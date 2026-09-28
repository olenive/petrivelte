/**
 * Centralised API client for the petritype-server control plane.
 *
 * Every request includes `credentials: 'include'` so the httponly
 * session cookie (`petritype_session`) is sent automatically.
 */

import { API_URL as resolvedApiUrl } from '$lib/config/network';
import { newIdempotencyKey, withIdempotency } from '$lib/idempotency';
import { markRequestStart } from '$lib/stores/slowRequests';
import { reportOutcome } from '$lib/stores/backendHealth';

export const API_URL = resolvedApiUrl;

const jsonHeaders = { 'Content-Type': 'application/json' };

// -- helpers --

export class SessionExpiredError extends Error {
	constructor(message = 'Session expired. Please log in again.') {
		super(message);
		this.name = 'SessionExpiredError';
	}
}

/**
 * Extract a human-readable error message from an API error response.
 * Handles both simple string `detail` and Pydantic validation error arrays.
 */
function extractErrorMessage(data: unknown, fallback: string): string {
	if (!data || typeof data !== 'object') return fallback;
	const detail = (data as Record<string, unknown>).detail;
	if (typeof detail === 'string') return detail;
	if (Array.isArray(detail) && detail.length > 0) {
		// Pydantic validation error format: [{loc: [...], msg: "...", type: "..."}]
		const first = detail[0];
		if (first && typeof first === 'object' && 'msg' in first) {
			return String(first.msg);
		}
	}
	return fallback;
}

// Skip timing for long-lived streams (SSE etc.)
function _isStreamingPath(path: string): boolean {
	return path.endsWith('/events') || path.includes('/logs/') || path.endsWith('/logs');
}

// Endpoints that kick off Fly/worker work and are *expected* to be slow
// (cold start, dep install, marimo spawn, machine provisioning). Their long
// backend duration must not be misread as database degradation — only a
// normally-fast endpoint going slow signals that. Hard failures on these
// (throw/5xx/429) are still classified; see backendHealth.reportOutcome.
const _EXPECTED_SLOW_SUFFIXES = [
	'/load', '/unload', '/provision', '/start', '/stop', '/destroy',
	'/health-check', '/trigger', '/upgrade',
];
function _isExpectedSlowPath(method: string, path: string): boolean {
	if (_EXPECTED_SLOW_SUFFIXES.some((s) => path.endsWith(s))) return true;
	// Worker creation provisions a machine — slow by nature.
	if (method === 'POST' && path === '/api/workers') return true;
	return false;
}

const _SLOW_REQUEST_MS = 500;

async function _timed(method: string, path: string, fn: () => Promise<Response>): Promise<Response> {
	const skip = _isStreamingPath(path);
	const expectSlow = _isExpectedSlowPath(method, path);
	const t0 = performance.now();
	// Streaming paths (SSE, log tails) are intentionally long-lived, so they
	// don't count toward the "slow request" surface — only one-shot calls do.
	const stopTracking = skip ? null : markRequestStart();
	try {
		const res = await fn();
		if (!skip) {
			const totalMs = performance.now() - t0;
			// Server-Timing: "app;dur=<ms>" — backend's own timing for the same request
			const serverTiming = res.headers.get('Server-Timing') || '';
			const m = serverTiming.match(/dur=([\d.]+)/);
			const backendMs = m ? parseFloat(m[1]) : null;
			const networkMs = backendMs !== null ? Math.max(0, totalMs - backendMs) : null;
			const summary = backendMs !== null
				? `${totalMs.toFixed(0)}ms (backend ${backendMs.toFixed(0)}, network ${networkMs!.toFixed(0)})`
				: `${totalMs.toFixed(0)}ms`;
			const log = totalMs >= _SLOW_REQUEST_MS ? console.warn : console.debug;
			log(`[api] ${method} ${path} -> ${res.status} in ${summary}`);
			// X-Backend-Slow: "db;dur=<ms>" — the CP telling us its OWN pool
			// acquire was slow for this request. A *verified* DB-pressure
			// signal (vs. raw latency, which can't identify the subsystem).
			const dbSlow = (res.headers.get('X-Backend-Slow') || '').startsWith('db');
			// Classify this outcome so the UI can name a degraded condition
			// (verified DB / rate limit / unreachable / slow) — not a bare spinner.
			reportOutcome({ status: res.status, backendMs, expectSlow, dbSlow });
		}
		return res;
	} catch (e) {
		const totalMs = performance.now() - t0;
		if (!skip) {
			console.warn(`[api] ${method} ${path} threw after ${totalMs.toFixed(0)}ms`, e);
			reportOutcome({ threw: true });
		}
		// The browser's generic "Failed to fetch" tells the user nothing.
		// Wrap with context (method, path, elapsed) so the page-level error
		// banner is actionable instead of mysterious.
		const reason = e instanceof Error ? e.message : String(e);
		throw new Error(
			`${method} ${path} failed after ${totalMs.toFixed(0)}ms: ${reason}`,
		);
	} finally {
		stopTracking?.();
	}
}

async function get(path: string): Promise<Response> {
	return _timed('GET', path, () => fetch(`${API_URL}${path}`, { credentials: 'include' }));
}

async function post(
	path: string,
	body?: unknown,
	extraHeaders?: Record<string, string>,
): Promise<Response> {
	// Compose headers: JSON header iff there's a body, then merge any
	// extras (e.g. ``X-Idempotency-Key``). Extras win on conflict so
	// callers can override defaults if they ever need to.
	let headers: Record<string, string> | undefined;
	if (body !== undefined || extraHeaders) {
		headers = {
			...(body !== undefined ? jsonHeaders : {}),
			...(extraHeaders ?? {}),
		};
	}
	return _timed('POST', path, () => fetch(`${API_URL}${path}`, {
		method: 'POST',
		credentials: 'include',
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	}));
}

async function patch(path: string, body: unknown): Promise<Response> {
	return _timed('PATCH', path, () => fetch(`${API_URL}${path}`, {
		method: 'PATCH',
		credentials: 'include',
		headers: jsonHeaders,
		body: JSON.stringify(body),
	}));
}

async function put(path: string, body: unknown): Promise<Response> {
	return _timed('PUT', path, () => fetch(`${API_URL}${path}`, {
		method: 'PUT',
		credentials: 'include',
		headers: jsonHeaders,
		body: JSON.stringify(body),
	}));
}

async function del(path: string): Promise<Response> {
	return _timed('DELETE', path, () => fetch(`${API_URL}${path}`, {
		method: 'DELETE',
		credentials: 'include',
	}));
}

// Coalesce concurrent identical reads. If a call with the same key is already
// pending, return its promise instead of issuing another request — prevents
// burst rate-limiting when multiple components call the same list endpoint
// in the same tick.
const _inflight = new Map<string, Promise<unknown>>();
function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const existing = _inflight.get(key) as Promise<T> | undefined;
	if (existing) return existing;
	const p = fn().finally(() => { _inflight.delete(key); });
	_inflight.set(key, p);
	return p;
}

// -- auth --

export interface AuthUser {
	id: string;
	email: string;
}

export async function register(email: string, password: string): Promise<{ status: string; email: string }> {
	const res = await post('/api/auth/register', { email, password });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Registration failed'));
	return res.json();
}

export async function login(email: string, password: string): Promise<AuthUser> {
	const res = await post('/api/auth/login', { email, password });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Login failed'));
	return res.json();
}

export async function logout(): Promise<void> {
	await post('/api/auth/logout');
}

export async function getMe(): Promise<AuthUser | null> {
	const res = await get('/api/auth/me');
	if (!res.ok) return null;
	return res.json();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
	const res = await post('/api/auth/change-password', {
		current_password: currentPassword,
		new_password: newPassword,
	});
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to change password'));
}

/** A personal API token as the control plane lists it. The secret itself is
 * never listed; `prefix` is the 8 characters after `petri_pat_`. */
/** What a token may do: read sees everything and changes nothing, operate
 * also drives what exists, manage also creates and deletes. */
export type ApiTokenScope = 'read' | 'operate' | 'manage';

export interface ApiToken {
	id: string;
	name: string;
	prefix: string;
	scope: ApiTokenScope;
	created_at: string;
	expires_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

/** Returned once, on creation: the only time the full `token` is available. */
export interface ApiTokenCreated extends ApiToken {
	token: string;
}

export async function listApiTokens(): Promise<ApiToken[]> {
	const res = await get('/api/auth/tokens');
	if (!res.ok) throw new Error(extractErrorMessage(await res.json().catch(() => null), 'Failed to load API tokens'));
	return res.json();
}

export async function createApiToken(
	name: string,
	expiresInDays: number,
	scope: ApiTokenScope,
): Promise<ApiTokenCreated> {
	const res = await post('/api/auth/tokens', { name, expires_in_days: expiresInDays, scope });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json().catch(() => null), 'Failed to create API token'));
	return res.json();
}

export async function revokeApiToken(id: string): Promise<{ status: string }> {
	const res = await del(`/api/auth/tokens/${encodeURIComponent(id)}`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json().catch(() => null), 'Failed to revoke API token'));
	return res.json();
}

export async function forgotPassword(email: string): Promise<void> {
	const res = await post('/api/auth/forgot-password', { email });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to send reset email'));
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
	const res = await post('/api/auth/reset-password', {
		token,
		new_password: newPassword,
	});
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to reset password'));
}

export async function verifyEmail(token: string): Promise<AuthUser> {
	const res = await post('/api/auth/verify-email', { token });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to verify email'));
	return res.json();
}

export async function resendVerification(email: string): Promise<{ status: string }> {
	const res = await post('/api/auth/resend-verification', { email });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to resend verification email'));
	return res.json();
}

// -- Auth0 --

export async function getAuth0Status(): Promise<{ configured: boolean }> {
	const res = await get('/api/auth/auth0/status');
	if (!res.ok) return { configured: false };
	return res.json();
}

export function getAuth0LoginUrl(): string {
	return `${API_URL}/api/auth/auth0/login`;
}

export async function auth0Callback(code: string, state: string): Promise<AuthUser> {
	const res = await post('/api/auth/auth0/callback', { code, state });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Authentication failed'));
	return res.json();
}

export async function unlinkAuth0(): Promise<void> {
	const res = await post('/api/auth/auth0/unlink');
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to unlink Google account'));
}

// -- Account management --

export interface AccountStatus {
	id: string;
	email: string;
	has_password: boolean;
	has_google: boolean;
	email_verified: boolean;
}

export async function getAccountStatus(): Promise<AccountStatus> {
	const res = await get('/api/auth/account-status');
	if (!res.ok) throw new Error('Failed to get account status');
	return res.json();
}

export async function setPassword(newPassword: string): Promise<void> {
	const res = await post('/api/auth/set-password', { new_password: newPassword });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to set password'));
}

export async function changeEmail(newEmail: string, password?: string): Promise<void> {
	const res = await post('/api/auth/change-email', { new_email: newEmail, password });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to initiate email change'));
}

export async function confirmEmailChange(token: string): Promise<AuthUser> {
	const res = await post('/api/auth/confirm-email-change', { token });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to confirm email change'));
	return res.json();
}

// -- nets --

export interface NetParam {
	name: string;
	type: string | null;
	/** Prefill for the input box. Null when the factory's default cannot
	 *  survive the text round trip (None, a lambda, an `int | None`) — leave
	 *  the box empty and the factory's own default applies. */
	default: string | null;
	required: boolean;
	/** The default as written in the factory's source, for display only.
	 *  Optional: control planes predating this field omit it. */
	default_display?: string | null;
	/** How the text in the input box becomes the value sent to the factory,
	 *  declared by the server. Optional: older control planes omit it, and the
	 *  client then predicts the coercion from ``type``. */
	coerce?: 'int' | 'float' | 'bool' | 'string' | null;
}

/**
 * The net's most recent closed run, denormalised onto its run-state row.
 *
 * ``trigger`` comes from the run row itself and goes null once retention
 * deletes it — the outcome outlives the history that produced it, which is
 * why the badge must never require ``trigger`` to render.
 */
export interface LastRun {
	id: string;
	trigger: string | null;
	state: string | null;
	reason: string | null;
	started_at: string | null;
	ended_at: string | null;
	/** Wall clock, seconds. Null once retention pruned the run row — the
	 *  outcome lives on the state row and outlives its own timings. */
	duration_s: number | null;
}

/**
 * The net's currently open run, or null when nothing is executing or armed.
 *
 * This is the liveness signal, and it replaces inferring one from
 * ``load_state`` and ``desired_execution_state``: a drained one-shot net has
 * load state loaded and desired execution state running while sitting idle,
 * which is what the daily pipeline is for twenty-three hours of the day. ``state`` is one of the open states —
 * ``claimed`` and ``dispatched`` are a scheduled run that has not begun
 * executing, so ``started_at`` is null until it does.
 */
export interface OpenRun {
	id: string;
	trigger: string;
	state: 'claimed' | 'dispatched' | 'running' | string;
	/** When the run row was written — the moment the slot was claimed or the
	 *  start was asked for. Always present, which is what lets an armed run
	 *  say how long it has been waiting. */
	created_at: string;
	started_at: string | null;
	/** The cron slot this run was fired for; null unless it was scheduled. */
	scheduled_for: string | null;
}

/**
 * Which code an instance runs: the deployment it is pinned to, in the few
 * fields a row needs to name it. Carried on nets and notebooks as
 * `deployment`, and again as `newer_deployment` for the newest successful
 * deployment of the same repo that still contains the instance's definition.
 */
export interface DeploymentSummary {
	id: string;
	/** Full commit hash; null for a build that did not record one. */
	git_commit: string | null;
	/** The first seven characters of `git_commit`, as the server cut them. */
	git_commit_short: string | null;
	git_ref: string;
	created_at: string;
	build_status: string;
}

/** The provenance pair on a net or notebook response. Optional so a control
 *  plane predating it reads as "not reported" rather than failing to parse. */
export interface Provenance {
	/** Null when the deployment row is gone. */
	deployment?: DeploymentSummary | null;
	/** Set when a newer successful deployment contains the same definition. */
	newer_deployment?: DeploymentSummary | null;
}

/** Tags naming a contradiction between what a net wants and what is true.
 *  Open-ended on the client: a newer server may send a tag this build does
 *  not know, and it is shown as the tag itself. */
export type NetAnomaly =
	| 'wants_running_without_worker'
	| 'wants_running_but_unloaded'
	| 'wants_running_but_load_failed'
	| 'duplicate_definition_on_deployment';

/** The schedule as the control plane reads it, composed server-side. */
export interface ScheduleFactsWire {
	expression: string;
	state: 'armed' | 'overdue' | 'paused' | 'invalid';
	next_run_at: string | null;
	pending_reason: string | null;
	pending_since: string | null;
	error: string | null;
	/** The one line to show beside the schedule expression. */
	message: string;
}

export interface Net extends Provenance {
	id: string;
	definition_name: string;
	instance_name: string;
	factory_params: Record<string, unknown> | null;
	image_tag: string | null;
	deployment_id: string | null;
	worker_id: string | null;
	load_state: 'unloaded' | 'loaded' | 'loading' | 'error';
	load_error: string | null;
	// Surfaced from deployments.discovered_nets — null if the deployment is gone
	// or the definition has been removed.
	entry_module: string | null;
	entry_function: string | null;
	execution_mode: string | null;
	/** The cron expression the net's code declares — read from the same
	 *  discovered definition as ``execution_mode`` and never copied onto the
	 *  net row, so a redeploy that changes ``schedule=`` changes this answer
	 *  immediately. Null unless ``execution_mode === 'cron'``. */
	schedule?: string | null;
	factory_params_schema: NetParam[] | null;
	step_wall_clock_timeout_seconds: number | null;
	/** Seconds without progress while running before Diagnose calls the net
	 *  stalled; null means no verdict. Optional so an older control plane
	 *  reads as unset. */
	stall_after_seconds?: number | null;
	/** Contradictions between intent and reality; empty when there are none.
	 *  Optional so an older control plane reads as none. */
	anomalies?: string[];
	/** The schedule line composed by the server; null for a net that is not
	 *  on a schedule, absent from older control planes. */
	schedule_facts?: ScheduleFactsWire | null;
	/** Why the schedule cannot be used, such as an expression that will not
	 *  parse; null when it can. */
	schedule_error?: string | null;
	/** The net's desired execution state: the intent the net resume sweep
	 *  restores after a worker reboot. Running implies loaded. Distinct from
	 *  ``load_state``, which is what is actually true. */
	desired_execution_state?: 'stopped' | 'running';
	// Surfaced from net_run_state. All null for a net that has never run: the
	// state row is created by its first run, so "no run state" is an answer
	// and not a missing join. Optional so a control plane predating the run
	// record degrades to "nothing to say" rather than to zeros.
	last_run?: LastRun | null;
	open_run?: OpenRun | null;
	pending_reason?: string | null;
	pending_since?: string | null;
	step_count?: number | null;
	last_progress_at?: string | null;
	last_success_at?: string | null;
	/**
	 * When the schedule next expects to run this net, computed on read from
	 * the expression and the slot the scheduler has already accounted for.
	 *
	 * Deliberately not always in the future: a slot the sweep has not reached
	 * yet — or one waiting on a worker, which ``pending_reason`` explains —
	 * is reported *in the past*, and that is the case worth showing, because
	 * a UI that pointed at tomorrow while nothing had run would hide it. Null
	 * for a paused net, a net that is not on a schedule, and an expression
	 * that will not parse.
	 */
	next_run_at?: string | null;
	/** The slow operation running on this net (a load or an unload), or null.
	 *  Optional so a control plane predating operations reads as "none". */
	active_operation?: OperationSummary | null;
	created_at: string;
	updated_at: string;
}

export async function listNets(opts?: { assigned?: boolean }): Promise<Net[]> {
	const params = new URLSearchParams();
	if (opts?.assigned === true) params.set('assigned', 'true');
	else if (opts?.assigned === false) params.set('assigned', 'false');
	const qs = params.toString();
	const path = `/api/nets${qs ? `?${qs}` : ''}`;
	return coalesce(`GET ${path}`, async () => {
		const res = await get(path);
		if (!res.ok) throw new Error('Failed to list nets');
		return res.json();
	});
}

export async function getNet(netId: string): Promise<Net> {
	const res = await get(`/api/nets/${netId}`);
	if (!res.ok) throw new Error('Failed to get net');
	return res.json();
}

export async function createNet(body: {
	deployment_id: string;
	definition_name: string;
	instance_name: string;
	factory_params?: Record<string, unknown> | null;
	worker_id?: string | null;
	image_tag?: string | null;
}): Promise<Net> {
	const res = await post('/api/nets', body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to create net'));
	return res.json();
}

export async function patchNet(
	netId: string,
	body: Partial<Pick<Net,
		'instance_name' | 'factory_params' | 'image_tag' | 'worker_id' | 'step_wall_clock_timeout_seconds'
		| 'stall_after_seconds'
	>>,
): Promise<Net> {
	const res = await patch(`/api/nets/${netId}`, body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to update net'));
	return res.json();
}

export async function deleteNet(netId: string): Promise<void> {
	const res = await del(`/api/nets/${netId}`);
	if (!res.ok) throw new Error('Failed to delete net');
}

export async function loadNet(
	netId: string,
	factoryParams?: Record<string, unknown>,
): Promise<{ status: string; worker_ip: string }> {
	const body = factoryParams ? { factory_params: factoryParams } : undefined;
	const res = await post(
		`/api/nets/${netId}/load`,
		body,
		withIdempotency(newIdempotencyKey()),
	);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to load net'));
	return res.json();
}

export async function unloadNet(netId: string): Promise<void> {
	const res = await post(
		`/api/nets/${netId}/unload`,
		undefined,
		withIdempotency(newIdempotencyKey()),
	);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to unload net'));
}

/**
 * The control plane's one-line verdict on a net: what state it is in, why,
 * and what to do about it. ``state`` is a closed set on the server that may
 * grow, so it is typed as a string and coloured through ``$lib/netDiagnose``.
 */
export interface NetDiagnosis {
	state: string;
	reason: string;
	action: string;
	facts: NetDiagnosisFacts;
	checked_at: string;
}

/** What the worker said about the net when asked. Every field is optional
 *  and nullable: an older control plane or worker leaves them out. */
export interface NetDiagnosisProbe {
	/** When the transition now firing started, ISO 8601. */
	executing_since?: string | null;
	executing_transition?: string | null;
	/** Since when nothing has been enabled, ISO 8601. */
	idle_since?: string | null;
	[key: string]: unknown;
}

/** The evidence behind a verdict. Only the fields the page reads are named;
 *  the rest is shown as raw JSON under Facts. */
export interface NetDiagnosisFacts {
	worker_probe?: NetDiagnosisProbe | null;
	executing_age_seconds?: number | null;
	idle_age_seconds?: number | null;
	stall_threshold_seconds?: number | null;
	/** Whether the threshold is the net's own ("declared") or the process default. */
	stall_threshold_source?: 'declared' | 'default' | null;
	[key: string]: unknown;
}

export async function diagnoseNet(netId: string): Promise<NetDiagnosis> {
	const res = await get(`/api/nets/${netId}/diagnose`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json().catch(() => null), 'Failed to diagnose net'));
	return res.json();
}

// -- net runs --
//
// The control plane's durable record of net executions: one row per run, a
// per-net summary and a per-UTC-day rollup. Everything the UI shows about
// what a net has actually done comes from these two reads — the worker is
// not asked, and a net whose worker is gone still has its history.

/**
 * One execution of a net.
 *
 * ``state`` and ``reason`` are closed sets the server enforces (see
 * ``nets/runs.py``); they are tags, never prose, and are rendered through the
 * map in ``$lib/runs`` rather than being shown raw. ``error`` is the one
 * field that carries free text, capped server-side at 2,000 characters.
 */
export interface RunRecord {
	id: string;
	net_id: string;
	trigger: string;
	/** The cron slot this run was fired for. Null unless trigger = schedule. */
	scheduled_for: string | null;
	state: string;
	reason: string | null;
	error: string | null;
	step_count: number | null;
	created_at: string;
	started_at: string | null;
	ended_at: string | null;
	duration_s: number | null;
}

/**
 * One newest-first page of run history.
 *
 * ``next_before`` is the cursor for the following page and is absent once the
 * history is exhausted, so a client stops paging on null rather than by
 * comparing lengths to a page size it would have to know.
 */
export interface RunPage {
	runs: RunRecord[];
	next_before: string | null;
}

/** One net's run counts for one UTC day. Days with no runs have no row. */
export interface DailyRollup {
	net_id: string;
	/** ISO date, ``YYYY-MM-DD``. */
	day: string;
	runs: number;
	succeeded: number;
	failed: number;
	stopped: number;
	skipped: number;
	steps_total: number;
	duration_total_s: number;
	duration_max_s: number | null;
}

export async function listNetRuns(
	netId: string,
	opts?: { limit?: number; before?: string | null },
): Promise<RunPage> {
	const params = new URLSearchParams();
	if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
	if (opts?.before) params.set('before', opts.before);
	const qs = params.toString();
	const res = await get(`/api/nets/${netId}/runs${qs ? `?${qs}` : ''}`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to list runs'));
	return res.json();
}

/**
 * Run now: ask the control plane to recycle the net and record the execution.
 *
 * The same dispatch the scheduler performs — unload, load, and the auto-start
 * that follows a load — rather than a start on the process already there,
 * which is what makes it work on a wedged subprocess and on a one-shot net
 * that has drained (loaded, desired-running, nothing left to fire).
 *
 * No idempotency key: this route has none. What stops a double click from
 * opening two runs is the server's one-open-run rule, which answers the
 * second with a 409 naming the run in the way. Its refusals — stopped net,
 * a load already in flight, no worker, an unreachable worker — arrive as
 * ``detail`` written for a person, so callers show that string and never the
 * status code.
 */
export async function runNetNow(netId: string): Promise<{ status: string; run_id: string }> {
	const res = await post(`/api/nets/${netId}/run`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to run the net'));
	return res.json();
}

export async function getNetRunDaily(
	netId: string,
	days?: number,
): Promise<DailyRollup[]> {
	const qs = days === undefined ? '' : `?days=${days}`;
	const res = await get(`/api/nets/${netId}/runs/daily${qs}`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to load run history'));
	return res.json();
}

// -- net secrets --

export interface SecretMetadata {
	key: string;
	created_at: string;
	updated_at: string;
}

export async function listNetSecrets(netId: string): Promise<SecretMetadata[]> {
	const res = await get(`/api/nets/${netId}/secrets`);
	if (!res.ok) throw new Error('Failed to list secrets');
	const data = await res.json();
	return data.secrets;
}

export async function setNetSecrets(
	netId: string,
	secrets: Array<{ key: string; value: string | null }>,
): Promise<SecretMetadata[]> {
	const res = await put(`/api/nets/${netId}/secrets`, { secrets });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to save secrets'));
	const data = await res.json();
	return data.secrets;
}

export async function deleteNetSecrets(netId: string): Promise<void> {
	const res = await del(`/api/nets/${netId}/secrets`);
	if (!res.ok) throw new Error('Failed to delete secrets');
}

// -- execution (proxied through control plane to worker) --

/**
 * A refusal from the net execution proxy (execution, log history, tokens,
 * inject). ``message`` is the server's ``detail``, written for a person;
 * ``reason`` is the tag a caller branches on: net_not_found,
 * not_assigned, worker_not_ready, not_loaded or worker_unreachable. Null
 * when the body carried no reason, as from an older control plane.
 */
export class NetProxyError extends Error {
	readonly status: number;
	readonly reason: string | null;
	constructor(message: string, status: number, reason: string | null) {
		super(message);
		this.name = 'NetProxyError';
		this.status = status;
		this.reason = reason;
	}
}

/** Build the typed error from a failed proxy response. */
export async function netProxyError(res: Response, fallback: string): Promise<NetProxyError> {
	const body = await res.json().catch(() => null);
	const reason = body && typeof body === 'object' && typeof (body as Record<string, unknown>).reason === 'string'
		? (body as Record<string, string>).reason
		: null;
	return new NetProxyError(extractErrorMessage(body, fallback), res.status, reason);
}

/**
 * True when the failure only says the net is not loaded, which is a state
 * rather than a fault and is shown quietly. The proxy says so with a 409
 * ``not_loaded``; an older control plane passed the worker's bare 404 on.
 */
export function isNotLoaded(error: unknown): boolean {
	if (!(error instanceof NetProxyError)) return false;
	return error.reason === 'not_loaded' || (error.reason === null && error.status === 404);
}

export async function getExecutionState(netId: string): Promise<any> {
	const res = await get(`/api/nets/${netId}/execution/state`);
	if (!res.ok) throw await netProxyError(res, 'Failed to get execution state');
	return res.json();
}

/** The worker's per-net transition history, oldest first. Capped on the
 *  worker (500), so it is the whole story only for a young subprocess.
 *  Empty for a net that is not loaded; other refusals throw
 *  ``NetProxyError``. */
export async function getExecutionHistory(netId: string): Promise<Array<{
	timestamp: number;
	transition: string;
	duration_ms: number;
	inputs: Record<string, string[]>;
	outputs: string[];
}>> {
	const res = await get(`/api/nets/${netId}/execution/history`);
	if (!res.ok) {
		// Not loaded means no history to show; any other refusal is news.
		const error = await netProxyError(res, 'Failed to get execution history');
		if (isNotLoaded(error)) return [];
		throw error;
	}
	const body = await res.json();
	return Array.isArray(body) ? body : [];
}

export async function executionStep(
	netId: string,
	idempotencyKey?: string,
): Promise<{ status: string }> {
	// Mint a key if the caller didn't supply one. Each call to this
	// function represents one logical "fire one step" action; minting
	// per-call means: an in-flight retry by the CP / network layer with
	// the same key dedupes on the worker, but two separate user clicks
	// generate two separate keys and fire two distinct steps.
	const key = idempotencyKey ?? newIdempotencyKey();
	const res = await post(
		`/api/nets/${netId}/execution/step`,
		undefined,
		withIdempotency(key),
	);
	if (!res.ok) throw await netProxyError(res, 'Failed to step');
	return res.json();
}

export async function executionStart(netId: string): Promise<void> {
	await post(
		`/api/nets/${netId}/execution/start`,
		undefined,
		withIdempotency(newIdempotencyKey()),
	);
}

export async function executionStop(netId: string): Promise<void> {
	await post(
		`/api/nets/${netId}/execution/stop`,
		undefined,
		withIdempotency(newIdempotencyKey()),
	);
}

export async function executionReset(netId: string): Promise<void> {
	await post(
		`/api/nets/${netId}/execution/reset`,
		undefined,
		withIdempotency(newIdempotencyKey()),
	);
}

// Inject a typed token into a place on a loaded net (human-in-the-loop). The
// worker validates `token` against the place's declared type, so a bad shape is
// rejected before it reaches the graph. Each call mints its own idempotency key:
// a network-layer retry dedupes to one token, two clicks inject two tokens.
export async function executionInject(
	netId: string,
	placeName: string,
	token: unknown,
): Promise<{ status: string; place_name: string }> {
	const res = await post(
		`/api/nets/${netId}/inject`,
		{ place_name: placeName, token },
		withIdempotency(newIdempotencyKey()),
	);
	if (!res.ok) throw await netProxyError(res, 'Failed to inject token');
	return res.json();
}

export interface TokenJsonView {
	kind: 'json';
	id: string;
	place_id: string;
	type_name: string;
	value: unknown;
}

export interface TokenTextView {
	kind: 'text';
	id: string;
	place_id: string;
	type_name: string;
	text: string;
}

export type TokenView = TokenJsonView | TokenTextView;

export async function getToken(netId: string, tokenId: string): Promise<TokenView> {
	const res = await get(`/api/nets/${netId}/tokens/${tokenId}`);
	if (!res.ok) throw await netProxyError(res, 'Failed to get token');
	return res.json();
}

// -- workers --

export interface Worker {
	id: string;
	name: string;
	worker_category: string; // "ephemeral" or "persistent"
	worker_type: string; // implementation: "sprite" or "fly_machine"
	sprite_name: string | null;
	fly_machine_id: string | null;
	deployment_id: string | null;
	image_tag: string | null;
	memory_mb: number;
	cpus: number;
	status: string;
	status_detail: string | null;
	url: string | null;
	/** Running operations on this worker. Optional for an older control plane. */
	active_operations?: number;
	created_at: string;
	updated_at: string;
	/** The worker's build: its git commit, when the control plane first saw
	 *  it, and whether it matches the control plane's own build (null when
	 *  either side is unknown). The match compares worker image content
	 *  hashes when both sides have one and falls back to commits otherwise.
	 *  Absent on an older control plane. */
	build_commit?: string | null;
	build_seen_at?: string | null;
	/** Content hash of the worker image's inputs, or null when the worker
	 *  predates it. When both sides report one, `build_matches_control_plane`
	 *  compares these hashes, so a worker built from an older commit whose
	 *  worker image is unchanged still matches. */
	build_worker_hash?: string | null;
	build_matches_control_plane?: boolean | null;
}

export interface WorkerDetail extends Worker {
	assigned_nets: Array<{
		id: string;
		definition_name: string;
		instance_name: string;
		load_state: string;
		entry_module: string | null;
		entry_function: string | null;
		factory_params_schema: NetParam[] | null;
	}>;
}

export async function listWorkers(): Promise<Worker[]> {
	return coalesce('GET /api/workers', async () => {
		const res = await get('/api/workers');
		if (!res.ok) throw new Error('Failed to list workers');
		return res.json();
	});
}

export async function getWorker(workerId: string): Promise<WorkerDetail> {
	const res = await get(`/api/workers/${workerId}`);
	if (!res.ok) throw new Error('Failed to get worker');
	return res.json();
}

export async function createWorker(body: {
	name: string;
	worker_category?: string; // "ephemeral" or "persistent"
	deployment_id?: string; // Link to a deployment for custom image
	memory_mb?: number; // 256, 512, 1024, 2048
	cpus?: number; // 1, 2, 4
}): Promise<Worker> {
	const res = await post('/api/workers', body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to create worker'));
	return res.json();
}

/** What a worker delete left behind. Its nets and secrets go with it; its
 *  notebooks stay, unassigned, with `load_error = 'worker_deleted'`. */
export interface WorkerDeleteResult {
	notebooks_unassigned: number;
	notebook_ids: string[];
}

export async function deleteWorker(workerId: string): Promise<WorkerDeleteResult> {
	const res = await del(`/api/workers/${workerId}`);
	if (!res.ok) {
		throw new Error(extractErrorMessage(await res.json().catch(() => null), 'Failed to delete worker'));
	}
	const body = await res.json().catch(() => null);
	const ids: unknown = body?.notebook_ids;
	const notebookIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
	const count: unknown = body?.notebooks_unassigned;
	return {
		notebooks_unassigned: typeof count === 'number' ? count : notebookIds.length,
		notebook_ids: notebookIds,
	};
}

export async function provisionWorker(workerId: string): Promise<{ status: string; url: string }> {
	const res = await post(`/api/workers/${workerId}/provision`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to provision worker'));
	return res.json();
}

export async function destroyWorkerResource(workerId: string): Promise<void> {
	const res = await post(`/api/workers/${workerId}/destroy`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to destroy resource'));
}

export async function startWorker(workerId: string): Promise<void> {
	const res = await post(`/api/workers/${workerId}/start`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to start worker'));
}

export async function stopWorker(workerId: string): Promise<void> {
	const res = await post(`/api/workers/${workerId}/stop`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to stop worker'));
}

export async function healthCheckWorker(workerId: string): Promise<{ status: string }> {
	const res = await post(`/api/workers/${workerId}/health-check`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Health check failed'));
	return res.json();
}

export async function getWorkerLogHistory(workerId: string): Promise<Array<Record<string, any>>> {
	const res = await get(`/api/workers/${workerId}/logs/history`);
	if (!res.ok) return [];
	return res.json();
}

/** Narrowing for the net log history read; all optional. */
export interface NetLogHistoryQuery {
	limit?: number;
	/** ISO 8601; only lines at or after this instant. */
	since?: string;
	/** Only lines containing this substring. */
	contains?: string;
	newest_first?: boolean;
}

/**
 * Durable per-net subprocess log tail from the worker's local rotating file.
 * Used to seed the net-page log panel with history that survives subprocess
 * and worker restarts (the live SSE ring does not). Empty for a net that is
 * not loaded; any other refusal, an unreachable worker included, throws
 * ``NetProxyError`` so the page can say why the history is missing.
 */
export async function getNetLogHistory(
	netId: string,
	query: NetLogHistoryQuery = {},
): Promise<Array<{ ts: string | null; text: string }>> {
	const params = new URLSearchParams();
	if (query.limit !== undefined) params.set('limit', String(query.limit));
	if (query.since !== undefined) params.set('since', query.since);
	if (query.contains !== undefined) params.set('contains', query.contains);
	if (query.newest_first !== undefined) params.set('newest_first', String(query.newest_first));
	const qs = params.toString();
	const res = await get(`/api/nets/${netId}/logs/history${qs ? `?${qs}` : ''}`);
	if (!res.ok) {
		const error = await netProxyError(res, 'Failed to get the net log history');
		if (isNotLoaded(error)) return [];
		throw error;
	}
	return res.json();
}

export async function getEventsAfter(after: number): Promise<Array<Record<string, any>>> {
	const res = await get(`/api/events/history?after=${after}`);
	if (!res.ok) return [];
	return res.json();
}

// -- GitHub --

export interface GitHubStatus {
	connected: boolean;
	username?: string;
}

export async function getGitHubStatus(): Promise<GitHubStatus> {
	const res = await get('/api/github/status');
	if (!res.ok) return { connected: false };
	return res.json();
}

export function getGitHubConnectUrl(): string {
	return `${API_URL}/api/github/connect`;
}

export async function disconnectGitHub(): Promise<void> {
	const res = await del('/api/github/disconnect');
	if (!res.ok) throw new Error('Failed to disconnect GitHub');
}

export interface GitHubRepo {
	id: string;
	full_name: string;
	default_branch: string;
	webhook_active: boolean;
	created_at: string;
}

export async function listGitHubRepos(): Promise<GitHubRepo[]> {
	const res = await get('/api/github/repos');
	if (!res.ok) throw new Error('Failed to list repos');
	return res.json();
}

export async function connectGitHubRepo(fullName: string, defaultBranch = 'main'): Promise<GitHubRepo> {
	const res = await post('/api/github/repos', { full_name: fullName, default_branch: defaultBranch });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to connect repo'));
	return res.json();
}

export async function disconnectGitHubRepo(repoId: string): Promise<void> {
	const res = await del(`/api/github/repos/${repoId}`);
	if (!res.ok) throw new Error('Failed to disconnect repo');
}

export async function triggerRepoBuild(repoId: string): Promise<{ deployment_id: string; commit: string }> {
	const res = await post(`/api/github/repos/${repoId}/trigger`);
	if (!res.ok) {
		if (res.status === 401) throw new SessionExpiredError();
		throw new Error(extractErrorMessage(await res.json(), 'Failed to trigger build'));
	}
	return res.json();
}

// -- Deployments --

/**
 * Notebook entry as it lives on ``deployments.discovered_notebooks``.
 *
 * Kept narrow on purpose: only the fields the frontend reads. The
 * server may add more (e.g. AST hashes) without breaking us, but the
 * Add-Notebook modal binds against ``name`` and surfaces ``slots`` for
 * preview, so those must stay present.
 */
/**
 * Something marimo found that stops it running part of the notebook.
 *
 * Recorded at build time, so it is known before a worker is ever asked to run
 * the notebook. `lines` holds one anchor per offending cell.
 */
export interface NotebookDefect {
	code: string;
	name: string;
	message: string;
	lines: number[];
	fix: string;
}

export interface DiscoveredNotebook {
	name: string;
	path_in_tarball: string;
	slots: NotebookSlot[];
	// Optional: a deployment built before the check existed has no such field,
	// and that must read as "not checked", never as "checked and sound".
	defects?: NotebookDefect[];
}

export interface Deployment {
	id: string;
	git_url: string;
	git_ref: string;
	git_commit: string | null;
	image_tag: string | null;
	build_status: string;
	build_error: string | null;
	discovered_nets: Array<{ name: string; module: string; function: string }> | null;
	discovered_notebooks: DiscoveredNotebook[] | null;
	created_at: string;
	build_started_at: string | null;
	build_finished_at: string | null;
}

export async function listDeployments(): Promise<Deployment[]> {
	const res = await get('/api/deployments');
	if (!res.ok) throw new Error('Failed to list deployments');
	return res.json();
}

export async function getDeployment(deploymentId: string): Promise<Deployment> {
	const res = await get(`/api/deployments/${deploymentId}`);
	if (!res.ok) throw new Error('Failed to get deployment');
	return res.json();
}

// -- notebooks --

export interface NotebookSlot {
	slot_name: string;
	places: string[];
	transitions: string[];
}

export interface NotebookBinding {
	slot_name: string;
	net_id: string;
}

export interface Notebook extends Provenance {
	id: string;
	definition_name: string;
	instance_name: string;
	deployment_id: string | null;
	worker_id: string | null;
	load_state: string;
	load_error: string | null;
	/** The notebook's desired load state: whether the user wants it loaded.
	 *  A load, reload or upgrade sets `loaded`; an unload, a worker delete,
	 *  idle eviction and an OOM or crash death set `unloaded`. A worker
	 *  restart leaves it as it was, so a `loaded` notebook the restart unloaded
	 *  is loaded again by the control plane. */
	desired_load_state: 'loaded' | 'unloaded';
	path_in_tarball: string | null;
	slots: NotebookSlot[];
	bindings: NotebookBinding[];
	/** How long the worker leaves this kernel idle before freeing its RAM.
	 *  `null` = use the worker's own default, `0` = never evict. */
	idle_timeout_seconds: number | null;
	/** The setting above resolved against the worker default, by the control
	 *  plane — so nothing here has to know what that default is. */
	effective_idle_timeout_seconds: number;
	/** Only on a PATCH response: whether the new value reached the running
	 *  subprocess. `false` = saved but the live kernel keeps the old one until
	 *  its next load; `null`/absent = there was nothing running to tell. */
	idle_timeout_pushed?: boolean | null;
	/** The slow operation running on this notebook (its load), or null. */
	active_operation?: OperationSummary | null;
	created_at: string;
	updated_at: string;
}

export async function listNotebooks(): Promise<Notebook[]> {
	return coalesce('GET /api/notebooks', async () => {
		const res = await get('/api/notebooks');
		if (!res.ok) throw new Error('Failed to list notebooks');
		return res.json();
	});
}

export async function getNotebook(id: string): Promise<Notebook> {
	const res = await get(`/api/notebooks/${id}`);
	if (!res.ok) throw new Error('Failed to get notebook');
	return res.json();
}

export async function createNotebook(body: {
	deployment_id: string;
	definition_name: string;
	instance_name: string;
	worker_id?: string | null;
}): Promise<Notebook> {
	const res = await post('/api/notebooks', body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to create notebook'));
	return res.json();
}

export async function patchNotebook(
	id: string,
	body: {
		instance_name?: string;
		worker_id?: string | null;
		/** `null` resets to the worker default; `0` never evicts; otherwise
		 *  60..604800, which the control plane enforces. */
		idle_timeout_seconds?: number | null;
	},
): Promise<Notebook> {
	const res = await patch(`/api/notebooks/${id}`, body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to update notebook'));
	return res.json();
}

export async function deleteNotebook(id: string): Promise<void> {
	const res = await del(`/api/notebooks/${id}`);
	if (!res.ok) throw new Error('Failed to delete notebook');
}

/** A notebook subprocess running on a worker, and what it costs.
 *
 * ~188MB each — larger than the worker's own process — so on the default
 * 512MB machine one is the ceiling. `instance_name` comes from the control
 * plane, the rest from the worker itself.
 */
export interface OccupancyNotebook {
	notebook_id: string;
	definition_name: string | null;
	instance_name?: string | null;
	pid: number;
	rss_mb: number;
	peak_rss_mb: number;
}

export interface OccupancyNet {
	net_id: string;
	pid: number;
	rss_mb: number;
	peak_rss_mb: number;
}

export interface WorkerOccupancy {
	reachable: boolean;
	/** `worker_unreachable` | `not_supported` | `no_backend` | `http_*` | null */
	reason: string | null;
	memory: {
		parent_rss_mb?: number | null;
		parent_peak_rss_mb?: number | null;
		container_total_mb?: number | null;
		container_available_mb?: number | null;
	};
	nets: OccupancyNet[];
	notebooks: OccupancyNotebook[];
}

/** The 409 body returned when loading would add a second notebook to a worker. */
export interface AdditionalNotebookRefusal {
	reason: 'additional_notebook';
	message: string;
	occupancy: WorkerOccupancy;
	additional: boolean;
	other_notebooks: OccupancyNotebook[];
	estimated_cost_mb: number;
	estimate_source: 'same_notebook' | 'other_notebook' | 'default';
	predicted_free_mb: number | null;
	/** `null` means unknown — never read it as "yes". */
	fits: boolean | null;
}

/** Thrown by `loadNotebook` when the server wants explicit consent. */
export class AdditionalNotebookError extends Error {
	constructor(public readonly refusal: AdditionalNotebookRefusal) {
		super(refusal.message);
		this.name = 'AdditionalNotebookError';
	}
}

/**
 * The 507 body returned when the worker refuses a load for lack of memory.
 *
 * The worker compares what it can give (free RAM plus free swap) with the
 * notebook's footprint plus a fixed headroom, and refuses before spawning
 * anything. `message` is written for people and already names the remedies.
 */
export interface InsufficientMemoryRefusal {
	reason: 'insufficient_memory';
	message: string;
	available_mb: number | null;
	swap_free_mb: number | null;
	footprint_mb: number | null;
	footprint_source: 'measured' | 'default' | null;
	headroom_mb: number | null;
	needed_mb: number | null;
}

/** Thrown by `loadNotebook` on a 507: a refusal, with nothing to confirm. */
export class InsufficientMemoryError extends Error {
	constructor(public readonly refusal: InsufficientMemoryRefusal) {
		super(refusal.message);
		this.name = 'InsufficientMemoryError';
	}
}

const INSUFFICIENT_MEMORY_FALLBACK =
	'The worker does not have enough memory to load this notebook. Unload a notebook or add memory.';

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read a load response's body as an admission refusal, or null when it is not
 * one. Missing numbers stay null rather than zero: a zero reads as a
 * measurement, and an absent field is the absence of one.
 */
export function parseInsufficientMemory(body: unknown): InsufficientMemoryRefusal | null {
	if (!body || typeof body !== 'object') return null;
	const detail = (body as Record<string, unknown>).detail;
	if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
	const d = detail as Record<string, unknown>;
	if (d.reason !== 'insufficient_memory') return null;
	const message =
		typeof d.message === 'string' && d.message.trim() ? d.message : INSUFFICIENT_MEMORY_FALLBACK;
	const source = d.footprint_source;
	return {
		reason: 'insufficient_memory',
		message,
		available_mb: numberOrNull(d.available_mb),
		swap_free_mb: numberOrNull(d.swap_free_mb),
		footprint_mb: numberOrNull(d.footprint_mb),
		footprint_source: source === 'measured' || source === 'default' ? source : null,
		headroom_mb: numberOrNull(d.headroom_mb),
		needed_mb: numberOrNull(d.needed_mb),
	};
}

export async function getWorkerOccupancy(workerId: string): Promise<WorkerOccupancy> {
	const res = await get(`/api/workers/${workerId}/occupancy`);
	if (!res.ok) throw new Error('Failed to fetch worker occupancy');
	return res.json();
}

/** Start a notebook's subprocess.
 *
 * The load runs in the background on the control plane: a 202 carries the
 * `notebook_load` operation, and the row moves `loading` then `loaded`, or
 * `unloaded` with `load_error`. Callers show the operation and follow it on
 * the event stream rather than waiting here. Resolves to null when the server
 * finished the load inside the request, which is what a control plane from
 * before operations does; the row is then already settled.
 *
 * Throws `AdditionalNotebookError` when the target worker is already running a
 * different notebook and `confirmAdditional` was not set: the caller is meant
 * to show what is running, then retry with it true. The refusal is the
 * server's, not the dialog's, so an agent hitting the API gets the same
 * information a person does.
 *
 * Throws `InsufficientMemoryError` on a 507, when the worker refused because
 * the notebook would not fit in its free RAM and swap. That one is final:
 * callers show its message, which names the remedies, and do not retry.
 */
export async function loadNotebook(
	id: string,
	opts?: { confirmAdditional?: boolean },
): Promise<Operation | null> {
	const res = await post(
		`/api/notebooks/${id}/load`,
		opts?.confirmAdditional ? { confirm_additional: true } : undefined,
		withIdempotency(newIdempotencyKey()),
	);
	if (res.status === 409) {
		const body = await res.json();
		const detail = body?.detail;
		if (detail?.reason === 'additional_notebook') {
			throw new AdditionalNotebookError(detail as AdditionalNotebookRefusal);
		}
		throw new Error(extractErrorMessage(body, 'Failed to load notebook'));
	}
	if (res.status === 507) {
		const body = await res.json().catch(() => null);
		const refusal = parseInsufficientMemory(body);
		if (refusal) throw new InsufficientMemoryError(refusal);
		throw new Error(extractErrorMessage(body, 'Failed to load notebook'));
	}
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to load notebook'));
	if (res.status !== 202) return null;
	return res.json();
}

/** Move a notebook to newer code.
 *
 * The control plane unloads the notebook if it is loaded, re-points its
 * deployment (to `deploymentId`, or to its `newer_deployment` when omitted),
 * keeps its bindings and idle timeout, and starts an ordinary
 * `notebook_load`. It answers 202 with that operation, which callers follow
 * exactly as they follow a Load. A 409 means there is nothing to upgrade to,
 * the notebook has no worker, or the target deployment lacks the definition
 * or one of its bound slots; its `detail` is the message thrown.
 */
export async function upgradeNotebook(id: string, deploymentId?: string): Promise<Operation> {
	const res = await post(
		`/api/notebooks/${id}/upgrade`,
		deploymentId ? { deployment_id: deploymentId } : undefined,
		withIdempotency(newIdempotencyKey()),
	);
	if (!res.ok) {
		throw new Error(extractErrorMessage(await res.json().catch(() => null), 'Failed to upgrade notebook'));
	}
	return res.json();
}

export async function unloadNotebook(id: string): Promise<{ status: string }> {
	const res = await post(
		`/api/notebooks/${id}/unload`,
		undefined,
		withIdempotency(newIdempotencyKey()),
	);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to unload notebook'));
	return res.json();
}

/** Server-side view of how long a notebook took to load.
 *
 * `load` is the spawn on the worker; `burst` summarises the last page open,
 * which is ~100 proxied asset requests. Both are held in memory on the
 * control plane, so both are null after a CP restart and `burst` is null
 * until the notebook page has been opened once.
 */
export interface NotebookTimings {
	load: {
		total_s: number;
		phases: Record<string, number>;
		at: number;
	} | null;
	burst: {
		count: number;
		errors: number;
		queued: number;
		wall_s: number;
		p50_s: number;
		p95_s: number;
		max_s: number;
		max_queue_wait_s: number;
		at: number;
	} | null;
	burst_in_progress: boolean;
	/**
	 * The in-flight burst, while one is open. `expected` is the previous
	 * burst's total, which is what makes an honest fraction possible: Marimo
	 * fetches the same lazily imported asset set on every open. It is null on
	 * a first-ever open — show a bare count there rather than a percentage
	 * against a guess.
	 *
	 * Optional so an older control plane degrades instead of throwing.
	 */
	burst_progress?: {
		count: number;
		elapsed_s: number;
		expected: number | null;
	} | null;
}

/**
 * One event from a notebook's load, as the worker publishes it.
 *
 * `load_progress` carries `{ step, message }` and drives the phase checklist;
 * `log` carries `{ text }`, the subprocess's own stderr. Both are needed: the
 * checklist is what a person reads, the log is what they send us when the
 * checklist is not enough.
 */
export interface NotebookLoadEvent {
	seq: number;
	scope: 'notebook';
	notebook_id: string | null;
	kind: 'load_progress' | 'log' | string;
	ts: string;
	data: Record<string, any>;
}

export async function getNotebookTimings(id: string): Promise<NotebookTimings> {
	const res = await get(`/api/notebooks/${id}/timings`);
	if (!res.ok) throw new Error('Failed to get notebook timings');
	return res.json();
}

/** How far behind its net each of a notebook's bound slots is.
 *
 * Reported by the notebook subprocess, aged by the worker against its own
 * clock, read through the control plane. The ages are what make it useful:
 * a notebook that has silently stopped updating shows identical *data* to one
 * that is up to date, so freshness has to be stated rather than inferred.
 *
 * `last_sync_age_s` is null when a slot has never synced at all — which is a
 * different thing from having synced a moment ago, and must not render the
 * same way. `report_age_s` is time since the subprocess said anything, so a
 * subprocess that has died shows a growing report age while its last
 * `last_error` stays whatever it was.
 */
export interface NotebookSyncSlot {
	slot_name: string;
	net_id: string | null;
	synced: boolean;
	step_count: number | null;
	running: boolean | null;
	last_error: string | null;
	last_sync_age_s: number | null;
	report_age_s: number;
	/** Which marking the notebook holds; null before its first fetch. */
	marking_version: number | null;
	/** The bridge's current check interval. It widens when fetches are slow,
	 *  so staleness is judged against it rather than a fixed cadence. Null
	 *  when the bridge has not reported one. */
	reconcile_interval_s: number | null;
	/** How long before the report the bridge last handed state to marimo.
	 *  Aged at the report's stamp, so the push happened
	 *  `report_age_s + last_push_age_s` ago. Null when it never has. */
	last_push_age_s: number | null;
}

/**
 * The render channel, as the worker sees it.
 *
 * Everything in `NotebookSyncSlot` travels the HTTP path from the notebook's
 * bridge and describes that path. The rendering a viewer actually looks at
 * travels a WebSocket, and the two fail independently — a notebook once sat
 * frozen for 259 seconds while every slot reported a sub-second sync age,
 * because the browser had not opened its socket yet.
 *
 * This page cannot check that for itself: the Marimo iframe is cross-origin,
 * so its socket is invisible from here. The worker counts it instead.
 *
 * Ages are null for "never happened", which must stay distinct from a large
 * number — never having connected and having disconnected long ago call for
 * different recoveries.
 */
export interface NotebookTransport {
	alive: boolean;
	ws_sessions: number;
	ws_opened_total: number;
	last_ws_open_age_s: number | null;
	frames_relayed: number;
	last_frame_age_s: number | null;
	first_report_age_s: number | null;
	/** The last socket close the worker's relay saw for this notebook: its
	 *  close code, its reason, and how long ago. Null when no socket has
	 *  closed, and absent on a worker that predates them; read absent as null. */
	ws_last_close_code?: number | null;
	ws_last_close_reason?: string | null;
	ws_last_close_age_s?: number | null;
	/** Marimo ends a session its socket left (after its 120 s session TTL),
	 *  and a later click on the page hits the dead session id. The worker
	 *  counts those here rather than reporting them as an error group.
	 *  Absent on an older worker; read absent as zero and null. */
	session_expired_total?: number;
	last_session_expired_age_s?: number | null;
}

export interface NotebookSync {
	slots: NotebookSyncSlot[];
	// Optional throughout: a control plane or worker predating the transport
	// signals omits these, and an absent block must degrade to "cannot tell"
	// rather than being filled in with zeros that read as "nothing attached".
	transport?: NotebookTransport | null;
	reachable?: boolean;
	/** Why `reachable` is false. `worker_busy` is the control plane's probe
	 *  timing out (the worker is saturated, nothing is known to be dead);
	 *  `worker_unreachable` is a failed connection; `subprocess_gone` is the
	 *  worker answering that it no longer knows the notebook. */
	reason?:
		| 'no_worker'
		| 'not_loaded'
		| 'worker_busy'
		| 'worker_unreachable'
		| 'subprocess_gone'
		| null;
	bindings?: number;
	/** The oldest running operation on this notebook's worker, or null. While
	 *  one runs the worker is known to be busy, and the page waits rather than
	 *  remounting. Optional for an older control plane. */
	worker_busy_with?: OperationSummary | null;
}

/** The viewer's thresholds, served by the control plane from the same
 *  module the worker and SDK read. Validated by the caller; see
 *  `notebookThresholds.ts`. */
export async function getNotebookViewerThresholds(): Promise<unknown> {
	const res = await get('/api/config/notebook-viewer');
	if (!res.ok) throw new Error('Failed to get notebook viewer thresholds');
	return res.json();
}

export async function getNotebookSync(id: string): Promise<NotebookSync> {
	const res = await get(`/api/notebooks/${id}/sync`);
	if (!res.ok) throw new Error('Failed to get notebook sync status');
	return res.json();
}

export async function bindNotebookSlot(
	notebookId: string,
	slotName: string,
	netId: string,
): Promise<{ status: string; slot_name: string; net_id: string }> {
	const res = await post(`/api/notebooks/${notebookId}/bindings`, {
		slot_name: slotName,
		net_id: netId,
	});
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to bind slot'));
	return res.json();
}

export async function unbindNotebookSlot(notebookId: string, slotName: string): Promise<void> {
	const res = await del(`/api/notebooks/${notebookId}/bindings/${encodeURIComponent(slotName)}`);
	if (!res.ok) throw new Error('Failed to unbind slot');
}

export interface NotebookError {
	id: string;
	signature: string;
	exception_type: string;
	top_frame_location: string | null;
	latest_message: string | null;
	latest_traceback: string;
	occurrence_count: number;
	first_seen_at: string;
	last_seen_at: string;
}

export async function listNotebookErrors(notebookId: string): Promise<NotebookError[]> {
	const res = await get(`/api/notebooks/${notebookId}/errors`);
	if (!res.ok) throw new Error('Failed to load notebook errors');
	const body = await res.json();
	return body.errors;
}

export async function dismissNotebookErrors(notebookId: string): Promise<number> {
	const res = await del(`/api/notebooks/${notebookId}/errors`);
	if (!res.ok) throw new Error('Failed to dismiss notebook errors');
	const body = await res.json();
	return body.dismissed;
}

// -- wiring (one-shot fetch for the graph view) --

// -- operations --
//
// The control plane's record of every slow operation: a net load or unload, a
// notebook load, a deployment being prepared. Each carries its current step
// and a heartbeat, so a page can say "busy doing X since T" instead of
// inferring "dead" from silence. Started, advanced and finished on the same
// `/api/events` stream as every other state change.

export type OperationKind =
	| 'net_load'
	| 'net_unload'
	| 'notebook_load'
	| 'deployment_prepare'
	// More kinds arrive later; an unknown one renders by its raw name.
	| (string & {});

export type OperationSubjectKind = 'net' | 'notebook' | 'deployment' | 'worker';

export type OperationTrigger = 'user' | 'schedule' | 'resume' | 'system';

export type OperationState = 'running' | 'succeeded' | 'failed' | 'abandoned';

export interface Operation {
	id: string;
	user_id: string;
	kind: OperationKind;
	subject_kind: OperationSubjectKind;
	subject_id: string;
	worker_id: string | null;
	trigger: OperationTrigger;
	state: OperationState;
	step: string | null;
	step_message: string | null;
	started_at: string;
	heartbeat_at: string;
	finished_at: string | null;
	error: string | null;
}

/** What a net, notebook or sync response says about its running operation.
 *  Always a running one, so it carries no state. */
export type OperationSummary = Pick<
	Operation,
	'id' | 'kind' | 'trigger' | 'step' | 'step_message' | 'started_at' | 'heartbeat_at'
>;

export interface OperationQuery {
	active?: boolean;
	subject_kind?: OperationSubjectKind;
	subject_id?: string;
	worker_id?: string;
	limit?: number;
}

export async function listOperations(query: OperationQuery = {}): Promise<Operation[]> {
	const params = new URLSearchParams();
	if (query.active !== undefined) params.set('active', String(query.active));
	if (query.subject_kind) params.set('subject_kind', query.subject_kind);
	if (query.subject_id) params.set('subject_id', query.subject_id);
	if (query.worker_id) params.set('worker_id', query.worker_id);
	if (query.limit !== undefined) params.set('limit', String(query.limit));
	const qs = params.toString();
	const path = `/api/operations${qs ? `?${qs}` : ''}`;
	return coalesce(`GET ${path}`, async () => {
		const res = await get(path);
		if (!res.ok) throw new Error('Failed to list operations');
		return res.json();
	});
}

export async function getOperation(id: string): Promise<Operation> {
	const res = await get(`/api/operations/${id}`);
	if (!res.ok) throw new Error('Failed to get operation');
	return res.json();
}

export interface WiringWorker {
	id: string;
	name: string;
	worker_category: string;
	worker_type: string;
	status: string;
	status_detail: string | null;
	memory_mb: number;
	cpus: number;
	memory_used_mb: number | null;
	memory_peak_mb: number | null;
	/** The worker's build: its git commit, when the control plane first saw
	 *  it, and whether it matches the control plane's own build (null when
	 *  either side is unknown). The match compares worker image content
	 *  hashes when both sides have one and falls back to commits otherwise.
	 *  Absent on an older control plane. */
	build_commit?: string | null;
	build_seen_at?: string | null;
	/** Content hash of the worker image's inputs, or null when the worker
	 *  predates it. When both sides report one, `build_matches_control_plane`
	 *  compares these hashes, so a worker built from an older commit whose
	 *  worker image is unchanged still matches. */
	build_worker_hash?: string | null;
	build_matches_control_plane?: boolean | null;
}

export interface WiringNet {
	id: string;
	definition_name: string;
	instance_name: string;
	worker_id: string | null;
	deployment_id: string | null;
	load_state: string;
	load_error: string | null;
}

export interface WiringSlot {
	slot_name: string;
	places: string[];
	transitions: string[];
}

export interface WiringNotebook {
	id: string;
	definition_name: string;
	instance_name: string;
	worker_id: string | null;
	deployment_id: string | null;
	load_state: string;
	load_error: string | null;
	/** See `Notebook`. */
	desired_load_state: 'loaded' | 'unloaded';
	/** See `Notebook`: the stored setting, and the control plane's resolution
	 *  of it. Read-only here — the picker lives on the notebook page. */
	idle_timeout_seconds: number | null;
	effective_idle_timeout_seconds: number;
	slots: WiringSlot[];
}

export interface WiringBinding {
	notebook_instance_id: string;
	slot_name: string;
	net_id: string;
}

/** The control plane's own build. Each field is null when unknown. */
export interface ControlPlaneBuild {
	commit: string | null;
	short: string | null;
	built_at: string | null;
}

export interface WiringResponse {
	workers: WiringWorker[];
	nets: WiringNet[];
	notebooks: WiringNotebook[];
	bindings: WiringBinding[];
	/** Absent on an older control plane. */
	control_plane_build?: ControlPlaneBuild | null;
}

export async function getWiring(): Promise<WiringResponse> {
	const res = await get('/api/wiring');
	if (!res.ok) throw new Error('Failed to load wiring');
	return res.json();
}

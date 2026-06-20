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
	'/health-check', '/trigger',
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
	default: string | null;
	required: boolean;
}

export interface Net {
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
	factory_params_schema: NetParam[] | null;
	step_wall_clock_timeout_seconds: number | null;
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

export async function getExecutionState(netId: string): Promise<any> {
	const res = await get(`/api/nets/${netId}/execution/state`);
	if (!res.ok) throw new Error('Failed to get execution state');
	return res.json();
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
	if (!res.ok) throw new Error('Failed to step');
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
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to inject token'));
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
	if (!res.ok) throw new Error('Failed to get token');
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
	created_at: string;
	updated_at: string;
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

export async function deleteWorker(workerId: string): Promise<void> {
	const res = await del(`/api/workers/${workerId}`);
	if (!res.ok) throw new Error('Failed to delete worker');
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

/**
 * Durable per-net subprocess log tail from the worker's local rotating file.
 * Used to seed the net-page log panel with history that survives subprocess
 * and worker restarts (the live SSE ring does not). Returns [] if the worker
 * is unreachable — the file lives on its disk.
 */
export async function getNetLogHistory(
	netId: string,
): Promise<Array<{ ts: string | null; text: string }>> {
	const res = await get(`/api/nets/${netId}/logs/history`);
	if (!res.ok) return [];
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
export interface DiscoveredNotebook {
	name: string;
	path_in_tarball: string;
	slots: NotebookSlot[];
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

export interface Notebook {
	id: string;
	definition_name: string;
	instance_name: string;
	deployment_id: string | null;
	worker_id: string | null;
	load_state: string;
	load_error: string | null;
	path_in_tarball: string | null;
	slots: NotebookSlot[];
	bindings: NotebookBinding[];
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
	body: { instance_name?: string; worker_id?: string | null },
): Promise<Notebook> {
	const res = await patch(`/api/notebooks/${id}`, body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to update notebook'));
	return res.json();
}

export async function deleteNotebook(id: string): Promise<void> {
	const res = await del(`/api/notebooks/${id}`);
	if (!res.ok) throw new Error('Failed to delete notebook');
}

export async function loadNotebook(id: string): Promise<{ status: string; port: number | null }> {
	const res = await post(
		`/api/notebooks/${id}/load`,
		undefined,
		withIdempotency(newIdempotencyKey()),
	);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to load notebook'));
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
	slots: WiringSlot[];
}

export interface WiringBinding {
	notebook_instance_id: string;
	slot_name: string;
	net_id: string;
}

export interface WiringResponse {
	workers: WiringWorker[];
	nets: WiringNet[];
	notebooks: WiringNotebook[];
	bindings: WiringBinding[];
}

export async function getWiring(): Promise<WiringResponse> {
	const res = await get('/api/wiring');
	if (!res.ok) throw new Error('Failed to load wiring');
	return res.json();
}

import type { NotebookSync, NotebookSyncSlot, Operation, OperationSummary } from './api';
import { kindLabel, stepLabel } from './operations';
import { slotInterval, type NotebookViewerThresholds } from './notebookThresholds';

/**
 * Deciding what is actually wrong with a notebook, and what to do about it.
 *
 * The bug this exists to make impossible: a notebook whose numbers silently
 * stopped updating looks exactly like one whose numbers are correct and
 * unchanging. The only thing that separates them is how long ago the data was
 * last confirmed, so everything here is derived from ages and errors on every
 * read — never latched on "we heard something once", which is how the nets
 * page ended up with a "Connected" indicator that could not go back.
 *
 * Aggregation takes the worst slot. A page showing one live net and one that
 * lost contact is not a live page, and averaging would hide exactly the slot
 * the reader needs to distrust.
 *
 * Slot freshness alone turned out not to be enough. It describes the HTTP path
 * from the notebook's bridge; the rendering in the iframe travels a WebSocket,
 * and the two fail independently. A notebook once sat frozen for 259 seconds
 * with every slot reporting a sub-second sync age, because its browser had not
 * opened a socket yet. `diagnose` reads both, so the states below name a
 * specific broken hop instead of a general unease.
 *
 * Every threshold arrives as an argument (`NotebookViewerThresholds`, served
 * by the control plane), so these functions hold no numbers of their own.
 */

export type SyncState = 'live' | 'syncing' | 'stale' | 'disconnected';

const SEVERITY: Record<SyncState, number> = {
	live: 0,
	syncing: 1,
	stale: 2,
	disconnected: 3,
};

const COLOURS: Record<SyncState, string> = {
	live: '#22c55e',
	syncing: '#eab308',
	stale: '#f59e0b',
	disconnected: '#ef4444',
};

/**
 * One slot's freshness, judged against its own cadence.
 *
 * The bridge widens its check interval when fetches are slow, up to a minute,
 * so a fixed age would call a deliberately backed-off notebook stale. Stale is
 * `stale_intervals` missed intervals, silent is `silent_intervals`, where the
 * interval is the one the slot reports (or the default when it reports none).
 */
export function slotSyncState(
	slot: NotebookSyncSlot,
	thresholds: NotebookViewerThresholds,
): SyncState {
	const interval = slotInterval(slot, thresholds);
	// Checked first: if the subprocess has gone quiet, everything else it told
	// us is only getting older, however healthy it looked at the time. Silence
	// for several intervals means the subprocess itself is gone, a different
	// failure from "it is running and telling us it cannot reach the net".
	if (slot.report_age_s > thresholds.silent_intervals * interval) return 'disconnected';
	// Reporting, but unable to reach its net — the data on screen is frozen at
	// whatever it last managed to read.
	if (slot.last_error) return 'stale';
	// Null age means no successful sync has ever happened, which is the normal
	// state for a second or two after opening. Distinct from an age of 0.
	if (slot.last_sync_age_s === null) return 'syncing';
	// A few missed intervals is past explaining away as jitter or a slow round trip.
	if (slot.last_sync_age_s > thresholds.stale_intervals * interval) return 'stale';
	return 'live';
}

export function syncColour(state: SyncState): string {
	return COLOURS[state];
}

function describeSlot(slot: NotebookSyncSlot, thresholds: NotebookViewerThresholds): string {
	const state = slotSyncState(slot, thresholds);
	const parts = [`${slot.slot_name}: ${state}`];
	if (slot.last_sync_age_s !== null) {
		parts.push(`synced ${slot.last_sync_age_s.toFixed(0)}s ago`);
	} else {
		parts.push('never synced');
	}
	if (slot.reconcile_interval_s) parts.push(`checking every ${slot.reconcile_interval_s.toFixed(0)}s`);
	if (slot.step_count !== null) parts.push(`step ${slot.step_count}`);
	if (slot.last_error) parts.push(slot.last_error);
	return parts.join(' · ');
}

export interface SyncBadge {
	state: SyncState;
	label: string;
	title: string;
	colour: string;
}

/**
 * Build the header badge, or null when there is nothing honest to say —
 * a notebook with no bindings has no freshness to report, and inventing a
 * reassuring badge for it would be worse than showing none.
 */
export function syncBadge(
	slots: NotebookSyncSlot[] | null | undefined,
	thresholds: NotebookViewerThresholds,
): SyncBadge | null {
	if (!slots || slots.length === 0) return null;

	const stateOf = (slot: NotebookSyncSlot) => slotSyncState(slot, thresholds);
	const worst = slots.reduce((acc, slot) =>
		SEVERITY[stateOf(slot)] > SEVERITY[stateOf(acc)] ? slot : acc,
	);
	const state = stateOf(worst);

	let label: string = state;
	if (state === 'stale' && worst.last_sync_age_s !== null) {
		label = `stale ${worst.last_sync_age_s.toFixed(0)}s`;
	}

	return {
		state,
		label,
		title: slots.map((slot) => describeSlot(slot, thresholds)).join('\n'),
		colour: syncColour(state),
	};
}

// -- the render channel ---------------------------------------------------

/**
 * How long the oldest push into marimo that no frame has followed has been
 * waiting, in seconds before this reading, or null when every push has been
 * drawn or there was never one.
 *
 * A frame is only owed after a push: a notebook watching a five-minute net
 * draws nothing between steps, and judging frame age against the wall clock
 * called that "not drawing" for most of every cycle. The slot's
 * `last_push_age_s` is aged at the report's stamp, which is itself
 * `report_age_s` old, so the push happened `report_age_s + last_push_age_s`
 * before this reading; `last_frame_age_s` is on the same worker clock. A
 * frame younger than a push has drawn it.
 *
 * A report names only the latest push, and a net that steps every few seconds
 * pushes every few seconds, so its latest push is always young even when the
 * page froze minutes ago. `carriedAgeS` is the page's memory of the oldest
 * undrawn push from earlier readings, rebased to this one: it counts until a
 * frame newer than it arrives. Feeding this function's result back in, rebased
 * by the time between polls, is what keeps that memory.
 */
export function undrawnPushAgeS(
	sync: NotebookSync,
	carriedAgeS: number | null = null,
): number | null {
	const frameAge = sync.transport?.last_frame_age_s ?? null;
	const pushAges = (sync.slots ?? [])
		.filter((slot) => slot.last_push_age_s !== null && slot.last_push_age_s !== undefined)
		.map((slot) => slot.report_age_s + (slot.last_push_age_s as number));
	if (carriedAgeS !== null) pushAges.push(carriedAgeS);
	const undrawn = pushAges.filter((pushAge) => frameAge === null || frameAge > pushAge);
	return undrawn.length === 0 ? null : Math.max(...undrawn);
}

/**
 * Whether the page has stopped drawing: a push more than `frame_stall_s` ago
 * with no frame relayed since. The threshold sits well under the relay's own
 * 120s pong deadline, so this verdict lands while the socket is still
 * nominally alive; otherwise "no frames" and "no socket" collapse into one.
 */
export function framesStalled(
	sync: NotebookSync,
	thresholds: NotebookViewerThresholds,
	carriedAgeS: number | null = null,
): boolean {
	const waited = undrawnPushAgeS(sync, carriedAgeS);
	return waited !== null && waited > thresholds.frame_stall_s;
}

export type NotebookState =
	| SyncState
	| 'checking'
	| 'connecting'
	| 'no_transport'
	| 'frames_stalled'
	| 'bridge_missing'
	| 'bridge_stalled'
	| 'worker_busy'
	| 'worker_unreachable'
	| 'subprocess_gone'
	| 'not_loaded'
	| 'busy';

/**
 * The recovery a diagnosis suggests.
 *
 * `remount` reloads the iframe: cheap, recovers a render channel that never
 * came up, and costs the chart's in-memory history. `reload` respawns the
 * subprocess and is heavier. Either is offered as a button; `automatic` on
 * the diagnosis says whether the page may also act without being asked.
 */
export type NotebookAction = 'none' | 'remount' | 'reload';

export interface Diagnosis {
	state: NotebookState;
	action: NotebookAction;
	/**
	 * Whether the page may take `action` on its own. True for exactly one
	 * case: a socket that never opened after the asset burst settled, with no
	 * operation in flight on the notebook or its worker. Every other action
	 * is a suggestion a person takes with a button, because a guess acted on
	 * without being asked is how a busy worker got a fresh asset burst on top
	 * of whatever was already keeping it busy.
	 */
	automatic: boolean;
	label: string;
	/** One line naming the broken hop, for the badge tooltip. */
	detail: string;
	/** The operation a `busy` verdict names. */
	operation?: Operation | OperationSummary | null;
}

const TRANSPORT_COLOURS: Record<string, string> = {
	checking: '#9ca3af',
	connecting: '#eab308',
	no_transport: '#ef4444',
	frames_stalled: '#ef4444',
	bridge_missing: '#f59e0b',
	bridge_stalled: '#f59e0b',
	worker_busy: '#f59e0b',
	worker_unreachable: '#ef4444',
	subprocess_gone: '#ef4444',
	not_loaded: '#6b7280',
	busy: '#eab308',
};

export function stateColour(state: NotebookState): string {
	return TRANSPORT_COLOURS[state] ?? syncColour(state as SyncState);
}

/**
 * Context only the page knows.
 *
 * `sinceBurstSettledS` is seconds since Marimo's asset burst went quiet, or
 * null while it is still loading. The server has no clock for "the browser
 * should have connected by now" — it cannot see a browser that never arrived —
 * so this is the one input that has to come from here.
 */
export interface DiagnoseContext {
	sinceBurstSettledS: number | null;
	/**
	 * The oldest undrawn push the page remembers from earlier polls, rebased
	 * to this reading (see `undrawnPushAgeS`). Null or absent when it
	 * remembers none, and then only this reading's pushes count.
	 */
	carriedPushAgeS?: number | null;
	/** The running operation on this notebook (its load), or null. */
	notebookOperation?: Operation | OperationSummary | null;
	/**
	 * The running operation on the notebook's worker, or null. Absent means
	 * the caller has nothing better than the sync report's own
	 * `worker_busy_with`, which is used instead; an explicit null means the
	 * caller knows the worker is idle (the stream saw that operation finish).
	 */
	workerOperation?: Operation | OperationSummary | null;
}

const SUBPROCESS_GONE: Diagnosis = {
	state: 'subprocess_gone',
	action: 'reload',
	automatic: false,
	label: 'subprocess gone',
	detail: 'The notebook subprocess died. Reload to respawn it.',
};

/**
 * What the page shows before the thresholds have loaded. Takes no action:
 * a remount decided without its budget is a guess.
 */
export const CHECKING: Diagnosis = {
	state: 'checking',
	action: 'none',
	automatic: false,
	label: 'checking',
	detail: 'Loading the thresholds this page judges by.',
};

/**
 * The verdict while an operation is in flight on the notebook or its worker.
 *
 * Busy is known, not inferred: the control plane holds a heartbeating record
 * of the work. Nothing is remounted while it runs, because a remount is a new
 * Marimo session and a new asset burst on a worker whose capacity the
 * operation is already using. The notebook's own operation is named first:
 * it is the one the page is waiting for.
 */
export function busyDiagnosis(
	notebookOperation: Operation | OperationSummary | null,
	workerOperation: Operation | OperationSummary | null,
): Diagnosis | null {
	const operation = notebookOperation ?? workerOperation;
	if (!operation) return null;
	const kind = kindLabel(operation.kind);
	const step = stepLabel(operation.step);
	const doing = step ? `${kind.toLowerCase()}, ${step}` : kind.toLowerCase();
	const message = operation.step_message?.trim();
	return {
		state: 'busy',
		action: 'none',
		automatic: false,
		label: `busy · ${step ?? kind.toLowerCase()}`,
		detail:
			(notebookOperation
				? `This notebook is busy ${doing}`
				: `Its worker is busy ${doing}`) +
			(message ? ` (${message})` : '') +
			'. The page waits for it rather than reconnecting.',
		operation,
	};
}

/**
 * Name the broken hop and say what to do, from server-side evidence only.
 *
 * Ordered most-authoritative first. A notebook whose worker is unreachable has
 * nothing useful to say about its own websocket, so later checks must not get
 * the chance to contradict an earlier one with staler evidence.
 */
export function diagnose(
	sync: NotebookSync,
	thresholds: NotebookViewerThresholds | null,
	ctx: DiagnoseContext,
): Diagnosis {
	// Ahead of every other check, thresholds included: a verdict that knows
	// what the worker is doing needs no budget to judge by, and a later check
	// must not reach a remount while the worker is working.
	const busy = busyDiagnosis(
		ctx.notebookOperation ?? null,
		ctx.workerOperation !== undefined ? ctx.workerOperation : (sync.worker_busy_with ?? null),
	);
	if (busy) return busy;

	if (thresholds === null) return { ...CHECKING };

	if (sync.reachable === false) {
		if (sync.reason === 'no_worker' || sync.reason === 'not_loaded') {
			return {
				state: 'not_loaded',
				action: 'none',
				automatic: false,
				label: 'not loaded',
				detail:
					sync.reason === 'no_worker'
						? 'This notebook is not assigned to a worker.'
						: 'The notebook subprocess is not running.',
			};
		}
		if (sync.reason === 'worker_busy') {
			// A timeout says the worker is slow to answer, not that anything
			// died. Reloading would add load to a machine already short of it.
			return {
				state: 'worker_busy',
				action: 'none',
				automatic: false,
				label: 'worker busy',
				detail:
					'The worker took more than 5 s to answer; it is probably saturated. ' +
					'Nothing is known to be dead.',
			};
		}
		if (sync.reason === 'subprocess_gone') return { ...SUBPROCESS_GONE };
		return {
			state: 'worker_unreachable',
			action: 'reload',
			automatic: false,
			label: 'unreachable',
			detail: 'The control plane could not reach this notebook’s worker.',
		};
	}

	const transport = sync.transport;
	if (!transport) {
		// An older worker or control plane. Fall back to what we can see and
		// take no action: inventing a transport failure here would remount a
		// page over a channel we simply have no reporting for.
		const badge = syncBadge(sync.slots, thresholds);
		return {
			state: badge?.state ?? 'syncing',
			action: 'none',
			automatic: false,
			label: badge?.label ?? 'syncing',
			detail: badge?.title ?? 'No render-channel reporting from this worker.',
		};
	}

	// An older worker keeps a dead entry and answers for it with a dead
	// transport; a newer one forgets it and the control plane reports
	// `subprocess_gone`. Both mean the same thing.
	if (!transport.alive) return { ...SUBPROCESS_GONE };

	if (transport.ws_sessions < 1) {
		// Still within the window where not being connected is just "loading".
		// Null means the burst has not settled, so nothing has been given a
		// chance yet — remounting mid-burst restarts the fetch and makes a slow
		// open into an unbounded one.
		const waited = ctx.sinceBurstSettledS;
		if (waited === null || waited < thresholds.ws_open_deadline_s) {
			return {
				state: 'connecting',
				action: 'none',
				automatic: false,
				label: 'connecting',
				detail: 'Waiting for the notebook to open its connection.',
			};
		}
		// Only a socket that never opened is remounted without asking: that
		// is the one failure a fresh iframe reliably fixes, and the busy check
		// above has already ruled out a worker with work in flight. A socket
		// that opened and dropped may be the worker shedding load, so a
		// person decides.
		const neverOpened = transport.ws_opened_total === 0;
		return {
			state: 'no_transport',
			action: 'remount',
			automatic: neverOpened,
			label: neverOpened ? 'reconnecting' : 'disconnected',
			detail: neverOpened
				? 'The notebook never opened its connection.'
				: 'The notebook’s connection dropped and did not come back.',
		};
	}

	// A browser is attached from here on, so anything still wrong is behind it.

	const expectsBridge = (sync.bindings ?? sync.slots.length) > 0;
	if (expectsBridge && transport.first_report_age_s === null) {
		const sinceOpen = transport.last_ws_open_age_s ?? 0;
		// Covers the cell run that starts the bridge, not just its cadence.
		if (sinceOpen < thresholds.bridge_start_deadline_s) {
			return {
				state: 'connecting',
				action: 'none',
				automatic: false,
				label: 'starting',
				detail: 'Waiting for the notebook to start tracking its nets.',
			};
		}
		return {
			state: 'bridge_missing',
			action: 'remount',
			automatic: false,
			label: 'not tracking',
			detail: 'The notebook is connected but never started tracking its nets.',
		};
	}

	const carried = ctx.carriedPushAgeS ?? null;
	if (framesStalled(sync, thresholds, carried)) {
		const waited = undrawnPushAgeS(sync, carried) ?? 0;
		return {
			state: 'frames_stalled',
			action: 'reload',
			automatic: false,
			label: 'not drawing',
			detail:
				transport.last_frame_age_s === null
					? `Connected, but the notebook has never drawn anything; its data changed ${waited.toFixed(0)}s ago.`
					: `Connected, but the notebook's data changed ${waited.toFixed(0)}s ago and nothing has been drawn since.`,
		};
	}

	// The channel is carrying, or has had nothing new to carry. Whatever is
	// left is the bridge falling behind, which the slot ages already describe
	// better than anything here could.
	const badge = syncBadge(sync.slots, thresholds);
	if (!badge) {
		return {
			state: 'live',
			action: 'none',
			automatic: false,
			label: 'live',
			detail: 'Connected and drawing. No nets bound.',
		};
	}
	if (badge.state === 'stale' || badge.state === 'disconnected') {
		return {
			state: 'bridge_stalled',
			action: 'reload',
			automatic: false,
			label: badge.label,
			detail: badge.title,
		};
	}
	return {
		state: badge.state,
		action: 'none',
		automatic: false,
		label: badge.label,
		detail: badge.title,
	};
}

// -- self-heal policy -----------------------------------------------------

/**
 * The automatic remount budget: at most `remount_budget` remounts in any
 * `remount_window_s` window. Once spent, the page stops guessing and says so
 * (exhausted) until the oldest remount ages out of the window.
 */

export interface RemountPlan {
	/** Remount the iframe after `delayS`. */
	remount: boolean;
	delayS: number;
	/** The budget is spent; the page should now ask the user. */
	exhausted: boolean;
	/**
	 * Epoch seconds of remounts still inside the window, to carry into the
	 * next poll. When `remount` is true it includes this one, stamped at
	 * `nowS + delayS`: the moment its Marimo session starts.
	 */
	history: number[];
}

/**
 * Decide whether to reload the iframe on the page's own initiative, given a
 * diagnosis and the remounts already made. Pure: the caller supplies the
 * clock as `nowS`.
 *
 * Only an `automatic` diagnosis is acted on, which is the socket that never
 * opened with nothing in flight; a remount the diagnosis merely suggests
 * waits for its button, and a busy verdict plans nothing at all.
 *
 * Capped rather than looping. Each remount is a fresh Marimo session, which
 * costs the chart's in-memory history and starts a kernel thread that keeps
 * running on the worker; retrying forever against a persistently broken
 * worker turns one frozen page into a permanent reload loop that also keeps
 * making work for the worker. Past the cap the page stops guessing and says
 * what it found, which a person can act on with information this code does
 * not have.
 *
 * The cap bounds remounts over time, and a recovery does not refund it. A
 * CPU-starved worker flaps between stalled and live every minute or two; when
 * recovery reset the count, one page remounted 43 times in 80 minutes, and
 * every extra session made the starvation worse. Ageing out of the window is
 * what restores budget, so a page left open for days still heals from
 * unrelated hiccups hours apart.
 */
export function planRemount(
	diagnosis: Diagnosis,
	history: readonly number[],
	nowS: number,
	thresholds: NotebookViewerThresholds,
): RemountPlan {
	const { remount_budget: budget, remount_window_s: window, remount_backoff_s: backoff } =
		thresholds;
	const recent = history.filter((t) => t > nowS - window);
	if (!diagnosis.automatic || diagnosis.action !== 'remount') {
		return { remount: false, delayS: 0, exhausted: false, history: recent };
	}
	if (recent.length >= budget) {
		return { remount: false, delayS: 0, exhausted: true, history: recent };
	}
	// Backing off between tries, because the common cause of a slow connect is
	// a busy worker, and remounting immediately adds a fresh asset burst to
	// whatever is already saturating it.
	const delayS = backoff[recent.length] ?? backoff[backoff.length - 1];
	return { remount: true, delayS, exhausted: false, history: [...recent, nowS + delayS] };
}

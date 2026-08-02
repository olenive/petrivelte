import type { NotebookSync, NotebookSyncSlot } from './api';

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
 */

/** A slot syncs roughly every reconcile interval (5s server-side). Three
 *  missed intervals is past explaining away as jitter or a slow round trip. */
export const STALE_AFTER_S = 15;

/** The subprocess reports on every pass, so silence for six intervals means
 *  the subprocess itself is gone — a different failure from "it is running and
 *  telling us it cannot reach the net". */
export const SILENT_AFTER_S = 30;

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

export function slotSyncState(slot: NotebookSyncSlot): SyncState {
	// Checked first: if the subprocess has gone quiet, everything else it told
	// us is only getting older, however healthy it looked at the time.
	if (slot.report_age_s > SILENT_AFTER_S) return 'disconnected';
	// Reporting, but unable to reach its net — the data on screen is frozen at
	// whatever it last managed to read.
	if (slot.last_error) return 'stale';
	// Null age means no successful sync has ever happened, which is the normal
	// state for a second or two after opening. Distinct from an age of 0.
	if (slot.last_sync_age_s === null) return 'syncing';
	if (slot.last_sync_age_s > STALE_AFTER_S) return 'stale';
	return 'live';
}

export function syncColour(state: SyncState): string {
	return COLOURS[state];
}

function describeSlot(slot: NotebookSyncSlot): string {
	const state = slotSyncState(slot);
	const parts = [`${slot.slot_name}: ${state}`];
	if (slot.last_sync_age_s !== null) {
		parts.push(`synced ${slot.last_sync_age_s.toFixed(0)}s ago`);
	} else {
		parts.push('never synced');
	}
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
export function syncBadge(slots: NotebookSyncSlot[] | null | undefined): SyncBadge | null {
	if (!slots || slots.length === 0) return null;

	const worst = slots.reduce((acc, slot) =>
		SEVERITY[slotSyncState(slot)] > SEVERITY[slotSyncState(acc)] ? slot : acc,
	);
	const state = slotSyncState(worst);

	let label: string = state;
	if (state === 'stale' && worst.last_sync_age_s !== null) {
		label = `stale ${worst.last_sync_age_s.toFixed(0)}s`;
	}

	return {
		state,
		label,
		title: slots.map(describeSlot).join('\n'),
		colour: syncColour(state),
	};
}

// -- the render channel ---------------------------------------------------

/**
 * Mirrored from petritype-server's `petritype_server/timeouts.py`, which
 * documents the reasoning and holds the ordering tests. Duplicated rather than
 * fetched because a page that has lost contact with the control plane still
 * has to decide what to do, and asking it for its own deadlines at that moment
 * is the worst possible time.
 */

/** From the asset burst settling to a socket the worker can see. Measured from
 *  burst settle, not from the iframe's load event: a cold spawn's burst has
 *  been observed at 61s, and a remount restarts it from nothing. */
export const WS_OPEN_DEADLINE_S = 45;

/** Session open, no frame from the kernel. Well under the relay's own 120s
 *  pong deadline, so this verdict lands while the socket is still nominally
 *  alive — otherwise "no frames" and "no socket" collapse into one. */
export const FRAME_STALL_S = 30;

/** Socket open and slots bound, but the bridge has never reported. Covers the
 *  cell run that starts it, not just the reconciler's 5s cadence. */
export const BRIDGE_START_DEADLINE_S = 30;

export type NotebookState =
	| SyncState
	| 'connecting'
	| 'no_transport'
	| 'frames_stalled'
	| 'bridge_missing'
	| 'bridge_stalled'
	| 'worker_unreachable'
	| 'not_loaded';

/**
 * What the page may do about it without being asked.
 *
 * `remount` reloads the iframe: cheap, recovers a render channel that never
 * came up, and costs the chart's in-memory history. `reload` respawns the
 * subprocess and is never automatic — it is heavier, and the states that
 * suggest it (a wedged kernel, a bridge that stopped mid-run) are ones where a
 * human can see things this code cannot.
 */
export type NotebookAction = 'none' | 'remount' | 'reload';

export interface Diagnosis {
	state: NotebookState;
	action: NotebookAction;
	label: string;
	/** One line naming the broken hop, for the badge tooltip. */
	detail: string;
}

const TRANSPORT_COLOURS: Record<string, string> = {
	connecting: '#eab308',
	no_transport: '#ef4444',
	frames_stalled: '#ef4444',
	bridge_missing: '#f59e0b',
	bridge_stalled: '#f59e0b',
	worker_unreachable: '#ef4444',
	not_loaded: '#6b7280',
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
}

/**
 * Name the broken hop and say what to do, from server-side evidence only.
 *
 * Ordered most-authoritative first. A notebook whose worker is unreachable has
 * nothing useful to say about its own websocket, so later checks must not get
 * the chance to contradict an earlier one with staler evidence.
 */
export function diagnose(sync: NotebookSync, ctx: DiagnoseContext): Diagnosis {
	if (sync.reachable === false) {
		if (sync.reason === 'no_worker' || sync.reason === 'not_loaded') {
			return {
				state: 'not_loaded',
				action: 'none',
				label: 'not loaded',
				detail:
					sync.reason === 'no_worker'
						? 'This notebook is not assigned to a worker.'
						: 'The notebook subprocess is not running.',
			};
		}
		return {
			state: 'worker_unreachable',
			action: 'reload',
			label: 'unreachable',
			detail: 'The control plane could not reach this notebook’s worker.',
		};
	}

	const transport = sync.transport;
	if (!transport) {
		// An older worker or control plane. Fall back to what we can see and
		// take no action: inventing a transport failure here would remount a
		// page over a channel we simply have no reporting for.
		const badge = syncBadge(sync.slots);
		return {
			state: badge?.state ?? 'syncing',
			action: 'none',
			label: badge?.label ?? 'syncing',
			detail: badge?.title ?? 'No render-channel reporting from this worker.',
		};
	}

	if (!transport.alive) {
		return {
			state: 'worker_unreachable',
			action: 'reload',
			label: 'subprocess gone',
			detail: 'The notebook subprocess died. Reload to respawn it.',
		};
	}

	if (transport.ws_sessions < 1) {
		// Still within the window where not being connected is just "loading".
		// Null means the burst has not settled, so nothing has been given a
		// chance yet — remounting mid-burst restarts the fetch and makes a slow
		// open into an unbounded one.
		const waited = ctx.sinceBurstSettledS;
		if (waited === null || waited < WS_OPEN_DEADLINE_S) {
			return {
				state: 'connecting',
				action: 'none',
				label: 'connecting',
				detail: 'Waiting for the notebook to open its connection.',
			};
		}
		return {
			state: 'no_transport',
			action: 'remount',
			label: 'reconnecting',
			detail:
				transport.ws_opened_total > 0
					? 'The notebook’s connection dropped and did not come back.'
					: 'The notebook never opened its connection.',
		};
	}

	// A browser is attached from here on, so anything still wrong is behind it.

	const expectsBridge = (sync.bindings ?? sync.slots.length) > 0;
	if (expectsBridge && transport.first_report_age_s === null) {
		const sinceOpen = transport.last_ws_open_age_s ?? 0;
		if (sinceOpen < BRIDGE_START_DEADLINE_S) {
			return {
				state: 'connecting',
				action: 'none',
				label: 'starting',
				detail: 'Waiting for the notebook to start tracking its nets.',
			};
		}
		return {
			state: 'bridge_missing',
			action: 'remount',
			label: 'not tracking',
			detail: 'The notebook is connected but never started tracking its nets.',
		};
	}

	const frameAge = transport.last_frame_age_s;
	if (frameAge === null || frameAge > FRAME_STALL_S) {
		return {
			state: 'frames_stalled',
			action: 'reload',
			label: 'not drawing',
			detail:
				frameAge === null
					? 'Connected, but the notebook has never drawn anything.'
					: `Connected, but nothing has been drawn for ${frameAge.toFixed(0)}s.`,
		};
	}

	// The channel is carrying. Whatever is left is the bridge falling behind,
	// which the slot ages already describe better than anything here could.
	const badge = syncBadge(sync.slots);
	if (!badge) {
		return {
			state: 'live',
			action: 'none',
			label: 'live',
			detail: 'Connected and drawing. No nets bound.',
		};
	}
	if (badge.state === 'stale' || badge.state === 'disconnected') {
		return {
			state: 'bridge_stalled',
			action: 'reload',
			label: badge.label,
			detail: badge.title,
		};
	}
	return { state: badge.state, action: 'none', label: badge.label, detail: badge.title };
}

// -- self-heal policy -----------------------------------------------------

/** Mirrors NOTEBOOK_REMOUNT_MAX_ATTEMPTS / _BACKOFF_S in timeouts.py. */
export const REMOUNT_MAX_ATTEMPTS = 2;
export const REMOUNT_BACKOFF_S = [5, 20];

export interface RemountPlan {
	/** Remount the iframe after `delayS`. */
	remount: boolean;
	delayS: number;
	/** Tried everything; the page should now ask the user. */
	exhausted: boolean;
	/** Attempt count to carry into the next poll. */
	attempts: number;
}

/**
 * Decide whether to reload the iframe, given a diagnosis and what we already tried.
 *
 * Capped rather than looping. Each remount is a fresh Marimo session, which
 * costs the chart's in-memory history and respawns a kernel; retrying forever
 * against a persistently broken worker turns one frozen page into a permanent
 * reload loop that also keeps making work for the worker. Past the cap the
 * page stops guessing and says what it found, which a person can act on with
 * information this code does not have.
 *
 * A recovered notebook resets the count, so a page left open for days is not
 * gradually consumed by unrelated hiccups hours apart.
 */
export function planRemount(diagnosis: Diagnosis, attempts: number): RemountPlan {
	const recovered = diagnosis.state === 'live' || diagnosis.state === 'syncing';
	if (diagnosis.action !== 'remount') {
		return { remount: false, delayS: 0, exhausted: false, attempts: recovered ? 0 : attempts };
	}
	if (attempts >= REMOUNT_MAX_ATTEMPTS) {
		return { remount: false, delayS: 0, exhausted: true, attempts };
	}
	// Backing off between tries, because the common cause of a slow connect is
	// a busy worker — and remounting immediately adds a fresh asset burst to
	// whatever is already saturating it.
	const delayS = REMOUNT_BACKOFF_S[attempts] ?? REMOUNT_BACKOFF_S[REMOUNT_BACKOFF_S.length - 1];
	return { remount: true, delayS, exhausted: false, attempts: attempts + 1 };
}

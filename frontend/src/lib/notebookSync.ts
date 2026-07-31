import type { NotebookSyncSlot } from './api';

/**
 * Turning per-slot sync ages into one badge for the notebook header.
 *
 * The bug this exists to make impossible: a notebook whose numbers silently
 * stopped updating looks exactly like one whose numbers are correct and
 * unchanging. The only thing that separates them is how long ago the data was
 * last confirmed, so the badge is derived from ages and errors — never latched
 * on "we heard something once", which is how the nets page ended up with a
 * "Connected" indicator that could not go back.
 *
 * Aggregation takes the worst slot. A page showing one live net and one that
 * lost contact is not a live page, and averaging would hide exactly the slot
 * the reader needs to distrust.
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

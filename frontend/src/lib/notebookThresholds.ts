/**
 * The thresholds the notebook viewer judges by, as served by the control plane.
 *
 * They used to be copied by hand from petritype-server's `timeouts.py`, and
 * the copies drifted: the remount budget changed on one side only, and the
 * stale threshold kept assuming a five-second cadence after the SDK learned
 * to back off to sixty. The control plane now serves them from that module,
 * and this page keeps none of its own.
 *
 * Until they arrive nothing is judged: badges read "checking" and no remount
 * is planned. A page that cannot reach the control plane for its thresholds
 * cannot reach it for the sync report either, so there is nothing to judge in
 * that state anyway.
 */

import { writable } from 'svelte/store';

import { getNotebookViewerThresholds } from './api';

export interface NotebookViewerThresholds {
	/** A slot is stale past this many of its reconcile intervals without a sync. */
	stale_intervals: number;
	/** The subprocess is silent past this many intervals without a report. */
	silent_intervals: number;
	/** The interval to judge by when a slot does not report its own. */
	default_reconcile_interval_s: number;
	/** From the asset burst settling to a socket the worker can see. */
	ws_open_deadline_s: number;
	/** A push this old with no frame relayed since means the page is not drawing. */
	frame_stall_s: number;
	/** Socket open and slots bound, but the bridge has never reported. */
	bridge_start_deadline_s: number;
	/** Automatic remounts allowed in any `remount_window_s`. */
	remount_budget: number;
	remount_window_s: number;
	/** Delay before a remount, indexed by remounts already in the window. */
	remount_backoff_s: number[];
	/** How often the notebook page polls its sync report. */
	sync_poll_s: number;
}

const NUMBER_FIELDS = [
	'stale_intervals',
	'silent_intervals',
	'default_reconcile_interval_s',
	'ws_open_deadline_s',
	'frame_stall_s',
	'bridge_start_deadline_s',
	'remount_budget',
	'remount_window_s',
	'sync_poll_s',
] as const;

function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Check a payload has every threshold, each a positive number.
 *
 * Throws rather than filling gaps: a missing threshold defaulted to zero
 * would call every notebook stale, and one defaulted to anything else is a
 * copy of the kind this module exists to remove.
 */
export function parseThresholds(raw: unknown): NotebookViewerThresholds {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('Notebook viewer thresholds: expected an object');
	}
	const record = raw as Record<string, unknown>;
	for (const field of NUMBER_FIELDS) {
		if (!positive(record[field])) {
			throw new Error(`Notebook viewer thresholds: ${field} is not a positive number`);
		}
	}
	const backoff = record.remount_backoff_s;
	if (!Array.isArray(backoff) || backoff.length === 0 || !backoff.every(positive)) {
		throw new Error('Notebook viewer thresholds: remount_backoff_s is not a list of positive numbers');
	}
	const pick = (field: (typeof NUMBER_FIELDS)[number]) => record[field] as number;
	return {
		stale_intervals: pick('stale_intervals'),
		silent_intervals: pick('silent_intervals'),
		default_reconcile_interval_s: pick('default_reconcile_interval_s'),
		ws_open_deadline_s: pick('ws_open_deadline_s'),
		frame_stall_s: pick('frame_stall_s'),
		bridge_start_deadline_s: pick('bridge_start_deadline_s'),
		remount_budget: pick('remount_budget'),
		remount_window_s: pick('remount_window_s'),
		remount_backoff_s: [...(backoff as number[])],
		sync_poll_s: pick('sync_poll_s'),
	};
}

// -- the store ------------------------------------------------------------

/**
 * Loaded once per page load and shared by the notebook page and the index.
 * The values change only with a control-plane deploy, which reloads the SPA
 * on the next navigation anyway.
 */
const _thresholds = writable<NotebookViewerThresholds | null>(null);
let _inflight: Promise<NotebookViewerThresholds> | null = null;
let _loaded: NotebookViewerThresholds | null = null;

export const notebookThresholdsStore = { subscribe: _thresholds.subscribe };

/**
 * Fetch the thresholds unless they are already here, sharing one request
 * between concurrent callers. A failure is not remembered, so the next call
 * tries again; callers keep reading "checking" until one succeeds.
 */
export function loadNotebookThresholds(
	fetchFn: () => Promise<unknown> = getNotebookViewerThresholds,
): Promise<NotebookViewerThresholds> {
	if (_loaded) return Promise.resolve(_loaded);
	if (_inflight) return _inflight;
	const request = fetchFn()
		.then(parseThresholds)
		.then((thresholds) => {
			_loaded = thresholds;
			_thresholds.set(thresholds);
			return thresholds;
		})
		.finally(() => {
			if (_inflight === request) _inflight = null;
		});
	_inflight = request;
	return request;
}

/** Forget the loaded thresholds. For tests. */
export function reset(): void {
	_inflight = null;
	_loaded = null;
	_thresholds.set(null);
}

/** The interval a slot is judged against: its own if it reported one. */
export function slotInterval(
	slot: { reconcile_interval_s?: number | null },
	thresholds: NotebookViewerThresholds,
): number {
	const own = slot.reconcile_interval_s;
	return positive(own) ? own : thresholds.default_reconcile_interval_s;
}

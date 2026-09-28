import { describe, expect, it } from 'vitest';

import type { NotebookSyncSlot } from './api';
import { marimoVersionLabel, slotSyncState, syncBadge } from './notebookSync';
import { testThresholds } from './notebookThresholds.testing';

/**
 * The notebook header badge.
 *
 * A notebook that silently stopped updating renders identically to one that is
 * up to date — same charts, same numbers, no error anywhere. That is how a
 * notebook sat at 214 tokens while its net ran past 500 and nobody noticed.
 *
 * So the badge must be derived from evidence (an age, an error) on every read,
 * and must never latch. The nets page has the counterexample: its "Connected"
 * indicator is set on the first event received and has no path back, so it
 * keeps claiming a live connection over a frozen graph.
 */

const slot = (over: Partial<NotebookSyncSlot> = {}): NotebookSyncSlot => ({
	slot_name: 'tw',
	net_id: 'n-1',
	synced: true,
	step_count: 10,
	running: true,
	last_error: null,
	last_sync_age_s: 1,
	report_age_s: 1,
	marking_version: 3,
	reconcile_interval_s: null,
	last_push_age_s: 0.5,
	...over,
});

const T = testThresholds();
/** Ages that mean stale and silent for a slot reporting no interval of its own. */
const STALE_AFTER_S = T.stale_intervals * T.default_reconcile_interval_s;
const SILENT_AFTER_S = T.silent_intervals * T.default_reconcile_interval_s;

describe('slotSyncState', () => {
	it('is live when a recent sync succeeded', () => {
		expect(slotSyncState(slot(), T)).toBe('live');
	});

	it('is syncing before the first successful sync', () => {
		// Null age is "no data at all", which must not read the same as an age
		// of zero — one is a notebook still starting up, the other is a
		// notebook that is bang up to date.
		expect(slotSyncState(slot({ last_sync_age_s: null, synced: false }), T)).toBe('syncing');
	});

	it('is stale once the last sync is older than the threshold', () => {
		expect(slotSyncState(slot({ last_sync_age_s: STALE_AFTER_S + 1 }), T)).toBe('stale');
	});

	it('is stale while an error is being reported, however recent', () => {
		// The subprocess is alive and talking; it just cannot reach the net. So
		// whatever is on screen is frozen at the last good read.
		expect(
			slotSyncState(slot({ last_sync_age_s: 0.2, last_error: 'net not loaded' }), T),
		).toBe('stale');
	});

	it('is disconnected when the subprocess itself has gone quiet', () => {
		// Outranks everything else: a healthy-looking report is only getting
		// older once nothing is arriving to renew it.
		expect(
			slotSyncState(slot({ report_age_s: SILENT_AFTER_S + 1, last_sync_age_s: 0.1 }), T),
		).toBe('disconnected');
	});

	it('does not go stale for ordinary reporting jitter', () => {
		expect(slotSyncState(slot({ last_sync_age_s: STALE_AFTER_S - 1 }), T)).toBe('live');
	});
});

describe('slotSyncState against the slot\'s own cadence', () => {
	// The bridge widens its interval up to a minute when fetches are slow. A
	// fixed fifteen-second threshold called that deliberate back-off stale,
	// and past thirty seconds disconnected.
	const backedOff = (over: Partial<NotebookSyncSlot> = {}) =>
		slot({ reconcile_interval_s: 60, ...over });

	it('is live at an age that would be stale on the default cadence', () => {
		expect(slotSyncState(backedOff({ last_sync_age_s: 50, report_age_s: 50 }), T)).toBe('live');
	});

	it('is stale past stale_intervals of the reported interval', () => {
		expect(slotSyncState(backedOff({ last_sync_age_s: 3 * 60 - 1 }), T)).toBe('live');
		expect(slotSyncState(backedOff({ last_sync_age_s: 3 * 60 + 1 }), T)).toBe('stale');
	});

	it('is disconnected past silent_intervals of the reported interval', () => {
		expect(slotSyncState(backedOff({ report_age_s: 6 * 60 - 1 }), T)).toBe('live');
		expect(slotSyncState(backedOff({ report_age_s: 6 * 60 + 1 }), T)).toBe('disconnected');
	});

	it('uses the default interval when the slot reports none', () => {
		const slow = testThresholds({ default_reconcile_interval_s: 10 });
		expect(slotSyncState(slot({ last_sync_age_s: 25 }), slow)).toBe('live');
		expect(slotSyncState(slot({ last_sync_age_s: 31 }), slow)).toBe('stale');
	});

	it('reads the multipliers from the thresholds, not from a copy', () => {
		const strict = testThresholds({ stale_intervals: 1, silent_intervals: 2 });
		expect(slotSyncState(slot({ last_sync_age_s: 6 }), strict)).toBe('stale');
		expect(slotSyncState(slot({ report_age_s: 11 }), strict)).toBe('disconnected');
	});
});

describe('syncBadge', () => {
	it('says nothing when there are no bound slots', () => {
		// A notebook with no bindings has no freshness to report. A reassuring
		// badge would be an invention.
		expect(syncBadge([], T)).toBeNull();
		expect(syncBadge(null, T)).toBeNull();
	});

	it('reports the worst slot, not the average', () => {
		const badge = syncBadge([
			slot({ slot_name: 'good' }),
			slot({ slot_name: 'bad', last_sync_age_s: 120 }),
		], T);

		expect(badge?.state).toBe('stale');
	});

	it('never claims live while any slot is disconnected', () => {
		const badge = syncBadge([
			slot({ slot_name: 'good' }),
			slot({ slot_name: 'gone', report_age_s: 300 }),
		], T);

		expect(badge?.state).toBe('disconnected');
	});

	it('puts the age in the label so staleness is quantified', () => {
		const badge = syncBadge([slot({ last_sync_age_s: 42.4 })], T);

		expect(badge?.label).toBe('stale 42s');
	});

	it('recovers to live once syncing resumes', () => {
		// The property the nets page badge lacks: derived on every read, so
		// there is always a path back.
		const stale = syncBadge([slot({ last_sync_age_s: 99 })], T);
		const recovered = syncBadge([slot({ last_sync_age_s: 1 })], T);

		expect(stale?.state).toBe('stale');
		expect(recovered?.state).toBe('live');
	});

	it('explains every slot in the tooltip, including the healthy ones', () => {
		const badge = syncBadge([
			slot({ slot_name: 'tw', last_sync_age_s: 2 }),
			slot({ slot_name: 'other', last_error: 'net not loaded', last_sync_age_s: null }),
		], T);

		expect(badge?.title).toContain('tw');
		expect(badge?.title).toContain('other');
		expect(badge?.title).toContain('net not loaded');
		expect(badge?.title).toContain('never synced');
	});

	it('gives each state a distinct colour', () => {
		const colours = [
			syncBadge([slot()], T)?.colour,
			syncBadge([slot({ last_sync_age_s: null, synced: false })], T)?.colour,
			syncBadge([slot({ last_sync_age_s: 99 })], T)?.colour,
			syncBadge([slot({ report_age_s: 99 })], T)?.colour,
		];

		expect(new Set(colours).size).toBe(4);
	});
});

describe('marimoVersionLabel', () => {
	it('names the version when the worker reports one', () => {
		expect(marimoVersionLabel({ marimo_version: '0.16.5' })).toBe('Marimo 0.16.5');
	});

	it('is null when the version is null, absent, or there is no sync record', () => {
		expect(marimoVersionLabel({ marimo_version: null })).toBeNull();
		expect(marimoVersionLabel({})).toBeNull();
		expect(marimoVersionLabel(null)).toBeNull();
	});
});

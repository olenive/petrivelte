import { describe, expect, it } from 'vitest';

import type { NotebookSyncSlot } from './api';
import { SILENT_AFTER_S, STALE_AFTER_S, slotSyncState, syncBadge } from './notebookSync';

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
	...over,
});

describe('slotSyncState', () => {
	it('is live when a recent sync succeeded', () => {
		expect(slotSyncState(slot())).toBe('live');
	});

	it('is syncing before the first successful sync', () => {
		// Null age is "no data at all", which must not read the same as an age
		// of zero — one is a notebook still starting up, the other is a
		// notebook that is bang up to date.
		expect(slotSyncState(slot({ last_sync_age_s: null, synced: false }))).toBe('syncing');
	});

	it('is stale once the last sync is older than the threshold', () => {
		expect(slotSyncState(slot({ last_sync_age_s: STALE_AFTER_S + 1 }))).toBe('stale');
	});

	it('is stale while an error is being reported, however recent', () => {
		// The subprocess is alive and talking; it just cannot reach the net. So
		// whatever is on screen is frozen at the last good read.
		expect(
			slotSyncState(slot({ last_sync_age_s: 0.2, last_error: 'net not loaded' })),
		).toBe('stale');
	});

	it('is disconnected when the subprocess itself has gone quiet', () => {
		// Outranks everything else: a healthy-looking report is only getting
		// older once nothing is arriving to renew it.
		expect(
			slotSyncState(slot({ report_age_s: SILENT_AFTER_S + 1, last_sync_age_s: 0.1 })),
		).toBe('disconnected');
	});

	it('does not go stale for ordinary reporting jitter', () => {
		expect(slotSyncState(slot({ last_sync_age_s: STALE_AFTER_S - 1 }))).toBe('live');
	});
});

describe('syncBadge', () => {
	it('says nothing when there are no bound slots', () => {
		// A notebook with no bindings has no freshness to report. A reassuring
		// badge would be an invention.
		expect(syncBadge([])).toBeNull();
		expect(syncBadge(null)).toBeNull();
	});

	it('reports the worst slot, not the average', () => {
		const badge = syncBadge([
			slot({ slot_name: 'good' }),
			slot({ slot_name: 'bad', last_sync_age_s: 120 }),
		]);

		expect(badge?.state).toBe('stale');
	});

	it('never claims live while any slot is disconnected', () => {
		const badge = syncBadge([
			slot({ slot_name: 'good' }),
			slot({ slot_name: 'gone', report_age_s: 300 }),
		]);

		expect(badge?.state).toBe('disconnected');
	});

	it('puts the age in the label so staleness is quantified', () => {
		const badge = syncBadge([slot({ last_sync_age_s: 42.4 })]);

		expect(badge?.label).toBe('stale 42s');
	});

	it('recovers to live once syncing resumes', () => {
		// The property the nets page badge lacks: derived on every read, so
		// there is always a path back.
		const stale = syncBadge([slot({ last_sync_age_s: 99 })]);
		const recovered = syncBadge([slot({ last_sync_age_s: 1 })]);

		expect(stale?.state).toBe('stale');
		expect(recovered?.state).toBe('live');
	});

	it('explains every slot in the tooltip, including the healthy ones', () => {
		const badge = syncBadge([
			slot({ slot_name: 'tw', last_sync_age_s: 2 }),
			slot({ slot_name: 'other', last_error: 'net not loaded', last_sync_age_s: null }),
		]);

		expect(badge?.title).toContain('tw');
		expect(badge?.title).toContain('other');
		expect(badge?.title).toContain('net not loaded');
		expect(badge?.title).toContain('never synced');
	});

	it('gives each state a distinct colour', () => {
		const colours = [
			syncBadge([slot()])?.colour,
			syncBadge([slot({ last_sync_age_s: null, synced: false })])?.colour,
			syncBadge([slot({ last_sync_age_s: 99 })])?.colour,
			syncBadge([slot({ report_age_s: 99 })])?.colour,
		];

		expect(new Set(colours).size).toBe(4);
	});
});

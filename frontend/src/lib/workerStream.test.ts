import { describe, expect, it } from 'vitest';

import {
	advanceCursor,
	SKIP_REPLAY_AFTER,
	capHead,
	capTail,
	liveAction,
	openCursor,
	lastLogSeq,
	mergeLogEntries,
	statusLabel,
	initialStreamStatus,
} from './workerStream';
import type { ServerEvent } from './stores/serverEvents';

describe('advanceCursor', () => {
	it('moves forward on the ordinary path and reports no gap', () => {
		expect(advanceCursor(10, { seq: 11, kind: 'distributed' }, false)).toEqual({ lastSeq: 11, gap: null });
	});

	it('treats a sequence that started over as a worker restart', () => {
		expect(advanceCursor(4000, { seq: 3, kind: 'memory_stats' }, false)).toEqual({ lastSeq: 3, gap: 'restarted' });
	});

	it('honours a stream_gap marker and rewinds the cursor after a restart', () => {
		expect(advanceCursor(4000, { seq: 0, kind: 'stream_gap', data: { reason: 'restarted' } }, false))
			.toEqual({ lastSeq: 0, gap: 'restarted' });
		expect(advanceCursor(120, { seq: 120, kind: 'stream_gap', data: { reason: 'evicted' } }, false))
			.toEqual({ lastSeq: 120, gap: 'evicted' });
	});

	it('does not mistake a marker with no reason for the ordinary path', () => {
		expect(advanceCursor(5, { seq: 5, kind: 'stream_gap' }, false).gap).toBe('unknown');
	});

	it('seeds the cursor where the worker says its sequence is now', () => {
		// A restarted worker: the cursor moves to the new incarnation's sequence.
		expect(advanceCursor(4000, {
			seq: 0, kind: 'stream_gap', data: { reason: 'restarted', after: 4000, current_seq: 37 },
		}, false)).toEqual({ lastSeq: 37, gap: 'restarted' });
		// An evicted cursor: nothing is replayed behind the marker, so the
		// cursor jumps to the worker's sequence rather than staying behind.
		expect(advanceCursor(120, {
			seq: 120, kind: 'stream_gap', data: { reason: 'evicted', after: 120, current_seq: 9000 },
		}, false)).toEqual({ lastSeq: 9000, gap: 'evicted' });
	});

	it('takes the marker that answers a skipped replay as a seed, not a gap', () => {
		const answer = {
			seq: 0, kind: 'stream_gap',
			data: { reason: 'restarted', after: SKIP_REPLAY_AFTER, current_seq: 2500 },
		};
		// The first open: nothing heard yet.
		expect(advanceCursor(0, answer, true)).toEqual({ lastSeq: 2500, gap: null });
		// The browser reopening the same skip connection after hearing live
		// events: the cursor follows the worker and is never rewound to 0.
		expect(advanceCursor(2400, answer, true)).toEqual({ lastSeq: 2500, gap: null });
		expect(advanceCursor(2400, { seq: 0, kind: 'stream_gap', data: { reason: 'restarted' } }, true))
			.toEqual({ lastSeq: 2400, gap: null });
	});

	it('treats live events on a skip connection like any other', () => {
		expect(advanceCursor(2500, { seq: 2501, kind: 'distributed' }, true)).toEqual({ lastSeq: 2501, gap: null });
		expect(advanceCursor(2500, { seq: 4, kind: 'memory_stats' }, true)).toEqual({ lastSeq: 4, gap: 'restarted' });
	});
});

describe('openCursor', () => {
	const cases: Array<[string, boolean, number | null, { after: number; skippedReplay: boolean }]> = [
		['a live tail with no cursor asks to skip', false, null, { after: SKIP_REPLAY_AFTER, skippedReplay: true }],
		['a replaying viewer with no cursor asks for the whole buffer', true, null, { after: 0, skippedReplay: false }],
		['a live tail resumes from its cursor', false, 4200, { after: 4200, skippedReplay: false }],
		['a replaying viewer resumes from its cursor', true, 4200, { after: 4200, skippedReplay: false }],
		['a cursor of 0 heard from a fresh worker is still a cursor', false, 0, { after: 0, skippedReplay: false }],
	];
	for (const [name, replay, cursor, want] of cases) {
		it(name, () => {
			expect(openCursor(replay, cursor)).toEqual(want);
		});
	}
});

describe('statusLabel', () => {
	it('gives Connected only to an open stream', () => {
		expect(statusLabel({ ...initialStreamStatus, state: 'open' })).toBe('Connected');
		expect(statusLabel({ ...initialStreamStatus, state: 'reconnecting' })).toBe('Reconnecting...');
		expect(statusLabel({ ...initialStreamStatus, state: 'unavailable' })).toBe('Worker unreachable');
		expect(statusLabel(initialStreamStatus)).toBe('No live stream');
	});
});

describe('caps', () => {
	it('keep the newest entries whichever way the list is ordered', () => {
		expect(capHead([5, 4, 3, 2, 1], 3)).toEqual([5, 4, 3]);
		expect(capTail([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
	});

	it('return the same array when nothing has to go', () => {
		const list = [1, 2];
		expect(capHead(list, 2)).toBe(list);
		expect(capTail(list, 5)).toBe(list);
	});
});

describe('mergeLogEntries', () => {
	const entry = (seq: number) => ({
		seq,
		transition: 'score',
		started_at: '2026-10-04T10:00:00Z',
		duration_ms: 3,
		outcome: 'fired' as const,
		consumed: [['Window', String(seq)]] as [string, string][],
		produced: [['Scores', String(seq + 100)]] as [string, string][],
	});

	it('puts newer entries at the head, newest first, and keeps to the cap', () => {
		expect(mergeLogEntries([entry(2), entry(1)], [entry(3), entry(4)], 3)).toEqual([
			entry(4),
			entry(3),
			entry(2),
		]);
	});

	it('leaves the log alone for entries it already lists', () => {
		// A resync's whole read and an incremental read can both answer them.
		const log = [entry(3), entry(2), entry(1)];
		expect(mergeLogEntries(log, [entry(2), entry(3)], 500)).toBe(log);
	});

	it('adds a repeated seq once', () => {
		expect(mergeLogEntries([], [entry(1), entry(1)], 500)).toEqual([entry(1)]);
	});

	it('leaves the log alone for entries without a seq', () => {
		const log = [entry(1)];
		expect(mergeLogEntries(log, [{}, undefined, null], 500)).toBe(log);
	});

	it('reads the cursor of the next incremental read', () => {
		expect(lastLogSeq([])).toBe(0);
		expect(lastLogSeq([entry(7), entry(5)])).toBe(7);
	});
});

describe('liveAction', () => {
	const net = { id: 'net-1', worker_id: 'w-1' };

	it('reconnects when the selected net’s worker comes back, and only then', () => {
		const ready: ServerEvent = { type: 'worker_state_changed', worker_id: 'w-1', status: 'ready' };
		expect(liveAction(ready, net)).toBe('reconnect');
		expect(liveAction({ ...ready, status: 'stopped' }, net)).toBeNull();
		expect(liveAction({ ...ready, worker_id: 'w-2' }, net)).toBeNull();
	});

	it('resyncs a reload, clears an unload, ignores a load in flight', () => {
		const changed = (load_state: string): ServerEvent => ({ type: 'net_state_changed', net_id: 'net-1', load_state });
		expect(liveAction(changed('loaded'), net)).toBe('resync');
		expect(liveAction(changed('unloaded'), net)).toBe('clear');
		expect(liveAction(changed('error'), net)).toBe('clear');
		expect(liveAction(changed('loading'), net)).toBeNull();
		expect(liveAction({ type: 'net_state_changed', net_id: 'net-2', load_state: 'loaded' }, net)).toBeNull();
	});

	it('hears a run opening for the selected net', () => {
		const started: ServerEvent = {
			type: 'net_run_started', run_id: 'r', net_id: 'net-1', trigger: 'schedule', state: 'running',
			reason: null, started_at: null, ended_at: null, scheduled_for: null,
		};
		expect(liveAction(started, net)).toBe('running');
		expect(liveAction({ ...started, type: 'net_run_finished' }, net)).toBeNull();
	});

	it('does nothing without a selected net', () => {
		expect(liveAction({ type: 'worker_state_changed', worker_id: 'w-1', status: 'ready' }, undefined)).toBeNull();
	});
});

import { describe, expect, it } from 'vitest';

import {
	advanceCursor,
	capHead,
	capTail,
	liveAction,
	statusLabel,
	initialStreamStatus,
} from './workerStream';
import type { ServerEvent } from './stores/serverEvents';

describe('advanceCursor', () => {
	it('moves forward on the ordinary path and reports no gap', () => {
		expect(advanceCursor(10, { seq: 11, kind: 'transition_fired' })).toEqual({ lastSeq: 11, gap: null });
	});

	it('treats a sequence that started over as a worker restart', () => {
		expect(advanceCursor(4000, { seq: 3, kind: 'memory_stats' })).toEqual({ lastSeq: 3, gap: 'restarted' });
	});

	it('honours a stream_gap marker and rewinds the cursor after a restart', () => {
		expect(advanceCursor(4000, { seq: 0, kind: 'stream_gap', data: { reason: 'restarted' } }))
			.toEqual({ lastSeq: 0, gap: 'restarted' });
		expect(advanceCursor(120, { seq: 120, kind: 'stream_gap', data: { reason: 'evicted' } }))
			.toEqual({ lastSeq: 120, gap: 'evicted' });
	});

	it('does not mistake a marker with no reason for the ordinary path', () => {
		expect(advanceCursor(5, { seq: 5, kind: 'stream_gap' }).gap).toBe('unknown');
	});
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

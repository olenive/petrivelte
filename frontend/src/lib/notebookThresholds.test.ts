import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import {
	loadNotebookThresholds,
	notebookThresholdsStore,
	parseThresholds,
	reset,
	slotInterval,
} from './notebookThresholds';
import { testThresholds } from './notebookThresholds.testing';

/**
 * The viewer's thresholds come from the control plane and nowhere else. These
 * tests pin that a partial payload is refused rather than patched with
 * defaults, and that the store stays empty (so pages read "checking") until a
 * load succeeds.
 */

const SERVED = {
	stale_intervals: 3,
	silent_intervals: 6,
	default_reconcile_interval_s: 5,
	ws_open_deadline_s: 45,
	frame_stall_s: 30,
	bridge_start_deadline_s: 30,
	remount_budget: 3,
	remount_window_s: 900,
	remount_backoff_s: [5, 20],
	sync_poll_s: 5,
};

afterEach(() => {
	reset();
	vi.unstubAllGlobals();
});

describe('parseThresholds', () => {
	it('accepts the served payload', () => {
		expect(parseThresholds(SERVED)).toEqual(testThresholds());
	});

	it('ignores fields it does not know', () => {
		expect(parseThresholds({ ...SERVED, something_new: 1 })).toEqual(testThresholds());
	});

	it('refuses a payload missing a threshold rather than defaulting it', () => {
		const { frame_stall_s: _, ...partial } = SERVED;
		expect(() => parseThresholds(partial)).toThrow(/frame_stall_s/);
	});

	it('refuses zero, negative and non-numeric values', () => {
		expect(() => parseThresholds({ ...SERVED, stale_intervals: 0 })).toThrow(/stale_intervals/);
		expect(() => parseThresholds({ ...SERVED, sync_poll_s: -1 })).toThrow(/sync_poll_s/);
		expect(() => parseThresholds({ ...SERVED, remount_budget: '3' })).toThrow(/remount_budget/);
	});

	it('refuses an empty or malformed backoff list', () => {
		expect(() => parseThresholds({ ...SERVED, remount_backoff_s: [] })).toThrow(/backoff/);
		expect(() => parseThresholds({ ...SERVED, remount_backoff_s: [5, 'x'] })).toThrow(/backoff/);
	});

	it('refuses something that is not an object', () => {
		expect(() => parseThresholds(null)).toThrow();
		expect(() => parseThresholds('3')).toThrow();
	});
});

describe('loadNotebookThresholds', () => {
	it('leaves the store empty until a load succeeds', async () => {
		expect(get(notebookThresholdsStore)).toBeNull();
		await expect(loadNotebookThresholds(async () => ({ stale_intervals: 3 }))).rejects.toThrow();
		expect(get(notebookThresholdsStore)).toBeNull();

		await loadNotebookThresholds(async () => SERVED);
		expect(get(notebookThresholdsStore)).toEqual(testThresholds());
	});

	it('fetches once and shares the answer', async () => {
		const fetchFn = vi.fn(async () => SERVED);
		const [a, b] = await Promise.all([
			loadNotebookThresholds(fetchFn),
			loadNotebookThresholds(fetchFn),
		]);
		await loadNotebookThresholds(fetchFn);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(a).toEqual(b);
	});

	it('tries again after a failure', async () => {
		const fetchFn = vi
			.fn<() => Promise<unknown>>()
			.mockRejectedValueOnce(new Error('control plane down'))
			.mockResolvedValueOnce(SERVED);

		await expect(loadNotebookThresholds(fetchFn)).rejects.toThrow('control plane down');
		await expect(loadNotebookThresholds(fetchFn)).resolves.toEqual(testThresholds());
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('reads the control plane endpoint by default', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(SERVED), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(loadNotebookThresholds()).resolves.toEqual(testThresholds());
		expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
			'http://cp.test/api/config/notebook-viewer',
		);
	});
});

describe('slotInterval', () => {
	it('uses the slot\'s own interval when it reports one', () => {
		expect(slotInterval({ reconcile_interval_s: 40 }, testThresholds())).toBe(40);
	});

	it('falls back to the default when the slot reports none', () => {
		expect(slotInterval({ reconcile_interval_s: null }, testThresholds())).toBe(5);
		expect(slotInterval({}, testThresholds({ default_reconcile_interval_s: 8 }))).toBe(8);
	});
});

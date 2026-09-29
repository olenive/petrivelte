/**
 * Collects items and hands them to a flush function in batches, at most once
 * per interval.
 *
 * A worker's event stream replays its whole buffer when a log viewer opens,
 * up to two thousand events arriving back to back. Writing each one to a
 * Svelte store makes every subscriber re-render its full line list and
 * scroll, two thousand times over. Batching turns that into one store update
 * per interval for as long as the replay lasts.
 *
 * The first item after a flush starts the timer; items that arrive before it
 * fires join the same batch. ``flushNow`` empties the batch at once, for the
 * moments a caller cannot wait: a disconnect, or a clear that must not be
 * followed by lines from before it.
 */

export interface BatchTimer {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export const browserTimer: BatchTimer = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface BatchScheduler<T> {
	push(item: T): void;
	flushNow(): void;
	pending(): number;
}

export const LOG_FLUSH_INTERVAL_MS = 100;

export function createBatchScheduler<T>(
	flush: (items: T[]) => void,
	intervalMs: number = LOG_FLUSH_INTERVAL_MS,
	timer: BatchTimer = browserTimer,
): BatchScheduler<T> {
	let batch: T[] = [];
	let handle: unknown = null;

	const flushNow = () => {
		if (handle !== null) {
			timer.clear(handle);
			handle = null;
		}
		if (batch.length === 0) return;
		const items = batch;
		batch = [];
		flush(items);
	};

	return {
		push(item: T) {
			batch.push(item);
			if (handle === null) {
				handle = timer.set(() => {
					handle = null;
					flushNow();
				}, intervalMs);
			}
		},
		flushNow,
		pending: () => batch.length,
	};
}

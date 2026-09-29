import { describe, expect, it } from 'vitest';

import { createBatchScheduler, type BatchTimer } from './batchScheduler';

/** A clock the test moves by hand: timers fire only when ``advance`` passes
 *  their due time, in due-time order. */
function fakeClock() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { due: number; fn: () => void }>();
	const timer: BatchTimer = {
		set: (fn, ms) => {
			const id = nextId++;
			timers.set(id, { due: now + ms, fn });
			return id;
		},
		clear: (handle) => {
			timers.delete(handle as number);
		},
	};
	const advance = (ms: number) => {
		const until = now + ms;
		for (;;) {
			const due = [...timers.entries()]
				.filter(([, t]) => t.due <= until)
				.sort((a, b) => a[1].due - b[1].due)[0];
			if (!due) break;
			timers.delete(due[0]);
			now = due[1].due;
			due[1].fn();
		}
		now = until;
	};
	return { timer, advance, active: () => timers.size };
}

function setup(intervalMs = 100) {
	const clock = fakeClock();
	const flushes: number[][] = [];
	const scheduler = createBatchScheduler<number>((items) => flushes.push(items), intervalMs, clock.timer);
	return { clock, flushes, scheduler };
}

describe('createBatchScheduler', () => {
	it.each([
		{ name: 'nothing pushed, nothing flushed', pushes: [] as number[], advanceMs: 500, expected: [] as number[][] },
		{ name: 'one item waits for the interval', pushes: [1], advanceMs: 99, expected: [] },
		{ name: 'one item flushes when the interval passes', pushes: [1], advanceMs: 100, expected: [[1]] },
		{ name: 'items pushed together flush together, in order', pushes: [1, 2, 3], advanceMs: 100, expected: [[1, 2, 3]] },
	])('$name', ({ pushes, advanceMs, expected }) => {
		const { clock, flushes, scheduler } = setup();
		for (const p of pushes) scheduler.push(p);
		clock.advance(advanceMs);
		expect(flushes).toEqual(expected);
	});

	it('starts a fresh interval for items that arrive after a flush', () => {
		const { clock, flushes, scheduler } = setup();
		scheduler.push(1);
		clock.advance(100);
		scheduler.push(2);
		clock.advance(50);
		expect(flushes).toEqual([[1]]);
		clock.advance(50);
		expect(flushes).toEqual([[1], [2]]);
	});

	it('flushNow empties the batch at once and cancels the pending timer', () => {
		const { clock, flushes, scheduler } = setup();
		scheduler.push(1);
		scheduler.push(2);
		scheduler.flushNow();
		expect(flushes).toEqual([[1, 2]]);
		expect(scheduler.pending()).toBe(0);
		expect(clock.active()).toBe(0);
		clock.advance(1000);
		expect(flushes).toEqual([[1, 2]]);
	});

	it('flushNow with nothing pending does not call flush', () => {
		const { flushes, scheduler } = setup();
		scheduler.flushNow();
		expect(flushes).toEqual([]);
	});

	it.each([
		// A replay arriving as fast as the stream can deliver it: all 2000
		// events inside one interval.
		{ spacingMs: 0, expectedFlushes: 1 },
		// One event every half millisecond: the replay takes a second.
		{ spacingMs: 0.5, expectedFlushes: 10 },
		// One event every two milliseconds: the replay takes four seconds.
		{ spacingMs: 2, expectedFlushes: 40 },
	])('a 2000-event replay spaced $spacingMs ms apart costs $expectedFlushes store updates', ({ spacingMs, expectedFlushes }) => {
		const { clock, flushes, scheduler } = setup();
		for (let i = 0; i < 2000; i++) {
			scheduler.push(i);
			clock.advance(spacingMs);
		}
		clock.advance(100);
		expect(flushes.length).toBe(expectedFlushes);
		expect(flushes.flat()).toEqual(Array.from({ length: 2000 }, (_, i) => i));
	});
});

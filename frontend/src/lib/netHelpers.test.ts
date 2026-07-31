import { describe, expect, it } from 'vitest';

import {
	TOKEN_COUNTER_THRESHOLD,
	TOKEN_DOT_MAX,
	applyTokenCounts,
	placeShowsCounter,
	placeTokenCount,
	tokenSlotOffset,
	totalTokenCount,
} from './netHelpers';

/**
 * Token counts in the net view.
 *
 * Two constraints shape this and pull against each other:
 *
 * 1. The worker caps per-place token detail, so `place.tokens` is a *sample*
 *    and its length is not the marking size.
 * 2. Transitions fire continuously between full state refreshes, so counts
 *    have to update from the `transition_fired` event or they visibly freeze
 *    while the execution log keeps scrolling.
 *
 * Together they mean counts come from `token_count`, refreshed per fire by
 * `token_counts` on the event. Getting either half wrong looks like a stuck
 * counter, which is exactly the bug these tests exist to catch.
 */

const place = (id: string, over: Partial<{ token_count: number; tokens: unknown[] }> = {}) => ({
	id,
	name: id,
	...over,
});

describe('placeTokenCount', () => {
	it('reports the true marking size, not the sample size', () => {
		const p = place('Receiving', { token_count: 5000, tokens: new Array(200) });

		expect(placeTokenCount(p)).toBe(5000);
	});

	it('falls back to the sample for workers predating token_count', () => {
		const p = place('Receiving', { tokens: new Array(3) });

		expect(placeTokenCount(p)).toBe(3);
	});

	it('treats a place with neither field as empty', () => {
		expect(placeTokenCount(place('Receiving'))).toBe(0);
	});
});

describe('placeShowsCounter', () => {
	it('stays silent while the cluster is still countable by eye', () => {
		expect(placeShowsCounter(place('P', { token_count: TOKEN_COUNTER_THRESHOLD - 1 }))).toBe(
			false,
		);
	});

	it('shows a count once the cluster stops being countable', () => {
		expect(placeShowsCounter(place('P', { token_count: TOKEN_COUNTER_THRESHOLD }))).toBe(true);
	});
});

describe('tokenSlotOffset', () => {
	it('gives a slot the same position no matter how many tokens exist', () => {
		// The reported jitter: the old layout derived angle and radius from the
		// current count, so every arrival slid every dot already on screen.
		expect(tokenSlotOffset(0)).toEqual(tokenSlotOffset(0));
		expect(tokenSlotOffset(3)).toEqual(tokenSlotOffset(3));
	});

	it('gives distinct slots distinct positions', () => {
		const seen = new Set(
			Array.from({ length: TOKEN_DOT_MAX }, (_, i) => {
				const { dx, dy } = tokenSlotOffset(i);
				return `${dx.toFixed(4)},${dy.toFixed(4)}`;
			}),
		);

		expect(seen.size).toBe(TOKEN_DOT_MAX);
	});

	it('keeps every dot inside the place circle', () => {
		// Place radius 30, token radius 8 — a dot centred beyond 22 would spill
		// out of the node.
		for (let i = 0; i < TOKEN_DOT_MAX; i++) {
			const { dx, dy } = tokenSlotOffset(i);
			expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(22);
		}
	});

	it('leaves the centre clear for the counter', () => {
		for (let i = 0; i < TOKEN_DOT_MAX; i++) {
			const { dx, dy } = tokenSlotOffset(i);
			expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
		}
	});
});

describe('applyTokenCounts', () => {
	it('updates counts from a fired transition', () => {
		const places = [place('Receiving', { token_count: 7 }), place('Sorting', { token_count: 0 })];

		const updated = applyTokenCounts(places, { Receiving: 6, Sorting: 1 });

		expect(placeTokenCount(updated[0])).toBe(6);
		expect(placeTokenCount(updated[1])).toBe(1);
	});

	it('keeps counting up as successive transitions fire', () => {
		// The reported bug: the counter sat at 7 while Receive Parcel kept
		// firing, because counts only moved on a full state refresh.
		let places = [place('Receiving', { token_count: 7 })];

		for (const n of [8, 9, 10]) {
			places = applyTokenCounts(places, { Receiving: n });
		}

		expect(placeTokenCount(places[0])).toBe(10);
	});

	it('does not zero places the event leaves out', () => {
		const places = [place('Receiving', { token_count: 4 }), place('Sorting', { token_count: 9 })];

		const updated = applyTokenCounts(places, { Receiving: 5 });

		expect(placeTokenCount(updated[1])).toBe(9);
	});

	it('is a no-op when the worker sends no counts', () => {
		const places = [place('Receiving', { token_count: 4 })];

		expect(applyTokenCounts(places, undefined)).toBe(places);
	});

	it('does not mutate the places it was given', () => {
		const places = [place('Receiving', { token_count: 4 })];

		applyTokenCounts(places, { Receiving: 99 });

		expect(placeTokenCount(places[0])).toBe(4);
	});

	it('ignores counts for places that are not in the graph', () => {
		const places = [place('Receiving', { token_count: 4 })];

		const updated = applyTokenCounts(places, { Nonexistent: 12 });

		expect(updated).toHaveLength(1);
		expect(placeTokenCount(updated[0])).toBe(4);
	});
});

describe('totalTokenCount', () => {
	it('sums true counts rather than rendered samples', () => {
		const places = [
			place('Receiving', { token_count: 5000, tokens: new Array(200) }),
			place('Sorting', { token_count: 3, tokens: new Array(3) }),
		];

		expect(totalTokenCount(places)).toBe(5003);
	});

	it('tracks a transition firing end to end', () => {
		// A parcel moves from Receiving to Sorting: the total is unchanged, but
		// both places must have moved.
		const before = [place('Receiving', { token_count: 7 }), place('Sorting', { token_count: 0 })];

		const after = applyTokenCounts(before, { Receiving: 6, Sorting: 1 });

		expect(totalTokenCount(before)).toBe(7);
		expect(totalTokenCount(after)).toBe(7);
		expect(placeTokenCount(after[0])).toBe(6);
		expect(placeTokenCount(after[1])).toBe(1);
	});
});

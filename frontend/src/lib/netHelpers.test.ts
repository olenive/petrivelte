import { describe, expect, it } from 'vitest';

import {
	TOKEN_DOT_LIMIT,
	applyTokenCounts,
	placeShowsCount,
	placeTokenCount,
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

describe('placeShowsCount', () => {
	it('draws dots below the limit', () => {
		expect(placeShowsCount(place('P', { token_count: TOKEN_DOT_LIMIT - 1 }))).toBe(false);
	});

	it('switches to a count at the limit, where the dot ring stops growing', () => {
		expect(placeShowsCount(place('P', { token_count: TOKEN_DOT_LIMIT }))).toBe(true);
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

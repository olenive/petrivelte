import { describe, expect, it } from 'vitest';

import {
	TOKEN_COUNTER_THRESHOLD,
	TOKEN_DOT_MAX,
	coerceParamValue,
	parseOptionalSeconds,
	placeShowsCounter,
	tokenSlotOffset,
} from './netHelpers';

describe('placeShowsCounter', () => {
	it('stays silent while the cluster is still countable by eye', () => {
		expect(placeShowsCounter(TOKEN_COUNTER_THRESHOLD - 1)).toBe(
			false,
		);
	});

	it('shows a count once the cluster stops being countable', () => {
		expect(placeShowsCounter(TOKEN_COUNTER_THRESHOLD)).toBe(true);
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

describe('coerceParamValue', () => {
	describe('with the server-declared coerce', () => {
		it('parses int, float and bool', () => {
			expect(coerceParamValue('42', { coerce: 'int', type: 'int' })).toBe(42);
			expect(coerceParamValue('2.5', { coerce: 'float', type: 'float' })).toBe(2.5);
			expect(coerceParamValue('True', { coerce: 'bool', type: 'bool' })).toBe(true);
			expect(coerceParamValue('no', { coerce: 'bool', type: 'bool' })).toBe(false);
		});

		it('keeps a string coerce as text', () => {
			expect(coerceParamValue('hello', { coerce: 'string', type: 'str' })).toBe('hello');
		});

		it('wins over type when the two disagree', () => {
			expect(coerceParamValue('7', { coerce: 'string', type: 'int' })).toBe('7');
			expect(coerceParamValue('7', { coerce: 'float', type: 'str' })).toBe(7);
		});

		it('leaves an optional annotation as a string', () => {
			expect(coerceParamValue('3', { coerce: 'string', type: 'int | None' })).toBe('3');
		});
	});

	describe('falling back on type when coerce is absent', () => {
		it('parses the bare int, float and bool annotations', () => {
			expect(coerceParamValue('42', { type: 'int' })).toBe(42);
			expect(coerceParamValue('2.5', { type: 'float', coerce: null })).toBe(2.5);
			expect(coerceParamValue('true', { type: 'bool' })).toBe(true);
			expect(coerceParamValue('1', { type: 'bool' })).toBe(false);
		});

		it('leaves an optional annotation as a string', () => {
			expect(coerceParamValue('3', { type: 'int | None' })).toBe('3');
		});

		it('leaves an unannotated parameter as a string', () => {
			expect(coerceParamValue('3', { type: null })).toBe('3');
			expect(coerceParamValue('3', {})).toBe('3');
		});
	});
});

describe('parseOptionalSeconds', () => {
	it('reads empty as null', () => {
		expect(parseOptionalSeconds('')).toEqual({ ok: true, value: null });
		expect(parseOptionalSeconds('  ')).toEqual({ ok: true, value: null });
		expect(parseOptionalSeconds(null)).toEqual({ ok: true, value: null });
		expect(parseOptionalSeconds(undefined)).toEqual({ ok: true, value: null });
	});

	it('reads a whole number of at least one, as text or number', () => {
		expect(parseOptionalSeconds('600')).toEqual({ ok: true, value: 600 });
		expect(parseOptionalSeconds(1)).toEqual({ ok: true, value: 1 });
	});

	it('refuses zero, negatives, fractions and words', () => {
		for (const bad of ['0', '-5', '1.5', 'ten', 0]) {
			expect(parseOptionalSeconds(bad)).toEqual({ ok: false });
		}
	});
});

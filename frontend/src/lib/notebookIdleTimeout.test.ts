import { describe, expect, it } from 'vitest';

import {
	IDLE_TIMEOUT_DEFAULT_VALUE,
	IDLE_TIMEOUT_PRESETS,
	formatIdleTimeout,
	idleTimeoutOptions,
	idleTimeoutValue,
	parseIdleTimeoutValue,
} from './notebookIdleTimeout';

/**
 * Two things are worth pinning here. The first is that `null` (use the worker
 * default) and `0` (never evict) stay distinguishable end to end — they are
 * both "no number the user picked", and a round trip that collapsed them would
 * turn "never evict this dashboard" into "evict it in 15 minutes". The second
 * is that the default entry's duration comes from the payload, so the day the
 * server's default changes the picker follows it without a frontend deploy.
 */
describe('formatIdleTimeout', () => {
	it('names whole hours and whole minutes in the unit they were chosen in', () => {
		expect(formatIdleTimeout(900)).toBe('15 min');
		expect(formatIdleTimeout(1800)).toBe('30 min');
		expect(formatIdleTimeout(3600)).toBe('1 h');
		expect(formatIdleTimeout(14400)).toBe('4 h');
		expect(formatIdleTimeout(86400)).toBe('24 h');
		expect(formatIdleTimeout(5400)).toBe('90 min');
	});

	it('falls back to seconds for a duration that is neither', () => {
		expect(formatIdleTimeout(90)).toBe('90 s');
		expect(formatIdleTimeout(61)).toBe('61 s');
	});

	it('reads the zero sentinel as never, and refuses to invent one', () => {
		expect(formatIdleTimeout(0)).toBe('never');
		expect(formatIdleTimeout(-5)).toBe('never');
		expect(formatIdleTimeout(Number.NaN)).toBe('never');
	});
});

describe('idleTimeoutValue / parseIdleTimeoutValue', () => {
	it('round-trips the default, never and a duration without confusing them', () => {
		for (const setting of [null, 0, 1800, 604800]) {
			expect(parseIdleTimeoutValue(idleTimeoutValue(setting))).toBe(setting);
		}
	});

	it('treats an absent setting as the default, like a null column', () => {
		expect(idleTimeoutValue(undefined)).toBe(IDLE_TIMEOUT_DEFAULT_VALUE);
	});

	it('resolves a value it cannot explain to the server default', () => {
		expect(parseIdleTimeoutValue('nonsense')).toBeNull();
	});
});

describe('idleTimeoutOptions', () => {
	it('labels the default entry from the effective value, never a constant', () => {
		expect(idleTimeoutOptions(null, 900)[0]).toEqual({
			value: 'default',
			label: 'Default (15 min)',
			seconds: null,
			selected: true,
		});
		expect(idleTimeoutOptions(null, 14400)[0].label).toBe('Default (4 h)');
	});

	it('says only Default when the payload carries no effective value', () => {
		// A control plane that predates the field: a stale "15 min" here would
		// be a claim this build cannot support.
		expect(idleTimeoutOptions(null, undefined)[0].label).toBe('Default');
	});

	it('offers the presets in ascending order with never last', () => {
		const options = idleTimeoutOptions(null, 900);
		expect(options.map((o) => o.seconds)).toEqual([null, ...IDLE_TIMEOUT_PRESETS, 0]);
		expect(options.map((o) => o.label)).toEqual([
			'Default (15 min)',
			'30 min',
			'1 h',
			'4 h',
			'12 h',
			'24 h',
			'Never',
		]);
	});

	it('marks exactly one entry selected, for each kind of setting', () => {
		for (const setting of [null, 0, 3600]) {
			const selected = idleTimeoutOptions(setting, 900).filter((o) => o.selected);
			expect(selected, String(setting)).toHaveLength(1);
			expect(selected[0].seconds, String(setting)).toBe(setting);
		}
	});

	it('keeps a stored value that is not a preset visible, in its own place', () => {
		const options = idleTimeoutOptions(90, 900);
		const custom = options.find((o) => o.seconds === 90);
		expect(custom).toEqual({ value: '90', label: 'custom (90 s)', seconds: 90, selected: true });
		// Spliced into the ascending run rather than parked at the end.
		expect(options.map((o) => o.seconds)).toEqual([null, 90, ...IDLE_TIMEOUT_PRESETS, 0]);
	});

	it('does not duplicate a preset the notebook happens to be set to', () => {
		const options = idleTimeoutOptions(3600, 900);
		expect(options.filter((o) => o.seconds === 3600)).toHaveLength(1);
		expect(options.find((o) => o.seconds === 3600)?.label).toBe('1 h');
	});
});

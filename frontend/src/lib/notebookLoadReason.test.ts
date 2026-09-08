import { describe, expect, it } from 'vitest';

import { describeLoadError } from './notebookLoadReason';

/**
 * The column under test is shared by expected unloads and real failures, and
 * the whole point of the helper is that a reader can tell them apart at a
 * glance. So the tests pin the heading and tone for each kind, not just the
 * label text.
 */
describe('describeLoadError', () => {
	it('shows an idle eviction as an expected reason, not an error', () => {
		const reason = describeLoadError('unloaded', 'idle_eviction');
		expect(reason).toEqual({
			heading: 'Reason',
			label: 'evicted after 15 min of inactivity (frees worker RAM)',
			tone: 'expected',
			code: 'idle_eviction',
		});
	});

	it('treats every worker lifecycle tag as expected', () => {
		for (const code of ['worker_stopped', 'worker_destroyed', 'worker_deleted', 'worker_torn_down']) {
			const reason = describeLoadError('unloaded', code);
			expect(reason?.heading, code).toBe('Reason');
			expect(reason?.tone, code).toBe('expected');
			expect(reason?.label, code).not.toBe(code);
		}
	});

	it('keeps a lost kernel red under an Error heading', () => {
		for (const code of ['subprocess_dead', 'subprocess_gone']) {
			const reason = describeLoadError('unloaded', code);
			expect(reason?.heading, code).toBe('Error');
			expect(reason?.tone, code).toBe('failure');
			expect(reason?.label, code).not.toBe(code);
		}
	});

	it('passes an unknown code through verbatim in the failure tone', () => {
		expect(describeLoadError('unloaded', 'something_new')).toEqual({
			heading: 'Error',
			label: 'something_new',
			tone: 'failure',
			code: 'something_new',
		});
	});

	it('never softens a row whose load_state is error, even with a known code', () => {
		const reason = describeLoadError('error', 'idle_eviction');
		expect(reason?.heading).toBe('Error');
		expect(reason?.tone).toBe('failure');
		expect(describeLoadError('error', 'Traceback: boom')?.label).toBe('Traceback: boom');
	});

	it('has nothing to say for an empty column or a loaded row', () => {
		expect(describeLoadError('unloaded', null)).toBeNull();
		expect(describeLoadError('unloaded', undefined)).toBeNull();
		expect(describeLoadError('unloaded', '   ')).toBeNull();
		expect(describeLoadError('loaded', 'idle_eviction')).toBeNull();
	});

	it('exposes the raw code so a tooltip can show what the server stored', () => {
		expect(describeLoadError('unloaded', ' idle_eviction ')?.code).toBe('idle_eviction');
	});

	/**
	 * The idle timeout is per notebook now, so the one label that quoted a
	 * duration has to quote *this* notebook's. The caller passes the control
	 * plane's effective value; nothing here resolves a default of its own.
	 */
	describe('with a known idle timeout', () => {
		it('names the notebook’s own duration in the eviction label', () => {
			expect(
				describeLoadError('unloaded', 'idle_eviction', { idleTimeoutSeconds: 14400 })?.label,
			).toBe('evicted after 4 h of inactivity (frees worker RAM)');
			expect(
				describeLoadError('unloaded', 'idle_eviction', { idleTimeoutSeconds: 900 })?.label,
			).toBe('evicted after 15 min of inactivity (frees worker RAM)');
		});

		it('keeps the eviction an expected reason whatever the duration', () => {
			const reason = describeLoadError('unloaded', 'idle_eviction', { idleTimeoutSeconds: 86400 });
			expect(reason?.heading).toBe('Reason');
			expect(reason?.tone).toBe('expected');
			expect(reason?.code).toBe('idle_eviction');
		});

		it('declines to name a duration when eviction is switched off', () => {
			// A stale code from before the setting changed: the notebook is not
			// evicted at all now, so "after never of inactivity" would be a lie.
			for (const seconds of [0, -1, Number.NaN, null]) {
				expect(
					describeLoadError('unloaded', 'idle_eviction', { idleTimeoutSeconds: seconds })?.label,
					String(seconds),
				).toBe('evicted after a period of inactivity (frees worker RAM)');
			}
		});

		it('changes nothing for any other code', () => {
			expect(
				describeLoadError('unloaded', 'worker_stopped', { idleTimeoutSeconds: 14400 })?.label,
			).toBe('worker was stopped');
			expect(
				describeLoadError('unloaded', 'something_new', { idleTimeoutSeconds: 14400 })?.label,
			).toBe('something_new');
			expect(describeLoadError('loaded', 'idle_eviction', { idleTimeoutSeconds: 14400 })).toBeNull();
		});
	});
});

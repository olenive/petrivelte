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
});

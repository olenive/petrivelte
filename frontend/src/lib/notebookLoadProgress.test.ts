import { describe, it, expect } from 'vitest';
import {
	emptyProgress,
	reduceLoadEvent,
	applyBurst,
	expectedSeconds,
	headline,
	MAX_LOG_LINES,
	STEP_ORDER
} from './notebookLoadProgress';
import type { NotebookLoadEvent, NotebookTimings } from './api';

function progressEvent(step: string, extra: Record<string, unknown> = {}): NotebookLoadEvent {
	return {
		seq: 1,
		scope: 'notebook',
		notebook_id: 'nb-1',
		kind: 'load_progress',
		ts: '',
		data: { step, message: step, ...extra }
	};
}

function logEvent(text: string): NotebookLoadEvent {
	return { seq: 1, scope: 'notebook', notebook_id: 'nb-1', kind: 'log', ts: '', data: { text } };
}

function fold(events: NotebookLoadEvent[]) {
	return events.reduce(reduceLoadEvent, emptyProgress());
}

function stateOf(progress: ReturnType<typeof emptyProgress>, name: string) {
	return progress.steps.find((s) => s.name === name)?.state;
}

describe('the checklist', () => {
	it('starts with every step pending and nothing claimed', () => {
		const progress = emptyProgress();
		expect(progress.steps).toHaveLength(STEP_ORDER.length);
		expect(progress.steps.every((s) => s.state === 'pending')).toBe(true);
		expect(progress.current).toBeNull();
		expect(progress.done).toBe(false);
	});

	it('marks the reported step active and names it as current', () => {
		const progress = fold([progressEvent('import_marimo')]);
		expect(stateOf(progress, 'import_marimo')).toBe('active');
		expect(progress.current).toBe('import_marimo');
	});

	it('completes a step when its done marker arrives, with its duration', () => {
		const progress = fold([
			progressEvent('import_marimo'),
			progressEvent('import_marimo', { done: true, elapsed_s: 31.2 })
		]);
		expect(stateOf(progress, 'import_marimo')).toBe('done');
		expect(progress.steps.find((s) => s.name === 'import_marimo')?.elapsed_s).toBe(31.2);
		expect(progress.current).toBeNull();
	});

	it('back-fills earlier steps a later one implies', () => {
		// Events get missed. A row stuck on "pending" beside later rows that
		// finished is a worse lie than one that quietly caught up.
		const progress = fold([progressEvent('serve')]);
		expect(stateOf(progress, 'download')).toBe('done');
		expect(stateOf(progress, 'import_marimo')).toBe('done');
		expect(stateOf(progress, 'serve')).toBe('active');
	});

	it('completes a step whose start was never seen', () => {
		const progress = fold([progressEvent('build_app', { done: true, elapsed_s: 17.7 })]);
		expect(stateOf(progress, 'build_app')).toBe('done');
	});

	it('is unmoved by a duplicate event', () => {
		const once = fold([progressEvent('import_marimo', { done: true, elapsed_s: 3 })]);
		const twice = fold([
			progressEvent('import_marimo', { done: true, elapsed_s: 3 }),
			progressEvent('import_marimo', { done: true, elapsed_s: 3 })
		]);
		expect(twice).toEqual(once);
	});

	it('ignores a step it does not know rather than inventing a row', () => {
		const progress = fold([progressEvent('teleport')]);
		expect(progress.steps).toHaveLength(STEP_ORDER.length);
		expect(progress.current).toBeNull();
	});

	it('finishes the outstanding steps when the notebook reports ready', () => {
		const progress = fold([progressEvent('serve'), progressEvent('ready', { done: true })]);
		expect(stateOf(progress, 'serve')).toBe('done');
		expect(progress.done).toBe(true);
		expect(progress.current).toBeNull();
	});

	it('leaves assets alone on ready, because the browser is still fetching', () => {
		// The subprocess is serving before the burst finishes. Marking assets
		// done here would claim the page is loaded while it is still blank.
		const ready = applyBurst(emptyProgress(), {
			load: null,
			burst: null,
			burst_in_progress: true,
			burst_progress: { count: 12, elapsed_s: 2, expected: 228 }
		} as NotebookTimings);
		const after = reduceLoadEvent(ready, progressEvent('ready', { done: true }));
		expect(stateOf(after, 'assets')).toBe('active');
	});
});

describe('failure', () => {
	it('names the reason and marks the running step failed', () => {
		const progress = fold([
			progressEvent('import_marimo'),
			progressEvent('failed', { message: 'did not report ready: rc=1' })
		]);
		expect(progress.failure).toBe('did not report ready: rc=1');
		expect(stateOf(progress, 'import_marimo')).toBe('failed');
		expect(progress.done).toBe(true);
	});

	it('is what the headline leads with', () => {
		const progress = fold([progressEvent('failed', { message: 'boom' })]);
		expect(headline(progress, 10, 50)).toEqual({
			title: 'The notebook failed to load',
			detail: 'boom'
		});
	});
});

describe('the log', () => {
	it('keeps lines in order', () => {
		const progress = fold([logEvent('first'), logEvent('second')]);
		expect(progress.log).toEqual(['first', 'second']);
	});

	it('drops empty lines rather than padding the view with them', () => {
		expect(fold([logEvent('')]).log).toEqual([]);
	});

	it('is bounded, so a chatty notebook cannot grow the page forever', () => {
		const many = Array.from({ length: MAX_LOG_LINES + 50 }, (_, i) => logEvent(`line ${i}`));
		const progress = fold(many);
		expect(progress.log).toHaveLength(MAX_LOG_LINES);
		expect(progress.log.at(-1)).toBe(`line ${MAX_LOG_LINES + 49}`);
	});
});

describe('the asset burst', () => {
	const timings = (over: Partial<NotebookTimings>): NotebookTimings =>
		({ load: null, burst: null, burst_in_progress: false, ...over }) as NotebookTimings;

	it('shows a real fraction once a denominator exists', () => {
		const progress = applyBurst(
			emptyProgress(),
			timings({ burst_in_progress: true, burst_progress: { count: 143, elapsed_s: 9, expected: 228 } })
		);
		expect(progress.steps.find((s) => s.name === 'assets')?.fraction).toEqual({
			done: 143,
			total: 228
		});
		expect(progress.current).toBe('assets');
	});

	it('shows a bare count on a first-ever open instead of guessing one', () => {
		const progress = applyBurst(
			emptyProgress(),
			timings({ burst_in_progress: true, burst_progress: { count: 12, elapsed_s: 1, expected: null } })
		);
		expect(progress.steps.find((s) => s.name === 'assets')?.fraction).toEqual({
			done: 12,
			total: null
		});
	});

	it('completes assets when the burst settles', () => {
		const open = applyBurst(
			emptyProgress(),
			timings({ burst_in_progress: true, burst_progress: { count: 5, elapsed_s: 1, expected: 228 } })
		);
		const settled = applyBurst(
			open,
			timings({ burst: { count: 228, wall_s: 24 } as NotebookTimings['burst'] })
		);
		expect(stateOf(settled, 'assets')).toBe('done');
		expect(settled.steps.find((s) => s.name === 'assets')?.elapsed_s).toBe(24);
		expect(settled.current).toBeNull();
	});

	it('does nothing when an older control plane omits the field', () => {
		const before = emptyProgress();
		expect(applyBurst(before, timings({}))).toEqual(before);
	});
});

describe('the expectation', () => {
	it('is this notebook own last load, spawn plus burst', () => {
		const value = expectedSeconds({
			load: { total_s: 50.7, phases: {}, at: 0 },
			burst: { wall_s: 24 },
			burst_in_progress: false
		} as NotebookTimings);
		expect(value).toBeCloseTo(74.7);
	});

	it('is null when we have never seen this notebook load', () => {
		expect(expectedSeconds(null)).toBeNull();
		expect(expectedSeconds({ load: null, burst: null, burst_in_progress: false })).toBeNull();
	});

	it('says nothing about duration when there is no expectation', () => {
		const progress = fold([progressEvent('import_marimo')]);
		expect(headline(progress, 12, null)).toEqual({ title: 'Importing Marimo', detail: null });
	});

	it('admits when a load is running long instead of pretending', () => {
		const progress = fold([progressEvent('import_marimo')]);
		expect(headline(progress, 120, 50).detail).toBe('longer than usual (120s)');
	});
});

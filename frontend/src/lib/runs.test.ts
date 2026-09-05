import { describe, expect, it } from 'vitest';

import type { DailyRollup, RunPage, RunRecord } from './api';
import {
	appendRunPage,
	dailyChart,
	emptyRunHistory,
	formatDuration,
	formatElapsed,
	hasMoreRuns,
	lastRunBadge,
	pendingLabel,
	progressLabel,
	reasonLabel,
	refreshRunHistory,
	runStateColour,
	runStateMeta,
	triggerLabel,
} from './runs';

/**
 * The run record, as the UI reads it.
 *
 * Two properties are worth tests of their own.
 *
 * States and reasons are closed sets the server enforces, and the UI switches
 * on them. A tag it does not know must therefore stay neutral: the failure
 * being ruled out is a backend tag added later — or a worker's prose leaking
 * into `reason` — painting itself with somebody else's colour.
 *
 * And the history pages backwards on a `created_at` cursor while live events
 * refresh its newest page. Getting that wrong does not throw; it silently
 * duplicates a run, or drops the pages the reader already asked for.
 */

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
	id: 'r-1',
	net_id: 'n-1',
	trigger: 'manual',
	scheduled_for: null,
	state: 'succeeded',
	reason: 'no_enabled_transitions',
	error: null,
	step_count: 12,
	created_at: '2026-09-05T10:00:00Z',
	started_at: '2026-09-05T10:00:00Z',
	ended_at: '2026-09-05T10:01:00Z',
	duration_s: 60,
	...over,
});

const page = (runs: RunRecord[], next: string | null = null): RunPage => ({
	runs,
	next_before: next,
});

const rollup = (over: Partial<DailyRollup> = {}): DailyRollup => ({
	net_id: 'n-1',
	day: '2026-09-05',
	runs: 1,
	succeeded: 1,
	failed: 0,
	stopped: 0,
	skipped: 0,
	steps_total: 10,
	duration_total_s: 60,
	duration_max_s: 60,
	...over,
});

const NOW = Date.parse('2026-09-05T12:00:00Z');

describe('runStateMeta', () => {
	it('knows every state the server can write', () => {
		for (const state of [
			'claimed', 'dispatched', 'running',
			'succeeded', 'failed', 'stopped', 'skipped',
		]) {
			expect(runStateMeta(state).label).not.toBe('unknown');
		}
	});

	it('falls back to a neutral label for a tag it has never seen', () => {
		// A state added to the backend later must not inherit a colour that
		// says something about it.
		expect(runStateMeta('quarantined')).toEqual(runStateMeta(null));
		expect(runStateMeta('quarantined').label).toBe('unknown');
	});

	it('gives an unknown state no colour of its own', () => {
		expect(runStateColour('quarantined')).toBe(runStateColour(undefined));
	});

	it('separates the outcomes by colour', () => {
		const colours = ['succeeded', 'failed', 'stopped', 'skipped'].map(runStateColour);
		expect(new Set(colours).size).toBe(4);
	});

	it('marks the three open states open and the terminal ones not', () => {
		expect(['claimed', 'dispatched', 'running'].every((s) => runStateMeta(s).open)).toBe(true);
		expect(['succeeded', 'failed', 'stopped', 'skipped'].some((s) => runStateMeta(s).open)).toBe(false);
	});
});

describe('reasonLabel', () => {
	it('spells out every tag in the closed set', () => {
		const tags = [
			'no_enabled_transitions', 'user_stop', 'unloaded', 'transition_raised',
			'subprocess_exited', 'load_failed', 'dispatch_failed', 'worker_lost',
			'abandoned', 'overlap',
		];
		for (const tag of tags) {
			expect(reasonLabel(tag)).toBeTruthy();
			expect(reasonLabel(tag)).not.toContain('_');
		}
	});

	it('shows an unknown tag as itself rather than hiding it', () => {
		// It is data. Dropping it would leave a failed run with no stated
		// reason at all; it just never decides a colour.
		expect(reasonLabel('quota_exceeded')).toBe('quota exceeded');
	});

	it('says nothing when there is no reason', () => {
		expect(reasonLabel(null)).toBeNull();
		expect(reasonLabel(undefined)).toBeNull();
	});
});

describe('triggerLabel', () => {
	it('reads a pruned run’s missing trigger as unknown, not as manual', () => {
		// Retention deletes the run row while the outcome survives on the
		// state row, so null here is a real answer.
		expect(triggerLabel(null)).toBe('unknown');
	});

	it('passes an unrecognised trigger through as words', () => {
		expect(triggerLabel('api_call')).toBe('api call');
	});
});

describe('formatDuration', () => {
	it('keeps a decimal for short runs and drops it for longer ones', () => {
		expect(formatDuration(1.24)).toBe('1.2s');
		expect(formatDuration(42.6)).toBe('43s');
	});

	it('breaks minutes and hours out', () => {
		expect(formatDuration(125)).toBe('2m 05s');
		expect(formatDuration(3 * 3600 + 7 * 60)).toBe('3h 07m');
	});

	it('has nothing to say about a run that has not ended', () => {
		expect(formatDuration(null)).toBeNull();
		expect(formatDuration(undefined)).toBeNull();
	});
});

describe('formatElapsed', () => {
	it('reports one unit at a time', () => {
		expect(formatElapsed('2026-09-05T11:59:30Z', NOW)).toBe('30s');
		expect(formatElapsed('2026-09-05T11:30:00Z', NOW)).toBe('30m');
		expect(formatElapsed('2026-09-05T06:00:00Z', NOW)).toBe('6h');
		expect(formatElapsed('2026-09-01T12:00:00Z', NOW)).toBe('4d');
	});

	it('returns null for an absent or unparseable time', () => {
		expect(formatElapsed(null, NOW)).toBeNull();
		expect(formatElapsed('not a time', NOW)).toBeNull();
	});
});

describe('lastRunBadge', () => {
	it('says nothing about a net that has never run', () => {
		// The state row is created by the first run, so its absence is the
		// answer; a badge here would be an invention.
		expect(lastRunBadge(null, NOW)).toBeNull();
		expect(lastRunBadge({ id: 'r', trigger: null, state: null, reason: null, ended_at: null }, NOW))
			.toBeNull();
	});

	it('renders state and reason, and puts the age in the tooltip', () => {
		const badge = lastRunBadge({
			id: 'r-9',
			trigger: 'schedule',
			state: 'failed',
			reason: 'transition_raised',
			ended_at: '2026-09-05T11:00:00Z',
		}, NOW);

		expect(badge?.label).toBe('failed');
		expect(badge?.detail).toBe('a transition raised');
		expect(badge?.colour).toBe(runStateColour('failed'));
		expect(badge?.title).toContain('ended 1h ago');
		expect(badge?.title).toContain('schedule');
	});

	it('still renders once retention has taken the run row away', () => {
		// `trigger` and `ended_at` come from the run; the outcome is
		// denormalised onto the state row precisely so it outlives them.
		const badge = lastRunBadge({
			id: 'r-old',
			trigger: null,
			state: 'succeeded',
			reason: 'no_enabled_transitions',
			ended_at: null,
		}, NOW);

		expect(badge?.label).toBe('succeeded');
		expect(badge?.detail).toBe('no enabled transitions');
	});
});

describe('progressLabel', () => {
	const running = {
		load_state: 'loaded' as const,
		desired_state: 'running' as const,
		step_count: 4213,
		last_progress_at: '2026-09-05T11:59:48Z',
	};

	it('quantifies progress for a running net', () => {
		expect(progressLabel(running, NOW)?.text).toBe('step 4213 · 12s ago');
	});

	it('says nothing for a net that is not meant to be running', () => {
		// On a stopped net the same age is just "when it stopped", which the
		// last-run badge already says.
		expect(progressLabel({ ...running, desired_state: 'stopped' }, NOW)).toBeNull();
		expect(progressLabel({ ...running, load_state: 'unloaded' }, NOW)).toBeNull();
	});

	it('says a running net has reported nothing rather than saying nothing', () => {
		// "When did it stop" is the whole question for a hang; silence here
		// would be the bug, not the answer.
		const label = progressLabel({ ...running, step_count: null, last_progress_at: null }, NOW);
		expect(label?.text).toBe('no progress reported');
	});
});

describe('pendingLabel', () => {
	it('names the refusal and when the wait started', () => {
		const label = pendingLabel({
			pending_reason: 'worker_not_ready',
			pending_since: '2026-09-05T11:00:00Z',
		}, NOW);

		expect(label?.text).toContain('waiting for worker since');
		expect(label?.title).toContain('for 1h');
		expect(label?.title).toContain('2026-09-05T11:00:00Z');
	});

	it('is silent when nothing is pending', () => {
		expect(pendingLabel({ pending_reason: null, pending_since: null }, NOW)).toBeNull();
	});

	it('still names an unknown refusal', () => {
		const label = pendingLabel({ pending_reason: 'quota_hold', pending_since: null }, NOW);
		expect(label?.text).toBe('quota hold');
	});
});

describe('run history paging', () => {
	it('starts empty with nothing more to fetch', () => {
		const history = emptyRunHistory();
		expect(history.runs).toEqual([]);
		expect(hasMoreRuns(history)).toBe(false);
	});

	it('takes the first page whole, cursor and all', () => {
		const history = refreshRunHistory(emptyRunHistory(), page([run()], '2026-09-05T10:00:00Z'));
		expect(history.runs).toHaveLength(1);
		expect(hasMoreRuns(history)).toBe(true);
	});

	it('appends an older page and adopts its cursor', () => {
		const first = refreshRunHistory(
			emptyRunHistory(),
			page([run({ id: 'r-3' }), run({ id: 'r-2' })], '2026-09-05T09:00:00Z'),
		);
		const second = appendRunPage(first, page([run({ id: 'r-1' })], null));

		expect(second.runs.map((r) => r.id)).toEqual(['r-3', 'r-2', 'r-1']);
		// The server said there is nothing older, so the button must stop.
		expect(hasMoreRuns(second)).toBe(false);
	});

	it('never lists a run twice when pages overlap', () => {
		// A close landing between two fetches can put the same run on both.
		const first = refreshRunHistory(emptyRunHistory(), page([run({ id: 'r-2' })], 'cursor'));
		const second = appendRunPage(first, page([run({ id: 'r-2' }), run({ id: 'r-1' })], null));

		expect(second.runs.map((r) => r.id)).toEqual(['r-2', 'r-1']);
	});

	it('prefers the newer read of a run it already held', () => {
		const first = refreshRunHistory(
			emptyRunHistory(),
			page([run({ id: 'r-2', state: 'running', ended_at: null, duration_s: null })], 'cursor'),
		);
		const second = appendRunPage(
			first,
			page([run({ id: 'r-2', state: 'succeeded', duration_s: 9 })], null),
		);

		expect(second.runs[0].state).toBe('succeeded');
		expect(second.runs[0].duration_s).toBe(9);
	});

	it('folds a refreshed first page in without losing the older pages', () => {
		// What a live run event does: refetch page one, keep everything the
		// reader has already asked for.
		const loaded = appendRunPage(
			refreshRunHistory(emptyRunHistory(), page([run({ id: 'r-3' })], 'c1')),
			page([run({ id: 'r-2' }), run({ id: 'r-1' })], 'c2'),
		);
		const refreshed = refreshRunHistory(
			loaded,
			page([run({ id: 'r-4' }), run({ id: 'r-3', state: 'stopped', reason: 'user_stop' })], 'c1'),
		);

		expect(refreshed.runs.map((r) => r.id)).toEqual(['r-4', 'r-3', 'r-2', 'r-1']);
		expect(refreshed.runs[1].state).toBe('stopped');
		// The cursor points past the oldest run in hand; the first page
		// cannot have moved it.
		expect(refreshed.nextBefore).toBe('c2');
	});

	it('does not resurrect the "load more" button on a refresh', () => {
		const exhausted = refreshRunHistory(emptyRunHistory(), page([run({ id: 'r-1' })], null));
		const refreshed = refreshRunHistory(exhausted, page([run({ id: 'r-2' }), run({ id: 'r-1' })], 'c1'));

		expect(refreshed.runs.map((r) => r.id)).toEqual(['r-2', 'r-1']);
		expect(hasMoreRuns(refreshed)).toBe(false);
	});
});

describe('dailyChart', () => {
	const opts = { days: 30, now: NOW };

	it('places a day by its date, not by its position in the array', () => {
		const chart = dailyChart([rollup({ day: '2026-08-27' }), rollup({ day: '2026-09-05' })], opts);

		expect(chart.columns).toBe(30);
		expect(chart.bars.map((b) => b.column)).toEqual([21, 30]);
	});

	it('leaves a gap for a day with no row instead of drawing a zero', () => {
		// The endpoint omits days on which nothing ran, and the omission is
		// information: "ran daily until Tuesday" must not look like "runs
		// twice a week".
		const chart = dailyChart([rollup({ day: '2026-09-03' }), rollup({ day: '2026-09-05' })], opts);

		expect(chart.bars).toHaveLength(2);
		expect(chart.bars.map((b) => b.column)).toEqual([28, 30]);
	});

	it('stacks the outcomes and scales to the busiest day', () => {
		const chart = dailyChart([
			rollup({ day: '2026-09-04', runs: 3, succeeded: 1, failed: 1, skipped: 1 }),
			rollup({ day: '2026-09-05', runs: 1, succeeded: 1 }),
		], opts);

		expect(chart.max).toBe(3);
		expect(chart.bars[0].segments.map((s) => s.state)).toEqual(['succeeded', 'failed', 'skipped']);
		expect(chart.bars[0].total).toBe(3);
	});

	it('drops a day older than the window rather than piling it on the edge', () => {
		const chart = dailyChart([rollup({ day: '2026-01-01' }), rollup({ day: '2026-09-05' })], opts);

		expect(chart.bars.map((b) => b.day)).toEqual(['2026-09-05']);
	});

	it('has no scale when nothing ran', () => {
		const chart = dailyChart([], opts);
		expect(chart.bars).toEqual([]);
		expect(chart.max).toBe(0);
	});

	it('reports the window it drew, in UTC days, so the axis can be labelled', () => {
		const chart = dailyChart([], opts);
		expect(chart.endDay).toBe('2026-09-05');
		expect(chart.startDay).toBe('2026-08-07');
	});

	it('names the day in UTC in the tooltip', () => {
		const chart = dailyChart([rollup({ day: '2026-09-05', duration_max_s: 90 })], opts);
		expect(chart.bars[0].title).toContain('2026-09-05 (UTC)');
		expect(chart.bars[0].title).toContain('longest 1m 30s');
	});
});

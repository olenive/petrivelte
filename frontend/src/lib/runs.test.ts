import { describe, expect, it } from 'vitest';

import type { DailyRollup, LastRun, Net, RunPage, RunRecord } from './api';
import type { RunEvent } from './stores/serverEvents';
import {
	appendRunPage,
	applyRunEvent,
	dailyChart,
	emptyRunHistory,
	formatDuration,
	formatElapsed,
	hasMoreRuns,
	lastRunBadge,
	netIsRunning,
	openRunLabel,
	previousRunLabel,
	runHeadline,
	pendingLabel,
	progressLabel,
	reasonLabel,
	refreshRunHistory,
	runStateColour,
	runStateMeta,
	scheduleFacts,
	executionVerbs,
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

const lastRun = (over: Partial<LastRun> = {}): LastRun => ({
	id: 'r-1',
	trigger: 'manual',
	state: 'succeeded',
	reason: 'no_enabled_transitions',
	started_at: '2026-09-05T10:00:00Z',
	ended_at: '2026-09-05T10:01:00Z',
	duration_s: 60,
	...over,
});

/** Just the run fields; the liveness helpers read nothing else off a net. */
type NetRunFields = Pick<
	Net,
	'id' | 'last_run' | 'open_run' | 'pending_reason' | 'pending_since'
	| 'step_count' | 'last_progress_at' | 'last_success_at'
>;

const netFields = (over: Partial<NetRunFields> = {}): NetRunFields => ({
	id: 'n-1',
	last_run: null,
	open_run: null,
	pending_reason: null,
	pending_since: null,
	step_count: null,
	last_progress_at: null,
	last_success_at: null,
	...over,
});

/** Just the schedule fields; the wording and the facts read nothing else. */
type NetScheduleFields = Pick<
	Net,
	'execution_mode' | 'schedule' | 'desired_state' | 'next_run_at'
	| 'pending_reason' | 'pending_since'
>;

const netSchedule = (over: Partial<NetScheduleFields> = {}): NetScheduleFields => ({
	execution_mode: 'cron',
	schedule: '0 2 * * *',
	desired_state: 'running',
	next_run_at: '2026-09-06T02:00:00Z',
	pending_reason: null,
	pending_since: null,
	...over,
});

const runEvent = (over: Partial<RunEvent> = {}): RunEvent => ({
	type: 'net_run_started',
	run_id: 'r-9',
	net_id: 'n-1',
	trigger: 'manual',
	state: 'running',
	reason: null,
	started_at: '2026-09-05T11:58:00Z',
	ended_at: null,
	scheduled_for: null,
	...over,
} as RunEvent);

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
			'abandoned', 'overlap', 'paused',
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
		expect(lastRunBadge(lastRun({ state: null, reason: null }), NOW)).toBeNull();
	});

	it('renders state and reason, and puts the age in the tooltip', () => {
		const badge = lastRunBadge({
			id: 'r-9',
			trigger: 'schedule',
			state: 'failed',
			reason: 'transition_raised',
			started_at: '2026-09-05T10:55:48Z',
			ended_at: '2026-09-05T11:00:00Z',
			duration_s: 252,
		}, NOW);

		expect(badge?.label).toBe('failed');
		expect(badge?.detail).toBe('a transition raised');
		expect(badge?.colour).toBe(runStateColour('failed'));
		expect(badge?.title).toContain('took 4m 12s');
		expect(badge?.title).toContain('ended 1h ago');
		expect(badge?.title).toContain('schedule');
	});

	it('does not say a skipped slot ended', () => {
		// It never ran. `ended_at` is when the control plane consumed the slot,
		// which is a different event from a run finishing.
		const skipped = lastRunBadge(lastRun({
			state: 'skipped',
			reason: 'overlap',
			started_at: null,
			ended_at: '2026-09-05T11:57:00Z',
			duration_s: null,
		}), NOW);
		const stopped = lastRunBadge(lastRun({
			state: 'stopped',
			reason: 'user_stop',
			ended_at: '2026-09-05T11:57:00Z',
		}), NOW);

		expect(skipped?.title).toContain('skipped 3m ago');
		expect(skipped?.title).not.toContain('ended');
		expect(stopped?.title).toContain('ended 3m ago');
	});

	it('still renders once retention has taken the run row away', () => {
		// `trigger` and `ended_at` come from the run; the outcome is
		// denormalised onto the state row precisely so it outlives them.
		const badge = lastRunBadge(lastRun({
			trigger: null,
			state: 'succeeded',
			reason: 'no_enabled_transitions',
			started_at: null,
			ended_at: null,
			duration_s: null,
		}), NOW);

		expect(badge?.label).toBe('succeeded');
		expect(badge?.detail).toBe('no enabled transitions');
		expect(badge?.title).not.toContain('took');
	});
});

describe('liveness', () => {
	const executing = netFields({
		open_run: { id: 'r-9', trigger: 'schedule', state: 'running', created_at: '2026-09-05T11:57:59Z', started_at: '2026-09-05T11:58:00Z', scheduled_for: null },
		step_count: 4213,
		last_progress_at: '2026-09-05T11:59:48Z',
	});

	// The whole point of `open_run`. A one-shot net that has drained sits
	// loaded and desired-running while doing nothing at all — the daily
	// pipeline spends twenty-three hours a day like this — so the old
	// inference reported steady progress on a net that had finished hours ago.
	const drained = netFields({
		open_run: null,
		step_count: 4213,
		last_progress_at: '2026-09-05T02:31:00Z',
		last_run: lastRun({ state: 'succeeded', ended_at: '2026-09-05T02:31:00Z' }),
	});

	it('calls a net running only while a run is open and running', () => {
		expect(netIsRunning(executing)).toBe(true);
		expect(netIsRunning(drained)).toBe(false);
		expect(netIsRunning(netFields({
			open_run: { id: 'r-9', trigger: 'schedule', state: 'claimed', created_at: '2026-09-05T11:56:00Z', started_at: null, scheduled_for: null },
		}))).toBe(false);
	});

	it('quantifies progress for a running net', () => {
		expect(progressLabel(executing, NOW)?.text).toBe('step 4213 · 12s ago');
	});

	it('shows no progress for a drained one-shot net', () => {
		// It is loaded, it is desired-running, and it has a step count and a
		// progress time from this morning. None of that is progress.
		expect(progressLabel(drained, NOW)).toBeNull();
		expect(openRunLabel(drained, NOW)).toBeNull();
	});

	it('says a running net has reported nothing rather than saying nothing', () => {
		// "When did it stop" is the whole question for a hang; silence here
		// would be the bug, not the answer.
		const label = progressLabel(
			netFields({ ...executing, step_count: null, last_progress_at: null }),
			NOW,
		);
		expect(label?.text).toBe('no progress reported');
	});

	it('says how long the open run has been running', () => {
		const label = openRunLabel(executing, NOW);
		expect(label?.text).toContain('running since');
		expect(label?.text).toContain('(2m)');
		expect(label?.title).toContain('2026-09-05T11:58:00Z');
	});

	it('calls an armed run pending, not running, and shows no progress', () => {
		// `claimed` and `dispatched` mean the slot is taken and the load
		// issued. Nothing is firing yet, and `started_at` is null until it is.
		for (const state of ['claimed', 'dispatched']) {
			const armed = netFields({
				open_run: { id: 'r-9', trigger: 'schedule', state, created_at: '2026-09-05T11:56:00Z', started_at: null, scheduled_for: '2026-09-05T02:00:00Z' },
				step_count: 12,
				last_progress_at: '2026-09-05T02:31:00Z',
			});
			expect(openRunLabel(armed, NOW)?.text).toContain('scheduled run pending');
			expect(progressLabel(armed, NOW)).toBeNull();
		}
	});

	it('measures an armed run’s wait from when it was claimed', () => {
		// `started_at` is null for a run that has not begun, so the wait has to
		// come from `created_at` — and a claim that is not moving is exactly
		// what this is for.
		const armed = netFields({
			open_run: {
				id: 'r-9', trigger: 'schedule', state: 'claimed',
				created_at: '2026-09-05T11:56:00Z', started_at: null, scheduled_for: null,
			},
		});
		const label = openRunLabel(armed, NOW);

		expect(label?.text).toBe('scheduled run pending since 4m');
		expect(label?.title).toContain('2026-09-05T11:56:00Z');
	});

	it('names the slot an armed run is waiting for, in UTC', () => {
		// Schedules are UTC by policy, so the slot must read as the same number
		// that is written in the net's decorator.
		const armed = netFields({
			open_run: {
				id: 'r-9', trigger: 'schedule', state: 'dispatched',
				created_at: '2026-09-05T11:56:00Z', started_at: null,
				scheduled_for: '2026-09-05T02:00:00Z',
			},
		});

		expect(openRunLabel(armed, NOW)?.text).toBe(
			'scheduled run pending since 4m · for the 02:00 UTC slot',
		);
	});

	it('dates a slot that is not today’s', () => {
		const armed = netFields({
			open_run: {
				id: 'r-9', trigger: 'schedule', state: 'claimed',
				created_at: '2026-09-05T11:56:00Z', started_at: null,
				scheduled_for: '2026-09-04T02:00:00Z',
			},
		});

		expect(openRunLabel(armed, NOW)?.text).toContain('for the Sep 4 02:00 UTC slot');
	});

	it('still names an open run in a state it has never heard of', () => {
		const odd = netFields({
			open_run: { id: 'r-9', trigger: 'manual', state: 'quarantined', created_at: '2026-09-05T11:56:00Z', started_at: null, scheduled_for: null },
		});
		expect(openRunLabel(odd, NOW)?.text).toContain('run open (unknown)');
		expect(progressLabel(odd, NOW)).toBeNull();
	});
});

describe('previousRunLabel', () => {
	it('says the outcome once, not twice', () => {
		// "stopped · stopped by user" is the state and a reason that opens with
		// it; the reason alone carries both.
		const label = previousRunLabel(lastRun({
			state: 'stopped',
			reason: 'user_stop',
			duration_s: 369,
		}), NOW);

		expect(label?.text).toBe('previous run: stopped by user · 6m 09s');
	});

	it('keeps the state when the reason does not already say it', () => {
		const label = previousRunLabel(lastRun({
			state: 'succeeded',
			reason: 'no_enabled_transitions',
			duration_s: 1864,
		}), NOW);

		expect(label?.text).toBe('previous run: succeeded · no enabled transitions · 31m 04s');
	});

	it('leaves the duration out when retention has taken it', () => {
		const label = previousRunLabel(lastRun({
			state: 'failed',
			reason: 'worker_lost',
			duration_s: null,
		}), NOW);

		expect(label?.text).toBe('previous run: failed · worker lost');
	});

	it('keeps the age in the tooltip', () => {
		expect(previousRunLabel(lastRun({ ended_at: '2026-09-05T11:00:00Z' }), NOW)?.title)
			.toContain('ended 1h ago');
	});

	it('says nothing about a net that has never run', () => {
		expect(previousRunLabel(null, NOW)).toBeNull();
	});
});

describe('runHeadline', () => {
	const open = {
		id: 'r-9', trigger: 'manual', state: 'running',
		created_at: '2026-09-05T00:37:59Z', started_at: '2026-09-05T00:38:00Z',
		scheduled_for: null,
	};

	it('never shows a bare outcome badge while a run is open', () => {
		// The production screenshot this exists for: "running since 00:38
		// (10h) · step 732 · 2m ago  [stopped] stopped by user" — two facts
		// side by side with no label, read as one contradiction.
		const headline = runHeadline(netFields({
			open_run: open,
			last_run: lastRun({ state: 'stopped', reason: 'user_stop', duration_s: 369 }),
		}), NOW);

		expect(headline.kind).toBe('open');
		// The 'open' variant carries no badge at all — the type says so, and
		// so does this, so a template cannot render one by accident.
		expect('badge' in headline).toBe(false);
		if (headline.kind !== 'open') throw new Error('expected an open headline');
		expect(headline.open.text).toContain('running since');
		expect(headline.previous?.text).toBe('previous run: stopped by user · 6m 09s');
	});

	it('leads with the badge when nothing is open', () => {
		const headline = runHeadline(netFields({
			open_run: null,
			last_run: lastRun({ state: 'stopped', reason: 'user_stop' }),
		}), NOW);

		expect(headline.kind).toBe('last');
		if (headline.kind !== 'last') throw new Error('expected a last-run headline');
		expect(headline.badge.label).toBe('stopped');
		expect(headline.badge.detail).toBe('stopped by user');
		expect(headline.badge.colour).toBe(runStateColour('stopped'));
	});

	it('has nothing to say about a net that has never run', () => {
		expect(runHeadline(netFields(), NOW).kind).toBe('none');
	});

	it('still leads with the open run when there is no previous one', () => {
		const headline = runHeadline(netFields({ open_run: open }), NOW);

		expect(headline.kind).toBe('open');
		if (headline.kind !== 'open') throw new Error('expected an open headline');
		expect(headline.previous).toBeNull();
	});
});

describe('applyRunEvent', () => {
	it('opens a run and answers whatever was pending', () => {
		const net = netFields({ pending_reason: 'worker_not_ready', pending_since: '2026-09-05T11:00:00Z' });
		const updated = applyRunEvent(net, runEvent());

		expect(updated.open_run?.id).toBe('r-9');
		expect(updated.open_run?.started_at).toBe('2026-09-05T11:58:00Z');
		// The event carries no `created_at`; for a run that has just started
		// the two are the same instant, and the refetch replaces it anyway.
		expect(updated.open_run?.created_at).toBe('2026-09-05T11:58:00Z');
		expect(updated.pending_reason).toBeNull();
		expect(updated.pending_since).toBeNull();
	});

	it('prefers the event’s own created_at for the open run', () => {
		const armed = applyRunEvent(netFields(), runEvent({
			created_at: '2026-09-05T11:57:30Z',
			started_at: '2026-09-05T11:58:00Z',
		}));

		expect(armed.open_run?.created_at).toBe('2026-09-05T11:57:30Z');
	});

	it('carries the slot onto the open run it opens', () => {
		const armed = applyRunEvent(netFields(), runEvent({
			trigger: 'schedule',
			scheduled_for: '2026-09-05T02:00:00Z',
		}));

		expect(armed.open_run?.scheduled_for).toBe('2026-09-05T02:00:00Z');
	});

	it('closes the run it names, with a duration derived from the event', () => {
		const net = applyRunEvent(netFields(), runEvent());
		const closed = applyRunEvent(net, runEvent({
			type: 'net_run_finished',
			state: 'succeeded',
			reason: 'no_enabled_transitions',
			ended_at: '2026-09-05T11:59:00Z',
		}));

		expect(closed.open_run).toBeNull();
		expect(closed.last_run?.state).toBe('succeeded');
		expect(closed.last_run?.duration_s).toBe(60);
		expect(closed.last_success_at).toBe('2026-09-05T11:59:00Z');
	});

	it('does not move last_success_at for a run that did not succeed', () => {
		const net = netFields({ last_success_at: '2026-09-04T02:31:00Z' });
		const closed = applyRunEvent(net, runEvent({
			type: 'net_run_finished',
			state: 'failed',
			reason: 'transition_raised',
			ended_at: '2026-09-05T11:59:00Z',
		}));

		expect(closed.last_success_at).toBe('2026-09-04T02:31:00Z');
	});

	it('records a skipped slot without claiming the net ran', () => {
		const armed = netFields({
			open_run: { id: 'r-9', trigger: 'schedule', state: 'claimed', created_at: '2026-09-05T11:56:00Z', started_at: null, scheduled_for: null },
		});
		const skipped = applyRunEvent(armed, runEvent({
			type: 'net_run_skipped',
			trigger: 'schedule',
			state: 'skipped',
			reason: 'overlap',
			started_at: null,
			ended_at: '2026-09-05T11:59:00Z',
			scheduled_for: '2026-09-05T11:59:00Z',
		}));

		expect(skipped.open_run).toBeNull();
		expect(skipped.last_run?.state).toBe('skipped');
		// No start, so no duration to invent.
		expect(skipped.last_run?.duration_s).toBeNull();
	});

	it('leaves a live run alone when a late event closes an older one', () => {
		// Otherwise a stale event makes an executing net look idle.
		const net = applyRunEvent(netFields(), runEvent());
		const stale = applyRunEvent(net, runEvent({
			type: 'net_run_finished',
			run_id: 'r-8',
			state: 'stopped',
			reason: 'user_stop',
			ended_at: '2026-09-05T11:00:00Z',
		}));

		expect(stale.open_run?.id).toBe('r-9');
	});

	it('ignores an event about another net', () => {
		const net = netFields({ id: 'n-2' });
		expect(applyRunEvent(net, runEvent())).toBe(net);
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

describe('executionVerbs', () => {
	// Two questions the words have to keep apart: what kind of net this is
	// (`execution_mode`), and whether it is meant to be running
	// (`desired_state`). A cron net that is armed but idle — which the daily
	// pipeline is for twenty-three hours a day — is armed, not paused.
	const cron = (over: Partial<NetScheduleFields> = {}) => netSchedule(over);

	it('names the schedule for a cron net', () => {
		const verbs = executionVerbs(cron());

		expect(verbs.scheduled).toBe(true);
		expect(verbs.activate).toBe('Arm schedule');
		expect(verbs.deactivate).toBe('Pause schedule');
		expect(verbs.onLabel).toBe('Armed');
		expect(verbs.offLabel).toBe('Paused');
	});

	it('leaves every other net’s wording exactly as it was', () => {
		const verbs = executionVerbs(cron({ execution_mode: '24/7', schedule: null }));

		expect(verbs.scheduled).toBe(false);
		expect(verbs.activate).toBe('Activate');
		expect(verbs.deactivate).toBe('Deactivate');
		expect(verbs.onLabel).toBe('Active');
		expect(verbs.offLabel).toBe('Idle');
	});

	it('reads armed from the intent, not from whether anything is firing', () => {
		expect(executionVerbs(cron({ desired_state: 'running' })).armed).toBe(true);
		expect(executionVerbs(cron({ desired_state: 'stopped' })).armed).toBe(false);
	});

	it('falls back to the manual wording when there is no net', () => {
		// A toolbar renders before a net is selected; it must not say "Arm".
		expect(executionVerbs(null).activate).toBe('Activate');
		expect(executionVerbs(undefined).armed).toBe(false);
	});
});

describe('scheduleFacts', () => {
	it('says both times, UTC first, for a slot still ahead', () => {
		const facts = scheduleFacts(netSchedule({ next_run_at: '2026-09-05T14:00:00Z' }), NOW);

		expect(facts?.kind).toBe('next');
		expect(facts?.expression).toBe('0 2 * * *');
		// The local half is the reader's timezone, so it is matched rather
		// than spelled: what this pins is that UTC leads and local follows.
		expect(facts?.when).toMatch(/^next run 14:00 UTC · .+ local$/);
		expect(facts?.pending).toBeNull();
	});

	it('dates a slot that is not today’s in UTC', () => {
		const facts = scheduleFacts(netSchedule({ next_run_at: '2026-09-06T02:00:00Z' }), NOW);

		expect(facts?.when).toContain('Sep 6 02:00 UTC');
	});

	it('reports an owed slot as due rather than pointing at tomorrow', () => {
		// `next_run_at` in the past is not a bug: the sweep has not reached
		// the slot, and saying "next run 02:00 tomorrow" would hide that
		// today's has not run.
		const facts = scheduleFacts(netSchedule({ next_run_at: '2026-09-05T02:00:00Z' }), NOW);

		expect(facts?.kind).toBe('due');
		expect(facts?.when).toBe('due since 02:00 UTC');
		expect(facts?.pending).toBeNull();
	});

	it('carries the refusal an owed slot is waiting on', () => {
		const facts = scheduleFacts(netSchedule({
			next_run_at: '2026-09-05T02:00:00Z',
			pending_reason: 'worker_not_ready',
			pending_since: '2026-09-05T02:00:10Z',
		}), NOW);

		expect(facts?.kind).toBe('due');
		expect(facts?.pending?.text).toContain('waiting for worker');
	});

	it('says a paused schedule is paused, and promises no time', () => {
		const facts = scheduleFacts(netSchedule({
			desired_state: 'stopped',
			next_run_at: null,
		}), NOW);

		expect(facts?.kind).toBe('paused');
		expect(facts?.when).toBe('schedule paused');
		expect(facts?.pending).toBeNull();
	});

	it('admits it when the control plane computed no slot for an armed net', () => {
		// An expression that will not parse, or a control plane predating the
		// field. The browser does not own a second cron implementation to
		// answer with instead.
		const facts = scheduleFacts(netSchedule({ next_run_at: null }), NOW);

		expect(facts?.kind).toBe('unknown');
		expect(facts?.when).toContain('unknown');
	});

	it('has nothing to say about a net that is not on a schedule', () => {
		expect(scheduleFacts(netSchedule({ execution_mode: '24/7', schedule: null }), NOW)).toBeNull();
		// Mode without an expression is the same absence of a schedule.
		expect(scheduleFacts(netSchedule({ schedule: null }), NOW)).toBeNull();
		expect(scheduleFacts(null, NOW)).toBeNull();
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

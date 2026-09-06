import type { DailyRollup, LastRun, Net, OpenRun, RunPage, RunRecord } from './api';
import type { RunEvent } from './stores/serverEvents';

/**
 * Reading a net's run record.
 *
 * A *run* is one execution of a net, from whatever asked it to run until it
 * stopped. The control plane keeps three things about it — the run rows, a
 * per-net summary and a per-UTC-day rollup (see the backend's
 * `dev-docs/RUNS_AND_SCHEDULING.md`) — and this module turns those into the
 * labels, colours and pages the UI renders.
 *
 * Two rules shape everything here.
 *
 * **States and reasons are closed sets, so they are looked up, never
 * interpreted.** The server enforces them (`nets/runs.py`): `reason` is a tag
 * capped at 64 characters precisely so a client can switch on it. A colour is
 * therefore only ever chosen from `state`, through the map below, and a tag
 * the map does not know renders as neutral text rather than as a guess. The
 * failure this avoids is a new backend tag — or a worker's prose leaking into
 * a reason — silently painting itself green.
 *
 * **A summary can outlive the history it summarises.** Retention prunes run
 * rows but keeps the outcome on the net's state row, so `LastRun.trigger` and
 * `ended_at` can be null while `state` is set. Nothing here may require a
 * field that retention is allowed to take away.
 *
 * Times are injectable (`now`) so ages are testable rather than
 * clock-dependent, and every absolute stamp keeps its original ISO string in a
 * `title` — the server's times are UTC from the database, and a local
 * rendering that loses that is not diagnosable.
 */

// -- the closed sets, mirrored --
//
// Mirrored rather than fetched: the page still has to render when the control
// plane is unreachable, and that is exactly when it must not invent a state.

export interface RunStateMeta {
	/** Human label. Lower case; the badge does not shout. */
	label: string;
	colour: string;
	/** True while the run is still going: nothing final can be said yet. */
	open: boolean;
}

const UNKNOWN_STATE: RunStateMeta = { label: 'unknown', colour: '#9ca3af', open: false };

const RUN_STATE_META: Record<string, RunStateMeta> = {
	// Open states: a slot claimed by the scheduler, a load in flight, and the
	// execution itself. All three mean "ask again later".
	claimed: { label: 'claimed', colour: '#94a3b8', open: true },
	dispatched: { label: 'dispatched', colour: '#0ea5e9', open: true },
	running: { label: 'running', colour: '#3b82f6', open: true },
	// Terminal states.
	succeeded: { label: 'succeeded', colour: '#22c55e', open: false },
	failed: { label: 'failed', colour: '#ef4444', open: false },
	stopped: { label: 'stopped', colour: '#6b7280', open: false },
	// Deliberately not a failure colour: a skipped slot is a policy decision
	// (the previous run was still going), not something that went wrong.
	skipped: { label: 'skipped', colour: '#a855f7', open: false },
};

/** Label, colour and openness for a run state. Unknown tags stay neutral. */
export function runStateMeta(state: string | null | undefined): RunStateMeta {
	if (!state) return UNKNOWN_STATE;
	return RUN_STATE_META[state] ?? UNKNOWN_STATE;
}

/** The colour for a run state — the only input a colour is ever taken from. */
export function runStateColour(state: string | null | undefined): string {
	return runStateMeta(state).colour;
}

const REASON_LABELS: Record<string, string> = {
	// succeeded
	no_enabled_transitions: 'no enabled transitions',
	// stopped
	user_stop: 'stopped by user',
	unloaded: 'net unloaded',
	// failed
	transition_raised: 'a transition raised',
	subprocess_exited: 'subprocess exited',
	load_failed: 'load failed',
	dispatch_failed: 'dispatch failed',
	worker_lost: 'worker lost',
	abandoned: 'abandoned — no report arrived',
	// skipped
	overlap: 'previous run still going',
	// A person pressed Stop while the slot was claimed or dispatched. Stop
	// pauses the schedule, so the slot is consumed rather than executed — the
	// run is not left open for the abandon sweep to find.
	paused: 'schedule paused',
};

/**
 * Why a pending slot has not been dispatched yet (`net_run_state`).
 *
 * Mirrors `PENDING_REASONS` in the control plane's `nets/runs.py`, which is
 * the declared closed set — exactly `worker_not_ready` and `not_loaded`. A tag
 * added there and not here still renders, as itself.
 */
const PENDING_REASON_LABELS: Record<string, string> = {
	worker_not_ready: 'waiting for worker',
	not_loaded: 'waiting for the net to load',
};

/**
 * Turn a tag into words.
 *
 * An unknown tag is shown as itself with the underscores taken out — it is
 * data, and hiding it would leave a run with no stated reason at all. It is
 * only ever text: no colour, icon or severity is decided from it.
 */
function humanise(tag: string): string {
	return tag.replace(/_/g, ' ').trim();
}

export function reasonLabel(reason: string | null | undefined): string | null {
	if (!reason) return null;
	return REASON_LABELS[reason] ?? humanise(reason);
}

export function pendingReasonLabel(reason: string | null | undefined): string | null {
	if (!reason) return null;
	return PENDING_REASON_LABELS[reason] ?? humanise(reason);
}

const TRIGGER_LABELS: Record<string, string> = {
	manual: 'manual',
	schedule: 'schedule',
	resume: 'resume',
};

export function triggerLabel(trigger: string | null | undefined): string {
	// Null is a real answer here, not a missing one: retention deletes the run
	// row while the outcome survives on the state row.
	if (!trigger) return 'unknown';
	return TRIGGER_LABELS[trigger] ?? humanise(trigger);
}

// -- formatting --

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A run's wall-clock duration, or null when it has not ended. */
export function formatDuration(seconds: number | null | undefined): string | null {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
	const s = Math.max(0, seconds);
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	if (s < 3600) {
		const m = Math.floor(s / 60);
		return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
	}
	const h = Math.floor(s / 3600);
	return `${h}h ${String(Math.floor((s - h * 3600) / 60)).padStart(2, '0')}m`;
}

/** How long ago, at one significant unit: `12s`, `4m`, `3h`, `2d`. */
export function formatElapsed(iso: string | null | undefined, now = Date.now()): string | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	const ms = Math.max(0, now - t);
	if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
	if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
	if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
	return `${Math.floor(ms / DAY)}d`;
}

export interface Stamp {
	text: string;
	/** The server's own ISO string, kept so a local rendering stays traceable. */
	title: string;
}

/**
 * An absolute time for the reader's own timezone, with the source ISO in the
 * tooltip. Times within the day show only the clock, older ones the date too —
 * a run history is scanned, and the date repeated on forty rows is noise.
 */
export function formatStamp(iso: string | null | undefined, now = Date.now()): Stamp | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	const d = new Date(t);
	const clock = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	if (now - t < DAY && new Date(now).getDate() === d.getDate()) {
		return { text: clock, title: iso };
	}
	const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	return { text: `${date} ${clock}`, title: iso };
}

const MONTHS = [
	'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * A time in UTC, said in UTC.
 *
 * Schedules are UTC by policy, so a cron slot rendered in the reader's own
 * timezone is a different number from the one in the net's decorator, and the
 * two would have to be reconciled by hand every time. The date is added only
 * when the slot is not today's, so the common case stays short.
 */
export function formatUtcStamp(iso: string | null | undefined, now = Date.now()): Stamp | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	const d = new Date(t);
	const clock = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
	const today = new Date(now);
	const sameDay = d.getUTCFullYear() === today.getUTCFullYear()
		&& d.getUTCMonth() === today.getUTCMonth()
		&& d.getUTCDate() === today.getUTCDate();
	return {
		text: sameDay ? clock : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${clock}`,
		title: iso,
	};
}

// -- per-net summaries, for the nets list --

export interface RunBadge {
	label: string;
	colour: string;
	/** The reason, as words. Shown beside the badge, never inside a colour. */
	detail: string | null;
	title: string;
}

/**
 * The last-run badge for a net, or null when the net has never run.
 *
 * Null is the honest answer for a net with no run state: the state row is
 * created by the first run, so its absence says "nothing has happened yet",
 * and a badge saying anything at all would be an invention.
 */
export function lastRunBadge(lastRun: LastRun | null | undefined, now = Date.now()): RunBadge | null {
	if (!lastRun || !lastRun.state) return null;
	const meta = runStateMeta(lastRun.state);
	const detail = reasonLabel(lastRun.reason);
	const age = formatElapsed(lastRun.ended_at, now);
	const took = formatDuration(lastRun.duration_s);
	const parts = [`last run: ${meta.label}`];
	if (detail) parts.push(detail);
	// Timings come from the run row and are gone once retention prunes it,
	// while the outcome above survives on the state row. Each is added only if
	// it is actually there, so an old run still gets a badge and a tooltip.
	if (took) parts.push(`took ${took}`);
	// A skipped slot never ran, so it did not end. Its `ended_at` is when the
	// control plane consumed the slot, which is a different event.
	if (age) parts.push(`${lastRun.state === 'skipped' ? 'skipped' : 'ended'} ${age} ago`);
	if (lastRun.trigger) parts.push(`triggered ${triggerLabel(lastRun.trigger)}`);
	return { label: meta.label, colour: meta.colour, detail, title: parts.join(' · ') };
}

/**
 * The last run, said in words rather than shown as a badge.
 *
 * For when something is executing now. A bare `stopped` pill beside "running
 * since 00:38 (10h)" is not a smaller version of the same fact, it is a
 * contradiction: the first production screenshot of the panel read "running
 * since 00:38 (10h) · step 732 · 2m ago  [stopped] stopped by user", and the
 * question it produced was whether the net was running or stopped. Labelled
 * and demoted to text, the same fact answers that instead of raising it.
 *
 * The state is left out when the reason already opens with it — "stopped ·
 * stopped by user" says it twice — which is what makes the common case read
 * as "previous run: stopped by user · 6m 09s".
 */
export function previousRunLabel(
	lastRun: LastRun | null | undefined,
	now = Date.now(),
): Stamp | null {
	const badge = lastRunBadge(lastRun, now);
	if (!badge || !lastRun) return null;
	const parts = badge.detail && badge.detail.startsWith(badge.label)
		? [badge.detail]
		: [badge.label, ...(badge.detail ? [badge.detail] : [])];
	const took = formatDuration(lastRun.duration_s);
	if (took) parts.push(took);
	return { text: `previous run: ${parts.join(' · ')}`, title: badge.title };
}

/**
 * What a net's header says about its runs: one of three presentations.
 *
 * The decision lives here rather than in each template because it is the same
 * decision in both places, and because getting it wrong is not a styling slip
 * — it is showing a live run and a closed one as equals. A net with something
 * open has no bare badge at all; the type makes that unrepresentable.
 */
export type RunHeadline =
	| { kind: 'open'; open: Stamp; previous: Stamp | null }
	| { kind: 'last'; badge: RunBadge }
	| { kind: 'none' };

export function runHeadline(
	net: Pick<Net, 'open_run' | 'last_run'>,
	now = Date.now(),
): RunHeadline {
	const open = openRunLabel(net, now);
	if (open) return { kind: 'open', open, previous: previousRunLabel(net.last_run, now) };
	const badge = lastRunBadge(net.last_run, now);
	return badge ? { kind: 'last', badge } : { kind: 'none' };
}

/**
 * True when this net is executing *right now*.
 *
 * Read from the open run, and from nothing else. The tempting inference —
 * loaded, and desired-running — is wrong for precisely the net that matters:
 * a one-shot net that has drained sits loaded and desired-running while doing
 * nothing at all, which is what the daily pipeline does for twenty-three hours
 * a day. Only an open run in `running` means work is happening.
 */
export function netIsRunning(net: Pick<Net, 'open_run'>): boolean {
	return net.open_run?.state === 'running';
}

/**
 * What the net's open run is, in words, or null when nothing is open.
 *
 * A run that is `claimed` or `dispatched` is armed, not working: the slot has
 * been taken and the load issued, but nothing is firing yet, and calling that
 * "running" would put a working net and a waiting one in the same words.
 */
export function openRunLabel(net: Pick<Net, 'open_run'>, now = Date.now()): Stamp | null {
	const open = net.open_run;
	if (!open) return null;
	const meta = runStateMeta(open.state);
	const trigger = `${triggerLabel(open.trigger)} run`;
	// Rendered in UTC because schedules are UTC by policy: a slot shown in the
	// reader's timezone is a different number from the one in the decorator.
	const slot = formatUtcStamp(open.scheduled_for, now);
	const slotTitle = slot ? ` for the slot at ${slot.title}` : '';

	if (open.state === 'running') {
		const since = formatStamp(open.started_at, now);
		const elapsed = formatElapsed(open.started_at, now);
		return since && elapsed
			? {
				text: `running since ${since.text} (${elapsed})`,
				title: `${trigger} started ${since.title}${slotTitle}`,
			}
			: {
				text: 'running',
				title: `${trigger}; the worker has not reported when it started${slotTitle}`,
			};
	}

	// Armed but not executing: the slot is claimed and the load may be in
	// flight, but nothing is firing, and `started_at` stays null until it is.
	// The wait is measured from `created_at`, which is the moment the run row
	// was written — a claim that is not moving is the thing worth seeing.
	// Named by what asked for it, because Run now dispatches the same way the
	// scheduler does: calling a hand-pressed rerun "scheduled" would send a
	// reader looking for a cron expression that does not exist.
	const waiting = formatElapsed(open.created_at, now);
	const parts = [
		open.state === 'claimed' || open.state === 'dispatched'
			? (open.trigger === 'schedule' ? 'scheduled run pending' : 'run pending')
			: `run open (${meta.label})`,
	];
	if (waiting) parts.push(`since ${waiting}`);
	const text = slot ? `${parts.join(' ')} · for the ${slot.text} slot` : parts.join(' ');
	return {
		text,
		title: `${trigger} is ${meta.label} since ${open.created_at}${slotTitle}`,
	};
}

/**
 * How long since the worker last reported this net firing.
 *
 * Only while a run is open *and* running. On an idle net the same age is just
 * the time since it last did anything, which the last-run badge already says,
 * and showing it as "progress" would suggest something is still happening. A
 * running net that has reported nothing says so rather than saying nothing —
 * "when did it stop" is the whole question for a hang.
 */
export function progressLabel(
	net: Pick<Net, 'open_run' | 'step_count' | 'last_progress_at'>,
	now = Date.now(),
): Stamp | null {
	if (!netIsRunning(net)) return null;
	const age = formatElapsed(net.last_progress_at, now);
	const step = net.step_count ?? null;
	if (age === null) {
		return step === null
			? { text: 'no progress reported', title: 'The worker has not reported a firing for this net yet.' }
			: { text: `step ${step}`, title: 'The worker has not reported when this net last fired.' };
	}
	const text = step === null ? `fired ${age} ago` : `step ${step} · ${age} ago`;
	return { text, title: `Last firing reported ${net.last_progress_at}` };
}

/**
 * The pre-dispatch refusal a net is currently sitting on, as text.
 *
 * This lives on the state row rather than on a run, because a slot that waits
 * an hour must cost one overwritten row and not sixty. It is therefore a
 * *current* condition, and it is shown with the time it started so a wait that
 * is not moving is visible as a wait that is not moving.
 */
export function pendingLabel(
	net: Pick<Net, 'pending_reason' | 'pending_since'>,
	now = Date.now(),
): Stamp | null {
	const label = pendingReasonLabel(net.pending_reason);
	if (!label) return null;
	const since = formatStamp(net.pending_since, now);
	const elapsed = formatElapsed(net.pending_since, now);
	if (!since) return { text: label, title: label };
	return {
		text: `${label} since ${since.text}`,
		title: elapsed ? `${label} for ${elapsed} (since ${since.title})` : `${label} since ${since.title}`,
	};
}

// -- the schedule --
//
// A cron net's controls are the same two requests every other net's are —
// start and stop — but they mean a different thing, and "Activate" said about
// a net that will do nothing for another nine hours is how a person concludes
// the button did not work. Stop pauses the schedule and Start arms it (the
// backend's `dev-docs/RUNS_AND_SCHEDULING.md`, decision 7), so on a cron net
// that is what the words say, and the state they describe is the *intent*
// (`desired_state`) rather than whether something happens to be firing right
// now — an armed daily net is idle for twenty-three hours a day and is not
// thereby paused.

/** The `execution_mode` a scheduled net carries; the platform's `MODES`. */
export const CRON_MODE = 'cron';

export interface ExecutionVerbs {
	/** True when this net runs on a schedule rather than by hand. */
	scheduled: boolean;
	/** The intent, from `desired_state`. For a cron net: armed. */
	armed: boolean;
	/** The button that turns execution on, and its label while in flight. */
	activate: string;
	activating: string;
	/** The button that turns it off. */
	deactivate: string;
	deactivating: string;
	/** The status pill, in each of its two states. */
	onLabel: string;
	offLabel: string;
	activateTitle: string;
	deactivateTitle: string;
}

const MANUAL_VERBS = {
	activate: 'Activate',
	activating: 'Activating…',
	deactivate: 'Deactivate',
	deactivating: 'Deactivating…',
	onLabel: 'Active',
	offLabel: 'Idle',
	activateTitle:
		'Run continuously on the worker. Keeps running even if you close this window; reopen the net to observe it again.',
	deactivateTitle: 'Stop continuous execution on the worker.',
} as const;

const SCHEDULE_VERBS = {
	activate: 'Arm schedule',
	activating: 'Arming…',
	deactivate: 'Pause schedule',
	deactivating: 'Pausing…',
	onLabel: 'Armed',
	offLabel: 'Paused',
	activateTitle:
		'Arm the schedule: each slot from now on runs this net, and the resume sweep re-arms it after a worker reboot.',
	deactivateTitle:
		'Pause the schedule: no slot fires until it is armed again. A slot already claimed is recorded as skipped rather than run.',
} as const;

/**
 * What this net's on/off control is called, and what its two states are.
 *
 * One helper rather than a conditional in each template, because it is one
 * decision made in several places and getting it inconsistent is worse than
 * getting it wrong: a button that says Deactivate above a pill that says
 * Armed is two claims about the same thing.
 */
export function executionVerbs(
	net: Pick<Net, 'execution_mode' | 'desired_state'> | null | undefined,
): ExecutionVerbs {
	const scheduled = net?.execution_mode === CRON_MODE;
	return {
		scheduled,
		armed: net?.desired_state === 'running',
		...(scheduled ? SCHEDULE_VERBS : MANUAL_VERBS),
	};
}

/**
 * What a cron net's schedule is doing, as one line beside its controls.
 *
 * * `next` — armed, with a slot ahead of it.
 * * `due` — the slot at or before now is still owed. `next_run_at` is
 *   deliberately allowed to be in the past for exactly this, and it is the
 *   case worth seeing: the sweep has not reached the slot yet, or something
 *   is in its way, which `pending` says.
 * * `paused` — Stop was pressed. No slot fires, and the server sends no
 *   `next_run_at` at all rather than a time that will not happen.
 * * `unknown` — armed, but the server computed no slot: an expression that
 *   will not parse, or a control plane that predates the field. Saying so is
 *   the only honest answer; inventing one from the expression here would put
 *   a second cron implementation in the browser.
 */
export type ScheduleKind = 'next' | 'due' | 'paused' | 'unknown';

export interface ScheduleFacts {
	/** The expression as the net's code declares it, shown as code. */
	expression: string;
	kind: ScheduleKind;
	/** The one line: "next run 02:00 UTC · 03:00 local", "due since …". */
	when: string;
	title: string;
	/**
	 * The pre-dispatch refusal, when a due slot is waiting on one. Carried
	 * here rather than left to the caller so that "due since 02:00 UTC" and
	 * "waiting for worker since 02:00" are one statement and not two
	 * unrelated notes that happen to sit near each other.
	 */
	pending: Stamp | null;
}

type ScheduleFields = Pick<
	Net, 'execution_mode' | 'schedule' | 'desired_state' | 'next_run_at'
	| 'pending_reason' | 'pending_since'
>;

export function scheduleFacts(
	net: ScheduleFields | null | undefined,
	now = Date.now(),
): ScheduleFacts | null {
	if (!net || net.execution_mode !== CRON_MODE || !net.schedule) return null;
	const expression = net.schedule;

	if (net.desired_state !== 'running') {
		return {
			expression,
			kind: 'paused',
			when: 'schedule paused',
			title: `${expression} — paused. Arm the schedule to run it again.`,
			pending: null,
		};
	}

	// Both renderings, UTC first: the expression is UTC by policy, so the UTC
	// time is the one that can be checked against the decorator, and the local
	// one is what says whether it is the middle of the reader's night.
	const utc = formatUtcStamp(net.next_run_at, now);
	const local = formatStamp(net.next_run_at, now);
	if (!utc || !local || !net.next_run_at) {
		return {
			expression,
			kind: 'unknown',
			when: 'armed · next run unknown',
			title: `${expression} — armed, but the control plane computed no next run for it.`,
			pending: pendingLabel(net, now),
		};
	}

	if (Date.parse(net.next_run_at) <= now) {
		return {
			expression,
			kind: 'due',
			when: `due since ${utc.text}`,
			title: `The ${utc.title} slot is owed and has not run yet.`,
			pending: pendingLabel(net, now),
		};
	}

	return {
		expression,
		kind: 'next',
		when: `next run ${utc.text} · ${local.text} local`,
		title: `${expression} — next run ${utc.title}`,
		pending: null,
	};
}

// -- live updates --
//
// A run event carries the whole transition — id, trigger, state, reason and
// the three timestamps — so the summary a list row shows can be updated from
// the event itself instead of waiting on the refetch it triggers. The refetch
// stays authoritative: this only closes the gap between "the run ended" and
// "the row that says so has arrived", which is the second or two in which a
// user watching a net they just stopped sees nothing change.

function durationBetween(start: string | null, end: string | null): number | null {
	if (!start || !end) return null;
	const from = Date.parse(start);
	const to = Date.parse(end);
	if (Number.isNaN(from) || Number.isNaN(to)) return null;
	return Math.max(0, (to - from) / 1000);
}

/**
 * Apply one run event to the net it is about, returning a new net.
 *
 * Events for other nets are returned unchanged, so a caller can map the whole
 * list without filtering first. A close only clears `open_run` when it is
 * closing *that* run: a late event about an older run must not make a net that
 * is currently executing look idle.
 */
export function applyRunEvent<T extends Pick<Net, 'id' | 'last_run' | 'open_run' | 'last_success_at' | 'pending_reason' | 'pending_since'>>(
	net: T,
	event: RunEvent,
): T {
	if (event.net_id !== net.id) return net;

	if (event.type === 'net_run_started') {
		const open: OpenRun = {
			id: event.run_id,
			trigger: event.trigger,
			state: event.state,
			// The event's own `created_at` when it has one. An older control
			// plane omits it, and for a run that has just started `started_at`
			// is the same instant to any reader; the refetch replaces it either
			// way. Never left unset, because the armed-run wait is measured
			// from this field.
			created_at: event.created_at ?? event.started_at ?? new Date().toISOString(),
			started_at: event.started_at,
			scheduled_for: event.scheduled_for,
		};
		// A started run answers whatever pre-dispatch refusal was pending —
		// the same thing `open_run` does on the state row.
		return { ...net, open_run: open, pending_reason: null, pending_since: null };
	}

	const closed: LastRun = {
		id: event.run_id,
		trigger: event.trigger,
		state: event.state,
		reason: event.reason,
		started_at: event.started_at,
		ended_at: event.ended_at,
		duration_s: durationBetween(event.started_at, event.ended_at),
	};
	const stillOpen = net.open_run && net.open_run.id !== event.run_id ? net.open_run : null;
	return {
		...net,
		open_run: stillOpen,
		last_run: closed,
		last_success_at: event.state === 'succeeded'
			? (event.ended_at ?? net.last_success_at ?? null)
			: (net.last_success_at ?? null),
	};
}

// -- run history paging --
//
// The cursor is a run's own `created_at`, not an offset, so runs closing or
// being pruned underneath a reader cannot make a page skip or repeat one. The
// only two things that ever happen to a held history are "the user asked for
// more" and "a live event says the newest page changed", and each has exactly
// one function below. Both merge by run id, because the same run legitimately
// appears twice — once open, once closed — when a refresh crosses a close.

export interface RunHistory {
	/** Newest first, as the server returns them. */
	runs: RunRecord[];
	/** Cursor for the next (older) page; null when the history is exhausted. */
	nextBefore: string | null;
}

export function emptyRunHistory(): RunHistory {
	return { runs: [], nextBefore: null };
}

/** True while there is an older page to fetch. */
export function hasMoreRuns(history: RunHistory): boolean {
	return history.nextBefore !== null;
}

function replaceById(runs: RunRecord[], incoming: Map<string, RunRecord>): RunRecord[] {
	return runs.map((run) => incoming.get(run.id) ?? run);
}

/**
 * Add an older page, fetched with `history.nextBefore`.
 *
 * The incoming page is the newer read, so where it repeats a run it wins; and
 * its own `next_before` becomes the cursor, which is what stops the "load
 * more" button once the server says there is nothing older.
 */
export function appendRunPage(history: RunHistory, page: RunPage): RunHistory {
	const incoming = new Map(page.runs.map((run) => [run.id, run]));
	const held = new Set(history.runs.map((run) => run.id));
	return {
		runs: [
			...replaceById(history.runs, incoming),
			...page.runs.filter((run) => !held.has(run.id)),
		],
		nextBefore: page.next_before ?? null,
	};
}

/**
 * Fold a freshly fetched *first* page into a history that may already have
 * older pages loaded.
 *
 * Used when a run event arrives: the newest page is refetched and merged, so
 * a live update neither discards the pages the reader has already asked for
 * nor duplicates the ones it repeats. The cursor is deliberately left alone
 * unless nothing was held — it points past the oldest run in hand, and the
 * first page cannot have moved that.
 */
export function refreshRunHistory(history: RunHistory, page: RunPage): RunHistory {
	if (history.runs.length === 0) {
		return { runs: [...page.runs], nextBefore: page.next_before ?? null };
	}
	const incoming = new Map(page.runs.map((run) => [run.id, run]));
	const held = new Set(history.runs.map((run) => run.id));
	return {
		// New runs are newer than everything held, and arrive newest first.
		runs: [
			...page.runs.filter((run) => !held.has(run.id)),
			...replaceById(history.runs, incoming),
		],
		nextBefore: history.nextBefore,
	};
}

// -- the daily bar --

export const DAILY_WINDOW_DAYS = 30;

/** The four terminal outcomes a day is counted in, in stacking order. */
export const DAILY_SEGMENT_STATES = ['succeeded', 'failed', 'stopped', 'skipped'] as const;

export type DailySegmentState = (typeof DAILY_SEGMENT_STATES)[number];

export interface DailySegment {
	state: DailySegmentState;
	count: number;
	colour: string;
}

export interface DailyBar {
	day: string;
	/** 1-based position in the window, so a day with no row leaves a gap. */
	column: number;
	total: number;
	segments: DailySegment[];
	title: string;
}

export interface DailyChart {
	bars: DailyBar[];
	/** Columns in the window — the axis, not the number of bars. */
	columns: number;
	/** Busiest day in the window; the scale. Zero when there is nothing. */
	max: number;
	/** The window's own bounds as UTC dates, so the axis can be labelled. */
	startDay: string;
	endDay: string;
}

function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnight(iso: string): number {
	// `day` is a UTC date (`YYYY-MM-DD`); `Date.parse` reads that as UTC.
	return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function utcToday(now: number): number {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Lay the rollups out on a UTC-day axis.
 *
 * The endpoint omits days on which nothing ran, and that omission is
 * information: a net that ran daily until Tuesday and has not run since must
 * look different from one that runs twice a week. So bars are placed by their
 * `day`'s distance from the start of the window rather than by their position
 * in the array, and a day with no row is a gap rather than a zero-height bar.
 * Rows outside the window are dropped rather than clamped onto its edge.
 */
export function dailyChart(
	rollups: DailyRollup[],
	options: { days?: number; now?: number } = {},
): DailyChart {
	const days = Math.max(1, options.days ?? DAILY_WINDOW_DAYS);
	const now = options.now ?? Date.now();
	const windowStart = utcToday(now) - (days - 1) * DAY;

	const bars: DailyBar[] = [];
	let max = 0;
	for (const rollup of rollups) {
		const midnight = utcMidnight(rollup.day);
		if (Number.isNaN(midnight)) continue;
		const column = Math.round((midnight - windowStart) / DAY) + 1;
		if (column < 1 || column > days) continue;
		const segments = DAILY_SEGMENT_STATES
			.map((state) => ({ state, count: rollup[state], colour: runStateColour(state) }))
			.filter((segment) => segment.count > 0);
		const total = segments.reduce((sum, segment) => sum + segment.count, 0);
		if (total > max) max = total;
		bars.push({
			day: rollup.day,
			column,
			total,
			segments,
			title: dailyTitle(rollup, segments),
		});
	}
	return {
		bars,
		columns: days,
		max,
		startDay: utcDay(windowStart),
		endDay: utcDay(windowStart + (days - 1) * DAY),
	};
}

function dailyTitle(rollup: DailyRollup, segments: DailySegment[]): string {
	const counts = segments.map((segment) => `${segment.count} ${segment.state}`);
	const parts = [`${rollup.day} (UTC)`, `${rollup.runs} run${rollup.runs === 1 ? '' : 's'}`];
	if (counts.length > 0) parts.push(counts.join(', '));
	const longest = formatDuration(rollup.duration_max_s);
	if (longest) parts.push(`longest ${longest}`);
	if (rollup.steps_total > 0) parts.push(`${rollup.steps_total} steps`);
	return parts.join(' · ');
}

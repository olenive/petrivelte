/**
 * What a notebook load is doing, reduced from the worker's event stream.
 *
 * A cold notebook is ~50s of spawn plus ~24s of asset burst, and until this
 * existed the page showed one static string for all of it. The spawn is ~99%
 * of that time and used to report nothing at all, so silence was the only
 * signal a user ever got — indistinguishable from a hang.
 *
 * Pure on purpose. Everything here is `(state, event) => state` over plain
 * data, so the orderings that actually go wrong in production — events
 * arriving late, twice, or not at all — are table-testable without a browser,
 * a worker, or a 50-second wait.
 */

import type { NotebookLoadEvent, NotebookTimings } from '$lib/api';

/** The checklist, in the order a load actually moves through it. */
export const STEP_ORDER = [
	'download',
	'extract',
	'dependencies',
	'spawn',
	'import_marimo',
	'build_app',
	'serve',
	'assets'
] as const;

export type StepName = (typeof STEP_ORDER)[number];

/** Plain language. The user is not debugging our worker. */
const STEP_LABELS: Record<StepName, string> = {
	download: 'Downloading code',
	extract: 'Extracting code',
	dependencies: 'Installing dependencies',
	spawn: 'Starting notebook subprocess',
	import_marimo: 'Importing Marimo',
	build_app: 'Building notebook app',
	serve: 'Starting notebook server',
	assets: 'Loading editor assets'
};

/**
 * `pending` and `active` are not cosmetic variants of each other: an active
 * step ticks, and a ticking number is the difference between "working" and
 * "hung" when a step legitimately takes 30 seconds with nothing to report.
 */
export type StepState = 'pending' | 'active' | 'done' | 'failed';

export interface Step {
	name: StepName;
	label: string;
	state: StepState;
	/** Seconds the step took, once known. */
	elapsed_s: number | null;
	/** Live fraction, only where a denominator honestly exists. */
	fraction: { done: number; total: number | null } | null;
}

export interface LoadProgress {
	steps: Step[];
	log: string[];
	/** The step to name in the headline, or null when nothing is running. */
	current: StepName | null;
	/** Set when the load failed outright; the reason is the only actionable part. */
	failure: string | null;
	done: boolean;
}

/** Bounded so a chatty notebook cannot grow the page without limit. */
export const MAX_LOG_LINES = 500;

export function emptyProgress(): LoadProgress {
	return {
		steps: STEP_ORDER.map((name) => ({
			name,
			label: STEP_LABELS[name],
			state: 'pending' as StepState,
			elapsed_s: null,
			fraction: null
		})),
		log: [],
		current: null,
		failure: null,
		done: false
	};
}

function withStep(
	progress: LoadProgress,
	name: StepName,
	patch: Partial<Step>
): LoadProgress {
	return {
		...progress,
		steps: progress.steps.map((step) => (step.name === name ? { ...step, ...patch } : step))
	};
}

function isStep(name: string): name is StepName {
	return (STEP_ORDER as readonly string[]).includes(name);
}

/**
 * Fold one event into the load's state.
 *
 * Unknown steps are ignored rather than appended. The checklist is a fixed,
 * ordered thing a person reads top to bottom; a worker that learns to emit a
 * new step should have it added here deliberately, not have it appear as a
 * mystery row in an order nobody chose.
 */
export function reduceLoadEvent(progress: LoadProgress, event: NotebookLoadEvent): LoadProgress {
	if (event.kind === 'log') {
		const text = String(event.data?.text ?? '');
		if (!text) return progress;
		const log = [...progress.log, text];
		return { ...progress, log: log.slice(-MAX_LOG_LINES) };
	}

	if (event.kind !== 'load_progress') return progress;

	const step = String(event.data?.step ?? '');

	if (step === 'failed') {
		const failure = String(event.data?.message ?? 'The notebook failed to load.');
		const active = progress.current;
		const failed = active ? withStep(progress, active, { state: 'failed' }) : progress;
		return { ...failed, failure, done: true };
	}

	if (step === 'ready') {
		return {
			...progress,
			steps: progress.steps.map((s) =>
				// `assets` is owned by the burst counter, not by the worker: the
				// subprocess is serving before the browser has finished fetching.
				s.state === 'active' && s.name !== 'assets' ? { ...s, state: 'done' } : s
			),
			current: null,
			done: true
		};
	}

	if (!isStep(step)) return progress;

	const elapsed = typeof event.data?.elapsed_s === 'number' ? event.data.elapsed_s : null;
	// A `done` marker for a step we never saw start still completes it — events
	// can be missed, and a checklist row stuck on "pending" beside later rows
	// that finished is a worse lie than one that simply caught up.
	const finished = event.data?.done === true;

	let next = withStep(progress, step, {
		state: finished ? 'done' : 'active',
		elapsed_s: elapsed ?? progress.steps.find((s) => s.name === step)?.elapsed_s ?? null
	});

	// Anything earlier in the order that is still pending when a later step
	// reports has, by definition, already happened.
	const index = STEP_ORDER.indexOf(step);
	next = {
		...next,
		steps: next.steps.map((s, i) =>
			i < index && s.state === 'pending' ? { ...s, state: 'done' } : s
		)
	};

	return { ...next, current: finished ? null : step };
}

/**
 * Fold the asset burst in from the timings poll.
 *
 * Kept separate from the event stream because it comes from a different place
 * and means a different thing. The notebook subprocess sets `access_log=False`,
 * so it says nothing at all while the browser fetches ~228 lazily imported
 * chunks — the whole second half of the wait. Without this the panel would go
 * silent exactly when the user is still waiting, which reads as a crash.
 */
export function applyBurst(progress: LoadProgress, timings: NotebookTimings | null): LoadProgress {
	const open = timings?.burst_progress;
	if (open) {
		return {
			...withStep(progress, 'assets', {
				state: 'active',
				fraction: { done: open.count, total: open.expected }
			}),
			current: 'assets',
			done: false
		};
	}
	const settled = timings?.burst;
	if (settled && !timings?.burst_in_progress) {
		const assets = progress.steps.find((s) => s.name === 'assets');
		if (assets?.state === 'active') {
			return {
				...withStep(progress, 'assets', {
					state: 'done',
					elapsed_s: settled.wall_s,
					fraction: { done: settled.count, total: settled.count }
				}),
				current: null
			};
		}
	}
	return progress;
}

/**
 * What this notebook's own last load took, as an expectation.
 *
 * Deliberately not a constant: a hardcoded "usually 50s" rots, and is wrong
 * for every notebook whose dependencies differ. Null when we have never seen
 * this notebook load, in which case the caller must say nothing rather than
 * guess.
 */
export function expectedSeconds(timings: NotebookTimings | null): number | null {
	const total = timings?.load?.total_s;
	if (typeof total !== 'number' || total <= 0) return null;
	const burst = timings?.burst?.wall_s;
	return typeof burst === 'number' ? total + burst : total;
}

/**
 * The headline: what is happening, and whether it is taking longer than usual.
 *
 * Never a percentage of the whole. Nothing knows how far through an import
 * chain it is, and a bar stalled at 90% is worse than an honest counter.
 */
export function headline(
	progress: LoadProgress,
	elapsedSeconds: number,
	expected: number | null
): { title: string; detail: string | null } {
	if (progress.failure) {
		return { title: 'The notebook failed to load', detail: progress.failure };
	}
	const step = progress.steps.find((s) => s.name === progress.current);
	const title = step ? step.label : 'Starting notebook';
	if (expected !== null && elapsedSeconds > expected * 1.5) {
		return { title, detail: `longer than usual (${Math.round(elapsedSeconds)}s)` };
	}
	if (expected !== null) {
		return { title, detail: `usually about ${Math.round(expected)}s` };
	}
	return { title, detail: null };
}

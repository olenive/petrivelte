/**
 * Slow operations, as the pages show them.
 *
 * The control plane records every slow operation (a net load, a notebook
 * load, a deployment being prepared) with its current step and a heartbeat,
 * and publishes each change on the event stream. That record is what lets a
 * page say "busy installing dependencies for 40 s, last heard from 2 s ago"
 * where it used to see only silence, and silence is what made the notebook
 * page remount a worker that was merely busy.
 *
 * Two jobs live here, both pure. The first folds operation events into a book
 * of what is running, which a page combines with what its last REST response
 * reported. The second turns one operation into the words and ages the
 * operations component renders, so the rendering can be asserted as a table.
 */

import type { Operation, OperationState, OperationSubjectKind, OperationSummary } from './api';

// -- words ------------------------------------------------------------------

const KIND_LABELS: Record<string, string> = {
	net_load: 'Loading net',
	net_unload: 'Unloading net',
	notebook_load: 'Loading notebook',
	deployment_prepare: 'Preparing deployment',
};

/** Plain language for the steps the worker reports. The user is not
 *  debugging the worker, so a known step reads as what it is doing. */
const STEP_LABELS: Record<string, string> = {
	download: 'downloading code',
	extract: 'extracting code',
	dependencies: 'installing dependencies',
	spawn: 'starting subprocess',
	import_marimo: 'importing Marimo',
	build_app: 'building notebook app',
	serve: 'starting notebook server',
	ready: 'ready',
	unload: 'unloading',
	load: 'loading',
	start: 'starting',
};

const STATE_LABELS: Record<OperationState, string> = {
	running: 'running',
	succeeded: 'done',
	failed: 'failed',
	abandoned: 'lost contact',
};

/** A kind this build has not heard of renders by its own name. */
export function kindLabel(kind: string): string {
	return KIND_LABELS[kind] ?? kind.replaceAll('_', ' ');
}

export function stepLabel(step: string | null | undefined): string | null {
	const trimmed = step?.trim();
	if (!trimmed) return null;
	return STEP_LABELS[trimmed] ?? trimmed.replaceAll('_', ' ');
}

/** Seconds from an ISO instant to `nowMs`, or null when it does not parse.
 *  Compared as instants, never as text. */
export function secondsSince(iso: string | null | undefined, nowMs: number): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	return Math.max(0, (nowMs - t) / 1000);
}

/** `42s`, `3m 05s`, `1h 02m`: precise enough to see a number move. */
export function formatDuration(seconds: number): string {
	const s = Math.floor(seconds);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
	return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export interface OperationView {
	id: string;
	/** `Loading notebook` */
	kind: string;
	/** `installing dependencies`, or null before the first step. */
	step: string | null;
	message: string | null;
	state: OperationState;
	stateLabel: string;
	running: boolean;
	/** Since `started_at`; for a finished operation, how long it took. */
	elapsed: string | null;
	/** Since `heartbeat_at`, while running; null once finished. */
	heartbeat: string | null;
	/** Kind and step in one phrase, for a badge or a one-line row. */
	headline: string;
	error: string | null;
	/** Everything above, one fact per line, for a tooltip. */
	title: string;
}

function isFull(op: Operation | OperationSummary): op is Operation {
	return 'state' in op;
}

/**
 * One operation, as words and ages.
 *
 * A summary (what a net or notebook response carries) is always a running
 * operation, so it reads as one. Ages are measured to `nowMs`, which the
 * caller ticks; a running operation's elapsed time grows with it, and a
 * finished one's is fixed at `finished_at`.
 */
export function operationView(op: Operation | OperationSummary, nowMs: number): OperationView {
	const state: OperationState = isFull(op) ? op.state : 'running';
	const running = state === 'running';
	const finishedAt = isFull(op) && op.finished_at ? Date.parse(op.finished_at) : NaN;
	const until = !running && !Number.isNaN(finishedAt) ? finishedAt : nowMs;
	const elapsedS = secondsSince(op.started_at, until);
	const heartbeatS = running ? secondsSince(op.heartbeat_at, nowMs) : null;
	const kind = kindLabel(op.kind);
	const step = stepLabel(op.step);
	const message = op.step_message?.trim() || null;
	const error = isFull(op) ? op.error : null;
	const headline = step ? `${kind}: ${step}` : kind;
	const lines = [
		headline,
		message,
		elapsedS === null ? null : `${running ? 'running for' : 'took'} ${formatDuration(elapsedS)}`,
		heartbeatS === null ? null : `last heard from ${formatDuration(heartbeatS)} ago`,
		running ? null : `state: ${STATE_LABELS[state]}`,
		error,
		`trigger: ${op.trigger}`,
	].filter((line): line is string => line !== null);
	return {
		id: op.id,
		kind,
		step,
		message,
		state,
		stateLabel: STATE_LABELS[state],
		running,
		elapsed: elapsedS === null ? null : formatDuration(elapsedS),
		heartbeat: heartbeatS === null ? null : formatDuration(heartbeatS),
		headline,
		error,
		title: lines.join('\n'),
	};
}

// -- the book of running operations -------------------------------------

/**
 * What the event stream has said about operations since the page opened.
 *
 * `finished` remembers the ids that have ended, so a REST response read just
 * before the finish (a sync report, a net list) cannot bring a finished
 * operation back. Bounded: a page left open for days sees many operations,
 * and only the recent ones can still be racing a response.
 */
export interface OperationBook {
	running: Operation[];
	finished: string[];
}

export const MAX_FINISHED_IDS = 200;

export function emptyBook(): OperationBook {
	return { running: [], finished: [] };
}

/** The fields of an operation event that fold into the book. */
export type OperationEventLike = Operation & { type?: string };

/**
 * Fold one operation event into the book.
 *
 * Idempotent and order-tolerant: a replayed event changes nothing, and a
 * progress event arriving after the finish (the stream replays missed events
 * on reconnect) is ignored rather than resurrecting the operation.
 */
export function applyOperationEvent(book: OperationBook, event: OperationEventLike): OperationBook {
	const op = pickOperation(event);
	const ended = event.type === 'operation_finished' || op.state !== 'running';
	const others = book.running.filter((o) => o.id !== op.id);
	if (ended) {
		const finished = book.finished.includes(op.id)
			? book.finished
			: [...book.finished, op.id].slice(-MAX_FINISHED_IDS);
		return { running: others, finished };
	}
	if (book.finished.includes(op.id)) return book;
	return { running: [...others, op], finished: book.finished };
}

/** Seed the book from `listOperations({ active: true })`, keeping anything
 *  the stream has already said. */
export function seedBook(book: OperationBook, ops: readonly Operation[]): OperationBook {
	return ops
		.filter((op) => op.state === 'running')
		.filter((op) => !book.running.some((o) => o.id === op.id))
		.reduce((acc, op) => applyOperationEvent(acc, op), book);
}

/** Only the contract's fields, so the SSE envelope (`type`, `seq`, `ts`)
 *  does not ride along into a stored row. */
export function pickOperation(op: Operation): Operation {
	return {
		id: op.id,
		user_id: op.user_id,
		kind: op.kind,
		subject_kind: op.subject_kind,
		subject_id: op.subject_id,
		worker_id: op.worker_id ?? null,
		trigger: op.trigger,
		state: op.state,
		step: op.step ?? null,
		step_message: op.step_message ?? null,
		started_at: op.started_at,
		heartbeat_at: op.heartbeat_at,
		finished_at: op.finished_at ?? null,
		error: op.error ?? null,
	};
}

function byStart(a: OperationSummary, b: OperationSummary): number {
	return Date.parse(a.started_at) - Date.parse(b.started_at);
}

/** Use a REST-reported operation unless the stream has since finished it. */
function unlessFinished(
	book: OperationBook,
	reported: OperationSummary | null | undefined,
): OperationSummary | null {
	if (!reported) return null;
	return book.finished.includes(reported.id) ? null : reported;
}

/**
 * The running operation on one subject: the stream's copy when it has one,
 * which is newer, else what the last response reported.
 */
export function operationFor(
	book: OperationBook,
	subjectKind: OperationSubjectKind,
	subjectId: string,
	reported: OperationSummary | null | undefined = null,
): Operation | OperationSummary | null {
	const live = book.running
		.filter((op) => op.subject_kind === subjectKind && op.subject_id === subjectId)
		.sort(byStart)[0];
	return live ?? unlessFinished(book, reported);
}

/**
 * The oldest running operation on a worker, the same choice the control
 * plane makes for a sync report's `worker_busy_with`. The report is weighed
 * with the stream's operations rather than behind them: it may name an older
 * operation the stream started before this page opened.
 */
export function operationOnWorker(
	book: OperationBook,
	workerId: string | null | undefined,
	reported: OperationSummary | null | undefined = null,
): Operation | OperationSummary | null {
	const live = workerId ? book.running.filter((op) => op.worker_id === workerId) : [];
	const fromReport = unlessFinished(book, reported);
	const candidates: Array<Operation | OperationSummary> = [...live];
	if (fromReport && !live.some((op) => op.id === fromReport.id)) candidates.push(fromReport);
	return candidates.sort(byStart)[0] ?? null;
}

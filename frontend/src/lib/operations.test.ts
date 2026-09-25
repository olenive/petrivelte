import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';

import type { Operation, OperationSummary } from './api';
import OperationStatus from './components/OperationStatus.svelte';
import {
	MAX_FINISHED_IDS,
	applyOperationEvent,
	emptyBook,
	formatDuration,
	operationFor,
	operationOnWorker,
	operationView,
	seedBook,
} from './operations';

/**
 * Operations are what let a page say "busy doing X since T" instead of
 * guessing from silence. The book must never bring a finished operation back
 * (that would hold a page in `busy` for ever), and the view must say how long
 * since the worker was last heard from, which is what tells working from stuck.
 */

const START = '2026-09-25T10:00:00Z';
const at = (seconds: number) => Date.parse(START) + seconds * 1000;

const operation = (over: Partial<Operation> = {}): Operation => ({
	id: 'op-1',
	user_id: 'u-1',
	kind: 'notebook_load',
	subject_kind: 'notebook',
	subject_id: 'nb-1',
	worker_id: 'w-1',
	trigger: 'user',
	state: 'running',
	step: 'dependencies',
	step_message: 'resolving 41 packages',
	started_at: START,
	heartbeat_at: '2026-09-25T10:01:00Z',
	finished_at: null,
	error: null,
	...over,
});

const summary = (over: Partial<OperationSummary> = {}): OperationSummary => ({
	id: 'op-1',
	kind: 'notebook_load',
	trigger: 'user',
	step: 'spawn',
	step_message: null,
	started_at: START,
	heartbeat_at: START,
	...over,
});

describe('operationView', () => {
	it('names the kind and step in plain words, with elapsed and heartbeat ages', () => {
		const v = operationView(operation(), at(65));

		expect(v.headline).toBe('Loading notebook: installing dependencies');
		expect(v.message).toBe('resolving 41 packages');
		expect(v.elapsed).toBe('1m 05s');
		expect(v.heartbeat).toBe('5s');
		expect(v.running).toBe(true);
		expect(v.stateLabel).toBe('running');
	});

	it('reads a summary as a running operation', () => {
		const v = operationView(summary(), at(3));

		expect(v.state).toBe('running');
		expect(v.headline).toBe('Loading notebook: starting subprocess');
	});

	it('fixes a finished operation’s elapsed time at its finish and drops the heartbeat', () => {
		const v = operationView(
			operation({ state: 'failed', finished_at: '2026-09-25T10:00:40Z', error: 'uv exited 1' }),
			at(600),
		);

		expect(v.elapsed).toBe('40s');
		expect(v.heartbeat).toBeNull();
		expect(v.stateLabel).toBe('failed');
		expect(v.error).toBe('uv exited 1');
		expect(v.title).toContain('uv exited 1');
	});

	it('calls an abandoned operation lost contact, not a failure of the work', () => {
		const v = operationView(operation({ state: 'abandoned', finished_at: START }), at(1));

		expect(v.stateLabel).toBe('lost contact');
	});

	it('names only the kind before the first step, and an unknown kind by its own name', () => {
		expect(operationView(summary({ step: null }), at(1)).headline).toBe('Loading notebook');
		expect(operationView(summary({ kind: 'model_train', step: 'epoch_3' }), at(1)).headline).toBe(
			'model train: epoch 3',
		);
	});

	it('leaves an unparseable timestamp unmeasured rather than inventing an age', () => {
		const v = operationView(summary({ started_at: 'nonsense', heartbeat_at: 'nonsense' }), at(1));

		expect(v.elapsed).toBeNull();
		expect(v.heartbeat).toBeNull();
	});
});

describe('formatDuration', () => {
	it('moves visibly at every scale', () => {
		expect(formatDuration(0.4)).toBe('0s');
		expect(formatDuration(59)).toBe('59s');
		expect(formatDuration(61)).toBe('1m 01s');
		expect(formatDuration(3725)).toBe('1h 02m');
	});
});

describe('the operation book', () => {
	it('holds a started operation and replaces it with each progress event', () => {
		let book = applyOperationEvent(emptyBook(), { ...operation(), type: 'operation_started' });
		book = applyOperationEvent(book, {
			...operation({ step: 'spawn', heartbeat_at: '2026-09-25T10:02:00Z' }),
			type: 'operation_progress',
		});

		expect(book.running).toHaveLength(1);
		expect(book.running[0].step).toBe('spawn');
	});

	it('drops a finished operation and ignores progress that arrives after it', () => {
		let book = applyOperationEvent(emptyBook(), { ...operation(), type: 'operation_started' });
		book = applyOperationEvent(book, {
			...operation({ state: 'succeeded', finished_at: START }),
			type: 'operation_finished',
		});
		// A replay after a reconnect can deliver an older progress event late.
		book = applyOperationEvent(book, { ...operation(), type: 'operation_progress' });

		expect(book.running).toEqual([]);
		expect(book.finished).toEqual(['op-1']);
	});

	it('keeps only the contract’s fields, not the event envelope', () => {
		const book = applyOperationEvent(emptyBook(), {
			...operation(),
			type: 'operation_started',
			seq: 7,
			ts: START,
		} as Operation & { type: string });

		expect(Object.keys(book.running[0]).sort()).toEqual(Object.keys(operation()).sort());
	});

	it('bounds the memory of finished ids', () => {
		let book = emptyBook();
		for (let i = 0; i < MAX_FINISHED_IDS + 5; i++) {
			book = applyOperationEvent(book, operation({ id: `op-${i}`, state: 'succeeded' }));
		}

		expect(book.finished).toHaveLength(MAX_FINISHED_IDS);
		expect(book.finished.at(-1)).toBe(`op-${MAX_FINISHED_IDS + 4}`);
	});

	it('seeds from a listing without undoing what the stream already said', () => {
		const finished = applyOperationEvent(emptyBook(), operation({ id: 'gone', state: 'failed' }));
		const book = seedBook(finished, [operation({ id: 'gone' }), operation({ id: 'op-2' })]);

		expect(book.running.map((o) => o.id)).toEqual(['op-2']);
	});

	it('prefers the stream’s copy for a subject, and falls back to the reported one', () => {
		const book = applyOperationEvent(emptyBook(), operation({ step: 'serve' }));

		expect(operationFor(book, 'notebook', 'nb-1', summary())?.step).toBe('serve');
		expect(operationFor(emptyBook(), 'notebook', 'nb-1', summary())?.step).toBe('spawn');
		expect(operationFor(book, 'net', 'nb-1')).toBeNull();
	});

	it('never brings back a reported operation the stream saw finish', () => {
		const book = applyOperationEvent(emptyBook(), operation({ state: 'succeeded' }));

		expect(operationFor(book, 'notebook', 'nb-1', summary())).toBeNull();
		expect(operationOnWorker(book, 'w-1', summary())).toBeNull();
	});

	it('names the oldest operation on a worker, weighing the report with the stream', () => {
		const book = applyOperationEvent(
			emptyBook(),
			operation({ id: 'newer', started_at: '2026-09-25T10:05:00Z' }),
		);
		const older = summary({ id: 'older', started_at: '2026-09-25T09:59:00Z' });

		expect(operationOnWorker(book, 'w-1', older)?.id).toBe('older');
		expect(operationOnWorker(book, 'w-1', null)?.id).toBe('newer');
		expect(operationOnWorker(book, 'w-2', null)).toBeNull();
	});
});

describe('OperationStatus', () => {
	const html = (props: Record<string, unknown>) =>
		render(OperationStatus, { props: props as never }).body;

	it('renders kind, step, message, elapsed and heartbeat age', () => {
		const body = html({ operation: operation(), now: at(65) });

		expect(body).toContain('Loading notebook');
		expect(body).toContain('installing dependencies');
		expect(body).toContain('resolving 41 packages');
		expect(body).toContain('running for 1m 05s');
		expect(body).toContain('last heard from 5s ago');
		expect(body).toContain('data-operation-state="running"');
	});

	it('renders a finished operation with its state and error, and no heartbeat', () => {
		const body = html({
			operation: operation({ state: 'failed', finished_at: '2026-09-25T10:00:40Z', error: 'uv exited 1' }),
			now: at(600),
		});

		expect(body).toContain('failed');
		expect(body).toContain('uv exited 1');
		expect(body).toContain('took 40s');
		expect(body).not.toContain('last heard');
	});

	it('fits the step and ages on one line when compact', () => {
		const body = html({ operation: summary(), now: at(12), compact: true });

		expect(body).toContain('Loading notebook: starting subprocess');
		expect(body).toContain('· 12s');
		expect(body).toContain('heard 12s ago');
	});
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import {
	NetProxyError,
	PROTOCOL_REASONS,
	diagnoseNet,
	disableTransition,
	distinctValues,
	enableTransition,
	executionInject,
	executionStep,
	getExecutionHistory,
	getExecutionState,
	getNetLogHistory,
	getToken,
	isNotLoaded,
	isProtocolError,
	isStillInProgress,
	queryNet,
} from './api';

function respond(status: number, body: unknown) {
	const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
		new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('diagnoseNet', () => {
	it('GETs the verdict for the net', async () => {
		const verdict = {
			state: 'stalled',
			reason: 'no progress for 900 s while running',
			action: 'restart the net',
			facts: { step_count: 12 },
			checked_at: '2026-09-27T12:00:00Z',
		};
		const fetchMock = respond(200, verdict);
		await expect(diagnoseNet('n-1')).resolves.toEqual(verdict);
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/nets/n-1/diagnose');
	});

	it('surfaces the server detail on failure', async () => {
		respond(404, { detail: 'Net not found' });
		await expect(diagnoseNet('gone')).rejects.toThrow('Net not found');
	});
});

describe('net execution proxy refusals', () => {
	const REFUSALS: Array<[number, string, string]> = [
		[404, 'net_not_found', 'Net not found'],
		[409, 'not_assigned', 'Net is not assigned to a worker'],
		[503, 'worker_not_ready', 'Worker is not ready'],
		[502, 'worker_unreachable', 'Worker did not answer'],
	];

	for (const [status, reason, detail] of REFUSALS) {
		it(`carries the ${reason} detail and reason from the execution state read`, async () => {
			respond(status, { detail, reason });
			const error = await getExecutionState('n-1').catch((e) => e);
			expect(error).toBeInstanceOf(NetProxyError);
			expect(error.message).toBe(detail);
			expect(error.reason).toBe(reason);
			expect(error.status).toBe(status);
			expect(isNotLoaded(error)).toBe(false);
		});
	}

	it('reads a 409 not_loaded as not loaded', async () => {
		respond(409, { detail: 'Net is not loaded', reason: 'not_loaded' });
		const error = await getExecutionState('n-1').catch((e) => e);
		expect(isNotLoaded(error)).toBe(true);
	});

	it('reads an older control plane passing the worker 404 on as not loaded', async () => {
		respond(404, { detail: 'Net not loaded' });
		const error = await getExecutionState('n-1').catch((e) => e);
		expect(error.reason).toBeNull();
		expect(isNotLoaded(error)).toBe(true);
	});

	it('is not fooled by a plain Error', () => {
		expect(isNotLoaded(new Error('Net not loaded'))).toBe(false);
	});

	it('falls back to a plain message when the body is not JSON', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));
		const error = await getExecutionState('n-1').catch((e) => e);
		expect(error.message).toBe('Failed to get execution state');
		expect(error.reason).toBeNull();
	});

	it('gives the step and token reads the server detail', async () => {
		respond(503, { detail: 'Worker is not ready', reason: 'worker_not_ready' });
		await expect(executionStep('n-1', 'k-1')).rejects.toThrow('Worker is not ready');
		await expect(getToken('n-1', 't-1')).rejects.toThrow('Worker is not ready');
	});
});

describe('protocol refusals', () => {
	const CODES: Array<[number, string]> = [
		[404, 'unknown_net'],
		[404, 'unknown_place'],
		[404, 'unknown_transition'],
		[404, 'unknown_token'],
		[422, 'invalid_params'],
		[422, 'invalid_token'],
		[422, 'not_serializable'],
		[422, 'load_failed'],
		[501, 'unsupported'],
		[501, 'unknown_method'],
		[500, 'internal'],
	];

	for (const [status, reason] of CODES) {
		it(`carries ${status} ${reason} as a protocol error`, async () => {
			respond(status, { detail: `refused: ${reason}`, reason });
			const error = await executionInject('n-1', 'Receiving', { id: 1 }).catch((e) => e);
			expect(error).toBeInstanceOf(NetProxyError);
			expect(error.status).toBe(status);
			expect(error.reason).toBe(reason);
			expect(error.message).toBe(`refused: ${reason}`);
			expect(isProtocolError(error)).toBe(true);
			expect(isNotLoaded(error)).toBe(false);
			expect(isStillInProgress(error)).toBe(false);
		});
	}

	it('knows every protocol code', () => {
		expect([...PROTOCOL_REASONS].sort()).toEqual([...CODES.map(([, r]) => r), 'not_loaded'].sort());
	});

	it('reads the protocol not_loaded as not loaded', async () => {
		respond(409, { detail: 'not loaded', reason: 'not_loaded' });
		const error = await getToken('n-1', '7').catch((e) => e);
		expect(isNotLoaded(error)).toBe(true);
		expect(isProtocolError(error)).toBe(true);
	});

	it('is not fooled by a control plane refusal', async () => {
		respond(503, { detail: 'Worker is not ready', reason: 'worker_not_ready' });
		const error = await getExecutionState('n-1').catch((e) => e);
		expect(isProtocolError(error)).toBe(false);
	});
});

describe('a step that outlasts the control plane', () => {
	it('is still in progress, not a failure', async () => {
		respond(504, { detail: 'The step is still running', reason: 'timeout' });
		const error = await executionStep('n-1', 'k-1').catch((e) => e);
		expect(error).toBeInstanceOf(NetProxyError);
		expect(error.status).toBe(504);
		expect(error.reason).toBe('timeout');
		expect(isStillInProgress(error)).toBe(true);
		expect(isProtocolError(error)).toBe(false);
	});

	it('is not mistaken for a bare 504 or another reason', async () => {
		respond(504, { detail: 'Gateway timeout' });
		expect(isStillInProgress(await executionStep('n-1', 'k-1').catch((e) => e))).toBe(false);
		respond(502, { detail: 'down', reason: 'worker_unreachable' });
		expect(isStillInProgress(await executionStep('n-1', 'k-1').catch((e) => e))).toBe(false);
		expect(isStillInProgress(new Error('timeout'))).toBe(false);
	});
});

describe('version 1 bodies', () => {
	it('reads the state with a token limit', async () => {
		const fetchMock = respond(200, { marking_version: 3 });
		await getExecutionState('n-1', 50);
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/nets/n-1/execution/state?token_limit=50');
		await getExecutionState('n-1');
		expect(fetchMock.mock.calls[1][0]).toBe('http://cp.test/api/nets/n-1/execution/state');
	});

	it('reads the history after a seq, answering its entries', async () => {
		const entry = { seq: 5, transition: 'Sort', started_at: 't', duration_ms: 1, outcome: 'fired', consumed: [], produced: [] };
		const fetchMock = respond(200, { entries: [entry] });
		await expect(getExecutionHistory('n-1', { after: 4, limit: 10 })).resolves.toEqual([entry]);
		const url = new URL(fetchMock.mock.calls[0][0]);
		expect(url.pathname).toBe('/api/nets/n-1/execution/history');
		expect(url.searchParams.get('after')).toBe('4');
		expect(url.searchParams.get('limit')).toBe('10');
	});

	it('posts inject by place and answers the new id', async () => {
		const fetchMock = respond(200, { status: 'injected', id: '17', marking_version: 4 });
		await expect(executionInject('n-1', 'Receiving', { weight: 2 })).resolves.toEqual({
			status: 'injected',
			id: '17',
			marking_version: 4,
		});
		const init = fetchMock.mock.calls[0][1]!;
		expect(JSON.parse(String(init.body))).toEqual({ place: 'Receiving', token: { weight: 2 } });
	});

	it('answers the step result', async () => {
		respond(200, { fired: true, transition: 'Sort', marking_version: 6, running: false });
		await expect(executionStep('n-1', 'k-1')).resolves.toEqual({
			fired: true,
			transition: 'Sort',
			marking_version: 6,
			running: false,
		});
	});

	it('enables and disables a transition by name', async () => {
		const fetchMock = respond(200, { marking_version: 9 });
		await expect(enableTransition('n-1', 'Dispatch Truck')).resolves.toEqual({ marking_version: 9 });
		await disableTransition('n-1', 'Sort');
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/nets/n-1/transitions/Dispatch%20Truck/enable');
		expect(fetchMock.mock.calls[0][1]!.method).toBe('POST');
		expect(fetchMock.mock.calls[1][0]).toBe('http://cp.test/api/nets/n-1/transitions/Sort/disable');
	});

	it('refuses an unknown transition with the protocol code', async () => {
		respond(404, { detail: 'no transition named Nope', reason: 'unknown_transition' });
		const error = await enableTransition('n-1', 'Nope').catch((e) => e);
		expect(error.reason).toBe('unknown_transition');
	});

	it('reads a token as JSON or text', async () => {
		const value = { id: '3', place: 'Receiving', type_name: 'Parcel', kind: 'json', value: { id: 3 } };
		const fetchMock = respond(200, value);
		await expect(getToken('n-1', '3')).resolves.toEqual(value);
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/nets/n-1/tokens/3');
	});
});

describe('inner nets by their address (protocol §12.3)', () => {
	it('reads an inner net state by nested id, after the token limit', async () => {
		const fetchMock = respond(200, { marking_version: 3, nested_id: 'n1' });
		await getExecutionState('n-1', 200, { nested_id: 'n1' });
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/nets/n-1/execution/state?token_limit=200&nested_id=n1');
		await getExecutionState('n-1', undefined, { path: 'transit/Depot/#1/cabin' });
		const url = new URL(fetchMock.mock.calls[1][0]);
		expect(url.searchParams.get('path')).toBe('transit/Depot/#1/cabin');
		expect(url.searchParams.has('nested_id')).toBe(false);
	});

	it('reads an inner token, and an inner net history, by the address', async () => {
		const fetchMock = respond(200, { entries: [] });
		await getToken('n-1', '2', { nested_id: 'n1' });
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/nets/n-1/tokens/2?nested_id=n1');
		await getExecutionHistory('n-1', { after: 3, nested_id: 'n1' });
		const url = new URL(fetchMock.mock.calls[1][0]);
		expect(url.searchParams.get('after')).toBe('3');
		expect(url.searchParams.get('nested_id')).toBe('n1');
	});

	it('injects into an inner net with the address in the body', async () => {
		const answer = { status: 'injected', id: '4', marking_version: 6, path: 'transit/Depot/#1/cabin', nested_id: 'n1' };
		const fetchMock = respond(200, answer);
		await expect(executionInject('n-1', 'Door', 'Dan', { nested_id: 'n1' })).resolves.toEqual(answer);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toEqual({ place: 'Door', token: 'Dan', nested_id: 'n1' });
	});

	it('says a gone inner net is gone, with the protocol code', async () => {
		respond(404, { detail: "no inner net 'n1'", reason: 'unknown_net' });
		const error = await getExecutionState('n-1', 200, { nested_id: 'n1' }).catch((e) => e);
		expect(error).toBeInstanceOf(NetProxyError);
		expect(error.status).toBe(404);
		expect(error.reason).toBe('unknown_net');
		expect(isProtocolError(error)).toBe(true);
	});
});

describe('queries (protocol §13.3)', () => {
	it('posts a query with its filter, limit and address, answering the matches', async () => {
		const answer = { marking_version: 4, count: 1, matches: [{ place: 'Pen', token: { id: '2', label: 'Hen', keys: { class: 'Bird' } } }] };
		const fetchMock = respond(200, answer);
		const filter = { clauses: [{ key: 'class', values: ['Bird'] }] };
		await expect(queryNet('n-1', { filter, tokenLimit: 10 }, { nested_id: 'n1' })).resolves.toEqual(answer);
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/nets/n-1/query');
		expect(fetchMock.mock.calls[0][1]!.method).toBe('POST');
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toEqual({ filter, token_limit: 10, nested_id: 'n1' });
		await queryNet('n-1');
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]!.body))).toEqual({});
	});

	it('reads the distinct values of a key, places repeated', async () => {
		const fetchMock = respond(200, { marking_version: 4, key: 'class', values: ['Bird', 'Mammal'] });
		await expect(distinctValues('n-1', 'class', { places: ['Pen', 'Aviary'] }, { nested_id: 'n1' })).resolves.toEqual([
			'Bird',
			'Mammal',
		]);
		const url = new URL(fetchMock.mock.calls[0][0]);
		expect(url.pathname).toBe('/api/nets/n-1/distinct');
		expect(url.searchParams.get('key')).toBe('class');
		expect(url.searchParams.getAll('places')).toEqual(['Pen', 'Aviary']);
		expect(url.searchParams.get('nested_id')).toBe('n1');
	});

	it('throws when the control plane has no distinct route, so the caller falls back', async () => {
		respond(404, { detail: 'Not Found' });
		const error = await distinctValues('n-1', 'class').catch((e) => e);
		expect(error).toBeInstanceOf(NetProxyError);
	});
});

describe('getExecutionHistory', () => {
	it('is empty for a net that is not loaded', async () => {
		respond(409, { detail: 'Net is not loaded', reason: 'not_loaded' });
		await expect(getExecutionHistory('n-1')).resolves.toEqual([]);
	});

	it('throws any other refusal with its detail', async () => {
		respond(502, { detail: 'Worker did not answer', reason: 'worker_unreachable' });
		await expect(getExecutionHistory('n-1')).rejects.toThrow('Worker did not answer');
	});
});

describe('getNetLogHistory', () => {
	it('sends no query string by default', async () => {
		const fetchMock = respond(200, []);
		await getNetLogHistory('n-1');
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/nets/n-1/logs/history');
	});

	it('sends limit, since, contains and newest_first when given', async () => {
		const fetchMock = respond(200, [{ ts: null, text: 'hello' }]);
		await expect(getNetLogHistory('n-1', {
			limit: 50,
			since: '2026-09-27T10:00:00Z',
			contains: 'alert fired',
			newest_first: true,
		})).resolves.toEqual([{ ts: null, text: 'hello' }]);
		const url = new URL(fetchMock.mock.calls[0][0]);
		expect(url.pathname).toBe('/api/nets/n-1/logs/history');
		expect(url.searchParams.get('limit')).toBe('50');
		expect(url.searchParams.get('since')).toBe('2026-09-27T10:00:00Z');
		expect(url.searchParams.get('contains')).toBe('alert fired');
		expect(url.searchParams.get('newest_first')).toBe('true');
	});

	it('is empty for a net that is not loaded', async () => {
		respond(409, { detail: 'Net is not loaded', reason: 'not_loaded' });
		await expect(getNetLogHistory('n-1')).resolves.toEqual([]);
	});

	it('throws any other refusal with its detail and reason', async () => {
		respond(409, { detail: 'Net is not assigned to a worker', reason: 'not_assigned' });
		const error = await getNetLogHistory('n-1').catch((e) => e);
		expect(error.message).toBe('Net is not assigned to a worker');
		expect(error.reason).toBe('not_assigned');
	});
});

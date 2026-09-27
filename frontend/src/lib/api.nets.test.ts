import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import {
	NetProxyError,
	diagnoseNet,
	executionStep,
	getExecutionHistory,
	getExecutionState,
	getNetLogHistory,
	getToken,
	isNotLoaded,
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

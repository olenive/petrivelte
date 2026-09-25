import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import { getOperation, listOperations } from './api';

/** The operations reads: the query the control plane filters by, and the
 *  failure a page sees when the read is refused. */

function capture(status: number, body: unknown) {
	const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('listOperations', () => {
	it('sends only the filters it was given', async () => {
		const fetchMock = capture(200, []);
		await listOperations({ active: true, subject_kind: 'notebook', subject_id: 'nb-1', limit: 5 });

		const url = new URL(fetchMock.mock.calls[0][0]);
		expect(url.pathname).toBe('/api/operations');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			active: 'true',
			subject_kind: 'notebook',
			subject_id: 'nb-1',
			limit: '5',
		});
	});

	it('asks for everything when given no filters', async () => {
		const fetchMock = capture(200, []);
		await listOperations();

		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/operations');
	});

	it('throws on a refusal', async () => {
		capture(500, { detail: 'boom' });
		await expect(listOperations({ worker_id: 'w-1' })).rejects.toThrow('Failed to list operations');
	});
});

describe('getOperation', () => {
	it('reads one operation by id', async () => {
		const fetchMock = capture(200, { id: 'op-1' });
		await expect(getOperation('op-1')).resolves.toEqual({ id: 'op-1' });
		expect(fetchMock.mock.calls[0][0]).toBe('http://cp.test/api/operations/op-1');
	});
});

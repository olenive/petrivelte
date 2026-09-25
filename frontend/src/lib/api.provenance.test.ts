import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import { deleteWorker, upgradeNotebook } from './api';

const OPERATION = {
	id: 'op-1',
	user_id: 'u-1',
	kind: 'notebook_load',
	subject_kind: 'notebook',
	subject_id: 'nb-1',
	worker_id: 'w-1',
	trigger: 'user',
	state: 'running',
	step: null,
	step_message: null,
	started_at: '2026-09-25T10:00:00Z',
	heartbeat_at: '2026-09-25T10:00:00Z',
	finished_at: null,
	error: null,
};

function respond(status: number, body: unknown) {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('upgradeNotebook', () => {
	it('POSTs to the upgrade route with no body and returns the 202 operation', async () => {
		const fetchMock = respond(202, OPERATION);
		await expect(upgradeNotebook('nb-1')).resolves.toEqual(OPERATION);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://cp.test/api/notebooks/nb-1/upgrade');
		expect(init.method).toBe('POST');
		expect(init.body).toBeUndefined();
		expect((init.headers as Record<string, string>)['X-Idempotency-Key']).toBeTruthy();
	});

	it('sends an explicit target deployment when given one', async () => {
		const fetchMock = respond(202, OPERATION);
		await upgradeNotebook('nb-1', 'dep-9');
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ deployment_id: 'dep-9' });
	});

	it("throws the server's 409 detail as the message", async () => {
		respond(409, { detail: 'No newer deployment contains this notebook.' });
		await expect(upgradeNotebook('nb-1')).rejects.toThrow(
			'No newer deployment contains this notebook.',
		);
	});
});

describe('deleteWorker', () => {
	it('returns how many notebooks were left unassigned', async () => {
		respond(200, { status: 'deleted', notebooks_unassigned: 2, notebook_ids: ['a', 'b'] });
		await expect(deleteWorker('w-1')).resolves.toEqual({
			notebooks_unassigned: 2,
			notebook_ids: ['a', 'b'],
		});
	});

	it('reads an older response without the count as zero', async () => {
		respond(200, { status: 'deleted' });
		await expect(deleteWorker('w-1')).resolves.toEqual({
			notebooks_unassigned: 0,
			notebook_ids: [],
		});
	});
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import { diagnoseNet } from './api';

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

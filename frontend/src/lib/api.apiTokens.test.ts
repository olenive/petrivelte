import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import { createApiToken, listApiTokens, revokeApiToken } from './api';

/**
 * Personal API tokens are minted and revoked from Settings. These tests pin
 * the request each function sends and that the server's `detail` reaches the
 * page as the error message.
 */

const TOKEN = {
	id: 'tok-1',
	name: 'laptop scripts',
	prefix: 'abcd1234',
	created_at: '2026-09-25T12:00:00Z',
	expires_at: '2027-09-25T12:00:00Z',
	last_used_at: null,
	revoked_at: null,
};

function respond(status: number, body: unknown) {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof respond>): [string, RequestInit] {
	return fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('listApiTokens', () => {
	it('GETs the token list with the session cookie', async () => {
		const fetchMock = respond(200, [TOKEN]);
		await expect(listApiTokens()).resolves.toEqual([TOKEN]);
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe('http://cp.test/api/auth/tokens');
		expect(init.credentials).toBe('include');
		expect(init.method ?? 'GET').toBe('GET');
	});

	it('surfaces the server detail on failure', async () => {
		respond(403, { detail: 'API tokens cannot manage API tokens' });
		await expect(listApiTokens()).rejects.toThrow('API tokens cannot manage API tokens');
	});
});

describe('createApiToken', () => {
	it('POSTs the name and expiry in days and returns the one-time token', async () => {
		const created = { ...TOKEN, token: 'petri_pat_abcd1234secret' };
		const fetchMock = respond(201, created);
		await expect(createApiToken('laptop scripts', 365)).resolves.toEqual(created);
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe('http://cp.test/api/auth/tokens');
		expect(init.method).toBe('POST');
		expect(JSON.parse(String(init.body))).toEqual({
			name: 'laptop scripts',
			expires_in_days: 365,
		});
	});

	it('throws the 400 detail when a limit is exceeded', async () => {
		respond(400, { detail: 'You already have 20 active API tokens; revoke one first.' });
		await expect(createApiToken('one too many', 30)).rejects.toThrow(
			'You already have 20 active API tokens; revoke one first.',
		);
	});

	it('reads a Pydantic validation message', async () => {
		respond(422, { detail: [{ loc: ['body', 'name'], msg: 'String should have at least 1 character', type: 'x' }] });
		await expect(createApiToken('', 30)).rejects.toThrow('String should have at least 1 character');
	});
});

describe('revokeApiToken', () => {
	it('DELETEs the token by id', async () => {
		const fetchMock = respond(200, { status: 'revoked' });
		await expect(revokeApiToken('tok-1')).resolves.toEqual({ status: 'revoked' });
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe('http://cp.test/api/auth/tokens/tok-1');
		expect(init.method).toBe('DELETE');
		expect(init.credentials).toBe('include');
	});

	it('throws the 404 detail for a token that is not the user\'s', async () => {
		respond(404, { detail: 'Token not found' });
		await expect(revokeApiToken('someone-else')).rejects.toThrow('Token not found');
	});

	it('falls back to a plain message when the body has no detail', async () => {
		respond(404, {});
		await expect(revokeApiToken('gone')).rejects.toThrow('Failed to revoke API token');
	});
});

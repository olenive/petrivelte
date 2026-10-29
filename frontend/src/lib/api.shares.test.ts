import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import { createShare, listShares, revokeShare, type Share, type ShareCreated } from './api';

/**
 * Shares are minted, listed and revoked from the shares page. These tests pin
 * the request each function sends, the shapes it hands back, and that the
 * server's plain-English refusal reaches the page as the error message.
 */

const NET_A = '00000000-0000-0000-0000-0000000000a1';
const NET_B = '00000000-0000-0000-0000-0000000000a2';
const WORKER = '00000000-0000-0000-0000-0000000000c1';

const SHARE: Share = {
	id: '00000000-0000-0000-0000-0000000000aa',
	label: 'demo',
	resource_kind: 'world',
	notebook_id: null,
	notebook_name: null,
	scope: 'read',
	audience: 'link',
	member_email: null,
	seat: null,
	prefix: 'abcdefgh',
	publish_payloads: false,
	max_viewers: 20,
	inputs_per_minute: 60,
	created_at: '2026-10-29T12:00:00Z',
	expires_at: '2026-11-28T12:00:00Z',
	revoked_at: null,
	last_used_at: null,
	bundle_id: null,
	bundle_label: null,
	nets: [
		{ net_id: NET_A, definition_name: 'light_net', instance_name: 'light', worker_id: WORKER, play_places: [], play_controls: [] },
	],
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

describe('listShares', () => {
	it('GETs every share with the session cookie and returns them as listed', async () => {
		const revoked: Share = { ...SHARE, id: 'share-2', revoked_at: '2026-10-29T13:00:00Z' };
		const fetchMock = respond(200, [SHARE, revoked]);
		const shares = await listShares();
		expect(shares).toEqual([SHARE, revoked]);
		expect(shares[0].nets[0].worker_id).toBe(WORKER);
		expect(shares[0].nets[0].instance_name).toBe('light');
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe('http://cp.test/api/shares');
		expect(init.credentials).toBe('include');
		expect(init.method ?? 'GET').toBe('GET');
	});

	it('narrows to the worlds holding one net', async () => {
		const fetchMock = respond(200, []);
		await listShares(NET_A);
		expect(lastCall(fetchMock)[0]).toBe(`http://cp.test/api/shares?net_id=${NET_A}`);
	});

	it('surfaces the 403 a personal API token gets', async () => {
		respond(403, { detail: 'This action needs a browser session, not an API token' });
		await expect(listShares()).rejects.toThrow('This action needs a browser session, not an API token');
	});
});

describe('createShare', () => {
	it('POSTs a read link share of one net and returns the one-time token', async () => {
		const created: ShareCreated = { ...SHARE, token: 'petri_share_abcdefghsecret' };
		const fetchMock = respond(201, created);
		const answer = await createShare({
			label: 'demo',
			resource_kind: 'world',
			nets: [{ net_id: NET_A }],
			scope: 'read',
			audience: 'link',
			expires_in_days: 30,
			publish_payloads: false,
			max_viewers: 20,
			inputs_per_minute: 60,
		});
		expect(answer).toEqual(created);
		expect(answer.token).toBe('petri_share_abcdefghsecret');
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe('http://cp.test/api/shares');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('include');
		expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
		expect(JSON.parse(String(init.body))).toEqual({
			label: 'demo',
			resource_kind: 'world',
			nets: [{ net_id: NET_A }],
			scope: 'read',
			audience: 'link',
			expires_in_days: 30,
			publish_payloads: false,
			max_viewers: 20,
			inputs_per_minute: 60,
		});
	});

	it('POSTs a named play share with a seat and each net\'s places and controls', async () => {
		const fetchMock = respond(201, { ...SHARE, token: 'petri_share_x' });
		await createShare({
			label: 'two-seat game',
			resource_kind: 'world',
			nets: [
				{ net_id: NET_A, play_places: ['moves'], play_controls: ['resign'] },
				{ net_id: NET_B, play_places: ['said'], play_controls: [] },
			],
			scope: 'play',
			audience: 'named',
			member_email: 'ann@example.com',
			seat: 'north',
			expires_in_days: 7,
			publish_payloads: true,
			max_viewers: 4,
			inputs_per_minute: 120,
		});
		expect(JSON.parse(String(lastCall(fetchMock)[1].body))).toEqual({
			label: 'two-seat game',
			resource_kind: 'world',
			nets: [
				{ net_id: NET_A, play_places: ['moves'], play_controls: ['resign'] },
				{ net_id: NET_B, play_places: ['said'], play_controls: [] },
			],
			scope: 'play',
			audience: 'named',
			member_email: 'ann@example.com',
			seat: 'north',
			expires_in_days: 7,
			publish_payloads: true,
			max_viewers: 4,
			inputs_per_minute: 120,
		});
	});

	it('POSTs a world share that names a bundle and hands back its label', async () => {
		const BUNDLE = '00000000-0000-0000-0000-0000000000b1';
		const fetchMock = respond(201, { ...SHARE, bundle_id: BUNDLE, bundle_label: 'chess board', token: 't' });
		const answer = await createShare({ label: 'game', resource_kind: 'world', nets: [{ net_id: NET_A }], bundle_id: BUNDLE });
		expect(JSON.parse(String(lastCall(fetchMock)[1].body))).toEqual({
			label: 'game',
			resource_kind: 'world',
			nets: [{ net_id: NET_A }],
			bundle_id: BUNDLE,
		});
		expect([answer.bundle_id, answer.bundle_label]).toEqual([BUNDLE, 'chess board']);
	});

	it('throws the sentence for another owner\'s bundle', async () => {
		respond(422, { detail: 'Bundle 00000000-0000-0000-0000-0000000000b2 is not one of your bundles' });
		await expect(
			createShare({ label: 'x', resource_kind: 'world', nets: [{ net_id: NET_A }], bundle_id: '00000000-0000-0000-0000-0000000000b2' }),
		).rejects.toThrow('Bundle 00000000-0000-0000-0000-0000000000b2 is not one of your bundles');
	});

	it('POSTs a notebook share by notebook id and hands back its notebook\'s name', async () => {
		const fetchMock = respond(201, {
			...SHARE, resource_kind: 'notebook', notebook_id: 'nb-1', notebook_name: 'daily plots', nets: [], token: 't',
		});
		const answer = await createShare({ label: 'plots', resource_kind: 'notebook', notebook_id: 'nb-1' });
		expect(JSON.parse(String(lastCall(fetchMock)[1].body))).toEqual({
			label: 'plots',
			resource_kind: 'notebook',
			notebook_id: 'nb-1',
		});
		expect([answer.notebook_id, answer.notebook_name]).toEqual(['nb-1', 'daily plots']);
	});

	it('throws the server\'s sentence for a refused mint', async () => {
		respond(422, { detail: 'The nets of a world must all be on one worker; these are on 2 workers' });
		await expect(
			createShare({ label: 'x', resource_kind: 'world', nets: [{ net_id: NET_A }, { net_id: NET_B }] }),
		).rejects.toThrow('The nets of a world must all be on one worker; these are on 2 workers');
	});

	it('throws the active-share cap sentence', async () => {
		respond(422, { detail: 'You already have 100 active shares; revoke one first' });
		await expect(createShare({ label: 'x', resource_kind: 'world', nets: [] })).rejects.toThrow(
			'You already have 100 active shares; revoke one first',
		);
	});

	it('names the field in a body FastAPI could not parse', async () => {
		respond(422, {
			detail: [{ loc: ['body', 'max_viewers'], msg: 'Input should be a valid integer', type: 'int_parsing' }],
		});
		await expect(createShare({ label: 'x', resource_kind: 'world', max_viewers: 2.5 })).rejects.toThrow(
			'max_viewers: Input should be a valid integer',
		);
	});

	it('names the nested field for a net of the request', async () => {
		respond(422, {
			detail: [{ loc: ['body', 'nets', 0, 'play_place'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }],
		});
		await expect(createShare({ label: 'x', resource_kind: 'world' })).rejects.toThrow(
			'nets.0.play_place: Extra inputs are not permitted',
		);
	});

	it('says the mint limit was reached on a 429', async () => {
		respond(429, { error: 'Rate limit exceeded', detail: '10 per 1 minute' });
		await expect(createShare({ label: 'x', resource_kind: 'world' })).rejects.toThrow(
			'Too many shares minted in the last minute (10 per 1 minute); wait a minute and try again',
		);
	});

	it('falls back to a plain message when the body is not JSON', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
		await expect(createShare({ label: 'x', resource_kind: 'world' })).rejects.toThrow('Failed to create the share');
	});
});

describe('revokeShare', () => {
	it('DELETEs the share by id', async () => {
		const fetchMock = respond(200, { status: 'revoked' });
		await expect(revokeShare(SHARE.id)).resolves.toEqual({ status: 'revoked' });
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe(`http://cp.test/api/shares/${SHARE.id}`);
		expect(init.method).toBe('DELETE');
		expect(init.credentials).toBe('include');
	});

	it('throws the 404 detail for a share that is not the owner\'s', async () => {
		respond(404, { detail: 'Share not found' });
		await expect(revokeShare('someone-else')).rejects.toThrow('Share not found');
	});

	it('falls back to a plain message when the body has no detail', async () => {
		respond(500, {});
		await expect(revokeShare('x')).rejects.toThrow('Failed to revoke the share');
	});
});

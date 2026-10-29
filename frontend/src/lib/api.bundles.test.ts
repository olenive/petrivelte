import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import { deleteBundle, listBundles, uploadBundle, type Bundle } from './api';

/**
 * Bundles are uploaded, listed and deleted from the shares page. These tests
 * pin the request each function sends, above all that an upload is the zip
 * itself as the body with `Content-Type: application/zip` and the label in
 * the query string, and that each of the server's refusals reaches the page
 * as its sentence.
 */

const BUNDLE: Bundle = {
	id: '00000000-0000-0000-0000-0000000000b1',
	label: 'chess board',
	size_bytes: 12_345_678,
	file_count: 4,
	content_hash: 'a'.repeat(64),
	created_at: '2026-10-29T12:00:00Z',
};

function respond(status: number, body: unknown) {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof respond>): [string, RequestInit] {
	return fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
}

function zipFile(name = 'game.zip'): File {
	return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], name, { type: '' });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('listBundles', () => {
	it('GETs the owner\'s bundles with the session cookie and returns them as listed', async () => {
		const older: Bundle = { ...BUNDLE, id: 'bundle-2', label: 'viewer', created_at: '2026-10-01T12:00:00Z' };
		const fetchMock = respond(200, [BUNDLE, older]);
		await expect(listBundles()).resolves.toEqual([BUNDLE, older]);
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe('http://cp.test/api/bundles');
		expect(init.credentials).toBe('include');
		expect(init.method ?? 'GET').toBe('GET');
	});

	it('surfaces the 403 a personal API token gets', async () => {
		respond(403, { detail: 'This action needs a browser session, not an API token' });
		await expect(listBundles()).rejects.toThrow('This action needs a browser session, not an API token');
	});

	it('falls back to a plain message when the body is not JSON', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
		await expect(listBundles()).rejects.toThrow('Failed to load bundles');
	});
});

describe('uploadBundle', () => {
	it('POSTs the file itself as an application/zip body, the label in the query', async () => {
		const fetchMock = respond(201, BUNDLE);
		const file = zipFile();
		await expect(uploadBundle('chess board', file)).resolves.toEqual(BUNDLE);
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe('http://cp.test/api/bundles?label=chess%20board');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('include');
		expect(new Headers(init.headers).get('Content-Type')).toBe('application/zip');
		expect(init.body).toBe(file);
	});

	it('sends application/zip whatever type the browser gave the file', async () => {
		const fetchMock = respond(201, BUNDLE);
		await uploadBundle('x', new File([new Uint8Array([1])], 'game.zip', { type: 'application/x-zip-compressed' }));
		expect(new Headers(lastCall(fetchMock)[1].headers).get('Content-Type')).toBe('application/zip');
	});

	it('encodes a label with characters a query string reserves', async () => {
		const fetchMock = respond(201, BUNDLE);
		await uploadBundle('chess & go?', zipFile());
		const url = new URL(lastCall(fetchMock)[0]);
		expect(url.searchParams.get('label')).toBe('chess & go?');
		expect([...url.searchParams.keys()]).toEqual(['label']);
	});

	it('sends the label as typed, so the server trims or refuses it', async () => {
		const fetchMock = respond(201, BUNDLE);
		await uploadBundle('', zipFile());
		expect(lastCall(fetchMock)[0]).toBe('http://cp.test/api/bundles?label=');
	});

	it.each([
		[413, "A bundle's zip is at most 64 MiB."],
		[415, 'Send the zip as the raw request body, with Content-Type application/zip.'],
		[422, 'The upload is not a zip file.'],
		[422, "There is no index.html at the root of the zip. Zip the contents of the bundle's folder rather than the folder itself, so that index.html is at the top."],
		[422, "A bundle's label must be 1 to 100 characters"],
		[422, 'You already have 20 bundles; delete one first'],
	])('throws the server\'s %i sentence: %s', async (status, sentence) => {
		respond(status, { detail: sentence });
		await expect(uploadBundle('x', zipFile())).rejects.toThrow(sentence);
	});

	it('names the field in a request FastAPI could not parse', async () => {
		respond(422, { detail: [{ loc: ['query', 'label'], msg: 'Field required', type: 'missing' }] });
		await expect(uploadBundle('x', zipFile())).rejects.toThrow('label: Field required');
	});

	it('says the upload limit was reached on a 429', async () => {
		respond(429, { error: 'Rate limit exceeded', detail: '5 per 1 minute' });
		await expect(uploadBundle('x', zipFile())).rejects.toThrow(
			'Too many bundles uploaded in the last minute (5 per 1 minute); wait a minute and try again',
		);
	});

	it('says the zip was too large when a 413 carries no sentence', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('Request Entity Too Large', { status: 413 })));
		await expect(uploadBundle('x', zipFile())).rejects.toThrow('The zip is larger than the server accepts');
	});

	it('falls back to a plain message when the body is not JSON', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
		await expect(uploadBundle('x', zipFile())).rejects.toThrow('Failed to upload the bundle');
	});
});

describe('deleteBundle', () => {
	it('DELETEs the bundle by id', async () => {
		const fetchMock = respond(200, { status: 'deleted' });
		await expect(deleteBundle(BUNDLE.id)).resolves.toEqual({ status: 'deleted' });
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe(`http://cp.test/api/bundles/${BUNDLE.id}`);
		expect(init.method).toBe('DELETE');
		expect(init.credentials).toBe('include');
	});

	it('throws the 404 detail for a bundle that is not the owner\'s', async () => {
		respond(404, { detail: 'Bundle not found' });
		await expect(deleteBundle('someone-else')).rejects.toThrow('Bundle not found');
	});

	it('falls back to a plain message when the body has no detail', async () => {
		respond(500, {});
		await expect(deleteBundle('x')).rejects.toThrow('Failed to delete the bundle');
	});
});

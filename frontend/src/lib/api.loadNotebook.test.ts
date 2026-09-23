import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config/network', () => ({ API_URL: 'http://cp.test' }));

import {
	AdditionalNotebookError,
	InsufficientMemoryError,
	loadNotebook,
	parseInsufficientMemory,
} from './api';

/**
 * The worker refuses a load it cannot fit with HTTP 507, forwarded by the
 * control plane. The refusal is final and its message names the remedies, so
 * the pages show it verbatim; these tests pin that the message survives the
 * trip and that nothing else is mistaken for it.
 */

const REFUSAL = {
	reason: 'insufficient_memory',
	message:
		'Worker has 210 MB of RAM and 0 MB of swap free; view_reachability needs about 300 MB ' +
		'(measured on this worker) plus 128 MB headroom. Unload a notebook or add memory.',
	available_mb: 210,
	swap_free_mb: 0,
	footprint_mb: 300,
	footprint_source: 'measured',
	headroom_mb: 128,
	needed_mb: 428,
};

function respond(status: number, body: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(body), { status })),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('parseInsufficientMemory', () => {
	it('reads every field of the admission detail', () => {
		expect(parseInsufficientMemory({ detail: REFUSAL })).toEqual(REFUSAL);
	});

	it('leaves missing numbers null rather than zero', () => {
		const parsed = parseInsufficientMemory({
			detail: { reason: 'insufficient_memory', message: 'no room' },
		});
		expect(parsed).toEqual({
			reason: 'insufficient_memory',
			message: 'no room',
			available_mb: null,
			swap_free_mb: null,
			footprint_mb: null,
			footprint_source: null,
			headroom_mb: null,
			needed_mb: null,
		});
	});

	it('falls back to a message naming the remedies when the body has none', () => {
		const parsed = parseInsufficientMemory({ detail: { reason: 'insufficient_memory' } });
		expect(parsed?.message).toMatch(/Unload a notebook or add memory/);
	});

	it('is null for anything that is not an admission refusal', () => {
		expect(parseInsufficientMemory(null)).toBeNull();
		expect(parseInsufficientMemory({ detail: 'Insufficient Storage' })).toBeNull();
		expect(parseInsufficientMemory({ detail: { reason: 'additional_notebook' } })).toBeNull();
		expect(parseInsufficientMemory({ detail: [{ msg: 'bad' }] })).toBeNull();
	});
});

describe('loadNotebook', () => {
	it('throws InsufficientMemoryError carrying the message verbatim on a 507', async () => {
		respond(507, { detail: REFUSAL });
		const err = await loadNotebook('nb-1').catch((e) => e);
		expect(err).toBeInstanceOf(InsufficientMemoryError);
		expect(err.message).toBe(REFUSAL.message);
		expect(err.refusal.needed_mb).toBe(428);
		expect(err.refusal.footprint_source).toBe('measured');
	});

	it('treats a 507 without the structured detail as a plain error', async () => {
		respond(507, { detail: 'Insufficient Storage' });
		const err = await loadNotebook('nb-1').catch((e) => e);
		expect(err).not.toBeInstanceOf(InsufficientMemoryError);
		expect(err.message).toBe('Insufficient Storage');
	});

	it('still asks for consent on the additional-notebook 409', async () => {
		respond(409, { detail: { reason: 'additional_notebook', message: 'another is running' } });
		const err = await loadNotebook('nb-1').catch((e) => e);
		expect(err).toBeInstanceOf(AdditionalNotebookError);
	});

	it('returns the body on success', async () => {
		respond(200, { status: 'loaded', port: 2718 });
		await expect(loadNotebook('nb-1')).resolves.toEqual({ status: 'loaded', port: 2718 });
	});
});

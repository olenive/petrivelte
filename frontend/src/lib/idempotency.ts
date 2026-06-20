/**
 * Idempotency-key helpers for state-changing API calls.
 *
 * The control plane and workers between them dedupe retries that arrive
 * with the same ``X-Idempotency-Key`` header. Use this module to attach
 * a fresh key per logical user action and reuse the same key across any
 * retry of that action.
 *
 * Pattern:
 *
 *     const key = newIdempotencyKey();
 *     await post('/api/nets/.../execution/step', {}, withIdempotency(key));
 *     // ...if network drop, retry with the same `key`...
 *
 * For Auto Step (one logical action per tick), generate a fresh key per
 * tick — each tick IS a distinct step and should NOT dedupe across
 * ticks.
 *
 * For a single user click (Step button, Reset button, etc.), keep the
 * key in a ref/closure across any retries of that one click. If the
 * user clicks again, that's a new logical action — new key.
 */

export const IDEMPOTENCY_HEADER = 'X-Idempotency-Key';

/**
 * Mint a fresh idempotency key. Uses ``crypto.randomUUID`` (available
 * in every modern browser and in the SvelteKit server environment).
 *
 * UUIDs are globally unique; per-net or per-worker scoping is
 * unnecessary at this layer. The worker cache keys on the UUID
 * directly.
 */
export function newIdempotencyKey(): string {
	return crypto.randomUUID();
}

/**
 * Build a headers object that attaches the given idempotency key.
 *
 * Shape matches what ``fetch``/``api.ts`` accept as the ``headers``
 * field. Wrap any extra headers your call needs:
 *
 *     withIdempotency(key, { 'Content-Type': 'application/json' })
 */
export function withIdempotency(
	key: string,
	extraHeaders: Record<string, string> = {},
): Record<string, string> {
	return { ...extraHeaders, [IDEMPOTENCY_HEADER]: key };
}

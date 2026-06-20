/**
 * Track in-flight API requests that have exceeded a "this is taking a
 * while" threshold so the UI can surface a non-blocking toast.
 *
 * Why: the first request after a worker has been idle hits a Fly machine
 * suspend/resume cold start (~15-20s). Without feedback the user clicks
 * a button and sees nothing change, assumes the app is broken, and
 * clicks again. The toast gives them a clear "still working, worker is
 * waking up" affordance.
 *
 * Usage: every API call wrapper (see ``api.ts``) calls
 * ``markRequestStart()`` and invokes the returned cleanup in a finally
 * block. After the threshold the request is counted in the store; once
 * it settles the count drops back down. ``slowRequestCount`` is the
 * read-only subscribe-able count.
 */

import { writable } from 'svelte/store';

const THRESHOLD_MS = 1500;

const _slowCount = writable(0);

export const slowRequestCount = { subscribe: _slowCount.subscribe };

/**
 * Begin tracking a request. Returns a cleanup that the caller must run
 * when the request settles (success or failure). If the request settles
 * before ``THRESHOLD_MS`` the cleanup is a no-op on the store; otherwise
 * it decrements the count.
 */
export function markRequestStart(): () => void {
	// Server-side rendering — no window, nothing to do.
	if (typeof window === 'undefined') return () => {};

	let counted = false;
	const timer = window.setTimeout(() => {
		counted = true;
		_slowCount.update((n) => n + 1);
	}, THRESHOLD_MS);

	return () => {
		window.clearTimeout(timer);
		if (counted) {
			_slowCount.update((n) => Math.max(0, n - 1));
		}
	};
}

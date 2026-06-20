/**
 * Classify recent API outcomes into a *named* backend condition so the UI
 * can say "responding slowly", "rate limited", or "unreachable" instead of
 * a generic spinner.
 *
 * Claim only what we can verify. Three conditions are backed by the server's
 * own answer: ``rate_limited`` (HTTP 429), ``unreachable`` (the request threw
 * or returned 502/503/504), and ``degraded_db`` (the CP set
 * ``X-Backend-Slow: db`` because its own database pool-acquire was slow — so
 * naming the database is a fact, not a guess). The remaining latency-based
 * ``degraded``/``slow`` conditions only know that responses are slow — NOT
 * *why* — so they describe the observation and never attribute it to a
 * specific subsystem.
 *
 * Why client-side classification (not a backend status endpoint): the
 * conditions we most want to name are exactly when the backend is slow or
 * unreachable — precisely when a status endpoint would itself be slow or
 * fail. Every signal we need is already on the response the api client
 * holds: the HTTP status, the ``Server-Timing`` backend duration, and
 * whether ``fetch`` threw. So we derive the condition from outcomes we
 * already see, with zero backend dependency.
 *
 * Anti-flap: a bad outcome sets the condition immediately; a good outcome
 * only clears it after ``RECOVERY_MS`` of calm, so one lucky fast response
 * mid-wave doesn't blink the banner off and back on.
 */

import { writable } from 'svelte/store';

export type BackendConditionKind =
	| 'ok'
	| 'slow'
	| 'degraded'
	| 'degraded_db'
	| 'rate_limited'
	| 'unreachable';

export interface BackendCondition {
	kind: BackendConditionKind;
	title: string;
	detail: string;
}

const _OK: BackendCondition = { kind: 'ok', title: '', detail: '' };

const _MESSAGES: Record<Exclude<BackendConditionKind, 'ok'>, Omit<BackendCondition, 'kind'>> = {
	unreachable: {
		title: 'Backend unreachable',
		detail:
			"The control plane or worker isn't responding — usually a brief Fly " +
			'networking blip. Requests are being retried.',
	},
	rate_limited: {
		// Verifiable: the server explicitly returned HTTP 429.
		title: 'Rate limited',
		detail:
			'The server returned "too many requests" — usually too many ' +
			'infrastructure operations at once. Normally clears within a minute.',
	},
	degraded_db: {
		// VERIFIED, not guessed: the CP set X-Backend-Slow: db, meaning its
		// own database pool-acquire was slow for this request. Safe to name
		// the database as the cause.
		title: 'Backend degraded (database)',
		detail:
			'The control plane is waiting on the database — connection acquires ' +
			'are slow. Requests are still succeeding but may take 20–40s.',
	},
	degraded: {
		// Inferred from latency only. We can see that responses are slow, but
		// NOT which subsystem is to blame, so we describe the observation and
		// do not name a cause (e.g. "database") we cannot verify here.
		title: 'Backend responding slowly',
		detail:
			'The control plane is taking much longer than usual to respond. ' +
			'Requests are still succeeding but may take 20–40s.',
	},
	slow: {
		title: 'Backend slow',
		detail:
			'Requests are taking longer than usual. Often a worker waking from ' +
			'idle (~20s cold start).',
	},
};

// A backend dur (Server-Timing) at/above this is "degraded" — the DB-churn
// waves we've seen put every endpoint in the 15–40s range. Below it but
// still sluggish counts as merely "slow" (cold-start territory).
const _DEGRADED_BACKEND_MS = 8000;
const _SLOW_BACKEND_MS = 3000;
// How long the backend must stay calm before we clear a named condition.
const _RECOVERY_MS = 5000;

const _condition = writable<BackendCondition>(_OK);
export const backendCondition = { subscribe: _condition.subscribe };

let _clearTimer: ReturnType<typeof setTimeout> | null = null;

function _set(kind: Exclude<BackendConditionKind, 'ok'>): void {
	if (_clearTimer) {
		clearTimeout(_clearTimer);
		_clearTimer = null;
	}
	_condition.set({ kind, ..._MESSAGES[kind] });
}

function _scheduleClear(): void {
	if (typeof window === 'undefined') return;
	if (_clearTimer) return; // already counting down
	_clearTimer = setTimeout(() => {
		_clearTimer = null;
		_condition.set(_OK);
	}, _RECOVERY_MS);
}

/**
 * Feed one settled request outcome into the classifier. Streaming/long-lived
 * paths should NOT be reported (they're intentionally slow). Called from the
 * api client's timing wrapper.
 */
export function reportOutcome(o: {
	threw?: boolean;
	status?: number;
	backendMs?: number | null;
	/**
	 * The endpoint is *expected* to be long-running (load / provision /
	 * lifecycle), so its high backend duration must NOT be read as database
	 * degradation — that's normal cold-start / dep-install time. Hard
	 * failures (throw / 5xx / 429) on these paths are still classified.
	 */
	expectSlow?: boolean;
	/**
	 * The CP reported (via X-Backend-Slow: db) that its own database
	 * pool-acquire was slow for this request — a *verified* DB-pressure
	 * signal, safe to name the database. Outranks latency-based inference.
	 */
	dbSlow?: boolean;
}): void {
	if (typeof window === 'undefined') return;

	let kind: BackendConditionKind = 'ok';
	if (o.threw) {
		kind = 'unreachable';
	} else if (o.status === 502 || o.status === 503 || o.status === 504) {
		kind = 'unreachable';
	} else if (o.status === 429) {
		kind = 'rate_limited';
	} else if (o.dbSlow) {
		// Verified by the backend — name the database.
		kind = 'degraded_db';
	} else if ((o.backendMs ?? 0) >= _DEGRADED_BACKEND_MS) {
		// NB: latency only tells us the backend is slow, NOT *why*. We do not
		// attribute it to a specific subsystem (database, etc.) — that would
		// be an unverified claim. See the 'degraded' message.
		kind = 'degraded';
	} else if ((o.backendMs ?? 0) >= _SLOW_BACKEND_MS) {
		kind = 'slow';
	}

	// Latency on a known-slow endpoint is expected, not degradation — leave
	// the store untouched so only the generic "Still working…" toast shows.
	// A VERIFIED db signal (degraded_db) is real even on a load endpoint, so
	// it is NOT suppressed here; only the latency-inferred kinds are.
	if (o.expectSlow && (kind === 'degraded' || kind === 'slow')) {
		return;
	}

	if (kind === 'ok') {
		_scheduleClear();
	} else {
		_set(kind);
	}
}

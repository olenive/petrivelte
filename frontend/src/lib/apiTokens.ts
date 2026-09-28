/**
 * Pure helpers for showing personal API tokens on the Settings page.
 * Every function takes `nowMs` so the wording is deterministic in tests.
 */

import type { ApiToken, ApiTokenScope } from '$lib/api';

export type ApiTokenStatus = 'active' | 'expiring' | 'expired' | 'revoked';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A token counts as expiring when it has this many days or fewer left. */
export const EXPIRING_WITHIN_DAYS = 30;

export const EXPIRY_CHOICES: readonly { days: number; label: string }[] = [
	{ days: 30, label: '30 days' },
	{ days: 90, label: '90 days' },
	{ days: 365, label: '1 year' },
];

export const DEFAULT_EXPIRY_DAYS = 365;

export function tokenLabel(prefix: string): string {
	return `petri_pat_${prefix}…`;
}

export function tokenStatus(token: ApiToken, nowMs: number): ApiTokenStatus {
	if (token.revoked_at) return 'revoked';
	const remaining = Date.parse(token.expires_at) - nowMs;
	if (remaining <= 0) return 'expired';
	if (remaining <= EXPIRING_WITHIN_DAYS * DAY_MS) return 'expiring';
	return 'active';
}

function plural(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Whole units of the largest scale that fits: days, hours, then minutes. */
export function describeSpan(ms: number): string {
	const abs = Math.abs(ms);
	if (abs >= DAY_MS) return plural(Math.floor(abs / DAY_MS), 'day');
	if (abs >= HOUR_MS) return plural(Math.floor(abs / HOUR_MS), 'hour');
	if (abs >= MINUTE_MS) return plural(Math.floor(abs / MINUTE_MS), 'minute');
	return 'less than a minute';
}

export function describeExpiry(token: ApiToken, nowMs: number): string {
	if (token.revoked_at) return 'revoked';
	const remaining = Date.parse(token.expires_at) - nowMs;
	return remaining > 0
		? `expires in ${describeSpan(remaining)}`
		: `expired ${describeSpan(remaining)} ago`;
}

export function describeLastUsed(token: ApiToken, nowMs: number): string {
	if (!token.last_used_at) return 'never used';
	const ago = nowMs - Date.parse(token.last_used_at);
	return ago < MINUTE_MS ? 'used just now' : `used ${describeSpan(ago)} ago`;
}

export function formatCreated(token: ApiToken): string {
	return new Date(token.created_at).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

/**
 * The scopes offered when creating a token, narrowest first. The wording
 * follows the server's rule in petritype_server/auth/scopes.py: manage is
 * every DELETE plus creating, provisioning and destroying workers, connecting
 * a GitHub repository and triggering its build; operate is every other write.
 */
export const SCOPE_CHOICES: readonly { scope: ApiTokenScope; description: string }[] = [
	{ scope: 'read', description: 'GET requests only: see everything, change nothing' },
	{
		scope: 'operate',
		description:
			'start, stop, reset, inject, create and edit nets and notebooks: everything except deletes and creating workers or repositories',
	},
	{
		scope: 'manage',
		description:
			'everything, including every delete, creating, provisioning and destroying workers, connecting repositories and starting builds',
	},
];

/** The narrowest scope is the default, matching the server. */
export const DEFAULT_SCOPE: ApiTokenScope = 'read';

/** One line saying what a scope allows; an unknown scope is shown as itself. */
export function describeScope(scope: string): string {
	return SCOPE_CHOICES.find((c) => c.scope === scope)?.description ?? scope;
}

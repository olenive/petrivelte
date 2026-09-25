import { describe, expect, it } from 'vitest';
import type { ApiToken } from './api';
import {
	DEFAULT_EXPIRY_DAYS,
	EXPIRY_CHOICES,
	describeExpiry,
	describeLastUsed,
	tokenLabel,
	tokenStatus,
} from './apiTokens';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function token(overrides: Partial<ApiToken> = {}): ApiToken {
	return {
		id: 't1',
		name: 'laptop scripts',
		prefix: 'abcd1234',
		created_at: iso(NOW - 10 * DAY),
		expires_at: iso(NOW + 212 * DAY),
		last_used_at: null,
		revoked_at: null,
		...overrides,
	};
}

describe('tokenLabel', () => {
	it('shows the fixed prefix, the stored prefix and an ellipsis', () => {
		expect(tokenLabel('abcd1234')).toBe('petri_pat_abcd1234…');
	});
});

describe('tokenStatus', () => {
	it('is active with more than 30 days left', () => {
		expect(tokenStatus(token({ expires_at: iso(NOW + 30 * DAY + 1) }), NOW)).toBe('active');
	});

	it('is expiring at exactly 30 days left', () => {
		expect(tokenStatus(token({ expires_at: iso(NOW + 30 * DAY) }), NOW)).toBe('expiring');
	});

	it('is expiring one millisecond before expiry', () => {
		expect(tokenStatus(token({ expires_at: iso(NOW + 1) }), NOW)).toBe('expiring');
	});

	it('is expired at the expiry instant and after', () => {
		expect(tokenStatus(token({ expires_at: iso(NOW) }), NOW)).toBe('expired');
		expect(tokenStatus(token({ expires_at: iso(NOW - DAY) }), NOW)).toBe('expired');
	});

	it('is revoked whatever the expiry says', () => {
		expect(tokenStatus(token({ revoked_at: iso(NOW - HOUR) }), NOW)).toBe('revoked');
		expect(
			tokenStatus(token({ revoked_at: iso(NOW - HOUR), expires_at: iso(NOW - DAY) }), NOW),
		).toBe('revoked');
	});
});

describe('describeExpiry', () => {
	it('counts whole days ahead', () => {
		expect(describeExpiry(token(), NOW)).toBe('expires in 212 days');
		expect(describeExpiry(token({ expires_at: iso(NOW + DAY + 5 * HOUR) }), NOW)).toBe(
			'expires in 1 day',
		);
	});

	it('drops to hours and minutes on the last day', () => {
		expect(describeExpiry(token({ expires_at: iso(NOW + 5 * HOUR) }), NOW)).toBe(
			'expires in 5 hours',
		);
		expect(describeExpiry(token({ expires_at: iso(NOW + MINUTE) }), NOW)).toBe(
			'expires in 1 minute',
		);
	});

	it('counts back once expired', () => {
		expect(describeExpiry(token({ expires_at: iso(NOW - 3 * DAY) }), NOW)).toBe(
			'expired 3 days ago',
		);
	});

	it('says revoked for a revoked token', () => {
		expect(describeExpiry(token({ revoked_at: iso(NOW) }), NOW)).toBe('revoked');
	});
});

describe('describeLastUsed', () => {
	it('says never used when there is no timestamp', () => {
		expect(describeLastUsed(token(), NOW)).toBe('never used');
	});

	it('says just now under a minute', () => {
		expect(describeLastUsed(token({ last_used_at: iso(NOW - 10_000) }), NOW)).toBe(
			'used just now',
		);
	});

	it('uses the largest whole unit', () => {
		expect(describeLastUsed(token({ last_used_at: iso(NOW - 2 * HOUR) }), NOW)).toBe(
			'used 2 hours ago',
		);
		expect(describeLastUsed(token({ last_used_at: iso(NOW - 45 * MINUTE) }), NOW)).toBe(
			'used 45 minutes ago',
		);
		expect(describeLastUsed(token({ last_used_at: iso(NOW - DAY) }), NOW)).toBe(
			'used 1 day ago',
		);
	});
});

describe('EXPIRY_CHOICES', () => {
	it('offers 30, 90 and 365 days and defaults to the year', () => {
		expect(EXPIRY_CHOICES.map((c) => c.days)).toEqual([30, 90, 365]);
		expect(EXPIRY_CHOICES.every((c) => c.label.length > 0)).toBe(true);
		expect(EXPIRY_CHOICES.some((c) => c.days === DEFAULT_EXPIRY_DAYS)).toBe(true);
	});
});

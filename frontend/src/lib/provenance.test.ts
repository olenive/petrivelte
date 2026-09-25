import { describe, expect, it } from 'vitest';

import type { DeploymentSummary } from './api';
import {
	formatDeploymentDate,
	formatDeploymentTime,
	newerMarker,
	provenanceChip,
	provenanceSuffix,
	shortCommit,
	upgradeAction,
} from './provenance';

const CURRENT: DeploymentSummary = {
	id: 'dep-old',
	git_commit: 'abc1234def5678abc1234def5678abc1234def56',
	git_commit_short: 'abc1234',
	git_ref: 'main',
	created_at: '2026-09-20T23:30:00Z',
	build_status: 'success',
};

const NEWER: DeploymentSummary = {
	id: 'dep-new',
	git_commit: 'fe958d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	git_commit_short: 'fe958d0',
	git_ref: 'main',
	created_at: '2026-09-25T10:04:00+00:00',
	build_status: 'success',
};

describe('dates', () => {
	it('prints the deployment date in UTC, whatever the offset it came with', () => {
		expect(formatDeploymentDate('2026-09-20T23:30:00Z')).toBe('2026-09-20');
		expect(formatDeploymentDate('2026-09-21T01:30:00+02:00')).toBe('2026-09-20');
		expect(formatDeploymentTime('2026-09-25T10:04:00+00:00')).toBe('2026-09-25 10:04 UTC');
	});

	it('gives null for an instant that does not parse', () => {
		expect(formatDeploymentDate('not a date')).toBeNull();
		expect(formatDeploymentTime(null)).toBeNull();
	});
});

describe('shortCommit', () => {
	it("prefers the server's short commit", () => {
		expect(shortCommit(CURRENT)).toBe('abc1234');
	});

	it('cuts the full commit when no short one came', () => {
		expect(shortCommit({ ...CURRENT, git_commit_short: null })).toBe('abc1234');
	});

	it('falls back to the ref for a build that recorded no commit', () => {
		expect(shortCommit({ ...CURRENT, git_commit: null, git_commit_short: null })).toBe('main');
	});
});

describe('provenanceChip', () => {
	it('shows the short commit and the deployment date', () => {
		expect(provenanceChip(CURRENT)?.text).toBe('abc1234 · 2026-09-20');
	});

	it('puts the ref, the full commit and the build time in the tooltip', () => {
		const title = provenanceChip(CURRENT)!.title;
		expect(title).toContain('ref: main');
		expect(title).toContain(`commit: ${CURRENT.git_commit}`);
		expect(title).toContain('built: 2026-09-20 23:30 UTC');
		expect(title).toContain('deployment: dep-old');
	});

	it('drops the date rather than printing garbage', () => {
		expect(provenanceChip({ ...CURRENT, created_at: '' })?.text).toBe('abc1234');
	});

	it('says so when the deployment row is gone', () => {
		expect(provenanceChip(null)?.text).toBe('deployment gone');
	});

	it('shows nothing when the control plane does not report provenance', () => {
		expect(provenanceChip(undefined)).toBeNull();
	});
});

describe('newerMarker', () => {
	it('names the newer commit', () => {
		const marker = newerMarker(NEWER)!;
		expect(marker.text).toBe('newer code: fe958d0');
		expect(marker.title).toContain('built: 2026-09-25 10:04 UTC');
	});

	it('is absent when there is no newer deployment', () => {
		expect(newerMarker(null)).toBeNull();
		expect(newerMarker(undefined)).toBeNull();
	});
});

describe('provenanceSuffix', () => {
	it('joins the chip and the marker as plain text', () => {
		expect(provenanceSuffix({ deployment: CURRENT, newer_deployment: NEWER })).toBe(
			' · abc1234 · 2026-09-20 · newer code: fe958d0',
		);
	});

	it('is empty when nothing is reported', () => {
		expect(provenanceSuffix({})).toBe('');
	});
});

describe('upgradeAction', () => {
	const base = {
		worker_id: 'w-1',
		load_state: 'loaded',
		deployment: CURRENT,
		newer_deployment: NEWER,
	};

	it('is enabled with newer code on an assigned notebook, and names the target', () => {
		const action = upgradeAction(base);
		expect(action.enabled).toBe(true);
		expect(action.reason).toContain('fe958d0');
	});

	it('is enabled for an unloaded notebook too: the upgrade ends in a load', () => {
		expect(upgradeAction({ ...base, load_state: 'unloaded' }).enabled).toBe(true);
	});

	it('is disabled with a reason for an unassigned notebook, even with newer code', () => {
		const action = upgradeAction({ ...base, worker_id: null });
		expect(action.enabled).toBe(false);
		expect(action.reason).toMatch(/not assigned to a worker/i);
	});

	it('is disabled when there is nothing newer', () => {
		const action = upgradeAction({ ...base, newer_deployment: null });
		expect(action.enabled).toBe(false);
		expect(action.reason).toMatch(/newest deployment/);
	});

	it('is disabled while a load is in flight', () => {
		expect(upgradeAction({ ...base, load_state: 'loading' }).enabled).toBe(false);
	});
});

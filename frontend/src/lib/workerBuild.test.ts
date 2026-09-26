import { describe, expect, it } from 'vitest';

import type { ControlPlaneBuild } from './api';
import { buildChip, controlPlaneShort, rollCommand, shortCommit } from './workerBuild';

const CP: ControlPlaneBuild = {
	commit: 'fe958d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	short: 'fe958d0',
	built_at: '2026-09-26T10:00:00Z',
};

const WORKER_COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

describe('shortCommit', () => {
	it('takes the first seven characters', () => {
		expect(shortCommit(WORKER_COMMIT)).toBe('abc1234');
	});
	it('is null for null, undefined and blank', () => {
		expect(shortCommit(null)).toBeNull();
		expect(shortCommit(undefined)).toBeNull();
		expect(shortCommit('  ')).toBeNull();
	});
});

describe('controlPlaneShort', () => {
	it('prefers the short field, else cuts the commit', () => {
		expect(controlPlaneShort(CP)).toBe('fe958d0');
		expect(controlPlaneShort({ ...CP, short: null })).toBe('fe958d0');
	});
	it('is null when the build is unknown or absent', () => {
		expect(controlPlaneShort({ commit: null, short: null, built_at: null })).toBeNull();
		expect(controlPlaneShort(null)).toBeNull();
		expect(controlPlaneShort(undefined)).toBeNull();
	});
});

describe('buildChip', () => {
	it('matching build: muted chip with the full commit and first-seen time, no marker', () => {
		const view = buildChip(
			{
				fly_machine_id: 'e82d10edf69738',
				build_commit: CP.commit,
				build_seen_at: '2026-09-26T10:04:00Z',
				build_matches_control_plane: true,
			},
			CP,
		);
		expect(view.chip).toEqual({
			label: 'fe958d0',
			tooltip: `Build ${CP.commit}\nfirst seen 2026-09-26 10:04 UTC`,
			tone: 'muted',
		});
		expect(view.marker).toBeNull();
	});

	it('mismatched build: amber marker carrying the exact roll command', () => {
		const view = buildChip(
			{
				fly_machine_id: 'e82d10edf69738',
				build_commit: WORKER_COMMIT,
				build_seen_at: '2026-09-20T08:00:00Z',
				build_matches_control_plane: false,
			},
			CP,
		);
		expect(view.chip.label).toBe('abc1234');
		expect(view.marker).toEqual({
			label: 'roll owed',
			tooltip:
				'This worker runs a different build from the control plane (fe958d0). Roll it in place:\n' +
				'fly machine update e82d10edf69738 -a petri-workers --image registry.fly.io/petri-workers:fe958d0',
			tone: 'warn',
		});
		expect(rollCommand('e82d10edf69738', 'fe958d0')).toBe(
			'fly machine update e82d10edf69738 -a petri-workers --image registry.fly.io/petri-workers:fe958d0',
		);
	});

	it('mismatch with no Fly machine: marker without a command', () => {
		const view = buildChip(
			{ fly_machine_id: null, build_commit: WORKER_COMMIT, build_matches_control_plane: false },
			CP,
		);
		expect(view.marker?.tooltip).toBe(
			'This worker runs a different build from the control plane (fe958d0).',
		);
	});

	it('unknown worker build: "build unknown" chip, no marker', () => {
		const view = buildChip(
			{
				fly_machine_id: 'm1',
				build_commit: null,
				build_seen_at: null,
				build_matches_control_plane: null,
			},
			CP,
		);
		expect(view.chip).toEqual({
			label: 'build unknown',
			tooltip:
				'This worker has not reported its build; it predates build identity or has not been polled yet.',
			tone: 'muted',
		});
		expect(view.marker).toBeNull();
	});

	it('unknown control plane build: chip still shows, no marker', () => {
		const view = buildChip(
			{
				fly_machine_id: 'm1',
				build_commit: WORKER_COMMIT,
				build_seen_at: '2026-09-20T08:00:00Z',
				build_matches_control_plane: null,
			},
			{ commit: null, short: null, built_at: null },
		);
		expect(view.chip.label).toBe('abc1234');
		expect(view.marker).toBeNull();
	});

	it('fields absent entirely: reads as unknown', () => {
		const view = buildChip({ fly_machine_id: 'm1' }, undefined);
		expect(view.chip.label).toBe('build unknown');
		expect(view.marker).toBeNull();
	});
});

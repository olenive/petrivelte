/**
 * A worker's ceiling has to be legible before a user can be asked to respect it.
 *
 * A notebook subprocess is ~190MB, the largest process on a worker, so the
 * default 512MB machine holds one and a 1024MB machine holds two. Until
 * 2026-08-06 none of that was visible: the worker reported memory for nets
 * only, so the gauge omitted the biggest consumer and always read low.
 *
 * The cases below are the ones where getting it wrong is expensive — chiefly
 * "we cannot see the worker", which must never be reported as room to spare.
 */

import { describe, expect, it } from 'vitest';
import type { OccupancyNotebook, WorkerOccupancy } from '$lib/api';
import {
	NOTEBOOK_COST_MB,
	dismissalKey,
	occupancyLevel,
	occupancySummary,
	otherNotebooks,
	predictedCostMb,
	predictedFreeMb,
	sameDefinitionCount,
	shouldWarn,
	usedMb,
} from './notebookOccupancy';

function nb(
	id: string,
	definition: string,
	rss: number,
	peak = rss,
): OccupancyNotebook {
	return {
		notebook_id: id,
		definition_name: definition,
		instance_name: null,
		pid: 1,
		rss_mb: rss,
		peak_rss_mb: peak,
	};
}

function occupancy(
	notebooks: OccupancyNotebook[],
	availableMb: number | null = 400,
	totalMb: number | null = 984,
): WorkerOccupancy {
	return {
		reachable: true,
		reason: null,
		memory: { container_available_mb: availableMb, container_total_mb: totalMb },
		nets: [],
		notebooks,
	};
}

const UNREACHABLE: WorkerOccupancy = {
	reachable: false,
	reason: 'worker_unreachable',
	memory: {},
	nets: [],
	notebooks: [],
};

describe('what else is running', () => {
	it('excludes the notebook being viewed', () => {
		const occ = occupancy([nb('nb-1', 'parcels', 188), nb('nb-2', 'daily', 96)]);

		expect(otherNotebooks(occ, 'nb-1').map((n) => n.notebook_id)).toEqual(['nb-2']);
	});

	it('counts instances of the same notebook by definition, not by id', () => {
		// Two instances of one notebook is the case the banner names, and they
		// share a definition while differing in every id.
		const occ = occupancy([nb('nb-1', 'parcels', 188), nb('nb-2', 'parcels', 190)]);

		expect(sameDefinitionCount(occ, 'parcels')).toBe(2);
	});

	it('reports nothing running when the worker cannot be reached', () => {
		// Not an assertion about emptiness — an unreachable worker has no
		// inventory to report, and callers gate on `reachable` before reading it.
		expect(otherNotebooks(UNREACHABLE, 'nb-1')).toEqual([]);
		expect(shouldWarn(UNREACHABLE)).toBe(false);
	});
});

describe('predicting what another instance costs', () => {
	it('prefers a running instance of the same notebook', () => {
		// Same code and same imports, so its observed peak is a measurement
		// rather than a guess.
		const occ = occupancy([nb('nb-1', 'parcels', 180, 195), nb('nb-2', 'daily', 300, 320)]);

		expect(predictedCostMb(occ, 'parcels')).toEqual({ mb: 195, source: 'same_notebook' });
	});

	it('falls back to any notebook, then to the default — and says which', () => {
		const otherOnly = occupancy([nb('nb-2', 'daily', 300, 320)]);
		expect(predictedCostMb(otherOnly, 'parcels')).toEqual({
			mb: 320,
			source: 'other_notebook',
		});

		expect(predictedCostMb(occupancy([]), 'parcels')).toEqual({
			mb: NOTEBOOK_COST_MB,
			source: 'default',
		});
	});

	it('uses peak rather than current, so a young notebook is not under-priced', () => {
		// A freshly spawned notebook has not grown into its working set; the
		// question is whether the next one still fits once it has.
		const occ = occupancy([nb('nb-1', 'parcels', 90, 195)]);

		expect(predictedCostMb(occ, 'parcels').mb).toBe(195);
	});
});

describe('whether another one fits', () => {
	it('is ok with room to spare', () => {
		const occ = occupancy([nb('nb-1', 'parcels', 188, 190)], 400);

		expect(predictedFreeMb(occ, 'parcels')).toBe(210);
		expect(occupancyLevel(occ, 'parcels')).toBe('ok');
	});

	it('is tight when the prediction goes negative', () => {
		const occ = occupancy([nb('nb-1', 'parcels', 188, 190)], 150);

		expect(predictedFreeMb(occ, 'parcels')).toBe(-40);
		expect(occupancyLevel(occ, 'parcels')).toBe('tight');
	});

	it('is unknown — never ok — when the worker cannot be read', () => {
		// The failure this whole feature exists to prevent: "cannot see" must
		// not render as "plenty of room".
		expect(occupancyLevel(UNREACHABLE, 'parcels')).toBe('unknown');
		expect(predictedFreeMb(UNREACHABLE, 'parcels')).toBeNull();
	});

	it('is unknown when the worker reports no memory figures', () => {
		// An older worker image answers /occupancy without container totals.
		const occ = occupancy([nb('nb-1', 'parcels', 188)], null, null);

		expect(occupancyLevel(occ, 'parcels')).toBe('unknown');
		expect(usedMb(occ)).toBeNull();
	});
});

describe('the banner', () => {
	it('stays silent for a single notebook', () => {
		// D2: a banner that always appears is one nobody reads.
		expect(shouldWarn(occupancy([nb('nb-1', 'parcels', 188)]))).toBe(false);
		expect(occupancySummary(occupancy([nb('nb-1', 'parcels', 188)]), 'nb-1', 'parcels'))
			.toBeNull();
	});

	it('states the instance count, the worker total and the memory', () => {
		const occ = occupancy([nb('nb-1', 'parcels', 188), nb('nb-2', 'parcels', 190)], 420);

		const summary = occupancySummary(occ, 'nb-1', 'parcels');

		expect(summary).toContain('2 instances of this notebook active');
		expect(summary).toContain('2 notebooks on this worker');
		expect(summary).toContain('564 MB of 984 MB used');
		expect(summary).toContain('420 MB free');
	});

	it('omits the instance count when the other notebook is a different one', () => {
		// Two different notebooks is not duplication — it is just occupancy, and
		// saying "2 instances of this notebook" would be false.
		const occ = occupancy([nb('nb-1', 'parcels', 188), nb('nb-2', 'daily', 96)]);

		const summary = occupancySummary(occ, 'nb-1', 'parcels');

		expect(summary).not.toContain('instances of this notebook');
		expect(summary).toContain('2 notebooks on this worker');
	});
});

describe('dismissal', () => {
	it('is keyed per instance, so another notebook re-states its own cost', () => {
		expect(dismissalKey('nb-1')).not.toEqual(dismissalKey('nb-2'));
		expect(dismissalKey('nb-1')).toContain('nb-1');
	});
});

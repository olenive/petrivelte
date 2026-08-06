/**
 * What else is running on a notebook's worker, and whether one more fits.
 *
 * A notebook subprocess is the largest process on a worker — about 190MB,
 * against the worker's own ~103MB and a net's ~54MB — so the default 512MB
 * machine has room for exactly one, and a 1024MB machine for two. That
 * ceiling used to be invisible: the worker reported memory for nets only, so
 * every gauge omitted the biggest consumer and read reassuringly low.
 *
 * Pure by design, like `notebookHealth.ts`: the interesting part is a small
 * matrix of cases, and a matrix is worth testing without a browser.
 */

import type { OccupancyNotebook, WorkerOccupancy } from '$lib/api';

/** Fallback cost of a notebook when nothing is running to measure.
 * Matches `DEFAULT_NOTEBOOK_COST_MB` in the control plane; the server's
 * number is authoritative and arrives in the 409 body. */
export const NOTEBOOK_COST_MB = 190;

/** Below this much predicted free memory, starting another notebook is
 * likely to end in an OOM kill rather than a slow page. */
export const TIGHT_FREE_MB = 0;

export type OccupancyLevel = 'ok' | 'tight' | 'unknown';

/** Notebooks running on this worker other than the one being viewed. */
export function otherNotebooks(
	occupancy: WorkerOccupancy | null,
	notebookId: string,
): OccupancyNotebook[] {
	if (!occupancy?.reachable) return [];
	return occupancy.notebooks.filter((nb) => nb.notebook_id !== notebookId);
}

/** How many instances of the *same* notebook definition are running.
 *
 * Counted by definition rather than by instance id because that is the
 * question a user asks — "is this notebook already open somewhere?" — and
 * because those instances are the ones whose measured size predicts the next
 * one's.
 */
export function sameDefinitionCount(
	occupancy: WorkerOccupancy | null,
	definitionName: string | null | undefined,
): number {
	if (!occupancy?.reachable || !definitionName) return 0;
	return occupancy.notebooks.filter((nb) => nb.definition_name === definitionName).length;
}

/** Predicted cost of starting one more instance, and where the figure came from.
 *
 * Prefers a running instance of the same notebook: same code, same imports,
 * so its observed peak is a measurement rather than a guess. Peak rather than
 * current, because a freshly spawned notebook has not yet grown into its
 * working set and quoting current RSS would under-promise the cost.
 */
export function predictedCostMb(
	occupancy: WorkerOccupancy | null,
	definitionName: string | null | undefined,
): { mb: number; source: 'same_notebook' | 'other_notebook' | 'default' } {
	const notebooks = occupancy?.reachable ? occupancy.notebooks : [];
	if (definitionName) {
		const same = notebooks.filter((nb) => nb.definition_name === definitionName);
		const peak = Math.max(0, ...same.map((nb) => nb.peak_rss_mb ?? 0));
		if (peak > 0) return { mb: peak, source: 'same_notebook' };
	}
	const anyPeak = Math.max(0, ...notebooks.map((nb) => nb.peak_rss_mb ?? 0));
	if (anyPeak > 0) return { mb: anyPeak, source: 'other_notebook' };
	return { mb: NOTEBOOK_COST_MB, source: 'default' };
}

/** Free memory expected after another notebook starts, or null if unknowable. */
export function predictedFreeMb(
	occupancy: WorkerOccupancy | null,
	definitionName: string | null | undefined,
): number | null {
	const available = occupancy?.reachable ? occupancy.memory?.container_available_mb : null;
	if (available === null || available === undefined) return null;
	return Math.round(available - predictedCostMb(occupancy, definitionName).mb);
}

/**
 * Whether another notebook fits.
 *
 * Three states, not two. `unknown` is what an unreachable worker or an image
 * too old to report occupancy produces, and it must never collapse into `ok`
 * — "we cannot see" reading as "plenty of room" is the exact failure this
 * whole feature exists to prevent.
 */
export function occupancyLevel(
	occupancy: WorkerOccupancy | null,
	definitionName: string | null | undefined,
): OccupancyLevel {
	const free = predictedFreeMb(occupancy, definitionName);
	if (free === null) return 'unknown';
	return free > TIGHT_FREE_MB ? 'ok' : 'tight';
}

/** Total memory the worker is holding, in MB, or null if not knowable. */
export function usedMb(occupancy: WorkerOccupancy | null): number | null {
	if (!occupancy?.reachable) return null;
	const total = occupancy.memory?.container_total_mb;
	const available = occupancy.memory?.container_available_mb;
	if (total === null || total === undefined) return null;
	if (available === null || available === undefined) return null;
	return Math.round(total - available);
}

/** One line for the banner: what is running, and what it costs.
 *
 * Deliberately worded as cost rather than as a mistake. Several instances is
 * a legitimate choice — different bindings, different views, two people
 * looking — and "you have duplicates" scolds a user who meant it.
 */
export function occupancySummary(
	occupancy: WorkerOccupancy | null,
	notebookId: string,
	definitionName: string | null | undefined,
): string | null {
	if (!occupancy?.reachable) return null;
	const total = occupancy.notebooks.length;
	if (total <= 1) return null;

	const sameCount = sameDefinitionCount(occupancy, definitionName);
	const parts: string[] = [];
	if (sameCount > 1) {
		parts.push(`${sameCount} instances of this notebook active`);
	}
	parts.push(`${total} notebook${total === 1 ? '' : 's'} on this worker`);

	const used = usedMb(occupancy);
	const capacity = occupancy.memory?.container_total_mb;
	if (used !== null && capacity) {
		const free = Math.round(capacity - used);
		parts.push(`${used} MB of ${Math.round(capacity)} MB used · ${free} MB free`);
	}
	return parts.join(' · ');
}

/** Whether the banner should be shown at all, before dismissal is considered. */
export function shouldWarn(occupancy: WorkerOccupancy | null): boolean {
	return Boolean(occupancy?.reachable && occupancy.notebooks.length > 1);
}

/** sessionStorage key for a dismissed banner.
 *
 * Per tab and per instance on purpose: a new tab re-states the cost, because
 * a warning permanently dismissed is a warning that does not exist.
 */
export function dismissalKey(notebookId: string): string {
	return `nb-occupancy-dismissed:${notebookId}`;
}

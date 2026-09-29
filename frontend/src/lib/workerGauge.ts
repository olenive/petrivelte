/**
 * What the workers page memory gauge shows for one worker.
 *
 * The live reading is the worker's ``memory_stats`` snapshot, which arrives on
 * its event stream every 5 seconds and breaks the total down by net and
 * notebook. Until the first one arrives, the gauge shows what the control
 * plane's health loop last stored on the worker row (``memory_used_mb``).
 * That figure is the RSS of the worker's own server process, read from
 * ``/proc/self/status``: it leaves out every net and notebook subprocess, so
 * it is a lower bound on what the worker uses and carries no breakdown. The
 * page labels it as such and shows no per-net figures from it.
 */

import type { Worker } from '$lib/api';
import { workerMemoryUsedMb, type WorkerMemorySnapshot } from '$lib/stores/workerMemory';

export type GaugeWorker = Pick<Worker, 'status' | 'memory_mb' | 'memory_used_mb' | 'memory_peak_mb'>;

export interface GaugeReading {
	/** ``snapshot``: the live reading with its breakdown. ``health_check``:
	 *  the worker process alone, from the worker list, until a snapshot. */
	source: 'snapshot' | 'health_check';
	usedMb: number;
	limitMb: number;
	/** 0 to 100. */
	percent: number;
	/** The worker process's peak RSS; only the health check reports one. */
	peakMb: number | null;
}

function percentOf(usedMb: number, limitMb: number): number {
	return limitMb > 0 ? Math.min(100, Math.max(0, (usedMb / limitMb) * 100)) : 0;
}

/**
 * The snapshot when there is one; otherwise the worker list's figure for a
 * ready worker; otherwise nothing. A worker that is not ready keeps the figure
 * from its last health check, which describes a machine no longer running.
 */
export function gaugeReading(
	snapshot: WorkerMemorySnapshot | undefined,
	worker: GaugeWorker,
): GaugeReading | null {
	if (snapshot) {
		const usedMb = workerMemoryUsedMb(snapshot);
		const limitMb = snapshot.container_total_mb ?? worker.memory_mb;
		return { source: 'snapshot', usedMb, limitMb, percent: percentOf(usedMb, limitMb), peakMb: null };
	}
	const usedMb = worker.memory_used_mb;
	if (worker.status !== 'ready' || usedMb === null || usedMb === undefined) return null;
	const limitMb = worker.memory_mb;
	return {
		source: 'health_check',
		usedMb,
		limitMb,
		percent: percentOf(usedMb, limitMb),
		peakMb: worker.memory_peak_mb ?? null,
	};
}

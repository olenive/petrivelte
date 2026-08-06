/**
 * Per-worker memory snapshot store.
 *
 * Populated from the worker's unified event stream (the same one
 * `connectRuntimeLogs` already opens), filtered for scope='worker'
 * kind='memory_stats'. Phase 1 of memory visibility — no soft
 * pre-emption yet, just letting the UI surface where RAM is going.
 */

import { writable } from 'svelte/store';

export interface WorkerMemoryNet {
	net_id: string;
	pid: number;
	rss_mb: number;
	peak_rss_mb: number;
}

export interface WorkerMemoryNotebook {
	notebook_id: string;
	definition_name: string | null;
	pid: number;
	rss_mb: number;
	peak_rss_mb: number;
}

export interface WorkerMemorySnapshot {
	parent_rss_mb: number | null;
	parent_peak_rss_mb: number | null;
	container_total_mb: number | null;
	container_available_mb: number | null;
	nets: WorkerMemoryNet[];
	/** Optional: workers older than 2026-08-06 do not report notebooks.
	 * Absent is not the same as empty — see `workerMemoryUsedMb`. */
	notebooks?: WorkerMemoryNotebook[];
}

/** Total RSS attributed to a worker, in MB.
 *
 * Notebooks were missing from this sum until 2026-08-06, and a notebook
 * subprocess is the single largest process on a worker — 188MB against the
 * worker's own 103MB and a net's 54MB. So the gauge under-reported by more
 * than the worker itself, always downward, on exactly the machines where the
 * next notebook is the difference between working and an OOM kill.
 */
export function workerMemoryUsedMb(snap: WorkerMemorySnapshot): number {
	const nets = snap.nets.reduce((sum, n) => sum + n.rss_mb, 0);
	const notebooks = (snap.notebooks ?? []).reduce((sum, n) => sum + n.rss_mb, 0);
	return (snap.parent_rss_mb ?? 0) + nets + notebooks;
}

const _memory = writable<Map<string, WorkerMemorySnapshot>>(new Map());

export const workerMemoryStore = { subscribe: _memory.subscribe };

export function setWorkerMemory(workerId: string, snap: WorkerMemorySnapshot): void {
	_memory.update((m) => {
		const next = new Map(m);
		next.set(workerId, snap);
		return next;
	});
}

export function clearWorkerMemory(workerId: string): void {
	_memory.update((m) => {
		const next = new Map(m);
		next.delete(workerId);
		return next;
	});
}

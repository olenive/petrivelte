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

export interface WorkerMemorySnapshot {
	parent_rss_mb: number | null;
	parent_peak_rss_mb: number | null;
	container_total_mb: number | null;
	container_available_mb: number | null;
	nets: WorkerMemoryNet[];
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

/**
 * Shared worker log store.
 *
 * Single source of truth for per-worker log lines. Both the inline
 * LogViewer on the workers page and the full-page log viewer read
 * from (and write to) this store, so they always show the same data.
 *
 * Logs are populated from two sources:
 *   1. Backend history  — fetched once per worker via the REST endpoint
 *   2. Live SSE events  — appended in real time as they arrive
 */

import { writable, get } from 'svelte/store';
import { getWorkerLogHistory, listNets, type Net } from '$lib/api';
import { serverEventsStore, type ServerEvent } from '$lib/stores/serverEvents';

// ---- internal state ----

/** Formatted log lines per worker. */
const _logs = writable<Map<string, string[]>>(new Map());

/** Workers for which we have already loaded history (avoid re-fetching). */
const _historyLoaded = new Set<string>();

/** Cached nets list for resolving net_id → name. */
let _nets: Net[] = [];

// ---- helpers ----

function formatTs(ts?: string): string {
	if (!ts) return '';
	try {
		const d = new Date(ts);
		return `[${d.toISOString().slice(11, 19)}] `;
	} catch {
		return '';
	}
}

function formatHistoryEvent(evt: Record<string, any>): string {
	const ts = evt.ts ? formatTs(evt.ts) : '';
	if (evt.type === 'net_load_log') {
		const netName = _nets.find(n => n.id === evt.net_id)?.name ?? evt.net_id;
		return `${ts}[${netName}] ${evt.message ?? ''}`;
	}
	if (evt.type === 'worker_provision_log') {
		return `${ts}[provision] ${evt.message ?? ''}`;
	}
	if (evt.type === 'worker_state_changed') {
		const detail = evt.status_detail ? ` (${evt.status_detail})` : '';
		return `${ts}[worker] Status → ${evt.status}${detail}`;
	}
	return `${ts}${evt.message ?? JSON.stringify(evt)}`;
}

function appendLine(workerId: string, line: string) {
	_logs.update(m => {
		const lines = m.get(workerId) || [];
		lines.push(line);
		m.set(workerId, lines);
		return new Map(m); // new reference for reactivity
	});
}

// ---- SSE subscription (runs once at module load) ----

serverEventsStore.subscribe((event: ServerEvent | null) => {
	if (!event) return;
	const ts = event.ts;

	if (event.type === 'net_load_log') {
		const net = _nets.find(n => n.id === event.net_id);
		if (net?.worker_id) {
			appendLine(net.worker_id, `${formatTs(ts)}[${net.name}] ${event.message}`);
		}
		return;
	}

	if (event.type === 'net_state_changed') {
		const net = _nets.find(n => n.id === event.net_id);
		if (net?.worker_id) {
			appendLine(net.worker_id, `${formatTs(ts)}[${net.name}] State → ${event.load_state}`);
		}
		return;
	}

	if (event.type === 'worker_provision_log') {
		appendLine(event.worker_id, `${formatTs(ts)}[provision] ${event.message}`);
		return;
	}

	if (event.type === 'worker_state_changed') {
		const detail = event.status_detail ? ` (${event.status_detail})` : '';
		appendLine(event.worker_id, `${formatTs(ts)}[worker] Status → ${event.status}${detail}`);
	}
});

// ---- public API ----

/** Reactive store of all worker logs: Map<workerId, string[]>. */
export const workerLogsStore = { subscribe: _logs.subscribe };

/** Update the cached nets list (call after fetching nets). */
export function setNets(nets: Net[]) {
	_nets = nets;
}

/** Seed error lines from nets that failed to load (for page-load display). */
export function seedFromNetErrors(nets: Net[]) {
	const current = get(_logs);
	for (const net of nets) {
		if (net.load_state === 'error' && net.load_error && net.worker_id) {
			const lines = current.get(net.worker_id) || [];
			const errorLine = `[${net.name}] Load error: ${net.load_error}`;
			if (!lines.includes(errorLine)) {
				appendLine(net.worker_id, errorLine);
			}
		}
	}
}

/**
 * Fetch log history from the backend for a worker.
 * Only fetches once per worker (unless force=true).
 */
export async function loadHistory(workerId: string, force = false) {
	if (_historyLoaded.has(workerId) && !force) return;
	_historyLoaded.add(workerId);

	try {
		const history = await getWorkerLogHistory(workerId);
		if (history.length > 0) {
			const current = get(_logs);
			const existing = current.get(workerId) || [];
			// Only populate if we have no lines yet (avoid duplicating on re-fetch)
			if (existing.length === 0) {
				_logs.update(m => {
					m.set(workerId, history.map(formatHistoryEvent));
					return new Map(m);
				});
			}
		}
	} catch {
		// History endpoint may not be available — ignore
	}
}

/** Get lines for a specific worker (non-reactive snapshot). */
export function getLines(workerId: string): string[] {
	return get(_logs).get(workerId) || [];
}

/** Clear logs for a specific worker. */
export function clearLogs(workerId: string) {
	_logs.update(m => {
		m.delete(workerId);
		return new Map(m);
	});
	_historyLoaded.delete(workerId);
}

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
import { API_URL, getWorkerLogHistory, listNets, type Net } from '$lib/api';
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
	if (evt.type === 'net_state_changed') {
		const label = _nets.find(n => n.id === evt.net_id)?.name ?? evt.net_id;
		return `${ts}[${label}] State → ${evt.load_state}`;
	}
	return `${ts}${evt.message ?? JSON.stringify(evt)}`;
}

function appendLine(workerId: string, line: string) {
	_logs.update(m => {
		const lines = m.get(workerId) || [];
		m.set(workerId, [...lines, line]);
		return new Map(m);
	});
}

// ---- SSE subscription (runs once at module load) ----

serverEventsStore.subscribe((event: ServerEvent | null) => {
	if (!event) return;
	const ts = event.ts;

	if (event.type === 'net_load_log') {
		const net = _nets.find(n => n.id === event.net_id);
		const workerId = event.worker_id ?? net?.worker_id;
		const label = net?.name ?? event.net_id;
		if (workerId) {
			appendLine(workerId, `${formatTs(ts)}[${label}] ${event.message}`);
		}
		return;
	}

	if (event.type === 'net_state_changed') {
		const net = _nets.find(n => n.id === event.net_id);
		const workerId = event.worker_id ?? net?.worker_id;
		const label = net?.name ?? event.net_id;
		if (workerId) {
			appendLine(workerId, `${formatTs(ts)}[${label}] State → ${event.load_state}`);
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
			const formatted = history.map(formatHistoryEvent);
			_logs.update(m => {
				const existing = m.get(workerId) || [];
				if (existing.length === 0) {
					m.set(workerId, formatted);
				} else {
					// Merge: prepend history lines not already present
					const existingSet = new Set(existing);
					const newLines = formatted.filter(l => !existingSet.has(l));
					if (newLines.length > 0) {
						m.set(workerId, [...newLines, ...existing]);
					}
				}
				return new Map(m);
			});
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

// ---- Runtime log SSE (worker subprocess output) ----

interface RuntimeConnection {
	source: EventSource;
	lastSeq: number;
}
const _runtimeSources = new Map<string, RuntimeConnection>();

function formatRuntimeLine(evt: Record<string, any>): string | null {
	const ts = formatTs(evt.ts);
	const data = evt.data ?? {};

	if (evt.scope === 'worker' && evt.kind === 'log') {
		const text = typeof data.text === 'string' ? data.text : '';
		if (!text.trim()) return null;
		return `${ts}[runtime] ${text}`;
	}

	if (evt.scope === 'net') {
		const netName = _nets.find(n => n.id === evt.net_id)?.name ?? evt.net_id ?? '';
		const label = netName ? `[${netName}] ` : '';
		if (evt.kind === 'subprocess_output') {
			const text = typeof data.text === 'string' ? data.text : '';
			if (!text.trim()) return null;
			return `${ts}${label}${text}`;
		}
		if (evt.kind === 'step_error') {
			return `${ts}${label}step error: ${data.error ?? ''}`;
		}
		if (evt.kind === 'execution_stopped') {
			return `${ts}${label}execution stopped: ${data.reason ?? ''}`;
		}
	}
	return null;
}

/**
 * Connect to the unified worker event SSE stream and append log-like events
 * to the worker's log store. Returns a cleanup function.
 *
 * Tracks the last seq seen so that when EventSource auto-reconnects the
 * server can skip events we've already received.
 */
export function connectRuntimeLogs(workerId: string): () => void {
	// Avoid duplicate connections
	const existing = _runtimeSources.get(workerId);
	if (existing) existing.source.close();

	const conn: RuntimeConnection = { source: null as unknown as EventSource, lastSeq: 0 };

	const open = () => {
		const url = `${API_URL}/api/workers/${workerId}/events?after=${conn.lastSeq}`;
		const source = new EventSource(url, { withCredentials: true });
		conn.source = source;
		_runtimeSources.set(workerId, conn);

		source.onmessage = (event) => {
			try {
				const parsed = JSON.parse(event.data) as Record<string, any>;
				const seq = typeof parsed.seq === 'number' ? parsed.seq : 0;
				// Worker restart resets seq; discard local tracker in that case.
				if (seq <= conn.lastSeq) conn.lastSeq = 0;
				conn.lastSeq = Math.max(conn.lastSeq, seq);
				const line = formatRuntimeLine(parsed);
				if (line) appendLine(workerId, line);
			} catch {
				// ignore malformed events
			}
		};

		source.onerror = () => {
			if (source.readyState === EventSource.CLOSED) {
				_runtimeSources.delete(workerId);
			}
		};
	};

	open();

	return () => {
		conn.source?.close();
		_runtimeSources.delete(workerId);
	};
}

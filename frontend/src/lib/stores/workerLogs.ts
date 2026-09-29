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
import { setWorkerMemory, type WorkerMemorySnapshot } from '$lib/stores/workerMemory';
import { createBatchScheduler } from '$lib/batchScheduler';
import { advanceCursor, openCursor } from '$lib/workerStream';

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
		const netName = _nets.find(n => n.id === evt.net_id)?.instance_name ?? evt.net_id;
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
		const label = _nets.find(n => n.id === evt.net_id)?.instance_name ?? evt.net_id;
		return `${ts}[${label}] State → ${evt.load_state}`;
	}
	return `${ts}${evt.message ?? JSON.stringify(evt)}`;
}

// Lines reach the store in batches: a log viewer's stream opens with a
// replay of up to two thousand events, and one store update per line made
// both viewers re-render their whole list and scroll that many times.
const _pending = createBatchScheduler<{ workerId: string; line: string }>((items) => {
	_logs.update(m => {
		const added = new Map<string, string[]>();
		for (const { workerId, line } of items) {
			const lines = added.get(workerId) ?? [];
			lines.push(line);
			added.set(workerId, lines);
		}
		for (const [workerId, lines] of added) {
			m.set(workerId, [...(m.get(workerId) || []), ...lines]);
		}
		return new Map(m);
	});
});

function appendLine(workerId: string, line: string) {
	_pending.push({ workerId, line });
}

// ---- SSE subscription (runs once at module load) ----

serverEventsStore.subscribe((event: ServerEvent | null) => {
	if (!event) return;
	const ts = event.ts;

	if (event.type === 'net_load_log') {
		const net = _nets.find(n => n.id === event.net_id);
		const workerId = event.worker_id ?? net?.worker_id;
		const label = net?.instance_name ?? event.net_id;
		if (workerId) {
			appendLine(workerId, `${formatTs(ts)}[${label}] ${event.message}`);
		}
		return;
	}

	if (event.type === 'net_state_changed') {
		const net = _nets.find(n => n.id === event.net_id);
		const workerId = event.worker_id ?? net?.worker_id;
		const label = net?.instance_name ?? event.net_id;
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
	_pending.flushNow();
	const current = get(_logs);
	for (const net of nets) {
		if (net.load_state === 'error' && net.load_error && net.worker_id) {
			const lines = current.get(net.worker_id) || [];
			const errorLine = `[${net.instance_name}] Load error: ${net.load_error}`;
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
	_pending.flushNow();
	return get(_logs).get(workerId) || [];
}

/** Clear logs for a specific worker. */
export function clearLogs(workerId: string) {
	// Lines that arrived before the clear belong to what is being cleared.
	_pending.flushNow();
	_logs.update(m => {
		m.delete(workerId);
		return new Map(m);
	});
	_historyLoaded.delete(workerId);
}

// ---- Runtime log SSE (worker subprocess output) ----

interface RuntimeConnection {
	source: EventSource | null;
	lastSeq: number;
	haveCursor: boolean; // whether lastSeq came from this worker's stream
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	reconnectDelay: number;
	failuresSinceOpen: number; // consecutive failed attempts with no successful open
	stopped: boolean; // set by the cleanup fn to halt all further reconnects
}
const _runtimeSources = new Map<string, RuntimeConnection>();

// Auto-reconnect backoff. Without this the inline log panel silently goes
// stale after any transient drop (a CP timeout, an autosuspend bounce) while
// a freshly-opened tab looks live — a confusing UX.
const _RUNTIME_RECONNECT_BASE_MS = 1000;
const _RUNTIME_RECONNECT_MAX_MS = 30000;
// 'worker_unavailable' means the proxy can't reach the worker (e.g. it
// autosuspended). It returns when something wakes it, so retry on a steady,
// longer cadence rather than giving up permanently.
const _RUNTIME_UNAVAILABLE_RETRY_MS = 15000;
// Give up after this many consecutive attempts that never open the stream.
// EventSource hides the HTTP status, so a persistent rejection (e.g. the
// endpoint 400s because the worker isn't 'ready') looks like a normal drop —
// without a cap we'd retry it forever and spam the console. The counter
// resets on every successful open, so a flapping-but-reachable worker is
// retried indefinitely; only a never-opening one is abandoned.
const _RUNTIME_MAX_FAILURES = 6;

function formatRuntimeLine(evt: Record<string, any>): string | null {
	const ts = formatTs(evt.ts);
	const data = evt.data ?? {};

	if (evt.scope === 'worker' && evt.kind === 'log') {
		const text = typeof data.text === 'string' ? data.text : '';
		if (!text.trim()) return null;
		return `${ts}[runtime] ${text}`;
	}

	if (evt.scope === 'net') {
		const netName = _nets.find(n => n.id === evt.net_id)?.instance_name ?? evt.net_id ?? '';
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
 * The line a ``stream_gap`` marker leaves in the log. The worker sends the
 * marker in place of a replay it cannot give in full, so the lines between
 * the last one shown and the next one are missing.
 */
function gapNote(reason: string | null): string {
	const why =
		reason === 'restarted'
			? 'the worker restarted while the stream was away'
			: reason === 'evicted'
				? 'the stream was away longer than the worker keeps events'
				: 'the worker could not replay what the stream missed';
	return `${formatTs(new Date().toISOString())}[runtime] Log stream resumed; ${why}, so lines from that time are missing.`;
}

export interface RuntimeLogsOptions {
	/** Whether the first connection asks for the worker's buffered events.
	 *  The full-page log viewer does: the buffer is the only source of the
	 *  worker's runtime log history. The workers page does not: it wants
	 *  live lines and the ``memory_stats`` frames its gauges read, and a
	 *  replay per ready worker downloads each one's whole buffer (about two
	 *  thousand events) on every page load. */
	replay: boolean;
}

/**
 * Connect to the unified worker event SSE stream and append log-like events
 * to the worker's log store. Returns a cleanup function.
 *
 * Tracks the last seq seen so that a connection the store reopens after a
 * drop resumes from it and the worker replays only what was missed. The
 * option has no default: each caller says whether it wants the buffer.
 */
export function connectRuntimeLogs(workerId: string, { replay }: RuntimeLogsOptions): () => void {
	// Replace any existing connection (and stop its reconnect loop) so we
	// never leak two streams for one worker.
	const existing = _runtimeSources.get(workerId);
	if (existing) {
		existing.stopped = true;
		if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
		existing.source?.close();
	}

	const conn: RuntimeConnection = {
		source: null,
		lastSeq: 0,
		haveCursor: false,
		reconnectTimer: null,
		reconnectDelay: _RUNTIME_RECONNECT_BASE_MS,
		failuresSinceOpen: 0,
		stopped: false,
	};
	_runtimeSources.set(workerId, conn);

	const scheduleReconnect = (delay: number) => {
		if (conn.stopped || conn.reconnectTimer) return;
		conn.reconnectTimer = setTimeout(() => {
			conn.reconnectTimer = null;
			open();
		}, delay);
	};

	// A failed attempt: count it, and either retry or give up if the stream
	// has never opened despite repeated tries (likely a persistent rejection
	// such as the worker not being 'ready' — retrying just spams the console).
	const failAndReconnect = (delay: number) => {
		conn.source = null;
		conn.failuresSinceOpen += 1;
		if (conn.failuresSinceOpen > _RUNTIME_MAX_FAILURES) {
			appendLine(
				workerId,
				`${formatTs(new Date().toISOString())}[runtime] Log stream unavailable after ` +
					`${_RUNTIME_MAX_FAILURES} attempts — stopped. Reload to retry.`,
			);
			conn.stopped = true;
			return;
		}
		scheduleReconnect(delay);
	};

	const open = () => {
		if (conn.stopped) return;
		// Fixed for this EventSource, whose own automatic reconnects reuse the
		// URL: a connection opened to skip the replay keeps getting a marker
		// in place of one.
		const { after, skippedReplay } = openCursor(replay, conn.haveCursor ? conn.lastSeq : null);
		const url = `${API_URL}/api/workers/${workerId}/events?after=${after}`;
		const source = new EventSource(url, { withCredentials: true });
		conn.source = source;

		source.onopen = () => {
			// Healthy again — reset the backoff and the give-up counter so the
			// next drop retries fast and a flapping-but-reachable worker is
			// never abandoned.
			conn.reconnectDelay = _RUNTIME_RECONNECT_BASE_MS;
			conn.failuresSinceOpen = 0;
		};

		source.onmessage = (event) => {
			try {
				const parsed = JSON.parse(event.data) as Record<string, any>;
				const seq = typeof parsed.seq === 'number' ? parsed.seq : 0;
				const cursor = advanceCursor(conn.lastSeq, { seq, kind: parsed.kind, data: parsed.data }, skippedReplay);
				conn.lastSeq = cursor.lastSeq;
				conn.haveCursor = true;
				if (parsed.kind === 'stream_gap') {
					// The marker that answers a skip only seeds the cursor:
					// nothing was missed, so there is nothing to note.
					if (cursor.gap) appendLine(workerId, gapNote(cursor.gap));
					return;
				}
				// Worker-scoped memory_stats events feed the memory gauge —
				// they aren't log lines, so they bypass formatRuntimeLine.
				if (parsed.scope === 'worker' && parsed.kind === 'memory_stats' && parsed.data) {
					setWorkerMemory(workerId, parsed.data as WorkerMemorySnapshot);
					return;
				}
				const line = formatRuntimeLine(parsed);
				if (line) appendLine(workerId, line);
			} catch {
				// ignore malformed events
			}
		};

		// Proxy couldn't reach the worker upstream (often an autosuspend
		// bounce). Note it, then retry on a steady cadence — the worker comes
		// back when it's woken, and the panel should recover on its own.
		source.addEventListener('worker_unavailable', (event: MessageEvent) => {
			let reason = 'unreachable';
			try {
				const parsed = JSON.parse(event.data) as { reason?: string };
				if (parsed.reason) reason = parsed.reason;
			} catch {
				// ignore malformed payload
			}
			appendLine(workerId, `${formatTs(new Date().toISOString())}[runtime] Worker unavailable (${reason}). Retrying…`);
			source.close();
			failAndReconnect(_RUNTIME_UNAVAILABLE_RETRY_MS);
		});

		source.onerror = () => {
			// CLOSED → the browser gave up; reconnect with backoff ourselves.
			// CONNECTING → the browser is already retrying; leave it alone.
			if (source.readyState === EventSource.CLOSED) {
				failAndReconnect(conn.reconnectDelay);
				conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, _RUNTIME_RECONNECT_MAX_MS);
			}
		};
	};

	open();

	return () => {
		_pending.flushNow();
		conn.stopped = true;
		if (conn.reconnectTimer) {
			clearTimeout(conn.reconnectTimer);
			conn.reconnectTimer = null;
		}
		conn.source?.close();
		_runtimeSources.delete(workerId);
	};
}

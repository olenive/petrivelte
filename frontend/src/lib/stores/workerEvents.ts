/**
 * Per-worker unified event stream.
 *
 * Connects to GET /api/workers/{workerId}/events?after=0 via EventSource.
 * Tracks the last seen seq and reconnects with ?after={lastSeq} so the
 * client can catch up on any events missed during disconnection.
 *
 * Each event has shape:
 *   { seq, scope: 'worker' | 'net', net_id, kind, ts, data }
 *
 * Consumers subscribe and filter by kind (and net_id when relevant).
 * Stream resets when the worker restarts: a drop in seq indicates the
 * client should discard local state and refetch via REST.
 */

import { writable } from 'svelte/store';
import { API_URL } from '$lib/api';

export interface WorkerEvent {
	seq: number;
	scope: 'worker' | 'net';
	net_id: string | null;
	kind: string;
	ts: string;
	data: Record<string, any>;
}

const { subscribe, set } = writable<WorkerEvent | null>(null);

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

let currentWorkerId: string | null = null;
let lastSeq = 0;

function cleanup() {
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}
}

function connectSSE() {
	cleanup();

	const workerId = currentWorkerId;
	if (!workerId) return;

	const url = `${API_URL}/api/workers/${workerId}/events?after=${lastSeq}`;
	eventSource = new EventSource(url, { withCredentials: true });

	eventSource.onopen = () => {
		reconnectDelay = 1000;
	};

	eventSource.onmessage = (event) => {
		try {
			const parsed = JSON.parse(event.data) as WorkerEvent;
			// A seq lower than what we've already seen indicates a worker
			// restart. Reset lastSeq and accept the new sequence.
			if (parsed.seq <= lastSeq) {
				lastSeq = 0;
			}
			lastSeq = Math.max(lastSeq, parsed.seq);
			set(parsed);
		} catch {
			// ignore unparseable messages (e.g. keepalive comments)
		}
	};

	// Server proxy emits this when it can't reach the worker upstream. Stop
	// reconnecting — something explicit has to bring the worker back
	// (refresh, manual restart, scheduled wake).
	eventSource.addEventListener('worker_unavailable', (event: MessageEvent) => {
		let reason = 'unreachable';
		try {
			const parsed = JSON.parse(event.data) as { worker_id?: string; reason?: string };
			if (parsed.reason) reason = parsed.reason;
		} catch {
			// ignore malformed payload
		}
		set({
			seq: lastSeq,
			scope: 'worker',
			net_id: null,
			kind: 'worker_unavailable',
			ts: new Date().toISOString(),
			data: { reason },
		});
		cleanup();
		currentWorkerId = null;
	});

	eventSource.onerror = () => {
		if (eventSource?.readyState === EventSource.CLOSED) {
			eventSource = null;
			scheduleReconnect();
		}
	};
}

function scheduleReconnect() {
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connectSSE();
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

export function connectToWorker(workerId: string) {
	if (currentWorkerId === workerId && eventSource && eventSource.readyState !== EventSource.CLOSED) {
		return;
	}
	currentWorkerId = workerId;
	lastSeq = 0;
	reconnectDelay = 1000;
	connectSSE();
}

export function disconnectWorkerEvents() {
	cleanup();
	currentWorkerId = null;
	lastSeq = 0;
	set(null);
}

export const workerEventsStore = { subscribe };

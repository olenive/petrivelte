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
 *
 * The stream is not the truth, only the fast path to it. ``workerStreamStore``
 * says whether it is currently open and bumps ``generation`` whenever what
 * the page has heard may no longer be what the worker knows: a reconnect
 * after a drop, a ``stream_gap`` marker from the worker (its buffer could
 * not replay what we missed), or a sequence that started over (the worker
 * restarted). A page refetches over REST on every bump. See
 * ``$lib/workerStream`` for the rules and their reasons.
 */

import { writable } from 'svelte/store';
import { API_URL } from '$lib/api';
import { setWorkerMemory, type WorkerMemorySnapshot } from '$lib/stores/workerMemory';
import { advanceCursor, initialStreamStatus, type StreamState, type StreamStatus } from '$lib/workerStream';

export interface WorkerEvent {
	seq: number;
	scope: 'worker' | 'net';
	net_id: string | null;
	kind: string;
	ts: string;
	data: Record<string, any>;
}

const { subscribe, set } = writable<WorkerEvent | null>(null);

const status = writable<StreamStatus>(initialStreamStatus);
export const workerStreamStore = { subscribe: status.subscribe };

function setState(state: StreamState) {
	status.update((s) => (s.state === state ? s : { ...s, state }));
}

function markStale(reason: string) {
	console.info('[worker stream] resync needed:', reason);
	status.update((s) => ({ ...s, generation: s.generation + 1, lastGap: reason }));
}

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

let currentWorkerId: string | null = null;
let lastSeq = 0;
// Whether this worker's stream has been open before: a first open seeds
// nothing (the page fetched on selection), a later one may have missed events.
let openedBefore = false;

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
	setState(openedBefore ? 'reconnecting' : 'connecting');
	eventSource = new EventSource(url, { withCredentials: true });

	eventSource.onopen = () => {
		reconnectDelay = 1000;
		setState('open');
		// The browser reconnects an EventSource on its own after a sleep or a
		// network blip, resuming from Last-Event-ID; what the worker could
		// not replay is not announced on this path, so a reopen is always a
		// reason to refetch.
		if (openedBefore) markStale('reconnected');
		openedBefore = true;
	};

	eventSource.onmessage = (event) => {
		try {
			const parsed = JSON.parse(event.data) as WorkerEvent;
			const cursor = advanceCursor(lastSeq, parsed);
			lastSeq = cursor.lastSeq;
			if (cursor.gap) markStale(cursor.gap);
			// A gap marker is addressed to this store, not to the page.
			if (parsed.kind === 'stream_gap') return;
			// Memory snapshots feed a dedicated store; downstream consumers
			// don't need to filter for kind=memory_stats themselves.
			if (parsed.scope === 'worker' && parsed.kind === 'memory_stats' && workerId) {
				setWorkerMemory(workerId, parsed.data as WorkerMemorySnapshot);
			}
			set(parsed);
		} catch {
			// ignore unparseable messages (e.g. keepalive comments)
		}
	};

	// Server proxy emits this when it can't reach the worker upstream. Keep
	// trying at the slowest cadence: a suspended machine wakes, a rolled one
	// comes back, and the page must not need a refresh to notice. The page
	// also reopens the stream the moment the control plane reports the
	// worker ready again (``liveAction`` in ``$lib/workerStream``).
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
		setState('unavailable');
		reconnectDelay = MAX_RECONNECT_DELAY;
		scheduleReconnect();
	});

	eventSource.onerror = () => {
		if (eventSource?.readyState === EventSource.CLOSED) {
			eventSource = null;
			setState('reconnecting');
			scheduleReconnect();
		} else {
			// The browser is retrying on its own; say so until onopen.
			setState('reconnecting');
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
	openedBefore = false;
	reconnectDelay = 1000;
	status.set({ ...initialStreamStatus, workerId });
	connectSSE();
}

export function disconnectWorkerEvents() {
	cleanup();
	currentWorkerId = null;
	lastSeq = 0;
	openedBefore = false;
	status.set(initialStreamStatus);
	set(null);
}

export const workerEventsStore = { subscribe };

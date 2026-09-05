/**
 * Server-Sent Events store.
 *
 * Connects to GET /api/events and exposes incoming state-change
 * events as a Svelte store.  Reconnects automatically with backoff.
 *
 * Each event carries a per-user monotonic `seq` (also sent as the SSE
 * `id` field). The store tracks the last seen seq; on reconnect it
 * fetches /api/events/history?after={lastSeq} to replay any events
 * missed while disconnected before continuing to tail live events.
 */

import { writable } from 'svelte/store';
import { API_URL, getEventsAfter } from '$lib/api';

export type ServerEvent =
	| { seq?: number; type: 'worker_state_changed'; worker_id: string; status: string; status_detail?: string | null; ts?: string }
	| { seq?: number; type: 'net_state_changed'; net_id: string; worker_id?: string; load_state: string; ts?: string }
	| { seq?: number; type: 'notebook_state_changed'; notebook_id: string; worker_id?: string | null; load_state: string; load_error?: string | null; ts?: string }
	| { seq?: number; type: 'notebook_error'; notebook_id: string; error_id?: string; exception_type?: string; top_frame_location?: string | null; occurrence_count?: number; dismissed_all?: boolean; ts?: string }
	| { seq?: number; type: 'net_load_log'; net_id: string; worker_id?: string; step: string; message: string; ts?: string }
	| { seq?: number; type: 'worker_provision_log'; worker_id: string; step: string; message: string; ts?: string }
	// Run lifecycle. Emitted inside the transaction that wrote the run, on the
	// same ``state_changes`` channel as every other event here — a run never
	// needs a second connection to be followed live. ``state`` and ``reason``
	// are the closed sets from ``nets/runs.py``; render them through
	// ``$lib/runs``, never raw.
	| ({ type: 'net_run_started' } & RunEventFields)
	| ({ type: 'net_run_finished' } & RunEventFields)
	| ({ type: 'net_run_skipped' } & RunEventFields);

/**
 * What every run event carries.
 *
 * The three timestamps are what let a listener update a badge from the event
 * itself instead of waiting for the refetch that follows it. All three are
 * legitimately null: a run that has not begun executing has no ``started_at``,
 * an open run no ``ended_at``, and only a scheduled run has a
 * ``scheduled_for``.
 */
interface RunEventFields {
	seq?: number;
	run_id: string;
	net_id: string;
	trigger: string;
	state: string;
	reason: string | null;
	/** When the run row was written. Optional: a control plane predating the
	 *  field omits it, and a listener then falls back to ``started_at``. */
	created_at?: string | null;
	started_at: string | null;
	ended_at: string | null;
	scheduled_for: string | null;
	ts?: string;
}

/** The run-lifecycle event types, for callers that treat the three alike. */
export const RUN_EVENT_TYPES = ['net_run_started', 'net_run_finished', 'net_run_skipped'] as const;

export type RunEvent = Extract<ServerEvent, { type: (typeof RUN_EVENT_TYPES)[number] }>;

export function isRunEvent(event: ServerEvent): event is RunEvent {
	return (RUN_EVENT_TYPES as readonly string[]).includes(event.type);
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

const { subscribe, set } = writable<ServerEvent | null>(null);

const connection = writable<ConnectionState>('disconnected');
export const connectionStateStore = { subscribe: connection.subscribe };

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

let lastSeq = 0;
let hadConnection = false;

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

async function replayMissedEvents() {
	if (!hadConnection || lastSeq === 0) return;
	try {
		const missed = await getEventsAfter(lastSeq);
		for (const evt of missed) {
			const seq = typeof evt.seq === 'number' ? evt.seq : 0;
			if (seq > lastSeq) lastSeq = seq;
			set(evt as ServerEvent);
		}
	} catch {
		// If replay fails we continue with live events; gaps are possible.
	}
}

function connectSSE() {
	cleanup();

	connection.set('connecting');
	const url = `${API_URL}/api/events`;
	eventSource = new EventSource(url, { withCredentials: true });

	eventSource.onopen = async () => {
		reconnectDelay = 1000;
		connection.set('connected');
		await replayMissedEvents();
		hadConnection = true;
	};

	eventSource.onmessage = (event) => {
		try {
			const parsed = JSON.parse(event.data) as ServerEvent;
			// Track seq so we can replay on reconnect. Event id is also
			// set on the SSE message for native Last-Event-ID support.
			const seq = typeof parsed.seq === 'number' ? parsed.seq : Number(event.lastEventId) || 0;
			if (seq > lastSeq) lastSeq = seq;
			try {
				set(parsed);
			} catch (err) {
				console.error('[SSE] subscriber threw for event', { seq, type: (parsed as any).type, err });
			}
		} catch (err) {
			console.warn('[SSE] unparseable message', { data: event.data, err });
		}
	};

	eventSource.onerror = (err) => {
		console.warn('[SSE] onerror', { readyState: eventSource?.readyState, err });
		connection.set('disconnected');
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

export function connectServerEvents() {
	connectSSE();
}

export function disconnectServerEvents() {
	cleanup();
	lastSeq = 0;
	hadConnection = false;
	connection.set('disconnected');
	set(null);
}

export const serverEventsStore = { subscribe };

/**
 * Server-Sent Events store.
 *
 * Connects to GET /api/events and exposes incoming state-change
 * events as a Svelte store.  Reconnects automatically with backoff.
 * Gracefully handles the endpoint not existing yet (backend not deployed).
 */

import { writable } from 'svelte/store';
import { API_URL } from '$lib/api';

export type ServerEvent =
	| { type: 'worker_state_changed'; worker_id: string; status: string; status_detail?: string | null }
	| { type: 'net_state_changed'; net_id: string; load_state: string };

const { subscribe, set } = writable<ServerEvent | null>(null);

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

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
	reconnectDelay = 1000;

	const url = `${API_URL}/api/events`;
	eventSource = new EventSource(url, { withCredentials: true });

	eventSource.onopen = () => {
		reconnectDelay = 1000; // reset backoff on successful connect
	};

	eventSource.onmessage = (event) => {
		try {
			const parsed = JSON.parse(event.data) as ServerEvent;
			set(parsed);
		} catch {
			// ignore unparseable messages (e.g. keepalive comments)
		}
	};

	eventSource.onerror = () => {
		// EventSource auto-reconnects for some errors, but if it
		// moves to CLOSED state we handle reconnection ourselves.
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
	set(null);
}

export const serverEventsStore = { subscribe };

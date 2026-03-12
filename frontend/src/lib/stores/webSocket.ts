/**
 * Per-net WebSocket store.
 *
 * Call `connectToNet(netId)` when the user selects a net.
 * The store emits parsed WebSocketMessage values.
 * Reconnects automatically on disconnect.
 */

import { writable } from 'svelte/store';
import { WS_BASE_URL } from '$lib/config/network';
import type { WebSocketMessage } from '$lib/types';

const wsBase = WS_BASE_URL;

const { subscribe, set } = writable<WebSocketMessage | null>(null);

/** Close codes that indicate the server will never accept this connection. */
const NO_RETRY_CODES = new Set([
	4001, // not authenticated / session expired
	4004, // net not found or not loaded
]);

const MAX_RETRIES = 8;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

let ws: WebSocket | null = null;
let currentNetId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalClose = false;
let retryCount = 0;

function cleanup() {
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (ws) {
		intentionalClose = true;
		ws.close();
		ws = null;
	}
}

function connectRaw(netId: string) {
	cleanup();
	intentionalClose = false;
	currentNetId = netId;

	const url = `${wsBase}/ws/${netId}`;
	ws = new WebSocket(url);

	ws.onopen = () => {
		console.log(`WebSocket connected to net ${netId}`);
		retryCount = 0;
	};

	ws.onmessage = (event) => {
		const message = JSON.parse(event.data) as WebSocketMessage;
		set(message);
	};

	ws.onerror = (error) => {
		console.error('WebSocket error:', error);
	};

	ws.onclose = (event) => {
		if (intentionalClose || currentNetId !== netId) return;

		if (NO_RETRY_CODES.has(event.code)) {
			console.log(`WebSocket closed for net ${netId} (code ${event.code}), not reconnecting`);
			return;
		}

		if (retryCount >= MAX_RETRIES) {
			console.log(`WebSocket reconnect limit reached for net ${netId}, giving up`);
			return;
		}

		const delay = Math.min(BASE_DELAY_MS * 2 ** retryCount, MAX_DELAY_MS);
		retryCount++;
		console.log(`WebSocket disconnected from net ${netId}, reconnecting in ${delay}ms (attempt ${retryCount}/${MAX_RETRIES})...`);
		reconnectTimer = setTimeout(() => connectRaw(netId), delay);
	};
}

export function connectToNet(netId: string) {
	if (currentNetId === netId && ws && ws.readyState === WebSocket.OPEN) {
		return; // already connected to this net
	}
	retryCount = 0;
	connectRaw(netId);
}

export function disconnect() {
	cleanup();
	currentNetId = null;
	set(null);
}

export function send(data: unknown) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(data));
	}
}

export const webSocketStore = { subscribe, connectToNet, disconnect, send };

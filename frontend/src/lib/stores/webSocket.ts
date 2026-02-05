/**
 * Per-net WebSocket store.
 *
 * Call `connectToNet(netId)` when the user selects a net.
 * The store emits parsed WebSocketMessage values.
 * Reconnects automatically on disconnect.
 */

import { writable, get } from 'svelte/store';
import { env } from '$env/dynamic/public';
import type { WebSocketMessage } from '$lib/types';

const apiUrl = env.PUBLIC_API_URL || 'http://localhost:8000';
const wsBase = apiUrl.replace(/^http/, 'ws');

const { subscribe, set } = writable<WebSocketMessage | null>(null);

let ws: WebSocket | null = null;
let currentNetId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalClose = false;

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
	};

	ws.onmessage = (event) => {
		const message = JSON.parse(event.data) as WebSocketMessage;
		set(message);
	};

	ws.onerror = (error) => {
		console.error('WebSocket error:', error);
	};

	ws.onclose = () => {
		if (!intentionalClose && currentNetId === netId) {
			console.log(`WebSocket disconnected from net ${netId}, reconnecting...`);
			reconnectTimer = setTimeout(() => connectRaw(netId), 1000);
		}
	};
}

export function connectToNet(netId: string) {
	if (currentNetId === netId && ws && ws.readyState === WebSocket.OPEN) {
		return; // already connected to this net
	}
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

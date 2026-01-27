import { writable } from 'svelte/store';
import type { WebSocketMessage } from '$lib/types';

function createWebSocketStore() {
	const { subscribe, set } = writable<WebSocketMessage | null>(null);
	let ws: WebSocket | null = null;

	function connect() {
		ws = new WebSocket('ws://localhost:8000/ws');

		ws.onopen = () => {
			console.log('WebSocket connected');
		};

		ws.onmessage = (event) => {
			const message = JSON.parse(event.data) as WebSocketMessage;
			set(message);
		};

		ws.onerror = (error) => {
			console.error('WebSocket error:', error);
		};

		ws.onclose = () => {
			console.log('WebSocket disconnected, reconnecting...');
			setTimeout(connect, 1000);
		};
	}

	connect();

	return {
		subscribe,
		send: (data: any) => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(data));
			}
		}
	};
}

export const webSocketStore = createWebSocketStore();

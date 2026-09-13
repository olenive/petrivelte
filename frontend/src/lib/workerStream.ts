/**
 * What the net page believes about its worker's event stream, and when that
 * belief must be replaced by a fresh fetch.
 *
 * The stream is the fast path: a transition fires, the worker emits it, the
 * page draws it. But it is not the truth. A laptop sleeps, a tab is throttled,
 * the worker rolls, the buffer behind the stream wraps — and the page keeps
 * showing whatever it last heard, with "Connected" in the corner. On
 * 2026-09-13 a monitor net page showed an execution log two and a half hours
 * older than the net, because the tab had missed more events than the worker
 * buffers and nothing told it so.
 *
 * Everything here is pure so it can be tested without a browser. The store in
 * ``$lib/stores/workerEvents`` drives the cursor through ``advanceCursor``;
 * the page maps the stream's status to a label and reacts to control-plane
 * events through ``liveAction``.
 */

import type { Net } from '$lib/api';
import type { ServerEvent } from '$lib/stores/serverEvents';

export type StreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unavailable';

export interface StreamStatus {
	state: StreamState;
	workerId: string | null;
	/** Bumped every time the page's picture may have gone stale: a reconnect
	 *  after a drop, a ``stream_gap`` marker, a worker whose sequence started
	 *  over. The page refetches on every bump. */
	generation: number;
	/** Why the last bump happened, for the console and for tests. */
	lastGap: string | null;
}

export const initialStreamStatus: StreamStatus = {
	state: 'idle',
	workerId: null,
	generation: 0,
	lastGap: null,
};

/** The header badge. Only ``Connected`` earns the green. */
export function statusLabel(status: StreamStatus): string {
	switch (status.state) {
		case 'open':
			return 'Connected';
		case 'connecting':
			return 'Connecting...';
		case 'reconnecting':
			return 'Reconnecting...';
		case 'unavailable':
			return 'Worker unreachable';
		default:
			return 'No live stream';
	}
}

interface StreamEventLike {
	seq: number;
	kind: string;
	data?: Record<string, unknown> | null;
}

/**
 * The next cursor after an event, and whether the event means the page must
 * resync. ``gap`` is null on the ordinary path.
 *
 * A ``stream_gap`` marker is the worker saying the replay it just skipped
 * would have been incomplete (see ``event_buffer.gap_before`` on the worker).
 * A sequence number at or below the cursor, without a marker, is a worker
 * whose sequence started over — it restarted between two of our events.
 */
export function advanceCursor(
	lastSeq: number,
	event: StreamEventLike,
): { lastSeq: number; gap: string | null } {
	if (event.kind === 'stream_gap') {
		const reason = typeof event.data?.reason === 'string' ? event.data.reason : 'unknown';
		return { lastSeq: reason === 'restarted' ? 0 : lastSeq, gap: reason };
	}
	if (event.seq > 0 && event.seq <= lastSeq) {
		return { lastSeq: event.seq, gap: 'restarted' };
	}
	return { lastSeq: Math.max(lastSeq, event.seq), gap: null };
}

/** The worker keeps this many entries per net; more than that on the page is
 *  invention. Also what keeps a page that has watched a net for a day
 *  from copying a ten-thousand-entry array on every transition. */
export const EXECUTION_LOG_CAP = 500;
export const NET_LOG_CAP = 2000;

/** Keep the first ``max`` of a newest-first list. */
export function capHead<T>(list: T[], max: number): T[] {
	return list.length > max ? list.slice(0, max) : list;
}

/** Keep the last ``max`` of an oldest-first list. */
export function capTail<T>(list: T[], max: number): T[] {
	return list.length > max ? list.slice(list.length - max) : list;
}

export type LiveAction = 'reconnect' | 'resync' | 'clear' | 'running';

/**
 * What a control-plane event means for the net the page is looking at.
 *
 * - ``reconnect``: the net's worker is ready again — reopen the worker
 *   stream (it stopped when the worker went away) and refetch.
 * - ``resync``: the net was (re)loaded — a scheduled dispatch or someone
 *   else's Load gave it a fresh subprocess whose history starts empty.
 * - ``clear``: the net was unloaded or failed — nothing on the worker
 *   answers for it now, so the graph and the running flag are stale.
 * - ``running``: a run opened for it — the schedule or a resume started it,
 *   and the Activate button has no other way to hear that.
 */
export function liveAction(event: ServerEvent, net: Pick<Net, 'id' | 'worker_id'> | undefined): LiveAction | null {
	if (!net) return null;
	if (event.type === 'worker_state_changed') {
		return event.worker_id === net.worker_id && event.status === 'ready' ? 'reconnect' : null;
	}
	if (event.type === 'net_state_changed' && event.net_id === net.id) {
		if (event.load_state === 'loaded') return 'resync';
		if (event.load_state === 'loading') return null;
		return 'clear';
	}
	if (event.type === 'net_run_started' && event.net_id === net.id) return 'running';
	return null;
}

import { describe, expect, it } from 'vitest';

import type { NotebookSync, NotebookSyncSlot, NotebookTransport } from './api';
import {
	BRIDGE_START_DEADLINE_S,
	FRAME_STALL_S,
	REMOUNT_BACKOFF_S,
	REMOUNT_MAX_ATTEMPTS,
	WS_OPEN_DEADLINE_S,
	diagnose,
	planRemount,
	stateColour,
} from './notebookSync';

/**
 * Telling apart the ways a notebook stops showing you the truth.
 *
 * Freshness alone could not. It describes the HTTP path from the notebook's
 * bridge; the rendering travels a WebSocket, and the two fail independently. A
 * notebook once sat frozen for 259 seconds with every slot reporting a
 * sub-second sync age, because its browser had not opened a socket yet — and
 * every signal we had said "live".
 *
 * Each case below is one row of that failure matrix. They matter individually
 * because they want different recoveries: remounting an iframe does nothing
 * for a wedged kernel, and respawning a subprocess does nothing for a socket
 * that never opened.
 */

const slot = (over: Partial<NotebookSyncSlot> = {}): NotebookSyncSlot => ({
	slot_name: 'tw',
	net_id: 'n-1',
	synced: true,
	step_count: 10,
	running: true,
	last_error: null,
	last_sync_age_s: 1,
	report_age_s: 1,
	...over,
});

const transport = (over: Partial<NotebookTransport> = {}): NotebookTransport => ({
	alive: true,
	ws_sessions: 1,
	ws_opened_total: 1,
	last_ws_open_age_s: 60,
	frames_relayed: 500,
	last_frame_age_s: 0.5,
	first_report_age_s: 55,
	...over,
});

const sync = (over: Partial<NotebookSync> = {}): NotebookSync => ({
	slots: [slot()],
	transport: transport(),
	reachable: true,
	reason: null,
	bindings: 1,
	...over,
});

/** Long past every deadline, so nothing is excused as still starting up. */
const settled = { sinceBurstSettledS: 300 };

describe('diagnose', () => {
	it('is live when the bridge is fresh and frames are flowing', () => {
		const d = diagnose(sync(), settled);

		expect(d.state).toBe('live');
		expect(d.action).toBe('none');
	});

	it('is the incident: fresh sync, no socket, and it must not read as live', () => {
		// The exact shape of the 259s freeze. Everything on the HTTP path is
		// healthy; nobody is looking at any of it.
		const d = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }),
			settled,
		);

		expect(d.state).toBe('no_transport');
		expect(d.action).toBe('remount');
		expect(d.detail).toContain('never opened');
	});

	it('does not call a slow open a failure', () => {
		// Marimo's asset burst can take a minute on a cold worker. Remounting
		// inside that window restarts the fetch and makes a slow open endless.
		const loading = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }),
			{ sinceBurstSettledS: WS_OPEN_DEADLINE_S - 1 },
		);

		expect(loading.state).toBe('connecting');
		expect(loading.action).toBe('none');
	});

	it('waits indefinitely while the asset burst is still running', () => {
		// Null is "not started counting yet", not "counted zero". The deadline
		// is measured from burst settle for the reason above.
		const d = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }),
			{ sinceBurstSettledS: null },
		);

		expect(d.state).toBe('connecting');
	});

	it('separates a connection that never happened from one that dropped', () => {
		// Different causes, and a remount walks back into the second one.
		const never = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }),
			settled,
		);
		const dropped = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 4 }) }),
			settled,
		);

		expect(never.detail).not.toBe(dropped.detail);
		expect(dropped.detail).toContain('dropped');
	});

	it('catches a notebook that connected but never started tracking', () => {
		const d = diagnose(
			sync({ transport: transport({ first_report_age_s: null }) }),
			settled,
		);

		expect(d.state).toBe('bridge_missing');
		expect(d.action).toBe('remount');
	});

	it('gives the bridge time to start before calling it missing', () => {
		// The clock is time since the socket opened, not since the page loaded:
		// the bridge cannot start before there is a session to run cells in.
		const d = diagnose(
			sync({
				transport: transport({
					first_report_age_s: null,
					last_ws_open_age_s: BRIDGE_START_DEADLINE_S - 1,
				}),
			}),
			settled,
		);

		expect(d.state).toBe('connecting');
	});

	it('does not expect a bridge on a notebook with nothing bound', () => {
		const d = diagnose(
			sync({
				slots: [],
				bindings: 0,
				transport: transport({ first_report_age_s: null }),
			}),
			settled,
		);

		expect(d.state).toBe('live');
		expect(d.action).toBe('none');
	});

	it('catches a wedged kernel holding its socket open', () => {
		// The failure the relay's own pings can never see: the socket is fine,
		// the kernel just stopped sending.
		const d = diagnose(
			sync({ transport: transport({ last_frame_age_s: FRAME_STALL_S + 1 }) }),
			settled,
		);

		expect(d.state).toBe('frames_stalled');
		expect(d.action).toBe('reload');
	});

	it('reports a stalled bridge behind a working channel', () => {
		const d = diagnose(sync({ slots: [slot({ last_sync_age_s: 120 })] }), settled);

		expect(d.state).toBe('bridge_stalled');
		expect(d.action).toBe('reload');
	});

	it('names each way of being unreachable', () => {
		const noWorker = diagnose(
			sync({ reachable: false, reason: 'no_worker', transport: null }),
			settled,
		);
		const unreachable = diagnose(
			sync({ reachable: false, reason: 'worker_unreachable', transport: null }),
			settled,
		);

		expect(noWorker.state).toBe('not_loaded');
		expect(unreachable.state).toBe('worker_unreachable');
		// An unreachable worker is worth retrying; an unassigned one is not.
		expect(noWorker.action).toBe('none');
		expect(unreachable.action).toBe('reload');
	});

	it('reports a dead subprocess as such rather than as a transport fault', () => {
		const d = diagnose(sync({ transport: transport({ alive: false }) }), settled);

		expect(d.state).toBe('worker_unreachable');
		expect(d.action).toBe('reload');
	});

	it('takes no action when the server does not report a transport at all', () => {
		// An older worker. Absent evidence must degrade to the freshness-only
		// badge — inventing a transport failure would remount a page over a
		// channel we simply have no reporting for.
		const d = diagnose(sync({ transport: null }), settled);

		expect(d.state).toBe('live');
		expect(d.action).toBe('none');
	});

	it('still surfaces slot staleness without a transport block', () => {
		const d = diagnose(
			sync({ transport: undefined, slots: [slot({ last_sync_age_s: 120 })] }),
			settled,
		);

		expect(d.state).toBe('stale');
		expect(d.action).toBe('none');
	});

	it('recovers to live once the channel comes back', () => {
		// Derived on every read, so there is always a path back — the property
		// the nets page indicator lacks.
		const broken = diagnose(
			sync({ transport: transport({ ws_sessions: 0 }) }),
			settled,
		);
		const fixed = diagnose(sync(), settled);

		expect(broken.state).toBe('no_transport');
		expect(fixed.state).toBe('live');
	});

	it('gives the transport failures colours of their own', () => {
		expect(stateColour('no_transport')).not.toBe(stateColour('live'));
		expect(stateColour('connecting')).not.toBe(stateColour('no_transport'));
	});
});

describe('planRemount', () => {
	const broken = { state: 'no_transport', action: 'remount', label: '', detail: '' } as const;
	const healthy = { state: 'live', action: 'none', label: '', detail: '' } as const;

	it('remounts on the first transport failure', () => {
		const plan = planRemount(broken, 0);

		expect(plan.remount).toBe(true);
		expect(plan.delayS).toBe(REMOUNT_BACKOFF_S[0]);
		expect(plan.attempts).toBe(1);
	});

	it('backs off further on the second', () => {
		// The usual cause of a slow connect is a busy worker, and remounting
		// immediately adds another asset burst to whatever is saturating it.
		expect(planRemount(broken, 1).delayS).toBe(REMOUNT_BACKOFF_S[1]);
	});

	it('gives up rather than looping forever', () => {
		const plan = planRemount(broken, REMOUNT_MAX_ATTEMPTS);

		expect(plan.remount).toBe(false);
		expect(plan.exhausted).toBe(true);
	});

	it('never remounts for a failure a remount cannot fix', () => {
		const wedged = { state: 'frames_stalled', action: 'reload', label: '', detail: '' } as const;

		expect(planRemount(wedged, 0).remount).toBe(false);
		expect(planRemount(wedged, 0).exhausted).toBe(false);
	});

	it('forgets past attempts once the notebook recovers', () => {
		// Otherwise a page left open for days is consumed by unrelated hiccups
		// hours apart, and has no attempts left when it finally matters.
		expect(planRemount(healthy, REMOUNT_MAX_ATTEMPTS).attempts).toBe(0);
	});

	it('keeps the count while still connecting', () => {
		const connecting = { state: 'connecting', action: 'none', label: '', detail: '' } as const;

		expect(planRemount(connecting, 1).attempts).toBe(1);
	});
});

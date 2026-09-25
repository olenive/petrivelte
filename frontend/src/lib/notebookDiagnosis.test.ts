import { describe, expect, it } from 'vitest';

import type { NotebookSync, NotebookSyncSlot, NotebookTransport } from './api';
import { diagnose, planRemount, stateColour, undrawnPushAgeS } from './notebookSync';
import { testThresholds } from './notebookThresholds.testing';

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
	marking_version: 3,
	reconcile_interval_s: null,
	last_push_age_s: 0.5,
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

const T = testThresholds();
const {
	bridge_start_deadline_s: BRIDGE_START_DEADLINE_S,
	frame_stall_s: FRAME_STALL_S,
	remount_backoff_s: REMOUNT_BACKOFF_S,
	remount_budget: REMOUNT_BUDGET,
	remount_window_s: REMOUNT_WINDOW_S,
	ws_open_deadline_s: WS_OPEN_DEADLINE_S,
} = T;

/** Long past every deadline, so nothing is excused as still starting up. */
const settled = { sinceBurstSettledS: 300 };

describe('diagnose', () => {
	it('is live when the bridge is fresh and frames are flowing', () => {
		const d = diagnose(sync(), T, settled);

		expect(d.state).toBe('live');
		expect(d.action).toBe('none');
	});

	it('is the incident: fresh sync, no socket, and it must not read as live', () => {
		// The exact shape of the 259s freeze. Everything on the HTTP path is
		// healthy; nobody is looking at any of it.
		const d = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }),
			T,
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
			T,
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
			T,
			{ sinceBurstSettledS: null },
		);

		expect(d.state).toBe('connecting');
	});

	it('separates a connection that never happened from one that dropped', () => {
		// Different causes, and a remount walks back into the second one.
		const never = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }),
			T,
			settled,
		);
		const dropped = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 4 }) }),
			T,
			settled,
		);

		expect(never.detail).not.toBe(dropped.detail);
		expect(dropped.detail).toContain('dropped');
	});

	it('catches a notebook that connected but never started tracking', () => {
		const d = diagnose(
			sync({ transport: transport({ first_report_age_s: null }) }),
			T,
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
			T,
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
			T,
			settled,
		);

		expect(d.state).toBe('live');
		expect(d.action).toBe('none');
	});

	it('catches a wedged kernel holding its socket open', () => {
		// The failure the relay's own pings can never see: the socket is fine,
		// the kernel was handed new state and drew nothing.
		const d = diagnose(
			sync({
				slots: [slot({ report_age_s: 1, last_push_age_s: FRAME_STALL_S })],
				transport: transport({ last_frame_age_s: FRAME_STALL_S + 10 }),
			}),
			T,
			settled,
		);

		expect(d.state).toBe('frames_stalled');
		expect(d.action).toBe('reload');
		expect(d.detail).toContain('31s ago');
	});

	it('reports a stalled bridge behind a working channel', () => {
		const d = diagnose(sync({ slots: [slot({ last_sync_age_s: 120 })] }), T, settled);

		expect(d.state).toBe('bridge_stalled');
		expect(d.action).toBe('reload');
	});

	it('names each way of being unreachable', () => {
		const noWorker = diagnose(
			sync({ reachable: false, reason: 'no_worker', transport: null }),
			T,
			settled,
		);
		const unreachable = diagnose(
			sync({ reachable: false, reason: 'worker_unreachable', transport: null }),
			T,
			settled,
		);

		expect(noWorker.state).toBe('not_loaded');
		expect(unreachable.state).toBe('worker_unreachable');
		// An unreachable worker is worth retrying; an unassigned one is not.
		expect(noWorker.action).toBe('none');
		expect(unreachable.action).toBe('reload');
	});

	it('reports a dead subprocess as such rather than as a transport fault', () => {
		// An older worker keeps the dead entry and answers with a dead transport.
		const d = diagnose(sync({ transport: transport({ alive: false }) }), T, settled);

		expect(d.state).toBe('subprocess_gone');
		expect(d.label).toBe('subprocess gone');
		expect(d.action).toBe('reload');
	});

	it('reads a worker that no longer knows the notebook as subprocess gone', () => {
		const d = diagnose(
			sync({ reachable: false, reason: 'subprocess_gone', transport: null }),
			T,
			settled,
		);

		expect(d).toEqual({
			state: 'subprocess_gone',
			action: 'reload',
			label: 'subprocess gone',
			detail: 'The notebook subprocess died. Reload to respawn it.',
		});
	});

	it('reads a probe timeout as a busy worker and takes no action', () => {
		// A saturated worker is not a dead one; reloading would only add load.
		const d = diagnose(
			sync({ reachable: false, reason: 'worker_busy', transport: null }),
			T,
			settled,
		);

		expect(d.state).toBe('worker_busy');
		expect(d.label).toBe('worker busy');
		expect(d.action).toBe('none');
		expect(d.detail).toBe(
			'The worker took more than 5 s to answer; it is probably saturated. Nothing is known to be dead.',
		);
	});

	it('keeps a refused connection as unreachable', () => {
		const d = diagnose(
			sync({ reachable: false, reason: 'worker_unreachable', transport: null }),
			T,
			settled,
		);

		expect(d.state).toBe('worker_unreachable');
		expect(d.label).toBe('unreachable');
	});

	it('takes no action when the server does not report a transport at all', () => {
		// An older worker. Absent evidence must degrade to the freshness-only
		// badge — inventing a transport failure would remount a page over a
		// channel we simply have no reporting for.
		const d = diagnose(sync({ transport: null }), T, settled);

		expect(d.state).toBe('live');
		expect(d.action).toBe('none');
	});

	it('still surfaces slot staleness without a transport block', () => {
		const d = diagnose(
			sync({ transport: undefined, slots: [slot({ last_sync_age_s: 120 })] }),
			T,
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
			T,
			settled,
		);
		const fixed = diagnose(sync(), T, settled);

		expect(broken.state).toBe('no_transport');
		expect(fixed.state).toBe('live');
	});

	it('gives the transport failures colours of their own', () => {
		expect(stateColour('no_transport')).not.toBe(stateColour('live'));
		expect(stateColour('connecting')).not.toBe(stateColour('no_transport'));
	});

	it('colours a busy worker amber and a dead subprocess red', () => {
		expect(stateColour('worker_busy')).toBe('#f59e0b');
		expect(stateColour('subprocess_gone')).toBe('#ef4444');
	});
});

describe('diagnose before the thresholds have loaded', () => {
	it('reads checking and takes no action, whatever the report says', () => {
		const reports = [
			sync(),
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }),
			sync({ slots: [slot({ last_sync_age_s: 999, report_age_s: 999 })] }),
			sync({ reachable: false, reason: 'worker_unreachable', transport: null }),
		];
		for (const report of reports) {
			const d = diagnose(report, null, settled);
			expect(d.state).toBe('checking');
			expect(d.label).toBe('checking');
			expect(d.action).toBe('none');
		}
	});

	it('plans no remount for a checking diagnosis', () => {
		const d = diagnose(
			sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }),
			null,
			settled,
		);
		const plan = planRemount(d, [], 1_000_000, T);

		expect(plan.remount).toBe(false);
		expect(plan.exhausted).toBe(false);
	});

	it('has a colour of its own', () => {
		expect(stateColour('checking')).not.toBe(stateColour('live'));
	});
});

describe('frame stall is relative to the last push', () => {
	// A notebook watching a five-minute net draws nothing between steps. Frame
	// age against the wall clock wore "not drawing" for most of every cycle
	// while the kernel was synced. A frame is owed only after a push.

	it('is not drawing when a push older than frame_stall_s has no frame after it', () => {
		const d = diagnose(
			sync({
				slots: [slot({ report_age_s: 2, last_push_age_s: 40 })],
				transport: transport({ last_frame_age_s: 300 }),
			}),
			T,
			settled,
		);

		expect(d.state).toBe('frames_stalled');
	});

	it('is live when the last frame followed the last push, however old both are', () => {
		const d = diagnose(
			sync({
				slots: [slot({ report_age_s: 2, last_push_age_s: 240 })],
				transport: transport({ last_frame_age_s: 230 }),
			}),
			T,
			settled,
		);

		expect(d.state).toBe('live');
	});

	it('gives a fresh push frame_stall_s to be drawn', () => {
		const d = diagnose(
			sync({
				slots: [slot({ report_age_s: 2, last_push_age_s: FRAME_STALL_S - 5 })],
				transport: transport({ last_frame_age_s: 300 }),
			}),
			T,
			settled,
		);

		expect(d.state).toBe('live');
	});

	it('ages the push from the report stamp, not from the reading', () => {
		// The push age is measured when the subprocess reports; the report is
		// itself report_age_s old by the time the worker answers. 25 + 10 is
		// past the 30 s threshold although neither number is on its own.
		const d = diagnose(
			sync({
				slots: [slot({ report_age_s: 10, last_push_age_s: 25, last_sync_age_s: 1 })],
				transport: transport({ last_frame_age_s: 40 }),
			}),
			T,
			settled,
		);

		expect(d.state).toBe('frames_stalled');
		expect(d.detail).toContain('35s ago');
	});

	it('is not a fault when nothing has ever been pushed', () => {
		const d = diagnose(
			sync({
				slots: [slot({ last_push_age_s: null })],
				transport: transport({ last_frame_age_s: null, frames_relayed: 0 }),
			}),
			T,
			settled,
		);

		expect(d.state).toBe('live');
		expect(d.action).toBe('none');
	});

	it('is not drawing when a push was never followed by any frame', () => {
		const d = diagnose(
			sync({
				slots: [slot({ report_age_s: 1, last_push_age_s: 45 })],
				transport: transport({ last_frame_age_s: null, frames_relayed: 0 }),
			}),
			T,
			settled,
		);

		expect(d.state).toBe('frames_stalled');
		expect(d.detail).toContain('never drawn');
	});

	it('judges each slot: one undrawn push is enough', () => {
		const d = diagnose(
			sync({
				slots: [
					slot({ slot_name: 'drawn', report_age_s: 1, last_push_age_s: 100 }),
					slot({ slot_name: 'undrawn', report_age_s: 1, last_push_age_s: 40 }),
				],
				bindings: 2,
				transport: transport({ last_frame_age_s: 60 }),
			}),
			T,
			settled,
		);

		expect(d.state).toBe('frames_stalled');
	});

	it('remembers an undrawn push across polls while the net keeps pushing', () => {
		// A net stepping every few seconds keeps its latest push young, so one
		// reading alone never sees a frozen page. The page carries the oldest
		// undrawn push forward, rebased by the time between polls.
		const reading = (frameAge: number) =>
			sync({
				slots: [slot({ report_age_s: 1, last_push_age_s: 2 })],
				transport: transport({ last_frame_age_s: frameAge }),
			});
		let carried: number | null = null;
		let frameAge = 10;
		const states: string[] = [];
		for (let poll = 0; poll < 12; poll++) {
			const r = reading(frameAge);
			states.push(diagnose(r, T, { ...settled, carriedPushAgeS: carried }).state);
			const undrawn = undrawnPushAgeS(r, carried);
			carried = undrawn === null ? null : undrawn + 5;
			frameAge += 5;
		}

		// The first undrawn push was seen 3 s old at poll 0, so it passes 30 s
		// between polls 5 and 6.
		expect(states.slice(0, 6).every((st) => st === 'live')).toBe(true);
		expect(states.slice(6).every((st) => st === 'frames_stalled')).toBe(true);
	});

	it('drops a remembered push once a newer frame has drawn it', () => {
		const r = sync({
			slots: [slot({ report_age_s: 1, last_push_age_s: 2 })],
			transport: transport({ last_frame_age_s: 1 }),
		});

		expect(undrawnPushAgeS(r, 60)).toBeNull();
		expect(diagnose(r, T, { ...settled, carriedPushAgeS: 60 }).state).toBe('live');
	});

	it('reads frame_stall_s from the thresholds', () => {
		const report = sync({
			slots: [slot({ report_age_s: 1, last_push_age_s: 14 })],
			transport: transport({ last_frame_age_s: 100 }),
		});

		expect(diagnose(report, T, settled).state).toBe('live');
		expect(diagnose(report, testThresholds({ frame_stall_s: 10 }), settled).state).toBe(
			'frames_stalled',
		);
	});
});

describe('planRemount', () => {
	const broken = { state: 'no_transport', action: 'remount', label: '', detail: '' } as const;
	const healthy = { state: 'live', action: 'none', label: '', detail: '' } as const;
	const T0 = 1_000_000;

	/** Drive the policy the way the page does: one plan per poll, carrying history. */
	const remountAt = (history: readonly number[], nowS: number) => planRemount(broken, history, nowS, T);

	it('remounts on the first transport failure', () => {
		const plan = remountAt([], T0);

		expect(plan.remount).toBe(true);
		expect(plan.delayS).toBe(REMOUNT_BACKOFF_S[0]);
		expect(plan.history).toEqual([T0 + REMOUNT_BACKOFF_S[0]]);
	});

	it('backs off by how many remounts are already in the window', () => {
		// The usual cause of a slow connect is a busy worker, and remounting
		// immediately adds another asset burst to whatever is saturating it.
		expect(remountAt([T0 - 60], T0).delayS).toBe(REMOUNT_BACKOFF_S[1]);
		expect(remountAt([T0 - 120, T0 - 60], T0).delayS).toBe(
			REMOUNT_BACKOFF_S[REMOUNT_BACKOFF_S.length - 1],
		);
		// An entry that has aged out no longer counts toward the backoff.
		expect(remountAt([T0 - REMOUNT_WINDOW_S - 1], T0).delayS).toBe(REMOUNT_BACKOFF_S[0]);
	});

	it('spends the budget within one window, then gives up', () => {
		let history: number[] = [];
		let now = T0;
		for (let i = 0; i < REMOUNT_BUDGET; i++) {
			const plan = remountAt(history, now);
			expect(plan.remount).toBe(true);
			history = plan.history;
			now += 60;
		}
		const plan = remountAt(history, now);

		expect(plan.remount).toBe(false);
		expect(plan.exhausted).toBe(true);
		expect(plan.history).toEqual(history);
	});

	it('does not refund the budget when the notebook recovers in between', () => {
		// A CPU-starved worker flapped stalled/live every minute or two, and
		// refunding on each recovery let one page remount 43 times in 80
		// minutes, each new session adding to the starvation.
		let history: number[] = [];
		let now = T0;
		for (let i = 0; i < REMOUNT_BUDGET; i++) {
			history = remountAt(history, now).history;
			now += 60;
			const recovered = planRemount(healthy, history, now, T);
			expect(recovered.history).toEqual(history);
			history = recovered.history;
			now += 60;
		}

		expect(remountAt(history, now).exhausted).toBe(true);
	});

	it('restores one remount when the oldest ages out of the window', () => {
		const history = [T0, T0 + 60, T0 + 120];
		expect(remountAt(history, T0 + REMOUNT_WINDOW_S - 1).exhausted).toBe(true);

		const plan = remountAt(history, T0 + REMOUNT_WINDOW_S);

		expect(plan.remount).toBe(true);
		expect(plan.history).toEqual([T0 + 60, T0 + 120, T0 + REMOUNT_WINDOW_S + plan.delayS]);
	});

	it('never remounts for a failure a remount cannot fix', () => {
		const wedged = { state: 'frames_stalled', action: 'reload', label: '', detail: '' } as const;

		expect(planRemount(wedged, [], T0, T).remount).toBe(false);
		expect(planRemount(wedged, [], T0, T).exhausted).toBe(false);
	});

	it('reads budget, window and backoff from the thresholds', () => {
		const tight = testThresholds({ remount_budget: 1, remount_window_s: 60, remount_backoff_s: [7] });

		const first = planRemount(broken, [], T0, tight);
		expect(first.delayS).toBe(7);
		expect(planRemount(broken, first.history, T0 + 10, tight).exhausted).toBe(true);
		// The window is 60 s here, so the remount stamped at T0 + 7 ages out by T0 + 68.
		expect(planRemount(broken, first.history, T0 + 68, tight).remount).toBe(true);
	});

	it('returns the pruned history unchanged for a diagnosis that needs no remount', () => {
		const connecting = { state: 'connecting', action: 'none', label: '', detail: '' } as const;
		const history = [T0 - REMOUNT_WINDOW_S - 10, T0 - 300, T0 - 30];

		for (const diagnosis of [connecting, healthy]) {
			const plan = planRemount(diagnosis, history, T0, T);
			expect(plan.remount).toBe(false);
			expect(plan.exhausted).toBe(false);
			expect(plan.history).toEqual([T0 - 300, T0 - 30]);
		}
	});
});

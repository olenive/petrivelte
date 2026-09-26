import { describe, it, expect } from 'vitest';

import type { NotebookSync, NotebookSyncSlot, NotebookTransport } from './api';
import { diagnose } from './notebookSync';
import { testThresholds } from './notebookThresholds.testing';
import {
	dataFact,
	diagnosticsText,
	frameFact,
	healthFacts,
	healthSummary,
	netFact,
} from './notebookHealth';

function slot(over: Partial<NotebookSyncSlot> = {}): NotebookSyncSlot {
	return {
		slot_name: 'parcel_distribution',
		net_id: 'net-1',
		synced: true,
		step_count: 67319,
		running: true,
		last_error: null,
		last_sync_age_s: 0.07,
		report_age_s: 0.07,
		marking_version: 67319,
		reconcile_interval_s: 5,
		last_push_age_s: 1,
		...over,
	};
}

function transport(over: Partial<NotebookTransport> = {}): NotebookTransport {
	return {
		alive: true,
		ws_sessions: 1,
		ws_opened_total: 1,
		last_ws_open_age_s: 10,
		frames_relayed: 900,
		last_frame_age_s: 0.5,
		first_report_age_s: 60,
		...over,
	};
}

function sync(over: Partial<NotebookSync> = {}): NotebookSync {
	return { slots: [slot()], transport: transport(), reachable: true, bindings: 1, ...over };
}

const T = testThresholds();

// The reading taken from the live notebook that prompted this panel: a second
// session on one subprocess, one frame at the handshake and then silence,
// while the bridge stayed perfectly healthy and kept pushing. Its latest push
// is two seconds old; the page remembers the first push it saw go undrawn,
// 140 s ago, which is what `FREEZE_CARRIED` stands for.
const FREEZE_CARRIED = 140;
const OBSERVED_FREEZE = sync({
	slots: [slot({ step_count: 67319, last_sync_age_s: 0.0735, last_push_age_s: 2 })],
	transport: transport({
		ws_sessions: 1,
		ws_opened_total: 2,
		last_ws_open_age_s: 145.5,
		last_frame_age_s: 142.8,
		frames_relayed: 3662,
	}),
});

describe('the three facts', () => {
	it('reports the net as running with its step count', () => {
		expect(netFact(sync())).toMatchObject({ value: 'step 67,319', ok: true });
	});

	it('does not call a deliberately stopped net a failure', () => {
		// Nets are started and stopped on purpose. A red cross here would send
		// people hunting for a fault they created.
		expect(netFact(sync({ slots: [slot({ running: false })] })).ok).toBeNull();
	});

	it('cannot tell anything about a net with no slots', () => {
		expect(netFact(sync({ slots: [] })).ok).toBeNull();
	});

	it('reports fresh notebook data as fine', () => {
		expect(dataFact(sync())).toMatchObject({ value: 'updated just now', ok: true });
	});

	it('reports a slot error against the data, not the connection', () => {
		const fact = dataFact(sync({ slots: [slot({ last_error: 'boom' })] }));
		expect(fact.ok).toBe(false);
		expect(fact.note).toBe('boom');
	});

	it('separates never having synced from having synced long ago', () => {
		expect(dataFact(sync({ slots: [slot({ last_sync_age_s: null })] })).value)
			.toBe('never synced');
		expect(dataFact(sync({ slots: [slot({ last_sync_age_s: 300 })] })).value)
			.toBe('updated 5m 0s ago');
	});

	it('reads ages past an hour in hours and past a day in days', () => {
		const age = (s: number) =>
			dataFact(sync({ slots: [slot({ last_sync_age_s: s, report_age_s: 0.4 })] })).value;
		expect(age(3599)).toBe('updated 59m 59s ago');
		expect(age(3600)).toBe('updated 1h 0m ago');
		expect(age(71439)).toBe('updated 19h 50m ago');
		expect(age(86400)).toBe('updated 1d 0h ago');
		expect(age(2 * 86400 + 3 * 3600 + 59)).toBe('updated 2d 3h ago');
	});

	it('reports a live render channel with its frame count', () => {
		expect(frameFact(sync(), T)).toMatchObject({ ok: true, note: '900 updates received' });
	});

	it('distinguishes never connecting from having disconnected', () => {
		expect(frameFact(sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) }), T).note)
			.toContain('never opened');
		expect(frameFact(sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 3 }) }), T).note)
			.toContain('has closed');
	});

	it('does not call a quiet page stalled when nothing new was pushed', () => {
		// A five-minute net: the last frame followed the last push minutes ago.
		const quiet = sync({
			slots: [slot({ last_push_age_s: 200 })],
			transport: transport({ last_frame_age_s: 199 }),
		});
		expect(frameFact(quiet, T).ok).toBe(true);
	});

	it('agrees with the badge on a push left undrawn past frame_stall_s', () => {
		const stuck = sync({
			slots: [slot({ last_push_age_s: 45 })],
			transport: transport({ last_frame_age_s: 100 }),
		});
		expect(frameFact(stuck, T).ok).toBe(false);
		expect(diagnose(stuck, T, { sinceBurstSettledS: 200 }).state).toBe('frames_stalled');
	});

	it('reads checking before the thresholds have loaded', () => {
		expect(frameFact(sync(), null)).toMatchObject({ value: 'checking', ok: null });
		expect(healthSummary(diagnose(sync(), null, { sinceBurstSettledS: 200 }))).toMatch(
			/thresholds/,
		);
	});

	it('admits it cannot tell when the worker reports no transport', () => {
		expect(frameFact(sync({ transport: null }), T).ok).toBeNull();
	});
});

describe('the observed freeze', () => {
	it('says the net and its data are fine and only the page is stuck', () => {
		const [net, data, frames] = healthFacts(OBSERVED_FREEZE, T, FREEZE_CARRIED);

		expect(net.ok).toBe(true);
		expect(data.ok).toBe(true);
		expect(frames.ok).toBe(false);
	});

	it('names the second session, which is the fact that explains it', () => {
		// A fresh session is the recovery, so whether this is session one or
		// session two is the difference between "try again" and "this is the
		// known freeze".
		expect(frameFact(OBSERVED_FREEZE, T, FREEZE_CARRIED).note).toContain('session 2');
	});

	it('leads with what still works', () => {
		const diagnosis = diagnose(OBSERVED_FREEZE, T, { sinceBurstSettledS: 200, carriedPushAgeS: FREEZE_CARRIED });
		expect(diagnosis.state).toBe('frames_stalled');
		expect(healthSummary(diagnosis)).toMatch(/net and its data are fine/i);
	});
});

describe('summaries for the new states', () => {
	it('says a busy worker has not been found dead', () => {
		const diagnosis = diagnose(
			sync({ reachable: false, reason: 'worker_busy', transport: null }),
			T,
			{ sinceBurstSettledS: 60 },
		);
		expect(diagnosis.state).toBe('worker_busy');
		expect(healthSummary(diagnosis)).toMatch(/Nothing is known to have failed/);
	});

	it('says a dead subprocess leaves the nets alone and names the reload', () => {
		for (const s of [
			sync({ reachable: false, reason: 'subprocess_gone', transport: null }),
			sync({ transport: transport({ alive: false }) }),
		]) {
			const diagnosis = diagnose(s, T, { sinceBurstSettledS: 60 });
			expect(diagnosis.state).toBe('subprocess_gone');
			expect(healthSummary(diagnosis)).toMatch(/subprocess has died/);
			expect(healthSummary(diagnosis)).toMatch(/nets are unaffected/);
		}
	});
});

describe('copyable diagnostics', () => {
	it('carries the evidence rather than just the conclusion', () => {
		const diagnosis = diagnose(OBSERVED_FREEZE, T, { sinceBurstSettledS: 200, carriedPushAgeS: FREEZE_CARRIED });
		const text = diagnosticsText(OBSERVED_FREEZE, diagnosis, 'nb-1', T, FREEZE_CARRIED);

		expect(text).toContain('nb-1');
		expect(text).toContain('frames_stalled');
		// The raw blocks: a report that only quotes the badge cannot be acted on.
		expect(text).toContain('"ws_opened_total":2');
		expect(text).toContain('"step_count":67319');
	});
});

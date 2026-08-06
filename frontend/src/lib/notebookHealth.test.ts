import { describe, it, expect } from 'vitest';

import type { NotebookSync, NotebookSyncSlot, NotebookTransport } from './api';
import { diagnose } from './notebookSync';
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

// The reading taken from the live notebook that prompted this panel: a second
// session on one subprocess, one frame at the handshake and then silence,
// while the bridge stayed perfectly healthy.
const OBSERVED_FREEZE = sync({
	slots: [slot({ step_count: 67319, last_sync_age_s: 0.0735 })],
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

	it('reports a live render channel with its frame count', () => {
		expect(frameFact(sync())).toMatchObject({ ok: true, note: '900 updates received' });
	});

	it('distinguishes never connecting from having disconnected', () => {
		expect(frameFact(sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 0 }) })).note)
			.toContain('never opened');
		expect(frameFact(sync({ transport: transport({ ws_sessions: 0, ws_opened_total: 3 }) })).note)
			.toContain('has closed');
	});

	it('admits it cannot tell when the worker reports no transport', () => {
		expect(frameFact(sync({ transport: null })).ok).toBeNull();
	});
});

describe('the observed freeze', () => {
	it('says the net and its data are fine and only the page is stuck', () => {
		const [net, data, frames] = healthFacts(OBSERVED_FREEZE);

		expect(net.ok).toBe(true);
		expect(data.ok).toBe(true);
		expect(frames.ok).toBe(false);
	});

	it('names the second session, which is the fact that explains it', () => {
		// A fresh session is the recovery, so whether this is session one or
		// session two is the difference between "try again" and "this is the
		// known freeze".
		expect(frameFact(OBSERVED_FREEZE).note).toContain('session 2');
	});

	it('leads with what still works', () => {
		const diagnosis = diagnose(OBSERVED_FREEZE, { sinceBurstSettledS: 200 });
		expect(diagnosis.state).toBe('frames_stalled');
		expect(healthSummary(diagnosis)).toMatch(/net and its data are fine/i);
	});
});

describe('copyable diagnostics', () => {
	it('carries the evidence rather than just the conclusion', () => {
		const diagnosis = diagnose(OBSERVED_FREEZE, { sinceBurstSettledS: 200 });
		const text = diagnosticsText(OBSERVED_FREEZE, diagnosis, 'nb-1');

		expect(text).toContain('nb-1');
		expect(text).toContain('frames_stalled');
		// The raw blocks: a report that only quotes the badge cannot be acted on.
		expect(text).toContain('"ws_opened_total":2');
		expect(text).toContain('"step_count":67319');
	});
});

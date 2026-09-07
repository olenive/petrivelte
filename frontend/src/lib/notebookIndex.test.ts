import { describe, expect, it } from 'vitest';

import type {
	NotebookSync,
	NotebookSyncSlot,
	NotebookTransport,
	WiringNet,
	WiringNotebook,
	WiringResponse,
	WiringWorker,
} from './api';
import {
	UNASSIGNED_KEY,
	groupByWorker,
	notebookBadge,
	viewersHint,
	workerHeader,
} from './notebookIndex';

/**
 * The index's badge is a different measurement from the notebook page's, and
 * the whole point of these tests is that it stays different. The page watches
 * the browser tab's render channel, which is why zero websocket sessions is a
 * fault there. Here there is no tab, so zero is the ordinary state of every
 * healthy row — a badge that consulted `frameFact` would paint the entire list
 * red the moment it was opened. Each case below is one row of the table in
 * `implementation_docs/NOTEBOOKS_INDEX.md`.
 */

function slot(over: Partial<NotebookSyncSlot> = {}): NotebookSyncSlot {
	return {
		slot_name: 'traffic',
		net_id: 'net-1',
		synced: true,
		step_count: 4213,
		running: true,
		last_error: null,
		last_sync_age_s: 0.4,
		report_age_s: 0.4,
		...over,
	};
}

function transport(over: Partial<NotebookTransport> = {}): NotebookTransport {
	return {
		alive: true,
		ws_sessions: 0,
		ws_opened_total: 0,
		last_ws_open_age_s: null,
		frames_relayed: 0,
		last_frame_age_s: null,
		first_report_age_s: 30,
		...over,
	};
}

function sync(over: Partial<NotebookSync> = {}): NotebookSync {
	return { slots: [slot()], transport: transport(), reachable: true, bindings: 1, ...over };
}

function notebook(over: Partial<WiringNotebook> = {}): WiringNotebook {
	return {
		id: 'nb-1',
		definition_name: 'view_traffic',
		instance_name: 'nb traffic',
		worker_id: 'w-1',
		deployment_id: 'dep-1',
		load_state: 'loaded',
		load_error: null,
		slots: [],
		...over,
	};
}

function worker(over: Partial<WiringWorker> = {}): WiringWorker {
	return {
		id: 'w-1',
		name: 'e2e-tailarm-20260903-195657',
		worker_category: 'persistent',
		worker_type: 'fly',
		status: 'ready',
		status_detail: null,
		memory_mb: 2048,
		cpus: 2,
		memory_used_mb: 1310,
		memory_peak_mb: 1400,
		...over,
	};
}

function net(over: Partial<WiringNet> = {}): WiringNet {
	return {
		id: 'net-1',
		definition_name: 'monitor_anomalies',
		instance_name: 'monitor-anomalies',
		worker_id: 'w-1',
		deployment_id: 'dep-1',
		load_state: 'loaded',
		load_error: null,
		...over,
	};
}

function wiring(over: Partial<WiringResponse> = {}): WiringResponse {
	return { workers: [], nets: [], notebooks: [], bindings: [], ...over };
}

describe('the badge table', () => {
	it('reads an unloaded notebook as unloaded', () => {
		const badge = notebookBadge(notebook({ load_state: 'unloaded' }), null);
		expect(badge.name).toBe('unloaded');
		expect(badge.label).toBe('unloaded');
	});

	it('reads a loading notebook as loading', () => {
		const badge = notebookBadge(notebook({ load_state: 'loading', load_error: null }), null);
		expect(badge.name).toBe('loading');
		expect(badge.label).toBe('loading…');
	});

	it('names the load phase when the row carries one', () => {
		const badge = notebookBadge(
			notebook({ load_state: 'loading', load_error: 'spawning subprocess' }),
			null,
		);
		expect(badge.label).toBe('loading… spawning subprocess');
	});

	it('reads a failed load as error and puts load_error in the tooltip', () => {
		const badge = notebookBadge(
			notebook({ load_state: 'error', load_error: 'subprocess_gone' }),
			null,
		);
		expect(badge.name).toBe('error');
		expect(badge.title).toContain('subprocess_gone');
	});

	it('reads a loaded, reachable, fully synced notebook as tracking', () => {
		const badge = notebookBadge(notebook(), sync());
		expect(badge.name).toBe('tracking');
		// The words come from netFact, not from a second opinion invented here.
		expect(badge.detail).toBe('step 4,213');
	});

	it('reads a slot that is not synced as stale', () => {
		const badge = notebookBadge(notebook(), sync({ slots: [slot({ synced: false })] }));
		expect(badge.name).toBe('stale');
		expect(badge.title).toContain('not synced: traffic');
	});

	it('reads a bridge report that has gone quiet as stale', () => {
		// `synced` is still true — the subprocess simply stopped saying so, which
		// is the failure a freshness flag alone cannot see.
		const badge = notebookBadge(
			notebook(),
			sync({ slots: [slot({ synced: true, report_age_s: 120, last_sync_age_s: 120 })] }),
		);
		expect(badge.name).toBe('stale');
		expect(badge.detail).toContain('updated');
	});

	it('reads an unreachable sync as unreachable', () => {
		const badge = notebookBadge(
			notebook(),
			sync({ reachable: false, reason: 'worker_unreachable', slots: [] }),
		);
		expect(badge.name).toBe('unreachable');
	});

	it('reads a loaded notebook with no bindings as idle, not tracking', () => {
		const badge = notebookBadge(notebook(), sync({ slots: [], bindings: 0 }));
		expect(badge.name).toBe('idle');
	});

	it('says it is still checking when the sync has not arrived yet', () => {
		expect(notebookBadge(notebook(), null).name).toBe('checking');
	});

	it('does not let error groups change the verdict', () => {
		// A notebook can track its net perfectly and still have raised
		// exceptions; collapsing the two loses whichever one was being looked for.
		const clean = notebookBadge(notebook(), sync(), 0);
		const noisy = notebookBadge(notebook(), sync(), 3);
		expect(noisy.name).toBe(clean.name);
		expect(noisy.label).toBe(clean.label);
		expect(noisy.title).toContain('3 error groups');
	});

	it('does not treat an empty tab count as a fault', () => {
		// The index has no iframe open, so this is the ordinary healthy case.
		const badge = notebookBadge(notebook(), sync({ transport: transport({ ws_sessions: 0 }) }));
		expect(badge.name).toBe('tracking');
		expect(viewersHint(sync({ transport: transport({ ws_sessions: 0 }) }))).toBeNull();
	});

	it('reports open tabs as a hint when there are any', () => {
		expect(viewersHint(sync({ transport: transport({ ws_sessions: 1 }) }))).toBe('viewed in 1 tab');
		expect(viewersHint(sync({ transport: transport({ ws_sessions: 2 }) }))).toBe('viewed in 2 tabs');
		expect(viewersHint(null)).toBeNull();
	});
});

describe('the worker header line', () => {
	it('reads status, CPUs, memory and net count', () => {
		expect(workerHeader(worker(), 2).line).toBe('ready · 2 CPU · 1310/2048 MB · 2 nets');
	});

	it('omits memory when the worker has not reported it', () => {
		// `0/2048 MB` would read as an idle machine, which is the opposite of
		// "we cannot see".
		expect(workerHeader(worker({ memory_used_mb: null }), 2).line).toBe(
			'ready · 2 CPU · 2 nets',
		);
	});

	it('keeps the net count separable so the page can link it', () => {
		const header = workerHeader(worker(), 1);
		expect(header.nets).toBe('1 net');
		expect(header.parts).toEqual(['ready', '2 CPU', '1310/2048 MB']);
	});

	it('still reports zero nets rather than going quiet', () => {
		expect(workerHeader(worker(), 0).nets).toBe('0 nets');
	});
});

describe('grouping', () => {
	it('keeps a worker with no notebooks', () => {
		// The page's other job is to say where a notebook could go, and a worker
		// that vanishes when it is empty is a worker the user cannot choose.
		const sections = groupByWorker(
			wiring({ workers: [worker({ id: 'w-1', name: 'empty-worker' })] }),
		);
		expect(sections).toHaveLength(1);
		expect(sections[0].title).toBe('empty-worker');
		expect(sections[0].rows).toEqual([]);
	});

	it('puts a notebook with no worker in the unassigned tail', () => {
		const sections = groupByWorker(
			wiring({
				workers: [worker()],
				notebooks: [notebook({ id: 'nb-2', instance_name: 'nb-scratch', worker_id: null })],
			}),
		);
		expect(sections.map((s) => s.key)).toEqual(['w-1', UNASSIGNED_KEY]);
		expect(sections[1].rows.map((r) => r.notebook.instance_name)).toEqual(['nb-scratch']);
		expect(sections[1].header).toBeNull();
	});

	it('treats a worker_id naming a worker that is not in the payload as unassigned', () => {
		const sections = groupByWorker(
			wiring({ workers: [worker()], notebooks: [notebook({ worker_id: 'w-gone' })] }),
		);
		expect(sections[1].key).toBe(UNASSIGNED_KEY);
	});

	it('omits the unassigned tail when nothing is unassigned', () => {
		const sections = groupByWorker(wiring({ workers: [worker()], notebooks: [notebook()] }));
		expect(sections.map((s) => s.key)).toEqual(['w-1']);
	});

	it('sorts workers by name and notebooks by instance name', () => {
		const sections = groupByWorker(
			wiring({
				workers: [worker({ id: 'w-2', name: 'zulu' }), worker({ id: 'w-1', name: 'alpha' })],
				notebooks: [
					notebook({ id: 'nb-b', instance_name: 'nb zebra', worker_id: 'w-1' }),
					notebook({ id: 'nb-a', instance_name: 'nb apple', worker_id: 'w-1' }),
				],
			}),
		);
		expect(sections.map((s) => s.title)).toEqual(['alpha', 'zulu']);
		expect(sections[0].rows.map((r) => r.notebook.instance_name)).toEqual([
			'nb apple',
			'nb zebra',
		]);
	});

	it('resolves each binding to the net it points at', () => {
		const sections = groupByWorker(
			wiring({
				workers: [worker()],
				nets: [net()],
				notebooks: [notebook()],
				bindings: [{ notebook_instance_id: 'nb-1', slot_name: 'traffic', net_id: 'net-1' }],
			}),
		);
		expect(sections[0].rows[0].bindings).toEqual([
			{ slotName: 'traffic', netId: 'net-1', netName: 'monitor-anomalies' },
		]);
	});

	it('leaves a binding whose net is gone unnamed rather than inventing a label', () => {
		const sections = groupByWorker(
			wiring({
				workers: [worker()],
				notebooks: [notebook()],
				bindings: [{ notebook_instance_id: 'nb-1', slot_name: 'traffic', net_id: 'net-gone' }],
			}),
		);
		expect(sections[0].rows[0].bindings[0].netName).toBeNull();
	});

	it('counts only the nets on that worker in its header', () => {
		const sections = groupByWorker(
			wiring({
				workers: [worker({ id: 'w-1', name: 'alpha' }), worker({ id: 'w-2', name: 'beta' })],
				nets: [
					net({ id: 'net-1', worker_id: 'w-1' }),
					net({ id: 'net-2', worker_id: 'w-1' }),
					net({ id: 'net-3', worker_id: 'w-2' }),
					net({ id: 'net-4', worker_id: null }),
				],
			}),
		);
		expect(sections[0].header?.nets).toBe('2 nets');
		expect(sections[1].header?.nets).toBe('1 net');
	});
});

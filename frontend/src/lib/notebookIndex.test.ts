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
	type RowBinding,
	UNASSIGNED_KEY,
	groupByWorker,
	notebookBadge,
	resumeHint,
	viewersHint,
	workerHeader,
} from './notebookIndex';
import { testThresholds } from './notebookThresholds.testing';

const T = testThresholds();

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
		marking_version: 7,
		reconcile_interval_s: 5,
		last_push_age_s: 0.2,
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
		desired_load_state: 'loaded',
		idle_timeout_seconds: null,
		effective_idle_timeout_seconds: 900,
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
		const badge = notebookBadge(notebook({ load_state: 'unloaded' }), null, T);
		expect(badge.name).toBe('unloaded');
		expect(badge.label).toBe('unloaded');
	});

	it('reads a loading notebook as loading', () => {
		const badge = notebookBadge(notebook({ load_state: 'loading', load_error: null }), null, T);
		expect(badge.name).toBe('loading');
		expect(badge.label).toBe('loading…');
	});

	it('names the load phase when the row carries one', () => {
		const badge = notebookBadge(
			notebook({ load_state: 'loading', load_error: 'spawning subprocess' }),
			null,
			T,
		);
		expect(badge.label).toBe('loading… spawning subprocess');
	});

	it('names the step of the load’s operation, ahead of the row’s phase', () => {
		const badge = notebookBadge(
			notebook({ load_state: 'loading', load_error: 'spawning subprocess' }),
			null,
			T,
			0,
			{
				operation: {
					id: 'op-1',
					kind: 'notebook_load',
					trigger: 'user',
					step: 'dependencies',
					step_message: null,
					started_at: '2026-09-25T10:00:00Z',
					heartbeat_at: '2026-09-25T10:00:05Z',
				},
			},
		);
		expect(badge.label).toBe('loading… installing dependencies');
	});

	it('reads a failed load as error and puts load_error in the tooltip', () => {
		const badge = notebookBadge(
			notebook({ load_state: 'error', load_error: 'subprocess_gone' }),
			null,
			T,
		);
		expect(badge.name).toBe('error');
		expect(badge.title).toContain('subprocess_gone');
	});

	it('reads a loaded, reachable, fully synced notebook as tracking', () => {
		const badge = notebookBadge(notebook(), sync(), T);
		expect(badge.name).toBe('tracking');
		// The words come from netFact, not from a second opinion invented here.
		expect(badge.detail).toBe('step 4,213');
	});

	it('reads a slot waiting for its first sync as syncing, not stale', () => {
		const badge = notebookBadge(
			notebook(),
			sync({ slots: [slot({ synced: false, last_sync_age_s: null })] }),
			T,
		);
		expect(badge.name).toBe('syncing');
		expect(badge.label).toBe('syncing…');
		expect(badge.colour).toBe('#eab308');
		expect(badge.title).toContain('waiting for the first sync: traffic');
	});

	describe('a bound net that is not loaded', () => {
		// The bridge is reporting, but its net is not there to sync from, so
		// its slot never syncs. That used to read `stale · never synced`,
		// which pointed at the notebook when the missing piece was the net.
		const neverSynced = sync({
			slots: [slot({ synced: false, last_sync_age_s: null, last_error: 'net not loaded' })],
		});
		const binding = (over: Partial<RowBinding> = {}): RowBinding => ({
			slotName: 'traffic',
			netId: 'net-1',
			netName: 'monitor-anomalies',
			netLoadState: 'unloaded',
			...over,
		});

		it('names the net in the expected tone', () => {
			const badge = notebookBadge(notebook(), neverSynced, T, 0, { bindings: [binding()] });

			expect(badge.name).toBe('net_not_loaded');
			expect(badge.label).toBe('net not loaded');
			expect(badge.colour).toBe('#6b7280');
			expect(badge.detail).toBe('monitor-anomalies unloaded');
			expect(badge.title).toContain('traffic → monitor-anomalies: unloaded');
		});

		it('names every net that is not loaded, and only those', () => {
			const badge = notebookBadge(notebook(), neverSynced, T, 0, {
				bindings: [
					binding(),
					binding({ slotName: 'reach', netId: 'net-2', netName: 'monitor-reachability', netLoadState: 'error' }),
					binding({ slotName: 'zeta', netId: 'net-3', netName: 'fine', netLoadState: 'loaded' }),
				],
			});

			expect(badge.detail).toBe('monitor-anomalies unloaded, monitor-reachability error');
			expect(badge.title).not.toContain('fine');
		});

		it('keeps stale for a net that is loaded and cannot be reached', () => {
			const badge = notebookBadge(notebook(), neverSynced, T, 0, {
				bindings: [binding({ netLoadState: 'loaded' })],
			});

			expect(badge.name).toBe('stale');
			expect(badge.label).toBe('stale');
		});

		it('keeps stale when the net is not in the payload or no bindings are given', () => {
			expect(
				notebookBadge(notebook(), neverSynced, T, 0, {
					bindings: [binding({ netName: null, netLoadState: null })],
				}).name,
			).toBe('stale');
			expect(notebookBadge(notebook(), neverSynced, T).name).toBe('stale');
		});

		it('leaves a notebook nobody has opened as loaded, whatever its net', () => {
			const badge = notebookBadge(
				notebook(),
				sync({ transport: transport({ first_report_age_s: null, ws_opened_total: 0 }) }),
				T,
				0,
				{ bindings: [binding()] },
			);

			expect(badge.name).toBe('loaded');
		});
	});

	it('reads a slot that reports an error as stale', () => {
		const badge = notebookBadge(
			notebook(),
			sync({ slots: [slot({ synced: false, last_error: 'net unreachable' })] }),
			T,
		);
		expect(badge.name).toBe('stale');
		expect(badge.label).toBe('stale');
		expect(badge.title).toContain('behind: traffic (stale)');
		expect(badge.title).toContain('error: traffic: net unreachable');
	});

	it('reads a loaded notebook nobody has opened as loaded, never stale', () => {
		// The bridge starts from a notebook cell, so before the first open there
		// is no report. The slot is a leftover from the previous subprocess.
		const badge = notebookBadge(
			notebook(),
			sync({
				transport: transport({ first_report_age_s: null, ws_opened_total: 0 }),
				slots: [slot({ synced: true, last_sync_age_s: 71992, report_age_s: 71992 })],
			}),
			T,
		);
		expect(badge.name).toBe('loaded');
		expect(badge.label).toBe('loaded');
		expect(badge.detail).toBe('not opened yet');
	});

	it('gives a just-opened notebook time for its bridge to start', () => {
		const badge = notebookBadge(
			notebook(),
			sync({
				transport: transport({
					first_report_age_s: null,
					ws_opened_total: 1,
					last_ws_open_age_s: 5,
				}),
				slots: [],
			}),
			T,
		);
		expect(badge.name).toBe('syncing');
		expect(badge.label).toBe('starting…');
	});

	it('reads a bridge that never started after an open as not tracking', () => {
		const badge = notebookBadge(
			notebook(),
			sync({
				transport: transport({
					first_report_age_s: null,
					ws_opened_total: 1,
					last_ws_open_age_s: T.bridge_start_deadline_s + 1,
				}),
				slots: [],
			}),
			T,
		);
		expect(badge.name).toBe('stale');
		expect(badge.label).toBe('not tracking');
	});

	it('reads a reporting bridge with no slots for its bindings as not tracking', () => {
		const badge = notebookBadge(notebook(), sync({ slots: [], bindings: 1 }), T);
		expect(badge.name).toBe('stale');
		expect(badge.label).toBe('not tracking');
		expect(badge.title).toContain('1 binding');
	});

	it('still reads a healthy slot as tracking from a worker without a transport block', () => {
		const badge = notebookBadge(notebook(), sync({ transport: null }), T);
		expect(badge.name).toBe('tracking');
	});

	it('reads a bridge report that has gone quiet as stale', () => {
		// `synced` is still true — the subprocess simply stopped saying so, which
		// is the failure a freshness flag alone cannot see.
		const badge = notebookBadge(
			notebook(),
			sync({ slots: [slot({ synced: true, report_age_s: 120, last_sync_age_s: 120 })] }),
			T,
		);
		expect(badge.name).toBe('stale');
		expect(badge.detail).toContain('updated');
	});

	it('says why an unloaded row is unloaded, muted for an expected reason', () => {
		const badge = notebookBadge(
			notebook({ load_state: 'unloaded', load_error: 'idle_eviction' }),
			null,
			T,
		);
		expect(badge.name).toBe('unloaded');
		expect(badge.label).toBe('unloaded');
		expect(badge.colour).toBe('#9ca3af');
		// The row's own effective timeout (900 s) names the duration.
		expect(badge.detail).toBe('evicted after 15 min of inactivity (frees worker RAM)');
		expect(badge.title).toContain('reason code: idle_eviction');
	});

	it('shows a worker restart muted, as expected rather than as a failure', () => {
		const badge = notebookBadge(
			notebook({ load_state: 'unloaded', load_error: 'worker_restarted' }),
			null,
			T,
		);
		expect(badge.name).toBe('unloaded');
		expect(badge.colour).toBe('#9ca3af');
		expect(badge.detail).toBe(
			'the worker restarted; it will be loaded again if it was wanted',
		);
		expect(badge.title).toContain('reason code: worker_restarted');
	});

	it('shows a worker delete muted in the Unassigned section, not as a failure', () => {
		const badge = notebookBadge(
			notebook({ worker_id: null, load_state: 'unloaded', load_error: 'worker_deleted' }),
			null,
			T,
		);
		expect(badge.name).toBe('unloaded');
		expect(badge.colour).toBe('#9ca3af');
		expect(badge.detail).toBe('worker was deleted');
		expect(badge.title).toContain('reason code: worker_deleted');
	});

	it('turns an unloaded row red when it died of a failure', () => {
		for (const code of [
			'oom_killed',
			'subprocess_killed',
			'subprocess_crashed',
			'subprocess_exited',
			'subprocess_gone',
		]) {
			const badge = notebookBadge(notebook({ load_state: 'unloaded', load_error: code }), null, T);
			expect(badge.name, code).toBe('unloaded');
			expect(badge.label, code).toBe('unloaded');
			expect(badge.colour, code).toBe('#ef4444');
			expect(badge.detail, code).not.toBeNull();
			expect(badge.title, code).toContain(`reason code: ${code}`);
		}
	});

	it('names the worker size on an OOM kill when it is known', () => {
		const badge = notebookBadge(
			notebook({ load_state: 'unloaded', load_error: 'oom_killed' }),
			null,
			T,
			0,
			{ workerMemoryMb: 2048 },
		);
		expect(badge.detail).toBe("killed by the worker's kernel: out of memory on a 2048 MB worker");
		expect(badge.title).toContain('The notebook subprocess stopped:');
	});

	it('keeps the plain unloaded badge when no reason is recorded', () => {
		const badge = notebookBadge(notebook({ load_state: 'unloaded', load_error: null }), null, T);
		expect(badge.colour).toBe('#9ca3af');
		expect(badge.detail).toBeNull();
		expect(badge.title).toBe('The notebook subprocess is not running. Load starts it.');
	});

	it('reads a probe timeout as a busy worker, not an unreachable one', () => {
		const badge = notebookBadge(
			notebook(),
			sync({ reachable: false, reason: 'worker_busy', slots: [] }),
			T,
		);
		expect(badge.name).toBe('busy');
		expect(badge.label).toBe('worker busy');
		expect(badge.colour).toBe('#f59e0b');
	});

	it('reads a worker that forgot the notebook as subprocess gone', () => {
		const badge = notebookBadge(
			notebook(),
			sync({ reachable: false, reason: 'subprocess_gone', slots: [] }),
			T,
		);
		expect(badge.name).toBe('gone');
		expect(badge.label).toBe('subprocess gone');
		expect(badge.colour).toBe('#ef4444');
		expect(badge.title).toBe('The notebook subprocess died. Reload to respawn it.');
	});

	it('reads a dead transport as gone, never as stale, even with ageing slots', () => {
		// The incident: a killed kernel's slots keep their last report and age,
		// which used to read as 'stale'.
		const badge = notebookBadge(
			notebook(),
			sync({
				transport: transport({ alive: false }),
				slots: [slot({ synced: true, report_age_s: 600, last_sync_age_s: 600 })],
			}),
			T,
		);
		expect(badge.name).toBe('gone');
		expect(badge.label).toBe('subprocess gone');
	});

	it('reads a dead transport as gone even with nothing bound', () => {
		const badge = notebookBadge(
			notebook(),
			sync({ transport: transport({ alive: false }), slots: [], bindings: 0 }),
			T,
		);
		expect(badge.name).toBe('gone');
	});

	it('reads an unreachable sync as unreachable', () => {
		const badge = notebookBadge(
			notebook(),
			sync({ reachable: false, reason: 'worker_unreachable', slots: [] }),
			T,
		);
		expect(badge.name).toBe('unreachable');
	});

	it('reads a loaded notebook with no bindings as idle, not tracking', () => {
		const badge = notebookBadge(notebook(), sync({ slots: [], bindings: 0 }), T);
		expect(badge.name).toBe('idle');
	});

	it('reads checking for a loaded row until the thresholds have loaded', () => {
		const stale = sync({ slots: [slot({ last_sync_age_s: 999, report_age_s: 999 })] });
		for (const report of [sync(), stale]) {
			const badge = notebookBadge(notebook(), report, null);
			expect(badge.name).toBe('checking');
			expect(badge.label).toBe('checking…');
			expect(badge.title).toContain('thresholds');
		}
	});

	it('still says why an unloaded row is unloaded before the thresholds load', () => {
		// Load state needs no thresholds, so it is not held back by them.
		expect(notebookBadge(notebook({ load_state: 'unloaded' }), null, null).name).toBe('unloaded');
		expect(notebookBadge(notebook({ load_state: 'error' }), null, null).name).toBe('error');
	});

	it('judges a backed-off slot against its own interval', () => {
		// Sixty seconds between checks: fifty seconds old is on time, not stale.
		const backedOff = sync({
			slots: [slot({ reconcile_interval_s: 60, last_sync_age_s: 50, report_age_s: 50 })],
		});
		expect(notebookBadge(notebook(), backedOff, T).name).toBe('tracking');
		const onDefault = sync({
			slots: [slot({ reconcile_interval_s: null, last_sync_age_s: 50, report_age_s: 50 })],
		});
		expect(notebookBadge(notebook(), onDefault, T).name).toBe('stale');
	});

	it('says it is still checking when the sync has not arrived yet', () => {
		expect(notebookBadge(notebook(), null, T).name).toBe('checking');
	});

	it('does not let error groups change the verdict', () => {
		// A notebook can track its net perfectly and still have raised
		// exceptions; collapsing the two loses whichever one was being looked for.
		const clean = notebookBadge(notebook(), sync(), T, 0);
		const noisy = notebookBadge(notebook(), sync(), T, 3);
		expect(noisy.name).toBe(clean.name);
		expect(noisy.label).toBe(clean.label);
		expect(noisy.title).toContain('3 error groups');
	});

	it('does not treat an empty tab count as a fault', () => {
		// The index has no iframe open, so this is the ordinary healthy case.
		const badge = notebookBadge(notebook(), sync({ transport: transport({ ws_sessions: 0 }) }), T);
		expect(badge.name).toBe('tracking');
		expect(viewersHint(sync({ transport: transport({ ws_sessions: 0 }) }))).toBeNull();
	});

	it('reports open tabs as a hint when there are any', () => {
		expect(viewersHint(sync({ transport: transport({ ws_sessions: 1 }) }))).toBe('viewed in 1 tab');
		expect(viewersHint(sync({ transport: transport({ ws_sessions: 2 }) }))).toBe('viewed in 2 tabs');
		expect(viewersHint(null)).toBeNull();
	});
});

/**
 * Only a worker restart unloads a notebook while leaving its desired load
 * state at loaded, and the control plane loads such a notebook again. The
 * row says so; every other combination has nothing to add.
 */
describe('resumeHint', () => {
	it('promises a resume on an unloaded row that is still wanted loaded', () => {
		expect(
			resumeHint(notebook({ load_state: 'unloaded', desired_load_state: 'loaded' })),
		).toBe('will resume after a worker restart');
	});

	it('says nothing for an unloaded row nobody wants loaded', () => {
		expect(
			resumeHint(notebook({ load_state: 'unloaded', desired_load_state: 'unloaded' })),
		).toBeNull();
	});

	it('says nothing on a row that is not unloaded', () => {
		for (const load_state of ['loaded', 'loading', 'error']) {
			expect(
				resumeHint(notebook({ load_state, desired_load_state: 'loaded' })),
				load_state,
			).toBeNull();
		}
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
			{
				slotName: 'traffic',
				netId: 'net-1',
				netName: 'monitor-anomalies',
				netLoadState: 'loaded',
			},
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
		expect(sections[0].rows[0].bindings[0].netLoadState).toBeNull();
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

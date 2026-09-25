/**
 * The notebooks index, as data.
 *
 * `/notebooks/<id>` answers "is *this* notebook drawing?". The index answers a
 * different question — "which notebooks exist, where do they run, are they
 * healthy" — and the difference matters most in the badge.
 *
 * The notebook page measures the *browser tab's* render channel: it has an
 * iframe open, so a websocket session count of zero there is a real fault.
 * The index has no tab open on anything, so zero sessions is the normal case
 * and `frameFact` would paint every healthy row red. Badges here therefore
 * derive from `load_state` plus the bridge's own report in `/sync`, and
 * `frameFact` is deliberately never consulted. The websocket count survives
 * only as a muted "viewed in N tabs" hint, which is information rather than a
 * verdict.
 *
 * Pure and fetch-free, like `notebookHealth.ts` and `notebookOccupancy.ts`:
 * the interesting part is a table of cases, and a table is worth asserting
 * without a browser.
 */

import type {
	NotebookSync,
	Operation,
	OperationSummary,
	WiringNotebook,
	WiringResponse,
	WiringWorker,
} from '$lib/api';
import { stepLabel } from '$lib/operations';
import { dataFact, netFact } from '$lib/notebookHealth';
import { describeLoadError } from '$lib/notebookLoadReason';
import { slotSyncState } from '$lib/notebookSync';
import type { NotebookViewerThresholds } from '$lib/notebookThresholds';

// -- sections -------------------------------------------------------------

/** Key of the trailing section holding notebooks with no worker. */
export const UNASSIGNED_KEY = '__unassigned__';

/** One bound slot, resolved to the net it points at. */
export interface RowBinding {
	slotName: string;
	netId: string;
	/** The net's instance name, or null when the net is not in the payload —
	 *  a binding can outlive the net row it names, and inventing a label for
	 *  one would hide exactly that. */
	netName: string | null;
}

export interface NotebookRow {
	notebook: WiringNotebook;
	bindings: RowBinding[];
}

/**
 * A worker's header line, split where the page needs a link.
 *
 * `nets` is separate because the net count is the only place nets appear on
 * this page and it links to `/nets`; `line` is the whole thing joined, which
 * is what the tests assert and what the tooltip carries.
 */
export interface WorkerHeader {
	/** Status, CPUs and memory — the parts that are plain text. */
	parts: string[];
	/** `2 nets`, rendered as a link to the Nets page. */
	nets: string;
	line: string;
}

export interface NotebookSection {
	key: string;
	title: string;
	/** null for the unassigned tail, which has no worker to describe. */
	worker: WiringWorker | null;
	header: WorkerHeader | null;
	rows: NotebookRow[];
}

function byName(a: string, b: string): number {
	return a.localeCompare(b);
}

/**
 * The worker header line.
 *
 * Memory is omitted rather than zeroed when the worker has not reported it:
 * `0/2048 MB` reads as an idle machine, which is the opposite of "we cannot
 * see". The net count is always shown, including zero — the absence of nets
 * on a worker running notebooks is itself worth reading.
 */
export function workerHeader(worker: WiringWorker, netCount: number): WorkerHeader {
	const parts = [worker.status, `${worker.cpus} CPU`];
	if (worker.memory_used_mb !== null && worker.memory_used_mb !== undefined) {
		parts.push(`${Math.round(worker.memory_used_mb)}/${worker.memory_mb} MB`);
	}
	const nets = `${netCount} net${netCount === 1 ? '' : 's'}`;
	return { parts, nets, line: [...parts, nets].join(' · ') };
}

/**
 * Group the wiring payload into one section per worker, plus an unassigned tail.
 *
 * Workers with no notebooks are kept: the page's other job is to say where a
 * notebook *could* go, and a worker that vanishes when it is empty is a worker
 * the user cannot choose. A notebook whose `worker_id` names a worker missing
 * from the payload falls into the tail rather than into a section of its own —
 * same rule the wiring canvas uses.
 */
export function groupByWorker(wiring: WiringResponse): NotebookSection[] {
	const netNames = new Map(wiring.nets.map((n) => [n.id, n.instance_name]));
	const bindingsByNotebook = new Map<string, RowBinding[]>();
	for (const b of wiring.bindings) {
		const row: RowBinding = {
			slotName: b.slot_name,
			netId: b.net_id,
			netName: netNames.get(b.net_id) ?? null,
		};
		const existing = bindingsByNotebook.get(b.notebook_instance_id);
		if (existing) existing.push(row);
		else bindingsByNotebook.set(b.notebook_instance_id, [row]);
	}

	const toRow = (notebook: WiringNotebook): NotebookRow => ({
		notebook,
		bindings: (bindingsByNotebook.get(notebook.id) ?? [])
			.slice()
			.sort((a, b) => byName(a.slotName, b.slotName)),
	});

	const workerIds = new Set(wiring.workers.map((w) => w.id));
	const notebooksByWorker = new Map<string, WiringNotebook[]>();
	const unassigned: WiringNotebook[] = [];
	for (const nb of wiring.notebooks) {
		if (nb.worker_id && workerIds.has(nb.worker_id)) {
			const existing = notebooksByWorker.get(nb.worker_id);
			if (existing) existing.push(nb);
			else notebooksByWorker.set(nb.worker_id, [nb]);
		} else {
			unassigned.push(nb);
		}
	}

	const netCounts = new Map<string, number>();
	for (const net of wiring.nets) {
		if (!net.worker_id) continue;
		netCounts.set(net.worker_id, (netCounts.get(net.worker_id) ?? 0) + 1);
	}

	const sections: NotebookSection[] = wiring.workers
		.slice()
		.sort((a, b) => byName(a.name, b.name))
		.map((worker) => ({
			key: worker.id,
			title: worker.name,
			worker,
			header: workerHeader(worker, netCounts.get(worker.id) ?? 0),
			rows: (notebooksByWorker.get(worker.id) ?? [])
				.slice()
				.sort((a, b) => byName(a.instance_name, b.instance_name))
				.map(toRow),
		}));

	if (unassigned.length > 0) {
		sections.push({
			key: UNASSIGNED_KEY,
			title: 'Unassigned',
			worker: null,
			header: null,
			rows: unassigned
				.slice()
				.sort((a, b) => byName(a.instance_name, b.instance_name))
				.map(toRow),
		});
	}

	return sections;
}

/** Every notebook on the page, in the order the sections render them. */
export function allRows(sections: NotebookSection[]): NotebookRow[] {
	return sections.flatMap((s) => s.rows);
}

// -- badges ---------------------------------------------------------------

export type NotebookBadgeName =
	| 'unloaded'
	| 'loading'
	| 'error'
	| 'tracking'
	| 'stale'
	| 'unreachable'
	| 'busy'
	| 'gone'
	| 'idle'
	| 'checking';

export interface NotebookIndexBadge {
	name: NotebookBadgeName;
	/** What the row shows. `loading` carries its phase here when there is one. */
	label: string;
	colour: string;
	/** The tooltip: everything the verdict was derived from. */
	title: string;
	/** One short phrase shown next to the badge, or null. */
	detail: string | null;
}

const COLOURS: Record<NotebookBadgeName, string> = {
	unloaded: '#9ca3af',
	loading: '#eab308',
	error: '#ef4444',
	tracking: '#22c55e',
	stale: '#f59e0b',
	unreachable: '#ef4444',
	busy: '#f59e0b',
	gone: '#ef4444',
	idle: '#6b7280',
	checking: '#9ca3af',
};

/** The fields of a notebook row the badge is allowed to read. The idle
 *  timeout is optional so a caller holding only the two load fields can still
 *  ask; without it the eviction label falls back to its generic wording. */
export type BadgeSource = Pick<WiringNotebook, 'load_state' | 'load_error'> &
	Partial<Pick<WiringNotebook, 'effective_idle_timeout_seconds'>>;

/** Context from outside the notebook row. */
export interface BadgeContext {
	/** The worker's configured RAM, named in an OOM kill's label. */
	workerMemoryMb?: number | null;
	/** The notebook's running operation (its load), when one is known. */
	operation?: Operation | OperationSummary | null;
}

/** Red, for an unloaded row whose reason is a failure. */
const FAILURE_COLOUR = '#ef4444';

const GONE_TITLE = 'The notebook subprocess died. Reload to respawn it.';

function factLine(fact: { label: string; value: string; note?: string }): string {
	return fact.note ? `${fact.label}: ${fact.value} — ${fact.note}` : `${fact.label}: ${fact.value}`;
}

function errorsLine(errorCount: number): string[] {
	if (errorCount <= 0) return [];
	return [`${errorCount} error group${errorCount === 1 ? '' : 's'} recorded`];
}

/**
 * The badge for one row.
 *
 * Ordered load state first, then the bridge, because a notebook that is not
 * running has nothing to say about its slots and a later check must not get
 * the chance to contradict that with staler evidence. Within the loaded
 * branch, `idle` precedes `tracking` for the same reason `syncBadge` returns
 * null on an empty slot list: "every slot is synced" is vacuously true when
 * there are no slots, and a notebook bound to nothing would otherwise render
 * as healthily tracking something it has never been given.
 *
 * `thresholds` is null until the control plane has served them; a loaded row
 * reads `checking` until then.
 *
 * `errorCount` never changes the verdict — a notebook can be tracking
 * perfectly and still have raised exceptions, and collapsing the two would
 * lose whichever the reader was looking for. It is named in the tooltip only;
 * the count itself is its own column on the row.
 */
export function notebookBadge(
	notebook: BadgeSource,
	sync: NotebookSync | null,
	thresholds: NotebookViewerThresholds | null,
	errorCount = 0,
	ctx: BadgeContext = {},
): NotebookIndexBadge {
	const badge = (
		name: NotebookBadgeName,
		label: string,
		titleLines: string[],
		detail: string | null = null,
	): NotebookIndexBadge => ({
		name,
		label,
		colour: COLOURS[name],
		title: [...titleLines, ...errorsLine(errorCount)].join('\n'),
		detail,
	});

	if (notebook.load_state === 'unloaded') {
		// Say why it is unloaded. An expected reason (idle eviction, a stopped
		// worker) is shown muted; a failure (OOM kill, crash) turns the row red
		// so it stands out on the index, while the label still says what the
		// state is.
		const reason = describeLoadError(notebook.load_state, notebook.load_error, {
			idleTimeoutSeconds: notebook.effective_idle_timeout_seconds,
			workerMemoryMb: ctx.workerMemoryMb,
		});
		if (!reason) {
			return badge('unloaded', 'unloaded', [
				'The notebook subprocess is not running. Load starts it.',
			]);
		}
		const failed = reason.tone === 'failure';
		const unloaded = badge(
			'unloaded',
			'unloaded',
			[
				failed
					? `The notebook subprocess stopped: ${reason.label}. Load starts it again.`
					: `The notebook subprocess is not running: ${reason.label}. Load starts it.`,
				`reason code: ${reason.code}`,
			],
			reason.label,
		);
		return failed ? { ...unloaded, colour: FAILURE_COLOUR } : unloaded;
	}

	if (notebook.load_state === 'loading') {
		// The load's operation names its step; before one is known, the
		// worker's phase stamped onto the row is the next best witness.
		const phase = stepLabel(ctx.operation?.step) ?? (notebook.load_error?.trim() || null);
		return badge(
			'loading',
			phase ? `loading… ${phase}` : 'loading…',
			[phase ? `Loading — ${phase}.` : 'The notebook subprocess is starting.'],
		);
	}

	if (notebook.load_state === 'error') {
		return badge('error', 'error', [notebook.load_error || 'The notebook failed to load.']);
	}

	// Loaded (and anything the control plane invents later: the bridge's own
	// report is a better witness than a load_state this build has not heard of).

	if (!sync) {
		return badge('checking', 'checking…', ['Waiting for this notebook’s sync report.']);
	}
	// A loaded row's freshness is judged against served thresholds, and
	// judging it before they arrive would be a guess.
	if (!thresholds) {
		return badge('checking', 'checking…', ['Loading the thresholds this page judges by.']);
	}

	if (sync.reachable === false) {
		if (sync.reason === 'worker_busy') {
			return badge('busy', 'worker busy', [
				'The worker took more than 5 s to answer; it is probably saturated. Nothing is known to be dead.',
			]);
		}
		if (sync.reason === 'subprocess_gone') {
			return badge('gone', 'subprocess gone', [GONE_TITLE]);
		}
		return badge('unreachable', 'unreachable', [
			sync.reason === 'no_worker'
				? 'This notebook is not assigned to a worker.'
				: sync.reason === 'not_loaded'
					? 'The notebook subprocess is not running.'
					: 'The control plane could not reach this notebook’s worker.',
		]);
	}

	// Before any slot check: a dead kernel's slots keep their last report and
	// only age, which would otherwise read as 'stale' rather than dead.
	if (sync.transport && !sync.transport.alive) {
		return badge('gone', 'subprocess gone', [GONE_TITLE]);
	}

	const slots = sync.slots ?? [];
	const bindings = sync.bindings ?? slots.length;
	if (bindings === 0) {
		return badge('idle', 'idle', [
			'Loaded, with no nets bound. Bind a slot on the Wiring page to give it something to track.',
		]);
	}

	const net = netFact(sync);
	const data = dataFact(sync);
	const facts = [factLine(net), factLine(data)];

	const unsynced = slots.filter((s) => !s.synced).map((s) => s.slot_name);
	// The report's own age, judged against the slot's cadence by
	// `slotSyncState`: a slot whose subprocess went quiet keeps reporting
	// whatever it last managed to read, so `synced` alone would stay true
	// while the data rots.
	const behind = slots.filter((s) => {
		const state = slotSyncState(s, thresholds);
		return state === 'stale' || state === 'disconnected';
	});

	if (unsynced.length > 0 || behind.length > 0 || data.ok === false) {
		const lines = [...facts];
		if (unsynced.length > 0) lines.push(`not synced: ${unsynced.join(', ')}`);
		if (behind.length > 0) {
			lines.push(`behind: ${behind.map((s) => `${s.slot_name} (${slotSyncState(s, thresholds)})`).join(', ')}`);
		}
		return badge('stale', 'stale', lines, data.value);
	}

	return badge('tracking', 'tracking', facts, net.value);
}

/**
 * Who else is looking, from the worker's websocket counters.
 *
 * A hint, never a verdict: nobody having the notebook open is the ordinary
 * state of a notebook seen from a list, and the index must not read that as a
 * failure the way the notebook page legitimately does.
 */
export function viewersHint(sync: NotebookSync | null): string | null {
	const sessions = sync?.transport?.ws_sessions ?? 0;
	if (sessions <= 0) return null;
	return `viewed in ${sessions} tab${sessions === 1 ? '' : 's'}`;
}

/** Whether a row's `/sync` and `/errors` are worth fetching at all. */
export function isLoaded(notebook: BadgeSource): boolean {
	return notebook.load_state === 'loaded';
}

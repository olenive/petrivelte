<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import AppNav from '$lib/components/AppNav.svelte';
	import { portal } from '$lib/actions/portal';
	import {
		getWiring,
		createNotebook,
		deleteNotebook,
		loadNotebook,
		unloadNotebook,
		bindNotebookSlot,
		unbindNotebookSlot,
		listDeployments,
		type WiringResponse,
		type WiringWorker,
		type WiringNet,
		type WiringNotebook,
		type WiringBinding,
		type Deployment,
		type DiscoveredNotebook,
	} from '$lib/api';
	import {
		serverEventsStore,
		connectionStateStore,
		type ServerEvent,
		type ConnectionState,
	} from '$lib/stores/serverEvents';
	import { workerMemoryStore, type WorkerMemorySnapshot } from '$lib/stores/workerMemory';

	// ---- data ----

	let wiring = $state<WiringResponse | null>(null);
	let loadError = $state<string | null>(null);
	let deployments = $state<Deployment[]>([]);

	// SvelteFlow needs writable $state arrays.
	let nodes = $state<Node[]>([]);
	let edges = $state<Edge[]>([]);

	// ---- side panel ----

	type SidePanelSelection =
		| { kind: 'net'; id: string }
		| { kind: 'notebook'; id: string }
		| { kind: 'worker'; id: string }
		| null;

	let selection = $state<SidePanelSelection>(null);
	let panelBusy = $state(false);
	let panelError = $state<string | null>(null);

	// ---- bind modal ----

	let bindModal = $state<{
		open: boolean;
		notebookId: string;
		slotName: string;
		error: string | null;
		busy: boolean;
	}>({ open: false, notebookId: '', slotName: '', error: null, busy: false });

	// ---- add-notebook modal ----

	let addModal = $state<{
		open: boolean;
		deploymentId: string;
		definitionName: string;
		instanceName: string;
		workerId: string;
		error: string | null;
		busy: boolean;
	}>({
		open: false,
		deploymentId: '',
		definitionName: '',
		instanceName: '',
		workerId: '',
		error: null,
		busy: false,
	});

	// ---- layout knobs ----

	const WORKER_WIDTH = 360;
	const WORKER_GAP_X = 32;
	const WORKER_HEADER_HEIGHT = 64;
	const CHILD_WIDTH = 160;
	const CHILD_HEIGHT = 64;
	const CHILD_GAP = 12;
	const CHILD_LEFT_PAD = 16;
	const UNASSIGNED_ID = '__unassigned__';

	// ---- lifecycle ----

	let unsubServerEvents: (() => void) | null = null;
	let unsubConnection: (() => void) | null = null;
	let unsubMemory: (() => void) | null = null;
	let lastEventSeq = -1;
	let connectionState = $state<ConnectionState>('disconnected');

	onMount(async () => {
		await refresh();
		// Live updates: react to events emitted by the control plane. We mutate
		// the in-memory wiring snapshot in place and rebuild the graph; full
		// refetch still happens after user actions (create/delete/bind/etc.).
		unsubServerEvents = serverEventsStore.subscribe((evt) => {
			if (!evt) return;
			// `seq` dedupes — Svelte stores may replay the last value on
			// subscribe; we only act on each event once.
			const seq = typeof evt.seq === 'number' ? evt.seq : null;
			if (seq !== null) {
				if (seq <= lastEventSeq) return;
				lastEventSeq = seq;
			}
			applyServerEvent(evt);
		});
		unsubMemory = workerMemoryStore.subscribe((m) => {
			applyMemorySnapshot(m);
		});
		unsubConnection = connectionStateStore.subscribe((s) => {
			connectionState = s;
		});
	});

	onDestroy(() => {
		unsubServerEvents?.();
		unsubMemory?.();
		unsubConnection?.();
	});

	function applyServerEvent(evt: ServerEvent): void {
		if (!wiring) return;
		let changed = false;
		if (evt.type === 'worker_state_changed') {
			const w = wiring.workers.find((x) => x.id === evt.worker_id);
			if (w) {
				w.status = evt.status;
				w.status_detail = evt.status_detail ?? null;
				changed = true;
			}
		} else if (evt.type === 'net_state_changed') {
			const n = wiring.nets.find((x) => x.id === evt.net_id);
			if (n && n.load_state !== evt.load_state) {
				n.load_state = evt.load_state;
				changed = true;
			}
		} else if (evt.type === 'notebook_state_changed') {
			const nb = wiring.notebooks.find((x) => x.id === evt.notebook_id);
			if (nb && nb.load_state !== evt.load_state) {
				nb.load_state = evt.load_state;
				changed = true;
			}
		}
		if (changed) rebuildGraph(wiring);
	}

	function applyMemorySnapshot(m: Map<string, WorkerMemorySnapshot>): void {
		if (!wiring || m.size === 0) return;
		let changed = false;
		for (const w of wiring.workers) {
			const snap = m.get(w.id);
			if (!snap) continue;
			const rss = snap.parent_rss_mb ?? null;
			const peak = snap.parent_peak_rss_mb ?? null;
			if (rss !== w.memory_used_mb || peak !== w.memory_peak_mb) {
				w.memory_used_mb = rss;
				w.memory_peak_mb = peak;
				changed = true;
			}
		}
		if (changed) rebuildGraph(wiring);
	}

	async function refresh() {
		try {
			const [w, deps] = await Promise.all([getWiring(), listDeployments()]);
			wiring = w;
			deployments = deps;
			rebuildGraph(w);
		} catch (e: any) {
			loadError = e?.message ?? String(e);
		}
	}

	// ---- helpers ----

	function statusBadgeColor(status: string): string {
		switch (status) {
			case 'ready':
			case 'loaded':
				return '#22c55e';
			case 'loading':
				return '#eab308';
			case 'error':
				return '#ef4444';
			case 'stopped':
			case 'unloaded':
				return '#9ca3af';
			default:
				return '#3b82f6';
		}
	}

	function findNet(id: string): WiringNet | undefined {
		return wiring?.nets.find((n) => n.id === id);
	}
	function findNotebook(id: string): WiringNotebook | undefined {
		return wiring?.notebooks.find((n) => n.id === id);
	}
	function findWorker(id: string): WiringWorker | undefined {
		return wiring?.workers.find((w) => w.id === id);
	}
	function bindingsForNotebook(id: string): WiringBinding[] {
		return wiring?.bindings.filter((b) => b.notebook_instance_id === id) ?? [];
	}

	function rebuildGraph(w: WiringResponse): void {
		const out: Node[] = [];
		const childrenByWorker = new Map<string, { nets: WiringNet[]; notebooks: WiringNotebook[] }>();
		const unassignedNets: WiringNet[] = [];
		const unassignedNotebooks: WiringNotebook[] = [];

		for (const wk of w.workers) {
			childrenByWorker.set(wk.id, { nets: [], notebooks: [] });
		}
		for (const n of w.nets) {
			if (n.worker_id && childrenByWorker.has(n.worker_id)) {
				childrenByWorker.get(n.worker_id)!.nets.push(n);
			} else {
				unassignedNets.push(n);
			}
		}
		for (const nb of w.notebooks) {
			if (nb.worker_id && childrenByWorker.has(nb.worker_id)) {
				childrenByWorker.get(nb.worker_id)!.notebooks.push(nb);
			} else {
				unassignedNotebooks.push(nb);
			}
		}

		w.workers.forEach((wk, i) => {
			const children = childrenByWorker.get(wk.id)!;
			const rows = Math.max(children.nets.length, children.notebooks.length, 1);
			const workerHeight = WORKER_HEADER_HEIGHT + rows * (CHILD_HEIGHT + CHILD_GAP) + CHILD_GAP;
			const x = i * (WORKER_WIDTH + WORKER_GAP_X);

			out.push({
				id: wk.id,
				type: 'group',
				position: { x, y: 0 },
				data: { kind: 'worker' },
				style: `width: ${WORKER_WIDTH}px; height: ${workerHeight}px; background: var(--bg-secondary, #1f2937); border: 1px solid var(--border, #374151); border-radius: 8px;`,
			});
			out.push({
				id: `${wk.id}-header`,
				type: 'default',
				parentId: wk.id,
				extent: 'parent',
				draggable: false,
				selectable: false,
				position: { x: 8, y: 6 },
				data: { label: workerHeaderLabel(wk) },
				style: `width: ${WORKER_WIDTH - 16}px; background: transparent; border: none; color: var(--text-primary, #f3f4f6); font-weight: 600; font-size: 13px; text-align: left; padding: 4px 8px;`,
			});

			children.nets.forEach((n, row) => {
				out.push(
					makeNetNode(
						n,
						wk.id,
						CHILD_LEFT_PAD,
						WORKER_HEADER_HEIGHT + row * (CHILD_HEIGHT + CHILD_GAP),
					),
				);
			});
			children.notebooks.forEach((nb, row) => {
				out.push(
					makeNotebookNode(
						nb,
						wk.id,
						CHILD_LEFT_PAD + CHILD_WIDTH + 16,
						WORKER_HEADER_HEIGHT + row * (CHILD_HEIGHT + CHILD_GAP),
					),
				);
			});
		});

		if (unassignedNets.length || unassignedNotebooks.length) {
			const rows = Math.max(unassignedNets.length, unassignedNotebooks.length, 1);
			const workerHeight = WORKER_HEADER_HEIGHT + rows * (CHILD_HEIGHT + CHILD_GAP) + CHILD_GAP;
			const x = w.workers.length * (WORKER_WIDTH + WORKER_GAP_X);
			out.push({
				id: UNASSIGNED_ID,
				type: 'group',
				position: { x, y: 0 },
				data: { kind: 'unassigned' },
				style: `width: ${WORKER_WIDTH}px; height: ${workerHeight}px; background: var(--bg-secondary, #1f2937); border: 1px dashed var(--border, #374151); border-radius: 8px;`,
			});
			out.push({
				id: `${UNASSIGNED_ID}-header`,
				type: 'default',
				parentId: UNASSIGNED_ID,
				extent: 'parent',
				draggable: false,
				selectable: false,
				position: { x: 8, y: 6 },
				data: { label: 'Unassigned (no worker)' },
				style: `width: ${WORKER_WIDTH - 16}px; background: transparent; border: none; color: var(--text-muted, #9ca3af); font-weight: 600; font-size: 13px; padding: 4px 8px;`,
			});
			unassignedNets.forEach((n, row) => {
				out.push(
					makeNetNode(
						n,
						UNASSIGNED_ID,
						CHILD_LEFT_PAD,
						WORKER_HEADER_HEIGHT + row * (CHILD_HEIGHT + CHILD_GAP),
					),
				);
			});
			unassignedNotebooks.forEach((nb, row) => {
				out.push(
					makeNotebookNode(
						nb,
						UNASSIGNED_ID,
						CHILD_LEFT_PAD + CHILD_WIDTH + 16,
						WORKER_HEADER_HEIGHT + row * (CHILD_HEIGHT + CHILD_GAP),
					),
				);
			});
		}

		const newEdges: Edge[] = [];
		const nodeIds = new Set(out.map((n) => n.id));
		for (const b of w.bindings) {
			const sourceId = `nb-${b.notebook_instance_id}`;
			const targetId = `net-${b.net_id}`;
			if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) continue;
			newEdges.push({
				id: `binding-${b.notebook_instance_id}-${b.slot_name}`,
				source: sourceId,
				target: targetId,
				label: b.slot_name,
				labelStyle: 'font-size: 11px; fill: var(--text-muted, #9ca3af);',
				style: 'stroke: var(--accent, #3b82f6); stroke-width: 1.5px;',
			});
		}

		nodes = out;
		edges = newEdges;
	}

	function workerHeaderLabel(wk: WiringWorker): string {
		const mem =
			wk.memory_used_mb !== null ? ` · ${Math.round(wk.memory_used_mb)}/${wk.memory_mb} MB` : '';
		return `${wk.name}  (${wk.status})${mem}`;
	}

	function makeNetNode(n: WiringNet, parentId: string, x: number, y: number): Node {
		const color = statusBadgeColor(n.load_state);
		return {
			id: `net-${n.id}`,
			parentId,
			extent: 'parent',
			position: { x, y },
			type: 'default',
			data: { label: `🔷 ${n.instance_name}`, meta: n, kind: 'net' },
			style: `width: ${CHILD_WIDTH}px; height: ${CHILD_HEIGHT}px; background: var(--bg-primary, #111827); color: var(--text-primary, #f3f4f6); border: 2px solid ${color}; border-radius: 6px; font-size: 12px; text-align: left; padding: 6px 8px;`,
		};
	}

	function makeNotebookNode(nb: WiringNotebook, parentId: string, x: number, y: number): Node {
		const color = statusBadgeColor(nb.load_state);
		const slotCount = nb.slots.length;
		return {
			id: `nb-${nb.id}`,
			parentId,
			extent: 'parent',
			position: { x, y },
			type: 'default',
			data: {
				label: `📓 ${nb.instance_name}  (${slotCount} slot${slotCount === 1 ? '' : 's'})`,
				meta: nb,
				kind: 'notebook',
			},
			style: `width: ${CHILD_WIDTH}px; height: ${CHILD_HEIGHT}px; background: var(--bg-primary, #111827); color: var(--text-primary, #f3f4f6); border: 2px solid ${color}; border-radius: 6px; font-size: 12px; text-align: left; padding: 6px 8px;`,
		};
	}

	// ---- node click handler ----

	function handleNodeClick({ node }: { node: Node }) {
		panelError = null;
		const data = node.data as { kind?: string; meta?: any } | undefined;
		if (!data?.kind) {
			// group / header nodes — treat as worker click
			if (node.type === 'group') {
				selection = { kind: 'worker', id: node.id };
			}
			return;
		}
		if (data.kind === 'net') {
			selection = { kind: 'net', id: (data.meta as WiringNet).id };
		} else if (data.kind === 'notebook') {
			selection = { kind: 'notebook', id: (data.meta as WiringNotebook).id };
		} else if (data.kind === 'worker' || data.kind === 'unassigned') {
			selection = { kind: 'worker', id: node.id };
		}
	}

	function closePanel() {
		selection = null;
		panelError = null;
	}

	// ---- notebook actions ----

	async function withPanelAction<T>(fn: () => Promise<T>): Promise<T | null> {
		panelError = null;
		panelBusy = true;
		try {
			const r = await fn();
			await refresh();
			return r;
		} catch (e: any) {
			panelError = e?.message ?? String(e);
			return null;
		} finally {
			panelBusy = false;
		}
	}

	async function handleLoadNotebook(id: string) {
		await withPanelAction(() => loadNotebook(id));
	}
	async function handleUnloadNotebook(id: string) {
		await withPanelAction(() => unloadNotebook(id));
	}
	async function handleDeleteNotebook(id: string) {
		const r = await withPanelAction(() => deleteNotebook(id));
		if (r !== null) closePanel();
	}
	async function handleUnbind(notebookId: string, slotName: string) {
		await withPanelAction(() => unbindNotebookSlot(notebookId, slotName));
	}

	function openBindModal(notebookId: string, slotName: string) {
		bindModal = {
			open: true,
			notebookId,
			slotName,
			error: null,
			busy: false,
		};
	}
	function closeBindModal() {
		bindModal = { ...bindModal, open: false, error: null };
	}

	async function pickBindTarget(netId: string) {
		bindModal = { ...bindModal, busy: true, error: null };
		try {
			await bindNotebookSlot(bindModal.notebookId, bindModal.slotName, netId);
			closeBindModal();
			await refresh();
		} catch (e: any) {
			bindModal = { ...bindModal, busy: false, error: e?.message ?? String(e) };
		}
	}

	// Filter net candidates for the bind modal: same worker as the notebook.
	function bindCandidates(): WiringNet[] {
		if (!wiring) return [];
		const nb = findNotebook(bindModal.notebookId);
		if (!nb || !nb.worker_id) return [];
		return wiring.nets.filter((n) => n.worker_id === nb.worker_id);
	}

	// ---- add-notebook modal ----

	function openAddModal(prefillWorkerId: string = '') {
		// If the caller didn't pick a worker and the user has exactly one ready
		// worker, prefill it — they almost certainly want to assign to it, and
		// leaving the dropdown on "No worker" silently produces an unassigned
		// notebook that can't be bound.
		let workerId = prefillWorkerId;
		if (!workerId) {
			const ready = (wiring?.workers ?? []).filter((w) => w.status === 'ready');
			if (ready.length === 1) workerId = ready[0].id;
		}
		addModal = {
			open: true,
			deploymentId: '',
			definitionName: '',
			instanceName: '',
			workerId,
			error: null,
			busy: false,
		};
	}
	function closeAddModal() {
		addModal = { ...addModal, open: false, error: null };
	}

	// Per-deployment notebook definitions, derived from the deployments list
	// (which already includes ``discovered_notebooks``). No per-deployment
	// fetch — the previous N+1 GET on /api/deployments/{id} was visibly
	// blocking the modal when PG was slow (12-23s per call observed).
	let deploymentNotebookDefs = $state<Map<string, DiscoveredNotebook[]>>(new Map());

	function loadDefsForDeployment(deploymentId: string) {
		if (!deploymentId || deploymentNotebookDefs.has(deploymentId)) return;
		const dep = deployments.find((d) => d.id === deploymentId);
		deploymentNotebookDefs = new Map(deploymentNotebookDefs).set(
			deploymentId,
			dep?.discovered_notebooks ?? [],
		);
	}

	const canCreateNotebook = $derived(
		!!addModal.deploymentId &&
			!!addModal.definitionName &&
			!!addModal.instanceName.trim() &&
			!!addModal.workerId,
	);

	async function submitAdd() {
		addModal = { ...addModal, busy: true, error: null };
		try {
			if (!addModal.deploymentId || !addModal.definitionName || !addModal.instanceName.trim()) {
				throw new Error('Pick a deployment, definition, and instance name.');
			}
			await createNotebook({
				deployment_id: addModal.deploymentId,
				definition_name: addModal.definitionName,
				instance_name: addModal.instanceName.trim(),
				worker_id: addModal.workerId || undefined,
			});
			closeAddModal();
			await refresh();
		} catch (e: any) {
			addModal = { ...addModal, busy: false, error: e?.message ?? String(e) };
		}
	}
</script>

<svelte:head>
	<title>Wiring · Petri</title>
</svelte:head>

<AppNav title="Wiring" />

{#if connectionState !== 'connected'}
	<div
		class="px-6 py-2 text-xs flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
		title="Server-Sent Events stream is not currently connected — the page won't refresh automatically. Use the Refresh button to pull the latest state."
	>
		<span class="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
		{#if connectionState === 'connecting'}
			Connecting to live updates…
		{:else}
			Live updates disconnected — retrying in the background. Use Refresh to pull the latest state.
		{/if}
	</div>
{/if}

<!-- Top action bar -->
<div class="flex items-center justify-between px-6 py-3 border-b border-border bg-card">
	<div class="text-sm text-foreground-muted">
		{#if wiring}
			{wiring.workers.length} worker{wiring.workers.length === 1 ? '' : 's'} ·
			{wiring.nets.length} net{wiring.nets.length === 1 ? '' : 's'} ·
			{wiring.notebooks.length} notebook{wiring.notebooks.length === 1 ? '' : 's'}
		{/if}
	</div>
	<div class="flex items-center gap-2">
		<button
			class="px-3 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground"
			onclick={() => openAddModal()}
		>
			+ Add notebook instance
		</button>
		<button
			class="px-3 py-1.5 border border-border rounded bg-card text-foreground-muted text-sm cursor-pointer hover:text-foreground"
			onclick={refresh}
		>
			Refresh
		</button>
	</div>
</div>

{#if loadError}
	<div class="m-6 p-4 border border-red-500 rounded bg-red-50 text-red-700 text-sm">
		Failed to load wiring: {loadError}
	</div>
{:else if wiring === null}
	<div class="flex items-center justify-center h-[calc(100vh-112px)] text-foreground-muted">
		Loading wiring...
	</div>
{:else if wiring.workers.length === 0 && wiring.nets.length === 0 && wiring.notebooks.length === 0}
	<div class="flex flex-col items-center justify-center h-[calc(100vh-112px)] gap-2 text-foreground-muted">
		<p class="text-sm">No workers, nets, or notebooks yet.</p>
		<p class="text-xs">
			Create a worker on the <a class="text-accent underline" href="/workers">Workers</a> page, then push a deployment to see them here.
		</p>
	</div>
{:else}
	<!-- Canvas + side panel -->
	<div class="flex h-[calc(100vh-112px)]">
		<div class="flex-1 min-w-0">
			<SvelteFlow
				bind:nodes
				bind:edges
				onnodeclick={handleNodeClick}
				fitView
				minZoom={0.25}
				maxZoom={2}
				proOptions={{ hideAttribution: true }}
			>
				<Background />
				<Controls />
			</SvelteFlow>
		</div>

		{#if selection !== null}
			<aside class="w-[380px] border-l border-border bg-card flex flex-col">
				<div class="px-4 py-3 border-b border-border flex items-center justify-between">
					<h2 class="text-sm font-semibold text-foreground">
						{#if selection.kind === 'net'}
							Net instance
						{:else if selection.kind === 'notebook'}
							Notebook instance
						{:else}
							Worker
						{/if}
					</h2>
					<button
						class="text-foreground-muted hover:text-foreground text-lg leading-none"
						onclick={closePanel}
						aria-label="Close panel"
					>
						&times;
					</button>
				</div>
				<div class="flex-1 overflow-y-auto p-4 text-sm">
					{#if panelError}
						<div class="mb-3 p-2 border border-red-500 rounded bg-red-50 text-red-700 text-xs">
							{panelError}
						</div>
					{/if}

					{#if selection.kind === 'net'}
						{@const n = findNet(selection.id)}
						{#if n}
							<dl class="grid grid-cols-[110px_1fr] gap-y-2 gap-x-3 text-xs">
								<dt class="text-foreground-muted">Instance</dt>
								<dd class="text-foreground font-medium">{n.instance_name}</dd>
								<dt class="text-foreground-muted">Definition</dt>
								<dd class="text-foreground font-mono text-[11px]">{n.definition_name}</dd>
								<dt class="text-foreground-muted">Load state</dt>
								<dd>
									<span
										class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
										style="background: {statusBadgeColor(n.load_state)}"
									>
										{n.load_state}
									</span>
								</dd>
								{#if n.load_error}
									<dt class="text-foreground-muted">Error</dt>
									<dd class="text-red-500 text-[11px]">{n.load_error}</dd>
								{/if}
								<dt class="text-foreground-muted">Worker</dt>
								<dd class="text-foreground text-[11px]">
									{#if n.worker_id}
										{findWorker(n.worker_id)?.name ?? n.worker_id.slice(0, 8)}
									{:else}
										<span class="text-foreground-muted">unassigned</span>
									{/if}
								</dd>
							</dl>
							<div class="mt-4 flex gap-2">
								<a
									href="/nets#{n.id}"
									target="_blank"
									rel="noopener"
									class="px-3 py-1.5 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground"
								>
									Open net ↗
								</a>
							</div>
						{/if}
					{:else if selection.kind === 'notebook'}
						{@const nb = findNotebook(selection.id)}
						{#if nb}
							<dl class="grid grid-cols-[110px_1fr] gap-y-2 gap-x-3 text-xs">
								<dt class="text-foreground-muted">Instance</dt>
								<dd class="text-foreground font-medium">{nb.instance_name}</dd>
								<dt class="text-foreground-muted">Definition</dt>
								<dd class="text-foreground font-mono text-[11px]">{nb.definition_name}</dd>
								<dt class="text-foreground-muted">Load state</dt>
								<dd>
									<span
										class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
										style="background: {statusBadgeColor(nb.load_state)}"
									>
										{nb.load_state}
									</span>
								</dd>
								{#if nb.load_error}
									<dt class="text-foreground-muted">Error</dt>
									<dd class="text-red-500 text-[11px]">{nb.load_error}</dd>
								{/if}
								<dt class="text-foreground-muted">Worker</dt>
								<dd class="text-foreground text-[11px]">
									{#if nb.worker_id}
										{findWorker(nb.worker_id)?.name ?? nb.worker_id.slice(0, 8)}
									{:else}
										<span class="text-foreground-muted">unassigned</span>
									{/if}
								</dd>
							</dl>

							<div class="mt-4">
								<h3 class="text-xs font-semibold text-foreground mb-2">Slots ({nb.slots.length})</h3>
								{#if nb.slots.length === 0}
									<p class="text-xs text-foreground-muted">No slots discovered in this notebook source.</p>
								{:else}
									<ul class="space-y-2">
										{#each nb.slots as s}
											{@const binding = bindingsForNotebook(nb.id).find((b) => b.slot_name === s.slot_name)}
											{@const boundNet = binding ? findNet(binding.net_id) : null}
											<li class="border border-border rounded p-2">
												<div class="flex items-center justify-between">
													<div class="font-mono text-[11px] text-foreground">{s.slot_name}</div>
													{#if binding && boundNet}
														<button
															class="text-[11px] text-red-500 hover:underline"
															onclick={() => handleUnbind(nb.id, s.slot_name)}
															disabled={panelBusy}
														>
															Unbind
														</button>
													{:else}
														<button
															class="text-[11px] text-accent hover:underline"
															onclick={() => openBindModal(nb.id, s.slot_name)}
															disabled={panelBusy}
														>
															Bind…
														</button>
													{/if}
												</div>
												{#if binding && boundNet}
													<div class="text-[11px] text-foreground-muted mt-1">
														→ {boundNet.instance_name}
														<span class="opacity-70">({boundNet.definition_name})</span>
													</div>
												{:else if binding}
													<div class="text-[11px] text-red-500 mt-1">
														Bound to net {binding.net_id.slice(0, 8)} (not in your nets?)
													</div>
												{/if}
												{#if s.places.length || s.transitions.length}
													<div class="text-[10px] text-foreground-muted mt-1">
														{#if s.places.length}places: {s.places.join(', ')}{/if}
														{#if s.places.length && s.transitions.length} · {/if}
														{#if s.transitions.length}transitions: {s.transitions.join(', ')}{/if}
													</div>
												{/if}
											</li>
										{/each}
									</ul>
								{/if}
							</div>

							<div class="mt-4 flex flex-wrap gap-2">
								<a
									href="/notebooks/{nb.id}"
									target="_blank"
									rel="noopener"
									class="px-3 py-1.5 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground"
								>
									Open notebook ↗
								</a>
								{#if nb.load_state === 'loaded'}
									<button
										class="px-3 py-1.5 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
										onclick={() => handleUnloadNotebook(nb.id)}
										disabled={panelBusy}
									>
										Unload
									</button>
								{:else}
									<button
										class="px-3 py-1.5 border border-green-600 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700 disabled:opacity-50"
										onclick={() => handleLoadNotebook(nb.id)}
										disabled={panelBusy || !nb.worker_id}
									>
										Load
									</button>
								{/if}
								<button
									class="px-3 py-1.5 border border-red-500 rounded bg-card text-red-500 text-xs font-medium hover:bg-red-500 hover:text-white disabled:opacity-50"
									onclick={() => handleDeleteNotebook(nb.id)}
									disabled={panelBusy}
								>
									Delete
								</button>
							</div>
						{/if}
					{:else if selection.kind === 'worker'}
						{@const wk = findWorker(selection.id)}
						{#if wk}
							<dl class="grid grid-cols-[110px_1fr] gap-y-2 gap-x-3 text-xs">
								<dt class="text-foreground-muted">Name</dt>
								<dd class="text-foreground font-medium">{wk.name}</dd>
								<dt class="text-foreground-muted">Status</dt>
								<dd>
									<span
										class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
										style="background: {statusBadgeColor(wk.status)}"
									>
										{wk.status}{wk.status_detail ? ` · ${wk.status_detail}` : ''}
									</span>
								</dd>
								<dt class="text-foreground-muted">Memory</dt>
								<dd class="text-foreground text-[11px]">
									{wk.memory_used_mb ?? '?'} / {wk.memory_mb} MB
									{#if wk.memory_peak_mb}<span class="opacity-70"> (peak {Math.round(wk.memory_peak_mb)})</span>{/if}
								</dd>
								<dt class="text-foreground-muted">CPUs</dt>
								<dd class="text-foreground text-[11px]">{wk.cpus}</dd>
								<dt class="text-foreground-muted">Type</dt>
								<dd class="text-foreground text-[11px]">{wk.worker_category} / {wk.worker_type}</dd>
							</dl>
							<div class="mt-4 flex flex-wrap gap-2">
								<a
									href="/workers"
									target="_blank"
									rel="noopener"
									class="px-3 py-1.5 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground"
								>
									Open workers ↗
								</a>
								<button
									class="px-3 py-1.5 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground"
									onclick={() => openAddModal(wk.id)}
								>
									+ Notebook here
								</button>
							</div>
						{:else}
							<p class="text-xs text-foreground-muted">
								This is the unassigned column — items without a worker assignment.
							</p>
						{/if}
					{/if}
				</div>
			</aside>
		{/if}
	</div>
{/if}

<!-- Bind modal -->
{#if bindModal.open}
	{@const nb = findNotebook(bindModal.notebookId)}
	{@const candidates = bindCandidates()}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		use:portal
		class="modal-scrim fixed inset-0 flex items-center justify-center z-[9999]"
		onclick={closeBindModal}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="modal-card border border-border rounded-lg shadow-lg p-5 min-w-[480px] max-w-[600px] max-h-[80vh] overflow-y-auto"
			onclick={(e) => e.stopPropagation()}
		>
			<h3 class="text-base font-semibold text-foreground mb-1">
				Bind slot <span class="font-mono text-sm">{bindModal.slotName}</span>
			</h3>
			<p class="text-xs text-foreground-muted mb-4">
				on notebook <span class="font-medium">{nb?.instance_name}</span> ·
				Showing nets on worker <span class="font-medium">{findWorker(nb?.worker_id ?? '')?.name ?? '?'}</span>
				(v1 same-worker constraint).
			</p>

			{#if bindModal.error}
				<div class="mb-3 p-2 border border-red-500 rounded bg-red-50 text-red-700 text-xs">
					{bindModal.error}
				</div>
			{/if}

			{#if candidates.length === 0}
				<p class="text-sm text-foreground-muted">
					No net instances on this worker. Create one on the
					<a class="text-accent underline" href="/workers">Workers</a> page first.
				</p>
			{:else}
				<ul class="space-y-1">
					{#each candidates as n}
						<li>
							<button
								class="w-full text-left px-3 py-2 border border-border rounded hover:border-accent hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
								onclick={() => pickBindTarget(n.id)}
								disabled={bindModal.busy}
							>
								<div class="text-sm text-foreground font-medium">{n.instance_name}</div>
								<div class="text-[11px] text-foreground-muted font-mono">{n.definition_name}</div>
								<div class="text-[11px] text-foreground-muted">load_state: {n.load_state}</div>
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			<div class="mt-4 flex justify-end gap-2">
				<button
					class="px-3 py-1.5 border border-border rounded text-foreground-muted text-sm hover:text-foreground"
					onclick={closeBindModal}
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Add-notebook modal -->
{#if addModal.open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		use:portal
		class="modal-scrim fixed inset-0 flex items-center justify-center z-[9999]"
		onclick={closeAddModal}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="modal-card border border-border rounded-lg shadow-lg p-5 min-w-[480px] max-w-[600px]"
			onclick={(e) => e.stopPropagation()}
		>
			<h3 class="text-base font-semibold text-foreground mb-4">Add notebook instance</h3>

			{#if addModal.error}
				<div class="mb-3 p-2 border border-red-500 rounded bg-red-50 text-red-700 text-xs">
					{addModal.error}
				</div>
			{/if}

			<div class="space-y-3">
				<label class="block text-xs text-foreground-muted">
					Deployment
					<select
						class="mt-1 w-full px-2 py-1.5 border border-border rounded bg-surface text-foreground text-sm"
						value={addModal.deploymentId}
						onchange={(e) => {
							addModal = {
								...addModal,
								deploymentId: e.currentTarget.value,
								definitionName: '',
							};
							loadDefsForDeployment(e.currentTarget.value);
						}}
					>
						<option value="">Pick a deployment…</option>
						{#each deployments.filter((d) => d.build_status === 'success') as dep}
							<option value={dep.id}
								>{dep.git_commit ? dep.git_commit.slice(0, 7) : dep.id.slice(0, 8)} ·
								{dep.git_ref}</option
							>
						{/each}
					</select>
				</label>

				<label class="block text-xs text-foreground-muted">
					Notebook definition
					<select
						class="mt-1 w-full px-2 py-1.5 border border-border rounded bg-surface text-foreground text-sm disabled:opacity-50"
						value={addModal.definitionName}
						onchange={(e) =>
							(addModal = { ...addModal, definitionName: e.currentTarget.value })}
						disabled={!addModal.deploymentId}
					>
						<option value="">Pick a notebook…</option>
						{#each deploymentNotebookDefs.get(addModal.deploymentId) ?? [] as def}
							<option value={def.name}>{def.name}</option>
						{/each}
					</select>
					{#if addModal.deploymentId && (deploymentNotebookDefs.get(addModal.deploymentId)?.length ?? 0) === 0}
						<span class="text-[11px] text-foreground-muted">
							No notebooks discovered in this deployment. Add a Marimo notebook
							(e.g. <code>notebooks/visualise_*.py</code>) with a
							<code>petri.net(&quot;slot&quot;)</code> call, push, and rebuild.
						</span>
					{/if}
				</label>

				<label class="block text-xs text-foreground-muted">
					Instance name
					<input
						type="text"
						class="mt-1 w-full px-2 py-1.5 border border-border rounded bg-surface text-foreground text-sm"
						placeholder="e.g. tw-overview"
						value={addModal.instanceName}
						oninput={(e) => (addModal = { ...addModal, instanceName: e.currentTarget.value })}
					/>
				</label>

				<label class="block text-xs text-foreground-muted">
					Worker <span class="text-red-500">*</span>
					<select
						class="mt-1 w-full px-2 py-1.5 border border-border rounded bg-surface text-foreground text-sm"
						value={addModal.workerId}
						onchange={(e) => (addModal = { ...addModal, workerId: e.currentTarget.value })}
					>
						<option value="">— pick a worker —</option>
						{#each wiring?.workers ?? [] as wk}
							{@const free = wk.memory_mb - (wk.memory_used_mb ?? 0)}
							<option value={wk.id}>
								{wk.name} ({wk.status}) · {Math.round(free)} MB free
							</option>
						{/each}
					</select>
					<p class="mt-1 text-[11px] text-foreground-muted">
						The notebook subprocess reserves ~80 MB for the Marimo kernel; user
						code adds on top. Watch the worker's memory bar after load to see
						actual usage. v1 doesn't pre-estimate user-code RAM — it can pull
						arbitrary data at runtime.
					</p>
					{#if addModal.workerId}
						{@const _w = wiring?.workers.find(w => w.id === addModal.workerId)}
						{#if _w}
							{@const _free = _w.memory_mb - (_w.memory_used_mb ?? 0)}
							{#if _free < 150}
								<p class="mt-1 text-[11px] text-amber-500">
									⚠ Only {Math.round(_free)} MB free on this worker — Marimo
									alone needs ~80 MB. Pick a bigger worker if your notebook
									imports anything heavy.
								</p>
							{/if}
						{/if}
					{/if}
				</label>
			</div>

			<div class="mt-4 flex justify-end gap-2">
				<button
					class="px-3 py-1.5 border border-border rounded text-foreground-muted text-sm hover:text-foreground"
					onclick={closeAddModal}
					disabled={addModal.busy}
				>
					Cancel
				</button>
				<button
					class="px-3 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={submitAdd}
					disabled={addModal.busy || !canCreateNotebook}
					title={canCreateNotebook ? '' : 'Fill in deployment, notebook, instance name, and worker first.'}
				>
					{addModal.busy ? 'Creating…' : 'Create'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(.svelte-flow__node.selected) {
		box-shadow: 0 0 0 2px var(--accent, #3b82f6);
	}

	/* .modal-scrim and .modal-card now live in $lib/theme.css so any page
	   can portal a modal and get the right look. */
</style>

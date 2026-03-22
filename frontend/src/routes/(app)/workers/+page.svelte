<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import {
		listWorkers, createWorker, deleteWorker, provisionWorker, destroyWorkerResource,
		startWorker, stopWorker, healthCheckWorker, getWorker,
		listNets, createNet, patchNet, loadNet, unloadNet,
		type Worker, type WorkerDetail, type Net,
	} from '$lib/api';
	import AppNav from '$lib/components/AppNav.svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import { serverEventsStore } from '$lib/stores/serverEvents';
	import { netDisplayName, netInstanceLabel, netFullLabel } from '$lib/netHelpers';

	let workers = $state<Worker[]>([]);
	let nets = $state<Net[]>([]);
	let expandedWorkerIds = $state<Record<string, boolean>>({});
	let workerDetails = $state<Map<string, WorkerDetail>>(new Map());

	// Create form state
	let newWorkerName = $state('');
	let newWorkerCategory = $state<'ephemeral' | 'persistent'>('ephemeral');
	let newWorkerMemory = $state(512);
	let newWorkerCpus = $state(1);

	// Loading/error state
	let actionInProgress = $state<string | null>(null);
	let errorMessage = $state('');

	// Per-worker log lines (includes net load logs, provisioning progress, etc.)
	let workerLogs = $state<Map<string, string[]>>(new Map());
	let workerLogsExpanded = $state<Record<string, boolean>>({});


	// Provisioning progress
	const PROVISION_STEPS = ['provisioning', 'ready'] as const;
	let provisionProgress = $state<Map<string, { step: number; total: number; label: string }>>(new Map());

	function appendWorkerLog(workerId: string, message: string) {
		const lines = workerLogs.get(workerId) || [];
		workerLogs.set(workerId, [...lines, message]);
		workerLogs = workerLogs;
	}

	// Delete confirmation state (per-worker so timers don't interfere)
	let deleteTimers = $state<Map<string, { countdown: number; timerId: ReturnType<typeof setInterval> }>>(new Map());

	function startDeleteCountdown(workerId: string) {
		cancelDeleteCountdown(workerId);
		const entry = { countdown: 10, timerId: 0 as unknown as ReturnType<typeof setInterval> };
		entry.timerId = setInterval(() => {
			entry.countdown -= 1;
			deleteTimers = new Map(deleteTimers); // trigger reactivity
			if (entry.countdown <= 0) {
				cancelDeleteCountdown(workerId);
				handleDelete(workerId);
			}
		}, 1000);
		deleteTimers.set(workerId, entry);
		deleteTimers = new Map(deleteTimers);
	}

	function cancelDeleteCountdown(workerId: string) {
		const entry = deleteTimers.get(workerId);
		if (entry) {
			clearInterval(entry.timerId);
			deleteTimers.delete(workerId);
			deleteTimers = new Map(deleteTimers);
		}
	}

	function cancelAllDeleteCountdowns() {
		for (const entry of deleteTimers.values()) {
			clearInterval(entry.timerId);
		}
		deleteTimers.clear();
		deleteTimers = new Map(deleteTimers);
	}

	function clearError() { errorMessage = ''; }

	async function withAction(id: string, fn: () => Promise<void>) {
		clearError();
		actionInProgress = id;
		try {
			await fn();
		} catch (e: any) {
			errorMessage = e.message || 'Something went wrong';
			// Refresh state so UI reflects reality after a failure
			await refreshAll();
		} finally {
			actionInProgress = null;
		}
	}

	async function refreshWorkers() {
		workers = await listWorkers();
	}

	async function refreshNets() {
		nets = await listNets();
	}

	async function refreshAll() {
		await Promise.all([refreshWorkers(), refreshNets()]);
	}

	// -- Polling --

	const POLL_INTERVAL = 30_000;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let pollInFlight = false;

	async function poll() {
		if (pollInFlight) return; // skip if previous poll hasn't returned
		pollInFlight = true;
		try {
			await refreshAll();
		} catch {
			// silently ignore polling errors
		} finally {
			pollInFlight = false;
		}
	}

	function startPolling() {
		stopPolling();
		pollTimer = setInterval(poll, POLL_INTERVAL);
	}

	function stopPolling() {
		if (pollTimer !== null) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function handleVisibilityChange() {
		if (document.hidden) {
			stopPolling();
		} else {
			poll(); // immediate refresh when tab becomes visible
			startPolling();
		}
	}

	// -- SSE listener (debounced to avoid bursts hitting rate limits) --

	let sseDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	const unsubscribeSSE = serverEventsStore.subscribe((event) => {
		if (!event) return;

		if (event.type === 'net_load_log') {
			const net = nets.find(n => n.id === event.net_id);
			if (net?.worker_id) {
				appendWorkerLog(net.worker_id, `[${net.name}] ${event.message}`);
			}
			return;
		}

		if (event.type === 'net_state_changed') {
			const net = nets.find(n => n.id === event.net_id);
			if (net?.worker_id) {
				appendWorkerLog(net.worker_id, `[${net.name}] State → ${event.load_state}`);
			}
		}

		if (event.type === 'worker_provision_log') {
			const wid = event.worker_id;
			appendWorkerLog(wid, `[provision] ${event.message}`);
			// Auto-expand log viewer during provisioning
			if (!workerLogsExpanded[wid]) {
				workerLogsExpanded = { ...workerLogsExpanded, [wid]: true };
			}
			return;
		}

		if (event.type === 'worker_state_changed') {
			const wid = event.worker_id;
			appendWorkerLog(wid, `[worker] Status → ${event.status}${event.status_detail ? ` (${event.status_detail})` : ''}`);

			// Update provisioning progress
			if (event.status === 'provisioning') {
				provisionProgress.set(wid, { step: 1, total: 3, label: 'Creating machine...' });
				provisionProgress = provisionProgress;
			} else if (event.status === 'ready') {
				provisionProgress.set(wid, { step: 3, total: 3, label: 'Ready' });
				provisionProgress = provisionProgress;
				setTimeout(() => {
					provisionProgress.delete(wid);
					provisionProgress = provisionProgress;
				}, 3000);
			} else if (event.status === 'error') {
				provisionProgress.delete(wid);
				provisionProgress = provisionProgress;
			}
		}

		if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
		sseDebounceTimer = setTimeout(() => {
			sseDebounceTimer = null;
			refreshAll();
		}, 500);
	});

	// -- Pre-action state checks --

	async function checkWorkerState(workerId: string, expectedStatus: string): Promise<boolean> {
		await refreshWorkers();
		const worker = workers.find(w => w.id === workerId);
		if (!worker || worker.status !== expectedStatus) {
			errorMessage = `Worker state has changed — it is now "${worker?.status ?? 'unknown'}". Please review before retrying.`;
			return false;
		}
		return true;
	}

	async function checkNetForLoad(netId: string): Promise<boolean> {
		await refreshAll();
		const net = nets.find(n => n.id === netId);
		if (!net) { errorMessage = 'Net no longer exists.'; return false; }
		if (net.load_state === 'loaded') { errorMessage = 'Net is already loaded.'; return false; }
		if (net.load_state === 'loading') { errorMessage = 'Net is currently loading.'; return false; }
		const worker = net.worker_id ? workers.find(w => w.id === net.worker_id) : null;
		if (!worker || worker.status !== 'ready') {
			errorMessage = `Worker is not ready (status: "${worker?.status ?? 'unknown'}"). Cannot load net.`;
			return false;
		}
		return true;
	}

	async function checkNetForUnload(netId: string): Promise<boolean> {
		await refreshAll();
		const net = nets.find(n => n.id === netId);
		if (!net) { errorMessage = 'Net no longer exists.'; return false; }
		if (net.load_state !== 'loaded') { errorMessage = 'Net is not currently loaded.'; return false; }
		const worker = net.worker_id ? workers.find(w => w.id === net.worker_id) : null;
		if (!worker || worker.status !== 'ready') {
			errorMessage = `Worker is not ready (status: "${worker?.status ?? 'unknown'}"). Cannot unload net.`;
			return false;
		}
		return true;
	}

	// -- Action handlers --

	function maxMemoryForCpus(cpus: number): number {
		return cpus * 2048;
	}

	async function handleCreate() {
		if (!newWorkerName.trim()) return;
		await withAction('create', async () => {
			await createWorker({
				name: newWorkerName.trim(),
				worker_category: newWorkerCategory,
				memory_mb: newWorkerMemory,
				cpus: newWorkerCpus,
			});
			newWorkerName = '';
			await refreshWorkers();
		});
	}

	async function handleProvision(workerId: string) {
		provisionProgress.set(workerId, { step: 1, total: 3, label: 'Creating machine...' });
		provisionProgress = provisionProgress;
		appendWorkerLog(workerId, '[provision] Provisioning started...');
		// Auto-expand log viewer so the user sees progress
		workerLogsExpanded = { ...workerLogsExpanded, [workerId]: true };
		await withAction(workerId, async () => {
			await provisionWorker(workerId);
			await refreshWorkers();
		});
		// Clear progress indicator — the SSE event may not arrive (e.g. if provisioning completed synchronously)
		provisionProgress.delete(workerId);
		provisionProgress = provisionProgress;
	}

	async function handleStart(workerId: string) {
		await refreshWorkers();
		const worker = workers.find(w => w.id === workerId);
		const canStart = worker?.status === 'stopped' ||
			(worker?.status === 'error' && worker?.status_detail === 'machine_stopped');
		if (!canStart) {
			errorMessage = `Worker state has changed — it is now "${worker?.status ?? 'unknown'}". Please review before retrying.`;
			return;
		}
		await withAction(workerId, async () => {
			await startWorker(workerId);
			await refreshWorkers();
		});
	}

	async function handleHealthCheck(workerId: string) {
		await withAction(workerId, async () => {
			await healthCheckWorker(workerId);
			await refreshWorkers();
		});
	}

	async function handleStop(workerId: string) {
		if (!await checkWorkerState(workerId, 'ready')) return;
		await withAction(workerId, async () => {
			await stopWorker(workerId);
			await refreshWorkers();
		});
	}

	async function handleDestroyResource(workerId: string) {
		await refreshWorkers();
		const worker = workers.find(w => w.id === workerId);
		if (!worker || (worker.status !== 'ready' && worker.status !== 'stopped')) {
			errorMessage = `Worker state has changed — it is now "${worker?.status ?? 'unknown'}". Please review before retrying.`;
			return;
		}
		await withAction(workerId, async () => {
			await destroyWorkerResource(workerId);
			await refreshWorkers();
		});
	}

	async function handleDelete(workerId: string) {
		await withAction(workerId, async () => {
			await deleteWorker(workerId);
			const { [workerId]: _, ...rest } = expandedWorkerIds;
			expandedWorkerIds = rest;
			await refreshWorkers();
			await refreshNets();
		});
	}

	async function toggleExpand(workerId: string) {
		if (expandedWorkerIds[workerId]) {
			const { [workerId]: _, ...rest } = expandedWorkerIds;
			expandedWorkerIds = rest;
			return;
		}
		expandedWorkerIds = { ...expandedWorkerIds, [workerId]: true };
		try {
			const detail = await getWorker(workerId);
			workerDetails.set(workerId, detail);
			workerDetails = workerDetails;
		} catch (e: any) {
			errorMessage = e.message;
		}
	}

	async function handleAssignNet(workerId: string, netId: string) {
		if (!netId) return;
		await refreshNets();
		const net = nets.find(n => n.id === netId);
		if (!net) {
			errorMessage = 'Net not found.';
			return;
		}
		await withAction(workerId, async () => {
			await createNet({
				name: net.name,
				entry_module: net.entry_module,
				entry_function: net.entry_function,
				deployment_id: net.deployment_id ?? undefined,
				worker_id: workerId,
			});
			await refreshNets();
			const detail = await getWorker(workerId);
			workerDetails.set(workerId, detail);
			workerDetails = workerDetails;
		});
	}

	async function handleUnassignNet(netId: string) {
		await refreshNets();
		const net = nets.find(n => n.id === netId);
		if (!net || !net.worker_id) {
			errorMessage = 'Net is no longer assigned to a worker.';
			return;
		}
		await withAction(netId, async () => {
			await patchNet(netId, { worker_id: null });
			await refreshNets();
			for (const wid of Object.keys(expandedWorkerIds)) {
				const detail = await getWorker(wid);
				workerDetails.set(wid, detail);
			}
			workerDetails = workerDetails;
		});
	}

	async function handleLoadNet(netId: string) {
		if (!await checkNetForLoad(netId)) return;
		await withAction(netId, async () => {
			await loadNet(netId);
			await refreshNets();
		});
	}

	async function handleUnloadNet(netId: string) {
		if (!await checkNetForUnload(netId)) return;
		await withAction(netId, async () => {
			await unloadNet(netId);
			await refreshNets();
		});
	}

	function loadStateBadge(state: string): { label: string; color: string } {
		switch (state) {
			case 'loaded': return { label: 'Loaded', color: 'var(--status-ready)' };
			case 'loading': return { label: 'Loading...', color: 'var(--status-provisioning)' };
			case 'error': return { label: 'Error', color: 'var(--status-error)' };
			default: return { label: 'Unloaded', color: 'var(--status-stopped)' };
		}
	}

	function statusColor(status: string, statusDetail?: string | null): string {
		if (status === 'error' && statusDetail === 'machine_stopped') return 'var(--status-stopped)';
		switch (status) {
			case 'ready': return 'var(--status-ready)';
			case 'stopped': return 'var(--status-stopped)';
			case 'error': return 'var(--status-error)';
			case 'provisioning': return 'var(--status-provisioning)';
			default: return 'var(--status-pending)';
		}
	}

	function errorDisplayText(statusDetail: string | null): string {
		switch (statusDetail) {
			case 'machine_stopped': return 'stopped externally';
			case 'machine_destroyed': return 'destroyed';
			case 'unreachable': return 'unreachable';
			case 'provision_failed': return 'provision failed';
			default: return 'error';
		}
	}

	function errorExplanation(statusDetail: string | null): string | null {
		switch (statusDetail) {
			case 'machine_stopped': return 'The machine was stopped outside of Petri';
			case 'machine_destroyed': return 'The machine no longer exists and must be re-created';
			case 'unreachable': return 'The worker is not responding to health checks';
			case 'provision_failed': return 'Provisioning failed — try again';
			default: return null;
		}
	}

	function workerCategoryLabel(category: string): string {
		return category === 'persistent' ? 'Persistent' : 'Ephemeral';
	}

	function unassignedNets(workerId: string): Net[] {
		return nets.filter(n => !n.worker_id || n.worker_id === workerId);
	}

	function netsForWorker(workerId: string): Net[] {
		return nets.filter(n => n.worker_id === workerId);
	}

	// Inline rename state
	let editingNetId = $state<string | null>(null);
	let editingNetName = $state('');

	function startEditNetName(net: Net) {
		editingNetId = net.id;
		editingNetName = netDisplayName(net);
	}

	function cancelEditNetName() {
		editingNetId = null;
		editingNetName = '';
	}

	async function saveNetName(netId: string) {
		const trimmed = editingNetName.trim();
		if (!trimmed) { cancelEditNetName(); return; }
		const net = nets.find(n => n.id === netId);
		if (!net) { cancelEditNetName(); return; }
		// If display name matches the template name, clear it (set to null)
		const newDisplayName = trimmed === net.name ? null : trimmed;
		try {
			await patchNet(netId, { display_name: newDisplayName });
			await refreshNets();
		} catch (e: any) {
			errorMessage = e.message || 'Failed to rename net';
		}
		cancelEditNetName();
	}

	function seedLogsFromNetErrors() {
		for (const net of nets) {
			if (net.load_state === 'error' && net.load_error && net.worker_id) {
				const lines = workerLogs.get(net.worker_id) || [];
				const errorLine = `[${net.name}] Load error: ${net.load_error}`;
				if (!lines.includes(errorLine)) {
					lines.push(errorLine);
					workerLogs.set(net.worker_id, lines);
				}
			}
		}
		workerLogs = workerLogs;
	}

	onMount(async () => {
		await refreshAll();
		seedLogsFromNetErrors();
		startPolling();
		document.addEventListener('visibilitychange', handleVisibilityChange);
	});

	onDestroy(() => {
		stopPolling();
		unsubscribeSSE();
		cancelAllDeleteCountdowns();
		if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		}
	});
</script>

<AppNav title="Workers" />

<div class="max-w-[900px] mx-auto p-8">

	{#if errorMessage}
		<div class="flex items-center justify-between px-4 py-3 bg-error-bg text-error rounded-md mb-4">
			<span>{errorMessage}</span>
			<button class="text-error font-bold cursor-pointer px-1" onclick={clearError}>x</button>
		</div>
	{/if}

	<!-- Create Worker Form -->
	<div class="flex items-center gap-4 p-4 bg-card border border-border rounded-md mb-6 flex-wrap">
		<input
			type="text"
			bind:value={newWorkerName}
			placeholder="Worker name"
			onkeydown={(e) => e.key === 'Enter' && handleCreate()}
			class="flex-1 min-w-[150px] px-3 py-2 border border-border rounded bg-surface text-foreground text-sm"
		/>
		<div class="flex gap-3">
			<label class="flex items-center gap-1 text-sm text-foreground cursor-pointer">
				<input type="radio" name="worker-category" bind:group={newWorkerCategory} value="ephemeral" />
				Ephemeral
			</label>
			<label class="flex items-center gap-1 text-sm text-foreground cursor-pointer">
				<input type="radio" name="worker-category" bind:group={newWorkerCategory} value="persistent" />
				Persistent
			</label>
		</div>
		<div class="flex gap-3 items-center">
			<label class="flex items-center gap-1 text-sm text-foreground">
				<span class="text-foreground-muted">RAM</span>
				<select
					bind:value={newWorkerMemory}
					class="px-2 py-1.5 border border-border rounded bg-surface text-foreground text-sm"
				>
					{#each [256, 512, 1024, 2048] as mb}
						{#if mb <= maxMemoryForCpus(newWorkerCpus)}
							<option value={mb}>{mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}</option>
						{/if}
					{/each}
				</select>
			</label>
			<label class="flex items-center gap-1 text-sm text-foreground">
				<span class="text-foreground-muted">CPUs</span>
				<select
					bind:value={newWorkerCpus}
					onchange={() => { if (newWorkerMemory > maxMemoryForCpus(newWorkerCpus)) newWorkerMemory = maxMemoryForCpus(newWorkerCpus); }}
					class="px-2 py-1.5 border border-border rounded bg-surface text-foreground text-sm"
				>
					<option value={1}>1</option>
					<option value={2}>2</option>
					<option value={4}>4</option>
				</select>
			</label>
		</div>
		<span class="inline-block" title={!newWorkerName.trim() ? 'Enter a worker name first' : ''}>
			<button
				class="px-5 py-2 border border-accent rounded bg-accent text-accent-foreground font-medium cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
				onclick={handleCreate}
				disabled={!newWorkerName.trim() || actionInProgress === 'create'}
			>
				{actionInProgress === 'create' ? 'Creating...' : 'Create Worker'}
			</button>
		</span>
	</div>

	<!-- Worker List -->
	{#if workers.length === 0}
		<div class="text-center text-foreground-muted p-8">
			<p>No workers yet. Create one above.</p>
			<p class="text-sm mt-2">Tip: You can also create workers from successful deployments on the <a href="/deployments" class="text-accent hover:underline">Deployments</a> page.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each workers as worker (worker.id)}
				<div class="border border-border rounded-md bg-card overflow-hidden">
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="flex items-center justify-between px-4 py-3 cursor-pointer transition-colors gap-3 hover:bg-hover"
						onclick={() => toggleExpand(worker.id)}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === 'Enter' && toggleExpand(worker.id)}
					>
						<div class="flex items-center gap-3">
							<span class="font-semibold text-foreground">{worker.name}</span>
							<span class="text-xs text-foreground-muted px-2 py-0.5 bg-muted rounded-sm">{workerCategoryLabel(worker.worker_category)}</span>
							<span class="text-xs text-foreground-muted px-2 py-0.5 bg-muted rounded-sm">{worker.memory_mb >= 1024 ? `${worker.memory_mb / 1024} GB` : `${worker.memory_mb} MB`} / {worker.cpus} CPU{worker.cpus > 1 ? 's' : ''}</span>
							<span class="text-xs px-2.5 py-0.5 rounded-full text-white font-medium capitalize" style="background: {statusColor(worker.status, worker.status_detail)}">
								{worker.status === 'error' ? errorDisplayText(worker.status_detail) : worker.status}
							</span>
							{#if worker.status === 'error' && errorExplanation(worker.status_detail)}
								<span class="text-xs text-foreground-muted">{errorExplanation(worker.status_detail)}</span>
							{/if}
						</div>
						<div class="flex items-center gap-2 flex-wrap">
							{#if worker.status === 'pending'}
								<button
									class="px-3.5 py-1.5 border border-green-600 rounded bg-green-600 text-white text-sm font-medium cursor-pointer transition-all hover:bg-green-700 hover:border-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={(e) => { e.stopPropagation(); handleProvision(worker.id); }}
									disabled={actionInProgress === worker.id}
								>
									Provision
								</button>
							{/if}
							{#if worker.status === 'error'}
								{#if worker.status_detail === 'machine_stopped'}
									<button
										class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
										onclick={(e) => { e.stopPropagation(); handleStart(worker.id); }}
										disabled={actionInProgress === worker.id}
									>
										Start
									</button>
								{:else if worker.status_detail === 'unreachable'}
									<button
										class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
										onclick={(e) => { e.stopPropagation(); handleHealthCheck(worker.id); }}
										disabled={actionInProgress === worker.id}
									>
										Check Health
									</button>
								{:else}
									<button
										class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
										onclick={(e) => { e.stopPropagation(); handleProvision(worker.id); }}
										disabled={actionInProgress === worker.id}
									>
										{worker.status_detail === 'machine_destroyed' || worker.status_detail === 'provision_failed' ? 'Re-provision' : 'Retry'}
									</button>
								{/if}
							{/if}
							{#if worker.status === 'ready' && worker.worker_category === 'persistent'}
								<button
									class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={(e) => { e.stopPropagation(); handleStop(worker.id); }}
									disabled={actionInProgress === worker.id}
								>
									Stop
								</button>
							{/if}
							{#if worker.status === 'stopped'}
								<button
									class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={(e) => { e.stopPropagation(); handleStart(worker.id); }}
									disabled={actionInProgress === worker.id}
								>
									Start
								</button>
							{/if}
							{#if worker.status === 'ready' || worker.status === 'stopped'}
								<button
									class="px-3.5 py-1.5 border border-destructive rounded bg-transparent text-destructive text-sm font-medium cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={(e) => { e.stopPropagation(); handleDestroyResource(worker.id); }}
									disabled={actionInProgress === worker.id}
								>
									Destroy Resource
								</button>
							{/if}
							{#if deleteTimers.has(worker.id)}
								<span class="inline-flex items-center gap-1.5 text-sm text-destructive font-medium">
									Deleting in {deleteTimers.get(worker.id)!.countdown}s...
									<button
										class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground"
										onclick={(e) => { e.stopPropagation(); cancelDeleteCountdown(worker.id); }}
									>
										Cancel
									</button>
								</span>
							{:else}
								<button
									class="px-3.5 py-1.5 border border-destructive rounded bg-transparent text-destructive text-sm font-medium cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={(e) => { e.stopPropagation(); startDeleteCountdown(worker.id); }}
									disabled={actionInProgress === worker.id}
								>
									Delete
								</button>
							{/if}
							<span class="text-[0.7em] text-foreground-muted ml-1">{expandedWorkerIds[worker.id] ? '▼' : '▶'}</span>
						</div>
					</div>

					{#if expandedWorkerIds[worker.id]}
						<div class="px-4 py-3 border-t border-border bg-muted">
							<div>
								<h4 class="mb-2 text-sm font-semibold text-foreground">Assigned Nets</h4>
								{#if netsForWorker(worker.id).length === 0}
									<p class="text-foreground-faint text-sm mb-2">No nets assigned</p>
								{:else}
									<ul class="list-none m-0 p-0 mb-3">
										{#each netsForWorker(worker.id) as net (net.id)}
											{@const badge = loadStateBadge(net.load_state)}
											<li class="py-1.5 border-b border-border-light last:border-b-0">
												<div class="flex items-center gap-3 flex-wrap">
												{#if editingNetId === net.id}
													<input
														type="text"
														bind:value={editingNetName}
														onkeydown={(e) => {
															if (e.key === 'Enter') saveNetName(net.id);
															if (e.key === 'Escape') cancelEditNetName();
														}}
														onblur={() => saveNetName(net.id)}
														class="font-medium text-foreground text-sm px-1 py-0 border border-accent rounded bg-surface w-40"
														autofocus
													/>
												{:else}
													<button
														class="font-medium text-foreground text-sm bg-transparent border-0 border-b border-dashed border-foreground-faint cursor-pointer px-0 py-0 hover:border-accent"
														onclick={(e) => { e.stopPropagation(); startEditNetName(net); }}
														title="Click to rename"
													>
														{netDisplayName(net)} {netInstanceLabel(net, nets)}
													</button>
												{/if}
												<span class="text-xs px-2 py-0.5 rounded-full text-white font-medium" style="background: {badge.color}">{badge.label}</span>
												<span class="text-xs text-foreground-faint font-mono">{net.entry_module}:{net.entry_function}</span>
												<div class="flex gap-1.5 ml-auto">
													{#if net.load_state === 'loaded'}
														<button
															class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-xs font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
															onclick={() => handleUnloadNet(net.id)}
															disabled={actionInProgress === net.id}
														>
															Unload
														</button>
													{:else if net.load_state !== 'loading'}
														<span title={worker.status !== 'ready' ? 'Provision the worker before loading a net' : ''}>
															<button
																class="px-2.5 py-1 border border-green-600 rounded bg-green-600 text-white text-xs font-medium cursor-pointer transition-all hover:bg-green-700 hover:border-green-700 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
																onclick={() => handleLoadNet(net.id)}
																disabled={worker.status !== 'ready' || actionInProgress === net.id}
															>
																Load
															</button>
														</span>
													{/if}
													<button
														class="px-2.5 py-1 border border-destructive rounded bg-transparent text-destructive text-xs font-medium cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
														onclick={() => handleUnassignNet(net.id)}
														disabled={actionInProgress === net.id}
													>
														Unassign
													</button>
												</div>
												</div>
												</li>
										{/each}
									</ul>
								{/if}

								<!-- Assign Net Dropdown -->
								{#if nets.length > 0}
								{@const uniqueNets = nets
									.reduce((acc, n) => {
										if (!acc.some(x => x.name === n.name)) acc.push(n);
										return acc;
									}, [] as typeof nets)}
									<div class="mt-2">
										<select
											class="px-3 py-1.5 border border-border rounded bg-card text-foreground text-sm"
											onchange={(e) => { handleAssignNet(worker.id, e.currentTarget.value); e.currentTarget.value = ''; }}
										>
											<option value="">Assign a net...</option>
											{#each uniqueNets as net (net.id)}
													<option value={net.id}>{net.name}</option>
											{/each}
										</select>
									</div>
								{/if}
							</div>

							{#if provisionProgress.has(worker.id)}
								{@const progress = provisionProgress.get(worker.id)!}
								<div class="mt-3 flex items-center gap-3 px-1">
									<div class="flex items-center gap-2 text-sm text-foreground-muted">
										<svg class="animate-spin h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none">
											<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
											<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
										</svg>
										<span>Step {progress.step}/{progress.total}</span>
									</div>
									<span class="text-xs text-foreground-faint">{progress.label}</span>
								</div>
							{/if}

							<div class="mt-3">
								<LogViewer
									lines={workerLogs.get(worker.id) || []}
									expanded={workerLogsExpanded[worker.id] ?? false}
									title="Worker Logs"
									fullPageUrl={`/workers/${worker.id}/logs`}
									onToggle={() => {
										workerLogsExpanded = { ...workerLogsExpanded, [worker.id]: !workerLogsExpanded[worker.id] };
									}}
									onClear={() => {
										workerLogs.delete(worker.id);
										workerLogs = workerLogs;
									}}
								/>
							</div>

							<div class="mt-3 text-xs text-foreground-faint">
								<span>Created: {new Date(worker.created_at).toLocaleString()}</span>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		getMe,
		listWorkers, createWorker, deleteWorker, provisionWorker, destroyWorkerResource,
		startWorker, stopWorker, healthCheckWorker, getWorker,
		listNets, patchNet, loadNet, unloadNet,
		type Worker, type WorkerDetail, type Net,
	} from '$lib/api';
	import AppNav from '$lib/components/AppNav.svelte';
	import { serverEventsStore } from '$lib/stores/serverEvents';

	let workers = $state<Worker[]>([]);
	let nets = $state<Net[]>([]);
	let expandedWorkerId = $state<string | null>(null);
	let workerDetails = $state<Map<string, WorkerDetail>>(new Map());

	// Create form state
	let newWorkerName = $state('');
	let newWorkerCategory = $state<'ephemeral' | 'persistent'>('ephemeral');

	// Loading/error state
	let actionInProgress = $state<string | null>(null);
	let errorMessage = $state('');

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

	async function handleCreate() {
		if (!newWorkerName.trim()) return;
		await withAction('create', async () => {
			await createWorker({ name: newWorkerName.trim(), worker_category: newWorkerCategory });
			newWorkerName = '';
			await refreshWorkers();
		});
	}

	async function handleProvision(workerId: string) {
		await withAction(workerId, async () => {
			await provisionWorker(workerId);
			await refreshWorkers();
		});
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
			if (expandedWorkerId === workerId) expandedWorkerId = null;
			await refreshWorkers();
			await refreshNets();
		});
	}

	async function toggleExpand(workerId: string) {
		if (expandedWorkerId === workerId) {
			expandedWorkerId = null;
			return;
		}
		expandedWorkerId = workerId;
		try {
			const detail = await getWorker(workerId);
			workerDetails.set(workerId, detail);
			workerDetails = workerDetails; // trigger reactivity
		} catch (e: any) {
			errorMessage = e.message;
		}
	}

	async function handleAssignNet(workerId: string, netId: string) {
		if (!netId) return;
		await refreshNets();
		const net = nets.find(n => n.id === netId);
		if (!net || net.worker_id) {
			errorMessage = 'Net is no longer available for assignment.';
			return;
		}
		await withAction(workerId, async () => {
			await patchNet(netId, { worker_id: workerId });
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
			// Patch worker_id to null by sending explicit null
			const res = await fetch(
				`${(await import('$lib/api')).API_URL}/api/nets/${netId}`,
				{
					method: 'PATCH',
					credentials: 'include',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ worker_id: null }),
				}
			);
			if (!res.ok) throw new Error('Failed to unassign net');
			await refreshNets();
			if (expandedWorkerId) {
				const detail = await getWorker(expandedWorkerId);
				workerDetails.set(expandedWorkerId, detail);
				workerDetails = workerDetails;
			}
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

	onMount(async () => {
		const user = await getMe();
		if (!user) { goto('/login'); return; }
		await refreshAll();
		startPolling();
		document.addEventListener('visibilitychange', handleVisibilityChange);
	});

	onDestroy(() => {
		stopPolling();
		unsubscribeSSE();
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
				<input type="radio" bind:group={newWorkerCategory} value="ephemeral" />
				Ephemeral
			</label>
			<label class="flex items-center gap-1 text-sm text-foreground cursor-pointer">
				<input type="radio" bind:group={newWorkerCategory} value="persistent" />
				Persistent
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
									class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
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
								<button
									class="px-3.5 py-1.5 border border-destructive rounded bg-transparent text-destructive text-sm font-medium cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={(e) => { e.stopPropagation(); handleDelete(worker.id); }}
									disabled={actionInProgress === worker.id}
								>
									Delete
								</button>
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
							<button
								class="px-3.5 py-1.5 border border-destructive rounded bg-transparent text-destructive text-sm font-medium cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
								onclick={(e) => { e.stopPropagation(); handleDelete(worker.id); }}
								disabled={actionInProgress === worker.id}
							>
								Delete
							</button>
							<span class="text-[0.7em] text-foreground-muted ml-1">{expandedWorkerId === worker.id ? '▼' : '▶'}</span>
						</div>
					</div>

					{#if expandedWorkerId === worker.id}
						<div class="px-4 py-3 border-t border-border bg-muted">
							<div>
								<h4 class="mb-2 text-sm font-semibold text-foreground">Assigned Nets</h4>
								{#if netsForWorker(worker.id).length === 0}
									<p class="text-foreground-faint text-sm mb-2">No nets assigned</p>
								{:else}
									<ul class="list-none m-0 p-0 mb-3">
										{#each netsForWorker(worker.id) as net (net.id)}
											{@const badge = loadStateBadge(net.load_state)}
											<li class="flex items-center gap-3 py-1.5 border-b border-border-light flex-wrap last:border-b-0">
												<span class="font-medium text-foreground text-sm">{net.name}</span>
												<span class="text-xs px-2 py-0.5 rounded-full text-white font-medium" style="background: {badge.color}">{badge.label}</span>
												<span class="text-xs text-foreground-faint font-mono">{net.entry_module}:{net.entry_function}</span>
												<div class="flex gap-1.5 ml-auto">
													{#if worker.status === 'ready'}
														{#if net.load_state !== 'loaded'}
															<button
																class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-xs font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
																onclick={() => handleLoadNet(net.id)}
																disabled={actionInProgress === net.id}
															>
																Load
															</button>
														{:else}
															<button
																class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-xs font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
																onclick={() => handleUnloadNet(net.id)}
																disabled={actionInProgress === net.id}
															>
																Unload
															</button>
														{/if}
													{/if}
													<button
														class="px-2.5 py-1 border border-destructive rounded bg-transparent text-destructive text-xs font-medium cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
														onclick={() => handleUnassignNet(net.id)}
														disabled={actionInProgress === net.id}
													>
														Unassign
													</button>
												</div>
											</li>
										{/each}
									</ul>
								{/if}

								<!-- Assign Net Dropdown -->
								{#if nets.filter(n => !n.worker_id).length > 0}
									<div class="mt-2">
										<select
											class="px-3 py-1.5 border border-border rounded bg-card text-foreground text-sm"
											onchange={(e) => { handleAssignNet(worker.id, e.currentTarget.value); e.currentTarget.value = ''; }}
										>
											<option value="">Assign a net...</option>
											{#each nets.filter(n => !n.worker_id) as net (net.id)}
												<option value={net.id}>{net.name}</option>
											{/each}
										</select>
									</div>
								{/if}
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

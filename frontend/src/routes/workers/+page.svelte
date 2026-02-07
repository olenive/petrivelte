<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		getMe,
		listWorkers, createWorker, deleteWorker, provisionWorker, destroyWorkerResource,
		startWorker, stopWorker, getWorker,
		listNets, patchNet, loadNet, unloadNet,
		type Worker, type WorkerDetail, type Net,
	} from '$lib/api';
	import AppNav from '$lib/components/AppNav.svelte';

	let workers: Worker[] = [];
	let nets: Net[] = [];
	let expandedWorkerId: string | null = null;
	let workerDetails: Map<string, WorkerDetail> = new Map();

	// Create form state
	let newWorkerName = '';
	let newWorkerCategory: 'ephemeral' | 'persistent' = 'ephemeral';

	// Loading/error state
	let actionInProgress: string | null = null;
	let errorMessage = '';

	function clearError() { errorMessage = ''; }

	async function withAction(id: string, fn: () => Promise<void>) {
		clearError();
		actionInProgress = id;
		try {
			await fn();
		} catch (e: any) {
			errorMessage = e.message || 'Something went wrong';
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
		await withAction(workerId, async () => {
			await startWorker(workerId);
			await refreshWorkers();
		});
	}

	async function handleStop(workerId: string) {
		await withAction(workerId, async () => {
			await stopWorker(workerId);
			await refreshWorkers();
		});
	}

	async function handleDestroyResource(workerId: string) {
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
		await withAction(workerId, async () => {
			await patchNet(netId, { worker_id: workerId });
			await refreshNets();
			const detail = await getWorker(workerId);
			workerDetails.set(workerId, detail);
			workerDetails = workerDetails;
		});
	}

	async function handleUnassignNet(netId: string) {
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
		await withAction(netId, async () => {
			await loadNet(netId);
		});
	}

	async function handleUnloadNet(netId: string) {
		await withAction(netId, async () => {
			await unloadNet(netId);
		});
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'ready': return 'var(--status-ready)';
			case 'stopped': return 'var(--status-stopped)';
			case 'error': return 'var(--status-error)';
			case 'provisioning': return 'var(--status-provisioning)';
			default: return 'var(--status-pending)';
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
		await Promise.all([refreshWorkers(), refreshNets()]);
	});
</script>

<AppNav title="Workers" />

<div class="workers-page">

	{#if errorMessage}
		<div class="error-banner">
			<span>{errorMessage}</span>
			<button class="dismiss" on:click={clearError}>x</button>
		</div>
	{/if}

	<!-- Create Worker Form -->
	<div class="create-form">
		<input
			type="text"
			bind:value={newWorkerName}
			placeholder="Worker name"
			on:keydown={(e) => e.key === 'Enter' && handleCreate()}
		/>
		<div class="type-selector">
			<label class="radio-label">
				<input type="radio" bind:group={newWorkerCategory} value="ephemeral" />
				Ephemeral
			</label>
			<label class="radio-label">
				<input type="radio" bind:group={newWorkerCategory} value="persistent" />
				Persistent
			</label>
		</div>
		<span class="create-btn-wrapper" title={!newWorkerName.trim() ? 'Enter a worker name first' : ''}>
			<button
				class="create-btn"
				on:click={handleCreate}
				disabled={!newWorkerName.trim() || actionInProgress === 'create'}
			>
				{actionInProgress === 'create' ? 'Creating...' : 'Create Worker'}
			</button>
		</span>
	</div>

	<!-- Worker List -->
	{#if workers.length === 0}
		<p class="empty">No workers yet. Create one above.</p>
	{:else}
		<div class="worker-list">
			{#each workers as worker (worker.id)}
				<div class="worker-card">
					<div class="worker-header" on:click={() => toggleExpand(worker.id)} role="button" tabindex="0" on:keydown={(e) => e.key === 'Enter' && toggleExpand(worker.id)}>
						<div class="worker-info">
							<span class="worker-name">{worker.name}</span>
							<span class="worker-type">{workerCategoryLabel(worker.worker_category)}</span>
							<span class="status-badge" style="background: {statusColor(worker.status)}">
								{worker.status}
							</span>
						</div>
						<div class="worker-actions">
							{#if worker.status === 'pending'}
								<button
									on:click|stopPropagation={() => handleProvision(worker.id)}
									disabled={actionInProgress === worker.id}
								>
									Provision
								</button>
							{/if}
							{#if worker.status === 'error'}
								<button
									on:click|stopPropagation={() => handleProvision(worker.id)}
									disabled={actionInProgress === worker.id}
								>
									Retry
								</button>
							{/if}
							{#if worker.status === 'ready' && worker.worker_category === 'persistent'}
								<button
									on:click|stopPropagation={() => handleStop(worker.id)}
									disabled={actionInProgress === worker.id}
								>
									Stop
								</button>
							{/if}
							{#if worker.status === 'stopped'}
								<button
									on:click|stopPropagation={() => handleStart(worker.id)}
									disabled={actionInProgress === worker.id}
								>
									Start
								</button>
							{/if}
							{#if worker.status === 'ready' || worker.status === 'stopped'}
								<button
									class="danger-outline"
									on:click|stopPropagation={() => handleDestroyResource(worker.id)}
									disabled={actionInProgress === worker.id}
								>
									Destroy Resource
								</button>
							{/if}
							<button
								class="danger"
								on:click|stopPropagation={() => handleDelete(worker.id)}
								disabled={actionInProgress === worker.id}
							>
								Delete
							</button>
							<span class="expand-icon">{expandedWorkerId === worker.id ? '▼' : '▶'}</span>
						</div>
					</div>

					{#if expandedWorkerId === worker.id}
						<div class="worker-detail">
							<div class="detail-section">
								<h4>Assigned Nets</h4>
								{#if netsForWorker(worker.id).length === 0}
									<p class="empty-small">No nets assigned</p>
								{:else}
									<ul class="net-list">
										{#each netsForWorker(worker.id) as net (net.id)}
											<li class="net-item">
												<span class="net-name">{net.name}</span>
												<span class="net-module">{net.entry_module}:{net.entry_function}</span>
												<div class="net-actions">
													{#if worker.status === 'ready'}
														<button
															class="small"
															on:click={() => handleLoadNet(net.id)}
															disabled={actionInProgress === net.id}
														>
															Load
														</button>
														<button
															class="small"
															on:click={() => handleUnloadNet(net.id)}
															disabled={actionInProgress === net.id}
														>
															Unload
														</button>
													{/if}
													<button
														class="small danger-outline"
														on:click={() => handleUnassignNet(net.id)}
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
									<div class="assign-control">
										<select on:change={(e) => { handleAssignNet(worker.id, e.currentTarget.value); e.currentTarget.value = ''; }}>
											<option value="">Assign a net...</option>
											{#each nets.filter(n => !n.worker_id) as net (net.id)}
												<option value={net.id}>{net.name}</option>
											{/each}
										</select>
									</div>
								{/if}
							</div>

							<div class="detail-meta">
								<span>Created: {new Date(worker.created_at).toLocaleString()}</span>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.workers-page {
		max-width: 900px;
		margin: 0 auto;
		padding: 2rem;
	}

	.error-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		background: var(--error-bg);
		color: var(--error-text);
		border-radius: 6px;
		margin-bottom: 1rem;
	}

	.error-banner .dismiss {
		background: none;
		border: none;
		color: var(--error-text);
		cursor: pointer;
		font-weight: bold;
		padding: 0 0.25rem;
	}

	/* Create form */
	.create-form {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 1rem;
		background: var(--bg-secondary);
		border: 1px solid var(--border-color);
		border-radius: 6px;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}

	.create-form input[type="text"] {
		flex: 1;
		min-width: 150px;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.9em;
	}

	.type-selector {
		display: flex;
		gap: 0.75rem;
	}

	.radio-label {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.9em;
		color: var(--text-primary);
		cursor: pointer;
	}

	.create-btn {
		padding: 0.5rem 1.25rem;
		border: 1px solid var(--button-border);
		border-radius: 4px;
		background: var(--button-hover-bg);
		color: var(--button-hover-text);
		font-weight: 500;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.create-btn-wrapper {
		display: inline-block;
	}

	.create-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Worker list */
	.empty {
		text-align: center;
		color: var(--text-secondary);
		padding: 2rem;
	}

	.worker-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.worker-card {
		border: 1px solid var(--border-color);
		border-radius: 6px;
		background: var(--bg-secondary);
		overflow: hidden;
	}

	.worker-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		cursor: pointer;
		transition: background 0.15s;
		gap: 0.75rem;
	}

	.worker-header:hover {
		background: var(--bg-hover);
	}

	.worker-info {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.worker-name {
		font-weight: 600;
		color: var(--text-primary);
	}

	.worker-type {
		font-size: 0.8em;
		color: var(--text-secondary);
		padding: 0.15rem 0.5rem;
		background: var(--bg-tertiary);
		border-radius: 3px;
	}

	.status-badge {
		font-size: 0.8em;
		padding: 0.15rem 0.6rem;
		border-radius: 10px;
		color: white;
		font-weight: 500;
		text-transform: capitalize;
	}

	.worker-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.expand-icon {
		font-size: 0.7em;
		color: var(--text-secondary);
		margin-left: 0.25rem;
	}

	button {
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--button-border);
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--button-text);
		font-size: 0.85em;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	button:hover:not(:disabled) {
		background: var(--button-hover-bg);
		color: var(--button-hover-text);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	button.small {
		padding: 0.25rem 0.6rem;
		font-size: 0.8em;
	}

	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	button.danger:hover:not(:disabled) {
		background: var(--danger-hover);
		color: white;
	}

	button.danger-outline {
		border-color: var(--danger);
		color: var(--danger);
	}

	button.danger-outline:hover:not(:disabled) {
		background: var(--danger-hover);
		color: white;
	}

	/* Worker detail (expanded) */
	.worker-detail {
		padding: 0.75rem 1rem;
		border-top: 1px solid var(--border-color);
		background: var(--bg-tertiary);
	}

	.detail-section h4 {
		margin: 0 0 0.5rem;
		font-size: 0.9em;
		color: var(--text-primary);
	}

	.empty-small {
		color: var(--text-tertiary);
		font-size: 0.85em;
		margin: 0 0 0.5rem;
	}

	.net-list {
		list-style: none;
		margin: 0 0 0.75rem;
		padding: 0;
	}

	.net-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--border-light);
		flex-wrap: wrap;
	}

	.net-item:last-child {
		border-bottom: none;
	}

	.net-name {
		font-weight: 500;
		color: var(--text-primary);
		font-size: 0.9em;
	}

	.net-module {
		font-size: 0.8em;
		color: var(--text-tertiary);
		font-family: monospace;
	}

	.net-actions {
		display: flex;
		gap: 0.35rem;
		margin-left: auto;
	}

	.assign-control {
		margin-top: 0.5rem;
	}

	.assign-control select {
		padding: 0.4rem 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: 0.85em;
	}

	.detail-meta {
		margin-top: 0.75rem;
		font-size: 0.8em;
		color: var(--text-tertiary);
	}

</style>

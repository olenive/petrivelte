<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		getMe,
		getGitHubStatus,
		getGitHubConnectUrl,
		listGitHubRepos,
		connectGitHubRepo,
		disconnectGitHubRepo,
		triggerRepoBuild,
		listDeployments,
		createWorker,
		type GitHubStatus,
		type GitHubRepo,
		type Deployment,
	} from '$lib/api';
	import AppNav from '$lib/components/AppNav.svelte';

	let github = $state<GitHubStatus | null>(null);
	let repos = $state<GitHubRepo[]>([]);
	let deployments = $state<Deployment[]>([]);

	// Connect repo form
	let newRepoFullName = $state('');
	let newRepoBranch = $state('main');

	// Loading/error state
	let actionInProgress = $state<string | null>(null);
	let errorMessage = $state('');
	let successMessage = $state('');

	// Polling for build status
	let pollingInterval: ReturnType<typeof setInterval> | null = null;

	function clearMessages() {
		errorMessage = '';
		successMessage = '';
	}

	async function withAction(id: string, fn: () => Promise<void>) {
		clearMessages();
		actionInProgress = id;
		try {
			await fn();
		} catch (e: any) {
			errorMessage = e.message || 'Something went wrong';
		} finally {
			actionInProgress = null;
		}
	}

	async function refreshData() {
		try {
			github = await getGitHubStatus();
			if (github.connected) {
				repos = await listGitHubRepos();
				deployments = await listDeployments();
			}
		} catch (e: any) {
			console.error('Failed to refresh data:', e);
		}
	}

	async function handleConnectRepo() {
		if (!newRepoFullName.trim()) return;
		await withAction('connect-repo', async () => {
			await connectGitHubRepo(newRepoFullName.trim(), newRepoBranch || 'main');
			successMessage = `Connected ${newRepoFullName}`;
			newRepoFullName = '';
			newRepoBranch = 'main';
			await refreshData();
		});
	}

	async function handleDisconnectRepo(repoId: string, fullName: string) {
		await withAction(repoId, async () => {
			await disconnectGitHubRepo(repoId);
			successMessage = `Disconnected ${fullName}`;
			await refreshData();
		});
	}

	async function handleTriggerBuild(repoId: string, fullName: string) {
		await withAction(`build-${repoId}`, async () => {
			const result = await triggerRepoBuild(repoId);
			successMessage = `Build triggered for ${fullName} (commit ${result.commit})`;
			await refreshData();
			// Start polling for updates
			startPolling();
		});
	}

	async function handleCreateWorkerFromDeployment(deployment: Deployment) {
		const name = `worker-${deployment.git_commit?.slice(0, 7) || deployment.id.slice(0, 8)}`;
		await withAction(`create-worker-${deployment.id}`, async () => {
			await createWorker({
				name,
				worker_category: 'persistent',
				deployment_id: deployment.id,
			});
			successMessage = `Created worker "${name}" from deployment`;
		});
	}

	function startPolling() {
		if (pollingInterval) return;
		pollingInterval = setInterval(async () => {
			const hasBuilding = deployments.some(d => d.build_status === 'pending' || d.build_status === 'building');
			if (!hasBuilding) {
				stopPolling();
				return;
			}
			await refreshData();
		}, 3000);
	}

	function stopPolling() {
		if (pollingInterval) {
			clearInterval(pollingInterval);
			pollingInterval = null;
		}
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'success': return 'var(--status-ready)';
			case 'failed': return 'var(--status-error)';
			case 'building': return 'var(--status-provisioning)';
			default: return 'var(--status-pending)';
		}
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString();
	}

	onMount(() => {
		(async () => {
			const user = await getMe();
			if (!user) {
				goto('/login');
				return;
			}
			await refreshData();

			// Start polling if there are active builds
			if (deployments.some(d => d.build_status === 'pending' || d.build_status === 'building')) {
				startPolling();
			}
		})();

		return () => stopPolling();
	});
</script>

<AppNav title="Deployments" />

<div class="max-w-[900px] mx-auto p-8">
	{#if errorMessage}
		<div class="flex items-center justify-between px-4 py-3 bg-error-bg text-error rounded-md mb-4">
			<span>{errorMessage}</span>
			<button class="text-error font-bold cursor-pointer px-1" onclick={() => errorMessage = ''}>x</button>
		</div>
	{/if}

	{#if successMessage}
		<div class="flex items-center justify-between px-4 py-3 bg-success-bg text-success rounded-md mb-4">
			<span>{successMessage}</span>
			<button class="text-success font-bold cursor-pointer px-1" onclick={() => successMessage = ''}>x</button>
		</div>
	{/if}

	{#if !github?.connected}
		<!-- GitHub Not Connected -->
		<div class="text-center p-8 bg-card border border-border rounded-md">
			<svg class="mx-auto mb-4" viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
				<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
			</svg>
			<h2 class="text-lg font-medium text-foreground mb-2">Connect GitHub</h2>
			<p class="text-foreground-muted mb-4">Connect your GitHub account to deploy Petri nets from your repositories.</p>
			<a
				href={getGitHubConnectUrl()}
				class="inline-block px-5 py-2 border border-accent rounded bg-accent text-accent-foreground font-medium cursor-pointer transition-opacity hover:opacity-90"
			>
				Connect GitHub
			</a>
		</div>
	{:else}
		<!-- Connected Repos -->
		<section class="mb-8">
			<h2 class="text-lg font-medium text-foreground mb-4">Connected Repositories</h2>

			<!-- Connect Repo Form -->
			<div class="flex items-center gap-3 p-4 bg-card border border-border rounded-md mb-4 flex-wrap">
				<input
					type="text"
					bind:value={newRepoFullName}
					placeholder="owner/repo"
					onkeydown={(e) => e.key === 'Enter' && handleConnectRepo()}
					class="flex-1 min-w-[200px] px-3 py-2 border border-border rounded bg-surface text-foreground text-sm"
				/>
				<input
					type="text"
					bind:value={newRepoBranch}
					placeholder="branch (default: main)"
					class="w-[150px] px-3 py-2 border border-border rounded bg-surface text-foreground text-sm"
				/>
				<button
					class="px-5 py-2 border border-accent rounded bg-accent text-accent-foreground font-medium cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={handleConnectRepo}
					disabled={!newRepoFullName.trim() || actionInProgress === 'connect-repo'}
				>
					{actionInProgress === 'connect-repo' ? 'Connecting...' : 'Connect Repo'}
				</button>
			</div>

			{#if repos.length === 0}
				<p class="text-center text-foreground-muted p-4">No repositories connected yet.</p>
			{:else}
				<div class="flex flex-col gap-2">
					{#each repos as repo (repo.id)}
						<div class="flex items-center justify-between p-4 bg-card border border-border rounded-md">
							<div class="flex items-center gap-3">
								<span class="font-medium text-foreground">{repo.full_name}</span>
								<span class="text-xs text-foreground-muted px-2 py-0.5 bg-muted rounded-sm">{repo.default_branch}</span>
								{#if repo.webhook_active}
									<span class="text-xs px-2 py-0.5 rounded-sm bg-success-bg text-success">Webhook active</span>
								{:else}
									<span class="text-xs px-2 py-0.5 rounded-sm bg-border text-foreground-faint">Manual builds</span>
								{/if}
							</div>
							<div class="flex items-center gap-2">
								<button
									class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={() => handleTriggerBuild(repo.id, repo.full_name)}
									disabled={actionInProgress === `build-${repo.id}`}
								>
									{actionInProgress === `build-${repo.id}` ? 'Triggering...' : 'Build'}
								</button>
								<button
									class="px-3.5 py-1.5 border border-destructive rounded bg-transparent text-destructive text-sm font-medium cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={() => handleDisconnectRepo(repo.id, repo.full_name)}
									disabled={actionInProgress === repo.id}
								>
									Disconnect
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Deployments -->
		<section>
			<h2 class="text-lg font-medium text-foreground mb-4">Deployments</h2>

			{#if deployments.length === 0}
				<p class="text-center text-foreground-muted p-4">No deployments yet. Connect a repo and trigger a build.</p>
			{:else}
				<div class="flex flex-col gap-3">
					{#each deployments as deployment (deployment.id)}
						<div class="p-4 bg-card border border-border rounded-md">
							<div class="flex items-center justify-between mb-2">
								<div class="flex items-center gap-3">
									<span class="font-mono text-sm text-foreground">{deployment.git_commit?.slice(0, 7) || 'pending'}</span>
									<span class="text-xs px-2.5 py-0.5 rounded-full text-white font-medium capitalize" style="background: {statusColor(deployment.build_status)}">
										{deployment.build_status}
									</span>
									<span class="text-xs text-foreground-muted">{deployment.git_ref}</span>
								</div>
								<span class="text-xs text-foreground-faint">{formatDate(deployment.created_at)}</span>
							</div>

							{#if deployment.build_error}
								<div class="mt-2 px-3 py-2 bg-error-bg text-error text-sm rounded-md font-mono text-xs overflow-x-auto">
									{deployment.build_error}
								</div>
							{/if}

							{#if deployment.build_status === 'success' && deployment.discovered_nets && deployment.discovered_nets.length > 0}
								<div class="mt-3 pt-3 border-t border-border">
									<h4 class="text-sm font-medium text-foreground mb-2">Discovered Nets</h4>
									<ul class="list-none m-0 p-0">
										{#each deployment.discovered_nets as net}
											<li class="flex items-center gap-3 py-1 text-sm">
												<span class="font-medium text-foreground">{net.name}</span>
												<span class="text-xs text-foreground-faint font-mono">{net.module}:{net.function}</span>
											</li>
										{/each}
									</ul>
								</div>
							{/if}

							{#if deployment.build_status === 'success' && deployment.image_tag}
								<div class="mt-3 pt-3 border-t border-border flex items-center justify-between">
									<span class="text-xs text-foreground-faint font-mono">{deployment.image_tag}</span>
									<button
										class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
										onclick={() => handleCreateWorkerFromDeployment(deployment)}
										disabled={actionInProgress === `create-worker-${deployment.id}`}
									>
										{actionInProgress === `create-worker-${deployment.id}` ? 'Creating...' : 'Create Worker'}
									</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</div>

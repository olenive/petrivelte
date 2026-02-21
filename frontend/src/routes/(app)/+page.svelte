<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		logout,
		listNets, listWorkers,
		getGitHubStatus, listGitHubRepos, listDeployments,
		type Net, type Worker,
	} from '$lib/api';
	import AppNav from '$lib/components/AppNav.svelte';
	import SetupChecklist from '$lib/components/SetupChecklist.svelte';

	let userEmail = $derived($page.data.user?.email ?? '');
	let loading = $state(true);

	// Checklist state
	let githubConnected = $state(false);
	let hasRepos = $state(false);
	let hasSuccessfulBuild = $state(false);
	let workers = $state<Worker[]>([]);
	let nets = $state<Net[]>([]);

	async function handleLogout() {
		await logout();
		goto('/login');
	}

	onMount(() => {
		(async () => {
			await Promise.all([
				listWorkers().then(w => workers = w).catch(() => {}),
				listNets().then(n => nets = n).catch(() => {}),
				getGitHubStatus().then(s => githubConnected = s.connected).catch(() => {}),
				listGitHubRepos().then(r => hasRepos = r.length > 0).catch(() => {}),
				listDeployments().then(d => hasSuccessfulBuild = d.some(dep => dep.build_status === 'success')).catch(() => {}),
			]);
			loading = false;
		})();
	});
</script>

<div class="flex flex-col h-screen bg-surface">
	<AppNav {userEmail} onLogout={handleLogout} />

	<main class="flex-1 flex flex-col items-center justify-center p-8">
		{#if loading}
			<p class="text-sm text-foreground-muted">Loading...</p>
		{:else}
			<SetupChecklist
				{githubConnected}
				{hasRepos}
				{hasSuccessfulBuild}
				hasWorkers={workers.length > 0}
				hasReadyWorker={workers.some(w => w.status === 'ready')}
				hasLoadedNet={nets.some(n => n.load_state === 'loaded')}
			/>
		{/if}
	</main>
</div>

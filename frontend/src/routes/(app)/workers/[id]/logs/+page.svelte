<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { page } from '$app/stores';
	import { getWorker, listNets, type WorkerDetail, type Net } from '$lib/api';
	import AppNav from '$lib/components/AppNav.svelte';
	import {
		workerLogsStore, setNets, loadHistory, clearLogs, connectRuntimeLogs,
	} from '$lib/stores/workerLogs';

	let workerId = $derived($page.params.id as string);
	let worker = $state<WorkerDetail | null>(null);
	let nets = $state<Net[]>([]);
	let allLogs = $state<Map<string, string[]>>(new Map());
	let logLines = $derived(allLogs.get(workerId) || []);
	let scrollContainer = $state<HTMLPreElement | null>(null);
	let userScrolledUp = $state(false);
	let errorMessage = $state('');

	// Subscribe to the shared log store
	const unsubscribeLogs = workerLogsStore.subscribe(m => {
		allLogs = m;
	});

	function handleScroll() {
		if (!scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		userScrolledUp = scrollHeight - scrollTop - clientHeight > 30;
	}

	$effect(() => {
		logLines.length;
		if (!userScrolledUp && scrollContainer) {
			tick().then(() => {
				if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
			});
		}
	});

	function statusColor(status: string): string {
		switch (status) {
			case 'ready': return 'var(--status-ready)';
			case 'stopped': return 'var(--status-stopped)';
			case 'error': return 'var(--status-error)';
			case 'provisioning': return 'var(--status-provisioning)';
			default: return 'var(--status-pending)';
		}
	}

	async function refreshWorker() {
		try {
			worker = await getWorker(workerId);
			nets = await listNets();
			setNets(nets);
		} catch (e: any) {
			errorMessage = e.message;
		}
	}

	let disconnectRuntime: (() => void) | null = null;

	onMount(async () => {
		await refreshWorker();
		await loadHistory(workerId);
		// Connect to runtime log SSE for subprocess output
		disconnectRuntime = connectRuntimeLogs(workerId);
	});

	onDestroy(() => {
		unsubscribeLogs();
		disconnectRuntime?.();
	});
</script>

<AppNav title={worker ? `Logs — ${worker.name}` : 'Worker Logs'} />

<div class="max-w-[1200px] mx-auto p-4 flex flex-col h-[calc(100vh-60px)]">
	{#if errorMessage}
		<div class="px-4 py-3 bg-error-bg text-error rounded-md mb-4">{errorMessage}</div>
	{/if}

	{#if worker}
		<div class="flex items-center gap-3 mb-3 flex-shrink-0">
			<a href="/workers" class="text-accent hover:underline text-sm">← Workers</a>
			<span class="text-foreground-muted text-sm">|</span>
			<span class="font-semibold text-foreground">{worker.name}</span>
			<span class="text-xs px-2.5 py-0.5 rounded-full text-white font-medium capitalize" style="background: {statusColor(worker.status)}">
				{worker.status}
			</span>
			{#if worker.assigned_nets.length > 0}
				<span class="text-xs text-foreground-muted">
					Nets: {worker.assigned_nets.map(n => n.name).join(', ')}
				</span>
			{/if}
		</div>
	{/if}

	<div class="flex-1 min-h-0 border border-border rounded overflow-hidden flex flex-col">
		{#if logLines.length === 0}
			<div class="flex-1 flex items-center justify-center text-foreground-faint text-sm bg-[#1a1a2e]">
				No log output yet. Logs will appear here as events stream in.
			</div>
		{:else}
			<pre
				bind:this={scrollContainer}
				onscroll={handleScroll}
				class="flex-1 bg-[#1a1a2e] text-[#c8c8d0] p-4 text-xs font-mono overflow-y-auto whitespace-pre-wrap break-words m-0"
			>{#each logLines as line}<span class={/\berror\b/i.test(line) ? 'text-red-400' : ''}>{line}
</span>{/each}</pre>
		{/if}
	</div>

	<div class="flex items-center justify-between mt-2 flex-shrink-0">
		<span class="text-xs text-foreground-faint">{logLines.length} lines</span>
		{#if logLines.length > 0}
			<button
				class="text-xs text-foreground-faint hover:text-foreground-muted cursor-pointer bg-transparent border-0"
				onclick={() => clearLogs(workerId)}
			>Clear</button>
		{/if}
	</div>
</div>

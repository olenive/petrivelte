<script lang="ts">
	import { dev } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import AppNav from '$lib/components/AppNav.svelte';

	// Redirect away in production
	onMount(() => {
		if (!dev) goto('/workers');
	});

	// -- LogViewer demo --
	let logLines = $state<string[]>([]);
	let logExpanded = $state(false);
	let streamTimer = $state<ReturnType<typeof setInterval> | null>(null);

	const sampleLogLines = [
		'[daily_pipeline] Downloading deployment artifact...',
		'[daily_pipeline] Download complete (2.3 MB)',
		'[daily_pipeline] Extracting code...',
		'[daily_pipeline] Found requirements.txt',
		'[daily_pipeline] Installing dependencies with uv...',
		'[daily_pipeline] Resolved 12 packages in 340ms',
		'[daily_pipeline] Installing polars==1.5.0',
		'[daily_pipeline] Installing httpx==0.27.0',
		'[daily_pipeline] Installing pydantic==2.6.0',
		'[daily_pipeline] Installed 12 packages in 1.2s',
		'[daily_pipeline] Importing petri_nets.daily_pipeline.build_daily_net...',
		'[daily_pipeline] Net loaded successfully — 4 places, 3 transitions',
		'[worker] Status → ready',
		'[daily_pipeline] State → loaded',
	];

	const errorLogLines = [
		'[daily_pipeline] Downloading deployment artifact...',
		'[daily_pipeline] Download complete (2.3 MB)',
		'[daily_pipeline] Extracting code...',
		'[daily_pipeline] Found requirements.txt',
		'[daily_pipeline] Installing dependencies with uv...',
		'[daily_pipeline] Resolved 12 packages in 340ms',
		'[daily_pipeline] Installing polars==1.5.0',
		'[daily_pipeline] Installed 12 packages in 1.2s',
		'[daily_pipeline] Importing petri_nets.daily_pipeline.build_daily_net...',
		'[daily_pipeline] ERROR: Failed to import petri_nets.daily_pipeline.build_daily_net: No module named \'polars\'',
		'[daily_pipeline] State → error',
	];

	let streamIndex = $state(0);

	function startStream(lines: string[]) {
		stopStream();
		logLines = [];
		logExpanded = true;
		streamIndex = 0;
		streamTimer = setInterval(() => {
			if (streamIndex >= lines.length) {
				stopStream();
				return;
			}
			logLines.push(lines[streamIndex]);
			logLines = logLines;
			streamIndex++;
		}, 300);
	}

	function stopStream() {
		if (streamTimer) {
			clearInterval(streamTimer);
			streamTimer = null;
		}
	}

	function addSingleLine() {
		logLines.push(`[test] Log line at ${new Date().toLocaleTimeString()}`);
		logLines = logLines;
	}

	function addBurst() {
		for (let i = 0; i < 20; i++) {
			logLines.push(`[burst] Line ${logLines.length + 1} — ${crypto.randomUUID().slice(0, 8)}`);
		}
		logLines = logLines;
	}

	// -- Provisioning progress demo --
	let provisionStep = $state(0);
	let provisionTotal = $state(3);
	let provisionLabel = $state('');
	let provisionTimer = $state<ReturnType<typeof setInterval> | null>(null);

	const provisionSteps = [
		{ step: 1, label: 'Creating machine...' },
		{ step: 2, label: 'Waiting for health check...' },
		{ step: 3, label: 'Ready' },
	];

	function startProvisionDemo() {
		stopProvisionDemo();
		provisionStep = 1;
		provisionLabel = provisionSteps[0].label;
		let idx = 0;
		provisionTimer = setInterval(() => {
			idx++;
			if (idx >= provisionSteps.length) {
				stopProvisionDemo();
				return;
			}
			provisionStep = provisionSteps[idx].step;
			provisionLabel = provisionSteps[idx].label;
		}, 2000);
	}

	function stopProvisionDemo() {
		if (provisionTimer) {
			clearInterval(provisionTimer);
			provisionTimer = null;
		}
		provisionStep = 0;
		provisionLabel = '';
	}

	// -- Empty state demo --
	let emptyExpanded = $state(false);

	// -- Worker expansion demo --
	interface MockWorker {
		id: string;
		name: string;
		status: string;
		category: string;
		memory_mb: number;
		cpus: number;
	}

	const mockWorkers: MockWorker[] = [
		{ id: 'w1', name: 'pipeline-worker', status: 'ready', category: 'ephemeral', memory_mb: 512, cpus: 1 },
		{ id: 'w2', name: 'ml-worker', status: 'pending', category: 'persistent', memory_mb: 2048, cpus: 2 },
		{ id: 'w3', name: 'test-worker', status: 'error', category: 'ephemeral', memory_mb: 256, cpus: 1 },
	];

	let expandedWorkerIds = $state<Record<string, boolean>>({});
	let expandClickLog = $state<string[]>([]);

	function toggleMockExpand(workerId: string) {
		expandClickLog = [...expandClickLog, `toggleExpand("${workerId}") called at ${new Date().toLocaleTimeString()}`];
		if (expandedWorkerIds[workerId]) {
			const { [workerId]: _, ...rest } = expandedWorkerIds;
			expandedWorkerIds = rest;
		} else {
			expandedWorkerIds = { ...expandedWorkerIds, [workerId]: true };
		}
	}

	function mockStatusColor(status: string): string {
		switch (status) {
			case 'ready': return 'var(--status-ready)';
			case 'error': return 'var(--status-error)';
			default: return 'var(--status-pending)';
		}
	}
</script>

{#if dev}
<AppNav title="Dev — Component Test Page" />

<div class="max-w-[900px] mx-auto p-8 flex flex-col gap-8">

	<div class="text-sm text-foreground-muted border border-border rounded px-4 py-3 bg-muted">
		This page is only available in development mode. It lets you test UI components in isolation.
	</div>

	<!-- Worker Expansion -->
	<section>
		<h2 class="text-lg font-semibold text-foreground mb-3">Worker Card Expansion</h2>
		<p class="text-sm text-foreground-muted mb-3">Click the row or arrow to expand/collapse. Multiple workers should expand independently.</p>
		<div class="flex flex-col gap-2">
			{#each mockWorkers as worker (worker.id)}
				<div class="border border-border rounded-md bg-card overflow-hidden">
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="flex items-center justify-between px-4 py-3 cursor-pointer transition-colors gap-3 hover:bg-hover"
						onclick={() => toggleMockExpand(worker.id)}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === 'Enter' && toggleMockExpand(worker.id)}
					>
						<div class="flex items-center gap-3">
							<span class="font-semibold text-foreground">{worker.name}</span>
							<span class="text-xs text-foreground-muted px-2 py-0.5 bg-muted rounded-sm">{worker.category}</span>
							<span class="text-xs text-foreground-muted px-2 py-0.5 bg-muted rounded-sm">{worker.memory_mb} MB / {worker.cpus} CPU</span>
							<span class="text-xs px-2.5 py-0.5 rounded-full text-white font-medium capitalize" style="background: {mockStatusColor(worker.status)}">
								{worker.status}
							</span>
						</div>
						<div class="flex items-center gap-2">
							<button
								class="px-3.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground"
								onclick={(e) => { e.stopPropagation(); expandClickLog = [...expandClickLog, `Button clicked on "${worker.name}" (stopPropagation)`]; }}
							>
								Test Button
							</button>
							<span class="text-[0.7em] text-foreground-muted ml-1">{expandedWorkerIds[worker.id] ? '▼' : '▶'}</span>
						</div>
					</div>

					{#if expandedWorkerIds[worker.id]}
						<div class="px-4 py-3 border-t border-border bg-muted">
							<p class="text-sm text-foreground">Expanded content for <strong>{worker.name}</strong></p>
							<p class="text-xs text-foreground-faint mt-1">Worker ID: {worker.id} | Status: {worker.status}</p>
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<div class="mt-3">
			<h3 class="text-sm font-semibold text-foreground mb-1">Click Log</h3>
			<div class="text-xs text-foreground-muted bg-muted border border-border rounded p-2 max-h-[120px] overflow-y-auto">
				{#if expandClickLog.length === 0}
					<span class="text-foreground-faint">Click events will appear here...</span>
				{:else}
					{#each expandClickLog as entry}
						<div>{entry}</div>
					{/each}
				{/if}
			</div>
			<button
				class="mt-1 text-xs text-foreground-faint hover:text-foreground-muted cursor-pointer bg-transparent border-0"
				onclick={() => { expandClickLog = []; }}
			>Clear log</button>
		</div>
	</section>

	<!-- LogViewer: Empty state -->
	<section>
		<h2 class="text-lg font-semibold text-foreground mb-3">LogViewer — Empty State</h2>
		<LogViewer
			lines={[]}
			expanded={emptyExpanded}
			title="Worker Logs"
			fullPageUrl="/dev"
			onToggle={() => { emptyExpanded = !emptyExpanded; }}
		/>
	</section>

	<!-- LogViewer: Interactive -->
	<section>
		<h2 class="text-lg font-semibold text-foreground mb-3">LogViewer — Interactive</h2>
		<div class="flex gap-2 mb-3 flex-wrap">
			<button
				class="px-3 py-1.5 border border-accent rounded bg-accent text-accent-foreground text-sm font-medium cursor-pointer hover:opacity-90"
				onclick={() => startStream(sampleLogLines)}
			>
				Stream: Success
			</button>
			<button
				class="px-3 py-1.5 border border-destructive rounded bg-destructive text-white text-sm font-medium cursor-pointer hover:opacity-90"
				onclick={() => startStream(errorLogLines)}
			>
				Stream: Error
			</button>
			<button
				class="px-3 py-1.5 border border-border rounded bg-card text-foreground text-sm cursor-pointer hover:bg-hover"
				onclick={addSingleLine}
			>
				Add 1 Line
			</button>
			<button
				class="px-3 py-1.5 border border-border rounded bg-card text-foreground text-sm cursor-pointer hover:bg-hover"
				onclick={addBurst}
			>
				Add 20 Lines (burst)
			</button>
			<button
				class="px-3 py-1.5 border border-border rounded bg-card text-foreground text-sm cursor-pointer hover:bg-hover"
				onclick={() => { stopStream(); logLines = []; }}
			>
				Clear
			</button>
		</div>
		<LogViewer
			lines={logLines}
			expanded={logExpanded}
			title="Worker Logs"
			fullPageUrl="/dev"
			onToggle={() => { logExpanded = !logExpanded; }}
			onClear={() => { stopStream(); logLines = []; }}
		/>
	</section>

	<!-- Provisioning Progress -->
	<section>
		<h2 class="text-lg font-semibold text-foreground mb-3">Provisioning Progress Indicator</h2>
		<div class="flex gap-2 mb-3">
			<button
				class="px-3 py-1.5 border border-green-600 rounded bg-green-600 text-white text-sm font-medium cursor-pointer hover:bg-green-700"
				onclick={startProvisionDemo}
			>
				Simulate Provisioning
			</button>
			<button
				class="px-3 py-1.5 border border-border rounded bg-card text-foreground text-sm cursor-pointer hover:bg-hover"
				onclick={stopProvisionDemo}
			>
				Reset
			</button>
		</div>
		<div class="border border-border rounded-md bg-card p-4">
			{#if provisionStep > 0}
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2 text-sm text-foreground-muted">
						<svg class="animate-spin h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
						</svg>
						<span>Step {provisionStep}/{provisionTotal}</span>
					</div>
					<span class="text-xs text-foreground-faint">{provisionLabel}</span>
				</div>
			{:else}
				<span class="text-sm text-foreground-faint">Click "Simulate Provisioning" to see the progress indicator</span>
			{/if}
		</div>
	</section>

	<!-- Inline net load log (as it appears in the worker card) -->
	<section>
		<h2 class="text-lg font-semibold text-foreground mb-3">Inline Net Load Log (within worker card)</h2>
		<div class="border border-border rounded-md bg-card px-4 py-3">
			<div class="flex items-center gap-3 mb-2">
				<span class="font-medium text-foreground text-sm">daily_pipeline</span>
				<span class="text-xs px-2 py-0.5 rounded-full text-white font-medium" style="background: var(--status-provisioning)">Loading...</span>
				<span class="text-xs text-foreground-faint font-mono">petri_nets.daily_pipeline:build_daily_net</span>
			</div>
			<pre
				class="bg-[#1a1a2e] text-[#c8c8d0] p-3 rounded text-xs font-mono max-h-[150px] overflow-y-auto whitespace-pre-wrap break-words m-0"
			>Downloading deployment artifact...
Download complete (2.3 MB)
Extracting code...
Installing dependencies with uv...
Installing polars==1.5.0</pre>
		</div>
	</section>

	<!-- Load error display -->
	<section>
		<h2 class="text-lg font-semibold text-foreground mb-3">Net Load Error Banner</h2>
		<div class="border border-border rounded-md bg-card px-4 py-3">
			<div class="flex items-center gap-3">
				<span class="font-medium text-foreground text-sm">daily_pipeline</span>
				<span class="text-xs px-2 py-0.5 rounded-full text-white font-medium" style="background: var(--status-error)">Error</span>
				<span class="text-xs text-foreground-faint font-mono">petri_nets.daily_pipeline:build_daily_net</span>
			</div>
			<div class="mt-1 text-xs text-error bg-error-bg px-2.5 py-1.5 rounded">
				Failed to import petri_nets.daily_pipeline.build_daily_net: No module named 'polars'
			</div>
		</div>
	</section>

</div>
{/if}

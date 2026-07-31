<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';

	import AppNav from '$lib/components/AppNav.svelte';
	import NotebookErrorsBanner from '$lib/components/NotebookErrorsBanner.svelte';
	import {
		API_URL,
		getNotebook,
		getNotebookTimings,
		loadNotebook,
		unloadNotebook,
		type Notebook,
		type NotebookTimings,
	} from '$lib/api';
	import { serverEventsStore } from '$lib/stores/serverEvents';

	// Human-friendly reasons matching what the worker / control plane
	// stamps on `load_error` when something changes load_state. Keep this
	// shallow — server-side codes are the source of truth, here we just
	// translate for display. Unknown codes fall through as-is.
	const LOAD_ERROR_LABELS: Record<string, string> = {
		idle_eviction: 'evicted after 15 min of inactivity (frees worker RAM)',
		subprocess_dead: 'subprocess unreachable — likely crashed',
		subprocess_gone: 'subprocess is gone (crash, OOM, or worker restart)',
		worker_deleted: 'worker was deleted',
		worker_destroyed: 'worker resource was destroyed',
		worker_stopped: 'worker was stopped',
	};

	function loadErrorLabel(code: string | null | undefined): string | null {
		if (!code) return null;
		return LOAD_ERROR_LABELS[code] ?? code;
	}

	let notebookId = $derived($page.params.id as string);
	let notebook = $state<Notebook | null>(null);
	let initialising = $state(true);
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let timings = $state<NotebookTimings | null>(null);
	let timingsPoll: ReturnType<typeof setTimeout> | null = null;

	// Wall-clock cost of the whole thing, from the user's action to the iframe
	// firing load. The server-side `load` number covers only the spawn call, so
	// on its own it reads as "25s" for something that took well over a minute:
	// a Reload also pays an unload, and the browser then fetches marimo and
	// boots its kernel. Reporting only the component we happen to instrument
	// would keep pointing at the wrong bottleneck.
	let wallClockStart: number | null = null;
	let wallClockMs = $state<number | null>(null);

	function startWallClock() {
		wallClockStart = performance.now();
		wallClockMs = null;
	}

	function stopWallClock() {
		if (wallClockStart === null) return;
		wallClockMs = performance.now() - wallClockStart;
		wallClockStart = null;
	}

	// The backend closes a page-load burst after ~2s of network quiet, so a
	// single fetch on iframe load always reads as still in progress. Poll for a
	// bounded window instead — this is instrumentation and must never become an
	// indefinite background loop.
	//
	// Long enough to outlast a cold marimo start: the chunk fetches can begin
	// well after the iframe's load event on a worker waking from suspend.
	const TIMINGS_POLL_ATTEMPTS = 20;
	const TIMINGS_POLL_INTERVAL_MS = 1500;

	async function refreshTimings(
		attemptsLeft = TIMINGS_POLL_ATTEMPTS,
		sawBurstStart = false,
	) {
		try {
			timings = await getNotebookTimings(notebookId);
		} catch {
			// A timings failure must never surface as a notebook error — the
			// notebook itself is fine, we just have no numbers to show.
			return;
		}
		// Only trust a closed burst once we've actually watched one open. A
		// stray early request (the document fetch, a service-worker probe) goes
		// quiet for 2s and closes a burst of its own; stopping there reported
		// "1 reqs 0.0s" while the real 300-request burst happened afterwards,
		// unobserved.
		const started = sawBurstStart || !!timings?.burst_in_progress;
		const settled = started && timings?.burst && !timings.burst_in_progress;
		if (!settled && attemptsLeft > 1) {
			timingsPoll = setTimeout(
				() => refreshTimings(attemptsLeft - 1, started),
				TIMINGS_POLL_INTERVAL_MS,
			);
		}
	}

	function fmtSeconds(s: number): string {
		return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`;
	}

	// Compact enough to sit in the slim header; the full breakdown lives in the
	// title tooltip so the common case stays glanceable.
	let timingsLabel = $derived.by(() => {
		if (!timings && wallClockMs === null) return null;
		const parts: string[] = [];
		// Total leads: it is what the user waited, and it is the only figure
		// that includes the unload, the asset burst and marimo's own startup.
		if (wallClockMs !== null) parts.push(`${fmtSeconds(wallClockMs / 1000)} total`);
		if (timings?.load) parts.push(`${fmtSeconds(timings.load.total_s)} spawn`);
		if (timings?.burst_in_progress) {
			parts.push('measuring page…');
		} else if (timings?.burst) {
			parts.push(`${timings.burst.count} reqs ${fmtSeconds(timings.burst.wall_s)}`);
		}
		return parts.length ? parts.join(' · ') : null;
	});

	let timingsDetail = $derived.by(() => {
		const lines: string[] = [];
		if (wallClockMs !== null) {
			lines.push(
				`Total: ${(wallClockMs / 1000).toFixed(1)}s — your action to the ` +
					`notebook appearing, including unload, spawn, assets and ` +
					`marimo's own startup.`,
			);
		}
		if (!timings) return lines.join('\n');
		if (timings.load) {
			const phases = Object.entries(timings.load.phases)
				.sort((a, b) => b[1] - a[1])
				.map(([name, seconds]) => `${name}=${seconds.toFixed(1)}s`)
				.join(' ');
			lines.push(`Spawn: ${timings.load.total_s.toFixed(1)}s (${phases})`);
		}
		const b = timings.burst;
		if (b) {
			lines.push(
				`Last page open: ${b.count} requests in ${b.wall_s.toFixed(1)}s`,
				`  p50 ${(b.p50_s * 1000).toFixed(0)}ms · p95 ${(b.p95_s * 1000).toFixed(0)}ms · max ${b.max_s.toFixed(1)}s`,
				`  ${b.queued} queued (max wait ${b.max_queue_wait_s.toFixed(1)}s) · ${b.errors} errors`,
			);
		}
		lines.push(
			'Spawn and page-open are measured on the control plane and reset ' +
				'when it restarts; total is measured in this tab.',
		);
		return lines.join('\n');
	});

	// The iframe src points at the control plane API. The proxy chain
	//   browser -> control plane -> flycast -> worker -> notebook subprocess
	// terminates at Marimo, which was mounted at this same path so its asset
	// URLs (/api/notebooks/{id}/static/...) all resolve through the chain.
	//
	// NB: we deliberately do NOT pass a stable ``?session_id=`` to force
	// Marimo run-mode resume on refresh. That preserved chart history but, in
	// this embedded/proxied setup, resuming an orphaned kernel produced a
	// cell-id mismatch — the frontend flooded "Cell <id> not found in state"
	// and hung on the spinner. A fresh session per load loses the chart's
	// in-memory history (it refills as the net steps) but renders cleanly,
	// which is strictly better than hanging. See tests/integration/
	// test_notebook_refresh for the repro/guard before re-attempting resume.
	let iframeSrc = $derived(notebook?.load_state === 'loaded'
		? `${API_URL}/api/notebooks/${notebookId}/`
		: null);

	onMount(async () => {
		await initialise();
	});

	// React to backend-driven state changes so the badge + reason update
	// without waiting for the user to click anything. Crucial for the
	// idle-eviction case: the worker tells us 15 min after we left the
	// tab idle, and the badge should flip to ``unloaded · evicted...``
	// in place.
	const unsubscribeEvents = serverEventsStore.subscribe((evt) => {
		if (!evt) return;
		if (evt.type !== 'notebook_state_changed') return;
		if (evt.notebook_id !== notebookId) return;
		if (!notebook) return;
		notebook = {
			...notebook,
			load_state: evt.load_state,
			load_error: evt.load_error ?? null,
			worker_id: evt.worker_id ?? notebook.worker_id,
		};
	});

	onDestroy(() => {
		unsubscribeEvents();
		if (timingsPoll) clearTimeout(timingsPoll);
	});

	async function initialise() {
		initialising = true;
		errorMessage = null;
		startWallClock();
		try {
			notebook = await getNotebook(notebookId);
			if (notebook.load_state !== 'loaded') {
				await ensureLoaded();
			}
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
		} finally {
			initialising = false;
		}
	}

	async function ensureLoaded() {
		if (!notebook) return;
		if (!notebook.worker_id) {
			errorMessage = 'Notebook is not assigned to a worker. Pick a worker on the Wiring page first.';
			return;
		}
		busy = true;
		try {
			await loadNotebook(notebookId);
			notebook = await getNotebook(notebookId);
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
		} finally {
			busy = false;
		}
	}

	async function handleReload() {
		if (!notebook) return;
		busy = true;
		errorMessage = null;
		// Starts before the unload: a Reload pays unload + load, and the unload
		// half was 15s in the field.
		startWallClock();
		try {
			if (notebook.load_state === 'loaded') {
				await unloadNotebook(notebookId);
			}
			await loadNotebook(notebookId);
			notebook = await getNotebook(notebookId);
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
		} finally {
			busy = false;
		}
	}

	function statusColor(s: string): string {
		switch (s) {
			case 'loaded':
				return '#22c55e';
			case 'loading':
				return '#eab308';
			case 'error':
				return '#ef4444';
			default:
				return '#9ca3af';
		}
	}
</script>

<svelte:head>
	<title>
		{notebook ? `${notebook.instance_name} · Notebook` : 'Notebook'}
	</title>
</svelte:head>

<AppNav title={notebook ? `Notebook · ${notebook.instance_name}` : 'Notebook'} />

<!-- Slim notebook header -->
<div class="flex items-center justify-between px-6 py-2 border-b border-border bg-card text-sm">
	<div class="flex items-center gap-3 min-w-0">
		<a class="text-accent hover:underline" href="/wiring">← Wiring</a>
		{#if notebook}
			<span class="text-foreground-muted">/</span>
			<span class="font-medium text-foreground truncate">{notebook.instance_name}</span>
			<span class="text-foreground-muted text-xs font-mono">({notebook.definition_name})</span>
			<span
				class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
				style="background: {statusColor(notebook.load_state)}"
			>
				{notebook.load_state}
			</span>
			{#if notebook.load_state !== 'loaded' && loadErrorLabel(notebook.load_error)}
				<span
					class="text-foreground-muted text-xs"
					title="Click Reload to restart the subprocess. Your bindings are preserved."
				>
					· {loadErrorLabel(notebook.load_error)}
				</span>
			{/if}
			{#if notebook.bindings.length > 0}
				<span class="text-foreground-muted text-xs">
					· {notebook.bindings.length} binding{notebook.bindings.length === 1 ? '' : 's'}
				</span>
			{/if}
			{#if timingsLabel}
				<span
					class="text-foreground-muted text-xs font-mono whitespace-nowrap"
					title={timingsDetail}
				>
					· {timingsLabel}
				</span>
			{/if}
		{/if}
	</div>
	<div class="flex items-center gap-2">
		{#if notebook}
			<button
				class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
				onclick={handleReload}
				disabled={busy}
			>
				{busy ? 'Working…' : 'Reload'}
			</button>
		{/if}
	</div>
</div>

<NotebookErrorsBanner {notebookId} />

{#if initialising}
	<div class="flex items-center justify-center h-[calc(100vh-104px)] text-foreground-muted">
		Initialising notebook…
	</div>
{:else if errorMessage}
	<div class="m-6 p-4 border border-red-500 rounded bg-red-50 text-red-700 text-sm">
		<p class="font-medium mb-2">Could not open notebook</p>
		<p>{errorMessage}</p>
		<button
			class="mt-3 px-3 py-1.5 border border-red-500 rounded bg-card text-red-500 text-xs font-medium hover:bg-red-500 hover:text-white"
			onclick={initialise}
		>
			Retry
		</button>
	</div>
{:else if notebook && notebook.load_state === 'loaded' && iframeSrc}
	<!-- Full-viewport iframe under the slim header -->
	<!-- onload fires once Marimo's document is in; the asset burst is still
	     settling at that point, which is why refreshTimings polls. -->
	<iframe
		src={iframeSrc}
		title={notebook.instance_name}
		class="w-full h-[calc(100vh-104px)] border-0 block"
		onload={() => {
			stopWallClock();
			refreshTimings();
		}}
	></iframe>
{:else if notebook && notebook.load_state === 'loading'}
	<div class="flex items-center justify-center h-[calc(100vh-104px)] text-foreground-muted">
		Loading notebook on worker…
	</div>
{:else if notebook}
	<!-- Not loaded yet — either failed silently or no worker -->
	<div class="m-6 p-4 border border-border rounded bg-card text-sm">
		<p class="text-foreground">Notebook is not loaded.</p>
		<p class="text-foreground-muted text-xs mt-1">
			Load state: <code>{notebook.load_state}</code>
			{#if notebook.load_error}
				· error: <code>{notebook.load_error}</code>
			{/if}
		</p>
		<button
			class="mt-3 px-3 py-1.5 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
			onclick={ensureLoaded}
			disabled={busy}
		>
			{busy ? 'Loading…' : 'Load on assigned worker'}
		</button>
	</div>
{/if}

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';

	import AppNav from '$lib/components/AppNav.svelte';
	import NotebookErrorsBanner from '$lib/components/NotebookErrorsBanner.svelte';
	import {
		API_URL,
		getNotebook,
		loadNotebook,
		unloadNotebook,
		type Notebook,
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

	onDestroy(unsubscribeEvents);

	async function initialise() {
		initialising = true;
		errorMessage = null;
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
	<iframe
		src={iframeSrc}
		title={notebook.instance_name}
		class="w-full h-[calc(100vh-104px)] border-0 block"
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

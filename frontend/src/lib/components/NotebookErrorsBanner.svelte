<!--
	Surfaces Python tracebacks captured from the notebook's Marimo
	subprocess. Each row is one "bug" (deduplicated by exception type +
	frame stack on the backend); identical bugs increment a counter
	rather than spawning a new row. Persistent across notebook reloads
	until the user dismisses, so the user can see a now-working notebook
	that *was* failing.

	Subscribes to the global SSE stream and re-fetches on
	``notebook_error`` events scoped to this notebook id. Initial fetch
	on mount.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		listNotebookErrors,
		dismissNotebookErrors,
		type NotebookError,
	} from '$lib/api';
	import { serverEventsStore } from '$lib/stores/serverEvents';

	let { notebookId }: { notebookId: string } = $props();

	let errors = $state<NotebookError[]>([]);
	let dismissing = $state(false);
	let expandedIds = $state<Set<string>>(new Set());

	async function refresh() {
		try {
			errors = await listNotebookErrors(notebookId);
		} catch {
			// Don't bury the iframe behind a banner error; silently skip.
			// The user will see the next successful refresh.
		}
	}

	onMount(refresh);

	const unsubscribe = serverEventsStore.subscribe((evt) => {
		if (!evt) return;
		if (evt.type !== 'notebook_error') return;
		if (evt.notebook_id !== notebookId) return;
		refresh();
	});

	onDestroy(unsubscribe);

	async function handleDismissAll() {
		dismissing = true;
		try {
			await dismissNotebookErrors(notebookId);
			errors = [];
			expandedIds = new Set();
		} catch {
			// best effort
		} finally {
			dismissing = false;
		}
	}

	function toggleExpand(id: string) {
		const next = new Set(expandedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedIds = next;
	}

	function formatTime(iso: string): string {
		try {
			return new Date(iso).toLocaleTimeString();
		} catch {
			return iso;
		}
	}
</script>

{#if errors.length > 0}
	<div
		role="alert"
		class="mx-6 mt-3 mb-2 border border-red-500 rounded bg-red-50 dark:bg-red-950/30 text-red-900 dark:text-red-200 text-sm overflow-hidden"
	>
		<div class="flex items-center justify-between px-4 py-2 border-b border-red-500/60">
			<div class="font-medium">
				⚠ {errors.length} error group{errors.length === 1 ? '' : 's'} reported by the notebook
			</div>
			<button
				class="px-2.5 py-1 border border-red-500 rounded text-xs font-medium hover:bg-red-500 hover:text-white disabled:opacity-50"
				onclick={handleDismissAll}
				disabled={dismissing}
			>
				{dismissing ? 'Dismissing…' : 'Dismiss all'}
			</button>
		</div>
		<ul class="divide-y divide-red-500/30">
			{#each errors as err (err.id)}
				{@const expanded = expandedIds.has(err.id)}
				<li class="px-4 py-2">
					<button
						class="w-full text-left flex items-start gap-3"
						onclick={() => toggleExpand(err.id)}
						aria-expanded={expanded}
					>
						<span class="font-mono text-xs mt-0.5 select-none">{expanded ? '▼' : '▶'}</span>
						<div class="flex-1 min-w-0">
							<div class="font-medium">
								<span class="font-mono">{err.exception_type}</span>
								{#if err.top_frame_location}
									<span class="text-red-700 dark:text-red-300">
										in <span class="font-mono">{err.top_frame_location}</span>
									</span>
								{/if}
								<span class="ml-2 text-xs">
									· {err.occurrence_count}×
								</span>
							</div>
							<div class="text-xs text-red-800 dark:text-red-300 mt-0.5">
								Last seen {formatTime(err.last_seen_at)}
								{#if err.occurrence_count > 1}
									· first seen {formatTime(err.first_seen_at)}
								{/if}
							</div>
							{#if err.latest_message}
								<div class="mt-1 font-mono text-xs whitespace-pre-wrap break-words">
									{err.latest_message}
								</div>
							{/if}
						</div>
					</button>
					{#if expanded}
						<pre
							class="mt-2 ml-6 max-h-96 overflow-auto rounded bg-red-100 dark:bg-red-950/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-words"
						>{err.latest_traceback}</pre>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}

<!--
	Renders one of four states for a data list:

	1. Error      — request threw; show the error message in red.
	2. Loading    — first fetch hasn't returned yet; show a spinner.
	                If the fetch has been pending for longer than
	                ``slowAfterMs`` (default 5s) a friendlier nudge
	                appears alongside.
	3. Empty      — fetch returned, list is empty. Either the
	                provided ``empty`` snippet or a centered
	                ``emptyMessage`` paragraph renders.
	4. Loaded     — anything else: render ``children``.

	The whole point of this component is to stop pages from rendering
	the empty state during the loading window. Initialising an array
	state as ``[]`` makes "haven't fetched yet" and "fetched, was empty"
	look identical to the UI; this component takes a separate
	``loading`` boolean so the caller can distinguish them cleanly.

	Usage:

	```svelte
	<DataLoadState
		loading={!loaded}
		error={errorMessage}
		isEmpty={items.length === 0}
		emptyMessage="No items yet."
	>
		{#each items as item} ... {/each}
	</DataLoadState>
	```

	For per-page empty-state markup (titles, links, tips) pass a snippet:

	```svelte
	<DataLoadState loading={!loaded} isEmpty={items.length === 0}>
		{#snippet empty()}
			<h2>No nets found</h2>
			<p>Deploy your code to create nets. <a href="...">...</a></p>
		{/snippet}
		{#each items as item} ... {/each}
	</DataLoadState>
	```
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		loading,
		error = null,
		isEmpty,
		loadingMessage = 'Loading…',
		emptyMessage = 'No items yet.',
		slowAfterMs = 5000,
		slowMessage = 'Still loading — the server is slow right now.',
		empty,
		children,
	}: {
		loading: boolean;
		error?: string | null;
		isEmpty: boolean;
		loadingMessage?: string;
		emptyMessage?: string;
		slowAfterMs?: number;
		slowMessage?: string;
		empty?: Snippet;
		children: Snippet;
	} = $props();

	// True once the loading window has lasted longer than slowAfterMs.
	// The effect resets to false as soon as ``loading`` flips off so a
	// subsequent refresh doesn't immediately re-show the nudge.
	let slow = $state(false);
	$effect(() => {
		if (!loading) {
			slow = false;
			return;
		}
		slow = false;
		const t = setTimeout(() => {
			slow = true;
		}, slowAfterMs);
		return () => clearTimeout(t);
	});
</script>

{#if error}
	<div class="m-4 p-4 border border-red-500 rounded bg-red-50 text-red-700 text-sm">
		<strong>Could not load:</strong> {error}
	</div>
{:else if loading}
	<div class="flex flex-col items-center gap-2 text-foreground-muted p-8">
		<div class="flex items-center gap-2">
			<span
				class="inline-block w-3 h-3 rounded-full border-2 border-foreground-muted border-t-transparent animate-spin"
				aria-hidden="true"
			></span>
			<span class="text-sm">{loadingMessage}</span>
		</div>
		{#if slow}
			<p class="text-xs text-amber-500">{slowMessage}</p>
		{/if}
	</div>
{:else if isEmpty}
	{#if empty}
		{@render empty()}
	{:else}
		<p class="text-center text-foreground-muted p-4">{emptyMessage}</p>
	{/if}
{:else}
	{@render children()}
{/if}

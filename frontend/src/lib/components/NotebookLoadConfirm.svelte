<script lang="ts">
	/**
	 * Shown instead of loading, when loading would add a second notebook.
	 *
	 * Opening a notebook page loads it automatically, so ~190MB can be spent by
	 * following a link. Where the worker is already running another notebook,
	 * that spend gets a decision attached to it — with the numbers, because
	 * "this will add memory pressure" tells nobody anything.
	 *
	 * "Open the running one" is here on purpose: most of the time the user
	 * wanted the notebook rather than a second copy of it, and a link is a
	 * better answer than a refusal.
	 */
	import type { AdditionalNotebookRefusal } from '$lib/api';

	interface Props {
		refusal: AdditionalNotebookRefusal;
		busy?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let { refusal, busy = false, onconfirm, oncancel }: Props = $props();

	let capacity = $derived(refusal.occupancy?.memory?.container_total_mb ?? null);
	let available = $derived(refusal.occupancy?.memory?.container_available_mb ?? null);
	let used = $derived(
		capacity !== null && available !== null ? Math.round(capacity - available) : null,
	);
	// `fits === null` means the worker could not be reached. Not the same as
	// "no", and very much not the same as "yes".
	let tight = $derived(refusal.fits === false);
	let unknown = $derived(refusal.fits === null);

	function label(nb: { instance_name?: string | null; definition_name: string | null }): string {
		return nb.instance_name || nb.definition_name || 'unnamed notebook';
	}
</script>

<div class="max-w-2xl mx-auto mt-12 px-6">
	<h2 class="text-lg font-medium">This worker is already running another notebook</h2>
	<p class="mt-2 text-sm text-foreground-muted">
		Notebooks are the largest processes on a worker. Starting another is fine
		if there is room for it — here is what is running now.
	</p>

	<div class="mt-5 border border-border rounded overflow-hidden text-sm">
		{#each refusal.other_notebooks as nb (nb.notebook_id)}
			<div class="flex justify-between px-3 py-2 border-b border-border last:border-b-0">
				<span>{label(nb)}</span>
				<span class="text-foreground-muted tabular-nums">{Math.round(nb.rss_mb)} MB</span>
			</div>
		{/each}
		{#if used !== null && capacity !== null}
			<div class="flex justify-between px-3 py-2 bg-muted/40">
				<span class="text-foreground-muted">Worker memory</span>
				<span class="tabular-nums">
					{used} / {Math.round(capacity)} MB · {Math.round(available ?? 0)} MB free
				</span>
			</div>
		{/if}
	</div>

	<p class="mt-3 text-sm {tight ? 'text-amber-400' : 'text-foreground-muted'}">
		{#if unknown}
			The worker could not be reached for a memory reading, so there is no way
			to tell whether another notebook fits.
		{:else if tight}
			⚠ Starting another is expected to use about {Math.round(refusal.estimated_cost_mb)} MB,
			which is more than this worker has left. If it runs out of memory a
			notebook is stopped first — but you may lose this one.
		{:else}
			Starting another is expected to use about {Math.round(refusal.estimated_cost_mb)} MB,
			leaving roughly {refusal.predicted_free_mb} MB free.
		{/if}
		{#if refusal.estimate_source === 'default'}
			<span class="block mt-1 text-xs">
				That figure is a default — nothing comparable is running to measure.
			</span>
		{/if}
	</p>

	<div class="mt-6 flex flex-wrap gap-2">
		<button
			type="button"
			class="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors disabled:opacity-50"
			disabled={busy}
			onclick={onconfirm}
		>
			{busy ? 'Starting…' : 'Start another instance'}
		</button>
		<button
			type="button"
			class="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
			onclick={oncancel}
		>
			Cancel
		</button>
	</div>

	{#if refusal.other_notebooks.length > 0}
		<p class="mt-4 text-xs text-foreground-muted">
			Already running:
			{#each refusal.other_notebooks as nb, i (nb.notebook_id)}
				<a class="underline hover:no-underline" href="/notebooks/{nb.notebook_id}">
					{label(nb)}
				</a>{i < refusal.other_notebooks.length - 1 ? ', ' : ''}
			{/each}
		</p>
	{/if}
</div>

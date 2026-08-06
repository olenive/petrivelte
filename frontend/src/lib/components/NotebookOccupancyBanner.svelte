<script lang="ts">
	/**
	 * States what else is running on this worker, and what it costs.
	 *
	 * Several instances of a notebook is a legitimate thing to want — different
	 * bindings, different views, two people looking — so this informs rather
	 * than objects. What it must not do is stay quiet: a notebook subprocess is
	 * about 190MB, the largest process on a worker, and on the default 512MB
	 * machine the second one is what gets something OOM-killed.
	 *
	 * Dismissal is per tab (sessionStorage): a warning that can be dismissed
	 * permanently is a warning that does not exist.
	 */
	import type { WorkerOccupancy } from '$lib/api';
	import {
		dismissalKey,
		occupancyLevel,
		occupancySummary,
		shouldWarn,
	} from '$lib/notebookOccupancy';

	interface Props {
		occupancy: WorkerOccupancy | null;
		notebookId: string;
		definitionName: string | null | undefined;
	}

	let { occupancy, notebookId, definitionName }: Props = $props();

	let dismissed = $state(readDismissed());

	function readDismissed(): boolean {
		if (typeof sessionStorage === 'undefined') return false;
		try {
			return sessionStorage.getItem(dismissalKey(notebookId)) === '1';
		} catch {
			// Private mode, or storage disabled. Showing the banner is the safe
			// side of this failure.
			return false;
		}
	}

	function dismiss() {
		dismissed = true;
		try {
			sessionStorage?.setItem(dismissalKey(notebookId), '1');
		} catch {
			// Nothing to do — it stays dismissed for this page's lifetime.
		}
	}

	let summary = $derived(occupancySummary(occupancy, notebookId, definitionName));
	let level = $derived(occupancyLevel(occupancy, definitionName));
	let visible = $derived(!dismissed && shouldWarn(occupancy) && summary !== null);
</script>

{#if visible}
	<div
		class="flex items-start gap-3 px-4 py-2 text-xs border-b {level === 'tight'
			? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
			: 'bg-muted/40 border-border text-foreground-muted'}"
		role="status"
	>
		<span class="mt-px" aria-hidden="true">{level === 'tight' ? '⚠' : 'ⓘ'}</span>
		<div class="flex-1 leading-relaxed">
			<span>{summary}</span>
			{#if level === 'tight'}
				<span class="block mt-0.5">
					This worker is close to its memory limit. If it runs out, a notebook
					is stopped first — nets and the worker itself are kept.
				</span>
			{/if}
		</div>
		<button
			type="button"
			class="shrink-0 px-2 py-0.5 rounded hover:bg-foreground/10 transition-colors"
			onclick={dismiss}
		>
			Dismiss
		</button>
	</div>
{/if}

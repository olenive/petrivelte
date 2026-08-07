<script lang="ts">
	/**
	 * Warns that a notebook will not run properly, before it is asked to.
	 *
	 * Not dismissible, and not styled as advice: unlike the occupancy banner —
	 * which reports a cost the user may legitimately choose to pay — this
	 * reports a defect with no upside. The notebook will load, serve and look
	 * healthy while some of its cells never execute.
	 *
	 * It shows marimo's own message and every line involved, because the
	 * runtime alternative is a `NameError` at a line that is not the problem
	 * plus "an internal error occurred".
	 */
	import type { NotebookDefect } from '$lib/api';
	import { defectSummary, describeLines } from '$lib/notebookDefects';

	interface Props {
		defects: NotebookDefect[];
		/** Shown so the reader knows which file to open. */
		definitionName?: string | null;
		compact?: boolean;
	}

	let { defects, definitionName = null, compact = false }: Props = $props();
</script>

{#if defects.length > 0}
	<div
		class="rounded border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 {compact
			? 'mt-1 p-2 text-[11px]'
			: 'mt-2 p-3 text-xs'}"
		role="status"
	>
		<div class="flex items-start gap-2">
			<span aria-hidden="true">⚠</span>
			<div class="min-w-0">
				<p class="font-medium">
					{defectSummary(defects)}
				</p>
				<ul class="mt-1 space-y-1">
					{#each defects as defect}
						<li>
							<span class="font-mono text-[11px]">{defect.name}</span>
							— {defect.message}
							{#if describeLines(defect)}
								<span class="opacity-80">({describeLines(defect)})</span>
							{/if}
							{#if defect.fix}
								<div class="opacity-80">{defect.fix}</div>
							{/if}
						</li>
					{/each}
				</ul>
				{#if definitionName}
					<p class="mt-1 opacity-80">
						Fix it in <span class="font-mono">{definitionName}</span>, push, and
						rebuild. Until then the notebook will start and look healthy, but
						the affected cells and everything downstream of them will not run.
					</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

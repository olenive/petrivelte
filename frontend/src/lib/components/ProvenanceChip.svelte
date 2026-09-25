<script lang="ts">
	/**
	 * Which code an instance runs: a small chip with the short commit and the
	 * deployment date, and a marker naming the newer commit when there is one.
	 * The words come from `$lib/provenance`; this file is layout.
	 */
	import type { DeploymentSummary } from '$lib/api';
	import { newerMarker, provenanceChip } from '$lib/provenance';

	interface Props {
		deployment: DeploymentSummary | null | undefined;
		newer?: DeploymentSummary | null | undefined;
	}

	let { deployment, newer = undefined }: Props = $props();

	let chip = $derived(provenanceChip(deployment));
	let marker = $derived(newerMarker(newer));
</script>

{#if chip}
	<span
		class="text-[11px] px-1.5 py-0.5 rounded border border-border text-foreground-muted font-mono whitespace-nowrap"
		title={chip.title}
	>
		{chip.text}
	</span>
{/if}
{#if marker}
	<span
		class="text-[11px] px-1.5 py-0.5 rounded border border-status-info text-status-info whitespace-nowrap"
		title={marker.title}
	>
		{marker.text}
	</span>
{/if}

<script lang="ts">
	import { placeShowsCounter } from '$lib/netHelpers';

	export let name: string;
	export let x: number;
	export let y: number;
	export let type_name: string;
	/** The place's true count (protocol §5.3), not its capped token list. */
	export let count: number = 0;
	/** Under a token filter, `2 of 5`: how many of its tokens are drawn. */
	export let matching: string | null = null;

	$: showCount = matching === null && placeShowsCounter(count);
</script>

<g class="place-text" data-place-id={name} data-count={count} data-matching={matching ?? undefined}>
	<!-- Scrim, drawn first so everything below sits on top of it. Veils the
	     dots toward the centre so the labels and count read cleanly, while the
	     outer dots stay visible through its transparent edge — no hard boundary
	     between "counting dots" and "reading the number". -->
	{#if showCount}
		<circle cx={x} cy={y} r={24} fill="url(#token-count-scrim)" />
	{/if}
	<!-- Title with stroke outline - inside upper portion of circle -->
	<text x={x} y={y - 15} text-anchor="middle" font-size="12" font-weight="bold" stroke="var(--place-fill)" stroke-width="3" fill="none">
		{name}
	</text>
	<text x={x} y={y - 15} text-anchor="middle" font-size="12" font-weight="bold" fill="var(--place-text)">
		{name}
	</text>
	<!-- Type name with stroke outline - below title, above tokens -->
	<text x={x} y={y - 3} text-anchor="middle" font-size="10" stroke="var(--place-fill)" stroke-width="3" fill="none">
		{type_name}
	</text>
	<text x={x} y={y - 3} text-anchor="middle" font-size="10" fill="var(--text-secondary)">
		{type_name}
	</text>
	<!-- Token count, below the type label, once the cluster stops being
	     countable by eye. The dots stay — this says how many there are. -->
	{#if showCount}
		<text x={x} y={y + 14} text-anchor="middle" font-size="15" font-weight="bold" fill="var(--place-text)">
			{count}
		</text>
	{/if}
	<!-- Under a token filter: how many of the place's tokens match. -->
	{#if matching !== null}
		<text x={x} y={y + 44} text-anchor="middle" font-size="11" font-weight="bold" stroke="var(--graph-bg)" stroke-width="3" fill="none">
			{matching}
		</text>
		<text x={x} y={y + 44} text-anchor="middle" font-size="11" font-weight="bold" fill="var(--place-text)">
			{matching}
		</text>
	{/if}
</g>

<style>
	.place-text {
		pointer-events: none; /* Let clicks pass through to circle below */
	}
</style>

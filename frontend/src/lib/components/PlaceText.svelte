<script lang="ts">
	import { placeShowsCount, placeTokenCount } from '$lib/netHelpers';

	export let id: string;
	export let name: string;
	export let x: number;
	export let y: number;
	export let type_name: string;
	// Spread in from the place. `tokens` is a capped sample, so the count comes
	// from `token_count` — see placeTokenCount.
	export let tokens: unknown[] | undefined = undefined;
	export let token_count: number | undefined = undefined;

	$: count = placeTokenCount({ tokens, token_count });
	$: showCount = placeShowsCount({ tokens, token_count });
</script>

<g class="place-text" data-place-id={id}>
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
	<!-- Token count, shown in place of the dots once they stop being
	     countable. Sits where the dot cluster would have been. -->
	{#if showCount}
		<text x={x} y={y + 14} text-anchor="middle" font-size="14" font-weight="bold" stroke="var(--place-fill)" stroke-width="3" fill="none">
			{count}
		</text>
		<text x={x} y={y + 14} text-anchor="middle" font-size="14" font-weight="bold" fill="var(--place-text)">
			{count}
		</text>
	{/if}
</g>

<style>
	.place-text {
		pointer-events: none; /* Let clicks pass through to circle below */
	}
</style>

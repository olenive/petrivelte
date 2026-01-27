<script lang="ts">
	export let id: string;
	export let name: string;
	export let x: number;
	export let y: number;
	export let type_name: string;
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
</g>

<style>
	.place-text {
		pointer-events: none; /* Let clicks pass through to circle below */
	}
</style>

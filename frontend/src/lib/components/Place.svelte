<script lang="ts">
	export let name: string;
	export let x: number;
	export let y: number;
	export let type_name: string;

	const radius = 30;
</script>

<g class="place" data-place-id={name}>
	<circle cx={x} cy={y} r={radius} fill="var(--place-fill)" stroke="var(--place-stroke)" stroke-width="2" />
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
	.place {
		cursor: pointer;
	}

	.place:hover circle {
		stroke: var(--button-border);
		stroke-width: 3;
	}
</style>

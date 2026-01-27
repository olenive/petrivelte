<script lang="ts">
	export let id: string;
	export let name: string;
	export let x: number;
	export let y: number;
	export let type_name: string;

	const radius = 30;
</script>

<g class="place" data-place-id={id}>
	<circle cx={x} cy={y} r={radius} fill="var(--place-fill)" stroke="var(--place-stroke)" stroke-width="2" />
	<text x={x} y={y - radius - 8} text-anchor="middle" font-size="12" font-weight="bold" fill="var(--place-text)">
		{name}
	</text>
	<text x={x} y={y} text-anchor="middle" font-size="10" fill="var(--text-secondary)">
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

<script lang="ts">
	export let id: string;
	export let x: number;
	export let y: number;

	const radius = 30;
</script>

<g class="place-circle" data-place-id={id}>
	<circle cx={x} cy={y} r={radius} fill="var(--place-fill)" stroke="var(--place-stroke)" stroke-width="2" />
</g>

<style>
	.place-circle {
		cursor: pointer;
	}

	.place-circle:hover circle {
		stroke: var(--button-border);
		stroke-width: 3;
	}
</style>

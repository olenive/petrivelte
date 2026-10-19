<script lang="ts">
	export let name: string;
	export let x: number;
	export let y: number;
	/** The colour its style fills it with (protocol §5.1); the theme's fill when absent. */
	export let fill: string | undefined = undefined;

	const radius = 30;
</script>

<!-- The fill is the `--place-fill` variable, so a styled place sets it here
     and its circle follows. -->
<g class="place-circle" data-place-id={name} data-fill={fill} style:--place-fill={fill}>
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

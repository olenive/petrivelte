<script lang="ts">
	export let name: string;
	export let x: number;
	export let y: number;
	/** The colour its style fills it with (protocol §5.1); the theme's fill when absent. */
	export let fill: string | undefined = undefined;
	/** The legend's row for a control acting on it is under the pointer. */
	export let hovered: boolean = false;

	const radius = 30;
</script>

<!-- The fill is the `--place-fill` variable, so a styled place sets it here
     and its circle follows. -->
<g class="place-circle" data-place-id={name} data-fill={fill} data-hover={hovered ? 'true' : undefined} style:--place-fill={fill}>
	<circle cx={x} cy={y} r={radius} fill="var(--place-fill)" stroke="var(--place-stroke)" stroke-width="2" />
</g>

<style>
	.place-circle {
		cursor: pointer;
	}

	.place-circle:hover circle,
	.place-circle[data-hover] circle {
		stroke: var(--button-border);
		stroke-width: 3;
	}
</style>

<script lang="ts">
	export let id: string;
	export let name: string;
	export let x: number;
	export let y: number;
	export let function_name: string;
	export let isFiring: boolean = false;

	const width = 60;
	const height = 12;
</script>

<g class="transition" class:firing={isFiring} data-transition-id={id}>
	<rect
		x={x - width / 2}
		y={y - height / 2}
		width={width}
		height={height}
		fill="var(--transition-fill)"
		stroke="var(--transition-stroke)"
		stroke-width="3"
		class:firing-rect={isFiring}
	/>
	<text x={x} y={y - height / 2 - 8} text-anchor="middle" font-size="12" font-weight="bold" fill="var(--transition-text)">
		{name}
	</text>
	<text x={x} y={y + height / 2 + 18} text-anchor="middle" font-size="9" fill="var(--text-secondary)">
		{function_name}
	</text>
</g>

<style>
	.transition {
		cursor: pointer;
	}

	.transition:hover rect {
		fill: #0066cc;
	}

	.firing-rect {
		fill: #90EE90 !important;
		stroke: #00ff00;
		stroke-width: 3;
	}
</style>

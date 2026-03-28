<script lang="ts">
	export let id: string;
	export let name: string;
	export let x: number;
	export let y: number;
	export let function_name: string;
	export let isFiring: boolean = false;
	export let isSelected: boolean = false;
	export let onSelect: ((id: string) => void) | null = null;

	const width = 80;
	const height = 50;

	function handleClick(event: MouseEvent) {
		event.stopPropagation();
		if (onSelect) onSelect(id);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<g class="transition" class:firing={isFiring} class:selected={isSelected} data-transition-id={id} on:click={handleClick}>
	<rect
		x={x - width / 2}
		y={y - height / 2}
		width={width}
		height={height}
		fill="var(--transition-fill)"
		stroke="var(--transition-stroke)"
		stroke-width="3"
		class:firing-rect={isFiring}
		class:selected-rect={isSelected}
	/>
	<!-- Title with stroke outline -->
	<text x={x} y={y - 10} text-anchor="middle" font-size="12" font-weight="bold" stroke="var(--transition-fill)" stroke-width="3" fill="none">
		{name}
	</text>
	<text x={x} y={y - 10} text-anchor="middle" font-size="12" font-weight="bold" fill="var(--transition-text)">
		{name}
	</text>
	<!-- Function name with stroke outline -->
	<text x={x} y={y + 12} text-anchor="middle" font-size="9" stroke="var(--transition-fill)" stroke-width="3" fill="none">
		{function_name}
	</text>
	<text x={x} y={y + 12} text-anchor="middle" font-size="9" fill="var(--text-secondary)">
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

	.selected-rect {
		stroke: #3b82f6;
		stroke-width: 3;
		filter: drop-shadow(0 0 6px rgba(59, 130, 246, 0.5));
	}
</style>

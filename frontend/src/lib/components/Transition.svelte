<script lang="ts">
	import type { TransitionLook } from '$lib/netView';

	export let name: string;
	export let x: number;
	export let y: number;
	/** A second line under the name, when the runtime gives one. */
	export let subtitle: string = '';
	/** From the transition's state: switched off, running, able to fire. */
	export let look: TransitionLook = 'idle';
	/** Tokens are travelling to or from it now. */
	export let isFiring: boolean = false;
	/** Its body just failed. */
	export let isFailing: boolean = false;
	export let isSelected: boolean = false;
	/** The legend's row for a control acting on it is under the pointer. */
	export let hovered: boolean = false;
	export let onSelect: ((name: string) => void) | null = null;

	const width = 80;
	const height = 50;

	function handleClick(event: MouseEvent) {
		event.stopPropagation();
		if (onSelect) onSelect(name);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<g
	class="transition"
	class:firing={isFiring}
	class:selected={isSelected}
	data-transition-id={name}
	data-look={look}
	data-failing={isFailing ? 'true' : undefined}
	data-hover={hovered ? 'true' : undefined}
	on:click={handleClick}
>
	<rect
		x={x - width / 2}
		y={y - height / 2}
		width={width}
		height={height}
		fill="var(--transition-fill)"
		stroke="var(--transition-stroke)"
		stroke-width="3"
		class:disabled-rect={look === 'disabled'}
		class:fireable-rect={look === 'fireable'}
		class:in-flight-rect={look === 'in_flight'}
		class:firing-rect={isFiring}
		class:failing-rect={isFailing}
		class:selected-rect={isSelected}
	/>
	<!-- Title with stroke outline -->
	<text x={x} y={subtitle ? y - 10 : y + 4} text-anchor="middle" font-size="12" font-weight="bold" stroke="var(--transition-fill)" stroke-width="3" fill="none">
		{name}
	</text>
	<text x={x} y={subtitle ? y - 10 : y + 4} text-anchor="middle" font-size="12" font-weight="bold" fill="var(--transition-text)" class:disabled-text={look === 'disabled'}>
		{name}
	</text>
	{#if subtitle}
		<text x={x} y={y + 12} text-anchor="middle" font-size="9" stroke="var(--transition-fill)" stroke-width="3" fill="none">
			{subtitle}
		</text>
		<text x={x} y={y + 12} text-anchor="middle" font-size="9" fill="var(--text-secondary)">
			{subtitle}
		</text>
	{/if}
</g>

<style>
	.transition {
		cursor: pointer;
	}

	.transition:hover rect,
	.transition[data-hover] rect {
		fill: #0066cc;
	}

	.disabled-rect {
		stroke: #9ca3af;
		stroke-dasharray: 6 4;
		fill: var(--bg-tertiary, #e5e7eb);
	}

	.disabled-text {
		fill: #9ca3af;
	}

	.fireable-rect {
		stroke: #22c55e;
		stroke-width: 4;
	}

	.in-flight-rect {
		stroke: #f59e0b;
		stroke-width: 4;
		animation: in-flight 1s ease-in-out infinite alternate;
	}

	@keyframes in-flight {
		from { stroke-opacity: 1; }
		to { stroke-opacity: 0.4; }
	}

	.firing-rect {
		fill: #90EE90 !important;
		stroke: #00ff00;
		stroke-width: 3;
	}

	.failing-rect {
		fill: #fca5a5 !important;
		stroke: #ef4444 !important;
		stroke-width: 4;
	}

	.selected-rect {
		stroke: #3b82f6;
		stroke-width: 3;
		filter: drop-shadow(0 0 6px rgba(59, 130, 246, 0.5));
	}
</style>

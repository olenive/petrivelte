<script lang="ts">
	import { tweened } from 'svelte/motion';
	import { cubicInOut } from 'svelte/easing';

	export let id: string;
	export let x: number;
	export let y: number;
	export let color: string;
	export let animating = false;
	export let isSelected = false;
	export let onSelect: ((id: string) => void) | null = null;

	const tweenedX = tweened(x, { duration: 500, easing: cubicInOut });
	const tweenedY = tweened(y, { duration: 500, easing: cubicInOut });

	$: if (animating) {
		tweenedX.set(x);
		tweenedY.set(y);
	} else {
		tweenedX.set(x, { duration: 0 });
		tweenedY.set(y, { duration: 0 });
	}

	function handleClick(event: MouseEvent) {
		event.stopPropagation();
		if (onSelect) {
			onSelect(id);
		}
	}
</script>

<circle
	cx={$tweenedX}
	cy={$tweenedY}
	r={8}
	fill={color}
	stroke={isSelected ? 'var(--token-selection-color)' : 'var(--token-stroke)'}
	stroke-width={isSelected ? 3 : 2}
	class="token"
	class:animating
	class:selected={isSelected}
	data-token-id={id}
	on:click={handleClick}
	role="button"
	tabindex="0"
	on:keydown={(e) => e.key === 'Enter' && handleClick(e as unknown as MouseEvent)}
/>

<style>
	.token {
		cursor: pointer;
	}

	.token:hover {
		stroke-width: 3;
	}

	.token.animating {
		filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.8));
	}

	.token.selected {
		filter: drop-shadow(0 0 6px var(--token-selection-glow));
	}

	.token.selected.animating {
		filter: drop-shadow(0 0 6px var(--token-selection-glow)) drop-shadow(0 0 4px rgba(255, 255, 255, 0.8));
	}
</style>

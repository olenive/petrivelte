<script lang="ts">
	import { tweened } from 'svelte/motion';
	import { cubicInOut } from 'svelte/easing';
	import { onMount } from 'svelte';

	export let id: string;
	export let x: number | undefined = undefined;
	export let y: number | undefined = undefined;
	export let startX: number | undefined = undefined;
	export let startY: number | undefined = undefined;
	export let targetX: number;
	export let targetY: number;
	export let color: string;
	export let duration: number = 250;
	export let fadeOut: boolean = false; // true = fade out as it moves, false = fade in

	// Determine starting position
	const initialX = startX !== undefined ? startX : (x !== undefined ? x : targetX);
	const initialY = startY !== undefined ? startY : (y !== undefined ? y : targetY);

	// Create tweened stores for position and opacity
	const tweenedX = tweened(initialX, { duration, easing: cubicInOut });
	const tweenedY = tweened(initialY, { duration, easing: cubicInOut });
	const tweenedOpacity = tweened(fadeOut ? 1 : 0, { duration, easing: cubicInOut });

	// Start animation when component mounts
	onMount(() => {
		tweenedX.set(targetX);
		tweenedY.set(targetY);
		tweenedOpacity.set(fadeOut ? 0 : 1);
	});
</script>

<circle
	cx={$tweenedX}
	cy={$tweenedY}
	r={8}
	fill={color}
	stroke="var(--token-stroke)"
	stroke-width="2"
	opacity={$tweenedOpacity}
	class="animating-token"
	data-token-id={id}
/>

<style>
	.animating-token {
		pointer-events: none;
		filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.8));
	}
</style>

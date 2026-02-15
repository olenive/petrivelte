<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import '$lib/theme.css';
	import { loadTheme } from '$lib/theme';
	import { connectServerEvents, disconnectServerEvents } from '$lib/stores/serverEvents';

	let { children } = $props();

	onMount(() => {
		loadTheme();
		connectServerEvents();
	});

	onDestroy(() => {
		disconnectServerEvents();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

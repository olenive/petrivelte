<script lang="ts">
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import '$lib/theme.css';
	import { loadTheme } from '$lib/theme';

	let { children } = $props();

	onMount(() => {
		loadTheme();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

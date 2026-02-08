<script lang="ts">
	import ThemeToggle from './ThemeToggle.svelte';

	type Props = {
		/** Current page title shown after breadcrumb separator */
		title?: string;
	};

	let { title }: Props = $props();
</script>

<nav class="flex items-center justify-between px-6 py-3 border-b border-border bg-card">
	<div class="flex items-center gap-2">
		<a href="/" class="font-bold text-lg text-foreground no-underline hover:opacity-80">Petrify</a>
		{#if title}
			<span class="text-foreground-faint">/</span>
			<span class="font-semibold text-foreground">{title}</span>
		{/if}
	</div>
	<div class="flex items-center gap-4">
		<ThemeToggle />
		<a href="/" class="text-accent text-sm no-underline hover:underline">App</a>
		<a href="/workers" class="text-accent text-sm no-underline hover:underline">Workers</a>
		<a href="/deployments" class="text-accent text-sm no-underline hover:underline">Deployments</a>
		<a href="/settings" class="text-accent text-sm no-underline hover:underline">Settings</a>
	</div>
</nav>

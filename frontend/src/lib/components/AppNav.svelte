<script lang="ts">
	import ThemeToggle from './ThemeToggle.svelte';

	type Props = {
		/** Current page title shown after breadcrumb separator */
		title?: string;
	};

	let { title }: Props = $props();
</script>

<nav class="app-nav">
	<div class="nav-left">
		<a href="/" class="brand">Petritype</a>
		{#if title}
			<span class="sep">/</span>
			<span class="title">{title}</span>
		{/if}
	</div>
	<div class="nav-right">
		<ThemeToggle />
		<a href="/" class="nav-link">App</a>
		<a href="/workers" class="nav-link">Workers</a>
		<a href="/settings" class="nav-link">Settings</a>
	</div>
</nav>

<style>
	.app-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1.5rem;
		border-bottom: 1px solid var(--border-color);
		background: var(--bg-secondary);
	}

	.nav-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.brand {
		font-weight: 700;
		font-size: 1.1rem;
		color: var(--text-primary);
		text-decoration: none;
	}

	.brand:hover {
		opacity: 0.8;
	}

	.sep {
		color: var(--text-tertiary);
	}

	.title {
		font-weight: 600;
		color: var(--text-primary);
	}

	.nav-right {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.nav-link {
		color: var(--button-text);
		text-decoration: none;
		font-size: 0.85rem;
	}

	.nav-link:hover {
		text-decoration: underline;
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { auth0Callback } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { captureAndStripSearchParams } from '$lib/security/sensitiveQueryParams';

	let status = $state<'loading' | 'error'>('loading');
	let errorMessage = $state('');

	onMount(async () => {
		const { code, state, error, error_description } = await captureAndStripSearchParams(
			new URL($page.url.toString()),
			['code', 'state', 'error', 'error_description'],
		);

		// Handle Auth0 error response
		if (error) {
			status = 'error';
			errorMessage = error_description || error;
			return;
		}

		if (!code || !state) {
			status = 'error';
			errorMessage = 'Missing authentication parameters';
			return;
		}

		try {
			await auth0Callback(code, state);
			// Success - redirect to home
			goto('/');
		} catch (e: any) {
			status = 'error';
			errorMessage = e.message || 'Authentication failed';
		}
	});
</script>

<div class="flex items-center justify-center min-h-screen bg-surface">
	<div class="bg-card border border-border rounded-lg p-8 w-full max-w-[380px] text-center">
		<div class="flex items-center justify-between mb-1">
			<h1 class="text-2xl font-bold text-foreground">Petri</h1>
			<ThemeToggle />
		</div>

		{#if status === 'loading'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Signing you in...</h2>
			<div class="w-8 h-8 mx-auto my-4 border-[3px] border-border border-t-accent rounded-full animate-spin"></div>
		{:else}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Authentication failed</h2>
			<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{errorMessage}</div>
			<a href="/login" class="block mt-4 text-accent text-sm hover:underline">Back to login</a>
		{/if}
	</div>
</div>

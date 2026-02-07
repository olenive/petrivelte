<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { auth0Callback } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let status: 'loading' | 'error' = 'loading';
	let errorMessage = '';

	onMount(async () => {
		const code = $page.url.searchParams.get('code');
		const state = $page.url.searchParams.get('state');
		const error = $page.url.searchParams.get('error');
		const errorDescription = $page.url.searchParams.get('error_description');

		// Handle Auth0 error response
		if (error) {
			status = 'error';
			errorMessage = errorDescription || error;
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

<div class="auth-page">
	<div class="auth-card" style="text-align:center;">
		<div class="card-header">
			<h1>Petritype</h1>
			<ThemeToggle />
		</div>

		{#if status === 'loading'}
			<h2>Signing you in...</h2>
			<div class="loading-spinner"></div>
		{:else}
			<h2>Authentication failed</h2>
			<div class="alert-error">{errorMessage}</div>
			<a href="/login" class="text-link" style="display:block;margin-top:1rem;">Back to login</a>
		{/if}
	</div>
</div>

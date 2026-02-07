<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { confirmEmailChange } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let status = $state<'loading' | 'success' | 'error' | 'no-token'>('loading');
	let errorMessage = $state('');
	let newEmail = $state('');

	let token = $derived($page.url.searchParams.get('token') || '');

	onMount(async () => {
		if (!token) {
			status = 'no-token';
			return;
		}

		try {
			const user = await confirmEmailChange(token);
			newEmail = user.email;
			status = 'success';
		} catch (e: any) {
			status = 'error';
			errorMessage = e.message || 'Failed to confirm email change';
		}
	});
</script>

<div class="flex items-center justify-center min-h-screen bg-surface">
	<div class="bg-card border border-border rounded-lg p-8 w-full max-w-[380px] text-center">
		<div class="flex items-center justify-between mb-1">
			<h1 class="text-2xl font-bold text-foreground">Petrify</h1>
			<ThemeToggle />
		</div>

		{#if status === 'loading'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Confirming email change...</h2>
			<div class="w-8 h-8 mx-auto my-4 border-[3px] border-border border-t-accent rounded-full animate-spin"></div>
		{:else if status === 'success'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Email updated!</h2>
			<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">
				<p>Your email has been changed to <strong>{newEmail}</strong></p>
			</div>
			<a href="/settings" class="inline-block mt-4 px-6 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground font-semibold no-underline transition-opacity hover:opacity-90">Go to settings</a>
		{:else if status === 'no-token'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Missing confirmation link</h2>
			<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">
				No confirmation token found. Please use the link from your email.
			</div>
			<a href="/settings" class="inline-block mt-4 px-6 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground font-semibold no-underline transition-opacity hover:opacity-90">Go to settings</a>
		{:else if status === 'error'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Confirmation failed</h2>
			<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{errorMessage}</div>
			<a href="/settings" class="inline-block mt-4 px-6 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground font-semibold no-underline transition-opacity hover:opacity-90">Go to settings</a>
		{/if}
	</div>
</div>

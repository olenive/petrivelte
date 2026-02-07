<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { confirmEmailChange } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let status: 'loading' | 'success' | 'error' | 'no-token' = 'loading';
	let errorMessage = '';
	let newEmail = '';

	$: token = $page.url.searchParams.get('token') || '';

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

<div class="auth-page">
	<div class="auth-card" style="text-align:center;">
		<div class="card-header">
			<h1>Petritype</h1>
			<ThemeToggle />
		</div>

		{#if status === 'loading'}
			<h2>Confirming email change...</h2>
			<div class="loading-spinner"></div>
		{:else if status === 'success'}
			<h2>Email updated!</h2>
			<div class="alert-success">
				<p>Your email has been changed to <strong>{newEmail}</strong></p>
			</div>
			<a href="/settings" class="btn-link">Go to settings</a>
		{:else if status === 'no-token'}
			<h2>Missing confirmation link</h2>
			<div class="alert-error">
				No confirmation token found. Please use the link from your email.
			</div>
			<a href="/settings" class="btn-link">Go to settings</a>
		{:else if status === 'error'}
			<h2>Confirmation failed</h2>
			<div class="alert-error">{errorMessage}</div>
			<a href="/settings" class="btn-link">Go to settings</a>
		{/if}
	</div>
</div>

<style>
	.btn-link {
		display: inline-block;
		margin-top: 1rem;
		padding: 0.65rem 1.5rem;
		border: 1px solid var(--button-border);
		border-radius: 6px;
		background: var(--button-border);
		color: var(--bg-primary);
		font-size: 0.95rem;
		font-weight: 600;
		text-decoration: none;
		transition: opacity 0.2s;
	}

	.btn-link:hover {
		opacity: 0.9;
	}
</style>

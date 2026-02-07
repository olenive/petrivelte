<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { verifyEmail, resendVerification } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let status: 'loading' | 'success' | 'error' | 'no-token' = 'loading';
	let errorMessage = '';

	// For resend functionality
	let resendEmail = '';
	let resendLoading = false;
	let resendSuccess = false;
	let resendError = '';

	$: token = $page.url.searchParams.get('token') || '';

	onMount(async () => {
		if (!token) {
			status = 'no-token';
			return;
		}

		try {
			await verifyEmail(token);
			status = 'success';
			// Redirect to home after short delay
			setTimeout(() => goto('/'), 2000);
		} catch (e: any) {
			status = 'error';
			errorMessage = e.message || 'Verification failed';
		}
	});

	async function handleResend() {
		if (!resendEmail.trim()) return;
		resendLoading = true;
		resendError = '';
		try {
			await resendVerification(resendEmail);
			resendSuccess = true;
		} catch (e: any) {
			resendError = e.message || 'Failed to resend verification email';
		} finally {
			resendLoading = false;
		}
	}
</script>

<div class="auth-page">
	<div class="auth-card" style="text-align:center;">
		<div class="card-header">
			<h1>Petritype</h1>
			<ThemeToggle />
		</div>

		{#if status === 'loading'}
			<h2>Verifying your email...</h2>
			<div class="loading-spinner"></div>
		{:else if status === 'success'}
			<h2>Email verified!</h2>
			<div class="alert-success">
				<p>Your email has been verified successfully.</p>
				<p>Redirecting you to the dashboard...</p>
			</div>
		{:else if status === 'no-token'}
			<h2>Missing verification link</h2>
			<div class="alert-error" style="text-align:left;">
				No verification token found. Please use the link from your verification email.
			</div>
			<a href="/login" class="text-link" style="display:block;margin-top:1rem;">Back to login</a>
		{:else if status === 'error'}
			<h2>Verification failed</h2>
			<div class="alert-error" style="text-align:left;">{errorMessage}</div>

			{#if resendSuccess}
				<div class="alert-success">
					<p>New verification email sent! Check your inbox.</p>
				</div>
			{:else}
				<div class="resend-section">
					<p>Need a new verification link?</p>
					{#if resendError}
						<p class="resend-error">{resendError}</p>
					{/if}
					<form on:submit|preventDefault={handleResend}>
						<input
							type="email"
							bind:value={resendEmail}
							placeholder="Enter your email"
							required
						/>
						<button type="submit" disabled={resendLoading}>
							{resendLoading ? 'Sending...' : 'Resend verification email'}
						</button>
					</form>
				</div>
			{/if}

			<a href="/login" class="text-link" style="display:block;margin-top:1rem;">Back to login</a>
		{/if}
	</div>
</div>

<style>
	.resend-section {
		margin: 1.5rem 0;
		padding: 1rem;
		border-radius: 6px;
		background: var(--bg-tertiary);
	}

	.resend-section p {
		margin: 0 0 0.75rem;
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.resend-error {
		color: var(--error-text) !important;
	}

	.resend-section form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.resend-section input {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.resend-section input:focus {
		outline: none;
		border-color: var(--button-border);
	}

	.resend-section button {
		padding: 0.5rem;
		border: 1px solid var(--button-border);
		border-radius: 6px;
		background: var(--button-border);
		color: var(--bg-primary);
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.resend-section button:hover:not(:disabled) {
		opacity: 0.9;
	}

	.resend-section button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

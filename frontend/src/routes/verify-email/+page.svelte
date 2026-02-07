<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { verifyEmail, resendVerification } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let status = $state<'loading' | 'success' | 'error' | 'no-token'>('loading');
	let errorMessage = $state('');

	// For resend functionality
	let resendEmail = $state('');
	let resendLoading = $state(false);
	let resendSuccess = $state(false);
	let resendError = $state('');

	let token = $derived($page.url.searchParams.get('token') || '');

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

<div class="flex items-center justify-center min-h-screen bg-surface">
	<div class="bg-card border border-border rounded-lg p-8 w-full max-w-[380px] text-center">
		<div class="flex items-center justify-between mb-1">
			<h1 class="text-2xl font-bold text-foreground">Petrify</h1>
			<ThemeToggle />
		</div>

		{#if status === 'loading'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Verifying your email...</h2>
			<div class="w-8 h-8 mx-auto my-4 border-[3px] border-border border-t-accent rounded-full animate-spin"></div>
		{:else if status === 'success'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Email verified!</h2>
			<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">
				<p class="mb-2">Your email has been verified successfully.</p>
				<p>Redirecting you to the dashboard...</p>
			</div>
		{:else if status === 'no-token'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Missing verification link</h2>
			<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm text-left">
				No verification token found. Please use the link from your verification email.
			</div>
			<a href="/login" class="block mt-4 text-accent text-sm hover:underline">Back to login</a>
		{:else if status === 'error'}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Verification failed</h2>
			<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm text-left">{errorMessage}</div>

			{#if resendSuccess}
				<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">
					<p>New verification email sent! Check your inbox.</p>
				</div>
			{:else}
				<div class="my-6 p-4 rounded-md bg-muted">
					<p class="mb-3 text-sm text-foreground-muted">Need a new verification link?</p>
					{#if resendError}
						<p class="mb-3 text-sm text-error">{resendError}</p>
					{/if}
					<form class="flex flex-col gap-2" onsubmit={(e) => { e.preventDefault(); handleResend(); }}>
						<input
							type="email"
							bind:value={resendEmail}
							placeholder="Enter your email"
							required
							class="px-3 py-2 border border-border rounded-md bg-surface text-foreground text-sm focus:outline-none focus:border-accent"
						/>
						<button type="submit" disabled={resendLoading}
							class="w-full py-2 border border-accent rounded-md bg-accent text-accent-foreground text-sm font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
							{resendLoading ? 'Sending...' : 'Resend verification email'}
						</button>
					</form>
				</div>
			{/if}

			<a href="/login" class="block mt-4 text-accent text-sm hover:underline">Back to login</a>
		{/if}
	</div>
</div>

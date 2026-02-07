<script lang="ts">
	import { forgotPassword } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let email = '';
	let error = '';
	let success = false;
	let loading = false;

	async function handleSubmit() {
		error = '';
		loading = true;
		try {
			await forgotPassword(email);
			success = true;
		} catch (e: any) {
			error = e.message || 'Something went wrong';
		} finally {
			loading = false;
		}
	}
</script>

<div class="auth-page">
	<div class="auth-card">
		<div class="card-header">
			<h1>Petritype</h1>
			<ThemeToggle />
		</div>
		<h2>Reset your password</h2>

		{#if success}
			<div class="alert-success">
				<p>If an account exists with that email, we've sent a password reset link.</p>
				<p>Check your inbox (and spam folder).</p>
			</div>
			<a href="/login" class="text-link" style="display:block;text-align:center;">Back to login</a>
		{:else}
			{#if error}
				<div class="alert-error">{error}</div>
			{/if}

			<p class="description">
				Enter your email address and we'll send you a link to reset your password.
			</p>

			<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
				<label>
					Email
					<input type="email" bind:value={email} required autocomplete="email" />
				</label>

				<button type="submit" disabled={loading}>
					{loading ? 'Sending...' : 'Send reset link'}
				</button>
			</form>

			<p class="switch">
				Remember your password?
				<a href="/login" class="text-link">Sign in</a>
			</p>
		{/if}
	</div>
</div>

<style>
	.description {
		margin: 0 0 1.5rem;
		font-size: 0.9rem;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.switch {
		margin-top: 1.25rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
</style>

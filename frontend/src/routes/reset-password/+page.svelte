<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { resetPassword } from '$lib/api';

	let newPassword = '';
	let confirmPassword = '';
	let error = '';
	let success = false;
	let loading = false;

	$: token = $page.url.searchParams.get('token') || '';

	async function handleSubmit() {
		error = '';

		if (!token) {
			error = 'Invalid reset link. Please request a new one.';
			return;
		}

		if (newPassword !== confirmPassword) {
			error = 'Passwords do not match';
			return;
		}

		if (newPassword.length < 6) {
			error = 'Password must be at least 6 characters';
			return;
		}

		loading = true;
		try {
			await resetPassword(token, newPassword);
			success = true;
		} catch (e: any) {
			error = e.message || 'Something went wrong';
		} finally {
			loading = false;
		}
	}

	function goToLogin() {
		goto('/login');
	}
</script>

<div class="page">
	<div class="card">
		<h1>Petritype</h1>
		<h2>Set new password</h2>

		{#if success}
			<div class="success">
				<p>Your password has been reset successfully.</p>
				<p>You can now sign in with your new password.</p>
			</div>
			<button class="primary-btn" onclick={goToLogin}>
				Go to login
			</button>
		{:else if !token}
			<div class="error">
				Invalid or missing reset token. Please request a new password reset link.
			</div>
			<a href="/forgot-password" class="back-link">Request new link</a>
		{:else}
			{#if error}
				<div class="error">{error}</div>
			{/if}

			<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
				<label>
					New Password
					<input
						type="password"
						bind:value={newPassword}
						required
						minlength="6"
						autocomplete="new-password"
					/>
				</label>

				<label>
					Confirm New Password
					<input
						type="password"
						bind:value={confirmPassword}
						required
						minlength="6"
						autocomplete="new-password"
					/>
				</label>

				<button type="submit" disabled={loading}>
					{loading ? 'Resetting...' : 'Reset password'}
				</button>
			</form>

			<p class="switch">
				Remember your password?
				<a href="/login" class="link">Sign in</a>
			</p>
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		background: var(--bg-primary, #0f0f0f);
	}

	.card {
		background: var(--bg-secondary, #1a1a1a);
		border: 1px solid var(--border-color, #333);
		border-radius: 8px;
		padding: 2rem;
		width: 100%;
		max-width: 380px;
	}

	h1 {
		margin: 0 0 0.25rem;
		font-size: 1.5rem;
		color: var(--text-primary, #fff);
	}

	h2 {
		margin: 0 0 1.5rem;
		font-size: 1.1rem;
		font-weight: 400;
		color: var(--text-secondary, #b0b0b0);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		color: var(--text-secondary, #b0b0b0);
	}

	input {
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border-color, #333);
		border-radius: 4px;
		background: var(--bg-primary, #0f0f0f);
		color: var(--text-primary, #fff);
		font-size: 0.95rem;
	}

	input:focus {
		outline: none;
		border-color: var(--button-border, #4d9fff);
	}

	button[type='submit'], .primary-btn {
		margin-top: 0.5rem;
		padding: 0.65rem;
		border: 1px solid var(--button-border, #4d9fff);
		border-radius: 4px;
		background: var(--button-border, #4d9fff);
		color: var(--bg-primary, #0f0f0f);
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	button[type='submit']:hover:not(:disabled), .primary-btn:hover {
		opacity: 0.9;
	}

	button[type='submit']:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error {
		margin-bottom: 1rem;
		padding: 0.6rem 0.75rem;
		border-radius: 4px;
		background: #3b1515;
		color: #f87171;
		font-size: 0.85rem;
	}

	.success {
		margin-bottom: 1.5rem;
		padding: 1rem;
		border-radius: 4px;
		background: #153b1a;
		color: #4ade80;
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.success p {
		margin: 0 0 0.5rem;
	}

	.success p:last-child {
		margin-bottom: 0;
	}

	.switch {
		margin-top: 1.25rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-secondary, #b0b0b0);
	}

	.link, .back-link {
		color: var(--button-border, #4d9fff);
		font-size: 0.85rem;
		text-decoration: none;
	}

	.link:hover, .back-link:hover {
		text-decoration: underline;
	}

	.back-link {
		display: block;
		text-align: center;
		margin-top: 1rem;
	}
</style>

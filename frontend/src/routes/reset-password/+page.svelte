<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { resetPassword } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

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

<div class="auth-page">
	<div class="auth-card">
		<div class="card-header">
			<h1>Petritype</h1>
			<ThemeToggle />
		</div>
		<h2>Set new password</h2>

		{#if success}
			<div class="alert-success">
				<p>Your password has been reset successfully.</p>
				<p>You can now sign in with your new password.</p>
			</div>
			<button class="primary-btn" onclick={goToLogin}>
				Go to login
			</button>
		{:else if !token}
			<div class="alert-error">
				Invalid or missing reset token. Please request a new password reset link.
			</div>
			<a href="/forgot-password" class="text-link" style="display:block;text-align:center;margin-top:1rem;">Request new link</a>
		{:else}
			{#if error}
				<div class="alert-error">{error}</div>
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
				<a href="/login" class="text-link">Sign in</a>
			</p>
		{/if}
	</div>
</div>

<style>
	.switch {
		margin-top: 1.25rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
</style>

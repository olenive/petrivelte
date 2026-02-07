<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { resetPassword } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let token = $derived($page.url.searchParams.get('token') || '');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let error = $state('');
	let success = $state(false);
	let loading = $state(false);

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

<div class="flex items-center justify-center min-h-screen bg-surface">
	<div class="bg-card border border-border rounded-lg p-8 w-full max-w-[380px]">
		<div class="flex items-center justify-between mb-1">
			<h1 class="text-2xl font-bold text-foreground">Petrify</h1>
			<ThemeToggle />
		</div>
		<h2 class="mb-6 text-lg font-normal text-foreground-muted">Set new password</h2>

		{#if success}
			<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">
				<p class="mb-2">Your password has been reset successfully.</p>
				<p>You can now sign in with your new password.</p>
			</div>
			<button class="w-full mt-2 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90" onclick={goToLogin}>
				Go to login
			</button>
		{:else if !token}
			<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">
				Invalid or missing reset token. Please request a new password reset link.
			</div>
			<a href="/forgot-password" class="block mt-4 text-center text-accent text-sm hover:underline">Request new link</a>
		{:else}
			{#if error}
				<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{error}</div>
			{/if}

			<form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
				<label class="flex flex-col gap-1 text-sm text-foreground-muted">
					New Password
					<input
						type="password"
						bind:value={newPassword}
						required
						minlength="6"
						autocomplete="new-password"
						class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent"
					/>
				</label>

				<label class="flex flex-col gap-1 text-sm text-foreground-muted">
					Confirm New Password
					<input
						type="password"
						bind:value={confirmPassword}
						required
						minlength="6"
						autocomplete="new-password"
						class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent"
					/>
				</label>

				<button type="submit" disabled={loading}
					class="w-full mt-2 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
					{loading ? 'Resetting...' : 'Reset password'}
				</button>
			</form>

			<p class="mt-5 text-center text-sm text-foreground-muted">
				Remember your password?
				<a href="/login" class="text-accent hover:underline">Sign in</a>
			</p>
		{/if}
	</div>
</div>

<script lang="ts">
	import { forgotPassword } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let email = $state('');
	let error = $state('');
	let success = $state(false);
	let loading = $state(false);

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

<div class="flex items-center justify-center min-h-screen bg-surface">
	<div class="bg-card border border-border rounded-lg p-8 w-full max-w-[380px]">
		<div class="flex items-center justify-between mb-1">
			<h1 class="text-2xl font-bold text-foreground">Petri</h1>
			<ThemeToggle />
		</div>
		<h2 class="mb-6 text-lg font-normal text-foreground-muted">Reset your password</h2>

		{#if success}
			<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">
				<p class="mb-2">If an account exists with that email, we've sent a password reset link.</p>
				<p>Check your inbox (and spam folder).</p>
			</div>
			<a href="/login" class="block text-center text-accent text-sm hover:underline">Back to login</a>
		{:else}
			{#if error}
				<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{error}</div>
			{/if}

			<p class="mb-6 text-sm text-foreground-muted leading-relaxed">
				Enter your email address and we'll send you a link to reset your password.
			</p>

			<form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
				<label class="flex flex-col gap-1 text-sm text-foreground-muted">
					Email
					<input type="email" bind:value={email} required autocomplete="email"
						class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent" />
				</label>

				<button type="submit" disabled={loading}
					class="w-full mt-2 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
					{loading ? 'Sending...' : 'Send reset link'}
				</button>
			</form>

			<p class="mt-5 text-center text-sm text-foreground-muted">
				Remember your password?
				<a href="/login" class="text-accent hover:underline">Sign in</a>
			</p>
		{/if}
	</div>
</div>

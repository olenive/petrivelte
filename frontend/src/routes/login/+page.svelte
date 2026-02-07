<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { register, login, resendVerification, getAuth0Status, getAuth0LoginUrl } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let mode = $state<'login' | 'register'>('login');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	// After registration, show verification message
	let registrationComplete = $state(false);
	let registeredEmail = $state('');

	// For "not verified" error, allow resending
	let showResendOption = $state(false);
	let resendLoading = $state(false);
	let resendSuccess = $state(false);

	// Auth0 / social login
	let auth0Configured = $state(false);

	onMount(async () => {
		const status = await getAuth0Status();
		auth0Configured = status.configured;
	});

	function handleGoogleLogin() {
		// Redirect to backend Auth0 login endpoint
		window.location.href = getAuth0LoginUrl();
	}

	async function handleSubmit() {
		error = '';
		showResendOption = false;
		resendSuccess = false;
		loading = true;
		try {
			if (mode === 'register') {
				const result = await register(email, password);
				registeredEmail = result.email;
				registrationComplete = true;
			} else {
				await login(email, password);
				goto('/');
			}
		} catch (e: any) {
			error = e.message || 'Something went wrong';
			// Check if this is a "not verified" error
			if (error.toLowerCase().includes('not verified')) {
				showResendOption = true;
			}
		} finally {
			loading = false;
		}
	}

	async function handleResendVerification() {
		resendLoading = true;
		error = '';
		try {
			await resendVerification(email);
			resendSuccess = true;
			showResendOption = false;
		} catch (e: any) {
			error = e.message || 'Failed to resend verification email';
		} finally {
			resendLoading = false;
		}
	}

	function toggleMode() {
		mode = mode === 'login' ? 'register' : 'login';
		error = '';
		showResendOption = false;
		resendSuccess = false;
		registrationComplete = false;
	}

	function backToLogin() {
		registrationComplete = false;
		mode = 'login';
		password = '';
	}
</script>

<div class="flex items-center justify-center min-h-screen bg-surface">
	<div class="bg-card border border-border rounded-lg p-8 w-full max-w-[380px]">
		<div class="flex items-center justify-between mb-1">
			<h1 class="text-2xl font-bold text-foreground">Petrify</h1>
			<ThemeToggle />
		</div>

		{#if registrationComplete}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">Check your email</h2>
			<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">
				<p class="mb-2">We've sent a verification link to <strong>{registeredEmail}</strong></p>
				<p>Click the link in the email to verify your account and sign in.</p>
			</div>
			<button class="w-full mt-2 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90" onclick={backToLogin}>
				Back to sign in
			</button>
		{:else}
			<h2 class="mb-6 text-lg font-normal text-foreground-muted">{mode === 'login' ? 'Sign in' : 'Create account'}</h2>

			{#if error}
				<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{error}</div>
			{/if}

			{#if resendSuccess}
				<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">
					<p>Verification email sent! Check your inbox.</p>
				</div>
			{/if}

			{#if showResendOption}
				<div class="mb-4 p-3 rounded-md bg-muted text-sm text-center">
					<p class="mb-2 text-foreground-muted">Didn't receive the email?</p>
					<button
						class="text-accent cursor-pointer text-sm hover:underline"
						onclick={handleResendVerification}
						disabled={resendLoading}
					>
						{resendLoading ? 'Sending...' : 'Resend verification email'}
					</button>
				</div>
			{/if}

			<form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
				<label class="flex flex-col gap-1 text-sm text-foreground-muted">
					Email
					<input type="email" bind:value={email} required autocomplete="email"
						class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent" />
				</label>

				<label class="flex flex-col gap-1 text-sm text-foreground-muted">
					Password
					<input
						type="password"
						bind:value={password}
						required
						minlength="6"
						autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
						class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent"
					/>
				</label>

				<button type="submit" disabled={loading}
					class="w-full mt-2 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
					{loading ? '...' : mode === 'login' ? 'Sign in' : 'Create account'}
				</button>
			</form>

			{#if auth0Configured}
				<div class="flex items-center my-5 text-foreground-faint text-xs">
					<div class="flex-1 h-px bg-border"></div>
					<span class="px-3">or</span>
					<div class="flex-1 h-px bg-border"></div>
				</div>

				<button class="flex items-center justify-center gap-2 w-full py-2.5 border border-border rounded-md bg-surface text-foreground text-base font-medium cursor-pointer transition-colors hover:bg-muted hover:border-foreground-faint" onclick={handleGoogleLogin}>
					<svg class="shrink-0" viewBox="0 0 24 24" width="18" height="18">
						<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
						<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
						<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
						<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
					</svg>
					Continue with Google
				</button>
			{/if}

			{#if mode === 'login'}
				<p class="mt-4 text-right text-sm">
					<a href="/forgot-password" class="text-accent hover:underline">Forgot password?</a>
				</p>
			{/if}

			<p class="mt-5 text-center text-sm text-foreground-muted">
				{mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
				<button class="text-accent cursor-pointer text-sm hover:underline" onclick={toggleMode}>
					{mode === 'login' ? 'Register' : 'Sign in'}
				</button>
			</p>
		{/if}
	</div>
</div>

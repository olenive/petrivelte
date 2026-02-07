<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { register, login, resendVerification, getAuth0Status, getAuth0LoginUrl } from '$lib/api';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let mode: 'login' | 'register' = 'login';
	let email = '';
	let password = '';
	let error = '';
	let loading = false;

	// After registration, show verification message
	let registrationComplete = false;
	let registeredEmail = '';

	// For "not verified" error, allow resending
	let showResendOption = false;
	let resendLoading = false;
	let resendSuccess = false;

	// Auth0 / social login
	let auth0Configured = false;

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

<div class="auth-page">
	<div class="auth-card">
		<div class="card-header">
			<h1>Petritype</h1>
			<ThemeToggle />
		</div>

		{#if registrationComplete}
			<h2>Check your email</h2>
			<div class="alert-success">
				<p>We've sent a verification link to <strong>{registeredEmail}</strong></p>
				<p>Click the link in the email to verify your account and sign in.</p>
			</div>
			<button class="primary-btn" on:click={backToLogin}>
				Back to sign in
			</button>
		{:else}
			<h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>

			{#if error}
				<div class="alert-error">{error}</div>
			{/if}

			{#if resendSuccess}
				<div class="alert-success">
					<p>Verification email sent! Check your inbox.</p>
				</div>
			{/if}

			{#if showResendOption}
				<div class="resend-option">
					<p>Didn't receive the email?</p>
					<button
						class="text-link"
						on:click={handleResendVerification}
						disabled={resendLoading}
					>
						{resendLoading ? 'Sending...' : 'Resend verification email'}
					</button>
				</div>
			{/if}

			<form on:submit|preventDefault={handleSubmit}>
				<label>
					Email
					<input type="email" bind:value={email} required autocomplete="email" />
				</label>

				<label>
					Password
					<input
						type="password"
						bind:value={password}
						required
						minlength="6"
						autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
					/>
				</label>

				<button type="submit" disabled={loading}>
					{loading ? '...' : mode === 'login' ? 'Sign in' : 'Create account'}
				</button>
			</form>

			{#if auth0Configured}
				<div class="divider">
					<span>or</span>
				</div>

				<button class="google-btn" on:click={handleGoogleLogin}>
					<svg class="google-icon" viewBox="0 0 24 24" width="18" height="18">
						<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
						<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
						<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
						<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
					</svg>
					Continue with Google
				</button>
			{/if}

			{#if mode === 'login'}
				<p class="forgot">
					<a href="/forgot-password" class="text-link">Forgot password?</a>
				</p>
			{/if}

			<p class="switch">
				{mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
				<button class="text-link" on:click={toggleMode}>
					{mode === 'login' ? 'Register' : 'Sign in'}
				</button>
			</p>
		{/if}
	</div>
</div>

<style>
	/* Login-specific styles (shared styles come from theme.css) */
	.resend-option {
		margin-bottom: 1rem;
		padding: 0.75rem;
		border-radius: 6px;
		background: var(--bg-tertiary);
		font-size: 0.85rem;
		text-align: center;
	}

	.resend-option p {
		margin: 0 0 0.5rem;
		color: var(--text-secondary);
	}

	.forgot {
		margin-top: 1rem;
		text-align: right;
		font-size: 0.85rem;
	}

	.switch {
		margin-top: 1.25rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.divider {
		display: flex;
		align-items: center;
		margin: 1.25rem 0;
		color: var(--text-tertiary);
		font-size: 0.8rem;
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-color);
	}

	.divider span {
		padding: 0 0.75rem;
	}

	.google-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.65rem;
		border: 1px solid var(--border-color);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.95rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.2s, border-color 0.2s;
	}

	.google-btn:hover {
		background: var(--bg-tertiary);
		border-color: var(--text-tertiary);
	}

	.google-icon {
		flex-shrink: 0;
	}
</style>

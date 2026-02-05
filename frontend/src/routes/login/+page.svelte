<script lang="ts">
	import { goto } from '$app/navigation';
	import { register, login } from '$lib/api';

	let mode: 'login' | 'register' = 'login';
	let email = '';
	let password = '';
	let error = '';
	let loading = false;

	async function handleSubmit() {
		error = '';
		loading = true;
		try {
			if (mode === 'register') {
				await register(email, password);
			} else {
				await login(email, password);
			}
			goto('/');
		} catch (e: any) {
			error = e.message || 'Something went wrong';
		} finally {
			loading = false;
		}
	}

	function toggleMode() {
		mode = mode === 'login' ? 'register' : 'login';
		error = '';
	}
</script>

<div class="login-page">
	<div class="login-card">
		<h1>Petritype</h1>
		<h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>

		{#if error}
			<div class="error">{error}</div>
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

		<p class="switch">
			{mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
			<button class="link" on:click={toggleMode}>
				{mode === 'login' ? 'Register' : 'Sign in'}
			</button>
		</p>
	</div>
</div>

<style>
	.login-page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		background: var(--bg-primary, #0f0f0f);
	}

	.login-card {
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

	button[type='submit'] {
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

	button[type='submit']:hover:not(:disabled) {
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

	.switch {
		margin-top: 1.25rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-secondary, #b0b0b0);
	}

	.link {
		background: none;
		border: none;
		color: var(--button-border, #4d9fff);
		cursor: pointer;
		font-size: 0.85rem;
		padding: 0;
		text-decoration: underline;
	}

	.link:hover {
		opacity: 0.8;
	}
</style>

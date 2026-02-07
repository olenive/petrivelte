<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { getMe, changePassword, logout } from '$lib/api';

	let user: { id: string; email: string } | null = null;
	let currentPassword = '';
	let newPassword = '';
	let confirmPassword = '';
	let error = '';
	let success = '';
	let loading = false;

	onMount(async () => {
		user = await getMe();
		if (!user) {
			goto('/login');
		}
	});

	async function handleChangePassword() {
		error = '';
		success = '';

		if (newPassword !== confirmPassword) {
			error = 'New passwords do not match';
			return;
		}

		if (newPassword.length < 6) {
			error = 'New password must be at least 6 characters';
			return;
		}

		loading = true;
		try {
			await changePassword(currentPassword, newPassword);
			success = 'Password changed successfully';
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
		} catch (e: any) {
			error = e.message || 'Failed to change password';
		} finally {
			loading = false;
		}
	}

	async function handleLogout() {
		await logout();
		goto('/login');
	}
</script>

<div class="settings-page">
	<div class="settings-card">
		<header>
			<h1>Settings</h1>
			<a href="/" class="back-link">Back to app</a>
		</header>

		{#if user}
			<section class="account-info">
				<h2>Account</h2>
				<p class="email">{user.email}</p>
				<button class="logout-btn" onclick={handleLogout}>Log out</button>
			</section>

			<section class="password-section">
				<h2>Change Password</h2>

				{#if error}
					<div class="error">{error}</div>
				{/if}

				{#if success}
					<div class="success">{success}</div>
				{/if}

				<form onsubmit={(e) => { e.preventDefault(); handleChangePassword(); }}>
					<label>
						Current Password
						<input
							type="password"
							bind:value={currentPassword}
							required
							autocomplete="current-password"
						/>
					</label>

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
						{loading ? 'Changing...' : 'Change Password'}
					</button>
				</form>
			</section>
		{:else}
			<p>Loading...</p>
		{/if}
	</div>
</div>

<style>
	.settings-page {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		min-height: 100vh;
		padding: 2rem;
		background: var(--bg-primary, #0f0f0f);
	}

	.settings-card {
		background: var(--bg-secondary, #1a1a1a);
		border: 1px solid var(--border-color, #333);
		border-radius: 8px;
		padding: 2rem;
		width: 100%;
		max-width: 480px;
	}

	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 2rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--border-color, #333);
	}

	h1 {
		margin: 0;
		font-size: 1.5rem;
		color: var(--text-primary, #fff);
	}

	h2 {
		margin: 0 0 1rem;
		font-size: 1.1rem;
		font-weight: 500;
		color: var(--text-primary, #fff);
	}

	.back-link {
		color: var(--button-border, #4d9fff);
		font-size: 0.85rem;
		text-decoration: none;
	}

	.back-link:hover {
		text-decoration: underline;
	}

	section {
		margin-bottom: 2rem;
	}

	.account-info {
		padding-bottom: 1.5rem;
		border-bottom: 1px solid var(--border-color, #333);
	}

	.email {
		margin: 0 0 1rem;
		color: var(--text-secondary, #b0b0b0);
		font-size: 0.95rem;
	}

	.logout-btn {
		padding: 0.5rem 1rem;
		border: 1px solid var(--border-color, #333);
		border-radius: 4px;
		background: transparent;
		color: var(--text-secondary, #b0b0b0);
		font-size: 0.85rem;
		cursor: pointer;
		transition: border-color 0.2s, color 0.2s;
	}

	.logout-btn:hover {
		border-color: #f87171;
		color: #f87171;
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

	.success {
		margin-bottom: 1rem;
		padding: 0.6rem 0.75rem;
		border-radius: 4px;
		background: #153b1a;
		color: #4ade80;
		font-size: 0.85rem;
	}
</style>

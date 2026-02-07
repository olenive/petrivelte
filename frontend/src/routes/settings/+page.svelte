<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		getAccountStatus,
		changePassword,
		setPassword,
		changeEmail,
		logout,
		unlinkAuth0,
		getAuth0LoginUrl,
		type AccountStatus,
	} from '$lib/api';
	import AppNav from '$lib/components/AppNav.svelte';

	let account: AccountStatus | null = null;

	// Password form
	let currentPassword = '';
	let newPassword = '';
	let confirmPassword = '';
	let passwordError = '';
	let passwordSuccess = '';
	let passwordLoading = false;

	// Email form
	let newEmail = '';
	let emailPassword = '';
	let emailError = '';
	let emailSuccess = '';
	let emailLoading = false;

	// Google account
	let googleError = '';
	let googleSuccess = '';
	let googleLoading = false;

	onMount(async () => {
		try {
			account = await getAccountStatus();
		} catch {
			goto('/login');
		}
	});

	async function handlePasswordSubmit() {
		passwordError = '';
		passwordSuccess = '';

		if (newPassword !== confirmPassword) {
			passwordError = 'New passwords do not match';
			return;
		}

		if (newPassword.length < 6) {
			passwordError = 'Password must be at least 6 characters';
			return;
		}

		passwordLoading = true;
		try {
			if (account?.has_password) {
				await changePassword(currentPassword, newPassword);
				passwordSuccess = 'Password changed successfully';
			} else {
				await setPassword(newPassword);
				passwordSuccess = 'Password set successfully';
				account = await getAccountStatus();
			}
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
		} catch (e: any) {
			passwordError = e.message || 'Failed to update password';
		} finally {
			passwordLoading = false;
		}
	}

	async function handleEmailSubmit() {
		emailError = '';
		emailSuccess = '';

		if (!newEmail.trim()) {
			emailError = 'Please enter a new email';
			return;
		}

		emailLoading = true;
		try {
			await changeEmail(newEmail, account?.has_password ? emailPassword : undefined);
			emailSuccess = 'Verification email sent to ' + newEmail;
			newEmail = '';
			emailPassword = '';
		} catch (e: any) {
			emailError = e.message || 'Failed to change email';
		} finally {
			emailLoading = false;
		}
	}

	async function handleUnlinkGoogle() {
		googleError = '';
		googleSuccess = '';
		googleLoading = true;
		try {
			await unlinkAuth0();
			googleSuccess = 'Google account unlinked';
			account = await getAccountStatus();
		} catch (e: any) {
			googleError = e.message || 'Failed to unlink Google account';
		} finally {
			googleLoading = false;
		}
	}

	function handleLinkGoogle() {
		window.location.href = getAuth0LoginUrl();
	}

	async function handleLogout() {
		await logout();
		goto('/login');
	}
</script>

<AppNav title="Settings" />

<div class="settings-page">
	<div class="settings-card">

		{#if account}
			<!-- Account Info -->
			<section class="account-info">
				<h2>Account</h2>
				<p class="email">{account.email}</p>
				<button class="logout-btn" on:click={handleLogout}>Log out</button>
			</section>

			<!-- Linked Accounts -->
			<section>
				<h2>Linked Accounts</h2>

				{#if googleError}
					<div class="alert-error">{googleError}</div>
				{/if}

				{#if googleSuccess}
					<div class="alert-success">{googleSuccess}</div>
				{/if}

				<div class="linked-account">
					<div class="account-info-row">
						<svg class="google-icon" viewBox="0 0 24 24" width="20" height="20">
							<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
							<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
							<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
							<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
						</svg>
						<span>Google</span>
						<span class="status-badge" class:connected={account.has_google}>
							{account.has_google ? 'Connected' : 'Not connected'}
						</span>
					</div>
					{#if account.has_google}
						<button
							class="unlink-btn"
							on:click={handleUnlinkGoogle}
							disabled={googleLoading || !account.has_password}
							title={!account.has_password ? 'Set a password first to unlink Google' : ''}
						>
							{googleLoading ? 'Unlinking...' : 'Unlink'}
						</button>
					{:else}
						<button class="link-btn" on:click={handleLinkGoogle}>
							Link Google
						</button>
					{/if}
				</div>
			</section>

			<!-- Password Section -->
			<section>
				<h2>{account.has_password ? 'Change Password' : 'Set Password'}</h2>

				{#if !account.has_password}
					<p class="hint">Add a password to log in with email/password as an alternative to Google.</p>
				{/if}

				{#if passwordError}
					<div class="alert-error">{passwordError}</div>
				{/if}

				{#if passwordSuccess}
					<div class="alert-success">{passwordSuccess}</div>
				{/if}

				<form on:submit|preventDefault={handlePasswordSubmit}>
					{#if account.has_password}
						<label>
							Current Password
							<input
								type="password"
								bind:value={currentPassword}
								required
								autocomplete="current-password"
							/>
						</label>
					{/if}

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

					<button type="submit" disabled={passwordLoading}>
						{passwordLoading ? 'Saving...' : account.has_password ? 'Change Password' : 'Set Password'}
					</button>
				</form>
			</section>

			<!-- Change Email Section -->
			<section>
				<h2>Change Email</h2>

				{#if emailError}
					<div class="alert-error">{emailError}</div>
				{/if}

				{#if emailSuccess}
					<div class="alert-success">{emailSuccess}</div>
				{/if}

				<form on:submit|preventDefault={handleEmailSubmit}>
					<label>
						New Email
						<input
							type="email"
							bind:value={newEmail}
							required
							autocomplete="email"
						/>
					</label>

					{#if account.has_password}
						<label>
							Current Password
							<input
								type="password"
								bind:value={emailPassword}
								required
								autocomplete="current-password"
							/>
						</label>
					{/if}

					<button type="submit" disabled={emailLoading}>
						{emailLoading ? 'Sending...' : 'Send Verification Email'}
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
		background: var(--bg-primary);
	}

	.settings-card {
		background: var(--bg-secondary);
		border: 1px solid var(--border-color);
		border-radius: 8px;
		padding: 2rem;
		width: 100%;
		max-width: 480px;
	}

	h2 {
		margin: 0 0 1rem;
		font-size: 1.1rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	section {
		margin-bottom: 2rem;
		padding-bottom: 1.5rem;
		border-bottom: 1px solid var(--border-color);
	}

	section:last-of-type {
		border-bottom: none;
		margin-bottom: 0;
		padding-bottom: 0;
	}

	.account-info .email {
		margin: 0 0 1rem;
		color: var(--text-secondary);
		font-size: 0.95rem;
	}

	.logout-btn {
		padding: 0.5rem 1rem;
		border: 1px solid var(--border-color);
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.85rem;
		cursor: pointer;
		transition: border-color 0.2s, color 0.2s;
	}

	.logout-btn:hover {
		border-color: var(--danger);
		color: var(--danger);
	}

	.linked-account {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem;
		background: var(--bg-tertiary);
		border-radius: 6px;
	}

	.account-info-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.google-icon {
		flex-shrink: 0;
	}

	.status-badge {
		font-size: 0.75rem;
		padding: 0.2rem 0.5rem;
		border-radius: 3px;
		background: var(--border-color);
		color: var(--text-tertiary);
	}

	.status-badge.connected {
		background: var(--success-bg);
		color: var(--success-text);
	}

	.link-btn, .unlink-btn {
		padding: 0.4rem 0.75rem;
		border-radius: 6px;
		font-size: 0.8rem;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.link-btn {
		border: 1px solid var(--button-border);
		background: var(--button-border);
		color: var(--bg-primary);
	}

	.unlink-btn {
		border: 1px solid var(--border-color);
		background: transparent;
		color: var(--text-secondary);
	}

	.unlink-btn:hover:not(:disabled) {
		border-color: var(--danger);
		color: var(--danger);
	}

	.link-btn:disabled, .unlink-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.hint {
		margin: 0 0 1rem;
		font-size: 0.85rem;
		color: var(--text-tertiary);
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
		color: var(--text-secondary);
	}

	input {
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.95rem;
	}

	input:focus {
		outline: none;
		border-color: var(--button-border);
	}

	button[type='submit'] {
		margin-top: 0.5rem;
		padding: 0.65rem;
		border: 1px solid var(--button-border);
		border-radius: 6px;
		background: var(--button-border);
		color: var(--bg-primary);
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
</style>

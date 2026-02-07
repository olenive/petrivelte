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

	let account = $state<AccountStatus | null>(null);

	// Password form
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let passwordError = $state('');
	let passwordSuccess = $state('');
	let passwordLoading = $state(false);

	// Email form
	let newEmail = $state('');
	let emailPassword = $state('');
	let emailError = $state('');
	let emailSuccess = $state('');
	let emailLoading = $state(false);

	// Google account
	let googleError = $state('');
	let googleSuccess = $state('');
	let googleLoading = $state(false);

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

<div class="flex items-start justify-center min-h-screen p-8 bg-surface">
	<div class="bg-card border border-border rounded-lg p-8 w-full max-w-[480px]">

		{#if account}
			<!-- Account Info -->
			<section class="mb-8 pb-6 border-b border-border">
				<h2 class="mb-4 text-lg font-medium text-foreground">Account</h2>
				<p class="mb-4 text-foreground-muted">{account.email}</p>
				<button
					class="px-4 py-2 border border-border rounded-md bg-transparent text-foreground-muted text-sm cursor-pointer transition-colors hover:border-destructive hover:text-destructive"
					onclick={handleLogout}
				>
					Log out
				</button>
			</section>

			<!-- Linked Accounts -->
			<section class="mb-8 pb-6 border-b border-border">
				<h2 class="mb-4 text-lg font-medium text-foreground">Linked Accounts</h2>

				{#if googleError}
					<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{googleError}</div>
				{/if}

				{#if googleSuccess}
					<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">{googleSuccess}</div>
				{/if}

				<div class="flex items-center justify-between p-3 bg-muted rounded-md">
					<div class="flex items-center gap-2">
						<svg class="shrink-0" viewBox="0 0 24 24" width="20" height="20">
							<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
							<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
							<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
							<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
						</svg>
						<span>Google</span>
						{#if account.has_google}
							<span class="text-xs px-2 py-0.5 rounded-sm bg-success-bg text-success">Connected</span>
						{:else}
							<span class="text-xs px-2 py-0.5 rounded-sm bg-border text-foreground-faint">Not connected</span>
						{/if}
					</div>
					{#if account.has_google}
						<button
							class="px-3 py-1.5 rounded-md text-xs border border-border bg-transparent text-foreground-muted cursor-pointer transition-colors hover:border-destructive hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
							onclick={handleUnlinkGoogle}
							disabled={googleLoading || !account.has_password}
							title={!account.has_password ? 'Set a password first to unlink Google' : ''}
						>
							{googleLoading ? 'Unlinking...' : 'Unlink'}
						</button>
					{:else}
						<button
							class="px-3 py-1.5 rounded-md text-xs border border-accent bg-accent text-accent-foreground cursor-pointer transition-opacity hover:opacity-90"
							onclick={handleLinkGoogle}
						>
							Link Google
						</button>
					{/if}
				</div>
			</section>

			<!-- Password Section -->
			<section class="mb-8 pb-6 border-b border-border">
				<h2 class="mb-4 text-lg font-medium text-foreground">{account.has_password ? 'Change Password' : 'Set Password'}</h2>

				{#if !account.has_password}
					<p class="mb-4 text-sm text-foreground-faint">Add a password to log in with email/password as an alternative to Google.</p>
				{/if}

				{#if passwordError}
					<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{passwordError}</div>
				{/if}

				{#if passwordSuccess}
					<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">{passwordSuccess}</div>
				{/if}

				<form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); handlePasswordSubmit(); }}>
					{#if account.has_password}
						<label class="flex flex-col gap-1 text-sm text-foreground-muted">
							Current Password
							<input
								type="password"
								bind:value={currentPassword}
								required
								autocomplete="current-password"
								class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent"
							/>
						</label>
					{/if}

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

					<button type="submit" disabled={passwordLoading}
						class="w-full mt-2 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
						{passwordLoading ? 'Saving...' : account.has_password ? 'Change Password' : 'Set Password'}
					</button>
				</form>
			</section>

			<!-- Change Email Section -->
			<section>
				<h2 class="mb-4 text-lg font-medium text-foreground">Change Email</h2>

				{#if emailError}
					<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{emailError}</div>
				{/if}

				{#if emailSuccess}
					<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">{emailSuccess}</div>
				{/if}

				<form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); handleEmailSubmit(); }}>
					<label class="flex flex-col gap-1 text-sm text-foreground-muted">
						New Email
						<input
							type="email"
							bind:value={newEmail}
							required
							autocomplete="email"
							class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent"
						/>
					</label>

					{#if account.has_password}
						<label class="flex flex-col gap-1 text-sm text-foreground-muted">
							Current Password
							<input
								type="password"
								bind:value={emailPassword}
								required
								autocomplete="current-password"
								class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent"
							/>
						</label>
					{/if}

					<button type="submit" disabled={emailLoading}
						class="w-full mt-2 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
						{emailLoading ? 'Sending...' : 'Send Verification Email'}
					</button>
				</form>
			</section>
		{:else}
			<p class="text-foreground-muted">Loading...</p>
		{/if}
	</div>
</div>

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
		getGitHubStatus,
		getGitHubConnectUrl,
		disconnectGitHub,
		listApiTokens,
		createApiToken,
		revokeApiToken,
		type AccountStatus,
		type GitHubStatus,
		type ApiToken,
		type ApiTokenCreated,
	} from '$lib/api';
	import {
		DEFAULT_EXPIRY_DAYS,
		DEFAULT_SCOPE,
		EXPIRY_CHOICES,
		SCOPE_CHOICES,
		describeScope,
		describeExpiry,
		describeLastUsed,
		formatCreated,
		tokenLabel,
		tokenStatus,
		type ApiTokenStatus,
	} from '$lib/apiTokens';
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

	// GitHub account
	let github = $state<GitHubStatus | null>(null);
	let githubError = $state('');
	let githubSuccess = $state('');
	let githubLoading = $state(false);

	// API tokens
	let tokens = $state<ApiToken[]>([]);
	let tokensNow = $state(Date.now());
	let tokenName = $state('');
	let tokenExpiryDays = $state(DEFAULT_EXPIRY_DAYS);
	let tokenScope = $state(DEFAULT_SCOPE);
	let tokensError = $state('');
	let tokenLoading = $state(false);
	let revokingId = $state<string | null>(null);
	let createdToken = $state<ApiTokenCreated | null>(null);
	let copied = $state(false);

	const STATUS_BADGE: Record<ApiTokenStatus, string> = {
		active: 'bg-success-bg text-success',
		expiring: 'bg-status-warning-bg text-status-warning',
		expired: 'bg-error-bg text-error',
		revoked: 'bg-border text-foreground-faint',
	};

	onMount(async () => {
		void loadTokens();
		account = await getAccountStatus();
		github = await getGitHubStatus();

		// Check for GitHub OAuth callback
		const url = new URL(window.location.href);
		if (url.searchParams.get('connected') === 'true') {
			githubSuccess = 'GitHub connected successfully';
			github = await getGitHubStatus();
			// Clean URL
			url.searchParams.delete('connected');
			window.history.replaceState({}, '', url.pathname);
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

	function handleConnectGitHub() {
		window.location.href = getGitHubConnectUrl();
	}

	async function handleDisconnectGitHub() {
		githubError = '';
		githubSuccess = '';
		githubLoading = true;
		try {
			await disconnectGitHub();
			githubSuccess = 'GitHub disconnected';
			github = { connected: false };
		} catch (e: any) {
			githubError = e.message || 'Failed to disconnect GitHub';
		} finally {
			githubLoading = false;
		}
	}

	async function loadTokens() {
		try {
			tokens = await listApiTokens();
			tokensNow = Date.now();
		} catch (e: any) {
			tokensError = e.message || 'Failed to load API tokens';
		}
	}

	async function handleCreateToken() {
		tokensError = '';
		createdToken = null;
		copied = false;
		const name = tokenName.trim();
		if (!name) {
			tokensError = 'Please enter a name for the token';
			return;
		}
		tokenLoading = true;
		try {
			createdToken = await createApiToken(name, tokenExpiryDays, tokenScope);
			tokenName = '';
			await loadTokens();
		} catch (e: any) {
			tokensError = e.message || 'Failed to create API token';
		} finally {
			tokenLoading = false;
		}
	}

	async function handleRevokeToken(token: ApiToken) {
		if (!confirm(`Revoke "${token.name}" (${tokenLabel(token.prefix)})? Scripts using it stop working at once.`)) {
			return;
		}
		tokensError = '';
		revokingId = token.id;
		try {
			await revokeApiToken(token.id);
			if (createdToken?.id === token.id) createdToken = null;
			await loadTokens();
		} catch (e: any) {
			tokensError = e.message || 'Failed to revoke API token';
		} finally {
			revokingId = null;
		}
	}

	async function handleCopyToken() {
		if (!createdToken) return;
		try {
			await navigator.clipboard.writeText(createdToken.token);
			copied = true;
		} catch {
			tokensError = 'Could not copy automatically; select the token and copy it by hand';
		}
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

			<!-- GitHub Integration -->
			<section class="mb-8 pb-6 border-b border-border">
				<h2 class="mb-4 text-lg font-medium text-foreground">GitHub Integration</h2>

				{#if githubError}
					<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{githubError}</div>
				{/if}

				{#if githubSuccess}
					<div class="mb-4 p-3 rounded-md bg-success-bg text-success text-sm leading-relaxed">{githubSuccess}</div>
				{/if}

				<div class="flex items-center justify-between p-3 bg-muted rounded-md">
					<div class="flex items-center gap-2">
						<svg class="shrink-0" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
							<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
						</svg>
						<span>GitHub</span>
						{#if github?.connected}
							<span class="text-xs px-2 py-0.5 rounded-sm bg-success-bg text-success">@{github.username}</span>
						{:else}
							<span class="text-xs px-2 py-0.5 rounded-sm bg-border text-foreground-faint">Not connected</span>
						{/if}
					</div>
					{#if github?.connected}
						<button
							class="px-3 py-1.5 rounded-md text-xs border border-border bg-transparent text-foreground-muted cursor-pointer transition-colors hover:border-destructive hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
							onclick={handleDisconnectGitHub}
							disabled={githubLoading}
						>
							{githubLoading ? 'Disconnecting...' : 'Disconnect'}
						</button>
					{:else}
						<button
							class="px-3 py-1.5 rounded-md text-xs border border-accent bg-accent text-accent-foreground cursor-pointer transition-opacity hover:opacity-90"
							onclick={handleConnectGitHub}
						>
							Connect GitHub
						</button>
					{/if}
				</div>

				{#if github?.connected}
					<p class="mt-3 text-sm text-foreground-muted">
						<a href="/deployments" class="text-accent hover:underline">Manage repositories and deployments →</a>
					</p>
				{/if}
			</section>

			<!-- API Tokens -->
			<section class="mb-8 pb-6 border-b border-border">
				<h2 class="mb-4 text-lg font-medium text-foreground">API tokens</h2>

				<p class="mb-4 text-sm text-foreground-muted leading-relaxed">
					A token lets scripts and automation call the control plane as you. It cannot change
					your password or email, and it cannot mint more tokens. See
					<code class="text-xs">AUTHENTICATION.md</code> in the petritype-server repository for
					how scripts use it and how to replace one.
				</p>

				{#if tokensError}
					<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm">{tokensError}</div>
				{/if}

				{#if createdToken}
					<div class="mb-4 p-3 rounded-md border border-accent bg-success-bg text-sm">
						<p class="mb-2 font-medium text-success">
							Token "{createdToken.name}" created. Copy it now; it is not shown again.
						</p>
						<div class="flex items-center gap-2">
							<code class="flex-1 min-w-0 px-2 py-1.5 rounded bg-surface text-foreground text-xs break-all select-all">{createdToken.token}</code>
							<button
								class="shrink-0 px-3 py-1.5 rounded-md text-xs border border-accent bg-accent text-accent-foreground cursor-pointer transition-opacity hover:opacity-90"
								onclick={handleCopyToken}
							>
								{copied ? 'Copied' : 'Copy'}
							</button>
						</div>
						<p class="mt-2 text-xs text-foreground-muted leading-relaxed">
							Scripts read it from <code>~/.config/petrify/control-plane-token</code> or the
							<code>PETRIFY_API_TOKEN</code> environment variable.
						</p>
						<button
							class="mt-2 text-xs text-foreground-faint bg-transparent border-0 p-0 cursor-pointer hover:underline"
							onclick={() => { createdToken = null; copied = false; }}
						>
							Done, hide it
						</button>
					</div>
				{/if}

				{#if tokens.length > 0}
					<ul class="mb-4 flex flex-col gap-2">
						{#each tokens as token (token.id)}
							{@const status = tokenStatus(token, tokensNow)}
							<li class="p-3 bg-muted rounded-md">
								<div class="flex items-start justify-between gap-2">
									<div class="min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-foreground truncate">{token.name}</span>
											<span class="text-xs px-2 py-0.5 rounded-sm {STATUS_BADGE[status]}">{status}</span>
											<span class="text-xs px-2 py-0.5 rounded-sm bg-border text-foreground-muted" title={describeScope(token.scope)}>{token.scope}</span>
										</div>
										<code class="text-xs text-foreground-muted">{tokenLabel(token.prefix)}</code>
									</div>
									{#if status !== 'revoked'}
										<button
											class="shrink-0 px-3 py-1.5 rounded-md text-xs border border-border bg-transparent text-foreground-muted cursor-pointer transition-colors hover:border-destructive hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
											onclick={() => handleRevokeToken(token)}
											disabled={revokingId === token.id}
										>
											{revokingId === token.id ? 'Revoking...' : 'Revoke'}
										</button>
									{/if}
								</div>
								<p class="mt-1 text-xs text-foreground-faint">
									created {formatCreated(token)} · {describeExpiry(token, tokensNow)} · {describeLastUsed(token, tokensNow)}
								</p>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="mb-4 text-sm text-foreground-faint">You have no API tokens.</p>
				{/if}

				<form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); handleCreateToken(); }}>
					<label class="flex flex-col gap-1 text-sm text-foreground-muted">
						Name
						<input
							type="text"
							bind:value={tokenName}
							required
							maxlength="100"
							placeholder="e.g. laptop scripts"
							class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent"
						/>
					</label>

					<label class="flex flex-col gap-1 text-sm text-foreground-muted">
						Expires after
						<select
							bind:value={tokenExpiryDays}
							class="px-3 py-2.5 border border-border rounded-md bg-surface text-foreground text-base focus:outline-none focus:border-accent"
						>
							{#each EXPIRY_CHOICES as choice (choice.days)}
								<option value={choice.days}>{choice.label}</option>
							{/each}
						</select>
					</label>

					<fieldset class="flex flex-col gap-1 text-sm text-foreground-muted">
						<legend class="mb-1">Scope</legend>
						{#each SCOPE_CHOICES as choice (choice.scope)}
							<label class="flex items-baseline gap-2 cursor-pointer">
								<input type="radio" name="token-scope" value={choice.scope} bind:group={tokenScope} />
								<span><span class="text-foreground">{choice.scope}</span>: {choice.description}</span>
							</label>
						{/each}
					</fieldset>

					<button type="submit" disabled={tokenLoading}
						class="w-full mt-2 py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
						{tokenLoading ? 'Creating...' : 'Create token'}
					</button>
				</form>
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

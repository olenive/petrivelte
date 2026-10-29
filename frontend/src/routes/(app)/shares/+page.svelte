<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createShare,
		deleteBundle,
		getWiring,
		listBundles,
		listShares,
		revokeShare,
		uploadBundle,
		type Bundle,
		type Share,
		type ShareCreated,
		type WiringResponse,
	} from '$lib/api';
	import { describeExpiry, describeLastUsed, formatCreated } from '$lib/apiTokens';
	import { PUBLIC_SHARE_URL } from '$lib/config/network';
	import {
		DEFAULT_EXPIRES_IN_DAYS,
		DEFAULT_INPUTS_PER_MINUTE,
		DEFAULT_MAX_VIEWERS,
		describeInputs,
		emptyShareForm,
		formatBundleSize,
		netsByWorker,
		notebookName,
		pickRefusal,
		pickedWorkers,
		shareLink,
		shareLinkBase,
		shareRequest,
		shareStatus,
		shareTokenLabel,
		togglePicked,
		withoutToken,
		worldProblem,
		type ShareForm,
		type ShareStatus,
	} from '$lib/shares';
	import { workerLabel } from '$lib/netInstances';
	import AppNav from '$lib/components/AppNav.svelte';

	const linkBase = shareLinkBase(PUBLIC_SHARE_URL, import.meta.env.PROD);

	// The list
	let shares = $state<Share[]>([]);
	let sharesLoaded = $state(false);
	let sharesError = $state('');
	let now = $state(Date.now());
	let confirmingId = $state<string | null>(null);
	let revokingId = $state<string | null>(null);

	// What the pickers choose from, and the notebook names the list shows
	let wiring = $state<WiringResponse | null>(null);
	let wiringError = $state('');

	// The owner's bundles, which the bundle picker also offers
	let bundles = $state<Bundle[]>([]);
	let bundlesLoaded = $state(false);
	let bundlesError = $state('');
	let confirmingBundleId = $state<string | null>(null);
	let deletingBundleId = $state<string | null>(null);

	// The upload form
	let bundleLabel = $state('');
	let bundleFile = $state<File | null>(null);
	let bundleFileInput = $state<HTMLInputElement | null>(null);
	let uploading = $state(false);
	let uploadError = $state('');

	// The form
	let form = $state<ShareForm>(emptyShareForm());
	let minting = $state(false);
	let mintError = $state('');
	let created = $state<ShareCreated | null>(null);
	let copied = $state(false);
	let copyError = $state('');

	const STATUS_BADGE: Record<ShareStatus, string> = {
		active: 'bg-success-bg text-success',
		expired: 'bg-error-bg text-error',
		revoked: 'bg-border text-foreground-faint',
	};

	const nets = $derived(wiring?.nets ?? []);
	const workers = $derived(wiring?.workers ?? []);
	const notebooks = $derived(wiring?.notebooks ?? []);
	const groups = $derived(netsByWorker(nets, workers));
	const picked = $derived(pickedWorkers(form.netIds, nets));
	const activeCount = $derived(shares.filter((s) => shareStatus(s, now) === 'active').length);
	const createdText = $derived(
		created ? (linkBase.base !== null ? shareLink(linkBase.base, created.token) : created.token) : '',
	);

	const inputClass =
		'px-3 py-2 border border-border rounded-md bg-surface text-foreground text-sm focus:outline-none focus:border-accent';

	onMount(() => {
		void loadShares();
		void loadWiring();
		void loadBundles();
	});

	async function loadShares() {
		try {
			shares = await listShares();
			now = Date.now();
			sharesError = '';
		} catch (e) {
			sharesError = e instanceof Error ? e.message : String(e);
		} finally {
			sharesLoaded = true;
		}
	}

	async function loadWiring() {
		try {
			wiring = await getWiring();
			wiringError = '';
		} catch (e) {
			wiringError = e instanceof Error ? e.message : String(e);
		}
	}

	async function loadBundles() {
		try {
			bundles = await listBundles();
			bundlesError = '';
		} catch (e) {
			bundlesError = e instanceof Error ? e.message : String(e);
		} finally {
			bundlesLoaded = true;
		}
	}

	/** The row's last line: dates, use and the share's policy. */
	function facts(share: Share): string[] {
		return [
			`created ${formatCreated(share)}`,
			describeExpiry(share, now),
			describeLastUsed(share, now),
			`payloads ${share.publish_payloads ? 'published' : 'hidden'}`,
			`up to ${share.max_viewers} viewers`,
			...(share.scope === 'play' ? [`${share.inputs_per_minute} inputs a minute`] : []),
		];
	}

	/** A bundle row's last line. */
	function bundleFacts(bundle: Bundle): string[] {
		return [
			`${formatBundleSize(bundle.size_bytes)} uncompressed`,
			`${bundle.file_count} file${bundle.file_count === 1 ? '' : 's'}`,
			`uploaded ${formatCreated(bundle)}`,
		];
	}

	/** A picked net of the mint form by name, from the wiring view the picker lists. */
	function netName(netId: string): string {
		return nets.find((n) => n.id === netId)?.instance_name ?? netId.slice(0, 8);
	}

	async function handleMint() {
		mintError = '';
		created = null;
		copied = false;
		copyError = '';
		minting = true;
		try {
			const answer = await createShare(shareRequest(form));
			created = answer;
			shares = [withoutToken(answer), ...shares.filter((s) => s.id !== answer.id)];
			now = Date.now();
			void loadShares();
		} catch (e) {
			mintError = e instanceof Error ? e.message : String(e);
		} finally {
			minting = false;
		}
	}

	async function handleRevoke(share: Share) {
		sharesError = '';
		revokingId = share.id;
		try {
			await revokeShare(share.id);
			if (created?.id === share.id) created = null;
			confirmingId = null;
			await loadShares();
		} catch (e) {
			sharesError = e instanceof Error ? e.message : String(e);
		} finally {
			revokingId = null;
		}
	}

	async function handleUpload() {
		if (bundleFile === null) return;
		uploadError = '';
		uploading = true;
		try {
			const uploaded = await uploadBundle(bundleLabel, bundleFile);
			bundles = [uploaded, ...bundles.filter((b) => b.id !== uploaded.id)];
			bundleLabel = '';
			bundleFile = null;
			if (bundleFileInput) bundleFileInput.value = '';
		} catch (e) {
			uploadError = e instanceof Error ? e.message : String(e);
		} finally {
			uploading = false;
		}
	}

	async function handleDeleteBundle(bundle: Bundle) {
		bundlesError = '';
		deletingBundleId = bundle.id;
		try {
			await deleteBundle(bundle.id);
			bundles = bundles.filter((b) => b.id !== bundle.id);
			if (form.bundleId === bundle.id) form.bundleId = null;
			confirmingBundleId = null;
			// The server takes the bundle off every share that named it.
			void loadShares();
		} catch (e) {
			bundlesError = e instanceof Error ? e.message : String(e);
		} finally {
			deletingBundleId = null;
		}
	}

	async function handleCopy() {
		if (!createdText) return;
		copyError = '';
		try {
			await navigator.clipboard.writeText(createdText);
			copied = true;
		} catch {
			copyError = 'Could not copy automatically; select the text and copy it by hand.';
		}
	}

	function hideCreated() {
		created = null;
		copied = false;
		copyError = '';
	}
</script>

<svelte:head>
	<title>Shares · Petri</title>
</svelte:head>

<AppNav title="Shares" />

<div class="max-w-[900px] mx-auto p-8 flex flex-col gap-8">
	<p class="text-sm text-foreground-muted leading-relaxed">
		A share opens a world of your nets, or one notebook, to people outside your account. They
		open its link on the public tier, never this app, and a share never loads, starts or creates
		anything: viewers see what you have running.
	</p>

	<!-- New share -->
	<section class="bg-card border border-border rounded-lg p-6" data-testid="share-form">
		<h2 class="mb-4 text-lg font-medium text-foreground">New share</h2>

		<form class="flex flex-col gap-5" novalidate onsubmit={(e) => { e.preventDefault(); void handleMint(); }}>
			<label class="flex flex-col gap-1 text-sm text-foreground-muted">
				Label
				<input type="text" name="share-label" bind:value={form.label} placeholder="e.g. game night, north seat" class={inputClass} />
			</label>

			<fieldset class="flex flex-col gap-1 text-sm text-foreground-muted">
				<legend class="mb-1">What it opens</legend>
				<label class="flex items-baseline gap-2 cursor-pointer">
					<input type="radio" name="share-kind" value="world" bind:group={form.resourceKind} />
					<span><span class="text-foreground">world</span>: one or more nets on one worker</span>
				</label>
				<label class="flex items-baseline gap-2 cursor-pointer">
					<input type="radio" name="share-kind" value="notebook" bind:group={form.resourceKind} />
					<span><span class="text-foreground">notebook</span>: one notebook, to read</span>
				</label>
			</fieldset>

			{#if wiringError}
				<div class="px-3 py-2.5 rounded-md bg-error-bg text-error text-sm flex items-center justify-between gap-2">
					<span>Could not load your nets and notebooks: {wiringError}</span>
					<button type="button" class="shrink-0 text-xs underline bg-transparent border-0 cursor-pointer text-error" onclick={() => void loadWiring()}>Retry</button>
				</div>
			{/if}

			{#if form.resourceKind === 'world'}
				<fieldset class="flex flex-col gap-3 text-sm text-foreground-muted" data-testid="share-net-picker">
					<legend class="mb-1">Nets</legend>
					{#if !wiring && !wiringError}
						<p class="text-foreground-faint">Loading your nets...</p>
					{:else if wiring && groups.length === 0}
						<p class="text-foreground-faint">You have no nets yet.</p>
					{/if}
					{#each groups as group (group.workerId ?? '')}
						{@const refusal = pickRefusal(group.workerId, picked)}
						<div class="p-3 rounded-md bg-muted" data-testid="share-worker-group">
							<div class="mb-1 flex items-baseline gap-2">
								<span class="text-foreground font-medium">{group.workerId ? group.label : 'No worker'}</span>
								{#if refusal}
									<span class="text-xs text-foreground-faint">{refusal}</span>
								{/if}
							</div>
							<ul class="flex flex-col gap-1">
								{#each group.nets as net (net.id)}
									{@const isPicked = form.netIds.includes(net.id)}
									<li>
										<label class="flex items-baseline gap-2 {refusal && !isPicked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}">
											<input
												type="checkbox"
												value={net.id}
												checked={isPicked}
												disabled={refusal !== null && !isPicked}
												onchange={(e) => { form.netIds = togglePicked(form.netIds, net.id, e.currentTarget.checked); }}
											/>
											<span class="text-foreground">{net.instance_name}</span>
											<span class="text-xs text-foreground-faint">{net.definition_name}</span>
											<span class="text-xs px-1.5 py-0.5 rounded-sm bg-border text-foreground-muted">{net.load_state}</span>
										</label>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				</fieldset>

				<label class="flex flex-col gap-1 text-sm text-foreground-muted" data-testid="share-bundle-picker">
					Bundle
					<select name="share-bundle" bind:value={form.bundleId} class="{inputClass} w-full max-w-sm">
						<option value={null}>none</option>
						{#each bundles as bundle (bundle.id)}
							<option value={bundle.id}>{bundle.label}</option>
						{/each}
					</select>
					<span class="text-xs text-foreground-faint">
						Optional: a game or viewer from your bundles below, served beside the world under its link.
					</span>
				</label>
			{:else}
				<fieldset class="flex flex-col gap-1 text-sm text-foreground-muted" data-testid="share-notebook-picker">
					<legend class="mb-1">Notebook</legend>
					{#if !wiring && !wiringError}
						<p class="text-foreground-faint">Loading your notebooks...</p>
					{:else if wiring && notebooks.length === 0}
						<p class="text-foreground-faint">You have no notebooks yet.</p>
					{/if}
					{#each notebooks as notebook (notebook.id)}
						<label class="flex items-baseline gap-2 cursor-pointer">
							<input type="radio" name="share-notebook" value={notebook.id} bind:group={form.notebookId} />
							<span class="text-foreground">{notebook.instance_name || notebook.definition_name}</span>
							<span class="text-xs text-foreground-faint">{notebook.definition_name} · {workerLabel(notebook.worker_id, workers)}</span>
							<span class="text-xs px-1.5 py-0.5 rounded-sm bg-border text-foreground-muted">{notebook.load_state}</span>
						</label>
					{/each}
				</fieldset>
			{/if}

			<fieldset class="flex flex-col gap-1 text-sm text-foreground-muted">
				<legend class="mb-1">Scope</legend>
				<label class="flex items-baseline gap-2 cursor-pointer">
					<input type="radio" name="share-scope" value="read" bind:group={form.scope} />
					<span><span class="text-foreground">read</span>: viewers watch, and change nothing</span>
				</label>
				<label class="flex items-baseline gap-2 cursor-pointer">
					<input type="radio" name="share-scope" value="play" bind:group={form.scope} />
					<span><span class="text-foreground">play</span>: the holder may also put tokens into the places and press the controls you list, each input stamped with the seat</span>
				</label>
			</fieldset>

			{#if form.scope === 'play'}
				<div class="flex flex-col gap-3 pl-4 border-l-2 border-border" data-testid="share-play-fields">
					<label class="flex flex-col gap-1 text-sm text-foreground-muted">
						Seat
						<input type="text" name="share-seat" bind:value={form.seat} placeholder="e.g. north, or the player's email" class={inputClass} />
						<span class="text-xs text-foreground-faint">The name your net reads as the player on every input from this share.</span>
					</label>
					{#if form.resourceKind === 'world'}
						{#each form.netIds as netId (netId)}
							<div class="flex flex-col gap-2 p-3 rounded-md bg-muted" data-testid="share-play-net">
								<span class="text-sm text-foreground font-medium">{netName(netId)}</span>
								<label class="flex flex-col gap-1 text-xs text-foreground-muted">
									Play places, comma separated
									<input type="text" name="play-places-{netId}" bind:value={form.playPlaces[netId]} placeholder="e.g. moves, chat" class={inputClass} />
								</label>
								<label class="flex flex-col gap-1 text-xs text-foreground-muted">
									Play controls, comma separated
									<input type="text" name="play-controls-{netId}" bind:value={form.playControls[netId]} placeholder="e.g. resign" class={inputClass} />
								</label>
							</div>
						{:else}
							<p class="text-xs text-foreground-faint">Pick a net to list its places and controls.</p>
						{/each}
					{/if}
				</div>
			{/if}

			<fieldset class="flex flex-col gap-1 text-sm text-foreground-muted">
				<legend class="mb-1">Audience</legend>
				<label class="flex items-baseline gap-2 cursor-pointer">
					<input type="radio" name="share-audience" value="link" bind:group={form.audience} />
					<span><span class="text-foreground">link</span>: anyone holding the link</span>
				</label>
				<label class="flex items-baseline gap-2 cursor-pointer">
					<input type="radio" name="share-audience" value="named" bind:group={form.audience} />
					<span><span class="text-foreground">named</span>: one person, recorded by email</span>
				</label>
			</fieldset>

			{#if form.audience === 'named'}
				<label class="flex flex-col gap-1 text-sm text-foreground-muted pl-4 border-l-2 border-border">
					Member email
					<input type="email" name="share-member-email" bind:value={form.memberEmail} autocomplete="off" class={inputClass} />
				</label>
			{/if}

			<label class="flex flex-col gap-1 text-sm text-foreground-muted">
				Expires after, in days
				<input type="number" name="share-expires-in-days" bind:value={form.expiresInDays} placeholder={String(DEFAULT_EXPIRES_IN_DAYS)} class="{inputClass} w-32" />
				<span class="text-xs text-foreground-faint">1 to 365. Left empty, {DEFAULT_EXPIRES_IN_DAYS}.</span>
			</label>

			<label class="flex items-baseline gap-2 text-sm text-foreground-muted cursor-pointer">
				<input type="checkbox" name="share-publish-payloads" bind:checked={form.publishPayloads} />
				<span>
					<span class="text-foreground">Publish payloads</span>
					<span class="block text-xs text-foreground-faint">Off hides token values and log lines from viewers; they still see counts and firings.</span>
				</span>
			</label>

			<details class="text-sm text-foreground-muted">
				<summary class="cursor-pointer select-none">Advanced</summary>
				<div class="mt-3 flex flex-col gap-3">
					<label class="flex flex-col gap-1">
						Max viewers
						<input type="number" name="share-max-viewers" bind:value={form.maxViewers} placeholder={String(DEFAULT_MAX_VIEWERS)} class="{inputClass} w-32" />
						<span class="text-xs text-foreground-faint">1 to 200. Left empty, {DEFAULT_MAX_VIEWERS}.</span>
					</label>
					<label class="flex flex-col gap-1">
						Inputs per minute
						<input type="number" name="share-inputs-per-minute" bind:value={form.inputsPerMinute} placeholder={String(DEFAULT_INPUTS_PER_MINUTE)} class="{inputClass} w-32" />
						<span class="text-xs text-foreground-faint">1 to 600, for the seat across the world's nets. Left empty, {DEFAULT_INPUTS_PER_MINUTE}.</span>
					</label>
				</div>
			</details>

			{#if mintError}
				<div class="px-3 py-2.5 rounded-md bg-error-bg text-error text-sm" role="alert" data-testid="share-mint-error">{mintError}</div>
			{/if}

			<button type="submit" disabled={minting}
				class="w-full py-2.5 border border-accent rounded-md bg-accent text-accent-foreground text-base font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
				{minting ? 'Creating...' : 'Create share'}
			</button>
		</form>

		{#if created}
			<div class="mt-4 p-3 rounded-md border border-accent bg-success-bg text-sm" data-testid="share-created">
				<p class="mb-2 font-medium text-success">
					Share "{created.label}" created. Copy its {linkBase.base !== null ? 'link' : 'token'} now: it is shown only once.
				</p>
				<div class="flex items-center gap-2">
					<code class="flex-1 min-w-0 px-2 py-1.5 rounded bg-surface text-foreground text-xs break-all select-all" data-testid="share-created-text">{createdText}</code>
					<button
						type="button"
						class="shrink-0 px-3 py-1.5 rounded-md text-xs border border-accent bg-accent text-accent-foreground cursor-pointer transition-opacity hover:opacity-90"
						onclick={() => void handleCopy()}
					>
						{copied ? 'Copied' : 'Copy'}
					</button>
				</div>
				{#if linkBase.problem !== null}
					<p class="mt-2 text-xs text-foreground-muted leading-relaxed" data-testid="share-link-unconfigured">
						The public tier's address is not configured ({linkBase.problem}), so this is the share's
						token rather than its link. The link is the public tier's address followed by
						<code>/s/</code> and this token.
					</p>
				{/if}
				{#if copyError}
					<p class="mt-2 text-xs text-error">{copyError}</p>
				{/if}
				<button
					type="button"
					class="mt-2 text-xs text-foreground-faint bg-transparent border-0 p-0 cursor-pointer hover:underline"
					onclick={hideCreated}
				>
					Done, hide it
				</button>
			</div>
		{/if}
	</section>

	<!-- The owner's shares -->
	<section data-testid="share-list">
		<div class="mb-3 flex items-baseline justify-between gap-2">
			<h2 class="text-lg font-medium text-foreground">Your shares</h2>
			{#if sharesLoaded && !sharesError}
				<span class="text-sm text-foreground-muted">
					{shares.length} share{shares.length === 1 ? '' : 's'} · {activeCount} active
				</span>
			{/if}
		</div>

		{#if sharesError}
			<div class="mb-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm" role="alert">{sharesError}</div>
		{/if}

		{#if !sharesLoaded}
			<p class="text-sm text-foreground-faint">Loading...</p>
		{:else if shares.length === 0 && !sharesError}
			<p class="text-sm text-foreground-faint">You have no shares.</p>
		{:else}
			<ul class="flex flex-col gap-2">
				{#each shares as share (share.id)}
					{@const status = shareStatus(share, now)}
					{@const problem = status === 'active' ? worldProblem(share) : null}
					<li
						class="p-3 rounded-md bg-muted border border-border {status === 'active' ? '' : 'opacity-60'}"
						data-testid="share-row"
						data-status={status}
					>
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0 flex flex-col gap-1">
								<div class="flex flex-wrap items-center gap-2">
									<span class="text-foreground font-medium truncate">{share.label}</span>
									<span class="text-xs px-2 py-0.5 rounded-sm {STATUS_BADGE[status]}" data-testid="share-status">{status}</span>
									<span class="text-xs px-2 py-0.5 rounded-sm bg-border text-foreground-muted">{share.scope}</span>
									<span class="text-xs px-2 py-0.5 rounded-sm bg-border text-foreground-muted">{share.audience}</span>
								</div>
								<p class="text-sm text-foreground-muted" data-testid="share-resource">
									{#if share.resource_kind === 'world'}
										world: {share.nets.map((n) => n.instance_name).join(', ') || 'no nets'}
									{:else if share.resource_kind === 'notebook' && share.notebook_id}
										notebook: {notebookName(share.notebook_id, notebooks)}
									{:else}
										{share.resource_kind}
									{/if}
								</p>
								{#if share.bundle_label}
									<p class="text-xs text-foreground-muted" data-testid="share-bundle">bundle <span class="text-foreground">{share.bundle_label}</span></p>
								{/if}
								{#if share.audience === 'named' && share.member_email}
									<p class="text-xs text-foreground-muted">for {share.member_email}</p>
								{/if}
								{#if share.scope === 'play'}
									<p class="text-xs text-foreground-muted">seat <span class="text-foreground">{share.seat}</span></p>
									{#each share.nets as shared (shared.net_id)}
										{@const inputs = describeInputs(shared)}
										{#if inputs}
											<p class="text-xs text-foreground-faint">{shared.instance_name}: {inputs}</p>
										{/if}
									{/each}
								{/if}
								{#if problem}
									<p class="text-xs text-status-warning">{problem}</p>
								{/if}
								<code class="text-xs text-foreground-muted">{shareTokenLabel(share.prefix)}</code>
							</div>
							{#if status === 'active'}
								<div class="shrink-0 flex flex-col items-end gap-1">
									{#if confirmingId === share.id}
										<span class="text-xs text-foreground-muted text-right max-w-[220px]">Revoke it? Anyone holding its link loses access, and it cannot be restored.</span>
										<div class="flex gap-2">
											<button
												type="button"
												class="px-3 py-1.5 rounded-md text-xs font-medium border border-destructive bg-transparent text-destructive cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
												onclick={() => void handleRevoke(share)}
												disabled={revokingId === share.id}
											>
												{revokingId === share.id ? 'Revoking...' : 'Yes, revoke'}
											</button>
											<button
												type="button"
												class="px-3 py-1.5 rounded-md text-xs border border-border bg-transparent text-foreground-muted cursor-pointer hover:text-foreground"
												onclick={() => { confirmingId = null; }}
												disabled={revokingId === share.id}
											>
												Cancel
											</button>
										</div>
									{:else}
										<button
											type="button"
											class="px-3 py-1.5 rounded-md text-xs border border-border bg-transparent text-foreground-muted cursor-pointer transition-colors hover:border-destructive hover:text-destructive"
											onclick={() => { confirmingId = share.id; }}
										>
											Revoke
										</button>
									{/if}
								</div>
							{/if}
						</div>
						<p class="mt-1 text-xs text-foreground-faint">{facts(share).join(' · ')}</p>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- The owner's bundles -->
	<section class="bg-card border border-border rounded-lg p-6" data-testid="bundles">
		<div class="mb-4 flex items-baseline justify-between gap-2">
			<h2 class="text-lg font-medium text-foreground">Bundles</h2>
			{#if bundlesLoaded && !bundlesError}
				<span class="text-sm text-foreground-muted">{bundles.length} bundle{bundles.length === 1 ? '' : 's'}</span>
			{/if}
		</div>

		<form class="flex flex-col gap-3" novalidate onsubmit={(e) => { e.preventDefault(); void handleUpload(); }} data-testid="bundle-form">
			<div class="flex flex-wrap items-end gap-3">
				<label class="flex flex-col gap-1 text-sm text-foreground-muted flex-1 min-w-[200px]">
					Label
					<input type="text" name="bundle-label" bind:value={bundleLabel} placeholder="e.g. chess board" disabled={uploading} class={inputClass} />
				</label>
				<label class="flex flex-col gap-1 text-sm text-foreground-muted">
					Zip file
					<input
						type="file"
						name="bundle-file"
						accept=".zip,application/zip"
						bind:this={bundleFileInput}
						disabled={uploading}
						onchange={(e) => { bundleFile = e.currentTarget.files?.[0] ?? null; }}
						class="text-sm text-foreground file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border file:border-border file:bg-surface file:text-foreground file:cursor-pointer"
					/>
				</label>
				<button type="submit" disabled={uploading || bundleFile === null}
					class="px-4 py-2 border border-accent rounded-md bg-accent text-accent-foreground text-sm font-semibold cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
					{uploading ? 'Uploading...' : 'Upload'}
				</button>
			</div>
			{#if uploading && bundleFile}
				<p class="text-xs text-foreground-muted" role="status" data-testid="bundle-uploading">
					Uploading {bundleFile.name}, {formatBundleSize(bundleFile.size)}...
				</p>
			{/if}
			{#if uploadError}
				<div class="px-3 py-2.5 rounded-md bg-error-bg text-error text-sm" role="alert" data-testid="bundle-upload-error">{uploadError}</div>
			{/if}
			<p class="text-xs text-foreground-faint">
				A bundle is a zip with <code>index.html</code> at its root, at most 64 MiB, served beside a shared world.
			</p>
		</form>

		{#if bundlesError}
			<div class="mt-4 px-3 py-2.5 rounded-md bg-error-bg text-error text-sm flex items-center justify-between gap-2" role="alert">
				<span>{bundlesError}</span>
				<button type="button" class="shrink-0 text-xs underline bg-transparent border-0 cursor-pointer text-error" onclick={() => void loadBundles()}>Retry</button>
			</div>
		{/if}

		<div class="mt-4">
			{#if !bundlesLoaded}
				<p class="text-sm text-foreground-faint">Loading...</p>
			{:else if bundles.length === 0 && !bundlesError}
				<p class="text-sm text-foreground-faint">You have no bundles.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each bundles as bundle (bundle.id)}
						<li class="p-3 rounded-md bg-muted border border-border" data-testid="bundle-row">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex flex-col gap-1">
									<span class="text-foreground font-medium truncate">{bundle.label}</span>
									<p class="text-xs text-foreground-faint">{bundleFacts(bundle).join(' · ')}</p>
								</div>
								<div class="shrink-0 flex flex-col items-end gap-1">
									{#if confirmingBundleId === bundle.id}
										<span class="text-xs text-foreground-muted text-right max-w-[220px]">Delete it? Shares that serve it carry on without it, and it cannot be restored.</span>
										<div class="flex gap-2">
											<button
												type="button"
												class="px-3 py-1.5 rounded-md text-xs font-medium border border-destructive bg-transparent text-destructive cursor-pointer transition-all hover:bg-destructive-hover hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
												onclick={() => void handleDeleteBundle(bundle)}
												disabled={deletingBundleId === bundle.id}
											>
												{deletingBundleId === bundle.id ? 'Deleting...' : 'Yes, delete'}
											</button>
											<button
												type="button"
												class="px-3 py-1.5 rounded-md text-xs border border-border bg-transparent text-foreground-muted cursor-pointer hover:text-foreground"
												onclick={() => { confirmingBundleId = null; }}
												disabled={deletingBundleId === bundle.id}
											>
												Cancel
											</button>
										</div>
									{:else}
										<button
											type="button"
											class="px-3 py-1.5 rounded-md text-xs border border-border bg-transparent text-foreground-muted cursor-pointer transition-colors hover:border-destructive hover:text-destructive"
											onclick={() => { confirmingBundleId = bundle.id; }}
										>
											Delete
										</button>
									{/if}
								</div>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>
</div>

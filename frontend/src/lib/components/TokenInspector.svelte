<script lang="ts">
	import { tick } from 'svelte';
	import type { InnerNetRef, KeyValue, MarkingToken, NetAddress, TokenValue } from '$lib/types';
	import type { MirrorPlace } from '$lib/netMirror';
	import { getToken } from '$lib/api';
	import { NO_FILTER, isActive, tokenMatches, valueText, type TokenFilter } from '$lib/tokenFilter';

	export let netId: string | null = null;
	/** The net's generation: token ids are unique within one, so the cache
	 *  of full views is keyed by it and the id together. */
	export let generation: number = 0;
	/** The inner net shown, if one is: its token ids are its own, so they are
	 *  read with its address and cached under it. */
	export let address: NetAddress | undefined = undefined;
	/** Every place, in topology order, with its true count and capped list. */
	export let places: MirrorPlace[] = [];
	export let selectedTokenId: string | null = null;
	export let onTokenSelect: ((tokenId: string | null) => void) | null = null;
	/** The view's token filter: the lists show only the tokens it lets through. */
	export let filter: TokenFilter = NO_FILTER;
	/** Open one of a token's nets; null where opening goes no further (an
	 *  inner net's tokens: one level for now). */
	export let onOpenNet: ((net: InnerNetRef) => void) | null = null;
	/** Said under a token's nets where they cannot be opened. */
	export let nestedNote: string | null = null;

	// Tab index: 0 = "All Tokens", 1+ = individual places
	let selectedTabIndex = 0;

	// Full views, fetched on selection, keyed by (generation, id). An id is
	// never reused within a generation, so a cached view stays right for as
	// long as the token lives; a new generation starts the cache over.
	let fullViews = new Map<string, TokenValue>();
	let cachedGeneration = generation;
	let fullViewError: string | null = null;
	let fullViewLoading = false;
	let fullViewKey: string | null = null;

	const keyOf = (id: string) => `${generation}:${address?.nested_id ?? ''}:${id}`;

	$: if (generation !== cachedGeneration) {
		cachedGeneration = generation;
		fullViews = new Map();
		fullViewKey = null;
		fullViewError = null;
		fullViewLoading = false;
	}

	$: totalCount = places.reduce((sum, place) => sum + place.count, 0);
	$: listedCount = places.reduce((sum, place) => sum + place.tokens.length, 0);
	$: filtering = isActive(filter);

	function hiddenCount(place: MirrorPlace): number {
		return Math.max(0, place.count - place.tokens.length);
	}

	/** The listed tokens of a place the filter lets through. */
	function shown(place: MirrorPlace, current: TokenFilter): MarkingToken[] {
		return isActive(current) ? place.tokens.filter((token) => tokenMatches(current, token)) : place.tokens;
	}

	function keyRows(token: MarkingToken): Array<[string, KeyValue]> {
		return token.keys ? Object.entries(token.keys) : [];
	}

	function openNet(event: MouseEvent, net: InnerNetRef) {
		event.stopPropagation();
		onOpenNet?.(net);
	}

	function cardKey(event: KeyboardEvent, tokenId: string) {
		if (event.target !== event.currentTarget) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleTokenCardClick(tokenId);
		}
	}

	function placeTabLabel(place: MirrorPlace): string {
		return place.count > place.tokens.length ? `${place.tokens.length} of ${place.count}` : `${place.count}`;
	}

	function typeOf(token: MarkingToken, place: MirrorPlace): string {
		return token.type_name ?? place.type_name ?? '';
	}

	// When selectedTokenId changes externally, find the containing place and switch tab
	$: if (selectedTokenId) {
		const placeIndex = places.findIndex((p) => p.tokens.some((t) => t.id === selectedTokenId));
		if (placeIndex !== -1) {
			// Switch to the place tab (index + 1 because 0 is "All Tokens")
			selectedTabIndex = placeIndex + 1;
			// Scroll to the token card after DOM updates
			tick().then(() => {
				const card = document.querySelector(`[data-token-card-id="${selectedTokenId}"]`);
				if (card) {
					card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				}
			});
		}
		void loadFullView(selectedTokenId);
	} else {
		fullViewKey = null;
		fullViewError = null;
	}

	async function loadFullView(tokenId: string) {
		if (!netId) return;
		const key = keyOf(tokenId);
		if (fullViewKey === key && (fullViews.has(key) || fullViewLoading)) return;
		fullViewKey = key;
		fullViewError = null;
		if (fullViews.has(key)) return;
		fullViewLoading = true;
		try {
			const view = await getToken(netId, tokenId, address);
			fullViews = new Map(fullViews).set(key, view);
		} catch (err) {
			if (fullViewKey === key) {
				fullViewError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			if (fullViewKey === key) {
				fullViewLoading = false;
			}
		}
	}

	function handleTokenCardClick(tokenId: string) {
		if (onTokenSelect) {
			onTokenSelect(tokenId);
		}
	}

	function formatFullView(view: TokenValue): string {
		if (view.kind === 'json') {
			return JSON.stringify(view.value, null, 2);
		}
		return view.text;
	}

	$: shownView = fullViewKey ? fullViews.get(fullViewKey) ?? null : null;
</script>

{#snippet card(token: MarkingToken, place: MirrorPlace)}
	<!-- A div, not a button: a token that holds nets carries Open buttons. -->
	<div
		class="token-card"
		class:selected={token.id === selectedTokenId}
		data-token-card-id={token.id}
		role="button"
		tabindex="0"
		on:click={() => handleTokenCardClick(token.id)}
		on:keydown={(event) => cardKey(event, token.id)}
	>
		<div class="token-header">
			<span class="token-id">#{token.id}</span>
			<span class="token-type">{typeOf(token, place)}</span>
		</div>
		{#if keyRows(token).length > 0}
			<!-- The token's keys (protocol §13.1), one row each. -->
			<div class="token-keys">
				{#each keyRows(token) as [name, value] (name)}
					<div class="key-row" data-key-name={name}>
						<span class="key-name">{name}</span>
						<span class="key-value">{valueText(value)}</span>
					</div>
				{/each}
			</div>
		{/if}
		{#if token.nets && token.nets.length > 0}
			<!-- The nets the token holds (protocol §12.2). -->
			<div class="token-nets">
				{#each token.nets as net (net.nested_id)}
					<div class="net-row" data-net-id={net.nested_id}>
						<span class="net-name">{net.name || '(the token itself)'}</span>
						{#if net.template}<span class="net-template">{net.template}</span>{/if}
						<span class="net-count" title="Tokens in all its places">{net.count}</span>
						{#if onOpenNet}
							<button type="button" class="net-open" data-open-net={net.nested_id} on:click={(event) => openNet(event, net)}>Open</button>
						{/if}
					</div>
				{/each}
				{#if !onOpenNet && nestedNote}
					<div class="muted" data-nested-note>{nestedNote}</div>
				{/if}
			</div>
		{/if}
		{#if token.id === selectedTokenId}
			{#if fullViewLoading && !shownView}
				<div class="muted">Loading…</div>
			{:else if fullViewError}
				<pre class="error">Failed to load full view: {fullViewError}</pre>
				<pre>{token.label}</pre>
			{:else if shownView && shownView.id === token.id}
				<pre data-token-view={shownView.kind}>{formatFullView(shownView)}</pre>
			{:else}
				<pre>{token.label}</pre>
			{/if}
		{:else}
			<pre>{token.label}</pre>
		{/if}
	</div>
{/snippet}

{#snippet filteredOut(place: MirrorPlace)}
	{#if filtering && shown(place, filter).length < place.tokens.length}
		<div class="truncated" data-filtered-out={place.name}>
			{place.tokens.length - shown(place, filter).length} hidden by the filter
		</div>
	{/if}
{/snippet}

<div class="token-inspector">
	<!-- Tab buttons -->
	<div class="tabs">
		<!-- All Tokens tab -->
		<button
			class="tab"
			class:active={selectedTabIndex === 0}
			on:click={() => (selectedTabIndex = 0)}
		>
			All ({totalCount})
		</button>
		<!-- Individual place tabs -->
		{#each places as place, i (place.name)}
			<button
				class="tab"
				class:active={selectedTabIndex === i + 1}
				on:click={() => (selectedTabIndex = i + 1)}
			>
				{place.name} ({placeTabLabel(place)})
			</button>
		{/each}
	</div>

	<!-- Tab content -->
	<div class="tab-content">
		{#if selectedTabIndex === 0}
			<!-- All Tokens tab content -->
			{#if listedCount > 0}
				{#each places as place (place.name)}
					{#if place.tokens.length > 0}
						<div class="place-section">
							<div class="place-info">
								<strong>{place.name}</strong>
								<span class="type">{place.type_name ?? ''}</span>
							</div>
							{#each shown(place, filter) as token (token.id)}
								{@render card(token, place)}
							{/each}
							{@render filteredOut(place)}
							{#if hiddenCount(place) > 0}
								<div class="truncated">
									{hiddenCount(place)} more not shown
								</div>
							{/if}
						</div>
					{/if}
				{/each}
			{:else if totalCount > 0}
				<div class="empty">{totalCount} tokens, none listed</div>
			{:else}
				<div class="empty">No tokens in the graph</div>
			{/if}
		{:else if places[selectedTabIndex - 1]}
			<!-- Individual place tab content -->
			{@const place = places[selectedTabIndex - 1]}
			<div class="place-info">
				<strong>{place.name}</strong>
				<span class="type">{place.type_name ?? ''}</span>
			</div>

			{#if place.tokens.length > 0}
				{#each shown(place, filter) as token (token.id)}
					{@render card(token, place)}
				{/each}
				{@render filteredOut(place)}
				{#if hiddenCount(place) > 0}
					<div class="truncated">
						{hiddenCount(place)} more not shown
					</div>
				{/if}
			{:else}
				<div class="empty">No tokens in this place</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.token-inspector {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow: hidden;
		background: var(--bg-secondary);
	}

	.tabs {
		display: flex;
		gap: 0.25rem;
		padding: 0.5rem;
		background: var(--bg-tertiary);
		border-bottom: 1px solid var(--border-color);
		overflow-x: auto;
		flex-shrink: 0;
	}

	.tab {
		padding: 0.4rem 0.75rem;
		border: 1px solid var(--border-color);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 4px;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.2s;
		font-size: 0.8rem;
	}

	.tab:hover {
		background: var(--bg-hover);
	}

	.tab.active {
		background: var(--button-border);
		color: white;
		border-color: var(--button-border);
	}

	.tab-content {
		flex: 1;
		overflow-y: auto;
		padding: 0.75rem;
		background: var(--bg-secondary);
	}

	.place-section {
		margin-bottom: 1rem;
	}

	.place-section:last-child {
		margin-bottom: 0;
	}

	.place-info {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--border-light);
		color: var(--text-primary);
	}

	.type {
		color: var(--text-secondary);
		font-size: 0.9em;
	}

	.token-card {
		display: block;
		width: 100%;
		margin-bottom: 0.75rem;
		padding: 0.5rem;
		background: var(--bg-tertiary);
		border-radius: 4px;
		border: 2px solid transparent;
		border-left: 3px solid var(--button-border);
		cursor: pointer;
		text-align: left;
		transition: all 0.2s;
	}

	.token-card:hover {
		background: var(--bg-hover);
		border-color: var(--border-color);
		border-left-color: var(--button-border);
	}

	.token-card.selected {
		border-color: var(--token-selection-color);
		border-left-color: var(--token-selection-color);
		box-shadow: 0 0 8px var(--token-selection-glow);
	}

	.token-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.25rem;
	}

	.token-id {
		font-weight: bold;
		font-size: 0.8em;
		color: var(--button-border);
	}

	.token-type {
		font-size: 0.75em;
		color: var(--text-secondary);
	}

	.muted {
		font-size: 0.8em;
		color: var(--text-secondary);
		padding: 0.25rem 0;
	}

	pre.error {
		color: #ef4444;
	}

	pre {
		font-size: 0.8em;
		overflow-x: auto;
		margin: 0;
		color: var(--text-primary);
	}

	.token-keys,
	.token-nets {
		margin: 0.25rem 0;
		font-size: 0.75em;
	}

	.key-row,
	.net-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.1rem 0;
	}

	.key-name {
		min-width: 5rem;
		color: var(--text-secondary);
	}

	.key-value {
		font-family: monospace;
		color: var(--text-primary);
	}

	.net-name {
		font-weight: bold;
		color: var(--text-primary);
	}

	.net-template {
		color: var(--text-secondary);
	}

	.net-count {
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--token-badge-fill);
		color: var(--token-badge-text);
		font-weight: bold;
	}

	.net-open {
		margin-left: auto;
		padding: 0.1rem 0.5rem;
		border: 1px solid var(--button-border);
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--button-text);
		cursor: pointer;
		font-size: 1em;
	}

	.net-open:hover {
		background: var(--button-hover-bg);
		color: var(--button-hover-text);
	}

	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-tertiary);
	}

	/* A state read lists each place's oldest tokens up to a cap; say so rather
	   than letting the list just stop. */
	.truncated {
		padding: 0.5rem;
		text-align: center;
		font-size: 0.75rem;
		font-style: italic;
		color: var(--text-tertiary);
	}
</style>

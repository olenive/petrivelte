<script lang="ts">
	import { tick } from 'svelte';
	import type { Token, Place } from '$lib/types';
	import { getToken, type TokenView } from '$lib/api';

	export let netId: string | null = null;
	export let tokens: Token[] = [];
	export let places: Place[] = [];
	export let selectedTokenId: string | null = null;
	export let onTokenSelect: ((tokenId: string | null) => void) | null = null;

	// Tab index: 0 = "All Tokens", 1+ = individual places
	let selectedTabIndex = 0;

	// Full-view cache: only fetched on selection. Keyed by token id.
	// Cleared whenever the token set changes so we don't show stale data
	// for an id whose underlying token was consumed and replaced.
	let fullView: TokenView | null = null;
	let fullViewError: string | null = null;
	let fullViewLoading = false;
	let fullViewTokenId: string | null = null;

	interface PlaceWithTokens {
		place: Place;
		tokens: Token[];
	}

	$: tokensByPlace = places.map((place) => ({
		place,
		tokens: tokens.filter((t) => t.place_id === place.id)
	})) as PlaceWithTokens[];

	// Live token id set — invalidate full-view cache when the selected
	// token disappears (consumed/produced) so we don't render stale JSON.
	$: liveIds = new Set(tokens.map((t) => t.id));
	$: if (fullViewTokenId && !liveIds.has(fullViewTokenId)) {
		fullView = null;
		fullViewError = null;
		fullViewTokenId = null;
	}

	// When selectedTokenId changes externally, find the containing place and switch tab
	$: if (selectedTokenId) {
		const token = tokens.find((t) => t.id === selectedTokenId);
		if (token) {
			const placeIndex = tokensByPlace.findIndex((p) => p.place.id === token.place_id);
			if (placeIndex !== -1) {
				// Switch to the place tab (index + 1 because 0 is "All Tokens")
				selectedTabIndex = placeIndex + 1;
			}
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
		fullView = null;
		fullViewError = null;
		fullViewTokenId = null;
	}

	async function loadFullView(tokenId: string) {
		if (!netId) return;
		if (fullViewTokenId === tokenId && (fullView || fullViewLoading)) return;
		fullViewTokenId = tokenId;
		fullView = null;
		fullViewError = null;
		fullViewLoading = true;
		try {
			const view = await getToken(netId, tokenId);
			// Skip stale responses if the user moved on
			if (fullViewTokenId === tokenId) {
				fullView = view;
			}
		} catch (err) {
			if (fullViewTokenId === tokenId) {
				fullViewError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			if (fullViewTokenId === tokenId) {
				fullViewLoading = false;
			}
		}
	}

	function handleTokenCardClick(tokenId: string) {
		if (onTokenSelect) {
			onTokenSelect(tokenId);
		}
	}

	function formatFullView(view: TokenView): string {
		if (view.kind === 'json') {
			return JSON.stringify(view.value, null, 2);
		}
		return view.text;
	}
</script>

<div class="token-inspector">
	<!-- Tab buttons -->
	<div class="tabs">
		<!-- All Tokens tab -->
		<button
			class="tab"
			class:active={selectedTabIndex === 0}
			on:click={() => (selectedTabIndex = 0)}
		>
			All ({tokens.length})
		</button>
		<!-- Individual place tabs -->
		{#each tokensByPlace as { place, tokens: placeTokens }, i}
			<button
				class="tab"
				class:active={selectedTabIndex === i + 1}
				on:click={() => (selectedTabIndex = i + 1)}
			>
				{place.name} ({placeTokens.length})
			</button>
		{/each}
	</div>

	<!-- Tab content -->
	<div class="tab-content">
		{#if selectedTabIndex === 0}
			<!-- All Tokens tab content -->
			{#if tokens.length > 0}
				{#each tokensByPlace as { place, tokens: placeTokens }}
					{#if placeTokens.length > 0}
						<div class="place-section">
							<div class="place-info">
								<strong>{place.name}</strong>
								<span class="type">{place.type_name}</span>
							</div>
							{#each placeTokens as token (token.id)}
								<button
									class="token-card"
									class:selected={token.id === selectedTokenId}
									data-token-card-id={token.id}
									on:click={() => handleTokenCardClick(token.id)}
								>
									<div class="token-header">
										<span class="token-id">{token.id}</span>
										<span class="token-type">{token.type_name}</span>
									</div>
									{#if token.id === selectedTokenId}
										{#if fullViewLoading}
											<div class="muted">Loading…</div>
										{:else if fullViewError}
											<pre class="error">Failed to load full view: {fullViewError}</pre>
											<pre>{token.preview}</pre>
										{:else if fullView && fullView.id === token.id}
											<pre>{formatFullView(fullView)}</pre>
										{:else}
											<pre>{token.preview}</pre>
										{/if}
									{:else}
										<pre>{token.preview}</pre>
									{/if}
								</button>
							{/each}
						</div>
					{/if}
				{/each}
			{:else}
				<div class="empty">No tokens in the graph</div>
			{/if}
		{:else if tokensByPlace[selectedTabIndex - 1]}
			<!-- Individual place tab content -->
			{@const { place, tokens: placeTokens } = tokensByPlace[selectedTabIndex - 1]}
			<div class="place-info">
				<strong>{place.name}</strong>
				<span class="type">{place.type_name}</span>
			</div>

			{#if placeTokens.length > 0}
				{#each placeTokens as token (token.id)}
					<button
						class="token-card"
						class:selected={token.id === selectedTokenId}
						data-token-card-id={token.id}
						on:click={() => handleTokenCardClick(token.id)}
					>
						<div class="token-header">
							<span class="token-id">{token.id}</span>
							<span class="token-type">{token.type_name}</span>
						</div>
						{#if token.id === selectedTokenId}
							{#if fullViewLoading}
								<div class="muted">Loading…</div>
							{:else if fullViewError}
								<pre class="error">Failed to load full view: {fullViewError}</pre>
								<pre>{token.preview}</pre>
							{:else if fullView && fullView.id === token.id}
								<pre>{formatFullView(fullView)}</pre>
							{:else}
								<pre>{token.preview}</pre>
							{/if}
						{:else}
							<pre>{token.preview}</pre>
						{/if}
					</button>
				{/each}
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

	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-tertiary);
	}
</style>

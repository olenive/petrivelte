<script lang="ts">
	import type { Topology, TopologyTransition, TransitionState } from '$lib/types';
	import { detailRows, transitionArcs } from '$lib/transitionDetail';

	export let transition: TopologyTransition | null = null;
	/** Its live state: the switch, whether it can fire, whether it runs. */
	export let state: TransitionState | null = null;
	export let topology: Topology | null = null;
	export let onEnable: ((name: string) => void) | null = null;
	export let onDisable: ((name: string) => void) | null = null;
	/** An enable or disable request is in flight. */
	export let toggling: boolean = false;
	export let toggleError: string | null = null;

	$: rows = detailRows(transition?.detail);
	$: arcs = transition ? transitionArcs(topology, transition.name) : { inputs: [], outputs: [] };
	$: status = !state
		? 'unknown'
		: !state.enabled
			? 'disabled'
			: state.in_flight
				? 'running'
				: state.fireable
					? 'fireable'
					: 'waiting';
</script>

<div class="transition-inspector">
	{#if transition}
		<div class="section">
			<div class="transition-name">{transition.name}</div>
			<div class="status" data-transition-status={status}>
				<span class="badge {status}">{status}</span>
				{#if state?.priority !== undefined}
					<span class="muted-inline">priority {state.priority}</span>
				{/if}
			</div>
			{#if state && (onEnable || onDisable)}
				<div class="actions">
					{#if state.enabled}
						<button type="button" disabled={toggling} on:click={() => onDisable?.(transition!.name)}>
							{toggling ? 'Disabling…' : 'Disable'}
						</button>
					{:else}
						<button type="button" disabled={toggling} on:click={() => onEnable?.(transition!.name)}>
							{toggling ? 'Enabling…' : 'Enable'}
						</button>
					{/if}
				</div>
			{/if}
			{#if toggleError}
				<div class="error">{toggleError}</div>
			{/if}
		</div>

		{#if rows.length > 0}
			<div class="section">
				<div class="label">Detail</div>
				{#each rows as [key, value] (key)}
					<div class="row" data-detail-key={key}>
						<div class="key">{key}</div>
						<pre class="value">{value}</pre>
					</div>
				{/each}
			</div>
		{:else}
			<div class="section">
				<div class="label">Inputs</div>
				{#each arcs.inputs as arc}
					<div class="arc" data-arc="in">{arc.place}{#if arc.note}<span class="muted-inline"> · {arc.note}</span>{/if}</div>
				{:else}
					<div class="muted">None</div>
				{/each}
			</div>
			<div class="section">
				<div class="label">Outputs</div>
				{#each arcs.outputs as arc}
					<div class="arc" data-arc="out">{arc.place}{#if arc.note}<span class="muted-inline"> · {arc.note}</span>{/if}</div>
				{:else}
					<div class="muted">None</div>
				{/each}
			</div>
		{/if}
	{:else}
		<div class="empty">Click a transition to inspect it</div>
	{/if}
</div>

<style>
	.transition-inspector {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow-y: auto;
		padding: 0.75rem;
		background: var(--bg-secondary);
	}

	.section {
		margin-bottom: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--border-light);
	}

	.section:last-child {
		border-bottom: none;
	}

	.transition-name {
		font-weight: bold;
		font-size: 1em;
		color: var(--text-primary);
		margin-bottom: 0.25rem;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.badge {
		font-size: 0.75em;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		background: var(--bg-tertiary);
		color: var(--text-secondary);
	}

	.badge.disabled {
		color: #9ca3af;
		border: 1px dashed #9ca3af;
	}

	.badge.fireable {
		color: #16a34a;
	}

	.badge.running {
		color: #d97706;
	}

	.actions button {
		padding: 0.3rem 0.75rem;
		border: 1px solid var(--button-border);
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--button-border);
		font-size: 0.8em;
		cursor: pointer;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error {
		margin-top: 0.4rem;
		font-size: 0.8em;
		color: #ef4444;
	}

	.label {
		font-size: 0.75em;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-tertiary);
		margin-bottom: 0.4rem;
	}

	.row {
		margin-bottom: 0.5rem;
	}

	.key {
		font-size: 0.75em;
		color: var(--text-secondary);
		margin-bottom: 0.15rem;
	}

	.value {
		font-family: monospace;
		font-size: 0.8em;
		color: var(--text-primary);
		background: var(--bg-tertiary);
		padding: 0.5rem;
		border-radius: 4px;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
		margin: 0;
	}

	.arc {
		font-family: monospace;
		font-size: 0.85em;
		color: var(--text-primary);
		padding: 0.1rem 0;
	}

	.muted,
	.muted-inline {
		font-size: 0.85em;
		color: var(--text-tertiary);
	}

	.muted {
		font-style: italic;
	}

	.empty {
		padding: 2rem;
		text-align: center;
		color: var(--text-tertiary);
	}
</style>

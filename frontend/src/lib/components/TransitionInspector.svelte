<script lang="ts">
	import type { Transition } from '$lib/types';

	export let transition: Transition | null = null;
</script>

<div class="transition-inspector">
	{#if transition}
		<div class="section">
			<div class="transition-name">{transition.name}</div>
			<div class="function-name">{transition.function_name}</div>
		</div>

		<div class="section">
			<div class="label">Signature</div>
			{#if transition.signature}
				<pre class="signature">{transition.function_name}{transition.signature}</pre>
			{:else}
				<div class="muted">No signature available</div>
			{/if}
		</div>

		<div class="section">
			<div class="label">Docstring</div>
			{#if transition.docstring}
				<pre class="docstring">{transition.docstring}</pre>
			{:else}
				<div class="muted">No docstring</div>
			{/if}
		</div>
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

	.function-name {
		font-family: monospace;
		font-size: 0.85em;
		color: var(--button-border);
	}

	.label {
		font-size: 0.75em;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-tertiary);
		margin-bottom: 0.4rem;
	}

	.signature {
		font-family: monospace;
		font-size: 0.8em;
		color: var(--text-primary);
		background: var(--bg-tertiary);
		padding: 0.5rem;
		border-radius: 4px;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-all;
		margin: 0;
	}

	.docstring {
		font-family: monospace;
		font-size: 0.8em;
		color: var(--text-primary);
		background: var(--bg-tertiary);
		padding: 0.5rem;
		border-radius: 4px;
		overflow-x: auto;
		white-space: pre-wrap;
		margin: 0;
	}

	.muted {
		font-size: 0.85em;
		color: var(--text-tertiary);
		font-style: italic;
	}

	.empty {
		padding: 2rem;
		text-align: center;
		color: var(--text-tertiary);
	}
</style>

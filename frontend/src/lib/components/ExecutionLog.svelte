<script lang="ts">
	import { tick } from 'svelte';
	import type { LogEntry } from '$lib/types';

	interface Props {
		entries?: LogEntry[];
		isStepping?: boolean;
		stepError?: string | null;
		subprocessLines?: string[];
	}

	let { entries = [], isStepping = false, stepError = null, subprocessLines = [] }: Props = $props();

	let logContainer = $state<HTMLDivElement | null>(null);
	let autoScroll = $state(true);

	function checkScrollPosition() {
		if (!logContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = logContainer;
		autoScroll = scrollTop + clientHeight >= scrollHeight - 30;
	}

	$effect(() => {
		// Track reactive dependencies that indicate new content
		entries.length;
		subprocessLines.length;
		isStepping;
		stepError;
		if (autoScroll && logContainer) {
			tick().then(() => {
				if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
			});
		}
	});

	function formatTimestamp(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleTimeString();
	}
</script>

<div class="execution-log" bind:this={logContainer} onscroll={checkScrollPosition}>
	{#each entries as entry (entry.timestamp)}
		<div class="log-entry">
			<span class="timestamp">{formatTimestamp(entry.timestamp)}</span>
			<span class="transition">{entry.transition}</span>
			<span class="duration">{entry.duration_ms}ms</span>
			<div class="details">
				{JSON.stringify(entry.inputs)} → {JSON.stringify(entry.outputs)}
			</div>
		</div>
	{/each}

	{#if isStepping}
		<div class="step-status">
			<span class="spinner"></span>
			<span>Executing transition...</span>
		</div>
		{#if subprocessLines.length > 0}
			<div class="subprocess-output">
				{#each subprocessLines as line}
					<div class="output-line">{line}</div>
				{/each}
			</div>
		{/if}
	{/if}

	{#if stepError}
		<div class="step-error">
			<span class="error-label">Step Error</span>
			<pre class="error-text">{stepError}</pre>
		</div>
	{/if}

	{#if entries.length === 0 && !isStepping && !stepError}
		<div class="empty">No transitions executed yet</div>
	{/if}
</div>

<style>
	.execution-log {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
		background: var(--bg-secondary);
	}

	.log-entry {
		padding: 0.5rem;
		border-bottom: 1px solid var(--border-light);
		font-family: monospace;
		font-size: 0.85em;
	}

	.timestamp {
		color: var(--text-secondary);
	}

	.transition {
		font-weight: bold;
		color: var(--button-border);
		margin: 0 0.5rem;
	}

	.duration {
		color: var(--text-tertiary);
		font-size: 0.9em;
	}

	.details {
		margin-top: 0.25rem;
		color: var(--text-primary);
	}

	.empty {
		padding: 2rem;
		text-align: center;
		color: var(--text-tertiary);
	}

	.step-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		font-family: monospace;
		font-size: 0.85em;
		color: var(--text-secondary);
		border-bottom: 1px solid var(--border-light);
	}

	.spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid var(--text-tertiary);
		border-top-color: var(--button-border);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.subprocess-output {
		padding: 0.25rem 0.5rem;
		font-family: monospace;
		font-size: 0.75em;
		border-bottom: 1px solid var(--border-light);
		max-height: 200px;
		overflow-y: auto;
		background: rgba(0, 0, 0, 0.15);
	}

	.output-line {
		padding: 1px 0;
		color: var(--text-tertiary);
		white-space: pre-wrap;
		word-break: break-all;
	}

	.step-error {
		padding: 0.5rem;
		border-bottom: 1px solid var(--border-light);
		font-family: monospace;
		font-size: 0.85em;
	}

	.error-label {
		color: #ef4444;
		font-weight: bold;
	}

	.error-text {
		margin-top: 0.25rem;
		color: #ef4444;
		white-space: pre-wrap;
		word-break: break-all;
		font-size: 0.9em;
		max-height: 200px;
		overflow-y: auto;
	}
</style>

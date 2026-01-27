<script lang="ts">
	import { afterUpdate } from 'svelte';
	import type { LogEntry } from '$lib/types';

	export let entries: LogEntry[] = [];

	let logContainer: HTMLDivElement;
	let autoScroll = true;

	function checkScrollPosition() {
		if (!logContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = logContainer;
		autoScroll = scrollTop + clientHeight >= scrollHeight - 10;
	}

	afterUpdate(() => {
		if (autoScroll && logContainer) {
			logContainer.scrollTop = logContainer.scrollHeight;
		}
	});

	function formatTimestamp(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleTimeString();
	}
</script>

<div class="execution-log" bind:this={logContainer} on:scroll={checkScrollPosition}>
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

	{#if entries.length === 0}
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
</style>

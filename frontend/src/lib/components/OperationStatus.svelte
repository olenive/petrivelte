<script lang="ts">
	/**
	 * One slow operation, as the pages show it: what kind of work, the step it
	 * has reached, the worker's own message, how long it has run and how long
	 * since it last heartbeat, and its state once it ends.
	 *
	 * The heartbeat age is the number that tells working from stuck. A step
	 * can legitimately run for minutes with nothing new to say, and a ticking
	 * "last heard from 2s ago" beside it is what stops that looking like a hang.
	 *
	 * All the words come from `operationView`, so the table of cases is
	 * asserted there; this file is layout. Ticks its own clock once a second
	 * unless the caller passes `now`.
	 */
	import { onDestroy, onMount } from 'svelte';

	import type { Operation, OperationSummary } from '$lib/api';
	import { operationView } from '$lib/operations';

	interface Props {
		operation: Operation | OperationSummary;
		/** Epoch milliseconds to measure ages to. Omit to tick every second. */
		now?: number;
		/** One inline line for a row or a header, instead of the block. */
		compact?: boolean;
		/** Compact only: leave out kind and step, for a row whose badge
		 *  already names them. The tooltip still carries everything. */
		agesOnly?: boolean;
	}

	let { operation, now, compact = false, agesOnly = false }: Props = $props();

	let ticked = $state(Date.now());
	let timer: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		timer = setInterval(() => {
			ticked = Date.now();
		}, 1000);
	});

	onDestroy(() => {
		if (timer !== null) clearInterval(timer);
	});

	let view = $derived(operationView(operation, now ?? ticked));
	let tone = $derived(
		view.state === 'failed' || view.state === 'abandoned'
			? 'text-red-500'
			: view.state === 'succeeded'
				? 'text-green-600'
				: 'text-status-warning',
	);
</script>

{#if compact}
	<span
		class="inline-flex items-center gap-1.5 text-xs whitespace-nowrap"
		title={view.title}
		data-operation-id={view.id}
		data-operation-state={view.state}
	>
		{#if view.running}
			<span
				class="inline-block w-2.5 h-2.5 border-2 border-current border-t-transparent rounded-full animate-spin {tone}"
				aria-hidden="true"
			></span>
		{/if}
		{#if !agesOnly}
			<span class="text-foreground">{view.headline}</span>
		{/if}
		{#if view.elapsed}
			<span class="text-foreground-muted">{agesOnly ? '' : '· '}{view.elapsed}</span>
		{/if}
		{#if view.heartbeat}
			<span class="text-foreground-faint">· heard {view.heartbeat} ago</span>
		{/if}
		{#if !view.running}
			<span class={tone}>· {view.stateLabel}</span>
		{/if}
	</span>
{:else}
	<div
		class="rounded border border-border bg-card px-3 py-2 text-xs"
		title={view.title}
		data-operation-id={view.id}
		data-operation-state={view.state}
	>
		<div class="flex items-center gap-2">
			{#if view.running}
				<span
					class="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin {tone}"
					aria-hidden="true"
				></span>
			{/if}
			<span class="font-medium text-foreground">{view.kind}</span>
			<span class="ml-auto {tone}">{view.stateLabel}</span>
		</div>
		{#if view.step}
			<div class="mt-1 text-foreground">{view.step}</div>
		{/if}
		{#if view.message}
			<div class="mt-0.5 text-foreground-muted break-words">{view.message}</div>
		{/if}
		{#if view.error}
			<div class="mt-0.5 text-red-500 break-words">{view.error}</div>
		{/if}
		<div class="mt-1 flex gap-3 text-foreground-muted">
			{#if view.elapsed}
				<span>{view.running ? 'running for' : 'took'} {view.elapsed}</span>
			{/if}
			{#if view.heartbeat}
				<span>last heard from {view.heartbeat} ago</span>
			{/if}
		</div>
	</div>
{/if}

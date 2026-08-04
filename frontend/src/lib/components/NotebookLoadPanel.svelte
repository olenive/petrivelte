<script lang="ts">
	import LogViewer from '$lib/components/LogViewer.svelte';
	import { headline, type LoadProgress } from '$lib/notebookLoadProgress';

	interface Props {
		progress: LoadProgress;
		/** Seconds since the load began, ticked by the caller. */
		elapsedSeconds: number;
		/** This notebook's own last load, or null if we have never seen one. */
		expectedSeconds: number | null;
	}

	let { progress, elapsedSeconds, expectedSeconds: expected }: Props = $props();

	let head = $derived(headline(progress, elapsedSeconds, expected));

	// Trailing pending rows are noise while the early steps are still running:
	// they promise detail about a future nobody can act on. Show what has
	// happened, what is happening, and one step of what is next.
	let visibleSteps = $derived.by(() => {
		const lastLive = progress.steps.reduce(
			(acc, step, i) => (step.state === 'pending' ? acc : i),
			-1
		);
		return progress.steps.slice(0, Math.min(lastLive + 2, progress.steps.length));
	});

	function fmt(seconds: number | null): string {
		if (seconds === null) return '';
		return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
	}
</script>

<div class="flex flex-col items-center justify-center h-[calc(100vh-104px)] gap-6 px-6">
	<div class="w-full max-w-xl flex flex-col gap-5">
		<div class="flex flex-col gap-1">
			<div class="flex items-baseline justify-between gap-3">
				<span
					class="text-base font-medium {progress.failure
						? 'text-red-500'
						: 'text-foreground'}"
				>
					{head.title}
				</span>
				<!-- Always moving. During a 30s import there is genuinely nothing
				     to report, and silence is what makes a working load feel
				     broken. -->
				<span class="text-foreground-muted text-sm font-mono tabular-nums">
					{Math.round(elapsedSeconds)}s
				</span>
			</div>
			{#if head.detail}
				<span class="text-foreground-muted text-xs">{head.detail}</span>
			{/if}
		</div>

		<ul class="flex flex-col gap-1.5">
			{#each visibleSteps as step (step.name)}
				<li class="flex items-baseline gap-2.5 text-sm">
					<span
						class="w-3 shrink-0 text-center
							{step.state === 'done' ? 'text-green-500' : ''}
							{step.state === 'active' ? 'text-accent' : ''}
							{step.state === 'failed' ? 'text-red-500' : ''}
							{step.state === 'pending' ? 'text-foreground-faint' : ''}"
					>
						{step.state === 'done'
							? '✓'
							: step.state === 'failed'
								? '✕'
								: step.state === 'active'
									? '◐'
									: '·'}
					</span>
					<span
						class="flex-1 {step.state === 'pending'
							? 'text-foreground-faint'
							: step.state === 'failed'
								? 'text-red-500'
								: 'text-foreground-muted'}"
					>
						{step.label}
					</span>
					<span class="text-foreground-faint text-xs font-mono tabular-nums">
						{#if step.fraction}
							<!-- The only honest fraction in the whole load: the
							     denominator is this notebook's own previous burst. -->
							{step.fraction.done}{step.fraction.total !== null
								? `/${step.fraction.total}`
								: ''}
						{:else if step.elapsed_s !== null}
							{fmt(step.elapsed_s)}
						{/if}
					</span>
				</li>
			{/each}
		</ul>

		{#if progress.failure}
			<p class="text-red-500 text-xs font-mono break-all">{progress.failure}</p>
		{/if}

		<LogViewer lines={progress.log} expanded title="Notebook output" />
	</div>
</div>

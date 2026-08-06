<script lang="ts">
	/**
	 * The health badge, and what it stands for.
	 *
	 * The badge alone said `not drawing` and put its one explanatory line in a
	 * `title` tooltip — invisible on a touch device, and easy to miss on any
	 * device, which is how a red failure state came to communicate nothing at
	 * all. The line is now in the open, under a panel that leads with the two
	 * things that are usually still working.
	 */
	import type { NotebookSync } from '$lib/api';
	import type { Diagnosis } from '$lib/notebookSync';
	import { stateColour } from '$lib/notebookSync';
	import {
		actionLabel,
		diagnosticsText,
		healthFacts,
		healthSummary,
	} from '$lib/notebookHealth';

	interface Props {
		sync: NotebookSync;
		diagnosis: Diagnosis;
		notebookId: string;
		/** Runs the diagnosis's own suggested recovery. */
		onact?: () => void;
	}

	let { sync, diagnosis, notebookId, onact }: Props = $props();

	let open = $state(false);
	let copied = $state(false);

	let facts = $derived(healthFacts(sync));
	let summary = $derived(healthSummary(diagnosis));
	let action = $derived(actionLabel(diagnosis));
	// A healthy notebook has nothing to explain, so the badge stays a badge.
	let expandable = $derived(diagnosis.state !== 'live');

	async function copyDiagnostics() {
		try {
			await navigator.clipboard.writeText(
				diagnosticsText(sync, diagnosis, notebookId),
			);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// Clipboard permission refused is not worth an error state; the
			// text is on screen either way.
		}
	}
</script>

<div class="relative inline-block">
	<button
		type="button"
		class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium whitespace-nowrap"
		class:cursor-default={!expandable}
		style="background: {stateColour(diagnosis.state)}"
		title={expandable ? 'Show connection detail' : diagnosis.detail}
		aria-expanded={open}
		disabled={!expandable}
		onclick={() => (open = !open)}
	>
		{diagnosis.label}{#if expandable}<span class="ml-1 opacity-70">▾</span>{/if}
	</button>

	{#if open && expandable}
		<!-- Click-away, behind the panel. -->
		<button
			type="button"
			class="fixed inset-0 z-40 cursor-default"
			aria-label="Close connection detail"
			onclick={() => (open = false)}
		></button>

		<div
			class="absolute left-0 top-full mt-2 z-50 w-80 rounded-lg border border-border
			       bg-background shadow-lg p-3 text-left"
		>
			<ul class="space-y-2">
				{#each facts as fact (fact.label)}
					<li class="flex items-start gap-2 text-xs">
						<span
							class="mt-0.5 w-3 shrink-0 text-center font-bold"
							class:text-green-600={fact.ok === true}
							class:text-red-500={fact.ok === false}
							class:text-foreground-muted={fact.ok === null}
						>
							{fact.ok === true ? '✓' : fact.ok === false ? '✗' : '·'}
						</span>
						<span class="min-w-0">
							<span class="text-foreground">{fact.label}</span>
							<span class="text-foreground-muted"> — {fact.value}</span>
							{#if fact.note}
								<span class="block text-foreground-muted opacity-80">{fact.note}</span>
							{/if}
						</span>
					</li>
				{/each}
			</ul>

			<p class="mt-3 pt-3 border-t border-border text-xs text-foreground">{summary}</p>

			<div class="mt-3 flex items-center gap-2">
				{#if action && onact}
					<button
						type="button"
						class="px-2 py-1 rounded border border-border text-xs hover:bg-background-subtle"
						onclick={() => {
							open = false;
							onact?.();
						}}
					>
						{action}
					</button>
				{/if}
				<button
					type="button"
					class="px-2 py-1 rounded border border-border text-xs hover:bg-background-subtle"
					onclick={copyDiagnostics}
				>
					{copied ? 'Copied' : 'Copy diagnostics'}
				</button>
			</div>
		</div>
	{/if}
</div>

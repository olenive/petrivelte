<script lang="ts">
	import { tick } from 'svelte';

	interface Props {
		lines: string[];
		expanded?: boolean;
		title?: string;
		fullPageUrl?: string;
		onToggle?: () => void;
		onClear?: () => void;
	}

	let { lines, expanded = false, title = 'Logs', fullPageUrl, onToggle, onClear }: Props = $props();

	let scrollContainer = $state<HTMLPreElement | null>(null);
	let userScrolledUp = $state(false);

	function handleScroll() {
		if (!scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		userScrolledUp = scrollHeight - scrollTop - clientHeight > 30;
	}

	$effect(() => {
		lines.length;
		if (!userScrolledUp && scrollContainer) {
			tick().then(() => {
				if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
			});
		}
	});

	function toggle() {
		onToggle?.();
	}
</script>

<div class="border border-border rounded bg-card overflow-hidden">
	<button
		class="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium text-foreground-muted cursor-pointer hover:bg-hover transition-colors bg-transparent border-0"
		onclick={toggle}
	>
		<span class="flex items-center gap-2">
			<span class="text-[0.7em]">{expanded ? '▼' : '▶'}</span>
			{title}
			{#if lines.length > 0}
				<span class="text-foreground-faint">({lines.length} lines)</span>
			{/if}
		</span>
		{#if expanded}
			<span class="flex items-center gap-2">
				{#if onClear && lines.length > 0}
					<span
						role="button"
						tabindex="0"
						class="text-foreground-faint hover:text-foreground-muted text-xs cursor-pointer"
						onclick={(e) => { e.stopPropagation(); onClear(); }}
						onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onClear(); } }}
					>Clear</span>
				{/if}
				{#if fullPageUrl}
					<a
						href={fullPageUrl}
						target="_blank"
						class="text-foreground-faint hover:text-foreground-muted text-xs no-underline"
						onclick={(e) => e.stopPropagation()}
					>Open in new tab ↗</a>
				{/if}
			</span>
		{/if}
	</button>

	{#if expanded}
		<div class="border-t border-border">
			{#if lines.length === 0}
				<div class="px-3 py-4 text-xs text-foreground-faint text-center">No log output yet</div>
			{:else}
				<pre
					bind:this={scrollContainer}
					onscroll={handleScroll}
					class="bg-[#1a1a2e] text-[#c8c8d0] p-3 text-xs font-mono max-h-[250px] overflow-y-auto whitespace-pre-wrap break-words m-0 rounded-none"
				>{lines.join('\n')}</pre>
			{/if}
		</div>
	{/if}
</div>

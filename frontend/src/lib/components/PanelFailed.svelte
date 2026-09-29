<script lang="ts">
	// What a panel on the nets page shows in place of itself when it threw
	// while rendering or running an effect. The rest of the page keeps going;
	// Retry renders the panel again from the page's current data.
	interface Props {
		name: string;
		error: unknown;
		onReset: () => void;
	}

	let { name, error, onReset }: Props = $props();

	const message = $derived(error instanceof Error ? error.message : String(error));
</script>

<div class="panel-failed flex-1 flex flex-col items-start gap-2 p-4 bg-card text-sm" role="alert" data-panel={name}>
	<div class="font-semibold text-error">The {name} panel failed</div>
	<pre class="bg-error-bg text-error text-xs px-3 py-2 rounded w-full whitespace-pre-wrap break-all">{message}</pre>
	<p class="text-xs text-foreground-muted">The rest of the page is still live. The full error is in the browser console.</p>
	<button
		type="button"
		class="px-3 py-1.5 border border-border rounded bg-muted text-foreground text-sm cursor-pointer transition-colors hover:bg-hover"
		onclick={onReset}
	>Retry</button>
</div>

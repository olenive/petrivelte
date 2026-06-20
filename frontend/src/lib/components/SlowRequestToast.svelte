<!--
	Non-blocking corner toast for backend slowness / degradation.

	Two layers of signal:
	  1. ``backendCondition`` — a *named* condition classified from recent API
	     outcomes (slow DB / rate limited / unreachable). When known, it wins,
	     so the user sees what's actually wrong instead of a generic message.
	  2. ``slowRequestCount`` — at least one request has been in flight past the
	     slow threshold. Used as the fallback "still working" affordance (most
	     often a Fly machine waking from idle ~15-20s) when no specific
	     condition has been classified yet.

	Disappears automatically when requests settle and the condition clears.
-->
<script lang="ts">
	import { slowRequestCount } from '$lib/stores/slowRequests';
	import { backendCondition } from '$lib/stores/backendHealth';

	// Show whenever there's a named condition OR an in-flight slow request.
	$: condition = $backendCondition;
	$: named = condition.kind !== 'ok';
	$: visible = named || $slowRequestCount > 0;

	// Unreachable / rate-limited are more alarming than slow — use red; the
	// "still working" cases stay amber so routine cold starts don't look scary.
	$: dotColor =
		condition.kind === 'unreachable' || condition.kind === 'rate_limited'
			? 'bg-red-500'
			: 'bg-amber-500';

	$: title = named ? condition.title : 'Still working…';
	$: detail = named
		? condition.detail
		: 'Your worker may be waking up from idle. First request after a quiet period can take ~20s.';
</script>

{#if visible}
	<div
		role="status"
		aria-live="polite"
		class="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-border bg-card px-4 py-3 shadow-lg"
	>
		<div class="flex items-start gap-3">
			<span
				class="mt-1.5 inline-block h-2 w-2 flex-none animate-pulse rounded-full {dotColor}"
				aria-hidden="true"
			></span>
			<div class="text-sm text-foreground">
				<p class="font-medium">{title}</p>
				<p class="mt-0.5 text-xs text-foreground-muted">
					{detail}
				</p>
			</div>
		</div>
	</div>
{/if}

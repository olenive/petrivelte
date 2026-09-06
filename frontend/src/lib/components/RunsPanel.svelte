<script lang="ts">
	/**
	 * What this net has actually done.
	 *
	 * Before the run record, that question could only be answered by hand from
	 * capped in-memory buffers on a worker that had to still be answering. The
	 * panel is the durable version: every row survives the worker, the reload
	 * and the redeploy that produced it.
	 *
	 * Three things it deliberately does not do.
	 *
	 * It does not poll. Runs change on three events the SSE connection already
	 * carries, so the newest page is refetched when one arrives for this net
	 * and sits still otherwise. A second EventSource would be a second thing to
	 * reconnect, and there is nothing here the first one cannot say.
	 *
	 * It does not fetch while collapsed. The history is a diagnostic, not a
	 * dashboard; selecting a net should cost nothing until somebody asks.
	 *
	 * It does not fill in the days a net did not run. `/runs/daily` omits them,
	 * and the omission is information — bars are placed by date, so a net that
	 * ran daily until Tuesday does not look like one that runs twice a week.
	 */
	import { onDestroy } from 'svelte';

	import {
		getNetRunDaily, listNetRuns,
		type DailyRollup, type Net, type RunRecord,
	} from '$lib/api';
	import { isRunEvent, serverEventsStore } from '$lib/stores/serverEvents';
	import {
		DAILY_WINDOW_DAYS, DAILY_SEGMENT_STATES,
		appendRunPage, dailyChart, emptyRunHistory, formatDuration, formatElapsed,
		formatStamp, formatUtcStamp, hasMoreRuns, progressLabel, refreshRunHistory, reasonLabel,
		runHeadline, runStateColour, runStateMeta, triggerLabel,
		type RunHistory,
	} from '$lib/runs';
	import DataLoadState from '$lib/components/DataLoadState.svelte';

	interface Props {
		net: Net | null;
		expanded: boolean;
		onToggle: () => void;
	}

	let { net, expanded, onToggle }: Props = $props();

	const PAGE_SIZE = 25;
	/** Ages are only honest if they keep moving. */
	const TICK_MS = 15_000;

	let history = $state<RunHistory>(emptyRunHistory());
	let daily = $state<DailyRollup[]>([]);
	let loaded = $state(false);
	let error = $state<string | null>(null);
	let loadingMore = $state(false);
	let openErrors = $state<Set<string>>(new Set());
	let now = $state(Date.now());

	const tick = setInterval(() => (now = Date.now()), TICK_MS);
	onDestroy(() => clearInterval(tick));

	// What is happening now, or — when nothing is — what happened last. Never
	// both as equals: a bare `stopped` badge beside "running since 00:38" reads
	// as a contradiction rather than as history. Comes off the net row, so it
	// follows a run event as soon as the page applies it.
	let headline = $derived(net ? runHeadline(net, now) : { kind: 'none' } as const);
	let progress = $derived(net ? progressLabel(net, now) : null);
	let chart = $derived(dailyChart(daily, { days: DAILY_WINDOW_DAYS, now }));

	async function load(netId: string) {
		error = null;
		try {
			const [page, rollups] = await Promise.all([
				listNetRuns(netId, { limit: PAGE_SIZE }),
				getNetRunDaily(netId, DAILY_WINDOW_DAYS),
			]);
			// Guard against the net having been switched mid-flight: the
			// response belongs to whichever net was selected when it was asked
			// for, not to whichever one is selected when it lands.
			if (net?.id !== netId) return;
			history = refreshRunHistory(emptyRunHistory(), page);
			daily = rollups;
		} catch (e) {
			if (net?.id !== netId) return;
			error = e instanceof Error ? e.message : 'Failed to load run history';
		} finally {
			if (net?.id === netId) loaded = true;
		}
	}

	/** Refetch the newest page only, keeping any older pages already asked for. */
	async function refreshNewest(netId: string) {
		try {
			const [page, rollups] = await Promise.all([
				listNetRuns(netId, { limit: PAGE_SIZE }),
				getNetRunDaily(netId, DAILY_WINDOW_DAYS),
			]);
			if (net?.id !== netId) return;
			history = refreshRunHistory(history, page);
			daily = rollups;
		} catch {
			// A refresh that fails leaves the last good history on screen; the
			// next event, or reopening the panel, tries again.
		}
	}

	async function loadMore() {
		const netId = net?.id;
		if (!netId || loadingMore || !hasMoreRuns(history)) return;
		loadingMore = true;
		try {
			const page = await listNetRuns(netId, { limit: PAGE_SIZE, before: history.nextBefore });
			if (net?.id !== netId) return;
			history = appendRunPage(history, page);
		} catch (e) {
			if (net?.id === netId) error = e instanceof Error ? e.message : 'Failed to load more runs';
		} finally {
			loadingMore = false;
		}
	}

	// Selecting another net (or opening the panel for the first time) starts
	// again from an empty history rather than showing the previous net's runs
	// while the new ones are in flight.
	let shownNetId: string | null = null;
	$effect(() => {
		const netId = expanded ? (net?.id ?? null) : null;
		if (netId === shownNetId) return;
		shownNetId = netId;
		history = emptyRunHistory();
		daily = [];
		openErrors = new Set();
		loaded = false;
		error = null;
		if (netId) load(netId);
	});

	// The same store and the same reconnect handling as every other state
	// change on this page — a run event is just another one.
	const unsubscribe = serverEventsStore.subscribe((event) => {
		if (!event || !isRunEvent(event)) return;
		const netId = net?.id;
		if (!netId || event.net_id !== netId || !expanded) return;
		refreshNewest(netId);
	});
	onDestroy(unsubscribe);

	function toggleError(runId: string) {
		const next = new Set(openErrors);
		if (!next.delete(runId)) next.add(runId);
		openErrors = next;
	}

	/** What a run's `started` cell says, with the server's ISO in the tooltip. */
	function started(run: RunRecord) {
		return formatStamp(run.started_at ?? run.created_at, now);
	}

	/** An open run has no duration yet, so it shows how long it has been open. */
	function duration(run: RunRecord): string {
		const closed = formatDuration(run.duration_s);
		if (closed) return closed;
		const open = formatElapsed(run.started_at ?? run.created_at, now);
		return open ? `${open}…` : '—';
	}
</script>

<section class="flex flex-col border-t border-border bg-card shrink-0">
	<button
		type="button"
		class="flex items-center gap-3 px-4 py-2 bg-muted border-0 cursor-pointer text-left text-sm
		       font-medium text-foreground w-full transition-colors hover:bg-hover"
		aria-expanded={expanded}
		onclick={onToggle}
	>
		<span class="text-[0.7rem] text-foreground-muted">{expanded ? '▼' : '▶'}</span>
		<span>Runs</span>
		{#if headline.kind === 'open'}
			<span class="text-xs text-status-info font-normal" title={headline.open.title}>{headline.open.text}</span>
			{#if progress}
				<span class="text-xs text-foreground-muted font-mono font-normal" title={progress.title}>{progress.text}</span>
			{/if}
			{#if headline.previous}
				<!-- Subordinate and labelled: the net is running, and this is
				     what it did last time, not what it is doing. -->
				<span class="text-xs text-foreground-faint font-normal" title={headline.previous.title}>
					{headline.previous.text}
				</span>
			{/if}
		{:else if headline.kind === 'last'}
			<span
				class="text-xs px-2 py-0.5 rounded-full text-white font-medium"
				style="background: {headline.badge.colour}"
				title={headline.badge.title}
			>{headline.badge.label}</span>
			{#if headline.badge.detail}
				<span class="text-xs text-foreground-muted font-normal">{headline.badge.detail}</span>
			{/if}
		{:else}
			<span class="text-xs text-foreground-faint font-normal">never run</span>
		{/if}
		{#if net?.last_success_at}
			<span class="text-xs text-foreground-faint" title="Last succeeded {net.last_success_at}">
				last success {formatElapsed(net.last_success_at, now)} ago
			</span>
		{/if}
		<span class="ml-auto text-xs text-foreground-faint font-normal">
			{expanded ? 'What this net has actually done' : 'Show run history'}
		</span>
	</button>

	{#if expanded}
		<div class="max-h-[45vh] overflow-y-auto">
			{#if net}
				<!-- Empty means *nothing at all*, not "no run rows". Retention
				     prunes history but keeps the daily rollups indefinitely, so a
				     net that last ran a year ago still has something to show and
				     must not be told it has never run. -->
				<DataLoadState
					loading={!loaded}
					{error}
					isEmpty={history.runs.length === 0 && chart.bars.length === 0}
					loadingMessage="Loading run history…"
				>
					{#snippet empty()}
						<div class="p-6 text-center">
							<p class="text-sm text-foreground-muted">This net has never run.</p>
							<p class="text-xs text-foreground-faint mt-1">
								A run is recorded the moment something starts this net — a Load that
								auto-starts it, an Activate, or the resume sweep after a worker reboot.
							</p>
						</div>
					{/snippet}

					<!-- Daily outcomes. Plotted against the UTC day, so a day the
					     net did not run is a gap and not a zero. -->
					{#if chart.max > 0}
						<div class="px-4 pt-3">
							<div class="flex items-baseline gap-3 mb-1">
								<h3 class="text-xs font-semibold text-foreground-muted">
									Last {DAILY_WINDOW_DAYS} days
								</h3>
								<div class="flex items-center gap-2 flex-wrap">
									{#each DAILY_SEGMENT_STATES as state (state)}
										<span class="inline-flex items-center gap-1 text-[10px] text-foreground-faint">
											<span
												class="inline-block w-2 h-2 rounded-sm"
												style="background: {runStateColour(state)}"
											></span>{runStateMeta(state).label}
										</span>
									{/each}
								</div>
								<span class="ml-auto text-[10px] text-foreground-faint">
									peak {chart.max} run{chart.max === 1 ? '' : 's'}/day
								</span>
							</div>
							<div
								class="grid gap-px h-12"
								style="grid-template-columns: repeat({chart.columns}, minmax(0, 1fr))"
							>
								{#each chart.bars as bar (bar.day)}
									<div
										class="flex flex-col justify-end h-full"
										style="grid-column: {bar.column}"
										title={bar.title}
									>
										<!-- A floor of 10%, so one run on a hundred-run scale is
										     still a mark rather than a rounding error. -->
										<div
											class="flex flex-col-reverse w-full rounded-sm overflow-hidden"
											style="height: {Math.max(10, (bar.total / chart.max) * 100)}%"
										>
											{#each bar.segments as segment (segment.state)}
												<div style="flex: {segment.count} 0 0; background: {segment.colour}"></div>
											{/each}
										</div>
									</div>
								{/each}
							</div>
							<div class="flex justify-between text-[10px] text-foreground-faint mt-0.5">
								<span>{chart.startDay}</span>
								<span>{chart.endDay} (UTC)</span>
							</div>
						</div>
					{/if}

					{#if history.runs.length === 0}
						<p class="px-4 py-3 text-xs text-foreground-muted">
							No runs in the history the control plane still holds — the daily counts
							above reach further back than the rows do.
						</p>
					{:else}
						<!-- Newest first, as the server returns them. -->
						<table class="w-full text-xs mt-3">
							<thead class="text-foreground-faint">
								<tr class="border-b border-border">
									<th class="text-left font-medium px-4 py-1.5">Trigger</th>
									<th class="text-left font-medium px-4 py-1.5">Started</th>
									<th class="text-right font-medium px-4 py-1.5">Duration</th>
									<th class="text-left font-medium px-4 py-1.5">State</th>
									<th class="text-left font-medium px-4 py-1.5">Reason</th>
								</tr>
							</thead>
							{#each history.runs as run (run.id)}
								{@const meta = runStateMeta(run.state)}
								{@const stamp = started(run)}
								{@const slot = formatUtcStamp(run.scheduled_for, now)}
								{@const reason = reasonLabel(run.reason)}
								<tbody class="border-b border-border-light">
									<tr class="hover:bg-hover">
										<td class="px-4 py-1.5 align-top">
											<span class="text-foreground">{triggerLabel(run.trigger)}</span>
											{#if slot}
												<!-- The cron slot this run was fired for, which is not the
												     same as when it started — and in UTC, because that is
												     the number written in the net's decorator. -->
												<span class="block text-foreground-faint" title="Scheduled for {slot.title}">
													slot {slot.text}
												</span>
											{/if}
										</td>
										<td class="px-4 py-1.5 align-top text-foreground-muted whitespace-nowrap">
											{#if stamp}
												<span title={stamp.title}>{stamp.text}</span>
											{:else}
												—
											{/if}
										</td>
										<td class="px-4 py-1.5 align-top text-right text-foreground-muted tabular-nums whitespace-nowrap">
											{duration(run)}
											{#if run.step_count !== null}
												<span class="block text-foreground-faint">{run.step_count} steps</span>
											{/if}
										</td>
										<td class="px-4 py-1.5 align-top whitespace-nowrap">
											<span
												class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
												style="background: {meta.colour}"
											>{meta.label}</span>
										</td>
										<td class="px-4 py-1.5 align-top text-foreground-muted">
											{#if run.error}
												<button
													type="button"
													class="text-left bg-transparent border-0 p-0 cursor-pointer text-accent hover:underline"
													aria-expanded={openErrors.has(run.id)}
													onclick={() => toggleError(run.id)}
												>
													{reason ?? 'error'}
													<span class="opacity-70">{openErrors.has(run.id) ? '▾' : '▸'}</span>
												</button>
											{:else if reason}
												{reason}
											{:else if meta.open}
												<span class="text-foreground-faint">in progress</span>
											{:else}
												<span class="text-foreground-faint">—</span>
											{/if}
										</td>
									</tr>
									{#if run.error && openErrors.has(run.id)}
										<tr>
											<td colspan="5" class="px-4 pb-2">
												<!-- The worker's own words. Capped at 2,000 characters by
												     the writer; the full traceback stays in the net log. -->
												<pre class="whitespace-pre-wrap break-words font-mono text-[11px]
												            leading-relaxed text-destructive bg-muted rounded p-2 m-0">{run.error}</pre>
											</td>
										</tr>
									{/if}
								</tbody>
							{/each}
						</table>

						<div class="flex items-center gap-3 px-4 py-2">
							{#if hasMoreRuns(history)}
								<button
									type="button"
									class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-xs font-medium
									       cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground
									       disabled:opacity-50 disabled:cursor-not-allowed"
									onclick={loadMore}
									disabled={loadingMore}
								>{loadingMore ? 'Loading…' : 'Load more'}</button>
							{:else}
								<span class="text-[11px] text-foreground-faint">
									That is the whole history the control plane still holds.
								</span>
							{/if}
							<span class="ml-auto text-[11px] text-foreground-faint">
								{history.runs.length} run{history.runs.length === 1 ? '' : 's'} shown
							</span>
						</div>
					{/if}
				</DataLoadState>
			{:else}
				<p class="p-4 text-sm text-foreground-muted">Select a net to see its runs.</p>
			{/if}
		</div>
	{/if}
</section>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';

	import AppNav from '$lib/components/AppNav.svelte';
	import NotebookErrorsBanner from '$lib/components/NotebookErrorsBanner.svelte';
	import {
		API_URL,
		getNotebook,
		getNotebookSync,
		getNotebookTimings,
		loadNotebook,
		unloadNotebook,
		type Notebook,
		type NotebookSync,
		type NotebookTimings,
	} from '$lib/api';
	import { diagnose, planRemount, stateColour, type Diagnosis } from '$lib/notebookSync';
	import { serverEventsStore } from '$lib/stores/serverEvents';
	import NotebookLoadPanel from '$lib/components/NotebookLoadPanel.svelte';
	import {
		emptyProgress,
		reduceLoadEvent,
		applyBurst,
		expectedSeconds,
		type LoadProgress,
	} from '$lib/notebookLoadProgress';

	// Human-friendly reasons matching what the worker / control plane
	// stamps on `load_error` when something changes load_state. Keep this
	// shallow — server-side codes are the source of truth, here we just
	// translate for display. Unknown codes fall through as-is.
	const LOAD_ERROR_LABELS: Record<string, string> = {
		idle_eviction: 'evicted after 15 min of inactivity (frees worker RAM)',
		subprocess_dead: 'subprocess unreachable — likely crashed',
		subprocess_gone: 'subprocess is gone (crash, OOM, or worker restart)',
		worker_deleted: 'worker was deleted',
		worker_destroyed: 'worker resource was destroyed',
		worker_stopped: 'worker was stopped',
	};

	function loadErrorLabel(code: string | null | undefined): string | null {
		if (!code) return null;
		return LOAD_ERROR_LABELS[code] ?? code;
	}

	let notebookId = $derived($page.params.id as string);
	let notebook = $state<Notebook | null>(null);
	let initialising = $state(true);
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let timings = $state<NotebookTimings | null>(null);
	let timingsPoll: ReturnType<typeof setTimeout> | null = null;

	// What the load is doing, so the wait is legible rather than a spinner.
	// The spawn is ~99% of a cold load and used to report nothing at all, which
	// made a working load and a hung one look identical.
	let loadProgress = $state<LoadProgress>(emptyProgress());
	let loadElapsedS = $state(0);
	let loadEvents: EventSource | null = null;
	let loadTicker: ReturnType<typeof setInterval> | null = null;

	// Burst arrives on the timings poll, not the event stream: the notebook's
	// uvicorn runs with access_log=False, so the subprocess says nothing at all
	// while the browser fetches its ~228 lazily imported chunks. Without this
	// the panel would go quiet for the whole second half of the wait.
	let displayedProgress = $derived(applyBurst(loadProgress, timings));

	function startLoadStream() {
		stopLoadStream();
		loadProgress = emptyProgress();
		loadElapsedS = 0;
		const startedAt = performance.now();
		loadTicker = setInterval(() => {
			loadElapsedS = (performance.now() - startedAt) / 1000;
		}, 250);
		try {
			loadEvents = new EventSource(`${API_URL}/api/notebooks/${notebookId}/events`, {
				withCredentials: true,
			});
		} catch {
			// No progress detail is a worse page, not a broken one.
			return;
		}
		loadEvents.onmessage = (message) => {
			try {
				loadProgress = reduceLoadEvent(loadProgress, JSON.parse(message.data));
			} catch {
				// One malformed event must not take down the whole readout.
			}
		};
		// Deliberately no onerror handler beyond closing: EventSource retries on
		// its own, and a load that finishes normally closes the stream from this
		// side anyway.
	}

	function stopLoadStream() {
		if (loadTicker !== null) {
			clearInterval(loadTicker);
			loadTicker = null;
		}
		if (loadEvents) {
			loadEvents.close();
			loadEvents = null;
		}
	}

	// Notebook health. Polled rather than pushed because most of it is an age:
	// it changes with the passage of time, not with events, so there is
	// nothing for the server to notify us about. Nulled while unloaded so the
	// badge disappears instead of freezing at its last reading — a stale
	// freshness indicator being the one thing worse than none.
	let syncState = $state<NotebookSync | null>(null);
	let syncPoll: ReturnType<typeof setTimeout> | null = null;
	const SYNC_POLL_MS = 5000;

	// Self-heal state. `remountAttempts` is reset by planRemount once the
	// notebook recovers, so a page left open for days is not gradually
	// consumed by unrelated hiccups hours apart.
	let remountAttempts = $state(0);
	let remountExhausted = $state(false);
	let remountPending: ReturnType<typeof setTimeout> | null = null;

	// Computed at poll time rather than derived. Half its inputs are clocks —
	// how long since the burst settled, how long since the last frame — and a
	// derived value would only recompute when something else happened to
	// change, which is precisely the "looks fine because nothing told us
	// otherwise" failure this page is being fixed for.
	let diagnosis = $state<Diagnosis | null>(null);

	async function pollSync() {
		if (notebook?.load_state !== 'loaded') {
			syncState = null;
			diagnosis = null;
		} else {
			try {
				syncState = await getNotebookSync(notebookId);
				diagnosis = diagnose(syncState, {
					sinceBurstSettledS: sinceBurstSettledS(),
				});
				considerRemount();
			} catch {
				// A failed poll says nothing about the notebook, only about
				// this request — so leave the last reading in place and let its
				// age speak for itself on the next render.
			}
		}
		syncPoll = setTimeout(pollSync, SYNC_POLL_MS);
	}

	// The render channel is the half of this system nothing used to watch. It
	// carries what the iframe actually draws, and it fails independently of
	// the freshness numbers above — a notebook once sat frozen for 259s while
	// every one of them read healthy, because the browser had not opened its
	// socket. The page cannot check that directly: the iframe is cross-origin,
	// so its socket is invisible from here. The worker counts it and we act on
	// what it reports.
	function considerRemount() {
		if (!diagnosis) return;

		if (remountPending) {
			// One is already queued. Do not consult the plan again — polls
			// arrive every 5s and the backoff is longer than that, so
			// re-planning here would spend the whole retry budget waiting for
			// the first retry. The only decision left is whether to call it
			// off, which a notebook that recovered on its own has earned.
			if (diagnosis.action !== 'remount') {
				clearTimeout(remountPending);
				remountPending = null;
			}
			return;
		}

		const plan = planRemount(diagnosis, remountAttempts);
		remountAttempts = plan.attempts;
		remountExhausted = plan.exhausted;
		if (!plan.remount) return;
		remountPending = setTimeout(() => {
			remountPending = null;
			// A remount is a fresh Marimo session — same trade-off the
			// iframeSrc comment below describes, and the reason this is capped.
			mountToken += 1;
			// The new iframe runs its own asset burst, so the connection clock
			// restarts with it. The old timings chain has to go too: it would
			// otherwise reach its terminal branch and arm the clock against a
			// burst that no longer exists, cutting the new one short.
			if (timingsPoll) clearTimeout(timingsPoll);
			timingsPoll = null;
			burstSettledAt = null;
		}, plan.delayS * 1000);
	}

	// Wall-clock cost of the whole thing, from the user's action to the iframe
	// firing load. The server-side `load` number covers only the spawn call, so
	// on its own it reads as "25s" for something that took well over a minute:
	// a Reload also pays an unload, and the browser then fetches marimo and
	// boots its kernel. Reporting only the component we happen to instrument
	// would keep pointing at the wrong bottleneck.
	let wallClockStart: number | null = null;
	let wallClockMs = $state<number | null>(null);

	// Bumped to force a fresh iframe, and therefore a fresh Marimo session.
	let mountToken = $state(0);

	// When Marimo's asset burst went quiet, which is the only sane clock to
	// judge "should have connected by now" against. The burst has been
	// measured at 61s on a cold worker, and a remount restarts it from
	// nothing — so a deadline armed at the iframe's load event would fire
	// mid-load and turn a slow open into an unbounded one.
	let burstSettledAt: number | null = null;

	function sinceBurstSettledS(): number | null {
		return burstSettledAt === null ? null : (performance.now() - burstSettledAt) / 1000;
	}

	function startWallClock() {
		wallClockStart = performance.now();
		wallClockMs = null;
	}

	function stopWallClock() {
		if (wallClockStart === null) return;
		wallClockMs = performance.now() - wallClockStart;
		wallClockStart = null;
	}

	// The backend closes a page-load burst after ~2s of network quiet, so a
	// single fetch on iframe load always reads as still in progress. Poll for a
	// bounded window instead — this is instrumentation and must never become an
	// indefinite background loop.
	//
	// Long enough to outlast a cold marimo start: the chunk fetches can begin
	// well after the iframe's load event on a worker waking from suspend.
	const TIMINGS_POLL_ATTEMPTS = 20;
	const TIMINGS_POLL_INTERVAL_MS = 1500;

	async function refreshTimings(
		attemptsLeft = TIMINGS_POLL_ATTEMPTS,
		sawBurstStart = false,
	) {
		try {
			timings = await getNotebookTimings(notebookId);
		} catch {
			// A timings failure must never surface as a notebook error — the
			// notebook itself is fine, we just have no numbers to show.
			return;
		}
		// Only trust a closed burst once we've actually watched one open. A
		// stray early request (the document fetch, a service-worker probe) goes
		// quiet for 2s and closes a burst of its own; stopping there reported
		// "1 reqs 0.0s" while the real 300-request burst happened afterwards,
		// unobserved.
		const started = sawBurstStart || !!timings?.burst_in_progress;
		const settled = started && timings?.burst && !timings.burst_in_progress;
		if (!settled && attemptsLeft > 1) {
			timingsPoll = setTimeout(
				() => refreshTimings(attemptsLeft - 1, started),
				TIMINGS_POLL_INTERVAL_MS,
			);
		} else if (burstSettledAt === null) {
			// Either the burst settled, or we ran out of attempts and can no
			// longer tell. Both start the connection clock: the second case
			// has already spent the poll window waiting, and leaving it unarmed
			// would mean a notebook whose burst never settles is never checked
			// for a connection at all — silence forever, which is the failure
			// this whole mechanism exists to end.
			burstSettledAt = performance.now();
		}
	}

	function fmtSeconds(s: number): string {
		return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`;
	}

	// Compact enough to sit in the slim header; the full breakdown lives in the
	// title tooltip so the common case stays glanceable.
	let timingsLabel = $derived.by(() => {
		if (!timings && wallClockMs === null) return null;
		const parts: string[] = [];
		// Total leads: it is what the user waited, and it is the only figure
		// that includes the unload, the asset burst and marimo's own startup.
		if (wallClockMs !== null) parts.push(`${fmtSeconds(wallClockMs / 1000)} total`);
		if (timings?.load) parts.push(`${fmtSeconds(timings.load.total_s)} spawn`);
		if (timings?.burst_in_progress) {
			parts.push('measuring page…');
		} else if (timings?.burst) {
			parts.push(`${timings.burst.count} reqs ${fmtSeconds(timings.burst.wall_s)}`);
		}
		return parts.length ? parts.join(' · ') : null;
	});

	let timingsDetail = $derived.by(() => {
		const lines: string[] = [];
		if (wallClockMs !== null) {
			lines.push(
				`Total: ${(wallClockMs / 1000).toFixed(1)}s — your action to the ` +
					`notebook appearing, including unload, spawn, assets and ` +
					`marimo's own startup.`,
			);
		}
		if (!timings) return lines.join('\n');
		if (timings.load) {
			const phases = Object.entries(timings.load.phases)
				.sort((a, b) => b[1] - a[1])
				.map(([name, seconds]) => `${name}=${seconds.toFixed(1)}s`)
				.join(' ');
			lines.push(`Spawn: ${timings.load.total_s.toFixed(1)}s (${phases})`);
		}
		const b = timings.burst;
		if (b) {
			lines.push(
				`Last page open: ${b.count} requests in ${b.wall_s.toFixed(1)}s`,
				`  p50 ${(b.p50_s * 1000).toFixed(0)}ms · p95 ${(b.p95_s * 1000).toFixed(0)}ms · max ${b.max_s.toFixed(1)}s`,
				`  ${b.queued} queued (max wait ${b.max_queue_wait_s.toFixed(1)}s) · ${b.errors} errors`,
			);
		}
		lines.push(
			'Spawn and page-open are measured on the control plane and reset ' +
				'when it restarts; total is measured in this tab.',
		);
		return lines.join('\n');
	});

	// The iframe src points at the control plane API. The proxy chain
	//   browser -> control plane -> flycast -> worker -> notebook subprocess
	// terminates at Marimo, which was mounted at this same path so its asset
	// URLs (/api/notebooks/{id}/static/...) all resolve through the chain.
	//
	// NB: we deliberately do NOT pass a stable ``?session_id=`` to force
	// Marimo run-mode resume on refresh. That preserved chart history but, in
	// this embedded/proxied setup, resuming an orphaned kernel produced a
	// cell-id mismatch — the frontend flooded "Cell <id> not found in state"
	// and hung on the spinner. A fresh session per load loses the chart's
	// in-memory history (it refills as the net steps) but renders cleanly,
	// which is strictly better than hanging. See tests/integration/
	// test_notebook_refresh for the repro/guard before re-attempting resume.
	//
	// Unchanged across remounts: the URL stays exactly what Marimo expects, and
	// `mountToken` recreates the element instead (see the {#key} below). A cache
	// -busting query param would work too, but it would arrive at Marimo, whose
	// run-mode handler already treats one query param as meaningful.
	let iframeSrc = $derived(notebook?.load_state === 'loaded'
		? `${API_URL}/api/notebooks/${notebookId}/`
		: null);

	onMount(async () => {
		await initialise();
		pollSync();
	});

	// React to backend-driven state changes so the badge + reason update
	// without waiting for the user to click anything. Crucial for the
	// idle-eviction case: the worker tells us 15 min after we left the
	// tab idle, and the badge should flip to ``unloaded · evicted...``
	// in place.
	const unsubscribeEvents = serverEventsStore.subscribe((evt) => {
		if (!evt) return;
		if (evt.type !== 'notebook_state_changed') return;
		if (evt.notebook_id !== notebookId) return;
		if (!notebook) return;
		notebook = {
			...notebook,
			load_state: evt.load_state,
			load_error: evt.load_error ?? null,
			worker_id: evt.worker_id ?? notebook.worker_id,
		};
	});

	onDestroy(() => {
		unsubscribeEvents();
		stopLoadStream();
		if (timingsPoll) clearTimeout(timingsPoll);
		if (syncPoll) clearTimeout(syncPoll);
		if (remountPending) clearTimeout(remountPending);
	});

	async function initialise() {
		initialising = true;
		errorMessage = null;
		startWallClock();
		startLoadStream();
		// The expectation is this notebook's own last load, so it has to be
		// read up front: waiting for the iframe's poll would mean the panel
		// could only say "usually about 51s" after the wait it exists to
		// explain. Fire and forget — no expectation is a quieter panel, not a
		// broken one.
		getNotebookTimings(notebookId)
			.then((t) => {
				timings = t;
			})
			.catch(() => {});
		try {
			notebook = await getNotebook(notebookId);
			if (notebook.load_state !== 'loaded') {
				await ensureLoaded();
			}
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
		} finally {
			initialising = false;
			// The spawn is over either way; the burst that follows is reported
			// by the timings poll, which the iframe's onload starts.
			stopLoadStream();
		}
	}

	async function ensureLoaded() {
		if (!notebook) return;
		if (!notebook.worker_id) {
			errorMessage = 'Notebook is not assigned to a worker. Pick a worker on the Wiring page first.';
			return;
		}
		busy = true;
		try {
			await loadNotebook(notebookId);
			notebook = await getNotebook(notebookId);
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
		} finally {
			busy = false;
		}
	}

	async function handleReload() {
		if (!notebook) return;
		busy = true;
		errorMessage = null;
		// Starts before the unload: a Reload pays unload + load, and the unload
		// half was 15s in the field.
		startWallClock();
		// The user has taken over, so the self-heal budget starts again. Not
		// resetting it would leave a page that had already exhausted its
		// retries unable to heal itself for the rest of its life, however many
		// times it was manually rescued in between.
		if (remountPending) clearTimeout(remountPending);
		remountPending = null;
		remountAttempts = 0;
		remountExhausted = false;
		burstSettledAt = null;
		try {
			if (notebook.load_state === 'loaded') {
				await unloadNotebook(notebookId);
			}
			await loadNotebook(notebookId);
			notebook = await getNotebook(notebookId);
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
		} finally {
			busy = false;
		}
	}

	function statusColor(s: string): string {
		switch (s) {
			case 'loaded':
				return '#22c55e';
			case 'loading':
				return '#eab308';
			case 'error':
				return '#ef4444';
			default:
				return '#9ca3af';
		}
	}
</script>

<svelte:head>
	<title>
		{notebook ? `${notebook.instance_name} · Notebook` : 'Notebook'}
	</title>
</svelte:head>

<AppNav title={notebook ? `Notebook · ${notebook.instance_name}` : 'Notebook'} />

<!-- Slim notebook header -->
<div class="flex items-center justify-between px-6 py-2 border-b border-border bg-card text-sm">
	<div class="flex items-center gap-3 min-w-0">
		<a class="text-accent hover:underline" href="/wiring">← Wiring</a>
		{#if notebook}
			<span class="text-foreground-muted">/</span>
			<span class="font-medium text-foreground truncate">{notebook.instance_name}</span>
			<span class="text-foreground-muted text-xs font-mono">({notebook.definition_name})</span>
			<span
				class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
				style="background: {statusColor(notebook.load_state)}"
			>
				{notebook.load_state}
			</span>
			{#if notebook.load_state !== 'loaded' && loadErrorLabel(notebook.load_error)}
				<span
					class="text-foreground-muted text-xs"
					title="Click Reload to restart the subprocess. Your bindings are preserved."
				>
					· {loadErrorLabel(notebook.load_error)}
				</span>
			{/if}
			{#if notebook.bindings.length > 0}
				<span class="text-foreground-muted text-xs">
					· {notebook.bindings.length} binding{notebook.bindings.length === 1 ? '' : 's'}
				</span>
			{/if}
			<!-- Health, separate from load_state above. A notebook can be
			     perfectly `loaded` and hours behind its net, or connected and
			     drawing nothing; both gaps are invisible in the notebook's own
			     output, which is the whole reason this badge exists. It names
			     the broken hop rather than saying only that something is
			     wrong, because the recoveries differ. -->
			{#if diagnosis}
				<span
					class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium whitespace-nowrap"
					style="background: {stateColour(diagnosis.state)}"
					title={diagnosis.detail}
				>
					{diagnosis.label}
				</span>
			{/if}
			{#if remountExhausted}
				<!-- Tried what it could and stopped, rather than looping. Says
				     so explicitly: a page that had silently given up would look
				     identical to one that never noticed. -->
				<span
					class="text-foreground-muted text-xs whitespace-nowrap"
					title={diagnosis?.detail}
				>
					· reconnecting did not help — try Reload
				</span>
			{/if}
			{#if timingsLabel}
				<span
					class="text-foreground-muted text-xs font-mono whitespace-nowrap"
					title={timingsDetail}
				>
					· {timingsLabel}
				</span>
			{/if}
		{/if}
	</div>
	<div class="flex items-center gap-2">
		{#if notebook}
			<button
				class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
				onclick={handleReload}
				disabled={busy}
			>
				{busy ? 'Working…' : 'Reload'}
			</button>
		{/if}
	</div>
</div>

<NotebookErrorsBanner {notebookId} />

{#if initialising}
	<NotebookLoadPanel
		progress={displayedProgress}
		elapsedSeconds={loadElapsedS}
		expectedSeconds={expectedSeconds(timings)}
	/>
{:else if errorMessage}
	<div class="m-6 p-4 border border-red-500 rounded bg-red-50 text-red-700 text-sm">
		<p class="font-medium mb-2">Could not open notebook</p>
		<p>{errorMessage}</p>
		<button
			class="mt-3 px-3 py-1.5 border border-red-500 rounded bg-card text-red-500 text-xs font-medium hover:bg-red-500 hover:text-white"
			onclick={initialise}
		>
			Retry
		</button>
	</div>
{:else if notebook && notebook.load_state === 'loaded' && iframeSrc}
	<!-- Full-viewport iframe under the slim header -->
	<!-- onload fires once Marimo's document is in; the asset burst is still
	     settling at that point, which is why refreshTimings polls. -->
	<!-- Keyed so a bumped mountToken destroys and recreates the element,
	     which is how the page recovers a render channel that never came up.
	     A new element means a new document and a new Marimo session, with the
	     same loss of in-memory chart history a Reload costs — which is why the
	     retry is capped at two rather than being a loop. -->
	{#key mountToken}
		<iframe
			src={iframeSrc}
			title={notebook.instance_name}
			class="w-full h-[calc(100vh-104px)] border-0 block"
			onload={() => {
				stopWallClock();
				refreshTimings();
			}}
		></iframe>
	{/key}
{:else if notebook && notebook.load_state === 'loading'}
	<div class="flex items-center justify-center h-[calc(100vh-104px)] text-foreground-muted">
		Loading notebook on worker…
	</div>
{:else if notebook}
	<!-- Not loaded yet — either failed silently or no worker -->
	<div class="m-6 p-4 border border-border rounded bg-card text-sm">
		<p class="text-foreground">Notebook is not loaded.</p>
		<p class="text-foreground-muted text-xs mt-1">
			Load state: <code>{notebook.load_state}</code>
			{#if notebook.load_error}
				· error: <code>{notebook.load_error}</code>
			{/if}
		</p>
		<button
			class="mt-3 px-3 py-1.5 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
			onclick={ensureLoaded}
			disabled={busy}
		>
			{busy ? 'Loading…' : 'Load on assigned worker'}
		</button>
	</div>
{/if}

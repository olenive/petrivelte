<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	import AppNav from '$lib/components/AppNav.svelte';
	import NotebookErrorsBanner from '$lib/components/NotebookErrorsBanner.svelte';
	import {
		API_URL,
		AdditionalNotebookError,
		getNotebook,
		getNotebookSync,
		getNotebookTimings,
		getWorkerOccupancy,
		loadNotebook,
		patchNotebook,
		unloadNotebook,
		upgradeNotebook,
		type AdditionalNotebookRefusal,
		type Notebook,
		type NotebookSync,
		type NotebookTimings,
		type Operation,
		type WorkerOccupancy,
	} from '$lib/api';
	import OperationStatus from '$lib/components/OperationStatus.svelte';
	import ProvenanceChip from '$lib/components/ProvenanceChip.svelte';
	import { upgradeAction } from '$lib/provenance';
	import {
		applyOperationEvent,
		emptyBook,
		operationFor,
		operationOnWorker,
		pickOperation,
		type OperationBook,
	} from '$lib/operations';
	import NotebookOccupancyBanner from '$lib/components/NotebookOccupancyBanner.svelte';
	import NotebookLoadConfirm from '$lib/components/NotebookLoadConfirm.svelte';
	import { diagnose, planRemount, undrawnPushAgeS, type Diagnosis } from '$lib/notebookSync';
	import {
		loadNotebookThresholds,
		type NotebookViewerThresholds,
	} from '$lib/notebookThresholds';
	import { isOperationEvent, serverEventsStore } from '$lib/stores/serverEvents';
	import NotebookLoadPanel from '$lib/components/NotebookLoadPanel.svelte';
	import NotebookHealthPanel from '$lib/components/NotebookHealthPanel.svelte';
	import {
		emptyProgress,
		reduceLoadEvent,
		applyBurst,
		expectedSeconds,
		type LoadProgress,
	} from '$lib/notebookLoadProgress';
	import { describeLoadError } from '$lib/notebookLoadReason';
	import {
		idleTimeoutOptions,
		idleTimeoutValue,
		parseIdleTimeoutValue,
	} from '$lib/notebookIdleTimeout';

	let notebookId = $derived($page.params.id as string);
	let notebook = $state<Notebook | null>(null);
	// Set when a saved timeout could not be pushed to the running kernel. Not
	// an error — the value is persisted and travels with the next load — so it
	// gets a muted line rather than the red banner.
	let idleTimeoutNote = $state<string | null>(null);
	let initialising = $state(true);
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let timings = $state<NotebookTimings | null>(null);
	let timingsPoll: ReturnType<typeof setTimeout> | null = null;

	// What else is on this worker. A notebook subprocess is ~190MB — the
	// largest process on the machine — so the second one on a 512MB worker is
	// what gets something OOM-killed. `pendingRefusal` is the server's 409:
	// this load would add a notebook, and it wants that said out loud first.
	let occupancy = $state<WorkerOccupancy | null>(null);
	let pendingRefusal = $state<AdditionalNotebookRefusal | null>(null);

	// Why the notebook is not loaded, in words; null while it is loaded or
	// nothing has been recorded. Shared with the wiring panel so the two
	// never disagree about whether an unload was expected.
	// The worker's size, from occupancy, is named in an OOM kill's label.
	let loadReason = $derived(
		notebook
			? describeLoadError(notebook.load_state, notebook.load_error, {
					idleTimeoutSeconds: notebook.effective_idle_timeout_seconds,
					workerMemoryMb: occupancy?.memory.container_total_mb ?? null,
				})
			: null,
	);

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

	// Served by the control plane. Until they arrive the badge reads
	// "checking" and no remount is planned. The poll interval is one of them,
	// so while they are missing the page retries on this delay instead.
	let thresholds = $state<NotebookViewerThresholds | null>(null);
	const THRESHOLDS_RETRY_MS = 5000;

	// The oldest push the kernel has not drawn yet, on this page's monotonic
	// clock. A report names only the latest push, and a net stepping every few
	// seconds keeps that young while the page stays frozen, so the page keeps
	// the earlier one until a frame newer than it arrives.
	let undrawnPushAt: number | null = null;
	let carriedPushAgeS = $state<number | null>(null);

	// Slow operations, from the event stream. The notebook's own (its load)
	// and its worker's are what `diagnose` reads to tell busy from broken, and
	// what the page shows while it waits. A load answers 202 with its
	// operation and the page follows it here rather than holding the request.
	let operations = $state<OperationBook>(emptyBook());
	let notebookOperation = $derived(
		notebook ? operationFor(operations, 'notebook', notebookId, notebook.active_operation) : null,
	);
	let workerOperation = $derived(
		operationOnWorker(operations, notebook?.worker_id, syncState?.worker_busy_with),
	);
	// The last load of this notebook that ended badly, shown beside the
	// "not loaded" panel so the step it died in stays readable.
	let failedLoad = $state<Operation | null>(null);

	// Self-heal state. `remountHistory` holds the epoch seconds of automatic
	// remounts; planRemount prunes it to its sliding window, so a recovery
	// does not refund the budget but time does.
	let remountHistory = $state<number[]>([]);
	let remountExhausted = $state(false);
	let remountPending: ReturnType<typeof setTimeout> | null = null;

	// Computed at poll time rather than derived. Half its inputs are clocks —
	// how long since the burst settled, how long since the last frame — and a
	// derived value would only recompute when something else happened to
	// change, which is precisely the "looks fine because nothing told us
	// otherwise" failure this page is being fixed for.
	let diagnosis = $state<Diagnosis | null>(null);

	async function pollSync() {
		if (thresholds === null) {
			thresholds = await loadNotebookThresholds().catch(() => null);
		}
		if (notebook?.load_state === 'loading') {
			// The event stream reports the end of a load; this re-read is the
			// fallback for a stream that dropped it.
			notebook = await getNotebook(notebookId).catch(() => notebook);
		}
		if (notebook?.load_state !== 'loaded') {
			syncState = null;
			diagnosis = null;
			// A new subprocess starts with no frames, so a push remembered
			// from the old one would read as undrawn.
			undrawnPushAt = null;
			carriedPushAgeS = null;
		} else {
			try {
				const reading = await getNotebookSync(notebookId);
				const nowS = performance.now() / 1000;
				const carried = undrawnPushAt === null ? null : nowS - undrawnPushAt;
				const undrawn = undrawnPushAgeS(reading, carried);
				undrawnPushAt = undrawn === null ? null : nowS - undrawn;
				carriedPushAgeS = carried;
				syncState = reading;
				rediagnose();
			} catch {
				// A failed poll says nothing about the notebook, only about
				// this request, so leave the last reading in place and let its
				// age speak for itself on the next render.
			}
		}
		syncPoll = setTimeout(
			pollSync,
			thresholds ? thresholds.sync_poll_s * 1000 : THRESHOLDS_RETRY_MS,
		);
	}

	// Judge the last reading again. Run on every poll, and whenever an
	// operation starts or ends: a worker that has just become busy must stop
	// a queued remount now, not at the next poll.
	function rediagnose() {
		if (!syncState) return;
		diagnosis = diagnose(syncState, thresholds, {
			sinceBurstSettledS: sinceBurstSettledS(),
			carriedPushAgeS,
			notebookOperation,
			workerOperation: operationOnWorker(
				operations,
				notebook?.worker_id,
				syncState.worker_busy_with,
			),
		});
		considerRemount();
	}

	// The render channel is the half of this system nothing used to watch. It
	// carries what the iframe actually draws, and it fails independently of
	// the freshness numbers above — a notebook once sat frozen for 259s while
	// every one of them read healthy, because the browser had not opened its
	// socket. The page cannot check that directly: the iframe is cross-origin,
	// so its socket is invisible from here. The worker counts it and we act on
	// what it reports.
	function considerRemount() {
		// No thresholds, no budget: a remount planned without one is a guess.
		if (!diagnosis || !thresholds) return;

		if (remountPending) {
			// One is already queued. Do not consult the plan again — polls
			// arrive every 5s and the backoff is longer than that, so
			// re-planning here would spend the whole retry budget waiting for
			// the first retry. The only decision left is whether to call it
			// off, which a notebook that recovered on its own has earned, and
			// so has one whose worker has since become busy.
			if (!diagnosis.automatic) {
				clearTimeout(remountPending);
				remountPending = null;
			}
			return;
		}

		const plan = planRemount(diagnosis, remountHistory, Date.now() / 1000, thresholds);
		remountHistory = plan.history;
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

	// The same remount, on request. Resets the remount history: the automatic
	// budget exists to stop an unattended page looping, and a person asking for
	// one is not that.
	function remountNow() {
		if (remountPending) {
			clearTimeout(remountPending);
			remountPending = null;
		}
		remountHistory = [];
		remountExhausted = false;
		mountToken += 1;
		if (timingsPoll) clearTimeout(timingsPoll);
		timingsPoll = null;
		burstSettledAt = null;
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
		if (isOperationEvent(evt)) {
			operations = applyOperationEvent(operations, evt);
			const own = evt.subject_kind === 'notebook' && evt.subject_id === notebookId;
			if (own && evt.type === 'operation_finished') {
				failedLoad = evt.state === 'succeeded' ? null : pickOperation(evt);
				void settleLoad();
			}
			if (own || (notebook?.worker_id && evt.worker_id === notebook.worker_id)) rediagnose();
			return;
		}
		if (evt.type !== 'notebook_state_changed') return;
		if (evt.notebook_id !== notebookId) return;
		if (!notebook) return;
		notebook = {
			...notebook,
			load_state: evt.load_state,
			load_error: evt.load_error ?? null,
			worker_id: evt.worker_id ?? notebook.worker_id,
			// A row that has left `loading` has no load in flight, so the
			// operation read with it must not hold the page in `busy`.
			active_operation: evt.load_state === 'loading' ? notebook.active_operation : null,
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
			// A notebook already loading has its operation running; asking
			// again would be refused, so the page follows the one in flight.
			if (notebook.load_state !== 'loaded' && notebook.load_state !== 'loading') {
				await ensureLoaded();
			}
			refreshOccupancy();
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
		} finally {
			initialising = false;
			// The load stream stays open while the load's operation runs;
			// once it has ended, the burst that follows is reported by the
			// timings poll, which the iframe's onload starts.
			if (notebook?.load_state !== 'loading') stopLoadStream();
		}
	}

	/**
	 * Follow a load the server accepted. The 202 carries its operation, which
	 * the page shows at once; the end arrives as `operation_finished` and
	 * `notebook_state_changed` on the event stream. Null is a server that
	 * finished the load inside the request, so the row is re-read instead.
	 */
	async function followLoad(operation: Operation | null) {
		if (!operation) {
			notebook = await getNotebook(notebookId);
			stopLoadStream();
			return;
		}
		operations = applyOperationEvent(operations, operation);
		failedLoad = null;
		if (notebook) notebook = { ...notebook, load_state: 'loading', load_error: null };
		if (!loadEvents) startLoadStream();
	}

	/** The load's operation ended: read the row it left behind. */
	async function settleLoad() {
		try {
			notebook = await getNotebook(notebookId);
		} catch {
			// The next poll re-reads it.
		}
		if (notebook?.load_state !== 'loading') stopLoadStream();
		refreshOccupancy();
	}

	async function ensureLoaded(confirmAdditional = false) {
		if (!notebook) return;
		if (!notebook.worker_id) {
			errorMessage = 'Notebook is not assigned to a worker. Pick a worker on the Wiring page first.';
			return;
		}
		busy = true;
		try {
			const operation = await loadNotebook(notebookId, { confirmAdditional });
			pendingRefusal = null;
			await followLoad(operation);
		} catch (e: any) {
			// The server refuses once when this would be an additional notebook
			// on the worker. Opening the page loads it automatically, so without
			// this the ~190MB would be spent by following a link — show what is
			// running and let the user decide.
			// A 507 (`InsufficientMemoryError`) is a refusal with nothing to
			// confirm; its message names the remedies and is shown as it came.
			if (e instanceof AdditionalNotebookError) {
				pendingRefusal = e.refusal;
			} else {
				errorMessage = e?.message ?? String(e);
			}
		} finally {
			busy = false;
		}
	}

	function cancelAdditional() {
		pendingRefusal = null;
		history.length > 1 ? history.back() : goto('/notebooks');
	}

	/** Poll-free: occupancy changes only when something is loaded or evicted,
	 * so it is read at mount and after a load rather than on a timer. */
	async function refreshOccupancy() {
		const workerId = notebook?.worker_id;
		if (!workerId) return;
		try {
			occupancy = await getWorkerOccupancy(workerId);
		} catch {
			// A missing occupancy reading hides the banner; it never blocks the
			// notebook, which is the thing the user came for.
			occupancy = null;
		}
	}

	let upgrade = $derived(notebook ? upgradeAction(notebook) : null);

	/** The self-heal state a fresh subprocess must not inherit, reset when the
	 *  user starts one by hand (Reload or Upgrade). */
	function resetForNewSubprocess() {
		// The user has taken over, so the self-heal budget starts again. Not
		// resetting it would leave a page that had already exhausted its
		// retries unable to heal itself for the rest of its life, however many
		// times it was manually rescued in between.
		if (remountPending) clearTimeout(remountPending);
		remountPending = null;
		remountHistory = [];
		remountExhausted = false;
		burstSettledAt = null;
		undrawnPushAt = null;
		carriedPushAgeS = null;
	}

	/**
	 * Move this notebook to the newer deployment. The server unloads it,
	 * re-points the deployment keeping the bindings, and starts a load whose
	 * operation the 202 carries; from there it is followed like a Reload.
	 */
	async function handleUpgrade() {
		if (!notebook || !upgrade?.enabled) return;
		busy = true;
		errorMessage = null;
		idleTimeoutNote = null;
		startWallClock();
		resetForNewSubprocess();
		try {
			const operation = await upgradeNotebook(notebookId);
			startLoadStream();
			await followLoad(operation);
			refreshOccupancy();
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
		// The new kernel reads the stored timeout on load, so whatever the push
		// failed to deliver is delivered now; the note would be stale.
		idleTimeoutNote = null;
		// Starts before the unload: a Reload pays unload + load, and the unload
		// half was 15s in the field.
		startWallClock();
		resetForNewSubprocess();
		try {
			if (notebook.load_state === 'loaded') {
				await unloadNotebook(notebookId);
			}
			// Confirmed by construction: restarting a notebook the user already
			// had is not an additional one, and after the unload above the
			// server would otherwise see this as adding one back.
			const operation = await loadNotebook(notebookId, { confirmAdditional: true });
			startLoadStream();
			await followLoad(operation);
			refreshOccupancy();
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
		} finally {
			busy = false;
		}
	}

	/**
	 * Change how long the worker leaves this kernel idle.
	 *
	 * The control plane pushes the new value to the running subprocess, so a
	 * loaded notebook does not need a reload; when that push fails the PATCH
	 * still succeeds and says so, and the note below is the only place the user
	 * would otherwise find out that the kernel they are looking at is still on
	 * the old timeout. On failure the notebook object is replaced with an equal
	 * one so the `<select>` snaps back to what the server actually holds.
	 */
	async function handleIdleTimeoutChange(event: Event) {
		if (!notebook) return;
		const chosen = parseIdleTimeoutValue((event.currentTarget as HTMLSelectElement).value);
		if (chosen === notebook.idle_timeout_seconds) return;
		busy = true;
		idleTimeoutNote = null;
		try {
			const updated = await patchNotebook(notebookId, { idle_timeout_seconds: chosen });
			notebook = updated;
			if (updated.idle_timeout_pushed === false) {
				idleTimeoutNote = 'saved; the running kernel keeps its old timeout until the next load';
			}
		} catch (e: any) {
			errorMessage = e?.message ?? String(e);
			notebook = { ...notebook };
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
		<a class="text-accent hover:underline" href="/notebooks">← Notebooks</a>
		{#if notebook}
			<span class="text-foreground-muted">/</span>
			<span class="font-medium text-foreground truncate">{notebook.instance_name}</span>
			<span class="text-foreground-muted text-xs font-mono">({notebook.definition_name})</span>
			<ProvenanceChip deployment={notebook.deployment} newer={notebook.newer_deployment} />
			<span
				class="inline-block px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
				style="background: {statusColor(notebook.load_state)}"
			>
				{notebook.load_state}
			</span>
			{#if loadReason}
				<span
					class="text-xs {loadReason.tone === 'failure' ? 'text-red-500' : 'text-foreground-muted'}"
					title="Click Reload to restart the subprocess. Your bindings are preserved."
				>
					· {loadReason.label}
				</span>
			{/if}
			<!-- How long this notebook may sit unopened before the worker frees
			     its kernel. Per notebook, because the right answer depends on
			     what the notebook is for: an hourly dashboard and a scratch pad
			     want opposite things, and only the person here knows which. -->
			<label class="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-foreground-muted">
				<span>Idle timeout</span>
				<select
					class="px-1.5 py-0.5 border border-border rounded bg-card text-foreground text-[11px] disabled:opacity-50"
					value={idleTimeoutValue(notebook.idle_timeout_seconds)}
					onchange={handleIdleTimeoutChange}
					disabled={busy}
					title="The worker frees this notebook's kernel after this much time without a browser request, to reclaim its ~190MB. Opening the page loads it again."
				>
					{#each idleTimeoutOptions(notebook.idle_timeout_seconds, notebook.effective_idle_timeout_seconds) as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
			{#if idleTimeoutNote}
				<span class="text-[11px] text-foreground-muted">· {idleTimeoutNote}</span>
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
			{#if diagnosis && syncState}
				<NotebookHealthPanel
					sync={syncState}
					{diagnosis}
					{thresholds}
					{carriedPushAgeS}
					{notebookId}
					onact={diagnosis.action === 'remount' ? remountNow : handleReload}
				/>
			{/if}
			{#if notebookOperation ?? workerOperation}
				<!-- Known work in flight. While it runs the page waits and does
				     not remount, so it says what it is waiting for. -->
				<span class="text-foreground-muted text-xs">·</span>
				<OperationStatus operation={(notebookOperation ?? workerOperation)!} compact />
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
		{#if notebook && upgrade}
			<button
				class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
				onclick={handleUpgrade}
				disabled={busy || notebookOperation !== null || !upgrade.enabled}
				title={notebookOperation ? 'A load is already in flight' : upgrade.reason}
			>
				Upgrade
			</button>
		{/if}
		{#if notebook}
			<button
				class="px-2.5 py-1 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
				onclick={handleReload}
				disabled={busy || notebookOperation !== null}
				title={notebookOperation ? 'A load is already in flight' : undefined}
			>
				{busy ? 'Working…' : 'Reload'}
			</button>
		{/if}
	</div>
</div>

<NotebookErrorsBanner {notebookId} />

<NotebookOccupancyBanner
	{occupancy}
	{notebookId}
	definitionName={notebook?.definition_name}
/>

{#if pendingRefusal}
	<!-- Ahead of `initialising`: the load stopped to ask a question, so the
	     load panel would be counting up a wait that is not happening. -->
	<NotebookLoadConfirm
		notebookName={notebook?.instance_name ?? 'this notebook'}
		refusal={pendingRefusal}
		{busy}
		onconfirm={() => ensureLoaded(true)}
		oncancel={cancelAdditional}
	/>
{:else if initialising || notebook?.load_state === 'loading'}
	{#if notebookOperation}
		<div class="mx-6 mt-4 max-w-xl">
			<OperationStatus operation={notebookOperation} />
		</div>
	{/if}
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
{:else if notebook}
	<!-- Not loaded yet — either failed silently or no worker -->
	<div class="m-6 p-4 border border-border rounded bg-card text-sm">
		<p class="text-foreground">Notebook is not loaded.</p>
		<p class="text-foreground-muted text-xs mt-1">
			Load state: <code>{notebook.load_state}</code>
			{#if loadReason}
				· {loadReason.heading.toLowerCase()}: {loadReason.label}
			{/if}
		</p>
		{#if failedLoad}
			<div class="mt-3 max-w-xl">
				<OperationStatus operation={failedLoad} />
			</div>
		{/if}
		<button
			class="mt-3 px-3 py-1.5 border border-accent rounded bg-card text-accent text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
			onclick={() => ensureLoaded()}
			disabled={busy}
		>
			{busy ? 'Loading…' : 'Load on assigned worker'}
		</button>
	</div>
{/if}

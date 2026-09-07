<script lang="ts">
	/**
	 * The notebooks index.
	 *
	 * Until this page existed the only way to find a notebook was the wiring
	 * canvas, where it is one node among workers, nets and bindings — so a
	 * person arriving from a bookmark or an alert had no list to fall back to,
	 * and no page answered "which notebooks exist, where do they run, are they
	 * healthy" without opening each one in turn (which *loads* each one, at
	 * ~190MB a time).
	 *
	 * Nets appear here only as a per-worker count and as the targets of
	 * bindings. The Nets page owns nets; duplicating their rows here would mean
	 * two places to keep honest about the same thing.
	 *
	 * All the derivation lives in `$lib/notebookIndex` — grouping, the badge
	 * table, the header line — so the cases can be asserted without a browser.
	 * This file is fetching, patching and markup.
	 */
	import { onDestroy, onMount } from 'svelte';

	import AppNav from '$lib/components/AppNav.svelte';
	import DataLoadState from '$lib/components/DataLoadState.svelte';
	import NotebookLoadConfirm from '$lib/components/NotebookLoadConfirm.svelte';
	import NotebookOccupancyBanner from '$lib/components/NotebookOccupancyBanner.svelte';
	import {
		AdditionalNotebookError,
		getNotebook,
		getNotebookSync,
		getWiring,
		getWorkerOccupancy,
		listNotebookErrors,
		listNotebooks,
		loadNotebook,
		unloadNotebook,
		type AdditionalNotebookRefusal,
		type NotebookSync,
		type WiringNotebook,
		type WiringResponse,
		type WorkerOccupancy,
	} from '$lib/api';
	import {
		groupByWorker,
		isLoaded,
		notebookBadge,
		viewersHint,
		type NotebookRow,
	} from '$lib/notebookIndex';
	import { formatElapsed } from '$lib/runs';
	import { serverEventsStore, type ServerEvent } from '$lib/stores/serverEvents';

	// -- state --

	let wiring = $state<WiringResponse | null>(null);
	let loadedOnce = $state(false);
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	/** `/sync` per loaded notebook. Absent means "not asked yet or not loaded",
	 *  which the badge renders as `checking…` rather than as a verdict. */
	let syncById = $state<Map<string, NotebookSync>>(new Map());
	let errorsById = $state<Map<string, number>>(new Map());
	/** `updated_at` is on the notebook rows, not on the wiring payload, so it
	 *  comes from one extra list call rather than from a per-row fetch. */
	let updatedById = $state<Map<string, string>>(new Map());

	let busyId = $state<string | null>(null);

	// The same two pieces the notebook page uses before spending ~190MB on a
	// worker: what else is running there, and the server's 409 when this load
	// would add a notebook rather than restart one.
	let occupancy = $state<WorkerOccupancy | null>(null);
	let occupancyFor = $state<{ id: string; definitionName: string } | null>(null);
	let pendingRefusal = $state<{ id: string; refusal: AdditionalNotebookRefusal } | null>(null);

	/** Ticked with the poll so relative ages move without a second timer. */
	let now = $state(Date.now());

	const sections = $derived(wiring ? groupByWorker(wiring) : []);
	const notebookCount = $derived(wiring?.notebooks.length ?? 0);

	function message(e: unknown): string {
		return e instanceof Error ? e.message : String(e);
	}

	// -- fetching --

	async function refreshAll() {
		try {
			// The notebook list is only here for `updated_at`; a failure to get
			// it must not cost the page its rows.
			const [w, notebooks] = await Promise.all([
				getWiring(),
				listNotebooks().catch(() => []),
			]);
			wiring = w;
			updatedById = new Map(notebooks.map((n) => [n.id, n.updated_at]));
			loadError = null;
			await refreshLoadedDetail();
		} catch (e) {
			loadError = message(e);
		} finally {
			loadedOnce = true;
		}
	}

	/** `/sync` and `/errors` for the loaded notebooks, all at once.
	 *
	 * Only the loaded ones: an unloaded notebook has no subprocess to report,
	 * and asking anyway would be N pointless round trips on a page whose whole
	 * point is not having to open each notebook. */
	async function refreshLoadedDetail() {
		const ids = (wiring?.notebooks ?? []).filter(isLoaded).map((n) => n.id);
		if (ids.length === 0) return;
		const results = await Promise.all(
			ids.map(async (id) => ({
				id,
				sync: await getNotebookSync(id).catch(() => null),
				errors: await listNotebookErrors(id)
					.then((e) => e.length)
					.catch(() => null),
			})),
		);
		const nextSync = new Map(syncById);
		const nextErrors = new Map(errorsById);
		for (const r of results) {
			// A failed poll says nothing about the notebook, only about this
			// request — so the last reading stays and its age speaks for itself.
			if (r.sync) nextSync.set(r.id, r.sync);
			if (r.errors !== null) nextErrors.set(r.id, r.errors);
		}
		syncById = nextSync;
		errorsById = nextErrors;
		now = Date.now();
	}

	async function refreshSyncOnly() {
		await refreshLoadedDetail();
	}

	/** Re-read one notebook after an action, and its detail if it is now loaded. */
	async function refreshNotebook(id: string) {
		try {
			const fresh = await getNotebook(id);
			patchNotebookRow(id, {
				load_state: fresh.load_state,
				load_error: fresh.load_error,
				worker_id: fresh.worker_id,
			});
			updatedById = new Map(updatedById).set(id, fresh.updated_at);
			if (fresh.load_state === 'loaded') {
				await refreshDetailFor(id);
			} else {
				dropDetail(id);
			}
		} catch (e) {
			actionError = message(e);
		}
	}

	async function refreshDetailFor(id: string) {
		const [sync, errors] = await Promise.all([
			getNotebookSync(id).catch(() => null),
			listNotebookErrors(id)
				.then((e) => e.length)
				.catch(() => null),
		]);
		if (sync) syncById = new Map(syncById).set(id, sync);
		if (errors !== null) errorsById = new Map(errorsById).set(id, errors);
	}

	function dropDetail(id: string) {
		// Nulled rather than kept: a freshness reading for a subprocess that no
		// longer exists is the one thing worse than no reading at all.
		const nextSync = new Map(syncById);
		nextSync.delete(id);
		syncById = nextSync;
	}

	function patchNotebookRow(id: string, patch: Partial<WiringNotebook>) {
		const row = wiring?.notebooks.find((n) => n.id === id);
		if (!row) return;
		Object.assign(row, patch);
	}

	// -- live updates --

	let unsubscribeEvents: (() => void) | null = null;
	let lastEventSeq = -1;

	function applyServerEvent(evt: ServerEvent) {
		if (!wiring) return;
		if (evt.type === 'worker_state_changed') {
			const w = wiring.workers.find((x) => x.id === evt.worker_id);
			if (w) {
				w.status = evt.status;
				w.status_detail = evt.status_detail ?? null;
			} else {
				void refreshAll();
			}
		} else if (evt.type === 'net_state_changed') {
			const n = wiring.nets.find((x) => x.id === evt.net_id);
			// An unknown net means the count in a header is now wrong, and the
			// count is the only thing nets contribute to this page.
			if (n) n.load_state = evt.load_state;
			else void refreshAll();
		} else if (evt.type === 'notebook_state_changed') {
			const nb = wiring.notebooks.find((x) => x.id === evt.notebook_id);
			if (!nb) {
				void refreshAll();
				return;
			}
			nb.load_state = evt.load_state;
			nb.load_error = evt.load_error ?? null;
			if (evt.worker_id !== undefined) nb.worker_id = evt.worker_id;
			if (evt.load_state === 'loaded') void refreshDetailFor(nb.id);
			else dropDetail(nb.id);
		} else if (evt.type === 'notebook_error') {
			const nb = wiring.notebooks.find((x) => x.id === evt.notebook_id);
			if (!nb) return;
			// Refetched rather than incremented: the event fires per occurrence
			// but the column counts *groups*, and `dismissed_all` moves it down.
			void listNotebookErrors(nb.id)
				.then((e) => {
					errorsById = new Map(errorsById).set(nb.id, e.length);
				})
				.catch(() => {});
		}
	}

	// -- the visibility-gated sync poll --

	const SYNC_POLL_MS = 10_000;
	let syncPoll: ReturnType<typeof setInterval> | null = null;

	function startPoll() {
		if (syncPoll !== null) return;
		syncPoll = setInterval(() => void refreshSyncOnly(), SYNC_POLL_MS);
	}

	function stopPoll() {
		if (syncPoll === null) return;
		clearInterval(syncPoll);
		syncPoll = null;
	}

	// Stopped rather than skipped while hidden. A background tab left open for
	// a day would otherwise keep N notebooks' worth of requests going against
	// workers whose memory is the scarce thing here.
	function handleVisibility() {
		if (document.visibilityState === 'visible') {
			void refreshSyncOnly();
			startPoll();
		} else {
			stopPoll();
		}
	}

	onMount(async () => {
		await refreshAll();
		unsubscribeEvents = serverEventsStore.subscribe((evt) => {
			if (!evt) return;
			// `seq` dedupes: a Svelte store may replay its last value on
			// subscribe, and each event must be acted on exactly once.
			const seq = typeof evt.seq === 'number' ? evt.seq : null;
			if (seq !== null) {
				if (seq <= lastEventSeq) return;
				lastEventSeq = seq;
			}
			applyServerEvent(evt);
		});
		document.addEventListener('visibilitychange', handleVisibility);
		if (document.visibilityState === 'visible') startPoll();
	});

	onDestroy(() => {
		unsubscribeEvents?.();
		stopPoll();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', handleVisibility);
		}
	});

	// -- actions --

	async function refreshOccupancy(nb: WiringNotebook) {
		if (!nb.worker_id) return;
		occupancyFor = { id: nb.id, definitionName: nb.definition_name };
		try {
			occupancy = await getWorkerOccupancy(nb.worker_id);
		} catch {
			// A missing reading hides the banner; it never blocks the action.
			occupancy = null;
		}
	}

	async function handleLoad(nb: WiringNotebook, confirmAdditional = false) {
		if (!nb.worker_id) {
			actionError = `${nb.instance_name} is not assigned to a worker. Assign one on the Wiring page first.`;
			return;
		}
		busyId = nb.id;
		actionError = null;
		try {
			await loadNotebook(nb.id, { confirmAdditional });
			pendingRefusal = null;
			await refreshNotebook(nb.id);
			void refreshOccupancy(nb);
		} catch (e) {
			// The server refuses once when this would be an *additional*
			// notebook on the worker — a notebook subprocess is the largest
			// process on a machine, so that spend gets a decision attached to
			// it rather than being made by a click.
			if (e instanceof AdditionalNotebookError) {
				pendingRefusal = { id: nb.id, refusal: e.refusal };
			} else {
				actionError = message(e);
			}
		} finally {
			busyId = null;
		}
	}

	async function handleUnload(nb: WiringNotebook) {
		busyId = nb.id;
		actionError = null;
		try {
			await unloadNotebook(nb.id);
			await refreshNotebook(nb.id);
		} catch (e) {
			actionError = message(e);
		} finally {
			busyId = null;
		}
	}

	async function handleReload(nb: WiringNotebook) {
		busyId = nb.id;
		actionError = null;
		try {
			if (nb.load_state === 'loaded') await unloadNotebook(nb.id);
			// Confirmed by construction: restarting a notebook the user already
			// had is not an additional one, and after the unload above the
			// server would otherwise see it as adding one back.
			await loadNotebook(nb.id, { confirmAdditional: true });
			await refreshNotebook(nb.id);
			void refreshOccupancy(nb);
		} catch (e) {
			actionError = message(e);
		} finally {
			busyId = null;
		}
	}

	function confirmPending() {
		const target = pendingRefusal;
		if (!target) return;
		const nb = wiring?.notebooks.find((n) => n.id === target.id);
		if (nb) void handleLoad(nb, true);
	}

	// -- row helpers --

	function badgeFor(row: NotebookRow) {
		return notebookBadge(row.notebook, syncById.get(row.notebook.id) ?? null, errorsById.get(row.notebook.id) ?? 0);
	}

	function lastChange(id: string): string | null {
		const elapsed = formatElapsed(updatedById.get(id), now);
		return elapsed ? `${elapsed} ago` : null;
	}
</script>

<svelte:head>
	<title>Notebooks · Petri</title>
</svelte:head>

<AppNav title="Notebooks" />

<div class="max-w-[1100px] mx-auto p-8">
	<div class="flex items-center justify-between mb-6">
		<div class="text-sm text-foreground-muted">
			{#if wiring}
				{notebookCount} notebook{notebookCount === 1 ? '' : 's'} ·
				{wiring.workers.length} worker{wiring.workers.length === 1 ? '' : 's'}
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<a
				class="px-3 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium no-underline transition-all hover:bg-accent hover:text-accent-foreground"
				href="/wiring?add="
			>
				+ Add notebook
			</a>
			<button
				class="px-3 py-1.5 border border-border rounded bg-card text-foreground-muted text-sm cursor-pointer hover:text-foreground"
				onclick={() => void refreshAll()}
			>
				Refresh
			</button>
		</div>
	</div>

	{#if actionError}
		<div class="mb-4 p-3 border border-red-500 rounded bg-red-50 text-red-700 text-sm">
			{actionError}
		</div>
	{/if}

	{#if occupancyFor}
		<NotebookOccupancyBanner
			{occupancy}
			notebookId={occupancyFor.id}
			definitionName={occupancyFor.definitionName}
		/>
	{/if}

	{#if pendingRefusal}
		<NotebookLoadConfirm
			refusal={pendingRefusal.refusal}
			busy={busyId === pendingRefusal.id}
			onconfirm={confirmPending}
			oncancel={() => (pendingRefusal = null)}
		/>
	{/if}

	<DataLoadState
		loading={!loadedOnce}
		error={loadError}
		isEmpty={notebookCount === 0}
		loadingMessage="Loading notebooks…"
	>
		{#snippet empty()}
			<div class="text-center text-foreground-muted p-8">
				<p class="text-sm">
					No notebooks yet. A notebook comes from a deployment — push one on the
					<a class="text-accent hover:underline" href="/deployments">Deployments</a> page, then add
					an instance from
					<a class="text-accent hover:underline" href="/wiring?add=">Wiring</a>.
				</p>
			</div>
		{/snippet}

		<div class="flex flex-col gap-6">
			{#each sections as section (section.key)}
				<section>
					<div class="flex items-baseline justify-between gap-3 mb-2">
						<div class="flex items-baseline gap-3 min-w-0">
							{#if section.worker}
								<a
									class="font-semibold text-foreground no-underline hover:underline truncate"
									href="/workers">{section.title}</a
								>
							{:else}
								<span class="font-semibold text-foreground">{section.title}</span>
							{/if}
							{#if section.header}
								<span class="text-xs text-foreground-muted" title={section.header.line}>
									{section.header.parts.join(' · ')} ·
									<a class="text-accent hover:underline" href="/nets">{section.header.nets}</a>
								</span>
							{:else}
								<span class="text-xs text-foreground-muted">no worker assigned</span>
							{/if}
						</div>
						{#if section.worker}
							<a
								class="text-xs text-accent no-underline hover:underline whitespace-nowrap"
								href="/wiring?add={section.worker.id}"
							>
								Add notebook
							</a>
						{/if}
					</div>

					{#if section.rows.length === 0}
						<p class="text-xs text-foreground-muted border border-border rounded bg-card px-3 py-2">
							No notebooks on this worker.
						</p>
					{:else}
						<div class="border border-border rounded bg-card overflow-hidden">
							{#each section.rows as row (row.notebook.id)}
								{@const nb = row.notebook}
								{@const badge = badgeFor(row)}
								{@const viewers = viewersHint(syncById.get(nb.id) ?? null)}
								{@const errors = errorsById.get(nb.id) ?? 0}
								{@const changed = lastChange(nb.id)}
								<div
									class="flex items-center gap-3 flex-wrap px-3 py-2 border-b border-border last:border-b-0 text-sm"
								>
									<span
										class="inline-block w-2 h-2 rounded-full shrink-0"
										style="background: {badge.colour}"
										aria-hidden="true"
									></span>
									<a
										class="font-medium text-foreground no-underline hover:underline truncate"
										href="/notebooks/{nb.id}">{nb.instance_name}</a
									>
									<span class="text-xs text-foreground-muted font-mono truncate"
										>{nb.definition_name}</span
									>
									<span
										class="text-[11px] px-2 py-0.5 rounded-full text-white font-medium whitespace-nowrap"
										style="background: {badge.colour}"
										title={badge.title}
									>
										{badge.label}
									</span>
									{#if badge.detail}
										<span class="text-xs text-foreground-muted whitespace-nowrap" title={badge.title}
											>{badge.detail}</span
										>
									{/if}
									{#if viewers}
										<span class="text-xs text-foreground-faint whitespace-nowrap">{viewers}</span>
									{/if}

									{#each row.bindings as binding (binding.slotName)}
										<a
											class="text-xs text-accent no-underline hover:underline whitespace-nowrap"
											href="/nets?net={binding.netId}"
											title="slot {binding.slotName}"
										>
											→ {binding.netName ?? binding.netId}
										</a>
									{/each}

									<a
										class="text-xs no-underline hover:underline whitespace-nowrap {errors > 0
											? 'text-red-500'
											: 'text-foreground-muted'}"
										href="/notebooks/{nb.id}"
									>
										{errors} error{errors === 1 ? '' : 's'}
									</a>

									{#if changed}
										<span class="text-xs text-foreground-faint whitespace-nowrap">{changed}</span>
									{/if}

									<div class="ml-auto flex items-center gap-2 whitespace-nowrap">
										<a
											class="text-xs text-accent no-underline hover:underline"
											href="/notebooks/{nb.id}">Open</a
										>
										{#if !nb.worker_id}
											<a class="text-xs text-accent no-underline hover:underline" href="/wiring"
												>Assign in wiring</a
											>
										{:else if nb.load_state === 'loaded'}
											<button
												class="text-xs text-accent hover:underline disabled:opacity-50"
												onclick={() => void handleUnload(nb)}
												disabled={busyId === nb.id}>Unload</button
											>
											<button
												class="text-xs text-accent hover:underline disabled:opacity-50"
												onclick={() => void handleReload(nb)}
												disabled={busyId === nb.id}>Reload</button
											>
										{:else}
											<button
												class="text-xs text-accent hover:underline disabled:opacity-50"
												onclick={() => void handleLoad(nb)}
												disabled={busyId === nb.id || nb.load_state === 'loading'}>Load</button
											>
										{/if}
										{#if busyId === nb.id}
											<span class="text-xs text-foreground-muted">working…</span>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
		</div>
	</DataLoadState>
</div>

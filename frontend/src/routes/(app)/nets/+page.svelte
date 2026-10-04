<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { workerEventsStore, workerStreamStore, connectToWorker, disconnectWorkerEvents } from '$lib/stores/workerEvents';
	import { statusLabel, liveAction, capTail, mergeLogEntries, lastLogSeq, EXECUTION_LOG_CAP, NET_LOG_CAP } from '$lib/workerStream';
	import { selectedTokenId } from '$lib/stores/tokenSelection';
	import { isOperationEvent, isRunEvent, serverEventsStore } from '$lib/stores/serverEvents';
	import OperationStatus from '$lib/components/OperationStatus.svelte';
	import ProvenanceChip from '$lib/components/ProvenanceChip.svelte';
	import { provenanceSuffix } from '$lib/provenance';
	import { applyOperationEvent, emptyBook, operationFor, type OperationBook } from '$lib/operations';
	import {
		workerMemoryStore,
		workerMemoryUsedMb,
		type WorkerMemorySnapshot,
	} from '$lib/stores/workerMemory';
	import {
		logout,
		listNets, listWorkers, patchNet, loadNet, unloadNet,
		getExecutionState, executionStep, executionStart, executionStop, executionReset, executionInject,
		enableTransition, disableTransition,
		listNetSecrets, setNetSecrets, getNetLogHistory, getExecutionHistory, runNetNow,
		diagnoseNet, isNotLoaded, isStillInProgress, type NetDiagnosis,
		type Net, type Worker, type NetParam, type SecretMetadata,
	} from '$lib/api';
	import GraphPanel from '$lib/components/GraphPanel.svelte';
	import ExecutionLog from '$lib/components/ExecutionLog.svelte';
	import PanelFailed from '$lib/components/PanelFailed.svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import TokenInspector from '$lib/components/TokenInspector.svelte';
	import TransitionInspector from '$lib/components/TransitionInspector.svelte';
	import AppNav from '$lib/components/AppNav.svelte';
	import DataLoadState from '$lib/components/DataLoadState.svelte';
	import RunsPanel from '$lib/components/RunsPanel.svelte';
	import { applyRunEvent, executionVerbs, formatStamp, pendingLabel, scheduleFacts } from '$lib/runs';
	import { portal } from '$lib/actions/portal';
	import { anomalyLabels, anomalySuffix } from '$lib/netAnomalies';
	import { groupByDefinition } from '$lib/netInstances';
	import { TOKEN_STAGE_MS, FIRING_ANIMATION_MS } from '$lib/tokenAnimation';
	import { diagnoseActivityLine, diagnoseClasses, diagnoseStateLabel } from '$lib/netDiagnose';
	import type { LogEntry, NetEvent, NetState, StepResult } from '$lib/types';
	import { layoutFor, type KeyedLayout } from '$lib/graphLayout';
	import {
		DEFAULT_TOKEN_LIMIT,
		anyInFlight,
		applyEvent,
		mirrorFromState,
		shouldAdopt,
		totalCount,
		type Change,
		type Mirror,
	} from '$lib/netMirror';
	import {
		activeEdges,
		busyTransitions,
		flashingTransitions,
		hiddenTokenIds,
		liveCues,
		nextWake,
		playChange,
		travelling,
		type Cue,
	} from '$lib/firingPlayback';
	import { drawNet, drawTokens, tokenPoint } from '$lib/netView';
	import { TOKEN_DOT_MAX, coerceParamValue, netFullLabel, parseOptionalSeconds } from '$lib/netHelpers';

	// What the page believes about the selected net's marking: built from a
	// state read and moved by the worker stream's state notifications, at
	// the held marking version plus one and no other (`netMirror.ts`). Null
	// while there is no state to show.
	let mirror = $state.raw<Mirror | null>(null);
	// The page lays the net out itself from the topology. Recomputed only
	// when the topology changes (a new generation), not on a marking update.
	let netLayout = $state.raw<KeyedLayout | null>(null);
	let logEntries = $state<LogEntry[]>([]);
	let connectionStatus = $state('Connecting...');

	// Sizes come from each place's `count`, never from its capped list.
	let totalTokenCount = $derived(totalCount(mirror));
	// Every place in topology order, for the token inspector.
	let mirrorPlaces = $derived(
		mirror ? mirror.topology.places.flatMap((p) => (mirror!.places[p.name] ? [mirror!.places[p.name]] : [])) : [],
	);
	// What the graph panel draws.
	let drawnNet = $derived(mirror && netLayout ? drawNet(mirror, netLayout.layout) : null);
	let drawnTokens = $derived(mirror && netLayout ? drawTokens(mirror, netLayout.layout) : []);
	// Places the inject form offers: only those whose tokens have a JSON form.
	let injectablePlaces = $derived((mirror?.topology.places ?? []).filter((p) => p.serializable));

	// Animation: cues played from the changes the mirror applied
	// (`firingPlayback.ts`), against a clock this page moves when a cue
	// starts or ends. The mirror is the truth; cues only travel over it.
	const MAX_CUES = 300;
	let cues = $state.raw<Cue[]>([]);
	let clock = $state(0);
	let stageOneEnds: Record<string, number> = {};
	let cueSerial = 0;
	let cueTimer: ReturnType<typeof setTimeout> | null = null;
	let travellingCues = $derived(travelling(cues, clock));
	let hiddenIds = $derived(hiddenTokenIds(cues, clock));
	let activeEdgeEnds = $derived(activeEdges(cues, clock));
	let firingTransitions = $derived(busyTransitions(cues, clock));
	let failingTransitions = $derived(flashingTransitions(cues, clock));

	function tickCues() {
		if (cueTimer) {
			clearTimeout(cueTimer);
			cueTimer = null;
		}
		clock = performance.now();
		const live = liveCues(cues, clock);
		if (live.length !== cues.length) cues = live;
		const wake = nextWake(live, clock);
		if (wake !== null) cueTimer = setTimeout(tickCues, Math.max(0, wake - performance.now()) + 5);
	}

	function clearPlayback() {
		if (cueTimer) {
			clearTimeout(cueTimer);
			cueTimer = null;
		}
		cues = [];
		stageOneEnds = {};
	}

	function play(change: Change) {
		const layout = netLayout?.layout;
		if (!layout) return;
		const now = performance.now();
		const played = playChange(change, {
			now,
			stageMs: TOKEN_STAGE_MS,
			stageOneEnds,
			transitionAt: (name) => {
				const at = layout.placements.get(name);
				return at ? { x: at.x, y: at.y } : null;
			},
			tokenAt: (place, slot) => tokenPoint(layout, place, slot),
			serial: ++cueSerial,
		});
		stageOneEnds = played.stageOneEnds;
		// A net firing faster than it can be watched: the drawing keeps up
		// with the mirror and the animation skips until it has caught up.
		if (played.cues.length === 0 || cues.length > MAX_CUES) return;
		cues = [...liveCues(cues, now), ...played.cues];
		tickCues();
	}

	// Auth state
	let userEmail = $derived($page.data.user?.email ?? '');

	// Net selection and execution state
	let availableNets = $state<Net[]>([]);
	// Tracks the first-fetch outcome so the "No nets" empty state only
	// appears after we actually know the answer.
	let netsLoaded = $state(false);
	let netsError = $state<string | null>(null);
	let selectedNetId = $state<string | null>(null);
	let isRunning = $state(false);
	// True while an Activate/Deactivate request is in flight and we await the
	// worker's authoritative reply. Drives the button spinner so the (now
	// non-optimistic) toggle doesn't look unresponsive during the round-trip.
	let isToggling = $state(false);
	let isAutoStepping = $state(false);
	// The step button's spinner: this page's own step request in flight.
	let isStepping = $state(false);
	// A step that outlasted the control plane's bound (504 `timeout`) has
	// not failed: its body runs on and the firing lands on the stream. Until
	// it does, the page still shows the step as under way.
	let stepAwaitingStream = $state(false);
	let stepBusy = $derived(isStepping || stepAwaitingStream);
	let stepNotice = $state<string | null>(null);
	// Enable and disable from the transition inspector.
	let togglingTransition = $state(false);
	let toggleError = $state<string | null>(null);
	let isResetting = $state(false);
	// Run now: one dispatch — unload, load, and the start that follows —
	// recorded as a manual run. `runNowError` holds the server's own words for
	// a refusal; the route's 409/400/503 details are written for a person.
	let isRunningNow = $state(false);
	let runNowError = $state<string | null>(null);
	let stepError = $state<string | null>(null);
	// Why the worker's view of the selected net could not be read: the
	// server's detail for any refusal other than "not loaded", which is a
	// state and not a fault. Kept with its net so a switch never shows
	// another net's refusal.
	let liveReadError = $state<{ netId: string; message: string } | null>(null);

	function noteLiveReadFailure(netId: string, error: unknown) {
		if (selectedNetId !== netId || isNotLoaded(error)) return;
		liveReadError = { netId, message: error instanceof Error ? error.message : String(error) };
	}

	// The execution log and the graph each sit in their own error boundary,
	// so an exception while one renders or runs an effect replaces that panel
	// with a fallback instead of stopping every update on the page. The error
	// still goes to the console for DevTools.
	function panelFailed(panel: string, error: unknown) {
		console.error(`[nets page] the ${panel} panel failed:`, error);
	}
	// Human-in-the-loop token injection: drop a typed token into a place to
	// drive an end-to-end test (e.g. synthetic traffic into the anomaly monitor).
	let showInject = $state(false);
	let injectPlaceName = $state('');
	let injectTokenJson = $state('{}');
	let isInjecting = $state(false);
	let injectError = $state<string | null>(null);
	let injectNotice = $state<string | null>(null);
	// Reason the net's continuous execution stopped on an error (a raised
	// transition). Cleared when the user next acts. A normal end-of-run
	// ("no_fireable_transitions") is not shown here.
	let executionStoppedReason = $state<string | null>(null);
	let subprocessLines = $state<string[]>([]);
	// Durable, net-wide subprocess log: seeded from the worker's rotating
	// file (survives restarts) and appended live. Distinct from
	// subprocessLines, which is the ephemeral current-step view that clears
	// on every step.
	let netLogLines = $state<string[]>([]);
	let netLogExpanded = $state(false);
	let selectedTransitionId = $state<string | null>(null);

	// Worker state
	let workers = $state<Worker[]>([]);
	let workerActionInProgress = $state(false);
	// Slow operations from the event stream. The selected net's load or
	// unload is shown beside its load badge, from the stream's copy when it
	// has one and from the net row's `active_operation` otherwise.
	let operations = $state<OperationBook>(emptyBook());

	// Factory params dialog state
	let showParamsDialog = $state(false);
	let paramsSchema = $state<NetParam[]>([]);
	let paramValues = $state<Record<string, string>>({});

	// Secrets dialog state
	let showSecretsDialog = $state(false);
	let secretEntries = $state<Array<{ key: string; value: string; isExisting: boolean }>>([]);
	let secretsSaving = $state(false);
	let secretsError = $state<string | null>(null);
	// In-flight flag — prevents rapid-fire clicks from queueing N copies of
	// the same slow GET while a previous one is still pending.
	let secretsLoading = $state(false);

	// Settings dialog state
	let showSettingsDialog = $state(false);
	let settingsTimeoutInput = $state<string | number | null>('');  // empty = unbounded
	let settingsStallInput = $state<string | number | null>('');  // empty = no verdict
	let settingsSaving = $state(false);
	let settingsError = $state<string | null>(null);

	function getRequiredParams(net: Net | undefined): NetParam[] {
		if (!net?.factory_params_schema) return [];
		return net.factory_params_schema;
	}

	// Panel layout state
	const PANEL_STORAGE_KEY = 'petrivelte-panel-layout';
	const MIN_SIDEBAR_WIDTH = 200;
	const MAX_SIDEBAR_WIDTH = 600;
	const DEFAULT_SIDEBAR_WIDTH = 350;
	const DEFAULT_PANEL_RATIO = 0.5;

	let execLogCollapsed = $state(false);
	let tokenInspectorCollapsed = $state(false);
	let sidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
	let execLogRatio = $state(DEFAULT_PANEL_RATIO);
	let rightSidebarCollapsed = $state(false);
	let rightSidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
	// The run history is a diagnostic rather than a dashboard, so it starts
	// collapsed and fetches nothing until it is opened.
	let runsExpanded = $state(false);

	// Drag state for resizing
	let isDraggingSidebar = $state(false);
	let isDraggingRightSidebar = $state(false);
	let isDraggingPanelDivider = $state(false);
	let dragStartX = 0;
	let dragStartY = 0;
	let dragStartWidth = 0;
	let dragStartRatio = 0;

	function loadPanelLayout() {
		if (typeof window === 'undefined') return;
		try {
			const saved = localStorage.getItem(PANEL_STORAGE_KEY);
			if (saved) {
				const layout = JSON.parse(saved);
				execLogCollapsed = layout.execLogCollapsed ?? false;
				tokenInspectorCollapsed = layout.tokenInspectorCollapsed ?? false;
				sidebarWidth = layout.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH;
				execLogRatio = layout.execLogRatio ?? DEFAULT_PANEL_RATIO;
				rightSidebarCollapsed = layout.rightSidebarCollapsed ?? false;
				rightSidebarWidth = layout.rightSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH;
				runsExpanded = layout.runsExpanded ?? false;
			}
		} catch (e) {
			console.warn('Failed to load panel layout:', e);
		}
	}

	function savePanelLayout() {
		if (typeof window === 'undefined') return;
		try {
			localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({
				execLogCollapsed,
				tokenInspectorCollapsed,
				sidebarWidth,
				execLogRatio,
				rightSidebarCollapsed,
				rightSidebarWidth,
				runsExpanded,
			}));
		} catch (e) {
			console.warn('Failed to save panel layout:', e);
		}
	}

	function toggleExecLog() {
		execLogCollapsed = !execLogCollapsed;
		savePanelLayout();
	}

	function toggleTokenInspector() {
		tokenInspectorCollapsed = !tokenInspectorCollapsed;
		savePanelLayout();
	}

	function toggleRuns() {
		runsExpanded = !runsExpanded;
		savePanelLayout();
	}

	function toggleRightSidebar() {
		rightSidebarCollapsed = !rightSidebarCollapsed;
		savePanelLayout();
	}

	function handleSidebarDragStart(event: MouseEvent) {
		isDraggingSidebar = true;
		dragStartX = event.clientX;
		dragStartWidth = sidebarWidth;
		event.preventDefault();
	}

	function handleRightSidebarDragStart(event: MouseEvent) {
		isDraggingRightSidebar = true;
		dragStartX = event.clientX;
		dragStartWidth = rightSidebarWidth;
		event.preventDefault();
	}

	function handlePanelDividerDragStart(event: MouseEvent) {
		isDraggingPanelDivider = true;
		dragStartY = event.clientY;
		dragStartRatio = execLogRatio;
		event.preventDefault();
	}

	function handleMouseMove(event: MouseEvent) {
		if (isDraggingSidebar) {
			const dx = event.clientX - dragStartX;
			sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, dragStartWidth + dx));
		}
		if (isDraggingRightSidebar) {
			const dx = dragStartX - event.clientX;
			rightSidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, dragStartWidth + dx));
		}
		if (isDraggingPanelDivider) {
			const container = document.querySelector('.sidebar-content');
			if (container) {
				const rect = container.getBoundingClientRect();
				const dy = event.clientY - rect.top;
				const newRatio = dy / rect.height;
				execLogRatio = Math.max(0.2, Math.min(0.8, newRatio));
			}
		}
	}

	function handleMouseUp() {
		if (isDraggingSidebar || isDraggingRightSidebar || isDraggingPanelDivider) {
			isDraggingSidebar = false;
			isDraggingRightSidebar = false;
			isDraggingPanelDivider = false;
			savePanelLayout();
		}
	}

	// Computed: is entire sidebar collapsed?
	let sidebarCollapsed = $derived(execLogCollapsed && tokenInspectorCollapsed);

	// Token selection handler
	function handleTokenSelect(tokenId: string | null) {
		$selectedTokenId = tokenId;
	}

	// Transition selection handler. Transitions are keyed by name.
	function handleTransitionSelect(transitionId: string | null) {
		selectedTransitionId = transitionId;
		toggleError = null;
		// Auto-expand right sidebar when a transition is selected
		if (transitionId && rightSidebarCollapsed) {
			rightSidebarCollapsed = false;
			savePanelLayout();
		}
	}

	let selectedTransition = $derived(
		selectedTransitionId && mirror
			? mirror.topology.transitions.find(t => t.name === selectedTransitionId) ?? null
			: null
	);
	let selectedTransitionState = $derived(
		selectedTransitionId && mirror ? mirror.transitions[selectedTransitionId] ?? null : null
	);

	async function handleToggleTransition(name: string, enable: boolean) {
		const netId = selectedNetId;
		if (!netId || togglingTransition) return;
		togglingTransition = true;
		toggleError = null;
		try {
			// The change itself arrives as `toggled` on the stream.
			await (enable ? enableTransition(netId, name) : disableTransition(netId, name));
		} catch (error) {
			if (selectedNetId === netId) toggleError = error instanceof Error ? error.message : String(error);
		} finally {
			togglingTransition = false;
		}
	}

	async function fetchNets() {
		try {
			// Only show nets assigned to a worker — templates (worker_id=null) can't be executed.
			availableNets = await listNets({ assigned: true });
			netsError = null;

			// Auto-select: honor a ?net=<id> deep link (e.g. from the "Open
			// Petri net view" button on the Workers page), else first net.
			if (availableNets.length > 0 && !selectedNetId) {
				const wanted = $page.url.searchParams.get('net');
				const target = wanted && availableNets.some(n => n.id === wanted)
					? wanted
					: availableNets[0].id;
				await selectNet(target);
			}
		} catch (error: any) {
			console.error('Failed to fetch nets:', error);
			netsError = error?.message ?? String(error);
		} finally {
			netsLoaded = true;
		}
	}

	function formatNetLogEntry(entry: { ts: string | null; text: string }): string {
		if (!entry.ts) return entry.text;
		try {
			return `[${new Date(entry.ts).toISOString().slice(11, 19)}] ${entry.text}`;
		} catch {
			return entry.text;
		}
	}

	async function selectNet(netId: string) {
		selectedNetId = netId;
		isRunning = false;
		dropMirror();
		netLogLines = [];
		executionStoppedReason = null;
		selectedTransitionId = null;
		logEntries = [];

		// Only connect event stream and fetch execution state if the net has a ready worker
		const net = availableNets.find(n => n.id === netId);
		const worker = net?.worker_id ? workers.find(w => w.id === net.worker_id) : null;
		if (!worker || worker.status !== 'ready') {
			disconnectWorkerEvents();
			return;
		}

		// Connect unified event stream for this net's worker. The store
		// dedupes by worker id so reselecting a net on the same worker
		// does not drop the existing connection.
		connectToWorker(worker.id);

		await resyncNet(netId);
	}

	// Replace everything this page believes about the net with what the
	// worker holds right now: graph, tokens, running flag, transition
	// history, the durable net log. Called on selection and whenever the
	// live stream may have let something slip — a reconnect, a gap marker
	// from the worker, a worker or net state change from the control plane,
	// the tab coming back into view. Before 2026-09-13 only the selection
	// fetched, and a tab that slept through more events than the worker
	// buffers showed a log hours older than the net, under "Connected".
	// Three reads, each guarded against a slow answer landing after the
	// user switched nets.
	async function resyncNet(netId: string) {
		if (liveReadError?.netId === netId) liveReadError = null;
		await Promise.all([
			refreshGraphState(netId),
			refreshHistory(netId, true),
			// Seeded from the worker's rotating file so it survives
			// subprocess and worker restarts.
			getNetLogHistory(netId)
				.then((entries) => {
					if (selectedNetId !== netId) return;
					netLogLines = capTail(entries.map(formatNetLogEntry), NET_LOG_CAP);
				})
				.catch((error) => noteLiveReadFailure(netId, error)),
		]);
	}

	// Forget the drawn net, its animation and its selection.
	function dropMirror() {
		mirror = null;
		clearPlayback();
		stepAwaitingStream = false;
		logEntries = [];
		historyFetch = null;
	}

	// The worker no longer answers for this net — an unload, or a load that
	// failed. What is drawn is a subprocess that is gone.
	function clearLiveState() {
		dropMirror();
		isRunning = false;
	}

	// Adopt a state read: always for a new generation, otherwise only if it
	// is not older than the mirror (notifications applied since the read was
	// answered must not be undone). A new generation drops every token,
	// animation and cached token view, and rereads the log, which the net
	// process starts over.
	function adoptState(state: NetState) {
		if (!shouldAdopt(mirror, state)) return;
		const previous = mirror;
		const newGeneration = !previous || previous.generation !== state.generation;
		if (newGeneration) {
			clearPlayback();
			$selectedTokenId = null;
		}
		mirror = mirrorFromState(state, DEFAULT_TOKEN_LIMIT);
		netLayout = layoutFor(mirror.topology, netLayout);
		// Server-derived: adopt the worker's actual continuous-execution
		// state rather than leaving the optimistic flag from a prior session.
		isRunning = !!state.running;
		if (!anyInFlight(mirror)) stepAwaitingStream = false;
		if (previous && newGeneration && selectedNetId) {
			// A reset: drop what belonged to the old net.
			stepError = null;
			stepNotice = null;
			executionStoppedReason = null;
			subprocessLines = [];
			logEntries = [];
			refreshHistory(selectedNetId, true);
		}
	}

	// One state read at a time per net: a request made while one is in
	// flight is folded into one more read after it, so a burst of gaps
	// costs two reads, not one per gap.
	let stateFetch: { netId: string; again: boolean; done: Promise<void> } | null = null;

	// Pull the worker's current state and rebuild the mirror from it. Used on
	// net selection, on a version gap, a `reloaded`, a stream gap, a
	// reconnect and the tab coming back into view.
	function refreshGraphState(netId: string): Promise<void> {
		if (stateFetch && stateFetch.netId === netId) {
			stateFetch.again = true;
			return stateFetch.done;
		}
		const entry = { netId, again: false, done: Promise.resolve() };
		entry.done = (async () => {
			do {
				entry.again = false;
				await readStateOnce(netId);
			} while (entry.again && selectedNetId === netId);
			if (stateFetch === entry) stateFetch = null;
		})();
		stateFetch = entry;
		return entry.done;
	}

	async function readStateOnce(netId: string) {
		try {
			const state = await getExecutionState(netId, DEFAULT_TOKEN_LIMIT);
			if (selectedNetId !== netId) return;
			adoptState(state);
		} catch (error) {
			// A net that is not loaded has no state to fetch, and says so
			// with a 409; that is quiet. Any other refusal carries the
			// server's detail, and the page shows it.
			if (!isNotLoaded(error)) console.error('Failed to fetch execution state:', error);
			noteLiveReadFailure(netId, error);
		}
	}

	// A place whose drawn dots fell short of its count (its listed tokens
	// were consumed, and what lies beyond the cap is not known here) is
	// refilled by a state read, at most every two seconds.
	let refillTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleRefill() {
		if (refillTimer) return;
		refillTimer = setTimeout(() => {
			refillTimer = null;
			if (selectedNetId) refreshGraphState(selectedNetId);
		}, 2000);
	}

	// The execution log: the whole log on a resync, then only what follows
	// the newest entry held, after each firing lands. One read at a time,
	// with one more after it if asked meanwhile.
	let historyFetch: { netId: string; again: boolean; whole: boolean } | null = null;

	async function refreshHistory(netId: string, whole: boolean) {
		if (historyFetch && historyFetch.netId === netId) {
			historyFetch.again = true;
			historyFetch.whole = historyFetch.whole || whole;
			return;
		}
		const entry = { netId, again: false, whole };
		historyFetch = entry;
		try {
			do {
				const readWhole = entry.whole;
				entry.again = false;
				entry.whole = false;
				const after = readWhole ? undefined : lastLogSeq(logEntries);
				const entries = await getExecutionHistory(netId, after ? { after } : {});
				if (selectedNetId !== netId || historyFetch !== entry) return;
				// The log answers oldest first; the panel shows newest first.
				logEntries = mergeLogEntries(readWhole ? [] : logEntries, entries, EXECUTION_LOG_CAP);
			} while (entry.again);
		} catch (error) {
			noteLiveReadFailure(netId, error);
		} finally {
			if (historyFetch === entry) historyFetch = null;
		}
	}

	// Fire one transition. The request answers once the firing has landed,
	// by which time the stream has (or is about to have) carried its
	// `launched` and `distributed`, which the animation plays. A step that
	// outlasts the control plane's bound is still running, not failed.
	// Returns the result, or 'in_progress' for that case; throws any other
	// refusal.
	async function stepOnce(netId: string): Promise<StepResult | 'in_progress'> {
		isStepping = true;
		try {
			const result = await executionStep(netId);
			if (selectedNetId === netId && result.failed && !stepError) {
				stepError = `${result.transition ?? 'The transition'} failed.`;
			}
			return result;
		} catch (error) {
			if (!isStillInProgress(error)) throw error;
			if (selectedNetId === netId) {
				stepAwaitingStream = true;
				stepNotice = 'Still running: the firing will show when its body returns.';
			}
			return 'in_progress';
		} finally {
			isStepping = false;
		}
	}

	async function handleStep() {
		if (!selectedNetId) return;
		const netId = selectedNetId;
		stepError = null;
		stepNotice = null;
		executionStoppedReason = null;
		subprocessLines = [];
		try {
			const result = await stepOnce(netId);
			if (result !== 'in_progress' && !result.fired && selectedNetId === netId) {
				stepNotice = 'Nothing is fireable.';
			}
		} catch (error) {
			console.error('Step failed:', error);
			stepError = error instanceof Error ? error.message : 'Step failed.';
		}
	}

	// Resolves once `ready()` holds, checking every 200 ms.
	function waitUntil(ready: () => boolean): Promise<void> {
		return new Promise((resolve) => {
			const check = () => (ready() ? resolve() : setTimeout(check, 200));
			check();
		});
	}

	// Pull the worker's authoritative running flag and adopt it. Returns the
	// reconciled value, or null when the fetch failed / the user switched nets
	// mid-flight — callers treat null as "leave the current value alone" so a
	// transient worker blip doesn't flip the button to a wrong state.
	async function refreshRunningState(netId: string): Promise<boolean | null> {
		try {
			const state = await getExecutionState(netId);
			if (selectedNetId !== netId) return null;
			// Only adopt an authoritative boolean. A worker that predates the
			// `running` flag omits it — treat that as "no info" and leave the
			// optimistic value untouched rather than wrongly forcing it off.
			if (typeof state?.running !== 'boolean') return null;
			isRunning = state.running;
			return isRunning;
		} catch {
			return null;
		}
	}

	async function handleActivateDeactivate() {
		if (!selectedNetId || isToggling) return;
		const netId = selectedNetId;
		// Don't optimistically flip isRunning: start/stop returns before the
		// engine loop has necessarily settled, and a dropped event stream can't
		// be relied on to correct a wrong guess. Reconcile from the worker
		// instead; the spinner covers the round-trip.
		//
		// Which way the button goes is `executionOn`, not `isRunning`: on a
		// cron net the same two requests arm and pause the schedule, and an
		// armed daily net is idle for twenty-three hours a day without being
		// paused. Reading `isRunning` there would offer to arm a net that is
		// already armed, and never offer to pause it.
		const on = executionOn;
		const scheduled = verbs.scheduled;
		isToggling = true;
		try {
			if (on) {
				await executionStop(netId);
			} else {
				executionStoppedReason = null;  // fresh run — drop any prior stop
				await executionStart(netId);
			}
			// Optimistic flip first (keeps pre-`running`-flag workers correct),
			// then let the authoritative state override it where available.
			// Only for a net whose button *is* the execution state: on a cron
			// net, arming does not claim anything is firing.
			if (!scheduled) isRunning = !on;
			await refreshRunningState(netId);
			// The schedule verbs read `desired_execution_state`, which changes
			// on the control plane rather than on the worker, so it comes from
			// a net refetch and not from the worker's execution state above.
			if (scheduled) availableNets = await listNets({ assigned: true });
		} catch (error) {
			console.error('Activate/Deactivate failed:', error);
			// Best-effort reconcile so the button still reflects reality.
			await refreshRunningState(netId);
		} finally {
			if (selectedNetId === netId) isToggling = false;
		}
	}

	async function handleRunNow() {
		if (!selectedNetId || isRunningNow) return;
		const netId = selectedNetId;
		isRunningNow = true;
		runNowError = null;
		try {
			await runNetNow(netId);
			// Nothing is refetched here: the run opens as `dispatched` before
			// the load begins, and the `net_run_started` that carries it comes
			// down the SSE connection this page already listens on — which is
			// also what updates the Runs panel and the badges.
			executionStoppedReason = null;
		} catch (error) {
			// Every refusal this route gives — the net is stopped, a load is
			// already in flight, a run is already pending, no worker, an
			// unreachable worker — arrives as prose written for a person. It
			// is shown as it came; a status code would say nothing a reader
			// could act on.
			runNowError = error instanceof Error ? error.message : 'Run now failed.';
		} finally {
			if (selectedNetId === netId) isRunningNow = false;
		}
	}

	async function handleAutoStep() {
		if (!selectedNetId) return;

		if (isAutoStepping) {
			isAutoStepping = false;
			console.log('AUTO STEP: Stopped by user');
			return;
		}

		const netId = selectedNetId;
		isAutoStepping = true;
		stepNotice = null;
		console.log('AUTO STEP: Starting...');

		// A single failed step is usually a transient backend blip (a flycast
		// drop, a worker restart) — NOT a reason to abandon a long-running
		// net. Tolerate consecutive failures with backoff and only give up
		// after several in a row, mirroring the worker health-check
		// hysteresis. A success resets the counter.
		const MAX_CONSECUTIVE_STEP_FAILURES = 5;
		let consecutiveFailures = 0;

		while (isAutoStepping && selectedNetId === netId) {
			try {
				subprocessLines = [];
				const result = await stepOnce(netId);
				consecutiveFailures = 0;
				if (result === 'in_progress') {
					// The body runs on; the next step waits for it to land.
					await waitUntil(() => !stepAwaitingStream || !isAutoStepping || selectedNetId !== netId);
					continue;
				}
				if (!result.failed) stepError = null;
				stepNotice = null;

				if (!result.fired) {
					console.log('AUTO STEP: No more transitions can fire, stopping');
					isAutoStepping = false;
					break;
				}
				if (result.failed) {
					console.log('AUTO STEP: the transition failed, stopping');
					isAutoStepping = false;
					break;
				}

				// Let the firing animation play out before the next step.
				await new Promise(resolve => setTimeout(resolve, FIRING_ANIMATION_MS + 50));
			} catch (error) {
				consecutiveFailures += 1;
				console.warn(
					`AUTO STEP: step failed (${consecutiveFailures}/${MAX_CONSECUTIVE_STEP_FAILURES}):`,
					error,
				);
				if (consecutiveFailures >= MAX_CONSECUTIVE_STEP_FAILURES) {
					console.error('AUTO STEP: too many consecutive failures, stopping');
					stepError = `Repeat Step stopped after ${MAX_CONSECUTIVE_STEP_FAILURES} consecutive failures. The backend may be degraded — press Repeat Step to resume.`;
					isAutoStepping = false;
					break;
				}
				// Transient — surface a soft notice and back off before retrying
				// (0.5s, 1s, 2s, 4s, capped at 5s), then keep stepping.
				stepError = `Step failed (retrying ${consecutiveFailures}/${MAX_CONSECUTIVE_STEP_FAILURES})…`;
				const backoffMs = Math.min(500 * 2 ** (consecutiveFailures - 1), 5000);
				await new Promise(resolve => setTimeout(resolve, backoffMs));
			}
		}

		console.log('AUTO STEP: Completed');
	}

	async function handleReset() {
		if (!selectedNetId || isResetting) return;
		isResetting = true;
		try {
			await executionReset(selectedNetId);
			// Every watcher hears `reloaded` and refetches, which brings the
			// new generation and with it a clean marking, log and animation.
			// This tab reads it now too, in case its stream is behind.
			await refreshGraphState(selectedNetId);
		} catch (error) {
			console.error('Reset failed:', error);
		} finally {
			isResetting = false;
		}
	}

	async function handleInject() {
		if (!selectedNetId || isInjecting || !injectPlaceName) return;
		injectError = null;
		injectNotice = null;
		let token: unknown;
		try {
			token = JSON.parse(injectTokenJson);
		} catch {
			injectError = 'Token must be valid JSON.';
			return;
		}
		isInjecting = true;
		try {
			const result = await executionInject(selectedNetId, injectPlaceName, token);
			// The token itself arrives on the stream as `added`, for every
			// watcher alike.
			injectNotice = `Injected token #${result.id} into ${injectPlaceName}.`;
		} catch (error) {
			injectError = error instanceof Error ? error.message : 'Inject failed.';
		} finally {
			isInjecting = false;
		}
	}

	async function handleNetSelect(event: Event) {
		const target = event.target as HTMLSelectElement;
		const netId = target.value;

		// Clear current state when switching nets
		dropMirror();
		// A refusal belongs to the net it was about.
		runNowError = null;

		if (netId) {
			await selectNet(netId);
		}
	}

	function selectedNetOperation() {
		const net = selectedNet();
		return net ? operationFor(operations, 'net', net.id, net.active_operation) : null;
	}

	function selectedNet(): Net | undefined {
		return availableNets.find(n => n.id === selectedNetId);
	}

	// What this net's on/off control is called. On a cron net Start arms the
	// schedule and Stop pauses it, so the words — and the state the pill
	// describes — are the schedule's, not the worker's.
	let verbs = $derived(executionVerbs(selectedNet() ?? null));

	// Whether execution is on. For a cron net that is the intent
	// (`desired_execution_state`); for every other net it stays what it has
	// always been, whether the worker is firing.
	let executionOn = $derived(verbs.scheduled ? verbs.armed : isRunning);

	// Contradictions between what the selected net wants and what is true.
	let selectedAnomalies = $derived.by(() => {
		const net = selectedNet();
		return net ? anomalyLabels(net) : [];
	});

	// Where each definition runs, for the "which workers" view.
	let definitionGroups = $derived(groupByDefinition(availableNets, workers));
	let multiInstanceCount = $derived(definitionGroups.filter(g => g.instances.length > 1).length);

	// Diagnose: fetched on click only, and kept with the net it was asked
	// about so switching nets never shows another net's verdict.
	let diagnosis = $state<{ netId: string; result: NetDiagnosis } | null>(null);
	let diagnoseError = $state<{ netId: string; message: string } | null>(null);
	let diagnosing = $state(false);

	async function handleDiagnose() {
		const netId = selectedNetId;
		if (!netId) return;
		diagnosing = true;
		diagnoseError = null;
		try {
			diagnosis = { netId, result: await diagnoseNet(netId) };
		} catch (e: any) {
			diagnoseError = { netId, message: e.message ?? 'Failed to diagnose net' };
		} finally {
			diagnosing = false;
		}
	}

	let shownDiagnosis = $derived(diagnosis && diagnosis.netId === selectedNetId ? diagnosis.result : null);
	let shownLiveReadError = $derived(liveReadError && liveReadError.netId === selectedNetId ? liveReadError.message : null);
	let shownDiagnoseError = $derived(diagnoseError && diagnoseError.netId === selectedNetId ? diagnoseError.message : null);

	// The expression and the slot it points at, for a cron net.
	let scheduleNote = $derived.by(() => scheduleFacts(selectedNet() ?? null));

	// A slot that is due but cannot be dispatched yet — the worker is not
	// ready, or the net is not loaded. It lives on the net's run-state row
	// rather than on a run, because a wait must cost one overwritten row and
	// not one row per minute of waiting.
	let pendingNote = $derived.by(() => {
		const net = selectedNet();
		if (!net) return null;
		// The schedule line already carries the refusal when a due slot is
		// waiting on one, next to the slot it is holding up. Saying it twice
		// on one toolbar does not say it twice as clearly.
		if (scheduleNote?.pending) return null;
		return pendingLabel(net);
	});

	// Subscribe to per-worker memory snapshots streamed over the same SSE
	// connection that workerEventsStore opens — no extra connection.
	let workerMemoryByWorker = $state<Map<string, WorkerMemorySnapshot>>(new Map());
	const unsubscribeMemory = workerMemoryStore.subscribe(m => {
		workerMemoryByWorker = m;
	});

	let selectedWorkerMemory = $derived.by(() => {
		const w = selectedNetWorker();
		return w ? workerMemoryByWorker.get(w.id) ?? null : null;
	});

	let memoryBarPercent = $derived.by(() => {
		const snap = selectedWorkerMemory;
		const w = selectedNetWorker();
		if (!snap || !w) return 0;
		const limit = snap.container_total_mb ?? w.memory_mb;
		if (!limit) return 0;
		return Math.min(100, (workerMemoryUsedMb(snap) / limit) * 100);
	});

	let memoryBarText = $derived.by(() => {
		const snap = selectedWorkerMemory;
		const w = selectedNetWorker();
		if (!snap || !w) return '';
		const limit = Math.round(snap.container_total_mb ?? w.memory_mb);
		return `${Math.round(workerMemoryUsedMb(snap))} / ${limit} MB`;
	});

	function memoryBarColor(percent: number): string {
		if (percent >= 85) return '#ef4444';
		if (percent >= 60) return '#eab308';
		return '#22c55e';
	}

	function selectedNetWorker(): Worker | undefined {
		const net = selectedNet();
		if (!net?.worker_id) return undefined;
		return workers.find(w => w.id === net.worker_id);
	}

	async function handleWorkerAssign(event: Event) {
		const target = event.target as HTMLSelectElement;
		const workerId = target.value;
		if (!selectedNetId) return;
		workerActionInProgress = true;
		try {
			if (workerId) {
				await patchNet(selectedNetId, { worker_id: workerId });
			} else {
				await patchNet(selectedNetId, { worker_id: null });
			}
			await fetchNets();
		} catch (error) {
			console.error('Worker assignment failed:', error);
		} finally {
			workerActionInProgress = false;
		}
	}

	async function handleLoadNet() {
		if (!selectedNetId) return;
		// Pre-action check: refresh and verify state
		availableNets = await listNets({ assigned: true });
		workers = await listWorkers();
		const net = selectedNet();
		const worker = selectedNetWorker();
		if (!net || net.load_state === 'loaded') return;
		if (!worker || worker.status !== 'ready') return;

		// If the net has factory params, show a dialog to collect them
		const params = getRequiredParams(net);
		if (params.length > 0) {
			paramsSchema = params;
			paramValues = {};
			for (const p of params) {
				paramValues[p.name] = p.default ?? '';
			}
			showParamsDialog = true;
			return;
		}

		await doLoadNet();
	}

	async function doLoadNet(factoryParams?: Record<string, unknown>) {
		if (!selectedNetId) return;
		workerActionInProgress = true;
		try {
			await loadNet(selectedNetId, factoryParams);
			availableNets = await listNets({ assigned: true });
		} catch (error) {
			console.error('Load failed:', error);
			availableNets = await listNets({ assigned: true });
			workers = await listWorkers();
		} finally {
			workerActionInProgress = false;
		}
	}

	function handleParamsSubmit() {
		showParamsDialog = false;
		const factoryParams: Record<string, unknown> = {};
		for (const p of paramsSchema) {
			const raw = paramValues[p.name] ?? '';
			if (p.required && raw === '') continue; // will be caught by server
			if (raw !== '' || p.required) {
				factoryParams[p.name] = coerceParamValue(raw, p);
			}
		}
		doLoadNet(factoryParams);
	}

	function handleParamsCancel() {
		showParamsDialog = false;
	}

	// -- Secrets dialog handlers --

	async function handleOpenSecrets() {
		if (!selectedNetId) return;
		if (secretsLoading) return;
		secretsLoading = true;
		secretsError = null;
		try {
			const existing = await listNetSecrets(selectedNetId);
			secretEntries = existing.map(s => ({ key: s.key, value: '', isExisting: true }));
			if (secretEntries.length === 0) {
				secretEntries = [{ key: '', value: '', isExisting: false }];
			}
			showSecretsDialog = true;
		} catch (e: any) {
			console.error('Failed to load secrets:', e);
		} finally {
			secretsLoading = false;
		}
	}

	function addSecretRow() {
		secretEntries = [...secretEntries, { key: '', value: '', isExisting: false }];
	}

	function removeSecretRow(index: number) {
		secretEntries = secretEntries.filter((_, i) => i !== index);
	}

	async function handleSecretsSave() {
		if (!selectedNetId) return;
		secretsSaving = true;
		secretsError = null;
		try {
			const toSave = secretEntries
				.filter(e => e.key.trim() !== '')
				.map(e => ({
					key: e.key.trim(),
					value: e.isExisting && e.value === '' ? null : e.value,
				}));

			await setNetSecrets(selectedNetId, toSave);
			showSecretsDialog = false;
		} catch (e: any) {
			secretsError = e.message ?? 'Failed to save secrets';
		} finally {
			secretsSaving = false;
		}
	}

	function handleSecretsCancel() {
		showSecretsDialog = false;
	}

	// -- Settings dialog handlers --

	function handleOpenSettings() {
		if (!selectedNetId) return;
		const net = selectedNet();
		settingsTimeoutInput = net?.step_wall_clock_timeout_seconds == null
			? ''
			: String(net.step_wall_clock_timeout_seconds);
		settingsStallInput = net?.stall_after_seconds == null ? '' : String(net.stall_after_seconds);
		settingsError = null;
		showSettingsDialog = true;
	}

	async function handleSettingsSave() {
		if (!selectedNetId) return;
		const timeout = parseOptionalSeconds(settingsTimeoutInput);
		if (!timeout.ok) {
			settingsError = 'Timeout must be a positive whole number of seconds, or empty for unbounded.';
			return;
		}
		const stall = parseOptionalSeconds(settingsStallInput);
		if (!stall.ok) {
			settingsError = 'Stall threshold must be a positive whole number of seconds, or empty for no verdict.';
			return;
		}
		settingsSaving = true;
		settingsError = null;
		try {
			const updated = await patchNet(selectedNetId, {
				step_wall_clock_timeout_seconds: timeout.value,
				stall_after_seconds: stall.value,
			});
			availableNets = availableNets.map(n => n.id === updated.id ? updated : n);
			showSettingsDialog = false;
		} catch (e: any) {
			settingsError = e.message ?? 'Failed to save settings';
		} finally {
			settingsSaving = false;
		}
	}

	function handleSettingsCancel() {
		showSettingsDialog = false;
	}

	async function handleUnloadNet() {
		if (!selectedNetId) return;
		// Pre-action check: refresh and verify state
		availableNets = await listNets({ assigned: true });
		workers = await listWorkers();
		const net = selectedNet();
		const worker = selectedNetWorker();
		if (!net || net.load_state !== 'loaded') return;
		if (!worker || worker.status !== 'ready') return;
		workerActionInProgress = true;
		try {
			await unloadNet(selectedNetId);
			availableNets = await listNets({ assigned: true });
		} catch (error) {
			console.error('Unload failed:', error);
			availableNets = await listNets({ assigned: true });
			workers = await listWorkers();
		} finally {
			workerActionInProgress = false;
		}
	}

	// Periodic reconcile of isRunning against the worker. Makes the button
	// self-heal even when the event stream drops the execution_stopped that
	// would otherwise clear it (the wedged-"Deactivate" bug), and forces it
	// off for a net that isn't loaded — an unloaded net can't be running.
	let runningPollTimer: ReturnType<typeof setInterval> | null = null;
	const RUNNING_POLL_MS = 5000;
	// A believed-stopped net is checked too, more slowly: the resume sweep
	// and the schedule start nets without this page's help, and until
	// 2026-09-13 the button offered to Activate a net that was firing.
	const STOPPED_RECONCILE_EVERY = 6;  // every 30s
	let runningPollTick = 0;

	function reconcileRunningPoll() {
		const netId = selectedNetId;
		runningPollTick += 1;
		if (!netId || isToggling) return;
		// A believed-running net is checked every tick — that's the wedged
		// "Deactivate" case. A believed-stopped one every sixth.
		if (!isRunning && runningPollTick % STOPPED_RECONCILE_EVERY !== 0) return;
		const net = availableNets.find(n => n.id === netId);
		if (!net || net.load_state !== 'loaded') {
			isRunning = false;  // an unloaded/errored net cannot be running
			return;
		}
		const worker = net.worker_id ? workers.find(w => w.id === net.worker_id) : null;
		if (!worker || worker.status !== 'ready') return;  // can't observe; retry later
		refreshRunningState(netId);
	}

	// -- SSE listener: refresh nets/workers on state change events (debounced) --
	let sseDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	const unsubscribeSSE = serverEventsStore.subscribe((event) => {
		if (!event) return;
		if (isOperationEvent(event)) {
			operations = applyOperationEvent(operations, event);
			// Progress is a step and a heartbeat, not a change of state; the
			// start and the finish fall through to the refetch below.
			if (event.type === 'operation_progress') return;
		}
		// A run event carries the whole transition, so the net's summary is
		// updated from the event itself — the Runs panel header and the
		// pending note follow immediately rather than after the debounce.
		if (isRunEvent(event)) {
			availableNets = availableNets.map(n => applyRunEvent(n, event));
		}
		// What the event means for the net on screen, beyond the lists: the
		// graph, the log and the Activate button all read the worker, and
		// the worker's stream cannot say that the worker came back, that the
		// net got a fresh subprocess, or that the schedule started it.
		switch (liveAction(event, selectedNet())) {
			case 'reconnect':
				if (selectedNetId && event.type === 'worker_state_changed') {
					connectToWorker(event.worker_id);
					resyncNet(selectedNetId);
				}
				break;
			case 'resync':
				if (selectedNetId) resyncNet(selectedNetId);
				break;
			case 'clear':
				clearLiveState();
				break;
			case 'running':
				if (selectedNetId) refreshRunningState(selectedNetId);
				break;
		}
		// Pure log events carry no state — skip the REST refetch. Only
		// state-change events warrant pulling fresh net/worker lists.
		//
		// The run lifecycle events (net_run_started / _finished / _skipped)
		// deliberately fall through to the same debounced refetch, which stays
		// authoritative over the optimistic update above. The Runs panel
		// refreshes its own page from the same store.
		if (event.type === 'worker_provision_log' || event.type === 'net_load_log') return;
		if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
		sseDebounceTimer = setTimeout(() => {
			sseDebounceTimer = null;
			listNets({ assigned: true }).then(n => availableNets = n).catch(() => {});
			listWorkers().then(w => workers = w).catch(() => {});
		}, 2000);
	});

	async function handleLogout() {
		unsubscribeSSE();
		await logout();
		goto('/login');
	}

	// What the page does with each kind on the worker stream (protocol §7,
	// and the host's own kinds, §9). State notifications go through the
	// mirror's version rule; a gap or a `reloaded` refetches; what the
	// mirror applied is animated.
	function handleNetEvent(event: NetEvent, ts: string) {
		const netId = selectedNetId;
		if (!netId) return;
		switch (event.kind) {
			case 'subprocess_output':
				subprocessLines = [...subprocessLines, event.data.text];
				// Also accumulate into the durable, net-wide panel (not cleared
				// per step). ts comes from the event so it matches file replay.
				netLogLines = capTail([...netLogLines, formatNetLogEntry({ ts, text: event.data.text })], NET_LOG_CAP);
				return;
			case 'memory_stats':
			case 'log':
			case 'stream_gap':
			case 'heartbeat':
			case 'idle':
			case 'load_progress':
				return;
		}

		// Every protocol notification says whether the net is running.
		if (typeof event.data?.running === 'boolean' && !isToggling) isRunning = event.data.running;

		if (event.kind === 'execution_stopped') {
			isRunning = false;
			// Loud, legible stop: show error stops only. A normal end-of-run
			// (nothing fireable) is not an error, so don't alarm on it.
			const reason = event.data.reason;
			if (reason && reason !== 'no_fireable_transitions') {
				executionStoppedReason = event.data.error_type
					? `${event.data.error_type}: ${event.data.message ?? ''}`.trim()
					: event.data.message
						? `${reason}: ${event.data.message}`
						: String(reason);
			}
		}

		if (!mirror) {
			// Nothing to apply to: a read is under way or due.
			if (event.kind === 'reloaded') refreshGraphState(netId);
			return;
		}
		const applied = applyEvent(mirror, event);
		switch (applied.outcome) {
			case 'applied': {
				mirror = applied.mirror;
				play(applied.change);
				const layoutShort = applied.short.some((name) => {
					const place = applied.mirror.places[name];
					return place.tokens.length < Math.min(place.count, TOKEN_DOT_MAX);
				});
				if (layoutShort) scheduleRefill();
				landed(netId, applied.change);
				break;
			}
			case 'gap':
				console.info(`[nets page] marking version gap: held ${applied.expected - 1}, got ${applied.got}; refetching`);
				refreshGraphState(netId);
				break;
			case 'refetch':
				console.info(`[nets page] refetching the state: ${applied.reason}`);
				refreshGraphState(netId);
				break;
			case 'stale':
			case 'ignored':
				break;
		}
	}

	// The page's own bookkeeping once a change is in the mirror: a firing
	// that landed ends a step still awaited and adds to the log.
	function landed(netId: string, change: Change) {
		if (change.kind === 'distributed' || change.kind === 'fired' || change.kind === 'failed') {
			if (stepAwaitingStream && !anyInFlight(mirror)) {
				stepAwaitingStream = false;
				stepNotice = null;
			}
			refreshHistory(netId, false);
		}
		if (change.kind === 'distributed' || change.kind === 'fired') stepError = null;
		if (change.kind === 'failed') stepError = `${change.transition} failed: ${change.error}`;
	}

	onDestroy(() => {
		unsubscribeSSE();
		unsubscribeMemory();
		if (sseDebounceTimer) {
			clearTimeout(sseDebounceTimer);
			sseDebounceTimer = null;
		}
		if (runningPollTimer) {
			clearInterval(runningPollTimer);
			runningPollTimer = null;
		}
		if (refillTimer) {
			clearTimeout(refillTimer);
			refillTimer = null;
		}
		clearPlayback();
	});

	onMount(() => {
		// Load saved panel layout
		loadPanelLayout();

		// Self-healing reconcile of the Activate/Deactivate state.
		runningPollTimer = setInterval(reconcileRunningPoll, RUNNING_POLL_MS);

		// The stream's own account of itself drives the header badge, and a
		// higher generation means "what you have heard may be stale". A lower
		// one is the store starting over for a new worker; nothing to refetch.
		let seenGeneration = -1;
		const unsubscribeStream = workerStreamStore.subscribe((s) => {
			connectionStatus = statusLabel(s);
			if (s.generation > seenGeneration) {
				seenGeneration = s.generation;
				if (selectedNetId) resyncNet(selectedNetId);
			} else if (s.generation < seenGeneration) {
				seenGeneration = s.generation;
			}
		});

		// A tab coming back into view has usually been throttled or asleep.
		// The browser reopens the stream on its own; the refetch is ours to
		// do, and a stream abandoned as unavailable needs reopening.
		const onVisible = () => {
			if (document.visibilityState !== 'visible' || !selectedNetId) return;
			const worker = selectedNetWorker();
			if (worker?.status !== 'ready') return;
			connectToWorker(worker.id);
			resyncNet(selectedNetId);
		};
		document.addEventListener('visibilitychange', onVisible);

		// Load workers first — selectNet() (called from fetchNets) needs workers
		// to determine if a net has a ready worker and read its state.
		(async () => {
			await listWorkers().then(w => workers = w).catch(() => {});
			// Now fetch nets (which may auto-select and read the net state)
			await fetchNets();
		})();

		const unsubscribe = workerEventsStore.subscribe((event) => {
			if (!event) return;

			// Only net-scoped events drive this view. Filter to the selected net.
			if (event.scope !== 'net' || event.net_id !== selectedNetId) return;
			if (event.kind === 'worker_unavailable') return;
			handleNetEvent(event, event.ts);
		});

		return () => {
			unsubscribe();
			unsubscribeStream();
			document.removeEventListener('visibilitychange', onVisible);
			disconnectWorkerEvents();
		};
	});

	// Button class helpers
	const btnBase = 'px-5 py-2 rounded text-sm font-medium cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed';
	const btnDefault = `${btnBase} border border-accent bg-card text-accent hover:bg-accent hover:text-accent-foreground disabled:border-border disabled:text-foreground-faint`;
	const btnDanger = `${btnBase} border border-destructive bg-card text-destructive hover:bg-destructive-hover hover:text-white`;
	const btnSmall = 'px-2.5 py-1.5 border border-accent rounded bg-card text-accent text-sm font-medium cursor-pointer transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed';
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={handleMouseUp} />

<div class="flex flex-col h-screen bg-surface">
	<AppNav title="Nets" {userEmail} onLogout={handleLogout} />

	{#if mirror}
		<!-- Secondary toolbar: net controls + execution buttons -->
		<div class="flex items-center gap-6 px-6 py-3 bg-card border-b border-border flex-wrap">
			<span class="px-3 py-1.5 rounded text-xs {connectionStatus === 'Connected' ? 'bg-status-success-bg text-status-success' : 'bg-status-warning-bg text-status-warning'}">
				{connectionStatus}
			</span>
			{#if mirror.runtime}
				<!-- Which runtime runs this net: the protocol is the same for both. -->
				<span class="px-2 py-0.5 rounded-full text-xs font-mono bg-muted text-foreground-muted" data-runtime={mirror.runtime} title="The runtime this net runs on">{mirror.runtime}</span>
			{/if}

			{#if availableNets.length > 0}
				<div class="flex items-center gap-2">
					<label for="net-select" class="text-sm font-medium text-foreground">Net:</label>
					<select id="net-select" bind:value={selectedNetId} onchange={handleNetSelect}
						class="px-4 py-2 border border-border rounded bg-card text-foreground text-sm cursor-pointer hover:border-accent">
						{#each availableNets as net}
							<option value={net.id}>{netFullLabel(net, availableNets)}{provenanceSuffix(net)}{anomalySuffix(net)}</option>
						{/each}
					</select>
				</div>

				{#if selectedNetId}
					<div class="flex items-center gap-2">
						<label for="worker-select" class="text-sm font-medium text-foreground">Worker:</label>
						<select id="worker-select" value={selectedNet()?.worker_id ?? ''} onchange={handleWorkerAssign} disabled={workerActionInProgress}
							class="px-4 py-2 border border-border rounded bg-card text-foreground text-sm cursor-pointer hover:border-accent">
							<option value="">No worker</option>
							{#each workers as w}
								<option value={w.id}>{w.name} ({w.worker_type === 'fly_machine' ? 'Fly' : 'Sprite'} - {w.status})</option>
							{/each}
						</select>
						{#if selectedNet()?.worker_id && selectedNetWorker()?.status === 'ready'}
							{#if selectedNet()?.load_state !== 'loaded'}
								<button class={btnSmall} onclick={handleLoadNet} disabled={workerActionInProgress}>Load</button>
							{:else}
								<button class={btnSmall} onclick={handleUnloadNet} disabled={workerActionInProgress}>Unload</button>
							{/if}
							<span class="text-xs px-2 py-0.5 rounded-full text-white font-medium"
								style="background: {selectedNet()?.load_state === 'loaded' ? 'var(--status-ready)' : selectedNet()?.load_state === 'error' ? 'var(--status-error)' : selectedNet()?.load_state === 'loading' ? 'var(--status-provisioning)' : 'var(--status-stopped)'}">
								{selectedNet()?.load_state === 'loaded' ? 'Loaded' : selectedNet()?.load_state === 'error' ? 'Error' : selectedNet()?.load_state === 'loading' ? 'Loading' : 'Unloaded'}
							</span>
						{/if}
						<!-- Nets stay pinned to their deployment: newer code means a
						     new instance, so the marker says it exists and no more. -->
						<ProvenanceChip
							deployment={selectedNet()?.deployment}
							newer={selectedNet()?.newer_deployment}
						/>
						{#if selectedNetOperation()}
							<OperationStatus operation={selectedNetOperation()!} compact />
						{/if}
						{#if pendingNote}
							<span class="text-xs text-status-warning" title={pendingNote.title}>{pendingNote.text}</span>
						{/if}
						{#if selectedNetId}
							<button
								class={btnSmall}
								onclick={handleOpenSecrets}
								disabled={secretsLoading}
								title={secretsLoading ? 'Loading secrets…' : 'Manage environment secrets for this net'}
							>{secretsLoading ? 'Loading…' : 'Secrets'}</button>
							<button class={btnSmall} onclick={handleOpenSettings} title="Per-net settings (timeouts, etc.)">Settings</button>
						{/if}
					</div>
				{/if}

				<div class="flex items-center gap-2">
					<!-- Armed / Paused on a cron net, Active / Idle on every other
					     one. The two browser-driven states in between are the
					     same either way. -->
					<span class="px-4 py-2 rounded text-sm font-medium {isToggling ? 'bg-status-warning-bg text-status-warning' : executionOn ? 'bg-status-info-bg text-status-info' : isAutoStepping ? 'bg-status-warning-bg text-status-warning' : stepBusy ? 'bg-status-warning-bg text-status-warning' : 'bg-muted text-foreground-muted'}">
						{isToggling ? 'Working…' : executionOn ? verbs.onLabel : isAutoStepping ? 'Repeating' : stepBusy ? 'Stepping...' : verbs.offLabel}
					</span>
				</div>

				{#if selectedWorkerMemory}
					<div
						class="flex items-center gap-2 min-w-[180px]"
						title="Worker memory: parent {Math.round(selectedWorkerMemory.parent_rss_mb ?? 0)} MB + nets {Math.round(selectedWorkerMemory.nets.reduce((s, n) => s + n.rss_mb, 0))} MB + notebooks {Math.round((selectedWorkerMemory.notebooks ?? []).reduce((s, n) => s + n.rss_mb, 0))} MB"
					>
						<span class="text-xs text-foreground-muted">Mem</span>
						<div class="flex-1 h-2 bg-muted rounded overflow-hidden min-w-[80px]">
							<div
								class="h-full transition-all"
								style="width: {memoryBarPercent}%; background: {memoryBarColor(memoryBarPercent)}"
							></div>
						</div>
						<span class="text-xs text-foreground-muted whitespace-nowrap">{memoryBarText}</span>
					</div>
				{/if}

				<div class="flex items-center gap-2">
					<button class={btnDefault} onclick={handleStep} disabled={isRunning || isAutoStepping || stepBusy || isResetting || isToggling || !selectedNetId} title="Fire a single transition manually.">{#if stepBusy && !isAutoStepping}<span class="inline-flex items-center gap-2"><span class="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>Stepping…</span>{:else}Step{/if}</button>
					<button class={isAutoStepping ? btnDanger : btnDefault} onclick={handleAutoStep} disabled={isRunning || isResetting || isToggling || !selectedNetId}
						title={isAutoStepping ? "Stop repeating steps." : `Repeatedly fires one transition at a time (with animation), like clicking Step over and over. Driven by this browser tab — closing or disconnecting it stops the run. To run the net independently of the browser, use ${verbs.activate}.`}
					>{isAutoStepping ? 'Stop' : 'Repeat Step'}</button>
					<button class={executionOn ? btnDanger : btnDefault} onclick={handleActivateDeactivate} disabled={isAutoStepping || isResetting || isToggling || !selectedNetId}
						title={executionOn ? verbs.deactivateTitle : verbs.activateTitle}
					>{#if isToggling}<span class="inline-flex items-center gap-2"><span class="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>{executionOn ? verbs.deactivating : verbs.activating}</span>{:else}{executionOn ? verbs.deactivate : verbs.activate}{/if}</button>
					<!-- Every net, not only the scheduled ones: this is the one
					     verb that reruns a one-shot net that has drained, and the
					     only one that works on a wedged subprocess. -->
					<button class={btnDefault} onclick={handleRunNow}
						disabled={isRunningNow || selectedNet()?.load_state === 'loading' || !selectedNetId}
						title="Run this net once now: unload, load, and the start that follows. Recorded as a manual run."
					>{isRunningNow ? 'Dispatching…' : 'Run now'}</button>
					{#if runNowError}
						<!-- The server's own words. It refuses for reasons a reader
						     can act on — the net is stopped, a load is in flight —
						     so the refusal is shown, never a status code. -->
						<span class="text-xs text-destructive max-w-[22rem]">{runNowError}</span>
					{/if}
					<button class={btnDefault} onclick={handleReset} disabled={isRunning || isAutoStepping || isResetting || isToggling || !selectedNetId} title="Reset the Petri net to its initial state.">{isResetting ? 'Resetting…' : 'Reset'}</button>
					<button class={showInject ? btnDanger : btnDefault} onclick={() => (showInject = !showInject)} disabled={!selectedNetId}
						title="Inject a typed token into a place — e.g. synthetic traffic to drive an end-to-end alert test.">{showInject ? 'Close Inject' : 'Inject…'}</button>
				</div>
			{/if}
		</div>
	{/if}

	<!-- What the schedule is doing. Outside the graph gate on purpose: a cron
	     net that is paused or waiting to be loaded has no graph on screen, and
	     that is exactly when "when does this run" is asked. -->
	{#if scheduleNote}
		<div class="flex items-center gap-2 px-6 py-2 bg-card border-b border-border text-xs flex-wrap">
			<span class="text-foreground-faint">Schedule</span>
			{#if scheduleNote.expression}
				<code class="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono">{scheduleNote.expression}</code>
			{/if}
			<span
				class={scheduleNote.kind === 'due' ? 'text-status-warning' : 'text-foreground-muted'}
				title={scheduleNote.title}
			>{scheduleNote.when}</span>
			{#if scheduleNote.pending}
				<!-- Why the owed slot has not gone yet, beside the slot itself. -->
				<span class="text-status-warning" title={scheduleNote.pending.title}>· {scheduleNote.pending.text}</span>
			{/if}
			{#if scheduleNote.error}
				<span class="text-error">· {scheduleNote.error}</span>
			{/if}
		</div>
	{/if}

	<!-- What the selected net wants and cannot have, and where each
	     definition runs. Outside the graph gate for the same reason as the
	     schedule: these matter most when there is no graph to look at. -->
	{#if selectedNetId || definitionGroups.length > 0}
		<div class="flex items-start gap-3 px-6 py-2 bg-card border-b border-border text-xs flex-wrap">
			{#if selectedNetId}
				<button class={btnSmall + ' text-xs'} onclick={handleDiagnose} disabled={diagnosing}
					title="Ask the control plane what state this net is in, why, and what to do about it."
				>{diagnosing ? 'Diagnosing…' : 'Diagnose'}</button>
			{/if}
			{#if selectedAnomalies.length > 0}
				<div class="flex items-center gap-2 flex-wrap">
					<span class="text-foreground-faint">Needs attention</span>
					{#each selectedAnomalies as label (label)}
						<span class="px-2 py-0.5 rounded-sm bg-status-warning-bg text-status-warning">{label}</span>
					{/each}
				</div>
			{/if}
			{#if definitionGroups.length > 0}
				<details class="min-w-0">
					<summary class="cursor-pointer text-foreground-muted">
						Where definitions run: {definitionGroups.length} definition{definitionGroups.length === 1 ? '' : 's'}{multiInstanceCount > 0 ? `, ${multiInstanceCount} with several instances` : ''}
					</summary>
					<div class="mt-2 flex flex-col gap-1">
						{#each definitionGroups as group (group.definition_name)}
							<details open={group.instances.length > 1}>
								<summary class="cursor-pointer text-foreground">
									<code class="font-mono">{group.definition_name}</code>
									<span class="text-foreground-faint">· {group.instances.length} instance{group.instances.length === 1 ? '' : 's'}</span>
								</summary>
								<ul class="ml-4 mt-1 flex flex-col gap-0.5">
									{#each group.instances as inst (inst.id)}
										<li class="text-foreground-muted">
											<span class="text-foreground">{inst.instance_name}</span>
											· {inst.worker} · {inst.load_state}
										</li>
									{/each}
								</ul>
							</details>
						{/each}
					</div>
				</details>
			{/if}
			{#if shownLiveReadError}
				<span class="basis-full text-error" title="The worker's view of this net could not be read">{shownLiveReadError}</span>
			{/if}
			{#if shownDiagnoseError}
				<span class="basis-full text-error">{shownDiagnoseError}</span>
			{/if}
			{#if shownDiagnosis}
				{@const checked = formatStamp(shownDiagnosis.checked_at)}
				{@const activity = diagnoseActivityLine(shownDiagnosis.facts)}
				<div class="basis-full flex flex-col gap-1">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="px-2 py-0.5 rounded-sm font-medium {diagnoseClasses(shownDiagnosis.state)}">{diagnoseStateLabel(shownDiagnosis.state)}</span>
						<span class="text-foreground">{shownDiagnosis.reason}</span>
						{#if checked}
							<span class="text-foreground-faint" title={checked.title}>checked {checked.text}</span>
						{/if}
					</div>
					{#if activity}
						<p class="text-foreground-muted">{activity}</p>
					{/if}
					{#if shownDiagnosis.action}
						<p class="text-foreground-muted">Next: {shownDiagnosis.action}</p>
					{/if}
					<details>
						<summary class="cursor-pointer text-foreground-faint">Facts</summary>
						<pre class="mt-1 p-2 rounded bg-muted text-foreground font-mono whitespace-pre-wrap break-all max-h-64 overflow-auto">{JSON.stringify(shownDiagnosis.facts, null, 2)}</pre>
					</details>
				</div>
			{/if}
		</div>
	{/if}

	{#if showInject && selectedNetId}
		<div class="flex flex-col gap-2 px-4 py-3 bg-card border-y border-border">
			<div class="flex items-end gap-3 flex-wrap">
				<label class="flex flex-col gap-1 text-xs text-foreground-muted">
					Place
					<select bind:value={injectPlaceName}
						class="px-3 py-1.5 border border-border rounded bg-background text-foreground text-sm min-w-[180px]">
						<option value="" disabled>Select a place…</option>
						<!-- Only places whose tokens have a JSON form can take one. -->
						{#each injectablePlaces as place (place.name)}
							<option value={place.name}>{place.name}{place.type_name ? ` · ${place.type_name}` : ''}</option>
						{/each}
					</select>
				</label>
				<label class="flex flex-col gap-1 text-xs text-foreground-muted flex-1 min-w-[240px]">
					Token (JSON)
					<input bind:value={injectTokenJson} spellcheck="false"
						placeholder={'{"deviation": 1.2}'}
						class="px-3 py-1.5 border border-border rounded bg-background text-foreground text-sm font-mono" />
				</label>
				<button class={btnDefault} onclick={handleInject}
					disabled={isInjecting || !injectPlaceName || !selectedNetId}>{isInjecting ? 'Injecting…' : 'Inject'}</button>
			</div>
			<p class="text-xs text-foreground-faint">
				The net decodes the token into the place's type, strictly: a number
				spelt as a string is refused. Only places whose tokens have a JSON form
				are offered. For the
				anomaly monitor, inject <span class="font-mono">{'{"deviation": 1.2}'}</span>
				into <span class="font-mono">SyntheticRequests</span>, then Activate to run the
				chain through to the alert.
			</p>
			{#if injectError}
				<p class="text-xs text-destructive">{injectError}</p>
			{/if}
			{#if injectNotice}
				<p class="text-xs text-status-info">{injectNotice}</p>
			{/if}
		</div>
	{/if}

	{#if executionStoppedReason}
		<div class="flex items-start gap-2 px-4 py-2 bg-destructive/10 border-y border-destructive/40 text-destructive text-sm">
			<span class="font-medium shrink-0">Execution stopped:</span>
			<span class="flex-1 break-words font-mono text-xs leading-relaxed">{executionStoppedReason}</span>
			<span class="text-foreground-faint text-xs shrink-0">See Net Logs for the full traceback.</span>
			<button
				type="button"
				class="text-destructive/70 hover:text-destructive text-xs cursor-pointer bg-transparent border-0 shrink-0"
				onclick={() => (executionStoppedReason = null)}
			>✕</button>
		</div>
	{/if}

	{#if mirror}
		<main class="flex flex-1 overflow-hidden {isDraggingSidebar || isDraggingRightSidebar || isDraggingPanelDivider ? 'cursor-col-resize select-none' : ''}">
			<!-- Left sidebar -->
			{#if !sidebarCollapsed}
				<aside class="flex shrink-0 bg-card border-r border-border" style="width: {sidebarWidth}px;">
					<div class="sidebar-content flex-1 flex flex-col overflow-hidden">
						<!-- Execution Log Panel -->
						<div
							class="flex flex-col bg-card overflow-hidden {execLogCollapsed ? 'flex-none' : ''}"
							style={!execLogCollapsed && !tokenInspectorCollapsed
								? `height: ${execLogRatio * 100}%`
								: !execLogCollapsed
									? 'flex: 1'
									: ''}
						>
							<button class="flex items-center gap-2 px-3 py-2 bg-muted border-0 border-b border-border cursor-pointer text-left text-sm font-medium text-foreground w-full transition-colors hover:bg-hover" onclick={toggleExecLog}>
								<span class="text-[0.7rem] text-foreground-muted">{execLogCollapsed ? '▶' : '▼'}</span>
								<span class="flex-1">Execution Log</span>
								<span class="bg-hover text-foreground-muted px-1.5 py-0.5 rounded-full text-xs">{logEntries.length}</span>
							</button>
							{#if !execLogCollapsed}
								<div class="flex-1 overflow-hidden flex flex-col">
									<svelte:boundary onerror={(error) => panelFailed('execution log', error)}>
										<ExecutionLog entries={logEntries} isStepping={stepBusy} {stepNotice} {stepError} {subprocessLines} />
										{#snippet failed(error, reset)}
											<PanelFailed name="execution log" {error} onReset={reset} />
										{/snippet}
									</svelte:boundary>
								</div>
							{/if}
						</div>

						<!-- Resize handle between panels -->
						{#if !execLogCollapsed && !tokenInspectorCollapsed}
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<div
								class="h-1.5 bg-muted cursor-row-resize shrink-0 transition-colors hover:bg-accent"
								onmousedown={handlePanelDividerDragStart}
								role="separator"
								aria-orientation="horizontal"
							></div>
						{/if}

						<!-- Token Inspector Panel -->
						<div
							class="flex flex-col bg-card overflow-hidden {tokenInspectorCollapsed ? 'flex-none' : ''}"
							style={!tokenInspectorCollapsed && !execLogCollapsed
								? `height: ${(1 - execLogRatio) * 100}%`
								: !tokenInspectorCollapsed
									? 'flex: 1'
									: ''}
						>
							<button class="flex items-center gap-2 px-3 py-2 bg-muted border-0 border-b border-border cursor-pointer text-left text-sm font-medium text-foreground w-full transition-colors hover:bg-hover" onclick={toggleTokenInspector}>
								<span class="text-[0.7rem] text-foreground-muted">{tokenInspectorCollapsed ? '▶' : '▼'}</span>
								<span class="flex-1">All Tokens</span>
								<span class="bg-hover text-foreground-muted px-1.5 py-0.5 rounded-full text-xs">{totalTokenCount}</span>
							</button>
							{#if !tokenInspectorCollapsed}
								<div class="flex-1 overflow-hidden flex flex-col">
									<TokenInspector
										netId={selectedNetId}
										generation={mirror.generation}
										places={mirrorPlaces}
										selectedTokenId={$selectedTokenId}
										onTokenSelect={handleTokenSelect}
									/>
								</div>
							{/if}
						</div>

						<!-- Durable net log panel — seeded from the worker's
						     rotating file, so output survives subprocess/worker
						     restarts (unlike the per-step Execution Log view). -->
						<div class="flex-none p-2 border-t border-border">
							<LogViewer
								lines={netLogLines}
								expanded={netLogExpanded}
								title="Net Logs"
								fullPageUrl={selectedNetWorker() ? `/workers/${selectedNetWorker()!.id}/logs` : undefined}
								onToggle={() => (netLogExpanded = !netLogExpanded)}
								onClear={() => (netLogLines = [])}
							/>
						</div>
					</div>

					<!-- Resize handle for sidebar width -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<div
						class="w-1.5 bg-muted cursor-col-resize transition-colors hover:bg-accent"
						onmousedown={handleSidebarDragStart}
						role="separator"
						aria-orientation="vertical"
					></div>
				</aside>
			{:else}
				<!-- Collapsed sidebar tabs -->
				<aside class="flex flex-col bg-card border-r border-border p-2 gap-2">
					<button class="flex flex-col items-center p-2 border border-border rounded bg-muted cursor-pointer transition-all hover:bg-hover hover:border-accent" onclick={toggleExecLog} title="Execution Log">
						<span class="text-xl">📋</span>
						<span class="text-[0.7rem] text-foreground-muted">{logEntries.length}</span>
					</button>
					<button class="flex flex-col items-center p-2 border border-border rounded bg-muted cursor-pointer transition-all hover:bg-hover hover:border-accent" onclick={toggleTokenInspector} title="All Tokens">
						<span class="text-xl">🔘</span>
						<span class="text-[0.7rem] text-foreground-muted">{totalTokenCount}</span>
					</button>
				</aside>
			{/if}

			<!-- Graph Panel -->
			<div class="flex-1 p-4 overflow-hidden flex">
				<svelte:boundary onerror={(error) => panelFailed('graph', error)}>
					<GraphPanel
						graph={drawnNet}
						layout={netLayout?.layout ?? null}
						tokens={drawnTokens}
						hiddenTokenIds={hiddenIds}
						travelling={travellingCues}
						activeEdges={activeEdgeEnds}
						{firingTransitions}
						{failingTransitions}
						selectedTokenId={$selectedTokenId}
						onTokenSelect={handleTokenSelect}
						{selectedTransitionId}
						onTransitionSelect={handleTransitionSelect}
					/>
					{#snippet failed(error, reset)}
						<PanelFailed name="graph" {error} onReset={reset} />
					{/snippet}
				</svelte:boundary>
			</div>

			<!-- Right sidebar: Transition Inspector -->
			{#if !rightSidebarCollapsed}
				<aside class="flex shrink-0 bg-card border-l border-border" style="width: {rightSidebarWidth}px;">
					<!-- Resize handle for right sidebar width -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<div
						class="w-1.5 bg-muted cursor-col-resize transition-colors hover:bg-accent"
						onmousedown={handleRightSidebarDragStart}
						role="separator"
						aria-orientation="vertical"
					></div>

					<div class="flex-1 flex flex-col overflow-hidden">
						<button class="flex items-center gap-2 px-3 py-2 bg-muted border-0 border-b border-border cursor-pointer text-left text-sm font-medium text-foreground w-full transition-colors hover:bg-hover" onclick={toggleRightSidebar}>
							<span class="text-[0.7rem] text-foreground-muted">▼</span>
							<span class="flex-1">Transition</span>
						</button>
						<div class="flex-1 overflow-hidden flex flex-col">
							<TransitionInspector
								transition={selectedTransition}
								state={selectedTransitionState}
								topology={mirror.topology}
								onEnable={(name) => handleToggleTransition(name, true)}
								onDisable={(name) => handleToggleTransition(name, false)}
								toggling={togglingTransition}
								{toggleError}
							/>
						</div>
					</div>
				</aside>
			{:else}
				<!-- Collapsed right sidebar tab -->
				<aside class="flex flex-col bg-card border-l border-border p-2 gap-2">
					<button class="flex flex-col items-center p-2 border border-border rounded bg-muted cursor-pointer transition-all hover:bg-hover hover:border-accent" onclick={toggleRightSidebar} title="Transition Inspector">
						<span class="text-sm font-medium text-foreground-muted">fn</span>
					</button>
				</aside>
			{/if}
		</main>
	{:else}
		<div class="flex-1 flex flex-col items-center justify-center p-8">
			<DataLoadState
				loading={!netsLoaded}
				error={netsError}
				isEmpty={availableNets.length === 0}
				loadingMessage="Loading nets…"
			>
				{#snippet empty()}
					<div class="text-center">
						<h2 class="text-lg font-semibold text-foreground mb-2">No nets found</h2>
						<p class="text-sm text-foreground-muted">Deploy your code to create nets. <a href="/deployments" class="text-accent hover:underline">Go to Deployments</a></p>
					</div>
				{/snippet}
				<div class="text-center">
					<h2 class="text-lg font-semibold text-foreground mb-2">Select a net</h2>
					<p class="text-sm text-foreground-muted mb-4">Choose a net and ensure its worker is ready to view the graph.</p>
					<div class="flex items-center justify-center gap-2">
						<select bind:value={selectedNetId} onchange={handleNetSelect}
							class="px-4 py-2 border border-border rounded bg-card text-foreground text-sm cursor-pointer hover:border-accent">
							{#each availableNets as net}
								<option value={net.id}>{netFullLabel(net, availableNets)}{provenanceSuffix(net)}{anomalySuffix(net)}</option>
							{/each}
						</select>
					</div>
					{#if selectedNetId}
						{@const net = selectedNet()}
						{@const worker = selectedNetWorker()}
						{#if !net?.worker_id}
							<p class="text-sm text-foreground-muted mt-3">No worker assigned. <a href="/workers" class="text-accent hover:underline">Manage workers</a></p>
						{:else if worker && worker.status !== 'ready'}
							<p class="text-sm text-foreground-muted mt-3">Worker "{worker.name}" is {worker.status}. <a href="/workers" class="text-accent hover:underline">Manage workers</a></p>
						{:else if net && net.load_state !== 'loaded'}
							<button class={btnSmall + ' mt-3'} onclick={handleLoadNet} disabled={workerActionInProgress}>Load net on worker</button>
						{/if}
					{/if}
				</div>
			</DataLoadState>
		</div>
	{/if}

	<!-- The durable record of this net's executions. Outside the graph gate
	     on purpose: a net that has been unloaded still has a history, and that
	     is often exactly when it is wanted. -->
	<RunsPanel net={selectedNet() ?? null} expanded={runsExpanded} onToggle={toggleRuns} />
</div>

{#if showParamsDialog}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div use:portal class="modal-scrim fixed inset-0 flex items-center justify-center z-[9999]" onkeydown={(e) => e.key === 'Escape' && handleParamsCancel()} onclick={handleParamsCancel}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-card border border-border rounded-lg shadow-lg p-6 min-w-[360px] max-w-[480px]" onclick={(e) => e.stopPropagation()}>
			<h3 class="text-base font-semibold text-foreground mb-1">Factory Parameters</h3>
			<p class="text-xs text-foreground-muted mb-4">This net requires parameters before loading.</p>

			<form onsubmit={(e) => { e.preventDefault(); handleParamsSubmit(); }}>
				{#each paramsSchema as param}
					<div class="mb-3">
						<label for="param-{param.name}" class="block text-sm font-medium text-foreground mb-1">
							{param.name}
							{#if param.type}
								<span class="text-xs text-foreground-faint ml-1">({param.type})</span>
							{/if}
							{#if !param.required}
								<span class="text-xs text-foreground-faint ml-1">optional</span>
							{/if}
						</label>
						<input
							id="param-{param.name}"
							type="text"
							bind:value={paramValues[param.name]}
							placeholder={param.default ?? param.default_display ?? ''}
							required={param.required}
							class="w-full px-3 py-2 border border-border rounded bg-surface text-foreground text-sm focus:outline-none focus:border-accent"
						/>
					</div>
				{/each}

				<div class="flex justify-end gap-2 mt-4">
					<button type="button" class={btnSmall} onclick={handleParamsCancel}>Cancel</button>
					<button type="submit" class={btnSmall}>Load</button>
				</div>
			</form>
		</div>
	</div>
{/if}

{#if showSecretsDialog}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div use:portal class="modal-scrim fixed inset-0 flex items-center justify-center z-[9999]" onkeydown={(e) => e.key === 'Escape' && handleSecretsCancel()} onclick={handleSecretsCancel}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-card border border-border rounded-lg shadow-lg p-6 min-w-[480px] max-w-[600px]" onclick={(e) => e.stopPropagation()}>
			<h3 class="text-base font-semibold text-foreground mb-1">Environment Secrets</h3>
			<p class="text-xs text-foreground-muted mb-4">Secrets are encrypted at rest and injected as environment variables when the net loads.</p>

			{#if secretsError}
				<div class="bg-error-bg text-error text-sm px-3 py-2 rounded mb-3">{secretsError}</div>
			{/if}

			<div class="flex flex-col gap-2 max-h-[400px] overflow-y-auto">
				{#each secretEntries as entry, i}
					<div class="flex items-center gap-2">
						{#if entry.isExisting}
							<span class="flex-1 min-w-[160px] px-3 py-2 border border-border rounded bg-surface/50 text-foreground text-sm opacity-70 select-none">{entry.key}</span>
						{:else}
							<input
								type="text"
								bind:value={entry.key}
								placeholder="KEY_NAME"
								class="flex-1 min-w-[160px] px-3 py-2 border border-border rounded bg-surface text-foreground text-sm focus:outline-none focus:border-accent font-mono"
							/>
						{/if}
						<input
							type="password"
							bind:value={entry.value}
							placeholder={entry.isExisting ? 'unchanged' : 'value'}
							autocomplete="off"
							class="flex-1 min-w-[160px] px-3 py-2 border border-border rounded bg-surface text-foreground text-sm focus:outline-none focus:border-accent"
						/>
						<button type="button" class="text-destructive hover:text-destructive/80 text-sm px-1" onclick={() => removeSecretRow(i)} title="Remove this secret">&times;</button>
					</div>
				{/each}
			</div>

			<button type="button" class="text-accent text-sm mt-2 hover:underline" onclick={addSecretRow}>+ Add secret</button>

			<div class="flex justify-end gap-2 mt-4">
				<button type="button" class={btnSmall} onclick={handleSecretsCancel}>Cancel</button>
				<button type="button" class={btnSmall} onclick={handleSecretsSave} disabled={secretsSaving}>
					{secretsSaving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if showSettingsDialog}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div use:portal class="modal-scrim fixed inset-0 flex items-center justify-center z-[9999]" onkeydown={(e) => e.key === 'Escape' && handleSettingsCancel()} onclick={handleSettingsCancel}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-card border border-border rounded-lg shadow-lg p-6 min-w-[480px] max-w-[600px]" onclick={(e) => e.stopPropagation()}>
			<h3 class="text-base font-semibold text-foreground mb-1">Net Settings</h3>
			<p class="text-xs text-foreground-muted mb-4">Per-net configuration that applies whenever this net runs.</p>

			{#if settingsError}
				<div class="bg-error-bg text-error text-sm px-3 py-2 rounded mb-3">{settingsError}</div>
			{/if}

			<div class="flex flex-col gap-2">
				<label class="text-sm text-foreground" for="step-timeout-input">Step wall-clock timeout (seconds)</label>
				<input
					id="step-timeout-input"
					type="number"
					min="1"
					step="1"
					bind:value={settingsTimeoutInput}
					placeholder="empty = unbounded"
					class="px-3 py-2 border border-border rounded bg-surface text-foreground text-sm focus:outline-none focus:border-accent"
				/>
				<p class="text-xs text-foreground-muted">
					Maximum total time a single Step (one transition) may run before the worker kills it.
					Leave empty for unbounded — recommended for monitoring nets and long CPU-heavy work.
					The worker emits internal heartbeats so silent CPU work won't be killed by the inactivity check;
					this knob is only for capping truly stuck work.
				</p>
			</div>

			<div class="flex flex-col gap-2 mt-4">
				<label class="text-sm text-foreground" for="stall-after-input">Stall after (seconds)</label>
				<input
					id="stall-after-input"
					type="number"
					min="1"
					step="1"
					bind:value={settingsStallInput}
					placeholder="empty = no verdict"
					class="px-3 py-2 border border-border rounded bg-surface text-foreground text-sm focus:outline-none focus:border-accent"
				/>
				<p class="text-xs text-foreground-muted">
					Seconds without progress while running before Diagnose calls the net stalled; empty means no verdict.
				</p>
			</div>

			<div class="flex justify-end gap-2 mt-4">
				<button type="button" class={btnSmall} onclick={handleSettingsCancel}>Cancel</button>
				<button type="button" class={btnSmall} onclick={handleSettingsSave} disabled={settingsSaving}>
					{settingsSaving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	</div>
{/if}

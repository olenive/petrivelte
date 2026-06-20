<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { workerEventsStore, connectToWorker, disconnectWorkerEvents } from '$lib/stores/workerEvents';
	import { selectedTokenId } from '$lib/stores/tokenSelection';
	import { serverEventsStore } from '$lib/stores/serverEvents';
	import { workerMemoryStore, type WorkerMemorySnapshot } from '$lib/stores/workerMemory';
	import {
		logout,
		listNets, listWorkers, patchNet, loadNet, unloadNet,
		getExecutionState, executionStep, executionStart, executionStop, executionReset, executionInject,
		listNetSecrets, setNetSecrets, getNetLogHistory,
		type Net, type Worker, type NetParam, type SecretMetadata,
	} from '$lib/api';
	import GraphPanel from '$lib/components/GraphPanel.svelte';
	import ExecutionLog from '$lib/components/ExecutionLog.svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import TokenInspector from '$lib/components/TokenInspector.svelte';
	import TransitionInspector from '$lib/components/TransitionInspector.svelte';
	import AppNav from '$lib/components/AppNav.svelte';
	import DataLoadState from '$lib/components/DataLoadState.svelte';
	import { portal } from '$lib/actions/portal';
	import type { GraphState, Token, LogEntry, Transition } from '$lib/types';
	import { netFullLabel } from '$lib/netHelpers';

	let graphState = $state<GraphState | null>(null);
	let tokens = $state<Token[]>([]);
	let logEntries = $state<LogEntry[]>([]);
	let connectionStatus = $state('Connecting...');

	// Animation state
	type AnimationStage = 'idle' | 'consuming' | 'producing';
	let animationStage = $state<AnimationStage>('idle');
	let consumingTokens = $state<Token[]>([]);
	let producingTokens = $state<Token[]>([]);
	let transitionPosition = $state<{ x: number; y: number } | null>(null);
	let firingTransitionId = $state<string | null>(null);
	let activeEdgeIds = $state<Set<string>>(new Set());
	let animationTimeouts: number[] = [];

	// Animation queue for handling rapid-fire transitions
	interface QueuedAnimation {
		transitionName: string;
		transitionPosition: { x: number; y: number };
		newTokens: Token[];
	}
	let animationQueue: QueuedAnimation[] = [];
	let isAnimating = false;

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
	let isStepping = $state(false);
	let isResetting = $state(false);
	let stepError = $state<string | null>(null);
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
	// ("no_enabled_transitions") is not shown here.
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
	let settingsTimeoutInput = $state('');  // empty string = unbounded
	let settingsSaving = $state(false);
	let settingsError = $state<string | null>(null);

	function getRequiredParams(net: Net | undefined): NetParam[] {
		if (!net?.factory_params_schema) return [];
		return net.factory_params_schema;
	}

	function coerceParamValue(value: string, type: string | null): unknown {
		if (type === 'int') return parseInt(value, 10);
		if (type === 'float') return parseFloat(value);
		if (type === 'bool') return value.toLowerCase() === 'true';
		return value;
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

	// Transition selection handler
	function handleTransitionSelect(transitionId: string | null) {
		selectedTransitionId = transitionId;
		// Auto-expand right sidebar when a transition is selected
		if (transitionId && rightSidebarCollapsed) {
			rightSidebarCollapsed = false;
			savePanelLayout();
		}
	}

	let selectedTransition = $derived(
		selectedTransitionId && graphState
			? graphState.transitions.find(t => t.id === selectedTransitionId) ?? null
			: null
	);

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
		graphState = null;
		tokens = [];
		netLogLines = [];
		executionStoppedReason = null;
		selectedTransitionId = null;
		// TODO: load logEntries from GET /api/nets/{netId}/execution/history once the endpoint exists

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

		// Seed the durable net-log panel from the worker's rotating file so
		// history survives subprocess/worker restarts. Guard against a slow
		// response landing after the user switched nets.
		getNetLogHistory(netId)
			.then((entries) => {
				if (selectedNetId !== netId) return;
				netLogLines = entries.map(formatNetLogEntry);
			})
			.catch(() => {});

		// Fetch execution state
		await refreshGraphState(netId);
	}

	// Pull the worker's current graph state and recompute token positions. Used
	// on net selection and after an inject, so the acting tab updates without
	// waiting on the broadcast round-trip.
	async function refreshGraphState(netId: string) {
		try {
			const stateData = await getExecutionState(netId);
			if (selectedNetId !== netId) return;
			graphState = stateData;
			// Server-derived: adopt the worker's actual continuous-execution
			// state rather than leaving the optimistic flag from a prior session.
			isRunning = !!stateData?.running;

			const tokensData: TokenSummary[] = [];
			if (graphState?.places) {
				for (const place of graphState.places) {
					if (place.tokens && place.tokens.length > 0) {
						for (const token of place.tokens) {
							tokensData.push({
								id: token.id,
								place_id: place.id,
								color: token.color,
								preview: token.preview,
								type_name: token.type_name,
							});
						}
					}
				}
			}
			tokens = calculateTokenPositions(tokensData, graphState!);
		} catch (error) {
			console.error('Failed to fetch execution state:', error);
		}
	}

	async function handleStep() {
		if (!selectedNetId) return;
		stepError = null;
		executionStoppedReason = null;
		subprocessLines = [];
		try {
			await executionStep(selectedNetId);
		} catch (error) {
			console.error('Step failed:', error);
		}
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
		const target = !isRunning;
		isToggling = true;
		try {
			if (isRunning) {
				await executionStop(netId);
			} else {
				executionStoppedReason = null;  // fresh run — drop any prior stop
				await executionStart(netId);
			}
			// Optimistic flip first (keeps pre-`running`-flag workers correct),
			// then let the authoritative state override it where available.
			isRunning = target;
			await refreshRunningState(netId);
		} catch (error) {
			console.error('Activate/Deactivate failed:', error);
			// Best-effort reconcile so the button still reflects reality.
			await refreshRunningState(netId);
		} finally {
			if (selectedNetId === netId) isToggling = false;
		}
	}

	// Resolve function for auto-step to wait on WebSocket step result
	let autoStepResolve: ((fired: boolean) => void) | null = null;

	async function handleAutoStep() {
		if (!selectedNetId) return;

		if (isAutoStepping) {
			isAutoStepping = false;
			if (autoStepResolve) {
				autoStepResolve(false);
				autoStepResolve = null;
			}
			console.log('AUTO STEP: Stopped by user');
			return;
		}

		isAutoStepping = true;
		console.log('AUTO STEP: Starting...');

		// A single failed step is usually a transient backend blip (a 30s
		// timeout under load, a flycast drop) — NOT a reason to abandon a
		// long-running net. Tolerate consecutive failures with backoff and
		// only give up after several in a row, mirroring the worker
		// health-check hysteresis. A success resets the counter.
		const MAX_CONSECUTIVE_STEP_FAILURES = 5;
		let consecutiveFailures = 0;

		while (isAutoStepping) {
			try {
				subprocessLines = [];
				// Register the resolver BEFORE POSTing the step so that a
				// transition_fired event arriving between POST response and
				// this line isn't lost (would otherwise hang the loop).
				const pending = new Promise<boolean>((resolve) => {
					autoStepResolve = resolve;
				});
				await executionStep(selectedNetId);
				const fired = await pending;
				autoStepResolve = null;
				consecutiveFailures = 0;
				stepError = null;

				if (!fired) {
					console.log('AUTO STEP: No more transitions can fire, stopping');
					isAutoStepping = false;
					break;
				}

				// Wait for animation to complete (600ms total)
				await new Promise(resolve => setTimeout(resolve, 650));
			} catch (error) {
				// Clean up the dangling resolver from this iteration.
				autoStepResolve = null;
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
			// Tokens, log entries, and animation state are cleared by the
			// `net_reset` event handler below. That path runs for every open
			// tab/client, keeping them in sync.
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
			await executionInject(selectedNetId, injectPlaceName, token);
			injectNotice = `Injected into ${injectPlaceName}.`;
			// New token positions arrive via the worker's graph_state broadcast;
			// refresh now so the injecting tab updates immediately too.
			await refreshGraphState(selectedNetId);
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
		graphState = null;
		tokens = [];
		logEntries = [];

		if (netId) {
			await selectNet(netId);
		}
	}

	type TokenSummary = {
		id: string;
		place_id: string;
		color: string;
		preview: string;
		type_name: string;
	};

	function calculateTokenPositions(tokensData: TokenSummary[], state: GraphState): Token[] {
		if (!state.places) return [];

		const tokensByPlace = new Map<string, TokenSummary[]>();
		for (const token of tokensData) {
			if (!tokensByPlace.has(token.place_id)) {
				tokensByPlace.set(token.place_id, []);
			}
			tokensByPlace.get(token.place_id)!.push(token);
		}

		const positionedTokens: Token[] = [];
		for (const [placeId, placeTokens] of tokensByPlace) {
			const place = state.places.find(p => p.id === placeId);
			if (!place) continue;

			const tokenCount = placeTokens.length;
			const stackRadius = Math.min(20, tokenCount * 3);

			placeTokens.forEach((token, index) => {
				const angle = (index * 2 * Math.PI) / tokenCount;
				const offsetX = Math.cos(angle) * stackRadius;
				const offsetY = Math.sin(angle) * stackRadius;

				positionedTokens.push({
					id: token.id,
					place_id: placeId,
					x: place.x + offsetX,
					y: place.y + offsetY,
					color: token.color,
					preview: token.preview,
					type_name: token.type_name,
				});
			});
		}

		return positionedTokens;
	}

	function processAnimationQueue() {
		if (animationQueue.length === 0) {
			isAnimating = false;
			return;
		}

		isAnimating = true;
		const animation = animationQueue.shift()!;

		console.log(`⚡ ANIMATION: Starting animation for ${animation.transitionName}`);

		// Build maps for efficient lookup
		const oldTokenMap = new Map(tokens.map(t => [t.id, t]));
		const newTokenMap = new Map(animation.newTokens.map(t => [t.id, t]));

		// Detect consumed tokens (IDs that disappeared)
		const consumed = tokens.filter(t => !newTokenMap.has(t.id));

		// Detect produced tokens (IDs that are new)
		const produced = animation.newTokens.filter(t => !oldTokenMap.has(t.id));

		// Detect moved tokens (same ID, different place_id)
		const moved: { old: Token; new: Token }[] = [];
		for (const [id, oldToken] of oldTokenMap) {
			const newToken = newTokenMap.get(id);
			if (newToken && oldToken.place_id !== newToken.place_id) {
				moved.push({ old: oldToken, new: newToken });
			}
		}

		// Moved tokens should animate like consumed (stage 1) then produced (stage 2)
		// Add old positions to consumed, new positions to produced
		const movedAsConsumed = moved.map(m => m.old);
		const movedAsProduced = moved.map(m => m.new);

		const allConsuming = [...consumed, ...movedAsConsumed];
		const allProducing = [...produced, ...movedAsProduced];

		console.log(`⚡ ANIMATION: Consumed ${consumed.length}, produced ${produced.length}, moved ${moved.length} tokens`);

		// Calculate active edges for each stage
		if (!graphState) {
			console.warn('⚡ ANIMATION: No graphState available');
			isAnimating = false;
			return;
		}

		// Stage 1: Find input edges (place → transition) for consuming tokens
		const inputEdgeIds = new Set<string>();
		const consumingPlaceIds = new Set(allConsuming.map(t => t.place_id));
		graphState.edges.forEach(edge => {
			if (edge.type === 'input' &&
			    edge.target === animation.transitionName &&
			    consumingPlaceIds.has(edge.source)) {
				inputEdgeIds.add(edge.id);
			}
		});

		// Stage 2: Find output edges (transition → place) for producing tokens
		const outputEdgeIds = new Set<string>();
		const producingPlaceIds = new Set(allProducing.map(t => t.place_id));
		graphState.edges.forEach(edge => {
			if (edge.type === 'output' &&
			    edge.source === animation.transitionName &&
			    producingPlaceIds.has(edge.target)) {
				outputEdgeIds.add(edge.id);
			}
		});

		console.log(`⚡ ANIMATION: Active edges - input: ${inputEdgeIds.size}, output: ${outputEdgeIds.size}`);

		// Start two-stage animation
		transitionPosition = animation.transitionPosition;
		firingTransitionId = animation.transitionName;
		consumingTokens = allConsuming;
		producingTokens = allProducing;
		activeEdgeIds = inputEdgeIds; // Start with input edges
		animationStage = 'consuming';

		// Stage 1: Consuming (0-300ms) - tokens move to transition
		const timeout1 = setTimeout(() => {
			console.log('⚡ ANIMATION: Stage 1 complete, starting Stage 2 (producing)');
			activeEdgeIds = outputEdgeIds; // Switch to output edges
			animationStage = 'producing';

			// Stage 2: Producing (300-600ms) - tokens move from transition to output
			const timeout2 = setTimeout(() => {
				console.log('⚡ ANIMATION: Stage 2 complete, updating final state');
				animationStage = 'idle';
				consumingTokens = [];
				producingTokens = [];
				transitionPosition = null;
				firingTransitionId = null;
				activeEdgeIds = new Set();
				tokens = animation.newTokens;

				// Remove completed timeouts
				animationTimeouts = [];

				// Process next animation in queue
				processAnimationQueue();
			}, 300);

			animationTimeouts = [timeout2];
		}, 300);

		animationTimeouts = [timeout1];
	}

	function selectedNet(): Net | undefined {
		return availableNets.find(n => n.id === selectedNetId);
	}

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
		const used = (snap.parent_rss_mb ?? 0) + snap.nets.reduce((s, n) => s + n.rss_mb, 0);
		return Math.min(100, (used / limit) * 100);
	});

	let memoryBarText = $derived.by(() => {
		const snap = selectedWorkerMemory;
		const w = selectedNetWorker();
		if (!snap || !w) return '';
		const limit = Math.round(snap.container_total_mb ?? w.memory_mb);
		const used = Math.round((snap.parent_rss_mb ?? 0) + snap.nets.reduce((s, n) => s + n.rss_mb, 0));
		return `${used} / ${limit} MB`;
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
				factoryParams[p.name] = coerceParamValue(raw, p.type);
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
		settingsError = null;
		showSettingsDialog = true;
	}

	async function handleSettingsSave() {
		if (!selectedNetId) return;
		const trimmed = settingsTimeoutInput.trim();
		let value: number | null;
		if (trimmed === '') {
			value = null;
		} else {
			const parsed = Number(trimmed);
			if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
				settingsError = 'Timeout must be a positive whole number of seconds, or empty for unbounded.';
				return;
			}
			value = parsed;
		}
		settingsSaving = true;
		settingsError = null;
		try {
			const updated = await patchNet(selectedNetId, { step_wall_clock_timeout_seconds: value });
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

	function reconcileRunningPoll() {
		const netId = selectedNetId;
		// Only correct a *believed-running* state — that's the wedged
		// "Deactivate" case. An idle/stopped net polls nothing, and live token
		// updates already arrive via the event stream, so this stays cheap.
		if (!netId || isToggling || !isRunning) return;
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
		// Pure log events carry no state — skip the REST refetch. Only
		// state-change events warrant pulling fresh net/worker lists.
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
	});

	onMount(() => {
		// Load saved panel layout
		loadPanelLayout();

		// Self-healing reconcile of the Activate/Deactivate state.
		runningPollTimer = setInterval(reconcileRunningPoll, RUNNING_POLL_MS);

		// Load workers first — selectNet() (called from fetchNets) needs workers
		// to determine if a net has a ready worker and set graphState.
		(async () => {
			await listWorkers().then(w => workers = w).catch(() => {});
			// Now fetch nets (which may auto-select and load graphState)
			await fetchNets();
		})();

		const unsubscribe = workerEventsStore.subscribe((event) => {
			if (!event) return;

			// Mark connection as established
			connectionStatus = 'Connected';

			// Only net-scoped events drive this view. Filter to the selected net.
			if (event.scope !== 'net' || event.net_id !== selectedNetId) return;

			const { kind, data } = event;

			if (kind === 'step_started') {
				isStepping = true;
				// Don't clear stepError here — keep the previous error visible
				// until this step either succeeds or produces a new error.
				subprocessLines = [];
			}

			if (kind === 'transition_fired') {
				isStepping = false;
				stepError = null;
				logEntries = [data.log_entry, ...logEntries];

				// Resolve auto-step promise: a transition fired
				if (autoStepResolve) autoStepResolve(true);

				if (!graphState) return;

				const newTokens = calculateTokenPositions(data.new_token_positions, graphState);

				const transition = graphState.transitions.find(t => t.name === data.transition_name);
				if (!transition) {
					tokens = newTokens;
					return;
				}

				animationQueue.push({
					transitionName: transition.name,
					transitionPosition: { x: transition.x, y: transition.y },
					newTokens
				});

				// If queue is getting too long, skip to catch up
				if (animationQueue.length > 3) {
					const lastAnimation = animationQueue[animationQueue.length - 1];
					tokens = lastAnimation.newTokens;
					animationQueue = [];
					animationStage = 'idle';
					consumingTokens = [];
					producingTokens = [];
					transitionPosition = null;
					isAnimating = false;
					animationTimeouts.forEach(t => clearTimeout(t));
					animationTimeouts = [];
					return;
				}

				if (!isAnimating) {
					processAnimationQueue();
				}
			}

			if (kind === 'step_completed') {
				isStepping = false;
				stepError = null;
				if (autoStepResolve) autoStepResolve(false);
			}

			if (kind === 'step_error') {
				isStepping = false;
				stepError = data.error;
				if (autoStepResolve) {
					autoStepResolve(false);
					autoStepResolve = null;
				}
			}

			if (kind === 'subprocess_output') {
				subprocessLines = [...subprocessLines, data.text];
				// Also accumulate into the durable, net-wide panel (not cleared
				// per step). ts comes from the event so it matches file replay.
				netLogLines = [...netLogLines, formatNetLogEntry({ ts: event.ts, text: data.text })];
			}

			if (kind === 'execution_stopped') {
				isRunning = false;
				// Loud, legible stop: show error stops only. A normal end-of-run
				// (no enabled transitions) is not an error, so don't alarm on it.
				// Accept the legacy 'deadlock' sentinel too, so an old worker
				// mid-deploy doesn't trip a spurious banner.
				if (
					data.reason &&
					data.reason !== 'no_enabled_transitions' &&
					data.reason !== 'deadlock'
				) {
					executionStoppedReason = data.error_type
						? `${data.error_type}: ${data.message ?? ''}`.trim()
						: String(data.reason);
				}
			}

			if (kind === 'net_reset') {
				// Worker reset the net — rebuild tokens and drop any stale log
				// entries / in-flight animations. This handler runs in every
				// tab/client subscribed to the worker, not just the one that
				// clicked Reset.
				animationTimeouts.forEach(t => clearTimeout(t));
				animationTimeouts = [];
				animationQueue = [];
				animationStage = 'idle';
				consumingTokens = [];
				producingTokens = [];
				transitionPosition = null;
				firingTransitionId = null;
				activeEdgeIds = new Set();
				isAnimating = false;
				isStepping = false;
				stepError = null;
				executionStoppedReason = null;
				subprocessLines = [];
				logEntries = [];

				const state = data as GraphState;
				graphState = state;
				const tokensData: TokenSummary[] = [];
				for (const place of state.places ?? []) {
					for (const token of place.tokens ?? []) {
						tokensData.push({
							id: token.id,
							place_id: place.id,
							color: token.color,
							preview: token.preview,
							type_name: token.type_name,
						});
					}
				}
				tokens = calculateTokenPositions(tokensData, state);
			}

			if (kind === 'graph_state') {
				// A non-reset state refresh (e.g. a token was injected). Rebuild
				// tokens in every subscribed tab without disturbing logs or any
				// in-flight step animation.
				const state = data as GraphState;
				graphState = state;
				const tokensData: TokenSummary[] = [];
				for (const place of state.places ?? []) {
					for (const token of place.tokens ?? []) {
						tokensData.push({
							id: token.id,
							place_id: place.id,
							color: token.color,
							preview: token.preview,
							type_name: token.type_name,
						});
					}
				}
				tokens = calculateTokenPositions(tokensData, state);
			}
		});

		return () => {
			unsubscribe();
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

	{#if graphState}
		<!-- Secondary toolbar: net controls + execution buttons -->
		<div class="flex items-center gap-6 px-6 py-3 bg-card border-b border-border flex-wrap">
			<span class="px-3 py-1.5 rounded text-xs {connectionStatus === 'Connected' ? 'bg-status-success-bg text-status-success' : 'bg-status-warning-bg text-status-warning'}">
				{connectionStatus}
			</span>

			{#if availableNets.length > 0}
				<div class="flex items-center gap-2">
					<label for="net-select" class="text-sm font-medium text-foreground">Net:</label>
					<select id="net-select" bind:value={selectedNetId} onchange={handleNetSelect}
						class="px-4 py-2 border border-border rounded bg-card text-foreground text-sm cursor-pointer hover:border-accent">
						{#each availableNets as net}
							<option value={net.id}>{netFullLabel(net, availableNets)}</option>
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
								style="background: {selectedNet()?.load_state === 'loaded' ? 'var(--status-ready)' : selectedNet()?.load_state === 'error' ? 'var(--status-error)' : 'var(--status-stopped)'}">
								{selectedNet()?.load_state === 'loaded' ? 'Loaded' : selectedNet()?.load_state === 'error' ? 'Error' : 'Unloaded'}
							</span>
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
					<span class="px-4 py-2 rounded text-sm font-medium {isToggling ? 'bg-status-warning-bg text-status-warning' : isRunning ? 'bg-status-info-bg text-status-info' : isAutoStepping ? 'bg-status-warning-bg text-status-warning' : isStepping ? 'bg-status-warning-bg text-status-warning' : 'bg-muted text-foreground-muted'}">
						{isToggling ? 'Working…' : isRunning ? 'Active' : isAutoStepping ? 'Repeating' : isStepping ? 'Stepping...' : 'Idle'}
					</span>
				</div>

				{#if selectedWorkerMemory}
					<div
						class="flex items-center gap-2 min-w-[180px]"
						title="Worker memory: parent {Math.round(selectedWorkerMemory.parent_rss_mb ?? 0)} MB + nets {Math.round(selectedWorkerMemory.nets.reduce((s, n) => s + n.rss_mb, 0))} MB"
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
					<button class={btnDefault} onclick={handleStep} disabled={isRunning || isAutoStepping || isStepping || isResetting || isToggling || !selectedNetId} title="Fire a single transition manually.">Step</button>
					<button class={isAutoStepping ? btnDanger : btnDefault} onclick={handleAutoStep} disabled={isRunning || isResetting || isToggling || !selectedNetId}
						title={isAutoStepping ? "Stop repeating steps." : "Repeatedly fires one transition at a time (with animation), like clicking Step over and over. Driven by this browser tab — closing or disconnecting it stops the run. To run the net independently of the browser, use Activate."}
					>{isAutoStepping ? 'Stop' : 'Repeat Step'}</button>
					<button class={isRunning ? btnDanger : btnDefault} onclick={handleActivateDeactivate} disabled={isAutoStepping || isResetting || isToggling || !selectedNetId}
						title={isRunning ? "Stop continuous execution on the worker." : "Run continuously on the worker. Keeps running even if you close this window; reopen the net to observe it again."}
					>{#if isToggling}<span class="inline-flex items-center gap-2"><span class="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>{isRunning ? 'Deactivating…' : 'Activating…'}</span>{:else}{isRunning ? 'Deactivate' : 'Activate'}{/if}</button>
					<button class={btnDefault} onclick={handleReset} disabled={isRunning || isAutoStepping || isResetting || isToggling || !selectedNetId} title="Reset the Petri net to its initial state.">{isResetting ? 'Resetting…' : 'Reset'}</button>
					<button class={showInject ? btnDanger : btnDefault} onclick={() => (showInject = !showInject)} disabled={!selectedNetId}
						title="Inject a typed token into a place — e.g. synthetic traffic to drive an end-to-end alert test.">{showInject ? 'Close Inject' : 'Inject…'}</button>
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
						{#each graphState?.places ?? [] as place (place.id)}
							<option value={place.name}>{place.name} · {place.type_name}</option>
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
				The worker validates the token against the place's declared type. For the
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

	{#if graphState}
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
									<ExecutionLog entries={logEntries} {isStepping} {stepError} {subprocessLines} />
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
								<span class="bg-hover text-foreground-muted px-1.5 py-0.5 rounded-full text-xs">{tokens.length}</span>
							</button>
							{#if !tokenInspectorCollapsed}
								<div class="flex-1 overflow-hidden flex flex-col">
									<TokenInspector
										netId={selectedNetId}
										{tokens}
										places={graphState.places}
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
						<span class="text-[0.7rem] text-foreground-muted">{tokens.length}</span>
					</button>
				</aside>
			{/if}

			<!-- Graph Panel -->
			<div class="flex-1 p-4 overflow-hidden flex">
				<GraphPanel
					{graphState}
					{tokens}
					{animationStage}
					{consumingTokens}
					{producingTokens}
					{transitionPosition}
					{firingTransitionId}
					{activeEdgeIds}
					selectedTokenId={$selectedTokenId}
					onTokenSelect={handleTokenSelect}
					{selectedTransitionId}
					onTransitionSelect={handleTransitionSelect}
				/>
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
							<TransitionInspector transition={selectedTransition} />
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
								<option value={net.id}>{netFullLabel(net, availableNets)}</option>
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
							placeholder={param.default ?? ''}
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

			<div class="flex justify-end gap-2 mt-4">
				<button type="button" class={btnSmall} onclick={handleSettingsCancel}>Cancel</button>
				<button type="button" class={btnSmall} onclick={handleSettingsSave} disabled={settingsSaving}>
					{settingsSaving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	</div>
{/if}

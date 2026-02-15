<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { webSocketStore } from '$lib/stores/webSocket';
	import { selectedTokenId } from '$lib/stores/tokenSelection';
	import {
		getMe, logout,
		listNets, listWorkers, patchNet, loadNet, unloadNet,
		getExecutionState, executionStep, executionStart, executionStop, executionReset,
		getGitHubStatus, listGitHubRepos, listDeployments,
		type Net, type Worker,
	} from '$lib/api';
	import GraphPanel from '$lib/components/GraphPanel.svelte';
	import ExecutionLog from '$lib/components/ExecutionLog.svelte';
	import TokenInspector from '$lib/components/TokenInspector.svelte';
	import AppNav from '$lib/components/AppNav.svelte';
	import SetupChecklist from '$lib/components/SetupChecklist.svelte';
	import type { GraphState, Token, LogEntry } from '$lib/types';

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
	let userEmail = $state('');

	// Net selection and execution state
	let availableNets = $state<Net[]>([]);
	let selectedNetId = $state<string | null>(null);
	let isRunning = $state(false);
	let isAutoStepping = $state(false);

	// Worker state
	let workers = $state<Worker[]>([]);
	let workerActionInProgress = $state(false);

	// Checklist state (fetched only when graphState is null)
	let githubConnected = $state(false);
	let hasRepos = $state(false);
	let hasSuccessfulBuild = $state(false);

	// Panel layout state
	const PANEL_STORAGE_KEY = 'petrivelte-panel-layout';
	const MIN_SIDEBAR_WIDTH = 200;
	const MAX_SIDEBAR_WIDTH = 600;
	const MIN_PANEL_HEIGHT = 100;
	const DEFAULT_SIDEBAR_WIDTH = 350;
	const DEFAULT_PANEL_RATIO = 0.5;

	let execLogCollapsed = $state(false);
	let tokenInspectorCollapsed = $state(false);
	let sidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
	let execLogRatio = $state(DEFAULT_PANEL_RATIO);

	// Drag state for resizing
	let isDraggingSidebar = $state(false);
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
				execLogRatio
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

	function handleSidebarDragStart(event: MouseEvent) {
		isDraggingSidebar = true;
		dragStartX = event.clientX;
		dragStartWidth = sidebarWidth;
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
		if (isDraggingSidebar || isDraggingPanelDivider) {
			isDraggingSidebar = false;
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

	async function fetchNets() {
		try {
			availableNets = await listNets();

			// Auto-select first net if none selected
			if (availableNets.length > 0 && !selectedNetId) {
				await selectNet(availableNets[0].id);
			}
		} catch (error) {
			console.error('Failed to fetch nets:', error);
		}
	}

	async function selectNet(netId: string) {
		selectedNetId = netId;
		isRunning = false;
		graphState = null;
		tokens = [];

		// Only connect WebSocket and fetch execution state if the net has a ready worker
		const net = availableNets.find(n => n.id === netId);
		const worker = net?.worker_id ? workers.find(w => w.id === net.worker_id) : null;
		if (!worker || worker.status !== 'ready') {
			webSocketStore.disconnect();
			return;
		}

		// Connect WebSocket to this net
		webSocketStore.connectToNet(netId);

		// Fetch execution state
		try {
			const stateData = await getExecutionState(netId);
			graphState = stateData;

			const tokensData: Array<{id: string, place_id: string, data: any}> = [];
			if (graphState?.places) {
				for (const place of graphState.places) {
					if (place.tokens && place.tokens.length > 0) {
						for (const token of place.tokens) {
							tokensData.push({
								id: token.id,
								place_id: place.id,
								data: token.data
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
		try {
			await executionStep(selectedNetId);
		} catch (error) {
			console.error('Step failed:', error);
		}
	}

	async function handleActivateDeactivate() {
		if (!selectedNetId) return;
		try {
			if (isRunning) {
				await executionStop(selectedNetId);
			} else {
				await executionStart(selectedNetId);
			}
			isRunning = !isRunning;
		} catch (error) {
			console.error('Activate/Deactivate failed:', error);
		}
	}

	async function handleAutoStep() {
		if (!selectedNetId) return;

		if (isAutoStepping) {
			isAutoStepping = false;
			console.log('AUTO STEP: Stopped by user');
			return;
		}

		isAutoStepping = true;
		console.log('AUTO STEP: Starting...');

		while (isAutoStepping) {
			try {
				const result = await executionStep(selectedNetId);

				if (result.fired === 0) {
					console.log('AUTO STEP: No more transitions can fire, stopping');
					isAutoStepping = false;
					break;
				}

				// Wait for animation to complete (600ms total)
				await new Promise(resolve => setTimeout(resolve, 650));
			} catch (error) {
				console.error('AUTO STEP: Step failed:', error);
				isAutoStepping = false;
				break;
			}
		}

		console.log('AUTO STEP: Completed');
	}

	async function handleReset() {
		if (!selectedNetId) return;
		try {
			await executionReset(selectedNetId);
			// Clear execution log and animation state (tokens will be updated by WebSocket graph_state message)
			logEntries = [];
			animationQueue = [];
			animationTimeouts.forEach(t => clearTimeout(t));
			animationTimeouts = [];
			animationStage = 'idle';
			consumingTokens = [];
			producingTokens = [];
			transitionPosition = null;
			firingTransitionId = null;
			activeEdgeIds = new Set();
			isAnimating = false;
		} catch (error) {
			console.error('Reset failed:', error);
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

	function calculateTokenPositions(tokensData: Array<{id: string, place_id: string, data: any}>, state: GraphState): Token[] {
		if (!state.places) return [];

		// Group tokens by place_id
		const tokensByPlace = new Map<string, Array<{id: string, data: any}>>();
		for (const token of tokensData) {
			if (!tokensByPlace.has(token.place_id)) {
				tokensByPlace.set(token.place_id, []);
			}
			tokensByPlace.get(token.place_id)!.push({id: token.id, data: token.data});
		}

		// Calculate positions for each place's tokens
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
					color: getTokenColor(token.data),
					data: token.data
				});
			});
		}

		return positionedTokens;
	}

	function getTokenColor(tokenData: any): string {
		if (tokenData && tokenData.color) {
			const colorMap: Record<string, string> = {
				red: '#ef4444',
				blue: '#3b82f6',
				green: '#22c55e',
				yellow: '#eab308',
				purple: '#a855f7',
				orange: '#f97316',
				pink: '#ec4899',
				gray: '#6b7280'
			};
			return colorMap[tokenData.color.toLowerCase()] || '#6b7280';
		}
		return '#6b7280'; // Gray default
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
				// Unassign — send explicit null via raw fetch
				const { API_URL } = await import('$lib/api');
				const res = await fetch(`${API_URL}/api/nets/${selectedNetId}`, {
					method: 'PATCH',
					credentials: 'include',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ worker_id: null }),
				});
				if (!res.ok) throw new Error('Failed to unassign worker');
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
		workerActionInProgress = true;
		try {
			await loadNet(selectedNetId);
			availableNets = await listNets();
		} catch (error) {
			console.error('Load failed:', error);
		} finally {
			workerActionInProgress = false;
		}
	}

	async function handleUnloadNet() {
		if (!selectedNetId) return;
		workerActionInProgress = true;
		try {
			await unloadNet(selectedNetId);
			availableNets = await listNets();
		} catch (error) {
			console.error('Unload failed:', error);
		} finally {
			workerActionInProgress = false;
		}
	}

	async function handleLogout() {
		await logout();
		goto('/login');
	}

	onMount(() => {
		// Load saved panel layout
		loadPanelLayout();

		// Check auth and load nets
		(async () => {
			const user = await getMe();
			if (!user) {
				goto('/login');
				return;
			}
			userEmail = user.email;
			await Promise.all([
				fetchNets(),
				listWorkers().then(w => workers = w).catch(() => {}),
				// Checklist data
				getGitHubStatus().then(s => githubConnected = s.connected).catch(() => {}),
				listGitHubRepos().then(r => hasRepos = r.length > 0).catch(() => {}),
				listDeployments().then(d => hasSuccessfulBuild = d.some(dep => dep.build_status === 'success')).catch(() => {}),
			]);
		})();

		const unsubscribe = webSocketStore.subscribe((message) => {
			if (!message) return;

			// Mark connection as established
			connectionStatus = 'Connected';

			// Filter messages by selected net
			if (message.graph_id !== selectedNetId) return;

			if (message.type === 'graph_state') {
				graphState = message.data;

				const tokensData: Array<{id: string, place_id: string, data: any}> = [];
				if (graphState.places) {
					for (const place of graphState.places) {
						if (place.tokens && place.tokens.length > 0) {
							for (const token of place.tokens) {
								tokensData.push({
									id: token.id,
									place_id: place.id,
									data: token.data
								});
							}
						}
					}
				}
				tokens = calculateTokenPositions(tokensData, graphState);
			}

			if (message.type === 'transition_fired') {
				logEntries = [message.log_entry, ...logEntries];

				if (!graphState) return;

				const newTokens = calculateTokenPositions(message.new_token_positions, graphState);

				const transition = graphState.transitions.find(t => t.name === message.transition_name);
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
		});

		return () => {
			unsubscribe();
			webSocketStore.disconnect();
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
	<AppNav {userEmail} onLogout={handleLogout} />

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
							<option value={net.id}>{net.name}</option>
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
					</div>
				{/if}

				<div class="flex items-center gap-2">
					<span class="px-4 py-2 rounded text-sm font-medium {isRunning ? 'bg-status-info-bg text-status-info' : isAutoStepping ? 'bg-status-warning-bg text-status-warning' : 'bg-muted text-foreground-muted'}">
						{isRunning ? 'Active' : isAutoStepping ? 'Auto Stepping' : 'Idle'}
					</span>
				</div>

				<div class="flex items-center gap-2">
					<button class={btnDefault} onclick={handleStep} disabled={isRunning || isAutoStepping || !selectedNetId} title="Fire a single transition manually.">Step</button>
					<button class={isAutoStepping ? btnDanger : btnDefault} onclick={handleAutoStep} disabled={isRunning || !selectedNetId}
						title={isAutoStepping ? "Stop automatic stepping." : "Automatically fire transitions one at a time with animations."}
					>{isAutoStepping ? 'Stop' : 'Auto Step'}</button>
					<button class={isRunning ? btnDanger : btnDefault} onclick={handleActivateDeactivate} disabled={isAutoStepping || !selectedNetId}
						title={isRunning ? "Stop continuous execution." : "Start continuous execution."}
					>{isRunning ? 'Deactivate' : 'Activate'}</button>
					<button class={btnDefault} onclick={handleReset} disabled={isRunning || isAutoStepping || !selectedNetId} title="Reset the Petri net to its initial state.">Reset</button>
				</div>
			{/if}
		</div>
	{/if}

	{#if graphState}
		<main class="flex flex-1 overflow-hidden {isDraggingSidebar || isDraggingPanelDivider ? 'cursor-col-resize select-none' : ''}">
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
									<ExecutionLog entries={logEntries} />
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
										{tokens}
										places={graphState.places}
										selectedTokenId={$selectedTokenId}
										onTokenSelect={handleTokenSelect}
									/>
								</div>
							{/if}
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
				/>
			</div>
		</main>
	{:else}
		<div class="flex-1 flex flex-col items-center justify-center p-8">
			<SetupChecklist
				{githubConnected}
				{hasRepos}
				{hasSuccessfulBuild}
				hasWorkers={workers.length > 0}
				hasReadyWorker={workers.some(w => w.status === 'ready')}
				hasLoadedNet={availableNets.some(n => n.load_state === 'loaded')}
			/>
		</div>
	{/if}
</div>

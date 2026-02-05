<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { webSocketStore } from '$lib/stores/webSocket';
	import { selectedTokenId } from '$lib/stores/tokenSelection';
	import {
		getMe, logout,
		listNets, getExecutionState, executionStep, executionStart, executionStop, executionReset,
		type Net,
	} from '$lib/api';
	import GraphPanel from '$lib/components/GraphPanel.svelte';
	import ExecutionLog from '$lib/components/ExecutionLog.svelte';
	import TokenInspector from '$lib/components/TokenInspector.svelte';
	import type { GraphState, Token, LogEntry } from '$lib/types';

	let graphState: GraphState | null = null;
	let tokens: Token[] = [];
	let logEntries: LogEntry[] = [];
	let connectionStatus = 'Connecting...';

	// Animation state
	type AnimationStage = 'idle' | 'consuming' | 'producing';
	let animationStage: AnimationStage = 'idle';
	let consumingTokens: Token[] = [];
	let producingTokens: Token[] = [];
	let transitionPosition: { x: number; y: number } | null = null;
	let firingTransitionId: string | null = null;
	let activeEdgeIds: Set<string> = new Set();
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
	let userEmail = '';

	// Net selection and execution state
	let availableNets: Net[] = [];
	let selectedNetId: string | null = null;
	let isRunning = false;
	let isAutoStepping = false;

	// Theme state
	const THEME_STORAGE_KEY = 'petrivelte-theme';
	let theme: 'light' | 'dark' = 'dark';

	function loadTheme() {
		if (typeof window === 'undefined') return;
		try {
			const saved = localStorage.getItem(THEME_STORAGE_KEY);
			if (saved === 'light' || saved === 'dark') {
				theme = saved;
			} else {
				// Detect OS preference
				const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
				theme = prefersDark ? 'dark' : 'light';
			}
		} catch (e) {
			console.warn('Failed to load theme:', e);
			theme = 'dark'; // Fallback
		}
		applyTheme();
	}

	function toggleTheme() {
		theme = theme === 'light' ? 'dark' : 'light';
		applyTheme();
		if (typeof window !== 'undefined') {
			try {
				localStorage.setItem(THEME_STORAGE_KEY, theme);
			} catch (e) {
				console.warn('Failed to save theme:', e);
			}
		}
	}

	function applyTheme() {
		if (typeof document !== 'undefined') {
			document.body.classList.remove('light-theme', 'dark-theme');
			document.body.classList.add(`${theme}-theme`);
		}
	}

	// Panel layout state
	const PANEL_STORAGE_KEY = 'petrivelte-panel-layout';
	const MIN_SIDEBAR_WIDTH = 200;
	const MAX_SIDEBAR_WIDTH = 600;
	const MIN_PANEL_HEIGHT = 100;
	const DEFAULT_SIDEBAR_WIDTH = 350;
	const DEFAULT_PANEL_RATIO = 0.5;

	let execLogCollapsed = false;
	let tokenInspectorCollapsed = false;
	let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
	let execLogRatio = DEFAULT_PANEL_RATIO; // Ratio of exec log height to total sidebar height

	// Drag state for resizing
	let isDraggingSidebar = false;
	let isDraggingPanelDivider = false;
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
	$: sidebarCollapsed = execLogCollapsed && tokenInspectorCollapsed;

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
			// Net might not be loaded on worker yet — that's ok, WebSocket will send state
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

	async function handleLogout() {
		await logout();
		goto('/login');
	}

	onMount(() => {
		// Load theme preference
		loadTheme();

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
			await fetchNets();
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
</script>

<svelte:window on:mousemove={handleMouseMove} on:mouseup={handleMouseUp} />

<div class="app">
	<header>
		<div class="header-left">
			<h1>Petritype</h1>
			<span class="status" class:connected={connectionStatus === 'Connected'}>
				{connectionStatus}
			</span>
			<button class="theme-toggle" on:click={toggleTheme} title="Toggle light/dark mode">
				{theme === 'light' ? 'dark' : 'light'}
			</button>
		</div>

		<div class="controls">
			{#if availableNets.length > 0}
				<div class="control-group">
					<label for="net-select">Net:</label>
					<select id="net-select" bind:value={selectedNetId} on:change={handleNetSelect}>
						{#each availableNets as net}
							<option value={net.id}>{net.name}</option>
						{/each}
					</select>
				</div>

				<div class="control-group">
					<span class="execution-state" class:running={isRunning} class:auto-stepping={isAutoStepping}>
						{isRunning ? 'Active' : isAutoStepping ? 'Auto Stepping' : 'Idle'}
					</span>
				</div>

				<div class="control-group">
					<button
						on:click={handleStep}
						disabled={isRunning || isAutoStepping || !selectedNetId}
						title="Fire a single transition manually."
					>
						Step
					</button>
					<button
						on:click={handleAutoStep}
						disabled={isRunning || !selectedNetId}
						class:stop={isAutoStepping}
						title={isAutoStepping
							? "Stop automatic stepping."
							: "Automatically fire transitions one at a time with animations."}
					>
						{isAutoStepping ? 'Stop' : 'Auto Step'}
					</button>
					<button
						on:click={handleActivateDeactivate}
						disabled={isAutoStepping || !selectedNetId}
						class:stop={isRunning}
						title={isRunning
							? "Stop continuous execution."
							: "Start continuous execution."}
					>
						{isRunning ? 'Deactivate' : 'Activate'}
					</button>
					<button
						on:click={handleReset}
						disabled={isRunning || isAutoStepping || !selectedNetId}
						title="Reset the Petri net to its initial state."
					>
						Reset
					</button>
				</div>
			{/if}

			<div class="control-group user-info">
				<span class="user-email">{userEmail}</span>
				<button on:click={handleLogout} title="Sign out">Logout</button>
			</div>
		</div>
	</header>

	{#if graphState}
		<main class="panels" class:dragging={isDraggingSidebar || isDraggingPanelDivider}>
			<!-- Left sidebar -->
			{#if !sidebarCollapsed}
				<aside class="sidebar" style="width: {sidebarWidth}px;">
					<div class="sidebar-content">
						<!-- Execution Log Panel -->
						<div
							class="panel exec-log"
							class:collapsed={execLogCollapsed}
							style={!execLogCollapsed && !tokenInspectorCollapsed
								? `height: ${execLogRatio * 100}%`
								: !execLogCollapsed
									? 'flex: 1'
									: ''}
						>
							<button class="panel-header" on:click={toggleExecLog}>
								<span class="panel-toggle">{execLogCollapsed ? '▶' : '▼'}</span>
								<span class="panel-title">Execution Log</span>
								<span class="panel-badge">{logEntries.length}</span>
							</button>
							{#if !execLogCollapsed}
								<div class="panel-content">
									<ExecutionLog entries={logEntries} />
								</div>
							{/if}
						</div>

						<!-- Resize handle between panels -->
						{#if !execLogCollapsed && !tokenInspectorCollapsed}
							<div
								class="panel-divider"
								on:mousedown={handlePanelDividerDragStart}
								role="separator"
								aria-orientation="horizontal"
							></div>
						{/if}

						<!-- Token Inspector Panel -->
						<div
							class="panel token-inspector"
							class:collapsed={tokenInspectorCollapsed}
							style={!tokenInspectorCollapsed && !execLogCollapsed
								? `height: ${(1 - execLogRatio) * 100}%`
								: !tokenInspectorCollapsed
									? 'flex: 1'
									: ''}
						>
							<button class="panel-header" on:click={toggleTokenInspector}>
								<span class="panel-toggle">{tokenInspectorCollapsed ? '▶' : '▼'}</span>
								<span class="panel-title">All Tokens</span>
								<span class="panel-badge">{tokens.length}</span>
							</button>
							{#if !tokenInspectorCollapsed}
								<div class="panel-content">
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
					<div
						class="sidebar-divider"
						on:mousedown={handleSidebarDragStart}
						role="separator"
						aria-orientation="vertical"
					></div>
				</aside>
			{:else}
				<!-- Collapsed sidebar tabs -->
				<aside class="sidebar-collapsed">
					<button class="collapsed-tab" on:click={toggleExecLog} title="Execution Log">
						<span class="tab-icon">📋</span>
						<span class="tab-badge">{logEntries.length}</span>
					</button>
					<button class="collapsed-tab" on:click={toggleTokenInspector} title="All Tokens">
						<span class="tab-icon">🔘</span>
						<span class="tab-badge">{tokens.length}</span>
					</button>
				</aside>
			{/if}

			<!-- Graph Panel -->
			<div class="graph-area">
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
		<div class="loading">
			<p>No graph data yet.</p>
			<p class="hint">
				Create a net, assign it to a worker, and load it.
				<br />
				The graph will appear once the net is loaded on a running worker.
			</p>
		</div>
	{/if}
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		font-family: system-ui, -apple-system, sans-serif;
	}

	/* Light theme */
	:global(body.light-theme) {
		--bg-primary: #f5f5f5;
		--bg-secondary: white;
		--bg-tertiary: #f8f9fa;
		--bg-hover: #f5f5f5;
		--text-primary: #333;
		--text-secondary: #666;
		--text-tertiary: #999;
		--border-color: #ddd;
		--border-light: #eee;
		--graph-bg: #f0f0f0;
		--place-fill: white;
		--place-stroke: #0066cc;
		--place-text: #333;
		--transition-stroke: #0066cc;
		--transition-fill: white;
		--transition-text: #333;
		--edge-input: #0066cc;
		--edge-output: #0066cc;
		--token-stroke: #333;
		--button-border: #0066cc;
		--button-text: #0066cc;
		--button-hover-bg: #0066cc;
		--button-hover-text: white;
		--token-selection-color: #0066cc;
		--token-selection-glow: rgba(0, 102, 204, 0.5);
	}

	/* Dark theme */
	:global(body.dark-theme) {
		--bg-primary: #0f0f0f;
		--bg-secondary: #1a1a1a;
		--bg-tertiary: #2d2d2d;
		--bg-hover: #333333;
		--text-primary: #ffffff;
		--text-secondary: #b0b0b0;
		--text-tertiary: #808080;
		--border-color: #333;
		--border-light: #444;
		--graph-bg: #1a1a1a;
		--place-fill: #1a1a1a;
		--place-stroke: #5cb85c;
		--place-text: #fffacd;
		--transition-stroke: #5cb85c;
		--transition-fill: #1a1a1a;
		--transition-text: #fffacd;
		--edge-input: #5cb85c;
		--edge-output: #5cb85c;
		--token-stroke: #ffffff;
		--button-border: #4d9fff;
		--button-text: #4d9fff;
		--button-hover-bg: #4d9fff;
		--button-hover-text: #0f0f0f;
		--token-selection-color: #4d9fff;
		--token-selection-glow: rgba(77, 159, 255, 0.6);
	}

	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--bg-primary);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 2rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border-color);
		gap: 2rem;
		flex-wrap: wrap;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	h1 {
		margin: 0;
		font-size: 1.5rem;
		color: var(--text-primary);
	}

	.theme-toggle {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: 4px;
		background: var(--bg-tertiary);
		font-size: 1.2em;
		cursor: pointer;
		transition: all 0.2s;
	}

	.theme-toggle:hover {
		background: var(--bg-hover);
		transform: scale(1.1);
	}

	.status {
		padding: 0.5rem 1rem;
		border-radius: 4px;
		font-size: 0.9em;
		background: #fff3cd;
		color: #856404;
	}

	.status.connected {
		background: #d4edda;
		color: #155724;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		flex-wrap: wrap;
	}

	.control-group {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	label {
		font-size: 0.9em;
		font-weight: 500;
		color: var(--text-primary);
	}

	select {
		padding: 0.5rem 1rem;
		border: 1px solid var(--border-color);
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: 0.9em;
		cursor: pointer;
	}

	select:hover {
		border-color: var(--button-border);
	}

	button {
		padding: 0.5rem 1.25rem;
		border: 1px solid var(--button-border);
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--button-text);
		font-size: 0.9em;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	button:hover:not(:disabled) {
		background: var(--button-hover-bg);
		color: var(--button-hover-text);
	}

	button.stop {
		border-color: #dc3545;
		color: #dc3545;
	}

	button.stop:hover {
		background: #dc3545;
		color: white;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		border-color: var(--border-color);
		color: var(--text-tertiary);
	}

	.user-info {
		margin-left: auto;
	}

	.user-email {
		font-size: 0.85em;
		color: var(--text-secondary);
	}

	.execution-state {
		padding: 0.5rem 1rem;
		border-radius: 4px;
		font-size: 0.9em;
		background: var(--bg-tertiary);
		color: var(--text-secondary);
		font-weight: 500;
	}

	.execution-state.running {
		background: #d1ecf1;
		color: #0c5460;
	}

	.execution-state.auto-stepping {
		background: #fff3cd;
		color: #856404;
	}

	.panels {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.panels.dragging {
		cursor: col-resize;
		user-select: none;
	}

	/* Sidebar */
	.sidebar {
		display: flex;
		flex-shrink: 0;
		background: var(--bg-secondary);
		border-right: 1px solid var(--border-color);
	}

	.sidebar-content {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.sidebar-divider {
		width: 6px;
		background: var(--bg-tertiary);
		cursor: col-resize;
		transition: background 0.2s;
	}

	.sidebar-divider:hover {
		background: var(--button-border);
	}

	/* Collapsed sidebar */
	.sidebar-collapsed {
		display: flex;
		flex-direction: column;
		background: var(--bg-secondary);
		border-right: 1px solid var(--border-color);
		padding: 0.5rem;
		gap: 0.5rem;
	}

	.collapsed-tab {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.5rem;
		border: 1px solid var(--border-color);
		border-radius: 4px;
		background: var(--bg-tertiary);
		cursor: pointer;
		transition: all 0.2s;
	}

	.collapsed-tab:hover {
		background: var(--bg-hover);
		border-color: var(--button-border);
	}

	.tab-icon {
		font-size: 1.2rem;
	}

	.tab-badge {
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	/* Panel styles */
	.panel {
		display: flex;
		flex-direction: column;
		background: var(--bg-secondary);
		overflow: hidden;
	}

	.panel.collapsed {
		flex: 0 0 auto;
	}

	.panel-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--bg-tertiary);
		border: none;
		border-bottom: 1px solid var(--border-color);
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-primary);
		transition: background 0.2s;
		width: 100%;
	}

	.panel-header:hover {
		background: var(--bg-hover);
	}

	.panel-toggle {
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.panel-title {
		flex: 1;
	}

	.panel-badge {
		background: var(--bg-hover);
		color: var(--text-secondary);
		padding: 0.1rem 0.4rem;
		border-radius: 10px;
		font-size: 0.75rem;
	}

	.panel-content {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	/* Panel divider */
	.panel-divider {
		height: 6px;
		background: var(--bg-tertiary);
		cursor: row-resize;
		flex-shrink: 0;
		transition: background 0.2s;
	}

	.panel-divider:hover {
		background: var(--button-border);
	}

	/* Graph area */
	.graph-area {
		flex: 1;
		padding: 1rem;
		overflow: hidden;
		display: flex;
	}

	.loading {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		text-align: center;
		color: var(--text-primary);
	}

	.loading p {
		margin: 0.5rem 0;
	}

	.hint {
		color: var(--text-secondary);
		font-size: 0.9em;
		max-width: 500px;
	}
</style>

<script lang="ts">
	import Place from './Place.svelte';
	import Transition from './Transition.svelte';
	import Edge from './Edge.svelte';
	import Token from './Token.svelte';
	import AnimatingToken from './AnimatingToken.svelte';
	import type { GraphState, Token as TokenType } from '$lib/types';

	type AnimationStage = 'idle' | 'consuming' | 'producing';

	export let graphState: GraphState | null;
	export let tokens: TokenType[] = [];
	export let animationStage: AnimationStage = 'idle';
	export let consumingTokens: TokenType[] = [];
	export let producingTokens: TokenType[] = [];
	export let transitionPosition: { x: number; y: number } | null = null;
	export let firingTransitionId: string | null = null;
	export let activeEdgeIds: Set<string> = new Set();
	export let selectedTokenId: string | null = null;
	export let onTokenSelect: ((tokenId: string | null) => void) | null = null;

	let viewBox = '0 0 1000 800';
	let scale = 1;
	let panX = 0;
	let panY = 0;
	let svgElement: SVGSVGElement;

	// Drag state
	let isDragging = false;
	let dragStartX = 0;
	let dragStartY = 0;
	let dragStartPanX = 0;
	let dragStartPanY = 0;

	function handleWheel(event: WheelEvent) {
		event.preventDefault();

		// Reduced sensitivity: 2.5% per scroll instead of 10%
		const delta = event.deltaY > 0 ? 0.975 : 1.025;

		// Get mouse position in SVG viewport coordinates
		const rect = svgElement.getBoundingClientRect();
		const mouseX = event.clientX - rect.left;
		const mouseY = event.clientY - rect.top;

		// Convert mouse position to SVG world coordinates (before zoom)
		const worldX = panX + (mouseX / rect.width) * (1000 / scale);
		const worldY = panY + (mouseY / rect.height) * (800 / scale);

		// Apply zoom
		const oldScale = scale;
		scale *= delta;

		// Adjust pan so the same world point stays under the mouse cursor
		const newWidth = 1000 / scale;
		const newHeight = 800 / scale;

		panX = worldX - (mouseX / rect.width) * newWidth;
		panY = worldY - (mouseY / rect.height) * newHeight;

		updateViewBox();
	}

	function handleMouseDown(event: MouseEvent) {
		if (event.button !== 0) return; // Only left-click
		isDragging = true;
		dragStartX = event.clientX;
		dragStartY = event.clientY;
		dragStartPanX = panX;
		dragStartPanY = panY;
	}

	function handleSvgClick(event: MouseEvent) {
		// Only clear selection if clicking directly on the SVG background
		// (not on a token or other element)
		if (event.target === svgElement && onTokenSelect) {
			onTokenSelect(null);
		}
	}

	function handleTokenSelect(tokenId: string) {
		if (onTokenSelect) {
			onTokenSelect(tokenId);
		}
	}

	function handleMouseMove(event: MouseEvent) {
		if (!isDragging) return;

		const rect = svgElement.getBoundingClientRect();
		const dx = event.clientX - dragStartX;
		const dy = event.clientY - dragStartY;

		// Convert screen-space delta to SVG world-space delta
		const worldDx = (dx / rect.width) * (1000 / scale);
		const worldDy = (dy / rect.height) * (800 / scale);

		panX = dragStartPanX - worldDx;
		panY = dragStartPanY - worldDy;

		updateViewBox();
	}

	function handleMouseUp(event: MouseEvent) {
		if (event.button !== 0) return; // Only left-click
		isDragging = false;
	}

	function resetZoom() {
		scale = 1;
		updateViewBox();
	}

	function centerView() {
		panX = 0;
		panY = 0;
		updateViewBox();
	}

	function updateViewBox() {
		viewBox = `${panX} ${panY} ${1000 / scale} ${800 / scale}`;
	}

	$: if (graphState) {
		updateViewBox();
	}
</script>

<svelte:window on:mousemove={handleMouseMove} on:mouseup={handleMouseUp} />

<div class="graph-container">
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<svg
		bind:this={svgElement}
		{viewBox}
		on:wheel={handleWheel}
		on:mousedown={handleMouseDown}
		on:click={handleSvgClick}
		class="petri-net"
		class:dragging={isDragging}
	>
		<defs>
			<!-- Arrowhead markers - edges now end at node borders, so tip at line endpoint -->
			<marker
				id="arrowhead-input"
				viewBox="0 0 12 12"
				markerWidth="8"
				markerHeight="8"
				refX="12"
				refY="6"
				orient="auto"
			>
				<path d="M0,0 L0,12 L12,6 z" class="arrowhead-input-path" />
			</marker>
			<marker
				id="arrowhead-output"
				viewBox="0 0 12 12"
				markerWidth="8"
				markerHeight="8"
				refX="12"
				refY="6"
				orient="auto"
			>
				<path d="M0,0 L0,12 L12,6 z" class="arrowhead-output-path" />
			</marker>
		</defs>

		{#if graphState}
			<!-- Edges layer -->
			<g class="edges">
				{#each graphState.edges as edge (edge.id)}
					<Edge {...edge} {graphState} isActive={activeEdgeIds.has(edge.id)} />
				{/each}
			</g>

			<!-- Places layer -->
			<g class="places">
				{#each graphState.places as place (place.id)}
					<Place {...place} />
				{/each}
			</g>

			<!-- Transitions layer -->
			<g class="transitions">
				{#each graphState.transitions as transition (transition.id)}
					<Transition {...transition} isFiring={transition.id === firingTransitionId} />
				{/each}
			</g>

			<!-- Tokens layer -->
			<g class="tokens">
				{#if animationStage === 'idle'}
					<!-- Normal state: show all tokens -->
					{#each tokens as token (token.id)}
						<Token
							{...token}
							animating={false}
							isSelected={token.id === selectedTokenId}
							onSelect={handleTokenSelect}
						/>
					{/each}
				{:else}
					<!-- During animation: hide consumed tokens, show static tokens -->
					{#each tokens as token (token.id)}
						{#if !consumingTokens.find(t => t.id === token.id)}
							<Token
								{...token}
								animating={false}
								isSelected={token.id === selectedTokenId}
								onSelect={handleTokenSelect}
							/>
						{/if}
					{/each}
				{/if}

				<!-- Consuming tokens animation (Stage 1) -->
				{#if animationStage === 'consuming' && transitionPosition}
					{#each consumingTokens as token (token.id)}
						<AnimatingToken
							{...token}
							targetX={transitionPosition.x}
							targetY={transitionPosition.y}
							duration={300}
							fadeOut={true}
						/>
					{/each}
				{/if}

				<!-- Producing tokens animation (Stage 2) -->
				{#if animationStage === 'producing' && transitionPosition}
					{#each producingTokens as token (token.id)}
						<AnimatingToken
							startX={transitionPosition.x}
							startY={transitionPosition.y}
							targetX={token.x}
							targetY={token.y}
							color={token.color}
							id={token.id}
							duration={300}
							fadeOut={false}
						/>
					{/each}
				{/if}
			</g>
		{/if}
	</svg>

	<div class="controls">
		<button on:click={resetZoom}>Reset Zoom</button>
		<button on:click={centerView}>Center</button>
	</div>
</div>

<style>
	.graph-container {
		flex: 1;
		position: relative;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--graph-bg);
		overflow: hidden;
	}

	svg {
		width: 100%;
		height: 100%;
		cursor: grab;
	}

	svg.dragging {
		cursor: grabbing;
	}

	.controls {
		position: absolute;
		top: 10px;
		right: 10px;
		display: flex;
		gap: 0.5rem;
	}

	button {
		padding: 0.5rem 1rem;
		background: var(--bg-secondary);
		border: 1px solid var(--border-color);
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9em;
		color: var(--text-primary);
	}

	button:hover {
		background: var(--bg-hover);
	}

	:global(.arrowhead-input-path) {
		fill: var(--edge-input);
	}

	:global(.arrowhead-output-path) {
		fill: var(--edge-output);
	}
</style>

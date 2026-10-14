<script lang="ts">
	import PlaceCircle from './PlaceCircle.svelte';
	import PlaceText from './PlaceText.svelte';
	import Transition from './Transition.svelte';
	import Edge from './Edge.svelte';
	import Token from './Token.svelte';
	import AnimatingToken from './AnimatingToken.svelte';
	import { TOKEN_STAGE_MS } from '$lib/tokenAnimation';
	import { frameView, type NetLayout } from '$lib/layout';
	import type { DrawnNet, DrawnToken } from '$lib/netView';
	import type { TokenCue } from '$lib/firingPlayback';

	/** What to draw, already at the positions `layout` gave it. */
	export let graph: DrawnNet | null;
	/** The layout `graph` was placed with: a new one (a new topology)
	 *  reframes the view. */
	export let layout: NetLayout | null = null;
	/** The token dots at rest. */
	export let tokens: DrawnToken[] = [];
	/** Tokens on their way to a place, not drawn there until they land. */
	export let hiddenTokenIds: Set<string> = new Set();
	/** Tokens travelling now, between a place and a transition. */
	export let travelling: TokenCue[] = [];
	/** Edges a token is travelling along, by `DrawnEdge.ends`. */
	export let activeEdges: Set<string> = new Set();
	/** Transitions tokens are travelling to or from. */
	export let firingTransitions: Set<string> = new Set();
	/** Transitions whose body just failed. */
	export let failingTransitions: Set<string> = new Set();
	export let selectedTokenId: string | null = null;
	export let onTokenSelect: ((tokenId: string | null) => void) | null = null;
	/** A double click on a token: open the net it holds. */
	export let onTokenOpen: ((tokenId: string) => void) | null = null;
	export let selectedTransitionId: string | null = null;
	export let onTransitionSelect: ((transitionId: string | null) => void) | null = null;

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
		if (event.target === svgElement) {
			if (onTokenSelect) onTokenSelect(null);
			if (onTransitionSelect) onTransitionSelect(null);
		}
	}

	function handleTokenSelect(tokenId: string) {
		if (onTokenSelect) {
			onTokenSelect(tokenId);
		}
	}

	function handleTransitionSelect(transitionId: string) {
		if (onTransitionSelect) {
			onTransitionSelect(transitionId);
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

	// The view onto the drawing: centred when it fits, else from its top.
	function centerView() {
		const corner = frameView(layout?.extent ?? null, 1000 / scale, 800 / scale);
		panX = corner.x;
		panY = corner.y;
		updateViewBox();
	}

	let framedLayout: NetLayout | null = null;
	$: if (layout !== framedLayout) {
		framedLayout = layout;
		centerView();
	}

	function updateViewBox() {
		viewBox = `${panX} ${panY} ${1000 / scale} ${800 / scale}`;
	}

	$: if (graph) {
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
			<!-- The hollow head of an input edge that accepts an empty place
			     (`drain`, `survey`): an outline in the edge's colour, filled with
			     the graph's background so the line does not show through, and
			     inset by half its stroke so its tip sits where a filled head's
			     does. Markers do not inherit the edge's dashes. -->
			<marker
				id="arrowhead-input-hollow"
				viewBox="0 0 12 12"
				markerWidth="8"
				markerHeight="8"
				refX="12"
				refY="6"
				orient="auto"
			>
				<path d="M0.75,0.75 L0.75,11.25 L11.25,6 z" class="arrowhead-input-hollow-path" />
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
			<!-- Scrim behind a place's token counter. The node's own fill colour
			     fading to fully transparent before the circle edge, so the number
			     reads clearly over the dots without drawing a visible disc: the
			     eye moves from counting dots to reading the count with nothing
			     hard to cross. -->
			<radialGradient id="token-count-scrim">
				<stop offset="0%" stop-color="var(--place-fill)" stop-opacity="0.92" />
				<stop offset="55%" stop-color="var(--place-fill)" stop-opacity="0.78" />
				<stop offset="100%" stop-color="var(--place-fill)" stop-opacity="0" />
			</radialGradient>
		</defs>

		{#if graph}
			<!-- Edges layer -->
			<g class="edges">
				{#each graph.edges as edge (edge.key)}
					<Edge
						from={edge.from}
						to={edge.to}
						fromShape={edge.fromShape}
						toShape={edge.toShape}
						direction={edge.direction}
						stroke={edge.stroke}
						head={edge.head}
						isActive={activeEdges.has(edge.ends)}
						isBack={edge.back}
						config={layout?.config}
					/>
				{/each}
			</g>

			<!-- Place circles layer (background) -->
			<g class="place-circles">
				{#each graph.places as place (place.name)}
					<PlaceCircle name={place.name} x={place.x} y={place.y} />
				{/each}
			</g>

			<!-- Tokens layer (on top of place circles, below place text) -->
			<g class="tokens">
				{#each tokens as token (token.id)}
					{#if !hiddenTokenIds.has(token.id)}
						<Token
							id={token.id}
							x={token.x}
							y={token.y}
							color={token.color}
							animating={false}
							isSelected={token.id === selectedTokenId}
							onSelect={handleTokenSelect}
							badge={token.badge}
							onOpen={onTokenOpen}
						/>
					{/if}
				{/each}

				<!-- Tokens travelling between places and transitions -->
				{#each travelling as cue (cue.key)}
					<AnimatingToken
						id={cue.id}
						startX={cue.from.x}
						startY={cue.from.y}
						targetX={cue.to.x}
						targetY={cue.to.y}
						color={cue.color ?? '#9ca3af'}
						duration={Math.max(0, cue.endsAt - cue.startAt) || TOKEN_STAGE_MS}
						fadeOut={cue.fade === 'out'}
					/>
				{/each}
			</g>

			<!-- Place text layer (rendered after tokens so text appears on top) -->
			<g class="place-texts">
				{#each graph.places as place (place.name)}
					<PlaceText name={place.name} x={place.x} y={place.y} type_name={place.type_name} count={place.count} matching={place.matching} />
				{/each}
			</g>

			<!-- Badges of tokens that hold nets: the total count of their nets,
			     at the token's top right, above the place labels. -->
			<g class="token-badges" pointer-events="none">
				{#each tokens as token (token.id)}
					{#if token.badge !== null && !hiddenTokenIds.has(token.id)}
						<g class="token-badge" data-token-badge={token.id}>
							<circle cx={token.x + 8} cy={token.y - 8} r={7.5} fill="var(--token-badge-fill)" stroke="var(--place-fill)" stroke-width="1.5" />
							<text
								x={token.x + 8}
								y={token.y - 8}
								text-anchor="middle"
								dominant-baseline="central"
								font-size={token.badge.length > 2 ? 6 : 9}
								font-weight="bold"
								fill="var(--token-badge-text)">{token.badge}</text>
						</g>
					{/if}
				{/each}
			</g>

			<!-- Transitions layer -->
			<g class="transitions">
				{#each graph.transitions as transition (transition.name)}
					<Transition
						name={transition.name}
						x={transition.x}
						y={transition.y}
						subtitle={transition.subtitle}
						look={transition.look}
						isFiring={firingTransitions.has(transition.name)}
						isFailing={failingTransitions.has(transition.name)}
						isSelected={transition.name === selectedTransitionId}
						onSelect={handleTransitionSelect}
					/>
				{/each}
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

	:global(.arrowhead-input-hollow-path) {
		fill: var(--graph-bg);
		stroke: var(--edge-input);
		stroke-width: 1.5;
		stroke-linejoin: round;
		stroke-dasharray: none;
	}

	:global(.arrowhead-output-path) {
		fill: var(--edge-output);
	}
</style>

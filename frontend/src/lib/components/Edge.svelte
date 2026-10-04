<script lang="ts">
	import type { GraphState } from '$lib/types';
	import { DEFAULT_LAYOUT_CONFIG, backEdgeControl, type LayoutConfig } from '$lib/layout';

	export let source: string;
	export let target: string;
	export let type: 'input' | 'output';
	export let graphState: GraphState;
	export let isActive: boolean = false;
	/** A back edge, set aside by the layout to break a cycle: drawn as a
	 *  curve bowing out to the side, as the Bevy view draws it. */
	export let isBack: boolean = false;
	export let config: LayoutConfig = DEFAULT_LAYOUT_CONFIG;

	// Node dimensions (must match Place.svelte and Transition.svelte)
	$: PLACE_RADIUS = config.placeRadius;
	$: TRANSITION_WIDTH = config.transitionWidth;
	$: TRANSITION_HEIGHT = config.transitionHeight;

	// Find nodes and determine their types
	$: sourcePlace = graphState.places.find((p) => p.id === source);
	$: sourceTransition = graphState.transitions.find((t) => t.id === source);
	$: targetPlace = graphState.places.find((p) => p.id === target);
	$: targetTransition = graphState.transitions.find((t) => t.id === target);

	$: sourceNode = sourcePlace || sourceTransition;
	$: targetNode = targetPlace || targetTransition;

	// Center coordinates
	$: cx1 = sourceNode?.x || 0;
	$: cy1 = sourceNode?.y || 0;
	$: cx2 = targetNode?.x || 0;
	$: cy2 = targetNode?.y || 0;

	// Compute intersection with circle (for Place nodes)
	function circleIntersection(
		cx: number, cy: number, radius: number,
		fromX: number, fromY: number, toX: number, toY: number
	): { x: number; y: number } {
		const dx = toX - fromX;
		const dy = toY - fromY;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len === 0) return { x: cx, y: cy };

		// Unit vector from source to target
		const ux = dx / len;
		const uy = dy / len;

		// Intersection point on circle edge (from center towards source)
		return {
			x: cx - ux * radius,
			y: cy - uy * radius
		};
	}

	// Compute intersection with rectangle (for Transition nodes)
	function rectIntersection(
		cx: number, cy: number, width: number, height: number,
		fromX: number, fromY: number, toX: number, toY: number
	): { x: number; y: number } {
		const halfW = width / 2;
		const halfH = height / 2;

		const dx = fromX - cx;
		const dy = fromY - cy;

		if (dx === 0 && dy === 0) return { x: cx, y: cy };

		// Calculate intersection with rectangle edges
		// Scale factors to reach each edge
		const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
		const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;

		// Use the smaller scale (first edge hit)
		const scale = Math.min(scaleX, scaleY);

		return {
			x: cx + dx * scale,
			y: cy + dy * scale
		};
	}

	// A back edge's curve passes near this point; a straight edge aims each
	// end at the other node's centre, a curved one at the control point.
	$: control = isBack ? backEdgeControl({ x: cx1, y: cy1 }, { x: cx2, y: cy2 }, config) : null;
	$: aimStart = control ?? { x: cx2, y: cy2 };
	$: aimEnd = control ?? { x: cx1, y: cy1 };

	// Compute edge endpoints at node borders
	$: edgeStart = sourcePlace
		? circleIntersection(cx1, cy1, PLACE_RADIUS, aimStart.x, aimStart.y, cx1, cy1)
		: sourceTransition
			? rectIntersection(cx1, cy1, TRANSITION_WIDTH, TRANSITION_HEIGHT, aimStart.x, aimStart.y, cx1, cy1)
			: { x: cx1, y: cy1 };

	$: edgeEnd = targetPlace
		? circleIntersection(cx2, cy2, PLACE_RADIUS, aimEnd.x, aimEnd.y, cx2, cy2)
		: targetTransition
			? rectIntersection(cx2, cy2, TRANSITION_WIDTH, TRANSITION_HEIGHT, aimEnd.x, aimEnd.y, cx2, cy2)
			: { x: cx2, y: cy2 };

	$: x1 = edgeStart.x;
	$: y1 = edgeStart.y;
	$: x2 = edgeEnd.x;
	$: y2 = edgeEnd.y;
</script>

{#if control}
	<path
		d="M {x1} {y1} Q {control.x} {control.y} {x2} {y2}"
		fill="none"
		stroke={isActive ? '#00ff00' : (type === 'input' ? 'var(--edge-input)' : 'var(--edge-output)')}
		stroke-width="2"
		marker-end={type === 'input' ? 'url(#arrowhead-input)' : 'url(#arrowhead-output)'}
		class="edge back"
		class:input={type === 'input'}
		class:output={type === 'output'}
		class:active={isActive}
		data-back-edge="true"
	/>
{:else}
	<line
		x1={x1}
		y1={y1}
		x2={x2}
		y2={y2}
		stroke={isActive ? '#00ff00' : (type === 'input' ? 'var(--edge-input)' : 'var(--edge-output)')}
		stroke-width="2"
		marker-end={type === 'input' ? 'url(#arrowhead-input)' : 'url(#arrowhead-output)'}
		class="edge"
		class:input={type === 'input'}
		class:output={type === 'output'}
		class:active={isActive}
	/>
{/if}

<style>
	.edge {
		stroke-dasharray: none;
		transition: stroke 0.15s;
	}

	.edge.active {
		stroke: #00ff00;
	}
</style>

<script lang="ts">
	import type { GraphState } from '$lib/types';

	export let source: string;
	export let target: string;
	export let type: 'input' | 'output';
	export let graphState: GraphState;
	export let isActive: boolean = false;

	// Node dimensions (must match Place.svelte and Transition.svelte)
	const PLACE_RADIUS = 30;
	const TRANSITION_WIDTH = 80;
	const TRANSITION_HEIGHT = 50;

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

	// Compute edge endpoints at node borders
	$: edgeStart = sourcePlace
		? circleIntersection(cx1, cy1, PLACE_RADIUS, cx2, cy2, cx1, cy1)
		: sourceTransition
			? rectIntersection(cx1, cy1, TRANSITION_WIDTH, TRANSITION_HEIGHT, cx2, cy2, cx1, cy1)
			: { x: cx1, y: cy1 };

	$: edgeEnd = targetPlace
		? circleIntersection(cx2, cy2, PLACE_RADIUS, cx1, cy1, cx2, cy2)
		: targetTransition
			? rectIntersection(cx2, cy2, TRANSITION_WIDTH, TRANSITION_HEIGHT, cx1, cy1, cx2, cy2)
			: { x: cx2, y: cy2 };

	$: x1 = edgeStart.x;
	$: y1 = edgeStart.y;
	$: x2 = edgeEnd.x;
	$: y2 = edgeEnd.y;
</script>

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

<style>
	.edge {
		stroke-dasharray: none;
		transition: stroke 0.15s;
	}

	.edge.active {
		stroke: #00ff00;
	}
</style>

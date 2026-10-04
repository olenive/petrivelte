/**
 * The bridge between the page's graph state and `layout.ts`: the version 0
 * wire shape goes in, the server's `x` and `y` are ignored, and the places
 * and transitions come out at the positions the layout computes. Slice 3
 * replaces the wire shape; `layout.ts` stays as it is.
 */
import type { GraphState } from '$lib/types';
import { computeLayout, topologyKey, type LayoutInput, type NetLayout } from '$lib/layout';

/** The layout's neutral input, read off a graph state. Nodes are keyed by
 *  id, which is what the edges name. */
export function layoutInputOf(state: GraphState): LayoutInput {
	return {
		places: (state.places ?? []).map((p) => p.id),
		transitions: (state.transitions ?? []).map((t) => t.id),
		edges: (state.edges ?? []).map((e) => ({ from: e.source, to: e.target })),
	};
}

/** A computed layout and the topology it was computed for. */
export interface KeyedLayout {
	key: string;
	layout: NetLayout;
}

/**
 * The layout for `state`: `previous` again if the topology is unchanged (a
 * marking update), a fresh one otherwise.
 */
export function layoutFor(state: GraphState, previous: KeyedLayout | null): KeyedLayout {
	const input = layoutInputOf(state);
	const key = topologyKey(input);
	return previous && previous.key === key ? previous : { key, layout: computeLayout(input) };
}

/** `state` with every place and transition moved to where `layout` put it. */
export function placeGraphState(state: GraphState, layout: NetLayout): GraphState {
	const move = <N extends { id: string; x: number; y: number }>(node: N): N => {
		const at = layout.placements.get(node.id);
		return at ? { ...node, x: at.x, y: at.y } : node;
	};
	return {
		...state,
		places: (state.places ?? []).map(move),
		transitions: (state.transitions ?? []).map(move),
	};
}

/**
 * The bridge between the protocol's topology (§5.1) and `layout.ts`: places,
 * transitions and directed edges go in, with the position hints as pins when
 * the topology has them, and the layout's placements come out. Read edges
 * (`snapshot`, `mutate`) take part like any other: they are part of the net.
 */
import type { Topology } from '$lib/types';
import { computeLayout, topologyKey, type LayoutInput, type NetLayout } from '$lib/layout';

/** The layout's neutral input, read off a topology. An `in` edge runs from
 *  its place to its transition, an `out` edge the other way. */
export function layoutInputOf(topology: Topology): LayoutInput {
	const pinned = topology.hints?.positions;
	return {
		places: (topology.places ?? []).map((p) => p.name),
		transitions: (topology.transitions ?? []).map((t) => t.name),
		edges: (topology.edges ?? []).map((e) =>
			e.direction === 'out' ? { from: e.transition, to: e.place } : { from: e.place, to: e.transition },
		),
		...(pinned && Object.keys(pinned).length > 0 ? { pinned } : {}),
	};
}

/** A computed layout and the topology it was computed for. */
export interface KeyedLayout {
	key: string;
	layout: NetLayout;
}

/**
 * The layout for `topology`: `previous` again if the topology is unchanged
 * (a refetch of the same generation), a fresh one otherwise.
 */
export function layoutFor(topology: Topology, previous: KeyedLayout | null): KeyedLayout {
	const input = layoutInputOf(topology);
	const key = topologyKey(input);
	return previous && previous.key === key ? previous : { key, layout: computeLayout(input) };
}

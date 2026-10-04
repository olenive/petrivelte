/**
 * What the graph panel draws, read off the marking mirror and the layout:
 * places with their true counts, transitions with their state, edges by
 * their endpoints, and the token dots of each place's first slots.
 */

import type { NetLayout } from '$lib/layout';
import type { Mirror } from '$lib/netMirror';
import type { Point, TopologyEdge, TransitionState } from '$lib/types';
import { TOKEN_DOT_MAX, tokenSlotOffset } from '$lib/netHelpers';
import { edgeEnds } from '$lib/firingPlayback';

export interface DrawnPlace {
	name: string;
	type_name: string;
	x: number;
	y: number;
	count: number;
}

/** How a transition is drawn: switched off (grey, dashed), firing now,
 *  able to fire, or none of these. */
export type TransitionLook = 'disabled' | 'in_flight' | 'fireable' | 'idle';

export interface DrawnTransition {
	name: string;
	x: number;
	y: number;
	/** A second line under the name: Python's function name, when given. */
	subtitle: string;
	look: TransitionLook;
}

/** An edge's stroke: read edges are drawn dashed (`snapshot`) and dotted
 *  (`mutate`), as the Bevy and Graphviz renderers draw them. */
export type EdgeStroke = 'solid' | 'dashed' | 'dotted';

export interface DrawnEdge {
	/** Unique per edge: its endpoints, direction, kind and slot. */
	key: string;
	/** Its endpoints and direction, as the animation names an edge. */
	ends: string;
	direction: 'in' | 'out';
	stroke: EdgeStroke;
	from: Point;
	to: Point;
	fromShape: 'place' | 'transition';
	toShape: 'place' | 'transition';
	/** Set aside by the layout to break a cycle: drawn curved. */
	back: boolean;
}

export interface DrawnToken {
	id: string;
	place: string;
	x: number;
	y: number;
	color: string;
}

export interface DrawnNet {
	places: DrawnPlace[];
	transitions: DrawnTransition[];
	edges: DrawnEdge[];
}

const DEFAULT_TOKEN_COLOR = '#9ca3af';

export function edgeKey(edge: TopologyEdge): string {
	return [edge.direction, edge.place, edge.transition, edge.kind ?? '', edge.slot ?? ''].join('|');
}

export function edgeStroke(edge: TopologyEdge): EdgeStroke {
	if (edge.direction !== 'in') return 'solid';
	if (edge.kind === 'snapshot') return 'dashed';
	if (edge.kind === 'mutate') return 'dotted';
	return 'solid';
}

export function transitionLook(state: TransitionState | undefined): TransitionLook {
	if (!state) return 'idle';
	if (!state.enabled) return 'disabled';
	if (state.in_flight) return 'in_flight';
	if (state.fireable) return 'fireable';
	return 'idle';
}

function at(layout: NetLayout, name: string): Point | null {
	const placement = layout.placements.get(name);
	return placement ? { x: placement.x, y: placement.y } : null;
}

/** Where the token in `slot` of `place` is drawn: its dot, or the place's
 *  centre for a token without one. */
export function tokenPoint(layout: NetLayout, place: string, slot: number | null): Point | null {
	const centre = at(layout, place);
	if (!centre) return null;
	if (slot === null || slot >= TOKEN_DOT_MAX) return centre;
	const { dx, dy } = tokenSlotOffset(slot);
	return { x: centre.x + dx, y: centre.y + dy };
}

export function drawNet(mirror: Mirror, layout: NetLayout): DrawnNet {
	const places = mirror.topology.places.flatMap((place) => {
		const p = at(layout, place.name);
		return p
			? [{ name: place.name, type_name: place.type_name ?? '', ...p, count: mirror.places[place.name]?.count ?? 0 }]
			: [];
	});
	const transitions = mirror.topology.transitions.flatMap((transition) => {
		const p = at(layout, transition.name);
		const fn = transition.detail?.function_name;
		return p
			? [
					{
						name: transition.name,
						...p,
						subtitle: typeof fn === 'string' && fn !== transition.name ? fn : '',
						look: transitionLook(mirror.transitions[transition.name]),
					},
				]
			: [];
	});
	const backs = new Set(layout.backEdges.map((e) => `${e.from}\u0000${e.to}`));
	const edges = mirror.topology.edges.flatMap((edge) => {
		const place = at(layout, edge.place);
		const transition = at(layout, edge.transition);
		if (!place || !transition || (edge.direction !== 'in' && edge.direction !== 'out')) return [];
		const inward = edge.direction === 'in';
		const [fromName, toName] = inward ? [edge.place, edge.transition] : [edge.transition, edge.place];
		return [
			{
				key: edgeKey(edge),
				ends: edgeEnds(edge.direction, edge.place, edge.transition),
				direction: edge.direction,
				stroke: edgeStroke(edge),
				from: inward ? place : transition,
				to: inward ? transition : place,
				fromShape: inward ? ('place' as const) : ('transition' as const),
				toShape: inward ? ('transition' as const) : ('place' as const),
				back: backs.has(`${fromName}\u0000${toName}`),
			},
		];
	});
	return { places, transitions, edges };
}

/** The dots: each place's first `TOKEN_DOT_MAX` listed tokens, in their
 *  fixed slots. Beyond that the place's counter carries the number. */
export function drawTokens(mirror: Mirror, layout: NetLayout): DrawnToken[] {
	return mirror.topology.places.flatMap((place) =>
		(mirror.places[place.name]?.tokens ?? []).slice(0, TOKEN_DOT_MAX).flatMap((token, slot) => {
			const p = tokenPoint(layout, place.name, slot);
			return p ? [{ id: token.id, place: place.name, ...p, color: token.color ?? DEFAULT_TOKEN_COLOR }] : [];
		}),
	);
}

/**
 * What the graph panel draws, read off the marking mirror and the layout:
 * places with their true counts, transitions with their state, edges by
 * their endpoints, and the token dots of each place's first slots.
 *
 * Under a token filter (`tokenFilter.ts`) a token that does not match is
 * not drawn and its slot stays empty, so the drawn tokens keep the slots the
 * firing animation travels from and to; each place then reads `matching of
 * count`. A token that holds nets carries a badge with their total count.
 *
 * A place with the style `{fill: "token"}` (protocol §5.1) is filled with
 * the colour of its one token while it holds exactly one token and that
 * token has a colour, and with the theme's fill otherwise. The page has no
 * input or output highlight on places during a firing, so nothing else
 * competes with that fill.
 */

import type { NetLayout } from '$lib/layout';
import type { Mirror, MirrorPlace } from '$lib/netMirror';
import type { PlaceStyle, Point, TopologyEdge, TransitionState } from '$lib/types';
import { TOKEN_DOT_MAX, tokenSlotOffset } from '$lib/netHelpers';
import { edgeEnds } from '$lib/firingPlayback';
import { badgeCount, badgeText } from '$lib/innerNets';
import { NO_FILTER, filterCounts, isActive, matchingText, tokenMatches, type TokenFilter } from '$lib/tokenFilter';

export interface DrawnPlace {
	name: string;
	type_name: string;
	x: number;
	y: number;
	count: number;
	/** Under a token filter, `2 of 5` (`2+ of 300` for a lower bound); else null. */
	matching: string | null;
	/** Its style, as the net declares it. */
	style?: PlaceStyle;
	/** The colour it is filled with, by its style; absent for the theme's fill. */
	fill?: string;
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

/** An edge's stroke: read edges are drawn dashed (`snapshot`, `survey`) and
 *  dotted (`mutate`, `mutate_where`), as the Bevy and Graphviz renderers
 *  draw `snapshot` and `mutate`; a `mutate_where` is a mutate edge with a
 *  filter, so it is dotted too. */
export type EdgeStroke = 'solid' | 'dashed' | 'dotted';

/** An edge's arrowhead: hollow for an input edge that accepts an empty
 *  place (`drain`, `survey`), so that it reads apart from `take_all` and
 *  `snapshot`, as the Bevy and Graphviz renderers draw it; filled for the
 *  rest. Chosen apart from the stroke. */
export type EdgeHead = 'filled' | 'hollow';

export interface DrawnEdge {
	/** Unique per edge: its endpoints, direction, kind and slot. */
	key: string;
	/** Its endpoints and direction, as the animation names an edge. */
	ends: string;
	direction: 'in' | 'out';
	stroke: EdgeStroke;
	head: EdgeHead;
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
	/** For a token that holds nets, their total count as the badge reads it. */
	badge: string | null;
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
	if (edge.kind === 'snapshot' || edge.kind === 'survey') return 'dashed';
	if (edge.kind === 'mutate' || edge.kind === 'mutate_where') return 'dotted';
	return 'solid';
}

export function edgeHead(edge: TopologyEdge): EdgeHead {
	if (edge.direction !== 'in') return 'filled';
	if (edge.kind === 'drain' || edge.kind === 'survey') return 'hollow';
	return 'filled';
}

export function transitionLook(state: TransitionState | undefined): TransitionLook {
	if (!state) return 'idle';
	if (!state.enabled) return 'disabled';
	if (state.in_flight) return 'in_flight';
	if (state.fireable) return 'fireable';
	return 'idle';
}

/** The colour a place is filled with by its style (§5.1): its one token's
 *  colour, while the style is `{fill: "token"}`, the place holds exactly
 *  one token and that token has a colour; otherwise none, and the theme's
 *  fill shows. A filter does not change it: it says what the place holds. */
export function placeFill(place: MirrorPlace | undefined): string | undefined {
	if (place?.style?.fill !== 'token' || place.count !== 1 || place.tokens.length !== 1) return undefined;
	const color = place.tokens[0].color;
	return typeof color === 'string' && color ? color : undefined;
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

export function drawNet(mirror: Mirror, layout: NetLayout, filter: TokenFilter = NO_FILTER): DrawnNet {
	const counts = isActive(filter) ? filterCounts(mirror, filter).places : null;
	const places = mirror.topology.places.flatMap((place) => {
		const p = at(layout, place.name);
		const counted = counts?.[place.name];
		const held = mirror.places[place.name];
		const fill = placeFill(held);
		return p
			? [
					{
						name: place.name,
						type_name: place.type_name ?? '',
						...p,
						count: held?.count ?? 0,
						matching: counted ? matchingText(counted) : null,
						...(held?.style ? { style: held.style } : {}),
						...(fill ? { fill } : {}),
					},
				]
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
				head: edgeHead(edge),
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
 *  fixed slots, leaving out those the filter hides. Beyond that the place's
 *  counter carries the number. */
export function drawTokens(mirror: Mirror, layout: NetLayout, filter: TokenFilter = NO_FILTER): DrawnToken[] {
	const filtering = isActive(filter);
	return mirror.topology.places.flatMap((place) =>
		(mirror.places[place.name]?.tokens ?? []).slice(0, TOKEN_DOT_MAX).flatMap((token, slot) => {
			if (filtering && !tokenMatches(filter, token)) return [];
			const p = tokenPoint(layout, place.name, slot);
			const count = badgeCount(token);
			return p
				? [
						{
							id: token.id,
							place: place.name,
							...p,
							color: token.color ?? DEFAULT_TOKEN_COLOR,
							badge: count === null ? null : badgeText(count),
						},
					]
				: [];
		}),
	);
}

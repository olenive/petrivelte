/**
 * What the net drawing module draws, as data: the app's picture of a net
 * (`GraphPanel.svelte` and its children) described as `SvgNode` trees, from
 * the drawing data `netView.ts` produces. Pure; `patch.ts` puts it on the
 * page.
 *
 * The layers come in the panel's order, each a group with a class a host
 * page can style: arcs, place circles, token dots, place labels and counts,
 * the badges of tokens that hold nets, and transitions on top. Geometry,
 * colours and type sizes are the components'; colours are the light
 * theme's (`palette.ts`).
 *
 * A place shows its count when the app's would (from seven tokens), and
 * also whenever the listed tokens fall short of it, which is how a state
 * read without payloads arrives: a count and no tokens, so the number is
 * all there is to show. With token labels on, each dot carries its label
 * as a title (shown on hover) and a place that holds tokens reads its first
 * token's label under the circle, with how many more it holds.
 */

import type { LayoutConfig, NetLayout } from '$lib/layout';
import type { Mirror, MirrorPlace } from '$lib/netMirror';
import {
	drawNet as drawnNet,
	drawTokens,
	type DrawnEdge,
	type DrawnNet,
	type DrawnPlace,
	type DrawnToken,
	type DrawnTransition,
	type EdgeStroke,
	type TransitionLook,
} from '$lib/netView';
import { placeShowsCounter } from '$lib/netHelpers';
import { arcPath } from '$lib/netDraw/arcs';
import { FONT_FAMILY, PALETTE } from '$lib/netDraw/palette';
import { svg, type SvgNode } from '$lib/netDraw/patch';

/** The ids of the markers and the gradient, unique to one drawing so that
 *  several nets on one page never resolve each other's. */
export interface SceneIds {
	arrowInput: string;
	arrowInputHollow: string;
	arrowOutput: string;
	countScrim: string;
}

export function sceneIds(prefix: string): SceneIds {
	return {
		arrowInput: `${prefix}-arrow-input`,
		arrowInputHollow: `${prefix}-arrow-input-hollow`,
		arrowOutput: `${prefix}-arrow-output`,
		countScrim: `${prefix}-count-scrim`,
	};
}

export interface Scene {
	/** The children of the drawing's `<defs>`. */
	defs: SvgNode[];
	/** The children of the drawing's root group, one group per layer. */
	layers: SvgNode[];
	/** What was drawn, as `netView.ts` gave it. */
	drawn: DrawnNet;
}

/** The root group's attributes besides its transform. */
export const ROOT_ATTRS = Object.freeze({ class: 'net-root', 'font-family': FONT_FAMILY });

/** The longest a token label reads under its place before it is cut. */
export const CAPTION_MAX = 20;

const DASH: Record<EdgeStroke, string | undefined> = { solid: undefined, dashed: '8 5', dotted: '2 4' };

interface Look {
	fill: string;
	stroke: string;
	width: number;
	dash?: string;
	text: string;
}

/** A transition's box and name by its look, as `Transition.svelte`'s rules
 *  paint them over its defaults. */
const LOOKS: Record<TransitionLook, Look> = {
	idle: { fill: PALETTE.transitionFill, stroke: PALETTE.transitionStroke, width: 3, text: PALETTE.transitionText },
	disabled: { fill: PALETTE.disabledFill, stroke: PALETTE.disabledStroke, width: 3, dash: '6 4', text: PALETTE.disabledText },
	fireable: { fill: PALETTE.transitionFill, stroke: PALETTE.fireableStroke, width: 4, text: PALETTE.transitionText },
	in_flight: { fill: PALETTE.transitionFill, stroke: PALETTE.inFlightStroke, width: 4, text: PALETTE.transitionText },
};

/** The class a look adds to its transition: `net-transition-in-flight` and the like. */
export function lookClass(look: TransitionLook): string {
	return `net-transition-${look.replace('_', '-')}`;
}

function classes(...names: Array<string | false>): string {
	return names.filter((name) => name !== false).join(' ');
}

/** A label twice over, as the components draw one: an outline in the colour
 *  behind it, then the text, so it reads over arcs and dots. */
function outlined(
	key: string,
	className: string,
	at: { x: number; y: number; size: number; weight?: string },
	text: string,
	outline: string,
	fill: string,
): SvgNode[] {
	const base = { x: at.x, y: at.y, 'text-anchor': 'middle', 'font-size': at.size, 'font-weight': at.weight };
	return [
		svg('text', `${key}-outline`, { ...base, class: `${className} net-outline`, stroke: outline, 'stroke-width': 3, fill: 'none' }, { text }),
		svg('text', key, { ...base, class: className, fill }, { text }),
	];
}

function defsOf(ids: SceneIds): SvgNode[] {
	const marker = (id: string, head: SvgNode) =>
		svg('marker', id, { id, viewBox: '0 0 12 12', markerWidth: 8, markerHeight: 8, refX: 12, refY: 6, orient: 'auto' }, { children: [head] });
	const stop = (offset: string, opacity: number) =>
		svg('stop', offset, { offset, 'stop-color': PALETTE.placeFill, 'stop-opacity': opacity });
	return [
		marker(ids.arrowInput, svg('path', 'head', { class: 'net-arrowhead net-arrowhead-input', d: 'M0,0 L0,12 L12,6 z', fill: PALETTE.edgeInput })),
		// The head of an input arc that accepts an empty place (`drain`,
		// `survey`): an outline filled with the panel's background, inset by
		// half its stroke so its tip sits where a filled head's does.
		marker(
			ids.arrowInputHollow,
			svg('path', 'head', {
				class: 'net-arrowhead net-arrowhead-hollow',
				d: 'M0.75,0.75 L0.75,11.25 L11.25,6 z',
				fill: PALETTE.graphBg,
				stroke: PALETTE.edgeInput,
				'stroke-width': 1.5,
				'stroke-linejoin': 'round',
				'stroke-dasharray': 'none',
			}),
		),
		marker(ids.arrowOutput, svg('path', 'head', { class: 'net-arrowhead net-arrowhead-output', d: 'M0,0 L0,12 L12,6 z', fill: PALETTE.edgeOutput })),
		// Behind a place's count: the place's fill fading out before the
		// circle's edge, so the number reads over the dots.
		svg('radialGradient', ids.countScrim, { id: ids.countScrim }, { children: [stop('0%', 0.92), stop('55%', 0.78), stop('100%', 0)] }),
	];
}

function arcNode(edge: DrawnEdge, config: LayoutConfig, ids: SceneIds): SvgNode {
	const input = edge.direction === 'in';
	const marker = !input ? ids.arrowOutput : edge.head === 'hollow' ? ids.arrowInputHollow : ids.arrowInput;
	return svg('path', edge.key, {
		class: classes('net-arc', input ? 'net-arc-input' : 'net-arc-output', `net-arc-${edge.stroke}`, `net-arc-head-${edge.head}`, edge.back && 'net-arc-back'),
		'data-ends': edge.ends,
		'data-stroke': edge.stroke,
		'data-head': edge.head,
		d: arcPath(edge, config),
		fill: 'none',
		stroke: input ? PALETTE.edgeInput : PALETTE.edgeOutput,
		'stroke-width': 2,
		'stroke-dasharray': DASH[edge.stroke],
		'marker-end': `url(#${marker})`,
	});
}

function placeNode(place: DrawnPlace, config: LayoutConfig): SvgNode {
	return svg(
		'g',
		place.name,
		{ class: classes('net-place', place.fill !== undefined && 'net-place-filled'), 'data-place': place.name, 'data-fill': place.fill },
		{
			children: [
				svg('circle', 'circle', {
					cx: place.x,
					cy: place.y,
					r: config.placeRadius,
					fill: place.fill ?? PALETTE.placeFill,
					stroke: PALETTE.placeStroke,
					'stroke-width': 2,
				}),
			],
		},
	);
}

function tokenNode(token: DrawnToken, label: string | undefined): SvgNode {
	return svg(
		'circle',
		token.id,
		{
			class: 'net-token',
			'data-token': token.id,
			'data-place': token.place,
			'data-holds-nets': token.badge !== null ? 'true' : undefined,
			cx: token.x,
			cy: token.y,
			r: 8,
			fill: token.color,
			stroke: PALETTE.tokenStroke,
			'stroke-width': 2,
		},
		{ children: label ? [svg('title', 'label', {}, { text: label })] : [] },
	);
}

/** What a place's caption reads with token labels on: its first token's
 *  label, cut to `CAPTION_MAX`, and how many more tokens it holds; null for
 *  a place with no labelled token listed. */
export function captionOf(place: MirrorPlace | undefined): string | null {
	const first = place?.tokens[0];
	const label = first?.label?.replace(/\s+/g, ' ').trim();
	if (!place || !label) return null;
	const cut = label.length > CAPTION_MAX ? `${label.slice(0, CAPTION_MAX - 1)}…` : label;
	const more = place.count - 1;
	return more > 0 ? `${cut} +${more}` : cut;
}

/** Whether a place shows its count: from seven tokens, as the app's does,
 *  or whenever its listed tokens fall short of it, so no dot stands for the
 *  rest. */
export function showsCount(count: number, listed: number): boolean {
	return placeShowsCounter(count) || (count > 0 && listed < count);
}

function placeLabelNode(place: DrawnPlace, held: MirrorPlace | undefined, tokenLabels: boolean, ids: SceneIds): SvgNode {
	const { x, y } = place;
	const outline = place.fill ?? PALETTE.placeFill;
	const counted = showsCount(place.count, held?.tokens.length ?? 0);
	const caption = tokenLabels ? captionOf(held) : null;
	const children: SvgNode[] = [
		...(counted ? [svg('circle', 'scrim', { class: 'net-count-scrim', cx: x, cy: y, r: 24, fill: `url(#${ids.countScrim})` })] : []),
		...outlined('name', 'net-place-name', { x, y: y - 15, size: 12, weight: 'bold' }, place.name, outline, PALETTE.placeText),
		...(place.type_name
			? outlined('type', 'net-place-type', { x, y: y - 3, size: 10 }, place.type_name, outline, PALETTE.textSecondary)
			: []),
		...(counted
			? [
					svg(
						'text',
						'count',
						{ class: 'net-count', x, y: y + 14, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 'bold', fill: PALETTE.placeText },
						{ text: String(place.count) },
					),
				]
			: []),
		...(caption ? outlined('caption', 'net-token-label', { x, y: y + 44, size: 11 }, caption, PALETTE.graphBg, PALETTE.placeText) : []),
	];
	return svg('g', place.name, { class: 'net-place-label', 'data-place': place.name, 'data-count': place.count }, { children });
}

function badgeNode(token: DrawnToken, badge: string, ring: string): SvgNode {
	const x = token.x + 8;
	const y = token.y - 8;
	return svg(
		'g',
		token.id,
		{ class: 'net-badge', 'data-token': token.id },
		{
			children: [
				svg('circle', 'ring', { cx: x, cy: y, r: 7.5, fill: PALETTE.badgeFill, stroke: ring, 'stroke-width': 1.5 }),
				svg(
					'text',
					'count',
					{
						x,
						y,
						'text-anchor': 'middle',
						'dominant-baseline': 'central',
						'font-size': badge.length > 2 ? 6 : 9,
						'font-weight': 'bold',
						fill: PALETTE.badgeText,
					},
					{ text: badge },
				),
			],
		},
	);
}

/** In flight: the stroke pulses from opaque to 0.4 and back, ease in and
 *  out, a second each way, as the app's CSS animation does. */
const PULSE = svg('animate', 'pulse', {
	attributeName: 'stroke-opacity',
	values: '1;0.4;1',
	keyTimes: '0;0.5;1',
	calcMode: 'spline',
	keySplines: '0.42 0 0.58 1;0.42 0 0.58 1',
	dur: '2s',
	repeatCount: 'indefinite',
});

function transitionNode(transition: DrawnTransition, config: LayoutConfig): SvgNode {
	const { x, y, subtitle } = transition;
	const look = LOOKS[transition.look];
	const width = config.transitionWidth;
	const height = config.transitionHeight;
	const children: SvgNode[] = [
		svg(
			'rect',
			'box',
			{
				class: 'net-transition-box',
				x: x - width / 2,
				y: y - height / 2,
				width,
				height,
				fill: look.fill,
				stroke: look.stroke,
				'stroke-width': look.width,
				'stroke-dasharray': look.dash,
			},
			{ children: transition.look === 'in_flight' ? [PULSE] : [] },
		),
		...outlined('name', 'net-transition-name', { x, y: subtitle ? y - 10 : y + 4, size: 12, weight: 'bold' }, transition.name, PALETTE.transitionFill, look.text),
		...(subtitle
			? outlined('subtitle', 'net-transition-subtitle', { x, y: y + 12, size: 9 }, subtitle, PALETTE.transitionFill, PALETTE.textSecondary)
			: []),
	];
	return svg(
		'g',
		transition.name,
		{ class: `net-transition ${lookClass(transition.look)}`, 'data-transition': transition.name, 'data-look': transition.look },
		{ children },
	);
}

export interface SceneInput {
	mirror: Mirror;
	layout: NetLayout;
	tokenLabels: boolean;
	ids: SceneIds;
}

export function sceneOf({ mirror, layout, tokenLabels, ids }: SceneInput): Scene {
	const config = layout.config;
	const drawn = drawnNet(mirror, layout);
	const tokens = drawTokens(mirror, layout);
	const labels = new Map(
		tokenLabels ? Object.values(mirror.places).flatMap((place) => place.tokens.map((token) => [token.id, token.label] as const)) : [],
	);
	const fills = new Map(drawn.places.flatMap((place) => (place.fill ? [[place.name, place.fill] as const] : [])));
	const layer = (key: string, children: SvgNode[], extra: Record<string, string> = {}) =>
		svg('g', key, { class: `net-${key}`, ...extra }, { children });
	return {
		defs: defsOf(ids),
		layers: [
			layer('arcs', drawn.edges.map((edge) => arcNode(edge, config, ids))),
			layer('places', drawn.places.map((place) => placeNode(place, config))),
			layer('tokens', tokens.map((token) => tokenNode(token, labels.get(token.id)))),
			layer(
				'place-labels',
				drawn.places.map((place) => placeLabelNode(place, mirror.places[place.name], tokenLabels, ids)),
				{ 'pointer-events': 'none' },
			),
			layer(
				'badges',
				tokens.flatMap((token) => (token.badge === null ? [] : [badgeNode(token, token.badge, fills.get(token.place) ?? PALETTE.placeFill)])),
				{ 'pointer-events': 'none' },
			),
			layer('transitions', drawn.transitions.map((transition) => transitionNode(transition, config))),
		],
		drawn,
	};
}

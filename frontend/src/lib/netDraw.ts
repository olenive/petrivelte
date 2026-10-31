/**
 * The net drawing module: draws a net's state into an `<svg>` element the
 * way the app's graph panel does, with no framework. The public tier
 * vendors its IIFE build to draw shared nets; the app will adopt its ES
 * build in place of the panel's components.
 *
 * `drawNet` lays the net out once per topology and generation, kept per
 * element, and draws or updates places, token dots, counts, badges,
 * transitions and arcs (`netDraw/scene.ts`) in place (`netDraw/patch.ts`).
 * Everything is written as SVG presentation attributes and classes, never
 * as inline styles, scripts or fetches, so it runs under a policy that
 * allows script and style only by nonce. Nothing reads a size from the
 * layout engine: positions come from the layout, sizes from the options or
 * the element's attributes.
 */

import { layoutFor, type KeyedLayout } from '$lib/graphLayout';
import { frameView } from '$lib/layout';
import { mirrorFromState } from '$lib/netMirror';
import type { NetState } from '$lib/types';
import { SVG_NS, patch } from '$lib/netDraw/patch';
import { ROOT_ATTRS, sceneIds, sceneOf, type SceneIds } from '$lib/netDraw/scene';
import { IDENTITY, installPanZoom, transformText, viewBoxText, type ViewBox, type ViewTransform } from '$lib/netDraw/panZoom';

export interface DrawOptions {
	/** Show token labels. Default: true when any place of the state carries a non-empty tokens array, false otherwise (then a place shows its count, as the app's badge does). */
	tokenLabels?: boolean;
	/** Pan by pointer drag and zoom by wheel, installed on the first call for an element. Default true. */
	interactive?: boolean;
	/** The frame the drawing is fitted into, in SVG user units; default: the svg's width and height attributes, else 800 by 500. */
	width?: number;
	height?: number;
}

export interface DrawSummary {
	places: number;
	transitions: number;
	edges: number;
	relaidOut: boolean;
}

/** The frame when neither the options nor the element give one. */
const DEFAULT_FRAME = Object.freeze({ width: 800, height: 500 });

/** What the module keeps for an element it has drawn into. */
interface Held {
	generation: number;
	keyed: KeyedLayout;
	defs: Element;
	root: Element;
	ids: SceneIds;
	view: ViewBox;
	transform: ViewTransform;
	interactive: boolean;
	/** Stops pan and zoom; a no-op while they are off. */
	detach: () => void;
}

const drawings = new WeakMap<SVGSVGElement, Held>();

const NO_OP = () => {};

/** The attribute marking the module's own children of the svg. */
const OWN = 'data-net-view';

/** Whether any place of the state lists a token: then labels are there to show. */
function carriesTokens(state: NetState): boolean {
	return Object.values(state.marking?.places ?? {}).some((place) => Array.isArray(place?.tokens) && place.tokens.length > 0);
}

/** A length from the options, else from the element's attribute when it is
 *  a plain number of user units or pixels, else the default. */
function dimension(given: number | undefined, attribute: string | null, fallback: number): number {
	if (given !== undefined && Number.isFinite(given) && given > 0) return given;
	const plain = attribute !== null && /^\s*\d+(\.\d+)?(px)?\s*$/.test(attribute) ? parseFloat(attribute) : NaN;
	return plain > 0 ? plain : fallback;
}

function setIfChanged(element: Element, name: string, value: string): void {
	if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** The `<defs>` and root group of a fresh drawing, any left by a drawing
 *  the module has forgotten removed first. */
function freshParts(svg: SVGSVGElement): { defs: Element; root: Element; ids: SceneIds } {
	for (const child of Array.from(svg.children)) {
		if (child.hasAttribute(OWN)) child.remove();
	}
	const doc = svg.ownerDocument;
	const defs = doc.createElementNS(SVG_NS, 'defs');
	defs.setAttribute(OWN, 'defs');
	defs.setAttribute('class', 'net-defs');
	const root = doc.createElementNS(SVG_NS, 'g');
	root.setAttribute(OWN, 'root');
	svg.append(defs, root);
	return { defs, root, ids: sceneIds(`net-view-${Math.random().toString(36).slice(2, 10)}`) };
}

function applyTransform(svg: SVGSVGElement, transform: ViewTransform): void {
	const held = drawings.get(svg);
	if (!held) return;
	drawings.set(svg, { ...held, transform });
	held.root.setAttribute('transform', transformText(transform));
}

function panZoomOn(svg: SVGSVGElement): () => void {
	return installPanZoom({
		svg,
		view: () => drawings.get(svg)?.view ?? { x: 0, y: 0, ...DEFAULT_FRAME },
		transform: () => drawings.get(svg)?.transform ?? IDENTITY,
		apply: (transform) => applyTransform(svg, transform),
	});
}

/**
 * Draws `state` into `svg`, or brings an earlier drawing up to date in
 * place. The layout is computed on the first call and again only for a new
 * generation or a changed topology, which also resets the pan and zoom.
 */
export function drawNet(svg: SVGSVGElement, state: NetState, options: DrawOptions = {}): DrawSummary {
	const previous = drawings.get(svg) ?? null;
	const mirror = mirrorFromState(state);
	const keyed = layoutFor(mirror.topology, previous?.generation === state.generation ? previous.keyed : null);
	const relaidOut = keyed !== previous?.keyed;
	const attached = previous !== null && previous.root.parentNode === svg && previous.defs.parentNode === svg;
	const parts = attached ? previous : freshParts(svg);

	const width = dimension(options.width, svg.getAttribute('width'), DEFAULT_FRAME.width);
	const height = dimension(options.height, svg.getAttribute('height'), DEFAULT_FRAME.height);
	const corner = frameView(keyed.layout.extent, width, height);
	const view: ViewBox = { x: corner.x, y: corner.y, width, height };
	const transform = previous && !relaidOut ? previous.transform : IDENTITY;

	const scene = sceneOf({
		mirror,
		layout: keyed.layout,
		tokenLabels: options.tokenLabels ?? carriesTokens(state),
		ids: parts.ids,
	});
	setIfChanged(svg, 'viewBox', viewBoxText(view));
	setIfChanged(svg, 'preserveAspectRatio', 'xMidYMid meet');
	for (const [name, value] of Object.entries(ROOT_ATTRS)) setIfChanged(parts.root, name, value);
	setIfChanged(parts.root, 'transform', transformText(transform));
	patch(parts.defs, scene.defs);
	patch(parts.root, scene.layers);

	const interactive = options.interactive ?? true;
	const wasInteractive = previous?.interactive ?? false;
	if (!interactive && wasInteractive) previous?.detach();
	drawings.set(svg, {
		generation: state.generation,
		keyed,
		defs: parts.defs,
		root: parts.root,
		ids: parts.ids,
		view,
		transform,
		interactive,
		detach: interactive ? (wasInteractive && previous ? previous.detach : panZoomOn(svg)) : NO_OP,
	});

	return {
		places: scene.drawn.places.length,
		transitions: scene.drawn.transitions.length,
		edges: scene.drawn.edges.length,
		relaidOut,
	};
}

/** Forget the element: drop its cached layout and remove the pan and zoom listeners. */
export function releaseNet(svg: SVGSVGElement): void {
	drawings.get(svg)?.detach();
	drawings.delete(svg);
}

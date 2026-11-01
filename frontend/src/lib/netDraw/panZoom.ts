/**
 * Pan by pointer drag and zoom by wheel, for a drawing whose root group
 * carries the view's transform. The arithmetic is pure; `installPanZoom`
 * wires it to the element and hands back the function that unwires it.
 *
 * The drawing's `viewBox` stays as framed; panning and zooming move the
 * root group inside it, by `translate(x y) scale(k)`. Zoom keeps the point
 * under the pointer where it is, in steps of 2.5% a wheel notch, as the
 * app's panel does. Nothing here reads a box from layout but the svg's own
 * client rectangle, and an element without one (no layout engine) zooms
 * about the middle of its view.
 */

import { FRAME_MARGIN, type Extent } from '$lib/layout';
import type { Point } from '$lib/types';

export interface ViewTransform {
	x: number;
	y: number;
	k: number;
}

export const IDENTITY: ViewTransform = Object.freeze({ x: 0, y: 0, k: 1 });

/** The drawing's `viewBox`, in user units. */
export interface ViewBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ClientRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export function transformText(t: ViewTransform): string {
	return `translate(${t.x} ${t.y}) scale(${t.k})`;
}

export function viewBoxText(view: ViewBox): string {
	return `${view.x} ${view.y} ${view.width} ${view.height}`;
}

/** How the view box sits on screen under `xMidYMid meet`: pixels per user
 *  unit and the client position of its corner; null for an element with
 *  no size. */
export function screenFit(rect: ClientRect, view: ViewBox): { unit: number; left: number; top: number } | null {
	if (!(rect.width > 0 && rect.height > 0 && view.width > 0 && view.height > 0)) return null;
	const unit = Math.min(rect.width / view.width, rect.height / view.height);
	return {
		unit,
		left: rect.left + (rect.width - view.width * unit) / 2,
		top: rect.top + (rect.height - view.height * unit) / 2,
	};
}

/** The user-space point under a client position; the view's middle for an
 *  element with no size. */
export function userPoint(rect: ClientRect, view: ViewBox, clientX: number, clientY: number): Point {
	const fit = screenFit(rect, view);
	return fit
		? { x: view.x + (clientX - fit.left) / fit.unit, y: view.y + (clientY - fit.top) / fit.unit }
		: { x: view.x + view.width / 2, y: view.y + view.height / 2 };
}

/** Scaled by `factor` about `p`, which stays where it is. */
export function zoomAt(t: ViewTransform, p: Point, factor: number): ViewTransform {
	return { x: p.x - (p.x - t.x) * factor, y: p.y - (p.y - t.y) * factor, k: t.k * factor };
}

/** The extent at scale `k`, its centre at the view's centre. */
function centredTransform(extent: Extent, view: ViewBox, k: number): ViewTransform {
	const centre = { x: (extent.minX + extent.maxX) / 2, y: (extent.minY + extent.maxY) / 2 };
	return { x: view.x + view.width / 2 - k * centre.x, y: view.y + view.height / 2 - k * centre.y, k };
}

/**
 * The transform that shows the whole extent in the view, centred: scaled
 * down, never up, so the extent fits with `margin` on every side, as
 * `frameView` leaves it. A view too small to leave that margin fits the
 * extent edge to edge instead. No extent, nothing to fit: the identity.
 */
export function fitTransform(extent: Extent | null, view: ViewBox, margin = FRAME_MARGIN): ViewTransform {
	if (!extent) return IDENTITY;
	const scale = (inset: number) =>
		Math.min(
			1,
			(view.width - 2 * inset) / Math.max(extent.maxX - extent.minX, 1),
			(view.height - 2 * inset) / Math.max(extent.maxY - extent.minY, 1),
		);
	const withMargin = scale(margin);
	return centredTransform(extent, view, withMargin > 0 ? withMargin : scale(0));
}

/** The floor a `fitFloor` option sets on the fit's scale: 0, no floor, for
 *  none, a value at or below 0 or one that is not a number, and at most 1,
 *  since the fit never scales a net up. */
function floorOf(fitFloor: number | undefined): number {
	return fitFloor !== undefined && fitFloor > 0 ? Math.min(fitFloor, 1) : 0;
}

/**
 * Where a fitted drawing starts: the whole extent as `fitTransform` frames
 * it, unless that needs a scale below the floor `fitFloor` sets; then the
 * extent at the floor's scale, centred on its middle, for the viewer to pan.
 * A net one rank of dozens of places wide stays readable this way, where
 * the whole of it would be drawn too small to read.
 */
export function flooredTransform(extent: Extent | null, view: ViewBox, fitFloor: number | undefined, margin = FRAME_MARGIN): ViewTransform {
	const whole = fitTransform(extent, view, margin);
	const floor = floorOf(fitFloor);
	return extent && whole.k < floor ? centredTransform(extent, view, floor) : whole;
}

export function panBy(t: ViewTransform, dx: number, dy: number): ViewTransform {
	return { ...t, x: t.x + dx, y: t.y + dy };
}

/** One wheel step: out for a scroll down, in for a scroll up, none for a
 *  sideways scroll. */
export function wheelFactor(deltaY: number): number {
	return deltaY > 0 ? 0.975 : deltaY < 0 ? 1.025 : 1;
}

export interface PanZoomHost {
	svg: SVGSVGElement;
	/** The view box and transform as they are now, read at each event. */
	view: () => ViewBox;
	transform: () => ViewTransform;
	apply: (t: ViewTransform) => void;
}

/** Listens for drags and wheels on the drawing; returns the function that
 *  stops listening. Moves and releases are heard on the document, so a
 *  drag that leaves the drawing keeps panning until the button is up. */
export function installPanZoom(host: PanZoomHost): () => void {
	const { svg } = host;
	const doc = svg.ownerDocument;
	let drag: { clientX: number; clientY: number; from: ViewTransform } | null = null;

	const onWheel = (event: WheelEvent) => {
		event.preventDefault();
		const factor = wheelFactor(event.deltaY);
		if (factor === 1) return;
		const p = userPoint(svg.getBoundingClientRect(), host.view(), event.clientX, event.clientY);
		host.apply(zoomAt(host.transform(), p, factor));
	};
	const onDown = (event: PointerEvent) => {
		if (event.button !== 0) return;
		drag = { clientX: event.clientX, clientY: event.clientY, from: host.transform() };
		svg.setAttribute('cursor', 'grabbing');
	};
	const onMove = (event: PointerEvent) => {
		if (!drag) return;
		const unit = screenFit(svg.getBoundingClientRect(), host.view())?.unit ?? 1;
		host.apply(panBy(drag.from, (event.clientX - drag.clientX) / unit, (event.clientY - drag.clientY) / unit));
	};
	const onUp = () => {
		if (!drag) return;
		drag = null;
		svg.setAttribute('cursor', 'grab');
	};

	svg.setAttribute('cursor', 'grab');
	svg.addEventListener('wheel', onWheel, { passive: false });
	svg.addEventListener('pointerdown', onDown);
	doc.addEventListener('pointermove', onMove);
	doc.addEventListener('pointerup', onUp);
	doc.addEventListener('pointercancel', onUp);
	return () => {
		svg.removeEventListener('wheel', onWheel);
		svg.removeEventListener('pointerdown', onDown);
		doc.removeEventListener('pointermove', onMove);
		doc.removeEventListener('pointerup', onUp);
		doc.removeEventListener('pointercancel', onUp);
		svg.removeAttribute('cursor');
	};
}

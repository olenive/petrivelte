/**
 * Where an arc is drawn: from the border of one node to the border of the
 * other, straight, or for a back edge a quadratic curve bowing out to the
 * side through `backEdgeControl`. The same geometry as `Edge.svelte`, as
 * pure functions over the layout's config.
 */

import { backEdgeControl, type LayoutConfig } from '$lib/layout';
import type { Point } from '$lib/types';

export type Shape = 'place' | 'transition';

/** The point on a circle of `radius` round `centre`, on the side facing `toward`. */
export function circleBorder(centre: Point, radius: number, toward: Point): Point {
	const dx = centre.x - toward.x;
	const dy = centre.y - toward.y;
	const len = Math.hypot(dx, dy);
	if (len === 0) return centre;
	return { x: centre.x - (dx / len) * radius, y: centre.y - (dy / len) * radius };
}

/** The point on a `width` by `height` box round `centre`, on the side facing `toward`. */
export function boxBorder(centre: Point, width: number, height: number, toward: Point): Point {
	const dx = toward.x - centre.x;
	const dy = toward.y - centre.y;
	if (dx === 0 && dy === 0) return centre;
	const scaleX = dx !== 0 ? width / 2 / Math.abs(dx) : Infinity;
	const scaleY = dy !== 0 ? height / 2 / Math.abs(dy) : Infinity;
	const scale = Math.min(scaleX, scaleY);
	return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

function border(shape: Shape, centre: Point, toward: Point, config: LayoutConfig): Point {
	return shape === 'place'
		? circleBorder(centre, config.placeRadius, toward)
		: boxBorder(centre, config.transitionWidth, config.transitionHeight, toward);
}

export interface ArcEnds {
	from: Point;
	to: Point;
	fromShape: Shape;
	toShape: Shape;
	back: boolean;
}

/** The path data of an arc: a line between the borders, or for a back edge
 *  a curve whose ends aim at its control point. */
export function arcPath(arc: ArcEnds, config: LayoutConfig): string {
	const control = arc.back ? backEdgeControl(arc.from, arc.to, config) : null;
	const start = border(arc.fromShape, arc.from, control ?? arc.to, config);
	const end = border(arc.toShape, arc.to, control ?? arc.from, config);
	return control
		? `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`
		: `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
}

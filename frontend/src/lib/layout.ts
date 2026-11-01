/**
 * Where the net's places and transitions go: a layered layout in the manner
 * of Graphviz `dot`, computed from the net's edges. A port of the Bevy
 * visualiser's `src/layout.rs`, so that both viewers draw the same net the
 * same way.
 *
 * The net is read as a directed graph, places and transitions being the
 * nodes, and laid out in four passes:
 *
 * 1. **Break cycles.** A depth-first search from the sources, in declaration
 *    order, marks every edge that reaches a node still on the search stack
 *    as a back edge. Back edges are drawn (curved), but ignored for ranking.
 * 2. **Rank.** A node's rank is the longest forward path from a source to
 *    it, so every forward edge points to a strictly higher rank.
 * 3. **Order.** Within a rank, nodes are sorted by the barycentre of their
 *    neighbours in the ranks already placed, sweeping down and then up a few
 *    times to reduce crossings. Ties keep their previous order, so the
 *    result is deterministic.
 * 4. **Coordinates.** Rank along the main axis, order centred along the
 *    cross axis, and the whole drawing centred on the origin.
 *
 * Coordinates are screen coordinates: x grows rightward, y grows downward.
 * There are no dummy nodes for edges spanning several ranks, as in Bevy.
 *
 * Input is neutral, independent of any wire shape: node names in
 * declaration order and `{from, to}` edges between them. Names must be
 * unique across places and transitions; a repeated name is laid out once,
 * where it was first declared.
 *
 * Pinned positions (the protocol's `topology.hints.positions`) are an
 * extension over Bevy: pinned nodes take part in ranking and ordering like
 * any other, then sit exactly where pinned, and the rest of the drawing is
 * translated by the mean offset between the pinned nodes' pins and their
 * computed positions, so it lands around them. The drawing is then not
 * centred on the origin, the pins fixing the frame. Overlaps between pinned
 * and unpinned nodes are not resolved.
 */

export interface Point {
	x: number;
	y: number;
}

export interface LayoutEdge {
	from: string;
	to: string;
}

export interface LayoutInput {
	/** Place names, in declaration order. */
	places: readonly string[];
	/** Transition names, in declaration order. */
	transitions: readonly string[];
	/** Directed edges. An edge naming a node not given is left out. */
	edges: readonly LayoutEdge[];
	/** Nodes that keep the given position. Unknown names are ignored. */
	pinned?: Readonly<Record<string, Point>>;
}

/** Which way the ranks grow. */
export type Direction = 'top-down' | 'left-right';

export interface LayoutConfig {
	direction: Direction;
	/** The distance between neighbouring ranks, along the main axis. */
	rankSep: number;
	/** The distance between neighbours within a rank, along the cross axis. */
	nodeSep: number;
	placeRadius: number;
	transitionWidth: number;
	transitionHeight: number;
}

/**
 * Bevy uses a place radius of 40, transitions of 120 by 50, a rank
 * separation of 150 and a node separation of 180. The page draws places of
 * radius 30 and transitions of 80 by 50 (`Place.svelte`, `Transition.svelte`),
 * so the separations are scaled down to match: 120 between ranks (the old
 * grandalf layout's `yspace`), 160 within a rank, which leaves room for the
 * labels, which are wider than the shapes.
 */
export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = Object.freeze({
	direction: 'top-down',
	rankSep: 120,
	nodeSep: 160,
	placeRadius: 30,
	transitionWidth: 80,
	transitionHeight: 50,
});

/** How many down-and-up barycentre sweeps the ordering pass makes. */
export const SWEEPS = 4;

export type NodeKind = 'place' | 'transition';

export interface Placement {
	kind: NodeKind;
	/** 0 for a source, else one more than the highest forward predecessor's. */
	rank: number;
	/** Its position within the rank, from 0. */
	order: number;
	/** Its centre. */
	x: number;
	y: number;
	pinned: boolean;
}

/** A box: around node centres, or around node shapes. */
export interface Extent {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface NetLayout {
	/** Every node, keyed by name, in declaration order. */
	placements: ReadonlyMap<string, Placement>;
	/** The edges set aside to break cycles, in input order. */
	backEdges: readonly LayoutEdge[];
	/** How many ranks were produced. */
	ranks: number;
	/** The box around every node's shape, or null for an empty net. Labels
	 *  and curved edges are outside it. */
	extent: Extent | null;
	config: LayoutConfig;
}

interface Layers {
	/** The nodes of each rank, in order. */
	layers: number[][];
	/** For each edge, whether it is a back edge. */
	back: boolean[];
	/** Each node's rank. */
	rank: number[];
}

/**
 * Cycle breaking, ranking and ordering over a plain digraph of `n` nodes,
 * where a node's index is its declaration order.
 */
export function layer(n: number, edges: readonly (readonly [number, number])[]): Layers {
	const outEdges: number[][] = Array.from({ length: n }, () => []);
	const hasInput = new Array<boolean>(n).fill(false);
	edges.forEach(([a, b], e) => {
		outEdges[a].push(e);
		hasInput[b] = true;
	});

	// 1. Depth-first search from the sources, then from anything a source
	//    does not reach (a cycle with no way in), in declaration order.
	const NEW = 0;
	const ON_STACK = 1;
	const DONE = 2;
	const mark = new Array<number>(n).fill(NEW);
	const back = new Array<boolean>(edges.length).fill(false);
	const preorder: number[] = [];
	const indices = Array.from({ length: n }, (_, i) => i);
	const roots = [...indices.filter((v) => !hasInput[v]), ...indices];
	for (const root of roots) {
		if (mark[root] !== NEW) continue;
		mark[root] = ON_STACK;
		preorder.push(root);
		const stack: [number, number][] = [[root, 0]];
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			const node = top[0];
			if (top[1] < outEdges[node].length) {
				const e = outEdges[node][top[1]];
				top[1] += 1;
				const target = edges[e][1];
				if (mark[target] === NEW) {
					mark[target] = ON_STACK;
					preorder.push(target);
					stack.push([target, 0]);
				} else if (mark[target] === ON_STACK) {
					back[e] = true;
				}
			} else {
				mark[node] = DONE;
				stack.pop();
			}
		}
	}

	// 2. Longest path over the forward edges, which form a DAG now.
	const indegree = new Array<number>(n).fill(0);
	edges.forEach(([, b], e) => {
		if (!back[e]) indegree[b] += 1;
	});
	const rank = new Array<number>(n).fill(0);
	const queue = indices.filter((v) => indegree[v] === 0);
	for (let head = 0; head < queue.length; head++) {
		const node = queue[head];
		for (const e of outEdges[node]) {
			if (back[e]) continue;
			const target = edges[e][1];
			rank[target] = Math.max(rank[target], rank[node] + 1);
			indegree[target] -= 1;
			if (indegree[target] === 0) queue.push(target);
		}
	}

	// 3. Start from the search's discovery order, then sweep.
	const rankCount = n === 0 ? 0 : Math.max(...rank) + 1;
	const layers: number[][] = Array.from({ length: rankCount }, () => []);
	for (const node of preorder) layers[rank[node]].push(node);
	const neighbours: number[][] = Array.from({ length: n }, () => []);
	edges.forEach(([a, b], e) => {
		if (!back[e]) {
			neighbours[a].push(b);
			neighbours[b].push(a);
		}
	});
	const cross = new Array<number>(n).fill(0);
	for (const l of layers) {
		const last = Math.max(l.length - 1, 0);
		l.forEach((node, i) => {
			cross[node] = i - last / 2;
		});
	}
	for (let sweep = 0; sweep < SWEEPS; sweep++) {
		// Down: each rank by its neighbours above. Up: by those below.
		for (let r = 1; r < rankCount; r++) {
			reorder(layers[r], neighbours, rank, cross, (nr) => nr < r);
		}
		for (let r = rankCount - 2; r >= 0; r--) {
			reorder(layers[r], neighbours, rank, cross, (nr) => nr > r);
		}
	}

	return { layers, back, rank };
}

/**
 * Sorts one rank, in place, by the barycentre of each node's neighbours in
 * the ranks `side` admits, and updates the cross positions to match. A node
 * with no such neighbour keeps its current position as its key; ties keep
 * their current order (`Array.prototype.sort` is stable).
 */
function reorder(
	layerNodes: number[],
	neighbours: readonly number[][],
	rank: readonly number[],
	cross: number[],
	side: (rank: number) => boolean,
): void {
	const key = (node: number): number => {
		const admitted = neighbours[node].filter((m) => side(rank[m]));
		return admitted.length === 0
			? cross[node]
			: admitted.reduce((sum, m) => sum + cross[m], 0) / admitted.length;
	};
	const keyed = layerNodes.map((node) => ({ key: key(node), node }));
	keyed.sort((a, b) => a.key - b.key);
	const last = Math.max(layerNodes.length - 1, 0);
	keyed.forEach(({ node }, i) => {
		layerNodes[i] = node;
		cross[node] = i - last / 2;
	});
}

/** Half the width and height of a node's shape. */
export function halfExtent(kind: NodeKind, config: LayoutConfig): Point {
	return kind === 'place'
		? { x: config.placeRadius, y: config.placeRadius }
		: { x: config.transitionWidth / 2, y: config.transitionHeight / 2 };
}

/** The smallest box around some points, or null for none. */
function bounding(points: readonly Point[]): Extent | null {
	if (points.length === 0) return null;
	return points.reduce<Extent>(
		(r, p) => ({
			minX: Math.min(r.minX, p.x),
			minY: Math.min(r.minY, p.y),
			maxX: Math.max(r.maxX, p.x),
			maxY: Math.max(r.maxY, p.y),
		}),
		{ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
	);
}

/** The box around every placed node's shape, or null for none. */
function shapeExtent(placements: ReadonlyMap<string, Placement>, config: LayoutConfig): Extent | null {
	const corners = [...placements.values()].flatMap((p) => {
		const half = halfExtent(p.kind, config);
		return [
			{ x: p.x - half.x, y: p.y - half.y },
			{ x: p.x + half.x, y: p.y + half.y },
		];
	});
	return bounding(corners);
}

/** Lays out the given places, transitions and edges. Pure and deterministic. */
export function computeLayout(
	input: LayoutInput,
	config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
): NetLayout {
	const nodes: { name: string; kind: NodeKind }[] = [];
	const index = new Map<string, number>();
	const declare = (name: string, kind: NodeKind) => {
		if (index.has(name)) return;
		index.set(name, nodes.length);
		nodes.push({ name, kind });
	};
	input.places.forEach((name) => declare(name, 'place'));
	input.transitions.forEach((name) => declare(name, 'transition'));

	const kept = input.edges.filter((e) => index.has(e.from) && index.has(e.to));
	const indexed = kept.map((e) => [index.get(e.from)!, index.get(e.to)!] as const);
	const { layers, back } = layer(nodes.length, indexed);

	const layered = new Map<number, Placement>();
	layers.forEach((l, rank) => {
		const last = Math.max(l.length - 1, 0);
		l.forEach((node, order) => {
			const main = rank * config.rankSep;
			const cross = (order - last / 2) * config.nodeSep;
			const { x, y } =
				config.direction === 'top-down' ? { x: cross, y: main } : { x: main, y: cross };
			layered.set(node, { kind: nodes[node].kind, rank, order, x, y, pinned: false });
		});
	});

	// Centre on the origin, or, with pins, move the drawing to meet them.
	const pins = Object.entries(input.pinned ?? {}).filter(([name]) => index.has(name));
	const offset = (() => {
		if (pins.length === 0) {
			const centres = bounding([...layered.values()]);
			return centres
				? { x: -(centres.minX + centres.maxX) / 2, y: -(centres.minY + centres.maxY) / 2 }
				: { x: 0, y: 0 };
		}
		const sum = pins.reduce(
			(s, [name, pin]) => {
				const at = layered.get(index.get(name)!)!;
				return { x: s.x + pin.x - at.x, y: s.y + pin.y - at.y };
			},
			{ x: 0, y: 0 },
		);
		return { x: sum.x / pins.length, y: sum.y / pins.length };
	})();
	const pinOf = new Map(pins);

	const placements = new Map<string, Placement>(
		nodes.map(({ name }, i) => {
			const at = layered.get(i)!;
			const pin = pinOf.get(name);
			return [
				name,
				pin
					? { ...at, x: pin.x, y: pin.y, pinned: true }
					: { ...at, x: at.x + offset.x, y: at.y + offset.y },
			];
		}),
	);

	return {
		placements,
		backEdges: kept.filter((_, e) => back[e]).map(({ from, to }) => ({ from, to })),
		ranks: layers.length,
		extent: shapeExtent(placements, config),
		config,
	};
}

/** Whether the edge `from -> to` was set aside to break a cycle. */
export function isBackEdge(layout: NetLayout, from: string, to: string): boolean {
	return layout.backEdges.some((e) => e.from === from && e.to === to);
}

/**
 * A key that changes exactly when the layout's input does: the names in
 * order, the edges and the pins. Markings are not part of it, so a page can
 * recompute only when this changes.
 */
export function topologyKey(input: LayoutInput): string {
	const pins = Object.entries(input.pinned ?? {})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, p]) => [name, p.x, p.y]);
	return JSON.stringify([
		input.places,
		input.transitions,
		input.edges.map((e) => [e.from, e.to]),
		pins,
	]);
}

/**
 * The control point of the quadratic curve a back edge from `a` to `b` is
 * drawn with: it bows out to the side the ranks do not grow toward (right
 * for top-down, down for left-right), as the Bevy view draws it.
 */
export function backEdgeControl(a: Point, b: Point, config: LayoutConfig = DEFAULT_LAYOUT_CONFIG): Point {
	const side = config.direction === 'top-down' ? { x: 1, y: 0 } : { x: 0, y: 1 };
	const bow = 0.8 * config.nodeSep + 0.2 * Math.hypot(b.x - a.x, b.y - a.y);
	return { x: (a.x + b.x) / 2 + side.x * bow, y: (a.y + b.y) / 2 + side.y * bow };
}

/** The room a view leaves between the drawing's extent and its edges. */
export const FRAME_MARGIN = 60;

/**
 * Where to put the top-left corner of a `width` by `height` view onto the
 * drawing: along each axis, centred on the extent if it fits with `margin`
 * on both sides, otherwise starting `margin` before it, so a large net is
 * seen from its first rank.
 */
export function frameView(extent: Extent | null, width: number, height: number, margin = FRAME_MARGIN): Point {
	if (!extent) return { x: -width / 2, y: -height / 2 };
	const axis = (min: number, max: number, size: number) =>
		max - min + 2 * margin <= size ? (min + max) / 2 - size / 2 : min - margin;
	return { x: axis(extent.minX, extent.maxX, width), y: axis(extent.minY, extent.maxY, height) };
}

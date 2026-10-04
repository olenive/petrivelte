import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LAYOUT_CONFIG,
	backEdgeControl,
	computeLayout,
	frameView,
	isBackEdge,
	topologyKey,
	type LayoutInput,
	type NetLayout,
} from './layout';

/** The Bevy tests' parcel net: a pipeline with a deferral loop. */
const parcel: LayoutInput = {
	places: ['Receiving', 'Sorting', 'Staging Area', 'Dispatched'],
	transitions: ['Sort', 'Stage', 'Dispatch Truck'],
	edges: [
		{ from: 'Receiving', to: 'Sort' },
		{ from: 'Sort', to: 'Sorting' },
		{ from: 'Sorting', to: 'Stage' },
		{ from: 'Stage', to: 'Staging Area' },
		{ from: 'Staging Area', to: 'Dispatch Truck' },
		{ from: 'Dispatch Truck', to: 'Dispatched' },
		{ from: 'Dispatch Truck', to: 'Staging Area' },
	],
};
const parcelOrder = [
	'Receiving',
	'Sort',
	'Sorting',
	'Stage',
	'Staging Area',
	'Dispatch Truck',
	'Dispatched',
];

/** The Bevy tests' branching net. */
const branching: LayoutInput = {
	places: ['Source', 'Left Out', 'Right Out'],
	transitions: ['Go Left', 'Go Right'],
	edges: [
		{ from: 'Source', to: 'Go Left' },
		{ from: 'Go Left', to: 'Left Out' },
		{ from: 'Source', to: 'Go Right' },
		{ from: 'Go Right', to: 'Right Out' },
	],
};

const at = (layout: NetLayout, name: string) => {
	const p = layout.placements.get(name);
	if (!p) throw new Error(`${name} is not placed`);
	return p;
};

describe('computeLayout, ported from the Bevy tests', () => {
	it('lays the parcel net out as one column in order with one back edge', () => {
		const layout = computeLayout(parcel);
		const positions = parcelOrder.map((name) => at(layout, name));
		positions.forEach((p, rank) => {
			expect(p.rank).toBe(rank);
			expect(Math.abs(p.x - positions[0].x)).toBeLessThan(1e-3);
		});
		// Screen coordinates: each rank is below the last, so y grows.
		positions.slice(1).forEach((p, i) => {
			expect(p.y).toBeGreaterThan(positions[i].y + 100);
		});
		expect(layout.backEdges).toEqual([{ from: 'Dispatch Truck', to: 'Staging Area' }]);
		expect(isBackEdge(layout, 'Dispatch Truck', 'Staging Area')).toBe(true);
		expect(isBackEdge(layout, 'Staging Area', 'Dispatch Truck')).toBe(false);
		expect(layout.ranks).toBe(7);
	});

	it('shares a rank between branches in a deterministic order', () => {
		const layout = computeLayout(branching);
		expect(at(layout, 'Source').rank).toBe(0);
		expect(at(layout, 'Go Left').rank).toBe(1);
		expect(at(layout, 'Go Right').rank).toBe(1);

		const tl = at(layout, 'Go Left');
		const tr = at(layout, 'Go Right');
		expect(tl.y).toBe(tr.y);
		expect(tl.x).toBeLessThan(tr.x);
		expect(Math.abs(tr.x - tl.x - DEFAULT_LAYOUT_CONFIG.nodeSep)).toBeLessThan(1e-3);
		expect(at(layout, 'Left Out').x).toBeLessThan(at(layout, 'Right Out').x);
		expect(Math.abs(at(layout, 'Source').x - (tl.x + tr.x) / 2)).toBeLessThan(1e-3);
		expect(layout.backEdges).toEqual([]);

		expect(computeLayout(structuredClone(branching))).toEqual(layout);

		const sideways = computeLayout(branching, {
			...DEFAULT_LAYOUT_CONFIG,
			direction: 'left-right',
		});
		expect(at(sideways, 'Go Left').x).toBeGreaterThan(at(sideways, 'Source').x);
		expect(at(sideways, 'Go Left').y).toBeLessThan(at(sideways, 'Go Right').y);
	});
});

describe('computeLayout', () => {
	it('is deterministic', () => {
		expect(computeLayout(parcel)).toEqual(computeLayout(parcel));
		expect(computeLayout(branching)).toEqual(computeLayout(branching));
	});

	it('lays a chain out in order along the direction', () => {
		const chain: LayoutInput = {
			places: ['a', 'b', 'c'],
			transitions: ['t1', 't2'],
			edges: [
				{ from: 'a', to: 't1' },
				{ from: 't1', to: 'b' },
				{ from: 'b', to: 't2' },
				{ from: 't2', to: 'c' },
			],
		};
		const down = computeLayout(chain);
		const ys = ['a', 't1', 'b', 't2', 'c'].map((n) => at(down, n).y);
		expect(ys).toEqual([...ys].sort((p, q) => p - q));
		expect(new Set(ys).size).toBe(5);
		expect(ys[1] - ys[0]).toBe(DEFAULT_LAYOUT_CONFIG.rankSep);

		const right = computeLayout(chain, { ...DEFAULT_LAYOUT_CONFIG, direction: 'left-right' });
		const xs = ['a', 't1', 'b', 't2', 'c'].map((n) => at(right, n).x);
		expect(xs).toEqual([...xs].sort((p, q) => p - q));
		expect(new Set(xs).size).toBe(5);
	});

	it('marks the back edge the depth-first order implies in a cycle', () => {
		// A ring with no way in: the search starts from the first declared
		// node, so the edge returning to it is the back edge.
		const ring = computeLayout({
			places: ['p', 'q'],
			transitions: ['t', 'u'],
			edges: [
				{ from: 'p', to: 't' },
				{ from: 't', to: 'q' },
				{ from: 'q', to: 'u' },
				{ from: 'u', to: 'p' },
			],
		});
		expect(ring.backEdges).toEqual([{ from: 'u', to: 'p' }]);
		expect(['p', 't', 'q', 'u'].map((n) => at(ring, n).rank)).toEqual([0, 1, 2, 3]);

		// Declaring `q` first starts the search there instead.
		const rotated = computeLayout({
			places: ['q', 'p'],
			transitions: ['t', 'u'],
			edges: [
				{ from: 'p', to: 't' },
				{ from: 't', to: 'q' },
				{ from: 'q', to: 'u' },
				{ from: 'u', to: 'p' },
			],
		});
		expect(rotated.backEdges).toEqual([{ from: 't', to: 'q' }]);
	});

	it('keeps a pinned node where it is and lays the rest out around it', () => {
		const free = computeLayout(parcel);
		const pinned = computeLayout({ ...parcel, pinned: { Sorting: { x: 500, y: 300 } } });
		expect(at(pinned, 'Sorting')).toMatchObject({ x: 500, y: 300, pinned: true });
		// The others keep their shape relative to the pin.
		for (const name of parcelOrder) {
			const dx = at(pinned, name).x - at(pinned, 'Sorting').x;
			const dy = at(pinned, name).y - at(pinned, 'Sorting').y;
			expect(dx).toBeCloseTo(at(free, name).x - at(free, 'Sorting').x);
			expect(dy).toBeCloseTo(at(free, name).y - at(free, 'Sorting').y);
		}
		expect(at(pinned, 'Receiving').pinned).toBe(false);
	});

	it('ignores pins and edges naming unknown nodes', () => {
		const layout = computeLayout({
			...branching,
			edges: [...branching.edges, { from: 'Ghost', to: 'Source' }],
			pinned: { Ghost: { x: 9, y: 9 } },
		});
		expect(layout).toEqual(computeLayout(branching));
	});

	it('lays an empty net out as nothing', () => {
		const layout = computeLayout({ places: [], transitions: [], edges: [] });
		expect(layout.placements.size).toBe(0);
		expect(layout.backEdges).toEqual([]);
		expect(layout.ranks).toBe(0);
		expect(layout.extent).toBeNull();
	});

	it('centres the drawing on the origin and bounds the shapes', () => {
		const layout = computeLayout(branching);
		const { placeRadius, transitionWidth, nodeSep, rankSep } = DEFAULT_LAYOUT_CONFIG;
		// Widest across the transitions' rank, tallest at the places' ranks.
		expect(layout.extent).toEqual({
			minX: -nodeSep / 2 - transitionWidth / 2,
			maxX: nodeSep / 2 + transitionWidth / 2,
			minY: -rankSep - placeRadius,
			maxY: rankSep + placeRadius,
		});
		expect(at(layout, 'Go Left').y).toBe(0);
	});
});

describe('topologyKey', () => {
	it('changes with the topology and nothing else', () => {
		const key = topologyKey(parcel);
		expect(topologyKey(structuredClone(parcel))).toBe(key);
		expect(topologyKey({ ...parcel, edges: parcel.edges.slice(1) })).not.toBe(key);
		expect(topologyKey({ ...parcel, pinned: { Sort: { x: 0, y: 0 } } })).not.toBe(key);
		expect(
			topologyKey({ ...parcel, pinned: { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } } }),
		).toBe(topologyKey({ ...parcel, pinned: { b: { x: 1, y: 1 }, a: { x: 0, y: 0 } } }));
	});
});

describe('backEdgeControl', () => {
	it('bows to the side the ranks do not grow toward', () => {
		const down = backEdgeControl({ x: 0, y: 200 }, { x: 0, y: 100 });
		expect(down.y).toBe(150);
		expect(down.x).toBeGreaterThan(0);
		const right = backEdgeControl(
			{ x: 200, y: 0 },
			{ x: 100, y: 0 },
			{ ...DEFAULT_LAYOUT_CONFIG, direction: 'left-right' },
		);
		expect(right.x).toBe(150);
		expect(right.y).toBeGreaterThan(0);
	});
});

describe('frameView', () => {
	it('centres a drawing that fits and starts a large one at its first rank', () => {
		expect(frameView({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, 1000, 800)).toEqual({
			x: -500,
			y: -400,
		});
		expect(frameView({ minX: -100, minY: -1000, maxX: 100, maxY: 1000 }, 1000, 800, 60)).toEqual(
			{ x: -500, y: -1060 },
		);
		expect(frameView(null, 1000, 800)).toEqual({ x: -500, y: -400 });
	});
});

import { describe, expect, it } from 'vitest';
import type { Control, EdgeKind, NetState, TopologyEdge } from './types';
import { mirrorFromState } from './netMirror';
import { layoutFor } from './graphLayout';
import { drawNet, drawTokens, edgeHead, edgeStroke, placeFill, transitionLook } from './netView';
import { detailRows, transitionArcs } from './transitionDetail';

const state: NetState = {
	protocol_version: 1,
	runtime: 'python',
	net: 'n',
	generation: 1,
	marking_version: 0,
	running: false,
	topology: {
		places: [
			{ name: 'In', type_name: 'int', serializable: true },
			{ name: 'Cfg', type_name: 'Cfg', serializable: false },
			{ name: 'Out', type_name: 'int', serializable: true },
		],
		transitions: [{ name: 'Go', detail: { function_name: 'go', signature: '(x: int) -> int', docstring: 'Go.' } }],
		edges: [
			{ place: 'In', transition: 'Go', direction: 'in', kind: 'take' },
			{ place: 'Cfg', transition: 'Go', direction: 'in', kind: 'snapshot' },
			{ place: 'Cfg', transition: 'Go', direction: 'in', kind: 'mutate' },
			{ place: 'Out', transition: 'Go', direction: 'out', slot: 0 },
			{ place: 'Out', transition: 'Go', direction: 'out', slot: 1 },
		],
	},
	transitions: { Go: { enabled: false, fireable: false, in_flight: false } },
	marking: { places: { In: { count: 25, tokens: Array.from({ length: 25 }, (_, i) => ({ id: String(i), label: 'x' })) } } },
	progress: { step_count: 0, last_fired: null, fired_counts: {}, last_progress_at: null },
};

describe('netView', () => {
	const mirror = mirrorFromState(state);
	const { layout } = layoutFor(mirror.topology, null);

	it('draws every edge once, keyed by its ends, kind and slot, read edges dashed and dotted', () => {
		const { edges } = drawNet(mirror, layout);
		expect(new Set(edges.map((e) => e.key)).size).toBe(5);
		expect(edges.map((e) => e.stroke)).toEqual(['solid', 'dashed', 'dotted', 'solid', 'solid']);
		expect(edges.every((e) => e.head === 'filled')).toBe(true);
		expect(edges[3]).toMatchObject({ fromShape: 'transition', toShape: 'place', direction: 'out' });
	});

	it('strokes and heads each input kind, the two that accept an empty place hollow, and an unknown kind plain', () => {
		const input = (kind?: string): TopologyEdge => ({ place: 'a', transition: 'b', direction: 'in', kind });
		const look = (kind?: string) => [edgeStroke(input(kind)), edgeHead(input(kind))];
		const kinds: EdgeKind[] = ['take', 'take_all', 'snapshot', 'mutate', 'take_where', 'mutate_where', 'drain', 'survey'];
		expect(Object.fromEntries(kinds.map((kind) => [kind, look(kind)]))).toEqual({
			take: ['solid', 'filled'],
			take_all: ['solid', 'filled'],
			snapshot: ['dashed', 'filled'],
			mutate: ['dotted', 'filled'],
			take_where: ['solid', 'filled'],
			// A mutate edge with a filter, a read edge as mutate is.
			mutate_where: ['dotted', 'filled'],
			// A drain consumes as take_all does, a survey reads as snapshot
			// does; the hollow head is what tells them apart.
			drain: ['solid', 'hollow'],
			survey: ['dashed', 'hollow'],
		});
		// A kind the page does not know, or none, draws as a plain edge (§5.1).
		expect(look('drain_where')).toEqual(['solid', 'filled']);
		expect(look(undefined)).toEqual(['solid', 'filled']);
		// Only an input edge has a kind to draw by.
		const output: TopologyEdge = { place: 'a', transition: 'b', direction: 'out', kind: 'survey' };
		expect([edgeStroke(output), edgeHead(output)]).toEqual(['solid', 'filled']);
	});

	it('styles transitions from their state', () => {
		expect(drawNet(mirror, layout).transitions[0]).toMatchObject({ look: 'disabled', subtitle: 'go' });
		expect(transitionLook({ enabled: true, fireable: true, in_flight: false })).toBe('fireable');
		expect(transitionLook({ enabled: true, fireable: false, in_flight: true })).toBe('in_flight');
		expect(transitionLook({ enabled: true, fireable: false, in_flight: false })).toBe('idle');
		expect(edgeStroke({ place: 'a', transition: 'b', direction: 'in', kind: 'take_all' })).toBe('solid');
	});

	it('draws places with their counts and at most the dot cap of tokens', () => {
		expect(drawNet(mirror, layout).places.map((p) => [p.name, p.count])).toEqual([
			['In', 25],
			['Cfg', 0],
			['Out', 0],
		]);
		expect(drawTokens(mirror, layout)).toHaveLength(20);
	});

	it('draws no matching count and no badge while there is nothing to say', () => {
		expect(drawNet(mirror, layout).places.every((p) => p.matching === null)).toBe(true);
		expect(drawTokens(mirror, layout).every((t) => t.badge === null)).toBe(true);
	});
});

describe('netView with keys and inner nets', () => {
	const keyed: NetState = {
		...state,
		topology: {
			...state.topology,
			places: [
				{ name: 'In', type_name: 'Animal', serializable: true, key_names: ['class'] },
				{ name: 'Cfg', type_name: 'Cfg', serializable: false },
				{ name: 'Out', type_name: 'Bus', serializable: true, nested: true },
			],
		},
		marking: {
			places: {
				In: {
					count: 4,
					tokens: [
						{ id: '1', label: 'Hen', keys: { class: 'Bird' } },
						{ id: '2', label: 'Dog', keys: { class: 'Mammal' } },
						{ id: '3', label: 'Owl', keys: { class: 'Bird' } },
					],
				},
				Out: {
					count: 2,
					tokens: [
						{ id: '4', label: 'Bus', nets: [{ name: 'cabin', nested_id: 'n1', path: 'n/Out/#4/cabin', count: 3 }] },
						{ id: '5', label: 'Van', nets: [{ name: 'cabin', nested_id: 'n2', path: 'n/Out/#5/cabin', count: 140 }] },
					],
				},
			},
		},
	};
	const mirror = mirrorFromState(keyed);
	const { layout } = layoutFor(mirror.topology, null);

	it('badges a token that holds nets with their total count', () => {
		const badges = Object.fromEntries(drawTokens(mirror, layout).map((t) => [t.id, t.badge]));
		expect(badges).toEqual({ '1': null, '2': null, '3': null, '4': '3', '5': '99+' });
	});

	it('leaves out the tokens the filter hides, keeping the slots of the rest', () => {
		const all = drawTokens(mirror, layout);
		const birds = drawTokens(mirror, layout, { class: ['Bird'] });
		expect(birds.map((t) => t.id)).toEqual(['1', '3']);
		// The owl stays in its own slot, where the animation finds it.
		expect(birds[1]).toMatchObject({ x: all[2].x, y: all[2].y });
	});

	it('reads matching of count on every place under a filter', () => {
		const places = Object.fromEntries(drawNet(mirror, layout, { class: ['Bird'] }).places.map((p) => [p.name, p.matching]));
		expect(places).toEqual({ In: '2+ of 4', Cfg: '0 of 0', Out: '0 of 2' });
	});
});

const strings = (names: string[]) => names.map((name) => ({ name, type_name: 'str', serializable: true }));

// The shop of protocol §11, the survey alone since 2026-10-16: Price Order
// surveys Promotions.
const shop: NetState = {
	...state,
	net: 'shop',
	topology: {
		places: strings(['Orders', 'Promotions', 'Priced', 'Discounts Applied']),
		transitions: [{ name: 'Price Order' }],
		edges: [
			{ place: 'Orders', transition: 'Price Order', direction: 'in', kind: 'take' },
			{ place: 'Promotions', transition: 'Price Order', direction: 'in', kind: 'survey' },
			{ place: 'Priced', transition: 'Price Order', direction: 'out', slot: 0 },
			{ place: 'Discounts Applied', transition: 'Price Order', direction: 'out', slot: 1 },
		],
	},
	transitions: {
		'Price Order': { enabled: true, fireable: false, in_flight: false },
	},
	marking: { places: {} },
};

// The traffic light's two controls, as §11 declares them: a text control
// that adds a car to Waiting, and a button that fires Change.
const trafficControls: Control[] = [
	{ name: 'car', label: '+ Car', kind: 'text', node: 'Waiting', action: 'inject', config: { placeholder: 'name' } },
	{ name: 'change', label: 'Change', kind: 'button', node: 'Change', action: 'fire' },
];

// The traffic light of protocol §11, since 2026-10-16, the light one place
// and two transitions in all since later that day, as it is seeded: Light
// holds one token, its colour, "red", carrying the colour it is drawn with,
// and Light is filled with its token's colour. Go drains Waiting and reads
// Light through a plain snapshot, writing the cars to Passed; Change takes
// the light and writes the next colour back. Go's guard, green and someone
// waiting, is not on the wire: what the page has is each transition's
// fireable.
const trafficLight: NetState = {
	...state,
	net: 'traffic-light',
	topology: {
		places: [
			{ name: 'Light', type_name: 'str', serializable: true, style: { fill: 'token' } },
			...strings(['Waiting', 'Passed']),
		],
		transitions: [{ name: 'Go' }, { name: 'Change' }],
		edges: [
			{ place: 'Waiting', transition: 'Go', direction: 'in', kind: 'drain' },
			{ place: 'Light', transition: 'Go', direction: 'in', kind: 'snapshot' },
			{ place: 'Passed', transition: 'Go', direction: 'out' },
			{ place: 'Light', transition: 'Change', direction: 'in', kind: 'take' },
			{ place: 'Light', transition: 'Change', direction: 'out' },
		],
		controls: trafficControls,
	},
	transitions: {
		Go: { enabled: true, fireable: false, in_flight: false },
		Change: { enabled: true, fireable: true, in_flight: false },
	},
	marking: { places: { Light: { count: 1, tokens: [{ id: '0', label: '"red"', color: '#ff6347' }] } } },
};

describe('netView with edges on empty places', () => {
	it('draws the survey dashed with a hollow head', () => {
		const mirror = mirrorFromState(shop);
		const { layout } = layoutFor(mirror.topology, null);
		expect(drawNet(mirror, layout).edges.map((e) => [e.key, e.stroke, e.head])).toEqual([
			['in|Orders|Price Order|take|', 'solid', 'filled'],
			['in|Promotions|Price Order|survey|', 'dashed', 'hollow'],
			['out|Priced|Price Order||0', 'solid', 'filled'],
			['out|Discounts Applied|Price Order||1', 'solid', 'filled'],
		]);
	});

	it('draws the drain solid with a hollow head, and the plain read dashed with a filled one', () => {
		const mirror = mirrorFromState(trafficLight);
		const { layout } = layoutFor(mirror.topology, null);
		const { edges } = drawNet(mirror, layout);
		expect(edges.map((e) => [e.key, e.stroke, e.head])).toEqual([
			['in|Waiting|Go|drain|', 'solid', 'hollow'],
			['in|Light|Go|snapshot|', 'dashed', 'filled'],
			['out|Passed|Go||', 'solid', 'filled'],
			['in|Light|Change|take|', 'solid', 'filled'],
			['out|Light|Change||', 'solid', 'filled'],
		]);
		// Change takes from Light and writes back to it: of that loop, one
		// edge is a back edge and drawn curved, so the two do not lie on one
		// line.
		expect(edges.filter((e) => e.back).map((e) => e.key)).toEqual(['out|Light|Change||']);
	});
});

describe('netView with controls and a styled place', () => {
	const withLight = (tokens: Array<{ id: string; label: string; color?: string }>, count = tokens.length): NetState => ({
		...trafficLight,
		marking: { places: { Light: { count, tokens } } },
	});
	const lightFill = (net: NetState) => {
		const mirror = mirrorFromState(net);
		const { layout } = layoutFor(mirror.topology, null);
		return drawNet(mirror, layout).places.find((p) => p.name === 'Light')?.fill;
	};

	it('keeps the controls in declaration order and each place its style', () => {
		const mirror = mirrorFromState(trafficLight);
		expect(mirror.topology.controls).toEqual(trafficControls);
		expect(mirror.places.Light.style).toEqual({ fill: 'token' });
		expect('style' in mirror.places.Waiting).toBe(false);
	});

	it("fills Light with its one token's colour", () => {
		const mirror = mirrorFromState(trafficLight);
		const { layout } = layoutFor(mirror.topology, null);
		const places = drawNet(mirror, layout).places;
		expect(places.find((p) => p.name === 'Light')).toMatchObject({ style: { fill: 'token' }, fill: '#ff6347' });
		// An unstyled place keeps the theme's fill, whatever it holds.
		expect(places.filter((p) => p.fill !== undefined).map((p) => p.name)).toEqual(['Light']);
	});

	it('fills it with nothing while it holds two tokens, or none, or one without a colour', () => {
		expect(lightFill(withLight([{ id: '0', label: '"red"', color: '#ff6347' }, { id: '1', label: '"green"', color: '#32cd32' }]))).toBeUndefined();
		expect(lightFill(withLight([]))).toBeUndefined();
		expect(lightFill(withLight([{ id: '0', label: '"red"' }]))).toBeUndefined();
		// The count is the truth: one token listed of two held is not one.
		expect(lightFill(withLight([{ id: '0', label: '"red"', color: '#ff6347' }], 2))).toBeUndefined();
		// Without the style, a coloured token leaves the place alone.
		expect(placeFill({ name: 'P', serializable: true, count: 1, tokens: [{ id: '0', label: 'x', color: '#ff6347' }] })).toBeUndefined();
	});

	it('draws a net that declares no controls as before: none kept, nothing filled', () => {
		for (const net of [state, shop]) {
			const mirror = mirrorFromState(net);
			const { layout } = layoutFor(mirror.topology, null);
			expect(mirror.topology.controls).toEqual([]);
			expect(drawNet(mirror, layout).places.every((p) => p.fill === undefined && p.style === undefined)).toBe(true);
		}
		// A token with a colour in an unstyled place is still drawn in it.
		const parcels = mirrorFromState({
			...state,
			marking: { places: { In: { count: 1, tokens: [{ id: '1', label: 'x', color: '#d94f4f' }] } } },
		});
		const { layout } = layoutFor(parcels.topology, null);
		expect(drawNet(parcels, layout).places.find((p) => p.name === 'In')?.fill).toBeUndefined();
		expect(drawTokens(parcels, layout)[0].color).toBe('#d94f4f');
	});
});

describe('transitionDetail', () => {
	it('shows detail as rows, strings plainly and the rest as JSON', () => {
		expect(detailRows({ function_name: 'go', params: ['u32', 'Parcel'], detachable: true })).toEqual([
			['function_name', 'go'],
			['params', '["u32","Parcel"]'],
			['detachable', 'true'],
		]);
		expect(detailRows(undefined)).toEqual([]);
	});

	it('lists input and output places from the topology', () => {
		expect(transitionArcs(state.topology, 'Go')).toEqual({
			inputs: [
				{ place: 'In', note: '' },
				{ place: 'Cfg', note: 'snapshot' },
				{ place: 'Cfg', note: 'mutate' },
			],
			outputs: [
				{ place: 'Out', note: 'slot 0' },
				{ place: 'Out', note: 'slot 1' },
			],
		});
	});

	it('says in a phrase what a drain and a survey do, and names a plain read', () => {
		expect(transitionArcs(shop.topology, 'Price Order').inputs).toEqual([
			{ place: 'Orders', note: '' },
			{ place: 'Promotions', note: 'survey: copies every token, zero or more' },
		]);
		expect(transitionArcs(trafficLight.topology, 'Go')).toEqual({
			inputs: [
				{ place: 'Waiting', note: 'drain: takes every token, zero or more' },
				{ place: 'Light', note: 'snapshot' },
			],
			outputs: [{ place: 'Passed', note: '' }],
		});
		expect(transitionArcs(trafficLight.topology, 'Change')).toEqual({
			inputs: [{ place: 'Light', note: '' }],
			outputs: [{ place: 'Light', note: '' }],
		});
	});
});

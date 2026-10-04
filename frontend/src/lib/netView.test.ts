import { describe, expect, it } from 'vitest';
import type { NetState } from './types';
import { mirrorFromState } from './netMirror';
import { layoutFor } from './graphLayout';
import { drawNet, drawTokens, edgeStroke, transitionLook } from './netView';
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
		expect(edges[3]).toMatchObject({ fromShape: 'transition', toShape: 'place', direction: 'out' });
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
});

import { describe, expect, it } from 'vitest';
import type { Topology } from './types';
import { layoutFor, layoutInputOf } from './graphLayout';

const topology = (): Topology => ({
	places: [
		{ name: 'In', type_name: 'int', serializable: true },
		{ name: 'Out', type_name: 'int', serializable: true },
		{ name: 'Config', type_name: 'Settings', serializable: false },
	],
	transitions: [{ name: 'Go', detail: { function_name: 'go' } }],
	edges: [
		{ place: 'In', transition: 'Go', direction: 'in', kind: 'take' },
		{ place: 'Config', transition: 'Go', direction: 'in', kind: 'snapshot' },
		{ place: 'Out', transition: 'Go', direction: 'out', slot: 0 },
	],
});

describe('graphLayout', () => {
	it('reads the topology edges as directed pairs, read edges included', () => {
		expect(layoutInputOf(topology())).toEqual({
			places: ['In', 'Out', 'Config'],
			transitions: ['Go'],
			edges: [
				{ from: 'In', to: 'Go' },
				{ from: 'Config', to: 'Go' },
				{ from: 'Go', to: 'Out' },
			],
		});
	});

	it('lays out a topology without hints around the origin', () => {
		const { layout } = layoutFor(topology(), null);
		const at = (name: string) => {
			const p = layout.placements.get(name)!;
			return [p.x, p.y, p.pinned];
		};
		expect(at('Go')).toEqual([0, 0, false]);
		expect(at('Out')).toEqual([0, 120, false]);
		expect(layout.placements.get('In')!.y).toBe(-120);
		expect(layout.placements.get('Config')!.y).toBe(-120);
	});

	it('passes position hints as pins', () => {
		const hinted: Topology = { ...topology(), hints: { positions: { Go: { x: 500, y: 300 } } } };
		expect(layoutInputOf(hinted).pinned).toEqual({ Go: { x: 500, y: 300 } });
		const { layout } = layoutFor(hinted, null);
		expect(layout.placements.get('Go')).toMatchObject({ x: 500, y: 300, pinned: true });
		expect(layout.placements.get('Out')).toMatchObject({ x: 500, y: 420, pinned: false });
	});

	it('leaves out empty hints', () => {
		expect(layoutInputOf({ ...topology(), hints: { positions: {} } })).not.toHaveProperty('pinned');
		expect(layoutInputOf({ ...topology(), hints: {} })).not.toHaveProperty('pinned');
	});

	it('keeps the layout for the same topology and recomputes on a change', () => {
		const first = layoutFor(topology(), null);
		expect(layoutFor(topology(), first)).toBe(first);
		const grown = topology();
		grown.places.push({ name: 'Extra', serializable: false });
		expect(layoutFor(grown, first)).not.toBe(first);
		const pinned = { ...topology(), hints: { positions: { In: { x: 1, y: 2 } } } };
		expect(layoutFor(pinned, first)).not.toBe(first);
	});
});

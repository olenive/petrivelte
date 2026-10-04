import { describe, expect, it } from 'vitest';
import type { GraphState } from './types';
import { layoutFor, layoutInputOf, placeGraphState } from './graphLayout';

const state = (tokenCount = 0): GraphState => ({
	places: [
		{ id: 'In', name: 'In', x: 999, y: 999, type_name: 'int', token_count: tokenCount },
		{ id: 'Out', name: 'Out', x: 5, y: 5, type_name: 'int' },
	],
	transitions: [{ id: 'Go', name: 'Go', x: -7, y: 42, function_name: 'go' }],
	edges: [
		{ id: 'e1', source: 'In', target: 'Go', type: 'input' },
		{ id: 'e2', source: 'Go', target: 'Out', type: 'output' },
	],
});

describe('graphLayout', () => {
	it('maps the version 0 edges to directed pairs', () => {
		expect(layoutInputOf(state())).toEqual({
			places: ['In', 'Out'],
			transitions: ['Go'],
			edges: [
				{ from: 'In', to: 'Go' },
				{ from: 'Go', to: 'Out' },
			],
		});
	});

	it('ignores the server coordinates', () => {
		const { layout } = layoutFor(state(), null);
		const placed = placeGraphState(state(), layout);
		expect(placed.places.map((p) => [p.x, p.y])).toEqual([
			[0, -120],
			[0, 120],
		]);
		expect(placed.transitions[0]).toMatchObject({ x: 0, y: 0, function_name: 'go' });
		expect(placed.places[0].token_count).toBe(0);
	});

	it('keeps the layout across marking updates and recomputes on a topology change', () => {
		const first = layoutFor(state(0), null);
		expect(layoutFor(state(3), first)).toBe(first);
		const grown = state();
		grown.places.push({ id: 'Extra', name: 'Extra', x: 0, y: 0, type_name: 'int' });
		expect(layoutFor(grown, first)).not.toBe(first);
	});
});

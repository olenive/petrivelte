import { describe, expect, it } from 'vitest';
import type { NetState } from './types';
import { mirrorFromState } from './netMirror';
import {
	NO_FILTER,
	bannerText,
	clausesOf,
	filterCounts,
	isActive,
	isOn,
	keyNames,
	matchesKeys,
	matchingText,
	mergeValues,
	mirrorValues,
	protocolFilter,
	sameValue,
	toggleValue,
	valueText,
} from './tokenFilter';

/** A zoo: animals keyed by class and legs; a place of keepers with no keys. */
function zoo(over: Partial<NetState> = {}): NetState {
	return {
		protocol_version: 1,
		runtime: 'rust',
		net: 'zoo',
		generation: 1,
		marking_version: 3,
		running: false,
		topology: {
			places: [
				{ name: 'Pen', type_name: 'Animal', serializable: true, key_names: ['class', 'legs'] },
				{ name: 'Keepers', type_name: 'str', serializable: true },
				{ name: 'Aviary', type_name: 'Animal', serializable: true, key_names: ['class', 'wild'] },
			],
			transitions: [],
			edges: [],
		},
		transitions: {},
		marking: {
			places: {
				Pen: {
					count: 3,
					tokens: [
						{ id: '1', label: 'Dog', keys: { class: 'Mammal', legs: 4 } },
						{ id: '2', label: 'Hen', keys: { class: 'Bird', legs: 2 } },
						{ id: '3', label: 'Ant', keys: { class: 'Insect', legs: 6 } },
					],
				},
				Keepers: { count: 1, tokens: [{ id: '4', label: 'Ada' }] },
				Aviary: { count: 5, tokens: [{ id: '5', label: 'Owl', keys: { class: 'Bird', wild: true } }] },
			},
		},
		progress: { step_count: 0, last_fired: null, fired_counts: {}, last_progress_at: null },
		...over,
	};
}

describe('matching', () => {
	it('compares by JSON type and value', () => {
		expect(sameValue(1, 1)).toBe(true);
		expect(sameValue(1, '1')).toBe(false);
		expect(sameValue(true, 1)).toBe(false);
		expect(sameValue('Bird', 'Bird')).toBe(true);
	});

	it('matches every token while no value is on', () => {
		expect(isActive(NO_FILTER)).toBe(false);
		expect(matchesKeys(NO_FILTER, undefined)).toBe(true);
		expect(isActive({ class: [] })).toBe(false);
	});

	it('ORs the values of one key and ANDs across keys', () => {
		const birdsAndMammals = { class: ['Bird', 'Mammal'] };
		expect(matchesKeys(birdsAndMammals, { class: 'Bird', legs: 2 })).toBe(true);
		expect(matchesKeys(birdsAndMammals, { class: 'Mammal', legs: 4 })).toBe(true);
		expect(matchesKeys(birdsAndMammals, { class: 'Insect', legs: 6 })).toBe(false);
		const twoLeggedBirds = { class: ['Bird'], legs: [2] };
		expect(matchesKeys(twoLeggedBirds, { class: 'Bird', legs: 2 })).toBe(true);
		expect(matchesKeys(twoLeggedBirds, { class: 'Bird', wild: true })).toBe(false);
		expect(matchesKeys({ legs: ['2'] }, { legs: 2 })).toBe(false);
	});

	it('lets nothing through from a token whose place does not declare the key', () => {
		expect(matchesKeys({ class: ['Bird'] }, undefined)).toBe(false);
	});
});

describe('the bar', () => {
	it('toggles a value on and off, dropping a key with nothing on', () => {
		const one = toggleValue(NO_FILTER, 'class', 'Bird');
		expect(one).toEqual({ class: ['Bird'] });
		expect(isOn(one, 'class', 'Bird')).toBe(true);
		const two = toggleValue(one, 'class', 'Mammal');
		expect(two).toEqual({ class: ['Bird', 'Mammal'] });
		expect(toggleValue(toggleValue(two, 'class', 'Bird'), 'class', 'Mammal')).toEqual({});
		expect(isOn(one, 'class', 'Mammal')).toBe(false);
	});

	it('gives the clauses in force in the protocol shape', () => {
		const filter = { class: ['Bird'], legs: [] };
		expect(clausesOf(filter)).toEqual([{ key: 'class', values: ['Bird'] }]);
		expect(protocolFilter(filter)).toEqual({ clauses: [{ key: 'class', values: ['Bird'] }] });
	});

	it('offers the union of the places key names, in order of first appearance', () => {
		expect(keyNames(zoo().topology.places)).toEqual(['class', 'legs', 'wild']);
	});

	it('takes the values from the tokens held, in place order then token order', () => {
		const mirror = mirrorFromState(zoo());
		expect(mirrorValues(mirror, 'class')).toEqual(['Mammal', 'Bird', 'Insect']);
		expect(mirrorValues(mirror, 'wild')).toEqual([true]);
		expect(mirrorValues(mirror, 'colour')).toEqual([]);
	});

	it('prefers the server distinct answer and adds what it lacks', () => {
		expect(mergeValues(['Fish', 'Bird'], ['Mammal', 'Bird'], ['Reptile'])).toEqual(['Fish', 'Bird', 'Mammal', 'Reptile']);
		expect(mergeValues(null, ['Mammal', 'Bird'])).toEqual(['Mammal', 'Bird']);
		expect(mergeValues([1, '1', true], [1])).toEqual([1, '1', true]);
	});

	it('shows a string as itself and anything else as JSON', () => {
		expect(valueText('Bird')).toBe('Bird');
		expect(valueText(2)).toBe('2');
		expect(valueText(true)).toBe('true');
	});
});

describe('counts', () => {
	it('counts the matching tokens per place, a lower bound where the place holds more than it lists', () => {
		const counts = filterCounts(mirrorFromState(zoo()), { class: ['Bird'] });
		expect(counts.places.Pen).toEqual({ count: 3, matching: 1, lowerBound: false });
		expect(counts.places.Keepers).toEqual({ count: 1, matching: 0, lowerBound: false });
		expect(counts.places.Aviary).toEqual({ count: 5, matching: 1, lowerBound: true });
		expect(counts).toMatchObject({ matching: 2, total: 9, lowerBound: true });
		expect(matchingText(counts.places.Pen)).toBe('1 of 3');
		expect(matchingText(counts.places.Aviary)).toBe('1+ of 5');
		expect(bannerText(counts)).toBe('showing 2+ of 9 tokens');
	});

	it('says showing N of M when every token is known', () => {
		const mirror = mirrorFromState(zoo({
			marking: {
				places: {
					Pen: zoo().marking.places.Pen,
					Keepers: { count: 0, tokens: [] },
					Aviary: { count: 0, tokens: [] },
				},
			},
		}));
		expect(bannerText(filterCounts(mirror, { class: ['Bird', 'Mammal'] }))).toBe('showing 2 of 3 tokens');
	});
});

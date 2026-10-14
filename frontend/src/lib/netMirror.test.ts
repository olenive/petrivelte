import { describe, expect, it } from 'vitest';
import type { NetEvent, NetState } from './types';
import { applyEvent, isShort, mirrorFromState, shouldAdopt, totalCount, type Mirror } from './netMirror';

/** The conformance net's shape (protocol §11), small: Receiving -> Sort -> Sorting. */
function state(over: Partial<NetState> = {}): NetState {
	return {
		protocol_version: 1,
		runtime: 'rust',
		net: 'parcel-distribution',
		generation: 1,
		marking_version: 10,
		running: false,
		topology: {
			places: [
				{ name: 'Receiving', type_name: 'Parcel', serializable: true },
				{ name: 'Sorting', type_name: 'Parcel', serializable: true },
			],
			transitions: [{ name: 'Sort' }],
			edges: [
				{ place: 'Receiving', transition: 'Sort', direction: 'in', kind: 'take' },
				{ place: 'Sorting', transition: 'Sort', direction: 'out' },
			],
		},
		transitions: { Sort: { enabled: true, fireable: true, in_flight: false } },
		marking: {
			places: {
				Receiving: {
					count: 3,
					tokens: [
						{ id: '1', label: 'P1', color: '#d94f4f' },
						{ id: '2', label: 'P2' },
						{ id: '3', label: 'P3' },
					],
				},
				Sorting: { count: 0, tokens: [] },
			},
		},
		progress: { step_count: 0, last_fired: null, fired_counts: {}, last_progress_at: null },
		...over,
	};
}

const stamp = (marking_version: number) => ({ marking_version, running: false });

function applied(mirror: Mirror, event: NetEvent) {
	const result = applyEvent(mirror, event);
	if (result.outcome !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(result)}`);
	return result;
}

const ids = (mirror: Mirror, place: string) => mirror.places[place].tokens.map((t) => t.id);

describe('mirrorFromState', () => {
	it('keeps every place with its true count and capped list', () => {
		const mirror = mirrorFromState(state());
		expect(mirror.places.Receiving.count).toBe(3);
		expect(ids(mirror, 'Receiving')).toEqual(['1', '2', '3']);
		expect(mirror.places.Sorting).toMatchObject({ count: 0, tokens: [], serializable: true });
		expect(mirror.transitions.Sort).toEqual({ enabled: true, fireable: true, in_flight: false });
		expect(totalCount(mirror)).toBe(3);
	});
});

describe('the version rule', () => {
	const added = (version: number, id: string): NetEvent => ({
		kind: 'added',
		data: { ...stamp(version), place: 'Sorting', id, label: `P${id}` },
	});

	it('applies a state notification at the held version plus one', () => {
		const result = applied(mirrorFromState(state()), added(11, '9'));
		expect(result.mirror.marking_version).toBe(11);
		expect(ids(result.mirror, 'Sorting')).toEqual(['9']);
	});

	it('ignores one at or below the held version', () => {
		const mirror = mirrorFromState(state());
		expect(applyEvent(mirror, added(10, '9'))).toEqual({ outcome: 'stale' });
		expect(applyEvent(mirror, added(4, '9'))).toEqual({ outcome: 'stale' });
	});

	it('reports a gap, applying nothing, for one beyond the next', () => {
		const mirror = mirrorFromState(state());
		expect(applyEvent(mirror, added(12, '9'))).toEqual({ outcome: 'gap', expected: 11, got: 12 });
		expect(mirror.places.Sorting.count).toBe(0);
	});

	it('applies a run of consecutive versions and none twice', () => {
		let mirror = mirrorFromState(state());
		for (const [version, id] of [[11, 'a'], [12, 'b'], [13, 'c']] as const) {
			mirror = applied(mirror, added(version, id)).mirror;
		}
		expect(applyEvent(mirror, added(12, 'b')).outcome).toBe('stale');
		expect(ids(mirror, 'Sorting')).toEqual(['a', 'b', 'c']);
	});

	it('refetches on reloaded', () => {
		const result = applyEvent(mirrorFromState(state()), {
			kind: 'reloaded',
			data: { ...stamp(10), generation: 2, reason: 'reset' },
		});
		expect(result.outcome).toBe('refetch');
	});

	it('refetches, applying nothing, for a name the mirror does not have', () => {
		const result = applyEvent(mirrorFromState(state()), {
			kind: 'added',
			data: { ...stamp(11), place: 'Nowhere', id: '9', label: 'x' },
		});
		expect(result.outcome).toBe('refetch');
	});

	it('moves no version on fireable', () => {
		const result = applied(mirrorFromState(state()), {
			kind: 'fireable',
			data: { ...stamp(10), transitions: [] },
		});
		expect(result.mirror.marking_version).toBe(10);
		expect(result.mirror.transitions.Sort.fireable).toBe(false);
		expect(result.change).toEqual({ kind: 'fireable' });
	});

	it('ignores host events and heartbeats', () => {
		const mirror = mirrorFromState(state());
		expect(applyEvent(mirror, { kind: 'subprocess_output', data: { text: 'hi' } })).toEqual({ outcome: 'ignored' });
		expect(
			applyEvent(mirror, {
				kind: 'heartbeat',
				data: { ...stamp(10), step_started_at: null, executing_transition: null },
			}),
		).toEqual({ outcome: 'ignored' });
	});
});

describe('shouldAdopt', () => {
	it('adopts a read not older than the mirror, and any new generation', () => {
		const mirror = mirrorFromState(state());
		expect(shouldAdopt(null, state())).toBe(true);
		expect(shouldAdopt(mirror, state({ marking_version: 10 }))).toBe(true);
		expect(shouldAdopt(mirror, state({ marking_version: 12 }))).toBe(true);
		expect(shouldAdopt(mirror, state({ marking_version: 9 }))).toBe(false);
		expect(shouldAdopt(mirror, state({ marking_version: 9, generation: 2 }))).toBe(true);
	});
});

describe('applying each kind', () => {
	it('launched takes the consumed tokens and marks the transition in flight', () => {
		const before = mirrorFromState(state());
		const result = applied(before, {
			kind: 'launched',
			data: { ...stamp(11), transition: 'Sort', consumed: [['Receiving', '2']] },
		});
		expect(ids(result.mirror, 'Receiving')).toEqual(['1', '3']);
		expect(result.mirror.places.Receiving.count).toBe(2);
		expect(result.mirror.transitions.Sort).toMatchObject({ in_flight: true, fireable: false });
		expect(result.change).toEqual({
			kind: 'launched',
			transition: 'Sort',
			consumed: [{ place: 'Receiving', id: '2', token: { id: '2', label: 'P2' }, slot: 1 }],
		});
		// The mirror it came from is left as it was.
		expect(ids(before, 'Receiving')).toEqual(['1', '2', '3']);
		expect(before.transitions.Sort.in_flight).toBe(false);
	});

	it('distributed places the produced tokens and lands the firing', () => {
		let mirror = applied(mirrorFromState(state()), {
			kind: 'launched',
			data: { ...stamp(11), transition: 'Sort', consumed: [['Receiving', '1']] },
		}).mirror;
		const result = applied(mirror, {
			kind: 'distributed',
			data: { ...stamp(12), transition: 'Sort', produced: [['Sorting', '4', 'S4', '#00ff00']], duration_ms: 3 },
		});
		mirror = result.mirror;
		expect(mirror.places.Sorting).toMatchObject({ count: 1, tokens: [{ id: '4', label: 'S4', color: '#00ff00' }] });
		expect(mirror.transitions.Sort.in_flight).toBe(false);
		expect(mirror.progress).toMatchObject({ step_count: 1, last_fired: 'Sort', fired_counts: { Sort: 1 } });
		expect(mirror.airborne).toEqual({});
		expect(result.change).toMatchObject({ kind: 'distributed', produced: [{ place: 'Sorting', id: '4', slot: 0 }] });
	});

	it('fired does both halves at once', () => {
		const result = applied(mirrorFromState(state()), {
			kind: 'fired',
			data: {
				...stamp(11),
				transition: 'Sort',
				consumed: [['Receiving', '1']],
				produced: [['Sorting', '4', 'S4']],
				duration_ms: 1,
			},
		});
		expect(ids(result.mirror, 'Receiving')).toEqual(['2', '3']);
		expect(ids(result.mirror, 'Sorting')).toEqual(['4']);
		expect(result.change).toMatchObject({
			kind: 'fired',
			consumed: [{ id: '1', slot: 0 }],
			produced: [{ id: '4', slot: 0 }],
		});
	});

	it('failed with restored puts the launched tokens back at the front, labels and all', () => {
		let mirror = applied(mirrorFromState(state()), {
			kind: 'launched',
			data: { ...stamp(11), transition: 'Sort', consumed: [['Receiving', '2'], ['Receiving', '3']] },
		}).mirror;
		const result = applied(mirror, {
			kind: 'failed',
			data: { ...stamp(12), transition: 'Sort', error: 'boom', restored: true, consumed: [['Receiving', '2'], ['Receiving', '3']] },
		});
		mirror = result.mirror;
		expect(mirror.places.Receiving.tokens).toEqual([
			{ id: '2', label: 'P2' },
			{ id: '3', label: 'P3' },
			{ id: '1', label: 'P1', color: '#d94f4f' },
		]);
		expect(mirror.places.Receiving.count).toBe(3);
		expect(mirror.transitions.Sort.in_flight).toBe(false);
		expect(result.change).toMatchObject({
			kind: 'failed',
			error: 'boom',
			restored: true,
			consumed: [{ id: '2', slot: 0 }, { id: '3', slot: 1 }],
		});
	});

	it('failed without restored leaves the tokens gone', () => {
		const launched = applied(mirrorFromState(state()), {
			kind: 'launched',
			data: { ...stamp(11), transition: 'Sort', consumed: [['Receiving', '1']] },
		}).mirror;
		const result = applied(launched, {
			kind: 'failed',
			data: { ...stamp(12), transition: 'Sort', error: 'boom', restored: false, consumed: [['Receiving', '1']] },
		});
		expect(ids(result.mirror, 'Receiving')).toEqual(['2', '3']);
		expect(result.mirror.places.Receiving.count).toBe(2);
	});

	it('a one-piece failure that restored leaves the tokens where they are', () => {
		const result = applied(mirrorFromState(state()), {
			kind: 'failed',
			data: { ...stamp(11), transition: 'Sort', error: 'boom', restored: true, consumed: [['Receiving', '1']] },
		});
		expect(ids(result.mirror, 'Receiving')).toEqual(['1', '2', '3']);
		expect(result.mirror.places.Receiving.count).toBe(3);
	});

	it('added appends, removed takes away, mutated replaces the label', () => {
		let mirror = mirrorFromState(state());
		mirror = applied(mirror, { kind: 'added', data: { ...stamp(11), place: 'Receiving', id: '7', label: 'P7', color: '#123456' } }).mirror;
		expect(mirror.places.Receiving.tokens.at(-1)).toEqual({ id: '7', label: 'P7', color: '#123456' });
		expect(mirror.places.Receiving.count).toBe(4);
		mirror = applied(mirror, { kind: 'removed', data: { ...stamp(12), place: 'Receiving', id: '1' } }).mirror;
		expect(ids(mirror, 'Receiving')).toEqual(['2', '3', '7']);
		expect(mirror.places.Receiving.count).toBe(3);
		const mutated = applied(mirror, { kind: 'mutated', data: { ...stamp(13), place: 'Receiving', id: '3', label: 'P3*' } });
		expect(mutated.mirror.places.Receiving.tokens[1]).toEqual({ id: '3', label: 'P3*' });
		expect(mutated.change).toEqual({ kind: 'mutated', place: 'Receiving', id: '3' });
	});

	it('toggled switches the transition', () => {
		const result = applied(mirrorFromState(state()), {
			kind: 'toggled',
			data: { ...stamp(11), transition: 'Sort', enabled: false },
		});
		expect(result.mirror.transitions.Sort.enabled).toBe(false);
		expect(result.change).toEqual({ kind: 'toggled', transition: 'Sort', enabled: false });
	});

	it('param_changed moves the version only', () => {
		const result = applied(mirrorFromState(state()), { kind: 'param_changed', data: { ...stamp(11), param: 'trucks' } });
		expect(result.mirror.marking_version).toBe(11);
		expect(totalCount(result.mirror)).toBe(3);
	});

	it('execution_stopped clears running', () => {
		const mirror = mirrorFromState(state({ running: true }));
		const result = applied(mirror, {
			kind: 'execution_stopped',
			data: { ...stamp(10), reason: 'no_fireable_transitions' },
		});
		expect(result.mirror.running).toBe(false);
	});

	it('takes running from each state notification', () => {
		const result = applied(mirrorFromState(state()), {
			kind: 'added',
			data: { marking_version: 11, running: true, place: 'Sorting', id: '9', label: 'x' },
		});
		expect(result.mirror.running).toBe(true);
	});
});

describe('a capped place', () => {
	// Receiving holds 5 tokens; the state listed the oldest 2 (token_limit 2).
	const capped = () =>
		mirrorFromState(
			state({
				marking: {
					places: {
						Receiving: { count: 5, tokens: [{ id: '1', label: 'P1' }, { id: '2', label: 'P2' }] },
						Sorting: { count: 0, tokens: [] },
					},
				},
			}),
			2,
		);

	it('only raises the count for a token produced beyond the cap', () => {
		const result = applied(capped(), {
			kind: 'added',
			data: { ...stamp(11), place: 'Receiving', id: '9', label: 'P9' },
		});
		expect(ids(result.mirror, 'Receiving')).toEqual(['1', '2']);
		expect(result.mirror.places.Receiving.count).toBe(6);
		expect(result.change).toMatchObject({ kind: 'added', token: { id: '9', slot: null } });
	});

	it('drops the count for a token it never knew, and says the place is short', () => {
		const result = applied(capped(), {
			kind: 'launched',
			data: { ...stamp(11), transition: 'Sort', consumed: [['Receiving', '4']] },
		});
		expect(result.mirror.places.Receiving.count).toBe(4);
		expect(ids(result.mirror, 'Receiving')).toEqual(['1', '2']);
		expect(result.change).toMatchObject({ consumed: [{ id: '4', token: null, slot: null }] });
		expect(result.short).toEqual([]);
	});

	it('says the place is short once its list holds fewer than a read would list', () => {
		const result = applied(capped(), {
			kind: 'launched',
			data: { ...stamp(11), transition: 'Sort', consumed: [['Receiving', '1']] },
		});
		expect(ids(result.mirror, 'Receiving')).toEqual(['2']);
		expect(result.short).toEqual(['Receiving']);
		expect(isShort(result.mirror.places.Receiving, 2)).toBe(true);
	});

	it('keeps counting up as tokens keep arriving', () => {
		// Counts move on every notification, not only on a state read.
		let mirror = capped();
		for (const version of [11, 12, 13]) {
			mirror = applied(mirror, {
				kind: 'added',
				data: { ...stamp(version), place: 'Receiving', id: String(100 + version), label: 'x' },
			}).mirror;
		}
		expect(mirror.places.Receiving.count).toBe(8);
	});
});

describe('keys and nets (protocol §12, §13)', () => {
	/** Receiving declares keys and Sorting holds nets. */
	function keyed(): NetState {
		const base = state();
		return {
			...base,
			topology: {
				...base.topology,
				places: [
					{ name: 'Receiving', type_name: 'Parcel', serializable: true, key_names: ['zone', 'urgent'] },
					{ name: 'Sorting', type_name: 'Crate', serializable: true, nested: true, passive: true },
				],
			},
			marking: {
				places: {
					Receiving: {
						count: 2,
						tokens: [
							{ id: '1', label: 'P1', keys: { zone: 'north', urgent: true } },
							{ id: '2', label: 'P2', keys: { zone: 'south', urgent: false } },
						],
					},
					Sorting: {
						count: 1,
						tokens: [{ id: '3', label: 'Crate', nets: [{ name: 'inside', nested_id: 'n7', path: 'parcel-distribution/Sorting/#3/inside', count: 4 }] }],
					},
				},
			},
		};
	}

	it('keeps each place declaration and each token keys and nets from a state read', () => {
		const mirror = mirrorFromState(keyed());
		expect(mirror.places.Receiving.key_names).toEqual(['zone', 'urgent']);
		expect(mirror.places.Sorting).toMatchObject({ nested: true, passive: true });
		expect(mirror.places.Receiving.tokens[0].keys).toEqual({ zone: 'north', urgent: true });
		expect(mirror.places.Sorting.tokens[0].nets?.[0]).toMatchObject({ nested_id: 'n7', count: 4 });
	});

	it('reads keys from a produced fifth element, with null for no colour', () => {
		const launched = applied(mirrorFromState(keyed()), {
			kind: 'launched', data: { ...stamp(11), transition: 'Sort', consumed: [['Receiving', '1']] },
		});
		const landed = applied(launched.mirror, {
			kind: 'distributed',
			data: {
				...stamp(12),
				transition: 'Sort',
				produced: [['Receiving', '9', 'P9', null, { zone: 'east', urgent: true }]],
				duration_ms: 1,
			},
		});
		const token = landed.mirror.places.Receiving.tokens.find((t) => t.id === '9');
		expect(token).toEqual({ id: '9', label: 'P9', keys: { zone: 'east', urgent: true } });
	});

	it('takes keys from added and replaces them from mutated, keeping the token nets', () => {
		const added = applied(mirrorFromState(keyed()), {
			kind: 'added', data: { ...stamp(11), place: 'Receiving', id: '8', label: 'P8', color: '#00ff00', keys: { zone: 'west', urgent: false } },
		});
		expect(added.mirror.places.Receiving.tokens.find((t) => t.id === '8')).toEqual({
			id: '8', label: 'P8', color: '#00ff00', keys: { zone: 'west', urgent: false },
		});
		const mutated = applied(added.mirror, {
			kind: 'mutated', data: { ...stamp(12), place: 'Receiving', id: '1', keys: { zone: 'north', urgent: false } },
		});
		expect(mutated.mirror.places.Receiving.tokens[0]).toEqual({ id: '1', label: 'P1', keys: { zone: 'north', urgent: false } });
		const relabelled = applied(mutated.mirror, {
			kind: 'mutated', data: { ...stamp(13), place: 'Sorting', id: '3', label: 'Crate (full)' },
		});
		expect(relabelled.mirror.places.Sorting.tokens[0].nets?.[0].nested_id).toBe('n7');
	});

	it('moves only the count and the version for hidden', () => {
		const mirror = mirrorFromState(keyed());
		const hiddenAdded = applied(mirror, { kind: 'hidden', data: { ...stamp(11), kind: 'added', place: 'Receiving' } });
		expect(hiddenAdded.mirror.marking_version).toBe(11);
		expect(hiddenAdded.mirror.places.Receiving.count).toBe(3);
		expect(ids(hiddenAdded.mirror, 'Receiving')).toEqual(['1', '2']);
		expect(hiddenAdded.change).toEqual({ kind: 'hidden', place: 'Receiving', what: 'added' });
		expect(hiddenAdded.short).toEqual([]);
		const hiddenMutated = applied(hiddenAdded.mirror, { kind: 'hidden', data: { ...stamp(12), kind: 'mutated', place: 'Receiving' } });
		expect(hiddenMutated.mirror.places.Receiving).toEqual(hiddenAdded.mirror.places.Receiving);
		const hiddenRemoved = applied(hiddenMutated.mirror, { kind: 'hidden', data: { ...stamp(13), kind: 'removed', place: 'Receiving' } });
		expect(hiddenRemoved.mirror.places.Receiving.count).toBe(2);
		// The mirrors it came from are left as they were.
		expect(mirror.places.Receiving.count).toBe(2);
	});

	it('keeps the version rule for hidden, and refetches for a place it does not have', () => {
		const mirror = mirrorFromState(keyed());
		expect(applyEvent(mirror, { kind: 'hidden', data: { ...stamp(13), kind: 'added', place: 'Receiving' } })).toEqual({
			outcome: 'gap', expected: 11, got: 13,
		});
		expect(applyEvent(mirror, { kind: 'hidden', data: { ...stamp(11), kind: 'added', place: 'Nowhere' } }).outcome).toBe('refetch');
	});

	it('does not apply nested: it moves the inner net version, never this one', () => {
		const mirror = mirrorFromState(keyed());
		const outcome = applyEvent(mirror, {
			kind: 'nested',
			data: {
				...stamp(11),
				path: 'parcel-distribution/Sorting/#3/inside',
				nested_id: 'n7',
				event: { method: 'added', params: { place: 'Door', id: '1', label: 'x', ...stamp(2) } },
			},
		});
		expect(outcome).toEqual({ outcome: 'ignored' });
	});
});

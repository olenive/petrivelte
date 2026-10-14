import { describe, expect, it } from 'vitest';
import type { InnerNetRef, NetEvent, NetState } from './types';
import { applyEvent, mirrorFromState, type Change, type Mirror } from './netMirror';
import {
	NO_TOUCH,
	OUTSIDE_NOTE,
	TOUCH_CLAIM_MS,
	adoptInnerState,
	afterOuterChange,
	badgeCount,
	badgeText,
	breadcrumb,
	countDelta,
	holderIdFromPath,
	holderOf,
	moveBadge,
	needsNetsRead,
	openView,
	outerNoteText,
	readFailedNotice,
	reloadedNotice,
	routeNested,
	settleTouches,
	trackInner,
	trackOuter,
	unwrapNested,
	type InnerView,
	type TouchTracker,
} from './innerNets';

const stamp = (marking_version: number) => ({ marking_version, running: false });

const CABIN: InnerNetRef = { name: 'cabin', nested_id: 'n1', path: 'transit/Depot/#1/cabin', template: 'Cabin', count: 2 };

/** A small transit net: a bus holding a cabin in Depot, a passenger on the platform. */
function outerState(over: Partial<NetState> = {}): NetState {
	return {
		protocol_version: 1,
		runtime: 'python',
		net: 'transit',
		generation: 1,
		marking_version: 20,
		running: false,
		topology: {
			places: [
				{ name: 'Depot', type_name: 'Vehicle', serializable: true, nested: true },
				{ name: 'Platform', type_name: 'str', serializable: true },
				{ name: 'In Transit', type_name: 'Vehicle', serializable: true, nested: true },
				{ name: 'Scrapyard', type_name: 'str', serializable: true },
			],
			transitions: [{ name: 'Board' }, { name: 'Depart' }, { name: 'Scrap' }],
			edges: [
				{ place: 'Platform', transition: 'Board', direction: 'in', kind: 'take' },
				{ place: 'Depot', transition: 'Board', direction: 'in', kind: 'mutate' },
				{ place: 'Depot', transition: 'Depart', direction: 'in', kind: 'take' },
				{ place: 'In Transit', transition: 'Depart', direction: 'out' },
				{ place: 'In Transit', transition: 'Scrap', direction: 'in', kind: 'take' },
				{ place: 'Scrapyard', transition: 'Scrap', direction: 'out' },
			],
		},
		transitions: {
			Board: { enabled: true, fireable: true, in_flight: false },
			Depart: { enabled: true, fireable: true, in_flight: false },
			Scrap: { enabled: true, fireable: false, in_flight: false },
		},
		marking: {
			places: {
				Depot: { count: 1, tokens: [{ id: '1', label: 'Bus 1', nets: [CABIN] }] },
				Platform: { count: 1, tokens: [{ id: '2', label: 'Ada' }] },
				'In Transit': { count: 0, tokens: [] },
				Scrapyard: { count: 0, tokens: [] },
			},
		},
		progress: { step_count: 0, last_fired: null, fired_counts: {}, last_progress_at: null },
		...over,
	};
}

/** The cabin as `get_state {nested_id: "n1"}` answers it. */
function cabinState(over: Partial<NetState> = {}): NetState {
	return {
		protocol_version: 1,
		runtime: 'python',
		net: 'cabin',
		path: 'transit/Depot/#1/cabin',
		nested_id: 'n1',
		template: 'Cabin',
		generation: 1,
		marking_version: 4,
		running: false,
		topology: {
			places: [
				{ name: 'Door', type_name: 'str', serializable: true },
				{ name: 'Seats', type_name: 'str', serializable: true },
			],
			transitions: [{ name: 'Sit' }],
			edges: [
				{ place: 'Door', transition: 'Sit', direction: 'in', kind: 'take' },
				{ place: 'Seats', transition: 'Sit', direction: 'out' },
			],
		},
		transitions: { Sit: { enabled: true, fireable: true, in_flight: false } },
		marking: {
			places: {
				Door: { count: 1, tokens: [{ id: '1', label: 'Bram' }] },
				Seats: { count: 1, tokens: [{ id: '2', label: 'Cato' }] },
			},
		},
		progress: { step_count: 0, last_fired: null, fired_counts: {}, last_progress_at: null },
		...over,
	};
}

function nested(nested_id: string, method: string, params: Record<string, unknown>, path = 'transit/Depot/#1/cabin'): NetEvent {
	return { kind: 'nested', data: { ...stamp(20), path, nested_id, event: { method, params } } };
}

function liveView(): InnerView {
	return adoptInnerState(openView(CABIN), cabinState());
}

function change(mirror: Mirror, event: NetEvent): { mirror: Mirror; change: Change } {
	const result = applyEvent(mirror, event);
	if (result.outcome !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(result)}`);
	return result;
}

describe('the badge', () => {
	it('is the total count of the nets a token holds, and none for a token without nets', () => {
		expect(badgeCount({ id: '1', label: 'Bus', nets: [CABIN, { ...CABIN, nested_id: 'n2', count: 3 }] })).toBe(5);
		expect(badgeCount({ id: '1', label: 'Bus', nets: [{ ...CABIN, count: 0 }] })).toBe(0);
		expect(badgeCount({ id: '2', label: 'Ada' })).toBeNull();
		expect(badgeCount({ id: '2', label: 'Ada', nets: [] })).toBeNull();
	});

	it('reads 99+ past 99', () => {
		expect(badgeText(7)).toBe('7');
		expect(badgeText(99)).toBe('99');
		expect(badgeText(100)).toBe('99+');
	});

	it('moves with the inner net events of the token it badges, and the outer version does not', () => {
		const mirror = mirrorFromState(outerState());
		const added = moveBadge(mirror, unwrapNested(nested('n1', 'added', { place: 'Door', id: '3', label: 'Dan', ...stamp(5) }))!);
		expect(holderOf(added, 'n1')?.net.count).toBe(3);
		expect(added.marking_version).toBe(20);
		const fired = moveBadge(added, unwrapNested(nested('n1', 'fired', {
			transition: 'Sit', consumed: [['Door', '1']], produced: [['Seats', '4', 'Bram']], duration_ms: 1, ...stamp(6),
		}))!);
		expect(holderOf(fired, 'n1')?.net.count).toBe(3);
		const removed = moveBadge(fired, unwrapNested(nested('n1', 'removed', { place: 'Door', id: '3', ...stamp(7) }))!);
		expect(holderOf(removed, 'n1')?.net.count).toBe(2);
		// The mirror it came from is left as it was.
		expect(holderOf(mirror, 'n1')?.net.count).toBe(2);
	});

	it('is left alone by a line of a net no listed token holds, and by one that moves no count', () => {
		const mirror = mirrorFromState(outerState());
		expect(moveBadge(mirror, unwrapNested(nested('n9', 'added', { place: 'Door', id: '3', label: 'x', ...stamp(5) }))!)).toBe(mirror);
		expect(moveBadge(mirror, unwrapNested(nested('n1', 'fireable', { transitions: [], ...stamp(4) }))!)).toBe(mirror);
	});

	it('counts each inner notification as the Bevy viewer does', () => {
		const event = (kind: string, data: Record<string, unknown>) => ({ kind, data }) as NetEvent;
		expect(countDelta(event('launched', { consumed: [['Door', '1'], ['Door', '2']] }))).toBe(-2);
		expect(countDelta(event('distributed', { produced: [['Seats', '3', 'x']] }))).toBe(1);
		expect(countDelta(event('failed', { restored: true, consumed: [['Door', '1']] }))).toBe(1);
		expect(countDelta(event('failed', { restored: false, consumed: [['Door', '1']] }))).toBe(0);
		expect(countDelta(event('hidden', { kind: 'added', place: 'Door' }))).toBe(1);
		expect(countDelta(event('hidden', { kind: 'mutated', place: 'Door' }))).toBe(0);
		expect(countDelta(event('mutated', { place: 'Door', id: '1' }))).toBe(0);
		expect(countDelta(event('param_changed', { param: 'stopped' }))).toBe(0);
	});
});

describe('unwrapNested', () => {
	it('reads the inner notification as a top-level one', () => {
		const line = unwrapNested(nested('n1', 'added', { place: 'Door', id: '3', label: 'Dan', ...stamp(5) }));
		expect(line).toEqual({
			path: 'transit/Depot/#1/cabin',
			nested_id: 'n1',
			event: { kind: 'added', data: { place: 'Door', id: '3', label: 'Dan', ...stamp(5) } },
		});
	});

	it('reads nothing from another kind or a wrapper without its parts', () => {
		expect(unwrapNested({ kind: 'added', data: { place: 'Door', id: '3', label: 'x', ...stamp(1) } })).toBeNull();
		expect(unwrapNested({ kind: 'nested', data: { ...stamp(1), path: 'p', nested_id: 'n1' } } as unknown as NetEvent)).toBeNull();
	});
});

describe('routing nested lines to the inner mirror', () => {
	it('applies a line of the net shown at its own version, leaving the path current', () => {
		const line = unwrapNested(nested('n1', 'fired', {
			transition: 'Sit', consumed: [['Door', '1']], produced: [['Seats', '3', 'Bram']], duration_ms: 1, ...stamp(5),
		}, 'transit/In Transit/#7/cabin'))!;
		const routed = routeNested(liveView(), line)!;
		expect(routed.outcome.outcome).toBe('applied');
		expect(routed.view.mirror?.marking_version).toBe(5);
		expect(routed.view.mirror?.places.Seats.count).toBe(2);
		expect(routed.view.path).toBe('transit/In Transit/#7/cabin');
	});

	it('routes nothing for another nested id, or with no view open', () => {
		const line = unwrapNested(nested('n2', 'added', { place: 'Door', id: '3', label: 'x', ...stamp(5) }))!;
		expect(routeNested(liveView(), line)).toBeNull();
		expect(routeNested(null, line)).toBeNull();
	});

	it('keeps the inner version rule: a gap is reported and a stale line ignored', () => {
		const view = liveView();
		const gap = routeNested(view, unwrapNested(nested('n1', 'added', { place: 'Door', id: '3', label: 'x', ...stamp(7) }))!)!;
		expect(gap.outcome).toEqual({ outcome: 'gap', expected: 5, got: 7 });
		expect(gap.view.mirror).toBe(view.mirror);
		const stale = routeNested(view, unwrapNested(nested('n1', 'added', { place: 'Door', id: '3', label: 'x', ...stamp(4) }))!)!;
		expect(stale.outcome).toEqual({ outcome: 'stale' });
	});

	it('asks for a read on an inner reloaded', () => {
		const routed = routeNested(liveView(), unwrapNested(nested('n1', 'reloaded', { generation: 1, reason: 'resync', ...stamp(4) }))!)!;
		expect(routed.outcome.outcome).toBe('refetch');
	});

	it('only follows the path while the first read is on its way', () => {
		const opening = openView(CABIN);
		const routed = routeNested(opening, unwrapNested(nested('n1', 'added', { place: 'Door', id: '3', label: 'x', ...stamp(5) }, 'transit/In Transit/#7/cabin'))!)!;
		expect(routed.outcome).toEqual({ outcome: 'ignored' });
		expect(routed.view.mirror).toBeNull();
		expect(routed.view.path).toBe('transit/In Transit/#7/cabin');
	});

	it('is not applied to the outer mirror, whose version stays', () => {
		const outer = mirrorFromState(outerState());
		expect(applyEvent(outer, nested('n1', 'added', { place: 'Door', id: '3', label: 'x', ...stamp(5) }))).toEqual({ outcome: 'ignored' });
	});

	it('adopts a read of the inner net by its own version, with its path', () => {
		const view = liveView();
		const moved = adoptInnerState(view, cabinState({ path: 'transit/In Transit/#7/cabin' }));
		expect(moved.path).toBe('transit/In Transit/#7/cabin');
		expect(adoptInnerState(view, cabinState({ marking_version: 2 }))).toBe(view);
	});
});

describe('closing the inner mirror', () => {
	const outer = () => mirrorFromState(outerState());

	it('closes when the outer token holding it is removed', () => {
		const removed = change(outer(), { kind: 'removed', data: { place: 'Depot', id: '1', ...stamp(21) } });
		expect(afterOuterChange(liveView(), removed.change)).toEqual({
			fate: 'gone', notice: 'Inner net gone: its token was removed.',
		});
	});

	it('asks after the net when the firing that took its token lands, since it may have been put back', () => {
		const launched = change(outer(), {
			kind: 'launched', data: { transition: 'Depart', consumed: [['Depot', '1']], ...stamp(21) },
		});
		const taken = afterOuterChange(liveView(), launched.change);
		expect(taken.fate).toBe('kept');
		const view = (taken as { view: InnerView }).view;
		expect(view.takenBy).toBe('Depart');
		// Another firing landing first says nothing about it.
		const other: Change = { kind: 'distributed', transition: 'Board', produced: [] };
		expect(afterOuterChange(view, other)).toEqual({ fate: 'kept', view });
		const landed = change(launched.mirror, {
			kind: 'distributed', data: { transition: 'Depart', produced: [['In Transit', '7', 'Bus 1']], duration_ms: 1, ...stamp(22) },
		});
		const fate = afterOuterChange(view, landed.change);
		expect(fate).toMatchObject({ fate: 'ask', takenBy: 'Depart', view: { takenBy: null } });
	});

	it('asks at once after a firing in one piece that took its token', () => {
		const fired = change(outer(), {
			kind: 'fired',
			data: { transition: 'Depart', consumed: [['Depot', '1']], produced: [['In Transit', '7', 'Bus 1']], duration_ms: 1, ...stamp(21) },
		});
		expect(afterOuterChange(liveView(), fired.change)).toMatchObject({ fate: 'ask', takenBy: 'Depart' });
	});

	it('keeps the view through outer changes that do not touch its token', () => {
		const view = liveView();
		const boarded = change(outer(), {
			kind: 'launched', data: { transition: 'Board', consumed: [['Platform', '2']], ...stamp(21) },
		});
		expect(afterOuterChange(view, boarded.change)).toEqual({ fate: 'kept', view });
	});

	it('says why it closed', () => {
		expect(reloadedNotice('reset')).toBe('Inner net gone: the net was reset.');
		expect(reloadedNotice('load')).toBe('Inner net gone: the net was loaded again.');
		expect(reloadedNotice('resync')).toBe('Inner net gone: the net was reloaded.');
		const gone = Object.assign(new Error('no net n1'), { status: 404, reason: 'unknown_net' });
		expect(readFailedNotice(gone, 'Scrap')).toBe('Inner net gone: its token was consumed by Scrap.');
		expect(readFailedNotice(gone, null)).toBe('Inner net gone: it no longer exists.');
		expect(readFailedNotice(new Error('Worker did not answer'), null)).toBe('Could not read the inner net: Worker did not answer');
	});
});

describe('the holding token', () => {
	it('is read from the path, one level down', () => {
		expect(holderIdFromPath('transit/Depot/#17/cabin')).toBe('17');
		expect(holderIdFromPath('transit/In Transit/#21/')).toBe('21');
		expect(holderIdFromPath('cabin')).toBeNull();
	});

	it('follows the path, so a token put back without nets is still known as the holder', () => {
		const view = liveView();
		expect(view.holderId).toBe('1');
		const moved = routeNested(view, unwrapNested(nested('n1', 'fireable', { transitions: [], ...stamp(4) }, 'transit/In Transit/#7/cabin'))!)!;
		expect(moved.view.holderId).toBe('7');
		// The token in In Transit was produced, so the mirror lists it without nets.
		const taken: Change = {
			kind: 'launched', transition: 'Scrap',
			consumed: [{ place: 'In Transit', id: '7', token: { id: '7', label: 'Bus 1' }, slot: 0 }],
		};
		expect(afterOuterChange(moved.view, taken)).toMatchObject({ fate: 'kept', view: { takenBy: 'Scrap' } });
	});
});

describe('needsNetsRead', () => {
	it('is true when a token lands in a place whose tokens may hold nets, since produced entries carry no nets', () => {
		const launched = change(mirrorFromState(outerState()), {
			kind: 'launched', data: { transition: 'Depart', consumed: [['Depot', '1']], ...stamp(21) },
		});
		expect(needsNetsRead(launched.mirror, launched.change)).toBe(false);
		const landed = change(launched.mirror, {
			kind: 'distributed', data: { transition: 'Depart', produced: [['In Transit', '7', 'Bus 1']], duration_ms: 1, ...stamp(22) },
		});
		expect(needsNetsRead(landed.mirror, landed.change)).toBe(true);
		const added = change(mirrorFromState(outerState()), {
			kind: 'added', data: { place: 'Platform', id: '9', label: 'Eve', ...stamp(21) },
		});
		expect(needsNetsRead(added.mirror, added.change)).toBe(false);
	});
});

describe('the breadcrumb', () => {
	it('names the outer net, then the path inside it', () => {
		expect(breadcrumb('transit', 'transit/Depot/#17/cabin')).toBe('transit > Depot/#17/cabin');
		expect(breadcrumb('transit', 'transit/In Transit/#21/cabin')).toBe('transit > In Transit/#21/cabin');
	});

	it('shows a path it cannot shorten whole, and the net name without a path', () => {
		expect(breadcrumb('transit', 'other/Depot/#1/cabin')).toBe('transit > other/Depot/#1/cabin');
		expect(breadcrumb('transit', '', 'cabin')).toBe('transit > cabin');
	});
});

describe('outer firings seen from inside', () => {
	const event = (kind: string, data: Record<string, unknown> = {}) => ({ kind, data: { ...data, ...stamp(1) } }) as NetEvent;

	/** Each step at its time in milliseconds; the notes it gave. */
	function run(steps: Array<[number, 'outer' | 'inner' | 'settle', NetEvent?]>): Array<string | null> {
		let tracker: TouchTracker = NO_TOUCH;
		return steps.map(([at, side, step]) => {
			const next =
				side === 'outer' ? trackOuter(tracker, step!, at) : side === 'inner' ? trackInner(tracker, step!, at) : settleTouches(tracker, at);
			tracker = next.tracker;
			return next.note;
		});
	}

	it('names the outer firing under way when it reaches inside (two pieces, as Python sends it)', () => {
		expect(run([
			[0, 'outer', event('launched', { transition: 'Alight Central', consumed: [] })],
			[5, 'inner', event('removed', { place: 'Door', id: '1' })],
			[6, 'outer', event('mutated', { place: 'Central', id: '1' })],
			[8, 'outer', event('distributed', { transition: 'Alight Central', produced: [] })],
			[9, 'inner', event('fireable', { transitions: [] })],
		])).toEqual([null, 'outer: Alight Central', null, null, null]);
	});

	it('puts the lines before a one-piece fired down to that firing (as the Rust example binary sends it)', () => {
		expect(run([
			[0, 'inner', event('param_changed', { param: 'stopped' })],
			[1, 'inner', event('added', { place: 'Announcements', id: '4', label: 'Arrived' })],
			[2, 'outer', event('mutated', { place: 'Central', id: '1' })],
			[3, 'outer', event('fired', { transition: 'Arrive', consumed: [['In Transit', '1']], produced: [] })],
			[4, 'outer', event('fireable', { transitions: [] })],
			// The window ran out with nothing waiting: nothing more to say.
			[900, 'settle'],
		])).toEqual([null, null, null, 'outer: Arrive', null, null]);
	});

	it('counts a touch no firing claims within the window as from outside', () => {
		expect(run([
			[0, 'inner', event('added', { place: 'Door', id: '5', label: 'Dan' })],
			[TOUCH_CLAIM_MS - 1, 'settle'],
			[TOUCH_CLAIM_MS, 'settle'],
		])).toEqual([null, null, OUTSIDE_NOTE]);
		expect(run([
			[0, 'inner', event('added', { place: 'Door', id: '5', label: 'Dan' })],
			[TOUCH_CLAIM_MS + 50, 'outer', event('fired', { transition: 'Board', consumed: [], produced: [] })],
		])).toEqual([null, OUTSIDE_NOTE]);
	});

	it('settles a waiting touch as from outside when something other than a firing comes first', () => {
		expect(run([
			[0, 'inner', event('added', { place: 'Door', id: '5', label: 'Dan' })],
			[1, 'outer', event('added', { place: 'Platform', id: '9', label: 'Eve' })],
			[2, 'outer', event('fired', { transition: 'Board', consumed: [], produced: [] })],
		])).toEqual([null, OUTSIDE_NOTE, null]);
	});

	it('does not count the inner net own firings', () => {
		expect(run([
			[0, 'inner', event('launched', { transition: 'Sit', consumed: [] })],
			[1, 'inner', event('mutated', { place: 'Seats', id: '1' })],
			[2, 'inner', event('distributed', { transition: 'Sit', produced: [] })],
			[3, 'inner', event('mutated', { place: 'Seats', id: '1' })],
			[4, 'inner', event('fired', { transition: 'Stand', consumed: [], produced: [] })],
			[900, 'settle'],
		])).toEqual([null, null, null, null, null, null]);
	});

	it('reads as the Bevy viewer words it', () => {
		expect(outerNoteText('Alight Central')).toBe('outer: Alight Central');
	});
});

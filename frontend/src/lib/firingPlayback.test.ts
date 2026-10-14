import { describe, expect, it } from 'vitest';
import type { Change, Moved } from './netMirror';
import {
	activeEdges,
	busyTransitions,
	edgeEnds,
	flashingTransitions,
	hiddenTokenIds,
	liveCues,
	nextWake,
	playChange,
	travelling,
	type PlaybackContext,
	type TokenCue,
} from './firingPlayback';

const STAGE = 1200;

const POINTS: Record<string, { x: number; y: number }> = {
	Receiving: { x: 0, y: -120 },
	Sort: { x: 0, y: 0 },
	Sorting: { x: 0, y: 120 },
};

function ctx(now: number, stageOneEnds: Record<string, number> = {}): PlaybackContext {
	return {
		now,
		stageMs: STAGE,
		stageOneEnds,
		transitionAt: (name) => POINTS[name] ?? null,
		tokenAt: (place, slot) => {
			const p = POINTS[place];
			return p ? { x: p.x + (slot ?? 0), y: p.y } : null;
		},
		serial: now,
	};
}

const moved = (place: string, id: string, slot: number | null = 0): Moved => ({
	place,
	id,
	token: { id, label: id, color: '#123456' },
	slot,
});

const tokens = (cues: ReturnType<typeof playChange>['cues']) =>
	cues.filter((cue): cue is TokenCue => cue.kind === 'token');

describe('a firing in two pieces', () => {
	it('moves the consumed tokens to the transition on launched', () => {
		const change: Change = { kind: 'launched', transition: 'Sort', consumed: [moved('Receiving', '1', 2)] };
		const { cues, stageOneEnds } = playChange(change, ctx(1000));
		expect(tokens(cues)).toEqual([
			expect.objectContaining({
				id: '1',
				from: { x: 2, y: -120 },
				to: { x: 0, y: 0 },
				startAt: 1000,
				endsAt: 1000 + STAGE,
				fade: 'out',
				hides: false,
				edge: edgeEnds('in', 'Receiving', 'Sort'),
			}),
		]);
		expect(stageOneEnds).toEqual({ Sort: 1000 + STAGE });
	});

	it('sends the produced tokens out on distributed, once stage one is over', () => {
		// The body returned at once: distributed 10 ms after launched.
		const change: Change = { kind: 'distributed', transition: 'Sort', produced: [moved('Sorting', '4')] };
		const { cues, stageOneEnds } = playChange(change, ctx(1010, { Sort: 1000 + STAGE }));
		expect(tokens(cues)).toEqual([
			expect.objectContaining({
				id: '4',
				from: { x: 0, y: 0 },
				to: { x: 0, y: 120 },
				startAt: 1000 + STAGE,
				endsAt: 1000 + 2 * STAGE,
				fade: 'in',
				hides: true,
				edge: edgeEnds('out', 'Sorting', 'Sort'),
			}),
		]);
		expect(stageOneEnds).toEqual({});
	});

	it('sends them out at once when the body outlasted stage one', () => {
		const change: Change = { kind: 'distributed', transition: 'Sort', produced: [moved('Sorting', '4')] };
		const { cues } = playChange(change, ctx(9000, { Sort: 1000 + STAGE }));
		expect(tokens(cues)[0].startAt).toBe(9000);
	});
});

describe('a firing in one piece', () => {
	const fired: Change = {
		kind: 'fired',
		transition: 'Sort',
		consumed: [moved('Receiving', '1')],
		produced: [moved('Sorting', '4')],
	};

	it('plays stage one now and stage two a stage later', () => {
		const { cues } = playChange(fired, ctx(500));
		const [inward, outward] = tokens(cues);
		expect(inward).toMatchObject({ id: '1', startAt: 500, endsAt: 500 + STAGE, fade: 'out' });
		expect(outward).toMatchObject({ id: '4', startAt: 500 + STAGE, endsAt: 500 + 2 * STAGE, fade: 'in', hides: true });
	});

	it('shows only stage one during stage one, and only stage two after', () => {
		const { cues } = playChange(fired, ctx(500));
		expect(travelling(cues, 600).map((cue) => cue.id)).toEqual(['1']);
		expect(activeEdges(cues, 600)).toEqual(new Set([edgeEnds('in', 'Receiving', 'Sort')]));
		expect(travelling(cues, 500 + STAGE + 1).map((cue) => cue.id)).toEqual(['4']);
		expect(activeEdges(cues, 500 + STAGE + 1)).toEqual(new Set([edgeEnds('out', 'Sorting', 'Sort')]));
		expect(busyTransitions(cues, 600)).toEqual(new Set(['Sort']));
	});

	it('hides the produced token at its place, waiting included, until it lands', () => {
		const { cues } = playChange(fired, ctx(500));
		expect(hiddenTokenIds(cues, 600)).toEqual(new Set(['4']));
		expect(hiddenTokenIds(cues, 500 + 2 * STAGE)).toEqual(new Set());
	});

	it('wakes the clock at each start and end, and is over after both stages', () => {
		const { cues } = playChange(fired, ctx(500));
		expect(nextWake(cues, 500)).toBe(500 + STAGE);
		expect(nextWake(cues, 500 + STAGE)).toBe(500 + 2 * STAGE);
		expect(nextWake(cues, 500 + 2 * STAGE)).toBeNull();
		expect(liveCues(cues, 500 + 2 * STAGE)).toEqual([]);
	});
});

describe('a failure', () => {
	it('flashes the transition and sends restored tokens back after stage one', () => {
		const change: Change = {
			kind: 'failed',
			transition: 'Sort',
			error: 'boom',
			restored: true,
			consumed: [moved('Receiving', '1', 0)],
		};
		const { cues, stageOneEnds } = playChange(change, ctx(1100, { Sort: 1000 + STAGE }));
		expect(flashingTransitions(cues, 1100)).toEqual(new Set(['Sort']));
		expect(tokens(cues)).toEqual([
			expect.objectContaining({
				id: '1',
				from: { x: 0, y: 0 },
				to: { x: 0, y: -120 },
				startAt: 1000 + STAGE,
				fade: 'in',
				hides: true,
			}),
		]);
		expect(stageOneEnds).toEqual({});
	});

	it('only flashes when nothing was restored', () => {
		const change: Change = { kind: 'failed', transition: 'Sort', error: 'boom', restored: false, consumed: [moved('Receiving', '1')] };
		const { cues } = playChange(change, ctx(0));
		expect(tokens(cues)).toEqual([]);
		expect(cues).toHaveLength(1);
	});
});

describe('changes without cues', () => {
	it('plays nothing for added, removed, mutated and toggled', () => {
		const changes: Change[] = [
			{ kind: 'added', token: moved('Sorting', '9') },
			{ kind: 'removed', token: moved('Sorting', '9') },
			{ kind: 'mutated', place: 'Sorting', id: '9' },
			{ kind: 'toggled', transition: 'Sort', enabled: false },
		];
		for (const change of changes) expect(playChange(change, ctx(0)).cues).toEqual([]);
	});

	it('skips a token whose transition is not drawn', () => {
		const change: Change = { kind: 'launched', transition: 'Gone', consumed: [moved('Receiving', '1')] };
		expect(playChange(change, ctx(0)).cues).toEqual([]);
	});
});

describe('a keyed token', () => {
	it('travels with its keys, so a token filter can hide its cue', () => {
		const keyed: Moved = { place: 'Receiving', id: '1', token: { id: '1', label: 'P', keys: { zone: 'north' } }, slot: 0 };
		const change: Change = { kind: 'launched', transition: 'Sort', consumed: [keyed, moved('Receiving', '2', 1)] };
		const [first, second] = tokens(playChange(change, ctx(1000)).cues);
		expect(first.keys).toEqual({ zone: 'north' });
		expect(second.keys).toBeUndefined();
	});
});

/**
 * How the nets page animates what the mirror applied: cues, each a token
 * travelling between a place and a transition, or a transition flashing,
 * over a window of time.
 *
 * A firing plays in two stages of `stageMs` each (`TOKEN_STAGE_MS`): the
 * consumed tokens travel from their places to the transition, then the
 * produced ones travel out. The protocol reports a firing in either of two
 * shapes (§6.3), and both play the same way:
 *
 * - `launched` then `distributed` (both runners): stage one on `launched`;
 *   stage two on `distributed`, but never before stage one has finished, so a
 *   body that returns at once does not send its outputs out while its inputs
 *   are still on their way in.
 * - `fired` (a one-piece runtime): stage one now, stage two `stageMs` later.
 *
 * A `failed` flashes its transition, and restored tokens travel back to their
 * places once stage one is over. A token travelling to a place is hidden at
 * that place until it lands, and is not drawn while its cue waits to start,
 * as the Bevy view settled. `added`, `removed`, `mutated` and `toggled` need
 * no cue: the drawing follows the mirror.
 *
 * Everything is pure; the page owns the clock.
 */

import type { Change, Moved } from '$lib/netMirror';
import type { Keys, Point } from '$lib/types';

export interface TokenCue {
	kind: 'token';
	key: string;
	id: string;
	color: string | undefined;
	from: Point;
	to: Point;
	startAt: number;
	endsAt: number;
	/** Leaving a place it fades out; arriving at one it fades in. */
	fade: 'out' | 'in';
	/** It is travelling to a place: the token is not drawn there until it lands. */
	hides: boolean;
	transition: string;
	/** The edge it travels along, as `edgeEnds` spells it. */
	edge: string;
	/** The token's keys as the mirror knew them, so a token filter can hide
	 *  the cue of a token it hides. */
	keys?: Keys;
}

export interface FlashCue {
	kind: 'flash';
	key: string;
	transition: string;
	startAt: number;
	endsAt: number;
}

export type Cue = TokenCue | FlashCue;

export interface PlaybackContext {
	now: number;
	stageMs: number;
	/** When each transition's current stage one ends. */
	stageOneEnds: Readonly<Record<string, number>>;
	/** A transition's centre, or null if it is not drawn. */
	transitionAt(name: string): Point | null;
	/** Where a token in `slot` of `place` is drawn; the place's centre for a
	 *  token not drawn there (null slot, or beyond the drawn dots). */
	tokenAt(place: string, slot: number | null): Point | null;
	/** A unique suffix for cue keys. */
	serial: number;
}

export interface Playback {
	cues: Cue[];
	stageOneEnds: Record<string, number>;
}

/** The key two cues share when they travel the same edge. */
export function edgeEnds(direction: 'in' | 'out', place: string, transition: string): string {
	return `${direction}|${place}|${transition}`;
}

const DEFAULT_COLOR = '#9ca3af';

function travel(
	ctx: PlaybackContext,
	transition: string,
	moved: Moved[],
	direction: 'in' | 'out',
	startAt: number,
	tag: string,
): TokenCue[] {
	const centre = ctx.transitionAt(transition);
	if (!centre) return [];
	return moved.flatMap((token, index) => {
		const at = ctx.tokenAt(token.place, token.slot);
		if (!at) return [];
		const leaving = direction === 'in';
		return [
			{
				kind: 'token' as const,
				key: `${ctx.serial}:${tag}:${index}:${token.id}`,
				id: token.id,
				color: token.token?.color ?? DEFAULT_COLOR,
				from: leaving ? at : centre,
				to: leaving ? centre : at,
				startAt,
				endsAt: startAt + ctx.stageMs,
				fade: leaving ? ('out' as const) : ('in' as const),
				hides: !leaving,
				transition,
				edge: edgeEnds(direction, token.place, transition),
				...(token.token?.keys ? { keys: token.token.keys } : {}),
			},
		];
	});
}

function without(record: Readonly<Record<string, number>>, key: string): Record<string, number> {
	const { [key]: _, ...rest } = record;
	return rest;
}

/** The cues one applied change plays. */
export function playChange(change: Change, ctx: PlaybackContext): Playback {
	const { now, stageMs } = ctx;
	switch (change.kind) {
		case 'launched':
			return {
				cues: travel(ctx, change.transition, change.consumed, 'in', now, 'in'),
				stageOneEnds: { ...ctx.stageOneEnds, [change.transition]: now + stageMs },
			};
		case 'distributed': {
			const startAt = Math.max(now, ctx.stageOneEnds[change.transition] ?? now);
			return {
				cues: travel(ctx, change.transition, change.produced, 'out', startAt, 'out'),
				stageOneEnds: without(ctx.stageOneEnds, change.transition),
			};
		}
		case 'fired':
			return {
				cues: [
					...travel(ctx, change.transition, change.consumed, 'in', now, 'in'),
					...travel(ctx, change.transition, change.produced, 'out', now + stageMs, 'out'),
				],
				stageOneEnds: without(ctx.stageOneEnds, change.transition),
			};
		case 'failed': {
			const back = Math.max(now, ctx.stageOneEnds[change.transition] ?? now);
			const flash: FlashCue = {
				kind: 'flash',
				key: `${ctx.serial}:flash:${change.transition}`,
				transition: change.transition,
				startAt: now,
				endsAt: Math.max(now + stageMs, back + (change.restored ? stageMs : 0)),
			};
			const restored = change.restored
				? travel(ctx, change.transition, change.consumed.filter((m) => m.token), 'out', back, 'back')
				: [];
			return {
				cues: [flash, ...restored],
				stageOneEnds: without(ctx.stageOneEnds, change.transition),
			};
		}
		default:
			return { cues: [], stageOneEnds: { ...ctx.stageOneEnds } };
	}
}

/** Cues not yet over. */
export function liveCues(cues: readonly Cue[], now: number): Cue[] {
	return cues.filter((cue) => cue.endsAt > now);
}

/** Token cues under way: started and not over. */
export function travelling(cues: readonly Cue[], now: number): TokenCue[] {
	return cues.filter((cue): cue is TokenCue => cue.kind === 'token' && cue.startAt <= now && now < cue.endsAt);
}

/** Ids of tokens on their way to a place, hidden there until they land. */
export function hiddenTokenIds(cues: readonly Cue[], now: number): Set<string> {
	return new Set(
		cues.flatMap((cue) => (cue.kind === 'token' && cue.hides && now < cue.endsAt ? [cue.id] : [])),
	);
}

/** Edges a token is travelling along now, as `edgeEnds` spells them. */
export function activeEdges(cues: readonly Cue[], now: number): Set<string> {
	return new Set(travelling(cues, now).map((cue) => cue.edge));
}

/** Transitions with tokens travelling to or from them now. */
export function busyTransitions(cues: readonly Cue[], now: number): Set<string> {
	return new Set(travelling(cues, now).map((cue) => cue.transition));
}

/** Transitions flashing a failure now. */
export function flashingTransitions(cues: readonly Cue[], now: number): Set<string> {
	return new Set(
		cues.flatMap((cue) => (cue.kind === 'flash' && cue.startAt <= now && now < cue.endsAt ? [cue.transition] : [])),
	);
}

/** The next time after `now` at which a cue starts or ends, or null. */
export function nextWake(cues: readonly Cue[], now: number): number | null {
	const times = cues.flatMap((cue) => [cue.startAt, cue.endsAt]).filter((time) => time > now);
	return times.length ? Math.min(...times) : null;
}

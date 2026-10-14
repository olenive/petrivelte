/**
 * Inner nets on the nets page (protocol §12): the badge of a token that
 * holds nets, the one inner net the page may show and how `nested` events
 * reach it, when that inner net is gone, the breadcrumb, and which outer
 * firing touched it. The Bevy viewer does the same (its DESIGN §3.5); this
 * page shows one inner net at a time, in place of the outer one, one level
 * deep.
 *
 * - **The badge.** A token that holds nets is badged with the total `count`
 *   of its nets. The count is a hint (§12.3): read with a full token entry,
 *   then moved by the `nested` events of those nets (`added` +1, `removed`
 *   −1, `launched` −consumed, `distributed` +produced, `fired` both, a
 *   restoring `failed` +consumed) without moving the outer version. A token
 *   a firing put down has no `nets` until the next state read, since a
 *   produced entry carries none (§12.2): `needsNetsRead` says when to read.
 * - **The view.** Opening a net makes an `InnerView`: its own mirror, fed by
 *   `GET .../execution/state?nested_id=` and by the `nested` lines of that
 *   net, unwrapped and applied under the inner net's own version rule
 *   (`routeNested`). Lines of any other net only move badges.
 * - **Gone.** An outer `removed` of the token holding it closes the view at
 *   once. An outer firing that takes that token may put it back (the common
 *   move: the net keeps its nested id and the token gets a new id, §12.6),
 *   so the view is asked after when that firing lands: an answer says where
 *   the net is now, a 404 `unknown_net` that it is gone. An outer
 *   `reloaded` closes it (§12.6: a reset or a load drops every inner net).
 *   The holding token is known by its id, read from the latest path (its
 *   `#id` segment), since the token a firing put back carries no `nets`
 *   until the next state read; a token whose listed `nets` name the view's
 *   net counts too.
 * - **Outer firings seen from inside.** An inner `added`, `removed`,
 *   `mutated`, `param_changed` or `hidden` that is not one of the inner
 *   net's own firings is an outer firing reaching inside: put down to the
 *   outer firing under way, or, for a runtime reporting a firing in one
 *   piece (whose inner lines come before its `fired`), claimed by the next
 *   outer `launched` or `fired`.
 */

import type { InnerNetRef, MarkingToken, NetEvent, NetState } from '$lib/types';
import {
	DEFAULT_TOKEN_LIMIT,
	applyEvent,
	mirrorFromState,
	shouldAdopt,
	type ApplyOutcome,
	type Change,
	type Mirror,
	type Moved,
} from '$lib/netMirror';

// -- the badge --

/** The total count of the nets a token holds, or null for a token that holds none. */
export function badgeCount(token: MarkingToken): number | null {
	if (!Array.isArray(token.nets) || token.nets.length === 0) return null;
	return token.nets.reduce((sum, net) => sum + (Number.isFinite(net.count) ? net.count : 0), 0);
}

/** What the badge reads: the count, `99+` past 99. */
export function badgeText(count: number): string {
	return count > 99 ? '99+' : String(count);
}

// -- nested lines --

/** A `nested` wrapper unwrapped: which inner net, and its own notification
 *  read as a top-level one. */
export interface NestedLine {
	path: string;
	nested_id: string;
	event: NetEvent;
}

/** The line a `nested` event carries, or null for any other event and for a
 *  wrapper missing its parts. */
export function unwrapNested(event: NetEvent): NestedLine | null {
	if (event.kind !== 'nested') return null;
	const data = event.data;
	const inner = data?.event;
	if (typeof data?.nested_id !== 'string' || !inner || typeof inner.method !== 'string') return null;
	return {
		path: typeof data.path === 'string' ? data.path : '',
		nested_id: data.nested_id,
		event: { kind: inner.method, data: inner.params ?? {} } as NetEvent,
	};
}

function listLength(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

/** How an inner notification moves the number of tokens in its net. */
export function countDelta(event: NetEvent): number {
	const data = event.data as Record<string, unknown> | undefined;
	switch (event.kind) {
		case 'added':
			return 1;
		case 'removed':
			return -1;
		case 'launched':
			return -listLength(data?.consumed);
		case 'distributed':
			return listLength(data?.produced);
		case 'fired':
			return listLength(data?.produced) - listLength(data?.consumed);
		case 'failed':
			return data?.restored === true ? listLength(data?.consumed) : 0;
		case 'hidden':
			return data?.kind === 'added' ? 1 : data?.kind === 'removed' ? -1 : 0;
		default:
			return 0;
	}
}

/** The token of `mirror` holding inner net `nestedId`, with its place and
 *  the net's entry, or null when no listed token holds it. */
export function holderOf(
	mirror: Mirror,
	nestedId: string,
): { place: string; token: MarkingToken; net: InnerNetRef } | null {
	for (const place of mirror.topology.places) {
		for (const token of mirror.places[place.name]?.tokens ?? []) {
			const net = token.nets?.find((each) => each.nested_id === nestedId);
			if (net) return { place: place.name, token, net };
		}
	}
	return null;
}

/**
 * Move the badge of the token holding the line's net by what the line
 * says. The outer version does not move: the count is a hint, and the
 * next state read replaces it. The same mirror when nothing changes.
 */
export function moveBadge(mirror: Mirror, line: NestedLine): Mirror {
	const delta = countDelta(line.event);
	if (delta === 0) return mirror;
	const holder = holderOf(mirror, line.nested_id);
	if (!holder) return mirror;
	const record = mirror.places[holder.place];
	const tokens = record.tokens.map((token) =>
		token.id !== holder.token.id
			? token
			: {
					...token,
					nets: (token.nets ?? []).map((net) =>
						net.nested_id === line.nested_id ? { ...net, count: Math.max(0, net.count + delta) } : net,
					),
				},
	);
	return { ...mirror, places: { ...mirror.places, [holder.place]: { ...record, tokens } } };
}

/** Whether an applied outer change put a token into a place whose tokens may
 *  hold nets: such a token's `nets` come only with a full entry, so the
 *  state is read again to badge it. */
export function needsNetsRead(mirror: Mirror, change: Change): boolean {
	const into = (moved: Moved[]) => moved.some((each) => mirror.places[each.place]?.nested === true);
	switch (change.kind) {
		case 'distributed':
			return into(change.produced);
		case 'fired':
			return into(change.produced);
		case 'added':
			return into([change.token]);
		case 'failed':
			return change.restored && into(change.consumed);
		default:
			return false;
	}
}

// -- the inner view --

export interface InnerView {
	/** The inner net's stable name (§12.1). */
	nested_id: string;
	/** Its name within its token. */
	name: string;
	template?: string;
	/** Its path as of the latest word, a state read or a `nested` line. */
	path: string;
	/** The id of the outer token holding it, as of that path. */
	holderId: string | null;
	/** Its own mirror, null until its first state read answers. */
	mirror: Mirror | null;
	/** The outer transition whose firing took the token holding it, until
	 *  that firing lands and the net is asked after. */
	takenBy: string | null;
}

/**
 * The id of the token holding a net one level down, from its path
 * (`transit/Depot/#17/cabin`, or `.../#17/` for a token that is itself a
 * net): the last `#` segment but the net's name. Null when the path has
 * none.
 */
export function holderIdFromPath(path: string): string | null {
	const found = /\/#([^/]+)\/[^/]*$/.exec(path);
	return found ? found[1] : null;
}

/** The view with its path moved, and the holder with it. */
function movedTo(view: InnerView, path: string): InnerView {
	if (!path || path === view.path) return view;
	return { ...view, path, holderId: holderIdFromPath(path) ?? view.holderId };
}

/** A view on one of a token's nets, waiting for its first state read;
 *  `holderId` is the token it was opened from. */
export function openView(ref: InnerNetRef, holderId: string | null = null): InnerView {
	return {
		nested_id: ref.nested_id,
		name: ref.name,
		...(ref.template !== undefined ? { template: ref.template } : {}),
		path: ref.path,
		holderId: holderId ?? holderIdFromPath(ref.path),
		mirror: null,
		takenBy: null,
	};
}

/** Adopt a state read of the view's net, by the inner net's own version
 *  rule; its `path` says where the net is now. */
export function adoptInnerState(view: InnerView, state: NetState, tokenLimit = DEFAULT_TOKEN_LIMIT): InnerView {
	if (!shouldAdopt(view.mirror, state)) return view;
	return {
		...movedTo(view, typeof state.path === 'string' ? state.path : ''),
		mirror: mirrorFromState(state, tokenLimit),
		...(typeof state.template === 'string' ? { template: state.template } : {}),
	};
}

/**
 * Route a `nested` line to the view, when it is about the view's net: the
 * path follows the line, and the inner event is applied to the view's
 * mirror under the inner net's version rule (a gap or an inner `reloaded`
 * asks for a read of the inner net). Null for a line of another net, or
 * with no view open.
 */
export function routeNested(
	view: InnerView | null,
	line: NestedLine,
): { view: InnerView; outcome: ApplyOutcome } | null {
	if (!view || view.nested_id !== line.nested_id) return null;
	const moved = movedTo(view, line.path);
	if (!moved.mirror) return { view: moved, outcome: { outcome: 'ignored' } };
	const outcome = applyEvent(moved.mirror, line.event);
	return {
		view: outcome.outcome === 'applied' ? { ...moved, mirror: outcome.mirror } : moved,
		outcome,
	};
}

/** What an applied outer change means for the view. */
export type InnerFate =
	| { fate: 'kept'; view: InnerView }
	/** Read the inner net again: its answer says where it is now, or that it
	 *  is gone. `takenBy` is the firing that took its token, if one did. */
	| { fate: 'ask'; view: InnerView; takenBy: string | null }
	| { fate: 'gone'; notice: string };

/** Whether a moved token is the one holding the view's net. */
function holds(moved: Moved, view: InnerView): boolean {
	if (view.holderId !== null && moved.id === view.holderId) return true;
	return moved.token?.nets?.some((net) => net.nested_id === view.nested_id) === true;
}

export function afterOuterChange(view: InnerView, change: Change): InnerFate {
	switch (change.kind) {
		case 'removed':
			return holds(change.token, view)
				? { fate: 'gone', notice: 'Inner net gone: its token was removed.' }
				: { fate: 'kept', view };
		case 'launched':
			return change.consumed.some((moved) => holds(moved, view))
				? { fate: 'kept', view: { ...view, takenBy: change.transition } }
				: { fate: 'kept', view };
		case 'fired':
			// One piece: taken and landed at once.
			return change.consumed.some((moved) => holds(moved, view))
				? { fate: 'ask', view: { ...view, takenBy: null }, takenBy: change.transition }
				: { fate: 'kept', view };
		case 'distributed':
		case 'failed':
			return view.takenBy === change.transition
				? { fate: 'ask', view: { ...view, takenBy: null }, takenBy: change.transition }
				: { fate: 'kept', view };
		default:
			return { fate: 'kept', view };
	}
}

/** The notice an outer `reloaded` leaves when it closes the view. */
export function reloadedNotice(reason: unknown): string {
	if (reason === 'reset') return 'Inner net gone: the net was reset.';
	if (reason === 'load') return 'Inner net gone: the net was loaded again.';
	return 'Inner net gone: the net was reloaded.';
}

/** The notice a failed read of the view's net leaves when it closes it: a
 *  404 `unknown_net` is the net gone, anything else a read that failed. */
export function readFailedNotice(error: unknown, takenBy: string | null): string {
	// Read by shape rather than by class, so this module needs no client.
	const reason = error && typeof error === 'object' ? (error as { reason?: unknown }).reason : undefined;
	if (reason === 'unknown_net') {
		return takenBy
			? `Inner net gone: its token was consumed by ${takenBy}.`
			: 'Inner net gone: it no longer exists.';
	}
	const message = error instanceof Error ? error.message : String(error);
	return `Could not read the inner net: ${message}`;
}

/** `transit > Depot/#17/cabin`: the outer net's name, then the path after
 *  it. A path that does not begin with that name is shown whole; without a
 *  path the net's name stands in. */
export function breadcrumb(outerNet: string, path: string, name = ''): string {
	const prefix = `${outerNet}/`;
	const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path || name;
	return rest ? `${outerNet} > ${rest}` : outerNet;
}

// -- outer firings seen from inside --

/** How long the page names an outer firing that touched the inner net. */
export const OUTER_NOTE_MS = 3000;

/**
 * How long an inner touch with no outer firing under way waits for one to
 * claim it. A runtime reporting a firing in one piece (the Rust runner's
 * example binary) writes the firing's inner lines first and its `fired`
 * last, in one burst; a touch no firing claims within this was made from
 * outside any firing, such as an inject.
 */
export const TOUCH_CLAIM_MS = 400;

/** The note for a touch no outer firing claimed. */
export const OUTSIDE_NOTE = 'from outside: not an outer firing';

export interface TouchTracker {
	/** Outer transitions launched and not yet landed, oldest first. */
	underway: readonly string[];
	/** When the latest inner touch came with no outer firing under way, while
	 *  it waits to be claimed; null when none waits. */
	pendingAt: number | null;
	/** The inner net's own firings under way. */
	innerUnderway: number;
}

export const NO_TOUCH: TouchTracker = { underway: [], pendingAt: null, innerUnderway: 0 };

const TOUCHES = new Set(['added', 'removed', 'mutated', 'param_changed', 'hidden']);

/** What a tracker step says: the tracker after it, and the line to show
 *  (`outer: Board`, or `OUTSIDE_NOTE`), if any. */
export interface Tracked {
	tracker: TouchTracker;
	note: string | null;
}

function withoutFirst(list: readonly string[], name: string): string[] {
	const at = list.indexOf(name);
	return at < 0 ? [...list] : [...list.slice(0, at), ...list.slice(at + 1)];
}

/** The line naming an outer firing. */
export function outerNoteText(transition: string): string {
	return `outer: ${transition}`;
}

/** A waiting touch claimed by `transition` if it is still within the
 *  window, else settled as from outside; no note when none waits. */
function claim(tracker: TouchTracker, transition: string | null, now: number): string | null {
	if (tracker.pendingAt === null) return null;
	if (transition && now - tracker.pendingAt <= TOUCH_CLAIM_MS) return outerNoteText(transition);
	return OUTSIDE_NOTE;
}

/**
 * An outer event at time `now`: keeps what is under way, and names the
 * firing a waiting touch is put down to. A `launched` or a one-piece
 * `fired` within the window claims it; a landing, an `added`, a `removed`
 * or a `toggled` first means no firing will, and it is settled as from
 * outside.
 */
export function trackOuter(tracker: TouchTracker, event: NetEvent, now: number): Tracked {
	const data = event.data as Record<string, unknown> | undefined;
	const transition = typeof data?.transition === 'string' ? data.transition : null;
	switch (event.kind) {
		case 'launched':
			return {
				tracker: {
					...tracker,
					underway: transition ? [...tracker.underway, transition] : [...tracker.underway],
					pendingAt: null,
				},
				note: claim(tracker, transition, now),
			};
		case 'fired':
			return { tracker: { ...tracker, pendingAt: null }, note: claim(tracker, transition, now) };
		case 'distributed':
		case 'failed':
			return {
				tracker: {
					...tracker,
					underway: transition ? withoutFirst(tracker.underway, transition) : [...tracker.underway],
					pendingAt: null,
				},
				note: claim(tracker, null, now),
			};
		case 'added':
		case 'removed':
		case 'toggled':
			return { tracker: { ...tracker, pendingAt: null }, note: claim(tracker, null, now) };
		case 'reloaded':
			return { tracker: NO_TOUCH, note: null };
		default:
			return { tracker, note: null };
	}
}

/**
 * An inner event of the net shown, at time `now`: a touch from outside its
 * own firings is named after the outer firing under way (two pieces: the
 * runner writes it between `launched` and the landing), or waits for the
 * next outer `launched` or `fired` (one piece: written before its `fired`).
 */
export function trackInner(tracker: TouchTracker, event: NetEvent, now: number): Tracked {
	switch (event.kind) {
		case 'launched':
			return { tracker: { ...tracker, innerUnderway: tracker.innerUnderway + 1 }, note: null };
		case 'distributed':
		case 'failed':
			return { tracker: { ...tracker, innerUnderway: Math.max(0, tracker.innerUnderway - 1) }, note: null };
		case 'fired':
			// A one-piece inner firing: the mutations just before it were its own.
			return { tracker: { ...tracker, pendingAt: null }, note: null };
	}
	if (!TOUCHES.has(event.kind)) return { tracker, note: null };
	if (event.kind === 'mutated' && tracker.innerUnderway > 0) return { tracker, note: null };
	const current = tracker.underway[tracker.underway.length - 1];
	if (current) return { tracker, note: outerNoteText(current) };
	return { tracker: { ...tracker, pendingAt: now }, note: null };
}

/** At time `now`: a touch that waited the whole window unclaimed was made
 *  from outside any firing. The page calls it when the window runs out. */
export function settleTouches(tracker: TouchTracker, now: number): Tracked {
	if (tracker.pendingAt === null || now - tracker.pendingAt < TOUCH_CLAIM_MS) return { tracker, note: null };
	return { tracker: { ...tracker, pendingAt: null }, note: OUTSIDE_NOTE };
}

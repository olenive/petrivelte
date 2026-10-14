/**
 * What the nets page believes about the net's marking, kept equal to the net
 * process by applying its notifications (protocol §4, §7).
 *
 * The mirror starts from a state read and moves only by state notifications,
 * each of which raises `marking_version` by exactly one. A notification is
 * applied at the held version plus one and no other: an older one is already
 * in the mirror and is ignored; a later one means one was missed, so nothing
 * is applied and the caller refetches the state. `reloaded` always means
 * refetch. A notification naming a place or transition the mirror does not
 * have applies nothing either and also means refetch.
 *
 * Per place, `count` is the truth and `tokens` a capped list, the oldest
 * first. A produced or added token joins the list only while the list is
 * complete (it holds every token) and under the cap; beyond that it only
 * raises the count, as a state read would show it. A token the mirror does
 * not know (it sat beyond the cap) still moves the count. A place whose list
 * has fallen short of what a state read would list is reported, so the
 * caller can refetch when the shortfall shows.
 *
 * Every function here returns a new mirror and leaves its argument alone. It
 * matches the Bevy visualiser's mirror (`src/remote/mirror.rs`) in
 * behaviour: `fireable` moves no version, `failed` with `restored` puts the
 * tokens back at the front of their places, a launched firing's tokens are
 * kept by transition so a restore brings back their labels.
 *
 * Keys and nets (protocol §12, §13). A token keeps the `keys` and `nets` its
 * last entry carried: a produced entry's fifth element, an `added` and a
 * `mutated` bring keys as they stand after the change; `nets` come only with
 * full entries (a state read), so a token a firing put down has none until
 * the next read. `hidden` (a projection's stand-in for a token it hides)
 * moves the version and, for `added` and `removed`, the place's count, and
 * nothing else. `nested` is not this mirror's: an inner net's events move
 * the inner net's own version, never the outer one, and are routed to an
 * inner mirror by `innerNets.ts`.
 */

import type {
	Keys,
	MarkingToken,
	NetEvent,
	NetState,
	PlaceToken,
	ProducedToken,
	Progress,
	StateEvent,
	Topology,
	TransitionState,
} from '$lib/types';
import { isStateEvent } from '$lib/types';

/** The page's `token_limit` on state reads; the protocol's default. */
export const DEFAULT_TOKEN_LIMIT = 200;

export interface MirrorPlace {
	name: string;
	type_name?: string;
	serializable: boolean;
	/** Its tokens may hold nets (§12.2). */
	nested?: boolean;
	/** Its inner nets are stepped only by an outer body. */
	passive?: boolean;
	/** The keys it derives from its tokens, in declaration order (§13.1). */
	key_names?: string[];
	/** The true number of tokens. */
	count: number;
	/** The tokens the mirror knows, oldest first; at most `tokenLimit`. */
	tokens: MarkingToken[];
}

/** A token a launched firing took, kept until the firing lands. */
export interface Airborne {
	place: string;
	token: MarkingToken;
}

export interface Mirror {
	net: string;
	runtime: string;
	generation: number;
	marking_version: number;
	running: boolean;
	topology: Topology;
	/** By name, every place of the topology. */
	places: Record<string, MirrorPlace>;
	/** By name, every transition of the topology. */
	transitions: Record<string, TransitionState>;
	progress: Progress;
	airborne: Record<string, Airborne[]>;
	tokenLimit: number;
}

/** One token's move, as the animation needs it. */
export interface Moved {
	place: string;
	id: string;
	/** What the mirror knew of it; null for a token beyond the cap. */
	token: MarkingToken | null;
	/** Its index in the place's list: before the move for a token leaving,
	 *  after it for a token arriving. Null when it is not in the list. */
	slot: number | null;
}

/** What an applied notification changed, for the animation and the page. */
export type Change =
	| { kind: 'launched'; transition: string; consumed: Moved[] }
	| { kind: 'distributed'; transition: string; produced: Moved[] }
	| { kind: 'fired'; transition: string; consumed: Moved[]; produced: Moved[] }
	| { kind: 'failed'; transition: string; error: string; restored: boolean; consumed: Moved[] }
	| { kind: 'added'; token: Moved }
	| { kind: 'removed'; token: Moved }
	| { kind: 'mutated'; place: string; id: string }
	| { kind: 'hidden'; place: string; what: 'added' | 'removed' | 'mutated' }
	| { kind: 'toggled'; transition: string; enabled: boolean }
	| { kind: 'param_changed' }
	| { kind: 'fireable' }
	| { kind: 'stopped' };

export type ApplyOutcome =
	/** Applied. `short` names the places whose list fell short. */
	| { outcome: 'applied'; mirror: Mirror; change: Change; short: string[] }
	/** At or below the held version: already in the mirror. */
	| { outcome: 'stale' }
	/** Not the next version: something was missed. Refetch. */
	| { outcome: 'gap'; expected: number; got: number }
	/** `reloaded`, or a name the mirror does not have. Refetch. */
	| { outcome: 'refetch'; reason: string }
	/** Nothing for the mirror (a host event, a heartbeat). */
	| { outcome: 'ignored' };

/** A mirror of a whole state read with `token_limit` `tokenLimit`. */
export function mirrorFromState(state: NetState, tokenLimit = DEFAULT_TOKEN_LIMIT): Mirror {
	const topology: Topology = {
		places: state.topology?.places ?? [],
		transitions: state.topology?.transitions ?? [],
		edges: state.topology?.edges ?? [],
		...(state.topology?.hints ? { hints: state.topology.hints } : {}),
	};
	const marking = state.marking?.places ?? {};
	const places = Object.fromEntries(
		topology.places.map((place) => {
			const held = marking[place.name];
			return [
				place.name,
				{
					name: place.name,
					type_name: place.type_name,
					serializable: place.serializable === true,
					...(place.nested === true ? { nested: true } : {}),
					...(place.passive === true ? { passive: true } : {}),
					...(Array.isArray(place.key_names) ? { key_names: place.key_names } : {}),
					count: held?.count ?? held?.tokens?.length ?? 0,
					tokens: held?.tokens ?? [],
				},
			];
		}),
	);
	const transitions = Object.fromEntries(
		topology.transitions.map((transition) => [
			transition.name,
			state.transitions?.[transition.name] ?? { enabled: true, fireable: false, in_flight: false },
		]),
	);
	return {
		net: state.net,
		runtime: state.runtime,
		generation: state.generation,
		marking_version: state.marking_version,
		running: state.running === true,
		topology,
		places,
		transitions,
		progress: state.progress ?? {
			step_count: 0,
			last_fired: null,
			fired_counts: {},
			last_progress_at: null,
		},
		airborne: {},
		tokenLimit,
	};
}

/**
 * Whether a fresh state read should replace the mirror: always for another
 * generation, and otherwise only if it is not older than what the mirror
 * holds, since notifications applied after the read was answered would
 * otherwise be undone.
 */
export function shouldAdopt(held: Mirror | null, fetched: NetState): boolean {
	if (!held) return true;
	if (fetched.generation !== held.generation) return true;
	return fetched.marking_version >= held.marking_version;
}

/** Whether a place's list holds fewer tokens than a state read would list. */
export function isShort(place: MirrorPlace, limit: number): boolean {
	return place.tokens.length < Math.min(place.count, limit);
}

/** Apply one worker stream event to the mirror. */
export function applyEvent(mirror: Mirror, event: NetEvent): ApplyOutcome {
	if (isStateEvent(event)) return applyStateEvent(mirror, event);
	switch (event.kind) {
		case 'reloaded':
			return { outcome: 'refetch', reason: `reloaded (${event.data?.reason ?? 'unknown'})` };
		case 'fireable': {
			const names = new Set(event.data?.transitions ?? []);
			const transitions = mapValues(mirror.transitions, (state, name) =>
				state.fireable === names.has(name) ? state : { ...state, fireable: names.has(name) },
			);
			return { outcome: 'applied', mirror: { ...mirror, transitions }, change: { kind: 'fireable' }, short: [] };
		}
		case 'execution_stopped':
			return {
				outcome: 'applied',
				mirror: { ...mirror, running: false },
				change: { kind: 'stopped' },
				short: [],
			};
		case 'nested':
			// An inner net's event: it moves no version of this net and is
			// never a gap here (§7.2, §12.3). `innerNets.ts` routes it.
			return { outcome: 'ignored' };
		default:
			return { outcome: 'ignored' };
	}
}

function applyStateEvent(mirror: Mirror, event: StateEvent): ApplyOutcome {
	const version = event.data?.marking_version;
	if (typeof version !== 'number') return { outcome: 'refetch', reason: `${event.kind} without a version` };
	if (version <= mirror.marking_version) return { outcome: 'stale' };
	const expected = mirror.marking_version + 1;
	if (version !== expected) return { outcome: 'gap', expected, got: version };
	const unknown = unknownName(mirror, event);
	if (unknown) return { outcome: 'refetch', reason: `no place or transition named ${JSON.stringify(unknown)}` };
	const draft = new Draft(mirror);
	const change = translate(draft, event);
	const next: Mirror = {
		...draft.result(),
		marking_version: version,
		running: typeof event.data.running === 'boolean' ? event.data.running : mirror.running,
	};
	const short = [...draft.touched].filter((name) => isShort(next.places[name], next.tokenLimit));
	return { outcome: 'applied', mirror: next, change, short };
}

/** The first name the event carries that the mirror does not have. */
function unknownName(mirror: Mirror, event: StateEvent): string | null {
	const places: string[] = [];
	const transitions: string[] = [];
	switch (event.kind) {
		case 'fired':
			transitions.push(event.data.transition);
			places.push(...pairs(event.data.consumed).map(([p]) => p), ...produced(event.data.produced).map(([p]) => p));
			break;
		case 'launched':
			transitions.push(event.data.transition);
			places.push(...pairs(event.data.consumed).map(([p]) => p));
			break;
		case 'distributed':
			transitions.push(event.data.transition);
			places.push(...produced(event.data.produced).map(([p]) => p));
			break;
		case 'failed':
			transitions.push(event.data.transition);
			places.push(...pairs(event.data.consumed).map(([p]) => p));
			break;
		case 'added':
		case 'removed':
		case 'mutated':
		case 'hidden':
			places.push(event.data.place);
			break;
		case 'toggled':
			transitions.push(event.data.transition);
			break;
		case 'param_changed':
			break;
	}
	return (
		transitions.find((name) => !(name in mirror.transitions)) ??
		places.find((name) => !(name in mirror.places)) ??
		null
	);
}

function pairs(list: PlaceToken[] | undefined): PlaceToken[] {
	return Array.isArray(list) ? list : [];
}

function produced(list: ProducedToken[] | undefined): ProducedToken[] {
	return Array.isArray(list) ? list : [];
}

function mapValues<V>(record: Record<string, V>, f: (value: V, key: string) => V): Record<string, V> {
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value, key)]));
}

/**
 * The places and transitions one notification changes, copied on first
 * touch so the mirror it came from is left as it was.
 */
class Draft {
	private places: Record<string, MirrorPlace>;
	private transitions: Record<string, TransitionState>;
	private airborne: Record<string, Airborne[]>;
	private progress: Progress;
	private readonly copied = new Set<string>();
	readonly touched = new Set<string>();

	constructor(private readonly base: Mirror) {
		this.places = { ...base.places };
		this.transitions = { ...base.transitions };
		this.airborne = { ...base.airborne };
		this.progress = base.progress;
	}

	place(name: string): MirrorPlace {
		this.touched.add(name);
		return this.copy(name);
	}

	/** Move a place's count alone, as `hidden` does: the list is not
	 *  touched, so the place is not reported short for it. */
	recount(name: string, delta: number) {
		const place = this.copy(name);
		place.count = Math.max(0, place.count + delta);
	}

	private copy(name: string): MirrorPlace {
		if (!this.copied.has(name)) {
			const place = this.places[name];
			this.places[name] = { ...place, tokens: [...place.tokens] };
			this.copied.add(name);
		}
		return this.places[name];
	}

	setTransition(name: string, patch: Partial<TransitionState>) {
		this.transitions[name] = { ...this.transitions[name], ...patch };
	}

	setAirborne(transition: string, tokens: Airborne[] | null) {
		if (tokens) this.airborne[transition] = tokens;
		else delete this.airborne[transition];
	}

	takeAirborne(transition: string): Airborne[] {
		const tokens = this.airborne[transition] ?? [];
		delete this.airborne[transition];
		return tokens;
	}

	countFiring(transition: string) {
		this.progress = {
			...this.progress,
			step_count: this.progress.step_count + 1,
			last_fired: transition,
			fired_counts: {
				...this.progress.fired_counts,
				[transition]: (this.progress.fired_counts[transition] ?? 0) + 1,
			},
		};
	}

	result(): Mirror {
		return {
			...this.base,
			places: this.places,
			transitions: this.transitions,
			airborne: this.airborne,
			progress: this.progress,
		};
	}

	get limit(): number {
		return this.base.tokenLimit;
	}
}

/** Take tokens out of their places; the count drops whether or not the
 *  token was known. Slots are read before anything moves. */
function takeAll(draft: Draft, consumed: PlaceToken[]): Moved[] {
	const moved = consumed.map(([place, id]) => {
		const list = draft.place(place).tokens;
		const slot = list.findIndex((token) => token.id === id);
		return { place, id, token: slot >= 0 ? list[slot] : null, slot: slot >= 0 ? slot : null };
	});
	for (const { place, id } of moved) {
		const record = draft.place(place);
		record.count = Math.max(0, record.count - 1);
		record.tokens = record.tokens.filter((token) => token.id !== id);
	}
	return moved;
}

/** Append a token to its place: to the list while the list is complete and
 *  under the cap, to the count always. A token already listed there only
 *  has its label and colour refreshed. */
function putBack(draft: Draft, place: string, token: MarkingToken) {
	const record = draft.place(place);
	const at = record.tokens.findIndex((known) => known.id === token.id);
	if (at >= 0) {
		record.tokens[at] = { ...record.tokens[at], ...token };
		return;
	}
	const complete = record.tokens.length >= record.count;
	if (complete && record.tokens.length < draft.limit) record.tokens.push(token);
	record.count += 1;
}

/** Where each token now sits in its place's list. */
function slotted(draft: Draft, tokens: Array<{ place: string; id: string; token: MarkingToken | null }>): Moved[] {
	return tokens.map(({ place, id, token }) => {
		const slot = draft.place(place).tokens.findIndex((known) => known.id === id);
		return { place, id, token, slot: slot >= 0 ? slot : null };
	});
}

/** A token as a notification describes it: a colour when one is given (a
 *  produced entry writes `null` for none when keys follow), keys when the
 *  place declares them. */
function described(id: string, label: string, color: unknown, keys: unknown): MarkingToken {
	return {
		id,
		label,
		...(typeof color === 'string' && color ? { color } : {}),
		...(isKeys(keys) ? { keys } : {}),
	};
}

/** Keys as the wire may carry them: an object of strings, numbers and
 *  booleans. Anything else is read as no keys. */
function isKeys(value: unknown): value is Keys {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function producedTokens(list: ProducedToken[]): Array<{ place: string; token: MarkingToken }> {
	return list.map(([place, id, label, color, keys]) => ({ place, token: described(id, label, color, keys) }));
}

function putAll(draft: Draft, list: ProducedToken[]): Moved[] {
	const made = producedTokens(list);
	for (const { place, token } of made) putBack(draft, place, token);
	return slotted(draft, made.map(({ place, token }) => ({ place, id: token.id, token })));
}

/**
 * A failure that restored its tokens: each back at the front of its place,
 * in the order taken. A token still listed (a one-piece runtime never moved
 * it) is left alone; one a launch took comes back with its label; one the
 * mirror never knew raises the count only.
 */
function restore(draft: Draft, consumed: PlaceToken[], flying: Airborne[]): Moved[] {
	const known = new Map(flying.map((entry) => [entry.token.id, entry.token]));
	const byPlace = new Map<string, MarkingToken[]>();
	for (const [place, id] of consumed) {
		const record = draft.place(place);
		if (record.tokens.some((token) => token.id === id)) continue;
		const token = known.get(id);
		record.count += 1;
		if (token) byPlace.set(place, [...(byPlace.get(place) ?? []), token]);
	}
	for (const [place, tokens] of byPlace) {
		const record = draft.place(place);
		record.tokens = [...tokens, ...record.tokens].slice(0, draft.limit);
	}
	return slotted(
		draft,
		consumed.map(([place, id]) => ({ place, id, token: known.get(id) ?? null })),
	);
}

/** A failure that kept nothing: tokens still listed (one-piece) go now. */
function discard(draft: Draft, consumed: PlaceToken[], flying: Airborne[]): Moved[] {
	const gone = new Set(flying.map((entry) => entry.token.id));
	const stillThere = consumed.filter(([, id]) => !gone.has(id));
	const taken = takeAll(draft, stillThere);
	const known = new Map(flying.map((entry) => [entry.token.id, entry]));
	return consumed.map(([place, id]) => {
		const was = taken.find((moved) => moved.id === id);
		return was ?? { place, id, token: known.get(id)?.token ?? null, slot: null };
	});
}

function translate(draft: Draft, event: StateEvent): Change {
	switch (event.kind) {
		case 'fired': {
			const { transition } = event.data;
			const consumed = takeAll(draft, pairs(event.data.consumed));
			const made = putAll(draft, produced(event.data.produced));
			draft.countFiring(transition);
			return { kind: 'fired', transition, consumed, produced: made };
		}
		case 'launched': {
			const { transition } = event.data;
			const consumed = takeAll(draft, pairs(event.data.consumed));
			draft.setAirborne(
				transition,
				consumed.flatMap((moved) => (moved.token ? [{ place: moved.place, token: moved.token }] : [])),
			);
			draft.setTransition(transition, { in_flight: true, fireable: false });
			return { kind: 'launched', transition, consumed };
		}
		case 'distributed': {
			const { transition } = event.data;
			const made = putAll(draft, produced(event.data.produced));
			draft.setAirborne(transition, null);
			draft.setTransition(transition, { in_flight: false });
			draft.countFiring(transition);
			return { kind: 'distributed', transition, produced: made };
		}
		case 'failed': {
			const { transition, restored, error } = event.data;
			const flying = draft.takeAirborne(transition);
			const consumed = restored
				? restore(draft, pairs(event.data.consumed), flying)
				: discard(draft, pairs(event.data.consumed), flying);
			draft.setTransition(transition, { in_flight: false });
			return { kind: 'failed', transition, error: String(error ?? ''), restored: restored === true, consumed };
		}
		case 'added': {
			const { place, id, label, color, keys } = event.data;
			const token = described(id, label, color, keys);
			putBack(draft, place, token);
			const [moved] = slotted(draft, [{ place, id, token }]);
			return { kind: 'added', token: moved };
		}
		case 'removed': {
			const [moved] = takeAll(draft, [[event.data.place, event.data.id]]);
			return { kind: 'removed', token: moved };
		}
		case 'mutated': {
			const { place, id, label, keys } = event.data;
			const patch: Partial<MarkingToken> = {
				...(typeof label === 'string' ? { label } : {}),
				...(isKeys(keys) ? { keys } : {}),
			};
			if (Object.keys(patch).length > 0) {
				const record = draft.place(place);
				record.tokens = record.tokens.map((token) => (token.id === id ? { ...token, ...patch } : token));
			}
			return { kind: 'mutated', place, id };
		}
		case 'hidden': {
			const { place, kind } = event.data;
			if (kind === 'added') draft.recount(place, 1);
			if (kind === 'removed') draft.recount(place, -1);
			return { kind: 'hidden', place, what: kind };
		}
		case 'toggled': {
			const { transition, enabled } = event.data;
			draft.setTransition(transition, { enabled });
			return { kind: 'toggled', transition, enabled };
		}
		case 'param_changed':
			return { kind: 'param_changed' };
	}
}

/** Every token the mirror lists, with its place, in topology order. */
export function listedTokens(mirror: Mirror): Array<{ place: string; token: MarkingToken }> {
	return mirror.topology.places.flatMap((place) =>
		(mirror.places[place.name]?.tokens ?? []).map((token) => ({ place: place.name, token })),
	);
}

/** The total number of tokens, from the counts. */
export function totalCount(mirror: Mirror | null): number {
	if (!mirror) return 0;
	return Object.values(mirror.places).reduce((sum, place) => sum + place.count, 0);
}

/** Whether any transition's body is running. */
export function anyInFlight(mirror: Mirror | null): boolean {
	return !!mirror && Object.values(mirror.transitions).some((state) => state.in_flight);
}

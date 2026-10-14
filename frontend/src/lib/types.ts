/**
 * The net protocol's shapes, version 1, as the nets page reads them.
 *
 * The protocol is specified once, in the Python library's `PROTOCOL.md`
 * (<https://github.com/olenive/petritype/blob/main/PROTOCOL.md>); section
 * numbers below are its. The control plane relays the shapes unchanged: an
 * HTTP answer is a method's `result`, and a worker stream event's `kind` and
 * `data` are a notification's `method` and `params` (§9). Optional fields are
 * omitted, never `null`, unless stated. Unknown fields are ignored and
 * unknown notifications skipped (§2).
 */

/** A point in the layout's screen coordinates. */
export interface Point {
	x: number;
	y: number;
}

// -- §5.1 topology --

export interface TopologyPlace {
	name: string;
	/** The runtime's own spelling of the token type, for display only. */
	type_name?: string;
	/** Whether tokens here have a JSON form: decides inject and `kind: "json"`. */
	serializable: boolean;
	/** Tokens of this place may hold nets of their own (§12). */
	nested?: boolean;
	/** Such a place's inner nets are stepped only by an outer body (§12.3). */
	passive?: boolean;
	/** The keys the place derives from its tokens, in declaration order;
	 *  absent when it declares none (§13.1). */
	key_names?: string[];
}

export interface TopologyTransition {
	name: string;
	/** Runtime-specific introspection (Python: `function_name`, `signature`,
	 *  `docstring`; Rust: `params`, `detachable`). Shown, never depended on. */
	detail?: Record<string, unknown>;
}

/** An input edge's kind. A reader meeting another value draws a plain edge.
 *  `drain` and `survey` (since 2026-10-14) read every token of their place,
 *  zero or more, the first consuming them and the second copying them, and
 *  never hold their transition back (§5.1). */
export type EdgeKind =
	| 'take'
	| 'take_all'
	| 'snapshot'
	| 'mutate'
	| 'take_where'
	| 'mutate_where'
	| 'drain'
	| 'survey';

export interface TopologyEdge {
	place: string;
	transition: string;
	/** `in`: place to transition; `out`: transition to place. */
	direction: 'in' | 'out';
	/** Input edges only. */
	kind?: EdgeKind | string;
	/** Output edges of a transition with more than one output. */
	slot?: number;
	/** `take_where` and `mutate_where` edges: the filter as declared (§13.5). */
	filter?: Filter;
}

export interface Topology {
	places: TopologyPlace[];
	transitions: TopologyTransition[];
	edges: TopologyEdge[];
	hints?: { positions?: Record<string, Point> };
}

// -- §5.2 transition state --

export interface TransitionState {
	/** The on/off switch, set by enable and disable. Not "can fire now". */
	enabled: boolean;
	/** Enabled, not in flight, every input non-empty, guard passes. */
	fireable: boolean;
	/** Its body is running. */
	in_flight: boolean;
	priority?: number;
}

// -- §5.3 marking --

/** A key's value (§13.1): a JSON string, an integer or a boolean. */
export type KeyValue = string | number | boolean;

/** A token's keys by name, present only when its place declares keys. */
export type Keys = Record<string, KeyValue>;

/** One net a token holds (§12.2), as a full token entry lists it. */
export interface InnerNetRef {
	/** The net's name within the token; the empty string for a token that is itself a net. */
	name: string;
	/** Its stable name: survives every move of the token, opaque, compared as a string. */
	nested_id: string;
	/** Its path as the marking stood when the entry was read (§12.1). */
	path: string;
	/** The template that built it, when the runtime knows one. */
	template?: string;
	/** The number of tokens in all its places: a hint, not a versioned value. */
	count: number;
}

export interface MarkingToken {
	/** A decimal integer as a string, never reused within a generation. */
	id: string;
	/** Short display text, at most 1000 characters. */
	label: string;
	/** `#rrggbb`, when the runtime has one. */
	color?: string;
	/** Only when it differs from the place's `type_name`. */
	type_name?: string;
	/** Its keys, when its place declares keys (§13.1). */
	keys?: Keys;
	/** The nets it holds, when it holds some (§12.2). Never on a produced
	 *  entry, `added` or `mutated`: a reader wanting them reads the token. */
	nets?: InnerNetRef[];
}

export interface PlaceMarking {
	/** The true number of tokens. Sizes come from here, never `tokens.length`. */
	count: number;
	/** Under a projection only (§13.4): how many tokens the filter lets through. */
	matching?: number;
	/** The oldest tokens first, capped (`token_limit`, default 200). */
	tokens: MarkingToken[];
}

// -- §5.4 progress --

export interface Progress {
	step_count: number;
	last_fired: string | null;
	fired_counts: Record<string, number>;
	last_progress_at: string | null;
}

/** `get_state`'s answer (§5): `GET /api/nets/{id}/execution/state`. */
export interface NetState {
	protocol_version: number;
	runtime: string;
	/** The net's name; for an inner net, its name within its token. */
	net: string;
	/** An inner net's address (§12.3); absent for the outer net. */
	path?: string;
	nested_id?: string;
	/** The template that built an inner net, when known. */
	template?: string;
	generation: number;
	marking_version: number;
	running: boolean;
	topology: Topology;
	transitions: Record<string, TransitionState>;
	marking: { places: Record<string, PlaceMarking> };
	progress: Progress;
}

// -- §12.1 addresses --

/**
 * Which net a read or an inject is about (§12.1): the outer net when
 * neither is given, an inner net by its path or its nested id. Never both:
 * that is `invalid_params`. The page names inner nets by `nested_id` alone,
 * which survives the holding token's moves.
 */
export interface NetAddress {
	path?: string;
	nested_id?: string;
}

// -- §6 results --

/** `step`'s answer. `fired: false` with no `transition`: nothing was fireable.
 *  A firing inside an inner net carries that net's `path` and `nested_id`;
 *  `marking_version` is always the outer net's. */
export interface StepResult {
	fired: boolean;
	transition?: string;
	failed?: boolean;
	marking_version: number;
	running: boolean;
	path?: string;
	nested_id?: string;
}

/** `inject`'s answer; into an inner net it carries that net's address and
 *  its own `marking_version`. */
export interface InjectResult {
	status: string;
	id: string;
	marking_version: number;
	path?: string;
	nested_id?: string;
}

/** What every `get_token` answer carries besides the value. */
interface TokenValueCommon {
	id: string;
	place: string;
	type_name: string;
	keys?: Keys;
	nets?: InnerNetRef[];
	path?: string;
	nested_id?: string;
}

/** `get_token`'s answer (§6.5): JSON exactly when the place is serializable. */
export type TokenValue =
	| (TokenValueCommon & { kind: 'json'; value: unknown })
	| (TokenValueCommon & { kind: 'text'; text: string });

// -- §13 keys, queries and filters --

/** A filter clause (§13.2): a token matches when it has the key with one of
 *  the values (compared by JSON type and value), or, for a `param` clause,
 *  the current value of that net parameter. */
export type FilterClause = { key: string; values: KeyValue[] } | { key: string; param: string };

/** A filter (§13.2): AND across clauses, OR within one; `places` and
 *  `prefix` restrict by place. No clauses and no restriction matches all. */
export interface Filter {
	clauses?: FilterClause[];
	places?: string[];
	prefix?: string;
}

/** `query`'s answer (§13.3). */
export interface QueryResult {
	marking_version: number;
	count: number;
	matches: Array<{ place: string; token: MarkingToken; json?: unknown }>;
}

/** `distinct`'s answer (§13.3): values in order of first appearance. */
export interface DistinctResult {
	marking_version: number;
	key: string;
	values: KeyValue[];
}

// -- §8 log --

/** A `[place, id]` pair. */
export type PlaceToken = [place: string, id: string];

export interface LogEntry {
	seq: number;
	transition: string;
	/** A firing inside an inner net: that net's path as it stood then, and
	 *  its nested id; its place names and token ids are the inner net's. */
	path?: string;
	nested_id?: string;
	started_at: string;
	duration_ms: number;
	outcome: 'fired' | 'failed';
	consumed: PlaceToken[];
	produced: PlaceToken[];
	/** With `outcome: "failed"`. */
	error?: string;
	restored?: boolean;
}

// -- §7 notifications --

/** A produced `[place, id, label, color?, keys?]`. When the place declares
 *  keys the fifth element is there and a token without a colour has `null`
 *  as its fourth (§7.1). */
export type ProducedToken = [place: string, id: string, label: string, color?: string | null, keys?: Keys];

/** What every notification carries (§7). */
export interface Stamped {
	marking_version: number;
	running: boolean;
}

export interface FiredParams extends Stamped {
	transition: string;
	consumed: PlaceToken[];
	produced: ProducedToken[];
	duration_ms: number;
}
export interface LaunchedParams extends Stamped {
	transition: string;
	consumed: PlaceToken[];
}
export interface DistributedParams extends Stamped {
	transition: string;
	produced: ProducedToken[];
	duration_ms: number;
}
export interface FailedParams extends Stamped {
	transition: string;
	error: string;
	restored: boolean;
	consumed: PlaceToken[];
}
export interface AddedParams extends Stamped {
	place: string;
	id: string;
	label: string;
	color?: string;
	keys?: Keys;
}
export interface RemovedParams extends Stamped {
	place: string;
	id: string;
}
export interface MutatedParams extends Stamped {
	place: string;
	id: string;
	label?: string;
	/** The keys as they stand after the change, when the place declares keys. */
	keys?: Keys;
}
/** Stands in for an `added`, `removed` or `mutated` about a token a
 *  connection's filter hides (§13.4): moves the version and, for `added`
 *  and `removed`, the place's count; tells nothing of the token. */
export interface HiddenParams extends Stamped {
	kind: 'added' | 'removed' | 'mutated';
	place: string;
}
export interface ToggledParams extends Stamped {
	transition: string;
	enabled: boolean;
}
export interface ParamChangedParams extends Stamped {
	param: string;
	transition?: string;
}

/** §7.1: each raises `marking_version` by exactly one. */
export type StateEvent =
	| { kind: 'fired'; data: FiredParams }
	| { kind: 'launched'; data: LaunchedParams }
	| { kind: 'distributed'; data: DistributedParams }
	| { kind: 'failed'; data: FailedParams }
	| { kind: 'added'; data: AddedParams }
	| { kind: 'removed'; data: RemovedParams }
	| { kind: 'mutated'; data: MutatedParams }
	| { kind: 'hidden'; data: HiddenParams }
	| { kind: 'toggled'; data: ToggledParams }
	| { kind: 'param_changed'; data: ParamChangedParams };

export type StateEventKind = StateEvent['kind'];

export const STATE_EVENT_KINDS: readonly StateEventKind[] = [
	'fired', 'launched', 'distributed', 'failed', 'added', 'removed', 'mutated', 'hidden', 'toggled',
	'param_changed',
];

export type StopReason = 'no_fireable_transitions' | 'transition_failed' | 'subprocess_exited';

/** §7.2: these move no version. */
export type OtherEvent =
	| { kind: 'reloaded'; data: Stamped & { generation: number; reason: 'load' | 'reset' | 'resync' } }
	| { kind: 'fireable'; data: Stamped & { transitions: string[] } }
	| { kind: 'idle'; data: Stamped & { idle_since: string } }
	| {
			kind: 'execution_stopped';
			data: Stamped & { reason: StopReason | string; error_type?: string; message?: string };
	  }
	| {
			kind: 'heartbeat';
			data: Stamped & { step_started_at: string | null; executing_transition: string | null };
	  }
	| { kind: 'load_progress'; data: Stamped & { step: string; message: string } }
	| { kind: 'nested'; data: NestedParams };

/**
 * An event inside an inner net (§7.2, §12.4): `event` is the notification
 * that net would send on its own, its `marking_version` the inner net's.
 * The wrapper's own `marking_version` is the outer net's, which it does not
 * move: it is never a gap for the outer net. One wrapper whatever the depth;
 * `path` is the full path as the marking stands when it is written.
 */
export interface NestedParams extends Stamped {
	path: string;
	nested_id: string;
	event: { method: string; params: Record<string, unknown> };
}

/** Events the host adds of its own (§9). */
export type HostEvent =
	| { kind: 'subprocess_output'; data: { text: string } }
	| { kind: 'memory_stats'; data: Record<string, unknown> }
	| { kind: 'log'; data: { text?: string; level?: string } }
	| { kind: 'stream_gap'; data: { reason: string; after?: number; current_seq?: number } };

/** Every kind the worker stream carries for a net, discriminated on `kind`. */
export type NetEvent = StateEvent | OtherEvent | HostEvent;

export function isStateEvent(event: { kind: string }): event is StateEvent {
	return (STATE_EVENT_KINDS as readonly string[]).includes(event.kind);
}

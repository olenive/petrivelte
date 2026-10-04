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
}

export interface TopologyTransition {
	name: string;
	/** Runtime-specific introspection (Python: `function_name`, `signature`,
	 *  `docstring`; Rust: `params`, `detachable`). Shown, never depended on. */
	detail?: Record<string, unknown>;
}

/** An input edge's kind. A reader meeting another value draws a plain edge. */
export type EdgeKind = 'take' | 'take_all' | 'snapshot' | 'mutate';

export interface TopologyEdge {
	place: string;
	transition: string;
	/** `in`: place to transition; `out`: transition to place. */
	direction: 'in' | 'out';
	/** Input edges only. */
	kind?: EdgeKind | string;
	/** Output edges of a transition with more than one output. */
	slot?: number;
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

export interface MarkingToken {
	/** A decimal integer as a string, never reused within a generation. */
	id: string;
	/** Short display text, at most 1000 characters. */
	label: string;
	/** `#rrggbb`, when the runtime has one. */
	color?: string;
	/** Only when it differs from the place's `type_name`. */
	type_name?: string;
}

export interface PlaceMarking {
	/** The true number of tokens. Sizes come from here, never `tokens.length`. */
	count: number;
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
	net: string;
	generation: number;
	marking_version: number;
	running: boolean;
	topology: Topology;
	transitions: Record<string, TransitionState>;
	marking: { places: Record<string, PlaceMarking> };
	progress: Progress;
}

// -- §6 results --

/** `step`'s answer. `fired: false` with no `transition`: nothing was fireable. */
export interface StepResult {
	fired: boolean;
	transition?: string;
	failed?: boolean;
	marking_version: number;
	running: boolean;
}

export interface InjectResult {
	status: string;
	id: string;
	marking_version: number;
}

/** `get_token`'s answer (§6.5): JSON exactly when the place is serializable. */
export type TokenValue =
	| { id: string; place: string; type_name: string; kind: 'json'; value: unknown }
	| { id: string; place: string; type_name: string; kind: 'text'; text: string };

// -- §8 log --

/** A `[place, id]` pair. */
export type PlaceToken = [place: string, id: string];

export interface LogEntry {
	seq: number;
	transition: string;
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

/** A produced `[place, id, label, color?]`. */
export type ProducedToken = [place: string, id: string, label: string, color?: string];

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
}
export interface RemovedParams extends Stamped {
	place: string;
	id: string;
}
export interface MutatedParams extends Stamped {
	place: string;
	id: string;
	label?: string;
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
	| { kind: 'toggled'; data: ToggledParams }
	| { kind: 'param_changed'; data: ParamChangedParams };

export type StateEventKind = StateEvent['kind'];

export const STATE_EVENT_KINDS: readonly StateEventKind[] = [
	'fired', 'launched', 'distributed', 'failed', 'added', 'removed', 'mutated', 'toggled',
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
	| { kind: 'load_progress'; data: Stamped & { step: string; message: string } };

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

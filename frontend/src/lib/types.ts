export interface Place {
	id: string;
	name: string;
	x: number;
	y: number;
	type_name: string;
	tokens?: Token[];
}

export interface Transition {
	id: string;
	name: string;
	x: number;
	y: number;
	function_name: string;
}

export interface Edge {
	id: string;
	source: string;
	target: string;
	type: 'input' | 'output';
}

export interface Token {
	id: string;
	place_id: string;
	x: number;
	y: number;
	color: string;
	data: any;
}

export interface GraphState {
	places: Place[];
	transitions: Transition[];
	edges: Edge[];
}

export interface TokenMovement {
	id: string;
	from_place: string;
	to_place: string;
	from_pos: { x: number; y: number };
	to_pos: { x: number; y: number };
	color: string;
	data: any;
}

export interface LogEntry {
	timestamp: number;
	transition: string;
	duration_ms: number;
	inputs: Record<string, string[]>;
	outputs: string[];
}

export interface TransitionFiredMessage {
	type: 'transition_fired';
	transition_name: string;
	tokens_moved: TokenMovement[];
	log_entry: LogEntry;
	new_token_positions: Token[];
}

export interface GraphStateMessage {
	type: 'graph_state';
	data: GraphState;
}

export type WebSocketMessage = GraphStateMessage | TransitionFiredMessage;

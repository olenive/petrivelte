export interface Place {
	id: string;
	name: string;
	x: number;
	y: number;
	type_name: string;
	tokens?: PlaceToken[];
}

export interface PlaceToken {
	id: string;
	preview: string;
	type_name: string;
	color: string;
}

export interface Transition {
	id: string;
	name: string;
	x: number;
	y: number;
	function_name: string;
	signature?: string | null;
	docstring?: string | null;
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
	preview: string;
	type_name: string;
}

export interface GraphState {
	places: Place[];
	transitions: Transition[];
	edges: Edge[];
}

export interface LogEntry {
	timestamp: number;
	transition: string;
	duration_ms: number;
	inputs: Record<string, string[]>;
	outputs: string[];
}


/**
 * What the transition inspector shows: the runtime's `detail` as rows when
 * it sent one (protocol §5.1), and the transition's input and output places
 * from the topology otherwise.
 */

import type { Topology } from '$lib/types';

/** A `detail` as key and value rows, one level deep: strings as they are,
 *  anything else as compact JSON, as the Bevy inspector shows it. */
export function detailRows(detail: unknown): Array<[string, string]> {
	if (detail === undefined || detail === null) return [];
	if (typeof detail !== 'object' || Array.isArray(detail)) return [['detail', plain(detail)]];
	return Object.entries(detail as Record<string, unknown>).map(([key, value]) => [key, plain(value)]);
}

function plain(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface Arc {
	place: string;
	/** An input's kind unless it is a plain `take`, with a short phrase for
	 *  the kinds that accept an empty place; the slot for an output of a
	 *  transition with several. */
	note: string;
}

/** An input edge's note: the kind by name, and for `drain` and `survey`,
 *  which read every token of their place and never hold the transition
 *  back (§5.1), what they do with them. */
function inputNote(kind: string | undefined): string {
	if (!kind || kind === 'take') return '';
	if (kind === 'drain') return 'drain: takes every token, zero or more';
	if (kind === 'survey') return 'survey: copies every token, zero or more';
	return kind;
}

/** A transition's input and output places, in topology order. */
export function transitionArcs(topology: Topology | null, transition: string): { inputs: Arc[]; outputs: Arc[] } {
	const edges = (topology?.edges ?? []).filter((edge) => edge.transition === transition);
	return {
		inputs: edges
			.filter((edge) => edge.direction === 'in')
			.map((edge) => ({ place: edge.place, note: inputNote(edge.kind) })),
		outputs: edges
			.filter((edge) => edge.direction === 'out')
			.map((edge) => ({ place: edge.place, note: edge.slot !== undefined ? `slot ${edge.slot}` : '' })),
	};
}

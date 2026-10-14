/**
 * The token filter of the nets page: which tokens of the net shown are
 * drawn, by their keys (protocol §13). It is the view's own: nothing is sent
 * to the server, counts stay the truth, and the execution log is not
 * filtered. The Bevy viewer's `TokenFilter` does the same (its DESIGN §3.6).
 *
 * A filter is, per key, the values switched on. A key with no value on has
 * no clause. A token matches when, for every clause, it has the key with one
 * of the clause's values (AND across keys, OR within one), compared by JSON
 * type and value as §13.2 says: `1` is not `"1"` and not `true`. A token
 * whose place declares no such key carries no such key, and so matches no
 * such clause. A hidden token is not drawn and its place reads `matching of
 * count`; a token a place lists beyond what the page holds (the capped
 * list) has keys the page does not know, so a place holding more than it
 * lists gives a lower bound (`2+ of 300`).
 */

import type { Filter, KeyValue, Keys, MarkingToken } from '$lib/types';
import type { Mirror } from '$lib/netMirror';

/** Per key, the values switched on. */
export type TokenFilter = Readonly<Record<string, readonly KeyValue[]>>;

export const NO_FILTER: TokenFilter = {};

/** Two key values are the same when their JSON type and value are. */
export function sameValue(a: KeyValue, b: KeyValue): boolean {
	return typeof a === typeof b && a === b;
}

function includes(values: readonly KeyValue[], value: KeyValue): boolean {
	return values.some((each) => sameValue(each, value));
}

/** The clauses in force: keys with at least one value on. */
export function clausesOf(filter: TokenFilter): Array<{ key: string; values: KeyValue[] }> {
	return Object.entries(filter)
		.filter(([, values]) => values.length > 0)
		.map(([key, values]) => ({ key, values: [...values] }));
}

/** Whether the filter hides anything at all. */
export function isActive(filter: TokenFilter): boolean {
	return clausesOf(filter).length > 0;
}

/** The filter in the protocol's shape (§13.2), for a `query`. */
export function protocolFilter(filter: TokenFilter): Filter {
	return { clauses: clausesOf(filter) };
}

/** Whether a token with these keys matches every clause. */
export function matchesKeys(filter: TokenFilter, keys: Keys | undefined): boolean {
	return clausesOf(filter).every(({ key, values }) => {
		const value = keys?.[key];
		return value !== undefined && includes(values, value);
	});
}

export function tokenMatches(filter: TokenFilter, token: MarkingToken): boolean {
	return matchesKeys(filter, token.keys);
}

/** The filter with `value` of `key` switched the other way. */
export function toggleValue(filter: TokenFilter, key: string, value: KeyValue): TokenFilter {
	const values = filter[key] ?? [];
	const next = includes(values, value) ? values.filter((each) => !sameValue(each, value)) : [...values, value];
	const { [key]: _, ...rest } = filter;
	return next.length > 0 ? { ...rest, [key]: next } : rest;
}

/** Whether `value` of `key` is switched on. */
export function isOn(filter: TokenFilter, key: string, value: KeyValue): boolean {
	return includes(filter[key] ?? [], value);
}

/** The key names the places declare, in order of first appearance. */
export function keyNames(places: ReadonlyArray<{ key_names?: readonly string[] }>): string[] {
	const seen: string[] = [];
	for (const place of places) {
		for (const name of place.key_names ?? []) if (!seen.includes(name)) seen.push(name);
	}
	return seen;
}

/** Whether a value is one a key may hold (§13.1); anything else is dropped. */
function isKeyValue(value: unknown): value is KeyValue {
	return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/** The values of `key` over the tokens the mirror lists, in place order then
 *  token order, each once. */
export function mirrorValues(mirror: Mirror, key: string): KeyValue[] {
	const values: KeyValue[] = [];
	for (const place of mirror.topology.places) {
		for (const token of mirror.places[place.name]?.tokens ?? []) {
			const value = token.keys?.[key];
			if (isKeyValue(value) && !includes(values, value)) values.push(value);
		}
	}
	return values;
}

/** The values to offer: the server's `distinct` answer when there is one,
 *  then any value of the given lists it lacks, each once. */
export function mergeValues(server: readonly KeyValue[] | null, ...local: ReadonlyArray<readonly KeyValue[]>): KeyValue[] {
	const values: KeyValue[] = [];
	for (const value of [...(server ?? []), ...local.flat()]) {
		if (isKeyValue(value) && !includes(values, value)) values.push(value);
	}
	return values;
}

export interface PlaceCount {
	/** The true number of tokens. */
	count: number;
	/** How many of the listed tokens match. */
	matching: number;
	/** The place holds tokens the page does not list: `matching` is a lower bound. */
	lowerBound: boolean;
}

export interface FilterCounts {
	places: Record<string, PlaceCount>;
	matching: number;
	total: number;
	lowerBound: boolean;
}

/** How many tokens the filter lets through, per place and in all. */
export function filterCounts(mirror: Mirror, filter: TokenFilter): FilterCounts {
	const places: Record<string, PlaceCount> = {};
	let matching = 0;
	let total = 0;
	let lowerBound = false;
	for (const place of mirror.topology.places) {
		const record = mirror.places[place.name];
		if (!record) continue;
		const hits = record.tokens.filter((token) => tokenMatches(filter, token)).length;
		const short = record.tokens.length < record.count;
		places[place.name] = { count: record.count, matching: hits, lowerBound: short };
		matching += hits;
		total += record.count;
		lowerBound = lowerBound || short;
	}
	return { places, matching, total, lowerBound };
}

/** `2 of 5`, or `2+ of 300` for a lower bound. */
export function matchingText(count: PlaceCount): string {
	return `${count.matching}${count.lowerBound ? '+' : ''} of ${count.count}`;
}

/** The banner: `showing 2 of 5 tokens`. */
export function bannerText(counts: FilterCounts): string {
	const tokens = counts.total === 1 ? 'token' : 'tokens';
	return `showing ${counts.matching}${counts.lowerBound ? '+' : ''} of ${counts.total} ${tokens}`;
}

/** A value as the bar shows it: a string as itself, anything else as JSON. */
export function valueText(value: KeyValue): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

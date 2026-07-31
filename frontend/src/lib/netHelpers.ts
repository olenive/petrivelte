import type { Net } from '$lib/api';

/**
 * The display name for a net instance. Always `instance_name` — the schema
 * enforces uniqueness within (user, definition_name) so no disambiguation
 * suffix is needed.
 */
export function netDisplayName(net: Net): string {
	return net.instance_name;
}

/**
 * Kept for backwards-compatibility with callers that still call it. Returns
 * empty string — the instance/definition disambiguation now happens via
 * `instance_name` (unique) + `definition_name` (the kind).
 */
export function netInstanceLabel(_net: Net, _allNets: Net[]): string {
	return '';
}

/**
 * Full label for a net: just the instance name. Use `definition_name` as a
 * separate secondary line when the kind matters.
 */
export function netFullLabel(net: Net, _allNets: Net[]): string {
	return net.instance_name;
}

/**
 * A stable, deterministic default instance name, suggested when the user picks
 * a definition. Defaulting to the definition name (instead of a timestamp)
 * means re-creating the net — e.g. after a redeploy — reuses the same identity
 * (user, definition_name, instance_name) via the backend upsert, so notebook
 * bindings (which reference the net_id) stay alive instead of orphaning. The
 * user can edit it (e.g. append `-TW`) to run several instances of one kind.
 */
export function suggestInstanceName(definitionName: string): string {
	return definitionName.trim();
}

/**
 * Above this many tokens in one place, the graph draws the count instead of
 * individual dots.
 *
 * Seven is where dots stop meaning anything: the layout lays them on a ring of
 * radius `min(20, count * 3)`, which pins at 20px from seven tokens up, so
 * every further token is squeezed onto the same small circle. Past that point
 * a number is strictly more informative than a smear.
 */
export const TOKEN_DOT_LIMIT = 7;

/**
 * How many tokens a place actually holds.
 *
 * `place.tokens` is a capped sample — the worker truncates per-place token
 * detail so the IPC payload stays bounded by the net's shape rather than its
 * runtime — so counts must come from `token_count`. The fallback covers
 * workers predating that field.
 */
export function placeTokenCount(place: { token_count?: number; tokens?: unknown[] }): number {
	return place.token_count ?? place.tokens?.length ?? 0;
}

/** True when a place should render as a count rather than as token dots. */
export function placeShowsCount(place: { token_count?: number; tokens?: unknown[] }): boolean {
	return placeTokenCount(place) >= TOKEN_DOT_LIMIT;
}

/**
 * Merge authoritative per-place counts from a `transition_fired` event into
 * the graph's places.
 *
 * Counts cannot be derived from `new_token_positions`: that payload is capped
 * per place, so a large place would report the cap. And they cannot wait for
 * the next full state snapshot either — transitions fire continuously between
 * refreshes, and counts would visibly freeze while the execution log kept
 * scrolling. Hence the worker sends `token_counts` with every fire.
 *
 * Places absent from `tokenCounts` are left untouched rather than zeroed, so a
 * partial payload can't blank out the marking.
 */
export function applyTokenCounts<P extends { id: string; name: string; token_count?: number }>(
	places: P[],
	tokenCounts: Record<string, number> | undefined,
): P[] {
	if (!tokenCounts) return places;
	return places.map((place) => {
		// The worker keys counts by place *name*; the graph keys places by id.
		// They coincide today, so accept either rather than depending on it.
		const count = tokenCounts[place.name] ?? tokenCounts[place.id];
		return count === undefined ? place : { ...place, token_count: count };
	});
}

/** Total tokens across every place, from the authoritative counts. */
export function totalTokenCount(places: { token_count?: number; tokens?: unknown[] }[]): number {
	return places.reduce((sum, place) => sum + placeTokenCount(place), 0);
}

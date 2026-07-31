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
 * Above this many tokens in one place, a count appears in the node.
 *
 * Seven is roughly where the eye stops being able to subitise a cluster, so
 * the number takes over the job the dots were failing at. The dots stay —
 * they're what makes the net feel alive — the number just tells you how many
 * there are.
 */
export const TOKEN_COUNTER_THRESHOLD = 7;

/**
 * Most token dots drawn for one place, however many tokens it holds.
 *
 * Past this the dots convey nothing the counter doesn't, and each one is a
 * keyed SVG node re-evaluated on every fire.
 */
export const TOKEN_DOT_MAX = 20;

/**
 * Fixed slots for token dots, as concentric rings inside the r=30 place.
 *
 * Capacities and radii are constants so slot N is always the same point. The
 * previous layout derived both angle and radius from the *current* token
 * count, so every arrival rotated and expanded the whole ring and the dots
 * appeared to slide around the node. Pinning the slots means an arriving token
 * fills the next empty one and nothing already drawn moves.
 *
 * Radii keep an 8px dot inside the circle (20 + 8 = 28 < 30). The outer ring
 * is deliberately over-subscribed — 14 dots on a 126px circumference overlap —
 * because a dense clump is the intended "lots of tokens here" signal.
 */
const TOKEN_RINGS = [
	{ radius: 10, capacity: 6, offset: 0 },
	{ radius: 20, capacity: 14, offset: Math.PI / 14 },
];

/** Offset from the place centre for the token dot in slot `index`. */
export function tokenSlotOffset(index: number): { dx: number; dy: number } {
	let remaining = index;
	for (const ring of TOKEN_RINGS) {
		if (remaining < ring.capacity) {
			const angle = ring.offset + (remaining * 2 * Math.PI) / ring.capacity;
			return { dx: Math.cos(angle) * ring.radius, dy: Math.sin(angle) * ring.radius };
		}
		remaining -= ring.capacity;
	}
	// Beyond the rings nothing is drawn; callers cap at TOKEN_DOT_MAX.
	return { dx: 0, dy: 0 };
}

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

/** True when a place should show its token count as a number. */
export function placeShowsCounter(place: { token_count?: number; tokens?: unknown[] }): boolean {
	return placeTokenCount(place) >= TOKEN_COUNTER_THRESHOLD;
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

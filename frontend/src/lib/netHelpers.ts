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

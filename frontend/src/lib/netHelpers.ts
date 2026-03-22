import type { Net } from '$lib/api';

/**
 * The display name for a net: `display_name` if set, otherwise `name`.
 */
export function netDisplayName(net: Net): string {
	return net.display_name ?? net.name;
}

/**
 * Instance label like "(2/3)" for nets that share the same template name.
 * Returns empty string if there's only one instance.
 */
export function netInstanceLabel(net: Net, allNets: Net[]): string {
	const siblings = allNets.filter(n => n.name === net.name && n.entry_module === net.entry_module);
	if (siblings.length <= 1) return '';
	const sorted = siblings.sort((a, b) => a.created_at.localeCompare(b.created_at));
	const index = sorted.findIndex(n => n.id === net.id) + 1;
	return `(${index}/${siblings.length})`;
}

/**
 * Full label for a net: display name + instance label.
 */
export function netFullLabel(net: Net, allNets: Net[]): string {
	const name = netDisplayName(net);
	const instance = netInstanceLabel(net, allNets);
	return instance ? `${name} ${instance}` : name;
}

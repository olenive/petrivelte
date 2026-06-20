/**
 * Move a Svelte node into a target element (default: document.body).
 *
 * Use for modals/overlays that need to escape their parent's stacking
 * context. SvelteFlow's viewport uses `transform`, which creates a
 * stacking context — a modal nested inside the same page tree can't
 * reliably layer above xyflow nodes via z-index alone.
 */
export function portal(node: HTMLElement, target: HTMLElement | string = document.body) {
	function update(t: HTMLElement | string) {
		const el = typeof t === 'string' ? document.querySelector<HTMLElement>(t) : t;
		if (!el) {
			console.warn('[portal] target not found:', t);
			return;
		}
		el.appendChild(node);
	}
	update(target);
	return {
		update,
		destroy() {
			node.remove();
		},
	};
}

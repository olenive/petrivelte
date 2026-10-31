/**
 * A drawing described as data, and the one function that brings an SVG
 * subtree in line with it.
 *
 * `scene.ts` describes what to draw as a tree of `SvgNode`s; `patch` makes
 * the children of a parent element match a list of them. Children are
 * matched by key, each element carrying its key as `data-key`: a node whose
 * key and tag match an existing child updates that element in place (its
 * attributes, its text, its own children), a new key creates an element,
 * and a child whose key is no longer wanted is removed. So a redraw with a
 * new marking touches only the attributes and texts that changed, and the
 * elements a host page holds on to stay the same elements.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

const KEY = 'data-key';

export interface SvgNode {
	tag: string;
	/** Unique among its siblings. */
	key: string;
	attrs: Readonly<Record<string, string>>;
	/** Its text, for an element that holds text and no elements. */
	text?: string;
	children?: readonly SvgNode[];
}

/** A node, its attributes given as numbers or strings, and those given as
 *  undefined left out. */
export function svg(
	tag: string,
	key: string,
	attrs: Readonly<Record<string, string | number | undefined>>,
	content: { text?: string; children?: readonly SvgNode[] } = {},
): SvgNode {
	const kept = Object.fromEntries(
		Object.entries(attrs).flatMap(([name, value]) => (value === undefined ? [] : [[name, String(value)]])),
	);
	return { tag, key, attrs: kept, ...content };
}

function update(element: Element, node: SvgNode): void {
	for (const attr of Array.from(element.attributes)) {
		if (attr.name !== KEY && !(attr.name in node.attrs)) element.removeAttribute(attr.name);
	}
	for (const [name, value] of Object.entries(node.attrs)) {
		if (element.getAttribute(name) !== value) element.setAttribute(name, value);
	}
	if (node.children !== undefined) {
		patch(element, node.children);
	} else if (element.textContent !== (node.text ?? '')) {
		element.textContent = node.text ?? '';
	}
}

function create(parent: Element, node: SvgNode): Element {
	const element = parent.ownerDocument.createElementNS(SVG_NS, node.tag);
	element.setAttribute(KEY, node.key);
	update(element, node);
	return element;
}

/** The nodes with any repeated key made unique by its position among the
 *  repeats, so that two nodes never claim one element. */
function distinct(nodes: readonly SvgNode[]): SvgNode[] {
	const seen = new Map<string, number>();
	return nodes.map((node) => {
		const repeats = seen.get(node.key) ?? 0;
		seen.set(node.key, repeats + 1);
		return repeats === 0 ? node : { ...node, key: `${node.key}#${repeats}` };
	});
}

/** Makes the element children of `parent` exactly `nodes`, in order. */
export function patch(parent: Element, nodes: readonly SvgNode[]): void {
	const held = new Map(
		Array.from(parent.children).flatMap((child) => {
			const key = child.getAttribute(KEY);
			return key === null ? [] : [[key, child] as const];
		}),
	);
	const wanted = distinct(nodes).map((node) => {
		const existing = held.get(node.key);
		if (existing && existing.localName === node.tag) {
			update(existing, node);
			return existing;
		}
		return create(parent, node);
	});
	wanted.forEach((element, index) => {
		const at = parent.children[index] ?? null;
		if (at !== element) parent.insertBefore(element, at);
	});
	for (const stale of Array.from(parent.children).slice(wanted.length)) stale.remove();
}

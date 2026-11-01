// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetState } from './types';
import { FRAME_MARGIN, computeLayout, type Extent } from './layout';
import { drawNet, releaseNet, type DrawOptions, type DrawSummary } from './netDraw';
import { TOKEN_DOT_MAX } from './netHelpers';
import fixtureJson from './netDraw.fixture.json';

// Counts the layouts computed, so a test can tell a redraw from a re-layout.
vi.mock('./layout', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./layout')>();
	return { ...actual, computeLayout: vi.fn(actual.computeLayout) };
});

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The fixture net: five places (one styled, one nested), four transitions
 *  in the four looks, and eleven arcs of every stroke and head, two of them
 *  closing cycles. The browser suite draws the same file. */
const fixture = (): NetState => structuredClone(fixtureJson) as unknown as NetState;

/** The state as the public tier serves it to a share without payloads:
 *  each place its count and no tokens. */
function withoutPayloads(state: NetState): NetState {
	const places = Object.fromEntries(
		Object.entries(state.marking.places).map(([name, place]) => [name, { count: place.count }]),
	) as unknown as NetState['marking']['places'];
	return { ...state, marking: { places } };
}

function newSvg(attrs: Record<string, string> = { width: '800', height: '500' }): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
	document.body.append(svg);
	return svg;
}

const all = (svg: Element, selector: string) => Array.from(svg.querySelectorAll(selector));
const one = (svg: Element, selector: string): Element => {
	const found = svg.querySelector(selector);
	if (!found) throw new Error(`nothing matches ${selector}`);
	return found;
};
const place = (name: string) => `.net-place[data-place="${name}"]`;
const placeLabel = (name: string) => `.net-place-label[data-place="${name}"]`;
const transition = (name: string) => `.net-transition[data-transition="${name}"]`;
const rootTransform = (svg: Element) => one(svg, 'g.net-root').getAttribute('transform');

let svg: SVGSVGElement;

function draw(state: NetState, options?: DrawOptions): DrawSummary {
	return drawNet(svg, state, options);
}

beforeEach(() => {
	document.body.replaceChildren();
	vi.mocked(computeLayout).mockClear();
	svg = newSvg();
});

describe('drawNet: the scene', () => {
	it('draws every place, transition and arc of the fixture with its class, under one root group', () => {
		const summary = draw(fixture());
		expect(summary).toEqual({ places: 5, transitions: 4, edges: 11, relaidOut: true });
		expect(all(svg, ':scope > g.net-root')).toHaveLength(1);
		const layers = all(svg, 'g.net-root > g').map((g) => g.getAttribute('class'));
		expect(layers).toEqual(['net-arcs', 'net-places', 'net-tokens', 'net-place-labels', 'net-badges', 'net-transitions']);
		expect(all(svg, '.net-place').map((g) => g.getAttribute('data-place'))).toEqual(['Queue', 'Backlog', 'Light', 'Fleet', 'Done']);
		expect(all(svg, '.net-transition').map((g) => g.getAttribute('data-transition'))).toEqual(['Work', 'Sweep', 'Change', 'Park']);
		expect(all(svg, 'path.net-arc')).toHaveLength(11);
		expect(all(svg, '.net-place circle').every((c) => c.getAttribute('r') === '30')).toBe(true);
		const box = one(svg, `${transition('Change')} rect`);
		expect([box.getAttribute('width'), box.getAttribute('height')]).toEqual(['80', '50']);
	});

	it('strokes and heads each arc by its kind, and curves the arcs that close a cycle', () => {
		draw(fixture());
		const arcs = all(svg, 'path.net-arc');
		const look = (ends: string) => {
			const arc = arcs.find((a) => a.getAttribute('data-ends') === ends);
			if (!arc) throw new Error(`no arc ${ends}`);
			return [arc.getAttribute('data-stroke'), arc.getAttribute('data-head'), arc.getAttribute('stroke-dasharray')];
		};
		expect(look('in|Queue|Work')).toEqual(['solid', 'filled', null]);
		expect(look('in|Light|Work')).toEqual(['dashed', 'filled', '8 5']);
		expect(look('in|Backlog|Work')).toEqual(['dotted', 'filled', '2 4']);
		expect(look('in|Backlog|Sweep')).toEqual(['solid', 'hollow', null]);
		expect(look('in|Fleet|Sweep')).toEqual(['dashed', 'hollow', '8 5']);
		const hollow = arcs.find((a) => a.getAttribute('data-ends') === 'in|Fleet|Sweep')!;
		expect(hollow.getAttribute('class')).toContain('net-arc-head-hollow');
		const marker = /^url\(#(.+)\)$/.exec(hollow.getAttribute('marker-end') ?? '')?.[1];
		expect(one(svg, `marker[id="${marker}"] path`).getAttribute('fill')).toBe('#f0f0f0');
		const back = all(svg, 'path.net-arc-back');
		expect(back.length).toBeGreaterThan(0);
		expect(back.every((a) => / Q /.test(a.getAttribute('d') ?? ''))).toBe(true);
		expect(all(svg, 'path.net-arc:not(.net-arc-back)').every((a) => / L /.test(a.getAttribute('d') ?? ''))).toBe(true);
	});

	it('gives each transition its look: disabled grey and dashed, in flight pulsing amber, fireable green', () => {
		draw(fixture());
		const looks = Object.fromEntries(all(svg, '.net-transition').map((g) => [g.getAttribute('data-transition'), g.getAttribute('class')]));
		expect(looks).toEqual({
			Work: 'net-transition net-transition-fireable',
			Sweep: 'net-transition net-transition-in-flight',
			Change: 'net-transition net-transition-idle',
			Park: 'net-transition net-transition-disabled',
		});
		const box = (name: string) => one(svg, `${transition(name)} rect`);
		const paint = (name: string) => ['fill', 'stroke', 'stroke-width', 'stroke-dasharray'].map((a) => box(name).getAttribute(a));
		expect(paint('Work')).toEqual(['white', '#22c55e', '4', null]);
		expect(paint('Sweep')).toEqual(['white', '#f59e0b', '4', null]);
		expect(paint('Change')).toEqual(['white', '#0066cc', '3', null]);
		expect(paint('Park')).toEqual(['#f8f9fa', '#9ca3af', '3', '6 4']);
		expect(box('Sweep').querySelector('animate')?.getAttribute('attributeName')).toBe('stroke-opacity');
		expect(box('Work').querySelector('animate')).toBeNull();
		expect(one(svg, `${transition('Park')} .net-transition-name:not(.net-outline)`).getAttribute('fill')).toBe('#9ca3af');
		// The function's name, when it differs, is the second line.
		expect(one(svg, `${transition('Work')} .net-transition-subtitle:not(.net-outline)`).textContent).toBe('do_work');
		expect(svg.querySelector(`${transition('Sweep')} .net-transition-subtitle`)).toBeNull();
	});

	it('draws token dots in their colours up to the cap, a count from seven, a styled fill and the badge of a token holding nets', () => {
		draw(fixture());
		const dots = (name: string) => all(svg, `.net-token[data-place="${name}"]`);
		expect(dots('Queue').map((d) => d.getAttribute('fill'))).toEqual(['#4f9dde', '#22c55e', '#f59e0b']);
		expect(dots('Backlog')).toHaveLength(TOKEN_DOT_MAX);
		expect(dots('Backlog').every((d) => d.getAttribute('fill') === '#9ca3af')).toBe(true);
		const count = (name: string) => svg.querySelector(`${placeLabel(name)} .net-count`)?.textContent ?? null;
		expect(['Queue', 'Backlog', 'Light', 'Fleet', 'Done'].map(count)).toEqual([null, '25', null, null, null]);
		expect(one(svg, place('Light')).getAttribute('class')).toBe('net-place net-place-filled');
		expect(one(svg, `${place('Light')} circle`).getAttribute('fill')).toBe('#ef4444');
		expect(one(svg, `${place('Queue')} circle`).getAttribute('fill')).toBe('white');
		const badges = all(svg, '.net-badge');
		expect(badges.map((b) => [b.getAttribute('data-token'), b.textContent])).toEqual([['300', '3']]);
		expect(one(svg, '.net-token[data-token="300"]').getAttribute('data-holds-nets')).toBe('true');
	});

	it('shows token labels by default when the state carries tokens', () => {
		draw(fixture());
		expect(one(svg, '.net-token[data-token="2"] title').textContent).toBe("Job(id=2, kind='render')");
		const caption = (name: string) => svg.querySelector(`${placeLabel(name)} .net-token-label:not(.net-outline)`)?.textContent ?? null;
		// Cut to twenty characters, the last an ellipsis, and how many more.
		expect(caption('Queue')).toBe("Job(id=1, kind='ren\u2026 +2");
		expect(caption('Light')).toBe('red');
		expect(caption('Backlog')).toBe('Job(id=100) +24');
		expect(caption('Done')).toBeNull();
	});

	it('leaves labels off without tokens, and every place that holds some shows its count instead', () => {
		const summary = draw(withoutPayloads(fixture()));
		expect(summary).toMatchObject({ places: 5, transitions: 4, edges: 11 });
		expect(all(svg, '.net-token')).toHaveLength(0);
		expect(all(svg, 'title')).toHaveLength(0);
		expect(all(svg, '.net-token-label')).toHaveLength(0);
		const counts = Object.fromEntries(all(svg, '.net-place-label').map((g) => [g.getAttribute('data-place'), g.querySelector('.net-count')?.textContent ?? null]));
		expect(counts).toEqual({ Queue: '3', Backlog: '25', Light: '1', Fleet: '1', Done: null });
		// Without its token's colour a styled place keeps the theme's fill.
		expect(one(svg, `${place('Light')} circle`).getAttribute('fill')).toBe('white');
	});

	it('takes token labels off or on when the options say so', () => {
		draw(fixture(), { tokenLabels: false });
		expect(all(svg, '.net-token')).toHaveLength(3 + TOKEN_DOT_MAX + 1 + 1);
		expect(all(svg, 'title')).toHaveLength(0);
		expect(all(svg, '.net-token-label')).toHaveLength(0);
		draw(fixture(), { tokenLabels: true });
		expect(all(svg, 'title').length).toBeGreaterThan(0);
	});

	it('writes no style attribute, style element or script, only presentation attributes and classes', () => {
		draw(fixture());
		draw(withoutPayloads(fixture()));
		expect(all(svg, '[style]')).toHaveLength(0);
		expect(all(svg, 'style, script, image, foreignObject')).toHaveLength(0);
		expect(svg.hasAttribute('style')).toBe(false);
	});
});

describe('drawNet: the frame', () => {
	it('frames the drawing with frameView in the size of the svg, keeping its aspect ratio', () => {
		draw(fixture());
		const [x, y, width, height] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
		expect([width, height]).toEqual([800, 500]);
		expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
		expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
	});

	it('takes the frame from the options first, and 800 by 500 when the svg gives none', () => {
		drawNet(newSvg({ width: '100%' }), fixture());
		expect(document.querySelectorAll('svg')[1].getAttribute('viewBox')?.split(' ').slice(2)).toEqual(['800', '500']);
		draw(fixture(), { width: 1200, height: 900 });
		expect(svg.getAttribute('viewBox')?.split(' ').slice(2)).toEqual(['1200', '900']);
	});

	it('gives two drawings on one page their own marker ids', () => {
		const other = newSvg();
		draw(fixture());
		drawNet(other, fixture());
		const ids = (s: Element) => all(s, 'marker').map((m) => m.id);
		expect(ids(svg)).toHaveLength(3);
		expect(ids(svg).filter((id) => ids(other).includes(id))).toEqual([]);
	});
});

describe('drawNet: updates', () => {
	it('updates a changed marking in place, the same elements, without laying out again', () => {
		draw(fixture());
		expect(computeLayout).toHaveBeenCalledTimes(1);
		const circle = one(svg, `${place('Queue')} circle`);
		const work = one(svg, transition('Work'));
		const arcs = all(svg, 'path.net-arc');
		const viewBox = svg.getAttribute('viewBox');

		const next = fixture();
		next.marking_version = 8;
		next.marking.places.Queue = { count: 9, tokens: [...next.marking.places.Queue.tokens, { id: '4', label: 'Job(id=4)' }] };
		next.marking.places.Light = { count: 1, tokens: [{ id: '201', label: 'green', color: '#22c55e' }] };
		next.transitions.Work = { enabled: true, fireable: false, in_flight: false };
		const summary = draw(next);

		expect(summary.relaidOut).toBe(false);
		expect(computeLayout).toHaveBeenCalledTimes(1);
		expect(one(svg, `${place('Queue')} circle`)).toBe(circle);
		expect(one(svg, transition('Work'))).toBe(work);
		expect(all(svg, 'path.net-arc')).toEqual(arcs);
		expect(svg.getAttribute('viewBox')).toBe(viewBox);
		expect(all(svg, '.net-token[data-place="Queue"]')).toHaveLength(4);
		expect(one(svg, `${placeLabel('Queue')} .net-count`).textContent).toBe('9');
		expect(work.getAttribute('class')).toBe('net-transition net-transition-idle');
		expect(one(svg, `${place('Light')} circle`).getAttribute('fill')).toBe('#22c55e');
		expect(all(svg, ':scope > g.net-root')).toHaveLength(1);
		expect(all(svg, ':scope > defs')).toHaveLength(1);
	});

	it('updates a count drawn from a state without payloads', () => {
		draw(withoutPayloads(fixture()));
		const label = one(svg, `${placeLabel('Queue')} .net-count`);
		const next = withoutPayloads(fixture());
		next.marking.places.Queue = { count: 4 } as NetState['marking']['places'][string];
		draw(next);
		expect(one(svg, `${placeLabel('Queue')} .net-count`)).toBe(label);
		expect(label.textContent).toBe('4');
	});

	it('lays out again for a changed topology and for a new generation, and resets the view', () => {
		draw(fixture());
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		expect(rootTransform(svg)).not.toBe('translate(0 0) scale(1)');

		const grown = fixture();
		grown.topology.places.push({ name: 'Archive', type_name: 'Job', serializable: true });
		grown.topology.edges.push({ place: 'Archive', transition: 'Park', direction: 'out' });
		expect(draw(grown)).toMatchObject({ places: 6, edges: 12, relaidOut: true });
		expect(computeLayout).toHaveBeenCalledTimes(2);
		expect(rootTransform(svg)).toBe('translate(0 0) scale(1)');
		expect(svg.querySelector(place('Archive'))).not.toBeNull();

		expect(draw(grown).relaidOut).toBe(false);
		const reloaded = { ...grown, generation: 2 };
		expect(draw(reloaded).relaidOut).toBe(true);
		expect(computeLayout).toHaveBeenCalledTimes(3);
	});
});

describe('drawNet: pan and zoom', () => {
	it('zooms the root group by wheel, 2.5% a step', () => {
		draw(fixture());
		expect(rootTransform(svg)).toBe('translate(0 0) scale(1)');
		const wheel = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
		svg.dispatchEvent(wheel);
		expect(wheel.defaultPrevented).toBe(true);
		expect(rootTransform(svg)).toMatch(/ scale\(1\.025\)$/);
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
		expect(rootTransform(svg)).toMatch(/ scale\(0\.99937/);
	});

	it('pans the root group by drag, until the button is released', () => {
		draw(fixture());
		svg.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
		document.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 30, bubbles: true }));
		expect(rootTransform(svg)).toBe('translate(30 20) scale(1)');
		expect(svg.getAttribute('cursor')).toBe('grabbing');
		document.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 40, clientY: 30, bubbles: true }));
		document.dispatchEvent(new PointerEvent('pointermove', { clientX: 90, clientY: 90, bubbles: true }));
		expect(rootTransform(svg)).toBe('translate(30 20) scale(1)');
		expect(svg.getAttribute('cursor')).toBe('grab');
	});

	it('keeps the view across a redraw of the same net', () => {
		draw(fixture());
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		const zoomed = rootTransform(svg);
		draw(fixture());
		expect(rootTransform(svg)).toBe(zoomed);
	});

	it('listens for nothing when not interactive, and stops listening when switched off', () => {
		draw(fixture(), { interactive: false });
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		expect(rootTransform(svg)).toBe('translate(0 0) scale(1)');
		expect(svg.hasAttribute('cursor')).toBe(false);
		draw(fixture());
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		expect(rootTransform(svg)).toMatch(/scale\(1\.025\)$/);
		draw(fixture(), { interactive: false });
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		expect(rootTransform(svg)).toMatch(/scale\(1\.025\)$/);
	});
});

/** The root group's transform, read back from its attribute. */
function transformOf(svg: Element): { x: number; y: number; k: number } {
	const match = /^translate\((\S+) (\S+)\) scale\((\S+)\)$/.exec(rootTransform(svg) ?? '');
	if (!match) throw new Error(`unreadable transform ${rootTransform(svg)}`);
	return { x: Number(match[1]), y: Number(match[2]), k: Number(match[3]) };
}

/** Every place and transition as the box of its shape, in the frame's own
 *  coordinates: through the root transform, then from the view box's
 *  corner, so the frame is [0, width] by [0, height]. */
function nodeBoxesInFrame(svg: Element): Array<{ name: string; left: number; top: number; right: number; bottom: number }> {
	const t = transformOf(svg);
	const [vx, vy] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
	const at = (x: number, y: number) => ({ x: t.x + t.k * x - vx, y: t.y + t.k * y - vy });
	const box = (name: string, cx: number, cy: number, halfW: number, halfH: number) => {
		const a = at(cx - halfW, cy - halfH);
		const b = at(cx + halfW, cy + halfH);
		return { name, left: a.x, top: a.y, right: b.x, bottom: b.y };
	};
	const num = (el: Element, attr: string) => Number(el.getAttribute(attr));
	return [
		...all(svg, '.net-place circle').map((c) => box(c.parentElement?.getAttribute('data-place') ?? '', num(c, 'cx'), num(c, 'cy'), 30, 30)),
		...all(svg, '.net-transition rect').map((r) =>
			box(r.parentElement?.getAttribute('data-transition') ?? '', num(r, 'x') + 40, num(r, 'y') + 25, 40, 25),
		),
	];
}

/** The extent of the layout computed last. */
function lastExtent(): Extent {
	const extent = vi.mocked(computeLayout).mock.results.at(-1)?.value.extent;
	if (!extent) throw new Error('no layout computed');
	return extent;
}

/** The fit's scale for an extent in a frame, as the option promises it. */
function fittedScale(extent: Extent, width: number, height: number): number {
	return Math.min(1, (width - 2 * FRAME_MARGIN) / (extent.maxX - extent.minX), (height - 2 * FRAME_MARGIN) / (extent.maxY - extent.minY));
}

describe('drawNet: fit', () => {
	/** Three places and two transitions in a line: short enough for any frame here. */
	const small = (): NetState => {
		const state = fixture();
		state.topology = {
			places: [
				{ name: 'A', serializable: true },
				{ name: 'B', serializable: true },
			],
			transitions: [{ name: 'Go' }],
			edges: [
				{ place: 'A', transition: 'Go', direction: 'in', kind: 'take' },
				{ place: 'B', transition: 'Go', direction: 'out' },
			],
		};
		state.transitions = { Go: { enabled: true, fireable: false, in_flight: false } };
		state.marking = { places: { A: { count: 1, tokens: [{ id: '1', label: 'a' }] } } };
		return state;
	};

	it('scales a net taller than the frame down until every node is inside it, centred', () => {
		draw(fixture(), { fit: true });
		const extent = lastExtent();
		expect(extent.maxY - extent.minY).toBeGreaterThan(500 - 2 * FRAME_MARGIN);
		const t = transformOf(svg);
		expect(t.k).toBeLessThan(1);
		expect(t.k).toBeCloseTo(fittedScale(extent, 800, 500), 12);
		for (const node of nodeBoxesInFrame(svg)) {
			expect(node.left, node.name).toBeGreaterThanOrEqual(0);
			expect(node.top, node.name).toBeGreaterThanOrEqual(0);
			expect(node.right, node.name).toBeLessThanOrEqual(800);
			expect(node.bottom, node.name).toBeLessThanOrEqual(500);
		}
		const boxes = nodeBoxesInFrame(svg);
		const top = Math.min(...boxes.map((b) => b.top));
		const bottom = Math.max(...boxes.map((b) => b.bottom));
		expect(top).toBeCloseTo(500 - bottom, 9);
		expect(top).toBeCloseTo(FRAME_MARGIN, 9);
	});

	it('leaves a net that fits at scale 1, centred in the frame', () => {
		draw(small(), { fit: true });
		const t = transformOf(svg);
		expect(t.k).toBe(1);
		const boxes = nodeBoxesInFrame(svg);
		const middle = (lo: number[], hi: number[]) => (Math.min(...lo) + Math.max(...hi)) / 2;
		expect(middle(boxes.map((b) => b.left), boxes.map((b) => b.right))).toBeCloseTo(400, 9);
		expect(middle(boxes.map((b) => b.top), boxes.map((b) => b.bottom))).toBeCloseTo(250, 9);
	});

	it('changes nothing without the option: the net at the app size from its first rank', () => {
		draw(fixture());
		expect(rootTransform(svg)).toBe('translate(0 0) scale(1)');
		draw(fixture(), { fit: false });
		expect(rootTransform(svg)).toBe('translate(0 0) scale(1)');
	});

	it('keeps the viewer\'s pan and zoom across a redraw that does not lay out again', () => {
		draw(fixture(), { fit: true });
		const fitted = rootTransform(svg);
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		svg.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
		document.dispatchEvent(new PointerEvent('pointermove', { clientX: 25, clientY: -15, bubbles: true }));
		document.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
		const moved = rootTransform(svg);
		expect(moved).not.toBe(fitted);

		const next = fixture();
		next.marking_version = 8;
		next.marking.places.Done = { count: 1, tokens: [{ id: '9', label: 'Job(id=9)' }] };
		expect(draw(next, { fit: true }).relaidOut).toBe(false);
		expect(rootTransform(svg)).toBe(moved);
	});

	it('fits again after a re-layout', () => {
		draw(fixture(), { fit: true });
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
		const grown = fixture();
		grown.topology.places.push({ name: 'Archive', type_name: 'Job', serializable: true });
		grown.topology.edges.push({ place: 'Archive', transition: 'Park', direction: 'out' });
		expect(draw(grown, { fit: true }).relaidOut).toBe(true);
		expect(transformOf(svg).k).toBeCloseTo(fittedScale(lastExtent(), 800, 500), 12);
		for (const node of nodeBoxesInFrame(svg)) {
			expect(node.left, node.name).toBeGreaterThanOrEqual(0);
			expect(node.top, node.name).toBeGreaterThanOrEqual(0);
			expect(node.right, node.name).toBeLessThanOrEqual(800);
			expect(node.bottom, node.name).toBeLessThanOrEqual(500);
		}
	});

	it('fits a frame too small for the margin edge to edge, never flipping the drawing', () => {
		draw(fixture(), { fit: true, width: 100, height: 100 });
		const t = transformOf(svg);
		expect(t.k).toBeGreaterThan(0);
		for (const node of nodeBoxesInFrame(svg)) {
			expect(node.top, node.name).toBeGreaterThanOrEqual(-1e-9);
			expect(node.bottom, node.name).toBeLessThanOrEqual(100 + 1e-9);
		}
	});
});

describe('drawNet: fit floor', () => {
	/** One transition feeding forty-five places in a single rank, the shape
	 *  of the reachability monitor: fitted whole into 800 by 500 it would be
	 *  drawn at under a tenth of its size. */
	const wide = (): NetState => {
		const state = fixture();
		const probes = Array.from({ length: 45 }, (_, i) => `Probe${String(i + 1).padStart(2, '0')}`);
		state.topology = {
			places: [{ name: 'Targets', serializable: true }, ...probes.map((name) => ({ name, serializable: true }))],
			transitions: [{ name: 'Measure' }],
			edges: [
				{ place: 'Targets', transition: 'Measure', direction: 'in', kind: 'take' },
				...probes.map((name) => ({ place: name, transition: 'Measure', direction: 'out' as const })),
			],
		};
		state.transitions = { Measure: { enabled: true, fireable: false, in_flight: false } };
		state.marking = { places: { Targets: { count: 1, tokens: [{ id: '1', label: 'target' }] } } };
		return state;
	};

	const doubleClick = (target: Element = svg): MouseEvent => {
		const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 });
		target.dispatchEvent(event);
		return event;
	};

	/** Where the extent's centre lands, through the root transform. */
	const extentCentreDrawn = (extent: Extent) => {
		const t = transformOf(svg);
		return { x: t.x + t.k * (extent.minX + extent.maxX) / 2, y: t.y + t.k * (extent.minY + extent.maxY) / 2 };
	};

	/** The frame's centre in user units: the view box's middle. */
	const frameCentre = () => {
		const [x, y, width, height] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
		return { x: x + width / 2, y: y + height / 2 };
	};

	/** The transform the same state, options and frame get from `fit` alone, drawn on an svg of its own. */
	const fitAlone = (state: NetState, options: DrawOptions = {}): string | null => {
		const other = newSvg();
		drawNet(other, state, { ...options, fit: true, fitFloor: undefined });
		return rootTransform(other);
	};

	/** A marking-only change of the wide net: one more token on a probe. */
	const marked = (): NetState => {
		const next = wide();
		next.marking_version = 8;
		next.marking.places.Probe07 = { count: 1, tokens: [{ id: '2', label: 'loss' }] };
		return next;
	};

	/** The wide net with a forty-sixth probe: a changed topology, so a re-layout. */
	const grown = (): NetState => {
		const next = wide();
		next.topology.places.push({ name: 'Probe46', serializable: true });
		next.topology.edges.push({ place: 'Probe46', transition: 'Measure', direction: 'out' });
		return next;
	};

	it('holds a net that would fit below the floor at the floor\'s scale, its middle at the frame\'s middle', () => {
		draw(wide(), { fit: true, fitFloor: 0.5 });
		const extent = lastExtent();
		expect(fittedScale(extent, 800, 500)).toBeLessThan(0.1);
		expect(transformOf(svg).k).toBe(0.5);
		const drawn = extentCentreDrawn(extent);
		const centre = frameCentre();
		expect(drawn.x).toBeCloseTo(centre.x, 9);
		expect(drawn.y).toBeCloseTo(centre.y, 9);
	});

	it('changes nothing when the fit is already at or above the floor, or the floor is at or below 0', () => {
		draw(fixture(), { fit: true, fitFloor: 0.5 });
		expect(fittedScale(lastExtent(), 800, 500)).toBeGreaterThan(0.5);
		expect(rootTransform(svg)).toBe(fitAlone(fixture()));

		for (const fitFloor of [0, -1, Number.NaN]) {
			releaseNet(svg);
			draw(wide(), { fit: true, fitFloor });
			expect(rootTransform(svg), String(fitFloor)).toBe(fitAlone(wide()));
		}
	});

	it('counts a floor above 1 as 1: the net at its own size, centred, never scaled up', () => {
		draw(wide(), { fit: true, fitFloor: 3 });
		expect(transformOf(svg).k).toBe(1);
		const drawn = extentCentreDrawn(lastExtent());
		expect(drawn.x).toBeCloseTo(frameCentre().x, 9);
		expect(drawn.y).toBeCloseTo(frameCentre().y, 9);
	});

	it('leaves the floor alone without fit', () => {
		draw(wide(), { fitFloor: 0.5 });
		expect(rootTransform(svg)).toBe('translate(0 0) scale(1)');
	});

	it('toggles by double-click to the whole net and back, cancelling the browser\'s own response', () => {
		draw(wide(), { fit: true, fitFloor: 0.5 });
		const floored = rootTransform(svg);
		const whole = fitAlone(wide());
		expect(whole).not.toBe(floored);

		const first = doubleClick();
		expect(first.defaultPrevented).toBe(true);
		expect(rootTransform(svg)).toBe(whole);
		expect(transformOf(svg).k).toBeCloseTo(fittedScale(lastExtent(), 800, 500), 12);
		doubleClick();
		expect(rootTransform(svg)).toBe(floored);
		doubleClick();
		expect(rootTransform(svg)).toBe(whole);
	});

	it('toggles to the other view from wherever the viewer panned or zoomed to', () => {
		draw(wide(), { fit: true, fitFloor: 0.5 });
		const floored = rootTransform(svg);
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		doubleClick();
		expect(rootTransform(svg)).toBe(fitAlone(wide()));
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
		doubleClick();
		expect(rootTransform(svg)).toBe(floored);
	});

	it('keeps the toggled view across a marking-only redraw, and the next double-click goes back', () => {
		draw(wide(), { fit: true, fitFloor: 0.5 });
		const floored = rootTransform(svg);
		doubleClick();
		const whole = rootTransform(svg);
		expect(draw(marked(), { fit: true, fitFloor: 0.5 }).relaidOut).toBe(false);
		expect(rootTransform(svg)).toBe(whole);
		doubleClick();
		expect(rootTransform(svg)).toBe(floored);
	});

	it('returns to the floored view after a re-layout, and the next double-click shows the whole net', () => {
		draw(wide(), { fit: true, fitFloor: 0.5 });
		doubleClick();
		expect(transformOf(svg).k).toBeLessThan(0.5);
		expect(draw(grown(), { fit: true, fitFloor: 0.5 }).relaidOut).toBe(true);
		expect(transformOf(svg).k).toBe(0.5);
		const drawn = extentCentreDrawn(lastExtent());
		expect(drawn.x).toBeCloseTo(frameCentre().x, 9);
		expect(drawn.y).toBeCloseTo(frameCentre().y, 9);
		doubleClick();
		expect(rootTransform(svg)).toBe(fitAlone(grown()));
	});

	it('returns a net that already fits to its fitted view by double-click, after a wheel or a drag', () => {
		draw(fixture(), { fit: true, fitFloor: 0.5 });
		const fitted = rootTransform(svg);
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		expect(rootTransform(svg)).not.toBe(fitted);
		expect(doubleClick().defaultPrevented).toBe(true);
		expect(rootTransform(svg)).toBe(fitted);

		svg.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
		document.dispatchEvent(new PointerEvent('pointermove', { clientX: 25, clientY: -15, bubbles: true }));
		document.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
		expect(rootTransform(svg)).not.toBe(fitted);
		doubleClick();
		expect(rootTransform(svg)).toBe(fitted);
	});

	it('cancels the second press of a double-click on a fitted drawing, where the browser would select a word', () => {
		const press = (detail: number) => {
			const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail });
			one(svg, `${transition('Measure')} text`).dispatchEvent(event);
			return event.defaultPrevented;
		};
		draw(wide(), { fit: true, fitFloor: 0.5 });
		expect([press(1), press(2), press(3)]).toEqual([false, true, true]);
		draw(wide());
		expect(press(2)).toBe(false);
	});

	it('hears a double-click on a node inside the drawing', () => {
		draw(wide(), { fit: true, fitFloor: 0.5 });
		doubleClick(one(svg, `${transition('Measure')} rect`));
		expect(rootTransform(svg)).toBe(fitAlone(wide()));
	});

	it('does nothing on a double-click without fit, or when not interactive', () => {
		draw(wide());
		const event = doubleClick();
		expect(event.defaultPrevented).toBe(false);
		expect(rootTransform(svg)).toBe('translate(0 0) scale(1)');

		releaseNet(svg);
		draw(wide(), { fit: true, fitFloor: 0.5, interactive: false });
		const floored = rootTransform(svg);
		expect(doubleClick().defaultPrevented).toBe(false);
		expect(rootTransform(svg)).toBe(floored);
	});

	it('stops hearing the double-click once released', () => {
		draw(wide(), { fit: true, fitFloor: 0.5 });
		const floored = rootTransform(svg);
		releaseNet(svg);
		expect(doubleClick().defaultPrevented).toBe(false);
		expect(rootTransform(svg)).toBe(floored);
	});
});

describe('releaseNet', () => {
	it('forgets the element: its listeners go, and the next draw starts over with one drawing', () => {
		draw(fixture());
		releaseNet(svg);
		svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
		expect(rootTransform(svg)).toBe('translate(0 0) scale(1)');
		expect(svg.hasAttribute('cursor')).toBe(false);

		expect(draw(fixture()).relaidOut).toBe(true);
		expect(computeLayout).toHaveBeenCalledTimes(2);
		expect(all(svg, ':scope > g.net-root')).toHaveLength(1);
		expect(all(svg, ':scope > defs')).toHaveLength(1);
		expect(all(svg, '.net-place')).toHaveLength(5);
	});

	it('leaves alone what the host page put in the svg', () => {
		const title = document.createElementNS(SVG_NS, 'title');
		title.textContent = 'The fixture net';
		svg.append(title);
		draw(fixture());
		releaseNet(svg);
		draw(fixture());
		expect(svg.firstElementChild).toBe(title);
	});

	it('is harmless on an element never drawn into', () => {
		expect(() => releaseNet(newSvg())).not.toThrow();
	});
});

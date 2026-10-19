import { describe, expect, it } from 'vitest';
import type { Control, TransitionState } from './types';
import {
	followsNet,
	initialValue,
	isLit,
	noticeOfAnswer,
	noticeOfError,
	selectOptions,
	sliderRange,
	snap,
	toggleOn,
	widgetOf,
} from './controls';
import { NetProxyError } from './api';

const control = (fields: Partial<Control> & Pick<Control, 'kind'>): Control => ({ name: 'c', label: 'C', ...fields });

const transitions: Record<string, TransitionState> = {
	Go: { enabled: true, fireable: false, in_flight: false },
	Change: { enabled: true, fireable: true, in_flight: false },
	Off: { enabled: false, fireable: false, in_flight: false },
};

describe('controls', () => {
	it('draws each kind with its widget, and a kind it does not know with none', () => {
		const kinds = ['button', 'toggle', 'slider', 'select', 'text', 'knob'];
		expect(kinds.map((kind) => widgetOf(control({ kind })))).toEqual([
			'button', 'toggle', 'slider', 'select', 'text', 'none',
		]);
	});

	it("reads a slider's range from start, stop and step, 0 to 100 in hundredths when not given", () => {
		expect(sliderRange(control({ kind: 'slider', config: { start: 1, stop: 9, step: 2 } }))).toEqual({ start: 1, stop: 9, step: 2 });
		expect(sliderRange(control({ kind: 'slider' }))).toEqual({ start: 0, stop: 100, step: 1 });
		expect(sliderRange(control({ kind: 'slider', config: { start: 0, stop: 1 } }))).toEqual({ start: 0, stop: 1, step: 0.01 });
		// A range with no width still has a step, and a stop below its start is the start.
		expect(sliderRange(control({ kind: 'slider', config: { start: 5, stop: 2 } }))).toEqual({ start: 5, stop: 5, step: 1 });
	});

	it('snaps a number to the steps from the start, within the bounds', () => {
		const range = { start: 0, stop: 1, step: 0.1 };
		expect(snap(0.31, range)).toBe(0.3);
		expect(snap(-4, range)).toBe(0);
		expect(snap(7, range)).toBe(1);
		expect(snap(Number.NaN, range)).toBe(0);
		expect(snap(4, { start: 1, stop: 10, step: 2 })).toBe(5);
	});

	it('starts each row from its initial value', () => {
		expect(initialValue(control({ kind: 'button' }))).toBeUndefined();
		expect(initialValue(control({ kind: 'toggle', config: { value: true } }))).toBe(true);
		expect(initialValue(control({ kind: 'toggle' }))).toBe(false);
		expect(initialValue(control({ kind: 'slider', config: { start: 0, stop: 10, step: 1, value: 3 } }))).toBe(3);
		expect(initialValue(control({ kind: 'slider', config: { start: 2, stop: 10 } }))).toBe(2);
		expect(initialValue(control({ kind: 'select', config: { options: ['calm', 'busy'], value: 'busy' } }))).toBe('busy');
		expect(initialValue(control({ kind: 'select', config: { options: ['calm', 'busy'], value: 'nope' } }))).toBe('calm');
		expect(initialValue(control({ kind: 'text', config: { placeholder: 'name' } }))).toBe('');
		expect(selectOptions(control({ kind: 'select', config: { options: ['a', 2 as unknown as string, 'b'] } }))).toEqual(['a', 'b']);
	});

	it('lights a fire row only while its transition is fireable, and every other row always', () => {
		expect(isLit(control({ kind: 'button', action: 'fire', node: 'Change' }), transitions)).toBe(true);
		expect(isLit(control({ kind: 'button', action: 'fire', node: 'Go' }), transitions)).toBe(false);
		expect(isLit(control({ kind: 'button', action: 'fire', node: 'Gone' }), transitions)).toBe(false);
		expect(isLit(control({ kind: 'text', action: 'inject', node: 'Waiting' }), transitions)).toBe(true);
		expect(isLit(control({ kind: 'button' }), transitions)).toBe(true);
	});

	it("shows an enable toggle as its transition's switch, and any other as what it holds", () => {
		const enable = (node: string) => control({ kind: 'toggle', action: 'enable', node });
		expect([toggleOn(enable('Go'), transitions, false), toggleOn(enable('Off'), transitions, true)]).toEqual([true, false]);
		expect([followsNet(enable('Go'), transitions), followsNet(enable('Gone'), transitions)]).toEqual([true, false]);
		// A node the net does not have leaves the row to hold its own state.
		expect(toggleOn(enable('Gone'), transitions, true)).toBe(true);
		expect(toggleOn(control({ kind: 'toggle' }), transitions, true)).toBe(true);
		expect(toggleOn(control({ kind: 'toggle' }), transitions, undefined)).toBe(false);
	});

	it('says what a press left: nothing for pressed, the reason for nothing, the refusal for an error', () => {
		const change = control({ name: 'change', label: 'Change', kind: 'button' });
		expect(noticeOfAnswer(change, { status: 'pressed', marking_version: 4 })).toBeNull();
		expect(noticeOfAnswer(change, { status: 'nothing', reason: 'Change is not fireable', marking_version: 4 })).toEqual({
			text: 'Change: Change is not fireable',
			error: false,
		});
		expect(noticeOfAnswer(change, { status: 'nothing', marking_version: 4 })?.text).toBe('Change: nothing to do');
		expect(noticeOfError(change, new NetProxyError("no control named 'change'", 404, 'unknown_control'))).toEqual({
			text: "Change: no control named 'change'",
			error: true,
		});
	});
});

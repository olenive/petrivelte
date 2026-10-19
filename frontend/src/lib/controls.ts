/**
 * The legend's rules for the controls a net declares (protocol §5.1, §6.6):
 * the widget each kind is drawn with, each row's starting value, a slider's
 * range, which rows are lit, and the line a press's answer leaves. The page
 * never runs a control: it names it and carries the value, and the runtime
 * that owns the net runs it. `ControlsLegend.svelte` draws the rows; the
 * nets page sends the presses.
 */

import type { Control, ControlValue, PressResult, TransitionState } from '$lib/types';

/** The widget a row is drawn with. A kind this page does not know is drawn
 *  as its label alone, with nothing to press. */
export type Widget = 'button' | 'toggle' | 'slider' | 'select' | 'text' | 'none';

const WIDGETS: readonly Widget[] = ['button', 'toggle', 'slider', 'select', 'text'];

export function widgetOf(control: Control): Widget {
	return WIDGETS.find((widget) => widget === control.kind) ?? 'none';
}

export interface SliderRange {
	start: number;
	stop: number;
	step: number;
}

const DEFAULT_START = 0;
const DEFAULT_STOP = 100;

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A slider's bounds and step from its `config.start`, `config.stop` and
 *  `config.step`: 0 to 100 when not given, and a hundredth of the range
 *  when no step is given. */
export function sliderRange(control: Control): SliderRange {
	const config = control.config ?? {};
	const start = finite(config.start) ?? DEFAULT_START;
	const stop = Math.max(start, finite(config.stop) ?? DEFAULT_STOP);
	const given = finite(config.step);
	const step = given !== undefined && given > 0 ? given : (stop - start) / 100 || 1;
	return { start, stop, step };
}

/** `n` clamped to the slider's bounds and snapped to its steps from
 *  `start`, rounded to nine places so that `0.1 * 3` reads `0.3`. */
export function snap(n: number, range: SliderRange): number {
	const { start, stop, step } = range;
	const clamped = Math.min(stop, Math.max(start, Number.isFinite(n) ? n : start));
	const stepped = start + Math.round((clamped - start) / step) * step;
	return Math.min(stop, Math.max(start, Math.round(stepped * 1e9) / 1e9));
}

/** What a row holds before anyone touches it: a toggle's state (off unless
 *  `config.value` says on), a slider's number (`config.value`, else its
 *  start), a select's option (`config.value` when it is one of the options,
 *  else the first), a text box's text (empty). A button holds nothing. */
export function initialValue(control: Control): ControlValue | undefined {
	const value = control.config?.value;
	switch (widgetOf(control)) {
		case 'toggle':
			return value === true;
		case 'slider': {
			const range = sliderRange(control);
			return snap(typeof value === 'number' ? value : range.start, range);
		}
		case 'select': {
			const options = selectOptions(control);
			return typeof value === 'string' && options.includes(value) ? value : (options[0] ?? '');
		}
		case 'text':
			return '';
		default:
			return undefined;
	}
}

/** A select's options, the strings among `config.options`. */
export function selectOptions(control: Control): string[] {
	const options = control.config?.options;
	return Array.isArray(options) ? options.filter((option): option is string => typeof option === 'string') : [];
}

/** Whether a row is lit (§5.1): a `fire` row only while its node is
 *  fireable; every other row always. A dim row still sends, and the
 *  runtime says it did nothing. */
export function isLit(control: Control, transitions: Record<string, TransitionState>): boolean {
	if (control.action !== 'fire' || !control.node) return true;
	return transitions[control.node]?.fireable === true;
}

/** Whether a toggle shows on: an `enable` toggle shows its transition's
 *  `enabled` switch, which `toggled` moves; any other shows what was last
 *  sent, or its initial value. */
export function toggleOn(
	control: Control,
	transitions: Record<string, TransitionState>,
	held: ControlValue | undefined,
): boolean {
	const node = control.node;
	if (control.action === 'enable' && node && transitions[node]) return transitions[node].enabled;
	return held === true;
}

/** Whether a toggle's state is the net's own (`enable`), rather than the row's. */
export function followsNet(control: Control, transitions: Record<string, TransitionState>): boolean {
	return control.action === 'enable' && !!control.node && !!transitions[control.node];
}

/** The line under the rows after a press: its label and why it did
 *  nothing, or its label and the refusal. A press that applied something
 *  leaves no line. */
export interface PressNotice {
	text: string;
	error: boolean;
}

export function noticeOfAnswer(control: Control, answer: PressResult): PressNotice | null {
	if (answer?.status !== 'nothing') return null;
	return { text: `${control.label}: ${answer.reason || 'nothing to do'}`, error: false };
}

export function noticeOfError(control: Control, error: unknown): PressNotice {
	const message = error instanceof Error ? error.message : String(error);
	return { text: `${control.label}: ${message}`, error: true };
}

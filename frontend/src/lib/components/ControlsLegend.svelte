<script lang="ts">
	/**
	 * The legend: the controls the net declares (protocol §5.1), drawn with
	 * native widgets in a panel at the graph's top-left, as the Bevy viewer
	 * draws its legend at the canvas's. One row per control in declaration
	 * order. A press names the control and carries the value its kind
	 * takes (`onPress`); the runtime runs it. A `fire` row is dim while its
	 * transition is not fireable and still sends; an `enable` toggle shows
	 * its transition's switch. Resting on a row lights the node it acts on
	 * (`onHover`). A row's widgets are disabled while its press is in
	 * flight; a text box is only read-only then, so that it keeps the focus
	 * for the next name. The colours read the theme's variables directly, as
	 * the graph panel's other bars do.
	 */
	import { onDestroy } from 'svelte';
	import type { Control, ControlValue, TransitionState } from '$lib/types';
	import {
		followsNet,
		initialValue,
		isLit,
		selectOptions,
		sliderRange,
		snap,
		toggleOn,
		widgetOf,
		type PressNotice,
	} from '$lib/controls';

	interface Props {
		/** The outer net's controls, in declaration order. */
		controls: Control[];
		/** The outer net's transitions, for the lighting. */
		transitions: Record<string, TransitionState>;
		/** Whether the rows are shown under the header. */
		open: boolean;
		/** The controls whose press is in flight. */
		pressing: ReadonlySet<string>;
		/** The line left by the last press, cleared by the next. */
		notice: PressNotice | null;
		onToggleOpen: () => void;
		onPress: (control: Control, value?: ControlValue) => void;
		/** The node the row under the pointer acts on, or null. */
		onHover: (node: string | null) => void;
	}

	let { controls, transitions, open, pressing, notice, onToggleOpen, onPress, onHover }: Props = $props();

	// A legend replaced under the pointer (a new generation) gets no
	// mouseleave: let go of the node it lit.
	onDestroy(() => onHover(null));

	// What each touched row holds, by control name: a toggle's state, a
	// slider's number, a select's option, a text box's text. A row not in
	// here holds its initial value. The page keys this component by net and
	// generation, so a new net starts from its initial values.
	let held = $state<Record<string, ControlValue>>({});

	function valueOf(control: Control): ControlValue | undefined {
		return control.name in held ? held[control.name] : initialValue(control);
	}

	function hold(control: Control, value: ControlValue) {
		held = { ...held, [control.name]: value };
	}

	function flip(control: Control) {
		const on = !toggleOn(control, transitions, valueOf(control));
		// An `enable` toggle follows the transition's switch as `toggled`
		// moves it; any other shows what it sent.
		if (!followsNet(control, transitions)) hold(control, on);
		onPress(control, on);
	}

	function slide(control: Control, raw: string, send: boolean) {
		const n = snap(Number(raw), sliderRange(control));
		hold(control, n);
		if (send) onPress(control, n);
	}

	function choose(control: Control, option: string) {
		hold(control, option);
		onPress(control, option);
	}

	function sendText(control: Control) {
		const text = valueOf(control);
		onPress(control, typeof text === 'string' ? text : '');
	}

	const rowButton = 'px-2.5 py-1 rounded border text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
	const rowButtonStyle = 'background: var(--bg-secondary); border-color: var(--button-border); color: var(--button-text)';
	const field = 'px-2 py-1 rounded border text-xs';
	const fieldStyle = 'background: var(--bg-primary); border-color: var(--border-color); color: var(--text-primary)';
</script>

<section
	class="absolute top-2.5 left-2.5 z-10 flex flex-col max-w-[22rem] max-h-[calc(100%-1.25rem)] overflow-auto rounded border shadow-sm text-xs"
	style="background: var(--bg-secondary); border-color: var(--border-color); color: var(--text-primary)"
	data-controls-legend
	aria-label="Controls"
>
	<button
		type="button"
		class="flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium cursor-pointer bg-transparent border-0"
		style="color: var(--text-primary)"
		aria-expanded={open}
		onclick={onToggleOpen}
		data-legend-header
	>
		<span class="text-[0.7rem]" style="color: var(--text-secondary)">{open ? '▼' : '▶'}</span>
		<span>Controls ({controls.length})</span>
	</button>
	{#if open}
		<ul class="flex flex-col gap-1.5 px-3 pb-2 m-0 list-none" data-legend-rows>
			{#each controls as control (control.name)}
				{@const widget = widgetOf(control)}
				{@const lit = isLit(control, transitions)}
				{@const busy = pressing.has(control.name)}
				{@const value = valueOf(control)}
				<li
					class="flex items-center gap-2 flex-wrap"
					style:opacity={lit ? null : '0.35'}
					data-control={control.name}
					data-control-kind={control.kind}
					data-lit={lit ? 'true' : 'false'}
					onmouseenter={() => onHover(control.node ?? null)}
					onmouseleave={() => onHover(null)}
				>
					{#if widget === 'button'}
						<button type="button" class={rowButton} style={rowButtonStyle} disabled={busy}
							onclick={() => onPress(control)}>{control.label}</button>
					{:else if widget === 'toggle'}
						{@const on = toggleOn(control, transitions, value)}
						<button type="button" class={rowButton} disabled={busy} aria-pressed={on}
							style={on
								? 'background: var(--button-border); border-color: var(--button-border); color: var(--button-hover-text)'
								: rowButtonStyle}
							onclick={() => flip(control)}>{on ? '☑' : '☐'} {control.label}</button>
					{:else if widget === 'slider'}
						{@const range = sliderRange(control)}
						<span>{control.label}</span>
						<input type="range" class="w-28 cursor-pointer disabled:cursor-not-allowed" aria-label={control.label}
							min={range.start} max={range.stop} step={range.step} value={value} disabled={busy}
							oninput={(event) => slide(control, event.currentTarget.value, false)}
							onchange={(event) => slide(control, event.currentTarget.value, true)} />
						<span class="font-mono tabular-nums" data-control-number>{value}</span>
					{:else if widget === 'select'}
						<span>{control.label}</span>
						<select class="{field} cursor-pointer" style={fieldStyle} aria-label={control.label}
							value={value} disabled={busy}
							onchange={(event) => choose(control, event.currentTarget.value)}>
							{#each selectOptions(control) as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					{:else if widget === 'text'}
						<span>{control.label}</span>
						<input type="text" class="{field} w-32" style={fieldStyle} aria-label={control.label}
							placeholder={control.config?.placeholder ?? ''} value={typeof value === 'string' ? value : ''}
							readonly={busy}
							oninput={(event) => hold(control, event.currentTarget.value)}
							onkeydown={(event) => {
								if (event.key === 'Enter') sendText(control);
							}} />
						<button type="button" class={rowButton} style={rowButtonStyle} disabled={busy}
							onclick={() => sendText(control)}>Send</button>
					{:else}
						<span>{control.label}</span>
					{/if}
				</li>
			{/each}
		</ul>
		{#if notice}
			<p class="px-3 pb-2 m-0 text-xs max-w-[20rem] break-words"
				style:color={notice.error ? 'var(--danger)' : 'var(--text-secondary)'}
				data-press-notice={notice.error ? 'error' : 'nothing'}>{notice.text}</p>
		{/if}
	{/if}
</section>

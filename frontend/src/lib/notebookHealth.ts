/**
 * What the badge is standing in for.
 *
 * `diagnose()` reduces the whole chain to one word and one line, which is the
 * right size for a header but the wrong size for a failure. A notebook that
 * has stopped drawing looks, to its owner, exactly like a notebook whose net
 * has died — and the first question is always "is my net still running?".
 *
 * Three facts answer that, each owned by a different actor and each able to
 * fail without the others:
 *
 *   1. the net is stepping          (the bridge's slot report)
 *   2. the notebook holds fresh data (that report's age)
 *   3. the page is receiving frames  (the worker's websocket counters)
 *
 * Collapsing them loses the thing the user most needs, which is that two of
 * the three are usually fine. So this module spreads them back out.
 *
 * Pure, and separate from the component, for the same reason `diagnose` is:
 * the interesting cases are combinations of server state, and they are worth
 * asserting as a table rather than by clicking.
 */

import type { NotebookSync } from './api';
import type { Diagnosis, NotebookState } from './notebookSync';

/** `ok: null` means "cannot tell from here" — never rendered as a failure. */
export interface HealthFact {
	label: string;
	value: string;
	ok: boolean | null;
	/** Shown under the value when there is something more to say. */
	note?: string;
}

function ageLabel(seconds: number | null): string {
	if (seconds === null) return 'never';
	if (seconds < 1) return 'just now';
	if (seconds < 60) return `${seconds.toFixed(0)}s ago`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m ${rest}s ago`;
}

function countLabel(n: number): string {
	return n.toLocaleString();
}

/**
 * Seconds without a frame before the page is treated as not drawing.
 * Matches `FRAME_STALL_S` in `notebookSync.ts`; kept as its own constant so a
 * change there shows up here as a failing test rather than as a panel that
 * quietly disagrees with the badge above it.
 */
export const FRAME_STALL_S = 30;

export function netFact(sync: NotebookSync): HealthFact {
	const slots = sync.slots ?? [];
	if (slots.length === 0) {
		return {
			label: 'Net running',
			value: 'no slots reported',
			ok: null,
			note: 'nothing is bound, or the notebook has not reported yet',
		};
	}
	const running = slots.filter((s) => s.running);
	const steps = slots
		.map((s) => s.step_count)
		.filter((n): n is number => typeof n === 'number');
	const highest = steps.length > 0 ? Math.max(...steps) : null;
	return {
		label: 'Net running',
		value: running.length > 0
			? highest === null ? 'yes' : `step ${countLabel(highest)}`
			: 'stopped',
		// A stopped net is not a fault: nets are started and stopped on purpose.
		ok: running.length > 0 ? true : null,
		note: running.length > 0 && slots.length > 1
			? `${running.length} of ${slots.length} slots running`
			: undefined,
	};
}

export function dataFact(sync: NotebookSync): HealthFact {
	const slots = sync.slots ?? [];
	const ages = slots
		.map((s) => s.last_sync_age_s)
		.filter((n): n is number => typeof n === 'number');
	if (ages.length === 0) {
		return {
			label: 'Notebook has data',
			value: 'never synced',
			ok: false,
			note: 'the notebook has not fetched its net state',
		};
	}
	const worst = Math.max(...ages);
	const errored = slots.find((s) => s.last_error);
	return {
		label: 'Notebook has data',
		value: `updated ${ageLabel(worst)}`,
		ok: !errored,
		note: errored?.last_error ?? undefined,
	};
}

export function frameFact(sync: NotebookSync): HealthFact {
	const transport = sync.transport;
	if (!transport) {
		return {
			label: 'Page updating',
			value: 'cannot tell',
			ok: null,
			note: 'this worker does not report websocket activity',
		};
	}
	if (transport.ws_sessions === 0) {
		return {
			label: 'Page updating',
			value: 'not connected',
			ok: false,
			note: transport.ws_opened_total === 0
				? 'the browser has never opened a connection'
				: 'the connection was open and has closed',
		};
	}
	const age = transport.last_frame_age_s;
	const stalled = age === null || age > FRAME_STALL_S;
	// Naming the session count is the point of this row when it fails: a
	// second session on one subprocess is the shape of the known freeze, and
	// it is the fact that decides whether reloading is worth the user's time.
	const note = transport.ws_opened_total > 1
		? `connection open · session ${countLabel(transport.ws_opened_total)} on this notebook`
		: 'connection open';
	return {
		label: 'Page updating',
		value: age === null ? 'nothing drawn yet' : `last change ${ageLabel(age)}`,
		ok: !stalled,
		note: stalled ? note : `${countLabel(transport.frames_relayed)} updates received`,
	};
}

export function healthFacts(sync: NotebookSync): HealthFact[] {
	return [netFact(sync), dataFact(sync), frameFact(sync)];
}

/**
 * The sentence that scopes the failure.
 *
 * Written to answer "is my work broken?" before "what do I do?", because that
 * is the order the questions arrive in. Says what still works by name, so the
 * user does not have to infer it from the absence of a complaint.
 */
const SUMMARIES: Record<NotebookState, string> = {
	live: 'Everything is connected and up to date.',
	syncing: 'Connected. Waiting for the first update from the net.',
	connecting: 'The page is still connecting to the notebook.',
	disconnected: 'The notebook is not reporting, so nothing can be drawn.',
	not_loaded: 'The notebook is not running. Loading it will start it.',
	no_transport:
		'The notebook and its data are fine — this page has no live connection to it. ' +
		'Reconnecting usually fixes it.',
	frames_stalled:
		'Your net and its data are fine. This page stopped receiving updates from the ' +
		'notebook. Reloading gives it a fresh session.',
	bridge_missing:
		'The page is connected, but the notebook never started tracking its nets. ' +
		'Reconnecting restarts it.',
	bridge_stalled:
		'The notebook stopped tracking its net partway through. Reloading restarts it.',
	worker_unreachable:
		'The worker running this notebook cannot be reached, so nothing can be drawn ' +
		'until it comes back.',
	stale: 'The notebook is behind its net.',
};

export function healthSummary(diagnosis: Diagnosis): string {
	return SUMMARIES[diagnosis.state] ?? diagnosis.detail;
}

const ACTION_LABELS: Record<Diagnosis['action'], string | null> = {
	none: null,
	remount: 'Reconnect',
	reload: 'Reload notebook',
};

export function actionLabel(diagnosis: Diagnosis): string | null {
	return ACTION_LABELS[diagnosis.action];
}

/**
 * The panel as text, for pasting into a bug report.
 *
 * Everything the diagnosis was derived from, not a re-rendering of the
 * conclusion: a report that carries only "not drawing" is the report that
 * cannot be acted on.
 */
export function diagnosticsText(
	sync: NotebookSync,
	diagnosis: Diagnosis,
	notebookId: string,
): string {
	const lines = [
		`notebook ${notebookId}`,
		`state    ${diagnosis.state} (${diagnosis.label})`,
		`detail   ${diagnosis.detail}`,
		'',
		...healthFacts(sync).map(
			(f) => `${f.ok === true ? 'ok  ' : f.ok === false ? 'BAD ' : '?   '}${f.label}: ${f.value}` +
				(f.note ? ` — ${f.note}` : ''),
		),
		'',
		`transport ${JSON.stringify(sync.transport ?? null)}`,
		`slots     ${JSON.stringify(sync.slots ?? [])}`,
		`captured  ${new Date().toISOString()}`,
	];
	return lines.join('\n');
}

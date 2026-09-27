/**
 * Colours for the Diagnose verdict on a net.
 *
 * The state set is closed on the server but may grow, so the map is keyed by
 * string and anything it does not know is grey rather than guessed.
 */

export type DiagnoseTone = 'good' | 'neutral' | 'active' | 'attention' | 'bad' | 'unknown';

const TONE_BY_STATE: Record<string, DiagnoseTone> = {
	healthy: 'good',
	finished: 'good',
	idle: 'neutral',
	stopped: 'neutral',
	scheduled: 'neutral',
	loading: 'active',
	dispatching: 'active',
	running: 'active',
	overdue: 'attention',
	unloaded: 'attention',
	no_worker: 'attention',
	worker_not_ready: 'attention',
	subprocess_gone: 'attention',
	not_running: 'attention',
	stalled: 'bad',
	crashed: 'bad',
	load_failed: 'bad',
	worker_unreachable: 'bad',
	schedule_invalid: 'bad',
};

/** The theme classes each tone is drawn with: success, muted, info, warning,
 *  error, and the faint grey the pages use for things with nothing to say. */
const TONE_CLASSES: Record<DiagnoseTone, string> = {
	good: 'bg-success-bg text-success',
	neutral: 'bg-muted text-foreground-muted',
	active: 'bg-status-info-bg text-status-info',
	attention: 'bg-status-warning-bg text-status-warning',
	bad: 'bg-error-bg text-error',
	unknown: 'bg-border text-foreground-faint',
};

export function diagnoseTone(state: string): DiagnoseTone {
	return TONE_BY_STATE[state] ?? 'unknown';
}

export function diagnoseClasses(state: string): string {
	return TONE_CLASSES[diagnoseTone(state)];
}

/** A state tag as words: `worker_not_ready` reads "worker not ready". */
export function diagnoseStateLabel(state: string): string {
	return state.replaceAll('_', ' ');
}

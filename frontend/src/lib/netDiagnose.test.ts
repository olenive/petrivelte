import { describe, expect, it } from 'vitest';
import { diagnoseClasses, diagnoseStateLabel, diagnoseTone } from './netDiagnose';

describe('diagnoseTone', () => {
	const cases: Record<string, string[]> = {
		good: ['healthy', 'finished'],
		neutral: ['idle', 'stopped', 'scheduled'],
		active: ['loading', 'dispatching', 'running'],
		attention: ['overdue', 'unloaded', 'no_worker', 'worker_not_ready', 'subprocess_gone', 'not_running'],
		bad: ['stalled', 'crashed', 'load_failed', 'worker_unreachable', 'schedule_invalid'],
	};
	for (const [tone, states] of Object.entries(cases)) {
		it(`is ${tone} for ${states.join(', ')}`, () => {
			for (const state of states) expect(diagnoseTone(state)).toBe(tone);
		});
	}

	it('is unknown for a state this build has not heard of', () => {
		expect(diagnoseTone('levitating')).toBe('unknown');
	});
});

describe('diagnoseClasses', () => {
	it('uses the theme success, info, warning and error classes', () => {
		expect(diagnoseClasses('healthy')).toBe('bg-success-bg text-success');
		expect(diagnoseClasses('running')).toBe('bg-status-info-bg text-status-info');
		expect(diagnoseClasses('overdue')).toBe('bg-status-warning-bg text-status-warning');
		expect(diagnoseClasses('crashed')).toBe('bg-error-bg text-error');
		expect(diagnoseClasses('idle')).toBe('bg-muted text-foreground-muted');
		expect(diagnoseClasses('levitating')).toBe('bg-border text-foreground-faint');
	});
});

describe('diagnoseStateLabel', () => {
	it('turns underscores into spaces', () => {
		expect(diagnoseStateLabel('worker_not_ready')).toBe('worker not ready');
		expect(diagnoseStateLabel('healthy')).toBe('healthy');
	});
});

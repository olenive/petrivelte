import { describe, expect, it } from 'vitest';
import { diagnoseActivityLine, diagnoseClasses, diagnoseStateLabel, diagnoseTone } from './netDiagnose';

describe('diagnoseTone', () => {
	const cases: Record<string, string[]> = {
		good: ['healthy', 'finished'],
		neutral: ['idle', 'stopped', 'scheduled', 'waiting'],
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
		expect(diagnoseClasses('waiting')).toBe(diagnoseClasses('scheduled'));
		expect(diagnoseClasses('levitating')).toBe('bg-border text-foreground-faint');
	});
});

describe('diagnoseStateLabel', () => {
	it('turns underscores into spaces', () => {
		expect(diagnoseStateLabel('worker_not_ready')).toBe('worker not ready');
		expect(diagnoseStateLabel('healthy')).toBe('healthy');
	});
});

describe('diagnoseActivityLine', () => {
	it('names the transition and its age while one is executing', () => {
		expect(
			diagnoseActivityLine({
				worker_probe: { executing_since: '2026-09-28T10:00:00Z', executing_transition: 'fetch', idle_since: null },
				executing_age_seconds: 250,
			}),
		).toBe('Executing fetch for 4m 10s');
	});

	it('says "a transition" when the worker gives no name', () => {
		expect(
			diagnoseActivityLine({
				worker_probe: { executing_since: '2026-09-28T10:00:00Z', executing_transition: null },
				executing_age_seconds: 42,
			}),
		).toBe('Executing a transition for 42s');
	});

	it('says how long nothing has been enabled while the net waits', () => {
		expect(
			diagnoseActivityLine({
				worker_probe: { executing_since: null, idle_since: '2026-09-28T08:00:00Z' },
				idle_age_seconds: 7500,
			}),
		).toBe('Nothing enabled for 2h 05m');
	});

	it('leaves the age out when the server sends none', () => {
		expect(diagnoseActivityLine({ worker_probe: { idle_since: '2026-09-28T08:00:00Z' } })).toBe('Nothing enabled');
	});

	it('is null when the worker reported neither, or from an older server', () => {
		expect(diagnoseActivityLine({ worker_probe: { executing_since: null, idle_since: null } })).toBeNull();
		expect(diagnoseActivityLine({ worker_probe: { pid: 12 } })).toBeNull();
		expect(diagnoseActivityLine({ worker_probe: null })).toBeNull();
		expect(diagnoseActivityLine({})).toBeNull();
		expect(diagnoseActivityLine(null)).toBeNull();
	});
});

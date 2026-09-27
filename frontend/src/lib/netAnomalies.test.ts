import { describe, expect, it } from 'vitest';
import { anomalyLabel, anomalyLabels, anomalySuffix } from './netAnomalies';

describe('anomalyLabel', () => {
	it('says each known tag in plain English', () => {
		expect(anomalyLabel('wants_running_without_worker')).toBe('wants running, no worker');
		expect(anomalyLabel('wants_running_but_unloaded')).toBe('wants running, not loaded');
		expect(anomalyLabel('wants_running_but_load_failed')).toBe('wants running, load failed');
		expect(anomalyLabel('duplicate_definition_on_deployment')).toBe(
			'another instance of this definition on the same deployment',
		);
	});

	it('shows an unknown tag as the tag itself', () => {
		expect(anomalyLabel('wants_something_new')).toBe('wants_something_new');
	});
});

describe('anomalyLabels and anomalySuffix', () => {
	it('say nothing for a net with no anomalies, or a server that sends none', () => {
		expect(anomalyLabels({ anomalies: [] })).toEqual([]);
		expect(anomalyLabels({})).toEqual([]);
		expect(anomalySuffix({ anomalies: [] })).toBe('');
		expect(anomalySuffix({})).toBe('');
	});

	it('keep the server order and join into one suffix', () => {
		const net = { anomalies: ['wants_running_but_unloaded', 'mystery'] };
		expect(anomalyLabels(net)).toEqual(['wants running, not loaded', 'mystery']);
		expect(anomalySuffix(net)).toBe(' · wants running, not loaded; mystery');
	});
});

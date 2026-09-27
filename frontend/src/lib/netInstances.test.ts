import { describe, expect, it } from 'vitest';
import { groupByDefinition, workerLabel } from './netInstances';

const WORKERS = [{ id: 'w-aaaaaaaa-1111', name: 'tailarm' }];

const net = (
	id: string,
	definition_name: string,
	instance_name: string,
	worker_id: string | null,
	load_state: 'unloaded' | 'loaded' | 'loading' | 'error' = 'loaded',
) => ({ id, definition_name, instance_name, worker_id, load_state });

describe('workerLabel', () => {
	it('names the worker when the list has it', () => {
		expect(workerLabel('w-aaaaaaaa-1111', WORKERS)).toBe('tailarm');
	});

	it('falls back to the id prefix when the list does not', () => {
		expect(workerLabel('0123456789abcdef', [])).toBe('01234567');
	});

	it('says no worker for an unassigned net', () => {
		expect(workerLabel(null, WORKERS)).toBe('no worker');
	});
});

describe('groupByDefinition', () => {
	it('groups instances under their definition, both sorted by name', () => {
		const groups = groupByDefinition([
			net('n3', 'monitor', 'monitor-b', 'w-zzzzzzzz-9999', 'error'),
			net('n1', 'anomalies', 'anomalies', 'w-aaaaaaaa-1111'),
			net('n2', 'monitor', 'monitor-a', 'w-aaaaaaaa-1111', 'unloaded'),
		], WORKERS);

		expect(groups.map((g) => g.definition_name)).toEqual(['anomalies', 'monitor']);
		expect(groups[1].instances).toEqual([
			{ id: 'n2', instance_name: 'monitor-a', worker: 'tailarm', load_state: 'unloaded' },
			{ id: 'n3', instance_name: 'monitor-b', worker: 'w-zzzzzz', load_state: 'error' },
		]);
		expect(groups[0].instances).toHaveLength(1);
	});

	it('is empty for no nets', () => {
		expect(groupByDefinition([], WORKERS)).toEqual([]);
	});
});

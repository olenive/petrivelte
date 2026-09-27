/**
 * Which workers a net definition is running on.
 *
 * One definition can have several instances, on one worker or on several,
 * and the net selector lists instances by name only. Grouping the list by
 * `definition_name` answers "where is this definition running" in one place.
 */

import type { Net, Worker } from '$lib/api';

export interface DefinitionInstance {
	id: string;
	instance_name: string;
	/** The worker's name when the workers list has it, else the first eight
	 *  characters of its id, else "no worker". */
	worker: string;
	load_state: Net['load_state'];
}

export interface DefinitionGroup {
	definition_name: string;
	instances: DefinitionInstance[];
}

const WORKER_ID_PREFIX = 8;

export function workerLabel(
	workerId: string | null,
	workers: readonly Pick<Worker, 'id' | 'name'>[],
): string {
	if (!workerId) return 'no worker';
	return workers.find((w) => w.id === workerId)?.name ?? workerId.slice(0, WORKER_ID_PREFIX);
}

/** Nets grouped by definition, definitions and instances sorted by name. */
export function groupByDefinition(
	nets: readonly Pick<Net, 'id' | 'definition_name' | 'instance_name' | 'worker_id' | 'load_state'>[],
	workers: readonly Pick<Worker, 'id' | 'name'>[],
): DefinitionGroup[] {
	const groups = new Map<string, DefinitionInstance[]>();
	for (const net of nets) {
		const instances = groups.get(net.definition_name) ?? [];
		instances.push({
			id: net.id,
			instance_name: net.instance_name,
			worker: workerLabel(net.worker_id, workers),
			load_state: net.load_state,
		});
		groups.set(net.definition_name, instances);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([definition_name, instances]) => ({
			definition_name,
			instances: instances.sort((a, b) => a.instance_name.localeCompare(b.instance_name)),
		}));
}

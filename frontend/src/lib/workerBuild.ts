/**
 * Which build each worker runs, in words.
 *
 * The control plane and every worker record the git commit they were built
 * from, and a content hash of the worker image's inputs. The control plane
 * decides whether they match (hashes when both sides have one, else commits).
 * A worker that does not match is owed a roll, and the marker says so with
 * the exact command. A worker built from an older commit that still matches
 * runs the same worker image contents, and its tooltip says no roll is owed. Every field may be absent
 * (an older control plane or worker), and absent reads as unknown.
 *
 * Pure, like the other `lib` helpers the pages render: the cases are a table.
 */

import type { ControlPlaneBuild } from '$lib/api';
import { formatDeploymentTime } from '$lib/provenance';

/** The worker fields this module reads. */
export interface WorkerBuildSource {
	fly_machine_id: string | null;
	build_commit?: string | null;
	build_seen_at?: string | null;
	build_worker_hash?: string | null;
	build_matches_control_plane?: boolean | null;
}

export type BuildTone = 'muted' | 'warn';

export interface BuildText {
	label: string;
	tooltip: string;
	tone: BuildTone;
}

export interface WorkerBuildView {
	/** Always present: the short commit, or "build unknown". */
	chip: BuildText;
	/** Present only when the worker runs a different build. */
	marker: BuildText | null;
}

/** The first seven characters of a commit, or null when there is none. */
export function shortCommit(commit: string | null | undefined): string | null {
	const trimmed = commit?.trim();
	return trimmed ? trimmed.slice(0, 7) : null;
}

/** The control plane's short commit: its own short form, else the first seven. */
export function controlPlaneShort(cp: ControlPlaneBuild | null | undefined): string | null {
	return shortCommit(cp?.short) ?? shortCommit(cp?.commit);
}

/** The command that rolls a Fly worker onto the control plane's build. */
export function rollCommand(flyMachineId: string, cpShort: string): string {
	return `fly machine update ${flyMachineId} -a petri-workers --image registry.fly.io/petri-workers:${cpShort}`;
}

function rollMarker(worker: WorkerBuildSource, cpShort: string | null): BuildText {
	const lead = cpShort
		? `This worker runs a different build from the control plane (${cpShort}).`
		: 'This worker runs a different build from the control plane.';
	const command =
		cpShort && worker.fly_machine_id ? rollCommand(worker.fly_machine_id, cpShort) : null;
	return {
		label: 'roll owed',
		tooltip: command ? `${lead} Roll it in place:\n${command}` : lead,
		tone: 'warn',
	};
}

export function buildChip(
	worker: WorkerBuildSource,
	controlPlane: ControlPlaneBuild | null | undefined,
): WorkerBuildView {
	const short = shortCommit(worker.build_commit);
	if (!short) {
		return {
			chip: {
				label: 'build unknown',
				tooltip:
					'This worker has not reported its build; it predates build identity or has not been polled yet.',
				tone: 'muted',
			},
			marker: null,
		};
	}
	const seen = formatDeploymentTime(worker.build_seen_at) ?? worker.build_seen_at;
	const hash = worker.build_worker_hash?.trim();
	const cpShort = controlPlaneShort(controlPlane);
	const lines = [`Build ${worker.build_commit?.trim()}`];
	if (seen) lines.push(`first seen ${seen}`);
	if (hash) lines.push(`worker image hash ${hash}`);
	if (worker.build_matches_control_plane === true && cpShort && cpShort !== short) {
		lines.push(
			`Built from an older commit than the control plane (${cpShort}), but its worker image contents are the same as the control plane's worker build, so no roll is owed.`,
		);
	}
	const tooltip = lines.join('\n');
	const marker =
		worker.build_matches_control_plane === false
			? rollMarker(worker, cpShort)
			: null;
	return { chip: { label: short, tooltip, tone: 'muted' }, marker };
}

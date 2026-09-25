/**
 * Which code an instance runs, in words.
 *
 * Two instances of the same definition from different pushes look identical
 * by name, so every net and notebook row carries a small chip naming its
 * deployment (short commit and date) and, when the control plane knows of a
 * newer successful deployment containing the same definition, a marker naming
 * that commit. Notebooks can then be upgraded in place; nets get new code
 * through a new instance.
 *
 * Pure, like the other `lib` helpers the pages render: the cases are a table
 * and are asserted without a browser. Dates are shown in UTC so every viewer,
 * and every test, reads the same text.
 */

import type { DeploymentSummary, Provenance } from '$lib/api';

export interface ProvenanceText {
	/** What the row shows. */
	text: string;
	/** The tooltip: everything the text was cut from. */
	title: string;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function parsed(iso: string | null | undefined): Date | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? null : new Date(t);
}

/** `2026-09-25`, in UTC, or null when the instant does not parse. */
export function formatDeploymentDate(iso: string | null | undefined): string | null {
	const d = parsed(iso);
	if (!d) return null;
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `2026-09-25 10:04 UTC`, or null when the instant does not parse. */
export function formatDeploymentTime(iso: string | null | undefined): string | null {
	const d = parsed(iso);
	if (!d) return null;
	return `${formatDeploymentDate(iso)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * The short name of a deployment's code: the server's seven-character commit,
 * or the first seven of the full one, or the ref for a build that recorded no
 * commit at all (a ref is still a name the user pushed).
 */
export function shortCommit(dep: DeploymentSummary): string {
	const short = dep.git_commit_short?.trim();
	if (short) return short;
	const full = dep.git_commit?.trim();
	if (full) return full.slice(0, 7);
	return dep.git_ref;
}

function describe(dep: DeploymentSummary, lead: string): string {
	const lines = [lead, `ref: ${dep.git_ref}`];
	lines.push(`commit: ${dep.git_commit?.trim() || 'not recorded'}`);
	const built = formatDeploymentTime(dep.created_at);
	if (built) lines.push(`built: ${built}`);
	lines.push(`build status: ${dep.build_status}`, `deployment: ${dep.id}`);
	return lines.join('\n');
}

/**
 * The chip for an instance's own deployment.
 *
 * `undefined` (a control plane that does not report provenance) gives null
 * and the row shows nothing. `null` is the server saying the deployment row
 * is gone, which is worth a chip of its own: the instance can no longer be
 * reloaded from code nobody can find.
 */
export function provenanceChip(dep: DeploymentSummary | null | undefined): ProvenanceText | null {
	if (dep === undefined) return null;
	if (dep === null) {
		return {
			text: 'deployment gone',
			title: 'The deployment this instance was created from no longer exists.',
		};
	}
	const date = formatDeploymentDate(dep.created_at);
	return {
		text: date ? `${shortCommit(dep)} · ${date}` : shortCommit(dep),
		title: describe(dep, 'Runs code from this deployment.'),
	};
}

/**
 * The "newer code available" marker, naming the newer commit, or null when
 * the instance is on the newest deployment that contains its definition.
 */
export function newerMarker(newer: DeploymentSummary | null | undefined): ProvenanceText | null {
	if (!newer) return null;
	return {
		text: `newer code: ${shortCommit(newer)}`,
		title: describe(
			newer,
			'A newer successful deployment of the same repo contains this definition.',
		),
	};
}

// -- the notebook Upgrade action -------------------------------------------

export interface UpgradeAction {
	enabled: boolean;
	/** The button's tooltip: what it will do, or why it cannot. */
	reason: string;
}

/** The fields of a notebook the Upgrade action reads. */
export type UpgradeSource = Provenance & {
	worker_id: string | null;
	load_state: string;
};

/**
 * Whether a notebook's Upgrade button is live, and what its tooltip says.
 *
 * An unassigned notebook is refused before anything else: the upgrade ends
 * in a load, and a load needs a worker, so offering it would promise
 * something the server will answer with a 409.
 */
export function upgradeAction(nb: UpgradeSource): UpgradeAction {
	if (!nb.worker_id) {
		return {
			enabled: false,
			reason: 'Not assigned to a worker. Assign one first: an upgrade loads the notebook on its worker.',
		};
	}
	if (!nb.newer_deployment) {
		return {
			enabled: false,
			reason: 'Already on the newest deployment that contains this notebook.',
		};
	}
	if (nb.load_state === 'loading') {
		return { enabled: false, reason: 'A load is already in flight.' };
	}
	return {
		enabled: true,
		reason:
			`Unload, move to ${shortCommit(nb.newer_deployment)} and load again. ` +
			'Bindings and the idle timeout are kept.',
	};
}

/**
 * The same facts as one plain-text tail, for a place that cannot hold a
 * chip, such as an `<option>` in the net picker: ` · abc1234 · 2026-09-25`,
 * plus ` · newer code: def5678` when there is newer code. Empty when the
 * control plane does not report provenance.
 */
export function provenanceSuffix(p: Provenance): string {
	const parts = [provenanceChip(p.deployment)?.text, newerMarker(p.newer_deployment)?.text];
	return parts
		.filter((x): x is string => !!x)
		.map((x) => ` · ${x}`)
		.join('');
}

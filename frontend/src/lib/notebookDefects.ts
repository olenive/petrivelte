/**
 * Notebook defects found at build time, and how to talk about them.
 *
 * Marimo requires each name to be defined by at most one cell, forbids
 * dependency cycles, and must be able to parse every cell. It enforces this
 * *per cell, at runtime*: an offending cell never executes, while the notebook
 * still loads, still serves and still opens a websocket. Every cell downstream
 * then fails on the names it was supposed to define, so the user sees a pile of
 * `NameError` at lines that are perfectly correct — and marimo redacts the real
 * cause to "an internal error occurred".
 *
 * The control plane now records these when the code is built, which is early
 * enough to say something before anyone spends four minutes provisioning a
 * worker to find out.
 *
 * Pure, like `notebookOccupancy.ts`: three-state logic (sound / defective /
 * never checked) is exactly the kind of thing worth testing without a browser.
 */

import type { Deployment, DiscoveredNotebook, NotebookDefect } from '$lib/api';

/**
 * Whether a notebook was checked, and what was found.
 *
 * `unchecked` is deliberately distinct from `sound`. A deployment built before
 * the check existed carries no verdict, and presenting the absence of a warning
 * as a clean bill of health is the exact failure this whole feature exists to
 * remove.
 */
export type DefectVerdict =
	| { state: 'sound'; defects: [] }
	| { state: 'defective'; defects: NotebookDefect[] }
	| { state: 'unchecked'; defects: [] };

export function verdictFor(notebook: DiscoveredNotebook | null | undefined): DefectVerdict {
	if (!notebook || notebook.defects === undefined) return { state: 'unchecked', defects: [] };
	if (notebook.defects.length === 0) return { state: 'sound', defects: [] };
	return { state: 'defective', defects: notebook.defects };
}

/** Find a notebook definition inside the deployment it was built from. */
export function findDefinition(
	deployments: Deployment[],
	deploymentId: string | null | undefined,
	definitionName: string | null | undefined,
): DiscoveredNotebook | null {
	if (!deploymentId || !definitionName) return null;
	const deployment = deployments.find((d) => d.id === deploymentId);
	return (
		deployment?.discovered_notebooks?.find((nb) => nb.name === definitionName) ?? null
	);
}

/** The verdict for a notebook *instance*, via the deployment it came from. */
export function verdictForInstance(
	deployments: Deployment[],
	deploymentId: string | null | undefined,
	definitionName: string | null | undefined,
): DefectVerdict {
	return verdictFor(findDefinition(deployments, deploymentId, definitionName));
}

/**
 * Where in the file to look.
 *
 * One line per offending cell, so the plural matters: a report naming a single
 * site sends the reader off to hunt for the rest, which is how the original
 * error behaved and why it took so long to read.
 */
export function describeLines(defect: NotebookDefect): string {
	const lines = defect.lines ?? [];
	if (lines.length === 0) return '';
	if (lines.length === 1) return `line ${lines[0]}`;
	return `lines ${lines.join(', ')}`;
}

/** One-line summary of a defect, location included. */
export function describeDefect(defect: NotebookDefect): string {
	const where = describeLines(defect);
	return where ? `${defect.message} (${where})` : defect.message;
}

/**
 * Headline for a set of defects.
 *
 * Says what will happen, not what was found. "Variable defined in multiple
 * cells" is only alarming to someone who already knows marimo's rule; "cells
 * will not run" is the consequence they care about.
 */
export function defectSummary(defects: NotebookDefect[]): string {
	if (defects.length === 0) return '';
	const problem = defects.length === 1 ? 'A problem' : `${defects.length} problems`;
	return `${problem} in this notebook will stop some of its cells running.`;
}

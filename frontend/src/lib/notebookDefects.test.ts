/**
 * The point of this warning is that the runtime error is unreadable.
 *
 * A notebook that redefines a name in two cells loads, serves and looks
 * healthy, while every cell downstream of the offending one raises
 * `NameError: name 'x' is not defined` at a line that is entirely correct —
 * and marimo redacts the real cause to "an internal error occurred". Once that
 * shipped, the diagnosis took reading the whole process tree on the worker.
 *
 * So the cases that matter here are the ones where the warning would mislead:
 * an old deployment with no verdict at all, and a lookup that misses.
 */

import { describe, expect, it } from 'vitest';
import type { Deployment, DiscoveredNotebook, NotebookDefect } from '$lib/api';
import {
	defectSummary,
	describeDefect,
	describeLines,
	findDefinition,
	verdictFor,
	verdictForInstance,
} from './notebookDefects';

const DUPLICATE: NotebookDefect = {
	code: 'MB002',
	name: 'multiple-definitions',
	message: "Variable 'petri' is defined in multiple cells",
	lines: [103, 155, 196],
	fix: 'Variables must be unique across cells.',
};

function notebook(name: string, defects?: NotebookDefect[]): DiscoveredNotebook {
	const nb: DiscoveredNotebook = { name, path_in_tarball: `notebooks/${name}.py`, slots: [] };
	if (defects !== undefined) nb.defects = defects;
	return nb;
}

function deployment(id: string, notebooks: DiscoveredNotebook[] | null): Deployment {
	return {
		id,
		git_url: 'https://example.invalid/repo',
		git_ref: 'main',
		git_commit: null,
		image_tag: null,
		build_status: 'success',
		build_error: null,
		discovered_nets: null,
		discovered_notebooks: notebooks,
		created_at: '2026-08-07T00:00:00Z',
		build_started_at: null,
		build_finished_at: null,
	};
}

describe('verdictFor', () => {
	it('reports a checked, clean notebook as sound', () => {
		expect(verdictFor(notebook('fine', []))).toEqual({ state: 'sound', defects: [] });
	});

	it('reports defects when there are any', () => {
		const verdict = verdictFor(notebook('broken', [DUPLICATE]));
		expect(verdict.state).toBe('defective');
		expect(verdict.defects).toEqual([DUPLICATE]);
	});

	it('never claims a notebook is sound when it was never checked', () => {
		// A deployment built before the check existed. Silence here would be
		// read as a clean bill of health, which is the failure this exists to
		// remove.
		expect(verdictFor(notebook('old')).state).toBe('unchecked');
	});

	it('treats a missing notebook as unchecked rather than sound', () => {
		expect(verdictFor(null).state).toBe('unchecked');
		expect(verdictFor(undefined).state).toBe('unchecked');
	});
});

describe('findDefinition', () => {
	const deployments = [
		deployment('dep-1', [notebook('alpha', []), notebook('beta', [DUPLICATE])]),
		deployment('dep-2', null),
	];

	it('finds a notebook in its own deployment', () => {
		expect(findDefinition(deployments, 'dep-1', 'beta')?.defects).toEqual([DUPLICATE]);
	});

	it('does not find a notebook in a different deployment', () => {
		// Two deployments can define the same notebook name at different
		// commits; answering from the wrong one would warn about code the user
		// is not running.
		expect(findDefinition(deployments, 'dep-2', 'beta')).toBeNull();
	});

	it('returns null rather than throwing on missing ids', () => {
		expect(findDefinition(deployments, null, 'beta')).toBeNull();
		expect(findDefinition(deployments, 'dep-1', null)).toBeNull();
		expect(findDefinition(deployments, 'nope', 'beta')).toBeNull();
		expect(findDefinition([], 'dep-1', 'beta')).toBeNull();
	});

	it('handles a deployment with no notebooks at all', () => {
		expect(findDefinition(deployments, 'dep-2', 'anything')).toBeNull();
	});
});

describe('verdictForInstance', () => {
	const deployments = [deployment('dep-1', [notebook('beta', [DUPLICATE])])];

	it('reaches the definition through the instance', () => {
		expect(verdictForInstance(deployments, 'dep-1', 'beta').state).toBe('defective');
	});

	it('is unchecked when the deployment cannot be found', () => {
		// Deployments load asynchronously; before they arrive there is no
		// verdict, and "no warning yet" must not render as "no problem".
		expect(verdictForInstance([], 'dep-1', 'beta').state).toBe('unchecked');
	});
});

describe('describeLines', () => {
	it('names every offending cell, not just the first', () => {
		expect(describeLines(DUPLICATE)).toBe('lines 103, 155, 196');
	});

	it('uses the singular for one line', () => {
		expect(describeLines({ ...DUPLICATE, lines: [12] })).toBe('line 12');
	});

	it('says nothing rather than "lines " when there are none', () => {
		expect(describeLines({ ...DUPLICATE, lines: [] })).toBe('');
	});
});

describe('describeDefect', () => {
	it('puts the message with its location', () => {
		expect(describeDefect(DUPLICATE)).toBe(
			"Variable 'petri' is defined in multiple cells (lines 103, 155, 196)",
		);
	});

	it('omits an empty location instead of leaving empty brackets', () => {
		expect(describeDefect({ ...DUPLICATE, lines: [] })).toBe(
			"Variable 'petri' is defined in multiple cells",
		);
	});
});

describe('defectSummary', () => {
	it('leads with the consequence, not the rule', () => {
		// "defined in multiple cells" only alarms someone who knows marimo's
		// rule already; "will stop some of its cells running" is the part the
		// reader needs.
		expect(defectSummary([DUPLICATE])).toContain('stop some of its cells running');
	});

	it('counts them when there is more than one', () => {
		expect(defectSummary([DUPLICATE, DUPLICATE])).toContain('2 problems');
	});

	it('is empty when there is nothing to say', () => {
		expect(defectSummary([])).toBe('');
	});
});

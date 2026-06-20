/**
 * Compile-time contract checks for the API client.
 *
 * No runtime code — these declarations only need to type-check. If the
 * server contract drifts (e.g. ``discovered_notebooks`` is removed from
 * ``Deployment``), this file fails ``svelte-check`` and CI catches it
 * before the bug reaches the Add-Notebook modal again.
 *
 * Add an entry here whenever a route's response shape carries a field
 * the UI reads directly. The cost is one literal per field; the benefit
 * is type-check coverage on the parts that matter.
 */
import type { Deployment, DiscoveredNotebook, NotebookSlot } from './api';

// -- Regression lock: Deployment must expose discovered_notebooks --
//
// Was broken once: the backend wrote the column, the frontend modal
// read ``dep.discovered_notebooks`` via an untyped ``as`` cast, and the
// field was silently undefined. Both the type and a usable shape are
// required.
const _deployment_has_notebooks: Deployment = {
	id: '11111111-1111-1111-1111-111111111111',
	git_url: 'https://github.com/example/repo',
	git_ref: 'main',
	git_commit: 'abc123',
	image_tag: null,
	build_status: 'success',
	build_error: null,
	discovered_nets: null,
	discovered_notebooks: [
		{
			name: 'visualise_daily_pipeline',
			path_in_tarball: 'petri/notebooks/visualise_daily_pipeline.py',
			slots: [
				{ slot_name: 'daily_pipeline', places: ['Result'], transitions: [] },
			],
		},
	],
	created_at: '2026-05-14T00:00:00Z',
	build_started_at: '2026-05-14T00:00:00Z',
	build_finished_at: '2026-05-14T00:00:01Z',
};

// -- DiscoveredNotebook contract --
//
// The Add-Notebook modal renders ``name`` in the dropdown and uses
// ``slots`` to show the count of bindable slots. Both must remain.
const _notebook_shape: DiscoveredNotebook = {
	name: 'x',
	path_in_tarball: 'x.py',
	slots: [],
};

// -- NotebookSlot contract --
//
// SDK discovery extracts these via AST; the wiring page surfaces them
// as bindable slots. ``slot_name`` is what the user sees and binds.
const _slot_shape: NotebookSlot = {
	slot_name: 's',
	places: [],
	transitions: [],
};

// Suppress unused-locals warnings while keeping the type-checks.
export const __api_contract_check = [
	_deployment_has_notebooks,
	_notebook_shape,
	_slot_shape,
];

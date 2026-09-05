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
import type {
	DailyRollup, Deployment, DiscoveredNotebook, LastRun, NotebookDefect, NotebookSlot,
	RunPage, RunRecord,
} from './api';

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

// -- NotebookDefect contract --
//
// The build records what marimo will refuse to run, and the wiring view warns
// on it. Every field is read: ``message`` and ``lines`` are the warning,
// ``fix`` is marimo's own remedy, ``name``/``code`` identify the rule.
//
// ``defects`` stays optional on DiscoveredNotebook, because a deployment built
// before the check existed genuinely has no verdict — and "not checked" must
// not render as "checked and sound".
const _defect_shape: NotebookDefect = {
	code: 'MB002',
	name: 'multiple-definitions',
	message: "Variable 'petri' is defined in multiple cells",
	lines: [103, 155],
	fix: 'Variables must be unique across cells.',
};

const _notebook_with_defects: DiscoveredNotebook = {
	name: 'x',
	path_in_tarball: 'x.py',
	slots: [],
	defects: [_defect_shape],
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

// -- Run history contract --
//
// The Runs panel reads every field below. Two of them are load-bearing and
// easy to lose in a refactor:
//
// ``RunPage.next_before`` is the paging cursor — without it the panel cannot
// tell "that was the last page" from "the page happened to be short", and the
// load-more button either stops early or never stops.
//
// ``LastRun.trigger`` and ``ended_at`` are nullable *by design*: retention
// deletes the run row while the outcome survives on the net's state row. A
// type that made them required would push the badge into rendering nothing
// for exactly the old runs it exists to summarise.
const _run_shape: RunRecord = {
	id: '22222222-2222-2222-2222-222222222222',
	net_id: '33333333-3333-3333-3333-333333333333',
	trigger: 'schedule',
	scheduled_for: '2026-09-05T02:00:00Z',
	state: 'succeeded',
	reason: 'no_enabled_transitions',
	error: null,
	step_count: 41,
	created_at: '2026-09-05T02:00:01Z',
	started_at: '2026-09-05T02:00:02Z',
	ended_at: '2026-09-05T02:31:00Z',
	duration_s: 1858.0,
};

const _run_page_shape: RunPage = {
	runs: [_run_shape],
	next_before: '2026-09-05T02:00:01Z',
};

const _exhausted_run_page: RunPage = { runs: [], next_before: null };

const _last_run_shape: LastRun = {
	id: '22222222-2222-2222-2222-222222222222',
	trigger: null,
	state: 'failed',
	reason: 'transition_raised',
	ended_at: null,
};

// Days with no runs have no row at all, so the chart plots against ``day``
// rather than against position. Keeping ``day`` in the contract keeps that
// possible.
const _daily_shape: DailyRollup = {
	net_id: '33333333-3333-3333-3333-333333333333',
	day: '2026-09-05',
	runs: 2,
	succeeded: 1,
	failed: 1,
	stopped: 0,
	skipped: 0,
	steps_total: 84,
	duration_total_s: 2000.5,
	duration_max_s: 1858.0,
};

// Suppress unused-locals warnings while keeping the type-checks.
export const __api_contract_check = [
	_deployment_has_notebooks,
	_notebook_shape,
	_slot_shape,
];

export const __runs_contract_check = [
	_run_shape,
	_run_page_shape,
	_exhausted_run_page,
	_last_run_shape,
	_daily_shape,
];

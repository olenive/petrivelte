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
	DailyRollup, Deployment, DeploymentSummary, DiscoveredNotebook, LastRun, Net, Notebook,
	NotebookDefect, NotebookSlot, OpenRun, WorkerDeleteResult, Operation, OperationSummary, RunPage, RunRecord,
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
	started_at: null,
	ended_at: null,
	duration_s: null,
};

// -- Liveness contract --
//
// ``open_run`` is the only thing that says a net is executing. The UI used to
// infer it from ``load_state`` + ``desired_state``, which is wrong for a
// drained one-shot net — loaded, desired-running, doing nothing, all day. If
// this field goes away the inference comes back, so lock it here.
//
// ``started_at`` is null while the run is ``claimed`` or ``dispatched``: armed
// is not the same as running, and the type has to allow saying so.
//
// ``created_at`` is required and ``started_at`` is not, which is the pair that
// lets an armed run say how long it has been waiting: the wait is measured
// from when the row was written, because a claim that is not moving has no
// start to measure from. ``scheduled_for`` is the slot, rendered in UTC.
const _open_run_shape: OpenRun = {
	id: '44444444-4444-4444-4444-444444444444',
	trigger: 'schedule',
	state: 'claimed',
	created_at: '2026-09-05T02:00:00Z',
	started_at: null,
	scheduled_for: '2026-09-05T02:00:00Z',
};

const _running_open_run: OpenRun = {
	id: '44444444-4444-4444-4444-444444444444',
	trigger: 'manual',
	state: 'running',
	created_at: '2026-09-05T02:00:01Z',
	started_at: '2026-09-05T02:00:02Z',
	scheduled_for: null,
};

// Every run field the nets list reads off a net row, in one place.
const _net_run_fields: Pick<
	Net,
	'last_run' | 'open_run' | 'pending_reason' | 'pending_since' | 'step_count'
	| 'last_progress_at' | 'last_success_at'
> = {
	last_run: _last_run_shape,
	open_run: _running_open_run,
	pending_reason: 'worker_not_ready',
	pending_since: '2026-09-05T02:00:00Z',
	step_count: 4213,
	last_progress_at: '2026-09-05T02:29:59Z',
	last_success_at: '2026-09-04T02:31:00Z',
};

// -- Schedule contract --
//
// What a cron net's page needs to say anything true about its schedule: the
// expression as the code declares it, the intent (Stop pauses the schedule,
// Start arms it), and the slot the control plane computes on read.
//
// ``next_run_at`` is nullable *and* allowed to be in the past. Null is a
// paused net or an unparseable expression; a past value is a slot still owed,
// which is the state the whole feature exists to make visible. A type that
// promised a future time would push the UI into showing tomorrow while
// nothing had run.
const _net_schedule_fields: Pick<
	Net, 'execution_mode' | 'schedule' | 'desired_state' | 'next_run_at'
> = {
	execution_mode: 'cron',
	schedule: '0 2 * * *',
	desired_state: 'running',
	next_run_at: '2026-09-06T02:00:00Z',
};

const _paused_net_schedule_fields: Pick<
	Net, 'execution_mode' | 'schedule' | 'desired_state' | 'next_run_at'
> = {
	execution_mode: 'cron',
	schedule: '0 2 * * *',
	desired_state: 'stopped',
	next_run_at: null,
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

// Provenance: which deployment a net or notebook runs, and the newer one when
// there is one. The chips and the notebook Upgrade action read these fields.
const _deployment_summary: DeploymentSummary = {
	id: '44444444-4444-4444-4444-444444444444',
	git_commit: '0123456789abcdef0123456789abcdef01234567',
	git_commit_short: '0123456',
	git_ref: 'main',
	created_at: '2026-09-25T10:04:00Z',
	build_status: 'success',
};

const _net_provenance: Pick<Net, 'deployment' | 'newer_deployment'> = {
	deployment: _deployment_summary,
	newer_deployment: null,
};

const _notebook_provenance: Pick<Notebook, 'deployment' | 'newer_deployment'> = {
	deployment: null,
	newer_deployment: _deployment_summary,
};

const _worker_delete_result: WorkerDeleteResult = {
	notebooks_unassigned: 1,
	notebook_ids: ['55555555-5555-5555-5555-555555555555'],
};

export const __provenance_contract_check = [
	_net_provenance,
	_notebook_provenance,
	_worker_delete_result,
];

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
	_open_run_shape,
	_running_open_run,
	_net_run_fields,
	_net_schedule_fields,
	_paused_net_schedule_fields,
	_daily_shape,
];

// -- Operation contract --
//
// The operations component, the busy verdict and the Load button's 202 all
// read these fields; the summary is what net, notebook and sync responses
// carry for a running operation.
const _operation_shape: Operation = {
	id: 'op-1',
	user_id: 'u-1',
	kind: 'notebook_load',
	subject_kind: 'notebook',
	subject_id: 'nb-1',
	worker_id: 'w-1',
	trigger: 'user',
	state: 'running',
	step: 'dependencies',
	step_message: 'resolving packages',
	started_at: '2026-09-25T10:00:00Z',
	heartbeat_at: '2026-09-25T10:00:05Z',
	finished_at: null,
	error: null,
};

const _operation_summary_shape: OperationSummary = {
	id: 'op-1',
	kind: 'net_load',
	trigger: 'schedule',
	step: null,
	step_message: null,
	started_at: '2026-09-25T10:00:00Z',
	heartbeat_at: '2026-09-25T10:00:05Z',
};

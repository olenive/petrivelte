# Petrivelte frontend

SvelteKit 2, Svelte 5, TypeScript and Tailwind 4. Client-rendered (`ssr =
false` in the `(app)` layout), served by `adapter-node`. How it talks to the
control plane is in [../COMS.md](../COMS.md).

## Run, test, type-check

```bash
npm install
npm run dev          # http://localhost:5173, API at PUBLIC_API_URL or http://localhost:8000
npm test             # vitest run (unit tests sit beside the modules as *.test.ts)
npx vitest run src/lib/runs.test.ts   # one file
npm run check        # svelte-kit sync + svelte-check (also type-checks api.contract.ts)
npm run build && npm run preview
```

The control plane runs from `../petritype-server` with
`uv run uvicorn petritype_server.server:app --reload --port 8000`.
Deploy with `fly deploy` (app `petrify-frontend`; `PUBLIC_API_URL` is set in
`fly.toml` as a build arg and env var).

## Routes (`src/routes`)

| Path | Page |
|---|---|
| `/` | Setup checklist and quick start. |
| `/wiring` | Graph of workers, nets, notebooks and their bindings. |
| `/nets` | Net selector, graph, execution controls, inject, runs and schedule, logs, secrets, Diagnose. |
| `/notebooks` | Notebook index grouped by worker, badges from `load_state` plus `/sync`. |
| `/notebooks/[id]` | One notebook in an iframe, with load progress and health. |
| `/workers` | Workers, their nets, occupancy, build chip, logs, lifecycle actions. |
| `/workers/[id]/logs` | Full-page worker log. |
| `/deployments` | GitHub repos, builds and discovered definitions. |
| `/settings` | Account, GitHub link, API tokens. |
| `/login`, `/auth/callback`, `/forgot-password`, `/reset-password`, `/verify-email`, `/confirm-email-change` | Auth flows, under `(auth)`. |
| `/dev` | Component playground, dev builds only. |

## Library (`src/lib`)

Most modules are pure functions with a table of cases in a sibling test.

- `api.ts`: every control-plane call and its types. `NetProxyError` and
  `isNotLoaded` for proxy refusals, `diagnoseNet`, `getNetLogHistory(netId,
  {limit, since, contains, newest_first})`, runs, operations, notebooks,
  occupancy, wiring. `api.contract.ts` holds compile-time shape checks.
- `apiTokens.ts`: token display helpers, `SCOPE_CHOICES`, `DEFAULT_SCOPE`
  (`read`) and `describeScope`; `ApiTokenScope` is in `api.ts`.
- `netHelpers.ts`: net labels, token layout, `applyTokenCounts`, and
  `coerceParamValue`, which applies the server's declared `coerce` for a
  factory parameter and falls back to the annotation text (`int`, `float`,
  `bool`) for an older control plane.
- `netAnomalies.ts`: words for the server's anomaly tags; unknown tags show
  as themselves.
- `netInstances.ts`: `groupByDefinition` and `workerLabel`, answering which
  workers a definition runs on.
- `netDiagnose.ts`: tone map for Diagnose verdict states; unknown states are
  grey.
- `runs.ts`: run labels and colours, and `scheduleFacts`, which prefers the
  server's `schedule_facts` message and computes a client version only when
  the server sends none.
- `operations.ts` with `components/OperationStatus.svelte`: slow operations
  (step, message, elapsed, heartbeat age) folded from operation events.
- `workerStream.ts`: when the worker event stream must be replaced by a REST
  refetch. `workerBuild.ts`: build chip and roll command. `workerDelete.ts`:
  delete warnings.
- Notebooks: `notebookSync.ts` (diagnosis and remount decisions),
  `notebookHealth.ts` (net, data and frame facts), `notebookIndex.ts`
  (index grouping and badges), `notebookLoadProgress.ts`,
  `notebookLoadReason.ts`, `notebookOccupancy.ts` (memory fit),
  `notebookIdleTimeout.ts`, `notebookThresholds.ts` (served by the CP),
  `notebookDefects.ts` (build-time defects).
- `provenance.ts`: deployment chip and newer-code marker.
- `stores/`: `serverEvents`, `workerEvents`, `workerLogs`, `workerMemory`,
  `backendHealth`, `slowRequests`, `tokenSelection`.
- `idempotency.ts`, `theme.ts`, `types.ts` (graph shapes),
  `actions/portal.ts`, `security/sensitiveQueryParams.ts`.
- `components/`: graph rendering (`GraphPanel`, `Place*`, `Transition`,
  `Edge`, `Token`, `AnimatingToken`), inspectors, `LogViewer`, `RunsPanel`,
  notebook banners and panels, `AppNav`, `ProvenanceChip`, toasts.

## Logs

The worker log viewer (inline on `/workers` and full page at
`/workers/[id]/logs`) shares one store, `stores/workerLogs.ts`: it seeds from
`/api/workers/{id}/logs/history`, then appends state changes,
`net_load_log` and `worker_provision_log` from `/api/events`, and `log`,
`subprocess_output`, `step_error` and `execution_stopped` from the worker's
own event stream. The nets page
seeds its log panel from the worker's durable per-net log file through
`getNetLogHistory`.

## Conventions

Style rules for code in this directory are in `CLAUDE.md` and `AGENTS.md`.

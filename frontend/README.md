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
`fly.toml` as a build arg and env var, and `PUBLIC_SHARE_URL`, the public
tier's base URL that share links start with, as an env var).

## Routes (`src/routes`)

| Path | Page |
|---|---|
| `/` | Setup checklist and quick start. |
| `/wiring` | Graph of workers, nets, notebooks and their bindings. |
| `/nets` | Net selector, graph, execution controls, inject, runs and schedule, logs, secrets, Diagnose; inner nets (open a badged token's net in place, breadcrumb and Up) and a token filter by keys. |
| `/notebooks` | Notebook index grouped by worker, badges from `load_state` plus `/sync`. |
| `/notebooks/[id]` | One notebook in an iframe, with load progress and health. |
| `/sharing` | The owner's shares (world or notebook, scope, audience, seat, bundle, expiry, state, last use) with revoke, a public share's address in full with Copy; the form that mints one, with an optional bundle for a world, and shows its link once, or a public share's address under a handle chosen from the owner's, or reserved on the spot; the Public handles box above it, which reserves handles up to the account's limit and renames or releases one no live share is under; and the owner's bundles (zips of a game or viewer served beside a shared world) with upload and delete. Ticking Publish payloads on a link or public share warns, under the checkbox, that token values will be visible to anyone who has the link or anyone at the public address. |
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
  occupancy, wiring, shares, the public handles and bundles (`uploadBundle`
  sends the zip as the raw request body). `api.contract.ts` holds
  compile-time shape checks.
- `apiTokens.ts`: token display helpers, `SCOPE_CHOICES`, `DEFAULT_SCOPE`
  (`read`) and `describeScope`; `ApiTokenScope` is in `api.ts`. The expiry,
  last-use and created wording also serves shares.
- `shares.ts`: the Sharing page's rules: a share's state, its link from
  `PUBLIC_SHARE_URL` (`shareLinkBase` says why there is none) or a public
  share's address (`publicLink`), the owner's public handles
  (`defaultHandle`, the one the form offers first, and `keepHandle`;
  `handlesReservedText`, `handleInUse`, `handleInUseNote` and
  `releaseWarning`), the net picker grouped by worker that keeps a world on
  one worker, `slugFromLabel`, the slug a public share's label suggests,
  `withAudience`, which makes a public share read only, `shareRequest`,
  which builds the mint body from the form and leaves out only what the
  share's kind would refuse, `formatBundleSize`, and `bundleFileRefusal`,
  which refuses a zip over the server's 64 MiB cap in the server's words
  before it is sent.
- `netHelpers.ts`: net labels, token layout, `applyTokenCounts`, and
  `coerceParamValue`, which applies the server's declared `coerce` for a
  factory parameter and falls back to the annotation text (`int`, `float`,
  `bool`) for an older control plane.
- The nets page's graph: `netMirror.ts` (the marking mirror and the
  version rule), `innerNets.ts` (badges of tokens that hold nets, the inner
  net shown, when it is gone, the breadcrumb, outer firings seen from
  inside), `tokenFilter.ts` (the view-side token filter by keys),
  `netView.ts` (what the panel draws), `firingPlayback.ts` (the firing
  animation), `layout.ts` and `graphLayout.ts` (the layered layout).
- `netDraw.ts` with `netDraw/`: the net drawing module, below.
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

## The net drawing module

`src/lib/netDraw.ts` draws a net's state (`NetState`) into an `<svg>`
element the way the graph panel does, with no framework.
`drawNet(svg, state, options)` lays the net out once per topology and
generation, kept per element, and draws or updates in place the places,
token dots and labels, counts, the badges of tokens that hold nets,
transitions in their four looks and arcs in their strokes and heads, with
pan by drag and zoom by wheel; `releaseNet(svg)` forgets the element and
removes its listeners. A state without tokens, as the public tier sends a
share that does not publish payloads, draws each place with its count.
The options:

- `tokenLabels`: each token's label on its dot and the first under its
  place; on by default when the state lists any tokens.
- `interactive`: pan by drag and zoom by wheel; on by default.
- `width`, `height`: the frame in user units; by default the svg's own
  `width` and `height` attributes, else 800 by 500.
- `fit`: start with the whole net in view, scaled down (never up) to fit
  the frame with the layout's margin and centred, after the first draw and
  each re-layout; a redraw keeps the viewer's pan and zoom. Off by default,
  which shows the net at the app's size from its first rank. With
  `interactive`, a double-click returns to where the drawing started from
  wherever the viewer panned or zoomed to, or with `fitFloor` in force
  toggles between that start and the whole net. A redraw of the marking
  keeps whichever view the viewer is in; a re-layout starts over.
- `fitFloor`: with `fit`, the smallest scale the fit may choose. A net that
  would need less, such as the reachability monitor with one rank of about
  forty-five places, starts at this scale centred on its middle, for the
  viewer to pan. 0 by default, which is no floor; a value above 1 counts as
  1.

The module writes SVG presentation attributes and classes (`net-place`,
`net-transition`, `net-transition-fireable`, `net-arc`, `net-token`,
`net-count`, `net-badge` and others), never an inline style or script, so
it runs under a policy that allows script and style only by nonce. Colours
are the light theme's; a host page restyles by class and sets the svg's
background (the panel's is `#f0f0f0`).

`npm run build:lib`, or `just build-lib` at the repository root, builds it
with `vite.lib.config.ts`, apart from the app's build and without Svelte,
into `dist-lib/`:

- `net-view.js`, an ES module exporting `drawNet` and `releaseNet`. The app
  will adopt it in place of the panel's components, so that one drawing
  serves both.
- `net-view.iife.js`, a classic script that puts `petriNetView.drawNet` and
  `petriNetView.releaseNet` on the global object, for a page that loads it
  with `<script nonce src>`. The public tier vendors this file:
  petritype-server's `scripts/update-net-view.sh` rebuilds it from a
  checkout of this repository and copies it in.

`netDraw.test.ts` draws the fixture `netDraw.fixture.json` under jsdom;
`netDraw.bundle.test.ts` builds both files and holds that they name nothing
from Svelte, import nothing and export the two functions; and
`tests/ui/test_net_view_module.py` loads the IIFE in a bare page served
with the public tier's policy and draws the same fixture.

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

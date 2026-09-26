# Notebooks index — `/notebooks`

Status: agreed and built 2026-09-07; awaiting frontend deploy. Decisions taken with the user are marked
**decided**; everything else is the implementer's call within these bounds.

## Problem

`/notebooks/<id>` renders a notebook, but `/notebooks` is a 404 and the nav
has no Notebooks entry. The only way to find a notebook is the wiring canvas,
where it is one node among workers, nets and bindings. A person arriving from
a bookmark or an alert has no list to fall back to, and no page answers
"which notebooks exist, where do they run, are they healthy" without opening
each one.

## Shape

One section per worker, workers with no notebooks still listed, an
*Unassigned* tail for notebooks with no worker.

```
Notebooks                                              [+ Add notebook]

e2e-tailarm-20260903-195657   ready · 2 CPU · 1310/2048 MB · 2 nets
  ● nb traffic   view_traffic               tracking   → monitor-anomalies   0 errors   Open · Unload
  ○ nb daily     visualise_daily_pipeline   unloaded   → daily-pipeline                 Open · Load

check-20260907-160655         ready · no notebooks                        [Add notebook]

Unassigned
  ○ nb-scratch   view_traffic               no worker                              Assign in wiring
```

Per worker header: name, status, CPUs, memory used/total when known, and a
**net count linking to `/nets`** — nets appear on this page only as counts
and as the binding targets of notebook rows, never as rows of their own
(**decided**; the Nets page owns nets).

Per notebook row: instance name linking to `/notebooks/<id>`, definition name
muted, status badge, one `→ <net instance name>` per bound slot linking to
that net on `/nets`, error-group count, relative last change (`updated_at`),
actions.

Sorting: workers by name; notebooks by instance name. Empty state when the
user has no notebooks at all: one sentence and a link to `/deployments`,
because a notebook comes from a deployment.

## Status vocabulary

The notebook page's badge (`live`, `not drawing`, `connecting`, …) measures the
*browser tab's* render channel. The index has no tab open on any notebook, so
`ws_sessions === 0` is normal there and must not read as a fault. Index badges
derive from `load_state` plus `/sync`, never from `frameFact`:

The bridge (the code in the notebook subprocess that follows its nets and
posts the `/sync` report) starts from a notebook cell, and cells run only once
a browser opens the notebook. Once started it keeps reporting after the tab
closes, until the subprocess dies. So a notebook nobody has opened since it
loaded has no report at all, and that is normal: it reads `loaded`, never
`stale`. `transport.first_report_age_s === null` is how the index knows the
bridge has not reported in this subprocess; any slots in the payload then are
leftovers from an earlier run and are ignored.

| badge          | when                                                                 |
|----------------|----------------------------------------------------------------------|
| `unloaded`     | `load_state === 'unloaded'`                                          |
| `loading …`    | `load_state === 'loading'`, phase from the notebook row when present |
| `error`        | `load_state === 'error'`; `load_error` as the title attribute        |
| `unreachable`  | loaded, `/sync` `reachable: false` (`busy`/`gone` for those reasons) |
| `gone`         | loaded, `transport.alive === false`                                  |
| `idle`         | loaded, no bindings                                                  |
| `loaded`       | bridge never reported, never opened: "not opened yet", blue-grey     |
| `syncing`      | "starting…": bridge never reported, opened under `bridge_start_deadline_s` ago |
| `stale`        | "not tracking": bridge never reported, opened longer ago than that   |
| `stale`        | "not tracking": bridge reported, but no slots for its bindings       |
| `stale`        | bridge reported, a slot `stale` or `disconnected` by `slotSyncState` |
| `syncing`      | "syncing…": bridge reported, a slot waiting for its first sync       |
| `tracking`     | bridge reported (or no transport block), every slot `live`           |

Reuse `netFact` and `dataFact` from `lib/notebookHealth.ts` for the words and
thresholds; do not duplicate their logic. Show "viewed in N tabs" from
`transport.ws_sessions` as a muted hint when N > 0.

## Data

- One `GET /api/wiring` (workers, nets, notebooks, bindings, worker memory) —
  the payload the wiring page already consumes, so the grouping code is shared
  in spirit and can be shared in fact (`lib/notebookIndex.ts`).
- For loaded notebooks only, in parallel: `GET /api/notebooks/{id}/sync` and
  `GET /api/notebooks/{id}/errors` (count only).
- Live: subscribe to `serverEventsStore`; patch rows on
  `notebook_state_changed`, `worker_state_changed`, `net_state_changed`,
  `notebook_error`. Re-poll `/sync` for loaded notebooks every 10 s while the
  document is visible; stop when hidden.
- Deferred: a backend `GET /api/notebooks/overview` batching sync and errors
  per worker, only if notebook counts make N calls a problem.

## Actions

Open (link), Load, Unload, Reload (unload then load). Load reuses the existing
occupancy warning and the additional-notebook confirm
(`NotebookOccupancyBanner`, `NotebookLoadConfirm`, `notebookOccupancy.ts`),
exactly as the notebook page does. Delete stays in Wiring (**decided**).
"Add notebook" and the per-worker button deep-link to the wiring page's
add-notebook modal via `/wiring?add=<workerId>`; the wiring page reads the
query parameter once on mount and opens the modal preselecting that worker.

## Navigation

- `AppNav`: a `Notebooks` link between `Nets` and `Workers` (**decided**).
- Notebook page header: `← Wiring` becomes `← Notebooks`; the back handler
  keeps trying browser history first and falls back to `/notebooks` instead
  of `/wiring` (**decided**). Coming from Wiring therefore still returns to
  Wiring; a direct open lands on the index.

## Files

- `src/routes/(app)/notebooks/+page.svelte` — new page.
- `src/lib/notebookIndex.ts` — pure helpers: group the wiring payload by
  worker, derive the badge from a notebook row plus its sync, sort, format
  the worker header line. No fetches, no Svelte.
- `src/lib/notebookIndex.test.ts` — vitest, in the style of the other
  `lib/*.test.ts` files.
- `src/lib/api.ts` — only if a helper is missing (wiring fetch, notebook
  load/unload/sync/errors all exist somewhere already; reuse them).
- `src/lib/components/AppNav.svelte`, `src/routes/(app)/notebooks/[id]/+page.svelte`,
  `src/routes/(app)/wiring/+page.svelte` (the `?add=` parameter).

## Checklist

- [x] (2026-09-07) `lib/notebookIndex.ts` + tests: grouping, badge derivation for every row of the table above, sorting, header line
- [x] (2026-09-07) `/notebooks` page: sections, rows, badges, actions, empty state, unassigned tail
- [x] (2026-09-07) live updates via `serverEventsStore`; 10 s sync re-poll gated on visibility
- [x] (2026-09-07) nav link; back link and fallback on the notebook page
- [x] (2026-09-07) `/wiring?add=<workerId>` opens the add-notebook modal
- [x] (2026-09-07) `npm run check` and `npm test` clean
- [ ] deployed (user runs `deploy.sh --frontend` from petritype-server)

## Out of scope

Deleting notebooks, creating notebooks outside the wiring modal, a backend
overview endpoint, and any change to what the notebook page itself shows.

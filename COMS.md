# Frontend and control plane communication

How the browser talks to the petritype-server control plane (CP). The server
side lives in `../petritype-server`; this file records what the frontend
relies on.

## Authentication

- The browser authenticates with an httponly session cookie
  (`petritype_session`). Every call in `src/lib/api.ts` sends
  `credentials: 'include'`, and every EventSource opens with
  `withCredentials: true`. The `(app)` layout redirects to `/login` when
  `getMe()` returns no user; the build trigger turns a 401 into
  `SessionExpiredError`.
- Personal API tokens (`petri_pat_...`) are for scripts and agents, never the
  browser. The Settings page creates, lists and revokes them; token
  management itself needs a browser session. Each token has a scope, checked
  by the server in `petritype_server/auth/scopes.py`:
  - `read`: GET requests only.
  - `operate`: every other write, such as load, start, stop, reset, inject,
    and creating or editing nets and notebooks.
  - `manage`: everything, including every DELETE, `POST /api/workers`, worker
    provision and destroy, `POST /api/github/repos` and repo build triggers.

## Requests

- `API_URL` comes from `PUBLIC_API_URL` (`src/lib/config/network.ts`); it
  defaults to `http://localhost:8000` in dev and must be https in production.
- Every one-shot request goes through `_timed` in `api.ts`, which reads the
  CP's `Server-Timing` and `X-Backend-Slow: db` headers and feeds
  `stores/backendHealth.ts` (names 429 as rate limited, throws and 502/503/504
  as unreachable) and `stores/slowRequests.ts` (the "still working" toast).
- Identical concurrent reads are coalesced. State-changing calls that may be
  retried carry an `X-Idempotency-Key` (`idempotency.ts`).
- The CP rate-limits the nets and workers lists (30/min), the wiring view
  (60/min) and the auth routes per user; a 429 shows as a banner.

## Net execution proxy

Execution state, history, step, start, stop, reset, inject, tokens and net log
history go to `/api/nets/{id}/...` and the CP forwards them to the net's
worker. When the CP refuses on its own it answers
`{"detail": <sentence>, "reason": <tag>}`, parsed into `NetProxyError`
(`status`, `reason`, message = detail):

| Status | Reason | What the UI does |
|---|---|---|
| 404 | `net_not_found` | Shows the detail as an error. |
| 409 | `not_assigned` | Shows the detail. |
| 409 | `not_loaded` | `isNotLoaded()` is true: shown quietly as a state, and reads return empty (history, log history). |
| 503 | `worker_not_ready` | Shows the detail. |
| 502 | `worker_unreachable` | Shows the detail; log history says why it is missing. |

`isNotLoaded` also accepts a bare 404 with no reason, from an older CP.
`diagnoseNet` (`GET /api/nets/{id}/diagnose`) returns one verdict per net,
judged against its own stall threshold; `netDiagnose.ts` colours it.
State `waiting` (a 24/7 net with no stall threshold, running but with nothing
enabled) is quiet like `scheduled`. `facts.worker_probe` may carry
`executing_since`, `executing_transition` and `idle_since`, with
`facts.executing_age_seconds`, `idle_age_seconds`, `stall_threshold_seconds`
and `stall_threshold_source` (`declared` or `default`); all nullable, and the
panel turns the first set into one line under the reason.

## Live channels

All are Server-Sent Events with the cookie; there is no WebSocket in this app
apart from the one Marimo opens inside the notebook iframe.

- `GET /api/events` (`stores/serverEvents.ts`): per-user CP events, fed by
  Postgres LISTEN/NOTIFY so they are sent only after the writing transaction
  commits. Each carries a monotonic `seq` (also the SSE id); on reconnect the
  store replays `GET /api/events/history?after={seq}`. Types:
  `worker_state_changed`, `net_state_changed`, `notebook_state_changed`,
  `notebook_error`, `net_load_log`, `worker_provision_log`,
  `net_run_started|finished|skipped`, `operation_started|progress|finished`.
- `GET /api/workers/{id}/events?after={seq}` (`stores/workerEvents.ts`,
  also opened by `stores/workerLogs.ts`): the worker's unified stream,
  `{seq, scope, net_id, kind, ts, data}`, with kinds such as
  `transition_fired`, `step_*`, `graph_state`, `log`, `subprocess_output`,
  `memory_stats` and `stream_gap`. The first connection for a worker asks
  with `after=1000000000000`, a cursor ahead of any worker sequence, as the
  CP's own keepalive does: the worker replays nothing and sends one
  `stream_gap` marker (`reason: restarted`, `data.current_seq` its sequence
  now) that seeds the cursor. The page has just fetched the net over REST,
  and replaying a busy worker's whole buffer (2000 events) on top of that
  froze the tab. Reconnects the store makes itself ask with `after={seq}` so
  the worker replays what was missed. The stream is a fast path, not the
  truth: `workerStream.ts` bumps a generation on reconnect, on a
  `stream_gap` that answers a real cursor, or on a restarted sequence, and
  the page refetches over REST.
- `GET /api/workers/{id}/logs/history` seeds the worker log viewer;
  `GET /api/nets/{id}/logs/history` (`getNetLogHistory`, with `limit`,
  `since`, `contains`, `newest_first`) reads the worker's durable per-net
  log file, which survives subprocess and worker restarts.
- `GET /api/notebooks/{id}/events` streams notebook load progress
  (`notebookLoadProgress.ts`).

## Notebooks

The notebook page embeds `/api/notebooks/{id}/` in an iframe; the CP proxies
it to Marimo on the worker, and Marimo's render WebSocket runs inside the
iframe. Health rides HTTP: the page polls `GET /api/notebooks/{id}/sync`
(bridge slot reports, transport counters) and judges it with thresholds the
CP serves (`notebookThresholds.ts`). The page cannot see the cross-origin
iframe's socket, so `notebookSync.ts` decides from ages and counters whether
to remount the iframe, with a capped budget.

## Polling

SSE triggers refetches; a few pages also poll as a fallback: the workers page
every 30 s while visible, the notebooks index `/sync` every 10 s, and the nets
page every 5 s while a net is running.

## State the UI assumes

- Worker `status`: `pending`, `provisioning`, `ready`, `stopped`, `error`.
  Net actions need `ready`. When a worker leaves `ready`, the CP resets its
  nets to `unloaded` and emits the events.
- Net `load_state`: `unloaded`, `loaded`, `error`, with the reason in
  `load_error`. Notebook `load_state` works the same way, and
  `notebookLoadReason.ts` turns `load_error` codes (idle eviction, crash,
  teardown) into words.
- Deleting a worker deletes its nets and secrets; its notebooks become
  unassigned with reason `worker_deleted` (`workerDelete.ts`).
- The CP runs its own health loop over ready workers, so a dead machine
  reaches the UI as a `worker_state_changed` event.

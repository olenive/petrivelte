# Backend Communication & State Management Plan

## Problem

The backend stores worker and net states in the database but these can become stale when external resources (Fly machines) change state outside of API calls. When a Fly machine crashes or gets reaped, the DB still says `ready`. Actions like `stop` then fail with 404s that propagate as unhelpful errors to the user. The backend also has no mechanism to push state changes to connected frontends.

## Goals

1. Gracefully handle external resource failures (update DB state when Fly/Sprite resources are gone)
2. Push state changes to the frontend in real-time via SSE
3. Rate-limit polling endpoints to prevent abuse
4. Ensure state consistency: when worker state changes, net load states must be reconciled

---

## State Model & Invariants

### Worker States
| State | Meaning | Transitions to |
|-------|---------|---------------|
| `pending` | Record created, no resource | `provisioning` |
| `provisioning` | Resource being created | `ready`, `error` |
| `ready` | Resource confirmed running | `stopped`, `error` |
| `stopped` | Intentionally stopped (persistent only) | `ready` (via start), `error` |
| `error` | Resource unreachable/gone | `provisioning` (via retry) |

### Net Load States
| State | Meaning | Transitions to |
|-------|---------|---------------|
| `unloaded` | Default / not loaded | `loaded`, `error` |
| `loaded` | Confirmed active on worker | `unloaded` (explicit), `error` |
| `error` | Load failed or worker issue | `unloaded`, `loaded` (retry) |

### Key Invariants
1. **Worker leaves `ready`** → ALL assigned nets MUST be set to `unloaded`
2. **Net reassigned** (worker_id changes) → net load_state MUST be set to `unloaded`
3. **Worker deleted** → all assigned nets unassigned (worker_id = null, load_state = unloaded)

---

## Changes Required

### 1. Graceful Error Handling in Lifecycle Operations

When Fly/Sprite API calls fail with resource-not-found errors (404, connection refused, etc.), the backend should **update state to reflect reality** instead of just raising an exception.

**`stop_fly_worker()` / `stop_sprite()`:**
- Catch 404 / not-found errors
- Update worker status to `error` in DB
- Reset all assigned net load_states to `unloaded`
- Return a meaningful response (not a 500)
- Emit SSE event (see below)

**`destroy_fly_machine()` / `destroy_sprite()`:**
- Catch 404 / not-found errors
- If the resource is already gone, treat as success (idempotent)
- Update worker status to `pending` (resource destroyed)
- Reset all assigned net load_states to `unloaded`
- Emit SSE event

**`load_net()` / `unload_net()`:**

> **Note:** `load_net` and `unload_net` already persist `load_state` (`loaded`/`unloaded`/`error`) from the recent net load-state tracking work. The changes below extend the existing error handling to also update the worker and sibling nets.

- If the worker is unreachable (connection error, 502, etc.):
  - Set net load_state to `error` *(already done)*
  - Set worker status to `error` *(new)*
  - Reset all OTHER nets on that worker to `unloaded` *(new)*
  - Emit SSE events for both worker and net state changes *(new)*
- Return the updated state in the error response so the frontend can display it

### 2. Server-Sent Events (SSE) Endpoint

Add a new endpoint: `GET /api/events`

**Authentication:** Must require a valid session cookie (same auth as all other endpoints). Reject unauthenticated requests.

**Behavior:**
- Keep the connection open, sending events as they occur
- Each event is a JSON payload with a `type` field
- Use standard SSE format (`data: {...}\n\n`)
- Send a keepalive comment (`: keepalive\n\n`) every 30 seconds to prevent proxy/LB timeouts
- Scope events to the authenticated user (only send events for their workers/nets)

**Event types to emit:**
```json
{"type": "worker_state_changed", "worker_id": "...", "status": "error"}
{"type": "net_state_changed", "net_id": "...", "load_state": "unloaded"}
```

**When to emit events:**
- Any time a worker status is updated in the DB (provision success/failure, stop, start, destroy, health check, error recovery)
- Any time a net load_state is updated in the DB (load, unload, error, reconciliation from worker state change)
- Bulk events are fine: if a worker goes down and 3 nets are reset, emit 1 worker event + 3 net events

**Implementation approach — Postgres LISTEN/NOTIFY:**

Use Postgres as the event bus so that SSE works across multiple backend instances without additional infrastructure.

- **Notification channel:** `state_changes` (scoped by user_id in the payload)
- **Publishing:** When any route handler changes worker/net state, issue a `NOTIFY state_changes, '<json payload>'` after the DB update. The payload includes `user_id` so listeners can filter. Example:
  ```sql
  NOTIFY state_changes, '{"user_id":"...","type":"worker_state_changed","worker_id":"...","status":"error"}'
  ```
  Wrap this in a helper: `await notify_state_change(conn, user_id, event_type, payload)`
- **Listening:** Use a **shared listener** pattern: a single background task holds one DB connection, runs `LISTEN state_changes`, and fans out received notifications to in-process SSE clients via `asyncio.Queue` per client. This avoids holding one DB connection per SSE client, which would exhaust the connection pool under moderate concurrency (e.g. 50 users = 50 reserved connections).
- **Filtering:** The shared listener receives all notifications. When dispatching, it only forwards to clients whose `user_id` matches the notification's `user_id`.
- **Connection lifecycle:** The shared LISTEN connection is managed as a FastAPI lifespan task (start on startup, close on shutdown). Individual SSE clients register/unregister their queues with the shared listener.
- **Payload size limit:** Postgres NOTIFY payloads are limited to ~8KB. Our events are small (type + IDs + status), so this is fine.
- **NOTIFY is transactional:** The notification is only sent when the transaction commits, so the frontend will never receive an event for a state change that was rolled back.

### 3. Health Check Improvements

The existing `POST /api/workers/{worker_id}/health-check` endpoint should:

- **Update worker status** based on health check result:
  - Healthy → ensure status is `ready`
  - Unreachable → set status to `error`, reset all net load_states to `unloaded`
- **Reconcile net load states** against the worker's reported `loaded_nets` list (already partially implemented)
- **Emit NOTIFY events** for any state changes detected
- **Return the updated state** in the response

### 4. Background Health Check Loop

Add an async background task that runs continuously while the server is up:

- **Interval:** every 60 seconds
- **Scope:** all workers with `status = 'ready'`
- **Per worker:** call the existing `check_worker_health()` function with a **5-second HTTP timeout**
- **On failure (timeout / connection refused / non-200):**
  - Set `worker.status = 'error'`
  - Reset all assigned nets to `load_state = 'unloaded'`
  - Issue `NOTIFY state_changes` for the worker and each affected net
- **On success but state mismatch** (e.g., worker reports a net is not loaded but DB says `loaded`):
  - Reconcile net load_states to match reality
  - Issue `NOTIFY` for any changes
- **Concurrency:** run health checks concurrently with `asyncio.gather` (all workers in parallel), but cap at e.g. 20 concurrent checks to avoid overwhelming the event loop
- **Startup:** register as a FastAPI `lifespan` background task (or `on_event("startup")`)
- **Shutdown:** cancel cleanly on server shutdown

### 5. Rate Limiting

To prevent abuse from polling:

Add rate limiting via `slowapi` (FastAPI-compatible, wraps `limits`):
- `GET /api/workers` — max 30 requests per minute per user
- `GET /api/nets` — max 30 requests per minute per user
- Return `429 Too Many Requests` when exceeded

> **Why 30/min instead of 10/min:** During SSE reconnection gaps (network blip, server restart, tab refocus), the frontend may burst several rapid fetches to re-sync state. 30/min (one request every 2 seconds) gives enough headroom for this without enabling true abuse.

The SSE endpoint doesn't need rate limiting (it's a single long-lived connection), but should limit to **1 concurrent SSE connection per user** (close the old one if a new one opens).

### 6. Error Response Format

When an action fails due to stale state, return a structured error that helps the frontend:

```json
{
  "error": "Worker is no longer available",
  "detail": "The Fly machine no longer exists (404). Worker status has been updated to 'error'.",
  "worker_status": "error",
  "net_load_state": "unloaded"
}
```

This allows the frontend to update its local state immediately from the error response, without needing a separate refresh call.

---

## File Changes Summary

| Area | Changes |
|------|---------|
| `workers/lifecycle.py` | Catch 404/connection errors in stop/destroy/health-check; update DB state; call `notify_state_change()` |
| `workers/routes.py` | Import and use event emitter; improve health-check response |
| `nets/routes.py` | Extend existing load/unload error handling to also update worker status and sibling nets; call `notify_state_change()` |
| New: `events/notify.py` | `notify_state_change(conn, user_id, event_type, payload)` helper — issues `NOTIFY state_changes` |
| New: `events/listener.py` | Shared LISTEN connection manager: one background task holding a single DB connection, fans out via `asyncio.Queue` per registered SSE client |
| New: `events/routes.py` | `GET /api/events` SSE endpoint — registers a queue with the shared listener, streams filtered events to the client |
| New: `workers/health_loop.py` | Background task: 60s loop checking all `ready` workers via `check_worker_health()`, emitting NOTIFY on changes |
| `server.py` / app lifespan | Register both the shared LISTEN task and the health check loop as lifespan background tasks |
| Rate limiting | Add `slowapi` dependency; apply 30/min per-user limit to `GET /api/workers` and `GET /api/nets` |

---

## Implementation Order

1. **`events/notify.py`** — `notify_state_change()` helper. Can start as a no-op wrapper to unblock other steps.
2. **`events/listener.py`** — Shared LISTEN connection + fan-out via `asyncio.Queue`.
3. **`events/routes.py`** — `GET /api/events` SSE endpoint. Wire into `server.py`.
4. **Graceful error handling** — Update `lifecycle.py` (stop/destroy catch 404s) and `nets/routes.py` (extend load/unload to update worker + sibling nets). Wire in `notify_state_change()` calls.
5. **`workers/health_loop.py`** — Background 60s loop. Wire into `server.py` lifespan.
6. **Rate limiting** — Add `slowapi`, apply to list endpoints. Lowest priority since SSE reduces polling.

---

## Sequence Diagram: Worker Crash Recovery

```
[Fly machine crashes]

[Option A: Frontend polls]
  Frontend → GET /api/workers
  Backend returns worker with status still "ready" (stale)
  Frontend shows "ready" (still wrong at this point)

  Frontend → user clicks "Load" on a net
  Frontend pre-check → GET /api/nets (still shows old state)
  Frontend → POST /api/nets/{id}/load
  Backend tries to reach worker → connection refused
  Backend:
    1. Sets worker.status = 'error'
    2. Sets net.load_state = 'error'
    3. Resets all other nets on worker to 'unloaded'
    4. Emits SSE: worker_state_changed + net_state_changed
    5. Returns 502 with structured error including new states
  Frontend receives error → updates UI

[Option B: Health check detects it]
  Backend health check runs (or frontend triggers it)
  Backend pings worker → timeout/refused
  Backend:
    1. Sets worker.status = 'error'
    2. Resets all net load_states to 'unloaded'
    3. Emits SSE events
  Frontend receives SSE → refreshes and updates UI

[Option C: SSE push (if backend has its own health monitoring)]
  Backend detects failure via monitoring
  Backend updates state + emits SSE
  Frontend receives immediately
```

---

## Resolved Decisions

- **Multi-instance deployment** — using Postgres LISTEN/NOTIFY as the event bus. All backend instances listen on the same channel, so SSE works regardless of which instance the client is connected to. No Redis or additional infrastructure needed.
- **Backend periodic health checks** — yes, run them. An async background task iterates over all `ready` workers every 60 seconds, pinging each worker's `/health` endpoint with a 5-second timeout. Cost is negligible (even 100 workers = 100 small HTTP requests/minute). Dead machines are detected within ~60s without user interaction. On failure: update worker status to `error`, reset net load_states to `unloaded`, emit NOTIFY events.
- **Fly machine webhooks** — Fly does not currently offer per-machine state change webhooks. This has been a frequently requested community feature but is not shipped. The 60s health check loop is the best available approach.

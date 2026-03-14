# Log Streaming Plan

Real-time log visibility for worker provisioning, net loading, and worker runtime.

## SSE Infrastructure (exists)

All real-time events arrive via a single Server-Sent Events endpoint:

```
GET /api/events
```

- Requires session cookie (`petritype_session`)
- One connection per user (new connection evicts previous)
- Keepalive comments every 30s
- Auto-reconnect with backoff on both sides

Event shape:

```
event: <event_type>
data: {"type": "<event_type>", ...payload}
```

---

## Phase 1 — Frontend log viewer + provisioning progress

Uses only existing backend infrastructure. No backend changes needed.

### Tasks

- [x] **Expandable log viewer component** — reusable `LogViewer.svelte`
  - Collapsed: small "Logs" bar with chevron at bottom of each worker card
  - Expanded: terminal-style viewer (~200px), dark theme (`bg-[#1a1a2e]`, `text-[#c8c8d0]`), scrollable, auto-scroll to bottom
  - "Open in new tab" button that links to `/workers/[id]/logs`
  - Reuse for both net load logs and future worker runtime logs

- [x] **Full-page log route** — `src/routes/(app)/workers/[id]/logs/+page.svelte`
  - Same terminal style, full viewport
  - Shows worker name/status header + scrollable log output

- [x] **Provisioning progress indicator**
  - Use existing `worker_state_changed` SSE events to show progress steps
  - Map state transitions to human-readable steps: "Creating machine..." → "Waiting for health check..." → "Ready"
  - Display as "Step n/m" with a spinner during provisioning

- [x] **Wire net load logs into the new LogViewer**
  - Move existing inline `net_load_log` terminal viewer into the new `LogViewer` component
  - Net load logs appear inside the worker's log viewer, scoped by net name

- [x] **Load error display**
  - Already implemented: `load_error` shown as error banner when `load_state === 'error'`
  - Ensure it also appears as the final line in the log viewer

---

## Phase 2 — Backend: net load error propagation

Ensure `load_error` is populated by the backend so the frontend can display it.

### Tasks

- [ ] **Add `load_error` column** to the `nets` table (nullable text) — already exists in schema
- [ ] **Capture the error** when the worker reports a failed load (import error traceback) and write it to `load_error`
- [ ] **Clear `load_error`** when `load_state` transitions to `unloaded` or `loaded`
- [ ] **Include `load_error`** in all API responses that return `Net` objects (`GET /api/nets`, `GET /api/nets/:id`, etc.)

### Frontend type support (done)

The `Net` interface in `src/lib/api.ts` already includes:

```typescript
load_state: 'unloaded' | 'loaded' | 'error';
load_error: string | null;
```

---

## Phase 3 — Backend: worker runtime log streaming

Stream stdout/stderr from running workers to the frontend in real time.

### Backend tasks

- [ ] **Worker-side log capture** — capture stdout/stderr into a ring buffer in the worker process
- [ ] **Worker log endpoint** — add `GET /logs` SSE endpoint to worker server (`petritype_server/worker/server.py`) that tails the ring buffer
- [ ] **Control plane proxy** — add `GET /api/workers/{worker_id}/logs` that proxies the worker's `/logs` SSE stream to the frontend
  - Authenticate via session cookie
  - Look up worker URL from DB (same pattern as execution proxy)
  - Forward SSE events to the browser

### Frontend tasks

- [ ] **Connect LogViewer to runtime log endpoint** — when the log viewer is expanded for a worker, open an EventSource to `/api/workers/{worker_id}/logs`
- [ ] **Disconnect on collapse** — close the EventSource when the viewer is collapsed to avoid unnecessary connections
- [ ] **Merge log streams** — interleave net load logs and runtime logs in the same viewer, visually distinguished (e.g., different prefix or colour)

### Alternative: Fly Machines Logs API

Instead of the worker-side approach, the control plane could proxy Fly's NATS-based log stream. This gives all machine stdout/stderr (including system output) without modifying the worker server. Trade-off: less control over formatting, includes noise from the runtime itself.

---

## Phase 4 — Backend: granular provisioning logs (optional)

Currently provisioning only emits state transitions (`pending` → `provisioning` → `ready`/`error`). This phase adds step-by-step log lines.

### Backend tasks

- [ ] **Make provisioning async** — `POST /api/workers/{worker_id}/provision` returns immediately, provisioning runs in background
- [ ] **Add `worker_provision_log` SSE event type** — same shape as `net_load_log`:
  ```json
  {
    "type": "worker_provision_log",
    "worker_id": "uuid",
    "step": "create_machine" | "wait_start" | "health_check",
    "message": "Creating Fly Machine in lhr..."
  }
  ```
- [ ] **Emit from lifecycle.py** — add notify calls at each step in `_provision_fly_machine` / `_provision_sprite`

### Frontend tasks

- [ ] **Add `worker_provision_log` to `ServerEvent` type** in `serverEvents.ts`
- [ ] **Stream provisioning logs into LogViewer** — replace the step counter from Phase 1 with real log lines when available

---

## Event Types Summary

| Event | Phase | Status | Key fields |
|-------|-------|--------|------------|
| `worker_state_changed` | — | Implemented | `worker_id`, `status`, `status_detail` |
| `net_state_changed` | — | Implemented | `net_id`, `load_state` |
| `net_load_log` | — | Implemented | `net_id`, `step`, `message` |
| `load_error` (REST) | 2 | Pending | `net_id`, `load_error` |
| Runtime logs (SSE) | 3 | Not started | `worker_id`, `message` |
| `worker_provision_log` | 4 | Not started | `worker_id`, `step`, `message` |

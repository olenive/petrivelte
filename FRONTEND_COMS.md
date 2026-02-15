# Frontend Communication & State Management Plan

## Problem

Worker and net states displayed in the UI can become stale. A worker may show "Ready" after its Fly machine has crashed. Net load states may show "Loaded" when the worker is gone. Actions (Stop, Load, Unload) fail with confusing errors when the underlying state has changed.

## Goals

1. Keep displayed worker/net state in sync with reality
2. Inform users when state changes unexpectedly (e.g., worker went down)
3. Prevent actions on stale state
4. Avoid DDoS risk from polling

---

## State Model

### Worker States
| State | Meaning | Allowed net actions |
|-------|---------|-------------------|
| `pending` | Record created, no machine | None |
| `provisioning` | Machine being created | None |
| `ready` | Machine confirmed running | Load, Unload, Assign, Unassign |
| `stopped` | Intentionally stopped (persistent) | Assign, Unassign only |
| `error` | Machine unreachable or gone | None (must re-provision) |

### Net Load States
| State | Meaning | Shown when |
|-------|---------|-----------|
| `unloaded` | Not loaded on worker | Worker exists but net isn't active |
| `loaded` | Confirmed active on worker | Worker is ready and net is running |
| `error` | Load failed or worker unreachable | Something went wrong |

### Valid Combinations
- Worker `pending`/`provisioning`/`stopped`/`error` → all assigned nets MUST be `unloaded`
- Worker `ready` → nets can be `unloaded`, `loaded`, or `error`
- If worker transitions from `ready` to anything else → all nets reset to `unloaded`

---

## Changes Required

### 1. Listen for Server-Sent Events (SSE)

The backend will provide an SSE endpoint (`GET /api/events`) that pushes state change notifications. The frontend should:

- **Create `src/lib/stores/serverEvents.ts`** - a new store that manages an SSE connection
- Connect on app load (in `+layout.svelte`) when the user is authenticated
- Reconnect automatically on disconnect (with backoff)
- Parse incoming events and expose them as a Svelte store
- Disconnect on logout

**Event types the frontend should handle:**
```typescript
type ServerEvent =
  | { type: 'worker_state_changed'; worker_id: string; status: string }
  | { type: 'net_state_changed'; net_id: string; load_state: string }
```

**When an event arrives:**
- On the **workers page**: refresh the workers list and/or net list to pick up new state
- On the **main page**: refresh `availableNets` to update load state badges and checklist
- Optionally show a toast/notification for unexpected changes (e.g., worker went to `error`)

### 2. Periodic Polling on Workers Page

As a fallback (SSE may disconnect, events may be missed), poll for fresh state on the workers page:

- **Poll interval: 30 seconds** — good balance of freshness vs server load
- **Only poll when the workers page is active** — use `onMount`/`onDestroy` to start/stop
- **Pause when tab is hidden** — use `document.visibilitychange` to stop polling when the user switches tabs, resume when they return
- **Poll endpoint**: just call the existing `GET /api/workers` and `GET /api/nets` endpoints (same as initial page load)
- **On the main page**: no periodic polling needed (SSE covers it, and the user will trigger refreshes via interactions)

**DDoS prevention measures:**
- 30s minimum interval (not configurable by the client to go lower)
- Stop polling on `visibilitychange` → `hidden`
- The backend rate-limits at 30 requests/min per user per endpoint (see BACKEND_COMS.md)
- Only one poll in-flight at a time (skip if previous hasn't returned)
- SSE-triggered refreshes are debounced (500ms) to coalesce event bursts (e.g., worker crash + multiple net resets) into a single API call pair

### 3. Pre-Action State Refresh

Before performing any worker or net action, refresh the relevant state to catch staleness:

**Workers page — wrap action handlers:**
- Before `handleLoadNet(netId)`: refresh nets, check `net.load_state` is still not `loaded` and worker is still `ready`
- Before `handleUnloadNet(netId)`: refresh nets, check `net.load_state` is still `loaded` and worker is still `ready`
- Before `handleStop(workerId)`: refresh workers, check worker is still `ready`
- Before `handleStart(workerId)`: refresh workers, check worker is still `stopped`
- Before `handleDestroyResource(workerId)`: refresh workers, check worker is still `ready` or `stopped`
- Before `handleAssignNet`/`handleUnassignNet`: refresh nets to confirm current assignment state

**If pre-check fails:**
- Show an error message like "Worker state has changed — it is now [status]. Please review before retrying."
- Do NOT proceed with the action
- The refreshed data will already be displayed (since we just fetched it)

**Main page:**
- Before `handleLoadNet`/`handleUnloadNet`: refresh `availableNets`, verify state hasn't changed

### 4. Graceful Error Handling for Failed Actions

Even with pre-checks, actions can still fail (race conditions). When an action fails:

- Catch the error as currently done
- **Additionally refresh** the relevant worker/net state so the UI shows the new reality
- Show a user-friendly error: not just "Failed to stop worker" but include context like "The worker may no longer be available"

### 5. UI Indicators

**Already implemented (from previous changes):**
- Net load state badges (Loaded/Unloaded/Error) with color coding
- Conditional Load/Unload buttons based on load state
- Setup checklist using real `load_state`

**Additional (optional, lower priority):**
- Show a subtle "last refreshed" timestamp on the workers page
- Briefly highlight rows that changed after a refresh/SSE update

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src/lib/stores/serverEvents.ts` | **New file** — SSE connection store |
| `src/routes/+layout.svelte` | Connect SSE on auth, disconnect on logout |
| `src/routes/workers/+page.svelte` | Add polling (30s + visibility), pre-action checks, SSE listener |
| `src/routes/+page.svelte` | SSE listener to refresh `availableNets`, pre-action checks on load/unload |

---

## Sequence Diagram: Typical Flow

```
User opens workers page
  → GET /api/workers + GET /api/nets (initial load)
  → SSE connection established (if not already from layout)
  → Start 30s poll timer

[Every 30s, if tab visible]
  → GET /api/workers + GET /api/nets
  → Update UI with any changes

[Backend detects worker crash]
  → SSE push: { type: 'worker_state_changed', worker_id: '...', status: 'error' }
  → Frontend receives event
  → Refresh workers + nets
  → UI updates: worker shows "error", nets show "unloaded"

[User clicks "Load" on a net]
  → Refresh nets (pre-check)
  → Verify net.load_state !== 'loaded' AND worker.status === 'ready'
  → If stale: show message, abort
  → If valid: POST /api/nets/{id}/load
  → On success: refresh nets
  → On failure: show error + refresh nets
```

# Architecture Decision: WebSocket vs SSE for Real-Time Communication

**Date:** 2026-01-23
**Status:** Accepted
**Decision Makers:** Development Team

## Context

Petrivelt frontend needs real-time communication with petritype-server to:
- Receive initial graph state (places, transitions, edges, tokens)
- Get live updates when transitions fire
- Display smooth token animations
- Update execution log
- Send commands (future: manual transition firing)

The server initially had only SSE (Server-Sent Events) at `/graphs/{graph_id}/events` which sent minimal state change notifications.

## Options Considered

### Option 1: Server-Sent Events (SSE) + REST API

**Architecture:**
```
Frontend → REST: GET /graphs/{graph_id}/visualization (initial load)
Frontend ← SSE: /graphs/{graph_id}/events (state change notifications)
Frontend → REST: GET /visualization (on state change)
Frontend → REST: POST /graphs/{graph_id}/step (commands)
```

**Pros:**
- Server already has SSE endpoint
- Simple HTTP-based
- Automatic reconnection

**Cons:**
- Multiple round trips for updates (SSE notification → REST fetch)
- Cannot push full graph/animation data efficiently
- One-way communication (client commands need separate HTTP requests)
- Higher latency and more network overhead

### Option 2: WebSocket (Chosen)

**Architecture:**
```
Frontend ↔ WebSocket: ws://localhost:8000/ws
  → Server sends full graph state on connect
  → Server pushes transition_fired events with animation data
  → Client can send commands on same connection
```

**Pros:**
- **Bidirectional communication** on single connection
- **Lower latency** - server pushes updates immediately
- **More efficient** - no polling or repeated REST calls
- **Better for animations** - can send detailed token movement data
- **Matches original design** - all design docs assumed WebSocket
- **Cleaner architecture** - single connection for all real-time data

**Cons:**
- Need to implement WebSocket endpoint in server
- Manual reconnection logic (already implemented in frontend)

## Decision

**We chose WebSocket (Option 2)** for the following reasons:

1. **Real-Time Visualization Requirements**
   - Token animations need detailed movement data (from position, to position)
   - Execution log needs full transition details
   - Low latency is important for smooth user experience

2. **Architectural Fit**
   - Original design documents (SVELTE_DESIGN.md, GETTING_STARTED.md) assumed WebSocket
   - Frontend already implements WebSocket store with reconnection logic
   - Bidirectional communication enables future features (manual firing, pause/resume)

3. **Efficiency**
   - Single connection vs multiple HTTP requests
   - Server can push rich data immediately
   - Reduces network overhead and latency

4. **Developer Experience**
   - Simpler mental model: one connection, all data flows through it
   - Easier to debug: all messages in one WebSocket stream
   - Better matches expectations from design phase

## Implementation

### Frontend (Already Complete)
- WebSocket store at `frontend/src/lib/stores/webSocket.ts`
- Auto-reconnection logic
- Message type handling for `graph_state` and `transition_fired`

### Backend (To Be Implemented)
- Add WebSocket endpoint at `/ws`
- Send `graph_state` message on connection
- Broadcast `transition_fired` messages when transitions execute
- Include animation data (token movements, positions)

### Message Protocol

**graph_state** (sent on connect):
```json
{
  "type": "graph_state",
  "data": {
    "places": [...],
    "transitions": [...],
    "edges": [...]
  }
}
```

**transition_fired** (sent on transition execution):
```json
{
  "type": "transition_fired",
  "transition_name": "T1",
  "tokens_moved": [
    {
      "id": "tok_1",
      "from_place": "P1",
      "to_place": "P2",
      "from_pos": {"x": 100, "y": 100},
      "to_pos": {"x": 300, "y": 100},
      "color": "#ff6b6b",
      "data": {...}
    }
  ],
  "log_entry": {
    "timestamp": 1234567890.123,
    "transition": "T1",
    "duration_ms": 42,
    "inputs": {"ball": ["tok_1"]},
    "outputs": ["tok_1"]
  },
  "new_token_positions": [...]
}
```

## Consequences

### Positive
- Clean, efficient real-time communication
- Frontend and backend design align
- Better user experience (lower latency)
- Enables future interactive features

### Negative
- Requires server-side changes (acceptable cost)
- Need to maintain WebSocket connection state

### Neutral
- Both SSE and WebSocket would work; this is the better choice for our use case
- SSE endpoint can remain for other use cases if needed

## References
- Frontend: `frontend/src/lib/stores/webSocket.ts`
- Backend: `petritype-server/petritype_server/server.py`
- Design: `SVELTE_DESIGN.md`, `GETTING_STARTED.md`
- Issue: 403 Forbidden error attempting WebSocket connection (because endpoint didn't exist)

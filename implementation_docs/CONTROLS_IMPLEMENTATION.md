# Execution Controls Implementation

**Date:** 2026-01-23
**Status:** Implemented

## What Was Added

### Frontend Controls

Added execution controls to the header with the following features:

#### 1. Graph Selection Dropdown
- Lists all available graphs from backend
- Allows switching between graphs
- Auto-selects first graph on load
- Clears current state when switching

#### 2. Execution State Display
- Shows "▶ Running" when continuous execution is active
- Shows "⏸ Stopped" when paused
- Visual indicator with color coding

#### 3. Control Buttons

**Step Button**
- Executes exactly one transition
- Calls: `POST /graphs/{graph_id}/step`
- Disabled when continuous execution is running
- Disabled when no graph selected

**Run/Stop Button**
- Toggles between "Run" and "Stop"
- **Run**: Starts continuous execution (100ms interval)
  - Calls: `POST /graphs/{graph_id}/start`
  - Button changes to "Stop" with red styling
- **Stop**: Stops continuous execution
  - Calls: `POST /graphs/{graph_id}/stop`
  - Button changes to "Run" with blue styling
- Always enabled when graph is selected

**Run All Button**
- Executes all transitions until completion
- Calls: `POST /graphs/{graph_id}/run-all`
- Synchronous operation (waits for completion)
- Disabled when continuous execution is running
- Disabled when no graph selected

### Backend Changes

#### CORS Middleware Added
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Allows frontend to make REST API calls to backend endpoints.

## Implementation Details

### State Management

```typescript
let availableGraphs: Array<{ graph_id: string; is_running: boolean }> = [];
let selectedGraphId: string | null = null;
let isRunning = false;
```

### Fetching Available Graphs

```typescript
async function fetchGraphs() {
    const response = await fetch('http://localhost:8000/graphs');
    const data = await response.json();
    availableGraphs = data.graphs.map((g: any) => ({
        graph_id: g.graph_id,
        is_running: g.is_running
    }));
    // Auto-select first graph
}
```

Polls every 2 seconds to keep graph list updated.

### Button Handlers

**Step:**
```typescript
async function handleStep() {
    await fetch(`http://localhost:8000/graphs/${selectedGraphId}/step`, {
        method: 'POST'
    });
}
```

**Run/Stop:**
```typescript
async function handleRunStop() {
    const endpoint = isRunning ? 'stop' : 'start';
    await fetch(`http://localhost:8000/graphs/${selectedGraphId}/${endpoint}`, {
        method: 'POST'
    });
    isRunning = !isRunning;
    await fetchGraphs(); // Refresh state
}
```

**Run All:**
```typescript
async function handleRunAll() {
    await fetch(`http://localhost:8000/graphs/${selectedGraphId}/run-all`, {
        method: 'POST'
    });
    await fetchGraphs(); // Refresh after completion
}
```

### Graph Selection

```typescript
function handleGraphSelect(event: Event) {
    selectedGraphId = target.value;
    const graph = availableGraphs.find(g => g.graph_id === selectedGraphId);
    if (graph) {
        isRunning = graph.is_running;
    }
    // Clear current state
    graphState = null;
    tokens = [];
    logEntries = [];
}
```

## UI Design

### Header Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ Petrivelt  [Connected ✓]  │  Graph: [coloured_balls ▼]  │          │
│                             │  [⏸ Stopped]                │          │
│                             │  [Step] [Run] [Run All]     │          │
└─────────────────────────────────────────────────────────────────────┘
```

### Button States

**Normal State:**
- Step: Blue border, enabled
- Run: Blue border, enabled
- Run All: Blue border, enabled

**Running State:**
- Step: Grayed out, disabled
- Stop: Red border, enabled
- Run All: Grayed out, disabled

### Visual Feedback

- **Execution State Badge:**
  - Stopped: Gray background, "⏸ Stopped"
  - Running: Blue background, "▶ Running"

- **Buttons:**
  - Hover: Fill with color
  - Disabled: 50% opacity, gray
  - Stop button: Red border and text

## Testing

### Test Scenarios

1. **Single Step Execution:**
   - Create graph (stopped)
   - Click "Step"
   - Verify one transition fires
   - Graph stays stopped

2. **Continuous Execution:**
   - Click "Run"
   - Button changes to "Stop"
   - State shows "▶ Running"
   - Step and Run All disabled
   - Transitions fire automatically
   - Click "Stop"
   - Execution stops
   - Button changes to "Run"

3. **Run All:**
   - Graph in stopped state
   - Click "Run All"
   - All transitions execute
   - Graph returns to stopped state

4. **Graph Switching:**
   - Create multiple graphs
   - Select different graph from dropdown
   - Display updates to show new graph
   - Controls work on selected graph

## REST Endpoints Used

- `GET /graphs` - List all graphs
- `POST /graphs/{graph_id}/step` - Execute one transition
- `POST /graphs/{graph_id}/start` - Start continuous execution
- `POST /graphs/{graph_id}/stop` - Stop continuous execution
- `POST /graphs/{graph_id}/run-all` - Execute all transitions

## Future Enhancements

- [ ] Add transition selector (manual firing of specific transitions)
- [ ] Add execution speed control (adjust 100ms interval)
- [ ] Add reset button to restore initial state
- [ ] Show transition count / transitions per second
- [ ] Add keyboard shortcuts (Space = Run/Stop, S = Step)
- [ ] Visual progress indicator for "Run All"
- [ ] Confirmation dialog for destructive actions
- [ ] Remember selected graph in localStorage

## Files Modified

### Frontend
- `frontend/src/routes/+page.svelte` - Added controls, state, handlers

### Backend
- `petritype_server/server.py` - Added CORS middleware

## Dependencies

No new dependencies - uses existing REST endpoints and browser Fetch API.

---

**The frontend now has full execution control!** 🎮

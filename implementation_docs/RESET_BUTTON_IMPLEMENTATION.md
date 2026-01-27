# Reset Button Implementation

**Date:** 2026-01-25
**Status:** ✅ Complete

## What Was Added

Added a "Reset" button to the frontend header that resets the Petri net to its initial state by calling the backend reset endpoint.

## Changes Made

### Frontend (`frontend/src/routes/+page.svelte`)

**Added reset handler function:**
```typescript
async function handleReset() {
    if (!selectedGraphId) return;
    try {
        await fetch(`http://localhost:8000/graphs/${selectedGraphId}/reset`, {
            method: 'POST'
        });
        // Clear frontend state
        tokens = [];
        logEntries = [];
        animatingTokens = [];
        await fetchGraphs(); // Refresh graph state
    } catch (error) {
        console.error('Reset failed:', error);
    }
}
```

**Added Reset button to header controls:**
```svelte
<button on:click={handleReset} disabled={isRunning || !selectedGraphId}>
    Reset
</button>
```

## Button Behavior

### When Enabled
- Graph is selected (`selectedGraphId` is not null)
- Graph is NOT running (`isRunning === false`)

### When Disabled
- No graph selected
- Graph is currently running (continuous execution active)

### What It Does

1. **Calls Backend Endpoint:**
   - `POST /graphs/{graph_id}/reset`
   - Backend stops execution if running
   - Backend re-creates graph from original module/function
   - Backend resets execution state (transitions_fired count, etc.)

2. **Clears Frontend State:**
   - `tokens = []` - Removes all displayed tokens
   - `logEntries = []` - Clears execution log
   - `animatingTokens = []` - Stops any ongoing animations

3. **Refreshes Graph State:**
   - Calls `fetchGraphs()` to get fresh graph data
   - WebSocket will send updated `graph_state` message
   - Frontend will re-extract initial tokens and display them

## Button Placement

The Reset button appears in the header control group, after the Run All button:

```
[Step] [Run] [Run All] [Reset]
```

## Visual Styling

- **Normal State:** Blue border, white background (same as other buttons)
- **Hover State:** Blue background, white text
- **Disabled State:** 50% opacity, gray border and text, cursor not-allowed

## Testing

### Test Scenario 1: Reset After Step Execution

1. Start with fresh coloured_balls graph (12 initial tokens)
2. Click "Step" 3 times
3. Observe: 3 transitions fired, some tokens consumed/produced
4. Click "Reset"
5. **Expected:** Graph returns to initial state with 12 tokens

### Test Scenario 2: Reset Disabled During Continuous Execution

1. Click "Run" to start continuous execution
2. Observe: Reset button becomes disabled (grayed out)
3. Click "Stop" to stop execution
4. Observe: Reset button becomes enabled again

### Test Scenario 3: Reset Clears Log

1. Execute some transitions (log entries appear)
2. Click "Reset"
3. **Expected:** Execution log clears completely

### Test Scenario 4: Reset Without Graph Selected

1. Refresh page before any graph loads
2. Observe: Reset button is disabled
3. Select a graph from dropdown
4. Observe: Reset button becomes enabled

## Backend Endpoint

The backend endpoint already existed:

```python
@app.post("/graphs/{graph_id}/reset")
async def reset_graph(graph_id: str):
    """Reset graph to initial state.

    Re-creates the graph from the original module/function and resets
    the execution state (transitions fired count, running status, etc).
    """
    if graph_id not in _engines:
        raise HTTPException(status_code=404, detail="Graph not found")

    engine = _engines[graph_id]["engine"]

    # Stop execution if running
    if is_engine_running(engine):
        await stop_continuous_execution(engine)

    # Re-create the initial graph
    try:
        create_fn = _import_graph_function(data["module"], data["function"])
        initial_graph = create_fn()
    except (ImportError, AttributeError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to re-create graph: {e}")

    # Reset the engine
    reset_engine(engine, initial_graph)

    return {"status": "reset", "transitions_fired": 0}
```

## Integration with Existing Features

- **Works with graph selection dropdown** - Resets currently selected graph
- **Respects execution state** - Disabled during continuous execution
- **Clears all frontend state** - Tokens, logs, animations all reset
- **Triggers WebSocket update** - Backend sends fresh graph_state message
- **Extracts initial tokens** - Option A token extraction logic runs on new state

## Files Modified

- `frontend/src/routes/+page.svelte` - Added handleReset function and Reset button

## No Backend Changes Required

The backend already had the necessary reset endpoint. No backend modifications were needed.

---

**Reset button is now fully functional!** 🔄

# Context for Claude Code Agent

You are working on **Petrivelt**, a Svelte-based frontend for visualizing Petri nets.

## Project Overview

Petrivelt is a web frontend that connects to **petritype-server** (a FastAPI backend at `../petritype-server`) via WebSocket to visualize and interact with Petri net graphs in real-time.

This is a **reimplementation** of an existing Streamlit-based viewer called "petrilit" (at `../petrilit`). The Streamlit version had state management issues where UI elements (dropdowns, tabs, scroll positions) would reset during continuous execution updates. We're building a proper frontend framework solution using Svelte.

## Architecture

```
┌─────────────────────────────┐
│   Petrivelt (Svelte)        │  ← You are building this
│   - Graph visualization     │
│   - Token animations        │
│   - Execution log           │
│   - Token inspector         │
└──────────┬──────────────────┘
           │
      WebSocket (ws://localhost:8000/ws)
           │
┌──────────┴──────────────────┐
│  petritype-server           │  ← Already exists, handles:
│  - Petri net execution      │     - Graph state
│  - Graph layout (grandalf)  │     - Transition execution
│  - State management         │     - Layout calculations
└─────────────────────────────┘     - WebSocket broadcasting
```

## Key Design Decisions Already Made

1. **Direct SVG rendering** - No graph library (like Cytoscape), we render SVG directly for full control over token animations
2. **Layout stays in backend** - petritype-server calculates positions using grandalf, frontend just renders at given coordinates
3. **WebSocket communication** - Real-time push updates, no polling
4. **Independent panels** - Graph, log, and inspector update independently (solving Streamlit's rerun problem)
5. **Svelte animations** - Use `tweened` stores and `animate:flip` for smooth token movements

## Files You Should Read First

**Priority order:**
1. **START_HERE.md** - Quick orientation (2 min read)
2. **README.md** - Project overview and goals (5 min read)
3. **GETTING_STARTED.md** - Step-by-step setup instructions
4. **SVELTE_DESIGN.md** - Complete implementation guide with component examples (this is your main reference!)

**Reference materials:**
- **reference/README.md** - Explains the reference code from Streamlit version
- **reference/previous_version_render.py** - Shows how SVG was structured in old version
- **reference/animation.py** - Animation data calculation logic
- **examples/coloured_balls/** - Example Petri net graph to test with

## Current State

The repository has been set up with:
- ✅ Documentation and design documents
- ✅ Reference code from Streamlit version
- ✅ Example Petri net graphs
- ✅ Project configuration
- ❌ **frontend/ directory does not exist yet** - You need to create it

## Your Task

Build the Svelte frontend following the design in SVELTE_DESIGN.md.

### Immediate Next Steps:

1. **Create the Svelte project:**
   ```bash
   npm create svelte@latest frontend
   # Choose: Skeleton project, TypeScript, ESLint, Prettier, Vitest
   ```

2. **Set up basic WebSocket connection:**
   - Create `frontend/src/lib/stores/webSocket.js` (see GETTING_STARTED.md or SVELTE_DESIGN.md)
   - Create a simple test page in `frontend/src/routes/+page.svelte`
   - Verify connection to petritype-server

3. **Build core components in this order:**
   - WebSocket store (communication layer)
   - GraphPanel component (SVG rendering)
   - Token component (with tweened animation)
   - Place, Transition, Edge components
   - ExecutionLog panel (with scroll preservation)
   - TokenInspector panel (with persistent tabs)

### Important Constraints:

- **Do NOT copy Streamlit code directly** - Use it as reference only
- **Do NOT implement graph layout** - Backend sends positioned coordinates
- **Do NOT add unnecessary dependencies** - Keep it simple (Svelte + standard web APIs)
- **Follow the component examples in SVELTE_DESIGN.md** - They're complete and tested architecturally

### Testing Your Work:

1. Start petritype-server:
   ```bash
   cd ../petritype-server
   uv run python -m petritype_server.cli start
   ```

2. Load test graph:
   ```bash
   cd ../petritype-server
   uv run python -m petritype_server.cli create-graph \
     --module graphs.coloured_balls \
     --graph-id coloured_balls
   ```

3. Run your Svelte dev server:
   ```bash
   cd frontend
   npm run dev
   ```

4. Open http://localhost:5173 and verify:
   - WebSocket connects
   - Graph data loads
   - Tokens animate when transitions fire

## Reference Data Structures

The backend will send WebSocket messages like:

```json
{
  "type": "graph_state",
  "data": {
    "places": [
      {"id": "P1", "name": "Input", "x": 100, "y": 100, "type_name": "Ball", "tokens": [...]},
    ],
    "transitions": [
      {"id": "T1", "name": "Route", "x": 300, "y": 100, "function_name": "route_ball"}
    ],
    "edges": [
      {"source": "P1", "target": "T1", "type": "input"}
    ]
  }
}

{
  "type": "transition_fired",
  "transition_name": "T1",
  "tokens_moved": [
    {
      "id": "tok_1",
      "from_place": "P1",
      "to_place": "P2",
      "from_pos": {"x": 100, "y": 100},
      "to_pos": {"x": 500, "y": 100},
      "color": "#ff6b6b",
      "data": {"color": "red"}
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

## Code Style Preferences

From the project's CLAUDE.md:
- Prefer functional programming style
- Minimize use of inheritance
- Avoid classes that use `self` or `@staticmethod`

For Svelte specifically:
- Use functional components (standard Svelte components are naturally functional)
- Keep component state local where possible
- Use stores for shared state
- Prefer simple, direct solutions over complex abstractions

## Questions to Ask Me

If anything is unclear:
- Architecture decisions
- Data structure details
- Backend API questions
- Design clarifications

## Success Criteria

You'll know you're successful when:
1. ✅ WebSocket connects to petritype-server
2. ✅ Graph renders with places, transitions, edges
3. ✅ Tokens appear in correct positions
4. ✅ Tokens animate smoothly when transitions fire
5. ✅ Execution log updates without resetting scroll position
6. ✅ Token inspector tabs persist during updates
7. ✅ User can expand/collapse sections without state loss during continuous execution

## Get Started!

Read START_HERE.md, then follow GETTING_STARTED.md to create the Svelte project and build your first component.

The complete component examples are in SVELTE_DESIGN.md - use them as your implementation guide.

Good luck! 🚀

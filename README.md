# Petrivelt

A **Svelte-based frontend** for visualizing and interacting with Petri nets running on [petritype-server](../petritype-server).

## Project Status

🚧 **In Development** - Setting up the Svelte frontend

## Architecture

```
┌─────────────────────────────┐
│   Petrivelt (Svelte)        │
│   - Graph visualization     │
│   - Token animations        │
│   - Execution log           │
│   - Token inspector         │
└──────────┬──────────────────┘
           │
      WebSocket
           │
┌──────────┴──────────────────┐
│  petritype-server (FastAPI) │
│  - Petri net engine         │
│  - Graph execution          │
│  - State management         │
└─────────────────────────────┘
```

## Design Goals

1. **Independent panel updates** - Graph, log, and inspector panels update independently
2. **State persistence** - UI state (collapsed sections, selected tabs, scroll position) preserved during continuous execution
3. **Smooth animations** - Token movements between places with CSS/Svelte animations
4. **Real-time updates** - WebSocket push updates, no polling

See [SVELTE_DESIGN.md](./SVELTE_DESIGN.md) for detailed architecture and implementation plan.

## Prerequisites

1. **Backend**: [petritype-server](../petritype-server) must be running
   ```bash
   cd ../petritype-server
   uv run python -m petritype_server.cli start
   ```

2. **Node.js**: Version 18+ required for Svelte/SvelteKit
   ```bash
   node --version  # Should be v18 or higher
   ```

## Setup

### 1. Install Frontend Dependencies (Coming Soon)

Once the Svelte project is initialized:

```bash
cd frontend
npm install
npm run dev
```

The dev server will run at `http://localhost:5173`

### 2. Connect to Backend

The frontend connects to `ws://localhost:8000/ws` by default. Make sure petritype-server is running on port 8000.

## Project Structure

```
petrivelt/
├── README.md                          # This file
├── SVELTE_DESIGN.md                   # Complete architecture and component examples
├── pyproject.toml                     # Python dev dependencies (optional)
│
├── reference/                         # Reference code from Streamlit version
│   ├── previous_version_render.py     # SVG generation example (from Streamlit)
│   ├── animation.py                   # Animation logic reference
│   └── layout.py                      # Graph layout reference
│
├── examples/                          # Example Petri net graphs
│   ├── coloured_balls/                # Main example: colored ball routing
│   └── toy/                           # Simple toy example
│
├── tests/                             # Tests copied from petrilit
│   ├── test_animation.py
│   ├── test_layout.py
│   └── test_render.py
│
└── frontend/                          # (To be created) SvelteKit app
    ├── src/
    │   ├── lib/
    │   │   ├── components/            # Svelte components
    │   │   │   ├── GraphPanel.svelte
    │   │   │   ├── Token.svelte
    │   │   │   ├── ExecutionLog.svelte
    │   │   │   └── TokenInspector.svelte
    │   │   └── stores/
    │   │       └── webSocket.js       # WebSocket store
    │   └── routes/
    │       └── +page.svelte           # Main app page
    ├── package.json
    └── vite.config.js
```

## Development Workflow

### Creating the Svelte Frontend

```bash
# Inside petrivelt directory
npm create svelte@latest frontend

# Choose:
# - Skeleton project
# - TypeScript (recommended)
# - ESLint + Prettier (recommended)

cd frontend
npm install
npm run dev
```

### Running with petritype-server

**Terminal 1 - Backend:**
```bash
cd ../petritype-server
uv run python -m petritype_server.cli start
```

**Terminal 2 - Create test graph:**
```bash
cd ../petritype-server
uv run python -m petritype_server.cli create-graph --module graphs.coloured_balls --graph-id coloured_balls
```

**Terminal 3 - Frontend:**
```bash
cd petrivelt/frontend
npm run dev
```

Open `http://localhost:5173`

## Reference Materials

### previous_version_render.py

This file contains the SVG generation logic from the Streamlit version of Petrilit. **Note: This is NOT the implementation for Svelte** - it's provided as reference for:

- How SVG layers were structured (edges, places, transitions, tokens)
- Token positioning and stacking logic
- Animation data structure
- Pan/zoom implementation with localStorage

The Svelte version will generate similar SVG but using Svelte components and reactive stores.

### animation.py & layout.py

These files show how the backend calculates:
- Graph layout (using grandalf)
- Token movement animations
- Position calculations

The **layout logic will stay in the backend** - the frontend just receives positioned coordinates and renders them.

## Key Differences from Streamlit Version (petrilit)

| Feature | Streamlit (petrilit) | Svelte (petrivelt) |
|---------|---------------------|-------------------|
| **UI Framework** | Streamlit | SvelteKit |
| **Updates** | Server reruns Python code | WebSocket pushes JSON |
| **State Management** | Hacky workarounds with checkboxes | Native component state |
| **Rendering** | Server generates HTML string | Client-side reactive components |
| **Animations** | CSS transitions in injected SVG | Svelte animate directives + tweened stores |
| **Panel Independence** | All panels rerender together | Only changed components update |
| **Scroll Preservation** | Lost on rerun | Automatic |
| **Dropdown State** | Lost on rerun | Persists naturally |

## Learning Resources

- [Svelte Tutorial](https://svelte.dev/tutorial)
- [SvelteKit Docs](https://kit.svelte.dev/docs)
- [Svelte Animations](https://svelte.dev/examples/tweened)
- [WebSocket in Svelte](https://svelte.dev/repl/websocket-example)

## Related Projects

- **[petritype-server](../petritype-server)** - Backend Petri net execution engine
- **[petrilit](../petrilit)** - Original Streamlit-based viewer (still maintained)


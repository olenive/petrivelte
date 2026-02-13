# Petrivelt Frontend

A Svelte-based frontend for visualizing Petri nets from petritype-server.

## What's Been Implemented

### Core Components ✅

- **WebSocket Store** (`src/lib/stores/webSocket.ts`) - Real-time connection to petritype-server
- **Type Definitions** (`src/lib/types.ts`) - TypeScript types for graph data structures
- **GraphPanel** - Main SVG canvas with zoom/pan controls
- **Place** - Circle nodes representing Petri net places
- **Transition** - Rectangle nodes representing transitions
- **Edge** - Connecting lines between places and transitions
- **Token** - Animated circles that move between places (uses `tweened` stores)
- **ExecutionLog** - Scrollable log with preserved scroll position
- **TokenInspector** - Tabbed interface for viewing token data by place

### Features ✅

- ✅ WebSocket connection with auto-reconnect
- ✅ Real-time graph visualization
- ✅ Smooth token animations using Svelte's motion stores
- ✅ Independent panel updates (graph, log, inspector update separately)
- ✅ Persistent UI state (tabs, scroll, expanded sections)
- ✅ Zoom and pan controls
- ✅ TypeScript throughout

## Quick Start

### 1. Start the Backend

Make sure petritype-server is running:

```bash
cd ../petritype-server
uv run python -m petritype_server.cli start
```

### 2. Load a Test Graph

```bash
cd ../petritype-server
uv run python -m petritype_server.cli create-graph \
  --module graphs.coloured_balls \
  --graph-id coloured_balls
```

### 3. Run the Frontend

```bash
bun run dev
```

Open http://localhost:5173


### 4. Deploy to Fly.io
`fly deploy`


## Project Structure

```
frontend/
├── src/
│   ├── lib/
│   │   ├── components/
│   │   │   ├── GraphPanel.svelte       # Main SVG canvas
│   │   │   ├── Place.svelte           # Place nodes
│   │   │   ├── Transition.svelte      # Transition nodes
│   │   │   ├── Edge.svelte            # Edges between nodes
│   │   │   ├── Token.svelte           # Animated tokens
│   │   │   ├── ExecutionLog.svelte    # Log panel
│   │   │   └── TokenInspector.svelte  # Token data viewer
│   │   ├── stores/
│   │   │   └── webSocket.ts           # WebSocket connection
│   │   └── types.ts                   # TypeScript definitions
│   └── routes/
│       └── +page.svelte               # Main app
├── package.json
└── README.md
```

## Development

```bash
# Run dev server with hot reload
bun run dev

# Type check
bun run check

# Build for production
bun run build

# Preview production build
bun run preview
```

## What You Should See

When everything is working:

1. **Header** shows "Connected ✓" status
2. **GraphPanel** displays the Petri net graph
   - Places as circles
   - Transitions as rectangles
   - Edges connecting them
   - Tokens as colored circles
3. **ExecutionLog** panel (collapsible)
   - Shows transition executions
   - Scroll position preserved during updates
4. **TokenInspector** panel (collapsible)
   - Tabs for each place
   - Shows token data
   - Tab selection persists during updates

## Key Design Decisions

### Direct SVG Rendering
No graph library (like Cytoscape). We render SVG directly for full control over token animations.

### Backend Handles Layout
petritype-server calculates positions using grandalf. Frontend just renders at given coordinates.

### Functional Programming Style
- No classes with `self` or `@staticmethod`
- Components are naturally functional in Svelte
- Stores for shared state
- TypeScript for type safety

### Independent Panel Updates
Each component manages its own state. When tokens move:
- Only GraphPanel re-renders the tokens
- ExecutionLog preserves scroll position
- TokenInspector preserves tab selection

This solves the main problem with the Streamlit version where everything would reset during updates.

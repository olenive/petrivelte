# Petrilit Frontend with Svelte - Design Document

## Why Svelte for Petrilit

### Perfect Fit for Your Requirements

1. **Built-in Animations** - Svelte has the best animation primitives of any framework
   - `transition:` directive for enter/leave animations
   - `animate:` directive for position changes (perfect for tokens!)
   - `tweened` and `spring` stores for smooth value interpolation
   - CSS-based transitions work seamlessly

2. **Reactive by Default** - Clean, intuitive state management
   - `$:` reactive statements update automatically
   - No hooks, no useEffect complexity
   - State changes trigger only dependent components

3. **Less Boilerplate** - Most concise code of modern frameworks
   - Components are just `.svelte` files with HTML, JS, CSS
   - No virtual DOM overhead
   - Compiles to vanilla JS (fast runtime)

4. **Independent Updates** - Each component manages its own state
   - Changes propagate only to dependent components
   - Scroll positions preserved automatically
   - No "everything reruns" problem

### Svelte vs Streamlit for Independent Panels

**Streamlit:**
```python
# Fragment reruns → ALL elements recreate → state lost
@st.fragment
def live_graph_view():
    # Graph, log, tokens ALL rerender together
    # Scroll position lost
    # Expanders reset
```

**Svelte:**
```svelte
<!-- Each component updates independently -->
<GraphPanel {graphState} {tokens} {animatingTokens} />
<ExecutionLog {entries} />  <!-- Only updates when entries change -->
<TokenInspector {tokens} />

<!-- User scrolling in log? Graph doesn't care, doesn't rerender -->
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 Frontend (Svelte + SvelteKit)               │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  GraphPanel  │  │ ExecutionLog │  │TokenInspector│   │
│  │  .svelte     │  │  .svelte     │  │  .svelte     │   │
│  │              │  │              │  │              │   │
│  │ Direct SVG   │  │  Scrollable  │  │  Expandable  │   │
│  │ + animate:   │  │  Auto-scroll │  │  Tabs        │   │
│  │  directive   │  │  preserved   │  │  preserved   │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│         │                 │                 │              │
│         └─────────────────┴─────────────────┘              │
│                           │                                 │
│                    WebSocket Store                          │
│                    (webSocketStore.js)                      │
└───────────────────────────┼─────────────────────────────────┘
                            │
                     WebSocket (ws://)
                            │
┌───────────────────────────┼─────────────────────────────────┐
│                  Backend (Python + FastAPI)                 │
│                           │                                 │
│                    WebSocket Endpoint                       │
│                           │                                 │
│  ┌────────────────────────┴────────────────────────────┐  │
│  │              Petrilit Engine                        │  │
│  │                                                      │  │
│  │  - Graph state management                           │  │
│  │  - Transition execution                             │  │
│  │  - grandalf layout (unchanged)                      │  │
│  │  - Continuous execution loop                        │  │
│  │                                                      │  │
│  │  On transition fired:                               │  │
│  │    ws.broadcast({                                   │  │
│  │      type: 'transition_fired',                      │  │
│  │      transition_name: 'T1',                         │  │
│  │      tokens_moved: [                                │  │
│  │        {id: 'tok_1', from: 'P1', to: 'P2',         │  │
│  │         from_pos: {x: 100, y: 100},                │  │
│  │         to_pos: {x: 300, y: 100},                  │  │
│  │         data: {...}}                                │  │
│  │      ],                                             │  │
│  │      log_entry: {...},                              │  │
│  │      new_token_positions: [...]                     │  │
│  │    })                                               │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Svelte Component Examples

### 1. Main App Component

**`src/routes/+page.svelte`**
```svelte
<script>
  import { onMount } from 'svelte';
  import GraphPanel from '$lib/components/GraphPanel.svelte';
  import ExecutionLog from '$lib/components/ExecutionLog.svelte';
  import TokenInspector from '$lib/components/TokenInspector.svelte';
  import { webSocketStore } from '$lib/stores/webSocket';

  let graphState = null;
  let tokens = [];
  let animatingTokens = [];
  let logEntries = [];

  // Subscribe to WebSocket updates
  onMount(() => {
    const unsubscribe = webSocketStore.subscribe(message => {
      if (!message) return;

      if (message.type === 'graph_state') {
        graphState = message.data;
      }

      if (message.type === 'transition_fired') {
        // Update log (new entry at top)
        logEntries = [message.log_entry, ...logEntries];

        // Update token positions
        tokens = message.new_token_positions;

        // Track which tokens are animating
        animatingTokens = message.tokens_moved.map(t => t.id);

        // Clear animation markers after animation completes
        setTimeout(() => {
          animatingTokens = [];
        }, 500);
      }
    });

    return unsubscribe;
  });
</script>

<div class="app">
  <header>
    <h1>Petrilit</h1>
  </header>

  <main class="panels">
    <GraphPanel
      {graphState}
      {tokens}
      {animatingTokens}
    />

    <aside class="sidebar">
      <ExecutionLog entries={logEntries} />
      <TokenInspector {tokens} places={graphState?.places} />
    </aside>
  </main>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .panels {
    display: flex;
    flex: 1;
    gap: 1rem;
    padding: 1rem;
    overflow: hidden;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 400px;
  }
</style>
```

### 2. Graph Panel with Direct SVG

**`src/lib/components/GraphPanel.svelte`**
```svelte
<script>
  import { flip } from 'svelte/animate';
  import { fade } from 'svelte/transition';
  import Place from './Place.svelte';
  import Transition from './Transition.svelte';
  import Edge from './Edge.svelte';
  import Token from './Token.svelte';

  export let graphState;
  export let tokens;
  export let animatingTokens;

  let viewBox = "0 0 1000 800";
  let scale = 1;
  let panX = 0;
  let panY = 0;

  // Pan and zoom handlers
  function handleWheel(event) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    scale *= delta;
  }

  // Reactive statement - updates automatically when graphState changes
  $: if (graphState) {
    // Calculate viewBox to fit graph
    viewBox = `${panX} ${panY} ${1000 / scale} ${800 / scale}`;
  }
</script>

<div class="graph-container">
  <svg
    {viewBox}
    on:wheel={handleWheel}
    class="petri-net"
  >
    {#if graphState}
      <!-- Edges layer -->
      <g class="edges">
        {#each graphState.edges as edge (edge.id)}
          <Edge {...edge} />
        {/each}
      </g>

      <!-- Places layer -->
      <g class="places">
        {#each graphState.places as place (place.id)}
          <Place {...place} />
        {/each}
      </g>

      <!-- Transitions layer -->
      <g class="transitions">
        {#each graphState.transitions as transition (transition.id)}
          <Transition {...transition} />
        {/each}
      </g>

      <!-- Tokens layer -->
      <g class="tokens">
        {#each tokens as token (token.id)}
          <Token
            {...token}
            animating={animatingTokens.includes(token.id)}
            animate:flip={{ duration: 500 }}
          />
        {/each}
      </g>
    {/if}
  </svg>

  <div class="controls">
    <button on:click={() => scale = 1}>Reset Zoom</button>
    <button on:click={() => { panX = 0; panY = 0; }}>Center</button>
  </div>
</div>

<style>
  .graph-container {
    flex: 1;
    position: relative;
    border: 1px solid #ddd;
    border-radius: 8px;
    background: white;
    overflow: hidden;
  }

  svg {
    width: 100%;
    height: 100%;
  }

  .controls {
    position: absolute;
    top: 10px;
    right: 10px;
    display: flex;
    gap: 0.5rem;
  }
</style>
```

### 3. Token Component with Animation

**`src/lib/components/Token.svelte`**
```svelte
<script>
  import { tweened } from 'svelte/motion';
  import { cubicInOut } from 'svelte/easing';

  export let id;
  export let x;
  export let y;
  export let color;
  export let animating = false;

  // Tweened stores for smooth position interpolation
  const tweenedX = tweened(x, { duration: 500, easing: cubicInOut });
  const tweenedY = tweened(y, { duration: 500, easing: cubicInOut });

  // Update tweened values when position changes
  $: if (animating) {
    tweenedX.set(x);
    tweenedY.set(y);
  } else {
    tweenedX.set(x, { duration: 0 });
    tweenedY.set(y, { duration: 0 });
  }
</script>

<circle
  cx={$tweenedX}
  cy={$tweenedY}
  r={8}
  fill={color}
  class="token"
  class:animating
  data-token-id={id}
/>

<style>
  .token {
    stroke: #333;
    stroke-width: 1;
    cursor: pointer;
  }

  .token:hover {
    stroke-width: 2;
    stroke: #000;
  }

  .token.animating {
    filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.8));
  }
</style>
```

### 4. Execution Log with Preserved Scroll

**`src/lib/components/ExecutionLog.svelte`**
```svelte
<script>
  import { onMount, afterUpdate } from 'svelte';
  import { slide } from 'svelte/transition';

  export let entries = [];

  let expanded = false;
  let logContainer;
  let autoScroll = true;

  // Check if user is at bottom
  function checkScrollPosition() {
    if (!logContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainer;
    autoScroll = scrollTop + clientHeight >= scrollHeight - 10;
  }

  // Auto-scroll to bottom if enabled
  afterUpdate(() => {
    if (autoScroll && logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  });

  function toggleExpanded() {
    expanded = !expanded;
  }
</script>

<div class="execution-log">
  <button class="header" on:click={toggleExpanded}>
    <span class="arrow">{expanded ? '▼' : '▶'}</span>
    <strong>🔍 Execution Log</strong>
    <span class="count">({entries.length} entries)</span>
  </button>

  {#if expanded}
    <div
      class="log-content"
      bind:this={logContainer}
      on:scroll={checkScrollPosition}
      transition:slide
    >
      {#each entries as entry (entry.timestamp)}
        <div class="log-entry" transition:slide>
          <span class="timestamp">{entry.timestamp}</span>
          <span class="transition">{entry.transition}</span>
          <span class="duration">{entry.duration_ms}ms</span>
          <div class="details">
            {entry.inputs} → {entry.outputs}
          </div>
        </div>
      {/each}

      {#if entries.length === 0}
        <div class="empty">No transitions executed yet</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .execution-log {
    display: flex;
    flex-direction: column;
    border: 1px solid #ddd;
    border-radius: 8px;
    background: white;
    overflow: hidden;
    flex: 1;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    background: #f5f5f5;
    border: none;
    cursor: pointer;
    width: 100%;
    text-align: left;
  }

  .header:hover {
    background: #e8e8e8;
  }

  .arrow {
    font-size: 0.8em;
  }

  .count {
    margin-left: auto;
    color: #666;
    font-size: 0.9em;
  }

  .log-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
    max-height: 400px;
  }

  .log-entry {
    padding: 0.5rem;
    border-bottom: 1px solid #eee;
    font-family: monospace;
    font-size: 0.85em;
  }

  .timestamp {
    color: #666;
  }

  .transition {
    font-weight: bold;
    color: #0066cc;
  }

  .duration {
    color: #999;
    font-size: 0.9em;
  }

  .details {
    margin-top: 0.25rem;
    color: #333;
  }

  .empty {
    padding: 2rem;
    text-align: center;
    color: #999;
  }
</style>
```

### 5. Token Inspector with Tabs

**`src/lib/components/TokenInspector.svelte`**
```svelte
<script>
  import { slide } from 'svelte/transition';

  export let tokens = [];
  export let places = [];

  let expanded = false;
  let selectedPlaceIndex = 0;

  // Group tokens by place
  $: tokensByPlace = places?.map(place => ({
    place,
    tokens: tokens.filter(t => t.place_id === place.id)
  })) || [];

  // Keep selected index in bounds
  $: if (selectedPlaceIndex >= tokensByPlace.length) {
    selectedPlaceIndex = 0;
  }

  function toggleExpanded() {
    expanded = !expanded;
  }
</script>

<div class="token-inspector">
  <button class="header" on:click={toggleExpanded}>
    <span class="arrow">{expanded ? '▼' : '▶'}</span>
    <strong>View All Tokens</strong>
  </button>

  {#if expanded}
    <div class="content" transition:slide>
      <!-- Tab buttons (horizontal) -->
      <div class="tabs">
        {#each tokensByPlace as { place, tokens: placeTokens }, i}
          <button
            class="tab"
            class:active={selectedPlaceIndex === i}
            on:click={() => selectedPlaceIndex = i}
          >
            {place.name} ({placeTokens.length})
          </button>
        {/each}
      </div>

      <!-- Selected tab content -->
      {#if tokensByPlace[selectedPlaceIndex]}
        {@const { place, tokens: placeTokens } = tokensByPlace[selectedPlaceIndex]}
        <div class="tab-content">
          <div class="place-info">
            <strong>{place.name}</strong>
            <span class="type">{place.type_name}</span>
          </div>

          {#if placeTokens.length > 0}
            {#each placeTokens as token (token.id)}
              <div class="token-data">
                <div class="token-id">{token.id}</div>
                <pre>{JSON.stringify(token.data, null, 2)}</pre>
              </div>
            {/each}
          {:else}
            <div class="empty">No tokens in this place</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .token-inspector {
    display: flex;
    flex-direction: column;
    border: 1px solid #ddd;
    border-radius: 8px;
    background: white;
    overflow: hidden;
    flex: 1;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    background: #f5f5f5;
    border: none;
    cursor: pointer;
    width: 100%;
    text-align: left;
  }

  .header:hover {
    background: #e8e8e8;
  }

  .arrow {
    font-size: 0.8em;
  }

  .content {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem;
    background: #f9f9f9;
    border-bottom: 1px solid #ddd;
    overflow-x: auto;
  }

  .tab {
    padding: 0.5rem 1rem;
    border: 1px solid #ddd;
    background: white;
    border-radius: 4px 4px 0 0;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s;
  }

  .tab:hover {
    background: #f5f5f5;
  }

  .tab.active {
    background: #0066cc;
    color: white;
    border-color: #0066cc;
  }

  .tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
  }

  .place-info {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #eee;
  }

  .type {
    color: #666;
    font-size: 0.9em;
  }

  .token-data {
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: #f9f9f9;
    border-radius: 4px;
    border-left: 3px solid #0066cc;
  }

  .token-id {
    font-weight: bold;
    margin-bottom: 0.5rem;
    font-size: 0.9em;
    color: #0066cc;
  }

  pre {
    font-size: 0.85em;
    overflow-x: auto;
    margin: 0;
  }

  .empty {
    padding: 2rem;
    text-align: center;
    color: #999;
  }
</style>
```

### 6. WebSocket Store

**`src/lib/stores/webSocket.js`**
```javascript
import { writable } from 'svelte/store';

function createWebSocketStore() {
  const { subscribe, set } = writable(null);
  let ws = null;

  function connect() {
    ws = new WebSocket('ws://localhost:8000/ws');

    ws.onopen = () => {
      console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      set(message);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      setTimeout(connect, 1000);
    };
  }

  connect();

  return {
    subscribe,
    send: (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    }
  };
}

export const webSocketStore = createWebSocketStore();
```

## Svelte's Animation Superpowers

### 1. Transitions (Enter/Leave)

```svelte
<script>
  import { fade, slide, fly } from 'svelte/transition';
</script>

<!-- Element fades in when created, fades out when removed -->
<div transition:fade>Content</div>

<!-- Slides down when shown, slides up when hidden -->
<div transition:slide>Content</div>

<!-- Flies in from left, flies out to right -->
<div in:fly={{ x: -200 }} out:fly={{ x: 200 }}>Content</div>
```

### 2. Animate Directive (Position Changes)

```svelte
<script>
  import { flip } from 'svelte/animate';

  let tokens = [...];
</script>

{#each tokens as token (token.id)}
  <Token
    {...token}
    animate:flip={{ duration: 500 }}
  />
{/each}
```

When token positions change in the array, Svelte **automatically animates them to their new positions**. Perfect for Petri net tokens!

### 3. Tweened Stores (Smooth Value Changes)

```svelte
<script>
  import { tweened } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';

  const x = tweened(0, { duration: 500, easing: cubicOut });

  // When you set a new value, it smoothly interpolates
  function moveToken() {
    x.set(300);  // Smoothly moves from current position to 300
  }
</script>

<circle cx={$x} cy={100} r={10} />
```

### 4. Spring Stores (Physics-Based Animation)

```svelte
<script>
  import { spring } from 'svelte/motion';

  const coords = spring({ x: 0, y: 0 }, {
    stiffness: 0.1,
    damping: 0.25
  });

  // Moves with spring physics (bouncy, natural feel)
  function jump() {
    coords.set({ x: 300, y: 200 });
  }
</script>

<circle cx={$coords.x} cy={$coords.y} r={10} />
```

## Backend Changes (Minimal)

### Add WebSocket Endpoint to FastAPI

**`backend/server.py`** (or wherever your server is)
```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import json

app = FastAPI()

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Store active WebSocket connections
active_connections: list[WebSocket] = []

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)

    try:
        # Send initial graph state
        graph_state = get_current_graph_state()  # Your existing function
        await websocket.send_json({
            "type": "graph_state",
            "data": graph_state
        })

        # Keep connection open
        while True:
            # You can receive messages from frontend if needed
            data = await websocket.receive_text()
            message = json.loads(data)

            if message.get("type") == "fire_transition":
                transition_name = message.get("transition")
                # Fire transition...

    except WebSocketDisconnect:
        active_connections.remove(websocket)

async def broadcast_transition_fired(transition_data):
    """Call this when a transition fires"""
    message = {
        "type": "transition_fired",
        "transition_name": transition_data["name"],
        "tokens_moved": transition_data["tokens_moved"],
        "log_entry": transition_data["log_entry"],
        "new_token_positions": transition_data["new_token_positions"],
    }

    # Send to all connected clients
    for connection in active_connections:
        try:
            await connection.send_json(message)
        except:
            active_connections.remove(connection)

# Your existing graph execution code
async def run_continuous_execution():
    """Modified to broadcast updates"""
    while True:
        if should_fire_transition():
            result = fire_next_transition()

            # Broadcast to all connected frontends
            await broadcast_transition_fired(result)

        await asyncio.sleep(0.1)
```

## Project Setup

### 1. Create Svelte Project

```bash
# Create new SvelteKit project
npm create svelte@latest petrilit-frontend

# Choose:
# - Skeleton project
# - TypeScript? (optional, but recommended)
# - ESLint, Prettier? (recommended)

cd petrilit-frontend
npm install
```

### 2. Project Structure

```
petrilit-frontend/
├── src/
│   ├── lib/
│   │   ├── components/
│   │   │   ├── GraphPanel.svelte
│   │   │   ├── Place.svelte
│   │   │   ├── Transition.svelte
│   │   │   ├── Edge.svelte
│   │   │   ├── Token.svelte
│   │   │   ├── ExecutionLog.svelte
│   │   │   └── TokenInspector.svelte
│   │   └── stores/
│   │       └── webSocket.js
│   ├── routes/
│   │   └── +page.svelte  (main app)
│   └── app.html
├── static/  (for any static assets)
├── svelte.config.js
├── vite.config.js
└── package.json
```

### 3. Install Dependencies

```bash
# Svelte is already included, just add any extras if needed
npm install

# Optional: D3 for advanced animations/utilities
npm install d3

# Run dev server
npm run dev
```

Development server runs at `http://localhost:5173`

## Implementation Roadmap

### Phase 1: Basic Structure (2-3 hours)
- [ ] Set up SvelteKit project
- [ ] Create WebSocket store
- [ ] Build basic GraphPanel with hardcoded SVG
- [ ] Verify WebSocket connection to Python backend

### Phase 2: Graph Rendering (3-4 hours)
- [ ] Create Place, Transition, Edge components
- [ ] Receive graph layout from backend (grandalf positions)
- [ ] Render complete graph structure
- [ ] Add zoom/pan controls

### Phase 3: Token Animation (2-3 hours)
- [ ] Create Token component with tweened positions
- [ ] Implement token movement animation on transition fire
- [ ] Test multiple simultaneous animations
- [ ] Add token stacking within places

### Phase 4: Side Panels (3-4 hours)
- [ ] Build ExecutionLog with scroll preservation
- [ ] Build TokenInspector with tabs
- [ ] Add collapsible sections with state preservation
- [ ] Style and polish UI

### Phase 5: Real-Time Updates (2-3 hours)
- [ ] Connect all components to WebSocket updates
- [ ] Handle transition_fired messages
- [ ] Update only changed components
- [ ] Test with continuous execution

### Phase 6: Polish & Features (2-3 hours)
- [ ] Add transition firing buttons/controls
- [ ] Improve animations and transitions
- [ ] Error handling and reconnection logic
- [ ] Responsive layout

**Total Estimate: 14-20 hours**

## Why This Will Solve Your Problems

### Problem 1: Dropdown State Reset
**Streamlit:** Expanders recreated on every rerun
**Svelte:**
```svelte
<script>
  let expanded = false;  // Persists across updates!
</script>

<button on:click={() => expanded = !expanded}>
  {expanded ? '▼' : '▶'}
</button>

{#if expanded}
  <div transition:slide>Content</div>
{/if}
```
State lives in component scope, never resets unless component destroyed.

### Problem 2: Tab Selection Reset
**Streamlit:** `st.tabs()` doesn't preserve selection
**Svelte:**
```svelte
<script>
  let selectedTab = 0;  // Persists!
</script>

{#each tabs as tab, i}
  <button
    class:active={selectedTab === i}
    on:click={() => selectedTab = i}
  >
    {tab.name}
  </button>
{/each}
```

### Problem 3: Scroll Position Lost
**Streamlit:** Entire fragment rerenders
**Svelte:**
```svelte
<script>
  let entries = [];
  let logContainer;

  // Component updates, but DOM element persists
  // Scroll position automatically preserved
</script>

<div bind:this={logContainer} class="scrollable">
  {#each entries as entry}
    <div>{entry.text}</div>
  {/each}
</div>
```

### Problem 4: Everything Updates Together
**Streamlit:** Fragment is atomic, all or nothing
**Svelte:** Only components with changed props re-render

```svelte
<!-- GraphPanel only updates if graphState or tokens change -->
<GraphPanel {graphState} {tokens} />

<!-- ExecutionLog only updates if entries change -->
<ExecutionLog {entries} />

<!-- If only entries changes, GraphPanel doesn't re-render at all! -->
```

## Svelte-Specific Advantages for Petrilit

1. **`animate:flip`** - Perfect for tokens moving between places
2. **`tweened` stores** - Smooth position interpolation with easing
3. **Reactive statements** - `$: derivedValue = computeFrom(tokens)` updates automatically
4. **Minimal boilerplate** - Components are concise and readable
5. **Transitions** - Built-in enter/leave animations for log entries
6. **Scoped CSS** - Styles in component don't leak, easy to manage
7. **No virtual DOM** - Direct DOM manipulation, very fast

## Migration Strategy

### Option A: Parallel Development
- Keep Streamlit version running
- Build Svelte version alongside
- Switch when feature parity reached
- **Timeline**: 2-3 weeks part-time

### Option B: Incremental (Harder)
- Start with basic graph view in Svelte
- Gradually add panels
- Run both UIs until Svelte is complete
- **Timeline**: 3-4 weeks part-time

### Option C: Full Rewrite (Recommended)
- Build complete Svelte version in isolated project
- Test thoroughly
- Switch over completely
- **Timeline**: 1-2 weeks full-time, or 3-4 weeks part-time

**Recommendation: Option C (Full Rewrite)**
- Cleaner mental model
- No hybrid complexity
- Can experiment freely
- Python backend barely changes

## Next Steps

1. **Prototype (3-4 hours)**
   - Set up SvelteKit project
   - Create basic GraphPanel with hardcoded data
   - Add Token components with animation
   - Verify WebSocket connection works
   - **Goal**: Prove Svelte solves the core problems

2. **Decision Point**
   - If prototype feels good → proceed with full build
   - If issues arise → reassess

3. **Full Implementation** (14-20 hours after prototype)
   - Follow implementation roadmap above
   - Build all panels and features
   - Polish and test

Would you like me to help you set up the initial SvelteKit project and create the basic components to get started?

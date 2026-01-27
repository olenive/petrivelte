# Getting Started with Petrivelt

This guide will help you set up the Svelte frontend for Petri net visualization.

## Prerequisites

✅ You should have:
- [ ] Node.js 18+ installed (`node --version`)
- [ ] petritype-server running on `localhost:8000`
- [ ] A Petri net graph loaded in petritype-server (e.g., coloured_balls)

## Step 1: Create the Svelte Project

```bash
cd petrivelt

# Create SvelteKit project in frontend/ directory
npm create svelte@latest frontend
```

**Choose these options:**
- Template: **Skeleton project**
- TypeScript: **Yes** (recommended)
- ESLint: **Yes** (recommended)
- Prettier: **Yes** (recommended)
- Playwright: No (optional - can add later)
- Vitest: **Yes** (for testing)

## Step 2: Install Dependencies

```bash
cd frontend
npm install
```

## Step 3: Set Up WebSocket Store

Create `frontend/src/lib/stores/webSocket.js`:

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

## Step 4: Create a Simple Test Page

Edit `frontend/src/routes/+page.svelte`:

```svelte
<script>
  import { onMount } from 'svelte';
  import { webSocketStore } from '$lib/stores/webSocket';

  let graphState = null;
  let connectionStatus = 'Connecting...';

  onMount(() => {
    const unsubscribe = webSocketStore.subscribe(message => {
      if (!message) return;

      console.log('Received message:', message);

      if (message.type === 'graph_state') {
        graphState = message.data;
        connectionStatus = 'Connected ✓';
      }
    });

    return unsubscribe;
  });
</script>

<div class="app">
  <h1>Petrivelt - Petri Net Visualizer</h1>
  <p>Status: {connectionStatus}</p>

  {#if graphState}
    <div class="graph-info">
      <h2>Graph Loaded</h2>
      <p>Places: {graphState.places?.length || 0}</p>
      <p>Transitions: {graphState.transitions?.length || 0}</p>
      <pre>{JSON.stringify(graphState, null, 2)}</pre>
    </div>
  {:else}
    <p>Waiting for graph data...</p>
  {/if}
</div>

<style>
  .app {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  .graph-info {
    margin-top: 2rem;
    padding: 1rem;
    border: 1px solid #ccc;
    border-radius: 8px;
  }

  pre {
    background: #f5f5f5;
    padding: 1rem;
    overflow-x: auto;
    font-size: 0.85em;
  }
</style>
```

## Step 5: Run the Dev Server

```bash
# Make sure you're in frontend/
npm run dev
```

Open `http://localhost:5173` in your browser.

## Step 6: Verify Connection

You should see:
1. "Status: Connected ✓" when WebSocket connects
2. Graph data displayed (places, transitions, etc.)

**If you see "Waiting for graph data":**
- Check petritype-server is running: `curl http://localhost:8000/health`
- Make sure a graph is loaded (see next section)

## Loading a Test Graph

In a separate terminal:

```bash
cd ../petritype-server

# Start server (if not already running)
uv run python -m petritype_server.cli start

# In another terminal, create a test graph
uv run python -m petritype_server.cli create-graph \
  --module graphs.coloured_balls \
  --graph-id coloured_balls
```

Now refresh the Svelte frontend - you should see graph data!

## Next Steps

Now that you have basic WebSocket connection working:

1. **Read [SVELTE_DESIGN.md](./SVELTE_DESIGN.md)** for complete component examples
2. **Create GraphPanel component** - See design doc for SVG structure
3. **Add Token component** with animations - Use `tweened` stores
4. **Build ExecutionLog** - With scroll preservation
5. **Build TokenInspector** - With persistent tabs

## Useful Commands

```bash
# Run dev server (with hot reload)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run tests
npm test

# Lint
npm run lint

# Format code
npm run format
```

## Troubleshooting

**WebSocket won't connect:**
- Check petritype-server is running on port 8000
- Check browser console for errors
- Verify WebSocket endpoint exists in petritype-server

**No graph data received:**
- Create a graph in petritype-server first
- Check petritype-server logs for errors
- Verify the WebSocket message format

**Hot reload not working:**
- Check Vite dev server is running
- Try restarting the dev server

## Resources

- [Svelte Tutorial](https://svelte.dev/tutorial)
- [SvelteKit Docs](https://kit.svelte.dev/docs)
- [SVELTE_DESIGN.md](./SVELTE_DESIGN.md) - Full implementation guide
- [reference/](./reference/) - Code from Streamlit version

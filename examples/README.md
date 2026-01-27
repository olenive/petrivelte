# Petri Net Examples

These examples are copied from the petrilit (Streamlit) version.

They are **Petri net graph definitions** that can be loaded into petritype-server for visualization and execution.

## Available Examples

### coloured_balls

A Petri net that routes colored balls through different paths based on their color.

**To use with petritype-server:**
```bash
cd ../petritype-server
uv run python -m petritype_server.cli create-graph --module graphs.coloured_balls --graph-id coloured_balls
```

Then connect with the Svelte frontend to visualize it.

### toy

A simple toy example for testing.

## Note

These examples define the Petri net structure (places, transitions, types, functions).
The Svelte frontend in petrivelt will connect to petritype-server to visualize and interact with these graphs in real-time.

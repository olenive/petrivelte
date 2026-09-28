# Petrivelte

The web frontend for [petritype-server](../petritype-server): a SvelteKit app
for running and watching Petri nets and their Marimo notebooks on workers
managed by the control plane.

## Run

```bash
# control plane
cd ../petritype-server && uv run uvicorn petritype_server.server:app --reload --port 8000
# frontend
cd frontend && npm install && npm run dev   # http://localhost:5173
```

`npm test` runs vitest and `npm run check` runs svelte-check.

## Where things live

- `frontend/`: the app. Its [README](frontend/README.md) lists routes, library
  modules and scripts.
- [COMS.md](COMS.md): how the frontend talks to the control plane (auth,
  proxy refusals, SSE channels, notebook iframe).
- `examples/`, `reference/`, `tests/`, `pyproject.toml`: Python material from
  the earlier Streamlit viewer, kept for reference; the app does not use it.
- `implementation_docs/`: historical design notes.

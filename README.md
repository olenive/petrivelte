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

`npm test` runs vitest and `npm run check` runs svelte-check. The browser
suite under `tests/ui` drives the real nets page with Playwright against a
fake control plane (`tests/ui/fake_cp.py`, both event streams included):
`uv run --with "playwright>=1.45" --with pytest pytest tests/ui -q`, after
`uv run --with "playwright>=1.45" playwright install chromium` once.

## Where things live

- `frontend/`: the app. Its [README](frontend/README.md) lists routes, library
  modules and scripts.
- [COMS.md](COMS.md): how the frontend talks to the control plane (auth,
  proxy refusals, SSE channels, notebook iframe).
- `tests/ui/`: the browser suite above; `pyproject.toml` exists for it.
- `examples/`, `reference/`, the files directly under `tests/`: Python material
  from the earlier Streamlit viewer, kept for reference; the app does not use it.
- `implementation_docs/`: historical design notes.

# Petrivelt Setup Summary

This document lists what was copied from petrilit and why.

## Created: 2026-01-23

## Directory Structure

```
petrivelt/
├── README.md                          # Main project documentation
├── GETTING_STARTED.md                 # Step-by-step setup guide
├── SVELTE_DESIGN.md                   # Complete Svelte architecture & examples
├── SETUP_SUMMARY.md                   # This file
├── pyproject.toml                     # Python project config (minimal)
├── .gitignore                         # Git ignore patterns
│
├── reference/                         # Reference code from Streamlit version
│   ├── README.md                      # Explains reference files
│   ├── previous_version_render.py     # SVG generation (was render.py)
│   ├── animation.py                   # Animation calculation reference
│   ├── layout.py                      # Graph layout reference
│   └── data_structures.py             # Data structures & utilities
│
├── examples/                          # Example Petri net graphs
│   ├── README.md                      # How to use examples
│   ├── coloured_balls/                # Main example
│   └── toy/                           # Simple example
│
├── tests/                             # Tests from petrilit (reference)
│   ├── README.md                      # Explains test purpose
│   ├── conftest.py
│   ├── test_animation.py
│   ├── test_layout.py
│   └── test_render.py
│
└── frontend/                          # (To be created) SvelteKit app
```

## What Was Copied and Why

### Documentation

| File | Source | Purpose |
|------|--------|---------|
| SVELTE_DESIGN.md | Created new | Complete Svelte architecture, component examples, implementation roadmap |
| README.md | New, based on petrilit README | Project overview, setup instructions, comparison with Streamlit version |
| GETTING_STARTED.md | Created new | Step-by-step guide to create Svelte project and connect to backend |

### Reference Code (from petrilit)

All files in `reference/` have header comments explaining they are **NOT** the Svelte implementation.

| File | Source | Purpose |
|------|--------|---------|
| previous_version_render.py | petrilit/render.py | SVG structure reference, token positioning, pan/zoom logic |
| animation.py | petrilit/animation.py | Animation data calculation reference |
| layout.py | petrilit/layout.py | Graph layout (grandalf) - stays in backend |
| data_structures.py | petrilit/data_structures.py | Token positioning, color logic, data formats |

**Why copied:**
- Avoid reimplementing token stacking logic from scratch
- Understand SVG layer structure
- See how animation sequences are calculated
- Reference for data formats sent from backend

**Important notes added:**
- Each file has a header explaining it's reference code only
- Notes explain what's relevant for Svelte version
- Clarifies what stays in backend vs what goes in frontend

### Examples

| Directory | Source | Purpose |
|-----------|--------|---------|
| examples/coloured_balls/ | petrilit/examples/coloured_balls/ | Main Petri net example for testing |
| examples/toy/ | petrilit/examples/toy/ | Simple example |

**Why copied:**
- Provides test data for frontend development
- Can load into petritype-server for visualization

**Added:**
- examples/README.md explaining how to use with petritype-server

### Tests

| File | Source | Purpose |
|------|--------|---------|
| test_animation.py | petrilit/tests/ | Reference for animation logic |
| test_layout.py | petrilit/tests/ | Reference for layout logic |
| test_render.py | petrilit/tests/ | Reference for rendering logic |
| conftest.py | petrilit/tests/ | Pytest fixtures |

**Why copied:**
- Understand expected behavior
- See data structure examples
- Reference for writing frontend tests

**Added:**
- tests/README.md explaining these are Python reference tests
- Notes on writing JavaScript/TypeScript tests for Svelte

### Configuration

| File | Purpose |
|------|---------|
| pyproject.toml | Minimal Python config (optional dev dependencies) |
| .gitignore | Ignore patterns for Python, Node.js, editors |

## What Was NOT Copied

- ❌ `view_server_graph.py` - Streamlit app (being replaced by Svelte)
- ❌ `visualize_remote_graph.py` - Streamlit utility
- ❌ `petrilit/controller.py` - Server-side controller (stays in petritype-server)
- ❌ `petrilit/graph_queries.py` - Backend logic (stays in petritype-server)
- ❌ Other test files - Not directly relevant to frontend development
- ❌ Build artifacts, venv, caches, etc.

## Key Design Decisions

### 1. Backend Stays Separate
- petritype-server handles all Petri net logic
- petrivelt is ONLY the frontend
- Communication via WebSocket

### 2. Layout Stays in Backend
- No need to port grandalf to JavaScript
- Backend sends positioned coordinates
- Frontend just renders at given positions

### 3. Reference Code Clearly Marked
- All reference files have explanatory headers
- Clear distinction between "reference" and "implementation"
- Notes on what needs adapting for Svelte

### 4. Progressive Setup
- Can start with basic WebSocket connection
- Add components incrementally
- Refer to SVELTE_DESIGN.md for examples

## Next Steps for Developer

1. **Read documentation**
   - [ ] Read README.md (overview)
   - [ ] Read SVELTE_DESIGN.md (complete architecture)
   - [ ] Read GETTING_STARTED.md (setup guide)

2. **Create Svelte project**
   - [ ] `npm create svelte@latest frontend`
   - [ ] Follow GETTING_STARTED.md

3. **Build components**
   - [ ] WebSocket store (see SVELTE_DESIGN.md)
   - [ ] GraphPanel with SVG
   - [ ] Token component with animation
   - [ ] ExecutionLog panel
   - [ ] TokenInspector panel

4. **Test with examples**
   - [ ] Load coloured_balls example in petritype-server
   - [ ] Verify WebSocket connection
   - [ ] Test token animations
   - [ ] Test continuous execution

## Questions?

Refer to:
- **SVELTE_DESIGN.md** for implementation details
- **GETTING_STARTED.md** for setup help
- **reference/README.md** for understanding reference code
- **examples/README.md** for using test graphs

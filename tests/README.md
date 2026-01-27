# Tests from petrilit

These tests are copied from the Streamlit version (petrilit) as reference.

## What's Included

- **test_animation.py** - Tests for animation data calculation
- **test_layout.py** - Tests for graph layout using grandalf
- **test_render.py** - Tests for SVG rendering logic
- **conftest.py** - Pytest fixtures

## Note for Svelte Development

These tests are **Python tests** that validate the backend rendering logic from the Streamlit version.

For the Svelte frontend (petrivelt):
- The backend logic they test is mostly staying in petritype-server
- You'll want to write **JavaScript/TypeScript tests** for Svelte components
- These are useful to understand expected data structures and behavior
- Consider using Vitest or Jest for frontend testing

## Running These Tests

If you want to run these Python tests (requires the petrilit dependencies):

```bash
# Install test dependencies
uv pip install pytest

# Run tests
uv run pytest tests/
```

However, these tests depend on the petrilit module which isn't included in petrivelt.
They're primarily here as **reference documentation** rather than executable tests.

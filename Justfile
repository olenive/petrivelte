# Every gate to pass before a hand-over is `just check`. Each recipe also runs on its own.

# List the recipes
default:
    @{{just_executable()}} --list

# Every gate before a hand-over, in order: lint, test, ui
check: lint test ui

# svelte-check over the frontend
[working-directory: 'frontend']
lint:
    npm run check

# The frontend's vitest suite
[working-directory: 'frontend']
test:
    npm test

# The browser suite: Playwright drives the pages under vite dev against a fake control plane
ui:
    uv run --with "playwright>=1.45" --with pytest pytest tests/ui -q

# The production bundle into frontend/build/
[working-directory: 'frontend']
build:
    npm run build

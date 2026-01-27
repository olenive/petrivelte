# Reference Code from Streamlit Version

This directory contains code from the **petrilit** (Streamlit) implementation.

⚠️ **IMPORTANT**: This code is **NOT** the implementation for Svelte. It's provided as reference to understand the previous architecture and avoid duplicating work.

## Files

### previous_version_render.py

The SVG generation logic from the Streamlit version.

**What's useful:**
- SVG layer structure (edges, places, transitions, tokens)
- Token positioning and stacking logic within places
- Animation data format
- Pan/zoom implementation with localStorage

**For Svelte:**
- Generate similar SVG but using Svelte components (`<Place>`, `<Token>`, etc.)
- Use Svelte's reactive stores instead of string templates
- Use Svelte's `animate:flip` and `tweened` for animations

### animation.py

Animation data calculation logic.

**What's useful:**
- How token movements are sequenced
- Animation timing and phases
- Data structure for animations

**For Svelte:**
- Backend (petritype-server) will still calculate animations like this
- Frontend receives animation data via WebSocket
- Apply animations using Svelte's `tweened` stores or CSS transitions

### layout.py

Graph layout using grandalf (hierarchical layout algorithm).

**What's useful:**
- Understanding how positions are calculated
- Layout algorithm parameters

**For Svelte:**
- This logic **stays in the backend** (petritype-server)
- Backend sends positioned coordinates: `{places: [{id, x, y}], ...}`
- Frontend just renders at given positions
- **No need to port layout logic to JavaScript**

### data_structures.py

Data structures and utility functions.

**What's useful:**
- `calculate_token_position()` - Token stacking within places
- `default_token_color()` - Color assignment logic
- `RenderableGraph` - Data format structure

**For Svelte:**
- May want to port `calculate_token_position` to TypeScript
- Use similar data structures for graph state
- Backend will send data in this format via WebSocket

## Key Differences: Streamlit vs Svelte

| Aspect | Streamlit (petrilit) | Svelte (petrivelt) |
|--------|---------------------|-------------------|
| **Rendering** | Server generates HTML string | Client components generate SVG |
| **Updates** | Full page/fragment rerun | Only changed components update |
| **Animation** | CSS transitions in HTML string | Svelte `tweened` stores + `animate:` directive |
| **State** | Server-side session_state | Client-side component state |
| **Real-time** | Polling with sleep + rerun | WebSocket push updates |

## How to Use This Reference

1. **Read the code** to understand the architecture
2. **Don't copy-paste** directly - adapt concepts to Svelte
3. **Focus on data structures** - they're mostly reusable
4. **Keep layout in backend** - no need to port grandalf to JS

## Example: Converting Render Logic

**Streamlit (string templates):**
```python
svg = f'''
<svg viewBox="...">
  <g class="places">
    {generate_places_svg(places)}
  </g>
  <g class="tokens">
    {generate_tokens_svg(tokens)}
  </g>
</svg>
'''
```

**Svelte (components):**
```svelte
<svg viewBox={viewBox}>
  <g class="places">
    {#each places as place (place.id)}
      <Place {...place} />
    {/each}
  </g>
  <g class="tokens">
    {#each tokens as token (token.id)}
      <Token {...token} animate:flip={{ duration: 500 }} />
    {/each}
  </g>
</svg>
```

## Questions?

Refer to [SVELTE_DESIGN.md](../SVELTE_DESIGN.md) for complete Svelte implementation examples.

# Token Visualization Algorithm

**Date:** 2026-01-25
**Status:** Fixed - Tokens now calculate positions correctly

## The Problem

The backend sends token data (id, place_id, data) but **does not** calculate x/y screen positions. The frontend must calculate where to draw each token on the SVG canvas.

**Bug:** Initially, tokens appeared correctly on graph load, but disappeared or jumped to wrong positions after transitions fired. This was because the `transition_fired` handler directly assigned `message.new_token_positions` without recalculating x/y coordinates.

## The Solution

Extract the position calculation logic into a reusable function `calculateTokenPositions()` and use it in both message handlers.

---

## Algorithm: Token Position Calculation

### Input
- `tokensData`: Array of token objects with `{id, place_id, data}`
- `state`: Current GraphState with places array (each place has x, y coordinates)

### Output
- Array of Token objects with calculated `{id, place_id, x, y, color, data}`

### Steps

```
FUNCTION calculateTokenPositions(tokensData, state):

    // Step 1: Group tokens by place_id
    tokensByPlace = new Map()
    FOR each token in tokensData:
        IF tokensByPlace does not have token.place_id:
            tokensByPlace[token.place_id] = []
        ADD {id: token.id, data: token.data} to tokensByPlace[token.place_id]

    // Step 2: Calculate positions for each place's tokens
    positionedTokens = []
    FOR each (placeId, placeTokens) in tokensByPlace:

        // Step 2a: Find the place node
        place = state.places.find(p => p.id === placeId)
        IF place not found: CONTINUE to next place

        // Step 2b: Calculate stacking parameters
        tokenCount = placeTokens.length
        stackRadius = min(20, tokenCount * 3)  // Larger radius for more tokens

        // Step 2c: Position each token in circular pattern
        FOR each token at index in placeTokens:
            angle = (index * 2π) / tokenCount        // Evenly distribute around circle
            offsetX = cos(angle) * stackRadius       // Horizontal offset from center
            offsetY = sin(angle) * stackRadius       // Vertical offset from center

            positionedToken = {
                id: token.id,
                place_id: placeId,
                x: place.x + offsetX,                // Absolute x = place center + offset
                y: place.y + offsetY,                // Absolute y = place center + offset
                color: getTokenColor(token.data),    // Map token data to color
                data: token.data
            }

            ADD positionedToken to positionedTokens

    RETURN positionedTokens
```

### Circular Stacking Details

**Why circular stacking?**
- Multiple tokens can exist in the same place
- Stacking them in a circle makes each token visible
- Alternative would be overlapping (only top token visible)

**Stack radius calculation:**
- `stackRadius = min(20, tokenCount * 3)`
- More tokens = larger radius (up to maximum of 20 pixels)
- 1 token: radius 3 (very close to center)
- 2 tokens: radius 6 (small circle)
- 5 tokens: radius 15
- 10+ tokens: radius 20 (capped)

**Angle distribution:**
- Tokens are evenly distributed around the circle
- 1 token: angle = 0 (sits at 3 o'clock position)
- 2 tokens: angles = 0, π (opposite sides)
- 3 tokens: angles = 0, 2π/3, 4π/3 (triangle)
- 4 tokens: angles = 0, π/2, π, 3π/2 (square)

---

## Color Mapping Algorithm

### Input
- `tokenData`: Token's data object (may contain color property)

### Output
- Hex color string (e.g., '#ef4444')

### Steps

```
FUNCTION getTokenColor(tokenData):
    IF tokenData exists AND tokenData.color exists:
        colorName = tokenData.color.toLowerCase()

        colorMap = {
            'red': '#ef4444',
            'blue': '#3b82f6',
            'green': '#22c55e',
            'yellow': '#eab308',
            'purple': '#a855f7',
            'orange': '#f97316',
            'pink': '#ec4899',
            'gray': '#6b7280'
        }

        RETURN colorMap[colorName] OR '#6b7280' (if color not in map)

    RETURN '#6b7280'  // Default gray for tokens without color
```

---

## Message Handler Flow

### Handler 1: graph_state (Initial Load)

```
ON WebSocket message with type='graph_state':

    1. Set graphState = message.data
    2. Set connectionStatus = 'Connected ✓'

    3. Extract token data from places:
       tokensData = []
       FOR each place in graphState.places:
           IF place.tokens exists:
               FOR each token in place.tokens:
                   ADD {id: token.id, place_id: place.id, data: token.data}

    4. Calculate positions:
       tokens = calculateTokenPositions(tokensData, graphState)

    5. Log: "Extracted N tokens from graph_state"
```

### Handler 2: transition_fired (After Execution)

```
ON WebSocket message with type='transition_fired':

    1. Add log entry:
       logEntries = [message.log_entry, ...logEntries]

    2. Recalculate token positions:
       IF graphState exists:
           tokens = calculateTokenPositions(message.new_token_positions, graphState)

       Note: message.new_token_positions has {id, place_id, data}
             but x/y are missing or incorrect, so we recalculate them

    3. Mark animating tokens:
       animatingTokens = message.tokens_moved.map(t => t.id)

    4. After 500ms:
       animatingTokens = []
```

---

## GraphPanel Rendering

```
FOR each token in tokens array (with token.id as key):
    Render Token component:
        - x={token.x}
        - y={token.y}
        - color={token.color}
        - id={token.id}
        - animating={animatingTokens.includes(token.id)}
```

---

## Token Component Animation

```
Token Component:
    Input: x, y, color, id, animating

    Initialize:
        tweenedX = tweened(x, duration: 500ms, easing: cubicInOut)
        tweenedY = tweened(y, duration: 500ms, easing: cubicInOut)

    On x or y prop change:
        IF animating === true:
            tweenedX.set(x)  // Smooth 500ms transition
            tweenedY.set(y)  // Smooth 500ms transition
        ELSE:
            tweenedX.set(x, duration: 0)  // Instant jump
            tweenedY.set(y, duration: 0)  // Instant jump

    Render:
        <circle cx={$tweenedX} cy={$tweenedY} r={8} fill={color} />
```

---

## Complete Token Lifecycle

### 1. Initial Graph Load
```
Backend sends graph_state
  ↓
Frontend extracts token data from places
  ↓
calculateTokenPositions() computes x/y with circular stacking
  ↓
GraphPanel renders Token components at calculated positions
  ↓
Tokens appear on screen in circular pattern around places
```

### 2. Transition Fires
```
Backend executes transition
  ↓
Backend sends transition_fired with new_token_positions
  ↓
Frontend receives new token data (some moved, some consumed, some created)
  ↓
calculateTokenPositions() recomputes x/y for ALL tokens
  ↓
Tokens with new place_id get new positions
Tokens still in same place keep similar positions (may shift in circle)
  ↓
Token components animate to new positions (500ms tween)
  ↓
Tokens smoothly move/appear/disappear on screen
```

### 3. Reset Button
```
User clicks Reset
  ↓
Frontend clears tokens = []
Frontend clears logEntries = []
  ↓
Backend sends new graph_state with initial tokens
  ↓
[Same as Initial Graph Load]
```

---

## Key Invariants

1. **Backend never calculates x/y positions** - Frontend always does this
2. **Position calculation always uses circular stacking** - Consistent everywhere
3. **Token positions recalculated on every update** - Never trust backend x/y values
4. **Tokens grouped by place_id** - All tokens in same place stacked together
5. **Color extracted from token.data.color** - Backend provides semantic color name, frontend maps to hex

---

## Files Involved

- **`frontend/src/routes/+page.svelte`** (Lines 104-157):
  - `calculateTokenPositions()` - Main algorithm
  - `getTokenColor()` - Color mapping
  - WebSocket message handlers

- **`frontend/src/lib/components/GraphPanel.svelte`** (Lines 83-87):
  - Renders Token components from tokens array

- **`frontend/src/lib/components/Token.svelte`** (Lines 1-49):
  - Tweened animation for smooth movement
  - SVG circle rendering

---

**The bug is now fixed - tokens will maintain correct positions throughout the execution lifecycle!** 🎯

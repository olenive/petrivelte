# Option A: Initial Tokens Now Visible ✅

**Date:** 2026-01-23
**Status:** Complete - Ready to Test

## What Was Fixed

### Problem
- Backend was sending tokens in `graph_state` message
- Frontend was receiving them but **not extracting/displaying** them
- `tokens` array stayed empty, so GraphPanel rendered nothing

### Solution

1. **Extract tokens from graph_state** when message arrives
2. **Add x/y coordinates** based on parent place position
3. **Stack tokens in circular pattern** so multiple tokens are visible
4. **Add color mapping** for colored balls (red, blue, green, yellow, etc.)

## Changes Made

### Frontend (`frontend/src/routes/+page.svelte`)

**Added token extraction on graph_state:**
```typescript
if (message.type === 'graph_state') {
    graphState = message.data;

    // Extract tokens from places
    const extractedTokens: Token[] = [];
    for (const place of graphState.places) {
        if (place.tokens && place.tokens.length > 0) {
            // Stack tokens in circular pattern
            const tokenCount = place.tokens.length;
            const stackRadius = Math.min(20, tokenCount * 3);

            place.tokens.forEach((token, index) => {
                const angle = (index * 2 * Math.PI) / tokenCount;
                const offsetX = Math.cos(angle) * stackRadius;
                const offsetY = Math.sin(angle) * stackRadius;

                extractedTokens.push({
                    id: token.id,
                    place_id: place.id,
                    x: place.x + offsetX,
                    y: place.y + offsetY,
                    color: getTokenColor(token.data),
                    data: token.data
                });
            });
        }
    }
    tokens = extractedTokens;
}
```

**Added color mapping:**
```typescript
function getTokenColor(tokenData: any): string {
    if (tokenData && tokenData.color) {
        const colorMap = {
            red: '#ef4444',
            blue: '#3b82f6',
            green: '#22c55e',
            yellow: '#eab308',
            // ... more colors
        };
        return colorMap[tokenData.color.toLowerCase()] || '#6b7280';
    }
    return '#6b7280'; // Gray default
}
```

## Testing

### Restart Everything

**Terminal 1: Backend**
```bash
cd /Users/admin/work/petritype-server
uv run python -m petritype_server.cli start
```

**Terminal 2: Create Graph**
```bash
cd /Users/admin/work/petritype-server
uv run python -m petritype_server.cli create-graph \
  --module graphs.coloured_balls \
  --graph-id coloured_balls
```

**Terminal 3: Frontend**
```bash
cd /Users/admin/work/petrivelt/frontend
npm run dev
```

### Expected Behavior

Open http://localhost:5173

You should now see:

1. **Initial State:**
   - ✅ Graph with 5 places and 1 transition
   - ✅ **12 tokens visible!**
     - 6 tokens in "Input Rubber" (gray circles)
     - 6 tokens in "Input Paint" (colored circles: red, blue, green, yellow, red, blue)
   - ✅ Tokens arranged in circle around each place
   - ✅ Empty output places (Red Balls, Blue Balls, Other Balls)

2. **Click "Step":**
   - ✅ One transition fires
   - ✅ One rubber + one paint consumed
   - ✅ One ball appears in output place (based on color)
   - ⚠️ **No animation yet** (tokens just appear/disappear)

3. **Click "Run":**
   - ✅ Transitions fire continuously
   - ✅ Tokens move from inputs to outputs
   - ⚠️ **No animation yet** (tokens teleport)

## What's Working Now

- ✅ Initial tokens visible on graph load
- ✅ Tokens colored based on data (Paint tokens show their color)
- ✅ Multiple tokens in same place stacked in circle
- ✅ Tokens update when transitions fire
- ✅ Console shows: "Extracted X tokens from graph_state"

## What's Still Missing (Option B)

- ❌ No smooth animations when tokens move
- ❌ Tokens just appear/disappear instead of transitioning
- ❌ No "from → to" movement visualization
- ❌ Backend doesn't send `tokens_moved` data

## Next: Option B

Option B will add:
1. Backend tracking of token movements (before/after comparison)
2. Backend populating `tokens_moved` with from/to positions
3. Frontend smooth animations based on movement data
4. Visual token flow from place → transition → place

---

**Test Option A first, then we'll move to Option B!** 🎨

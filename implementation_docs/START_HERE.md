# 👋 Welcome to Petrivelt!

This is a **Svelte-based frontend** for visualizing Petri nets from petritype-server.

## 🚀 Quick Start (5 minutes)

### 1. Read the Overview
```bash
cat README.md
```

### 2. Follow the Setup Guide
```bash
cat GETTING_STARTED.md
```

The guide will walk you through:
- Creating the Svelte project
- Setting up WebSocket connection
- Verifying connection with test data

### 3. Build Your First Component

Once setup is complete, see **SVELTE_DESIGN.md** for complete component examples:
- WebSocket store
- GraphPanel with SVG
- Token animations
- ExecutionLog
- TokenInspector

## 📚 Documentation Map

| File | Purpose | Read When |
|------|---------|-----------|
| **START_HERE.md** | You are here! | First |
| **README.md** | Project overview & architecture | First |
| **GETTING_STARTED.md** | Step-by-step setup instructions | Setting up |
| **SVELTE_DESIGN.md** | Complete Svelte implementation guide | Building components |
| **SETUP_SUMMARY.md** | What was copied from petrilit and why | Understanding project |
| **reference/README.md** | Explains reference code files | Using reference code |
| **examples/README.md** | How to use example graphs | Testing frontend |
| **tests/README.md** | About copied tests | Understanding tests |

## 🗂️ Project Structure

```
petrivelt/
├── 📄 Documentation (read these)
│   ├── START_HERE.md           ← You are here
│   ├── README.md               ← Project overview
│   ├── GETTING_STARTED.md      ← Setup guide
│   └── SVELTE_DESIGN.md        ← Implementation guide
│
├── 📁 reference/               Reference from Streamlit version
│   ├── previous_version_render.py  (SVG generation example)
│   ├── animation.py                (Animation logic)
│   └── layout.py                   (Graph layout)
│
├── 📁 examples/                Test Petri net graphs
│   └── coloured_balls/         (Main example)
│
├── 📁 tests/                   Reference tests from petrilit
│
└── 📁 frontend/                (To be created) Your Svelte app
```

## 🎯 Development Workflow

### Phase 1: Setup (30 min)
1. Read README.md
2. Follow GETTING_STARTED.md
3. Verify WebSocket connection works

### Phase 2: Basic Visualization (4-6 hours)
1. Create GraphPanel component
2. Render places, transitions, edges
3. Add basic token rendering
4. Test with coloured_balls example

### Phase 3: Animation (2-3 hours)
1. Add Token component with tweened stores
2. Implement token movement animation
3. Test with transition firing

### Phase 4: Side Panels (3-4 hours)
1. Build ExecutionLog with scroll preservation
2. Build TokenInspector with persistent tabs
3. Add collapsible sections

### Phase 5: Polish (2-3 hours)
1. Add zoom/pan controls
2. Improve styling
3. Add transition firing controls
4. Error handling

**Total: ~14-20 hours for full implementation**

## 🛠️ Tech Stack

### Frontend (Svelte)
- **SvelteKit** - Application framework
- **Svelte** - Reactive components
- **Vite** - Build tool & dev server
- **TypeScript** - Type safety (recommended)

### Backend (Already exists)
- **petritype-server** - Petri net execution engine
- **FastAPI** - WebSocket API
- **grandalf** - Graph layout (backend only)

### Communication
- **WebSocket** - Real-time updates from backend
- **JSON** - Message format

## 💡 Key Concepts

### 1. Backend Does Layout
- petritype-server calculates positions using grandalf
- Frontend receives coordinates and renders
- **No need to port layout logic to JavaScript**

### 2. Independent Panel Updates
- Each Svelte component manages its own state
- Only changed components re-render
- Solves the main problem with Streamlit version

### 3. WebSocket Communication
- Backend pushes updates when transitions fire
- Frontend applies updates reactively
- No polling needed

### 4. Reference Code
- `reference/` contains Streamlit version code
- NOT the Svelte implementation
- Use as reference for:
  - Data structures
  - Token positioning logic
  - SVG layer structure
  - Animation sequences

## ❓ Common Questions

**Q: Do I need to know Python?**
A: No! The frontend is pure JavaScript/TypeScript. Python reference code is just for understanding data structures.

**Q: Do I need to implement graph layout?**
A: No! The backend sends positioned coordinates. You just render at those positions.

**Q: Can I use the Streamlit code directly?**
A: No, but you can adapt concepts. See reference/README.md for guidance.

**Q: Where do I start?**
A: Read README.md, then follow GETTING_STARTED.md step by step.

**Q: How do I test my frontend?**
A: Load example graphs in petritype-server and connect your Svelte app.

## 🎨 Design Philosophy

1. **Simple beats complex** - Start with basic rendering, add features incrementally
2. **Svelte is reactive** - Let the framework handle updates, don't fight it
3. **Direct SVG** - No graph library needed, full control over rendering
4. **State in components** - Each component owns its state, no global state needed
5. **WebSocket for updates** - Push model, not polling

## 🏁 Ready to Start?

1. **First time here?** → Read README.md
2. **Ready to code?** → Follow GETTING_STARTED.md
3. **Building components?** → See SVELTE_DESIGN.md
4. **Need help?** → Check reference/ directory

Happy coding! 🚀

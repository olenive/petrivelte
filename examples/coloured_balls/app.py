"""Streamlit app for the coloured balls Petri net example."""

import asyncio
import sys
import time
from pathlib import Path

# Add project root to path for imports when running directly
_project_root = Path(__file__).parent.parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

import streamlit as st

from petrilit import (
    compute_hierarchical_layout,
    generate_petri_net_svg,
    get_enabled_transitions,
    prepare_fire_animation,
    create_in_memory_controller,
)

from examples.coloured_balls.graph import create_initial_graph
from examples.coloured_balls.token_style import coloured_balls_token_color


# Streamlit app
st.set_page_config(page_title="Petritype - Coloured Balls Example", layout="wide")

# Initialize session state
if "controller" not in st.session_state:
    st.session_state.controller = create_in_memory_controller(create_initial_graph())
if "positions" not in st.session_state:
    initial_graph = asyncio.run(st.session_state.controller["get_graph"]())
    st.session_state.positions = compute_hierarchical_layout(initial_graph)
if "animation_data" not in st.session_state:
    st.session_state.animation_data = None
if "show_animation" not in st.session_state:
    st.session_state.show_animation = False


def reset_graph():
    """Reset the graph to initial state."""
    initial_graph = create_initial_graph()
    asyncio.run(st.session_state.controller["reset"](initial_graph))
    st.session_state.positions = compute_hierarchical_layout(initial_graph)
    st.session_state.animation_data = None
    st.session_state.show_animation = False


st.title("Petritype Graph Visualization")
st.markdown("### Coloured Balls Distribution Example")

st.markdown(
    """
This example demonstrates a petri net for manufacturing coloured balls:
- **Circles (Blue)**: Place nodes that hold tokens
- **Rectangle (Green)**: Transition that fires to transform tokens
- **Small colored circles**: Tokens (rubber=brown, paint/balls=colored)
- Click **Fire Transition** to watch tokens animate!
"""
)

st.markdown("---")

# Control panel
st.subheader("Controls")
col1, col2, col3, col4, col5 = st.columns(5)

# Check if controller is running
is_running = asyncio.run(st.session_state.controller["is_running"]())

with col1:
    fire_clicked = st.button(
        "Fire Transition",
        type="primary",
        disabled=st.session_state.show_animation or is_running
    )

with col2:
    # Toggle button for animated run all
    button_label = "Stop" if is_running else "Run All (Animated)"
    button_type = "secondary" if is_running else "primary"

    if st.button(button_label, type=button_type, disabled=st.session_state.show_animation):
        if is_running:
            asyncio.run(st.session_state.controller["stop_continuous"]())
        else:
            asyncio.run(st.session_state.controller["start_continuous"]())
        st.rerun()

with col3:
    if st.button("Run All (Instant)", disabled=st.session_state.show_animation or is_running):

        async def run_all():
            controller = st.session_state.controller
            total = 0
            while True:
                fired = await controller["step"]()
                if fired == 0:
                    break
                total += fired
            return total

        asyncio.run(run_all())
        st.session_state.animation_data = None
        st.rerun()

with col4:
    if st.button("Reset", disabled=st.session_state.show_animation):
        reset_graph()
        st.rerun()

with col5:
    transitions_fired = asyncio.run(st.session_state.controller["get_transitions_fired_count"]())
    st.metric("Fired", transitions_fired)

# Get current graph for display and animation
current_graph = asyncio.run(st.session_state.controller["get_graph"]())

# Handle fire button click - prepare animation
if fire_clicked:
    enabled = get_enabled_transitions(current_graph)
    if enabled:
        transition = enabled[-1]
        st.session_state.animation_data = prepare_fire_animation(
            current_graph,
            transition,
            st.session_state.positions,
            token_color_fn=coloured_balls_token_color,
        )
        st.session_state.show_animation = True
        # Don't rerun yet - let the page render with animation data

# Handle auto-fire mode - start firing if active and not already animating
if is_running and not st.session_state.show_animation:
    enabled = get_enabled_transitions(current_graph)
    if enabled:
        transition = enabled[-1]
        st.session_state.animation_data = prepare_fire_animation(
            current_graph,
            transition,
            st.session_state.positions,
            token_color_fn=coloured_balls_token_color,
        )
        st.session_state.show_animation = True
    else:
        # No more transitions to fire - stop auto-fire
        asyncio.run(st.session_state.controller["stop_continuous"]())

# Show status
enabled_transitions = get_enabled_transitions(current_graph)
if enabled_transitions:
    st.success(f"Ready to fire: **{enabled_transitions[-1].name}**")
else:
    st.warning("No transitions enabled (need tokens in input places)")

st.markdown("---")

# Display the graph
svg_html = generate_petri_net_svg(
    current_graph,
    st.session_state.positions,
    st.session_state.animation_data,
    token_color_fn=coloured_balls_token_color,
    width=950,
    height=420,
)
st.components.v1.html(svg_html, height=450, scrolling=False)

# If animation is showing, wait then update state
if st.session_state.show_animation:
    # Show a progress message
    with st.spinner("Animating transition..."):
        time.sleep(2.0)  # Wait for full animation

    # Now fire the actual transition to update state
    asyncio.run(st.session_state.controller["step"]())
    st.session_state.animation_data = None
    st.session_state.show_animation = False
    st.rerun()

# Legend
st.markdown(
    """
**Legend:**
- Place (circle) holds tokens
- Transition (rectangle) fires
- Brown = Rubber tokens
- Colored = Paint/ball tokens
"""
)

st.markdown("---")

# Graph details in expander
with st.expander("Graph Details"):
    col1, col2 = st.columns(2)

    with col1:
        st.markdown("**Places:**")
        for place in current_graph.places:
            type_name = getattr(place.type, "__name__", str(place.type))
            st.write(f"- **{place.name}** ({type_name}): {len(place.tokens)} tokens")

    with col2:
        st.markdown("**Transitions:**")
        for transition in current_graph.transitions:
            st.write(f"- **{transition.name}**: `{transition.function.__name__}()`")

with st.expander("View All Tokens", expanded=False):
    # Create tab labels with token counts
    place_names = [f"{p.name} ({len(p.tokens)})" for p in current_graph.places]
    tabs = st.tabs(place_names)

    for tab, place in zip(tabs, current_graph.places):
        with tab:
            type_name = getattr(place.type, "__name__", str(place.type))
            st.caption(f"Type: {type_name}")

            if place.tokens:
                for i, token in enumerate(place.tokens):
                    if hasattr(token, "model_dump"):
                        st.json(token.model_dump())
            else:
                st.info("No tokens")

"""Streamlit app for the match up tokens Petri net example."""

import asyncio
import sys
import time
from pathlib import Path

# Add project root to path for imports when running directly
_project_root = Path(__file__).parent.parent.parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

import streamlit as st

from petritype.core.executable_graph_components import ExecutableGraphOperations

from petrilit import (
    compute_hierarchical_layout,
    generate_petri_net_svg,
    get_enabled_transitions,
    prepare_fire_animation,
)

from examples.toy.match_up_tokens.graph import create_initial_graph
from examples.toy.match_up_tokens.token_style import match_tokens_color


async def fire_single_transition():
    """Fire one transition and update the graph."""
    graph = st.session_state.graph
    try:
        updated_graph, fired = await ExecutableGraphOperations.execute_graph(
            graph,
            max_transitions=1,
            allow_token_copying=False,
            verbose=False,
        )
        st.session_state.graph = updated_graph
        st.session_state.transitions_fired += fired
        return fired
    except Exception as e:
        # If matching fails, stop auto-fire
        st.session_state.auto_fire_active = False
        st.error(f"Matching failed: {e}")
        return 0


# Streamlit app
st.set_page_config(page_title="Petritype - Match Up Tokens Example", layout="wide")

# Initialize session state
if "graph" not in st.session_state:
    st.session_state.graph = create_initial_graph()
if "positions" not in st.session_state:
    st.session_state.positions = compute_hierarchical_layout(st.session_state.graph)
if "animation_data" not in st.session_state:
    st.session_state.animation_data = None
if "transitions_fired" not in st.session_state:
    st.session_state.transitions_fired = 0
if "show_animation" not in st.session_state:
    st.session_state.show_animation = False
if "auto_fire_active" not in st.session_state:
    st.session_state.auto_fire_active = False


def reset_graph():
    """Reset the graph to initial state."""
    st.session_state.graph = create_initial_graph()
    st.session_state.positions = compute_hierarchical_layout(st.session_state.graph)
    st.session_state.animation_data = None
    st.session_state.transitions_fired = 0
    st.session_state.show_animation = False
    st.session_state.auto_fire_active = False


st.title("Petritype Graph Visualization")
st.markdown("### Match Up Tokens Example")

st.markdown(
    """
This example demonstrates matching strings to their lengths:
- **Circles (Blue)**: Place nodes that hold tokens
- **Rectangle (Green)**: Transition that matches strings to lengths
- **Small circles**: Tokens (blue=strings, orange=integers, green=matched pairs)
- Unmatched tokens circulate back, matched pairs accumulate in "Matched Pair"
"""
)

st.markdown("---")

# Control panel
st.subheader("Controls")
col1, col2, col3, col4, col5 = st.columns(5)

with col1:
    fire_clicked = st.button(
        "Fire Transition",
        type="primary",
        disabled=st.session_state.show_animation or st.session_state.auto_fire_active,
    )

with col2:
    # Toggle button for animated run all
    button_label = "Stop" if st.session_state.auto_fire_active else "Run All (Animated)"
    button_type = "secondary" if st.session_state.auto_fire_active else "primary"

    if st.button(
        button_label, type=button_type, disabled=st.session_state.show_animation
    ):
        st.session_state.auto_fire_active = not st.session_state.auto_fire_active
        st.rerun()

with col3:
    if st.button(
        "Run All (Instant)",
        disabled=st.session_state.show_animation or st.session_state.auto_fire_active,
    ):

        async def run_all():
            total = 0
            while True:
                fired = await fire_single_transition()
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
    st.metric("Fired", st.session_state.transitions_fired)

# Handle fire button click - prepare animation
if fire_clicked:
    enabled = get_enabled_transitions(st.session_state.graph)
    if enabled:
        transition = enabled[-1]
        st.session_state.animation_data = prepare_fire_animation(
            st.session_state.graph,
            transition,
            st.session_state.positions,
            token_color_fn=match_tokens_color,
        )
        st.session_state.show_animation = True
        # Don't rerun yet - let the page render with animation data

# Handle auto-fire mode - start firing if active and not already animating
if st.session_state.auto_fire_active and not st.session_state.show_animation:
    enabled = get_enabled_transitions(st.session_state.graph)
    if enabled:
        transition = enabled[-1]
        st.session_state.animation_data = prepare_fire_animation(
            st.session_state.graph,
            transition,
            st.session_state.positions,
            token_color_fn=match_tokens_color,
        )
        st.session_state.show_animation = True
    else:
        # No more transitions to fire - stop auto-fire
        st.session_state.auto_fire_active = False

# Show status
enabled_transitions = get_enabled_transitions(st.session_state.graph)
if enabled_transitions:
    st.success(f"Ready to fire: **{enabled_transitions[-1].name}**")
else:
    st.warning("No transitions enabled (no matching pairs found)")

st.markdown("---")

# Display the graph
svg_html = generate_petri_net_svg(
    st.session_state.graph,
    st.session_state.positions,
    st.session_state.animation_data,
    token_color_fn=match_tokens_color,
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
    asyncio.run(fire_single_transition())
    st.session_state.animation_data = None
    st.session_state.show_animation = False
    st.rerun()

# Legend
st.markdown(
    """
**Legend:**
- Place (circle) holds tokens
- Transition (rectangle) fires when matches are found
- Blue = String tokens (darker = longer)
- Orange = Integer tokens (darker = larger)
- Green = Matched pairs
"""
)

st.markdown("---")

# Graph details in expander
with st.expander("Graph Details"):
    col1, col2 = st.columns(2)

    with col1:
        st.markdown("**Places:**")
        for place in st.session_state.graph.places:
            type_name = getattr(place.type, "__name__", str(place.type))
            st.write(f"- **{place.name}** ({type_name}): {len(place.tokens)} tokens")

    with col2:
        st.markdown("**Transitions:**")
        for transition in st.session_state.graph.transitions:
            st.write(f"- **{transition.name}**: `{transition.function.__name__}()`")

with st.expander("View All Tokens", expanded=False):
    # Create tab labels with token counts
    place_names = [
        f"{p.name} ({len(p.tokens)})" for p in st.session_state.graph.places
    ]
    tabs = st.tabs(place_names)

    for tab, place in zip(tabs, st.session_state.graph.places):
        with tab:
            type_name = getattr(place.type, "__name__", str(place.type))
            st.caption(f"Type: {type_name}")

            if place.tokens:
                for i, token in enumerate(place.tokens):
                    st.markdown(f"**Token {i+1}:** `{repr(token)}`")
            else:
                st.info("No tokens")

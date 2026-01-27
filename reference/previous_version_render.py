"""
REFERENCE CODE FROM STREAMLIT VERSION (petrilit)

This file is provided as reference only. It is NOT the implementation for Svelte.

This was the SVG generation code used in the Streamlit version of Petrilit.
It shows:
- How SVG layers were structured (edges, places, transitions, tokens)
- Token positioning and stacking logic within places
- Animation data structure for token movements
- Pan/zoom implementation with localStorage persistence

For the Svelte version (petrivelt), you will:
- Generate similar SVG structure but using Svelte components
- Use Svelte's reactive stores for state management
- Use Svelte's animation directives (animate:flip, tweened) for token movement
- Keep the same visual structure but with client-side reactive rendering

The layout logic (using grandalf) will stay in the backend - the frontend
just receives positioned coordinates and renders them.
"""

"""SVG rendering for Petri net visualization."""

import json
from typing import Any

from petritype.core.executable_graph_components import ExecutableGraph

from petrilit.animation import AnimationData
from petrilit.data_structures import (
    TokenColorFn,
    calculate_token_position,
    default_token_color,
    RenderableGraph,
)


def generate_petri_net_svg(
    graph: ExecutableGraph,
    positions: dict[str, tuple[float, float]],
    animation_data: AnimationData | dict | None = None,
    token_color_fn: TokenColorFn = default_token_color,
    width: int = 950,
    height: int = 750,
) -> str:
    """Generate an SVG representation of the Petri net with animated tokens.

    Args:
        graph: The ExecutableGraph to render
        positions: Dict mapping node names to (x, y) coordinates
        animation_data: Optional animation data for transition firing
        token_color_fn: Function to determine token colors
        width: SVG width in pixels
        height: SVG height in pixels

    Returns:
        HTML string containing SVG and JavaScript for rendering
    """
    # Layout configuration
    place_radius = 45
    token_radius = 8
    transition_width = 100
    transition_height = 30

    # Build place data with tokens
    places_data = []
    for place in graph.places:
        x, y = positions.get(place.name, (0, 0))
        tokens_data = []
        for i, token in enumerate(place.tokens):
            offset_x, offset_y = calculate_token_position(
                i, len(place.tokens), token_radius
            )
            tokens_data.append(
                {
                    "x": x + offset_x,
                    "y": y + offset_y,
                    "color": token_color_fn(token),
                    "id": f"token-{place.name.replace(' ', '-')}-{i}",
                }
            )
        places_data.append(
            {
                "name": place.name,
                "x": x,
                "y": y,
                "tokens": tokens_data,
                "type": getattr(place.type, "__name__", str(place.type)),
            }
        )

    # Build transition data
    transitions_data = []
    for transition in graph.transitions:
        x, y = positions.get(transition.name, (0, 0))
        transitions_data.append({"name": transition.name, "x": x, "y": y})

    # Build edges data
    edges_data = []
    for edge in graph.argument_edges:
        start = positions[edge.place_node_name]
        end = positions[edge.transition_node_name]
        edges_data.append(
            {
                "startX": start[0],
                "startY": start[1],
                "endX": end[0],
                "endY": end[1],
                "type": "argument",
                "label": edge.argument,
            }
        )

    for edge in graph.return_edges:
        start = positions[edge.transition_node_name]
        end = positions[edge.place_node_name]
        edges_data.append(
            {
                "startX": start[0],
                "startY": start[1],
                "endX": end[0],
                "endY": end[1],
                "type": "return",
                "label": "",
            }
        )

    # Animation configuration
    if animation_data is not None:
        # Handle both AnimationData objects and plain dicts
        if hasattr(animation_data, "to_js_dict"):
            anim_dict = animation_data.to_js_dict()
        else:
            anim_dict = animation_data
        anim_json = json.dumps(anim_dict)
    else:
        anim_json = "null"
    places_json = json.dumps(places_data)
    transitions_json = json.dumps(transitions_data)
    edges_json = json.dumps(edges_data)

    svg_html = f"""
    <div id="petri-net-container" style="width: {width}px; height: {height}px; margin: 0 auto; background: #F8F9FA; border-radius: 8px;">
        <svg id="petri-net-svg" width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#95A5A6" />
                </marker>
                <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="2" dy="2" stdDeviation="2" flood-opacity="0.2"/>
                </filter>
                <filter id="glow">
                    <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
                    <feMerge>
                        <feMergeNode in="coloredBlur"/>
                        <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                </filter>
            </defs>

            <!-- All content will be drawn by JavaScript -->
        </svg>
    </div>

    <style>
        #petri-net-svg {{
            font-family: 'Segoe UI', system-ui, sans-serif;
        }}
        .place-circle {{
            transition: filter 0.3s ease;
        }}
        .place-circle:hover {{
            filter: url(#glow);
        }}
        .transition-rect {{
            transition: fill 0.3s ease, filter 0.3s ease;
        }}
        .transition-rect.firing {{
            fill: #1ABC9C !important;
            filter: url(#glow);
        }}
        .token {{
            /* Tokens use transform for animation */
            transition: none;
        }}
        .token.animating {{
            transition: transform 0.8s ease-in-out, opacity 0.3s ease;
        }}
        .edge-line {{
            transition: stroke 0.3s ease, stroke-width 0.3s ease;
        }}
        .edge-line.active {{
            stroke: #E74C3C;
            stroke-width: 3px;
        }}
        .label {{
            pointer-events: none;
            user-select: none;
        }}
    </style>

    <script>
    (function() {{
        const svg = document.getElementById('petri-net-svg');
        const placeRadius = {place_radius};
        const tokenRadius = {token_radius};
        const transitionWidth = {transition_width};
        const transitionHeight = {transition_height};

        const placesData = {places_json};
        const transitionsData = {transitions_json};
        const edgesData = {edges_json};
        const animationData = {anim_json};

        // Create layers
        const edgesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        edgesLayer.id = 'edges-layer';
        svg.appendChild(edgesLayer);

        const placesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        placesLayer.id = 'places-layer';
        svg.appendChild(placesLayer);

        const transitionsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        transitionsLayer.id = 'transitions-layer';
        svg.appendChild(transitionsLayer);

        const tokensLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        tokensLayer.id = 'tokens-layer';
        svg.appendChild(tokensLayer);

        // Draw edges
        edgesData.forEach((edge, i) => {{
            // Calculate edge endpoints accounting for node boundaries
            // For top-to-bottom layout: edges connect to bottom of source, top of target
            const dx = edge.endX - edge.startX;
            const dy = edge.endY - edge.startY;
            const angle = Math.atan2(dy, dx);

            let startX, startY, endX, endY;

            if (edge.type === 'argument') {{
                // From place circle (bottom) to transition (top)
                startX = edge.startX + Math.cos(angle) * placeRadius;
                startY = edge.startY + Math.sin(angle) * placeRadius;
                // Connect to top of transition rectangle
                endX = edge.endX;
                endY = edge.endY - transitionHeight/2 - 5;
            }} else {{
                // From transition (bottom) to place circle (top)
                startX = edge.startX;
                startY = edge.startY + transitionHeight/2 + 5;
                const dx2 = edge.endX - startX;
                const dy2 = edge.endY - startY;
                const angle2 = Math.atan2(dy2, dx2);
                endX = edge.endX - Math.cos(angle2) * (placeRadius + 5);
                endY = edge.endY - Math.sin(angle2) * (placeRadius + 5);
            }}

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', startX);
            line.setAttribute('y1', startY);
            line.setAttribute('x2', endX);
            line.setAttribute('y2', endY);
            line.setAttribute('stroke', '#95A5A6');
            line.setAttribute('stroke-width', '2');
            line.setAttribute('marker-end', 'url(#arrowhead)');
            line.setAttribute('class', 'edge-line');
            line.id = `edge-${{i}}`;
            edgesLayer.appendChild(line);
        }});

        // Draw places
        placesData.forEach(place => {{
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.id = `place-${{place.name.replace(/\\s+/g, '-')}}`;

            // Main circle
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', place.x);
            circle.setAttribute('cy', place.y);
            circle.setAttribute('r', placeRadius);
            circle.setAttribute('fill', '#EBF5FB');
            circle.setAttribute('stroke', '#3498DB');
            circle.setAttribute('stroke-width', '3');
            circle.setAttribute('class', 'place-circle');
            circle.setAttribute('filter', 'url(#shadow)');
            g.appendChild(circle);

            // Place label
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', place.x);
            label.setAttribute('y', place.y + placeRadius + 18);
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('class', 'label');
            label.setAttribute('font-size', '11');
            label.setAttribute('font-weight', '600');
            label.setAttribute('fill', '#2C3E50');
            label.textContent = place.name;
            g.appendChild(label);

            // Token count
            const count = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            count.setAttribute('x', place.x);
            count.setAttribute('y', place.y + placeRadius + 32);
            count.setAttribute('text-anchor', 'middle');
            count.setAttribute('class', 'label');
            count.setAttribute('font-size', '10');
            count.setAttribute('fill', '#7F8C8D');
            count.textContent = `[${{place.tokens.length}}]`;
            count.id = `count-${{place.name.replace(/\\s+/g, '-')}}`;
            g.appendChild(count);

            placesLayer.appendChild(g);
        }});

        // Draw transitions
        transitionsData.forEach(transition => {{
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.id = `transition-${{transition.name.replace(/\\s+/g, '-')}}`;

            // Main rectangle
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', transition.x - transitionWidth/2);
            rect.setAttribute('y', transition.y - transitionHeight/2);
            rect.setAttribute('width', transitionWidth);
            rect.setAttribute('height', transitionHeight);
            rect.setAttribute('fill', '#2ECC71');
            rect.setAttribute('stroke', '#27AE60');
            rect.setAttribute('stroke-width', '2');
            rect.setAttribute('rx', '4');
            rect.setAttribute('class', 'transition-rect');
            rect.setAttribute('filter', 'url(#shadow)');
            g.appendChild(rect);

            // Transition label (inside rectangle)
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', transition.x);
            label.setAttribute('y', transition.y + 4);
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('dominant-baseline', 'middle');
            label.setAttribute('class', 'label');
            label.setAttribute('font-size', '11');
            label.setAttribute('font-weight', '600');
            label.setAttribute('fill', '#FFFFFF');
            label.textContent = transition.name;
            g.appendChild(label);

            transitionsLayer.appendChild(g);
        }});

        // Draw tokens
        placesData.forEach(place => {{
            place.tokens.forEach(token => {{
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', token.x);
                circle.setAttribute('cy', token.y);
                circle.setAttribute('r', tokenRadius);
                circle.setAttribute('fill', token.color);
                circle.setAttribute('stroke', '#2C3E50');
                circle.setAttribute('stroke-width', '1.5');
                circle.setAttribute('class', 'token');
                circle.id = token.id;
                // Store original position for animation calculations
                circle.dataset.originalX = token.x;
                circle.dataset.originalY = token.y;
                tokensLayer.appendChild(circle);
            }});
        }});

        // Handle animation
        if (animationData && animationData.type === 'fire') {{
            const transitionPos = animationData.transition_pos;
            const inputTokens = animationData.input_tokens || [];
            const outputTokens = animationData.output_tokens || [];

            // Highlight the firing transition
            const transRect = document.querySelector(`#transition-${{animationData.transition.replace(/\\s+/g, '-')}} rect`);
            if (transRect) {{
                transRect.classList.add('firing');
            }}

            // Phase 1: Move input tokens to transition (simultaneously)
            inputTokens.forEach(tokenInfo => {{
                const tokenEl = document.getElementById(tokenInfo.id);
                if (tokenEl) {{
                    const currentX = parseFloat(tokenEl.dataset.originalX);
                    const currentY = parseFloat(tokenEl.dataset.originalY);

                    // Calculate translation to transition center
                    const translateX = transitionPos.x - currentX;
                    const translateY = transitionPos.y - currentY;

                    // Add animating class to enable transition
                    tokenEl.classList.add('animating');

                    // Apply transform after a tiny delay to trigger CSS transition
                    requestAnimationFrame(() => {{
                        requestAnimationFrame(() => {{
                            tokenEl.style.transform = `translate(${{translateX}}px, ${{translateY}}px)`;
                        }});
                    }});

                    // Fade out near the end
                    setTimeout(() => {{
                        tokenEl.style.opacity = '0';
                    }}, 600);
                }}
            }});

            // Phase 2: After input tokens arrive, create and move output tokens
            setTimeout(() => {{
                outputTokens.forEach(tokenInfo => {{
                    // Create new token at transition
                    const newToken = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    newToken.setAttribute('cx', transitionPos.x);
                    newToken.setAttribute('cy', transitionPos.y);
                    newToken.setAttribute('r', tokenRadius);
                    newToken.setAttribute('fill', tokenInfo.color);
                    newToken.setAttribute('stroke', '#2C3E50');
                    newToken.setAttribute('stroke-width', '1.5');
                    newToken.setAttribute('class', 'token');
                    newToken.style.opacity = '0';
                    newToken.dataset.originalX = transitionPos.x;
                    newToken.dataset.originalY = transitionPos.y;
                    tokensLayer.appendChild(newToken);

                    // Calculate translation to destination
                    const translateX = tokenInfo.destX - transitionPos.x;
                    const translateY = tokenInfo.destY - transitionPos.y;

                    // Fade in
                    requestAnimationFrame(() => {{
                        newToken.style.opacity = '1';
                        newToken.classList.add('animating');

                        // Start moving after fade in
                        requestAnimationFrame(() => {{
                            requestAnimationFrame(() => {{
                                newToken.style.transform = `translate(${{translateX}}px, ${{translateY}}px)`;
                            }});
                        }});
                    }});
                }});
            }}, 900); // Start output animation after input tokens reach transition
        }}
    }})();
    </script>
    """

    return svg_html


def generate_svg_from_renderable(
    renderable: RenderableGraph,
    width: int = 950,
    height: int = 750,
) -> str:
    """Generate an SVG representation from a RenderableGraph.

    This function is used when visualizing graphs from JSON data where
    positions and token data are already computed.

    Supports pan and zoom: users can scroll to zoom and drag to pan.
    The diagram is initially fit to view, but can extend beyond the viewport.

    Args:
        renderable: RenderableGraph with all positions and token data
        width: SVG viewport width in pixels
        height: SVG viewport height in pixels

    Returns:
        HTML string containing SVG and JavaScript for rendering
    """
    # Layout configuration
    place_radius = 45
    token_radius = 8
    transition_width = 100
    transition_height = 30

    # Calculate bounds of the diagram
    all_x = []
    all_y = []
    for place in renderable.places:
        all_x.append(place.x)
        all_y.append(place.y)
    for trans in renderable.transitions:
        all_x.append(trans.x)
        all_y.append(trans.y)

    if all_x and all_y:
        min_x = min(all_x) - place_radius - 100
        max_x = max(all_x) + place_radius + 100
        min_y = min(all_y) - place_radius - 100
        max_y = max(all_y) + place_radius + 100
        diagram_width = max_x - min_x
        diagram_height = max_y - min_y
    else:
        min_x, min_y = 0, 0
        diagram_width, diagram_height = width, height

    # Convert RenderableGraph to data structures for JavaScript
    places_data = []
    for place in renderable.places:
        tokens_data = [
            {
                "x": token.x,
                "y": token.y,
                "color": token.color,
                "id": token.id,
            }
            for token in place.tokens
        ]
        places_data.append(
            {
                "name": place.name,
                "x": place.x,
                "y": place.y,
                "tokens": tokens_data,
                "type": place.type_name,
            }
        )

    transitions_data = [
        {"name": trans.name, "x": trans.x, "y": trans.y}
        for trans in renderable.transitions
    ]

    edges_data = [
        {
            "startX": edge.start_x,
            "startY": edge.start_y,
            "endX": edge.end_x,
            "endY": edge.end_y,
            "type": edge.edge_type,
            "label": edge.label,
        }
        for edge in renderable.edges
    ]

    # No animation support for now
    anim_json = "null"
    places_json = json.dumps(places_data)
    transitions_json = json.dumps(transitions_data)
    edges_json = json.dumps(edges_data)

    # ViewBox for the SVG - shows the entire diagram initially
    viewbox_str = f"{min_x} {min_y} {diagram_width} {diagram_height}"

    svg_html = f"""
    <div id="petri-net-container" style="position: relative; width: {width}px; height: {height}px; margin: 0 auto; background: #F8F9FA; border-radius: 8px;">
        <div id="zoom-controls" style="position: absolute; top: 10px; right: 10px; z-index: 100; display: flex; gap: 5px;">
            <button id="fit-to-view-btn" style="padding: 8px 12px; background: white; border: 2px solid #3498DB; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; color: #3498DB;">Fit to View</button>
            <button id="reset-zoom-btn" style="padding: 8px 12px; background: white; border: 2px solid #3498DB; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; color: #3498DB;">Reset Zoom</button>
        </div>
        <svg id="petri-net-svg" width="{width}" height="{height}" viewBox="{viewbox_str}" xmlns="http://www.w3.org/2000/svg" style="cursor: grab;">
            <defs>
                <marker id="arrowhead-input" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#7F8C8D" />
                </marker>
                <marker id="arrowhead-output" markerWidth="12" markerHeight="9" refX="10" refY="4.5" orient="auto">
                    <polygon points="0 0, 12 4.5, 0 9" fill="#27AE60" />
                </marker>
                <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="2" dy="2" stdDeviation="2" flood-opacity="0.2"/>
                </filter>
                <filter id="glow">
                    <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
                    <feMerge>
                        <feMergeNode in="coloredBlur"/>
                        <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                </filter>
            </defs>

            <!-- All content will be drawn by JavaScript -->
        </svg>
    </div>

    <style>
        #petri-net-svg {{
            font-family: 'Segoe UI', system-ui, sans-serif;
        }}
        .place-circle {{
            transition: filter 0.3s ease;
        }}
        .place-circle:hover {{
            filter: url(#glow);
        }}
        .transition-rect {{
            transition: fill 0.3s ease, filter 0.3s ease;
        }}
        .transition-rect.firing {{
            fill: #1ABC9C !important;
            filter: url(#glow);
        }}
        .token {{
            /* No animation by default */
            transition: opacity 0.2s ease-out;
        }}
        .token.hidden {{
            opacity: 0;
        }}
        .label {{
            pointer-events: none;
            user-select: none;
        }}
        #zoom-controls button {{
            transition: all 0.2s ease;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        #zoom-controls button:hover {{
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(0,0,0,0.15);
        }}
        #zoom-controls button:active {{
            transform: translateY(0);
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
    </style>

    <script>
    (function() {{
        const svg = document.getElementById('petri-net-svg');
        const placeRadius = {place_radius};
        const tokenRadius = {token_radius};
        const transitionWidth = {transition_width};
        const transitionHeight = {transition_height};

        const placesData = {places_json};
        const transitionsData = {transitions_json};
        const edgesData = {edges_json};

        // Create layers
        const edgesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        edgesLayer.id = 'edges-layer';
        svg.appendChild(edgesLayer);

        const placesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        placesLayer.id = 'places-layer';
        svg.appendChild(placesLayer);

        const transitionsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        transitionsLayer.id = 'transitions-layer';
        svg.appendChild(transitionsLayer);

        const tokensLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        tokensLayer.id = 'tokens-layer';
        svg.appendChild(tokensLayer);

        const labelsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        labelsLayer.id = 'labels-layer';
        svg.appendChild(labelsLayer);

        // Draw edges
        edgesData.forEach(edge => {{
            // Calculate edge endpoints accounting for node boundaries
            const dx = edge.endX - edge.startX;
            const dy = edge.endY - edge.startY;
            const angle = Math.atan2(dy, dx);

            let startX, startY, endX, endY;

            if (edge.type === 'argument') {{
                // From place circle to transition rectangle
                // Start from edge of place circle
                startX = edge.startX + Math.cos(angle) * placeRadius;
                startY = edge.startY + Math.sin(angle) * placeRadius;
                // End at edge of transition rectangle (with offset for arrow)
                endX = edge.endX - Math.cos(angle) * (transitionWidth/2 + 10);
                endY = edge.endY - Math.sin(angle) * (transitionHeight/2 + 10);
            }} else {{
                // From transition rectangle to place circle
                // Start from edge of transition rectangle
                startX = edge.startX + Math.cos(angle) * (transitionWidth/2);
                startY = edge.startY + Math.sin(angle) * (transitionHeight/2);
                // End at edge of place circle (with offset for arrow)
                endX = edge.endX - Math.cos(angle) * (placeRadius + 10);
                endY = edge.endY - Math.sin(angle) * (placeRadius + 10);
            }}

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', startX);
            line.setAttribute('y1', startY);
            line.setAttribute('x2', endX);
            line.setAttribute('y2', endY);

            // Use different styling for argument vs return edges
            if (edge.type === 'argument') {{
                line.setAttribute('stroke', '#7F8C8D');
                line.setAttribute('stroke-width', '2');
                line.setAttribute('marker-end', 'url(#arrowhead-input)');
            }} else {{
                line.setAttribute('stroke', '#27AE60');
                line.setAttribute('stroke-width', '2.5');
                line.setAttribute('marker-end', 'url(#arrowhead-output)');
            }}

            line.setAttribute('class', 'edge-line');
            edgesLayer.appendChild(line);

            // Label for argument edges (use adjusted endpoints for positioning)
            if (edge.label && edge.label !== '') {{
                const midX = (startX + endX) / 2;
                const midY = (startY + endY) / 2;

                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', midX);
                text.setAttribute('y', midY - 5);
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('class', 'label');
                text.setAttribute('fill', '#555');
                text.setAttribute('font-size', '11px');
                text.textContent = edge.label;
                labelsLayer.appendChild(text);
            }}
        }});

        // Draw places
        placesData.forEach(place => {{
            const placeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            placeGroup.id = `place-${{place.name.replace(/\\s+/g, '-')}}`;

            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', place.x);
            circle.setAttribute('cy', place.y);
            circle.setAttribute('r', placeRadius);
            circle.setAttribute('fill', '#3498DB');
            circle.setAttribute('stroke', '#2C3E50');
            circle.setAttribute('stroke-width', '2.5');
            circle.setAttribute('class', 'place-circle');
            circle.setAttribute('filter', 'url(#shadow)');
            placeGroup.appendChild(circle);

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', place.x);
            text.setAttribute('y', place.y - placeRadius - 8);
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('class', 'label');
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('fill', '#2C3E50');
            text.textContent = place.name;
            placeGroup.appendChild(text);

            placesLayer.appendChild(placeGroup);

            // Draw tokens
            place.tokens.forEach(token => {{
                const tokenCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                tokenCircle.setAttribute('id', token.id);
                tokenCircle.setAttribute('cx', token.x);
                tokenCircle.setAttribute('cy', token.y);
                tokenCircle.setAttribute('r', tokenRadius);
                tokenCircle.setAttribute('fill', token.color);
                tokenCircle.setAttribute('stroke', '#2C3E50');
                tokenCircle.setAttribute('stroke-width', '1.5');
                tokenCircle.setAttribute('class', 'token');
                tokensLayer.appendChild(tokenCircle);
            }});
        }});

        // Draw transitions
        transitionsData.forEach(transition => {{
            const transGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            transGroup.id = `transition-${{transition.name.replace(/\\s+/g, '-')}}`;

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', transition.x - transitionWidth / 2);
            rect.setAttribute('y', transition.y - transitionHeight / 2);
            rect.setAttribute('width', transitionWidth);
            rect.setAttribute('height', transitionHeight);
            rect.setAttribute('fill', '#2ECC71');
            rect.setAttribute('stroke', '#27AE60');
            rect.setAttribute('stroke-width', '2.5');
            rect.setAttribute('class', 'transition-rect');
            rect.setAttribute('filter', 'url(#shadow)');
            rect.setAttribute('rx', '4');
            transGroup.appendChild(rect);

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', transition.x);
            text.setAttribute('y', transition.y + 4);
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('class', 'label');
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('fill', 'white');
            text.setAttribute('font-size', '12px');
            text.textContent = transition.name;
            transGroup.appendChild(text);

            transitionsLayer.appendChild(transGroup);
        }});

        // Add 2-stage flow animation if data-animate attribute is present
        const container = document.getElementById('petri-net-container');
        if (container && container.dataset.animate === 'true') {{
            try {{
                const animData = JSON.parse(container.dataset.animation || '{{}}');
                const transitionName = animData.transition_name;
                const inputPlaces = animData.input_places || [];
                const outputPlaces = animData.output_places || [];

                // Debug logging
                console.log('Animation data:', {{
                    transition: transitionName,
                    inputs: inputPlaces,
                    outputs: outputPlaces
                }});

                // Find transition position
                const transition = transitionsData.find(t => t.name === transitionName);
                if (!transition) return;

                const transX = transition.x;
                const transY = transition.y;

                // Hide tokens in output places initially (they'll appear when animation arrives)
                outputPlaces.forEach(placeName => {{
                    const place = placesData.find(p => p.name === placeName);
                    if (!place) return;

                    // Find all token elements for this place
                    place.tokens.forEach(token => {{
                        const tokenEl = document.getElementById(token.id);
                        if (tokenEl) {{
                            tokenEl.classList.add('hidden');
                        }}
                    }});
                }});

                // Highlight the firing transition
                const transRect = document.querySelector(`#transition-${{transitionName.replace(/\\s+/g, '-')}} rect`);
                if (transRect) {{
                    transRect.classList.add('firing');
                    setTimeout(() => transRect.classList.remove('firing'), 1500);
                }}

                // Calculate delay for Stage 2 based on whether there are input places
                const hasInputs = inputPlaces.length > 0;
                const stage1Duration = hasInputs ? 700 : 100; // Skip stage 1 delay if no inputs

                // Stage 1: Animate from input places to transition (only if there are input places)
                if (hasInputs) {{
                    setTimeout(() => {{
                        inputPlaces.forEach((placeName, index) => {{
                            const place = placesData.find(p => p.name === placeName);
                            if (!place) return;

                            setTimeout(() => {{
                                const particle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                                particle.setAttribute('r', '8');
                                particle.setAttribute('fill', '#3498DB');
                                particle.setAttribute('opacity', '0.9');
                                particle.setAttribute('stroke', '#2C3E50');
                                particle.setAttribute('stroke-width', '2');

                                const duration = 600;
                                const startTime = Date.now();

                                function animateToTransition() {{
                                    const elapsed = Date.now() - startTime;
                                    const progress = Math.min(elapsed / duration, 1);

                                    // Ease-in
                                    const eased = progress * progress;

                                    const x = place.x + (transX - place.x) * eased;
                                    const y = place.y + (transY - place.y) * eased;

                                    particle.setAttribute('cx', x);
                                    particle.setAttribute('cy', y);

                                    if (progress < 1) {{
                                        requestAnimationFrame(animateToTransition);
                                    }} else {{
                                        // Fade out at transition
                                        particle.setAttribute('opacity', '0');
                                        setTimeout(() => particle.remove(), 200);
                                    }}
                                }}

                                tokensLayer.appendChild(particle);
                                animateToTransition();
                            }}, index * 100);
                        }});
                    }}, 100);
                }}

                // Stage 2: Animate from transition to output places
                setTimeout(() => {{
                    outputPlaces.forEach((placeName, index) => {{
                        const place = placesData.find(p => p.name === placeName);
                        if (!place) return;

                        setTimeout(() => {{
                            const particle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                            particle.setAttribute('r', '8');
                            particle.setAttribute('fill', '#27AE60');
                            particle.setAttribute('opacity', '0');
                            particle.setAttribute('stroke', '#1E8449');
                            particle.setAttribute('stroke-width', '2');
                            particle.setAttribute('cx', transX);
                            particle.setAttribute('cy', transY);

                            const duration = 600;
                            const startTime = Date.now();

                            // Fade in first
                            setTimeout(() => {{
                                particle.setAttribute('opacity', '0.9');
                            }}, 50);

                            function animateToOutput() {{
                                const elapsed = Date.now() - startTime;
                                const progress = Math.min(elapsed / duration, 1);

                                // Ease-out
                                const eased = 1 - Math.pow(1 - progress, 2);

                                const x = transX + (place.x - transX) * eased;
                                const y = transY + (place.y - transY) * eased;

                                particle.setAttribute('cx', x);
                                particle.setAttribute('cy', y);

                                if (progress < 1) {{
                                    requestAnimationFrame(animateToOutput);
                                }} else {{
                                    // Fade out particle at destination
                                    particle.setAttribute('opacity', '0');
                                    setTimeout(() => particle.remove(), 200);

                                    // Show the actual tokens in this place now that animation arrived
                                    place.tokens.forEach(token => {{
                                        const tokenEl = document.getElementById(token.id);
                                        if (tokenEl && tokenEl.classList.contains('hidden')) {{
                                            tokenEl.classList.remove('hidden');
                                            // Opacity transition will fade them in smoothly (defined in CSS)
                                        }}
                                    }});
                                }}
                            }}

                            tokensLayer.appendChild(particle);
                            setTimeout(() => animateToOutput(), 100);
                        }}, index * 100);
                    }});
                }}, stage1Duration); // Start immediately if no inputs, or after stage 1 if there are inputs
            }} catch (e) {{
                console.error('Animation error:', e);
            }}
        }}

        // ===== Pan and Zoom Implementation =====

        // Store initial viewBox (for "Fit to View")
        const initialViewBox = {{
            x: {min_x},
            y: {min_y},
            width: {diagram_width},
            height: {diagram_height}
        }};

        // Current viewBox state - restore from localStorage if available
        const storageKey = 'petrilit-viewbox-state';
        let currentViewBox;
        try {{
            const saved = localStorage.getItem(storageKey);
            if (saved) {{
                currentViewBox = JSON.parse(saved);
                // Validate saved data
                if (!currentViewBox.x || !currentViewBox.y || !currentViewBox.width || !currentViewBox.height) {{
                    currentViewBox = {{ ...initialViewBox }};
                }}
            }} else {{
                currentViewBox = {{ ...initialViewBox }};
            }}
        }} catch (e) {{
            currentViewBox = {{ ...initialViewBox }};
        }}

        // Initialize the view
        updateViewBox();

        // Zoom limits based on place radius
        // Min: place appears ~5px radius, Max: place appears ~200px radius
        const minZoom = ({place_radius} / 200);  // Can zoom out until node is 5px
        const maxZoom = ({place_radius} / 5);    // Can zoom in until node is 200px

        function updateViewBox() {{
            svg.setAttribute('viewBox',
                `${{currentViewBox.x}} ${{currentViewBox.y}} ${{currentViewBox.width}} ${{currentViewBox.height}}`
            );
            // Save to localStorage
            try {{
                localStorage.setItem(storageKey, JSON.stringify(currentViewBox));
            }} catch (e) {{
                // Ignore localStorage errors
            }}
        }}

        // Mouse wheel zoom
        svg.addEventListener('wheel', (e) => {{
            e.preventDefault();

            // Get mouse position in SVG coordinates
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

            // Zoom factor - 2% per step
            const zoomFactor = e.deltaY > 0 ? 1.02 : 0.98;

            // Calculate new viewBox dimensions
            const newWidth = currentViewBox.width * zoomFactor;
            const newHeight = currentViewBox.height * zoomFactor;

            // Check zoom limits
            const currentZoom = initialViewBox.width / currentViewBox.width;
            const newZoom = initialViewBox.width / newWidth;
            if (newZoom < minZoom || newZoom > maxZoom) {{
                return; // Outside zoom limits
            }}

            // Adjust position to zoom towards mouse
            const mouseRatioX = (svgP.x - currentViewBox.x) / currentViewBox.width;
            const mouseRatioY = (svgP.y - currentViewBox.y) / currentViewBox.height;

            currentViewBox.width = newWidth;
            currentViewBox.height = newHeight;
            currentViewBox.x = svgP.x - mouseRatioX * newWidth;
            currentViewBox.y = svgP.y - mouseRatioY * newHeight;

            updateViewBox();
        }});

        // Drag to pan
        let isPanning = false;
        let startPoint = {{ x: 0, y: 0 }};
        let startViewBox = {{ x: 0, y: 0 }};

        svg.addEventListener('mousedown', (e) => {{
            if (e.button === 0) {{ // Left click only
                isPanning = true;
                svg.style.cursor = 'grabbing';

                const pt = svg.createSVGPoint();
                pt.x = e.clientX;
                pt.y = e.clientY;
                const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

                startPoint = {{ x: svgP.x, y: svgP.y }};
                startViewBox = {{ x: currentViewBox.x, y: currentViewBox.y }};
            }}
        }});

        svg.addEventListener('mousemove', (e) => {{
            if (isPanning) {{
                const pt = svg.createSVGPoint();
                pt.x = e.clientX;
                pt.y = e.clientY;
                const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

                const dx = svgP.x - startPoint.x;
                const dy = svgP.y - startPoint.y;

                currentViewBox.x = startViewBox.x - dx;
                currentViewBox.y = startViewBox.y - dy;

                updateViewBox();
            }}
        }});

        svg.addEventListener('mouseup', () => {{
            if (isPanning) {{
                isPanning = false;
                svg.style.cursor = 'grab';
            }}
        }});

        svg.addEventListener('mouseleave', () => {{
            if (isPanning) {{
                isPanning = false;
                svg.style.cursor = 'grab';
            }}
        }});

        // Fit to View button
        const fitBtn = document.getElementById('fit-to-view-btn');
        if (fitBtn) {{
            fitBtn.addEventListener('click', () => {{
                currentViewBox = {{ ...initialViewBox }};
                updateViewBox();
                // Clear saved state so next reload also shows fit to view
                try {{
                    localStorage.removeItem(storageKey);
                }} catch (e) {{}}
            }});

            fitBtn.addEventListener('mouseenter', () => {{
                fitBtn.style.background = '#3498DB';
                fitBtn.style.color = 'white';
            }});

            fitBtn.addEventListener('mouseleave', () => {{
                fitBtn.style.background = 'white';
                fitBtn.style.color = '#3498DB';
            }});
        }}

        // Reset Zoom button (1:1 zoom at center)
        const resetBtn = document.getElementById('reset-zoom-btn');
        if (resetBtn) {{
            resetBtn.addEventListener('click', () => {{
                // Reset to 1:1 zoom, centered on diagram
                currentViewBox.width = initialViewBox.width;
                currentViewBox.height = initialViewBox.height;
                currentViewBox.x = initialViewBox.x;
                currentViewBox.y = initialViewBox.y;
                updateViewBox();
            }});

            resetBtn.addEventListener('mouseenter', () => {{
                resetBtn.style.background = '#3498DB';
                resetBtn.style.color = 'white';
            }});

            resetBtn.addEventListener('mouseleave', () => {{
                resetBtn.style.background = 'white';
                resetBtn.style.color = '#3498DB';
            }});
        }}
    }})();
    </script>
    """

    return svg_html

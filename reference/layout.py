"""
REFERENCE CODE FROM STREAMLIT VERSION (petrilit)

This file shows how graph layout is calculated using grandalf.

For the Svelte version:
- This layout logic will stay in the petritype-server backend
- The backend sends positioned coordinates to the frontend
- The frontend just renders nodes/edges at the given positions
- No need to reimplement layout logic in JavaScript
"""

"""Layout algorithms for Petri net visualization."""

from grandalf.graphs import Vertex, Edge, Graph
from grandalf.layouts import SugiyamaLayout

from petritype.core.executable_graph_components import ExecutableGraph


class VertexView:
    """View class for grandalf vertices to store dimensions.

    This is required by grandalf's layout algorithm to know
    the size of each node when computing positions.

    Attributes:
        w: Width of the vertex
        h: Height of the vertex
        xy: Position tuple, set by the layout algorithm
    """

    def __init__(self, w: int = 100, h: int = 80):
        self.w = w
        self.h = h


def compute_hierarchical_layout(
    graph: ExecutableGraph,
    canvas_width: int = 950,
    canvas_height: int = 700,
    margin: int = 60,
) -> dict[str, tuple[float, float]]:
    """Compute hierarchical layout positions for a Petri net.

    Uses grandalf's Sugiyama algorithm to arrange nodes in layers,
    with places and transitions positioned to minimize edge crossings.

    The layout uses consistent spacing and does NOT scale to fit the canvas.
    Diagrams can extend beyond the viewport, requiring pan/zoom to navigate.

    Args:
        graph: The ExecutableGraph to layout
        canvas_width: Not used (kept for API compatibility)
        canvas_height: Not used (kept for API compatibility)
        margin: Margin around the edges of the layout

    Returns:
        Dictionary mapping node names to (x, y) coordinate tuples

    >>> from petritype.core.executable_graph_components import (
    ...     ListPlaceNode, FunctionTransitionNode, ArgumentEdgeToTransition,
    ...     ReturnedEdgeFromTransition, ExecutableGraphOperations
    ... )
    >>> def dummy_fn(x): return x
    >>> components = [
    ...     ListPlaceNode(name="Input", type=int, tokens=[1]),
    ...     ArgumentEdgeToTransition("Input", "Process", "x"),
    ...     FunctionTransitionNode(name="Process", function=dummy_fn),
    ...     ReturnedEdgeFromTransition("Process", "Output"),
    ...     ListPlaceNode(name="Output", type=int),
    ... ]
    >>> g = ExecutableGraphOperations.construct_graph(components)
    >>> positions = compute_hierarchical_layout(g)
    >>> "Input" in positions and "Process" in positions and "Output" in positions
    True
    """
    # Create grandalf vertices for all places and transitions
    vertices: dict[str, Vertex] = {}

    for place in graph.places:
        v = Vertex(place.name)
        v.view = VertexView(w=90, h=90)  # Place circles
        vertices[place.name] = v

    for transition in graph.transitions:
        v = Vertex(transition.name)
        v.view = VertexView(w=120, h=50)  # Transition rectangles (wide)
        vertices[transition.name] = v

    # Create grandalf edges
    edges: list[Edge] = []

    for arg_edge in graph.argument_edges:
        src = vertices[arg_edge.place_node_name]
        dst = vertices[arg_edge.transition_node_name]
        edges.append(Edge(src, dst))

    for ret_edge in graph.return_edges:
        src = vertices[ret_edge.transition_node_name]
        dst = vertices[ret_edge.place_node_name]
        edges.append(Edge(src, dst))

    # Create graph and compute layout
    g = Graph(list(vertices.values()), edges)

    # Use Sugiyama layout algorithm
    sug = SugiyamaLayout(g.C[0])  # C[0] is the first connected component
    sug.init_all(optimize=True)

    # Increase vertical spacing between layers to prevent overlap
    sug.yspace = 120  # Vertical space between layers (default is much smaller)
    sug.xspace = 80   # Horizontal space between nodes in same layer

    sug.draw()

    # Extract positions from vertices
    # Grandalf gives us coordinates - produces top-to-bottom hierarchical layout
    raw_positions = {}
    for name, vertex in vertices.items():
        # grandalf stores position in vertex.view.xy after draw()
        x, y = vertex.view.xy
        raw_positions[name] = (x, y)

    # Find bounds of the layout
    if not raw_positions:
        return {}

    xs = [p[0] for p in raw_positions.values()]
    ys = [p[1] for p in raw_positions.values()]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    # Don't scale - use consistent spacing
    # Just offset to positive coordinates with margin
    positions = {}
    for name, (x, y) in raw_positions.items():
        final_x = x - min_x + margin
        final_y = y - min_y + margin
        positions[name] = (final_x, final_y)

    return positions

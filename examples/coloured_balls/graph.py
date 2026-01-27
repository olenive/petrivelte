"""Graph construction for the coloured balls example."""

from petritype.core.executable_graph_components import (
    ArgumentEdgeToTransition,
    ExecutableGraph,
    ExecutableGraphOperations,
    FunctionTransitionNode,
    ListPlaceNode,
    ReturnedEdgeFromTransition,
)

from examples.coloured_balls.models import (
    Ball,
    Paint,
    Rubber,
    distribute_by_colour,
    make_a_ball,
)


def create_initial_graph() -> ExecutableGraph:
    """Create a fresh instance of the executable graph with initial tokens."""
    paint_inputs = [
        Paint(color="red"),
        Paint(color="blue"),
        Paint(color="green"),
        Paint(color="yellow"),
        Paint(color="red"),
        Paint(color="blue"),
        Paint(color="green"),
        Paint(color="yellow"),
        Paint(color="red"),
    ]
    rubber_inputs = [Rubber(quantity=i) for i in range(1, 11)]

    executable_graph_nodes_and_edges = [
        ListPlaceNode(name="Input Rubber", type=Rubber, tokens=rubber_inputs),
        ListPlaceNode(name="Input Paint", type=Paint, tokens=paint_inputs),
        ArgumentEdgeToTransition("Input Rubber", "Make a Ball", "rubber"),
        ArgumentEdgeToTransition("Input Paint", "Make a Ball", "paint"),
        FunctionTransitionNode(
            name="Make a Ball",
            function=make_a_ball,
            output_distribution_function=distribute_by_colour,
        ),
        ReturnedEdgeFromTransition("Make a Ball", "Red Balls"),
        ReturnedEdgeFromTransition("Make a Ball", "Blue Balls"),
        ReturnedEdgeFromTransition("Make a Ball", "Other Balls"),
        ListPlaceNode(name="Red Balls", type=Ball),
        ListPlaceNode(name="Blue Balls", type=Ball),
        ListPlaceNode(name="Other Balls", type=Ball),
    ]

    return ExecutableGraphOperations.construct_graph(executable_graph_nodes_and_edges)

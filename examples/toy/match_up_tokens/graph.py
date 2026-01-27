"""Graph construction for the match up tokens example."""

from petritype.core.executable_graph_components import (
    ArgumentEdgeToTransition,
    ExecutableGraph,
    ExecutableGraphOperations,
    FunctionTransitionNode,
    ListPlaceNode,
    ReturnedEdgeFromTransition,
)

from examples.toy.match_up_tokens.models import (
    distribute_result_tokens,
    match_one_string_to_one_length,
)


def create_initial_graph() -> ExecutableGraph:
    """Create the initial graph with strings and lengths to match."""
    # Initial tokens - strings and their potential length matches
    initial_strings = ["a", "ab", "abc", "abcd"]
    initial_lengths = [2, 3, 4, 5, 99]

    executable_graph_nodes_and_edges = [
        # Input places with initial tokens
        ListPlaceNode(name="Some Strings", type=str, tokens=initial_strings),
        ListPlaceNode(name="Some Lengths", type=int, tokens=initial_lengths),
        # Edges to transition
        ArgumentEdgeToTransition("Some Strings", "Match Lengths", "string"),
        ArgumentEdgeToTransition("Some Lengths", "Match Lengths", "length"),
        # Transition that matches strings to lengths
        FunctionTransitionNode(
            name="Match Lengths",
            function=match_one_string_to_one_length,
            output_distribution_function=distribute_result_tokens,
        ),
        # Return edges - unmatched tokens go back, matched pairs go to output
        ReturnedEdgeFromTransition("Match Lengths", "Some Strings"),
        ReturnedEdgeFromTransition("Match Lengths", "Some Lengths"),
        ReturnedEdgeFromTransition("Match Lengths", "Matched Pair"),
        # Output place for matched pairs
        ListPlaceNode(name="Matched Pair", type=tuple),
    ]

    return ExecutableGraphOperations.construct_graph(executable_graph_nodes_and_edges)

"""Shared test fixtures for Petrilit tests."""

import pytest

from petritype.core.executable_graph_components import (
    ArgumentEdgeToTransition,
    ExecutableGraph,
    ExecutableGraphOperations,
    FunctionTransitionNode,
    ListPlaceNode,
    ReturnedEdgeFromTransition,
)


def identity(x):
    """Simple identity function for testing."""
    return x


def add_one(x: int) -> int:
    """Add one to input."""
    return x + 1


def route_by_value(x: int) -> dict[str, int]:
    """Route based on value - for testing output distribution."""
    if x > 5:
        return {"High": x}
    else:
        return {"Low": x}


@pytest.fixture
def simple_graph() -> ExecutableGraph:
    """Create a simple graph: Input -> Process -> Output."""
    components = [
        ListPlaceNode(name="Input", type=int, tokens=[1, 2, 3]),
        ArgumentEdgeToTransition("Input", "Process", "x"),
        FunctionTransitionNode(name="Process", function=identity),
        ReturnedEdgeFromTransition("Process", "Output"),
        ListPlaceNode(name="Output", type=int),
    ]
    return ExecutableGraphOperations.construct_graph(components)


@pytest.fixture
def two_input_graph() -> ExecutableGraph:
    """Create a graph with two inputs: A, B -> Combine -> Output."""

    def combine(a: int, b: int) -> int:
        return a + b

    components = [
        ListPlaceNode(name="Input A", type=int, tokens=[1, 2]),
        ListPlaceNode(name="Input B", type=int, tokens=[10, 20]),
        ArgumentEdgeToTransition("Input A", "Combine", "a"),
        ArgumentEdgeToTransition("Input B", "Combine", "b"),
        FunctionTransitionNode(name="Combine", function=combine),
        ReturnedEdgeFromTransition("Combine", "Output"),
        ListPlaceNode(name="Output", type=int),
    ]
    return ExecutableGraphOperations.construct_graph(components)


@pytest.fixture
def distributing_graph() -> ExecutableGraph:
    """Create a graph with output distribution: Input -> Route -> High/Low."""
    components = [
        ListPlaceNode(name="Input", type=int, tokens=[3, 7, 2, 9]),
        ArgumentEdgeToTransition("Input", "Route", "x"),
        FunctionTransitionNode(
            name="Route",
            function=add_one,
            output_distribution_function=route_by_value,
        ),
        ReturnedEdgeFromTransition("Route", "High"),
        ReturnedEdgeFromTransition("Route", "Low"),
        ListPlaceNode(name="High", type=int),
        ListPlaceNode(name="Low", type=int),
    ]
    return ExecutableGraphOperations.construct_graph(components)


@pytest.fixture
def empty_input_graph() -> ExecutableGraph:
    """Create a graph with no tokens in input."""
    components = [
        ListPlaceNode(name="Input", type=int, tokens=[]),
        ArgumentEdgeToTransition("Input", "Process", "x"),
        FunctionTransitionNode(name="Process", function=identity),
        ReturnedEdgeFromTransition("Process", "Output"),
        ListPlaceNode(name="Output", type=int),
    ]
    return ExecutableGraphOperations.construct_graph(components)

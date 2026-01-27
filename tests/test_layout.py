"""Tests for petrilit.layout module."""

import pytest

from petrilit.layout import VertexView, compute_hierarchical_layout


class TestVertexView:
    """Tests for VertexView class."""

    def test_default_dimensions(self):
        view = VertexView()
        assert view.w == 100
        assert view.h == 80

    def test_custom_dimensions(self):
        view = VertexView(w=50, h=30)
        assert view.w == 50
        assert view.h == 30


class TestComputeHierarchicalLayout:
    """Tests for compute_hierarchical_layout function."""

    def test_returns_positions_for_all_nodes(self, simple_graph):
        """Should return positions for all places and transitions."""
        positions = compute_hierarchical_layout(simple_graph)

        # Should have positions for Input, Process, Output
        assert "Input" in positions
        assert "Process" in positions
        assert "Output" in positions
        assert len(positions) == 3

    def test_positions_are_tuples(self, simple_graph):
        """Each position should be a tuple of (x, y) floats."""
        positions = compute_hierarchical_layout(simple_graph)

        for name, pos in positions.items():
            assert isinstance(pos, tuple)
            assert len(pos) == 2
            assert isinstance(pos[0], (int, float))
            assert isinstance(pos[1], (int, float))

    def test_positions_within_canvas(self, simple_graph):
        """Positions should be within canvas bounds."""
        width, height = 950, 420
        margin = 80
        positions = compute_hierarchical_layout(
            simple_graph,
            canvas_width=width,
            canvas_height=height,
            margin=margin,
        )

        for name, (x, y) in positions.items():
            assert margin <= x <= width - margin, f"{name} x={x} out of bounds"
            assert margin <= y <= height - margin, f"{name} y={y} out of bounds"

    def test_custom_canvas_size(self, simple_graph):
        """Should respect custom canvas dimensions."""
        positions = compute_hierarchical_layout(
            simple_graph,
            canvas_width=500,
            canvas_height=300,
            margin=50,
        )

        for name, (x, y) in positions.items():
            assert 50 <= x <= 450
            assert 50 <= y <= 250

    def test_two_input_graph_layout(self, two_input_graph):
        """Should handle graphs with multiple inputs."""
        positions = compute_hierarchical_layout(two_input_graph)

        # Should have positions for: Input A, Input B, Combine, Output
        assert len(positions) == 4
        assert "Input A" in positions
        assert "Input B" in positions
        assert "Combine" in positions
        assert "Output" in positions

    def test_distributing_graph_layout(self, distributing_graph):
        """Should handle graphs with multiple outputs."""
        positions = compute_hierarchical_layout(distributing_graph)

        # Should have positions for: Input, Route, High, Low
        assert len(positions) == 4
        assert "Input" in positions
        assert "Route" in positions
        assert "High" in positions
        assert "Low" in positions

    def test_hierarchical_ordering(self, simple_graph):
        """Input should be above transition, which should be above output."""
        positions = compute_hierarchical_layout(simple_graph)

        # In a top-to-bottom layout, y increases downward
        # Input -> Process -> Output
        input_y = positions["Input"][1]
        process_y = positions["Process"][1]
        output_y = positions["Output"][1]

        assert input_y < process_y, "Input should be above Process"
        assert process_y < output_y, "Process should be above Output"

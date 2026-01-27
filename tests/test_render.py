"""Tests for petrilit.render module."""

import json

import pytest

from petrilit.animation import (
    AnimationData,
    AnimationOutputToken,
    AnimationTokenInfo,
)
from petrilit.data_structures import default_token_color
from petrilit.layout import compute_hierarchical_layout
from petrilit.render import generate_petri_net_svg


class TestGeneratePetriNetSvg:
    """Tests for generate_petri_net_svg function."""

    def test_returns_html_string(self, simple_graph):
        """Should return a non-empty HTML string."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(simple_graph, positions)

        assert isinstance(result, str)
        assert len(result) > 0

    def test_contains_svg_element(self, simple_graph):
        """Should contain an SVG element."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(simple_graph, positions)

        assert "<svg" in result
        assert "</svg>" in result

    def test_contains_place_names(self, simple_graph):
        """Should include place names in output."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(simple_graph, positions)

        assert "Input" in result
        assert "Output" in result

    def test_contains_transition_name(self, simple_graph):
        """Should include transition name in output."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(simple_graph, positions)

        assert "Process" in result

    def test_custom_dimensions(self, simple_graph):
        """Should respect custom width and height."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(
            simple_graph, positions, width=800, height=600
        )

        assert 'width="800"' in result
        assert 'height="600"' in result

    def test_custom_token_color_fn(self, simple_graph):
        """Should use provided token color function."""
        positions = compute_hierarchical_layout(simple_graph)

        def always_red(token):
            return "#FF0000"

        result = generate_petri_net_svg(
            simple_graph, positions, token_color_fn=always_red
        )

        # The color should appear in the JSON data embedded in the script
        assert "#FF0000" in result

    def test_no_animation_data(self, simple_graph):
        """Should handle None animation data."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(simple_graph, positions, animation_data=None)

        # Should contain 'null' for animation data in JS
        assert "const animationData = null" in result

    def test_with_animation_data_dict(self, simple_graph):
        """Should handle animation data as dict."""
        positions = compute_hierarchical_layout(simple_graph)

        anim_dict = {
            "type": "fire",
            "transition": "Process",
            "transition_pos": {"x": 100, "y": 100},
            "input_tokens": [],
            "output_tokens": [],
        }

        result = generate_petri_net_svg(
            simple_graph, positions, animation_data=anim_dict
        )

        assert '"type": "fire"' in result or "'type': 'fire'" in result

    def test_with_animation_data_object(self, simple_graph):
        """Should handle AnimationData object."""
        positions = compute_hierarchical_layout(simple_graph)

        anim = AnimationData(
            transition="Process",
            transition_pos_x=100.0,
            transition_pos_y=100.0,
            input_tokens=(),
            output_tokens=(),
        )

        result = generate_petri_net_svg(
            simple_graph, positions, animation_data=anim
        )

        # Should contain the transition name
        assert "Process" in result

    def test_contains_css_styles(self, simple_graph):
        """Should include CSS styles for animation."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(simple_graph, positions)

        assert "<style>" in result
        assert ".place-circle" in result
        assert ".transition-rect" in result
        assert ".token" in result

    def test_contains_svg_defs(self, simple_graph):
        """Should include SVG defs for markers and filters."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(simple_graph, positions)

        assert "<defs>" in result
        assert "arrowhead" in result
        assert "shadow" in result

    def test_two_input_graph(self, two_input_graph):
        """Should handle graphs with multiple inputs."""
        positions = compute_hierarchical_layout(two_input_graph)

        result = generate_petri_net_svg(two_input_graph, positions)

        assert "Input A" in result
        assert "Input B" in result
        assert "Combine" in result

    def test_json_data_is_valid(self, simple_graph):
        """The embedded JSON data should be valid."""
        positions = compute_hierarchical_layout(simple_graph)

        result = generate_petri_net_svg(simple_graph, positions)

        # Extract placesData JSON (rough extraction)
        # The format is: const placesData = [...];
        import re

        places_match = re.search(r"const placesData = (\[.*?\]);", result, re.DOTALL)
        assert places_match, "Could not find placesData in output"

        places_json = places_match.group(1)
        places_data = json.loads(places_json)

        assert isinstance(places_data, list)
        assert len(places_data) == 2  # Input and Output

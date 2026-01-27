"""Tests for petrilit.animation module."""

import pytest

from petrilit.animation import (
    AnimationData,
    AnimationOutputToken,
    AnimationTokenInfo,
    prepare_fire_animation,
)
from petrilit.data_structures import default_token_color
from petrilit.layout import compute_hierarchical_layout


class TestAnimationTokenInfo:
    """Tests for AnimationTokenInfo model."""

    def test_creation(self):
        token = AnimationTokenInfo(
            id="token-Input-0",
            color="#FF0000",
            x=100.0,
            y=100.0,
            place="Input",
        )
        assert token.id == "token-Input-0"
        assert token.color == "#FF0000"
        assert token.place == "Input"

    def test_immutable(self):
        token = AnimationTokenInfo(
            id="token-1", color="#FF0000", x=100.0, y=100.0, place="Input"
        )
        with pytest.raises(Exception):
            token.x = 200.0


class TestAnimationOutputToken:
    """Tests for AnimationOutputToken model."""

    def test_creation(self):
        token = AnimationOutputToken(
            color="#00FF00",
            dest_x=200.0,
            dest_y=200.0,
            dest_place="Output",
        )
        assert token.color == "#00FF00"
        assert token.dest_x == 200.0
        assert token.dest_place == "Output"


class TestAnimationData:
    """Tests for AnimationData model."""

    def test_creation(self):
        input_token = AnimationTokenInfo(
            id="t1", color="#FF0000", x=0.0, y=0.0, place="In"
        )
        output_token = AnimationOutputToken(
            color="#00FF00", dest_x=100.0, dest_y=100.0, dest_place="Out"
        )

        anim = AnimationData(
            transition="Process",
            transition_pos_x=50.0,
            transition_pos_y=50.0,
            input_tokens=(input_token,),
            output_tokens=(output_token,),
        )

        assert anim.type == "fire"
        assert anim.transition == "Process"
        assert len(anim.input_tokens) == 1
        assert len(anim.output_tokens) == 1

    def test_to_js_dict(self):
        """Should convert to JS-compatible dict format."""
        input_token = AnimationTokenInfo(
            id="t1", color="#FF0000", x=10.0, y=20.0, place="In"
        )
        output_token = AnimationOutputToken(
            color="#00FF00", dest_x=100.0, dest_y=200.0, dest_place="Out"
        )

        anim = AnimationData(
            transition="Process",
            transition_pos_x=50.0,
            transition_pos_y=60.0,
            input_tokens=(input_token,),
            output_tokens=(output_token,),
        )

        js_dict = anim.to_js_dict()

        assert js_dict["type"] == "fire"
        assert js_dict["transition"] == "Process"
        assert js_dict["transition_pos"] == {"x": 50.0, "y": 60.0}

        # Check input tokens format
        assert len(js_dict["input_tokens"]) == 1
        assert js_dict["input_tokens"][0]["id"] == "t1"
        assert js_dict["input_tokens"][0]["x"] == 10.0
        assert js_dict["input_tokens"][0]["place"] == "In"

        # Check output tokens format (camelCase)
        assert len(js_dict["output_tokens"]) == 1
        assert js_dict["output_tokens"][0]["destX"] == 100.0
        assert js_dict["output_tokens"][0]["destY"] == 200.0
        assert js_dict["output_tokens"][0]["destPlace"] == "Out"


class TestPrepareFireAnimation:
    """Tests for prepare_fire_animation function."""

    def test_simple_graph_animation(self, simple_graph):
        """Should prepare animation for simple graph."""
        positions = compute_hierarchical_layout(simple_graph)
        transition = simple_graph.transitions[0]

        anim = prepare_fire_animation(
            simple_graph, transition, positions, default_token_color
        )

        assert anim.type == "fire"
        assert anim.transition == "Process"
        assert len(anim.input_tokens) == 1
        assert anim.input_tokens[0].place == "Input"

    def test_two_input_animation(self, two_input_graph):
        """Should capture tokens from both input places."""
        positions = compute_hierarchical_layout(two_input_graph)
        transition = two_input_graph.transitions[0]

        anim = prepare_fire_animation(
            two_input_graph, transition, positions, default_token_color
        )

        assert len(anim.input_tokens) == 2
        input_places = {t.place for t in anim.input_tokens}
        assert input_places == {"Input A", "Input B"}

    def test_distributing_animation(self, distributing_graph):
        """Should predict output destination with distribution function."""
        positions = compute_hierarchical_layout(distributing_graph)
        transition = distributing_graph.transitions[0]

        anim = prepare_fire_animation(
            distributing_graph, transition, positions, default_token_color
        )

        # Should have one output token going to either High or Low
        assert len(anim.output_tokens) >= 1

    def test_custom_token_color_fn(self, simple_graph):
        """Should use provided token color function."""
        positions = compute_hierarchical_layout(simple_graph)
        transition = simple_graph.transitions[0]

        def red_color(token):
            return "#FF0000"

        anim = prepare_fire_animation(simple_graph, transition, positions, red_color)

        assert anim.input_tokens[0].color == "#FF0000"

    def test_transition_position_in_result(self, simple_graph):
        """Should include transition position in result."""
        positions = compute_hierarchical_layout(simple_graph)
        transition = simple_graph.transitions[0]

        anim = prepare_fire_animation(
            simple_graph, transition, positions, default_token_color
        )

        trans_pos = positions["Process"]
        assert anim.transition_pos_x == trans_pos[0]
        assert anim.transition_pos_y == trans_pos[1]

    def test_token_ids_match_svg_convention(self, simple_graph):
        """Token IDs should follow the SVG naming convention."""
        positions = compute_hierarchical_layout(simple_graph)
        transition = simple_graph.transitions[0]

        anim = prepare_fire_animation(
            simple_graph, transition, positions, default_token_color
        )

        # Token ID should be token-{place_name}-{index}
        # The last token (index = len-1) is consumed
        expected_id = "token-Input-2"  # 3 tokens, last one is index 2
        assert anim.input_tokens[0].id == expected_id

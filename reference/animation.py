"""
REFERENCE CODE FROM STREAMLIT VERSION (petrilit)

This file shows how animation data is calculated for token movements.

For the Svelte version:
- The backend will still calculate animation sequences like this
- But the frontend will receive them via WebSocket and apply using Svelte's
  tweened stores or animate directives instead of CSS transitions
"""

"""Animation data preparation for Petri net visualization."""

from pydantic import BaseModel

from petritype.core.executable_graph_components import (
    ExecutableGraph,
    FunctionTransitionNode,
)

from petrilit.data_structures import (
    TokenColorFn,
    calculate_token_position,
    default_token_color,
)
from petrilit.graph_queries import get_transition_io_places


class AnimationTokenInfo(BaseModel, frozen=True):
    """Information about a token being consumed in an animation.

    Attributes:
        id: Unique identifier matching the SVG element id
        color: Hex color string
        x: Current x position
        y: Current y position
        place: Name of the place this token is in
    """

    id: str
    color: str
    x: float
    y: float
    place: str


class AnimationOutputToken(BaseModel, frozen=True):
    """Information about a token being produced in an animation.

    Attributes:
        color: Hex color string for the new token
        dest_x: Destination x position
        dest_y: Destination y position
        dest_place: Name of the destination place
    """

    color: str
    dest_x: float
    dest_y: float
    dest_place: str


class AnimationData(BaseModel, frozen=True):
    """Complete animation data for a transition firing.

    Attributes:
        type: Animation type (currently always "fire")
        transition: Name of the firing transition
        transition_pos_x: X position of the transition
        transition_pos_y: Y position of the transition
        input_tokens: Tokens being consumed
        output_tokens: Tokens being produced
    """

    type: str = "fire"
    transition: str
    transition_pos_x: float
    transition_pos_y: float
    input_tokens: tuple[AnimationTokenInfo, ...]
    output_tokens: tuple[AnimationOutputToken, ...]

    def to_js_dict(self) -> dict:
        """Convert to dict format expected by the JavaScript animation code.

        Returns:
            Dict with structure matching the JS animation expectations.
        """
        return {
            "type": self.type,
            "transition": self.transition,
            "transition_pos": {"x": self.transition_pos_x, "y": self.transition_pos_y},
            "input_tokens": [
                {
                    "id": t.id,
                    "color": t.color,
                    "place": t.place,
                    "x": t.x,
                    "y": t.y,
                }
                for t in self.input_tokens
            ],
            "output_tokens": [
                {
                    "color": t.color,
                    "destX": t.dest_x,
                    "destY": t.dest_y,
                    "destPlace": t.dest_place,
                }
                for t in self.output_tokens
            ],
        }


def prepare_fire_animation(
    graph: ExecutableGraph,
    transition: FunctionTransitionNode,
    positions: dict[str, tuple[float, float]],
    token_color_fn: TokenColorFn = default_token_color,
) -> AnimationData:
    """Prepare animation data for firing a transition.

    This function computes where tokens will move from (input places)
    and where they will move to (output places) during a transition firing.
    It simulates the transition to predict output token destinations.

    Args:
        graph: The ExecutableGraph containing the Petri net state
        transition: The transition that will fire
        positions: Dict mapping node names to (x, y) coordinates
        token_color_fn: Function to determine token colors

    Returns:
        AnimationData with all information needed to animate the firing

    >>> from petritype.core.executable_graph_components import (
    ...     ListPlaceNode, ArgumentEdgeToTransition,
    ...     ReturnedEdgeFromTransition, ExecutableGraphOperations
    ... )
    >>> def double(x: int) -> int: return x * 2
    >>> components = [
    ...     ListPlaceNode(name="Input", type=int, tokens=[5]),
    ...     ArgumentEdgeToTransition("Input", "Double", "x"),
    ...     FunctionTransitionNode(name="Double", function=double),
    ...     ReturnedEdgeFromTransition("Double", "Output"),
    ...     ListPlaceNode(name="Output", type=int),
    ... ]
    >>> g = ExecutableGraphOperations.construct_graph(components)
    >>> pos = {"Input": (100.0, 100.0), "Double": (200.0, 200.0), "Output": (300.0, 300.0)}
    >>> anim = prepare_fire_animation(g, g.transitions[0], pos)
    >>> anim.transition
    'Double'
    >>> len(anim.input_tokens)
    1
    """
    input_places_names, output_places_names = get_transition_io_places(
        graph, transition.name
    )

    # Get tokens that will be consumed (the last token from each input place)
    input_tokens = []
    for place_name in input_places_names:
        place = next((p for p in graph.places if p.name == place_name), None)
        if place and place.tokens:
            token = place.tokens[-1]
            token_idx = len(place.tokens) - 1
            px, py = positions[place_name]
            offset_x, offset_y = calculate_token_position(token_idx, len(place.tokens))
            input_tokens.append(
                AnimationTokenInfo(
                    id=f"token-{place_name.replace(' ', '-')}-{token_idx}",
                    color=token_color_fn(token),
                    place=place_name,
                    x=px + offset_x,
                    y=py + offset_y,
                )
            )

    # Predict output token based on inputs
    output_tokens = []

    if transition.output_distribution_function is not None:
        # Build kwargs dynamically from graph edges
        simulation_kwargs = {}
        input_edges = [
            e
            for e in graph.argument_edges
            if e.transition_node_name == transition.name
        ]

        all_inputs_available = True
        for edge in input_edges:
            place = next(
                (p for p in graph.places if p.name == edge.place_node_name), None
            )
            if place and place.tokens:
                simulation_kwargs[edge.argument] = place.tokens[-1]
            else:
                all_inputs_available = False
                break

        if all_inputs_available and simulation_kwargs:
            # Simulate the transition to predict output
            simulated_result = transition.function(**simulation_kwargs)
            distribution = transition.output_distribution_function(simulated_result)

            for dest_place_name, token_value in distribution.items():
                if dest_place_name in positions:
                    dest_pos = positions[dest_place_name]
                    dest_place = next(
                        (p for p in graph.places if p.name == dest_place_name), None
                    )
                    new_token_count = len(dest_place.tokens) + 1 if dest_place else 1
                    offset_x, offset_y = calculate_token_position(
                        new_token_count - 1, new_token_count
                    )

                    output_tokens.append(
                        AnimationOutputToken(
                            color=token_color_fn(token_value),
                            dest_x=dest_pos[0] + offset_x,
                            dest_y=dest_pos[1] + offset_y,
                            dest_place=dest_place_name,
                        )
                    )
    else:
        # No distribution function - output goes to all connected output places
        for place_name in output_places_names:
            if place_name in positions:
                dest_pos = positions[place_name]
                dest_place = next(
                    (p for p in graph.places if p.name == place_name), None
                )
                new_token_count = len(dest_place.tokens) + 1 if dest_place else 1
                offset_x, offset_y = calculate_token_position(
                    new_token_count - 1, new_token_count
                )

                output_tokens.append(
                    AnimationOutputToken(
                        color=default_token_color(None),
                        dest_x=dest_pos[0] + offset_x,
                        dest_y=dest_pos[1] + offset_y,
                        dest_place=place_name,
                    )
                )

    trans_pos = positions[transition.name]
    return AnimationData(
        type="fire",
        transition=transition.name,
        transition_pos_x=trans_pos[0],
        transition_pos_y=trans_pos[1],
        input_tokens=tuple(input_tokens),
        output_tokens=tuple(output_tokens),
    )

"""
REFERENCE CODE FROM STREAMLIT VERSION (petrilit)

This file shows data structures and token positioning logic.

Useful for understanding:
- How tokens are positioned within places (calculate_token_position)
- Token stacking logic
- Color assignment for tokens
- RenderableGraph structure

For the Svelte version:
- Similar data structures will be sent from backend via WebSocket
- Token positioning logic might be useful to port to JavaScript/TypeScript
"""

"""Immutable data structures for Petrilit visualization."""

from typing import Any, Callable

from pydantic import BaseModel


# Type alias for token coloring functions
TokenColorFn = Callable[[Any], str]


def default_token_color(token: Any) -> str:
    """Default token coloring - returns gray for all tokens.

    >>> default_token_color("anything")
    '#95A5A6'
    >>> default_token_color(42)
    '#95A5A6'
    """
    return "#95A5A6"


def calculate_token_position(
    index: int, total: int, token_radius: int = 8
) -> tuple[float, float]:
    """Calculate the position offset of a token within a place circle.

    Arranges tokens in a grid pattern, centered within the place.

    Args:
        index: The token's index (0-based)
        total: Total number of tokens in the place
        token_radius: Radius of each token circle

    Returns:
        Tuple of (offset_x, offset_y) from the place center

    >>> calculate_token_position(0, 1)
    (0.0, 0.0)
    >>> calculate_token_position(0, 4)
    (-30.0, 0.0)
    >>> calculate_token_position(3, 4)
    (30.0, 0.0)
    """
    max_per_row = 4
    row = index // max_per_row
    col = index % max_per_row
    total_rows = (total + max_per_row - 1) // max_per_row
    total_in_row = min(max_per_row, total - row * max_per_row)

    offset_x = (col - (total_in_row - 1) / 2) * (token_radius * 2.5)
    offset_y = (row - (total_rows - 1) / 2) * (token_radius * 2.5)

    return offset_x, offset_y


class TokenView(BaseModel, frozen=True):
    """Immutable view of a token for rendering.

    Attributes:
        id: Unique identifier (e.g., "token-PlaceName-0")
        x: Computed x position on canvas
        y: Computed y position on canvas
        color: Hex color string for rendering
    """
    id: str
    x: float
    y: float
    color: str


class PlaceView(BaseModel, frozen=True):
    """Immutable view of a place for rendering.

    Attributes:
        name: Display name of the place
        x: Center x position on canvas
        y: Center y position on canvas
        type_name: Display name for the token type held
        tokens: Tuple of TokenView instances
    """
    name: str
    x: float
    y: float
    type_name: str
    tokens: tuple[TokenView, ...] = ()


class TransitionView(BaseModel, frozen=True):
    """Immutable view of a transition for rendering.

    Attributes:
        name: Display name of the transition
        x: Center x position on canvas
        y: Center y position on canvas
    """
    name: str
    x: float
    y: float


class EdgeView(BaseModel, frozen=True):
    """Immutable view of an edge for rendering.

    Attributes:
        start_x: Starting x position
        start_y: Starting y position
        end_x: Ending x position
        end_y: Ending y position
        edge_type: Either "argument" (place->transition) or "return" (transition->place)
        label: Optional label (e.g., argument name)
    """
    start_x: float
    start_y: float
    end_x: float
    end_y: float
    edge_type: str
    label: str = ""


class RenderableGraph(BaseModel, frozen=True):
    """Complete immutable snapshot of a Petri net ready for rendering.

    This is the primary data structure passed to rendering functions.
    It contains all computed positions and visual properties.

    Attributes:
        places: Tuple of PlaceView instances
        transitions: Tuple of TransitionView instances
        edges: Tuple of EdgeView instances
        width: Canvas width in pixels
        height: Canvas height in pixels
    """
    places: tuple[PlaceView, ...]
    transitions: tuple[TransitionView, ...]
    edges: tuple[EdgeView, ...]
    width: int = 950
    height: int = 450

"""Token styling for the coloured balls example."""

from typing import Any


def coloured_balls_token_color(token: Any) -> str:
    """Get a color for a token based on its properties.

    - Rubber tokens: brown gradient based on quantity
    - Paint/Ball tokens: color based on the 'color' attribute

    Args:
        token: Any token object

    Returns:
        Hex color string

    >>> from examples.coloured_balls.models import Rubber, Paint, Ball
    >>> coloured_balls_token_color(Paint(color="red"))
    '#E74C3C'
    >>> coloured_balls_token_color(Ball(color="blue", size=10))
    '#3498DB'
    >>> coloured_balls_token_color(Rubber(quantity=5))  # doctest: +ELLIPSIS
    'rgb(...)'
    """
    if hasattr(token, "color"):
        color_map = {
            "red": "#E74C3C",
            "blue": "#3498DB",
            "green": "#2ECC71",
            "yellow": "#F1C40F",
        }
        return color_map.get(token.color, "#9B59B6")
    elif hasattr(token, "quantity"):
        # Gradient from light to dark brown based on quantity
        intensity = min(token.quantity * 20, 200)
        return f"rgb({100 + intensity // 2}, {60 + intensity // 3}, {20 + intensity // 4})"
    return "#95A5A6"

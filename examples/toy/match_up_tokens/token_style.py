"""Token styling for the match up tokens example."""

from typing import Any


def match_tokens_color(token: Any) -> str:
    """Get a color for a token based on its type and value.

    - Strings: Blue shades based on length
    - Integers: Orange shades based on value
    - Tuples (matched pairs): Green

    Args:
        token: Any token object

    Returns:
        Hex color string
    """
    if isinstance(token, str):
        # Blue shades for strings, darker for longer strings
        length = len(token)
        if length == 1:
            return "#AED6F1"  # Light blue
        elif length == 2:
            return "#5DADE2"  # Medium blue
        elif length == 3:
            return "#3498DB"  # Blue
        else:
            return "#2874A6"  # Dark blue

    elif isinstance(token, int):
        # Orange shades for integers
        if token < 3:
            return "#F8C471"  # Light orange
        elif token < 5:
            return "#F39C12"  # Orange
        elif token < 10:
            return "#E67E22"  # Dark orange
        else:
            return "#BA4A00"  # Very dark orange

    elif isinstance(token, tuple):
        # Green for matched pairs
        return "#2ECC71"

    # Default gray
    return "#95A5A6"

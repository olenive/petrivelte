"""Domain models for the match up tokens example."""


def match_one_string_to_one_length(
    string: str, length: int
) -> tuple[bool, str, int]:
    """Check if a string matches a length.

    Args:
        string: A string token
        length: An integer token

    Returns:
        Tuple of (is_match, string, length)
    """
    is_match = len(string) == length
    return (is_match, string, length)


def distribute_result_tokens(
    result: tuple[bool, str, int]
) -> dict[str, str | int | tuple[str, int]]:
    """Distribute the result tokens back to their places.

    Args:
        result: Tuple of (is_match, string, length)

    Returns:
        Dictionary mapping place names to their tokens
    """
    is_match, string, length = result

    if is_match:
        # Matched! Send pair to output
        return {"Matched Pair": (string, length)}
    else:
        # No match - return tokens to their original places
        return {
            "Some Strings": string,
            "Some Lengths": length,
        }

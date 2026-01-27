"""Domain models for the coloured balls example."""

from pydantic import BaseModel


class Rubber(BaseModel):
    """Raw material for making balls."""

    quantity: int


class Paint(BaseModel):
    """Paint used to colour balls."""

    color: str


class Ball(BaseModel):
    """A coloured ball produced from rubber and paint."""

    color: str
    size: int


def make_a_ball(rubber: Rubber, paint: Paint) -> Ball:
    """Transition function: combine rubber and paint to make a ball."""
    return Ball(color=paint.color, size=rubber.quantity * 10)


def distribute_by_colour(ball: Ball) -> dict[str, Ball]:
    """Output distribution function: route balls by colour."""
    if ball.color == "red":
        return {"Red Balls": ball}
    elif ball.color == "blue":
        return {"Blue Balls": ball}
    else:
        return {"Other Balls": ball}

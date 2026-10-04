"""One panel's exception must not stop the rest of the nets page.

The execution log and the graph each sit in their own error boundary. A
panel that throws while it renders shows a fallback naming itself and the
error, with a Retry button, and every other panel keeps updating. Before the
boundaries, one exception in one component (a duplicate key in the execution
log) stopped every update on the page.

The graph is made to throw with data the net can send: a `reloaded` after
which the state read lists one edge twice. The graph keys its edges by their
ends, kind and slot, and the dev build this suite runs throws on the
repeated key while the graph renders. The page's own handlers (the mirror,
the layout, the animation) accept the state, so the exception is the
graph's alone.
"""

from playwright.sync_api import ConsoleMessage, Page

import fake_cp
from test_graph_pan import NET_ID, _open, _seed

GRAPH_FAILED = '.panel-failed[data-panel="graph"]'


def test_a_failing_graph_leaves_the_execution_log_live(
        page: Page, frontend_url: str, expected_console_errors: list[str],
        fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    expected_console_errors.append("[nets page] the graph panel failed")
    logged: list[str] = []

    def on_console(message: ConsoleMessage) -> None:
        if message.type == "error":
            logged.append(message.text)

    page.on("console", on_console)
    _seed(cp, running=True, tokens_at="Requests")
    _open(page, frontend_url)
    page.wait_for_function("() => document.querySelectorAll('.log-entry').length === 0")

    edges = cp.execution_state[NET_ID]["topology"]["edges"]
    edges.append(dict(edges[1]))
    fake_cp.resync(cp, NET_ID)

    fallback = page.locator(GRAPH_FAILED)
    fallback.wait_for(timeout=10_000)
    assert "The graph panel failed" in fallback.inner_text()
    message = fallback.locator("pre").inner_text()
    print("graph fallback shows:", message)
    assert "duplicate key" in message
    assert page.locator("svg.petri-net").count() == 0
    assert any("[nets page] the graph panel failed" in text for text in logged), logged

    # The execution log keeps taking firings while the graph is down.
    for _ in range(3):
        assert fake_cp.fire(cp, NET_ID) is not None
    page.wait_for_function("() => document.querySelectorAll('.log-entry').length === 3",
                           timeout=10_000)
    assert page.locator(GRAPH_FAILED).count() == 1

    # A whole state again, then Retry renders the graph from it.
    edges.pop()
    fake_cp.resync(cp, NET_ID)
    page.wait_for_timeout(300)
    fallback.get_by_role("button", name="Retry").click()
    page.wait_for_selector("svg.petri-net g.transition", timeout=10_000)
    assert page.locator(GRAPH_FAILED).count() == 0

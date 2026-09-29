"""One panel's exception must not stop the rest of the nets page.

The execution log and the graph each sit in their own error boundary. A
panel that throws while it renders shows a fallback naming itself and the
error, with a Retry button, and every other panel keeps updating. Before the
boundaries, one exception in one component (a duplicate key in the execution
log) stopped every update on the page.

The graph is made to throw with data the worker stream can carry: a
`graph_state` that lists one edge twice. The graph keys its edges by id, and
the dev build this suite runs throws on the repeated key while the graph
renders. The page's own handlers accept the payload, so the exception is
the graph's alone. (A `graph_state` without its `transitions` list would
make the graph throw too, but the page's `transition_fired` handler looks
transitions up in it as well; an exception there, in a store subscriber, is
outside what a boundary can catch.)
"""

import time

from playwright.sync_api import ConsoleMessage, Page

import fake_cp
from test_graph_pan import NET_ID, _firing, _graph, _open, _seed

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

    broken = _graph("Window")
    broken["edges"].append(dict(broken["edges"][0]))
    fake_cp.publish_worker(cp, kind="graph_state", data=broken, net_id=NET_ID)

    fallback = page.locator(GRAPH_FAILED)
    fallback.wait_for(timeout=10_000)
    assert "The graph panel failed" in fallback.inner_text()
    message = fallback.locator("pre").inner_text()
    print("graph fallback shows:", message)
    assert "duplicate key" in message
    assert page.locator("svg.petri-net").count() == 0
    assert any("[nets page] the graph panel failed" in text for text in logged), logged

    # The execution log keeps taking firings while the graph is down.
    for index in range(3):
        firing = _firing(index, index)
        firing["log_entry"]["timestamp"] = time.time() + index
        fake_cp.publish_worker(cp, kind="transition_fired", data=firing, net_id=NET_ID)
    page.wait_for_function("() => document.querySelectorAll('.log-entry').length === 3",
                           timeout=10_000)
    assert page.locator(GRAPH_FAILED).count() == 1

    # A whole state again, then Retry renders the graph from it.
    fake_cp.publish_worker(cp, kind="graph_state", data=_graph("Scores"), net_id=NET_ID)
    page.wait_for_timeout(300)
    fallback.get_by_role("button", name="Retry").click()
    page.wait_for_selector("svg.petri-net g.transition", timeout=10_000)
    assert page.locator(GRAPH_FAILED).count() == 0

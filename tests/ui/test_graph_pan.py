"""Pan and zoom on the nets page graph, idle and while the net is executing.

A drag on the graph's background must move the view, and the wheel must zoom
it, whatever the worker's event stream is doing at the time. The executing
case streams what a continuous monitor net sends while it fires: a step
starting, the subprocess printing, a transition firing with the tokens it
moved, the worker's memory, and run events on the control plane's stream.
"""

import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from playwright.sync_api import Page

import fake_cp

WORKER_ID = "worker-1"
NET_ID = "net-monitor"

# A chain across the top of the canvas, so the lower half of the view is
# empty background to grab.
PLACES = ["Requests", "Window", "Scores", "Anomalies", "Alerts"]
TRANSITIONS = ["collect", "score", "detect", "notify"]

# The page's cap on execution log rows, as `EXECUTION_LOG_CAP` in
# `frontend/src/lib/workerStream.ts`.
EXECUTION_LOG_CAP = 500


def _graph(tokens_at: str | None) -> dict:
    places = []
    for index, name in enumerate(PLACES):
        tokens = []
        if name == tokens_at:
            tokens = [
                {"id": f"tok-{slot}", "preview": "{'deviation': 0.4}", "type_name": "Sample",
                 "color": "#4f9dde"}
                for slot in range(3)
            ]
        places.append({
            "id": name, "name": name, "x": 80 + index * 200, "y": 150,
            "type_name": "Sample", "tokens": tokens, "token_count": len(tokens),
        })
    transitions = [
        {"id": name, "name": name, "x": 180 + index * 200, "y": 300, "function_name": name,
         "signature": None, "docstring": None}
        for index, name in enumerate(TRANSITIONS)
    ]
    edges = []
    for index, name in enumerate(TRANSITIONS):
        edges.append({"id": f"{PLACES[index]}->{name}", "source": PLACES[index], "target": name,
                      "type": "input"})
        edges.append({"id": f"{name}->{PLACES[index + 1]}", "source": name,
                      "target": PLACES[index + 1], "type": "output"})
    return {"places": places, "transitions": transitions, "edges": edges}


def _seed(cp: fake_cp.FakeControlPlane, *, running: bool, tokens_at: str | None) -> None:
    cp.workers = [fake_cp.worker_row(WORKER_ID)]
    cp.nets = [fake_cp.net_row(NET_ID, WORKER_ID, name="monitor_anomalies",
                               execution_mode="continuous")]
    cp.execution_state = {NET_ID: {**_graph(tokens_at), "running": running}}


def _open(page: Page, frontend_url: str) -> None:
    page.goto(f"{frontend_url}/nets?net={NET_ID}")
    page.wait_for_selector("svg.petri-net g.transition", timeout=60_000)


def _view_box(page: Page) -> list[float]:
    raw = page.get_attribute("svg.petri-net", "viewBox") or ""
    return [float(part) for part in raw.split()]


def _background_point(page: Page) -> tuple[float, float]:
    """A point on the graph that is bare background: the svg itself answers it."""
    box = page.locator("svg.petri-net").bounding_box()
    assert box is not None
    x = box["x"] + box["width"] * 0.3
    y = box["y"] + box["height"] * 0.85
    hit = page.evaluate(
        "([x, y]) => document.elementFromPoint(x, y)?.matches('svg.petri-net') ?? false", [x, y])
    assert hit, "the drag must start on bare background"
    return x, y


def _drag(page: Page, start: tuple[float, float], by: tuple[float, float],
          *, before_first_move: Callable[[], None] = lambda: None) -> None:
    x, y = start
    page.mouse.move(x, y)
    page.mouse.down()
    before_first_move()
    steps = 12
    for step in range(1, steps + 1):
        page.mouse.move(x + by[0] * step / steps, y + by[1] * step / steps)
        page.wait_for_timeout(60)
    page.mouse.up()


def _assert_pans_and_zooms(page: Page, *, before_first_move: Callable[[], None] = lambda: None) -> None:
    start = _background_point(page)
    before = _view_box(page)
    _drag(page, start, (-300, -120), before_first_move=before_first_move)
    after = _view_box(page)
    selected = page.evaluate("() => String(window.getSelection() ?? '')")
    assert after[0] > before[0] + 100 and after[1] > before[1] + 30, (
        f"dragging the background did not pan: viewBox {before} -> {after}, "
        f"selected text {selected!r}")

    page.mouse.move(*start)
    for _ in range(4):
        page.mouse.wheel(0, -100)
        page.wait_for_timeout(50)
    zoomed = _view_box(page)
    assert zoomed[2] < after[2], f"the wheel did not zoom: viewBox {after} -> {zoomed}"


def _firing(transition_index: int, cycle: int) -> dict:
    """What the worker sends when `transition_index` fires on cycle `cycle`."""
    name = TRANSITIONS[transition_index]
    source, target = PLACES[transition_index], PLACES[transition_index + 1]
    moved = [{"id": f"tok-{cycle}-{slot}", "place_id": target, "color": "#4f9dde",
              "preview": "{'deviation': 0.4}", "type_name": "Sample"} for slot in range(3)]
    return {
        "transition_name": name,
        "log_entry": {"timestamp": time.time(), "transition": name, "duration_ms": 12.5,
                      "inputs": {source: [f"tok-{cycle}-0"]}, "outputs": [target]},
        "new_token_positions": moved,
        "token_counts": {place: (3 if place == target else 0) for place in PLACES},
    }


def _memory() -> dict:
    return {"parent_rss_mb": 180.0, "parent_peak_rss_mb": 190.0, "container_total_mb": 2048.0,
            "container_available_mb": 1100.0,
            "nets": [{"net_id": NET_ID, "rss_mb": 300.0}], "notebooks": []}


@contextmanager
def _executing(cp: fake_cp.FakeControlPlane, *, graph_state_every: int = 0,
               period_s: float = 0.3) -> Iterator[None]:
    """Stream a firing net's events until the block ends."""
    done = threading.Event()

    def run() -> None:
        tick = 0
        while not done.is_set():
            transition_index = tick % len(TRANSITIONS)
            fake_cp.publish_worker(cp, kind="step_started", data={}, net_id=NET_ID)
            fake_cp.publish_worker(cp, kind="subprocess_output",
                                   data={"text": f"scoring window {tick}"}, net_id=NET_ID)
            fake_cp.publish_worker(cp, kind="transition_fired",
                                   data=_firing(transition_index, tick), net_id=NET_ID)
            fake_cp.publish_worker(cp, kind="memory_stats", data=_memory(), net_id=None,
                                   scope="worker")
            if graph_state_every and tick % graph_state_every == 0:
                fake_cp.publish_worker(cp, kind="graph_state",
                                       data=_graph(PLACES[transition_index + 1]), net_id=NET_ID)
            fake_cp.publish_server(cp, {
                "type": "net_run_started", "run_id": f"run-{tick}", "net_id": NET_ID,
                "trigger": "resume", "state": "running", "reason": None,
                "created_at": fake_cp.STAMP, "started_at": fake_cp.STAMP, "ended_at": None,
                "scheduled_for": None, "ts": fake_cp.STAMP,
            })
            tick += 1
            done.wait(period_s)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        yield
    finally:
        done.set()
        thread.join(timeout=5)


def test_idle_net_pans_and_zooms(page: Page, frontend_url: str,
                                 fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    _seed(fresh_control_plane, running=False, tokens_at=None)
    _open(page, frontend_url)
    _assert_pans_and_zooms(page)


def test_executing_net_pans_and_zooms(page: Page, frontend_url: str,
                                      fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed(cp, running=True, tokens_at="Requests")
    _open(page, frontend_url)

    def replace_graph_mid_drag() -> None:
        # Between the button going down and the first move: a new graph
        # object for the panel, and a firing that starts an animation.
        fake_cp.publish_worker(cp, kind="graph_state", data=_graph("Window"), net_id=NET_ID)
        fake_cp.publish_worker(cp, kind="transition_fired", data=_firing(1, 999), net_id=NET_ID)
        page.wait_for_timeout(400)

    with _executing(cp, graph_state_every=3):
        page.wait_for_timeout(1500)
        _assert_pans_and_zooms(page, before_first_move=replace_graph_mid_drag)


def test_net_opened_mid_run_pans_and_zooms(page: Page, frontend_url: str,
                                           fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    """A net that has been firing for a while when the page opens.

    The worker's history is full, and its event buffer still holds the
    firings that history already lists. Opening the page fetches the history
    and opens the worker stream from the start, which replays those firings;
    when the history answers first, each replayed firing arrives as news.
    That once put the same entry in the execution log twice, and the log
    keys its rows by timestamp: the dev build throws on the duplicate key,
    the production build throws a little later as the cap evicts rows, and
    either way the page stops updating, pan and zoom included.
    """
    cp = fresh_control_plane
    _seed(cp, running=True, tokens_at="Requests")
    firings = [_firing(index % len(TRANSITIONS), index) for index in range(EXECUTION_LOG_CAP)]
    for index, firing in enumerate(firings):
        firing["log_entry"]["timestamp"] = 1_790_000_000.0 + index
    cp.execution_history = {NET_ID: [firing["log_entry"] for firing in firings]}
    buffered = firings[-50:]
    cp.worker_replay = [
        {"seq": seq, "scope": "net", "net_id": NET_ID, "kind": "transition_fired",
         "ts": fake_cp.STAMP, "data": firing}
        for seq, firing in enumerate(buffered, start=1)
    ]
    cp.worker_seq = len(buffered)
    cp.replay_delay_s = 0.8
    _open(page, frontend_url)

    with _executing(cp):
        page.wait_for_timeout(2500)
        _assert_pans_and_zooms(page)
    assert page.locator(".log-entry").count() == EXECUTION_LOG_CAP

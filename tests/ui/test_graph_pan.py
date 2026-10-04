"""Pan and zoom on the nets page graph, idle and while the net is executing.

A drag on the graph's background must move the view, and the wheel must zoom
it, whatever the worker's event stream is doing at the time. The executing
case streams what a continuous monitor net sends while it fires, in protocol
version 1: each firing as `launched` then `distributed`, the subprocess
printing, the worker's memory, a fresh token `added` when the chain runs
dry, and run events on the control plane's stream.
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


def _state(tokens_at: str | None, *, running: bool = False, marking_version: int = 0) -> dict:
    """The monitor chain as a protocol state, three tokens in `tokens_at`."""
    marking = {}
    if tokens_at is not None:
        marking[tokens_at] = [{"id": str(slot + 1), "label": "{'deviation': 0.4}", "color": "#4f9dde"}
                              for slot in range(3)]
    edges = []
    for index, name in enumerate(TRANSITIONS):
        edges.append({"place": PLACES[index], "transition": name, "direction": "in", "kind": "take"})
        edges.append({"place": PLACES[index + 1], "transition": name, "direction": "out"})
    return fake_cp.net_state(
        net="monitor_anomalies",
        places=[{"name": name, "type_name": "Sample", "serializable": True} for name in PLACES],
        transitions=[{"name": name, "detail": {"function_name": name, "signature": "(sample: Sample) -> Sample"}}
                     for name in TRANSITIONS],
        edges=edges, marking=marking, running=running, marking_version=marking_version)


def _seed(cp: fake_cp.FakeControlPlane, *, running: bool, tokens_at: str | None,
          marking_version: int = 0, history: list[dict] | None = None) -> None:
    cp.workers = [fake_cp.worker_row(WORKER_ID)]
    cp.nets = [fake_cp.net_row(NET_ID, WORKER_ID, name="monitor_anomalies",
                               execution_mode="continuous")]
    fake_cp.seed_net(cp, NET_ID, _state(tokens_at, running=running, marking_version=marking_version),
                     history)


def _entry(seq: int) -> dict:
    """A log entry (protocol §8) for firing number `seq` along the chain."""
    index = seq % len(TRANSITIONS)
    return {"seq": seq, "transition": TRANSITIONS[index], "started_at": "2026-10-04T10:00:00Z",
            "duration_ms": 12.5, "outcome": "fired",
            "consumed": [[PLACES[index], str(seq)]], "produced": [[PLACES[index + 1], str(seq + 10_000)]]}


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


def _fire_or_refill(cp: fake_cp.FakeControlPlane) -> None:
    """Fire the next transition along the chain; when it has run dry, a new
    token arrives at its head."""
    if fake_cp.fire(cp, NET_ID) is None:
        fake_cp.inject(cp, NET_ID, PLACES[0], {"deviation": 0.4})


def _memory() -> dict:
    return {"parent_rss_mb": 180.0, "parent_peak_rss_mb": 190.0, "container_total_mb": 2048.0,
            "container_available_mb": 1100.0,
            "nets": [{"net_id": NET_ID, "rss_mb": 300.0}], "notebooks": []}


@contextmanager
def _executing(cp: fake_cp.FakeControlPlane, *, resync_every: int = 0,
               period_s: float = 0.3) -> Iterator[None]:
    """Stream a firing net's events until the block ends."""
    done = threading.Event()

    def run() -> None:
        tick = 0
        while not done.is_set():
            fake_cp.publish_worker(cp, kind="subprocess_output",
                                   data={"text": f"scoring window {tick}"}, net_id=NET_ID)
            _fire_or_refill(cp)
            fake_cp.publish_worker(cp, kind="memory_stats", data=_memory(), net_id=None,
                                   scope="worker")
            if resync_every and tick % resync_every == 0:
                fake_cp.resync(cp, NET_ID)
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
        # Between the button going down and the first move: a `reloaded`
        # that makes the page read and rebuild its whole state, and a
        # firing that starts an animation.
        fake_cp.resync(cp, NET_ID)
        _fire_or_refill(cp)
        page.wait_for_timeout(400)

    with _executing(cp, resync_every=3):
        page.wait_for_timeout(1500)
        _assert_pans_and_zooms(page, before_first_move=replace_graph_mid_drag)


def test_net_opened_mid_run_pans_and_zooms(page: Page, frontend_url: str,
                                           fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    """A net that has been firing for a while when the page opens.

    The net's log is full, and the worker's event buffer still holds the
    notifications for firings the log already lists. Opening the page reads
    the state and the log and asks the worker stream to skip its replay, so
    none of the buffer is sent. Old notifications can still reach the page,
    as they do when a reconnect replays what the resync's read already
    holds: they are at or below the marking version the page holds and are
    ignored. The log keys its rows by `seq`, and a repeated key once stopped
    the page updating, pan and zoom included; the log is read again only
    after the newest entry it holds, and capped.
    """
    cp = fresh_control_plane
    _seed(cp, running=True, tokens_at="Requests", marking_version=1000,
          history=[_entry(seq) for seq in range(1, EXECUTION_LOG_CAP + 1)])
    old = [{"kind": "distributed",
            "data": {"transition": TRANSITIONS[0], "produced": [[PLACES[1], str(9000 + v), "x"]],
                     "duration_ms": 1.0, "marking_version": v, "running": True}}
           for v in range(950, 1000)]
    with cp.lock:
        first = cp.worker_seq + 1
        cp.worker_buffer = [
            {"seq": seq, "scope": "net", "net_id": NET_ID, "ts": fake_cp.STAMP, **event}
            for seq, event in enumerate(old, start=first)
        ]
        cp.worker_seq = cp.worker_buffer[-1]["seq"]
    cp.replay_delay_s = 0.8
    _open(page, frontend_url)
    page.wait_for_function(f"document.querySelectorAll('.log-entry').length === {EXECUTION_LOG_CAP}")

    # Notifications the page's state already holds, arriving live.
    for event in old[-10:]:
        fake_cp.publish_worker(cp, kind=event["kind"], data=event["data"], net_id=NET_ID)
    with _executing(cp):
        page.wait_for_timeout(2500)
        _assert_pans_and_zooms(page)
    newest = cp.execution_history[NET_ID][-1]["seq"]
    assert newest > EXECUTION_LOG_CAP
    page.wait_for_function(
        f"document.querySelector('.log-entry')?.dataset.seq === '{newest}'", timeout=10_000)
    assert page.locator(".log-entry").count() == EXECUTION_LOG_CAP
    assert [answer["answer"] for answer in cp.worker_stream_answers] == ["restarted"], (
        f"the worker stream replayed its buffer: {cp.worker_stream_answers}")
    # None of the old notifications reached the drawing: they are not tokens.
    assert page.locator('[data-token-id="9990"]').count() == 0

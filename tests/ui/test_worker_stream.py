"""How the nets page opens and reopens its worker's event stream.

A first open asks the worker to skip its replay: the page fetches the net's
state, history and log over REST on selection, and a busy worker's buffer
(two thousand events, megabytes of them) replayed on top of that froze the
tab for seconds. The worker answers the skip with one `stream_gap` marker
that seeds the page's cursor. A reconnect the page's store makes itself asks
from that cursor, so a short outage is filled by replay.
"""

import time
from collections.abc import Iterator

import pytest
from playwright.sync_api import ConsoleMessage, Page

import fake_cp
from test_graph_pan import NET_ID, TRANSITIONS, _firing, _open, _seed

SKIP_REPLAY_AFTER = 10**12

# The stream's messages as the browser received them, whatever the page did
# with them.
RECORD_WORKER_EVENTS = """
(() => {
    const Native = window.EventSource;
    window.__workerEvents = [];
    window.EventSource = class extends Native {
        constructor(url, init) {
            super(url, init);
            if (String(url).includes('/api/workers/')) {
                this.addEventListener('message', (event) => {
                    window.__workerEvents.push(JSON.parse(event.data));
                });
            }
        }
    };
})();
"""


@pytest.fixture
def recorded(page: Page) -> Iterator[list[str]]:
    """The page with its worker stream recorded, and its resync notes."""
    page.add_init_script(RECORD_WORKER_EVENTS)
    resyncs: list[str] = []

    def on_console(message: ConsoleMessage) -> None:
        if "resync needed" in message.text:
            resyncs.append(message.text)

    page.on("console", on_console)
    yield resyncs


def _received_seqs(page: Page) -> list[int]:
    return page.evaluate("() => window.__workerEvents.map((event) => event.seq)")


def _wait_for_seqs(page: Page, seqs: list[int]) -> None:
    page.wait_for_function(
        "(wanted) => wanted.every((seq) => window.__workerEvents.some((e) => e.seq === seq))",
        arg=seqs, timeout=15_000)


def _worker_stream_urls(cp: fake_cp.FakeControlPlane) -> list[str]:
    return [line for line in cp.requests if "/api/workers/" in line and "/events" in line]


def _state_fetches(cp: fake_cp.FakeControlPlane) -> int:
    return sum(1 for line in cp.requests if line == f"GET /api/nets/{NET_ID}/execution/state")


def _stamped(index: int, timestamp: float) -> dict:
    firing = _firing(index % len(TRANSITIONS), index)
    firing["log_entry"]["timestamp"] = timestamp
    return firing


def test_first_open_skips_the_replay(page: Page, frontend_url: str, recorded: list[str],
                                     fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed(cp, running=True, tokens_at="Requests")
    history = [_stamped(index, 1_790_000_000.0 + index)["log_entry"] for index in range(20)]
    cp.execution_history = {NET_ID: history}
    # A buffer of firings the history does not list: any of them on the page
    # would be a replayed firing applied.
    with cp.lock:
        first = cp.worker_seq + 1
        cp.worker_buffer = [
            {"seq": seq, "scope": "net", "net_id": NET_ID, "kind": "transition_fired",
             "ts": fake_cp.STAMP, "data": _stamped(seq, 1_791_000_000.0 + seq)}
            for seq in range(first, first + 50)
        ]
        cp.worker_seq = cp.worker_buffer[-1]["seq"]
    current_seq = cp.worker_seq

    _open(page, frontend_url)
    page.wait_for_function("() => window.__workerEvents.length > 0")
    page.wait_for_function("document.querySelectorAll('.log-entry').length > 0")
    page.wait_for_timeout(1500)

    urls = _worker_stream_urls(cp)
    print("worker stream requests on a first open:", urls)
    assert urls == [f"GET /api/workers/worker-1/events?after={SKIP_REPLAY_AFTER}"]
    assert cp.worker_stream_answers == [
        {"after": SKIP_REPLAY_AFTER, "answer": "restarted", "seqs": [0]}]
    marker = page.evaluate("() => window.__workerEvents[0]")
    assert marker["kind"] == "stream_gap"
    assert marker["data"] == {"reason": "restarted", "after": SKIP_REPLAY_AFTER,
                              "current_seq": current_seq}
    assert page.locator(".log-entry").count() == len(history)
    assert _state_fetches(cp) == 1
    assert recorded == [], f"a first open triggered a resync: {recorded}"


def test_store_reconnect_resumes_from_the_last_live_event(
        page: Page, frontend_url: str, recorded: list[str],
        fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed(cp, running=True, tokens_at="Requests")
    _open(page, frontend_url)
    page.wait_for_function("() => window.__workerEvents.length > 0")

    for index in range(3):
        fake_cp.publish_worker(cp, kind="transition_fired",
                               data=_stamped(index, time.time()), net_id=NET_ID)
    last_live_seq = cp.worker_seq
    _wait_for_seqs(page, list(range(last_live_seq - 2, last_live_seq + 1)))

    # The stream closes, and the browser's own retry is refused, so the
    # EventSource gives up and the page's store reconnects on its own.
    cp.refuse_worker_streams = 1
    fake_cp.drop_worker_streams(cp)
    for index in range(3, 6):
        fake_cp.publish_worker(cp, kind="transition_fired",
                               data=_stamped(index, time.time()), net_id=NET_ID)
    missed = list(range(last_live_seq + 1, cp.worker_seq + 1))
    _wait_for_seqs(page, missed)

    urls = _worker_stream_urls(cp)
    print("worker stream requests across a store-made reconnect:", urls)
    assert urls == [
        f"GET /api/workers/worker-1/events?after={SKIP_REPLAY_AFTER}",
        f"GET /api/workers/worker-1/events?after={SKIP_REPLAY_AFTER}",
        f"GET /api/workers/worker-1/events?after={last_live_seq}",
    ]
    assert [answer["answer"] for answer in cp.worker_stream_answers] == [
        "restarted", "refused", "replay"]
    assert cp.worker_stream_answers[-1]["seqs"] == missed
    # Each missed event arrived once, after the three live ones.
    assert _received_seqs(page)[1:] == list(range(last_live_seq - 2, cp.worker_seq + 1))

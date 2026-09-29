"""The workers page tails each ready worker's event stream; the log viewer replays.

The workers page opens one stream per ready worker for two things: live log
lines in its inline viewer and the `memory_stats` frames its gauges read. A
replay of each worker's buffer (two thousand events in production) serves
neither, so the page asks every stream to skip it. Until a worker's first
snapshot arrives, about five seconds after the stream opens, its gauge shows
the figure the control plane's health loop stored on the worker row, labelled
as the worker process alone.

The full-page log viewer is the one place a worker's buffer is replayed: it is
the only record of the worker's runtime log.
"""

from playwright.sync_api import Page, expect

import fake_cp

SKIP_REPLAY_AFTER = 10**12
WORKER_A = "worker-a"
WORKER_B = "worker-b"


def _worker(worker_id: str, *, used_mb: float, peak_mb: float) -> dict:
    return {**fake_cp.worker_row(worker_id), "name": worker_id,
            "memory_used_mb": used_mb, "memory_peak_mb": peak_mb}


def _buffer_of_log_lines(cp: fake_cp.FakeControlPlane, count: int) -> None:
    with cp.lock:
        first = cp.worker_seq + 1
        cp.worker_buffer = [
            {"seq": seq, "scope": "worker", "net_id": None, "kind": "log", "ts": fake_cp.STAMP,
             "data": {"text": f"buffered line {seq}"}}
            for seq in range(first, first + count)
        ]
        cp.worker_seq = cp.worker_buffer[-1]["seq"]


def _stream_requests(cp: fake_cp.FakeControlPlane) -> list[str]:
    return [line for line in cp.requests if "/api/workers/" in line and "/events" in line]


def _wait_for_streams(page: Page, cp: fake_cp.FakeControlPlane, count: int) -> None:
    """Until the fake has answered `count` stream requests, so a frame
    published next reaches every one of them."""
    for _ in range(150):
        if len(cp.worker_stream_answers) >= count:
            return
        page.wait_for_timeout(100)
    raise AssertionError(f"{count} worker streams did not open: {cp.worker_stream_answers}")


def _gauge(page: Page, worker_id: str):
    row = page.locator("div.border.rounded-md", has=page.get_by_text(worker_id, exact=True))
    return row.get_by_test_id("worker-memory-gauge")


def test_workers_page_tails_live_and_seeds_the_gauge(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cp.workers = [_worker(WORKER_A, used_mb=123.4, peak_mb=150.0),
                  _worker(WORKER_B, used_mb=98.0, peak_mb=98.0)]
    _buffer_of_log_lines(cp, 40)

    page.goto(f"{frontend_url}/workers")
    page.get_by_text(WORKER_A, exact=True).click()
    page.get_by_text(WORKER_B, exact=True).click()

    gauge_a = _gauge(page, WORKER_A)
    gauge_b = _gauge(page, WORKER_B)
    expect(gauge_a).to_have_attribute("data-source", "health_check", timeout=30_000)
    expect(gauge_a.get_by_test_id("worker-memory-figure")).to_have_text(
        "123 MB / 2048 MB (6%) (peak 150)")
    expect(gauge_a).to_contain_text("worker process only")
    expect(gauge_b).to_have_attribute("data-source", "health_check")
    expect(gauge_b.get_by_test_id("worker-memory-figure")).to_have_text("98 MB / 2048 MB (5%)")

    _wait_for_streams(page, cp, 2)
    urls = _stream_requests(cp)
    print("worker stream requests from /workers:", urls)
    assert sorted(urls) == sorted(
        f"GET /api/workers/{worker_id}/events?after={SKIP_REPLAY_AFTER}"
        for worker_id in (WORKER_A, WORKER_B))
    assert all(answer["answer"] == "restarted" and answer["seqs"] == [0]
               for answer in cp.worker_stream_answers), cp.worker_stream_answers

    fake_cp.publish_worker(cp, kind="memory_stats", scope="worker", net_id=None,
                           worker_id=WORKER_A, data={
                               "parent_rss_mb": 100.0, "parent_peak_rss_mb": 120.0,
                               "container_total_mb": 2000.0, "container_available_mb": 1400.0,
                               "nets": [],
                               "notebooks": [{"notebook_id": "nb-1", "definition_name": None,
                                              "pid": 7, "rss_mb": 400.0, "peak_rss_mb": 410.0}],
                           })

    expect(gauge_a).to_have_attribute("data-source", "snapshot")
    expect(gauge_a.get_by_test_id("worker-memory-figure")).to_have_text("500 MB / 2000 MB (25%)")
    expect(gauge_a).not_to_contain_text("worker process only")
    expect(gauge_b).to_have_attribute("data-source", "health_check")
    # Nothing replayed and nothing missed: no buffered line and no gap note.
    expect(page.get_by_text("buffered line", exact=False)).to_have_count(0)
    expect(page.get_by_text("Log stream resumed", exact=False)).to_have_count(0)
    assert len(_stream_requests(cp)) == 2


def test_full_page_log_viewer_replays_the_buffer(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cp.workers = [_worker(WORKER_A, used_mb=123.4, peak_mb=150.0)]
    _buffer_of_log_lines(cp, 5)
    first = cp.worker_buffer[0]["seq"]

    page.goto(f"{frontend_url}/workers/{WORKER_A}/logs")
    expect(page.get_by_text(f"[runtime] buffered line {first + 4}")).to_be_visible(timeout=30_000)
    for seq in range(first, first + 5):
        expect(page.get_by_text(f"[runtime] buffered line {seq}", exact=False)).to_have_count(1)

    urls = _stream_requests(cp)
    print("worker stream requests from the full-page log viewer:", urls)
    assert urls == [f"GET /api/workers/{WORKER_A}/events?after=0"]
    assert cp.worker_stream_answers[0]["answer"] == "replay"

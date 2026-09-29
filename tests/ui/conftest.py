"""Fixtures for the browser suite: a fake control plane and `vite dev` against it.

Run from the repository root:

    uv run --with "playwright>=1.45" playwright install chromium
    uv run --with "playwright>=1.45" --with pytest pytest tests/ui -q

`vite dev` rather than a production build, because a production build refuses
a plain-http API URL. The fake and the dev server live for the whole session;
each test gets a fresh browser page and a fake whose data it sets itself.
"""

import os
import shutil
import socket
import subprocess
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest
from playwright.sync_api import Browser, ConsoleMessage, Page, sync_playwright

import fake_cp

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_for_http(url: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except OSError:
            time.sleep(0.3)
    raise RuntimeError(f"{url} did not answer within {timeout_s} s")


@pytest.fixture(scope="session")
def ui_port() -> int:
    return _free_port()


@pytest.fixture(scope="session")
def control_plane(ui_port: int) -> Iterator[fake_cp.FakeControlPlane]:
    cp = fake_cp.FakeControlPlane(allowed_origin=f"http://127.0.0.1:{ui_port}")
    server = fake_cp.start(cp)
    yield cp
    fake_cp.stop(cp, server)


@pytest.fixture(scope="session")
def frontend_url(ui_port: int, control_plane: fake_cp.FakeControlPlane) -> Iterator[str]:
    npm = shutil.which("npm")
    if npm is None:
        pytest.fail("npm is not on PATH; the browser suite needs it to run vite dev")
    if not (FRONTEND / "node_modules").exists():
        subprocess.run([npm, "ci"], cwd=FRONTEND, check=True)
    env = {**os.environ, "PUBLIC_API_URL": f"http://127.0.0.1:{control_plane.port}"}
    process = subprocess.Popen(
        [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", str(ui_port), "--strictPort"],
        cwd=FRONTEND,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    url = f"http://127.0.0.1:{ui_port}"
    try:
        _wait_for_http(url + "/login", timeout_s=90)
        yield url
    finally:
        os.killpg(process.pid, 15)
        process.wait(timeout=15)


@pytest.fixture(scope="session")
def browser() -> Iterator[Browser]:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        yield browser
        browser.close()


@pytest.fixture
def fresh_control_plane(control_plane: fake_cp.FakeControlPlane) -> Iterator[fake_cp.FakeControlPlane]:
    """The session's fake, emptied for one test and its streams closed after it."""
    control_plane.workers = []
    control_plane.nets = []
    control_plane.execution_state = {}
    control_plane.execution_history = {}
    control_plane.worker_buffer = []
    control_plane.replay_delay_s = 0.0
    control_plane.refuse_worker_streams = 0
    control_plane.worker_stream_answers.clear()
    control_plane.requests.clear()
    control_plane.unknown_paths.clear()
    yield control_plane
    if control_plane.unknown_paths:
        # Shown with the test's output (`-rA` or on failure): what the page
        # asked for that this fake answers only with an empty body.
        print("paths the fake does not know:", sorted(set(control_plane.unknown_paths)))
    fake_cp.drop_worker_streams(control_plane)
    with control_plane.lock:
        for stream in list(control_plane.server_streams):
            stream.put(None)


@pytest.fixture
def expected_console_errors() -> list[str]:
    """Text of console errors a test provokes on purpose. A test appends to
    it; a console error containing any of these does not fail the test."""
    return []


@pytest.fixture
def page(browser: Browser, frontend_url: str, expected_console_errors: list[str]) -> Iterator[Page]:
    """A page that fails its test on any uncaught exception or unexpected
    console error."""
    context = browser.new_context(viewport={"width": 1600, "height": 1000})
    page = context.new_page()
    problems: list[str] = []
    page.on("pageerror", lambda error: problems.append(f"uncaught: {error}"))

    def on_console(message: ConsoleMessage) -> None:
        if message.type == "error" and not any(
                expected in message.text for expected in expected_console_errors):
            problems.append(f"console error: {message.text}")

    page.on("console", on_console)
    yield page
    context.close()
    assert problems == [], "\n".join(problems)

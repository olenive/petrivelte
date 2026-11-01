"""The net drawing module's IIFE build, loaded in a bare page under the public tier's policy.

The public tier serves a viewer page whose content security policy allows
script and style only by the page's nonce, and loads the vendored module with
a classic `<script nonce src>`. This test builds the IIFE from
`frontend/vite.lib.config.ts` into a temporary directory, serves it beside a
bare page from a small local server that sends that policy with a fresh
nonce, and has the page draw the fixture net (`frontend/src/lib/netDraw.fixture.json`)
four times: as a share that publishes payloads sends it, as one that does
not, fitted whole into a frame shorter than the net, and fitted into that
frame with a floor on the scale above what the whole net needs. The drawing
must appear, redraw a changed count in place, fit, hold the floor, toggle
by double-click between the floored view and the whole net, zoom by wheel
and pan by drag, and the page must record no console error and no policy
violation. A last test proves the policy is in force: the page refuses an
inline style.
"""

import json
import re
import secrets
import shutil
import subprocess
import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import Browser, ConsoleMessage, Page

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
FIXTURE = FRONTEND / "src" / "lib" / "netDraw.fixture.json"
SCRIPT = "net-view.iife.js"


def tier_policy(nonce: str) -> str:
    """The public tier's policy, as `petritype_server/public/page.py` writes it."""
    return (
        "default-src 'self'; "
        f"script-src 'nonce-{nonce}'; "
        f"style-src 'nonce-{nonce}'; "
        "img-src 'self'; connect-src 'self'; object-src 'none'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )


def fixture_state() -> dict:
    return json.loads(FIXTURE.read_text())


def without_payloads(state: dict) -> dict:
    """The state as the tier reduces it for a share without payloads: counts, no tokens."""
    places = {name: {"count": place["count"]} for name, place in state["marking"]["places"].items()}
    return {**state, "marking": {"places": places}}


def _as_script(value: dict) -> str:
    """A JSON value as a script literal that cannot close its `<script>`."""
    return json.dumps(value).replace("</", "<\\/")


def page_html(nonce: str, full: dict, bare: dict) -> str:
    """A bare page: a violation recorder, the module by `<script nonce src>`, and an inline draw."""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Net view</title>
<script nonce="{nonce}">
  window.violations = [];
  document.addEventListener('securitypolicyviolation', (event) => {{
    window.violations.push(event.violatedDirective + ' ' + event.blockedURI);
  }});
</script>
</head>
<body>
<svg id="full" width="800" height="500"></svg>
<svg id="bare" width="800" height="500"></svg>
<svg id="fit" width="600" height="300"></svg>
<svg id="floor" width="600" height="300"></svg>
<script nonce="{nonce}" src="/{SCRIPT}"></script>
<script nonce="{nonce}">
  window.summaries = {{
    full: petriNetView.drawNet(document.getElementById('full'), {_as_script(full)}),
    bare: petriNetView.drawNet(document.getElementById('bare'), {_as_script(bare)}),
    fit: petriNetView.drawNet(document.getElementById('fit'), {_as_script(full)}, {{ fit: true }}),
    floor: petriNetView.drawNet(document.getElementById('floor'), {_as_script(full)}, {{ fit: true, fitFloor: 0.5 }}),
  }};
</script>
</body>
</html>
"""


@pytest.fixture(scope="module")
def built_module(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The IIFE, built from the library config into a temporary directory."""
    npm = shutil.which("npm")
    if npm is None:
        pytest.fail("npm is not on PATH; this test builds the module with it")
    if not (FRONTEND / "node_modules").exists():
        subprocess.run([npm, "ci"], cwd=FRONTEND, check=True)
    out = tmp_path_factory.mktemp("net-view")
    subprocess.run([npm, "run", "build:lib", "--", "--outDir", str(out), "--emptyOutDir", "--logLevel", "warn"],
                   cwd=FRONTEND, check=True)
    assert (out / SCRIPT).is_file()
    return out


def _handler_for(script: bytes, page_for: Callable[[str], str]) -> type[BaseHTTPRequestHandler]:
    """`http.server` takes only a class: this one serves the page with the
    tier's policy and the module script, and 404s anything else."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def do_GET(self) -> None:
            if self.path == "/":
                nonce = secrets.token_urlsafe(16)
                self._send(200, "text/html; charset=utf-8", page_for(nonce).encode(), tier_policy(nonce))
            elif self.path == f"/{SCRIPT}":
                self._send(200, "application/javascript", script, None)
            else:
                self._send(404, "text/plain", b"not found", None)

        def _send(self, status: int, content_type: str, body: bytes, policy: str | None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            if policy is not None:
                self.send_header("Content-Security-Policy", policy)
            self.end_headers()
            self.wfile.write(body)

    return Handler


@pytest.fixture(scope="module")
def site(built_module: Path) -> Iterator[str]:
    """The bare page and the module, served from a local port."""
    state = fixture_state()

    def page_for(nonce: str) -> str:
        return page_html(nonce, state, without_payloads(state))

    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for((built_module / SCRIPT).read_bytes(), page_for))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def bare_page(browser: Browser, site: str) -> Iterator[tuple[Page, list[str]]]:
    """The page opened, with every console error and uncaught exception recorded."""
    context = browser.new_context(viewport={"width": 1000, "height": 1400})
    page = context.new_page()
    problems: list[str] = []
    page.on("pageerror", lambda error: problems.append(f"uncaught: {error}"))

    def on_console(message: ConsoleMessage) -> None:
        if message.type == "error":
            problems.append(f"console error: {message.text}")

    page.on("console", on_console)
    page.goto(site + "/")
    page.wait_for_function("() => window.summaries !== undefined")
    yield page, problems
    context.close()


def _transform(page: Page, svg: str) -> str:
    return page.get_attribute(f"#{svg} g.net-root", "transform") or ""


def _scale(page: Page, svg: str) -> float:
    match = re.search(r" scale\(([^)]+)\)$", _transform(page, svg))
    assert match is not None, _transform(page, svg)
    return float(match.group(1))


def _count(page: Page, svg: str, place: str) -> str | None:
    label = page.locator(f'#{svg} .net-place-label[data-place="{place}"] .net-count')
    return label.text_content() if label.count() else None


def test_the_module_draws_the_fixture_under_the_tier_policy(bare_page: tuple[Page, list[str]]) -> None:
    page, problems = bare_page
    summaries = page.evaluate("() => window.summaries")
    assert summaries["full"] == {"places": 5, "transitions": 4, "edges": 11, "relaidOut": True}
    assert summaries["bare"] == {"places": 5, "transitions": 4, "edges": 11, "relaidOut": True}
    for svg in ("full", "bare"):
        assert page.locator(f"#{svg} .net-place").count() == 5
        assert page.locator(f"#{svg} .net-transition").count() == 4
        assert page.locator(f"#{svg} path.net-arc").count() == 11
    assert page.get_attribute('#full .net-transition[data-transition="Work"]', "class") == \
        "net-transition net-transition-fireable"
    # With payloads: the dots, capped at twenty, and the badge of the token holding nets.
    assert page.locator("#full .net-token").count() == 3 + 20 + 1 + 1
    assert page.locator("#full .net-badge").text_content() == "3"
    # Without: no dots, and every place that holds tokens shows its count.
    assert page.locator("#bare .net-token").count() == 0
    assert [_count(page, "bare", name) for name in ("Queue", "Backlog", "Light", "Fleet", "Done")] == \
        ["3", "25", "1", "1", None]
    # Laid out in the page, with a real size: the arcs have length.
    box = page.locator('#full .net-place[data-place="Queue"] circle').bounding_box()
    assert box is not None and box["width"] > 0
    assert page.evaluate("() => window.violations") == []
    assert problems == []


def test_a_second_draw_updates_the_count_in_place(bare_page: tuple[Page, list[str]]) -> None:
    page, problems = bare_page
    page.evaluate("() => { window.queueCount = document.querySelector("
                  "'#bare .net-place-label[data-place=\"Queue\"] .net-count'); }")
    state = without_payloads(fixture_state())
    state["marking"]["places"]["Queue"] = {"count": 4}
    state["marking_version"] = 8
    summary = page.evaluate("(state) => petriNetView.drawNet(document.getElementById('bare'), state)", state)
    assert summary == {"places": 5, "transitions": 4, "edges": 11, "relaidOut": False}
    assert _count(page, "bare", "Queue") == "4"
    assert page.evaluate("() => window.queueCount === document.querySelector("
                         "'#bare .net-place-label[data-place=\"Queue\"] .net-count')")
    assert page.evaluate("() => window.violations") == []
    assert problems == []


def test_the_wheel_zooms_and_a_drag_pans_the_root_group(bare_page: tuple[Page, list[str]]) -> None:
    page, problems = bare_page
    assert _transform(page, "full") == "translate(0 0) scale(1)"
    box = page.locator("#full").bounding_box()
    assert box is not None
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.wheel(0, -120)
    page.wait_for_function("() => document.querySelector('#full g.net-root')"
                           ".getAttribute('transform') !== 'translate(0 0) scale(1)'")
    zoomed = _transform(page, "full")
    assert zoomed.endswith("scale(1.025)")

    page.mouse.move(box["x"] + 50, box["y"] + 50)
    page.mouse.down()
    page.mouse.move(box["x"] + 150, box["y"] + 90, steps=4)
    page.mouse.up()
    panned = _transform(page, "full")
    assert panned != zoomed and panned.endswith("scale(1.025)")
    # The other drawing on the page is untouched.
    assert _transform(page, "bare") == "translate(0 0) scale(1)"
    assert page.evaluate("() => window.violations") == []
    assert problems == []


def test_a_fitted_net_starts_whole_in_its_frame_and_still_zooms(bare_page: tuple[Page, list[str]]) -> None:
    """The fixture is taller than a 600 by 300 frame: fitted, its lowest node is inside the svg."""
    page, problems = bare_page
    assert page.evaluate("() => window.summaries.fit") == {"places": 5, "transitions": 4, "edges": 11, "relaidOut": True}
    boxes = page.evaluate("""() => {
        const box = (el) => { const r = el.getBoundingClientRect();
                              return {top: r.top, bottom: r.bottom, left: r.left, right: r.right}; };
        const svg = document.getElementById('fit');
        const nodes = [...svg.querySelectorAll('.net-place circle, .net-transition rect')].map(box);
        return {svg: box(svg), nodes};
    }""")
    frame = boxes["svg"]
    lowest = max(boxes["nodes"], key=lambda node: node["bottom"])
    assert frame["top"] <= lowest["top"] and lowest["bottom"] <= frame["bottom"], (lowest, frame)
    assert frame["left"] <= lowest["left"] and lowest["right"] <= frame["right"], (lowest, frame)
    fitted = _transform(page, "fit")
    assert not fitted.endswith("scale(1)")

    box = page.locator("#fit").bounding_box()
    assert box is not None
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.wheel(0, -120)
    page.wait_for_function(f"() => document.querySelector('#fit g.net-root').getAttribute('transform') !== {json.dumps(fitted)}")
    assert page.evaluate("() => window.violations") == []
    assert problems == []


def test_a_floored_fit_starts_at_half_size_and_a_double_click_toggles_the_whole_net(
        bare_page: tuple[Page, list[str]]) -> None:
    """The fixture fits whole into 600 by 300 only at a third of its size. With
    the floor at a half it starts at half size; a double-click shows the whole
    net, as the drawing fitted without a floor beside it does, and a second
    one goes back to half size, selecting nothing on the way."""
    page, problems = bare_page
    assert page.evaluate("() => window.summaries.floor") == \
        {"places": 5, "transitions": 4, "edges": 11, "relaidOut": True}
    floored = _transform(page, "floor")
    assert _scale(page, "floor") == 0.5
    whole = _transform(page, "fit")
    assert _scale(page, "fit") < 0.5

    # The first double-click lands on a token label in view, where the
    # browser would otherwise select a word.
    floor = page.locator("#floor")
    floor.scroll_into_view_if_needed()
    label = page.evaluate("""() => {
        const svg = document.getElementById('floor');
        const frame = svg.getBoundingClientRect();
        for (const text of svg.querySelectorAll('.net-token-label:not(.net-outline)')) {
            const r = text.getBoundingClientRect();
            if (r.width > 10 && r.left > frame.left && r.right < frame.right && r.top > frame.top && r.bottom < frame.bottom)
                return {x: r.left + r.width / 2, y: r.top + r.height / 2};
        }
        return null;
    }""")
    assert label is not None
    page.mouse.dblclick(label["x"], label["y"])
    page.wait_for_function(f"() => document.querySelector('#floor g.net-root').getAttribute('transform') !== {json.dumps(floored)}")
    assert _transform(page, "floor") == whole
    assert _scale(page, "floor") < 0.5
    assert page.evaluate("() => window.getSelection().toString()") == ""

    floor.dblclick()
    page.wait_for_function(f"() => document.querySelector('#floor g.net-root').getAttribute('transform') !== {json.dumps(whole)}")
    assert _transform(page, "floor") == floored
    assert _scale(page, "floor") == 0.5
    assert page.evaluate("() => window.getSelection().toString()") == ""
    assert page.evaluate("() => window.violations") == []
    assert problems == []


def test_the_harness_policy_refuses_an_inline_style(bare_page: tuple[Page, list[str]]) -> None:
    """Without this, an empty violation list could mean the policy was never sent."""
    page, problems = bare_page
    page.evaluate("() => document.body.setAttribute('style', 'background: red')")
    page.wait_for_function("() => window.violations.length > 0")
    assert any(v.startswith("style-src") for v in page.evaluate("() => window.violations"))
    assert any("Content Security Policy" in problem for problem in problems)

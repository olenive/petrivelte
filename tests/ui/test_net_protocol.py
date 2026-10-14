"""The nets page on protocol version 1: what it draws and does for each thing
the net says.

A small parcel net with a read edge and a place without a JSON form. Steps,
injects, resets and switches go through the page's own controls; the fake
moves its net and publishes what a runner would, and the page is checked for
what it shows. The shop of protocol §11 has the edges that accept an empty
place, a drain and a survey.
"""

import json
from typing import Any

from playwright.sync_api import Page

import fake_cp

WORKER_ID = "worker-1"
NET_ID = "net-parcels"


def _seed(cp: fake_cp.FakeControlPlane, *, runtime: str = "python") -> None:
    cp.workers = [fake_cp.worker_row(WORKER_ID)]
    cp.nets = [fake_cp.net_row(NET_ID, WORKER_ID, name="parcel_distribution", execution_mode="manual")]
    state = fake_cp.net_state(
        net="parcel-distribution",
        runtime=runtime,
        places=[
            {"name": "Receiving", "type_name": "Parcel", "serializable": True},
            {"name": "Config", "type_name": "Rules", "serializable": False},
            {"name": "Sorting", "type_name": "Parcel", "serializable": True},
            {"name": "Dispatched", "type_name": "Parcel", "serializable": True},
        ],
        transitions=[
            {"name": "Sort", "detail": {"function_name": "sort_parcel",
                                        "signature": "(parcel: Parcel, rules: Rules) -> Parcel",
                                        "docstring": "Sort one parcel."}},
            {"name": "Dispatch"},
        ],
        edges=[
            {"place": "Receiving", "transition": "Sort", "direction": "in", "kind": "take"},
            {"place": "Config", "transition": "Sort", "direction": "in", "kind": "snapshot"},
            {"place": "Sorting", "transition": "Sort", "direction": "out"},
            {"place": "Sorting", "transition": "Dispatch", "direction": "in", "kind": "take"},
            {"place": "Dispatched", "transition": "Dispatch", "direction": "out"},
        ],
        marking={
            "Receiving": [{"id": str(n), "label": f'{{"parcel": {n}}}', "color": "#d94f4f"}
                          for n in (1, 2, 3)],
            "Config": [{"id": "4", "label": "Rules(strict=True)"}],
        },
        marking_version=7,
    )
    fake_cp.seed_net(cp, NET_ID, state)


def _open(page: Page, frontend_url: str) -> None:
    page.goto(f"{frontend_url}/nets?net={NET_ID}")
    page.wait_for_selector("svg.petri-net g.transition", timeout=60_000)


def _count(page: Page, place: str) -> str | None:
    return page.get_attribute(f".place-text[data-place-id='{place}']", "data-count")


def _wait_counts(page: Page, counts: dict[str, int]) -> None:
    wanted = ",".join(str(n) for n in counts.values())
    names = list(counts)
    page.wait_for_function(
        "([names, wanted]) => names.map((n) => document.querySelector("
        "`.place-text[data-place-id='${n}']`)?.dataset.count).join() === wanted",
        arg=[names, wanted], timeout=10_000)


def _wait_look(page: Page, transition: str, look: str) -> None:
    page.wait_for_function(
        "([name, look]) => document.querySelector(`g.transition[data-transition-id='${name}']`)"
        "?.dataset.look === look",
        arg=[transition, look], timeout=5_000)


def _state_reads(cp: fake_cp.FakeControlPlane) -> int:
    return sum(1 for line in cp.requests if line.startswith(f"GET /api/nets/{NET_ID}/execution/state"))


def test_the_page_draws_the_topology_and_its_state(page: Page, frontend_url: str,
                                                    fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    _seed(fresh_control_plane, runtime="rust")
    _open(page, frontend_url)

    assert page.locator("[data-runtime]").inner_text() == "rust"
    assert _count(page, "Receiving") == "3"
    assert page.locator(".tokens [data-token-id]").count() == 4
    # The read edge is dashed; the others are solid.
    strokes = page.eval_on_selector_all(".edges [data-edge-stroke]", "els => els.map(e => e.dataset.edgeStroke)")
    assert sorted(strokes) == ["dashed", "solid", "solid", "solid", "solid"]
    assert page.get_attribute("g.transition[data-transition-id='Sort']", "data-look") == "fireable"
    assert page.get_attribute("g.transition[data-transition-id='Dispatch']", "data-look") == "idle"
    assert "?token_limit=200" in next(line for line in fresh_control_plane.requests
                                      if "/execution/state" in line)


def _price_order(handed: dict[str, list[dict[str, Any]]]) -> list[tuple[str, str]]:
    """The shop's Price Order (§11): the order into Priced, and one discount
    per promotion running, oldest first, into Discounts Applied."""
    order = json.loads(handed["Orders"][0]["label"])
    promotions = [json.loads(token["label"]) for token in handed["Promotions"]]
    return [("Priced", json.dumps(order))] + [
        ("Discounts Applied", json.dumps(f"{promotion} on {order}")) for promotion in promotions]


def test_the_shop_draws_drain_and_survey_edges_and_prices_orders(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    # The shop of protocol §11, seeded empty: Price Order surveys Promotions
    # and Close Day drains it.
    cp = fresh_control_plane
    cp.bodies[NET_ID] = {"Price Order": _price_order}
    cp.workers = [fake_cp.worker_row(WORKER_ID)]
    cp.nets = [fake_cp.net_row(NET_ID, WORKER_ID, name="shop", execution_mode="manual")]
    places = ["Orders", "Promotions", "Day End", "Priced", "Discounts Applied", "Expired"]
    fake_cp.seed_net(cp, NET_ID, fake_cp.net_state(
        net="shop",
        runtime="rust",
        places=[{"name": name, "type_name": "String", "serializable": True} for name in places],
        transitions=[{"name": "Price Order"}, {"name": "Close Day"}],
        edges=[
            {"place": "Orders", "transition": "Price Order", "direction": "in", "kind": "take"},
            {"place": "Promotions", "transition": "Price Order", "direction": "in", "kind": "survey"},
            {"place": "Priced", "transition": "Price Order", "direction": "out", "slot": 0},
            {"place": "Discounts Applied", "transition": "Price Order", "direction": "out", "slot": 1},
            {"place": "Day End", "transition": "Close Day", "direction": "in", "kind": "take"},
            {"place": "Promotions", "transition": "Close Day", "direction": "in", "kind": "drain"},
            {"place": "Expired", "transition": "Close Day", "direction": "out"},
        ],
    ))
    _open(page, frontend_url)

    # The survey is dashed as a snapshot is, the drain solid as a take_all
    # is, and both end in the hollow head.
    drawn = page.eval_on_selector_all(
        ".edges [data-edge-stroke]",
        "els => els.map(e => [e.dataset.edgeStroke, e.dataset.edgeHead, e.getAttribute('marker-end')])")
    assert sorted(tuple(each) for each in drawn) == [
        ("dashed", "hollow", "url(#arrowhead-input-hollow)"),
        ("solid", "filled", "url(#arrowhead-input)"),
        ("solid", "filled", "url(#arrowhead-input)"),
        ("solid", "filled", "url(#arrowhead-output)"),
        ("solid", "filled", "url(#arrowhead-output)"),
        ("solid", "filled", "url(#arrowhead-output)"),
        ("solid", "hollow", "url(#arrowhead-input-hollow)"),
    ]
    # The hollow head is an outline in the input edge's colour, filled with
    # the graph's background.
    fill, stroke, filled, background = page.evaluate(
        "() => [getComputedStyle(document.querySelector('#arrowhead-input-hollow path')).fill,"
        " getComputedStyle(document.querySelector('#arrowhead-input-hollow path')).stroke,"
        " getComputedStyle(document.querySelector('#arrowhead-input path')).fill,"
        " getComputedStyle(document.querySelector('.graph-container')).backgroundColor]")
    assert (fill, stroke) == (background, filled)

    # Without detail, the inspector says what each does.
    page.locator("g.transition[data-transition-id='Close Day']").click()
    inspector = page.locator(".transition-inspector")
    arcs = inspector.locator("[data-arc='in']").all_inner_texts()
    assert arcs[0] == "Day End"
    assert arcs[1].startswith("Promotions") and arcs[1].endswith("drain: takes every token, zero or more")

    # The first two firings of the design's script (§2). An order alone makes
    # Price Order fireable, the surveyed Promotions empty, and it fires with
    # no promotion running.
    fake_cp.inject(cp, NET_ID, "Orders", "Order 1")
    _wait_look(page, "Price Order", "fireable")
    page.get_by_role("button", name="Step", exact=True).click()
    page.wait_for_selector(".log-entry[data-seq='1']", timeout=10_000)
    assert page.locator(".log-entry[data-seq='1'] .details").inner_text() == "Orders #1 → Priced #2"
    _wait_counts(page, {"Orders": 0, "Promotions": 0, "Priced": 1, "Discounts Applied": 0})

    # Two promotions start, which makes nothing fireable; a second order is
    # priced with both, which it surveys and does not take.
    fake_cp.inject(cp, NET_ID, "Promotions", "10% off")
    fake_cp.inject(cp, NET_ID, "Promotions", "Free shipping")
    _wait_counts(page, {"Promotions": 2})
    assert page.get_attribute("g.transition[data-transition-id='Price Order']", "data-look") == "idle"
    fake_cp.inject(cp, NET_ID, "Orders", "Order 2")
    _wait_look(page, "Price Order", "fireable")
    page.get_by_role("button", name="Step", exact=True).click()
    page.wait_for_selector(".log-entry[data-seq='2']", timeout=10_000)
    assert page.locator(".log-entry[data-seq='2'] .details").inner_text() == (
        "Orders #5 → Priced #6, Discounts Applied #7, Discounts Applied #8")
    _wait_counts(page, {"Orders": 0, "Promotions": 2, "Priced": 2, "Discounts Applied": 2})
    for token_id, discount in (("7", "10% off on Order 2"), ("8", "Free shipping on Order 2")):
        page.locator(f".tokens circle.token[data-token-id='{token_id}']").click()
        view = page.locator(f"[data-token-card-id='{token_id}'] pre[data-token-view='json']")
        view.wait_for(timeout=5_000)
        assert discount in view.inner_text()


def test_a_step_animates_the_firing_and_logs_it(page: Page, frontend_url: str,
                                                fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed(cp)
    _open(page, frontend_url)

    page.get_by_role("button", name="Step", exact=True).click()
    # Stage one: the parcel travels from Receiving to Sort along its edge.
    page.wait_for_selector(".animating-token[data-token-id='1']", timeout=5_000)
    assert page.locator(".edge.active").count() >= 1
    _wait_counts(page, {"Receiving": 2, "Sorting": 1})
    page.wait_for_selector(".log-entry[data-seq='1']", timeout=10_000)
    assert "Receiving #1" in page.locator(".log-entry[data-seq='1']").inner_text()
    assert "Sorting #5" in page.locator(".log-entry[data-seq='1']").inner_text()
    # Both stages over: the produced token rests in Sorting, nothing travels.
    page.wait_for_function("() => document.querySelectorAll('.animating-token').length === 0",
                           timeout=10_000)
    assert page.locator(".tokens circle.token[data-token-id='5']").count() == 1
    assert page.locator(".tokens circle.token[data-token-id='1']").count() == 0


def test_a_slow_step_is_still_running_not_failed(page: Page, frontend_url: str,
                                                 expected_console_errors: list[str],
                                                 fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    # The browser reports the 504 itself; the page does not treat it as a failure.
    expected_console_errors.append("504 (Gateway Timeout)")
    _seed(cp)
    cp.slow_steps = 1
    cp.slow_step_s = 1.5
    _open(page, frontend_url)

    page.get_by_role("button", name="Step", exact=True).click()
    page.get_by_text("Still running").wait_for(timeout=5_000)
    assert page.locator(".step-error").count() == 0
    assert page.get_attribute("g.transition[data-transition-id='Sort']", "data-look") == "in_flight"
    # The firing lands on the stream, and the page stops waiting for it.
    page.wait_for_selector(".log-entry[data-seq='1']", timeout=10_000)
    page.get_by_text("Still running").wait_for(state="detached", timeout=5_000)
    _wait_counts(page, {"Receiving": 2, "Sorting": 1})
    assert page.locator(".step-error").count() == 0


def test_inject_offers_only_serializable_places_and_shows_the_token(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed(cp)
    _open(page, frontend_url)

    page.get_by_role("button", name="Inject…").click()
    options = page.eval_on_selector_all("select option:not([disabled])", "els => els.map(e => e.value)")
    assert "Config" not in options
    assert {"Receiving", "Sorting", "Dispatched"} <= set(options)

    page.locator("select").filter(has=page.locator("option[value='Dispatched']")).select_option("Dispatched")
    page.get_by_placeholder('{"deviation": 1.2}').fill('{"parcel": 99}')
    page.get_by_role("button", name="Inject", exact=True).click()
    page.get_by_text("Injected token #5 into Dispatched.").wait_for(timeout=5_000)
    _wait_counts(page, {"Dispatched": 1})
    assert page.locator(".tokens circle.token[data-token-id='5']").count() == 1
    assert any(line == f"POST /api/nets/{NET_ID}/inject" for line in cp.requests)


def test_reset_starts_a_new_generation(page: Page, frontend_url: str,
                                       fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed(cp)
    _open(page, frontend_url)
    for _ in range(2):
        fake_cp.fire(cp, NET_ID, "Sort")
    _wait_counts(page, {"Receiving": 1, "Sorting": 2})
    page.wait_for_function("() => document.querySelectorAll('.log-entry').length === 2", timeout=10_000)

    page.get_by_role("button", name="Reset", exact=True).click()
    _wait_counts(page, {"Receiving": 3, "Sorting": 0})
    page.wait_for_function("() => document.querySelectorAll('.log-entry').length === 0", timeout=10_000)
    assert cp.execution_state[NET_ID]["generation"] == 2


def test_a_version_gap_rereads_the_state(page: Page, frontend_url: str,
                                         fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed(cp)
    _open(page, frontend_url)
    reads = _state_reads(cp)

    # The net moved twice; the page hears only the second, at version 9
    # while it holds 7.
    with cp.lock:
        state = cp.execution_state[NET_ID]
        state["marking"]["places"]["Sorting"]["tokens"] = [{"id": "20", "label": "a"}, {"id": "21", "label": "b"}]
        state["marking"]["places"]["Sorting"]["count"] = 2
        state["marking_version"] = 9
    fake_cp.publish_worker(cp, kind="added", net_id=NET_ID, data={
        "place": "Sorting", "id": "21", "label": "b", "marking_version": 9, "running": False})
    _wait_counts(page, {"Sorting": 2})
    assert _state_reads(cp) == reads + 1
    # An old notification changes nothing.
    fake_cp.publish_worker(cp, kind="removed", net_id=NET_ID, data={
        "place": "Sorting", "id": "20", "marking_version": 8, "running": False})
    page.wait_for_timeout(500)
    assert _count(page, "Sorting") == "2"


def test_the_inspector_shows_detail_and_switches_a_transition(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed(cp)
    _open(page, frontend_url)

    page.locator("g.transition[data-transition-id='Sort']").click()
    inspector = page.locator(".transition-inspector")
    assert inspector.locator("[data-detail-key='function_name']").inner_text().endswith("sort_parcel")
    assert "(parcel: Parcel, rules: Rules) -> Parcel" in inspector.locator(
        "[data-detail-key='signature']").inner_text()

    inspector.get_by_role("button", name="Disable").click()
    _wait_look(page, "Sort", "disabled")
    assert cp.execution_state[NET_ID]["transitions"]["Sort"]["enabled"] is False
    inspector.get_by_role("button", name="Enable").click()
    _wait_look(page, "Sort", "fireable")

    # Without detail, the inspector lists the transition's places.
    page.locator("g.transition[data-transition-id='Dispatch']").click()
    assert inspector.locator("[data-arc='in']").inner_text().startswith("Sorting")
    assert inspector.locator("[data-arc='out']").inner_text().startswith("Dispatched")


def test_a_selected_token_shows_its_value(page: Page, frontend_url: str,
                                          fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    _seed(fresh_control_plane)
    _open(page, frontend_url)

    page.locator(".tokens circle.token[data-token-id='2']").click()
    view = page.locator("[data-token-card-id='2'] pre[data-token-view='json']")
    view.wait_for(timeout=5_000)
    assert '"parcel": 2' in view.inner_text()
    page.locator(".tokens circle.token[data-token-id='4']").click()
    text = page.locator("[data-token-card-id='4'] pre[data-token-view='text']")
    text.wait_for(timeout=5_000)
    assert text.inner_text() == "Rules(strict=True)"

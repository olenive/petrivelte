"""The nets page on protocol version 1: what it draws and does for each thing
the net says.

A small parcel net with a read edge and a place without a JSON form. Steps,
injects, resets and switches go through the page's own controls; the fake
moves its net and publishes what a runner would, and the page is checked for
what it shows. Two conformance nets of protocol §11 have the edges that
accept an empty place: the shop's survey, and the traffic light's drain,
beside a plain snapshot. The traffic light also declares controls, which the
legend over the graph presses, and fills its light with its token's colour.
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
    # A net that declares no controls has no legend, and no place is filled
    # by a style.
    assert page.locator("[data-controls-legend]").count() == 0
    assert page.locator(".place-circle[data-fill]").count() == 0


def _price_order(handed: dict[str, list[dict[str, Any]]]) -> list[tuple[str, str]]:
    """The shop's Price Order (§11): the order into Priced, and one discount
    per promotion running, oldest first, into Discounts Applied."""
    order = json.loads(handed["Orders"][0]["label"])
    promotions = [json.loads(token["label"]) for token in handed["Promotions"]]
    return [("Priced", json.dumps(order))] + [
        ("Discounts Applied", json.dumps(f"{promotion} on {order}")) for promotion in promotions]


def _drawn_edges(page: Page) -> list[tuple[str, str, str]]:
    """Every edge drawn, as (stroke, head, marker), sorted."""
    drawn = page.eval_on_selector_all(
        ".edges [data-edge-stroke]",
        "els => els.map(e => [e.dataset.edgeStroke, e.dataset.edgeHead, e.getAttribute('marker-end')])")
    return sorted(tuple(each) for each in drawn)


def _input_arcs(page: Page, transition: str) -> list[str]:
    """The inspector's input rows for `transition`, which sends no detail."""
    page.locator(f"g.transition[data-transition-id='{transition}']").click()
    page.wait_for_function(
        "name => document.querySelector('.transition-inspector .transition-name')?.textContent === name",
        arg=transition, timeout=5_000)
    return page.locator(".transition-inspector [data-arc='in']").all_inner_texts()


def _step(page: Page, seq: int, details: str) -> None:
    """Step through the page's control and wait for the firing's log entry."""
    page.get_by_role("button", name="Step", exact=True).click()
    page.wait_for_selector(f".log-entry[data-seq='{seq}']", timeout=10_000)
    assert page.locator(f".log-entry[data-seq='{seq}'] .details").inner_text() == details


def test_the_shop_draws_its_survey_and_prices_orders(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    # The shop of protocol §11, the survey alone since 2026-10-16, seeded
    # empty: Price Order surveys Promotions.
    cp = fresh_control_plane
    cp.bodies[NET_ID] = {"Price Order": _price_order}
    cp.workers = [fake_cp.worker_row(WORKER_ID)]
    cp.nets = [fake_cp.net_row(NET_ID, WORKER_ID, name="shop", execution_mode="manual")]
    places = ["Orders", "Promotions", "Priced", "Discounts Applied"]
    fake_cp.seed_net(cp, NET_ID, fake_cp.net_state(
        net="shop",
        runtime="rust",
        places=[{"name": name, "type_name": "String", "serializable": True} for name in places],
        transitions=[{"name": "Price Order"}],
        edges=[
            {"place": "Orders", "transition": "Price Order", "direction": "in", "kind": "take"},
            {"place": "Promotions", "transition": "Price Order", "direction": "in", "kind": "survey"},
            {"place": "Priced", "transition": "Price Order", "direction": "out", "slot": 0},
            {"place": "Discounts Applied", "transition": "Price Order", "direction": "out", "slot": 1},
        ],
    ))
    _open(page, frontend_url)

    # The survey is dashed as a snapshot is, and ends in the hollow head.
    assert _drawn_edges(page) == [
        ("dashed", "hollow", "url(#arrowhead-input-hollow)"),
        ("solid", "filled", "url(#arrowhead-input)"),
        ("solid", "filled", "url(#arrowhead-output)"),
        ("solid", "filled", "url(#arrowhead-output)"),
    ]
    # The hollow head is an outline in the input edge's colour, filled with
    # the graph's background.
    fill, stroke, filled, background = page.evaluate(
        "() => [getComputedStyle(document.querySelector('#arrowhead-input-hollow path')).fill,"
        " getComputedStyle(document.querySelector('#arrowhead-input-hollow path')).stroke,"
        " getComputedStyle(document.querySelector('#arrowhead-input path')).fill,"
        " getComputedStyle(document.querySelector('.graph-container')).backgroundColor]")
    assert (fill, stroke) == (background, filled)

    # Without detail, the inspector says what the survey does.
    arcs = _input_arcs(page, "Price Order")
    assert arcs[0] == "Orders"
    assert arcs[1].startswith("Promotions") and arcs[1].endswith("survey: copies every token, zero or more")

    # The script of transcript 07. An order alone makes Price Order
    # fireable, the surveyed Promotions empty, and it fires with no
    # promotion running.
    fake_cp.inject(cp, NET_ID, "Orders", "Order 1")
    _wait_look(page, "Price Order", "fireable")
    _step(page, 1, "Orders #1 → Priced #2")
    _wait_counts(page, {"Orders": 0, "Promotions": 0, "Priced": 1, "Discounts Applied": 0})

    # Two promotions start, which makes nothing fireable; a second order is
    # priced with both, which it surveys and does not take.
    fake_cp.inject(cp, NET_ID, "Promotions", "10% off")
    fake_cp.inject(cp, NET_ID, "Promotions", "Free shipping")
    _wait_counts(page, {"Promotions": 2})
    assert page.get_attribute("g.transition[data-transition-id='Price Order']", "data-look") == "idle"
    fake_cp.inject(cp, NET_ID, "Orders", "Order 2")
    _wait_look(page, "Price Order", "fireable")
    _step(page, 2, "Orders #5 → Priced #6, Discounts Applied #7, Discounts Applied #8")
    _wait_counts(page, {"Orders": 0, "Promotions": 2, "Priced": 2, "Discounts Applied": 2})
    for token_id, discount in (("7", "10% off on Order 2"), ("8", "Free shipping on Order 2")):
        page.locator(f".tokens circle.token[data-token-id='{token_id}']").click()
        view = page.locator(f"[data-token-card-id='{token_id}'] pre[data-token-view='json']")
        view.wait_for(timeout=5_000)
        assert discount in view.inner_text()
    # The promotions still running, and no order: nothing more fires.
    _wait_look(page, "Price Order", "idle")


def _next_colour(colour: str) -> str:
    """The colour after `colour` (§11): red to green, green to amber, amber
    to red."""
    return {"red": "green", "green": "amber"}.get(colour, "red")


def _colour(places: dict[str, dict[str, Any]]) -> str | None:
    """The light's colour as Go's guard reads it: the front token of
    `Light`, or None while it is empty."""
    tokens = places["Light"]["tokens"]
    return json.loads(tokens[0]["label"]) if tokens else None


def _go(handed: dict[str, list[dict[str, Any]]]) -> list[tuple[str, str]]:
    """The traffic light's Go (§11): every car drained from Waiting, oldest
    first, into Passed. The light is only read, so it is not handed over."""
    return [("Passed", car["label"]) for car in handed["Waiting"]]


# The colours the conformance net gives the light's tokens (§11).
COLOURS = {"red": "#ff6347", "green": "#32cd32", "amber": "#ffa500"}
# The same, as a browser's computed style reads them.
RGB = {"red": "rgb(255, 99, 71)", "green": "rgb(50, 205, 50)", "amber": "rgb(255, 165, 0)"}


def _change(handed: dict[str, list[dict[str, Any]]]) -> list[tuple[str, str, str]]:
    """The traffic light's Change (§11): the next colour into Light,
    carrying the colour it is drawn with."""
    colour = _next_colour(json.loads(handed["Light"][0]["label"]))
    return [("Light", json.dumps(colour), COLOURS[colour])]


# The traffic light's controls, as §11 declares them, in this order.
CAR = {"name": "car", "label": "+ Car", "kind": "text", "node": "Waiting", "action": "inject",
       "config": {"placeholder": "name"}}
CHANGE = {"name": "change", "label": "Change", "kind": "button", "node": "Change", "action": "fire"}
# A control the conformance net does not declare: fires Go, which its guard
# holds back except at green with someone waiting.
GO = {"name": "go", "label": "Go", "kind": "button", "node": "Go", "action": "fire"}


def _seed_traffic_light(cp: fake_cp.FakeControlPlane, controls: list[dict[str, Any]] | None = None) -> None:
    """The traffic light of protocol §11 as it is seeded: Light holds one
    token, its colour, "red", as token 0, as the Rust runner numbers it, and
    is filled with its token's colour; nobody is waiting. Go drains Waiting
    and reads Light through a plain snapshot, writing the cars to Passed;
    Change takes the light and writes the next colour back. Go is guarded
    on green and someone waiting, Change not at all; the wire does not say
    so: the page lights what the fake says is fireable. A car pressed in
    with no name is `Car N`, N one more than the cars in Waiting and Passed
    together."""
    cp.bodies[NET_ID] = {"Go": _go, "Change": _change}
    cp.workers = [fake_cp.worker_row(WORKER_ID)]
    cp.nets = [fake_cp.net_row(NET_ID, WORKER_ID, name="traffic-light", execution_mode="manual")]

    def car(value: str) -> tuple[str, None]:
        places = cp.execution_state[NET_ID]["marking"]["places"]
        return json.dumps(value or f"Car {places['Waiting']['count'] + places['Passed']['count'] + 1}"), None

    cp.makers[NET_ID] = {"car": car}
    fake_cp.seed_net(cp, NET_ID, fake_cp.net_state(
        net="traffic-light",
        runtime="rust",
        places=[
            {"name": "Light", "type_name": "String", "serializable": True, "style": {"fill": "token"}},
            *({"name": name, "type_name": "String", "serializable": True} for name in ("Waiting", "Passed")),
        ],
        transitions=[{"name": "Go"}, {"name": "Change"}],
        edges=[
            {"place": "Waiting", "transition": "Go", "direction": "in", "kind": "drain"},
            {"place": "Light", "transition": "Go", "direction": "in", "kind": "snapshot"},
            {"place": "Passed", "transition": "Go", "direction": "out"},
            {"place": "Light", "transition": "Change", "direction": "in", "kind": "take"},
            {"place": "Light", "transition": "Change", "direction": "out"},
        ],
        marking={"Light": [{"id": "0", "label": json.dumps("red"), "color": COLOURS["red"]}]},
        guards={"Go": lambda places: _colour(places) == "green" and places["Waiting"]["count"] > 0},
        controls=controls,
    ))


def _wait_looks(page: Page, looks: dict[str, str]) -> None:
    for transition, look in looks.items():
        _wait_look(page, transition, look)


def test_the_traffic_light_draws_its_drain_and_its_read_and_lets_the_cars_go(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    # The traffic light of protocol §11, since 2026-10-16, the light one
    # place and two transitions in all since later that day, driven by the
    # page's Step as transcript 08 drives it, before its controls.
    cp = fresh_control_plane
    _seed_traffic_light(cp)
    _open(page, frontend_url)

    # The drain is solid as a take_all is and ends in the hollow head; the
    # plain read is dashed and ends in the filled head every other input
    # edge has.
    assert _drawn_edges(page) == sorted([
        ("solid", "hollow", "url(#arrowhead-input-hollow)"),
        ("dashed", "filled", "url(#arrowhead-input)"),
        ("solid", "filled", "url(#arrowhead-input)"),
        *[("solid", "filled", "url(#arrowhead-output)")] * 2,
    ])
    # Of Change's loop through Light, one edge is drawn curved.
    assert page.locator(".edges [data-back-edge='true']").count() == 1

    # Without detail, the inspector says what the drain does, and names the
    # plain read beside it; Change's take is a plain row.
    arcs = _input_arcs(page, "Go")
    assert len(arcs) == 2
    assert arcs[0].startswith("Waiting") and arcs[0].endswith("drain: takes every token, zero or more")
    assert arcs[1].startswith("Light") and arcs[1].endswith("snapshot")
    assert _input_arcs(page, "Change") == ["Light"]

    # The script of transcript 08. Change alone is fireable, Go held by its
    # guard, and the light goes round, a new token for each colour: to
    # green, where Go waits for someone waiting, and on to amber.
    _wait_looks(page, {"Go": "idle", "Change": "fireable"})
    _step(page, 1, "Light #0 → Light #1")
    _wait_looks(page, {"Go": "idle", "Change": "fireable"})
    _step(page, 2, "Light #1 → Light #2")
    _wait_counts(page, {"Light": 1, "Waiting": 0, "Passed": 0})
    _wait_looks(page, {"Go": "idle", "Change": "fireable"})

    # Two cars arrive at amber: only Change is fireable, and they wait
    # through red until the light is green again.
    fake_cp.inject(cp, NET_ID, "Waiting", "Car 1")
    fake_cp.inject(cp, NET_ID, "Waiting", "Car 2")
    _wait_counts(page, {"Waiting": 2})
    _wait_look(page, "Change", "fireable")
    assert page.get_attribute("g.transition[data-transition-id='Go']", "data-look") == "idle"
    _step(page, 3, "Light #2 → Light #5")
    _wait_counts(page, {"Light": 1, "Waiting": 2, "Passed": 0})
    _wait_looks(page, {"Go": "idle", "Change": "fireable"})
    _step(page, 4, "Light #5 → Light #6")
    _wait_looks(page, {"Go": "fireable", "Change": "fireable"})

    # Green with cars waiting: Go, declared first, drains both, oldest
    # first; the light is only read and stays in Light as token 6.
    _step(page, 5, "Waiting #3, Waiting #4 → Passed #7, Passed #8")
    _wait_counts(page, {"Light": 1, "Waiting": 0, "Passed": 2})
    _wait_looks(page, {"Go": "idle", "Change": "fireable"})

    # A car arriving at green goes straight through, reading the light,
    # which stays in Light with its id.
    fake_cp.inject(cp, NET_ID, "Waiting", "Car 3")
    _wait_looks(page, {"Go": "fireable", "Change": "fireable"})
    _step(page, 6, "Waiting #9 → Passed #10")
    _wait_counts(page, {"Light": 1, "Waiting": 0, "Passed": 3})
    page.wait_for_function("() => document.querySelectorAll('.animating-token').length === 0",
                           timeout=10_000)
    assert page.locator(".tokens circle.token[data-token-id='6']").count() == 1
    _wait_looks(page, {"Go": "idle", "Change": "fireable"})
    _step(page, 7, "Light #6 → Light #11")
    _wait_counts(page, {"Light": 1, "Waiting": 0, "Passed": 3})
    for token_id, value in (("7", "Car 1"), ("8", "Car 2"), ("10", "Car 3"), ("11", "amber")):
        page.locator(f".tokens circle.token[data-token-id='{token_id}']").click()
        view = page.locator(f"[data-token-card-id='{token_id}'] pre[data-token-view='json']")
        view.wait_for(timeout=5_000)
        assert value in view.inner_text()
    # The light cycles by itself: the net never quiesces.
    _wait_looks(page, {"Go": "idle", "Change": "fireable"})


def _place_fill(page: Page, place: str) -> str:
    """The fill a place's circle is drawn with, as the browser computes it."""
    return page.eval_on_selector(f".place-circle[data-place-id='{place}'] circle",
                                 "el => getComputedStyle(el).fill")


def _wait_fill(page: Page, place: str, fill: str) -> None:
    page.wait_for_function(
        "([place, fill]) => { const el = document.querySelector("
        "`.place-circle[data-place-id='${place}'] circle`);"
        " return !!el && getComputedStyle(el).fill === fill; }",
        arg=[place, fill], timeout=10_000)


def _theme_colour(page: Page, variable: str) -> str:
    """A theme variable as a computed colour, read where the page reads it."""
    return page.evaluate(
        "v => { const el = document.createElement('span'); el.style.color = `var(${v})`;"
        " document.body.append(el); const c = getComputedStyle(el).color; el.remove(); return c; }",
        variable)


def _wait_lit(page: Page, control: str, lit: bool) -> None:
    page.wait_for_function(
        "([name, lit]) => document.querySelector(`[data-controls-legend] [data-control='${name}']`)"
        "?.dataset.lit === lit",
        arg=[control, "true" if lit else "false"], timeout=5_000)


def _wait_presses(page: Page, cp: fake_cp.FakeControlPlane, n: int) -> None:
    """Wait until the fake has had `n` presses."""
    for _ in range(50):
        if len(cp.presses) >= n:
            return
        page.wait_for_timeout(100)
    raise AssertionError(f"{len(cp.presses)} presses, not {n}: {cp.presses}")


def test_the_legend_presses_the_traffic_lights_controls(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    # The traffic light with the two controls §11 declares: + Car adds a car
    # to Waiting, named as typed, and Change fires Change. Light is filled
    # with its one token's colour.
    cp = fresh_control_plane
    _seed_traffic_light(cp, controls=[CAR, CHANGE])
    _open(page, frontend_url)

    legend = page.locator("[data-controls-legend]")
    assert "Controls (2)" in legend.locator("[data-legend-header]").inner_text()
    assert legend.locator("[data-control]").evaluate_all("els => els.map(e => e.dataset.control)") == [
        "car", "change"]
    # Both rows lit: Change is fireable, and an inject is always lit.
    assert legend.locator("[data-lit='true']").count() == 2
    assert _place_fill(page, "Light") == RGB["red"]

    # A car named as typed, sent with Enter; then one with no name, sent with
    # its button, which the net numbers.
    box = legend.get_by_role("textbox", name="+ Car")
    assert box.get_attribute("placeholder") == "name"
    box.fill("Taxi")
    box.press("Enter")
    _wait_counts(page, {"Waiting": 1})
    box.fill("")
    legend.locator("[data-control='car']").get_by_role("button", name="Send").click()
    _wait_counts(page, {"Light": 1, "Waiting": 2, "Passed": 0})
    assert cp.presses == [{"control": "car", "value": "Taxi"}, {"control": "car", "value": ""}]
    page.locator(".tokens circle.token[data-token-id='2']").click()
    view = page.locator("[data-token-card-id='2'] pre[data-token-view='json']")
    view.wait_for(timeout=5_000)
    assert "Car 2" in view.inner_text()

    # Change fires Change, which a button sends with no value: the log reads
    # the firing, and Light is filled with the next colour.
    legend.get_by_role("button", name="Change", exact=True).click()
    page.wait_for_selector(".log-entry[data-seq='1']", timeout=10_000)
    assert page.locator(".log-entry[data-seq='1'] .details").inner_text() == "Light #0 → Light #3"
    _wait_fill(page, "Light", RGB["green"])
    assert cp.presses[-1] == {"control": "change"}
    # A press that applied something leaves no line.
    assert legend.locator("[data-press-notice]").count() == 0

    # Resting on a row lights the node it acts on, as resting on the node
    # does, once the firing's own highlight is over.
    page.wait_for_selector("g.transition.firing", state="detached", timeout=10_000)
    legend.locator("[data-control='change']").hover()
    page.wait_for_selector("g.transition[data-transition-id='Change'][data-hover]", timeout=5_000)
    assert page.eval_on_selector("g.transition[data-transition-id='Change'] rect",
                                 "el => getComputedStyle(el).fill") == "rgb(0, 102, 204)"
    legend.locator("[data-control='car']").hover()
    page.wait_for_selector(".place-circle[data-place-id='Waiting'][data-hover]", timeout=5_000)
    assert page.locator("g.transition[data-hover]").count() == 0
    page.mouse.move(5, 5)
    page.wait_for_selector("[data-hover]", state="detached", timeout=5_000)

    # The header folds the rows away and brings them back.
    header = legend.locator("[data-legend-header]")
    assert header.get_attribute("aria-expanded") == "true"
    header.click()
    legend.locator("[data-legend-rows]").wait_for(state="detached", timeout=5_000)
    assert header.get_attribute("aria-expanded") == "false"
    assert "Controls (2)" in header.inner_text()
    header.click()
    legend.locator("[data-control='change']").wait_for(timeout=5_000)


def test_a_held_fire_control_is_dim_and_still_sends(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    # A Go control beside the two the net declares: Go is held by its guard
    # at red, so its row is dim, and a press is still sent; the net answers
    # that it did nothing, and the line under the rows says so.
    cp = fresh_control_plane
    _seed_traffic_light(cp, controls=[CAR, CHANGE, GO])
    _open(page, frontend_url)

    legend = page.locator("[data-controls-legend]")
    go = legend.locator("[data-control='go']")
    _wait_lit(page, "go", False)
    assert go.evaluate("el => getComputedStyle(el).opacity") == "0.35"
    assert legend.locator("[data-control='change']").get_attribute("data-lit") == "true"
    assert go.get_by_role("button", name="Go").is_enabled()

    go.get_by_role("button", name="Go").click()
    notice = legend.locator("[data-press-notice]")
    notice.wait_for(timeout=5_000)
    assert notice.inner_text() == "Go: Go is not fireable"
    assert notice.get_attribute("data-press-notice") == "nothing"
    assert notice.evaluate("el => getComputedStyle(el).color") == _theme_colour(page, "--text-secondary")
    assert cp.presses == [{"control": "go"}]
    assert page.locator(".log-entry").count() == 0

    # The next press clears the line. At green with nobody waiting Go is
    # still held; a car arriving lights its row, and Go drains it.
    legend.get_by_role("button", name="Change", exact=True).click()
    notice.wait_for(state="detached", timeout=5_000)
    _wait_fill(page, "Light", RGB["green"])
    _wait_lit(page, "go", False)
    box = legend.get_by_role("textbox", name="+ Car")
    box.fill("Bus")
    box.press("Enter")
    _wait_lit(page, "go", True)
    go.get_by_role("button", name="Go").click()
    _wait_counts(page, {"Light": 1, "Waiting": 0, "Passed": 1})
    _wait_lit(page, "go", False)
    assert legend.locator("[data-press-notice]").count() == 0


def test_a_refused_press_shows_the_error_line(
        page: Page, frontend_url: str, expected_console_errors: list[str],
        fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    # The browser reports the refusal's 404 itself.
    expected_console_errors.append("404 (Not Found)")
    cp = fresh_control_plane
    _seed_traffic_light(cp, controls=[CAR, CHANGE])
    _open(page, frontend_url)
    # The net no longer declares Change by the time it is pressed.
    with cp.lock:
        cp.execution_state[NET_ID]["topology"]["controls"] = [CAR]

    legend = page.locator("[data-controls-legend]")
    legend.get_by_role("button", name="Change", exact=True).click()
    notice = legend.locator("[data-press-notice='error']")
    notice.wait_for(timeout=5_000)
    assert notice.inner_text() == "Change: no control named 'change'"
    assert notice.evaluate("el => getComputedStyle(el).color") == _theme_colour(page, "--danger")
    # Nothing ran: the light is still red, and the row can be pressed again.
    assert _place_fill(page, "Light") == RGB["red"]
    assert page.locator(".log-entry").count() == 0
    assert legend.get_by_role("button", name="Change", exact=True).is_enabled()


def test_the_legend_draws_each_kind_and_sends_its_value(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    # The traffic light with a control of each other kind: a toggle that is
    # Go's switch, a slider and a select, these two with no action.
    cp = fresh_control_plane
    _seed_traffic_light(cp, controls=[
        {"name": "go_on", "label": "Go on", "kind": "toggle", "node": "Go", "action": "enable"},
        {"name": "speed", "label": "Speed", "kind": "slider",
         "config": {"start": 0, "stop": 10, "step": 1, "value": 3}},
        {"name": "mood", "label": "Mood", "kind": "select", "config": {"options": ["calm", "busy"], "value": "calm"}},
    ])
    _open(page, frontend_url)
    legend = page.locator("[data-controls-legend]")

    # The toggle shows Go's switch, and pressing it sends the other state,
    # which the net applies and the toggle follows.
    toggle = legend.get_by_role("button", name="Go on")
    assert toggle.get_attribute("aria-pressed") == "true"
    toggle.click()
    _wait_look(page, "Go", "disabled")
    page.wait_for_function(
        "() => document.querySelector(`[data-control='go_on'] button`)?.getAttribute('aria-pressed') === 'false'",
        timeout=5_000)

    # The slider starts at its initial value and sends each change, its
    # number beside it: a drag let go at 7, then a key one step down.
    slider = legend.get_by_role("slider", name="Speed")
    assert slider.input_value() == "3"
    assert [slider.get_attribute(a) for a in ("min", "max", "step")] == ["0", "10", "1"]
    slider.evaluate("el => { el.value = '7'; el.dispatchEvent(new Event('input', {bubbles: true}));"
                    " el.dispatchEvent(new Event('change', {bubbles: true})); }")
    _wait_presses(page, cp, 2)
    assert legend.locator("[data-control-number]").inner_text() == "7"
    page.wait_for_function("() => !document.querySelector(`[data-control='speed'] input`).disabled",
                           timeout=5_000)
    slider.focus()
    page.keyboard.press("ArrowLeft")
    page.wait_for_function("() => document.querySelector('[data-control-number]')?.textContent === '6'",
                           timeout=5_000)

    # The select starts at its initial option and sends the one chosen.
    select = legend.get_by_role("combobox", name="Mood")
    assert select.input_value() == "calm"
    select.select_option("busy")
    _wait_presses(page, cp, 4)
    assert cp.presses == [{"control": "go_on", "value": False}, {"control": "speed", "value": 7},
                          {"control": "speed", "value": 6}, {"control": "mood", "value": "busy"}]
    assert legend.locator("[data-press-notice]").count() == 0


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

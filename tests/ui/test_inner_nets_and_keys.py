"""The nets page with inner nets and keys (PROTOCOL §12, §13), against the
fake control plane's relay of them.

A small transit net: a bus in Depot holds a cabin, an inner net where
passengers sit down. The page shows the cabin in place of the outer net,
with a breadcrumb and a way back up, follows it as the bus moves, names an
outer firing that reaches inside, and falls back when the bus is gone. A zoo
net with keyed places drives the token filter.
"""

from playwright.sync_api import Page

import fake_cp

WORKER_ID = "worker-1"
TRANSIT = "net-transit"
ZOO = "net-zoo"


def _seed_transit(cp: fake_cp.FakeControlPlane) -> str:
    """The transit net, Depart switched off so that nothing outside is
    fireable; the cabin's nested id."""
    cp.workers = [fake_cp.worker_row(WORKER_ID)]
    cp.nets = [fake_cp.net_row(TRANSIT, WORKER_ID, name="transit", execution_mode="manual")]
    state = fake_cp.net_state(
        net="transit",
        places=[
            {"name": "Platform", "type_name": "str", "serializable": True},
            {"name": "Depot", "type_name": "Vehicle", "serializable": True, "nested": True},
            {"name": "In Transit", "type_name": "Vehicle", "serializable": True, "nested": True},
            {"name": "Scrapyard", "type_name": "str", "serializable": True},
        ],
        transitions=[{"name": "Board"}, {"name": "Depart"}, {"name": "Scrap"}],
        edges=[
            {"place": "Platform", "transition": "Board", "direction": "in", "kind": "take"},
            {"place": "Depot", "transition": "Board", "direction": "in", "kind": "mutate"},
            {"place": "Depot", "transition": "Depart", "direction": "in", "kind": "take"},
            {"place": "In Transit", "transition": "Depart", "direction": "out"},
            {"place": "In Transit", "transition": "Scrap", "direction": "in", "kind": "take"},
            {"place": "Scrapyard", "transition": "Scrap", "direction": "out"},
        ],
        marking={"Depot": [{"id": "1", "label": '"Bus 1"', "color": "#3366cc"}]},
        marking_version=30,
    )
    state["transitions"]["Depart"]["enabled"] = False
    fake_cp._refresh_fireable(state)
    fake_cp.seed_net(cp, TRANSIT, state)
    cabin = fake_cp.net_state(
        net="cabin",
        places=[
            {"name": "Door", "type_name": "str", "serializable": True},
            {"name": "Seats", "type_name": "str", "serializable": True},
        ],
        transitions=[{"name": "Sit"}],
        edges=[
            {"place": "Door", "transition": "Sit", "direction": "in", "kind": "take"},
            {"place": "Seats", "transition": "Sit", "direction": "out"},
        ],
        marking={"Door": [{"id": "1", "label": '"Bram"'}], "Seats": [{"id": "2", "label": '"Cato"'}]},
        marking_version=4,
    )
    cp.boarding[TRANSIT] = {"Board": ("Depot", "Door")}
    return fake_cp.seed_inner(cp, TRANSIT, "1", name="cabin", template="Cabin", state=cabin)


def _open(page: Page, frontend_url: str, net_id: str) -> None:
    page.goto(f"{frontend_url}/nets?net={net_id}")
    page.wait_for_selector("svg.petri-net g.transition", timeout=60_000)


def _wait_counts(page: Page, counts: dict[str, int]) -> None:
    wanted = ",".join(str(n) for n in counts.values())
    names = list(counts)
    page.wait_for_function(
        "([names, wanted]) => names.map((n) => document.querySelector("
        "`.place-text[data-place-id='${n}']`)?.dataset.count).join() === wanted",
        arg=[names, wanted], timeout=10_000)


def _wait_text(page: Page, selector: str, text: str) -> None:
    page.wait_for_function(
        "([selector, text]) => document.querySelector(selector)?.textContent.trim() === text",
        arg=[selector, text], timeout=10_000)


def _descend_by_inspector(page: Page, nested_id: str) -> None:
    page.locator(".tokens circle.token[data-token-id='1']").click()
    page.locator(f"[data-token-card-id='1'] [data-open-net='{nested_id}']").click()
    page.wait_for_selector(".place-text[data-place-id='Door']", timeout=10_000)


def test_a_badged_token_opens_its_net_from_the_inspector(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cabin = _seed_transit(cp)
    _open(page, frontend_url, TRANSIT)

    # The bus is badged with the number of tokens in its cabin.
    _wait_text(page, ".token-badge[data-token-badge='1']", "2")
    page.locator(".tokens circle.token[data-token-id='1']").click()
    row = page.locator(f"[data-token-card-id='1'] .net-row[data-net-id='{cabin}']")
    assert "cabin" in row.inner_text() and "Cabin" in row.inner_text()

    _descend_by_inspector(page, cabin)
    _wait_text(page, "[data-breadcrumb]", "transit > Depot/#1/cabin")
    _wait_counts(page, {"Door": 1, "Seats": 1})
    assert page.locator(".place-text[data-place-id='Depot']").count() == 0
    assert any(line == f"GET /api/nets/{TRANSIT}/execution/state?token_limit=200&nested_id={cabin}"
               for line in cp.requests)

    # A token of the cabin is read with the cabin's address.
    page.locator(".tokens circle.token[data-token-id='2']").click()
    page.locator("[data-token-card-id='2'] pre[data-token-view='json']").wait_for(timeout=5_000)
    assert any(line == f"GET /api/nets/{TRANSIT}/tokens/2?nested_id={cabin}" for line in cp.requests)

    # Inject goes into the cabin, by its address.
    page.get_by_role("button", name="Inject…").click()
    options = page.eval_on_selector_all("select option:not([disabled])", "els => els.map(e => e.value)")
    assert {"Door", "Seats"} <= set(options) and "Platform" not in options
    page.locator("select").filter(has=page.locator("option[value='Door']")).select_option("Door")
    page.get_by_placeholder('{"deviation": 1.2}').fill('"Dan"')
    page.get_by_role("button", name="Inject", exact=True).click()
    page.get_by_text("Injected token #3 into Door in cabin.").wait_for(timeout=5_000)
    _wait_counts(page, {"Door": 2})

    # Up: the outer net again, the badge counting the passenger who came in.
    page.locator("[data-inner-bar]").get_by_role("button", name="Up").click()
    page.wait_for_selector(".place-text[data-place-id='Depot']", timeout=5_000)
    assert page.locator("[data-breadcrumb]").count() == 0
    _wait_text(page, ".token-badge[data-token-badge='1']", "3")


def test_a_double_click_on_a_badged_token_descends(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cabin = _seed_transit(fresh_control_plane)
    _open(page, frontend_url, TRANSIT)
    page.wait_for_selector(".token-badge[data-token-badge='1']", timeout=10_000)

    page.locator(".tokens circle.token[data-token-id='1']").dblclick()
    page.wait_for_selector(".place-text[data-place-id='Door']", timeout=10_000)
    _wait_text(page, "[data-breadcrumb]", "transit > Depot/#1/cabin")
    assert any(f"nested_id={cabin}" in line for line in fresh_control_plane.requests)


def test_the_inner_net_animates_while_the_outer_net_steps(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cabin = _seed_transit(cp)
    _open(page, frontend_url, TRANSIT)
    page.wait_for_selector(".token-badge[data-token-badge='1']", timeout=10_000)
    _descend_by_inspector(page, cabin)

    # Nothing outside can fire, so the step fires inside the cabin: Bram sits.
    page.get_by_role("button", name="Step", exact=True).click()
    page.wait_for_selector(".animating-token[data-token-id='1']", timeout=5_000)
    _wait_counts(page, {"Door": 0, "Seats": 2})
    entry = page.locator(".log-entry[data-seq='1']")
    entry.wait_for(timeout=10_000)
    assert "Sit" in entry.inner_text() and "in transit/Depot/#1/cabin" in entry.inner_text()

    # An outer firing reaching inside is named while the cabin is shown.
    fake_cp.inject(cp, TRANSIT, "Platform", "Eve")
    fake_cp.fire(cp, TRANSIT, "Board")
    _wait_text(page, "[data-outer-note]", "outer: Board")
    _wait_counts(page, {"Door": 1, "Seats": 2})

    # The bus departs: a new token in In Transit, the same cabin; the
    # breadcrumb follows it.
    fake_cp.toggle(cp, TRANSIT, "Depart", True)
    fake_cp.fire(cp, TRANSIT, "Depart")
    new_id = cp.execution_state[TRANSIT]["marking"]["places"]["In Transit"]["tokens"][0]["id"]
    _wait_text(page, "[data-breadcrumb]", f"transit > In Transit/#{new_id}/cabin")
    assert page.locator("[data-view-notice]").count() == 0
    assert page.locator(".place-text[data-place-id='Door']").count() == 1


def test_one_piece_firings_are_named_and_a_change_from_outside_says_so(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cabin = _seed_transit(cp)
    # As the Rust runner's example binary reports a firing: the inner lines
    # and the outer `mutated` first, then `fired`, with no `launched`.
    cp.one_piece_firings = True
    _open(page, frontend_url, TRANSIT)
    page.wait_for_selector(".token-badge[data-token-badge='1']", timeout=10_000)
    _descend_by_inspector(page, cabin)

    fake_cp.inject(cp, TRANSIT, "Platform", "Eve")
    fake_cp.fire(cp, TRANSIT, "Board")
    _wait_text(page, "[data-outer-note]", "outer: Board")
    _wait_counts(page, {"Door": 2})
    page.wait_for_selector("[data-outer-note]", state="detached", timeout=10_000)

    # A change inside that no outer firing claims came from outside.
    fake_cp.inject(cp, TRANSIT, "Door", "Zed", cabin)
    _wait_text(page, "[data-outer-note]", "from outside: not an outer firing")
    _wait_counts(page, {"Door": 3})


def test_the_page_falls_back_when_the_token_is_consumed(
        page: Page, frontend_url: str, expected_console_errors: list[str],
        fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    # The browser reports the 404 that says the cabin is gone.
    expected_console_errors.append("404 (Not Found)")
    cabin = _seed_transit(cp)
    _open(page, frontend_url, TRANSIT)
    page.wait_for_selector(".token-badge[data-token-badge='1']", timeout=10_000)
    _descend_by_inspector(page, cabin)

    fake_cp.toggle(cp, TRANSIT, "Depart", True)
    fake_cp.fire(cp, TRANSIT, "Depart")
    page.wait_for_function("() => document.querySelector('[data-breadcrumb]')?.textContent.includes('In Transit')",
                           timeout=10_000)
    fake_cp.fire(cp, TRANSIT, "Scrap")
    _wait_text(page, "[data-view-notice] span", "Inner net gone: its token was consumed by Scrap.")
    page.wait_for_selector(".place-text[data-place-id='Scrapyard']", timeout=5_000)
    assert page.locator("[data-breadcrumb]").count() == 0
    _wait_counts(page, {"Scrapyard": 1, "In Transit": 0})


def test_the_page_falls_back_when_the_token_is_removed(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cabin = _seed_transit(cp)
    _open(page, frontend_url, TRANSIT)
    page.wait_for_selector(".token-badge[data-token-badge='1']", timeout=10_000)
    _descend_by_inspector(page, cabin)

    fake_cp.remove(cp, TRANSIT, "Depot", "1")
    _wait_text(page, "[data-view-notice] span", "Inner net gone: its token was removed.")
    page.wait_for_selector(".place-text[data-place-id='Depot']", timeout=5_000)
    _wait_counts(page, {"Depot": 0})


def _seed_zoo(cp: fake_cp.FakeControlPlane) -> None:
    cp.workers = [fake_cp.worker_row(WORKER_ID)]
    cp.nets = [fake_cp.net_row(ZOO, WORKER_ID, name="zoo", execution_mode="manual")]
    animal = lambda n, name, cls, legs: {  # noqa: E731
        "id": str(n), "label": f'{{"name": "{name}", "class": "{cls}", "legs": {legs}}}',
        "keys": {"class": cls, "legs": legs}}
    state = fake_cp.net_state(
        net="zoo",
        runtime="rust",
        places=[
            {"name": "Pen", "type_name": "Animal", "serializable": True, "key_names": ["class", "legs"]},
            {"name": "Aviary", "type_name": "Animal", "serializable": True, "key_names": ["class"]},
            {"name": "Keepers", "type_name": "str", "serializable": True},
        ],
        transitions=[{"name": "Move"}],
        edges=[
            {"place": "Pen", "transition": "Move", "direction": "in", "kind": "take"},
            {"place": "Aviary", "transition": "Move", "direction": "out"},
        ],
        marking={
            "Pen": [animal(1, "Dog", "Mammal", 4), animal(2, "Hen", "Bird", 2), animal(3, "Ant", "Insect", 6)],
            "Aviary": [{"id": "4", "label": '{"name": "Owl", "class": "Bird"}', "keys": {"class": "Bird"}}],
            "Keepers": [{"id": "5", "label": '"Ada"'}],
        },
        marking_version=2,
    )
    fake_cp.seed_net(cp, ZOO, state)


def test_the_filter_hides_tokens_and_says_how_many(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    _seed_zoo(cp)
    _open(page, frontend_url, ZOO)
    assert page.locator(".tokens circle.token").count() == 5
    assert page.locator("[data-filter-banner]").count() == 0

    # Keys show as rows in the token inspector.
    page.locator(".tokens circle.token[data-token-id='2']").click()
    row = page.locator("[data-token-card-id='2'] .key-row[data-key-name='class']")
    assert row.inner_text().split() == ["class", "Bird"]

    page.locator("select[data-filter-key]").select_option("class")
    page.locator("[data-filter-value='Insect']").wait_for(timeout=5_000)
    assert any(line == f"GET /api/nets/{ZOO}/distinct?key=class" for line in cp.requests)
    values = page.eval_on_selector_all("[data-filter-value]", "els => els.map(e => e.dataset.filterValue)")
    assert values == ["Mammal", "Bird", "Insect"]

    page.locator("[data-filter-value='Bird']").click()
    page.wait_for_function("() => document.querySelectorAll('.tokens circle.token').length === 2")
    drawn = page.eval_on_selector_all(".tokens circle.token", "els => els.map(e => e.dataset.tokenId).sort()")
    assert drawn == ["2", "4"]
    assert page.get_attribute(".place-text[data-place-id='Pen']", "data-matching") == "1 of 3"
    assert page.get_attribute(".place-text[data-place-id='Keepers']", "data-matching") == "0 of 1"
    assert page.locator("[data-filter-banner-text]").inner_text() == "showing 2 of 5 tokens"

    # A second value of the same key widens (OR); a value of another key narrows (AND).
    page.locator("[data-filter-value='Mammal']").click()
    page.wait_for_function("() => document.querySelectorAll('.tokens circle.token').length === 3")
    page.locator("select[data-filter-key]").select_option("legs")
    page.locator("[data-filter-value='4']").click()
    page.wait_for_function("() => document.querySelectorAll('.tokens circle.token').length === 1")
    assert page.locator("[data-filter-banner-text]").inner_text() == "showing 1 of 5 tokens"

    # The execution log is not filtered: a hidden token's firing is logged.
    fake_cp.fire(cp, ZOO, "Move")
    page.wait_for_selector(".log-entry[data-seq='1']", timeout=10_000)
    assert "Pen #1" in page.locator(".log-entry[data-seq='1']").inner_text()

    page.locator("[data-filter-banner]").get_by_role("button", name="Clear").click()
    page.wait_for_function("() => document.querySelectorAll('.tokens circle.token').length === 5")
    assert page.locator("[data-filter-banner]").count() == 0
    assert page.get_attribute(".place-text[data-place-id='Pen']", "data-matching") is None

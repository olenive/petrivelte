"""The shares page lists the owner's shares, mints one and revokes one, and keeps their bundles.

A world is one or more nets on one worker, so the net picker groups the
owner's nets by worker and, once one is picked, leaves only that worker's
nets selectable; a net on no worker never is. Past that the form judges
nothing: it sends what the owner typed and shows the server's sentence when
the mint is refused. A minted share's link, the public tier's address, `/s/`
and the one-time token, is shown once. Revoked and expired shares stay in the
list, muted and without a Revoke button. A world share names its nets by the
names it carries itself.

A bundle is a zip the public tier serves beside a world share. The page
uploads one as the raw request body, shows the server's sentence when the
upload is refused, refuses a zip over the server's cap in the server's words
before sending it, deletes one after a confirm, and offers the owner's
bundles to a world share's mint.
"""

import json
import re
import zipfile
from pathlib import Path

from playwright.sync_api import Page, expect

import fake_cp
from fake_cp import PUBLIC_SHARE_URL as SHARE_URL

W_ALPHA = "11111111-0000-0000-0000-000000000001"
W_BETA = "11111111-0000-0000-0000-000000000002"
NET_LIGHT = "22222222-0000-0000-0000-000000000001"
NET_SHOP = "22222222-0000-0000-0000-000000000002"
NET_FAR = "22222222-0000-0000-0000-000000000003"
NET_LOOSE = "22222222-0000-0000-0000-000000000004"
NOTEBOOK = "33333333-0000-0000-0000-000000000001"
BUNDLE_CHESS = "44444444-0000-0000-0000-000000000001"
BUNDLE_VIEWER = "44444444-0000-0000-0000-000000000002"
MUTED = re.compile(r"\bopacity-60\b")
NO_INDEX = ("There is no index.html at the root of the zip. Zip the contents of the bundle's folder "
            "rather than the folder itself, so that index.html is at the top.")


def _wired_net(net_id: str, worker_id: str | None, name: str) -> dict:
    return {"id": net_id, "definition_name": f"{name}_net", "instance_name": name,
            "worker_id": worker_id, "deployment_id": None, "load_state": "loaded" if worker_id else "unloaded",
            "load_error": None}


def _wiring() -> dict:
    worker = {"worker_category": "persistent", "worker_type": "fly_machine", "status": "ready",
              "status_detail": None, "memory_mb": 2048, "cpus": 2, "memory_used_mb": None,
              "memory_peak_mb": None}
    return {
        "workers": [{**worker, "id": W_ALPHA, "name": "alpha"}, {**worker, "id": W_BETA, "name": "beta"}],
        "nets": [_wired_net(NET_LIGHT, W_ALPHA, "light"), _wired_net(NET_SHOP, W_ALPHA, "shop"),
                 _wired_net(NET_FAR, W_BETA, "far"), _wired_net(NET_LOOSE, None, "loose")],
        "notebooks": [{"id": NOTEBOOK, "definition_name": "plots", "instance_name": "daily plots",
                       "worker_id": W_ALPHA, "deployment_id": None, "load_state": "loaded",
                       "load_error": None, "desired_load_state": "loaded", "idle_timeout_seconds": None,
                       "effective_idle_timeout_seconds": 14400, "slots": []}],
        "bindings": [],
        "control_plane_build": None,
    }


def _shared_net(net_id: str, worker_id: str | None, name: str) -> dict:
    """A net of a share as the server lists it, with the names read from the net."""
    return {"net_id": net_id, "definition_name": f"{name}_net", "instance_name": name,
            "worker_id": worker_id, "play_places": [], "play_controls": []}


def _zip(path: Path, files: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return path


def _net_box(page: Page, net_id: str):
    return page.locator(f'input[type="checkbox"][value="{net_id}"]')


def _rows(page: Page):
    return page.get_by_test_id("share-row")


def _bundle_rows(page: Page):
    return page.get_by_test_id("bundle-row")


def _bundle_options(page: Page):
    return page.locator('select[name="share-bundle"] option')


def test_mint_a_named_play_world_and_see_its_link_once(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cp.wiring = _wiring()

    page.goto(f"{frontend_url}/shares")
    expect(page.get_by_text("You have no shares.")).to_be_visible(timeout=30_000)
    expect(page.locator('nav a[href="/shares"]')).to_have_text("Shares")

    groups = page.get_by_test_id("share-worker-group")
    expect(groups).to_have_count(3)
    expect(groups.nth(0)).to_contain_text("alpha")
    expect(groups.nth(1)).to_contain_text("beta")
    expect(groups.nth(2)).to_contain_text("No worker")
    expect(groups.nth(2)).to_contain_text("On no worker")
    expect(_net_box(page, NET_LOOSE)).to_be_disabled()
    expect(_net_box(page, NET_FAR)).to_be_enabled()

    page.locator('input[name="share-label"]').fill("game night")
    _net_box(page, NET_LIGHT).check()
    # A world stays on one worker: beta's net and the loose net are now out of reach.
    expect(_net_box(page, NET_FAR)).to_be_disabled()
    expect(groups.nth(1)).to_contain_text("On another worker than the nets picked")
    expect(_net_box(page, NET_SHOP)).to_be_enabled()
    _net_box(page, NET_SHOP).check()

    page.get_by_role("radio", name="play:").check()
    page.locator('input[name="share-seat"]').fill("north")
    expect(page.get_by_test_id("share-play-net")).to_have_count(2)
    page.locator(f'input[name="play-places-{NET_LIGHT}"]').fill(" moves, chat ,")
    page.locator(f'input[name="play-controls-{NET_LIGHT}"]').fill("resign")
    page.locator(f'input[name="play-places-{NET_SHOP}"]').fill("orders")
    page.get_by_role("radio", name="named:").check()
    page.locator('input[name="share-member-email"]').fill("ann@example.com")
    page.locator('input[name="share-expires-in-days"]').fill("7")
    page.locator("summary", has_text="Advanced").click()
    page.locator('input[name="share-max-viewers"]').fill("")
    page.get_by_role("button", name="Create share").click()

    created = page.get_by_test_id("share-created")
    expect(created).to_contain_text('Share "game night" created. Copy its link now: it is shown only once.')
    link = page.get_by_test_id("share-created-text")
    expect(link).to_have_text(f"{SHARE_URL}/s/petri_share_0000" + "A" * 39)

    print("mint body:", json.dumps(cp.share_bodies))
    assert cp.share_bodies == [{
        "label": "game night",
        "resource_kind": "world",
        "nets": [
            {"net_id": NET_LIGHT, "play_places": ["moves", "chat"], "play_controls": ["resign"]},
            {"net_id": NET_SHOP, "play_places": ["orders"], "play_controls": []},
        ],
        "scope": "play",
        "seat": "north",
        "audience": "named",
        "member_email": "ann@example.com",
        "expires_in_days": 7,
        "publish_payloads": False,
        "inputs_per_minute": 60,
    }]

    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    created.get_by_role("button", name="Copy").click()
    expect(created.get_by_role("button", name="Copied")).to_be_visible()
    assert page.evaluate("navigator.clipboard.readText()") == f"{SHARE_URL}/s/petri_share_0000" + "A" * 39

    expect(_rows(page)).to_have_count(1)
    row = _rows(page).first
    expect(row).to_have_attribute("data-status", "active")
    expect(row.get_by_test_id("share-resource")).to_have_text("world: light, shop")
    expect(row).to_contain_text("for ann@example.com")
    expect(row).to_contain_text("seat north")
    expect(row).to_contain_text("light: places moves, chat; controls resign")
    expect(row).to_contain_text("shop: places orders")
    expect(row).to_contain_text("expires in")
    expect(row).to_contain_text("never used")
    expect(page.get_by_text("1 share · 1 active")).to_be_visible()

    # Shown once: a fresh visit lists the share but never shows its link again.
    page.reload()
    expect(_rows(page)).to_have_count(1)
    expect(page.get_by_test_id("share-created")).to_have_count(0)
    expect(page.get_by_text("petri_share_0000AAAA")).to_have_count(0)


def test_a_refused_mint_shows_the_servers_sentence(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        expected_console_errors: list[str]) -> None:
    # The browser logs the refused request itself.
    expected_console_errors.append("status of 422")
    cp = fresh_control_plane
    cp.wiring = _wiring()
    refusal = "A play share needs a seat: the name stamped on its player's inputs"
    cp.share_refusals = [refusal]

    page.goto(f"{frontend_url}/shares")
    expect(_net_box(page, NET_LIGHT)).to_be_enabled(timeout=30_000)
    page.locator('input[name="share-label"]').fill("no seat")
    _net_box(page, NET_LIGHT).check()
    page.get_by_role("radio", name="play:").check()
    page.locator(f'input[name="play-places-{NET_LIGHT}"]').fill("moves")
    page.get_by_role("button", name="Create share").click()

    expect(page.get_by_test_id("share-mint-error")).to_have_text(refusal)
    expect(page.get_by_test_id("share-created")).to_have_count(0)
    # The empty seat went as typed: the server, not the form, refused it.
    assert cp.share_bodies[0]["seat"] == ""
    assert cp.share_bodies[0]["scope"] == "play"
    expect(_rows(page)).to_have_count(0)


def test_mint_a_notebook_share(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cp.wiring = _wiring()

    page.goto(f"{frontend_url}/shares")
    page.get_by_role("radio", name="notebook:").check()
    picker = page.get_by_test_id("share-notebook-picker")
    expect(picker).to_contain_text("daily plots", timeout=30_000)
    picker.get_by_role("radio").check()
    page.locator('input[name="share-label"]').fill("plots")
    page.get_by_role("button", name="Create share").click()

    expect(page.get_by_test_id("share-created")).to_be_visible()
    # A notebook share takes no bundle, so the form offers none.
    expect(page.get_by_test_id("share-bundle-picker")).to_have_count(0)
    assert cp.share_bodies == [{
        "label": "plots",
        "resource_kind": "notebook",
        "notebook_id": NOTEBOOK,
        "scope": "read",
        "audience": "link",
        "expires_in_days": 30,
        "publish_payloads": False,
        "max_viewers": 20,
        "inputs_per_minute": 60,
    }]
    expect(_rows(page).first.get_by_test_id("share-resource")).to_have_text("notebook: daily plots")


def test_revoke_asks_first_and_keeps_the_row_muted(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cp.wiring = _wiring()
    light = _shared_net(NET_LIGHT, W_ALPHA, "light")
    cp.shares = [
        fake_cp.share_row("share-live", label="live one", nets=[light]),
        fake_cp.share_row("share-old", label="old one", nets=[light], expires_at="2026-01-01T00:00:00+00:00"),
        fake_cp.share_row("share-gone", label="gone one", nets=[light], revoked_at="2026-10-01T00:00:00+00:00"),
    ]

    page.goto(f"{frontend_url}/shares")
    rows = _rows(page)
    expect(rows).to_have_count(3, timeout=30_000)
    expect(rows.nth(0)).to_have_attribute("data-status", "active")
    expect(rows.nth(1)).to_have_attribute("data-status", "expired")
    expect(rows.nth(2)).to_have_attribute("data-status", "revoked")
    expect(rows.nth(1)).to_have_class(MUTED)
    expect(rows.nth(2)).to_have_class(MUTED)
    expect(rows.nth(0)).not_to_have_class(MUTED)
    expect(page.get_by_role("button", name="Revoke", exact=True)).to_have_count(1)

    live = rows.nth(0)
    live.get_by_role("button", name="Revoke", exact=True).click()
    expect(live).to_contain_text("Revoke it? Anyone holding its link loses access")
    live.get_by_role("button", name="Cancel").click()
    expect(live.get_by_role("button", name="Yes, revoke")).to_have_count(0)
    assert not [line for line in cp.requests if line.startswith("DELETE")]

    live.get_by_role("button", name="Revoke", exact=True).click()
    live.get_by_role("button", name="Yes, revoke").click()
    expect(live).to_have_attribute("data-status", "revoked")
    expect(live).to_have_class(MUTED)
    expect(page.get_by_role("button", name="Revoke", exact=True)).to_have_count(0)
    assert [line for line in cp.requests if line.startswith("DELETE")] == ["DELETE /api/shares/share-live"]
    expect(page.get_by_text("3 shares · 0 active")).to_be_visible()


def test_upload_a_bundle_and_see_it_listed_and_offered(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        tmp_path: Path) -> None:
    cp = fresh_control_plane
    cp.wiring = _wiring()
    # Long enough to see the upload under way.
    cp.slow_upload_s = 1.5
    chess = _zip(tmp_path / "chess.zip", {
        "index.html": b"<!doctype html><title>chess</title><script src=game.js></script>",
        "game.js": b"console.log('chess');",
        "game_bg.wasm": b"\x00asm" + b"\x00" * 1_499_996,
    })

    page.goto(f"{frontend_url}/shares")
    bundles = page.get_by_test_id("bundles")
    expect(bundles.get_by_text("You have no bundles.")).to_be_visible(timeout=30_000)
    expect(bundles).to_contain_text(
        "A bundle is a zip with index.html at its root, at most 64 MiB, served beside a shared world.")
    upload = bundles.get_by_role("button", name="Upload")
    expect(upload).to_be_disabled()
    expect(_bundle_options(page)).to_have_text(["none"])

    page.locator('input[name="bundle-label"]').fill("chess board")
    page.locator('input[name="bundle-file"]').set_input_files(str(chess))
    expect(upload).to_be_enabled()
    upload.click()

    busy = bundles.get_by_role("button", name="Uploading...")
    expect(busy).to_be_disabled()
    expect(page.get_by_test_id("bundle-uploading")).to_contain_text("Uploading chess.zip")
    expect(_bundle_rows(page)).to_have_count(1, timeout=10_000)
    expect(page.get_by_test_id("bundle-uploading")).to_have_count(0)

    row = _bundle_rows(page).first
    expect(row).to_contain_text("chess board")
    expect(row).to_contain_text("1.5 MB uncompressed · 3 files · uploaded")
    expect(bundles).to_contain_text("1 bundle")
    # The form is ready for the next upload.
    expect(page.locator('input[name="bundle-label"]')).to_have_value("")
    expect(upload).to_be_disabled()

    [sent] = cp.bundle_uploads
    assert sent["label"] == "chess board"
    assert sent["content_type"] == "application/zip"
    assert sent["body"] == chess.read_bytes()
    assert [line for line in cp.requests if line.startswith("POST /api/bundles")] == [
        "POST /api/bundles?label=chess%20board"]

    # The new bundle is offered to a world share at once.
    expect(_bundle_options(page)).to_have_text(["none", "chess board"])


def test_a_refused_upload_shows_the_servers_sentence(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        expected_console_errors: list[str], tmp_path: Path) -> None:
    expected_console_errors.append("status of 422")
    cp = fresh_control_plane
    cp.bundle_refusals = [(422, NO_INDEX)]
    folder = _zip(tmp_path / "chess.zip", {"chess/index.html": b"<!doctype html>"})

    page.goto(f"{frontend_url}/shares")
    bundles = page.get_by_test_id("bundles")
    expect(bundles.get_by_text("You have no bundles.")).to_be_visible(timeout=30_000)
    page.locator('input[name="bundle-label"]').fill("chess board")
    page.locator('input[name="bundle-file"]').set_input_files(str(folder))
    bundles.get_by_role("button", name="Upload").click()

    expect(page.get_by_test_id("bundle-upload-error")).to_have_text(NO_INDEX)
    expect(_bundle_rows(page)).to_have_count(0)
    expect(bundles.get_by_text("You have no bundles.")).to_be_visible()
    # What the owner typed stays, to fix and send again.
    expect(page.locator('input[name="bundle-label"]')).to_have_value("chess board")
    expect(bundles.get_by_role("button", name="Upload")).to_be_enabled()
    assert len(cp.bundle_uploads) == 1


def test_a_zip_over_the_cap_is_refused_before_it_is_sent(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        tmp_path: Path) -> None:
    # A server can answer 413 before the body is all sent, which a browser may
    # report only as a failed fetch, so the page refuses the zip itself.
    cp = fresh_control_plane
    huge = tmp_path / "huge.zip"
    with huge.open("wb") as sparse:
        sparse.truncate(64 * 1024 * 1024 + 1)
    chess = _zip(tmp_path / "chess.zip", {"index.html": b"<!doctype html><title>chess</title>"})

    page.goto(f"{frontend_url}/shares")
    bundles = page.get_by_test_id("bundles")
    expect(bundles.get_by_text("You have no bundles.")).to_be_visible(timeout=30_000)
    page.locator('input[name="bundle-label"]').fill("chess board")
    page.locator('input[name="bundle-file"]').set_input_files(str(huge))
    bundles.get_by_role("button", name="Upload").click()

    expect(page.get_by_test_id("bundle-upload-error")).to_have_text("A bundle's zip is at most 64 MiB.")
    assert cp.bundle_uploads == []
    assert not [line for line in cp.requests if line.startswith("POST /api/bundles")]
    expect(page.locator('input[name="bundle-label"]')).to_have_value("chess board")

    # A zip within the cap then goes, and the sentence clears.
    page.locator('input[name="bundle-file"]').set_input_files(str(chess))
    bundles.get_by_role("button", name="Upload").click()
    expect(_bundle_rows(page)).to_have_count(1, timeout=10_000)
    expect(page.get_by_test_id("bundle-upload-error")).to_have_count(0)
    [sent] = cp.bundle_uploads
    assert sent["body"] == chess.read_bytes()


def test_delete_a_bundle_asks_first_and_its_share_carries_on_without_it(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    # No wiring: the share list names a world's nets from the share itself.
    cp.wiring = None
    cp.bundles = [fake_cp.bundle_row(BUNDLE_CHESS, label="chess board", size_bytes=28_600_000, file_count=42),
                  fake_cp.bundle_row(BUNDLE_VIEWER, label="viewer", file_count=1)]
    cp.shares = [fake_cp.share_row("share-game", label="game night",
                                   nets=[_shared_net(NET_LIGHT, W_ALPHA, "light"),
                                         _shared_net(NET_SHOP, W_ALPHA, "shop")],
                                   bundle_id=BUNDLE_CHESS, bundle_label="chess board")]

    page.goto(f"{frontend_url}/shares")
    rows = _bundle_rows(page)
    expect(rows).to_have_count(2, timeout=30_000)
    expect(rows.nth(0)).to_contain_text("28.6 MB uncompressed · 42 files")
    expect(rows.nth(1)).to_contain_text("1 file ·")
    share = _rows(page).first
    expect(share.get_by_test_id("share-resource")).to_have_text("world: light, shop")
    expect(share.get_by_test_id("share-bundle")).to_have_text("bundle chess board")

    chess = rows.nth(0)
    chess.get_by_role("button", name="Delete", exact=True).click()
    expect(chess).to_contain_text("Delete it? Shares that serve it carry on without it")
    chess.get_by_role("button", name="Cancel").click()
    expect(chess.get_by_role("button", name="Yes, delete")).to_have_count(0)
    assert not [line for line in cp.requests if line.startswith("DELETE")]

    chess.get_by_role("button", name="Delete", exact=True).click()
    chess.get_by_role("button", name="Yes, delete").click()
    expect(rows).to_have_count(1)
    expect(rows.first).to_contain_text("viewer")
    assert [line for line in cp.requests if line.startswith("DELETE")] == [
        f"DELETE /api/bundles/{BUNDLE_CHESS}"]
    # The share stands, without the bundle.
    expect(share.get_by_test_id("share-bundle")).to_have_count(0)
    expect(share).to_have_attribute("data-status", "active")
    expect(_bundle_options(page)).to_have_text(["none", "viewer"])


def test_mint_a_world_share_with_a_bundle(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cp.wiring = _wiring()
    cp.bundles = [fake_cp.bundle_row(BUNDLE_CHESS, label="chess board"),
                  fake_cp.bundle_row(BUNDLE_VIEWER, label="viewer")]

    page.goto(f"{frontend_url}/shares")
    expect(_bundle_options(page)).to_have_text(["none", "chess board", "viewer"], timeout=30_000)
    select = page.locator('select[name="share-bundle"]')
    expect(select.locator("option:checked")).to_have_text("none")

    # Offered on a world of either scope, never on a notebook.
    page.get_by_role("radio", name="play:").check()
    expect(page.get_by_test_id("share-bundle-picker")).to_be_visible()
    page.get_by_role("radio", name="read:").check()
    page.get_by_role("radio", name="notebook:").check()
    expect(page.get_by_test_id("share-bundle-picker")).to_have_count(0)
    page.get_by_role("radio", name="world:").check()

    page.locator('input[name="share-label"]').fill("game night")
    _net_box(page, NET_LIGHT).check()
    page.locator('select[name="share-bundle"]').select_option(label="chess board")
    page.get_by_role("button", name="Create share").click()

    expect(page.get_by_test_id("share-created")).to_be_visible()
    assert cp.share_bodies == [{
        "label": "game night",
        "resource_kind": "world",
        "nets": [{"net_id": NET_LIGHT}],
        "bundle_id": BUNDLE_CHESS,
        "scope": "read",
        "audience": "link",
        "expires_in_days": 30,
        "publish_payloads": False,
        "max_viewers": 20,
        "inputs_per_minute": 60,
    }]
    row = _rows(page).first
    expect(row.get_by_test_id("share-resource")).to_have_text("world: light")
    expect(row.get_by_test_id("share-bundle")).to_have_text("bundle chess board")

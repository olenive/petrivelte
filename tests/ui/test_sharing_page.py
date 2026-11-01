"""The Sharing page lists the owner's shares, mints one and revokes one, and keeps their bundles.

A world is one or more nets on one worker, so the net picker groups the
owner's nets by worker and, once one is picked, leaves only that worker's
nets selectable; a net on no worker never is. Past that the form judges
nothing: it sends what the owner typed and shows the server's sentence when
the mint is refused. Ticking "Publish payloads" on a link or public share
warns, under the checkbox, who will see token values; a named share adds no
warning. A minted share's link, the public tier's address, `/s/` and the
one-time token, is shown once. Revoked and expired shares stay in the
list, muted and without a Revoke button. A share names its nets, or its
notebook, by the names it carries itself.

A public share is read only and served at `/p/<handle>/<slug>`, under one
of the handles the owner reserves ahead, up to the account's limit, in the
Public handles box or on the spot in the form. A handle no public share is
live under can be renamed inline or released after a warning; one in use
says to revoke its shares first instead, and the server's refusals show as
they arrive. The form offers the handle used last, the slug follows the
label until edited, and the address is shown after the mint and again in
the list, never the token. An address is held per handle, and an expired
public share keeps a Revoke button, since it holds its address until
revoked.

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

    page.goto(f"{frontend_url}/sharing")
    expect(page.get_by_text("You have no shares.")).to_be_visible(timeout=30_000)
    expect(page.locator('nav a[href="/sharing"]')).to_have_text("Sharing")
    expect(page).to_have_title("Sharing · Petri")

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

    page.goto(f"{frontend_url}/sharing")
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

    page.goto(f"{frontend_url}/sharing")
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


def test_publishing_payloads_warns_who_will_see_token_values(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cp.wiring = _wiring()
    dialogs: list[str] = []
    page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))

    page.goto(f"{frontend_url}/sharing")
    expect(page.get_by_text("You have no shares.")).to_be_visible(timeout=30_000)
    publish = page.locator('input[name="share-publish-payloads"]')
    warning = page.get_by_test_id("share-payload-warning")
    expect(page.get_by_role("radio", name="link:")).to_be_checked()
    expect(warning).to_have_count(0)

    publish.check()
    expect(warning).to_have_text("Token values will be visible to anyone who has the link.")
    # The line sits in a polite live region, so a screen reader hears it appear and change.
    expect(warning.locator("xpath=..")).to_have_attribute("aria-live", "polite")

    page.get_by_role("radio", name="public:").check()
    expect(warning).to_have_text("Token values will be visible to anyone, at a public address.")

    # A named share's one viewer is chosen by the owner, so it adds no warning.
    page.get_by_role("radio", name="named:").check()
    expect(warning).to_have_count(0)

    page.get_by_role("radio", name="public:").check()
    expect(warning).to_be_visible()
    publish.uncheck()
    expect(warning).to_have_count(0)

    # A warning, not a question: no dialog, and nothing sent.
    assert dialogs == []
    assert cp.share_bodies == []


def test_the_list_names_a_notebook_share_from_the_share_itself(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    # No wiring: the pickers' view knows no notebook, and the list needs none.
    cp.wiring = None
    cp.shares = [fake_cp.share_row("share-plots", label="plots", resource_kind="notebook",
                                   notebook_id=NOTEBOOK, notebook_name="daily plots")]

    page.goto(f"{frontend_url}/sharing")
    expect(_rows(page)).to_have_count(1, timeout=30_000)
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

    page.goto(f"{frontend_url}/sharing")
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

    page.goto(f"{frontend_url}/sharing")
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

    page.goto(f"{frontend_url}/sharing")
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

    page.goto(f"{frontend_url}/sharing")
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

    page.goto(f"{frontend_url}/sharing")
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

    page.goto(f"{frontend_url}/sharing")
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


TAKEN = "That handle is taken; choose another"
RELEASE_WARNING = ("Release {}? It will no longer be reserved for you: anyone may take it, "
                   "and a new holder could publish at addresses you once used.")


def _public_share(share_id: str, *, label: str, handle: str = "oleg", slug: str, **overrides) -> dict:
    """A public notebook share as the server lists it."""
    return fake_cp.share_row(share_id, label=label, resource_kind="notebook", notebook_id=NOTEBOOK,
                             notebook_name="daily plots", audience="public", handle=handle, slug=slug,
                             public_path=f"/p/{handle}/{slug}", **overrides)


def _pick_the_notebook(page: Page) -> None:
    page.get_by_role("radio", name="notebook:").check()
    picker = page.get_by_test_id("share-notebook-picker")
    expect(picker).to_contain_text("daily plots", timeout=30_000)
    picker.get_by_role("radio").check()


def _handles_box(page: Page):
    return page.get_by_test_id("public-handles")


def _handle_rows(page: Page):
    return page.get_by_test_id("handle-row")


def _handle_row(page: Page, handle: str):
    return page.locator(f'[data-testid="handle-row"][data-handle="{handle}"]')


def _reserve_in_box(page: Page, handle: str) -> None:
    box = _handles_box(page)
    box.locator('input[name="reserve-handle"]').fill(handle)
    box.get_by_role("button", name="Reserve", exact=True).click()


def _handle_options(page: Page):
    return page.locator('select[name="share-handle"] option')


def _requests(cp: fake_cp.FakeControlPlane, start: str) -> list[str]:
    return [line for line in cp.requests if line.startswith(start)]


def test_reserve_handles_up_to_the_limit_and_see_the_refusal(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        expected_console_errors: list[str]) -> None:
    # The browser logs each refused request itself.
    expected_console_errors.extend(["status of 409", "status of 422"])
    cp = fresh_control_plane
    cp.handle_limit = 2
    cp.taken_handles = {"taken"}

    page.goto(f"{frontend_url}/sharing")
    box = _handles_box(page)
    expect(box.get_by_text("You have no handles yet.")).to_be_visible(timeout=30_000)
    expect(page.get_by_test_id("handles-count")).to_have_text("0 of 2 handles reserved")
    # The box sits above the share form.
    assert page.evaluate("""() => {
        const box = document.querySelector('[data-testid="public-handles"]');
        const form = document.querySelector('[data-testid="share-form"]');
        return Boolean(box.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING);
    }""")

    # Each refusal shows the server's sentence, and nothing is reserved.
    _reserve_in_box(page, "taken")
    expect(page.get_by_test_id("reserve-handle-error")).to_have_text(TAKEN)
    _reserve_in_box(page, "sharing")
    expect(page.get_by_test_id("reserve-handle-error")).to_have_text("The handle sharing is reserved; choose another")
    expect(_handle_rows(page)).to_have_count(0)

    _reserve_in_box(page, "oleg")
    expect(_handle_rows(page)).to_have_count(1)
    expect(_handle_row(page, "oleg")).to_contain_text("no live shares")
    expect(page.get_by_test_id("reserve-handle-error")).to_have_count(0)
    expect(box.locator('input[name="reserve-handle"]')).to_have_value("")
    expect(page.get_by_test_id("handles-count")).to_have_text("1 of 2 handles reserved")

    _reserve_in_box(page, "tailarm")
    expect(_handle_rows(page)).to_have_count(2)
    expect(page.get_by_test_id("handles-count")).to_have_text("2 of 2 handles reserved")
    # At the limit the field and its button wait, and say why.
    expect(box.locator('input[name="reserve-handle"]')).to_be_disabled()
    expect(box.get_by_role("button", name="Reserve", exact=True)).to_be_disabled()
    expect(page.get_by_test_id("handles-at-limit")).to_have_text(
        "You hold as many handles as your account allows; release one to reserve another.")
    assert cp.handle_bodies == [{"handle": "taken"}, {"handle": "sharing"}, {"handle": "oleg"},
                                {"handle": "tailarm"}]
    assert [held["handle"] for held in cp.public_handles] == ["oleg", "tailarm"]

    # A page whose count is stale, because another tab reserved meanwhile,
    # gets the server's refusal and then shows the limit.
    with cp.lock:
        cp.public_handles.pop()
    page.reload()
    expect(page.get_by_test_id("handles-count")).to_have_text("1 of 2 handles reserved", timeout=30_000)
    with cp.lock:
        cp.public_handles.append(fake_cp.handle_row("elsewhere"))
    _reserve_in_box(page, "games")
    expect(page.get_by_test_id("reserve-handle-error")).to_have_text(
        "You already hold 2 handles; release one first")
    expect(page.get_by_test_id("handles-count")).to_have_text("2 of 2 handles reserved")
    expect(_handle_row(page, "elsewhere")).to_be_visible()
    expect(page.get_by_test_id("handles-at-limit")).to_be_visible()


def test_rename_and_release_a_free_handle_with_the_warning(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        expected_console_errors: list[str]) -> None:
    expected_console_errors.append("status of 409")
    cp = fresh_control_plane
    cp.public_handles = [fake_cp.handle_row("oleg"), fake_cp.handle_row("tailarm")]
    cp.taken_handles = {"taken"}

    page.goto(f"{frontend_url}/sharing")
    expect(_handle_rows(page)).to_have_count(2, timeout=30_000)
    expect(page.get_by_test_id("handles-count")).to_have_text("2 of 3 handles reserved")
    row = _handle_row(page, "tailarm")
    expect(row).to_contain_text("no live shares")

    # Rename opens an inline edit; Cancel sends nothing.
    row.get_by_role("button", name="Rename").click()
    rename = page.get_by_label("New name for tailarm")
    expect(rename).to_have_value("tailarm")
    row.get_by_role("button", name="Cancel").click()
    expect(page.get_by_label("New name for tailarm")).to_have_count(0)
    assert not _requests(cp, "PUT")

    # A taken name is refused in the row, and the edit stays open to fix it.
    row.get_by_role("button", name="Rename").click()
    page.get_by_label("New name for tailarm").fill("taken")
    row.get_by_role("button", name="Save").click()
    expect(row.get_by_test_id("handle-row-error")).to_have_text(TAKEN)
    page.get_by_label("New name for tailarm").fill("boards")
    row.get_by_role("button", name="Save").click()
    renamed = _handle_row(page, "boards")
    expect(renamed).to_contain_text("no live shares")
    expect(_handle_row(page, "tailarm")).to_have_count(0)
    expect(renamed.get_by_test_id("handle-row-error")).to_have_count(0)
    assert _requests(cp, "PUT") == ["PUT /api/public-handles/tailarm", "PUT /api/public-handles/tailarm"]
    assert cp.handle_bodies == [{"handle": "taken"}, {"handle": "boards"}]
    assert [held["handle"] for held in cp.public_handles] == ["oleg", "boards"]

    # Release warns first; Cancel sends nothing.
    renamed.get_by_role("button", name="Release").click()
    expect(renamed.get_by_test_id("handle-release-warning")).to_have_text(RELEASE_WARNING.format("boards"))
    renamed.get_by_role("button", name="Cancel").click()
    expect(renamed.get_by_test_id("handle-release-warning")).to_have_count(0)
    assert not _requests(cp, "DELETE")

    renamed.get_by_role("button", name="Release").click()
    renamed.get_by_role("button", name="Yes, release").click()
    expect(_handle_rows(page)).to_have_count(1)
    expect(_handle_row(page, "boards")).to_have_count(0)
    expect(page.get_by_test_id("handles-count")).to_have_text("1 of 3 handles reserved")
    assert _requests(cp, "DELETE") == ["DELETE /api/public-handles/boards"]
    assert [held["handle"] for held in cp.public_handles] == ["oleg"]

    # What the page shows is what the server holds.
    page.reload()
    expect(_handle_rows(page)).to_have_count(1, timeout=30_000)
    expect(_handle_row(page, "oleg")).to_be_visible()


def test_a_handle_in_use_refuses_rename_and_release(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        expected_console_errors: list[str]) -> None:
    expected_console_errors.append("status of 409")
    cp = fresh_control_plane
    cp.wiring = _wiring()
    cp.public_handles = [fake_cp.handle_row("oleg"), fake_cp.handle_row("tailarm"), fake_cp.handle_row("games")]
    cp.shares = [
        _public_share("share-boards", label="boards", slug="reachability"),
        _public_share("share-old", label="old boards", slug="old", expires_at="2026-01-01T00:00:00+00:00"),
        _public_share("share-gone", label="gone", handle="tailarm", slug="gone",
                      revoked_at="2026-10-01T00:00:00+00:00"),
    ]

    page.goto(f"{frontend_url}/sharing")
    expect(_handle_rows(page)).to_have_count(3, timeout=30_000)
    # Two unrevoked public shares, one of them expired, keep oleg in use.
    oleg = _handle_row(page, "oleg")
    expect(oleg).to_contain_text("2 live shares")
    expect(oleg.get_by_test_id("handle-in-use")).to_have_text("revoke its 2 public shares first")
    expect(oleg.get_by_role("button", name="Rename")).to_have_count(0)
    expect(oleg.get_by_role("button", name="Release")).to_have_count(0)
    # A revoked share holds nothing, so tailarm is free.
    tailarm = _handle_row(page, "tailarm")
    expect(tailarm).to_contain_text("no live shares")
    expect(tailarm.get_by_test_id("handle-in-use")).to_have_count(0)

    # A share minted elsewhere since the page read the list puts tailarm in
    # use: the server refuses the rename, the sentence shows in its row, and
    # the row catches up.
    tailarm.get_by_role("button", name="Rename").click()
    page.get_by_label("New name for tailarm").fill("boards")
    with cp.lock:
        cp.shares.insert(0, _public_share("share-t", label="t", handle="tailarm", slug="new"))
    tailarm.get_by_role("button", name="Save").click()
    expect(tailarm.get_by_test_id("handle-row-error")).to_have_text("Revoke the 1 public share under tailarm first")
    expect(tailarm.get_by_test_id("handle-in-use")).to_have_text("revoke its 1 public share first")
    expect(page.get_by_label("New name for tailarm")).to_have_count(0)

    # And the same for a release of games, with two shares minted elsewhere.
    games = _handle_row(page, "games")
    expect(games).to_contain_text("no live shares")
    games.get_by_role("button", name="Release").click()
    with cp.lock:
        cp.shares[:0] = [_public_share("share-g1", label="g1", handle="games", slug="one"),
                         _public_share("share-g2", label="g2", handle="games", slug="two")]
    games.get_by_role("button", name="Yes, release").click()
    expect(games.get_by_test_id("handle-row-error")).to_have_text("Revoke the 2 public shares under games first")
    expect(games.get_by_test_id("handle-in-use")).to_have_text("revoke its 2 public shares first")
    expect(games.get_by_role("button", name="Release")).to_have_count(0)
    assert [held["handle"] for held in cp.public_handles] == ["oleg", "tailarm", "games"]
    assert _requests(cp, "PUT") == ["PUT /api/public-handles/tailarm"]
    assert _requests(cp, "DELETE") == ["DELETE /api/public-handles/games"]

    # Revoking both of oleg's shares, the expired one too, frees it.
    rows = _rows(page)
    for label in ("boards", "old boards"):
        share = rows.filter(has_text=label).first
        share.get_by_role("button", name="Revoke", exact=True).click()
        share.get_by_role("button", name="Yes, revoke").click()
        expect(share).to_have_attribute("data-status", "revoked")
    expect(oleg).to_contain_text("no live shares")
    expect(oleg.get_by_test_id("handle-in-use")).to_have_count(0)
    expect(oleg.get_by_role("button", name="Rename")).to_be_visible()
    expect(oleg.get_by_role("button", name="Release")).to_be_visible()


def test_mint_a_public_share_choosing_a_handle_from_the_select(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        expected_console_errors: list[str]) -> None:
    expected_console_errors.append("status of 409")
    cp = fresh_control_plane
    cp.wiring = _wiring()
    cp.taken_handles = {"taken"}
    cp.public_handles = [
        fake_cp.handle_row("oleg", last_used_at="2026-10-29T10:00:00+00:00"),
        fake_cp.handle_row("tailarm", last_used_at="2026-10-30T10:00:00+00:00"),
    ]

    page.goto(f"{frontend_url}/sharing")
    expect(page.get_by_text("You have no shares.")).to_be_visible(timeout=30_000)
    _pick_the_notebook(page)
    page.locator('input[name="share-label"]').fill("Reachability boards")
    page.get_by_role("radio", name="play:").check()
    page.get_by_role("radio", name="public:").check()

    # Public is read only, and lasts a year unless the owner says otherwise.
    expect(page.get_by_role("radio", name="read:")).to_be_checked()
    expect(page.get_by_role("radio", name="play:")).to_be_disabled()
    expect(page.get_by_test_id("share-public-read-only")).to_have_text("A public share is read only.")
    expires = page.locator('input[name="share-expires-in-days"]')
    expect(expires).to_have_value("365")
    expect(expires).to_have_attribute("placeholder", "365")

    # The select offers every handle and a new one, the one used last first.
    select = page.locator('select[name="share-handle"]')
    expect(_handle_options(page)).to_have_text(["oleg", "tailarm", "new handle…"])
    expect(select).to_have_value("tailarm")
    slug = page.locator('input[name="share-slug"]')
    expect(slug).to_have_value("reachability-boards")
    preview = page.get_by_test_id("share-public-preview")
    expect(preview).to_have_text(f"{SHARE_URL}/p/tailarm/reachability-boards")
    create = page.get_by_role("button", name="Create share")
    expect(create).to_be_enabled()

    # "new handle…" reveals a field, and the mint waits for a handle.
    select.select_option(label="new handle…")
    form = page.get_by_test_id("share-form")
    new_handle = form.locator('input[name="share-new-handle"]')
    expect(new_handle).to_be_visible()
    expect(create).to_be_disabled()
    expect(page.get_by_test_id("share-needs-handle")).to_be_visible()
    new_handle.fill("taken")
    form.get_by_role("button", name="Reserve", exact=True).click()
    expect(page.get_by_test_id("share-new-handle-error")).to_have_text(TAKEN)
    new_handle.fill("games")
    form.get_by_role("button", name="Reserve", exact=True).click()
    # Reserved on the spot, the new handle is chosen, and the account is at its limit.
    expect(new_handle).to_have_count(0)
    expect(_handle_options(page)).to_have_text(["oleg", "tailarm", "games"])
    expect(select).to_have_value("games")
    expect(_handle_row(page, "games")).to_be_visible()
    expect(page.get_by_test_id("handles-count")).to_have_text("3 of 3 handles reserved")

    select.select_option("oleg")
    expect(preview).to_have_text(f"{SHARE_URL}/p/oleg/reachability-boards")
    # Edited, the slug stays as typed when the label changes.
    slug.fill("reachability")
    page.locator('input[name="share-label"]').fill("nb reachability")
    expect(slug).to_have_value("reachability")
    address = f"{SHARE_URL}/p/oleg/reachability"
    expect(preview).to_have_text(address)
    create.click()

    created = page.get_by_test_id("share-created")
    expect(created).to_contain_text('Share "nb reachability" created at its public address')
    expect(page.get_by_test_id("share-created-text")).to_have_text(address)
    expect(created).not_to_contain_text("petri_share_")
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    created.get_by_role("button", name="Copy").click()
    expect(created.get_by_role("button", name="Copied")).to_be_visible()
    assert page.evaluate("navigator.clipboard.readText()") == address

    print("mint body:", json.dumps(cp.share_bodies))
    assert cp.share_bodies == [{
        "label": "nb reachability",
        "resource_kind": "notebook",
        "notebook_id": NOTEBOOK,
        "scope": "read",
        "audience": "public",
        "handle": "oleg",
        "slug": "reachability",
        "expires_in_days": 365,
        "publish_payloads": False,
        "max_viewers": 20,
        "inputs_per_minute": 60,
    }]
    assert cp.handle_bodies == [{"handle": "taken"}, {"handle": "games"}]

    # The handle now has a live share, so it can be neither renamed nor released.
    expect(_handle_row(page, "oleg").get_by_test_id("handle-in-use")).to_have_text(
        "revoke its 1 public share first")

    # The list shows the address in full with a Copy beside it, and no token prefix.
    row = _rows(page).first
    expect(row.get_by_text("public", exact=True)).to_be_visible()
    expect(row.get_by_test_id("share-public-address")).to_have_text(address)
    expect(row).not_to_contain_text("petri_share_")

    # The address is not a secret: a fresh visit lists it again, with its
    # Copy, and the form now offers oleg first, the handle used last.
    page.reload()
    expect(_rows(page)).to_have_count(1, timeout=30_000)
    expect(page.get_by_test_id("share-created")).to_have_count(0)
    row = _rows(page).first
    expect(row.get_by_test_id("share-public-address")).to_have_text(address)
    page.evaluate("navigator.clipboard.writeText('')")
    row.get_by_role("button", name="Copy").click()
    expect(row.get_by_role("button", name="Copied")).to_be_visible()
    assert page.evaluate("navigator.clipboard.readText()") == address
    page.get_by_role("radio", name="public:").check()
    expect(_handle_options(page)).to_have_text(["oleg", "tailarm", "games"])
    expect(select).to_have_value("oleg")


def test_with_no_handle_the_form_reserves_one_before_a_public_mint(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane) -> None:
    cp = fresh_control_plane
    cp.wiring = _wiring()

    page.goto(f"{frontend_url}/sharing")
    expect(_handles_box(page).get_by_text("You have no handles yet.")).to_be_visible(timeout=30_000)
    _pick_the_notebook(page)
    page.locator('input[name="share-label"]').fill("Reachability")
    page.get_by_role("radio", name="public:").check()

    # No handle yet: the form shows the field itself, and the mint waits.
    expect(page.locator('select[name="share-handle"]')).to_have_count(0)
    new_handle = page.get_by_label("Reserve a handle for your public shares")
    expect(new_handle).to_be_visible()
    expect(page.get_by_test_id("share-public-preview")).to_have_text(f"{SHARE_URL}/p/<your handle>/reachability")
    create = page.get_by_role("button", name="Create share")
    expect(create).to_be_disabled()
    expect(page.get_by_test_id("share-needs-handle")).to_have_text("Reserve a handle to create a public share.")

    new_handle.fill("oleg")
    page.get_by_test_id("share-form").get_by_role("button", name="Reserve", exact=True).click()
    # One handle: no select, the handle named, and room for another.
    one = page.get_by_test_id("share-one-handle")
    expect(one).to_contain_text("Handle oleg")
    expect(one.get_by_role("button", name="new handle…")).to_be_visible()
    expect(page.locator('select[name="share-handle"]')).to_have_count(0)
    expect(page.get_by_test_id("share-public-preview")).to_have_text(f"{SHARE_URL}/p/oleg/reachability")
    expect(create).to_be_enabled()
    expect(_handle_row(page, "oleg")).to_be_visible()
    expect(page.get_by_test_id("handles-count")).to_have_text("1 of 3 handles reserved")

    # "new handle…" opens the field again, and Cancel puts it away.
    one.get_by_role("button", name="new handle…").click()
    expect(create).to_be_disabled()
    page.get_by_test_id("share-form").get_by_role("button", name="Cancel").click()
    expect(page.get_by_label("New handle")).to_have_count(0)
    expect(create).to_be_enabled()

    create.click()
    expect(page.get_by_test_id("share-created-text")).to_have_text(f"{SHARE_URL}/p/oleg/reachability")
    assert [(body["handle"], body["slug"]) for body in cp.share_bodies] == [("oleg", "reachability")]


def test_a_held_address_is_refused_until_its_share_is_revoked(
        page: Page, frontend_url: str, fresh_control_plane: fake_cp.FakeControlPlane,
        expected_console_errors: list[str]) -> None:
    expected_console_errors.append("status of 422")
    cp = fresh_control_plane
    cp.wiring = _wiring()
    cp.public_handles = [fake_cp.handle_row("oleg", last_used_at="2026-10-30T10:00:00+00:00"),
                         fake_cp.handle_row("tailarm")]
    cp.shares = [
        _public_share("share-boards", label="boards", slug="reachability"),
        _public_share("share-old", label="old boards", slug="old", expires_at="2026-01-01T00:00:00+00:00"),
    ]

    page.goto(f"{frontend_url}/sharing")
    rows = _rows(page)
    expect(rows).to_have_count(2, timeout=30_000)
    held = rows.nth(0)
    expect(held.get_by_test_id("share-public-address")).to_have_text(f"{SHARE_URL}/p/oleg/reachability")
    # Expired, a public share still holds its address, so it can be revoked to free it.
    expect(rows.nth(1)).to_have_attribute("data-status", "expired")
    expect(rows.nth(1).get_by_role("button", name="Revoke", exact=True)).to_be_visible()

    _pick_the_notebook(page)
    page.locator('input[name="share-label"]').fill("Reachability")
    page.get_by_role("radio", name="public:").check()
    select = page.locator('select[name="share-handle"]')
    expect(select).to_have_value("oleg")
    expect(page.locator('input[name="share-slug"]')).to_have_value("reachability")
    create = page.get_by_role("button", name="Create share")
    create.click()

    held_sentence = "Your public share boards is already at /p/oleg/reachability; revoke it first"
    expect(page.get_by_test_id("share-mint-error")).to_have_text(held_sentence)
    expect(page.get_by_test_id("share-created")).to_have_count(0)
    expect(rows).to_have_count(2)

    # An address is held per handle: the same slug under tailarm is free.
    select.select_option("tailarm")
    create.click()
    expect(page.get_by_test_id("share-created-text")).to_have_text(f"{SHARE_URL}/p/tailarm/reachability")
    expect(page.get_by_test_id("share-mint-error")).to_have_count(0)
    expect(rows).to_have_count(3)

    # Revoked, the old share frees the address under oleg, and the same mint takes it.
    held = rows.filter(has_text="boards").filter(has=page.get_by_text("/p/oleg/reachability")).first
    held.get_by_role("button", name="Revoke", exact=True).click()
    expect(held).to_contain_text("Its address stops answering")
    held.get_by_role("button", name="Yes, revoke").click()
    expect(held).to_have_attribute("data-status", "revoked")
    select.select_option("oleg")
    create.click()
    expect(page.get_by_test_id("share-created-text")).to_have_text(f"{SHARE_URL}/p/oleg/reachability")
    expect(page.get_by_test_id("share-mint-error")).to_have_count(0)
    expect(rows).to_have_count(4)
    assert [(body["handle"], body["slug"]) for body in cp.share_bodies] == [
        ("oleg", "reachability"), ("tailarm", "reachability"), ("oleg", "reachability")]

"""The `ui_font_px` setting is the single source for the interface text scale. Concurrent updates must preserve neighboring settings."""
import pytest

import vocalis_server as vs
from vocalis.web import ui


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


def test_the_three_numbers_are_named_once():
    """The floor, ceiling and default are module constants rather than literals sprayed through
    the route, the GET and the front end. ⚠️ The floor must equal the CSS floor on the sensor row
    (`max(0.75rem,12px)`): if this one drops below that one, the smallest text stops responding
    to the slider and pins silently, which reads as the control being broken."""
    assert (ui.UI_FONT_PX_MIN, ui.UI_FONT_PX_DEFAULT, ui.UI_FONT_PX_MAX) == (12, 16, 24)


def test_the_default_is_the_browser_default():
    """16px is not a taste. It is the browser default, the size Google's mobile-friendly guidance
    asks for, and the threshold below which Lighthouse flags text as too small. The app shipped
    at 14 for a year and the workaround was a permanent 125% browser zoom."""
    assert ui.UI_FONT_PX_DEFAULT == 16


@pytest.mark.parametrize("sent,expected", [
    (16, 16),
    (12, 12), (24, 24),                 # the walls themselves are legal
    (11, 12), (0, 12), (-40, 12),       # under the floor
    (25, 24), (999, 24),                # over the ceiling
    ("18", 18), (18.7, 18),             # a range input POSTs a string; floats truncate
])
def test_out_of_range_is_clamped_not_refused(client, sent, expected):
    """🔴 CLAMPED, NOT REJECTED, and that is a deliberate call. A bad number here is a dragged
    slider or a stale client, never an attack — and refusing the PUT would discard the OTHER
    settings carried in the same body. Out-of-range becomes the nearest legal value, which is
    what the input's own min/max would have produced anyway."""
    r = client.put("/settings/app", json={"ui_font_px": sent})
    assert r.status_code == 200, r.data[:300]
    assert r.get_json()["ui_font_px"] == expected


@pytest.mark.parametrize("junk", ["large", None, "", [], {"a": 1}])
def test_junk_does_not_500_the_settings_route(client, junk):
    """`/settings/app` carries GPU selection and KoboldCpp config. An unparseable font size must
    not take the whole panel down with it — it falls back to the default."""
    r = client.put("/settings/app", json={"ui_font_px": junk})
    assert r.status_code == 200, r.data[:300]
    assert r.get_json()["ui_font_px"] == ui.UI_FONT_PX_DEFAULT


def test_the_get_clamps_a_hand_edited_file(client, monkeypatch):
    """🔴 THE PATH THE PUT CANNOT GUARD. `app_settings.yaml` is a file on disk that a user can
    open, so a value can reach the GET without ever passing the route's clamp. Without this the
    front end would receive `ui_font_px: 400` and apply it."""
    monkeypatch.setattr(ui.settings, "load_app_settings", lambda: {"ui_font_px": 400})
    r = client.get("/settings/app")
    assert r.status_code == 200
    assert r.get_json()["ui_font_px"] == ui.UI_FONT_PX_MAX


def test_the_setting_round_trips(client):
    client.put("/settings/app", json={"ui_font_px": 20})
    assert client.get("/settings/app").get_json()["ui_font_px"] == 20


def test_concurrent_puts_do_not_crash_or_lose_a_neighbor(tmp_path, monkeypatch):
    """Concurrent updates to the type scale must not crash or overwrite unrelated settings."""
    import threading

    import vocalis.runtime.settings as rt_settings
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    rt_settings.save_app_settings({"gpus": "all", "log_ansi_colors": True})

    vs.app.config["TESTING"] = True
    errors, statuses = [], []

    def hammer(i):
        try:
            with vs.app.test_client() as c:
                # Alternating keys: a lost update shows up as one of them reverting.
                body = {"ui_font_px": 12 + (i % 13)} if i % 2 else {"gpus": "cpu"}
                statuses.append(c.put("/settings/app", json=body).status_code)
        except Exception as exc:                                       # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=hammer, args=(i,)) for i in range(24)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert not errors, f"concurrent PUTs raised: {errors[:3]}"
    assert all(s == 200 for s in statuses), f"non-200s under concurrency: {sorted(set(statuses))}"
    # 🔴 The neighbor key survived. Without the lock the `gpus` writers and the `ui_font_px`
    # writers each stomp the other's snapshot, so one of the two ends up at its default.
    final = rt_settings.load_app_settings()
    assert final.get("gpus") == "cpu", final
    assert ui.UI_FONT_PX_MIN <= final.get("ui_font_px", 0) <= ui.UI_FONT_PX_MAX, final
    # ⚠️ And no temp file was orphaned in the install root — a per-writer temp name is only an
    # improvement if it is still cleaned up.
    leftovers = list(tmp_path.glob("*.part"))
    assert not leftovers, f"orphaned temp files: {leftovers}"


def test_the_admin_password_still_never_round_trips(client):
    """The GET is an explicit allowlist, and adding a key to it is exactly the edit that could
    turn it back into `jsonify(s)`. Pinned here because this milestone touched that dict."""
    body = client.get("/settings/app").get_json()
    assert "kobold_adminpassword" not in body
    assert isinstance(body.get("kobold_adminpassword_set"), bool)

"""Per-device capability and authorization for the retained rendering, Stems, and ACE work."""
import pytest
import torch

import vocalis_server as vs
import vocalis.runtime.gpu as gpu_mod
import vocalis.runtime.satellites as sat_mod
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import pool as pool_mod
from vocalis.runtime import subsystems as sub_mod


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def settings_file(monkeypatch, tmp_path):
    """Never write the repo's real app_settings.yaml."""
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    return tmp_path / "app_settings.yaml"


@pytest.fixture(autouse=True)
def two_local_cards(monkeypatch):
    """The fixture provides two local cards so the selector can verify per-card authorization and stable indexing."""
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "Test Card A"},
                                 {"index": 1, "name": "Test Card B"}])
    monkeypatch.setattr(gpu_mod, "gpu_stats",
                        lambda: [{"index": 0, "free_gb": 20.0}, {"index": 1, "free_gb": 8.0}])
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 2)


@pytest.fixture(autouse=True)
def never_probe_the_network(monkeypatch):
    monkeypatch.setattr(sat_mod, "health",
                        lambda name: {"reachable": False, "error": "not running",
                                      "devices": [], "ready": False})


def _save(settings_file, rows):
    rt_settings.save_app_settings({"devices": rows})


# ── The registry ─────────────────────────────────────────────────────────────

def test_absent_uses_means_everything_allowed():
    """🔴 THE WHOLE MIGRATION. Every app_settings.yaml written before 7.6 has rows of
    `{id, enabled}` and no `uses`; each must keep behaving exactly as it did. Read this the
    other way round — absent as "nothing allowed" — and shipping 7.6 would switch every
    subsystem off on every existing install at once."""
    for key in sub_mod.KEYS:
        assert sub_mod.authorized({"enabled": True}, key) is True


def test_a_malformed_uses_is_not_a_denial():
    """A hand-edited config with `uses: "yes"` must not read as "deny everything". Settings
    files are hand-edited on this box; the failure mode of a strict reader is a silently
    unusable machine."""
    for bad in ("yes", 3, [], None):
        assert sub_mod.authorized({"uses": bad}, sub_mod.RENDER) is True


def test_an_explicit_false_denies_only_that_subsystem():
    cfg = {"enabled": True, "uses": {"stems": False}}
    assert sub_mod.authorized(cfg, sub_mod.STEMS) is False
    assert sub_mod.authorized(cfg, sub_mod.RENDER) is True
    assert sub_mod.authorized(cfg, sub_mod.ACESTEP) is True


def test_a_satellite_is_capable_of_render_and_stems_and_nothing_else():
    """A satellite may advertise rendering capabilities without gaining authorization for every subsystem."""
    assert sub_mod.capable('test-satellite:cuda:0') == [sub_mod.RENDER, sub_mod.STEMS]
    for never in (sub_mod.VOICECREATE, sub_mod.ACESTEP):
        assert never not in sub_mod.capable('test-satellite:cuda:0')
    assert sub_mod.capable("cpu") == [sub_mod.RENDER]
    assert sub_mod.capable("cuda:0") == list(sub_mod.KEYS)


def test_clean_uses_drops_what_the_device_cannot_run():
    """Dropped, never stored as False. A stored `false` would record a decision the user never
    made about a capability that does not exist — and would silently deny it if that device ever
    gained the capability."""
    out = sub_mod.clean_uses({"render": True, "bogus": False}, 'test-satellite:cuda:0')
    assert out == {"render": True}
    assert sub_mod.clean_uses({"render": True, "stems": False}, 'test-satellite:cuda:0') == {
        "render": True, "stems": False}


def test_clean_uses_coerces_and_ignores_unknown_keys():
    out = sub_mod.clean_uses({"render": 1, "stems": 0, "nonsense": True}, "cuda:0")
    assert out == {"render": True, "stems": False}
    assert sub_mod.clean_uses("not a dict", "cuda:0") == {}


# ── The read path ────────────────────────────────────────────────────────────

def test_render_is_unchanged_when_nothing_is_narrowed(settings_file):
    """The subsystem argument only ever NARROWS. With no `uses` key anywhere, every accessor
    must answer exactly what it answered before 7.6."""
    _save(settings_file, [{"id": "cuda:0", "enabled": True},
                          {"id": "cuda:1", "enabled": True}])
    assert pool_mod.default_devices() == ["cuda:0", "cuda:1"]
    assert pool_mod.local_cuda_devices() == ["cuda:0", "cuda:1"]
    assert pool_mod.default_workers() == {"cuda:0": 1, "cuda:1": 1}


def test_narrowing_one_subsystem_leaves_the_others_alone(settings_file):
    _save(settings_file, [{"id": "cuda:0", "enabled": True, "uses": {"render": False}},
                          {"id": "cuda:1", "enabled": True}])
    assert pool_mod.local_cuda_devices(sub_mod.RENDER) == ["cuda:1"]
    assert pool_mod.local_cuda_devices(sub_mod.STEMS) == ["cuda:0", "cuda:1"]


def test_unticking_a_subsystem_everywhere_does_not_fall_back_to_every_card(settings_file):
    """🔴 THE REGRESSION THIS FEATURE IS MOST LIKELY TO GROW, and it is silent.

    `default_devices` falls back to `_local_gpus_string()` when its list comes out empty. The
    fallback must apply the same filter or a disabled subsystem would still receive every card.
    """
    _save(settings_file, [{"id": "cuda:0", "enabled": True, "uses": {"render": False}},
                          {"id": "cuda:1", "enabled": True, "uses": {"render": False}}])
    assert pool_mod.local_cuda_devices(sub_mod.RENDER) == []
    assert pool_mod._local_gpus_string(sub_mod.RENDER) == "cpu"
    # ...while the cards are still fully available to Stems.
    assert pool_mod.local_cuda_devices(sub_mod.STEMS) == ["cuda:0", "cuda:1"]


def test_workers_narrow_in_step_with_devices(settings_file):
    """They are called as a pair and the pool's cache key is built from both. A count for a
    device the pool was never given lands in `_signature` and is reported to the user by
    `worker_note` as in flight."""
    _save(settings_file, [{"id": "cuda:0", "enabled": True, "uses": {"render": False}},
                          {"id": "cuda:1", "enabled": True}])
    assert pool_mod.default_devices(sub_mod.RENDER) == ["cuda:1"]
    assert pool_mod.default_workers(sub_mod.RENDER) == {"cuda:1": 1}


def test_migration_does_not_drop_the_uses_map(settings_file):
    """🔴 `migrate_device_settings` is the ONLY path a saved row takes to reach the panel, so a
    key it drops is a setting the user silently loses on their next save: the GET reports an
    un-narrowed row, the browser sends five ticks back, and the narrowing is gone."""
    _save(settings_file, [{"id": "cuda:0", "enabled": True, "uses": {"stems": False}}])
    rows = pool_mod.migrate_device_settings(["cuda:0", "cuda:1"])
    by_id = {r["id"]: r for r in rows}
    assert by_id["cuda:0"]["uses"] == {"stems": False}
    assert "uses" not in by_id["cuda:1"], "an un-narrowed row must not grow an empty map"


# ── auto_device: the two empty lists that want opposite answers ───────────────

def test_auto_device_uses_the_cpu_when_the_box_has_no_card(settings_file, monkeypatch):
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    _save(settings_file, [{"id": "cpu", "enabled": True}])
    device, refusal = pool_mod.auto_device(sub_mod.STEMS)
    assert (device, refusal) == ("cpu", None)


def test_auto_device_refuses_when_cards_exist_but_none_is_allowed(settings_file):
    """When cards exist but none is authorized for the requested work, automatic selection must refuse instead of silently using the CPU."""
    _save(settings_file, [{"id": "cuda:0", "enabled": True, "uses": {"stems": False}},
                          {"id": "cuda:1", "enabled": True, "uses": {"stems": False}}])
    device, refusal = pool_mod.auto_device(sub_mod.STEMS)
    assert device is None
    assert "Voice Studio → Stems" in refusal
    assert "Settings" in refusal


def test_auto_device_picks_the_emptiest_allowed_card(settings_file):
    """cuda:0 has the most free VRAM in the fixture, but it is not allowed to split."""
    _save(settings_file, [{"id": "cuda:0", "enabled": True, "uses": {"stems": False}},
                          {"id": "cuda:1", "enabled": True}])
    assert pool_mod.auto_device(sub_mod.STEMS) == ("cuda:1", None)


def test_pick_device_requires_its_candidates():
    """The signature change IS the fix. Leaving a no-argument form working would have repaired
    two call sites and left the trap armed for the third, which is how it survived from 5.1."""
    with pytest.raises(TypeError):
        gpu_mod.pick_device()


# ── The route ────────────────────────────────────────────────────────────────

def test_get_reports_capability_and_the_registry(client, settings_file):
    body = client.get("/devices").get_json()
    keys = [s["key"] for s in body["subsystems"]]
    assert keys == list(sub_mod.KEYS)
    assert all(s["label"] for s in body["subsystems"]), "a checkbox with no label is unusable"
    row = next(d for d in body["devices"] if d["id"] == "cuda:0")
    assert row["capable"] == list(sub_mod.KEYS)
    assert row["uses"] == {}, "an un-narrowed row must arrive with nothing set"


def test_put_stores_and_get_returns_the_narrowing(client, settings_file):
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True, "uses": {"render": False, "stems": True}},
        {"id": "cuda:1", "enabled": True}]})
    saved = {d["id"]: d for d in rt_settings.load_app_settings()["devices"]}
    assert saved["cuda:0"]["uses"] == {"render": False, "stems": True}
    assert "uses" not in saved["cuda:1"]
    row = next(d for d in client.get("/devices").get_json()["devices"] if d["id"] == "cuda:0")
    assert row["uses"] == {"render": False, "stems": True}


def test_a_stale_tab_sending_no_uses_narrows_nothing(client, settings_file):
    """⚠️ A browser left open across the upgrade sends the old payload shape. Treating a missing
    map as "all false" would switch every subsystem off on that save."""
    client.put("/devices", json={"devices": [{"id": "cuda:0", "enabled": True}]})
    saved = rt_settings.load_app_settings()["devices"]
    assert "uses" not in saved[0]
    assert pool_mod.local_cuda_devices(sub_mod.RENDER) == ["cuda:0"]


def test_put_drops_a_key_the_device_cannot_run(client, settings_file):
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True, "uses": {"render": True, "bogus": True}}]})
    saved = rt_settings.load_app_settings()["devices"]
    assert saved[0]["uses"] == {"render": True}


# ── A Docker save keeps the settings Docker does not show ────────────────────
#
# October 10, 2026 (in-place switch design, item 6). A standalone install's app_settings.yaml
# carries `uses.training/swap/comfyui` per card; Docker offers none of them (comfyui only outside
# Docker mode), and the same file goes back to the standalone install on a switch-back.

class _DockerPaths:
    """`vocalis.runtime.paths` as the Devices route sees it in Docker mode. Patched into the
    route's module only, so the app's before_request gates (which would demand a bootstrapped
    vault) keep seeing the ordinary test environment."""
    def __init__(self, real):
        self._real = real

    def docker_encrypted_mode(self):
        return True

    def __getattr__(self, name):
        return getattr(self._real, name)


@pytest.fixture
def docker_devices_route(monkeypatch):
    import vocalis.web.ui as ui_mod
    monkeypatch.setattr(ui_mod, "paths", _DockerPaths(ui_mod.paths))


_STORED = [
    {"id": "cuda:0", "enabled": True,
     "uses": {"training": False, "swap": False, "comfyui": False, "render": True}},
    {"id": "cuda:1", "enabled": True},
]


def test_preserved_uses_is_the_unoffered_legacy_keys_exactly_as_stored():
    stored = {"training": False, "swap": False, "comfyui": False, "render": True, "stems": False,
              "bogus": True}
    assert sub_mod.preserved_uses(stored, docker_mode=True) == {
        "training": False, "swap": False, "comfyui": False}
    assert sub_mod.preserved_uses({"training": 0, "swap": "x"}, docker_mode=True) == {
        "training": 0, "swap": "x"}, "values are carried as stored, never coerced"
    assert sub_mod.preserved_uses(stored, docker_mode=False) == {}, "outside Docker nothing changes"
    for nothing in (None, "oops", [], {}):
        assert sub_mod.preserved_uses(nothing, docker_mode=True) == {}


def test_docker_save_keeps_training_swap_comfyui_and_changes_only_offered_keys(
        client, settings_file, docker_devices_route):
    _save(settings_file, _STORED)
    resp = client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True,
         # `comfyui` and `training` are not offered in Docker mode, so a payload naming them
         # (an old tab, a hand-built request) is dropped by clean_uses and the stored values win.
         "uses": {"render": False, "stems": True, "comfyui": True, "training": True}},
        {"id": "cuda:1", "enabled": True}]})
    assert resp.status_code == 200
    saved = {d["id"]: d for d in rt_settings.load_app_settings()["devices"]}
    assert saved["cuda:0"]["uses"] == {"render": False, "stems": True,
                                       "training": False, "swap": False, "comfyui": False}
    assert "uses" not in saved["cuda:1"], "a card with nothing stored gains nothing"


def test_docker_save_from_a_tab_sending_no_uses_still_keeps_the_unoffered_keys(
        client, settings_file, docker_devices_route):
    _save(settings_file, _STORED)
    client.put("/devices", json={"devices": [{"id": "cuda:0", "enabled": True},
                                             {"id": "cuda:1", "enabled": True}]})
    saved = {d["id"]: d for d in rt_settings.load_app_settings()["devices"]}
    assert saved["cuda:0"]["uses"] == {"training": False, "swap": False, "comfyui": False}
    assert pool_mod.local_cuda_devices(sub_mod.RENDER) == ["cuda:0", "cuda:1"], \
        "the kept keys narrow nothing that Docker offers"


def test_docker_save_keeps_the_keys_through_a_get_that_hides_them(
        client, settings_file, docker_devices_route):
    _save(settings_file, _STORED)
    row = next(d for d in client.get("/devices").get_json()["devices"] if d["id"] == "cuda:0")
    assert row["uses"] == {"render": True}, "Docker does not show the stored legacy keys"
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True, "uses": row["uses"]}, {"id": "cuda:1", "enabled": True}]})
    saved = {d["id"]: d for d in rt_settings.load_app_settings()["devices"]}
    assert saved["cuda:0"]["uses"] == {"render": True, "training": False, "swap": False,
                                       "comfyui": False}


def test_non_docker_save_is_unchanged(client, settings_file):
    """Outside Docker mode comfyui is offered, so the browser's value is what is stored, and
    training/swap (offered in no mode of this build) are dropped exactly as before."""
    _save(settings_file, _STORED)
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True, "uses": {"render": False, "comfyui": True}},
        {"id": "cuda:1", "enabled": True}]})
    saved = {d["id"]: d for d in rt_settings.load_app_settings()["devices"]}
    assert saved["cuda:0"]["uses"] == {"render": False, "comfyui": True}


# ── release audit 2026-10-11, item 3: Stems is offered on a satellite only if it says it can ──
#
# A satellite that reports `leadvocal_ready: false` cannot take the lead-vocal work, and
# `stemsplit` keeps the job on this machine. Offering the tick promised work that silently
# stayed local.

def _two_satellites(monkeypatch):
    monkeypatch.setattr(sat_mod, "snapshot", lambda remembered=None: {
        "satellites": [
            {"name": "ready-sat", "url": "https://ready.invalid:7880", "reachable": True,
             "error": "", "ready": True, "loading": False, "leadvocal_ready": True},
            {"name": "plain-sat", "url": "https://plain.invalid:7880", "reachable": True,
             "error": "", "ready": True, "loading": False, "leadvocal_ready": False}],
        "devices": [
            {"id": "ready-sat:cuda:0", "satellite": "ready-sat", "device": "cuda:0",
             "reachable": True},
            {"id": "plain-sat:cuda:0", "satellite": "plain-sat", "device": "cuda:0",
             "reachable": True}]})


def test_capable_without_a_health_answer_is_the_static_set_and_with_one_it_follows_it():
    assert sub_mod.capable("s:cuda:0") == [sub_mod.RENDER, sub_mod.STEMS], \
        "the SAVE path asks without health and must keep a stored stems choice"
    assert sub_mod.capable("s:cuda:0", leadvocal_ready=True) == [sub_mod.RENDER, sub_mod.STEMS]
    assert sub_mod.capable("s:cuda:0", leadvocal_ready=False) == [sub_mod.RENDER]
    assert sub_mod.capable("cuda:0", leadvocal_ready=False) == list(sub_mod.KEYS), \
        "a LOCAL card is never judged by a satellite's health"


def test_the_devices_route_offers_stems_only_to_a_satellite_that_reports_it(
        client, settings_file, monkeypatch):
    _two_satellites(monkeypatch)
    rows = {d["id"]: d for d in client.get("/devices").get_json()["devices"]}
    assert rows["ready-sat:cuda:0"]["capable"] == [sub_mod.RENDER, sub_mod.STEMS]
    assert rows["plain-sat:cuda:0"]["capable"] == [sub_mod.RENDER]
    assert rows["cuda:0"]["capable"] == list(sub_mod.KEYS)


def test_a_saved_stems_tick_on_a_satellite_without_it_is_ignored_without_error(
        client, settings_file, monkeypatch):
    """The stored `stems: true` stays in the file (the satellite may only be asleep or not yet
    updated) and neither the GET nor the work routing errors on it."""
    _two_satellites(monkeypatch)
    _save(settings_file, [{"id": "plain-sat:cuda:0", "enabled": True,
                           "uses": {"render": True, "stems": True}}])
    resp = client.get("/devices")
    assert resp.status_code == 200
    row = next(d for d in resp.get_json()["devices"] if d["id"] == "plain-sat:cuda:0")
    assert sub_mod.STEMS not in row["capable"]
    # The work side: the saved tick makes the card a candidate, the satellite's own health
    # rules it out, and the job stays local without raising.
    import stemsplit
    from conftest import REPO_ROOT
    monkeypatch.setattr("vocalis.runtime.pool.default_devices",
                        lambda sub: ["plain-sat:cuda:0"])
    monkeypatch.setattr("vocalis.runtime.satellites.health",
                        lambda name: {"reachable": True, "ready": True,
                                      "leadvocal_ready": False, "devices": []})
    assert stemsplit._satellite_lead_devices(REPO_ROOT / "scripts" / "leadvocal" / "detect.py") == []


def test_saving_while_stems_is_not_offered_keeps_the_stored_choice(
        client, settings_file, monkeypatch):
    """The page sends no `stems` key for a card that is not offered it, and the save must not
    erase a stored one (even a deliberate untick) on that account."""
    _two_satellites(monkeypatch)
    _save(settings_file, [{"id": "plain-sat:cuda:0", "enabled": True,
                           "uses": {"render": True, "stems": False}}])
    client.put("/devices", json={"devices": [
        {"id": "plain-sat:cuda:0", "enabled": True, "uses": {"render": True}}]})
    saved = {d["id"]: d for d in rt_settings.load_app_settings()["devices"]}
    assert saved["plain-sat:cuda:0"]["uses"] == {"render": True, "stems": False}

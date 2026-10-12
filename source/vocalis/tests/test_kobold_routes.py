"""4.7-m1 — the /kobold/* routes and ⚙ Settings ▸ KoboldCpp.

Runs on the dev box with no Kobold: the admin API is mocked at the HTTP boundary.

The settings tests here are deliberately HOSTILE. The write-only password contract is the
part that must not be got wrong — GET returns a bool, never the value — and the classic way
to "test" it is to assert an unset password isn't returned, which proves an empty dict is
empty. So every assertion below runs with a password SET.
"""
import json

import pytest

from conftest import make_test_docx

import kobold
import vocalis_server as vs
import vocalis.runtime.comfyui as rt_comfyui
import vocalis.runtime.gpu as gpu_mod
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import jobs as jobs_mod
from vocalis.web import kobold as web_kobold   # the /kobold/* routes + their helpers (5.1-P4.13)
from vocalis.web import books as web_books   # /book/start + run_job live here (5.1-P4.11)


def test_the_no_local_kobold_guard_lands_on_the_LIVE_binding():
    """🔴 The guard on conftest's `_no_local_kobold` guard. It patched a phantom for six phases.

    P4.13 moved `_kobold_cfg` to `vocalis/web/kobold.py`; conftest kept aiming at
    `vocalis_server._kobold_cfg` with `raising=False`, which CREATED the attribute instead of
    erroring, so the real config stayed live and "the suite must not read the host" quietly
    stopped holding. Nothing went red — that is the whole problem, and it is why this test
    exists.

    Assert the binding, not a value that could pass when no remote instance is configured. The
    fixture installs a lambda, so the live attribute
    not being the module's own function is the thing that proves the patch landed."""
    assert web_kobold._kobold_cfg.__name__ == "<lambda>", (
        "conftest's autouse _no_local_kobold did not patch the live _kobold_cfg binding — "
        "the suite is reading this host's real KoboldCpp config")
    assert web_kobold._kobold_cfg().local is False


CFG_A = "01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps"
CFG_B = "10-Alt-Nightfall-Aurora-72B-Q3.kcpps"
MODEL_A = "koboldcpp/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S"


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def settings_file(monkeypatch, tmp_path):
    """Never write the repo's real app_settings.yaml."""
    p = tmp_path / "app_settings.yaml"
    # 5.1-P3.3: the constant lives on vocalis.runtime.settings and vocalis_server does not
    # re-export it, so this must patch where load/save actually read it.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", p)
    return p


@pytest.fixture
def admindir(tmp_path):
    d = tmp_path / "kcpps"
    d.mkdir()
    (d / CFG_A).write_text(json.dumps({
        "model_param": "/ai-models/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S.gguf",
        "contextsize": 98304, "gpulayers": 999}), encoding="utf-8")
    (d / CFG_B).write_text(json.dumps({
        "model_param": "/ai-models/Nightfall-Aurora-72B-A3B-Chat-tuned.Q3_K_M.gguf",
        "contextsize": 98304, "gpulayers": 999}), encoding="utf-8")
    return d


class FakeKobold:
    def __init__(self, model="inactive", authed=True):
        self.model, self.authed = model, authed
        self.loaded = []

    def __call__(self, cfg, path, body=None, timeout=10.0):
        if path == "/api/extra/version":
            return {"result": "KoboldCpp", "version": "1.116.1",
                    "llm": self.model != "inactive", "admin": 2}
        if path == "/api/v1/model":
            return {"result": self.model if self.authed else kobold.PROTECTED_SENTINEL}
        if path == "/api/admin/list_options":
            return [] if not self.authed else [CFG_A, CFG_B, "initial_model", "unload_model"]
        if path == "/api/admin/reload_config":
            self.loaded.append(body["filename"])
            return {"success": True}
        raise AssertionError(path)


@pytest.fixture
def fake(monkeypatch):
    f = FakeKobold()
    monkeypatch.setattr(kobold, "_request", f)
    return f


@pytest.fixture
def wired(monkeypatch, admindir, fake, settings_file):
    """A local Kobold with a password set and configs on disk."""
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw", local=True, admindir=admindir))
    # Nothing here may depend on the host's GPUs.
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 51.2)
    return fake


# ── /kobold/info ────────────────────────────────────────────────────────────

def test_info_names_the_url_it_tried(client, monkeypatch, settings_file):
    """"no KoboldCpp at https://127.0.0.1:5001", never "no KoboldCpp on this host". The URL
    is the first thing to suspect and the tab must identify the attempted URL."""
    def boom(*a, **k):
        raise kobold.KoboldUnreachable("Connection refused")
    monkeypatch.setattr(kobold, "_request", boom)
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://somebox:5001", adminpassword="pw", local=False))
    j = client.get("/kobold/info").get_json()
    assert j["available"] is False
    assert j["url"] == "https://somebox:5001"
    assert j["host"] == "somebox"


def test_info_available_reports_version_and_admin(client, wired):
    j = client.get("/kobold/info").get_json()
    assert j["available"] is True and j["admin_on"] is True
    assert j["version"] == "1.116.1" and j["local"] is True


def test_info_never_returns_the_password(client, wired):
    assert "pw" not in json.dumps(client.get("/kobold/info").get_json())


# ── /kobold/configs ─────────────────────────────────────────────────────────

def test_configs_lists_and_labels(client, wired):
    j = client.get("/kobold/configs").get_json()
    names = [c["name"] for c in j["configs"]]
    assert names == [CFG_A, CFG_B]                 # by stem: 01- before 10-
    # The label is the filename, verbatim. No `starred` field: that rule is gone, not
    # disabled — Vocalis reads no meaning out of a config's name (see kobold.sort_key).
    assert "starred" not in j["configs"][0]
    assert j["configs"][0]["label"] == "01-★-Chat-Nightfall-Aurora-72B-Q6"


def test_configs_never_offers_the_pseudo_entries(client, wired):
    names = [c["name"] for c in client.get("/kobold/configs").get_json()["configs"]]
    assert "unload_model" not in names and "initial_model" not in names


def test_configs_carries_the_detail_line_when_local(client, wired):
    d = client.get("/kobold/configs").get_json()["configs"][0]["detail"]
    assert d["contextsize"] == 98304 and d["gpulayers"] == 999


def test_a_local_kobold_whose_config_folder_is_not_visible_here_says_so_neutrally(
        client, monkeypatch, tmp_path, fake, settings_file):
    """Release audit 2026-10-11, item 2. VOCALIS_KOBOLD_LOCAL=1 in the container says the server is
    on this machine, but the .kcpps folder is on the HOST. Every row used to read a red 'not found'."""
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="http://host.docker.internal:5001", adminpassword="pw", local=True,
        admindir=tmp_path / "not-mounted-here"))
    rows = client.get("/kobold/configs").get_json()["configs"]
    assert [r["detail"] for r in rows] == [{"unreadable_here": True}] * 2, rows
    assert all("error" not in r["detail"] for r in rows), "no per-config error to paint red"


def test_in_docker_a_host_model_path_is_never_called_missing(
        client, monkeypatch, admindir, fake, settings_file):
    """The folder can be mounted while the MODEL it names is a host path the container cannot
    open; 'model file missing' would be false there."""
    class _DockerPaths:
        """The route module's `paths` in Docker mode. Patched into that module only: flipping
        the real function would also close the app's before_request gates on this test client."""
        def __getattr__(self, name):
            return getattr(rt_paths, name)

        def docker_encrypted_mode(self):
            return True

    monkeypatch.setattr(web_kobold, "paths", _DockerPaths())
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="http://host.docker.internal:5001", adminpassword="pw", local=True, admindir=admindir))
    body = client.get("/kobold/configs").get_json()
    for r in body["configs"]:
        assert r["detail"]["contextsize"] == 98304
        assert "model_exists" not in r["detail"], r["detail"]
        assert "models_all_missing" not in r["detail"], r["detail"]


def test_outside_docker_a_missing_model_file_is_still_reported(client, wired):
    """The developer's non-Docker run keeps the real check."""
    d = client.get("/kobold/configs").get_json()["configs"][0]["detail"]
    assert d["model_exists"] is False


def test_empty_list_says_cant_authenticate_never_no_configs(client, wired):
    """[] is a 200 from Kobold and means wrong password / admin off / missing admindir /
    genuinely empty — indistinguishable. Rendering it as "no configs found" is the bug."""
    wired.authed = False
    r = client.get("/kobold/configs")
    assert r.status_code == 502
    assert r.get_json()["error"] == "kobold_auth"


def test_configs_default_prefers_last_config(client, monkeypatch, admindir, fake, settings_file):
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw", local=True, admindir=admindir,
        last_config=CFG_B))
    assert client.get("/kobold/configs").get_json()["default"] == CFG_B


def test_configs_default_prefers_a_loaded_model_over_last_config(
        client, monkeypatch, admindir, fake, settings_file):
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw", local=True, admindir=admindir,
        last_config=CFG_B))
    fake.model = MODEL_A                       # live truth: A is loaded, last_config says B
    assert client.get("/kobold/configs").get_json()["default"] == CFG_A


# ── locality: remote must not touch the local disk ──────────────────────────

def test_remote_does_not_report_the_local_admindirs_contents(
        client, monkeypatch, admindir, fake, settings_file):
    """THE test that matters. The bug isn't a crash — it's Vocalis confidently describing
    the WRONG BOX'S configs. Only a fixture with a populated local dir present can catch it;
    a test with no local dir passes for the wrong reason."""
    assert (admindir / CFG_A).exists()          # the local dir IS populated
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://elsewhere:5001", adminpassword="pw", local=False, admindir=admindir))
    j = client.get("/kobold/configs").get_json()
    assert j["local"] is False
    assert all("detail" not in c for c in j["configs"])      # degraded to the filename only


def test_remote_suppresses_vram_and_does_not_report_a_zero(
        client, monkeypatch, admindir, fake, settings_file):
    """A zero is the failure mode: _other_vram_gb() doesn't error remote, it returns a
    plausible ~0.0, so the tab would say "Kobold is holding 0 GB" about a box holding 51.
    Asserting "absent" and asserting "not 0" are different tests; the second is the one that
    fails when someone .get(..., 0)s it back in."""
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://elsewhere:5001", adminpassword="pw", local=False, admindir=admindir))
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 0.0)
    fake.model = MODEL_A
    j = client.get("/kobold/status").get_json()
    assert "other_vram_gb" not in j            # absent...
    assert j.get("other_vram_gb") != 0         # ...and not a zero
    assert j["vram_measurable"] is False
    assert j["host"] == "elsewhere"            # names the host instead


def test_local_reports_the_measured_other_share(client, wired):
    fake_model = MODEL_A
    wired.model = fake_model
    j = client.get("/kobold/status").get_json()
    assert j["other_vram_gb"] == 51.2          # measured, never a file-size estimate


# ── /kobold/status ──────────────────────────────────────────────────────────

def test_status_inactive(client, wired):
    j = client.get("/kobold/status").get_json()
    assert j["loaded"] is False and j["model"] is None


def test_status_names_the_config_it_can_derive(client, wired):
    wired.model = MODEL_A
    j = client.get("/kobold/status").get_json()
    assert j["config"] == CFG_A and j["how"] == "derived"


def test_status_says_outside_for_a_model_vocalis_didnt_load(client, wired):
    wired.model = 'koboldcpp/Sample-Model-Loaded-By-Hand'
    j = client.get("/kobold/status").get_json()
    assert j["config"] is None and j["how"] == "outside"


def test_status_unreachable_is_503_not_a_500(client, monkeypatch, settings_file):
    def boom(*a, **k):
        raise kobold.KoboldUnreachable("Connection refused")
    monkeypatch.setattr(kobold, "_request", boom)
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(url="https://x:5001"))
    assert client.get("/kobold/status").status_code == 503


# ── /kobold/load ────────────────────────────────────────────────────────────

def test_load_posts_to_kobold_and_reports_loading_not_loaded(client, wired, monkeypatch):
    monkeypatch.setattr(vs.threading, "Thread", lambda **k: type(
        "T", (), {"start": lambda s: None})())          # don't spawn the watcher
    j = client.post("/kobold/load", json={"filename": CFG_A}).get_json()
    assert j["loading"] is True and "loaded" not in j
    assert wired.loaded == [CFG_A]


def test_load_rejects_a_config_kobold_doesnt_offer(client, wired):
    r = client.post("/kobold/load", json={"filename": "made-up.kcpps"})
    assert r.status_code == 404
    assert r.get_json()["error"] == "unknown_config"


def test_load_without_a_kobold_is_503_with_a_clear_message(client, monkeypatch, settings_file):
    def boom(*a, **k):
        raise kobold.KoboldUnreachable("Connection refused")
    monkeypatch.setattr(kobold, "_request", boom)
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw"))
    r = client.post("/kobold/load", json={"filename": CFG_A})
    assert r.status_code == 503
    assert "https://127.0.0.1:5001" in r.get_json()["message"]


def test_load_without_a_password_points_at_settings(client, monkeypatch, admindir, fake,
                                                    settings_file):
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="", local=True, admindir=admindir))
    r = client.post("/kobold/load", json={"filename": CFG_A})
    assert r.status_code == 502
    assert "Settings" in r.get_json()["message"]


def test_load_requires_a_filename(client, wired):
    assert client.post("/kobold/load", json={}).status_code == 400


# ── /kobold/unload (m2) ─────────────────────────────────────────────────────

def test_unload_posts_the_pseudo_config_and_reports_a_measured_delta(client, wired, monkeypatch):
    """The freed figure is whole-card before/after — never a self-report, never a file-size
    estimate. m0 measured the real thing at 53.97 -> 0.11 GB."""
    wired.model = MODEL_A
    seq = iter([54.0, 0.1])
    monkeypatch.setattr(gpu_mod, "used_vram_gb_total", lambda: next(seq))
    monkeypatch.setattr(vs.time, "sleep", lambda s: None)

    def go(cfg, path, body=None, timeout=10.0):
        if path == "/api/admin/reload_config":
            wired.loaded.append(body["filename"])
            wired.model = "inactive"       # the supervisor gets there eventually
            return {"success": True}
        return wired(cfg, path, body, timeout)

    monkeypatch.setattr(kobold, "_request", go)
    j = client.post("/kobold/unload", json={}).get_json()
    assert wired.loaded == ["unload_model"]
    assert j["unloaded"] is True
    assert j["freed_gb"] == 53.9


def test_unload_waits_for_the_model_to_actually_go_before_measuring(client, wired, monkeypatch):
    """{"success": true} means QUEUED. m0 clocked the response at t=0.01s against an unload
    that completed at ~5.5s — measuring on the response measures the state from BEFORE the
    call, and would report 0 GB freed every time."""
    wired.model = MODEL_A
    calls = {"n": 0}

    def go(cfg, path, body=None, timeout=10.0):
        if path == "/api/admin/reload_config":
            return {"success": True}
        if path == "/api/v1/model":
            calls["n"] += 1
            # still loaded for the first few polls, exactly like the real supervisor
            return {"result": MODEL_A if calls["n"] < 3 else "inactive"}
        return wired(cfg, path, body, timeout)

    monkeypatch.setattr(kobold, "_request", go)
    # VRAM is only read AFTER the model reads as gone, so the delta is honest.
    reads = []
    def vram():
        reads.append(calls["n"])
        return 54.0 if not reads else 0.1
    monkeypatch.setattr(gpu_mod, "used_vram_gb_total", vram)
    monkeypatch.setattr(vs.time, "sleep", lambda s: None)
    j = client.post("/kobold/unload", json={}).get_json()
    assert j["unloaded"] is True
    assert reads[-1] >= 3            # the last VRAM read happened AFTER the model was gone


def test_unload_survives_the_listener_dropping_while_it_waits(client, wired, monkeypatch):
    """The socket belongs to the child being killed, so the port refuses connections mid-way
    through the very operation we're waiting on (measured: ~4.3 s of an unload)."""
    wired.model = MODEL_A
    calls = {"n": 0}

    def go(cfg, path, body=None, timeout=10.0):
        if path == "/api/admin/reload_config":
            return {"success": True}
        if path == "/api/v1/model":
            calls["n"] += 1
            if calls["n"] <= 2:
                raise kobold.KoboldUnreachable("Connection refused")
            return {"result": "inactive"}
        return wired(cfg, path, body, timeout)

    monkeypatch.setattr(kobold, "_request", go)
    monkeypatch.setattr(gpu_mod, "used_vram_gb_total", lambda: 1.0)
    monkeypatch.setattr(vs.time, "sleep", lambda s: None)
    assert client.post("/kobold/unload", json={}).get_json()["unloaded"] is True


def test_remote_unload_works_but_reports_no_freed_figure(
        client, monkeypatch, admindir, fake, settings_file):
    """Unload is the whole point cross-host — but those cards have no sensor here, and
    _other_vram_gb() would answer a plausible 0.0 rather than erroring."""
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://elsewhere:5001", adminpassword="pw", local=False, admindir=admindir))
    monkeypatch.setattr(gpu_mod, "used_vram_gb_total", lambda: 0.0)
    monkeypatch.setattr(vs.time, "sleep", lambda s: None)
    j = client.post("/kobold/unload", json={}).get_json()
    assert fake.loaded == ["unload_model"]      # the unload still happens
    assert j["freed_gb"] is None                # ...but no number is invented for it
    assert j["vram_measurable"] is False


def test_unload_without_a_kobold_is_503(client, monkeypatch, settings_file):
    def boom(*a, **k):
        raise kobold.KoboldUnreachable("Connection refused")
    monkeypatch.setattr(kobold, "_request", boom)
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw"))
    assert client.post("/kobold/unload", json={}).status_code == 503


# ── /kobold/test — the Settings connection check ────────────────────────────

def test_test_reports_ok_with_a_config_count(client, wired):
    j = client.post("/kobold/test", json={}).get_json()
    assert j["ok"] is True and j["configs"] == 2 and j["version"] == "1.116.1"


def test_test_tells_a_bad_password_apart_from_admin_being_off(client, wired):
    """These are the SAME response from list_options ([] + 200). The unauthenticated version
    probe is the only honest way to separate them, and saying the wrong one sends an operator to fix
    something that isn't broken."""
    wired.authed = False
    j = client.post("/kobold/test", json={}).get_json()
    assert j["ok"] is False and j["reason"] == "bad_password"


def test_test_reports_admin_off(client, wired, monkeypatch):
    def go(cfg, path, body=None, timeout=10.0):
        if path == "/api/extra/version":
            return {"result": "KoboldCpp", "version": "1.116.1", "admin": 0, "llm": False}
        return wired(cfg, path, body, timeout)
    monkeypatch.setattr(kobold, "_request", go)
    j = client.post("/kobold/test", json={}).get_json()
    assert j["ok"] is False and j["reason"] == "admin_off"


def test_test_reports_unreachable(client, monkeypatch, settings_file):
    def boom(*a, **k):
        raise kobold.KoboldUnreachable("Connection refused")
    monkeypatch.setattr(kobold, "_request", boom)
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://nope:5001", adminpassword="pw"))
    j = client.post("/kobold/test", json={}).get_json()
    assert j["ok"] is False and j["reason"] == "unreachable"
    assert j["url"] == "https://nope:5001"


def test_test_reports_a_missing_password(client, monkeypatch, admindir, fake, settings_file):
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="", local=True, admindir=admindir))
    j = client.post("/kobold/test", json={}).get_json()
    assert j["ok"] is False and j["reason"] == "no_password"


def test_test_always_answers_200_because_it_REPORTS_a_verdict(client, monkeypatch, settings_file):
    """A 4xx would make the fetch throw, and the panel would show a transport error about a
    diagnostic instead of the diagnostic."""
    def boom(*a, **k):
        raise kobold.KoboldUnreachable("nope")
    monkeypatch.setattr(kobold, "_request", boom)
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(url="https://x:5001"))
    assert client.post("/kobold/test", json={}).status_code == 200


def test_test_never_returns_the_password(client, wired):
    assert "pw" not in client.post("/kobold/test", json={}).get_data(as_text=True)


# ── last_config: written ONLY by a load that actually happened ──────────────

def test_a_successful_load_records_the_default_and_the_mapping(settings_file):
    web_kobold._kobold_record_load(CFG_A, MODEL_A)
    import yaml
    s = yaml.safe_load(settings_file.read_text(encoding="utf-8"))
    assert s["kobold"]["last_config"] == CFG_A
    assert s["kobold"]["model_map"][CFG_A] == MODEL_A


def test_a_failed_load_leaves_last_config_untouched(settings_file, monkeypatch, admindir, fake):
    """A failed load that poisons the default turns the 95% case into a footgun."""
    settings_file.write_text("kobold:\n  last_config: '%s'\n" % CFG_B, encoding="utf-8")
    cfg = kobold.KoboldConfig(url="https://127.0.0.1:5001", adminpassword="pw",
                              local=True, admindir=admindir)
    fake.model = "inactive"                       # the model never appears
    web_kobold._kobold_watch_load(cfg, CFG_A, timeout=0.1)
    import yaml
    s = yaml.safe_load(settings_file.read_text(encoding="utf-8"))
    assert s["kobold"]["last_config"] == CFG_B    # untouched


def test_the_watcher_survives_the_listener_dropping_mid_swap(settings_file, admindir,
                                                             monkeypatch):
    """A swap restarts the model process that holds the listening socket, so the port can refuse
    connections briefly during a normal load. A watcher must tolerate transient refusals."""
    calls = {"n": 0}

    def flaky(cfg, path, body=None, timeout=10.0):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise kobold.KoboldUnreachable("Connection refused")   # mid-swap
        return {"result": MODEL_A}

    monkeypatch.setattr(kobold, "_request", flaky)
    cfg = kobold.KoboldConfig(url="https://127.0.0.1:5001", adminpassword="pw",
                              local=True, admindir=admindir)
    web_kobold._kobold_watch_load(cfg, CFG_A, timeout=30, interval=0)
    import yaml
    s = yaml.safe_load(settings_file.read_text(encoding="utf-8"))
    assert s["kobold"]["last_config"] == CFG_A    # it waited the drop out


def test_the_star_round_trips_through_the_yaml_literally(settings_file):
    """The dump is allow_unicode=True, so ★ stays a ★ rather than escaping."""
    web_kobold._kobold_record_load(CFG_A, MODEL_A)
    assert "★" in settings_file.read_text(encoding="utf-8")


# ── ⚙ Settings ▸ KoboldCpp: the write-only contract (HOSTILE) ───────────────

def test_get_never_returns_the_password_asserted_with_one_SET(client, settings_file):
    """Testing this with the password UNSET is the classic pass-for-the-wrong-reason: it
    proves an empty dict is empty."""
    client.put("/settings/app", json={"kobold_adminpassword": "hunter2"})
    r = client.get("/settings/app")
    body = r.get_data(as_text=True)
    assert "hunter2" not in body                  # the VALUE appears nowhere
    assert "adminpassword" not in r.get_json()    # and no such key either
    assert r.get_json()["kobold_adminpassword_set"] is True


def test_the_set_flag_flips_with_the_put(client, settings_file):
    assert client.get("/settings/app").get_json()["kobold_adminpassword_set"] is False
    client.put("/settings/app", json={"kobold_adminpassword": "s3cret"})
    assert client.get("/settings/app").get_json()["kobold_adminpassword_set"] is True


def test_an_explicit_empty_string_clears_it(client, settings_file):
    client.put("/settings/app", json={"kobold_adminpassword": "s3cret"})
    client.put("/settings/app", json={"kobold_adminpassword": ""})
    assert client.get("/settings/app").get_json()["kobold_adminpassword_set"] is False


def test_omitted_is_NOT_the_same_as_empty(client, settings_file):
    """Collapsing these two is how editing the URL silently wipes the password."""
    client.put("/settings/app", json={"kobold_adminpassword": "s3cret"})
    client.put("/settings/app", json={"kobold_url": "https://kobold.example.invalid:5001"})     # password omitted
    j = client.get("/settings/app").get_json()
    assert j["kobold_adminpassword_set"] is True      # INTACT
    assert j["kobold_url"] == "https://kobold.example.invalid:5001"


def test_the_url_round_trips(client, settings_file):
    client.put("/settings/app", json={"kobold_url": "https://kobold.example.invalid:5001/"})
    assert client.get("/settings/app").get_json()["kobold_url"] == "https://kobold.example.invalid:5001"


def test_a_hand_edited_scalar_does_not_500_the_put(client, settings_file):
    """`kobold: "oops"` — a hand-edited scalar rather than a dict. The assignment would raise
    without the setdefault guard."""
    settings_file.write_text("kobold: oops\n", encoding="utf-8")
    r = client.put("/settings/app", json={"kobold_url": "https://kobold.example.invalid:5001"})
    assert r.status_code == 200
    assert r.get_json()["kobold_url"] == "https://kobold.example.invalid:5001"


def test_the_get_stays_an_explicit_allowlist(client, settings_file):
    """It is safe STRUCTURALLY, not incidentally. The day someone simplifies it to
    `return jsonify(s)`, the admin password ships to the browser."""
    settings_file.write_text(
        "workers_per_card: 2\nsome_secret_junk: leakme\n"
        "kobold:\n  adminpassword: hunter2\n  last_config: x\n"
        # 9.5: a SECOND credential in a SECOND section, planted the same way. The leak this
        # guards is not "the kobold password" — it is any secret reachable from the settings
        # dict, and one engine's key proves nothing about the other's.
        "llama:\n  api_key: sk-leakme-too\n  url: http://127.0.0.1:8080\n", encoding="utf-8")
    body = client.get("/settings/app").get_data(as_text=True)
    assert "leakme" not in body
    assert "hunter2" not in body
    assert "sk-leakme-too" not in body
    # ⚠️ EXACT SET, and updating it is the POINT rather than a chore: a new key here has to be a
    # deliberate edit to this line, which is what stops the dict drifting back toward
    # `jsonify(s)` one convenience at a time. `ui_font_px` joined in 7.2-m3 (the text-size
    # setting) and is a clamped int — see tests/test_ui_font_setting.py for its own guards.
    # 9.5-m1 added the three `llama_*` keys. `llama_api_key_set` is a BOOL, exactly like
    # `kobold_adminpassword_set`, and for exactly the same reason: the value must never
    # round-trip into the DOM.
    # 9.5-m3 added `devices_warn_llm_loaded` — the tick-a-card warning. A plain bool with no
    # secret anywhere near it, declared here because that is the price of the allowlist working.
    # 9.5.9 REMOVED `kobold_warn_gpus` and `llama_warn_gpus`: one condition — cards ticked while
    # an LLM holds this box — reached from either end, so it gets ONE switch, and both engines'
    # `/…/status` read `devices_warn_llm_loaded` for their `warn_gpus` now. Their absence is
    # asserted separately below; a key served but governing nothing is a control that lies.
    assert set(client.get("/settings/app").get_json()) == {
        "gpus", "log_ansi_colors", "log_path", "log_path_in_data_folder", "ui_font_px",
        "devices_warn_llm_loaded",
        "kobold_url", "kobold_adminpassword_set",
        "llama_url", "llama_api_key_set"}
    # 🔴 THE FLAG IS FALSE FOR THE PLANTED KEY, AND THAT IS CORRECT — it is not a bug and it is
    # the whole point of the split. `llama_api_key_set` reads the ROUTED (encrypted) settings
    # file through `llama_secrets()`, never `app_settings.yaml`. A key sitting in app_settings —
    # hand-edited, or left by an older build — is a key in the wrong file: it must not leak
    # (asserted above) and it must not be honored either, or the plaintext copy would silently
    # become the live credential.
    assert client.get("/settings/app").get_json()["llama_api_key_set"] is False
    # ...and now the NON-VACUOUS half: store one the way the UI does, and check the flag flips
    # while the value still never round-trips. Testing a write-only field with nothing stored
    # proves an empty dict is empty, which is the vacuity 4.7 warned about for Kobold's flag.
    client.put("/settings/app", json={"llama_api_key": "sk-real-one"})
    j = client.get("/settings/app")
    assert j.get_json()["llama_api_key_set"] is True
    assert "sk-real-one" not in j.get_data(as_text=True)
    # Empty string CLEARS (distinct from omitted, which leaves it alone) — the same contract the
    # Kobold password has, and the reason editing a URL cannot wipe a credential by accident.
    client.put("/settings/app", json={"llama_api_key": ""})
    assert client.get("/settings/app").get_json()["llama_api_key_set"] is False
    # 5.4.1 dropped `workers_per_card` from the allowlist with the setting itself. Asserted as
    # absent, not just removed from the set above: an allowlist that quietly grew the key back
    # would start echoing a value nothing honors.
    assert "workers_per_card" not in client.get("/settings/app").get_json()


def test_the_existing_settings_still_work_alongside_kobold(client, settings_file):
    """4.7 EXTENDS the allowlist; it must not disturb it."""
    assert client.put("/settings/app", json={"gpus": "0,1"}).get_json()["gpus"] == "0,1"
    client.put("/settings/app", json={"kobold_url": "https://kobold.example.invalid:5001"})
    j = client.get("/settings/app").get_json()
    assert j["gpus"] == "0,1" and j["kobold_url"] == "https://kobold.example.invalid:5001"


def test_a_stale_tab_putting_the_removed_worker_key_is_not_a_400(client, settings_file):
    """🔴 IGNORED, never rejected. A browser left open across the 5.4.1 upgrade still has the
    old field in its saved payload, and refusing the whole PUT over a key we stopped honoring
    would break every other setting on that page until the user reloaded."""
    r = client.put("/settings/app", json={"workers_per_card": 6, "gpus": "cpu"})
    assert r.status_code == 200
    assert r.get_json()["gpus"] == "cpu"
    assert "workers_per_card" not in r.get_json()


def test_a_url_edit_does_not_disturb_last_config(client, settings_file):
    web_kobold._kobold_record_load(CFG_A, MODEL_A)
    client.put("/settings/app", json={"kobold_url": "https://kobold.example.invalid:5001"})
    import yaml
    s = yaml.safe_load(settings_file.read_text(encoding="utf-8"))
    assert s["kobold"]["last_config"] == CFG_A


# ── the ticked-cards warning ─────────────────────────────────────────────────
# The route reports enabled cards and the warning setting; the browser decides whether to show a
# dialog. These tests cover the route values consumed by that dialog.


@pytest.fixture
def two_local_cards(monkeypatch):
    """The suite must not read host GPU state. This fixture supplies two cards so the assertions
    remain independent of the developer machine."""
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "Test Card A"},
                                 {"index": 1, "name": "Test Card B"}])


def test_status_names_the_cards_vocalis_still_has_ticked(client, wired, two_local_cards):
    """🔴 IT NAMES THEM. "some cards are in use" is a sentence you can only act on by going and
    looking; the id AND the label are what make the dialog point at a row to untick."""
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True},
                                               {"id": "cuda:1", "enabled": False}]})
    j = client.get("/kobold/status").get_json()
    assert j["vocalis_gpus"] == [{"id": "cuda:0", "label": "Test Card A"}]
    assert j["warn_gpus"] is True


def test_a_card_narrowed_to_one_subsystem_is_still_a_ticked_card(client, wired, two_local_cards):
    """🔴 THE TOP-LEVEL TICK, NOT `local_cuda_devices()`. That one filters by subsystem, and
    reusing it here would report a card narrowed to speech alone as free — while Vocalis goes
    on putting a Chatterbox replica on it. The question is about the hardware."""
    rt_settings.save_app_settings({"devices": [
        {"id": "cuda:0", "enabled": True, "uses": {"render": True, "enhance": False,
                                                   "voxcpm": False, "swap": False,
                                                   "training": False}},
        {"id": "cuda:1", "enabled": False}]})
    j = client.get("/kobold/status").get_json()
    assert [c["id"] for c in j["vocalis_gpus"]] == ["cuda:0"]


def test_a_config_that_predates_the_device_rows_still_reports_its_cards(
        client, wired, two_local_cards):
    """🔴 THROUGH `migrate_device_settings`. An app_settings.yaml written before the per-device
    rows carries `gpus: "all"` and no `devices:` list; read raw that is an empty dict, and the
    warning would be silently off on exactly the installs that never opened the panel."""
    rt_settings.save_app_settings({"gpus": "all"})
    j = client.get("/kobold/status").get_json()
    assert [c["id"] for c in j["vocalis_gpus"]] == ["cuda:0", "cuda:1"]
    # And migration stays READ-ONLY here, the same as /devices' own GET.
    assert "devices" not in rt_settings.load_app_settings(), "the status poll wrote settings"


def test_unticking_them_all_is_what_makes_the_warning_go_quiet(client, wired, two_local_cards):
    """The whole point of the setting: untick the cards, and Load stops asking."""
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": False},
                                               {"id": "cuda:1", "enabled": False}]})
    assert client.get("/kobold/status").get_json()["vocalis_gpus"] == []


def test_a_remote_kobold_says_nothing_about_this_boxs_cards(
        client, monkeypatch, admindir, fake, settings_file, two_local_cards):
    """🔴 THE SAME GATE AS THE RENDER CONFLICT, AND FOR THE SAME REASON (§2b/§5). A remote
    KoboldCpp loads onto hardware these cards are not part of, so "cuda:0 is ticked" is true and
    irrelevant — and a warning that fires about someone else's cards is the fabricated-GB figure
    wearing the other hat. Absent, not an empty list: an empty list would read as "checked, and
    nothing is ticked"."""
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True}]})
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://elsewhere:5001", adminpassword="pw", local=False, admindir=admindir))
    j = client.get("/kobold/status").get_json()
    assert "vocalis_gpus" not in j
    assert "warn_gpus" not in j


def test_the_setting_reaches_the_tab_on_the_status_poll(client, wired, two_local_cards):
    """It rides the poll the tab already makes rather than a second fetch on the click that
    matters most. Turning it off must reach the tab as `false` WITH the cards still listed —
    the facts and the policy are separate, and the browser applies the policy."""
    # ⚠️ BOTH ROWS, and the second one is not padding: `migrate_device_settings` FILLS GAPS from
    # the legacy `gpus` key, so a card left out of `devices:` comes back enabled rather than off.
    # That is /devices' own behavior and this list has to match it — an omission here would
    # report a card as free that the panel one tab over shows ticked.
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True},
                                               {"id": "cuda:1", "enabled": False}],
                                   "devices_warn_llm_loaded": False})
    j = client.get("/kobold/status").get_json()
    assert j["warn_gpus"] is False
    assert [c["id"] for c in j["vocalis_gpus"]] == ["cuda:0"]


def test_the_two_routes_agree_about_the_default(client, wired, two_local_cards):
    """🔴 ONE DEFAULT, TWO READERS. `/settings/app` paints the checkbox and `/kobold/status`
    drives the dialog; if they disagreed, the box would sit unticked over a server that is
    warning anyway (or the reverse), which is a control reporting the opposite of the app."""
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True}]})
    assert client.get("/settings/app").get_json()["devices_warn_llm_loaded"] is True
    assert client.get("/kobold/status").get_json()["warn_gpus"] is True


def test_the_ONE_checkbox_drives_this_engines_load_warning(client, wired, two_local_cards,
                                                           settings_file):
    """The application checkbox controls the route value read by KoboldCpp status. Exercise the setting through both routes to catch mismatched storage keys."""
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True}]})
    client.put("/settings/app", json={"devices_warn_llm_loaded": False})
    assert client.get("/kobold/status").get_json()["warn_gpus"] is False
    client.put("/settings/app", json={"devices_warn_llm_loaded": True})
    assert client.get("/kobold/status").get_json()["warn_gpus"] is True


def test_a_stale_per_engine_key_is_INERT(client, wired, two_local_cards):
    """🔴 A PRE-9.5.9 `kobold: {warn_gpus: false}` MUST NOT SILENCE ANYTHING. It is not migrated
    and it is not read; the effect of the change is a warning coming BACK, never one silently
    staying off. This is the assertion that fails if someone "helpfully" restores the old read as
    a fallback — which would put the second switch back without putting the checkbox back."""
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True}],
                                   "kobold": {"warn_gpus": False}})
    assert client.get("/kobold/status").get_json()["warn_gpus"] is True


def test_the_retired_key_is_neither_served_nor_accepted(client, wired, two_local_cards,
                                                        settings_file):
    """A PUT naming the old key must not resurrect it — not in the GET, and not as a switch. A
    route that quietly kept honoring it would leave a way to silence the warning that no control
    on screen can turn back on."""
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True}]})
    r = client.put("/settings/app", json={"kobold_warn_gpus": False, "llama_warn_gpus": False})
    assert r.status_code == 200
    assert "kobold_warn_gpus" not in r.get_json()
    assert "llama_warn_gpus" not in r.get_json()
    assert client.get("/kobold/status").get_json()["warn_gpus"] is True


def test_turning_the_warning_off_does_not_disturb_the_password_or_the_url(client, settings_file):
    """It is a top-level key now rather than one inside the `kobold:` section, but the claim is
    unchanged and still worth its test: omitted is not empty, here as much as anywhere else in
    this route. A save of one setting must never wipe a credential."""
    client.put("/settings/app", json={"kobold_url": "https://kobold.example.invalid:5001",
                                      "kobold_adminpassword": "s3cret"})
    client.put("/settings/app", json={"devices_warn_llm_loaded": False})
    j = client.get("/settings/app").get_json()
    assert j["kobold_adminpassword_set"] is True
    assert j["kobold_url"] == "https://kobold.example.invalid:5001"
    assert j["devices_warn_llm_loaded"] is False


def test_a_hand_edited_scalar_does_not_500_the_url_put(client, settings_file):
    """`kobold: "oops"` — the guard that creates the dict still has to run, or the URL assignment
    raises on a hand-edited file. (It used to be reached through the warning key too; that key
    left the section at 9.5.9, so the URL is what exercises the guard now.)"""
    settings_file.write_text("kobold: oops\n", encoding="utf-8")
    r = client.put("/settings/app", json={"kobold_url": "https://kobold.example.invalid:5001"})
    assert r.status_code == 200
    assert r.get_json()["kobold_url"] == "https://kobold.example.invalid:5001"
    # ...and the warning key is top-level, so a scalar `kobold:` cannot reach it at all.
    assert client.put("/settings/app",
                      json={"devices_warn_llm_loaded": False}).status_code == 200


def test_a_cpu_only_box_has_nothing_to_warn_about(client, wired, monkeypatch):
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    assert client.get("/kobold/status").get_json()["vocalis_gpus"] == []


# ── m3: the pre-render offer ────────────────────────────────────────────────
# A book render takes EVERY card, so a co-resident 80B doesn't block it — it makes it bad.
# Vocalis asks, at the moment it matters, and never acts alone.

@pytest.fixture
def wired_remote(monkeypatch, fake, settings_file):
    """A REMOTE Kobold, holding a model, on a box whose cards read hot.

    The VRAM figure is deliberately non-zero: if anything ever gates the offer on the number
    instead of on `local`, these tests must fail rather than pass by luck.
    """
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://somebox:5001", adminpassword="pw", local=False))
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 51.2)
    fake.model = MODEL_A
    return fake


def test_no_offer_when_kobold_is_remote(wired_remote):
    """Unloading a remote Kobold frees nothing for this render — the offer would interrupt a
    live SillyTavern chat in exchange for nothing, and justify it
    with a GB figure about hardware this render never touches. Gate on `local`, never on
    `loaded`: here the model IS loaded and the cards DO read 51.2 GB, and the answer is still
    no offer."""
    assert web_kobold._kobold_render_conflict() is None


def test_offer_when_local_and_loaded(wired):
    wired.model = MODEL_A
    c = web_kobold._kobold_render_conflict()
    assert c["error"] == "kobold_loaded"
    assert c["model"] == MODEL_A
    assert c["other_vram_gb"] == 51.2
    assert c["config"] == CFG_A                 # derived from the kcpps's model_param
    assert c["config_label"] == "01-★-Chat-Nightfall-Aurora-72B-Q6"


def test_no_offer_when_nothing_is_loaded(wired):
    assert wired.model == "inactive"
    assert web_kobold._kobold_render_conflict() is None


def test_a_dead_kobold_never_blocks_a_render(client, monkeypatch, settings_file):
    """The offer is an OFFER, not a dependency. Kobold being down, misconfigured or
    unreachable must leave /book/start behaving exactly as it did before 4.7."""
    def boom(*a, **k):
        raise kobold.KoboldUnreachable("Connection refused")
    monkeypatch.setattr(kobold, "_request", boom)
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw", local=True))
    assert web_kobold._kobold_render_conflict() is None


def test_a_wrong_password_never_blocks_a_render(wired):
    """Kobold answers a wrong password with its protected-model sentinel and a 200. That must
    read as 'can't tell', which means proceed — never as a model worth offering to unload."""
    wired.authed = False
    wired.model = MODEL_A
    assert web_kobold._kobold_render_conflict() is None


def test_a_broken_config_list_still_makes_the_offer(wired, monkeypatch):
    """Naming the config is a nicety ON TOP of the offer. A list_options that fails must not
    swallow a conflict already known to be real — the modal falls back to the raw model
    string Kobold reported."""
    def boom(cfg):
        raise kobold.KoboldUnreachable("gone")
    monkeypatch.setattr(kobold, "list_configs", boom)
    wired.model = MODEL_A
    c = web_kobold._kobold_render_conflict()
    assert c["error"] == "kobold_loaded" and c["model"] == MODEL_A
    assert c["config"] is None and c["config_label"] is None


def test_the_offer_carries_a_sentence_not_just_a_code(wired):
    """`kobold_loaded` is for the client to branch on. An unhandled 409 renders `message`,
    and an earlier response exposed raw error codes to the client."""
    wired.model = MODEL_A
    c = web_kobold._kobold_render_conflict()
    assert "kobold_loaded" not in c["message"]
    assert "51.2" in c["message"] and len(c["message"].split()) > 6


def test_the_offer_never_estimates_vram(wired, monkeypatch):
    """Where the cards can't be read, there is no figure — and the sentence must not grow a
    zero. _other_vram_gb() answers a plausible 0.0 rather than erroring, so a number is never
    evidence of anything on its own."""
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 0.0)
    wired.model = MODEL_A
    c = web_kobold._kobold_render_conflict()
    assert c["error"] == "kobold_loaded"         # still a real conflict: `loaded` said so
    assert "0 GB" not in c["message"] and "~0" not in c["message"]


# ── m3 through the route ────────────────────────────────────────────────────

@pytest.fixture
def bookable(monkeypatch, tmp_path):
    """/book/start with the job thread stubbed out — these tests are about the GATE, and a
    real run_job would want a pool."""
    out = tmp_path / "output"; out.mkdir()
    voices = tmp_path / "voice_samples"; voices.mkdir()
    (voices / "V.wav").write_bytes(b"RIFF0000WAVE")
    monkeypatch.setattr(web_books, "OUTPUT_DIR", out)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", voices)
    monkeypatch.setattr(web_books, "run_job", lambda job: None)
    docx = tmp_path / "book.docx"
    make_test_docx(docx, num_chapters=1)
    yield {"path": str(docx), "voice": "V.wav"}
    jobs_mod.JOBS.clear()


def test_book_start_409s_when_kobold_holds_the_cards(client, wired, bookable):
    wired.model = MODEL_A
    r = client.post("/book/start", json=bookable)
    assert r.status_code == 409
    j = r.get_json()
    assert j["error"] == "kobold_loaded" and j["other_vram_gb"] == 51.2
    assert not jobs_mod.JOBS                            # and NOTHING started


def test_book_start_force_renders_anyway(client, wired, bookable):
    """A 409 response includes a machine-readable reason; resending with `force` renders without unloading the connected model."""
    wired.model = MODEL_A
    r = client.post("/book/start", json={**bookable, "force": True})
    assert r.status_code == 200 and r.get_json()["job_id"]
    assert wired.loaded == []                     # and force did NOT unload anything itself


def test_book_start_is_silent_when_kobold_is_remote(client, wired_remote, bookable):
    """Remote → the render proceeds exactly as if Kobold weren't there, because as far as
    these GPUs are concerned, it isn't."""
    r = client.post("/book/start", json=bookable)
    assert r.status_code == 200 and r.get_json()["job_id"]


def test_book_start_never_unloads_on_its_own(client, wired, bookable):
    """Explicitly rejected in design: auto-unload on GPU claim. It would kill a model out
    from under a live chat with no warning. The 409 is the whole feature."""
    wired.model = MODEL_A
    client.post("/book/start", json=bookable)
    assert wired.loaded == []

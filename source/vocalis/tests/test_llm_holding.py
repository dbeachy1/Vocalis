"""`/llm/holding` warns when enabling a device would contend with a loaded LLM model.

The reciprocal load-time warning already covers the opposite transition. This route test keeps
the check at the device-enable decision point, where it can prevent the contended state without
duplicating the same warning in render or enhancement paths."""
import pytest

import kobold
import llama
import vocalis_server as vs
import vocalis.runtime.gpu as gpu_mod
import vocalis.runtime.settings as rt_settings
from vocalis.web import kobold as web_kobold
from vocalis.web import llama as web_llama


ROUTER_PROPS = {"role": "router", "max_instances": 4, "models_autoload": True}


def _models(*rows):
    return {"object": "list",
            "data": [{"id": i, "source": "preset", "status": {"value": v}} for i, v in rows]}


class FakeRouter:
    def __init__(self, models, fail=None):
        self.models = models
        self.fail = fail

    def __call__(self, cfg, path, body=None, timeout=10.0, method=None):
        if path == "/health":
            return {"status": "ok"}
        if self.fail is not None:
            raise self.fail
        if path == "/props":
            return dict(ROUTER_PROPS)
        if path.startswith("/models"):
            return self.models
        raise AssertionError(f"unscripted {path!r}")


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def no_cards(monkeypatch):
    """This test must not read host GPU inventory; the fixture supplies its own registry."""
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 47.5)


def wire_llama(monkeypatch, fake, *, local=True, url="http://127.0.0.1:8080"):
    monkeypatch.setattr(llama, "_request", fake)
    monkeypatch.setattr(web_llama, "_llama_cfg",
                        lambda: llama.LlamaConfig(url=url, api_key="", local=local))
    return fake


HELD = _models(("big-70b", "loaded"), ("small-8b", "unloaded"))
SLEEPING = _models(("big-70b", "sleeping"), ("small-8b", "unloaded"))
TWO_HELD = _models(("big-70b", "loaded"), ("small-8b", "loaded"))


# ── what is holding the cards ───────────────────────────────────────────────

def test_a_loaded_llama_model_is_reported_with_its_engine_and_name(client, monkeypatch):
    """🔴 IT NAMES WHAT IS HOLDING. "An LLM is loaded" is a sentence you can only act on by going
    and looking; `llama.cpp - big-70b` is the thing to unload."""
    wire_llama(monkeypatch, FakeRouter(HELD))
    j = client.get("/llm/holding").get_json()
    assert j["holding"] == [{"engine": "llama.cpp", "model": "big-70b"}]
    assert j["other_vram_gb"] == 47.5


def test_a_SLEEPING_model_is_NOT_holding(client, monkeypatch):
    """🔴 THE LANDMINE. `is_running()` on the router is `loaded | loading | sleeping`, and a
    `sleeping` model has released its weights AND its KV cache while staying routable. Warning
    about one would cost a dismissal and describe nothing — and it would read completely
    reasonable, because the model IS "running"."""
    wire_llama(monkeypatch, FakeRouter(SLEEPING))
    assert client.get("/llm/holding").get_json()["holding"] == []


def test_every_resident_model_is_named_not_just_the_first(client, monkeypatch):
    """`--models-max` defaults to 4. Report every resident model so the operator can account for all hardware contention."""
    wire_llama(monkeypatch, FakeRouter(TWO_HELD))
    j = client.get("/llm/holding").get_json()
    assert [h["model"] for h in j["holding"]] == ["big-70b", "small-8b"]


def test_a_REMOTE_engine_is_never_reported(client, monkeypatch):
    """A model on another box uses hardware this process cannot observe. Do not warn about remote state; `gpu.other_vram_gb()` can return a plausible zero when cards are unavailable."""
    wire_llama(monkeypatch, FakeRouter(HELD), local=False)
    assert client.get("/llm/holding").get_json()["holding"] == []


def test_an_unconfigured_engine_is_never_reported(client, monkeypatch):
    """No URL is the DEFAULT state on any box, and it must cost nothing."""
    wire_llama(monkeypatch, FakeRouter(HELD), url="")
    assert client.get("/llm/holding").get_json()["holding"] == []


def test_no_vram_figure_when_nothing_is_holding(client, monkeypatch):
    """🔴 ABSENT, NOT 0.0. `other_vram_gb()` answers a plausible zero rather than erroring when it
    cannot see the cards, so a figure reported unconditionally would make "0.0 GB" mean both
    "nothing is loaded" and "cannot tell". A blank invites a question; a zero answers it falsely."""
    wire_llama(monkeypatch, FakeRouter(_models(("small-8b", "unloaded"))))
    assert "other_vram_gb" not in client.get("/llm/holding").get_json()


def test_an_engine_that_cannot_be_ASKED_never_fails_the_route(client, monkeypatch):
    """📌 The route decorates an action; it must never be able to prevent one. Down, wrong key,
    TLS, a hand-edited settings file — every one answers "nothing is holding" and the tick
    proceeds exactly as it did before the feature existed."""
    wire_llama(monkeypatch, FakeRouter(HELD, fail=llama.LlamaUnreachable("connection refused")))
    r = client.get("/llm/holding")
    assert r.status_code == 200 and r.get_json()["holding"] == []


def test_one_engine_being_down_does_not_hide_the_other(client, monkeypatch):
    """🔴 THE PROBES ARE ISOLATED. A single try/except around the loop would turn a KoboldCpp
    timeout into "llama.cpp is holding nothing" — a WRONG answer rather than a missing one, and
    the warning would silently stop existing on the box where it mattered most."""
    wire_llama(monkeypatch, FakeRouter(HELD))

    def kobold_boom():
        raise kobold.KoboldUnreachable("connection refused")

    import vocalis.web.llm as web_llm
    # Put the failing probe first: a try/except around the whole loop would keep the mutation
    # from the earlier probe and hide the later successful result.
    monkeypatch.setattr(web_llm, "_PROBES", (kobold_boom, web_llm._llama_holding))
    j = client.get("/llm/holding").get_json()
    assert j["holding"] == [{"engine": "llama.cpp", "model": "big-70b"}], (
        "a failing probe hid a working one — a single try/except around the loop turns one "
        "engine's timeout into 'the other is holding nothing', which is a WRONG answer rather "
        "than a missing one, and the warning silently stops existing")


def test_kobold_is_reported_through_the_SAME_shape(client, monkeypatch):
    """Engine-agnostic by construction: the browser reads `{engine, model}` and never branches on
    which engine it is, because the cards do not care which process is holding them."""
    wire_llama(monkeypatch, FakeRouter(_models(("small-8b", "unloaded"))))
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw", local=True))
    monkeypatch.setattr(kobold, "status", lambda cfg: {"loaded": True, "model": "some-70b"})
    j = client.get("/llm/holding").get_json()
    assert j["holding"] == [{"engine": "KoboldCpp", "model": "some-70b"}]


# ── the setting ─────────────────────────────────────────────────────────────

def test_the_warning_setting_defaults_to_ON(client, tmp_path, monkeypatch):
    """🔴 DEFAULT TRUE. A confirm nobody has found is a feature that does not exist, and this one
    costs a click to dismiss. The box is how you turn it OFF, not how you turn it on."""
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    rt_settings.save_app_settings({})                    # no key at all, as before 9.5
    assert client.get("/settings/app").get_json()["devices_warn_llm_loaded"] is True


def test_the_warning_setting_round_trips_off_and_back_on(client, tmp_path, monkeypatch):
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    rt_settings.save_app_settings({})
    client.put("/settings/app", json={"devices_warn_llm_loaded": False})
    assert client.get("/settings/app").get_json()["devices_warn_llm_loaded"] is False
    client.put("/settings/app", json={"devices_warn_llm_loaded": True})
    assert client.get("/settings/app").get_json()["devices_warn_llm_loaded"] is True


def test_saving_an_unrelated_setting_does_not_disturb_it(client, tmp_path, monkeypatch):
    """`in data` gates the write, so a PUT that never mentions this key leaves it alone. Collapsing
    that to a truthiness check is how editing one field silently resets another."""
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    rt_settings.save_app_settings({})
    client.put("/settings/app", json={"devices_warn_llm_loaded": False})
    client.put("/settings/app", json={"log_ansi_colors": True})
    assert client.get("/settings/app").get_json()["devices_warn_llm_loaded"] is False


# One setting controls both warning directions. Both engine status routes read it, so
# separate per-engine controls could drift and disagree about the same contention state.


def _two_cards(monkeypatch):
    """Use only the synthetic GPU registry installed by this test, never the host registry."""
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "Test Card A"},
                                 {"index": 1, "name": "Test Card B"}])


def _wire_both(monkeypatch, tmp_path):
    """Both engines local, one card ticked — the state the warning is FOR."""
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    _two_cards(monkeypatch)
    wire_llama(monkeypatch, FakeRouter(HELD))
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw", local=True))
    monkeypatch.setattr(kobold, "status", lambda cfg: {"loaded": False})
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True},
                                               {"id": "cuda:1", "enabled": False}]})


def test_the_ONE_checkbox_silences_BOTH_engines_load_warnings(client, monkeypatch, tmp_path):
    """🔴 THE JOIN, DRIVEN THROUGH THE ROUTE THE BROWSER ACTUALLY WRITES. Asserting each route's
    default separately would pass on the broken arrangement this replaces — the defaults always
    agreed; it was the SWITCH that only reached one of them."""
    _wire_both(monkeypatch, tmp_path)

    assert client.get("/kobold/status").get_json()["warn_gpus"] is True
    assert client.get("/llama/status").get_json()["warn_gpus"] is True

    client.put("/settings/app", json={"devices_warn_llm_loaded": False})
    assert client.get("/kobold/status").get_json()["warn_gpus"] is False
    assert client.get("/llama/status").get_json()["warn_gpus"] is False

    client.put("/settings/app", json={"devices_warn_llm_loaded": True})
    assert client.get("/kobold/status").get_json()["warn_gpus"] is True
    assert client.get("/llama/status").get_json()["warn_gpus"] is True


def test_llama_status_NAMES_the_cards_vocalis_still_has_ticked(client, monkeypatch, tmp_path):
    """🔴 IT NAMES THEM, and this engine had no server-side test for it at all until 9.5.9 —
    only the browser spec. "Some cards are in use" is a sentence you can only act on by going and
    looking; the id AND the label are what make the dialog point at a row to untick."""
    _wire_both(monkeypatch, tmp_path)
    j = client.get("/llama/status").get_json()
    assert j["vocalis_gpus"] == [{"id": "cuda:0", "label": "Test Card A"}]


def test_a_remote_llama_server_says_nothing_about_this_boxs_cards(client, monkeypatch, tmp_path):
    """A remote server uses hardware outside this process. Omit both `vocalis_gpus` and `warn_gpus`; an empty list would falsely imply that local cards were checked."""
    _wire_both(monkeypatch, tmp_path)
    wire_llama(monkeypatch, FakeRouter(HELD), local=False)
    j = client.get("/llama/status").get_json()
    assert "vocalis_gpus" not in j
    assert "warn_gpus" not in j


def test_a_stale_per_engine_key_is_INERT_on_both_engines(client, monkeypatch, tmp_path):
    """🔴 A PRE-9.5.9 `warn_gpus: false` IN EITHER SECTION MUST NOT SILENCE ANYTHING. The old keys
    are not migrated and not read: the effect of the change is a warning coming BACK, never one
    silently staying off. This fails if someone restores the old read "as a fallback", which would
    put the second switch back without putting its checkbox back."""
    _wire_both(monkeypatch, tmp_path)
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True},
                                               {"id": "cuda:1", "enabled": False}],
                                   "kobold": {"warn_gpus": False},
                                   "llama": {"warn_gpus": False}})
    assert client.get("/kobold/status").get_json()["warn_gpus"] is True
    assert client.get("/llama/status").get_json()["warn_gpus"] is True

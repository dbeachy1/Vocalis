"""Card pickers must agree with the server routes that enforce Settings → Devices permissions. The `/gpus` response publishes per-card `allows` values from `pool.local_card_permissions()`, using the same enabled and authorized checks as the routes. This matters for auto-selection: Voice Training may prefer the highest available card, but must never select a card that its route will refuse. The tests exercise the actual route contract rather than duplicating its permission calculation."""
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from vocalis.runtime import pool as rt_pool
from vocalis.runtime import subsystems


def _rows(per_card: dict):
    """app_settings-shaped `devices:` rows. `per_card` is {index: (enabled, uses)}, and it is a
    positional dict rather than `**kwargs` because the keys are card INDICES — ints are not
    legal keyword names."""
    return [{"id": f"cuda:{i}", "enabled": en, **({"uses": uses} if uses is not None else {})}
            for i, (en, uses) in sorted(per_card.items())]


@pytest.fixture
def settings_devices(monkeypatch):
    """Install a `devices:` list and return the permission map the route would publish."""
    def install(rows, cards=2):
        monkeypatch.setattr(rt_pool.settings, "load_app_settings", lambda: {"devices": rows})
        return rt_pool.local_card_permissions(range(cards))
    return install


def test_an_unticked_subsystem_is_false_for_that_card_only(settings_devices):
    """The narrow case: card 1 is on, but not available for voice creation. (This was TRAINING
    before the Docker edition dropped the training and Voice Swap subsystems; the property is
    the same for any registry key, so it now rides on VOICECREATE.)"""
    perms = settings_devices(_rows({0: (True, None), 1: (True, {subsystems.VOICECREATE: False})}))
    assert perms[0][subsystems.VOICECREATE] is True
    assert perms[1][subsystems.VOICECREATE] is False
    # 🔴 AND NOTHING ELSE ON THAT CARD MOVED. A row that narrows one subsystem must not read as
    # narrowing the others — that would turn one unticked box into a disabled card, which is a
    # different setting the user did not make.
    assert perms[1][subsystems.STEMS] is True
    assert perms[1][subsystems.RENDER] is True


def test_a_disabled_card_is_false_for_everything_whatever_its_uses_map_says(settings_devices):
    """⚠️ `enabled` and `uses` are read SEPARATELY server-side, and a picker that honored only
    the indented tick would offer a card switched off entirely."""
    perms = settings_devices(_rows({0: (True, None), 1: (False, {subsystems.VOICECREATE: True})}))
    assert all(v is False for v in perms[1].values()), perms[1]


def test_an_absent_row_and_an_absent_uses_map_are_both_ALLOWED(settings_devices):
    """🔴 THE MIGRATION, and the reason this is not a `.get(k, False)`. Every app_settings.yaml
    written before 7.6 has `{id, enabled}` and no `uses`; every card added since the file was
    last saved has no row at all. Both must keep behaving exactly as they do today — a default
    of "denied" would take five features away from every existing install on upgrade."""
    perms = settings_devices(_rows({0: (True, None)}), cards=2)   # card 1 has NO row
    assert all(perms[0][k] is True for k in subsystems.KEYS)
    assert all(perms[1][k] is True for k in subsystems.KEYS), "a card with no saved row was denied"


def test_every_registry_subsystem_is_answered_for_every_card(settings_devices):
    """A picker asks by KEY. A map missing one answers `undefined`, which the client reads as
    "not false" — allowed — so a missing key is a silently-open gate rather than a crash."""
    perms = settings_devices(_rows({0: (True, None), 1: (True, None)}))
    for i in (0, 1):
        assert set(perms[i]) == set(subsystems.KEYS), f"cuda:{i} is missing a subsystem"


# ── the agreement itself, driven through the real routes ────────────────────────────────────
# 🔴 THE ONLY TEST HERE THAT WOULD HAVE CAUGHT THE BUG. Everything above checks the map is
# computed correctly; none of it would have failed in the shipped build, because the map did not
# exist and the picker simply did not consult one. What was broken was the AGREEMENT between two
# layers, so that is what this asserts: for every card and every subsystem, what `/gpus` tells
# the dropdown must match what the route does when you press the button.
#
# ⚠️ It drives a real route (`/train/start` in the legacy app, `/model/load` for VoxCPM2 in the
# Docker edition, which has no training) rather than re-deriving the expectation. A test that computed the
# allowed set itself would share the client's assumption and pass while the two disagreed.

def test_what_gpus_publishes_is_exactly_what_model_load_enforces(monkeypatch):
    """Ported from `/train/start` (Voice Training is not in the Docker edition) to the retained
    route that consumes the VOICECREATE tick: `POST /model/load {"which": "voxcpm"}`. It hands
    `voxcpm_pool.usable_cards()` to the pool, which is the list a Voices → Create a voice press
    acts on, so it is what the picker has to agree with."""
    import types

    import torch
    import vocalis_server as vs
    import vocalis.runtime.configs as rt_configs
    import vocalis.runtime.gpu as gpu_mod
    from vocalis.runtime.voxcpm_pool import VOX

    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "R9700"}, {"index": 1, "name": "R9700"}])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    # `parse_devices` validates saved indices against the real card count; this box may have none.
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 2)
    monkeypatch.setattr(rt_configs, "voxcpm_cfg", lambda: types.SimpleNamespace(available=True))
    # The route's own decision is the list it hands the pool; record it and start nothing.
    offered_to_pool = []

    def claim_load(cards):
        offered_to_pool.append(list(cards))
        return []                                    # nothing to load: no worker thread starts

    monkeypatch.setattr(VOX, "claim_load", claim_load)
    monkeypatch.setattr(VOX, "loading", lambda: False)

    c = vs.app.test_client()
    # Both directions, so neither card is special: the unticked one is cuda:1, then cuda:0.
    for unticked, ticked in (("cuda:1", "cuda:0"), ("cuda:0", "cuda:1")):
        monkeypatch.setattr(rt_pool.settings, "load_app_settings", lambda: {
            "devices": [{"id": unticked, "enabled": True,
                         "uses": {subsystems.VOICECREATE: False}},
                        {"id": ticked, "enabled": True}]})
        rows = c.get("/gpus").get_json()
        allows = {r["index"]: r["allows"] for r in rows}

        # The picker's view: the ticked card yes, the unticked card no.
        assert allows[int(ticked.split(":")[1])][subsystems.VOICECREATE] is True
        assert allows[int(unticked.split(":")[1])][subsystems.VOICECREATE] is False

        # The route's view of the SAME two cards.
        offered_to_pool.clear()
        r = c.post("/model/load", json={"which": "voxcpm"})
        assert r.status_code == 200, (r.status_code, r.get_json())
        published = sorted(f"cuda:{idx}" for idx, a in allows.items()
                           if a[subsystems.VOICECREATE])
        assert [sorted(cards) for cards in offered_to_pool] == [published], (
            f"/gpus offers {published} for VOICECREATE but /model/load handed the pool "
            f"{offered_to_pool} — the dropdown and the route it feeds disagree, which is exactly "
            f"the defect this file is for")


# ── the 9.0 tabs joined the registry, and their dispatch honors it ───────────

def test_comfyui_is_in_the_registry_at_all_but_not_in_docker_mode():
    """🔴 9.0 SHIPPED TWO TABS THAT TAKE A CARD FOR HOURS AND NEITHER WAS IN THIS REGISTRY.

    The Devices panel renders one checkbox per key `capable()` returns, so a subsystem absent from
    `SUBSYSTEMS` has no tick — and every ComfyUI consumer therefore derived its device list from
    "how many systemd units exist" instead. Unticking `cuda:1` stopped stems, swaps, training,
    render and enhance and did nothing at all to LoRA Generate, face candidates, LoRA tests, LoRA
    training or shot rendering.

    ⚠️ **ONE KEY FOR BOTH TABS, DELIBERATELY**, because they share one dispatch path — every one of
    those five goes through `comfyui.authorized_instances()`. Two keys would be two ticks over one
    mechanism, which is a promise the server could not keep separately.
    """
    assert subsystems.COMFYUI in subsystems.KEYS
    row = next(s for s in subsystems.SUBSYSTEMS if s["key"] == subsystems.COMFYUI)
    # Docker edition: the LoRA Studio and Video tabs are excluded, so the label no longer names
    # them; it names the optional ComfyUI service the tick controls, and Docker mode omits the row.
    assert "ComfyUI" in row["label"], "the label must name what the tick controls"
    assert subsystems.COMFYUI in subsystems.keys_for_mode(False)
    assert subsystems.COMFYUI not in subsystems.keys_for_mode(True), (
        "the Docker Devices panel must not offer a tick for a service the image does not bundle"
    )
    assert row["satellite"] is False
    assert subsystems.COMFYUI not in subsystems.capable('test-satellite:cuda:0'), (
        "a satellite is a Chatterbox render box; offering it a ComfyUI tick is a dead checkbox"
    )
    assert subsystems.COMFYUI not in subsystems.capable("cpu")
    assert subsystems.COMFYUI in subsystems.capable("cuda:0")


def test_an_unticked_card_stops_receiving_comfyui_work(monkeypatch):
    """🔴 THE JOIN, NOT THE MAP. Every test above checks the permission map is computed right; this
    one checks the DISPATCH consults it, which is the half that was missing.

    ⚠️ **THE INDEX IS ASSIGNED BEFORE THE FILTER, AND THAT ORDER IS THE POINT.** `cuda:i` comes from
    the launch order of the units — `comfyui.service` is card 0, `comfyui-gpu1.service` hard-sets
    `HIP_VISIBLE_DEVICES=1`. Filtering the pairs and enumerating the survivors would renumber them,
    so unticking card 0 would point card 1's work at card 0's URL. Asserted explicitly below.
    """
    from vocalis.runtime import comfyui, settings

    monkeypatch.setattr(comfyui, "comfyui_instances",
                        lambda: [("comfyui.service", "http://127.0.0.1:8188"),
                                 ("comfyui-gpu1.service", "http://127.0.0.1:8189")])

    def _settings(rows):
        monkeypatch.setattr(settings, "load_app_settings", lambda: {"devices": rows})

    _settings([])
    assert [d for _s, _u, d in comfyui.authorized_instances()] == ["cuda:0", "cuda:1"], (
        "no saved rows must mean everything allowed - that is the migration"
    )

    _settings([{"id": "cuda:1", "enabled": False}])
    assert [d for _s, _u, d in comfyui.authorized_instances()] == ["cuda:0"], (
        "a card switched off entirely still received ComfyUI work"
    )

    # 🔴 THE RENUMBERING CASE, AND IT IS THE ONLY ONE THAT CATCHES IT. Disabling the FIRST card is
    # what distinguishes "assign the index, then filter" from "filter, then index": the survivor
    # must stay `cuda:1` on port 8189. Filtering first renumbers it to `cuda:0`, which then reads
    # card 0's saved row — so the card the user disabled is the row consulted for the card they did
    # not. I wrote this test without this case, mutated the order to check it, and the test passed.
    # A mutation a test survives is the test telling you which case it does not have.
    _settings([{"id": "cuda:0", "enabled": False}])
    survivors = comfyui.authorized_instances()
    assert [d for _s, _u, d in survivors] == ["cuda:1"], (
        "disabling card 0 renumbered card 1 onto card 0 instead of leaving it as cuda:1"
    )
    assert survivors[0][1].endswith("8189"), "the survivor was pointed at the disabled card's URL"

    _settings([{"id": "cuda:0", "enabled": True, "uses": {subsystems.COMFYUI: False}}])
    got = comfyui.authorized_instances()
    assert [d for _s, _u, d in got] == ["cuda:1"], "the per-subsystem tick was ignored"
    assert got[0][1].endswith("8189"), (
        "cuda:1 kept its own URL - filtering before enumerating would have renumbered it to card 0"
    )

    _settings([{"id": "cuda:0", "enabled": False}, {"id": "cuda:1", "enabled": False}])
    assert comfyui.authorized_instances() == [], (
        "with every card forbidden the answer is nothing - never a fallback to cuda:0"
    )


def test_no_comfyui_consumer_still_enumerates_the_unfiltered_list():
    """The three device-list helpers must go through `authorized_instances`. A fourth consumer
    added later that reaches for `comfyui_instances()` reintroduces the whole defect silently."""
    for rel in ("web/lora.py", "web/productions.py"):
        src = (Path(REPO_ROOT) / "src" / "vocalis" / rel).read_text(encoding="utf-8")
        code = "\n".join(ln.split("#", 1)[0] for ln in src.splitlines())
        assert "enumerate(comfyui.comfyui_instances())" not in code, (
            f"{rel} builds a device list from installed units, so the Devices tick does not reach it"
        )
        assert "authorized_instances()" in code, f"{rel} does not consult the Devices tick at all"

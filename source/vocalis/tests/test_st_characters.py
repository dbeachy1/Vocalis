"""3.x: the SillyTavern character registry + its HTTP surface.

Registry: the `sillytavern` section of voice_settings.yaml (keyed by character
name, sibling `default_voice`), seen-upsert semantics (never touches
assignments), full-map replace sanitization, and the corrupt-file write guard.
Routes: open POST /v1/st/characters (extension push, CORS'd) and gated
GET/PUT /st/characters (the web UI tab).
"""
import sys
from pathlib import Path

import pytest
import yaml
from flask import Flask

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import voice_utils                                           # noqa: E402
from st_characters import (MAX_CHARACTERS, StCharacterRegistry,   # noqa: E402
                           create_st_blueprint)


def _reg(tmp_path):
    return StCharacterRegistry(tmp_path / "voice_settings.yaml")


# ── registry ────────────────────────────────────────────────────────────────────

def test_upsert_seen_registers_and_is_idempotent(tmp_path):
    reg = _reg(tmp_path)
    assert reg.upsert_seen(["Test Character 1", "  Test Character 3  ", "", None]) == 2
    assert reg.upsert_seen(["Test Character 1"]) == 0                 # already known
    entry = reg.lookup("Test Character 1")
    assert entry["voice"] == "" and entry["last_seen"]
    assert reg.lookup("Test Character 3") is not None                       # stripped


def test_upsert_seen_never_touches_assignments(tmp_path):
    reg = _reg(tmp_path)
    reg.replace({"Test Character 1": {"voice": "v.wav", "exaggeration": 0.9}})
    reg.upsert_seen(["Test Character 1"])
    entry = reg.lookup("Test Character 1")
    assert entry["voice"] == "v.wav" and entry["exaggeration"] == 0.9


def test_persistence_roundtrip_in_sillytavern_section(tmp_path):
    # incoming `seed`/`turbo` (pre-3.x clients) are silently dropped, never stored
    _reg(tmp_path).replace({"Test Character 1": {"voice": "v.wav", "seed": 42, "turbo": True}})
    entry = _reg(tmp_path).lookup("Test Character 1")                 # fresh instance = re-read
    assert entry["voice"] == "v.wav" and "seed" not in entry and "turbo" not in entry
    # stored under the sillytavern top-level section, keyed by character
    raw = yaml.safe_load((tmp_path / "voice_settings.yaml").read_text(encoding="utf-8"))
    assert raw["sillytavern"]["Test Character 1"]["voice"] == "v.wav"


def test_registry_leaves_other_sections_alone(tmp_path):
    """The registry rewrites ONLY its own section — book tuning and the Nomi
    map in the shared file must survive every character save."""
    spath = tmp_path / "voice_settings.yaml"
    voice_utils.save_context_settings(spath, "v.wav", "book", {"exaggeration": 1.5})
    voice_utils.replace_section(spath, "nomi", {"default_voice": "d.wav"})
    reg = StCharacterRegistry(spath)
    reg.replace({"Test Character 1": {"voice": "v.wav"}})
    reg.set_default("v.wav")
    reg.upsert_seen(["Newcomer"])
    assert voice_utils.get_context_section(spath, "v.wav", "book") == {"exaggeration": 1.5}
    assert voice_utils.get_section(spath, "nomi")["default_voice"] == "d.wav"


def test_replace_sanitizes(tmp_path):
    reg = _reg(tmp_path)
    out = reg.replace({"Test Character 2": {"voice": "../../etc/passwd.wav", "exaggeration": "1.5"}})
    assert out["Test Character 2"]["voice"] == "passwd.wav"                 # leaf only
    assert out["Test Character 2"]["exaggeration"] == 1.5                   # cast
    with pytest.raises(ValueError):
        reg.replace({"Test Character 2": {"cfg": 2.0}})                     # out of range
    with pytest.raises(ValueError):
        reg.replace({"Test Character 2": "not-an-object"})


def test_replace_preserves_last_seen(tmp_path):
    reg = _reg(tmp_path)
    reg.upsert_seen(["Test Character 1"])
    seen = reg.lookup("Test Character 1")["last_seen"]
    out = reg.replace({"Test Character 1": {"voice": "v.wav"}})       # PUT without last_seen
    assert out["Test Character 1"]["last_seen"] == seen


def test_default_voice_persists(tmp_path):
    reg = _reg(tmp_path)
    assert reg.default_voice == ""
    assert reg.set_default("../sneaky/velvet.wav") == "velvet.wav"   # leaf only
    assert _reg(tmp_path).default_voice == "velvet.wav"    # fresh instance = re-read
    reg.set_default("")
    assert _reg(tmp_path).default_voice == ""


def test_default_voice_is_a_reserved_name(tmp_path):
    """A character literally named 'default_voice' would corrupt the section
    layout — it must be silently ignored everywhere."""
    reg = _reg(tmp_path)
    assert reg.upsert_seen(["default_voice"]) == 0
    assert reg.lookup("default_voice") is None
    assert "default_voice" not in reg.replace({"default_voice": {"voice": "v.wav"}})


def test_registration_cap(tmp_path):
    reg = _reg(tmp_path)
    reg.upsert_seen([f"c{i}" for i in range(MAX_CHARACTERS)])
    assert reg.upsert_seen(["overflow"]) == 0
    assert reg.lookup("overflow") is None


def test_corrupt_settings_file_refuses_writes_and_survives(tmp_path):
    """Review #23/#62 carried forward: an unreadable voice_settings.yaml must
    never be overwritten by the memory-backed registry. The registry starts
    empty; the admin mutations RAISE (and roll back memory); the open-route
    upsert logs + skips persisting; the file survives byte-for-byte."""
    spath = tmp_path / "voice_settings.yaml"
    spath.write_text("sillytavern: [broken\n", encoding="utf-8")
    before = spath.read_text(encoding="utf-8")
    reg = StCharacterRegistry(spath)
    assert reg.all() == {}                                     # unreadable -> starts empty
    with pytest.raises(voice_utils.SettingsUnreadable):
        reg.replace({"Test Character 2": {"voice": "v.wav"}})
    assert reg.all() == {}                                     # rolled back: memory == disk
    with pytest.raises(voice_utils.SettingsUnreadable):
        reg.set_default("v.wav")
    assert reg.default_voice == ""
    assert reg.upsert_seen(["Newcomer"]) == 1                  # open route: no raise
    assert spath.read_text(encoding="utf-8") == before         # file never touched


# ── boot while the vault is locked (5.0) ────────────────────────────────────────

def _locked_until(monkeypatch, gate):
    """Make voice_utils.get_section raise VaultLocked while gate['locked'] — the
    encrypted install's real boot order: vocalis_server constructs the registry
    at module scope AFTER vault_store.configure, with no password in RAM yet."""
    from vault import VaultLocked
    real = voice_utils.get_section

    def fake(path, section):
        if gate["locked"]:
            raise VaultLocked("vault is locked — the DEK is not in RAM")
        return real(path, section)

    monkeypatch.setattr(voice_utils, "get_section", fake)


def test_boot_with_locked_vault_does_not_crash(tmp_path, monkeypatch):
    """The server builds this at import time under `Restart=always`. An eager
    read that raises VaultLocked crash-loops the process, so it can never come
    up to serve the unlock page that would let anyone in. Boot, serve empty."""
    gate = {"locked": True}
    _locked_until(monkeypatch, gate)
    reg = StCharacterRegistry(tmp_path / "voice_settings.yaml")   # must not raise
    assert reg.all() == {} and reg.default_voice == ""
    assert reg.lookup("Test Character 1") is None


def test_locked_boot_then_unlock_does_not_wipe_the_section(tmp_path, monkeypatch):
    """🔴 THE DATA-LOSS REGRESSION. Booting locked leaves the map empty, and this
    map is the WHOLE section on every write. If the empty map were persisted, the
    first upsert after unlock would erase every assignment + default_voice — and
    upsert fires on the auth-EXEMPT /v1 routes, so a normal unlock followed by
    SillyTavern opening a chat is the entire trigger. Post-unlock use must MERGE."""
    spath = tmp_path / "voice_settings.yaml"
    reg0 = StCharacterRegistry(spath)
    reg0.replace({"Test Character 1": {"voice": "test-character-1.wav", "exaggeration": 0.9}})
    reg0.set_default("fallback.wav")

    gate = {"locked": True}
    _locked_until(monkeypatch, gate)
    reg = StCharacterRegistry(spath)                           # boots locked, empty
    assert reg.all() == {}

    gate["locked"] = False                                     # the user logs in
    assert reg.upsert_seen(["Newcomer"]) == 1                  # ST opens a chat

    on_disk = yaml.safe_load(spath.read_text(encoding="utf-8"))["sillytavern"]
    assert on_disk["Test Character 1"]["voice"] == "test-character-1.wav"         # survived
    assert on_disk["Test Character 1"]["exaggeration"] == 0.9
    assert on_disk["default_voice"] == "fallback.wav"          # survived
    assert "Newcomer" in on_disk                               # and the new one landed


def test_upsert_while_locked_holds_in_memory_and_never_persists(tmp_path, monkeypatch):
    """The open routes fire before anyone logs in. That must not 500 the stream
    (same disposition as a corrupt file) and must not write an empty section."""
    spath = tmp_path / "voice_settings.yaml"
    StCharacterRegistry(spath).replace({"Test Character 1": {"voice": "test-character-1.wav"}})
    before = spath.read_text(encoding="utf-8")

    gate = {"locked": True}
    _locked_until(monkeypatch, gate)
    reg = StCharacterRegistry(spath)
    assert reg.upsert_seen(["Newcomer"]) == 1                  # no raise
    assert spath.read_text(encoding="utf-8") == before         # file untouched


# ── routes ──────────────────────────────────────────────────────────────────────

def _mk_client(tmp_path):
    reg = _reg(tmp_path)
    app = Flask(__name__)
    # mirror prod CORS: /v1/* is the open, extension-facing surface
    from flask_cors import CORS
    CORS(app, resources={r"/v1/*": {"origins": "*"}})
    app.register_blueprint(create_st_blueprint(
        reg, voice_options=lambda: [{"name": "v.wav", "stem": "v"}]))
    return app.test_client(), reg


def test_seen_route_open_and_cors(tmp_path):
    client, reg = _mk_client(tmp_path)
    r = client.post("/v1/st/characters", json={"characters": ["Test Character 1"]},
                    headers={"Origin": "https://test-server.invalid:8000"})
    assert r.status_code == 200 and r.get_json()["registered"] == 1
    assert len(r.headers.getlist("Access-Control-Allow-Origin")) == 1
    assert reg.lookup("Test Character 1") is not None
    pre = client.options("/v1/st/characters", headers={
        "Origin": "https://test-server.invalid:8000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"})
    assert pre.headers.get("Access-Control-Allow-Origin")


def test_seen_route_requires_list(tmp_path):
    client, _ = _mk_client(tmp_path)
    r = client.post("/v1/st/characters", json={"characters": "Test Character 1"})
    assert r.status_code == 400
    assert r.get_json()["error"]["type"] == "invalid_request_error"


def test_get_put_roundtrip(tmp_path):
    client, _ = _mk_client(tmp_path)
    client.post("/v1/st/characters", json={"characters": ["Test Character 1"]})
    got = client.get("/st/characters").get_json()
    assert "Test Character 1" in got["characters"]
    assert got["voice_options"] == [{"name": "v.wav", "stem": "v"}]

    assert got["default_voice"] == ""

    got["characters"]["Test Character 1"].update(voice="v.wav", exaggeration=0.9)
    put = client.put("/st/characters", json={"characters": got["characters"],
                                             "default_voice": "v.wav"})
    assert put.status_code == 200
    body = put.get_json()
    entry = body["characters"]["Test Character 1"]
    assert entry["voice"] == "v.wav" and entry["exaggeration"] == 0.9
    assert "seed" not in entry and "turbo" not in entry
    assert body["default_voice"] == "v.wav"
    assert client.get("/st/characters").get_json()["default_voice"] == "v.wav"


def test_put_rejects_bad_payloads(tmp_path):
    client, _ = _mk_client(tmp_path)
    assert client.put("/st/characters", json={"characters": ["list"]}).status_code == 400
    r = client.put("/st/characters", json={"characters": {"Test Character 2": {"cfg": 5}}})
    assert r.status_code == 400 and "out of range" in r.get_json()["error"]


def test_put_corrupt_settings_file_500s(tmp_path):
    client, _ = _mk_client(tmp_path)
    (tmp_path / "voice_settings.yaml").write_text("sillytavern: [broken\n", encoding="utf-8")
    r = client.put("/st/characters", json={"characters": {"Test Character 2": {"voice": "v.wav"}}})
    assert r.status_code == 500 and "corrupt" in r.get_json()["error"]


# ── 7.0-m5b: two characters can share a name, and the registry assumed they could not ──

def test_two_characters_with_one_name_are_two_entries(tmp_path):
    """Two character cards may share a display name. The registry must keep both entries distinct by avatar instead of overwriting the first."""
    reg = StCharacterRegistry(tmp_path / "voice_settings.yaml")
    reg.upsert_seen([{"name": "Test_Character", "avatar": "Test_Character.png"}])
    reg.upsert_seen([{"name": "Test_Character", "avatar": "Test_Character-2.png"}])
    chars = reg.all()
    assert len(chars) == 2, f"the second Test_Character vanished into the first: {list(chars)}"
    assert {e.get("avatar") for e in chars.values()} == {"Test_Character.png", "Test_Character-2.png"}


def test_the_second_test_character_never_narrates_in_the_first_ones_voice(tmp_path):
    """🔴 WORSE THAN THE MISSING ROW, AND SILENT. `lookup` was by name, so it returned the first
    Test_Character's entry — the second would have spoken in her voice with nothing reporting it."""
    reg = StCharacterRegistry(tmp_path / "voice_settings.yaml")
    reg.upsert_seen([{"name": "Test_Character", "avatar": "Test_Character.png"}])
    reg.upsert_seen([{"name": "Test_Character", "avatar": "Test_Character-2.png"}])
    reg.replace({k: {**v, "voice": "test_voice.wav" if v.get("avatar") == "Test_Character.png" else "sample_voice.wav"}
                 for k, v in reg.all().items()})
    assert reg.lookup("Test_Character", "Test_Character.png")["voice"] == "test_voice.wav"
    assert reg.lookup("Test_Character", "Test_Character-2.png")["voice"] == "sample_voice.wav"


def test_an_entry_that_predates_the_avatar_is_ADOPTED_never_orphaned(tmp_path):
    """When a legacy entry has no avatar key, the first matching card must adopt it so its voice assignment and tuning remain available."""
    reg = StCharacterRegistry(tmp_path / "voice_settings.yaml")
    reg.upsert_seen(["Test_Character"])                       # the pre-m5b shape: a bare name
    reg.replace({"Test_Character": {"voice": "test_voice.wav", "exaggeration": 0.7}})
    assert reg.all()["Test_Character"].get("avatar") is None

    reg.upsert_seen([{"name": "Test_Character", "avatar": "Test_Character.png"}])
    chars = reg.all()
    assert list(chars) == ["Test_Character"], "a second row was minted beside the tuned one"
    assert chars["Test_Character"]["voice"] == "test_voice.wav", "his voice assignment was lost"
    assert chars["Test_Character"]["exaggeration"] == 0.7
    assert chars["Test_Character"]["avatar"] == "Test_Character.png", "the entry was not bound to the avatar"


def test_a_full_map_save_does_not_strip_the_avatar_binding(tmp_path):
    """🔴 WITHOUT THIS THE WHOLE FEATURE UNDOES ITSELF ON THE FIRST SAVE, INVISIBLY.

    `replace()` rebuilds every row from scratch — voice, params, last_seen — and returns exactly
    that. The SillyTavern tab saves as a full-map PUT by design, so a Save would have stripped
    `avatar` off every entry and collapsed the two Test_Characters back into one the next time either
    opened a chat.
    """
    reg = StCharacterRegistry(tmp_path / "voice_settings.yaml")
    reg.upsert_seen([{"name": "Test_Character", "avatar": "Test_Character.png"}])
    reg.upsert_seen([{"name": "Test_Character", "avatar": "Test_Character-2.png"}])
    # Exactly what the browser sends: keys and the editable fields, nothing else.
    reg.replace({k: {"voice": "test_voice.wav"} for k in reg.all()})
    kept = reg.all()
    assert len(kept) == 2
    assert {e.get("avatar") for e in kept.values()} == {"Test_Character.png", "Test_Character-2.png"}, \
        "a Save stripped the avatar binding"
    reg.upsert_seen([{"name": "Test_Character", "avatar": "Test_Character-2.png"}])
    assert len(reg.all()) == 2, "the two Test_Characters collapsed back into one after a Save"


def test_a_name_only_caller_still_resolves_exactly_as_before(tmp_path):
    """📌 The string form is not deprecated. `/v1/audio/stream` is an open route with callers that
    are not our extension, and an un-reinstalled extension copy sends no avatar. One character per
    name is the overwhelmingly common case and it must not change behavior."""
    reg = StCharacterRegistry(tmp_path / "voice_settings.yaml")
    reg.upsert_seen(["Test Character 1"])
    reg.replace({"Test Character 1": {"voice": "test_voice.wav"}})
    assert reg.lookup("Test Character 1")["voice"] == "test_voice.wav"
    assert reg.lookup("Test Character 1", None)["voice"] == "test_voice.wav"
    assert reg.lookup("Test Character 1", "")["voice"] == "test_voice.wav"


def test_an_avatar_can_never_carry_a_path(tmp_path):
    """⚠️ It becomes a settings key. A separator in it is a traversal in a file that holds every
    voice assignment."""
    reg = StCharacterRegistry(tmp_path / "voice_settings.yaml")
    reg.upsert_seen([{"name": "Test_Character", "avatar": "../../etc/passwd"}])
    assert reg.all()["Test_Character"]["avatar"] == "passwd"

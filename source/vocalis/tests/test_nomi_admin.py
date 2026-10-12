"""Nomi admin config endpoints GET/PUT /nomi (2.1-M3, reshaped 3.x).

The Nomi map lives in the `nomi` section of voice_settings.yaml (entries carry
name/voice/params/narrate_actions). Here we test the HTTP layer: shape,
voice_options, sanitization, full-map-replace semantics, and that /speak
reflects a save immediately.
"""
import pytest
import yaml

import vocalis_server
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.nomi as rt_nomi
import voice_utils
from nomi_speak import NomiSpeaker


@pytest.fixture
def client():
    with vocalis_server.app.test_client() as c:
        yield c


@pytest.fixture
def nomi_files(tmp_path, monkeypatch):
    vs = tmp_path / "voice_samples"; vs.mkdir()
    (vs / "testvoice.wav").write_bytes(b"x")
    (vs / "othervoice.mp3").write_bytes(b"x")
    settings = tmp_path / "voice_settings.yaml"
    settings.write_text(yaml.safe_dump({
        "nomi": {"default_voice": "testvoice.wav",
                 "111": {"name": "TestVoice", "voice": "testvoice.wav", "exaggeration": 0.6}}}),
        encoding="utf-8")
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", settings)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", vs)
    monkeypatch.setattr(rt_nomi, "NOMI", NomiSpeaker(settings, vs, tmp_path / "cache"))
    return settings


def test_nomi_get_shape(client, nomi_files):
    j = client.get("/nomi").get_json()
    assert j["nomis"]["111"]["name"] == "TestVoice"
    assert j["nomis"]["111"]["exaggeration"] == 0.6
    assert "default_voice" not in j["nomis"]                 # entries only, not the sibling key
    assert j["default_voice"] == "testvoice.wav"
    stems = {o["stem"] for o in j["voice_options"]}
    assert {"testvoice", "othervoice"} <= stems                         # wav AND mp3 offered


def test_nomi_voice_options_carry_favorite(client, nomi_files, tmp_path):
    """★ reaches the Nomi/ST dropdowns (4.8-m5 regression).

    Those tabs don't read GET /voices — they read the voice_options embedded here, and it
    shipped without `favorite`. The client's picker builder is shared, so nothing errored:
    the flag was just `undefined`, which renders no ⭐ and makes the favorites-first sort a
    no-op. Half the tabs had the feature and half didn't, silently. Assert the flag survives
    the trip on BOTH sides so a payload that forgets it fails here instead of in the browser."""
    (tmp_path / "voice_samples" / "testvoice.voice.json").write_text(
        '{"origin": "uploaded", "favorite": true}', encoding="utf-8")
    opts = {o["name"]: o for o in client.get("/nomi").get_json()["voice_options"]}
    assert opts["testvoice.wav"]["favorite"] is True
    assert opts["othervoice.mp3"]["favorite"] is False              # no sidecar ⇒ present and False,
                                                            # never missing (undefined ≠ false)


def test_nomi_put_updates_adds_removes(client, nomi_files):
    r = client.put("/nomi", json={
        "nomis": {"111": {"name": "TestVoice", "voice": "othervoice.mp3",         # updated voice
                          "exaggeration": 0.75, "cfg": 0.4, "temperature": 0.9,
                          "narrate_actions": False},
                  "222": {"name": "Test User 4", "voice": "testvoice.wav"}},     # added
        "default_voice": "othervoice.mp3"})
    assert r.status_code == 200
    j = r.get_json()
    assert j["nomis"]["111"]["voice"] == "othervoice.mp3"
    assert j["nomis"]["111"]["exaggeration"] == 0.75
    assert j["nomis"]["111"]["narrate_actions"] is False
    assert "222" in j["nomis"] and j["default_voice"] == "othervoice.mp3"
    # persisted in the nomi section of voice_settings.yaml
    raw = yaml.safe_load(nomi_files.read_text(encoding="utf-8"))
    assert raw["nomi"]["111"]["cfg"] == 0.4
    # /speak reflects the save without a restart: 111's own params...
    cfg = rt_nomi.NOMI.resolve("111", "TestVoice")
    assert cfg["voice_filename"] == "othervoice.mp3" and cfg["cfg_weight"] == 0.4
    assert cfg["narrate_actions"] is False
    # ...and an unknown Nomi gets the new default voice at chatterbox defaults
    assert rt_nomi.NOMI.resolve("999", "unknown")["voice_filename"] == "othervoice.mp3"


def test_nomi_put_is_full_map_replace(client, nomi_files):
    """An id missing from the PUT is deleted; a PUT without `nomis` (default_voice
    only) leaves the map untouched."""
    client.put("/nomi", json={"nomis": {"222": {"name": "Test User 4", "voice": "testvoice.wav"}}})
    j = client.get("/nomi").get_json()
    assert set(j["nomis"]) == {"222"}                        # 111 removed
    assert j["default_voice"] == "testvoice.wav"                 # untouched by that PUT
    r = client.put("/nomi", json={"default_voice": "othervoice.mp3"})
    j = r.get_json()
    assert set(j["nomis"]) == {"222"} and j["default_voice"] == "othervoice.mp3"


def test_nomi_put_sanitizes_voice_to_leaf(client, nomi_files):
    r = client.put("/nomi", json={"nomis": {"111": {"name": "A", "voice": "../../evil.wav"}}})
    assert r.status_code == 200
    assert r.get_json()["nomis"]["111"]["voice"] == "evil.wav"           # traversal stripped


def test_nomi_put_rejects_bad_shape_and_ranges(client, nomi_files):
    assert client.put("/nomi", json={"nomis": ["not", "a", "dict"]}).status_code == 400
    r = client.put("/nomi", json={"nomis": {"111": {"name": "A", "voice": "testvoice.wav",
                                                    "cfg": 5}}})
    assert r.status_code == 400 and "out of range" in r.get_json()["error"]
    r = client.put("/nomi", json={"nomis": {"111": {"name": "A", "voice": "testvoice.wav",
                                                    "exaggeration": "loud"}}})
    assert r.status_code == 400


def test_nomi_put_corrupt_settings_file_500s_without_wiping(client, nomi_files):
    """The carried-forward data-loss guard on the admin PUT: a corrupt
    voice_settings.yaml refuses the save (500) and the file survives."""
    nomi_files.write_text("nomi: [broken\n", encoding="utf-8")
    before = nomi_files.read_text(encoding="utf-8")
    r = client.put("/nomi", json={"nomis": {"1": {"name": "A", "voice": "testvoice.wav"}}})
    assert r.status_code == 500 and "corrupt" in r.get_json()["error"]
    assert nomi_files.read_text(encoding="utf-8") == before


# ── auto-created cards for Nomis we've never seen ─────────────────────────────
#
# Playing a Nomi the map doesn't know creates its card automatically (id + name
# pre-filled, no voice), the way the ST extension auto-registers characters — so
# a new Nomi shows up in the web UI's Nomi tab ready for a voice instead of having
# to be typed in by hand. Playback is deliberately UNCHANGED: until a voice is
# assigned the Nomi speaks with default_voice, exactly as before.


def test_auto_creates_card_for_unknown_nomi(client, nomi_files):
    speaker = rt_nomi.NOMI
    speaker.register_unknown("777", 'Test User 1')

    raw = yaml.safe_load(nomi_files.read_text(encoding="utf-8"))
    assert raw["nomi"]["777"] == {"name": 'Test User 1', "voice": ""}   # id + name, no voice yet
    assert raw["nomi"]["111"]["voice"] == "testvoice.wav"            # existing entry untouched
    assert raw["nomi"]["default_voice"] == "testvoice.wav"           # the sibling key survives
    # it reaches the admin GET the Nomi tab reads
    assert client.get("/nomi").get_json()["nomis"]["777"]["name"] == 'Test User 1'
    # and until a voice is picked it still speaks with default_voice — no behavior change
    assert speaker.resolve("777", 'Test User 1')["voice_filename"] == "testvoice.wav"


def test_auto_create_is_idempotent_and_never_overwrites(client, nomi_files):
    """Every subsequent play must be a no-op. If it re-wrote the entry it would
    stamp a user's assigned voice back to "" on the next thing they said."""
    speaker = rt_nomi.NOMI
    speaker.register_unknown("777", 'Test User 1')
    speaker.register_unknown("777", 'Test User 1 Renamed')              # a later play
    raw = yaml.safe_load(nomi_files.read_text(encoding="utf-8"))
    assert raw["nomi"]["777"] == {"name": 'Test User 1', "voice": ""}   # NOT rewritten
    # an id that already has a voice is likewise never touched
    speaker.register_unknown("111", "TestVoice")
    raw = yaml.safe_load(nomi_files.read_text(encoding="utf-8"))
    assert raw["nomi"]["111"]["voice"] == "testvoice.wav"


def test_auto_create_skips_unresolvable_ids(client, nomi_files):
    """A group chat whose avatar didn't yield an id sends null/empty — that must
    not create a card keyed "None" (the extension JSON-nulls a failed lookup)."""
    speaker = rt_nomi.NOMI
    speaker.register_unknown("", 'Test User 3')
    speaker.register_unknown("None", 'Test User 3')                  # JSON null -> str(None)
    raw = yaml.safe_load(nomi_files.read_text(encoding="utf-8"))
    assert set(raw["nomi"]) == {"default_voice", "111"}          # nothing created


def test_auto_create_stores_blank_for_the_unknown_name_sentinel(client, nomi_files):
    """request_context defaults a missing name to the literal "unknown"; that is a
    sentinel, not a name, so the card gets an empty name field to fill in."""
    rt_nomi.NOMI.register_unknown("888", "unknown")
    raw = yaml.safe_load(nomi_files.read_text(encoding="utf-8"))
    assert raw["nomi"]["888"] == {"name": "", "voice": ""}


def test_auto_create_on_corrupt_settings_neither_raises_nor_wipes(client, nomi_files):
    """It fires on the OPEN /speak route, so a corrupt settings file must not 500
    a Nomi mid-conversation — and must never rebuild the section from one entry."""
    nomi_files.write_text("nomi: [broken\n", encoding="utf-8")
    before = nomi_files.read_text(encoding="utf-8")
    rt_nomi.NOMI.register_unknown("777", 'Test User 1')          # must not raise
    assert nomi_files.read_text(encoding="utf-8") == before      # file survives


def test_speak_request_context_auto_creates(client, nomi_files):
    """The real seam: both /speak and /speak/stream go through request_context, so
    the card appears as a side effect of the play itself."""
    rt_nomi.NOMI.request_context(
        {"nomi_id": "555", "nomi_name": 'Test User 2', "text": "Hello there."})
    raw = yaml.safe_load(nomi_files.read_text(encoding="utf-8"))
    assert raw["nomi"]["555"] == {"name": 'Test User 2', "voice": ""}


# ── cache key (salvaged from test_nomi.py, deleted with the retired server in 5.0-M2) ──
#
# The original test built its OWN make_key lambda and compared it to itself — a tautology
# that never touched production code. Ported here against the LIVE NomiSpeaker.cache_key,
# so it actually guards the property it claims to.
#
# This matters for 5.0: POST /voices/<name>/clear_cache is implemented as nothing but an
# os.utime() (SWEEP §3), so if the vault ever stops exposing a real mtime for a logical
# path, clear-cache silently becomes a no-op that reports success.

def _cfg_for(voice_path):
    return {"voice": voice_path, "voice_filename": voice_path.name,
            "exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.8}


def test_cache_key_changes_when_voice_mtime_changes(tmp_path):
    """Replacing a voice WAV must invalidate its cached audio."""
    import os
    from nomi_speak import NomiSpeaker

    vp = tmp_path / "test_voice.wav"
    vp.write_bytes(b"RIFF-fake")
    speaker = NomiSpeaker.__new__(NomiSpeaker)          # cache_key needs no init state

    os.utime(vp, (1000, 1000))
    k1 = speaker.cache_key(_cfg_for(vp), "Hello.")
    os.utime(vp, (9999, 9999))
    k2 = speaker.cache_key(_cfg_for(vp), "Hello.")

    assert k1 != k2, "a replaced voice WAV would serve stale cached audio"


def test_cache_key_changes_with_text_and_params(tmp_path):
    from nomi_speak import NomiSpeaker

    vp = tmp_path / "v.wav"
    vp.write_bytes(b"RIFF-fake")
    speaker = NomiSpeaker.__new__(NomiSpeaker)
    base = _cfg_for(vp)

    k = speaker.cache_key(base, "Hello.")
    assert k != speaker.cache_key(base, "Goodbye.")
    assert k == speaker.cache_key(_cfg_for(vp), "Hello."), "the key must be stable"
    assert k != speaker.cache_key({**base, "exaggeration": 0.9}, "Hello.")

"""Cached-message counts per voice, and 🧹 Clear deleting them (11.2.9 / 11.3.0).

The speech cache is filed by SPEAKER (`<root>/<md5(owner)[:16]>/<shard>/<key>.mp3`), not by
voice, so `/voices/cache_stats` answers "how much is cached for this voice" by asking which
speakers use it. That only works if the owner strings it builds match the ones the WRITERS use —
so every cache file here is placed at the path the real writer computes (`request_context` for a
Nomi, `resolve_st_request` for a SillyTavern character), never at a path this test derives by
hand. A drift between the two would then fail here instead of showing zero in the UI.
"""
import pytest
import yaml

import vocalis_server
import vocalis.runtime.nomi as rt_nomi
import vocalis.runtime.paths as rt_paths
from nomi_speak import NomiSpeaker
from st_characters import StCharacterRegistry
from vocalis_stream_http import resolve_st_request


@pytest.fixture
def client():
    with vocalis_server.app.test_client() as c:
        yield c


@pytest.fixture
def world(tmp_path, monkeypatch):
    """Two voices; Nomis and ST characters spread across them, some through the defaults."""
    vs = tmp_path / "voice_samples"
    vs.mkdir()
    (vs / "testvoice.wav").write_bytes(b"RIFF-testvoice")
    (vs / "othervoice.wav").write_bytes(b"RIFF-othervoice")
    settings = tmp_path / "voice_settings.yaml"
    settings.write_text(yaml.safe_dump({
        "nomi": {"default_voice": "testvoice.wav",
                 "111": {"name": "NomiOne", "voice": "testvoice.wav"},
                 "222": {"name": "NomiTwo", "voice": ""}},              # -> Nomi default (testvoice)
        "sillytavern": {"default_voice": "",                          # unset -> Nomi default
                        "TestCharacter": {"voice": "othervoice.wav"},
                        "OtherCharacter": {"voice": ""},                        # -> testvoice, via both defaults
                        # the second Test_Character: keyed by her avatar's stem, filed by display name
                        "test_character2": {"voice": "othervoice.wav", "name": "Test_Character",
                                     "avatar": "test_character2.png"}}}),
        encoding="utf-8")
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", settings)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", vs)
    nomi = NomiSpeaker(settings, vs, tmp_path / "cache")
    monkeypatch.setattr(rt_nomi, "NOMI", nomi)
    reg = StCharacterRegistry(settings)

    def nomi_file(nid, text, size):
        p = nomi.request_context({"nomi_id": nid, "text": text})["cpath"]
        p.write_bytes(b"m" * size)
        return p

    def st_file(character, text, size, avatar=""):
        req = resolve_st_request({"input": text, "character": character,
                                  "character_avatar": avatar},
                                 nomi=nomi, st_registry=reg,
                                 resolve_voice=lambda n: vs / n if (vs / n).exists() else None)
        req["cpath"].write_bytes(b"s" * size)
        return req["cpath"]

    return {"nomi_file": nomi_file, "st_file": st_file, "nomi": nomi}


def test_stats_count_each_speakers_files_under_its_voice(client, world):
    world["nomi_file"]("111", "one", 100)
    world["nomi_file"]("111", "two", 200)
    world["nomi_file"]("222", "three", 50)          # NomiTwo speaks the Nomi default: testvoice
    world["st_file"]("OtherCharacter", "four", 7)             # OtherCharacter falls through both defaults: testvoice
    world["st_file"]("TestCharacter", "five", 1000)
    world["st_file"]("Test_Character", "six", 30, avatar="test_character2.png")
    j = client.get("/voices/cache_stats").get_json()
    assert j["voices"]["testvoice.wav"] == {"messages": 4, "bytes": 357}
    assert j["voices"]["othervoice.wav"] == {"messages": 2, "bytes": 1030}


def test_a_voice_with_nothing_cached_is_absent(client, world):
    world["st_file"]("TestCharacter", "hi", 10)
    j = client.get("/voices/cache_stats").get_json()
    assert "testvoice.wav" not in j["voices"]
    assert j["voices"]["othervoice.wav"]["messages"] == 1


def test_clear_deletes_only_the_speakers_on_that_voice(client, world):
    a = [world["nomi_file"]("111", "one", 100), world["nomi_file"]("222", "two", 50),
         world["st_file"]("OtherCharacter", "three", 7)]
    b = [world["st_file"]("TestCharacter", "four", 1000)]
    r = client.post("/voices/testvoice.wav/clear_cache", json={})
    assert r.status_code == 200
    j = r.get_json()
    assert (j["messages_deleted"], j["bytes_deleted"]) == (3, 157)
    assert not any(p.exists() for p in a), "Clear left testvoice's cached messages on disk"
    assert all(p.exists() for p in b), "Clear on testvoice deleted othervoice's cache"
    after = client.get("/voices/cache_stats").get_json()["voices"]
    assert "testvoice.wav" not in after
    assert after["othervoice.wav"]["messages"] == 1


def test_clear_still_bumps_the_voice_mtime(client, world, tmp_path):
    """The delete is added to the bump, never instead of it: a render whose voice came from the
    request body rather than the saved map is only invalidated by the new key."""
    import os
    v = tmp_path / "voice_samples" / "testvoice.wav"
    os.utime(v, (1000, 1000))
    client.post("/voices/testvoice.wav/clear_cache", json={})
    assert v.stat().st_mtime > 1000


def test_owner_usage_and_clear_owner_skip_in_flight_temps(tmp_path):
    nomi = NomiSpeaker(tmp_path / "vs.yaml", tmp_path, tmp_path / "cache")
    p = nomi.cache_path("ab" + "0" * 30, "st:Zed")
    p.parent.mkdir(parents=True)
    p.write_bytes(b"x" * 10)
    (p.parent / (p.name + ".part.123")).write_bytes(b"y" * 99)   # a render still being written
    assert nomi.owner_usage("st:Zed") == (1, 10)
    assert nomi.owner_usage("st:Nobody") == (0, 0)
    assert nomi.clear_owner("st:Zed") == (1, 10)
    assert not p.exists()
    assert (p.parent / (p.name + ".part.123")).exists(), "Clear deleted an in-flight render"


# Per-character totals use the same registry key as the row, and clearing one character must
# leave other characters and in-flight renders untouched.

def test_stats_also_answer_per_character_keyed_like_the_rows(client, world):
    world["st_file"]("TestCharacter", "a", 10)
    world["st_file"]("OtherCharacter", "b", 20)
    world["st_file"]("OtherCharacter", "c", 30)
    world["st_file"]("Test_Character", "d", 5, avatar="test_character2.png")
    world["nomi_file"]("222", "e", 40)
    sp = client.get("/voices/cache_stats").get_json()["speakers"]
    assert sp["st"]["TestCharacter"] == {"messages": 1, "bytes": 10}
    assert sp["st"]["OtherCharacter"] == {"messages": 2, "bytes": 50}
    # keyed by the REGISTRY key the row carries, filed under the display name the stream writes
    assert sp["st"]["test_character2"] == {"messages": 1, "bytes": 5}
    assert sp["nomi"]["222"] == {"messages": 1, "bytes": 40}
    assert sp["nomi"]["111"] == {"messages": 0, "bytes": 0}


def test_clear_speaker_deletes_that_character_only(client, world, tmp_path):
    import os
    dana = [world["st_file"]("OtherCharacter", "one", 7), world["st_file"]("OtherCharacter", "two", 8)]
    ann = world["nomi_file"]("111", "three", 100)      # also on testvoice — must survive
    v = tmp_path / "voice_samples" / "testvoice.wav"
    os.utime(v, (1000, 1000))
    r = client.post("/voices/cache/clear_speaker", json={"kind": "st", "key": "OtherCharacter"})
    assert r.status_code == 200
    assert (r.get_json()["messages_deleted"], r.get_json()["bytes_deleted"]) == (2, 15)
    assert not any(p.exists() for p in dana)
    assert ann.exists(), "clearing one character deleted another's cache on the same voice"
    assert v.stat().st_mtime == 1000, "clearing one character re-keyed the whole voice"


def test_clear_speaker_refuses_an_unknown_one(client, world):
    r = client.post("/voices/cache/clear_speaker", json={"kind": "st", "key": "Nobody"})
    assert r.status_code == 404

"""8.0-m3g — candidates, saving, and the library routes.

The two claims worth pinning, because both are invisible when broken:

🔴 **A CANDIDATE IS NEVER WRITTEN TO DISK.** It is proxied from the backend that made it, and
Save is the only thing that copies bytes into Vocalis. Break that and nothing fails — the tray
works, the songs play — you simply accumulate tens of MB of FLAC per Generate for audio that was
about to be discarded, in a tree nothing sweeps.

🔴 **THE LIBRARY STAYS LOSSLESS AND OPUS IS MADE AT DOWNLOAD TIME.** Voice Swap and Demucs will
consume these later and both want the FLAC. Storing an Opus twin would double the space and make
"which one is the song" ambiguous again.
"""
import urllib.error

import pytest

import vocalis_server as vs
import vocalis.runtime.acelib as rt_acelib
import vocalis.runtime.jobs as jobs_mod
import vocalis.runtime.paths as rt_paths
from vocalis.runtime import acestep as rt


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def lib(monkeypatch, tmp_path):
    """Never the developer's real library — it holds songs."""
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", tmp_path / "ace_library.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", tmp_path / "ace_library")
    return tmp_path


SONG = b"RIFF-pretend-flac-bytes"


def _finished_job(monkeypatch, **detail):
    """A job that has completed, as the runner would have left it."""
    job = jobs_mod.Job(id="j" + str(len(jobs_mod.JOBS)), docx="", voice="", params=None,
                       gpus="cuda:0", workers=1, kind="acestep", status="done")
    job.detail = {"audio": ["/gradio_outputs/batch_1/song.flac"], "url": "http://127.0.0.1:7683",
                  "device": "cuda:0", "model": "acestep-v15-turbo", "seed": 7,
                  "title": 'Sample Track', "payload": {"prompt": "alt metal", "lyrics": "[verse]\nx"}}
    job.detail.update(detail)
    with jobs_mod.JOBS_LOCK:
        jobs_mod.JOBS[job.id] = job
    monkeypatch.setattr(rt, "fetch_audio", lambda url, path, timeout=120.0: SONG)
    return job


def test_a_candidate_is_proxied_and_NOTHING_is_written(client, monkeypatch, lib):
    """🔴 THE INVARIANT. Playing a candidate must not create a file — most of them are discarded,
    and a staging copy would give one song a third home (§6.4)."""
    job = _finished_job(monkeypatch)
    r = client.get(f"/acestep/jobs/{job.id}/audio")
    assert r.status_code == 200 and r.data == SONG
    assert not (lib / "ace_library").exists(), "playing a candidate wrote it to the library tree"
    assert not (lib / "ace_library.json").exists(), "playing a candidate indexed it"


def test_a_candidate_that_has_not_finished_says_so_rather_than_500ing(client, monkeypatch):
    job = _finished_job(monkeypatch, audio=[])
    assert client.get(f"/acestep/jobs/{job.id}/audio").status_code == 409


def test_a_dead_backend_is_a_502_naming_the_card(client, monkeypatch):
    """⚠️ The backend can be stopped between finishing a song and someone pressing play. That is
    a 502 about that card, not a Vocalis error."""
    job = _finished_job(monkeypatch)

    def boom(url, path, timeout=120.0):
        raise OSError("connection refused")
    monkeypatch.setattr(rt, "fetch_audio", boom)
    r = client.get(f"/acestep/jobs/{job.id}/audio")
    assert r.status_code == 502 and "cuda:0" in r.get_json()["error"]


def test_a_refused_backend_says_the_audio_is_STILL_THERE_and_which_button_starts_it(
        client, monkeypatch):
    """Return actionable backend-unavailable guidance without implying saved candidates were deleted. ACESTEP_TMPDIR stores generated FLACs in the vault, while upstream cleanup removes tracked uploads rather than saved renders; service availability and file existence are separate."""
    job = _finished_job(monkeypatch)

    def refused(url, path, timeout=120.0):
        raise urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
    monkeypatch.setattr(rt, "fetch_audio", refused)
    msg = client.get(f"/acestep/jobs/{job.id}/audio").get_json()["error"]
    assert "cuda:0" in msg, "the card is the one fact that says WHICH backend to start"
    assert "not running" in msg
    assert "Nothing has been deleted" in msg, "the fear is the thing the message exists to answer"
    assert "Start ACE-Step" in msg, "naming the cure is what turns a report into a fix"
    assert "Errno" not in msg and "urlopen" not in msg


def test_SAVE_answers_a_refused_backend_the_same_way_PLAY_does(client, monkeypatch, lib):
    """⚠️ They are the SAME failure — one `fetch_audio`, one dead backend. Save fetches the
    bytes before it writes anything, so a stopped unit breaks both at once; answering them
    differently is what made *"could not save it: <urlopen error [Errno 111]>"* read as a second,
    separate disaster on top of the first."""
    job = _finished_job(monkeypatch)

    def refused(url, path, timeout=120.0):
        raise urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
    monkeypatch.setattr(rt, "fetch_audio", refused)
    r = client.post(f"/acestep/jobs/{job.id}/save", json={"name": 'Sample Track'})
    assert r.status_code == 502
    msg = r.get_json()["error"]
    assert "cuda:0" in msg and "Nothing has been deleted" in msg and "Errno" not in msg
    # And the library is untouched — a save that could not read the bytes must not leave a row.
    assert client.get("/acestep/library").get_json()["songs"] == []


def test_a_failure_that_is_NOT_a_refusal_keeps_its_own_text(client, monkeypatch):
    """🔴 NO FALSE REASSURANCE. "Nothing has been deleted" is a claim, not a pleasantry: it
    is true of a stopped backend and unknown of anything else. A disk error or a truncated read
    must arrive as itself, or the friendly sentence becomes the next thing that lies to him."""
    job = _finished_job(monkeypatch)

    def boom(url, path, timeout=120.0):
        raise OSError("I/O error reading the file")
    monkeypatch.setattr(rt, "fetch_audio", boom)
    msg = client.get(f"/acestep/jobs/{job.id}/audio").get_json()["error"]
    assert "I/O error reading the file" in msg
    assert "Nothing has been deleted" not in msg


def test_saving_copies_the_bytes_and_records_what_it_was_RENDERED_from(client, monkeypatch, lib):
    """🔴 THE ROW STORES THE WORDS, NOT A POINTER. A template can be renamed or deleted after the
    fact; if the row pointed at one, the library would then lie about its own history."""
    job = _finished_job(monkeypatch, template_id="tpl-1")
    r = client.post(f"/acestep/jobs/{job.id}/save", json={"name": 'Sample Track One'})
    assert r.status_code == 201
    song = r.get_json()
    assert song["name"] == 'Sample Track One' and song["template_id"] == "tpl-1"
    assert song["caption"] == "alt metal" and song["lyrics"] == "[verse]\nx"
    assert song["model"] == "acestep-v15-turbo" and song["seed"] == 7
    assert rt_acelib.audio_path(song["id"]).exists(), "the audio was indexed but not written"


def test_saving_an_unfinished_job_is_refused(client, monkeypatch):
    job = _finished_job(monkeypatch, audio=[])
    assert client.post(f"/acestep/jobs/{job.id}/save", json={}).status_code == 409


def test_the_library_lists_newest_first_and_filters_by_template(client, monkeypatch, lib):
    a = _finished_job(monkeypatch, template_id="tpl-a")
    client.post(f"/acestep/jobs/{a.id}/save", json={"name": "From A"})
    b = _finished_job(monkeypatch, template_id="tpl-b")
    client.post(f"/acestep/jobs/{b.id}/save", json={"name": "From B"})

    everything = client.get("/acestep/library").get_json()["songs"]
    assert {s["name"] for s in everything} == {"From A", "From B"}
    only_a = client.get("/acestep/library?template_id=tpl-a").get_json()["songs"]
    assert [s["name"] for s in only_a] == ["From A"], (
        "selecting a template did not narrow the library to the songs made from it")


def test_the_stored_song_is_served_back_as_flac(client, monkeypatch, lib):
    job = _finished_job(monkeypatch)
    song = client.post(f"/acestep/jobs/{job.id}/save", json={"name": "x"}).get_json()
    r = client.get(f"/acestep/library/{song['id']}/audio")
    assert r.status_code == 200 and r.data == SONG
    assert r.mimetype == "audio/flac"


def test_opus_is_a_transcode_at_download_time_and_the_stored_copy_stays_flac(client, monkeypatch,
                                                                            lib):
    """🔴 The library is what Voice Swap and Demucs will consume, so it stays lossless. An Opus
    twin on disk would double the space and make "which one is the song" ambiguous."""
    job = _finished_job(monkeypatch)
    song = client.post(f"/acestep/jobs/{job.id}/save", json={"name": "x"}).get_json()
    monkeypatch.setattr(rt_acelib, "to_opus", lambda p, bitrate=None: b"OggS-fake-opus")
    r = client.get(f"/acestep/library/{song['id']}/audio?format=opus")
    assert r.status_code == 200 and r.data == b"OggS-fake-opus"
    # the stored bytes are untouched
    assert rt_acelib.audio_path(song["id"]).read_bytes() == SONG
    assert list(rt_paths.ACE_LIBRARY_AUDIO.glob("*.opus")) == [], "an Opus copy was stored"


def test_rename_favorite_and_delete(client, monkeypatch, lib):
    job = _finished_job(monkeypatch)
    song = client.post(f"/acestep/jobs/{job.id}/save", json={"name": "Before"}).get_json()
    client.post(f"/acestep/library/{song['id']}", json={"name": "After", "favorite": True})
    got = client.get("/acestep/library").get_json()["songs"][0]
    assert got["name"] == "After" and got["favorite"] is True

    p = rt_acelib.audio_path(song["id"])
    assert p.exists()
    assert client.delete(f"/acestep/library/{song['id']}").status_code == 200
    assert client.get("/acestep/library").get_json()["songs"] == []
    assert not p.exists(), "the row went but the audio was left behind"


def test_deleting_SEVERAL_songs_takes_one_request_and_the_audio_with_them(client, monkeypatch, lib):
    """DELETE /acestep/library accepts one ids list for a batch delete. The library index is a single locked read-modify-write store, so one request avoids repeated cycles and partial failure across individual deletes."""
    ids, paths_ = [], []
    for name in ("One", "Two", "Three"):
        job = _finished_job(monkeypatch)
        song = client.post(f"/acestep/jobs/{job.id}/save", json={"name": name}).get_json()
        ids.append(song["id"])
        paths_.append(rt_acelib.audio_path(song["id"]))
    assert all(p.exists() for p in paths_)

    r = client.delete("/acestep/library", json={"ids": ids[:2]})
    assert r.status_code == 200
    body = r.get_json()
    assert body["deleted"] == 2 and body["missing"] == []
    left = client.get("/acestep/library").get_json()["songs"]
    assert [s["name"] for s in left] == ["Three"], "the two named went and the third stayed"
    assert not paths_[0].exists() and not paths_[1].exists(), "the rows went but the audio was left behind"
    assert paths_[2].exists(), "a song that was NOT named must keep its audio"


def test_a_bulk_delete_REPORTS_the_ids_that_were_already_gone(client, monkeypatch, lib):
    """⚠️ A tick set can name a song another tab deleted a second ago. Refusing the whole request
    over that would make the common case fail; saying nothing would report a delete that did not
    happen. So `deleted` counts what really went and `missing` names what was already gone —
    exactly the quiet arithmetic the Sources bulk bar records as reading like a failed delete."""
    job = _finished_job(monkeypatch)
    song = client.post(f"/acestep/jobs/{job.id}/save", json={"name": "Only"}).get_json()

    body = client.delete("/acestep/library", json={"ids": [song["id"], "ghost-id"]}).get_json()
    assert body["deleted"] == 1
    assert body["missing"] == ["ghost-id"]
    assert client.get("/acestep/library").get_json()["songs"] == []


def test_a_bulk_delete_with_no_ids_is_a_400_and_deletes_NOTHING(client, monkeypatch, lib):
    """🔴 THE ONE INPUT THAT MUST NEVER MEAN "ALL". An empty or absent list reaching a loop that
    happens to iterate the library instead would empty it, and the request that sends it is a
    tick set someone forgot to fill in."""
    job = _finished_job(monkeypatch)
    client.post(f"/acestep/jobs/{job.id}/save", json={"name": "Keep me"})

    for payload in ({}, {"ids": []}, {"ids": "all"}):
        assert client.delete("/acestep/library", json=payload).status_code == 400, payload
    assert len(client.get("/acestep/library").get_json()["songs"]) == 1


def test_unknown_ids_are_404s_everywhere(client, lib):
    assert client.get("/acestep/library/nope/audio").status_code == 404
    assert client.post("/acestep/library/nope", json={"name": "x"}).status_code == 404
    assert client.delete("/acestep/library/nope").status_code == 404
    assert client.get("/acestep/jobs/nope/audio").status_code == 404

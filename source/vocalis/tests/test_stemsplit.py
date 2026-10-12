"""Tests the stem-job engine and routes with Demucs mocked. The suite covers splitting,
extending, upload, cancellation, failure, and cached replay without external tools.
"""
import io
import json
import threading
from pathlib import Path

import numpy as np
import pytest
from conftest import install_demucs_weights, install_lead_models

import leadvocal
import song_library
import stems
import stem_engine
import stemsplit
import vocalis_server as vs
import vocalis.runtime.configs as rt_configs
import vocalis.runtime.pool as rt_pool
import vocalis.web.stems as web_stems


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def _drain_ss_jobs(monkeypatch):
    # `/stems/start` hands its worker thread to nobody, so the only way to know a route-started job
    # has really ended is to hold the Thread objects. The route reaches `threading` only for that
    # one Thread, so a stand-in module that records each Thread it creates changes nothing else.
    started_threads = []

    class _RecordingThread(threading.Thread):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            started_threads.append(self)

    class _ThreadingStandIn:
        Thread = _RecordingThread

        def __getattr__(self, name):
            # Every other attribute is the real `threading`'s, so a route that starts using Lock,
            # Event or current_thread keeps working instead of dying on a missing name.
            return getattr(threading, name)

    monkeypatch.setattr(web_stems, "threading", _ThreadingStandIn())
    yield
    for j in list(stemsplit.JOBS.values()):
        j.cancel.set()
    for t in started_threads:
        t.join(60)
        assert not t.is_alive(), "a route-started split job did not end after cancel"
    stemsplit.JOBS.clear()


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    c = stemsplit.StemConfig(
        venv=tmp_path / "stems-venv",
        acestep_dir=tmp_path / "acestep",
        songs_dir=tmp_path / "uploads" / "songs",
        stems_dir=tmp_path / "output" / "stems",
        stem_uploads_dir=tmp_path / "uploads" / "stems",
        work_root=tmp_path / "work",
        song_index=tmp_path / "cache" / "song_ids.yaml",   # the song-ID cache shared with the swap
        # Keep child paths inside the test-owned tree; never depend on a host model install.
        leadvocal_venv=tmp_path / "leadvocal-venv",
        leadvocal_models=tmp_path / "leadvocal-models",
        leadvocal_scripts=tmp_path / "scripts" / "leadvocal",
    )
    for d in (c.acestep_dir, c.songs_dir, c.stems_dir, c.stem_uploads_dir):
        d.mkdir(parents=True, exist_ok=True)
    c.python.parent.mkdir(parents=True, exist_ok=True)
    c.python.write_bytes(b"")
    # The lead chain checks its interpreter and its script exist before it spends anything.
    for f in (c.leadvocal_python, c.leadvocal_detect):
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"")
    # Both children also refuse to start unless their model files are already on disk (nothing is
    # downloaded), so the faked children get stand-ins; the tests of the refusal remove them.
    install_demucs_weights(monkeypatch, tmp_path / "torch-home")
    install_lead_models(c.leadvocal_models)
    return c


def test_resolve_config_uses_image_owned_engine_paths(monkeypatch, tmp_path):
    monkeypatch.delenv("VOCALIS_STEMS_VENV", raising=False)
    monkeypatch.delenv("LEADVOCAL_VENV", raising=False)
    monkeypatch.delenv("LEADVOCAL_MODELS", raising=False)
    cfg = stemsplit.resolve_config({}, tmp_path, tmp_path / "output", tmp_path / "cache")
    assert cfg.venv == Path("/opt/vocalis/venvs/stems")
    assert cfg.python.parent == cfg.venv / ("Scripts" if stemsplit.os.name == "nt" else "bin")
    assert cfg.python.name == ("python.exe" if stemsplit.os.name == "nt" else "python")
    assert cfg.leadvocal_venv == stemsplit.DEFAULT_LEADVOCAL_VENV
    assert cfg.leadvocal_models == stemsplit.DEFAULT_LEADVOCAL_MODELS

    demucs = tmp_path / "demucs"
    lead = tmp_path / "lead"
    models = tmp_path / "models"
    monkeypatch.setenv("VOCALIS_STEMS_VENV", str(demucs))
    monkeypatch.setenv("LEADVOCAL_VENV", str(lead))
    monkeypatch.setenv("LEADVOCAL_MODELS", str(models))
    cfg = stemsplit.resolve_config({}, tmp_path, tmp_path / "output", tmp_path / "cache")
    assert cfg.venv == demucs
    assert cfg.leadvocal_venv == lead
    assert cfg.leadvocal_models == models


def _seed_song(cfg, name="My_Song.mp3", content=b"ID3song-bytes"):
    p = cfg.acestep_dir / name
    p.write_bytes(content)
    return p


@pytest.fixture
def fake_demucs(monkeypatch):
    """Fake the extracted Stems engine's child-process seam."""
    state = {"fail": False, "cancel": False, "calls": [], "cmds": []}

    def fake(job, cmd, env=None):
        marker = "ffmpeg" if cmd[0] == "ffmpeg" else "demucs"
        state["calls"].append(marker)
        state["cmds"].append([str(a) for a in cmd])
        if state["cancel"]:
            job.cancel.set()
            return -1
        if state["fail"]:
            job.last_line = "boom: demucs exploded"
            return 1
        if marker == "demucs":
            work = Path(cmd[cmd.index("-o") + 1])
            d = work / stems.DEMUCS_MODEL / Path(cmd[-1]).stem
            d.mkdir(parents=True, exist_ok=True)
            raw = (stems.DEMUCS_RAW["2stem"] if "--two-stems=vocals" in cmd
                   else stems.DEMUCS_RAW["4stem"])
            for s in raw:
                (d / s).write_bytes(b"RIFF" + s.encode())
        else:
            Path(cmd[-1]).write_bytes(b"RIFFsummed")     # the instrumental sum
        return 0

    monkeypatch.setattr(stem_engine, "_run_stage", fake)
    monkeypatch.setattr(stem_engine, "ffprobe_duration", lambda p: 4.2)
    return state


def _mk_job(cfg, song, mode="2stem", **kw):
    """`**kw` carries 8.4's `dereverb` / `dereverb_model` / `params`; the other two modes
    ignore all three."""
    return stemsplit.new_job(source_ref="acestep/" + song.name, song_name=song.stem,
                             mode=mode, device="cpu", h=stems.song_hash(song), **kw)


# ── the split job ────────────────────────────────────────────────────────────

def test_split_job_2stem(cfg, fake_demucs):
    song = _seed_song(cfg)
    job = _mk_job(cfg, song)
    stemsplit.run_split_job(job, cfg)
    assert job.status == "done" and job.error is None
    rows = stems.list_sets(cfg)
    assert len(rows) == 1 and rows[0]["ref"] == job.result_ref
    assert rows[0]["mode"] == "2stem" and rows[0]["source"] == "demucs"
    assert rows[0]["duration_s"] == 4.2 and rows[0]["swappable"] is True
    # Demucs's `no_vocals.wav` landed under OUR name — a user should never see theirs
    # 7.5.25: the store is Opus now. The identity is `stem`; `file` is how it is kept.
    assert {s["file"] for s in rows[0]["stems"]} == {"vocals.opus", "instrumental.opus"}
    assert {s["stem"] for s in rows[0]["stems"]} == {"vocals", "instrumental"}
    assert not (cfg.work_root / job.id).exists()               # workdir cleaned
    assert stems.find_by_hash(cfg, job.h).name == job.result_ref


def test_split_job_4stem_sums_the_instrumental(cfg, fake_demucs):
    """Demucs 4-stem emits no instrumental at all — so we make one (§5). Otherwise a
    4-stem set could not satisfy a swap, and "every set is swap-ready" would be false."""
    job = _mk_job(cfg, _seed_song(cfg), mode="4stem")
    stemsplit.run_split_job(job, cfg)
    assert job.status == "done"
    # split, the sum, then one Opus encode per stem (7.5.25)
    assert fake_demucs["calls"] == ["demucs"] + ["ffmpeg"] * 6
    row = stems.list_sets(cfg)[0]
    assert row["mode"] == "4stem" and row["swappable"] is True
    assert ({s["stem"] for s in row["stems"]}
            == {stems.stem_key(f) for f in stems.MODE_STEMS["4stem"]})
    assert [s["label"] for s in row["stems"]][0] == "Instrumental"   # display order


def test_a_4stem_split_extends_the_2stem_set_instead_of_forking_one(cfg, fake_demucs):
    """A set is keyed by song, so adding another mode extends the existing row."""
    song = _seed_song(cfg)
    stemsplit.run_split_job(_mk_job(cfg, song, "2stem"), cfg)
    two = stems.list_sets(cfg)
    assert len(two) == 1 and two[0]["mode"] == "2stem"

    stemsplit.run_split_job(_mk_job(cfg, song, "4stem"), cfg)
    four = stems.list_sets(cfg)
    assert len(four) == 1                                  # ← same folder, extended
    assert four[0]["ref"] == two[0]["ref"] and four[0]["mode"] == "4stem"


def test_split_job_failure_surfaces_last_line(cfg, fake_demucs):
    fake_demucs["fail"] = True
    job = _mk_job(cfg, _seed_song(cfg))
    stemsplit.run_split_job(job, cfg)
    assert job.status == "failed"
    assert "Demucs split failed" in job.error and "boom" in job.error
    assert stems.list_sets(cfg) == []
    assert not (cfg.work_root / job.id).exists()


def test_split_job_cancel_writes_nothing(cfg, fake_demucs):
    fake_demucs["cancel"] = True
    job = _mk_job(cfg, _seed_song(cfg))
    stemsplit.run_split_job(job, cfg)
    assert job.status == "canceled"
    assert stems.list_sets(cfg) == []           # commit() never ran — no half-set
    assert job.events[-1]["type"] == "canceled"


def test_split_job_missing_venv_fails_clearly(cfg, fake_demucs):
    cfg.python.unlink()
    job = _mk_job(cfg, _seed_song(cfg))
    stemsplit.run_split_job(job, cfg)
    assert job.status == "failed" and "VOCALIS_STEMS_VENV" in job.error


def test_live_h_guard(cfg):
    job = _mk_job(cfg, _seed_song(cfg))         # queued — never run
    assert stemsplit.live_h(job.h)
    job.status = "done"
    assert not stemsplit.live_h(job.h)


# ── "I already have clean stems" (§7) ────────────────────────────────────────

def test_upload_maps_names_to_slots(cfg):
    """A user exporting from a DAW should not have to learn our filenames — and
    Demucs's own `no_vocals` is understood too, because that's what a stem set
    downloaded from anywhere else will be called."""
    row = stemsplit.save_upload(cfg, "My Acapella", [
        ("Vocals.WAV", io.BytesIO(b"RIFFvox")),
        ("no_vocals.wav", io.BytesIO(b"RIFFinst")),
        ("readme.txt", io.BytesIO(b"junk")),           # not audio — ignored
    ])
    assert row["source"] == "uploaded" and row["swappable"] is True
    assert row["song"] == "My Acapella" and row["song_h"] is None    # it has no song
    assert {s["file"] for s in row["stems"]} == {"vocals.wav", "instrumental.wav"}
    d = stems.find_dir(cfg, row["ref"])
    assert (d / "instrumental.wav").read_bytes() == b"RIFFinst"


def test_upload_is_idempotent_on_identical_content(cfg):
    def up():
        return stemsplit.save_upload(cfg, "Set", [
            ("vocals.wav", io.BytesIO(b"RIFFvox")),
            ("instrumental.wav", io.BytesIO(b"RIFFinst"))])
    assert up()["ref"] == up()["ref"]                   # R4: content IS the identity
    assert len(stems.list_sets(cfg)) == 1


def test_upload_of_a_lone_instrumental_is_stored_but_not_swappable(cfg):
    row = stemsplit.save_upload(cfg, "Backing", [
        ("instrumental.wav", io.BytesIO(b"RIFFinst"))])
    assert row["swappable"] is False                    # grays out in the swap picker
    assert len(stems.list_sets(cfg)) == 1               # …but it IS kept


def test_upload_with_nothing_recognizable_says_so(cfg):
    with pytest.raises(ValueError, match="vocals.wav"):
        stemsplit.save_upload(cfg, "Junk", [("notes.txt", io.BytesIO(b"x"))])


# ── routes ───────────────────────────────────────────────────────────────────

@pytest.fixture
def route_cfg(monkeypatch, cfg, tmp_path):
    monkeypatch.setattr(rt_configs, "ss_cfg", lambda: cfg)
    monkeypatch.setattr(rt_configs, "song_cfg", lambda: song_library.SongConfig(
        songs_dir=cfg.songs_dir, acestep_dir=cfg.acestep_dir, acelib_dir=None,
        song_index=cfg.song_index))
    return cfg


def test_stems_start_validation(client, route_cfg):
    _seed_song(route_cfg, "job_1.mp3")

    def start(**over):
        body = {"song": "acestep/job_1.mp3", "mode": "2stem", "device": "cpu"}
        body.update(over)
        return client.post("/stems/start", json=body)
    assert start(song="acestep/missing.mp3").status_code == 400
    assert start(song="../etc/passwd").status_code == 400
    assert start(mode="3stem").status_code == 400
    assert start(device="cuda:x").status_code == 400


def test_start_serves_a_cached_set_but_a_richer_mode_still_runs(client, route_cfg,
                                                               fake_demucs):
    """"Cached" must mean the stored set already HOLDS what this mode promises. Keying
    it on the song alone would falsely report a 2-stem set as satisfying a 4-stem
    request, and the drums you asked for would never arrive."""
    song = _seed_song(route_cfg, "job_1.mp3")
    stemsplit.run_split_job(_mk_job(route_cfg, song, "2stem"), route_cfg)
    ref = stems.find_by_hash(route_cfg, stems.song_hash(song)).name

    r = client.post("/stems/start", json={"song": "acestep/job_1.mp3",
                                          "mode": "2stem", "device": "cpu"}).get_json()
    assert r == {"cached": True, "ref": ref}

    r = client.post("/stems/start", json={"song": "acestep/job_1.mp3",
                                          "mode": "4stem", "device": "cpu"}).get_json()
    assert "job_id" in r and "cached" not in r          # ← really runs


def test_stems_start_job_status_events_jobs(client, route_cfg, monkeypatch):
    _seed_song(route_cfg, "job_1.mp3")

    finished = threading.Event()

    def instant_job(job, cfg):
        job.status = "running"
        stemsplit.emit(job, {"type": "job_start", "id": job.id, "kind": "stemsplit"})
        job.result_ref = "fake_ref"
        job.status = "done"
        stemsplit.emit(job, {"type": "job_done", "ref": "fake_ref", "duration_s": 1.0})
        finished.set()          # the last thing the job does, so "done" and its events are visible
    monkeypatch.setattr(stemsplit, "run_split_job", instant_job)

    r = client.post("/stems/start", json={"song": "acestep/job_1.mp3",
                                          "mode": "4stem", "device": "cpu"}).get_json()
    jid = r["job_id"]
    assert finished.wait(60), "the route-started job never finished"
    st = client.get(f"/stems/status/{jid}").get_json()
    assert st["status"] == "done" and st["result"] == "fake_ref"
    assert st["mode"] == "4stem" and st["device"] == "cpu"
    evs = [json.loads(l[6:]) for l in
           client.get(f"/stems/events/{jid}").get_data(as_text=True).splitlines()
           if l.startswith("data: ")]
    assert evs[-1]["type"] == "job_done" and evs[-1]["ref"] == "fake_ref"
    jobs = client.get("/stems/jobs").get_json()
    assert any(j["id"] == jid and j["status"] == "done" for j in jobs)
    assert client.get("/stems/status/nope").status_code == 404
    assert client.post("/stems/cancel/" + jid).get_json()["ok"] is True


def test_library_lists_both_stores_with_provenance(client, route_cfg, fake_demucs):
    stemsplit.run_split_job(_mk_job(route_cfg, _seed_song(route_cfg)), route_cfg)
    stemsplit.save_upload(route_cfg, "Mine", [
        ("vocals.wav", io.BytesIO(b"RIFFv")),
        ("instrumental.wav", io.BytesIO(b"RIFFi"))])
    rows = client.get("/stems/library").get_json()
    assert {r["source"] for r in rows} == {"demucs", "uploaded"}
    uploaded = next(row for row in rows if row["source"] == "uploaded")
    generated = next(row for row in rows if row["source"] == "demucs")
    assert uploaded["song"] and uploaded["ref"] and uploaded["song_h"] is None
    assert generated["song"] and generated["ref"] and generated["song_h"] == generated["h"]


def test_library_rows_carry_their_virtual_folder(client, route_cfg, fake_demucs, tmp_path):
    """8.9 — the Stems library is the tenth and last folder scope.

    🔴 SCOPE `stems_library`, NOT `voiceswap_songs`, even though a brought-in set shows in
    Voice Swap ▸ Sources too. They are not the same DATASET: this route lists EVERY separation,
    ours and yours, as a SET; Sources lists only the `source == "uploaded"` subset, as one of five
    kinds of source, under a ref the client composes (`stems/<ref>`). §2's "duplicate data shares
    a scope" rule is about two views of one listing — see §14 of the design doc.

    ⚠️ AND AN UNFILED ROW MUST SAY `None`, not be missing the key: the client reads
    `row.folder` on every row and a missing key is indistinguishable from a route that forgot to
    stamp — which is exactly the 8.9.7 bug this whole scope was wired after."""
    stemsplit.run_split_job(_mk_job(route_cfg, _seed_song(route_cfg)), route_cfg)
    stemsplit.save_upload(route_cfg, "Mine", [
        ("vocals.wav", io.BytesIO(b"RIFFv")),
        ("instrumental.wav", io.BytesIO(b"RIFFi"))])

    rows = client.get("/stems/library").get_json()
    assert rows and all("folder" in r for r in rows), "every row is stamped, filed or not"
    assert all(r["folder"] is None for r in rows), "nothing is filed yet"

    made = client.post("/folders/stems_library", json={"name": "Keepers"}).get_json()
    ref = rows[0]["ref"]
    client.post("/folders/stems_library/assign", json={"refs": [ref], "folder": made["id"]})

    got = {r["ref"]: r["folder"] for r in client.get("/stems/library").get_json()}
    assert got[ref] == made["id"]
    assert all(v is None for k, v in got.items() if k != ref), "one row moved, not the list"

    # The OTHER scope is untouched — two listings, two sets of folders, by construction.
    assert client.get("/folders/voiceswap_songs").get_json()["assign"] == {}


def test_stem_audio_zip_and_delete_routes(client, route_cfg, fake_demucs):
    job = _mk_job(route_cfg, _seed_song(route_cfg), mode="4stem")
    stemsplit.run_split_job(job, route_cfg)
    ref = job.result_ref

    r = client.get(f"/stems/library/{ref}/vocals.wav/audio")
    assert r.status_code == 200 and r.data.startswith(b"RIFF")
    r.close()          # release the send_file handle — Windows blocks the delete below
    assert client.get(f"/stems/library/{ref}/stems.yaml/audio").status_code == 404
    assert client.get(f"/stems/library/{ref}/../../evil/audio").status_code in (207, 404, 308)

    # ⬇ All — the actual reason you asked for a 4-stem split
    z = client.get(f"/stems/library/{ref}/zip")
    assert z.status_code == 200
    import zipfile
    names = zipfile.ZipFile(io.BytesIO(z.data)).namelist()
    assert sorted(names) == sorted(f"{ref}/{stems.stem_key(s)}{stems.STEM_EXT}"
                                   for s in stems.MODE_STEMS["4stem"])
    assert client.get("/stems/library/nope/zip").status_code == 404

    d = client.delete("/stems/library", json={"refs": [ref, "bogus"]})
    assert d.get_json()["deleted"] == [ref]
    assert client.get(f"/stems/library/{ref}/vocals.wav/audio").status_code == 404


def test_upload_route(client, route_cfg):
    r = client.post("/stems/upload", data={
        "name": "Brought my own",
        "file": [(io.BytesIO(b"RIFFv"), "vocals.wav"),
                 (io.BytesIO(b"RIFFi"), "instrumental.wav")],
    }, content_type="multipart/form-data")
    assert r.status_code == 200
    row = r.get_json()
    assert row["source"] == "uploaded" and row["swappable"] is True
    assert client.post("/stems/upload", data={"name": "x"},
                       content_type="multipart/form-data").status_code == 400
    bad = client.post("/stems/upload", data={
        "name": "x", "file": (io.BytesIO(b"junk"), "notes.txt")},
        content_type="multipart/form-data")
    assert bad.status_code == 400 and "vocals.wav" in bad.get_json()["error"]


def test_delete_only_removes_the_selected_stem_set(client, route_cfg, fake_demucs):
    first = _seed_song(route_cfg, "first.mp3")
    second = _seed_song(route_cfg, "second.mp3", content=b"ID3second-song")
    first_job, second_job = _mk_job(route_cfg, first), _mk_job(route_cfg, second)
    stemsplit.run_split_job(first_job, route_cfg)
    stemsplit.run_split_job(second_job, route_cfg)

    response = client.delete("/stems/library", json={"refs": [first_job.result_ref]})
    assert response.get_json()["deleted"] == [first_job.result_ref]
    remaining = client.get("/stems/library").get_json()
    assert [row["ref"] for row in remaining] == [second_job.result_ref]


# ── 8.4 "Lead vocals only" (DESIGN_8_4_LEAD_VOCAL.md) ─────────────────────────────────────────
#
# The mode is a THIRD stem-split mode that does work AFTER Demucs: stage 1 harvests the vocal
# alone, then a second child in a second venv detects backing vocals, takes the reverb off, and
# `leadvocal.py` cuts the passages where the singer is alone into one `lead_solo.wav`.
#
# Everything below fakes the children and lets the real arithmetic run. Two seams are needed and
# that is not an accident of style — see `fake_lead`.

LEAD_SR = 16_000            # small enough that a 30 s fixture is 480k samples, i.e. instant
LEAD_DUR = 30.0


def _noise(n, amp, seed):
    """Deterministic "audio".

    Uniform noise rather than a tone on purpose: `leadvocal.align_dry` cross-correlates the
    de-reverbed file against the wet one and refuses it on a non-zero lag, and a periodic signal
    correlates just as well one period out — which would make the alignment guard's verdict a
    coin toss between runs."""
    return np.random.default_rng(seed).uniform(-amp, amp, int(n)).astype(np.float32)


@pytest.fixture
def fake_lead(monkeypatch):
    """The 8.4 chain's children, faked at `stemsplit._run_stage`, writing real WAVs.

    `stemsplit` binds its stage runner from `stem_engine`, while the shared separation helper
    uses the engine module directly. Patch both seams so this test never launches a subprocess.

    The fake writes what the COMMAND LINE asks for, so the "did we ask for de-reverb?" question
    is answered by the same object the child would have been handed. `backing` is the list of
    (start, end) seconds where somebody else is singing: the default leaves two solo passages
    either side of a stacked chorus, and `[(0, LEAD_DUR)]` is the song that is 100 % stacked.
    """
    # `wet_sr` is what the DECODE of the stored stem yields and `child_sr` is what the models
    # answer with. They are separate because on a re-run they really are: a stored stem is Opus,
    # Opus is a 48 kHz codec, and the karaoke model answers at its own rate whatever it was fed.
    state = {"backing": [(10.0, 20.0)], "cmds": [], "gate": None,
             "wet_sr": LEAD_SR, "child_sr": LEAD_SR,
             "at_detect": threading.Event()}

    def fake(job, cmd, env=None, cwd=None, timing=None):
        state["cmds"].append([str(a) for a in cmd])
        if str(cmd[0]) == "ffmpeg":
            if "-ar" in cmd:                             # the resample onto the vocal's rate
                want = int(cmd[cmd.index("-ar") + 1])
                x, got = leadvocal.read_wav(cmd[cmd.index("-i") + 1])
                m = max(1, int(round(len(x) * want / float(got))))
                # Linear resample: real enough that a length and a rate both come out right,
                # which is all the chain reads off it.
                leadvocal.write_wav(cmd[-1],
                                    np.interp(np.linspace(0, len(x) - 1, m),
                                              np.arange(len(x)), x).astype(np.float32), want)
                return 0
            sr = state["wet_sr"]                         # decode of the stored vocal stem
            leadvocal.write_wav(cmd[-1], _noise(int(sr * LEAD_DUR), 0.6, 8401), sr)
            return 0
        # A model READS the file it was handed and answers at its OWN rate — it does not
        # invent audio. Deriving the de-reverbed output from the actual input is what makes
        # `align_dry`'s cross-correlation meaningful here: an independently generated array
        # would correlate at a random lag and be refused for a reason the code never had.
        sr = state["child_sr"]
        src_x, src_sr = leadvocal.read_wav(cmd[cmd.index("-i") + 1])
        n = max(1, int(round(len(src_x) * sr / float(src_sr))))
        wet = (src_x if sr == src_sr else
               np.interp(np.linspace(0, len(src_x) - 1, n),
                         np.arange(len(src_x)), src_x).astype(np.float32))
        state["at_detect"].set()                         # the lock-release test waits here
        if state["gate"] is not None:
            state["gate"].wait(30)
        if "--karaoke-out" in cmd:
            backing = np.zeros(n, dtype=np.float32)
            for i, (a, b) in enumerate(state["backing"]):
                lo, hi = int(a * sr), int(b * sr)
                backing[lo:hi] = _noise(hi - lo, 0.5, 8402 + i)
            leadvocal.write_wav(cmd[cmd.index("--karaoke-out") + 1], backing, sr)
        if "--dereverb-out" in cmd:
            # Sample-aligned and the same length, which is what `align_dry` demands before it
            # will let the cut land on the dry file.
            leadvocal.write_wav(cmd[cmd.index("--dereverb-out") + 1], wet * 0.9, sr)
        return 0

    monkeypatch.setattr(stemsplit, "_run_stage", fake)
    return state



def test_a_stored_stem_decodes_at_a_different_rate_and_the_chain_still_cuts(cfg, fake_demucs,
                                                                           fake_lead):
    """🔴 THE SECOND RUN OF A SONG USED TO FAIL, AND IT IS THE DOCUMENTED PATH.

    Found by the first live end-to-end run, not by this suite — because the suite and the FIRST
    live run both took the lucky path. A fresh split hands `_run_lead` the WAV Demucs just wrote,
    at 44.1 kHz, and the karaoke model answers at 44.1 kHz, so the frame-by-frame envelope
    comparison lined up by accident.

    On a RE-RUN the vocal comes out of the STORE, where a stem is Opus since 7.5.25 — and Opus is
    a 48 kHz codec, so it decodes at 48000 whatever went in while the model still answers 44100.
    The guard refused to cut, which was right and useless: that re-run is §4b's entire argument
    for making de-reverb unconditional ("costs the detector and the cut and no Demucs at all"),
    and it is every one of m2's *Extract lead vocal* runs over the songs already in the library.

    So the child's outputs are brought onto the vocal's rate rather than left to agree by luck."""
    fake_lead["wet_sr"] = 48_000            # what decoding a stored `vocals.opus` gives you
    fake_lead["child_sr"] = LEAD_SR         # what the models answer with
    job = _mk_job(cfg, _seed_song(cfg), mode="lead")
    stemsplit.run_split_job(job, cfg)

    assert job.status == "done", job.error
    d = stems.find_dir(cfg, job.result_ref)
    assert stems.has_lead(d), "the lead was not written on a re-run-shaped rate mismatch"
    block = stems.read_meta(d)["lead"]
    assert block["spans"] > 0 and block["kept_sec"] > 0
    # …and it got there by RESAMPLING, not by the fallback quietly dropping the de-reverb.
    assert any("-ar" in c for c in fake_lead["cmds"]), "nothing was resampled"
    assert block["dereverb"], "the de-reverbed audio was thrown away instead of resampled"
    assert not block.get("dereverb_skipped")

# ── stage 1: the `vocals` harvest (§6.4) ─────────────────────────────────────

def test_the_vocals_harvest_commits_the_vocal_and_drops_the_instrumental(cfg, fake_demucs):
    """The vocals-only path commits the vocal stem and does not retain the instrumental output."""
    song = _seed_song(cfg)
    job = _mk_job(cfg, song, mode="lead")
    src = song_library.resolve_song(cfg, job.source_ref)
    work = cfg.work_root / job.id
    vocals, inst, ref = stem_engine.get_stems(job, cfg, src, "vocals", work)

    demucs = fake_demucs["cmds"][0]
    assert "--two-stems=vocals" in demucs                 # the same child as a 2-stem split
    raw = (Path(demucs[demucs.index("-o") + 1]) / stems.DEMUCS_MODEL
           / Path(demucs[-1]).stem)
    assert (raw / stems.LEGACY_INSTRUMENTAL).is_file(), \
        "the fixture never produced an instrumental, so dropping one proves nothing"

    d = stems.find_dir(cfg, ref)
    assert [p.name for p in stems.stem_files(d)] == ["vocals.opus"]
    assert stems.find_stem(d, "instrumental") is None
    assert stems.has_base(d) is False and stems.mode_of(d) == "vocals"
    assert inst is None and vocals is not None and Path(vocals).exists()


def test_the_harvest_adds_to_a_set_and_never_deletes_from_it(cfg, fake_demucs):
    """🔴 §6 R4 — "THIS MODE ADDS; IT NEVER DELETES", and the distinction is between what THIS
    RUN made and what the SET already had.

    A stem set belongs to the SONG and is shared with Voice Swap, so removing a stem another
    tab's cache leans on would be the 4.0-m3 mistake wearing a new face. Here the set already
    holds an instrumental and no vocal, so the harvest genuinely runs Demucs — and `commit()`
    extends the folder rather than replacing it, exactly as a 4-stem split extends a 2-stem
    one."""
    song = _seed_song(cfg)
    h = stems.song_hash(song)
    d = cfg.stems_dir / stems.set_ref(song.stem, h)
    d.mkdir(parents=True)
    kept = b"RIFF-the-instrumental-that-was-already-here"
    (d / "instrumental.wav").write_bytes(kept)
    stems.write_meta(d, {"h": h, "song": song.stem, "song_h": h, "source": "demucs",
                         "created": "2026-08-01T00:00:00"})

    job = _mk_job(cfg, song, mode="lead")
    src = song_library.resolve_song(cfg, job.source_ref)
    _v, _i, ref = stem_engine.get_stems(job, cfg, src, "vocals", cfg.work_root / job.id)

    assert stems.find_dir(cfg, ref) == d                       # extended, not forked
    assert (d / "instrumental.wav").read_bytes() == kept       # untouched, byte for byte
    assert stems.find_stem(d, "vocals") is not None
    assert stems.has_base(d) is True and stems.mode_of(d) == "2stem"
    assert len(stems.list_sets(cfg)) == 1


def test_a_lead_extraction_leaves_an_existing_2stem_set_intact(cfg, fake_demucs, fake_lead):
    """The same rule from the user's side: split a song, then extract its lead. The
    instrumental is still there afterward — and stage 1 is a STORE HIT, so no second Demucs
    pass is spent finding a vocal that is already in the folder."""
    song = _seed_song(cfg)
    stemsplit.run_split_job(_mk_job(cfg, song, "2stem"), cfg)
    d = stems.find_by_hash(cfg, stems.song_hash(song))
    before = stems.find_stem(d, "instrumental")
    kept = before.read_bytes()

    job = _mk_job(cfg, song, mode="lead")
    stemsplit.run_split_job(job, cfg)

    assert job.status == "done", job.error
    assert fake_demucs["calls"].count("demucs") == 1, "stage 1 re-ran Demucs over a stored set"
    assert stems.find_stem(d, "instrumental") == before
    assert before.read_bytes() == kept
    assert stems.has_base(d) and stems.mode_of(d) == "2stem"
    assert stems.has_lead(d) and len(stems.list_sets(cfg)) == 1


def test_a_later_2stem_split_does_not_erase_the_lead_block(cfg, fake_demucs, fake_lead):
    """🔴 A REAL, SILENT DATA-LOSS PATH — `commit()` WRITES A FRESH SIDECAR.

    Extract a lead, then swap the song. The swap's stage 1 runs a 2-stem split to get the
    instrumental the set never had, and `get_stems` builds `meta` from scratch — so every key
    it does not name is erased. `lead_solo.wav` would still be sitting in the folder with
    nothing left saying which stem it was cut from, by which detector, or whether it was
    de-reverbed. §4b's rule that a singer's dataset must never mix wet and dry material is only
    checkable while that block survives, and nothing about the loss is visible at the time.

    So `get_stems` carries `lead:` forward explicitly, and this is the test that fails if that
    carry-forward is ever removed."""
    song = _seed_song(cfg)
    stemsplit.run_split_job(_mk_job(cfg, song, mode="lead"), cfg)
    d = stems.find_by_hash(cfg, stems.song_hash(song))
    block = stems.read_meta(d)["lead"]
    assert block["spans"] == 2 and block["detector"]

    later = _mk_job(cfg, song, mode="2stem")
    stemsplit.run_split_job(later, cfg)
    assert later.status == "done", later.error

    meta = stems.read_meta(d)
    assert meta.get("lead") == block, "the fresh sidecar dropped the lead block"
    assert meta["source"] == "demucs" and meta["h"] == stems.song_hash(song)
    assert stems.has_lead(d) and stems.find_stem(d, "instrumental") is not None
    assert stems.row(d)["lead"] == block


# ── stages 2-5: the cut ──────────────────────────────────────────────────────

def test_the_lead_job_end_to_end(cfg, fake_demucs, fake_lead):
    """The whole mode with both children faked: split, decode, detect, de-reverb, cut, commit.

    The fixture song is 30 s with one stacked passage from 0:10 to 0:20, so the honest answer
    is two solo spans of ~9.5 s each, eroded by `guard_sec` at every edge. Everything asserted
    here is something the UI or a trainer actually reads: the two files on disk, the provenance
    block behind the widget's coverage line, the spans sidecar that makes a bad detection
    reviewable, and the row the Stems tab draws."""
    song = _seed_song(cfg)
    job = _mk_job(cfg, song, mode="lead")
    stemsplit.run_split_job(job, cfg)

    assert job.status == "done" and job.error is None
    d = stems.find_dir(cfg, job.result_ref)
    assert (d / stems.LEAD_SOLO).is_file() and (d / stems.LEAD_SPANS).is_file()

    # The child was asked for both separations, on the CPU, with the models 8.4 names.
    detect = fake_lead["cmds"][-1]
    assert detect[0] == str(cfg.leadvocal_python) and detect[1] == str(cfg.leadvocal_detect)
    assert detect[detect.index("--device") + 1] == "cpu"
    assert detect[detect.index("--karaoke-model") + 1] == leadvocal.KARAOKE_MODEL
    assert detect[detect.index("--dereverb-model") + 1] == leadvocal.DEREVERB_DEFAULT
    assert detect[detect.index("--model-dir") + 1] == str(cfg.leadvocal_models)

    block = stems.read_meta(d)["lead"]
    assert block["detector"] == "UVR_MDXNET_KARA_2"        # the model, minus its extension
    assert block["device"] == "cpu"
    assert block["dereverb"] == leadvocal.DEREVERB_DEFAULT
    assert "dereverb_skipped" not in block                 # it aligned, so it was used
    assert block["spans"] == 2 and block["thin"] is False
    # 19.38, not 18.98: 8.6.6 stopped eroding the song's own first and last moments, so
    # 0.4 s of singing that used to be discarded against nothing is now kept. `source_sec`
    # is unchanged, which is the check that the SOURCE was not re-measured.
    assert block["source_sec"] == 30.0 and block["kept_sec"] == 19.38
    assert block["params"]["backing_enter_db"] == -30.0

    # ⚠️ The span LIST is missing from this file — that is a real defect, reported and pinned
    # in `test_the_spans_sidecar_must_describe_where_the_cuts_were` below. What IS in it agrees
    # with the sidecar, which is the part that can be asserted today.
    spans = json.loads((d / stems.LEAD_SPANS).read_text(encoding="utf-8"))
    assert spans["kept_sec"] == block["kept_sec"] and spans["detector"] == block["detector"]
    assert spans["dereverb"] == block["dereverb"] and spans["params"] == block["params"]
    assert spans["thin"] is False and spans["source_sec"] == 30.0

    # 🔴 THE AUDIO ON DISK, NOT JUST THE ARITHMETIC ABOUT IT: two spans joined with one
    # `silence_sec` gap between them. RVC slices a dataset at silence, so that gap is how the
    # joined clip trains as the two clean takes it contains.
    cut, sr = leadvocal.read_wav(d / stems.LEAD_SOLO)
    assert sr == LEAD_SR
    assert round(len(cut) / sr, 2) == round(block["kept_sec"]
                                            + leadvocal.LeadParams().silence_sec, 2)
    assert float(np.abs(cut).max()) > 0.5                  # …and it is not a file of silence

    row = stems.row(d)
    assert row["lead"] == block
    assert [s["stem"] for s in row["stems"]] == ["lead_solo", "vocals"]   # the lead leads
    assert row["stems"][0]["derived"] is True and row["stems"][0]["size"] > 0
    assert row["mode"] == "vocals" and row["swappable"] is False
    assert job.events[-1]["type"] == "job_done"
    assert not (cfg.work_root / job.id).exists()           # scratch swept: no wet/backing/dry


#: `spans_json()` must retain the span list. The dict literal
#: set "spans" to the list of cuts and then unpacked `**summarize(...)` LAST, and `summarize`
#: returns its own "spans" key holding the COUNT — so the count overwrote the list and
#: `lead_spans.json` shipped as `"spans": 2`. The file whose entire purpose is making a bad
#: detection reviewable contained no timestamps at all. Fixed by unpacking `summarize` FIRST
#: and letting the list win.
def test_the_spans_sidecar_must_describe_where_the_cuts_were(cfg, fake_demucs, fake_lead):
    """🔴 §6 · §9.4 — `lead_spans.json` IS THE PROVENANCE, AND PROVENANCE WITHOUT
    TIMESTAMPS IS NOTHING.

    It exists so a bad detection is reviewable instead of mysterious: the design's answer to
    "why did this song only give me eleven seconds?" is to open this file, see the spans the
    detector chose, and re-run with a different `backing_enter_db`. It also rides along in
    ⬇ All precisely so a trainer months later can check §4b's "never mix wet and dry
    material in one singer's dataset" against the audio beside it.

    A count answers none of that — the `lead:` block in the sidecar already carries the count.
    So the contract is the LIST, written here as the contract rather than as the behavior, and
    marked xfail(strict) so it turns red the moment the source is fixed."""
    job = _mk_job(cfg, _seed_song(cfg), mode="lead")
    stemsplit.run_split_job(job, cfg)
    assert job.status == "done", job.error

    d = stems.find_dir(cfg, job.result_ref)
    spans = json.loads((d / stems.LEAD_SPANS).read_text(encoding="utf-8"))
    assert isinstance(spans["spans"], list),         f"lead_spans.json carries no timestamps at all: spans={spans['spans']!r}"
    # 8.6.6 — the first span starts at the SONG'S START, which is no longer eroded: the
    # guard keeps a harmony out and there is no harmony before the first sample. The
    # second span is interior and still carries its 0.2 s guard, which is the half of
    # this assertion that must not move.
    assert [s["start"] for s in spans["spans"]] == [0.0, 20.2]
    # The LAST span runs to the end of the analyzed signal, so 8.6.6 does not erode it —
    # 0.2 s of singing that used to be thrown away against nothing. The first span's end
    # is interior and unchanged at 9.688, which is the guard still doing its job.
    assert [s["end"] for s in spans["spans"]] == [9.688, 29.888]
    assert [s["dur"] for s in spans["spans"]] == [9.688, 9.688]
    assert stems.read_meta(d)["lead"]["spans"] == len(spans["spans"])


def test_swap_lock_is_released_before_the_cpu_only_stages(cfg, fake_demucs, fake_lead):
    """🔴 §9.2 — THE ONE CONCURRENCY CLAIM 8.4 MAKES, AND IT IS MEASURED RATHER THAN READ.

    The Stems lock covers GPU separation. The remaining lead stages are CPU-only, so keeping
    that lock through them would block unrelated GPU work without protecting a shared resource.

    So: run the job with the detector wedged on an event this test owns, and ask for the lock
    from the outside while it is "running". If the release ever moves back to the end of the
    job this goes red, which is the only way that regression would ever be noticed — the
    feature would still work perfectly, just alone."""
    gate = threading.Event()
    fake_lead["gate"] = gate
    job = _mk_job(cfg, _seed_song(cfg), mode="lead")
    t = threading.Thread(target=stemsplit.run_split_job, args=(job, cfg), daemon=True)
    free = False
    t.start()
    try:
        assert fake_lead["at_detect"].wait(60), "the detector stage never started"
        free = stem_engine.STEMS_LOCK.acquire(blocking=False)
        if free:
            stem_engine.STEMS_LOCK.release()
    finally:
        gate.set()
        t.join(60)

    assert not t.is_alive()
    assert free, "the Stems GPU lock was still held while the CPU-only detector ran"
    assert job.status == "done", job.error
    assert stems.has_lead(stems.find_dir(cfg, job.result_ref))
    assert stem_engine.STEMS_LOCK.acquire(blocking=False)  # …and it is free again at the end
    stem_engine.STEMS_LOCK.release()


def test_dereverb_false_skips_the_stage_and_the_set_records_it(cfg, fake_demucs, fake_lead):
    """When dereverb is disabled, the stage is skipped and the sidecar records that choice."""
    job = _mk_job(cfg, _seed_song(cfg), mode="lead", dereverb=False)
    stemsplit.run_split_job(job, cfg)
    assert job.status == "done", job.error

    detect = fake_lead["cmds"][-1]
    assert "--karaoke-out" in detect                       # the detector still runs…
    assert "--dereverb-out" not in detect and "--dereverb-model" not in detect

    d = stems.find_dir(cfg, job.result_ref)
    block = stems.read_meta(d)["lead"]
    assert block["dereverb"] is False and block["params"]["dereverb"] is False
    assert "dereverb_skipped" not in block                 # not skipped — never asked for
    assert block["spans"] == 2 and stems.has_lead(d)       # …and the cut still happened


def test_no_spans_is_a_success_and_takes_a_stale_lead_with_it(cfg, fake_demucs, fake_lead):
    """🔴 §9.5 — "THIS SONG IS UNUSABLE FOR TRAINING" IS A REAL ANSWER AND MUST NOT LOOK LIKE A
    CRASH. It must not look like a success with a playable file either: a zero-length WAV is a
    pill that plays nothing.

    And the re-run case is where the silent damage lives. The first pass wrote a good
    `lead_solo.wav`; the second finds no solo passages at all. If the stale file were left
    behind, the sidecar would describe a cut that has nothing to do with the audio sitting next
    to it — 0 spans and 0 seconds kept, beside a 19-second file — and there is no way to notice
    that by looking at the row."""
    song = _seed_song(cfg)
    stemsplit.run_split_job(_mk_job(cfg, song, mode="lead"), cfg)
    d = stems.find_by_hash(cfg, stems.song_hash(song))
    assert stems.has_lead(d) and stems.read_meta(d)["lead"]["spans"] == 2

    fake_lead["backing"] = [(0.0, LEAD_DUR)]               # she is never alone on this one
    again = _mk_job(cfg, song, mode="lead")
    stemsplit.run_split_job(again, cfg)

    assert again.status == "done" and again.error is None
    block = stems.read_meta(d)["lead"]
    assert block["spans"] == 0 and block["kept_sec"] == 0.0 and block["thin"] is True
    assert stems.find_stem(d, "lead_solo") is None
    assert not (d / stems.LEAD_SOLO).exists(), "the stale lead outlived the block describing it"
    assert (d / stems.LEAD_SPANS).is_file()                # the provenance still lands
    row = stems.row(d)
    assert row["lead"]["thin"] is True
    assert not any(s["stem"] == "lead_solo" for s in row["stems"])
    assert any("No passages" in e.get("line", "") for e in again.events if e["type"] == "log")


def test_the_lead_job_names_its_missing_environment(cfg, fake_demucs, fake_lead):
    """A missing interpreter is named as a broken image (the environment ships in it), rather than
    surfacing as a FileNotFoundError from a subprocess spawn or naming a setup script the Docker
    edition does not have.

    The vocal stage 1 harvested is still in the store afterward — the mode adds, and a failure
    in stages 2-5 does not un-commit stage 1."""
    cfg.leadvocal_detect.unlink()
    job = _mk_job(cfg, _seed_song(cfg), mode="lead")
    stemsplit.run_split_job(job, cfg)

    assert job.status == "failed"
    assert "lead-vocal environment is missing from this image" in job.error
    assert "setup.sh" not in job.error
    # The error is shown to the user: no server path in it (the path is logged instead).
    assert str(cfg.leadvocal_python) not in job.error
    d = stems.find_by_hash(cfg, job.h)
    assert d is not None and stems.has_lead(d) is False
    assert stems.find_stem(d, "vocals") is not None


# ── the /stems routes ────────────────────────────────────────────────────────

def _stub_runner(monkeypatch) -> list:
    """Start a job through the route without running it — the engine is covered above, and a
    real `lead` run from here would want the 8.4 venv. Marks it done so `_drain_ss_jobs` has
    nothing to wait out."""
    started = []

    def stub(job, cfg):
        started.append(job)
        job.status = "done"

    monkeypatch.setattr(stemsplit, "run_split_job", stub)
    return started


def test_stems_start_takes_lead_and_still_refuses_the_internal_harvest(client, route_cfg,
                                                                      monkeypatch):
    """`SPLIT_MODES` is deliberately NOT `stems.MODE_STEMS`, and the difference is a live
    hazard rather than a tidiness point: since 8.4 that table also holds `vocals`, the internal
    mode the lead chain runs its stage 1 in. Validating against it would let a request name
    `vocals` and quietly produce a baseless, unswappable set nobody asked for."""
    _seed_song(route_cfg, "job_1.mp3")
    _stub_runner(monkeypatch)

    def start(mode):
        return client.post("/stems/start", json={"song": "acestep/job_1.mp3",
                                                 "mode": mode, "device": "cpu"})

    assert "job_id" in start("lead").get_json()
    assert "job_id" in start("4stem").get_json()
    bad = start("vocals")
    assert bad.status_code == 400
    assert "'2stem', '4stem' or 'lead'" in bad.get_json()["error"]
    assert start("3stem").status_code == 400


def test_a_lead_request_is_never_reported_cached(client, route_cfg, fake_demucs, monkeypatch):
    """🔴 §6 R3 — RE-RUNNING IS THE DOCUMENTED ESCAPE HATCH, SO IT CANNOT BE SHORT-CIRCUITED.

    "Cached" everywhere else means the stored set already holds what this mode promises, and
    that is right for Demucs: the stems do not change. The lead does — it is the product of a
    detector and a de-reverb model, and the design's answer to "the first one came back dull"
    is precisely *clear the box and press Split again*. A cached reply would make that
    unreachable from the UI, on the one mode whose output is a judgment call.

    Cheap, too: stage 1 is a store hit so no Demucs runs, and the set's identity is the SONG's,
    so the file is overwritten in place rather than forking a second set."""
    song = _seed_song(route_cfg, "job_1.mp3")
    stemsplit.run_split_job(_mk_job(route_cfg, song, "2stem"), route_cfg)
    d = stems.find_by_hash(route_cfg, stems.song_hash(song))
    (d / stems.LEAD_SOLO).write_bytes(b"RIFF-a-lead-from-an-earlier-run")
    assert stems.has_lead(d)

    _stub_runner(monkeypatch)
    lead = client.post("/stems/start", json={"song": "acestep/job_1.mp3",
                                             "mode": "lead", "device": "cpu"}).get_json()
    assert "cached" not in lead and "job_id" in lead
    # …and the contrast is the MODE, not the set: the same set still answers 2stem from cache.
    two = client.post("/stems/start", json={"song": "acestep/job_1.mp3",
                                            "mode": "2stem", "device": "cpu"}).get_json()
    assert two == {"cached": True, "ref": d.name}


def test_the_lead_knobs_reach_the_job_and_status_reports_them(client, route_cfg, monkeypatch):
    """The de-reverb switch has to survive a page reload, which is what `/stems/status` giving
    it back is for: a reloading page restores the tickbox to what the RUNNING job was actually
    given, not to the checkbox's default.

    `params` is re-checked downstream — `leadvocal.params_from` clamps every threshold and
    `dereverb_model` is an allowlist — but a value that is not an object at all is dropped
    here, because everything below assumes a mapping."""
    _seed_song(route_cfg, "job_1.mp3")
    started = _stub_runner(monkeypatch)

    r = client.post("/stems/start", json={
        "song": "acestep/job_1.mp3", "mode": "lead", "device": "cpu",
        "dereverb": False, "dereverb_model": leadvocal.DEREVERB_MODELS[1],
        "params": {"backing_enter_db": -24}}).get_json()
    job = started[-1]
    assert job.mode == "lead" and job.dereverb is False
    assert job.dereverb_model == leadvocal.DEREVERB_MODELS[1]
    assert job.params == {"backing_enter_db": -24}
    st = client.get(f"/stems/status/{r['job_id']}").get_json()
    assert st["mode"] == "lead" and st["dereverb"] is False and st["device"] == "cpu"

    client.post("/stems/start", json={"song": "acestep/job_1.mp3", "mode": "lead",
                                      "device": "cpu", "params": "backing_enter_db=-24"})
    assert started[-1].dereverb is True and started[-1].params == {}
    assert started[-1].dereverb_model == ""
    assert client.get(f"/stems/status/{started[-1].id}").get_json()["dereverb"] is True


def test_a_lead_request_on_an_already_split_song_does_not_demand_a_gpu(client, route_cfg,
                                                                      fake_demucs, monkeypatch):
    """🔴 8.4 MOVED `auto` DEVICE RESOLUTION BELOW THE STORE LOOKUP, AND THE REFUSAL IS WHY.

    `auto_device` refuses rather than silently dropping to the CPU when cards exist but none is
    ticked for Stems — correct for Demucs, which would otherwise crawl for twenty minutes with
    nothing naming the setting responsible. But a lead extraction on an already-split song runs
    NO Demucs (stage 1 is a store hit) and everything after it is CPU by construction, so the
    old ordering refused a job for want of a card it was never going to use.

    The store lookup is the first line at which "will Demucs actually run?" has an answer, so
    that is where the question is now asked."""
    song = _seed_song(route_cfg, "job_1.mp3")
    stemsplit.run_split_job(_mk_job(route_cfg, song, "2stem"), route_cfg)
    monkeypatch.setattr(rt_pool, "auto_device",
                        lambda sub: (None, "No card is allowed to run “Voice Studio → Stems”."))
    started = _stub_runner(monkeypatch)

    r = client.post("/stems/start", json={"song": "acestep/job_1.mp3",
                                          "mode": "lead", "device": "auto"})
    assert r.status_code == 200, r.get_json()
    assert started[-1].device == "cpu"
    assert client.get(f"/stems/status/{started[-1].id}").get_json()["device"] == "cpu"

    # …and the refusal still stands wherever Demucs really would run: a richer mode over the
    # same set, and a lead over a song that has never been split at all.
    rich = client.post("/stems/start", json={"song": "acestep/job_1.mp3",
                                             "mode": "4stem", "device": "auto"})
    assert rich.status_code == 400 and "No card" in rich.get_json()["error"]

    _seed_song(route_cfg, "job_2.mp3", content=b"ID3a-different-song")
    fresh = client.post("/stems/start", json={"song": "acestep/job_2.mp3",
                                              "mode": "lead", "device": "auto"})
    assert fresh.status_code == 400 and "No card" in fresh.get_json()["error"]


# ── model files must already be on disk: nothing is downloaded, nothing is spawned ─────────────
# Demucs and audio-separator both DOWNLOAD absent weights on first use. This edition must never
# fetch a model at run time (setup downloads them since October 11, 2026), so a
# job whose weights are missing has to fail BEFORE its child exists. The fakes above are the
# spawn seam: an empty `calls` / `cmds` list is the proof that no process was started.

DEMUCS_MISSING = ("Stems needs the HTDemucs model (955717e8-8726e21a.th), which has not been "
                  "downloaded yet. Run setup again to fetch it; on Windows that is Start menu > Repair setup.")


def _no_popen(monkeypatch):
    """A real spawn from either module is a failure on its own, whatever the fakes recorded."""
    def forbidden(*args, **kwargs):
        raise AssertionError(f"a child process was spawned: {args[:1]}")
    monkeypatch.setattr(stem_engine.subprocess, "Popen", forbidden)


def test_missing_demucs_weights_fail_the_job_and_spawn_nothing(cfg, fake_demucs, monkeypatch,
                                                              tmp_path):
    """Removing the stand-in weight is the whole difference from `test_split_job_2stem`."""
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "no-weights-here"))
    _no_popen(monkeypatch)
    song = _seed_song(cfg)
    job = _mk_job(cfg, song)
    stemsplit.run_split_job(job, cfg)

    assert job.status == "failed"
    assert job.error == DEMUCS_MISSING
    assert fake_demucs["calls"] == [], "a child was started for a model that is not installed"
    assert any(e["type"] == "error" and e["message"] == DEMUCS_MISSING for e in job.events)
    assert stems.find_by_hash(cfg, job.h) is None, "a set was committed anyway"
    assert not (cfg.work_root / job.id).exists(), "the song's scratch copy outlived the job"


def test_missing_demucs_weights_fail_a_lead_job_before_the_lead_chain_starts(
        cfg, fake_demucs, fake_lead, monkeypatch, tmp_path):
    """A lead extraction on a never-split song needs Demucs first; it must stop there."""
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "no-weights-here"))
    job = _mk_job(cfg, _seed_song(cfg), mode="lead")
    stemsplit.run_split_job(job, cfg)

    assert job.status == "failed" and job.error == DEMUCS_MISSING
    assert fake_demucs["calls"] == [] and fake_lead["cmds"] == []


def test_present_demucs_weights_let_the_spawn_proceed(cfg, fake_demucs, monkeypatch):
    """With the weights where torch.hub reads them, behavior is exactly what it was before."""
    seen = {}
    real = stem_engine._run_stage

    def spy(job, cmd, env=None):
        if "demucs_worker.py" in " ".join(str(a) for a in cmd):
            seen["torch_home"] = (env or {}).get("TORCH_HOME")
        return real(job, cmd, env)

    monkeypatch.setattr(stem_engine, "_run_stage", spy)
    job = _mk_job(cfg, _seed_song(cfg))
    stemsplit.run_split_job(job, cfg)

    assert job.status == "done", job.error
    assert "demucs" in fake_demucs["calls"]
    assert seen["torch_home"], "the child was not handed the TORCH_HOME that was checked"


def test_the_setup_models_folder_is_the_demucs_childs_torch_home(cfg, fake_demucs, monkeypatch, tmp_path):
    """October 11, 2026: with VOCALIS_STEMS_MODEL_ROOT set (the packaged image), the weights setup
    downloaded there are the ones checked AND the ones the child reads: the spawn is handed
    TORCH_HOME=<that folder>, whatever the process's own TORCH_HOME says."""
    root = tmp_path / "models" / "stems"
    weight = stems.demucs_weight_path({"TORCH_HOME": str(root)})
    weight.parent.mkdir(parents=True)
    weight.write_bytes(b"")
    monkeypatch.setenv(stems.STEMS_MODEL_ROOT_VARIABLE, str(root))
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "runtime-cache-torch"))      # no weights there
    seen = {}
    real = stem_engine._run_stage

    def spy(job, cmd, env=None):
        if "demucs_worker.py" in " ".join(str(a) for a in cmd):
            seen["torch_home"] = (env or {}).get("TORCH_HOME")
        return real(job, cmd, env)

    monkeypatch.setattr(stem_engine, "_run_stage", spy)
    job = _mk_job(cfg, _seed_song(cfg))
    stemsplit.run_split_job(job, cfg)

    assert job.status == "done", job.error
    assert seen["torch_home"] == str(root)


def test_missing_weights_in_the_setup_models_folder_fail_even_if_the_runtime_cache_has_them(
        cfg, fake_demucs, monkeypatch, tmp_path):
    """The folder that is checked is the child's folder, not the parent's: a stand-in weight in the
    parent's TORCH_HOME must not satisfy the check when the child will look in the models folder."""
    cache = tmp_path / "runtime-cache-torch"
    stale = stems.demucs_weight_path({"TORCH_HOME": str(cache)})
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"")
    monkeypatch.setenv("TORCH_HOME", str(cache))
    monkeypatch.setenv(stems.STEMS_MODEL_ROOT_VARIABLE, str(tmp_path / "models" / "stems"))
    _no_popen(monkeypatch)
    job = _mk_job(cfg, _seed_song(cfg))
    stemsplit.run_split_job(job, cfg)

    assert job.status == "failed" and job.error == DEMUCS_MISSING
    assert fake_demucs["calls"] == []


def test_missing_lead_models_fail_the_job_before_any_child_starts(cfg, fake_demucs, fake_lead):
    """Stage 1 is a store hit on the second run, so the ONLY thing between the job and a child
    is the model check: not even the ffmpeg decode may start."""
    song = _seed_song(cfg)
    first = _mk_job(cfg, song, mode="lead")
    stemsplit.run_split_job(first, cfg)
    assert first.status == "done", first.error

    (cfg.leadvocal_models / leadvocal.KARAOKE_MODEL).unlink()
    started_before = (list(fake_demucs["calls"]), list(fake_lead["cmds"]))
    job = _mk_job(cfg, song, mode="lead")
    stemsplit.run_split_job(job, cfg)

    assert job.status == "failed"
    assert leadvocal.KARAOKE_MODEL in job.error
    assert "have not been downloaded yet" in job.error and "Run setup again" in job.error
    assert (list(fake_demucs["calls"]), list(fake_lead["cmds"])) == started_before, (
        "a child was started although a model file is missing")


def test_the_dereverb_model_is_only_required_when_the_job_asks_for_it(cfg, fake_demucs, fake_lead):
    song = _seed_song(cfg)
    stemsplit.run_split_job(_mk_job(cfg, song, mode="lead"), cfg)
    (cfg.leadvocal_models / leadvocal.DEREVERB_DEFAULT).unlink()

    without = _mk_job(cfg, song, mode="lead", dereverb=False)
    stemsplit.run_split_job(without, cfg)
    assert without.status == "done", without.error

    sent = len(fake_lead["cmds"])
    asked = _mk_job(cfg, song, mode="lead", dereverb=True)
    stemsplit.run_split_job(asked, cfg)
    assert asked.status == "failed" and leadvocal.DEREVERB_DEFAULT in asked.error
    assert len(fake_lead["cmds"]) == sent, "a child was started for a de-reverb model that is absent"

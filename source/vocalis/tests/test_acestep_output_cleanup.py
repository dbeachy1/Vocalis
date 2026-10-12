"""The ACE-Step engine's output folder is emptied of songs nothing refers to any more.

The engine writes every generated song into `<stage root>/api_audio/` and has no delete call.
Discarding a candidate used to remove only its record, so the files piled up for good. A song's
file is read again only through its candidate record (the tray's player and Save), so the rule
under test is: delete a file the moment no remembered candidate, no undo-bin record and no live
job refers to it, and never before. Saved library songs are separate encrypted copies and are
never part of this.
"""
import os
from pathlib import Path

import pytest
from flask import Flask
from loguru import logger

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vault_fs
import vocalis_server as vs
from vault import VaultAuthError, VaultLocked
from vocalis.runtime import acecands, acerun, acestage
from vocalis.runtime import acestep as rt
from vocalis.runtime import jobs as jobs_mod
from vocalis.runtime import paths as rt_paths
from vocalis.runtime import settings as rt_settings
from vocalis.web import acestep as web_acestep


@pytest.fixture(autouse=True)
def engine(monkeypatch, tmp_path):
    """A stage root the way the image sets it, with the engine's output folder inside it. Returns
    that output folder. Candidates, library and settings live in this test's own directory."""
    stage = tmp_path / "work" / "acestep"
    out = stage / acestage.BACKEND_SUBDIR
    out.mkdir(parents=True)
    monkeypatch.setenv(acestage.ENV_VAR, str(stage))
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    monkeypatch.setattr(rt_paths, "ACE_CANDIDATES", tmp_path / "ace_candidates.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", tmp_path / "ace_library.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", tmp_path / "ace_library")
    monkeypatch.setattr(jobs_mod, "JOBS", {})
    return out


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def said():
    """Every log line written while the test runs, as (LEVEL, message)."""
    lines = []
    sink = logger.add(lambda m: lines.append((m.record["level"].name, m.record["message"])),
                      level="DEBUG")
    yield lines
    logger.remove(sink)


def _file(out, name, data=b"flac-bytes"):
    p = out / name
    p.write_bytes(data)
    return p


def _remember(out, jid, *names, status="done"):
    """A finished candidate whose detail points at these files the way the runner records it:
    the engine's absolute path of each song."""
    acecands.remember(jid, status, 1.0, {"audio": [(out / n).as_posix() for n in names],
                                         "url": "http://127.0.0.1:7683", "device": "cuda:0"})


def _live(jid, status, out=None, *names):
    job = jobs_mod.Job(id=jid, docx="", voice="", params=None, gpus="cuda:0", workers=1)
    job.kind = "acestep"
    job.status = status
    job.detail = {"audio": [(out / n).as_posix() for n in names], "url": "http://127.0.0.1:7683"}
    jobs_mod.JOBS[jid] = job
    return job


def _left(out):
    return sorted(p.name for p in out.iterdir())


def _cleanup_lines(said):
    return [(lvl, m) for lvl, m in said if m.startswith("ACE-Step output")]


# ── rule 1: records leaving for good take their files with them ───────────────────────────────

def test_a_candidate_pushed_out_by_the_limit_loses_its_file_and_the_kept_ones_do_not(engine):
    for i in range(acecands.MAX_REMEMBERED):
        _file(engine, f"s{i}.flac")
        _remember(engine, f"j{i}", f"s{i}.flac")
    assert len(_left(engine)) == acecands.MAX_REMEMBERED, "fixture: nothing goes below the limit"

    _file(engine, "newest.flac")
    _remember(engine, "newest", "newest.flac")

    left = _left(engine)
    assert "s0.flac" not in left, "the oldest candidate was dropped from the tray; its file stays?"
    assert len(left) == acecands.MAX_REMEMBERED
    assert {f"s{i}.flac" for i in range(1, acecands.MAX_REMEMBERED)} | {"newest.flac"} == set(left)


def test_the_second_discard_replaces_the_bin_and_only_then_do_the_first_files_go(engine):
    for n in "abc":
        _file(engine, f"{n}.flac")
        _remember(engine, n, f"{n}.flac")

    assert acecands.forget("a") is True
    assert _left(engine) == ["a.flac", "b.flac", "c.flac"], "a discard is undoable: nothing yet"

    assert acecands.forget("b") is True
    assert _left(engine) == ["b.flac", "c.flac"], "the bin was replaced; a is gone for good"

    assert [r["id"] for r in acecands.undo()] == ["b"]
    assert _left(engine) == ["b.flac", "c.flac"], "undo restored b and its file is still there"
    assert sorted(c["id"] for c in acecands.load_all()) == ["b", "c"]


def test_discard_all_then_undo_deletes_nothing(engine):
    for i in range(5):
        _file(engine, f"s{i}.flac")
        _remember(engine, f"j{i}", f"s{i}.flac")
    assert acecands.forget_all() == 5
    assert len(_left(engine)) == 5, "the whole tray is in the bin; every file is still undoable"
    assert len(acecands.undo()) == 5
    assert len(_left(engine)) == 5
    assert len(acecands.load_all()) == 5


def test_a_second_discard_all_releases_the_first_batch(engine):
    _file(engine, "old.flac")
    _remember(engine, "old", "old.flac")
    acecands.forget_all()
    _file(engine, "new.flac")
    _remember(engine, "new", "new.flac")
    acecands.forget_all()
    assert _left(engine) == ["new.flac"]


def test_dropping_a_record_without_the_bin_deletes_its_file_and_leaves_the_bin_alone(engine):
    _file(engine, "binned.flac")
    _remember(engine, "binned", "binned.flac")
    acecands.forget("binned")
    _file(engine, "dropped.flac")
    _remember(engine, "dropped", "dropped.flac")
    assert acecands.drop("dropped") is True
    assert _left(engine) == ["binned.flac"]
    assert acecands.bin_size() == 1


def test_a_file_a_live_job_still_refers_to_is_not_deleted_when_its_record_leaves(engine):
    _file(engine, "shown.flac")
    _remember(engine, "shown", "shown.flac")
    _live("shown", "done", engine, "shown.flac")          # still in the tray this session
    acecands.drop("shown")
    assert _left(engine) == ["shown.flac"], "the tray row still plays it"


# ── rule 2: the reconcile pass ────────────────────────────────────────────────────────────────

def test_reconcile_removes_the_unreferenced_and_keeps_every_kind_of_referenced_file(engine, said):
    for n in ("cand.flac", "binned.flac", "live.flac", "stray1.flac", "stray2.wav"):
        _file(engine, n)
    _remember(engine, "cand", "cand.flac")
    _remember(engine, "binned", "binned.flac")
    acecands.forget("binned")
    _live("live", "done", engine, "live.flac")           # finished, never persisted

    assert acecands.reconcile_output(jobs_mod) == 2
    assert _left(engine) == ["binned.flac", "cand.flac", "live.flac"]
    assert _cleanup_lines(said) == [
        ("INFO", "ACE-Step output: removed 2 file(s) no candidate refers to, kept 3")]


@pytest.mark.parametrize("status", ["queued", "running"])
def test_reconcile_does_nothing_while_a_job_is_queued_or_running(engine, said, status,
                                                                monkeypatch):
    """A running job's file exists before its record does. "Running" means a watcher in this
    process is collecting its result."""
    monkeypatch.setattr(acerun, "_WATCHING", {"busy"})
    _file(engine, "in-flight.flac")
    _live("busy", status)
    assert acecands.reconcile_output(jobs_mod) == 0
    assert _left(engine) == ["in-flight.flac"]
    assert _cleanup_lines(said) == []

    jobs_mod.JOBS["busy"].status = "done"
    assert acecands.reconcile_output(jobs_mod) == 1, "the next pass with the card idle collects it"
    assert _left(engine) == []


def test_a_running_job_whose_child_is_ours_and_alive_blocks_the_pass_without_a_watcher(
        engine, monkeypatch):
    _file(engine, "in-flight.flac")
    job = _live("owned", "running")
    job.detail.update(device="cuda:0", backend_generation=3)
    monkeypatch.setattr(acerun, "_WATCHING", set())
    monkeypatch.setattr(acerun.acestep, "owns_generation",
                        lambda device, generation: (device, generation) == ("cuda:0", 3))
    assert acecands.reconcile_output(jobs_mod) == 0
    assert _left(engine) == ["in-flight.flac"]


def test_a_restored_running_row_with_no_child_does_not_stop_the_pass_for_the_whole_process(
        engine, monkeypatch):
    """After a restart during a render the row stays "running" for the life of the process (no
    child of this process owns it, nothing resolves it), but it cannot write a song."""
    _file(engine, "stray.flac")
    _file(engine, "kept.flac")
    _remember(engine, "kept", "kept.flac")
    ghost = _live("ghost", "running")
    ghost.detail.update(device="cuda:0", backend_generation=1, task_id="t-old")
    monkeypatch.setattr(acerun, "_WATCHING", set())
    monkeypatch.setattr(rt, "_BACKENDS", {})             # a fresh process: no child at all
    assert acecands.reconcile_output(jobs_mod) == 1
    assert _left(engine) == ["kept.flac"]
    assert ghost.status == "running", "the row itself is untouched"


def test_a_pass_that_removes_nothing_says_nothing(engine, said):
    _file(engine, "kept.flac")
    _remember(engine, "kept", "kept.flac")
    assert acecands.reconcile_output(jobs_mod) == 0
    assert acecands.reconcile_output(jobs_mod) == 0
    assert _cleanup_lines(said) == []


def test_a_cancelled_jobs_leftover_file_is_removed_by_the_pass_that_follows_it(engine, monkeypatch):
    """"canceled after the backend finished; generated audio was not collected": the engine wrote
    the song, the job never recorded it, and the watcher's last act is the pass."""
    monkeypatch.setattr(acerun, "POLL_SECONDS", 0.01)
    leftover = _file(engine, "never-collected.flac")
    job = _live("c1", "running")
    job.detail = {"payload": {}, "device": "cuda:0", "backend_generation": 7}
    job.cancel.set()
    monkeypatch.setattr(acerun.acestep, "poll", lambda url, tid: {
        "status": acerun.acestep.SUCCEEDED, "audio": [leftover.as_posix()]})
    done = []
    queue = type("Q", (), {"done": staticmethod(lambda jid: done.append(jid))})()

    acerun.run_job(job, "http://x", "cuda:0", {}, queue, task_id="t-1")

    assert job.status == "canceled" and done == ["c1"]
    assert not leftover.exists(), "nothing refers to a cancelled job's song"


def test_a_finished_job_keeps_its_song(engine, monkeypatch):
    monkeypatch.setattr(acerun, "POLL_SECONDS", 0.01)
    song = _file(engine, "fresh.flac")
    job = _live("f1", "running")
    job.detail = {"payload": {}, "device": "cuda:0", "backend_generation": 7}
    monkeypatch.setattr(acerun.acestep, "poll", lambda url, tid: {
        "status": acerun.acestep.SUCCEEDED, "audio": [song.as_posix()]})
    queue = type("Q", (), {"done": staticmethod(lambda jid: None)})()

    acerun.run_job(job, "http://x", "cuda:0", {}, queue, task_id="t-2")

    assert job.status == "done" and song.exists()
    assert [c["id"] for c in acecands.load_all()] == ["f1"]


def test_a_pass_runs_at_the_first_tray_load_after_a_restart(engine):
    """Candidates from before this behavior existed, and anything left by a crash, go when the
    store has been read for the first time."""
    _file(engine, "kept.flac")
    _remember(engine, "kept", "kept.flac")
    _file(engine, "from-before.flac")
    jobs_mod.JOBS.clear()

    app = Flask(__name__)
    app.register_blueprint(web_acestep.create_acestep_blueprint())
    r = app.test_client().get("/acestep/jobs")

    assert r.status_code == 200
    assert [j["id"] for j in r.get_json()["jobs"]] == ["kept"]
    assert _left(engine) == ["kept.flac"]


def test_the_discard_routes_run_a_pass_and_undo_still_plays_the_song(engine, client, monkeypatch):
    monkeypatch.setattr(rt, "fetch_audio",
                        lambda url, path, timeout=120.0: Path(path).read_bytes())
    for n in "ab":
        _file(engine, f"{n}.flac", data=f"bytes-of-{n}".encode())
        _remember(engine, n, f"{n}.flac")
    _file(engine, "stray.flac")
    acecands.rehydrate(jobs_mod)

    assert client.post("/acestep/jobs/a/discard").status_code == 200
    assert _left(engine) == ["a.flac", "b.flac"], "stray went with the pass; a waits in the bin"
    assert client.post("/acestep/candidates/undo").get_json()["restored"] == 1
    r = client.get("/acestep/jobs/a/audio")
    assert r.status_code == 200 and r.data == b"bytes-of-a", "an undone discard plays again"

    client.post("/acestep/jobs/a/discard")
    client.post("/acestep/jobs/b/discard")
    assert _left(engine) == ["b.flac"]
    assert client.get("/acestep/jobs/b/audio").status_code == 404, "b left the registry"
    assert client.post("/acestep/candidates/undo").get_json()["restored"] == 1
    assert client.get("/acestep/jobs/b/audio").data == b"bytes-of-b"


def test_the_pass_does_not_run_from_a_discard_while_a_job_is_running(engine, client, monkeypatch):
    monkeypatch.setattr(acerun, "_WATCHING", {"busy"})
    _remember(engine, "a", "a.flac")
    _file(engine, "a.flac")
    _file(engine, "in-flight.flac")
    acecands.rehydrate(jobs_mod)
    _live("busy", "running")
    client.post("/acestep/jobs/a/discard")
    assert _left(engine) == ["a.flac", "in-flight.flac"]


# ── rule 3 and 6: playback of what is left ────────────────────────────────────────────────────

def test_a_candidate_whose_file_is_missing_still_reads_as_unavailable(engine, client, monkeypatch):
    monkeypatch.setattr(rt, "fetch_audio",
                        lambda url, path, timeout=120.0: Path(path).read_bytes())
    _remember(engine, "gone", "never-written.flac")
    acecands.rehydrate(jobs_mod)
    r = client.get("/acestep/jobs/gone/audio")
    assert r.status_code == 502 and "could not fetch it" in r.get_json()["error"]


# ── rule 4: the library is untouched ──────────────────────────────────────────────────────────

def test_a_saved_song_still_plays_after_its_candidate_is_discarded_twice_over(
        engine, client, monkeypatch, tmp_path):
    original = b"the-song-as-the-engine-wrote-it"
    monkeypatch.setattr(rt, "fetch_audio",
                        lambda url, path, timeout=120.0: Path(path).read_bytes())
    song = _file(engine, "saved.flac", data=original)
    _remember(engine, "saved", "saved.flac")
    acecands.rehydrate(jobs_mod)
    saved = client.post("/acestep/jobs/saved/save", json={"name": "Kept"})
    assert saved.status_code == 201
    song_id = saved.get_json()["id"]

    client.post("/acestep/jobs/saved/discard")
    _file(engine, "other.flac")
    _remember(engine, "other", "other.flac")
    acecands.rehydrate(jobs_mod)
    client.post("/acestep/jobs/other/discard")

    assert not song.exists(), "fixture check: the candidate's engine file went with its record"
    r = client.get(f"/acestep/library/{song_id}/audio")
    assert r.status_code == 200 and r.data == original
    assert acestage.output_dir() not in Path(rt_paths.ACE_LIBRARY_AUDIO).parents
    acecands.reconcile_output(jobs_mod)
    assert client.get(f"/acestep/library/{song_id}/audio").data == original


def test_a_source_staged_from_a_candidate_is_a_copy_the_pass_does_not_touch(engine, tmp_path):
    """Remix, Repaint and Cover stage a candidate by fetching its bytes into the stage root under
    an opaque name, so the new job refers to the copy and never to the engine's file."""
    _file(engine, "src.flac", data=b"source-bytes")
    _remember(engine, "src", "src.flac")
    acecands.rehydrate(jobs_mod)
    stage = engine.parent
    staged = acestage.stage_source("cand:src", root=stage,
                                   fetch=lambda url, p: Path(p).read_bytes())
    assert Path(staged).parent == stage and Path(staged).read_bytes() == b"source-bytes"

    jobs_mod.JOBS.clear()
    acecands.forget_all()
    acecands.forget_all()                                # bin replaced: the engine file is gone
    acecands.reconcile_output(jobs_mod)

    assert not (engine / "src.flac").exists()
    assert Path(staged).read_bytes() == b"source-bytes"


# ── rule 5: safety ────────────────────────────────────────────────────────────────────────────

def test_a_link_is_never_removed_or_followed_even_if_it_is_named_for_deletion(
        engine, tmp_path, monkeypatch):
    """The guard behind the real-link test below, which needs a privilege some accounts lack:
    whatever `lstat` says is a link is not a plain file, so it is left alone."""
    import stat as stat_mod
    outside = tmp_path / "outside.flac"
    outside.write_bytes(b"not ours")
    _file(engine, "link.flac", data=b"stands in for a link")
    real_lstat = os.lstat

    def lstat(p, *a, **k):
        if str(p).endswith("link.flac"):
            st = real_lstat(p)
            return os.stat_result((stat_mod.S_IFLNK | 0o777,) + tuple(st)[1:])
        return real_lstat(p, *a, **k)
    monkeypatch.setattr(acecands.os, "lstat", lstat)

    assert acecands._delete_files({"link.flac"}) == 0
    assert (engine / "link.flac").exists() and outside.read_bytes() == b"not ours"


def test_an_output_folder_reported_as_a_link_is_not_used(engine, monkeypatch):
    _file(engine, "stray.flac")
    real = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda self: self.name == acestage.BACKEND_SUBDIR
                        or real(self))
    assert acestage.output_dir() is None
    assert acecands.reconcile_output(jobs_mod) == 0
    assert _left(engine) == ["stray.flac"]


def test_only_regular_files_directly_in_the_output_folder_are_ever_removed(engine, tmp_path):
    stage = engine.parent
    outside = tmp_path / "outside.flac"
    outside.write_bytes(b"not ours")
    link = engine / "link.flac"
    try:
        link.symlink_to(outside)
        made_link = True
    except (OSError, NotImplementedError):
        made_link = False       # a Windows account without the privilege; the guard has its own test
    (engine / "sub").mkdir()
    (engine / "sub" / "nested.flac").write_bytes(b"nested")
    staged_ref = stage / "0123456789abcdef.flac"          # the staging sweep's opaque name
    staged_ref.write_bytes(b"reference")
    loose = stage / "tmpabcd.wav"
    loose.write_bytes(b"engine temp")
    (stage / "local_redis").mkdir()
    redis_db = stage / "local_redis" / "cache.db"
    redis_db.write_bytes(b"sqlite")
    _file(engine, "stray.flac")

    assert acecands.reconcile_output(jobs_mod) == 1

    assert not (engine / "stray.flac").exists()
    assert outside.read_bytes() == b"not ours"
    assert os.path.lexists(link) == made_link
    assert (engine / "sub" / "nested.flac").read_bytes() == b"nested"
    assert staged_ref.exists() and loose.exists() and redis_db.exists()


def test_a_record_naming_a_path_outside_the_folder_deletes_nothing_outside(engine, tmp_path):
    victim = tmp_path / "precious.flac"
    victim.write_bytes(b"precious")
    acecands.remember("evil", "done", 1.0, {"audio": [str(victim), "../precious.flac"]})
    acecands.drop("evil")
    acecands.forget_all()
    acecands.reconcile_output(jobs_mod)
    assert victim.read_bytes() == b"precious"


def test_without_the_variable_the_image_sets_the_engine_is_not_assumed_to_share_the_folder(
        engine, monkeypatch, said):
    _file(engine, "stray.flac")
    monkeypatch.delenv(acestage.ENV_VAR)
    assert acestage.output_dir() is None
    assert acecands.reconcile_output(jobs_mod) == 0
    assert _left(engine) == ["stray.flac"] and _cleanup_lines(said) == []


def test_a_missing_output_folder_is_left_alone(engine, said):
    engine.rmdir()
    assert acecands.reconcile_output(jobs_mod) == 0
    assert not engine.exists() and _cleanup_lines(said) == []


def test_an_output_folder_that_is_itself_a_link_is_not_followed(engine, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "stray.flac").write_bytes(b"x")
    engine.rmdir()
    try:
        engine.symlink_to(elsewhere, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"this account cannot create symlinks here: {exc}")
    assert acecands.reconcile_output(jobs_mod) == 0
    assert (elsewhere / "stray.flac").exists()


# ── rule 5: an unreadable store looks like nothing and deletes nothing ────────────────────────

def _unreadable_by(kind, monkeypatch, tmp_path):
    if kind == "corrupt":
        rt_paths.ACE_CANDIDATES.write_text("{ this is not json", encoding="utf-8")
        return
    raiser = {"locked": VaultLocked("the vault is locked"),
              "auth": VaultAuthError("authentication failed")}[kind]

    def read_text(p, encoding="utf-8"):
        raise raiser
    monkeypatch.setattr(vault_fs, "read_text", read_text)


@pytest.mark.parametrize("kind", ["corrupt", "locked", "auth"])
def test_an_unreadable_candidate_store_deletes_nothing_and_says_why_once(
        engine, said, monkeypatch, tmp_path, kind):
    _file(engine, "a.flac")
    _file(engine, "b.flac")
    _remember(engine, "a", "a.flac")
    _unreadable_by(kind, monkeypatch, tmp_path)

    assert acecands.reconcile_output(jobs_mod) == 0

    assert _left(engine) == ["a.flac", "b.flac"]
    lines = _cleanup_lines(said)
    assert len(lines) == 1 and lines[0][0] == "WARNING", lines
    assert "candidate store could not be read" in lines[0][1]


# ── rule 7: logging ───────────────────────────────────────────────────────────────────────────

def test_a_file_that_cannot_be_removed_is_one_warning_without_its_name(engine, said, monkeypatch):
    _file(engine, "stuck-secret-name.flac")
    _file(engine, "free.flac")
    real = os.unlink

    def unlink(p, *a, **k):
        if "stuck-secret-name" in str(p):
            raise PermissionError(13, "Permission denied", str(p))
        return real(p, *a, **k)
    monkeypatch.setattr(acecands.os, "unlink", unlink)

    assert acecands.reconcile_output(jobs_mod) == 1

    assert _left(engine) == ["stuck-secret-name.flac"]
    lines = _cleanup_lines(said)
    assert [lvl for lvl, _m in lines] == ["WARNING", "INFO"]
    assert all("stuck-secret-name" not in m and "free.flac" not in m for _l, m in said
               if m.startswith("ACE-Step output")), lines
    assert lines[1][1] == "ACE-Step output: removed 1 file(s) no candidate refers to, kept 1"


# ── the engine's loose audio directly under the stage root, once, at process start ────────────

def _stage_with_leftovers(engine):
    stage = engine.parent
    loose = [stage / "tmpa1b2c3d4.flac", stage / "tmpe5f6g7h8.WAV"]
    for p in loose:
        p.write_bytes(b"engine tempfile leftover")
    return stage, loose


def test_the_loose_audio_the_engine_left_goes_at_start_and_everything_else_stays(
        engine, said, monkeypatch, tmp_path):
    monkeypatch.setattr(rt, "_BACKENDS", {})
    stage, loose = _stage_with_leftovers(engine)
    ours = [stage / "0123456789abcdef.flac",              # a staged reference / candidate copy
            stage / "fedcba9876543210.wav",
            stage / "0f0f0f0f0f0f0f0f.flac"]              # an opaque name, whatever the suffix
    for p in ours:
        p.write_bytes(b"staged")
    marker = stage / "engine.lock"
    marker.write_bytes(b"not audio, so not ours to judge")
    (engine / "song.flac").write_bytes(b"in api_audio")
    (stage / "local_redis").mkdir()
    (stage / "local_redis" / "cache.db").write_bytes(b"sqlite")
    (stage / "triton").mkdir()
    (stage / "triton" / "kernel.wav").write_bytes(b"in a sub-folder")
    outside = tmp_path / "outside.flac"
    outside.write_bytes(b"not ours")
    try:
        (stage / "link.flac").symlink_to(outside)
        made_link = True
    except (OSError, NotImplementedError):
        made_link = False                  # a Windows account without the privilege

    assert acestage.sweep_loose() == 2

    assert not any(p.exists() for p in loose)
    assert all(p.exists() for p in ours) and marker.exists()
    assert (engine / "song.flac").exists() and (stage / "local_redis" / "cache.db").exists()
    assert (stage / "triton" / "kernel.wav").exists() and stage.is_dir()
    assert outside.read_bytes() == b"not ours"
    assert os.path.lexists(stage / "link.flac") == made_link
    assert [(lvl, m) for lvl, m in said if m.startswith("acestage")] == [
        ("INFO", "acestage: removed 2 loose audio file(s) the engine left in the stage folder")]


def test_the_loose_sweep_says_nothing_when_there_is_nothing_to_remove(engine, said, monkeypatch):
    monkeypatch.setattr(rt, "_BACKENDS", {})
    (engine.parent / "0123456789abcdef.flac").write_bytes(b"staged")
    assert acestage.sweep_loose() == 0
    assert [m for _l, m in said if m.startswith("acestage")] == []


@pytest.mark.parametrize("phase", ["starting", "active", "stopping"])
def test_the_loose_sweep_does_nothing_while_an_engine_child_exists(engine, monkeypatch, phase):
    stage, loose = _stage_with_leftovers(engine)
    monkeypatch.setattr(rt, "active_states", lambda insts=None: {"cuda:0": phase})
    assert acestage.sweep_loose() == 0
    assert all(p.exists() for p in loose)


def test_the_loose_sweep_does_nothing_when_the_stage_folder_is_not_known_to_be_ours(
        engine, monkeypatch):
    monkeypatch.setattr(rt, "_BACKENDS", {})
    stage, loose = _stage_with_leftovers(engine)
    monkeypatch.delenv(acestage.ENV_VAR)
    assert acestage.sweep_loose() == 0
    monkeypatch.setenv(acestage.ENV_VAR, str(stage / "does-not-exist"))
    assert acestage.sweep_loose() == 0
    assert all(p.exists() for p in loose)


def test_a_loose_file_that_cannot_be_removed_is_one_warning_without_its_name(
        engine, said, monkeypatch):
    monkeypatch.setattr(rt, "_BACKENDS", {})
    stage, loose = _stage_with_leftovers(engine)
    real = os.unlink

    def unlink(p, *a, **k):
        if "tmpa1b2c3d4" in str(p):
            raise PermissionError(13, "Permission denied", str(p))
        return real(p, *a, **k)
    monkeypatch.setattr(acestage.os, "unlink", unlink)

    assert acestage.sweep_loose() == 1

    lines = [(lvl, m) for lvl, m in said if m.startswith("acestage")]
    assert [lvl for lvl, _m in lines] == ["WARNING", "INFO"]
    assert all("tmpa1b2c3d4" not in m for _l, m in lines)
    assert loose[0].exists() and not loose[1].exists()


def test_the_start_up_block_runs_the_loose_sweep_beside_the_staging_sweep():
    """The call site is the process-start block that already runs `acestage.sweep`."""
    import inspect
    src = inspect.getsource(vs)
    assert src.index("acestage.sweep()") < src.index("acestage.sweep_loose()")

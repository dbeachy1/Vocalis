"""Tests for the Bulk tab's one-shot batch engine (bulk.py) and its /bulk routes (4.5-m1).

The per-file ENGINE is injected, so the whole lifecycle — stage → fan-out → ZIP → persist
→ teardown — runs against a fake engine with no GPU, venv, or ffmpeg. The live
enhancer is validated separately; these tests pin the lifecycle contract.
"""
import io
import json
import time
import types
import zipfile
from pathlib import Path

import pytest

import bulk
import vocalis_server as vs
from vocalis.web import bulk as web_bulk
from vocalis.runtime import configs as rt_configs
from vocalis.runtime import enhancement as rt_enh
# 5.1-P3.2: the GPU telemetry lives in vocalis.runtime.gpu and vocalis_server calls it
# through the module. Patch it THERE -- vs has no gpu_stats to rebind any more, and if
# it did, rebinding it would leave the real caller reading the unpatched original.
from vocalis.runtime import gpu as gpu_mod


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_bulk():
    """Each test starts with an empty registry and no 'current' pointer."""
    bulk.JOBS.clear()
    bulk._CURRENT_IDS = {"enhance": "", "cleanup": ""}
    yield
    for j in list(bulk.JOBS.values()):
        j.cancel.set()
    bulk.JOBS.clear()
    bulk._CURRENT_IDS = {"enhance": "", "cleanup": ""}


@pytest.fixture
def cfg(tmp_path):
    return bulk.BulkConfig(scratch_root=tmp_path / "bulk")


def _files(*names):
    """[(filename, stream)] the way the route hands them to stage_uploads."""
    return [(n, io.BytesIO(f"RAW:{n}".encode())) for n in names]


class _FakeEngine:
    """Writes a deterministic output for each input — no GPU, no encode. `slots` is the
    fan-out width; `fail_on`/`cancel_on` exercise the error and cancel branches."""
    def __init__(self, workers=2, fail_on=None, cancel_on=None):
        self.workers = workers
        self.fail_on = fail_on
        self.cancel_on = cancel_on
        self.processed = []

    def slots(self, job):
        return list(range(self.workers))

    def process(self, job, src: Path, dst: Path, slot):
        name = src.name
        if self.cancel_on and self.cancel_on in name:
            job.cancel.set()
            return None
        if self.fail_on and self.fail_on in name:
            raise RuntimeError(f"boom on {name}")
        dst.write_text("OUT:" + src.read_text())
        self.processed.append(name)
        return dst


# ── pure helpers ─────────────────────────────────────────────────────────────

def test_resolve_format_default_on_garbage():
    assert bulk.resolve_format("mp3_256k") == "mp3_256k"
    assert bulk.resolve_format("wav") == "wav"
    assert bulk.resolve_format("nonsense") == bulk.DEFAULT_FORMAT
    assert bulk.resolve_format(None) == bulk.DEFAULT_FORMAT


def test_dedup_names_maps_extension_and_disambiguates():
    # Same stem from two sources → the second gets a numeric suffix; ext follows the format.
    out = bulk.dedup_names(["chapter01.mp3", "chapter01.wav", "b.flac"], "mp3_256k")
    assert out == ["chapter01.mp3", "chapter01 (2).mp3", "b.mp3"]
    # WAV format
    assert bulk.dedup_names(["x.mp3"], "wav") == ["x.wav"]


def test_encode_output_wav_moves_the_file(tmp_path):
    src = tmp_path / "proc.wav"
    src.write_text("audio")
    dst = tmp_path / "out" / "final.wav"
    bulk.encode_output(src, dst, "wav")
    assert dst.read_text() == "audio"
    assert not src.exists()                 # WAV output is a MOVE, not a copy


# ── staging + reset ──────────────────────────────────────────────────────────

def test_stage_uploads_records_inputs_and_avoids_collision(cfg):
    job = bulk.new_job(mode="enhance", fmt="mp3_256k", nfe=32)
    n = bulk.stage_uploads(cfg, job, _files("a.mp3", "a.mp3"))
    assert n == 2 and job.total == 2
    # Two uploads with the same name land on distinct on-disk paths (indexed prefix)...
    paths = [p for p, _o in job.inputs]
    assert len(set(paths)) == 2
    # ...but both remember their ORIGINAL name, which the output is derived from.
    assert [o for _p, o in job.inputs] == ["a.mp3", "a.mp3"]
    for p, _o in job.inputs:
        assert Path(p).is_file()


def test_clear_batches_keeps_one(cfg):
    (cfg.scratch_root / "keep").mkdir(parents=True)
    (cfg.scratch_root / "gone").mkdir(parents=True)
    bulk.clear_batches(cfg, keep="keep")
    assert (cfg.scratch_root / "keep").exists()
    assert not (cfg.scratch_root / "gone").exists()


# ── the lifecycle, end to end (fake engine) ──────────────────────────────────

def test_run_bulk_job_end_to_end(cfg):
    job = bulk.new_job(mode="enhance", fmt="mp3_256k", nfe=32)
    bulk.stage_uploads(cfg, job, _files("one.wav", "two.wav", "three.wav"))
    bulk.run_bulk_job(job, cfg, _FakeEngine(workers=2))

    assert job.status == "done"
    assert job.done == 3
    work = cfg.scratch_root / job.id
    zip_path = work / "result.zip"
    assert zip_path.is_file() and job.result_zip == str(zip_path)
    # in/ and out/ are gone on completion; the ZIP is the record.
    assert not (work / "in").exists()
    assert not (work / "out").exists()
    with zipfile.ZipFile(zip_path) as z:
        names = sorted(z.namelist())
    assert names == ["one.mp3", "three.mp3", "two.mp3"]     # names preserved, ext remapped
    # Manifest + current pointer.
    man = json.loads((work / "manifest.json").read_text())
    assert man["count"] == 3 and man["format"] == "mp3_256k" and man["mode"] == "enhance"
    assert bulk.current_job("enhance") is job
    assert bulk.manifest_of(job)["has_result"] is True


def test_run_bulk_job_cancel_keeps_nothing(cfg):
    job = bulk.new_job(mode="enhance", fmt="wav")
    bulk.stage_uploads(cfg, job, _files("a.wav", "STOP.wav", "c.wav"))
    bulk.run_bulk_job(job, cfg, _FakeEngine(workers=1, cancel_on="STOP"))
    assert job.status == "canceled"
    assert not (cfg.scratch_root / job.id).exists()          # a canceled batch produces no ZIP
    assert bulk.current_job("enhance") is None


def test_run_bulk_job_failure_keeps_nothing(cfg):
    job = bulk.new_job(mode="enhance", fmt="wav")
    bulk.stage_uploads(cfg, job, _files("a.wav", "BAD.wav"))
    bulk.run_bulk_job(job, cfg, _FakeEngine(workers=1, fail_on="BAD"))
    assert job.status == "failed"
    assert job.error
    assert not (cfg.scratch_root / job.id).exists()


def test_new_batch_replaces_previous(cfg):
    first = bulk.new_job(mode="enhance", fmt="wav")
    bulk.stage_uploads(cfg, first, _files("a.wav"))
    bulk.run_bulk_job(first, cfg, _FakeEngine(workers=1))
    assert bulk.current_job("enhance") is first
    first_dir = cfg.scratch_root / first.id
    assert first_dir.exists()

    # A new upload implicitly resets: clear the previous batch dir, then run.
    bulk.clear_batches(cfg)
    assert not first_dir.exists()
    assert bulk.current_job("enhance") is None
    second = bulk.new_job(mode="enhance", fmt="wav")
    bulk.stage_uploads(cfg, second, _files("b.wav"))
    bulk.run_bulk_job(second, cfg, _FakeEngine(workers=1))
    assert bulk.current_job("enhance") is second


# ── routes: validation + reattach surface ────────────────────────────────────

def test_bulk_start_bad_mode_404(client):
    r = client.post("/bulk/frobnicate")
    assert r.status_code == 404


def test_bulk_start_cleanup_is_a_valid_mode(client):
    # 'cleanup' is a real mode now (m3) — a bad mode is a 404, cleanup is not.
    assert client.post("/bulk/frobnicate").status_code == 404
    assert client.post("/bulk/cleanup").status_code != 404


def test_bulk_start_requires_enhance(client, monkeypatch):
    # No enhancer on the dev box → a clear 400, not a crash.
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: False)
    r = client.post("/bulk/enhance", data={"format": "mp3_256k"})
    assert r.status_code == 400


def test_bulk_start_no_files_400(client, monkeypatch):
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(gpu_mod, "cards_emptiest_first", lambda c: ["cuda:0"])
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: ["cuda:0"])
    r = client.post("/bulk/enhance", data={"format": "mp3_256k"})
    assert r.status_code == 400
    assert "file" in r.get_json()["error"].lower()


def test_bulk_start_happy_path_202(client, monkeypatch, tmp_path):
    # Stub the heavy engine run so the route's staging + 202 contract is what's tested.
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(gpu_mod, "cards_emptiest_first", lambda c: ["cuda:0"])
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: ["cuda:0"])
    monkeypatch.setattr(rt_configs, "bulk_cfg", lambda: bulk.BulkConfig(scratch_root=tmp_path / "b"))
    monkeypatch.setattr(vs.enhance, "estimate_seconds", lambda *a, **k: None)

    ran = {}
    def fake_run(job, cfg, engine):
        ran["id"] = job.id
        ran["total"] = job.total
        job.status = "done"
    monkeypatch.setattr(bulk, "run_bulk_job", fake_run)

    data = {"format": "mp3_256k", "nfe": "32",
            "file": [(io.BytesIO(b"one"), "one.mp3"), (io.BytesIO(b"two"), "two.mp3")]}
    r = client.post("/bulk/enhance", data=data, content_type="multipart/form-data")
    assert r.status_code == 202
    body = r.get_json()
    assert body["total"] == 2 and body["job_id"]
    # Give the daemon thread a beat to run the stubbed job.
    for _ in range(100):
        if ran:
            break
        time.sleep(0.01)
    assert ran.get("total") == 2


def test_bulk_current_empty_then_download_404(client):
    assert client.get("/bulk/current/enhance").get_json() == {}
    assert client.get("/bulk/download/enhance").status_code == 404
    assert client.get("/bulk/jobs").get_json() == []


# ── persistence across restart + housekeeping (m2) ───────────────────────────

def _make_batch(cfg, jid, names, created, mode="enhance", fmt="mp3_256k"):
    work = cfg.scratch_root / jid
    work.mkdir(parents=True, exist_ok=True)
    (work / "result.zip").write_bytes(b"PK\x05\x06" + b"\x00" * 18)   # existence is all recover checks
    (work / "manifest.json").write_text(json.dumps({
        "mode": mode, "format": fmt, "format_label": "MP3 256 kbps", "nfe": 8,
        "count": len(names), "names": names, "size": 123, "created": created}))
    return work


def test_startup_recover_adopts_complete_batch(cfg):
    _make_batch(cfg, "abc123abc123", ["a.mp3", "b.mp3"], created=time.time())
    m = bulk.startup_recover(cfg, ttl_days=7)["enhance"]
    assert m and m["count"] == 2 and m["job_id"] == "abc123abc123"
    assert bulk.current_job("enhance") is not None
    assert bulk.current_job("enhance").id == "abc123abc123"


def test_startup_recover_reaps_orphans(cfg):
    (cfg.scratch_root / "orphan" / "in").mkdir(parents=True)          # no result.zip → orphan
    keep = _make_batch(cfg, "keep12345678", ["x.mp3"], created=time.time())
    bulk.startup_recover(cfg)
    assert not (cfg.scratch_root / "orphan").exists()
    assert keep.exists()


def test_startup_recover_keeps_only_newest(cfg):
    old = _make_batch(cfg, "oldoldoldold", ["o.mp3"], created=1000)
    new = _make_batch(cfg, "newnewnewnew", ["n.mp3"], created=time.time())
    m = bulk.startup_recover(cfg)["enhance"]
    assert m["job_id"] == "newnewnewnew"
    assert new.exists() and not old.exists()


def test_startup_recover_ttl_drops_stale(cfg):
    d = _make_batch(cfg, "staleststale", ["s.mp3"], created=100)      # 1970 → far past any TTL
    m = bulk.startup_recover(cfg, ttl_days=7)
    assert m == {} and not d.exists()
    assert bulk.current_job("enhance") is None


def test_bulk_info_route(client, monkeypatch):
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: ["cuda:0", "cuda:1"])
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "R9700"}, {"index": 1, "name": "R9700"}])
    j = client.get("/bulk/info").get_json()
    assert j["available"] is True
    assert [c["index"] for c in j["cards"]] == [0, 1]


def _stub_enhance(monkeypatch, tmp_path):
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: ["cuda:0", "cuda:1"])
    monkeypatch.setattr(gpu_mod, "cards_emptiest_first", lambda c: list(c))
    monkeypatch.setattr(rt_configs, "bulk_cfg", lambda: bulk.BulkConfig(scratch_root=tmp_path / "b"))
    monkeypatch.setattr(vs.enhance, "estimate_seconds", lambda *a, **k: None)


def test_bulk_start_card_selection(client, monkeypatch, tmp_path):
    _stub_enhance(monkeypatch, tmp_path)
    cap = {}
    def fake_run(job, cfg, engine):
        cap["cards"] = list(engine.cards)
        job.status = "done"
    monkeypatch.setattr(bulk, "run_bulk_job", fake_run)
    data = {"format": "mp3_256k", "cards": "1", "file": [(io.BytesIO(b"x"), "x.mp3")]}
    r = client.post("/bulk/enhance", data=data, content_type="multipart/form-data")
    assert r.status_code == 202
    for _ in range(100):
        if cap:
            break
        time.sleep(0.01)
    assert cap["cards"] == ["cuda:1"]                    # only the ticked card


def test_bulk_start_card_selection_no_match_400(client, monkeypatch, tmp_path):
    _stub_enhance(monkeypatch, tmp_path)
    data = {"format": "mp3_256k", "cards": "9", "file": [(io.BytesIO(b"x"), "x.mp3")]}
    r = client.post("/bulk/enhance", data=data, content_type="multipart/form-data")
    assert r.status_code == 400


# ── m3: Clean up mode + match-source format ──────────────────────────────────

def test_resolve_format_source_only_when_allowed():
    assert bulk.resolve_format("source") == bulk.DEFAULT_FORMAT          # not allowed → default
    assert bulk.resolve_format("source", allow_source=True) == "source"


def test_source_ext_keeps_mp3_else_wav():
    assert bulk.source_ext("chapter01.mp3") == "mp3"
    assert bulk.source_ext("clip.MP3") == "mp3"
    assert bulk.source_ext("clip.wav") == "wav"
    assert bulk.source_ext("clip.flac") == "wav"                          # never inflate a lossy source


def test_dedup_names_source_mixed_batch():
    assert bulk.dedup_names(["a.mp3", "a.flac", "b.wav"], "source") == ["a.mp3", "a.wav", "b.wav"]


def test_format_label_source():
    assert bulk.format_label("source") == bulk.SOURCE_LABEL
    assert bulk.format_label("mp3_256k") == "MP3 256 kbps"


def test_run_bulk_job_cleanup_source_keeps_containers(cfg):
    job = bulk.new_job(mode="cleanup", fmt="source")
    bulk.stage_uploads(cfg, job, _files("a.mp3", "b.wav"))
    bulk.run_bulk_job(job, cfg, _FakeEngine(workers=2))
    assert job.status == "done"
    work = cfg.scratch_root / job.id
    with zipfile.ZipFile(work / "result.zip") as z:
        assert sorted(z.namelist()) == ["a.mp3", "b.wav"]                 # mp3 stays mp3, wav stays wav
    man = json.loads((work / "manifest.json").read_text())
    assert man["mode"] == "cleanup" and man["format"] == "source"
    assert man["format_label"] == bulk.SOURCE_LABEL and man["nfe"] is None


def test_bulk_start_cleanup_needs_denoise(client, monkeypatch):
    monkeypatch.setattr(rt_configs, "cleanup_cfg", lambda: types.SimpleNamespace(
        denoise_available=False, denoise_unavailable_reason="DFN3 model not installed"))
    r = client.post("/bulk/cleanup", data={"file": [(io.BytesIO(b"x"), "x.wav")]},
                    content_type="multipart/form-data")
    assert r.status_code == 400
    assert r.get_json()["error"] == "DFN3 model not installed", "the config's own reason, not a legacy script hint"


def test_bulk_start_cleanup_happy_path_defaults_to_source(client, monkeypatch, tmp_path):
    monkeypatch.setattr(rt_configs, "cleanup_cfg", lambda: types.SimpleNamespace(denoise_available=True))
    monkeypatch.setattr(rt_configs, "bulk_cfg", lambda: bulk.BulkConfig(scratch_root=tmp_path / "b"))
    monkeypatch.setattr(vs.cleanup, "estimate_seconds", lambda *a, **k: None)
    cap = {}
    def fake_run(job, cfg, engine):
        cap["mode"], cap["fmt"] = job.mode, job.fmt
        job.status = "done"
    monkeypatch.setattr(bulk, "run_bulk_job", fake_run)
    r = client.post("/bulk/cleanup", data={"file": [(io.BytesIO(b"x"), "x.mp3")]},
                    content_type="multipart/form-data")
    assert r.status_code == 202
    for _ in range(100):
        if cap:
            break
        time.sleep(0.01)
    assert cap["mode"] == "cleanup" and cap["fmt"] == "source"            # no format sent → match source


def test_bulk_info_reports_cleanup(client, monkeypatch):
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: False)
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: [])
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    monkeypatch.setattr(rt_configs, "cleanup_cfg", lambda: types.SimpleNamespace(denoise_available=True))
    j = client.get("/bulk/info").get_json()
    assert j["cleanup_available"] is True and j["available"] is False


# ── the STAGING area (§5a): pick now, run later ──────────────────────────────
#
# The folder IS the list — that is the whole feature ("the server does not remember the files
# the user uploaded"). So what is pinned here is (a) the folder really is what
# gets read back, (b) the two REAPERS that walk the scratch root leave it alone, and (c) a run
# doesn't eat it. Each of those is a way the list would silently empty itself.

def test_staged_files_reads_the_folder_back(cfg):
    """Stage, then read: the list comes off disk, not out of a variable. This is what makes a
    reload / a new tab / a restart all show the same files."""
    bulk.stage_add(cfg, "enhance", _files("a.mp3", "b.wav"))
    assert [r["name"] for r in bulk.staged_files(cfg, "enhance")] == ["a.mp3", "b.wav"]
    assert all(r["size"] > 0 for r in bulk.staged_files(cfg, "enhance"))


def test_picks_accumulate_and_a_repick_overwrites(cfg):
    """A second pick adds another staged item. Picking the same name again replaces its staged copy."""
    bulk.stage_add(cfg, "enhance", _files("a.mp3"))
    bulk.stage_add(cfg, "enhance", _files("b.mp3"))
    assert {r["name"] for r in bulk.staged_files(cfg, "enhance")} == {"a.mp3", "b.mp3"}
    bulk.stage_add(cfg, "enhance", [("a.mp3", io.BytesIO(b"NEWER"))])
    rows = bulk.staged_files(cfg, "enhance")
    assert len(rows) == 2                                   # replaced, not duplicated
    assert (bulk.staging_dir(cfg, "enhance") / "a.mp3").read_bytes() == b"NEWER"


def test_remove_one_and_remove_all(cfg):
    bulk.stage_add(cfg, "enhance", _files("a.mp3", "b.mp3", "c.mp3"))
    assert bulk.stage_remove(cfg, "enhance", "b.mp3") is True
    assert [r["name"] for r in bulk.staged_files(cfg, "enhance")] == ["a.mp3", "c.mp3"]
    assert bulk.stage_remove(cfg, "enhance", "b.mp3") is False         # already gone → not an error
    assert bulk.stage_clear(cfg, "enhance") == 2
    assert bulk.staged_files(cfg, "enhance") == []


@pytest.mark.parametrize("evil", ["../escape.mp3", "../../etc/passwd", "/abs/path.mp3", "", ".", ".."])
def test_a_staged_name_can_never_escape_the_staging_dir(cfg, evil):
    """The name arrives off an HTTP request and feeds unlink(). A traversal must not delete a
    file outside staging — nor should a bad name raise into the route."""
    bulk.stage_add(cfg, "enhance", _files("keep.mp3"))
    outside = Path(cfg.scratch_root) / "escape.mp3"
    outside.parent.mkdir(parents=True, exist_ok=True)
    outside.write_bytes(b"do not delete me")
    assert bulk.stage_remove(cfg, "enhance", evil) is False
    assert outside.is_file()                                # untouched
    assert [r["name"] for r in bulk.staged_files(cfg, "enhance")] == ["keep.mp3"]


def test_clear_batches_never_eats_the_staging_area(cfg):
    """clear_batches deletes every dir under the scratch root except `keep` — the implicit reset
    fires on EVERY run. If it took staging with it, your files would vanish the moment you hit ▶."""
    bulk.stage_add(cfg, "enhance", _files("a.mp3", "b.mp3"))
    (Path(cfg.scratch_root) / "deadbeef1234").mkdir(parents=True, exist_ok=True)
    bulk.clear_batches(cfg)
    assert not (Path(cfg.scratch_root) / "deadbeef1234").exists()    # a batch dir: gone
    assert [r["name"] for r in bulk.staged_files(cfg, "enhance")] == ["a.mp3", "b.mp3"]   # staging: intact


def test_startup_recover_never_reaps_the_staging_area(cfg):
    """startup_recover reaps any dir with no result.zip/manifest.json as a crash-orphan. Staging
    has neither, so without its guard every staged file would be eaten on RESTART."""
    bulk.stage_add(cfg, "enhance", _files("a.mp3"))
    bulk.startup_recover(cfg)
    assert [r["name"] for r in bulk.staged_files(cfg, "enhance")] == ["a.mp3"]


def test_a_run_copies_the_staged_files_and_does_not_consume_them(cfg):
    """stage_from_staging COPIES. run_bulk_job unlinks each input as its output lands (§8), so
    handing it the staging paths directly would make a run quietly eat the user's picked files."""
    bulk.stage_add(cfg, "cleanup", _files("a.mp3", "b.mp3"))
    job = bulk.new_job(mode="cleanup", fmt="mp3_256k")
    assert bulk.stage_from_staging(cfg, job) == 2
    assert job.total == 2
    assert [orig for _p, orig in job.inputs] == ["a.mp3", "b.mp3"]       # original names preserved
    for p, _orig in job.inputs:
        assert Path(p).is_file() and str(bulk.STAGING_DIR) not in p      # a copy in the JOB dir
    Path(job.inputs[0][0]).unlink()                                      # simulate the §8 unlink
    assert [r["name"] for r in bulk.staged_files(cfg, "cleanup")] == ["a.mp3", "b.mp3"]   # staging survives


# ── the /bulk/stage routes (what the tab actually calls) ─────────────────────

def test_stage_routes_round_trip(client, tmp_path, monkeypatch):
    """Pick → list → remove one → remove all, over HTTP. The route family the tab drives."""
    monkeypatch.setattr(rt_configs, "bulk_cfg", lambda: bulk.BulkConfig(scratch_root=tmp_path / "bulk"))
    assert client.get("/bulk/stage/enhance").get_json() == []                    # nothing staged yet

    r = client.post("/bulk/stage/enhance", content_type="multipart/form-data",
                    data={"file": [(io.BytesIO(b"aaa"), "a.mp3"), (io.BytesIO(b"bb"), "b.mp3")]})
    assert r.status_code == 200
    assert [x["name"] for x in r.get_json()] == ["a.mp3", "b.mp3"]

    # a second pick ADDS rather than replacing (the staging contract)
    r = client.post("/bulk/stage/enhance", content_type="multipart/form-data",
                    data={"file": [(io.BytesIO(b"c"), "c.mp3")]})
    assert [x["name"] for x in r.get_json()] == ["a.mp3", "b.mp3", "c.mp3"]

    # the list survives a "reload" — it is read off the folder
    assert [x["name"] for x in client.get("/bulk/stage/enhance").get_json()] == ["a.mp3", "b.mp3", "c.mp3"]

    r = client.post("/bulk/stage/enhance/remove", json={"name": "b.mp3"})        # the red ✕
    assert r.status_code == 200 and [x["name"] for x in r.get_json()] == ["a.mp3", "c.mp3"]
    assert client.post("/bulk/stage/enhance/remove", json={"name": "gone.mp3"}).status_code == 404

    r = client.post("/bulk/stage/enhance/clear", json={})                        # Remove all
    assert r.status_code == 200 and r.get_json()["removed"] == 2
    assert client.get("/bulk/stage/enhance").get_json() == []


def test_start_with_no_files_and_nothing_staged_is_400(client, tmp_path, monkeypatch):
    monkeypatch.setattr(rt_configs, "bulk_cfg", lambda: bulk.BulkConfig(scratch_root=tmp_path / "bulk"))
    r = client.post("/bulk/cleanup", data={}, content_type="multipart/form-data")
    assert r.status_code == 400 and "staged" in r.get_json()["error"]


def test_start_runs_what_is_staged_when_no_files_are_posted(client, tmp_path, monkeypatch):
    """The tab posts NO file parts — the run must pick the batch up off the staging folder."""
    monkeypatch.setattr(rt_configs, "bulk_cfg", lambda: bulk.BulkConfig(scratch_root=tmp_path / "bulk"))
    monkeypatch.setattr(rt_configs, "cleanup_cfg", lambda: types.SimpleNamespace(denoise_available=True))
    monkeypatch.setattr(vs.cleanup, "estimate_seconds", lambda *a, **k: None)
    cfg = rt_configs.bulk_cfg()
    bulk.stage_add(cfg, "cleanup", _files("x.mp3", "y.mp3"))
    cap = {}

    def fake_run(job, cfg_, engine):
        cap["names"] = [orig for _p, orig in job.inputs]
        cap["total"] = job.total
        job.status = "done"
    monkeypatch.setattr(bulk, "run_bulk_job", fake_run)
    monkeypatch.setattr(vs.bulk, "ffprobe_duration", lambda p: 10.0)

    r = client.post("/bulk/cleanup", data={"format": "mp3_256k"},
                    content_type="multipart/form-data")
    assert r.status_code == 202
    for _ in range(100):
        if cap:
            break
        time.sleep(0.01)
    assert cap["names"] == ["x.mp3", "y.mp3"] and cap["total"] == 2
    # and the run left the staged files alone — they're still there to re-run
    assert [x["name"] for x in client.get("/bulk/stage/cleanup").get_json()] == ["x.mp3", "y.mp3"]


# ── §5b: Enhance and Clean up are SEPARATE workspaces ────────────────────────
#
# They shared one staging folder and one "last batch" slot, so the Enhance tab showed Clean up's
# files and offered its ZIP (the two tabs shared one staging folder and one last-batch slot). Every test here is a way that leaks back.

def test_the_two_modes_stage_independently(cfg):
    bulk.stage_add(cfg, "enhance", _files("e1.mp3", "e2.mp3"))
    bulk.stage_add(cfg, "cleanup", _files("c1.mp3"))
    assert [r["name"] for r in bulk.staged_files(cfg, "enhance")] == ["e1.mp3", "e2.mp3"]
    assert [r["name"] for r in bulk.staged_files(cfg, "cleanup")] == ["c1.mp3"]


def test_remove_all_in_one_mode_leaves_the_other_alone(cfg):
    bulk.stage_add(cfg, "enhance", _files("e1.mp3"))
    bulk.stage_add(cfg, "cleanup", _files("c1.mp3"))
    assert bulk.stage_clear(cfg, "cleanup") == 1
    assert bulk.staged_files(cfg, "cleanup") == []
    assert [r["name"] for r in bulk.staged_files(cfg, "enhance")] == ["e1.mp3"]


def test_removing_a_name_cannot_reach_into_the_other_modes_folder(cfg):
    """Same filename in both tabs: removing it from one must not touch the other's copy."""
    bulk.stage_add(cfg, "enhance", _files("same.mp3"))
    bulk.stage_add(cfg, "cleanup", _files("same.mp3"))
    assert bulk.stage_remove(cfg, "enhance", "same.mp3") is True
    assert bulk.staged_files(cfg, "enhance") == []
    assert [r["name"] for r in bulk.staged_files(cfg, "cleanup")] == ["same.mp3"]


def test_each_mode_retains_its_own_last_batch(cfg):
    """The heart of it: running a Clean-up batch must not delete the Enhance ZIP you kept."""
    e = bulk.new_job(mode="enhance", fmt="wav")
    bulk.stage_uploads(cfg, e, _files("e.wav"))
    bulk.run_bulk_job(e, cfg, _FakeEngine(workers=1))
    assert bulk.current_job("enhance") is e

    bulk.clear_batches(cfg, mode="cleanup")            # the implicit reset a cleanup run does
    c = bulk.new_job(mode="cleanup", fmt="wav")
    bulk.stage_uploads(cfg, c, _files("c.wav"))
    bulk.run_bulk_job(c, cfg, _FakeEngine(workers=1))

    assert bulk.current_job("cleanup") is c
    assert bulk.current_job("enhance") is e                       # survived the other mode's run
    assert (cfg.scratch_root / e.id).exists() and (cfg.scratch_root / c.id).exists()


def test_a_new_batch_replaces_only_its_own_modes_batch(cfg):
    e1 = bulk.new_job(mode="enhance", fmt="wav")
    bulk.stage_uploads(cfg, e1, _files("e1.wav"))
    bulk.run_bulk_job(e1, cfg, _FakeEngine(workers=1))
    c1 = bulk.new_job(mode="cleanup", fmt="wav")
    bulk.stage_uploads(cfg, c1, _files("c1.wav"))
    bulk.run_bulk_job(c1, cfg, _FakeEngine(workers=1))

    bulk.clear_batches(cfg, mode="enhance")            # a SECOND enhance run starts
    assert bulk.current_job("enhance") is None                    # its own previous batch: gone
    assert bulk.current_job("cleanup") is c1                      # the other tab's: untouched
    assert (cfg.scratch_root / c1.id).exists()


def test_startup_recover_adopts_one_batch_PER_MODE(cfg):
    """It used to keep the single newest overall — so a newer Clean-up batch silently deleted
    your Enhance ZIP on restart."""
    _make_batch(cfg, "enh111111111", ["e.mp3"], created=1000, mode="enhance")
    _make_batch(cfg, "cln222222222", ["c.mp3"], created=2000, mode="cleanup")
    adopted = bulk.startup_recover(cfg, ttl_days=0)
    assert set(adopted) == {"enhance", "cleanup"}
    assert adopted["enhance"]["job_id"] == "enh111111111"
    assert adopted["cleanup"]["job_id"] == "cln222222222"
    assert (cfg.scratch_root / "enh111111111").exists()           # the older one is NOT reaped
    assert bulk.current_job("enhance").id == "enh111111111"
    assert bulk.current_job("cleanup").id == "cln222222222"


def test_startup_recover_still_keeps_only_the_newest_WITHIN_a_mode(cfg):
    _make_batch(cfg, "oldenhance11", ["o.mp3"], created=1000, mode="enhance")
    _make_batch(cfg, "newenhance11", ["n.mp3"], created=2000, mode="enhance")
    adopted = bulk.startup_recover(cfg, ttl_days=0)
    assert adopted["enhance"]["job_id"] == "newenhance11"
    assert not (cfg.scratch_root / "oldenhance11").exists()       # superseded within its mode


# ── §5c: Copy to Enhance — the clean → enhance hand-off ──────────────────────
#
# One way only: 4.4 §6 keeps the axes separate and cleanup.py's rule is "denoise never runs on
# already-enhanced audio". It reads the ZIP because §8 already deleted the loose outputs.

def _finished_cleanup_batch(cfg, names=("a.mp3", "b.mp3")):
    """Run a real Clean-up batch through the engine so there's a genuine result.zip to copy."""
    job = bulk.new_job(mode="cleanup", fmt="wav")
    bulk.stage_uploads(cfg, job, _files(*names))
    bulk.run_bulk_job(job, cfg, _FakeEngine(workers=1))
    assert job.status == "done"
    return job


def test_copy_to_enhance_reads_the_ZIP_because_the_outputs_are_gone(cfg):
    """§8 deletes in/ and out/ on completion — the ZIP is the only record, so this must work
    with nothing but result.zip on disk."""
    job = _finished_cleanup_batch(cfg)
    assert not (cfg.scratch_root / job.id / "out").exists()      # the outputs really are gone
    assert Path(job.result_zip).is_file()

    files = bulk.copy_result_to_staging(cfg, "cleanup", "enhance")
    assert [r["name"] for r in files] == ["a.wav", "b.wav"]       # the CLEANED names, fmt applied
    assert [r["name"] for r in bulk.staged_files(cfg, "enhance")] == ["a.wav", "b.wav"]
    for r in files:
        assert (bulk.staging_dir(cfg, "enhance") / r["name"]).stat().st_size > 0
    assert not list(bulk.staging_dir(cfg, "enhance").glob("*.part"))


def test_copy_to_enhance_REPLACES_what_was_staged(cfg):
    """Copying a completed cleanup batch replaces the Enhance staging list after confirmation when it is nonempty."""
    _finished_cleanup_batch(cfg)
    bulk.stage_add(cfg, "enhance", _files("old1.mp3", "old2.mp3"))
    files = bulk.copy_result_to_staging(cfg, "cleanup", "enhance")
    assert [r["name"] for r in files] == ["a.wav", "b.wav"]       # the old pair is gone, not merged
    assert not (bulk.staging_dir(cfg, "enhance") / "old1.mp3").exists()


def test_copy_to_enhance_leaves_the_source_alone(cfg):
    """The ZIP and Clean up's own staged files must survive — 'copy', not 'move'."""
    job = _finished_cleanup_batch(cfg)
    bulk.stage_add(cfg, "cleanup", _files("source.mp3"))
    bulk.copy_result_to_staging(cfg, "cleanup", "enhance")
    assert Path(job.result_zip).is_file()                         # re-download still free
    assert [r["name"] for r in bulk.staged_files(cfg, "cleanup")] == ["source.mp3"]
    assert bulk.current_job("cleanup") is job                     # still the retained batch


def test_copy_to_enhance_with_no_finished_batch_raises(cfg):
    with pytest.raises(FileNotFoundError):
        bulk.copy_result_to_staging(cfg, "cleanup", "enhance")


def test_a_zip_member_cannot_escape_the_staging_dir(cfg, tmp_path):
    """ZIP SLIP. We wrote this ZIP so its names are ours — which is exactly the assumption these
    bugs are built on. A hostile member name must land inside staging or not at all."""
    job = _finished_cleanup_batch(cfg)
    with zipfile.ZipFile(job.result_zip, "a") as z:              # forge a traversal member
        z.writestr("../../../evil.mp3", b"pwned")
    outside = Path(cfg.scratch_root).parent / "evil.mp3"
    outside.unlink(missing_ok=True)

    bulk.copy_result_to_staging(cfg, "cleanup", "enhance")
    assert not outside.exists()                                  # never written above the root
    names = [r["name"] for r in bulk.staged_files(cfg, "enhance")]
    assert "evil.mp3" in names                                   # collapsed INTO staging, harmless
    assert all(".." not in n and "/" not in n for n in names)


def test_handoff_route(client, tmp_path, monkeypatch):
    monkeypatch.setattr(rt_configs, "bulk_cfg", lambda: bulk.BulkConfig(scratch_root=tmp_path / "bulk"))
    cfg = rt_configs.bulk_cfg()
    assert client.post("/bulk/handoff/cleanup-to-enhance", json={}).status_code == 404  # no batch

    _finished_cleanup_batch(cfg)
    r = client.post("/bulk/handoff/cleanup-to-enhance", json={})
    assert r.status_code == 200
    j = r.get_json()
    assert j["count"] == 2 and [f["name"] for f in j["files"]] == ["a.wav", "b.wav"]
    # and it really landed where Enhance will look for it
    assert [f["name"] for f in client.get("/bulk/stage/enhance").get_json()] == ["a.wav", "b.wav"]


def test_handoff_route_409s_while_a_batch_runs(client, tmp_path, monkeypatch):
    monkeypatch.setattr(rt_configs, "bulk_cfg", lambda: bulk.BulkConfig(scratch_root=tmp_path / "bulk"))
    _finished_cleanup_batch(rt_configs.bulk_cfg())
    live = bulk.new_job(mode="enhance", fmt="wav")
    live.status = "running"                                      # a batch is in flight
    assert client.post("/bulk/handoff/cleanup-to-enhance", json={}).status_code == 409

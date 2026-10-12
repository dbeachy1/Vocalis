"""Tests for the 2.0-M4 book web UI server (vocalis_server).

Drives the Flask test client with a FAKE pool + fake start/finish_section, so the
job lifecycle, SSE fan-out, and endpoints are exercised without a GPU or model.
"""
import ctypes
import io
import json
import os
import queue
import struct
import threading
import time
import types
from urllib.parse import quote

import pytest
import torch

from conftest import REPO_ROOT, make_test_docx, make_test_epub

import vocalis_server as vs
from vocalis.runtime import enhancement as rt_enh
from vocalis.runtime import voices as rt_voices
import vocalis.runtime.comfyui as rt_comfyui
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.pool as rt_pool
import vocalis.runtime.settings as rt_settings
# 5.1-P3.2: the GPU telemetry lives in vocalis.runtime.gpu and vocalis_server calls it
# through the module. Patch it THERE -- vs has no gpu_stats to rebind any more, and if
# it did, rebinding it would leave the real caller reading the unpatched original.
from vocalis.runtime import gpu as gpu_mod
from vocalis.runtime import jobs as jobs_mod
from vocalis.runtime import procs   # the /proc scans (5.1-P4.14, ledger 3.9)
# 5.1-P4.11: the Books tab and the whole book renderer are vocalis.web.books now. OUTPUT_DIR
# and CHUNKS_ROOT belong to book_to_audio and every importer captures its OWN binding, so the
# tmp_output fixture below has to redirect BOTH -- vocalis_server still reads them for the
# playground and /library. `run_job`, `start_section`/`finish_section` and `wav_to_mp3` are seams and are
# NOT re-exported by vocalis_server; patch them on this module or the patch reaches nothing.
from vocalis.web import books as web_books
from vocalis.web import clips as web_clips        # OUTPUT_DIR binding (6.0 §7)
from vocalis.web import playground as web_playground
from vocalis.web import system as web_system      # /library's OUTPUT_DIR binding (5.1-P4.17)
from vocalis.web import train as web_train        # OUTPUT_DIR + CHUNKS_ROOT bindings (5.1.1)
from vocalis.web import voices as web_voices      # OUTPUT_DIR binding (5.1.1)
from vocalis.runtime import configs as rt_configs  # OUTPUT_DIR binding (5.1.1)
import book_state
from book_to_audio import books_root
import tts_utils
import playground_clips
from tts_utils import save_wav_sf   # portable WAV write (torchaudio.save unusable on ROCm)

FAKE_SR = 24000


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def _drain_jobs_between_tests():
    """Test isolation: several tests here start a book job (a daemon run_job thread)
    or hold GPUS. A job thread lingering into the next test — still holding or
    contending GPUS — makes a following GPUS/timeout test flake. After each
    test, cancel any live jobs and wait for them to reach a terminal state (run_job
    releases GPUS on its way out), then clear the registry, so no job thread
    crosses a test boundary."""
    yield
    for j in list(jobs_mod.JOBS.values()):
        j.cancel.set()
    for _ in range(200):
        if all(j.status in ("done", "failed", "canceled") for j in jobs_mod.JOBS.values()):
            break
        time.sleep(0.02)
    jobs_mod.JOBS.clear()


@pytest.fixture
def fake_pipeline(monkeypatch):
    """Replace the GPU-bound pieces so a job runs instantly on CPU."""
    class _FakePool:
        sr = FAKE_SR
        def shutdown(self): pass
    monkeypatch.setattr(rt_pool, "get_pool", lambda devices, workers: _FakePool())

    # 7.1: the render pipeline split into start_section (queue this chapter's chunks) and
    # finish_section (wait for them), so a book can keep the next chapter queued behind the
    # current one — otherwise a satellite that swallows a whole chapter leaves every other
    # card idle for the rest of it. Both seams are faked.
    #
    # 🔴 ALL the work stays in finish_section. The driver starts a section AHEAD of the one it
    # is collecting, so anything done at start time would happen a chapter early — the WAV
    # would land before its section_start event and the ordering these tests assert on would
    # come apart.
    def fake_start_section(section, pool, params, out_dir, chunks_base, on_event=None, cancel=None):
        return {"section": section, "out_dir": out_dir, "on_event": on_event}

    def fake_finish_section(h):
        section, out_dir, on_event = h["section"], h["out_dir"], h["on_event"]
        out_path = out_dir / (section["filename"] + ".wav")
        save_wav_sf(str(out_path), torch.zeros(1, FAKE_SR), FAKE_SR)   # 1 s of silence
        if on_event:
            on_event({"type": "chunk_done", "device": "cpu", "chapter": section["index"],
                      "chunk": 0, "total": 1, "preview": section["title"],
                      "stats": {"s": 0.1, "cps": 100, "tokens": 10, "pct": 1, "mark": "✓", "render": 9.9},
                      "log": f"[cpu] {section['title']} done"})
        return out_path, 1.0, 10, 0.1
    monkeypatch.setattr(web_books, "start_section", fake_start_section)
    monkeypatch.setattr(web_books, "finish_section", fake_finish_section)
    def fake_wav_to_mp3(p):
        # Mirror the real contract: the MP3 lands in mp3/ BESIDE the WAV and the
        # file EXISTS on return — 3.x deletes the WAV + chunks once it does, and
        # MP3 existence is the doneness marker, so a path-only fake breaks everything.
        mp3_dir = p.parent / "mp3"
        mp3_dir.mkdir(exist_ok=True)
        mp3 = mp3_dir / (p.stem + ".opus")   # 7.5.30: the encoded chapter is Opus
        mp3.write_bytes(b"ID3fake")
        return mp3
    monkeypatch.setattr(web_books, "wav_to_mp3", fake_wav_to_mp3)


@pytest.fixture
def tmp_output(monkeypatch, tmp_path):
    """Redirect the server's output/ + chunks/ + voice_samples/ to tmp dirs
    (isolation, no repo pollution). The voice names the tests use exist as real
    files because book_start/playground/regenerate reject a voice whose file is
    missing (2.0-M9)."""
    out = tmp_path / "output"; out.mkdir()
    ch = tmp_path / "chunks"; ch.mkdir()
    voices = tmp_path / "voice_samples"; voices.mkdir()
    for name in ("V.wav", "TestVoice.wav", "OtherVoice.wav", "Main.wav", "evil.wav"):
        (voices / name).write_bytes(b"RIFF0000WAVE")     # existence is all the guard checks
    # 🔴 EVERY BINDING. `OUTPUT_DIR`/`CHUNKS_ROOT` are `book_to_audio`'s and each importer
    # captures its own; they are deliberately not re-exported anywhere (a third name would be a
    # third place to remember — see test_m6_e2e.py's note). vocalis_server still reads
    # OUTPUT_DIR for the orphaned-regenbak sweep, but no longer reads CHUNKS_ROOT
    # at all, so patching it there would land on nothing.
    #
    # 🔴 5.1-P4.17 made `web_system` a FOURTH capture site by moving `/library` there, and
    # missing it does not fail loudly: three of the six /library assertions in this file are
    # NEGATIVE (`assert all(b["book"] != "empty" …)`), and those pass perfectly well while
    # reading the developer's real output/ tree — which is also the tree they would then be
    # asserting about.
    #
    # 🔴 5.1.1: "add one here whenever a route moves again" was the rule, and it had already
    # been missed THREE more times — web_voices, web_train and runtime/configs all captured
    # their own binding during Phase 4 and none was added. A comment asking a human to
    # remember is not a mechanism, so the list below is now pinned by
    # `test_tmp_output_redirects_EVERY_capture_site`, which discovers the sites from source
    # instead of trusting this list to be complete.
    monkeypatch.setattr(vs, "OUTPUT_DIR", out)               # the regenbak sweep
    monkeypatch.setattr(web_system, "OUTPUT_DIR", out)       # /library (5.1-P4.17)
    monkeypatch.setattr(web_books, "OUTPUT_DIR", out)        # the books blueprint (5.1-P4.11)
    monkeypatch.setattr(web_books, "CHUNKS_ROOT", ch)
    monkeypatch.setattr(web_playground, "OUTPUT_DIR", out)   # the playground blueprint (P4.12)
    monkeypatch.setattr(web_playground, "CHUNKS_ROOT", ch)
    monkeypatch.setattr(web_voices, "OUTPUT_DIR", out)       # /voices/<n>/clear_cache DELETES here
    monkeypatch.setattr(web_train, "OUTPUT_DIR", out)        # /train/source/import reads clips
    monkeypatch.setattr(web_train, "CHUNKS_ROOT", ch)
    monkeypatch.setattr(rt_configs, "OUTPUT_DIR", out)       # vs_cfg/ss_cfg library+stems dirs
    monkeypatch.setattr(web_clips, "OUTPUT_DIR", out)        # the Clips tab (6.0 §7)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", voices)
    return out


@pytest.fixture
def books_out(tmp_output):
    """`output/books/` — where rendered books live as of 5.3.

    `tmp_output` is still OUTPUT_DIR, because the playground / stems / voiceswap stores are
    genuinely its children. Books are not: they moved down a level so a book titled
    `playground` can no longer resolve onto the clip store. See tests/test_books_output_root.py.
    """
    d = books_root(tmp_output)
    d.mkdir(parents=True, exist_ok=True)
    return d


def test_tmp_output_redirects_EVERY_capture_site(tmp_output):
    """🔴 The fixture's completeness is now a TEST, not a comment asking someone to remember.

    `OUTPUT_DIR`/`CHUNKS_ROOT` are `book_to_audio`'s, and every importer captures its own
    binding — so the fixture has to name each one, and P4.17 proved that missing one fails
    SILENTLY: the route quietly reads the developer's real `output/` tree, and a negative
    assertion over it passes. Between P4.11 and P4.18 the list fell three sites behind
    without a single red test.

    So discover the sites from the SOURCE rather than from a list maintained by hand: any
    module under `src/` that binds one of these names is a site, and under `tmp_output` every
    one of them must point at the tmp tree. `book_to_audio` itself is excluded — it is where
    the names are DEFINED, and the fixture deliberately leaves the definition alone.

    A new blueprint that captures `OUTPUT_DIR` and forgets the fixture now fails HERE, loudly,
    instead of silently reading (and for /voices/<name>/clear_cache, DELETING in) real output."""
    import importlib
    import re as _re

    src = REPO_ROOT / "src"
    expected = {"OUTPUT_DIR": tmp_output, "CHUNKS_ROOT": tmp_output.parent / "chunks"}
    missed = []
    found_any = False
    for py in sorted(src.rglob("*.py")):
        if py.name == "book_to_audio.py":
            continue
        text = py.read_text(encoding="utf-8")
        bound = set()
        for m in _re.finditer(r"^from book_to_audio import (.+)$", text, _re.M):
            bound |= {n.strip() for n in m.group(1).split(",")}
        bound &= set(expected)
        if not bound:
            continue
        modname = py.relative_to(src).with_suffix("").as_posix().replace("/", ".")
        mod = importlib.import_module(modname)
        for name in sorted(bound):
            found_any = True
            actual = getattr(mod, name)
            if actual != expected[name]:
                missed.append(f"{modname}.{name} -> {actual} (want {expected[name]})")

    assert found_any, "found no capture sites at all -- the scan itself is broken"
    assert not missed, (
        "tmp_output does not redirect every OUTPUT_DIR/CHUNKS_ROOT binding; these still point "
        "at the real tree:\n  " + "\n  ".join(missed))


def _run_book(client, tmp_path, tmp_output, name="book", chapters=2, voice="V.wav", extra=None):
    docx = tmp_path / f"{name}.docx"
    make_test_docx(docx, num_chapters=chapters)
    body = {"path": str(docx), "gpus": "cpu", "voice": voice}
    if extra:
        body.update(extra)
    r = client.post("/book/start", json=body)
    return docx, r


def _wait_terminal(client, job_id, timeout=10):
    for _ in range(int(timeout / 0.05)):
        st = client.get(f"/book/status/{job_id}").get_json()
        if st["status"] in ("done", "failed", "canceled"):
            return st
        time.sleep(0.05)
    raise AssertionError("job did not finish in time")


def _wait_for_job_log(job, fragment, timeout=10):
    """Block until `job` has emitted a log event containing `fragment`, on the job's own event
    stream (the same ring-buffer replay + live tail the SSE route uses). It replaces a sleep that
    stood in for "the job thread has reached the GPU wait loop": the runner emits "Waiting for the
    GPUs" from INSIDE that loop, after its first failed acquire, so seeing it means the thread is
    there. `timeout` bounds a hang only; running out of it fails the test. It is a TOTAL deadline
    for the wait, not a limit per event: a job that keeps logging other lines must not stretch it."""
    deadline = time.monotonic() + timeout
    q = queue.Queue()
    with job.lock:
        backlog = list(job.events)
        job.subscribers.append(q)
    try:
        seen = list(backlog)
        while not any(ev.get("type") == "log" and fragment in ev.get("line", "") for ev in seen):
            try:
                seen = [q.get(timeout=max(0.0, deadline - time.monotonic()))]
            except queue.Empty:
                raise AssertionError(
                    f"the job never logged {fragment!r} within {timeout}s") from None
    finally:
        with job.lock:
            if q in job.subscribers:
                job.subscribers.remove(q)


# ── basic endpoints ───────────────────────────────────────────────────────────

def test_health(client):
    j = client.get("/health").get_json()
    assert j["status"] == "ok" and j["product"] == "Vocalis"
    assert "model_ready" in j and "model_loading" in j


# ── Engines running outside Vocalis (4.8-m4h) ────────────────────────────────
@pytest.fixture
def fake_proc(tmp_path, monkeypatch):
    """A stand-in /proc so the cmdline scan is exercised on any box, Windows included.
    Returns an `add(pid, cmdline, ppid=1, pgrp=None)` that writes one process's files."""
    monkeypatch.setattr(procs, "PROC_DIR", str(tmp_path))
    monkeypatch.setattr(procs, "_foreign_cache", {"t": 0.0, "v": {}})   # never serve a stale scan
    monkeypatch.setattr(vs.os, "getpid", lambda: 999)
    monkeypatch.setattr(vs.VOX, "_workers", {})

    def add(pid, cmdline, ppid=1, pgrp=None):
        d = tmp_path / str(pid)
        d.mkdir()
        (d / "cmdline").write_bytes(cmdline.replace(" ", "\0").encode() + b"\0")
        (d / "stat").write_text(f"{pid} (python) S {ppid} {pgrp if pgrp is not None else pid} 1 0")
        (d / "status").write_text(f"Name:\tpython\nPPid:\t{ppid}\n")
    (tmp_path / "self").mkdir()          # a non-numeric entry the scan must skip
    return add


def test_foreign_engines_spots_a_shell_launched_voxcpm(fake_proc):
    """The case that prompted this: a VoxCPM2 worker started from a shell holds a card,
    and the header used to read a cheerful '○ VoxCPM2' beside a full VRAM gauge."""
    fake_proc(101, "/home/test-user/voxcpm-venv/bin/python /tmp/worker.py --device cuda:0")
    assert procs.foreign_engines() == {"voxcpm": 1, "chatterbox": 0}


def test_foreign_engines_ignores_our_own_worker_and_its_children(fake_proc):
    """Vocalis's OWN worker is not foreign, and neither is anything it spawned — a
    worker gets its own session, so its descendants carry its pid as their pgid."""
    fake_proc(201, "/home/test-user/voxcpm-venv/bin/python scripts/voxcpm/worker.py --device cuda:0")
    fake_proc(202, "/home/test-user/voxcpm-venv/bin/python -c import voxcpm-venv", pgrp=201)
    vs.VOX._workers = {"cuda:0": types.SimpleNamespace(proc=types.SimpleNamespace(pid=201))}
    try:
        assert procs.foreign_engines()["voxcpm"] == 0
    finally:
        vs.VOX._workers = {}


def test_foreign_engines_ignores_our_direct_children(fake_proc):
    """A render this server spawned is ours, however Chatterbox-shaped it looks."""
    fake_proc(301, "/home/test-user/Vocalis/venv/bin/python src/book_to_audio.py", ppid=999)
    assert procs.foreign_engines()["chatterbox"] == 0


def test_foreign_engines_does_not_count_the_searcher(fake_proc):
    """🔴 The self-match guard. A shell command that merely NAMES the pattern — an ls, a
    grep — must not be counted as a running engine; that confusion is what once let a
    `pkill -f` kill the session that ran it."""
    fake_proc(401, "/bin/ls -la /home/test-user/voxcpm-venv/bin")
    fake_proc(402, "grep -r voxcpm/worker.py /home/test-user")
    # The nastiest one: names a needle AND the word python, but argv[0] is `ls`, so the
    # process is not an engine. Matching on "python anywhere in the line" would count it.
    fake_proc(403, "/bin/ls -la /home/test-user/voxcpm-venv/bin/python3.12")
    assert procs.foreign_engines() == {"voxcpm": 0, "chatterbox": 0}


def test_foreign_engines_spots_a_shell_render(fake_proc):
    """Chatterbox loads in-process, so the detectable case is a CLI entry point — it loads
    a model as its whole reason to exist, which is what makes the claim safe to make."""
    fake_proc(501, "/home/test-user/Vocalis/venv/bin/python src/book_to_audio.py mybook.docx")
    assert procs.foreign_engines()["chatterbox"] == 1


def test_foreign_engines_does_not_count_a_sibling_server(fake_proc):
    """🔴 Running 4.x and 5.x side by side is normal on this box — the first cut counted
    both the moment it deployed. A server that is merely RUNNING may hold nothing at all:
    unlike a worker or a CLI render, its model state is independent of its existence, so
    counting it would pin a permanent marker to the header on an unmeasured claim."""
    fake_proc(601, "/home/test-user/Vocalis.encrypted/venv/bin/python "
                   "/home/test-user/Vocalis.encrypted/src/vocalis_server.py --port 7871")
    fake_proc(602, "/home/test-user/Vocalis/venv/bin/python src/vocalis_server.py --port 7898")
    assert procs.foreign_engines() == {"voxcpm": 0, "chatterbox": 0}


def test_foreign_engines_says_nothing_when_it_cannot_look(monkeypatch, tmp_path):
    """No /proc ⇒ {}, NOT zeros. 'I can't tell' and 'none are running' must not look the
    same to the UI — one draws no marker, the other would assert the cards are free."""
    monkeypatch.setattr(procs, "PROC_DIR", str(tmp_path / "nope"))
    monkeypatch.setattr(procs, "_foreign_cache", {"t": 0.0, "v": {}})
    assert procs.foreign_engines() == {}


def test_health_reports_foreign_engines(client, monkeypatch):
    monkeypatch.setattr(procs, "foreign_engines", lambda: {"voxcpm": 2, "chatterbox": 0})
    assert client.get("/health").get_json()["foreign"] == {"voxcpm": 2, "chatterbox": 0}


# ── ComfyUI VRAM control (restart the shared-GPU neighbor) ───────────────────
class _FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


@pytest.fixture
def comfy_ok(monkeypatch):
    """Make BOTH ComfyUI instances look present + reachable + idle, with the
    network/systemctl/wait helpers stubbed so restart tests neither hit the LAN nor
    block on the ready-poll. The measured-VRAM instrument reads 20 GB before the
    restart, 4 GB after. Restart calls are recorded IN ORDER — 4.8: the button owns
    every instance (one ComfyUI per card on remote host), one systemctl restart each."""
    monkeypatch.setattr(rt_comfyui, "comfyui_instances",
                        lambda: [("comfyui.service", "http://127.0.0.1:8189"),
                                 ("comfyui-gpu1.service", "http://127.0.0.1:8289")])
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy", lambda: None)          # idle
    monkeypatch.setattr(rt_comfyui, "comfyui_vram_bytes", lambda: 16 * 2**30)    # self-report (lower bound)
    monkeypatch.setattr(rt_comfyui, "comfyui_wait_ready", lambda timeout: (True, 3.2))
    monkeypatch.setattr(vs.time, "sleep", lambda s: None)                # skip the sensor settle
    reads = iter([20.0, 4.0])                                            # before, after
    monkeypatch.setattr(gpu_mod, "used_vram_gb_total", lambda: next(reads))
    ram = iter([70.0, 12.0])                                             # before, after (58 GB back)
    monkeypatch.setattr(gpu_mod, "used_ram_gb", lambda: next(ram))
    # Stubbed so it doesn't land its own `systemctl is-active` in the recorded cmds —
    # these tests assert the EXACT systemctl calls the action made.
    monkeypatch.setattr(rt_comfyui, "comfyui_active_count", lambda: 2)
    seen = {"cmds": []}
    monkeypatch.setattr(vs.subprocess, "run",
                        lambda cmd, **kw: seen["cmds"].append(cmd) or _FakeCompleted(0))
    return seen


def test_health_reports_comfyui_flag(client, monkeypatch):
    monkeypatch.setattr(rt_comfyui, "comfyui_control_available", lambda: True)
    assert client.get("/health").get_json()["comfyui"] is True


def test_comfyui_status_uses_max_of_report_and_other(client, monkeypatch):
    """ComfyUI's self-report is a LOWER bound (it missed ~20 GB live) — the freeable
    estimate must take the non-Vocalis whole-card usage when that's larger."""
    monkeypatch.setattr(rt_comfyui, "comfyui_control_available", lambda: True)
    monkeypatch.setattr(rt_comfyui, "comfyui_vram_bytes", lambda: int(0.1 * 2**30))  # self-report ~0.1
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 20.7)                  # cards say 20.7
    j = client.get("/comfyui/status").get_json()
    assert j["available"] is True and j["up"] is True and j["vram_gb"] == 20.7


def test_comfyui_status_self_report_wins_when_larger(client, monkeypatch):
    monkeypatch.setattr(rt_comfyui, "comfyui_control_available", lambda: True)
    monkeypatch.setattr(rt_comfyui, "comfyui_vram_bytes", lambda: 15 * 2**30)
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 2.0)
    j = client.get("/comfyui/status").get_json()
    assert j["vram_gb"] == 15.0


def test_comfyui_status_down_but_cards_loaded(client, monkeypatch):
    """ComfyUI unreachable (up: false) but the cards hold non-Vocalis VRAM — the
    estimate still reports it (a restart is exactly how you reclaim it)."""
    monkeypatch.setattr(rt_comfyui, "comfyui_control_available", lambda: True)
    monkeypatch.setattr(rt_comfyui, "comfyui_vram_bytes", lambda: None)
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 12.3)
    j = client.get("/comfyui/status").get_json()
    assert j["available"] is True and j["up"] is False and j["vram_gb"] == 12.3


def test_comfyui_status_unavailable(client, monkeypatch):
    monkeypatch.setattr(rt_comfyui, "comfyui_control_available", lambda: False)
    assert client.get("/comfyui/status").get_json() == {"available": False}


def test_comfyui_status_reports_unit_state_not_reachability(client, monkeypatch):
    """4.8-m4f: the Stop/Start button reads `running` — the systemd unit state. It must be
    reported independently of `up` (HTTP reachability), because a ComfyUI warming its ROCm
    context is RUNNING and silent, and a button that offered to Start it would be lying."""
    monkeypatch.setattr(rt_comfyui, "comfyui_control_available", lambda: True)
    monkeypatch.setattr(rt_comfyui, "comfyui_vram_bytes", lambda: None)          # not answering yet
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 0.0)
    monkeypatch.setattr(rt_comfyui, "comfyui_active_count", lambda: 2)
    j = client.get("/comfyui/status").get_json()
    assert j["up"] is False and j["running"] == 2


def test_comfyui_active_count_reads_one_state_per_unit(monkeypatch):
    """`systemctl is-active a b` prints one state per unit in order and exits NON-ZERO
    unless all are active — so the lines are the answer and the exit code is noise."""
    monkeypatch.setattr(rt_comfyui, "comfyui_instances",
                        lambda: [("a.service", "http://x"), ("b.service", "http://y")])
    monkeypatch.setattr(vs.subprocess, "run",
                        lambda cmd, **kw: _FakeCompleted(returncode=3, stdout="active\ninactive\n"))
    assert rt_comfyui.comfyui_active_count() == 1


def test_comfyui_active_count_none_when_answers_dont_line_up(monkeypatch):
    """A short/garbled answer can't be matched to units positionally — say 'don't know'
    rather than guess, and the UI falls back to Restart instead of a wrong Start/Stop."""
    monkeypatch.setattr(rt_comfyui, "comfyui_instances",
                        lambda: [("a.service", "http://x"), ("b.service", "http://y")])
    monkeypatch.setattr(vs.subprocess, "run",
                        lambda cmd, **kw: _FakeCompleted(returncode=0, stdout="active\n"))
    assert rt_comfyui.comfyui_active_count() is None


def test_comfyui_stop_stops_every_instance_and_reports_ram(client, comfy_ok, monkeypatch):
    """Stop is the RAM button: an image-training run wants ~60 GB back, and only a stop
    (not a restart) leaves it free. No ready-wait — there is nothing coming back."""
    monkeypatch.setattr(rt_comfyui, "comfyui_wait_ready",
                        lambda timeout: pytest.fail("stop must not wait for a ready ComfyUI"))
    j = client.post("/comfyui/stop").get_json()
    assert j["ok"] is True and j["action"] == "stop" and j["ready"] is False
    assert j["freed_gb"] == 16.0 and j["freed_ram_gb"] == 58.0
    assert comfy_ok["cmds"] == [["systemctl", "--user", "stop", "comfyui.service"],
                                ["systemctl", "--user", "stop", "comfyui-gpu1.service"]]


def test_comfyui_stop_409_when_busy(client, comfy_ok, monkeypatch):
    """Same guard as restart — killing a running render is the user's call, not ours."""
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy", lambda: (1, 0))
    r = client.post("/comfyui/stop")
    assert r.status_code == 409 and r.get_json()["error"] == "comfyui_busy"
    assert comfy_ok["cmds"] == []
    assert client.post("/comfyui/stop", json={"force": True}).get_json()["ok"] is True


def test_comfyui_start_starts_every_instance_and_waits(client, comfy_ok, monkeypatch):
    """No busy check on start: a stopped ComfyUI has no queue to protect. It DOES wait,
    so the button's spinner covers the ~30 s ROCm warm-up instead of lying about ready."""
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy",
                        lambda: pytest.fail("start must not consult the queue"))
    j = client.post("/comfyui/start").get_json()
    assert j["ok"] is True and j["action"] == "start" and j["ready"] is True
    assert comfy_ok["cmds"] == [["systemctl", "--user", "start", "comfyui.service"],
                                ["systemctl", "--user", "start", "comfyui-gpu1.service"]]


def test_comfyui_start_501_when_unavailable(client, monkeypatch):
    monkeypatch.setattr(rt_comfyui, "comfyui_instances", lambda: [])
    monkeypatch.setattr(vs.subprocess, "run",
                        lambda *a, **k: pytest.fail("must not shell out with no instances"))
    assert client.post("/comfyui/start").status_code == 501
    assert client.post("/comfyui/stop").status_code == 501


def test_comfyui_restart_ok_restarts_every_instance(client, comfy_ok):
    j = client.post("/comfyui/restart").get_json()
    assert j["ok"] is True and j["ready"] is True
    assert j["freed_gb"] == 16.0                 # measured delta: 20.0 before - 4.0 after
    assert j["services"] == ["comfyui.service", "comfyui-gpu1.service"]
    assert comfy_ok["cmds"] == [["systemctl", "--user", "restart", "comfyui.service"],
                                ["systemctl", "--user", "restart", "comfyui-gpu1.service"]]


def test_comfyui_restart_409_when_busy(client, comfy_ok, monkeypatch):
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy", lambda: (1, 2))        # 1 running, 2 queued
    def boom(*a, **k):
        raise AssertionError("must not restart while ComfyUI is busy")
    monkeypatch.setattr(vs.subprocess, "run", boom)
    r = client.post("/comfyui/restart")
    assert r.status_code == 409
    j = r.get_json()
    assert j["error"] == "comfyui_busy" and j["running"] == 1 and j["pending"] == 2


def test_comfyui_restart_force_overrides_busy(client, comfy_ok, monkeypatch):
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy", lambda: (1, 0))        # busy, but force skips the check
    assert client.post("/comfyui/restart", json={"force": True}).get_json()["ok"] is True


def test_comfyui_restart_501_when_unavailable(client, monkeypatch):
    monkeypatch.setattr(rt_comfyui, "comfyui_instances", lambda: [])
    def boom(*a, **k):
        raise AssertionError("systemctl must not run when control is unavailable")
    monkeypatch.setattr(vs.subprocess, "run", boom)
    assert client.post("/comfyui/restart").status_code == 501


def test_comfyui_restart_attempts_all_and_names_the_failure(client, comfy_ok, monkeypatch):
    """One dead unit must not strand the other instance's VRAM: the healthy one still
    restarts, and the 502 names exactly which unit failed."""
    calls = []
    def run(cmd, **kw):
        calls.append(cmd)
        if "comfyui-gpu1.service" in cmd:
            return _FakeCompleted(returncode=1, stderr="Failed to restart comfyui-gpu1.service: not found.")
        return _FakeCompleted(0)
    monkeypatch.setattr(vs.subprocess, "run", run)
    r = client.post("/comfyui/restart")
    j = r.get_json()
    assert r.status_code == 502 and "comfyui-gpu1.service" in j["error"] and "not found" in j["error"]
    assert len(calls) == 2                       # the healthy instance was still restarted


def test_comfyui_defaults_to_one_instance(monkeypatch):
    """Use one instance by default, even when a remote host may expose two GPUs. One GPU is the ordinary case; a default of two
    makes every normal install carry a config it has to correct."""
    monkeypatch.delenv("VOCALIS_COMFYUI_SERVICE", raising=False)
    monkeypatch.delenv("VOCALIS_COMFYUI_URL", raising=False)
    monkeypatch.delenv("VOCALIS_COMFYUI_INSTANCES", raising=False)
    assert rt_comfyui.comfyui_configured({}) == [("comfyui.service", "http://127.0.0.1:8189")]


def test_comfyui_instance_count_generates_multi_instance_convention(monkeypatch):
    """The first instance is unsuffixed; later instances include their card index and
    carry their card index, one port band apart."""
    monkeypatch.delenv("VOCALIS_COMFYUI_SERVICE", raising=False)
    monkeypatch.delenv("VOCALIS_COMFYUI_URL", raising=False)
    assert rt_comfyui.comfyui_configured({"comfyui": {"instances": 3}}) == [
        ("comfyui.service",     "http://127.0.0.1:8189"),
        ("comfyui-gpu1.service", "http://127.0.0.1:8289"),
        ("comfyui-gpu2.service", "http://127.0.0.1:8389")]


def test_comfyui_explicit_lists_beat_the_count(monkeypatch):
    """A box with non-standard names still needs a way in, and it must not have to also
    get the count right — the explicit pair wins outright."""
    monkeypatch.delenv("VOCALIS_COMFYUI_SERVICE", raising=False)
    monkeypatch.delenv("VOCALIS_COMFYUI_URL", raising=False)
    cfg = {"comfyui": {"instances": 5, "services": ["a.service", "b.service"],
                       "urls": ["http://127.0.0.1:1/", "http://127.0.0.1:2"]}}
    assert rt_comfyui.comfyui_configured(cfg) == [("a.service", "http://127.0.0.1:1"),
                                           ("b.service", "http://127.0.0.1:2")]


def test_comfyui_config_accepts_a_yaml_list_or_a_comma_string(monkeypatch):
    """Both are natural to hand-write in YAML; accepting only one invites a silent miss."""
    monkeypatch.delenv("VOCALIS_COMFYUI_SERVICE", raising=False)
    monkeypatch.delenv("VOCALIS_COMFYUI_URL", raising=False)
    as_str = rt_comfyui.comfyui_configured({"comfyui": {"services": "a.service,b.service",
                                                 "urls": "http://x,http://y"}})
    as_list = rt_comfyui.comfyui_configured({"comfyui": {"services": ["a.service", "b.service"],
                                                  "urls": ["http://x", "http://y"]}})
    assert as_str == as_list == [("a.service", "http://x"), ("b.service", "http://y")]


def test_comfyui_env_beats_the_config_file(monkeypatch):
    """env → app_settings.yaml → default is the house rule (cleanup/kobold/voxcpm all use
    it); ComfyUI must not be the one place it reverses."""
    monkeypatch.setenv("VOCALIS_COMFYUI_INSTANCES", "2")
    monkeypatch.delenv("VOCALIS_COMFYUI_SERVICE", raising=False)
    monkeypatch.delenv("VOCALIS_COMFYUI_URL", raising=False)
    assert len(rt_comfyui.comfyui_configured({"comfyui": {"instances": 1}})) == 2


def test_comfyui_bad_instance_count_falls_back(monkeypatch):
    """A hand-edited `instances: two` must not sink the button."""
    monkeypatch.delenv("VOCALIS_COMFYUI_SERVICE", raising=False)
    monkeypatch.delenv("VOCALIS_COMFYUI_URL", raising=False)
    monkeypatch.delenv("VOCALIS_COMFYUI_INSTANCES", raising=False)
    assert rt_comfyui.comfyui_configured({"comfyui": {"instances": "two"}}) == [
        ("comfyui.service", "http://127.0.0.1:8189")]
    assert rt_comfyui.comfyui_configured({"comfyui": "oops"}) == [("comfyui.service",
                                                           "http://127.0.0.1:8189")]


def test_comfyui_instances_discovery_filters_on_unit_files(monkeypatch):
    """Env configures the pairs; systemd decides which exist HERE — a box with only
    the first unit behaves exactly as 4.7 did."""
    monkeypatch.setenv("VOCALIS_COMFYUI_SERVICE", "a.service,b.service")
    monkeypatch.setenv("VOCALIS_COMFYUI_URL", "http://127.0.0.1:1/,http://127.0.0.1:2")
    monkeypatch.setattr(vs.subprocess, "run",
        lambda cmd, **kw: _FakeCompleted(0, stdout="a.service enabled enabled\n"))
    rt_comfyui._COMFYUI_AVAIL = None
    try:
        assert rt_comfyui.comfyui_instances() == [("a.service", "http://127.0.0.1:1")]
        assert rt_comfyui.comfyui_control_available() is True
    finally:
        rt_comfyui._COMFYUI_AVAIL = None      # don't leak the cached answer into other tests


# ── Playground streaming (3.x): register endpoint + the stream source ─────────

def _pg_stream_body(**over):
    body = {"text": "Hello streaming playground.", "voice": "", "exaggeration": 0.5,
            "cfg": 0.5, "temperature": 0.8}
    body.update(over)
    return body


def test_playground_stream_registers_job_and_urls(client, tmp_output, monkeypatch):
    monkeypatch.setattr(rt_pool, "default_devices", lambda *_a, **_k: ["cpu"])
    monkeypatch.setattr(rt_pool, "default_workers", lambda *_a, **_k: 2)
    r = client.post("/playground/stream",
                    json=_pg_stream_body(gpus="cuda:9", workers=64, seed=7))  # stale keys ignored
    assert r.status_code == 202
    j = r.get_json()
    assert j["stream_url"].startswith("/speak/stream/")
    assert j["status_url"].endswith("/status")
    job = jobs_mod.JOBS[j["job_id"]]
    assert job.kind == "playground"
    assert job.gpus == ["cpu"] and job.workers == 2    # request echoes ignored — globals win
    assert job.status == "queued"                      # runs when the GET claims the token
    job.cancel.set()


def test_playground_stream_reports_resume_s(client, tmp_output):
    """A register whose identity has banked chunks reports their prefix duration
    (resume_s) so the player can start playback ~a minute behind the resume point."""
    body = _pg_stream_body(text="Resume seconds check, please.")
    h = playground_clips.clip_hash("", 0.5, 0.5, 0.8, body["text"], True)
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, h)
    ws.mkdir(parents=True)
    save_wav_sf(str(ws / "chunk_0000.wav"), torch.zeros(1, 48000), 24000)   # 2.0 s banked
    r = client.post("/playground/stream", json=body)
    assert r.status_code == 202
    j = r.get_json()
    assert j["resume_s"] == 2.0
    jobs_mod.JOBS[j["job_id"]].cancel.set()
    # a fresh identity reports 0
    r2 = client.post("/playground/stream", json=_pg_stream_body(text="Fresh, no bank."))
    assert r2.get_json()["resume_s"] == 0.0
    jobs_mod.JOBS[r2.get_json()["job_id"]].cancel.set()


def test_playground_stream_ignores_stale_turbo_key(client, tmp_output):
    """Turbo died app-wide (3.x) — a stale client still sending it must not error."""
    r = client.post("/playground/stream", json=_pg_stream_body(turbo=True))
    assert r.status_code == 202
    jobs_mod.JOBS[r.get_json()["job_id"]].cancel.set()


def test_playground_stream_always_renders_no_cached_shortcircuit(client, tmp_output):
    """Seedless identity: an existing clip at the same H does NOT short-circuit —
    Generate always renders (and the finished take overwrites the stored one)."""
    body = _pg_stream_body()
    h = playground_clips.clip_hash("", 0.5, 0.5, 0.8, body["text"], True)
    ref = web_playground._clip_ref_for("", body["text"], h)
    mp3, _y = playground_clips.clip_paths(vs.OUTPUT_DIR / "playground", ref)
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3x")
    r = client.post("/playground/stream", json=body)
    assert r.status_code == 202
    j = r.get_json()
    assert "cached" not in j and "stream_url" in j
    job = jobs_mod.JOBS[j["job_id"]]
    assert job.clip_h == h
    job.cancel.set()


def test_playground_stream_409_when_same_inputs_already_rendering(client, tmp_output):
    """Same-H concurrency guard: two live renders of one identity would write the
    same workspace's chunk files over each other."""
    body = _pg_stream_body(text="Concurrent render guard.")
    r1 = client.post("/playground/stream", json=body)
    assert r1.status_code == 202
    try:
        r2 = client.post("/playground/stream", json=body)
        assert r2.status_code == 409
        assert "already rendering" in r2.get_json()["error"]
    finally:
        job = jobs_mod.JOBS[r1.get_json()["job_id"]]
        job.status = "canceled"
        job.cancel.set()


class _SrPool:
    sr = 24000


def _mk_pg_job(text, h):
    return jobs_mod.Job(id="pgs-" + h[:4], docx="", voice="",
                  params=tts_utils.GenParams(voice=None, exaggeration=0.5, cfg=0.5,
                                      temperature=0.8),
                  gpus="cpu", workers=1, kind="playground",
                  text=text, narrate_actions=True, clip_h=h)


def test_playground_stream_gen_banks_and_finalizes(client, tmp_output, monkeypatch):
    """Fresh streamed render: chunks bank into the workspace as they finish, the
    final clip (MP3 + YAML) lands in the library, the workspace is removed, and
    the job ends 'done' with clip_ref set — the batch path's exact artifacts."""
    import vocalis_streaming as vstr
    chunks = ["Hello world."]
    job = _mk_pg_job("Hello world.", "d00d00d00d00")
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, job.clip_h)

    def fake_stream_message(pool, t, params, config=None, cancel=None, on_event=None,
                            chunks=None, chunk_base=0, on_chunk=None):
        wav = torch.zeros(1, 24000)
        for i, _c in enumerate(chunks):
            on_chunk(chunk_base + i, wav)              # bank like the real renderer
            yield wav.squeeze(0).numpy()
    monkeypatch.setattr(vstr, "stream_message", fake_stream_message)

    out = list(web_playground._playground_stream_gen(job, chunks, _SrPool(), threading.Event(), None))
    assert len(out) == 1
    assert job.status == "done" and job.clip_ref
    mp3, y = playground_clips.clip_paths(vs.OUTPUT_DIR / "playground", job.clip_ref)
    assert mp3.exists() and y.exists()
    assert not ws.exists()                     # workspace cleaned — the clip is the record


def test_playground_stream_gen_resumes_banked_prefix(client, tmp_output, monkeypatch):
    """Banked chunks replay from disk and the tail renders with chunk_base=prefix
    (GLOBAL indices) — the resume contract."""
    import vocalis_streaming as vstr
    chunks = ["First sentence.", "Second sentence."]
    job = _mk_pg_job("First sentence. Second sentence.", "beefbeefbeef")
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, job.clip_h)
    ws.mkdir(parents=True)
    save_wav_sf(str(ws / "chunk_0000.wav"), torch.zeros(1, 12000), 24000)   # banked chunk 0

    seen = {}
    def fake_stream_message(pool, t, params, config=None, cancel=None, on_event=None,
                            chunks=None, chunk_base=0, on_chunk=None):
        seen["chunk_base"], seen["chunks"] = chunk_base, list(chunks)
        wav = torch.zeros(1, 24000)
        on_chunk(chunk_base, wav)
        yield wav.squeeze(0).numpy()
    monkeypatch.setattr(vstr, "stream_message", fake_stream_message)

    out = list(web_playground._playground_stream_gen(job, chunks, _SrPool(), threading.Event(), None))
    assert seen["chunk_base"] == 1 and seen["chunks"] == ["Second sentence."]
    assert len(out) == 2                       # replayed chunk 0 + live chunk 1
    assert job.status == "done"
    assert not ws.exists()


def test_playground_stream_gen_resume_replays_only_lead_in(client, tmp_output, monkeypatch):
    """A large banked prefix must NOT re-stream in full — only the last LEAD_IN_CHUNKS
    replay for context; the tail still renders from chunk_base=prefix and the finished
    clip concatenates ALL chunks from disk. (Re-streaming the whole prefix idled the
    GPUs while minutes of already-rendered audio pumped to the browser.)"""
    import vocalis_streaming as vstr
    chunks = [f"Sentence {i}." for i in range(6)]
    job = _mk_pg_job(" ".join(chunks), "ca11ca11ca11")
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, job.clip_h)
    ws.mkdir(parents=True)
    for i in range(5):                                    # banked prefix = chunks 0..4
        save_wav_sf(str(ws / f"chunk_{i:04d}.wav"), torch.zeros(1, 12000), 24000)

    seen = {}
    def fake_stream_message(pool, t, params, config=None, cancel=None, on_event=None,
                            chunks=None, chunk_base=0, on_chunk=None):
        seen["chunk_base"], seen["chunks"] = chunk_base, list(chunks)
        wav = torch.zeros(1, 24000)
        on_chunk(chunk_base, wav)
        yield wav.squeeze(0).numpy()
    monkeypatch.setattr(vstr, "stream_message", fake_stream_message)

    out = list(web_playground._playground_stream_gen(job, chunks, _SrPool(), threading.Event(), None))
    assert seen["chunk_base"] == 5 and seen["chunks"] == ["Sentence 5."]   # tail starts at prefix
    assert len(out) == 3                       # last 2 banked replayed + 1 live tail chunk
    assert job.status == "done"
    assert not ws.exists()


def test_playground_stream_gen_cancel_keeps_workspace(client, tmp_output, monkeypatch):
    """Stop mid-stream: the workspace (banked chunks + manifest) survives for
    resume, the job ends 'canceled', and no clip reaches the library."""
    import vocalis_streaming as vstr
    chunks = ["First sentence.", "Second sentence."]
    job = _mk_pg_job("First sentence. Second sentence.", "cafecafecafe")
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, job.clip_h)
    cancel = threading.Event()

    def fake_stream_message(pool, t, params, config=None, cancel=None, on_event=None,
                            chunks=None, chunk_base=0, on_chunk=None):
        wav = torch.zeros(1, 24000)
        on_chunk(chunk_base, wav)
        yield wav.squeeze(0).numpy()
        cancel.set()                           # the Stop lands after the first chunk
    monkeypatch.setattr(vstr, "stream_message", fake_stream_message)

    list(web_playground._playground_stream_gen(job, chunks, _SrPool(), cancel, None))
    assert job.status == "canceled"
    assert ws.exists() and (ws / "pending.yaml").exists()
    assert (ws / "chunk_0000.wav").exists()    # banked progress kept
    assert not job.clip_ref                    # no clip
    assert not list((vs.OUTPUT_DIR / "playground").rglob("*.mp3"))


def test_playground_stream_gen_finalizes_when_listener_stops_consuming(
        client, tmp_output, monkeypatch):
    """A 620-chunk render finished on the GPUs, but the
    browser had stopped draining the stream (MediaSource quota backpressure with
    playback stalled), so the generator never reached its tail — no clip, job stuck
    'running', Cancel stuck lit. The render is complete when the LAST CHUNK LANDS ON
    DISK, not when the listener finishes the audio: the clip must appear even though
    nobody ever pulls another window out of this generator."""
    import vocalis_streaming as vstr
    chunks = [f"Sentence {i}." for i in range(4)]
    job = _mk_pg_job(" ".join(chunks), "f00df00df00d")
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, job.clip_h)

    def fake_stream_message(pool, t, params, config=None, cancel=None, on_event=None,
                            chunks=None, chunk_base=0, on_chunk=None):
        wav = torch.zeros(1, 24000)
        for i, _c in enumerate(chunks):        # the pool banks every chunk...
            on_chunk(chunk_base + i, wav)
        for _c in chunks:                      # ...but the listener only ever takes one
            yield wav.squeeze(0).numpy()
    monkeypatch.setattr(vstr, "stream_message", fake_stream_message)

    gen = web_playground._playground_stream_gen(job, chunks, _SrPool(), threading.Event(), None)
    next(gen)                                  # one window out, then the consumer wedges

    # Finalize runs on its own thread, started from the banking hook of the last chunk -- which
    # fired synchronously inside next(gen) above, so the thread exists (or has already finished)
    # by now. Join it by its name instead of sleeping until job.status flips.
    for t in [t for t in threading.enumerate() if t.name == f"pg-finalize-{job.id}"]:
        t.join(timeout=10)
        assert not t.is_alive(), "the finalize thread never finished"
    assert job.status == "done" and job.clip_ref     # finalized off the banking hook
    mp3, y = playground_clips.clip_paths(vs.OUTPUT_DIR / "playground", job.clip_ref)
    assert mp3.exists() and y.exists()
    assert not ws.exists()

    gen.close()                                # the wedged listener finally goes away
    assert job.status == "done"                # ...which is NOT a cancel: the clip stands


def test_playground_clip_rename_endpoint(client, tmp_output):
    """POST /playground/clips/<ref>/rename moves both files, keeps the _H8 identity
    suffix, and the library lists the new name; bad names 400, unknown refs 404."""
    ref = "Narrator_3/Hello_there_ab12cd34"
    mp3, y = playground_clips.clip_paths(vs.OUTPUT_DIR / "playground", ref)
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3x")
    playground_clips.write_clip_yaml(y, {"voice": "", "text": "Hello there."})
    r = client.post(f"/playground/clips/{ref}/rename", json={"name": "Renamed Clip"})
    assert r.status_code == 200
    assert r.get_json()["ref"] == "Narrator_3/Renamed_Clip_ab12cd34"
    names = [c["name"] for c in client.get("/playground/clips").get_json()]
    assert names == ["Renamed Clip"]
    assert client.post(f"/playground/clips/{ref}/rename",
                       json={"name": "x"}).status_code == 404          # old ref is gone
    assert client.post("/playground/clips/Narrator_3/Renamed_Clip_ab12cd34/rename",
                       json={"name": "  "}).status_code == 400


def test_clip_list_shows_cosmetic_voice_label(client, tmp_output, monkeypatch, tmp_path):
    """The library's Voice column shows the voice's COSMETIC label when one is
    set (Voices tab), for clips AND partials. Identity/refs still key on the
    exact filename in the sidecar — only the display string changes."""
    settings = tmp_path / "voice_settings.yaml"
    settings.write_text("global:\n  Sample_Voice_voice_sample_v1.wav:\n    label: SampleVoice\n",
                        encoding="utf-8")
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", settings)
    ref = "Test_Character_voice_sample_v1/Hello_ab12cd34"
    mp3, y = playground_clips.clip_paths(vs.OUTPUT_DIR / "playground", ref)
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3x")
    playground_clips.write_clip_yaml(y, {"voice": "Sample_Voice_voice_sample_v1.wav",
                                         "text": "Hello."})
    playground_clips.write_pending(
        playground_clips.workspace(web_playground.CHUNKS_ROOT, "feedfacecafe"),
        {"voice": "Sample_Voice_voice_sample_v1.wav", "text": "hi", "total": 2})
    rows = client.get("/playground/clips").get_json()
    assert len(rows) == 2                                      # the clip + the partial
    assert {r["voice_label"] for r in rows} == {"SampleVoice"}
    # sidecar identity is untouched — still the exact filename
    assert {r["voice"] for r in rows} == {"Sample_Voice_voice_sample_v1.wav"}
    # a voice with NO label keeps the previous display (dir / narrator name)
    ref2 = "OtherVoice/Hi_there_ab12cd35"
    mp3b, yb = playground_clips.clip_paths(vs.OUTPUT_DIR / "playground", ref2)
    mp3b.parent.mkdir(parents=True, exist_ok=True)
    mp3b.write_bytes(b"ID3x")
    playground_clips.write_clip_yaml(yb, {"voice": "OtherVoice.wav", "text": "Hi."})
    rows = client.get("/playground/clips").get_json()
    assert {r["voice_label"] for r in rows} == {"SampleVoice", "OtherVoice"}


def test_partial_rename_endpoint_and_finish_stem(client, tmp_output):
    """POST /playground/partials/<h>/rename stores the name; the finished clip's
    stem then carries it (via _clip_ref_for) instead of the text-derived words."""
    h = "feedfacecafe"
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, h)
    playground_clips.write_pending(ws, {"voice": "", "text": "Some long story text here.",
                                        "total": 3})
    r = client.post(f"/playground/partials/{h}/rename", json={"name": "Partial Clip"})
    assert r.status_code == 200 and r.get_json()["name"] == "Partial Clip"
    assert web_playground._clip_ref_for("", "Some long story text here.", h) == f"default/Partial_Clip_{h[:8]}"
    assert client.post("/playground/partials/000011112222/rename",
                       json={"name": "x"}).status_code == 404
    assert client.post(f"/playground/partials/{h}/rename",
                       json={"name": " "}).status_code == 400


def test_favorite_endpoints_clip_and_partial(client, tmp_output):
    ref = "Narrator_3/fav_me_ab12cd34"
    mp3, y = playground_clips.clip_paths(vs.OUTPUT_DIR / "playground", ref)
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3x")
    playground_clips.write_clip_yaml(y, {"voice": "", "text": "Fav me."})
    r = client.post(f"/playground/clips/{ref}/favorite", json={"favorite": True})
    assert r.status_code == 200 and r.get_json()["favorite"] is True
    assert client.get("/playground/clips").get_json()[0]["favorite"] is True
    assert client.post("/playground/clips/Narrator_3/ghost_ab12cd99/favorite",
                       json={"favorite": True}).status_code == 404
    h = "feedfacecafe"
    playground_clips.write_pending(playground_clips.workspace(web_playground.CHUNKS_ROOT, h),
                                   {"voice": "", "text": "Partial fav.", "total": 2})
    r2 = client.post(f"/playground/partials/{h}/favorite", json={"favorite": True})
    assert r2.status_code == 200 and r2.get_json()["favorite"] is True


def test_finished_clip_carries_partial_name_and_favorite(client, fake_pg, tmp_output):
    """Rename + ★ a partial, let the render finish: the clip keeps both (name in
    the sidecar exactly as typed, favorite flag set, stem from the custom name)."""
    body = {"text": "Carry my name and star.", "gpus": "cpu"}
    h = playground_clips.clip_hash("", 0.5, 0.5, 0.8, body["text"], True)
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, h)
    playground_clips.write_pending(ws, {"voice": "", "text": body["text"], "total": 1})
    assert client.post(f"/playground/partials/{h}/rename",
                       json={"name": "_Keeper scene"}).status_code == 200
    assert client.post(f"/playground/partials/{h}/favorite",
                       json={"favorite": True}).status_code == 200
    j = client.post("/playground/generate", json=body).get_json()
    st = _wait_terminal(client, j["job_id"])
    assert st["status"] == "done"
    assert st["clip"] == f"default/_Keeper_scene_{h[:8]}"      # custom-name stem
    c = client.get("/playground/clips").get_json()[0]
    assert c["name"] == "_Keeper scene" and c["favorite"] is True


def test_playground_generate_ignores_request_gpus_workers(client, tmp_output, monkeypatch):
    monkeypatch.setattr(rt_pool, "default_devices", lambda *_a, **_k: ["cpu"])
    monkeypatch.setattr(rt_pool, "default_workers", lambda *_a, **_k: 4)
    monkeypatch.setattr(web_playground, "run_playground_job", lambda job: None)   # don't load a real pool
    r = client.post("/playground/generate",
                    json={"text": "ignore my knobs.", "seed": 5, "gpus": "cuda:9", "workers": 64})
    assert r.status_code == 202
    job = jobs_mod.JOBS[r.get_json()["job_id"]]
    job.cancel.set()
    assert job.gpus == ["cpu"] and job.workers == 4


def test_playground_job_renders_on_a_satellite_only_selection(client, tmp_output, monkeypatch):
    """A satellite-only selection must not be replaced by local-device defaults.

    Resolve the pool from the selected device so the satellite receives the render request and
    its replicas remain available through `current_pool()`.

    Deliberately driven through the real settings rather than by patching `default_devices`:
    the bug was that the job asked the WRONG function, and a patched answer would hide it.
    """
    import vocalis.runtime.settings as settings_mod
    monkeypatch.setattr(settings_mod, "load_app_settings",
                        lambda: {"devices": [{"id": "cuda:0", "enabled": False},
                                             {"id": 'test-satellite:cuda:0', "enabled": True}]})
    monkeypatch.setattr(web_playground, "run_playground_job", lambda job: None)
    r = client.post("/playground/generate", json={"text": "render me on the 4090."})
    assert r.status_code == 202
    job = jobs_mod.JOBS[r.get_json()["job_id"]]
    job.cancel.set()
    assert job.gpus == ['test-satellite:cuda:0'], (
        f"the job would render on {job.gpus!r} — a satellite-only selection must not fall "
        f"back to the CPU")
    assert rt_pool.resolve_devices(job.gpus) == ['test-satellite:cuda:0']


@pytest.mark.parametrize("route,body", [
    ("/playground/generate", {"text": "one."}),
    ("/playground/stream", {"text": "two."}),
])
def test_every_job_building_route_carries_the_satellite(route, body, client, tmp_output,
                                                        monkeypatch):
    """The test above covers ONE of the routes that build a job from `default_devices()`.

    ⚠️ The others were covered only incidentally: their tests patch `default_devices` and so
    fail on a revert because the patch stops applying, not because anything asserts satellite
    behavior. Driven through real settings, a revert to `parse_devices(default_gpus())` shows
    up here as `['cpu']`.
    """
    import vocalis.runtime.settings as settings_mod
    monkeypatch.setattr(settings_mod, "load_app_settings",
                        lambda: {"devices": [{"id": "cuda:0", "enabled": False},
                                             {"id": 'test-satellite:cuda:0', "enabled": True}]})
    monkeypatch.setattr(web_playground, "run_playground_job", lambda job: None)
    monkeypatch.setattr(web_playground, "run_playground_stream", lambda job: None, raising=False)
    r = client.post(route, json=body)
    assert r.status_code in (200, 202), r.get_data(as_text=True)[:200]
    job = jobs_mod.JOBS[r.get_json()["job_id"]]
    job.cancel.set()
    assert job.gpus == ['test-satellite:cuda:0'], f"{route} would render on {job.gpus!r}"


def test_the_devices_a_job_carries_are_the_devices_the_pool_is_built_on(client, tmp_output,
                                                                        monkeypatch):
    """The selected device list must determine the pool used by the job.

    Every test above stubs `run_playground_job` out, so `job.gpus` is asserted and then dropped.
    The downstream path is `resolve_devices(job.gpus)` → `get_pool(devices, …)`,
    which is where a `'cpu'` signature tore the satellite's replicas down. This lets the runner
    run with `get_pool` recording what it was asked to build.
    """
    import vocalis.runtime.settings as settings_mod
    monkeypatch.setattr(settings_mod, "load_app_settings",
                        lambda: {"devices": [{"id": "cuda:0", "enabled": False},
                                             {"id": 'test-satellite:cuda:0', "enabled": True}]})
    built = {}
    asked = threading.Event()

    def _get_pool(devices, workers):
        built["devices"], built["workers"] = list(devices), workers
        asked.set()
        raise RuntimeError("stop here — the pool signature is what this test is about")

    monkeypatch.setattr(rt_pool, "get_pool", _get_pool)
    r = client.post("/playground/generate", json={"text": "on the 4090, please."})
    assert r.status_code == 202
    job = jobs_mod.JOBS[r.get_json()["job_id"]]
    assert asked.wait(timeout=10), "the runner never asked for a pool"   # the runner is a thread
    job.cancel.set()
    assert built.get("devices") == ['test-satellite:cuda:0'], (
        f"the pool was built on {built.get('devices')!r} — 'cpu' here is the bug that tore the "
        f"satellite's replicas down mid-render")
    # One replica on the ticked satellite card — and the saved `workers: 2` that used to sit in
    # the fixture above is exactly what 5.4.1 stopped letting through to here.
    assert built.get("workers") == {'test-satellite:cuda:0': 1}


def test_comfyui_detect_false_without_systemctl(monkeypatch):
    """No systemctl (dev box / Windows) -> detection is False, so the button stays hidden."""
    def no_systemctl(*a, **k):
        raise FileNotFoundError("systemctl")
    monkeypatch.setattr(vs.subprocess, "run", no_systemctl)
    rt_comfyui._COMFYUI_AVAIL = None
    try:
        assert rt_comfyui.comfyui_control_available() is False
    finally:
        rt_comfyui._COMFYUI_AVAIL = None      # don't leak the cached answer into other tests


def test_model_unload_frees_pool(client):
    class _P:                                  # unload calls pool.shutdown() to free replicas
        def shutdown(self): pass
    rt_pool._pool = _P(); rt_pool._pool_sig = ("x",)
    try:
        r = client.post("/model/unload")
        assert r.status_code == 200 and r.get_json()["model_ready"] is False
        assert rt_pool._pool is None and rt_pool._pool_sig is None       # replicas dropped
    finally:
        rt_pool._pool = None; rt_pool._pool_sig = None


def test_model_unload_409_while_rendering(client):
    assert vs.GPUS.acquire(timeout=1)                      # simulate a render holding the GPUs
    try:
        assert client.post("/model/unload").status_code == 409
    finally:
        vs.GPUS.release()


def test_model_load_noop_when_ready(client):
    rt_pool._pool = object()
    try:
        j = client.post("/model/load").get_json()
        assert j["model_ready"] is True and j["already"] is True
    finally:
        rt_pool._pool = None


def test_model_load_spawns_preload_when_unloaded(client, monkeypatch):
    rt_pool._pool = None
    calls = {"n": 0}
    ran = threading.Event()
    def _preload():
        calls["n"] += 1
        ran.set()
    monkeypatch.setattr(rt_pool, "preload_default_pool", _preload)
    r = client.post("/model/load")
    assert r.status_code == 200 and r.get_json().get("loading") is True
    assert ran.wait(timeout=10), "the preload thread never ran"   # daemon thread
    assert calls["n"] == 1


def test_index_page_served(client):
    r = client.get("/")
    assert r.status_code == 200 and b"Vocalis" in r.data


def test_every_placeholder_the_template_declares_is_actually_substituted(client):
    """🔴 5.1.1: `{{ADMIN_USER}}` was served to the browser VERBATIM for the whole of 5.1.

    P4.15's mechanical `ADMIN_USER` -> `auth.ADMIN_USER` rename landed inside the STRING
    LITERAL as well as on the name, so `index()` searched for `{{auth.ADMIN_USER}}`, which
    the template does not contain, and `.replace()` became a silent no-op. Same class as the
    two `url_for` traps -- an identifier living in a string, invisible to every AST audit.

    It was not cosmetic. index.html reads that meta into `$('setU').value`, and `applyLogin()`
    POSTs that field to /admin/set-credentials -- so changing the password from the settings
    gear RENAMED THE ADMIN ACCOUNT to the literal `{{ADMIN_USER}}`, and the next login 401'd.
    On an encrypted install /login is the only caller of unlock_with_password, so that is a
    lockout, recoverable only via scripts/set-admin-credentials.sh or by burning the recovery
    key.

    Derive the assertion FROM THE TEMPLATE rather than listing placeholders here: a per-token
    check is exactly what missed this (test_m6_e2e pinned {{UI_STATE}} and nothing else), and
    a hardcoded list rots the moment someone adds a placeholder. Scanning the response for a
    bare `{{` would be wrong in the other direction -- {{UI_STATE}} expands to the user's own
    prose, which may legitimately contain braces.

    🔴 **UPPERCASE ONLY, AND THAT IS ENFORCED RATHER THAN ASSUMED (7.0).** `{{user}}` and
    `{{char}}` are SILLYTAVERN's template variables. This app is a character-card editor, so they
    appear all over its prose, its help text and its comments -- and a scan that treated them as
    OUR placeholders reported the find-and-replace documentation as an unsubstituted token. The
    convention is that our placeholders are SCREAMING_CASE, and `test_the_servers_own_placeholders_
    are_all_uppercase` below holds the server to it, so narrowing this regex cannot hide a real
    one: a lowercase `{{foo}}` added to `ui.py` fails that test by name."""
    import re as _re
    template = (rt_paths.WEBUI / "index.html").read_text(encoding="utf-8")
    declared = set(_re.findall(r"\{\{[A-Z][A-Z0-9_]*\}\}", template))
    assert declared, "no placeholders found -- the scan itself is broken"

    html = client.get("/").get_data(as_text=True)
    survived = sorted(p for p in declared if p in html)
    assert not survived, f"served to the browser unsubstituted: {survived}"


def test_the_servers_own_placeholders_are_all_uppercase():
    """The other half of the test above, and what makes narrowing its regex safe.

    That scan only looks for `{{UPPERCASE}}`, because SillyTavern's `{{user}}` / `{{char}}` are
    ordinary prose in this application. This one reads `ui.py` and fails if the server ever
    substitutes a name that scan would not have caught -- so the pair covers every placeholder
    without either of them carrying a hardcoded list.
    """
    import inspect
    import re as _re

    from vocalis.web import ui as web_ui

    names = _re.findall(r'\.replace\(\s*"\{\{([^}]+)\}\}"', inspect.getsource(web_ui))
    assert names, "no substitutions found in ui.py -- this check is looking in the wrong place"
    bad = [n for n in names if not _re.fullmatch(r"[A-Z][A-Z0-9_]*", n)]
    assert not bad, (
        f"these placeholders are not SCREAMING_CASE: {bad}. The unsubstituted-placeholder scan "
        f"only looks for uppercase names, because {{{{user}}}} and {{{{char}}}} are SillyTavern's "
        f"variables and appear throughout this app's own prose. Rename these, or widen both "
        f"checks together.")


def test_gpus_and_stats(client):
    assert client.get("/gpus").status_code == 200
    stats = client.get("/gpus/stats").get_json()
    assert isinstance(stats, list)          # [] on CPU-only, else per-card dicts
    for s in stats:                         # real whole-card used + Vocalis's share
        assert {"index", "name", "total_gb", "free_gb", "used_gb", "vocalis_gb"} <= set(s)
        assert s["used_gb"] >= s["vocalis_gb"]      # Vocalis's share is part of total used


def test_voices_lists_samples(client):
    v = client.get("/voices").get_json()
    assert isinstance(v, list)
    assert all("name" in e for e in v)


# ── parse ─────────────────────────────────────────────────────────────────────

def test_book_parse_ok(client, tmp_path):
    docx = tmp_path / "b.docx"
    make_test_docx(docx, num_chapters=3)
    r = client.post("/book/parse", json={"path": str(docx)})
    assert r.status_code == 200
    assert len(r.get_json()["chapters"]) == 3


def test_book_parse_rejects_missing_and_nondocx(client, tmp_path):
    assert client.post("/book/parse", json={"path": str(tmp_path / "nope.docx")}).status_code == 400
    txt = tmp_path / "x.txt"; txt.write_text("hi")
    assert client.post("/book/parse", json={"path": str(txt)}).status_code == 400


def test_book_parse_accepts_epub(client, tmp_path):        # M8
    epub = tmp_path / "b.epub"
    make_test_epub(epub, num_chapters=3)
    r = client.post("/book/parse", json={"path": str(epub)})
    assert r.status_code == 200
    assert len(r.get_json()["chapters"]) == 3


def test_book_parse_returns_bad_request_for_invalid_epub(client, tmp_path):
    epub = tmp_path / "invalid.epub"
    epub.write_bytes(b"not a ZIP archive")
    response = client.post("/book/parse", json={"path": str(epub)})
    assert response.status_code == 400
    assert response.get_json()["error"].startswith("parse failed:")


# ── Book library: upload / list / inspect / delete (browse, no manual path) ───

@pytest.fixture
def tmp_books(monkeypatch, tmp_path):
    bd = tmp_path / "books"; bd.mkdir()
    monkeypatch.setattr(rt_paths, "BOOKS_DIR", bd)
    return bd


def _upload_book(client, filename, data, overwrite=False):
    import io as _io
    form = {"file": (_io.BytesIO(data), filename)}
    if overwrite:
        form["overwrite"] = "true"
    return client.post("/books", data=form, content_type="multipart/form-data")


def test_books_upload_list_inspect_delete(client, tmp_books, tmp_path):
    docx = tmp_path / "MyBook.docx"
    make_test_docx(docx, num_chapters=3)
    r = _upload_book(client, "MyBook.docx", docx.read_bytes())
    assert r.status_code == 200 and r.get_json()["name"] == "MyBook.docx"
    assert (tmp_books / "MyBook.docx").exists()

    lst = client.get("/books").get_json()
    assert any(b["name"] == "MyBook.docx" and b["size"] > 0 for b in lst)

    o = client.get("/books/MyBook.docx/inspect").get_json()      # size + chapters + words
    assert len(o["chapters"]) == 3 and o["words"] > 0 and o["size"] > 0
    assert o["path"].endswith("MyBook.docx")

    assert client.delete("/books/MyBook.docx").status_code == 200
    assert all(b["name"] != "MyBook.docx" for b in client.get("/books").get_json())


def test_books_upload_rejects_non_book(client, tmp_books):
    assert _upload_book(client, "notes.txt", b"not a book").status_code == 400


def test_books_upload_409_then_overwrite(client, tmp_books, tmp_path):
    docx = tmp_path / "Dup.docx"; make_test_docx(docx, num_chapters=1)
    data = docx.read_bytes()
    assert _upload_book(client, "Dup.docx", data).status_code == 200
    assert _upload_book(client, "Dup.docx", data).status_code == 409
    assert _upload_book(client, "Dup.docx", data, overwrite=True).status_code == 200


def test_books_upload_sanitizes_traversal_filename(client, tmp_books, tmp_path):
    docx = tmp_path / "e.docx"; make_test_docx(docx, num_chapters=1)
    r = _upload_book(client, "../../evil.docx", docx.read_bytes())
    assert r.status_code == 200
    assert r.get_json()["name"] == "evil.docx"                    # path parts stripped
    assert (tmp_books / "evil.docx").exists()
    assert not (tmp_books.parent / "evil.docx").exists()          # nothing escaped books/


def test_books_delete_404_missing(client, tmp_books):
    assert client.delete("/books/nope.docx").status_code == 404


def test_books_inspect_rejects_traversal(client, tmp_books, tmp_path):
    (tmp_books.parent / "secret.docx").write_bytes(b"secret")
    for frag in ["..%2fsecret.docx", "..%2f..%2fsecret.docx"]:
        assert client.get(f"/books/{frag}/inspect").status_code != 200


# ── job lifecycle + SSE ───────────────────────────────────────────────────────

def test_job_runs_to_completion(client, fake_pipeline, tmp_path, tmp_output):
    docx = tmp_path / "book.docx"
    make_test_docx(docx, num_chapters=2)
    r = client.post("/book/start", json={"path": str(docx), "gpus": "cpu", "workers": 1})
    job_id = r.get_json()["job_id"]
    st = _wait_terminal(client, job_id)
    assert st["status"] == "done"
    assert len(st["sections"]) == 2
    assert st["output_dir"]


def test_sse_replays_backlog_and_terminates(client, fake_pipeline, tmp_path, tmp_output):
    docx = tmp_path / "book.docx"
    make_test_docx(docx, num_chapters=2)
    job_id = client.post("/book/start", json={"path": str(docx), "gpus": "cpu"}).get_json()["job_id"]
    _wait_terminal(client, job_id)
    # GET the SSE stream AFTER completion: must replay the buffered events and
    # terminate (the bug fix) rather than block forever.
    data = client.get(f"/book/events/{job_id}").get_data(as_text=True)
    types = [json.loads(l[6:])["type"] for l in data.splitlines() if l.startswith("data: ")]
    assert "sections" in types
    assert types.count("chunk_done") == 2
    assert types[-1] == "job_done"


def test_cancel_sets_flag(client, fake_pipeline, tmp_path, tmp_output):
    docx = tmp_path / "book.docx"
    make_test_docx(docx, num_chapters=1)
    job_id = client.post("/book/start", json={"path": str(docx), "gpus": "cpu"}).get_json()["job_id"]
    r = client.post(f"/book/cancel/{job_id}")
    assert r.status_code == 200 and r.get_json()["ok"] is True
    _wait_terminal(client, job_id)   # let the job thread finish under the fakes


def test_status_and_events_404_for_unknown_job(client):
    assert client.get("/book/status/nope").status_code == 404
    assert client.get("/book/events/nope").status_code == 404


def test_canceled_job_emits_terminal_and_sse_terminates(client, fake_pipeline, tmp_path, tmp_output):
    """A canceled job must emit a terminal 'canceled' event so the SSE stream (and
    the UI) closes — the bug was that cancel emitted no terminal event, so the
    stream blocked on q.get() forever."""
    docx = tmp_path / "cx.docx"
    make_test_docx(docx, num_chapters=2)
    job = jobs_mod.Job(id="cxjob", docx=str(docx), voice="V.wav", params=tts_utils.GenParams(),
                 gpus="cpu", workers=1)
    job.cancel.set()                              # cancel before it processes any section
    with jobs_mod.JOBS_LOCK:
        jobs_mod.JOBS[job.id] = job
    web_books.run_job(job)                                # run synchronously under the fakes
    assert job.status == "canceled"
    assert [e["type"] for e in job.events][-1] == "canceled"
    # SSE replay must terminate on the canceled terminal, not hang
    data = client.get(f"/book/events/{job.id}").get_data(as_text=True)
    types = [json.loads(l[6:])["type"] for l in data.splitlines() if l.startswith("data: ")]
    assert types[-1] == "canceled"


def test_different_narrator_warns_switching_to_model_default(client, fake_pipeline, tmp_path, tmp_output):
    """A book rendered with a cloned voice, re-rendered with the model default (''),
    is a DIFFERENT narrator: 409 different_narrator (it forks a separate library
    entry), and confirm_new_narrator lets it through."""
    docx, r = _run_book(client, tmp_path, tmp_output, name="vcd", voice="TestVoice.wav")
    _wait_terminal(client, r.get_json()["job_id"])
    r2 = client.post("/book/start", json={"path": str(docx), "gpus": "cpu", "voice": ""})
    assert r2.status_code == 409
    j2 = r2.get_json()
    assert j2["error"] == "different_narrator"
    assert j2["prev_narrator"] == "TestVoice"
    assert j2["new_narrator"] == "the model default voice"
    r3 = client.post("/book/start", json={"path": str(docx), "gpus": "cpu",
                                          "voice": "", "confirm_new_narrator": True})
    assert r3.status_code == 200


def test_different_narrator_warns_switching_from_model_default(client, fake_pipeline, tmp_path, tmp_output):
    """The reverse direction — a book rendered with the model default ('') then
    re-rendered with a cloned voice — is also a different narrator and must 409 (the
    plain '<book>' folder is matched as the prior render)."""
    docx, r = _run_book(client, tmp_path, tmp_output, name="vcd2", voice="")
    _wait_terminal(client, r.get_json()["job_id"])
    r2 = client.post("/book/start", json={"path": str(docx), "gpus": "cpu", "voice": "TestVoice.wav"})
    assert r2.status_code == 409
    assert r2.get_json()["error"] == "different_narrator"
    assert r2.get_json()["prev_narrator"] == "the model default voice"
    # explicit confirm forks the separate "(TestVoice)" render
    r3 = client.post("/book/start", json={"path": str(docx), "gpus": "cpu",
                                          "voice": "TestVoice.wav", "confirm_new_narrator": True})
    assert r3.status_code == 200


def test_book_start_rejects_bad_params(client, tmp_path, tmp_output):
    """Malformed numeric fields → clean 400, not an unguarded float()/int() 500.
    (`workers` is NOT validated any more — request-body gpus/workers are ignored
    leftovers; the server reads the global settings — see the ignore test below.)"""
    docx = tmp_path / "bp.docx"
    make_test_docx(docx, num_chapters=1)
    assert client.post("/book/start",
                       json={"path": str(docx), "gpus": "cpu", "exaggeration": "high"}).status_code == 400


def test_book_start_ignores_request_gpus_workers(client, tmp_path, tmp_output, monkeypatch):
    """gpus/workers in the request body are legacy echoes — the job must be built
    from the GLOBAL settings regardless of what the request claims."""
    docx = tmp_path / "ig.docx"
    make_test_docx(docx, num_chapters=1)
    monkeypatch.setattr(rt_pool, "default_devices", lambda *_a, **_k: ["cpu"])
    monkeypatch.setattr(rt_pool, "default_workers", lambda *_a, **_k: 3)
    monkeypatch.setattr(web_books, "run_job", lambda job: None)   # don't load a real pool
    r = client.post("/book/start", json={"path": str(docx), "gpus": "cuda:7", "workers": 0})
    assert r.status_code == 200
    job = jobs_mod.JOBS[r.get_json()["job_id"]]
    assert job.gpus == ["cpu"] and job.workers == 3


def test_book_start_rejects_nan_inf_and_out_of_range(client, tmp_path, tmp_output):
    """float('nan') parses fine and defeats every </> range check (all NaN
    comparisons are False); inf and out-of-range values must be rejected too."""
    docx = tmp_path / "nan.docx"
    make_test_docx(docx, num_chapters=1)
    for bad in [{"exaggeration": "nan"}, {"cfg": "inf"}, {"temperature": 1e999},
                {"cfg": 2.0}, {"exaggeration": -1}]:
        r = client.post("/book/start", json={"path": str(docx), "gpus": "cpu", **bad})
        assert r.status_code == 400, f"{bad} was accepted"


def test_voice_request_input_is_sanitized(client, fake_pipeline, tmp_path, tmp_output):
    """The voice field is request input — path components must be stripped so it
    can never point the model's conditioning sample outside voice_samples/."""
    docx = tmp_path / "vsan.docx"
    make_test_docx(docx, num_chapters=1)
    r = client.post("/book/start", json={"path": str(docx), "gpus": "cpu",
                                         "voice": "../../../evil.wav"})
    assert r.status_code == 200
    st = _wait_terminal(client, r.get_json()["job_id"])
    assert st["voice"] == "evil.wav"             # traversal components stripped


def test_playground_queues_behind_render_and_cancel_works(client, tmp_output):
    """2.3: playground renders are jobs — busy GPUs mean the job QUEUES (visible
    'Waiting for the GPUs' log) instead of a 503, and Cancel works while waiting."""
    assert vs.GPUS.acquire(timeout=1)        # simulate a running book job
    try:
        r = client.post("/playground/generate", json={"text": "Hello there.", "gpus": "cpu", "seed": 1})
        assert r.status_code == 202
        job_id = r.get_json()["job_id"]
        _wait_for_job_log(jobs_mod.JOBS[job_id], "Waiting for the GPUs")   # job thread is in the wait loop
        client.post(f"/book/cancel/{job_id}")
        st = _wait_terminal(client, job_id, timeout=15)
        assert st["status"] == "canceled" and st["kind"] == "playground"
    finally:
        vs.GPUS.release()


def test_cancel_works_while_waiting_for_gen_lock(client, fake_pipeline, tmp_path, tmp_output):
    """A job queued behind a long render must still be cancellable — with a plain
    `with GPUS:` its Cancel would be a no-op until the current holder finished."""
    docx = tmp_path / "cw.docx"
    make_test_docx(docx, num_chapters=1)
    assert vs.GPUS.acquire(timeout=1)        # hold the lock like a running book
    try:
        r = client.post("/book/start", json={"path": str(docx), "gpus": "cpu"})
        job_id = r.get_json()["job_id"]
        _wait_for_job_log(jobs_mod.JOBS[job_id], "Waiting for the GPUs")   # job thread is in the wait loop
        client.post(f"/book/cancel/{job_id}")
        st = _wait_terminal(client, job_id, timeout=15)
        assert st["status"] == "canceled"       # canceled WITHOUT the lock ever freeing
        with jobs_mod.JOBS_LOCK:
            job = jobs_mod.JOBS[job_id]
        assert job.events[-1]["type"] == "canceled"   # terminal SSE event emitted
    finally:
        vs.GPUS.release()


def test_get_pool_rebuilds_when_poisoned(monkeypatch):
    """After a stall abort the pool is poisoned (a zombie thread may share its
    replicas); the SAME signature must rebuild rather than reuse it."""
    builds = []
    class _FakePool:
        def __init__(self, devices, workers):
            builds.append(1); self.sr = FAKE_SR; self.poisoned = False
        def shutdown(self): pass               # get_pool shuts the old pool down on rebuild
    monkeypatch.setattr(rt_pool, "WorkerPool", _FakePool)
    rt_pool._pool = None; rt_pool._pool_sig = None
    try:
        p1 = rt_pool.get_pool(["cuda:0"], 1)
        assert rt_pool.get_pool(["cuda:0"], 1) is p1 and len(builds) == 1   # cached
        p1.poisoned = True
        p2 = rt_pool.get_pool(["cuda:0"], 1)
        assert p2 is not p1 and len(builds) == 2                              # rebuilt
    finally:
        rt_pool._pool = None; rt_pool._pool_sig = None


def test_prune_jobs_caps_finished_and_keeps_running(monkeypatch):
    """JOBS can't grow unbounded: finished jobs beyond JOBS_KEEP are dropped, but a
    running job is never pruned.

    Patched on `vocalis.runtime.jobs`, not on `vocalis_server` (5.1-P2). The registry moved
    there; `jobs_mod.JOBS` is now a re-export, i.e. a second NAME for the same dict. Rebinding the
    re-export — which is what this test used to do — leaves `prune_jobs` reading the original
    dict and the original cap out of its own module, so it pruned something else entirely and
    the assertions below were measuring an untouched dict. Mutating a re-export is fine and ~20
    other sites do it; REBINDING one is not, and this is the test that says so out loud.
    """
    from vocalis.runtime import jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "JOBS", {})
    monkeypatch.setattr(jobs_mod, "JOBS_KEEP", 5)

    def add(jid, status):
        j = jobs_mod.Job(id=jid, docx="x", voice="", params=tts_utils.GenParams(),
                   gpus="cpu", workers=1)
        j.status = status
        jobs_mod.JOBS[jid] = j
        jobs_mod.prune_jobs()

    running = jobs_mod.Job(id="run", docx="x", voice="", params=tts_utils.GenParams(),
                     gpus="cpu", workers=1)
    running.status = "running"
    jobs_mod.JOBS["run"] = running
    for i in range(20):
        add(f"j{i}", "done")
    assert "run" in jobs_mod.JOBS                          # running job survives every prune
    assert len(jobs_mod.JOBS) <= jobs_mod.JOBS_KEEP + 1    # bounded


def test_jobs_list(client, fake_pipeline, tmp_path, tmp_output):
    docx = tmp_path / "book.docx"
    make_test_docx(docx, num_chapters=1)
    jid = client.post("/book/start", json={"path": str(docx), "gpus": "cpu"}).get_json()["job_id"]
    _wait_terminal(client, jid)
    jobs = client.get("/book/jobs").get_json()
    assert any(j["id"] == jid for j in jobs)


# ── resume-on-reload: /book/status carries everything a fresh page needs ──────

def test_status_carries_resume_fields(client, fake_pipeline, tmp_path, tmp_output):
    """A reloaded page rebuilds itself from /book/status: real elapsed (started_at/now,
    server-clock pair so client clock skew can't corrupt it), the job's live params,
    and the sidecar-derived done chapters (authoritative even if the SSE ring evicted
    early section_done events on a long render)."""
    docx, r = _run_book(client, tmp_path, tmp_output, name="rs", chapters=2, voice="V.wav")
    st = _wait_terminal(client, r.get_json()["job_id"])
    assert st["started_at"] > 0
    assert st["now"] >= st["started_at"]
    assert st["canceling"] is False              # terminal — never reports a stale cancel
    assert st["only_section"] is None
    assert st["params"] == {"exaggeration": 0.5, "cfg": 0.5, "temperature": 0.8}
    assert sorted(st["done_sections"]) == [0, 1]


def test_status_reports_canceling_flag(client):
    """A cancel requested but not yet honored must be visible across a reload, so the
    page can restore the disabled 'Canceling…' button instead of a live Cancel."""
    job = jobs_mod.Job(id="cflag", docx="x.docx", voice="", params=tts_utils.GenParams(),
                 gpus="cpu", workers=1)
    with jobs_mod.JOBS_LOCK:
        jobs_mod.JOBS[job.id] = job
    job.cancel.set()                              # still 'queued' — cancel is pending
    assert client.get("/book/status/cflag").get_json()["canceling"] is True
    job.status = "canceled"                      # let the drain fixture see it as terminal


def test_status_answers_for_a_job_without_speech_parameters(client):
    """A music job is created with `params=None` (`acecands`). October 12, 2026: /book/status
    answered 500 for one, and the Music tab asks it when it reattaches to a running job."""
    job = jobs_mod.Job(id="musicjob", docx="", voice="", params=None, gpus="", workers=1)
    with jobs_mod.JOBS_LOCK:
        jobs_mod.JOBS[job.id] = job
    response = client.get("/book/status/musicjob")
    assert response.status_code == 200
    assert response.get_json()["params"] is None
    job.status = "canceled"                      # let the drain fixture see it as terminal


def test_vram_events_fan_out_but_are_not_buffered():
    """The 1/s vram ticker must not flood the replay ring: an hour-long render would
    evict the structural events (job_start, sections, early log lines) that
    resume-on-reload replays. vram goes to live subscribers only."""
    import queue as _q
    job = jobs_mod.Job(id="vbuf", docx="x", voice="", params=tts_utils.GenParams(),
                 gpus="cpu", workers=1)
    q = _q.Queue()
    job.subscribers.append(q)
    jobs_mod.emit(job, {"type": "vram", "gpus": []})
    jobs_mod.emit(job, {"type": "log", "line": "hi"})
    assert [e["type"] for e in job.events] == ["log"]                        # not buffered
    assert [q.get_nowait()["type"], q.get_nowait()["type"]] == ["vram", "log"]  # both live


# ── AC3: pool rebuilds only when selection changes, no restart ────────────────

# ── M5: sidecar / Output / Library / voice-change guard ───────────────────────

def test_different_narrator_409_then_confirm(client, fake_pipeline, tmp_path, tmp_output):
    docx, r = _run_book(client, tmp_path, tmp_output, name="vc", voice="TestVoice.wav")
    _wait_terminal(client, r.get_json()["job_id"])
    # re-rendering with the SAME narrator resumes silently (no 409) — resume is keyed on
    # the narrator alone, so mid-book settings tweaks don't fork a new render.
    same = client.post("/book/start", json={"path": str(docx), "gpus": "cpu", "voice": "TestVoice.wav"})
    assert same.status_code == 200
    _wait_terminal(client, same.get_json()["job_id"])
    # a DIFFERENT narrator, no confirm -> 409 citing the prior narrator
    r2 = client.post("/book/start", json={"path": str(docx), "gpus": "cpu", "voice": "OtherVoice.wav"})
    assert r2.status_code == 409
    assert r2.get_json()["error"] == "different_narrator"
    assert r2.get_json()["prev_narrator"] == "TestVoice"
    assert r2.get_json()["prev_voice"] == "TestVoice.wav"
    # with confirm -> proceeds into its own "(OtherVoice)" folder
    r3 = client.post("/book/start", json={"path": str(docx), "gpus": "cpu",
                                          "voice": "OtherVoice.wav", "confirm_new_narrator": True})
    assert r3.status_code == 200


def test_output_list_reports_chapters_and_mismatch(client, fake_pipeline, tmp_path, tmp_output, books_out):
    docx, r = _run_book(client, tmp_path, tmp_output, name="ol", chapters=2, voice="Main.wav")
    _wait_terminal(client, r.get_json()["job_id"])
    book = "ol (Main)"                       # rendered into its per-narrator folder
    # tamper one chapter's voice in the sidecar to simulate a one-off regen
    out_dir = books_out / book
    sc = book_state.load_sidecar(out_dir)
    sc["chapters"][1]["voice"] = "Other.wav"
    book_state.write_sidecar(out_dir, sc)
    j = client.get(f"/output/{quote(book)}").get_json()
    assert j["voice"] == "Main.wav"
    assert len(j["chapters"]) == 2
    assert j["chapters"][0]["mismatch"] is False
    assert j["chapters"][1]["mismatch"] is True


def test_single_audiobook_rejects_unknown_format_without_touching_outputs(
        client, books_out):
    d = books_out / "format-validation"
    d.mkdir()
    existing = d / "format-validation_full.opus"
    existing.write_bytes(b"existing")
    r = client.post("/output/format-validation/concat", json={"format": "alac"})
    assert r.status_code == 400
    assert "unsupported audiobook format" in r.get_json()["error"]
    assert existing.read_bytes() == b"existing"


@pytest.mark.parametrize("bitrate", ["192", 224, 0, True])
def test_single_audiobook_rejects_unsupported_bitrate_without_touching_outputs(
        client, books_out, bitrate):
    d = books_out / "bitrate-validation"
    d.mkdir()
    existing = d / "bitrate-validation_full.opus"
    existing.write_bytes(b"existing")
    r = client.post("/output/bitrate-validation/concat",
                    json={"format": "opus", "bitrate": bitrate})
    assert r.status_code == 400
    assert "unsupported audiobook bitrate" in r.get_json()["error"]
    assert existing.read_bytes() == b"existing"


def test_single_audiobook_build_preserves_other_formats_on_success_and_failure(
        client, books_out, monkeypatch):
    d = books_out / "format-replacement"
    d.mkdir()
    prior = [d / f"format-replacement_full{ext}" for ext in book_state.FULL_EXTS]
    for p in prior:
        p.write_bytes(b"old output")

    def failed_concat(*args):
        raise RuntimeError("encoder failed")

    monkeypatch.setattr(book_state, "concat_book", failed_concat)
    r = client.post("/output/format-replacement/concat", json={"format": "aac"})
    assert r.status_code == 400
    assert all(p.read_bytes() == b"old output" for p in prior)

    def successful_concat(out_dir, slug, fmt, bitrate):
        assert bitrate == "192k"
        target = out_dir / f"{slug}_full.m4a"
        target.write_bytes(b"new AAC")
        return target

    monkeypatch.setattr(book_state, "concat_book", successful_concat)
    monkeypatch.setattr(book_state, "mp3_duration", lambda _p: 0)
    r = client.post("/output/format-replacement/concat", json={"format": "aac"})
    assert r.status_code == 200
    assert r.get_json()["file"] == "format-replacement_full.m4a"
    assert (d / "format-replacement_full.m4a").read_bytes() == b"new AAC"
    assert all(p.read_bytes() == b"old output" for p in prior if p.suffix != ".m4a")


def test_delete_one_completed_audiobook_preserves_chapters_and_other_formats(
        client, books_out):
    d = books_out / "delete-one"
    d.mkdir()
    chapter = d / "00_Chapter.opus"
    chapter.write_bytes(b"chapter")
    exports = [d / f"delete-one_full{ext}" for ext in book_state.FULL_EXTS]
    for path in exports:
        path.write_bytes(path.suffix.encode())

    response = client.delete("/output/delete-one/audiobook/delete-one_full.mp3")

    assert response.status_code == 200
    assert response.get_json() == {"deleted": "delete-one_full.mp3"}
    assert not exports[1].exists()
    assert exports[0].exists() and exports[2].exists()
    assert chapter.read_bytes() == b"chapter"
    inventory = client.get("/output/delete-one").get_json()
    assert [a["file"] for a in inventory["full_audiobooks"]] == [
        "delete-one_full.opus", "delete-one_full.m4a"]


@pytest.mark.parametrize("filename", [
    "00_Chapter.opus", "other_full.mp3", "delete-one_full.wav", "..",
])
def test_delete_completed_audiobook_rejects_noncanonical_names(client, books_out, filename):
    d = books_out / "delete-one"
    d.mkdir(exist_ok=True)
    chapter = d / "00_Chapter.opus"
    chapter.write_bytes(b"chapter")
    opus = d / "delete-one_full.opus"
    opus.write_bytes(b"opus")

    response = client.delete(f"/output/delete-one/audiobook/{filename}")

    assert response.status_code == 400
    assert chapter.read_bytes() == b"chapter"
    assert opus.read_bytes() == b"opus"


def test_delete_completed_audiobook_returns_404_when_missing(client, books_out):
    (books_out / "missing-audiobook").mkdir()
    response = client.delete(
        "/output/missing-audiobook/audiobook/missing-audiobook_full.opus")
    assert response.status_code == 404


@pytest.mark.parametrize("fmt", ["opus", "mp3", "aac"])
def test_single_audiobook_passes_selected_bitrate_to_engine(
        client, books_out, monkeypatch, fmt):
    d = books_out / "bitrate-selection"
    d.mkdir()
    seen = []

    def concat(out_dir, slug, selected_format, bitrate):
        seen.append((selected_format, bitrate))
        suffix = {"opus": ".opus", "mp3": ".mp3", "aac": ".m4a"}[selected_format]
        target = out_dir / f"{slug}_full{suffix}"
        target.write_bytes(b"audio")
        return target

    monkeypatch.setattr(book_state, "concat_book", concat)
    monkeypatch.setattr(book_state, "mp3_duration", lambda _p: 0)
    r = client.post("/output/bitrate-selection/concat",
                    json={"format": fmt, "bitrate": 96})
    assert r.status_code == 200
    assert seen == [(fmt, "96k")]


def test_library_enumerates_books(client, fake_pipeline, tmp_path, tmp_output):
    _, r = _run_book(client, tmp_path, tmp_output, name="lib1", chapters=1)   # default voice V.wav
    _wait_terminal(client, r.get_json()["job_id"])
    lib = client.get("/library").get_json()
    assert any(b["book"] == "lib1 (V)" for b in lib)     # library lists the per-narrator folder


def test_output_and_library_work_without_a_sidecar(client, tmp_output, books_out):
    """Files copied in manually (no vocalis-book.yaml) must still be listed:
    the filesystem is the source of truth, not the sidecar."""
    import torch, torchaudio as ta
    d = books_out / "manual"
    (d / "mp3").mkdir(parents=True)
    for i, name in enumerate(["Prologue", "Chapter_One"]):
        save_wav_sf(str(d / f"{i:02d}_{name}.wav"), torch.zeros(1, 24000), 24000)

    out = client.get("/output/manual").get_json()
    assert out["has_sidecar"] is False
    assert len(out["chapters"]) == 2
    assert out["chapters"][1]["title"] == "Chapter One"     # derived from filename
    assert out["chapters"][0]["wav"] == "00_Prologue.wav"

    lib = client.get("/library").get_json()
    m = next(b for b in lib if b["book"] == "manual")
    assert m["has_sidecar"] is False and m["chapters"] == 2


def test_library_skips_folders_without_audio(client, tmp_output, books_out):
    """⚠️ 5.1.1: ANCHOR THE NEGATIVE ON A POSITIVE IN THE SAME TREE.

    This was `assert all(b["book"] != "empty" …)` and nothing else — satisfiable by the empty
    set. Verified worthless: stubbing /library to `return jsonify([])` left it GREEN, so it
    could not tell "the skip rule works" from "the route is dead" or "the route is reading a
    different tree entirely". That last one is not hypothetical — P4.17 made web/system.py a
    fourth OUTPUT_DIR capture site and this assertion passed happily against the developer's
    real output/ tree while being the thing under test."""
    (books_out / "empty").mkdir()
    (books_out / "empty" / "notes.txt").write_text("no audio here")
    book_state.write_sidecar(books_out / "real (V)", {
        "source_docx": "r.docx", "voice": "V.wav",
        "chapters": [{"index": 0, "title": "Ch 1", "filename": "00_Ch_1", "status": "done"}]})

    lib = client.get("/library").get_json()
    assert any(b["book"] == "real (V)" for b in lib), \
        "/library is not reading this tree at all — the negative below would prove nothing"
    assert all(b["book"] != "empty" for b in lib)


def test_library_keeps_partial_render_with_no_finished_chapters(client, tmp_output, books_out):
    """A render stopped before its first chapter finished leaves only the sidecar.
    The book must STAY in the library — browsable and resumable — not vanish the
    moment the render stops. Total comes from the sidecar (0/2, not 0/0), and the
    Output tab opens it rather than 404ing."""
    book = "partial (V)"
    book_state.write_sidecar(books_out / book, {
        "source_docx": "p.docx", "voice": "V.wav",
        "chapters": [{"index": 0, "title": "Ch 1", "filename": "00_Ch_1", "status": "pending"},
                     {"index": 1, "title": "Ch 2", "filename": "01_Ch_2", "status": "pending"}]})
    m = next((b for b in client.get("/library").get_json() if b["book"] == book), None)
    assert m is not None, "sidecar-only book vanished from the library"
    assert m["done"] == 0 and m["chapters"] == 2
    out = client.get(f"/output/{quote(book)}")
    assert out.status_code == 200
    assert out.get_json()["chapters"] == []


def test_app_settings_default_and_roundtrip(client, tmp_path, monkeypatch):
    """The machine-level prefs default sensibly and a PUT persists across reads.

    5.4.1: `workers_per_card` is no longer among them. One replica per device is a constant, so
    the key is neither returned nor accepted — see `rt_pool.default_workers`.
    """
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    j = client.get("/settings/app").get_json()
    assert "workers_per_card" not in j       # removed in 5.4.1, not merely defaulted
    assert j["log_ansi_colors"] is True                        # ANSI colors default on
    assert j["log_path"].endswith("vocalis.log")               # location shown in Settings
    assert client.put("/settings/app", json={"log_ansi_colors": False}).get_json()["log_ansi_colors"] is False
    assert client.get("/settings/app").get_json()["log_ansi_colors"] is False
    assert j["gpus"] == "all"                                  # GPU selection persists too
    assert client.put("/settings/app", json={"gpus": "1"}).get_json()["gpus"] == "1"
    assert client.get("/settings/app").get_json()["gpus"] == "1"
    assert client.put("/settings/app", json={"gpus": "bogus"}).status_code == 400
    # 🔴 The removed key is IGNORED, not validated. It used to be a 400 on a bad value; now a
    # stale tab carrying any value at all must still get its other settings saved.
    assert client.put("/settings/app", json={"workers_per_card": "x"}).status_code == 200


def test_logs_tail_cursor_rotation_and_ansi(client, tmp_path, monkeypatch):
    """The SillyTavern ▸ Logs tail: the first call returns the file's tail plus a
    byte cursor; later calls return only what's new; ANSI color escapes are
    stripped; only whole lines cross (a partial trailing line waits for its
    newline); and a file shorter than the cursor (loguru's 10 MB rotation)
    restarts from the fresh tail with rotated=True."""
    (tmp_path / "logs").mkdir()
    log = tmp_path / "logs" / "vocalis.log"
    monkeypatch.setattr(rt_paths, "LOG_DIR", tmp_path / "logs")

    # missing file -> empty text, still-negative cursor, a missing flag
    assert client.get("/logs/tail").get_json() == {"text": "", "cursor": -1, "missing": True}

    # first fill: the whole (small) file comes back with colors stripped; cursor at EOF
    log.write_bytes(b"\x1b[32mline one\x1b[0m\nline two\n")
    j = client.get("/logs/tail?cursor=-1").get_json()
    assert j["text"] == "line one\nline two\n"          # ANSI escapes gone
    assert j["rotated"] is False and "missing" not in j
    cur = j["cursor"]
    assert cur == log.stat().st_size

    # no new bytes -> empty, cursor unchanged
    j = client.get(f"/logs/tail?cursor={cur}").get_json()
    assert j["text"] == "" and j["cursor"] == cur

    # a partial line (no newline yet) does NOT cross, and the cursor holds
    with log.open("ab") as f:
        f.write(b"partial")
    j = client.get(f"/logs/tail?cursor={cur}").get_json()
    assert j["text"] == "" and j["cursor"] == cur

    # finish the line -> it crosses whole and the cursor advances past it
    with log.open("ab") as f:
        f.write(b" done\n")
    j = client.get(f"/logs/tail?cursor={cur}").get_json()
    assert j["text"] == "partial done\n"
    cur2 = j["cursor"]
    assert cur2 == log.stat().st_size

    # rotation: a cursor past EOF means the file rolled over -> fresh tail, rotated True
    log.write_bytes(b"fresh\n")                          # now far shorter than cur2
    j = client.get(f"/logs/tail?cursor={cur2}").get_json()
    assert j["rotated"] is True and j["text"] == "fresh\n"


def test_output_file_serves_with_range(client, tmp_output, books_out):
    d = books_out / "rng"; d.mkdir()
    (d / "a.wav").write_bytes(b"0123456789")
    r = client.get("/output/rng/file/a.wav", headers={"Range": "bytes=0-3"})
    assert r.status_code == 206                     # partial content -> scrubbing works
    r2 = client.get("/output/rng/file/a.wav?download=1")
    assert "attachment" in r2.headers.get("Content-Disposition", "")


def test_clear_requires_confirm_then_wipes(client, tmp_output, books_out):
    d = books_out / "wipe"; d.mkdir()
    (d / "x.wav").write_bytes(b"x")
    assert client.post("/book/clear/wipe", json={"confirm": "wrong"}).status_code == 400
    assert d.exists()
    r = client.post("/book/clear/wipe", json={"confirm": "wipe"})
    assert r.status_code == 200 and not d.exists()


def test_output_404_for_unknown_book(client, tmp_output):
    assert client.get("/output/ghost").status_code == 404


def test_output_file_rejects_path_traversal(client, tmp_output, books_out):
    """The <path:fname> segment must not be able to climb out of the book dir and
    serve a sibling file. Assert the secret is never leaked, regardless of 400/404."""
    d = books_out / "trav"; d.mkdir()
    (d / "a.wav").write_bytes(b"x")
    (tmp_output / "secret.txt").write_bytes(b"TOPSECRET")
    for frag in ["../secret.txt", "..%2fsecret.txt", "..%2F..%2Fsecret.txt",
                 "mp3/../../secret.txt"]:
        r = client.get(f"/output/trav/file/{frag}")
        assert r.status_code != 200, f"traversal served a file via {frag!r}"
        assert b"TOPSECRET" not in r.data


def test_regenerate_failure_restores_original_chapter(client, fake_pipeline, tmp_path,
                                                      tmp_output, monkeypatch, books_out):
    """A failed regen must restore the original chapter audio — deleting it up front
    (the bug) makes a failed regen permanent data loss."""
    docx, r = _run_book(client, tmp_path, tmp_output, name="rg", chapters=1, voice="V.wav")
    _wait_terminal(client, r.get_json()["job_id"])
    book = "rg (V)"
    out_dir = books_out / book
    fn = book_state.load_sidecar(out_dir)["chapters"][0]["filename"]
    # 3.x: the chapter's persistent artifact is the ENCODED file (the WAV is deleted the
    # moment it lands) — that's what a failed regen must restore. Opus since 7.5.30;
    # `book_state.chapter_encoded` is the resolver that reads either format.
    mp3 = book_state.chapter_encoded(out_dir, fn)
    assert mp3 is not None, "the render produced no encoded chapter"
    assert mp3.exists() and not (out_dir / (fn + ".wav")).exists()
    original = mp3.read_bytes()

    def boom(*a, **k):
        raise RuntimeError("render failed")
    # `finish_section`, not `start_section`: the failure has to land where the render is
    # AWAITED. fake_pipeline's start_section still runs and hands back its handle, so this
    # stays "a render that failed" rather than "a section that was never queued".
    monkeypatch.setattr(web_books, "finish_section", boom)

    rr = client.post(f"/book/regenerate/{quote(book)}/0", json={})
    assert rr.status_code == 200
    st = _wait_terminal(client, rr.get_json()["job_id"])
    assert st["status"] == "failed"
    assert mp3.exists(), "failed regen lost the original chapter"
    assert mp3.read_bytes() == original


def test_regen_does_not_hide_chapter_while_queued(client, fake_pipeline, tmp_path,
                                                  tmp_output, monkeypatch, books_out):
    """The safe-swap must run in run_job under GPUS, NOT in the request handler:
    moving the files at enqueue would make the chapter vanish from Output (and be
    silently missing from a concat) for however long the regen queues behind
    another render."""
    docx, r = _run_book(client, tmp_path, tmp_output, name="rq", chapters=1, voice="V.wav")
    _wait_terminal(client, r.get_json()["job_id"])
    book = "rq (V)"
    out_dir = books_out / book
    fn = book_state.load_sidecar(out_dir)["chapters"][0]["filename"]
    mp3 = book_state.chapter_encoded(out_dir, fn)   # the encoded chapter is the artifact
    assert mp3 is not None, "the render produced no encoded chapter"
    assert mp3.exists()

    monkeypatch.setattr(web_books, "run_job", lambda job: None)   # job never actually starts
    rr = client.post(f"/book/regenerate/{quote(book)}/0", json={})
    assert rr.status_code == 200
    assert mp3.exists(), "chapter file was moved at enqueue — must stay until the render starts"


def _regen_job():
    return jobs_mod.Job(id="rb", docx="x", voice="", params=tts_utils.GenParams(),
                  gpus="cpu", workers=1)


def test_resolve_regen_backups_success_nothing_landed_restores_both(tmp_path):
    """On SUCCESS with NEITHER a new MP3 nor a new WAV, the render produced nothing
    (e.g. the section no longer has synthesizable text) — BOTH backups restore, so
    a no-op regen never destroys the only copy of a chapter."""
    wav, mp3 = tmp_path / "ch.wav", tmp_path / "mp3" / "ch.mp3"
    mp3.parent.mkdir()
    wav_bak = tmp_path / "ch.wav.regenbak"; wav_bak.write_bytes(b"old-wav")
    mp3_bak = tmp_path / "mp3" / "ch.mp3.regenbak"; mp3_bak.write_bytes(b"old-mp3")
    job = _regen_job()
    job.regen_backups = [(str(wav_bak), str(wav)), (str(mp3_bak), str(mp3))]
    web_books._resolve_regen_backups(job, success=True)
    assert wav.read_bytes() == b"old-wav" and mp3.read_bytes() == b"old-mp3"


def test_resolve_regen_backups_success_mp3_landed_discards_both(tmp_path):
    """On SUCCESS with the new MP3 down (3.x mainline — the WAV is transient and
    already deleted), every backup is stale — discard, restore nothing."""
    wav, mp3 = tmp_path / "ch.wav", tmp_path / "mp3" / "ch.mp3"
    mp3.parent.mkdir(); mp3.write_bytes(b"new-mp3")
    wav_bak = tmp_path / "ch.wav.regenbak"; wav_bak.write_bytes(b"old-wav")
    mp3_bak = tmp_path / "mp3" / "ch.mp3.regenbak"; mp3_bak.write_bytes(b"old-mp3")
    job = _regen_job()
    job.regen_backups = [(str(wav_bak), str(wav)), (str(mp3_bak), str(mp3))]
    web_books._resolve_regen_backups(job, success=True)
    assert mp3.read_bytes() == b"new-mp3"
    assert not wav.exists() and not wav_bak.exists() and not mp3_bak.exists()


def test_resolve_regen_backups_success_encode_failed_keeps_new_wav(tmp_path):
    """On SUCCESS where the render landed but its encode failed (fresh WAV, no MP3):
    the render is real — discard the backups rather than resurrect pre-regen audio
    next to the new WAV."""
    wav, mp3 = tmp_path / "ch.wav", tmp_path / "mp3" / "ch.mp3"
    mp3.parent.mkdir(); wav.write_bytes(b"new-wav")
    wav_bak = tmp_path / "ch.wav.regenbak"; wav_bak.write_bytes(b"old-wav")
    mp3_bak = tmp_path / "mp3" / "ch.mp3.regenbak"; mp3_bak.write_bytes(b"old-mp3")
    job = _regen_job()
    job.regen_backups = [(str(wav_bak), str(wav)), (str(mp3_bak), str(mp3))]
    web_books._resolve_regen_backups(job, success=True)
    assert wav.read_bytes() == b"new-wav"
    assert not mp3.exists() and not wav_bak.exists() and not mp3_bak.exists()


def test_restore_orphaned_regenbaks_at_startup(monkeypatch, tmp_output, books_out):
    """A crash between swap and resolve strands *.regenbak files; the startup sweep
    restores any whose original is missing and drops any whose original exists."""
    d = books_out / "orph"; (d / "mp3").mkdir(parents=True)
    lost = d / "01_ch.wav.regenbak";  lost.write_bytes(b"lost")     # orig missing
    kept = d / "02_ch.wav";           kept.write_bytes(b"new")
    dupe = d / "02_ch.wav.regenbak";  dupe.write_bytes(b"old")      # orig exists
    vs._restore_orphaned_regenbaks()
    assert (d / "01_ch.wav").read_bytes() == b"lost" and not lost.exists()
    assert kept.read_bytes() == b"new" and not dupe.exists()


# ── M6: Voices management / settings / Playground ─────────────────────────────

@pytest.fixture
def tmp_voices(monkeypatch, tmp_path):
    vsdir = tmp_path / "voice_samples"; vsdir.mkdir()
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", vsdir)
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    return vsdir


def test_voices_add_409_when_exists(client, tmp_voices):
    """A name collision is REJECTED, never overwritten (4.8-m3 §14.9.1), and the rejection
    names the voice the way the user does — "Dup", not "Dup.wav". The filename is plumbing."""
    (tmp_voices / "Dup.wav").write_bytes(b"RIFFfake")
    r = client.post("/voices", data={"name": "Dup"},
                    content_type="multipart/form-data",
                    buffered=True,
                    # a file part is required
                    )
    # no file -> 400; add a file part and retry
    assert r.status_code == 400
    import io as _io
    r2 = client.post("/voices", data={"name": "Dup", "file": (_io.BytesIO(b"x"), "u.mp3")},
                     content_type="multipart/form-data")
    j = r2.get_json()
    assert r2.status_code == 409 and j["name"] == "Dup"
    # The message says WHERE the collision lives — being told only "taken" while looking at a
    # tab that doesn't contain it is a dead end (§14.2).
    assert "uploaded voice" in j["message"].lower() and "Dup" in j["message"]


def test_voices_delete_reports_in_use(client, tmp_voices):
    (tmp_voices / "Gone.wav").write_bytes(b"x")
    (tmp_voices / "Also.wav").write_bytes(b"x")
    rt_paths.VOICE_SETTINGS.write_text("nomi:\n  default_voice: Gone.wav\n"
                                 "sillytavern:\n  Test Character: {voice: Also.wav}\n",
                                 encoding="utf-8")
    r = client.delete("/voices/Gone")                 # Nomi default_voice reference
    j = r.get_json()
    assert r.status_code == 200 and j["ok"] is True and j["in_use"] is True
    assert not (tmp_voices / "Gone.wav").exists()
    r = client.delete("/voices/Also")                 # ST character reference
    assert r.get_json()["in_use"] is True


def test_voices_delete_404_missing(client, tmp_voices):
    assert client.delete("/voices/Nope").status_code == 404


def test_voice_label_is_cosmetic_and_round_trips(client, tmp_voices):
    """Labels are DISPLAY-ONLY: stored in the voice's settings entry keyed by the
    immutable filename, listed by /voices, and clearable (empty = back to the
    filename). The file itself is never renamed."""
    (tmp_voices / "Narrator_2.wav").write_bytes(b"RIFFfake")
    r = client.put("/voices/Narrator_2.wav/settings", json={"label": "Narrator_2 — warm narrator"})
    assert r.status_code == 200
    v = next(x for x in client.get("/voices").get_json() if x["name"] == "Narrator_2.wav")
    assert v["label"] == "Narrator_2 — warm narrator"
    client.put("/voices/Narrator_2.wav/settings", json={"label": ""})
    v = next(x for x in client.get("/voices").get_json() if x["name"] == "Narrator_2.wav")
    assert v["label"] == ""                        # cleared — UI falls back to the filename


def test_voice_settings_get_default_and_put(client, tmp_voices):
    g = client.get("/voices/Narrator_2.wav/settings").get_json()
    assert "engine" not in g and g["exaggeration"] == 0.5   # engine left the wire (3.x)
    p = client.put("/voices/Narrator_2.wav/settings", json={"exaggeration": 0.65})
    assert p.status_code == 200 and p.get_json()["exaggeration"] == 0.65
    # persisted
    assert client.get("/voices/Narrator_2.wav/settings").get_json()["exaggeration"] == 0.65


def test_voices_audio_404_missing(client, tmp_voices):
    assert client.get("/voices/Nope/audio").status_code == 404


def test_voices_lists_and_serves_non_wav(client, tmp_voices):
    """A clip dropped into voice_samples/ by hand can be any format the model
    conditions on (not just the transcode-to-wav upload path). It must be listed,
    auditionable, and deletable by its REAL filename — resolved through
    _resolve_voice_ref, which never coerces the extension to '.wav'."""
    (tmp_voices / "Fixture_full.mp3").write_bytes(b"ID3fake-mp3")
    names = [e["name"] for e in client.get("/voices").get_json()]
    assert "Fixture_full.mp3" in names                       # listed, not filtered out
    assert client.get("/voices/Fixture_full.mp3/audio").status_code == 200
    assert client.get("/voices/Fixture_full/audio").status_code == 200   # bare stem resolves too
    r = client.delete("/voices/Fixture_full.mp3")
    assert r.status_code == 200 and r.get_json()["name"] == "Fixture_full.mp3"
    assert not (tmp_voices / "Fixture_full.mp3").exists()     # the real file went, not a phantom .wav


# ── 4.8-m3: origin, and the label as the identity ────────────────────────────

def test_voices_report_origin_and_no_sidecar_means_uploaded(client, tmp_voices):
    """🔴 NO SIDECAR ⇒ UPLOADED, kept deliberately after the backfill. Hand-dropping a file
    into voice_samples/ is a supported path, so a voice with no sidecar can appear at any
    time and needs a defined answer — and the read path must never write one to get it."""
    (tmp_voices / "Plain.wav").write_bytes(b"RIFFfake")
    (tmp_voices / "Made.wav").write_bytes(b"RIFFfake")
    (tmp_voices / "Made.voice.json").write_text('{"origin": "created"}', encoding="utf-8")
    (tmp_voices / "Stamped.wav").write_bytes(b"RIFFfake")
    (tmp_voices / "Stamped.voice.json").write_text(
        '{"origin": "uploaded", "backfilled": true}', encoding="utf-8")
    by = {v["name"]: v["origin"] for v in client.get("/voices").get_json()}
    assert by == {"Plain.wav": "uploaded", "Made.wav": "created", "Stamped.wav": "uploaded"}
    assert not (tmp_voices / "Plain.voice.json").exists()   # reading did NOT stamp it


def test_voices_origin_survives_a_corrupt_sidecar(client, tmp_voices):
    """A corrupt sidecar degrades one voice to "uploaded"; it never hides the voice or 500s
    the whole list."""
    (tmp_voices / "Broken.wav").write_bytes(b"RIFFfake")
    (tmp_voices / "Broken.voice.json").write_text("{not json", encoding="utf-8")
    v = client.get("/voices").get_json()
    assert len(v) == 1 and v[0]["origin"] == "uploaded"


def test_the_first_upload_into_a_fresh_install_creates_the_store(client, tmp_voices, monkeypatch):
    """🔴 voice_samples/ NO LONGER SHIPS — not even a .gitkeep (the enable gate needs a fresh
    clone's store to be EMPTY, and an empty directory cannot be committed). So the FIRST upload
    on a new install arrives with no directory to write into.

    VOICE_SAMPLES.mkdir lived in exactly one place, the design-freeze path, which did it for
    itself; the upload path had none anywhere. It now sits in _place_voice, the shared save path
    for both.

    🔴 THE FIXTURE HIDES THIS, WHICH IS WHY THE TEST REMOVES THE DIRECTORY BY HAND. Both
    `tmp_voices` and conftest's install-root fixture mkdir the store before any test runs, so
    every other voices test — and the whole 1400-test suite — starts in a state a fresh install
    is never in, and cannot fail when the mkdir is missing."""
    monkeypatch.setattr(vs.voice_utils, "transcode_normalize",
                        lambda src, dst: open(dst, "wb").write(b"RIFFfake"))
    monkeypatch.setattr(vs.voice_utils, "peak_dbfs", lambda p: -1.0)
    import io as _io
    tmp_voices.rmdir()                      # exactly what a fresh clone looks like
    assert not tmp_voices.exists()
    r = client.post("/voices", data={"name": "First", "file": (_io.BytesIO(b"x"), "u.mp3")},
                    content_type="multipart/form-data")
    assert r.status_code == 200, f"the first upload on a fresh install failed: {r.get_json()}"
    assert (tmp_voices / "First.wav").is_file()


def test_upload_writes_an_uploaded_sidecar_and_sets_the_label(client, tmp_voices, monkeypatch):
    """Uploads get a positive marker at upload time (§14.6a), and the name the user typed is
    stored as the LABEL — the identity — not just baked into a filename."""
    monkeypatch.setattr(vs.voice_utils, "transcode_normalize",
                        lambda src, dst: open(dst, "wb").write(b"RIFFfake"))
    monkeypatch.setattr(vs.voice_utils, "peak_dbfs", lambda p: -1.0)
    import io as _io
    r = client.post("/voices", data={"name": "SecondVoice", "file": (_io.BytesIO(b"x"), "u.mp3")},
                    content_type="multipart/form-data")
    j = r.get_json()
    assert r.status_code == 200 and j["name"] == "SecondVoice.wav" and j["label"] == "SecondVoice"
    side = json.loads((tmp_voices / "SecondVoice.voice.json").read_text(encoding="utf-8"))
    assert side["origin"] == "uploaded" and "created" in side
    listed = client.get("/voices").get_json()[0]
    assert listed["label"] == "SecondVoice" and listed["origin"] == "uploaded"


def test_upload_name_defaults_to_the_files_stem(client, tmp_voices, monkeypatch):
    """A filename IS a meaningful default for an upload — you picked that file. (Only the
    DESIGN path refuses to default, because a designed voice has nothing to fall back on.)"""
    monkeypatch.setattr(vs.voice_utils, "transcode_normalize",
                        lambda src, dst: open(dst, "wb").write(b"RIFFfake"))
    monkeypatch.setattr(vs.voice_utils, "peak_dbfs", lambda p: -1.0)
    import io as _io
    r = client.post("/voices", data={"file": (_io.BytesIO(b"x"), "Gravel Voice.mp3")},
                    content_type="multipart/form-data")
    assert r.get_json()["label"] == "Gravel Voice"


def test_label_collisions_are_rejected_across_both_origins(client, tmp_voices, monkeypatch):
    """The label is ONE uniqueness namespace covering both sub-tabs, case-insensitively —
    "secondvoice" and "SecondVoice" are the same person to a user."""
    monkeypatch.setattr(vs.voice_utils, "transcode_normalize",
                        lambda src, dst: open(dst, "wb").write(b"RIFFfake"))
    monkeypatch.setattr(vs.voice_utils, "peak_dbfs", lambda p: -1.0)
    (tmp_voices / "SampleVoice.wav").write_bytes(b"RIFFfake")
    (tmp_voices / "SampleVoice.voice.json").write_text('{"origin": "created"}', encoding="utf-8")
    import io as _io

    def up(name):
        return client.post("/voices", data={"name": name, "file": (_io.BytesIO(b"x"), "u.mp3")},
                           content_type="multipart/form-data")
    r = up("samplevoice")                                  # different case, same person
    assert r.status_code == 409
    assert "created voice" in r.get_json()["message"].lower()   # names WHERE it lives
    assert up("SampleVoice Two").status_code == 200        # a genuinely different name is fine


def test_a_sanitization_collision_gets_a_hash_suffix_silently(client, tmp_voices, monkeypatch):
    """Labels are unique by rule, but _wav_name() strips non-word characters, so two distinct
    labels can still collapse onto one filename (§14.10). The user never sees or resolves
    that — they get both voices, under the names they asked for."""
    monkeypatch.setattr(vs.voice_utils, "transcode_normalize",
                        lambda src, dst: open(dst, "wb").write(b"RIFFfake"))
    monkeypatch.setattr(vs.voice_utils, "peak_dbfs", lambda p: -1.0)
    import io as _io

    def up(name):
        return client.post("/voices", data={"name": name, "file": (_io.BytesIO(b"x"), "u.mp3")},
                           content_type="multipart/form-data")
    a = up("SecondVoice warm").get_json()
    b = up("SecondVoice (warm)").get_json()               # sanitizes to the SAME stem
    assert a["name"] == "SecondVoice warm.wav"
    assert b["name"] != a["name"] and b["name"].startswith("SecondVoice warm_")
    assert b["label"] == "SecondVoice (warm)"             # the label is untouched by the suffix
    labels = {v["label"] for v in client.get("/voices").get_json()}
    assert labels == {"SecondVoice warm", "SecondVoice (warm)"}


def test_rename_is_conflict_checked_but_a_voice_may_keep_its_own_label(client, tmp_voices):
    """A rename is a rename of the IDENTITY, so it gets the same check a save does — but a
    voice must not collide with itself."""
    (tmp_voices / "A.wav").write_bytes(b"RIFFfake")
    (tmp_voices / "B.wav").write_bytes(b"RIFFfake")
    assert client.put("/voices/A.wav/settings", json={"label": "Test Voice 1"}).status_code == 200
    r = client.put("/voices/B.wav/settings", json={"label": "Test Voice 1"})
    assert r.status_code == 409 and "Test Voice 1" in r.get_json()["message"]
    # its own label round-trips, and clearing back to the filename is always allowed
    assert client.put("/voices/A.wav/settings", json={"label": "Test Voice 1"}).status_code == 200
    assert client.put("/voices/A.wav/settings", json={"label": ""}).status_code == 200


def test_no_overwrite_route_survives(client, tmp_voices):
    """🔴 The silent bypass is GONE. PUT /voices/<name> called _save_voice(overwrite=True)
    unconditionally while the UI promised collisions are always rejected (§14.9.1)."""
    (tmp_voices / "SecondVoice.wav").write_bytes(b"RIFFfake")
    import io as _io
    r = client.put("/voices/SecondVoice.wav", data={"file": (_io.BytesIO(b"x"), "u.mp3")},
                   content_type="multipart/form-data")
    assert r.status_code == 405                      # method gone, not silently overwriting
    assert (tmp_voices / "SecondVoice.wav").read_bytes() == b"RIFFfake"


def test_voice_download_offers_the_label_not_the_on_disk_name(client, tmp_voices):
    """Downloading exports the user's voice, not our bookkeeping — the on-disk name may carry
    a sanitization hash (and is opaque ciphertext in 5.x)."""
    (tmp_voices / "SecondVoice warm_a3f9c.wav").write_bytes(b"RIFFfake")
    client.put("/voices/SecondVoice warm_a3f9c.wav/settings", json={"label": "SecondVoice (warm)"})
    r = client.get("/voices/SecondVoice warm_a3f9c.wav/audio?download=1")
    assert r.status_code == 200
    assert "SecondVoice warm.wav" in r.headers["Content-Disposition"]
    # ...and the inline player still gets a plain body it can Range-seek
    plain = client.get("/voices/SecondVoice warm_a3f9c.wav/audio")
    assert "attachment" not in plain.headers.get("Content-Disposition", "")


# ── 4.8-m5: favorites, and "when did this voice arrive" ──────────────────────

def _load_backfill():
    """scripts/backfill-voice-sidecars.py, whose hyphens make it unimportable by name."""
    import importlib.util
    path = REPO_ROOT / "scripts" / "backfill-voice-sidecars.py"
    spec = importlib.util.spec_from_file_location("backfill_voice_sidecars", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_voices_payload_carries_favorite_and_added_for_every_voice_state(client, tmp_voices):
    """All four states answer the same shape (§16.4). A surface that has to ask "does this
    voice even have an `added`?" ends up with two code paths and one of them rots."""
    (tmp_voices / "Plain.wav").write_bytes(b"RIFFfake")           # hand-dropped, no sidecar
    (tmp_voices / "Made.wav").write_bytes(b"RIFFfake")            # designed
    (tmp_voices / "Made.voice.json").write_text(
        '{"origin": "created", "created": 1000.0}', encoding="utf-8")
    (tmp_voices / "Up.wav").write_bytes(b"RIFFfake")              # post-m3 upload
    (tmp_voices / "Up.voice.json").write_text(
        '{"origin": "uploaded", "created": 2000.0}', encoding="utf-8")
    (tmp_voices / "Old.wav").write_bytes(b"RIFFfake")             # backfilled
    (tmp_voices / "Old.voice.json").write_text(
        '{"origin": "uploaded", "created": 3000.0, "backfilled": true}', encoding="utf-8")

    by = {v["name"]: v for v in client.get("/voices").get_json()}
    assert len(by) == 4
    for v in by.values():
        assert {"favorite", "added", "added_exact"} <= v.keys()
        assert v["favorite"] is False                    # nothing is starred yet
        assert isinstance(v["added"], float) and v["added"] > 0
    # 🔴 RECORDED vs GUESSED (§16.3) — `backfilled` exists precisely to tell these apart, and
    # the UI may sort on an inferred date but must never print it as a hard one.
    assert by["Made.wav"]["added"] == 1000.0 and by["Made.wav"]["added_exact"] is True
    assert by["Up.wav"]["added"] == 2000.0 and by["Up.wav"]["added_exact"] is True
    assert by["Old.wav"]["added"] == 3000.0 and by["Old.wav"]["added_exact"] is False
    # No sidecar at all: the file's own mtime, and honestly labeled as inferred.
    assert by["Plain.wav"]["added_exact"] is False
    assert by["Plain.wav"]["added"] == pytest.approx((tmp_voices / "Plain.wav").stat().st_mtime)
    assert not (tmp_voices / "Plain.voice.json").exists()    # reading still does NOT stamp it


def test_voices_order_is_untouched_by_m5(client, tmp_voices):
    """🔴 §16.5 — the server stays FILENAME-sorted. This one payload feeds the Voices tab and
    every voice dropdown, and those sort themselves (favorites first, by display name). Sorting
    here to suit one surface silently reorders the others as a side effect."""
    for n in ("zeta.wav", "alpha.wav", "mid.wav"):
        (tmp_voices / n).write_bytes(b"RIFFfake")
    (tmp_voices / "zeta.voice.json").write_text('{"favorite": true}', encoding="utf-8")
    client.put("/voices/alpha.wav/settings", json={"label": "Zzz last by label"})
    names = [v["name"] for v in client.get("/voices").get_json()]
    assert names == ["alpha.wav", "mid.wav", "zeta.wav"]   # not the ★ first, not by label


def test_star_a_voice_with_no_sidecar_writes_the_full_backfill_shape(client, tmp_voices):
    """🔴 THE regression test for §16.2a — the silent one.

    The backfill skips any voice that already has a sidecar, which is correct for its job. So a
    naive {"favorite": true} write here would make it skip this voice PERMANENTLY, and it would
    never receive `origin` or `created`. Nothing would look broken: a missing origin reads as
    "uploaded", which is the right answer. The only symptom is a voice with no add-date in a
    list whose default order is by add-date."""
    (tmp_voices / "Hand.wav").write_bytes(b"RIFFfake")
    mtime = (tmp_voices / "Hand.wav").stat().st_mtime
    r = client.post("/voices/Hand.wav/favorite", json={"favorite": True})
    assert r.status_code == 200 and r.get_json()["favorite"] is True

    side = json.loads((tmp_voices / "Hand.voice.json").read_text(encoding="utf-8"))
    assert side["favorite"] is True
    assert side["origin"] == "uploaded"                     # the full shape, not just the flag
    assert side["created"] == pytest.approx(mtime)
    assert side["backfilled"] is True                       # and honest about where that came from

    # The backfill now skips it — and skipping loses NOTHING, which is the whole point.
    counts = _load_backfill().backfill(tmp_voices, dry_run=True)
    assert counts["skipped"] == 1 and counts["stamped"] == 0
    still = client.get("/voices").get_json()[0]
    assert still["origin"] == "uploaded" and still["favorite"] is True
    assert still["added"] == pytest.approx(mtime) and still["added_exact"] is False


def test_star_preserves_the_provenance_a_created_voice_already_has(client, tmp_voices):
    """★ is one more field on the sidecar, not a replacement for it — starring a designed voice
    must not cost it the engine/model/seed record it was saved with."""
    (tmp_voices / "Test_Voice_1.wav").write_bytes(b"RIFFfake")
    (tmp_voices / "Test_Voice_1.voice.json").write_text(
        json.dumps({"origin": "created", "engine": "voxcpm", "created": 1234.0, "seed": 42}),
        encoding="utf-8")
    assert client.post("/voices/Test_Voice_1.wav/favorite", json={"favorite": True}).status_code == 200
    side = json.loads((tmp_voices / "Test_Voice_1.voice.json").read_text(encoding="utf-8"))
    assert side == {"origin": "created", "engine": "voxcpm", "created": 1234.0,
                    "seed": 42, "favorite": True}
    v = client.get("/voices").get_json()[0]
    assert v["origin"] == "created" and v["added"] == 1234.0 and v["added_exact"] is True


def test_star_is_on_disk_so_it_survives_a_restart(client, tmp_voices):
    """The flag lives in the sidecar, not in server memory (§16.2) — it cannot detach from its
    voice or outlive it, and it is still there after the process goes away."""
    (tmp_voices / "S.wav").write_bytes(b"RIFFfake")
    client.post("/voices/S.wav/favorite", json={"favorite": True})
    assert client.get("/voices").get_json()[0]["favorite"] is True
    assert json.loads((tmp_voices / "S.voice.json").read_text(encoding="utf-8"))["favorite"]
    # unstar round-trips too — the flag is set to what was asked, not toggled server-side
    client.post("/voices/S.wav/favorite", json={"favorite": False})
    assert client.get("/voices").get_json()[0]["favorite"] is False


def test_star_deletes_with_its_voice(client, tmp_voices):
    """No orphan favorite outlives the voice it pointed at — the reason this is a sidecar and
    not a central favorites file."""
    (tmp_voices / "S.wav").write_bytes(b"RIFFfake")
    client.post("/voices/S.wav/favorite", json={"favorite": True})
    assert client.delete("/voices/S.wav").status_code == 200
    assert not (tmp_voices / "S.voice.json").exists()


def test_star_write_failure_is_a_5xx_not_a_silent_200(client, tmp_voices, monkeypatch):
    """🔴 §16.8 — _write_voice_sidecar is best-effort BY DESIGN, and that is wrong for ★, whose
    entire effect IS the write. A swallowed failure answers 200 to a request that changed
    nothing: "a star that only exists in the DOM is a lie the next refresh silently corrects."
    """
    (tmp_voices / "S.wav").write_bytes(b"RIFFfake")

    def boom(dst, data):
        raise OSError("read-only file system")
    monkeypatch.setattr(rt_voices, "write_sidecar_or_raise", boom)
    r = client.post("/voices/S.wav/favorite", json={"favorite": True})
    assert r.status_code == 500 and "favorite" in r.get_json()["error"]
    assert client.get("/voices").get_json()[0]["favorite"] is False   # and it really did not stick


def test_the_forgiving_sidecar_write_stays_forgiving(tmp_voices, monkeypatch):
    """The raising variant is for ★ only. Its other callers depend on a failed sidecar NOT
    failing a save the user watched succeed — do not relax one into the other."""
    monkeypatch.setattr(rt_voices, "write_sidecar_or_raise",
                        lambda dst, data: (_ for _ in ()).throw(OSError("nope")))
    rt_voices.write_sidecar(tmp_voices / "S.wav", {"origin": "uploaded"})   # must not raise


def test_star_404s_on_a_voice_that_does_not_exist(client, tmp_voices):
    assert client.post("/voices/Ghost.wav/favorite", json={"favorite": True}).status_code == 404
    assert not list(tmp_voices.glob("*.voice.json"))       # and wrote nothing on the way out


def test_book_start_resolves_non_wav_voice(client, fake_pipeline, tmp_path, tmp_output):
    """Selecting a hand-added .mp3 voice renders with it: the value round-trips to the
    real on-disk filename instead of being coerced to a phantom '<stem>.wav' that would
    404 as 'voice file not found'."""
    (rt_paths.VOICE_SAMPLES / "Fixture_full.mp3").write_bytes(b"ID3fake-mp3")
    docx = tmp_path / "mp3voice.docx"
    make_test_docx(docx, num_chapters=1)
    r = client.post("/book/start", json={"path": str(docx), "gpus": "cpu",
                                         "voice": "Fixture_full.mp3"})
    assert r.status_code == 200
    st = _wait_terminal(client, r.get_json()["job_id"])
    assert st["voice"] == "Fixture_full.mp3"


def test_playground_rejects_docx(client, tmp_path):
    import io as _io
    r = client.post("/playground/generate",
                    data={"file": (_io.BytesIO(b"hi"), "note.docx")},
                    content_type="multipart/form-data")
    assert r.status_code == 400


@pytest.fixture
def fake_pg(monkeypatch):
    """Fake pool + instant MP3 'encode' so playground jobs run on CPU in ms.

    `encodes` records the bitrate every clip was encoded at — enhancement doubles the
    bandwidth the encoder has to pay for, so the 96k/256k choice is the difference between
    keeping the invented high end and throwing it straight back away (DESIGN §7). It is
    not observable from a faked MP3 any other way."""
    import torch
    from pathlib import Path as _P

    class _FakePool:
        sr = FAKE_SR
        def run_chunks(self, items, params, save, total, on_event=None, chapter=None, cancel=None):
            for i, _text in items:
                save(i, torch.zeros(1, FAKE_SR // 10), FAKE_SR)
            return 0, 0.0
        def shutdown(self): pass
    monkeypatch.setattr(rt_pool, "get_pool", lambda d, w: _FakePool())

    encodes = []

    def _fake_encode(wav, mp3, bitrate=vs.enhance.MP3_BITRATE_PLAIN):
        encodes.append((_P(wav).name, bitrate))
        _P(mp3).parent.mkdir(parents=True, exist_ok=True)
        _P(mp3).write_bytes(b"ID3-fake-mp3")
        return _P(mp3)
    monkeypatch.setattr(playground_clips, "encode_mp3", _fake_encode)
    return encodes


def test_playground_job_renders_clip_and_lists_it(client, fake_pg, tmp_output):
    """Happy path: generate is a job (202); the finished clip persists as mp3+yaml
    under output/playground/<voice>/, lists in the library, and serves from disk."""
    r = client.post("/playground/generate",
                    json={"text": "Hello there. This is a test.", "gpus": "cpu"})
    assert r.status_code == 202
    j = r.get_json()
    st = _wait_terminal(client, j["job_id"])
    assert st["status"] == "done" and st["kind"] == "playground"
    assert st["clip"].startswith("default/")     # pollers (Audition) play the clip from status
    clips = client.get("/playground/clips").get_json()
    assert len(clips) == 1
    c = clips[0]
    assert "seed" not in c                       # seedless rows (3.x)
    assert c["text"].startswith("Hello there.")
    assert c["ref"].startswith("default/")            # model-default voice dir
    a = client.get(f"/playground/clips/{c['ref']}/audio")
    assert a.status_code == 200 and a.data == b"ID3-fake-mp3"


def test_playground_generate_always_renders_and_overwrites(client, fake_pg, tmp_output):
    """Seedless identity: identical inputs land on the SAME clip path — a second
    Generate renders again (no cached short-circuit) and the fresh take replaces
    the stored one; the library still shows exactly one row."""
    body = {"text": "Cache me please. Twice over.", "gpus": "cpu"}
    j = client.post("/playground/generate", json=body).get_json()
    _wait_terminal(client, j["job_id"])
    r2 = client.post("/playground/generate", json=body)
    assert r2.status_code == 202                       # renders again — never "cached"
    st2 = _wait_terminal(client, r2.get_json()["job_id"])
    assert st2["status"] == "done"
    clips = client.get("/playground/clips").get_json()
    assert len(clips) == 1                             # overwrote, not versioned


def test_playground_cancel_keeps_workspace_and_same_inputs_resume(client, fake_pg, tmp_output):
    """A canceled render leaves its workspace; the next request with identical
    inputs lands on the SAME identity H and resumes its chunks (seedless: the
    hash alone locates the workspace — no adoption step)."""
    body = {"text": "Adopt me on resume. Same text and knobs.", "gpus": "cpu"}
    assert vs.GPUS.acquire(timeout=1)          # hold the GPUs so the job queues
    try:
        j1 = client.post("/playground/generate", json=body).get_json()
        # The runner writes pending.yaml BEFORE its lock wait and logs "Waiting for the GPUs" from
        # inside it, so that line means the workspace exists and the job is queued.
        _wait_for_job_log(jobs_mod.JOBS[j1["job_id"]], "Waiting for the GPUs")
        client.post(f"/book/cancel/{j1['job_id']}")
        st1 = _wait_terminal(client, j1["job_id"])
        assert st1["status"] == "canceled"
    finally:
        vs.GPUS.release()
    h1 = jobs_mod.JOBS[j1["job_id"]].clip_h
    assert playground_clips.workspace(web_playground.CHUNKS_ROOT, h1).exists()   # progress kept
    j2 = client.post("/playground/generate", json=body).get_json()
    assert jobs_mod.JOBS[j2["job_id"]].clip_h == h1, "same inputs must land on the same workspace"
    st2 = _wait_terminal(client, j2["job_id"])
    assert st2["status"] == "done"
    assert len(client.get("/playground/clips").get_json()) == 1


def test_playground_clips_multi_delete_and_guards(client, fake_pg, tmp_output):
    for s in (5, 6):
        j = client.post("/playground/generate",
                        json={"text": f"Clip number {s} here to delete.", "gpus": "cpu"}).get_json()
        _wait_terminal(client, j["job_id"])
    refs = [c["ref"] for c in client.get("/playground/clips").get_json()]
    assert len(refs) == 2
    r = client.delete("/playground/clips", json={"clips": refs + ["../evil", "nope/nope"]})
    assert sorted(r.get_json()["deleted"]) == sorted(refs)     # bad refs skipped, not errors
    assert client.get("/playground/clips").get_json() == []


def test_playground_download_selected_zips_stored(client, fake_pg, tmp_output):
    """⬇ Download selected: one STORED zip holding the selection, form-encoded.

    The form path is the one the page actually uses (a form submit is a native browser
    download, so nothing buffers the archive) — testing only the JSON body would leave the
    live path uncovered. ZIP_STORED is asserted per entry, not on the file as a whole: the
    compression method lives in each member's header, so a route that quietly deflated would
    still produce a perfectly valid zip and every other assertion here would pass.
    """
    import io as _io
    import zipfile as _zip

    for s in (7, 8):
        j = client.post("/playground/generate",
                        json={"text": f"Clip number {s} to download.", "gpus": "cpu"}).get_json()
        _wait_terminal(client, j["job_id"])
    refs = [c["ref"] for c in client.get("/playground/clips").get_json()]
    assert len(refs) == 2

    r = client.post("/playground/clips/zip",
                    data={"clips": [refs[0], refs[1], "nope/nope"]})
    assert r.status_code == 200 and r.mimetype == "application/zip"
    assert 'attachment; filename="playground-clips-2.zip"' in r.headers["Content-Disposition"]

    z = _zip.ZipFile(_io.BytesIO(r.data))
    assert z.testzip() is None                       # a torn stream is a valid-looking zip too
    names = z.namelist()
    assert len(names) == 2                           # the bogus ref was skipped, not an error
    for info in z.infolist():
        assert info.compress_type == _zip.ZIP_STORED
        assert z.read(info.filename) == b"ID3-fake-mp3"
    assert all(n.endswith(".mp3") and "/" not in n for n in names)   # flat archive

    # JSON body — the DELETE route's shape, so "selected" cannot come to mean two things.
    r = client.post("/playground/clips/zip", json={"clips": [refs[0]]})
    assert r.status_code == 200
    assert 'filename="playground-clip.zip"' in r.headers["Content-Disposition"]
    assert len(_zip.ZipFile(_io.BytesIO(r.data)).namelist()) == 1

    assert client.post("/playground/clips/zip", json={}).status_code == 400
    # Everything named is gone: 404 rather than an empty archive, which would look like success.
    assert client.post("/playground/clips/zip",
                       json={"clips": ["../evil", "gone/gone_ab12cd34"]}).status_code == 404


def test_playground_download_selected_includes_partials(client, fake_pg, tmp_output):
    """A partial is selectable, so it must be downloadable — as the same 'story so far' WAV
    its own row serves, named from the text rather than from the workspace hash.

    The workspace is built directly rather than by canceling a render: `list_partials` lists a
    workspace that has a manifest and NO banked chunks, so a cancel that lands before chunk 0
    produces a selectable row with nothing to zip. That is a real state and the route skips it
    (below) — it is just not the state this test is about, and racing for it would make the
    assertion that matters skip most runs.
    """
    import io as _io
    import zipfile as _zip

    import playground_clips as pc
    from tts_utils import save_wav_sf

    h = "aabbccdd1122"
    ws = pc.workspace(web_playground.CHUNKS_ROOT, h)
    ws.mkdir(parents=True, exist_ok=True)
    save_wav_sf(str(ws / "chunk_0000.wav"), torch.zeros(1, 24000), 24000)
    pc.write_pending(ws, {"voice": "", "text": "Partial to be zipped up later.", "total": 4})

    rows = [c for c in client.get("/playground/clips").get_json() if c["kind"] == "partial"]
    assert [r["ref"] for r in rows] == [h]

    r = client.post("/playground/clips/zip", data={"partials": [h]})
    assert r.status_code == 200
    names = _zip.ZipFile(_io.BytesIO(r.data)).namelist()
    assert len(names) == 1 and names[0].endswith("_partial.wav")
    assert h not in names[0]                  # named from the text, never the raw hash

    # A manifest with nothing banked yet is selectable but has no audio: skipped, so a
    # selection of only those is a 404 rather than a zip holding a zero-byte WAV.
    empty = "bbccddee3344"
    ws2 = pc.workspace(web_playground.CHUNKS_ROOT, empty)
    ws2.mkdir(parents=True, exist_ok=True)
    pc.write_pending(ws2, {"voice": "", "text": "Nothing banked here.", "total": 4})
    assert client.post("/playground/clips/zip", data={"partials": [empty]}).status_code == 404


def test_library_never_lists_playground_folder(client, fake_pg, tmp_output, books_out):
    """output/playground is the clip store, not a book — the Library must skip it.

    ⚠️ 5.1.1: anchored on a positive, for the reason in test_library_skips_folders_without_audio
    — the bare `assert all(...)` here was green against a /library stubbed to return []."""
    j = client.post("/playground/generate",
                    json={"text": "Not a book. Just a clip.", "gpus": "cpu"}).get_json()
    _wait_terminal(client, j["job_id"])
    book_state.write_sidecar(books_out / "real (V)", {
        "source_docx": "r.docx", "voice": "V.wav",
        "chapters": [{"index": 0, "title": "Ch 1", "filename": "00_Ch_1", "status": "done"}]})

    lib = client.get("/library").get_json()
    assert (tmp_output / "playground").is_dir(), "the clip folder was never created"
    assert any(b["book"] == "real (V)" for b in lib), \
        "/library is not reading this tree at all — the negative below would prove nothing"
    assert all(b["book"] != "playground" for b in lib)


def test_playground_empty_text_400(client):
    assert client.post("/playground/generate", json={"text": "   "}).status_code == 400


def test_playground_uses_one_worker_whatever_is_saved(client, fake_pg, tmp_output, tmp_path,
                                                      monkeypatch):
    """🔴 A request that omits `workers` (playground, audition, extensions) gets ONE per device.

    This test used to prove the opposite property — that a saved count was honored — because a
    hardcoded 2 was quietly loading two replicas per card after the user dialed Settings down.
    5.4.1 settles it the other way: the count is not a setting at all, and a stale 3 left in the
    config must not reach the job. Same failure shape, opposite fix.
    """
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    client.put("/settings/app", json={"workers_per_card": 3})     # ignored since 5.4.1
    j = client.post("/playground/generate",
                    json={"text": "Workers default check here.", "gpus": "cpu", "seed": 4}).get_json()
    st = _wait_terminal(client, j["job_id"])
    assert st["workers"] == 1


def test_playground_file_upload_decodes_cp1252(client, fake_pg, tmp_output):
    """A legacy Word/Notepad .txt (cp1252) must not turn em-dashes into U+FFFD —
    strict UTF-8 first, cp1252 fallback."""
    import io as _io
    raw = "Leo's jacket — navy blue. It hung by the door.".encode("cp1252")
    r = client.post("/playground/generate",
                    data={"file": (_io.BytesIO(raw), "legacy.txt"), "gpus": "cpu", "seed": "5"},
                    content_type="multipart/form-data")
    assert r.status_code == 202
    st = _wait_terminal(client, r.get_json()["job_id"])
    assert "—" in st["text"] and "�" not in st["text"]


def test_nomi_extension_zip_download(client):
    """The Nomi tab's extension download: a zip built from the repo source, with
    everything under one folder so unzipping is clean."""
    import io as _io
    import zipfile
    r = client.get("/nomi/extension.zip")
    assert r.status_code == 200 and r.mimetype == "application/zip"
    z = zipfile.ZipFile(_io.BytesIO(r.data))
    names = z.namelist()
    assert "vocalis-tts-for-nomi/manifest.json" in names
    assert all(n.startswith("vocalis-tts-for-nomi/") for n in names)


def test_playground_narrate_actions_off_and_on_are_distinct_clips(client, fake_pg, tmp_output):
    """The narrate-*actions* checkbox is part of a clip's identity: same text+knobs
    with narration on vs off renders two separate clips, and the setting round-trips
    through the clip metadata."""
    body = {"text": '*She waves.* "Hello there my friend."', "gpus": "cpu", "seed": 11}
    j1 = client.post("/playground/generate", json={**body, "narrate_actions": True}).get_json()
    _wait_terminal(client, j1["job_id"])
    j2 = client.post("/playground/generate", json={**body, "narrate_actions": False}).get_json()
    assert "job_id" in j2, "narration-off must be a new clip, not a cache hit"
    _wait_terminal(client, j2["job_id"])
    clips = client.get("/playground/clips").get_json()
    assert sorted(c["narrate_actions"] for c in clips) == [False, True]
    assert all(c["text"].startswith("*She waves.*") for c in clips)   # ORIGINAL text stored


def test_playground_all_actions_with_narration_off_400(client, tmp_output):
    r = client.post("/playground/generate",
                    json={"text": "*just an action, nothing spoken*", "gpus": "cpu",
                          "narrate_actions": False, "seed": 1})
    assert r.status_code == 400
    assert "actions" in r.get_json()["error"]


def test_playground_incomplete_generation_fails_job(client, fake_pg, tmp_output, monkeypatch):
    """If the pool can't produce every chunk the JOB must fail — and no half-clip
    may ever appear in the library."""
    import torch
    class _HolePool:
        sr = FAKE_SR
        def run_chunks(self, items, params, save, total, on_event=None, chapter=None, cancel=None):
            if items:                                  # save only the first chunk -> hole remains
                save(items[0][0], torch.zeros(1, FAKE_SR // 10), FAKE_SR)
            return 0, 0.0
        def shutdown(self): pass
    monkeypatch.setattr(rt_pool, "get_pool", lambda d, w: _HolePool())
    text = "Sentence one here. Sentence two here. Sentence three here. " * 20
    j = client.post("/playground/generate", json={"text": text, "gpus": "cpu", "seed": 3}).get_json()
    st = _wait_terminal(client, j["job_id"])
    assert st["status"] == "failed"
    assert "incomplete" in (st["error"] or "")
    rows = client.get("/playground/clips").get_json()
    assert [r for r in rows if r["kind"] == "clip"] == []          # no half-clip published…
    assert any(r["kind"] == "partial" for r in rows)               # …but the workspace shows for resume


def test_partials_list_play_and_delete(client, tmp_output):
    """An interrupted render's workspace lists as a partial row (voice/seed/progress),
    its contiguous prefix streams as WAV ('the story so far' — chunks past a gap are
    not played), and deleting it removes the workspace. Traversal refs are skipped."""
    import torch
    h = "abcdef123456"
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, h)
    playground_clips.write_pending(ws, {
        "voice": "V.wav", "exaggeration": 0.5, "cfg": 0.5, "temperature": 0.8,
        "seed": 99, "random_seed": True, "turbo": False, "narrate_actions": True,   # stale keys: ignored
        "text": "An interrupted tale that keeps on going. " * 4, "total": 8})
    for i in (0, 1, 3):                          # hole at 2 -> playable prefix is 2
        save_wav_sf(str(ws / f"chunk_{i:04d}.wav"), torch.zeros(1, 2400), 24000)

    p = next(r for r in client.get("/playground/clips").get_json() if r["kind"] == "partial")
    assert p["ref"] == h and p["done"] == 3 and p["total"] == 8 and p["prefix"] == 2
    assert p["voice"] == "V.wav" and "seed" not in p     # stale manifest keys ignored
    assert p["voice_label"] == "V"
    assert p["text"].startswith("An interrupted tale")

    a = client.get(f"/playground/partials/{h}/audio")
    assert a.status_code == 200 and a.mimetype == "audio/wav"
    assert len(a.data) > 44                       # prefix audio, not an empty header

    r = client.delete("/playground/clips", json={"partials": [h, "../evil", "zzzz"]})
    assert r.get_json()["deleted"] == [h]         # bad refs skipped, not errors
    assert not ws.exists()
    assert client.get(f"/playground/partials/{h}/audio").status_code == 404


def test_playground_rejects_bad_param(client):
    r = client.post("/playground/generate",
                    json={"text": "Hello there.", "exaggeration": "loud", "gpus": "cpu"})
    assert r.status_code == 400


def test_get_pool_rebuilds_on_selection_change(monkeypatch):
    builds = []
    class _FakePool:
        def __init__(self, devices, workers):
            builds.append((tuple(devices), workers)); self.sr = FAKE_SR
        def shutdown(self): pass               # get_pool shuts the old pool down on rebuild
    monkeypatch.setattr(rt_pool, "WorkerPool", _FakePool)
    rt_pool._pool = None; rt_pool._pool_sig = None

    rt_pool.get_pool(["cuda:0"], 1)
    rt_pool.get_pool(["cuda:0"], 1)       # same sig -> reuse
    assert len(builds) == 1
    rt_pool.get_pool(["cuda:0"], 2)       # workers changed -> rebuild
    assert len(builds) == 2
    rt_pool.get_pool(["cuda:0", "cuda:1"], 2)  # devices changed -> rebuild
    assert len(builds) == 3
    rt_pool._pool = None; rt_pool._pool_sig = None


# ── GPU sensor strip (AMD sysfs hwmon) ───────────────────────────────────────

def test_gpu_sensors_convert_units_and_survive_missing_files(tmp_path, monkeypatch):
    """The strip reads power/clocks/temperature straight out of sysfs hwmon, where
    everything is in base SI units: microwatts and hertz. Getting the conversion
    wrong doesn't crash — it quietly reports a 13,000,000 W graphics card."""
    import tts_utils as tu

    hw = tmp_path / "hwmon0"
    hw.mkdir()
    (hw / "temp1_input").write_text("65000\n")          # millidegrees
    (hw / "power1_average").write_text("245000000\n")   # microwatts
    (hw / "freq1_input").write_text("2100000000\n")     # hertz (core)
    (hw / "freq2_input").write_text("1200000000\n")     # hertz (VRAM)
    monkeypatch.setattr(tu, "_hwmon_dir", lambda d: str(hw))

    assert tu.gpu_temp_c(0) == 65
    assert tu.gpu_power_w(0) == 245
    assert tu.gpu_clocks_mhz(0) == (2100, 1200)

    # An idle AMD card reports a core clock of 0 — clock gating, not a missing
    # sensor. It must read 0, not vanish (which would look like "no sensor").
    (hw / "freq1_input").write_text("0\n")
    assert tu.gpu_clocks_mhz(0) == (0, 1200)

    # power1_input is the fallback name some parts expose instead of power1_average
    (hw / "power1_average").unlink()
    (hw / "power1_input").write_text("39056000\n")
    assert tu.gpu_power_w(0) == 39

    # A card that exposes none of them yields None per field — the UI omits those
    # rather than rendering a blank, which is what keeps the Windows dev box working.
    for f in hw.iterdir():
        f.unlink()
    assert tu.gpu_power_w(0) is None
    assert tu.gpu_temp_c(0) is None
    assert tu.gpu_clocks_mhz(0) == (None, None)
    monkeypatch.setattr(tu, "_hwmon_dir", lambda d: None)      # non-AMD / non-Linux
    assert tu.gpu_power_w(0) is None and tu.gpu_temp_c(0) is None


# ── werkzeug client-disconnect noise ─────────────────────────────────────────

# Representative Werkzeug disconnect trace. This exact shape is the whole point: Werkzeug
# does NOT pass the exception on the record — serving.py renders it with
# DebugTraceback(e).render_traceback_text() and logs the traceback as plain TEXT. A
# filter that inspects record.exc_info sees None and passes every one of these through,
# which is exactly what the first version of this filter did. Test the real shape.
_REAL_WERKZEUG_MSG = """Error on request:
Traceback (most recent call last):
  File "/home/test-user/Vocalis/venv/lib/python3.12/site-packages/werkzeug/serving.py", line 335, in execute
    write(data)
  File "/usr/lib/python3.12/ssl.py", line 1191, in send
    return self._sslobj.write(data)
           ^^^^^^^^^^^^^^^^^^^^^^^^
BrokenPipeError: [Errno 32] Broken pipe

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/home/test-user/Vocalis/venv/lib/python3.12/site-packages/werkzeug/serving.py", line 371, in run_wsgi
    execute(self.server.app)
  File "/usr/lib/python3.12/ssl.py", line 1115, in read
    return self._sslobj.read(len, buffer)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
ssl.SSLError: [SSL: UNEXPECTED_EOF_WHILE_READING] unexpected eof while reading (_ssl.c:2580)
"""


def test_client_disconnect_tracebacks_are_dropped_but_real_errors_are_not():
    """Pressing ▶ (or seeking) on a 90 MB training clip made werkzeug log a full ERROR
    traceback: the browser starts the download, then hangs up and re-requests with a
    Range header so it can buffer instead of pulling two hours of audio — so the server
    is mid-write when the socket dies. Nothing failed and there is nothing to act on,
    but a steady drip of ERROR tracebacks buries the errors that DO matter, which is
    which is why only this expected disconnect is dropped."""
    import logging
    import ssl as _ssl

    f = vs._DropClientDisconnects()

    def rec(msg, exc=None):
        return f.filter(logging.LogRecord(
            "werkzeug", logging.ERROR, __file__, 1, msg, (),
            (type(exc), exc, None) if exc else None))

    # THE REAL ONE: traceback in the message, exc_info None.
    assert not rec(_REAL_WERKZEUG_MSG)

    # the same event in its other guises
    assert not rec("Error on request:\nConnectionResetError: [Errno 104] reset by peer")
    assert not rec("Error on request:\nssl.SSLEOFError: EOF occurred in violation")

    # and still dropped if a future werkzeug DOES attach the exception
    assert not rec("Error on request:", BrokenPipeError(32, "Broken pipe"))
    assert not rec("Error on request:", _ssl.SSLError(
        "[SSL: UNEXPECTED_EOF_WHILE_READING] unexpected eof while reading"))

    # the idle-socket twin: the peer left a keep-alive socket open after playback and the
    # socket clock (SOCKET_TIMEOUT_S) fired. http.server logs this with NO "Error on
    # request" traceback, so it must be matched on its own text, not the reset family's.
    assert not rec("127.0.0.1 - - [22/Jul/2026 22:19:25] Request timed out: "
                   "TimeoutError('The read operation timed out')")
    assert not rec("Request timed out: TimeoutError('The read operation timed out')")

    # …but a genuine failure still shouts. A cert/protocol problem IS ours.
    assert rec("Error on request:\nssl.SSLError: [SSL: CERTIFICATE_VERIFY_FAILED] bad cert")
    assert rec("Error on request:\nssl.SSLError: [SSL: WRONG_VERSION_NUMBER] wrong version")
    assert rec("Error on request:\nRuntimeError: something actually broke")
    assert rec("Error on request:", RuntimeError("something actually broke"))
    assert rec("Restarting with stat")                   # unrelated werkzeug chatter
    # a BrokenPipe mentioned outside a request error is NOT werkzeug's noise — keep it
    assert rec("BrokenPipeError while writing the audiobook")
    # our OWN timeouts don't carry werkzeug's "Request timed out" prefix — keep those
    assert rec("comfyui restart timed out after 60s")
    assert rec("Error on request:\nRuntimeError: GPU render timed out")


def test_failed_reunlock_of_open_store_does_not_evict_the_live_key():
    """A stale single-use SUK POSTed against an ALREADY-open store must be a no-op, not an
    eviction. : the browser auto-redeems its rotating SUK whenever /health reads
    `locked` (redeemSuk); a second tab — or a replay after a dropped response — POSTed a
    consumed key, and _unlock_all's blanket lock-on-failure zeroed the WORKING DEK. Repeated
    self-inflicted locks, no restart, no logout, 500ing every in-flight render."""
    import threading
    import pytest
    import vault_store as vsm
    from vault import VaultAuthError                      # BaseException — the real reject type

    class FakeVault:
        def __init__(self, locked): self.locked = locked
        def is_unlocked(self): return not self.locked
        def lock(self): self.locked = True
        def migrate_structural_names(self): pass

    def make(locked):
        s = object.__new__(vsm.VaultStore)               # skip __init__: exercise _unlock_all alone
        s._mu = threading.RLock()
        s._vaults = [FakeVault(locked), FakeVault(locked)]
        s._dev_unlocked = not locked
        return s

    # OPEN store, a re-unlock that rejects a stale key on the 2nd vault -> STAY OPEN.
    store = make(locked=False)
    def reject_second(v):
        if v is store._vaults[1]:
            raise VaultAuthError("stale suk")
    with pytest.raises(BaseException):
        store._unlock_all(reject_second)
    assert store.is_unlocked(), "a rejected re-unlock evicted a working DEK"

    # LOCKED store, a genuine PARTIAL unlock (1st ok, 2nd fails) -> all-or-none: lock everything.
    store2 = make(locked=True)
    def partial(v):
        if v is store2._vaults[1]:
            raise VaultAuthError("bad")
        v.locked = False
    with pytest.raises(BaseException):
        store2._unlock_all(partial)
    assert not store2.is_unlocked(), "a partial unlock must roll back to locked"


def test_cpu_stats_is_top_style_and_degrades_gracefully(monkeypatch, tmp_path):
    """100% = ONE logical core (top's convention), so a 32-thread box saturates at
    3200% — not 100%. And the load is a DELTA between polls, so the first call has no
    answer yet and must say so rather than inventing a since-boot average."""
    import tts_utils as tu

    stat = tmp_path / "stat"
    tu._CPU_PREV.clear()
    monkeypatch.setattr(tu.os, "cpu_count", lambda: 32)

    real_open = open                                # before we shadow it, obviously

    def _open(path, *a, **k):
        return real_open(stat if path == "/proc/stat" else path, *a, **k)
    monkeypatch.setattr("builtins.open", _open)

    # idle is field 4; here: 100 busy ticks, 900 idle
    stat.write_text("cpu  100 0 0 900 0 0 0 0 0 0\n")
    assert tu._cpu_percent() is None                 # first sample: no delta to report

    # next second: +100 busy, +100 idle → 50% of the whole CPU → 50% × 32 = 1600%
    stat.write_text("cpu  200 0 0 1000 0 0 0 0 0 0\n")
    assert tu._cpu_percent() == 1600

    # every thread pinned → 3200%, the real ceiling on this box
    stat.write_text("cpu  1200 0 0 1000 0 0 0 0 0 0\n")
    assert tu._cpu_percent() == 3200

    # a box with none of these files reports None per field, and the UI omits the row
    tu._CPU_PREV.clear()
    tu._CPU_PATHS.clear()
    monkeypatch.setattr("builtins.open", lambda *a, **k: (_ for _ in ()).throw(OSError()))
    assert tu._cpu_percent() is None
    assert tu._cpu_mhz() is None and tu._cpu_temp_c() is None and tu._cpu_power_w() is None


def _fake_proc(monkeypatch, files):
    """Point open() at a dict of {path: text}; anything else raises, as it does off Linux."""
    real_open = open

    def _open(path, *a, **k):
        p = str(path)
        if p in files:
            return io.StringIO(files[p])
        if p.startswith("/proc") or p.startswith("/sys"):
            raise FileNotFoundError(2, "No such file or directory", p)
        return real_open(path, *a, **k)
    monkeypatch.setattr("builtins.open", _open)


_MEMINFO = ("MemTotal:       94100468 kB\nMemFree:         3376864 kB\n"
            "MemAvailable:   40569284 kB\nCached:         37869812 kB\n"
            "SwapCached:      2579788 kB\nSwapTotal:      67108860 kB\n"
            "SwapFree:       57617472 kB\n")

#: Linux /proc/pressure/memory sample.
_PSI = ("some avg10=0.00 avg60=0.00 avg300=0.01 total=2002383869\n"
        "full avg10=0.00 avg60=0.00 avg300=0.01 total=1842689380\n")


def test_swap_is_read_from_the_meminfo_the_ram_line_already_opened(monkeypatch):
    """The header's swap line (7.3.2). Two things at once: the arithmetic, and the fact that a
    box with swap TURNED OFF reports None rather than "0.0 / 0.0 GB" — a line that would then
    sit in the header of every such box forever, saying nothing."""
    import tts_utils as tu

    _fake_proc(monkeypatch, {"/proc/meminfo": _MEMINFO})
    assert tu._swap_gb() == (9.1, 64.0)          # (67108860 - 57617472) kB → GiB

    _fake_proc(monkeypatch, {"/proc/meminfo": _MEMINFO.replace("SwapTotal:      67108860",
                                                              "SwapTotal:             0")})
    assert tu._swap_gb() is None, "swap off must omit the line, not print a pair of zeros"

    _fake_proc(monkeypatch, {})                  # Windows: no /proc at all
    assert tu._swap_gb() is None


def test_meminfo_is_read_once_for_both_the_ram_and_swap_figures(monkeypatch):
    """Both figures come off the same six lines, and cpu_stats() runs 4x/s with several readers
    behind it. Opening the same pseudo-file twice per sample to answer two questions from one
    read is the kind of waste that never shows up in a profile and never stops costing.

    Pinned to the /proc path (11.1.5): this is exercising `_meminfo`'s single-read sharing, which
    only exists on the Linux side — `cpu_stats()` would otherwise take the real `_win_*` branch
    on a Windows box and never call `open()` at all."""
    import tts_utils as tu

    monkeypatch.setattr(tu.os, "name", "posix")
    opens = []
    real_open = open

    def _open(path, *a, **k):
        p = str(path)
        opens.append(p)
        if p == "/proc/meminfo":
            return io.StringIO(_MEMINFO)
        if p.startswith("/proc") or p.startswith("/sys"):
            raise FileNotFoundError(2, "No such file or directory", p)
        return real_open(path, *a, **k)
    monkeypatch.setattr("builtins.open", _open)
    monkeypatch.setattr(tu, "_cpu_percent", lambda: 100)

    s = tu.cpu_stats()
    assert s["mem_used_gb"] == 51.1 and s["swap_used_gb"] == 9.1   # 53531184 kB, 9491388 kB
    assert opens.count("/proc/meminfo") == 1, (
        f"/proc/meminfo was opened {opens.count('/proc/meminfo')} times in one sample — "
        "_cpu_mem and _swap_gb must share the read that cpu_stats() already did.")


def test_memory_pressure_reads_psi_and_keeps_the_since_boot_total(monkeypatch):
    """🔴 THE SINCE-BOOT TOTAL IS THE HALF THAT CARRIES HISTORY, and it is the half a
    "just show the current number" simplification would drop. PSI's averages decay to 0.00
    within seconds of the pressure ending — remote host reads `avg10=0.00` while sitting on 33 minutes
    of accumulated stall — so a line printing only `avg10` says "fine" about a box that spent
    half an hour of the day waiting on memory. `total` is monotonic and cannot decay.

    The `some` line, not `full`: `full` means every task was stalled, which is a box already on
    the floor. `some` still moves while there is something to be done about it."""
    import tts_utils as tu

    _fake_proc(monkeypatch, {tu._PSI_MEM: _PSI})
    p = tu._mem_psi()
    assert p == {"avg10": 0.0, "avg60": 0.0, "avg300": 0.01, "total_s": 2002}

    # …and it must take `some`, whose figures differ from `full`'s on a box under real pressure.
    _fake_proc(monkeypatch, {tu._PSI_MEM: ("some avg10=18.40 avg60=9.10 avg300=3.20 total=7860000000\n"
                                           "full avg10=4.10 avg60=2.00 avg300=0.70 total=1200000000\n")})
    assert tu._mem_psi() == {"avg10": 18.4, "avg60": 9.1, "avg300": 3.2, "total_s": 7860}

    # A kernel built without CONFIG_PSI, and Windows: the line is omitted, nothing is invented.
    _fake_proc(monkeypatch, {})
    assert tu._mem_psi() is None
    _fake_proc(monkeypatch, {tu._PSI_MEM: "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"})
    assert tu._mem_psi() is None, "no `some` line means no reading — do not fall back to `full`"


def test_uptime_and_load_average_ride_the_same_sample(monkeypatch):
    """The top header line's other two readouts (7.3.4). Uptime is what makes the stall total
    below it readable at all — 33 minutes of stall means nothing until you know whether the box
    has been up sixteen hours or twenty minutes — and load average is the contention signal the
    CPU row's percentage cannot show, since it counts tasks WAITING as well as running."""
    import tts_utils as tu

    _fake_proc(monkeypatch, {"/proc/uptime": "58980.42 1834762.11\n",
                             "/proc/loadavg": "0.07 0.95 2.14 2/3421 251552\n"})
    assert round(tu._uptime_s()) == 58980
    assert tu._loadavg() == [0.07, 0.95, 2.14]

    # A load average is three numbers or it is nothing: a truncated file must not yield a
    # half-filled row, which would print "0.07  " and read as two idle windows.
    _fake_proc(monkeypatch, {"/proc/loadavg": "0.07 0.95\n"})
    assert tu._loadavg() is None
    _fake_proc(monkeypatch, {})
    assert tu._uptime_s() is None and tu._loadavg() is None


def test_cpu_stats_omits_swap_and_pressure_on_a_box_that_cannot_report_them(monkeypatch):
    """The Linux degrade path: a kernel with none of /proc/meminfo, /proc/pressure/memory,
    /proc/uptime or /proc/loadavg (a stripped container, say). Every key must still be present
    and None — the renderer keys off `!= null`, and a missing key would read the same way but
    crash anything that iterates the dict.

    🔴 11.1.5: this used to double as the Windows case too, because before that release EVERY
    field came back None on Windows for the same reason it does here — no /proc at all. That
    stopped being true once `cpu_stats()` grew a real `_win_*` branch (pct, clock, RAM and uptime
    now come from Win32 APIs there, not from these faked-out `open()` calls), so this test pins
    `os.name` to the Linux path explicitly — it is testing the /proc degrade, not "whatever this
    box happens to be" — and the now-Windows-only fields (swap, PSI) get their own coverage in
    the `_win_cpu_stats` tests below."""
    import tts_utils as tu

    monkeypatch.setattr(tu.os, "name", "posix")      # pin to the /proc path regardless of the box
    _fake_proc(monkeypatch, {})
    monkeypatch.setattr(tu, "_cpu_percent", lambda: None)
    s = tu.cpu_stats()
    assert s["swap_used_gb"] is None and s["swap_total_gb"] is None and s["mem_psi"] is None
    assert s["mem_used_gb"] is None and s["mem_reclaimable_gb"] is None
    assert s["uptime_s"] is None and s["loadavg"] is None


# ── CPU stats — Windows (11.1.5) ──────────────────────────────────────────────
# The four `_win_get_*` functions are the only things in `tts_utils.py` that touch
# `ctypes.windll` — everything above them (`_win_cpu_percent`, `_win_cpu_mhz`, `_win_cpu_mem`,
# `_win_uptime_s`) is pure delta/averaging/unit-conversion arithmetic over whatever those raw
# getters return, which is exactly what makes it testable by injecting plain tuples/lists here
# instead of faking a live Win32 DLL call.

def test_win_cpu_percent_is_top_style_first_call_none_and_kernel_includes_idle(monkeypatch):
    """Same contract as `_cpu_percent` (top-style, delta since last call, None on the first
    call) but a different formula, because GetSystemTimes' kernel bucket INCLUDES idle time —
    unlike /proc/stat's disjoint counters. If the idle subtraction were dropped (i.e. `busy`
    computed as `d_total / d_total`) this would read 100% busy on an idle box; mutation-checked
    by hand against `_win_cpu_percent`'s source during development."""
    import tts_utils as tu

    tu._CPU_PREV.clear()
    monkeypatch.setattr(tu.os, "cpu_count", lambda: 32)

    samples = iter([
        (900, 1000, 0),          # boot-ish baseline: 900 idle of 1000 kernel, 0 user
        (1000, 1100, 100),       # +100 idle, +100 kernel, +100 user over the interval
    ])
    monkeypatch.setattr(tu, "_win_get_system_times", lambda: next(samples))

    assert tu._win_cpu_percent() is None                # first sample: no delta yet
    # d_idle=100, d_kernel=100, d_user=100 -> d_total=200, busy=(200-100)/200=0.5 -> 50% of
    # the whole box -> 50% * 32 cores * 100 = 1600, the same shape as the Linux example above.
    assert tu._win_cpu_percent() == 1600

    # Every thread pinned: d_idle=0, d_kernel=+100, d_user=+100 -> d_total=200, busy=1.0.
    tu._CPU_PREV.clear()
    samples = iter([(1000, 1100, 100), (1000, 1200, 200)])
    monkeypatch.setattr(tu, "_win_get_system_times", lambda: next(samples))
    tu._win_cpu_percent()
    assert tu._win_cpu_percent() == 3200

    # The strip's "stat" key (Linux) and this function's "win_times" key must never collide —
    # each degrades on its own box without disturbing the other's delta state.
    assert "win_times" in tu._CPU_PREV and "stat" not in tu._CPU_PREV


def test_win_cpu_percent_degrades_to_none_on_a_failing_win32_call(monkeypatch):
    """GetSystemTimes failing (an OSError from `ctypes.WinError()`, or the attribute not
    existing at all on a stripped-down interpreter) must degrade `pct` alone — never raise out
    of `cpu_stats()`, per the acceptance contract for every Win32 call in this file."""
    import tts_utils as tu

    tu._CPU_PREV.clear()

    def _boom():
        raise OSError("GetSystemTimes failed (fake)")
    monkeypatch.setattr(tu, "_win_get_system_times", _boom)
    assert tu._win_cpu_percent() is None


def test_win_cpu_mhz_combines_base_clock_with_the_pdh_performance_percentage(monkeypatch):
    """🔴 : `CallNtPowerInformation`'s `CurrentMhz` measured a CONSTANT 4300 on every
    core of this real box regardless of load — it is the nominal base clock, not a live
    reading — while Windows' own `% Processor Performance` counter read 120.6 at the same
    instant (real clock ≈5186 MHz, matching Task Manager's own "Speed" figure). So `mhz` is
    `base_mhz × perf_pct / 100`, not an average of `CurrentMhz`, and this test pins that formula
    against those measured numbers."""
    import tts_utils as tu

    monkeypatch.setattr(tu, "_win_get_processor_max_mhz_list", lambda: [4300] * 32)
    monkeypatch.setattr(tu, "_win_get_processor_performance_pct", lambda: 120.6)
    assert tu._win_cpu_mhz() == 5186             # round(4300 * 120.6 / 100) = round(5185.8)

    # Averaging still applies to the base clock half, same rule as `_cpu_mhz` (not maxed — one
    # core's base figure differing from the rest must not read as the whole box's speed).
    monkeypatch.setattr(tu, "_win_get_processor_max_mhz_list", lambda: [4300] * 30 + [3800, 3800])
    monkeypatch.setattr(tu, "_win_get_processor_performance_pct", lambda: 100.0)
    assert tu._win_cpu_mhz() == 4269              # (4300*30 + 3800*2) / 32 = 4268.75 -> 4269

    # The PDH counter is a RATE counter: its first collection has nothing to compute a ratio
    # from and must degrade the whole figure to None, not fall back to reporting the base clock
    # alone — that would silently reintroduce the exact bug this formula exists to fix.
    monkeypatch.setattr(tu, "_win_get_processor_performance_pct", lambda: None)
    assert tu._win_cpu_mhz() is None


def test_win_cpu_mhz_degrades_on_a_failing_base_clock_or_pdh_call(monkeypatch):
    """Either half of the `base_mhz × perf_pct / 100` formula failing must degrade `mhz` alone,
    never raise out of `cpu_stats()` — same contract as every other Win32/PDH call in this
    file."""
    import tts_utils as tu

    def _boom_base():
        raise OSError("CallNtPowerInformation failed (fake)")
    monkeypatch.setattr(tu, "_win_get_processor_max_mhz_list", _boom_base)
    assert tu._win_cpu_mhz() is None

    monkeypatch.setattr(tu, "_win_get_processor_max_mhz_list", lambda: [4300] * 32)

    def _boom_pdh():
        raise OSError("PdhCollectQueryData failed (fake)")
    monkeypatch.setattr(tu, "_win_get_processor_performance_pct", _boom_pdh)
    assert tu._win_cpu_mhz() is None


def test_win_cpu_mem_matches_the_linux_formula_and_degrades_on_failure(monkeypatch):
    """`used = total - available`, same as `_cpu_mem` — `ullAvailPhys` is
    GlobalMemoryStatusEx's own estimate of what a new allocation could take, the Windows
    analogue of MemAvailable, not a naive total-free."""
    import tts_utils as tu

    total = 16 * 1073741824            # 16 GiB, in bytes — GlobalMemoryStatusEx's own unit
    avail = 4 * 1073741824             # 4 GiB available -> 12 GiB used
    monkeypatch.setattr(tu, "_win_get_memory_status", lambda: (total, avail))
    assert tu._win_cpu_mem() == (12.0, 16.0)

    def _boom():
        raise OSError("GlobalMemoryStatusEx failed (fake)")
    monkeypatch.setattr(tu, "_win_get_memory_status", _boom)
    assert tu._win_cpu_mem() is None

    # A zero-length report (should never happen, but the field must still degrade, not divide
    # by a zero total or claim a box with no RAM).
    monkeypatch.setattr(tu, "_win_get_memory_status", lambda: (0, 0))
    assert tu._win_cpu_mem() is None


def test_win_uptime_reads_tick_count_and_degrades_on_failure(monkeypatch):
    """GetTickCount64 is milliseconds; `_win_uptime_s` must hand back seconds, same unit
    `_uptime_s` reports on Linux."""
    import tts_utils as tu

    monkeypatch.setattr(tu, "_win_get_tick_count_ms", lambda: 574666562)
    assert tu._win_uptime_s() == 574666.562

    def _boom():
        raise OSError("GetTickCount64 failed (fake)")
    monkeypatch.setattr(tu, "_win_get_tick_count_ms", _boom)
    assert tu._win_uptime_s() is None


def test_win_cpu_stats_degrades_only_the_one_field_a_failing_call_hits(monkeypatch):
    """The dict-assembly test: three of the four live Win32 sources succeed and one fails, and
    only that one field must come back None — a shared `except` swallowing all of them into a
    single failure would silently blank the whole row over one bad call."""
    import tts_utils as tu

    tu._CPU_PREV.clear()
    monkeypatch.setattr(tu.os, "name", "nt")
    monkeypatch.setattr(tu.os, "cpu_count", lambda: 8)
    monkeypatch.setattr(tu, "_win_get_system_times", lambda: (100, 200, 0))

    def _mhz_boom():
        raise OSError("CallNtPowerInformation failed (fake)")
    monkeypatch.setattr(tu, "_win_get_processor_max_mhz_list", _mhz_boom)
    monkeypatch.setattr(tu, "_win_get_memory_status", lambda: (16 * 1073741824, 8 * 1073741824))
    monkeypatch.setattr(tu, "_win_get_tick_count_ms", lambda: 60000)
    # Isolates this test from the real HWiNFO/LHM probe `_win_cpu_temp_source` would otherwise
    # make (a real shared-memory open plus a real loopback HTTP attempt) — irrelevant to what
    # this test is checking, and on a box where either app happens to be running it would make
    # `temp_c` non-None and turn this into a flaky assertion elsewhere. See the dedicated
    # `_win_cpu_temp_source`/HWiNFO/LHM tests below for that machinery's own coverage.
    monkeypatch.setattr(tu, "_win_cpu_temp_source", lambda: (None, None))

    s = tu.cpu_stats()
    assert s["mhz"] is None                              # the one that failed
    assert s["mem_used_gb"] == 8.0 and s["mem_total_gb"] == 16.0   # the others still report
    assert s["uptime_s"] == 60.0
    assert s["cores"] == 8


def test_win_cpu_stats_fields_with_no_windows_source_stay_none(monkeypatch):
    """`power_w`, `mem_reclaimable_gb`, `mem_psi`, `loadavg` and both `swap_*` keys have no
    unprivileged Windows API behind them at all — they must be present (the renderer keys off
    `!= null` and a missing key crashes it) and always None, regardless of whether the live
    samples succeed.

    🔴 `temp_c` USED TO BE IN THAT LIST TOO, AND NO LONGER BELONGS HERE: now that HWiNFO/
    LibreHardwareMonitor shared-reading support exists, `temp_c` CAN report a value — just not
    from a Windows API, and only while one of those apps happens to be running. That path is
    stubbed to "neither is running" below (also keeping this test from making a REAL
    shared-memory/loopback-HTTP probe) so this test still isolates the fields with no path to a
    value at all; the "a source answers" cases get their own tests further down, alongside
    `_win_cpu_temp_source`'s own cache/precedence/degrade coverage."""
    import tts_utils as tu

    monkeypatch.setattr(tu.os, "name", "nt")
    monkeypatch.setattr(tu, "_win_get_system_times", lambda: (1, 2, 0))
    monkeypatch.setattr(tu, "_win_get_processor_max_mhz_list", lambda: [4000])
    monkeypatch.setattr(tu, "_win_get_processor_performance_pct", lambda: 100.0)
    monkeypatch.setattr(tu, "_win_get_memory_status", lambda: (2 * 1073741824, 1073741824))
    monkeypatch.setattr(tu, "_win_get_tick_count_ms", lambda: 1000)
    monkeypatch.setattr(tu, "_win_cpu_temp_source", lambda: (None, None))

    s = tu.cpu_stats()
    for key in ("power_w", "mem_reclaimable_gb", "mem_psi", "loadavg",
                "swap_used_gb", "swap_total_gb"):
        assert s[key] is None, f"{key} has no Windows source and must stay None"
    # `temp_c`/`temp_src` degrade the same way once no source is found, and `temp_hint` — absent
    # from every OTHER field on this row — appears with the exact text shown in the system strip.
    assert s["temp_c"] is None and s["temp_src"] is None
    assert s["temp_hint"] == (
        "CPU temperature on Windows comes from HWiNFO (Settings ▸ Shared Memory Support) or "
        "LibreHardwareMonitor (Options ▸ Remote Web Server) while it is running.")


@pytest.mark.skipif(os.name != "nt", reason="exercises the real Win32/PDH API, Windows only")
def test_windows_raw_getters_and_real_cpu_stats_have_plausible_shapes():
    """The live check: no fakes, the actual `ctypes.windll` calls against this real box — but
    NO real sleep. The delta/rate arithmetic (GetSystemTimes deltas in `_win_cpu_percent`, the
    PDH rate counter in `_win_cpu_mhz`) is already covered above with injected fakes and no wall
    clock; this only proves the raw getters and the real `cpu_stats()` assembly run against the
    live APIs without raising and return numbers of the right SHAPE — a single sample each,
    nothing that needs two readings apart in time."""
    import tts_utils as tu

    idle, kernel, user = tu._win_get_system_times()
    assert idle > 0 and kernel > 0 and user >= 0
    assert kernel >= idle                                 # kernel time INCLUDES idle — see
    # `_win_cpu_percent`'s docstring for why that changes the delta formula.

    total, avail = tu._win_get_memory_status()
    assert total > 0 and 0 <= avail <= total

    assert tu._win_get_tick_count_ms() > 0

    base_vals = tu._win_get_processor_max_mhz_list()
    assert base_vals and all(v > 0 for v in base_vals)

    # The PDH query: opening it and collecting once must not raise. A first collection
    # legitimately returns None (a rate counter has nothing to divide by yet), so this proves
    # the query/counter open and collect cleanly rather than asserting a value out of them.
    perf = tu._win_get_processor_performance_pct()
    assert perf is None or perf >= 0

    s = tu.cpu_stats()
    assert isinstance(s["cores"], int) and s["cores"] >= 1
    assert s["mhz"] is None or s["mhz"] > 0
    assert s["mem_total_gb"] > 0
    assert s["uptime_s"] > 0

    # 🔴 THE ONE LIVE CHECK FOR THE HWiNFO/LHM TEMPERATURE PATH: everything ELSE about
    # `_win_cpu_temp_source` (struct parsing, label preference, JSON tree walking, the cache and
    # re-probe windows, degrading on a raise) is covered with fabricated buffers/trees and an
    # injected clock further below — no real mapping, no real network, in any of those. This is
    # only "does the real path run against this real box without raising or hanging", the same
    # question the rest of this test asks of the other live Win32 calls. Neither HWiNFO nor
    # LibreHardwareMonitor is installed on this box, so the plausible answer is "no source, but
    # fast and clean" — a wrong answer here (an exception, or a multi-second stall) is the
    # regression this exists to catch.
    tu._WIN_TEMP_STATE.update(temp_c=None, source=None, resolved_at=None, probed_at=None,
                               refreshing=False)
    t0 = time.monotonic()
    temp_s = tu.cpu_stats()
    elapsed_ms = (time.monotonic() - t0) * 1000
    assert temp_s["temp_c"] is None and temp_s["temp_src"] is None
    assert temp_s["temp_hint"] == (
        "CPU temperature on Windows comes from HWiNFO (Settings ▸ Shared Memory Support) or "
        "LibreHardwareMonitor (Options ▸ Remote Web Server) while it is running.")
    # `_win_cpu_temp_source` must not probe inline: `cpu_stats()` runs under `runtime/gpu.py`'s
    # `_STRIP_LOCK`, shared with `GET /system/stats`, the `/system/stream` SSE generator and
    # jobs.py's per-job `emit`, so that cost used to stall all three behind one CPU sample in
    # every 15s. Now the probe runs on a background thread this call only ever TRIGGERS, so the
    # call itself must be a status-dict read, not a network wait — tight enough to fail on a
    # regression back to inline probing, generous enough not to flake on a loaded CI box.
    assert elapsed_ms < 50, (
        f"cpu_stats() took {elapsed_ms:.1f} ms — the temperature probe must never block its "
        f"caller (see _win_cpu_temp_source's own docstring)")
    # And the trigger genuinely happened — a background refresh really was launched rather than
    # silently skipped. Checked either way round because the real daemon thread may already have
    # finished (and cleared `refreshing`) by the time this line runs: `probed_at` being set is
    # just as much proof a refresh ran as catching it still `refreshing`. Whether it actually
    # FINDS anything on this box is exactly what the separate ad hoc verification (20 consecutive
    # real calls, max single-call time, thread-count/leak check) confirms — deliberately not
    # awaited here, since awaiting it would reintroduce the same real-time dependency this fix
    # removed from the hot path.
    assert tu._WIN_TEMP_STATE["refreshing"] is True or tu._WIN_TEMP_STATE["probed_at"] is not None


# ── CPU temperature — Windows HWiNFO / LibreHardwareMonitor (11.1.x) ─────────────────────────
# `_win_cpu_temp_source` and everything it calls are exercised entirely with FABRICATED data —
# a hand-built shared-memory buffer for HWiNFO, a hand-built JSON tree for LHM — never a real
# mapping and never a real socket. `test_windows_raw_getters_and_real_cpu_stats_have_plausible_
# shapes` above is the one place the real thing runs, and it only proves the real path doesn't
# raise or hang; every behavioral claim (which label wins, striding, caching, degrade-on-raise)
# is proven here instead, where it can be proven exactly.

def _win_reset_temp_state():
    """Resets the module-level cache/failure-log state these tests share with each other and
    with `test_win_cpu_stats_*` above — same reasoning as `tu._CPU_PREV.clear()` elsewhere in
    this file: it's process-wide state that outlives any one test in the same xdist worker."""
    import tts_utils as tu
    tu._WIN_TEMP_STATE.update(temp_c=None, source=None, resolved_at=None, probed_at=None,
                               refreshing=False)
    tu._WIN_LOGGED.clear()


def _win_inline_runner(fn):
    """A synchronous stand-in for `tu._WIN_TEMP_RUNNER`: calls the refresh function directly,
    on the calling thread, instead of spawning `vocalis-cputemp`. Every test below passes this
    (or something built on it) as `runner=` — no real thread, no sleep, anywhere in this file."""
    fn()


def _win_resolve_temp(tu, now, runner=None):
    """`_win_cpu_temp_source` always returns the value cached BEFORE any refresh it just
    triggered — see its own docstring — so a test that wants the value AFTER a refresh calls it
    TWICE at the same `now`: once to trigger (and, with an inline runner, complete) the refresh,
    once more to read the now-fresh cache. This helper is that pattern, reused by every test that
    doesn't care about the two-call mechanics for their own sake (those get their own dedicated
    tests below)."""
    run = runner if runner is not None else _win_inline_runner
    tu._win_cpu_temp_source(now=now, runner=run)
    return tu._win_cpu_temp_source(now=now, runner=run)


def _hwinfo_reading_bytes(reading_type, label_orig, label_user, value, unit="C"):
    """One `_HwInfoReadingElement`-shaped record, packed exactly like the real ctypes struct
    (`<III128s128s16sdddd`, 316 bytes) — `struct.pack`, not the ctypes struct itself, so the test
    buffer is built independently of the code under test rather than round-tripping through it."""
    return struct.pack(
        "<III128s128s16sdddd",
        reading_type, 0, 0,
        label_orig.encode("latin-1").ljust(128, b"\x00"),
        label_user.encode("latin-1").ljust(128, b"\x00"),
        unit.encode("latin-1").ljust(16, b"\x00"),
        float(value), 0.0, 0.0, 0.0,
    )


def _build_hwinfo_shm(readings, *, signature=None, extra_stride=0):
    """Builds a fake HWiNFO shared-memory buffer: header + a reading section only (no sensor
    section — `_win_parse_hwinfo_shm` never reads one; see its own docstring on why). `readings`
    is `[(reading_type, label_orig, label_user, value), ...]`.

    `extra_stride` pads every element with that many trailing 0xEE bytes (never 0x00, so a
    striding bug that reads them AS data — rather than skipping past them — cannot coincidentally
    still produce the right answer) and grows the header's own `dwSizeOfReadingElement` to match,
    which is what `test_hwinfo_shm_strides_by_the_headers_own_element_size` uses to prove the
    header's stride is what's actually used to advance between elements."""
    import tts_utils as tu
    sig = signature if signature is not None else tu._HWINFO_SIGNATURE_ALIVE
    elem_size = 316 + extra_stride
    body = b""
    for reading_type, label_orig, label_user, value in readings:
        body += _hwinfo_reading_bytes(reading_type, label_orig, label_user, value)
        body += b"\xee" * extra_stride
    header_size = 44
    header = struct.pack(
        "<IIIqIIIIII",
        sig, 2, 0, 1700000000,          # dwSignature, dwVersion, dwRevision, poll_time
        0, 0, 0,                        # sensor section offset/size/count — unused by this file
        header_size, elem_size, len(readings),
    )
    return bytearray(header + body)


def _hwinfo_addr(buf: bytearray) -> int:
    """The address of a fabricated buffer's first byte, for `_win_parse_hwinfo_shm(base)` to
    read from — exactly the pointer arithmetic a real mapping's base address would give it,
    without opening one."""
    return ctypes.addressof((ctypes.c_char * len(buf)).from_buffer(buf))


def test_hwinfo_shm_picks_the_preferred_label_over_a_user_renamed_one(monkeypatch):
    """Builds a section with: a non-temp reading (must be skipped), a temperature reading whose
    ORIGINAL label is a lower-priority match ("CPU Package" — present only as a decoy so a
    naive "first temperature wins" implementation would pick it instead), and — placed LAST in
    the buffer, so a naive "last one wins" implementation would also fail — the preferred
    "CPU (Tctl/Tdie)" reading, published under a user-renamed `szLabelUser` ("My Renamed CPU").
    The chosen label/value must be the preferred ORIGINAL one regardless of buffer position or
    the user-facing rename."""
    import tts_utils as tu

    buf = _build_hwinfo_shm([
        (tu._HWINFO_SENSOR_TYPE_TEMP + 5, "GPU Hot Spot", "GPU Hot Spot", 55.0),   # not TEMP type
        (tu._HWINFO_SENSOR_TYPE_TEMP, "CPU Package", "CPU Package", 58.0),        # decoy, lower rank
        (tu._HWINFO_SENSOR_TYPE_TEMP, "CPU (Tctl/Tdie)", "My Renamed CPU", 61.8),  # preferred, renamed
    ])
    result = tu._win_parse_hwinfo_shm(_hwinfo_addr(buf))
    assert result == (62, "CPU (Tctl/Tdie)")               # round(61.8) == 62; the ORIGINAL label


def test_hwinfo_shm_falls_back_to_first_temperature_when_nothing_preferred_matches(monkeypatch):
    """No label in `_CPU_TEMP_LABEL_PREFERENCE` is present — the FIRST temperature reading in the
    section wins, rather than showing nothing."""
    import tts_utils as tu

    buf = _build_hwinfo_shm([
        (tu._HWINFO_SENSOR_TYPE_TEMP, "VRM", "VRM", 45.0),
        (tu._HWINFO_SENSOR_TYPE_TEMP, "Chipset", "Chipset", 50.0),
    ])
    assert tu._win_parse_hwinfo_shm(_hwinfo_addr(buf)) == (45, "VRM")


def test_hwinfo_shm_dead_or_unrecognized_signature_is_treated_as_absent(monkeypatch):
    """A DEAD signature (torn down / free-edition 12-hour expiry) and any OTHER unrecognized
    value both degrade to None, never a crash or a stale reading."""
    import tts_utils as tu

    readings = [(tu._HWINFO_SENSOR_TYPE_TEMP, "CPU Package", "CPU Package", 60.0)]
    dead = _build_hwinfo_shm(readings, signature=tu._HWINFO_SIGNATURE_DEAD)
    assert tu._win_parse_hwinfo_shm(_hwinfo_addr(dead)) is None

    garbage = _build_hwinfo_shm(readings, signature=0x12345678)
    assert tu._win_parse_hwinfo_shm(_hwinfo_addr(garbage)) is None


def test_hwinfo_shm_strides_by_the_headers_own_element_size(monkeypatch):
    """🔴 THE STRIDING TEST. `dwSizeOfReadingElement` in this buffer is 40 bytes LARGER than
    `_HwInfoReadingElement`'s own size, and every element is followed by 40 bytes of 0xEE
    padding — never 0x00, so a bug that reads padding AS data cannot coincidentally still land
    on the right answer. If the code advanced by `ctypes.sizeof(_HwInfoReadingElement)` instead
    of the header's own `dwSizeOfReadingElement` (the bug this guards against), element 1 would
    be read starting inside element 0's padding: its `tReading` field would decode from 0xEE
    bytes (not `_HWINFO_SENSOR_TYPE_TEMP`), so it would be silently skipped and the fallback
    "VRM" reading — present specifically so this test can tell the two implementations apart —
    would be returned instead of the true, preferred "CPU (Tctl/Tdie)" reading.

    Mutation-checked by hand: forcing the stride to `ctypes.sizeof(_HwInfoReadingElement)`
    instead of `header.dwSizeOfReadingElement` turns this test red, returning `(45, "VRM")`."""
    import tts_utils as tu

    buf = _build_hwinfo_shm([
        (tu._HWINFO_SENSOR_TYPE_TEMP, "VRM", "VRM", 45.0),
        (tu._HWINFO_SENSOR_TYPE_TEMP, "CPU (Tctl/Tdie)", "CPU (Tctl/Tdie)", 61.8),
    ], extra_stride=40)
    assert tu._win_parse_hwinfo_shm(_hwinfo_addr(buf)) == (62, "CPU (Tctl/Tdie)")


def test_win_read_hwinfo_temp_returns_none_when_the_view_is_absent_and_raises_through_failures(monkeypatch):
    """`_win_read_hwinfo_temp` is the thin combinator: no view -> None; a view -> parsed;
    `_win_open_hwinfo_view` raising propagates UNCAUGHT (this file's raw-getter contract — the
    caller, `_win_cpu_temp_source`, is what catches and degrades, not this function)."""
    import tts_utils as tu

    monkeypatch.setattr(tu, "_win_open_hwinfo_view", lambda: None)
    assert tu._win_read_hwinfo_temp() is None

    buf = _build_hwinfo_shm([(tu._HWINFO_SENSOR_TYPE_TEMP, "CPU Package", "CPU Package", 60.0)])
    cleaned_up = []
    monkeypatch.setattr(tu, "_win_open_hwinfo_view",
                         lambda: (_hwinfo_addr(buf), lambda: cleaned_up.append(True)))
    assert tu._win_read_hwinfo_temp() == (60, "CPU Package")
    assert cleaned_up == [True]                             # the cleanup callable was invoked

    def _boom():
        raise OSError("MapViewOfFile failed (fake)")
    monkeypatch.setattr(tu, "_win_open_hwinfo_view", _boom)
    with pytest.raises(OSError):
        tu._win_read_hwinfo_temp()


def test_hwinfo_view_cleanup_uses_pointer_abi_for_64_bit_view_and_closes_handle(monkeypatch):
    import tts_utils as tu

    view = 0x123456789ABCDEF0
    handle = 0x23456789ABCDEF01
    calls = []

    class Win32Call:
        def __init__(self, name, result=None):
            self.name = name
            self.result = result
            self.argtypes = None
            self.restype = None

        def __call__(self, *args):
            calls.append((self.name, args))
            if self.name == "UnmapViewOfFile":
                assert self.argtypes == [ctypes.c_void_p]
                assert args == (view,), "the full 64-bit mapping address must reach Win32"
            return self.result

    class Kernel:
        OpenFileMappingW = Win32Call("OpenFileMappingW", handle)
        MapViewOfFile = Win32Call("MapViewOfFile", view)
        UnmapViewOfFile = Win32Call("UnmapViewOfFile", 1)
        CloseHandle = Win32Call("CloseHandle", 1)

    monkeypatch.setattr(ctypes, "windll", types.SimpleNamespace(kernel32=Kernel()), raising=False)
    opened_view, cleanup = tu._win_open_hwinfo_view()
    assert opened_view == view
    cleanup()
    assert [name for name, _args in calls] == ["OpenFileMappingW", "MapViewOfFile",
                                              "UnmapViewOfFile", "CloseHandle"]
    assert Kernel.CloseHandle.argtypes == [ctypes.c_void_p]


def test_hwinfo_view_cleanup_closes_handle_when_unmap_raises(monkeypatch):
    import tts_utils as tu

    closed = []

    class Win32Call:
        def __init__(self, name, result=None):
            self.name = name
            self.result = result
            self.argtypes = None
            self.restype = None

        def __call__(self, *_args):
            if self.name == "UnmapViewOfFile":
                raise OSError("injected unmap failure")
            if self.name == "CloseHandle":
                closed.append(True)
            return self.result

    class Kernel:
        OpenFileMappingW = Win32Call("OpenFileMappingW", 0x123456789ABCDEF0)
        MapViewOfFile = Win32Call("MapViewOfFile", 0x23456789ABCDEF01)
        UnmapViewOfFile = Win32Call("UnmapViewOfFile", 1)
        CloseHandle = Win32Call("CloseHandle", 1)

    monkeypatch.setattr(ctypes, "windll", types.SimpleNamespace(kernel32=Kernel()), raising=False)
    _view, cleanup = tu._win_open_hwinfo_view()
    with pytest.raises(OSError, match="injected unmap failure"):
        cleanup()
    assert closed == [True]


# ---- LibreHardwareMonitor -------------------------------------------------------------------

def _lhm_temp_leaf(node_id, text, value_c, sensor_path="/amdcpu/0/temperature/0"):
    return {"id": node_id, "Text": text, "Min": "", "Value": f"{value_c:.1f} °C", "Max": "",
            "SensorId": sensor_path, "Type": "Temperature",
            "ImageURL": "images/transparent.png", "Children": []}


def _lhm_load_leaf(node_id, text, value_pct):
    """A non-temperature leaf (Type == "Load") with a `%`-suffixed Value — present in the AMD/
    Intel fixtures specifically to prove the `Type` filter (not a bare '°' scan) is what's
    driving selection on a current-format tree."""
    return {"id": node_id, "Text": text, "Min": "", "Value": f"{value_pct:.1f} %", "Max": "",
            "SensorId": "/amdcpu/0/load/0", "Type": "Load",
            "ImageURL": "images/transparent.png", "Children": []}


def _lhm_cpu_hw_node(node_id, name, hardware_id, temp_leaves, load_leaves=()):
    return {"id": node_id, "Text": name, "Min": "", "Value": "", "Max": "",
            "HardwareId": hardware_id, "ImageURL": "images_icon/cpu.png",
            "Children": [
                {"id": node_id + 1, "Text": "Temperatures", "Min": "", "Value": "", "Max": "",
                 "ImageURL": "images_icon/temperature.png", "Children": list(temp_leaves)},
                {"id": node_id + 2, "Text": "Load", "Min": "", "Value": "", "Max": "",
                 "ImageURL": "images_icon/load.png", "Children": list(load_leaves)},
            ]}


def _lhm_tree(*hardware_nodes):
    """The synthetic wrapper `SendJsonAsync` puts around the real tree — `Text: "Sensor"`,
    `Value: "Value"` (a literal placeholder, not a reading) — with a Computer node and the given
    hardware nodes underneath, matching `HttpServer.cs`'s real shape."""
    return {"id": 0, "Text": "Sensor", "Min": "Min", "Value": "Value", "Max": "Max",
            "ImageURL": "", "Children": [
                {"id": 1, "Text": "DESKTOP-TEST", "Min": "", "Value": "", "Max": "",
                 "ImageURL": "images_icon/computer.png", "Children": list(hardware_nodes)},
            ]}


def test_lhm_json_picks_amd_tctl_tdie_under_the_cpu_hardware_node(monkeypatch):
    """AMD shape: `HardwareId` starts `/amdcpu`, the preferred label is `Core (Tctl/Tdie)`. A
    decoy `CCD1 (Tdie)` reading (present on every real Ryzen tree) and a `Load` sibling with a
    `%`-suffixed value must both be ignored in favor of it."""
    import tts_utils as tu

    tree = _lhm_tree(_lhm_cpu_hw_node(
        2, "AMD Ryzen 9 9950X", "/amdcpu/0",
        temp_leaves=[_lhm_temp_leaf(5, "CCD1 (Tdie)", 41.2), _lhm_temp_leaf(6, "Core (Tctl/Tdie)", 61.8)],
        load_leaves=[_lhm_load_leaf(8, "CPU Total", 12.4)],
    ))
    assert tu._win_pick_lhm_cpu_temp(tree) == (62, "Core (Tctl/Tdie)")


def test_lhm_json_picks_intel_cpu_package(monkeypatch):
    """Intel shape: `HardwareId` starts `/intelcpu`, no Tctl/Tdie exists at all — "CPU Package"
    is the preferred (and, on this fixture, only) match."""
    import tts_utils as tu

    tree = _lhm_tree(_lhm_cpu_hw_node(
        2, "Intel Core i9-14900K", "/intelcpu/0",
        temp_leaves=[_lhm_temp_leaf(5, "CPU Package", 54.3), _lhm_temp_leaf(6, "Core Max", 58.0)],
    ))
    assert tu._win_pick_lhm_cpu_temp(tree) == (54, "CPU Package")


def test_lhm_json_ignores_a_gpu_hardware_node_and_falls_back_within_the_cpu_one(monkeypatch):
    """Two hardware nodes — a GPU (higher, hotter reading, and NOT a CPU) and a CPU with no
    preferred label present. The GPU's reading must never be considered even as a fallback; the
    CPU's own first temperature reading is what's returned."""
    import tts_utils as tu

    gpu_node = {"id": 2, "Text": "NVIDIA GeForce RTX 4090", "Min": "", "Value": "", "Max": "",
                "HardwareId": "/gpu-nvidia/0", "ImageURL": "images_icon/gpu.png",
                "Children": [_lhm_temp_leaf(3, "GPU Core", 71.0)]}
    cpu_node = _lhm_cpu_hw_node(4, "AMD Ryzen 9 9950X", "/amdcpu/0",
                                 temp_leaves=[_lhm_temp_leaf(7, "CCD1 (Tdie)", 41.2)])
    tree = _lhm_tree(gpu_node, cpu_node)
    assert tu._win_pick_lhm_cpu_temp(tree) == (41, "CCD1 (Tdie)")


def test_lhm_json_pre_hardware_id_build_falls_back_to_a_whole_tree_scan(monkeypatch):
    """A build old enough to predate `HardwareId`/`Type` (neither key appears anywhere in the
    tree) falls back to scanning every node whose `Value` string carries a `°C` reading, with no
    hardware-node restriction — the degraded case the brief calls out explicitly."""
    import tts_utils as tu

    tree = {"Text": "Sensor", "Value": "Value", "Children": [
        {"Text": "Motherboard", "Value": "", "Children": [
            {"Text": "VRM", "Value": "48.5 °C", "Children": []},
        ]},
        {"Text": "AMD Ryzen 9 9950X", "Value": "", "Children": [
            {"Text": "CPU (Tctl/Tdie)", "Value": "61.8 °C", "Children": []},
        ]},
    ]}
    # The preferred label still wins even though it is not the first temperature encountered.
    assert tu._win_pick_lhm_cpu_temp(tree) == (62, "CPU (Tctl/Tdie)")


def test_parse_lhm_celsius_reads_only_celsius_strings():
    """The unit-parsing seam on its own: a real Celsius reading, a Fahrenheit-configured LHM's
    reading (deliberately NOT converted — see `_LHM_CELSIUS_RE`'s own comment), the root's
    literal `"Value"` placeholder, and a blank container node's `""`."""
    import tts_utils as tu

    assert tu._parse_lhm_celsius("62.4 °C") == 62.4
    assert tu._parse_lhm_celsius("-3.0 °C") == -3.0
    assert tu._parse_lhm_celsius("144.3 °F") is None
    assert tu._parse_lhm_celsius("Value") is None
    assert tu._parse_lhm_celsius("") is None
    assert tu._parse_lhm_celsius(None) is None


def test_win_fetch_lhm_json_builds_the_loopback_url_from_the_resolved_port(monkeypatch):
    """`_win_fetch_lhm_json` is the one thing in this whole path that touches the network — this
    proves the URL it builds and that it decodes whatever `urlopen` hands back, via an INJECTED
    `urlopen` (module-level `urllib.request.urlopen`), never a real socket."""
    import tts_utils as tu

    seen = {}

    class _FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return json.dumps({"Text": "Sensor"}).encode("utf-8")

    def _fake_urlopen(url, timeout=None):
        seen["url"] = url
        seen["timeout"] = timeout
        return _FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)
    result = tu._win_fetch_lhm_json(port=9191)
    assert seen["url"] == "http://127.0.0.1:9191/data.json"
    assert seen["timeout"] == tu._LHM_FETCH_TIMEOUT_S
    assert result == {"Text": "Sensor"}


def test_win_lhm_port_env_beats_app_settings_beats_default(monkeypatch):
    """env `VOCALIS_LHM_PORT` -> `app_settings.yaml`'s `sensors: lhm_port:` -> 8085, the same
    precedence order `acestep.configured()` uses for its own port."""
    import tts_utils as tu

    monkeypatch.delenv("VOCALIS_LHM_PORT", raising=False)
    monkeypatch.setattr(rt_settings, "load_app_settings", lambda: {})
    assert tu._win_lhm_port() == 8085

    monkeypatch.setattr(rt_settings, "load_app_settings", lambda: {"sensors": {"lhm_port": 9000}})
    assert tu._win_lhm_port() == 9000

    monkeypatch.setenv("VOCALIS_LHM_PORT", "9100")
    assert tu._win_lhm_port() == 9100                        # env wins over app_settings

    monkeypatch.setenv("VOCALIS_LHM_PORT", "not-a-port")
    assert tu._win_lhm_port() == 9000                         # bad env falls through to app_settings


# ---- `_win_cpu_temp_source`: never blocks its caller, only triggers a background refresh ----
# The caller holds `_WIN_TEMP_LOCK`, and `cpu_stats()` runs under `runtime/gpu.py`'s `_STRIP_LOCK`, shared by
# `GET /system/stats`, the `/system/stream` SSE generator and jobs.py's per-job `emit` — so on a
# host without a temperature service could block all three paths behind a network timeout. Each
# test below drives `_win_cpu_temp_source` with `runner=_win_inline_runner` (or a purpose-built
# stand-in) so the refresh happens synchronously and deterministically for the test's own
# assertions — but the function's contract, proven by
# `test_win_cpu_temp_source_never_probes_on_the_calling_thread` below, is that it always returns
# the PRE-refresh cached value and only ever *triggers* work, regardless of which runner picks it
# up. The real runner (`_WIN_TEMP_RUNNER`, a daemon thread) is exercised in the Windows-gated test
# above.

def test_win_cpu_temp_source_never_probes_on_the_calling_thread(monkeypatch):
    """🔴 THE DEFECT-FIX TEST. Even with an inline runner that completes the refresh
    SYNCHRONOUSLY before `run(...)` returns, the call that TRIGGERED it still hands back the
    value that was cached BEFORE — never the fresh one — because `_win_cpu_temp_source` snapshots
    `state["temp_c"]`/`state["source"]` under the lock BEFORE releasing it and launching the
    refresh. Proven here with a probe that's slow to mutate a marker, to make unmistakable that
    the first call's return value could not possibly have waited on it."""
    import tts_utils as tu

    _win_reset_temp_state()
    probed = []
    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", lambda: (probed.append(1), (58, "CPU Package"))[1])
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: None)

    first = tu._win_cpu_temp_source(now=0.0, runner=_win_inline_runner)
    assert first == (None, None)                    # the value cached BEFORE this call's refresh
    assert probed == [1]                             # the refresh DID run (inline runner) …
    second = tu._win_cpu_temp_source(now=0.0, runner=_win_inline_runner)
    assert second == (58, "hwinfo")                  # …and THIS call is what sees it land
    assert probed == [1]                              # not due again yet — no second probe


def test_win_cpu_temp_source_prefers_hwinfo_and_never_calls_lhm_when_it_answers(monkeypatch):
    """HWiNFO first: when it answers, LHM must not even be TRIED — the whole point of trying the
    cheap local source before the network one."""
    import tts_utils as tu

    _win_reset_temp_state()
    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", lambda: (58, "CPU Package"))
    lhm_calls = []
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: lhm_calls.append(1))

    assert _win_resolve_temp(tu, now=0.0) == (58, "hwinfo")
    assert lhm_calls == []


def test_win_cpu_temp_source_falls_back_to_lhm_when_hwinfo_finds_nothing(monkeypatch):
    import tts_utils as tu

    _win_reset_temp_state()
    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", lambda: None)
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: (55, "CPU (Tctl/Tdie)"))

    assert _win_resolve_temp(tu, now=0.0) == (55, "lhm")


def test_win_cpu_temp_source_returns_the_cache_without_probing_when_fresh(monkeypatch):
    """A cache written less than `_WIN_TEMP_CACHE_S` ago must be served WITHOUT touching either
    probe at all — the whole reason this function exists is to make `cpu_stats()` cheap, and a
    call that still probes on a "fresh" sample would defeat that."""
    import tts_utils as tu

    _win_reset_temp_state()
    tu._WIN_TEMP_STATE.update(temp_c=59, source="hwinfo", resolved_at=10.0, probed_at=10.0,
                               refreshing=False)
    calls = []
    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", lambda: calls.append(1))
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: calls.append(1))

    assert tu._win_cpu_temp_source(now=10.5, runner=_win_inline_runner) == (59, "hwinfo")
    assert calls == []                                # neither probe was ever called


def test_win_cpu_temp_source_caches_for_one_second_then_rereads(monkeypatch):
    """Within `_WIN_TEMP_CACHE_S` of a successful read, the cached value is returned WITHOUT
    calling either source again; past it, the sources are consulted again — proven with an
    injected `now`, no real sleep."""
    import tts_utils as tu

    _win_reset_temp_state()
    calls = []

    def _hwinfo():
        calls.append(1)
        return (60 + len(calls), "CPU Package")            # a different value each real call
    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", _hwinfo)
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: None)

    assert _win_resolve_temp(tu, now=0.0) == (61, "hwinfo")
    assert len(calls) == 1
    assert tu._win_cpu_temp_source(now=0.5, runner=_win_inline_runner) == (61, "hwinfo")   # inside the 1s cache
    assert len(calls) == 1
    assert _win_resolve_temp(tu, now=1.5) == (62, "hwinfo")   # past it: read again, new value
    assert len(calls) == 2


def test_win_cpu_temp_source_reprobes_an_absent_source_only_every_15s(monkeypatch):
    """A box with neither app installed must not pay a failed HWiNFO open AND a failed LHM fetch
    on every single sample — only once per `_WIN_TEMP_REPROBE_S`."""
    import tts_utils as tu

    _win_reset_temp_state()
    calls = []
    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", lambda: (calls.append(1), None)[1])
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: None)

    assert _win_resolve_temp(tu, now=0.0) == (None, None)
    assert len(calls) == 1
    assert tu._win_cpu_temp_source(now=5.0, runner=_win_inline_runner) == (None, None)   # inside the 15s window
    assert len(calls) == 1
    assert _win_resolve_temp(tu, now=16.0) == (None, None)    # past it: probed again
    assert len(calls) == 2


def test_win_cpu_temp_source_does_not_start_a_second_refresh_while_one_is_in_flight(monkeypatch):
    """🔴 THE IN-FLIGHT GUARD. A refresh already marked outstanding (`refreshing=True`) must
    suppress a SECOND one even though the cache says one is due — proven with a `runner` that
    fails the test outright if it's ever called, since the whole point is that it must not be."""
    import tts_utils as tu

    _win_reset_temp_state()
    tu._WIN_TEMP_STATE.update(temp_c=None, source=None, resolved_at=None, probed_at=None,
                               refreshing=True)                 # a refresh is (simulated) in flight

    def _must_not_run(fn):
        pytest.fail("a second refresh was started while one was already in flight")
    result = tu._win_cpu_temp_source(now=0.0, runner=_must_not_run)
    assert result == (None, None)                               # still just the (empty) cache
    assert tu._WIN_TEMP_STATE["refreshing"] is True               # untouched — still the same one


def test_win_cpu_temp_source_stale_floor_turns_an_old_reading_into_none(monkeypatch):
    """🔴 THE STALENESS FLOOR. A reading that hasn't been refreshed in over
    `_WIN_TEMP_STALE_FLOOR_S` must be reported as `(None, None)` — never the frozen last-good
    number — even though the raw cache still HOLDS that number (proven by reading
    `_WIN_TEMP_STATE` directly). The refresh THIS staleness would also trigger is neutered with a
    `runner` that never executes its function, so the pre-existing stale state is what's being
    read, not a freshly completed one."""
    import tts_utils as tu

    _win_reset_temp_state()
    tu._WIN_TEMP_STATE.update(temp_c=59, source="hwinfo", resolved_at=0.0, probed_at=0.0,
                               refreshing=False)

    def _never_runs(fn):
        pass                                                     # simulates a refresh still in flight
    # Just under the floor: still trusted.
    assert tu._win_cpu_temp_source(now=9.9, runner=_never_runs) == (59, "hwinfo")
    tu._WIN_TEMP_STATE.update(refreshing=False)                   # the "triggered" refresh above never ran
    # Past the floor: no longer trusted, even though the cache still holds the old number.
    assert tu._win_cpu_temp_source(now=10.1, runner=_never_runs) == (None, None)
    assert tu._WIN_TEMP_STATE["temp_c"] == 59 and tu._WIN_TEMP_STATE["source"] == "hwinfo"


def test_win_cpu_temp_source_degrades_to_none_and_logs_the_failure_exactly_once(monkeypatch):
    """A source that RAISES (rather than cleanly answering None) must still degrade the row to
    None — never propagate out of `cpu_stats()` — and the failure is logged once per distinct
    cause, not once per sample, the same rule every other `_win_*` source in this file follows."""
    import tts_utils as tu

    _win_reset_temp_state()

    def _boom():
        raise OSError("MapViewOfFile failed (fake)")
    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", _boom)
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: None)

    warnings = []
    monkeypatch.setattr(tu.logger, "warning", lambda msg: warnings.append(msg))

    assert _win_resolve_temp(tu, now=0.0) == (None, None)
    assert len(warnings) == 1 and "MapViewOfFile failed (fake)" in warnings[0]
    # Re-probed (past the 15s window) but the SAME distinct failure — no second warning.
    assert _win_resolve_temp(tu, now=16.0) == (None, None)
    assert len(warnings) == 1


def test_win_cpu_temp_source_an_unexpected_exception_in_the_worker_never_escapes(monkeypatch):
    """The `except (OSError, AttributeError, ValueError)` around each source is deliberately
    narrow — this proves the OUTER blanket catch in `_win_do_temp_refresh` is what stands between
    a genuinely unexpected exception type and a permanently wedged `refreshing` flag (which would
    silently blank the CPU temperature forever, since `_win_cpu_temp_source` would then never
    trigger another refresh — `due and not state["refreshing"]` stays false forever)."""
    import tts_utils as tu

    _win_reset_temp_state()

    def _weird_boom():
        raise RuntimeError("not one of the caught types (fake)")
    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", _weird_boom)
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: None)
    warnings = []
    monkeypatch.setattr(tu.logger, "warning", lambda msg: warnings.append(msg))

    # Must not raise OUT of this call, and must clear `refreshing` so the NEXT due sample can
    # still try again — both are the point of the outer catch-and-clear-in-`finally` pairing.
    result = tu._win_cpu_temp_source(now=0.0, runner=_win_inline_runner)
    assert result == (None, None)
    assert tu._WIN_TEMP_STATE["refreshing"] is False
    assert len(warnings) == 1 and "unexpectedly" in warnings[0]


def test_win_cpu_temp_source_logs_once_on_found_and_once_on_lost(monkeypatch):
    """The OTHER half of the logging contract: `logger.info` fires exactly once when a source
    starts answering and exactly once when it stops — never once per sample either way."""
    import tts_utils as tu

    _win_reset_temp_state()
    infos = []
    monkeypatch.setattr(tu.logger, "info", lambda msg: infos.append(msg))

    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", lambda: (60, "CPU Package"))
    monkeypatch.setattr(tu, "_win_read_lhm_temp", lambda: None)
    _win_resolve_temp(tu, now=0.0)
    tu._win_cpu_temp_source(now=0.5, runner=_win_inline_runner)     # still cached: no second log
    assert len(infos) == 1 and "found" in infos[0] and "hwinfo" in infos[0]

    monkeypatch.setattr(tu, "_win_read_hwinfo_temp", lambda: None)
    _win_resolve_temp(tu, now=1.5)                          # past the cache: re-reads, now absent
    assert len(infos) == 2 and "lost" in infos[1]


def test_win_spawn_temp_refresh_starts_a_named_daemon_thread(monkeypatch):
    """The REAL runner, for real — the one piece of this machinery that has to touch an actual
    `threading.Thread` to mean anything. Named so it's identifiable in a thread dump; daemon so
    it can never block process exit."""
    import tts_utils as tu

    started = {}
    real_thread = threading.Thread

    class _Recording(real_thread):
        def start(self):
            started["name"] = self.name
            started["daemon"] = self.daemon
            super().start()

    monkeypatch.setattr(tu.threading, "Thread", _Recording)
    done = threading.Event()
    tu._win_spawn_temp_refresh(done.set)
    assert done.wait(timeout=5), "the spawned thread never ran the function it was given"
    assert started["name"] == "vocalis-cputemp"
    assert started["daemon"] is True


def test_win_cpu_stats_threads_temp_c_and_temp_src_from_the_resolved_source(monkeypatch):
    """The join between `_win_cpu_temp_source` and the assembled row: `cpu_stats()` on Windows
    carries whatever it returned, under the right keys, with `temp_hint` only when there's no
    source. `_win_cpu_temp_source` itself is monkeypatched directly here — this test's job is the
    JOIN, not the cache/refresh mechanics those get their own tests for above."""
    import tts_utils as tu

    monkeypatch.setattr(tu.os, "name", "nt")
    monkeypatch.setattr(tu, "_win_get_system_times", lambda: (1, 2, 0))
    monkeypatch.setattr(tu, "_win_get_processor_max_mhz_list", lambda: [4000])
    monkeypatch.setattr(tu, "_win_get_processor_performance_pct", lambda: 100.0)
    monkeypatch.setattr(tu, "_win_get_memory_status", lambda: (2 * 1073741824, 1073741824))
    monkeypatch.setattr(tu, "_win_get_tick_count_ms", lambda: 1000)
    monkeypatch.setattr(tu, "_win_cpu_temp_source", lambda: (61, "hwinfo"))

    s = tu.cpu_stats()
    assert s["temp_c"] == 61 and s["temp_src"] == "hwinfo"
    assert "temp_hint" not in s                                # a source was found — no hint needed


def test_cpu_stats_on_linux_always_sends_temp_src_as_none(monkeypatch):
    """Decision recorded here per the brief: Linux's payload gets the SAME `temp_src` key as
    Windows (always present), just always `None` — so hwstrip.js never needs a platform check to
    know whether the key exists, only what it says."""
    import tts_utils as tu

    monkeypatch.setattr(tu.os, "name", "posix")
    monkeypatch.setattr(tu, "_cpu_percent", lambda: None)
    s = tu.cpu_stats()
    assert "temp_src" in s and s["temp_src"] is None
    assert "temp_hint" not in s                                 # Windows-only key, never sent here


def test_cpu_paths_are_resolved_once_but_values_are_reread(monkeypatch, tmp_path):
    """The strip samples 4x/s, so re-walking 32 cpufreq directories on every sample to
    learn what we already know is the single most expensive thing in it. Cache the PATHS
    (they can't change without a reboot) — never the VALUES, which are the whole point."""
    import tts_utils as tu

    import glob as _g

    tu._CPU_PATHS.clear()
    cur = tmp_path / "scaling_cur_freq"
    cur.write_text("3000000\n")                         # kHz

    globs = []

    def _glob(pat):
        globs.append(pat)
        return [str(cur)] if "cpufreq" in pat else []
    monkeypatch.setattr(_g, "glob", _glob)              # _cpu_mhz imports glob at call time

    assert tu._cpu_mhz() == 3000
    cur.write_text("800000\n")                          # the core clocked down…
    assert tu._cpu_mhz() == 800                         # …and we SEE it: values are re-read
    assert len([p for p in globs if "cpufreq" in p]) == 1   # but the directory walk happened once


def test_rapl_is_never_path_cached_so_the_udev_rule_takes_effect_live(monkeypatch, tmp_path):
    """RAPL's energy_uj is root-only until the operator applies a udev rule. That rule is
    applied to a RUNNING box — so the moment it lands, watts must appear on the next
    sample. Caching "no readable domain" would mean Vocalis never noticed until a restart,
    which is exactly the trap the clock/temperature path caches would set if copied here."""
    import glob as _g
    import tts_utils as tu

    d = tmp_path / "intel-rapl-0"      # the real one is "intel-rapl:0"; Windows forbids the
    d.mkdir()                          # colon, and the glob is faked, so the name is moot
    energy = d / "energy_uj"
    monkeypatch.setattr(_g, "glob", lambda pat: [str(d)] if "powercap" in pat else [])

    tu._CPU_PREV.clear()
    real_open = open
    denied = {"on": True}

    def _open(path, *a, **k):
        if str(path) == str(energy) and denied["on"]:
            raise PermissionError(13, "Permission denied")
        return real_open(path, *a, **k)
    monkeypatch.setattr("builtins.open", _open)

    energy.write_text("1000000\n")
    assert tu._cpu_power_w() is None                     # locked down: no reading, no crash

    denied["on"] = False                                 # <- the operator's udev rule lands
    now = [100.0]
    monkeypatch.setattr(tu.time, "monotonic", lambda: now[0])
    assert tu._cpu_power_w() is None                     # first readable sample: no delta yet

    energy.write_text("3000000\n")                       # +2 J…
    now[0] = 100.5                                       # …over half a second
    assert tu._cpu_power_w() == 4                        # …is 4 W, and it shows up. No restart.


def test_strip_sample_is_shared_between_readers(monkeypatch, client):
    """The CPU's load and power are DELTAS between reads. The strip has several readers —
    a browser tab per screen, plus one SSE ticker per running job — and if each took its
    own read they'd carve one interval into slivers and the load would come back as noise.
    So they share a sample."""
    reads = []
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: (reads.append(1), [])[1])
    monkeypatch.setattr("tts_utils.cpu_stats",
                        lambda: {"pct": 42, "cores": 32, "mhz": 3900, "power_w": None, "temp_c": 61})

    gpu_mod._STRIP.update(t=0.0, v=None)                      # cold
    now = [1000.0]
    monkeypatch.setattr(vs.time, "monotonic", lambda: now[0])

    a = client.get("/system/stats").get_json()
    assert a["cpu"]["pct"] == 42 and "gpus" in a
    now[0] += gpu_mod._STRIP_TTL / 2                          # a second reader, same beat
    client.get("/system/stats")
    assert len(reads) == 1                               # ONE read of the hardware, not two

    now[0] += gpu_mod._STRIP_TTL                              # the beat passes → fresh sample
    client.get("/system/stats")
    assert len(reads) == 2


def test_vram_tick_carries_the_cpu_line_too(monkeypatch):
    """The UI stops its idle poll while a job runs and lives off this event instead. If it
    only carried `gpus`, the CPU line would sit frozen for the whole render — which is the
    exact stretch worth watching."""
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [{"index": 0}])
    monkeypatch.setattr("tts_utils.cpu_stats", lambda: {"pct": 1600, "cores": 32})
    gpu_mod._STRIP.update(t=0.0, v=None)

    job = jobs_mod.Job(id="j1", docx="b.docx", voice="v.wav", params=None, gpus="all", workers=1)
    q = queue.Queue()
    job.subscribers.append(q)
    stop = threading.Event()
    t = threading.Thread(target=jobs_mod.vram_ticker, args=(job, stop), daemon=True)
    t.start()
    try:
        ev = q.get(timeout=2)
    finally:
        stop.set()
        t.join(timeout=2)

    assert ev["type"] == "vram"
    assert ev["gpus"] == [{"index": 0}]
    assert ev["cpu"]["pct"] == 1600


# ── 7.3.6: whole-box power, sampled continuously ─────────────────────────────
# The header's third system line. What separates it from every other figure in the strip is
# WHERE the series lives: this one is taken by the server on its own timer, so its averages and
# its peak cover the hours when no browser is open — which on a render box is most of them.

@pytest.fixture
def power_mod():
    """The sampler with an empty series, and stopped again afterward.

    Every piece of its state is process-global (it IS a series), so a test that left history
    behind would hand the next one an average over samples it never took."""
    from vocalis.runtime import power

    def _reset():
        power.stop()
        power._HIST.clear()
        power._PARTS.clear()
        power._PEAK.update(w=None, t=None, cpu_w=None, gpu_w=None)
        power._STARTED["t"] = None
        power._RAPL.clear()
        power._HWMONS.clear()
        power._HWMON_SCAN[0] = 0.0
        power._CAPS.clear()
        power._STALLS[0] = 0
        power._BOGUS[0] = 0
    _reset()
    yield power
    _reset()


def _fake_sensors(monkeypatch, tmp_path, cards, energy_uj=None):
    """A box's power sensors as real files: one hwmon dir per entry in `cards` (a dict of
    {filename: microwatts}, so `power1_cap_max` goes in the same way `power1_average` does),
    plus a RAPL domain when `energy_uj` is given. Returns a setter for the energy counter, since
    watts are the delta between two reads of it.

    `energy_uj` may be a SEQUENCE, and then there is one domain per entry — which is what a real
    box looks like: remote host's glob matches `intel-rapl:0` (package) and `intel-rapl:0:0` (core), two
    unrelated running totals. The setter then takes an index."""
    import glob as _g

    hwmons = []
    for i, files in enumerate(cards):
        d = tmp_path / f"hwmon{i}"
        d.mkdir()
        (d / "name").write_text("amdgpu\n")
        for n, uw in files.items():
            (d / n).write_text(f"{uw}\n")
        hwmons.append(str(d))

    # The real names are "intel-rapl:0" and "intel-rapl:0:0"; Windows forbids the colon, and the
    # glob is faked — but the SORT ORDER is load-bearing (the package domain must come first),
    # and "rapl-0" < "rapl-0-0" the same way "…:0" < "…:0:0".
    ujs = [] if energy_uj is None else (
        list(energy_uj) if isinstance(energy_uj, (list, tuple)) else [energy_uj])
    rapls = []
    for i, uj in enumerate(ujs):
        d = tmp_path / ("rapl-0" + "-0" * i)
        d.mkdir()
        (d / "energy_uj").write_text(f"{uj}\n")
        rapls.append(d)

    def _glob(pat):
        if "hwmon" in pat:
            return hwmons
        if "powercap" in pat:
            return [str(d) for d in rapls]
        return []
    monkeypatch.setattr(_g, "glob", _glob)

    def _set(uj, i=0):
        (rapls[i] / "energy_uj").write_text(f"{uj}\n")
    return _set


def test_power_is_the_cpu_package_plus_every_gpu(monkeypatch, tmp_path, power_mod):
    """Total system power includes the CPU package and every GPU. Both halves come off sysfs,
    and the second card here reports `power1_input` rather
    than `power1_average` — remote host's iGPU is exactly that shape, and a sum that only understood one
    of the two names would silently drop a device from a whole-box total."""
    import tts_utils as tu

    set_uj = _fake_sensors(monkeypatch, tmp_path,
                           [{"power1_average": 300_000_000},      # a card at 300 W
                            {"power1_input": 24_000}],            # the iGPU, 0.024 W
                           energy_uj=1_000_000)
    now = [100.0]
    monkeypatch.setattr(tu.time, "monotonic", lambda: now[0])

    assert power_mod.sample_once() is None, "the priming RAPL read has no delta and no watts yet"
    assert not power_mod._HIST, (
        "the priming sample was RECORDED, and it is missing the CPU's share entirely — one "
        "short total is enough to set a wrong peak or drag an average")

    set_uj(1_000_000 + 60_000_000)                # +60 J…
    now[0] = 101.0                                # …over one second is 60 W of CPU
    assert round(power_mod.sample_once()) == 360  # 60 + 300 + 0.024

    s = power_mod.snapshot()
    assert (s["w"], s["cpu_w"], s["gpu_w"], s["gpus"]) == (360, 60, 300, 2)


def test_a_card_that_reports_nothing_is_skipped_not_counted_as_zero(monkeypatch, tmp_path,
                                                                    power_mod):
    """A silent sensor and a card drawing nothing are not the same claim. With NO readable
    sensor anywhere the whole line is absent — which is every Windows dev box, and is why the
    renderer keys the row off the block being present at all."""
    _fake_sensors(monkeypatch, tmp_path, [{"name_only": 1}])      # a card with no power file
    assert power_mod._gpu_w() == (None, None)                     # nothing to report, nobody lied
    assert power_mod.sample_once() is None and power_mod.snapshot() is None


def test_power_averages_are_means_over_1_5_and_15_minutes(monkeypatch, tmp_path, power_mod):
    """The server samples power so rolling means and peaks remain available while the page is
    hidden or closed. This 20-minute series has one 900 W spike at its midpoint. The 1-minute
    mean cannot see the spike, the 15-minute mean has half-forgotten it, and the peak still has it.
    A page computing from its own polls would have nothing for the stretch it was hidden,
    closed or driving a render off the SSE stream, and would report the same three figures with
    holes in them and no way to tell."""
    watts = [100.0]
    now = [1000.0]
    monkeypatch.setattr(power_mod.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(power_mod, "_cpu_w", lambda: (None, None))
    monkeypatch.setattr(power_mod, "_gpu_w", lambda: (watts[0], None))

    for i in range(1200):                          # 20 minutes at 1 Hz
        watts[0] = 900.0 if i == 600 else 100.0    # one second of spike, ten minutes back
        power_mod.sample_once()
        now[0] += 1.0

    s = power_mod.snapshot()
    assert s["w"] == 100                           # the live figure is the last sample, flat
    assert s["avg"] == [100, 100, 101], (
        "the windows are wrong: 60 s and 300 s are past the spike entirely, and the 900 s mean "
        f"carries one 800 W excess spread over 900 samples (+0.89 W) — got {s['avg']}")
    assert s["peak_w"] == 900 and s["peak_ago_s"] == 600, (
        "the spike fell out of every average, and the peak is the only thing that still knows "
        "it happened")
    assert s["span_s"] == 901 and s["n"] == 901, (
        "history is trimmed to the widest window — 15 minutes of samples, not 20")


def test_power_says_how_much_of_the_15_minute_window_it_actually_covers(monkeypatch, power_mod):
    """The honest limit of this readout. Load average's series is the kernel's and starts at
    boot; this one starts when Vocalis does, so for the first quarter hour after a restart the
    widest figure is a mean over less than it is labeled. `span_s`/`since_s` are what let the
    tooltip say so instead of the number quietly pretending."""
    now = [500.0]
    monkeypatch.setattr(power_mod.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(power_mod, "_cpu_w", lambda: (None, None))
    monkeypatch.setattr(power_mod, "_gpu_w", lambda: (200.0, None))

    for _ in range(90):                            # a minute and a half of uptime
        power_mod.sample_once()
        now[0] += 1.0

    s = power_mod.snapshot()
    assert s["avg"] == [200, 200, 200]             # nothing to tell the three windows apart yet
    assert s["span_s"] == 90 and s["since_s"] == 90, (
        "the tooltip has no way to say the 15-minute figure covers 90 seconds so far")


def test_the_sampler_runs_with_nobody_watching(monkeypatch, power_mod):
    """*"The server should sample it continually, not just when the UI calls for it."* No
    request is made anywhere in this test and the series still grows."""
    monkeypatch.setattr(power_mod, "_linuxish", lambda: True)         # pretend to be Linux
    # The sampler thread is one loop: read the sensors, THEN record the sample. So the sixth
    # sensor read can only begin after five samples are in the series, and the stub marks it.
    reads = {"n": 0}
    five_taken = threading.Event()
    def counted_gpu():
        reads["n"] += 1
        if reads["n"] >= 6:
            five_taken.set()
        return 150.0, None
    monkeypatch.setattr(power_mod, "_cpu_w", lambda: (50.0, None))
    monkeypatch.setattr(power_mod, "_gpu_w", counted_gpu)

    sampler = power_mod.start(interval=0.02)
    assert sampler is not None
    assert power_mod.start(interval=0.02) is power_mod._THREAD[0], "start() must be idempotent"
    assert five_taken.wait(timeout=10), "the background sampler never got past five reads"
    power_mod.stop()
    assert len(power_mod._HIST) >= 5, "the background sampler took no samples of its own"
    assert power_mod.snapshot()["w"] == 200
    # stop() joined the thread, so once it is dead nothing can add a sample: no waiting needed.
    assert not sampler.is_alive(), "stop() left the sampler running"


@pytest.mark.timeout(30)
def test_a_stalled_sensor_read_is_never_repaid_as_a_burst(monkeypatch, power_mod):
    """A slow sensor read must not cause the sampler to replay missed ticks. At 1 Hz, a
    fake-sensor harness measured the header changing at a clean 1000 ms — because fake sensors
    return instantly. A real `power1_average` read goes to the card's SMU over a mailbox and can
    block for hundreds of milliseconds under load.

    The loop paced itself with a bare `nxt += interval`, so a schedule that fell behind fired one
    sample per MISSED tick with no wait between them: the classic fixed-schedule catch-up burst.
    The header flicker was the visible half. The worse half is silent — every sample in the burst
    carries the same instant into the 1/5/15-minute means, weighting a stalled moment by however
    many ticks were missed.

    So: one stall of six intervals, and the samples after it must still be spaced. A gap in the
    series is honest; invented samples are not.
    """
    # TIME IS THE SUBJECT HERE, so it is injected rather than slept through: the module's clock is
    # a fake that only moves when the test says so, and the loop's own `_STOP.wait(...)` is a fake
    # that advances that clock by exactly the wait the loop asked for. The real `_loop` runs
    # unchanged, in this thread, on a schedule that is the same on every machine.
    clock = [1000.0]
    monkeypatch.setattr(power_mod.time, "monotonic", lambda: clock[0])

    class _FakeStop:
        """Stands in for the loop's stop Event: waiting costs no real time, it moves the clock."""
        def __init__(self):
            self.stopped, self.waits = False, 0
        def is_set(self):
            return self.stopped
        def set(self):
            self.stopped = True
        def clear(self):
            self.stopped = False
        def wait(self, timeout=None):
            self.waits += 1
            clock[0] += timeout
            # 8 samples are enough to judge; the wait cap only keeps a broken loop from spinning.
            if len(power_mod._HIST) >= 8 or self.waits >= 200:
                self.stopped = True
            return self.stopped
    stop = _FakeStop()
    monkeypatch.setattr(power_mod, "_STOP", stop)

    stalled = {"done": False}

    def slow_gpu():
        if not stalled["done"]:                 # the first read blocks, like a busy SMU
            stalled["done"] = True
            clock[0] += 0.6                     # 0.6 s stall = six missed ticks
        return 600.0, None
    monkeypatch.setattr(power_mod, "_cpu_w", lambda: (None, None))
    monkeypatch.setattr(power_mod, "_gpu_w", slow_gpu)

    power_mod._loop(0.1)                        # returns when the fake stop is set

    ts = [t for t, _ in power_mod._HIST]
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    assert len(gaps) >= 6, f"the sampler did not take enough samples to judge: {gaps}"
    # 40 ms against a 100 ms interval: generous enough for a loaded CI box, nowhere near the
    # ~0 ms of a burst. Before the fix this saw five or six gaps under a millisecond.
    tight = [g for g in gaps if g < 0.04]
    assert not tight, (
        f"{len(tight)} samples landed within 40 ms of the one before, on a 100 ms schedule: "
        f"{[round(g, 4) for g in gaps]}. The loop is repaying a stalled read by firing the "
        "missed ticks back to back — resync `nxt` instead of catching up.")
    # 🔴 AND IT COUNTED THE STALL. Handled correctly, a stall leaves no trace in the series at
    # all — which is how the original diagnosis stayed an inference nobody could check. This
    # counter is what makes the next one checkable, on a box nobody can log into.
    assert power_mod._STALLS[0] >= 1, (
        "the loop dropped ticks without recording that it did. A stall that leaves no evidence "
        "is one that cannot be confirmed or ruled out later.")


def test_the_sampler_keeps_its_own_rapl_slot(monkeypatch, tmp_path, power_mod):
    """🔴 TWO READERS OF ONE ENERGY COUNTER, AND THE FIX IS TWO SLOTS. RAPL reports joules since
    boot, so watts are the delta between consecutive reads — and the strip's CPU row polls it at
    4 Hz while this sampler polls at 1 Hz. Sharing `_CPU_PREV` would leave each of them dividing
    whatever fragment of an interval the other had not already consumed."""
    import tts_utils as tu

    set_uj = _fake_sensors(monkeypatch, tmp_path, [], energy_uj=0)
    tu._CPU_PREV.clear()
    now = [10.0]
    monkeypatch.setattr(tu.time, "monotonic", lambda: now[0])

    mine = {}
    assert tu._cpu_power_w(state=mine) is None          # primes MY slot…
    assert tu._CPU_PREV == {}, "the sampler's read landed in the strip's slot"
    assert tu._cpu_power_w() is None                    # …and the strip primes its own
    # One key per RAPL domain PATH in each dict, and the two dicts hold the same domain — the
    # split is between READERS, not between domains.
    assert set(mine) == set(tu._CPU_PREV) and len(mine) == 1

    set_uj(100_000_000)
    now[0] = 11.0
    assert tu._cpu_power_w(state=mine) == 100           # 100 J in 1 s, off MY previous read
    assert tu._cpu_power_w() == 100                     # …and the strip's is intact too


def test_rapl_never_subtracts_one_domain_from_another(monkeypatch, tmp_path, power_mod):
    """The header once reported a peak draw of about 2,550 W on
    a box whose readable sensors — two 300 W cards, a 9950X and an iGPU at 0.025 W — cannot sum
    past roughly 830.

    The glob `*rapl*:[0-9]` matches TWO domains on remote host: `intel-rapl:0` (package-0, ~17.2e9 µJ)
    and `intel-rapl:0:0` (core, ~0.43e9 µJ). They are unrelated running totals, the core being a
    sub-domain of the package. The loop returns on the first READABLE one, so the second is
    touched only when the first throws — an empty sysfs read (`ValueError`) or an `-EIO` off the
    MSR (`OSError`), rare but certain over days. With ONE shared previous-read slot that transient
    parked the CORE counter where the PACKAGE's belonged, and the next sample computed
    `package_now - core_prev`: a difference that is arbitrary modulo the 65.5 kJ counter range,
    over a quarter second, i.e. a wattage of up to 262,000 W.

    One transient, one absurd number, and `_PEAK` is a max — it keeps it until Vocalis restarts,
    which is exactly the shape of what he saw. So: the slot is keyed by domain.

    ⚠️ Note which way a WRAP goes, since that was the obvious suspect and is not the culprit: the
    counter is `total mod range`, so a wrapped delta comes out negative or short, never long. It
    can only ever under-report."""
    import os as _os

    import tts_utils as tu

    # remote host's real counters, read : package-0 and its core sub-domain, 16.7 kJ apart.
    set_uj = _fake_sensors(monkeypatch, tmp_path, [], energy_uj=[17_157_614_652, 429_076_351])
    pkg = 0
    now = [100.0]
    monkeypatch.setattr(tu.time, "monotonic", lambda: now[0])

    mine = {}
    assert tu._cpu_power_w(state=mine) is None           # primes off the PACKAGE domain
    now[0] = 100.25
    set_uj(17_157_614_652 + 15_000_000, pkg)             # +15 J in 250 ms = 60 W, a quiet 9950X
    assert tu._cpu_power_w(state=mine) == 60

    # The package read throws — once. Every real cause of this is transient: an empty read from
    # a show() that bailed, -EIO from the MSR, a domain unbound under us.
    real_open = open
    boom = {"on": True}

    def _open(path, *a, **k):
        if boom["on"] and _os.path.basename(_os.path.dirname(str(path))) == "rapl-0":
            boom["on"] = False
            raise OSError(5, "Input/output error")
        return real_open(path, *a, **k)
    monkeypatch.setattr("builtins.open", _open)

    now[0] = 100.5
    fell_through = tu._cpu_power_w(state=mine)           # …so it falls through to the CORE domain
    assert fell_through is None or fell_through < 200, (
        f"the fall-through sample itself is nonsense: {fell_through} W")

    now[0] = 100.75
    set_uj(17_157_614_652 + 30_000_000, pkg)             # the package is readable again
    w = tu._cpu_power_w(state=mine)
    assert w is None or w < 500, (
        f"{w} W off a 9950X. The package counter was subtracted from the CORE domain's previous "
        f"read — 16.7 kJ of unrelated running total over a quarter second. This is the 2,550 W "
        f"peak observed previously; key the previous-read slot by DOMAIN.")


def test_a_card_reporting_past_its_own_board_limit_is_not_believed(monkeypatch, tmp_path,
                                                                   power_mod):
    """🔴 THE SECOND HALF: NOTHING CHECKED A READING AGAINST WHAT THE HARDWARE SAYS IS POSSIBLE.
    hwmon hands back whatever the SMU left in the metrics table, and a mailbox read that lands
    mid-reset returns a NUMBER rather than an error — so "it parsed as an integer" was the only
    check a card's power reading ever got, on the one figure (`_PEAK`) where a single bad sample
    is permanent.

    The ceiling is the card's own `power1_cap_max`, not a constant invented here, and the reading
    is refused at twice it: the failure being caught is garbage — out by orders of magnitude —
    never a regulated average sitting a few percent over its limit. A real spike is never eaten,
    which matters because catching spikes is what this series is FOR.

    And the whole sample goes, not the card: a whole-box total silently missing 300 W is
    indistinguishable downstream from a quiet box."""
    _fake_sensors(monkeypatch, tmp_path,
                  [{"power1_average": 250_000_000, "power1_cap_max": 300_000_000},
                   {"power1_average": 2_400_000_000, "power1_cap_max": 300_000_000}])
    total, liar = power_mod._gpu_w()
    assert total is None and liar and "2400 W" in liar and "300 W" in liar, (
        f"a card claiming 2,400 W against its own 300 W board limit was believed: {(total, liar)}")

    monkeypatch.setattr(power_mod, "_cpu_w", lambda: (60.0, None))
    assert power_mod.sample_once() is None, "a sample with a lying sensor in it was recorded"
    assert not power_mod._HIST and power_mod.snapshot() is None
    assert power_mod._BOGUS[0] == 1, (
        "the sample was discarded without recording that it happened. A guard that leaves no "
        "evidence is one nobody can tell was ever needed — same job as _STALLS.")


def test_a_card_a_little_over_its_cap_is_still_a_measurement(monkeypatch, tmp_path, power_mod):
    """A published cap is a sustained target, not a ceiling. Transient GPU excursions can run
    1.5–2× rated TDP and 200–300% of it for millisecond bursts, amdgpu's caps are loosely
    enforced (a documented 200 W cap producing 278 W peaks), and `power1_average` is fed by a
    FAST_PPT limit that is a ~10 ms moving average — short enough to carry a real burst straight
    into the file this reads.

    So 900 W off a 300 W card — three times sustained, the documented transient ceiling — is a
    MEASUREMENT and must survive. A guard that eats it is worse than no guard, because catching
    spikes is the entire reason this series exists.

    This test is deliberately harsher than a measured workload. A finite sample cannot establish
    a hardware maximum, so the guard must allow documented transient excursions."""
    _fake_sensors(monkeypatch, tmp_path,
                  [{"power1_average": 900_000_000, "power1_cap_max": 300_000_000}])
    total, liar = power_mod._gpu_w()
    assert liar is None and round(total) == 900, (
        "a 300 W card reporting a 900 W transient was called a liar. That is three times "
        "sustained draw, which is what the silicon is documented to do on a millisecond burst — "
        "the cap is not a law, and a bound scaled tightly to it will eat real spikes.")


def test_a_part_that_publishes_no_board_limit_is_still_bounded(monkeypatch, tmp_path, power_mod):
    """Some devices publish no power limit. A fabricated reading of 40,756 W demonstrates
    why readings still need a plausibility bound when no `power1_cap*` value is available:
    `_gpu_w` refused a card past its own `power1_cap_max`, and the iGPU publishes no `power1_cap*`
    at all — `power1_input` and nothing beside it — so its reading was checked by nothing.

    A small ordinary reading says nothing about the range of a faulty sensor. A part that cannot
    draw 40 kW is
    exactly as able to RETURN it, and `_PEAK` is a max, so it stays on screen for the life of the
    process.

    The uncapped part keeps a representative reading (0.012 W) and an ordinary
    one: the ceiling is an absurdity bound, not a plausibility one."""
    igpu = tmp_path / "hwmon1"
    _fake_sensors(monkeypatch, tmp_path,
                  [{"power1_average": 210_000_000, "power1_cap_max": 300_000_000},
                   {"power1_input": 12_000}])                      # ...and no cap files at all

    total, liar = power_mod._gpu_w()
    assert liar is None and round(total, 3) == 210.012, (
        f"the ordinary reading of an uncapped part was refused or dropped: {(total, liar)}")

    (igpu / "power1_input").write_text("40756000000\n")            # fabricated value, in µW
    total, liar = power_mod._gpu_w()
    assert total is None and liar and "40756 W" in liar and "1500 W" in liar, (
        f"a part with no published board limit reported 40,756 W and was believed: {(total, liar)}")

    monkeypatch.setattr(power_mod, "_cpu_w", lambda: (60.0, None))
    assert power_mod.sample_once() is None and not power_mod._HIST, (
        "the sample was recorded anyway — a lying sensor retires the whole sample, not the part")
    assert power_mod._BOGUS[0] == 1


def test_the_cpu_package_is_bounded_too(monkeypatch, tmp_path, power_mod):
    """🔴 THE OTHER UNGUARDED SENSOR, AND THE ONE THE 08-10 SESSION WAS ACTUALLY LOOKING AT.
    That day keyed `_cpu_power_w`'s previous-read slot by domain, which closed the KNOWN route to
    an absurd package wattage, and added a ceiling to the GPU side only — so the CPU figure itself
    stayed unchecked and any other route to a nonsense wattage still landed in a permanent peak.
    AMD's RAPL publishes no `constraint_*_max_power_uw` for a bound to be scaled from (read off
    the available bound source, so the ceiling is `ABSURD_W`.

    ⚠️ THIS IS DRIVEN THROUGH THE REAL `_cpu_power_w` AND REAL FILES, not a stubbed wattage.
    The number under test is a delta divided by an elapsed time this process measures for itself,
    and a guard proved only against a fake that hands back a float has not been shown to sit
    anywhere in particular relative to that arithmetic."""
    now = [1000.0]
    monkeypatch.setattr(power_mod.time, "monotonic", lambda: now[0])
    set_uj = _fake_sensors(monkeypatch, tmp_path, [],
                           energy_uj=[10_000_000_000, 5_000_000_000])

    assert power_mod._cpu_w() == (None, None), "the priming read is not a lie, it is an absence"

    now[0] += 0.25
    set_uj(10_000_000_000 + 50_000_000)                   # 50 J in a quarter second = 200 W
    assert power_mod._cpu_w() == (200, None), "a 200 W package is a 9950X working, not a liar"

    now[0] += 0.25
    uj = 10_000_000_000 + 50_000_000 + 10_189_000_000     # 10.189 kJ in a quarter = 40,756 W
    set_uj(uj)
    w, liar = power_mod._cpu_w()
    assert w is None and liar and "40756 W" in liar, (
        f"40,756 W off a CPU package was believed: {(w, liar)}")

    # ⚠️ A FRESH ABSURD QUARTER-SECOND, because `sample_once` reads RAPL for ITSELF. Re-asserting
    # against the reading above would be asserting about a counter that has not moved since —
    # `_cpu_power_w` has already banked (uj, now) as its previous read, so a second call at the
    # same instant is the no-delta path and returns None with nobody having lied. The first
    # version of this test did exactly that and passed for the wrong reason.
    now[0] += 0.25
    set_uj(uj + 10_189_000_000)
    monkeypatch.setattr(power_mod, "_gpu_w", lambda: (42.0, None))
    assert power_mod.sample_once() is None and not power_mod._HIST, (
        "a sample whose CPU figure was nonsense was recorded — the whole sample goes, and the "
        "42 W of card in it is not a consolation prize: a total that is quietly 40 kW short of "
        "what it claims to be is indistinguishable downstream from a quiet box")
    assert power_mod._BOGUS[0] == 1


def test_the_cpu_ceiling_would_have_caught_the_2550_w_reading(monkeypatch, power_mod):
    """The plausibility bound must reject an aggregate of 2,550 W when the available sensors
    cannot sum past about 830 W. It must also accept genuine transients, so the bound cannot be
    tightened to an ordinary steady-state reading.

    ⚠️ AND THE OTHER ARM MATTERS AS MUCH. `CAP_SLACK`'s docstring is one long argument that a
    guard which eats a real spike is worse than no guard, because catching spikes is what this
    series is FOR. 800 W is roughly a PL4-class transient on the largest x86 package ever shipped
    — it must survive."""
    import tts_utils as tu
    seen = [800.0]
    monkeypatch.setattr(tu, "_cpu_power_w", lambda state=None: seen[0])

    assert power_mod._cpu_w() == (800.0, None), (
        "800 W — about a PL4-class transient on the biggest package that exists — was called a "
        "lie. A bound that eats a real burst is worse than no bound; see CAP_SLACK.")

    seen[0] = 2550.0
    w, liar = power_mod._cpu_w()
    assert w is None and liar and "2550 W" in liar, (
        f"the 2,550 W reading still gets through: {(w, liar)}")


def test_a_transient_cap_read_does_not_permanently_unguard_a_card(monkeypatch, tmp_path,
                                                                  power_mod):
    """🔴 "NO PUBLISHED LIMIT" IS A PERMANENT ANSWER, SO IT MUST NOT BE REACHED BY A TRANSIENT.
    `_card_cap_w` caches what it found, `None` included — and the failure it was catching is
    exactly the transient class that caused the 08-10 bug one file over: an empty read, an -EIO
    from the mailbox, a domain unbound underneath it. One of those on `power1_cap_max` used to
    retire a real 300 W card's own ceiling for the life of the process and quietly demote it to
    the general bound, which is four times looser.

    Absence is cached (the iGPU genuinely has no such file and asking again forever is waste); a
    file that is THERE and did not read is asked again next sample."""
    _fake_sensors(monkeypatch, tmp_path,
                  [{"power1_average": 250_000_000, "power1_cap_max": 300_000_000}])
    h = str(tmp_path / "hwmon0")

    real_open = open
    boom = {"on": True}

    def _open(path, *a, **k):
        if boom["on"] and str(path).endswith("power1_cap_max"):
            boom["on"] = False
            raise OSError(5, "Input/output error")
        return real_open(path, *a, **k)
    monkeypatch.setattr("builtins.open", _open)

    assert power_mod._card_cap_w(h) is None, "the failed read invented a cap"
    assert h not in power_mod._CAPS, (
        "one -EIO on power1_cap_max was cached as 'this card publishes no limit', which unguards "
        "a real 300 W card for the life of the process")
    assert power_mod._card_cap_w(h) == 300.0, "the cap never came back after the transient"


def test_the_hwmon_list_is_not_frozen_on_a_partial_scan(monkeypatch, tmp_path, power_mod):
    """⚠️ THE OLD RULE HANDLED "NO CARDS YET" AND MISSED "SOME CARDS YET". It cached the first
    non-empty glob forever on the grounds that a card cannot appear without a reboot — true of the
    hardware, false of `/sys`, where the cards are published one at a time as the driver probes
    them. A sampler starting into that window froze on one card and every sample after it was a
    "whole-box" total missing 300 W: the same quietly-short number `sample_once` refuses to record
    when a sensor lies, reached by a different road and with nothing to notice it.

    The list only ever grows, and it is not re-globbed on every sample — 4 Hz of directory
    scanning to re-learn something that changes once would be its own defect."""
    import glob as _g
    dirs = []
    for i in range(3):
        d = tmp_path / f"hwmon{i}"
        d.mkdir()
        (d / "name").write_text("amdgpu\n")
        (d / "power1_average").write_text("100000000\n")
        dirs.append(str(d))

    visible = [dirs[:1]]                                   # only the first card has probed
    monkeypatch.setattr(_g, "glob", lambda pat: visible[0] if "hwmon" in pat else [])
    now = [1000.0]
    monkeypatch.setattr(power_mod.time, "monotonic", lambda: now[0])

    assert power_mod._amdgpu_hwmons() == dirs[:1]
    visible[0] = dirs                                      # ...the other two arrive

    now[0] += 1.0
    assert power_mod._amdgpu_hwmons() == dirs[:1], (
        "it re-globbed /sys within a second of the last scan — the throttle is gone")

    now[0] += power_mod.HWMON_RESCAN_S
    assert power_mod._amdgpu_hwmons() == dirs, (
        "the two cards that probed after the first glob are invisible for the life of the "
        "process, so every total from here on is short by whatever they draw")

    visible[0] = dirs[:1]                                  # a card cannot leave; if the glob
    now[0] += power_mod.HWMON_RESCAN_S + 1                 # blinks, the list must not shrink
    assert power_mod._amdgpu_hwmons() == dirs


def test_the_peak_says_which_sensor_made_it(monkeypatch, tmp_path, power_mod):
    """🔴 PROVENANCE ON THE ONE PERMANENT FIGURE. The live watts are replaced four times a second
    and the means wash a bad sample out inside fifteen minutes, so the peak is the only readout
    where a lying sensor stays on screen for the life of the process — and when a monitored host reported 2,550 W
    it was a bare number, so establishing WHICH sensor produced it cost a session of reading sysfs
    by hand. The split at the moment of the peak is two fields.

    Note it is the PEAK's split, not the latest sample's: they are different moments, and the
    tooltip attributes the peak."""
    watts = [100.0]
    now = [1000.0]
    monkeypatch.setattr(power_mod.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(power_mod, "_cpu_w", lambda: (40.0, None))
    monkeypatch.setattr(power_mod, "_gpu_w", lambda: (watts[0], None))

    for i in range(10):
        watts[0] = 600.0 if i == 3 else 100.0
        power_mod.sample_once()
        now[0] += 1.0

    s = power_mod.snapshot()
    assert (s["peak_w"], s["peak_cpu_w"], s["peak_gpu_w"]) == (640, 40, 600)
    assert (s["w"], s["cpu_w"], s["gpu_w"]) == (140, 40, 100), (
        "the peak's split is being taken from the LATEST sample, so it describes the wrong moment")


def test_the_power_sampler_never_imports_torch(power_mod):
    """🔴 THE COLD-START RULE, ASSERTED IN THE ONE PLACE IT COULD BE BROKEN BY A ONE-LINE
    "SIMPLIFICATION". `tts_utils.gpu_power_w` is right there and reads the same hwmon files, and
    using it would be shorter — but it resolves the card through
    `torch.cuda.get_device_properties`, which triggers torch's lazy CUDA init. This sampler runs
    one second after boot, so that would put a HIP context on every card and hold its VRAM for
    the life of the process, on a server that deliberately comes up cold."""
    import tokenize
    from pathlib import Path
    src = Path(power_mod.__file__).read_text(encoding="utf-8")
    # Tokens, not lines: the comments and docstrings in that file discuss torch at length, and
    # a grep over the raw text would only ever be able to assert that they don't.
    code = "".join(t.string for t in tokenize.generate_tokens(io.StringIO(src).readline)
                   if t.type not in (tokenize.COMMENT, tokenize.STRING))
    assert "torch" not in code, (
        "runtime/power.py reaches torch. Read the hwmon files directly — a sampler is not a "
        "reason to initialize CUDA at boot on a server that comes up cold.")


def test_system_stats_carries_the_power_block(monkeypatch, client, power_mod):
    """The route's shape. `None` on a box that can report nothing — the header keys the whole
    line off the block being there, the same way it does for swap."""
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    monkeypatch.setattr("tts_utils.cpu_stats", lambda: {"pct": 1, "cores": 32})

    gpu_mod._STRIP.update(t=0.0, v=None)
    assert client.get("/system/stats").get_json()["power"] is None

    monkeypatch.setattr(power_mod, "snapshot", lambda: {"w": 655, "avg": [640, 620, 300]})
    gpu_mod._STRIP.update(t=0.0, v=None)
    assert client.get("/system/stats").get_json()["power"]["w"] == 655


# ── 4.1: bandwidth extension + the 60-minute cap ─────────────────────────────

@pytest.fixture
def fake_enhance(monkeypatch):
    """Make this box look like remote host: the enhancer is installed and there is a card.

    The enhancer itself is a 21 GB child process in its own venv, so it is replaced by a
    stub that copies its input — what these tests are about is the CHAIN around it (which
    bitrate, which name, which sidecar, what a cancel means), not resemble-enhance."""
    import shutil as _sh
    from pathlib import Path as _P
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: ["cuda:0"])
    ran = []

    def _fake_one(job, src, dst, nfe, device, label):
        ran.append({"src": _P(src).name, "nfe": nfe, "device": device, "label": label})
        _P(dst).parent.mkdir(parents=True, exist_ok=True)
        _sh.copyfile(src, dst)                # stands in for 44.1 kHz with ~22 kHz of content
        return True
    monkeypatch.setattr(rt_enh, "enhance_one", _fake_one)
    return ran


def test_enhanced_clip_is_a_separate_file_encoded_at_256k(client, fake_pg, fake_enhance,
                                                          tmp_output):
    """The whole 4.1 Playground chain: enhance the FINISHED clip, mark it in the name and
    the sidecar, and encode it at 256k — the bitrate that keeps the band we just paid a GPU
    to invent (96k would throw it straight back away)."""
    text = "Hello there. This is a test."
    plain = client.post("/playground/generate", json={"text": text, "enhance": False})
    _wait_terminal(client, plain.get_json()["job_id"])
    enh = client.post("/playground/generate", json={"text": text, "enhance": True, "nfe": 16})
    st = _wait_terminal(client, enh.get_json()["job_id"])
    assert st["status"] == "done"

    assert [r["nfe"] for r in fake_enhance] == [16]        # only the enhanced render ran it
    bitrates = [b for _name, b in fake_pg]
    assert vs.enhance.MP3_BITRATE_PLAIN in bitrates        # the plain take
    assert vs.enhance.MP3_BITRATE_ENHANCED in bitrates     # the enhanced one

    clips = client.get("/playground/clips").get_json()
    assert len(clips) == 2                                 # they did NOT collide on one path
    enhanced = [c for c in clips if c["enhanced"]]
    assert len(enhanced) == 1
    assert "_enhanced_" in enhanced[0]["ref"]              # visible in the library
    assert enhanced[0]["nfe"] == 16


# ── the render ETA: measured on this box, or absent ───────────────────────────

def test_render_rate_endpoint_admits_it_does_not_know(client, tmp_path, monkeypatch):
    """`measured: false` is the whole point. The UI must be able to show NOTHING, rather
    than a default dressed up as an estimate — which overestimated ten-hour books at
    sixteen hours for a month."""
    monkeypatch.setattr(vs.render_rate, "cache_root", lambda: tmp_path)
    r = client.get("/render/rate").get_json()
    assert r["measured"] is False and r["rate"] is None
    assert r["min_chars"] == vs.render_rate.MIN_CHARS


def test_a_render_measures_the_box_and_then_the_eta_exists(client, fake_pg, tmp_output,
                                                           tmp_path, monkeypatch):
    """No estimate is available until a render is measured; then its ETA
    comes from the box's own overall rate. The render records what it did, and the next
    estimate reads it back."""
    monkeypatch.setattr(vs.render_rate, "cache_root", lambda: tmp_path)
    assert client.get("/render/rate").get_json()["measured"] is False

    # Stand in for a real render: enough characters, over enough wall clock, to be quotable.
    # The key is built exactly as the endpoint builds it — the configuration IS the identity,
    # so a test that guessed at it would pass while the two disagreed.
    # Through the module that OWNS it (5.1.1). Reaching it as `vs.parse_devices` was the only
    # thing keeping a dead re-export alive in vocalis_server, which never reads the name itself.
    # 5.3.1: and through the helper that answers "which of THIS box's cards", which is the same
    # question `/render/rate` asks — `default_gpus()` is gone precisely so this cannot drift.
    devices = rt_pool.local_cuda_devices()
    key = vs.render_rate.key_for(vs.render_rate.gpu_name(), gpu_mod.cuda_count(devices),
                                 rt_pool.default_workers())
    vs.render_rate.record(key, 12000, 240)

    r = client.get("/render/rate").get_json()
    assert r["measured"] is True
    assert r["rate"] == pytest.approx(50.0)          # 12000 chars / 240 s of WALL clock
    assert vs.render_rate.eta_seconds(100000, r["rate"]) == pytest.approx(2000)


def test_a_resumed_chapter_cannot_send_the_rate_to_infinity(tmp_path, monkeypatch):
    """A chapter already on disk costs no GPU and returns 0 new chars. Fold its ~0 seconds
    into the rate and the box looks infinitely fast, so the rest of the book is quoted as
    instant — the failure mode of every naive "chars over elapsed" counter."""
    monkeypatch.setattr(vs.render_rate, "cache_root", lambda: tmp_path)
    key = vs.render_rate.key_for("cpu", 0, 1)
    vs.render_rate.record(key, 0, 0.01)              # what a resumed chapter would report
    assert vs.render_rate.get(key) is None
    vs.render_rate.record(key, 6000, 120)            # real work
    assert vs.render_rate.get(key) == pytest.approx(50.0, rel=0.02)


# ── enhance a clip that is ALREADY in the library (the E button) ──────────────

@pytest.fixture
def fake_decode(monkeypatch):
    """The clip on disk is a fake MP3, so the real ffmpeg decode would fail and it cannot be
    measured. Stand in for both: 10.8 kHz is what a real Chatterbox render measures, and
    the whole feature keys off that measurement."""
    from pathlib import Path as _P
    monkeypatch.setattr(rt_enh, "decode_to_wav",
                        lambda src, dst: _P(dst).write_bytes(b"RIFF-fake-wav"))
    monkeypatch.setattr(web_playground, "ffprobe_duration", lambda p: 12.0)
    monkeypatch.setattr(vs.enhance, "bandwidth_of", lambda p, meta=None: (10800, {}))


def _wait_enhance(client, jid):
    for _ in range(400):
        s = client.get(f"/playground/enhance/{jid}").get_json()
        if s["status"] in ("done", "failed", "canceled"):
            return s
        time.sleep(0.02)
    raise AssertionError("enhance job never finished")


def _enhance_clip(client, ref, nfe=None):
    """Fire the E button and wait for its background job."""
    r = client.post(f"/playground/clips/{ref}/enhance", json={"nfe": nfe} if nfe else {})
    if r.status_code != 202:
        return r, None
    return r, _wait_enhance(client, r.get_json()["job_id"])


def test_enhancing_a_stored_clip_replaces_it_with_the_full_band_take(
        client, fake_pg, fake_enhance, fake_decode, tmp_output):
    """The E button. The point is Voice Training: a clip goes there as its MP3, training
    must enhance any band-limited source, and that work is cached on (path, size, mtime) —
    so re-SENDING the clip pays for it all over again. Enhance it once here and every send
    after that is already full-band.

    It REPLACES the clip, because enhancement is one of clip_hash's inputs: the result is a
    different H under an `_enhanced` stem, and leaving the raw take behind would mean the
    library grows a near-duplicate row for every clip you ever tidy up."""
    r = client.post("/playground/generate", json={"text": "Hello there.", "enhance": False})
    _wait_terminal(client, r.get_json()["job_id"])
    before = client.get("/playground/clips").get_json()
    assert len(before) == 1 and before[0]["enhanced"] is False
    old_ref = before[0]["ref"]

    _req, st = _enhance_clip(client, old_ref, nfe=16)
    assert st["status"] == "done"
    assert [e["nfe"] for e in fake_enhance] == [16]         # the render did NOT enhance

    after = client.get("/playground/clips").get_json()
    assert len(after) == 1, "the raw take must not survive as a second row"
    c = after[0]
    assert c["enhanced"] is True and c["nfe"] == 16
    assert "_enhanced_" in c["ref"] and c["ref"] != old_ref  # new identity, new name
    assert c["ref"] == st["ref"]                             # what the row re-points at
    assert vs.enhance.MP3_BITRATE_ENHANCED in [b for _n, b in fake_pg]


def test_enhancing_keeps_the_users_name_and_favorite(client, fake_pg, fake_enhance,
                                                      fake_decode, tmp_output):
    """The stem is rebuilt from the clip's WORDS, not from its text — rebuilding from the
    text (clip_stem) would silently undo every rename the clip has ever had."""
    r = client.post("/playground/generate", json={"text": "Hello there.", "enhance": False})
    _wait_terminal(client, r.get_json()["job_id"])
    ref = client.get("/playground/clips").get_json()[0]["ref"]
    client.post(f"/playground/clips/{ref}/rename", json={"name": "AnotherVoice audition take 3"})
    ref = client.get("/playground/clips").get_json()[0]["ref"]
    client.post(f"/playground/clips/{ref}/favorite", json={"favorite": True})
    ref = client.get("/playground/clips").get_json()[0]["ref"]

    _req, st = _enhance_clip(client, ref)
    assert st["status"] == "done"
    c = client.get("/playground/clips").get_json()[0]
    assert c["name"] == "AnotherVoice audition take 3"
    assert c["favorite"] is True
    assert "AnotherVoice_audition_take_3_enhanced_" in c["ref"]


def test_a_full_band_clip_refuses_to_be_enhanced_again(client, fake_pg, fake_enhance,
                                                       fake_decode, tmp_output, monkeypatch):
    """MEASURED, not remembered (DESIGN §5.1). The same 409 protects a clip we enhanced and
    a genuine 48 kHz upload we never touched — neither has anything to gain, and the flag
    would only get the second one right by accident."""
    r = client.post("/playground/generate", json={"text": "Hello there.", "enhance": False})
    _wait_terminal(client, r.get_json()["job_id"])
    ref = client.get("/playground/clips").get_json()[0]["ref"]

    monkeypatch.setattr(vs.enhance, "bandwidth_of", lambda p, meta=None: (19982, {}))
    resp = client.post(f"/playground/clips/{ref}/enhance", json={})
    assert resp.status_code == 409
    assert resp.get_json()["error"] == "already full quality"
    assert not fake_enhance, "no GPU was spent on a clip with nothing to add"


def test_an_unmeasurable_clip_is_not_called_full_band(client, fake_pg, fake_enhance,
                                                      tmp_output, monkeypatch):
    """is_band_limited folds "unknown" in with "full-band" ON PURPOSE — it is deciding
    whether to spend 95 minutes of GPU on a guess, and a probe that failed is not a license
    to act. But this endpoint is deciding what to TELL the user, and "already full quality"
    about a file we could not read is a confident lie. Different question, different answer.
    """
    r = client.post("/playground/generate", json={"text": "Hello there.", "enhance": False})
    _wait_terminal(client, r.get_json()["job_id"])
    ref = client.get("/playground/clips").get_json()[0]["ref"]

    monkeypatch.setattr(vs.enhance, "bandwidth_of", lambda p, meta=None: (0, {}))
    resp = client.post(f"/playground/clips/{ref}/enhance", json={})
    assert resp.status_code == 409
    err = resp.get_json()["error"]
    assert "couldn't measure" in err and "full quality" not in err
    assert not fake_enhance


def test_enhancing_a_clip_waits_for_the_gpus_rather_than_fighting_a_render(
        client, fake_pg, fake_enhance, fake_decode, tmp_output):
    """The enhancer wants ~21 GB and cannot share a card with a render, which holds every
    card for its whole life. Say so instead of queueing in silence — the render is the thing
    the user is actually watching."""
    r = client.post("/playground/generate", json={"text": "Hello there.", "enhance": False})
    _wait_terminal(client, r.get_json()["job_id"])
    ref = client.get("/playground/clips").get_json()[0]["ref"]

    vs.GPUS.acquire()                       # stand in for a render in flight
    try:
        resp = client.post(f"/playground/clips/{ref}/enhance", json={})
    finally:
        vs.GPUS.release()
    assert resp.status_code == 409
    assert resp.get_json()["error"] == rt_enh.ENHANCE_BUSY["render"]


def test_a_failed_enhancement_leaves_the_original_clip_alone(client, fake_pg, fake_decode,
                                                             tmp_output, monkeypatch):
    """The raw take is only removed once the enhanced one is encoded and described. A
    library that loses the clip AND fails to make a better one is the worst outcome there
    is — and the GPUS must come back either way, or the box never renders again."""
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: ["cuda:0"])

    def _boom(job, src, dst, nfe, device, label):
        raise RuntimeError("resemble-enhance fell over")
    monkeypatch.setattr(rt_enh, "enhance_one", _boom)

    r = client.post("/playground/generate", json={"text": "Hello there.", "enhance": False})
    _wait_terminal(client, r.get_json()["job_id"])
    ref = client.get("/playground/clips").get_json()[0]["ref"]

    _req, st = _enhance_clip(client, ref)
    assert st["status"] == "failed" and "fell over" in st["error"]
    clips = client.get("/playground/clips").get_json()
    assert len(clips) == 1 and clips[0]["ref"] == ref     # untouched
    assert clips[0]["enhanced"] is False
    assert vs.GPUS.acquire(blocking=False), "GPUS leaked — no render could ever start"
    vs.GPUS.release()


def test_a_crash_before_the_enhancer_still_gives_the_gpus_back(client, fake_pg, fake_decode,
                                                               tmp_output, monkeypatch):
    """GPUS is taken by the REQUEST and released by the worker's finally, so any line
    that ran ahead of that try — resolving a path, making a directory — could leak it for
    the life of the process and leave the box unable to render anything, ever. Nothing runs
    outside the try now, and this is what proves it: blow up on the very first step."""
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: ["cuda:0"])

    def _boom(*a, **k):
        raise OSError("scratch dir is read-only")
    monkeypatch.setattr(vs.enhance, "scratch_path", _boom)

    r = client.post("/playground/generate", json={"text": "Hello there.", "enhance": False})
    _wait_terminal(client, r.get_json()["job_id"])
    ref = client.get("/playground/clips").get_json()[0]["ref"]

    _req, st = _enhance_clip(client, ref)
    assert st["status"] == "failed" and "read-only" in st["error"]
    assert vs.GPUS.acquire(blocking=False), "GPUS leaked — the box can never render again"
    vs.GPUS.release()


# ── 4.3: enhance a PARTIAL clip, non-destructively ───────────────────────────

def _seed_partial(h="feedfacecafe", chunks=2, text="A long story being read aloud now.",
                  voice="", name=None):
    """A partial render on disk: `chunks` banked WAVs + a pending manifest."""
    import torch
    ws = playground_clips.workspace(web_playground.CHUNKS_ROOT, h)
    ws.mkdir(parents=True, exist_ok=True)
    for i in range(chunks):
        save_wav_sf(str(ws / f"chunk_{i:04d}.wav"), torch.zeros(1, 24000), 24000)   # 1.0 s each
    m = {"voice": voice, "text": text, "total": chunks + 3, "enhance": True, "nfe": 16}
    if name:
        m["name"] = name
    playground_clips.write_pending(ws, m)
    return h, ws


def test_enhancing_a_partial_makes_a_new_clip_and_leaves_the_partial(
        client, fake_pg, fake_enhance, fake_decode, tmp_output):
    """A partial can be enhanced non-destructively.
    It snapshots the banked prefix into a NEW full-quality clip and leaves the partial exactly
    as it was, still resumable. Nothing is replaced — a partial has no MP3 to replace."""
    h, ws = _seed_partial()
    before = sorted(p.name for p in ws.iterdir())

    r = client.post(f"/playground/partials/{h}/enhance", json={"nfe": 16})
    assert r.status_code == 202
    assert _wait_enhance(client, r.get_json()["job_id"])["status"] == "done"

    # the enhancer ran, and the encode was at the ENHANCED bitrate (256k, not 96k)
    assert [x["nfe"] for x in fake_enhance] == [16]
    assert vs.enhance.MP3_BITRATE_ENHANCED in [b for _n, b in fake_pg]

    clips = client.get("/playground/clips").get_json()
    finished = [c for c in clips if c.get("kind") != "partial"]
    assert len(finished) == 1
    assert finished[0]["enhanced"] is True and "_enhanced_" in finished[0]["ref"]

    # the partial is UNTOUCHED: same workspace, same chunks, still listed as a partial
    assert sorted(p.name for p in ws.iterdir()) == before
    assert any(c.get("kind") == "partial" and c["ref"] == h for c in clips)


def test_a_partial_snapshot_is_not_overwritten_by_a_longer_prefix_or_repeat(
        client, fake_pg, fake_enhance, fake_decode, tmp_output):
    """The identity guard: the snapshot keys on (partial hash, prefix length), NOT the full
    text — so re-enhancing the SAME prefix is idempotent (one clip), enhancing a LONGER prefix
    is a distinct clip, and neither can be clobbered by the completed render's full-text hash."""
    h, ws = _seed_partial(chunks=2)
    r1 = client.post(f"/playground/partials/{h}/enhance", json={"nfe": 16})
    assert _wait_enhance(client, r1.get_json()["job_id"])["status"] == "done"
    ref1 = next(c["ref"] for c in client.get("/playground/clips").get_json()
                if c.get("kind") != "partial")

    # same prefix again → the SAME clip (idempotent)
    r2 = client.post(f"/playground/partials/{h}/enhance", json={"nfe": 16})
    _wait_enhance(client, r2.get_json()["job_id"])
    finished = [c for c in client.get("/playground/clips").get_json() if c.get("kind") != "partial"]
    assert len(finished) == 1 and finished[0]["ref"] == ref1

    # bank one more chunk → a LONGER prefix → a DISTINCT snapshot, the first still there
    import torch
    save_wav_sf(str(ws / "chunk_0002.wav"), torch.zeros(1, 24000), 24000)
    r3 = client.post(f"/playground/partials/{h}/enhance", json={"nfe": 16})
    _wait_enhance(client, r3.get_json()["job_id"])
    finished = [c for c in client.get("/playground/clips").get_json() if c.get("kind") != "partial"]
    assert len(finished) == 2 and ref1 in [c["ref"] for c in finished]


def test_enhancing_a_partial_with_nothing_banked_is_refused(client, fake_enhance, tmp_output):
    h = "abcabcabcabc"
    playground_clips.write_pending(playground_clips.workspace(web_playground.CHUNKS_ROOT, h),
                                   {"voice": "", "text": "nothing banked yet", "total": 3})
    assert client.post(f"/playground/partials/{h}/enhance", json={}).status_code == 409
    assert client.post("/playground/partials/nothex/enhance", json={}).status_code == 404


# ── 4.1-M16: an enhancement takes ONE card, so two of them take two ──────────
#
# Two independent enhancements should use separate cards when available. One global lock
# (GEN_LOCK) served every GPU job, so the first enhancement locked out the
# second even though it was only ever using one card. The machinery to do better was already
# there: _enhance_one pins its child to a card and takes that card's lock, and the book's own
# post-pass has always run one enhancer per card. Only the gate was wrong.

# (A polling helper, `_until`, used to sit here. The tests below now wait on a signal from their
# own stub -- or, for the gate, from a Condition that reports the queued render -- so it is gone.
# The claim is made in the REQUEST, so the tests do not depend on the wait; it proves the card
# really is in the enhancer's hands, not merely spoken for.)

@pytest.fixture
def two_cards(monkeypatch):
    """remote host: two R9700s, both idle. gpu_stats is what the card order is read from."""
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(rt_enh, "enhance_cards", lambda: ["cuda:0", "cuda:1"])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [{"index": 0, "free_gb": 31.9},
                                                  {"index": 1, "free_gb": 31.9}])


def test_two_clips_enhance_side_by_side_on_two_cards(client, fake_pg, fake_decode,
                                                     tmp_output, two_cards, monkeypatch):
    """THE BUG. Enhance one clip, then enhance another while the first is still running:
    the second must get the idle card, not a 409 blaming a render that isn't running."""
    import shutil as _sh
    started, go = queue.Queue(), threading.Event()    # started: the device each enhancer holds

    def _blocking_one(job, src, dst, nfe, device, label):
        started.put(device)
        go.wait(5)                          # hold the card, like a real 16-minute run
        _sh.copyfile(src, dst)
        return True
    monkeypatch.setattr(rt_enh, "enhance_one", _blocking_one)

    for text in ("AnotherVoice speaking.", "SampleVoice speaking."):
        r = client.post("/playground/generate", json={"text": text, "enhance": False})
        _wait_terminal(client, r.get_json()["job_id"])
    refs = [c["ref"] for c in client.get("/playground/clips").get_json()]
    assert len(refs) == 2

    try:
        a = client.post(f"/playground/clips/{refs[0]}/enhance", json={})
        assert a.status_code == 202
        first_card = started.get(timeout=10)           # AnotherVoice has a card in hand

        b = client.post(f"/playground/clips/{refs[1]}/enhance", json={})
        assert b.status_code == 202, f"the other card was idle: {b.get_json()}"
        second_card = started.get(timeout=10)
        assert sorted([first_card, second_card]) == ["cuda:0", "cuda:1"], "two enhancements, two cards"
    finally:
        go.set()
    for r in (a, b):
        assert _wait_enhance(client, r.get_json()["job_id"])["status"] == "done"
    assert vs.GPUS.acquire(blocking=False), "both cards must come back"
    vs.GPUS.release()


def test_the_second_enhancement_is_refused_honestly_when_the_one_card_is_busy(
        client, fake_pg, fake_enhance, fake_decode, tmp_output, monkeypatch):
    """A one-card box refuses the second enhancement and reports the actual busy device. The
    previous message incorrectly blamed an unrelated render."""
    import shutil as _sh
    go, started = threading.Event(), threading.Event()

    def _blocking_one(job, src, dst, nfe, device, label):
        started.set()
        go.wait(5)
        _sh.copyfile(src, dst)
        return True
    monkeypatch.setattr(rt_enh, "enhance_one", _blocking_one)
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [{"index": 0, "free_gb": 31.9}])

    for text in ("AnotherVoice speaking.", "SampleVoice speaking."):
        r = client.post("/playground/generate", json={"text": text, "enhance": False})
        _wait_terminal(client, r.get_json()["job_id"])
    refs = [c["ref"] for c in client.get("/playground/clips").get_json()]

    try:
        assert client.post(f"/playground/clips/{refs[0]}/enhance", json={}).status_code == 202
        assert started.wait(timeout=10), "the enhancer never took its card"
        assert vs.GPUS.enhancing() == 1
        resp = client.post(f"/playground/clips/{refs[1]}/enhance", json={})
        assert resp.status_code == 409
        err = resp.get_json()["error"]
        assert err == rt_enh.ENHANCE_BUSY["cards"]
        assert "render" not in err, "nothing is rendering — do not say there is"
    finally:
        go.set()


def test_the_gate_gives_each_enhancement_a_card_of_its_own():
    """The claim is made in the request, not when the job thread reaches the enhancer a few
    milliseconds later — otherwise two E clicks in the same instant would both be handed the
    same idle card and one would sit behind the other's card lock for the whole run."""
    g = vs.GpuGate()
    assert g.claim_card(["cuda:1", "cuda:0"]) == ("cuda:1", "")
    assert g.claim_card(["cuda:1", "cuda:0"]) == ("cuda:0", "")
    assert g.claim_card(["cuda:1", "cuda:0"]) == (None, "cards")
    g.release_card("cuda:1")
    assert g.claim_card(["cuda:1", "cuda:0"]) == ("cuda:1", "")


def test_the_gate_keeps_renders_and_enhancements_off_each_other():
    """A render owns every card and the enhancer wants ~21 GB of one, so they are exclusive
    — and a render QUEUED for the cards stands new enhancements down. Without that last
    part, a trickle of 16-minute enhancements could keep an interactive render waiting
    indefinitely; an enhancement is a background tidy-up and it yields."""
    g = vs.GpuGate()
    assert g.acquire(timeout=1)                        # a render holds the lot
    assert g.claim_card(["cuda:0"]) == (None, "render")
    g.release()

    assert g.claim_card(["cuda:0"]) == ("cuda:0", "")  # now an enhancement holds the card
    assert not g.acquire(timeout=0.1), "the render must wait for the card back"

    # Know the render is QUEUED without polling the gate: swap in a Condition that reports the
    # moment a thread blocks in wait(). acquire() counts itself as waiting (under the condition's
    # lock) before it ever waits, and the lock is only released inside wait(), so claim_card()
    # below cannot get in until the render is both counted and parked.
    class _SignalingCondition(threading.Condition):
        def __init__(self, entered):
            super().__init__()
            self._entered = entered
        def wait(self, timeout=None):
            self._entered.set()
            return super().wait(timeout)
    render_parked = threading.Event()
    g._cv = _SignalingCondition(render_parked)

    got = []
    t = threading.Thread(target=lambda: got.append(g.acquire(timeout=4)), daemon=True)
    t.start()
    assert render_parked.wait(timeout=10), "the render never queued for the cards"
    assert g.claim_card(["cuda:1"])[1] == "render_waiting"   # queued ⇒ no new ones
    g.release_card("cuda:0")
    t.join(5)
    assert got == [True]                               # and the render gets every card
    assert g.claim_card(["cuda:0"]) == (None, "render")
    g.release()


def test_the_emptiest_card_is_offered_first(monkeypatch):
    """Card 0 is idle while card 1 has 13.5 GB free and is running the first enhancement. The
    second enhancement should be offered to card 0."""
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [{"index": 0, "free_gb": 31.8},
                                                  {"index": 1, "free_gb": 18.4}])
    assert gpu_mod.cards_emptiest_first(["cuda:0", "cuda:1"]) == ["cuda:0", "cuda:1"]

    # Within 0.5 GB it is a tie, and a tie goes to the HIGHEST card: card 0 is what
    # everything else on the box grabs by default, so leave it free within reason.
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [{"index": 0, "free_gb": 31.9},
                                                  {"index": 1, "free_gb": 31.7}])
    assert gpu_mod.cards_emptiest_first(["cuda:0", "cuda:1"]) == ["cuda:1", "cuda:0"]


def test_the_size_tooltip_can_name_the_actual_file(client, fake_pg, tmp_output):
    """The display name is the user's — renamed, identity suffix stripped — so the row
    otherwise never says what the clip is really called or what format it is in."""
    r = client.post("/playground/generate", json={"text": "Hello there."})
    _wait_terminal(client, r.get_json()["job_id"])
    c = client.get("/playground/clips").get_json()[0]
    assert c["format"] == "mp3"
    assert c["file"].endswith(".mp3") and c["file"] == c["ref"].split("/")[1] + ".mp3"


def test_asking_to_enhance_where_it_is_impossible_fails_before_the_render(
        client, fake_pg, tmp_output, monkeypatch):
    """A render is minutes to hours and the enhance pass is at the END of it. Discovering
    the toolchain is missing THERE would mean the GPU time is already spent."""
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: False)
    r = client.post("/playground/generate", json={"text": "Hi there.", "enhance": True})
    assert r.status_code == 400
    # The reason itself varies with what is missing on the host running the test; the route's
    # own contract is that it explains and offers the way out before any GPU time is spent.
    assert "untick enhance to render without it" in r.get_json()["error"].lower()


def test_the_default_degrades_where_enhancement_is_impossible(client, fake_pg, tmp_output,
                                                              monkeypatch):
    """Enhance is default-ON, but a default that hard-fails is not a default — it is an
    outage. On a box that cannot enhance, a caller who never asked for it (and may not know
    it exists) still gets their render."""
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: False)
    r = client.post("/playground/generate", json={"text": "Hi there."})
    assert r.status_code == 202
    st = _wait_terminal(client, r.get_json()["job_id"])
    assert st["status"] == "done" and st["enhance"] is False


def test_the_default_is_on_where_enhancement_works(client, fake_pg, fake_enhance, tmp_output):
    r = client.post("/playground/generate", json={"text": "Hi there."})
    st = _wait_terminal(client, r.get_json()["job_id"])
    assert st["enhance"] is True and len(fake_enhance) == 1


def test_the_60_minute_cap_produces_a_finished_clip_not_a_canceled_one(client, monkeypatch,
                                                                        tmp_output):
    """The cap STOPS the render and SAVES what it has. It is not a cancel: the clip is
    complete, it lists in the library, and it plays — it is simply the amount of audio the
    user chose to make. (Chunks here are 1 s each and the cap is stubbed to 3 s.)"""
    import torch
    from pathlib import Path as _P
    monkeypatch.setattr(jobs_mod, "CAP_SECONDS", 3.0)

    class _FakePool:
        sr = FAKE_SR
        def run_chunks(self, items, params, save, total, on_event=None, chapter=None, cancel=None):
            for i, _t in items:
                if cancel is not None and cancel.is_set():
                    break                      # the cap stops new chunks, exactly as a cancel does
                save(i, torch.zeros(1, FAKE_SR), FAKE_SR)      # 1.0 s per chunk
            return 0, 0.0
        def shutdown(self):
            pass
    monkeypatch.setattr(rt_pool, "get_pool", lambda d, w: _FakePool())

    def _enc(wav, mp3, bitrate=None):
        _P(mp3).parent.mkdir(parents=True, exist_ok=True)
        _P(mp3).write_bytes(b"ID3")
        return _P(mp3)
    monkeypatch.setattr(playground_clips, "encode_mp3", _enc)

    text = " ".join(f"Sentence number {i} is here." for i in range(60))   # many chunks
    r = client.post("/playground/generate",
                    json={"text": text, "enhance": False, "cap60": True})
    st = _wait_terminal(client, r.get_json()["job_id"])
    assert st["status"] == "done"               # NOT 'canceled'
    assert st["capped"] is True
    assert st["audio_s"] >= 3.0

    clips = client.get("/playground/clips").get_json()
    finished = [c for c in clips if c["kind"] == "clip"]
    assert len(finished) == 1                   # a real clip, in the library
    assert finished[0]["duration_s"] >= 3.0
    assert not [c for c in clips if c["kind"] == "partial"]   # and no partial left behind


def test_the_cap_can_be_turned_on_during_a_render(client, tmp_output):
    """The one live setting. You tick it ten minutes in, having realized the text is longer
    than you thought — so it must be settable on a job that is already running."""
    job = jobs_mod.Job(id="capme01", docx="", voice="", params=tts_utils.GenParams(voice=None),
                 gpus="cpu", workers=1, kind="playground", clip_h="a" * 12)
    job.status = "running"
    job.audio_s = 4200.0
    with jobs_mod.JOBS_LOCK:
        jobs_mod.JOBS[job.id] = job
    try:
        r = client.post("/playground/cap", json={"job_id": job.id, "cap": True})
        assert r.status_code == 200
        assert r.get_json()["cap"] is True and job.cap60 is True
        # It reports the audio ALREADY made, so the client can say "this render has already
        # produced 70 minutes — capping now stops it at the next chunk" instead of implying
        # it can undo what is already down.
        assert r.get_json()["audio_s"] == 4200.0
        assert client.post("/playground/cap",
                           json={"job_id": job.id, "cap": False}).get_json()["cap"] is False
    finally:
        with jobs_mod.JOBS_LOCK:
            jobs_mod.JOBS.pop(job.id, None)


def test_cap_refuses_a_finished_render(client, tmp_output):
    job = jobs_mod.Job(id="capme02", docx="", voice="", params=tts_utils.GenParams(voice=None),
                 gpus="cpu", workers=1, kind="playground", clip_h="b" * 12)
    job.status = "done"
    with jobs_mod.JOBS_LOCK:
        jobs_mod.JOBS[job.id] = job
    try:
        assert client.post("/playground/cap",
                           json={"job_id": job.id, "cap": True}).status_code == 409
    finally:
        with jobs_mod.JOBS_LOCK:
            jobs_mod.JOBS.pop(job.id, None)


# ── the AudioMeter: seconds of CONTIGUOUS audio ──────────────────────────────

def test_the_60_minute_cap_is_actually_sixty_minutes():
    """🔴 The one thing the two cap tests above CANNOT tell you.

    Both of them start with `monkeypatch.setattr(jobs_mod, "CAP_SECONDS", …)` — 3.0 and 2.0 — because
    driving the real value would mean synthesizing an hour of audio per test. That is the right
    trade, and it leaves the production constant asserted by nothing: change it to 360 and every
    one of those tests still passes while the feature the UI calls a 60-minute cap silently
    becomes a six-minute one. The user-visible promise lives in the number, not the mechanism.

    It is also the number the client is told (`/enhance/info` → `cap_seconds`), so the label the
    UI draws and the threshold the server enforces are pinned together here.

    The cap behavior is covered above; this assertion pins the production duration without
    rendering an hour of audio.
    """
    assert jobs_mod.CAP_SECONDS == 3600.0, "cap60 means SIXTY minutes — the UI says so"
    assert jobs_mod.CAP_SECONDS == 60 * 60.0


def test_the_cap_seconds_the_client_is_told_is_the_one_enforced(client):
    """The UI quotes this figure before the user commits to a render. If /enhance/info ever
    reports a different number from the one _pg_cap_check compares against, the app lies about
    when it will stop — and it lies in the direction of making more audio than asked for."""
    assert client.get("/enhance/info").get_json()["cap_seconds"] == jobs_mod.CAP_SECONDS


def test_audio_meter_counts_the_contiguous_prefix_only():
    """Chunks finish out of order across workers. A clip is a PREFIX of the text, never a
    set of islands — so counting every file on disk would let the cap fire on 55 minutes of
    audio plus a chunk from further down the page."""
    m = web_playground.AudioMeter()
    m.add(0, 10.0)
    m.add(2, 10.0)          # an island: chunk 1 is still rendering
    assert m.chunks == 1 and m.seconds == 10.0
    m.add(1, 5.0)           # the gap fills — now all three count
    assert m.chunks == 3 and m.seconds == 25.0


def test_audio_meter_seeds_a_resume_from_real_durations(tmp_path):
    """A resumed render can have GAPS in it, so there is no 'prefix length' to take on
    trust: every chunk carries its own measured duration and the prefix falls out of the
    set."""
    import torch
    from tts_utils import save_wav_sf
    ws = tmp_path / "ws"
    ws.mkdir()
    for i, frames in ((0, 24000), (1, 12000), (3, 24000)):   # 1.0 s, 0.5 s, one past a gap
        save_wav_sf(str(ws / f"chunk_{i:04d}.wav"), torch.zeros(1, frames), 24000)
    m = web_playground.AudioMeter().seed(ws, [0, 1, 3])
    assert m.chunks == 2 and m.seconds == 1.5                # chunk 3 is beyond the gap
    m.add(2, 2.0)
    assert m.chunks == 4 and m.seconds == 4.5                # gap filled: 3 now counts too


# ── the book's enhance setting is a property of the BOOK ─────────────────────

def test_a_book_cannot_change_its_enhance_setting_midway(client, fake_pipeline, fake_enhance,
                                                         tmp_output, tmp_path):
    """Chapters 1-3 dull and 4-12 crisp is a worse audiobook than either one consistently.
    Once a book has committed chapters to disk the setting is fixed, and a render that
    disagrees is REFUSED — there is deliberately no 'mix anyway'."""
    docx = tmp_path / "Locked.docx"
    make_test_docx(docx, num_chapters=2)
    r = client.post("/book/start", json={"path": str(docx), "enhance": True})
    _wait_terminal(client, r.get_json()["job_id"])

    out = books_root(vs.OUTPUT_DIR) / "Locked"
    sc = vs.book_state.load_sidecar(out) or {}
    assert sc["enhance"] is True
    assert vs.book_state.rendered_chapters(out) > 0

    bad = client.post("/book/start", json={"path": str(docx), "enhance": False})
    assert bad.status_code == 409
    body = bad.get_json()
    assert body["error"] == "enhance_locked"
    assert body["enhance"] is True               # the client offers to continue with THIS
    assert body["rendered"] > 0

    ok = client.post("/book/start", json={"path": str(docx), "enhance": True})
    assert ok.status_code == 200


def test_a_book_with_nothing_rendered_is_still_free_to_choose(client, tmp_output):
    """An empty folder has nothing to be inconsistent WITH, so the lock must not fire on
    one — that would freeze the setting forever after a single failed start."""
    assert vs.book_state.book_enhance_lock(books_root(vs.OUTPUT_DIR) / "Nothing") is None


def test_the_enhance_pass_finishes_what_a_stopped_render_left_behind(tmp_path):
    """The WAV on disk IS the to-do list. Both paths delete a chapter's WAV the instant its
    MP3 lands, so 'still has a WAV' means 'not finished' — whether it was rendered a minute
    ago or stranded by a render that was stopped yesterday. There is no second ledger to
    drift out of sync with the files."""
    d = tmp_path / "book"
    (d / "mp3").mkdir(parents=True)
    (d / "01_One.wav").write_bytes(b"x")           # rendered, not yet encoded
    (d / "02_Two.wav").write_bytes(b"x")
    (d / "mp3" / "00_Zero.mp3").write_bytes(b"x")  # already finished — no WAV left
    (d / "book_full.wav").write_bytes(b"x")        # the concatenated book, not a chapter
    (d / "03_Three.part.wav").write_bytes(b"x")    # a save still in flight
    assert [p.name for p in web_books._pending_chapter_wavs(d)] == ["01_One.wav", "02_Two.wav"]


def test_a_straggler_chunk_after_the_cap_is_not_banked(client, monkeypatch, tmp_output):
    """The cap finalizes IMMEDIATELY — it cannot wait for the chunks already on the GPUs,
    which are mid-synthesis and can't be preempted. So finalize (concat → encode → rmtree
    the workspace) runs while those stragglers are still landing.

    A straggler that banked into a workspace being deleted would raise FileNotFoundError
    inside a pool worker (save_wav_sf does not recreate its parent). They are text past the
    point the user asked us to stop, so they are dropped — and the clip is exactly the
    contiguous prefix the cap froze."""
    import torch
    from pathlib import Path as _P
    monkeypatch.setattr(jobs_mod, "CAP_SECONDS", 2.0)

    class _FakePool:
        sr = FAKE_SR
        def run_chunks(self, items, params, save, total, on_event=None, chapter=None, cancel=None):
            # Every chunk lands, INCLUDING after the cap trips — exactly what happens when
            # workers×cards chunks are already in flight when it fires.
            for i, _t in items:
                save(i, torch.zeros(1, FAKE_SR), FAKE_SR)      # 1.0 s each
            return 0, 0.0
        def shutdown(self):
            pass
    monkeypatch.setattr(rt_pool, "get_pool", lambda d, w: _FakePool())

    def _enc(wav, mp3, bitrate=None):
        _P(mp3).parent.mkdir(parents=True, exist_ok=True)
        _P(mp3).write_bytes(b"ID3")
        return _P(mp3)
    monkeypatch.setattr(playground_clips, "encode_mp3", _enc)

    # Snapshot the workspace at the instant finalize opens it — this is the moment the
    # deletion race would be live, and the only place the invariant is observable (the
    # workspace is gone by the time the request returns).
    seen = {}
    real = web_playground._pg_write_clip

    def _spy(job, ws, sr, upto):
        seen["files"] = len(list(_P(ws).glob("chunk_*.wav")))
        seen["upto"] = upto
        return real(job, ws, sr, upto)
    monkeypatch.setattr(web_playground, "_pg_write_clip", _spy)

    text = " ".join(f"Sentence number {i} is here." for i in range(60))
    r = client.post("/playground/generate",
                    json={"text": text, "enhance": False, "cap60": True})
    st = _wait_terminal(client, r.get_json()["job_id"])
    assert st["status"] == "done" and st["capped"] is True
    assert st["audio_s"] < 10          # it stopped near the 2 s cap, not at the 60th chunk

    # NOTHING beyond the cap was written. Without the guard the stragglers all land, and
    # finalize would be deleting a workspace that pool workers were still writing into.
    assert seen["files"] == seen["upto"], (
        f"{seen['files']} chunks on disk but the clip is frozen at {seen['upto']} — "
        f"chunks past the cap are still being banked")

    # The clip is exactly that frozen prefix, and no partial is left behind.
    clip = [c for c in client.get("/playground/clips").get_json() if c["kind"] == "clip"][0]
    assert clip["duration_s"] == pytest.approx(st["audio_s"], abs=0.11)
    assert not [c for c in client.get("/playground/clips").get_json() if c["kind"] == "partial"]

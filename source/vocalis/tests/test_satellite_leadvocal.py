"""8.6 — routing a lead-vocal separation to a satellite, and the guards around it.

Nothing here loads a model or talks to a real satellite. It pins routing decisions and failure
handling that are difficult to exercise in a live run: an unavailable satellite, a stale
separator copy, or a cancellation during transfer.

🔴 THE TWO PARITY TESTS ARE THE POINT OF THIS FILE. The satellite folder is copied to another
machine and has no Vocalis checkout, so `detect_env` and the separator child exist twice on
purpose. Duplication that is CHECKED is a design; duplication that is trusted is the
SillyTavern-extension drift, which went unnoticed through an entire release line.
"""
import hashlib
import sys
import threading
import time
from pathlib import Path

import pytest

import leadvocal
import stemsplit
from vocalis.runtime import subsystems

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "satellite"))
import vocalis_satellite_leadvocal as sat_lv          # noqa: E402
import vocalis_satellite_protocol as proto            # noqa: E402

REPO = Path(__file__).resolve().parent.parent


# ── the duplication that must not drift ──────────────────────────────────────

def test_the_satellites_separator_is_byte_identical_to_ours():
    """🔴 A satellite running DIFFERENT separator code answers with plausible audio computed by
    something nobody is looking at — the worst shape this can fail in, because every downstream
    check still passes. `script_sha` catches a stale COPY on the box; this catches the two
    files diverging in the repo, which is the thing a copy would then propagate."""
    ours = (REPO / "scripts" / "leadvocal" / "detect.py").read_bytes()
    theirs = (REPO / "satellite" / "leadvocal_detect.py").read_bytes()
    assert ours == theirs, (
        "scripts/leadvocal/detect.py and satellite/leadvocal_detect.py have diverged. "
        "They are ONE child run in two places; copy the repo's over the satellite's.")


def test_both_sides_hash_the_child_the_same_way():
    mine = leadvocal.detect_script_sha(REPO / "scripts" / "leadvocal" / "detect.py")
    assert mine and mine == sat_lv.script_sha()


def test_a_missing_child_reads_as_cannot_compare_not_as_a_mismatch(tmp_path):
    """Empty, never a wrong-looking hash: a mismatch takes the satellite out of the running, so
    'I could not read my own file' must not be spelled the same way."""
    assert leadvocal.detect_script_sha(tmp_path / "gone.py") == ""


@pytest.mark.parametrize("device", ["cuda:0", "cuda:1", "cuda:7", "cpu", "", 'test-satellite:cuda:0'])
def test_detect_env_is_identical_on_both_sides(device):
    """🔴 The lever is the ENVIRONMENT — `audio-separator` has no `device=` argument — so the
    two copies disagreeing means the satellite silently runs on a card remote host did not choose, or
    on all of them. Hiding must be EMPTY rather than unset: unset means 'all of them'."""
    base = {"PATH": "/usr/bin", "HOME": "/home/test-user"}
    assert leadvocal.detect_env(base, device) == sat_lv.detect_env(base, device)


def test_the_vram_requirement_is_the_same_number_on_both_sides():
    """remote host asks 'have you got 1.9 GB' and the satellite re-checks with its own copy. Two
    different figures would make the second check either dead code or a silent second policy."""
    assert leadvocal.REQUIRED_VRAM_GB == sat_lv.REQUIRED_VRAM_GB


# ── the wire ─────────────────────────────────────────────────────────────────

def test_parts_survive_a_body_bigger_than_one_frame():
    """🔴 THE REASON LENGTHS LIVE IN THE HEADER. `seal_bytes` splits anything over 4 MB across
    DATA frames, so a reader that counted frames would work on a short song and mis-slice a
    long one — which is a bug that only appears on real material."""
    big = bytes(range(256)) * (5 * 1024 * 1024 // 256)          # 5 MB, over FRAME_PAYLOAD_BYTES
    body = proto.pack_parts({"request_id": "abc"}, [("vocals", big), ("dry", b"tail")])
    key = proto.derive_key(proto.new_master(), proto.new_salt(), proto.DIR_TO_SERVER)
    head, parts = proto.unpack_parts(proto.open_bytes(key, proto.seal_bytes(key, body)))
    assert head["request_id"] == "abc"
    assert parts["vocals"] == big and parts["dry"] == b"tail"
    assert len(proto.seal_bytes(key, body)) > proto.FRAME_PAYLOAD_BYTES     # it really did split


def test_an_empty_part_round_trips():
    body = proto.pack_parts({}, [("vocals", b"")])
    _head, parts = proto.unpack_parts(body)
    assert parts["vocals"] == b""


def test_a_truncated_body_raises_rather_than_returning_half_a_wav():
    """Half a WAV handed to a separator comes back as confident audio for the wrong length of
    song, so this has to be an error and not a short read."""
    body = proto.pack_parts({}, [("vocals", b"x" * 100)])
    with pytest.raises(proto.ProtocolError):
        proto.unpack_parts(body[:-10])


def test_trailing_bytes_after_the_last_part_raise():
    body = proto.pack_parts({}, [("vocals", b"x" * 8)])
    with pytest.raises(proto.ProtocolError):
        proto.unpack_parts(body + b"junk")


def test_a_garbage_header_raises_instead_of_being_guessed_at():
    with pytest.raises(proto.ProtocolError):
        proto.unpack_parts(b"\x00\x00\x00\x04nope")


# ── the policy ───────────────────────────────────────────────────────────────

SAT = 'test-satellite:cuda:0'


def test_a_satellite_with_room_wins_over_a_local_card():
    dev, why = leadvocal.route_lead(
        "auto", satellites=[{"device": SAT, "free_gb": 21.3, "ok": True}],
        local_cards=["cuda:0", "cuda:1"])
    assert dev == SAT and "faster" in why


def test_a_satellite_short_of_vram_is_skipped():
    dev, _ = leadvocal.route_lead(
        "auto", satellites=[{"device": SAT, "free_gb": 1.2, "ok": True}],
        local_cards=["cuda:0", "cuda:1"])
    assert dev == "cuda:0"


def test_exactly_the_requirement_is_enough():
    """No margin is added: the exact VRAM requirement must remain sufficient."""
    dev, _ = leadvocal.route_lead(
        "auto", satellites=[{"device": SAT, "free_gb": leadvocal.REQUIRED_VRAM_GB, "ok": True}],
        local_cards=["cuda:0"])
    assert dev == SAT


def test_a_satellite_that_cannot_answer_is_not_a_candidate():
    """`free_gb: None` is a box with no CUDA to measure. It must read as 'no', never as
    'unlimited' — `inf` would make it win every time it was least able to deliver."""
    dev, _ = leadvocal.route_lead(
        "auto", satellites=[{"device": SAT, "free_gb": None, "ok": True}],
        local_cards=["cuda:1"])
    assert dev == "cuda:1"


def test_an_unhealthy_satellite_is_not_a_candidate():
    dev, _ = leadvocal.route_lead(
        "auto", satellites=[{"device": SAT, "free_gb": 99.0, "ok": False}],
        local_cards=["cuda:1"])
    assert dev == "cuda:1"


def test_local_cards_rotate_so_a_queue_does_not_pile_onto_one():
    picks = [leadvocal.route_lead("auto", local_cards=["cuda:0", "cuda:1"], cursor=i)[0]
             for i in range(5)]
    assert picks == ["cuda:0", "cuda:1", "cuda:0", "cuda:1", "cuda:0"]


def test_the_satellite_does_not_take_its_turn_in_the_rotation():
    """Prefer a qualifying satellite on every song; rotate only among local cards when needed."""
    for cursor in range(4):
        dev, _ = leadvocal.route_lead(
            "auto", satellites=[{"device": SAT, "free_gb": 20.0, "ok": True}],
            local_cards=["cuda:0", "cuda:1"], cursor=cursor)
        assert dev == SAT


def test_no_card_anywhere_falls_back_to_the_cpu():
    dev, why = leadvocal.route_lead("auto", satellites=[], local_cards=[])
    assert dev == "cpu" and "CPU" in why


@pytest.mark.parametrize("want", ["cpu", "cuda:1"])
def test_an_explicit_setting_beats_every_satellite(want):
    """An explicit `leadvocal_device` setting takes precedence over automatic routing."""
    dev, why = leadvocal.route_lead(
        want, satellites=[{"device": SAT, "free_gb": 40.0, "ok": True}],
        local_cards=["cuda:0"])
    assert dev == want and "leadvocal_device" in why


def test_candidates_collapse_every_failure_to_not_available():
    """An unavailable satellite is a normal routing outcome, not an error to propagate."""
    def probe(dev):
        if dev == "a:cuda:0":
            raise ConnectionError("remote host is off")
        return {"free_gb": 8.0}

    got = leadvocal.satellite_candidates(["a:cuda:0", "b:cuda:0"], probe)
    assert [c["ok"] for c in got] == [False, True]
    assert got[0]["free_gb"] is None and got[1]["free_gb"] == 8.0


# ── the wiring in the job ────────────────────────────────────────────────────

def test_the_fallback_can_never_choose_a_satellite_again(monkeypatch):
    """🔴 One retry is a fallback; a router that can re-pick the thing that just refused is a
    loop. The reason a satellite said no is a moment, not a state the router can see."""
    monkeypatch.setattr("vocalis.runtime.pool.local_cuda_devices", lambda sub: ["cuda:0"])
    job = stemsplit.new_job(mode="lead", device="cuda:0", source_ref="song:x",
                           song_name="x", h="0" * 8)
    for _ in range(4):
        dev, _why = stemsplit._local_lead_device(job, _cfg())
        assert not dev.startswith('test-satellite') and dev in ("cuda:0", "cpu")


def test_an_unreachable_satellite_leaves_the_candidate_list_empty(monkeypatch):
    monkeypatch.setattr("vocalis.runtime.pool.default_devices", lambda sub: [SAT])
    monkeypatch.setattr("vocalis.runtime.satellites.health",
                        lambda name: {"reachable": False, "devices": [], "ready": False})
    assert stemsplit._satellite_lead_devices(
        REPO / "scripts" / "leadvocal" / "detect.py") == []


def test_a_drifted_satellite_separator_is_refused(monkeypatch):
    """🔴 The satellite install is a COPY, so `git pull` does not refresh it. A satellite whose
    child differs from ours is taken out of the running rather than trusted."""
    monkeypatch.setattr("vocalis.runtime.pool.default_devices", lambda sub: [SAT])
    monkeypatch.setattr("vocalis.runtime.satellites.health",
                        lambda name: {"reachable": True, "leadvocal_ready": True,
                                      "leadvocal_script": "deadbeefdeadbeef"})
    assert stemsplit._satellite_lead_devices(
        REPO / "scripts" / "leadvocal" / "detect.py") == []


def test_a_satellite_without_the_venv_is_refused(monkeypatch):
    monkeypatch.setattr("vocalis.runtime.pool.default_devices", lambda sub: [SAT])
    monkeypatch.setattr("vocalis.runtime.satellites.health",
                        lambda name: {"reachable": True, "leadvocal_ready": False,
                                      "leadvocal_script": ""})
    assert stemsplit._satellite_lead_devices(
        REPO / "scripts" / "leadvocal" / "detect.py") == []


def test_a_healthy_matching_satellite_is_asked_for_its_free_vram(monkeypatch):
    asked = {}

    class _C:
        def vram(self, card):
            asked["card"] = card
            return {"free_gb": 19.5}

    monkeypatch.setattr("vocalis.runtime.pool.default_devices", lambda sub: [SAT])
    monkeypatch.setattr("vocalis.runtime.satellites.health",
                        lambda name: {"reachable": True, "leadvocal_ready": True,
                                      "leadvocal_script": sat_lv.script_sha()})
    monkeypatch.setattr("vocalis.runtime.satellites.client_for", lambda name: _C())
    got = stemsplit._satellite_lead_devices(REPO / "scripts" / "leadvocal" / "detect.py")
    assert got == [{"device": SAT, "free_gb": 19.5, "ok": True}]
    assert asked["card"] == "cuda:0"          # the satellite's local card identifier


def test_a_satellite_may_be_authorized_for_stems_but_never_for_demucs_only_subsystems():
    """8.6 widened a satellite's capability because what it can do genuinely changed. It must
    not have widened to VoxCPM2, RVC or ACE-Step, none of which exist over there."""
    caps = subsystems.capable(SAT)
    assert subsystems.STEMS in caps and subsystems.RENDER in caps
    assert subsystems.TRAINING not in caps and subsystems.VOICECREATE not in caps
    assert subsystems.SWAP not in caps and subsystems.ACESTEP not in caps
    assert set(subsystems.capable("cuda:0")) == set(subsystems.KEYS)


# ── the satellite's own housekeeping ─────────────────────────────────────────

def test_stale_scratch_is_swept_but_a_live_one_is_left_alone(monkeypatch, tmp_path):
    """🔴 A `finally` cannot run in a process that was KILLED, and a hand-run desktop process
    is closed rather than stopped. That is exactly how 34 GB accumulated on this machine."""
    monkeypatch.setattr(sat_lv, "WORK_ROOT", tmp_path)
    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir(), new.mkdir()
    import os
    ancient = time.time() - sat_lv.STALE_AFTER_S - 60
    os.utime(old, (ancient, ancient))
    assert sat_lv.sweep_stale() == 1
    assert not old.exists() and new.exists()


def test_sweeping_an_absent_root_is_not_an_error(monkeypatch, tmp_path):
    monkeypatch.setattr(sat_lv, "WORK_ROOT", tmp_path / "never-made")
    assert sat_lv.sweep_stale() == 0


def test_the_device_the_child_actually_used_is_read_off_its_own_output():
    """🔴 Asking for a card is not getting one, and the two halves can legitimately land on
    different devices — so this reports what happened rather than what was requested."""
    out = ("[leadvocal] UVR_MDXNET_KARA_2.onnx: torch on cuda:0, onnx providers ['CUDA…']\n"
           "[leadvocal] UVR-DeEcho-DeReverb.pth: torch on cuda:0, onnx providers ['CUDA…']\n")
    assert sat_lv._child_device(out) == "cuda:0"
    mixed = ("[leadvocal] a: torch on cpu, onnx providers ['CPU']\n"
             "[leadvocal] b: torch on cuda:0, onnx providers ['CPU']\n")
    assert sat_lv._child_device(mixed) == "cpu, cuda:0"
    assert sat_lv._child_device("") == ""


def test_running_without_the_venv_is_a_refusal_not_a_crash(monkeypatch, tmp_path):
    """remote host answers every refusal the same way — run it here — so this must be the typed error
    the router catches, never an arbitrary exception out of a subprocess call."""
    monkeypatch.setattr(sat_lv, "venv_python", lambda cfg=None: tmp_path / "no" / "python")
    with pytest.raises(sat_lv.LeadVocalError):
        sat_lv.run(b"RIFF", device="cpu", dereverb=False, karaoke_model="", dereverb_model="")


def test_a_card_that_lost_its_room_since_the_probe_is_refused(monkeypatch, tmp_path):
    """The backstop for the window between `/satellite/vram` and the work landing. Something
    else on a DESKTOP can claim the card in that gap — that is the normal case, not an attack."""
    monkeypatch.setattr(sat_lv, "installed", lambda cfg=None: True)
    with pytest.raises(sat_lv.LeadVocalError) as exc:
        sat_lv.run(b"RIFF", device="cuda:0", dereverb=True, karaoke_model="", dereverb_model="",
                   free_gb=lambda dev: 0.5)
    assert "0.5" in str(exc.value)


def test_canceling_an_unknown_request_is_false_not_an_error():
    assert sat_lv.cancel("nothing-is-running-under-this") is False


def test_a_registered_child_can_be_canceled(monkeypatch):
    class _P:
        killed = False

        def kill(self):
            _P.killed = True

    with sat_lv._LOCK:
        sat_lv._RUNNING["rid"] = _P()
    try:
        assert sat_lv.running() == 1
        assert sat_lv.cancel("rid") is True
        assert _P.killed
    finally:
        with sat_lv._LOCK:
            sat_lv._RUNNING.pop("rid", None)


def _cfg():
    """The smallest StemConfig `_local_lead_device` reads. It touches only `leadvocal_device`
    on this path, so building a whole one would be noise."""
    class _C:
        leadvocal_device = "auto"
        leadvocal_detect = REPO / "scripts" / "leadvocal" / "detect.py"
    return _C()


# ── 8.6.2: the resident separator ────────────────────────────────────────────

def test_the_worker_is_released_when_the_queue_says_it_is_the_last_song(monkeypatch, tmp_path):
    """🔴 THE VRAM COMES BACK. A warm separator holds ~1.9 GB on the worker host, so "keep it
    loaded" is only defensible if letting go is automatic. The release sits in `run`'s `finally`,
    so a failed or canceled last song frees it too — remote host says whether more are coming, it does
    not have to remember to clean up after a job that went wrong."""
    stopped = []
    monkeypatch.setattr(sat_lv, "installed", lambda cfg=None: True)
    monkeypatch.setattr(sat_lv, "_worker_stop", lambda why="": stopped.append(why))
    monkeypatch.setattr(sat_lv, "_run_on_worker",
                        lambda job, device, cfg, rid: (_touch(job), "ran")[1])
    monkeypatch.setattr(sat_lv, "WORK_ROOT", tmp_path)

    sat_lv.run(b"RIFF", device="cpu", dereverb=False, karaoke_model="", dereverb_model="",
               request_id="r1", keep_warm=True)
    assert stopped == [], "a queue with songs left must keep the separator loaded"

    sat_lv.run(b"RIFF", device="cpu", dereverb=False, karaoke_model="", dereverb_model="",
               request_id="r2", keep_warm=False)
    assert len(stopped) == 1, "the last song of a queue must release the separator"


def test_a_failed_last_song_still_releases_the_worker(monkeypatch, tmp_path):
    stopped = []
    monkeypatch.setattr(sat_lv, "installed", lambda cfg=None: True)
    monkeypatch.setattr(sat_lv, "_worker_stop", lambda why="": stopped.append(why))
    monkeypatch.setattr(sat_lv, "WORK_ROOT", tmp_path)

    def _boom(job, device, cfg, rid):
        raise sat_lv.LeadVocalError("the separator refused it")

    monkeypatch.setattr(sat_lv, "_run_on_worker", _boom)
    with pytest.raises(sat_lv.LeadVocalError):
        sat_lv.run(b"RIFF", device="cpu", dereverb=False, karaoke_model="", dereverb_model="",
                   request_id="r3", keep_warm=False)
    assert stopped, "a job that failed on the last song still has to give the VRAM back"


def test_an_idle_worker_is_reaped(monkeypatch):
    """The backstop handles a browser closed mid-run, a crash, or a cancel that never completes.
    Explicit release is the normal path; this stops an abandoned worker from retaining VRAM."""
    stopped = []
    monkeypatch.setattr(sat_lv, "_worker_stop", lambda why="": stopped.append(why))
    sat_lv._WORKER.update(proc=object(), device="cuda:0", work=None,
                          last=time.time() - sat_lv.IDLE_RELEASE_S - 1)
    try:
        sat_lv._reap_idle()
        assert stopped, "an idle worker was not released"
        stopped.clear()
        sat_lv._WORKER.update(proc=object(), last=time.time())
        sat_lv._reap_idle()
        assert not stopped, "a worker used a moment ago must not be reaped"
    finally:
        sat_lv._WORKER.update(proc=None, device=None, work=None, last=0.0)


def test_keep_warm_absent_reads_as_the_last_song():
    """An older remote host sends no `keep_warm`. Absent must mean RELEASE: being wrong that way costs
    one model reload, and being wrong the other way pins VRAM on somebody's desktop."""
    import inspect
    sig = inspect.signature(sat_lv.run)
    assert sig.parameters["keep_warm"].default is False


def _touch(job):
    """The worker's side effect the caller checks for — it writes the backing stem."""
    Path(job["karaoke_out"]).write_bytes(b"RIFFfake")

# ── worker_pids() must never block behind a lead-vocal job ──
#
# 🔴 `worker_pids()` used to take `_WORKER_LOCK`, which `_run_on_worker` holds across a WHOLE
# song separation. gpustats' housekeeping thread (which also prints "stats polling stopped")
# reads it, so it blocked for the length of a job and the worker's VRAM went uncounted exactly
# while it worked. It is lock-free now; see its own comment.

class _FakeWorkerProc:
    """Just enough of `subprocess.Popen` for `worker_pids()`: a fixed `pid` and a `poll()` that
    reports "still running" (`None`) until told otherwise — no real process involved."""

    def __init__(self, pid):
        self.pid = pid
        self.exited = False

    def poll(self):
        return None if not self.exited else 0


def test_worker_pids_returns_while_the_lock_is_held_by_another_thread():
    """🔴 THE FIX, proved directly. A real thread holds `_WORKER_LOCK` indefinitely — released
    only when this test says so via `release_lock`, not a sleep — and `worker_pids()` must
    still answer promptly. Before the fix this call took the same lock and the `join` below
    would have had to wait for `release_lock`, exactly the block a whole lead-vocal job would
    otherwise impose on the housekeeping thread."""
    lock_held = threading.Event()
    release_lock = threading.Event()

    def _hold_lock():
        with sat_lv._WORKER_LOCK:
            lock_held.set()
            release_lock.wait(timeout=5.0)

    holder = threading.Thread(target=_hold_lock, name="lock-holder")
    holder.start()
    try:
        assert lock_held.wait(timeout=2.0), "the holder thread never took the lock"

        sat_lv._WORKER.update(proc=_FakeWorkerProc(4321), device="cuda:0", work=None,
                              last=time.time())
        started = time.monotonic()
        got = sat_lv.worker_pids()
        took_s = time.monotonic() - started
        assert got == [4321], "the PID must still be reported while the lock is held elsewhere"
        assert took_s < 1.0, (
            f"worker_pids() took {took_s:.3f}s while _WORKER_LOCK was held by another thread — "
            f"it is still taking that lock, which blocks the housekeeping thread for a whole "
            f"lead-vocal job")
    finally:
        release_lock.set()
        holder.join(timeout=2.0)
        assert not holder.is_alive(), "the lock-holder thread never finished"
        sat_lv._WORKER.update(proc=None, device=None, work=None, last=0.0)


def test_worker_pids_is_empty_when_the_process_has_exited():
    """`poll()` returning non-None means the child is gone — the PID must not be reported as
    resident (it would over-count `vocalis_gb` for a process that no longer holds any VRAM)."""
    proc = _FakeWorkerProc(9999)
    proc.exited = True
    sat_lv._WORKER.update(proc=proc, device="cuda:0", work=None, last=time.time())
    try:
        assert sat_lv.worker_pids() == []
    finally:
        sat_lv._WORKER.update(proc=None, device=None, work=None, last=0.0)


def test_worker_pids_is_empty_when_there_is_no_worker():
    sat_lv._WORKER.update(proc=None, device=None, work=None, last=0.0)
    assert sat_lv.worker_pids() == []

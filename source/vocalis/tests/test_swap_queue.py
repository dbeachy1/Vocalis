"""Tests for the persistent swap queue (swap_queue.py, 4.3-m3).

Pure data + persistence — no Flask, no swaps run here. The runner that drives it (validate →
launch → mark) is exercised through the routes in test_voiceswap.py."""
import swap_queue


def _req(song="acestep/a.mp3", voice="test_voice_1", **kw):
    r = {"song": song, "voice": voice, "pitch": 0, "index_rate": 0.5,
         "vocal_gain": 1.0, "backing_gain": 1.0, "rms_mix_rate": 0.25,
         "clean_up": True, "device": "auto"}
    r.update(kw)
    return r


def test_add_is_ordered_pending_and_never_runs(tmp_path):
    q = swap_queue.SwapQueue(tmp_path / "q.yaml")
    assert q.running is False
    a = q.add(_req(song="acestep/a.mp3"), "a → test_voice_1", audio_s=60)
    q.add(_req(song="acestep/b.mp3"), "b → test_voice_1", audio_s=90)
    assert [e["label"] for e in q.list()] == ["a → test_voice_1", "b → test_voice_1"]
    assert all(e["status"] == "pending" for e in q.list())
    assert q.running is False                        # 🔴 adding NEVER starts anything (§5.1)
    assert q.next_pending()["id"] == a["id"]         # oldest pending first
    assert set(a["req"]) == set(swap_queue.REQ_FIELDS)   # only the request fields are stored


def test_to_front_remove_and_clear(tmp_path):
    q = swap_queue.SwapQueue(tmp_path / "q.yaml")
    a = q.add(_req(), "a", audio_s=1)
    q.add(_req(), "b", audio_s=1)
    c = q.add(_req(), "c", audio_s=1)
    assert q.to_front(c["id"]) is True
    assert [e["label"] for e in q.list()] == ["c", "a", "b"]
    assert q.remove(a["id"]) is True and q.remove("nope") is False
    assert [e["label"] for e in q.list()] == ["c", "b"]
    assert q.clear() == 2 and q.list() == []


def test_to_front_lands_after_a_running_job(tmp_path):
    q = swap_queue.SwapQueue(tmp_path / "q.yaml")
    a = q.add(_req(), "a", audio_s=1)
    q.add(_req(), "b", audio_s=1)
    c = q.add(_req(), "c", audio_s=1)
    q.mark(a["id"], "running", job_id="x")
    assert q.to_front(c["id"]) is True
    assert [e["label"] for e in q.list()] == ["a", "c", "b"]   # genuinely NEXT, behind the runner
    assert q.to_front(a["id"]) is False              # a running job isn't pending — can't jump


def test_mark_done_drains_failed_stays_visible(tmp_path):
    q = swap_queue.SwapQueue(tmp_path / "q.yaml")
    a = q.add(_req(), "a", audio_s=1)
    b = q.add(_req(), "b", audio_s=1)
    q.mark(a["id"], "done", result="Song__test_voice_1_ab12cd34")
    assert [e["label"] for e in q.list()] == ["b"]   # done leaves the queue (it's in the library)
    q.mark(b["id"], "failed", error="boom")
    row = q.list()[0]
    assert row["status"] == "failed" and row["error"] == "boom"
    assert q.has_pending() is False and q.next_pending() is None   # a failed one isn't pending
    assert q.clear() == 1                            # clear drops the failed one too


def test_persist_reopens_stopped_with_the_interrupted_job_reset(tmp_path):
    """§5.3: the queue survives a restart, comes up STOPPED, and the one job that was in flight
    (its swap died with the process) is reset to pending so ▶ Run re-runs it."""
    p = tmp_path / "q.yaml"
    q = swap_queue.SwapQueue(p)
    a = q.add(_req(), "a", audio_s=1)
    q.add(_req(), "b", audio_s=1)
    q.mark(a["id"], "running", job_id="deadbeefcafe")
    q.set_running(True)                              # 'running' is never persisted True

    q2 = swap_queue.SwapQueue(p)                     # a fresh process reads the same file
    assert q2.running is False
    got = {e["label"]: e for e in q2.list()}
    assert got["a"]["status"] == "pending" and got["a"]["job_id"] == ""
    assert got["b"]["status"] == "pending"
    assert q2.next_pending()["label"] == "a"        # order preserved


def test_a_corrupt_or_missing_file_starts_empty(tmp_path):
    assert swap_queue.SwapQueue(tmp_path / "missing.yaml").list() == []
    bad = tmp_path / "bad.yaml"
    bad.write_text("{: not valid yaml", encoding="utf-8")
    q = swap_queue.SwapQueue(bad)
    assert q.list() == [] and q.running is False

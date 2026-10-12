"""Two concurrent requests for one scene must resolve to a single enhancement job."""
import threading
import time
from pathlib import Path
import sys

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import scene_enhance                                       # noqa: E402
import scenes                                              # noqa: E402
from vocalis.web.clips import create_clips_blueprint       # noqa: E402


@pytest.fixture
def app(tmp_path, monkeypatch):
    import book_to_audio
    import vocalis.web.clips as clips_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", tmp_path / "output")
    a = Flask(__name__)
    a.register_blueprint(create_clips_blueprint())
    return a


@pytest.fixture
def root(tmp_path):
    r = scenes.scenes_root(tmp_path / "output")
    r.mkdir(parents=True, exist_ok=True)
    return r


@pytest.fixture(autouse=True)
def _clean_gate_and_jobs():
    from vocalis.runtime.gpu import GPUS
    scene_enhance.JOBS.clear()
    yield
    for d in list(getattr(GPUS, "_cards", ())):
        GPUS.release_card(d)
    scene_enhance.JOBS.clear()


def test_two_simultaneous_clicks_start_ONE_enhancement(app, root, monkeypatch):
    """🔴 Two cards, two threads, one scene. Exactly one 202 and one 409.

    Widened deliberately: `bandwidth_of` sleeps, standing in for the ffmpeg probe the real one
    runs. The race does not need the sleep — `claim_card` plus the job construction is already a
    window — but without it the test passes or fails on thread scheduling and proves nothing
    either way.
    """
    from vocalis.runtime import enhancement
    import enhance

    monkeypatch.setattr(enhancement, "enhance_available", lambda: True)
    monkeypatch.setattr(enhancement, "enhance_cards", lambda: ["cuda:0", "cuda:1"])
    monkeypatch.setattr(enhance, "is_band_limited", lambda hz: True)
    monkeypatch.setattr(enhance, "estimate_seconds", lambda dur, nfe: 148.1)

    def slow_probe(mp3, meta):
        time.sleep(0.25)
        return 11000, True

    monkeypatch.setattr(enhance, "bandwidth_of", slow_probe)

    # The job must stay ACTIVE for the length of the test, so a second request that got past the
    # guard is still visible as a second job. Nothing here touches a card or a file.
    monkeypatch.setattr(scene_enhance, "run_enhance",
                        lambda job, **kw: time.sleep(2.0))

    (root / "ferry_ab12cd34.mp3").write_bytes(b"ID3 fake audio")
    scenes.write_manifest(root / "ferry_ab12cd34.yaml",
                          {"title": "The ferry", "entries": [], "total_duration_s": 60.0})

    codes, lock, go = [], threading.Lock(), threading.Barrier(2)

    def click():
        go.wait(5)
        r = app.test_client().post("/clips/scenes/ferry_ab12cd34/enhance", json={})
        with lock:
            codes.append(r.status_code)

    threads = [threading.Thread(target=click, name=f"click-{i}") for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)

    started = [j for j in scene_enhance.JOBS.values() if j.status in scene_enhance.ACTIVE]
    assert sorted(codes) == [202, 409], (
        f"both clicks were accepted ({codes}) — two enhancements of one scene, on two cards, "
        f"racing for one twin path. Jobs registered: {[(j.id, j.device) for j in started]}")
    assert len(started) == 1, f"two jobs are live for one scene: {[j.id for j in started]}"

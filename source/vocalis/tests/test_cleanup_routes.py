"""The /cleanup/* routes and the training-clip enhance route — thin wiring over cleanup.py.

Hermetic: no child process runs, and NOTHING reads the host — denoiser availability is pinned
via _cleanup_cfg, so a test's verdict is a property of the test, not of whether this box happens
to have ~/dfn-venv (the same "the suite must not read the host" rule enhance follows).
"""
import pytest

import speech_sources
import vocalis_server as vs
from vocalis.runtime import configs as rt_configs
import vocalis.runtime.paths as rt_paths


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def _pin_cleanup(monkeypatch, tmp_path):
    cfg = vs.cleanup.CleanupConfig(
        denoise_python=tmp_path / "absent" / "python",              # denoise unavailable
        denoise_script=tmp_path / "absent.py",
        trim_script=rt_paths.BASE_DIR / "scripts" / "cleanup" / "trim_audio.py",  # trim available
        scratch=tmp_path / "scratch")
    monkeypatch.setattr(rt_configs, "cleanup_cfg", lambda: cfg)
    monkeypatch.setattr(vs.cleanup, "measured", lambda *a, **k: None)   # untimed box


def test_info_reports_pass_availability_and_no_rate(client):
    d = client.get("/cleanup/info").get_json()
    assert d["trim_available"] is True and d["denoise_available"] is False
    assert d["rate"] is None and "default" in d
    # 4.4-m3: the fixture pins a cfg with no trim scorer venv, so the torch upgrade reads absent
    # and the client stays on the SNR-only MVP (no music veto slider).
    assert d["trim_scorer_available"] is False
    assert "environment is unavailable" in d["trim_scorer_unavailable_reason"]


def test_score_404_on_unknown_clip(client):
    assert client.post("/cleanup/score", json={"ref": "no_such.wav"}).status_code == 404


def test_score_400_when_scorer_absent(client, monkeypatch, tmp_path):
    # a real clip, but the pinned cfg has no trim scorer venv → 400, not a hang or a 500.
    monkeypatch.setattr(speech_sources, "source_path",
                        lambda cfg, ref: tmp_path / "x.wav")
    r = client.post("/cleanup/score", json={"ref": "x.wav"})
    assert r.status_code == 400 and "trim scorer" in r.get_json()["error"]


def test_poll_and_cancel_404_on_unknown_job(client):
    assert client.get("/cleanup/deadbeef0000").status_code == 404
    assert client.post("/cleanup/deadbeef0000/cancel").status_code == 404


def test_analyze_404_on_unknown_clip(client):
    assert client.post("/cleanup/analyze", json={"ref": "no_such.wav"}).status_code == 404


def test_run_404_on_unknown_clip(client):
    assert client.post("/cleanup/run",
                       json={"ref": "no_such.wav", "denoise": {"enabled": True}}
                       ).status_code == 404


def test_preview_400_when_denoiser_absent(client):
    assert client.post("/cleanup/preview", json={"ref": "x.wav"}).status_code == 400


def test_train_source_enhance_400_when_enhance_unavailable(client):
    # conftest pins enhance_available() False for every test that doesn't opt in.
    assert client.post("/train/sources/x.wav/enhance", json={}).status_code == 400

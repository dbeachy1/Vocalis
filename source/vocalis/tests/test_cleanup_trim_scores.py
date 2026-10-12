"""Pure reduction-helper tests for `scripts/cleanup/trim_scores.py`.

Model-quality evaluation is separate. These tests pin the NumPy/stdlib mapping from the tagger's
527 AudioSet classes to the two scores consumed by `cleanup.py`; a classification error can make
the scorer retain music or sound effects. Torch loads inside `main()`, so helper imports stay light.
"""
import sys
import os
import json
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "cleanup"))

import trim_scores as ts  # noqa: E402


# ── keyword_indices: the 527-class → music/SFX vs speech bridge ───────────────

FAKE_LABELS = ["Speech", "Music", "Electric guitar", "Silence", "Explosion",
               "Narration, monologue", "Dog", "Inside, small room"]


def test_keyword_indices_matches_music_and_sfx_substrings():
    idx = ts.keyword_indices(FAKE_LABELS, ts.MUSIC_SFX_KEYWORDS)
    got = {FAKE_LABELS[i] for i in idx}
    assert "Music" in got and "Electric guitar" in got and "Explosion" in got
    assert "Speech" not in got and "Dog" not in got     # neither is music/SFX


def test_keyword_indices_matches_speech_variants():
    idx = ts.keyword_indices(FAKE_LABELS, ts.SPEECH_KEYWORDS)
    got = {FAKE_LABELS[i] for i in idx}
    assert "Speech" in got and "Narration, monologue" in got
    assert "Music" not in got


def test_keyword_indices_is_case_insensitive_and_empty_safe():
    assert ts.keyword_indices(["GUITAR SOLO"], ("guitar",)) == [0]
    assert ts.keyword_indices([], ts.MUSIC_SFX_KEYWORDS) == []


# ── reduce_window: 527 probs → {speech, music_sfx, top} ───────────────────────

def test_reduce_window_takes_the_peak_of_each_group():
    labels = ["Speech", "Music", "Guitar"]
    probs = np.array([0.10, 0.70, 0.40])
    music_idx = ts.keyword_indices(labels, ts.MUSIC_SFX_KEYWORDS)   # Music, Guitar
    speech_idx = ts.keyword_indices(labels, ts.SPEECH_KEYWORDS)     # Speech
    rec = ts.reduce_window(probs, music_idx, speech_idx, labels, topk=2)
    assert rec["music_sfx"] == 0.70          # peak over {Music, Guitar}
    assert rec["speech"] == 0.10
    assert rec["top"][0] == ["Music", 0.7]   # highest-prob label first
    assert len(rec["top"]) == 2


def test_reduce_window_zeroes_a_missing_group():
    labels = ["Dog", "Cat"]                  # neither music/SFX nor speech
    rec = ts.reduce_window(np.array([0.9, 0.1]), [], [], labels)
    assert rec["music_sfx"] == 0.0 and rec["speech"] == 0.0


# ── window_starts: no tail is silently dropped ────────────────────────────────

def test_window_starts_covers_the_tail():
    # 2.5 windows of audio → 3 starts, the last a partial the caller zero-pads.
    starts = ts.window_starts(n_samples=250, win=100, hop=100)
    assert starts == [0, 100, 200]


def test_window_starts_empty_and_degenerate():
    assert ts.window_starts(0, 100, 100) == []
    assert ts.window_starts(50, 100, 100) == [0]      # shorter than one window → one start


def _write_labels(path, *, header="index,mid,display_name", count=527):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(header + "\n" + "".join(f"{i},/m/{i},Class {i}\n" for i in range(count)),
                    encoding="utf-8")


def _reject_model_imports(monkeypatch, tmp_path):
    original_import = __import__

    def reject_panns(name, *args, **kwargs):
        if name == "panns_inference":
            raise AssertionError("PANNs must not be imported before local inputs validate")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", reject_panns)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    monkeypatch.setattr(ts.os, "system", lambda *_: (_ for _ in ()).throw(
        AssertionError("Trim must not invoke a downloader")))


def test_main_rejects_missing_local_checkpoint_before_model_import(tmp_path, monkeypatch, capsys):
    source = tmp_path / "input.wav"
    source.touch()
    model_root = tmp_path / "model"
    labels = model_root / "class_labels_indices.csv"
    _write_labels(labels)
    monkeypatch.setattr(sys, "argv", ["trim_scores.py", "-i", str(source), "-o",
                                       str(tmp_path / "scores.json"), "--checkpoint",
                                       str(model_root / ts.PANNS_CHECKPOINT_FILE), "--labels", str(labels)])
    _reject_model_imports(monkeypatch, tmp_path)
    assert ts.main() == 2
    assert "Trim scorer checkpoint is missing" in capsys.readouterr().err
    assert not (tmp_path / "home" / "panns_data").exists()


def test_main_rejects_truncated_checkpoint_before_model_import(tmp_path, monkeypatch, capsys):
    source = tmp_path / "input.wav"
    source.touch()
    model_root = tmp_path / "model"
    checkpoint = model_root / ts.PANNS_CHECKPOINT_FILE
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"small")
    labels = model_root / "class_labels_indices.csv"
    _write_labels(labels)
    monkeypatch.setattr(ts, "PANNS_CHECKPOINT_BYTES", len(b"small") + 1)
    monkeypatch.setattr(sys, "argv", ["trim_scores.py", "-i", str(source), "-o",
                                       str(tmp_path / "scores.json"), "--checkpoint", str(checkpoint),
                                       "--labels", str(labels)])
    _reject_model_imports(monkeypatch, tmp_path)
    assert ts.main() == 2
    assert "invalid size" in capsys.readouterr().err


def test_main_rejects_incompatible_labels_before_model_import(tmp_path, monkeypatch, capsys):
    source = tmp_path / "input.wav"
    source.touch()
    model_root = tmp_path / "model"
    checkpoint = model_root / ts.PANNS_CHECKPOINT_FILE
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"checkpoint")
    labels = model_root / "class_labels_indices.csv"
    _write_labels(labels, header="wrong,header,here")
    monkeypatch.setattr(ts, "PANNS_CHECKPOINT_BYTES", len(b"checkpoint"))
    monkeypatch.setattr(sys, "argv", ["trim_scores.py", "-i", str(source), "-o",
                                       str(tmp_path / "scores.json"), "--checkpoint", str(checkpoint),
                                       "--labels", str(labels)])
    _reject_model_imports(monkeypatch, tmp_path)
    assert ts.main() == 2
    assert "incompatible header" in capsys.readouterr().err


def test_main_rejects_missing_labels_before_model_import(tmp_path, monkeypatch, capsys):
    source = tmp_path / "input.wav"
    source.touch()
    model_root = tmp_path / "model"
    checkpoint = model_root / ts.PANNS_CHECKPOINT_FILE
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"checkpoint")
    monkeypatch.setattr(ts, "PANNS_CHECKPOINT_BYTES", len(b"checkpoint"))
    labels = model_root / "class_labels_indices.csv"
    monkeypatch.setattr(sys, "argv", ["trim_scores.py", "-i", str(source), "-o",
                                       str(tmp_path / "scores.json"), "--checkpoint", str(checkpoint),
                                       "--labels", str(labels)])
    _reject_model_imports(monkeypatch, tmp_path)
    assert ts.main() == 2
    assert "AudioSet labels are missing" in capsys.readouterr().err
    assert not (tmp_path / "home" / "panns_data").exists()


def test_main_passes_the_explicit_local_checkpoint_and_keeps_score_output(tmp_path, monkeypatch):
    source = tmp_path / "input.wav"
    source.touch()
    model_root = tmp_path / "models"
    checkpoint = model_root / ts.PANNS_CHECKPOINT_FILE
    checkpoint.parent.mkdir()
    checkpoint.write_bytes(b"checkpoint")
    labels_path = model_root / "class_labels_indices.csv"
    _write_labels(labels_path)
    monkeypatch.setattr(ts, "PANNS_CHECKPOINT_BYTES", len(b"checkpoint"))
    monkeypatch.setenv("VOCALIS_TRIM_MODEL_ROOT", "test-previous-root")
    output = tmp_path / "scores.json"
    monkeypatch.setattr(sys, "argv", ["trim_scores.py", "-i", str(source), "-o",
                                       str(output), "--checkpoint", str(checkpoint),
                                       "--labels", str(labels_path)])

    class Tensor:
        def __init__(self, values):
            self.values = np.asarray(values)
            self.shape = self.values.shape

        def detach(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return self.values

    labels = ["Speech", "Music"] + [f"Class {i}" for i in range(525)]
    constructor_calls = []

    class FakeTagger:
        def __init__(self, *, checkpoint_path, device):
            constructor_calls.append((checkpoint_path, device))

        def inference(self, batch):
            scores = np.zeros((len(batch), len(labels)), dtype=np.float32)
            scores[:, 0] = 0.4
            scores[:, 1] = 0.75
            return scores, None

    sf = types.ModuleType("soundfile")
    sf.read = lambda *args, **kwargs: (np.zeros((32000, 1), dtype=np.float32), 32000)
    torch = types.ModuleType("torch")
    torch.from_numpy = lambda values: Tensor(values)
    torchaudio = types.ModuleType("torchaudio")
    torchaudio.functional = types.SimpleNamespace(
        resample=lambda tensor, orig, target: Tensor(
            tensor.values[::max(1, int(orig / target))]))
    silero = types.ModuleType("silero_vad")
    silero.load_silero_vad = lambda: object()
    silero.get_speech_timestamps = lambda *args, **kwargs: [{"start": 0.0, "end": 0.5}]
    panns = types.ModuleType("panns_inference")
    panns.__path__ = []
    panns.AudioTagging = FakeTagger
    panns_config = types.ModuleType("panns_inference.config")
    panns_config.labels = labels
    for name, module in (("soundfile", sf), ("torch", torch), ("torchaudio", torchaudio),
                         ("silero_vad", silero), ("panns_inference", panns),
                         ("panns_inference.config", panns_config)):
        monkeypatch.setitem(sys.modules, name, module)

    assert ts.main() == 0
    assert constructor_calls == [(str(checkpoint), "cpu")]
    assert os.environ["VOCALIS_TRIM_MODEL_ROOT"] == str(model_root.resolve())
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["schema"] == "vocalis.trim_scores/1"
    assert payload["tagger"]["windows"][0]["music_sfx"] == 0.75
    assert payload["vad"]["segments"] == [[0.0, 0.5]]

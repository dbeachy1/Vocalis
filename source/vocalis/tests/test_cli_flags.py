"""Smoke tests that the 2.0-M2 pool flags are wired into both CLI entrypoints.

Guards against the args being dropped/renamed: runs each entrypoint's --help
(which exits before any model load) and checks the flags appear.
"""
import subprocess
import sys

from conftest import REPO_ROOT

SRC = REPO_ROOT / "src"
PYTHON = sys.executable


def _help_text(script):
    r = subprocess.run([PYTHON, str(SRC / script), "--help"],
                       cwd=str(SRC), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert r.returncode == 0, r.stderr
    return r.stdout + r.stderr


def test_generate_exposes_pool_flags():
    h = _help_text("generate.py")
    assert "--gpus" in h
    assert "--workers" in h


def test_book_to_audio_exposes_pool_flags():
    h = _help_text("book_to_audio.py")
    assert "--gpus" in h
    assert "--workers" in h
    assert "--seed" not in h        # seeds removed app-wide (3.x)

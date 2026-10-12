"""`vocalis.env` — the one file systemd and the hand-run tools both read.

The per-instance paths (VOCALIS_CACHE_DIR / SCRATCH_DIR / APPLIO_DIR) used to live only as
`Environment=` lines in the systemd unit. A shell does not inherit those, so a maintenance tool
run by hand could use `$HOME` defaults and target another install's cache. Loading this file
gives the server and maintenance tools the same per-instance paths; these tests protect that
contract.
"""
import os

import pytest

from tts_utils import ENV_FILE_NAME, load_env_file


def _write(root, text):
    (root / ENV_FILE_NAME).write_text(text, encoding="utf-8")


def test_loads_keys_into_the_environment(tmp_path, monkeypatch):
    monkeypatch.delenv("VOCALIS_CACHE_DIR", raising=False)
    _write(tmp_path, "VOCALIS_CACHE_DIR=/tmp/cache-a\n")

    path, applied = load_env_file(tmp_path)

    assert path == tmp_path / ENV_FILE_NAME
    assert applied == {"VOCALIS_CACHE_DIR": "/tmp/cache-a"}
    assert os.environ["VOCALIS_CACHE_DIR"] == "/tmp/cache-a"


def test_does_NOT_override_something_already_set(tmp_path, monkeypatch):
    """An explicit export — or systemd's own Environment= — is a decision someone made.
    Silently undoing it would recreate the bug in mirror image."""
    monkeypatch.setenv("VOCALIS_CACHE_DIR", "/tmp/explicit")
    _write(tmp_path, "VOCALIS_CACHE_DIR=/tmp/from-file\n")

    _, applied = load_env_file(tmp_path)

    assert applied == {}
    assert os.environ["VOCALIS_CACHE_DIR"] == "/tmp/explicit"


def test_override_flag_forces_it(tmp_path, monkeypatch):
    monkeypatch.setenv("VOCALIS_CACHE_DIR", "/tmp/explicit")
    _write(tmp_path, "VOCALIS_CACHE_DIR=/tmp/from-file\n")

    _, applied = load_env_file(tmp_path, override=True)

    assert applied == {"VOCALIS_CACHE_DIR": "/tmp/from-file"}
    assert os.environ["VOCALIS_CACHE_DIR"] == "/tmp/from-file"


def test_missing_file_is_not_an_error(tmp_path):
    """A single install with default paths needs no file — matches EnvironmentFile=- in the unit."""
    assert load_env_file(tmp_path) == (None, {})


@pytest.mark.parametrize("line,expected", [
    ("# a comment\nVOCALIS_SCRATCH_DIR=/s\n",        {"VOCALIS_SCRATCH_DIR": "/s"}),
    ("\n\n   \nVOCALIS_SCRATCH_DIR=/s\n",            {"VOCALIS_SCRATCH_DIR": "/s"}),
    ('VOCALIS_SCRATCH_DIR="/s"\n',                   {"VOCALIS_SCRATCH_DIR": "/s"}),
    ("VOCALIS_SCRATCH_DIR='/s'\n",                   {"VOCALIS_SCRATCH_DIR": "/s"}),
    ("  VOCALIS_SCRATCH_DIR = /s  \n",               {"VOCALIS_SCRATCH_DIR": "/s"}),
    ("garbage with no equals sign\n",                {}),
    ("=novalue\n",                                   {}),
])
def test_parses_the_systemd_EnvironmentFile_subset(tmp_path, monkeypatch, line, expected):
    monkeypatch.delenv("VOCALIS_SCRATCH_DIR", raising=False)
    _write(tmp_path, line)

    _, applied = load_env_file(tmp_path)

    assert applied == expected


def test_the_shipped_example_names_all_three_paths():
    """The example is the documentation people actually read. If a variable stops being
    per-instance, or a new one starts, this is where it has to show up."""
    from conftest import REPO_ROOT
    text = (REPO_ROOT / "vocalis.env.example").read_text(encoding="utf-8")
    for var in ("VOCALIS_CACHE_DIR", "VOCALIS_SCRATCH_DIR", "VOCALIS_APPLIO_DIR"):
        assert var in text, f"{var} missing from vocalis.env.example"

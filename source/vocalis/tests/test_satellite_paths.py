"""Mounted satellite paths are explicit inputs; the resolver never creates them."""
import importlib
import sys

import pytest

from conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT / "satellite"))
import vocalis_satellite_paths as paths  # noqa: E402


def test_explicit_paths_resolve_once_and_share_the_leadvocal_work_root(monkeypatch, tmp_path):
    names = {
        "VOCALIS_SATELLITE_CONFIG": tmp_path / "config" / "satellite.yaml",
        "VOCALIS_SATELLITE_CERT_DIR": tmp_path / "certs",
        "VOCALIS_SATELLITE_LOG_DIR": tmp_path / "logs",
        "VOCALIS_SATELLITE_WORK_DIR": tmp_path / "work",
    }
    for name, path in names.items():
        monkeypatch.setenv(name, str(path))
    try:
        configured_paths = importlib.reload(paths)
        assert configured_paths.CONFIG_FILE == names["VOCALIS_SATELLITE_CONFIG"]
        assert configured_paths.CERT_DIR == names["VOCALIS_SATELLITE_CERT_DIR"]
        assert configured_paths.LOG_DIR == names["VOCALIS_SATELLITE_LOG_DIR"]
        assert configured_paths.WORK_DIR == names["VOCALIS_SATELLITE_WORK_DIR"]
        assert configured_paths.LEADVOCAL_WORK_DIR == names["VOCALIS_SATELLITE_WORK_DIR"] / "leadvocal"
        assert not any(path.exists() for path in names.values())
    finally:
        for name in names:
            monkeypatch.delenv(name, raising=False)
        importlib.reload(paths)


@pytest.mark.parametrize("value", ["", "relative/config.yaml"])
def test_config_override_rejects_blank_or_relative_paths(monkeypatch, value):
    monkeypatch.setenv("VOCALIS_SATELLITE_CONFIG", value)
    with pytest.raises(RuntimeError, match="VOCALIS_SATELLITE_CONFIG"):
        paths._path("VOCALIS_SATELLITE_CONFIG", paths.HERE / "satellite.yaml")


def test_explicit_mount_validation_does_not_create_a_directory(tmp_path):
    missing = tmp_path / "missing"
    with pytest.raises(RuntimeError, match="VOCALIS_SATELLITE_WORK_DIR"):
        paths.require_directory(missing, "VOCALIS_SATELLITE_WORK_DIR")
    assert not missing.exists()

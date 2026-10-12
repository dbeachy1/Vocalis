"""Removing a satellite deletes its pinned certificate file (October 10, 2026).

`save_cert` writes `<cert_dir>/<name>.pem`; `remove` used to drop the entry and leave that file in
`data/vocalis/certs` forever, so a satellite added later under the same name found a stale file on
disk. The file is deleted only when it is a regular file directly inside the certificate folder and
no remaining entry pins it; a failure to delete never fails the removal.
"""
from pathlib import Path

import pytest

from vocalis.runtime import satellites as sat


class Log:
    def __init__(self):
        self.info_lines, self.warning_lines = [], []

    def info(self, m):
        self.info_lines.append(m)

    def warning(self, m):
        self.warning_lines.append(m)

    def debug(self, m):
        pass


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A settings store held in a dict, and a certificate folder under tmp_path."""
    certs = tmp_path / "certs"
    certs.mkdir()
    store = {"satellites": []}
    monkeypatch.setattr(sat, "cert_dir", lambda: certs)
    monkeypatch.setattr(sat.settings, "load_app_settings", lambda: dict(store))
    monkeypatch.setattr(sat.settings, "save_app_settings", lambda s: store.update(s))
    log = Log()
    monkeypatch.setattr(sat, "logger", log)
    world = type("World", (), {})()
    world.certs, world.store, world.log, world.tmp = certs, store, log, tmp_path

    def add(name, cert):
        store["satellites"].append({"name": name, "url": f"https://{name}:7880",
                                    "secret": "ab" * 32, "cert": cert})

    world.add = add
    world.names = lambda: [e["name"] for e in store["satellites"]]
    return world


def _pem(path: Path):
    path.write_bytes(b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")
    return path


def test_the_pinned_certificate_file_is_deleted_with_the_satellite(world):
    f = _pem(world.certs / "workstation.pem")
    world.add("workstation", "workstation.pem")
    sat.remove("workstation")
    assert world.names() == [] and not f.exists()
    assert [m for m in world.log.info_lines if "deleted its pinned certificate file workstation.pem" in m]


def test_a_file_another_entry_is_pinned_to_is_kept(world):
    f = _pem(world.certs / "shared.pem")
    world.add("a", "shared.pem")
    world.add("b", "shared.pem")
    sat.remove("a")
    assert world.names() == ["b"] and f.exists()
    assert [m for m in world.log.info_lines if "kept" in m]
    sat.remove("b")
    assert not f.exists(), "the last entry pinned to it takes it with it"


def test_a_cert_path_outside_the_certificate_folder_is_not_deleted(world):
    (world.tmp / "elsewhere").mkdir()
    outside = _pem(world.tmp / "elsewhere" / "other.pem")
    world.add("workstation", str(outside))                       # a hand-edited absolute path
    sat.remove("workstation")
    assert world.names() == [] and outside.exists()


def test_a_relative_dotdot_name_never_leaves_the_folder(world):
    """`_resolve_cert` takes the basename of a relative value, so '../x.pem' means certs/x.pem —
    and a same-named file OUTSIDE the folder is untouched."""
    outside = _pem(world.tmp / "x.pem")
    world.add("workstation", "../x.pem")
    sat.remove("workstation")
    assert outside.exists()


def test_a_missing_file_does_not_raise(world):
    world.add("workstation", "workstation.pem")                         # never written
    sat.remove("workstation")
    assert world.names() == [] and world.log.warning_lines == []


def test_an_entry_with_no_cert_removes_cleanly(world):
    world.add("workstation", None)
    sat.remove("workstation")
    assert world.names() == []


def test_a_symlink_is_left_alone(world):
    target = _pem(world.tmp / "real.pem")
    link = world.certs / "workstation.pem"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlinks need privileges on this machine")
    world.add("workstation", "workstation.pem")
    sat.remove("workstation")
    assert target.exists() and link.is_symlink()


def test_a_delete_failure_is_logged_and_the_entry_is_still_removed(world, monkeypatch):
    f = _pem(world.certs / "workstation.pem")
    world.add("workstation", "workstation.pem")

    def refuse(self, *a, **k):
        raise PermissionError("in use by another process")

    monkeypatch.setattr(Path, "unlink", refuse)
    sat.remove("workstation")
    assert world.names() == [], "the removal does not fail on a file that will not go"
    assert f.exists()
    assert len(world.log.warning_lines) == 1
    assert "PermissionError" in world.log.warning_lines[0]
    assert "in use by another process" in world.log.warning_lines[0]
    assert "workstation.pem" in world.log.warning_lines[0]


def test_removing_an_unknown_name_deletes_nothing(world):
    f = _pem(world.certs / "workstation.pem")
    world.add("workstation", "workstation.pem")
    sat.remove("nobody")
    assert world.names() == ["workstation"] and f.exists()


def test_the_cached_client_is_dropped_by_remove(world):
    sat._clients["workstation"] = (("sig",), object())
    world.add("workstation", None)
    sat.remove("workstation")
    assert "workstation" not in sat._clients

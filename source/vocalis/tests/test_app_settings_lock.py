"""Every writer of `app_settings.yaml` reads it and writes it back inside ONE hold of
`settings.APP_LOCK`.

The file is one YAML document that every writer replaces whole. A writer that reads it, works on
its copy and writes the copy back without the lock undoes whatever another request saved in
between. `PUT /settings/app` has held the lock since 7.2; five other writers did not.

Found 2026-10-12 while removing sleeps from the browser specs: forty copies of
`llm_tick_warn_browser_spec.mjs` run at once ended, twice, with every check green and the
"warn me if an LLM is loaded" switch wrong in the file. `PUT /devices` had read the file at the top
of the request and written it back at the bottom, over the switch that `PUT /settings/app` had
saved in the meantime.

Nothing pinned the rule, which is how five writers came to miss it. The first test here is that
pin: it reads the source, so a sixth writer fails it the day it is written.
"""
import ast
import threading
from pathlib import Path

import pytest
import yaml

import vocalis_server as vs
import vocalis.runtime.gpu as gpu_mod
import vocalis.runtime.satellites as sat_mod
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import paths, subsystems

SRC = Path(paths.BASE_DIR) / "src"


def _is_call_to(node: ast.AST, name: str) -> bool:
    if not isinstance(node, ast.Call):
        return False
    fn = node.func
    return (isinstance(fn, ast.Attribute) and fn.attr == name) or (isinstance(fn, ast.Name) and fn.id == name)


def _holds_the_lock(node: ast.AST) -> bool:
    return isinstance(node, ast.With) and any(
        ast.unparse(item.context_expr).endswith("APP_LOCK") for item in node.items)


def test_every_save_of_the_app_settings_is_read_and_written_under_one_lock():
    writers, bare = 0, []
    for path in sorted(SRC.rglob("*.py")):
        if path.name == "settings.py" and path.parent.name == "runtime":
            continue                                   # the definition itself
        tree = ast.parse(path.read_text(encoding="utf-8"))
        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        for node in ast.walk(tree):
            if not _is_call_to(node, "save_app_settings"):
                continue
            writers += 1
            up = node
            while up in parents and not _holds_the_lock(up):
                up = parents[up]
            where = f"{path.relative_to(SRC).as_posix()}:{node.lineno}"
            if not _holds_the_lock(up):
                bare.append(f"{where} saves without holding APP_LOCK")
            elif not any(_is_call_to(n, "load_app_settings") for n in ast.walk(up)):
                bare.append(f"{where} holds APP_LOCK for the save but read the file before taking it")
    assert writers >= 8, f"only {writers} save_app_settings call(s) found - has the scan broken?"
    assert not bare, (
        "app_settings.yaml is replaced whole on every save, so a writer that reads it outside "
        "the lock undoes any save that lands before its own:\n  " + "\n  ".join(bare))


@pytest.fixture
def settings_file(monkeypatch, tmp_path):
    """Never write the repo's real app_settings.yaml."""
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    return tmp_path / "app_settings.yaml"


@pytest.fixture(autouse=True)
def no_host_cards_and_no_network(monkeypatch):
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [{"index": 0, "name": "Test Card A"}])
    monkeypatch.setattr(sat_mod, "health",
                        lambda name: {"reachable": False, "error": "not running",
                                      "devices": [], "ready": False})


def test_a_device_save_does_not_undo_a_setting_saved_while_it_runs(settings_file, monkeypatch):
    """The device save is stopped in the middle of its work, by an event and not by a clock. While
    it stands there it must be holding the lock, and a warning-switch save started meanwhile must
    end up in the file together with the device change."""
    vs.app.config["TESTING"] = True
    settings_file.write_text(
        yaml.safe_dump({"devices": [{"id": "cuda:0", "enabled": True}]}), encoding="utf-8")
    inside, release, at_lock = threading.Event(), threading.Event(), threading.Event()
    real_clean = subsystems.clean_uses

    def paused_clean(*args, **kwargs):                 # runs between the route's read and its write
        inside.set()
        assert release.wait(60), "the test never released the device save"
        return real_clean(*args, **kwargs)

    monkeypatch.setattr(subsystems, "clean_uses", paused_clean)
    lock = rt_settings.APP_LOCK

    class Watched:
        """The real lock, plus a note of when the warning save arrives at it."""
        def __enter__(self):
            if threading.current_thread().name == "warning-save":
                at_lock.set()
            return lock.__enter__()

        def __exit__(self, *exc):
            return lock.__exit__(*exc)

    monkeypatch.setattr(rt_settings, "APP_LOCK", Watched())
    status = {}

    def device_save():
        status["devices"] = vs.app.test_client().put(
            "/devices", json={"devices": [{"id": "cuda:0", "enabled": False}]}).status_code

    def warning_save():
        status["warning"] = vs.app.test_client().put(
            "/settings/app", json={"devices_warn_llm_loaded": False}).status_code

    first = threading.Thread(target=device_save, name="device-save")
    second = threading.Thread(target=warning_save, name="warning-save")
    first.start()
    try:
        assert inside.wait(60), "the device save never reached its row-building step"
        free = lock.acquire(blocking=False)
        if free:
            lock.release()
        assert not free, ("the device save is between its read of app_settings.yaml and its "
                          "write, and it is not holding APP_LOCK")
        second.start()
        assert at_lock.wait(60), "the warning save never reached the settings lock"
    finally:
        release.set()
        first.join(60)
        if second.ident is not None:
            second.join(60)
    assert not first.is_alive() and not second.is_alive(), "a save is still running"
    assert status == {"devices": 200, "warning": 200}, status
    saved = yaml.safe_load(settings_file.read_text(encoding="utf-8"))
    assert saved["devices"][0]["enabled"] is False, saved
    assert saved.get("devices_warn_llm_loaded") is False, saved


@pytest.mark.parametrize("change", [
    lambda: sat_mod.add("box", "http://127.0.0.1:1"),
    lambda: sat_mod.update("first", url="http://127.0.0.1:2"),
    lambda: sat_mod.regenerate("first"),
    lambda: sat_mod.remove("first"),
], ids=["add", "update", "regenerate", "remove"])
def test_a_satellite_edit_reads_the_list_while_holding_the_lock(settings_file, monkeypatch, change):
    """These four read the satellite list themselves and hand the changed list to `_save`. The
    read has to be inside the lock too, or two edits at once keep only one."""
    settings_file.write_text(yaml.safe_dump({"satellites": [
        {"name": "first", "url": "http://127.0.0.1:9", "cert": None, "secret": "00" * 32}]}),
        encoding="utf-8")
    held = []
    real_load = rt_settings.load_app_settings

    def watched_load():
        held.append(rt_settings.APP_LOCK._is_owned())
        return real_load()

    monkeypatch.setattr(rt_settings, "load_app_settings", watched_load)
    change()
    assert held and all(held), f"the satellite list was read {held.count(False)} time(s) without the lock"

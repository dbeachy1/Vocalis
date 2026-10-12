"""Browser coverage for multi-select deletion in the Stems library. It verifies selection controls and their effect on the displayed sets."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest
import yaml

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import stems

SPEC = Path(__file__).parent / "stems_bulk_browser_spec.mjs"
NODE = shutil.which("node")

#: Four sets, named so the filter check has exactly one match for "Gamma". The refs are pinned
#: because the spec addresses checkboxes by `data-sspick` — keep them in step with the constants
#: at the top of `stems_bulk_browser_spec.mjs`.
SETS = [("Alpha", "a" * 32), ("Beta", "b" * 32), ("Gamma", "c" * 32), ("Delta", "d" * 32)]


def _chrome():
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in ("chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(c)
        if found:
            return found
    for c in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              "/usr/bin/google-chrome", "/usr/bin/chromium"):
        if Path(c).exists():
            return c
    return None



def _seed(root: Path):
    """Four finished 2-stem sets. Placeholder bytes: nothing here plays anything, and the sizes
    only have to be non-zero for the bar's running total to be worth asserting."""
    for name, h in SETS:
        d = root / stems.set_ref(name, h)
        d.mkdir(parents=True)
        for f in stems.MODE_STEMS["2stem"]:
            (d / f).write_bytes(b"RIFF" + b"\0" * 40_000)
        stems.write_meta(d, {"h": h, "song": name, "source": "demucs", "mode": "2stem"})


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_stem_sets_can_be_ticked_and_deleted_together(tmp_path, monkeypatch):
    out = tmp_path / "output"
    stems_dir = out / "stems"
    stems_dir.mkdir(parents=True)
    _seed(stems_dir)

    # The suite must not read the host, and this one deletes: output/ unpatched may be populated
    # render tree and its `stems/` may contain persistent files. `stems_dir` is derived from
    # the output dir rather than taken from an env var of its own, so it is pinned via
    # app_settings — which is what `resolve_config` reads before its default.
    settings = tmp_path / "app_settings.yaml"
    settings.write_text(yaml.safe_dump({"output_dir": str(out)}), encoding="utf-8")
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("VOCALIS_STEM_UPLOADS_DIR", str(tmp_path / "uploads" / "stems"))
    (tmp_path / "uploads" / "stems").mkdir(parents=True)

    import book_to_audio
    import vocalis.runtime.settings as rt_settings
    import vocalis.web.stems as stems_web
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", settings)
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(stems_web, "OUTPUT_DIR", out, raising=False)

    import vocalis.runtime.configs as rt_configs
    import stemsplit
    # 🔴 DOCKER PORT. The Stems routes resolve their config through `configs.ss_cfg()`, which calls
    # `stemsplit.resolve_config` (the legacy page resolved it through `voiceswap.resolve_config`,
    # a path this product's Stems routes no longer take — patching it left the page reading the
    # real, empty stems directory, so no seeded set ever reached the browser). `ss_cfg` also reads
    # `OUTPUT_DIR` from ITS OWN module namespace (`from book_to_audio import OUTPUT_DIR`), a
    # by-value copy that patching `book_to_audio.OUTPUT_DIR` above never reaches, so it is pinned
    # here too — the trap test_server.py's tmp_output fixture documents.
    monkeypatch.setattr(rt_configs, "OUTPUT_DIR", out)
    real = stemsplit.resolve_config

    def _cfg(*a, **k):
        c = real(*a, **k)
        # The one binding the routes actually read. Pinned directly rather than hoped for: the
        # module-level OUTPUT_DIR copies are the trap test_clips_train_browser.py documents.
        c.stems_dir = stems_dir
        c.stem_uploads_dir = tmp_path / "uploads" / "stems"
        return c
    monkeypatch.setattr(stemsplit, "resolve_config", _cfg)
    if hasattr(rt_configs, "_SS_CFG"):
        monkeypatch.setattr(rt_configs, "_SS_CFG", None, raising=False)

    import vocalis_server as vs
    vs.app.config["TESTING"] = False

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, ("the stems multi-delete failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=28)

    # A second opinion, off the filesystem rather than off the route the spec already asked.
    assert sorted(p.name for p in stems_dir.iterdir()) == [], (
        f"sets survived the bulk delete: {sorted(p.name for p in stems_dir.iterdir())}")

    # 🔴 A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("every stem set in the library carries a checkbox",
                  "the bulk bar is hidden while nothing is ticked",
                  "clicking the checkbox does NOT expand the set",
                  "and the box really is ticked",
                  "the bulk bar appears as soon as one is ticked",
                  "clicking the header itself still opens the set",
                  "Clear unticks everything and hides the bar again",
                  "the bar totals what is ticked",
                  "the filter narrows the list",
                  "is NOT still selected — the DOM is the truth",
                  "⇤ Remove from folder is on the stems library toolbar too",
                  "⇥ Move selected here FILES it, and the server agrees",
                  "opening the folder shows the set inside it, checkbox and all",
                  "⇤ Remove from folder takes it back to the root, and the server agrees",
                  "the ticks are CLEARED, so 🗑 Delete selected is not left armed",
                  "removing the folder returns all four sets to the main list",
                  "Select all ticks every visible set",
                  "it asks before deleting four sets",
                  "the confirm names the count and the size",
                  "and enumerates them",
                  "all four sets leave the library",
                  "and it went as ONE request carrying all four refs",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

"""The server must actually START, the way the box starts it. Nothing else in the suite checks.

🔴 THE GAP THIS CLOSES. Five and a half thousand tests build `vocalis_server.app` and serve it
in-process. `vocalis_server.main()` is never executed by any of them — so argument parsing,
`resolve_ssl_context`, `_refuse_to_share_a_root_with_another_instance`, `_sweep_stale_workdirs`,
`run_store_startup_tasks`, `voicetrain.reattach`, the logging setup and the startup banner are
covered by NOTHING. A break in any of them is invisible to a green suite and surfaces as "the
service will not come back up" straight after a deploy, which is the worst moment available.

📌 AND IT IS THE ENTRYPOINT THE UNIT USES. `vocalis.py`, not `src/vocalis_server.py` — running
the module as a script makes it `__main__`, so a later `from vocalis_server import X` re-executes
the whole file under a second name. That can run `vault_store.configure()` twice, installing a
fresh locked store while `/health` reports `locked:false`. `test_setup_configure.py` pins the generated unit's `ExecStart`; this pins that
the thing it points at actually boots.

🔴 WHY IT PLANTS A COPY, AND WHY THAT IS NOT OPTIONAL. `paths.BASE_DIR` is derived from `__file__`
and NO environment variable moves it, so a server started in this checkout writes its `logs/` into
the repo and calls `_sweep_stale_workdirs()` against the test runner's scratch. Planting the
tracked file set into `tmp_path` makes BASE_DIR the temporary root, so every one of those paths
lands in the throwaway tree. 725 files, 15.9 MB — under a second, and the whole test is about
eight.

⚠️ THE COPY IS ONLY HALF OF THE ISOLATION. A spawned process also inherits the ENVIRONMENT, and
conftest pins `VOCALIS_CACHE_DIR` and `VOCALIS_SCRATCH_DIR` that way — one scratch directory per
worker, which `main()` EMPTIES at boot. Those are repointed below, by discovery rather than by
name. See feedback_an_adhoc_script_steps_off_conftests_floor: conftest's pins are a pytest-time
floor, and a subprocess steps off it in two directions at once.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from conftest import REPO_ROOT

import tts_utils

#: Cold start imports torch and probes the cards, so this is generous on purpose. It is a ceiling
#: for a hang, not a performance assertion — a machine that needs more than this has a problem
#: worth failing over.
BOOT_BUDGET_S = 150


def _free_port() -> int:
    """A port nothing is listening on right now.

    ⚠️ INHERENTLY RACY, and the caller retries rather than pretending otherwise: between this
    close() and the child's bind() another process can take it. Six copies of this helper in
    this tree once produced intermittent failures at every xdist width for exactly that reason,
    so the race is handled where it actually is — in the retry below — instead of being wished
    away here.
    """
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _plant(root: Path) -> Path:
    """A runnable copy of the app whose BASE_DIR is `root` — every file git TRACKS.

    🔴 THE TRACKED SET, NOT `src/`, AND THE FIRST RUN OF THIS TEST IS WHY. Copying only
    `src/` + `vocalis.py` died at import with `ModuleNotFoundError: vocalis_stream_core` — that
    module lives in `satellite/`, which `vocalis_streaming.py` puts on `sys.path` itself
    ("one file, imported from two machines, because a vendored duplicate would drift"). Guessing
    at the runtime's directory layout is how you write a test that passes on a shape nobody
    ships.

    📌 And the tracked set is the RIGHT answer rather than a bigger guess: the install on the
    box is a git checkout, so this boots exactly what a deploy puts there. 725 files, 15.9 MB.
    """
    listed = subprocess.run(["git", "ls-files"], cwd=str(REPO_ROOT),
                            capture_output=True, text=True, encoding="utf-8")
    n = 0
    for line in listed.stdout.splitlines():
        rel = line.strip()
        if not rel:
            continue
        src = REPO_ROOT / rel
        if not src.is_file():
            continue
        dst = root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        n += 1
    assert n > 300, (
        f"only {n} tracked files were planted, so the copy is not a working install and a boot "
        "failure below would say nothing about the real one. Check that `git ls-files` runs from "
        "the repo root."
    )
    return root / "vocalis.py"


def _health(port: int, timeout: float = 3.0):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


@pytest.mark.timeout(300)
def test_the_server_boots_from_its_real_entrypoint_and_answers_health(tmp_path):
    entry = _plant(tmp_path)
    log = tmp_path / "spawn.log"

    # 🔴 A SPAWNED PROCESS INHERITS THE PARENT'S ENVIRONMENT, SO EVERY PIN conftest MADE WITH AN
    # ENV VAR ARRIVES POINTING AT SHARED STATE. Copying the tree moves `BASE_DIR`, but it does
    # nothing about these — and `VOCALIS_SCRATCH_DIR` is the dangerous one: conftest points it at
    # ONE directory per worker process, and `main()` calls `_sweep_stale_workdirs()`, which EMPTIES
    # the scratch at boot. Inherited, this test would delete another test's staged uploads on the
    # same worker, intermittently, with the damage landing somewhere else entirely.
    #
    # 📌 REPOINTED BY DISCOVERY, NOT BY A LIST OF TWO NAMES. Every `VOCALIS_*` var whose value is a
    # path under the OS temp directory is a test pin by construction, and each gets its own
    # subdirectory here. A third pin added to conftest is handled the day it lands — the same
    # reason `job_registry_modules()` matches a signature instead of reciting module names.
    env = dict(os.environ)
    tmpdir = str(Path(tempfile.gettempdir()).resolve()).lower()
    for k, v in list(env.items()):
        if k.startswith("VOCALIS_") and v and str(Path(v).resolve()).lower().startswith(tmpdir):
            env[k] = str(tmp_path / "env" / k.lower())
    env["VOCALIS_CACHE_DIR"] = str(tmp_path / "cache")
    # Cold, like the box: no model is held at boot. Stated rather than inherited, because the
    # default changing would otherwise turn this into a VRAM test by accident.
    env["VOCALIS_PRELOAD"] = "0"

    proc = None
    for attempt in range(3):                      # the _free_port race, handled where it lives
        port = _free_port()
        with open(log, "wb") as fh:
            proc = subprocess.Popen(
                [sys.executable, str(entry), "--host", "127.0.0.1", "--port", str(port)],
                cwd=str(tmp_path), env=env, stdout=fh, stderr=subprocess.STDOUT,
            )
        deadline = time.time() + BOOT_BUDGET_S
        health = None
        while time.time() < deadline:
            if proc.poll() is not None:           # died: either the port race or a real break
                break
            try:
                health = _health(port)
                break
            except (urllib.error.URLError, OSError, TimeoutError):
                time.sleep(0.4)
        if health is not None:
            break
        # Stop only the process handle created by this test. Other Python processes and their
        # browser sessions are outside its ownership.
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=20)
        tail = log.read_text(encoding="utf-8", errors="replace")[-4000:]
        if attempt == 2 or "address" not in tail.lower():
            pytest.fail(
                "the server did not answer /health within "
                f"{BOOT_BUDGET_S}s of a cold start from its real entrypoint.\n"
                "  This is the one check that covers main(): argument parsing, TLS resolution, the\n"
                "  single-instance guard, the scratch sweep, the store startup tasks and the\n"
                "  training reattach. A green suite cannot see any of them.\n"
                f"  exit code: {proc.returncode}\n--- last of {log.name} ---\n{tail}"
            )

    try:
        assert health.get("version") == tts_utils.VERSION, (
            f"/health says version {health.get('version')!r} but this tree is "
            f"{tts_utils.VERSION!r} — the running code is not the code under test"
        )
        # 🔴 AND THE ISOLATION HELD. `logs/vocalis.log` under the TEMPORARY root is the proof that
        # BASE_DIR followed the copy; if this file is absent the server logged into the developer's
        # own checkout, which is the exact leak this file's docstring is about.
        assert (tmp_path / "logs" / "vocalis.log").exists(), (
            "the spawned server did not create logs/vocalis.log under the temporary root — "
            "BASE_DIR did not follow the copy, so it has been writing into the real install"
        )
        banner = (tmp_path / "logs" / "vocalis.log").read_text(encoding="utf-8", errors="replace")
        assert tts_utils.VERSION in banner, (
            "the startup banner never reached the log file, so setup_logging's file sink is not "
            "attached — every future 'nothing in the journal' outage starts here"
        )
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=20)

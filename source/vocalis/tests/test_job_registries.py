"""conftest's job-leak fixture must reach EVERY job registry, not the three someone remembered.

🔴 WHY THIS FILE EXISTS. `dedb016` fixed a three-session flake — a job left in a module-level
registry makes a later browser spec load a page that reattaches to it and calls
`switchTab('voicestudio')`, so every geometry check after that measures a `display:none` panel
where all rects are 0x0. The fixture it added drained three registries by name. The tree has
EIGHT, and the flake came back from a fourth: `stemsplit.JOBS`, reached by `ssResume()` polling
`/stems/jobs`. The diagnostic added the same night printed it plainly —

    {"firstHiddenAncestor":"SECTION#[playground]","activeTab":"voicestudio"}

— which is why this is a census rather than a fifth name in a list. A recited list goes stale the
next time someone adds a queue, and the failure it produces is a flake in an unrelated spec,
hours away from the change that caused it.

📌 THE HOUSE SIGNATURE IS `JOBS` + `JOBS_LOCK`, and all eight follow it. `job_registry_modules()`
matches on that rather than on names, so a ninth written the same way is drained the day it
lands. This file is what proves that claim instead of asserting it.
"""
from __future__ import annotations

import importlib
import re
import sys
import types
from pathlib import Path

from conftest import REPO_ROOT, job_registry_modules

SRC = Path(REPO_ROOT) / "src"

#: 🔴 THE WINDOW GUARD. Every assertion below is "the census covers X", which is trivially true of
#: an empty census. Eight registries exist today; a scan that suddenly finds two has broken, and a
#: floor is what turns that into a failure instead of a quieter pass.
#: See feedback_a_guard_is_only_as_good_as_its_window.
MIN_REGISTRIES = 6

_DECL = re.compile(r"(?m)^JOBS_LOCK\s*=")


def _source_level_registries() -> set[Path]:
    """Files that DECLARE a registry, read off disk — independent of what got imported."""
    out = set()
    for p in SRC.rglob("*.py"):
        try:
            if _DECL.search(p.read_text(encoding="utf-8", errors="replace")):
                out.add(p.resolve())
        except OSError:
            continue
    return out


def test_every_registry_in_the_tree_is_one_the_fixture_can_reach():
    """The census: what the source declares must be what the discovery finds.

    ⚠️ `import vocalis_server` first, because discovery deliberately only considers modules that
    are ALREADY imported — pulling them in itself would drag the whole runtime into unit tests
    that never touch it. The server imports every blueprint, and the blueprints import every job
    module, so this is the app's own import graph rather than a hand-kept list.
    """
    # importlib rather than a plain import: the module is wanted for its IMPORT SIDE EFFECT,
    # and a bare `import vocalis_server` would be an unused name needing a `noqa` — one more
    # suppression for the ratchets to carry, bought for nothing.
    importlib.import_module("vocalis_server")

    declared = _source_level_registries()
    assert len(declared) >= MIN_REGISTRIES, (
        f"only {len(declared)} registry declaration(s) found under {SRC} (floor {MIN_REGISTRIES}). "
        "The scan has stopped matching, so everything below is true of almost nothing — check the "
        "`JOBS_LOCK` pattern before believing a green run."
    )

    reached = {Path(m.__file__).resolve() for m in job_registry_modules() if getattr(m, "__file__", None)}
    missed = sorted(p for p in declared if p not in reached)
    assert not missed, (
        "these modules own a job registry that conftest's `_no_job_leaks_between_tests` never "
        "clears:\n" + "\n".join(f"  {p.relative_to(REPO_ROOT).as_posix()}" for p in missed) + "\n"
        "\n  A job left in one of these outlives its test, and the page REATTACHES to it at boot "
        "\n  and switches tabs — so the damage lands in an unrelated browser spec as 0x0 rects, "
        "\n  hours from the change that caused it. That flake cost three sessions once already."
        "\n  If the module does not follow the `JOBS` + `JOBS_LOCK` signature, make it follow the "
        "\n  signature rather than adding a name to a list somewhere."
    )


def test_the_fixture_actually_empties_them():
    """🔴 Discovery is not draining. Fill every registry, run the drain, and look.

    A test that only checks the census would pass with a fixture whose body did nothing.
    """
    importlib.import_module("vocalis_server")

    mods = job_registry_modules()
    assert len(mods) >= MIN_REGISTRIES, f"discovery found only {len(mods)} registries"

    for m in mods:
        m.JOBS["probe-8994cc99"] = {"status": "running"}
    assert all(m.JOBS for m in mods), "the probe did not land in every registry"

    # Exactly what the autouse fixture does.
    for m in job_registry_modules():
        m.JOBS.clear()

    left = sorted(m.__name__ for m in mods if m.JOBS)
    assert not left, f"these registries still held jobs after the drain: {left}"


def test_the_census_can_actually_fail():
    """A detector nobody has watched fire is decoration — so fire it on a module with no lock."""
    fake = types.ModuleType("fake_registry_8994cc99")
    fake.JOBS = {}
    fake.__file__ = str(SRC / "fake_registry_8994cc99.py")
    # No JOBS_LOCK: it does not follow the signature, so discovery must not pick it up.
    sys.modules[fake.__name__] = fake
    try:
        assert fake not in job_registry_modules(), (
            "discovery matched a module with no JOBS_LOCK, so its signature is looser than "
            "documented and it may clear dictionaries that are not job registries"
        )
        fake.JOBS_LOCK = object()
        assert fake in job_registry_modules(), (
            "discovery did NOT match a module with both JOBS and JOBS_LOCK inside the repo — "
            "the census above is then vacuous, because nothing can ever be found"
        )
    finally:
        sys.modules.pop(fake.__name__, None)

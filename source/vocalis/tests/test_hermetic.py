"""Keep cache-backed tests inside the test environment.

`cache_root()` follows `VOCALIS_CACHE_DIR`, not the working directory. Modules that import
that function hold separate bindings, so the tests verify the environment override reaches
all of them and never inspects or modifies the operator's cache.
"""
import importlib
import os
from pathlib import Path

import pytest

import enhance_rate
import render_rate
import tts_utils

# 🔴 IMPORTED AT MODULE LEVEL, AND THAT IS PART OF THE TEST (8.9.8). conftest's install-root pin
# is an autouse fixture, so it runs BEFORE any test body — it can only pin a module something has
# already imported. This file AUDITS those paths, and it used to import the four modules inside
# the test function: the fixture therefore saw them as absent, skipped their pins, and the audit
# then measured the developer's real install and failed. Importing here makes the modules visible
# to the fixture, which is the ordering every other test file gets by accident.
# ⚠️ RESIDUAL, RECORDED RATHER THAN HIDDEN: `runtime/auth` imported LAZILY by some other file
# still misses its pin. `paths` and `settings` are imported by the fixture itself now (they are
# side-effect-free); `auth` and `vocalis_server` are not, because their imports build the app and
# capture the vault.
# 📌 A LOOP RATHER THAN FOUR BARE IMPORTS. The names are never referenced — the IMPORT is the
# whole point — so four plain `import x` lines each need an unused-import suppression, and a
# suppression is what you write when the code will not say what you mean. `import_module` says
# it: these modules are being registered, on purpose, before the fixtures run.
# ⚠️ AND THE TOKEN IS NOT SPELLED IN THIS COMMENT, deliberately. The tree-wide ratchet counts
# textual occurrences, so a note explaining why there are none would have added one — the exact
# self-funding the `@ts-nocheck` note in test_webui_types.py records for the other family.
for _m in ("vocalis_server", "vocalis.runtime.auth",
           "vocalis.runtime.paths", "vocalis.runtime.settings"):
    importlib.import_module(_m)


def test_the_cache_root_is_pinned_away_from_the_host(monkeypatch):
    """cache_root() must not resolve to the user's real cache while the suite runs."""
    pinned = tts_utils.cache_root()
    assert os.environ.get("VOCALIS_CACHE_DIR"), \
        "conftest must pin VOCALIS_CACHE_DIR before any test module is imported"
    assert pinned == Path(os.environ["VOCALIS_CACHE_DIR"])

    # What this box WOULD have used with no override — i.e. the live app's own cache.
    monkeypatch.delenv("VOCALIS_CACHE_DIR")
    host = tts_utils.cache_root()
    assert pinned != host, "the suite is pointed at the host's real cache"


def test_every_module_that_bound_cache_root_got_the_pinned_one():
    """The whole point, and the thing per-test monkeypatching kept getting wrong.

    Each module holds its own `cache_root` binding, so the old approach had to patch each one
    by hand and silently read the host wherever it forgot. The env var reaches all of them at
    once because cache_root() re-reads it on EVERY call."""
    pinned = Path(os.environ["VOCALIS_CACHE_DIR"])
    for mod in (tts_utils, enhance_rate, render_rate):
        assert mod.cache_root() == pinned, \
            f"{mod.__name__}'s own cache_root binding escaped the pin — it can read the host"


def test_the_import_time_constants_got_it_too():
    """The reason this lives in conftest at IMPORT and not in an autouse fixture.

    `book_to_audio.CHUNKS_ROOT` and `rt_paths.AUDIO_CACHE` are evaluated when their
    module is imported, so a fixture — which runs per-test, long after collection has imported
    everything — would be far too late to redirect them. Only setting the env var before
    pytest imports the first test module catches these two."""
    pinned = Path(os.environ["VOCALIS_CACHE_DIR"])

    import book_to_audio
    assert book_to_audio.CHUNKS_ROOT == pinned / "chunks", \
        "CHUNKS_ROOT is bound at import — the pin must be set before the module loads"

    # Imported here rather than at module scope on purpose: it drags torch + flask in, and
    # conftest deliberately keeps those out of the chunker unit tests.
    import vocalis.runtime.paths as rt_paths
    assert rt_paths.AUDIO_CACHE == pinned / "audio_cache", \
        "AUDIO_CACHE is bound at import — same reason"


def test_the_rate_stores_write_somewhere_harmless():
    """The failure that would have mattered most, and the one nobody had hit YET.

    `record()` on both rate stores is a read-modify-WRITE of a YAML file under cache_root().
    Nothing stopped a test from calling it for real — and on host that file is the live app's
    measured performance history. A green suite would have quietly rewritten it."""
    pinned = Path(os.environ["VOCALIS_CACHE_DIR"])
    for store in (enhance_rate._path(), render_rate._path()):
        assert pinned in store.parents, \
            f"a rate store writes to {store} — outside the throwaway cache, i.e. the HOST"


# ── the install root (5.0) ───────────────────────────────────────────────────────────────
# The cache was closed first, and closing it made it obvious that BASE_DIR had exactly the same
# hole and six more files in it. Run the suite inside a real install and 284 tests failed —
# `admin_credentials.yaml` was sitting there, so auth_enabled() was True and every
# unauthenticated request 401'd. The suite passed on a dev box and failed in the deployment,
# which is the one place you actually want to run it before trusting a release.

def test_the_scratch_is_pinned_away_from_the_host(monkeypatch):
    """scratch.default_root() is `work/scratch` UNDER THE INSTALL ROOT — in a real install that
    is the live server's scratch, which bulk.py stages uploads in and sweep() empties."""
    import scratch
    pinned = scratch.scratch_root()
    assert os.environ.get("VOCALIS_SCRATCH_DIR"), \
        "conftest must pin VOCALIS_SCRATCH_DIR before any test module is imported"
    assert pinned == Path(os.environ["VOCALIS_SCRATCH_DIR"])

    monkeypatch.delenv("VOCALIS_SCRATCH_DIR")
    assert pinned != scratch.scratch_root(), "the suite is pointed at the host's real scratch"


def test_the_suite_never_inherits_the_hosts_login():
    """THE 284. A deployed install has admin_credentials.yaml; a dev box does not. Unpinned,
    that one file decides whether the entire suite can reach any gated route.

    Note this asserts the STATE, not the path: `_apply_admin_creds()` runs at import, so
    repointing ADMIN_CREDS_FILE without resetting what import already derived from it leaves
    auth_enabled() True and changes nothing."""
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    assert not rt_auth.auth_enabled(), \
        "the suite inherited a login from the install root — every gated route will 401"
    assert not rt_auth.creds_broken()


#: The only BASE_DIR-rooted names that may STAY inside the install root, because none of them
#: is state: they are the checkout itself and the code/assets shipped in it, read and never
#: written. Everything else `runtime/paths.py` declares is a file or directory the app WRITES,
#: and must be pinned away from the developer's own install.
#:
#: 🔴 THIS ALLOWLIST IS THE WHOLE RATCHET. Add a path constant and it is checked automatically;
#: the only way past is to name it here, which is a decision someone has to write down.
#:
#: `CODE_DIR` (Docker refactor): the immutable code root that `BASE_DIR` now aliases. In the image it
#: is the read-only application tree; all writable state moved to the DATA_DIR/LOG_DIR/SCRATCH_DIR
#: mounts, which this test still checks. Naming it here is the same decision `BASE_DIR` already had.
READ_ONLY_INSTALL_PATHS = {"BASE_DIR", "CODE_DIR", "_SRC", "WEBUI"}


def test_no_install_root_path_points_into_a_real_install():
    """Every BASE_DIR-rooted constant, ENUMERATED off the module rather than recited.

    🔴 THE RECITED VERSION SAID "adding an eighth cannot quietly reopen this" AND WAS WRONG.
    It listed seven names. By 8.9 the fixture pinned nine, and FOUR MORE — `CLIP_FAVORITES`,
    `ACE_CANDIDATES`, `ACE_LIBRARY`, `ACE_LIBRARY_AUDIO` — were not pinned anywhere at all,
    with `CLIP_FAVORITES` a read-modify-WRITE store over the developer's own stars. Every one
    of those arrived after the list was written and none of them reopened it loudly, because a
    hand-kept list cannot notice what was never added to it. `dir(rt_paths)` can.

    🔴 EACH NAME IS STILL CHECKED ON THE MODULE THAT OWNS IT for the three that live elsewhere.
    5.1 moved APP_SETTINGS to `vocalis.runtime.settings` (P3.3) and the two credential paths to
    `vocalis.runtime.auth` (P4.15); had any been left re-exported on `vocalis_server`, a test
    reading the re-export would pass while the code read the host's real file. Asserting on a
    name its module no longer has raises AttributeError instead, which is the outcome to want.
    """
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    import vocalis.runtime.paths as rt_paths
    import vocalis.runtime.settings as rt_settings
    base = rt_paths.BASE_DIR.resolve()

    named = {"APP_SETTINGS": rt_settings,
             # 5.1-P4.15: both moved to vocalis.runtime.auth, which is also what pins them.
             "ADMIN_CREDS_FILE": rt_auth, "VAULT_KEYFILE": rt_auth}
    checked = []
    for name, owner in named.items():
        p = Path(getattr(owner, name)).resolve()
        checked.append(name)
        assert base not in p.parents, \
            f"{name} -> {p} is inside the install root: the suite is reading/writing the HOST"

    for name in sorted(dir(rt_paths)):
        if name.startswith("__") or name in READ_ONLY_INSTALL_PATHS:
            continue
        v = getattr(rt_paths, name)
        if not isinstance(v, Path):
            continue
        p = v.resolve()
        checked.append(name)
        assert base != p and base not in p.parents, (
            f"{name} -> {p} is inside the install root: the suite is reading/writing the HOST.\n"
            f"  Pin it in conftest's `_pin_install_root`, or — if it is read-only code or an "
            f"asset rather than state — add it to READ_ONLY_INSTALL_PATHS and say why."
        )

    # 🔴 NON-VACUITY. An enumeration that found nothing would pass silently, which is exactly how
    # a renamed module or an import that quietly failed would read. Ten is well under the current
    # count and well over anything an accident produces.
    assert len(checked) >= 10, f"the enumeration found almost nothing to check: {checked}"


# ── two instances must never share a root (5.0) ──────────────────────────────────────────
# host runs two Vocalis servers, kept apart ONLY by Environment= lines in a systemd unit. Drop
# one and both silently resolve to ~/.cache/vocalis, because cache_root() is keyed on HOME, not
# the install root. These pin the guard that refuses to boot on a shared root — and, just as
# importantly, pin the cases where it must NOT fire, since it exits the process.

def _marker(root, pid, install):
    import scratch
    (root / scratch.INSTANCE_MARKER).write_text(f"{pid} {install}\n", encoding="utf-8")


def test_a_free_root_is_claimed(tmp_path):
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    assert procs.claim_root(tmp_path, "cache") is None
    held = (tmp_path / procs._INSTANCE_MARKER).read_text().split()
    assert int(held[0]) == os.getpid()


def test_a_live_sibling_at_another_install_is_refused(tmp_path, monkeypatch):
    """Refuse a running sibling process whose marker names a different install root."""
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    _marker(tmp_path, 4242, "/srv/vocalis")
    monkeypatch.setattr(procs, "_pid_is_the_instance_at", lambda pid, install: True)
    msg = procs.claim_root(tmp_path, "cache")
    assert msg and "/srv/vocalis" in msg and "4242" in msg


def test_my_own_predecessor_mid_restart_is_not_a_collision(tmp_path, monkeypatch):
    """Allow a restart overlap when the existing process owns the same install root."""
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    import vocalis.runtime.paths as rt_paths
    _marker(tmp_path, 4242, str(rt_paths.BASE_DIR.resolve()))
    monkeypatch.setattr(procs, "_pid_is_the_instance_at",
                        lambda pid, install: pytest.fail("must not even be asked"))
    assert procs.claim_root(tmp_path, "cache") is None


def test_a_stale_marker_from_a_recycled_pid_is_not_a_collision(tmp_path, monkeypatch):
    """Linux recycles pids hard, so a SIGKILLed instance's marker outlives it and the number
    comes back. Alive-and-a-vocalis is not enough; it must be serving THAT install."""
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    _marker(tmp_path, 4242, "/srv/vocalis")
    monkeypatch.setattr(procs, "_pid_is_the_instance_at", lambda pid, install: False)
    assert procs.claim_root(tmp_path, "cache") is None


def test_an_unanswerable_question_is_not_a_collision(tmp_path, monkeypatch):
    """None means "cannot tell" — no /proc, unreadable entry. It must never be folded into
    True, because this guard exits the process. Same doctrine as foreign_engines()."""
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    _marker(tmp_path, 4242, "/srv/vocalis")
    monkeypatch.setattr(procs, "_pid_is_the_instance_at", lambda pid, install: None)
    assert procs.claim_root(tmp_path, "cache") is None


def test_a_garbled_marker_is_reclaimed_not_obeyed(tmp_path):
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    (tmp_path / procs._INSTANCE_MARKER).write_text("not a pid at all\n", encoding="utf-8")
    assert procs.claim_root(tmp_path, "cache") is None


def test_the_startup_sweep_does_not_eat_the_claim(tmp_path):
    """The marker is written BEFORE the sweep (the check must precede the destructive step), so
    the sweep has to skip it or the boot deletes its own claim."""
    import scratch
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    assert procs.claim_root(tmp_path, "scratch") is None
    (tmp_path / "junk").write_text("x", encoding="utf-8")
    assert scratch.sweep(tmp_path) == 1                       # the junk, and ONLY the junk
    assert (tmp_path / scratch.INSTANCE_MARKER).is_file()


def test_a_sibling_install_whose_path_is_a_prefix_is_not_confused(tmp_path, monkeypatch):
    """Compare normalized path components so a sibling root with a shared prefix stays distinct."""
    import vocalis_server as vs
    from vocalis.runtime import auth as rt_auth
    from vocalis.runtime import procs
    plain = tmp_path / "Vocalis"
    enc = tmp_path / "Vocalis.encrypted"
    for d in (plain, enc):
        (d / "src").mkdir(parents=True)
    argv = ["/usr/bin/python3", str(enc / "src" / "vocalis_server.py"), "--port", "7871"]
    monkeypatch.setattr(procs, "PROC_DIR", str(tmp_path / "proc"))
    (tmp_path / "proc" / "4242").mkdir(parents=True)
    (tmp_path / "proc" / "4242" / "cmdline").write_bytes(("\0".join(argv) + "\0").encode())

    assert procs._pid_is_the_instance_at(4242, str(enc)) is True
    assert procs._pid_is_the_instance_at(4242, str(plain)) is False, \
        "a prefix match mistook the encrypted instance for the plain one"

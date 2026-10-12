"""Vocalis 5.0-M6 — THE PATH ROUTER.

`vault_store.route(abs_path) -> (Vault, logical) | None` — "is this path ours, and if so what
is its logical name?" Every vault method takes a LOGICAL path; every seam in this codebase holds
an ABSOLUTE one. This is the one function that turns the second into the first, and nothing else
in M6/M7 works until it is right.

Getting it wrong is not a small bug in either direction, and the two directions are NOT
symmetric — which is why the router's default is None and an allow-list is what claims a path:

  wrongly CLAIM a path   -> it encrypts src/, .git/, logs/, or the plaintext SCRATCH ITSELF.
                            The app is bricked and the repository is destroyed.
  wrongly DISCLAIM one   -> a leak. Bounded, and the M0 sweep enumerates every data dir.

See SPEC_5_0_M6 §2.
"""
import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vault
import vault_store

PW = "correct horse battery staple"

# argon2 at the production 256 MiB costs ~0.11 s per unlock; these tests unlock a lot.
TEST_KDF = {"algo": "argon2id", "memory_kib": 8 * 1024, "time_cost": 1, "parallelism": 1}


@pytest.fixture
def roots(tmp_path):
    """An install root shaped like the REAL one — which is the whole point.

    BASE_DIR is the repo: it holds src/, .git/, logs/ and work/scratch right beside output/
    and uploads/. A router tested against a tidy fixture that contains only data dirs would
    pass while claiming every one of those.
    """
    install = tmp_path / "install"
    cache = tmp_path / "cache"
    for d in ("output", "uploads/songs", "voice_samples", "books",     # ours
              "src", "scripts", "logs", "work/scratch", ".git"):        # emphatically not
        (install / d).mkdir(parents=True, exist_ok=True)
    for d in ("chunks", "enhanced", "audio_cache", "voiceswap_preview"):
        (cache / d).mkdir(parents=True, exist_ok=True)
    return install, cache


@pytest.fixture
def store(roots, monkeypatch):
    """A CONFIGURED, INITIALIZED, UNLOCKED store over both roots."""
    install, cache = roots
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    s = vault_store.configure([("install", install), ("cache", cache)],
                              install / "vault_keys.yaml")
    # ⚠ configure() has ALREADY assigned the module global, so this setattr records `s` as the
    # "original" and would restore `s` on teardown — i.e. leak the vault into every test that
    # runs after this file. conftest's `_a_vault_never_leaks_out_of_the_test_that_built_it` is
    # what actually puts STORE back; this line only makes the intent readable.
    monkeypatch.setattr(vault_store, "STORE", s)
    s.create(PW)
    return s


# ── what the router must NEVER claim ─────────────────────────────────────────

def test_the_router_does_not_claim_the_code_the_logs_or_the_scratch(store, roots):
    """🔴 THE ONE THAT WOULD DESTROY THE REPOSITORY.

    All five of these live INSIDE the install root, because the install root IS the repo. A
    router built on containment alone — "is it under a root?", which is how both the design and
    the handoff describe it — claims every one of them.

    work/scratch is the one that should stop your heart: the scratch is THE ONE PLACE PLAINTEXT
    MAY TOUCH DISK (M3), and its default root is BASE_DIR/work/scratch. Encrypting it means
    encrypting the destination that decrypt_to_scratch WRITES TO.
    """
    install, _ = roots
    for p in (install / "src" / "vocalis_server.py",
              install / "scripts" / "enhance" / "enhance_audio.py",   # a FOREIGN VENV execs this
              install / "logs" / "vocalis.log",                       # must be readable while LOCKED
              install / "work" / "scratch" / "abc123.wav",            # 🔴 the plaintext boundary
              install / ".git" / "HEAD"):
        assert vault_store.route(p) is None, f"the router CLAIMED {p} — it would encrypt it"


def test_the_router_does_not_claim_what_you_unlock_with(store, roots):
    """A locked server must still be able to read these — they are the login and the key.

    admin_credentials.yaml is checked BEFORE the vault can possibly be unlocked, and
    app_settings.yaml is read at boot to find the scratch root and the enhance venv. Encrypting
    either is a deadlock: you would need the DEK to read the file that gets you the DEK.
    """
    install, _ = roots
    for name in ("vault_keys.yaml", "admin_credentials.yaml", "app_settings.yaml"):
        assert vault_store.route(install / name) is None, f"the router CLAIMED {name}"


def test_the_router_does_not_claim_ai_output(store):
    """/ai-output is gocryptfs's, not ours.

    It is already plaintext to us through the FUSE mount, and the ownership rule is "we read
    /ai-output; we NEVER write there". A plain open() is CORRECT for an ACE-Step song — and
    claiming one would mean Vocalis encrypting a library that belongs to another application.
    """
    assert vault_store.route("/ai-output/acestep/some_song.mp3") is None


# ── what it must claim ───────────────────────────────────────────────────────

def test_the_router_claims_every_store_in_both_roots(store, roots):
    install, cache = roots
    cases = {
        install / "output" / 'Sample Book' / "mp3" / "ch_001.mp3": 'output/Sample Book/mp3/ch_001.mp3',
        install / "uploads" / "songs" / "track.mp3":           "uploads/songs/track.mp3",
        install / "voice_samples" / 'TestVoice.wav':                'voice_samples/TestVoice.wav',
        install / "books" / 'Sample Book.epub':                    'books/Sample Book.epub',
        install / "voice_settings.yaml":                       "voice_settings.yaml",
        install / "ui_state.yaml":                             "ui_state.yaml",
        cache / "chunks" / "playground" / "ab12" / "pending.yaml": "chunks/playground/ab12/pending.yaml",
        cache / "enhanced" / "deadbeef.wav":                   "enhanced/deadbeef.wav",
        cache / "audio_cache" / "cafe.mp3":                    "audio_cache/cafe.mp3",
        cache / "voiceswap_preview" / "p.mp3":                 "voiceswap_preview/p.mp3",
        cache / "song_ids.yaml":                               "song_ids.yaml",
        cache / "enhance_rates.yaml":                          "enhance_rates.yaml",
        cache / "render_rates.yaml":                           "render_rates.yaml",
    }
    for abs_path, expected in cases.items():
        r = vault_store.route(abs_path)
        assert r is not None, f"the router DISCLAIMED {abs_path} — it would stay in cleartext"
        _, logical = r
        assert logical == expected


def test_a_bare_tree_dir_routes_because_a_directory_is_a_logical_path_too(store, roots):
    """listdir("output") and mkdir("uploads/songs") both need the DIRECTORY to route."""
    install, _ = roots
    v, logical = vault_store.route(install / "output")
    assert logical == "output"


def test_the_two_roots_route_to_two_DIFFERENT_vaults(store, roots):
    """One keyfile, one DEK — but each root keeps its own sentinel, so each proves
    independently that the keyfile belongs to IT."""
    install, cache = roots
    vi, _ = vault_store.route(install / "output" / "x.wav")
    vc, _ = vault_store.route(cache / "enhanced" / "y.wav")
    assert vi is not vc
    assert vi.store_root == install and vc.store_root == cache


# ── 🔴 the rule that lets M6/M7 ship before M9's migration ────────────────────

def test_the_router_is_INERT_until_the_vault_is_initialized(roots, monkeypatch):
    """🔴 THIS IS WHY MIGRATION-ERA INSTALLS DO NOT BRICK ON DEPLOY.

    M6/M7 ship before M9's migration, so output/, uploads/, and ~/.cache/vocalis remain
    full of PLAINTEXT. With no vault_keys.yaml every seam must route to None and read them with
    a plain open() — bit-for-bit 4.x behavior. The cipher arrives; the data has not moved yet.

    It is also the entire reason the suite stays green: every pure-library test drives stems /
    playground_clips / enhance with a bare tmp_path and no server.
    """
    install, cache = roots
    s = vault_store.configure([("install", install), ("cache", cache)],
                              install / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", s)
    assert not s.is_initialized()
    assert vault_store.route(install / "output" / 'Sample Book' / "mp3" / "ch_001.mp3") is None
    assert vault_store.route(cache / "enhanced" / "deadbeef.wav") is None


def test_no_store_at_all_routes_to_None(monkeypatch):
    """A pure-library test, or an import-time caller, must not explode."""
    monkeypatch.setattr(vault_store, "STORE", None)
    assert vault_store.route("/anywhere/at/all.wav") is None


def test_initialized_but_LOCKED_still_ROUTES(store, roots):
    """🔴 LOCKED IS NOT INERT, and this is the distinction that matters most.

    Returning None while locked would send the seams down the plaintext path and write
    PLAINTEXT INTO AN ENCRYPTED STORE — the one outcome worse than failing. So a locked vault
    still routes, and the vault itself then raises VaultLocked, loudly.
    """
    install, _ = roots
    store.lock()
    assert not store.is_unlocked()

    r = vault_store.route(install / "output" / 'Sample Book' / "mp3" / "ch_001.mp3")
    assert r is not None, "a LOCKED vault routed to None — the seams would write plaintext"
    v, logical = r
    with pytest.raises(vault.VaultLocked):
        v.read_bytes(logical)


# ── 🔴 the cleared cache must not brick the vault (SPEC_5_0_M6 §3) ────────────

def test_a_cleared_cache_does_not_brick_the_vault(store, roots):
    """🔴 THE LOCKOUT M5 REFUSED TO GUESS AT.

    Vault._finish_unlock refuses to unlock a store that has CONTENT BUT NO SENTINEL. That is the
    backup-restore guard and it is RIGHT. But cache_root() is a CACHE and `clear_cache` is a
    shipped feature: delete it, let anything at all repopulate it, and a strict vault sees
    content-with-no-sentinel and refuses to open THE WHOLE STORE — including the install root,
    which holds the actual data. A cleared cache would become a permanent lockout.

    The cache root is registered DERIVED, so a MISSING sentinel self-heals.
    """
    install, cache = roots
    store.lock()

    # `rm -rf ~/.cache/vocalis`, then anything at all repopulates it.
    import shutil
    shutil.rmtree(cache)
    cache.mkdir()
    (cache / "enhanced").mkdir()
    (cache / "enhanced" / "leftover.wav").write_bytes(b"repopulated by something")
    assert not (cache / vault.SENTINEL_NAME).exists()

    store.unlock_with_password(PW)                    # must NOT raise
    assert store.is_unlocked()
    assert (cache / vault.SENTINEL_NAME).exists()     # healed


def test_a_derived_store_still_REFUSES_a_sentinel_that_FAILS(tmp_path, monkeypatch):
    """Absence of evidence, only. A sentinel that is PRESENT and does not verify is not a
    missing proof — it is a POSITIVE one, and it says this cache was written under a different
    DEK. Self-healing THAT would be forging the very check the sentinel exists to make.
    """
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    cache = tmp_path / "cache"
    cache.mkdir()

    v = vault.Vault(cache, tmp_path / "keys.yaml", derived=True)
    v2, _ = vault.Vault.create(cache, tmp_path / "keys.yaml", PW)
    v2.lock()

    # A sentinel from a DIFFERENT vault (a different DEK) — a cache restored from a backup
    # taken under an older keyfile.
    other, _ = vault.Vault.create(tmp_path / "other", tmp_path / "other_keys.yaml", PW)
    (cache / vault.SENTINEL_NAME).write_bytes(
        (tmp_path / "other" / vault.SENTINEL_NAME).read_bytes())

    with pytest.raises(vault.VaultAuthError):
        v2.unlock_with_password(PW)
    assert not v2.is_unlocked()


def test_the_install_root_still_REFUSES_content_without_a_sentinel(tmp_path, monkeypatch):
    """The relaxation is for the CACHE and nowhere else. The install root is not derived, and a
    missing sentinel there still means "this key may not belong to this data" — refuse."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    root = tmp_path / "install"
    root.mkdir()

    v, _ = vault.Vault.create(root, tmp_path / "keys.yaml", PW)
    v.lock()
    (root / vault.SENTINEL_NAME).unlink()
    (root / "output").mkdir()
    (root / "output" / "book.mp3").write_bytes(b"data that is still here")

    with pytest.raises(vault.VaultAuthError):
        v.unlock_with_password(PW)


# ── the allow-list must not rot into a silent leak ───────────────────────────

def test_every_store_the_app_can_actually_write_is_routed(store, roots, monkeypatch):
    """🔴 THE TEST THAT STOPS THE ALLOW-LIST ROTTING.

    An allow-list's failure mode is a SILENT leak: add a store in 5.1, forget to register it,
    and it writes cleartext forever with nothing to say so. So this does not check the table
    against itself — it asks the REAL config objects where they actually put things, and
    demands the router claim every one.

    🔴 AND IT ONLY ASKED **ONE** OF THEM, WHICH IS THE VERY ROT IT WAS BUILT TO STOP.

    It enumerated `SwapConfig` and nothing else. `TrainConfig` names three more directories, and
    TWO of them hold user data:

      * **`rvc_dir`** — the trained-voice registry. main's 4.2-m0a moved it out of /ai-models
        and INTO the install root, and nothing here noticed. 13–18 GPU-hours a voice.
      * **`training_dir`** — the source-clip repository: the user's own recorded voice.

    Both were sitting inside BASE_DIR, unrouted, and would have shipped in cleartext with the
    whole suite green. An allow-list is only as good as the list of things you ask.
    """
    import cleanup_rate
    import swap_rate
    import voiceswap
    import voicetrain
    from tts_utils import cache_root

    install, cache = roots
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))

    cfg = voiceswap.resolve_config({}, install, install / "output", cache)
    tcfg = voicetrain.resolve_config({}, install)

    live = {
        "songs (uploaded)":   cfg.songs_dir,
        "stem uploads":       cfg.stem_uploads_dir,
        "stems (ours)":       cfg.stems_dir,
        "the swap library":   cfg.library_dir,
        "the swap previews":  cfg.preview_dir,
        "M4's song index":    cfg.song_index,
        "the chunk store":    cache_root() / "chunks",
        "the enhanced cache": cache_root() / "enhanced",
        "the MD5 audio cache": cache_root() / "audio_cache",
        "voice samples":      install / "voice_samples",
        "the book library":   install / "books",
        "the settings file":  install / "voice_settings.yaml",
        # 5.0-M8: the web UI's own state — tabs, selections, and the Playground PROSE. A loose file
        # in the install root, registered beside voice_settings.yaml. Unrouted, it would sit in the
        # vault directory in cleartext with the user's typed prose in it.
        "the UI-state file":  install / "ui_state.yaml",
        # TrainConfig — the two nobody was asking:
        "the trained-voice registry": tcfg.rvc_dir,
        "the training clips":         tcfg.training_dir,
        # 🔴 AND IT ROTTED A THIRD TIME (M10 §6). The rot was not carelessness: this test asks
        # CONFIG OBJECTS, and 4.4 introduced stores that are not config fields at all — a module
        # FUNCTION (cleanup.scores_cache_path, {cleanup,swap}_rate._path) is invisible to a test
        # that enumerates dataclasses, however many dataclasses you add to it. These three are
        # M10 R1–R3, and adding them fixes this instance while leaving that mechanism intact;
        # §12.1 is the decision to make this test PARSE instead of enumerate.
        "the trim-score cache":  cache_root() / "trim_scores",
        "the denoise rate store": cleanup_rate._path(),
        "the swap rate store":    swap_rate._path(),
    }
    unrouted = [what for what, p in live.items() if vault_store.route(p) is None]
    assert not unrouted, (
        f"these stores hold user data and the router does NOT claim them — they would stay in "
        f"CLEARTEXT forever, silently: {unrouted}")

    # ...and the ones that must NOT be claimed, each for its own reason.
    import cleanup
    import scratch
    ccfg = cleanup.resolve_config({}, install)
    assert vault_store.route(ccfg.scratch) is None, (
        "the router claimed the CLEANUP SCRATCH — the scratch IS the plaintext boundary (5.0 "
        "§8.3), and encrypting it would encrypt the very files the denoise child has to read")
    assert vault_store.route(scratch.scratch_root()) is None, "the router claimed the scratch root"
    assert vault_store.route(cfg.acestep_dir) is None, "the router claimed /ai-output"
    assert vault_store.route(tcfg.applio_dir) is None, (
        "the router claimed the Applio checkout — it holds a foreign venv that EXECUTES from it, "
        "and its logs/ are the training checkpoints, which are M7's ferry (design §8.6), not "
        "vault.py's to encrypt in place: Vocalis writes only two files in that tree.")


# ── §6: the anti-rot test that PARSES instead of enumerating ─────────────────
#
# 🔴🔴 THE TEST ABOVE HAS NOW ROTTED THREE TIMES, AND NEVER ONCE THROUGH CARELESSNESS.
#
#   1. It asked SwapConfig and not TrainConfig  -> rvc_dir and training_dir unrouted.
#   2. It asked config objects, and 4.4's stores are not config fields at all: a module
#      CONSTANT (CLEANUP_PREVIEW_DIR) and three module FUNCTIONS (cleanup.scores_cache_path,
#      {cleanup,swap}_rate._path). No number of added dataclasses can make those visible.
#   3. M10 §3b: 4.8 arrived with six more, and the list did not know to ask.
#
# Each repair added the missing name and left the mechanism. This is the mechanism: it does not
# ask anything for its list — it READS THE SOURCE and finds every path the code actually builds
# out of a store root. A new `output/**` resident cannot arrive unnoticed, which is exactly what
# cleanup_preview did.
#
# 🔴 IT PARSES, IT DOES NOT GREP. The same lesson the scratch tripwire and the blind-except
# tripwire each had to learn: a regex over source text matches strings in comments, in
# docstrings and unrelated expressions, and it cannot distinguish a data-root path from the
# same words appearing in a sentence. An AST walk sees the expression.

# The roots a store path can hang off, and what each resolves to in the fixture. These are the
# names the SOURCE uses; the values are this test's fake install/cache.
_PATH_ROOT_NAMES = {"DATA_DIR", "OUTPUT_DIR", "CHUNKS_ROOT"}
_PATH_ROOT_CALLS = {"cache_root", "chunks_root"}

# Paths that are deliberately NOT encrypted. Every entry is a REASON, not a name — an exempt
# list whose entries carry no argument is just the allow-list's rot moved one file over.
_EXEMPT = {
    ("DATA_DIR", "app_settings.yaml"):
        "config, and it must be readable while LOCKED (design §7)",
    ("DATA_DIR", "admin_credentials.yaml"):
        "the password hash you log in WITH — readable while locked, by definition",
    ("DATA_DIR", "vault_keys.yaml"):
        "the wrapped DEK itself. Encrypting it with the key it holds is a bootstrap paradox",
    ("DATA_DIR", "logs"):
        "the legacy default log directory is outside the vault writer; Docker supplies a separate "
        "VOCALIS_LOG_DIR mount, and logs must not contain user content",
    ("DATA_DIR", "work"):
        "the legacy default scratch workspace is plaintext staging outside vault_fs; Docker "
        "supplies separate VOCALIS_SCRATCH_DIR and VOCALIS_BULK_DIR mounts",
    ("DATA_DIR", "certs"):
        "pinned satellite TLS certificates (5.3). PUBLIC by construction — the private half is "
        "generated on the satellite and never leaves it — and read while LOCKED, because the "
        "satellite registry decides which devices exist before anything unlocks",
}


def _src_root(root=None):
    return (root or REPO_ROOT) / "src"


def _store_paths_built_in_src(root=None):
    """Every `<root> / "literal" / ...` expression under src/, AT ANY DEPTH, as
    (root, parts) -> sites. `root` is how the planted-input test below points the SAME walk at
    a fake tree instead of the working one.

    Truncated at the first NON-literal component: `CHUNKS_ROOT / book_id` tells us the code
    writes somewhere under the chunk store, which is the question this test asks, and the
    identity of `book_id` is not knowable here and does not change the answer.

    🔴 rglob, not glob — fixed 5.1-P3.3, and it was FOUND BY GOING RED rather than by being
    looked for. This walk was flat, exactly like `test_m6_writer_census._src_files` was until
    Phase 0.1, and for the same reason: nothing under `src/` was a package. Moving
    `APP_SETTINGS = BASE_DIR / "app_settings.yaml"` into `src/vocalis/runtime/settings.py`
    took it out of this walk, and `test_the_EXEMPT_list_cannot_rot_either` reported the
    exemption as stale. That direction is loud. **The other direction is silent and is the one
    that matters**: a NEW store path built in a subpackage would simply never be audited, and
    the test proving every store in `src/` is routed would go on passing while covering less
    and less of the product.

    Sites are labeled with the path relative to `src/`, not the basename, so
    `vocalis/web/bulk.py` reads as itself rather than as `bulk.py` — same reason the census
    keys its module map that way.
    """
    import ast
    import collections

    def root_of(node):
        if isinstance(node, ast.Name) and node.id in _PATH_ROOT_NAMES:
            return node.id
        # DATA_DIR is module-qualified in the runtime and bare in some consumers. Kept in step with
        # test_m6_writer_census._store_root_of by test_the_two_censuses_agree_on_the_roots.
        if isinstance(node, ast.Attribute) and node.attr in _PATH_ROOT_NAMES:
            return node.attr
        if isinstance(node, ast.Call):
            fn = node.func
            name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
            if name in _PATH_ROOT_CALLS:
                return name + "()"
        return None

    src = _src_root(root)
    out = collections.defaultdict(list)
    for f in sorted(p for p in src.rglob("*.py") if "__pycache__" not in p.parts):
        # utf-8-sig: a BOM is invisible to Python's importer and a SyntaxError to ast.parse.
        tree = ast.parse(f.read_text(encoding="utf-8-sig"), filename=str(f))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div)):
                continue
            parts, cur = [], node
            while isinstance(cur, ast.BinOp) and isinstance(cur.op, ast.Div):
                r = cur.right
                parts.append(r.value if isinstance(r, ast.Constant) and isinstance(r.value, str)
                             else None)                       # None = dynamic
                cur = cur.left
            root = root_of(cur)
            if root is None:
                continue                                      # not rooted at a store root
            parts.reverse()
            if None in parts:
                parts = parts[:parts.index(None)]             # truncate at the first dynamic part
            out[(root, tuple(parts))].append(
                f"{f.relative_to(src).as_posix()}:{node.lineno}")
    return out


def test_the_walk_DESCENDS_into_subpackages(tmp_path):
    """🔴 The walk above must reach `src/vocalis/**`, and nothing else in this file can tell you
    whether it does — every assertion here is of the form "no offenders found", which an empty
    walk satisfies perfectly and forever.

    This was flat until 5.1-P3.3 and it was correct only for as long as no `.py` lived in a
    subdirectory of `src/`. The refactor arms it: the first module to move takes its store paths
    out of the audit, and the audit says nothing. Verified red against the flat glob — three
    depths, so a fix that reaches one level only is caught too.
    """
    src = tmp_path / "src"
    for rel, body in {
        "flat.py":                 'A = DATA_DIR / "flat_store"\n',
        "vocalis/mid.py":          'B = OUTPUT_DIR / "mid_store"\n',
        "vocalis/runtime/deep.py": 'C = CHUNKS_ROOT / "deep_store"\n',
        "vocalis/qualified.py":    'from vocalis.runtime import paths\n'
                                   'D = paths.DATA_DIR / "qualified_store"\n',
    }.items():
        p = src / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")

    found = _store_paths_built_in_src(tmp_path)
    assert ("DATA_DIR", ("flat_store",)) in found
    assert ("OUTPUT_DIR", ("mid_store",)) in found, "the walk stopped at the top level of src/"
    assert ("CHUNKS_ROOT", ("deep_store",)) in found, "the walk did not reach src/vocalis/runtime"
    # Module-qualified DATA_DIR references use the same root recognition as bare names.
    assert ("DATA_DIR", ("qualified_store",)) in found, (
        "`paths.DATA_DIR / \"…\"` was not recognized as a store root")
    # And the site labels distinguish a subpackage module from a same-named top-level one,
    # which a basename key would not: see test_m6_writer_census._mod_key for the same lesson.
    assert found[("CHUNKS_ROOT", ("deep_store",))] == ["vocalis/runtime/deep.py:1"]


def test_every_path_the_SOURCE_builds_under_a_store_root_is_routed_or_exempt(store, roots, monkeypatch):
    """🔴 THE ANTI-ROT TEST THAT CANNOT ROT THE WAY THE OTHER ONE DID.

    It builds its own list by parsing `src/*.py`, so "the list of things you thought to ask" —
    the thing that failed three times — is not part of it. Add a store in 5.1 and forget to
    register it, and this fails the moment the code that writes it is committed.

    A finding here is one of exactly two things, and BOTH are actionable:
      * a new store that must go in `ROUTES` — the leak this whole milestone is about; or
      * a new non-store path that must go in `_EXEMPT` **with a reason someone can argue with**.
    """
    install, cache = roots
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))

    concrete = {"DATA_DIR": install, "OUTPUT_DIR": install / "output",
                "CHUNKS_ROOT": cache / "chunks", "cache_root()": cache,
                "chunks_root()": cache / "chunks"}

    built = _store_paths_built_in_src()
    # 🔴 THE GUARD AGAINST THIS TEST LYING, and it is the same one `assert_no_cleartext`'s
    # `expect_files` exists for: a parser that matches NOTHING passes, beautifully, forever.
    # Rename BASE_DIR, or change how a path is spelled, and the walk quietly returns {} while
    # this file goes on reporting that every store is routed.
    #
    # The number counts DISTINCT LITERAL PREFIXES, not expressions: everything from the first
    # dynamic component on is truncated, so `CHUNKS_ROOT / book / f"{i}.wav"` and
    # There are 24 distinct literal prefixes. The floor leaves room for legitimate route changes
    # while detecting a narrowed scan.
    #
    # 18 is a deliberately loose floor. It is a tripwire for the WALK BREAKING — returning zero,
    # or only the handful an accidental narrowing would leave — not a count to keep in step with
    # the code. A floor set at the current total makes every honest deletion a test failure,
    # which teaches people to edit the number without reading it, and then it guards nothing.
    assert len(built) >= 18, (
        f"the AST walk found only {len(built)} store-rooted paths in src/ — it has stopped "
        f"seeing the code, and a walk that sees nothing reports everything as routed")

    unrouted = []
    for (root, parts), sites in sorted(built.items()):
        if (root, parts[0] if parts else "") in _EXEMPT:
            continue
        p = concrete[root]
        for part in parts:
            p = p / part
        if vault_store.route(p) is None:
            shown = "/".join((root,) + parts)
            unrouted.append(f"{shown}  (built at {', '.join(sites[:3])})")

    assert not unrouted, (
        "the SOURCE builds these paths under a store root and the router does NOT claim them.\n"
        "Each is either a store that belongs in vault_store.ROUTES — in which case it is "
        "writing CLEARTEXT into the vault right now, silently — or a non-store that belongs in "
        "this file's _EXEMPT with a reason:\n  " + "\n  ".join(unrouted))


def test_the_EXEMPT_list_cannot_rot_either(store, roots, monkeypatch):
    """An exemption for a path nothing builds any more is a stale claim, and a stale claim is
    how the allow-list rotted in the first place — one file over. If a store moves or is
    deleted, its exemption must go with it rather than sitting here quietly excusing a name
    that a future store could reuse."""
    install, cache = roots
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))

    built = {(root, parts[0] if parts else "")
             for root, parts in _store_paths_built_in_src()}
    stale = sorted(k for k in _EXEMPT if k not in built)
    assert not stale, (
        f"these paths are exempted but src/ no longer builds them — drop the entries: {stale}")

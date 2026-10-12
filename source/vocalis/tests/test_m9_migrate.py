"""5.0-M9 — the migration: turn a plaintext box into an encrypted one, in place, losing nothing.

🔴 A GREEN SUITE PROVES NOTHING ABOUT THE CIPHER. `vault_store.route()` is inert until a vault is
initialized, so every OTHER test in this repo is just as green over a 100%-cleartext store. This
file is the exception: it drives the real migration with a vault ON and then GREPS THE PLATTER
(`assert_no_cleartext`) — the only instrument that sees a file the walk missed, because a missed
write is silent (SPEC_5_0_M9 §8).

The two rules that would fail SILENTLY and EXPENSIVELY get their own tests: PRESERVE MTIME (§5 —
or the whole library re-renders on first use) and VERIFY BEFORE DELETE (§4 — or a bad migration
eats data).
"""
import os
from pathlib import Path

import pytest
import yaml

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect: puts src/ on the path)

import vault
import vault_fs
import vault_store
import vault_migrate
from test_m6_e2e import assert_no_cleartext, PW, TEST_KDF

# 2020-01-01, whole seconds -> 100ns-aligned, and safely in the PAST: if the migration fails to
# restore an mtime, the ciphertext carries ~now instead, and the assertion catches the gap.
PAST = 1_577_836_800

_ALLOW_INSTALL = {"vault_keys.yaml", ".vault_sentinel", "app_settings.yaml", "admin_credentials.yaml"}
_ALLOW_CACHE = {".vault_sentinel"}


def _seed(install: Path, cache: Path):
    """Populate a plaintext 4.x tree across both roots, plus two UNROUTED files that must survive
    untouched. Every routed file starts with a recognizable header or carries the user's words, so
    `assert_no_cleartext` has something real to catch before — and nothing after. Distinct past
    mtimes per file catch a 'restored the wrong file's mtime' bug."""
    long_title = "0_" + "C" * 210 + ".mp3"                 # overflows the SIV name -> long-name path
    routed = {
        "install": [
            ("output/My Book/mp3/01_Intro.mp3",
             b"ID3\x04\x00" + b"\x00" * 40 + b" the trained voice reads chapter one "),
            (f"output/My Book/mp3/{long_title}", b"\xff\xfb" + b"long chapter payload " * 4),
            ("output/playground/Narrator/clip1.mp3", b"\xff\xfb" + b"playground clip payload here"),
            ("output/playground/Narrator/clip1.yaml",
             b"text: the quick brown fox\nvoice: Narrator\ncreated: 2026-07-14\n"),
            ("voice_samples/Narrator.wav", b"RIFF\x24\x00\x00\x00WAVEfmt the reference voice clip"),
            ("voice_models/Narrator.pth", b"PK\x03\x04" + b" the trained voice weights blob " * 3),
            ("voice_models/Narrator.index", bytes(range(256)) + b"faiss-index-body-bytes"),
            ("voice_models/Narrator.yaml", b"trained: 2026-07-01\nsize: 1234\n"),
            ("voice_settings.yaml", b"Narrator:\n  pitch: 0\n  index_rate: 0.75\n"),
            ("books/mybook.docx", b"PK\x03\x04" + b"word/document.xml the manuscript body text"),
        ],
        "cache": [
            ("enhanced/abc123def456.wav", b"RIFF\x24\x00\x00\x00WAVEthe enhanced full-band audio"),
            ("chunks/playground/HASH/pending.yaml", b"text: the user's canceled render words\n"),
            ("song_ids.yaml", b"someref: {size: 7, mtime: 8}\n"),
        ],
    }
    unrouted = [
        ("app_settings.yaml", b"gpus: [0, 1]\nworkers_per_card: 2\n"),
        ("admin_credentials.yaml", b"username: admin\npassword_hash: scrypt:32768:8:1$abc$def\n"),
    ]
    roots = {"install": install, "cache": cache}
    manifest, idx = {}, 0
    for rootname, items in routed.items():
        for rel, content in items:
            p = roots[rootname] / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(content)
            t = (PAST + idx) * 1_000_000_000                # distinct, past, ns-aligned
            os.utime(p, ns=(t, t))
            manifest[p] = (content, t)
            idx += 1
    unrouted_manifest = {}
    for rel, content in unrouted:
        p = install / rel
        p.write_bytes(content)
        unrouted_manifest[p] = content
    return manifest, unrouted_manifest


@pytest.fixture
def box(tmp_path, monkeypatch):
    """A plaintext tree + a configured-but-NOT-created store. The migration itself calls
    `create()`. `vault.DEFAULT_KDF` is swapped for the cheap test KDF so `create()` is fast; the
    autouse conftest fixture restores `vault_store.STORE` afterward."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install, cache = tmp_path / "install", tmp_path / "cache"
    install.mkdir()
    cache.mkdir()
    manifest, unrouted = _seed(install, cache)
    keyfile = install / "vault_keys.yaml"
    store = vault_store.configure([("install", install), ("cache", cache)], keyfile)
    monkeypatch.setattr(vault_store, "STORE", store)
    return dict(store=store, install=install, cache=cache, keyfile=keyfile,
                manifest=manifest, unrouted=unrouted)


# ── the gate ──────────────────────────────────────────────────────────────────

def test_migration_leaves_no_cleartext_on_the_platter(box):
    """Scan both roots after migration; only explicitly allowed files may remain clear."""
    store = box["store"]
    store.create(PW)
    vault_migrate.encrypt_tree(store)
    assert_no_cleartext(box["install"], allow=_ALLOW_INSTALL, expect_files=5)
    assert_no_cleartext(box["cache"], allow=_ALLOW_CACHE, expect_files=2)


def test_find_cleartext_sees_under_a_top_whose_name_is_encrypted(box):
    """Check that the scoped scan reaches files beneath encrypted routed tops.

    `trim_scores` and cache-root files are routed but not structural, so migration stores them
    beneath SIV names rather than `root / top`. The scan must locate those physical paths before
    applying `store.logical_of()`; otherwise path arithmetic returns `None` and silently skips
    the subtree. The broad gate above scans the entire root and does not exercise this scoped
    traversal, so this test plants equivalent plaintext in routed and structural locations.
    """
    store = box["store"]
    store.create(PW)
    vault_migrate.encrypt_tree(store)
    assert vault_migrate.find_cleartext(store) == [], "the migrated tree should start clean"

    v_cache = store.logical_of(box["cache"] / "enhanced" / "x")[0]
    encrypted_top = Path(v_cache._map("trim_scores"))
    assert encrypted_top != box["cache"] / "trim_scores", (
        "trim_scores has become structural — repoint this test at a top that is still encrypted, "
        "or the blind spot it guards is no longer being tested")

    leak = b"RIFF\x24\x00\x00\x00WAVEtitle: the user's own words"
    (box["cache"] / "enhanced" / "leak.wav").write_bytes(leak)      # structural top — always seen
    encrypted_top.mkdir(parents=True, exist_ok=True)
    (encrypted_top / "leak.wav").write_bytes(leak)                  # SIV top — the blind spot

    hits = vault_migrate.find_cleartext(store)
    assert len(hits) == 2, (
        f"find_cleartext must see BOTH leaks, not just the one under a cleartext top: {hits}")


def test_every_file_round_trips_to_its_original_plaintext(box):
    store = box["store"]
    store.create(PW)
    vault_migrate.encrypt_tree(store)
    for p, (content, _mt) in box["manifest"].items():
        assert vault_fs.read_bytes(p) == content, f"{p} did not round-trip"


# ── the two silent, expensive rules ────────────────────────────────────────────

def test_mtime_is_preserved_to_the_nanosecond(box):
    """🔴🔴 The cardinal rule (§5). A missed restore leaves ~now on the ciphertext and every
    (size, mtime)-keyed cache re-derives."""
    store = box["store"]
    store.create(PW)
    vault_migrate.encrypt_tree(store)
    for p, (_content, mt_ns) in box["manifest"].items():
        v, logical = store.logical_of(p)
        st = v.stat(logical)
        assert st.mtime_ns == mt_ns, f"{logical}: mtime {st.mtime_ns} != original {mt_ns}"
        assert int(st.mtime) == mt_ns // 1_000_000_000


def test_size_is_the_plaintext_size_not_the_ciphertext_size(box):
    """The other identity leg — free, via vault.plaintext_len — but pinned so it can't regress."""
    store = box["store"]
    store.create(PW)
    vault_migrate.encrypt_tree(store)
    for p, (content, _mt) in box["manifest"].items():
        v, logical = store.logical_of(p)
        assert v.stat(logical).size == len(content), f"{logical}: wrong plaintext size"


def test_the_swap_identity_seam_answers_the_same_before_and_after(box):
    """`source_stat` is THE identity seam (enhance/bandwidth/durations/song-index/swap all key on
    it). Its answer for the .pth must be byte-identical across the migration, or the swap library
    silently orphans and re-renders."""
    import tts_utils
    store = box["store"]
    pth = box["install"] / "voice_models" / "Narrator.pth"
    before = tts_utils.source_stat(pth)          # store not created -> raw stat
    store.create(PW)
    vault_migrate.encrypt_tree(store)
    after = tts_utils.source_stat(pth)           # now -> vault's logical stat
    assert before == after, f"swap identity moved across the migration: {before} -> {after}"


def test_a_failed_verify_preserves_the_plaintext_and_stops(box, monkeypatch):
    """🔴 Verify-before-delete (§4). Force one file's round-trip to fail: the plaintext original
    must be untouched and the run must raise, never delete on an unconfirmed write."""
    store = box["store"]
    store.create(PW)
    target = box["install"] / "voice_samples" / "Narrator.wav"
    original = target.read_bytes()
    real = vault_migrate.round_trips
    monkeypatch.setattr(vault_migrate, "round_trips",
                        lambda v, lg, path: False if Path(path) == target else real(v, lg, path))
    with pytest.raises(vault_migrate.MigrationError):
        vault_migrate.migrate_one(store, target, stats=vault_migrate.Stats())
    assert target.exists(), "the plaintext original was deleted despite a failed verify"
    assert target.read_bytes() == original, "the plaintext original was altered"


# ── resume / idempotence ───────────────────────────────────────────────────────

def test_a_second_run_is_a_no_op(box):
    store = box["store"]
    store.create(PW)
    first = vault_migrate.encrypt_tree(store)
    assert first.migrated == len(box["manifest"])        # everything got encrypted the first time
    second = vault_migrate.encrypt_tree(store)
    assert second.migrated == 0                          # THE property: a re-run encrypts nothing new
    for p, (content, _mt) in box["manifest"].items():    # ...and the store still round-trips
        assert vault_fs.read_bytes(p) == content


def test_verify_all_decrypts_every_migrated_file(box):
    """`verify_all` walks the vault by LOGICAL name (not physical + logical_of), so it reaches the
    SIV-named loose files too — the exact gap that broke the first cut of this function."""
    store = box["store"]
    store.create(PW)
    vault_migrate.encrypt_tree(store)
    checked, failures = vault_migrate.verify_all(store)
    assert not failures
    assert checked == len(box["manifest"])               # every routed file, loose ones included


def test_a_partial_migration_resumes_and_finishes(box):
    """Migrate half, drop a crash-orphaned .part, then resume the whole tree. It must finish and
    leave no cleartext; the orphan is stepped over, not treated as a plaintext original."""
    store = box["store"]
    store.create(PW)
    files = vault_migrate.iter_plaintext_files(store)
    stats = vault_migrate.Stats()
    for p in files[: len(files) // 2]:
        vault_migrate.migrate_one(store, p, stats=stats)

    orphan = box["install"] / "output" / "crashed.part"     # partial ciphertext left by a SIGKILL
    orphan.write_bytes(vault.MAGIC + b"\x01\x00\x00\x00" + b"\x00" * 8 + b"half a block")

    vault_migrate.encrypt_tree(store)                        # resume
    assert_no_cleartext(box["install"], allow=_ALLOW_INSTALL, expect_files=5)
    assert_no_cleartext(box["cache"], allow=_ALLOW_CACHE, expect_files=2)
    for p, (content, _mt) in box["manifest"].items():
        assert vault_fs.read_bytes(p) == content


# ── the boundaries: what M9 must NOT touch ─────────────────────────────────────

def test_unrouted_files_stay_plaintext_and_identical(box):
    """app_settings.yaml + admin_credentials.yaml route to None — they are what you UNLOCK WITH —
    so they must be neither encrypted nor moved."""
    store = box["store"]
    store.create(PW)
    vault_migrate.encrypt_tree(store)
    for p, content in box["unrouted"].items():
        assert p.exists(), f"{p} vanished"
        assert p.read_bytes() == content, f"{p} was modified"


# ── the recovery + rollback flows ──────────────────────────────────────────────

def test_the_recovery_key_unlocks_the_migrated_store(box):
    """The disaster path: after migration, lock, then unlock with the recovery key and read a
    file — the automated half of the §9 bare-metal restore gate."""
    store = box["store"]
    recovery = store.create(PW)
    vault_migrate.encrypt_tree(store)
    store.lock()
    assert not store.is_unlocked()
    store.unlock_with_recovery(recovery)
    assert store.is_unlocked()
    pth = box["install"] / "voice_models" / "Narrator.pth"
    assert vault_fs.read_bytes(pth) == box["manifest"][pth][0]


def test_create_and_confirm_returns_the_key_on_success(box):
    store, keyfile = box["store"], box["keyfile"]
    recovery = vault_migrate.create_and_confirm(store, keyfile, PW, lambda r: True)
    assert recovery
    assert store.is_initialized() and store.is_unlocked()


def test_wipe_and_init_on_an_empty_wiped_tree(tmp_path, monkeypatch):
    """The empty-install path (§1.5): a fresh, wiped tree where cache_root() may not exist yet. The tool
initializes the vault, confirms the recovery key, encrypts zero files, and starts clean. With no
existing data, migration and preservation checks have no work to do."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install = tmp_path / "install"
    install.mkdir()
    cache = tmp_path / "cache"                        # deliberately NOT created — the wipe removed it
    keyfile = install / "vault_keys.yaml"
    store = vault_store.configure([("install", install), ("cache", cache)], keyfile)
    monkeypatch.setattr(vault_store, "STORE", store)

    recovery = vault_migrate.create_and_confirm(store, keyfile, PW, lambda r: True)
    assert recovery and store.is_initialized() and store.is_unlocked()
    assert cache.exists(), "create_and_confirm must mkdir a wiped cache root before create()"

    stats = vault_migrate.encrypt_tree(store)
    assert stats.migrated == 0 and stats.already == 0
    checked, failures = vault_migrate.verify_all(store)
    assert checked == 0 and not failures
    assert not vault_migrate.find_cleartext(store, allow=("app_settings.yaml",))


def test_a_refused_recovery_confirmation_rolls_back_untouched(box):
    """🔴 If setup aborts before the walk, the half-initialized vault is rolled back — an
    initialized box whose files are still plaintext is a BROKEN box (§4)."""
    store, keyfile = box["store"], box["keyfile"]
    before = {p: p.read_bytes() for p in box["manifest"]}
    recovery = vault_migrate.create_and_confirm(store, keyfile, PW, lambda r: False)
    assert recovery is None
    assert not keyfile.exists(), "the keyfile survived the rollback"
    assert not (box["install"] / ".vault_sentinel").exists()
    assert not (box["cache"] / ".vault_sentinel").exists()
    assert not store.is_initialized()
    for p, content in before.items():
        assert p.exists() and p.read_bytes() == content, f"{p} was touched during a rolled-back run"


# ── unit-level guards ──────────────────────────────────────────────────────────

def test_is_vault_internal_recognizes_only_vault_bookkeeping():
    """The companion match is EXACT — a user file that merely ends in .name must still migrate,
    or it leaks."""
    assert vault_migrate.is_vault_internal(".vault_sentinel")
    assert vault_migrate.is_vault_internal("whatever.part")
    assert vault_migrate.is_vault_internal("L" + "a" * 32 + ".name")     # a real companion
    assert not vault_migrate.is_vault_internal("my chapter.name")         # a USER file — must migrate
    assert not vault_migrate.is_vault_internal("01_Intro.mp3")


def test_dry_run_writes_nothing(box, capsys):
    store = box["store"]
    rc = vault_migrate._dry_run(store)
    assert rc == 0
    assert "DRY RUN" in capsys.readouterr().out
    assert not box["keyfile"].exists()
    assert not store.is_initialized()


def test_default_roots_is_the_data_root_plus_cache_root():
    """The shared vault roots are durable data and configured cache."""
    import tts_utils
    from vocalis.runtime import paths
    roots = dict(vault_store.default_roots())
    assert set(roots) == {"install", "cache"}
    assert roots["install"] == paths.DATA_DIR
    assert roots["cache"] == tts_utils.cache_root()


# ── enable / disable are the ONLY supported flows — no migration ─────────────────────────

def _empty_store(tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install, cache = tmp_path / "install", tmp_path / "cache"
    install.mkdir()
    cache.mkdir()
    keyfile = install / "vault_keys.yaml"
    store = vault_store.configure([("install", install), ("cache", cache)], keyfile)
    monkeypatch.setattr(vault_store, "STORE", store)
    return store, install, cache, keyfile


def test_enable_refuses_a_populated_store(box):
    """🔴 We do NOT migrate. Enabling on a store that already holds data must refuse, create no vault,
    and leave the data untouched — you pick encryption at install time, on an empty store."""
    store, keyfile = box["store"], box["keyfile"]
    rc = vault_migrate._enable(store, keyfile, assume_yes=True)
    assert rc == 1
    assert not keyfile.exists() and not store.is_initialized()   # no vault was created
    for p, (content, _mt) in box["manifest"].items():
        assert p.exists() and p.read_bytes() == content          # data untouched


def test_disable_turns_encryption_off_on_an_empty_store(tmp_path, monkeypatch):
    store, install, cache, keyfile = _empty_store(tmp_path, monkeypatch)
    store.create(PW)
    assert store.is_initialized()
    rc = vault_migrate._disable(store, keyfile, assume_yes=True)
    assert rc == 0
    assert not keyfile.exists()
    assert not (install / ".vault_sentinel").exists()
    assert not (cache / ".vault_sentinel").exists()
    assert not store.is_initialized()                            # back to plaintext mode


def test_disable_refuses_when_encrypted_data_exists(tmp_path, monkeypatch):
    """Disabling with ciphertext present would orphan it — there is no in-place decrypt. Refuse."""
    store, install, cache, keyfile = _empty_store(tmp_path, monkeypatch)
    store.create(PW)
    vault_fs.write_bytes(install / "voice_settings.yaml", b"Narrator:\n  pitch: 0\n")   # -> ciphertext
    rc = vault_migrate._disable(store, keyfile, assume_yes=True)
    assert rc == 1
    assert keyfile.exists() and store.is_initialized()           # refused -> untouched


# ── the setup gate: an encrypted install you cannot log in to is an install you cannot USE ──

def _write_admin_creds(install, password: str, user: str = "admin") -> None:
    from werkzeug.security import generate_password_hash
    (install / "admin_credentials.yaml").write_text(
        yaml.safe_dump({"username": user, "password_hash": generate_password_hash(password)}),
        encoding="utf-8")


def test_enable_refuses_when_no_admin_login_is_set(tmp_path, monkeypatch):
    """🔴 IT WOULD HAVE BUILT AN INSTALL THAT CAN NEVER BE UNLOCKED.

    `login_submit` is the ONLY caller of `unlock_with_password` in the whole process — one
    password, two uses (SPEC_5_0_M5 §4.1) — and it returns early when `auth_enabled()` is False.
    So a vault with no `admin_credentials.yaml` boots straight into: every route 401s "locked",
    `/login` REDIRECTS AWAY because auth is off, and the only way in is a hand-written POST to
    `/vault/recover` that spends the recovery key on day one to undo a setup mistake.

    Same discipline as the populated-store refusal: this tool must not be able to produce a
    state the app cannot get out of. And it is NOT skippable with --yes — `--yes` waives
    interactive confirmations, never a safety gate.
    """
    store, install, cache, keyfile = _empty_store(tmp_path, monkeypatch)
    assert not (install / "admin_credentials.yaml").exists()

    rc = vault_migrate._enable(store, keyfile, assume_yes=True)

    assert rc == 1, "it enabled encryption on an install with no way to log in"
    assert not keyfile.exists() and not store.is_initialized(), "a vault was created anyway"


def test_enable_refuses_a_vault_password_that_is_not_the_admin_password(tmp_path, monkeypatch):
    """🔴 The two are checked against DIFFERENT things and nothing else keeps them in step.

    Authentication compares a werkzeug hash; unlocking runs argon2id → KEK → unwrap the DEK. Let
    them diverge at setup and the failure surfaces later, at the login screen, as "correct
    password, but the vault refused to unlock" — authenticated, still locked, fail-closed and
    completely baffling. It is cheap here and expensive there.
    """
    store, install, cache, keyfile = _empty_store(tmp_path, monkeypatch)
    _write_admin_creds(install, "the-admin-password")

    tries = iter(["a-different-password", "another-wrong-one"])
    monkeypatch.setattr(vault_migrate, "_get_new_password", lambda: next(tries))
    monkeypatch.setattr(vault_migrate, "create_and_confirm",
                        lambda *a, **k: pytest.fail("it got past the password check"))

    with pytest.raises(StopIteration):        # it re-prompted rather than accepting either
        vault_migrate._enable(store, keyfile, assume_yes=True)
    assert not store.is_initialized(), "a vault was created with a password that cannot log in"


def test_enable_accepts_the_admin_password_and_turns_encryption_on(tmp_path, monkeypatch):
    """The happy path this gate exists to protect: one password, and the install is reachable."""
    store, install, cache, keyfile = _empty_store(tmp_path, monkeypatch)
    _write_admin_creds(install, PW)
    monkeypatch.setattr(vault_migrate, "_get_new_password", lambda: PW)   # asks for the EXISTING admin password
    monkeypatch.setattr(vault_migrate, "_interactive_confirm_recovery", lambda rec: True)

    rc = vault_migrate._enable(store, keyfile, assume_yes=True)

    assert rc == 0, "the correct admin password was refused"
    assert store.is_initialized() and keyfile.exists()
    store.lock()
    store.unlock_with_password(PW)             # the login password really does unwrap the DEK
    assert store.is_unlocked()

"""Concurrent writers to one destination need distinct temporary siblings before atomic replacement. A fixed .part name lets request threads interleave writes; the result can be invalid plaintext data or mixed ciphertext. The shared temporary-name helper protects writers across modules where a single owner lock cannot."""

import json
import threading

import pytest
import yaml

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vault
import vault_fs
from tts_utils import part_path
from vault import Vault

PW = "correct horse battery staple"
TEST_KDF = {"algo": "argon2id", "memory_kib": 8192, "time_cost": 1, "parallelism": 1}

WRITERS = 12


@pytest.fixture
def store(tmp_path):
    v, rk = Vault.create(tmp_path / "store", tmp_path / "vault_keys.yaml", PW, kdf=TEST_KDF)
    v.recovery_key = rk
    return v


def _storm(fn):
    """Run `fn(i)` on WRITERS threads that all arrive at once, and re-raise the first failure.

    The barrier is the point. Without it the threads trickle through one at a time and a shared
    temp name survives by luck, which is exactly how this bug stayed in the tree.
    """
    gate = threading.Barrier(WRITERS)
    errors = []

    def run(i):
        try:
            gate.wait(timeout=30)
            fn(i)
        except BaseException as e:                       # noqa: BLE001 — re-raised below, verbatim
            errors.append(e)

    threads = [threading.Thread(target=run, args=(i,)) for i in range(WRITERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    if errors:
        raise errors[0]


# ── the name itself ──────────────────────────────────────────────────────────


def test_two_writers_of_one_destination_never_get_the_same_temp(tmp_path):
    dest = tmp_path / "clip.yaml"
    names = {part_path(dest).name for _ in range(500)}
    assert len(names) == 500, "temp names collided — the whole fix is that they do not"


def test_the_part_suffix_stays_last_or_an_orphan_gets_decrypted_as_content(tmp_path):
    """🔴 `vault.listdir` and `vault_migrate` both recognize a crash-orphaned temp by
    `endswith(PART_SUFFIX)`. Put the unique token AFTER the suffix and a leftover temp stops being
    recognized, gets decrypted as though it were content, and raises — taking the whole directory
    with it. So the token goes before."""
    tmp = part_path(tmp_path / "clip.yaml", vault.PART_SUFFIX)
    assert tmp.name.endswith(vault.PART_SUFFIX)

    import vault_migrate
    assert vault_migrate.is_vault_internal(tmp.name)


def test_the_orphan_sweeps_still_find_it(tmp_path):
    """Half the suite asserts `not list(parent.glob("*.part"))` to prove a temp was cleaned up.
    A unique token must not walk out from under those."""
    tmp = part_path(tmp_path / "clip.yaml")
    tmp.write_text("x", encoding="utf-8")
    assert list(tmp_path.glob("*.part")) == [tmp]


# ── outside the vault ────────────────────────────────────────────────────────


def test_concurrent_yaml_writers_leave_one_parseable_file(tmp_path):
    dest = tmp_path / "clip_favorites.yaml"
    _storm(lambda i: vault_fs.write_yaml_atomic(dest, {"name": f"take {i}", "n": i}))

    loaded = yaml.safe_load(dest.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict), "the file did not parse — two writers interleaved into it"
    assert loaded["name"] == f"take {loaded['n']}", "the file is a MIX of two writers' payloads"
    assert not list(tmp_path.glob("*.part")), "a temp was orphaned"


def test_concurrent_json_writers_leave_one_parseable_file(tmp_path):
    """Exercise concurrent JSON writes to one destination and verify the final file remains parseable rather than being truncated by a shared temporary path."""
    dest = tmp_path / "revision.json"
    _storm(lambda i: vault_fs.write_json_atomic(dest, {"text": f"take {i}", "n": i}))

    loaded = json.loads(dest.read_text(encoding="utf-8"))
    assert loaded["text"] == f"take {loaded['n']}", "the file is a MIX of two writers' payloads"
    assert not list(tmp_path.glob("*.part")), "a temp was orphaned"


# ── inside the vault ─────────────────────────────────────────────────────────


def test_concurrent_vault_writers_do_not_interleave_two_ciphertexts(store):
    """Exercise concurrent vault writes to one destination and verify the result is one valid ciphertext, not an interleaving that causes later authentication failure."""
    logical = 'output/playground/TestCharacter/take.yaml'
    _storm(lambda i: store.write_text(logical, f"take {i}"))

    got = store.read_text(logical)                 # raises VaultAuthError if the blocks are mixed
    assert got in {f"take {i}" for i in range(WRITERS)}, f"not any writer's payload: {got!r}"


def test_a_concurrent_storm_leaves_no_orphan_in_the_listing(store):
    """An orphaned temp that listdir DID surface would be decrypted as content and raise."""
    logical = 'output/playground/TestCharacter/take.yaml'
    _storm(lambda i: store.write_text(logical, f"take {i}"))

    assert store.listdir('output/playground/TestCharacter') == ["take.yaml"]


# ── the guard ────────────────────────────────────────────────────────────────


def test_no_shared_writer_rebuilds_a_fixed_temp_name():
    """🔴 The regression is a one-line edit away, and it is invisible until two requests race.

    `<dest> + ".part"` is the obvious, idiomatic thing to write, and it is what was there before.
    Every shared writer must go through `part_path` instead.
    """
    import inspect

    for fn in (vault_fs.write_yaml_atomic, vault_fs.write_json_atomic, vault.Vault.open_write):
        src = inspect.getsource(fn)
        body = src.split('"""')[-1]                # skip the docstring, which discusses `.part`
        assert "part_path" in body, f"{fn.__qualname__} no longer uses part_path"
        assert '+ ".part"' not in body and "+ PART_SUFFIX" not in body, (
            f"{fn.__qualname__} rebuilt a FIXED temp name — two writers will share it")

"""Enabling from an install root that is also the repository root must report only paths owned by the application. Post-enable checks use that same root."""
import sys

import pytest

sys.path.insert(0, "src")
import vault_migrate                                    # noqa: E402
import vault_store                                      # noqa: E402


PW = "correct horse battery staple"


@pytest.fixture
def real_looking_root(tmp_path):
    """An install root with the junk a real one has: a venv, a .git, source, docs."""
    root = tmp_path / "install"
    (root / "venv" / "lib" / "python3.12" / "site-packages" / "urllib3").mkdir(parents=True)
    (root / ".git").mkdir(parents=True)
    (root / "src").mkdir(parents=True)
    (root / "docs").mkdir(parents=True)
    # The exact shape that produced the false leaks: source files holding marker bytes.
    (root / "venv/lib/python3.12/site-packages/urllib3/connection.py").write_bytes(b"# text: hi\n")
    (root / "src" / "vocalis_server.py").write_bytes(b"title: not user content\n")
    (root / "docs" / "DESIGN.md").write_bytes(b"created: also not\n")
    (root / ".git" / "config").write_bytes(b"voice: nope\n")
    (root / "README.md").write_bytes(b"favorite: still no\n")
    cache = tmp_path / "cache"
    cache.mkdir()
    return root, cache


def _store(root, cache, tmp_path):
    return vault_store.configure([("install", root), ("cache", cache)],
                                 tmp_path / "vault_keys.yaml")


def test_the_repo_is_not_a_leak(real_looking_root, tmp_path):
    """venv/, src/, docs/, .git/ and README.md are not the store, so they cannot leak from it."""
    root, cache = real_looking_root
    store = _store(root, cache, tmp_path)

    assert vault_migrate.find_cleartext(store) == []


def test_the_repo_is_not_data_that_blocks_enabling(real_looking_root, tmp_path):
    """The same scope decides whether the store counts as empty. If the repo counted, no real
    install could ever be enabled at all."""
    root, cache = real_looking_root
    store = _store(root, cache, tmp_path)

    assert vault_migrate.iter_plaintext_files(store) == []


def test_a_real_leak_in_a_routed_tree_is_STILL_caught(real_looking_root, tmp_path):
    """The scoping must not blind the instrument — that is the whole reason it exists."""
    root, cache = real_looking_root
    (root / "output" / "Some Book").mkdir(parents=True)
    (root / "output" / "Some Book" / "ch1.mp3").write_bytes(b"ID3\x04leaked audio")
    store = _store(root, cache, tmp_path)

    hits = vault_migrate.find_cleartext(store)

    assert len(hits) == 1
    assert "ch1.mp3" in hits[0]


def test_verify_all_walks_routed_tops_not_the_whole_root(real_looking_root, tmp_path):
    """Walking from "" hands .git/README.md/venv to listdir, which cannot decrypt them and logs
    each as possible TAMPERING. Nothing here is encrypted, so a correct walk checks zero files
    and reports zero failures — the old one reported a failure per repo entry."""
    root, cache = real_looking_root
    store = _store(root, cache, tmp_path)
    store.create(PW)
    try:
        checked, failures = vault_migrate.verify_all(store)

        assert failures == [], f"the repo tree was mistaken for vault content: {failures[:5]}"
        # If this fails, the message must identify the unexpected file so its writer can be found.
        #
        # `verify_all` walks this store's per-test roots, so unexpected files point to a background
        # writer. `vault_store.configure()` replaces the process-global router; a thread left
        # running by another test can later write through this test's router into its `tmp_path`.
        #
        # ⚠️ Diagnosis, not a workaround: the assertion still fails. It just says who did it.
        if checked:
            import threading
            alive = [t.name for t in threading.enumerate() if t is not threading.main_thread()]
            found = [str(p) for p in sorted(root.rglob("*")) if p.is_file()][:10]
            raise AssertionError(
                f"verify_all found {checked} encrypted file(s) under a root that should hold "
                f"none. Live non-main threads (a leaked one writing through the process-global "
                f"router is the standing hypothesis): {alive}. Files under the install root: "
                f"{found}")
    finally:
        store.lock()


def test_routed_tops_come_from_ROUTES(tmp_path):
    """If a tree is added to ROUTES it must be walked, without anyone remembering to update a
    second list. Same anti-rot rule as tests/test_m6_router.py."""
    for name in ("install", "cache"):
        tops = set(vault_migrate._routed_tops(None, name))
        r = vault_store.ROUTES[name]
        assert tops == {*r["trees"], *r["files"]}

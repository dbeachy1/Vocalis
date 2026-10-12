"""The CLI installs the vault path router before accessing files. Exercise the command-line guard with a temporary encrypted install and verify that exempt operations remain limited to their intended paths."""
import sys

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import book_to_audio
import vault_store


class _FakeStore:
    def __init__(self, initialized, unlocked):
        self._init, self._unlocked = initialized, unlocked
        self.roots_seen = None
        self.keyfile_seen = None

    def is_initialized(self):
        return self._init

    def is_unlocked(self):
        return self._unlocked


@pytest.fixture
def spy_configure(monkeypatch):
    """Capture what main() configures, without building a real VaultStore."""
    calls = {}

    def _make(initialized, unlocked):
        def _fake_configure(roots, keyfile):
            store = _FakeStore(initialized, unlocked)
            calls["roots"] = roots
            calls["keyfile"] = keyfile
            calls["store"] = store
            return store
        monkeypatch.setattr(vault_store, "configure", _fake_configure)
        return calls

    return _make


def _run_main(monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", ["book_to_audio.py"] + argv)
    with pytest.raises(SystemExit) as exc:
        book_to_audio.main()
    return exc.value.code


def test_locked_vault_refuses_before_touching_anything(monkeypatch, spy_configure, tmp_path):
    """An encrypted install without a DEK must refuse before rendering into the vault.

    The missing book path is deliberate: if the guard does not run first, the CLI reports
    "File not found" and obscures the locked-vault condition.
    """
    spy_configure(initialized=True, unlocked=False)
    assert _run_main(monkeypatch, [str(tmp_path / "anything.docx")]) == 1


def test_locked_vault_refuses_even_with_out_dir_outside_the_vault(monkeypatch, spy_configure,
                                                                  tmp_path):
    """There is no --out-dir that makes the run safe: the chunk workspace lives under
    cache_root(), a vault root of its own. So the guard must not be talked out of it."""
    spy_configure(initialized=True, unlocked=False)
    code = _run_main(monkeypatch, [str(tmp_path / "anything.docx"),
                                   "--out-dir", str(tmp_path / "outside")])
    assert code == 1


def test_unencrypted_install_is_not_blocked(monkeypatch, spy_configure, tmp_path):
    """An un-migrated box must behave exactly as it did in 4.x — route() returns None
    everywhere and the CLI is plain filesystem. It should get past the guard and fail on the
    ordinary missing-file check instead (also exit 1, so assert on the message, not the code).
    """
    spy_configure(initialized=False, unlocked=False)
    missing = tmp_path / "nope.docx"
    code = _run_main(monkeypatch, [str(missing)])
    assert code == 1                       # the File-not-found branch, NOT the vault guard


def test_unlocked_store_is_not_blocked(monkeypatch, spy_configure, tmp_path):
    """Belt and braces: initialized AND unlocked (a hypothetical future CLI that does hold a
    key) must not be refused by this guard either."""
    spy_configure(initialized=True, unlocked=True)
    assert _run_main(monkeypatch, [str(tmp_path / "nope.docx")]) == 1


def test_main_configures_the_router_with_the_shared_roots(monkeypatch, spy_configure, tmp_path):
    """The CLI must walk the SAME roots as the server and the migration — `default_roots()` is
    the one definition, so a CLI that configured its own list could miss a store (a leak) or
    encrypt one the app reads plaintext (a brick)."""
    calls = spy_configure(initialized=True, unlocked=False)
    _run_main(monkeypatch, [str(tmp_path / "anything.docx")])

    assert calls.get("store") is not None, "main() never called vault_store.configure()"
    assert [r[0] for r in calls["roots"]] == ["install", "cache"]
    assert calls["keyfile"].name == "vault_keys.yaml"


# ── --list-styles is exempt only for paths outside the vault ────────────────────────────
#
# The guard above sat in front of the `--list-styles` early return, so it refused a command
# that renders nothing, writes nothing and needs no key. A CLI process NEVER holds the DEK —
# `is_unlocked()` is False in a fresh process however the server is doing — so this broke
# `book_to_audio.py mybook.docx --list-styles` on every encrypted install, including the
# "inspect styles before your first run" usage the module docstring recommends.
#
# 🔴 This guard requires an initialized install. A clean checkout has no vault_keys.yaml, so
# `is_initialized()` is False and `test_list_styles_exits_zero` skips the stateful branch. Exercise
# the initialized-state path explicitly; guards keyed on installed state need that fixture.


def test_list_styles_is_allowed_on_a_locked_install(monkeypatch, spy_configure, tmp_path):
    """The regression. Encrypted, no key, --list-styles on a doc outside every root: allowed.

    It must NOT hit the vault refusal. The file does not exist, so it falls through to the
    ordinary File-not-found branch — which is exit 1 as well, so assert on WHICH refusal ran by
    checking the message, not the code."""
    spy_configure(initialized=True, unlocked=False)
    monkeypatch.setattr(vault_store, "route", lambda p: None)      # outside every vault root

    errors = []
    monkeypatch.setattr(book_to_audio.logger, "error", lambda m: errors.append(str(m)))

    _run_main(monkeypatch, [str(tmp_path / "nope.docx"), "--list-styles"])

    joined = "\n".join(errors)
    assert "ENCRYPTED" not in joined, "the vault guard refused a read-only --list-styles"
    assert "File not found" in joined


def test_list_styles_INSIDE_the_vault_still_refuses(monkeypatch, spy_configure, tmp_path):
    """The other half, and what keeps the exemption narrow. A book in books/ has a ciphertext
    name and needs the key to read at all — so --list-styles there must still get the honest
    "this install is encrypted" refusal rather than a confusing File-not-found."""
    spy_configure(initialized=True, unlocked=False)
    monkeypatch.setattr(vault_store, "route", lambda p: ("vault", "books/x.docx"))

    errors = []
    monkeypatch.setattr(book_to_audio.logger, "error", lambda m: errors.append(str(m)))

    assert _run_main(monkeypatch, [str(tmp_path / "x.docx"), "--list-styles"]) == 1
    assert "ENCRYPTED" in "\n".join(errors)


def test_a_RENDER_is_still_refused_even_outside_the_vault(monkeypatch, spy_configure, tmp_path):
    """The exemption is for --list-styles ONLY. A render with the document outside the roots is
    still refused, because the chunk workspace lives under cache_root() — a vault root of its
    own — so there is no document location that makes rendering safe without a key."""
    spy_configure(initialized=True, unlocked=False)
    monkeypatch.setattr(vault_store, "route", lambda p: None)

    errors = []
    monkeypatch.setattr(book_to_audio.logger, "error", lambda m: errors.append(str(m)))

    assert _run_main(monkeypatch, [str(tmp_path / "nope.docx")]) == 1
    assert "ENCRYPTED" in "\n".join(errors)

"""Store rendered books beneath `output/books/` to separate them from data stores.

The shared output namespace contains cleartext structural stores such as `playground`, `stems`,
and `voiceswap`. A book with one of those names must resolve under `output/books/`, so a book
clear operation cannot target the sibling store. The dedicated container also avoids maintaining
a reserved-name list alongside `vault.STRUCTURAL`.

Vault names are bound to their logical parent with AES-SIV. Moving an existing book directory
would require rewriting its encrypted names; directory renames are therefore rejected. This test
covers the path layout without moving existing vault data.
"""
import fnmatch

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import book_state
import vault
from book_to_audio import books_root

PW = "correct horse battery staple"
TEST_KDF = {"algo": "argon2id", "memory_kib": 8 * 1024, "time_cost": 1, "parallelism": 1}

# The three cleartext stores a book must never be able to reach.
STORES = ["playground", "stems", "voiceswap"]


@pytest.fixture
def v(tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    vlt, _recovery = vault.Vault.create(tmp_path / "store", tmp_path / "keys.yaml", PW)
    return vlt


# ── the root itself ──────────────────────────────────────────────────────────

def test_books_root_is_a_subdirectory_of_the_output_dir(tmp_path):
    assert books_root(tmp_path) == tmp_path / "books"


def test_books_root_reads_the_root_it_is_GIVEN(tmp_path):
    """🔴 Why it is a function taking the root rather than a module constant.

    `OUTPUT_DIR` is captured per importer — `from book_to_audio import OUTPUT_DIR` binds a name
    in each module, and the suite patches those bindings one at a time
    (`monkeypatch.setattr(web_books, "OUTPUT_DIR", tmp)`). A module-level
    `BOOKS_DIR = OUTPUT_DIR / "books"` would be computed once at import, so every patched test
    would keep writing into the developer's REAL install root while passing.
    """
    a, b = tmp_path / "one", tmp_path / "two"
    assert books_root(a) != books_root(b)
    assert books_root(b).parent == b


# ── 🔴 the collision is structurally impossible now ──────────────────────────

@pytest.mark.parametrize("store", STORES)
def test_a_book_named_after_a_store_does_not_resolve_onto_it(store, tmp_path):
    """THE ONE THAT MATTERS. Not 'it is rejected' — it does not collide at all."""
    output_dir = tmp_path / "output"
    resolved = books_root(output_dir) / store
    assert resolved != output_dir / store
    assert resolved.parent.name == "books"


@pytest.mark.parametrize("store", STORES)
def test_the_store_is_not_under_the_books_root(store, tmp_path):
    """The other direction: nothing a book route resolves can BE a store, so `_book_dir`'s
    strict-child check now genuinely bounds the blast radius it claims to."""
    output_dir = tmp_path / "output"
    store_path = (output_dir / store).resolve()
    assert books_root(output_dir).resolve() not in store_path.parents


# ── encryption: the container is cleartext, the title is not ─────────────────

def test_the_books_container_is_structural(v):
    """It is a constant of the source, like its three siblings — so `ls` on the store stays
    navigable for the person debugging it, who is the owner."""
    assert v._is_structural("output/books")


def test_a_book_title_under_it_is_still_encrypted(v):
    """The whole point of the vault. The container name may be cleartext; what the USER named
    may not be."""
    assert not v._is_structural("output/books/The Silmarillion")


def test_the_title_is_ciphertext_on_disk_and_the_container_is_not(v):
    v.mkdir("output/books/The Silmarillion")
    on_disk = v._map("output/books/The Silmarillion")
    assert on_disk.parent.name == "books", "the container should be readable on the platter"
    assert on_disk.name != "The Silmarillion", "the book's title leaked onto the disk in clear"


def test_chapter_audio_still_lands_in_a_cleartext_mp3_folder(v):
    """⚠️ `output/*/mp3` was written for `output/<title>/mp3` and now has to reach one level
    deeper. It does — fnmatch's `*` crosses `/` — which is why the move needed no new pattern.
    Asserted rather than assumed, because if it silently stopped matching, every chapter would
    land in an encrypted `mp3` directory and nothing would report it."""
    assert v._is_structural("output/books/The Silmarillion/mp3")
    assert v._is_structural("output/books/The Silmarillion/wav")
    assert fnmatch.fnmatchcase("output/books/The Silmarillion/mp3", "output/*/mp3")


def test_no_structural_pattern_claims_the_book_title(v):
    """A pattern that accidentally matched the title would put it on the platter in cleartext.
    Checked against the WHOLE tuple so a future entry cannot open that hole quietly."""
    claimed = [p for p in vault.STRUCTURAL
               if fnmatch.fnmatchcase("output/books/The Silmarillion", p)]
    assert not claimed, f"these STRUCTURAL patterns leak the book title: {claimed}"


# ── the library scan follows the books, not the stores ───────────────────────

def test_scan_library_of_the_books_root_ignores_the_stores(tmp_path):
    """`_book_stems` calls anything with chapter audio a book. Scanning `output/` would offer a
    store as a library entry the moment one grew an `mp3/` folder; scanning `output/books/`
    cannot, because the stores are not in it."""
    output_dir = tmp_path / "output"
    (output_dir / "playground" / "mp3").mkdir(parents=True)
    (output_dir / "playground" / "mp3" / "01.mp3").write_bytes(b"x")
    root = books_root(output_dir)
    (root / "Real Book" / "mp3").mkdir(parents=True)
    (root / "Real Book" / "mp3" / "01.mp3").write_bytes(b"x")

    names = {b["book"] for b in book_state.scan_library(root)}
    assert "Real Book" in names
    assert "playground" not in names, "the clip library was listed as a book"

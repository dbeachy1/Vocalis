"""Verify which fixed logical directory names remain visible in an encrypted store.

Structural routing applies to names only; file contents remain encrypted. Patterns must match full logical paths so nested stores are covered without confusing a user document named `output` with the real `output/` directory.

These names also determine migration and `.gitignore` behavior. Tests check routed roots against both the structural-name registry and ignore rules, and verify that promoting existing files or directories preserves their data.
"""
import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vault
import vault_store

PW = "correct horse battery staple"
TEST_KDF = {"algo": "argon2id", "memory_kib": 8 * 1024, "time_cost": 1, "parallelism": 1}


# Every constant directory the app actually writes into, with the LOGICAL path it really has.
# Traced from the source, not from the design:
#   OUTPUT_DIR      = BASE_DIR/output                  (book_to_audio.py:100)
#   clips           = OUTPUT_DIR/playground            (vocalis_server.py:1996)
#   stems_dir       = OUTPUT_DIR/stems                 (voiceswap.py:182)
#   library_dir     = OUTPUT_DIR/voiceswap             (voiceswap.py:183)
#   stem_uploads    = BASE_DIR/uploads/stems           (voiceswap.py:181)
#   CHUNKS_ROOT     = cache_root()/chunks              (book_to_audio.py:99)
#   preview_dir     = cache_root()/voiceswap_preview   (voiceswap.py:192)
#   AUDIO_CACHE     = cache_root()/audio_cache         (vocalis_server.py:91)
#   enhanced        = cache_root()/enhanced            (enhance.py:270)
CONSTANT_DIRS = [
    "output",
    "output/books",             # 5.3: the container. The <title>/ inside it is NOT constant.
    "output/playground",
    "output/scenes",            # 6.0 §5: the container. The <slug> inside it is user-authored title.
    "output/stems",
    "output/voiceswap",
    "uploads",
    "uploads/songs",
    "uploads/stems",
    "voice_samples",
    "books",
    "chunks",
    "chunks/playground",
    "enhanced",
    "audio_cache",
    "voiceswap_preview",
]

# The user named every one of these. They are the reason the vault exists.
USER_CONTENT = [
    "output/books/The Silmarillion",                # a book title (5.3: under output/books/)
    'output/playground/TestVoice',                  # a voice the user added
    'output/playground/TestVoice/hello_there_ab12cd34.mp3',
    "output/stems/my_secret_song_a1b2",
    # 6.0 §5.1: a scene's slug is the title the user typed, and its manifest is the transcript.
    # This is the direction that matters — `output/scenes` reaching one component further
    # would write the name of a private conversation onto the platter in cleartext.
    "output/scenes/Test_Character_1_Ferry_ab12cd34.mp3",
    "output/scenes/Test_Character_1_Ferry_ab12cd34.yaml",
    "uploads/songs/my_secret_song.mp3",
    'voice_samples/TestVoice.wav',
    "books/The Silmarillion.epub",
    "chunks/playground/0123456789ab",               # the identity hash of a render
    "output/books/The Silmarillion/mp3/01_Of the Beginning.mp3",
]


@pytest.fixture
def v(tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    vlt, _recovery = vault.Vault.create(tmp_path / "store", tmp_path / "keys.yaml", PW)
    return vlt


@pytest.mark.parametrize("logical", CONSTANT_DIRS)
def test_every_constant_store_dir_is_structural(v, logical):
    """The anti-rot test. A store added in 5.1 fails HERE rather than turning up as gibberish
    on the day someone has to read the disk by hand."""
    assert v._is_structural(logical), (
        f"{logical!r} is a CONSTANT of the source and should stay cleartext on disk, but it "
        f"is being encrypted. If you meant that, this list is the place to say so.")


@pytest.mark.parametrize("logical", USER_CONTENT)
def test_nothing_the_user_named_is_structural(v, logical):
    """The direction that actually matters. A structural pattern that reaches one component
    too far writes the user's words onto the platter in cleartext."""
    assert not v._is_structural(logical), f"{logical!r} is USER CONTENT and must be encrypted"


def test_a_bare_name_does_not_match_a_nested_path(v):
    """A structural pattern must match the full logical path. Verify that a bare `playground` entry does not protect `output/playground`.
    """
    lone = vault.Vault(v.store_root, v.keyfile, structural=("playground",))
    assert lone._is_structural("playground")
    assert not lone._is_structural("output/playground"), (
        "a bare structural name matched a nested path — then the real bug was somewhere else, "
        "and the fix in STRUCTURAL was wrong")


def test_the_constant_dirs_are_cleartext_on_the_real_disk(v):
    """Not "is_structural returns True" — that is the code agreeing with itself. Write a file
    down each path and go LOOK at the physical tree."""
    v.write_bytes('output/playground/TestVoice/hi_ab12cd34.mp3', b"ID3 audio")
    v.write_bytes("uploads/songs/secret.mp3", b"ID3 audio")
    v.write_bytes("voiceswap_preview/abc.mp3", b"ID3 audio")

    assert (v.store_root / "output" / "playground").is_dir(), "output/playground is not navigable"
    assert (v.store_root / "uploads" / "songs").is_dir(), "uploads/songs is not navigable"
    assert (v.store_root / "voiceswap_preview").is_dir(), "voiceswap_preview is not navigable"

    # ...and the names UNDER them are not readable.
    names = [p.name for p in (v.store_root / "output" / "playground").iterdir()]
    assert 'TestVoice' not in names, "the voice's name is on the platter in cleartext"
    songs = [p.name for p in (v.store_root / "uploads" / "songs").iterdir()]
    assert "secret.mp3" not in songs, "the song's filename is on the platter in cleartext"


# Install-root files are user data inside a Git repository. Derive structural-name and ignore checks from ROUTES so newly routed files cannot be omitted from either contract.

def test_every_routed_root_FILE_is_structural():
    """Every routed install-root file must have a structural name so its `.gitignore` entry can match it.
    """
    missing = [f for f in vault_store.ROUTES["install"]["files"]
               if f not in vault.STRUCTURAL_FILES]
    assert not missing, (
        f"{missing} are routed into the install-root vault but absent from vault.STRUCTURAL_FILES, "
        f"so each gets a CIPHERTEXT name in the install root — which is a git repo. The name is "
        f"unpredictable, so no .gitignore line can cover it, and one `git add -A` commits it.")


def test_every_routed_root_FILE_is_gitignored():
    """Every routed install-root file must have an ignore rule to keep user data out of the install repository.
    """
    ignored = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    lines = {ln.strip() for ln in ignored if ln.strip() and not ln.lstrip().startswith("#")}
    missing = [f for f in vault_store.ROUTES["install"]["files"] if f not in lines]
    assert not missing, (
        f"{missing} live at the install root, which is a git repo, and hold user content — "
        f"add each to .gitignore by name.")


def test_every_routed_root_TREE_is_structural_and_gitignored():
    """Every routed install-root store must be both structural and gitignored. Checking both properties together catches encrypted names that ignore rules cannot match and visible store names that could be added to the repository.
    """
    ignored = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    lines = {ln.strip() for ln in ignored if ln.strip() and not ln.lstrip().startswith("#")}
    trees = vault_store.ROUTES["install"]["trees"]
    unignored = [t for t in trees if not {t, t + "/", "/" + t, "/" + t + "/"} & lines]
    assert not unignored, (
        f"{unignored} are routed stores at the install root, which is a git repo, and they hold "
        f"user content — add each to .gitignore by name.")
    unstructural = [t for t in trees if t not in vault.STRUCTURAL]
    assert not unstructural, (
        f"{unstructural} are routed into the install-root vault but absent from vault.STRUCTURAL, "
        f"so each gets a CIPHERTEXT DIRECTORY NAME in the install root — which is a git repo. "
        f"The .gitignore line for it then matches nothing, and the name is unpredictable, so no "
        f"pattern can be written that would.")


@pytest.mark.parametrize("name", vault.STRUCTURAL_FILES)
def test_the_routed_root_files_are_structural(v, name):
    """What ROUTES always claimed, now actually true — and required for .gitignore to work."""
    assert v._is_structural(name), (
        f"{name!r} gets an ENCRYPTED name on disk, so it lands in the install root — which is "
        f"a git repo — as an unpredictable untracked blob that no .gitignore can match.")


@pytest.mark.parametrize("name", vault.STRUCTURAL_FILES)
def test_a_structural_name_does_NOT_mean_plaintext_contents(v, name):
    """Structural routing exposes the logical filename only. Verify that file bytes remain encrypted and still round-trip through the vault.
    """
    secret = b"kobold_adminpassword: hunter2\nplayground_text: her name was Test Character\n"
    v.write_bytes(name, secret)

    on_disk = (v.store_root / name)
    assert on_disk.is_file(), "the structural name did not land in the clear"
    raw = on_disk.read_bytes()
    assert raw != secret, "THE CONTENTS ARE IN PLAINTEXT ON THE PLATTER"
    assert b"hunter2" not in raw and b"Test Character" not in raw, "user content leaked into the file"
    assert v.read_bytes(name) == secret, "it no longer round-trips through the vault"


@pytest.mark.parametrize("name", vault.STRUCTURAL_FILES)
def test_a_pre_existing_encrypted_file_is_MIGRATED_not_orphaned(tmp_path, monkeypatch, name):
    """Promoting an encrypted filename to a structural name must move the existing file and preserve its readable contents. The second migration pass must be a no-op.
    """
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    old_style = tuple(p for p in vault.STRUCTURAL if p != name)
    store, keys = tmp_path / "store", tmp_path / "keys.yaml"

    vault.Vault.create(store, keys, PW)                   # the store itself is version-neutral
    before = vault.Vault(store, keys, structural=old_style)   # ...but this VIEW predates the promotion
    before.unlock_with_password(PW)
    payload = b"adminpassword: hunter2\n"
    before.write_bytes(name, payload)
    enc_name = before._enc_name(name, "")
    assert (store / enc_name).is_file(), "precondition failed — the old name was not encrypted"
    assert not (store / name).exists()

    after = vault.Vault(store, keys)                      # the CURRENT structural tuple
    after.unlock_with_password(PW)
    assert after.migrate_structural_names() == [name]

    assert (store / name).is_file(), "the file did not move to its structural name"
    assert not (store / enc_name).exists(), "the old encrypted name was left behind"
    assert after.read_bytes(name) == payload, "THE CONTENT WAS ORPHANED BY THE PROMOTION"
    assert after.migrate_structural_names() == [], "not idempotent — it moved something twice"


@pytest.mark.parametrize("name", ["wbedit", "voice_candidates"])
def test_a_pre_existing_encrypted_DIRECTORY_is_migrated_with_its_contents(tmp_path, monkeypatch,
                                                                          name):
    """Promoting a directory name must preserve the directory contents and their logical paths. Verify the data after migration and require a second pass to be a no-op.
    """
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    old_style = tuple(p for p in vault.STRUCTURAL if p != name)
    store, keys = tmp_path / "store", tmp_path / "keys.yaml"

    vault.Vault.create(store, keys, PW)
    before = vault.Vault(store, keys, structural=old_style)   # the view that predates 7.0-m7
    before.unlock_with_password(PW)
    doc = b'{"name": "Blackwood", "entries": ["his own prose"]}'
    before.write_bytes(f"{name}/doc-1.json", doc)
    enc_dir = before._enc_name(name, "")
    assert (store / enc_dir).is_dir(), "precondition failed — the directory name was not encrypted"
    assert not (store / name).exists()

    after = vault.Vault(store, keys)                          # the CURRENT structural tuple
    after.unlock_with_password(PW)
    assert after.migrate_structural_names() == [name]

    assert (store / name).is_dir(), "the directory did not move to its structural name"
    assert not (store / enc_dir).exists(), "the old encrypted name was left behind"
    assert after.read_bytes(f"{name}/doc-1.json") == doc, (
        "THE DOCUMENTS WERE ORPHANED BY THE PROMOTION — a child's name must derive from the "
        "LOGICAL parent, so renaming the container cannot reach them")
    # ...and the child is still ciphertext-named inside the now-cleartext directory. Structural
    # is a statement about the NAME of that one entry and nothing below it.
    assert "doc-1.json" not in [p.name for p in (store / name).iterdir()]
    assert after.migrate_structural_names() == [], "not idempotent — it moved something twice"


def test_migration_refuses_to_guess_when_both_names_exist(tmp_path, monkeypatch):
    """Two files, one logical name: clobbering the live one is the worst available move."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    name = "ui_state.yaml"
    old_style = tuple(p for p in vault.STRUCTURAL if p != name)
    store, keys = tmp_path / "store", tmp_path / "keys.yaml"

    vault.Vault.create(store, keys, PW)
    before = vault.Vault(store, keys, structural=old_style)
    before.unlock_with_password(PW)
    before.write_bytes(name, b"the OLD one")
    enc_name = before._enc_name(name, "")

    after = vault.Vault(store, keys)
    after.unlock_with_password(PW)
    after.write_bytes(name, b"the NEW one")               # now BOTH exist

    assert after.migrate_structural_names() == [], "it overwrote a live file"
    assert (store / enc_name).is_file(), "the pre-migration copy was destroyed"
    assert after.read_bytes(name) == b"the NEW one"

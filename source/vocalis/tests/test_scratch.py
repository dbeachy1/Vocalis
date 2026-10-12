"""The scratch boundary — where plaintext is allowed to touch disk (5.0 §8, M3).

The design's safety argument rests on two properties of this boundary, and M0 found BOTH of
them to be goals rather than facts:

  1. **The scratch only ever holds music — never the words.** False twice over:
     `_concat_list.txt` handed ffmpeg a machine-readable table of contents of the book, and a
     Playground clip — named from the user's PROMPT — rode into `_datasets/` where Applio
     enumerated it for eighteen hours. **The words arrived as FILENAMES.**
  2. **Nothing outlives the job that needed it.** Every cleanup was a `finally`, which a
     SIGKILL, an OOM kill or a power cut does not run.

These tests are what make both true rather than hoped-for. They are cheap, and the thing they
protect is the reason the whole project exists.
"""
import os
from pathlib import Path

import pytest

import scratch


def test_a_scratch_name_spells_nothing(tmp_path):
    """The property, stated as bluntly as it can be. The caller is ENCOURAGED to be
    descriptive — the key is hashed, so it may safely carry the user's prose — and the
    filesystem still learns nothing from it."""
    prompt = "she told me she had never loved anyone before the war"
    p = scratch.path_for(tmp_path, f"/voice_training/{prompt}.mp3", tag="prep", suffix=".wav")

    assert "she" not in p.name and "war" not in p.name and "loved" not in p.name
    assert p.suffix == ".wav", "the suffix must survive — ffmpeg and Demucs sniff format by it"
    assert len(p.stem) == 16 and all(c in "0123456789abcdef" for c in p.stem)


def test_the_name_matches_the_vault_seam_by_construction():
    """scratch.py and vault.decrypt_to_scratch must produce the SAME shape, so that when
    M6/M7 lands, plaintext made by this module and plaintext made by the vault are
    indistinguishable on disk — one shape, one sweep, one thing to reason about.

    Recomputed by hand here rather than by calling either one, so the test cannot agree with
    a mistake in the thing it is checking."""
    import hashlib
    key = "/output/playground/some clip.mp3"
    expect = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16] + ".mp3"
    assert scratch.opaque_name(key, ".mp3") == expect


def test_the_same_source_under_two_tags_is_two_files(tmp_path):
    """A stage that converts and then enhances holds BOTH at once. If the tag did not enter
    the hash they would be one path, and the enhancer's input would be its own output."""
    a = scratch.path_for(tmp_path, "/x/clip.mp3", tag="convert")
    b = scratch.path_for(tmp_path, "/x/clip.mp3", tag="enhanced")
    assert a != b


def test_a_scratch_file_is_deleted_even_when_the_body_raises(tmp_path):
    """Plaintext must not outlive the stage that needed it — including when the stage fails,
    which is exactly when a hand-written cleanup gets forgotten."""
    seen = None
    with pytest.raises(RuntimeError):
        with scratch.file(tmp_path, "voice-upload") as p:
            seen = p
            p.write_bytes(b"the raw uploaded recording")
            assert p.is_file()
            raise RuntimeError("the transcode failed")
    assert seen is not None and not seen.exists()


def test_a_scratch_directory_is_removed_with_its_contents(tmp_path):
    """Demucs writes a TREE, not a file — and `<model>/<song stem>/` is the SONG TITLE
    unless what we handed it was already opaque."""
    with scratch.directory(tmp_path, "demucs|job1") as d:
        (d / "htdemucs").mkdir()
        (d / "htdemucs" / "vocals.wav").write_bytes(b"RIFF")
        assert d.is_dir()
        kept = d
    assert not kept.exists()


def test_two_concurrent_jobs_do_not_share_one_scratch_file(tmp_path):
    """scratch.file() salts with a uuid on purpose. Two jobs enhancing the same source at
    the same moment must not be handed the same path — that is not a cache, it is a race,
    and one job would be reading the other's half-written audio."""
    with scratch.file(tmp_path, "same-source") as a, \
         scratch.file(tmp_path, "same-source") as b:
        assert a != b


def test_sweep_removes_what_a_sigkill_left_behind(tmp_path):
    """The guarantee, as opposed to the promise. A `finally` covers cancel and exception; it
    does NOT cover SIGKILL, the OOM killer, `systemctl restart` or a power cut — and what
    those leave in the scratch is PLAINTEXT: a decrypted training clip, a dry swapped vocal,
    a chapter's audio. M2a added exactly this sweep for voiceswap's workdir after finding
    that nothing in the repo swept it anywhere."""
    (tmp_path / "deadbeefdeadbeef.wav").write_bytes(b"orphaned plaintext")
    orphan_dir = tmp_path / "cafebabecafebabe"
    orphan_dir.mkdir()
    (orphan_dir / "vocals.wav").write_bytes(b"RIFF")

    assert scratch.sweep(tmp_path) == 2
    assert list(tmp_path.iterdir()) == []
    assert scratch.sweep(tmp_path) == 0          # idempotent


def test_sweep_on_a_scratch_that_does_not_exist_yet(tmp_path):
    """First boot on a fresh box. Must not raise."""
    assert scratch.sweep(tmp_path / "never-created") == 0


def test_sweep_does_not_eat_the_bulk_root(tmp_path):
    """Scratch cleanup must leave the configured bulk-data root intact."""
    (tmp_path / "deadbeefdeadbeef.wav").write_bytes(b"orphaned plaintext")
    bulk_root = tmp_path / scratch.BULK_SUBDIR
    (bulk_root / "_staging" / "enhance").mkdir(parents=True)
    picked = bulk_root / "_staging" / "enhance" / "my_clip.wav"
    picked.write_bytes(b"RIFF picked, not yet batched")

    assert scratch.sweep(tmp_path) == 1           # the orphan — and ONLY the orphan
    assert picked.read_bytes() == b"RIFF picked, not yet batched"
    assert not (tmp_path / "deadbeefdeadbeef.wav").exists()


def test_the_bulk_root_the_sweep_skips_is_the_one_bulk_actually_uses(tmp_path, monkeypatch):
    """The skip is a STRING MATCH against a directory name, so it is only as good as the two
    sides agreeing — and they are in different modules. Pin them to each other: if bulk ever
    renames its root, this fails instead of the staging area quietly emptying itself at the
    next restart, which is a bug nobody would trace back to a renamed constant."""
    import bulk
    monkeypatch.delenv("VOCALIS_BULK_DIR", raising=False)
    monkeypatch.setenv(scratch.ENV_VAR, str(tmp_path))

    root = bulk.resolve_config().scratch_root
    assert root.parent == tmp_path                # under the scratch, not the OS temp dir
    assert root.name in (scratch.BULK_SUBDIR,)    # …and by the name sweep() spares


def test_the_root_is_a_config_value_and_the_env_wins(tmp_path, monkeypatch):
    """An explicit environment root overrides the configured scratch root."""
    monkeypatch.delenv(scratch.ENV_VAR, raising=False)
    assert scratch.scratch_root({}) == scratch.default_root()
    assert scratch.scratch_root({"scratch": str(tmp_path / "from-settings")}) \
        == tmp_path / "from-settings"

    monkeypatch.setenv(scratch.ENV_VAR, str(tmp_path / "from-env"))
    assert scratch.scratch_root({"scratch": str(tmp_path / "from-settings")}) \
        == tmp_path / "from-env", "the env var must win, as it does for every other path"


def test_the_default_is_under_data_root_not_tempfile():
    """The default scratch root follows the configured data mount, not OS temp."""
    import tempfile
    from vocalis.runtime import paths
    default = scratch.default_root().resolve()

    assert default == paths.SCRATCH_DIR.resolve()
    assert default != Path(tempfile.gettempdir()).resolve()


def test_no_module_in_src_uses_the_os_temp_dir():
    """The repo-level guard, and the reason it exists: the four `tempfile` sites M0 found
    were each individually defensible and collectively a plaintext store nobody owned.

      * the WHOLE BOOK, copied byte-for-byte on every parse   (book_to_audio.open_docx)
      * the RAW UPLOADED VOICE RECORDING, delete=False        (now vocalis/web/voices.py::_save_voice)
      * ffmpeg staging for two training-clip imports          (vocalis_server)
      * EVERY SillyTavern MP3 response, round-tripped         (vocalis_server)

    None of them needed the OS temp dir; two needed no disk at all. This test is what stops
    the fifth one — because the fifth one will also look defensible.

    If you are here because this test failed: you want `scratch.file()` /
    `scratch.directory()`, or — better — a pipe.

    🔴 IT PARSES, IT DOES NOT GREP, and it learned that the hard way — twice in one project.
    The old version stripped `#` comments and text-matched the rest, so it could not tell an
    `import tempfile` from a DOCSTRING EXPLAINING WHY YOU MUST NOT IMPORT TEMPFILE. Which means
    the more carefully a module documented this ban, the more certainly it failed the test
    enforcing it. (`SPEC_5_0_M5` §2's blind-`except` tripwire had the identical bug and was
    counting its own prose: 101 by substring, 86 real.)

    A tripwire that fires on its own documentation gets its documentation deleted, or gets
    itself deleted. Either way the ban is what you lose."""
    import ast
    src = Path(__file__).resolve().parent.parent / "src"
    banned = {"tempfile", "mkstemp", "mkdtemp", "gettempdir", "NamedTemporaryFile",
              "TemporaryDirectory"}
    offenders = []
    # rglob — 5.1-P3.3. Flat, the ban stopped applying to a module the moment it moved into
    # `src/vocalis/`, silently: this test asserts "no offenders found", which an empty walk
    # satisfies perfectly and forever. The skip below is matched on the path relative to src/
    # so it exempts THE scratch.py that owns the ban, not any future one in a subpackage.
    for p in sorted(q for q in src.rglob("*.py") if "__pycache__" not in q.parts):
        if p.relative_to(src).as_posix() == "scratch.py":   # documents the ban; does not use it
            continue
        # utf-8-sig: a BOM is invisible to Python's importer and a SyntaxError to ast.parse.
        tree = ast.parse(p.read_text(encoding="utf-8-sig"), filename=str(p))
        for node in ast.walk(tree):
            hit = None
            if isinstance(node, ast.Import):
                hit = next((a.name for a in node.names if a.name.split(".")[0] == "tempfile"), None)
            elif isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "tempfile":
                hit = f"from {node.module}"
            elif isinstance(node, ast.Attribute) and node.attr in banned:
                hit = node.attr
            elif isinstance(node, ast.Name) and node.id in banned:
                hit = node.id
            if hit:
                offenders.append(f"{p.relative_to(src).as_posix()}:{node.lineno}: {hit}")
    assert not offenders, (
        "the OS temp dir is not a scratch — it is outside everything 5.0 encrypts:\n  "
        + "\n  ".join(offenders))


# ── The scratch root may be boot-ephemeral (5.0 §8.3) ───────────────────────
#
# It is re-keyed from /dev/urandom and re-mkfs'd on every boot, so it is EMPTY on startup.
# It survives `systemctl restart` (the 18h training needs that); it does not survive a
# reboot (which killed the training anyway). Nothing that must outlive a reboot may live
# there — and the thing that makes this dangerous is that parking Applio's logs/ here looks
# like an obvious tidy-up now that /scratch exists. It would vaporize every training's
# checkpoints at every reboot, and Resume is built entirely on those surviving (§8.6).

def test_every_consumer_recreates_its_own_tree(tmp_path):
    """/scratch comes up EMPTY and re-formatted. Nothing may assume a directory it created
    last run is still there — including the scratch root itself."""
    gone = tmp_path / "wiped-by-the-reboot"
    assert not gone.exists()

    with scratch.file(gone, "voice-upload", ".wav") as p:
        p.write_bytes(b"x")
        assert p.is_file(), "scratch.file must create the root it was handed"
    with scratch.directory(gone, "demucs") as d:
        assert d.is_dir(), "scratch.directory must create the root it was handed"
    assert scratch.sweep(gone / "never-existed") == 0     # and sweeping a missing root is fine


def test_retained_stems_workdir_is_scratch_and_shared_data_stays_durable(tmp_path, monkeypatch):
    """Stems work is transient; retained song and Speech files use the mounted data root."""
    import stemsplit
    from vocalis.runtime import configs, paths, settings

    monkeypatch.setenv(scratch.ENV_VAR, str(tmp_path / "scratch"))
    root = tmp_path / "scratch"
    code_root, data_root, cache_root = (tmp_path / "code", tmp_path / "data",
                                        tmp_path / "cache")
    monkeypatch.setattr(paths, "BASE_DIR", code_root)
    monkeypatch.setattr(paths, "DATA_DIR", data_root)
    monkeypatch.setattr(settings, "load_app_settings", lambda: {})
    monkeypatch.setattr(configs, "cache_root", lambda: cache_root)
    monkeypatch.setattr(configs, "OUTPUT_DIR", code_root / "output")

    stems_cfg = stemsplit.resolve_config({}, code_root, code_root / "output",
                                         cache_root, data_dir=data_root)
    assert root in stems_cfg.work_root.parents
    assert stems_cfg.songs_dir == data_root / "uploads" / "songs"
    assert stems_cfg.stem_uploads_dir == data_root / "uploads" / "stems"
    assert stems_cfg.leadvocal_scripts == code_root / "scripts" / "leadvocal"
    assert configs.song_cfg().songs_dir == data_root / "uploads" / "songs"
    assert configs.speech_cfg().training_dir == data_root / "voice_training"

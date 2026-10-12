"""Exercise staging plaintext reference audio where ACE-Step can open it. The backend returns None for unreadable, silent, or otherwise failed input, so each test verifies that a selected reference arrives as a nonempty file in the injected backend temp root or fails clearly. Every test injects stage_root; it must not depend on a host default or HOME-based cache location."""
import pytest

from vocalis.runtime import acestage


def _src(tmp_path, name="vocals.opus", data=b"OggS-not-really-audio"):
    """A plaintext source file. Content is irrelevant here — nothing in `acestage` decodes."""
    p = tmp_path / "store" / "set-a"
    p.mkdir(parents=True, exist_ok=True)
    f = p / name
    f.write_bytes(data)
    return f


# ── the name ────────────────────────────────────────────────────────────────────────────────

def test_the_staged_name_spells_nothing_about_the_song(tmp_path):
    """🔴 THE WORDS MUST NEVER ARRIVE AS FILENAMES (`src/scratch.py` §1). A stem set's directory
    name carries the song title, and the staging directory is shared with a process we do not own.
    """
    src = _src(tmp_path, "vocals.opus")
    staged = acestage.stage(src, root=tmp_path / "stage")
    assert "vocals" not in staged
    assert "set-a" not in staged


def test_the_suffix_survives_because_the_backend_sniffs_format_by_it(tmp_path):
    """soundfile picks its decoder from the extension before it ever opens the file."""
    for ext in (".opus", ".wav", ".flac"):
        staged = acestage.stage(_src(tmp_path, f"vocals{ext}"), root=tmp_path / "stage")
        assert staged.endswith(ext)


def test_the_name_is_deterministic_because_two_cards_share_one_staged_file(tmp_path):
    """🔴 THE REASON STAGED FILES ARE SWEPT BY AGE RATHER THAN DELETED ON COMPLETION.

    One Generate press makes one job PER CARD and both carry the same reference. A non-deterministic
    name would stage the same clip twice per press; a per-job delete on a deterministic one would
    pull the file out from under the sibling still rendering. The design doc's §6 sentence ("delete
    on job completion") is right for `src_audio_path` and wrong here — see the module header.
    """
    src = _src(tmp_path)
    a = acestage.stage(src, root=tmp_path / "stage")
    b = acestage.stage(src, root=tmp_path / "stage")
    assert a == b


# ── the guarantee ───────────────────────────────────────────────────────────────────────────

def test_a_staged_path_is_confirmed_to_exist_and_be_non_empty(tmp_path):
    staged = acestage.stage(_src(tmp_path), root=tmp_path / "stage")
    from pathlib import Path
    assert Path(staged).is_file() and Path(staged).stat().st_size > 0


def test_a_missing_source_raises_rather_than_returning_a_path(tmp_path):
    """🔴 The backend swallows a bad reference without a word, so this layer must not. Returning
    an unverified path here would surface as "the reference did nothing", with nothing to explain
    it — the same shape as the `?.addEventListener` bug that painted a button which did nothing."""
    with pytest.raises((FileNotFoundError, OSError)):
        acestage.stage(tmp_path / "store" / "gone.opus", root=tmp_path / "stage")


def test_an_empty_source_is_refused_because_the_backend_would_ignore_it_silently(tmp_path):
    """A zero-byte file decodes to nothing, `is_silence` catches it, and the render comes out with
    no reference. Cheaper to refuse it here than to let someone wonder why."""
    with pytest.raises(OSError):
        acestage.stage(_src(tmp_path, data=b""), root=tmp_path / "stage")


def test_restaging_repairs_a_truncated_file_rather_than_trusting_the_name(tmp_path):
    """The deterministic-name fast path must check the SIZE, not just existence — a previous run
    killed mid-copy leaves a zero-byte file whose name is perfectly correct."""
    src = _src(tmp_path)
    staged = acestage.stage(src, root=tmp_path / "stage")
    from pathlib import Path
    Path(staged).write_bytes(b"")
    again = acestage.stage(src, root=tmp_path / "stage")
    assert Path(again).stat().st_size > 0


def test_the_staging_directory_is_created_rather_than_assumed(tmp_path):
    """Create the backend temp directory on demand, including on development systems without an installed ACE-Step backend. Each consumer should create the tree it needs."""
    staged = acestage.stage(_src(tmp_path), root=tmp_path / "deep" / "not" / "there")
    from pathlib import Path
    assert Path(staged).is_file()


# ── the sweep ───────────────────────────────────────────────────────────────────────────────

def test_the_sweep_takes_only_names_this_module_minted(tmp_path):
    """🔴 `api_audio/` IS THE BACKEND'S AND ONE OF ITS FILES IS WHAT `fetch_audio` IS ABOUT TO
    COLLECT. A sweep that walked everything in the staging directory would destroy finished
    renders. Only `<16 hex><suffix>` is ours."""
    root = tmp_path / "stage"
    root.mkdir()
    (root / "api_audio").mkdir()
    (root / "api_audio" / "task-123.flac").write_bytes(b"x")
    theirs = root / "somebody-elses-render.flac"
    theirs.write_bytes(b"x")
    import os
    import time
    old = time.time() - 100 * 3600
    for p in (root / "api_audio" / "task-123.flac", theirs):
        os.utime(p, (old, old))

    acestage.sweep(root=root, ttl_h=1)

    assert (root / "api_audio" / "task-123.flac").is_file()
    assert theirs.is_file()


def test_the_sweep_takes_our_own_files_once_they_are_old(tmp_path):
    import os
    import time
    from pathlib import Path
    root = tmp_path / "stage"
    staged = Path(acestage.stage(_src(tmp_path), root=root))
    old = time.time() - 100 * 3600
    os.utime(staged, (old, old))
    assert acestage.sweep(root=root, ttl_h=1) == 1
    assert not staged.exists()


def test_the_sweep_leaves_a_freshly_staged_file_alone(tmp_path):
    from pathlib import Path
    root = tmp_path / "stage"
    staged = Path(acestage.stage(_src(tmp_path), root=root))
    assert acestage.sweep(root=root, ttl_h=24) == 0
    assert staged.is_file()


def test_reusing_a_reference_keeps_it_out_of_the_sweep(tmp_path):
    """A reference is picked once and rendered with fifty times. The fast path touches its mtime so
    a clip in daily use is never the oldest thing in the directory."""
    import os
    import time
    from pathlib import Path
    root = tmp_path / "stage"
    src = _src(tmp_path)
    staged = Path(acestage.stage(src, root=root))
    old = time.time() - 100 * 3600
    os.utime(staged, (old, old))
    acestage.stage(src, root=root)                 # used again — the fast path
    assert acestage.sweep(root=root, ttl_h=1) == 0


def test_the_sweep_tolerates_a_root_that_does_not_exist(tmp_path):
    """It runs at boot, and on a box with no ACE-Step the directory is simply absent."""
    assert acestage.sweep(root=tmp_path / "never-made", ttl_h=1) == 0


# ── the token ───────────────────────────────────────────────────────────────────────────────

def test_no_token_is_the_empty_string_and_not_a_lookup(tmp_path):
    """🔴 "" IS THE NO-REFERENCE VALUE ALL THE WAY DOWN. `validate_audio_path` opens with
    `if not path: return None`, so the key is safe to send on every job — which is what lets
    `acegen` obey its own "every parameter explicit" rule."""
    assert acestage.stage_reference("") == ""
    assert acestage.stage_reference(None) == ""


def test_an_unknown_token_kind_is_not_treated_as_a_stem(tmp_path):
    """The token is `<kind>:<id>` because m3 adds `song:` and `cand:` against the same resolver.
    A kind this version does not know must not fall through to the stem lookup."""
    assert acestage.resolve("song:whatever") is None
    assert acestage.resolve("nonsense") is None
    assert acestage.resolve("") is None


def test_a_deleted_stem_set_raises_rather_than_rendering_without_it(monkeypatch):
    """🔴 A TEMPLATE OUTLIVES THE CLIP IT NAMES. That is exactly why the template stores a token
    and not a path — and it means "the set is gone" is a normal thing to hit, which the user must
    be told about rather than discovering by ear."""
    monkeypatch.setattr(acestage, "resolve", lambda token, cfg=None: None)
    with pytest.raises(FileNotFoundError):
        acestage.stage_reference("stem:long-gone")


# ── the root ────────────────────────────────────────────────────────────────────────────────

def test_the_stage_root_default_is_the_backends_tempdir(monkeypatch):
    """🔴 THERE IS EXACTLY ONE DIRECTORY THAT WORKS. `validate_audio_path` 400s on any absolute
    path outside `tempfile.gettempdir()`, and both ACE units set `ACESTEP_TMPDIR` to this.

    ⚠️ The env var is cleared first — `stage_root({})` still reads it, so on a box that exports
    `VOCALIS_ACESTEP_STAGE_DIR` this was a test of host configuration, not of the default. Its
    neighbor two tests down already knew that.
    """
    monkeypatch.delenv(acestage.ENV_VAR, raising=False)
    assert acestage.stage_root({}).as_posix() == "/ai-output/acestep-tmp"


def test_the_env_var_wins_over_settings(monkeypatch):
    """Same precedence as every other studio path in this app: env → app_settings → default."""
    monkeypatch.setenv(acestage.ENV_VAR, "/tmp/from-env")
    assert acestage.stage_root({"acestep": {"stage_dir": "/tmp/from-settings"}}).as_posix() \
        == "/tmp/from-env"


def test_a_hand_edited_settings_block_does_not_raise(monkeypatch):
    """`acestep: "oops"` in app_settings.yaml must not take the tab down — same guard as
    `acestep.configured`."""
    monkeypatch.delenv(acestage.ENV_VAR, raising=False)
    assert acestage.stage_root({"acestep": "oops"}).as_posix() == "/ai-output/acestep-tmp"


# ── 8.1-m3: what Remix and Repaint can work FROM ────────────────────────────────────────────

def test_a_source_token_kind_this_build_does_not_know_is_refused_not_guessed(tmp_path):
    """The token is `<kind>:<id>` so m4 can add more against the same call. A kind that means
    nothing here must not fall through to some other kind's lookup."""
    with pytest.raises(FileNotFoundError):
        acestage.stage_source("wat:123", root=tmp_path / "stage")


def test_no_source_is_the_empty_string(tmp_path):
    assert acestage.stage_source("", root=tmp_path / "stage") == ""
    assert acestage.stage_source(None, root=tmp_path / "stage") == ""


def test_a_stem_is_a_legitimate_source_as_well_as_a_reference(monkeypatch, tmp_path):
    """"Remix my isolated vocal" is a real thing to want, and it costs nothing to allow because
    the reference resolver already answers for that token kind."""
    src = _src(tmp_path)
    monkeypatch.setattr(acestage, "resolve", lambda token, cfg=None: src)
    got = acestage.stage_source("stem:set-a", root=tmp_path / "stage")
    from pathlib import Path
    assert Path(got).is_file()


def test_a_candidate_that_has_gone_says_so_rather_than_500ing(monkeypatch, tmp_path):
    """🔴 NOT SURVIVING A RESTART IS WHAT A CANDIDATE IS. The tray offers them as sources anyway,
    because the song you are looking at right now is the most useful source there is — so the
    failure has to be a sentence the user can act on."""
    from vocalis.runtime import jobs as rt_jobs
    monkeypatch.setattr(rt_jobs, "JOBS", {})
    with pytest.raises(FileNotFoundError, match="do not survive"):
        acestage.stage_source("cand:nosuchjob", root=tmp_path / "stage")


def test_a_candidate_still_rendering_is_refused_rather_than_staged_empty(monkeypatch, tmp_path):
    from vocalis.runtime import jobs as rt_jobs
    import threading

    class _J:
        kind, id, status = "acestep", "j1", "running"
        detail = {"audio": [], "url": None}
        lock = threading.RLock()
    monkeypatch.setattr(rt_jobs, "JOBS", {"j1": _J()})
    with pytest.raises(FileNotFoundError, match="has not finished"):
        acestage.stage_source("cand:j1", root=tmp_path / "stage")


def test_a_candidate_is_fetched_over_http_because_it_is_not_ours(monkeypatch, tmp_path):
    """⚠️ THE TWO SOURCE KINDS TAKE DIFFERENT PATHS AND THE DESIGN SAYS WHY. A library song is a
    file Vocalis owns and decrypts; a candidate lives in the BACKEND's own outputs and the only
    way to it is `fetch_audio`. Nothing is stored until Save, by design."""
    from vocalis.runtime import jobs as rt_jobs
    import threading

    class _J:
        kind, id, status = "acestep", "j1", "done"
        detail = {"audio": ["/remote/out/song.flac"], "url": "http://127.0.0.1:7683"}
        lock = threading.RLock()
    monkeypatch.setattr(rt_jobs, "JOBS", {"j1": _J()})
    calls = []
    got = acestage.stage_source("cand:j1", root=tmp_path / "stage",
                                fetch=lambda url, path: (calls.append((url, path)), b"FLACfake")[1])
    from pathlib import Path
    assert Path(got).read_bytes() == b"FLACfake"
    assert calls == [("http://127.0.0.1:7683", "/remote/out/song.flac")]
    assert got.endswith(".flac"), "the suffix decides the decoder, same as every other staged file"

    # Pressing Remix twice on the same candidate must reuse the one file, not fetch it again.
    calls.clear()
    again = acestage.stage_source("cand:j1", root=tmp_path / "stage",
                                  fetch=lambda url, path: pytest.fail("re-fetched a staged file"))
    assert again == got


def test_an_empty_fetch_is_refused_because_the_backend_would_ignore_it_silently(monkeypatch,
                                                                                tmp_path):
    from vocalis.runtime import jobs as rt_jobs
    import threading

    class _J:
        kind, id, status = "acestep", "j1", "done"
        detail = {"audio": ["/remote/out/song.flac"], "url": "http://127.0.0.1:7683"}
        lock = threading.RLock()
    monkeypatch.setattr(rt_jobs, "JOBS", {"j1": _J()})
    with pytest.raises(OSError):
        acestage.stage_source("cand:j1", root=tmp_path / "stage", fetch=lambda url, path: b"")


# ── the seed rides with every source that has one (8.2.6) ───────────────────────────────────

def test_every_source_that_has_a_seed_carries_it_so_two_takes_can_be_told_apart(monkeypatch):
    """Include the seed in candidate display labels so takes with identical titles remain distinguishable. Keep label as the plain title because it is also used for the saved name and unavailable-candidate message."""
    import threading
    from vocalis.runtime import jobs as rt_jobs

    class _Song:
        id, name, seed = "abc123", 'Sample Track One', 42832463

    class _J:
        kind, id, status = "acestep", "j9", "done"
        detail = {"audio": ["/remote/out/song.flac"], "url": "http://127.0.0.1:7683",
                  "title": 'Sample Track One', "seed": 910791439}
        lock = threading.RLock()

    import vocalis.runtime.acelib as acelib
    monkeypatch.setattr(acelib, "list_songs", lambda *a, **k: [_Song()])
    monkeypatch.setattr(rt_jobs, "JOBS", {"j9": _J()})
    monkeypatch.setattr(acestage, "references", lambda cfg=None: [])

    by_group = {s["group"]: s for s in acestage.sources()}
    assert by_group["Library"]["seed"] == 42832463
    assert by_group["Library"]["label"] == 'Sample Track One', "the label is the TITLE, not a mix"
    assert by_group["Candidates"]["seed"] == 910791439


def test_a_stem_source_has_no_seed_and_says_so_with_absence(monkeypatch):
    """A stem set is not a render, so it has no seed — and the formatter prints nothing rather
    than "seed None". Only null means "there isn't one"; 0 is a real seed and must print."""
    import vocalis.runtime.acelib as acelib
    monkeypatch.setattr(acelib, "list_songs", lambda *a, **k: [])
    from vocalis.runtime import jobs as rt_jobs
    monkeypatch.setattr(rt_jobs, "JOBS", {})
    monkeypatch.setattr(acestage, "references",
                        lambda cfg=None: [{"token": "stem:set-a", "label": "a vocal"}])
    rows = acestage.sources()
    assert rows and rows[0]["group"] == "Stems" and rows[0].get("seed") is None

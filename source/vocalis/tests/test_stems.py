"""Tests for the stem store filesystem and metadata behavior. The live Demucs pipeline is covered separately in test_voiceswap.py."""
from pathlib import Path

import pytest

import stems
import vault
import vault_fs
import vault_store


@pytest.fixture
def cfg(tmp_path):
    """Anything carrying the two store dirs will do — the store never asks for more."""
    class C:
        stems_dir = tmp_path / "output" / "stems"
        stem_uploads_dir = tmp_path / "uploads" / "stems"
        acestep_dir = tmp_path / "acestep"
        songs_dir = tmp_path / "uploads" / "songs"
    for d in (C.stems_dir, C.stem_uploads_dir, C.acestep_dir, C.songs_dir):
        Path(d).mkdir(parents=True, exist_ok=True)
    return C


def _set(root, name, h, files, **meta):
    d = Path(root) / stems.set_ref(name, h)
    d.mkdir(parents=True, exist_ok=True)
    for f in files:
        (d / f).write_bytes(b"RIFF" + f.encode())
    stems.write_meta(d, {"h": h, "song": name, **meta})
    return d


# ── identity ─────────────────────────────────────────────────────────────────

def test_song_hash_is_content_not_name(tmp_path):
    a, b = tmp_path / "a.mp3", tmp_path / "b.mp3"
    a.write_bytes(b"ID3same")
    b.write_bytes(b"ID3same")
    assert stems.song_hash(a) == stems.song_hash(b)      # same content, different name
    b.write_bytes(b"ID3different")
    assert stems.song_hash(a) != stems.song_hash(b)


def test_upload_hash_ignores_file_order(tmp_path):
    v, i = tmp_path / "v.wav", tmp_path / "i.wav"
    v.write_bytes(b"RIFFvox")
    i.write_bytes(b"RIFFinst")
    one = stems.upload_hash([("vocals.wav", v), ("instrumental.wav", i)])
    two = stems.upload_hash([("instrumental.wav", i), ("vocals.wav", v)])
    assert one == two          # the browser's ordering is not part of the identity
    i.write_bytes(b"RIFFother")
    assert stems.upload_hash([("vocals.wav", v), ("instrumental.wav", i)]) != one


# ── the two stores, and the lookup order between them ────────────────────────

def test_find_by_hash_confirms_against_the_full_sidecar_hash(cfg):
    """The `_<h8>` glob is only a fast index. Two DIFFERENT sets can collide on eight
    hex chars, and serving one set's vocal for another's would be silent and wrong — so
    the full hash in the sidecar is what actually decides."""
    real = "abcdef01" + "1" * 24
    twin = "abcdef01" + "2" * 24                        # same h8, different identity
    _set(cfg.stems_dir, "Song", real, stems.MODE_STEMS["2stem"], source="demucs")
    assert stems.find_by_hash(cfg, real).name == stems.set_ref("Song", real)
    assert stems.find_by_hash(cfg, twin) is None
    assert stems.find_by_hash(cfg, "not-a-hash") is None
    assert stems.find_by_hash(cfg, "") is None


def test_uploads_win_over_our_own(cfg):
    """§5's lookup order: stems you brought beat stems we made, because you brought
    them for a reason."""
    h = "d" * 32
    _set(cfg.stems_dir, "Ours", h, stems.MODE_STEMS["2stem"], source="demucs")
    mine = _set(cfg.stem_uploads_dir, "Ours", h, stems.MODE_STEMS["2stem"],
                source="uploaded")
    assert stems.find_by_hash(cfg, h) == mine
    assert stems.find_dir(cfg, mine.name) == mine


def test_a_half_written_set_is_invisible(cfg):
    """commit() writes the sidecar LAST inside a .part dir and then renames once, so a
    crashed job leaves a folder that simply doesn't exist as far as the store is
    concerned — rather than one that exists and is corrupt."""
    d = cfg.stems_dir / "Crashed_deadbeef"
    d.mkdir(parents=True)
    (d / "vocals.wav").write_bytes(b"RIFF")
    assert stems.list_sets(cfg) == []
    assert stems.find_dir(cfg, "Crashed_deadbeef") is None


# ── what a set IS ────────────────────────────────────────────────────────────

def test_every_set_carries_a_2stem_base(cfg):
    """§5. A 4-stem set holds the instrumental too, so a swap is satisfied without
    summing anything at swap time and a set is swap-ready however it was made."""
    two = _set(cfg.stems_dir, "Two", "a" * 32, stems.MODE_STEMS["2stem"])
    four = _set(cfg.stems_dir, "Four", "b" * 32, stems.MODE_STEMS["4stem"])
    for d in (two, four):
        assert stems.has_base(d) and stems.satisfies(d, "2stem")
    assert stems.mode_of(two) == "2stem" and stems.mode_of(four) == "4stem"
    # …and the mode a set HOLDS is what decides, not what someone asked for:
    assert not stems.satisfies(two, "4stem")     # ← so a 4-stem request really runs
    assert stems.satisfies(four, "4stem")
    assert [p.name for p in stems.stem_files(four)] == stems.STEM_ORDER


def test_a_lone_instrumental_is_storable_but_not_swappable(cfg):
    """§5: not an error — there's just nothing to convert. It grays out in the swap
    picker instead of failing at stage 2.

    🔴 AND ITS MODE IS `partial`, NOT `2stem` (8.4 §6 R6). Until 8.4 `mode_of` ended in a
    bare `else: return "2stem"`, so THIS set — one file, unswappable, half a base — was
    badged *2-stem* in the row, in the picker and in the library. Nothing failed over it
    because nothing asked; the answer was simply a lie, and 8.4's lead-only sets made it a
    lie the UI would print constantly. Asserted here so the fallback cannot come back.
    `partial` rather than `vocals` because there is no vocal: naming a baseless set after
    the vocal it does not have would be the same lie pointing the other way."""
    d = _set(cfg.stem_uploads_dir, "Backing", "c" * 32, ["instrumental.wav"],
             source="uploaded")
    assert not stems.has_base(d)
    row = stems.row(d)
    assert row["swappable"] is False and row["source"] == "uploaded"
    assert [s["label"] for s in row["stems"]] == ["Instrumental"]
    assert row["mode"] == "partial" and stems.mode_of(d) == "partial"
    assert row["lead"] is None          # never been through the mode


def test_stem_file_guards(cfg):
    _set(cfg.stems_dir, "Song", "e" * 32, stems.MODE_STEMS["2stem"])
    ref = stems.set_ref("Song", "e" * 32)
    assert stems.stem_file(cfg, ref, "vocals.wav").is_file()
    assert stems.stem_file(cfg, ref, "drums.wav") is None       # not in this set
    assert stems.stem_file(cfg, ref, "stems.yaml") is None      # not a stem name
    assert stems.stem_file(cfg, ref, "../evil.wav") is None
    assert stems.stem_file(cfg, "../up", "vocals.wav") is None
    for bad in ("", ".", "..", "a/b", "a\\b", "..."):
        assert stems.set_dir(cfg.stems_dir, bad) is None, bad


def test_delete_reports_only_what_actually_went(cfg):
    _set(cfg.stems_dir, "Song", "f" * 32, stems.MODE_STEMS["2stem"])
    ref = stems.set_ref("Song", "f" * 32)
    assert stems.delete_sets(cfg, ["../evil", "nope", ref]) == [ref]
    assert stems.list_sets(cfg) == []


# ── commit: a 4-stem split EXTENDS the set rather than forking it ────────────

def test_commit_extends_an_existing_set(tmp_path, cfg):
    'A set is keyed on its SONG, not on the mode — which is what lets the UI show one\n    row per song ("sample-track · 5 stems") instead of one row per (song, mode) pair.'
    h = "1" * 32
    d = _set(cfg.stems_dir, 'sample-track', h, stems.MODE_STEMS["2stem"], source="demucs")
    (d / "vocals.wav").write_bytes(b"RIFF-original-vocals")

    incoming = tmp_path / "fresh"
    incoming.mkdir()
    produced = {}
    for f in ("vocals.wav", "instrumental.wav", "drums.wav", "bass.wav", "other.wav"):
        (incoming / f).write_bytes(b"RIFF-new-" + f.encode())
        produced[f] = incoming / f
    stems.commit(d, produced, {"h": h, "source": "demucs", "song": 'sample-track'})

    assert stems.mode_of(d) == "4stem"
    assert (d / "vocals.wav").read_bytes() == b"RIFF-new-vocals.wav"   # fresh copy wins
    assert not (d.parent / (d.name + ".part")).exists()                # no debris
    assert len(stems.list_sets(cfg)) == 1                              # ONE row, not two


def test_commit_keeps_stems_the_new_run_did_not_produce(tmp_path, cfg):
    h = "2" * 32
    d = _set(cfg.stems_dir, "Song", h, stems.MODE_STEMS["4stem"], source="demucs")
    incoming = tmp_path / "fresh"
    incoming.mkdir()
    (incoming / "vocals.wav").write_bytes(b"RIFF-redone")
    stems.commit(d, {"vocals.wav": incoming / "vocals.wav"},
                 {"h": h, "source": "demucs", "song": "Song"})
    assert stems.mode_of(d) == "4stem"          # drums/bass/other survived the re-commit
    assert (d / "vocals.wav").read_bytes() == b"RIFF-redone"


# ── command builders ─────────────────────────────────────────────────────────

def test_demucs_cmd_modes(tmp_path):
    two = stems.build_demucs_cmd("py", tmp_path / "s.mp3", tmp_path / "w", "cuda:1", "2stem")
    assert two[1].endswith(str(Path("scripts") / "stems" / "demucs_worker.py"))
    assert Path(two[1]).is_file()
    assert "--two-stems=vocals" in two and "htdemucs" in two
    assert two[two.index("-d") + 1] == "cuda"        # card pinning is env-var based
    four = stems.build_demucs_cmd("py", tmp_path / "s.mp3", tmp_path / "w", "cpu", "4stem")
    assert "--two-stems=vocals" not in four
    assert four[four.index("-d") + 1] == "cpu"


def test_sum_cmd_does_not_attenuate(tmp_path):
    """normalize=0 is load-bearing, exactly as it is in the remix: amix divides every
    input by N by default, which would hand back an instrumental a THIRD of the level
    Demucs's own no_vocals.wav has."""
    cmd = stems.build_sum_cmd([tmp_path / p for p in stems.SUM_PARTS],
                              tmp_path / "instrumental.wav")
    fc = cmd[cmd.index("-filter_complex") + 1]
    assert "amix=inputs=3" in fc and "normalize=0" in fc
    assert cmd.count("-i") == 3
    assert cmd[cmd.index("-c:a") + 1] == "pcm_s16le"     # stems stay lossless


# ── the HTDemucs weights must already be on disk (Demucs downloads them otherwise) ───────

def test_demucs_weight_path_is_where_torch_hub_reads_for_the_childs_environment():
    """`demucs -n htdemucs` loads `955717e8-8726e21a.th` through `torch.hub`, whose directory is
    `$TORCH_HOME/hub`, else `$XDG_CACHE_HOME/torch/hub`, else `~/.cache/torch/hub`. The packaged
    image sets TORCH_HOME=/work/vocalis/runtime-cache/torch (moved October 10, 2026 out of the
    Vocalis cache root; the path follows the environment, never a literal)."""
    tail = Path("hub") / "checkpoints" / "955717e8-8726e21a.th"
    assert stems.demucs_weight_path({"TORCH_HOME": "/work/vocalis/runtime-cache/torch"}) == \
        Path("/work/vocalis/runtime-cache/torch") / tail
    assert stems.demucs_weight_path({"XDG_CACHE_HOME": "/xdg"}) == Path("/xdg") / "torch" / tail
    assert stems.demucs_weight_path({"TORCH_HOME": "/t", "XDG_CACHE_HOME": "/xdg"}) == \
        Path("/t") / tail, "TORCH_HOME wins over XDG_CACHE_HOME, as in torch"
    assert stems.demucs_weight_path({}) == Path.home() / ".cache" / "torch" / tail


def test_require_demucs_model_refuses_what_is_not_a_regular_file(tmp_path):
    """Absent, and a directory wearing the weight's name, both mean "not installed"."""
    env = {"TORCH_HOME": str(tmp_path)}
    weight = stems.demucs_weight_path(env)
    for setup in (lambda: None, lambda: weight.mkdir(parents=True)):
        setup()
        with pytest.raises(RuntimeError) as err:
            stems.require_demucs_model(env)
        message = str(err.value)
        assert "HTDemucs" in message and "955717e8-8726e21a.th" in message
        # October 11, 2026: setup downloads the file, so the message says how to get it; no licence wording.
        assert "has not been downloaded yet" in message
        assert "Run setup again" in message and "Start menu > Repair setup" in message
        assert "licen" not in message.lower() and "edition" not in message.lower()
        assert str(tmp_path) not in message, "a server path must not reach the user"
    weight.rmdir()
    weight.write_bytes(b"")
    stems.require_demucs_model(env)                  # present: returns, raises nothing


def test_demucs_child_env_points_torch_home_at_the_setup_models_folder():
    """VOCALIS_STEMS_MODEL_ROOT (set by the image) becomes the child's TORCH_HOME, so the file setup
    downloaded under <root>/hub/checkpoints is the one torch.hub reads. The parent's env is untouched."""
    parent = {"TORCH_HOME": "/work/vocalis/runtime-cache/torch", "KEEP": "1",
              stems.STEMS_MODEL_ROOT_VARIABLE: "/models/vocalis/stems"}
    child = stems.demucs_child_env(parent)
    assert child["TORCH_HOME"] == "/models/vocalis/stems" and child["KEEP"] == "1"
    assert parent["TORCH_HOME"] == "/work/vocalis/runtime-cache/torch", "the caller's dict was changed"
    assert stems.demucs_weight_path(child) == Path("/models/vocalis/stems/hub/checkpoints/955717e8-8726e21a.th")


def test_demucs_child_env_changes_nothing_without_the_models_variable(monkeypatch):
    """A non-Docker run behaves exactly as before: same TORCH_HOME (or none), same path."""
    monkeypatch.delenv(stems.STEMS_MODEL_ROOT_VARIABLE, raising=False)
    assert stems.demucs_child_env({"TORCH_HOME": "/t"}) == {"TORCH_HOME": "/t"}
    assert stems.demucs_child_env({}) == {}
    assert stems.demucs_child_env({stems.STEMS_MODEL_ROOT_VARIABLE: ""}) == {stems.STEMS_MODEL_ROOT_VARIABLE: ""}
    monkeypatch.setenv("TORCH_HOME", "/from-process")
    assert stems.demucs_child_env()["TORCH_HOME"] == "/from-process"      # default env is the process's


def test_the_weight_check_follows_the_childs_models_folder(tmp_path):
    """The check reads the child's environment: weights in the parent's own torch home do not count when
    the child will look in the models folder, and weights in the models folder count."""
    cache, models = tmp_path / "cache", tmp_path / "models"
    stale = stems.demucs_weight_path({"TORCH_HOME": str(cache)})
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"")
    env = stems.demucs_child_env({"TORCH_HOME": str(cache), stems.STEMS_MODEL_ROOT_VARIABLE: str(models)})
    with pytest.raises(RuntimeError):
        stems.require_demucs_model(env)
    installed = stems.demucs_weight_path(env)
    assert installed == models / "hub" / "checkpoints" / stems.DEMUCS_WEIGHT_FILE
    installed.parent.mkdir(parents=True)
    installed.write_bytes(b"")
    stems.require_demucs_model(env)


def test_the_image_and_the_lock_agree_on_where_the_weights_go():
    """The Dockerfile's VOCALIS_STEMS_MODEL_ROOT plus the lock's path is exactly the file `torch.hub`
    reads for the child (packaging/models/stems/model-file-lock.json)."""
    import json
    import re
    root = Path(__file__).resolve().parents[3]
    lock_path = root / "packaging" / "models" / "stems" / "model-file-lock.json"
    dockerfile = root / "packaging" / "main-cuda" / "Dockerfile.app"
    if not (lock_path.is_file() and dockerfile.is_file()):
        pytest.skip("the packaging files are not in this checkout")
    (entry,) = json.loads(lock_path.read_text(encoding="utf-8"))["files"]
    declared = re.search(rf"^\s+{stems.STEMS_MODEL_ROOT_VARIABLE}=(\S+?)(?: \\)?$",
                         dockerfile.read_text(encoding="utf-8"), re.MULTILINE).group(1)
    env = stems.demucs_child_env({stems.STEMS_MODEL_ROOT_VARIABLE: declared})
    assert Path(declared) / entry["path"] == stems.demucs_weight_path(env)
    assert entry["url"].endswith("/" + stems.DEMUCS_WEIGHT_FILE)


def test_the_weight_check_is_written_for_the_model_the_launcher_asks_for():
    """The file above belongs to `htdemucs`; if the model name moves, the check is stale."""
    assert stems.DEMUCS_MODEL == "htdemucs"
    assert stems.DEMUCS_WEIGHT_FILE.startswith("955717e8-")


# ── migration off the 4.0-m3 layout ──────────────────────────────────────────

def test_migrate_upgrades_a_pre_m4_split(cfg):
    """Pre-M4 splits hold Demucs's `no_vocals.wav`, are keyed on sha256(song|mode|model)
    rather than on the song, and have no `h` — so NOTHING could find them by song, and a
    swap of an already-split song would have quietly re-run Demucs. That is the one
    thing M4 exists to stop, so they get upgraded rather than orphaned."""
    song = Path(cfg.songs_dir) / 'sample-track.mp3'
    song.write_bytes(b"ID3buttons")
    old = Path(cfg.stems_dir) / 'sample-track_6bb06561'       # the m3-era ref, verbatim
    old.mkdir(parents=True)
    (old / "vocals.wav").write_bytes(b"RIFFv")
    (old / "no_vocals.wav").write_bytes(b"RIFFb")
    stems.write_meta(old, {"song": 'sample-track', "song_ref": 'uploads/sample-track.mp3',
                           "mode": "2stem", "model": "htdemucs", "duration_s": 225.6,
                           "created": "2026-07-12T05:56:24"})

    assert stems.migrate(cfg) == [stems.set_ref('sample-track', stems.song_hash(song))]
    d = stems.find_by_hash(cfg, stems.song_hash(song))
    assert d is not None and not old.exists()
    assert (d / "instrumental.wav").read_bytes() == b"RIFFb"   # renamed, not re-split
    assert not (d / "no_vocals.wav").exists()
    assert stems.has_base(d)
    meta = stems.read_meta(d)
    assert meta["source"] == "demucs" and meta["created"] == "2026-07-12T05:56:24"

    assert stems.migrate(cfg) == []                      # idempotent


def test_migrate_carries_a_virtual_folder_across_the_ref_it_moves(cfg):
    """🔴 THE REF IS THE FOLDER NAME, SO THIS MIGRATION IS A REKEY (8.9.7).

    A folder assignment is keyed on the set's `ref`, and `migrate()` re-forms that ref from
    `set_ref(song, h)` — so without a hook the set would leave its folder and NOTHING would
    report it. That is the failure `folders.RENAME_MOVES_REF` exists for, and the exact shape
    the scene star carried unnoticed from 6.2 to 8.8.6.

    ⚠️ The window is narrow — a set can only be FILED once it is listed, and a listed set has
    normally migrated already — but it is reachable: a set whose song was missing at one startup
    is listed under its old ref, and migrates the moment the song comes back."""
    import folders
    from vocalis.runtime import paths

    song = Path(cfg.songs_dir) / 'sample-track.mp3'
    song.write_bytes(b"ID3buttons")
    old = Path(cfg.stems_dir) / 'sample-track_6bb06561'
    old.mkdir(parents=True)
    (old / "vocals.wav").write_bytes(b"RIFFv")
    (old / "no_vocals.wav").write_bytes(b"RIFFb")
    stems.write_meta(old, {"song": 'sample-track', "song_ref": 'uploads/sample-track.mp3',
                           "mode": "2stem", "model": "htdemucs", "created": "2026-07-12T05:56:24"})

    root = paths.FOLDERS.parent
    fid = folders.create(root, "stems_library", 'Sample Folder')["id"]
    folders.assign(root, "stems_library", [old.name], fid)

    new_ref = stems.set_ref('sample-track', stems.song_hash(song))
    assert stems.migrate(cfg) == [new_ref]
    assert new_ref != old.name, "the fixture must actually MOVE the ref or this proves nothing"

    m = folders.listing(root, "stems_library")["assign"]
    assert m == {new_ref: fid}, 'the set is still in Sample Folder, under its new ref, and only once'


def test_migrate_does_not_write_the_folders_file_when_nothing_was_filed(cfg):
    """🔴 THE COMMON STARTUP PATH MUST NOT TOUCH IT. `migrate()` runs on every boot; a rekey
    that wrote unconditionally would CREATE `folders.yaml` on an install that has never used a
    folder, which is the defect `_mutate` was fixed for in m1 — and it would do it inside the
    vault, on a path nothing else had reason to write."""
    from vocalis.runtime import paths

    song = Path(cfg.songs_dir) / 'sample-track.mp3'
    song.write_bytes(b"ID3buttons")
    old = Path(cfg.stems_dir) / 'sample-track_6bb06561'
    old.mkdir(parents=True)
    (old / "vocals.wav").write_bytes(b"RIFFv")
    stems.write_meta(old, {"song": 'sample-track', "song_ref": 'uploads/sample-track.mp3',
                           "mode": "vocals", "model": "htdemucs"})

    assert not paths.FOLDERS.exists()
    stems.migrate(cfg)
    assert not paths.FOLDERS.exists(), "a boot with no folders in play writes no folders file"


def test_migrate_keeps_a_set_whose_song_is_gone(cfg):
    """Non-destructive: it keeps its stems and stays listed, playable and downloadable.
    It just can't be found BY SONG any more — which is the honest outcome when the song
    it belongs to has been deleted."""
    orphan = Path(cfg.stems_dir) / "Ghost_deadbeef"
    orphan.mkdir(parents=True)
    (orphan / "vocals.wav").write_bytes(b"RIFFv")
    (orphan / "no_vocals.wav").write_bytes(b"RIFFb")
    stems.write_meta(orphan, {"song": "Ghost", "song_ref": "uploads/gone.mp3",
                              "mode": "2stem"})
    assert stems.migrate(cfg) == []
    assert orphan.is_dir()
    row = stems.row(orphan)
    assert row["h"] is None and row["swappable"] is True   # still usable BY HAND
    assert (orphan / "instrumental.wav").is_file()         # the rename still happened


# ── M2.5: never destroy on a failed read ─────────────────────────────────────
#
# The chain, and it is a long one — which is exactly why the sweep found it and a reviewer
# would not: read_meta returns {} on a corrupt sidecar → find_by_hash can't confirm the
# hash → the set looks FOREIGN → Demucs re-runs → commit() rmtree's the folder and
# os.replace's a freshly-made set over it. The UI lists the set the whole time, because
# list_sets tests that the sidecar EXISTS, not that it READS.

def _corrupt(d):
    (Path(d) / stems.SIDECAR).write_text("{{{ not yaml", encoding="utf-8")


def test_a_corrupt_sidecar_is_not_a_missing_set(cfg):
    """find_by_hash reads strict: an UNKNOWN must never be reported as an ABSENCE, because
    the caller's answer to an absence is to spend a GPU and write over this very folder."""
    h = "ab12cd34" + "0" * 24
    d = _set(cfg.stems_dir, "Buttons", h, ["vocals.wav", "instrumental.wav"])
    _corrupt(d)
    with pytest.raises(stems.StemsSidecarUnreadable):
        stems.find_by_hash(cfg, h)


def test_commit_refuses_to_land_on_a_set_it_could_not_read(cfg, tmp_path):
    """The destroy site itself. find_by_hash reads strict so we should never get here — but
    `rmtree(dest); os.replace(part, dest)` is the line that actually destroys, and a destroy
    site that trusts its caller to have checked is one waiting for the next caller."""
    h = "ab12cd34" + "0" * 24
    d = _set(cfg.stems_dir, "Buttons", h, ["vocals.wav", "instrumental.wav"])
    _corrupt(d)
    keep = {p.name: p.read_bytes() for p in stems.stem_files(d)}
    sidecar = (d / stems.SIDECAR).read_bytes()

    incoming = tmp_path / "fresh"
    incoming.mkdir()
    (incoming / "vocals.wav").write_bytes(b"RIFF-remade-by-demucs")

    with pytest.raises(stems.StemsSidecarUnreadable):
        stems.commit(d, {"vocals.wav": incoming / "vocals.wav"},
                     {"h": h, "source": "demucs", "song": "Buttons"})

    assert {p.name: p.read_bytes() for p in stems.stem_files(d)} == keep, \
        "the good stems were overwritten by remade ones"
    assert (d / stems.SIDECAR).read_bytes() == sidecar, "the sidecar was overwritten"
    assert not d.with_name(d.name + ".part").exists(), "the .part scratch must be cleaned up"


def test_a_listing_still_shows_a_set_whose_sidecar_is_corrupt(cfg):
    """Reads DEGRADE. The row is the Stems tab, not an identity question — showing it with
    blanks is right, and refusing to show it would hide a set the user still owns."""
    h = "ab12cd34" + "0" * 24
    d = _set(cfg.stems_dir, "Buttons", h, ["vocals.wav", "instrumental.wav"])
    _corrupt(d)
    rows = stems.list_sets(cfg)
    assert [r["ref"] for r in rows] == [d.name]
    assert rows[0]["h"] is None and rows[0]["swappable"] is True   # still playable, still there


def test_migrate_leaves_a_set_it_could_not_read_exactly_as_it_is(cfg):
    """A corrupt sidecar has no `h`, which reads EXACTLY like "pre-M4" — so a non-strict
    read would hand this loop a set to rewrite and rename. It is not pre-M4; it is unknown."""
    d = Path(cfg.stems_dir) / "Buttons_deadbeef"
    d.mkdir(parents=True)
    (d / "vocals.wav").write_bytes(b"RIFFv")
    (d / "no_vocals.wav").write_bytes(b"RIFFb")
    _corrupt(d)
    before = (d / stems.SIDECAR).read_bytes()

    assert stems.migrate(cfg) == []
    assert d.is_dir(), "the folder must not be renamed"
    assert (d / stems.SIDECAR).read_bytes() == before, "the sidecar must not be rewritten"
    assert (d / "no_vocals.wav").is_file(), "and no_vocals must not be renamed either"


def test_absent_sidecar_is_not_corrupt(cfg):
    """ABSENT ≠ CORRUPT. A folder with no sidecar is half-written and counts as a set
    nowhere (find_dir, list_sets), so there is nothing there to destroy — and commit must
    stay free to create one, which is what every first split does."""
    d = Path(cfg.stems_dir) / "Buttons_deadbeef"
    d.mkdir(parents=True)
    assert stems.read_meta(d, strict=True) == {}          # no raise
    assert stems.find_by_hash(cfg, "deadbeef" + "0" * 24) is None


# ── 🔴 delete really frees the disk, and the old test could not tell ─────────────────────────
#
# A listing can report a set as deleted as soon as its sidecar disappears. These tests also
# measure directory contents so orphaned audio files cannot pass as a successful deletion.


def _bytes_under(root) -> int:
    """Every byte on the platter under `root`, whatever the names look like. Deliberately NOT
    routed: in the vault case the point is to walk the CIPHERTEXT and prove the blobs are gone,
    which is the question — a logical listing would be answering with the same map that lost the
    sidecar."""
    return sum(p.stat().st_size for p in Path(root).rglob("*") if p.is_file())


def test_delete_frees_the_platter_not_just_the_shelf(cfg):
    """🔴 THE BYTES, NOT THE ROW. A stem set is two to five WAVs and they are the big files in this
    product — deleting one has to reclaim the space or the feature is a lie about disk."""
    big = b"RIFF" + b"\0" * 400_000
    d = _set(cfg.stems_dir, 'sample-track', "a" * 32, stems.MODE_STEMS["2stem"])
    for f in stems.MODE_STEMS["2stem"]:
        (d / f).write_bytes(big)
    ref = stems.set_ref('sample-track', "a" * 32)
    before = _bytes_under(cfg.stems_dir)
    assert before > 800_000, "the fixture has to be big enough to notice"

    assert stems.delete_sets(cfg, [ref]) == [ref]

    # ⚠️ Not `list_sets() == []` — that is satisfied by losing the sidecar alone. The DIRECTORY is
    # gone and the bytes with it.
    assert not d.exists(), f"the set folder survived: {sorted(p.name for p in d.iterdir())}"
    assert _bytes_under(cfg.stems_dir) == 0, "the WAVs are still on disk"
    assert stems.list_sets(cfg) == []


def test_delete_frees_the_platter_through_the_vault_too(tmp_path, monkeypatch):
    """Deleting a set must remove its underlying files from the encrypted store, not only remove the row from the listing."""
    monkeypatch.setattr(vault, "DEFAULT_KDF",
                        {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1})
    install = tmp_path / "install"
    install.mkdir()
    store = vault_store.configure([("install", install)], install / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", store)
    store.create("correct horse battery staple")      # created => unlocked

    class C:
        stems_dir = install / "output" / "stems"
        stem_uploads_dir = install / "uploads" / "stems"
    vault_fs.mkdir(C.stems_dir)
    vault_fs.mkdir(C.stem_uploads_dir)

    ref = stems.set_ref('sample-track', "b" * 32)
    d = C.stems_dir / ref
    vault_fs.mkdir(d)
    for f in stems.MODE_STEMS["2stem"]:
        vault_fs.write_bytes(d / f, b"RIFF" + b"\0" * 400_000)
    stems.write_meta(d, {"h": "b" * 32, "song": 'sample-track'})

    # The store is routed, so this walks CIPHERTEXT — and it has to have got heavier, or the
    # fixture never wrote through the vault and the whole test is vacuous.
    heavy = _bytes_under(install)
    assert heavy > 800_000, f"nothing large landed in the store ({heavy} bytes)"
    assert stems.find_dir(C, ref) is not None, "the set has to be findable before it is deleted"

    assert stems.delete_sets(C, [ref]) == [ref]

    assert stems.find_dir(C, ref) is None
    after = _bytes_under(install)
    assert after < heavy - 800_000, (
        f"the encrypted blobs survived the delete: {heavy} -> {after} bytes under {install}")


# ── 8.4: the DERIVED lead stem (DESIGN_8_4_LEAD_VOCAL.md §6) ─────────────────────────────────
#
# `lead_solo.wav` is made FROM another stem in this set — the wet vocal, cut down to the passages
# where the lead sings alone — so the store has to hold two ideas apart at once:
#
#   * it IS a file in the set: enumerated for the widget, in ⬇ All, downloadable, labeled;
#   * it is NOT a Demucs slot: invisible to `satisfies`, `has_base` and `mode_of`, or a folder
#     holding one reads as a differently-moded Demucs set and every badge in the UI goes wrong.
#
# Everything below is one of those two halves. The fixture is deliberately the cheap one — the
# store is pure, so a set is a directory with the right names in it.


def _lead_block(**over) -> dict:
    """A plausible `lead:` block, as `leadvocal.lead_block` writes it. Built by hand rather than
    imported so this file stays what it says it is — a test of the STORE, with no analysis, no
    numpy and no job in it."""
    b = {"built_at": "2026-08-17T14:22:03", "detector": "UVR_MDXNET_KARA_2", "device": "cpu",
         "dereverb": "UVR-DeEcho-DeReverb.pth", "params": {"backing_enter_db": -30.0},
         "spans": 7, "kept_sec": 82.4, "source_sec": 225.0, "thin": False}
    b.update(over)
    return b


def test_a_lead_only_set_has_no_base_and_says_so(cfg):
    """🔴 §6 R5/R6 — A LEAD-ONLY SET IS BASELESS ON PURPOSE, AND THAT IS NOT A REGRESSION.

    The mode commits the vocal and drops the instrumental Demucs computed (§6.4), so the set
    holds one Demucs stem plus a derived file. Three answers follow and all three are
    load-bearing: `has_base` is False, so the swap picker grays the row out rather than failing
    at stage 2 minutes later; `swappable` says the same thing to the page; and `mode_of` answers
    `vocals`, because the old fallback would have printed *2-stem* over a set with no
    instrumental in it — a lie the row, the picker and the library would then all repeat.

    A later Voice Swap of the song re-runs Demucs and extends the set with the instrumental
    THEN. Paying for it at the moment it is wanted is the trade; for this workflow that moment
    never comes."""
    d = _set(cfg.stems_dir, 'sample-track', "1a" * 16, ["vocals.opus", stems.LEAD_SOLO],
             source="demucs", lead=_lead_block())
    assert stems.has_base(d) is False
    assert stems.satisfies(d, "2stem") is False and stems.satisfies(d, "4stem") is False
    assert stems.mode_of(d) == "vocals"
    row = stems.row(d)
    assert row["swappable"] is False and row["mode"] == "vocals"


def test_the_derived_lead_is_invisible_to_the_mode_questions(cfg):
    '🔴 §6 R1 — THE LEAD MUST NOT COUNT TOWARD ANY MODE. It is the same folder with and\n    without a `lead_solo.wav` as far as `satisfies`, `has_base` and `mode_of` are concerned.\n\n    Why it matters beyond tidiness: `stems.migrate()` runs at startup over every set, and the\n    mode badge is computed from what is on disk. A derived file that counted would make a\n    one-vocal folder look like a Demucs set of some other mode — and the count in "sample-track ·\n    N stems" would include a file Demucs never made.\n\n    The pairing is the assertion: the answers are IDENTICAL before and after the lead lands,\n    for every mode question, while `has_lead` is the one answer that changes.'
    bare = _set(cfg.stems_dir, "Bare", "2a" * 16, ["vocals.opus"], source="demucs")
    withlead = _set(cfg.stems_dir, "Led", "2b" * 16, ["vocals.opus", stems.LEAD_SOLO],
                    source="demucs", lead=_lead_block())

    def answers(d):
        return (stems.has_base(d), stems.satisfies(d, "2stem"), stems.satisfies(d, "4stem"),
                stems.satisfies(d, "vocals"), stems.mode_of(d))

    assert answers(withlead) == answers(bare) == (False, False, False, True, "vocals")
    assert stems.has_lead(withlead) is True and stems.has_lead(bare) is False
    # …and a 4-stem set given a lead later is still a 4-stem set, from every angle.
    four = _set(cfg.stems_dir, "Full", "2c" * 16,
                stems.MODE_STEMS["4stem"] + [stems.LEAD_SOLO], source="demucs")
    assert stems.mode_of(four) == "4stem" and stems.has_base(four) is True
    # The startup migration must walk straight past all three — they are M4 sets with an `h`,
    # and a derived file is not a `no_vocals.wav` waiting to be renamed.
    assert stems.migrate(cfg) == []


def test_has_lead_and_find_stem_resolve_the_derived_lead(cfg):
    """`has_lead` is what puts the pill on the row, what makes the 🎓 button send the lead
    instead of the wet vocal, and what "already done" would mean for a `lead` split — so it has
    to be one question with one answer, asked through `find_stem` like every other lookup."""
    d = _set(cfg.stems_dir, "Song", "3a" * 16, ["vocals.opus", stems.LEAD_SOLO])
    assert stems.has_lead(d) is True
    p = stems.find_stem(d, "lead_solo")
    assert p is not None and p.name == stems.LEAD_SOLO and p.parent == d
    assert stems.find_stem(d, stems.LEAD_SOLO) == p              # by filename too
    assert stems.stem_file(cfg, d.name, "lead_solo.wav") == p    # …and through the route door

    empty = _set(cfg.stems_dir, "None", "3b" * 16, ["vocals.opus", "instrumental.opus"])
    assert stems.has_lead(empty) is False
    assert stems.find_stem(empty, "lead_solo") is None


def test_lead_solo_resolves_only_as_wav(cfg):
    """🔴 THE ONE FILE IN THIS STORE THAT IS DELIBERATELY NOT OPUS, AND THE LOOKUP HAS TO AGREE.

    Every Demucs stem resolves across `STEM_EXTS` because the store holds both formats forever
    (7.5.25). The lead does not: it is a MODEL'S TRAINING INPUT, the chain already spends one
    lossy generation on `vocals.opus` → decode → cut → training MP3, and resolving a
    `lead_solo.opus` would quietly hand a trainer a second one.

    So a folder holding ONLY `lead_solo.opus` has no lead at all. That is not a graceful
    fallback being refused — nothing in this system writes that file, so its presence means
    something went wrong, and the honest answer is that the set has no lead rather than to feed
    a mystery file to a voice model."""
    opus_only = _set(cfg.stems_dir, "Opus", "4a" * 16, ["vocals.opus", "lead_solo.opus"])
    assert stems.find_stem(opus_only, "lead_solo") is None
    assert stems.has_lead(opus_only) is False
    assert [p.name for p in stems.stem_files(opus_only)] == ["vocals.opus"]
    assert stems.stem_file(cfg, opus_only.name, "lead_solo.wav") is None

    # …and the WAV wins even when both are somehow sitting there.
    both = _set(cfg.stems_dir, "Both", "4b" * 16,
                ["vocals.opus", stems.LEAD_SOLO, "lead_solo.opus"])
    assert stems.find_stem(both, "lead_solo").name == stems.LEAD_SOLO


def test_the_lead_is_listed_first_and_flagged_derived(cfg):
    """§6 R1 · §7 — DISPLAY ORDER AND THE `derived` FLAG.

    The lead goes FIRST, ahead of the instrumental the widget normally leads with: on a set
    that has one it is what you came for. And every stem entry carries `derived`, so the page
    can tell a pill it made from a pill Demucs made without re-deriving it from the filename —
    which is how the "N stems" count and the mode badge stay honest.

    `STEM_ORDER` is untouched by all of this on purpose: it is the DEMUCS SLOT LIST, and the
    mode questions are asked with it. `DISPLAY_ORDER` is the enumeration."""
    assert stems.DISPLAY_ORDER == [stems.LEAD_SOLO] + stems.STEM_ORDER
    assert stems.STEM_LABELS[stems.LEAD_SOLO] == "Lead vocal"

    d = _set(cfg.stems_dir, "Song", "5a" * 16,
             ["vocals.opus", "instrumental.opus", stems.LEAD_SOLO], source="demucs")
    assert [p.name for p in stems.stem_files(d)] == [
        stems.LEAD_SOLO, "instrumental.opus", "vocals.opus"]

    row = stems.row(d)
    assert [s["label"] for s in row["stems"]] == ["Lead vocal", "Instrumental", "Vocals"]
    assert [s["stem"] for s in row["stems"]] == ["lead_solo", "instrumental", "vocals"]
    assert [s["derived"] for s in row["stems"]] == [True, False, False]
    assert row["mode"] == "2stem" and row["swappable"] is True   # the lead changed neither


def test_row_carries_the_lead_block_and_none_without_one(cfg):
    """§6 — the provenance the widget's coverage line reads ("7 spans · 1:22 of 3:45 kept ·
    de-reverbed"), and the record §4b's "never mix wet and dry material in one singer's
    dataset" is checked against months later.

    `None` — not `{}`, not a missing key — for a set that has never been through the mode, so
    the page can branch on it directly."""
    block = _lead_block()
    d = _set(cfg.stems_dir, "Song", "6a" * 16, ["vocals.opus", stems.LEAD_SOLO],
             source="demucs", lead=block)
    assert stems.row(d)["lead"] == block

    plain = _set(cfg.stems_dir, "Plain", "6b" * 16, stems.MODE_STEMS["2stem"])
    assert stems.row(plain)["lead"] is None
    assert "lead" in stems.row(plain)                # the key is always there to branch on

    thin = _set(cfg.stems_dir, "Thin", "6c" * 16, ["vocals.opus"],
                lead=_lead_block(spans=0, kept_sec=0.0, thin=True, dereverb=False))
    assert stems.row(thin)["lead"]["thin"] is True and stems.row(thin)["lead"]["spans"] == 0


def test_stored_name_keeps_the_lead_out_of_the_opus_rule():
    """Writers ask `stored_name` what to call a fresh file. For every Demucs slot the answer is
    Opus (7.5.25); for the derived lead it is WAV, and `DERIVED_EXTS` is the single place that
    knows it."""
    assert stems.stored_name("lead_solo") == stems.LEAD_SOLO == "lead_solo.wav"
    assert stems.stored_name("lead_solo.wav") == "lead_solo.wav"
    assert stems.stored_name("lead_solo.opus") == "lead_solo.wav"  # asked wrong, answered right
    assert stems.stored_name("vocals") == "vocals.opus"            # …and nothing else moved
    assert stems.stored_name("stems.yaml") == ""


#: Keep derived lead audio out of the Opus pass: `stem_key()` resolves the lead only as WAV,
#: while `encoded_produced()` maps encoded output to an Opus filename the store will not resolve.
def test_the_encode_pass_must_not_opus_the_lead(tmp_path):
    """🔴 §5/§6 — THE OPUS PASS MUST STEP OVER THE DERIVED LEAD.

    `encode_plan` is the gate between "Demucs wrote these WAVs" and "the store gets Opus". The
    lead is the one file that must cross it unchanged, and the cost of getting that wrong is not
    a bigger file — it is a LOST file: `find_stem` resolves `lead_solo` only as `.wav`, on
    purpose (see `test_lead_solo_resolves_only_as_wav`), so a `lead_solo.opus` in the set is a
    file nothing can find, sitting exactly where the training material was supposed to be.

    Written as the CONTRACT rather than as the behavior, and marked xfail(strict) so it turns
    red the moment the source is fixed."""
    produced = {"vocals.wav": tmp_path / "vocals.wav", stems.LEAD_SOLO: tmp_path / "lead.wav"}
    work = tmp_path / "work"
    work.mkdir()
    plan = stems.encode_plan(produced, work)
    assert [key for key, _src, _out in plan] == ["vocals"], \
        f"the derived lead was queued for an Opus encode: {plan}"
    for _key, _src, out in plan:
        out.write_bytes(b"OggS")
    assert set(stems.encoded_produced(produced, plan)) == {"vocals.opus", stems.LEAD_SOLO}


def test_the_vocals_harvest_mode_is_one_vocal_and_the_same_demucs_run(tmp_path):
    """§6.4 — `vocals` is 8.4's INTERNAL stage-1 mode, not something the split control offers.

    Two things define it. What it must HOLD is one file, so a lead-only set satisfies it and a
    lead re-run over an already-split song is a store hit rather than a Demucs pass. And what it
    RUNS is the 2-stem child verbatim: Demucs computes the instrumental as mix − vocals
    whichever way it is invoked, so `--two-stems=vocals` costs nothing extra and the HARVEST is
    what drops the half we are not keeping. `DEMUCS_RAW` lists only the vocal for the same
    reason — failing a good split over a by-product we are about to throw away would be a
    manufactured error."""
    assert stems.MODE_STEMS["vocals"] == ["vocals.wav"]
    assert stems.DEMUCS_RAW["vocals"] == ["vocals.wav"]

    class C:
        stems_dir = tmp_path / "stems"
        stem_uploads_dir = tmp_path / "up"
    for d in (C.stems_dir, C.stem_uploads_dir):
        d.mkdir(parents=True)
    assert stems.satisfies(_set(C.stems_dir, "Song", "7a" * 16, ["vocals.opus"]),
                           "vocals") is True
    assert stems.satisfies(_set(C.stems_dir, "Inst", "7b" * 16, ["instrumental.opus"]),
                           "vocals") is False

    cmd = stems.build_demucs_cmd("py", tmp_path / "s.mp3", tmp_path / "w", "cuda:1", "vocals")
    two = stems.build_demucs_cmd("py", tmp_path / "s.mp3", tmp_path / "w", "cuda:1", "2stem")
    assert "--two-stems=vocals" in cmd
    assert cmd == two, "the harvest must be the SAME child as a 2-stem split, argument for arg"


def test_stem_key_is_still_traversal_safe_with_the_derived_names(cfg):
    """`stem_key` gained a second membership test (`DERIVED_EXTS`), and a membership test is
    exactly where a traversal slips in if the basename is not taken FIRST. It is: every one of
    these collapses to a bare name that is then checked against a fixed list, so the worst a
    crafted ref can do is name a stem it was already allowed to name."""
    for bad in ("../../lead_solo.wav", "..\\..\\lead_solo.wav", "/etc/lead_solo.wav",
                "C:\\windows\\lead_solo.wav", "x/../lead_solo.wav"):
        assert stems.stem_key(bad) == "lead_solo", bad          # the NAME survives…
    for evil in ("../../etc/passwd", "lead_solo/../../evil.wav", "lead_spans.json",
                 "lead_solo.exe", "..", "", "lead_solo.wav.bak"):
        assert stems.stem_key(evil) == "", evil

    # …and the name is all that survives: the route door still joins it to the set's own dir.
    d = _set(cfg.stems_dir, "Song", "8a" * 16, ["vocals.opus", stems.LEAD_SOLO])
    assert stems.stem_file(cfg, d.name, "../../lead_solo.wav") == d / stems.LEAD_SOLO
    assert stems.stem_file(cfg, "../up", "lead_solo.wav") is None
    assert stems.stem_file(cfg, d.name, "lead_spans.json") is None   # provenance is not a stem


# ── 8.6.4: one clip must not pin a socket for its whole length ───────────────

def test_a_range_answer_is_capped_so_it_cannot_starve_the_socket_pool(tmp_path, monkeypatch):
    """Audio elements initially request a range that may cover the full file. Clamp that response so a slow client cannot occupy a connection for the entire download; keep the shared cap in the common sender."""
    import store_serve
    # 🔴 2 MiB, TIGHTENED FROM 8 — AND THE OLD BOUND IS WHY THIS SHIPPED BROKEN TWICE. 4 MiB
    # passed it comfortably and still pinned a socket for FIFTEEN SECONDS, because the thing that
    # matters is not the byte count, it is whether the answer fits inside Chrome's media buffer
    # target. Over it, Chrome stops reading and drains the rest slowly; werkzeug closes the
    # connection per response, so a large response can occupy one of the browser's limited
    # per-host connections. Keep the cap below the point where buffered media reads stall; too
    # small a range also adds handshake overhead because each response closes its connection.
    assert store_serve.RANGE_CHUNK_CAP <= 2 * 1024 * 1024, (
        f"RANGE_CHUNK_CAP is {store_serve.RANGE_CHUNK_CAP:,} bytes - large enough for Chrome to "
        "stop reading mid-response and pin the socket for seconds, which is the stall this cap "
        "exists to prevent. See the measurement table in store_serve.py.")
    assert store_serve.RANGE_CHUNK_CAP >= 256 * 1024, (
        "below ~256 KiB every extra round trip is a fresh TLS handshake (werkzeug sends "
        "Connection: close) and the measurement showed no further improvement")

    src = store_serve.inspect.getsource(store_serve.send_store_file) \
        if hasattr(store_serve, "inspect") else None
    if src is None:
        import inspect as _i
        src = _i.getsource(store_serve.send_store_file)
    assert "RANGE_CHUNK_CAP" in src, "the range path no longer applies the cap"
    assert "end = min(end, start + RANGE_CHUNK_CAP - 1)" in src, (
        "the cap is defined but the range answer is not clamped by it")


def test_no_audio_route_serves_a_player_through_an_uncapped_sender():
    """All player routes must use the shared capped sender. Download routes may retain their separate full-file behavior."""
    import re
    from conftest import REPO_ROOT
    offenders = []
    for f in sorted((REPO_ROOT / "src").rglob("*.py")):
        if "__pycache__" in f.parts or f.name == "store_serve.py":
            continue
        src = f.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"send_file\(([^)]*)\)", src, re.S):
            call = m.group(1)
            if "audio/" not in call:
                continue
            if "as_attachment" in call:
                continue                      # a download, not a player — uncapped by design
            line = src[:m.start()].count("\n") + 1
            offenders.append(f"{f.relative_to(REPO_ROOT).as_posix()}:{line}")
    assert not offenders, (
        "these serve audio to a player through Werkzeug's uncapped send_file, so `bytes=0-` is "
        "answered with the whole file and one clip pins a socket for its length. Route them "
        f"through store_serve.send_store_file / send_capped_bytes: {offenders}")


def test_the_cap_is_defined_exactly_once():
    """The route-level cap must remain an alias of the shared sender's single limit."""
    import store_serve
    from conftest import REPO_ROOT
    from vocalis.web import acestep as web_ace
    assert web_ace.AUDIO_CHUNK_CAP is store_serve.RANGE_CHUNK_CAP or \
        web_ace.AUDIO_CHUNK_CAP == store_serve.RANGE_CHUNK_CAP
    ace_src = (REPO_ROOT / "src" / "vocalis" / "web" / "acestep.py").read_text(encoding="utf-8")
    assert "AUDIO_CHUNK_CAP = RANGE_CHUNK_CAP" in ace_src, (
        "acestep defines its own cap number again instead of aliasing the shared one")

"""Unit tests for playground_clips (2.3-M1): identity, storage, and the
crash/cancel-resume workspace — no server, no GPU."""
from pathlib import Path

import pytest
import yaml

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import playground_clips as pc


# ── identity (seedless since 3.x) ─────────────────────────────────────────────

def test_clip_hash_stable_and_input_sensitive():
    h = pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hello there.")
    assert h == pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hello there.")
    assert len(h) == 12
    # every input participates
    assert h != pc.clip_hash("W.wav", 0.5, 0.5, 0.8, "Hello there.")
    assert h != pc.clip_hash("V.wav", 0.6, 0.5, 0.8, "Hello there.")
    assert h != pc.clip_hash("V.wav", 0.5, 0.6, 0.8, "Hello there.")
    assert h != pc.clip_hash("V.wav", 0.5, 0.5, 0.9, "Hello there.")
    assert h != pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hello there!")


def test_clip_stem_is_words_plus_hash8():
    stem = pc.clip_stem("The quick brown fox jumps over the lazy dog", "abcdef123456")
    assert stem.endswith("_abcdef12")
    assert stem.startswith("The_quick_brown_fox")
    assert "/" not in stem and "\\" not in stem


def test_clip_paths_traversal_guarded(tmp_path):
    mp3, y = pc.clip_paths(tmp_path, "Narrator_3/clip_ab12cd34")
    assert mp3.suffix == ".mp3" and y.suffix == ".yaml"
    assert mp3.parent == tmp_path / "Narrator_3"
    for bad in ("../evil", "a/../../evil", "Narrator_3/../../evil", "toolow", "a/b/c", "", None):
        assert pc.clip_paths(tmp_path, bad) == (None, None)


# ── clip storage round-trip ───────────────────────────────────────────────────

def _make_clip(root, ref, **meta):
    mp3, y = pc.clip_paths(root, ref)
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3-fake")
    pc.write_clip_yaml(y, {"voice": "V.wav", "exaggeration": 0.5, "cfg": 0.5,
                           "temperature": 0.8,
                           "text": "Hello there.", "duration_s": 1.5,
                           **meta})
    return mp3, y


def test_list_clips_round_trip(tmp_path):
    _make_clip(tmp_path, "Narrator_3/Hello_there_ab12cd34")
    clips = pc.list_clips(tmp_path)
    assert len(clips) == 1
    c = clips[0]
    assert c["ref"] == "Narrator_3/Hello_there_ab12cd34"
    assert c["name"] == "Hello there"                 # hash suffix stripped, underscores spaced
    assert c["voice"] == "V.wav" and c["voice_label"] == "Narrator_3"
    assert "seed" not in c and "random_seed" not in c   # seedless rows (3.x)
    assert c["text"] == "Hello there."
    assert c["duration_s"] == 1.5 and c["size"] > 0 and c["created"]


def test_list_clips_skips_orphans(tmp_path):
    """A yaml without its mp3 (half-deleted / crash between writes) is not a clip."""
    _mp3, y = pc.clip_paths(tmp_path, "Narrator_3/orphan_ab12cd34")
    y.parent.mkdir(parents=True)
    pc.write_clip_yaml(y, {"voice": "V.wav", "text": "x"})
    assert pc.list_clips(tmp_path) == []


def test_delete_clips_prunes_and_skips_bad_refs(tmp_path):
    _make_clip(tmp_path, "Narrator_3/one_ab12cd34")
    _make_clip(tmp_path, "Narrator_3/two_ab12cd35")
    deleted = pc.delete_clips(tmp_path, ["Narrator_3/one_ab12cd34", "../evil", "ghost/none"])
    assert deleted == ["Narrator_3/one_ab12cd34"]
    assert (tmp_path / "Narrator_3").exists()              # still holds clip two
    assert pc.delete_clips(tmp_path, ["Narrator_3/two_ab12cd35"]) == ["Narrator_3/two_ab12cd35"]
    assert not (tmp_path / "Narrator_3").exists()          # emptied voice dir pruned


# ── stale-key tolerance (pre-3.x sidecars/manifests carry seed keys) ─────────

def test_stale_seed_keys_in_sidecars_and_manifests_are_ignored(tmp_path):
    """Old on-disk YAML still carries seed/random_seed — reading must tolerate
    (ignore) them: rows list fine, no seed fields leak through."""
    _make_clip(tmp_path, "Narrator_3/old_ab12cd99", seed=777, random_seed=True)
    clips = pc.list_clips(tmp_path)
    assert len(clips) == 1 and "seed" not in clips[0]
    ws = pc.workspace(tmp_path, "aaaabbbbcccc")
    pc.write_pending(ws, {"voice": "V.wav", "exaggeration": 0.5, "cfg": 0.5,
                          "temperature": 0.8, "seed": 777, "random_seed": True,
                          "turbo": False,           # stale pre-3.x keys: ignored
                          "text": "Resume me.", "total": 3})
    parts = pc.list_partials(tmp_path)
    assert len(parts) == 1 and "seed" not in parts[0]


def test_clip_hash_includes_narrate_actions():
    a = pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hi. *waves*", narrate_actions=True)
    b = pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hi. *waves*", narrate_actions=False)
    assert a != b                                    # same text, different narration = two clips


# ── *action* filtering (tts_utils.filter_actions — shared with 3.0 Nomi/ST) ──

def test_filter_actions_narrate_on_strips_only_asterisks():
    """Default: the action text IS spoken; the asterisk characters never reach the
    model (Chatterbox's tokenizer treats them as alien tokens and mangles the span)."""
    from tts_utils import filter_actions
    src = '*I jump into your arms and hug you tight.* "I missed you so much!"'
    out = filter_actions(src, narrate_actions=True)
    assert "*" not in out
    assert "I jump into your arms and hug you tight." in out
    assert '"I missed you so much!"' in out


def test_filter_actions_narrate_off_drops_spans():
    from tts_utils import filter_actions
    src = '*She smiles warmly.* Hello there. *waves* How are you?'
    out = filter_actions(src, narrate_actions=False)
    assert "*" not in out
    assert "smiles" not in out and "waves" not in out
    assert "Hello there." in out and "How are you?" in out


def test_filter_actions_narrate_off_all_actions_leaves_nothing():
    from tts_utils import filter_actions
    assert filter_actions("*only actions here*", narrate_actions=False) == ""


def test_filter_actions_unpaired_asterisk_never_spoken():
    from tts_utils import filter_actions
    assert "*" not in filter_actions("Oops *unclosed action. More text.", narrate_actions=False)
    assert "*" not in filter_actions("Oops *unclosed action. More text.", narrate_actions=True)


# ── scene breaks and other markup with no words in it (Doug, 2026-10-12) ─────────

SCENE = ("She closed the door.\n\n***\n\n0900 the next morning\n\n***\n\n"
         "Marcus was already at his desk.")
SPOKEN = "She closed the door. 0900 the next morning. Marcus was already at his desk."


def test_a_scene_break_never_reaches_the_model_and_its_heading_is_a_sentence():
    from tts_utils import filter_actions
    assert filter_actions(SCENE) == SPOKEN


@pytest.mark.parametrize("marker", ["***", "* * *", "---", "- - -", "———", "###", "~~~", "===",
                                    "___", "\\*\\*\\*", "⁂", "• • •", "~*~", "-=-", "*****"])
def test_every_marker_form_comes_out_on_its_own_line_or_between_words(marker):
    from tts_utils import filter_actions
    assert filter_actions(SCENE.replace("***", marker)) == SPOKEN
    # An extension copy that has not been re-installed still sends the message as one line.
    flat = " ".join(SCENE.replace("***", marker).split())
    assert filter_actions(flat) == SPOKEN


@pytest.mark.parametrize("text, spoken", [
    ("That was fun ^_^ let's go again.", "That was fun let's go again."),
    ("Oh no >_< not again.", "Oh no not again."),
    ("He scored 5 | 10 on it.", "He scored 5 10 on it."),
    ("• milk\n• eggs", "milk eggs"),
    ("Well -_- fine.", "Well fine."),
])
def test_a_stray_symbol_is_removed_without_ending_the_sentence(text, spoken):
    """An emoticon or a table pipe is not a scene break. Treated as one, it put a full stop in
    the middle of the sentence."""
    from tts_utils import filter_actions
    assert filter_actions(text) == spoken


def test_a_paragraph_ending_in_cjk_punctuation_gets_no_extra_full_stop():
    from tts_utils import filter_actions
    assert filter_actions("彼は去った。\n\n「待って！」\n\n終わり") == "彼は去った。 「待って！」 終わり"
    assert filter_actions("本当？\n\nはい") == "本当？ はい"


def test_a_long_run_of_asterisks_stuck_to_a_letter_does_not_stall_the_server():
    """The bold-line pattern was cubic in the length of such a run: about a second at 2,000
    characters and minutes at 10,000, holding every other request up. With the old pattern this
    test does not fail an assertion: it hangs for minutes (a regex holds the interpreter lock, so
    the per-test timeout cannot interrupt it) until the session limit ends the run."""
    from tts_utils import filter_actions
    assert filter_actions("*" * 20000 + "x") == "x"
    assert filter_actions("_" * 20000 + "x") == "_" * 20000 + "x"


def test_a_heading_line_is_its_own_sentence_without_a_marker():
    from tts_utils import filter_actions
    assert filter_actions("He left.\n## The Next Morning\nShe woke early.") == \
        "He left. The Next Morning. She woke early."
    assert filter_actions("He left.\n**0900, the next morning**\nShe woke early.") == \
        "He left. 0900, the next morning. She woke early."


def test_a_paragraph_that_already_ends_in_punctuation_is_left_alone():
    from tts_utils import filter_actions
    assert filter_actions('"Wait," she said:\n\n"Not yet."\n\nHe stopped') == \
        '"Wait," she said: "Not yet." He stopped'
    assert filter_actions('She said "go"\n\nHe went.') == 'She said "go." He went.'


def test_hard_wrapped_text_gets_no_full_stops_at_its_line_ends():
    from tts_utils import filter_actions
    assert filter_actions("The quick brown fox\njumps over\nthe lazy dog.") == \
        "The quick brown fox jumps over the lazy dog."


def test_one_line_of_plain_text_is_unchanged_so_its_cache_key_is_unchanged():
    from tts_utils import filter_actions
    for text in ("Hello there.  Two spaces, no stop", "It cost 2 + 2 = 4 - or so.",
                 "Wait -- what? I... I don't know."):
        assert filter_actions(text) == text


def test_text_with_no_words_is_nothing_to_speak():
    from tts_utils import filter_actions
    for text in ("***", "---", "* * *", "...", "\\*\\*\\*", "###\n\n---"):
        assert filter_actions(text) == ""
    assert filter_actions("*smiles* ...", narrate_actions=False) == ""


def test_a_scene_break_does_not_reverse_the_action_pairs_after_it():
    """A "***" line holds an odd number of asterisks. Left in, dialogue-only mode dropped "Later"
    and spoke "nods"."""
    from tts_utils import filter_actions
    src = "*smiles* Hi.\n\n***\n\nLater. *nods* Bye."
    assert filter_actions(src, narrate_actions=False) == "Hi. Later. Bye."


def test_list_partials_skips_manifestless_workspaces(tmp_path):
    pc.workspace(tmp_path, "000011112222").mkdir(parents=True)        # chunks, no manifest
    assert pc.list_partials(tmp_path) == []


# ── resume-behind: the banked prefix's duration (register reports resume_s) ───

def test_banked_prefix_seconds(tmp_path):
    import torch
    from tts_utils import save_wav_sf
    ws = pc.workspace(tmp_path, "abcdefabcdef")
    assert pc.banked_prefix_seconds(ws) == 0.0                 # no workspace at all
    ws.mkdir(parents=True)
    save_wav_sf(str(ws / "chunk_0000.wav"), torch.zeros(1, 24000), 24000)   # 1.0 s
    save_wav_sf(str(ws / "chunk_0001.wav"), torch.zeros(1, 12000), 24000)   # 0.5 s
    save_wav_sf(str(ws / "chunk_0003.wav"), torch.zeros(1, 24000), 24000)   # beyond the gap
    assert pc.banked_prefix_seconds(ws) == 1.5                 # contiguous prefix only
    # list_partials surfaces the same number as the row's duration_s (the
    # library's Length column shows it as "Xs so far")
    pc.write_pending(ws, {"voice": "V.wav", "text": "hi", "total": 5})
    assert pc.list_partials(tmp_path)[0]["duration_s"] == 1.5


# ── rename (display name only; the _H8 identity suffix survives) ──────────────

def test_rename_clip_moves_both_files_and_keeps_suffix(tmp_path):
    _make_clip(tmp_path, "Narrator_3/Hello_there_ab12cd34")
    new_ref = pc.rename_clip(tmp_path, "Narrator_3/Hello_there_ab12cd34", "Kitchen scene, take two!")
    assert new_ref == "Narrator_3/Kitchen_scene_take_two_ab12cd34"
    mp3, y = pc.clip_paths(tmp_path, new_ref)
    assert mp3.exists() and y.exists()
    assert not (tmp_path / "Narrator_3" / "Hello_there_ab12cd34.mp3").exists()
    assert pc.list_clips(tmp_path)[0]["name"] == "Kitchen scene, take two!"   # sidecar: exact


def test_rename_clip_guards(tmp_path):
    import pytest
    _make_clip(tmp_path, "Narrator_3/one_ab12cd34")
    assert pc.rename_clip(tmp_path, "Narrator_3/ghost_ab12cd99", "x") is None      # missing -> 404 path
    assert pc.rename_clip(tmp_path, "../evil", "x") is None                   # traversal-guarded
    with pytest.raises(ValueError):
        pc.rename_clip(tmp_path, "Narrator_3/one_ab12cd34", "!!!")                 # no usable chars
    # target-exists guard (defensive — same words + same H8 can't normally coexist)
    (tmp_path / "Narrator_3" / "stray_ab12cd34.mp3").write_bytes(b"x")
    with pytest.raises(ValueError):
        pc.rename_clip(tmp_path, "Narrator_3/one_ab12cd34", "stray")
    assert pc.rename_clip(tmp_path, "Narrator_3/one_ab12cd34", "one") == "Narrator_3/one_ab12cd34"  # no-op


def test_rename_clip_preserves_exact_name_in_sidecar(tmp_path):
    """The sidecar preserves the exact display name, including a leading underscore and punctuation. The file stem still passes through `safe_name` for filesystem compatibility."""
    _make_clip(tmp_path, "Narrator_3/Hello_there_ab12cd34")
    new_ref = pc.rename_clip(tmp_path, "Narrator_3/Hello_there_ab12cd34", "_Nightly test, v2!")
    assert new_ref == "Narrator_3/_Nightly_test_v2_ab12cd34"        # stem: safe_name'd
    assert pc.list_clips(tmp_path)[0]["name"] == "_Nightly test, v2!"   # display: exact


def test_favorites_toggle_and_list(tmp_path):
    _make_clip(tmp_path, "Narrator_3/one_ab12cd34")
    assert pc.list_clips(tmp_path)[0]["favorite"] is False
    assert pc.set_clip_favorite(tmp_path, "Narrator_3/one_ab12cd34", True) is True
    assert pc.list_clips(tmp_path)[0]["favorite"] is True
    assert pc.set_clip_favorite(tmp_path, "Narrator_3/one_ab12cd34", False) is False
    assert pc.set_clip_favorite(tmp_path, "Narrator_3/ghost_ab12cd99", True) is None
    # partials
    ws = pc.workspace(tmp_path, "aaaabbbbcccc")
    pc.write_pending(ws, {"voice": "V.wav", "text": "T.", "total": 2})
    assert pc.set_partial_favorite(tmp_path, "aaaabbbbcccc", True) is True
    assert pc.list_partials(tmp_path)[0]["favorite"] is True
    assert pc.read_pending(ws)["text"] == "T."                 # merge-write kept the rest
    assert pc.set_partial_favorite(tmp_path, "000011112222", True) is None


def test_rename_partial_stores_name_and_lists_it(tmp_path):
    import pytest
    ws = pc.workspace(tmp_path, "aaaabbbbcccc")
    pc.write_pending(ws, {"voice": "V.wav", "exaggeration": 0.5, "cfg": 0.5,
                          "temperature": 0.8, "text": "A long story begins.", "total": 5})
    assert pc.rename_partial(tmp_path, "aaaabbbbcccc", "Kitchen scene WIP") == "Kitchen scene WIP"
    assert pc.list_partials(tmp_path)[0]["name"] == "Kitchen scene WIP"
    # the name survives a resume's manifest rewrite (write_pending merges)
    pc.write_pending(ws, {"voice": "V.wav", "text": "A long story begins.", "total": 5})
    assert pc.read_pending(ws)["name"] == "Kitchen scene WIP"
    assert pc.rename_partial(tmp_path, "nope-not-hex!", "x") is None
    assert pc.rename_partial(tmp_path, "000011112222", "x") is None      # no manifest
    with pytest.raises(ValueError):
        pc.rename_partial(tmp_path, "aaaabbbbcccc", "!!!")


def test_find_ref_by_hash_survives_rename(tmp_path):
    """The overwrite-by-identity lookup finds a clip by its _H8 suffix — a rename
    must not fork a duplicate on the next render of the same inputs."""
    _make_clip(tmp_path, "Narrator_3/Hello_there_ab12cd34")
    assert pc.find_ref_by_hash(tmp_path, "Narrator_3", "ab12cd34ffff") == "Narrator_3/Hello_there_ab12cd34"
    new_ref = pc.rename_clip(tmp_path, "Narrator_3/Hello_there_ab12cd34", "Sample Favorite")
    assert pc.find_ref_by_hash(tmp_path, "Narrator_3", "ab12cd34ffff") == new_ref
    assert pc.find_ref_by_hash(tmp_path, "Narrator_3", "deadbeefffff") is None
    assert pc.find_ref_by_hash(tmp_path, "Nobody", "ab12cd34ffff") is None


def test_prefix_wav_decodes_exactly_the_prefix_its_seconds_twin_reports(tmp_path):
    """prefix_wav (decode) and banked_prefix_seconds (headers) must agree on where the
    banked prefix ends. The 🎓 button gates on the seconds; /train/import imports the
    waveform — if they disagreed, a partial would train on audio its row never played."""
    import torch
    from tts_utils import save_wav_sf
    assert pc.prefix_wav(tmp_path, "abcdefabcdef") == (None, 0)     # no workspace at all
    ws = pc.workspace(tmp_path, "abcdefabcdef")
    ws.mkdir(parents=True)
    assert pc.prefix_wav(tmp_path, "abcdefabcdef") == (None, 0)     # workspace, no chunks
    save_wav_sf(str(ws / "chunk_0000.wav"), torch.zeros(1, 24000), 24000)   # 1.0 s
    save_wav_sf(str(ws / "chunk_0001.wav"), torch.zeros(1, 12000), 24000)   # 0.5 s
    save_wav_sf(str(ws / "chunk_0003.wav"), torch.zeros(1, 24000), 24000)   # beyond the gap
    wav, sr = pc.prefix_wav(tmp_path, "abcdefabcdef")
    assert sr == 24000
    assert wav.shape[-1] == 36000                                  # chunk 3 is NOT included
    assert wav.shape[-1] / sr == pc.banked_prefix_seconds(ws)      # the two agree


# ── the corrupt-sidecar clobber (5.0-M2) ──────────────────────────────────────
#
# LIVE DATA LOSS, no encryption required. The idiom was `_read_yaml(y) or {}` -> mutate
# -> write back, so on an UNREADABLE sidecar one star click persisted `{"favorite": true}`
# and nothing else. The sidecar is the ONLY record of a clip's text/voice/knobs — the
# render workspace is rmtree'd once the clip lands (vocalis_server.py:1499) — so there is
# nothing to recover from.
#
# Same asymmetric-strictness fix as voice_utils.SettingsUnreadable: READS degrade, WRITES
# abort. And note ABSENT is not CORRUPT — a missing sidecar has nothing to destroy.

def test_favorite_on_corrupt_sidecar_aborts_and_does_not_wipe_it(tmp_path):
    mp3, y = _make_clip(tmp_path, "Angel/clip_ab12cd34")
    y.write_text("text: [broken\n", encoding="utf-8")          # unparseable

    with pytest.raises(pc.ClipSidecarUnreadable):
        pc.set_clip_favorite(tmp_path, "Angel/clip_ab12cd34", True)

    assert y.read_text(encoding="utf-8") == "text: [broken\n", "the corrupt sidecar was overwritten"


def test_rename_on_corrupt_sidecar_aborts_and_does_not_wipe_it(tmp_path):
    """Worse than the star click: rename_clip moves the mp3 FIRST, so a clobber here also
    destroys the only other place the old state could have been re-derived from."""
    mp3, y = _make_clip(tmp_path, "Angel/clip_ab12cd34")
    y.write_text("text: [broken\n", encoding="utf-8")

    with pytest.raises(pc.ClipSidecarUnreadable):
        pc.rename_clip(tmp_path, "Angel/clip_ab12cd34", "New Name")

    survivors = sorted(p.name for p in (tmp_path / "Angel").glob("*.yaml"))
    assert len(survivors) == 1
    assert (tmp_path / "Angel" / survivors[0]).read_text(encoding="utf-8") == "text: [broken\n"


def test_favorite_on_a_GOOD_sidecar_still_preserves_everything(tmp_path):
    """The regression guard: the strict= flag must not break the happy path."""
    mp3, y = _make_clip(tmp_path, "Angel/clip_ab12cd34", text="The user's whole novel.")
    assert pc.set_clip_favorite(tmp_path, "Angel/clip_ab12cd34", True) is True

    meta = yaml.safe_load(y.read_text(encoding="utf-8"))
    assert meta["favorite"] is True
    assert meta["text"] == "The user's whole novel."      # <- what used to be destroyed
    assert meta["voice"] == "V.wav" and meta["cfg"] == 0.5 and meta["temperature"] == 0.8


def test_favorite_on_an_ABSENT_sidecar_still_works(tmp_path):
    """ABSENT is not CORRUPT. A missing sidecar has nothing to destroy, so favoriting a
    clip whose sidecar was never written must still succeed — not 500."""
    mp3, y = pc.clip_paths(tmp_path, "Angel/clip_ab12cd34")
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3-fake")
    assert not y.exists()

    assert pc.set_clip_favorite(tmp_path, "Angel/clip_ab12cd34", True) is True
    assert yaml.safe_load(y.read_text(encoding="utf-8"))["favorite"] is True


def test_write_pending_on_a_corrupt_manifest_aborts(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / pc.PENDING_NAME).write_text("text: [broken\n", encoding="utf-8")

    with pytest.raises(pc.ClipSidecarUnreadable):
        pc.write_pending(ws, {"favorite": True})

    assert (ws / pc.PENDING_NAME).read_text(encoding="utf-8") == "text: [broken\n"


def test_write_pending_is_atomic(tmp_path):
    """write_pending was a bare write_text — so a crash mid-write left a truncated
    manifest, i.e. it was itself the PRODUCER of the corrupt files the readers then ate."""
    ws = tmp_path / "ws"
    pc.write_pending(ws, {"text": "T.", "name": "keep me"})
    pc.write_pending(ws, {"favorite": True})

    assert not list(ws.glob("*.part")), "a .part file was orphaned"
    m = pc.read_pending(ws)
    assert m["favorite"] is True and m["name"] == "keep me" and m["text"] == "T."


# ── the LISTING clobber (5.0-M2.5) ───────────────────────────────────────────
#
# 4.1 gave list_clips a cache write (the bandwidth measurement) and reached for the
# NON-strict read to base it on. `_read_yaml(y) or {}` collapses CORRUPT into {},
# bandwidth_of can never cache-hit on {}, so `fresh` was always truthy and the write
# always fired — overwriting every corrupt sidecar with three bandwidth fields on every
# open of the library panel. Strictly worse than the ★-click bug M2a fixed: no click, and
# it hits every clip at once.
#
# These fail on main today. That is the point of them.

def test_listing_does_not_clobber_a_corrupt_sidecar(tmp_path):
    mp3, y = _make_clip(tmp_path, "Angel/clip_ab12cd34")
    y.write_text("text: [broken\n", encoding="utf-8")          # unparseable

    rows = pc.list_clips(tmp_path)                             # must not raise…

    assert y.read_text(encoding="utf-8") == "text: [broken\n", \
        "listing the library overwrote a sidecar it could not read"
    assert len(rows) == 1, "the clip still lists — a read degrades, it does not vanish"


def test_a_clip_with_no_sidecar_does_not_list_at_all(tmp_path):
    """Why the ABSENT case cannot arise here, unlike in voicetrain._source_row: this
    listing is driven by `vdir.glob("*.yaml")`, so a clip with no sidecar is never seen.
    The strict read therefore only ever meets a file that EXISTS — corrupt or good — and
    'absent' is voicetrain's problem, not this one."""
    mp3, y = pc.clip_paths(tmp_path, "Angel/clip_ab12cd34")
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3-fake")
    assert not y.exists()

    assert pc.list_clips(tmp_path) == []
    assert not y.exists(), "the listing invented a sidecar for a clip it never listed"


def test_listing_a_GOOD_sidecar_still_caches_and_preserves_everything(tmp_path):
    """The regression guard: strict= must not break the happy path."""
    mp3, y = _make_clip(tmp_path, "Angel/clip_ab12cd34", text="The user's whole novel.")

    pc.list_clips(tmp_path)

    meta = yaml.safe_load(y.read_text(encoding="utf-8"))
    assert "bandwidth_hz" in meta                     # the measurement was cached
    assert meta["text"] == "The user's whole novel."  # …and nothing was lost to it
    assert meta["voice"] == "V.wav" and meta["cfg"] == 0.5


# ── enhancement is part of the identity (4.1) ────────────────────────────────

def test_enhanced_and_plain_takes_of_the_same_text_are_different_clips():
    """THE COLLISION. Render the same text enhanced and un-enhanced and, without this,
    both land on one H — so they share a clip path and you get back whichever finished
    last. The `_enhanced` filename suffix is the human half of telling them apart; the
    hash is the machine half, and with only the suffix the bug reads as a haunting."""
    plain = pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hello there.")
    enh   = pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hello there.", enhanced=True, nfe=32)
    assert plain != enh


def test_step_count_changes_the_identity_when_enhancing():
    """Different enhancement step counts produce different audio and therefore distinct clip identities. The identity must not depend on whichever setting was most recently used."""
    h = {n: pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hi.", enhanced=True, nfe=n) for n in (8, 16, 32)}
    assert len(set(h.values())) == 3


def test_step_count_is_ignored_when_not_enhancing():
    """nfe has NO effect on un-enhanced audio. Folding it into the key regardless would
    mint distinct clips for a knob that did nothing."""
    assert (pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hi.", nfe=8)
            == pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hi.", nfe=32))


def test_an_unenhanced_clip_keeps_its_pre_4_1_identity():
    """An un-enhanced clip is bit-for-bit what 4.0 rendered from the same inputs, so it
    must keep 4.0's H. Salting every key would orphan the whole existing library from the
    overwrite path: re-rendering an old clip would spawn a duplicate under a fresh H
    instead of replacing it."""
    key = "V.wav|0.5|0.5|0.8|1|Hello there."
    import hashlib
    expected = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    assert pc.clip_hash("V.wav", 0.5, 0.5, 0.8, "Hello there.") == expected


def test_enhanced_stem_keeps_the_hash_terminal():
    """`_enhanced` sits BEFORE the hash. find_ref_by_hash globs on a trailing `_<H8>` and
    rename_clip anchors on it — put the marker after the hash and both break silently."""
    stem = pc.clip_stem("Hello there.", "abcdef1234ab", enhanced=True)
    assert stem == "Hello_there_enhanced_abcdef12"
    assert pc.clip_stem("Hello there.", "abcdef1234ab") == "Hello_there_abcdef12"


def test_find_ref_by_hash_still_finds_an_enhanced_clip(tmp_path):
    d = tmp_path / 'TestCharacter'
    d.mkdir(parents=True)
    (d / "Hello_there_enhanced_abcdef12.mp3").write_bytes(b"x")
    assert (pc.find_ref_by_hash(tmp_path, 'TestCharacter', "abcdef1234ab")
            == 'TestCharacter/Hello_there_enhanced_abcdef12')


def test_rename_preserves_the_enhanced_marker(tmp_path):
    """The marker is not decoration: it is how you tell two takes of the same text apart
    in a flat library. Tidying up a name must not erase it."""
    d = tmp_path / 'TestCharacter'
    d.mkdir(parents=True)
    (d / "Old_name_enhanced_abcdef12.mp3").write_bytes(b"x")
    (d / "Old_name_enhanced_abcdef12.yaml").write_text("voice: V.wav\n", encoding="utf-8")
    ref = pc.rename_clip(tmp_path, 'TestCharacter/Old_name_enhanced_abcdef12', "Bedtime story")
    assert ref == 'TestCharacter/Bedtime_story_enhanced_abcdef12'
    assert (d / "Bedtime_story_enhanced_abcdef12.mp3").exists()
    # and the identity suffix survived, so a re-render still overwrites this clip
    assert pc.find_ref_by_hash(tmp_path, 'TestCharacter', "abcdef1234ab") == ref


def test_rename_of_a_plain_clip_does_not_invent_the_marker(tmp_path):
    d = tmp_path / 'TestCharacter'
    d.mkdir(parents=True)
    (d / "Old_name_abcdef12.mp3").write_bytes(b"x")
    (d / "Old_name_abcdef12.yaml").write_text("voice: V.wav\n", encoding="utf-8")
    assert (pc.rename_clip(tmp_path, 'TestCharacter/Old_name_abcdef12', "New name")
            == 'TestCharacter/New_name_abcdef12')


def test_chunk_seconds_reads_the_header_not_the_chunk_count(tmp_path):
    """The 60-minute cap counts SECONDS, and seconds is not something you can infer from a
    chunk count — chunks run from a clause to 400 characters."""
    import torch
    from tts_utils import save_wav_sf
    ws = pc.workspace(tmp_path, "abcdefabcdef")
    ws.mkdir(parents=True)
    save_wav_sf(str(ws / "chunk_0000.wav"), torch.zeros(1, 36000), 24000)   # 1.5 s
    assert pc.chunk_seconds(ws, 0) == 1.5
    assert pc.chunk_seconds(ws, 7) == 0.0        # missing chunk contributes nothing

"""The audio-scene store (6.0 §5) — identity, layout, manifests, rename, delete.

The store exists as a SECOND store rather than a corner of `output/playground` for one reason,
and most of this file is about that reason: a playground clip is identity-keyed on its inputs
and is *deliberately overwritten* by a re-render, and a scene must never be overwritten by
anything. §12 lists reusing the clip store as rejected — "a scene that a later render silently
replaced would be a data-loss bug wearing a feature's clothes" — and the way that bug comes back
is not by someone moving the directory, it is by someone copying `clip_hash`.
"""
from pathlib import Path

import pytest

import playground_clips
import scenes
import vault
from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)


KEYS = ["k1111111", "k2222222", "k3333333"]


def _mk(root: Path, stem: str, meta=None):
    """Land a scene pair on disk the way a build would."""
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{stem}.mp3").write_bytes(b"ID3 fake audio")
    scenes.write_manifest(root / f"{stem}.yaml", meta or {"title": "A scene", "entries": []})
    return stem


# ── identity: the difference from a playground clip ──────────────────────────────────────

def test_two_builds_of_the_same_range_are_two_scenes():
    """A nonce gives otherwise identical scene inputs distinct identities."""
    common = dict(title="The ferry", owner='st:Test User', gap_s=0.7, cache_keys=KEYS)
    a = scenes.scene_hash(**common, created="2026-07-31T18:00:00")
    b = scenes.scene_hash(**common, created="2026-07-31T19:30:00")
    assert a != b, ("two builds landed on one hash — a rebuild would overwrite the earlier "
                    "scene. `created` is in the key for exactly this")


def test_two_builds_in_the_SAME_SECOND_are_still_two_scenes():
    """🔴 THE HOLE IN THE RULE ABOVE, found by 6.0-m2's Join.

    `now()` is second-resolution, deliberately, because it is what the Clips tab prints. So
    `created` alone does NOT deliver the promise the test above asserts: joining the same two
    clips twice takes about a tenth of a second each time, both land in the same second, both
    hash identically — and the second scene overwrites the first, with no error anywhere.

    Reachable for scene builds too: an all-cached rebuild finishes in about four seconds.

    `now_exact()` is the token that actually separates them, and this is the assertion that
    stops the fix being quietly dropped.
    """
    common = dict(title="The ferry", owner='st:Test User', gap_s=0.7, cache_keys=KEYS,
                  created="2026-07-31T18:00:00")          # the SAME second, both times
    a = scenes.scene_hash(**common, nonce=scenes.now_exact())
    b = scenes.scene_hash(**common, nonce=scenes.now_exact())
    assert a != b, "two builds inside one second collided — the later one overwrites the earlier"


def test_now_exact_never_repeats_even_in_a_tight_loop():
    """Windows' clock granularity is coarser than a float's, so 'add microseconds' on its own
    is not enough — hence the per-process counter."""
    seen = [scenes.now_exact() for _ in range(2000)]
    assert len(set(seen)) == len(seen)


def test_a_hash_with_no_nonce_is_unchanged():
    """Without a nonce, the scene hash remains stable for the same inputs."""
    common = dict(title="The ferry", owner='st:Test User', gap_s=0.7, cache_keys=KEYS,
                  created="2026-07-31T18:00:00")
    assert scenes.scene_hash(**common) == scenes.scene_hash(**common, nonce="")


def test_the_hash_still_describes_what_the_scene_is():
    """`created` making every build unique must not make the rest of the key decorative — the
    audio and the gap are what the file IS, and a hash that ignored them would make staleness
    detection (§4) and any future dedup meaningless."""
    fixed = dict(title="The ferry", owner='st:Test User', created="2026-07-31T18:00:00")
    base = scenes.scene_hash(**fixed, gap_s=0.7, cache_keys=KEYS)
    assert base != scenes.scene_hash(**fixed, gap_s=1.4, cache_keys=KEYS), "gap is audible"
    assert base != scenes.scene_hash(**fixed, gap_s=0.7, cache_keys=KEYS[:2]), "fewer messages"
    assert base != scenes.scene_hash(**fixed, gap_s=0.7, cache_keys=list(reversed(KEYS))), (
        "order is the conversation — a reordered scene is a different scene")


def test_enhancing_does_not_collide_with_the_raw_take():
    """§3.5a keeps BOTH versions, so the two must not race for one path. Same rule as
    `clip_hash`, which folds `enhanced` in for the same reason."""
    common = dict(title="The ferry", owner='st:Test User', gap_s=0.7, cache_keys=KEYS,
                  created="2026-07-31T18:00:00")
    assert scenes.scene_hash(**common) != scenes.scene_hash(**common, enhanced=True, nfe=32)


# ── layout: the H8 stays terminal ────────────────────────────────────────────────────────

def test_the_enhanced_marker_sits_BEFORE_the_hash():
    """`playground_clips`' comment is emphatic that the H8 must be the LAST token — its glob
    and its rename both anchor on it. A new store copying the layout must copy that rule, and
    the failure mode if it doesn't is silent: the glob matches nothing and the rename mangles
    the stem."""
    assert scenes.stem_for("ferry", "ab12cd34ef56") == "ferry_ab12cd34"
    assert scenes.stem_for("ferry", "ab12cd34ef56", True) == "ferry_enhanced_ab12cd34"


def test_the_two_stores_spell_a_stem_identically():
    """Pinned against each other rather than restated, because two copies of one rule is how
    the rule drifts. If `playground_clips.stem_for` ever changes shape, this fails here instead
    of in whichever of the two globs was written second."""
    for enh in (False, True):
        assert scenes.stem_for("thing", "0123456789ab", enh) == \
               playground_clips.stem_for("thing", "0123456789ab", enh)


def test_the_slug_comes_from_the_title_never_from_the_messages():
    """🔴 §5.1. A stem derived from message text puts a line of the conversation into a
    filename — the one part of an artifact that ends up in a file picker, a bug report and a
    shell history. `playground_clips.clip_stem` DOES derive from text, correctly, because a
    clip's text is its identity; this is the place that must not copy it."""
    # `&` and `:` are dropped and the whitespace run collapses to one `_` — safe_name's rules,
    # not ours, and the same ones the clip store has always used.
    assert scenes.scene_stem('Test User & me: the ferry', "ab12cd34") == "Test_User_me_the_ferry_ab12cd34"
    # …and a title that safe_name empties out still yields a usable stem rather than "section"
    assert scenes.scene_stem("!!!", "ab12cd34") == "scene_ab12cd34"
    assert scenes.scene_stem("", "ab12cd34") == "scene_ab12cd34"


@pytest.mark.parametrize("ref", ["../secrets", "a/b", "a\\b", "..", ".", ""])
def test_a_traversal_ref_resolves_to_nothing(tmp_path, ref):
    """Refs arrive from the browser. The shape check and the containment check both have to
    hold — one guard on a path is a guard you get to be wrong about."""
    assert scenes.scene_paths(tmp_path, ref) == (None, None)


def test_a_wellformed_ref_resolves_to_the_pair(tmp_path):
    mp3, y = scenes.scene_paths(tmp_path, "ferry_ab12cd34")
    assert mp3 == tmp_path / "ferry_ab12cd34.mp3"
    assert y == tmp_path / "ferry_ab12cd34.yaml"


# ── the manifest ─────────────────────────────────────────────────────────────────────────

def test_a_corrupt_manifest_degrades_on_read_and_ABORTS_on_write(tmp_path):
    """Reads degrade, writes abort — the rule `ClipSidecarUnreadable` established, and it bites
    harder here. A clip's sidecar can be rebuilt by re-rendering the text; a scene's manifest is
    the only record of which messages are inside a file that may run an hour, in what order, at
    what offsets. A writer starting from `{}` turns the scene into anonymous audio."""
    p = tmp_path / "ferry_ab12cd34.yaml"
    p.write_text("{{{ not yaml", encoding="utf-8")
    assert scenes.read_manifest(p) is None
    with pytest.raises(scenes.SceneManifestUnreadable):
        scenes.read_manifest(p, strict=True)


def test_an_absent_manifest_is_not_corrupt(tmp_path):
    """ABSENT ≠ CORRUPT. Nothing to destroy, so strict returns None and the first write of a
    new scene goes through."""
    assert scenes.read_manifest(tmp_path / "nope.yaml", strict=True) is None


def test_a_manifest_that_is_not_a_mapping_is_corrupt(tmp_path):
    p = tmp_path / "ferry_ab12cd34.yaml"
    p.write_text("- just\n- a list\n", encoding="utf-8")
    with pytest.raises(scenes.SceneManifestUnreadable):
        scenes.read_manifest(p, strict=True)


# ── listing ──────────────────────────────────────────────────────────────────────────────

def test_listing_reports_both_takes_of_one_build_as_two_rows(tmp_path):
    """§3.5a: two complete artifacts, not one file with a flag. §7.1's filter is built on the
    `enhanced` field of these rows."""
    _mk(tmp_path, "ferry_ab12cd34", {"title": "The ferry", "entries": [{}, {}],
                                     "total_duration_s": 120.0})
    _mk(tmp_path, "ferry_enhanced_ff00ff00", {"title": "The ferry", "entries": [{}, {}],
                                              "enhanced": True, "nfe": 32,
                                              "raw_ref": "ferry_ab12cd34"})
    rows = {r["ref"]: r for r in scenes.list_scenes(tmp_path)}
    assert set(rows) == {"ferry_ab12cd34", "ferry_enhanced_ff00ff00"}
    assert rows["ferry_ab12cd34"]["enhanced"] is False
    assert rows["ferry_enhanced_ff00ff00"]["enhanced"] is True
    assert rows["ferry_enhanced_ff00ff00"]["raw_ref"] == "ferry_ab12cd34", (
        "the twin must point at its parent, or the tab cannot pair them")
    assert rows["ferry_ab12cd34"]["n_entries"] == 2


def test_a_listing_does_not_ship_the_transcript(tmp_path):
    """⚠️ §5.1. `entries` carries `text` per message — the conversation. The list route is the
    one the UI calls most, and putting the whole chat through it, a JSON encoder and the
    browser's memory to draw a row is not a thing to do by accident."""
    _mk(tmp_path, "ferry_ab12cd34",
        {"title": "The ferry", "entries": [{"text": "the unmistakable secret words"}]})
    rows = scenes.list_scenes(tmp_path)
    assert "entries" not in rows[0]
    assert "the unmistakable secret" not in repr(rows)


def test_a_half_written_pair_is_not_a_scene(tmp_path):
    """A manifest with no audio beside it is a build that died, not a scene. It must not draw
    a row with a play button that 404s."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    scenes.write_manifest(tmp_path / "ferry_ab12cd34.yaml", {"title": "The ferry"})
    assert scenes.list_scenes(tmp_path) == []


def test_an_unreadable_manifest_still_lists_its_audio(tmp_path):
    """An unreadable manifest does not hide its playable audio file."""
    (tmp_path).mkdir(parents=True, exist_ok=True)
    (tmp_path / "ferry_ab12cd34.mp3").write_bytes(b"ID3 fake audio")
    (tmp_path / "ferry_ab12cd34.yaml").write_text("{{{ not yaml", encoding="utf-8")
    rows = scenes.list_scenes(tmp_path)
    assert len(rows) == 1 and rows[0]["ref"] == "ferry_ab12cd34"
    assert rows[0]["name"] == "ferry"          # derived from the stem, H8 dropped


def test_listing_a_missing_root_is_empty_not_an_error(tmp_path):
    assert scenes.list_scenes(tmp_path / "never-made") == []


# ── 7.5: the name a scene is KNOWN BY, derived once ──────────────────────────────────────

@pytest.mark.parametrize("meta,stem,want", [
    ({"title": "The ferry"}, "The_ferry_ab12cd34", "The ferry"),      # the manifest wins
    ({}, "The_ferry_ab12cd34", "The ferry"),                          # …else the stem, H8 off
    ({}, "The_ferry_enhanced_ab12cd34", "The ferry"),                 # …enhanced marker too
    (None, "night_walk_ff00ff00", "night walk"),                      # unreadable manifest
    ({"title": ""}, "night_walk_ff00ff00", "night walk"),             # blank title is no title
])
def test_display_name_reads_the_title_then_falls_back_to_the_stem(meta, stem, want):
    assert scenes.display_name(meta, stem) == want


def test_the_listing_and_the_training_import_agree_about_a_scenes_name(tmp_path):
    """The scene listing title and training-import name use the same derivation."""
    _mk(tmp_path, "The_ferry_ab12cd34", {"title": "The ferry"})
    # ⚠️ `{"entries": []}`, not `{}` — `_mk`'s `meta or {…}` reads an empty dict as "none given"
    # and substitutes a default TITLE, which is the one shape this test must not have.
    _mk(tmp_path, "night_walk_ff00ff00", {"entries": []})   # no title — the stem path
    by_ref = {r["ref"]: r for r in scenes.list_scenes(tmp_path)}
    for ref, row in by_ref.items():
        meta = scenes.read_manifest(tmp_path / f"{ref}.yaml")
        assert row["name"] == scenes.display_name(meta, ref)


# ── finding, renaming, deleting ──────────────────────────────────────────────────────────

def test_find_by_hash_tells_the_two_takes_apart(tmp_path):
    _mk(tmp_path, "ferry_ab12cd34")
    _mk(tmp_path, "ferry_enhanced_ab12cd34")
    assert scenes.find_ref_by_hash(tmp_path, "ab12cd34") == "ferry_ab12cd34"
    assert scenes.find_ref_by_hash(tmp_path, "ab12cd34", enhanced=True) == "ferry_enhanced_ab12cd34"


def test_rename_keeps_the_hash_and_the_enhanced_marker(tmp_path):
    """The marker is how §7.1's filter tells the two rows apart. Tidying a name must not merge
    them, and the H8 must stay terminal or `find_ref_by_hash` stops finding the pair."""
    _mk(tmp_path, "ferry_enhanced_ab12cd34", {"title": "The ferry", "enhanced": True})
    new = scenes.rename_scene(tmp_path, "ferry_enhanced_ab12cd34", "Crossing to Ullapool")
    assert new == "Crossing_to_Ullapool_enhanced_ab12cd34"
    assert (tmp_path / f"{new}.mp3").is_file() and (tmp_path / f"{new}.yaml").is_file()
    assert not (tmp_path / "ferry_enhanced_ab12cd34.mp3").exists()
    # the EXACT typed name lands in the manifest — the stem went through safe_name
    assert scenes.read_manifest(tmp_path / f"{new}.yaml")["title"] == "Crossing to Ullapool"


def test_rename_refuses_an_unusable_name_and_a_collision(tmp_path):
    _mk(tmp_path, "ferry_ab12cd34")
    _mk(tmp_path, "Other_ab12cd34")
    with pytest.raises(ValueError):
        scenes.rename_scene(tmp_path, "ferry_ab12cd34", "!!!")
    with pytest.raises(ValueError):
        scenes.rename_scene(tmp_path, "ferry_ab12cd34", "Other")


def test_rename_of_a_missing_scene_is_None_not_an_exception(tmp_path):
    assert scenes.rename_scene(tmp_path, "nope_ab12cd34", "Whatever") is None


def test_delete_removes_the_pair_and_reports_what_went(tmp_path):
    _mk(tmp_path, "ferry_ab12cd34")
    assert scenes.delete_scenes(tmp_path, ["ferry_ab12cd34", "never_existed_00000000",
                                           "../escape"]) == ["ferry_ab12cd34"]
    assert not (tmp_path / "ferry_ab12cd34.mp3").exists()
    assert not (tmp_path / "ferry_ab12cd34.yaml").exists()


def test_deleting_the_raw_take_leaves_the_enhanced_one(tmp_path):
    """⚠️ No cascade. §7.1's cleanup workflow is "filter to not enhanced, select all, delete" —
    a cascade would take the enhanced ones too, which is the exact opposite of what the filter
    is for."""
    _mk(tmp_path, "ferry_ab12cd34")
    _mk(tmp_path, "ferry_enhanced_ff00ff00", {"raw_ref": "ferry_ab12cd34", "enhanced": True})
    scenes.delete_scenes(tmp_path, ["ferry_ab12cd34"])
    assert (tmp_path / "ferry_enhanced_ff00ff00.mp3").is_file()


# ── the store is registered with the vault ───────────────────────────────────────────────

def test_the_store_is_a_structural_name(tmp_path):
    """The scene output container remains structurally named while user titles stay inside its manifests."""
    assert "output/scenes" in vault.STRUCTURAL
    assert not any(p.startswith("output/scenes/") for p in vault.STRUCTURAL), (
        "a pattern reaching INTO output/scenes would put the title of a private conversation "
        "on the platter in cleartext")

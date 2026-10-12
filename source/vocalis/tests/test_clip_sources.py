"""The Clips tab's unified view (6.0-m2 §7) — three stores, one row shape.

§7's ruling is that this is "a view plus a verb, not a fourth storage system", so what is
tested here is almost entirely ADAPTATION: that each store's own vocabulary survives being
flattened, that the flattening does not invent identity, and that one broken store does not
take the tab down with it.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import clip_sources                                        # noqa: E402
import playground_clips                                    # noqa: E402
import scenes                                              # noqa: E402


# ── fixtures: a real row in each of the three stores ─────────────────────────────────────

def _scene(output_dir: Path, stem="Ferry_ab12cd34", *, name="The ferry", enhanced=False):
    root = scenes.scenes_root(output_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{stem}.mp3").write_bytes(b"ID3 scene audio")
    scenes.write_manifest(root / f"{stem}.yaml", {
        "title": name, "owner": "st:Test User", "created": scenes.now(), "gap_s": 0.7,
        "enhanced": enhanced, "total_duration_s": 12.5,
        "entries": [{"mesid": 1, "character": 'Test Character 1', "cache_key": "k0", "offset_s": 0.0,
                     "duration_s": 12.5, "text": "the unmistakable secret words"}],
    })
    return stem


def _pg_clip(output_dir: Path, vdir='Test_Voice_1', stem="hello_12345678", *, text="typed by hand"):
    d = output_dir / "playground" / vdir
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{stem}.mp3").write_bytes(b"ID3 playground audio")
    playground_clips.write_clip_yaml(d / f"{stem}.yaml", {
        "name": "Hello there", "voice": 'Test_Voice_1.wav', "text": text,
        "duration_s": 3.25, "enhanced": False, "created": "2026-07-31T10:00:00",
    })
    return f"{vdir}/{stem}"


class _VtCfg:
    """The shape `voicetrain.list_sources` / `source_path` read off a TrainConfig."""
    def __init__(self, d):
        self.training_dir = str(d)


def _upload(tmp_path: Path, name="a read.wav"):
    d = tmp_path / "training"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(b"RIFF....WAVEfmt ")
    return _VtCfg(d)


# ── the row shape ────────────────────────────────────────────────────────────────────────

def test_all_three_stores_flatten_into_one_shape(tmp_path):
    out = tmp_path / "output"
    _scene(out)
    _pg_clip(out)
    vt = _upload(tmp_path)
    rows = clip_sources.list_items(out, vt)

    assert {r["kind"] for r in rows} == {"scene", "playground", "upload"}
    for r in rows:
        # Every consumer — the table, the Join tray, the running total — reads these.
        for field in ("kind", "ref", "name", "duration_s", "size", "created_ts",
                      "enhanced", "origin", "audio_url"):
            assert field in r, f"{r['kind']} row is missing {field}"


def test_a_row_carries_the_route_that_actually_serves_it(tmp_path):
    out = tmp_path / "output"
    _scene(out, "Ferry_ab12cd34")
    _pg_clip(out, 'Test_Voice_1', "hello_12345678")
    vt = _upload(tmp_path, "a read.wav")
    by = {r["kind"]: r for r in clip_sources.list_items(out, vt)}

    assert by["scene"]["audio_url"] == "/clips/scenes/Ferry_ab12cd34/audio"
    # 🔴 The slash inside a playground ref is STRUCTURAL — the route is a <path:ref>. Escaping
    # it to %2F gives a 404 that looks like a missing clip.
    assert by["playground"]["audio_url"] == '/playground/clips/Test_Voice_1/hello_12345678/audio'
    assert by["upload"]["audio_url"] == "/train/sources/a%20read.wav/audio"


def test_the_catalogue_does_not_ship_the_words(tmp_path):
    """⚠️ §5.1, applied past scenes. The scene list already withholds `entries`; a Playground
    clip carries the prompt it was rendered from, which is the same kind of content by another
    door. This route runs on every open of the tab."""
    out = tmp_path / "output"
    _scene(out)
    _pg_clip(out, text="the unmistakable secret words")
    rows = clip_sources.list_items(out, None)
    blob = repr(rows)
    assert "unmistakable secret words" not in blob     # the scene's transcript
    assert "typed by hand" not in blob                 # the playground clip's prompt
    # The transcript itself, not the word: `n_entries` is a COUNT and the m1 scene list
    # already ships it, so a substring test on "entries" fails for the wrong reason.
    assert all("entries" not in r for r in rows)
    assert all("text" not in r for r in rows)


# ── identity ─────────────────────────────────────────────────────────────────────────────

def test_the_same_ref_in_two_stores_stays_two_rows(tmp_path):
    """🔴 Identity is (kind, ref), never ref alone. Nothing stops a scene and an upload sharing
    a name, and a selection keyed on ref alone would join or delete the wrong file."""
    out = tmp_path / "output"
    _scene(out, "shared_name", name="shared name")
    vt = _upload(tmp_path, "shared_name.wav")
    rows = clip_sources.list_items(out, vt)
    refs = [r["ref"] for r in rows]
    assert len(rows) == 2
    assert len(set(refs)) <= 2
    # The PAIR is what is unique, and that is what every downstream set must key on.
    assert len({(r["kind"], r["ref"]) for r in rows}) == 2


def test_newest_first_across_all_three_stores(tmp_path):
    out = tmp_path / "output"
    _scene(out)
    _pg_clip(out)
    rows = clip_sources.list_items(out, None)
    ts = [r["created_ts"] or 0 for r in rows]
    assert ts == sorted(ts, reverse=True)


# ── filtering, degrading, and the things that must NOT appear ────────────────────────────

def test_kinds_filters_at_the_source(tmp_path):
    """Not in the client: two of the three listings measure duration and bandwidth on anything
    they have not seen, and this route runs on every tab switch."""
    out = tmp_path / "output"
    _scene(out)
    _pg_clip(out)
    vt = _upload(tmp_path)
    only = clip_sources.list_items(out, vt, kinds=["scene"])
    assert only and {r["kind"] for r in only} == {"scene"}


def test_no_upload_store_configured_is_not_an_outage(tmp_path):
    """A fresh install has no training directory in app settings. The other two kinds still
    have to list, or the whole tab is empty because of a store the user never set up."""
    out = tmp_path / "output"
    _scene(out)
    _pg_clip(out)
    rows = clip_sources.list_items(out, None)
    assert {r["kind"] for r in rows} == {"scene", "playground"}


def test_one_broken_store_does_not_take_the_tab_down(tmp_path, monkeypatch):
    out = tmp_path / "output"
    _scene(out)

    def boom(_root):
        raise RuntimeError("the playground tree is unreadable")
    monkeypatch.setattr(playground_clips, "list_clips", boom)
    rows = clip_sources.list_items(out, None)
    assert [r["kind"] for r in rows] == ["scene"]


def test_an_upload_is_never_counted_as_enhanced(tmp_path):
    """⚠️ `enhanced` on a training source is a POINTER to a cached enhanced WAV for training
    prep — a different thing wearing the same word. Reading it here would put uploads under
    §7.1's filter, which exists to separate the two TAKES of a render."""
    vt = _upload(tmp_path)
    rows = clip_sources.list_items(tmp_path / "output", vt, kinds=["upload"])
    assert rows and all(r["enhanced"] is False for r in rows)


# ── resolve ──────────────────────────────────────────────────────────────────────────────

def test_resolve_finds_each_kind(tmp_path):
    out = tmp_path / "output"
    s = _scene(out)
    p = _pg_clip(out)
    vt = _upload(tmp_path, "a read.wav")
    assert clip_sources.resolve(out, vt, "scene", s).name.endswith(".mp3")
    assert clip_sources.resolve(out, vt, "playground", p).name.endswith(".mp3")
    assert clip_sources.resolve(out, vt, "upload", "a read.wav").name == "a read.wav"


@pytest.mark.parametrize("kind,ref", [
    ("playground", "../../etc/passwd"),
    ("playground", 'Test_Voice_1/../../../secrets'),
    ("upload", "../../../etc/passwd"),
    ("upload", "sub/dir.wav"),
    ("scene", "../../../etc/passwd"),
    ("nonsense", "whatever"),
])
def test_resolve_refuses_traversal_and_unknown_kinds(tmp_path, kind, ref):
    """Each branch delegates to the store's OWN resolver, which is where the traversal check
    lives. This asserts the delegation actually happened."""
    out = tmp_path / "output"
    _upload(tmp_path)
    vt = _VtCfg(tmp_path / "training")
    assert clip_sources.resolve(out, vt, kind, ref) is None


def test_a_playground_ref_that_is_malformed_returns_none_not_a_tuple(tmp_path):
    """🔴 `clip_paths` answers (None, None) — a NON-EMPTY tuple, so it is truthy. A guard
    written as `if not pair` sails straight past it and hands a tuple to the caller."""
    got = clip_sources.resolve(tmp_path / "output", None, "playground", "no-slash-here")
    assert got is None


def test_a_scene_row_still_carries_the_chat_the_filter_box_promises(tmp_path):
    """⚠️ No column shows `chat`, but the Clips filter placeholder says "name or chat" and the
    m1 list matched on it. A flattened row that dropped it would narrow the search silently —
    the box would still accept the words and simply find nothing."""
    out = tmp_path / "output"
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    (root / "ferry_ab12cd34.mp3").write_bytes(b"ID3")
    scenes.write_manifest(root / "ferry_ab12cd34.yaml", {
        "title": "The ferry", "owner": "st:Test User", "chat": "test-user-chat-17",
        "created": scenes.now(), "gap_s": 0.7, "entries": []})
    row = [r for r in clip_sources.list_items(out, None) if r["kind"] == "scene"][0]
    assert row["chat"] == "test-user-chat-17"


def test_a_scene_row_carries_its_skipped_count(tmp_path):
    """🔴 §9: an unspeakable message is "skipped, counted, and reported in the manifest — not
    silently dropped", and the Clips row is the only place that is visible. Flattening three
    stores into one shape nearly lost it."""
    out = tmp_path / "output"
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    (root / "ferry_ab12cd34.mp3").write_bytes(b"ID3")
    scenes.write_manifest(root / "ferry_ab12cd34.yaml", {
        "title": "The ferry", "owner": "st:Test User", "created": scenes.now(), "gap_s": 0.7,
        "entries": [{"mesid": 1, "cache_key": "k", "duration_s": 1.0, "text": "x"}],
        "skipped": [{"mesid": 2, "reason": "nothing speakable"},
                    {"mesid": 5, "reason": "nothing speakable"}]})
    row = [r for r in clip_sources.list_items(out, None) if r["kind"] == "scene"][0]
    assert row["n_skipped"] == 2


def test_a_LOCKED_vault_is_not_swallowed_into_an_empty_list(tmp_path, monkeypatch):
    """🔴 `list_items` catches `Exception` so one broken store is not an outage — but
    `VaultAuthError` is a BaseException ON PURPOSE (5.0 M1 §1) and must sail straight past it.

    A locked vault has to reach the app's lock boundary and answer "log in to unlock". Swallowed
    here it would render as "No clips yet" — a tab reporting DATA LOSS when the data is merely
    locked. Widening the catch to BaseException would cause exactly that, which is why this test
    exists rather than a comment alone.
    """
    from vault import VaultAuthError
    out = tmp_path / "output"
    _scene(out)

    def locked(_root):
        raise VaultAuthError("wrong key")
    monkeypatch.setattr(playground_clips, "list_clips", locked)
    with pytest.raises(VaultAuthError):
        clip_sources.list_items(out, None)


# ── m4i / §9a.3: whose voice is this? ────────────────────────────────────────────────────

def _multi_scene(output_dir: Path, stem="Tavern_beef0001", speakers=('Test Character 1', 'Test Character 2')):
    """A scene with more than one speaker, and one entry that has no character at all."""
    root = scenes.scenes_root(output_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{stem}.mp3").write_bytes(b"ID3 scene audio")
    entries = [{"mesid": i, "character": c, "cache_key": f"k{i}", "offset_s": float(i),
                "duration_s": 1.0, "text": "line"} for i, c in enumerate(speakers)]
    # A narration line with no speaker — the shape every pre-m4i entry has.
    entries.append({"mesid": 99, "character": "", "cache_key": "k99", "offset_s": 9.0,
                    "duration_s": 1.0, "text": "the door opens"})
    # And the same speaker again, to prove the list is DISTINCT rather than one per entry.
    entries.append({"mesid": 100, "character": speakers[0], "cache_key": "k100",
                    "offset_s": 10.0, "duration_s": 1.0, "text": "again"})
    scenes.write_manifest(root / f"{stem}.yaml", {
        "title": "The tavern", "owner": "st:Test User", "created": scenes.now(), "gap_s": 0.7,
        "enhanced": False, "total_duration_s": 12.5, "entries": entries,
    })
    return stem


def test_a_scene_row_says_who_speaks_in_it(tmp_path):
    """🔴 §9a.3 opens by saying this "starts at the EXTENSION… the character who spoke it is not
    sent, so there is nothing in the store to render or filter on." It was already there:
    `scene_build.py` has written `character` onto every entry since the first scene. Nothing was
    missing except a way to see it."""
    out = tmp_path / "output"
    _multi_scene(out)
    row = clip_sources.list_items(out, None)[0]
    assert row["characters"] == ['Test Character 1', 'Test Character 2']


def test_the_speaker_list_is_distinct_and_in_first_appearance_order(tmp_path):
    """📌 First-appearance rather than sorted: for a two-hander that is who opened the scene,
    which is more useful in a row than alphabetical. And distinct, or a fifty-message scene
    would carry fifty names into a listing that draws one."""
    out = tmp_path / "output"
    _multi_scene(out, speakers=('Test Character 3', 'Test Character 4'))
    assert clip_sources.list_items(out, None)[0]["characters"] == ['Test Character 3', 'Test Character 4']


def test_a_blank_character_is_DROPPED_rather_than_listed_as_an_empty_name(tmp_path):
    """⚠️ The row has to say *unknown* for a scene with no speakers, and it can only do that if
    it can tell "no names" from "a name that is the empty string". A blank in the list would put
    a faceless circle with no label beside the real ones."""
    out = tmp_path / "output"
    _multi_scene(out)
    assert "" not in clip_sources.list_items(out, None)[0]["characters"]


def test_a_scene_with_no_speakers_at_all_is_an_EMPTY_LIST_not_a_missing_key(tmp_path):
    """Every scene built before this was stored has one, and the filter must be able to OFFER
    them ("no character") rather than hide them. One row shape, always present."""
    out = tmp_path / "output"
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    (root / "Old_cafe0001.mp3").write_bytes(b"ID3")
    scenes.write_manifest(root / "Old_cafe0001.yaml", {
        "title": "Before m4i", "owner": "st:Test User", "created": scenes.now(),
        "entries": [{"mesid": 1, "cache_key": "k", "offset_s": 0.0, "duration_s": 1.0}],
    })
    row = clip_sources.list_items(out, None)[0]
    assert row["characters"] == []


def test_every_kind_carries_the_field_so_the_table_has_ONE_shape(tmp_path):
    """Playground clips are voice auditions, not character speech, and uploads have no recorded
    speaker. Both still carry the field so the table can use one row shape."""
    out = tmp_path / "output"
    _scene(out)
    _pg_clip(out)
    rows = {r["kind"]: r for r in clip_sources.list_items(out, _upload(tmp_path))}
    assert set(rows) == {"scene", "playground", "upload"}
    for kind in ("playground", "upload"):
        assert rows[kind]["characters"] == [], kind
        assert rows[kind]["character_avatars"] == [], kind
    assert rows["scene"]["characters"] == ['Test Character 1']


def test_the_avatar_list_lines_up_with_the_names_and_is_blank_where_unrecorded(tmp_path):
    """11.2.5 — the Clips row finds the face by SillyTavern's avatar filename, so the row must
    carry it aligned with `characters`. A scene built before it was stored carries `""`, and the
    row falls back to the name."""
    out = tmp_path / "output"
    _multi_scene(out)
    row = clip_sources.list_items(out, None)[0]
    assert row["character_avatars"] == ["", ""]
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    (root / "New_cafe0002.mp3").write_bytes(b"ID3")
    scenes.write_manifest(root / "New_cafe0002.yaml", {
        "title": "After", "owner": 'st:Test User', "created": scenes.now(),
        "entries": [
            {"mesid": 1, "character": 'Test Character 3', "character_avatar": "", "cache_key": "a"},
            {"mesid": 2, "character": 'Test Character 4', "cache_key": "b"},
            {"mesid": 3, "character": 'Test Character 3', "character_avatar": 'test-character-3.png',
             "cache_key": "c"},
        ],
    })
    rows = {r["name"]: r for r in clip_sources.list_items(out, None)}
    assert rows["After"]["characters"] == ['Test Character 3', 'Test Character 4']
    # The first NON-EMPTY avatar wins, so a message without one cannot blank out a later one.
    assert rows["After"]["character_avatars"] == ['test-character-3.png', ""]


def test_the_transcript_still_does_not_ride_along(tmp_path):
    """🔴 §5.1, and the reason `_speakers` returns NAMES rather than the entries it read them
    from. The listing is the call the tab makes most often; shipping the conversation to draw a
    row is exactly what `list_scenes` refuses to do."""
    out = tmp_path / "output"
    _multi_scene(out)
    row = clip_sources.list_items(out, None)[0]
    assert "entries" not in row
    assert "the door opens" not in str(row)

"""8.0-m3 — the song-template store, and the one distinction that must not collapse.

🔴 A MISSING FILE AND AN UNREADABLE ONE ARE NOT THE SAME ANSWER. Absent means "no templates yet"
and is a fact. Corrupt raises, and a LOCKED VAULT raises — because "the vault is shut" answered
as "you have no songs" is a data-loss report waiting to happen, and worse, the next save would
write an empty list on top of the real one.

That is also why the store has no in-memory cache: every mutation reads the whole file and writes
it straight back, so a locked vault fails on the READ, before anything is written.

The other half is the field split (§4.5.2). A template holds what makes a song *that song* —
lyrics, caption, bpm, key, time signature, language, duration, instrumental. It does NOT hold
render settings, and it does NOT hold the seed: two cards handed the same seed render the
identical song twice, which is the one thing a two-card setup must never do.
"""
import json

import pytest

import vocalis.runtime.acetemplates as rt_tpl
import vocalis.runtime.paths as rt_paths


@pytest.fixture(autouse=True)
def store(monkeypatch, tmp_path):
    """Never the developer's real song library — it holds lyrics and nothing prunes it."""
    p = tmp_path / "ace_templates.json"
    monkeypatch.setattr(rt_paths, "ACE_TEMPLATES", p)
    return p


def _save(**kw):
    fields = {"name": "Untitled", "caption": "alternative metal, hard rock",
              "lyrics": "[verse]\nsomething", "bpm": 85}
    fields.update(kw)
    return rt_tpl.save(fields)


def test_an_absent_library_is_no_templates_not_an_error(store):
    assert not store.exists()
    assert rt_tpl.list_templates() == []


def test_a_saved_template_round_trips_every_field_that_makes_the_song(store):
    t = _save(name='Sample Track', key_scale="E minor", time_signature="4", duration=210.0,
              vocal_language="en", global_caption="a full-band arrangement")
    again = rt_tpl.list_templates()
    assert [x.id for x in again] == [t.id]
    got = again[0]
    assert (got.name, got.caption, got.bpm, got.key_scale, got.time_signature) == (
        'Sample Track', "alternative metal, hard rock", 85, "E minor", "4")
    assert got.duration == 210.0 and got.vocal_language == "en"
    assert got.global_caption == "a full-band arrangement"
    assert got.lyrics.startswith("[verse]")


def test_the_stored_shape_carries_no_seed_and_no_render_settings(store):
    """🔴 THE FIELD SPLIT, AS AN ASSERTION. A seed on a template means two cards render the
    identical song; steps/guidance/DCW on a template means the same song cannot be drafted on
    turbo and rendered on xl-sft, which is the entire point of two cards."""
    _save()
    raw = json.loads(store.read_text(encoding="utf-8"))["templates"][0]
    for banned in ("seed", "use_random_seed", "inference_steps", "guidance_scale", "shift",
                   "dcw_enabled", "sampler_mode", "model"):
        assert banned not in raw, f"a template stored {banned!r} — see §4.5.2"


def test_updating_keeps_the_id_and_the_creation_time(store):
    t = _save(name="First")
    again = rt_tpl.save({"name": "Renamed"}, template_id=t.id)
    assert again.id == t.id and again.created_at == t.created_at
    assert again.updated_at >= t.updated_at
    assert len(rt_tpl.list_templates()) == 1, "an update created a second row"


def test_updating_leaves_untouched_fields_alone(store):
    """A rename must not blank the lyrics — the save sends the changed fields, not the world."""
    t = _save(name="Keeps", lyrics="[chorus]\nkeep me")
    rt_tpl.save({"name": "Renamed"}, template_id=t.id)
    assert rt_tpl.list_templates()[0].lyrics == "[chorus]\nkeep me"


def test_a_stale_id_creates_rather_than_raising(store):
    """⚠️ A page open while the store was edited elsewhere holds an id that no longer exists.
    That should cost a new row, not an error dialog over lyrics just typed."""
    rt_tpl.save({"name": "New one"}, template_id="not-a-real-id")
    assert [t.name for t in rt_tpl.list_templates()] == ["New one"]


def test_delete_and_favorite(store):
    a, b = _save(name="A"), _save(name="B")
    assert rt_tpl.set_favorite(b.id, True) is True
    assert [t.favorite for t in rt_tpl.list_templates()] == [False, True]
    assert rt_tpl.delete(a.id) is True
    assert rt_tpl.delete(a.id) is False, "deleting twice reported success"
    assert [t.id for t in rt_tpl.list_templates()] == [b.id]


def test_note_use_is_silent_about_a_deleted_template(store):
    """Called on the way into a render. A template deleted in another tab must not fail the song
    that is already being submitted."""
    rt_tpl.note_use("gone")                       # must not raise
    t = _save()
    rt_tpl.note_use(t.id)
    assert rt_tpl.list_templates()[0].used == 1


def test_a_corrupt_library_raises_rather_than_reporting_none(store):
    """🔴 THE DISTINCTION THIS FILE IS ABOUT. Reporting `[]` here is what makes the NEXT save
    write an empty list over the real one — the picker would look merely empty, and the library
    would be gone."""
    store.write_text("this is not json", encoding="utf-8")
    with pytest.raises(rt_tpl.TemplateStoreCorrupt):
        rt_tpl.list_templates()


def test_a_json_file_that_is_not_a_library_also_raises(store):
    store.write_text(json.dumps({"something": "else"}), encoding="utf-8")
    with pytest.raises(rt_tpl.TemplateStoreCorrupt):
        rt_tpl.list_templates()


def test_one_bad_row_does_not_take_the_whole_picker_down(store):
    """A malformed numeric field should affect only that field, not remove the template from the picker. Preserve the row's lyrics."""
    store.write_text(json.dumps({"templates": [
        {"id": "x", "name": "Hand edited", "bpm": "eighty-five", "duration": "long",
         "lyrics": "[verse]\nstill here"}]}), encoding="utf-8")
    got = rt_tpl.list_templates()
    assert len(got) == 1 and got[0].bpm is None and got[0].duration is None
    assert got[0].lyrics == "[verse]\nstill here"


def test_rows_without_an_id_are_skipped_not_guessed_at(store):
    store.write_text(json.dumps({"templates": [{"name": "no id"}, {"id": "y", "name": "ok"}]}),
                     encoding="utf-8")
    assert [t.name for t in rt_tpl.list_templates()] == ["ok"]


def test_the_library_is_bounded(store, monkeypatch):
    monkeypatch.setattr(rt_tpl, "MAX_TEMPLATES", 2)
    _save(name="1"), _save(name="2")
    with pytest.raises(ValueError):
        _save(name="3")


def test_oversized_text_is_clamped_rather_than_rejected(store):
    """A guard on a store read whole on every mutation, not a policy about how long a song is —
    so it truncates rather than refusing the save and losing what was typed."""
    t = _save(name="x" * 500, lyrics="y" * (rt_tpl.MAX_LYRICS + 100))
    assert len(t.name) == rt_tpl.MAX_NAME
    assert len(t.lyrics) == rt_tpl.MAX_LYRICS


def test_the_store_is_registered_for_encryption():
    """🔴 LYRICS IN THE CLEAR INSIDE AN ENCRYPTED INSTALL IS THE EXACT FAILURE 5.0 EXISTS TO
    PREVENT, and the recorded way it happens is a store added to one list and not the other.
    `vault.py`'s own comment says so: "a human keeps having to remember two lists at once"."""
    import vault
    import vault_store
    assert "ace_templates.json" in vault_store.ROUTES["install"]["files"], "not routed"
    assert "ace_templates.json" in vault.STRUCTURAL, "not structural"

"""Favorite state for Clips rows and filters.

Favorite references use `<slug>_<h8>`, with the slug derived from the scene title. The encrypted
store must route writes so titles are not exposed in plaintext. A deleted clip may leave a stale
favorite key; `for_rows` is the only reader and ignores keys without a current row, avoiding a
multi-store cascade that could miss one of the related files.
"""
import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import clip_favorites                                  # noqa: E402
import scenes                                           # noqa: E402
from vocalis.web.clips import create_clips_blueprint    # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    import book_to_audio
    import vocalis.web.clips as clips_mod
    from vocalis.runtime import paths
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(paths, "CLIP_FAVORITES", tmp_path / "clip_favorites.yaml")
    app = Flask(__name__)
    app.register_blueprint(create_clips_blueprint())
    return app.test_client()


@pytest.fixture
def root(tmp_path):
    r = scenes.scenes_root(tmp_path / "output")
    r.mkdir(parents=True, exist_ok=True)
    return r


def _mk(root: Path, stem: str, meta=None):
    (root / f"{stem}.mp3").write_bytes(b"ID3 fake audio")
    scenes.write_manifest(root / f"{stem}.yaml", meta or {"title": "A scene", "entries": []})
    return stem


# ── the store ────────────────────────────────────────────────────────────────────────────

def test_nothing_is_favorited_before_anything_is_starred(tmp_path):
    assert clip_favorites.load(tmp_path) == set()


def test_a_toggle_is_a_toggle(tmp_path):
    assert clip_favorites.toggle(tmp_path, "scene", "ferry_ab12cd34") is True
    assert clip_favorites.load(tmp_path) == {"scene|ferry_ab12cd34"}
    assert clip_favorites.toggle(tmp_path, "scene", "ferry_ab12cd34") is False
    assert clip_favorites.load(tmp_path) == set()


def test_the_key_carries_the_kind_because_two_stores_can_share_a_ref(tmp_path):
    """🔴 `scKey` in the UI is `kind|ref` for exactly this reason, and the server has to agree.
    A Playground clip and a scene can be named the same thing; keying on the ref alone would
    star both, in two different tabs, from one click."""
    clip_favorites.toggle(tmp_path, "scene", "same_name_ab12cd34")
    favs = clip_favorites.load(tmp_path)
    assert "scene|same_name_ab12cd34" in favs
    assert "playground|same_name_ab12cd34" not in favs


def test_a_corrupt_file_means_nothing_is_starred_rather_than_a_broken_tab(tmp_path):
    """A convenience store degrades; it does not take the page down. (`VaultAuthError` is a
    BaseException and is deliberately NOT caught — a wrong key is not a corrupt file.)"""
    (tmp_path / "clip_favorites.yaml").write_text("{not: a list", encoding="utf-8")
    assert clip_favorites.load(tmp_path) == set()


def test_a_stale_key_does_not_resurrect_a_deleted_row(tmp_path):
    """Deleting a clip does not reach into this file, on purpose. `for_rows` is the only reader
    and it only ever stamps rows it was given."""
    clip_favorites.toggle(tmp_path, "scene", "deleted_ab12cd34")
    rows = [{"kind": "scene", "ref": "still_here_ff00ff00"}]
    out = clip_favorites.for_rows(tmp_path, rows)
    assert out == [{"kind": "scene", "ref": "still_here_ff00ff00", "favorite": False}]


# ── 🔴 a rename MOVES a scene's ref, and the star has to follow it ───────────────────────
#
# `scenes.scene_stem()` is `safe_name(title) + '_' + h[:8]`, so the slug IS the display name and
# `rename_scene` hands back a new ref for the same audio. This store keys on the whole ref, so a
# rename that did not carry the entry across left it naming a row that no longer existed — and
# `for_rows` then dropped it in silence on the next listing. The test above says a stale key is
# deliberate for a DELETED row; these say a RENAMED row is the opposite case.

def test_rekey_carries_a_star_across_a_rename(tmp_path):
    clip_favorites.toggle(tmp_path, "scene", "ferry_ab12cd34")
    assert clip_favorites.rekey(tmp_path, "scene", "ferry_ab12cd34", "barge_ab12cd34") is True
    assert clip_favorites.load(tmp_path) == {"scene|barge_ab12cd34"}


def test_rekey_never_manufactures_a_favorite(tmp_path):
    """An UNSTARRED row that gets renamed must not come back starred."""
    assert clip_favorites.rekey(tmp_path, "scene", "ferry_ab12cd34", "barge_ab12cd34") is False
    assert clip_favorites.load(tmp_path) == set()


def test_rekey_is_a_no_op_when_the_ref_did_not_move(tmp_path):
    """`rename_scene` returns the SAME ref for a no-op rename, and this must not disturb it."""
    clip_favorites.toggle(tmp_path, "scene", "ferry_ab12cd34")
    assert clip_favorites.rekey(tmp_path, "scene", "ferry_ab12cd34", "ferry_ab12cd34") is False
    assert clip_favorites.load(tmp_path) == {"scene|ferry_ab12cd34"}


def test_rekey_leaves_every_other_row_alone(tmp_path):
    """It is a whole-file read-modify-write, so the blast radius of getting this wrong is
    everyone else's stars — the same reason `_record` in stems.py refuses to write a store it
    could not first read."""
    clip_favorites.toggle(tmp_path, "scene", "ferry_ab12cd34")
    clip_favorites.toggle(tmp_path, "playground", "v1/other")
    clip_favorites.rekey(tmp_path, "scene", "ferry_ab12cd34", "barge_ab12cd34")
    assert clip_favorites.load(tmp_path) == {"scene|barge_ab12cd34", "playground|v1/other"}


def test_renaming_a_scene_through_the_route_keeps_its_star(client, root, tmp_path):
    """🔴 THE REGRESSION, end to end. Shipped broken since 6.2: `/clips/scenes/<ref>/rename` called
    `rename_scene` and never touched this store, so starring a scene and then renaming it dropped
    the star with no error — the only tell being that it was there a moment ago."""
    _mk(root, "ferry_ab12cd34")
    assert client.post("/clips/favorite",
                       json={"kind": "scene", "ref": "ferry_ab12cd34"}).get_json()["favorite"]
    r = client.post("/clips/scenes/ferry_ab12cd34/rename", json={"name": "Barge"})
    new_ref = r.get_json()["ref"]
    assert new_ref == "Barge_ab12cd34"          # the premise: the ref really did move
    assert clip_favorites.load(tmp_path) == {f"scene|{new_ref}"}


def test_the_enhanced_marker_survives_the_rename_of_a_starred_scene(client, root, tmp_path):
    """The raw and enhanced takes of one build share an H8 and differ ONLY by the marker, so a
    carry-across that dropped it would land the star on the other row."""
    _mk(root, "ferry_enhanced_ab12cd34", {"title": "The ferry", "enhanced": True})
    client.post("/clips/favorite", json={"kind": "scene", "ref": "ferry_enhanced_ab12cd34"})
    new_ref = client.post("/clips/scenes/ferry_enhanced_ab12cd34/rename",
                          json={"name": "Barge"}).get_json()["ref"]
    assert new_ref == "Barge_enhanced_ab12cd34"
    assert clip_favorites.load(tmp_path) == {"scene|Barge_enhanced_ab12cd34"}


def test_the_list_is_capped(tmp_path):
    clip_favorites.save(tmp_path, {f"scene|s{i}" for i in range(clip_favorites.MAX_FAVORITES)})
    with pytest.raises(ValueError):
        clip_favorites.toggle(tmp_path, "scene", "one_too_many")


# ── 🔴 the file is in the vault ──────────────────────────────────────────────────────────

def test_the_favorites_file_is_a_ROUTED_install_file():
    """The reference carries the scene title, so the favorites file must be routed through the encrypted
install store. Assert against the route table used by `vault_fs`; an omitted write route would
silently expose the title list."""
    import vault_store
    assert "clip_favorites.yaml" in vault_store.ROUTES["install"]["files"]


def test_the_writer_goes_through_vault_fs(monkeypatch, tmp_path):
    """The census would catch a raw `open()` eventually; this catches it here, and says why."""
    import vault_fs
    seen = {}
    monkeypatch.setattr(vault_fs, "write_yaml_atomic",
                        lambda p, data, **kw: seen.update({"path": p, "data": data}))
    clip_favorites.save(tmp_path, {"scene|ferry_ab12cd34"})
    assert seen["path"].name == "clip_favorites.yaml"
    assert seen["data"] == ["scene|ferry_ab12cd34"]


# ── the route ────────────────────────────────────────────────────────────────────────────

def test_the_listing_stamps_the_star_on_every_row(client, root, tmp_path):
    _mk(root, "ferry_ab12cd34")
    _mk(root, "other_ff00ff00")
    rows = {r["ref"]: r for r in client.get("/clips/items").get_json()}
    assert all(r["favorite"] is False for r in rows.values())

    r = client.post("/clips/favorite", json={"kind": "scene", "ref": "ferry_ab12cd34"})
    assert r.status_code == 200 and r.get_json()["favorite"] is True

    rows = {r["ref"]: r for r in client.get("/clips/items").get_json()}
    assert rows["ferry_ab12cd34"]["favorite"] is True
    assert rows["other_ff00ff00"]["favorite"] is False

    assert client.post("/clips/favorite",
                       json={"kind": "scene", "ref": "ferry_ab12cd34"}).get_json()["favorite"] is False
    rows = {r["ref"]: r for r in client.get("/clips/items").get_json()}
    assert rows["ferry_ab12cd34"]["favorite"] is False


def test_an_unknown_kind_is_refused(client):
    """The kind is half the key, so a typo would star a row nothing can ever un-star."""
    assert client.post("/clips/favorite",
                       json={"kind": "nonsense", "ref": "x"}).status_code == 400
    assert client.post("/clips/favorite", json={"kind": "scene", "ref": ""}).status_code == 400


def test_a_star_survives_a_restart(client, root, tmp_path):
    """It is the whole point of putting it on the server rather than in localStorage — where
    `UIS` would sweep it on the next boot anyway (6.2-m1)."""
    _mk(root, "ferry_ab12cd34")
    client.post("/clips/favorite", json={"kind": "scene", "ref": "ferry_ab12cd34"})
    assert clip_favorites.load(tmp_path) == {"scene|ferry_ab12cd34"}
    # A fresh process reads the file, not a cache.
    rows = {r["ref"]: r for r in client.get("/clips/items").get_json()}
    assert rows["ferry_ab12cd34"]["favorite"] is True
# ── 🔴 8.8.6: a rename moves the ref for ALL THREE kinds, not just scenes ────────────────

def test_rekey_moves_a_playground_star_and_an_upload_star_too(tmp_path):
    """🔴 THE STORE ALWAYS COULD; THE ROUTES DID NOT CALL IT.

    `rekey` is kind-agnostic and works for every kind — this pins that, so the wiring test below
    is the only thing that can fail if a rename route drops the call. What was wrong for two years
    was `rekey`'s own docstring, which certified playground and upload refs as stable. They are
    not: `playground_clips.rename_clip` rebuilds the stem from `safe_name(name)` and returns a new
    `vdir/stem`, and an upload's ref IS its filename, which `rename_source` renames.
    """
    clip_favorites.save(tmp_path, {"playground|amy/hello_ab12cd34",
                                    "upload|old_take.wav",
                                    "scene|ferry_ab12cd34"})
    assert clip_favorites.rekey(tmp_path, "playground",
                                 "amy/hello_ab12cd34", "amy/goodbye_ab12cd34") is True
    assert clip_favorites.rekey(tmp_path, "upload", "old_take.wav", "new_take.wav") is True
    assert clip_favorites.load(tmp_path) == {"playground|amy/goodbye_ab12cd34",
                                              "upload|new_take.wav",
                                              "scene|ferry_ab12cd34"}


def test_rekey_never_manufactures_a_star_for_an_unstarred_row(tmp_path):
    """Renaming something that was never starred must not star it — the routes now call this
    unconditionally on every rename, so this is the property that makes that safe."""
    clip_favorites.save(tmp_path, {"scene|ferry_ab12cd34"})
    assert clip_favorites.rekey(tmp_path, "upload", "never_starred.wav", "x.wav") is False
    assert clip_favorites.rekey(tmp_path, "playground", "amy/a_11111111",
                                 "amy/b_11111111") is False
    assert clip_favorites.load(tmp_path) == {"scene|ferry_ab12cd34"}


def test_every_rename_route_carries_the_star_across(tmp_path):
    """🔴 THE SCENE HALF WAS FIXED IN 8.8.3 AND THE OTHER TWO WERE LEFT BROKEN.

    All three kinds are starrable — `/clips/favorite` accepts every member of
    `clip_sources.KINDS` — and all three refs MOVE on a rename. Miss the `rekey` and the entry is
    left naming a row that no longer exists; `for_rows` drops it on the next listing with no error
    at all. The only tell is that the star was there a moment ago.

    ⚠️ THE WINDOW IS BOUNDED AT THE NEXT ROUTE, AND THAT IS THE POINT. The sibling guard in
    `test_voicetrain.py` sliced a window spanning three branches and so matched a `build_index_cmd`
    on an unreachable path, passing green for two releases over a behavior that never happened.
    A window that runs past the thing it is about proves nothing, so this one asserts it found the
    next route before it trusts what it read.
    """
    web = Path(__file__).parent.parent / "src" / "vocalis" / "web"
    for fname, route, kind in (
        ("clips.py", '"/clips/scenes/<ref>/rename"', "clip_sources.SCENE"),
        ("playground.py", '"/playground/clips/<path:ref>/rename"', "clip_sources.PLAYGROUND"),
        ("train.py", '"/train/sources/rename"', "clip_sources.UPLOAD"),
    ):
        src = (web / fname).read_text(encoding="utf-8")
        assert route in src, f"{fname} no longer has the rename route this test is about"
        body = src[src.index(route):]
        nxt = body.find("@bp.route", 10)
        assert nxt > 0, (
            f"{fname}: the window must END at the next route — an unbounded one would match a "
            f"rekey belonging to some other handler and prove nothing")
        body = body[:nxt]
        # Commentary out, for the same reason as the sibling guard in test_voicetrain.py: these
        # three routes each carry a comment explaining WHY the rekey is there, and a comment that
        # names the call satisfies an assertion the call itself no longer does.
        body = "\n".join(ln for ln in body.splitlines() if not ln.lstrip().startswith("#"))
        assert "clip_favorites.rekey(" in body, (
            f"{fname}'s rename route does not carry the star across: the rename moves the ref and "
            f"the favorite is silently dropped on the next listing")
        assert kind in body, f"{fname} rekeys some other kind than {kind}"

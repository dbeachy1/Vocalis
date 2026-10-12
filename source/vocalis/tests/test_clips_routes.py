"""The Clips tab's routes (6.0 §7) — list, play, chapter list, rename, delete, zip.

m1 is scenes only (§10). The tab exists from the first commit rather than being a Scenes
sub-tab under SillyTavern that m2 replaces, because that would be the same list built twice with
one of them thrown away.
"""
import io
import sys
import zipfile
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import scenes                                              # noqa: E402
from vocalis.web.clips import create_clips_blueprint       # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    import book_to_audio
    import vocalis.web.clips as clips_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", tmp_path / "output")
    app = Flask(__name__)
    app.register_blueprint(create_clips_blueprint())
    return app.test_client()


@pytest.fixture
def root(tmp_path):
    r = scenes.scenes_root(tmp_path / "output")
    r.mkdir(parents=True, exist_ok=True)
    return r


def _mk(root: Path, stem: str, meta=None, audio=b"ID3 fake audio"):
    (root / f"{stem}.mp3").write_bytes(audio)
    scenes.write_manifest(root / f"{stem}.yaml", meta or {"title": "A scene", "entries": []})
    return stem


ENTRIES = [{"mesid": 400, "character": 'Test Character 1', "cache_key": "k0", "offset_s": 0.0,
            "duration_s": 2.0, "text": "the unmistakable secret words"},
           {"mesid": 401, "character": 'Test Character 1', "cache_key": "k1", "offset_s": 2.7,
            "duration_s": 3.0, "text": "and the reply"}]


# ── list ─────────────────────────────────────────────────────────────────────────────────

def test_the_list_is_empty_before_any_scene_exists(client):
    assert client.get("/clips/scenes").get_json() == []


def test_the_list_does_not_ship_the_transcript(client, root):
    """⚠️ §5.1. This route is called on every open of the tab. `entries` carries `text` per
    message — the conversation — and the chapter list is fetched one scene at a time instead."""
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    body = client.get("/clips/scenes").get_json()
    assert len(body) == 1 and body[0]["ref"] == "ferry_ab12cd34"
    assert "entries" not in body[0]
    assert "unmistakable" not in repr(body)


def test_the_list_carries_what_the_enhanced_filter_needs(client, root):
    """§7.1 — a three-state filter (all · enhanced · not enhanced) is the whole cleanup
    workflow, and it reads exactly one field per row."""
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    _mk(root, "ferry_enhanced_ff00ff00", {"title": "The ferry", "entries": ENTRIES,
                                          "enhanced": True, "raw_ref": "ferry_ab12cd34"})
    rows = {r["ref"]: r for r in client.get("/clips/scenes").get_json()}
    assert rows["ferry_ab12cd34"]["enhanced"] is False
    assert rows["ferry_enhanced_ff00ff00"]["enhanced"] is True
    assert rows["ferry_enhanced_ff00ff00"]["raw_ref"] == "ferry_ab12cd34"


# ── the chapter list ─────────────────────────────────────────────────────────────────────

def test_the_manifest_route_is_the_chapter_list(client, root):
    """§5: click a line, jump to that message inside the audio. This is the one route that
    ships conversation text, deliberately and on demand — which is why the list route does not."""
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES,
                                 "total_duration_s": 5.7})
    body = client.get("/clips/scenes/ferry_ab12cd34/manifest").get_json()
    assert body["title"] == "The ferry"
    assert [e["offset_s"] for e in body["entries"]] == [0.0, 2.7]
    assert body["entries"][0]["text"] == "the unmistakable secret words"
    assert body["total_duration_s"] == 5.7


def test_the_manifest_of_a_missing_scene_is_a_404(client, root):
    assert client.get("/clips/scenes/nope_ab12cd34/manifest").status_code == 404


def test_a_scene_whose_manifest_is_corrupt_still_answers(client, root):
    """The scene is the MP3; the manifest is what we know about it. Losing the metadata must
    not 500 the tab."""
    (root / "ferry_ab12cd34.mp3").write_bytes(b"ID3 fake audio")
    (root / "ferry_ab12cd34.yaml").write_text("{{{ not yaml", encoding="utf-8")
    body = client.get("/clips/scenes/ferry_ab12cd34/manifest").get_json()
    assert body["entries"] == [] and body["ref"] == "ferry_ab12cd34"


# ── audio ────────────────────────────────────────────────────────────────────────────────

def test_a_scene_plays_and_downloads(client, root):
    _mk(root, "ferry_ab12cd34", audio=b"ID3 pretend this is an hour of audio")
    r = client.get("/clips/scenes/ferry_ab12cd34/audio")
    assert r.status_code == 200 and r.data.startswith(b"ID3")
    d = client.get("/clips/scenes/ferry_ab12cd34/audio?download=1")
    assert "attachment" in d.headers["Content-Disposition"]
    assert "ferry_ab12cd34.mp3" in d.headers["Content-Disposition"]


@pytest.mark.parametrize("ref", ["nope_ab12cd34", "..%2fescape", "a%2fb"])
def test_audio_404s_for_a_missing_or_traversing_ref(client, root, ref):
    assert client.get(f"/clips/scenes/{ref}/audio").status_code == 404


# ── rename ───────────────────────────────────────────────────────────────────────────────

def test_rename_moves_both_files_and_keeps_the_identity(client, root):
    _mk(root, "ferry_enhanced_ab12cd34", {"title": "The ferry", "enhanced": True})
    r = client.post("/clips/scenes/ferry_enhanced_ab12cd34/rename",
                    json={"name": "Crossing to Ullapool"})
    assert r.status_code == 200
    new = r.get_json()["ref"]
    assert new == "Crossing_to_Ullapool_enhanced_ab12cd34"
    assert (root / f"{new}.mp3").is_file() and (root / f"{new}.yaml").is_file()


def test_rename_to_an_unusable_name_is_a_400(client, root):
    _mk(root, "ferry_ab12cd34")
    r = client.post("/clips/scenes/ferry_ab12cd34/rename", json={"name": "!!!"})
    assert r.status_code == 400


def test_rename_of_a_missing_scene_is_a_404(client, root):
    assert client.post("/clips/scenes/nope_ab12cd34/rename",
                       json={"name": "x"}).status_code == 404


# ── delete ───────────────────────────────────────────────────────────────────────────────

def test_delete_takes_a_selection_and_reports_what_went(client, root):
    _mk(root, "a_ab12cd34")
    _mk(root, "b_ff00ff00")
    r = client.delete("/clips/scenes", json={"scenes": ["a_ab12cd34", "gone_00000000"]})
    assert r.get_json()["deleted"] == ["a_ab12cd34"]
    assert not (root / "a_ab12cd34.mp3").exists()
    assert (root / "b_ff00ff00.mp3").is_file()


def test_deleting_the_raw_take_leaves_the_enhanced_one(client, root):
    """⚠️ §7.1's cleanup workflow is "filter to not enhanced, select all, delete". A cascade
    would take the enhanced ones with them — the opposite of what the filter is for."""
    _mk(root, "ferry_ab12cd34")
    _mk(root, "ferry_enhanced_ff00ff00", {"raw_ref": "ferry_ab12cd34", "enhanced": True})
    client.delete("/clips/scenes", json={"scenes": ["ferry_ab12cd34"]})
    assert (root / "ferry_enhanced_ff00ff00.mp3").is_file()


# ── ⬇ Download selected ──────────────────────────────────────────────────────────────────

def test_the_zip_holds_the_selection(client, root):
    _mk(root, "a_ab12cd34", audio=b"ID3 aaaa")
    _mk(root, "b_ff00ff00", audio=b"ID3 bbbb")
    r = client.post("/clips/scenes/zip", json={"scenes": ["a_ab12cd34", "b_ff00ff00"]})
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.data))
    assert sorted(z.namelist()) == ["a_ab12cd34.mp3", "b_ff00ff00.mp3"]
    assert z.read("a_ab12cd34.mp3") == b"ID3 aaaa"
    for info in z.infolist():
        assert info.compress_type == zipfile.ZIP_STORED, (
            "MP3 data is already compressed and should be stored without recompression")


def test_the_zip_accepts_the_form_post_the_page_makes(client, root):
    """A form submit is a NATIVE browser download: the bytes go to disk without the tab holding
    the archive. A selection of scenes is measured in hours."""
    _mk(root, "a_ab12cd34")
    r = client.post("/clips/scenes/zip", data={"scenes": ["a_ab12cd34"]})
    assert r.status_code == 200
    assert "vocalis-scene.zip" in r.headers["Content-Disposition"]


def test_a_ref_that_vanished_is_skipped_not_fatal(client, root):
    """Same rule as delete: "selected" must mean the same set to both buttons, and a scene
    deleted between the page rendering and the click must not fail the download."""
    _mk(root, "a_ab12cd34")
    r = client.post("/clips/scenes/zip", json={"scenes": ["a_ab12cd34", "gone_00000000"]})
    assert r.status_code == 200
    assert zipfile.ZipFile(io.BytesIO(r.data)).namelist() == ["a_ab12cd34.mp3"]


def test_a_zip_of_nothing_is_refused_rather_than_empty(client, root):
    """An empty archive is a lie, not a degradation."""
    assert client.post("/clips/scenes/zip", json={"scenes": []}).status_code == 400
    assert client.post("/clips/scenes/zip", json={"scenes": ["gone_00000000"]}).status_code == 404


# ══ 6.0-m2 §7 — the rest of the tab: the unified list, and Join ═════════════════════════

class _VtCfg:
    def __init__(self, d):
        self.training_dir = str(d)


@pytest.fixture
def m2(tmp_path, monkeypatch):
    """The tab as m2 wires it: OUTPUT_DIR for scenes + playground, a vt_cfg CALLABLE for
    uploads. The callable is the point — settings change under a running server and the
    blueprint is built once (see `create_clips_blueprint`'s docstring)."""
    import book_to_audio
    import clip_join
    import vocalis.web.clips as clips_mod
    out = tmp_path / "output"
    up = tmp_path / "training"
    up.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", out)
    # A module-global job registry leaks the 409 between tests otherwise.
    monkeypatch.setattr(clip_join, "JOBS", {})
    app = Flask(__name__)
    app.register_blueprint(create_clips_blueprint(lambda: _VtCfg(up)))
    return app.test_client(), out, up


def _upload_file(up, name="a read.wav"):
    (up / name).write_bytes(b"RIFF....WAVEfmt ")
    return name


def test_the_items_route_lists_every_kind(m2):
    client, out, up = m2
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    _upload_file(up)
    rows = client.get("/clips/items").get_json()
    assert {r["kind"] for r in rows} == {"scene", "upload"}


def test_items_filters_by_kind(m2):
    client, out, up = m2
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    _upload_file(up)
    rows = client.get("/clips/items?kinds=upload").get_json()
    assert rows and {r["kind"] for r in rows} == {"upload"}


def test_items_does_not_ship_the_transcript(m2):
    """§5.1 again, on the route that runs on every open of the tab."""
    client, out, _up = m2
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    assert "unmistakable secret words" not in r_text(client.get("/clips/items"))


def r_text(resp):
    return resp.get_data(as_text=True)


def test_the_m1_scene_route_still_answers_its_own_shape(m2):
    """⚠️ /clips/items does NOT replace /clips/scenes. The m1 table renders scene-shaped
    fields the flattened catalog does not carry, and collapsing the two would cost them."""
    client, out, _up = m2
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "gap_s": 0.7, "entries": ENTRIES})
    row = client.get("/clips/scenes").get_json()[0]
    assert "gap_s" in row and "n_entries" in row


# ── Join: validation ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("body,why", [
    ({"title": "x"}, "no items"),
    ({"title": "x", "items": []}, "empty items"),
    ({"title": "x", "items": [{"ref": "a.wav"}]}, "no kind"),
    ({"title": "x", "items": [{"kind": "nonsense", "ref": "a.wav"}]}, "unknown kind"),
    ({"title": "x", "items": [{"kind": "upload", "ref": ""}]}, "no ref"),
    ({"title": "", "items": [{"kind": "upload", "ref": "a.wav"}]}, "no name"),
])
def test_join_refuses_a_malformed_request(m2, body, why):
    client, _out, _up = m2
    assert client.post("/clips/join", json=body).status_code == 400, why


def test_join_refuses_an_absurd_selection(m2):
    import clip_join
    client, _out, _up = m2
    items = [{"kind": "upload", "ref": f"{i}.wav"} for i in range(clip_join.MAX_JOIN_ITEMS + 1)]
    assert client.post("/clips/join", json={"title": "x", "items": items}).status_code == 400


def test_join_answers_202_with_a_job_and_then_a_status(m2):
    client, _out, up = m2
    _upload_file(up, "a.wav")
    r = client.post("/clips/join", json={"title": "Two takes",
                                         "items": [{"kind": "upload", "ref": "a.wav"}]})
    assert r.status_code == 202
    job_id = r.get_json()["job_id"]
    st = client.get(f"/clips/join/{job_id}")
    assert st.status_code == 200 and st.get_json()["job_id"] == job_id
    assert client.get("/clips/join/nosuchjob").status_code == 404


def test_only_one_join_at_a_time(m2, monkeypatch):
    """⚠️ Not a pool constraint like the render one — a user who double-clicks Join otherwise
    gets two identical scenes with different timestamps and no way to tell which to keep."""
    import clip_join
    client, _out, _up = m2
    stuck = clip_join.JoinJob(id="busy", title="already going")
    stuck.status = "assembling"
    monkeypatch.setitem(clip_join.JOBS, "busy", stuck)
    r = client.post("/clips/join", json={"title": "x",
                                         "items": [{"kind": "upload", "ref": "a.wav"}]})
    assert r.status_code == 409
    assert r.get_json()["error"]["job_id"] == "busy"


def test_a_join_can_be_canceled(m2, monkeypatch):
    import clip_join
    client, _out, _up = m2
    job = clip_join.JoinJob(id="j9", title="going")
    job.status = "assembling"
    monkeypatch.setitem(clip_join.JOBS, "j9", job)
    assert client.post("/clips/join/j9/cancel").status_code == 200
    assert job.cancel.is_set()
    assert client.post("/clips/join/nosuchjob/cancel").status_code == 404


# ── 6.1-m1a — the edit verb ──────────────────────────────────────────────────────────────
#
# The stitch itself is tested in test_scene_edit.py against real ffmpeg. These are the door:
# what the route refuses, and why, BEFORE a job exists. §7 — "a bad range fails at the door
# with a real error instead of inside a background thread nobody is watching."

def _edit(client, ref, **body):
    body.setdefault("title", "Edited")
    return client.post(f"/clips/scenes/{ref}/edit", json=body)


def test_editing_a_scene_that_is_not_there_is_a_404(client, root):
    assert _edit(client, "nope_00000000", ops=[]).status_code == 404


def test_an_enhanced_scene_is_refused_and_names_its_raw_twin(client, root):
    """🔴 §6 — edit the RAW scene. A Playground replacement has not been through the enhancer, so
    splicing it into a 256 kbps enhanced file drops an unenhanced line into the middle of an
    enhanced one: audible, and a profile mismatch besides. The UI steers him there; the server
    must not quietly do the wrong thing if anything else asks."""
    _mk(root, "ferry_enhanced_ff00ff00",
        {"title": "The ferry", "enhanced": True, "raw_ref": "ferry_ab12cd34",
         "entries": ENTRIES})
    r = _edit(client, "ferry_enhanced_ff00ff00",
              ops=[{"op": "replace", "index": 0, "kind": "playground", "ref": "v/a"}])
    assert r.status_code == 400
    err = r.get_json()["error"]
    assert err["raw_ref"] == "ferry_ab12cd34", "it must say WHICH scene to edit instead"


def test_an_edited_scene_needs_a_name(client, root):
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    r = client.post("/clips/scenes/ferry_ab12cd34/edit",
                    json={"title": "  ", "ops": [{"op": "replace", "index": 0,
                                                  "kind": "playground", "ref": "v/a"}]})
    assert r.status_code == 400


@pytest.mark.parametrize("ops", [
    [],
    [{"op": "sideways", "index": 0, "kind": "playground", "ref": "v/a"}],
    [{"op": "replace", "index": 7, "kind": "playground", "ref": "v/a"}],     # only 2 entries
    [{"op": "replace", "index": 0, "kind": "nope", "ref": "v/a"}],
])
def test_a_bad_plan_is_a_400_with_a_message(client, root, ops):
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    r = _edit(client, "ferry_ab12cd34", ops=ops)
    assert r.status_code == 400
    assert isinstance(r.get_json()["error"], str) and r.get_json()["error"]


@pytest.mark.parametrize("ref, why", [
    ("../../etc/passwd", "malformed — resolve returns None"),
    ('Test_Voice_1/deleted_last_week', "well-formed, but nothing is there"),
])
def test_a_clip_that_is_not_there_is_refused_at_the_door(client, root, ref, why):
    """Not deferred to the job. He picked this clip for this line; finding out it is missing
    after a 202 means a job he watches fail for a reason that was knowable before it started.

    🔴 Both cases, because they take different paths: `resolve` returns None only for the
    malformed one and hands back a perfectly good path for a clip that was deleted five minutes
    ago. An `is None` check alone lets the second one through."""
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    r = _edit(client, "ferry_ab12cd34",
              ops=[{"op": "replace", "index": 0, "kind": "playground", "ref": ref}])
    assert r.status_code == 400, why


def test_the_status_and_cancel_routes_404_an_unknown_job(client):
    assert client.get("/clips/scenes/edit/nosuchjob").status_code == 404
    assert client.post("/clips/scenes/edit/nosuchjob/cancel").status_code == 404


def test_the_status_route_does_not_shadow_the_edit_verb(client, root):
    """⚠️ `/clips/scenes/<ref>/edit` and `/clips/scenes/edit/<job_id>` live in the same space.
    They cannot collide — the verb's last segment is the literal "edit" — but that is the kind of
    thing that is true until someone adds a third route, so it is pinned."""
    import scene_edit
    _mk(root, "ferry_ab12cd34", {"title": "The ferry", "entries": ENTRIES})
    job = scene_edit.EditJob(id="abc123", title="T", src_ref="ferry_ab12cd34")
    scene_edit.JOBS["abc123"] = job
    try:
        got = client.get("/clips/scenes/edit/abc123").get_json()
        assert got["job_id"] == "abc123" and got["src_ref"] == "ferry_ab12cd34"
        # …and the verb still reaches the verb, not the status route.
        assert _edit(client, "ferry_ab12cd34", ops=[]).status_code == 400
    finally:
        scene_edit.JOBS.pop("abc123", None)


def test_canceling_sets_the_flag_the_job_reads(client, root):
    import scene_edit
    job = scene_edit.EditJob(id="cxx", title="T", src_ref="ferry_ab12cd34")
    scene_edit.JOBS["cxx"] = job
    try:
        assert client.post("/clips/scenes/edit/cxx/cancel").get_json()["ok"] is True
        assert job.cancel.is_set()
    finally:
        scene_edit.JOBS.pop("cxx", None)

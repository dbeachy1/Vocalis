"""Test ACE-Step routes, authorization, readiness, and lifecycle against local child doubles."""
import threading
import time
import types

import pytest

import vocalis_server as vs
from vocalis.runtime import acestep as rt
from vocalis.runtime import settings as rt_settings
from vocalis.runtime import paths as rt_paths
import vocalis.runtime.jobs as jobs_mod


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def no_host_reads(monkeypatch, tmp_path):
    """Keep settings and candidate persistence inside this test's temporary directory."""
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    monkeypatch.setattr(rt_paths, "ACE_CANDIDATES", tmp_path / "ace_candidates.json")
    monkeypatch.setattr(rt_paths, "UI_STATE", tmp_path / "ui_state.json")
    monkeypatch.setattr(rt, "_BACKENDS", {})
    monkeypatch.setattr(rt, "_STOP_ALL", threading.Event())


def _two_installed(monkeypatch):
    """Expose two configured local child slots without starting either process."""
    instances = [
        ("acestep-api-gpu0", "http://127.0.0.1:7683", "cuda:0"),
        ("acestep-api-gpu1", "http://127.0.0.1:7685", "cuda:1"),
    ]
    monkeypatch.setattr(rt, "configured", lambda _settings=None: instances)
    monkeypatch.setattr(rt, "installed", lambda: instances)


def _settings(monkeypatch, devices):
    monkeypatch.setattr(rt_settings, "load_app_settings", lambda: {"devices": devices})


def test_no_configured_acestep_child_hides_the_button(client, monkeypatch):
    """Without configured local children, the ACE-Step panel is unavailable."""
    monkeypatch.setattr(rt, "installed", lambda: [])
    j = client.get("/acestep/status").get_json()
    assert j == {"available": False}


def test_status_reports_every_authorized_backend_with_its_card(client, monkeypatch):
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 1)
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": url.endswith("7683"), "model_loaded": url.endswith("7683"),
        "model": "acestep-v15-turbo"})
    j = client.get("/acestep/status").get_json()
    assert j["available"] is True and j["instances"] == 2 and j["running"] == 1
    assert [b["device"] for b in j["backends"]] == ["cuda:0", "cuda:1"]


def test_a_live_child_that_is_not_answering_is_not_reported_as_stopped(client, monkeypatch):
    """Keep process phase separate from HTTP readiness when a health probe fails."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True}])
    # cuda:0 is answering; cuda:1 remains active although its HTTP probe fails.
    monkeypatch.setattr(rt, "active_states", lambda insts=None: {"cuda:0": "active", "cuda:1": "active"})
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": url.endswith("7683"), "model_loaded": url.endswith("7683"),
        "model": "acestep-v15-xl-sft" if url.endswith("7683") else None})
    by_dev = {b["device"]: b for b in client.get("/acestep/status").get_json()["backends"]}
    assert by_dev["cuda:1"]["up"] is False, "the probe is still allowed to say it did not answer"
    assert by_dev["cuda:1"]["unit"] == "active"
    assert by_dev["cuda:0"]["unit"] == "active"


def test_a_child_that_is_stopped_says_so(client, monkeypatch):
    """A confirmed child exit reports stopped independently of the failed HTTP probe."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "active_states", lambda insts=None: {"cuda:0": "active", "cuda:1": "stopped"})
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": False, "model_loaded": None, "model": None})
    by_dev = {b["device"]: b for b in client.get("/acestep/status").get_json()["backends"]}
    assert by_dev["cuda:1"]["unit"] == "stopped"
    assert by_dev["cuda:0"]["unit"] == "active"


def test_a_child_waiting_for_exit_keeps_running_count_unknown(client, monkeypatch):
    """An unconfirmed stop remains distinct from both active and stopped."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "active_states", lambda insts=None: {
        "cuda:0": "stopping", "cuda:1": "stopped"})
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": False, "model_loaded": None, "model": None})
    j = client.get("/acestep/status").get_json()
    by_dev = {b["device"]: b for b in j["backends"]}
    assert by_dev["cuda:0"]["unit"] == "stopping"
    assert by_dev["cuda:1"]["unit"] == "stopped"
    assert j["running"] is None


def test_running_counts_owned_children_even_when_a_card_is_unauthorized(client, monkeypatch):
    """The global lifecycle button can stop owned children regardless of model authorization."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True, "uses": {"acestep": False}}])
    monkeypatch.setattr(rt, "active_states", lambda insts=None: {"cuda:0": "active", "cuda:1": "active"})
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": False, "model": None})
    j = client.get("/acestep/status").get_json()
    assert j["installed"] == 2 and j["instances"] == 1
    assert j["running"] == 2, "both owned children are running; authorization remains a separate field"
    by_dev = {b["device"]: b for b in j["backends"]}
    assert by_dev["cuda:1"]["unit"] == "active", "the ROW still tells the truth about it"


def test_unticking_acestep_for_a_card_keeps_the_row_and_revokes_the_MODEL(client, monkeypatch):
    """🔴 WHAT THE TICK REVOKES IS THE VRAM, NOT THE PROCESS — changed .

    This used to assert that an unticked card's backend vanished from the status entirely. That
    was the wrong half of the pair to enforce: it hid a unit that might be RUNNING, so the panel
    could neither show it nor offer to stop it, and a row that disappears because of a tick
    elsewhere is indistinguishable from a card that broke.

    The row stays and carries ``authorized: false``. The denial that matters is enforced where the
    14-19 GB is actually spent — ``test_init_refuses_a_card_that_is_not_authorized`` and
    ``test_generate_refuses_when_no_card_is_authorized`` are the two that must never relax.
    """
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True, "uses": {"acestep": False}}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 1)
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": False, "model": None})
    j = client.get("/acestep/status").get_json()
    assert j["instances"] == 1, "only cuda:0 may hold a model"
    assert j["installed"] == 2
    assert [b["device"] for b in j["backends"]] == ["cuda:0", "cuda:1"],         "the unticked card keeps its row so a running backend stays visible and stoppable"
    by_dev = {b["device"]: b for b in j["backends"]}
    assert by_dev["cuda:0"]["authorized"] is True
    assert by_dev["cuda:1"]["authorized"] is False


def test_a_card_switched_off_entirely_is_also_unauthorized_but_still_shown(client, monkeypatch):
    """`enabled: false` is the whole row, and it outranks the indented tick — a card that is off
    is off for ACE-Step too, whatever `uses` happens to say. It is reported as unauthorized rather
    than hidden, for the same reason as the test above."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": False, "uses": {"acestep": True}},
                            {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 0)
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": False, "model_loaded": None, "model": None})
    j = client.get("/acestep/status").get_json()
    by_dev = {b["device"]: b for b in j["backends"]}
    assert set(by_dev) == {"cuda:0", "cuda:1"}
    assert by_dev["cuda:0"]["authorized"] is False, "enabled:false outranks uses.acestep:true"
    assert by_dev["cuda:1"]["authorized"] is True
    assert j["instances"] == 1


def test_a_config_written_before_8_0_authorizes_both_cards(client, monkeypatch):
    """🔴 THE MIGRATION, AND IT IS THE WHOLE REASON `authorized()` DEFAULTS TO TRUE. Every
    app_settings.yaml on disk today was written before ACE-Step was in the registry, so it has no
    `acestep` key at all. An absent key means allowed — otherwise upgrading to 8.0 would silently
    switch the music backends off on a box that never chose that."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True, "uses": {"training": False}},
                            {"id": "cuda:1", "enabled": True, "uses": {"render": True}}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 0)
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": False, "model_loaded": None, "model": None})
    j = client.get("/acestep/status").get_json()
    assert j["instances"] == 2, "a pre-8.0 config unticked ACE-Step by omission"


def test_a_backend_that_does_not_answer_reports_model_state_unknown_not_unloaded(monkeypatch):
    """🔴 None, NEVER False. "I could not ask" and "it holds no model" are different answers, and
    collapsing them tells someone to re-Initialize a backend that is already loaded — 19 GB of
    xl-sft read back for nothing."""
    got = rt.probe("http://127.0.0.1:1")     # nothing listens there
    assert got == {"up": False, "model_loaded": None, "model": None}


def test_a_running_backend_with_no_model_is_up_but_not_loaded(client, monkeypatch):
    """The distinction the whole tab exists for: serving HTTP is not holding a model, and the
    status must let the UI say which."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "installed", lambda: [
        ("acestep-api-gpu0", "http://127.0.0.1:7683", "cuda:0")])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 1)
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": False, "model": "acestep-v15-xl-sft"})
    b = client.get("/acestep/status").get_json()["backends"][0]
    assert b["up"] is True and b["model_loaded"] is False
    assert b["model"] == "acestep-v15-xl-sft", "the selection is still worth showing"


@pytest.mark.parametrize("action", ["start", "stop", "restart"])
def test_global_lifecycle_targets_every_configured_child(client, monkeypatch, action):
    """Global lifecycle controls address configured local children independently of authorization."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True, "uses": {"acestep": False}},
                            {"id": "cuda:1", "enabled": True, "uses": {"acestep": False}}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 0)
    results = [{"ok": True, "state": action, "device": dev}
               for _svc, _url, dev in rt.installed()]
    monkeypatch.setattr(rt, f"{action}_all", lambda **_kw: results)
    j = client.post("/acestep/" + action).get_json()
    assert j["ok"] is True
    assert [row["device"] for row in j["devices"]] == ["cuda:0", "cuda:1"]


@pytest.mark.parametrize("action", ["start", "stop", "restart"])
def test_control_drives_every_installed_unit_not_just_the_ticked_one(client, monkeypatch, action):
    """An unticked card's child remains addressable for explicit lifecycle cleanup."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True, "uses": {"acestep": False}}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 1)
    results = [{"ok": True, "state": action, "device": dev}
               for _svc, _url, dev in rt.installed()]
    monkeypatch.setattr(rt, f"{action}_all", lambda **_kw: results)
    j = client.post("/acestep/" + action).get_json()
    assert j["ok"] is True
    assert [row["device"] for row in j["devices"]] == ["cuda:0", "cuda:1"]


def test_the_jobs_list_keeps_its_order_when_a_queued_song_starts(client, monkeypatch):
    """Order jobs by stable creation order. started_at changes when rendering begins, so sorting by it would move a queued row and make the list appear to reset its position or elapsed time."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}, {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 2)

    import vocalis.runtime.jobs as jobs_mod
    for jid in [j for j, x in list(jobs_mod.JOBS.items())
                if getattr(x, "kind", "") == "acestep"]:
        jobs_mod.JOBS.pop(jid, None)

    made = []
    for n in range(3):
        j = jobs_mod.Job(id=f"ace-order-{n}", docx="", voice="", params=None,
                         gpus="", workers=1)
        j.kind = "acestep"
        j.status = "queued"
        j.detail = {"title": f"song {n}"}
        jobs_mod.JOBS[j.id] = j
        made.append(j)

    before = [x["id"] for x in client.get("/acestep/jobs").get_json()["jobs"]]
    assert before == ["ace-order-2", "ace-order-1", "ace-order-0"],         f"newest-created first, and stable: {before}"

    # The LAST-created song starts. Under the old sort its fresh started_at would rocket it to the
    # top; it must simply stay where it is.
    made[0].status = "running"
    made[0].started_at = 10_000_000.0
    after = [x["id"] for x in client.get("/acestep/jobs").get_json()["jobs"]]
    assert after == before, f"a song starting must not move any row: {before} -> {after}"


def test_the_acestep_tab_never_persists_through_raw_localStorage():
    """Persist account-level ACE-Step selections through the server-side vault-backed UI state. The boot sweep removes account keys from localStorage, so the source-level guard prevents new controls from writing selections to the wrong store."""
    import pathlib
    ace = pathlib.Path(__file__).resolve().parents[1] / "src" / "webui" / "js" / "ace"
    offenders = []
    for f in sorted(ace.glob("*.js")):
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if "localStorage" not in line or line.lstrip().startswith(("//", "*")):
                continue
            offenders.append(f"{f.name}:{i}: {line.strip()[:90]}")
    assert not offenders, (
        "the ACE-Step tab must persist through UIS, never raw localStorage — UIS sweeps "
        "`vocalis-*` keys off the client on boot, so these would silently reset: "
        + "; ".join(offenders))


def test_a_candidate_survives_the_process_that_made_it(client, monkeypatch, tmp_path):
    """Persist completed candidates in the registry so they survive process restart. Exercise the round trip by clearing in-memory state and rehydrating it from storage."""
    import vocalis.runtime.acecands as acecands
    import vocalis.runtime.jobs as jobs_mod
    import vocalis.runtime.paths as rt_paths
    monkeypatch.setattr(rt_paths, "ACE_CANDIDATES", tmp_path / "ace_candidates.json")

    acecands.forget_all()
    acecands.remember("cand-1", "done", 1000.0,
                      {"device": "cuda:0", "model": "acestep-v15-xl-sft", "seed": 7,
                       "title": 'Sample Track One', "url": "http://127.0.0.1:7683",
                       "audio": ["/home/test-user/x.flac"]})

    # A restart is exactly this: the registry is gone, the store is not.
    for jid in [j for j, x in list(jobs_mod.JOBS.items())
                if getattr(x, "kind", "") == "acestep"]:
        jobs_mod.JOBS.pop(jid, None)
    assert acecands.rehydrate(jobs_mod) == 1

    j = jobs_mod.JOBS["cand-1"]
    assert j.status == "done" and j.kind == "acestep"
    assert j.detail["audio"] == ["/home/test-user/x.flac"], "the path to fetch it back must survive"
    assert j.detail["title"] == 'Sample Track One'

    # ⚠️ AND DISCARD HAS TO REACH THE STORE, or persistence hands back the thing you threw away.
    assert acecands.forget("cand-1") is True
    for jid in list(jobs_mod.JOBS):
        jobs_mod.JOBS.pop(jid, None)
    assert acecands.rehydrate(jobs_mod) == 0, "a discarded candidate must not come back"


@pytest.fixture
def lib_store(monkeypatch, tmp_path):
    """acelib in a temp root.

    🔴 BOTH PATHS, the index AND the audio directory. Patching only the index still writes a real
    FLAC into the install root's `ace_library/`, which is the same "a spec left a file in the
    repo" failure `no_host_reads` was written for one store earlier.
    """
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", tmp_path / "ace_library.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", tmp_path / "ace_library")
    return tmp_path


#: The §4.5.2 identity, as the form submits it — every field, not just the two with words in.
_FULL_SONG = {"name": 'Sample Track One', "caption": "alternative metal, driving drums",
              "lyrics": "[verse]\nrain on the tin\n[chorus]\nashes", "bpm": 148,
              "key_scale": "Am", "time_signature": "4", "vocal_language": "en",
              "duration": 210, "instrumental": False}


def test_saving_a_song_records_the_WHOLE_form_not_just_its_words(client, two_live, lib_store,
                                                                 monkeypatch):
    """Store every generation setting needed to restore a saved song's form, including advanced fields. Exercise generate, finish, save, and read-back through the library route."""
    import vocalis.runtime.acelib as rt_acelib          # noqa: F401 — patched via rt_paths above
    from vocalis.web import acestep as web_ace

    settings = {"inference_steps": 60, "guidance_scale": 7.5, "thinking": True}
    r = client.post("/acestep/generate",
                    json={"template": _FULL_SONG, "settings": settings}).get_json()
    job_id = r["jobs"][0]["job_id"]

    job = jobs_mod.JOBS[job_id]
    job.status = "done"
    job.detail = dict(job.detail, url="http://127.0.0.1:7683", audio=["/tmp/x.flac"])
    monkeypatch.setattr(web_ace.acestep, "fetch_audio", lambda url, path: b"FLACfake")

    saved = client.post(f"/acestep/jobs/{job_id}/save", json={"name": 'Sample Track One'})
    assert saved.status_code == 201, saved.get_data(as_text=True)

    row = client.get("/acestep/library").get_json()["songs"][0]
    assert row["template"] == _FULL_SONG, (
        "every §4.5.2 field must survive the save, not just caption and lyrics — without them the "
        f"form cannot be restored and no template comparison is possible: {row['template']}")
    assert row["settings"] == settings, "the Advanced knobs the song was rendered with"


def test_the_stored_settings_are_the_USERS_dict_not_the_resolved_payload(client, two_live,
                                                                        lib_store, monkeypatch):
    """🔴 WHAT WAS LEFT BLANK MUST COME BACK BLANK.

    `acegen` fills every per-model default into the payload — steps 8 for turbo, 50 for xl-sft,
    DCW to match. If the row recorded THAT, clicking the song would put a hard number into a box
    the user deliberately left empty, and every later render on the other card would use the wrong
    one, silently. `js/ace/advanced.js` is written at length about exactly this.

    So: submit no steps, and the row must record no steps — even though the payload that reached
    ACE-Step certainly had some.
    """
    from vocalis.web import acestep as web_ace

    client.post("/acestep/generate", json={"template": _FULL_SONG, "settings": {}})
    job_id = next(j for j, x in jobs_mod.JOBS.items() if getattr(x, "kind", "") == "acestep")
    job = jobs_mod.JOBS[job_id]
    # The payload really does carry a resolved value — that is the thing being kept OUT of the row.
    assert job.detail["payload"].get("inference_steps"), \
        "fixture check: acegen is expected to resolve steps from the card's model"

    job.status = "done"
    job.detail = dict(job.detail, url="http://127.0.0.1:7683", audio=["/tmp/x.flac"])
    monkeypatch.setattr(web_ace.acestep, "fetch_audio", lambda url, path: b"FLACfake")
    client.post(f"/acestep/jobs/{job_id}/save", json={"name": "Blank"})

    row = client.get("/acestep/library").get_json()["songs"][0]
    assert row["settings"] == {}, (
        "an empty Advanced panel must be recorded as empty — recording the resolved payload here "
        f"pins steps to one card's model on every later render: {row['settings']}")


def _finished_candidate(client, monkeypatch, payload=b"0123456789abcdef"):
    """Generate one song, mark it finished, and stub the fetch. Returns its job id."""
    from vocalis.web import acestep as web_ace
    client.post("/acestep/generate", json={"template": _FULL_SONG, "settings": {}})
    job_id = next(j for j, x in jobs_mod.JOBS.items() if getattr(x, "kind", "") == "acestep")
    job = jobs_mod.JOBS[job_id]
    job.status = "done"
    job.detail = dict(job.detail, url="http://127.0.0.1:7683", audio=["/tmp/x.flac"])
    monkeypatch.setattr(web_ace.acestep, "fetch_audio", lambda url, path: payload)
    return job_id


def test_a_candidate_can_be_SEEKED_not_only_played(client, two_live, monkeypatch):
    """Support byte-range requests for saved audio. Verify the requested slice and the partial-content headers that let a browser seek and report duration."""
    job_id = _finished_candidate(client, monkeypatch)

    whole = client.get(f"/acestep/jobs/{job_id}/audio")
    assert whole.status_code == 200
    assert whole.headers.get("Accept-Ranges") == "bytes", \
        "without this header a browser will not offer a seek bar at all"
    assert whole.headers.get("ETag"), \
        "If-Range needs a validator, or a seek mid-playback cannot be made safe"

    part = client.get(f"/acestep/jobs/{job_id}/audio", headers={"Range": "bytes=4-8"})
    assert part.status_code == 206, f"a Range request must be answered 206, got {part.status_code}"
    assert part.get_data() == b"45678", "the 206 must carry the slice that was asked for"
    assert part.headers["Content-Range"] == "bytes 4-8/16"



def test_the_audio_routes_hold_NO_cache_and_read_fresh_every_time(client, two_live, lib_store,
                                                                  monkeypatch):
    """Do not add an application audio cache or in-flight response map to these routes. Each request reads the saved artifact so responses stay current and cannot mix one song's bytes under another song's identity."""
    import vocalis.runtime.acelib as rt_acelib
    from vocalis.web import acestep as web_ace

    assert not hasattr(web_ace, "_AUDIO_CACHE"), "the audio cache is back"
    assert not hasattr(web_ace, "_cached_fetch"), "the coalescing wrapper is back"

    reads = []
    real = web_ace.vault_fs.read_bytes
    monkeypatch.setattr(web_ace.vault_fs, "read_bytes",
                        lambda p: (reads.append(p), real(p))[1])
    song = rt_acelib.save(b"0123456789abcdef", name='Sample Track One')
    reads.clear()
    for _ in range(3):
        client.get(f"/acestep/library/{song.id}/audio")
    assert len(reads) == 3, f"three requests must do three reads, got {len(reads)}"

    fetches = []
    job_id = _finished_candidate(client, monkeypatch)
    monkeypatch.setattr(web_ace.acestep, "fetch_audio",
                        lambda url, path: (fetches.append(path), b"0123456789abcdef")[1])
    for _ in range(3):
        client.get(f"/acestep/jobs/{job_id}/audio")
    assert len(fetches) == 3, f"three requests must do three fetches, got {len(fetches)}"


def test_a_saved_song_can_be_seeked_too(client, lib_store, monkeypatch):
    """The library player is the same element with the same requirement. It is a separate route,
    so it is a separate way to get this wrong — and it was wrong in exactly the same way."""
    import vocalis.runtime.acelib as rt_acelib
    song = rt_acelib.save(b"0123456789abcdef", name='Sample Track One')

    whole = client.get(f"/acestep/library/{song.id}/audio")
    assert whole.status_code == 200 and whole.headers.get("Accept-Ranges") == "bytes"

    part = client.get(f"/acestep/library/{song.id}/audio", headers={"Range": "bytes=0-3"})
    assert part.status_code == 206 and part.get_data() == b"0123"




def test_timestep_shift_follows_the_cards_model_instead_of_being_forced_to_1(client, two_live):
    """🔴 A BLANK BOX MEANT "SEND 1.0", NOT "LET ACE-STEP DECIDE", AND THAT OVERRODE TURBO.

    `build_payload` did `float(s.get("shift", 1.0))`, so every render explicitly sent 1.0 —
    overriding ACE-Step's own pydantic default of 3.0 (`release_task_models.py:92`). For base and
    SFT that lands on the right number by accident. For turbo it is wrong, and upstream is
    explicit: *"the only timestep/guidance parameter you need to set manually for turbo is
    shift=3.0"* (`docs/en/INFERENCE.md:361`).

    ⚠️ ACE-STEP CONTRADICTS ITSELF HERE AND THIS WAS RESOLVED FROM THE CODE. Its API field says
    shift is "Only effective for base models, not turbo models" — false:
    `modeling_acestep_v15_turbo.py:1978` applies the same `t = shift*t/(1+(shift-1)*t)` transform
    the base and SFT samplers do. Every family uses it.
    """
    from vocalis.runtime import acegen
    assert acegen.shift_for("acestep-v15-turbo") == 3.0
    assert acegen.shift_for("acestep-v15-xl-turbo") == 3.0
    assert acegen.shift_for("acestep-v15-xl-sft") == 1.0
    assert acegen.shift_for("") == 1.0, "an unknown model falls back to base, never to a guess"

    # And it reaches the wire, per card, exactly as steps do. cuda:0 holds turbo here.
    client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}})
    by_dev = {j.detail["device"]: j.detail["payload"]
              for j in jobs_mod.JOBS.values() if getattr(j, "kind", "") == "acestep"}
    assert by_dev["cuda:0"]["shift"] == 3.0, "turbo's card must get turbo's shift"
    assert by_dev["cuda:1"]["shift"] == 1.0, "the xl-sft card must not"


def test_an_explicit_shift_still_wins_over_the_models_default(client, two_live):
    """⚠️ Model-driven is the BLANK behavior, not an override. A number typed in the box has to
    reach both cards — the same contract Steps has, and the same one a user reads "leave a box
    empty to use the default" as promising."""
    client.post("/acestep/generate",
                json={"template": {"name": 'Sample Track'}, "settings": {"shift": 2.5}})
    shifts = {j.detail["payload"]["shift"] for j in jobs_mod.JOBS.values()
              if getattr(j, "kind", "") == "acestep"}
    assert shifts == {2.5}, shifts


def test_a_pinned_seed_is_used_for_every_card_instead_of_a_fresh_one(client, two_live):
    """A pinned seed deliberately overrides per-card seed variation to reproduce a selected take. Keep the default per-card behavior covered separately so an unpinned multi-card render still produces distinct takes."""
    j = client.post("/acestep/generate",
                    json={"template": {"name": 'Sample Track'}, "settings": {"seed": 12345}}).get_json()
    assert [x["seed"] for x in j["jobs"]] == [12345, 12345]


@pytest.mark.parametrize("bad", ["", None, "not a number", -5, 2**40])
def test_a_seed_that_is_not_a_usable_number_renders_something_anyway(client, two_live, bad):
    """⚠️ A KNOB, NOT AN INSTRUCTION. A press that took a paragraph of lyrics to set up must not
    400 because a number was out of range — it should render. Empty and nonsense fall back to
    random; out of range clamps."""
    j = client.post("/acestep/generate",
                    json={"template": {"name": 'Sample Track'}, "settings": {"seed": bad}}).get_json()
    seeds = [x["seed"] for x in j["jobs"]]
    assert len(seeds) == 2 and all(0 <= s <= 2**31 - 2 for s in seeds), seeds


def test_generate_forever_fills_free_cards_and_queues_NOTHING(client, two_live, monkeypatch):
    """Generate only when a card is free; do not prequeue a job with stale form values. Read the current settings when the next card becomes available."""
    from vocalis.web import acestep as web_ace
    try:
        web_ace.set_forever(True, {"template": {"name": "Endless"}, "settings": {}})
        web_ace._forever_topup()          # the second card
        web_ace._forever_topup()          # both busy now — this one must add nothing

        snap = web_ace.QUEUE.snapshot()
        assert len(snap["inflight"]) == 2, f"both cards should be rendering: {snap['inflight']}"
        assert snap["pending"] == [], (
            "nothing may sit in the queue — a parked song renders words that are already stale: "
            f"{snap['pending']}")
    finally:
        web_ace.set_forever(False)
    assert web_ace.forever_state() == {"on": False}
    # ⚠️ AND IT REALLY STOPS. A stale flag would keep the watchdog starting songs after the button
    # says it is off, which is the worst possible version of this feature.
    assert web_ace._forever_topup() == 0


def test_generate_forever_never_stacks_behind_a_hand_pressed_generate(client, two_live):
    """⚠️ Generate fans out one song per card, so a press while forever is on fills the queue by
    hand. The top-up must see that and stay out of it — otherwise the two of them race to fill a
    queue that is meant to be empty, and Clear queue stops meaning anything."""
    from vocalis.web import acestep as web_ace
    try:
        web_ace.set_forever(True, {"template": {"name": "Endless"}, "settings": {}})
        client.post("/acestep/generate", json={"template": {"name": "By hand"}})
        before = web_ace.QUEUE.snapshot()["pending"]
        assert before, "fixture check: a hand press with both cards busy should leave work waiting"
        assert web_ace._forever_topup() == 0
        assert web_ace.QUEUE.snapshot()["pending"] == before, \
            "forever must add nothing while anything is already waiting"
    finally:
        web_ace.set_forever(False)


def test_a_running_forever_takes_the_words_that_are_on_screen_now(client, two_live):
    """Refresh the running recipe as the form changes without restarting the mode or starting a job. The next render uses the current form state."""
    from vocalis.web import acestep as web_ace
    try:
        r = client.post("/acestep/forever",
                        json={"on": True, "template": {"name": "First", "lyrics": "old words"}})
        assert r.get_json() == {"on": True}

        client.post("/acestep/forever",
                    json={"on": True, "refresh": True,
                          "template": {"name": "Second", "lyrics": "new words"}})
        assert web_ace.forever_state() == {"on": True}, "a refresh must not toggle the mode"
        assert web_ace._FOREVER["recipe"]["template"]["lyrics"] == "new words"

        # Free a card and let it start one: it must render the NEW words.
        for dev in list(web_ace.QUEUE.snapshot()["inflight"]):
            web_ace.QUEUE.release(web_ace.QUEUE.snapshot()["inflight"][dev])
        assert web_ace._forever_topup() == 1
        started = [j for j in jobs_mod.JOBS.values()
                   if getattr(j, "kind", "") == "acestep" and j.detail.get("rebuild")]
        assert started[-1].detail["template"]["lyrics"] == "new words", (
            "the song started after the edit must use the edited words, not the ones the button "
            f"was pressed with: {started[-1].detail['template']}")
    finally:
        web_ace.set_forever(False)


def test_discard_all_takes_the_finished_and_leaves_what_it_cannot_honestly_touch(client, two_live,
                                                                                monkeypatch):
    """Discard completed candidates only. Leave active jobs to their cancel control and queued jobs to Clear queue so one action has one predictable effect."""
    client.post("/acestep/generate", json={"template": {"name": "One"}})
    client.post("/acestep/generate", json={"template": {"name": "Two"}})
    mine = [j for j in jobs_mod.JOBS.values() if getattr(j, "kind", "") == "acestep"]
    assert len(mine) == 4, f"fixture check: two presses on two cards: {len(mine)}"
    mine[0].status = "done"
    mine[1].status = "failed"
    mine[2].status = "running"
    mine[3].status = "queued"

    r = client.post("/acestep/candidates/discard_all", json={}).get_json()
    assert r["discarded"] == 2, r
    assert r["still_running"] == 1 and r["still_queued"] == 1, (
        "a song on a card cannot be stopped and a queued one is Clear queue's business — "
        f"neither may be swept up by this: {r}")

    left = {j.status for j in jobs_mod.JOBS.values() if getattr(j, "kind", "") == "acestep"}
    assert left == {"running", "queued"}, left


def test_discard_all_really_forgets_them_so_a_restart_does_not_hand_them_back(client, two_live,
                                                                             tmp_path):
    """⚠️ THE STORE, NOT JUST THE REGISTRY. Candidates are persisted (8.0-m7), so a Discard that
    only emptied the in-memory dict would have the whole tray reappear on the next restart —
    which is the exact bug the single Discard was fixed for, and this is a second way in."""
    import vocalis.runtime.acecands as acecands
    client.post("/acestep/generate", json={"template": {"name": "One"}})
    for j in jobs_mod.JOBS.values():
        if getattr(j, "kind", "") == "acestep":
            j.status = "done"
    assert acecands.load_all(), "fixture check: the candidates were remembered when queued"

    client.post("/acestep/candidates/discard_all", json={})
    assert acecands.load_all() == [], "a discarded candidate must not survive to be rehydrated"


def test_a_refresh_for_a_run_that_is_off_does_not_start_one(client, two_live):
    """A stale tab pushing edits at a mode nobody turned on must be told the truth, not quietly
    obeyed — otherwise closing a laptop lid and reopening it starts generating."""
    from vocalis.web import acestep as web_ace
    r = client.post("/acestep/forever", json={"on": True, "refresh": True,
                                              "template": {"name": "Ghost"}})
    assert r.get_json() == {"on": False}
    assert web_ace.forever_state() == {"on": False}


def test_generate_forever_ignores_a_pinned_seed(client, two_live):
    """⚠️ THE TWO FEATURES MEAN OPPOSITE THINGS. A fixed seed makes every render byte-identical,
    so "forever" with one set would burn both cards producing the same song until somebody
    noticed. Forever always draws fresh; the button's tooltip says so."""
    from vocalis.web import acestep as web_ace
    try:
        web_ace.set_forever(True, {"template": {"name": "Endless"}, "settings": {"seed": 999}})
        seeds = [j.detail["seed"] for j in jobs_mod.JOBS.values()
                 if getattr(j, "kind", "") == "acestep"]
        assert seeds and 999 not in seeds, \
            f"a forever run must not inherit a pinned seed and render one song over and over: {seeds}"
    finally:
        web_ace.set_forever(False)


def test_a_forever_job_is_built_for_the_card_that_actually_takes_it(client, two_live, monkeypatch):
    """🔴 A TOP-UP IS MADE FOR NO CARD IN PARTICULAR, so its payload is resolved at DISPATCH.

    Generate creates one job per card and bakes that card's model in, which is right because each
    job is created FOR a named card. A forever top-up cannot work that way — it makes ONE job to
    keep the queue at depth 1, and which card frees next is unknown until the queue hands it over.
    Left alone it would carry the other card's `inference_steps`: 8 turbo steps on an xl-sft card,
    or 50 on turbo, i.e. a visibly worse or needlessly slow render with nothing explaining it.
    """
    from vocalis.web import acestep as web_ace
    try:
        # 🔴 THE SETUP IS THE TEST. cuda:0 (turbo) is occupied by something else, so the only free
        # card is cuda:1, which holds xl-sft at 50 steps. Without the rebuild the payload keeps
        # whatever model it was built against and nothing anywhere says why the render came out
        # wrong — a rebuild that quietly stopped working would look like nothing at all.
        web_ace.QUEUE.claim("someone-elses-job", "cuda:0")
        web_ace.set_forever(True, {"template": {"name": "Endless"}, "settings": {}})

        job = next(j for j in jobs_mod.JOBS.values()
                   if getattr(j, "kind", "") == "acestep" and (j.detail or {}).get("rebuild"))
        assert job.detail["device"] == "cuda:1", \
            f"fixture check: the only free card was cuda:1, got {job.detail['device']}"
        assert job.detail["model"] == "acestep-v15-xl-sft", job.detail["model"]
        assert job.detail["payload"]["inference_steps"] == 50, (
            "the payload must be rebuilt for the card that took the job — 8 here would be turbo's "
            f"step count on an xl-sft card: {job.detail['payload']['inference_steps']}")
    finally:
        web_ace.set_forever(False)


def test_an_empty_settings_dict_is_not_the_same_answer_as_a_row_that_never_recorded_one(lib_store):
    """🔴 `{}` AND `None` MEAN DIFFERENT THINGS AND THE STORE MUST KEEP THEM APART.

    `{}` is "this song recorded its settings, and they were all defaults" — loading it CLEARS the
    Advanced boxes. `None` is a row saved before 8.0-m9, which never recorded them at all; loading
    that must leave the boxes alone rather than wiping knobs on the strength of a row that knew
    nothing about them.

    ⚠️ The trap is `d.get("settings") or None`, which is the obvious way to write `from_dict` and
    quietly folds the first case into the second — `{}` is falsy. The client cannot tell them
    apart afterward, so the distinction has to survive the JSON round trip here.
    """
    import vocalis.runtime.acelib as rt_acelib

    recorded = rt_acelib.Song.from_dict(
        {"id": "a", "name": "All defaults", "settings": {}, "template": {}})
    never = rt_acelib.Song.from_dict({"id": "b", "name": "From 8.0-m8"})

    assert recorded.settings == {} and recorded.settings is not None
    assert never.settings is None and never.template is None
    # …and out through to_dict again, which is what the route actually serializes.
    assert recorded.to_dict()["settings"] == {}
    assert never.to_dict()["settings"] is None


def test_rehydrate_never_clobbers_a_render_in_flight(monkeypatch, tmp_path):
    """A record on disk is a snapshot of something that finished; a live job is the authority on
    itself. Rehydrating over a running render would reset it to 'done' and strand the worker."""
    import vocalis.runtime.acecands as acecands
    import vocalis.runtime.jobs as jobs_mod
    import vocalis.runtime.paths as rt_paths
    monkeypatch.setattr(rt_paths, "ACE_CANDIDATES", tmp_path / "ace_candidates.json")
    acecands.forget_all()
    acecands.remember("busy-1", "done", 1.0, {"audio": ["/old.flac"]})

    live = jobs_mod.Job(id="busy-1", docx="", voice="", params=None, gpus="", workers=1)
    live.kind = "acestep"
    live.status = "running"
    live.detail = {"audio": []}
    jobs_mod.JOBS["busy-1"] = live
    try:
        assert acecands.rehydrate(jobs_mod) == 0
        assert jobs_mod.JOBS["busy-1"].status == "running", "the live job won"
    finally:
        jobs_mod.JOBS.pop("busy-1", None)


def test_the_jobs_route_sends_the_server_clock(client, monkeypatch):
    """Elapsed is `now - started_at`, and the browser must not supply the `now`. /book/status and
    /bulk/status have always sent it — "started_at/now give real elapsed without trusting client
    clocks" — and this route omitted it, so any skew between development host and remote host was added to every
    reading on screen."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 1)
    j = client.get("/acestep/jobs").get_json()
    assert isinstance(j.get("now"), (int, float)), "the jobs route must publish the server clock"
    assert abs(j["now"] - time.time()) < 60, "and it must be the real one"


def test_the_panel_still_exists_when_no_card_is_ticked(client, monkeypatch):
    """`available` follows INSTALLED, not authorized. Reporting False here made the tab say
    "No ACE-Step backend is available on this box" about a box where it was installed and
    running — and hid the very button that could stop it."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True, "uses": {"acestep": False}},
                            {"id": "cuda:1", "enabled": True, "uses": {"acestep": False}}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 2)
    j = client.get("/acestep/status").get_json()
    assert j["available"] is True, "installed is what makes the panel exist"
    assert j["installed"] == 2 and j["instances"] == 0
    assert [b["device"] for b in j["backends"]] == ["cuda:0", "cuda:1"],         "an unticked card still gets a row - vanishing is indistinguishable from broken"
    assert all(b["authorized"] is False for b in j["backends"])


def test_global_stop_reports_each_child_result(client, monkeypatch):
    """A failed child stop is reported without hiding the result for another card."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}, {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 0)
    results = [
        {"ok": False, "state": "stopping", "device": "cuda:0",
         "error": "could not confirm child exit"},
        {"ok": True, "state": "stopped", "device": "cuda:1"},
    ]
    monkeypatch.setattr(rt, "stop_all", lambda **_kw: results)
    r = client.post("/acestep/stop")
    assert r.status_code == 502
    body = r.get_json()
    assert body["devices"] == results
    assert body["devices"][0]["state"] == "stopping"
    assert body["devices"][1]["state"] == "stopped"


def test_the_ports_are_not_the_api_servers_own_default(monkeypatch):
    """🔴 `acestep.api_server` defaults to port 8001, which on remote host is SillyTavern. The units pass
    --port explicitly and this module has to agree with them; a silent drift here would point
    Vocalis at whatever else is on 8001."""
    triples = rt.configured({"acestep": {"instances": 2}})
    assert [t[1] for t in triples] == ["http://127.0.0.1:7683", "http://127.0.0.1:7685"]
    assert [t[0] for t in triples] == ["acestep-api-gpu0", "acestep-api-gpu1"]
    assert [t[2] for t in triples] == ["cuda:0", "cuda:1"]


def test_a_hand_edited_instances_value_does_not_sink_the_button(monkeypatch):
    """`instances: two` is a config typo, not a reason for the header to lose its control."""
    assert len(rt.configured({"acestep": {"instances": "two"}})) == 1
    assert len(rt.configured({"acestep": "oops"})) == 1


# ── 8.0-m2: assigning a model to a card ──────────────────────────────────────────────────────

def test_models_lists_what_each_card_could_load(client, monkeypatch):
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}, {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "inventory", lambda url: {
        "models": ["acestep-v15-turbo", "acestep-v15-xl-sft"],
        "default": "acestep-v15-turbo", "reachable": True})
    j = client.get("/acestep/models").get_json()
    assert set(j["backends"]) == {"cuda:0", "cuda:1"}
    assert j["backends"]["cuda:0"]["models"] == ["acestep-v15-turbo", "acestep-v15-xl-sft"]


def test_a_backend_that_is_down_still_gets_a_row(client, monkeypatch):
    """`reachable: false` and an empty list, NOT an error. The row has to render — it is the row
    that offers to start the service in the first place."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "installed", lambda: [
        ("acestep-api-gpu0", "http://127.0.0.1:7683", "cuda:0")])
    monkeypatch.setattr(rt, "inventory", lambda url: {"models": [], "default": None,
                                                      "reachable": False})
    j = client.get("/acestep/models").get_json()
    assert j["backends"]["cuda:0"] == {"models": [], "default": None, "reachable": False}


def test_init_starts_the_load_and_answers_immediately(client, monkeypatch):
    """🔴 202, NOT 200, AND IT MUST NOT BLOCK. Reading xl-sft is 19 GB; a synchronous route would
    hold a worker for minutes and then time out mid-read, leaving the UI unable to say whether
    anything is still happening."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}, {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "inventory", lambda url: {
        "models": ["acestep-v15-turbo", "acestep-v15-xl-sft"], "default": None, "reachable": True})
    started = []

    def start_init(url, device, model, *, busy_check=None):
        assert callable(busy_check)
        started.append((device, model))
        return {"ok": True}

    monkeypatch.setattr(rt, "start_init", start_init)
    r = client.post("/acestep/init", json={"device": "cuda:1", "model": "acestep-v15-xl-sft"})
    assert r.status_code == 202
    assert started == [("cuda:1", "acestep-v15-xl-sft")]


def test_init_refuses_a_model_the_backend_does_not_have(client, monkeypatch):
    """🔴 THIS GUARD IS ABOUT DISK, NOT TIDINESS. `/v1/init` calls `ensure_model_downloaded`, so a
    typo would have it pull an unknown model from HuggingFace — and the first sign of that is a
    full disk, twenty minutes later."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "installed", lambda: [
        ("acestep-api-gpu0", "http://127.0.0.1:7683", "cuda:0")])
    monkeypatch.setattr(rt, "inventory", lambda url: {
        "models": ["acestep-v15-turbo"], "default": None, "reachable": True})
    called = []
    monkeypatch.setattr(rt, "start_init", lambda *a: called.append(a))
    r = client.post("/acestep/init", json={"device": "cuda:0", "model": "acestep-v15-xl-sf"})
    assert r.status_code == 400 and not called, "a typo'd model name reached /v1/init"
    assert "acestep-v15-turbo" in r.get_json()["error"], "the error did not say what IS available"


def test_init_refuses_a_card_that_is_not_authorized(client, monkeypatch):
    """Same rule as start/stop: the tick decides whether that backend may be driven at all."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True, "uses": {"acestep": False}}])
    called = []
    monkeypatch.setattr(rt, "start_init", lambda *a: called.append(a))
    r = client.post("/acestep/init", json={"device": "cuda:1", "model": "acestep-v15-turbo"})
    assert r.status_code == 404 and not called
    assert "Devices" in r.get_json()["error"]


@pytest.mark.parametrize("body", [{}, {"device": "cuda:0"}, {"model": "acestep-v15-turbo"}])
def test_init_needs_both_a_card_and_a_model(client, monkeypatch, body):
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    r = client.post("/acestep/init", json=body)
    assert r.status_code == 400


def test_a_load_in_flight_is_reported_as_a_third_state(client, monkeypatch):
    """🔴 "no model" AND "19 GB is 40 seconds into arriving" LOOK IDENTICAL over /health, and the
    difference is the whole reason someone does not click the dropdown a second time."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "installed", lambda: [
        ("acestep-api-gpu0", "http://127.0.0.1:7683", "cuda:0")])
    monkeypatch.setattr(rt, "active_count", lambda *_a: 1)
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": False, "model": "acestep-v15-turbo"})
    monkeypatch.setattr(rt, "loading_model", lambda dev: "acestep-v15-xl-sft")
    b = client.get("/acestep/status").get_json()["backends"][0]
    assert b["model_loaded"] is False and b["loading"] == "acestep-v15-xl-sft"


# ── 8.0-m3: the song-template routes ─────────────────────────────────────────────────────────

@pytest.fixture
def tpl_store(monkeypatch, tmp_path):
    """The route specs get their own library — never the developer's, which holds lyrics."""
    import vocalis.runtime.paths as rt_paths
    monkeypatch.setattr(rt_paths, "ACE_TEMPLATES", tmp_path / "ace_templates.json")
    return tmp_path / "ace_templates.json"


def _mk(client, name='Sample Track', **kw):
    body = {"name": name, "caption": "alternative metal, hard rock",
            "lyrics": "[verse]\nsomething", "bpm": 85}
    body.update(kw)
    r = client.post("/acestep/templates", json=body)
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def test_a_template_round_trips_through_the_routes(client, tpl_store):
    t = _mk(client)
    got = client.get("/acestep/templates").get_json()["templates"]
    assert [x["id"] for x in got] == [t["id"]]
    assert got[0]["caption"] == "alternative metal, hard rock" and got[0]["bpm"] == 85


def test_a_template_needs_a_title(client, tpl_store):
    r = client.post("/acestep/templates", json={"lyrics": "no title"})
    assert r.status_code == 400
    assert "title" in r.get_json()["message"].lower()


def test_saving_always_creates_so_a_shared_name_cannot_destroy_the_older_one(client, tpl_store):
    """🔴 The convention `/voices/templates` established, and its reason: the id is the identity.
    A save that replaced a same-named entry would silently lose twenty minutes of lyrics."""
    a, b = _mk(client, "Same"), _mk(client, "Same")
    assert a["id"] != b["id"]
    assert len(client.get("/acestep/templates").get_json()["templates"]) == 2


def test_a_rename_does_not_blank_the_lyrics(client, tpl_store):
    """🔴 THE BUG THE STORE SHIPPED WITH FOR ABOUT TEN MINUTES. The first `save()` clamped every
    field whether or not it was sent, so an absent key read as "" and got written — a rename
    erased the words."""
    t = _mk(client, "Keeps", lyrics="[chorus]\nkeep me")
    client.post("/acestep/templates/" + t["id"], json={"name": "Renamed"})
    got = client.get("/acestep/templates").get_json()["templates"][0]
    assert got["name"] == "Renamed" and got["lyrics"] == "[chorus]\nkeep me"


def test_the_star_toggles_through_the_same_route(client, tpl_store):
    t = _mk(client)
    client.post("/acestep/templates/" + t["id"], json={"favorite": True})
    assert client.get("/acestep/templates").get_json()["templates"][0]["favorite"] is True


def test_an_unknown_id_is_a_404_not_a_new_song(client, tpl_store):
    """⚠️ The store's own `save()` CREATES on a stale id, deliberately, so a race cannot lose
    freshly typed lyrics. The route is the layer that knows the user aimed at an existing row,
    so it is the layer that can tell a stale page from a new song."""
    assert client.post("/acestep/templates/nope", json={"name": "x"}).status_code == 404
    assert client.delete("/acestep/templates/nope").status_code == 404
    assert client.get("/acestep/templates").get_json()["templates"] == []


def test_an_empty_update_is_refused_rather_than_bumping_the_timestamp(client, tpl_store):
    t = _mk(client)
    assert client.post("/acestep/templates/" + t["id"], json={}).status_code == 400


def test_unknown_fields_are_ignored_not_stored(client, tpl_store):
    """🔴 THE FIELD SPLIT ENFORCED AT THE DOOR. A client that sends `seed` or `inference_steps`
    must not get them persisted — a seed on a template means two cards render the identical
    song, and render settings on a template break draft-then-render."""
    t = _mk(client, seed=42, inference_steps=50, model="acestep-v15-xl-sft")
    got = client.get("/acestep/templates").get_json()["templates"][0]
    for banned in ("seed", "inference_steps", "model"):
        assert banned not in got
    assert t["name"] == 'Sample Track'


# ── 8.0-m3d: generating ──────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def fresh_queue():
    """🔴 THE QUEUE AND THE JOB REGISTRY ARE PROCESS-WIDE, so without this every generate spec
    inherits the cards the previous one filled — and the failure is not an error, it is a wrong
    NUMBER. That is what it did: a spec counting running jobs saw four, because two tests earlier
    had left both cards occupied and their jobs still in `JOBS`."""
    from vocalis.web import acestep as web_ace
    web_ace.QUEUE._pending.clear()
    web_ace.QUEUE._inflight.clear()
    # The capability cache is process-wide for the same reason the queue is — and it is keyed by
    # URL, which stubs REUSE across files. A turbo-only tasks map left by one test would silently
    # capability-filter another test's generate on the same fake URL, which is the wrong-NUMBER
    # failure all over again. The model map goes with it: `_url_can_task` reads them as a pair.
    web_ace._TASKS_BY_URL.clear()
    web_ace._MODEL_BY_URL.clear()
    mine = [k for k, v in jobs_mod.JOBS.items() if getattr(v, "kind", "") == "acestep"]
    for k in mine:
        jobs_mod.JOBS.pop(k, None)
    yield


@pytest.fixture
def two_live(monkeypatch):
    """Two authorized backends, both up, holding different models — the draft-and-final shape."""
    from vocalis.web import acestep as web_ace
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}, {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "_runtime_inputs", lambda: (
        "/opt/python", "/opt/acestep", "/models/vocalis/acestep"))

    class FakeChild:
        pid = 941_217
        returncode = None

        def poll(self):
            return self.returncode

    monkeypatch.setattr(rt.subprocess, "Popen", lambda *args, **kwargs: FakeChild())
    for service, url, device in rt.installed():
        result = rt.start_instance(service=service)
        assert result["ok"], result
        rt.mark_http_ready(url)
        rt.mark_model_ready(url, True)
    models = {"7683": "acestep-v15-turbo", "7685": "acestep-v15-xl-sft"}
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": models[url[-4:]]})
    started = []
    # 🔴 REPLACE THE MODULE'S *REFERENCE*, NEVER `threading.Thread` ITSELF.
    # This was `monkeypatch.setattr("vocalis.web.acestep.threading.Thread", …)`, and that string
    # resolves `vocalis.web.acestep` → `.threading` → THE REAL threading MODULE, then sets
    # `.Thread` on it. So it swapped `threading.Thread` PROCESS-WIDE for the duration of the
    # test, for every library in the interpreter — while pretending, by its dotted path, to be
    # scoped to one module.
    # ⚠️ IT CAME DUE THE MOMENT ANY CODE ON THE PATH USED A THREAD POOL.
    # `concurrent.futures.ThreadPoolExecutor` builds its workers with `threading.Thread`; with
    # the stub installed, `start()` only appended to this list, so the pool's workers never ran
    # and `ex.map(...)` blocked forever. The symptom was not an error — it was
    # `worker 'gw1' crashed`, i.e. pytest-timeout killing the process at 60s, which reads as a
    # segfault and sends you looking in entirely the wrong place.
    # 📌 Rebinding the NAME in this one module's namespace is what the dotted path claimed to do
    # and what the fixture actually wants: `web_ace.threading` is only ever used for the one
    # `Thread(...)` in `_dispatch`.
    # ⚠️ THE STUB REPLACES `Thread`, NOT THE WHOLE MODULE'S SURFACE. It started life as a
    # SimpleNamespace carrying `Thread` alone, which was fine while that was the only name this
    # module used — and then Generate-forever added `threading.Event` for its watchdog's stop
    # signal, and three specs died with AttributeError inside the PRODUCT rather than saying
    # anything about the product. A stub narrower than the thing it stands in for is a trap that
    # springs on whoever adds the next line, so the real names are passed through.
    thread_api = types.SimpleNamespace(**vars(threading))
    thread_api.Thread = lambda target, name=None, args=(), daemon=None: type(
        "T", (), {"start": lambda self: started.append(args)})()
    monkeypatch.setattr(web_ace, "threading", thread_api)
    return started


def test_generate_makes_one_job_per_live_card(client, two_live):
    j = client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}}).get_json()
    assert [x["device"] for x in j["jobs"]] == ["cuda:0", "cuda:1"]


def test_each_card_gets_its_OWN_seed(client, two_live):
    """🔴 THE INVARIANT THAT MAKES TWO CARDS WORTH HAVING. Identical seeds and an identical
    template render the IDENTICAL song, which turns a two-card box into a one-card box that
    takes up twice the room — and it would look like it was working."""
    j = client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}}).get_json()
    seeds = [x["seed"] for x in j["jobs"]]
    assert len(set(seeds)) == len(seeds), f"two cards were handed the same seed: {seeds}"


def test_each_cards_payload_uses_that_cards_model(client, two_live):
    """The model comes from the CARD, so the two payloads differ in more than the seed: steps and
    DCW follow whatever that backend holds. A draft and a final really are different renders."""
    started = two_live
    client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}})
    payloads = {a[2]: a[3] for a in started}          # args = (job, url, device, payload, queue)
    assert payloads["cuda:0"]["inference_steps"] == 8      # turbo
    assert payloads["cuda:1"]["inference_steps"] == 50     # xl-sft
    assert payloads["cuda:0"]["dcw_enabled"] is True
    assert payloads["cuda:1"]["dcw_enabled"] is False


def test_generation_waits_for_model_readiness_even_with_a_saved_choice(client, monkeypatch, tmp_path):
    """A saved model choice does not make a no-init child ready for generation."""
    import ui_state
    from vocalis.runtime import paths

    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}, {"id": "cuda:1", "enabled": True}])
    ui_state.save(paths.UI_STATE, {"vocalis-ace-model-cuda:0": "acestep-v15-xl-sft",
                                   "vocalis-ace-model-cuda:1": "acestep-v15-xl-sft"})
    # The children answer HTTP but report no loaded model.
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": False, "model": None})

    response = client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}})
    assert response.status_code == 409
    assert "loaded, ready model" in response.get_json()["error"]
    assert not any(getattr(job, "kind", "") == "acestep" for job in jobs_mod.JOBS.values())


def test_a_card_that_already_holds_a_model_is_NOT_silently_swapped(client, two_live, monkeypatch):
    """⚠️ THE OTHER HALF, AND IT IS THE ONE THAT KEEPS THE FIX HONEST. The fallback applies only
    when the card holds NOTHING. A card holding turbo keeps running turbo until the user presses
    Swap — Generate quietly starting a 19 GB model change would be a worse surprise than the one
    being fixed, and the row says what is loaded so the two never disagree."""
    from vocalis.web import acestep as web_ace
    import ui_state
    from vocalis.runtime import paths

    ui_state.save(paths.UI_STATE, {"vocalis-ace-model-cuda:0": "acestep-v15-xl-sft"})
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": "acestep-v15-turbo"})
    monkeypatch.setattr(rt, "active_states", lambda insts=None: {"cuda:0": "active", "cuda:1": "active"})
    web_ace._MODEL_BY_URL.clear()

    j = client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}}).get_json()
    assert all(x["model"] == "acestep-v15-turbo" for x in j["jobs"]), \
        "what the card HOLDS wins whenever it holds anything"


def test_chosen_model_is_empty_when_nothing_was_ever_picked(monkeypatch):
    """No store, no key, no device — all three answer `""` rather than raising, because this sits
    on the render path and an unreadable convenience store must never stop a song."""
    assert rt.chosen_model("") == ""
    assert rt.chosen_model("cuda:9") == "", "a card the user never touched has no preference"


# Preserve the HTTPError response body because its string form contains only status and reason, not the provider's actionable validation message.

def _http_error(status, body, url="http://127.0.0.1:7683/v1/audio"):
    import io
    import urllib.error
    return urllib.error.HTTPError(url, status, "Bad Request", {}, io.BytesIO(body.encode()))


def test_a_backend_400_carries_its_response_body():
    """FastAPI puts the sentence in `detail`, which is the shape ACE-Step's validator raises."""
    from vocalis.runtime import acerun
    out = str(acerun._with_body(_http_error(400, '{"detail": "absolute audio file paths are not allowed"}')))
    assert "400" in out, "the status still reads"
    assert "absolute audio file paths are not allowed" in out, "and now so does the reason"


def test_the_other_envelope_shape_is_read_too():
    """ACE-Step's own wrapper uses `error` rather than `detail`. Both, or the helper only works
    on whichever endpoint was tested.

    ⚠️ THE `{`/`}` ASSERTION IS THE WHOLE TEST. Written without it, this passed while the `error`
    branch was DELETED — because the raw-text fallback hands back the entire JSON document, and
    that document contains the sentence being searched for. Substring-in-blob is not extraction,
    and mutation-testing is what said so."""
    from vocalis.runtime import acerun
    out = str(acerun._with_body(_http_error(422, '{"error": "model not initialized"}')))
    assert "model not initialized" in out
    assert "{" not in out and "}" not in out, \
        f"the sentence was not EXTRACTED, the raw envelope was pasted in whole: {out!r}"


def test_a_body_that_is_not_json_is_passed_through_as_text():
    """⚠️ A backend behind a proxy answers HTML, and a helper that only understood JSON would go
    back to saying nothing exactly when the cause is furthest away."""
    from vocalis.runtime import acerun
    out = str(acerun._with_body(_http_error(502, "<html><body>Bad Gateway</body></html>")))
    assert "Bad Gateway" in out


def test_a_long_body_is_truncated_rather_than_dumped_on_screen():
    """`job.error` reaches the tray. An HTML error page is a kilobyte of markup and it would all
    land there."""
    from vocalis.runtime import acerun
    out = str(acerun._with_body(_http_error(500, "x" * 5000)))
    assert len(out) < 600, f"the message is {len(out)} characters"


def test_an_empty_body_leaves_the_error_exactly_as_it_was():
    """Nothing to add is not the same as something to add. Returning the original exception keeps
    the type — the caller's `except` clauses still see an HTTPError."""
    import urllib.error
    from vocalis.runtime import acerun
    exc = _http_error(400, "")
    assert acerun._with_body(exc) is exc
    assert isinstance(acerun._with_body(exc), urllib.error.HTTPError)


def test_the_helper_is_actually_ON_the_failure_path(monkeypatch, two_live):
    """Drive a failing backend through run_job and assert the response-body diagnostic reaches the job error shown by the UI. Direct helper tests alone would not catch a disconnected call site."""
    from vocalis.runtime import acerun
    from vocalis.web import acestep as web_ace

    def boom(*_a, **_k):
        raise _http_error(400, '{"detail": "absolute audio file paths are not allowed"}')

    # `acestep.submit` is the POST — the exact call that 400s on a reference clip.
    monkeypatch.setattr(acerun.acestep, "submit", boom)
    monkeypatch.setattr(acerun, "_remember", lambda *a, **k: None)

    job = acerun.jobs.Job(id="j1", docx="", voice="", params=None, gpus="cuda:0",
                          workers=1, kind="acestep")
    acerun.run_job(job, "http://127.0.0.1:7683", "cuda:0", {}, web_ace.QUEUE)
    assert job.status == "failed", "a definitive HTTP rejection must terminate the job"
    assert job.error, "the job recorded no error at all"
    assert "absolute audio file paths are not allowed" in job.error, \
        f"the reason never reached job.error, which is what the tray shows: {job.error!r}"


def test_a_non_http_exception_is_untouched():
    """The helper sits on the general failure path, where most exceptions are not HTTP at all."""
    from vocalis.runtime import acerun
    exc = OSError("connection reset")
    assert acerun._with_body(exc) is exc


# The undo bin retains the most recently discarded batch as one action; a later discard replaces that slot, while new candidate creation leaves it intact.

def _remember(jid, **detail):
    from vocalis.runtime import acecands
    acecands.remember(jid, "done", 1.0, detail or {"device": "cuda:0"})


def test_a_discarded_candidate_goes_to_the_bin_and_comes_back(client):
    from vocalis.runtime import acecands
    _remember("j1")
    _remember("j2")
    assert acecands.forget("j1") is True
    assert [c["id"] for c in acecands.load_all()] == ["j2"], "it left the tray"
    assert acecands.bin_size() == 1, "…and landed in the bin rather than the void"

    assert [r["id"] for r in acecands.undo()] == ["j1"]
    assert sorted(c["id"] for c in acecands.load_all()) == ["j1", "j2"], "it is back"
    assert acecands.bin_size() == 0, "and the bin is empty — Undo is not a duplicator"


def test_the_bin_holds_the_LAST_discard_only(client):
    """🔴 ONE SLOT. Discarding a second candidate replaces the first in the bin — the earlier one
    is gone for good, which is what "undo the last discard" means and why this is an
    accident-catcher rather than a history."""
    from vocalis.runtime import acecands
    _remember("j1")
    _remember("j2")
    acecands.forget("j1")
    acecands.forget("j2")
    assert [r["id"] for r in acecands.undo()] == ["j2"]
    assert [c["id"] for c in acecands.load_all()] == ["j2"], "only the last one comes back"


def test_discard_all_is_ONE_undoable_action(client):
    """🔴 THE SLOT HOLDS A SET, NOT A RECORD. `Discard all` over forty candidates is one press; a
    bin holding a single row would hand back one of forty, which is worse than useless."""
    from vocalis.runtime import acecands
    for i in range(5):
        _remember(f"j{i}")
    assert acecands.forget_all() == 5
    assert acecands.load_all() == []
    assert acecands.bin_size() == 5
    assert len(acecands.undo()) == 5
    assert sorted(c["id"] for c in acecands.load_all()) == [f"j{i}" for i in range(5)]


def test_remembering_a_new_candidate_does_not_empty_the_bin(client):
    """🔴 THE `bin_rows=None` CONTRACT. Every pre-existing caller of `_write` passes candidates
    only; a default of `[]` would have each of them silently clear the recycle bin — an Undo
    button that is empty exactly when it is needed, and nothing would have said so."""
    from vocalis.runtime import acecands
    _remember("j1")
    acecands.forget("j1")
    assert acecands.bin_size() == 1
    _remember("j2")                      # an ordinary render finishing
    assert acecands.bin_size() == 1, "a new candidate must not disturb the bin"
    assert [r["id"] for r in acecands.undo()] == ["j1"]


def test_undo_on_an_empty_bin_is_a_no_op(client):
    from vocalis.runtime import acecands
    assert acecands.undo() == []
    assert acecands.bin_size() == 0


def test_a_file_written_before_the_bin_existed_still_loads(client):
    """⚠️ A MISSING `bin` KEY IS EMPTY, NOT CORRUPT. Every store written before 8.9.10 has no such
    key, and refusing those would turn a new feature into "you have no candidates"."""
    import json
    from vocalis.runtime import acecands
    import vault_fs
    vault_fs.write_json_atomic(acecands._path(), {"candidates": [{"id": "old"}]}, indent=2)
    assert [c["id"] for c in acecands.load_all()] == ["old"]
    assert acecands.bin_size() == 0
    assert json.loads(vault_fs.read_text(acecands._path()))["candidates"][0]["id"] == "old"


def test_the_undo_route_restores_the_row_into_the_live_registry(client, monkeypatch):
    """The store half is only half: the tray reads `jobs.JOBS`, so an undone record has to be put
    back there too or the button empties the bin and shows nothing."""
    from vocalis.runtime import acecands, jobs as rt_jobs
    _remember("j1", device="cuda:0")
    rt_jobs.JOBS.pop("j1", None)
    acecands.forget("j1")

    r = client.post("/acestep/candidates/undo").get_json()
    assert r["restored"] == 1 and r["ids"] == ["j1"] and r["undoable"] == 0
    assert "j1" in rt_jobs.JOBS, "the tray reads JOBS — a store-only restore is invisible"
    assert rt_jobs.JOBS["j1"].kind == "acestep"


def test_discard_all_reports_what_undo_would_put_back(client, monkeypatch):
    """The button is painted from this number, and it must come from the SERVER: the bin survives
    a restart, so a page loaded fresh has no local idea what is in it."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    _remember("j1")
    _remember("j2")
    from vocalis.runtime import jobs as rt_jobs
    for jid in ("j1", "j2"):
        j = rt_jobs.Job(id=jid, docx="", voice="", params=None, gpus="cuda:0", workers=1)
        j.kind, j.status = "acestep", "done"
        rt_jobs.JOBS[jid] = j
    r = client.post("/acestep/candidates/discard_all").get_json()
    assert r["discarded"] == 2
    assert r["undoable"] == 2, "one press, one undoable action, two rows in it"


def test_generate_refuses_when_no_card_is_authorized(client, monkeypatch):
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True, "uses": {"acestep": False}},
                            {"id": "cuda:1", "enabled": True, "uses": {"acestep": False}}])
    r = client.post("/acestep/generate", json={"template": {}})
    assert r.status_code == 501 and "Devices" in r.get_json()["error"]


def test_generate_refuses_when_the_backends_are_down_rather_than_queueing_forever(client,
                                                                                 monkeypatch):
    """⚠️ A song sitting behind a stopped service looks exactly like one that is merely slow.
    Say which it is."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}, {"id": "cuda:1", "enabled": True}])
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": False, "model_loaded": None, "model": None})
    r = client.post("/acestep/generate", json={"template": {}})
    assert r.status_code == 409 and "no authorized ACE-Step card has a loaded, ready model" \
        in r.get_json()["error"]


def test_canceling_a_queued_job_is_exact_and_says_so(client, two_live, monkeypatch):
    """🔴 THE TWO MEANINGS OF CANCEL. A queued job never reached ACE-Step, so removing it is
    exact — `was_running: False`. That is the only honest "canceled" this system has."""
    made = client.post("/acestep/generate", json={"template": {}}).get_json()["jobs"]
    third = client.post("/acestep/generate", json={"template": {}}).get_json()["jobs"][0]
    r = client.post(f"/acestep/jobs/{third['job_id']}/cancel")
    assert r.status_code == 200 and r.get_json()["was_running"] is False
    assert r.get_json()["removed"] is True
    assert made, "the first press should have filled both cards"


def test_canceling_a_submitted_job_stops_waiting_but_keeps_its_reservation(client, two_live):
    """Cancel does not interrupt inference; only a result or confirmed child exit frees the card."""
    from vocalis.web import acestep as web_ace
    made = client.post("/acestep/generate", json={"template": {}}).get_json()["jobs"]
    r = client.post(f"/acestep/jobs/{made[0]['job_id']}/cancel")
    assert r.status_code == 202
    body = r.get_json()
    assert body["was_running"] is True and body["removed"] is False
    assert "does not stop inference" in body["message"]
    assert "Stop or Unload" in body["message"]
    assert web_ace.QUEUE.device_of(made[0]["job_id"]) == made[0]["device"]
    assert jobs_mod.JOBS[made[0]["job_id"]].cancel.is_set()


def test_canceling_a_terminal_job_does_not_relabel_it(client, two_live):
    made = client.post("/acestep/generate", json={"template": {}}).get_json()["jobs"]
    job = jobs_mod.JOBS[made[0]["job_id"]]
    with job.lock:
        job.status = "done"

    response = client.post(f"/acestep/jobs/{job.id}/cancel")

    assert response.status_code == 200
    assert response.get_json()["status"] == "done"
    assert not job.cancel.is_set()


def test_the_jobs_route_reports_queue_position_for_waiting_songs(client, two_live):
    client.post("/acestep/generate", json={"template": {}})
    client.post("/acestep/generate", json={"template": {}})
    rows = client.get("/acestep/jobs").get_json()["jobs"]
    running = [r for r in rows if r["queue_position"] is None]
    waiting = [r for r in rows if r["queue_position"] is not None]
    assert len(running) == 2, "more than one job per card was dispatched"
    assert sorted(r["queue_position"] for r in waiting) == [1, 2]


def test_generate_bumps_the_templates_use_count(client, two_live, tpl_store):
    t = _mk(client, "Counted")
    client.post("/acestep/generate", json={"template": {"name": "Counted"},
                                           "template_id": t["id"]})
    got = client.get("/acestep/templates").get_json()["templates"][0]
    assert got["used"] == 1, "the picker cannot tell which templates are actually reached for"


# ── 8.0-m4: the tick switches a UNIT ─────────────────────────────────────────────────────────

def test_unticking_a_card_STOPS_its_backend_rather_than_only_hiding_it(monkeypatch):
    """Revoking ACE-Step authorization stops only the affected locally owned child."""
    from vocalis.web import ui as web_ui
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True},
                            {"id": "cuda:1", "enabled": True, "uses": {"acestep": False}}])
    stopped = []
    monkeypatch.setattr(rt, "stop_instance", lambda **kw: (
        stopped.append((kw["device"], kw["reason"])), {"ok": True, "state": "stopped"})[1])
    web_ui._stop_unauthorized_acestep()
    assert stopped == [("cuda:1", "feature-disabled")]


def test_the_reconcile_NEVER_starts_a_backend(monkeypatch):
    """Saving unchanged authorization does not start or stop any local child."""
    from vocalis.web import ui as web_ui
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}, {"id": "cuda:1", "enabled": True}])
    ran = []

    monkeypatch.setattr(rt, "stop_instance", lambda **kw: ran.append(kw))
    web_ui._stop_unauthorized_acestep()
    assert ran == []


def test_a_card_switched_off_entirely_also_stops_its_backend(monkeypatch):
    """`enabled: false` outranks the indented tick everywhere else, and it does here too."""
    from vocalis.web import ui as web_ui
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": False}, {"id": "cuda:1", "enabled": True}])
    stopped = []

    monkeypatch.setattr(rt, "stop_instance", lambda **kw: (
        stopped.append((kw["device"], kw["reason"])), {"ok": True, "state": "stopped"})[1])
    web_ui._stop_unauthorized_acestep()
    assert stopped == [("cuda:0", "feature-disabled")]


def test_a_reconcile_failure_does_not_escape_settings_save(monkeypatch):
    from vocalis.web import ui as web_ui
    monkeypatch.setattr("vocalis.web.acestep.disable_unauthorized",
                        lambda: (_ for _ in ()).throw(RuntimeError("state unavailable")))
    web_ui._stop_unauthorized_acestep()          # must not raise


def test_two_inits_for_one_card_do_not_stack(two_live, monkeypatch):
    """A double-click must not fire two 19 GB loads at the same backend."""
    monkeypatch.setattr(rt, "_LOADING", {})
    calls = []
    # 🔴 REBIND THE MODULE'S NAME, NEVER `rt.threading.Thread` — `rt.threading` IS the real
    # stdlib module, so patching its attribute swapped Thread PROCESS-WIDE and any
    # ThreadPoolExecutor built during the window got workers that never run (presents as
    # `worker gwN crashed`). The `two_live` fixture above documents the incident at length and
    # this line was the one remaining instance of the banned spelling.
    thread_api = types.SimpleNamespace(**vars(threading))
    thread_api.Thread = lambda target, name=None, daemon=None: type(
        "T", (), {"start": lambda self: calls.append(name)})()
    monkeypatch.setattr(rt, "threading", thread_api)
    rt.start_init("http://127.0.0.1:7683", "cuda:0", "acestep-v15-xl-sft")
    rt.start_init("http://127.0.0.1:7683", "cuda:0", "acestep-v15-turbo")
    assert len(calls) == 1, "a second init was started while the first was still loading"
    assert rt.loading_model("cuda:0") == "acestep-v15-xl-sft"


# ── 8.0-m22: the status poll heals stranded work, and a job renders with its landing card ────


def test_the_status_poll_re_arms_a_stranded_queued_job(client, two_live):
    """🔴 A registry job at "queued" that the QUEUE does not track had NOTHING left to start it.
    Two real ways to get one: rehydration running while the ACE-Step units were still coming up
    (`_rearm_unfinished` hit `if not live: return` with `_rehydrated` already latched, so its
    promised "next poll" never came), and an untick→re-tick cycle. `_self_heal` on the status
    poll is the fix: it re-offers them against the probes the poll already paid for."""
    started = two_live
    from vocalis.runtime import jobs as jobs_mod
    j = jobs_mod.Job(id="strand-1", docx="", voice="", params=None, gpus="", workers=1)
    j.kind = "acestep"
    j.status = "queued"
    j.detail = {"payload": {"prompt": "x"}, "seed": 1}
    with jobs_mod.JOBS_LOCK:
        jobs_mod.JOBS["strand-1"] = j
    r = client.get("/acestep/status").get_json()
    assert r["available"] is True
    assert [a[0].id for a in started] == ["strand-1"], (
        "the stranded job was not dispatched by the status poll's self-heal")


def test_the_status_poll_pumps_pending_queue_work_onto_a_freed_card(client, two_live):
    """The other stranding: work IN the queue with a free card and no event to pump it —
    `done()` pumped into an empty backend list while both cards were unticked, and re-ticking
    pumps nothing on its own. The status poll now notices pending-plus-free and pumps."""
    started = two_live
    from vocalis.web import acestep as web_ace
    from vocalis.runtime import jobs as jobs_mod
    j = jobs_mod.Job(id="pend-1", docx="", voice="", params=None, gpus="", workers=1)
    j.kind = "acestep"
    j.status = "queued"
    j.detail = {"payload": {"prompt": "x"}, "seed": 2}
    with jobs_mod.JOBS_LOCK:
        jobs_mod.JOBS["pend-1"] = j
    web_ace.QUEUE._pending.append("pend-1")          # queued while no card was available
    client.get("/acestep/status")
    assert [a[0].id for a in started] == ["pend-1"], (
        "pending work sat in the queue with a free live card and the status poll did not pump")


def test_a_job_built_for_a_busy_card_renders_with_the_landing_cards_model(client, two_live):
    """🔴 "Created FOR a named card" is not "runs ON it" — the queue is affinity-free, so with
    cuda:0 mid-song the job built for it dispatches onto cuda:1. Without rebuild it carried 8
    turbo steps onto the xl-sft card (a visibly worse render) and the row's `model` lied about
    what made it. Every generate job now rebuilds at dispatch for the card that takes it."""
    started = two_live
    from vocalis.web import acestep as web_ace
    assert web_ace.QUEUE.claim("someone-elses-song", "cuda:0")
    j = client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}}).get_json()
    assert len(j["jobs"]) == 2                        # both made; only one card could start
    assert len(started) == 1
    job, _url, device, payload, _q = started[0]
    assert device == "cuda:1"
    assert payload["inference_steps"] == 50, (
        f"the job landed on xl-sft but rendered with {payload['inference_steps']} steps — "
        f"it kept the busy card's payload")
    assert job.detail["model"] == "acestep-v15-xl-sft"


# ── 8.0-m24: range answers are CAPPED, so no socket is pinned for the length of a song ───────


def _big_song(monkeypatch, tmp_path, nbytes):
    """One library song whose audio is `nbytes` of addressable bytes."""
    from vocalis.runtime import acelib, paths as rt_paths
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", tmp_path / "ace_library.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", tmp_path / "ace_library")
    data = bytes(range(256)) * (nbytes // 256)
    return acelib.save(data, name="Big"), data


def test_an_open_ended_range_is_answered_in_a_capped_chunk(client, monkeypatch, tmp_path):
    """🔴 THE SOCKET-PINNING BUG (provisional-headers behavior).. werkzeug
    hard-codes Connection: close, so a `bytes=0-` answered with the WHOLE file left every
    preload=metadata player holding a half-read socket as its data source — a few painted rows
    exhausted Chrome's 6-per-origin pool and the next play click queued INSIDE the browser for
    5-10 s. A capped 206 is consumed to its end, so the socket is freed the moment it lands."""
    from vocalis.web import acestep as web_ace
    song, data = _big_song(monkeypatch, tmp_path, web_ace.AUDIO_CHUNK_CAP * 2)
    r = client.get(f"/acestep/library/{song.id}/audio", headers={"Range": "bytes=0-"})
    assert r.status_code == 206
    body = r.get_data()
    assert len(body) == web_ace.AUDIO_CHUNK_CAP, (
        f"an open-ended range must be capped at AUDIO_CHUNK_CAP, got {len(body):,} bytes")
    assert body == data[:web_ace.AUDIO_CHUNK_CAP]
    total = len(data)
    assert r.headers["Content-Range"] == f"bytes 0-{web_ace.AUDIO_CHUNK_CAP - 1}/{total}"


def test_a_seek_reads_one_chunk_not_the_rest_of_the_file(client, monkeypatch, tmp_path):
    """For an open-ended byte range, return at most AUDIO_CHUNK_CAP bytes with the matching Content-Range so a seek does not transfer the remainder of a large file."""
    from vocalis.web import acestep as web_ace
    song, data = _big_song(monkeypatch, tmp_path, web_ace.AUDIO_CHUNK_CAP * 2)
    n = 1024
    r = client.get(f"/acestep/library/{song.id}/audio", headers={"Range": f"bytes={n}-"})
    assert r.status_code == 206
    assert len(r.get_data()) == web_ace.AUDIO_CHUNK_CAP
    assert r.get_data()[:16] == data[n:n + 16]
    assert r.headers["Content-Range"].startswith(f"bytes {n}-")


def test_a_range_past_the_end_is_416_with_the_total(client, monkeypatch, tmp_path):
    song, data = _big_song(monkeypatch, tmp_path, 1024 * 256)
    r = client.get(f"/acestep/library/{song.id}/audio",
                   headers={"Range": f"bytes={len(data) + 10}-"})
    assert r.status_code == 416
    assert r.headers["Content-Range"] == f"bytes */{len(data)}"


def test_a_stale_if_range_gets_the_whole_file_as_200(client, monkeypatch, tmp_path):
    """If the validator no longer matches, a slice of NEW bytes must never be spliced into an
    OLD buffer — the correct answer is the whole current file as a 200."""
    song, data = _big_song(monkeypatch, tmp_path, 1024 * 256)
    r = client.get(f"/acestep/library/{song.id}/audio",
                   headers={"Range": "bytes=0-", "If-Range": '"some-other-validator"'})
    assert r.status_code == 200
    assert r.get_data() == data


# ── 8.1-m1: the reference clip ──────────────────────────────────────────────────────────────
#
# 🔴 THE ONE FAILURE THESE ARE FOR IS SILENT. `process_reference_audio` returns None for anything
# it cannot read and the render then proceeds with no reference and nothing anywhere saying so, so
# every question here is really "does Vocalis notice, when the backend would not?"


def test_a_reference_that_cannot_be_staged_stops_the_press_with_a_message(client, two_live,
                                                                          monkeypatch):
    """🔴 A 400, NOT A QUIET RENDER. Somebody is standing at the button having just pressed it;
    a song that comes back sounding untouched, with the picker still showing the clip they chose,
    is the worst available outcome."""
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestage, "stage_reference",
                        lambda tok: (_ for _ in ()).throw(FileNotFoundError("gone from the library")))
    r = client.post("/acestep/generate",
                    json={"template": dict(_FULL_SONG, reference="stem:gone"), "settings": {}})
    assert r.status_code == 400
    body = r.get_json()
    assert body["error"] == "reference_unavailable"
    assert "gone from the library" in body["message"]


def test_no_reference_never_touches_the_staging_directory(client, two_live, monkeypatch):
    """The overwhelmingly common case. Staging is filesystem work inside the vault mount and it
    must not happen on a press that did not ask for it."""
    from vocalis.web import acestep as web_ace
    calls = []
    monkeypatch.setattr(web_ace.acestage, "stage_reference",
                        lambda tok: (calls.append(tok), "")[1])
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    r = client.post("/acestep/generate", json={"template": _FULL_SONG, "settings": {}})
    assert r.status_code == 202
    assert calls == [""], "asked with the empty token, and the module short-circuits on it"


def test_the_staged_path_reaches_every_cards_payload(client, two_live, monkeypatch):
    """🔴 STAGED ONCE, BEFORE ANY JOB EXISTS. One press makes one job per card and both carry the
    same clip — which is why the staging directory has to be SHARED between the two units rather
    than per-card, and why the file is swept by age instead of deleted when the first job ends."""
    from vocalis.web import acestep as web_ace
    staged = "/ai-output/acestep-tmp/deadbeefdeadbeef.opus"
    monkeypatch.setattr(web_ace.acestage, "stage_reference", lambda tok: staged)
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    r = client.post("/acestep/generate",
                    json={"template": dict(_FULL_SONG, reference="stem:set-a"), "settings": {}})
    assert r.status_code == 202
    made = r.get_json()["jobs"]
    assert len(made) == 2
    for m in made:
        job = jobs_mod.JOBS[m["job_id"]]
        assert job.detail["payload"]["reference_audio_path"] == staged
        # The TOKEN stays on the template so a library row can restore the form; only `detail`
        # carries the resolved path, because an absolute path saved onto a row would rot.
        assert job.detail["template"]["reference"] == "stem:set-a"
        assert job.detail["reference_path"] == staged


def test_a_rebuild_at_dispatch_carries_the_reference_rather_than_restaging(client, two_live,
                                                                          monkeypatch):
    """⚠️ `_dispatch` RUNS INSIDE THE QUEUE'S PUMP AND MUST NOT BLOCK. Every generate job carries
    `rebuild=True`, so the payload is rebuilt for whichever card actually took it — and that
    rebuild cannot do filesystem work. The staged path is card-independent anyway."""
    from vocalis.web import acestep as web_ace
    staged = "/ai-output/acestep-tmp/deadbeefdeadbeef.opus"
    monkeypatch.setattr(web_ace.acestage, "stage_reference", lambda tok: staged)
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    monkeypatch.setattr(web_ace.acestage, "stage",
                        lambda *a, **k: pytest.fail("dispatch must not stage — it blocks the pump"))
    r = client.post("/acestep/generate",
                    json={"template": dict(_FULL_SONG, reference="stem:set-a"), "settings": {}})
    job_id = r.get_json()["jobs"][0]["job_id"]
    job = jobs_mod.JOBS[job_id]
    web_ace._MODEL_BY_URL["http://127.0.0.1:7685"] = "acestep-v15-xl-sft"
    web_ace._dispatch(job_id, "cuda:1", "http://127.0.0.1:7685")
    assert job.detail["payload"]["reference_audio_path"] == staged
    assert job.detail["payload"]["inference_steps"] == 50, "and it really did rebuild for the card"


def test_the_references_route_answers_an_empty_list_when_the_vault_is_shut(client, monkeypatch):
    """⚠️ PAINTED ON TAB LOAD, AND THE STORE IS UNREADABLE UNTIL SOMEONE LOGS IN. A raising route
    would take the whole song form down over a control that is optional by design.

    🔴 AND THE EMPTY LIST IS FLAGGED (8.2.5), because "shut" and "empty" must not share a shape:
    unflagged, a boot that landed in the locked window painted a saved reference as
    "⚠ … no longer in the stems library" over a store that merely was not open yet. The client
    keeps its previous list and retries when it sees `locked`; a plain empty answer still means
    what it says — you have none.
    """
    from vocalis.web import acestep as web_ace

    class _Locked(BaseException):
        pass

    monkeypatch.setattr(web_ace.acestage, "references",
                        lambda: (_ for _ in ()).throw(_Locked("vault is locked")))
    r = client.get("/acestep/references")
    assert r.status_code == 200
    assert r.get_json() == {"references": [], "locked": True}


# ── 8.1-m2a: the words the MODEL rendered, which are not the words that were typed ───────────
#
# 🔴 THINK MODE IS ON BY DEFAULT, so the 5 Hz LM rewrites the caption on ordinary Custom renders
# — and `poll()` kept status/audio/error/progress and dropped `prompt`, `lyrics` and `metas` on
# the floor. Every candidate and library row therefore recorded the REQUEST and called it the
# result. Simple mode needs this; the gap predates it.


def _finish_with(job, monkeypatch, rendered):
    """Drive one job to done through the real `run_job` loop with a stubbed backend poll."""
    from vocalis.runtime import acerun, acestep as rt_ace
    monkeypatch.setattr(rt_ace, "submit", lambda url, payload, timeout=30.0: "task-1")
    monkeypatch.setattr(rt_ace, "poll", lambda url, task_id, timeout=15.0: {
        "status": rt_ace.SUCCEEDED, "audio": ["/tmp/x.flac"], "error": None,
        "progress": None, "song": rendered})

    class _Q:
        def done(self, *a, **k):
            pass
    acerun.run_job(job, "http://127.0.0.1:7683", "cuda:0", job.detail["payload"], _Q())


def test_the_lm_written_song_is_recorded_beside_the_one_that_was_typed(client, two_live,
                                                                       monkeypatch):
    """🔴 BESIDE, NEVER INSTEAD. `template` is what the user set, blanks and all, and clicking a
    library row has to put THAT back — so the rendered words get their own key rather than
    overwriting it. Both facts are worth having: what was asked for is how a row is compared
    against its template, what came back is what the audio actually is."""
    r = client.post("/acestep/generate",
                    json={"template": dict(_FULL_SONG, caption="alt metal"), "settings": {}})
    job_id = r.get_json()["jobs"][0]["job_id"]
    job = jobs_mod.JOBS[job_id]
    _finish_with(job, monkeypatch,
                 {"caption": "alternative metal, driving drums, male vocal",
                  "lyrics": "[verse]\nthe LM wrote this", "bpm": 148, "key_scale": "Am"})

    assert job.detail["rendered"]["caption"] == "alternative metal, driving drums, male vocal"
    assert job.detail["template"]["caption"] == "alt metal", (
        "the submitted caption must survive untouched — it is what the template comparison uses")

    row = next(j for j in client.get("/acestep/jobs").get_json()["jobs"] if j["id"] == job_id)
    assert row["rendered"]["bpm"] == 148, "and the tray can see it"


def test_a_backend_that_reports_no_words_leaves_the_key_absent(client, two_live, monkeypatch):
    """⚠️ `{}` MUST NOT BE WRITTEN AS IF IT WERE AN ANSWER. A model that reported nothing is not
    a model that reported empty strings, and blanking a caption the user typed would be worse
    than saying nothing at all."""
    r = client.post("/acestep/generate", json={"template": _FULL_SONG, "settings": {}})
    job_id = r.get_json()["jobs"][0]["job_id"]
    job = jobs_mod.JOBS[job_id]
    _finish_with(job, monkeypatch, {})
    assert "rendered" not in job.detail


def test_the_rendered_words_reach_the_library_row(client, two_live, lib_store, monkeypatch):
    """The row is the durable record, and it is the one a future session reads to answer "what
    was this song actually made from"."""
    from vocalis.web import acestep as web_ace
    r = client.post("/acestep/generate", json={"template": _FULL_SONG, "settings": {}})
    job_id = r.get_json()["jobs"][0]["job_id"]
    job = jobs_mod.JOBS[job_id]
    _finish_with(job, monkeypatch, {"caption": "what the LM chose", "duration": 212.0})
    job.detail = dict(job.detail, url="http://127.0.0.1:7683")
    monkeypatch.setattr(web_ace.acestep, "fetch_audio", lambda url, path: b"FLACfake")

    saved = client.post(f"/acestep/jobs/{job_id}/save", json={"name": 'Sample Track'})
    assert saved.status_code == 201, saved.get_data(as_text=True)
    row = client.get("/acestep/library").get_json()["songs"][0]
    assert row["rendered"] == {"caption": "what the LM chose", "duration": 212.0}
    assert row["caption"] == _FULL_SONG["caption"], (
        "the SUBMITTED caption still fills `caption` — that contract is pinned elsewhere and "
        "m2a must not change it")


def test_a_row_saved_before_this_release_reads_back_as_None_not_a_crash(lib_store):
    """Every store in this repo has to survive its own history."""
    from vocalis.runtime import acelib
    song = acelib.Song.from_dict({"id": "abc", "name": "Old", "caption": "c", "lyrics": "l"})
    assert song.rendered is None
    assert song.to_dict()["rendered"] is None


# ── 8.1-m2b: the 5 Hz LM on its own, without spending a render ───────────────────────────────


def test_the_lm_writes_a_song_from_a_description_without_rendering(client, two_live, monkeypatch):
    """🔴 THE POINT OF THE MILESTONE. Upstream's Simple mode only produces its words as a side
    effect of a render, so disliking the lyrics costs a full render to discover. This asks the LM
    directly: nothing is queued, no card is taken, and the answer goes into the form."""
    from vocalis.web import acestep as web_ace
    seen = {}
    monkeypatch.setattr(web_ace.acestep, "create_sample",
                        lambda url, **kw: (seen.update(kw), {"caption": "sad piano ballad",
                                                             "lyrics": "[verse]\ndawn",
                                                             "bpm": 72})[1])
    r = client.post("/acestep/compose", json={"query": "a slow sad piano ballad"})
    assert r.status_code == 200
    assert r.get_json()["song"] == {"caption": "sad piano ballad",
                                    "lyrics": "[verse]\ndawn", "bpm": 72}
    assert seen["query"] == "a slow sad piano ballad"
    # ⚠️ Scoped to acestep-kind jobs — the registry is process-wide and `fresh_queue` deliberately
    # leaves other kinds alone, so a whole-registry assert here blames this route for whatever a
    # neighboring FILE on the same xdist worker left mid-flight.
    assert not [j for j in jobs_mod.JOBS.values() if getattr(j, "kind", "") == "acestep"], \
        "writing words must not queue a render"


def test_an_empty_description_is_surprise_me_rather_than_an_error(client, two_live, monkeypatch):
    """`sample_mode` with no query is a real upstream mode — `llm_generation_inputs.py:119` sends
    the literal "NO USER INPUT" for it. Refusing it here would remove a feature the backend has."""
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestep, "create_sample",
                        lambda url, **kw: {"caption": "whatever it felt like"})
    r = client.post("/acestep/compose", json={"query": ""})
    assert r.status_code == 200 and r.get_json()["song"]["caption"]


def test_tidy_up_goes_to_the_format_route_with_what_is_already_typed(client, two_live,
                                                                     monkeypatch):
    """`use_format` is a SEPARATE feature from Simple mode and works on a song you wrote
    yourself — surfaced as its own button rather than buried as a flag inside a render, because
    the whole value is seeing the result and choosing to keep it."""
    from vocalis.web import acestep as web_ace
    seen = {}
    monkeypatch.setattr(web_ace.acestep, "format_input",
                        lambda url, **kw: (seen.update(kw), {"caption": "tidied"})[1])
    r = client.post("/acestep/compose", json={"format": True, "caption": "alt metal",
                                              "lyrics": "[verse]\nrain", "bpm": 148})
    assert r.status_code == 200 and r.get_json()["song"] == {"caption": "tidied"}
    assert seen["caption"] == "alt metal" and seen["metadata"]["bpm"] == 148


def test_the_backends_own_message_survives_to_the_user(client, two_live, monkeypatch):
    """⚠️ "LLM not initialized. Set ACESTEP_INIT_LLM=true in .env to enable" is the entire useful
    content of that failure, and a generic "could not write it" throws it away. 502 rather than
    500: the failure is another machine's."""
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestep, "create_sample", lambda url, **kw: (_ for _ in ()).throw(
        RuntimeError("LLM not initialized. Set ACESTEP_INIT_LLM=true in .env to enable.")))
    r = client.post("/acestep/compose", json={"query": "anything"})
    assert r.status_code == 502
    assert "ACESTEP_INIT_LLM" in r.get_json()["error"]


def test_composing_with_no_backend_running_says_which_button_to_press(client, monkeypatch):
    """The same two answers Generate gives, for the same two situations, in the same words —
    "no card ticked" and "nothing running" have different fixes and must not be one message."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {"up": False, "model_loaded": None,
                                                               "model": None})
    r = client.post("/acestep/compose", json={"query": "x"})
    assert r.status_code == 409 and "Start ACE-Step" in r.get_json()["error"]


def test_an_empty_answer_is_a_502_rather_than_a_form_full_of_nothing(client, two_live,
                                                                     monkeypatch):
    """⚠️ The client writes what comes back straight over the form, so "the LM said nothing" must
    never arrive looking like a successful answer — it would read as the boxes being cleared on
    purpose."""
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestep, "create_sample", lambda url, **kw: {})
    r = client.post("/acestep/compose", json={"query": "x"})
    assert r.status_code == 502


# ── 8.1-m3: the mode list's authority, and what a source mode can work from ──────────────────


def test_the_mode_list_comes_from_the_backends_own_capability_map(client, monkeypatch):
    """🔴 `supported_task_types`, PER MODEL, AND NEVER GRADIO'S RULE (design §3A).

    Gradio picks its mode list with `is_pure_base_model(config_path_lower)` — it sniffs the model's
    PATH NAME — and it is demonstrably wrong on the checkpoint in production: it drops
    `acestep-v15-xl-sft` into the four-mode TURBO list while the backend reports that same model
    supporting all seven. Copying that would hide three working modes from the only card that can
    run them. A name-sniffing heuristic is not a capability check.

    SUPERSEDED October 11, 2026 (the half about xl-sft; the rule that the page never sniffs a name
    still holds): the backend's "all seven" for xl-sft is an `is_turbo` check on a config.json that
    xl-sft shares byte for byte with xl-base. The publisher lists Extract, Lego and Complete for
    xl-base alone (model card: xl-sft is "Standard"), so the server narrows each model's list to the
    publisher's by NAME (`acegen.PUBLISHED_TASKS`) and the route answers the narrowed list. What the
    backend reports is still the starting point: a model the table does not know keeps it.
    """
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "_get", lambda url, path, timeout=10.0: {
        "models": [{"name": "acestep-v15-xl-sft",
                    "supported_task_types": ["text2music", "repaint", "cover", "cover-nofsq",
                                             "extract", "lego", "complete"]},
                   {"name": "acestep-v15-xl-base",
                    "supported_task_types": ["text2music", "repaint", "cover", "cover-nofsq",
                                             "extract", "lego", "complete"]},
                   {"name": "acestep-v15-turbo",
                    "supported_task_types": ["text2music", "repaint", "cover", "cover-nofsq"]},
                   {"name": "acestep-v15-unlisted",
                    "supported_task_types": ["text2music", "extract"]}],
        "default_model": "acestep-v15-xl-sft"})
    got = client.get("/acestep/models").get_json()["backends"]["cuda:0"]
    assert got["tasks"]["acestep-v15-xl-base"] == [
        "text2music", "repaint", "cover", "cover-nofsq", "extract", "lego", "complete"]
    assert got["tasks"]["acestep-v15-xl-sft"] == ["text2music", "repaint", "cover", "cover-nofsq"]
    assert got["tasks"]["acestep-v15-turbo"] == ["text2music", "repaint", "cover", "cover-nofsq"]
    assert got["tasks"]["acestep-v15-unlisted"] == ["text2music", "extract"], "unknown keeps the engine's answer"
    # The page names the model to load from this map; only xl-base is listed for the three editing tasks.
    assert got["task_models"]["extract"] == ["acestep-v15-xl-base"]
    assert got["task_models"]["lego"] == ["acestep-v15-xl-base"]
    assert got["task_models"]["complete"] == ["acestep-v15-xl-base"]
    assert "acestep-v15-xl-base" in got["task_models"]["text2music"]


def test_a_model_reporting_no_task_types_gets_an_empty_list_not_a_guess(client, monkeypatch):
    """⚠️ `task_type` is a bare `str` on the request model, so an unsupported value is not refused
    at the door — it fails deeper or quietly. Inventing a default mode list for a model that did
    not answer is exactly how one gets offered."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "_get", lambda url, path, timeout=10.0: {
        "models": [{"name": "mystery-model"}], "default_model": "mystery-model"})
    assert client.get("/acestep/models").get_json()["backends"]["cuda:0"]["tasks"] == {
        "mystery-model": []}


def test_a_down_backend_reports_no_task_types_rather_than_erroring(client, monkeypatch):
    """The row still has to render — it is the row that offers to start the service."""
    _two_installed(monkeypatch)
    _settings(monkeypatch, [{"id": "cuda:0", "enabled": True}])
    monkeypatch.setattr(rt, "_get", lambda url, path, timeout=10.0: (_ for _ in ()).throw(OSError()))
    got = client.get("/acestep/models").get_json()["backends"]["cuda:0"]
    assert got["reachable"] is False and got["tasks"] == {}


@pytest.mark.parametrize("mode,label", [("extract", "Extract"), ("lego", "Replace"), ("complete", "Complete")])
def test_an_editing_mode_is_refused_with_the_model_to_load_when_only_turbo_and_xl_sft_are_loaded(
        client, two_live, monkeypatch, mode, label):
    """🔴 October 11, 2026. Extract, Replace and Complete run only on the model the publisher lists for
    them, `acestep-v15-xl-base`. With turbo and xl-sft loaded (the engine itself claims xl-sft can run
    all three: its config.json is the one xl-base ships) the press is refused with one plain sentence
    naming the model, and no job is made."""
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    monkeypatch.setattr(web_ace.acestage, "stage_source", lambda tok: "/ai-output/acestep-tmp/ab.flac")
    r = client.post("/acestep/generate",
                    json={"template": dict(_FULL_SONG, mode=mode, source="song:abc"), "settings": {}})
    assert r.status_code == 409, r.get_data(as_text=True)
    j = r.get_json()
    assert j["error"] == "mode_unsupported"
    assert j["message"].startswith(f"{label} needs the acestep-v15-xl-base model. Load it from a card's model menu"), \
        j["message"]
    assert not [x for x in jobs_mod.JOBS.values() if getattr(x, "kind", "") == "acestep"], \
        "a refused press must not leave a job behind"


def test_an_editing_mode_is_accepted_only_for_the_card_holding_xl_base(client, two_live, monkeypatch):
    """The other half: with xl-base loaded on cuda:1 and turbo on cuda:0, Extract makes ONE job, on
    cuda:1, carrying task_type extract and xl-base's own 50 steps. Normal generation still makes a job
    per card (see test_generate_makes_one_job_per_live_card, which runs turbo and xl-sft)."""
    from vocalis.web import acestep as web_ace
    models = {"7683": "acestep-v15-turbo", "7685": "acestep-v15-xl-base"}
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": models[url[-4:]]})
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    monkeypatch.setattr(web_ace.acestage, "stage_source", lambda tok: "/ai-output/acestep-tmp/ab.flac")
    r = client.post("/acestep/generate",
                    json={"template": dict(_FULL_SONG, mode="extract", source="song:abc"), "settings": {}})
    assert r.status_code == 202, r.get_data(as_text=True)
    made = r.get_json()["jobs"]
    assert [m["device"] for m in made] == ["cuda:1"]
    p = jobs_mod.JOBS[made[0]["job_id"]].detail["payload"]
    assert p["task_type"] == "extract" and p["inference_steps"] == 50


def test_the_dispatch_gate_follows_the_publishers_table_with_or_without_an_inventory():
    """`_url_can_task` is what the queue asks before a free card takes a job. xl-sft refuses the three
    editing tasks whether the cache holds nothing yet (a card nobody has pressed Generate on), holds the
    engine's raw all-seven list, or holds the narrowed list; xl-base accepts them; a model the table does
    not know keeps the old rule (no inventory = yes, else the engine's list)."""
    from vocalis.web import acestep as web_ace
    url = "http://127.0.0.1:7685"
    every = ["text2music", "repaint", "cover", "cover-nofsq", "extract", "lego", "complete"]
    try:
        for cache in ({}, {url: {"acestep-v15-xl-sft": every}},
                      {url: {"acestep-v15-xl-sft": ["text2music", "repaint", "cover", "cover-nofsq"]}}):
            web_ace._TASKS_BY_URL.clear()
            web_ace._TASKS_BY_URL.update(cache)
            web_ace._MODEL_BY_URL[url] = "acestep-v15-xl-sft"
            for task in ("extract", "lego", "complete"):
                assert not web_ace._url_can_task(url, task), (cache, task)
            for task in ("text2music", "cover", "repaint"):
                assert web_ace._url_can_task(url, task), (cache, task)
        web_ace._TASKS_BY_URL.clear()
        web_ace._MODEL_BY_URL[url] = "acestep-v15-xl-base"
        assert all(web_ace._url_can_task(url, t) for t in every)
        web_ace._MODEL_BY_URL[url] = "acestep-v15-unlisted"
        assert web_ace._url_can_task(url, "extract"), "unknown model, no inventory: the old permissive rule"
        web_ace._TASKS_BY_URL[url] = {"acestep-v15-unlisted": ["text2music"]}
        assert not web_ace._url_can_task(url, "extract") and web_ace._url_can_task(url, "text2music")
    finally:
        web_ace._TASKS_BY_URL.clear()
        web_ace._MODEL_BY_URL.clear()


def test_a_source_mode_with_no_source_is_refused_rather_than_rendered(client, two_live,
                                                                      monkeypatch):
    """🔴 THE DESIGN'S §5 FAILURE SHAPE, STATED AS A RULE. `task_type: "cover"` with an empty
    `src_audio_path` produces a perfectly ordinary text2music song, with nothing anywhere saying
    the remix did not happen — found by LISTENING, which is the most expensive way to find
    anything. So the press stops with a sentence."""
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    # October 11, 2026: Extract, Replace and Complete are only offered to a card holding xl-base (the
    # capability check comes before the source check), so the second card holds it here.
    models = {"7683": "acestep-v15-turbo", "7685": "acestep-v15-xl-base"}
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": models[url[-4:]]})
    for mode in ("remix", "remix-nofsq", "repaint", "extract", "lego", "complete"):
        r = client.post("/acestep/generate",
                        json={"template": dict(_FULL_SONG, mode=mode), "settings": {}})
        assert r.status_code == 400, f"{mode} rendered without a source"
        assert r.get_json()["error"] == "source_required"
    # Scoped to acestep-kind, same reason as the compose test above: the registry is shared
    # with whatever else this xdist worker ran.
    assert not [j for j in jobs_mod.JOBS.values() if getattr(j, "kind", "") == "acestep"], \
        "a refused press must not leave a job behind"


def test_custom_and_simple_need_no_source(client, two_live, monkeypatch):
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    for mode in ("custom", "simple"):
        r = client.post("/acestep/generate",
                        json={"template": dict(_FULL_SONG, mode=mode), "settings": {}})
        assert r.status_code == 202, f"{mode} was refused and should not have been"


def test_the_staged_source_reaches_every_cards_payload_with_the_mode(client, two_live,
                                                                     monkeypatch):
    from vocalis.web import acestep as web_ace
    staged = "/ai-output/acestep-tmp/feedfacefeedface.flac"
    monkeypatch.setattr(web_ace.acestage, "stage_source", lambda tok: staged)
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    r = client.post("/acestep/generate",
                    json={"template": dict(_FULL_SONG, mode="repaint", source="song:abc",
                                           repaint_start=30, repaint_end=48.5),
                          "settings": {}})
    assert r.status_code == 202, r.get_data(as_text=True)
    for m in r.get_json()["jobs"]:
        p = jobs_mod.JOBS[m["job_id"]].detail["payload"]
        assert p["src_audio_path"] == staged
        assert p["task_type"] == "repaint"
        assert p["repainting_start"] == 30.0 and p["repainting_end"] == 48.5


def test_a_source_that_has_gone_stops_the_press_with_the_reason(client, two_live, monkeypatch):
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestage, "stage_source", lambda tok: (_ for _ in ()).throw(
        FileNotFoundError("that candidate is gone — candidates do not survive a restart")))
    r = client.post("/acestep/generate",
                    json={"template": dict(_FULL_SONG, mode="remix", source="cand:j1"),
                          "settings": {}})
    assert r.status_code == 400
    assert r.get_json()["error"] == "source_unavailable"
    assert "do not survive" in r.get_json()["message"]


def test_the_sources_route_answers_an_empty_list_when_the_vault_is_shut(client, monkeypatch):
    """Same rule as `/acestep/references`: painted on tab load, and the store is unreadable until
    someone logs in. A raising route would take the song form down with it."""
    from vocalis.web import acestep as web_ace

    class _Locked(BaseException):
        pass
    monkeypatch.setattr(web_ace.acestage, "sources",
                        lambda: (_ for _ in ()).throw(_Locked("vault is locked")))
    r = client.get("/acestep/sources")
    # `locked` flagged, same contract as the references twin above (8.2.5).
    assert r.status_code == 200 and r.get_json() == {"sources": [], "locked": True}


def test_the_track_picks_survive_a_template_round_trip(client, two_live):
    """m4: `tracks` is on the template because it is part of what the song IS — "the bassline of
    this song" is a different song from "the vocal of this song"."""
    r = client.post("/acestep/templates",
                    json={"name": "Strip it", "mode": "complete", "tracks": ["guitar", "bass"],
                          "source": "song:abc"})
    assert r.status_code == 201
    got = r.get_json()
    assert got["tracks"] == ["guitar", "bass"]
    assert got["mode"] == "complete" and got["source"] == "song:abc"

    back = client.get("/acestep/templates").get_json()["templates"]
    assert [t for t in back if t["id"] == got["id"]][0]["tracks"] == ["guitar", "bass"]


def test_a_template_saved_before_m4_reads_back_with_no_tracks(client):
    """Every store in this repo has to survive its own history."""
    from vocalis.runtime import acetemplates
    t = acetemplates.SongTemplate.from_dict({"id": "x", "name": "Old"})
    assert t.tracks == [] and t.mode == "custom"
    assert t.to_dict()["tracks"] == []


# ── 8.1-m6: LoRA is the CARD's state, not the song's ────────────────────────────────────────


def test_lora_is_not_a_payload_field_because_there_is_no_such_field(client, two_live,
                                                                    monkeypatch):
    """🔴 THE CORRECTION THIS MILESTONE IS. Design §9 lists `use_lora`, `lora_path` and
    `lora_scale` under "Advanced — what is missing", i.e. as three per-render payload fields.
    Measured on remote host: `lora` appears NOWHERE on the request model, nowhere in the alias table and
    nowhere in `job_generation_setup.py`. Sending them would post three keys the builder never
    reads — landmine #1's silent no-op, wearing a feature's clothes."""
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestage, "sweep", lambda *a, **k: 0)
    r = client.post("/acestep/generate",
                    json={"template": _FULL_SONG,
                          "settings": {"use_lora": True, "lora_path": "/x", "lora_scale": 0.7}})
    p = jobs_mod.JOBS[r.get_json()["jobs"][0]["job_id"]].detail["payload"]
    for k in ("use_lora", "lora_path", "lora_scale"):
        assert k not in p, f"{k} was sent as a render parameter and no such parameter exists"


def test_the_lora_status_of_an_unknown_card_is_a_state_not_a_500(client, two_live):
    """The card row has to render whatever is going on, and it is the row that offers the fix."""
    r = client.get("/acestep/lora/cuda:9")
    assert r.status_code == 200
    assert r.get_json()["reachable"] is False and r.get_json()["loaded"] is False


def test_each_lora_verb_reaches_its_own_card(client, two_live, monkeypatch):
    from vocalis.web import acestep as web_ace
    seen = []
    monkeypatch.setattr(web_ace.acestep, "lora_load",
                        lambda url, path, **kw: (seen.append(("load", url, path)), {"ok": 1})[1])
    monkeypatch.setattr(web_ace.acestep, "lora_unload",
                        lambda url, **kw: (seen.append(("unload", url)), {"ok": 1})[1])
    monkeypatch.setattr(web_ace.acestep, "lora_toggle",
                        lambda url, on, **kw: (seen.append(("toggle", url, on)), {"ok": 1})[1])
    monkeypatch.setattr(web_ace.acestep, "lora_scale",
                        lambda url, sc, **kw: (seen.append(("scale", url, sc)), {"ok": 1})[1])
    monkeypatch.setattr(web_ace.acestep, "lora_status", lambda url, **kw: {"loaded": True})

    assert client.post("/acestep/lora/cuda:1",
                       json={"action": "load", "lora_path": "/models/a.safetensors"}
                       ).status_code == 200
    assert client.post("/acestep/lora/cuda:0", json={"action": "unload"}).status_code == 200
    assert client.post("/acestep/lora/cuda:0",
                       json={"action": "toggle", "use_lora": False}).status_code == 200
    assert client.post("/acestep/lora/cuda:0",
                       json={"action": "scale", "scale": 0.35}).status_code == 200

    assert seen[0] == ("load", "http://127.0.0.1:7685", "/models/a.safetensors"), (
        "cuda:1's request must reach cuda:1's backend, not the first one in the list")
    assert seen[1][1] == "http://127.0.0.1:7683"
    assert seen[2] == ("toggle", "http://127.0.0.1:7683", False), (
        "an explicit False must survive — it is the interesting value of a toggle")
    assert seen[3][2] == 0.35


def test_loading_an_adapter_with_no_path_is_refused_before_the_round_trip(client, two_live):
    r = client.post("/acestep/lora/cuda:0", json={"action": "load", "lora_path": "  "})
    assert r.status_code == 400


def test_an_unknown_lora_verb_is_a_400_and_never_an_attribute_lookup(client, two_live):
    """⚠️ Dispatching by name off the request would turn a typo into whatever `acestep` happens to
    have called that — a route that executes arbitrary module attributes. Validated against a
    table instead."""
    r = client.post("/acestep/lora/cuda:0", json={"action": "poll"})
    assert r.status_code == 400 and "unknown lora action" in r.get_json()["error"]


def test_the_backends_own_reason_survives_a_failed_lora_call(client, two_live, monkeypatch):
    """"Model not fully initialized" is the whole useful content of that failure and it names the
    fix. Every one of these routes calls `_require_initialized_handler`, so it is the ordinary
    failure rather than an exotic one."""
    from vocalis.web import acestep as web_ace
    monkeypatch.setattr(web_ace.acestep, "lora_unload", lambda url, **kw: (_ for _ in ()).throw(
        RuntimeError("Model not fully initialized")))
    r = client.post("/acestep/lora/cuda:0", json={"action": "unload"})
    assert r.status_code == 502 and "not fully initialized" in r.get_json()["error"]

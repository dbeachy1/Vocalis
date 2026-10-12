"""3.0-M4: the ST extension's player talking to the real server (Node smoke).

Runs the ACTUAL sillytavern/extension/vocalis-stream.js under Node against a real
werkzeug HTTP server running the real stream blueprint — real sockets, real chunked
progressive-MP3 through real ffmpeg; only generation (fake PCM) and the browser
audio sink (fake Audio/no MediaSource -> blob path) are stubbed. Covers the code
that is NEW in the ST port — register POST, /v1 error-shape parsing, cross-origin
URL resolution, /status truncation check, retry closure — the MediaSource pump
branch is the field-proven Nomi recipe and is exercised only in the browser.

Skips when node isn't installed. The Node-side checks live in st_player_smoke.mjs.
"""
import shutil
import subprocess

from conftest import assert_spec_ran
import sys
import threading
from pathlib import Path

import numpy as np
import pytest
from flask import Flask, jsonify, request

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import mp3_render                                          # noqa: E402
import vocalis_stream_http as vsh                          # noqa: E402
from nomi_speak import NomiSpeaker                         # noqa: E402
from st_characters import StCharacterRegistry, create_st_blueprint  # noqa: E402

NODE = shutil.which("node")
SR = 24000


class FakePool:
    sr = SR


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_st_player_talks_to_server(tmp_path, monkeypatch):
    vdir = tmp_path / "voice_samples"
    vdir.mkdir()
    (vdir / "v.wav").write_bytes(b"RIFFfake")
    settings = tmp_path / "voice_settings.yaml"
    settings.write_text("nomi:\n  default_voice: v.wav\n", encoding="utf-8")
    nomi = NomiSpeaker(settings, vdir, tmp_path / "cache")

    # 7.0-m6: the pairing bearer rides every /v1 call. This server has no gate (the gate's own
    # test is test_auth_surface.py); what is recorded here is what the CLIENT actually put on
    # the wire — the half no server-side test can see.
    TOKEN = "smoke-pairing-token-0123456789"
    v1_auth = []          # Authorization header of every /v1/* request
    speak_auth = []       # ...and of every /speak/stream/<token> GET (must stay bare — §2.2)

    def fake_stream_message(pool, text, params, config=None, cancel=None, **kw):
        for j in range(3):
            if "BOOM" in text and j == 2:                  # the truncation case
                raise RuntimeError("gen boom mid-stream")
            yield np.ones(12000, dtype=np.float32) * 0.1
    # 5.2: generation lives in mp3_render.Mp3Render now. Patching `vsh` still
    # "succeeds" and silently stops taking effect — which would point this smoke at
    # the REAL chatterbox pool with a FakePool underneath it.
    monkeypatch.setattr(mp3_render, "stream_message", fake_stream_message)

    def resolve_voice(name):
        stem = Path(Path(name).name).stem.lower()
        matches = [f for f in vdir.iterdir() if f.is_file() and f.stem.lower() == stem]
        return matches[0] if matches else None

    # character registry with one pre-assigned character (the smoke's happy path
    # narrates as her, proving the character->voice resolution over the wire)
    streg = StCharacterRegistry(settings)
    streg.replace({'Test Character': {"voice": "v.wav", "exaggeration": 0.9}})

    app = Flask(__name__)
    app.register_blueprint(vsh.create_stream_blueprint(
        lambda: FakePool(), nomi, voice_dir=vdir,
        resolve_voice=resolve_voice, st_registry=streg))
    app.register_blueprint(create_st_blueprint(streg))

    @app.before_request
    def _record_auth():
        if request.path.startswith("/v1/"):
            v1_auth.append(request.headers.get("Authorization", ""))
        elif request.path.startswith("/speak/stream/"):
            speak_auth.append(request.headers.get("Authorization", ""))

    # The two server routes the extension's settings panel uses (prod contract).
    @app.route("/health")
    def health():
        return jsonify({"status": "ok", "product": "Vocalis", "version": "smoke",
                        "model_ready": True})

    @app.route("/v1/audio/voices")
    def voices():
        return jsonify({"voices": [f.stem for f in sorted(vdir.iterdir())]})

    from werkzeug.serving import make_server
    srv = make_server("127.0.0.1", 0, app, threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        r = subprocess.run(
            [NODE, str(Path(__file__).parent / "st_player_smoke.mjs"),
             f"http://127.0.0.1:{srv.server_port}",
             str(Path(__file__).parent.parent / "sillytavern" / "extension"
                 / "vocalis-stream.js"),
             TOKEN],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=120)
        # 🔴 m6 — the bearer ARRIVED, on every /v1 request, in the exact shape the gate parses.
        # "The client looks right and the server looks right" is precisely the state in which
        # the header never actually crosses; this is the wire truth.
        assert v1_auth and all(h == f"Bearer {TOKEN}" for h in v1_auth), (
            f"/v1 requests did not all carry the bearer: {sorted(set(v1_auth))}")
        # …and the /speak/stream/<token> capability GETs stayed BARE. Their credential is the
        # 122-bit token in the path (§2.2 — "do not 'fix' it"), and sending the pairing bearer
        # there would put the long-lived secret on a family that stays open through m6.
        assert speak_auth and all(h == "" for h in speak_auth), (
            f"the capability-URL GETs must not carry the pairing bearer: {sorted(set(speak_auth))}")
        # A skipped section exits 0 just as happily as a passing one. Name the check
        # that 5.2 hangs on, so "the smoke is green" cannot come to mean "the smoke
        # quietly stopped testing the thing".
        assert "prerender and stream agree on the cache key" in r.stdout, \
            f"the 5.2 key-identity check did not run:\n{r.stdout}"
        # 5.4's two, for the same reason: the probe agreeing on the key is what makes the
        # color describe the entry a click looks up, and "queued nothing" is the whole
        # reason /v1/audio/state exists instead of a call to /v1/audio/prerender.
        for named in ("the probe and the render agree on the cache key",
                      "the probe queued nothing"):
            assert named in r.stdout, f"the 5.4 check {named!r} did not run:\n{r.stdout}"
        # m6's two: the error-info contract that routes §6.2's guidance. `auth` on a locked 401
        # would rotate a working credential; `locked` on a rejected one would hide the fix.
        for named in ("a locked 401 reports locked, never auth",
                      "a token-rejected 401 reports auth, never locked"):
            assert named in r.stdout, f"the m6 check {named!r} did not run:\n{r.stdout}"
    finally:
        srv.shutdown()


# ── 5.4: the button's color ─────────────────────────────────────────────────────
# ⚠️ SOURCE CHECKS, NOT A RENDERING. A regex over markup cannot see a color, and this
# repo has been burned by exactly that before — markup-regex and Flask test-client tests
# both passed while the player was visibly broken in the browser. These catch the traps
# that ARE visible in the source (a state with no class, a specificity inversion, an
# unwired event); DESIGN_5_4_BUTTON_STATE.md m4 is the browser QA, and it is not optional.

EXT = Path(__file__).parent.parent / "sillytavern" / "extension"


def test_every_server_state_maps_to_a_color():
    """The route answers with five states. A state the client has no branch for paints
    nothing and reads as orange — i.e. 'the server has nothing', which for `playable` or
    `cached` is the opposite of the truth."""
    js = (EXT / "index.js").read_text(encoding="utf-8")
    block = js.split("const CLASS_FOR")[1].split("};")[0]
    for state in ("cached", "playable", "rendering", "queued"):
        assert f"{state}:" in block, f"the client has no color for {state!r}"
    # `none` is deliberately absent: orange is the ABSENCE of a class, so that a server
    # which is down leaves the buttons exactly as they look today.
    assert "none:" not in block
    for cls in ("vocalis_pending", "vocalis_ready", "vocalis_cached"):
        assert cls in js and cls in (EXT / "style.css").read_text(encoding="utf-8")


def test_the_state_colors_outrank_the_hover_rule():
    """🔴 `.vocalis_narrate:hover` and `.vocalis_narrate.vocalis_cached` have the SAME
    specificity (0,2,0), so source order alone decides which wins. Move the state rules
    above the hover rule and every colored button turns orange under the pointer — while
    every test that does not use a mouse goes on passing."""
    css = (EXT / "style.css").read_text(encoding="utf-8")
    hover = css.index(".vocalis_narrate:hover")
    for cls in ("vocalis_pending", "vocalis_ready", "vocalis_cached"):
        assert css.index(f".vocalis_narrate.{cls} ") > hover, \
            f".{cls} must come AFTER the plain :hover rule or hover repaints it"


def test_the_band_and_the_red_square_are_wired_at_BOTH_ends():
    """9.1 §1 — index.js applies two classes, style.css paints them, and NOTHING else joins
    the two files. The browser specs each prove one half in isolation: st_button_state_spec
    watches the classes land on the DOM, st_button_colors_spec asks Chrome what they paint on
    a hand-built row. Neither can see the pair drifting apart at the ELEMENT they are hung on —
    the band goes on `.mes` and the red on the button inside it, and a version that put the band
    on `.ch_name` instead would leave both files still containing both names."""
    js = (EXT / "index.js").read_text(encoding="utf-8")
    css = (EXT / "style.css").read_text(encoding="utf-8")
    # the ROW wears the band …
    assert "row.toggleClass('vocalis_speaking'" in js
    assert "#chat .mes.vocalis_speaking .ch_name" in css, \
        "the band must be selected on `.mes` and painted on ST's `.ch_name` header strip"
    # … and the BUTTON inside it wears the red.
    assert ".vocalis_narrate').toggleClass('vocalis_audible'" in js
    assert "#chat .mes.vocalis_speaking .vocalis_narrate.vocalis_audible" in css


def test_red_is_defined_only_on_the_band():
    """🔴 The red stop square must never occur off a yellow band, because it is the NARROWER
    of the two markers: band = "this message is loaded", red = "…and audible right now". A rule
    that painted `.vocalis_audible` red on its own would put a color on screen that says
    "playing" in a place where nothing says WHICH message — which is the state 9.1 exists to
    end. Cheap to state here and invisible to a browser spec, which can only ask about the
    combinations its fixture happens to build."""
    css = (EXT / "style.css").read_text(encoding="utf-8")
    rules = [ln for ln in css.splitlines()
             if "vocalis_audible" in ln and "{" in ln and not ln.lstrip().startswith("*")]
    assert rules, "no rule paints .vocalis_audible at all — the red square is dead CSS"
    for ln in rules:
        assert "vocalis_speaking" in ln, \
            f"`.vocalis_audible` is painted off the band, which cannot happen in the app:\n  {ln}"


def test_playing_no_longer_recolors_the_button():
    """Color is the render state; the glyph is playback. `.vocalis_playing` used to force
    red, which would overwrite the very state 5.4 exists to show."""
    css = (EXT / "style.css").read_text(encoding="utf-8")
    playing = css.split(".vocalis_narrate.vocalis_playing")[1].split("}")[0]
    assert "color:" not in playing, "the playing state must not set a color (§2)"


def test_every_path_that_paints_a_message_is_wired():
    """SillyTavern paints a whole batch on chat load and on each scroll-back, and neither
    fires a per-message event. Miss them and the older messages — the ones most likely to
    be cached — keep their buttons and never get a color."""
    js = (EXT / "index.js").read_text(encoding="utf-8")
    for ev in ("CHAT_LOADED", "MORE_MESSAGES_LOADED", "CHARACTER_MESSAGE_RENDERED",
               "USER_MESSAGE_RENDERED", "MESSAGE_EDITED", "MESSAGE_UPDATED"):
        assert f"event_types.{ev}" in js, f"{ev} is not wired — see §6.1/§6.3"


def test_all_three_routes_are_handed_the_same_body():
    """The probe, the pre-render and the click must put the SAME bytes on the wire, or the
    server derives different cache keys and the color describes an entry nothing looks up.
    One helper builds it; nothing else may hand-roll one."""
    js = (EXT / "index.js").read_text(encoding="utf-8")
    assert js.count("input: text, character:") == 1, \
        "a second hand-built request body appeared — route it through bodyFor()"


def test_the_long_press_branches_on_the_color():
    """m3: hold-to-re-render on orange/green, hold-to-CANCEL on yellow/blue. A gesture that
    always renders would make 'skip this pre-render' impossible, which is the whole feature."""
    js = (EXT / "index.js").read_text(encoding="utf-8")
    up = js.split("$(document).on('pointerup'")[1].split("});")[0]
    assert "cancelGesture(mesId)" in up and "narrateMessage(mesId, true)" in up, \
        "the release handler must choose between canceling and forcing"
    assert "cancellable(mesId)" in up, "…and it must choose on the CURRENT color"


def test_a_playing_blue_button_can_still_arm():
    """A blue button that is playing may still arm the requested action. Guard only the gesture-specific state, not the shared button state."""
    js = (EXT / "index.js").read_text(encoding="utf-8")
    assert "current.mesId === mesId && !cancellable(mesId)) return" in js, \
        "the playing guard must yield when there is something to cancel"


def test_the_cancel_stops_the_listener_before_the_producer():
    """🔴 Order is load-bearing. A click on a blue message FOLLOWS the producer's spool, so
    killing the producer first ends the stream underneath a listener that is still watching —
    and a deliberate skip surfaces as 'playback stopped early — Retry?'. Stopping the handle
    first marks it stopped, so the truncation check never runs."""
    js = (EXT / "index.js").read_text(encoding="utf-8")
    body = js.split("function cancelGesture")[1].split("\n}")[0]
    assert body.index("stopCurrent()") < body.index("cancelPrerenderFor"), \
        "stopCurrent() must precede the cancel POST"


def test_un_arming_does_not_strip_a_playing_button():
    """endPress used to force the speaker glyph back. Since the gesture can now arm on a
    message that is playing, that would leave a stop button that is not a stop button."""
    js = (EXT / "index.js").read_text(encoding="utf-8")
    assert "function restoreBtn" in js
    restore = js.split("function restoreBtn")[1].split("\n}")[0]
    assert "current.mesId === mesId ? 'playing' : 'idle'" in restore


def test_the_scene_poll_no_longer_branches_on_a_state_that_cannot_happen():
    """6.3 §8.6. A build no longer enhances, so `enhancing` is not a status the server can
    report and `enhanced_ref` is not a field it can send. Both were live branches here — the
    poll printed *"Scene built — enhancing… (cancel keeps the un-enhanced one)"* and the success
    toast chose between two messages on `st.enhanced_ref`.

    🔴 Dead client branches on a removed server state are not harmless: this one describes a
    cancel that "keeps the un-enhanced one" to a user whose cancel now does something else
    entirely, and it would have gone on reading as correct because the branch simply never
    fires. Asserted on the SOURCE, because nothing observable is left to drive.
    """
    js = (EXT / "index.js").read_text(encoding="utf-8")
    assert "'enhancing'" not in js and '"enhancing"' not in js, \
        "the poll still has a branch for a status the server cannot report"
    assert "enhanced_ref" not in js, "the success toast still branches on a field that is gone"
    assert "enhance_unavailable" not in js, \
        "the 202 no longer carries this — the build does not enhance"


# ── 7.0-m2: the pairing token, over the wire ─────────────────────────────────────
#
# 🔴 THE TWO HALVES OF A CREDENTIAL ARE AGREED ON BY NOBODY. `test_pair_surface.py` proves the
# server refuses an unauthenticated caller; the browser specs stub the transport entirely. Neither
# can see whether the EXTENSION sends a header this server accepts — and "both sides look right"
# is precisely the state in which the bearer never actually arrives. This runs the real,
# unmodified `vocalis-stream.js` against the real `/pair/*` blueprint over a real socket.
@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_the_extension_pairs_with_the_real_gate(monkeypatch):
    """The extension's `pairPing` against the real bearer gate, including the empty-token case."""
    from wbedit import pairing
    from vocalis.web.pair import create_pair_blueprint

    TOKEN = "a-real-looking-token_0123456789"
    # The STORAGE is `test_pair_surface.py`'s subject and needs a vault; what is under test here
    # is the gate and the client. `verify()` itself is left real — its `compare_digest` and its
    # 🔴 fail-closed-on-unpaired branch are exactly what check 3 below exercises.
    #
    # 🔴 PATCH THE CHANNEL, NOT THE MODULE ATTRIBUTE. This used to be
    # `setattr(pairing, "get_token", …)`, which worked while module-level `verify()` called
    # module-level `get_token()`. 7.2-m4 moved both onto `Channel`, so `verify` now calls
    # `self.get_token()` and a module-level patch reaches nothing — the gate went on reading the
    # real (empty) section and refused the "correct" token.
    #
    # ⚠️ IT FAILED LOUDLY HERE, WHICH WAS LUCK RATHER THAN DESIGN. The dangerous direction is a
    # patch that fakes "unpaired" and still passes, because the unpatched read ALSO returns "" —
    # a security test passing for the wrong reason. `test_nomi_pairing.py::
    # test_verify_observes_the_channels_own_get_token` is the guard against that recurring.
    monkeypatch.setattr(pairing.ST, "get_token", lambda: TOKEN)

    app = Flask(__name__)
    app.register_blueprint(create_pair_blueprint())

    # ⚠️ A LIST, NOT THE LAST ONE. The smoke deliberately sends a wrong token and an empty token
    # after the good one, so a single slot holds `Bearer ` by the time it is read and the check
    # fails describing a bug that is not there.
    seen = []

    @app.before_request
    def _record():
        # Recorded for check 4, which is what stops the other checks passing for the wrong
        # reason: a client that sent the token in a query string would satisfy every one of them.
        if request.path.startswith("/pair/"):
            seen.append(request.headers.get("Authorization", ""))

    @app.route("/__seen_auth")
    def _seen_auth():
        return jsonify({"headers": seen})

    # 🔴 A SECOND SERVER THAT IS LOCKED. `_require_unlocked` is an app-level before_request in
    # production, so it runs BEFORE this family's bearer gate and 401s every /pair/* call while
    # the vault is shut — with a correct token in hand. That is a different 401 from "wrong
    # token" and the client must not conflate them. Modeled with the REAL `auth.LOCKED_BODY` so
    # this test cannot drift from the body production actually sends.
    from vocalis.runtime import auth
    locked_app = Flask(__name__)
    locked_app.register_blueprint(create_pair_blueprint())

    @locked_app.before_request
    def _locked():
        if request.method != "OPTIONS":
            return jsonify(auth.LOCKED_BODY), 401

    from werkzeug.serving import make_server
    srv = make_server("127.0.0.1", 0, app, threaded=True)
    lsrv = make_server("127.0.0.1", 0, locked_app, threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=lsrv.serve_forever, daemon=True).start()
    try:
        r = subprocess.run(
            [NODE, str(Path(__file__).parent / "st_pairing_smoke.mjs"),
             f"http://127.0.0.1:{srv.server_port}",
             str(EXT / "vocalis-stream.js"), TOKEN,
             f"http://127.0.0.1:{lsrv.server_port}"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        assert r.returncode == 0, f"pairing smoke failed:\n{r.stdout}\n{r.stderr}"

        # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a script that stopped
        # checking - an early return leaves the run SHORTER and still green. ⚠\Fe0f MEASURED floor: this
        # file has no SPEC constant, so conftest cannot derive one from a module-level path.
        assert_spec_ran(r, Path(__file__).parent / "st_pairing_smoke.mjs", floor=6)
        # A skipped section exits 0 as happily as a passing one — name the three that carry the
        # security property, so "the smoke is green" cannot come to mean "it stopped checking".
        for named in ("an empty token is refused",
                      "the server saw an Authorization: Bearer header",
                      "a locked vault reports locked, never unpaired"):
            assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
    finally:
        srv.shutdown()
        lsrv.shutdown()


def test_every_call_to_a_gated_family_carries_the_bearer():
    """🔴 THE m6 INVERSION OF A RULE THIS FILE HELD FOR FOUR MILESTONES. Until 7.0-m6 this test
    asserted the token was NEVER sent on `/v1/*` — correct while that family was deliberately
    unauthenticated, and exactly wrong the day `_require_login` started demanding the bearer
    there. The invariant now: **every helper that calls `/v1/*` or `/pair/*` carries the
    credential** — the literal header or the `authHeader(` helper — and the ones that call
    neither (`probeHealth`, and playStream's capability-URL fetches) stay bare.

    🔴 **CHECKED PER FUNCTION AGAINST THE URL IT CALLS, NOT AGAINST A LIST OF BLESSED NAMES** —
    that part survives from the old rule, and so does the reason: a whitelist has to be edited by
    whoever adds the next route call, and the edit that satisfies it is also the edit that would
    satisfy it for a call that forgot the header. Matching is on the URL TEMPLATE (`${base}/v1/`),
    never prose, so a docstring discussing the family cannot trip it.
    """
    js = (EXT / "vocalis-stream.js").read_text(encoding="utf-8")
    KEY = "'Authorization'"
    HELPER = "authHeader("
    # The helper itself must exist and pin the exact shape both gates parse.
    assert "function authHeader(" in js and "Bearer ${String(token || '')}" in js, \
        "authHeader() is gone or changed shape — the gated families parse 'Bearer <token>'"
    carriers = []
    # 🔴 EACH BLOCK IS CUT AT ITS OWN CLOSING BRACE, and that is not tidiness. Splitting on
    # `\nexport ` alone leaves the NEXT function's leading docstring glued to the end of this one,
    # so `pushDocument` inherited `fetchVoices`'s "GET /v1/audio/voices" and failed a rule it
    # keeps perfectly. A test whose verdict depends on its neighbor's comments is a test that
    # will be silenced rather than believed.
    for b in js.split("\nexport "):
        body = b.split("\n}\n")[0]              # this function only — bodies are indented
        name = body.partition("(")[0].split()[-1] if "(" in body else "<module header>"
        gated = ("${base}/v1/" in body) or ("${base}/pair/" in body)
        if not gated:
            # ⚠️ probeHealth and the module header land here, and so do the stream/status GETs
            # (they build URLs from reg.stream_url, not from a `${base}/…` template — their
            # credential is the 122-bit token IN the path, §2.2).
            continue
        carriers.append(name)
        assert KEY in body or HELPER in body, (
            f"{name} calls a gated family without the bearer — after m6 that call answers 401 "
            f"on every configured install")
    # The positive half. Without it, deleting the header everywhere passes silently — the loop
    # above is vacuously true over zero carriers, which is the classic surface-test hole.
    assert sorted(carriers) == [
        "cancelPrerender", "cancelScene", "createScene", "estimateScene", "fetchAvatar",
        "fetchExtensionSettings", "fetchPlan", "fetchStates", "fetchVoices", "pairPing", "pairPoll", "playStream",
        "prerender", "pushAvatar", "pushDocument", "pushDone", "registerCharacters",
        "sceneStatus", "sweepDone"], \
        f"the set of functions calling the gated families changed: {sorted(carriers)}"
    # …and the health probe stays credential-free: it is the one pre-auth call the settings
    # panel makes, and a bearer there would leak the token to a server nobody has vetted yet.
    probe = [b for b in js.split("\nexport ") if b.startswith("async function probeHealth")]
    assert probe and KEY not in probe[0].split("\n}\n")[0] \
        and HELPER not in probe[0].split("\n}\n")[0], \
        "probeHealth must not carry the bearer"


def test_no_identifier_is_declared_twice_at_module_scope():
    """Top-level declarations must have unique names because duplicate const declarations make the extension fail to parse."""
    import collections
    import re
    for name in ("index.js", "vocalis-stream.js", "polish-send.js"):
        js = (EXT / name).read_text(encoding="utf-8")
        decls = re.findall(r"^(?:export\s+)?(?:const|let|var|function|async function)\s+"
                           r"([A-Za-z_$][\w$]*)", js, re.M)
        dupes = sorted(n for n, c in collections.Counter(decls).items() if c > 1)
        assert not dupes, f"{name} declares these more than once at module scope: {dupes}"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_polish_send_runtime_contract():
    """Run the focused DOM/state-machine contract against the production ES module."""
    spec = Path(__file__).with_name("st_polish_send_spec.mjs")
    result = subprocess.run([NODE, str(spec)], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "st_polish_send_spec: ok" in result.stdout
    assert_spec_ran(result, spec)


# ── SillyTavern's bookkeeping is not part of the card ────────────────────────

def test_the_cards_fallback_strips_the_fields_their_server_recomputes():
    """Fallback requests must omit fields recomputed by the server so repeated polls do not create false revisions."""
    src = (EXT / "index.js").read_text(encoding="utf-8")

    for field in ("date_last_chat", "chat_size", "date_added", "create_date", "data_size"):
        assert f"'{field}'" in src, f"{field} is no longer stripped — it changes when nothing did"

    fn = src[src.index("function withoutBookkeeping"):]
    fn = fn[:fn.index("\n}") + 2]
    assert "delete out[k]" in fn, "withoutBookkeeping no longer removes anything"

    # 🔴 The verbatim chunk must NOT be run through the strip: that is the path §5b's byte
    # identity is written against, and quietly normalizing it would break the export contract.
    grab = src[src.index("async function fetchCard(avatar)"):]
    grab = grab[:grab.index("\n}\n")]
    assert "JSON.parse(row.json_data)" in grab
    assert "withoutBookkeeping(JSON.parse" not in grab, (
        "the verbatim PNG chunk must not be normalized — only the reconstructed row is")
def test_the_audio_error_listener_guards_on_the_NULLABLE_SLOT_not_the_event_target():
    """🔴 GUARD ON `audio`, NEVER ON `e.target` — OTHERWISE EVERY FINISHED NARRATION TOASTS.

    `teardown()` sets `audio.src = ''`, and an empty src makes the element fire a REAL `error`
    (code 4, "Empty src attribute") asynchronously. `finishByStatus()` is the one teardown caller
    that does not set `stopped` first, so on the ordinary play-to-the-end path the `{ once: true }`
    error listener is still armed when that spurious error lands. The old guard read `audio`, which
    `teardown` had already set to `null`, and swallowed it. `e.target` is the element and is ALWAYS
    truthy, so a guard on it swallows nothing: `fail()` runs, `index.js` calls `toastr.error`, and
    the user gets a red error toast immediately after `onEnded` reported success.

    8.8-m10's cast pass moved the guard onto the hoisted local in the extension while the sibling
    player kept it on `audio`. The two files had been identical here; that divergence WAS the bug,
    so this test asserts both of them, together, for exactly that reason.
    """
    player = Path(__file__).parent.parent / "src" / "webui" / "vocalis_stream_player.js"
    for path in (EXT / "vocalis-stream.js", player):
        src = path.read_text(encoding="utf-8")
        i = src.index("fail('audio error: ")
        cond = src[max(0, i - 260):i]
        assert "!stopped && audio" in cond, (
            f"{path.name}: the audio error listener no longer guards on the nullable `audio` "
            f"slot, so teardown's own empty-src error reaches fail() and the user sees an error "
            f"toast after every completed narration")
        assert "!stopped && el" not in cond, (
            f"{path.name}: guarding on the hoisted event-target local swallows nothing — "
            f"`e.target` is the element and is always truthy")

"""5.4: POST /v1/audio/state — what the server HAS for a batch of messages.

The SillyTavern extension colors each message's ▶ button from this route, so the two
failure modes worth a test file are the two that are SILENT:

  1. **The probe resolves a different cache key from the render paths.** Every button
     then reads orange forever, every click renders, and nothing errors or logs. Same
     shape as 5.2's key trap, and pinned the same way.
  2. **The probe is not read-only.** Reusing /v1/audio/prerender as the probe would
     queue a speculative render per message — a chat open paints 100 at once — and
     `resolve_st_request` writes twice on its own account (registry upsert, cache mkdir).
     A test that only checks the returned STATE would pass through all of it.

Fixtures come from test_prerender: same fake generator (real ffmpeg, no GPU), same
autouse dispatcher cleanup. DESIGN_5_4_BUTTON_STATE §5.
"""
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import prerender                                            # noqa: E402
import vocalis_stream_http as vsh                           # noqa: E402
from test_prerender import (BODY, HOLD_CHUNKS, HOLD_SAMPLES, _mk_app,  # noqa: E402,F401
                            _stop_queues, _wait, cpath_of)

STATE_URL = "/v1/audio/state"


def _identity(nomi, key):
    """The live-render registry key: the content key plus the speaker-scoped cache path (see
    prerender.request_identity), not the bare content key it was keyed by before."""
    return prerender.request_identity(key, cpath_of(nomi, key))


def _states(client, *bodies):
    r = client.post(STATE_URL, json={"items": list(bodies)})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["states"]


# ── 🔴 the one that decides whether any of this works ─────────────────────────────

def test_probe_and_render_derive_the_same_key(tmp_path, monkeypatch):
    """The probe must land on the SAME key a click would look up, through every branch
    of the voice-precedence ladder. If it doesn't, the color describes an entry nobody
    will ever ask for: orange button, cache hit one millisecond later, no error anywhere."""
    client, _, _, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True                       # gate shut: nothing actually renders
    for body in ({"input": "One.", "character": 'Test Character'},          # character voice
                 {"input": "Two.", "character": "Nobody"},             # falls to default
                 {"input": "Three.", "character": 'Test Character', "voice": "v.wav"},
                 {"input": "Four.", "character": 'Test Character', "narrate_actions": False},
                 {"input": "Five."}):                                  # no character at all
        probe = _states(client, body)[0]
        stream = client.post("/v1/audio/stream", json=body).get_json()
        assert probe["cache_key"] == stream["cache_key"], body
        assert len(probe["cache_key"]) == 32


# ── 🔴 read-only, in all three senses ────────────────────────────────────────────

def test_the_state_route_starts_nothing(tmp_path, monkeypatch):
    """The reason this route exists instead of reusing /v1/audio/prerender. Probing an
    uncached message must not queue it — otherwise opening a chat speculatively renders
    every message on screen."""
    client, _, q, _, calls = _mk_app(tmp_path, monkeypatch)
    before = q.stats()
    assert _states(client, BODY)[0]["state"] == "none"
    assert q.queued_count() == 0                 # nothing queued…
    assert calls["n"] == 0                       # …and nothing generated
    after = q.stats()
    for k in ("completed", "hits", "attached", "declined", "dropped"):
        assert after[k] == before[k], k


def test_the_probe_does_not_create_the_cache_directory(tmp_path, monkeypatch):
    """`resolve_st_request` mkdirs the entry's encrypted cache dir. A chat open probes
    ~100 messages; 100 directories for audio that may never exist is a write per message
    nobody asked for."""
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    key = _states(client, BODY)[0]["cache_key"]
    assert not cpath_of(nomi, key).parent.exists()
    # …and the render path still does create it, i.e. `probe=` skipped only this.
    client.post("/v1/audio/prerender", json=BODY)
    assert cpath_of(nomi, key).parent.exists()


def test_the_probe_does_not_register_characters(tmp_path, monkeypatch):
    """Names become assignable in the web UI when the user does something — not when a
    poll glances at a chat."""
    from st_characters import StCharacterRegistry
    client, _, _, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    body = {"input": "A line.", "character": "Stranger"}
    # A fresh reader over the same store — the blueprint's own registry is not returned,
    # and reading the file back is the stronger check anyway: it is what persists.
    registry = lambda: StCharacterRegistry(tmp_path / "voice_settings.yaml").all()
    _states(client, body)
    assert "Stranger" not in registry()
    client.post("/v1/audio/prerender", json=body)          # a real request registers it
    assert "Stranger" in registry()


def test_a_probe_is_not_a_hit(tmp_path, monkeypatch):
    """`(hits + attached) / completed` is the number that says whether pre-rendering was
    worth the GPU. Polling must not touch it — it would drive it toward 100% on a chat
    nobody listened to."""
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    # 🔴 WAIT ON THE PUBLISHED STAT, NOT ON THE FILE — this is the only test in the file that
    # asserts against `q.stats()`, and it is the only one the difference can reach. `_promote`
    # Promotion writes the cache entry before publishing `completed` and `unclaimed` under
    # the queue lock (prerender.py:634). File existence can therefore precede the counter update.
    # Wait for `completed`, which is published with `unclaimed`, then assert the untouched
    # counters; this synchronizes the test without making those assertions vacuous.
    _wait(lambda: q.stats()["completed"] == 1, what="the promote to be published")
    assert cpath_of(nomi, key).exists()          # …and the entry it promoted is really there
    for _ in range(5):                           # a poll, five times over
        assert _states(client, BODY)[0]["state"] == "cached"
    assert q.stats()["hits"] == 0
    assert q.stats()["attached"] == 0
    assert q.stats()["unclaimed"] == 1           # still unclaimed: nobody clicked


# ── the states themselves ────────────────────────────────────────────────────────

def test_none_when_the_server_has_nothing(tmp_path, monkeypatch):
    client, _, _, _, _ = _mk_app(tmp_path, monkeypatch)
    assert _states(client, BODY)[0]["state"] == "none"


def test_queued_carries_its_position(tmp_path, monkeypatch):
    client, _, _, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True                       # gate shut: everything piles up
    first = {"input": "First line.", "character": 'Test Character'}
    second = {"input": "Second line.", "character": 'Test Character'}
    client.post("/v1/audio/prerender", json=first)
    client.post("/v1/audio/prerender", json=second)
    got = _states(client, first, second)
    assert [s["state"] for s in got] == ["queued", "queued"]
    assert got[0]["detail"] == "next"
    assert got[1]["detail"] == "1 ahead"


def test_rendering_before_the_governor_releases(tmp_path, monkeypatch):
    """Yellow, not blue: the producer is running but has emitted no audio, so playing it
    now would stutter. (0.5 s chunks — well under what ffmpeg's AVIO buffer flushes.)"""
    hold = threading.Event()
    client, _, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                 chunks=3, chunk_samples=12000)
    client.post("/v1/audio/prerender", json=BODY)
    _wait(lambda: q._running is not None, what="the producer to start")
    assert q._running.written == 0               # the premise of this test
    assert _states(client, BODY)[0]["state"] == "rendering"
    hold.set()


def test_playable_once_bytes_reach_the_spool(tmp_path, monkeypatch):
    """🔴 Blue. `written > 0` is the buffer governor's RELEASE decision, not a byte count
    standing in for progress: stream_message withholds every window until
    `required_buffer_s` is met, and a pre-render runs that same path with the same
    StreamConfig. See DESIGN_5_4_BUTTON_STATE.md §3.1."""
    hold = threading.Event()
    client, _, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                 chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    client.post("/v1/audio/prerender", json=BODY)
    _wait(lambda: q._running is not None and q._running.written > 0, what="first bytes")
    assert _states(client, BODY)[0]["state"] == "playable"
    hold.set()


def test_cached_when_the_entry_exists(tmp_path, monkeypatch):
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: cpath_of(nomi, key).exists(), what="the cache entry")
    got = _states(client, BODY)[0]
    assert got["state"] == "cached"
    assert got["cache_key"] == key


def test_state_of_agrees_with_what_submit_would_say(tmp_path, monkeypatch):
    """The two read the same conditions in the same order. If they ever disagree the
    button reports one thing and the click does another."""
    client, nomi, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    # Queue identity is the key AND its speaker-scoped cache path, so both calls name the path.
    cpath = cpath_of(nomi, key)
    assert q.state_of(key, cpath)[0] == "queued"
    assert q.submit(key, "x", {}, cpath) == "queued"      # submit's own view
    assert q.state_of("deadbeef" * 4)[0] is None             # a key it has never seen


# ── the batch ────────────────────────────────────────────────────────────────────

def test_order_is_preserved_and_a_bad_item_spares_its_siblings(tmp_path, monkeypatch):
    """One unspeakable message must not blank the colors of the other ninety-nine."""
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: cpath_of(nomi, key).exists(), what="the cache entry")
    got = _states(client,
                  BODY,                                        # cached
                  {"input": "   ", "character": 'Test Character'},   # no text at all
                  {"input": "*shrugs*", "character": 'Test Character', "narrate_actions": False},
                  "not an object",
                  {"input": "Never rendered.", "character": 'Test Character'})
    assert [s["state"] for s in got] == ["cached", "none", "none", "none", "none"]
    assert got[0]["cache_key"] == key
    assert got[1]["cache_key"] is None and got[1]["detail"]     # says why
    assert got[3]["detail"] == "not an object"
    assert got[4]["cache_key"] is not None                      # resolvable, just absent


def test_the_batch_cap(tmp_path, monkeypatch):
    """The DoS bound on another unauthenticated route — and above the 100 SillyTavern
    paints in one DOM update, so an ordinary chat open is always one request."""
    client, _, _, _, _ = _mk_app(tmp_path, monkeypatch)
    assert vsh.MAX_STATE_ITEMS >= 100
    one = {"input": "A line.", "character": 'Test Character'}
    ok = client.post(STATE_URL, json={"items": [one] * vsh.MAX_STATE_ITEMS})
    assert ok.status_code == 200
    assert len(ok.get_json()["states"]) == vsh.MAX_STATE_ITEMS
    over = client.post(STATE_URL, json={"items": [one] * (vsh.MAX_STATE_ITEMS + 1)})
    assert over.status_code == 400


def test_items_must_be_a_list(tmp_path, monkeypatch):
    client, _, _, _, _ = _mk_app(tmp_path, monkeypatch)
    assert client.post(STATE_URL, json={}).status_code == 400
    assert client.post(STATE_URL, json={"items": "nope"}).status_code == 400
    assert client.post(STATE_URL, json={"items": []}).get_json() == {"states": []}
    assert prerender.MAX_QUEUE                   # keeps the import honest


# ── 🔴 the one the suite could not see ───────────────────────────────────────────

def test_the_key_never_depends_on_the_working_directory(tmp_path, monkeypatch):
    'A cache key must depend on the request, and on NOTHING ELSE.\n\n    It did not. `NomiSpeaker.cache_key` guarded its voice stat with `if vp`, and the\n    no-voice sentinel handed to it was `Path("")` — which is `Path(".")`, which is TRUTHY.\n    A request that resolved no voice therefore stat\'d the process\'s CURRENT DIRECTORY and\n    folded that directory\'s mtime into the key. Creating or deleting any file in it — and\n    registering a character rewrites voice_settings.yaml, which is enough — moved every key\n    computed afterward. The audio simply rendered again, every time, and nothing reported\n    it: no error, no log, just a cache that never hit and a pre-render never claimed.\n\n    The rest of this file could not see it — the fixture gives Test Character a real voice, so\n    `voice_ref` was never None. Found by driving the live route on a box with no\n    default_voice set, where a probe and a render a millisecond apart disagreed.\n    '
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    base = {"voice_filename": "", "exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.8}
    empty = nomi.cache_key({**base, "voice": Path("")}, "A line.")
    none_ = nomi.cache_key({**base, "voice": None}, "A line.")
    dot = nomi.cache_key({**base, "voice": Path(".")}, "A line.")
    assert empty == none_ == dot, (
        "the no-voice sentinel is being stat'd as a directory — the key now moves whenever "
        "anything is written next to the process")
    assert client  # the fixture's dispatcher is what _stop_queues cleans up


def test_a_probe_and_a_render_agree_when_no_voice_resolves(tmp_path, monkeypatch):
    """The live failure, end to end: an unknown character on a box with no default voice.
    The render registers the name (a write) and the probe does not, so anything the key
    picked up from the filesystem around it made the two disagree."""
    settings = tmp_path / "voice_settings.yaml"
    client, _, _, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    settings.write_text("nomi: {}\n", encoding="utf-8")      # no default_voice anywhere
    body = {"input": "Nobody has a voice for this line.", "character": "Nameless"}
    probed = _states(client, body)[0]["cache_key"]
    rendered = client.post("/v1/audio/prerender", json=body).get_json()["cache_key"]
    assert probed == rendered, "a probe and a render derived different keys for one body"


# ── a user-started render, outside the queue ───────────────────────────────
# The live stream is not represented in the pre-render queue or cache. Track its state so the
# route can distinguish a render that has not emitted audio from one that is ready to play.

def test_a_live_render_reports_rendering_before_it_ships(tmp_path, monkeypatch):
    """Yellow while the click's render is spinning up but has emitted nothing."""
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/stream", json=BODY).get_json()["cache_key"]
    identity = _identity(nomi, key)
    vsh._live_begin(identity)
    try:
        assert _states(client, BODY)[0]["state"] == "rendering"
    finally:
        vsh._live_end(identity)


def test_a_live_render_reports_playable_once_it_ships(tmp_path, monkeypatch):
    """🔴 Blue. The live path's release moment is its first ENCODED block leaving for the
    listener — the same governor decision the pre-render spool's `written > 0` records,
    because both go through `stream_message` with the same StreamConfig."""
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/stream", json=BODY).get_json()["cache_key"]
    identity = _identity(nomi, key)
    vsh._live_begin(identity)
    try:
        assert _states(client, BODY)[0]["state"] == "rendering"
        vsh._live_shipped(identity)
        assert _states(client, BODY)[0]["state"] == "playable"
    finally:
        vsh._live_end(identity)


def test_the_live_entry_is_gone_when_the_render_is(tmp_path, monkeypatch):
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/stream", json=BODY).get_json()["cache_key"]
    identity = _identity(nomi, key)
    vsh._live_begin(identity)
    vsh._live_end(identity)
    assert vsh.live_state_of(identity) is None
    assert _states(client, BODY)[0]["state"] == "none"


def test_two_renders_of_one_key_do_not_retire_each_other(tmp_path, monkeypatch):
    """A re-GET of the same token, or a force alongside a normal click, means two renders can
    be in flight for one key. The first to finish must not blank the color of the second."""
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/stream", json=BODY).get_json()["cache_key"]
    identity = _identity(nomi, key)
    vsh._live_begin(identity)
    vsh._live_begin(identity)
    vsh._live_end(identity)
    assert vsh.live_state_of(identity) is not None     # still one in flight
    vsh._live_end(identity)
    assert vsh.live_state_of(identity) is None


def test_the_cache_still_wins_over_a_live_render(tmp_path, monkeypatch):
    """Order is cache, then live, then the queue. A finished render promotes into the cache
    BEFORE its live entry is retired, precisely so the button never flickers orange between
    blue and green — which means both can be true for an instant, and green must win."""
    client, nomi, _, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: cpath_of(nomi, key).exists(), what="the cache entry")
    identity = _identity(nomi, key)
    vsh._live_begin(identity)
    vsh._live_shipped(identity)
    try:
        assert _states(client, BODY)[0]["state"] == "cached"
    finally:
        vsh._live_end(identity)


def test_an_uncacheable_stream_registers_nothing(tmp_path, monkeypatch):
    """Playground and web-UI streams carry an empty key — they manage their own persistence.
    Registering '' would make one anonymous stream color every unresolvable probe."""
    # Live renders are keyed by `request_identity` now (cache key + cache path); an empty key has no
    # identity at all, which is how an uncacheable stream stays out of the registry.
    identity = prerender.request_identity("", None)
    assert identity is None
    vsh._live_begin(identity)
    vsh._live_shipped(identity)
    assert vsh.live_state_of(identity) is None
    vsh._live_end(identity)

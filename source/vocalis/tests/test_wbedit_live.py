"""Tests live progress and cancellation using controlled model responses."""
from __future__ import annotations

import copy
import json
import ssl
import time
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit import formats, prompt, runner
from wbedit.backends.base import profile
from wbedit.backends.kobold_chat import KoboldChat, urllib_post
from wbedit.core.contract import BEGIN, END, NOCHANGE
from wbedit.core.job import Job
from wbedit.store import DocumentStore, PassStore
from wbedit.store.models import Proposal

CARD_PATH = REPO_ROOT / "reference" / "wbedit-baseline" / "prompts" / "Section-Editor.json"

LIVE_TEST_TIMEOUT_S = 960.0

pytestmark = pytest.mark.timeout(LIVE_TEST_TIMEOUT_S)


# ── the seam ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def live(request):
    url = request.config.getoption("--live-llm")
    if not url:
        pytest.skip("live-model tests are opt-in: pass --live-llm https://127.0.0.1:5001")
    return url, request.config.getoption("--live-llm-key")


@pytest.fixture(scope="session")
def backend(live):
    """Checks that backend."""
    import urllib.request

    url, key = live
    ctx = ssl._create_unverified_context()          # local, self-signed (I18: nothing leaves)
    req = urllib.request.Request(url.rstrip("/") + "/api/v1/model",
                                 headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            model = json.loads(r.read().decode("utf-8"))["result"]
    except OSError as exc:
        pytest.fail(f"no KoboldCpp at {url} ({type(exc).__name__}: {exc}) — is the tunnel up? "
                    f"ssh -N -L 5001:127.0.0.1:5001 user@remote-host")
    assert model != "koboldcpp/protected-model", \
        "the bearer was refused — /api/v1/model returned the placeholder name"
    return KoboldChat(urllib_post(url, key, context=ctx), model=model, timeout=900.0)


@pytest.fixture(scope="session")
def card():
    return json.loads(CARD_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def build(card):
    system, shots = prompt.load(card)
    return prompt.for_runner(system, shots)


def a_job(text: str, *, label="Sample Entry 1", kind="a lorebook entry", note="",
          keys=(), constant=False, locator=("entries", "0", "content")) -> Job:
    return Job(rel="live.json", locator=locator, label=label, original=text,
               meta={"section": "Sample World Book 1", "keys": list(keys), "constant": constant,
                     "kind": kind, "note": note})


def one(backend, build, job, instruction, **kw):
    """Run a single field and hand back its Result. The runner, not a hand-rolled call — the
    retry, the reparse and the two NOCHANGE paths are part of what is under test."""
    for ev in runner.run([job], instruction=instruction, backend=backend, prompt=build, **kw):
        if ev.kind == runner.FIELD_RESULT:
            return ev.result
    raise AssertionError("the runner produced no result")


# ── the fixtures the invariants were found on ─────────────────────────────────

LONG = (
    "Test Character 1 keeps the ledger of every debt owed in the lower wards, and has done so for "
    "thirty-one years. The book itself is calfskin over oak boards, rebound twice, and it never "
    "leaves the counting room on the second floor of the Sample Location 1. Merchants come to it the way "
    "penitents come to a shrine: quietly, early, and with something in hand. Test Character 1 does "
    "not haggle. The figure in the ledger is the figure, and the only negotiation permitted is "
    "over time, which Test Character 1 sells at a rate that has never once been written down.\n\n"
    "There is a story, probably untrue, that a factor from the Sample Location 2 once tried to buy the "
    "ledger outright. He arrived with a chest of silver and an escort of six, and he left the "
    "same afternoon with the chest and four of the six, having been shown a single page and "
    "asked, politely, whether he still wished to own it. Nobody knows which page. The story is "
    "told most often by people who owe nothing, which is how you can tell it is a story.\n\n"
    "What is certainly true is this: no debt recorded in that book has ever been forgiven, and "
    "three have been transferred to heirs who had not been born when they were incurred."
)

RENAME = ("Rename the character Test Character 1 to Renamed Character 1. Change every reference to that "
          "character, including oblique ones such as 'the Character 1'. Change nothing else whatsoever: "
          "keep every other word, every punctuation mark and every paragraph break exactly as it "
          "is.")

IRRELEVANT = ("Rename the character Test Character 13 to Renamed Test Character 13. Change every "
              "reference to that character and nothing else.")


# ── I2 — the one that cannot be unit-tested ───────────────────────────────────

def test_a_long_field_comes_back_verbatim_apart_from_the_edit(backend, build):
    """Checks that a long field comes back verbatim apart from the edit."""
    res = one(backend, build, a_job(LONG), RENAME)
    assert res.status == "CHANGED", f"{res.status}: {res.reason}"
    expected = LONG.replace("Test Character 1", "Renamed Character 1")
    assert res.revised == expected, (
        f"the untouched text drifted under {backend.model}.\n"
        f"in  {len(LONG)} chars / {len(LONG.split())} words\n"
        f"out {len(res.revised)} chars / {len(res.revised.split())} words\n"
        "🔴 If the diff shows words missing rather than reworded, check the sampler block "
        "reached the request — an omitted rep_pen is 1.1, not 0.")


def test_paragraph_structure_survives(backend, build):
    """Checks that paragraph structure survives."""
    res = one(backend, build, a_job(LONG), RENAME)
    assert res.revised.count("\n\n") == LONG.count("\n\n"), "paragraph breaks were reflowed"


@pytest.mark.parametrize("n", [1, 2, 3])
def test_the_same_field_three_times_never_bleeds_or_drifts(backend, build, n):
    """Checks that the same field three times never bleeds or drifts."""
    res = one(backend, build, a_job(LONG), RENAME)
    assert res.status == "CHANGED"
    assert res.revised == LONG.replace("Test Character 1", "Renamed Character 1"), f"run {n} drifted"
    # Nothing from the card's few-shot material may appear in the answer.
    for bleed in ("Test Character 10 Extra", "example", "<START>", "{{user}}", "{{char}}"):
        assert bleed not in res.revised, f"run {n}: {bleed!r} bled in from the prompt"


# ── I6 — the NOCHANGE discipline ──────────────────────────────────────────────

def test_an_unrelated_instruction_produces_NOCHANGE_not_an_echo(backend, build):
    """Checks that an unrelated instruction produces nochange not an echo."""
    res = one(backend, build, a_job(LONG), IRRELEVANT)
    assert res.status == "NOCHANGE", (
        f"the model echoed a {len(LONG)}-char field instead of emitting {NOCHANGE} "
        f"(status {res.status}, {len(res.revised or '')} chars back)")


def test_the_byte_identity_path_catches_an_echo_if_the_sentinel_does_not(backend, build):
    """Checks that the byte identity path catches an echo if the sentinel does not."""
    text = "The rains come off the estuary in the ninth month and do not stop until the frost."
    res = one(backend, build, a_job(text, label="Weather"),
              "Correct any spelling mistakes. If there are none, change nothing.")
    assert res.status == "NOCHANGE", f"{res.status}: {res.revised!r}"


# ── I1 / I3 / I5 — the output contract, against real replies ──────────────────

def test_the_model_never_emits_json(backend, build):
    """Checks that the model never emits json."""
    text = ('The contract reads: {"party": "Test Character 1", "term": "perpetual"} and is sealed '
            'with wax. Test Character 1 keeps the original.')
    res = one(backend, build, a_job(text), RENAME)
    assert res.status == "CHANGED", f"{res.status}: {res.reason}"
    body = res.revised.strip()
    assert not (body.startswith("{") and body.endswith("}")), \
        "the model returned a JSON object as the field body (I1)"
    assert '"content"' not in body and '"entries"' not in body, \
        "the model emitted document structure into a field (I1)"
    assert '{"party": "Renamed Character 1", "term": "perpetual"}' in body, \
        "the field's own JSON-shaped content did not survive"


def test_content_full_of_code_fences_and_backticks_round_trips(backend, build):
    """I3 — the sentinels are `<<<BEGIN` / `END>>>` rather than code fences precisely because
    field values routinely contain backticks and fenced blocks. This is that case, live."""
    text = ("Test Character 1's cipher is written as ```character-notation``` in the margin, and the "
            "key is `0x1F`. Test Character 1 never explains it.\n\n"
            "```\nledger:\n  owed: 40\n```\n\nThat block is copied into every apprentice's book.")
    res = one(backend, build, a_job(text), RENAME)
    assert res.status == "CHANGED", f"{res.status}: {res.reason}"
    assert "```character-notation```" in res.revised, "an inline fenced span was mangled"
    assert "```\nledger:\n  owed: 40\n```" in res.revised, "a fenced block was mangled"
    assert BEGIN not in res.revised and END not in res.revised, \
        "a sentinel leaked into the field body"


def test_no_chain_of_thought_arrives_inside_the_sentinels(backend, build):
    """Checks that no chain of thought arrives inside the sentinels."""
    res = one(backend, build, a_job(LONG), RENAME)
    lowered = (res.revised or "").lower()
    for tell in ("<think", "okay, so", "let me", "the user wants", "i need to",
                 "first, i", "step 1", "here is the", "here's the"):
        assert tell not in lowered, f"reasoning leaked into the field body: {tell!r}"


def test_the_notes_come_after_the_closing_sentinel_and_the_body_is_clean(backend, build):
    """Checks that the notes come after the closing sentinel and the body is clean."""
    res = one(backend, build, a_job(LONG), RENAME)
    assert res.revised.startswith("Renamed Character 1 keeps the ledger"), \
        "something preceded the field body inside the sentinels"
    assert res.revised.rstrip().endswith("when they were incurred."), \
        "commentary was appended inside the sentinels"


# ── the card path, and the macros ─────────────────────────────────────────────

def test_character_card_macros_survive_an_edit(backend, build):
    """Checks that character card macros survive an edit."""
    text = ("{{char}} watches {{user}} from across the counting room. Test Character 1 has been "
            "waiting for {{user}} to say something for a full minute now.")
    res = one(backend, build, a_job(text, label="first_mes",
                                    kind="a character card's opening message"), RENAME)
    assert res.status == "CHANGED", f"{res.status}: {res.reason}"
    assert res.revised.count("{{char}}") == 1 and res.revised.count("{{user}}") == 2, \
        f"a macro was dropped or duplicated: {res.revised!r}"
    assert not res.flags, f"the validators flagged it: {res.flags}"


def test_a_mes_example_block_keeps_its_START_separators(backend, build):
    """Checks that a mes example block keeps its start separators."""
    from wbedit.formats.card import EXAMPLE_NOTE
    text = ("<START>\n{{user}}: How much do I owe?\n{{char}}: Test Character 1 consults the book. "
            "Forty marks.\n<START>\n{{user}}: And if I cannot pay?\n"
            "{{char}}: Then Test Character 1 sells you time.")
    res = one(backend, build, a_job(text, label="mes_example",
                                    kind="a character card's example-dialogue block",
                                    note=EXAMPLE_NOTE), RENAME)
    assert res.status == "CHANGED", f"{res.status}: {res.reason}"
    assert res.revised.count("<START>") == 2, \
        f"the separators were treated as structure and removed: {res.revised!r}"
    assert "Test Character 10" not in res.revised and res.revised.count("Renamed Character 1") == 2


# ── the whole pass, through the store, on the real model ──────────────────────

def test_a_real_pass_reaches_a_revision_with_everything_else_untouched(backend, build, tmp_path):
    """Checks that a real pass reaches a revision with everything else untouched."""
    book = {
        "name": "Sample World Book 1",
        "entries": {
            "0": {"uid": 0, "key": ["ledger"], "keysecondary": [], "comment": "Sample Entry 1",
                  "content": LONG, "constant": False, "selective": True, "order": 100,
                  "position": 0, "disable": False, "probability": 100, "depth": 4,
                  "displayIndex": 0},
            "1": {"uid": 1, "key": ["weather"], "keysecondary": [], "comment": "Weather",
                  "content": "The rains come off the estuary in the ninth month.",
                  "constant": False, "selective": True, "order": 100, "position": 0,
                  "disable": False, "probability": 100, "depth": 4, "displayIndex": 1},
            "2": {"uid": 2, "key": ["wards"], "keysecondary": [], "comment": "X-the upper wards",
                  "content": ("Test Character 1 never goes above the third terrace, and the ledger "
                              "has no page for anyone who lives there."),
                  "constant": True, "selective": False, "order": 50, "position": 1,
                  "disable": False, "probability": 100, "depth": 4, "displayIndex": 2},
        },
    }
    docs, passes = DocumentStore(tmp_path / "wb"), PassStore(tmp_path / "wb")
    doc = docs.create(copy.deepcopy(book), name="Sample World Book 1", kind="worldbook")
    jobs = formats.collect(docs.revision(doc.id, 0).content, rel="sample-world-book-1.json")
    assert len(jobs) == 3

    p = passes.start(doc.id, revision=0, instruction=RENAME, model=backend.model,
                     sampler=profile(), selection=[list(j.locator) for j in jobs],
                     total=len(jobs))

    t0 = time.monotonic()
    for ev in runner.run(jobs, instruction=RENAME, backend=backend, prompt=build):
        if ev.kind == runner.FIELD_RESULT:
            passes.record(doc.id, p.id, Proposal.from_event(ev))
            # I16, observed on a real frame rather than asserted about the code. Labels and
            # document names DO travel; bodies do not.
            frame = json.dumps(ev.public())
            for body_only in ("calfskin", "Sample Location 1", "penitents", "Sample Location 2", "estuary"):
                assert body_only not in frame, f"I16: {body_only!r} in an SSE frame: {frame}"
        if ev.kind == runner.PASS_FINISH:
            passes.finish(doc.id, p.id, tally=ev.tally)
    elapsed = time.monotonic() - t0

    fresh = PassStore(tmp_path / "wb")               # read it back as a restart would
    props = fresh.proposals(doc.id, p.id)
    assert [x.status for x in props] == ["CHANGED", "NOCHANGE", "CHANGED"], \
        f"the Ledger and the X entry name Test Character 1; Weather does not — got {props}"
    assert [x.review for x in props] == ["approved", "none", "approved"]

    rev = DocumentStore(tmp_path / "wb").materialize(doc.id, 0, props, pass_id=p.id)
    assert rev is not None and rev.n == 1

    # Everything outside `content` byte-identical — uid, key, order, displayIndex, dict key order.
    before, after = copy.deepcopy(book), copy.deepcopy(rev.content)
    for k in before["entries"]:
        before["entries"][k]["content"] = after["entries"][k]["content"]
    assert json.dumps(after) == json.dumps(before), \
        "the pass changed something outside the fields it was given"

    assert "Test Character 10" not in json.dumps(after), "the rename did not reach every field"
    assert after["entries"]["1"]["content"] == book["entries"]["1"]["content"], \
        "the unrelated entry was touched"
    # X-titled entries follow the same edit path as other entries.
    assert after["entries"]["2"]["content"].startswith("Renamed Character 1")
    assert docs.revision(doc.id, 0).content == book, "I8 — the import was mutated"

    print(f"\n[live] {len(jobs)} fields in {elapsed:.1f}s on {backend.model}")


def test_the_pass_records_which_model_it_ran_under(backend, build, tmp_path):
    """Checks that the pass records which model it ran under."""
    docs, passes = DocumentStore(tmp_path / "wb"), PassStore(tmp_path / "wb")
    doc = docs.create({"entries": {}}, name="empty", kind="worldbook")
    p = passes.start(doc.id, revision=0, instruction=RENAME, model=backend.model,
                     sampler=profile(), selection=[], total=0)
    stored = PassStore(tmp_path / "wb").get(doc.id, p.id).model
    assert stored == backend.model and stored != "koboldcpp/protected-model"
    assert stored, "the pass recorded no model at all"


# ── what a pass costs, measured ───────────────────────────────────────────────

def test_report_the_observed_cost_per_field(backend, build):
    """Checks that report the observed cost per field."""
    sizes = [("short", 120), ("medium", 600), ("long", len(LONG))]
    rows = []
    for name, n in sizes:
        text = (LONG * 3)[:n] if n <= len(LONG) * 3 else LONG
        text = "Test Character 1. " + text
        t0 = time.monotonic()
        res = one(backend, build, a_job(text), RENAME)
        rows.append((name, len(text), res.status, time.monotonic() - t0))
    print(f"\n[live] {backend.model}")
    for name, n, status, secs in rows:
        print(f"[live]   {name:>6} {n:>5} chars  {status:<8} {secs:5.1f}s")
    slowest = max(r[3] for r in rows)
    assert slowest < 180, (
        f"a single field took {slowest:.0f}s — a 110-entry pass would be over five hours. "
        "Is the model swapped out, or is another job holding the cards?")


# ── the routes, against the real model ───────────────────────────────────────

def test_the_whole_tab_works_over_http_against_the_real_model(live, tmp_path, monkeypatch):
    """Checks that the whole tab works over http against the real model."""
    import kobold
    import vocalis_server as vs
    import vocalis.web.kobold as web_kobold
    import vocalis.web.wbedit as web_wbedit
    from vocalis.runtime import paths

    url, key = live
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    # `local=True` is what makes `_ssl_context` accept the tunnel's self-signed cert — the same
    # branch used by a local client. Nothing here re-derives TLS or the bearer (§7).
    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url=url, adminpassword=key, local=True))
    vs.app.config["TESTING"] = True

    book = {"name": "Sample World Book 1", "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False, "content": LONG},
        "1": {"uid": 1, "key": ["weather"], "comment": "Weather", "constant": False,
              "order": 100, "disable": False,
              "content": "The rains come off the estuary in the ninth month."},
        "2": {"uid": 2, "key": ["wards"], "comment": "X-the upper wards", "constant": True,
              "order": 50, "disable": False,
              "content": "Test Character 1 never goes above the third terrace."}}}

    with vs.app.test_client() as c:
        model = c.get("/wbedit/model").get_json()
        assert model["loaded"] is True, model
        assert model["model"] and model["model"] != "koboldcpp/protected-model"

        doc = c.post("/wbedit/documents", json={"document": book}).get_json()
        assert doc["kind"] == "worldbook"

        fields = c.get(f"/wbedit/documents/{doc['id']}/fields").get_json()["fields"]
        assert [f["label"] for f in fields] == ["Sample Entry 1", "Weather", "X-the upper wards"]

        started = c.post(f"/wbedit/documents/{doc['id']}/pass",
                         json={"instruction": RENAME}).get_json()
        assert started["fields"] == 3

        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            body = c.get(f"/wbedit/pass/{doc['id']}/{started['id']}").get_json()
            if body["status"] in ("done", "failed", "canceled"):
                break
            time.sleep(0.25)
        assert body["status"] == "done", f"the pass ended {body['status']}: {body.get('error')}"
        assert [x["status"] for x in body["proposals"]] == ["CHANGED", "NOCHANGE", "CHANGED"]

        # 🔴 I16, on a stream a real model filled. Grep the artifact, not the code (§10).
        stream = c.get(f"/wbedit/pass/{doc['id']}/{started['id']}/events").get_data(as_text=True)
        assert "field.result" in stream, "the stream was empty — this assertion proves nothing"
        for body_only in ("calfskin", "Sample Location 1", "penitents", "Sample Location 2", "estuary", "terrace"):
            assert body_only not in stream, f"I16 BREACH: {body_only!r} in an SSE frame"
        assert "Sample Entry 1" in stream, "labels must travel — a progress line needs them"

        one = c.get(f"/wbedit/pass/{doc['id']}/{started['id']}/proposal/1").get_json()
        assert one["original"] == LONG
        assert one["revised"] == LONG.replace("Test Character 1", "Renamed Character 1"), \
            "the long field drifted through the HTTP path"

        r = c.post(f"/wbedit/pass/{doc['id']}/{started['id']}/materialize")
        assert r.status_code == 201, r.get_json()
        assert r.get_json()["applied"] == 2

        rev = c.get(f"/wbedit/documents/{doc['id']}/revision/1").get_json()["content"]
        assert "Test Character 10" not in json.dumps(rev), "the rename did not reach every field"
        assert rev["entries"]["1"] == book["entries"]["1"], "an untouched entry moved"
        assert rev["entries"]["2"]["content"].startswith("Renamed Character 1"), "I9 — X is not immune"
        rev0 = c.get(f"/wbedit/documents/{doc['id']}/revision/0").get_json()["content"]
        assert rev0 == book, "I8 — the import was mutated"

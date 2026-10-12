"""Vocalis 5.0-M5 — the five VaultAuthError boundaries.

`VaultAuthError` does not subclass `Exception` (vault.py:57). That is deliberate, it is
re-decided and KEPT in SPEC_5_0_M5 §2, and it buys one thing: a wrong key can never be
swallowed by one of the 72 blind `except Exception:` handlers in src/ and answered by
DELETING the data it was asked about.

The price is that every place a thread or a request can END must catch it BY NAME, or a
hang becomes the normal UX. There are FIVE such places (the docs elsewhere say four — the
Playground finalize daemon thread makes five), and this file is the receipt for each.

Two properties, at every boundary:

    NEVER A HANG   — the job/request reaches a terminal state, and the SSE stream ends
    NEVER A DELETE — the file the vault could not read is still there, byte for byte
"""
import ast
import inspect
import json
import textwrap
import threading

import pytest

from conftest import REPO_ROOT, make_fake_pool  # noqa: F401  (sys.path side effect)

import stemsplit
import tts_utils
import vault_store
import vocalis_server as vs
import voiceswap
import voicetrain
from vault import VaultAuthError
from vocalis.runtime import jobs as jobs_mod
from vocalis.web import books as web_books            # run_job moved here in 5.1-P4.11
from vocalis.web import playground as web_playground  # run_playground_job + the stream gen (P4.12)

BOOM = "authentication failed on block 0 of output/test-user/mp3/01_Chapter.mp3"


def _handlers_of(obj, inner=None):
    """Every exception name caught inside `obj` (dedented — a METHOD's source is indented and
    ast.parse chokes on it). `inner` narrows to a nested function, which is how boundary 5 is
    reached: finalize() is defined inside the stream generator."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(obj)))
    if inner:
        tree = next(n for n in ast.walk(tree)
                    if isinstance(n, ast.FunctionDef) and n.name == inner)
    return {h.type.id if isinstance(h.type, ast.Name) else getattr(h.type, "attr", None)
            for n in ast.walk(tree) if isinstance(n, ast.Try)
            for h in n.handlers if h.type is not None}


# ── boundary 1: the Flask request boundary ───────────────────────────────────

def test_flask_cannot_errorhandler_a_baseexception():
    """THE FACT THE WHOLE WSGI WRAPPER EXISTS FOR — pinned, so nobody "simplifies" it back
    into an @app.errorhandler that silently never runs.

    Flask's error handling is `except Exception`. VaultAuthError is a BaseException. So a
    registered errorhandler for it is DEAD CODE, and the exception sails past Flask into the
    WSGI server, where the client gets a dropped connection instead of an answer.
    """
    from flask.app import Flask
    src = inspect.getsource(Flask.full_dispatch_request)
    assert "except Exception" in src
    assert "except BaseException" not in src


def test_a_vault_auth_error_in_a_view_becomes_a_500_not_a_dropped_connection():
    """Boundary 1. Not a 401: "locked" means log in, and this does not. It means these bytes
    did not authenticate — a wrong DEK, tampering, truncation, or real corruption.

    Driven through the WSGI wrapper directly rather than a throwaway @app.route: Flask 3
    refuses to register a route once the app has served its first request, so the route
    version passes alone and fails in the full suite. Which is a fair warning about how much
    of this milestone depends on being tested in the right ORDER.
    """
    assert isinstance(vs.app.wsgi_app, vs._VaultAuthWSGI), (
        "the VaultAuthError WSGI wrapper is not installed — a vault failure in any view would "
        "be re-raised into the WSGI server and the client would get a dropped connection")

    def _explodes(environ, start_response):
        raise VaultAuthError(BOOM)

    captured = {}

    def _start_response(status, headers):
        captured["status"] = status

    body = b"".join(vs._VaultAuthWSGI(_explodes)({"PATH_INFO": "/book/render"}, _start_response))

    assert captured["status"].startswith("500")
    payload = json.loads(body)
    assert payload["error"] == "vault_auth"
    assert BOOM in payload["message"]


# ── boundaries 2 + 5: the job threads ────────────────────────────────────────

class _Job:
    """The shape every job thread's error path actually touches."""
    def __init__(self):
        self.id = "j0b"
        self.status = "running"
        self.error = None
        self.events = []

    def emit(self, job, ev):
        self.events.append(ev)


def test_fail_job_on_vault_auth_stops_the_job_and_deletes_nothing(tmp_path):
    """The ONE shape all six job threads share (vault_store.fail_job_on_vault_auth), so that
    "each boundary catches it" and "each boundary does the right thing" cannot drift apart."""
    victim = tmp_path / "18_hour_training.pth"
    victim.write_bytes(b"thirteen to eighteen hours of GPU")

    job = _Job()
    vault_store.fail_job_on_vault_auth(job, VaultAuthError(BOOM), job.emit)

    assert job.status == "failed"                       # terminal — NEVER A HANG
    assert BOOM in job.error
    assert job.events[-1]["type"] == "error"            # and the SSE stream gets a terminal event
    assert victim.read_bytes() == b"thirteen to eighteen hours of GPU"   # NEVER A DELETE


@pytest.mark.parametrize("func", [
    web_books.run_job,
    web_playground.run_playground_job,
    voiceswap.run_swap_job,
    stemsplit.run_split_job,
    voicetrain.run_train_job,
], ids=lambda f: f.__name__)
def test_every_job_thread_catches_VaultAuthError_by_name(func):
    """Boundary 2, ×5 — the guard test (SPEC_5_0_M5 §2.5).

    AST, not behavior: it proves the clause is THERE. A refactor that drops one would
    otherwise turn that job into a silent thread death, and no existing test would notice
    until a render hung in production. This is M1's lint idea, kept as a complement to the
    type hierarchy rather than as a replacement for it.
    """
    assert "VaultAuthError" in _handlers_of(func), (
        f"{func.__name__} no longer catches VaultAuthError BY NAME. It is a BaseException: "
        f"`except Exception` will NOT catch it, the thread will die silently, and the job "
        f"will hang forever with no error anywhere. See SPEC_5_0_M5 §6.")


def test_the_playground_finalize_thread_is_the_fifth_boundary():
    """Boundary 5. A nested function on its own daemon thread (pg-finalize-<job.id>). It reads
    and writes the clip sidecar, and it can OUTLIVE the generator — so nobody else is
    guaranteed to be around to report for it. Every doc that says "four boundaries" is wrong.
    """
    assert "VaultAuthError" in _handlers_of(web_playground._playground_stream_gen, inner="finalize")


# ── boundary 3: the WorkerPool worker ────────────────────────────────────────

def test_a_vault_failure_in_a_worker_fails_the_render_instead_of_hanging_it(monkeypatch):
    """Boundary 3 — and THE hang, demonstrated.

    The per-chunk guard in _worker_loop is `except Exception`, which CANNOT see a
    VaultAuthError. Without the by-name clause, the exception escapes with batch.inflight and
    batch.pending still incremented, and collect() waits for a chunk that will never arrive —
    forever, with no error anywhere. Under M6/M7 this is a live path: batch.save() becomes a
    vault WRITE.

    So: the batch must DRAIN, and collect() must re-raise the VaultAuthError BY TYPE (not
    flattened into a RuntimeError, which would quietly defeat boundary 2 upstream).
    """
    pool = make_fake_pool(n_workers=1)

    def exploding_save(index, wav, sr):
        raise VaultAuthError(BOOM)                      # what a vault write does with a bad DEK

    def fake_generate(text, make_fn, sr, label=None, out=None):
        import torch
        return torch.zeros(1, 8), len(text), 0.01, None

    # monkeypatch, NOT a bare assignment: the worker resolves these in tts_utils's globals, and
    # a permanent rebind would follow this test into test_pool/test_server and quietly fake out
    # their generation too.
    monkeypatch.setattr(tts_utils, "generate_with_retry", fake_generate)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))

    done = {}

    def run():
        try:
            pool.run_chunks([(0, "hello")], tts_utils.GenParams(), exploding_save, total=1)
        except BaseException as exc:                    # BaseException: that is the whole point
            done["exc"] = exc

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout=20)

    assert not t.is_alive(), "THE RENDER HUNG. collect() is waiting on a chunk that will never arrive."
    assert isinstance(done.get("exc"), VaultAuthError), (
        f"collect() must re-raise the VaultAuthError BY TYPE so the job thread's "
        f"`except VaultAuthError` can see it — got {done.get('exc')!r}")


def test_the_worker_entry_catches_it_by_name():
    assert "VaultAuthError" in _handlers_of(tts_utils.WorkerPool._worker_entry)
    assert "VaultAuthError" in _handlers_of(tts_utils.WorkerPool._worker_loop)


# ── boundary 4: the streaming response ───────────────────────────────────────

def test_a_streaming_generator_catches_its_own():
    """Boundary 4. A streaming Response's generator is iterated by the WSGI server AFTER
    wsgi_app has already returned — so _VaultAuthWSGI (boundary 1) is off the stack by then
    and CANNOT see it. That is why the stream loops are a separate boundary and not a special
    case of boundary 1. Easy to get wrong; impossible to notice until it hangs."""
    assert "VaultAuthError" in _handlers_of(web_playground._playground_stream_gen)


def test_the_sse_event_stream_terminates_when_a_job_dies_of_a_vault_error():
    """The hang the boundary list exists to prevent, end to end.

    The SSE loop is `while True: ev = q.get()` — it blocks until a TERMINAL event arrives. A
    job thread that dies silently never emits one, so the browser's EventSource waits forever.
    Boundary 2 is what stops that: the job thread catches by name and emits `error`, which is
    terminal. This test is the proof, and it is why the three SSE event generators do NOT need
    a VaultAuthError clause of their own — they cannot raise one; they can only be starved.
    """
    job = jobs_mod.Job(id="sse1", docx="", voice="", params=tts_utils.GenParams(),
                 gpus="cpu", workers=1)
    jobs_mod.JOBS[job.id] = job
    try:
        vault_store.fail_job_on_vault_auth(job, VaultAuthError(BOOM), jobs_mod.emit)
        with vs.app.test_client() as c:
            r = c.get(f"/book/events/{job.id}")
            events = [json.loads(line[6:]) for line in r.data.decode().splitlines()
                      if line.startswith("data: ")]
        assert events, "the SSE stream produced nothing — the browser would hang here"
        assert events[-1]["type"] == "error"            # TERMINAL. The stream ends.
        assert BOOM in events[-1]["message"]
    finally:
        jobs_mod.JOBS.pop(job.id, None)


# ── the property that outlives all five ──────────────────────────────────────

def test_VaultAuthError_still_cannot_be_swallowed_by_a_blind_except():
    """The 73rd blind `except Exception` somebody writes next year. There are 72 today."""
    swallowed = False
    try:
        try:
            raise VaultAuthError(BOOM)
        except Exception:                               # noqa: BLE001 — the whole point
            swallowed = True
    except VaultAuthError:
        pass
    assert not swallowed


def _blind_excepts(path) -> int:
    """`except Exception:` / `except Exception as e:` handlers — PARSED, not grepped.

    🔴 IT USED TO BE A SUBSTRING COUNT, AND A SUBSTRING COUNT WAS COUNTING ITS OWN
    DOCUMENTATION.

    Every comment explaining *why* a blind catch is dangerous contains the words "except
    Exception", so the tripwire for the hazard was tripped by WRITING ABOUT the hazard. M6 added
    a handful of such comments — each one at a site it had just routed, saying "a VaultAuthError
    is a BaseException, so the `except Exception` below cannot see it" — and the count went over
    the line with no new handler anywhere in the tree.

    Measured at that moment: **101 by substring, 86 real. Fifteen of them were prose.** So the
    "94 at 5.0-M5" this test used to assert (and SPEC_5_0_M5 §2, and the handoff) was never a
    count of handlers either — it was a count of handlers plus paragraphs about handlers, and it
    inflated every time somebody documented one.

    That does NOT reopen the VaultAuthError ruling: it rests on claim (2) — "it stops the 73rd
    blind catch somebody writes next year" — which does not depend on the exact figure. But a
    tripwire has to measure the thing it is named after, or the first time it fires the honest
    response is to raise the limit, and then it is measuring nothing at all.
    """
    n = 0
    # utf-8-sig: a BOM is invisible to Python's importer and a SyntaxError to ast.parse.
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
        if isinstance(node, ast.ExceptHandler):
            t = node.type
            if isinstance(t, ast.Name) and t.id == "Exception":
                n += 1
    return n


def test_no_child_process_output_is_decoded_with_the_LOCALE_codec():
    """🔴 `text=True` ALONE DECODES WITH THE LOCALE CODEC, AND THAT 500s A ROUTE.

    `subprocess.run(..., capture_output=True, text=True)` decodes the child's bytes using
    `locale.getpreferredencoding()` — **cp1252 on Windows**. ffmpeg and ffprobe emit bytes that
    are not valid cp1252, so READING the output of a command that SUCCEEDED raises
    UnicodeDecodeError. The failure is at the wrong end of the call: nothing is wrong with the
    child, its work is done, and what breaks is our side reading the answer.

    Found three times in one night at 8.5 (commit 1757796):

      * `web/train.py:decode_take` was unwrapped, so it surfaced as a 500 on
        /train/import_stems_joined;
      * `leadvocal.ffprobe_channels` survived only because UnicodeDecodeError is a subclass of
        ValueError and a narrowed handler happened to catch it — luck, not design, and it
        silently reported "2 channels" for a probe that had actually worked.

    That commit fixed the two it was about and deliberately did not sweep the rest ("sweeping
    unrelated files into a production fix at midnight is the thing that makes a change
    unreviewable"), logging the remaining twelve as tech debt. This is that sweep, and this test
    is what stops a thirteenth arriving: an explicit `encoding=` is required, and
    `errors="replace"` beside it means a probe of a file with an odd byte in its metadata
    degrades to a replacement character instead of taking the request with it.

    ⚠️ AST, not grep. `text=True` on one line with `encoding=` on the next reads as a violation
    to a line-based search and is perfectly correct — two of the `mp3_concat.py` sites are exactly
    that, and a grep-based version of this test would have "found" them and been wrong.
    """
    import ast
    bad = []
    for path in sorted((REPO_ROOT / "src").rglob("*.py")):
        src = path.read_text(encoding="utf-8")
        if "text=True" not in src:
            continue
        for node in ast.walk(ast.parse(src)):
            if not isinstance(node, ast.Call):
                continue
            kw = {k.arg for k in node.keywords if k.arg}
            if "text" in kw and "encoding" not in kw:
                bad.append(f"{path.relative_to(REPO_ROOT).as_posix()}:{node.lineno}")
    assert not bad, (
        "these calls decode a child process's output with the LOCALE codec (cp1252 on Windows), "
        "so a byte ffmpeg or ffprobe legitimately emits raises UnicodeDecodeError on a command "
        "that SUCCEEDED:\n  " + "\n  ".join(bad) +
        '\n\nAdd encoding="utf-8", errors="replace" to each.')


def test_the_blind_except_count_has_not_quietly_exploded():
    """Count broad `except Exception` handlers as a tripwire, not a style rule. Each handler can hide a
failed write if a vault-authentication error is caught by mistake, so growth should prompt a review
of the new sites. Count recursively and compare handler identity rather than file location because
refactors move existing handlers between modules.

`VaultAuthError` subclasses `BaseException` and must continue to pass through these handlers. The
ceiling includes small headroom for legitimate growth; raise it only after reviewing the new
handlers, not just to clear a failure."""

    src = REPO_ROOT / "src"
    counts = {f.relative_to(src).as_posix(): _blind_excepts(f)
              for f in src.rglob("*.py") if "__pycache__" not in f.parts}
    n = sum(counts.values())
    worst = sorted(counts.items(), key=lambda kv: -kv[1])[:3]

    # 173 (was 172), October 10, 2026: one reviewed handler in `web/ui.py::_reconcile_satellites`.
    # It wraps the satellite reconcile so a failure is logged with its traceback and the busy flag
    # is cleared and a pending newer plan still applied. It cannot touch the vault: it surrounds
    # only `satellites.reconcile`, and `VaultAuthError` (a BaseException) passes through it.
    assert n <= 173, (
        f"{n} broad `except Exception:` handlers in src/. A wrong key could hide a failure if "
        f"VaultAuthError were caught; review new handlers before raising the ceiling. "
        f"Match handlers by function and body across refactors, not by file. "
        f"Worst offenders: {worst}. See SPEC_5_0_M5 §2.")

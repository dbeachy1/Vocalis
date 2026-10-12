"""Logging tests for the loguru-based setup (2.0-M4+).

Covers:
  - generate_timed / generate_with_retry honor out= (capture to a buffer for the
    pool/SSE) vs falling back to loguru when out is None.
  - setup_logging installs a working file sink and an InterceptHandler that routes
    stdlib logging records through loguru.
"""
import io
import logging as stdlogging
import sys

import pytest
import torch
from loguru import logger

import tts_utils
from tts_utils import generate_timed, generate_with_retry, setup_logging

FAKE_SR = 24000


def _wav(seconds=0.5):
    return torch.zeros(1, int(FAKE_SR * seconds))


def _capture_loguru():
    """Add a synchronous StringIO sink; returns (buf, sink_id)."""
    buf = io.StringIO()
    sid = logger.add(buf, format="{message}", level="DEBUG", enqueue=False)
    return buf, sid


# ── out= capture (the pool's per-chunk SSE mechanism) ─────────────────────────

def test_generate_timed_out_captures_to_buffer(capsys):
    buf = io.StringIO()
    generate_timed("hello there", lambda: _wav(), FAKE_SR, label="LBL", out=buf)
    captured = buf.getvalue()
    assert "LBL" in captured          # label captured to the buffer
    assert "c/s" in captured          # stats line captured to the buffer
    # out= path writes ONLY to the buffer — nothing to stdout.
    assert capsys.readouterr().out == ""


def test_generate_timed_default_goes_to_loguru():
    buf, sid = _capture_loguru()
    try:
        generate_timed("hello there", lambda: _wav(), FAKE_SR, label="ONLOG")
    finally:
        logger.remove(sid)
    out = buf.getvalue()
    assert "ONLOG" in out and "c/s" in out


def test_generate_with_retry_forwards_out(capsys):
    buf = io.StringIO()
    generate_with_retry("hello there", lambda c: (lambda: _wav()),
                        FAKE_SR, label="RETRY_LBL", out=buf)
    assert "RETRY_LBL" in buf.getvalue()
    assert capsys.readouterr().out == ""


# ── setup_logging: file sink + stdlib intercept ───────────────────────────────

def test_setup_logging_file_sink_and_intercept(tmp_path):
    logf = tmp_path / "app.log"
    setup_logging(logf)
    try:
        logger.info("direct-loguru-msg")
        stdlogging.getLogger("some.third.party").warning("intercepted-stdlib-msg")
        # complete() blocks until the enqueued records are written (file sink uses enqueue=True),
        # so the read below needs no wait of its own (test_setup_logging_disables_diagnose
        # relies on the same guarantee).
        logger.complete()
        text = logf.read_text(encoding="utf-8")
        assert "direct-loguru-msg" in text
        assert "intercepted-stdlib-msg" in text          # InterceptHandler worked
        # File sink uses the pinned format (module:function:line present).
        assert "test_logging" in text or "tts_utils" in text
    finally:
        # Restore a clean default so a dangling file sink (tmp gets removed) can't
        # break later tests.
        logger.remove()
        logger.add(sys.stderr, level="INFO")


# ── the log scrub (5.0-M2) ────────────────────────────────────────────────────
#
# logs/ lives OUTSIDE the vault by design (you need it to debug a LOCKED server) and it
# rotates x5 — so anything user-facing that lands here is up to ~60 MB of plaintext
# sitting beside the ciphertext. SWEEP §6 found 14 leaks. These are the guards.

SENTINEL = "Xyzzy-Plugh-Sentinel-42"


def test_setup_logging_disables_diagnose(tmp_path):
    """🔴 loguru's default is diagnose=True, which renders every frame's LOCAL VARIABLES
    on logger.exception(). The locals include `job` (job.text = the ENTIRE Playground
    input), the raw SillyTavern chat line, and the Nomi message — so any unhandled render
    error wrote the user's words verbatim into logs/vocalis.log. 24 call sites.
    """
    logf = tmp_path / "v.log"
    setup_logging(logf)

    def render():
        job_text = SENTINEL          # stands in for job.text / the ST chat line
        raise RuntimeError("boom")

    try:
        render()
    except RuntimeError:
        logger.exception("render failed")
    logger.complete()

    body = logf.read_text(encoding="utf-8", errors="replace")
    assert "render failed" in body and "RuntimeError" in body, "the error must still be logged"
    assert SENTINEL not in body, "diagnose=True leaked a local variable (the user's text) into the log"


def test_make_log_path_hashes_the_name(tmp_path):
    """The book's TITLE used to be the log FILENAME — readable by anything that can `ls`,
    with no key at all."""
    p = tts_utils.make_log_path("book", "My Private Novel", tmp_path)
    assert "Private" not in p.name and "Novel" not in p.name and "MyPrivateNovel" not in p.name
    assert p.name.startswith("book_") and p.suffix == ".log"
    # stable per title (same-day runs share a file) and distinct across titles
    assert p == tts_utils.make_log_path("book", "My Private Novel", tmp_path)
    assert p != tts_utils.make_log_path("book", "A Different Book", tmp_path)


def test_chunk_previews_are_not_logged(tmp_path):
    """The 60/120-char text previews. These land in the pool's `out=` buffer, which LOOKS
    like an SSE-only channel — but WorkerPool replays the whole buffer into loguru on the
    SUCCESS path, so they reached disk on every chunk of every render."""
    buf, sid = _capture_loguru()
    try:
        out = io.StringIO()
        generate_timed(SENTINEL + " and the rest of the sentence.", lambda: _wav(),
                       FAKE_SR, label="  chunk [1/1]", out=out)
        # Neither the SSE buffer (which is replayed to loguru) nor loguru itself may carry it.
        assert SENTINEL not in out.getvalue(), "the chunk preview still carries the user's text"
        assert SENTINEL not in buf.getvalue()
    finally:
        logger.remove(sid)


def test_truncation_dump_reports_size_not_text(monkeypatch, tmp_path):
    """The truncation path used to dump 120 chars of the user's text. The CHAR COUNT is
    what diagnoses a truncation; the words never did."""
    monkeypatch.setattr(tts_utils, "_TOKEN_CAP", 1)      # force `truncated`
    out = io.StringIO()
    generate_timed(SENTINEL + " more words here.", lambda: _wav(2.0), FAKE_SR, out=out)

    body = out.getvalue()
    assert "TRUNCATED" in body, "the truncation must still be reported"
    assert SENTINEL not in body, "the truncation dump still leaks the user's text"
    assert "chars" in body


# ── deep exception-chain handling ────────────────────────────────────────────
#
# This is a production logging hazard, so the guard belongs in `src/`, not `conftest.py`.
# `setup_logging` installs `InterceptHandler` at level 0; dependency records and their attached
# exception chains therefore reach the application formatter. Loguru recurses through chained
# exceptions, so a long chain from an optional dependency must not terminate the worker.


#: A chain comfortably under the cap, used to prove the guard is a ceiling and not a
#: blanket refusal to render tracebacks.
_MAX_UNDER_CAP = 5


def _chain(depth):
    """An exception whose `__context__` chain is `depth` links long.

    ⚠️ `__context__` is set by raising INSIDE an `except` block, not by raising in a fresh
    `try` — the first version of this helper did the latter and built a chain of length 1
    while looking correct. Assigning `__context__` explicitly is exactly what the
    interpreter does there, and it keeps the builder O(1) in stack depth, which matters:
    a nested-raise version would need 400 live frames to build the 400-link chain below
    and could hit the very ceiling this file is about.

    Each link still gets a real traceback, because each one is genuinely raised.
    """
    top = None
    for i in range(depth):
        try:
            raise RuntimeError("link %d" % i)
        except RuntimeError as e:
            exc = e
        exc.__context__ = top
        top = exc
    return top


def test_the_chain_depth_walk_follows_the_same_edges_loguru_does():
    assert tts_utils._exc_chain_depth(_chain(1), 50) == 1
    assert tts_utils._exc_chain_depth(_chain(5), 50) == 5
    # Counts to cap+1 and no further: the caller only needs "over the line", and a
    # 4,000-link chain must not cost a 4,000-iteration walk on every log record.
    assert tts_utils._exc_chain_depth(_chain(200), 12) == 13

    # `raise ... from None` sets __suppress_context__; loguru does not follow it, so
    # neither may we, or we would drop a traceback loguru would have rendered fine.
    try:
        try:
            raise ValueError("inner")
        except ValueError:
            raise RuntimeError("outer") from None
    except RuntimeError as e:
        suppressed = e
    assert tts_utils._exc_chain_depth(suppressed, 50) == 1

    # A cyclic chain must terminate rather than spin.
    a, b = RuntimeError("a"), RuntimeError("b")
    a.__context__, b.__context__ = b, a
    assert tts_utils._exc_chain_depth(a, 50) <= 50


def test_a_deep_chain_would_really_blow_the_stack_in_loguru():
    """🔴 VERIFIES THE HAZARD IS REAL, not merely asserted by the guard's own docstring.

    Calls loguru's formatter directly on a chain past the interpreter's ceiling. Without
    this, the guard below could be deleted and every remaining test would still pass.

    ⚠️ The chain is sized from `sys.getrecursionlimit()` rather than pinned at a number.
    loguru recurses ONCE per link, so what is fatal depends on how deep the caller already
    is — the production sighting died at ~40 links inside an xdist worker, and 400 links
    from pytest's much shallower stack does NOT raise. A fixed constant here would either
    be flaky or would quietly stop testing anything.
    """
    from loguru import _better_exceptions

    deep = _chain(sys.getrecursionlimit() + 200)
    fmt = _better_exceptions.ExceptionFormatter(colorize=False, backtrace=True, diagnose=False)
    with pytest.raises(RecursionError):
        "".join(fmt.format_exception(type(deep), deep, deep.__traceback__))

    # And a chain within the cap formats perfectly well — so the guard is a ceiling, not
    # a blanket refusal to render tracebacks.
    ok = _chain(_MAX_UNDER_CAP)
    text = "".join(fmt.format_exception(type(ok), ok, ok.__traceback__))
    assert "link %d" % (_MAX_UNDER_CAP - 1) in text


def test_intercept_handler_drops_a_chain_too_deep_to_render_but_keeps_the_message():
    buf, sid = _capture_loguru()
    handler = tts_utils.InterceptHandler()
    try:
        deep = _chain(tts_utils._MAX_EXC_CHAIN + 30)
        rec = stdlogging.LogRecord(
            name="torio._extension.utils", level=stdlogging.DEBUG, pathname=__file__,
            lineno=1, msg="Failed to load FFmpeg extension.", args=(),
            exc_info=(type(deep), deep, deep.__traceback__))
        handler.emit(rec)                     # must not raise, and must not kill us
        out = buf.getvalue()
        assert "Failed to load FFmpeg extension." in out, "the message itself must survive"
        assert "traceback not rendered" in out, "and it must SAY the traceback was dropped"
        assert "link 0" not in out, "the chain must not have been rendered"
    finally:
        logger.remove(sid)


def test_intercept_handler_still_renders_an_ordinary_traceback():
    """The guard must not have quietly turned every stdlib traceback into a one-liner —
    a real error's stack is the reason InterceptHandler forwards exc_info at all."""
    buf, sid = _capture_loguru()
    handler = tts_utils.InterceptHandler()
    try:
        shallow = _chain(3)
        rec = stdlogging.LogRecord(
            name="some.third.party", level=stdlogging.ERROR, pathname=__file__,
            lineno=1, msg="the render failed", args=(),
            exc_info=(type(shallow), shallow, shallow.__traceback__))
        handler.emit(rec)
        out = buf.getvalue()
        assert "the render failed" in out
        assert "Traceback" in out, "an ordinary exception must still get its traceback"
        assert "traceback not rendered" not in out
    finally:
        logger.remove(sid)


def test_a_message_containing_braces_is_not_run_through_format():
    """Both branches of `emit` must stay argless. `logger.log(level, msg)` with no args
    does NOT call str.format — add one arg and a dependency logging `{"k": 1}` raises
    KeyError inside the handler, which is the failure mode this whole section is about."""
    buf, sid = _capture_loguru()
    handler = tts_utils.InterceptHandler()
    try:
        deep = _chain(tts_utils._MAX_EXC_CHAIN + 5)
        for exc_info in (None, (type(deep), deep, deep.__traceback__)):
            rec = stdlogging.LogRecord(
                name="some.third.party", level=stdlogging.WARNING, pathname=__file__,
                lineno=1, msg='payload {"unclosed": and {0} and {name}', args=(),
                exc_info=exc_info)
            handler.emit(rec)                 # KeyError/IndexError here is the bug
        assert buf.getvalue().count('payload {"unclosed"') == 2
    finally:
        logger.remove(sid)

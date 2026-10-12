"""The extension build stamp tracks extension content independently of the app version.

The extension is copied into SillyTavern, and an already-open tab can continue running older
JavaScript after the copied files change. Polling the content-derived stamp lets the UI detect that
state. Tests verify that the stamp changes with the extension files and remains stable across
application-version-only changes."""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from tts_utils import VERSION
from vocalis.runtime import extstamp, paths

EXT = paths.BASE_DIR / "sillytavern" / "extension" / "index.js"


def test_the_stamp_matches_the_extension_content():
    """🔴 THE DRIFT GUARD, POINTED AT THE THING THAT ACTUALLY DRIFTS. Edit the extension without
    re-stamping and every tab that loaded the old copy reports a stamp equal to the new one — the
    staleness signal goes silent in exactly the case it exists for."""
    assert extstamp.declared() == extstamp.compute(), (
        f"the extension says it is {extstamp.declared()} and its content hashes to "
        f"{extstamp.compute()}.\n"
        "  You changed sillytavern/extension/ without re-stamping it. Run:\n"
        "      python scripts/stamp-extension.py\n"
        "  Do NOT hand-edit EXT_BUILD — it is derived, and a typed value cannot stay true.")


def test_the_stamp_is_NOT_the_release_version():
    """🔴 THE REGRESSION GUARD FOR THE BUG THIS FILE USED TO ENFORCE.

    The failure mode is a well-meaning session "tidying" the stamp back into step with the release
    — it looks neater, every previous release did it, and nothing else would complain. This is the
    line that complains. A stamp equal to `VERSION` is not a coincidence; it is the coupling back.
    """
    stamp = extstamp.declared()
    assert stamp != VERSION, (
        f"EXT_BUILD is {stamp}, which is the release version. The stamp must describe the\n"
        "  EXTENSION's content, not Vocalis's release — see vocalis/runtime/extstamp.py for the\n"
        "  measurement (11 of the last 14 extension commits were the stamp and nothing else).")
    assert re.fullmatch(r"[0-9a-f]{%d}" % extstamp.STAMP_LEN, stamp), (
        f"EXT_BUILD is {stamp!r}, which is not a content hash. It is written by\n"
        "      python scripts/stamp-extension.py")


def test_a_release_that_does_not_touch_the_extension_leaves_the_stamp_alone():
    """The test proves the property in both directions.

    ⚠️ AND IT IS NOT VACUOUS — BOTH ARMS RUN. Asserting only that an untouched tree keeps its stamp
    would pass just as happily against a `compute()` that returned a constant, which is the exact
    shape of "a guard can be decoration". So this also changes a real file and requires the stamp
    to MOVE. A stamp that never changes is as broken as one that always does; it just fails the
    other way, silently, on the day the extension really is stale.
    """
    src = extstamp.extension_dir()
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        a = Path(td) / "a"
        shutil.copytree(src, a)
        before = extstamp.compute(a)

        # A release with no extension change: nothing under this directory moved.
        assert extstamp.compute(a) == before, "compute() is not stable over an unchanged tree"

        # 🔴 AND EDITING THE STAMP LINE ALONE MUST NOT MOVE IT — that self-exclusion is what makes
        # `stamp-extension.py` terminate instead of chasing its own tail.
        idx = a / "index.js"
        idx.write_text(
            extstamp.STAMP_RE.sub("const EXT_BUILD = 'deadbeefcafe';", idx.read_text(encoding="utf-8"), count=1),
            encoding="utf-8", newline="")
        assert extstamp.compute(a) == before, \
            "the stamp line is inside its own hash — re-stamping would never converge"

        # …but a REAL change must move it.
        idx.write_text(idx.read_text(encoding="utf-8") + "\n// a real change\n",
                       encoding="utf-8", newline="")
        assert extstamp.compute(a) != before, \
            "compute() did not notice a changed file — the stamp would never report a stale tab"


def test_the_stamp_survives_a_line_ending_flip():
    """Windows and Linux checkouts can hold different newline bytes, so hashing raw bytes would
    make the same extension appear stale. The content stamp must normalize line endings."""
    src = extstamp.extension_dir()
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        a = Path(td) / "a"
        shutil.copytree(src, a)
        want = extstamp.compute(a)
        for name in extstamp.FILES:
            p = a / name
            p.write_text(p.read_text(encoding="utf-8").replace("\n", "\r\n"), encoding="utf-8", newline="")
        assert extstamp.compute(a) == want, 'CRLF changed the stamp — Windows and Linux would disagree'


def test_the_stamp_actually_rides_the_poll():
    """⚠️ A CONSTANT NOBODY SENDS IS DECORATION. The value has to reach `/pair/poll`, which is the
    one message this side emits unconditionally — the sweep and the send both go quiet when there
    is nothing to do, and a signal that only travels when something is already working cannot
    diagnose the case where nothing is."""
    src = EXT.read_text(encoding="utf-8")
    assert re.search(r"pairPoll\([^)]*EXT_BUILD", src), \
        "EXT_BUILD is defined but never passed to pairPoll — nothing would ever report it"

    wire = (paths.BASE_DIR / "sillytavern" / "extension" / "vocalis-stream.js").read_text(encoding="utf-8")
    # The query is assembled with URLSearchParams now that two fields ride it, so the literal
    # "build=" no longer appears in the source — the set() call is what puts it on the wire.
    assert "params.set('build'" in wire, "pairPoll does not put the stamp on the request"


def test_the_tab_checks_itself_against_what_sillytavern_served_it():
    """The tab compares its running stamp with the extension file served to that tab.

Hashing a repository copy cannot establish what SillyTavern served. The extension therefore fetches
its own URL without cache and compares the served stamp with its running build stamp."""
    src = EXT.read_text(encoding="utf-8")
    assert "import.meta.url" in src,         "the self-check must read the file THIS TAB was loaded from, not a path built from guesses"
    assert re.search(r"fetch\(\s*url\.href", src), "checkOwnBuild does not fetch its own file"
    assert "cache: 'no-store'" in src,         "a cached copy answers the question the check exists to ask, with last week's bytes"
    assert re.search(r"===\s*EXT_BUILD\s*\?\s*'current'\s*:\s*'stale'", src),         "the verdict must be the served stamp against the RUNNING one"


def test_a_tab_that_could_not_check_is_not_called_stale():
    """🔴 SILENCE IS NOT EVIDENCE — the one part of the old `is_stale` worth keeping.

    A 404, a network blip, a file whose stamp line cannot be found: none of those is proof the tab
    is old. Nor is an older extension that does not self-check at all. Only an explicit "stale"
    accuses, and both the wire and the pane have to agree on that or the guarantee is half-built.
    """
    wire = (paths.BASE_DIR / "src" / "vocalis" / "web" / "pair.py").read_text(encoding="utf-8")
    assert '("current", "stale", "unknown")' in wire,         "the poll must clamp the reported verdict to the words it may be"

    pane = (paths.BASE_DIR / "src" / "vocalis" / "web" / "wbedit.py").read_text(encoding="utf-8")
    assert '"stale": st.get("self_check") == "stale"' in pane,         "only an explicit \"stale\" may accuse; \"\" and \"unknown\" must read as not-stale"

    ext = EXT.read_text(encoding="utf-8")
    for bail in ("response.ok", "!served"):
        assert bail in ext,             f"the self-check must leave its answer alone when {bail} says it could not find out"


def test_the_verdict_actually_rides_the_poll():
    """⚠️ A CHECK NOBODY SENDS IS DECORATION — same reasoning as the stamp above it. The verdict has
    to reach `/pair/poll`, the one message this side emits unconditionally."""
    src = EXT.read_text(encoding="utf-8")
    assert re.search(r"pairPoll\([^)]*EXT_BUILD,\s*self", src),         "checkOwnBuild's answer is computed and then not passed to pairPoll"

    wire = (paths.BASE_DIR / "sillytavern" / "extension" / "vocalis-stream.js").read_text(encoding="utf-8")
    assert "params.set('self'" in wire, "pairPoll does not put the verdict on the request"

    server = (paths.BASE_DIR / "src" / "vocalis" / "web" / "pair.py").read_text(encoding="utf-8")
    assert 'request.args.get("self")' in server, "the poll route never reads the verdict it is sent"


def test_nothing_decides_staleness_by_reading_this_repo():
    """🔴 THE REGRESSION THIS FILE NOW EXISTS TO CATCH. `extstamp` still hashes this repo's files —
    that is how the stamp gets WRITTEN, and it is the right answer to a question about this repo.
    What must never come back is a staleness verdict derived from it, because this repo's copy is
    not the one SillyTavern serves."""
    assert not hasattr(extstamp, "is_stale"),         "is_stale is back: staleness must not be decided by reading a directory on this side"

    pane = (paths.BASE_DIR / "src" / "vocalis" / "web" / "wbedit.py").read_text(encoding="utf-8")
    body = re.sub(r"^\s*#.*$", "", pane, flags=re.M)  # comments explain the old bug; they are not code
    assert "extstamp" not in body, "the send status is reading the local extension copy again"
    assert "build != VERSION" not in body,         "the release version is back in the staleness comparison — that is the 9.7.2 regression"

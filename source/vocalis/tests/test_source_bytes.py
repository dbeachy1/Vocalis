"""No tracked source file may carry a RAW control byte. Escape it, or grep goes blind.

🔴 WHAT THIS IS ABOUT, AND IT IS NOT TIDINESS. `src/webui/js/util/dom.js` held a literal NUL at
line 158 — `const k = label + '<NUL>' + id;`, where `'\\0'` was plainly meant. A NUL makes GNU
grep, ripgrep and every other content search classify the whole file as **binary** and skip it:
the search prints `Binary file src/webui/js/util/dom.js matches` and not one line of context. So
one of the tree's shared utility modules was invisible to text searches, even though its
JavaScript behavior remained intact.

🔴 AND GIT TREATED IT AS BINARY TOO, WHICH IS THE BIGGER HALF. A NUL turns off
git's text handling for the whole file: no readable `git diff`, no line-level merge, and no
end-of-line normalization — so dom.js was the one source file in this tree stored with CRLF
in the repository while every other text file is stored with LF. Escaping the byte let git
normalize it, which is why that one commit shows all 249 lines as changed for a ONE-BYTE edit.
Do not "fix" that back: the blob is now stored the way the rest of the tree is.

The byte did not change runtime output: esbuild normalizes it to "\\0". The failure was in
source inspection, because text searches and Git treated the file as binary. This test protects
that searchability boundary and checks the same class in other tracked files.

⚠️ THE SAME CLASS CAN AFFECT ANY TRACKED SOURCE FILE: an escape sequence was typed as the
byte it represents:

    src/wbedit/prompt/settings.py    h.update(b"<0x02>")  — next to a correct h.update(b"\\x01")
    tests/test_satellite_setup.py    red = "<ESC>[1m<ESC>[31m"  and three more on the lines below

All three were behavior-neutral to fix: the byte in the file and the byte the escape produces
are the same byte, so `bundle/app.js` did not move (proved by a build-and-diff, not assumed).
That is what makes a zero-tolerance rule affordable here — there is no legitimate reason to type
the byte instead of the escape, and no cost to writing the escape.

📌 SHIPPED AT ZERO, NOT AS A RATCHET. A count would say "three are allowed", and a budget for
raw control bytes invites spending it (see feedback_never_offer_suppression_as_an_option). The
tree is at zero as of this commit and the honest gate is zero.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

# REPO_ROOT is imported for its sys.path side effect AND used below, so no noqa is
# needed here — one fewer suppression for test_webui_types.py's ratchet to carry.
from conftest import REPO_ROOT

ROOT = Path(REPO_ROOT)

#: Tab, newline and carriage return are the only control bytes that belong in a text file.
#: CRLF is the house line ending on this tree, so 13 is as ordinary as 10 here.
ALLOWED = {0x09, 0x0A, 0x0D}

#: Generated or vendored. `src/webui/bundle/` is esbuild's output — it is checked against the
#: sources by test_webui_bundle.py, and a control byte there could only have come from a source
#: file this scan already covers.
SKIP_DIRS = ("venv/", "node_modules/", "temp/", "src/webui/bundle/")

#: Every extension in this tree that a human edits and a search is expected to reach. Broader
#: than the list in test_webui_types.py on purpose: `.html`, `.css` and `.md` are searched just
#: as often, and a NUL blinds grep to them exactly the same way.
TEXT_EXTS = (".py", ".js", ".mjs", ".ts", ".json", ".yaml", ".yml", ".cfg", ".ini",
             ".html", ".css", ".md", ".sh", ".toml", ".txt")

#: 🔴 THE WINDOW GUARD. Every check in this file is "no file has X", which is trivially true of
#: an empty list — and a scan that silently stops matching (a renamed directory, a changed
#: `git ls-files` invocation, a typo in an extension) passes LOUDER as it covers less. So the
#: scan's own reach is asserted: a floor on the count, and two files that must be in it.
#: See feedback_a_guard_is_only_as_good_as_its_window.
MIN_FILES = 500
MUST_INCLUDE = ("src/webui/js/util/dom.js", "tests/conftest.py", "src/tts_utils.py")


def _tracked_text_files():
    """Every tracked file a human edits, as (repo-relative path, bytes)."""
    listed = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    for line in listed.stdout.splitlines():
        rel = line.strip()
        if not rel or rel.startswith(SKIP_DIRS) or not rel.endswith(TEXT_EXTS):
            continue
        path = ROOT / rel
        if path.is_file():
            yield rel, path.read_bytes()


def raw_control_bytes(data: bytes) -> list[int]:
    """The distinct C0 control bytes in `data`, tab/LF/CR excluded. Empty is the good answer.

    Split out from the test so `test_the_scan_can_actually_fail` can feed it a known-bad input.
    A guard nobody has watched fail is decoration.
    """
    return sorted({b for b in data if b < 0x20 and b not in ALLOWED})


def test_no_tracked_source_file_holds_a_raw_control_byte():
    offenders = {}
    for rel, data in _tracked_text_files():
        found = raw_control_bytes(data)
        if found:
            offenders[rel] = found
    assert not offenders, (
        "these files hold RAW control bytes where an escape sequence was meant:\n"
        + "\n".join(
            f"  {rel}: {', '.join(f'0x{b:02x}' for b in codes)}"
            for rel, codes in sorted(offenders.items())
        )
        + "\n"
        "\n  A NUL (0x00) makes grep and ripgrep treat the whole file as BINARY and skip it, so"
        "\n  the file stops answering content searches without anything failing. The others are"
        "\n  the same mistake with a less dramatic symptom."
        "\n  THE FIX IS THE ESCAPE, NOT AN EXCEPTION HERE: '\\0', '\\x02', '\\x1b'. The byte the"
        "\n  escape produces is the byte that was in the file, so behavior does not change —"
        "\n  verify with a bundle build-and-diff if the file is one esbuild reads."
    )


def test_the_scan_reaches_the_tree_it_claims_to():
    """🔴 The vacuity guard: a scan that matches nothing passes every assertion above it."""
    seen = {rel for rel, _ in _tracked_text_files()}
    assert len(seen) >= MIN_FILES, (
        f"the scan found only {len(seen)} files (floor {MIN_FILES}) — it has stopped reaching the "
        "tree, and 'no file holds a control byte' is then true of almost nothing. Check "
        "SKIP_DIRS, TEXT_EXTS and that `git ls-files` still runs from the repo root."
    )
    missing = [p for p in MUST_INCLUDE if p not in seen]
    assert not missing, (
        f"these files are no longer in the scan: {missing}. dom.js is the file the whole check "
        "was written for; if it has fallen out, the check is guarding a tree that no longer "
        "contains the problem."
    )


def test_the_scan_can_actually_fail(tmp_path):
    """A detector nobody has watched fire is decoration — so fire it, on all three real shapes."""
    assert raw_control_bytes(b"ordinary source\r\n\twith tabs\n") == []
    assert raw_control_bytes(b"const k = label + '\x00' + id;") == [0x00]      # the dom.js one
    assert raw_control_bytes(b'h.update(b"\x02")') == [0x02]                   # the settings.py one
    assert raw_control_bytes(b'red = "\x1b[1m"') == [0x1B]                     # the satellite one
    # And the whole way through: a file on disk, read the way the scan reads it.
    bad = tmp_path / "sample.js"
    bad.write_bytes(b"export const sep = '\x00';\r\n")
    assert raw_control_bytes(bad.read_bytes()) == [0x00]

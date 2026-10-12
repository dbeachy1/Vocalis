"""6.0 §2 — selecting a range and the bar that prices it, driven in a real browser.

Three of the things this covers are invisible to every other kind of test, and each of them is
a defect the design names explicitly:

  * §2.2 — **the menu is appended to `body`.** Built inside `.mes_buttons` it is CLIPPED by ST's
    message button row and mostly off screen. The source looks identical either way; only a
    browser can tell you which parent it ended up with.
  * §2.4 — **the count comes from `chat`, not the DOM.** `getContext().chat` is the entire chat
    array regardless of `chat_truncation` or the fork's message window, and that fact is what
    makes selecting a range 4,000 messages back free. A count taken off the DOM would silently
    mean "the part you have scrolled into view" — right in the fixture, wrong in every real
    chat. The page here holds 40 messages and paints 10, so the two answers differ.
  * a **leaked document keydown listener.** The menu's number-key handler is on `document`,
    because a click anywhere must dismiss the menu. Remove the node without removing the
    listener and it swallows the digits 1–5 for the rest of the session — which in SillyTavern
    means typing a number into the message box stops working, a symptom nobody would trace back
    to a menu that closed ten minutes ago.

It drives the REAL, unmodified `index.js`; only the transport module is stubbed, so what is
asserted about the Create payload is the bytes the server would actually receive. That matters
most for the one check spelled 🔴 in the spec: every item must be `bodyFor()` output, or the
cache keys never match and the whole range re-renders silently (the 5.4 landmine, §3.1).

Skips without Node or Chrome.
"""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from test_voices_player_browser import _chrome        # noqa: E402

NODE = shutil.which("node")
HERE = Path(__file__).parent
EXT = HERE.parent / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_range_selects_counts_and_posts_what_the_server_expects():
    r = subprocess.run(
        [NODE, str(HERE / "st_scene_range_spec.mjs"), str(EXT), str(HERE / "st_dom_shim.js"),
         _chrome()],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    assert r.returncode == 0, f"scene range spec failed:\n{r.stdout}\n{r.stderr}"

    # A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("the menu is appended to BODY",
                  # 7.4 — this used to be "four items with no range yet", a magic count that broke
                  # when the menu grew two per-message rows. It asserts the RULE now.
                  '"Create audio scene…" appears only once a range exists',
                  "counted from `chat`, NOT from the 10 rows in the DOM",
                  "a leaked one eats the number keys",
                  "every item is bodyFor() output",
                  # 6.2 — the buttons go green as the build caches them, not in one lump at the
                  # end. The "while the bar still says Building" half is the whole assertion:
                  # without it the check passes against the defect it exists to catch.
                  "precondition: no message is green when the build starts",
                  "turns its speaker green, with no other event",
                  "while the bar still says Building",
                  "never asked about again",
                  # 9.2 §2.5 — one message added or removed at a time. The two that matter are
                  # the ones a naive implementation gets wrong: the bar has to COUNT the hole
                  # (off screen it is the only evidence there is), and the hole has to survive
                  # the next move of an endpoint.
                  "the bar SAYS one was skipped",
                  "is STILL out after the endpoint moved",
                  "an added message is not inside it",
                  "with no hole carried over from the last one"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

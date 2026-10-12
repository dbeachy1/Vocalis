"""9.6.4 §18f — a new chat's greeting is preloaded when preloading is enabled.

SillyTavern emits CHAT_CHANGED and CHARACTER_MESSAGE_RENDERED during chat setup. In a solo chat,
the two requests can race; in a group chat, cancellation follows the greeting. Because
PrerenderQueue.cancel(None) clears queued and running work, either ordering can discard the new
greeting. The browser spec exercises the real event sequence and models cancellation explicitly;
a no-op cancel stub would hide this failure.

The assertions inspect the bodies still held by the server, not just whether a request was sent.
"""
import shutil
import subprocess
from pathlib import Path

import pytest
from test_voices_player_browser import _chrome

NODE = shutil.which("node")
HERE = Path(__file__).parent
EXT = HERE.parent / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_a_new_chats_greeting_is_preloaded():
    r = subprocess.run(
        [NODE, str(HERE / "st_newchat_preload_spec.mjs"), str(EXT), str(HERE / "st_dom_shim.js"),
         _chrome()],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    assert r.returncode == 0, f"the new-chat preload spec failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 A SPEC THAT STOPPED CHECKING EARLY EXITS 0 AS HAPPILY AS ONE THAT PASSED. Each claim is
    # named, including the two that prove the fixture itself is not vacuous — without a live
    # pre-render to stand down there is no cancel, and without a cancel there is no bug.
    for named in ("the outgoing chat has a live pre-render to stand down",
                  "the race is real, not stubbed away",
                  "greeting is still held by the server after the stand-down",
                  "nothing from the chat he left is held with it",
                  "group chat's newest greeting survives the CHAT_CHANGED that follows it",
                  "a chat change alone preloads the newest message",
                  "a greeting populated after CHAT_CHANGED is still submitted",
                  "preloads nothing",
                  'with "Pre-render new messages" unticked, a new chat preloads nothing',
                  "two chat changes inside one stand-down still leave the settled chat held",
                  "nothing of the chat he abandoned is held"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

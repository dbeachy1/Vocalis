"""7.0 code review §5.1 — persona edits must reach the flat fields consumed by the prompt.

writePersona updates the stored descriptor, while SillyTavern reads flat settings fields and
synchronizes them when a persona is switched. The edit must update those fields directly and
avoid a stale textarea overwriting the change. The spec evaluates the extracted function against
controlled settings and verifies create/merge ordering, persistence, collision handling, and
failure reporting without connecting to a SillyTavern server.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

# 9.0.12 - the browser-spec output guard. Importing conftest is also the sys.path side effect
# every other browser wrapper in this tree relies on.
from conftest import assert_spec_ran

NODE = shutil.which("node")
SPEC = Path(__file__).parent / "st_persona_sync_spec.mjs"
EXT = Path(__file__).parent.parent / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_a_persona_edit_reaches_the_fields_the_prompt_actually_reads():
    r = subprocess.run([NODE, str(SPEC), str(EXT)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=60)
    assert r.returncode == 0, f"persona sync spec failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE - they catch different things. A name list catches
    # one check being dropped; it cannot catch an EARLY RETURN, because the names it checks are
    # near the top by construction. ⚠️ MEASURED, not derived: conftest's derivation refuses on this
    # spec, and a floor under the true count reads as a guard while permitting the very drift it
    # exists to catch.
    # 11.1.8 raised this from 49 to 75 — measured off a green run, which is the whole count and
    # not a margin under it. Every ok() here is unconditional, so a correct run cannot come out
    # lower and a lower one means the spec stopped early.
    assert_spec_ran(r, SPEC, floor=75)
    # ⚠️ A spec that silently stopped checking exits 0 as happily as one that passed — the
    # anti-deletion rule the browser specs use, applied here for the same reason.
    for named in ("the flat field the PROMPT reads is updated",
                  "his next keystroke cannot write the old text back",
                  "editing a background persona leaves the active one alone",
                  "a closed Persona panel does not throw mid-send",
                  "a key the descriptor does not carry is left as it was",
                  # §9a.11 / 7.5.16 — createPersona, run for real. These four are the
                  # decisions that touch external SillyTavern data and cannot be taken back.
                  "the ref is minted their way",
                  "the descriptor defaults match initPersona",
                  "the two power_user keys are written BEFORE the avatar file exists",
                  "rolls the two keys back",
                  "a colliding ref is stepped past, never reused",
                  "the existing persona remains unchanged",
                  "the ref recorded is the path their server answered with",
                  "it uploads THEIR default, as createDummyPersona does",
                  # A host integration run exposed this defect: a scheduled write is
                  # not a write, and on a create that difference is a one-way door.
                  "is reported as a FAILURE, not a success",
                  "carries NO ref, so Vocalis cannot adopt a persona that was never saved",
                  "reads the settings back before answering ok",
                  # 7.5.18 — the same lie, on the MERGE branch. The middle two are the ones
                  # worth their line: a merge's persona key is ALREADY saved, so checking the
                  # key rather than the FIELDS is a poll that waits for nothing and passes.
                  "settingsLanded is present in index.js",
                  "writePersona is present in index.js",
                  "a merge answers ok only after the edit is read back out of settings.json",
                  "because it is the FIELDS that are checked",
                  "clearing a title with null is recognized as landed",
                  "refused, never recreated by the merge",
                  # 🔴 11.1.8 — a new persona picture stayed invisible until a hard reload.
                  # `getUserAvatars(true)` re-renders the row from the URL it already had, and the
                  # URL is the browser's cache key.
                  "the browser cache is busted under the avatar FILENAME",
                  "never under the display name, which addresses no file",
                  "AFTER the panel repaint",
                  "a merge with no picture busts nothing"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

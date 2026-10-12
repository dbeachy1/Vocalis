"""Folder behavior is covered at two levels. Browser specs exercise individual panels, while this source-level census checks that every panel which adds folders also exposes a way to remove a row and wires both click and drag behavior. It also keeps server scopes either represented by a panel or explicitly listed as unrendered.

The source scan strips comments before matching code so explanatory examples cannot satisfy an assertion about actual call sites."""
import ast
import re
from pathlib import Path

import pytest

import folders

JS = Path(__file__).parent.parent / "src" / "webui" / "js"
SRC = Path(__file__).parent.parent / "src"

# The shared module DEFINES these; every other file may only CALL them.
SHARED = JS / "ui" / "folders.js"


def _panel_sources():
    """Return client modules with comments stripped before source contracts are counted.

Several checks search for call expressions. Keeping explanatory mentions out of the input prevents a comment from hiding a missing call or making a check pass without executable code."""
    return {
        p: _strip_js_comments(p.read_text(encoding="utf-8", errors="replace"))
        for p in JS.rglob("*.js")
        if p != SHARED
    }


def _strip_js_comments(src: str) -> str:
    """Blank out `//` and `/* */` comments, preserving line numbering.

    ⚠️ STRING-AWARE, because a `//` inside a URL or a `/*` inside a regex is not a comment, and
    because these modules are dense with template literals holding markup. Newlines are kept so a
    reported line number still points at the right line. Same job as `tests/_jscomments.mjs` does
    for the JS side; a local copy rather than an import so this file has no cross-test dependency.
    """
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":  # a string — copy it whole, honoring escapes
            q = c
            out.append(c)
            i += 1
            while i < n:
                out.append(src[i])
                if src[i] == "\\":
                    if i + 1 < n:
                        out.append(src[i + 1])
                        i += 2
                        continue
                elif src[i] == q:
                    i += 1
                    break
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                if src[i] == "\n":
                    out.append("\n")  # keep the line count honest
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _call_args(src: str, fn: str):
    """Every `fn(...)` call in `src`, as the raw argument text, brace/paren/quote aware.

    ⚠️ NOT A REGEX ON THE WHOLE CALL. The 4th argument is an object literal holding an arrow
    function — `{ selected: () => [...vsLibSel] }` — so a lazy `\\(([^)]*)\\)` stops at the first
    `)` inside it and reports the argument list as absent. That is the exact shape being checked,
    so getting it wrong would make this file pass by never looking. Depth counting is the cheapest
    thing that is actually correct here, and it skips string bodies so a `)` inside a title=
    tooltip cannot close the call either.
    """
    out = []
    for m in re.finditer(re.escape(fn) + r"\s*\(", src):
        i = m.end()
        depth, quote, esc = 1, "", False
        start = i
        while i < len(src) and depth:
            c = src[i]
            if quote:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == quote:
                    quote = ""
            elif c in "\"'`":
                quote = c
            elif c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
            i += 1
        if not depth:
            out.append(src[start : i - 1])
    return out


def _add_button_calls():
    """`(path, argument-text)` for every `folderAddButton(...)` call outside the shared module."""
    hits = []
    for p, s in _panel_sources().items():
        for args in _call_args(s, "folderAddButton"):
            # An `import { folderAddButton, … }` line is not a call; the paren scan cannot land on
            # one (no `(` follows the name), but a defensive check costs nothing.
            hits.append((p.relative_to(JS).as_posix(), args))
    return hits


# 🔴 THE FLOOR IS THE POINT. Nine panels satisfy the contract today; the risk this file exists for
# is a TENTH that does not. A census with no floor passes on an empty list — the classic vacuous
# scan — so the count is pinned and a new panel has to come here and say so deliberately.
# ⚠️ Raise it when you ADD a folder-enabled panel. Never lower it to make a red suite green: a
# panel that lost its `✚ Folder` button lost the feature, which is the thing being tested.
# DOCKER EDITION: 11 -> 7. The four panels that went with the excluded surfaces are Voice Training's
# clip picker and trained-voice list (vtPicker, vtVoices), and Voice Swap's source picker and
# finished-songs library. The seven that remain are ace/tray.js, book/library.js, media/speech.js,
# media/stems.js (x2: the song picker and the Stems library), pg/playground.js and voices/voices.js.
# This is a re-measured floor for a smaller product, not a lowered check: each remaining panel is
# still held to every contract below.
EXPECTED_PANELS = 7  # 11 in the legacy app. 9.0.6: the Speech clip library (`#spList`) joined, over the same
#                       `train_sources` scope Voice Training's picker already files into. It was
#                       the LAST panel rendering a folder-stamped dataset flat: the server has
#                       stamped every row since 8.9 and this screen discarded the field, so a clip
#                       filed anywhere else read as unfiled here. Raised deliberately, with a
#                       browser spec — and the floor went red the moment the panel was wired,
#                       which is the transaction it exists to force.
#                     # 8.9.14: Stems ▸ 🎵 Songs (`#ssPicker`) joined, over the same
#                       `voiceswap_songs` scope Voice Swap ▸ Sources already filed into.


def test_every_panel_that_can_make_a_folder_can_also_take_a_row_back_out():
    """Every `folderAddButton` call must supply the selection callback that exposes `⇤ Remove from folder`. Without it, a panel can add rows to a folder but cannot return them to the root. This census catches missing wiring across all panels; browser tests cover click behavior."""
    missing = [where for where, args in _add_button_calls() if not re.search(r"\bselected\s*:", args)]
    assert not missing, (
        "these panels build a ✚ Folder button and pass no `selected` callback, so they get NO\n"
        "`⇤ Remove from folder` and a row filed there can never be taken back to the root:\n\n  "
        + "\n  ".join(missing)
        + "\n\nPass `{ selected: () => [...yourTickSet] }` as the 4th argument."
    )


def test_the_number_of_folder_panels_is_pinned():
    """A census with no floor cannot fail; this is the floor. See EXPECTED_PANELS."""
    found = _add_button_calls()
    assert len(found) == EXPECTED_PANELS, (
        f"expected {EXPECTED_PANELS} `folderAddButton` call sites, found {len(found)}:\n  "
        + "\n  ".join(w for w, _ in found)
        + "\n\nAdded a folder-enabled panel? Raise EXPECTED_PANELS and give it a browser spec.\n"
        "Removed one? Say so in the commit — a panel losing ✚ Folder is a feature being deleted."
    )


def test_every_panel_that_can_make_a_folder_also_draws_move_selected_here():
    """The other half of the same gesture, and it is a SEPARATE flag asserting the SAME fact.

    `folderBar(e, {selectable: true})` draws `⇥ Move selected here` on each folder row;
    `folderAddButton`'s `selected` draws `⇤ Remove from folder` on the toolbar. Nothing in the
    shared module couples them, so a panel can legally have one and not the other — filing with no
    way out, or a way out with no way in. Every file that builds one must build the other.
    """
    bad = []
    for p, s in _panel_sources().items():
        if not _call_args(s, "folderAddButton"):
            continue
        bars = _call_args(s, "folderBar") + _call_args(s, "folderBarRow")
        if not bars:
            bad.append(f"{p.relative_to(JS).as_posix()}: builds ✚ Folder but never calls folderBar")
        # 🔴 EVERY call, not ANY — and this line was `any` until a mutation test caught it. A panel
        # can render more than one list through one toolbar: `media/swaplib.js` draws folder rows
        # in its flat views AND in the Parts view, and Parts shipped 8.9 with
        # `folderBar(d, {selectable: false})` and a note explaining that a card is not a row with a
        # checkbox — which was the bug. Under `any`, deleting `selectable: true` from one of a
        # file's two calls left the other satisfying the assertion, so the exact regression this
        # test is named for passed. A window wide enough to hold a second call is a window that
        # cannot see the first one break.
        for b in bars:
            if not re.search(r"selectable\s*:\s*true", b):
                bad.append(f"{p.relative_to(JS).as_posix()}: a folderBar call without `selectable: true`")
    assert not bad, "⇥ Move selected here is missing where ✚ Folder exists:\n  " + "\n  ".join(bad)


def test_every_panel_that_can_make_a_folder_wires_its_host_for_clicks_and_drags():
    """`folderWire` enables the folder rows' buttons, while `folderWireDrag` supports drag-to-folder. A panel needs both handlers for both supported interactions."""
    bad = []
    for p, s in _panel_sources().items():
        if not _call_args(s, "folderAddButton"):
            continue
        for fn in ("folderWire", "folderWireDrag"):
            # `folderWire` is a prefix of `folderWireDrag`, so count the exact-name calls only.
            if not re.search(re.escape(fn) + r"\s*\(", re.sub(r"folderWireDrag", "folderWireDRAG", s) if fn == "folderWire" else s):
                bad.append(f"{p.relative_to(JS).as_posix()}: never calls {fn}")
    assert not bad, "a folder panel is unwired:\n  " + "\n  ".join(bad)


def _client_scopes():
    """The scope strings the CLIENT actually declares, from its `const *_SCOPE = '…'` lines.

    ⚠️ NOT A SUBSTRING SEARCH FOR THE SCOPE NAME. `scenes` is a whole directory in this tree
    (`js/scenes/scenes.js`), so "does the string appear anywhere" answers yes for a scope with no
    folder UI at all — a scanner counting MENTIONS instead of occurrences, which is the way this
    kind of test goes quietly vacuous. Every panel names its scope in exactly one place and in
    exactly this shape; that declaration is the honest signal.
    """
    out = {}
    for p, s in _panel_sources().items():
        for m in re.finditer(r"^const\s+\w*SCOPE\w*\s*=\s*['\"]([a-z_]+)['\"]", s, re.M):
            out.setdefault(m.group(1), []).append(p.relative_to(JS).as_posix())
    return out


# `scenes` has a rename hook and a place in SCOPES and NOTHING renders it — the Clips listing never
# calls `for_rows` and the Clips tab has no ✚ Folder button. Maintained infrastructure for a feature
# nobody built; the explicit choice to keep it tracked as unrendered, and named here so the others are
# actually checked rather than the whole list being waved through.
#
# DOCKER EDITION: `voices_rvc` (Training/Voice-Swap voice lists) and `swap_library` (Voice Swap finished
# songs) stay in the server registry (`folders.SCOPES`) but their screens were excluded from this
# image, so no client module declares them. They are listed here for the same reason `scenes` is: the
# assertion below still fails if a client module ever declares one, which is the signal to move it back
# out of this set and give its panel a browser spec.
UNRENDERED = {"scenes", "voices_rvc", "swap_library"}


@pytest.mark.parametrize("scope", folders.SCOPES)
def test_every_server_scope_is_either_rendered_by_a_panel_or_declared_unrendered(scope):
    """🔴 THE INVENTORY, SO AN ORPHAN SCOPE IS A DECISION AND NOT AN ACCIDENT."""
    declared = _client_scopes()
    if scope in UNRENDERED:
        assert scope not in declared, (
            f"`{scope}` is listed here as deliberately unrendered, but a client module now "
            f"declares it ({declared.get(scope)}) — if the panel was built, take it out of "
            f"UNRENDERED and give it a browser spec."
        )
        return
    assert scope in declared, (
        f"the server declares scope `{scope}` in folders.SCOPES but no client module declares it, "
        f"so nothing can ever file a row into it. Build the panel, or retire the scope."
    )


def test_composed_refs_carry_their_folder_across_a_rename():
    """🔴 A ROW CAN LIVE IN TWO SCOPES AT ONCE, AND BOTH ASSIGNMENTS HAVE TO MOVE.

    Voice Swap ▸ Sources merges five stores into one list and COMPOSES the refs it does not own:
    a speech clip is `speech/<filename>` and a Playground clip is `pg/<vdir>/<stem>`, both in the
    `voiceswap_songs` scope. Those are second assignments, keyed on strings no `train_sources` or
    `playground_clips` rekey can reach — so before 8.9.14 renaming either clip left its Voice Swap
    row filed under a ref that no longer existed, and `for_rows` dropped it in silence. Exactly the
    failure `test_folders_rename_hooks.py` exists for, in the one place that file structurally
    cannot see: it enumerates `RENAME_MOVES_REF`, and this hazard belongs to a scope that is not in
    it and should not be (`voiceswap_songs` refs are content-addressed for the stores it owns).
    """
    hay = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in SRC.rglob("*.py"))
    for prefix in ('"speech/"', '"pg/"'):
        pat = re.compile(r"folders\.rekey\s*\([^)]*?voiceswap_songs[^)]*?" + re.escape(prefix), re.S)
        assert pat.search(hay), (
            f"no `folders.rekey(..., 'voiceswap_songs', ...)` carries the {prefix} composed ref "
            f"across a rename — the Voice Swap ▸ Sources row silently leaves its folder."
        )


def test_the_shared_module_is_the_only_place_a_folder_button_is_built():
    """One producer, so the contract above is enforceable at all.

    A hand-rolled `✚ Folder` somewhere in a panel would bypass `folderAddButton` entirely, get no
    `⇤ Remove from folder`, and make every census in this file blind to it.
    """
    stray = []
    for p, s in _panel_sources().items():
        # `_panel_sources` has already stripped comments — see its docstring for why that is
        # load-bearing rather than tidy.
        for line_no, line in enumerate(s.splitlines(), 1):
            if "✚ Folder" in line or "Create folder" in line or "New folder" in line:
                stray.append(f"{p.relative_to(JS).as_posix()}:{line_no}: {line.strip()[:90]}")
    assert not stray, (
        "a folder button is being built outside ui/folders.js — it will have no ⇤ Remove from "
        "folder and no census here can see it:\n  " + "\n  ".join(stray)
    )


def test_folder_add_button_inserts_both_buttons_and_the_second_needs_the_callback():
    """Pin the mechanism the census above depends on, in the shared module itself.

    ⚠️ WITHOUT THIS, EVERY TEST IN THIS FILE IS A SCAN FOR A STRING WHOSE MEANING NOBODY CHECKED.
    If `folderAddButton` stopped keying `⇤ Remove from folder` off `o.selected`, the census would
    still pass while asserting nothing — the window-too-wide failure, one level up.
    """
    src = SHARED.read_text(encoding="utf-8")
    body = re.search(r"export function folderAddButton\([\s\S]*?\n\}", src)
    assert body, "folderAddButton is no longer a top-level function declaration in ui/folders.js"
    b = body.group(0)
    assert "data-vfadd" in b or "dataset.vfadd" in b, "✚ Folder no longer carries its marker"
    assert "dataset.vfout" in b or "data-vfout" in b, "⇤ Remove from folder no longer carries its marker"
    assert re.search(r"const sel = o && o\.selected;\s*\n\s*if \(!sel\) return;", b), (
        "⇤ Remove from folder is no longer gated on `o.selected` — the 4th-argument census in "
        "this file now proves nothing. Re-derive what makes the button appear and pin THAT."
    )


def test_a_row_filed_in_a_folder_the_client_cannot_name_falls_back_to_the_root():
    """🔴 A VANISHED ROW IS THE WORST THING A LIST CAN DO, AND IT WAS SILENT.

    `folderRows` partitions into `mine` (the OPEN folder's children) and `loose`. Keyed on
    `!r.folder` alone, a row stamped with a folder this scope no longer has fell into NEITHER: not
    loose, and never emitted because no folder row matched it. It rendered nowhere at all, with no
    folder on screen to open and no way to reach it.

    Reachable from ONE page, not just from two tabs: `FOLDERS` in the shared module is a
    module-level cache shared by every panel in a scope, while `.folder` is stamped per PANEL.
    Three panels render `train_sources` and two render `voices_rvc` — delete a folder in one and
    `loadFolders` drops it for its siblings at once, but their rows keep the stale stamp until they
    refetch, which their own reload is never told to do. And the delete confirm has just promised
    the user in bold that *"the N items in it are kept — they go back to the main list, unfiled"*.

    Pinned as a source claim because the partition is where it is decided; the browser drivers
    exercise the behavior.
    """
    src = SHARED.read_text(encoding="utf-8")
    body = re.search(r"export function folderRows\([\s\S]*?\n\}", src)
    assert body, "folderRows is no longer a top-level function declaration in ui/folders.js"
    b = body.group(0)
    assert re.search(r"const known = new Set\(fs\.map\(f => f\.id\)\)", b), (
        "folderRows no longer builds the set of folders it can actually show"
    )
    assert re.search(r"rows\.filter\(r => !r\.folder \|\| !known\.has\(r\.folder\)\)", b), (
        "the unfiled partition no longer catches a row whose folder is not on screen — such a row "
        "renders NOWHERE. See this test's docstring."
    )

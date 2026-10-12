"""Exercises the World Books and Character Cards interface in the browser."""
import os
import re
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import paths

SPEC = Path(__file__).parent / "wbedit_browser_spec.mjs"
NODE = shutil.which("node")


def _chrome():
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in ("chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(c)
        if found:
            return found
    for c in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              "/usr/bin/google-chrome", "/usr/bin/chromium"):
        if Path(c).exists():
            return c
    return None


CHECKS = (
    'the page loads, the editor JS is on it, and the module tree published its exports',
    'the shell computes to 1800px, not 1080',
    'and so does the footer — the second hand-written 1080',
    'the strip reads',
    # The refresh-loses-your-tab bug: a hand-written allow-list that never grew.
    'every sub-tab on the strip can be restored after a reload',
    'opening Character Cards records it as the tab to come back to',
    'and a reload would accept that value rather than falling back to Logs',
    'clicking World Books opens its pane',
    '…and closes the one that was open',
    # §8.3, the third kind. The sub-tab key and the document kind differ by one 's'
    # here, which is the mistake that renders an empty library over a full one.
    'clicking Personas opens its pane',
    'and the pane maps its tab key to the document kind the store records',
    # Persona import is a separate document path; this check keeps its editor route reachable.
    'Personas has ⬆ Import file… — 9.5.12',
    '…and it takes prose as well as .json',
    '…but not a PNG: a persona avatar holds only the picture',
    'and no Assemble — a persona has no sections',
    'the sweep IS there — §8.2a, we pull it from Vocalis',
    'the Personas library finishes its first fetch',
    'the empty state names the sweep AND the file picker',
    # §9a.11 / 7.5.15 — ✚ New Persona. The route tests can assert the field LIST; only a
    # browser can say the editor really drew boxes and that typing into one saves.
    '✚ New Persona is on the pane — §9a.11',
    'and the empty state names it as the third way in',
    'naming it closes the dialog',
    'the created persona lands in the Library',
    'the editor opens on two EMPTY boxes to type into',
    '…and they are description and title — the title row is the older gap this closes',
    'typing into an empty field saves as revision',
    'and the stored document is still a persona by its spec marker',
    'and it has no invented avatar filename to collide with a real persona',
    # Keep the upload control visible on cards without an avatar and exercise the upload route.
    'a persona with no picture still offers ⬆ Upload PNG — the whole point of 9.5.12',
    '…and the empty slot says what to do with it',
    '…with no <img> in the flow, so an empty slot is not a broken-image glyph',
    '…and ◎ Set face stays away until there is a picture to drag a square over',
    '⬆ Upload PNG gives a pictureless persona a face',
    '…the reopened document reports a picture, and its URL carries the stamp',
    '…and ◎ Set face arrives with it, the empty-slot note gone',
    '⬆ Import file… takes a .md persona and names it from the heading',
    '…stored as a persona document, with the whole file kept as the description',
    '…and the message says the trimming is his',
    'the prompt card is shown on Personas — its description is passable prose',
    # Drive the card controls through real browser events so module loading and event wiring are covered.
    'the prompt card loads its system prompt from the server',
    'and reports its few-shot pairs and fingerprint',
    'the revision picker is populated rather than a dead box',
    'a just-loaded card is not dirty — the private snapshot survived the move',
    'wbShotsText still renders a pair as user/blank/assistant',
    'a worldbook imports',
    'the World Books roster paints a row to open',
    'it appears in the Library by name',
    'the latest World Book is pre-rendered in the background',
    'the pre-rendered book stays hidden until its row is opened',
    'clicking Open renders every field on one scrollable page (§6.1.2)',
    'an X entry is present, ticked, editable and shows its text (I9)',
    'the preflight counts the ticked fields',
    'and updates when you untick them',
    'toggle all INVERTS every tick, so the one unticked field becomes the only ticked one',
    'and the preflight follows it rather than describing the previous selection',
    'collapse unticked folds exactly the unticked fields and leaves the ticked one open',
    'and every folded field keeps its header row and its checkbox, so it can be ticked back',
    'and the button says how to undo it rather than repeating what it just did',
    'ticking a folded field brings its body straight back — the header is a control, not a label',
    'and that tick reaches the preflight too',
    'editing a field reveals the Save control',
    'saving mints a revision, and the picker offers both',
    'revision 0 is still the bytes as imported (I8)',
    'and revision 1 carries the edit',
    # These assertions cover the browser's fetch/JSON/DOM path, which Python tests cannot exercise.
    'a document carrying the hard characters imports',
    'the encoding probe opens at revision 0',
    'the editor field shows the characters that were stored, not mojibake',
    'the em dash arrives as U+2014',
    'and no stray latin-1 a-circumflex (U+00E2)',
    'the hand-typed em dash is saved as a new revision',
    'an em dash typed into the editor survives the save and comes back intact',
    'the probe is deleted and Sample World Book 1 is back on screen at revision 0',
    # Each assertion names the UI property under test, not merely that a control exists:
    # WHERE the editor lands, WHICH field the preview uses, and that a replace
    # marks the document dirty so Save appears at all.
    'the editor is parked in a slot directly after the row that was clicked',
    'and it is visible, below that row rather than far down the page',
    'the roster reload puts its rows back',
    'the editor node survives a roster reload rather than being detached',
    'and it is put back under its row',
    # The row is a disclosure control with explicit open and closed states.
    "the open row's button reads Close while it is open",
    'and the label was not written over the portrait',
    'clicking the row again collapses it — same control both ways',
    '…and the button goes back to reading Open',
    'clicking the empty part of the row opens it — the row IS the target, not the button',
    'the second click on the row closes the editor',
    'and a third click opens it again from the top of the page',
    'opening a row below the fold scrolls the page to it',
    'and the row lands about a third down, not at the very top',
    # A control shoved past the panel edge looks deleted, not misplaced.
    'no Library header control is pushed outside its panel',
    '⟳ Import from SillyTavern is inside the panel and clickable',
    'the sort drop-down is a drop-down, not a full-width bar',
    # Browser checks prove the fields render and save. The flat-alias check prevents sensitive
    # mismatch logging in SillyTavern.
    '✚ New Character Card is on the Cards pane',
    'naming the card closes the dialog',
    'the created card lands in the Cards Library',
    'the editor opens the new card on EMPTY boxes to type into',
    'typing into an empty card field saves as revision',
    'and the stored document is still a valid V2 card after the edit',
    'and carries no flat V1 alias to go stale and log his description',
    'it has no SillyTavern ref yet and no world book attached',
    # The rename pair distinguishes resolving by `world_id` from printing the imported `world_ref`.
    # Browser assertions also verify that the association and unlink controls reach the store.
    'the world control is drawn for a linked card',
    'the control names the world book the card is associated with',
    '…without the caveat, because Vocalis holds this one',
    'the dropdown offers the Vocalis books and an unassociate row',
    'the card reopens after its book was renamed',
    "the control follows the rename while the card's own copy stays frozen",
    '…so the pane cannot be printing the name the card carries',
    'the world control is drawn for an unheld book',
    'a book Vocalis does not hold is named AND flagged',
    "the unheld book's option is a state, not an id",
    'the control is drawn for a card that has no world book',
    'a card with no world book still shows the control that could give it one',
    '…reading "— no world book —"',
    'picking a book from the dropdown reaches the store',
    'and the control redraws onto the book it just wrote',
    'the control settles on the book it wrote',
    "the card's own copy of the name was written too",
    'the record says the user chose this, which is what lets a send carry it',
    'changing the world book minted no revision',
    'unassociating from the dropdown reaches the store',
    'and the control redraws onto "— no world book —"',
    'the control settles on "— no world book —"',
    'and the record marks it as HIS answer, not as a link we failed to resolve',
    'the imported card is back on screen with its book selected',
    'unassociating a card that was imported WITH a world reaches the store',
    "the card's own bytes were not rewritten",
    'and the exported card no longer names the book',
    # Sorting, renaming, and card zoom behavior.
    'the Library has a sort control',
    'and it defaults to newest first',
    'Name A–Z re-renders the roster',
    'Name A–Z actually orders the rows',
    'and Z–A reverses it',
    'rows sharing a timestamp keep one stable order',
    'the editor has a Rename button',
    "renaming updates the open editor's title",
    'and the Library row, not just the header',
    "and no code path still asks through the browser's native prompt()",
    # Exercise export into the linked installation, including its success and failure states.
    # tone, and the give-up branch, because a 'busy' line has no timeout by design.
    'the editor has a Save to SillyTavern button',
    'and Save does not look like Export — only one of them writes outside Vocalis',
    # Pin Export to the entry group after Import & merge; location is part of the UI contract.
    'and ⬇ Export… closes the entry group, after ⇄ Import & merge…',
    'in that group rather than the Save/Send/Close one it used to live in',
    'and its label says a dialog is coming',
    'and it is enabled — a previous send is never a reason to refuse another',
    'pressing Send records a job the extension can collect',
    'and the pane says a send is under way',
    'the send status is the busy tone, not plain chatter',
    'an uncollected send says the tab is in the background and QUEUED, never that none is listening',
    'and the job is kept rather than withdrawn on a 14-second guess',
    'and a queued send offers Cancel, because a busy line with no exit is not an answer',
    'pressing Cancel withdraws the job so no write fires when a tab next opens',
    'and it says so, rather than leaving the queued line up over nothing',
    'every revision in the picker carries its date and time',
    'the newest revision is at the top of the picker',
    'saving says which revision it made',
    'and it is green, not gray chatter that erases itself',
    'and it carries an ✕ so he can dismiss it himself',
    'and the save did not throw away his scroll position',
    'Preview one offers a field picker',
    'it lists exactly the ticked fields',
    'and each option names the field and its size',
    'unticking a field removes it from the picker',
    'the find bar opens',
    'it reports a running count',
    'and each field header carries its own match count',
    'the current match is selected in the textarea itself',
    'and the field it jumped to is actually on screen, below the pinned header',
    'replacing marks the document dirty and reveals Save',
    'and {{user}} is inserted VERBATIM — nothing treats the replacement as a template',
    'a search with nothing to find says "no matches" rather than going quiet',
    # §9a.32 — the entry TITLE is searchable, and stepping onto a title hit opens the fold that
    # hides it. Both are prefixes, not whole lines: the spec appends the observed values.
    'a title-only match is found',
    'stepping to a title hit opens the settings fold and selects it in the Title control',
    'and it closes again',
    'World Books offers "Assemble sections…" (§6.5)',
    '…and Character Cards does not — a card has no sections',
    'the card importer accepts a .png — a character card IS a PNG (§4.3.1)',
    'a PNG card imports and the server says it brought a picture',
    'the Library roster renders a face, and it decodes',
    'the face is a circle that clips',
    'and it is square, 40×40',
    # Verify thumbnail geometry and crop behavior for the roster and fallback image.
    'the roster face is the 96px server crop, not the 400×600 card',
    'wbFitFace ran on load',
    'and it is not cropped a second time',
    'the server cut it at the focus rect, not the center',
    'the fallback fetches the whole 400×600 card',
    'and the browser cuts it at the focus rect, not centered',
    'a card with no picture gets its initial, never a stand-in face',
    # The roster's faces are the point of the page — never lazy-loaded.
    'a Library face is not lazy-loaded',
    'and it is fetched at high priority',
    'a face carries its initial underneath the picture',
    'opening the card shows the big picture beside the fields',
    'and it is the whole card — the rect describes the circle, not the picture',
    'clicking the card picture actually makes it bigger',
    "and \"full size\" means the PNG's own pixels, never an upscale",
    'and clicking it again shrinks it back',
    'the card picture decodes again before the zoom is measured',
    'opening another document opens it shrunk, not at whatever zoom the last one was left at',
    # Assert that the image element updates after upload and the upload control remains available.
    'reopening a pictureless card clears the big image rather than keeping a stale face',
    '…and ⬆ Upload PNG is on screen for it, which is how a card imported as JSON gets a face at all',
    'both sub-tabs offer ⬇ Export',
    'the Export block opens Sample World Book 1 at revision 0',
    'Export asks for the revision on screen, not the latest',
    # Cover the Save-As picker, written bytes, cancellation, and browsers without a picker.
    'the books editor is really on screen, so these reads mean something',
    "⬇ Export…'s label sits on one line",
    'Export opens the browser’s own Save-As dialog rather than firing at the downloads folder',
    'and it arrives pre-filled with the name the SERVER chose',
    'and names an id, so it reopens where he last saved',
    'the stream is CLOSED, not just written',
    'and what it writes is the standard worldbook JSON',
    'with no download fired behind the dialog — one save, not two',
    'and the message line says saved, not downloaded',
    'pressing Cancel saves NOTHING — no download fires behind the dismissed dialog',
    'and the line says so rather than leaving the busy spinner up',
    'a browser with no Save-As dialog still downloads it',
    'and says downloaded, which is what happened',
    # Use a real pointer to test face-square movement, resizing, applying, and canceling.
    'the Character Cards roster has a row with a picture to work with',
    'and opening it shows the picture the face square is drawn on',
    'the card editor has Upload PNG, Set face, and 9.5.13’s Apply/Cancel under the picture',
    'and a World Book has neither, because it has no picture',
    '◎ Set face opens on a square already on the picture',
    'and it is square on screen, not the shape of the 2:3 card',
    'with four corner handles to resize by',
    'and a dashed circle inside showing what the avatar will actually be',
    '✓ Apply face replaces ◎ Set face while picking',
    'dragging the square moves it',
    'and moving does not resize it',
    'and a release stores nothing — Apply is the only writer',
    'dragging a corner resizes it',
    'and it is still square after a resize',
    'and still inside the picture',
    '✕ Cancel leaves the stored rect alone',
    'and puts the buttons back to ◎ Set face',
    '✓ Apply face stores the rect as fractions of the image',
    'and stores the square he actually adjusted to',
    'and closes the picker, because the answer is in',
    'Clear face removes the rect rather than zeroing it',
    # Verify cache invalidation with a server-side upload so the upload response cannot mask stale-cache behavior.
    'the editor shows the picture the server holds',
    "and a picture replaced behind the page's back is seen, not the cached one",
    # Verify the roster uses the refreshed thumbnail URL, not only the editor's full-size image.
    # Compare pixels because every thumbnail has the same dimensions.
    'the roster circle shows the picture the server holds',
    "and a face replaced behind the page's back updates the circle too, without a reload",
    # …and the second input, which `avatar_at` cannot see: a rect edit leaves the PNG byte-identical.
    'the roster circle is cut at the face square',
    'and MOVING that square re-cuts it, on the same unchanged picture',
    'a card naming a book we already hold is linked to it at import',
    'a card naming a book we do NOT hold imports unlinked rather than failing',
    'the World Books pane has no worldbook filter — it would have nothing to filter by',
    'the dropdown offers every worldbook, unfiltered first',
    'choosing a book narrows the roster to the characters associated with it',
    'a card imported BEFORE its book is linked once the book arrives — import order does not matter',
    'renaming the worldbook does NOT break the association — the link is the id, not the name',
    'and the dropdown shows the new name',
    'the "not associated" option finds the cards linked to no book',
    'a filter that matches nothing says so, rather than claiming the library is empty',
    "an exported card carries the book's CURRENT name, not the one it was imported with",
    'clearing the filter brings the whole roster back',
    'the ↻ button is gone from both sub-tabs',
    'the World Books pane is on screen before the 423 is injected',
    "a 423 is injected for one call, through the loader's own jget, and the stub then stands down",
    'the pane says the vault is locked rather than "nothing imported yet" (I15)',
    '…and heals itself once the vault opens, with no button to press',
    'the Character Cards pane is on screen for the status-line block',
    # Keep import status visible after the previous short timeout window.
    'an import in progress carries a spinner',
    'and it is amber, not the old gray',
    'a job still running offers no ✕ — there is nothing finished to dismiss',
    'a finished import is green',
    'and it says what actually happened, not just that it happened',
    'and it carries an ✕ to dismiss it',
    'a finished import is not still spinning',
    'ordinary chatter is unchanged — muted, and not something to dismiss',
    'the running line is still there after the old six-second timeout would have wiped it',
    'and so is the tally — the only record a press leaves behind',
    'while ordinary chatter still expires on its own, as it always did',
    'clicking the ✕ is what clears it',
    'and dismissing puts the line back to neutral, not to a green empty one',
    'a new status replaces the old one rather than accumulating beside it',
    'a document name in the tally is escaped, never parsed as markup',
    # Assert delegated event-handler wiring directly; visible behavior alone does not prove the listener is attached.
    'and it dismisses by DELEGATION — data-wbhush, never an onclick attribute',
    'the World Books pane is back, with a row, for the model-log block',
    # The active request must appear before its reply; polling must update the same row.
    'the model log has no Refresh button on any pane',
    'the log pane comes before the Review card in the DOM',
    'and after the World Books library it belongs to',
    'the saved log header says saved, not live',
    'and it names the revision and never spins, because nothing is in flight',
    'a pass is under way with its first request sent and no reply yet',
    'the poll paints the open row without waiting for a reply',
    'the REQUEST is on screen before any reply exists',
    'and the open row says it is waiting, not that nothing was sent',
    'and the open row carries a spinner',
    'the header spins while the pass is running',
    'and the live header says live, never saved',
    'the in-flight request is ONE row, not a row per poll',
    'the poll picks the reply up on its own, with no button to press',
    'the reply closes the open row in place rather than adding a second',
    'and the closed row shows the reply where the spinner was',
    'nothing is left spinning once the reply is in',
    'and the header stops spinning when the pass is no longer running',
    'a reply carrying <START> and {{user}} renders as text, never as markup',
    'the log window overflows, so a scroll position means something',
    'a new row leaves a pane that was at the bottom still at the bottom',
    'a new row does not yank the pane away from where he scrolled it',
    'Settings offers a pairing token, beside the other credential',
    'it starts unpaired',
    'the field is masked',
    'Generate mints a token and puts it on screen',
    'the token on screen actually opens /pair/*',
    'a freshly minted token is masked, not left legible on screen',
    'and the state line says so',
    'the four-mode book opens with all four entries',
    # Check the mode indicator against all classifier states, including disabled entries.
    'every entry carries its injection mode',
    'a DISABLED entry is never rendered as normal — it injects nothing and must not look live',
    'every dot carries a tooltip that spells the mode out in words, not color alone',
    'the always-injected tooltip says it costs tokens on every message',
    'and the two states most easily misread carry their own glyph, not just their own color',
    'the filter narrows the entry list to the chosen mode',
    'tick all over a filtered list selects only what is visible',
    'and the preflight names the whole book and what it is hiding',
    'find searches only the entries the filter is showing',
    'Ctrl+F3 lands on a field he can actually see',
    'and the count says what it did not search',
    'clearing the filter brings every entry back and drops the warning with it',
    'changing the filter rescans rather than leaving stale hits behind',
    'a book Vocalis authored is not marked as uploaded',
    'a new World Book opens empty, and says so rather than looking broken',
    'and ✚ Add entry is in the toolbar, so it is reachable while the book is still empty',
    'the new entry is visible in the editor that made it',
    'and it is born with placeholder text, never blank, or it would be invisible',
    'and it carries an injection mode like any other entry',
    'the SillyTavern section is on screen, so a scroll position means something',
    'the entry is appended to a long book',
    'adding an entry scrolls to the new entry, not back to the top',
    'and nothing drags the page back afterward',
    'and the cursor is in the new entry, ready for him to type',
    'and its Primary keywords box is on screen',
    '…without auto-expanding the ⚙ fold to get there, which was the lesser fix',
    'an empty book is refused on the press, with the reason',
    # Test row-level export and import controls so clicks do not trigger parent handlers.
    'the World Books roster is painted for the download checks',
    '⬇ sits between Open/Close and 🗑 on the row',
    'and every row has one, not just the first',
    'and it says what the file is for',
    '⬇ saves the book under its own name',
    'from bytes the page already has, so a locked vault can be reported instead of navigated to',
    'and downloading does not open the book',
    'and the message line says it happened',
    '⬆ Import entry is in the toolbar beside ✚ Add entry, reachable on an empty book',
    'the imported entry is in the editor that imported it',
    'and the entry that already held uid 18 is untouched',
    'the incoming uid is reassigned, and the container key agrees with it',
    'and the message line says what it was renumbered to',
    'the entry keeps its own order and the fields Vocalis has never heard of',
    'and its keywords, or SillyTavern would store it and never fire it',
    # Check that all card fields render, with prose selected and machinery fields unticked.
    'each alternate greeting is its own field, blanks skipped',
    'and the indices are the ORIGINAL ones, so an edit lands on the greeting he is looking at',
    'creator notes, system prompt and post-history instructions are on the page too',
    'the prose fields arrive ticked, exactly as before',
    'and the machinery arrives UNTICKED — I13 is a rule about passes, not about eyesight',
    'the preflight counts all ten and selects five',
    # 7.4 / §9a.32 — the field that is not on the card yet. The disabled checkbox is the half no
    # route test can see, and `checked = true` on a disabled box succeeds silently.
    'a card field with no text still gets a row',
    'the row is empty and says so rather than looking like a field that lost its text',
    'its checkbox is disabled',
    '⊕ tick all does not select it',
    'and the preflight counts only the field a pass can actually reach',
    'typing into the empty row and pressing Save puts the field on the card for the first time',
    'and it is an ordinary field from then on',
    # Verify that opening the settings fold with nullable values proposes no edits.
    'the settings fold is built on first open, not with the row',
    'Primary keywords sits outside the ⚙ fold, and only there',
    'each field gets its own control type',
    'an unset sticky renders blank, never 0',
    "a nullable boolean offers 'use global' and is on it",
    'opening the fold proposes no edits at all',
    'an entry missing nearly every key proposes nothing either',
    'the settings are grouped, Identity first',
    'changing one control marks the row and proposes exactly that one edit',
    'the value lands as a NUMBER in one new revision',
    "an untouched nullable is still 'not set' after the save",
    'and the prose is untouched by a settings save',
    'the fold he was working in is still open after the save',
    'the roster face asks for the thumbnail, not the full card',
    "and carries the thumbnail's own cache key, the same one the ETag is built from",
    'and carries no data-focus, because the server already applied the rect',
    'but keeps the rect for the fallback',
    'still eager and high priority',
    'the route serves a WebP',
    'and never lets the browser hold a stale crop',
    'a thumbnail miss falls back to the full avatar',
    'and the fallback URL is stamped as well',
    'and restores the rect so the browser crops it correctly',
    'a second failure drops the img and uncovers the initial, rather than looping',
    'an embedded entry says it belongs to the card',
    'and one heading is drawn for the group, not one per row',
    "the heading sits above the entries and below the card's own fields",
    'and it says the lorebook is inside the card',
    'every field including the card book arrives ticked',
    'the heading shows while any of its rows do',
    "the mode filter reaches the card book's own entries",
    'and the heading is hidden once its last row is filtered away',
    # Join voice-row avatars by SillyTavern reference rather than display name.
    'the Character Voices list renders its rows',
    'a character with a card gets its face, via the thumbnail route',
    'a character with no card in the Library gets its initial, never a broken image',
    # Register every browser assertion so a later failure cannot hide an omitted check.
    'a persona in Character Voices gets its persona face',
    'an ambiguous name draws the initial rather than guessing between two cards',
    'and the ambiguity was seen rather than missed, so the row is a decision not an accident',
    'a face outside the Library is not dressed up as a click target',
    'the avatar filename wins over the name, even an ambiguous one',
    'an entry with no avatar still resolves by an unambiguous name',
    'and refuses to choose when two cards share that name',
    'an unknown avatar draws the initial rather than falling back to the name',
    'a Clips face takes the exact SillyTavern avatar first',
    '🔴 an ambiguous name still draws a picture, a card over a persona',
    'an avatar no document carries falls back to the name, not to the initial',
    'a card with a picture beats a newer one without',
    'between two cards with pictures, the newest import wins',
    'a persona is used when it is the only document of that name',
    'a name with no document at all draws the initial',

    'wbBump advances the pane generation',
    'a token taken before a bump reads as stale',
    'and the token the bump returned does not',
    'the generation is per pane, so bumping books does not invalidate cards',
    'two racing opens leave the pane on the second document',
    'and its revision and fields belong to that same document',
    'a rejected background call reaches the message line',
    'and a 423 says the vault is locked rather than a raw error',
    'the sweep and send pollers are keyed per pane, not module globals',

    # §9a.31 — the entry accordion. Every one of these is a claim about layout or about which
    # element an event reached, which is why they live in the browser spec and not in a smoke.
    'the accordion probe opens at revision 0',
    'selecting a World Book opens the first entry and collapses the rest',
    'and the collapsed bodies are really off the page, not merely class-marked',
    'a collapsed entry still holds its full text — the fold is a view, never a truncation',
    'an entry header is a fold control rather than a label wrapping its checkbox',
    'and it carries a twisty saying which way the row will go',
    # §9a.28 — the dots. The glyphs themselves are pinned against the fork in
    # test_wbedit_modeglyphs.py; which SIDE of the title they land on only a browser can answer.
    'the injection-mode dot sits LEFT of the entry title',
    "and it is SillyTavern's own glyph for the mode, not ours",
    'with the tooltip still carrying the only explanation of what the mode means',
    'clicking an entry title bar collapses that entry',
    'and clicking it again opens it back up',
    'clicking the checkbox ticks the entry and does NOT fold it',
    'collapse all closes every entry, including the one that opened by default',
    'every collapsed entry is still ticked and still included in a pass',
    'expand all opens every one of them again',
    'an edited entry that is then collapsed still offers Save',
    'and its collapsed header says it is unsaved rather than looking idle',
    'Find still searches the bodies of collapsed entries',
    'and stepping onto a match OPENS the collapsed entry it is in',
    'a refused keyless entry is OPENED, not marked red behind a fold',
    # Primary keywords remain visible without opening the settings fold.
    '…and the Primary keywords box itself is visible on the refused row',
    'and the ⚙ fold is left alone — nothing had to be opened to show it',
    # §9a.29 — the passive marker, on a book that arrived broken rather than one being saved.
    'a book holding a keyless entry opens',
    'a keyless entry is marked inert on sight, without pressing Save',
    'and a keyed entry and an always-injected one are left alone',
    'the entry-less probe opens',
    'a book with no entries hides the expand and collapse controls rather than offering dead ones',
    'and it hides the injection-mode filter too — four modes over zero entries is a dead control',
    'an empty World Book says so and points at Add entry',
    'the probes are deleted and Sample World Book 1 is back on screen',
    # …and the §6.1.2 boundary, proved on the one document that holds both kinds of row.
    'every row on a Character Card keeps its label header and gets no twisty',
    'so nothing on a card is ever collapsed, embedded lorebook included',
    'and the expand/collapse controls stay hidden on the Character Cards pane',

    # §9a.27 / §9a.30 — the top-line Save, and the spinner that is really a double-click guard.
    'Sample World Book 1 is open at its latest revision for the top-line Save',
    'Save as new revision sits on the top line, left of Save to SillyTavern',
    'and it wears the same primary blue as the one at the bottom',
    'it is DISABLED on a clean document rather than hidden, so the row never moves',
    'and it enables on the first keystroke',
    'clicking the TOP button mints a new revision',
    'and it clears the shared dirty state, so both controls are wired to one handler',
    'the top button goes back to disabled once there is nothing left to save',
    'the pressed button turns into a spinner and is disabled',
    'the other trigger is disabled too, but does not spin — it is one action, not two',
    'and both captions come back afterward, so a failed save leaves no stuck spinner',

    # 7.3.9c/d — the ⚙ fold's pending edits, and the roster marker that says they exist.
    'a Keywords edit is stashed on the server as JSON',
    'and a numeric setting keeps its type through the encoding',
    'the Library row says how many are pending',
    'and it is painted --warn orange, distinct from the muted text beside it',
    'and no row without drafts is marked',
    "the fold's pending edits come back after a reopen",
    'and the fold is BUILT while still shut',
    # §9a.35 — the keywords box is the one body that must be built AND on screen, which is what
    # separates it from the fold beside it.
    'the primary-keywords box is built AND visible without opening anything',
    'Save can actually see them:',
    'and he is told',
    'a restored fold edit lands in the revision',
    'and the draft is cleared by the save',
    'putting a control back to its stored value clears the draft',

    # 7.3.9f — ↺ Revert changes, beside Save, orange, confirmed.
    'the Library row gains the marker as he types, with no reload',
    'and the Library row drops its marker in the same breath, with no refresh',
    'Revert is disabled with nothing to revert and lights up on an edit',
    'it says Revert changes and sits to the RIGHT of Save',
    'and it is the orange one, by computed color',
    'it asks before destroying anything',
    'and Cancel keeps the unsaved text',
    'confirming puts the stored text back',
    'the draft is gone from the vault and the button grays out again',

    # §6.3 — the live typing diff. The green half had never been drawn: `wbDiff` returned an
    # `after` the pane computed and threw away, so the CSS for it shipped unreachable.
    "the row arrives with the model's removal already red on the left",
    'and its addition green on the right, which no build before this one drew',
    'a row that differs from the document is banded',
    'typing in the after box moves the red on the left',
    'and the green on the right follows the same keystroke',
    'putting the original text back clears the band and every mark with it',
    'the addition is painted the diff green, not merely given a class',
    'and the removal the diff red',
    "the highlight layer wraps at exactly the textarea's width",
    'and the two layers agree on size, family and leading',
    'the layer paints backgrounds only',
    'a diff span in the highlight layer carries no padding of its own',

    'a book with real entry positions imports and opens',
    '⇊ Fix positions is on screen',
    'and its label sits on one line',
    'the editor toolbar has its full row of controls to measure',
    '⇊ Fix positions did not cost the toolbar a line',
    'and no control is pushed outside the strip',
    'and it sits with ✚ Add entry and ⬆ Import entry, the two it belongs with',
    'it opens the preview dialog',
    'the preview counts what would move, before anything is written',
    "and offers the fork's own default depth",
    'only the extras that apply are offered',
    'the dialog renders no entry text at all',
    'and it says how many are left alone, and why',
    'the left-alone count follows the tick too',
    "ticking an extra repaints the count from the server's own figure",
    'the dialog commits and closes',
    'the message line says what moved and where',
    'it minted exactly one revision',
    'both conditional entries are at depth 4',
    'the steady always-injected entry stayed where it was',
    'and the ↑EM entry was not moved by the default rule',
    'no entry text or keyword changed',
    '⬇ Export file… is in the Library strip',
    'and it sits on the same row as ⬆ Import file…, to its right',
    'its label sits on one line too',
    'with nothing open it points at the row button rather than dead-ending',

    'a book whose only candidates are the offered extras imports and opens',
    'the dialog still opens for it — there IS something it could do',
    'it opens at nothing-would-move',
    'and offers both extras',
    'and Fix positions is DISABLED, so the only thing it can do is not produce a red error',
    "the always-injected label starts at the base plan's figure",
    'the always-injected label is recounted once the examples tick is on',
    'and with nothing moving yet the button is still disabled',
    'ticking both arms the button and moves the count',
    'canceling mints nothing',
    'and leaves no spinner running behind it',

    # A no-op press still needs visible feedback, so verify the dialog and its dismissal.
    'a book with every entry already at depth imports and opens',
    'pressing it opens a DIALOG rather than writing to a message line he cannot see',
    'the dialog names the outcome',
    'and says WHY nothing moved',
    'one button, and it is OK',
    'OK dismisses it',
    'nothing was written',
    'and the "looking at where the entries sit" spinner did not survive the dialog',

    'the editor is open for this block',
    "the message reaches the editor's own strip",
    'and it carries the spinner, beside the button he pressed',
    'exactly one strip is on screen, and it is the editor one',
    'the library strip still HOLDS the text for anything reading it',
    'the editor copy carries its own',
    'and one press clears both',
    'with the editor closed the library strip is visible again',
    'and it carries the message',
    'while the editor copy is left empty rather than stale',

    # Check preview and Apply independently, including default and explicit conflict choices.
    'picking a file opens the merge dialog with something in it',
    'only the entries that need him are listed',
    'and the dialog counts them in words',
    'both versions are on screen to compare, his first',
    'and the pre-selected answer takes the file',
    'applying reports what it did',
    'one revision was minted, not two',
    'the entry he never touched took the update',
    'a conflict he skimmed past took the file',
    'and the one he clicked "Keep mine" on kept his',
    'the revision it wrote is marked as the new base',

    # Card merges summarize fields, mark local edits, and provide all three conflict choices.
    'a character card opens the merge dialog too',
    'the summary does not claim nothing differs while listing a decision',
    "it counts the card's FIELDS, which is where a card keeps everything",
    'the selected edit is marked green in the top pane',
    'there are three answers, not two',
    'the edit box starts from the FILE',
    'and it stays out of the way until that answer is chosen',
    'the dialog is wide, and scrolls its own body so Apply stays reachable',
    'the pane holds the whole entry with no ellipsis',
    'including its last words, which the old 400-character cut ate',
    'and it scrolls rather than growing the dialog without limit',
    'applying a card merge reports what it did',
    'and what he typed is what landed',

    # Keep import-and-merge available in the open card header, where a document is selected.
    'the cards pane is really on screen, so these rects mean something',
    '⇄ Import & merge… is on the open card',
    'on the same header line as ⬇ Export, to its right',
    'and no longer up in the Library strip',
    "⇄ Import & merge…'s own label does not wrap either",
    'its hidden file input moved with it, so the picker it opens is still the one wired',

    # Verify that closing a card while its draft loads does not process stale DOM rows.
    'the draft read really was held open, so the race window exists',
    'the editor was on screen with its fields drawn',
    'and closing leaves those rows in the DOM, which is what made the crash reachable',
    'closing it straight away prints no error',
    'and the late open does not re-populate the pane he already dismissed',

    # Ctrl+F belongs to the editor only while its pane is visible. Check both capture and pass-through.
    'a worldbook is open in the editor, which is the only state Ctrl+F is for',
    '🔴 Ctrl+F IS taken by the find bar while the editor is the thing you are looking at',
    'and it really opened the find bar, not merely swallowed the key',
    'switching tabs hides the SillyTavern panel',
    '🔴 …but NOT the editor pane inside it',
    '🔴 Ctrl+F on another tab is LEFT ALONE, so the browser opens its own find',
    'and coming back to SillyTavern hands the key to the editor again',

    'a deleted document shows a row in the recycle bin',
    '🔴 pressing Undelete keeps the row on screen and says it is working',
    '…and disables ✕ Delete permanently beside it, so a purge cannot land mid-gesture',
    'the ref really is un-declined while the import runs',
    '🔴 …and when the import brings nothing back, the ref goes STRAIGHT BACK in the bin',
    'the row is live again, so a second attempt is the same one click',
    'and the message line says so rather than leaving him to notice',

    'no uncaught page errors',
)

# `  ok   <what>` and `  FAIL <what>` — the only two lines `ok()` in the spec prints.
_CHECK_LINE = re.compile(r"^ {2}(?:ok {3}|FAIL )(?P<what>\S.*)$")


def _printed_checks(stdout):
    return [m.group("what") for m in map(_CHECK_LINE.match, stdout.splitlines()) if m]


def _audit_the_roster(stdout):
    """Compare what the spec printed against CHECKS, in BOTH directions."""
    printed = _printed_checks(stdout)

    # ← a registered check that stopped printing: deleted, renamed, or its block no longer runs.
    for name in CHECKS:
        hits = [w for w in printed if w.startswith(name)]
        assert len(hits) == 1, (
            f"the check {name!r} printed {len(hits)} times, expected exactly once — it was "
            f"deleted, renamed, or the block it lives in stopped executing:\n{stdout}")

    # → a check that ran but was never registered: today that one is deletable in silence.
    orphans = [w for w in printed if not any(w.startswith(n) for n in CHECKS)]
    assert not orphans, (
        "these checks ran but are NOT on the anti-deletion roster in this file. Register them — "
        "until you do, deleting them leaves the whole suite green:\n  "
        + "\n  ".join(orphans))

    assert len(printed) == len(CHECKS), (
        f"the spec printed {len(printed)} checks and {len(CHECKS)} are registered:\n{stdout}")


def test_the_roster_is_unambiguous():
    """Checks that the roster is unambiguous."""
    dupes = sorted({n for n in CHECKS if CHECKS.count(n) > 1})
    assert not dupes, f"a check name is registered more than once: {dupes}"

    # If one name were a prefix of another, one printed line would satisfy both and the count
    # would stop meaning anything — which is precisely how a deletion would hide.
    nested = [(a, b) for a in CHECKS for b in CHECKS if a != b and b.startswith(a)]
    assert not nested, (
        "one registered name is a prefix of another, so a printed line would match both and the "
        f"roster stops being a bijection — lengthen the shorter one: {nested}")


def test_the_roster_audit_catches_a_deletion_and_an_unregistered_check():
    """Checks that the roster audit catches a deletion and an unregistered check."""
    perfect = "\n".join(f"  ok   {n}" for n in CHECKS) + "\nall checks passed\n"
    _audit_the_roster(perfect)                     # the undamaged article is accepted

    # ← someone deletes a check from the .mjs. This is the direction the old allowlist had, and
    # the only one it had.
    with pytest.raises(AssertionError, match="printed 0 times"):
        _audit_the_roster(perfect.replace(f"  ok   {CHECKS[17]}\n", ""))

    # → someone ADDS a check and does not register it: 50 checks got in this way, and every one
    # of them was deletable in silence until this direction existed.
    with pytest.raises(AssertionError, match="NOT on the anti-deletion roster"):
        _audit_the_roster(perfect + "  ok   a brand new check nobody registered\n")

    # A check that runs twice is the third way the bijection breaks — a block that got duplicated,
    # or a loop that started emitting per iteration.
    with pytest.raises(AssertionError, match="printed 2 times"):
        _audit_the_roster(perfect + f"  ok   {CHECKS[17]}\n")


# Give the browser spec a 100-second timeout because it needs more than the suite-wide unit-test limit.
@pytest.mark.timeout(100)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_editor_tab_works_in_a_real_browser(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = False

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    # Opt-in, and the supported way to regenerate the roster above off a real run.
    dump = os.environ.get("WBEDIT_SPEC_DUMP")
    if dump:
        Path(dump).write_text(f"{r.stdout}\n---STDERR---\n{r.stderr}", encoding="utf-8")

    # A red check or a crash first, with the whole log. The roster audit would otherwise bury it
    # under one "did not print" line per check that never got the chance to run.
    assert r.returncode == 0, f"the editor failed in a real browser:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. The exit code above cannot tell a pass from a spec that stopped
    # checking - an early return, a renamed selector or a deleted block exits 0 and is merely
    # SHORTER. The floor is derived from the spec's own unconditional ok() calls, so there is no
    # constant here to go stale. See assert_spec_ran in conftest.py.
    # The floor counts unconditional assertions, not the total emitted by one run.
    # 32 of its assertions sit behind a branch, so a slower box or a loaded run can emit
    # Branch-dependent assertions may vary by environment; the roster audit checks exact coverage
    # while this lower bound catches early termination.
    assert_spec_ran(r, SPEC, floor=420)

    _audit_the_roster(r.stdout)

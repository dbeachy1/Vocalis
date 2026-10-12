// ui/filterwiring.js — the nine filter boxes, each wired to the render it drives (7.3-m13).
//
// The last block of application logic to leave index.html, and the one the milestone kept saying
// could never go. `── ONE FILTER, EVERY LIST ──` and `── every filter box ──` were two halves of
// one thing: `util/filter.js` took the machinery at m1b, and these nine statements stayed behind
// for twelve milestones because they run WHILE THE PAGE PARSES and a module is deferred.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WHY THIS IS A FILE OF ITS OWN AND NOT PART OF `util/filter.js`, WHICH OWNS `filtWire`.
//
// Because it would be ten cycles. These nine lines name renderers belonging to SIX feature modules
// — book/library.js, pg/playground.js, voices/voices.js, media/voiceswap.js (four of them),
// voice/training.js (two) — and **every one of those imports `filtQ`/`filtRows`/`filtNone`/
// `filtCount` from `util/filter.js`**. Putting the calls there makes the leaf import all of its own
// importers. A SINK — a module nothing imports, that imports everything it drives — has no cycle to
// have, and this is the only file in the tree with that shape.
//
// 📌 It is the `st/tabstate.js` (m2b) / `media/swapstate.js` (m9a) / `pg/pgstate.js` (m6e) /
// `util/appstate.js` (m12d) split seen from the other end. Those four extracted the thing everyone
// READS into a file with no imports; this extracts the thing that CALLS everyone into a file
// nothing imports. Same problem — a hub in the middle of a graph — solved at whichever end is a leaf.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ ONE FILTER, EVERY LIST — the behavior these nine lines are wiring, kept here because it is
// the reason they are nine identical lines and not nine implementations.
//
// EVERY WORD TYPED must appear somewhere in the row's searchable text, IN ANY ORDER. Two words beat
// one substring: "sample voice" finds the row that "samplevoice" never would, and you do not have to
// remember whether the song or the voice comes first. The lists are small enough that re-filtering
// on every keystroke costs nothing measurable.
//
// It filters the DISPLAY ONLY — the underlying arrays stay whole. So play, download, delete and
// rename all still resolve a ref that has been filtered off the screen, which is what lets the
// player at the top of a library keep working while you type a filter that excludes the very thing
// it is playing.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ THE ARROWS ARE NO LONGER LOAD-BEARING, AND THEY STAY ANYWAY. §11.8 charged four separate times
// for the rule that these had to be `()=>renderX()` rather than `filtWire('x', renderX)`: this
// block was read at parse time, and a name that had become a module export sat in its temporal dead
// zone until the shim ran, so a bare reference was the bug that "would have shipped a blank page".
// In a module, imports are resolved before the body's first statement, so both forms work.
//
// **They are verbatim** — §6 step 4 moves code without reformatting it, and this file is the last
// place in 7.3 that could have been tempted to tidy on the way past. There is also a real reason to
// prefer the arrow permanently: `pgSearch`'s body is `{pgLib.page=0;renderPgLib();}`, which is not a
// function reference at all, so the block would read as eight of one shape and one of another.
//
// 📌 NOTHING IS EXPORTED. This file is imported for its side effect, by js/main.js — the fifth such
// import in the tree after wb/wire.js, voice/autoplay.js, voice/rvcimport.js and sys/login.js. Drop
// that line and all nine filter boxes are silently dead, with no ReferenceError to say so.

import { filtWire } from '../util/filter.js';
import { renderLibrary } from '../book/library.js';
import { pgLib } from '../pg/pgstate.js';
import { renderPgLib } from '../pg/playground.js';
import { renderVoiceList } from '../voices/voices.js';
// ⚠️ `vsRenderLib` IS `media/swaplib.js`'s, NOT voiceswap.js's — checked with grep, not assumed,
// which is §11.12's rule and the one that cost m4t a browser run. The four `vs*`/`ss*` names read
// as one family in the page and live in two files: m4p split the swap LIBRARY out before m9a took
// the swap SCREEN, so the renderer for "Finished songs | Stems" went with the library.
import { ssRenderPicker, ssRenderLib } from '../media/stems.js';
import { spRender } from '../media/speech.js';
import { aceLibSearch } from '../ace/tray.js';

// ── every filter box, wired to the render it drives (never to the LOADER: that would refetch
//    on every keystroke) ──────────────────────────────────────────────────────
filtWire('libFilter', () => renderLibrary()); // Book → Library
filtWire('pgSearch', () => {
  pgLib.page = 0;
  renderPgLib();
}); // Playground library (paged)
filtWire('vFilter', () => renderVoiceList()); // Voices (TTS samples)
filtWire('ssPickerFilter', () => ssRenderPicker()); // Stems → Songs
filtWire('ssLibFilter', () => ssRenderLib()); // Stems → Your stems
// 🔴 THE TENTH, AND IT WAS MISSING FOR THE WHOLE LIFE OF THE PANEL. Voice Studio ▸ Speech had
// `$('spFilter').addEventListener('input', spRender)` of its own, which looks like wiring and is
// not: `filtQ` reads the `FILT` map, `filtWire` is the only thing that writes it, so the box
// repainted an unfiltered list on every keystroke. Found because the folder contract's browser
// spec filters each list and this one kept all three rows.
// ⚠️ A LIST OF NINE WITH A TENTH WIRED SOMEWHERE ELSE reads as complete. The absence was only
// visible from HERE, which is the argument for one place naming every box.
filtWire('spFilter', () => spRender()); // Voice Studio → Speech clips
// 🔴 THE ELEVENTH (9.7.0) — ACE-Step ▸ Library. It is `aceLibSearch`
// rather than the renderer because that library is PAGED: a keystroke has to land you back on page
// 1, which is the same shape `pgSearch` above has, and the only two entries here that are not a
// bare render are the two paged lists.
// ⚠️ IMPORT ORDER IS WHAT MAKES THIS SAFE. `ace/tray.js` paints `#aceLibFilter` into the page at
// module-eval, and `filtWire` silently no-ops on a box that is not there yet — but this file
// imports that module and nothing imports this one, so ESM guarantees tray.js has finished
// evaluating before the line below runs. That is the sink property the header describes, working.
filtWire('aceLibFilter', () => aceLibSearch()); // ACE-Step → Library (paged)

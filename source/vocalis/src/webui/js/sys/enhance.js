// sys/enhance.js — ONE SERVER FACT, AND EVERYTHING THE PAGE DRAWS FROM IT (7.3, 4.1).
//
// `/enhance/info` answers a single question — can this box enhance, at which step counts, and
// how fast has it actually gone here — and `enh` is the page's only copy of that answer. Every
// other name in this file is downstream of that one object: `loadEnhanceInfo` writes it,
// `enhEta`/`ETA_UNKNOWN` do arithmetic on its measured rates, and `bandPill`/`enhBtn`/
// `pgUpdateEnh`/`bkUpdateEnh` render it. That is why they moved as a group rather than being
// filed by which panel happens to call them: split anywhere and `enh` ends up on one side of a
// module boundary with its only writer or its only readers on the other.
//
// 🔴 EVERY DEFINITION IN THE RANGE IS EXPORTED, AND THAT IS THE MEASUREMENT, NOT A DEFAULT.
// Ten definitions, ten with callers outside the range — Playground, Book, Clips, Speech
// sources, Bulk and Voice Training all read `enh` or paint one of these badges. Nothing here
// turned out to be private, which is the same finding DESIGN_7_3_FRONTEND_SPLIT.md §5 m6
// records from the other direction: "they share the log sink and the enhance badges".
//
// 🔴 THIS MODULE MUST BE ADDED TO THE SHIM'S `Object.assign`, LIKE `util/filter.js` AND UNLIKE
// `util/dom.js`/`util/http.js`. Roughly thirty still-inline sites reach `enh`, `enhEta`,
// `ETA_UNKNOWN`, `badgeLine`, `bandPill`, `sizeTip`, `enhBtn`, `pgUpdateEnh` and `bkUpdateEnh`
// as bare globals; there is no other route to them until those areas are modules themselves.
// Miss this line and the page throws `enh is not defined` the first time a clip list renders.
//
// ⚠️ AND `Object.assign` IS SAFE HERE FOR THE SAME REASON IT WAS SAFE FOR `FILT`. It copies the
// object REFERENCE, and `loadEnhanceInfo` only ever mutates properties — `enh.ok=…`, never
// `enh=…`. So the inline readers and this module see one object. Had anything reassigned `enh`,
// the shim would have frozen a stale snapshot on `window` and the two halves would have drifted
// silently, which is exactly the failure that is invisible until a card is ticked.
//
// ⚠️ NOTHING IN THIS FILE IS PARSE-TIME REACHABLE — checked by hand, transitively, over the
// top-level statements (including indented continuation lines) and both surviving top-level
// IIFEs, `UIS` and `vcInitLang`. Zero hits. `loadEnhanceInfo` was pinned in
// `tests/test_webui_parsetime.py` until 7.3-m2 took the boot IIFE out of the classic script;
// it is now called from `js/main.js`, which is a module and resolves it at CALL time.
//
// 🔴 SO `loadEnhanceInfo` MUST STAY EXPORTED AND MUST STAY PUBLISHED. `js/main.js` reaches it
// as a global (`await loadEnhanceInfo()`), and `index.html`'s Devices save calls it again after
// a card is ticked — that re-callability is 7.2-m6 and it is the whole reason the function is
// idempotent. Drop it from the shim and boot dies at the fifth await with no card ticked and no
// message, which reads as "enhancement is broken" rather than as "a name went missing".
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ fmtEta WAS THE FOURTH NAME ON THIS LIST AND IS NOW A REAL IMPORT (7.3-m4). It went to
// `util/fmt.js` — which this comment used to say it would NOT do, on the grounds that fmt.js
// "deliberately holds only fmtDur/fmtSize/fmtDate today". That was a description of the status
// quo mistaken for a rule: fmtEta is a formatter, it was a bare `const` sitting ~1,300 lines from
// its three siblings inside the Voice-training banner, and the only thing keeping it there was
// that its first caller happened to be there. §11.5 item 2.
//
// ⚠️ THREE NAMES BELOW ARE STILL INLINE GLOBALS, DELIBERATELY NOT IMPORTED AND NOT DUPLICATED.
// A module body resolves a global at CALL time and modules run after the whole document is
// parsed, so every one of these exists by then (§11.3). Each becomes a real `import` when its
// own area lands; none of them is touched at this module's top level, so evaluation order
// cannot matter:
//
//     UIS         index.html:2764, the server-backed UI state factory. Read by
//                 `loadEnhanceInfo` and written by the `bkEnh` change handler. It CANNOT move
//                 before m12 — §11.2 — so this reference outlives most of the milestone.
//     state       index.html:2865, the page's job/book state. `state.pgEnh` (enhBtn),
//                 `state.bookChars` and `state.chapters` (bkUpdateEnh).
//     pgEdited    index.html:4609. Called by the `pgEnh` change handler; moves with `pg/`.
//
// 📌 `badgeLine` AND `sizeTip` ARE FILED HERE BY POSITION, AND §4 PROPOSES `util/fmt.js` FOR
// `badgeLine`. They sit inside the 4.1 banner because that is where the full-quality pill first
// needed them, and they came with the range rather than being split into a second file. Neither
// touches `enh`, so moving them to `util/fmt.js` later is a straight lift with no untangling.
// 📌 The trigger this named — "worth doing when `fmtEta` moves" — has now happened, and the two
// were deliberately NOT bundled in with it: fmtEta had callers in two modules reaching it as a
// global, which is a defect being closed, while these two have no such pressure. Move them when
// something is actually served by it.

import { $, esc } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { jget } from '../util/http.js';
import { fmtDur, fmtEta } from '../util/fmt.js';
import { modal } from '../ui/modal.js';
import { pgEditedFire } from '../pg/pgstate.js'; // 7.5.6 — was `pgEdited` from playground.js,
// which was half of a module cycle (see pgstate)

// ── 4.1: bandwidth extension ────────────────────────────────────────────────
// Chatterbox synthesizes at 24 kHz and is digitally silent above ~11 kHz. Enhancement
// invents plausible content up to ~22 kHz. It is a POST-PASS on the finished audio, never
// part of the stream — so what you hear live is the raw take and the file you keep is the
// enhanced one. Every number below comes from the server (/enhance/info); none is
// hardcoded here, because they were all measured and they will all move again.
// `seen` is "has /enhance/info ever answered", which is NOT the same as `ok` being false — see
// loadEnhanceInfo, where the difference decides whether the tick boxes get their defaults re-applied.
/** Shared `/enhance/info` response. Mutate this object as fields load so readers keep a stable reference.
 * * @typedef {object} EnhState
 * @property {boolean} ok      `i.available` — the venv is installed AND a local card is ticked.
 * @property {boolean} seen    Has `/enhance/info` ever answered at all.
 * @property {number[]} choices  Step counts offered.
 * @property {number} def        Default step count.
 * @property {Record<string, number>} rates    Seconds of GPU per second of audio, keyed by step
 *   count — only what THIS box has actually been timed at; an absent key means untimed, not zero.
 * @property {Record<string, number>} startup  Model-load seconds, same keying.
 * @property {number} cards
 * @property {number} cps    Chars per second of AUDIO — turns a char count into a duration.
 * @property {number} cap    Cap, in seconds, on one enhance job.
 * @property {string} msg    Why enhancement is unavailable, or `''`.
 */
/** @type {EnhState} */
export const enh = {
  ok: false,
  seen: false,
  choices: [8, 16, 32],
  def: 32,
  rates: {},
  startup: {},
  cards: 1,
  cps: 15.6,
  cap: 3600,
  msg: '',
};
// Seconds of GPU for `secs` of audio, split over `files` runs of the enhancer on `cards`
// cards. The model load is paid PER FILE, not per book — leave it out and a 25-second clip
// is quoted at about half its real cost, because at that length the load is half the job.
//
// NULL WHEN THIS BOX HAS NOT BEEN TIMED at this step count. There is no fallback constant to
// reach for any more: the rates come from what this machine actually did (enhance_rate.py),
// and before the first run there is nothing to say. Every caller renders that as ETA_UNKNOWN
// rather than printing a number nobody measured — the 0.271 that used to sit in this line
// was an R9700's, and on anyone else's card it was fiction.
export const ETA_UNKNOWN = 'no estimate yet — this box hasn’t been timed. This run will be timed, and the next one will have a number.';
/**
 * @param {number} secs @param {number} nfe @param {number} [files] @param {number} [cards]
 * @returns {number|null}
 */
export const enhEta = (secs, nfe, files = 1, cards = 1) => {
  const rate = enh.rates[nfe],
    start = enh.startup[nfe];
  if (rate == null || start == null) return null;
  return (Math.max(1, files) * start + secs * rate) / Math.max(1, cards);
};
// A full-quality clip: enhanced, OR a high-resolution upload that never needed it. The pill
// reads the MEASUREMENT, not a flag — which is the only thing that gets both right.
//
// The badge used to say "full-band", and its opposite "band-limited". Both are jargon, and
// they sit on rows the user reads constantly. "Full quality" covers BOTH cases it has to
// cover — enhanced, and never-dull-to-begin-with — and "Standard quality" describes the
// other without grading it: it is what Chatterbox standardly produces, and the user did not
// do anything wrong by having it.
/** Optional clip metadata read by enhancement controls; each source store supplies a different subset.
 * * @typedef {object} EnhRow
 * @property {boolean} [band_limited]
 * @property {number} [bandwidth_hz]
 * @property {boolean} [enhanced]
 * @property {number} [nfe]
 * @property {string} [kind]
 * @property {number} [prefix]
 *   🔴 A CHUNK COUNT, NOT A STRING — `playground_clips.py:515` builds it as `prefix = 0` then
 *   `prefix += 1` per contiguous chunk, and `pg/pgstate.js`'s `PgClip.prefix` already said
 *   `number`. Declared `string` here, it made `PgClip` and `EnhRow` mutually non-assignable and
 *   forced an `unknown`-hop cast at all three `renderPgLib` call sites. Nothing broke at runtime
 *   because the only read is `!c.prefix`, which is truthy-equivalent either way — so the two
 *   halves of one row shape disagreed for as long as nobody wrote them down next to each other.
 *   ⚠️ Found by cross-checking two writers' reports against each other, not by either alone.
 * @property {string} [ref]
 * @property {string} [name]
 * @property {number|null} [duration_s] - null when ffprobe could not measure it; the
 *    producer (voice/training.js's VtSourceRow) has always said so.
 * @property {number} [size]
 * @property {string} [format]
 * @property {string} [file]
 */
/** @param {EnhRow} r */
export const bandPill = r =>
  r.band_limited === false && r.bandwidth_hz
    ? `<span class="badge up" title="Full quality — this clip has the crisp high end that makes audio sound present and real.${r.enhanced ? ' It was enhanced: that detail was reconstructed by the enhancer rather than recorded.' : ''}">Full quality${r.enhanced ? ' ✨' : ''}</span>`
    : '';
// Badges that annotate a NAME always get their own line beneath it — never inline. The name
// is user-written text (a Playground clip's name IS the prompt), so an inline pill lands in
// the middle of a wrapped sentence and reads as part of it. The partial row already worked
// this way; the full-band pill has to match, and so does anything added next to it later.
/** @param {...(string|false|null|undefined)} b */
export const badgeLine = (...b) => {
  const s = b.filter(Boolean).join(' ');
  return s ? `<div style="margin-top:3px">${s}</div>` : '';
};
// The Size cell's tooltip is where the FILE lives: its real name on disk, its format, and
// the bitrate neither of those tells you. A clip's display name is the user's — renamed,
// identity suffix stripped — so without this there is nowhere in the UI that says what a
// clip actually IS. The bitrate is measured off the bytes, not read off the enhance flag.
//
// The WAV rows (partial renders — raw 24 kHz mono PCM_16 chunks) measure out at ~384 kbps,
// which reads as a LIE next to the 1411 kbps everyone knows WAV by. That number is CD:
// 44.1 kHz, 16-bit, STEREO. 24 kHz × 16 × mono really is 384 kbps. Say "uncompressed" so
// the number is read as PCM arithmetic and not as a codec setting someone chose badly.
/** @param {EnhRow} c */
export const sizeTip = c => {
  const kbps = c.duration_s && c.size ? Math.round((c.size * 8) / c.duration_s / 1000) : 0;
  const rate = kbps ? `  ·  ~${kbps} kbps${(c.format || '') === 'wav' ? ' (uncompressed)' : ''}` : '';
  return esc(`type: ${(c.format || '?').toUpperCase()}${rate}`) + '&#10;' + esc(c.file || '');
};
// Enhance-in-place. Disabled — but still GREEN and still there — once a clip is full quality,
// because "there is nothing to do here" is information; hiding the button would just look
// like the feature was missing. The reason lives on a wrapping span: a disabled button
// swallows its own hover, so its title never shows.
/** @param {EnhRow} c */
export const enhBtn = c => {
  if (c.kind === 'partial') {
    // A partial can be enhanced non-destructively. It snapshots the
    // story-so-far into a NEW full-quality clip and leaves the partial resumable; you keep
    // both. Only offered when there's banked audio and the enhancer is up. Its own snapshot
    // running ⇒ the button becomes that job's ■ (the partial is safe either way).
    if (!c.prefix || !enh.ok) return '';
    if (state.pgEnh.has(/** @type {string} */ (c.ref)))
      return (
        `<span title="Stop the snapshot — the partial is untouched either way."` +
        `><button class="xs danger" data-enhstop="${esc(c.ref)}">■</button></span> `
      );
    return (
      `<span title="Enhance the story so far into a NEW, full-quality clip. The partial is left exactly as it is and can still be continued — you keep both."` +
      `><button class="xs enh" data-enhpart="${esc(c.ref)}">E</button></span> `
    );
  }
  // Its own enhancement is running: the button becomes that job's ■. The row is the only
  // place it can live — with two enhancements in flight, a single shared Cancel could not
  // say which one it would stop. Canceling leaves the ORIGINAL clip (the server does not
  // touch it until the enhanced file is safely on disk), so this is always safe to press.
  if (state.pgEnh.has(/** @type {string} */ (c.ref)))
    return (
      `<span title="Stop enhancing “${esc(c.name)}” — the clip is left exactly as it is now."` +
      `><button class="xs danger" data-enhstop="${esc(c.ref)}">■</button></span> `
    );
  // Unmeasured is NOT the same as full quality, even though both leave nothing to do here.
  // Saying "already full quality" about a file we couldn't read would be a confident lie.
  const known = !!c.bandwidth_hz,
    full = known && c.band_limited === false,
    why = !known
      ? `Vocalis couldn't measure this clip, so it can't tell whether enhancing would add anything to it.`
      : full
        ? c.enhanced
          ? `Already enhanced${c.nfe ? ` at ${c.nfe} steps` : ''} — full quality. Nothing left to add.`
          : `Already full quality — this clip has its crisp high end, so there is nothing to put back. (Measured, not assumed.)`
        : !enh.ok
          ? enh.msg
          : `Enhance — the audio equivalent of an AI upscaler. It puts back the crispness Chatterbox can't produce, and REPLACES this clip with the upscaled version at 256 kbps.`;
  const off = full || !known || !enh.ok;
  return `<span title="${esc(why)}"><button class="xs enh" data-enh="${esc(c.ref)}"${off ? ' disabled' : ''}>E</button></span> `;
};
// Recheck availability after device changes: the server requires an installed venv and at least
// one enabled local card, so availability can change during a session.
//
// ⚠️ THE TICK DEFAULTS ARE APPLIED ONLY WHEN AVAILABILITY CHANGES, which is why `enh.seen` exists.
// Re-running this on every device save would otherwise re-tick Playground Enhance — deliberately ON
// each session — underneath a user who had just turned it off for one raw take, and silently
// re-read the book box from storage over a choice he had made this minute.
export async function loadEnhanceInfo() {
  const had = enh.seen ? enh.ok : null; // null on the very first call: everything is a change
  try {
    const i = await jget('/enhance/info');
    enh.ok = !!i.available;
    enh.choices = i.nfe_choices || enh.choices;
    enh.def = i.nfe_default || enh.def;
    // Both maps are keyed by STEP COUNT and hold only what this box has been timed at. An
    // absent key means "never run at these steps here" — not "use the default's number".
    enh.rates = i.seconds_per_audio_second || {};
    enh.cards = Math.max(1, i.cards || 1);
    enh.startup = i.startup_seconds || {};
    enh.cps = i.chars_per_audio_second || enh.cps;
    enh.cap = i.cap_seconds || enh.cap;
    enh.msg = i.message || '';
  } catch (e) {
    enh.ok = false;
    enh.msg = 'Could not reach the server to check whether enhancement is available.';
  }
  /** @type {VEl} */ ($('bkNfe')).innerHTML = enh.choices
    .map(n => `<option value="${n}"${n === enh.def ? ' selected' : ''}>${n} steps</option>`)
    .join('');
  if ($('blkNfe'))
    /** @type {VEl} */ ($('blkNfe')).innerHTML = enh.choices
      .map(n => `<option value="${n}"${n === enh.def ? ' selected' : ''}>${n} steps</option>`)
      .join('');
  // Where enhancement is impossible (no venv, no card — the Windows dev box) the boxes go
  // dead and UNTICKED, and the note says why. A ticked box that silently does nothing is
  // worse than no box.
  enh.seen = true;
  // The DISABLED state tracks the server on every call — that is the half that was stuck.
  for (const id of ['pgEnh', 'bkEnh']) /** @type {HTMLInputElement} */ ($(id)).disabled = !enh.ok;
  if (had !== enh.ok) {
    if (!enh.ok) {
      for (const id of ['pgEnh', 'bkEnh']) /** @type {HTMLInputElement} */ ($(id)).checked = false;
    }
    // Playground Enhance returns to on each session and is deliberately not persisted, avoiding
    // an unnoticed long raw take after an earlier temporary opt-out.
    // Un-tick it per render for the raw take; a reload comes back on. The BOOK box still remembers
    // its choice — an audiobook's enhance setting is a per-book decision, not a momentary one.
    // (M8: the book box's memory is UIS, not localStorage — it rides in the vault with the rest.)
    else {
      /** @type {HTMLInputElement} */ ($('pgEnh')).checked = true;
      try {
        /** @type {HTMLInputElement} */ ($('bkEnh')).checked = UIS.getItem('vocalis-book-enh') !== '0';
      } catch (e) {}
    }
  }
  pgUpdateEnh();
  bkUpdateEnh();
}
export function pgUpdateEnh() {
  if (!enh.ok) {
    /** @type {VEl} */ ($('pgEnhNote')).innerHTML = `<span style="color:var(--warn)">${esc(enh.msg)}</span>`;
    return;
  }
  /** @type {VEl} */ ($('pgEnhNote')).innerHTML = /** @type {HTMLInputElement} */ ($('pgEnh')).checked
    ? `<span class="muted">The finished clip is enhanced (upscaled) and saved at 256 kbps. What you hear streaming is the raw take — the clip you keep is the enhanced one.</span>`
    : `<span style="color:var(--warn)">Saved as-is: 96 kbps, without the enhance pass. You can enhance the clip later from the library.</span>`;
}
// The book's ETA, in hours, BEFORE you commit to it. characters ÷ chars-per-audio-second
// gives the book's audio length; audio length × the per-step rate gives the GPU time. A
// ten-hour book at 32 steps is about eight hours of enhancement — that is not a number to
// discover afterward, and it is the entire reason the step count is exposed at all.
export function bkUpdateEnh() {
  const on = enh.ok && /** @type {HTMLInputElement} */ ($('bkEnh')).checked;
  /** @type {HTMLSelectElement} */ ($('bkNfe')).disabled = !on;
  if (!enh.ok) {
    /** @type {VEl} */ ($('bkEnhEta')).innerHTML = '';
    /** @type {VEl} */ ($('bkEnhNote')).innerHTML = `<span style="color:var(--warn)">${esc(enh.msg)}</span>`;
    return;
  }
  if (!on) {
    /** @type {VEl} */ ($('bkEnhEta')).innerHTML = '';
    /** @type {VEl} */ ($('bkEnhNote')).innerHTML =
      '<span style="color:var(--warn)">⚠ Chapters will be saved exactly as Chatterbox renders them — 96 kbps, and slightly muffled. The audiobook will be noticeably duller.</span>';
    return;
  }
  /** @type {VEl} */ ($('bkEnhNote')).innerHTML = '';
  const chars = state.bookChars || 0;
  if (!chars) {
    /** @type {VEl} */ ($('bkEnhEta')).innerHTML = '<span class="muted">pick a book above to see the hours this adds.</span>';
    return;
  }
  const nfe = +(/** @type {HTMLSelectElement} */ ($('bkNfe')).value) || enh.def;
  const audioS = chars / enh.cps;
  // Chapters are independent files, which is the ONE condition under which spreading
  // across cards buys anything — so the estimate may divide by them, but never by more
  // cards than there are chapters to put on them.
  const chapters = state.chapters.length || 1;
  const cards = Math.max(1, Math.min(enh.cards, chapters));
  const secs = enhEta(audioS, nfe, chapters, cards); // one enhancer run per chapter
  // Untimed box: the hours are exactly what you must NOT invent. This is the number a user
  // decides a ten-hour commitment on, and a made-up one is worse than an absent one.
  /** @type {VEl} */ ($('bkEnhEta')).innerHTML =
    (secs ? `≈ <b>${fmtEta(secs)}</b> of enhancement, <i>on top of</i> the render` : `<span class="muted">${ETA_UNKNOWN}</span>`) +
    `<div class="muted">${fmtDur(audioS)} of audio · ${nfe} steps · ${cards} card${cards > 1 ? 's' : ''}</div>`;
}
/** @type {VEl} */ ($('bkNfe')).addEventListener('change', bkUpdateEnh);
/** @type {VEl} */ ($('bkEnh')).addEventListener('change', async e => {
  try {
    UIS.setItem('vocalis-book-enh', /** @type {HTMLInputElement} */ (e.target).checked ? '1' : '0');
  } catch (x) {}
  bkUpdateEnh();
  // Warn on UNTICK, before the render starts — the chapters are what they are once made.
  if (!(/** @type {HTMLInputElement} */ (e.target).checked))
    await modal(
      'Render without enhancement?',
      `The chapters will be saved exactly as Chatterbox renders them: <b>96 kbps, and slightly muffled</b>. The audiobook will sound noticeably duller than one that was enhanced.<br><br><span class="muted">You can turn this back on — but not once the render has started. An audiobook with some chapters crisp and some dull is worse than either one consistently, so the setting is fixed for the whole book.</span>`,
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
});
/** @type {VEl} */ ($('pgEnh')).addEventListener('change', e => {
  // Not persisted by design (see loadEnhanceInfo) — Enhance returns to ON each session.
  // pgEdited(), not just a repaint: enhance is part of the clip's IDENTITY, so flipping it
  // re-points the stored-take player AND disarms a loaded partial's green "Continue" — that
  // partial belongs to a different H now, and continuing it would be a lie.
  pgUpdateEnh();
  pgEditedFire();
});

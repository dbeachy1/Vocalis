// ui/theme.js — the type scale, the dark/light theme, and the app-settings reconcile that binds
// them (7.3-m12b, §4 and §5's m2 row, which has been carrying this file as "the only piece of m2
// still inline" since m2a).
//
// 27 lines of code out of THREE ranges: `── the type scale (7.2-m3) ──`, the uiFont/logAnsi wiring
// that sat ~50 lines below it under a pointer comment, and `── theme ──`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 §11.9 FLAGGED THIS AS "NOT A MECHANICAL CUT" FOR ELEVEN MILESTONES, AND THE REASON IS THE
// TOP-LEVEL `uiFontApply(c)` CALL. Here is what it turned out to be.
//
// It reads like a pre-paint restore that cannot possibly move — and it is not one. **The actual
// pre-paint work is done by a separate `<head>` block** (index.html:794), which sets `--fs` from
// localStorage before anything is drawn and is one of §4's three leaves that stay in the page
// forever. What the top-level call in the application script did was **sync the slider control**,
// because the `<head>` script runs before the DOM exists and therefore cannot touch it. Its own
// comment said so, and named the bug it fixed: the page sat at 20px while the control still read
// 16, found by `ui_font_browser_spec` on its first run.
//
// So the question was never "does this flash?" — the size is already right before first paint —
// it is **how long the CONTROL may disagree with the PAGE**. Inline, that window was the rest of
// the inline block. Here it is module-eval: later, but still far ahead of `loadAppSettings`'s
// fetch, which is what the original comment rejected as too slow. §11.9 called that "very likely
// fine and the cheaper option by a lot", and said to VERIFY rather than reason — so the move was
// made and `ui_font_browser_spec.mjs` run against it specifically. It holds: the spec's own
// `waitFor($('uiFont').value === '20', 5000)` is exactly the assertion that measures this window,
// and it was written because the window has always been non-zero.
//
// ✅ SO NOTHING IS DUPLICATED. §3.1a's other exit — duplicate `uiFontApply` and leave the original,
// the way m3e duplicated `AUDITION_TEXT` — was not needed, and a duplicate always costs a drift
// test (7.3-m8c is what deleting one of those looks like).
//
// 📌 THE SAME ARGUMENT COVERS `applyTheme`, and it is the easier half: the theme's pre-paint block
// is index.html:792 and sets `data-theme` before paint. The top-level `applyTheme(…)` call here
// re-reads that attribute and syncs `#themeSel` — a control sync, not a paint.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WHY `loadAppSettings` IS IN A FILE CALLED theme.js, WHEN IT ALSO LOADS THE LOG PATH AND THE
// KOBOLD PANEL. Because it shares `uiFontTouched` with the slider, and that is not a coincidence —
// it is a stale-response guard. `loadAppSettings()` is a fetch; if the user drags the slider while it
// is in flight, its `uiFontApply(s.ui_font_px)` lands afterward and snaps the size back to
// whatever the server had. Split the two and `uiFontTouched` is a `let` whose only writers are on
// the other side of a file boundary — the straddling-`let` shape that decided m4m, m6c, m8b, m9a
// and m6e, and the one the `Object.assign` shim provably cannot carry (§11.4).
//
// The rest of `loadAppSettings` is three lines of assignment and one call into `sys/kobold.js`.
// Filing it with the race it exists to lose to is more honest than a `ui/appsettings.js` holding
// four unrelated lines and half of a race.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — two names, and the reasons are different.
//
//   uiFontApply       for `tests/ui_font_browser_spec.mjs`, which drives it through CDP as a page
//                     global at three points, including its readiness gate
//                     (`typeof uiFontApply === 'function'`). A spec caller is a caller (§11.16).
//   loadAppSettings   `js/main.js`'s boot IIFE awaits it, and imports it directly rather than
//                     reading it off the shim. The same spec also calls it twice, deliberately —
//                     once as setup and once as the assertion that a stale response loses.
//
// ⚠️ `uiFontTouched` IS NOT EXPORTED AND MUST NOT BE. It is a reassigned `let`, so the shim's
// `Object.assign` would copy `false` once and freeze it — the m4m/m6e trap. Nothing outside needs
// it; both writers and its one reader are in this file, which is the point of the paragraph above.
// `applyTheme`, `UI_FONT_DEFAULT`, `UI_FONT_MIN` and `UI_FONT_MAX` are private for the ordinary
// reason: the measured reference count outside this range was zero.
//
// 📌 IT WIRES AT MODULE LOAD — #uiFont, #uiFontReset, #logAnsi, #themeSel — and runs two control
// syncs in its body, so the import is load-bearing beyond the two names it publishes.

import { $ } from '../util/dom.js';
import { jget } from '../util/http.js';
import { kobRenderSettings } from '../sys/kobold.js';
import { llaRenderSettings } from '../sys/llama.js'; // 9.5-m1, the second engine's panel
import { devRenderSettings } from '../sys/devices.js'; // 9.5-m3, the tick-a-card warning
// ── the type scale (7.2-m3) ────────────────────────────────────────────────
// 🔴 ONE PAINTER, so the slider, the readout, the CSS variable and the localStorage cache can
// never disagree. Three call sites set this (load, drag, reset) and the last time this page had
// three inline copies of one piece of state it was §9a.27's save control, which drifted.
const UI_FONT_DEFAULT = 16,
  UI_FONT_MIN = 12,
  UI_FONT_MAX = 24;
// 🔴 A STALE RESPONSE MUST NOT OVERWRITE A NEWER CHOICE — the same rule 7.1 §4's generation
// token exists for, in miniature. `loadAppSettings()` is a fetch; if the user drags the slider while
// it is still in flight, its `uiFontApply(s.ui_font_px)` lands afterward and snaps the size back
// to whatever the server had. Rare in a browser and NOT rare in a spec, which is how it was
// found: the drag checks failed intermittently depending on which won the race.
let uiFontTouched = false;
/**
 * @param {string|number} px — unparsed: a slider's `.value` (string) or the server's
 *   `ui_font_px` (number). `parseInt` below takes either.
 * @param {{persist?: boolean}} [o]
 * @returns {number} the clamped size actually applied.
 */
export function uiFontApply(px, { persist = false } = {}) {
  // `String(px)` MADE EXPLICIT: `parseInt` always coerced a numeric `px` (the server's
  // `ui_font_px`) to a string internally — this is that coercion written down, not a behavior
  // change, and it is what lets the parameter stay honestly `string|number`.
  const v = Math.max(UI_FONT_MIN, Math.min(UI_FONT_MAX, parseInt(String(px), 10) || UI_FONT_DEFAULT));
  document.documentElement.style.setProperty('--fs', v + 'px');
  // Logs that follow their tail re-wrap without changing size; this tells them (ui/log.js).
  window.dispatchEvent(new Event('vocalis:fontsize'));
  const sl = /** @type {HTMLInputElement} */ ($('uiFont')),
    out = $('uiFontOut');
  if (sl) sl.value = String(v); // an input's .value is a string; the runtime was coercing this
  if (out) out.textContent = v + ' px';
  try {
    localStorage.setItem('vocalis-ui-font', String(v));
  } catch (e) {}
  // 🔴 DEBOUNCED, AND THE FIRST VERSION WAS NOT — it PUT on every `input` event, so one drag
  // fired a dozen overlapping fire-and-forget requests at a route that does
  // load → mutate → save. That is a lost-update race by construction, and the full suite caught
  // its other half two runs later: two writers sharing one `.yaml.part` temp, the second one's
  // `atomic_replace` raising FileNotFoundError.
  //
  // ⚠️ THE SERVER IS WHERE THAT IS ACTUALLY FIXED (`settings.APP_LOCK`), because any client can
  // send two requests at once and a debounce is not a correctness mechanism. This is here
  // because firing ~30 writes to disk to answer one drag is wrong on its own terms.
  //
  // 📌 Still fire-and-forget once it does go: the value is already applied and already cached
  // locally, so a failed PUT costs the next DEVICE, not this session. Awaiting it would make a
  // slider feel broken on exactly the slow link this helps most.
  if (persist) {
    clearTimeout(uiFontApply._t);
    uiFontApply._t = setTimeout(() => {
      fetch('/settings/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui_font_px: v }),
      }).catch(() => {});
    }, 250);
  }
  return v;
}
// The debounce handle above is parked on the function itself — same convention as the `_t` this
// app puts on elements. TypeScript only recognizes a function expando when it is assigned in the
// same scope as the declaration, so this line is what declares it; `clearTimeout(undefined)` is
// already the no-op the first call relied on, so initializing it changes nothing at runtime.
/** @type {ReturnType<typeof setTimeout>|undefined} */
uiFontApply._t = undefined;

export async function loadAppSettings() {
  try {
    const s = await jget('/settings/app');
    // The server is the record; the pre-paint script only had localStorage. Reconcile without
    // persisting — writing back here would turn a read into a write on every page load.
    // ⚠️ NEVER OVER A CHOICE MADE WHILE THIS FETCH WAS IN FLIGHT. See `uiFontTouched`: this
    // response is by definition older than a drag that has already happened.
    if (s.ui_font_px && !uiFontTouched) uiFontApply(s.ui_font_px);
    /** @type {HTMLInputElement} */ ($('logAnsi')).checked = s.log_ansi_colors !== false;
    if (s.log_path) {
      /** @type {VEl} */ ($('logPath')).textContent = s.log_path;
      /** @type {VEl} */ ($('stLogPath')).textContent = s.log_path;
      // Docker package: the path is relative to the data folder chosen at setup, not to the
      // container; say where it is (release audit 2026-10-11, item 7). Empty on a source run.
      const where = s.log_path_in_data_folder ? ' (inside the data folder you chose at setup)' : '';
      for (const id of ['logPathWhere', 'stLogPathWhere']) {
        const el = $(id);
        if (el) el.textContent = where;
      }
    }
    kobRenderSettings(s);
    llaRenderSettings(s);
    devRenderSettings(s);
  } catch (e) {}
}

// ⚠️ SYNC THE CONTROL FROM THE CACHE AT WIRE TIME, not only from the settings fetch. The
// pre-paint <head> script runs before the DOM exists, so it can set `--fs` but cannot touch the
// slider; loadAppSettings fixes it, but that is a round trip away. In between, the page is
// already at 20px while the control still reads 16 — caught by ui_font_browser_spec on its
// first run. No `persist`: this is a read of what was already saved, not a new choice.
// 🔴 THIS IS THE LINE §11.9 WAS ABOUT. It ran during parsing when it was inline and runs at
// module-eval now — later, but still ahead of the fetch it exists to pre-empt. See the header.
try {
  // `?? ''` rather than a non-null cast: getItem is honestly `string|null`, and parseInt('')
  // and parseInt(null) are both NaN, so this states the truth without changing what runs.
  const c = parseInt(localStorage.getItem('vocalis-ui-font') ?? '', 10);
  if (c) uiFontApply(c);
} catch (e) {}
// `input`, not `change` — it must move as he drags, because judging a text size means seeing it
// against the page, not committing and then evaluating.
// `uiFontTouched` is set HERE, on the two deliberate acts, rather than inside `uiFontApply` —
// which is also called by the boot reconcile and by the cache sync, neither of which is a choice.
/** @type {VEl} */ ($('uiFont')).addEventListener('input', e => {
  uiFontTouched = true;
  uiFontApply(/** @type {HTMLInputElement} */ (e.target).value, { persist: true });
});
/** @type {VEl} */ ($('uiFontReset')).addEventListener('click', () => {
  uiFontTouched = true;
  uiFontApply(UI_FONT_DEFAULT, { persist: true });
});
/** @type {VEl} */ ($('logAnsi')).addEventListener('change', () => {
  fetch('/settings/app', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ log_ansi_colors: /** @type {HTMLInputElement} */ ($('logAnsi')).checked }),
  }).catch(() => {});
});

// ── theme (dark default; persisted; applied pre-paint in <head>) ─────────
/** @param {string} t — `'dark'` or `'light'`. */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem('vocalis-theme', t);
  } catch (e) {}
  /** @type {HTMLSelectElement} */ ($('themeSel')).value = t;
}
/** @type {VEl} */ ($('themeSel')).onchange = e => applyTheme(/** @type {HTMLSelectElement} */ (e.target).value);
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

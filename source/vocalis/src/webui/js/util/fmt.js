// util/fmt.js — the three display formatters the whole page shares (7.3-m1a).
//
// Moved verbatim from `index.html`, where they sat at 2669–2671 between the voice-cluster
// painting and the ONE FILTER block, for no reason other than that being where the first
// caller needed them. They are pure functions of their argument: no DOM, no fetch, no module
// import, nothing to go wrong in a different execution order.
//
// 🔴 THESE ARE NOT THE EDITOR'S `js/wb/fmt.js`, AND THE TWO MUST NOT BE MERGED. That file
// exports exactly one name — `wbWhen`, which renders a worldbook revision's timestamp as
// "just now" / "3 hours ago" for the editor's own log. It is a different job with a different
// audience, and DESIGN_7_3_FRONTEND_SPLIT.md §4's open question "merge or keep separate"
// resolved to SEPARATE on that basis. Merging them would give the editor a dependency on the
// page's formatters and vice versa, for a saving of one file.
//
// ⚠️ WHY THESE COULD GO FIRST, WHEN `filtWire` COULD NOT. Nothing calls them during parsing.
// The parse-time surface is nine names (§3.1a) and none of them is a `fmt*`; the module copy
// therefore does not need an inline twin the way `$`, `esc` and the `j*` helpers do.
// `tests/test_webui_parsetime.py` is what makes that a checked claim rather than a reading.
//
// 📌 They are published to `window` by the shim at the bottom of `index.html`, because 14–17
// still-inline areas call each of them. That line goes away in m13 along with the shim; these
// functions do not change when it does.

// Seconds → "1h 4m" or "4m 12s". Hours suppress the seconds entirely: at that length the
// caller is quoting a book render, and a second's precision is noise in a number nobody can
// act on. Under an hour the seconds are the interesting part, so they stay.
/**
 * @param {number|null|undefined} s — seconds. Nullish is treated as 0 by the `s || 0` below,
 *   because callers pass a payload field that is routinely absent (`b.total_duration_s`).
 * @returns {string}
 */
export const fmtDur = s => {
  s = s || 0;
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
};

// Bytes → "1.4 MB" or "812 KB". MB carries one decimal because the interesting comparison is
// between similar files; KB carries none, because a clip is never usefully "812.3 KB".
// ⚠️ `null` is empty string, NOT "0 KB" — a row whose size has not loaded yet must not claim
// to be an empty file.
/**
 * @param {number|null|undefined} b — bytes. Nullish renders as `''`, see above.
 * @returns {string}
 */
export const fmtSize = b => (b == null ? '' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB');

// Seconds → an ETA: "45s", "7m", "1h 04m". A SECOND formatter for a duration, and deliberately
// not fmtDur, because the two answer different questions: fmtDur reports a length that is known
// ("this clip is 4m 12s") while this one quotes a wait that is estimated.
//
// 🔴 UNDER 90 SECONDS IT SAYS THE SECONDS, and that threshold is load-bearing. Enhancing a
// Playground clip really does take about fifteen — and "<1m" reads as "too small to bother
// measuring", which is not the same claim as "fifteen seconds", and is what let a 5x-wrong rate
// constant hide for a day.
//
// 📌 MOVED HERE IN 7.3-m4 from a bare `const` inside index.html's Voice-training banner, ~1,300
// lines from its three siblings — §11.5 item 2. It was never training code; it just happened to be
// declared where its first caller was. `js/sys/enhance.js` and `js/media/cleanup.js` both reached
// it as an inline global, and this is the commit that stops them: two fewer inline reaches, and
// the last of the four formatters joins the file named after them.
/**
 * @param {number|null|undefined} s — seconds remaining, as estimated. Nullish is 0.
 * @returns {string}
 */
export const fmtEta = s => {
  s = Math.max(0, Math.round(s || 0));
  if (s < 90) return `${s}s`;
  const h = Math.floor(s / 3600),
    m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

// A song's seed → " · seed 42832463", or nothing at all when there isn't one.
//
// 🔴 A FORMATTER RATHER THAN FOUR TEMPLATE LITERALS, because this is now a rule about the whole
// app. Retake, ∞ Generate forever and a two-card Generate
// all produce sets of songs whose titles are identical by construction, so a title on its own does
// not identify a row anywhere it is shown: the ACE-Step library, the candidates tray, the Voice
// Swap sources, the Stems picker, and both trays.
//
// ⚠️ `0` IS A SEED and must print. Only null/undefined mean "this thing has no seed" — an upload, a
// stem set, a speech clip — so the test is on the value being nullish and never on falsiness.
// The separator is a parameter because a <select> option reads better with an em dash than with
// the interpunct the meta lines use.
/**
 * 🔴 THE UNION INCLUDES `string` BECAUSE THE WIRE DOES. A seed arrives as a number from the
 * generate routes and as the string it was typed as from a form field, and both must print. It is
 * interpolated, never compared, so widening here costs nothing — whereas demanding `{number}`
 * would put a `Number(...)` at call sites that never needed one.
 *
 * @param {number|string|null|undefined} seed — ⚠️ `0` IS A SEED and must print. Only nullish
 *   means "this thing has no seed" — an upload, a stem set, a speech clip.
 * @param {string} [sep] - defaults to ` · `.
 * @returns {string}
 */
export const fmtSeed = (seed, sep = ' · ') => (seed === null || seed === undefined ? '' : `${sep}seed ${seed}`);

// Unix seconds → a locale-formatted date. `[]` as the locales argument means "the browser's
// own preference", which follows the browser locale rather than server settings.
// ⚠️ The input is SECONDS, not milliseconds — every caller comes from Python's `time.time()`
// or a stat result, hence the *1000. A caller passing ms lands in the year 56000 silently.
/**
 * @param {number|null|undefined} ts — UNIX SECONDS. See the warning above; the type system
 *   cannot tell seconds from milliseconds, so this stays a comment somebody has to read.
 * @returns {string} `''` when there is no timestamp.
 */
export const fmtDate = ts =>
  ts
    ? new Date(ts * 1000).toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';

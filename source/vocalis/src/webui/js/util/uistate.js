// util/uistate.js — account-local UI state, stored server-side in the vault (7.3-m13; 5.0-M8 §4).
//
// The `localStorage`-shaped façade the whole front end uses to remember which tab you were on,
// which book was selected, what you had typed in the Playground box. Seventeen modules read it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THIS FILE WAS CANCELED FOR ELEVEN MILESTONES, AND BOTH REASONS EXPIRED RATHER THAN BEING
// SOLVED. §11.2 is titled *"`util/uistate.js` CANNOT BE BUILT"* and gives two blockers, "either one
// sufficient":
//
//   1. **`UIS` IS a top-level IIFE** — the factory runs during parsing to seed itself from
//      `window.__UI_STATE__` and migrate old localStorage keys. Parse-time code by construction.
//   2. **`UIS` is a parse-time RECEIVER** — ten top-level `UIS.getItem(…)` restores read it while
//      the document parses.
//
// ✅ **Blocker 2 fell at m12c and nobody aimed at it** (§11.29): every one of those ten restores
// traveled with its own area, one milestone at a time — the Book sub-tab restore at m2a, `ST_TABS`
// at m2b, `vSort`/`vcTabWant`/`vcTplSort` at m8b, `vocalis-pg-actions` at m6e, `vocalis-pg-text` at
// m12c. The parse-time scan reported `LEFT UIS` on a commit about voice clusters.
//
// ✅ **Blocker 1 falls here, by deletion.** "It is parse-time code" was only ever true relative to a
// classic script; m13 deletes that script, so this body runs at module-eval — after the document is
// parsed, which is strictly LATER and strictly safer. Nothing reads `UIS` before its importers'
// bodies run, because an import is resolved before the importing module's first statement.
//
// 🔴 AND IT IS NOT OPTIONAL AT m13, IT IS REQUIRED. §10 item 2 says `Object.assign(window, …)`
// appears nowhere. Seventeen modules reached `UIS` through the global scope chain; with no classic
// script there is no global `UIS` to reach. This file is what makes item 2 satisfiable.
//
// ⚠️ THE `<head>` BLOCK AT index.html:803 IS NOT WHAT MOVED AND MUST NOT. `window.__UI_STATE__` is
// substituted into the page by the server (`{{UI_STATE}}`), and a module gets no substitution — it
// is one of §4's three permanent leaves. This file READS that global; it does not produce it.
//
// 📌 A DUPLICATE WOULD HAVE BEEN ACTIVELY WORSE THAN NO MODULE, which is what §11.2's other
// paragraph is about: two `UIS` objects, each with its own debounce timer, both POSTing the whole
// state to `/ui-state`, last write wins. That hazard is gone by construction — a module is
// evaluated once per URL, so there is exactly one `s`, one timer and one flush.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 `CSRF` CAME WITH IT, and the reason it waited this long is not the one the shim recorded.
// That note said `CSRF` could never move because "a module gets no `{{…}}` template substitution".
// **`CSRF` is read from a `<meta>` tag** — ordinary markup, readable by anything, at any time
// (§11.27's shape: a stated reason that was never checked against the code). What actually held it
// here is directly below: the factory reads it AT PARSE TIME, so the two had to travel together.

export const CSRF = /** @type {{content?: string}} */ (document.querySelector('meta[name=csrf]') || {}).content || '';

// ── 5.0-M8: account-local UI state lives server-side, in the vault ────────────
// A localStorage-shaped façade over an object the server injected, so the ~40 call sites did not
// have to change when the store moved off the client. Writes are debounced 400ms and flushed on
// hide; reads are synchronous against the in-memory copy, which is what lets a restore run in a
// module body without awaiting anything.
export const UIS = (() => {
  // 🔴 THREE KEYS STAY ON THE CLIENT ON PURPOSE. Theme, volume and text size are properties of the
  // SCREEN you are sitting at, not of the account — and the first two are read by the pre-paint
  // `<head>` blocks, which run before any fetch could have returned. Round-tripping them would
  // make a second machine inherit the first one's font size and reintroduce the flash.
  const CLIENT_ONLY = new Set(['vocalis-theme', 'vocalis-vol', 'vocalis-ui-font']);
  const s = window.__UI_STATE__ && typeof window.__UI_STATE__ === 'object' ? window.__UI_STATE__ : {};
  // One-time migration off localStorage for anyone upgrading: take what is there, seed the
  // server copy with anything the server does not already have, and remove the local key so the
  // two can never disagree afterward.
  // 🔴 THE FLUSH IS A PER-KEY DELTA, NEVER THE WHOLE BLOB (8.0-m21). Every open tab holds its
  // own `s`, and a whole-blob POST from ANY of them overwrote all the others' newer keys —
  // which was the ACE-Step template amnesia: pick a template in one window, and the moment a
  // second window flushed anything (a tab click was enough) the pick was erased server-side.
  // Reproduced in tests/ace_draft_twotab_spec.mjs. So a tab now sends only the keys IT changed;
  // the server merges (`ui_state.apply_delta`). Two tabs editing the SAME key is still last
  // write wins — per-key is the granularity that matches "each window owns what you did in it".
  const dirty = new Set(),
    removed = new Set();
  const legacy = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('vocalis-') && !CLIENT_ONLY.has(k)) legacy.push(k);
    }
  } catch (e) {}
  let seeded = false;
  for (const k of legacy) {
    let v = null;
    try {
      v = localStorage.getItem(k);
    } catch (e) {}
    if (v !== null && !(k in s)) {
      s[k] = v;
      dirty.add(k);
      seeded = true;
    }
    try {
      localStorage.removeItem(k);
    } catch (e) {}
  }
  // ⚠️ `ReturnType<typeof setTimeout>` RATHER THAN `number`: the DOM lib types it as `number` and
  // `@types/node` as a `Timeout` object, and this tree is compiled with both on the path. Pinning
  // `number` here is the annotation that goes red on a devDependency bump rather than on a change
  // to this file.
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  async function flush() {
    if (!dirty.size && !removed.size) return;
    /** @type {Record<string,unknown>} */
    const set = {};
    for (const k of dirty) if (k in s) set[k] = s[k];
    const del = [...removed];
    const sentD = [...dirty],
      sentR = del;
    dirty.clear();
    removed.clear();
    try {
      const r = await fetch('/ui-state', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({ set, del }),
      });
      if (!r.ok) throw new Error('ui-state flush: HTTP ' + r.status);
    } catch (e) {
      // A failed flush is ROUTINE — it is what a service bounce looks like from here. Re-mark
      // and retry; forgetting instead is how a pick made in the 30s before a restart vanished.
      for (const k of sentD) if (k in s) dirty.add(k);
      for (const k of sentR) if (!(k in s)) removed.add(k);
      schedule(3000);
    }
  }
  /** @param {number} [ms] - the debounce, defaulting to 400. The retry path passes 3000. */
  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, ms || 400);
  }
  if (seeded) flush(); // persist the migrated state once
  // `keepalive` on the flush plus this listener is what makes a closed tab keep its state:
  // visibilitychange fires on hide, unlike unload, which is unreliable on mobile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) {
      clearTimeout(timer);
      timer = null;
      flush();
    }
  });
  return {
    /**
     * @param {string} k
     * @returns {string|null} — `null` for a key that has never been set, exactly as
     *   `localStorage.getItem` does. Every restore in the tree branches on that.
     */
    getItem: k => (k in s ? s[k] : null),
    /**
     * @param {string} k
     * @param {unknown} v — ⚠️ COERCED WITH `String(v)`, like `localStorage`. Callers pass numbers
     *   and booleans freely, and a restore always reads the string back — `'false'` is truthy, so
     *   the readers compare against `'1'`/`'0'` rather than testing the value.
     */
    setItem: (k, v) => {
      s[k] = String(v);
      dirty.add(k);
      removed.delete(k);
      schedule();
    },
    /** @param {string} k */
    removeItem: k => {
      if (k in s) delete s[k];
      removed.add(k);
      dirty.delete(k);
      schedule();
    },
  };
})();

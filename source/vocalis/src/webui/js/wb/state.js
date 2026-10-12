// Per-pane state for the World Book editor. `WB` stays module-private so document changes must
// use the generation helpers below; imported code cannot mutate the token directly.

/** Mutable state for one World Book editor pane. Keep this type file-local and declare lazily created fields without adding them to the runtime initializer. The loose payload shapes validate the field set.
 * @typedef {object} WbPaneState
 * @property {any} doc - the open document. `null` until one is loaded.
 * @property {any} rev - which revision is on screen; `null` means the head.
 * @property {any[]} fields - the entry rows as rendered.
 * @property {any} pass - the live proposal pass, or `null`.
 * @property {EventSource|null} es - the pass's SSE connection.
 * @property {Set<any>} seen - proposal ids already painted, so a replay does not duplicate them.
 * @property {ReturnType<typeof setTimeout>|null} logTimer
 * @property {boolean} logLive
 * @property {boolean} logFolded
 * @property {string|null} openId - the open document's id.
 * @property {any[]} spec - `/fields`' typed entry-field table (m5g / §9a.26).
 * @property {Record<string, any>} specByName
 * @property {any[]} specGroups
 * @property {Set<any>} setOpen - which rows have their settings fold open, kept so a save does not
 *   close every pane he had just arranged.
 * @property {number} gen - 🔴 THE GENERATION TOKEN. §4's rule — anything that can change which
 *   document is on screen stamps this before its first await and checks it after its last — is
 *   only enforceable because `WB` is module-private and this is reachable through nothing else.
 * @property {Record<string, any>} draftAt
 * @property {number} [draftTotal] - late-created; see the note above.
 * @property {boolean} [onLatest] - late-created. Whether the head revision is the one displayed;
 *   Save is gated on it exactly as Rollback is.
 * @property {Set<any>} [openRows] - late-created.
 * @property {{on: boolean, rect: any}} [pick] - late-created.
 * @property {{hits: any[], at: number}} [find] - late-created.
 */

/**
 * Per-kind state, keyed by the TAB key ('cards'/'books'/'personas').
 *
 * ⚠️ `WB` IS MODULE-PRIVATE AND MUST STAY SO — the header above says why, and the `gen` field is
 * the whole of it.
 * @type {Record<string, WbPaneState>}
 */
const WB = {}; // per-kind state: {doc, rev, fields, pass, es, proposals}
// m5g / §9a.26 — `spec` / `specByName` / `specGroups` are the typed entry-field table the server
// sends with `/fields`; `setOpen` is which rows have their settings fold open, kept so a save does
// not close every pane he had just arranged.
/**
 * @param {string} kind - the tab key, never the document kind (`kind.js`'s header is the whole
 *   argument for why the two must not be conflated).
 * @returns {WbPaneState}
 */
export function wbState(kind) {
  return (
    WB[kind] ||
    (WB[kind] = {
      doc: null,
      rev: null,
      fields: [],
      pass: null,
      es: null,
      seen: new Set(),
      logTimer: null,
      logLive: false,
      logFolded: false,
      openId: null,
      spec: [],
      specByName: {},
      specGroups: [],
      setOpen: new Set(),
      gen: 0,
      draftAt: {},
    })
  );
}

// ── Per-pane generation token ────────────────────────────────────────────────────────────────
// Async work can finish after another document is opened. Capture `wbBump(kind)` before the first
// await and check `wbStale(kind, seq)` before applying results. Use `wbGen(kind)` when an operation
// belongs to the current document but must not start a new generation. Bump on open, close, or
// delete so each pane invalidates only its own stale work.
/** @param {string} kind @returns {number} the pane's current generation. */
export function wbGen(kind) {
  return wbState(kind).gen;
}
/** @param {string} kind @returns {number} the NEW generation, after bumping — call before the first await. */
export function wbBump(kind) {
  return ++wbState(kind).gen;
}
/**
 * @param {string} kind
 * @param {number} seq - a generation captured by `wbGen`/`wbBump` before an await.
 * @returns {boolean} true if a newer `wbBump` has fired since `seq` was taken — the caller's
 *   in-flight work has been overtaken and must not write `st`.
 */
export function wbStale(kind, seq) {
  return wbState(kind).gen !== seq;
}

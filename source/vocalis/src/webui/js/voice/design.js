// voice/design.js — `vc`, the Create-a-voice design state, and nothing else (7.3-m8a).
//
// 🔴 EIGHTEEN LINES, ONE DECLARATION, AND IT IS THE m4o/m4t MOVE AGAIN: a thing several features
// share belongs to none of them, and taking it out FIRST is what makes each feature's own cut one
// clean range. `ui/fav.js` was the ★ pulled out of the middle of the swap library; `ui/audition.js`
// took `wireAudCluster`/`wireClearCache` out of the middle of the Nomi banner. This is the third,
// and the first where the shared thing is STATE rather than a helper.
//
// ⚠️ THE PAGE HAS BEEN SAYING SO SINCE m4d, IN THE COMMENT THIS CUT DELETES: *"`vc` STAYS DECLARED
// HERE and the module reads it through the scope chain, because all three parts share it — it moves
// with the LAST of them, not the first."* The Create tab is three things — the design FORM, the
// candidate QUEUE (js/voice/candidates.js, m4d) and the overnight BATCH (js/voice/batch.js, m4i) —
// and two of them were already modules reading `vc` off the page's scope chain.
//
// 🔴 SO WHY NOT SIMPLY LET IT MOVE WITH THE FORM AT m8? BECAUSE THAT IS A CYCLE. `voices/*` calls
// `loadCandidates`, `vcN`, `vcPoll` and `vcBatchPoll`, so it imports from both of those modules; if
// it also DECLARED `vc`, both of them would have to import it back. ES modules survive that shape
// as long as every use is inside a function — which today it is — but 7.1 §5.8 settled this once:
// **a cycle between two modules is usually a filing error, not a fact.** One file that all three
// import has no cycle in it and needs no argument about evaluation order.
//
// ✅ AND IT IS SAFE ON THE `Object.assign` SHIM, which the page still needs for the four sites the
// design form has left (§11.4's middle row): `vc` is a `const` that is exclusively MUTATED —
// `vc.cands=…`, `vc.sel`, `vc.show`, `vc.busy` — and never rebound, so the shim's one-time copy is
// the same object every reader holds. 🔴 The day anything writes `vc = {…}`, this stops being true
// and the page's four sites start reading a stale object with no error to say so.
//
// ⚠️ WHAT IS NOT HERE: `vcTab`, `vcTabWant`, `vcFilled`, `vcTpls`. They look like siblings and are
// not — those belong to the Voices LIST and the design FORM respectively, each has exactly one
// owner, and each moves with its own feature at m8. `vc` is here because it has three.
// 🔴 THE CANDIDATE LIST IS THE SERVER'S, NOT THIS TAB'S (7.0-m7 §18.5). It used to be `vc.cands`
// and nowhere else: Generate REPLACED it, Discard merely hid a row, and a reload emptied it —
// three separate ways of being the opposite of append-only. `vc.cands` is now a CACHE of GET
// /voices/design/
// candidates, refilled after anything that changes it, and an overnight batch that runs while
// this tab is closed is waiting in it in the morning.
// ── the shapes `vc` holds, off the routes that produce them (DESIGN_8_3 §7) ──────────────────
// candidates.js and batch.js both import `vc` rather than redeclaring these — a JSDoc typedef
// has no runtime existence, so there is nothing to import; they reach the same two shapes as
// `import('./design.js').VcCandidate` / `.VcBatch` at each use site instead.

/** One drawn candidate — `_candidate_list()`'s row, `/voices/design/candidates`. */
/**
 * @typedef {object} VcCandidate
 * @property {string} token
 * @property {number} size
 * @property {number} created
 * @property {number|null} seed
 * @property {number|null} steps
 * @property {number|null} duration_s
 * @property {string} prompt
 * @property {string} sample_text
 * @property {string} url
 */

/** The overnight batch's live state — `VoiceBatch.snapshot()`, `/voices/design/batch`. */
/**
 * @typedef {object} VcBatch
 * @property {string} status   'idle' · 'running' · 'stopping' · 'stopped' · 'done'.
 * @property {number} total
 * @property {number} done
 * @property {number} failed
 * @property {number} remaining
 * @property {string} prompt
 * @property {string} sample_text
 * @property {number} steps
 * @property {number} spent_s
 * @property {number|null} eta_s  Null until a round has actually finished — see the header note.
 * @property {string|null} error
 * @property {string[]} log
 */

/**
 * The Create tab's whole state, shared by its three pieces (the header above explains why one
 * file declares it). `job`/`timer` are the design-form poll; `batch`/`btimer` are the overnight
 * run; `cands`/`sel`/`show`/`page` are the candidate queue.
 */
/**
 * @typedef {object} VcState
 * @property {boolean} busy
 * @property {VcCandidate[]} cands
 * @property {number} total
 * @property {string|null} job     The running Generate job's id.
 * @property {number|null} timer   `vcPoll`'s own `setTimeout` handle.
 * @property {Set<string>} sel     Tokens ticked for the mass-delete.
 * @property {number} show         Rows per page (or `1e9` for "show all").
 * @property {number} page
 * @property {VcBatch|null} batch
 * @property {number|null} btimer  `vcBatchPoll`'s own `setTimeout` handle.
 * @property {string} playing      The token now playing, for play-next-on-end.
 */
/** @type {VcState} */
export const vc = {
  busy: false,
  cands: [],
  total: 0,
  job: null,
  timer: null,
  sel: new Set(), // tokens ticked for the mass-delete
  show: 50,
  page: 0, // current page, zero-based
  batch: null,
  btimer: null,
  playing: '',
}; // the token currently playing

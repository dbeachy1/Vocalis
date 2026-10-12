// util/appstate.js — `state`, the one object the whole front end shares (7.3-m12d).
//
// Six lines out of index.html, and the last piece of shared state in the page. It holds what a
// RENDER is doing right now — the live job's id and EventSource, whether one is running, the
// chapters parsed out of the current book, the Playground's parallel set of the same, and the map
// of in-flight enhance jobs.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 A FILE OF ITS OWN, WITH NO IMPORTS — the m8a/m2b/m9a/m6e/m12c pattern for the SIXTH time, and
// the one instance where the pattern is not a judgment call but arithmetic. **Ten modules read
// `state`** (book/books, book/job, book/library, book/parse, media/stemwidget, pg/playground,
// sys/devices, sys/enhance, sys/hwstrip, ui/audition, voice/training, voices/voices), and they
// import from each other in most directions already. Putting this declaration in any one of them
// makes that module a dependency of the other eleven, and it is a leaf in none of those graphs —
// `book/job.js` alone imports from seven files. A dependency-free holder has no cycle to have.
//
// 📌 It is also what the earlier instances were rehearsing. `st/tabstate.js` (m2b) was split out
// because four modules read one `let` and the router imported from all four; `media/swapstate.js`
// (m9a) because stemwidget and swaplib read `vs` while voiceswap imports ten names from them;
// `pg/pgstate.js` (m6e) because book/job.js assigns `pgStart`. Same shape each time, growing.
//
// ⚠️ EXPORTED AS A `const` THAT IS ONLY EVER MUTATED, which is what makes it legal on index.html's
// `Object.assign` shim until m13 deletes it (§11.4's middle row — the `scLib`/`vcBin`/`FILT` case).
// 🔴 **NEVER REASSIGN IT.** `state = {...}` anywhere would give that module a fresh object while
// every other reader keeps the old one, silently, and the shim's one-time copy would freeze
// besides. Mutate fields; if a wholesale reset is ever wanted, write a `resetState()` here that
// mutates in place.
//
// ⚠️ `pgStream` HOLDS A LIVE `VocalisStreamPlayer` HANDLE, not data — so this object is not
// serializable and must never be sent anywhere. It is scratch space for the running page.

// 🔴 THE SHAPE IS DECLARED IN `types/vocalis.d.ts`, NOT INFERRED HERE, AND SEVEN OF ITS FIELDS ARE
// NOT IN THIS INITIALIZER. `books`, `bookLive`, `chapsDone`, `eta`, `vlist`, `pgResume` and
// `pgLibClip` are created by their first writer, so inference would type this object without them
// and every read would be an error while every *typo* stayed silent. `AppState` lists all twenty.
/** @type {AppState} */
export const state = {
  gpus: [],
  jobId: null,
  es: null,
  running: false,
  chapters: [],
  curBook: null,
  bookChars: 0,
  pgJobId: null,
  pgEs: null,
  pgRunning: false,
  pgStream: null,
  pgAudioS: 0,
  // ref → {jid,name}. A MAP, not one job id: an enhancement takes ONE card, so on a
  // two-card box two of them run side by side (4.1-M16). The row that started each one is
  // where it lives — its ■ cancels that job and nothing else.
  pgEnh: new Map(),
}; // pgStream = live VocalisStreamPlayer handle

// ── which of this box's cards may run a given subsystem (8.0-m4c) ───────────────────────────
// 🔴 THREE PICKERS OFFERED CARDS THEIR OWN ROUTE WOULD REFUSE. 7.6 gated the servers — Voice
// Training, Voice Swap, Stems, Create-a-voice, ACE-Step — and left every dropdown building
// itself from the raw `/gpus` registry. Voice Training was the one that bit, because its picker
// auto-selects the HIGHEST FREE card: on a box with only cuda:0 ticked for training it silently
// selected cuda:1, and Start failed with "cuda:1 is not allowed… Allowed right now: cuda:0" —
// naming a card the user had never chosen.
//
// 🔴 ONE FILTER, NOT THREE. Each picker re-deriving this is how they drift apart from each
// other and from the routes they feed; `/gpus` now publishes `allows` per card, computed by the
// SAME `enabled AND authorized(...)` the routes enforce (runtime/pool.local_card_permissions).
// This reads that map and nothing else — it must never re-implement the predicate.
//
// ⚠️ AN ABSENT `allows` MEANS ALLOWED, deliberately: a page held open across an upgrade has
// pre-8.0 rows cached in `state.gpus`, and hiding every card because the key is missing would
// take the feature away rather than filter it. Matches `subsystems.authorized()` server-side.
// ⚠️ It answers about CARDS, never satellites — same scope as `local_cuda_devices()`.
/**
 * @param {string} sub — the subsystem key, as `pool.local_card_permissions()` names it
 *   (`'train'`, `'swap'`, `'stems'`, `'voxcpm'`, `'acestep'`).
 * @returns {GpuCard[]}
 */
export function cardsFor(sub) {
  return (state.gpus || []).filter(g => !g.allows || g.allows[sub] !== false);
}

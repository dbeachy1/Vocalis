// The four JSON helpers every `wb` module needs. 7.1 §5.6 — module 3.
//
// 🔴 THESE ARE DELIBERATE DUPLICATES OF THE FOUR STILL DEFINED INSIDE index.html, EXACTLY AS
// `js/util/dom.js` DUPLICATES `$` AND `esc`. Both copies have to exist until the inline script is
// gone. See DESIGN_7_1_FRONTEND_REFACTOR.md §5.6.
//
// ⚠️ AND THE OBVIOUS CHECK SAYS OTHERWISE, WHICH IS WHY §5.6 EXISTS. A grep for a top-level
// statement calling `jget` finds nothing, so these look free to move. They are not: the inline
// script ends with a bootstrap IIFE that runs immediately —
//
//     (async()=>{ await loadGpus(); loadDevices(); await loadVoices(); … })()
//
// — and `loadGpus` is, in its entirety, `state.gpus = await jget('/gpus')`. `async` does not save
// you: the body runs synchronously up to its first `await`, and that call IS it. So `jget` is
// invoked while the page is still parsing, and a `type="module"` script is DEFERRED — it has not
// run yet. Move these and the page dies at load with `jget is not a function`, before anything is
// wired. The correct eligibility test is TRANSITIVE, not a grep for direct callers.
//
// ⚠️ THE REMOVAL CONDITION IS SINGULAR AND IT IS THE INLINE COPY THAT GOES: delete the four
// `async function j*` definitions from index.html when the last inline caller becomes a module,
// and this file becomes the only definition. Deleting THIS one instead, to "remove the
// duplication", breaks every module that imports it.
//
// 🔴 THE ERROR SHAPE BELOW IS NOT INCIDENTAL, AND DRIFT IN IT IS A REAL BUG. `e.status`, `e.body`,
// and preferring `message` over `error` are each there because a specific wrong string reached
// the KoboldCpp tab: it branched on `e.body.error` to render a real sentence, but `e.body` was
// always undefined, and every branch fell through to `e.message`, which is the machine-readable
// CODE. A route that carefully returns both a code to branch on and a sentence to read is worth
// nothing if the sentence is dropped in transit. `test_webui_modules.py` pins the two copies
// together for that reason.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE RETURN IS `Promise<any>`, AND THAT IS A BOUNDARY RATHER THAN A SHRUG (8.3-m2).
// These four are the only door between ~130 Flask routes and the front end, and each route
// answers with its own shape. The honest declaration is `Promise<unknown>`, which is an error at
// every one of the ~500 call sites that reads a field off the result (`r.job_id`, `s.status`) —
// a diff this milestone explicitly refused to take.
//
// ⚠️ THE EXIT IS PER-ROUTE RETURN TYPES, NOT A CLEVERER SIGNATURE HERE. `jget('/gpus')` can
// return `Promise<GpuCard[]>` the day `/gpus`'s shape is declared, one route at a time, without
// touching this file: a caller writes `/** @type {GpuCard[]} */ (await jget('/gpus'))` today and
// an overload takes over later. `types/vocalis.d.ts` already holds four of those shapes.
// 📌 What IS checked here and matters: the error path. `HttpError` is a real, pinned type, which
// is the half of this contract that has actually bitten (see the KoboldCpp incident above).

import { CSRF } from './uistate.js';
import { reopenIfLocked } from './suk.js';

/**
 * `fetch`, plus one retry when a restart locked the vault under this tab (see util/suk.js): a
 * locked-vault 401 redeems the tab's Session Unlock Key and repeats the request once. Any other
 * response — including a 401 that could not be recovered — is returned unchanged, so callers keep
 * their own 401 handling. `init` is reused for the retry; FormData and string bodies resend as-is.
 * @param {string} u
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchUnlocked(u, init) {
  const r = await fetch(u, init);
  if (r.status === 401 && (await reopenIfLocked(r))) return fetch(u, init);
  return r;
}

/** Narrow an unknown caught value to `HttpError` only when the HTTP status and body are present.
 * @param {unknown} e
 * @returns {e is HttpError}
 */
export function isHttpError(e) {
  return e instanceof Error && typeof (/** @type {ErrLike} */ (e).status) === 'number';
}

/** Return a readable sentence for any thrown value. This helper does not branch by status; use `isHttpError` when the caller needs status-specific behavior.
 * @param {unknown} e
 * @returns {string}
 */
export function errText(e) {
  const m = /** @type {ErrLike} */ (e) && /** @type {ErrLike} */ (e).message;
  return typeof m === 'string' && m ? m : 'the request failed';
}

/**
 * GET, parsed as JSON.
 *
 * ⚠️ A 401 NEVER RESOLVES AND NEVER THROWS. It navigates to `/login` and returns a promise that
 * stays pending forever, deliberately: the page is being replaced, so a caller's `catch` firing
 * would paint an error into a document that is on its way out.
 *
 * @param {string} u
 * @returns {Promise<any>} — see the boundary note above.
 * @throws {HttpError} on any other non-2xx: `.status` is the code, `.body` the parsed envelope.
 */
export async function jget(u) {
  const r = await fetchUnlocked(u);
  if (r.status === 401) {
    location.href = '/login';
    return new Promise(() => {});
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = /** @type {HttpError} */ (new Error(j.message || j.error || r.statusText));
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return r.json();
}
/**
 * POST a JSON body. Same 401 and error contract as `jget`.
 * @param {string} u
 * @param {unknown} [b] - omitted or nullish sends `{}`.
 * @returns {Promise<any>}
 * @throws {HttpError}
 */
export async function jpost(u, b) {
  const r = await fetchUnlocked(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b || {}),
  });
  if (r.status === 401) {
    location.href = '/login';
    return new Promise(() => {});
  }
  // PREFER `message`. The routes that carry a machine-readable `error` code put the human
  // sentence in `message`, and this line used to throw the CODE — so any caller that fell
  // through to e.message showed users "kobold_loaded" instead of a sentence. Same bug m2
  // fixed in jget's e.body; same fix. Routes whose `error` IS the sentence still read right.
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = /** @type {HttpError} */ (new Error(j.message || j.error || r.statusText));
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}
// Same shape as jpost.
/**
 * @param {string} u
 * @param {unknown} [b] - omitted or nullish sends `{}`.
 * @returns {Promise<any>}
 * @throws {HttpError}
 */
export async function jput(u, b) {
  const r = await fetchUnlocked(u, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
    body: JSON.stringify(b || {}),
  });
  if (r.status === 401) {
    location.href = '/login';
    return new Promise(() => {});
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = /** @type {HttpError} */ (new Error(j.message || j.error || r.statusText));
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}
// Same shape again (5.3-m2).
// 7.5.13: an OPTIONAL body. DELETE with a payload is legal and is what /train/weights needs —
// it names WHICH checkpoints to prune, and putting a list of epochs in the URL would be worse.
// ⚠️ Omitting it sends no body and no Content-Type, so the existing one-arg callers are byte
// -identical on the wire; a bare `{}` body would make some routes' get_json see an empty dict
// where they currently see None.
/**
 * @param {string} u
 * @param {unknown} [b] - 🔴 OMITTED IS NOT THE SAME AS `{}`. Omitting sends no body and no
 *   Content-Type, which is what keeps the one-arg callers byte-identical on the wire; a bare `{}`
 *   would make some routes' `get_json` see an empty dict where they currently see `None`. So the
 *   test below is `b === undefined`, never falsiness.
 * @returns {Promise<any>}
 * @throws {HttpError}
 */
export async function jdel(u, b) {
  const r = await fetchUnlocked(
    u,
    b === undefined
      ? { method: 'DELETE', headers: { 'X-CSRF-Token': CSRF } }
      : {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
          body: JSON.stringify(b),
        },
  );
  if (r.status === 401) {
    location.href = '/login';
    return new Promise(() => {});
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = /** @type {HttpError} */ (new Error(j.message || j.error || r.statusText));
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}

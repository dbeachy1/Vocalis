// sys/modelstate.js — `MODELS` and `ENCRYPTED`, the two things the /health poll writes and four
// modules read (7.3-m12d).
//
// Two lines out of index.html, and they are the last of §11.4's "the shim cannot carry this"
// family. Dependency-free, for the `util/appstate.js` reason: `sys/model.js` writes both,
// `sys/login.js` and `voices/voices.js` read them, and model.js already imports from four files.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WHY THESE COULD NOT MOVE BEFORE, AND WHY THAT REASON ENDS HERE. index.html's shim said:
//
//   "A MODULE GOES IN THIS LIST ONLY IF NOTHING IT EXPORTS IS EVER REASSIGNED. Object.assign
//    copies the VALUE once … That is why js/sys/model.js publishes only its two functions and
//    leaves MODELS/ENCRYPTED declared inline."
//
// That is exactly right about the SHIM and says nothing about modules. **A module-to-module
// `import { ENCRYPTED }` is a LIVE BINDING**: readers see every reassignment the exporting module
// makes, immediately, by specification. The `Object.assign` shim is the only path that flattens a
// binding into a one-time copy — so the moment every reader is a module, the constraint is gone.
// m12d is that moment: `sys/model.js`, `sys/login.js` and `voices/voices.js` are all modules, and
// nothing inline reads either name.
//
// 📌 So this file is NOT on the shim, and putting it there would reintroduce the exact bug the
// note above describes: `window.ENCRYPTED` would freeze at `false`, and a stale copy of it
// **disarms both vault guards in `applyLogin`** — the reason that note is in capitals.
//
// ⚠️ WRITERS CALL THE SETTERS. You cannot assign to an imported binding (it is a SyntaxError in
// strict mode, and a module is always strict), so the /health poller uses `setModels`/`setEncrypted`
// and every reader uses the plain import. That asymmetry is the whole API: **one writer, named;
// many readers, live.** It is the `xNow()`/`xSet()` pair from m4m/m2b/m6e with the read half
// upgraded from an accessor to a real binding, which is possible here and was not there — those
// were reached THROUGH the shim by inline callers, and this one never will be.

/**
 * `MODELS.foreign` — per-model count of engines running OUTSIDE Vocalis (4.8-m4h), from
 * `runtime/procs.foreign_engines()`. Both keys are optional: `{}` on an old server or a box with
 * no `/proc` to read, which the header reads as "nothing to say" rather than "none running".
 * @typedef {object} ForeignCounts
 * @property {number} [chatterbox]
 * @property {number} [voxcpm]
 */
/** One model's state, as `pollReady` derives it from `/health`. @typedef {'ready'|'loading'|'unloaded'} ModelStatus */
/**
 * @typedef {object} ModelsState
 * @property {ModelStatus} cb
 * @property {ModelStatus} vox
 * @property {boolean} voxAvail  Is the VoxCPM2 venv even installed on this box.
 * @property {ForeignCounts} foreign
 */
/** Which model families are loaded, and whether VoxCPM2 is even installed. Replaced wholesale by
 *  each /health response, which is why it is a `let` and why the shim could never carry it. */
/** @type {ModelsState} */
export let MODELS = { cb: 'unloaded', vox: 'unloaded', voxAvail: false, foreign: {} };
/** A vault exists and is initialized — so the login password is also the vault key. Set by the
 *  /health poll; read by `applyLogin`, where a stale `false` would skip the re-wrap of the vault
 *  DEK and the recovery-key warning both. */
export let ENCRYPTED = false;

/** @param {ModelsState} v */
export function setModels(v) {
  MODELS = v;
}
/** @param {unknown} v */
export function setEncrypted(v) {
  ENCRYPTED = !!v;
}

/** This server is the Docker package (`paths.docker_encrypted_mode()`), as /health reports it in
 *  its `docker` field — the ONE flag the page has for "the user is in a container, so a host path
 *  or a source-install command in a text would be a lie" (release audit, 2026-10-11). `false`
 *  until the first /health answer, and in a developer's non-Docker run. Written only by
 *  `pollReady` through `setDocker`, which also mirrors it onto `<html data-docker="1|0">` so the
 *  static partials can switch text with the `.docker-only` / `.plain-only` classes. */
export let DOCKER = false;

/** @param {unknown} v */
export function setDocker(v) {
  DOCKER = !!v;
}

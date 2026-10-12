// sys/model.js — the header strip's brain: the Session Unlock Key, the model buttons, the
// /health poll, and ComfyUI. Moved verbatim from the `5.0-M5b: the browser half of the Session
// Unlock Key` banner in index.html; that banner and every comment under it are kept below,
// unedited, because the reasons written into them are the reasons the code looks like this.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THESE MOVED AS ONE GROUP.
//
// One route in, one strip of buttons out. Every function in this file is driven by a single
// endpoint — `/health`, polled forever by `pollReady` — and every function in it writes a
// single region of the page: the button row across the top (`#ready`, `#cbBtn`, `#voxBtn`,
// `#freeBtn`, `#comfyBtn`, plus `#edition` and `#logoutBtn`).
//
// The Session Unlock Key is in this group and not in a security file of its own for a
// mechanical reason, not a filing one: **`/health` is the only route that answers while the
// vault is locked**, so the poll that reports whether a model is loaded is also the only thing
// on the page that can notice a restart and POST the key back. `redeemSuk` is a branch of
// `pollReady`, not a neighbor of it. Splitting it out would put a second poller on the same
// route for the sake of a directory name.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 `MODELS` AND `ENCRYPTED` ARE EXPORTED, AND `Object.assign(window, mod)` CANNOT PUBLISH
// THEM. READ THIS BEFORE ADDING THIS MODULE TO THE SHIM.
//
// Both are `let` bindings that `pollReady` REASSIGNS on every poll, and both are read by code
// that is still inline:
//
//     ENCRYPTED   index.html, in `applyLogin` — two guards on an encrypted install
//     MODELS      index.html, in `vcSyncModel` — `MODELS.voxAvail` / `MODELS.vox`
//
// `Object.assign` copies a VALUE, once, when the shim runs. An ES module export is a live
// binding for an `import`, but a snapshot for `Object.assign`. So `window.ENCRYPTED` would be
// pinned at `false` and `window.MODELS` pinned at the unloaded seed, forever, no matter what
// `/health` says. That is not a cosmetic drift:
//
//   * a permanently-false `ENCRYPTED` disarms BOTH vault guards in `applyLogin` — the one that
//     demands the current password so the server can re-wrap the DEK, and the one that refuses
//     to remove the login on an encrypted install ("a vault with no login can never be
//     unlocked"). The UI is where those two are enforced.
//   * a permanently-unloaded `MODELS` makes `vcSyncModel` hide the Create-a-voice tab forever.
//
// ⚠️ This is the exact inverse of `util/filter.js`'s `FILT` note. `FILT` survived the shim
// because it is only ever MUTATED; these two are only ever REPLACED.
//
// ✅ THE FIX IS TWO LINES AND IT DOES NOT NEED THE SHIM. Leave `let ENCRYPTED=false;` and
// `let MODELS={…};` where they are, in the classic script, and DELETE those two declarations
// from this file. A top-level `let` in a classic script lives in the global LEXICAL environment,
// not on `window`, and a module body reads AND WRITES it through its own scope chain — the same
// mechanism `js/main.js` already relies on for `stTab`. Nothing here needs to change but the two
// declarations, and the inline readers keep seeing live values in both directions. When
// `sys/login.js` (m4) and `voices/create.js` (m8) land, the two `let`s come here for real and
// their readers `import` them.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 `pollReady` MUST STAY PUBLISHED ON `window` UNTIL m12. `js/main.js` calls it by bare name
// (`startIdleVram();pollReady();pollComfy();`), and it has two more inline callers — `applyLogin`'s
// save and the Create panel's Load button. Drop it from the shim and the page boots with no health
// poll at all, silently: nothing throws, the version string just never appears and the model
// buttons never unhide.
//
// ✅ THE COMFYUI HALF LEFT IN 7.3-m4 → `js/sys/comfy.js`. The note that used to sit here called
// the cut exactly — no shared state, timer or helper, and not one call in either direction — and
// it was re-checked and still true. `pollComfy` went with it and is no longer this file's export.
// ⚠️ It is not on the shim either: main.js is its only caller and imports it directly.
//
// ⚠️ ONE NAME IS STILL AN INLINE GLOBAL AND IS DELIBERATELY NOT IMPORTED — there is no module to
// import it from yet, and duplicating it would fork live state:
//
//     vcSyncModel   Create-a-voice (index.html) → `voices/create.js`, m8.
//                   One call site, the first line of `setModelUI`.
//
// It resolves on the global scope at call time, which always works from a module (§3.1). Turn it
// into a real `import` on the commit that lands its module.
//
// ✅ `pollVram` WAS THE OTHER ONE, AND IT IS A REAL IMPORT NOW. This header used to file it as
// "no module to import it from yet" — true when written, stale since 7.3-m3b landed
// `js/sys/hwstrip.js`. The instruction it carried was "turn each into a real import on the commit
// that lands its module"; that commit was m3b and this is the one that finally does it.
// ⚠️ Import the FUNCTION, never a copy of the state. `pollVram` reads `vramBusy` and `vramTimer`,
// which are hwstrip's module-private state; a second copy would poll twice and fight over them.

import { $, esc } from '../util/dom.js';
import { jget, jpost } from '../util/http.js';
import { redeemSuk } from '../util/suk.js';
import { modal } from '../ui/modal.js';
import { pollVram } from './hwstrip.js';
// ✅ 7.3-m12d. Both were declared in index.html since m3d, because the shim copies a value once and
// these are the two names `pollReady` REASSIGNS every poll. A module-to-module import is a LIVE
// binding, so once every reader was a module (this file, sys/login.js, voices/voices.js) the
// constraint ended — see modelstate.js's header. ⚠️ WRITE THROUGH THE SETTERS: assigning to an
// imported binding is a SyntaxError, and the two writes below are the only ones in the tree.
import { MODELS, ENCRYPTED, DOCKER, setModels, setEncrypted, setDocker } from './modelstate.js';
// `setModelUI` runs on each /health poll. This cycle is safe because the imported binding is read
// inside a function body, not during module evaluation.
import { vcSyncModelFire } from '../voices/vcstate.js'; // 7.5.6 — the leaf, not voices.js

/** @typedef {import('./modelstate.js').ModelStatus} ModelStatus */
/** Which button — the whole key set `MODEL_BTN` and `MODELS.foreign` both index on. */
/** @typedef {'chatterbox'|'voxcpm'} ModelKey */

// ── 5.0-M5b: the browser half of the Session Unlock Key (design §5.4) ────────
//
// AUTHENTICATED AND UNLOCKED ARE TWO DIFFERENT THINGS, and only one of them survives a restart.
// The login cookie can outlive the in-memory DEK. Without reusing the SUK, freeing VRAM would leave
// the browser authenticated but unable to access encrypted data until the user signs in again.
//
// The still-open tab is the thing that can fix it, because it is the only place the SUK exists.
// /health is open even while locked (that is deliberate, and this is what it is for): it reports
// `locked`, the tab sees it, and POSTs the SUK back.
//
// The SUK is single-use — /vault/unlock-suk mints a FRESH one and returns it — so a replayed key
// is a dead key. Store the new one or we can only do this once.
// The redemption itself lives in util/suk.js, shared with the 401 path in util/http.js so the
// single-use key is never spent twice by two racing callers. /health is no longer the ONLY
// trigger: a locked-vault 401 on any request redeems too (util/http.js `fetchUnlocked`).

// 4.8-m1: per-model state. cb/vox ∈ ready|loading|unloaded; voxAvail gates the VoxCPM2
// button — a box without the VoxCPM2 venv simply doesn't get one.
//
// 🔴 DECLARED IN index.html, NOT HERE, AND THAT IS LOAD-BEARING (7.3-m3). pollReady REPLACES
// this object on every poll. `Object.assign(window, mod)` copies a value ONCE at module load —
// it is not a live binding — so exporting it would pin window.MODELS at the unloaded seed
// forever and inline vcSyncModel would hide the Create-a-voice tab for the rest of the session.
// A top-level `let` in a classic script lives in the global LEXICAL environment, so this module
// reads and writes the real one through its own scope chain and every reader sees one value.
// It comes across for real when voices/create.js (m8) lands and its readers import it.
// An engine running outside Vocalis leaves Vocalis's own state unchanged, but the status line
// must not imply the card is free. The
// button still acts on it — what changes is that the status line stops implying the CARD is
// free. A ◍ says "not mine, but something of this shape is running"; the tooltip says how
// many and what to do, because Vocalis cannot unload what it did not start.
/** @param {number} n @param {string} name */
const FOREIGN_NOTE = (n, name) =>
  `${n} ${name} process${n > 1 ? 'es' : ''} running outside Vocalis — ` +
  `holding VRAM that Vocalis can neither use nor free. Stop it where you started it; ` +
  `Vocalis can only unload what it started itself.`;
// 4.8-m4e: one button per model. Each carries its own copy for both directions, because the
// two models free VRAM by different means and the tooltip is where that difference lives:
// Chatterbox drops replicas inside this process (the ROCm runtime survives), VoxCPM2 is a
// subprocess whose death frees everything it held.
const MODEL_BTN = {
  chatterbox: {
    id: 'cbBtn',
    name: 'Chatterbox',
    load: 'Load Chatterbox into VRAM (~15 s)',
    unload:
      'Drop the Chatterbox replicas and free their VRAM (the ~1.5 GB ROCm runtime stays — use Free Vocalis VRAM for every GB). Rendering auto-reloads it.',
  },
  voxcpm: {
    id: 'voxBtn',
    name: 'VoxCPM2',
    load: 'Start the VoxCPM2 voice-design worker on the emptiest card (~7 GB)',
    unload: 'End the VoxCPM2 worker — its process death frees everything it holds on its card.',
  },
};
// The button reads its OWN model's state (the 4.7 lesson: a button that says Load while its
// model is loaded is lying) — which is now the whole reason there is no select to get wrong.
/** @param {ModelKey} which @param {ModelStatus} st */
function setModelBtn(which, st) {
  const m = MODEL_BTN[which],
    b = /** @type {HTMLButtonElement} */ ($(m.id));
  if (st === 'loading') {
    b.disabled = true;
    b.className = 'sm';
    b.textContent = 'Loading ' + m.name + '…';
    b.removeAttribute('data-act');
    b.title = '';
    return;
  }
  b.disabled = false;
  if (st === 'ready') {
    b.className = 'sm vram';
    b.textContent = '⏏ Unload ' + m.name;
    b.dataset.act = 'unload';
    b.title = m.unload;
  } else {
    b.className = 'sm primary';
    b.textContent = '⬇ Load ' + m.name;
    b.dataset.act = 'load';
    b.title = m.load;
  }
}
function setModelUI() {
  const el = /** @type {VEl} */ ($('ready'));
  vcSyncModelFire(); // keep the Create-a-voice panel's model state live off the same poll
  /** @type {VEl} */ ($('cbBtn')).style.display = '';
  setModelBtn('chatterbox', MODELS.cb);
  /** @type {VEl} */ ($('voxBtn')).style.display = MODELS.voxAvail ? '' : 'none';
  if (MODELS.voxAvail) setModelBtn('voxcpm', MODELS.vox);
  // A foreign process only changes the dot when OUR state is 'unloaded'. Loaded or loading
  // already says the card is busy, and stacking two claims on one segment says neither well.
  /** @param {ModelStatus} st @param {string} name @param {number|undefined} fn */
  const seg = (st, name, fn) => {
    if (st === 'ready') return `● ${name}`;
    if (st === 'loading') return `<span class="spin"></span>${name}…`;
    return (fn ?? 0) > 0
      ? `<span class="ext" title="${esc(FOREIGN_NOTE(/** @type {number} */ (fn), name))}">◍ ${name}</span>`
      : `○ ${name}`;
  };
  const fg = MODELS.foreign || {};
  el.innerHTML = seg(MODELS.cb, 'Chatterbox', fg.chatterbox) + (MODELS.voxAvail ? ' · ' + seg(MODELS.vox, 'VoxCPM2', fg.voxcpm) : '');
  el.classList.toggle('on', MODELS.cb === 'ready' || (MODELS.voxAvail && MODELS.vox === 'ready'));
  // Free Vocalis VRAM stays offered even with nothing loaded — the ROCm runtime it frees
  // outlives an unload, so "nothing loaded" is exactly when it still has ~1.5 GB to give
  // back. It is only withheld mid-load, where bouncing the process would kill the load.
  const f = /** @type {HTMLButtonElement} */ ($('freeBtn'));
  f.style.display = '';
  f.disabled = MODELS.cb === 'loading' || MODELS.vox === 'loading';
  f.title = f.disabled
    ? 'Wait for the load to finish'
    : 'Restart the Vocalis engine to free ALL VRAM (incl. the ~1.5 GB ROCm runtime). The web UI stays up; Chatterbox reloads on demand (~15 s), VoxCPM2 stays unloaded until you Load it.';
}
// 🔴 ENCRYPTED IS DECLARED IN index.html TOO, AND FOR THE SHARPEST REASON IN THIS FILE.
// pollReady REASSIGNS it every poll (`ENCRYPTED=!!h.initialized`). Published through the shim it
// would be a one-time copy of `false`, and inline applyLogin reads it to enforce BOTH vault
// guards — the one demanding the current password so the server can re-wrap the DEK, and the one
// refusing to remove the login on an encrypted install ("a vault with no login can never be
// unlocked"). Both would stop firing, silently, on an install where they are the whole point.
// Same mechanism as MODELS above; it moves for real with sys/login.js (m4).
/** The texts that live in ATTRIBUTES (placeholders, tooltips), which the `.docker-only` /
 * `.plain-only` classes cannot switch (release audit 2026-10-11). Called from `pollReady` once the
 * Docker flag is known; harmless to call again. Exported for the specs.
 *  - `127.0.0.1` in the Docker package is the container itself, so the address examples there name
 *    the host instead (item 8).
 *  - The Voices refresh tooltip promised that audio dropped into the voice folder is picked up; in
 *    the encrypted edition a plain file in a vault folder is skipped (vault.py), so it says so (item 5). */
export function applyDockerAttributes() {
  const set = (/** @type {string} */ id, /** @type {string} */ attr, /** @type {string} */ docker, /** @type {string} */ plain) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute(attr, DOCKER ? docker : plain);
  };
  set('kobUrl', 'placeholder', 'http://host.docker.internal:5001', 'https://127.0.0.1:5001');
  set('llaUrl', 'placeholder', 'http://host.docker.internal:8080', 'http://127.0.0.1:8080');
  set(
    'vRefresh',
    'title',
    'Reload the voice list — shows any voices added, removed or renamed since the page loaded (for example from another browser tab). A file copied into the voice folder by hand is not picked up here; add voices with Upload.',
    'Refresh all files in the voice_samples folder — rescans and picks up any audio (WAV, MP3, FLAC…) added or removed since the page loaded.',
  );
}

export async function pollReady() {
  try {
    const h = await jget('/health');
    /** @type {VEl} */ ($('ver')).textContent = 'v' + h.version + ' — Studio';
    // One password, two uses: with a vault the Admin login panel needs the current password (the
    // server re-wraps the DEK with it) and must not offer to remove the login at all.
    setEncrypted(h.initialized);
    // The Docker flag rides the same payload; the attribute is what switches the static partials'
    // `.docker-only` / `.plain-only` text (css/base.css). Both stay hidden until this first answer.
    setDocker(h.docker);
    document.documentElement.dataset.docker = DOCKER ? '1' : '0';
    applyDockerAttributes();
    /** @type {VEl} */ ($('edition')).hidden = !ENCRYPTED; // the brand's second line — see the .edition CSS note
    {
      const n = $('loginVaultNote'),
        w = $('setCurWrap'),
        rp = $('recoveryPanel');
      if (n) n.style.display = ENCRYPTED ? '' : 'none';
      if (w) w.style.display = ENCRYPTED ? '' : 'none';
      // No vault ⇒ no wrap_recovery to rotate, and the route 409s. Hide it rather than offer it.
      if (rp) rp.style.display = ENCRYPTED ? '' : 'none';
      /** @type {HTMLInputElement} */ ($('setP')).placeholder = ENCRYPTED
        ? 'required — also re-wraps your vault key'
        : 'blank = remove the login';
    }
    {
      const lb = /** @type {VEl} */ ($('logoutBtn'));
      lb.style.display = h.auth ? '' : 'none';
      // Log out means LOCK (the server zeroes the DEK and revokes the wrap), so the SUK we are
      // holding is about to be worthless. Drop it here rather than leaving a dead key in the tab.
      lb.onclick = () => {
        sessionStorage.removeItem('vocalis-suk');
        location.href = '/logout';
      };
    }
    if (h.locked) redeemSuk(); // a restart happened — re-unlock silently, no prompt, no retyping
    const vx = h.voxcpm || {};
    setModels({
      cb: h.model_ready ? 'ready' : h.model_loading ? 'loading' : 'unloaded',
      vox: vx.ready ? 'ready' : vx.loading ? 'loading' : 'unloaded',
      voxAvail: !!vx.available,
      foreign: h.foreign || {},
    }); // {} from an old server or a box with no /proc — no ◍, no claim
    setModelUI();
    const busy = h.model_loading || vx.loading;
    if (busy) pollVram(); // watch VRAM climb live during a model load
    setTimeout(pollReady, busy ? 1200 : 3000);
  } catch (e) {
    setTimeout(pollReady, 2500);
  }
}
// One handler for both model buttons — `which` is now the button's identity, not a select's
// value. A pre-4.8 server just ignores the extra key, so 'chatterbox' stays the old contract.
/** @param {ModelKey} which */
async function modelAct(which) {
  const b = /** @type {HTMLButtonElement} */ ($(MODEL_BTN[which].id)),
    act = b.dataset.act;
  if (!act) return;
  b.disabled = true;
  try {
    await jpost(act === 'unload' ? '/model/unload' : '/model/load', { which });
  } catch (e) {
    await modal(act === 'unload' ? 'Unload failed' : 'Load failed', esc(/** @type {ErrLike} */ (e).message), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  }
  pollReady();
  pollVram();
  setTimeout(pollVram, 1500);
  setTimeout(pollVram, 3000); // AMD VRAM sensor lags ~1-2s behind an actual free — re-poll so the graph shows the settled floor
}
/** @type {VEl} */ ($('cbBtn')).onclick = () => modelAct('chatterbox');
/** @type {VEl} */ ($('voxBtn')).onclick = () => modelAct('voxcpm');
/** @type {VEl} */ ($('freeBtn')).onclick = async () => {
  const b = /** @type {HTMLButtonElement} */ ($('freeBtn'));
  if (
    !(await modal(
      'Free Vocalis VRAM?',
      'Restart the Vocalis engine to release <b>every</b> GB — including the ~1.5 GB of ROCm runtime that an unload cannot free. The web UI stays up; the model reloads on demand (~15 s).',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Free Vocalis VRAM', class: 'primary', value: 1 },
      ],
    ))
  )
    return;
  b.disabled = true;
  try {
    await jpost('/engine/restart', {});
  } catch (e) {
    b.disabled = false;
    if (/** @type {ErrLike} */ (e).status === 409) {
      // a render is running — offer to force it (renders resume from saved chunks)
      if (
        !(await modal(
          '⚠ A render is in progress',
          'A book render is currently running. Shutting down now will stop it — but it <b>resumes from where it left off</b> the next time you render. Force shutdown and restart anyway?',
          [
            { label: 'Cancel', value: 0 },
            { label: 'Force shutdown + restart', class: 'danger', value: 1 },
          ],
        ))
      )
        return;
      b.disabled = true;
      try {
        await jpost('/engine/restart', { force: true });
      } catch (e2) {
        await modal('Cannot free VRAM', esc(/** @type {ErrLike} */ (e2).message || 'restart failed'), [
          { label: 'OK', class: 'primary', value: 1 },
        ]);
        b.disabled = false;
        return;
      }
    } else {
      await modal('Cannot free VRAM', esc(/** @type {ErrLike} */ (e).message || 'restart failed'), [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
      return;
    }
  }
  /** @type {VEl} */ ($('ready')).textContent = '○ restarting…';
  /** @type {VEl} */ ($('ready')).classList.remove('on');
  setTimeout(pollReady, 2500);
  setTimeout(pollVram, 3500); // the process bounces (~2s); pollReady/pollVram retry through the outage until it's back cold
};

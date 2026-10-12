// trayslot.js — the preview player in a tray, and the one guard that keeps it playing (7.5.12).
//
// 🔴 THE GUARD IS THE WHOLE MODULE. Assigning `<audio>.src` RELOADS the element even when you
// assign the identical URL — the browser tears down the media resource and starts over at 0. Every
// tray re-renders for reasons that have nothing to do with which clip is loaded (a list refresh, a
// filter keystroke, a star toggled, a poll landing), so an unguarded `el.src = u` inside a render
// function means the preview you are listening to restarts a second in, over and over, and the
// cause is nowhere near the sound.
//
// So the src is only reassigned when the REF changes, and the ref is remembered on the element
// itself — `dataset.ref` — rather than in any feature's state, because the element is the thing
// that either is or is not already playing that clip.
//
// 📌 FOUR CALLERS IN THREE FEATURES, WHICH IS WHY IT LIVES IN ui/ (the m4o shape — a helper every
// feature calls belongs to none of them):
//
//     media/voiceswap.js   #vsTrayAudio, twice — the speech branch and the song branch
//     media/voiceswap.js   #ssTrayAudio — the Stem Split tray
//     voice/training.js    #vtTrayAudio — the training clip being auditioned
//
// ⚠️ ITS OTHER HALF IS `hideAudio` IN ui/audition.js AND STAYS THERE. That is the shared
// "stop it AND clear it" for every audio slot on the page — the Playground take, the audition
// player, the swap output — not a tray concept. Pulling it in here to make a matched pair would
// move a function away from two thirds of its callers.
//
// ⚠️ NO IMPORTS, DELIBERATELY. It takes the element, not an id, so it depends on nothing and can
// never appear in a cycle — the property `tests/test_webui_bundle.py`'s order guard protects.

/**
 * Point a tray's preview player at `url` for `ref`, and show it.
 *
 * Idempotent by design: calling it twice with the same `ref` leaves playback untouched, which is
 * the normal case — most re-renders do not change the selection.
 *
 * @param {VEl} el — the `<audio>` element, reached through `$` like everything else (see the
 *   two deliberate lies at `types/dom-permissive.d.ts`).
 * @param {string} ref
 * @param {string} url
 */
export function trayAudio(el, ref, url) {
  if (el.dataset.ref !== ref) {
    // The header says it: `el` is the tray's `<audio>`. `$` hands it back as `VEl`, so the kind is
    // stated here rather than on the parameter — the four call sites all pass `$(...)`.
    /** @type {HTMLAudioElement} */ (el).src = url;
    el.dataset.ref = ref;
  }
  el.style.display = '';
}

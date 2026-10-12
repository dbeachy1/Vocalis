// sys/comfy.js — the ComfyUI Stop / Start / Restart button (7.3-m4).
//
// Split out of js/sys/model.js, which had already done the analysis and written the answer into
// its own header: `COMFY`, `comfyPaint`, `pollComfy`, `comfyActionNote` (`comfyDoneLabel` when that
// header was written — the ✓ label it built is gone, see the click handler) and the `#comfyBtn` handler
// "share no state, no timer and no helper with anything above them, and there is not one call in
// either direction between the two halves." Re-checked before cutting, and still true — this is
// the free split §4 predicted, not a new decomposition.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY IT IS WORTH SPLITTING AT ALL, GIVEN IT COSTS NOTHING EITHER WAY.
//
// Because `sys/model.js` is named after one idea — "what the /health poll says, and the strip of
// buttons that acts on it" — and ComfyUI is a different idea that merely renders next door. It is
// a separate service, on a separate poll, against separate routes, whose whole purpose is to give
// back memory that Vocalis does not own. The two halves were adjacent because the button sits in
// the same row, which is a fact about layout rather than about behavior.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THIS MODULE IS NOT ON THE SHIM, AND THAT IS THE POINT — IT IS THE FIRST ONE THAT ISN'T.
//
// `pollComfy` is its only export and `js/main.js` is its only caller. main.js imports it directly,
// so nothing here is published to `window` and no inline code can reach it. Every other module in
// the tree is on the shim because still-inline code calls into it; this one has no such caller, so
// adding it would be publishing for the sake of symmetry.
//
// ⚠️ IMPORTING IT IS STILL LOAD-BEARING, and not only for the name. The `$('comfyBtn').onclick`
// at the bottom is a top-level statement, so the button is wired by the mere act of evaluating
// this file. Stop importing it and the export is not what you lose — it is the button.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// Import the shared VRAM poll from `hwstrip.js`; it owns the poll's private state and timer.
//
// ⚠️ NEVER duplicate the VRAM poll instead. `pollVram` reads `vramBusy` and `vramTimer`, which are
// the strip's own module-private state; a second copy would poll twice and fight over them. That
// is why hwstrip.js exports the function and not the state.

import { $, esc } from '../util/dom.js';
import { jget, jpost } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { pollVram } from './hwstrip.js';

// ── the wire shapes `/comfyui/*` actually carry (8.3) ─────────────────────────
/**
 * `/comfyui/status`. `available:false` is the WHOLE body on a box with no controllable ComfyUI.
 * @typedef {object} ComfyStatus
 * @property {boolean} available
 * @property {boolean} [up]
 * @property {number} [vram_gb]       max(ComfyUI's self-report, non-Vocalis whole-card usage) —
 *   the self-report alone missed ~20 GB live.
 * @property {number} [min_free_gb]
 * @property {number} [instances]
 * @property {number|null} [running]  How many systemd has up. `null` reads as "restart" — see
 *   `comfyPaint`'s `s.running == null` branch.
 */
/**
 * `/comfyui/start`, `/stop` and `/restart`'s success body. A 409 (`comfyui_busy`) or any other
 * non-2xx throws instead — see the busy-modal branch below, which reads `e.body`.
 * @typedef {object} ComfyActionResult
 * @property {boolean} ok
 * @property {string[]} services
 * @property {string} action
 * @property {boolean} ready
 * @property {number} waited_s
 * @property {number|null} freed_gb
 * @property {number|null} freed_ram_gb
 * @property {number|null} running
 */

// Offer Stop and Start separately: restarting ComfyUI would reclaim its system RAM, which may be
// needed by another workload. Read
// `running`, the systemd unit state, NOT HTTP reachability: a ComfyUI that is up but still
// warming its ROCm context answers nothing for ~30 s, and offering to Start it then would be
// a lie. If the unit state can't be read at all the button falls back to the 4.7 Restart.
/** @type {ComfyStatus|null} */
let COMFY = null; // last /comfyui/status, so an error can repaint
// 📌 WHAT THE LAST ACTION REPORTED, KEPT FOR THE TOOLTIP. The figures used to hold the button
// hostage: the ✓ label was the only place they existed, so the button could not go back to being
// a button until they had been read. Parked here they survive the repaint — which is what lets
// the repaint happen the instant the stop returns instead of five seconds later.
let COMFY_NOTE = ''; // '' until an action reports something — see `comfyActionNote`
// 🔴 2 Hz, and CHAINED rather than an interval (see `pollComfy`'s `finally`), so a slow probe
// delays the next poll instead of stacking on it. One measurement found `/comfyui/status` took
// ~4.5 ms — `systemctl --user is-active` 1.9 ms, the two
// loopback `/api/system_stats` probes 1.6 ms, the whole-card VRAM read 1.0 ms — so twice a second
// costs about 9 ms of server time per second, keeping status responsive without overlapping probes.
const COMFY_POLL_MS = 500;
function comfyPaint() {
  const b = /** @type {HTMLButtonElement} */ ($('comfyBtn')),
    s = COMFY;
  if (!s) return;
  const n = s.instances || 1,
    sfx = n > 1 ? ` ×${n}` : '',
    who = n > 1 ? `all ${n} ComfyUI instances` : 'ComfyUI';
  const held =
    s.vram_gb != null && s.vram_gb >= (s.min_free_gb || 0.1)
      ? ` — frees up to ≈${s.vram_gb.toFixed(1)} GB of VRAM, plus the system RAM it holds`
      : ' (not holding meaningful VRAM right now)';
  // 4.8-m4i: the count is configurable and defaults to 1, so the tooltip has to say so —
  // otherwise a two-GPU box looks like it can only ever control the one instance it found.
  const cfg =
    `\n\nHow many instances to control is set by "comfyui: instances:" in ` +
    `app_settings.yaml (default 1). More than one is only useful with more than one GPU.`;
  // ALWAYS enabled: a crashed/hung ComfyUI is exactly when the button is needed — and
  // exactly when its measurable VRAM reads ~0. The tooltip carries the number.
  b.disabled = false;
  if (s.running === 0) {
    b.className = 'sm primary';
    b.dataset.act = 'start';
    b.textContent = '▶ Start ComfyUI' + sfx;
    b.title = `Start ${who} — ~30 s to warm up` + cfg;
  } else if (s.running == null) {
    b.className = 'sm vram';
    b.dataset.act = 'restart';
    b.textContent = '⏏ Restart ComfyUI' + sfx;
    b.title = `Restart ${who}${held}` + cfg;
  } else {
    b.className = 'sm vram';
    b.dataset.act = 'stop';
    b.textContent = '⏹ Stop ComfyUI' + sfx;
    b.title = `Stop ${who} and leave them down${held}` + (s.running < n ? ` — ${s.running} of ${n} running now` : '') + cfg;
  }
  b.title += COMFY_NOTE; // every branch above ASSIGNS `title`, so this appends once and never stacks
}
export async function pollComfy() {
  const b = /** @type {VEl} */ ($('comfyBtn'));
  try {
    const s = await jget('/comfyui/status');
    if (!s.available) {
      b.style.display = 'none';
      return;
    } // no controllable ComfyUI on this host
    b.style.display = '';
    COMFY = s;
    if (b.dataset.busy === '1') return; // an action is mid-flight — don't clobber its UI
    comfyPaint();
  } catch (e) {
    /* transient — try again next tick */
  } finally {
    setTimeout(pollComfy, COMFY_POLL_MS);
  }
}
// Stop is the one that reports TWO numbers, because freeing the RAM is now the point.
/** One freed figure rendered, or null when it is missing or under the sensor's noise floor.
 * @param {ComfyActionResult} j @param {'freed_gb'|'freed_ram_gb'} k */
const comfyGb = (j, k) => (j && typeof j[k] === 'number' && j[k] >= 0.1 ? j[k].toFixed(1) : null);
// Built by push rather than `.filter(Boolean)`: that idiom is correct at runtime but tsc cannot
// narrow it, and papering over that with a cast would be asserting what an `if` can just prove.
/** @param {ComfyActionResult} j @returns {string[]} the figures that exist, VRAM first */
function comfyFreedBits(j) {
  const v = comfyGb(j, 'freed_gb'),
    r = comfyGb(j, 'freed_ram_gb');
  /** @type {string[]} */
  const bits = [];
  if (v) bits.push(v + ' GB VRAM');
  if (r) bits.push(r + ' GB RAM');
  return bits;
}
// 🔴 THIS REPLACED A ✓ LABEL, AND THE REPLACEMENT IS THE WHOLE POINT. What the action
// achieved is worth saying; saying it IN THE BUTTON meant the button could not simultaneously be
// the next action, and the next action is what is wanted — so it moved to the tooltip, where it
// costs nothing to leave up. `ready === false` on a start is the one non-freed thing worth
// carrying: the unit came up but had not answered its API inside COMFYUI_READY_TIMEOUT, which is
// ordinary ROCm warm-up rather than a failure, and the button correctly reads ⏹ Stop either way.
/** @param {'start'|'stop'|'restart'} act @param {ComfyActionResult} j @returns {string} */
function comfyActionNote(act, j) {
  if (act === 'start') return j && j.ready === false ? '\n\nStarted, but it has not answered its API yet — warm-up is ~30 s.' : '';
  const bits = comfyFreedBits(j);
  return bits.length ? `\n\nThe last ${act} freed ${bits.join(' + ')}.` : '';
}
/** @type {VEl} */ ($('comfyBtn')).onclick = async () => {
  const b = /** @type {HTMLButtonElement} */ ($('comfyBtn')),
    act = b.dataset.act || 'restart';
  const ing = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' }[act];
  /** @param {boolean} [force] */
  const go = async force => {
    b.dataset.busy = '1';
    b.disabled = true;
    b.innerHTML = `<span class="spin"></span>${ing} ComfyUI…`;
    let j;
    try {
      j = await jpost('/comfyui/' + act, force ? { force: true } : {});
    } catch (e) {
      b.dataset.busy = '';
      comfyPaint();
      if (
        /** @type {ErrLike} */ (e).status === 409 &&
        /** @type {ErrLike} */ (e).body &&
        /** @type {ErrLike} */ (e).body.error === 'comfyui_busy'
      ) {
        // busy — let the user decide (the only modal here)
        const r = /** @type {ErrLike} */ (e).body.running || 0,
          p = /** @type {ErrLike} */ (e).body.pending || 0,
          V = act === 'stop' ? 'Stop' : 'Restart';
        if (
          await modal(
            '⚠ ComfyUI is busy',
            `ComfyUI has <b>${r}</b> running and <b>${p}</b> queued job(s). ${V === 'Stop' ? 'Stopping' : 'Restarting'} now will kill them. ${V} anyway?`,
            [
              { label: 'Cancel', value: 0 },
              { label: V + ' anyway', class: 'danger', value: 1 },
            ],
          )
        )
          return go(true);
        return;
      }
      await modal(`Cannot ${act} ComfyUI`, esc(/** @type {ErrLike} */ (e).message || act + ' failed'), [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
      return;
    }
    // Success — the top gauges (polled every 1s) show the drop live; briefly echo what it freed.
    pollVram();
    [400, 1500, 3000].forEach(t => setTimeout(pollVram, t));
    // 🔴 THE RESPONSE IS THE CONFIRMATION — THERE IS NOTHING LEFT TO WAIT FOR OR POLL FOR.
    // `/comfyui/stop` runs a synchronous `systemctl --user stop` for every instance and does not
    // answer until each unit is down; that is precisely why it can measure what was freed. So by
    // this line ComfyUI is stopped, `j.running` says so, and the only honest button is an enabled
    // ▶ Start. Anything between here and that button is invented delay.
    //
    // It used to be nine seconds of it: a 5 s hold on the ✓ label, and then up to 4 s more because
    // clearing `busy` repaints nothing — it merely lets the NEXT poll tick repaint, and that tick
    // ran on a 4 s timer the click did not reset. Enable Start as soon as the stop response
    // confirms that the service is down.
    //
    // ⚠️ SO DO NOT REINTRODUCE A TIMER HERE, and do not hand the repaint back to the poll — 500 ms
    // is short, but it is still 500 ms of a button that is wrong and disabled for no reason.
    // `comfyPaint()` is synchronous and reads `COMFY`, which the line above has already corrected.
    const a = /** @type {'start'|'stop'|'restart'} */ (act);
    if (COMFY && j && j.running != null) COMFY = { ...COMFY, running: j.running };
    COMFY_NOTE = comfyActionNote(a, j);
    b.dataset.busy = '';
    comfyPaint(); // enabled, labeled with the NEXT action, now
  };
  return go(false);
};

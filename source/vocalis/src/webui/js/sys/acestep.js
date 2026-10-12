// sys/acestep.js — the ACE-Step Start / Stop button (8.0-m1c).
//
// Status is shared with the per-card controls so process, HTTP and model readiness use one read.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 ONE: "SERVICE UP" AND "MODEL LOADED" ARE DIFFERENT FACTS AND THIS BUTTON SHOWS BOTH.
//
// ComfyUI's button needs one number because "is it running" is the whole question there. An
// ACE-Step backend that is up and serving HTTP may hold no model at all, and generating then
// fails with "Model not fully initialized" — with the control that fixes it buried in a Gradio
// accordion that looks like an unrelated setting. The UI therefore reports unit and model state
// separately.
//
// Process state comes from the locally owned child; HTTP and loaded-model readiness remain
// separate because a no-init child is expected to start before either becomes ready.
//
// ⚠️ `model_loaded` is a THREE-state value: true, false, and null for "the backend did not
// answer". Never render null as "not loaded" — that is what makes someone re-Initialize a
// backend that is already holding 19 GB of xl-sft.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 TWO: `×N` COUNTS AUTHORIZED CARDS, NOT INSTALLED UNITS.
//
// Device authorization controls which child may accept work. Global lifecycle controls still
// address every configured child, including one whose authorization was removed.
//
// Lifecycle confirmation accounts for submitted work; stopping a child ends that work only
// after exit is confirmed, while queued jobs remain pending for an explicitly initialized child.

import { $, esc } from '../util/dom.js';
import { jget, jpost } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { pollVram } from './hwstrip.js';

// ── the wire shapes `/acestep/*` actually carry (8.3) ─────────────────────────
// 🔴 `AceBackend` AND `AceStatus` ARE IN `types/vocalis.d.ts`, NOT HERE, AND THAT IS THE FIX
// RATHER THAN A TIDY-UP. This file owns the poll (`ACE_SUBS`/`fanout`) and `ace/cards.js`
// subscribes to it through `onAceStatus` — one route, one subscription, two directories. A local
// typedef in each is two statements about one payload that are free to drift, and in the pass
// that wrote them they drifted immediately: this file said `loading` was a `boolean`, cards.js
// said `string`, and cards.js was right (`runtime/acestep.py:674` stores the MODEL NAME). The
// checker caught it as a TS2345 on the `onAceStatus(...)` argument, which is the whole argument
// for declaring a subscribed-to shape once, centrally.
/**
 * `/acestep/start`, `/stop` and `/restart` response body.
 * @typedef {object} AceActionResult
 * @property {boolean} ok
 * @property {Array<{device:string,state:string,ok:boolean,error?:string}>} devices
 * @property {string} action
 * @property {number|null} running
 */

/** @type {AceStatus|null} */
let ACE = null; // last /acestep/status, so an error can repaint

// 🔴 ONE POLL, MANY CONSUMERS. `ace/cards.js` renders the per-card rows from the SAME
// Candidate audio is served through its producing child. A reset can make candidates unavailable;
// confirmation states that risk without promising the files survive.
//
// ⚠️ FED BY ace/tray.js, WHICH OWNS THE LIST. A second count here — off a second fetch of
// /acestep/jobs — is two numbers that can disagree, and the one on screen would be whichever
// landed last. The tray dispatches on every poll it already makes.
let ACE_CANDS = 0;
document.addEventListener('ace:candidates', ev => {
  // ⚠️ ITS OWN CONST, NOT AN INLINE CAST INSIDE THE CALL. Prettier reflows this line and
  // 8.3.2 recorded it re-targeting a `@type` cast when it did — tsc is the only thing that
  // notices, so the assertion gets a statement of its own where nothing can move it.
  const d = /** @type {CustomEvent} */ (ev).detail || {};
  ACE_CANDS = Number(d.finished) || 0;
});

/** @type {((s: AceStatus) => void)[]} */
const ACE_SUBS = [];
/** @param {(s: AceStatus) => void} fn */
export function onAceStatus(fn) {
  ACE_SUBS.push(fn);
  if (ACE) fn(ACE); // a late subscriber still gets the current state
}
/** @param {AceStatus} s */
function fanout(s) {
  // One bad subscriber must not take the button down with it — this fan-out runs inside the
  // poll's own try, and an exception here would skip the `finally` that schedules the next tick.
  for (const fn of ACE_SUBS) {
    try {
      fn(s);
    } catch (e) {
      /* keep polling */
    }
  }
}

// What the tooltip says about models, which is the half ComfyUI's button has no equivalent for.
/** @param {AceStatus} s */
function aceModelLine(s) {
  const bs = s.backends || [];
  if (!bs.length) return '';
  const bits = bs.map(b => {
    const where = b.device;
    if (b.unit === 'stopping') return `${where}: stopping; child exit not confirmed`;
    if (b.unit === 'starting') return `${where}: starting; HTTP not ready`;
    if (!b.up) return `${where}: ${b.unit || 'child not answering'}; HTTP unavailable`;
    if (b.model_loaded === null) return `${where}: up, model state unknown`;
    if (b.loading) return `${where}: loading ${b.loading}`;
    if (!b.model_loaded) return `${where}: up, NO model loaded`;
    return `${where}: ${b.model || 'a model'} loaded`;
  });
  return '\n\n' + bits.join('\n');
}

function acePaint() {
  const b = /** @type {HTMLButtonElement} */ ($('aceBtn')),
    s = ACE;
  if (!s) return;
  const n = s.instances || 1,
    sfx = n > 1 ? ` ×${n}` : '';
  const who = n > 1 ? `all ${n} ACE-Step backends` : 'ACE-Step';
  const models = aceModelLine(s);
  // Which cards these are is worth saying: the count is the AUTHORIZED one, so a user who has
  // unticked a card should be able to see that is why the number changed.
  const cards = (s.backends || []).map(x => x.device).join(', ');
  const auth = cards
    ? `\n\nAuthorized cards: ${cards} — set under ⚙ Settings ▸ Devices.`
    : '';
  // ALWAYS enabled: a crashed or hung backend is exactly when the button is needed.
  b.disabled = false;
  if (s.running === 0) {
    b.className = 'sm primary';
    b.dataset.act = 'start';
    b.textContent = '▶ Start ACE-Step' + sfx;
    b.title = `Start ${who} without loading a model. Select Initialize on a card when ready.${models}${auth}`;
  } else if (s.running == null) {
    b.className = 'sm vram';
    b.textContent = '⏏ Restart ACE-Step' + sfx;
    b.dataset.act = 'restart';
    b.title = `Restart ${who} after any current stop operation confirms child exit.${models}${auth}`;
  } else {
    b.className = 'sm vram';
    b.dataset.act = 'stop';
    b.textContent = '⏹ Stop ACE-Step' + sfx;
    const some = s.running < n ? ` — ${s.running} of ${n} running now` : '';
    b.title = `Stop ${who} and leave them down. Process exit does not measure released VRAM.${some}${models}${auth}`;
  }
}

export async function pollAcestep() {
  const b = /** @type {VEl} */ ($('aceBtn'));
  try {
    const s = await jget('/acestep/status');
    if (!s.available) {
      b.style.display = 'none'; // no controllable ACE-Step here
      ACE = s;
      fanout(s); // …but the TAB still has to say so
      return;
    }
    b.style.display = '';
    ACE = s;
    fanout(s);
    if (b.dataset.busy === '1') return; // an action is mid-flight
    acePaint();
  } catch (e) {
    /* transient — try again next tick */
  } finally {
    setTimeout(pollAcestep, 4000);
  }
}

/** @type {VEl} */ ($('aceBtn')).onclick = async () => {
  const b = /** @type {HTMLButtonElement} */ ($('aceBtn')),
    act = b.dataset.act || 'restart';
  const ing = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' }[act];
  const backends = (ACE && ACE.backends) || [];
  const affected = backends.filter(x => x.unit !== 'stopped');
  const active = affected.filter(x => x.busy || x.loading || x.model_loaded === true);
  if (act !== 'start' && (active.length || ACE_CANDS)) {
    const what = active.map(x => `${x.device}${x.model ? ` (${x.model})` : ''}`).join(', ');
    const verb = act === 'restart' ? 'Restarting' : 'Stopping';
    const work = active.length
      ? `The affected card state is ${what}. ${verb} the child ends submitted renders; model ` +
        `loading or HTTP readiness may still be uncertain. `
      : '';
    const tray = ACE_CANDS
      ? `There ${ACE_CANDS === 1 ? 'is' : 'are'} ${ACE_CANDS} finished candidate${ACE_CANDS === 1 ? '' : 's'}; ` +
        `their availability after a child reset is not guaranteed. `
      : '';
    const ok = await modal(`${verb} ACE-Step children?`, work + tray + 'Continue?', [
      { label: 'Cancel', value: 0 },
      { label: `${verb} anyway`, class: 'danger', value: 1 },
    ]);
    if (!ok) return;
  }
  b.dataset.busy = '1';
  b.disabled = true;
  b.innerHTML = `<span class="spin"></span>${ing} ACE-Step…`;
  // Typed here rather than inferred: `aceDoneLabel` used to be what tied `j` to its wire shape,
  // and deleting it would have quietly left `j.running` an unchecked `any`.
  /** @type {AceActionResult|undefined} */
  let j;
  try {
    j = await jpost('/acestep/' + act, {});
  } catch (e) {
    b.dataset.busy = '';
    acePaint();
    await modal(`Cannot ${act} ACE-Step`, esc(/** @type {ErrLike} */ (e).message || act + ' failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  // Refresh hardware telemetry after the process transition.
  pollVram();
  [400, 1500, 3000].forEach(t => setTimeout(pollVram, t));
  // Repaint from the latest status; the server may still be confirming child exit.
  if (ACE && j && j.running != null) ACE = { ...ACE, running: j.running };
  b.dataset.busy = '';
  acePaint(); // enabled, labeled with the NEXT action, now
};

// sys/devices.js — the ⚙ Settings ▸ Devices panel and the voice dropdowns (7.3-m4).
//
// This module owns the device and voice controls plus their delegated event wiring.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY DEVICES AND VOICES ARE ONE FILE, WHEN THE NAMES SUGGEST TWO.
//
// Because the banner is one area and `loadVoices` is the *dropdown* half of the same idea: the
// panel decides which cards render, the dropdowns decide which voice they render with, and both
// are the "what does this box have available" read that the boot sequence does back to back.
// Splitting them would buy two files that are each other's only neighbor. §4 of the design doc
// files them together for that reason and this move does not relitigate it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE WIRING CAME WITH IT, AND IT HAD TO — ONE LINE OF IT WAS A PARSE-TIME MINE.
//
//     $('satAdd').addEventListener('click',satAdd);        index.html, top level
//
// `satAdd` there is a BARE VALUE, evaluated when the classic script is PARSED. Leave that line
// inline while `satAdd` becomes a module export and it throws a ReferenceError mid-parse, killing
// every top-level statement after it — most of the page. tests/test_webui_parsetime.py cannot see
// this shape (its `_names_used` matches a name followed by `(`, `.` or `[`, and a bare identifier
// matches none of those), so it would have gone green on the crash. js/main.js's header has the
// long version; three sibling lines under the old `── boot ──` banner had the same defect.
//
// ✅ Moving the whole delegated block also emptied the inline caller list for SIX names. saveDevices,
// devReconnect, satAdd, satRotate, satRemove and satUploadCert had exactly one call site each, all
// of them in that block, so none of them is exported and none is on the shim. A satellite action is
// reachable only by clicking a satellite row, which is what the delegation already said.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED, AND WHY IT IS ONLY EIGHT OF NINETEEN.
//
//   loadDevices · devPollStart · devPollStop · alignDevCols   switchTab still calls all four when
//                                                             ⚙ Settings opens (index.html, inline)
//   loadVoices                                                six inline call sites in the Voices
//                                                             tab, all inside handlers
//   loadGpus                                                  js/main.js only — imported there, not
//                                                             read off the shim
//   renderDevices · devs                                      NEITHER has a page caller. Both are
//                                                             driven by devices_browser_spec.mjs
//
// 🔴 A SPEC CALLER IS A CALLER, and this is the module that proves the rule was worth writing down.
// Both of those were private on a correct measurement of index.html — the wiring move took
// renderDevices' last inline caller with it — and `tests/test_webui_modules.py` went red naming
// them, which is the whole reason that test exists. Left private, the browser spec would have
// thrown `ReferenceError: renderDevices is not defined` INSIDE the page: twelve failed checks and,
// historically (log.js, 7.1-m11b), a spec that hangs for 100 s and prints nothing.
//
// 🔴 `devs`, `devBusy` and `devTimer` ARE NOT EXPORTED, and `devBusy`/`devTimer` never may be.
// Both are `let` bindings this file REASSIGNS, and `Object.assign(window, mod)` copies a value
// once — an inline reader would be pinned to the seed forever (the rule the shim states, and the
// one js/sys/model.js's MODELS/ENCRYPTED nearly shipped a security regression over). Nothing
// outside this file names any of the three: index.html mentions `devBusy` only in the ⟳ button's
// comment, which is describing this file's behavior rather than reaching for its state.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE STILL REACHES FOR AS AN INLINE GLOBAL — FOUR names, all resolved at CALL time.
//
//   state                     the local card registry; loadGpus writes state.gpus
//   restoreVoice              per-dropdown restore of the remembered voice
//   BOOK_F · PG_F             the two field maps, `const` at index.html's top level
//
// ✅ `voiceOrder` AND `voiceOptText` LEFT THIS LIST IN 7.3-m4q and are ordinary imports below. They
// were here because they were inline and there was nowhere to import them from; ui/voicepicker.js
// is that somewhere. Nothing about this file's behavior changed — the point is that it no longer
// depends on the shim having published them before `loadVoices` runs.
//
// ⚠️ BOOK_F and PG_F are declared BELOW this code's old position and that was always fine — a
// top-level `const` in a classic script lives in the global LEXICAL environment, which a module
// reaches through its scope chain, and `loadVoices` only names them when it runs. They become a
// real import when the per-voice-settings area lands. Do NOT redeclare them here: two declarations
// means this file writes its copy while inline readers read one nothing updates.
//
// 📌 `loadEnhanceInfo` is NOT in that list — sys/enhance.js already owns it (7.3-m3a), so it is a
// real import below. Every name here turns into one the same way, as its area moves.

import { $, esc } from '../util/dom.js';
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { jget, jpost, jput, jdel } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { DOCKER } from './modelstate.js'; // the Docker-package flag, from /health
import { loadEnhanceInfo } from './enhance.js';
import { voiceOrder, voiceOptText } from '../ui/voicepicker.js';
// `loadVoices` populates both selects before `restoreVoice` reapplies the saved choice. The field
// maps define which settings belong to each context.
import { restoreVoice, BOOK_F, PG_F } from '../voice/params.js';

// ── the wire shapes `/devices` actually carries (8.3) ─────────────────────────
/**
 * One entry of `/devices`'s `subsystems` — `runtime/subsystems.SUBSYSTEMS`, sent whole so labels
 * stay centralized and cannot drift from the tab names.
 * @typedef {object} SubsystemDef
 * @property {string} key
 * @property {string} label
 * @property {string} hint
 * @property {boolean} satellite
 */
/**
 * One row of `/devices`'s `devices` — this box's cards plus every satellite card, merged with
 * the saved per-device settings.
 * @typedef {object} DeviceRow
 * @property {string} id              `cuda:N` local, `<satellite>:cuda:N` remote, or `cpu`.
 * @property {string} label
 * @property {string|null} satellite  That satellite's name, or `null` for a local card.
 * @property {boolean} reachable
 * @property {number|null} loaded     What this card actually holds right now. `null` on a local
 *   card (never in question) or an unreachable satellite (unknown) — never a stand-in for 0.
 * @property {boolean} enabled
 * @property {string[]} capable       Subsystem keys this device can run AT ALL — capability,
 *   never authorization; a satellite carries exactly one, never the whole list.
 * @property {Record<string, boolean>} uses  What the user AUTHORIZED, keyed by subsystem key.
 *   A missing key reads as allowed — see `useRow`'s own note.
 */
/**
 * One row of `/devices`'s `satellites` — `runtime/satellites.snapshot()` merged with
 * `security()`'s TLS verdict for that satellite's client.
 * @typedef {object} SatelliteRow
 * @property {string} name
 * @property {string} url
 * @property {boolean} reachable
 * @property {string} error
 * @property {boolean} ready
 * @property {boolean} loading
 * @property {string} cert
 * @property {boolean} secret_set     A BOOL, never the value — the secret is served once, at
 *   generation, and never again.
 * @property {string} version
 * @property {unknown} [sr]
 * @property {boolean} verified
 * @property {string} note
 * @property {number} vram_cap_gb     What Settings HAS saved. 0 (or unset) means no ceiling.
 * @property {number} st_max_batch    The most chunks this satellite is handed in one batch while
 *   rendering live SillyTavern speech (11.2). 1 is one chunk at a time, and is the default. No
 *   `_live` twin: Vocalis enforces this one itself, so there is nothing the satellite can ignore.
 * @property {number|null} vram_cap_live  What the satellite says it is actually enforcing —
 *   `null` while unreachable OR too old to report one (pre-1.11): a third state, not a 0.
 * @property {Record<string, number>|null} vram_reserved_gb  Per-card GB this satellite holds,
 *   or `null` while unreachable.
 */

// ── Devices + voices dropdowns ─────────────────────────────────────────
// 5.3-m3: one row per device — this box's cards AND every satellite card — each with its own
// enable checkbox. 5.4.1 dropped the per-row worker count; replaces the old single box plus a
// separate GPU checkbox list. One number stopped being defensible the moment a 24 GB satellite
// card and a card sharing a box with an LLM sat in the same pool.
//
// state.gpus stays: it is this box's LOCAL card registry, which the strip, Voice Swap, training
// and the splitter all read. Satellites are not cards on this machine and never belong in it.
export async function loadGpus() {
  state.gpus = await jget('/gpus');
}
// 📌 EXPORTED FOR THE BROWSER SPEC, NOT FOR THE PAGE — devices_browser_spec.mjs seeds the panel
// with `devs.rows = rows; devs.sats = sats;` to render a satellite layout without a satellite.
// Nothing in index.html names it. Safe on the shim by the eligibility rule: it is a `const` that
// is only ever MUTATED (`devs.rows=…`), never rebound — the FILT/enh case, not the MODELS one.
// `subs` comes from the server-side subsystem registry so panel labels share one authority.
/**
 * @typedef {object} DevState
 * @property {DeviceRow[]} rows
 * @property {SatelliteRow[]} sats
 * @property {SubsystemDef[]} subs
 */
/** @type {DevState} */
export const devs = { rows: [], sats: [], subs: [] };
let devBusy = false;
// How many `saveDevices` calls are between reading the boxes and their PUT being answered, and
// how many have ever started. `loadDevices` reads both: see the note where it discards an answer.
let devSaving = 0,
  devSaveGen = 0;
/** @type {ReturnType<typeof setInterval>|null} */
let devTimer = null;
/** @param {{force?: boolean}} [opts] */
export async function loadDevices(opts) {
  // 🔴 Never overlap. A GET probes every satellite for liveness (5 s timeout each), so a poll
  // that fires while the last one is still out would stack requests on a box that is down —
  // which is a normal steady state for satellites started manually.
  //
  // `{force:true}` (the Check now button) waits for the in-flight poll instead of giving up:
  // a request the user made explicitly must not be dropped because a background timer got
  // there first. Still only one request at a time — it waits, it does not overlap.
  if (devBusy) {
    if (!(opts && opts.force)) return;
    while (devBusy) await new Promise(r => setTimeout(r, 120));
  }
  devBusy = true;
  const gen = devSaveGen;
  try {
    const d = await jget('/devices');
    // 🔴 AN ANSWER THAT CROSSED A SAVE IS THROWN AWAY. It describes the server BEFORE the save, and
    // painting it puts back the tick the user just changed: untick a card, "Stop ACE-Step on
    // these cards?" opens, the 10 s poll answers while it is open, and the box is drawn ticked
    // again. The save still goes through unticked, so the panel then shows the opposite of what
    // is stored until the next poll. Measured 2026-10-12 in llm_tick_warn_browser_spec.mjs under
    // load: PUT /devices from 15.1 s to 19.0 s, a poll GET answered at 15.9 s, the page's box
    // ticked and the server's row unticked. So: nothing is painted while a save is in progress,
    // nor from a request that was sent before a save began. The next poll reads the truth.
    if (devSaving || gen !== devSaveGen) return;
    devs.rows = d.devices || [];
    devs.sats = d.satellites || [];
    devs.subs = d.subsystems || [];
  } catch (e) {
    const list = /** @type {VEl} */ ($('devList'));
    list.innerHTML = '<span class="muted">could not read the device list</span>';
    // The list no longer shows what `renderDevices` last drew, so forget that drawing. Left in
    // place, the next GOOD answer built the same html, matched it, and drew nothing: one failed
    // read left "could not read the device list" on screen until a row changed or the page was
    // reloaded. (2026-10-12, found in review; the same short circuit as the Cancel case below.)
    if (list.dataset) delete list.dataset.html;
    return;
  } finally {
    devBusy = false;
  }
  renderDevices();
  renderSats();
}
// Satellites can start independently of this page, so poll while the panel is open. The route
// health-checks each satellite; the Check now button provides an immediate refresh.
export function devPollStart() {
  devPollStop();
  devTimer = setInterval(loadDevices, 10000);
}
export function devPollStop() {
  if (devTimer) {
    clearInterval(devTimer);
    devTimer = null;
  }
}
/** @param {DeviceRow} d */
function devRow(d) {
  // The row is dimmed when unreachable but its controls stay LIVE — see the .off note in the CSS.
  const off = d.satellite && !d.reachable;
  // 5.4.1 removed the worker box. A device holds exactly ONE replica now, so the only thing
  // left to say about a card is whether it is used — see DESIGN_6_2_BATCHING §1.
  // A ticked row therefore expects 1 and an unticked one expects 0.
  const want = d.enabled ? 1 : 0;
  // `loaded` is the card's current allocation and may differ from saved settings after a restart.
  // Show a warning only when the known allocation is unexpected. An unticked row expects ZERO,
  // or releasing a card would report drift forever. `loaded` is null when unreachable and
  // undefined for local cards.
  const drift =
    d.satellite && d.loaded != null && d.loaded !== want
      ? ` <span class="warn" title="What this card is holding right now, which is not what this row asks for. Press ⟳ to make the satellite match.">· ${d.loaded} loaded</span>`
      : '';
  // ⟳ acts on the whole satellite, not this one row: Engine.load is declarative per MACHINE, so
  // sending one card's state would zero that satellite's other cards.
  const sync = d.satellite
    ? ` <button class="devSync small" data-sat="${esc(d.satellite)}" title="Reconnect — tell satellite ${esc(d.satellite)} to hold exactly the cards these rows tick. Use it after that machine has been restarted.">⟳</button>`
    : '';
  return `<div class="devwrap"><div class="gpu dev${off ? ' off' : ''}" data-id="${esc(d.id)}">
    <input type="checkbox" class="devchk"${d.enabled ? ' checked' : ''}>
    <span class="dlab" title="${esc(d.id)}">${esc(d.id)} — ${esc(d.label)}${off ? ' <i>(not running)</i>' : ''}</span>${drift}${sync}
  </div>${useRow(d)}</div>`;
}
// §4.4 — the indented ticks under one card: which parts of Vocalis may use it.
//
// 🔴 IT RENDERS `capable`, NEVER THE FULL LIST. `capable` is what this device CAN run and comes
// from the server; a satellite is a Chatterbox render box and nothing else, so its row shows ONE
// box rather than five with four permanently dead. An unticked box means "you could, but I said
// no" — say that about VoxCPM2 on a satellite and the panel is promising what the server cannot
// keep, which is this codebase's most-repeated defect and is not being added on purpose.
//
// 🔴 AN ABSENT KEY IS CHECKED, and `!== false` is how, deliberately rather than `=== true`.
// Every config written before 7.6 has no `uses` map at all, so every box must arrive ticked and
// nothing may be narrowed until the user says so. Reading it the other way round would switch
// every subsystem off on every existing install the moment this shipped.
//
// Hidden when the card itself is unticked: that card is out entirely, so narrowing it further is
// a control over nothing. The `change` handler below toggles this on the click rather than
// waiting for the save's round trip.
/** @param {DeviceRow} d */
function useRow(d) {
  const caps = d.capable || [];
  if (!caps.length || !devs.subs.length) return '';
  const uses = d.uses || {};
  const boxes = devs.subs
    .filter(s => caps.includes(s.key))
    .map(
      s =>
        `<label title="${esc(s.hint || '')}"><input type="checkbox" class="usechk" data-sub="${esc(s.key)}"${uses[s.key] !== false ? ' checked' : ''}><span>${esc(s.label)}</span></label>`,
    )
    .join('');
  return boxes ? `<div class="devuses"${d.enabled ? '' : ' hidden'}>${boxes}</div>` : '';
}
// Exported for the browser spec, which verifies that the unchanged-HTML short circuit preserves
// focus on a checkbox across repeated renders.
export function renderDevices() {
  const local = devs.rows.filter(d => !d.satellite);
  let html = local.length ? local.map(devRow).join('') : '<span class="muted">No CUDA devices — jobs run on CPU.</span>';
  // Keep this warning visible while no device is enabled. CPU fallback is valid, but substantially
  // slower, and unticking all devices also releases satellite VRAM.
  if (devs.rows.length && !devs.rows.some(d => d.enabled))
    html =
      '<div class="warn small" style="display:block;margin:0 0 8px">⚠ Nothing is ticked — ' +
      'renders fall back to this machine&rsquo;s CPU, which is far slower than a card. ' +
      'Any satellite VRAM is released.</div>' +
      html;
  for (const s of devs.sats) {
    const cards = devs.rows.filter(d => d.satellite === s.name);
    const status = s.reachable
      ? '<span style="color:var(--ok)">running</span>'
      : '<span class="muted">not running — start it on that machine</span>';
    // Label the group as a satellite and use the status color so it is distinct from local cards.
    html += `<div class="devgrp"><div class="small sathdr">🛰 <b>satellite ${esc(s.name)}</b> · <span class="muted">${esc(s.url)}</span> · ${status}</div>`;
    // A satellite never yet reached contributes no card rows, because nothing here knows what
    // cards it has. Say so, rather than rendering an empty group that reads as "zero cards".
    html += cards.length
      ? cards.map(devRow).join('')
      : '<div class="small muted" style="padding:6px 0">Its cards appear here once it has been reached once.</div>';
    html += '</div>';
  }
  // 🔴 The unchanged-html short circuit is now the WHOLE of the focus protection, so it is
  // load-bearing rather than an optimization. This runs from a 10-second poll and replaces the
  // entire list; leaving the DOM alone when nothing changed is what keeps a checkbox the user
  // just clicked from being destroyed under them.
  //
  // 5.4.1 removed the guard that used to sit here for the worker box. It tested for a focused
  // `.wk`, which no longer exists in the markup, so it could only ever be false — dead code
  // that read as live protection. The case it protected against is gone with the control: a
  // number input does not fire `change` until blur, so it could hold a digit the server had
  // never seen. A checkbox saves on the click itself, so there is no unsaved state to lose.
  const list = $('devList');
  if (list && list.dataset && list.dataset.html === html) {
    alignDevCols();
    return;
  } // unchanged — leave it
  if (list && list.dataset) list.dataset.html = html;
  /** @type {VEl} */ ($('devList')).innerHTML = html;
  alignDevCols();
}
// The worker box belongs beside the device it configures, so the label column is sized to the
// WIDEST label and every row's box lines up just past it — including across the satellite
// groups, whose labels can be much longer than a local card's. Measure rather than set a fixed
// width because the label length depends on each device's reported name.
//
// 🔴 Clearing the variable before measuring is load-bearing. `scrollWidth` reports the element's
// own width once that is wider than the text, so measuring while the previous value is still
// applied re-reports it and the column creeps wider on every single render.
//
// ⚠️ `scrollWidth` is 0 inside `display:none`, which is where ⚙ Settings sits until it is
// opened. That is why switchTab calls this too — at boot there is nothing to measure, and the
// `auto` fallback covers that moment.
export function alignDevCols() {
  const list = $('devList');
  if (!list) return;
  list.style.removeProperty('--dlabw');
  const w = Math.max(0, ...[...list.querySelectorAll('.dlab')].map(el => el.scrollWidth));
  if (w) list.style.setProperty('--dlabw', Math.ceil(w) + 18 + 'px');
}
// ── Satellites (5.3-m2) ────────────────────────────────────────────────
// Define a satellite by name + URL. Saving generates the shared secret and shows it ONCE —
// the server returns it in that one response and never again (snapshot reports a bool), so
// there is deliberately nowhere in this UI that can redisplay it.
/** @param {SatelliteRow} s */
function satRow(s) {
  // 🔴 The badge is the SERVER's verdict, never "the URL starts with https". Unpinned
  // self-signed TLS is barely better than plain HTTP against an active attacker on the LAN,
  // and a badge that calls it secure is worse than no badge at all.
  const sec = s.verified
    ? '<span title="TLS, pinned to this satellite\'s certificate">🔒 pinned</span>'
    : `<span class="warn" title="${esc(s.note || '')}">⚠ ${esc(s.verified === false && s.cert ? 'pin failed' : 'not pinned')}</span>`;
  const live = s.reachable
    ? `<span style="color:var(--ok)">running</span>${s.version ? ' · v' + esc(s.version) : ''}`
    : '<span>not running</span>';
  // The saved VRAM ceiling and the satellite's reported effective ceiling are separate facts.
  // Older satellites may ignore the saved value, so display both when they disagree. An empty
  // ceiling means unlimited; label that state as "all" rather than "none" to avoid implying zero.
  const cap = Number(s.vram_cap_gb || 0);
  // Batch size is never blank: 1 selects serial processing, so the effective value is always shown.
  const stb = Math.max(1, Math.min(Number(s.st_max_batch || 1) || 1, 64));
  const live_cap = s.vram_cap_live === null || s.vram_cap_live === undefined ? null : Number(s.vram_cap_live);
  const held =
    s.vram_reserved_gb && typeof s.vram_reserved_gb === 'object'
      ? Object.entries(s.vram_reserved_gb)
          .map(([d, g]) => `${esc(d)} ${Number(g).toFixed(1)} GB`)
          .join(' · ')
      : '';
  // Do not guess why an effective cap differs. The server distinguishes these states
  // (`vram_cap_live` is null when the
  // satellite did not report a cap AT ALL, which is every build before 1.11):
  //   * it never mentioned one   -> it is too old to know about the setting. Update it.
  //   * it mentioned a different one -> it knows, and has not taken this one yet. The server re-sends
  //     the number on every health probe, so this clears itself within a tick or two; if it
  //     does not, the satellite's own log says what it did with it.
  //   * it agrees -> in effect.
  const capNote =
    cap <= 0 || !s.reachable
      ? ''
      : live_cap === null
        ? `<span class="warn" title="This satellite never mentioned a VRAM cap, so it is older than the setting — it is on ${esc(s.version || 'an unknown build')} and 1.11 is the first that understands it. Update it, or the number here is doing nothing.">⚠ too old for this</span>`
        : Math.abs(live_cap - cap) > 0.05
          ? `<span class="warn" title="It is on ${esc(s.version || 'an unknown build')} and understands the setting, but it is holding a ceiling of ${live_cap > 0 ? live_cap.toFixed(1) + ' GB' : 'none'} rather than this one. Vocalis re-sends the number every few seconds, so this normally clears itself; if it stays, the satellite's own console says what it did with the cap.">⚠ not taken yet</span>`
          : '<span style="color:var(--ok)">in effect</span>';
  return `<div class="satrow" data-name="${esc(s.name)}">
    <div><b class="satname">${esc(s.name)}</b> · <span class="muted">${esc(s.url)}</span> · ${live} · ${sec}</div>
    <div class="small muted" style="margin:2px 0 4px">${s.secret_set ? 'shared secret set' : '<b>no shared secret</b>'} · ${s.cert ? 'certificate: ' + esc(s.cert) : 'no certificate pinned'}${s.reachable ? '' : s.error ? ' · <span class="warn">' + esc(s.error) + '</span>' : ''}</div>
    <div class="row" style="gap:6px;margin:0;align-items:center">
      <label class="small muted" style="display:inline-flex;align-items:center;gap:5px;margin:0" title="The most VRAM this satellite may hold ON ANY ONE CARD, in GB. Empty means ALL of it — no ceiling, which is what it does today. A cap does not reserve anything — it is a ceiling, so the rest of that card stays free for ComfyUI or anything else you run there.">
        <span>Max VRAM</span>
        <input class="satCap" type="number" min="0" max="1024" step="0.5" placeholder="all"
               value="${cap > 0 ? esc(String(cap)) : ''}" style="width:82px" spellcheck="false">
        <span>GB</span>
      </label>
      <button class="satCapSave small">Save</button>
      ${capNote}
      ${held ? `<span class="small muted" title="What this satellite is holding right now, per card. This is what the cap limits — free VRAM moves every time anything else on that machine allocates.">holding ${held}</span>` : ''}
      <div style="flex:1"></div>
      <button class="satCert small">Upload certificate…</button>
      <button class="satRot small">New secret…</button>
      <button class="satDel small danger">Remove</button>
    </div>
    <div class="row" style="gap:6px;margin:4px 0 0;align-items:center">
      <label class="small muted" style="display:inline-flex;align-items:center;gap:5px;margin:0" title="The most chunks Vocalis will ask this satellite to render in one batch for SillyTavern speech. A batch is faster per chunk, but it hands nothing back until every chunk in it has finished — so a wide batch arrives as one lump. 1 renders one chunk at a time, which keeps the audio coming steadily, and is the default. Books, scene builds and pre-rendered guesses are not affected by this.">
        <span>SillyTavern max batch size</span>
        <input class="satStBatch" type="number" min="1" max="64" step="1" placeholder="1"
               value="${esc(String(stb))}" style="width:64px" spellcheck="false">
        <span>chunk${stb === 1 ? '' : 's'}</span>
      </label>
      <button class="satStBatchSave small">Save</button>
      <span class="small muted">If speech playback pauses, lower this.</span>
    </div>
  </div>`;
}
function renderSats() {
  const list = $('satList');
  // 🔴 §17 — NEVER REPAINT WHILE HE IS TYPING IN THE CAP BOX. This runs from the same 10-second
  // poll `renderDevices` does, and it replaces the whole list unconditionally; that was harmless
  // while a satellite row held nothing but buttons, and stops being harmless the moment one holds
  // an input with unsaved state. A number input does not fire `change` until blur, so a repaint
  // mid-type destroys a digit the server has never seen — and the row also carries LIVE figures
  // ("holding 4.2 GB"), so the html-unchanged short circuit that protects `devList` cannot help
  // here: this markup legitimately differs on nearly every tick.
  //
  // ⚠️ Narrow on purpose. Focus anywhere else in the list — a button, a link — loses nothing to a
  // repaint, and blocking on that would freeze the panel's live status for as long as a stray
  // focus lasted. 5.4.1 deleted a guard of this shape as dead code because the control it named
  // was gone; this one names a control that is on screen.
  const busy =
    list &&
    document.activeElement &&
    document.activeElement.classList &&
    // 11.2 — BOTH boxes. The guard names the controls that hold unsaved state, so a second one
    // has to be named here too or the 10 s poll eats a digit out of it.
    (document.activeElement.classList.contains('satCap') || document.activeElement.classList.contains('satStBatch')) &&
    list.contains(document.activeElement);
  if (busy) return;
  /** @type {VEl} */ (list).innerHTML = devs.sats.length
    ? devs.sats.map(satRow).join('')
    : '<span class="muted">None. Vocalis renders on this machine\'s cards only.</span>';
}
// Shown once, and this is the only place it can be shown. Not selectable-and-forgotten: the
// modal stays until it is dismissed deliberately, because losing it means rotating.
/** @param {string} name @param {string} secret */
function showSecret(name, secret) {
  // 🔴 Blank the modal body on the way out. Closing a modal only removes a CSS class from the
  // overlay — the body keeps its HTML until some later modal happens to replace it — so without
  // this the secret sits in the live DOM after it has been "dismissed", readable by anything on
  // the page and visible to anyone who opens the inspector. Found in a real browser; the route
  // tests cannot see it, because the server did nothing wrong. Shown once has to mean GONE.
  // `number`, not a generic passthrough: `clear` is only ever handed to THIS modal's `.then()`,
  // and its one action ({value:1}) fixes T=number — see modal()'s own `@template T`.
  /** @param {number} v @returns {number} */
  const clear = v => {
    /** @type {VEl} */ ($('mBody')).innerHTML = '';
    return v;
  };
  // October 10, 2026: the Docker satellite has no setup.bat. Its setup command (design section 9,
  // "Satellite package") asks for the secret itself, so the text says where it goes in that case too.
  // Release audit 2026-10-11, item 10: in the Docker package the dialog used to open with setup.bat,
  // which a Docker satellite does not have; it now names the real programs first. A developer's
  // source run keeps the setup.bat wording.
  const where = DOCKER
    ? `<p>Paste this into the satellite's setup on <b>${esc(name)}</b> when it asks for the secret: the <b>Vocalis Satellite setup program</b> on Windows, or <code>satellite-setup.sh</code> on Linux. <b>It is shown once and cannot be retrieved</b> — if you lose it, generate a new one here and run that setup again to give the satellite the new secret (on Windows the Start menu's <b>Change secret</b>; on Linux <code>satellite-setup.sh --new-secret</code>).</p>`
    : `<p>Paste this into <code>setup.bat</code> on <b>${esc(name)}</b>. <b>It is shown once and cannot be retrieved</b> — if you lose it, generate a new one here and re-run setup there.</p>`;
  return modal(
    `Shared secret for ${name}`,
    `${where}
     <p><input readonly value="${esc(secret)}" spellcheck="false" style="width:100%;font-family:ui-monospace,Consolas,monospace" onclick="this.select()"></p>
     <p class="small muted">Vocalis keeps its own copy. The satellite will not answer until it has the same one.</p>`,
    [{ label: 'Done', class: 'primary', value: 1 }],
  ).then(clear);
}
async function satAdd() {
  const name = /** @type {HTMLInputElement} */ ($('satName')).value.trim().toLowerCase(),
    url = /** @type {HTMLInputElement} */ ($('satUrl')).value.trim();
  /** @type {VEl} */ ($('satErr')).style.display = 'none';
  if (!name || !url) {
    /** @type {VEl} */ ($('satErr')).textContent = 'A name and a URL are both needed.';
    /** @type {VEl} */ ($('satErr')).style.display = '';
    return;
  }
  let r;
  try {
    r = await jpost('/satellites', { name, url });
  } catch (e) {
    /** @type {VEl} */ ($('satErr')).textContent = /** @type {ErrLike} */ (e).message || 'the request failed';
    /** @type {VEl} */ ($('satErr')).style.display = '';
    return;
  }
  /** @type {HTMLInputElement} */ ($('satName')).value = '';
  /** @type {HTMLInputElement} */ ($('satUrl')).value = '';
  await showSecret(name, r.secret);
  loadDevices();
}
/** @param {string} name */
async function satRotate(name) {
  if (
    !(await modal(
      `Generate a new secret for ${name}?`,
      `<p><b>${esc(name)}</b> will stop answering until the new secret is pasted into it as well. Renders will fall back to this machine's cards in the meantime.</p>`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Generate', class: 'primary', value: 1 },
      ],
    ))
  )
    return;
  try {
    const r = await jpost(`/satellites/${encodeURIComponent(name)}/secret`, {});
    await showSecret(name, r.secret);
  } catch (e) {}
  loadDevices();
}
// Save one typed-in satellite setting and report success as well as failure.
//
// 11.2 — `field` and `fallback` are parameters because the row now holds two of these boxes
// (the VRAM ceiling and the SillyTavern batch size) and they differ in nothing but which key
// they PUT and what to say when the server refuses the value. The server owns the range rules
// for both; this never second-guesses them, it only reports what came back.
/**
 * @param {string} name @param {string} field @param {HTMLInputElement} input
 * @param {HTMLButtonElement} btn @param {string} fallback
 */
async function satNumSave(name, field, input, btn, fallback) {
  const raw = String(input.value || '').trim();
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  /** @type {VEl} */ ($('satErr')).style.display = 'none';
  try {
    await jput(`/satellites/${encodeURIComponent(name)}`, { [field]: raw });
    // 🔴 RELOAD RATHER THAN REPAINT THE ROW. The satellite is only told the VRAM cap on the next
    // /load or /capacity, so the "in effect" badge beside that box is a fact about the OTHER
    // machine that this browser cannot compute — it has to come back from a health probe. (The
    // batch size needs no probe — Vocalis enforces it — but the reload is what redraws the row
    // from what the server actually stored, which is the only number worth showing.)
    btn.textContent = 'Saved';
    await loadDevices({ force: true });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = was;
    // ⚠️ `ErrLike|null` AND `?.`, BECAUSE THE OLD CODE GUARDED AND THIS MUST TOO. It read
    // `(e && e.body && e.body.error) || '...'`; a plain `(e).body` throws inside the catch when a
    // non-object is thrown, and that throw skips the `style.display = ''` two lines down, so the
    // user gets NO error rather than a wrong one. `catch` really does hand you `unknown`.
    const body = /** @type {ErrLike|null} */ (e)?.body;
    /** @type {VEl} */ ($('satErr')).textContent = (typeof body?.error === 'string' && body.error) || fallback;
    /** @type {VEl} */ ($('satErr')).style.display = '';
  }
}
/** @param {string} name */
async function satRemove(name) {
  if (
    !(await modal(
      `Remove ${name}?`,
      `<p>Its cards disappear from <b>Devices</b> and their worker settings are forgotten. Nothing on <b>${esc(name)}</b> itself is changed — stop it there when you're done with it.</p>`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Remove', class: 'danger', value: 1 },
      ],
    ))
  )
    return;
  try {
    await jdel(`/satellites/${encodeURIComponent(name)}`);
  } catch (e) {}
  loadDevices();
}
/** @param {string} name */
function satUploadCert(name) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.pem,.crt,.cer';
  // Sent as the raw BODY, not multipart. A PEM is a couple of kilobytes of text, and the
  // request.files path carries a blanket exemption from the 128 MB body cap that exists for
  // streaming audio to disk — see the route's own note.
  inp.onchange = async () => {
    const f = /** @type {FileList} */ (inp.files)[0];
    if (!f) return;
    const pem = await f.text();
    // Report successful storage and show the fingerprint so it can be compared with setup output.
    try {
      const r = await fetch(`/satellites/${encodeURIComponent(name)}/cert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-pem-file' },
        body: pem,
      });
      const b = await r.json();
      if (!r.ok)
        await modal('Certificate not accepted', `<p>${esc(b.error || 'unknown error')}</p>`, [{ label: 'OK', class: 'primary', value: 1 }]);
      else
        await modal(
          'Certificate pinned',
          `<p>Vocalis now trusts <b>${esc(name)}</b>'s certificate and will refuse any other one.</p>` +
            `<p class="small muted" style="margin-bottom:4px">Stored as <code>${esc(b.cert || '')}</code>. This is its SHA-256 — it should match ${DOCKER ? 'the fingerprint the satellite setup showed on that machine (its last page on Windows, or what <code>satellite-setup.sh</code> printed on Linux)' : 'what <code>setup.py</code> printed on that machine'}:</p>` +
            `<pre class="fp">${esc(b.fingerprint || '—')}</pre>`,
          [{ label: 'OK', class: 'primary', value: 1 }],
        );
    } catch (e) {
      await modal('Certificate not stored', `<p>${esc(String((e && /** @type {ErrLike} */ (e).message) || e))}</p>`, [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
    }
    loadDevices();
  };
  inp.click();
}
/**
 * One row of the PUT `/devices` sends — read back by field name at the mirror step below
 * (`d.enabled=r.enabled`, `d.uses=r.uses`), so the callback that builds it is cast rather than
 * left to inference (L5 — a dropped field here is the 7.5.10 `favorite` bug's shape).
 * @typedef {object} DeviceSaveRow
 * @property {string} id
 * @property {boolean} enabled
 * @property {Record<string, boolean>} uses
 */
async function saveDevices() {
  const els = [...document.querySelectorAll('#devList .dev')];
  const rows = els.map(
    /** @type {(el: Element) => DeviceSaveRow} */ (
      el => {
        // 7.6 — the row's own tick plus its indented per-subsystem ticks. The sub-list is a SIBLING
        // of `.dev` inside `.devwrap`, not a child: `.gpu` is `display:flex` and one row, so a block
        // nested inside it would land in that row rather than under it.
        //
        // ⚠️ Only boxes that are ON SCREEN are collected, and that is right — `useRow` renders only
        // what the device is `capable` of, so a key this device cannot run is never sent, and the
        // server drops it anyway (`subsystems.clean_uses`). Two layers agreeing is deliberate: the
        // server's is the one that must hold, the browser's is what keeps the payload honest.
        const wrap = el.closest('.devwrap');
        /** @type {Record<string, boolean>} */
        const uses = {};
        if (wrap)
          wrap.querySelectorAll('.usechk').forEach(c => {
            uses[/** @type {string} */ (/** @type {HTMLInputElement} */ (c).dataset.sub)] = /** @type {HTMLInputElement} */ (c).checked;
          });
        return {
          id: /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.id),
          enabled: /** @type {HTMLInputElement} */ (el.querySelector('.devchk')).checked,
          uses,
        };
      }
    ),
  );
  if (!rows.length) return;
  // From here until the PUT is answered (or the question below is canceled) a poll must not
  // repaint the list. A canceled or failed save re-reads the server, and that read is sent only
  // AFTER the count has dropped, so its answer is painted rather than thrown away with the rest.
  devSaving++;
  devSaveGen++;
  let reread = false;
  try {
    reread = await saveDeviceRows(rows);
  } finally {
    devSaving--;
  }
  if (reread) {
    // 🔴 AND THAT READ MUST BE DRAWN EVEN IF IT MATCHES THE LAST DRAWING. `renderDevices` leaves the
    // list alone when its html is unchanged, and after a Cancel it IS unchanged: the server still
    // has the card ticked, exactly as last painted. What differs is the box the user clicked,
    // which no html remembers. Without this the "Stop ACE-Step on these cards?" Cancel left the
    // card unticked on screen and enabled on the server (2026-10-12, found by
    // tests/devices_ui_smoke.mjs while the poll fix above was being tested).
    const list = $('devList');
    if (list && list.dataset) delete list.dataset.html;
    loadDevices({ force: true });
  }
}
/** The rest of `saveDevices`: ask about ACE-Step if needed, mirror the rows, PUT them.
 *  @param {DeviceSaveRow[]} rows
 *  @returns {Promise<boolean>} true when nothing was saved (canceled, or the PUT failed), so the
 *    panel must be re-read from the server. */
async function saveDeviceRows(rows) {
  /** @param {{enabled?: boolean, uses?: Record<string, boolean>}} d  A `DeviceRow` or a `DeviceSaveRow`. */
  const aceAllowed = d => d.enabled !== false && (!d.uses || d.uses.acestep !== false);
  // October 10, 2026: a row revokes ACE-Step only if that card could have been RUNNING it. The
  // server's `capable` list says so (a satellite's card is a Chatterbox render box and `cpu` runs
  // speech only), and an absent `uses.acestep` means "allowed", which is not "capable": without
  // this, unticking any satellite card raised "Stop ACE-Step on these cards?" for a card with no
  // ACE-Step to stop. A row with no `capable` list (an older payload) is judged by being local.
  /** @param {{capable?: string[], satellite?: string|null}} d */
  const couldRunAce = d => (Array.isArray(d.capable) ? d.capable.includes('acestep') : !d.satellite);
  const aceRevoked = rows.filter(next => {
    const previous = devs.rows.find(old => old.id === next.id);
    return previous && couldRunAce(previous) && aceAllowed(previous) && !aceAllowed(next);
  });
  if (aceRevoked.length) {
    const cards = aceRevoked.map(d => esc(d.id)).join(', ');
    const proceed = await modal(
      'Stop ACE-Step on these cards?',
      `<p>Saving this change stops the local ACE-Step child on ${cards}.</p>` +
        '<p>Any render already submitted to those cards ends when its child stops. Queued jobs ' +
        'for the disabled cards are canceled; work on other authorized cards can continue. ' +
        'Re-enabling a card does not restart ACE-Step or reload its model.</p>',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Save and stop', class: 'danger', value: 1 },
      ],
    );
    if (!proceed) {
      return true; // nothing was saved: the caller re-reads the server
    }
  }
  // Unticking every device is allowed; warn after saving and never revert the user's choice. This
  // also releases satellite VRAM without stopping the satellite.
  const nothingTicked = !rows.some(r => r.enabled);
  // Mirror the saved state back into devs.rows so a re-render (or the next satellite probe)
  // does not resurrect the values the user just changed.
  const wasNothingTicked = devs.rows.length && !devs.rows.some(d => d.enabled);
  // 7.6 — mirror `uses` too. Mirroring `enabled` alone would leave the next repaint (a 10 s
  // poll, or the CPU-banner re-render below) drawing the ticks from the pre-save snapshot and
  // visibly undoing the click that had in fact been saved.
  rows.forEach(r => {
    const d = devs.rows.find(x => x.id === r.id);
    if (d) {
      d.enabled = r.enabled;
      d.uses = r.uses;
    }
  });
  // Repaint ONLY when the CPU-fallback banner has to appear or disappear. A blanket re-render
  // here would replace the checkbox on every tick and throw focus to <body> — the poll's own
  // note explains why that matters — and this is the one state change the panel cannot show
  // without redrawing, because the banner is not part of any row.
  if (nothingTicked !== !!wasNothingTicked) setTimeout(renderDevices, 0);
  try {
    const r = await fetch('/devices', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices: rows }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'HTTP ' + r.status);
    }
    // Device selection can change local enhance availability. Refresh it before the CPU fallback
    // dialog so the page state is current when the dialog appears.
    // ⚠️ It is safe to call repeatedly: it only re-applies the tick DEFAULTS when availability
    // actually changed. See loadEnhanceInfo.
    await loadEnhanceInfo();
    // Save first, then explain the slower CPU fallback.
    if (nothingTicked)
      await modal(
        'Rendering on the CPU now',
        '<p>Nothing is ticked, so renders fall back to this machine&rsquo;s CPU. That is much ' +
          'slower than a card &mdash; fine for a short line, hours for a book.</p>' +
          '<p>Any satellite VRAM has been released. Tick a card again whenever you want the ' +
          'GPUs back.</p>',
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
  } catch (e) {
    // A save that did not land used to be invisible: the mirror above had already updated the
    // panel, so it showed settings the server never took. Say so, then re-read the truth.
    await modal('Devices not saved', `<p>${esc(String((e && /** @type {ErrLike} */ (e).message) || e))}</p>`, [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return true;
  }
  return false;
}
// Reapply the saved device selection to a satellite after it has restarted.
//
// 🔴 Save FIRST, and await it. The route applies what is SAVED, and clicking this button BLURS
// the worker box — which is what fires its `change` save, asynchronously. Without the await
// those two race and the satellite gets told the previous number, which is the same class of
// silent divergence the button exists to end.
/** @param {string} name @param {HTMLButtonElement} [btn] */
async function devReconnect(name, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    await saveDevices();
    const r = await fetch(`/satellites/${encodeURIComponent(name)}/reconnect`, { method: 'POST' });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || 'HTTP ' + r.status);
    // A satellite that is off is the normal steady state, not an error — but pressing ⟳ and
    // getting silence is indistinguishable from a no-op, which is the complaint the certificate
    // upload already earned. Say it did nothing, and why.
    if (!b.reachable)
      await modal(
        'Satellite not reachable',
        `<p><b>${esc(name)}</b> did not answer, so nothing was loaded.</p>` +
          '<p>Start the satellite on that machine, then press ⟳ again.</p>',
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
  } catch (e) {
    await modal('Reconnect failed', `<p>${esc(String((e && /** @type {ErrLike} */ (e).message) || e))}</p>`, [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⟳';
    }
    // force: a 10-second poll may well be in flight, and this is the read that has to land.
    loadDevices({ force: true });
  }
}
// ⚠️ THIS BLOCK SITS ABOVE `loadVoices` DELIBERATELY. `tests/voices_ui_smoke.mjs` slices this
// file from that function's definition to the `#devList` change listener and asserts the region
// is under 4,000 characters — its own comment says loadVoices is the LAST definition in the
// module and the delegated wiring is the first thing after it. Ninety lines dropped into that
// gap turn the slice into something meaningless, and it went red saying so.
//
// 🔴 AND THE NEEDLE IS NOT SPELLED OUT ABOVE, ON PURPOSE. Writing it here in prose is what
// broke the slice the SECOND time: `indexOf` has no idea it is inside a comment, so it matched
// this paragraph instead of the function and the region grew to include everything between.
// A scanner reads prose as code. Describe the needle; never quote it.

// — the tick-a-card warning (9.5-m3) —————————————
//
// 🔴 THIS IS THE MIRROR OF THE MODEL TABS' WARNING, NOT A SECOND FEATURE. `kobGpuWarnHtml` /
// `llaGpuWarnHtml` fire when you LOAD A MODEL with cards ticked; this fires when you TICK A CARD
// with a model loaded. One fact about one set of cards, asked from whichever side you arrive
// from — so there is no order of operations that reaches the bad state unwarned.
//
// This checkbox is the only switch for both directions. `/kobold/status` and `/llama/status` read
// `devices_warn_llm_loaded` for their `warn_gpus`, so unticking this silences the pair — and
// there is no longer a second switch that can disagree with it about one fact.
//
// 🔴 AND IT IS THE ONLY PLACE THIS IS ASKED. A device that is not ticked cannot be contended
// for, so the tick is the one moment that decides anything; asking again at render, enhance or
// voice-creation time would be N dialogs saying the same thing, N to keep consistent, every one
// of them firing long after the decision. Do not add another.
let devWarnLlm = true; // absent reads as ON, matching /settings/app's default on both sides

/** Paint the checkbox from /settings/app. Called by `loadAppSettings`.
 *  @param {any} s */
export function devRenderSettings(s) {
  // `!== false`, never `=== true`: app_settings.yaml written before 9.5 carries no key at all, and
  // reading it the other way round paints an unticked box over a server that warns anyway — a
  // control reporting the opposite of what the app does.
  devWarnLlm = s.devices_warn_llm_loaded !== false;
  const el = /** @type {HTMLInputElement|null} */ ($('devWarnLlm'));
  if (el) el.checked = devWarnLlm;
}

// Saved on the tick, like #logAnsi — one boolean, no Save button. The response is NOT fed
// back through a repaint; the only thing worth reacting to is a FAILURE, and then the box goes
// back rather than sitting there claiming a setting the server never took.
const devWarnEl = $('devWarnLlm');
if (devWarnEl)
  devWarnEl.addEventListener('change', async () => {
    const el = /** @type {HTMLInputElement} */ (devWarnEl),
      want = el.checked;
    try {
      await jput('/settings/app', { devices_warn_llm_loaded: want });
      devWarnLlm = want;
    } catch (e) {
      el.checked = !want;
      await modal('Could not save', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
  });

/**
 * Ask before ticking a card an LLM is already sitting on. `true` to go ahead.
 *
 * ⚠️ FAILS OPEN, DELIBERATELY. This decorates an action; it must never be able to prevent
 * one. If `/llm/holding` is down, slow or unhappy the tick proceeds exactly as it did before the
 * feature existed — a warning that can break the thing it warns about is worse than absent.
 *
 * ⚠️ AND IT NAMES WHAT IS HOLDING. "An LLM is loaded" is a sentence you can only act on by
 * going and looking; `llama.cpp - big-70b` is the thing to unload. The route sends the list for
 * exactly that reason rather than a boolean it had already decided.
 *
 * @param {string} id - the device being enabled, e.g. `cuda:0`
 */
async function okToEnable(id) {
  if (!devWarnLlm) return true;
  /** @type {{holding?: {engine: string, model: string}[], other_vram_gb?: number}} */
  let r;
  try {
    r = await jget('/llm/holding');
  } catch (e) {
    return true; // fail open
  }
  const held = (r && r.holding) || [];
  if (!held.length) return true;
  const rows = held.map(h => `<li><b>${esc(h.engine)}</b>${h.model ? ` — <code>${esc(h.model)}</code>` : ''}</li>`).join('');
  const much = /** @type {number} */ (r.other_vram_gb) > 0 ? ` holding <b>~${r.other_vram_gb} GB</b>` : '';
  return !!(await modal(
    'An LLM is holding the GPUs',
    `<div>${held.length === 1 ? 'A model is' : held.length + ' models are'} loaded on this box's cards${much}:</div>` +
      `<ul style="margin:6px 0 0 18px">${rows}</ul>` +
      `<div style="margin-top:8px">Ticking <code>${esc(id)}</code> makes Vocalis hold a copy of the speech model on it too, so both will be competing for the same memory — speech may be slower, and either side can run out.</div>` +
      `<div class="small muted" style="margin-top:8px">Unload it from the <b>LLM</b> tab first if you want the card to itself. You can turn this warning off below the device list — the same box also warns you the other way round, when you load a model with a device ticked.</div>`,
    [
      { label: 'Cancel', value: 0 },
      { label: 'Enable anyway', class: 'primary', value: 1 },
    ],
  ));
}

export async function loadVoices() {
  const vs = await jget('/voices');
  // Options DISPLAY the cosmetic label but their VALUE is always the immutable
  // filename — settings, clips, sidecars, and the Nomi map all key on it. Favorites float
  // to the top with a gold ⭐ on the text only; see voiceOrder/voiceOptText (§16.9).
  const opts =
    '<option value="">(model default)</option>' +
    voiceOrder(vs)
      .map(v => `<option value="${esc(v.name)}" title="${esc(v.name)}">${esc(voiceOptText(v))}</option>`)
      .join('');
  /** @type {VEl} */ ($('voice')).innerHTML = opts;
  /** @type {VEl} */ ($('pgVoice')).innerHTML = opts;
  // Await the restores: resumeRender() runs after loadVoices() and overwrites the knobs
  // with the LIVE job's params — an un-awaited voice-settings fetch landing later
  // would silently clobber them back to the voice's saved defaults.
  await Promise.all([restoreVoice('voice', 'vocalis-book-voice', BOOK_F), restoreVoice('pgVoice', 'vocalis-pg-voice', PG_F)]);
  return vs;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE DELEGATED WIRING. Verbatim from index.html, where it sat ~600 lines below the code it
// drives, between the KoboldCpp password controls and the UI-font slider — next to neither.
//
// ✅ Top-level in a module is the RIGHT place for it, not merely a legal one: a module body runs
// after the document is parsed, so `$('devList')` is guaranteed to find its element. Inline, these
// same lines ran mid-parse and only worked because the markup happened to be above them.
// One listener for the whole list — the rows are re-rendered whenever a satellite is added or
// probed, so per-row handlers would go stale.
/** @type {VEl} */ ($('devList')).addEventListener('change', async e => {
  if (/** @type {HTMLElement} */ (e.target).classList.contains('devchk')) {
    // 7.6 — show or hide the indented ticks on the CLICK, not on the save's round trip.
    // `saveDevices` only re-renders when the CPU-fallback banner has to appear or disappear
    // (see its note — a blanket repaint here would throw focus to <body> on every tick), so
    // without this line the sub-list would sit there stale until some later poll happened to
    // change the html. Doing it directly also survives a save that FAILS: the card is visibly
    // unticked either way, and the modal says the save did not land.
    const w = /** @type {HTMLElement} */ (e.target).closest('.devwrap'),
      u = /** @type {HTMLElement|null} */ (w && w.querySelector('.devuses'));
    if (u) u.hidden = !(/** @type {HTMLInputElement} */ (e.target).checked);
    // 🔴 ASK BEFORE THE SAVE, AND ONLY WHEN TURNING ONE ON. Unticking is how you GIVE the
    // memory back, so it never asks — and `saveDevices`'s own note is emphatic that unticking
    // must never be blocked or reverted. On a Cancel the tick goes back, because Cancel here
    // means "I did not want to enable it", which is the state it was already in.
    const chk = /** @type {HTMLInputElement} */ (e.target);
    if (
      chk.checked &&
      !(await okToEnable(/** @type {string} */ (chk.closest('.dev') && /** @type {HTMLElement} */ (chk.closest('.dev')).dataset.id)))
    ) {
      chk.checked = false;
      const w2 = /** @type {HTMLElement} */ (chk.closest('.devwrap')),
        u2 = /** @type {HTMLElement|null} */ (w2 && w2.querySelector('.devuses'));
      if (u2) u2.hidden = true;
      return;
    }
    saveDevices();
  } else if (/** @type {HTMLElement} */ (e.target).classList.contains('usechk')) saveDevices();
});
// `Element|EventTarget|null -> whatever the callee declares`, the L4 two-step
// (dom-permissive.d.ts's own header): every delegated handler below reaches its target through
// `e.target`/`closest`/`querySelector`, and `satNumSave`/`devReconnect` name the concrete
// `HTMLInputElement`/`HTMLButtonElement` they need — the DOM cannot prove either from an
// `EventTarget`, so `T` is inferred from the parameter it is being passed to.
/** @template {Element} T @param {Element|EventTarget|null} [el] @returns {T} */
const asEl = el => /** @type {T} */ (/** @type {unknown} */ (el));
// Delegated for the same reason, and it must be: ⟳ re-renders the very list it was clicked in.
/** @type {VEl} */ ($('devList')).addEventListener('click', e => {
  const b = /** @type {HTMLButtonElement|null} */ (
    /** @type {HTMLElement} */ (e.target).closest && /** @type {HTMLElement} */ (e.target).closest('.devSync')
  );
  if (b && !b.disabled) devReconnect(/** @type {string} */ (b.dataset.sat), b);
});
// Delegated for the same reason: every satellite action re-renders the list it was clicked in.
/** @type {VEl} */ ($('satList')).addEventListener('click', e => {
  const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.satrow'));
  if (!row) return;
  const n = /** @type {string} */ (row.dataset.name);
  if (/** @type {HTMLElement} */ (e.target).classList.contains('satDel')) satRemove(n);
  else if (/** @type {HTMLElement} */ (e.target).classList.contains('satRot')) satRotate(n);
  else if (/** @type {HTMLElement} */ (e.target).classList.contains('satCert')) satUploadCert(n);
  else if (/** @type {HTMLElement} */ (e.target).classList.contains('satCapSave'))
    satNumSave(n, 'vram_cap_gb', asEl(row.querySelector('.satCap')), asEl(e.target), 'That VRAM cap was not accepted.');
  else if (/** @type {HTMLElement} */ (e.target).classList.contains('satStBatchSave'))
    satNumSave(n, 'st_max_batch', asEl(row.querySelector('.satStBatch')), asEl(e.target), 'That batch size was not accepted.');
});
// Enter in the box saves it. ⚠️ Delegated on the LIST, not bound per input: `renderSats` replaces
// this HTML on every 10 s poll, so a listener attached to the input dies with it — silently, and
// only after the poll nobody was watching for.
/** @type {VEl} */ ($('satList')).addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const cls = /** @type {HTMLElement} */ (e.target).classList;
  // 11.2 — which box he was in decides which field is saved. Keyed off the input's own class
  // rather than a second listener, because the reason this one is delegated at all (`renderSats`
  // replaces the HTML every poll, taking any per-input listener with it) applies identically.
  const isCap = cls.contains('satCap'),
    isBatch = cls.contains('satStBatch');
  if (!isCap && !isBatch) return;
  const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.satrow'));
  if (!row) return;
  e.preventDefault();
  if (isCap)
    satNumSave(
      /** @type {string} */ (row.dataset.name),
      'vram_cap_gb',
      asEl(e.target),
      asEl(row.querySelector('.satCapSave')),
      'That VRAM cap was not accepted.',
    );
  else
    satNumSave(
      /** @type {string} */ (row.dataset.name),
      'st_max_batch',
      asEl(e.target),
      asEl(row.querySelector('.satStBatchSave')),
      'That batch size was not accepted.',
    );
});
// 🔴 The button has to WAIT for a poll that is already out, not return instantly. loadDevices()
// bails immediately while devBusy is set, so pressing Check now during a poll used to flash
// "Checking…" for a few milliseconds and refresh nothing. Against a satellite that is down each
// poll holds devBusy for ~5 s of every 10, so that was a coin flip, and it is exactly when the
// button gets pressed. `force` retries until the in-flight poll releases.
/** @type {VEl} */ ($('devRefresh')).addEventListener('click', async () => {
  const b = /** @type {HTMLButtonElement} */ ($('devRefresh')),
    was = b.textContent;
  b.textContent = 'Checking…';
  b.disabled = true;
  try {
    await loadDevices({ force: true });
  } finally {
    b.textContent = was;
    b.disabled = false;
  }
});
/** @type {VEl} */ ($('satAdd')).addEventListener('click', satAdd);
/** @type {VEl} */ ($('satUrl')).addEventListener('keydown', e => {
  if (e.key === 'Enter') satAdd();
});

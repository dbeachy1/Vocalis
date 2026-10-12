// Playground rendering, job progress, and clip-library interactions.
// Shared job/library state lives in pgstate.js so sibling UI modules can access it without globals.
// Cross-module callbacks run at call time; keep dependency changes compatible with the bundle order.

import { $, esc } from '../util/dom.js';
import { UIS } from '../util/uistate.js';
import { state } from '../util/appstate.js';
import { jget, jpost, isHttpError, fetchUnlocked } from '../util/http.js';
import { fmtDate, fmtDur, fmtEta, fmtSize } from '../util/fmt.js';
import { filtNone, filtQ, filtRows } from '../util/filter.js';
// 8.9 — virtual folders. Scope `playground_clips`: this list alone. 🔴 The ref MOVES on a
// rename (`rename_clip` rebuilds the stem from `safe_name`), so the scope is in
// `folders.RENAME_MOVES_REF` and its rename route carries the assignment across.
import {
  folderRows,
  folderPage,
  folderBarRow,
  folderGapRow,
  folderTag,
  folderWire,
  folderWireDrag,
  folderAddButton,
  loadFolders,
} from '../ui/folders.js';
import { modal } from '../ui/modal.js';
import { switchTab } from '../ui/tabswitch.js';
import { stepVoice } from '../ui/voicepicker.js';
import { renderStrip } from '../sys/hwstrip.js';
// Both symbols are used while rendering library rows and enhancement progress.
import { ETA_UNKNOWN, badgeLine, bandPill, enh, enhBtn, enhEta, pgUpdateEnh, sizeTip } from '../sys/enhance.js';
import { AUDITION_TEXT, bookUpdateAudition, hideAudio, pgTakeMatch, pgUpdateAudition, pgUpdateTake } from '../ui/audition.js';
import { PG_F, curParams, saveVoiceSettings } from '../voice/params.js';
import { logInto } from '../ui/log.js';
import { spLoadAll } from '../media/speech.js';
import { switchStudioPanel } from '../media/studio-tabs.js';

// Keep log output scoped to the originating tab; book jobs import this sink when needed.
/**
 * @param {string} html
 * @param {string} [cls]
 */
export function pgLogLine(html, cls) {
  logInto(/** @type {VEl} */ ($('pgLog')), html, cls, true);
}
// Which clip a line belongs to. Two enhancements can run at once (one card each), and they
// narrate into the same Playground log — untagged, the two interleave into nonsense.
/** @param {string} name */
export const pgEnhTag = name => `<b>${esc(name)}</b> · `;
import { scCopyClip } from '../scenes/scenes.js';
import { onPgEdited, onPgLibLoad, pgClipUrl, pgElapsed, pgLib, pgStartNow, pgStartSet } from './pgstate.js';
/** @typedef {import('./pgstate.js').PgClip} PgClip */
/** @typedef {import('../sys/enhance.js').EnhRow} EnhRow */
/**
 * `GET /playground/enhance/<job_id>` — `playground_enhance_status` in `src/vocalis/web/playground.py`.
 * Response fields returned by the enhancement-status endpoint.
 * @typedef {object} PgEnhStatus
 * @property {string} status - 'queued'|'running'|'done'|'failed'|'canceled'.
 * @property {string|null} error
 * @property {string|null} ref - the clip's NEW ref once it lands (its identity changes with it).
 * @property {string} line - the last log line, for a poller that wants to show progress text.
 */

// Render jobs stream progress and can be canceled or resumed. Finished clips persist at
// output/playground/<voice>/; the status strip updates while a chunk is running.
/** @type {string|null} */
let pgStripCtx = null;
/** @type {ReturnType<typeof setInterval>|null} */
let pgStripTimer = null;
function pgStripPaint() {
  if (pgStripCtx == null) return;
  /** @type {VEl} */ ($('pgStrip')).innerHTML =
    `${esc(pgStripCtx)} · elapsed ${pgElapsed()} <span class="spin" style="margin:0 0 0 2px"></span>`;
}
/** @param {string} ctx */
function pgStripLive(ctx) {
  pgStripCtx = ctx;
  pgStripPaint();
}
/** @param {string} text */
function pgStripStatic(text) {
  pgStripCtx = null;
  /** @type {VEl} */ ($('pgStrip')).textContent = text;
}
/** @param {PgClip} c @returns {string} */
function pgAudioUrl(c) {
  return c.kind === 'partial' ? '/playground/partials/' + encodeURIComponent(c.ref) + '/audio' : pgClipUrl(c.ref);
}
// A loaded partial arms Generate as "Continue" — any edit to the text or settings disarms it
// (an edit changes the identity, so "continue" would be a lie).
//
// The label communicates the resume position; edits disarm continuation because they change render identity.
/** @param {PgClip} c */
function pgArmResume(c) {
  state.pgResume = c.ref;
  /** @type {VEl} */ ($('pgGen')).textContent = `▶ Continue render (${c.done}/${c.total ?? '?'})`;
}
function pgDisarmResume() {
  if (!state.pgResume) return;
  state.pgResume = null;
  /** @type {VEl} */ ($('pgGen')).textContent = '▶ Generate';
}
export function pgEdited() {
  pgDisarmResume();
  pgUpdateAudition();
  pgUpdateTake();
}
// 7.5.6 — hand it to the leaf so js/sys/enhance.js can fire it without importing this file. See
// pgstate.js's note: that import was one strand of the module cycle the bundle exposed.
onPgEdited(pgEdited);
for (const id of ['pgText', 'pgVoice', 'pgExag', 'pgCfg', 'pgTemp', 'pgActions']) {
  /** @type {VEl} */ ($(id)).addEventListener('input', pgEdited);
  /** @type {VEl} */ ($(id)).addEventListener('change', pgEdited);
}
// Save editor text on blur as account state, independent of voice settings. UIS storage is scoped to
// the account; localStorage remains limited to theme and volume so it can survive a vault lock.
function pgSaveText() {
  try {
    UIS.setItem('vocalis-pg-text', /** @type {HTMLTextAreaElement} */ ($('pgText')).value);
  } catch (e) {}
}
/** @type {VEl} */ ($('pgText')).addEventListener('blur', pgSaveText);
// ◀ ▶ page through voices without opening the dropdown — the synthetic change event
// runs the full voice-switch path (settings load, cached-audition player, resume disarm).
// Dispatch the normal voice-change path so settings, audition, and resume state stay synchronized.
/** @type {VEl} */ ($('pgStreamOut')).addEventListener('volumechange', () => {
  try {
    localStorage.setItem('vocalis-vol', String(/** @type {HTMLAudioElement} */ ($('pgStreamOut')).volume));
  } catch (e) {}
}); // .volume is a number; setItem stringifies either way
/** @type {VEl} */ ($('pgVoicePrev')).onclick = () => stepVoice('pgVoice', -1);
/** @type {VEl} */ ($('pgVoiceNext')).onclick = () => stepVoice('pgVoice', 1);
/** @type {VEl} */ ($('voicePrev')).onclick = () => stepVoice('voice', -1);
/** @type {VEl} */ ($('voiceNext')).onclick = () => stepVoice('voice', 1);
// Book param edits re-evaluate the cached-audition player, like the Playground's.
for (const id of ['exag', 'cfg', 'temp']) {
  /** @type {VEl} */ ($(id)).addEventListener('input', () => bookUpdateAudition());
  /** @type {VEl} */ ($(id)).addEventListener('change', () => bookUpdateAudition());
}
// Narrate-*actions* survives a reload (default on). One setter so clip-loads and
// resume keep the stored preference in sync with what's shown.
/** @param {boolean} v */
export function setPgActions(v) {
  /** @type {HTMLInputElement} */ ($('pgActions')).checked = v;
  try {
    UIS.setItem('vocalis-pg-actions', v ? '1' : '0');
  } catch (e) {}
}
/** @type {VEl} */ ($('pgActions')).addEventListener('change', e => setPgActions(/** @type {HTMLInputElement} */ (e.target).checked));
try {
  /** @type {HTMLInputElement} */ ($('pgActions')).checked = UIS.getItem('vocalis-pg-actions') !== '0';
} catch (e) {}
// Restore the remembered editor text, falling back to the shared audition prompt.
try {
  /** @type {HTMLTextAreaElement} */ ($('pgText')).value = UIS.getItem('vocalis-pg-text') || AUDITION_TEXT;
} catch (e) {
  /** @type {HTMLTextAreaElement} */ ($('pgText')).value = AUDITION_TEXT;
}
/** @param {string} ref */
function pgShowClip(ref) {
  // Playback lives in the "existing take" player next to Generate (input-match —
  // it now matches the clip that just finished); this is just the download.
  const u = pgClipUrl(ref);
  /** @type {VEl} */ ($('pgOut')).innerHTML = `<a class="dlbtn" style="margin-left:0" href="${u}?download=1">⬇ Download</a>`;
}
/** @param {boolean} r */
export function pgSetRunning(r) {
  state.pgRunning = r;
  /** @type {VEl} */ ($('pgGen')).style.display = r ? 'none' : 'inline-block';
  /** @type {VEl} */ ($('pgCancel')).style.display = r ? 'inline-block' : 'none';
  pgSyncGen();
  if (r) {
    /** @type {HTMLButtonElement} */ ($('pgCancel')).disabled = false;
    /** @type {VEl} */ ($('pgCancel')).innerHTML = '■ Cancel';
    if (!pgStripTimer) pgStripTimer = setInterval(pgStripPaint, 1000);
  } else if (pgStripTimer) {
    clearInterval(pgStripTimer);
    pgStripTimer = null;
  }
}
// A render needs EVERY card and an enhancement is holding one, so the server would queue the
// render behind it — silently, for as long as the enhancement runs. Rather than let Generate
// sit there looking instant, it is disabled and says what it's waiting for. It does NOT turn
// into a Cancel any more: an enhancement takes ONE card, so two of them run side by side on
// a two-card box (4.1-M16), and there is no single job for one shared button to point at.
// Each one's ■ lives in the library row that started it.
//
// Enhance-on-render is part of the clip's IDENTITY — it decides which file the render writes
// — so it is fixed at Generate and cannot be toggled mid-flight. (The 60-minute cap is not:
// that is a decision about how MUCH audio to make, and the moment you want to make it is
// usually ten minutes in. So the cap deliberately stays live.)
function pgSyncGen() {
  const n = state.pgEnh.size;
  /** @type {HTMLInputElement} */ ($('pgEnh')).disabled = !!n || state.pgRunning || !enh.ok;
  if (state.pgRunning) return; // the render owns the button while it runs
  /** @type {HTMLButtonElement} */ ($('pgGen')).disabled = !!n;
  /** @type {VEl} */ ($('pgGen')).title = n
    ? `${n === 1 ? 'An enhancement is' : n + ' enhancements are'} using the GPUs — a ` +
      `render needs every card. Cancel ${n === 1 ? 'it' : 'them'} in the library below, or wait.`
    : '';
}
/**
 * @param {string} ref
 * @param {string|null} jid - null STOPS the row's enhancement (the poll loop's terminal branch);
 *   a real job id starts it.
 * @param {string} [name]
 */
function pgSetEnhancing(ref, jid, name) {
  if (jid) state.pgEnh.set(ref, { jid, name: name || '' });
  else state.pgEnh.delete(ref);
  pgSyncGen();
  renderPgLib();
} // the rows own the ■ buttons
// How much audio this render has actually produced. Chunks are not minutes — they run from
// a clause to 400 characters — so without this the only honest answer to "how long is this
// getting?" arrives when it finishes, which is after the moment you'd have capped it.
/** @param {number} s */
export function pgSetAudio(s) {
  state.pgAudioS = s || 0;
  const el = /** @type {VEl} */ ($('pgAudio'));
  if (!state.pgRunning && !s) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const over = state.pgAudioS >= enh.cap;
  // The cap suffix describes a render IN FLIGHT. With nothing running, this number is the
  // LAST render's total, sitting above the last render's log — and ticking the box would
  // staple "stopping at the next chunk boundary" onto a clip that finished minutes ago, even one
  // whose text has since been replaced from the library. Idle, the tick
  // is a setting for the NEXT render and says nothing about this number. The finished log
  // is kept: it is the last status, and the only record of what just happened.
  el.innerHTML =
    `<b>${fmtDur(state.pgAudioS)}</b> of audio so far` +
    (state.pgRunning && /** @type {HTMLInputElement} */ ($('pgCap')).checked
      ? ` <span style="color:var(--warn)">— ${
          over ? 'over 60 minutes: stopping at the next chunk boundary' : 'stopping at 60 minutes'
        }</span>`
      : '');
}
/** @type {VEl} */ ($('pgCap')).addEventListener('change', async e => {
  const on = /** @type {HTMLInputElement} */ (e.target).checked;
  try {
    UIS.setItem('vocalis-pg-cap', on ? '1' : '0');
  } catch (x) {}
  if (!state.pgRunning || !state.pgJobId) {
    pgSetAudio(state.pgAudioS);
    return;
  } // nothing running: it just ticks
  // Unticking mid-render is not destructive — it only lets the render run on. No dialog.
  if (!on) {
    try {
      await jpost('/playground/cap', { job_id: state.pgJobId, cap: false });
    } catch (err) {}
    pgSetAudio(state.pgAudioS);
    return;
  }
  // Ticking it mid-render IS destructive: it truncates the render. Say so, and say it
  // differently when the render is already past the cap — "capping" cannot un-render what
  // is already made, and pretending otherwise would be the lie.
  const mins = Math.floor(state.pgAudioS / 60);
  const past = state.pgAudioS >= enh.cap;
  const ok = await modal(
    'Stop this render at 60 minutes?',
    past
      ? `This render has already produced <b>${mins} minutes</b> of audio. Capping now stops it at the <b>next chunk boundary</b> — it can't unmake what's already rendered, so the clip will be a little over an hour.<br><br>The clip is <b>saved</b>, not canceled.`
      : `The render will stop once it reaches <b>60 minutes</b> of audio (it's at ${mins} min) and save what it has as a <b>finished clip</b>.<br><br>The rest of the text won't be rendered. This is a truncation, not a cancel.`,
    [
      { label: 'Cancel', value: 0 },
      { label: past ? 'Stop at the next chunk' : 'Cap at 60 minutes', class: 'primary', value: 1 },
    ],
  );
  if (!ok) {
    /** @type {HTMLInputElement} */ (e.target).checked = false;
    pgSetAudio(state.pgAudioS);
    return;
  }
  try {
    await jpost('/playground/cap', { job_id: state.pgJobId, cap: true });
  } catch (err) {
    /** @type {HTMLInputElement} */ (e.target).checked = false;
    await modal('Could not cap the render', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
  pgSetAudio(state.pgAudioS);
});
try {
  /** @type {HTMLInputElement} */ ($('pgCap')).checked = UIS.getItem('vocalis-pg-cap') === '1';
} catch (e) {} // default OFF: it truncates
function pgEndJob() {
  pgSetRunning(false);
  if (state.pgEs) {
    state.pgEs.close();
    state.pgEs = null;
  }
}
function pgStreamDone() {
  // PLAYBACK is over (ended/stopped/failed) — the render's end is job_done
  if (state.pgStream) {
    try {
      state.pgStream.stop();
    } catch (e) {}
  }
  state.pgStream = null;
  /** @type {VEl} */ ($('pgStreamOut')).style.display = 'none';
  pgUpdateTake();
}
/**
 * One `/book/events/<id>` SSE payload for a Playground job — `pool.run_chunks`'s `on_event`
 * forwarded verbatim through `emit(job, ev)`, so `chunk_start`/`chunk_done`/`device_dropped`/
 * `chunk_failed` carry exactly the shape `tts_utils.py`'s batch runner builds (shared with
 * `book/job.js`'s own event handler — same wire, two job kinds). A discriminated union on
 * `type` rather than one all-optional bag: it lets each `case` below narrow `ev` for free.
 * @typedef {{type:'job_start', id?:string, kind?:string}} PgEvJobStart
 * @typedef {{type:'vram'} & import('../sys/hwstrip.js').StripSample} PgEvVram
 * @typedef {{type:'audio', seconds:number}} PgEvAudio
 * @typedef {{type:'log', line:string}} PgEvLog
 * @typedef {{type:'chunk_start', chunk:number, total:number, device:string}} PgEvChunkStart
 * @typedef {{type:'chunk_done', chunk:number, total:number, device:string, preview:string,
 *   stats:{s:number,cps:number,tokens:number,pct:number,mark:string,render:number}}} PgEvChunkDone
 * @typedef {{type:'device_dropped', device:string, chunk:number, reason:string, message:string}} PgEvDeviceDropped
 * @typedef {{type:'chunk_failed', device:string, chunk:number, reason:string, message:string}} PgEvChunkFailed
 * @typedef {{type:'job_done', clip:string, duration_s:number}} PgEvJobDone
 * @typedef {{type:'canceled'}} PgEvCanceled
 * @typedef {{type:'error', message:string}} PgEvError
 * @typedef {PgEvJobStart|PgEvVram|PgEvAudio|PgEvLog|PgEvChunkStart|PgEvChunkDone|
 *   PgEvDeviceDropped|PgEvChunkFailed|PgEvJobDone|PgEvCanceled|PgEvError} PgEvent
 */

/** @param {string} id */
export function pgOpenStream(id) {
  const es = new EventSource('/book/events/' + id);
  state.pgEs = es;
  es.onmessage = ev => pgHandleEvent(JSON.parse(ev.data));
  es.onerror = async () => {
    if (state.pgEs !== es) return;
    try {
      const s = await jget('/book/status/' + id);
      if (['done', 'failed', 'canceled'].includes(s.status)) {
        pgLogLine('Connection closed — job ' + s.status + '.', 'muted');
        pgEndJob();
      }
    } catch (e) {
      pgLogLine('Connection lost — job no longer available.', 'drop');
      pgEndJob();
    }
  };
}
/** @param {PgEvent} ev */
function pgHandleEvent(ev) {
  switch (ev.type) {
    case 'job_start':
      if (!pgStartNow()) pgStartSet(Date.now());
      if (pgStripCtx == null) pgStripLive('rendering');
      break;
    case 'vram':
      renderStrip(ev);
      break; // the whole strip — see handleEvent
    case 'audio':
      pgSetAudio(ev.seconds);
      break; // the running duration counter
    case 'log':
      pgLogLine(esc(ev.line), 'muted');
      break;
    case 'chunk_start':
      pgStripLive(`chunk ${ev.chunk + 1}/${ev.total} on ${ev.device}`);
      break;
    case 'chunk_done': {
      const s = ev.stats;
      pgLogLine(
        `<span class="dev">[${esc(ev.device)}]</span> chunk [${ev.chunk + 1}/${ev.total}] ${esc(ev.preview)}\n  <span class="stat">${s.s}s  ${s.cps} c/s  |  ${s.tokens} tok  ${s.pct}% ${esc(s.mark)}  |  ${s.render}x</span>`,
      );
      break;
    }
    case 'device_dropped':
      pgLogLine(`<span class="drop">[${esc(ev.device)}] dropped (${esc(ev.reason)}) chunk ${ev.chunk + 1} — reassigned</span>`);
      break;
    case 'chunk_failed':
      pgLogLine(
        `<span class="drop">[${esc(ev.device)}] chunk ${ev.chunk + 1} FAILED (${esc(ev.reason)}) — ${esc(ev.message || '')}</span>`,
      );
      break;
    case 'job_done':
      pgStripStatic(`✓ done — ${fmtDur(ev.duration_s)} · elapsed ${pgElapsed()}`);
      pgLogLine(`\n✓ Clip ready — ${fmtDur(ev.duration_s)}`);
      pgShowClip(ev.clip);
      // NB: the RENDER is done but PLAYBACK usually isn't — the stream player stays
      // up (with its controls) until the audio ends; pgStreamDone() fires then.
      pgEndJob();
      loadPgLib();
      break;
    case 'canceled':
      pgStripStatic('■ canceled');
      pgStreamDone();
      pgLogLine('\n■ Canceled — progress kept; the same settings resume here.', 'muted');
      pgEndJob();
      loadPgLib();
      break;
    case 'error':
      pgStripStatic('✗ failed');
      pgStreamDone();
      pgLogLine(`\n✗ ERROR: ${esc(ev.message)}`, 'drop');
      pgEndJob();
      break;
  }
}
// Choosing a .txt/.md loads it straight into the text box (read in-browser, instantly) —
// the textarea is the single source of truth for Generate. The old behavior silently
// sent the picked file INSTEAD of the visible text, with no feedback at all.
// Strict UTF-8 first; a decode error means a legacy Word/Notepad export (cp1252),
// where em-dashes and curly quotes otherwise turn into � replacement characters.
/** @param {File} f */
async function readTextFile(f) {
  const buf = await f.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return new TextDecoder('windows-1252').decode(buf);
  }
}
/** @type {VEl} */ ($('pgFile')).addEventListener('change', async e => {
  const f = /** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files)[0];
  if (!f) return;
  if (!/\.(txt|md)$/i.test(f.name)) {
    await modal('Wrong file type', 'Playground accepts .txt or .md — books belong on the Book tab.', [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    /** @type {HTMLInputElement} */ (e.target).value = '';
    /** @type {VEl} */ ($('pgFileName')).textContent = '';
    return;
  }
  const text = await readTextFile(f);
  /** @type {HTMLTextAreaElement} */ ($('pgText')).value = text;
  pgSaveText();
  /** @type {HTMLInputElement} */ (e.target).value = ''; // cleared so re-choosing the same file works; we show the name ourselves
  /** @type {VEl} */ ($('pgFileName')).textContent = `${f.name} · ${text.length.toLocaleString()} chars`;
  pgEdited(); // programmatic text change: no input event fires, so
  // re-evaluate the existing-take/audition match ourselves
  pgLogLine(`Loaded ${esc(f.name)} into the text box (${text.length.toLocaleString()} chars).`, 'muted');
});
/** @type {VEl} */ ($('pgGen')).onclick = async () => {
  // SAME INPUTS = SAME CLIP, AND GENERATE REPLACES IT. That is deliberate and it stays
  // (4.0, when seeds were removed: identity is text+voice+knobs, and Generate's contract is
  // "give me a fresh take"). But rendering is SEEDLESS — the new take is a different
  // performance, not the same one again — so the take on disk does not come back. Rendering
  // replaces the prior take silently; retain that behavior but make the replacement explicit.
  //
  // pgTakeMatch() is the SAME identity the server hashes (text, voice, exaggeration, cfg,
  // temperature, narrate-actions, enhance), so this warns exactly when it will overwrite —
  // never on a new clip, and never on a partial (those RESUME, they don't replace).
  // 🔴 CAST, NOT A NARROWER READ: `pgTakeMatch()`'s declared return is `ui/audition.js`'s local
  // `ClipLite`, which carries only the fields THAT file needs (`ref`/`kind`/`text`/… — see its
  // header). It omits `name`/`duration_s`/`voice_label`, which this call site does need — the
  // object handed back is a real `PgClip` (straight out of `pgLib.items`), `ClipLite` is just a
  // narrower view of the same row. Reported: `ClipLite` should carry every field either file reads.
  const clash = /** @type {PgClip|null} */ (pgTakeMatch());
  if (clash) {
    const ok = await modal(
      'Replace the take you already have?',
      `<b>“${esc(clash.name)}”</b> — ${fmtDur(clash.duration_s)} · ${esc(clash.voice_label || 'default')}` +
        `<div style="margin-top:8px">These exact settings already have a take. Generating renders a <b>new performance</b> and <b>replaces</b> it — you won't get this one back.</div>` +
        `<div class="muted" style="margin-top:8px">To keep it: change the text or a setting, or press ▶ to play it without re-rendering.</div>`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Replace', class: 'danger', value: 1 },
      ],
    );
    if (!ok) return;
  }
  saveVoiceSettings(/** @type {HTMLSelectElement} */ ($('pgVoice')).value, curParams(PG_F), PG_F.ctx);
  pgDisarmResume(); // the label was informational — the server resumes by identity anyway
  /** @type {HTMLButtonElement} */ ($('pgGen')).disabled = true;
  /** @type {VEl} */ ($('pgGen')).textContent = 'Starting…';
  /** @type {VEl} */ ($('pgOut')).innerHTML = '';
  try {
    pgSaveText(); // generated text becomes the default next visit (blur usually beat us to it)
    pgSetAudio(0);
    const body = {
      text: /** @type {HTMLTextAreaElement} */ ($('pgText')).value,
      voice: /** @type {HTMLSelectElement} */ ($('pgVoice')).value,
      exaggeration: +(/** @type {HTMLInputElement} */ ($('pgExag')).value),
      cfg: +(/** @type {HTMLInputElement} */ ($('pgCfg')).value),
      temperature: +(/** @type {HTMLInputElement} */ ($('pgTemp')).value),
      narrate_actions: /** @type {HTMLInputElement} */ ($('pgActions')).checked,
      enhance: enh.ok && /** @type {HTMLInputElement} */ ($('pgEnh')).checked,
      nfe: enh.def,
      cap60: /** @type {HTMLInputElement} */ ($('pgCap')).checked,
    };
    // Streaming (3.x): audio starts in seconds and each finished chunk banks to
    // disk (Stop/crash resumes). Generate ALWAYS renders a fresh take and
    // overwrites the stored one for these inputs (seedless identity) — the little
    // player by this button plays the existing take without re-rendering.
    const r = await jpost('/playground/stream', body);
    pgStartSet(0);
    state.pgJobId = r.job_id;
    /** @type {VEl} */ ($('pgLog')).innerHTML = '';
    // Visible player (3.1): native volume/pause/scrub over the live stream; the
    // seek range grows as chunks land. A RESUME plays a short lead-in of the last
    // already-rendered audio (the server caps the replay) and flows into the live
    // render — it does NOT re-stream the whole banked prefix (that idled the GPUs),
    // so playback starts from 0, not a far seek point.
    const sEl = /** @type {HTMLAudioElement} */ ($('pgStreamOut')),
      startAt = 0;
    hideAudio(/** @type {VEl} */ ($('pgTakeOut')));
    sEl.style.display = ''; // stop a playing take before the stream takes the slot
    try {
      sEl.volume = +(localStorage.getItem('vocalis-vol') || 1);
    } catch (e) {}
    pgLogLine(
      'Starting stream…' +
        (r.resume_s ? ` (resuming — ${fmtDur(r.resume_s)} already rendered; replaying a short lead-in, then rendering the rest live)` : ''),
      'muted',
    );
    pgSetRunning(true);
    pgOpenStream(r.job_id);
    state.pgStream = VocalisStreamPlayer.play({
      streamUrl: r.stream_url,
      statusUrl: r.status_url,
      audioEl: sEl,
      startAt,
      onPlaying: () => {
        pgStripLive('♪ streaming… (each finished chunk is saved — Cancel stops the render, pause is yours)');
      },
      onEnded: () => {
        pgStreamDone();
      },
      onError: m => {
        pgStreamDone();
        pgLogLine('stream error: ' + esc(m), 'drop');
      }, // job status/SSE carries the real outcome
      onTruncated: () => {
        pgStreamDone();
        pgLogLine('stream ended early — the log above has the reason; progress is kept.', 'drop');
      },
    });
  } catch (e) {
    await modal('Generation failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    /** @type {VEl} */ ($('pgGen')).textContent = '▶ Generate';
    pgSyncGen();
  }
}; // NOT disabled=false: an enhancement may still hold a card
/** @type {VEl} */ ($('pgCancel')).onclick = async () => {
  const b = /** @type {HTMLButtonElement} */ ($('pgCancel'));
  if (!state.pgJobId) return; // enhancements cancel from their own row now
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>Canceling…';
  pgStreamDone(); // aborts the stream fetch -> server cancels + keeps banked chunks
  try {
    await jpost('/book/cancel/' + state.pgJobId, {});
  } catch (e) {
    // also flips the shared cancel Event (covers a stream that never started)
    pgLogLine('Cancel failed — ' + esc(/** @type {ErrLike} */ (e).message), 'drop');
    b.disabled = false;
    b.innerHTML = '■ Cancel';
  }
};

// ── Playground library panel (2.3-M4): search / sort / page / multi-delete ──
export async function loadPgLib() {
  try {
    pgLib.items = await jget('/playground/clips');
  } catch (e) {
    pgLib.items = [];
  }
  for (const r of [...pgLib.sel]) if (!pgLib.items.some(c => c.ref === r)) pgLib.sel.delete(r); // drop stale selections
  await loadFolders(PG_SCOPE); // 8.9 — names + order; the rows arrive already stamped
  renderPgLib();
  pgUpdateAudition();
  bookUpdateAudition();
  pgUpdateTake();
}
onPgLibLoad(loadPgLib); // 7.5.6 — see pgstate.js: outside pg/, this is reached as `pgLibLoad()`
function pgFiltered() {
  // On the shared matcher now, which also upgrades this box from ONE substring to EVERY word
  // in any order — "sample voice" finds a clip that "samplevoice" never would.
  let a = filtRows('pgSearch', pgLib.items, c => `${c.name} ${c.voice_label} ${c.voice} ${c.text}`);
  if (/** @type {HTMLInputElement} */ ($('pgPartialsOnly')).checked) a = a.filter(c => c.kind === 'partial');
  if (/** @type {HTMLInputElement} */ ($('pgFavsOnly')).checked) a = a.filter(c => c.favorite);
  // 6.0 §7.1 — three-state, and it COMPOSES with the selection, which is the point: filter to
  // "not enhanced", select all, then Delete selected or ⬇ Download selected. That is the whole
  // cleanup workflow and it needs no new verbs. A partial has never been enhanced, so it is
  // correctly excluded by "enhanced" and kept by "not enhanced".
  const pgEnh = /** @type {HTMLSelectElement} */ ($('pgEnhFilter')).value;
  if (pgEnh === '1') a = a.filter(c => !!c.enhanced);
  else if (pgEnh === '0') a = a.filter(c => !c.enhanced);
  const k = pgLib.sort,
    d = pgLib.dir;
  // A dynamic column lookup by NAME — `k` is whichever `<th data-sort>` was last clicked, so its
  // type is the loose `string` `pgLib.sort` carries (see the note there), and `PgClip` has no
  // index signature to look it up with directly. The `unknown` hop is L4's shape: `PgClip` and a
  // string-keyed record are mutually non-assignable without it. Honest for every sortable column
  // (name/voice_label/created_ts/duration_s/size — all string or number|null), which is exactly
  // what the `typeof` checks below already assume at runtime.
  a.sort((x, y) => {
    const xr = /** @type {Record<string, string|number|null|undefined>} */ (/** @type {unknown} */ (x));
    const yr = /** @type {Record<string, string|number|null|undefined>} */ (/** @type {unknown} */ (y));
    const vx = xr[k],
      vy = yr[k];
    return (
      (typeof vx === 'string' || typeof vy === 'string' ? String(vx ?? '').localeCompare(String(vy ?? '')) : (vx || 0) - (vy || 0)) * d
    );
  });
  return a;
}
// 8.9 — the folder scope, and the ONE answer to "which item rows are on screen".
//
// 🔴 `pgSelAll` USED TO RECOMPUTE THE PAGE SLICE ITSELF (`pgFiltered().slice(page*20, ...)`),
// which was a second copy of the paging arithmetic. Folders make that copy WRONG rather than
// merely duplicated — the display list now contains folder rows, so an item slice taken at the
// same offsets selects the wrong clips. One array, written by the render, read by the handler.
const PG_SCOPE = 'playground_clips';
/** @type {any[]} */
let pgVisible = [];

export function renderPgLib() {
  pgLibPark(); // 7.3.1 — the player is a child of this table now; see pgLibPark
  const a = pgFiltered();
  // 🔴 8.9.13 — THE TICK SET IS PRUNED TO WHAT THE FILTER LEFT, ON EVERY RENDER. `loadPgLib`
  // already drops refs whose clip no longer exists, but that is a different question: a clip the
  // search box has hidden still EXISTS, so it kept its tick — and then `⇥ Move selected here`
  // filed it along with the rows actually on screen. Nothing on screen ever mentioned it, and the
  // only symptom is a clip that turns up in a folder nobody put it in.
  //
  // ⚠️ FILTERED, NOT DISPLAYED, AND THE DIFFERENCE IS PAGING AND THE OPEN FOLDER — both of which
  // are NAVIGATION. folders.js draws that line itself: *"Opening a folder is navigation; typing in
  // the box is search, and the two stay orthogonal."* Page 2 hides page 1's rows the same way a
  // closed folder hides its own, and `pgSelAll` only ever ticks the page it is on — so ticking
  // twenty clips, paging on, ticking twenty more and pressing `Delete selected (40)` is the ONLY
  // way to select more than twenty in this library. Pruning to the visible page would silently
  // make that impossible, which is a bigger hole than the one being closed.
  const keep = new Set(a.map(c => c.ref));
  for (const r of [...pgLib.sel]) if (!keep.has(r)) pgLib.sel.delete(r);
  const per = 20;
  // 8.9 — folders before, the open one's children, folders after, divider, unfiled; then page
  // the ITEMS only. `folderPage` never pages a folder row: they are the navigation, and a pager
  // that swept them away on page 2 would leave unexplained items with no way back and no drop
  // target. It also clamps the page, so a filter that shortens the list cannot strand you.
  const disp = folderRows(PG_SCOPE, a, { query: filtQ('pgSearch') });
  const paged = folderPage(disp, pgLib.page, per);
  pgLib.page = paged.page;
  const pages = paged.pages;
  const rows = paged.rows.filter(e => e.t === 'item').map(e => e.row);
  pgVisible = rows;
  const tot = pgLib.items.reduce((s, c) => s + (c.size || 0), 0);
  /** @type {VEl} */ ($('pgLibTotals')).textContent = pgLib.items.length
    ? `— ${pgLib.items.length} clip${pgLib.items.length === 1 ? '' : 's'} · ${fmtSize(tot)}`
    : '';
  /** @param {string} k */
  const arrow = k => (pgLib.sort === k ? (pgLib.dir > 0 ? ' ▲' : ' ▼') : '');
  // 🔴 THE THREE `EnhRow` CASTS BELOW GO THROUGH `unknown`, NOT DIRECTLY: `sys/enhance.js`'s
  // `EnhRow.prefix` is typed `string`, but every real row's `prefix` — this file's `PgClip`, and
  // `playground_clips.py`'s own `"prefix": prefix` — is a chunk COUNT, a number. That is a
  // conflicting field type, not a missing one, so PgClip and EnhRow are mutually non-assignable
  // and a single-step cast is rejected (the L4 shape). Reported: `EnhRow.prefix` should be `number`.
  /** @type {VEl} */ ($('pgLib')).innerHTML = a.length
    ? `<div style="overflow-x:auto"><table class="pgtable"><thead><tr>
      <th style="width:24px"><input type="checkbox" id="pgSelAll"${rows.length && rows.every(c => pgLib.sel.has(c.ref)) ? ' checked' : ''}></th>
      <th data-sort="name" title="Click to sort (click again to flip)">Name${arrow('name')}</th><th data-sort="voice_label" title="Click to sort (click again to flip)">Voice${arrow('voice_label')}</th>
      <th data-sort="created_ts" title="Click to sort (click again to flip)">Rendered${arrow('created_ts')}</th><th data-sort="duration_s" title="Click to sort (click again to flip)">Length${arrow('duration_s')}</th>
      <th data-sort="size" title="Click to sort (click again to flip)">Size${arrow('size')}</th><th></th></tr></thead><tbody>` +
      paged.rows
        .map(e => (e.t === 'folder' ? folderBarRow(e, 7, { selectable: true }) : e.t === 'gap' ? folderGapRow(7) : pgRow(e.row, e.in)))
        .join('') +
      `</tbody></table></div>`
    : filtQ('pgSearch')
      ? filtNone('pgSearch')
      : '<span class="muted">No clips yet — everything you generate lands here.</span>';
  /** @type {VEl} */ ($('pgPager')).innerHTML =
    pages > 1
      ? `‹ page ${Array.from({ length: pages }, (_, i) => `<button class="sm${i === pgLib.page ? ' primary' : ''}" data-pgpage="${i}">${i + 1}</button>`).join(' ')} ›`
      : '';
  const n = pgLib.sel.size;
  /** @type {HTMLButtonElement} */ ($('pgDelSel')).disabled = !n;
  /** @type {VEl} */ ($('pgDelSel')).textContent = n ? `Delete selected (${n})` : 'Delete selected';
  /** @type {HTMLButtonElement} */ ($('pgDlSel')).disabled = !n;
  /** @type {VEl} */ ($('pgDlSel')).textContent = n ? `⬇ Download selected (${n})` : '⬇ Download selected';
  pgLibMount();
  pgLibSyncPlay();
} // 7.3.1 — put the player back in its row, and face the ▶s the right way

/**
 * One clip row.
 * @param {any} c
 * @param {string} [inFolder] - the folder's NAME, present only when a filter has flattened the
 *   list; without the tag a flat result set silently loses what folders added.
 */
// 🔴 THE TICK CELL DOES NEED A CLICK GUARD, AND IT HAS ONE (8.9.14). IT IS `td.pgtick` BELOW.
//
// ⚠️ THIS PARAGRAPH SAID THE OPPOSITE, ON THE STRENGTH OF A MEASUREMENT, AND THE MEASUREMENT WAS
// WRONG. It read: "not reachable — the column is pinned to 24px by its header, so the 13px
// checkbox overflows its content box and covers the padding in every direction", and concluded a
// spec for it could only ever be vacuous. The 24px is a `width:` HINT on the `<th>`, not the
// rendered width. Re-measured in headless Chrome against the real stylesheet:
//
//     cell 36 x 44   ·   checkbox 13 x 13   ·   1388 of 1584 points inside the cell hit the <td>
//
// The row is tall because the Name cell carries badge pills against `vertical-align:middle`, and
// the cell is wider than the hint because of `box-sizing:border-box` plus `padding:6px 8px`. So
// most of the cell was bare, and a click there fell through to `pgLoadClip`, which REWRITES the
// text and settings in the editor above — measured by putting "UNSAVED WORK THE USER WAS TYPING"
// in the textarea and clicking 2.5px inside the cell: the clip's own text was there afterward.
// A near-miss on a checkbox silently discarded whatever you were typing.
//
// 📌 THE OLD NOTE NAMED THIS EXACT FIX AND DECLINED IT — "if that column ever gets wider, the
// guard is one line in the row handler: bail on closest('td.pgtick')". The column was already
// wider. A recorded measurement is only as good as what it actually measured, and this one made
// the next three readers stop looking, which is precisely what the file's other landmines warn a
// certifying comment costs. `pgbook_folders_browser_spec.mjs` now drives the click and asserts the
// editor is untouched, so the claim is a test rather than a paragraph.
function pgRow(c, inFolder) {
  return `<tr class="pgrow${c.ref === state.pgLibClip ? ' active' : ''}" data-ref="${esc(c.ref)}" data-vrow="${esc(c.ref)}" draggable="true">
      <td class="pgtick"><input type="checkbox" class="pgsel" data-ref="${esc(c.ref)}"${pgLib.sel.has(c.ref) ? ' checked' : ''}></td>
      <td title="${esc(c.name)}&#10;&#10;${esc((c.text || '').slice(0, 300))}">${esc(c.name)}${
        c.kind === 'partial'
          ? badgeLine(
              `<span class="flag" style="color:var(--warn);border-color:var(--warn);white-space:nowrap" title="Interrupted render — click the row to load it, then press Continue">⏳ partial · ${c.done}/${c.total ?? '?'}</span>`,
              c.enhanced
                ? `<span class="badge" title="This render will be enhanced when it finishes. The banked chunks are still raw — enhancement is a post-pass on the completed clip.">✨ enhance on finish</span>`
                : '',
            )
          : badgeLine(bandPill(/** @type {EnhRow} */ (/** @type {unknown} */ (c))))
      }</td>
      <td title="${esc(c.voice || '(model default)')}">${esc(c.voice_label || 'default')}</td><td style="white-space:nowrap">${fmtDate(c.created_ts || 0)}</td>
      <td style="white-space:nowrap" ${c.kind === 'partial' && c.duration_s ? 'title="the playable story-so-far (banked chunks) — the full length depends on the remaining text"' : ''}>${c.kind === 'partial' ? (c.duration_s ? fmtDur(c.duration_s) + ' so far' : '—') : fmtDur(c.duration_s)}</td><td style="white-space:nowrap" title="${sizeTip(/** @type {EnhRow} */ (/** @type {unknown} */ (c)))}">${fmtSize(c.size)}</td>
      <td style="white-space:nowrap">${c.kind !== 'partial' || /** @type {number} */ (c.prefix) > 0 ? `<button class="sm" data-play="${esc(c.ref)}" title="${pgPlayTitle(c)}">▶</button>` : ''}
        ${enhBtn(/** @type {EnhRow} */ (/** @type {unknown} */ (c)))}
        <a class="abtn" style="margin:0 12px 0 6px" href="${pgAudioUrl(c)}?download=1" title="Download">⬇</a>
        <button class="xs" data-fav="${esc(c.ref)}" title="${c.favorite ? 'Unfavorite' : 'Favorite'}"${c.favorite ? ' style="color:var(--warn);border-color:var(--warn)"' : ''}>${c.favorite ? '★' : '☆'}</button> <button class="xs" data-speech="${esc(c.ref)}" title="Add this clip to Speech sources">＋</button><button class="xs" data-copyclip="${esc(c.ref)}" title="Copy this clip for a scene edit — then paste it into a scene's chapters in SillyTavern ▸ Clips">⧉</button> <button class="xs" data-renclip="${esc(c.ref)}" title="${c.kind === 'partial' ? 'Rename this render — the name sticks when it finishes' : 'Rename this clip (the file keeps its identity suffix — a re-render of the same inputs still replaces it)'}">✏</button> <button class="xs danger" data-delclip="${esc(c.ref)}" title="Delete">✕</button>${folderTag(inFolder || '')}</td></tr>${c.ref === state.pgLibClip ? PG_PLAYER_ROW : ''}`;
}

// The LIBRARY's own player — the top player belongs to the running/just-finished
// render and must never be hijacked by browsing clips mid-render.
//
// ✅ 7.3.1: IT OPENS IN THE ROW, not in a slot above the table. A page holds 20 clips, so the old
// position could be a screenful away from the row whose ▶ opened it — and with the name and the
// controls that far apart, "which one is this?" had no answer without scrolling back up.
//
// 🔴 IT IS ONE PERSISTENT NODE THAT MOVES. It is never markup inside the table, because
// `renderPgLib` rebuilds `#pgLib` wholesale — on a sort, a page, a tick of one checkbox, a
// favorite, and on every `loadPgLib` — and an <audio> written into that HTML would be destroyed
// mid-playback by each of them. So the node is PARKED back in #pgLibHome before the rebuild and
// re-mounted into the new row after it, both in the SAME synchronous turn: the HTML spec pauses a
// media element that is out of the document at the next stable state, and a move that completes
// inside one task never reaches one.
const PG_PLAYER_ROW = `<tr class="pgplayrow"><td colspan="7" data-pgplayer></td></tr>`;
/** @param {PgClip|undefined} c */
const pgPlayTitle = c => `Play${c && c.kind === 'partial' ? ' the story so far' : ''}`;
function pgLibPark() {
  const p = /** @type {VEl} */ ($('pgLibPlayer'));
  if (p.parentElement !== /** @type {VEl} */ ($('pgLibHome'))) /** @type {VEl} */ ($('pgLibHome')).appendChild(p);
}
function pgLibMount() {
  const slot = /** @type {VEl} */ ($('pgLib')).querySelector('[data-pgplayer]');
  if (slot) slot.appendChild(/** @type {VEl} */ ($('pgLibPlayer')));
} // no slot => the clip is filtered or paged away, and it plays on at home
function pgLibAudio() {
  return /** @type {VEl} */ ($('pgLibPlayer')).querySelector('audio');
}
function pgLibPlaying() {
  const a = pgLibAudio();
  return !!(a && !a.paused && !a.ended);
}
// ▶/■ on the row itself. Every row renders ▶ and this is the one place that corrects it, so the
// markup, a repaint and the audio's own events agree by construction instead of by three copies of
// the same condition drifting apart.
function pgLibSyncPlay() {
  const on = pgLibPlaying();
  for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (/** @type {VEl} */ ($('pgLib')).querySelectorAll('button[data-play]'))) {
    const cur = on && b.dataset.play === state.pgLibClip;
    b.textContent = cur ? '■' : '▶';
    b.title = cur ? 'Stop' : pgPlayTitle(pgLib.items.find(x => x.ref === b.dataset.play));
  }
}
/** @param {string} ref */
function pgLibShowClip(ref) {
  const c = pgLib.items.find(x => x.ref === ref);
  if (!c) return;
  state.pgLibClip = ref;
  const u = pgAudioUrl(c);
  const meta =
    c.kind === 'partial'
      ? `${esc(c.voice_label || 'default')} · <span style="color:var(--warn)">partial — ${c.done}/${c.total ?? '?'} chunks</span> · plays the story so far`
      : `${esc(c.voice_label || 'default')} · rendered ${fmtDate(c.created_ts || 0)} · ${fmtDur(c.duration_s)} · ${fmtSize(c.size)}`;
  /** @type {VEl} */ ($('pgLibPlayer')).innerHTML = `<div class="item" style="margin-bottom:0">
    <audio controls autoplay src="${u}" style="vertical-align:middle"></audio>
    <div class="grow"><div class="t">${esc(c.name)}</div>
      <div class="m">${meta}</div></div>
    <a class="dlbtn" style="margin-left:0" href="${u}?download=1">⬇ Download</a></div>`;
  // The glyph follows the AUDIO, not the click that started it: pausing with the native controls,
  // or the clip simply ending, has to put ▶ back, or the row is offering to stop something that
  // already stopped.
  const a = pgLibAudio();
  if (a) for (const ev of ['play', 'pause', 'ended']) a.addEventListener(ev, pgLibSyncPlay);
  renderPgLib();
} // repaints: highlights the row, opens the slot under it, moves the player in
/** @param {string[]} refs */
async function pgDeleteClips(refs) {
  const partials = refs.filter(r => pgLib.items.some(c => c.ref === r && c.kind === 'partial'));
  const clips = refs.filter(r => !partials.includes(r));
  try {
    const r = await fetchUnlocked('/playground/clips', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips, partials }),
    });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
  } catch (e) {}
  if (/** @type {(string|null|undefined)[]} */ (refs).includes(state.pgLibClip)) {
    state.pgLibClip = null;
    /** @type {VEl} */ ($('pgLibPlayer')).innerHTML = '';
  } // deleted the playing clip
  refs.forEach(x => pgLib.sel.delete(x));
  loadPgLib();
}
/** @param {string} ref */
function pgLoadClip(ref) {
  const c = pgLib.items.find(x => x.ref === ref);
  if (!c) return;
  const pgVoiceSel = /** @type {HTMLSelectElement} */ ($('pgVoice'));
  if ([...pgVoiceSel.options].some(o => o.value === (c.voice || ''))) pgVoiceSel.value = c.voice || '';
  // String(...): `.value` is a string everywhere, and the DOM was already coercing this number
  // to one — made explicit rather than left for the checker to flag at every numeric `.value=`.
  if (c.exaggeration != null) /** @type {HTMLInputElement} */ ($('pgExag')).value = String(c.exaggeration);
  if (c.cfg != null) /** @type {HTMLInputElement} */ ($('pgCfg')).value = String(c.cfg);
  if (c.temperature != null) /** @type {HTMLInputElement} */ ($('pgTemp')).value = String(c.temperature);
  // Enhance is one of the inputs that made this clip, so loading it must restore that too
  // — otherwise "Generate" on a loaded clip would render a DIFFERENT clip (different H)
  // and leave the original sitting there, which reads as a failure to overwrite.
  if (enh.ok) {
    /** @type {HTMLInputElement} */ ($('pgEnh')).checked = !!c.enhanced;
    pgUpdateEnh();
  }
  setPgActions(c.narrate_actions !== false);
  /** @type {HTMLTextAreaElement} */ ($('pgText')).value = c.text || '';
  pgSaveText();
  if (c.kind === 'partial') pgArmResume(c);
  else pgDisarmResume(); // loading a partial arms the green Continue
  pgUpdateAudition();
  pgUpdateTake();
  pgLibShowClip(ref);
} // programmatic set — refresh the take match too
/** @type {VEl} */ ($('pgLib')).addEventListener('click', async e => {
  const th = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('th[data-sort]'));
  if (th) {
    const k = /** @type {string} */ (th.dataset.sort);
    if (pgLib.sort === k) pgLib.dir *= -1;
    else {
      pgLib.sort = k;
      pgLib.dir = k === 'created_ts' || k === 'size' || k === 'duration_s' ? -1 : 1;
    }
    renderPgLib();
    return;
  }
  if (/** @type {HTMLElement} */ (e.target).id === 'pgSelAll') {
    // 8.9 — `pgVisible`, not a second copy of the page arithmetic. With folders in the display
    // list an item slice taken at the same offsets selects the WRONG clips; the render already
    // knows exactly which rows are on screen, so it publishes them.
    const rows = pgVisible;
    if (/** @type {HTMLInputElement} */ (e.target).checked) rows.forEach(c => pgLib.sel.add(c.ref));
    else rows.forEach(c => pgLib.sel.delete(c.ref));
    renderPgLib();
    return;
  }
  if (/** @type {HTMLElement} */ (e.target).classList.contains('pgsel')) {
    const r = /** @type {string} */ (/** @type {HTMLInputElement} */ (e.target).dataset.ref);
    if (/** @type {HTMLInputElement} */ (e.target).checked) pgLib.sel.add(r);
    else pgLib.sel.delete(r);
    renderPgLib();
    return;
  }
  // ▶ / ■ — 7.3.1. The button that started a clip is the button that stops it, because it is the
  // one under the pointer: reaching for a player somewhere else on the page to stop what THIS row
  // is playing was the whole complaint. ■ STOPS rather than pauses (it rewinds and stays open, so
  // ▶ plays it again from the top), and a mid-clip pause from the native controls leaves the
  // position alone — ▶ resumes there.
  const play = /** @type {HTMLElement} */ (e.target).dataset.play;
  if (play) {
    const a = play === state.pgLibClip ? pgLibAudio() : null;
    if (!a) {
      pgLibShowClip(play);
      return;
    } // a different clip — open it and play
    if (pgLibPlaying()) {
      a.pause();
      a.currentTime = 0;
    } else {
      if (a.ended) a.currentTime = 0;
      a.play().catch(() => {});
    }
    pgLibSyncPlay();
    return;
  }
  const del = /** @type {HTMLElement} */ (e.target).dataset.delclip;
  if (del) {
    const c = pgLib.items.find(x => x.ref === del);
    const what = c
      ? `<b>“${esc(c.name)}”</b> — ${esc(c.voice_label || 'default')}${c.kind === 'partial' ? ` <span class="muted">(partial render, ${c.done}/${c.total ?? '?'} chunks)</span>` : ''}`
      : `<b>${esc(del)}</b>`;
    const ok = await modal(c && c.kind === 'partial' ? 'Delete partial render' : 'Delete clip', `Delete ${what}? This cannot be undone.`, [
      { label: 'Cancel', value: 0 },
      { label: 'Delete', class: 'danger', value: 1 },
    ]);
    if (ok) pgDeleteClips([del]);
    return;
  }
  // ■ — stop THIS clip's enhancement (what its E button becomes while its own job runs).
  const es_ = /** @type {HTMLElement} */ (e.target).dataset.enhstop;
  if (es_) {
    const j = state.pgEnh.get(es_);
    if (!j) return;
    /** @type {HTMLButtonElement} */ (e.target).disabled = true;
    try {
      await jpost('/playground/enhance/' + j.jid + '/cancel', {});
    } catch (err) {
      /** @type {HTMLButtonElement} */ (e.target).disabled = false;
      pgLogLine(`${pgEnhTag(j.name)}Cancel failed — ${esc(/** @type {ErrLike} */ (err).message)}`, 'drop');
    }
    return;
  } // the poll loop that started it owns the outcome
  // E — enhance a clip that is already in the library, in place. It REPLACES the clip
  // (enhancement is part of clip identity, so the result is a different H under an
  // _enhanced stem), and the raw take is unrecoverable — a re-render is seedless and
  // gives a different performance. So it confirms first, with the real ETA on the button.
  const eh = /** @type {HTMLElement} */ (e.target).dataset.enh;
  if (eh) {
    const c = pgLib.items.find(x => x.ref === eh),
      btn = /** @type {HTMLButtonElement} */ (e.target);
    if (!c) return;
    const secs = enhEta(c.duration_s || 0, enh.def);
    const ok = await modal(
      'Enhance this clip',
      `<b>“${esc(c.name)}”</b> — ${fmtDur(c.duration_s)}, currently <b>standard quality</b>.` +
        `<div style="margin-top:8px">This will upscale it to <b>full quality</b> and <b>replace this clip</b> at 256 kbps.` +
        (secs ? ` Takes about <b>${fmtEta(secs)}</b>.` : ` <span class="muted">${ETA_UNKNOWN}</span>`) +
        `</div>`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Enhance', class: 'ok', value: 1 },
      ],
    );
    if (!ok) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" style="margin:0"></span>';
    let jid = null;
    try {
      const r = await jpost('/playground/clips/' + encodeURI(eh) + '/enhance', { nfe: enh.def });
      jid = r.job_id;
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = 'E';
      await modal('Enhance failed', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
      return;
    }
    // Enhancing a two-hour clip is a HALF-HOUR GPU JOB, and it used to run behind a silent
    // 2-second poll: a spinner on a small button, nothing in the log, and no way to stop it.
    // The server was already emitting every line of it (decode, ETA, the child's output) and
    // /book/events serves ANY job in JOBS — the UI was simply throwing it away.
    //
    // The log is NOT cleared and every line is tagged with the clip's name: a second
    // enhancement runs on the second card, so two of these narrate into the same log at
    // once, and clearing it would wipe the other one's history mid-run.
    pgSetEnhancing(eh, jid, c.name);
    pgLogLine(
      `${pgEnhTag(c.name)}Enhancing — ${fmtDur(c.duration_s)}${secs ? `, about ${fmtEta(secs)}` : ''}. The result replaces this clip.`,
      'muted',
    );
    const src = new EventSource('/book/events/' + jid);
    src.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'log') pgLogLine(pgEnhTag(c.name) + esc(m.line), 'muted');
    };
    src.onerror = () => {}; // the poll below owns the outcome; SSE is the narration
    // The row is stale the moment it lands (new ref, new name, new size), so just reload.
    /** @type {PgEnhStatus} */
    let out = { status: 'queued', error: null, ref: null, line: '' };
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        out = await jget('/playground/enhance/' + jid);
      } catch (e2) {
        break;
      }
      if (['done', 'failed', 'canceled'].includes(out.status)) break;
    }
    src.close();
    pgSetEnhancing(eh, null);
    const tag = pgEnhTag(c.name);
    if (out.status === 'done') pgLogLine(`${tag}✓ Full-band — the clip has been replaced.`, 'ok');
    else if (out.status === 'canceled') pgLogLine(`${tag}■ Canceled — the clip is untouched.`, 'muted');
    else if (out.status === 'failed') {
      pgLogLine(`${tag}✗ ${esc(out.error || 'the enhancer stopped')}`, 'drop');
      await modal('Enhance failed', esc(out.error || 'the enhancer stopped'), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    await loadPgLib();
    return;
  }
  // E on a PARTIAL — enhance the story-so-far into a NEW clip, non-destructively. Nothing is
  // replaced (there's no MP3 to replace — it's banked chunks); the partial stays resumable and
  // both it and the enhanced snapshot remain available.
  const ep = /** @type {HTMLElement} */ (e.target).dataset.enhpart;
  if (ep) {
    const c = pgLib.items.find(x => x.ref === ep),
      btn = /** @type {HTMLButtonElement} */ (e.target);
    if (!c) return;
    const secs = enhEta(c.duration_s || 0, enh.def);
    const ok = await modal(
      'Enhance the story so far',
      `<b>“${esc(c.name)}”</b> is a partial render — ${c.done}/${c.total ?? '?'} chunks, ${fmtDur(c.duration_s)} banked so far.` +
        `<div style="margin-top:8px">This enhances the <b>banked prefix</b> into a <b>new full-quality clip</b> and <b>leaves the partial exactly as it is</b> — you keep both, and can still Continue the render.` +
        (secs ? ` Takes about <b>${fmtEta(secs)}</b>.` : ` <span class="muted">${ETA_UNKNOWN}</span>`) +
        `</div>`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Enhance so far', class: 'ok', value: 1 },
      ],
    );
    if (!ok) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" style="margin:0"></span>';
    let jid = null;
    try {
      const r = await jpost('/playground/partials/' + encodeURIComponent(ep) + '/enhance', {
        nfe: enh.def,
      });
      jid = r.job_id;
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = 'E';
      await modal('Enhance failed', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
      return;
    }
    pgSetEnhancing(ep, jid, c.name);
    pgLogLine(
      `${pgEnhTag(c.name)}Enhancing the story so far${secs ? `, about ${fmtEta(secs)}` : ''}. It becomes a NEW clip; the partial is untouched.`,
      'muted',
    );
    const src = new EventSource('/book/events/' + jid);
    src.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'log') pgLogLine(pgEnhTag(c.name) + esc(m.line), 'muted');
    };
    src.onerror = () => {};
    /** @type {PgEnhStatus} */
    let out = { status: 'queued', error: null, ref: null, line: '' };
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        out = await jget('/playground/enhance/' + jid);
      } catch (e2) {
        break;
      }
      if (['done', 'failed', 'canceled'].includes(out.status)) break;
    }
    src.close();
    pgSetEnhancing(ep, null);
    const tag = pgEnhTag(c.name);
    if (out.status === 'done') pgLogLine(`${tag}✓ Full-band snapshot saved — the partial is untouched.`, 'ok');
    else if (out.status === 'canceled') pgLogLine(`${tag}■ Canceled — the partial is untouched.`, 'muted');
    else if (out.status === 'failed') {
      pgLogLine(`${tag}✗ ${esc(out.error || 'the enhancer stopped')}`, 'drop');
      await modal('Enhance failed', esc(out.error || 'the enhancer stopped'), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    await loadPgLib();
    return;
  }
  // Add a generated clip to Speech sources using the shared source-preparation route.
  // SPINS while in flight and disables the button. A finished clip is an instant
  // file copy, but a PARTIAL has no MP3 on disk — the server decodes its banked
  // chunks and encodes the lot, which on a multi-hour render can take several seconds.
  const tr = /** @type {HTMLElement} */ (e.target).dataset.speech;
  if (tr) {
    const btn = /** @type {HTMLButtonElement} */ (e.target);
    /** @param {boolean} ow */
    const send = async ow => {
      try {
        return await jpost('/train/import', { clip: tr, overwrite: ow });
      } catch (err) {
        if (isHttpError(err) && err.status === 409 && !ow) {
          const ok = await modal(
            'Already in Speech sources',
            `<b>${esc(/** @type {string|undefined} */ (/** @type {ErrLike} */ (err).body && /** @type {ErrLike} */ (err).body.name) || 'this clip')}</b> is already a Speech source. Replace it with this version?`,
            [
              { label: 'Cancel', value: 0 },
              { label: 'Replace', class: 'danger', value: 1 },
            ],
          );
          if (ok) return send(true);
          return null;
        }
        await modal('Send failed', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
        return null;
      }
    };
    let row;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" style="margin:0"></span>';
    try {
      row = await send(false);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '＋';
    } // restore even on error/cancel
    if (!row) return;
    switchTab('voicestudio');
    switchStudioPanel('speech');
    await spLoadAll();
    return;
  }
  const fv = /** @type {HTMLElement} */ (e.target).dataset.fav;
  if (fv) {
    const c = pgLib.items.find(x => x.ref === fv);
    if (!c) return;
    const url =
      c.kind === 'partial'
        ? '/playground/partials/' + encodeURIComponent(fv) + '/favorite'
        : '/playground/clips/' + encodeURI(fv) + '/favorite';
    try {
      await jpost(url, { favorite: !c.favorite });
    } catch (e2) {
      await modal('Favorite failed', esc(/** @type {ErrLike} */ (e2).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    loadPgLib();
    return;
  }
  // 6.1-m1b §3.4 — Copy clip. This is where the round trip ends: he fixed the line here, saved
  // it, and now needs it back in the scene. It only puts (kind, ref) on the page's clipboard;
  // WHICH line it lands on, and whether it replaces or inserts, is chosen over in the chapters.
  const cp = /** @type {HTMLElement} */ (e.target).dataset.copyclip;
  if (cp) {
    const c = pgLib.items.find(x => x.ref === cp);
    if (!c) return;
    scCopyClip('playground', cp, c.name);
    return;
  }
  // Rename IN PLACE (same pattern as the Voices tab): the Name cell becomes an
  // input; ✓ renames the files (identity suffix preserved server-side), ✕/Esc reverts.
  const rn = /** @type {HTMLElement} */ (e.target).dataset.renclip;
  if (rn) {
    const c = pgLib.items.find(x => x.ref === rn);
    if (!c) return;
    const cell = /** @type {HTMLTableRowElement} */ (/** @type {HTMLElement} */ (e.target).closest('tr')).children[1];
    if (cell.querySelector('input')) return; // already editing
    cell.innerHTML = `<span style="display:inline-flex;gap:6px;align-items:center">
      <input type="text" value="${esc(c.name)}" style="width:240px">
      <button class="xs primary" data-rensaveclip="${esc(rn)}">✓</button>
      <button class="xs" data-rencancelclip="1">✕</button></span>`;
    const inp = /** @type {HTMLInputElement} */ (cell.querySelector('input'));
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') /** @type {HTMLButtonElement} */ (cell.querySelector('[data-rensaveclip]')).click();
      if (ev.key === 'Escape') renderPgLib();
    });
    return;
  }
  const rsc = /** @type {HTMLElement} */ (e.target).dataset.rensaveclip;
  if (rsc) {
    const inp = /** @type {HTMLInputElement} */ (
      /** @type {HTMLSpanElement} */ (/** @type {HTMLElement} */ (e.target).closest('span')).querySelector('input')
    );
    const it = pgLib.items.find(x => x.ref === rsc);
    const url =
      it && it.kind === 'partial'
        ? '/playground/partials/' + encodeURIComponent(rsc) + '/rename'
        : '/playground/clips/' + encodeURI(rsc) + '/rename';
    try {
      await jpost(url, { name: inp.value.trim() });
    } catch (e2) {
      await modal('Rename failed', esc(/** @type {ErrLike} */ (e2).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    loadPgLib();
    return;
  }
  if (/** @type {HTMLElement} */ (e.target).dataset.rencancelclip) {
    renderPgLib();
    return;
  }
  if (/** @type {HTMLElement} */ (e.target).tagName === 'INPUT') return; // typing in the rename editor — not a row click
  // 🔴 8.9.14 — A CLICK ANYWHERE IN THE TICK CELL IS A TICK, NOT A ROW CLICK, AND THE OLD NOTE
  // ABOVE `pgRow` SAID THIS COULD NOT HAPPEN. It said the column is pinned to 24px so the 13px
  // checkbox overflows and covers the padding "in every direction", measured with an
  // `elementFromPoint` probe. Re-measured in a real browser at 8.9.14, the cell is **36 x 44**,
  // the box is 13 x 13, and **1388 of 1584 points inside the cell hit the <td>, not the input**.
  // The 24px is a `width:` hint on the <th>; the rendered cell is wider, and the row is tall
  // because the Name cell carries badge pills against `vertical-align:middle`.
  //
  // 🔴 AND IT COSTS UNSAVED WORK, which is why this is a fix and not a tidy-up. A click 2.5px
  // inside the cell falls through to `pgLoadClip` below, which REWRITES the text and the settings
  // in the editor above. Driven in headless Chrome: the textarea held "UNSAVED WORK THE USER WAS
  // TYPING" before the click and the clip's own text after it. A near-miss on a checkbox silently
  // discards what you were typing.
  //
  // 📌 The old note named this exact fix — "bail on closest('td.pgtick'), the way the Books card
  // handler bails on its label" — and declined it because the measurement said it was unreachable.
  // The measurement was the wrong one; the fix it described was right.
  if (/** @type {HTMLElement} */ (e.target).closest('td.pgtick')) return;
  if (/** @type {HTMLElement} */ (e.target).closest('a')) return; // download link — let it through
  const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.pgrow'));
  if (row) {
    // Loading a clip rewrites the text + settings up top — those are what the LIVE
    // render is using, so it's blocked while one runs. Play/download/delete stay
    // available meanwhile. NAME the running render: the clip you clicked is almost
    // never the one rendering, and the old wording ("the text and settings above
    // belong to the render that's running") read as a claim that it was.
    if (state.pgRunning) {
      let what = '';
      if (state.pgJobId) {
        try {
          const st = await jget('/book/status/' + state.pgJobId);
          const v = (st.voice || '').replace(/\.wav$/i, '');
          const t = (st.text || '').trim().replace(/\s+/g, ' ').slice(0, 48);
          what = [v, t && `“${t}…”`].filter(Boolean).join(' · ');
        } catch (e) {
          /* status gone — the generic message still explains the block */
        }
      }
      await modal(
        'Render in progress',
        `A render is running${what ? ' — ' + esc(what) : ''}. Loading a clip rewrites the text and settings in the editor above, which that render is using — so it's blocked until it finishes (or you Cancel it). The clip you clicked is not the one rendering; you can still ▶ play, ⬇ download, or ✕ delete clips meanwhile.`,
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
      return;
    }
    pgLoadClip(/** @type {string} */ (row.dataset.ref)); // row click loads text+settings+player
  }
});
// ── 8.9: the folder controls on the Playground library ─────────────────────
// 🔴 8.9.13 — THE 4TH ARGUMENT IS WHAT BUYS `⇤ Remove from folder`, AND WITHOUT IT THERE IS NO
// WAY BACK OUT. Filing had two gestures — the button on the folder row and a drag — and un-filing
// had none you could find: the drop target for the root is the divider under the folder block, and
// before 8.9.12 that divider was not even rendered once everything was filed, which is precisely
// the state using folders gets you to. It reads the same `pgLib.sel` as `⇥ Move selected here`, so
// the two actions share one selection set and differ only in destination.
//
// 🔴 ONE RELOAD FOR THE ROW ACTIONS AND THE TOOLBAR ONE, AND IT BRANCHES ON THE ACTION.
// `⇤ Remove from folder` is a `move` like any other, and getting that wrong is invisible: every
// clip's `.folder` stamp came DOWN WITH THE ROW, so a panel that merely re-renders after an
// un-file paints the clips straight back into the folder the server has just taken them out of.
// The store is right and the screen is wrong, and it corrects itself on the next unrelated
// refresh — which is what turns it into a bug report about something else, later. Measured in
// `vs_folders_browser_spec.mjs`, where the folder still read (2) after an un-file that had
// already landed.
//
// ⚠️ THE OTHER TWO ACTIONS MUST NOT PAY THE ROUND TRIP. `open` is pure UI state — nothing on the
// server moved — and `create` has already refreshed the folder cache inside `folderCreate`. One
// reload that always refetched would put an HTTP request on every folder click.
/** @param {string} act */
const pgFolderReload = async act => {
  if (act === 'move') pgLib.sel.clear(); // the ticked clips went where they were sent
  if (act === 'open' || act === 'create') renderPgLib();
  else await loadPgLib();
};
folderAddButton(PG_SCOPE, 'pgLibRefresh', pgFolderReload, { selected: () => [...pgLib.sel] });
folderWire('pgLib', PG_SCOPE, {
  reload: pgFolderReload,
  selected: () => [...pgLib.sel],
  // Read at CLICK time: the delete confirm has to name how many clips are in the folder.
  counts: () => {
    /** @type {Record<string, number>} */
    const n = {};
    for (const c of pgLib.items) if (c.folder) n[c.folder] = (n[c.folder] || 0) + 1;
    return n;
  },
});
folderWireDrag('pgLib', PG_SCOPE, { reload: pgFolderReload, selected: () => [...pgLib.sel] });

/** @type {VEl} */ ($('pgPager')).addEventListener('click', e => {
  const p = /** @type {HTMLElement} */ (e.target).dataset.pgpage;
  if (p !== undefined) {
    pgLib.page = +p;
    renderPgLib();
  }
});
/** @type {VEl} */ ($('pgSearch')).addEventListener('input', e => {
  pgLib.q = /** @type {HTMLInputElement} */ (e.target).value.trim();
  pgLib.page = 0;
  renderPgLib();
});
/** @type {VEl} */ ($('pgLibRefresh')).onclick = loadPgLib;
/** @type {VEl} */ ($('pgPartialsOnly')).addEventListener('change', () => {
  pgLib.page = 0;
  renderPgLib();
});
/** @type {VEl} */ ($('pgFavsOnly')).addEventListener('change', () => {
  pgLib.page = 0;
  renderPgLib();
});
/** @type {VEl} */ ($('pgEnhFilter')).addEventListener('change', () => {
  pgLib.page = 0;
  renderPgLib();
}); // 6.0 §7.1
/** @type {VEl} */ ($('pgDelSel')).onclick = async () => {
  const n = pgLib.sel.size;
  if (!n) return;
  const ok = await modal('Delete clips', `Delete <b>${n}</b> stored clip${n === 1 ? '' : 's'}? This cannot be undone.`, [
    { label: 'Cancel', value: 0 },
    { label: 'Delete', class: 'danger', value: 1 },
  ]);
  if (ok) pgDeleteClips([...pgLib.sel]);
};
// ⬇ Download selected — a FORM POST into a hidden iframe, not fetch()+blob. The response is an
// attachment, so the browser streams it straight to disk with its own progress and its own
// resume; a blob would hold every byte of the selection in the tab, and this library has
// multi-hour renders in it. POST because the refs are paths and there can be dozens of them —
// a GET query string is the wrong place for either. The iframe is what keeps a server error
// from navigating the page away from the app.
/** @type {VEl} */ ($('pgDlSel')).onclick = () => {
  const refs = [...pgLib.sel];
  if (!refs.length) return;
  /** @param {string} r */
  const isPart = r => pgLib.items.some(c => c.ref === r && c.kind === 'partial');
  // The double cast is not belt-and-braces: `$` promises `VEl` and this element is really an
  // <iframe>, and neither type is assignable to the other (VEl has .selectedIndex, an iframe has
  // .contentWindow), so TS requires the `unknown` hop before the narrowing it will accept.
  let fr = /** @type {HTMLIFrameElement} */ (/** @type {unknown} */ ($('pgDlFrame')));
  if (!fr) {
    fr = document.createElement('iframe');
    fr.id = 'pgDlFrame';
    fr.name = 'pgDlFrame';
    fr.style.display = 'none';
    document.body.appendChild(fr);
  }
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = '/playground/clips/zip';
  f.target = 'pgDlFrame';
  f.style.display = 'none';
  for (const r of refs) {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = isPart(r) ? 'partials' : 'clips';
    i.value = r;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
  f.remove();
};

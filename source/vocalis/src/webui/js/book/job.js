// book/job.js — start a render, watch it over SSE, cancel it, and reattach to one that was
// already running when the page loaded (7.3-m6c).
//
// 199 lines in TWO cuts: `logLine` out of the log-sink cluster, and the contiguous 198-line block
// that runs from `function bookBody(` through the end of `── Resume-on-reload ──`. This is the
// "run + SSE" the m6a banner promised and did not contain — §11.10.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — three names, and js/main.js is the only importer of any of them.
//
//   runBook       #runBtn. Posts /book/start in a LOOP, because the route can refuse more than
//                 once and its refusals are independent facts
//   cancelJob     #cancelBtn
//   resumeRender  boot. Finds a live job server-side and rebuilds the page around it
//
// 🔴 SO THIS MODULE IS NOT ON THE SHIM, AND IT IS ONLY THE SECOND THAT IS NOT (after sys/comfy.js
// at m4c). That is a measurement, not a preference: `bookBody`, `openStream`, `setStrip`,
// `subLine`, `jobStart`, `elapsed`, `handleEvent`, `endJob` and `setRunning` have ZERO references
// anywhere outside the moved range — not in the page, not in the module tree. Nine of twelve names
// are private, and the three that are not are wired from main.js, which imports properly.
//
// 📌 m6a's header guessed the opposite. It warned that "seven of its ten names are unprefixed
// generics — endJob, setRunning, openStream, handleEvent — and putting those on the shim is a
// different question", and reserved a commit to answer it. The answer is that the question does
// not arise: nothing publishes them, so nothing can collide with them. Worth recording because the
// guess was reasonable and wrong, and the thing that settled it was grepping the corpus rather
// than reasoning about the names.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE JOB AND `resumeRender` ARE ONE MODULE, AND `jobStart` IS WHY. THIS IS THE `vsStart` TRAP.
//
//     let jobStart=0;                    declared here
//     jobStart=0                         runBook, before opening a fresh stream
//     if(!jobStart)jobStart=Date.now()   handleEvent's `job_start`
//     jobStart=st.started_at? …          resumeRender, from the server's own clock pair
//
// Three assignment sites for one `let`, and `elapsed()` closes over it. Move the job here and
// leave `resumeRender` in the page and its write lands on a DIFFERENT binding from the one
// `elapsed()` reads — `Object.assign(window, mod)` copies a value once and is not a live binding
// (§11.4). The reader would stay pinned at 0 and every resumed render would report an elapsed time
// of roughly 29 million minutes, which is exactly what m4m measured when `vsStart` was declared in
// a module instead of left inline. Same shape, opposite fix: there the reader moved and the
// declaration stayed; here the declaration and ALL THREE writers move together.
//
// ⚠️ That is the same argument m4l used for Library + Chapters, and it is the one boundary rule in
// this milestone that overrides the banners: **shared mutable state decides the file, not the
// headings.** A banner tells you what the author was writing; a `let` with writers on both sides of
// a proposed cut tells you the cut is in the wrong place.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ SIX PLAYGROUND NAMES ARE REACHED AS INLINE GLOBALS, AND ONE OF THEM IS ASSIGNED.
//
//   pgLogLine  pgOpenStream  pgSetAudio  pgSetRunning  setPgActions     read, at call time
//   pgStart                                                             ASSIGNED
//
// All six are in `resumeRender`, and they are there because ONE route answers for both renders:
// /book/jobs returns the live job whatever its kind, and `st.kind==='playground'` branches to the
// Playground tab instead of the Book tab. That is not a tangle to be undone — it is the reason
// resume works at all after a reload, from a second browser, or after a server restart.
//
// Reading an inline global from a module resolves at CALL time and is always safe (§3.1, and
// js/sys/devices.js has done it since m4a). ASSIGNING one is the rarer case: a module body is
// strict, so `pgStart = …` would throw if the name were unresolvable — it resolves because
// `let pgStart=0` is a top-level declaration in the classic script and a module's scope chain
// reaches the global declarative record. It is a live write to the one binding `pgElapsed()`
// reads. m4n established this with `vtCurveAt`; this is the second.
//
// 🔴 THE SIX BECOME IMPORTS WHEN `pg/*` MOVES, AND NOT BEFORE. §5 pairs book/* and pg/* in the
// same milestone for exactly this reason. Do not "fix" the reach by declaring `pgStart` here —
// that is the trap above, wearing the other feature's name.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ `logLine` CAME ALONG, AND IT IS THE FIRST OF THE SIX SINKS TO TRAVEL.
//
// m4g moved `logInto` — the one appender — and left the six sinks in the page with the rule that
// each "travels with its own area". This is `logLine`'s area: every one of its twelve call sites
// is in the moved block, and it had none anywhere else in the page or the tree. m6a deliberately
// did NOT take it, because a sink for the Book RUN has no business in a file called `parse.js`.
// `pgLogLine` and `pgEnhTag` stay where they are and travel with `pg/*`.
//
// ⚠️ `elapsed` IS A COMMON WORD AND FOUR MODULES CONTAIN IT. All four are string literals in some
// other feature's status strip ("… · elapsed 3m 12s"), not references to this one — checked before
// concluding the name was free. It is module-private here and always was page-private.
//
// ⚠️ `state` IS STILL AN INLINE GLOBAL — read, and mutated (`state.es`, `state.jobId`,
// `state.eta`, `state.running`). Property mutation on a shared object is safe in both directions;
// it moves at m12. `switchTab`/`switchBkTab` are inline functions resolved at call time and become
// imports when `ui/tabs.js` lands.

import { $, esc } from '../util/dom.js';
import { switchTab } from '../ui/tabswitch.js'; // 7.5.6 — the leaf, not the hub
import { switchBkTab } from '../ui/tabs.js'; // 7.3-m13
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { fmtDur, fmtEta } from '../util/fmt.js';
import { jget, jpost } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { logInto } from '../ui/log.js';
import { enh, bkUpdateEnh, pgUpdateEnh } from '../sys/enhance.js';
import { kobDropWarnHtml, kobErrHtml } from '../sys/kobold.js';
import { renderStrip, startIdleVram, stopIdleVram } from '../sys/hwstrip.js';
import { renderChaps, loadRenderRate } from './parse.js';
import { pgLogLine, pgOpenStream, pgSetAudio, pgSetRunning, setPgActions } from '../pg/playground.js'; // 7.3-m6e, pgLogLine m12d
import { pgStartSet } from '../pg/pgstate.js'; // 7.3-m6e: was a bare ASSIGNMENT

// 🔴 THE BOOK RUN'S LOG SINK, moved out of the six-sink cluster with its own area (see the header).
/**
 * @param {string} html
 * @param {string} [cls]
 */
function logLine(html, cls) {
  logInto(/** @type {VEl} */ ($('log')), html, cls, /** @type {HTMLInputElement} */ ($('autoscroll')).checked);
}
/**
 * The confirmations `runBook`'s retry loop has accumulated so far — each 409 in `/book/start`'s
 * refusal vocabulary adds one of these and re-posts, so `POST /book/start` sees whichever of the
 * two `runBook` has collected by that point.
 * @param {{confirm_new_narrator?: boolean, force?: boolean}} extra
 */
function bookBody(extra) {
  return {
    path: /** @type {HTMLInputElement} */ ($('path')).value.trim(),
    voice: /** @type {HTMLSelectElement} */ ($('voice')).value,
    exaggeration: +(/** @type {HTMLInputElement} */ ($('exag')).value),
    cfg: +(/** @type {HTMLInputElement} */ ($('cfg')).value),
    temperature: +(/** @type {HTMLInputElement} */ ($('temp')).value),
    enhance: enh.ok && /** @type {HTMLInputElement} */ ($('bkEnh')).checked,
    nfe: +(/** @type {HTMLSelectElement} */ ($('bkNfe')).value) || enh.def,
    ...extra,
  };
} // which devices render is a GLOBAL setting — the server reads it itself
// /book/start can refuse MORE THAN ONCE, and its refusals are independent facts: a new
// narrator, a locked enhance setting and a loaded KoboldCpp can all be true of one click, and
// the route reports whichever it reaches first. So answer them in a LOOP — each modal adds its
// confirmation and re-posts. This used to be one try/catch, which handled exactly one 409 and
// dropped the second into the outer "Start failed" dialog as a bare error CODE.
export async function runBook() {
  const extra = {}; // confirmations accumulate across re-posts; bookBody() spreads them
  const answered = new Set(); // a code we already said yes to must not come back — see below
  try {
    let r;
    for (;;) {
      try {
        r = await jpost('/book/start', bookBody(extra));
        break;
      } catch (e) {
        // same voice => resumes its own "(Narrator)" folder
        const b = /** @type {HttpErrorBody} */ ((e && /** @type {ErrLike} */ (e).body) || {});
        // Only a 409 is a question. Anything else is a real failure and belongs in the outer
        // catch. And if a code we already answered comes back, the answer isn't taking:
        // re-posting again would spin on the server forever, so surface it instead.
        if (/** @type {ErrLike} */ (e).status !== 409 || !b.error || answered.has(b.error)) throw e;
        answered.add(b.error);
        // The book already has finished chapters, rendered with the OTHER enhance setting.
        // There is no "mix anyway" — chapters 1-3 dull and 4-12 crisp is a worse audiobook
        // than either one consistently — so the only real choices are to match what's there
        // or to clear it out and start again.
        if (b.error === 'enhance_locked') {
          const was = /** @type {boolean} */ (b.enhance);
          const ok = await modal(
            'This book is already part-rendered',
            `<b>${esc(b.book)}</b> has <b>${b.rendered} chapter${b.rendered === 1 ? '' : 's'}</b> already rendered <b>${was ? 'with' : 'without'}</b> enhancement.
             <div class="small muted" style="margin-top:8px">An audiobook with some chapters crisp and some dull is worse than either one consistently, so the setting is fixed for the whole book. Continue with the setting it already has — or clear the book in the <b>Library</b> tab and start over with the one you want.</div>`,
            [
              { label: 'Cancel', value: 0 },
              {
                label: `Continue ${was ? 'with' : 'without'} enhancement`,
                class: 'primary',
                value: 1,
              },
            ],
          );
          if (!ok) return;
          /** @type {HTMLInputElement} */ ($('bkEnh')).checked = was;
          bkUpdateEnh(); // the re-post reads it back out of the form
          continue;
        }
        if (b.error === 'different_narrator') {
          const prev = b.prev_voice
            ? `<b>${esc(b.prev_narrator)}</b> (<code>${esc(b.prev_voice)}</code>)`
            : `<b>${esc(b.prev_narrator)}</b>`;
          const ok = await modal(
            'Different narrator',
            `Note: “${esc(b.book)}” has been rendered so far with narrator ${prev}. ` +
              `Rendering with <b>${esc(b.new_narrator)}</b> will be stored <b>separately</b> in your library as a new narrator — it won’t replace or continue the existing render. Are you sure?`,
            [
              { label: 'Cancel', value: 0 },
              { label: 'Yes, render separately', class: 'primary', value: 1 },
            ],
          );
          if (!ok) return;
          extra.confirm_new_narrator = true;
          continue;
        }
        // KoboldCpp is sitting on this box's VRAM and the render is about to want every card.
        // The offer, never the act: [Unload and render] is a third button, not a default.
        // (The server only ever raises this for a LOCAL Kobold — unloading a remote one frees
        // nothing here, so there'd be no trade to offer.)
        if (b.error === 'kobold_loaded') {
          const what = b.config_label
            ? `<div style="margin-top:4px"><code>${esc(b.config_label)}</code></div>`
            : b.model
              ? `<div style="margin-top:4px"><code>${esc(b.model)}</code></div>`
              : '';
          const held =
            /** @type {number} */ (b.other_vram_gb) > 0
              ? `<b>KoboldCpp is holding ~${b.other_vram_gb} GB</b> of GPU memory.`
              : `<b>KoboldCpp has a model loaded.</b>`;
          // Qualitative ON PURPOSE: nobody has ever timed a render with an 80B co-resident, so
          // any concrete multiplier here would be a figure with nothing behind it. (4.1 shipped
          // an ETA asserted against itself and it was 5x wrong.) Measure it, or stay vague.
          const v = await modal(
            'KoboldCpp is holding the GPUs',
            `${held}${what}<div style="margin-top:8px">This render takes <b>every card</b>, so leaving the model loaded means less memory for it — the render will be slower, and may run out of memory entirely.</div>` +
              kobDropWarnHtml(),
            [
              { label: 'Cancel', value: 0 },
              { label: 'Render anyway', value: 2 },
              { label: 'Unload and render', class: 'primary', value: 1 },
            ],
          );
          if (!v) return;
          if (v === 2) {
            extra.force = true;
            continue;
          }
          // Unload, THEN render. If the unload fails, say so and STOP: rendering anyway would
          // be the one outcome the user didn't choose. The button carries the wait (~5-7s, and the
          // route only answers once the model actually reads as gone) — not the strip, which
          // has no off switch and would sit there lying if we bailed.
          const btn = /** @type {HTMLButtonElement} */ ($('runBtn')),
            label = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'Unloading KoboldCpp…';
          try {
            await jpost('/kobold/unload', {});
          } catch (err) {
            await modal('Could not unload KoboldCpp', kobErrHtml(/** @type {ErrLike} */ (err)), [
              { label: 'OK', class: 'primary', value: 1 },
            ]);
            return;
          } finally {
            btn.disabled = false;
            btn.textContent = label;
          }
          extra.force = true; // it's gone now; don't get asked again on the re-post
          continue;
        }
        throw e;
      }
    }
    setRunning(true);
    /** @type {VEl} */ ($('log')).innerHTML = '';
    logLine('Starting job…', 'muted ph');
    document.querySelectorAll('.chap').forEach(x => x.classList.remove('done'));
    jobStart = 0;
    state.jobId = r.job_id;
    openStream(r.job_id);
  } catch (e) {
    setRunning(false);
    await modal('Start failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
}
/** @param {string} id */
function openStream(id) {
  stopIdleVram();
  const es = new EventSource('/book/events/' + id);
  state.es = es;
  es.onmessage = ev => handleEvent(JSON.parse(ev.data));
  // On a dropped connection EventSource retries forever — fine while the job lives,
  // but a pruned/vanished job would leave the UI stuck on "running". Per error:
  // job still known → let it reconnect; job gone/terminal → end cleanly.
  es.onerror = async () => {
    if (state.es !== es) return;
    try {
      const s = await jget('/book/status/' + id);
      if (['done', 'failed', 'canceled'].includes(s.status)) {
        logLine('Connection closed — job ' + s.status + '.', 'muted');
        endJob();
      }
    } catch (e) {
      logLine('Connection lost — job no longer available.', 'drop');
      endJob();
    }
  };
}
/**
 * @param {string} m
 * @param {string} [s]
 */
function setStrip(m, s) {
  /** @type {VEl} */ ($('strip')).classList.add('live');
  /** @type {VEl} */ ($('stripMain')).innerHTML = m;
  /** @type {VEl} */ ($('stripSub')).innerHTML = s || '';
}
// The strip's second line: elapsed, plus an ETA ONLY if this box has actually been measured.
// Before that it says "measuring", which is the truth. The old code had no ETA here at all,
// and the CLI's was computed by dividing by summed worker time — about twice the wall clock
// on a two-card box, so it quoted every remaining chapter at double.
function subLine() {
  const e = state.eta;
  if (!e) return `elapsed ${elapsed()}`;
  if (!e.measured || !e.eta_s) return `elapsed ${elapsed()} · <span class="muted">ETA: measuring…</span>`;
  return `elapsed ${elapsed()} · <b>~${fmtEta(e.eta_s)} left</b> <span class="muted">(${/** @type {number} */ (e.rate).toFixed(1)} c/s, measured ${esc(e.from || 'on this box')})</span>`;
}
let jobStart = 0;
const elapsed = () => {
  const s = Math.floor((Date.now() - jobStart) / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};
/**
 * One `/book/events/<id>` SSE payload for a BOOK job — the same `pool.run_chunks`/`emit(job, ev)`
 * wire family as `pg/playground.js`'s `PgEvent`, plus book-only members: `sections`, `stage` and
 * `section_start`/`section_done` (a book job renders CHAPTERS, not one clip, so `chunk_*` events
 * here carry a `chapter` index the Playground's never do). `eta` reuses the central `EtaEvent`
 * type directly — `state.eta` is already declared against it in `types/vocalis.d.ts`.
 * @typedef {{type:'job_start'}} BkEvJobStart
 * @typedef {{type:'sections', sections:Chapter[]}} BkEvSections
 * @typedef {{type:'vram'} & import('../sys/hwstrip.js').StripSample} BkEvVram
 * @typedef {{type:'log', line:string}} BkEvLog
 * @typedef {{type:'stage', stage:string}} BkEvStage
 * @typedef {EtaEvent & {type:'eta'}} BkEvEta
 * @typedef {{type:'section_start', chapter:number, total:number, title:string}} BkEvSectionStart
 * @typedef {{type:'chunk_start', chapter:number, chunk:number, total:number, device:string}} BkEvChunkStart
 * @typedef {{type:'chunk_done', chapter:number, chunk:number, total:number, device:string, preview:string,
 *   stats:{s:number,cps:number,tokens:number,pct:number,mark:string,render:number}}} BkEvChunkDone
 * @typedef {{type:'device_dropped', chapter:number, device:string, chunk:number, reason:string, message:string}} BkEvDeviceDropped
 * @typedef {{type:'chunk_failed', chapter:number, device:string, chunk:number, reason:string, message:string}} BkEvChunkFailed
 * @typedef {{type:'section_done', chapter:number, title:string, file:string, duration:number|null}} BkEvSectionDone
 * @typedef {{type:'job_done', total_duration:number, output_dir:string}} BkEvJobDone
 * @typedef {{type:'canceled', total_duration?:number, output_dir?:string}} BkEvCanceled
 * @typedef {{type:'error', message:string}} BkEvError
 * @typedef {BkEvJobStart|BkEvSections|BkEvVram|BkEvLog|BkEvStage|BkEvEta|BkEvSectionStart|
 *   BkEvChunkStart|BkEvChunkDone|BkEvDeviceDropped|BkEvChunkFailed|BkEvSectionDone|
 *   BkEvJobDone|BkEvCanceled|BkEvError} BookEvent
 */
/** @param {BookEvent} ev */
function handleEvent(ev) {
  switch (ev.type) {
    // Replayed job_start must not clobber the real start time restored by resumeRender();
    // runBook() zeroes jobStart before opening a fresh stream, so live runs still set it here.
    case 'job_start':
      if (!jobStart) jobStart = Date.now();
      state.eta = null;
      break;
    // Replayed on reconnect: rebuild the chapter list, keeping any done-marks already
    // painted (resumeRender pre-marks from the sidecar, which outlives the SSE ring).
    case 'sections': {
      const done = [...document.querySelectorAll('.chap.done')].map(
        x => +(/** @type {string} */ (/** @type {HTMLElement} */ (x).dataset.ch)),
      );
      renderChaps(ev.sections, done);
      break;
    }
    // The whole strip, pushed — the idle poll is stopped while a job runs, so the CPU line
    // rides along here. Without it the CPU would freeze for the entire render, which is
    // precisely when it's worth watching.
    case 'vram':
      renderStrip(ev);
      break;
    case 'log':
      logLine(esc(ev.line), 'muted');
      break;
    // The enhance pass. It runs AFTER every chapter is rendered — the enhancer needs ~21 GB
    // and cannot share a card with a render — so the strip must say what it is doing, or an
    // hours-long stage with the GPUs pinned reads as a hang.
    case 'stage':
      if (ev.stage === 'enhance') setStrip('✨ Enhancing the finished chapters…', `elapsed ${elapsed()}`);
      break;
    // The ETA is MEASURED on this box or it is not shown. `measured:false` is not a cue to
    // fall back to something — there is nothing to fall back to, and a made-up number in
    // this slot is exactly what quoted a ten-hour book as sixteen for a month.
    case 'eta':
      state.eta = ev;
      break;
    case 'section_start':
      setStrip(`Chapter ${ev.chapter + 1}/${ev.total}: ${esc(ev.title)}`, subLine());
      logLine(`\n=== [${ev.chapter + 1}/${ev.total}] ${esc(ev.title)} ===`);
      break;
    case 'chunk_start':
      setStrip(`Chapter ${ev.chapter + 1} — chunk ${ev.chunk + 1}/${ev.total} on <span class="pill">${esc(ev.device)}</span>`, subLine());
      break;
    case 'chunk_done': {
      const s = ev.stats;
      logLine(
        `<span class="dev">[${esc(ev.device)}]</span> chunk [${ev.chunk + 1}/${ev.total}] ${esc(ev.preview)}\n  <span class="stat">${s.s}s  ${s.cps} c/s  |  ${s.tokens} tok  ${s.pct}% ${esc(s.mark)}  |  ${s.render}x</span>`,
      );
      break;
    }
    case 'device_dropped':
      logLine(`<span class="drop">[${esc(ev.device)}] dropped (${esc(ev.reason)}) chunk ${ev.chunk + 1} — reassigned</span>`);
      break;
    case 'chunk_failed':
      logLine(`<span class="drop">[${esc(ev.device)}] chunk ${ev.chunk + 1} FAILED (${esc(ev.reason)}) — ${esc(ev.message || '')}</span>`);
      break;
    case 'section_done': {
      const c = document.querySelector(`.chap[data-ch="${ev.chapter}"]`);
      if (c) c.classList.add('done');
      logLine(`  → ${esc(ev.file)} (${ev.duration ? ev.duration.toFixed(1) : '?'}s)`);
      break;
    }
    case 'job_done':
      setStrip(`✓ Done — ${fmtDur(ev.total_duration)} of audio`, `output: ${esc(ev.output_dir)} · elapsed ${elapsed()}`);
      logLine(`\n✓ Complete — ${fmtDur(ev.total_duration)} total.`);
      endJob();
      break;
    case 'canceled':
      setStrip('■ Canceled', `output: ${esc(ev.output_dir || '')} · elapsed ${elapsed()}`);
      logLine('\n■ Canceled.', 'muted');
      endJob();
      break;
    case 'error':
      setStrip('✗ Failed', esc(ev.message));
      logLine(`\n✗ ERROR: ${esc(ev.message)}`, 'drop');
      endJob();
      break;
  }
}
// A finished render has just measured this box, so the pre-flight estimate can exist now
// where a moment ago it honestly could not. Re-read it rather than wait for a page reload.
function endJob() {
  setRunning(false);
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  startIdleVram();
  loadRenderRate();
}
/** @param {boolean} r */
function setRunning(r) {
  state.running = r;
  /** @type {VEl} */ ($('runBtn')).style.display = r ? 'none' : 'inline-block';
  /** @type {VEl} */ ($('cancelBtn')).style.display = r ? 'inline-block' : 'none';
  /** @type {HTMLButtonElement} */ ($('runBtn')).disabled = r || !state.chapters.length;
  // Locked once the render starts. A mid-render toggle is how you end up with an
  // audiobook whose first three chapters are dull and whose last nine are crisp.
  /** @type {HTMLInputElement} */ ($('bkEnh')).disabled = r || !enh.ok;
  /** @type {HTMLSelectElement} */ ($('bkNfe')).disabled = r || !enh.ok || !(/** @type {HTMLInputElement} */ ($('bkEnh')).checked);
  if (r) {
    /** @type {HTMLButtonElement} */ ($('cancelBtn')).disabled = false;
    /** @type {VEl} */ ($('cancelBtn')).innerHTML = '■ Cancel';
  }
}
export async function cancelJob() {
  if (!state.jobId) return;
  const b = /** @type {HTMLButtonElement} */ ($('cancelBtn'));
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>Canceling…';
  try {
    await jpost('/book/cancel/' + state.jobId, {});
  } catch (e) {
    logLine('Cancel failed — ' + esc(/** @type {ErrLike} */ (e).message), 'drop');
    b.disabled = false;
    b.innerHTML = '■ Cancel';
  }
}

// ── Resume-on-reload ────────────────────────────────────────────────────
// The server is the source of truth for a live render (localStorage would lie after
// a server restart or from a second browser). On boot: find a running/queued job,
// restore the Book tab to exactly what it is rendering — book, narrator, params,
// workers, GPUs, chapter done-marks, real elapsed — then reattach the event stream;
// /book/events replays its buffered backlog to rebuild the live log before going live.
/**
 * `/book/status/<id>` — `web/books.py`'s `book_status()`. The full reattach payload: what a
 * reloaded page (or `resumeRender`) needs to look exactly like the render that is already
 * running, for either job kind (`kind` decides which tab this function routes to).
 * @typedef {object} BookStatus
 * @property {string} id
 * @property {string} status
 * @property {string|null} error
 * @property {string} docx
 * @property {string} voice
 * @property {number} workers
 * @property {string} gpus
 * @property {Chapter[]} sections
 * @property {string|null} output_dir
 * @property {number|null} started_at
 * @property {number} now
 * @property {string} kind - 'book'|'playground'.
 * @property {string} text
 * @property {boolean} narrate_actions
 * @property {string|null} clip
 * @property {boolean} enhance
 * @property {number} nfe
 * @property {boolean} cap60
 * @property {boolean} capped
 * @property {number} audio_s
 * @property {number|null} only_section
 * @property {boolean} canceling
 * @property {number[]} done_sections
 * @property {{exaggeration:number, cfg:number, temperature:number}} params
 */
export async function resumeRender() {
  /** @type {import('./library.js').BookJobRow[]} */
  let live = [];
  try {
    live = (await jget('/book/jobs')).filter(
      /** @type {(j: import('./library.js').BookJobRow) => boolean} */ (j => ['queued', 'running'].includes(j.status)),
    );
  } catch (e) {
    return;
  }
  if (!live.length) return;
  /** @type {BookStatus} */
  let st;
  try {
    st = await jget('/book/status/' + live[live.length - 1].id);
  } catch (e) {
    return;
  } // newest live job
  if (['done', 'failed', 'canceled'].includes(st.status)) return; // finished while the page was loading
  if (st.kind === 'playground') {
    // route a live playground render to its own tab
    if ([.../** @type {HTMLSelectElement} */ ($('pgVoice')).options].some(o => o.value === (st.voice || '')))
      /** @type {HTMLSelectElement} */ ($('pgVoice')).value = st.voice || '';
    // String(...): `.value` is a string everywhere; the DOM was already coercing these numbers.
    if (st.params) {
      /** @type {HTMLInputElement} */ ($('pgExag')).value = String(st.params.exaggeration);
      /** @type {HTMLInputElement} */ ($('pgCfg')).value = String(st.params.cfg);
      /** @type {HTMLInputElement} */ ($('pgTemp')).value = String(st.params.temperature);
    }
    setPgActions(st.narrate_actions !== false);
    // The RUNNING job is the truth about what is being rendered — not localStorage, which
    // would happily contradict it after a reload, a server restart, or a second browser.
    /** @type {HTMLInputElement} */ ($('pgEnh')).checked = !!st.enhance;
    /** @type {HTMLInputElement} */ ($('pgCap')).checked = !!st.cap60;
    pgUpdateEnh();
    if (st.text) /** @type {HTMLTextAreaElement} */ ($('pgText')).value = st.text;
    switchTab('playground');
    pgSetRunning(true);
    pgSetAudio(st.audio_s || 0);
    if (st.canceling) {
      /** @type {HTMLButtonElement} */ ($('pgCancel')).disabled = true;
      /** @type {VEl} */ ($('pgCancel')).innerHTML = '<span class="spin"></span>Canceling…';
    }
    /** @type {VEl} */ ($('pgLog')).innerHTML = '';
    pgLogLine('Reconnected to the render in progress…', 'muted');
    pgStartSet(st.started_at ? Date.now() - Math.max(0, st.now - st.started_at) * 1000 : Date.now());
    state.pgJobId = st.id;
    pgOpenStream(st.id);
    return;
  }
  if (st.docx) {
    /** @type {HTMLInputElement} */ ($('path')).value = st.docx;
    const base = /** @type {string} */ (st.docx.split(/[\\/]/).pop());
    if ([.../** @type {HTMLSelectElement} */ ($('bookSelect')).options].some(o => o.value === base))
      /** @type {HTMLSelectElement} */ ($('bookSelect')).value = base;
    /** @type {VEl} */ ($('bookDetails')).innerHTML = `📄 <b>${esc(base)}</b> · render in progress`;
  }
  if ([.../** @type {HTMLSelectElement} */ ($('voice')).options].some(o => o.value === (st.voice || '')))
    /** @type {HTMLSelectElement} */ ($('voice')).value = st.voice || '';
  if (st.params) {
    /** @type {HTMLInputElement} */ ($('exag')).value = String(st.params.exaggeration);
    /** @type {HTMLInputElement} */ ($('cfg')).value = String(st.params.cfg);
    /** @type {HTMLInputElement} */ ($('temp')).value = String(st.params.temperature);
  }
  // The live job's own workers/gpus are NOT written back into the ⚙ Settings rows any more.
  // Those rows are the saved per-device configuration; a resumed job would overwrite them with
  // one render's pool, silently editing settings that outlive it. (5.3-m3)
  if (st.sections && st.sections.length) renderChaps(st.sections, st.done_sections || []);
  switchTab('book');
  switchBkTab('generate');
  setRunning(true); // the render's log lives on Generate
  if (st.canceling) {
    /** @type {HTMLButtonElement} */ ($('cancelBtn')).disabled = true;
    /** @type {VEl} */ ($('cancelBtn')).innerHTML = '<span class="spin"></span>Canceling…';
  }
  /** @type {VEl} */ ($('log')).innerHTML = '';
  logLine(
    st.only_section != null ? `Reconnected — chapter ${st.only_section + 1} is regenerating…` : 'Reconnected to the render in progress…',
    'muted',
  );
  // Real elapsed across the reload, from the server's own clock pair (skew-free).
  jobStart = st.started_at ? Date.now() - Math.max(0, st.now - st.started_at) * 1000 : Date.now();
  state.jobId = st.id;
  openStream(st.id);
}

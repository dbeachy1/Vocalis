// voice/batch.js — the overnight batch under Create a voice (7.3-m4i).
//
// Arm a run of N candidates, watch it, stop it, carry it on. Moved verbatim from index.html's
// `── The overnight batch (7.0-m7 §18) ──` banner — 166 lines, three definitions and one wiring.
//
// 🔴 THE RUN IS THE SERVER'S. This code starts it, watches it and stops it; it does not drive it.
// The run must survive a tab close, sleep, or reload, so a client-side loop would stop too early.
// Everything in this file is a VIEW over
// state the server owns, which is also why `vcBatchPoll` is safe to call on entering the tab: it
// finds a run that has been going for six hours and simply starts showing it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE SECOND OF THE CREATE TAB'S THREE PIECES.
//
// The tab is a design FORM, this BATCH, and the candidate QUEUE that both feed. The queue left in
// 7.3-m4d; this is the batch; the form is what remains, and `vc` moves with it — see below.
//
// WHAT IS EXPORTED — one name, and it has exactly one inline caller.
//
//   vcBatchPoll   `switchVTab`'s `if(name==='create'){loadCandidates();vcBatchPoll();…}`. A call,
//                 inside a function, so nothing here is parse-time reachable (§3.1).
//
// 📌 `vcBatchForm` and `vcRenderBatch` are exported for `tests/voices_ui_smoke.mjs`, which slices
// `vcBatchForm` out of the real source and runs it under `vm` against eight cases. A spec caller is
// a caller — the rule `tests/test_webui_modules.py` computes, and the one js/sys/devices.js learned
// the hard way in m4a.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ WHAT IT REACHES FOR AS AN INLINE GLOBAL — NOTHING, AS OF 7.3-m8a.
//
// It was one name, `vc`, the Create tab's whole state object, read off index.html's scope chain
// because all three pieces mutate it (`vc.batch`, `vc.btimer` here) and this header said it "moves
// with the LAST of them, not the first". It moved on its own instead, into js/voice/design.js: the
// form would otherwise have declared it at m8 while importing from here and from candidates.js,
// which is a cycle, and 7.1 §5.8 settled that a cycle between two modules is a filing error.
//
// 🔴 DO NOT REDECLARE `vc` HERE. Exactly one declaration: a second copy would have this file
// mutating its own while the form and the queue read one nothing updates — the same trap §11.4
// documents for MODELS/ENCRYPTED, and the reason those stayed inline too.
//
// 📌 `loadCandidates` and `vcN` ARE IMPORTS, not reaches — they became js/voice/candidates.js in
// m4d. The batch calls `loadCandidates()` every time a round lands, which is the whole reason a
// batch running with this tab closed shows up in the queue at all.

import { $, esc } from '../util/dom.js';
import { jget, jpost } from '../util/http.js';
import { fmtDur } from '../util/fmt.js';
import { modal } from '../ui/modal.js';
import { loadCandidates, vcN } from './candidates.js';
import { vc } from './design.js';
// 🔴 THE ACCESSOR, NOT THE BARE `vcTab` THIS FILE USED TO READ. See the note on `vcTabNow` in
// voices.js: the `let` is reassigned by `switchVTab`, so an imported copy would be right once and
// wrong afterward. The bare read at :95 sat between `vcRenderBatch()` and the reschedule, so the
// throw killed the poll loop — the overnight batch painted one tick and then froze. 7.3 review.
import { vcTabNow } from '../voices/vcstate.js'; // 7.5.6 — the state moved to its own leaf
// ── The overnight batch (7.0-m7 §18) ──────────────────────────────────────
// 🔴 THE RUN IS THE SERVER'S. This code starts it, watches it, and stops it — it does not drive
// it. The run must survive a tab close, sleep, or reload, so everything below is a view.
/** @type {VEl} */ ($('vcBatchBtn')).onclick = async () => {
  const sample = /** @type {HTMLTextAreaElement} */ ($('vcSample')).value.trim();
  if (!sample) {
    await modal('No sample text', 'Give the voice a sentence to speak.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  const count = Math.max(1, Math.min(500, +(/** @type {HTMLInputElement} */ ($('vcBatchN')).value) || 0));
  if (!count) {
    await modal('How many?', 'Give the batch a number of candidates to make.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  // §18.3 — this run holds both cards, so the confirmation describes its impact on the whole box.
  // This modal IS the deliberate second step swap_queue §5.1 asks for; the server takes arm-and-start in one call because the
  // intent was established here.
  // 🔴 §17.4 — SHOW THE TEXT IT WILL SPEAK. The confirmation repeats the exact sample and voice
  // description so the run can be checked before GPU work begins.
  const go = await modal(
    'Run this batch?',
    `<b>${count}</b> candidate${count === 1 ? '' : 's'} — only the seed changes between them.
     <div class="small" style="margin-top:8px">It will say:</div>
     <div class="small" style="margin-top:2px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);max-height:5.5em;overflow:auto;white-space:pre-wrap">${esc(sample)}</div>
     <div class="small muted" style="margin-top:6px">in the voice: ${esc(/** @type {HTMLTextAreaElement} */ ($('vcPrompt')).value.trim()) || '<i>no description</i>'}</div>
     <div class="small muted" style="margin-top:8px">A round is one candidate per free GPU and takes roughly 30–60 s, so this is about ${Math.ceil(count / 2)} rounds on a two-card box.</div>
     <div class="small" style="margin-top:8px;color:var(--warn)">⚠️ It holds VoxCPM2 on the GPUs until it finishes or you stop it. <b>ComfyUI and SwarmUI share those cards.</b> Renders still take priority — the batch waits for them — but nothing else will find the GPUs quiet.</div>
     <div class="small muted" style="margin-top:8px">It runs on the server: close this tab or the laptop and it carries on. Nothing it makes expires.</div>`,
    [
      { label: 'Cancel', value: 0 },
      { label: '▶ Run it', class: 'primary', value: 1 },
    ],
  );
  if (!go) return;
  try {
    vc.batch = await jpost('/voices/design/batch', {
      count,
      prompt: /** @type {HTMLTextAreaElement} */ ($('vcPrompt')).value.trim(),
      sample_text: sample,
      steps: +(/** @type {HTMLInputElement} */ ($('vcSteps')).value) || 30,
    });
  } catch (e) {
    await modal(
      'Couldn’t start the batch',
      esc(
        /** @type {string|undefined} */ (/** @type {ErrLike} */ (e).body && /** @type {ErrLike} */ (e).body.message) ||
          /** @type {ErrLike} */ (e).message,
      ),
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    return;
  }
  vcRenderBatch();
  vcBatchPoll();
};
// Poll while it is live, and once when it is not — the "not" is what makes an interrupted batch
// visible after a restart, even when no batch is currently running.
export async function vcBatchPoll() {
  clearTimeout(vc.btimer ?? undefined);
  const before = vc.batch ? vc.batch.done : 0;
  try {
    vc.batch = /** @type {import('./design.js').VcBatch} */ (await jget('/voices/design/batch'));
  } catch (e) {
    vc.btimer = setTimeout(vcBatchPoll, 5000);
    return;
  }
  vcRenderBatch();
  // A round landed — refresh the list so the morning's rows appear as they are made rather than
  // only on a reload. Skipped when nothing changed, so an idle poll costs one request, not two.
  if (vc.batch.done !== before && vcTabNow() === 'create') loadCandidates();
  const live = vc.batch.status === 'running' || vc.batch.status === 'stopping';
  if (live) vc.btimer = setTimeout(vcBatchPoll, 2000);
}
// 🔴 §20.4 — SHOW THE BATCH'S OWN PROMPT AND SAMPLE AS READ-ONLY.
//
// The batch carries its OWN copy of the form (`arm()` stores it; `_batch_run` reads it), and until
// now the only thing on screen was the boxes at the top of the page — which are a DIFFERENT
// document as soon as the user edits them or picks a template. The batch's captured input remains
// visible separately from the editable form.
//
// ⚠️ READ-ONLY, AND NOT WRITTEN BACK INTO THE BOXES ABOVE. Updating those fields on carry-on
// would overwrite a description or template the user may be editing.
//
// 📌 `readonly`, never `disabled`: a disabled textarea cannot be selected, and copying the text out
// to paste into the boxes above is the obvious next thing to want.
/** @param {import('./design.js').VcBatch} b */
export function vcBatchForm(b) {
  if (!b || b.status === 'idle') return '';
  // 🔴 NO `opacity` HERE. The read-only form uses the same font size as the editable inputs so
  // its text remains legible; the bordered panel and heading already mark it as secondary.
  //
  // ⚠️ The signal is not lost, because it was never carried by the opacity alone: this content
  // is already inside a bordered `--panel2` box, under a heading naming what it is, in a
  // `readonly` control. Four cues remain and none of them costs contrast.
  /** @param {string} label @param {string} text @param {number} rows */
  const box = (label, text, rows) =>
    `<div style="margin-top:6px">
       <div class="small muted" style="margin-bottom:2px">${esc(label)}</div>
       <textarea readonly rows="${rows}" style="width:100%;font:inherit;line-height:1.4;resize:vertical">${esc(String(text || ''))}</textarea>
     </div>`;
  // The heading says WHOSE text this is, because the page now shows two forms and the difference
  // between them is the entire point of the section.
  return `<div style="margin-top:8px;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--panel2)">
      <div class="small"><b>What this batch is generating</b>
        <span class="muted">— the description and sample text it was started with. Editing the boxes at the top of the page does not change a batch that is already running.</span></div>
      ${box('Description', b.prompt, 2)}
      ${box('Sample text', b.sample_text, 3)}
      <div class="small muted" style="margin-top:6px">Quality steps: ${esc(String(b.steps || ''))}${
        b.status === 'stopped'
          ? ' · <b>▶ Carry on continues with exactly this text.</b> To run what is in the boxes at the top instead, press ✕ Discard and then ▶ Batch.'
          : ''
      }</div>
    </div>`;
}

export function vcRenderBatch() {
  const b = vc.batch,
    box = /** @type {VEl} */ ($('vcBatch'));
  if (!b || b.status === 'idle') {
    box.style.display = 'none';
    /** @type {HTMLButtonElement} */ ($('vcBatchBtn')).disabled = false;
    return;
  }
  const live = b.status === 'running' || b.status === 'stopping';
  /** @type {HTMLButtonElement} */ ($('vcBatchBtn')).disabled = live; // arming a second batch would zero the first's progress
  const pct = b.total ? Math.min(100, Math.round((100 * b.done) / b.total)) : 0;
  const head =
    b.status === 'running'
      ? '<span class="spin"></span> Batch running'
      : b.status === 'stopping'
        ? '<span class="spin"></span> Stopping after this round'
        : b.status === 'done'
          ? '✓ Batch finished'
          : '⏸ Batch stopped';
  const eta = b.eta_s ? ` · about ${fmtDur(b.eta_s)} left` : '';
  const failed = b.failed ? ` · <span class="drop">${b.failed} round${b.failed === 1 ? '' : 's'} produced nothing</span>` : '';
  const err = b.error ? `<div class="small drop" style="margin-top:6px">${esc(b.error)}</div>` : '';
  const tail = (b.log || []).slice(-4).join('\n');
  box.style.display = '';
  box.innerHTML = `<div class="row" style="align-items:center;gap:10px;margin:0">
      <div style="flex:1 1 auto;min-width:0"><b>${head}</b> <span class="muted">— ${b.done} of ${b.total}${eta}</span>${failed}</div>
      <div style="flex:0 0 auto;display:flex;gap:6px">
        ${live ? `<button class="danger xs" id="vcBatchStop">${b.status === 'stopping' ? '■ Cancel now' : '■ Stop'}</button>` : ''}
        ${b.status === 'stopped' ? '<button class="primary xs" id="vcBatchGo">▶ Carry on</button>' : ''}
        ${live ? '' : '<button class="xs" id="vcBatchClear" title="Throw this batch away and go back to no batch at all. The candidates it already made are kept — only Delete removes those.">✕ Discard</button>'}
      </div>
    </div>
    ${vcBatchForm(b)}
    <div style="height:6px;border-radius:3px;background:var(--line);margin-top:8px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--acc)"></div></div>
    ${err}
    ${tail ? `<div class="small muted" style="margin-top:6px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.4">${esc(tail)}</div>` : ''}`;
  const stop = /** @type {HTMLButtonElement} */ ($('vcBatchStop'));
  if (stop)
    stop.onclick = async () => {
      // 🔴 §17.4 — SHOW PROGRESS WHILE CANCELLING. Canceling a round in flight interrupts a
      // generation that is already on the GPU, which is not instant — and a disabled button with
      // its old label on it is indistinguishable from a button that did nothing. The label is
      // replaced rather than only grayed, so the control confirms that cancellation is underway.
      const was = stop.innerHTML;
      stop.disabled = true;
      stop.innerHTML = '<span class="spin"></span> ' + (b.status === 'stopping' ? 'Canceling…' : 'Stopping…');
      try {
        vc.batch = await jpost('/voices/design/batch/stop', {});
      } catch (e) {
        stop.innerHTML = was;
        stop.disabled = false;
      }
      vcRenderBatch();
      vcBatchPoll();
    };
  // §17.4 — discard, so a stopped batch is not a one-way door into ▶ Carry on's stored text.
  const clr = /** @type {HTMLButtonElement} */ ($('vcBatchClear'));
  if (clr)
    clr.onclick = async () => {
      const go = await modal(
        'Discard this batch?',
        `<p>This throws away the batch itself — <b>${b.done} of ${b.total}</b> — so the box goes back to
       having no batch at all.</p>
       <p class="small muted">The ${vcN(b.done, 'candidate')} it already made are <b>kept</b>. Only Delete removes those.</p>
       <p class="small muted">Do this when you want to run a different description or sample text: Carry on would
       re-use the ones this batch was started with.</p>`,
        [
          { label: 'Cancel', value: 0 },
          { label: '✕ Discard', class: 'danger', value: 1 },
        ],
      );
      if (!go) return;
      clr.disabled = true;
      try {
        vc.batch = await jpost('/voices/design/batch/clear', {});
      } catch (e) {
        await modal(
          'Couldn’t discard it',
          esc(
            /** @type {string|undefined} */ (/** @type {ErrLike} */ (e).body && /** @type {ErrLike} */ (e).body.message) ||
              /** @type {ErrLike} */ (e).message,
          ),
          [{ label: 'OK', class: 'primary', value: 1 }],
        );
      }
      vcRenderBatch();
      vcBatchPoll();
    };
  const go = /** @type {HTMLButtonElement} */ ($('vcBatchGo'));
  if (go)
    go.onclick = async () => {
      go.disabled = true;
      try {
        vc.batch = await jpost('/voices/design/batch/resume', {});
      } catch (e) {
        await modal(
          'Couldn’t carry on',
          esc(
            /** @type {string|undefined} */ (/** @type {ErrLike} */ (e).body && /** @type {ErrLike} */ (e).body.message) ||
              /** @type {ErrLike} */ (e).message,
          ),
          [{ label: 'OK', class: 'primary', value: 1 }],
        );
      }
      vcRenderBatch();
      vcBatchPoll();
    };
}

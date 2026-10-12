// media/cleanup.js — the two CPU passes that happen to a clip BEFORE it trains (7.3-m10).
//
// WHY THESE THIRTEEN MOVE AS ONE GROUP. They are the whole of banner `4.4 Clean up`, and the
// thing that holds them together is not "cleanup" — it is **a long CPU job that a human sits
// and watches on the shared overlay, and that ends by re-listing whichever clip list sent it**.
// `spCleanup` (Trim + Denoise) and `enhanceClip` (✨ Enhance) are two different jobs on two
// different server rails, and every line they have in common is in this file: `spProgressView`
// puts a live log and a Cancel-that-becomes-Close on the one overlay, and `spDriveJob` streams
// `/book/events/<jid>` while polling `<base>/<jid>` for the verdict. Split cleanup from enhance
// and those two helpers have to be duplicated or hoisted into a module of their own that has
// exactly two callers, both here.
//
// The four `cln*` scoring helpers are the same argument one level down: `clnKeep` is the single
// definition of "is this region kept", and `clnTakes`/`clnStats`/`clnTimeline` are three
// presentations of it. They mirror `cleanup._build_scored` on the server so that the live
// browser-side preview and the cut that actually gets saved agree — which is only checkable
// while they sit next to each other.
//
// 📌 FIVE OF THIRTEEN ARE EXPORTED, and the other eight stop being globals. `cln`,
// `loadCleanupInfo`, `spCleanup`, `spEnhance` and `vtEnhance` have callers outside this file;
// `clnKeep`, `clnTakes`, `clnStats`, `clnTimeline`, `clnPollJob`, `spProgressView`,
// `spDriveJob` and `enhanceClip` have none anywhere, so they become module-private rather than
// moving house — which is the point of the split, not a side effect of it.
//
// ⚠️ NOTHING IN HERE IS PARSE-TIME REACHABLE, verified by hand and against
// `tests/test_webui_parsetime.py`'s pinned surface. The two column-0 lines that name anything of
// ours REGISTER rather than call — `$('spFilter').addEventListener('input',spRender)` and
// `$('spRefresh').onclick=spLoadAll` — and §3.1 is explicit that registering is not calling.
//
// ✅ THREE NAMES ARE STILL REACHED AS INLINE GLOBALS, DOWN FROM SEVEN. `enh`, `enhEta` and
// `ETA_UNKNOWN` belong to `sys/enhance.js` and become imports when it is convenient; that is the
// whole of the list now.
//
// 📌 AND THE OTHER FOUR ARE WORTH READING AS A SET, BECAUSE THEY LEFT BY TWO DIFFERENT DOORS.
// `fmtEta` became a real IMPORT at 7.3-m4 — it moved to `util/fmt.js` beside its three siblings,
// exactly as an earlier draft of this comment predicted. But `sp`/`spLoadAll` (7.3-m9a) and
// `vt`/`vtLoadSources` (7.3-m9b) became PARAMETERS instead, and had to: their areas moved into
// `js/media/voiceswap.js` and `js/voice/training.js`, and BOTH of those files import from THIS
// one, so an import the other way closes a cycle. `spEnhance(ref, sources, reload)`,
// `spCleanup(ref, sources, reload)` and `vtEnhance(ref, sources, reload)` take them from the
// caller — which is what the paragraph below has been asking for since m3c.
//
// 🔴 SO THE RULE IS NOT "EVERY GLOBAL BECOMES AN IMPORT". It becomes an import if the dependency
// runs one way and a parameter if it runs both — and you cannot tell which until you know where
// its area is going. Resolving a global from a module body at CALL time is the specified behavior
// of the scope chain (§3.1, and `js/main.js` leans on it wholesale), so there is no hurry to
// guess. Do NOT duplicate any of them here.
//
// ⚠️ AND THE TRAY (§2.2) IS NOT ONE OF THEM. `vsRenderTray`, `vtSelectSrc`, `vtSaveSel`,
// `vtPicked`, `vt.sel` and the whole `vs.*` state appear NOWHERE in this file. `vtEnhance`
// reads `vt.sources` — the clip LIST, fetched from `/train/sources`, the same list the Speech
// tab holds its own copy of — and passes `vtLoadSources` as an opaque `reload` callback. That is
// `enhanceClip(ref, name, dur, reload)`'s whole design: the caller says which tab to re-list and
// this file never learns what a selection is.
//
// 🔴 `media/sourcetray.js` IS CANCELED — IT WAS NEVER A CONCEPT (7.3-m9a, DESIGN_7_3 §11.23).
// This paragraph used to end "so `media/sourcetray.js` is not a prerequisite for this module, and
// this module must not become one for it", and it was right on both counts for a better reason
// than it knew: there is no shared tray to be a prerequisite. Three trays share a ten-line shape,
// two of them have no callers outside their own banner, and cutting there measured WORSE than not
// cutting. 📌 The `reload`-as-a-parameter design is what let this file land four milestones early
// and is what kept m9a cycle-free; keep the lookups on the caller's side.

import { $, esc } from '../util/dom.js';
import { ETA_UNKNOWN, enh, enhEta } from '../sys/enhance.js'; // 7.3-m13
import { jget, jpost } from '../util/http.js';
import { fmtDur, fmtEta } from '../util/fmt.js';
import { modal } from '../ui/modal.js';

// ── 4.4 Clean up: Trim + Denoise an uploaded clip into new clip(s) ─────────────
// Two AI passes on a Speech-tab clip before it becomes a training clip (design §2). CPU work,
// so it never competes with a render or a training for a GPU. Availability comes from the
// server (/cleanup/info) — which passes are installed, and the measured denoise rate.
/**
 * @typedef {object} CleanupInfo
 * @property {boolean} trim_available
 * @property {boolean} denoise_available
 * @property {string} denoise_unavailable_reason
 * @property {boolean} trim_scorer_available
 * @property {{startup_s:number, per_s:number}|null} rate
 * @property {number|null} def
 * @property {boolean} _loaded
 */
/** @type {CleanupInfo} */
export const cln = {
  trim_available: false,
  denoise_available: false,
  denoise_unavailable_reason: '',
  trim_scorer_available: false,
  rate: null,
  def: null,
  _loaded: false,
};
/** @param {boolean} [force] */
export async function loadCleanupInfo(force) {
  if (cln._loaded && !force) return;
  try {
    const d = await jget('/cleanup/info');
    Object.assign(cln, {
      trim_available: !!d.trim_available,
      denoise_available: !!d.denoise_available,
      denoise_unavailable_reason: String(d.denoise_unavailable_reason || ''),
      trim_scorer_available: !!d.trim_scorer_available,
      rate: d.rate,
      def: d.default,
      _loaded: true,
    });
  } catch (e) {}
}

// The kept/dropped timeline is thresholded LIVE in the browser: /cleanup/analyze returns every
// speech region with its noise-excess AND (4.4-m3) its music/SFX probability once, and moving
// either slider only re-decides keep/drop — no round-trip. A region is kept iff its noise excess is
// within the threshold AND its music/SFX is within the veto (veto=Infinity when the torch scorer is
// absent ⇒ music never vetoes ⇒ the SNR-only MVP). These mirror cleanup._build_scored so the
// preview and the saved cut agree.
/**
 * One scored region of a clip's `/cleanup/analyze` timeline.
 * @typedef {object} CleanupRegion
 * @property {number} start_s
 * @property {number} end_s
 * @property {number} excess_db
 * @property {number} [music_sfx]   0–1 probability; absent until the scorer has run on this clip.
 */
/**
 * `/cleanup/analyze`'s answer — the SNR-only shape until the music/SFX pass has run, `scored`
 * afterward.
 * @typedef {object} CleanupAnalysis
 * @property {CleanupRegion[]} regions
 * @property {number} [total_s]
 * @property {boolean} [scorer_available]
 * @property {boolean} [scored]
 */
/** @param {CleanupRegion} r
 * @param {number} thresh
 * @param {number} veto */
function clnKeep(r, thresh, veto) {
  return r.excess_db <= thresh && !(Number(r.music_sfx) > veto);
}
/** @param {CleanupRegion[]} regions
 * @param {number} thresh
 * @param {number} veto */
function clnTakes(regions, thresh, veto) {
  let takes = 0,
    prevEnd = null,
    adj = false;
  for (const r of regions) {
    if (!clnKeep(r, thresh, veto)) {
      adj = false;
      continue;
    }
    if (!(adj && prevEnd != null && r.start_s - prevEnd <= 1.0)) takes++;
    prevEnd = r.end_s;
    adj = true;
  }
  return takes;
}
/** @param {CleanupAnalysis} a
 * @param {number} thresh
 * @param {number} veto */
function clnStats(a, thresh, veto) {
  let keptS = 0,
    dropS = 0,
    dropped = 0;
  for (const r of a.regions) {
    const d = Math.max(0, r.end_s - r.start_s);
    if (clnKeep(r, thresh, veto)) keptS += d;
    else {
      dropS += d;
      dropped++;
    }
  }
  return { keptS, dropS, dropped, takes: clnTakes(a.regions, thresh, veto) };
}
/** @param {CleanupAnalysis} a
 * @param {number} thresh
 * @param {number} veto */
function clnTimeline(a, thresh, veto) {
  const T = a.total_s || 1;
  return a.regions
    .map(r => {
      const l = (100 * r.start_s) / T,
        w = (100 * Math.max(0, r.end_s - r.start_s)) / T,
        keep = clnKeep(r, thresh, veto);
      const mtip = r.music_sfx != null ? ` · music ${Math.round(100 * r.music_sfx)}%` : '';
      return `<span class="clnseg ${keep ? 'keep' : 'drop'}" style="left:${l.toFixed(3)}%;width:${w.toFixed(3)}%" title="${fmtDur(r.start_s)}–${fmtDur(r.end_s)} · +${r.excess_db.toFixed(1)} dB${mtip} ${keep ? '(kept)' : '(dropped)'}"></span>`;
    })
    .join('');
}
// Poll a background job on the shared /cleanup rails until it reaches a terminal state (used for the
// 4.4-m3 music/SFX scoring pass, which shows no live log — just a quiet "detecting…" in the bar).
/**
 * @typedef {object} CleanupJobStatus
 * @property {string} status   'running' · 'done' · 'failed' · 'canceled'.
 * @property {string} [error]
 */
/** @param {string} jid
 * @returns {Promise<CleanupJobStatus>} */
async function clnPollJob(jid) {
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    /** @type {CleanupJobStatus} */
    let o = { status: 'running' };
    try {
      o = await jget('/cleanup/' + jid);
    } catch (e) {}
    if (['done', 'failed', 'canceled'].includes(o.status)) return o;
  }
}

// A progress view in the shared overlay: a live log fed by /book/events, a Cancel that becomes
// Close when the job ends. Returns {box, finish()}.
/** @param {string} title
 * @param {() => void} onCancel */
function spProgressView(title, onCancel) {
  /** @type {VEl} */ ($('mTitle')).textContent = title;
  /** @type {VEl} */ ($('mBody')).innerHTML = `<div class="clnlog" id="spProgLog"></div>`;
  /** @type {VEl} */ ($('mActs')).innerHTML = '';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.className = 'danger';
  cancel.onclick = () => {
    cancel.disabled = true;
    cancel.textContent = 'Canceling…';
    if (onCancel) onCancel();
  };
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.className = 'primary';
  close.style.display = 'none';
  close.onclick = () => {
    /** @type {HTMLElement} */ (/** @type {VEl} */ ($('overlay')).querySelector('.modal')).classList.remove('wide');
    /** @type {VEl} */ ($('overlay')).classList.remove('on');
  };
  /** @type {VEl} */ ($('mActs')).appendChild(cancel);
  /** @type {VEl} */ ($('mActs')).appendChild(close);
  /** @type {VEl} */ ($('overlay')).classList.add('on');
  return {
    box: /** @type {VEl} */ ($('spProgLog')),
    finish() {
      cancel.style.display = 'none';
      close.style.display = '';
      close.focus();
    },
  };
}
// Drive a background job: stream its log over /book/events, poll `pollBase/<jid>` until it
// reaches a terminal state, then resolve with that status object. Same rails the Playground
// enhance flow uses (SSE for narration, a poll for the verdict).
/** @param {string} jid
 * @param {string} pollBase
 * @param {VEl} box
 * @returns {Promise<CleanupJobStatus>} */
function spDriveJob(jid, pollBase, box) {
  return new Promise(resolve => {
    /** @type {EventSource|null} */
    let es = null;
    try {
      es = new EventSource('/book/events/' + jid);
      es.onmessage = ev => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === 'log' && d.line) {
            const ln = document.createElement('div');
            ln.textContent = d.line;
            box.appendChild(ln);
            box.scrollTop = box.scrollHeight;
          }
        } catch (e) {}
      };
      es.onerror = () => {};
    } catch (e) {}
    (async () => {
      /** @type {CleanupJobStatus} */
      let out = { status: 'running' };
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          out = await jget(pollBase + '/' + jid);
        } catch (e) {}
        if (['done', 'failed', 'canceled'].includes(out.status)) break;
      }
      try {
        if (es) es.close();
      } catch (e) {}
      resolve(out);
    })();
  });
}

// ✨ Enhance a training clip, keeping both (§10.4 decision B): the original is untouched and a
// full-band copy is cached beside it. Reuses the enhance job's poll/cancel/SSE. `reload` re-lists
// whichever tab called it (the Speech tab or the Voice Training picker).
/**
 * The subset of a training-clip row (`/train/sources`) these entry points need. Callers hand
 * over their OWN list — the Speech tab's `sp.sources` in voiceswap.js, Voice Training's
 * `vt.sources` — so this stays minimal rather than importing either caller's fuller row type;
 * this file "never learns what a selection is" (see the header).
 * @typedef {object} CleanupSourceRow
 * @property {string} ref
 * @property {string} name
 * @property {number|null} [duration_s] - null when ffprobe could not measure it; the
 *    producer (voice/training.js's VtSourceRow) has always said so.
 */
/** @param {string} ref
 * @param {string} name
 * @param {number|null} [dur] - null when ffprobe could not measure it. Both callers below feed a
 *    row's `duration_s` straight through, and the body already reads it as `dur || 0`.
 * @param {() => Promise<void>} [reload] */
async function enhanceClip(ref, name, dur, reload) {
  if (!enh.ok) {
    await modal('Enhance unavailable', esc(enh.msg || 'Enhancing isn’t available on this box.'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  const est = enhEta(dur || 0, enh.def);
  const go = await modal(
    'Enhance this clip',
    `Reconstruct the crisp high end of <b>${esc(name)}</b> — ${enh.def} steps, ${est ? '~' + fmtEta(est) : '<span class="muted">' + ETA_UNKNOWN + '</span>'}.<br><br>` +
      `The original stays exactly as it is; this makes a <b>full-band copy</b> beside it, which you can download. Best <i>after</i> a Clean up: clean the original, then enhance the clean copy.`,
    [
      { label: 'Cancel', value: 0 },
      { label: 'Enhance', class: 'go', value: 1 },
    ],
  );
  if (!go) return;
  let jid = null;
  try {
    const r = await jpost('/train/sources/' + encodeURIComponent(ref) + '/enhance', {
      nfe: enh.def,
    });
    jid = r.job_id;
  } catch (e) {
    const t =
      /** @type {ErrLike} */ (e).body && /** @type {ErrLike} */ (e).body.error === 'already full quality'
        ? 'Already full quality'
        : 'Could not start';
    await modal(t, esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  const pv = spProgressView('Enhancing · ' + name, () => jpost('/playground/enhance/' + jid + '/cancel', {}).catch(() => {}));
  const out = await spDriveJob(jid, '/playground/enhance', pv.box);
  if (out.status === 'done') {
    /** @type {VEl} */ ($('overlay')).classList.remove('on');
  } else {
    const ln = document.createElement('div');
    ln.style.color = 'var(--err)';
    ln.textContent = out.status === 'canceled' ? 'Canceled.' : 'Failed: ' + (out.error || 'unknown error');
    pv.box.appendChild(ln);
    pv.finish();
  }
  if (reload) await reload();
}
// 🔴 `sources` AND `reload` ARE PARAMETERS, AND THIS FILE'S OWN HEADER IS WHY (7.3-m9a). It said:
// "when sources.js and training.js become modules they import FROM here; if anyone converts
// sp/spLoadAll/vt/vtLoadSources into imports the other way, that becomes a real cycle. Keep the
// lookups on the caller's side." m9a is that moment — `sp` and `spLoadAll` moved into
// js/media/voiceswap.js, which imports FOUR names from this file. Importing them back would have
// been the cycle, named in advance and shipped anyway. The caller has both in hand.
/** @param {string} ref
 * @param {CleanupSourceRow[]} sources
 * @param {() => Promise<void>} [reload] */
export async function spEnhance(ref, sources, reload) {
  const s = (sources || []).find(x => x.ref === ref);
  if (s) await enhanceClip(ref, s.name, s.duration_s, reload);
}
// 🔴 THE LAST TWO INLINE REACHES GO THE SAME WAY (7.3-m9b). `vt` and `vtLoadSources` moved into
// js/voice/training.js, which imports `vtEnhance` from HERE — so importing them back would close
// the cycle this file's header named four milestones ago. Parameters, like spEnhance above.
/** @param {string} ref
 * @param {CleanupSourceRow[]} sources
 * @param {() => Promise<void>} [reload] */
export async function vtEnhance(ref, sources, reload) {
  const s = (sources || []).find(x => x.ref === ref);
  if (s) await enhanceClip(ref, s.name, s.duration_s, reload);
}

// 🧹 The Clean up workspace (design §3): Trim (a live kept/dropped timeline + threshold) and/or
// Denoise (a strength slider + a 20 s A/B preview), then Save as new clip(s). Managed directly
// on the shared overlay so it can move from configure → progress without closing.
/** @param {string} ref
 * @param {CleanupSourceRow[]} sources
 * @param {() => Promise<void>} [reload] */
export async function spCleanup(ref, sources, reload) {
  // 🔴 params, not imports — see spEnhance above
  const s = (sources || []).find(x => x.ref === ref);
  if (!s) return;
  const canTrim = cln.trim_available,
    canDen = cln.denoise_available;
  if (!canTrim && !canDen) {
    await modal('Clean up unavailable', 'Neither pass is installed on this box.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  const modalEl = /** @type {HTMLElement} */ (/** @type {VEl} */ ($('overlay')).querySelector('.modal'));
  modalEl.classList.add('wide');
  /** @type {VEl} */ ($('mTitle')).textContent = 'Clean up · ' + s.name;
  /** @type {VEl} */ ($('mBody')).innerHTML = `
    <div class="clnsec" id="clnTrimSec">
      <label class="clnhd"><input type="checkbox" id="clnTrim"${canTrim ? '' : ' disabled'}> Trim noisy parts</label>
      <div class="small muted" style="margin-top:4px">Cut the noisy / SFX / dead-air stretches, keep the clean speech split into takes. ${canTrim ? 'The primary tool — cutting costs nothing you can’t spare.' : '<span style="color:var(--err)">unavailable on this box</span>'}</div>
      <div id="clnTrimBody" style="display:none">
        <div class="clnrow"><span class="small">conservative</span>
          <input type="range" id="clnThresh" min="6" max="30" step="1" value="24">
          <span class="small">aggressive</span>
          <span class="small" id="clnThreshVal" style="min-width:56px;text-align:right"></span></div>
        <div class="clnrow" id="clnMusicRow" style="display:none"><span class="small">drop music/SFX</span>
          <input type="range" id="clnVeto" min="0" max="1" step="0.05" value="0.35">
          <span class="small">keep music/SFX</span>
          <span class="small" id="clnVetoVal" style="min-width:56px;text-align:right"></span></div>
        <div class="clnbar" id="clnBar"><span class="small muted" style="padding:4px 8px">analyzing…</span></div>
        <div class="clnread" id="clnRead"></div>
      </div>
    </div>
    <div class="clnsec" id="clnDenSec">
      <label class="clnhd"><input type="checkbox" id="clnDen"${canDen ? ' checked' : ' disabled'}> Denoise <span class="small muted">(DeepFilterNet3)</span></label>
      <div class="small muted" style="margin-top:4px">Pull the voice out of the background without cutting. ${canDen ? 'Full strength won the ear test; gentle keeps more of the true timbre.' : `<span style="color:var(--err)">${esc(cln.denoise_unavailable_reason || 'Denoise is unavailable.')}</span>`}</div>
      <div id="clnDenBody"${canDen ? '' : ' style="display:none"'}>
        <div class="clnrow"><span class="small">gentle</span>
          <input type="range" id="clnWet" min="0" max="1" step="0.05" value="1">
          <span class="small">full</span>
          <span class="small" id="clnWetVal" style="min-width:56px;text-align:right"></span></div>
        <div class="clnrow"><button class="sm" id="clnPrevBtn" title="Denoise a 20-second snippet from the start so you can compare it against the original before committing.">▶ Preview 20 s</button></div>
        <div id="clnAB"></div>
      </div>
    </div>
    <div class="small" id="clnEta" style="margin-top:6px"></div>`;
  /** @type {VEl} */ ($('mActs')).innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => {
    modalEl.classList.remove('wide');
    /** @type {VEl} */ ($('overlay')).classList.remove('on');
  };
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save as new clip(s)';
  saveBtn.className = 'go';
  /** @type {VEl} */ ($('mActs')).appendChild(cancelBtn);
  /** @type {VEl} */ ($('mActs')).appendChild(saveBtn);
  /** @type {VEl} */ ($('overlay')).classList.add('on');

  /** @type {CleanupAnalysis|null} */
  let analysis = null;
  const trimCb = /** @type {HTMLInputElement} */ ($('clnTrim')),
    trimBody = /** @type {VEl} */ ($('clnTrimBody')),
    thresh = /** @type {HTMLInputElement} */ ($('clnThresh')),
    threshVal = /** @type {VEl} */ ($('clnThreshVal')),
    veto = /** @type {HTMLInputElement} */ ($('clnVeto')),
    vetoVal = /** @type {VEl} */ ($('clnVetoVal')),
    musicRow = /** @type {VEl} */ ($('clnMusicRow')),
    bar = /** @type {VEl} */ ($('clnBar')),
    read = /** @type {VEl} */ ($('clnRead')),
    denCb = /** @type {HTMLInputElement} */ ($('clnDen')),
    denBody = /** @type {VEl} */ ($('clnDenBody')),
    wet = /** @type {HTMLInputElement} */ ($('clnWet')),
    wetVal = /** @type {VEl} */ ($('clnWetVal')),
    eta = /** @type {VEl} */ ($('clnEta'));
  // The music/SFX veto only applies once the clip is scored (scorer installed AND the pass ran);
  // until then the timeline is SNR-only, so the veto is Infinity (never drops for music).
  const curVeto = () => (analysis && analysis.scored ? +veto.value : Infinity);
  function renderTrim() {
    threshVal.textContent = (+thresh.value).toFixed(1) + ' dB';
    vetoVal.textContent = Math.round(+veto.value * 100) + '%';
    if (!analysis) return;
    const t = +thresh.value,
      v = curVeto();
    bar.innerHTML = clnTimeline(analysis, t, v);
    const st = clnStats(analysis, t, v);
    read.textContent = `kept ${fmtDur(st.keptS)} across ${st.takes} segment${st.takes === 1 ? '' : 's'} → one clip · dropped ${fmtDur(st.dropS)} across ${st.dropped} region${st.dropped === 1 ? '' : 's'}`;
  }
  // First analyze gives the instant SNR preview; if the torch scorer is installed but this clip
  // hasn't been scored yet, run the one-time music/SFX pass in the background, then re-analyze for
  // the upgraded (music-aware) timeline and reveal the veto slider. Degrades silently to SNR.
  async function clnAnalyze() {
    try {
      analysis = await jpost('/cleanup/analyze', { ref });
    } catch (e) {
      bar.innerHTML =
        '<span class="small" style="color:var(--err);padding:4px 8px">could not analyze this clip: ' +
        esc(/** @type {ErrLike} */ (e).message) +
        '</span>';
      return;
    }
    renderTrim();
    if (/** @type {CleanupAnalysis} */ (analysis).scorer_available && !(/** @type {CleanupAnalysis} */ (analysis).scored)) {
      read.innerHTML = '<span class="small muted">detecting music / SFX (once per clip — a few minutes on a long file)…</span>';
      try {
        const r = await jpost('/cleanup/score', { ref });
        const out = await clnPollJob(r.job_id);
        if (out.status === 'done') analysis = await jpost('/cleanup/analyze', { ref });
      } catch (e) {
        /* stay on the SNR preview */
      }
    }
    if (/** @type {CleanupAnalysis} */ (analysis).scored) musicRow.style.display = '';
    renderTrim();
  }
  function renderEta() {
    const parts = [];
    if (denCb.checked) {
      const dur = /** @type {CleanupSourceRow} */ (s).duration_s || 0;
      const e = cln.rate ? cln.rate.startup_s + dur * cln.rate.per_s : null;
      parts.push(e ? 'denoise ~' + fmtEta(e) : 'denoise: ' + ETA_UNKNOWN);
    }
    if (trimCb.checked) parts.push('trim is fast');
    eta.innerHTML = parts.length ? '<span class="muted">' + parts.join(' · ') + '</span>' : '';
  }
  function validate() {
    saveBtn.disabled = !(trimCb.checked || denCb.checked);
  }
  trimCb.onchange = async () => {
    trimBody.style.display = trimCb.checked ? '' : 'none';
    validate();
    renderEta();
    if (trimCb.checked && !analysis) await clnAnalyze();
  };
  thresh.oninput = renderTrim;
  veto.oninput = renderTrim;
  denCb.onchange = () => {
    denBody.style.display = denCb.checked ? '' : 'none';
    validate();
    renderEta();
  };
  // `+value`, not `value`: a range input's .value is a STRING, and `'0.5'*100` only works because
  // JS coerces it. The unary plus is what this file already does when it sends the number
  // (`{wet:+wet.value}` below), so this is the same read written the same way.
  wet.oninput = () => {
    wetVal.textContent = Math.round(+wet.value * 100) + '%';
    /** @type {VEl} */ ($('clnAB')).innerHTML = '';
  };
  /** @type {VEl} */ ($('clnPrevBtn')).onclick = async () => {
    const b = /** @type {HTMLButtonElement} */ ($('clnPrevBtn'));
    b.disabled = true;
    b.textContent = 'denoising…';
    try {
      const r = await jpost('/cleanup/preview', {
        ref,
        denoise: { wet: +wet.value },
        start_s: 0,
        seconds: 20,
      });
      /** @type {VEl} */ ($('clnAB')).innerHTML = `<div class="clnab">
        <div class="clnabrow"><span class="clnablbl">Original</span><audio controls src="${r.orig}"></audio></div>
        <div class="clnabrow"><span class="clnablbl">Cleaned</span><audio controls src="${r.cleaned}"></audio></div>
      </div>`;
    } catch (e) {
      /** @type {VEl} */ ($('clnAB')).innerHTML =
        '<span class="small" style="color:var(--err)">preview failed: ' + esc(/** @type {ErrLike} */ (e).message) + '</span>';
    } finally {
      b.disabled = false;
      b.textContent = '▶ Preview 20s A/B';
    }
  };
  wetVal.textContent = Math.round(+wet.value * 100) + '%';
  vetoVal.textContent = Math.round(+veto.value * 100) + '%';
  validate();
  renderEta();

  saveBtn.onclick = async () => {
    // 🔴 SAVE MUST SEND WHAT THE TIMELINE WAS DRAWN WITH. This sent `+veto.value` unconditionally
    // while the preview used curVeto(), which is Infinity until the clip is scored — so on an
    // unscored clip the saved cut applied a 0.35 music veto that was never on screen, and regions
    // the user watched being KEPT were silently dropped. The server does not ignore the field:
    // _trim_to_scratch computes the VAD+tagger scores itself when analyze() has not cached them
    // ("otherwise pays for the child here") and hands them to _build_scored with this value. It
    // contradicted both written invariants — clnKeep's "these mirror cleanup._build_scored so the
    // preview and the saved cut agree", and _build_scored's own "kept identical between preview
    // and cut so the timeline and the saved clip can never disagree".
    //
    // ⚠️ 1, NOT curVeto() — Infinity CANNOT SURVIVE THE ROUND TRIP, TWICE OVER. JSON.stringify
    // turns Infinity into `null`, and cleanup.py's `_f(None, default)` then falls back to exactly
    // the 0.35 this fix exists to stop; and even a literal inf would be flattened by that route's
    // `min(1.0, max(0.0, …))` clamp. 1 is the largest value the wire can carry, and it is EXACTLY
    // equivalent to no veto: the comparison is `music <= music_veto` server-side (`!(music_sfx >
    // veto)` here — the same predicate), and music/SFX is a probability, so nothing can exceed 1.
    // Reachable path is not exotic: tick Trim, and for the minutes the music/SFX pass runs ("a few
    // minutes on a long file") nothing disables Save. Same if /cleanup/score fails or is canceled,
    // since the catch leaves analysis.scored false permanently.
    const wireVeto = Math.min(curVeto(), 1);
    const passes = {
      trim: { enabled: trimCb.checked, max_excess_db: +thresh.value, music_veto: wireVeto },
      denoise: { enabled: denCb.checked, wet: +wet.value },
    };
    if (!passes.trim.enabled && !passes.denoise.enabled) {
      eta.innerHTML = '<span style="color:var(--err)">Pick at least one pass — Trim, Denoise, or both.</span>';
      return;
    }
    let jid = null;
    try {
      const r = await jpost('/cleanup/run', { ref, trim: passes.trim, denoise: passes.denoise });
      jid = r.job_id;
    } catch (e) {
      eta.innerHTML = '<span style="color:var(--err)">Could not start: ' + esc(/** @type {ErrLike} */ (e).message) + '</span>';
      return;
    }
    const pv = spProgressView('Cleaning up · ' + s.name, () => jpost('/cleanup/' + jid + '/cancel', {}).catch(() => {}));
    const out = await spDriveJob(jid, '/cleanup', pv.box);
    if (out.status === 'done') {
      modalEl.classList.remove('wide');
      /** @type {VEl} */ ($('overlay')).classList.remove('on');
    } else {
      const ln = document.createElement('div');
      ln.style.color = 'var(--err)';
      ln.textContent = out.status === 'canceled' ? 'Canceled.' : 'Failed: ' + (out.error || 'unknown error');
      pv.box.appendChild(ln);
      pv.finish();
    }
    await loadCleanupInfo(true); // fold this run's measured rate into the next ETA
    if (reload) await reload();
  };
}

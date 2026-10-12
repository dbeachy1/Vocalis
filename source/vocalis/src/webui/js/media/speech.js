import { $, esc } from '../util/dom.js';
import { jget, jpost, fetchUnlocked } from '../util/http.js';
import { fmtDate, fmtDur, fmtSize } from '../util/fmt.js';
import { filtCount, filtNone, filtQ, filtRows } from '../util/filter.js';
import { folderRows, folderBar, folderGap, folderTag, folderAddButton, folderWire, folderWireDrag, loadFolders } from '../ui/folders.js';
import { modal } from '../ui/modal.js';
import { badgeLine, bandPill, enh } from '../sys/enhance.js';
import { cln, loadCleanupInfo, spCleanup, spEnhance } from './cleanup.js';

// Speech clip library backed by the shared source store.
// This panel manages the shared speech-material store used by Playground, Stems, and scenes.
/** Speech source row available to the retained media workflows.
 * * @typedef {object} SpRow
 * @property {string} ref
 * @property {string} name
 * @property {string} [provenance]     'uploaded' · 'playground' · 'stems' · 'scene' · 'cleaned' ·
 *   absent (a pre-4.3 clip, whose origin was never recorded).
 * @property {string} [cleaned_from]   The clip this one was cleaned from, when provenance is
 *   'cleaned'.
 * @property {string} [cleanup]        A one-line description of the clean-up pass that made it.
 * @property {boolean} [band_limited]
 * @property {boolean} [enhanced_ready]
 * @property {number} [enhanced_nfe]
 * @property {number} [duration_s]
 * @property {number} [size]
 * @property {number} [mtime]
 * @property {string} [folder] - the virtual folder's id, stamped by the server since 8.9
 *   (`web/train.py`, scope `train_sources`). 📌 THE TYPEDEF NOT DECLARING IT WAS ITSELF THE
 *   FINGERPRINT OF THE DEFECT: the field has been on every row for a release, and it went
 *   undeclared because this panel never read it.
 */
//: `sel` — the folder tick set (9.0.6). 📌 DECLARED ON THE NAMED CONST, not asserted inline at the
//: literal: an inline `/** @type */ (expr)` asserts and checks nothing, which is how four fields
//: were dropped from a literal in 8.9.7 under a comment certifying it was a compile error.
/** @type {{sources: SpRow[], sel: Set<string>}} */
const sp = { sources: [], sel: new Set() };
/** @param {SpRow} s */
function spProvBadge(s) {
  const p = s.provenance;
  return p === 'uploaded'
    ? '<span class="badge up" title="You uploaded this clip.">uploaded</span>'
    : p === 'playground'
      ? '<span class="badge" title="Sent here from a Playground clip with its ＋ button.">from Playground</span>'
      : p === 'stems'
        ? '<span class="badge" title="The isolated vocal from a Stem Split, sent here with its Add to Speech button.">from stems</span>'
        : // 7.5: a SillyTavern scene, sent here with ＋ Speech on its row in Scene Clips (it was a 🎓 Train
          // button before the training feature left the Docker package, 2026-10-11). ⚠️ A scene can
          // have more than one speaker in it — the tab warns before sending, and the badge is the only
          // thing that says so afterward, once the clip is sitting in a list of one-voice reads.
          p === 'scene'
          ? '<span class="badge" title="A SillyTavern scene, sent here with ＋ Speech on its row in Scene Clips.">from a scene</span>'
          : // 4.4: a Clean up pass produced this clip. Light-green, and independent of the "Full
            // quality ✨" badge — a clip can be both cleaned AND enhanced (§3.1).
            p === 'cleaned'
            ? `<span class="badge cleaned" title="Made by a Clean up pass${s.cleaned_from ? ` from “${esc(s.cleaned_from)}”` : ''}${s.cleanup ? ` — ${esc(s.cleanup)}` : ''}. Noise / SFX / dead air removed; the original is untouched.">Cleaned up</span>`
            : '';
} // pre-4.3 clip: origin unknown, no badge
//: 9.0.6 — virtual folders on the Speech library. Scope `train_sources`, keyed on `ref`, and it is
//: This scope is shared with the Stems and source-management views.
//:
//: 🔴 THIS PANEL WAS THE LAST ONE RENDERING A FOLDER-STAMPED DATASET AS A FLAT LIST. `/train/sources`
//: has stamped every row with its folder since 8.9 (`web/train.py`, `folders.for_rows(...,
//: "train_sources", rows)`) — this screen received the field and threw it away, so a clip filed
//: from any of the other three panels read as unfiled here. The grouping is a render change over a
//: field that was already on every row, not a new data path.
const SP_SCOPE = 'train_sources';

//: ⚠️ THE SET SURVIVES RE-RENDERS ON PURPOSE, AND IS PRUNED TO WHAT IS ON SCREEN ON EVERY ONE.
//: This list re-renders on a filter keystroke, a rename, a delete, an enhance and a clean-up, and
//: losing your ticks to any of those would make selecting more than two clips impossible. But a
//: tick on a row you cannot SEE silently widens the next `⇥ Move selected here`, so the render
//: below drops every ref that is not in the display array it is about to paint — filtered out,
//: deleted, or inside a closed folder.
//:
//: 📌 PRUNED AT THE RENDER, NOT NARROWED AT THE GESTURE, and the difference is which panel this
//: is. Speech-library ticks answer only which clips the folder action should move — they
//: are also the training selection, and dropping one would delete a clip from a dataset you spent
//: ten minutes assembling. These ticks answer exactly one question, "what am I filing", so the
//: simpler rule is the correct one and it matches `voices.js`'s uploaded-voices list verbatim.
const spFolderSel = () => [...sp.sel];

export function spRender() {
  const all = sp.sources || [],
    shown = filtRows('spFilter', all, s => s.name);
  /** @type {VEl} */ ($('spTotals')).textContent = filtCount('spFilter', shown.length, all.length, 'clip');
  // Folders before, the open one's children, folders after, divider, unfiled — `folderRows` owns
  // that order so all four panels agree about what a folder list looks like.
  const disp = folderRows(SP_SCOPE, shown, { query: filtQ('spFilter') });
  // `disp`, not `shown`: a clip inside a CLOSED folder is in `shown` and is not on screen.
  const onScreen = new Set();
  for (const e of disp) if (e.t === 'item') onScreen.add(e.row.ref);
  for (const r of [...sp.sel]) if (!onScreen.has(r)) sp.sel.delete(r);
  /** @type {VEl} */ ($('spList')).innerHTML =
    disp.map(e => (e.t === 'folder' ? folderBar(e, { selectable: true }) : e.t === 'gap' ? folderGap() : spRow(e.row, e.in))).join('') ||
    (all.length
      ? filtNone('spFilter')
      : '<span class="muted">No speech clips yet — upload one, send a Playground clip here with its ＋ button, or use Add to Speech on the vocals of a Stem Split.</span>');
}

/**
 * One speech-clip row.
 * @param {SpRow} s
 * @param {string} [inFolder] - the folder's NAME, present only when a filter has flattened the list.
 */
function spRow(s, inFolder) {
  return `<div class="item${sp.sel.has(s.ref) ? ' active' : ''}" data-sprow="${esc(s.ref)}" data-vrow="${esc(s.ref)}" draggable="true">
    <input type="checkbox" data-picksp="${esc(s.ref)}"${sp.sel.has(s.ref) ? ' checked' : ''} style="margin-right:6px"
           title="Tick this clip to file it into a folder, or to take it back out.">
    <div class="grow"><div class="t" data-spname="${esc(s.ref)}">${esc(s.name)}</div>
      ${badgeLine(
        spProvBadge(s),
        bandPill(s),
        s.band_limited
          ? s.enhanced_ready
            ? `<span class="flag" style="color:var(--ok);border-color:var(--ok)" title="Standard quality — but a full-band enhanced copy is already made (download it with ⬇ enhanced). The original clip is unchanged, and the enhanced copy remains separately available.">standard quality · enhanced copy ready</span>`
            : `<span class="flag" title="Missing the crisp high end. The source remains available as stored. Use ✨ Enhance to create a separate full-band copy.">standard quality</span>`
          : '',
      )}
      <div class="m">${s.duration_s ? fmtDur(s.duration_s) + ' · ' : ''}${fmtSize(s.size)} · ${fmtDate(s.mtime)}</div></div>
    <button class="sm" data-spplay="${esc(s.ref)}" title="Play this clip below">▶</button>
    <a class="abtn" style="margin:0 6px" href="/train/sources/${encodeURIComponent(s.ref)}/audio?download=1" title="Download this clip as it is stored">⬇</a>
    ${s.enhanced_ready ? `<a class="abtn" style="margin:0 6px" href="/train/sources/${encodeURIComponent(s.ref)}/enhanced" title="Download the enhanced (full-band) WAV${s.enhanced_nfe ? ` — ${s.enhanced_nfe} steps` : ''}. A separate file; the clip above is the untouched original.">⬇ enhanced</a>` : ''}
    ${cln.trim_available || cln.denoise_available ? `<button class="sm" style="color:var(--cln);border-color:var(--cln)" data-spclean="${esc(s.ref)}" title="Clean up this clip — trim the noisy/SFX stretches and/or denoise what's left (DeepFilterNet3). Makes a new clip; the original is untouched.">🧹 Clean up</button>` : ''}
    ${s.band_limited && enh.ok && !s.enhanced_ready ? `<button class="sm" style="color:var(--ok);border-color:var(--ok)" data-spenh="${esc(s.ref)}" title="Enhance this clip — reconstruct the crisp high end. Keeps the original and caches a full-band copy beside it (a separate copy). Best AFTER a Clean up: clean the original, then enhance the clean copy.">✨ Enhance</button>` : ''}
    <button class="sm" data-spren="${esc(s.ref)}" title="Rename this clip.">✏</button>
    <button class="sm danger" data-spdel="${esc(s.ref)}" title="Remove this clip from the speech library.">✕</button>${folderTag(inFolder || '')}</div>`;
}
export async function spLoadAll() {
  await loadCleanupInfo();
  // 9.0.6 — folder NAMES and order. The rows themselves arrive already stamped by the server, so
  // this is the only extra request the folder column costs this panel.
  await loadFolders(SP_SCOPE);
  try {
    sp.sources = await jget('/train/sources');
  } catch (e) {
    sp.sources = [];
  }
  spRender();
}
// 🔴 THE FILTER BOX WAS INERT, AND HAD BEEN. This line used to read
// `$('spFilter').addEventListener('input', spRender)` — which re-rendered on every keystroke and
// filtered NOTHING, because `filtQ` does not read the DOM: it reads the `FILT` map, and only
// `filtWire` writes it. Typing in "Filter clips…" repainted the identical list for ever.
// 📌 Now wired with the other nine in `ui/filterwiring.js` — "every filter box, wired to the
// render it drives" — which is where the omission was visible as an absence rather than as a
// line that looked correct on its own. `spRender` is exported for that reason.
/** @type {VEl} */ ($('spRefresh')).onclick = spLoadAll;
/** @type {VEl} */ ($('spFile')).addEventListener('change', async () => {
  const spInp = /** @type {HTMLInputElement} */ ($('spFile'));
  const f = /** @type {FileList} */ (spInp.files)[0];
  if (!f) return;
  /** @param {boolean} ow */
  async function up(ow) {
    const fd = new FormData();
    fd.append('file', f);
    if (ow) fd.append('overwrite', 'true');
    return fetchUnlocked('/train/sources', { method: 'POST', body: fd });
  }
  try {
    let r = await up(false);
    let j = await r.json().catch(() => ({}));
    if (r.status === 409) {
      const ok = await modal('Clip exists', `<b>${esc(j.name || f.name)}</b> is already a speech clip. Replace it?`, [
        { label: 'Cancel', value: 0 },
        { label: 'Replace', class: 'danger', value: 1 },
      ]);
      if (!ok) return;
      r = await up(true);
      j = await r.json().catch(() => ({}));
    }
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    if (!r.ok) throw new Error(j.error || r.statusText);
    await spLoadAll();
  } catch (e) {
    await modal('Upload failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    spInp.value = '';
  }
});
/** @type {VEl} */ ($('spList')).addEventListener('click', async e => {
  // 9.0.6 — the folder tick. 🔴 PATCHES ONE ROW, NEVER RE-RENDERS THE LIST. This list carries an
  // INLINE RENAME EDITOR (the ✏ branch below), so a `spRender()` here would destroy a name the
  // user was halfway through typing — and it would do it from a click on a different row. That is
  // the Playground tick-cell data loss with the pieces rearranged; the fix is the same one
  // `lora.js` uses for Curate, which is to patch the cell and touch nothing else.
  const tk = /** @type {HTMLElement} */ (e.target).dataset.picksp;
  if (tk !== undefined) {
    const box = /** @type {HTMLInputElement} */ (e.target);
    const row = /** @type {HTMLElement} */ (box.closest('[data-sprow]'));
    // The checkbox has already flipped itself — read it rather than toggling a second time.
    if (box.checked) sp.sel.add(tk);
    else sp.sel.delete(tk);
    if (row) row.classList.toggle('active', box.checked);
    return;
  }
  // Rename the selected clip in place.
  const rn = /** @type {HTMLElement} */ (e.target).dataset.spren;
  if (rn) {
    const s = sp.sources.find(x => x.ref === rn);
    if (!s) return;
    const cell = /** @type {Element} */ (
      /** @type {Element} */ (/** @type {HTMLElement} */ (e.target).closest('[data-sprow]')).querySelector('[data-spname]')
    );
    if (cell.querySelector('input')) return;
    cell.innerHTML = `<span style="display:inline-flex;gap:6px;align-items:center">
      <input type="text" value="${esc(s.name)}" style="width:240px" maxlength="60">
      <button class="xs primary" data-spsave="${esc(rn)}">✓</button>
      <button class="xs" data-spcancel="1">✕</button></span>`;
    const inp = /** @type {HTMLInputElement} */ (cell.querySelector('input'));
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') /** @type {HTMLButtonElement} */ (cell.querySelector('[data-spsave]')).click();
      if (ev.key === 'Escape') spRender();
    });
    return;
  }
  const sv = /** @type {HTMLElement} */ (e.target).dataset.spsave;
  if (sv) {
    const inp = /** @type {HTMLInputElement} */ (
      /** @type {Element} */ (/** @type {HTMLElement} */ (e.target).closest('span')).querySelector('input')
    );
    try {
      await jpost('/train/sources/rename', { ref: sv, name: inp.value.trim() });
    } catch (e2) {
      await modal('Rename failed', esc(/** @type {ErrLike} */ (e2).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    await spLoadAll();
    return;
  }
  if (/** @type {HTMLElement} */ (e.target).dataset.spcancel) {
    spRender();
    return;
  }
  // ▶ play — inject a FRESH <audio autoplay>, exactly as the Playground and Voice-Swap
  // libraries do. Re-pointing one persistent preload="none" element and calling .play()
  // silently no-ops in some browsers (Chrome blocks the programmatic play); a new element
  // carrying the autoplay attribute is honored because it rides the click's user gesture.
  const pl = /** @type {HTMLElement} */ (e.target).dataset.spplay;
  if (pl) {
    const u = `/train/sources/${encodeURIComponent(pl)}/audio`;
    /** @type {VEl} */ ($('spPlayerWrap')).innerHTML = `<audio controls autoplay src="${u}" style="width:100%;max-width:440px"></audio>`;
    /** @type {VEl} */ ($('spPlayerWrap')).style.display = '';
    return;
  }
  // 🧹 Clean up (4.4) — open the Trim/Denoise workspace for this clip.
  const cl = /** @type {HTMLElement} */ (e.target).dataset.spclean;
  if (cl) {
    spCleanup(cl, sp.sources, spLoadAll);
    return;
  }
  // ✨ Enhance (4.4 §10) — bandwidth-extend, keeping both (a full-band copy beside the original).
  const en = /** @type {HTMLElement} */ (e.target).dataset.spenh;
  if (en) {
    spEnhance(en, sp.sources, spLoadAll);
    return;
  }
  const del = /** @type {HTMLElement} */ (e.target).dataset.spdel;
  if (del) {
    const s = sp.sources.find(x => x.ref === del);
    const ok = await modal('Remove clip', `Remove <b>${esc(s ? s.name : del)}</b> from the speech library?`, [
      { label: 'Cancel', value: 0 },
      { label: 'Remove', class: 'danger', value: 1 },
    ]);
    if (!ok) return;
    try {
      await fetch('/train/sources', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refs: [del] }),
      });
    } catch (e2) {}
    spLoadAll();
    return;
  }
});

// ── 9.0.6: the folder controls on the Speech clip library ────────────────────
//
// 🔴 THE LAST PANEL RENDERING A FOLDER-STAMPED DATASET FLAT. `#spList` reads `/train/sources`,
// which has stamped every row with its `train_sources` folder since 8.9 — the same scope Voice
// Stems and Speech group clips by the same folder identity. A clip filed from either view reads
// as unfiled here, because this screen received the field and discarded it.
//
// ⚠️ `⇤ Remove from folder` acts on `spFolderSel`, NOT on `sp.sel` — the ticks narrowed to what is
// on screen. Filing a row a filter is hiding, or one inside a closed folder, is a move nothing on
// screen reports; that is the invariant every other panel here buys the same way.
//
// Ticks are cleared after a move because they identify only the clips being filed, so
// leaving them set after the clips have gone would arm the next ⇥ with rows that already moved.
/** @param {string} act */
const spFolderReload = async act => {
  if (act === 'move') sp.sel.clear(); // the ticked clips went where they were sent
  // `open` is pure UI state and `create` has already refreshed the folder cache inside
  // `folderCreate`. Everything else invalidates the server's `.folder` stamps and MUST refetch:
  // repainting from the rows in hand puts them straight back into the folder they just left.
  if (act === 'open' || act === 'create') spRender();
  else await spLoadAll();
};
folderAddButton(SP_SCOPE, 'spRefresh', spFolderReload, { selected: spFolderSel });
folderWire('spList', SP_SCOPE, {
  reload: spFolderReload,
  selected: spFolderSel,
  // Counted over every clip the panel holds, not just what is displayed — the number goes into
  // the delete-folder confirm ("the N items in it are kept"), which must describe the FOLDER
  // rather than the current view of it.
  counts: () => {
    /** @type {Record<string, number>} */
    const n = {};
    for (const x of sp.sources || []) if (x.folder) n[x.folder] = (n[x.folder] || 0) + 1;
    return n;
  },
});
folderWireDrag('spList', SP_SCOPE, { reload: spFolderReload, selected: spFolderSel });

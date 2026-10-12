// The shared prompt card: the system prompt, the wrapper, the few-shot pairs, and their
// revisions. 7.1 §5.5 — module 7, and the first one the CORRECTED order (§5.7) picked.
//
// 📌 IT WENT NEXT BECAUSE IT WAS NEARLY FREE. Re-measuring after six modules had landed, this
// group needed exactly two things still inline — `wbConfirm` and `wbWhen` — against `st.js`'s
// three, which live in modules that have not moved yet. That is what demoted `st.js` to last.
//
// 🔴 `wbPromptLoaded` IS MODULE-PRIVATE NOW, and that is the point of the move rather than a side
// effect. It is the snapshot `wbPromptDirty` compares against, and the comment below explains why
// it is a comparison and not a flag: a flag has to be cleared correctly by every path that
// writes, and the paths that write are exactly the ones that were getting it wrong. A snapshot
// nothing outside these functions can touch is that argument made structural.
//
// ⚠️ THE FOUR LISTENERS MOVED WITH THE CARD, and they are top-level statements in a module. That
// is safe for the same reason the overlay listener was (§5.4): a module runs after the document
// is parsed, so `$('wbPromptRev')` and friends are guaranteed to exist by the time this runs.
// They were registered DURING parsing before and are registered just after it now; the only
// difference is a window of a few milliseconds in which a click would be missed.
//
// ⚠️ None of this is reachable at parse time — hand-checked per §5.6. Every entry point is a
// listener or `switchStTab`, and there is no column-0 call of any of these names.

import { $, esc } from '../util/dom.js';
import { jget, jpost, jput, jdel } from '../util/http.js';
import { wbConfirm } from '../ui/modal.js';
import { wbWhen } from './fmt.js';

/** One few-shot pair, as typed into `#wbPromptShots` and as the server stores it. */
/** @typedef {{user: string, assistant: string}} WbShotPair */

/** A saved-state snapshot — what `wbPromptDirty` compares the live boxes against. */
/** @typedef {{system: string, wrapper: string, shots: string}} WbPromptSnapshot */

/**
 * The prompt card as `GET /wbedit/prompt` (and every route that mutates it) answers.
 * @typedef {object} WbPromptData
 * @property {string} [system]
 * @property {string} [wrapper]
 * @property {WbShotPair[]} shots
 * @property {string} fingerprint
 * @property {string} shipped_fingerprint
 */

/** One row of `GET /wbedit/prompt/revisions`. */
/** @typedef {{n: number, created_at?: number, note?: string}} WbPromptRevRow */

// Persisted in the vault and used by every pass from then on — he refines it rarely, so the
// cost that matters is a bad edit being hard to undo, not a save being slow. Hence Reset, and
// hence the pane always showing whether it is on the default.
//
// 🔴 A PASS FREEZES IT (I10). The route refuses a save while one is running rather than letting
// the record disagree with what was actually sent.
/**
 * @param {string} msg
 * @param {boolean} [bad]
 */
export const wbPromptSay = (msg, bad) => {
  const el = /** @type {VEl} */ ($('wbPromptMsg'));
  el.textContent = msg || '';
  el.style.color = bad ? 'var(--err)' : 'var(--muted)';
};

// Pairs are edited as text because a repeater of paired boxes is a lot of chrome for something
// touched a few times a year. `---` between pairs, a blank line between the halves.
/** @param {WbShotPair[]|null|undefined} shots */
export const wbShotsText = shots => (shots || []).map(s => `${s.user}\n\n${s.assistant}`).join('\n---\n');

/**
 * @param {string} text
 * @returns {WbShotPair[]|null} null when a pair is missing its blank-line separator — the
 *   caller reports that rather than silently dropping the pair.
 */
export function wbParseShots(text) {
  /** @type {WbShotPair[]} */
  const out = [];
  for (const block of String(text || '').split(/^---$/m)) {
    if (!block.trim()) continue;
    const halves = block.trim().split(/\n\s*\n/);
    if (halves.length < 2) return null; // caller reports; a silent drop loses a pair
    out.push({ user: halves[0].trim(), assistant: halves.slice(1).join('\n\n').trim() });
  }
  return out;
}

// Is there typing in the prompt card that the server has not been told about? (5.5)
//
// Compared against what was last LOADED, not against a dirty flag, for the same reason
// `wbShowPrompt`'s "as shipped" note is a comparison rather than a stored bit: a flag has to be
// cleared correctly by every path that writes, and the paths that write are exactly the ones that
// were getting this wrong.
/** @type {WbPromptSnapshot|null} */
let wbPromptLoaded = null;
export function wbPromptDirty() {
  if (!wbPromptLoaded) return false;
  const sys = /** @type {HTMLTextAreaElement} */ ($('wbPromptSys')),
    wrap = /** @type {HTMLTextAreaElement} */ ($('wbPromptWrap')),
    shots = /** @type {HTMLTextAreaElement} */ ($('wbPromptShots'));
  if (!sys || !wrap || !shots) return false;
  return sys.value !== wbPromptLoaded.system || wrap.value !== wbPromptLoaded.wrapper || shots.value !== wbPromptLoaded.shots;
}

/** @param {WbPromptData} p */
export function wbShowPrompt(p) {
  /** @type {HTMLTextAreaElement} */ ($('wbPromptSys')).value = p.system || '';
  /** @type {HTMLTextAreaElement} */ ($('wbPromptWrap')).value = p.wrapper || '';
  /** @type {HTMLTextAreaElement} */ ($('wbPromptShots')).value = wbShotsText(p.shots);
  wbPromptLoaded = {
    system: /** @type {HTMLTextAreaElement} */ ($('wbPromptSys')).value,
    wrapper: /** @type {HTMLTextAreaElement} */ ($('wbPromptWrap')).value,
    shots: /** @type {HTMLTextAreaElement} */ ($('wbPromptShots')).value,
  };
  // Not a stored flag — a comparison. Editing this is expected, so the pane says which prompt
  // is loaded, and only notes "as shipped" because that is what tells him Reset is a no-op.
  const stock = p.fingerprint === p.shipped_fingerprint;
  /** @type {VEl} */ ($('wbPromptState')).textContent =
    `· ${p.shots.length} few-shot pair${p.shots.length === 1 ? '' : 's'} · ${p.fingerprint}` + (stock ? ' · as shipped' : '');
}

export async function wbLoadPrompt() {
  wbShowPrompt(await jget('/wbedit/prompt'));
  await wbLoadPromptRevs();
  wbPromptSay('');
}

// ── m5a / §9a.12: the prompt has revisions, for the reason the documents do ───────────────────
//
// 🔴 THE PANE'S OWN HELP TEXT SAYS "IF A PASS STARTS PASTING ITS THINKING INTO A FIELD, PRESS
// RESET" — so the product instructs him to destroy a prompt he may have spent an hour tuning, at
// exactly the moment something is going wrong. `save` overwrote and `reset` unlinked; neither left
// anything behind. Now both mint a revision, and restoring appends a NEW one rather than rewinding
// — the same rule as `DocumentStore.rollback`, because a restore that truncated would make
// recovering from a BAD restore impossible.
export async function wbLoadPromptRevs() {
  const sel = /** @type {HTMLSelectElement} */ ($('wbPromptRev'));
  if (!sel) return;
  /** @type {WbPromptRevRow[]} */
  let rows = [];
  try {
    rows = (await jget('/wbedit/prompt/revisions')).revisions || [];
  } catch (e) {
    /* below */
  }
  if (!rows.length) {
    // Nothing has ever been saved, so there is no history and the control would be a dead box.
    sel.innerHTML = '<option value="">none yet</option>';
    sel.disabled = true;
    /** @type {VEl} */ ($('wbPromptRestore')).style.display = 'none';
    return;
  }
  sel.disabled = false;
  // Newest first — what he reaches for is the last one or the one before it. Same ordering, and
  // the same timestamp format, as the document picker m4n built.
  sel.innerHTML =
    '<option value="">— in effect now —</option>' +
    rows
      .slice()
      .reverse()
      .map(r => `<option value="${r.n}">revision ${r.n}${wbWhen(r.created_at)}` + `${r.note ? ' · ' + esc(r.note) : ''}</option>`)
      .join('');
  sel.value = '';
  /** @type {VEl} */ ($('wbPromptRestore')).style.display = 'none';
}

/** @type {VEl} */ ($('wbPromptRev')).addEventListener('change', async e => {
  const n = /** @type {HTMLSelectElement} */ (e.target).value;
  if (n === '') {
    await wbLoadPrompt();
    return;
  }
  try {
    const d = await jget('/wbedit/prompt/revision/' + encodeURIComponent(n));
    // Shown, NOT applied. Reading an old prompt is how he decides whether to restore it, and a
    // picker that silently put it into force would make browsing the history a destructive act.
    /** @type {HTMLTextAreaElement} */ ($('wbPromptSys')).value = d.system || '';
    /** @type {HTMLTextAreaElement} */ ($('wbPromptWrap')).value = d.wrapper || '';
    /** @type {HTMLTextAreaElement} */ ($('wbPromptShots')).value = wbShotsText(d.shots || []);
    /** @type {VEl} */ ($('wbPromptRestore')).style.display = '';
    wbPromptSay('showing revision ' + n + ' — this is not in effect until you press Restore');
  } catch (err) {
    wbPromptSay(/** @type {ErrLike} */ (err).message || 'could not read that revision', true);
  }
});

/** @type {VEl} */ ($('wbPromptRestore')).addEventListener('click', async () => {
  const n = /** @type {HTMLSelectElement} */ ($('wbPromptRev')).value;
  if (n === '') return;
  try {
    wbShowPrompt(await jpost('/wbedit/prompt/rollback/' + encodeURIComponent(n), {}));
    await wbLoadPromptRevs();
    wbPromptSay('restored revision ' + n + ' — minted as a new revision, nothing was rewound');
  } catch (e) {
    wbPromptSay(/** @type {ErrLike} */ (e).message || 'could not restore it', true);
  }
});

/** @type {VEl} */ ($('wbPromptSave')).addEventListener('click', async () => {
  const system = /** @type {HTMLTextAreaElement} */ ($('wbPromptSys')).value;
  const wrapper = /** @type {HTMLTextAreaElement} */ ($('wbPromptWrap')).value;
  if (!system.trim()) {
    wbPromptSay('the system prompt cannot be empty', true);
    return;
  }
  const shots = wbParseShots(/** @type {HTMLTextAreaElement} */ ($('wbPromptShots')).value);
  if (shots === null) {
    wbPromptSay('a few-shot pair needs a blank line between the user half and the assistant half', true);
    return;
  }
  if (
    !shots.length &&
    !(await wbConfirm(
      'Save with no few-shot pairs?',
      '<p>They are what stop this model emitting its reasoning before it answers — without them ' +
        'that reasoning can land inside the sentinels and be written into your text as content.</p>' +
        '<p class="small muted">Reset to default undoes this.</p>',
      'Save anyway',
      true,
    ))
  )
    return;
  try {
    wbShowPrompt(await jput('/wbedit/prompt', { system, shots, wrapper }));
    await wbLoadPromptRevs(); // m5a — the save it just made is a revision
    wbPromptSay('saved — every pass from now on uses this, and it is now a revision you can ' + 'come back to');
  } catch (e) {
    wbPromptSay(/** @type {ErrLike} */ (e).message || 'could not save', true);
  }
});

/** @type {VEl} */ ($('wbPromptReset')).addEventListener('click', async () => {
  // m5a — no longer the one-way door it was, and the wording says so. It used to be honest to warn
  // that this was unrecoverable; now the truthful thing is that it is recorded first.
  if (
    !(await wbConfirm(
      'Reset the prompt?',
      '<p>Reset the system prompt, the wrapper and the few-shot pairs to the ones the code ships ' +
        'with?</p>' +
        '<p class="small muted">What you have now is saved as a revision first, so you can bring it ' +
        'back from the revision picker.</p>',
      'Reset',
      true,
    ))
  )
    return;
  try {
    wbShowPrompt(await jdel('/wbedit/prompt'));
    await wbLoadPromptRevs();
    // ⚠️ Resetting when nothing was tuned records nothing, because there was nothing to lose —
    // so the message must not promise a revision that does not exist.
    const revSel = /** @type {HTMLSelectElement} */ ($('wbPromptRev'));
    const kept = (revSel.options[1] || {}).value;
    wbPromptSay(
      kept ? 'back to the default — the prompt you had is revision ' + kept + ', still there in the picker' : 'back to the default',
    );
  } catch (e) {
    wbPromptSay(/** @type {ErrLike} */ (e).message || 'could not reset', true);
  }
});

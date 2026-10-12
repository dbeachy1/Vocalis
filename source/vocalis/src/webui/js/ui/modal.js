// The overlay dialogs: `modal`, `confirmDelete`, `promptForName`, and the one backdrop hook the
// three of them share. 7.1 §5 — the first behavioral module, moved verbatim out of index.html.
//
// 🔴 THESE THREE MOVED TOGETHER BECAUSE `_overlayDismiss` IS SHARED STATE AND CANNOT BE SPLIT.
// Each dialog registers its own cancel in it and clears it in `done()`; the backdrop listener at
// the bottom is what calls it. Leave any one of them behind in the inline script and that one can
// no longer reach the variable — its backdrop click silently stops canceling, which looks like a
// dead dialog rather than a refactor that went half way.
//
// 🔴 AND THEY WERE ALLOWED TO MOVE BECAUSE NOTHING CALLS THEM AT PARSE TIME. A module is deferred:
// it runs after the whole classic inline script. The audit is in DESIGN_7_1_FRONTEND_REFACTOR.md
// §5.3 — the single top-level mention of `modal` is `$('vAddBtn').onclick = async () => { … }`,
// which ASSIGNS a handler, so the call happens on click, long after this file has run. Any future
// caller that runs during parsing would break, silently, with `undefined is not a function`.
//
// ⚠️ The remaining inline callers reach these through the transitional
// `Object.assign(window, …)` shim in index.html, which is deleted when the last of them becomes a
// module. Nothing here should ever reference `window`.

import { $, esc } from '../util/dom.js';

/** Dialog action shape local to the modal module. Promote it only if another module needs the type.

 * @template T
 * @typedef {object} ModalAction
 * @property {string} label
 * @property {string} [class] - `'primary'`/`'go'` take Enter; anything else (including
 *   omitted) does not. `'danger'` is styling only.
 * @property {T} value - resolved by `modal()`'s promise when this button is clicked.
 */

// Each dialog registers its own cancel here and clears it in `done()`; the backdrop calls it.
/** @type {(() => void) | null} */
let _overlayDismiss = null;

/**
 * Use at least one action so the dialog always has a resolution path. `wide` adjusts panel width; `tall` caps height at 90vh and scrolls the body to keep actions visible. The shared overlay clears these options between dialogs.
 * @template T
 * @param {string} title
 * @param {string} bodyHtml
 * @param {ModalAction<T>[]} actions
 * @param {{wide?: boolean, tall?: boolean}} [opts]
 * @returns {Promise<T>} the clicked value (or the first action on Esc or backdrop).
 */
export function modal(title, bodyHtml, actions, opts) {
  return new Promise(resolve => {
    /** @type {VEl} */ ($('mTitle')).textContent = title;
    /** @type {VEl} */ ($('mBody')).innerHTML = bodyHtml;
    /** @type {VEl} */ ($('mActs')).innerHTML = '';
    const panel = /** @type {HTMLElement} */ (/** @type {VEl} */ ($('overlay')).querySelector('.modal'));
    panel.classList.toggle('wide', !!(opts && opts.wide)); // a plain modal is never wide
    panel.classList.toggle('tall', !!(opts && opts.tall));
    /** @type {VEl|null} */
    let primaryBtn = null;
    /** @param {T} v */
    const done = v => {
      _overlayDismiss = null;
      document.removeEventListener('keydown', onKey);
      /** @type {VEl} */ ($('overlay')).classList.remove('on');
      resolve(v);
    };
    actions.forEach(a => {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.class) b.className = a.class;
      // 'go' (green) is a confirm just as much as 'primary' (blue) is — it must take
      // the Enter key too, or the greener a button gets the less it works.
      b.onclick = () => done(a.value);
      /** @type {VEl} */ ($('mActs')).appendChild(b);
      if (a.class === 'primary' || a.class === 'go') primaryBtn = /** @type {VEl} */ (/** @type {unknown} */ (b));
    });
    // Enter fires the primary action (never a 'danger' one); Esc cancels (first action).
    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (e.key === 'Enter' && primaryBtn && /** @type {HTMLElement} */ (e.target).tagName !== 'TEXTAREA') {
        e.preventDefault();
        primaryBtn.click();
      } else if (e.key === 'Escape' && actions.length) {
        e.preventDefault();
        done(actions[0].value);
      }
    }
    document.addEventListener('keydown', onKey);
    // The backdrop cancels exactly the way Esc does — the first action, which is the cancel by
    // convention. A dialog with no actions cannot be canceled and must not be dismissible.
    _overlayDismiss = actions.length ? () => done(actions[0].value) : null;
    /** @type {VEl} */ ($('overlay')).classList.add('on');
    const fi = /** @type {HTMLElement|null} */ (/** @type {VEl} */ ($('mBody')).querySelector('input,textarea,select'));
    if (fi) fi.focus();
  });
}

/**
 * type-DELETE confirmation for destructive actions (reuses the modal overlay). Enter fires
 * Delete but only proceeds when the box says "delete" (case-insensitive); Esc cancels.
 * @param {string} title
 * @param {string} bodyHtml
 * @returns {Promise<boolean>}
 */
export function confirmDelete(title, bodyHtml) {
  return new Promise(resolve => {
    /** @type {VEl} */ ($('mTitle')).textContent = title;
    /** @type {VEl} */ ($('mBody')).innerHTML = bodyHtml;
    /** @type {VEl} */ ($('mActs')).innerHTML = '';
    /** @param {boolean} v */
    const done = v => {
      _overlayDismiss = null;
      document.removeEventListener('keydown', onKey);
      /** @type {VEl} */ ($('overlay')).classList.remove('on');
      resolve(v);
    };
    const inp = /** @type {HTMLInputElement|null} */ (/** @type {VEl} */ ($('mBody')).querySelector('#delType'));
    const tryDel = () => {
      if (((inp && inp.value) || '').trim().toLowerCase() === 'delete') done(true);
      else if (inp) {
        inp.style.borderColor = 'var(--err)';
        inp.focus();
      }
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => done(false);
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'danger';
    del.onclick = tryDel;
    /** @type {VEl} */ ($('mActs')).appendChild(cancel);
    /** @type {VEl} */ ($('mActs')).appendChild(del);
    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryDel();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    }
    // Backdrop == Cancel, never Delete. A destructive dialog must not be confirmable by a click
    // that lands outside it.
    _overlayDismiss = () => done(false);
    document.addEventListener('keydown', onKey);
    /** @type {VEl} */ ($('overlay')).classList.add('on');
    if (inp) inp.focus();
  });
}

/**
 * @typedef {object} PromptOpts
 * @property {string} title
 * @property {string} blurb
 * @property {string} okLabel
 * @property {string} [placeholder]
 * @property {string} [initial] - pre-filled value.
 * @property {string} [error] - a message from a previous, rejected attempt.
 * @property {string} [required] - the inline error shown when the box is left blank; defaults
 *   to "Give it a name."
 */

// The one-field name dialog. Extracted when §17's templates needed the same thing with different
// words: the plumbing — Enter/Escape, the backdrop dismiss, restoring `_overlayDismiss`, the
// inline required-error — is fiddly enough that a second copy would drift, and the copy that
// drifts is the one that stops closing on Escape.
/**
 * @param {PromptOpts} o
 * @returns {Promise<string|null>} the trimmed name, or `null` for cancel/Esc/backdrop.
 */
export function promptForName(o) {
  return new Promise(resolve => {
    /** @type {VEl} */ ($('mTitle')).textContent = o.title;
    /** @type {VEl} */ ($('mBody')).innerHTML = `<div class="small muted">${o.blurb}</div>
      ${o.error ? `<div class="small drop" style="margin-top:8px">${esc(o.error)}</div>` : ''}
      <input type="text" id="vcNameIn" style="width:100%;margin-top:10px" placeholder="${esc(o.placeholder || '')}" value="${esc(o.initial || '')}">
      <div class="small drop" id="vcNameErr" style="margin-top:6px;display:none">${esc(o.required || 'Give it a name.')}</div>`;
    /** @type {VEl} */ ($('mActs')).innerHTML = '';
    /** @type {HTMLElement} */ (/** @type {VEl} */ ($('overlay')).querySelector('.modal')).classList.remove('wide');
    /** @param {string|null} v */
    const done = v => {
      _overlayDismiss = null;
      document.removeEventListener('keydown', onKey);
      /** @type {VEl} */ ($('overlay')).classList.remove('on');
      resolve(v);
    };
    // `<input type="text">`, built by the template literal above — hence the kind, once, here.
    const inp = /** @type {HTMLInputElement} */ ($('vcNameIn'));
    const ok = () => {
      const v = inp.value.trim();
      if (!v) {
        /** @type {VEl} */ ($('vcNameErr')).style.display = '';
        inp.style.borderColor = 'var(--err)';
        inp.focus();
        return;
      }
      done(v);
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => done(null);
    const save = document.createElement('button');
    save.textContent = o.okLabel;
    save.className = 'ok';
    save.onclick = ok;
    /** @type {VEl} */ ($('mActs')).appendChild(cancel);
    /** @type {VEl} */ ($('mActs')).appendChild(save);
    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        ok();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      }
    }
    _overlayDismiss = () => done(null); // backdrop == Cancel, same as Esc
    document.addEventListener('keydown', onKey);
    /** @type {VEl} */ ($('overlay')).classList.add('on');
    inp.focus();
    inp.select();
  });
}

// 📌 THIS LISTENER MOVED WITH THEM AND HAD TO. It is the only reader of `_overlayDismiss`, which is
// now module-private; left in index.html it would reference a name that no longer exists there.
// Registering it at module-evaluation time is safe for the opposite reason the deferral rule bites
// elsewhere: a module runs after the document is parsed, so `#overlay` is guaranteed to be present.
/** @type {VEl} */ ($('overlay')).addEventListener('click', e => {
  if (/** @type {HTMLElement} */ (e.target).id !== 'overlay') return;
  // Route through the live dialog's own cancel so the promise resolves and its keydown listener
  // comes off. The bare class-removal fallback is for the two non-promise panels that own their
  // overlay directly and register nothing on document.
  if (_overlayDismiss) {
    const d = _overlayDismiss;
    _overlayDismiss = null;
    d();
  } else /** @type {VEl} */ ($('overlay')).classList.remove('on');
});

// ── the two wb dialog wrappers (7.1-m8) ─────────────────────────────────────
// 📌 THEY LIVE HERE BECAUSE THEY ARE DIALOGS, not because `prompt.js` needed them first.
// Both are thin wrappers over `modal` and both are called from all over the editor —
// `wbConfirm` from 8 sites, `wbAskName` from 5 — so putting them in whichever module
// happened to move next would have made that module everyone's dependency. §5.4 moved
// all three dialogs together for the same reason.

// ── Assemble: many section chunks -> ONE named worldbook (§6.5) ───────────
//
// Worldbooks may be assembled from multiple files, so the server owns filename ordering and uid
// assignment.
//
// 🔴 THE SERVER SORTS BY FILENAME. The A_/B_/…/X_ prefixes decide uid assignment and a
// multi-file <input> hands them over in whatever order it likes. Do NOT sort here as well and
// do not "helpfully" reorder — one authority, and it is the one that also runs for the ST
// import path.
// 🔴 THE APP'S OWN MODAL, NEVER `prompt()`. The native dialog is browser chrome, not Vocalis's —
// it says "host:port says", it ignores every color
// and font on the page, and it is the one piece of UI here that looks like a phishing page. It is
// also modal to the whole tab, which is why it cannot be styled out of the problem.
//
// Returns the trimmed string, or `null` for cancel. Blank counts as cancel: a nameless worldbook
// is the thing the caller was asking about.
// 🔴 **THE APP'S OWN YES/NO, AND `confirm()` IS BANNED OUTRIGHT.** Use a reusable styled modal
// rather than native browser confirmation chrome.
//
// ⚠️ `modal()` is already available in this module; use it consistently instead of native dialogs.
//
// `body` is HTML, not text: a native dialog took `\n\n` and this takes paragraphs, which is the
// only edit any of the six call sites needed.
//
// 📌 Prefer `confirmDelete` for anything irreversible — it requires typing DELETE. This is for the
// ordinary "are you sure", where a wrong click costs a revision rather than the data.
/**
 * @param {string} title
 * @param {string} bodyHtml
 * @param {string} [okLabel] - defaults to `'OK'`.
 * @param {boolean} [danger] - styles the confirm button `danger` instead of `primary`.
 * @returns {Promise<boolean>}
 */
export async function wbConfirm(title, bodyHtml, okLabel, danger) {
  return !!(await modal(title, bodyHtml, [
    { label: 'Cancel', value: 0 },
    { label: okLabel || 'OK', class: danger ? 'danger' : 'primary', value: 1 },
  ]));
}

/**
 * @param {string} title
 * @param {string} help
 * @param {string} [initial] - pre-filled value.
 * @returns {Promise<string|null>} the trimmed name, or `null` for cancel/blank.
 */
export async function wbAskName(title, help, initial) {
  const id = 'wbAskName_' + Math.random().toString(36).slice(2, 9);
  const ok = await modal(
    title,
    '<div class="small muted" style="margin-bottom:8px">' +
      esc(help) +
      '</div>' +
      '<input type="text" id="' +
      id +
      '" class="filter" style="width:100%" ' +
      'autocomplete="off" spellcheck="false" value="' +
      esc(initial || '') +
      '">',
    [
      { label: 'Cancel', value: 0 },
      { label: 'OK', class: 'primary', value: 1 },
    ],
  );
  if (!ok) return null;
  // `modal` has already torn the overlay down, so the node is read before it goes — which is why
  // the value is pulled inside this function rather than by the caller.
  const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
  const v = (el ? el.value : '').trim();
  return v || null;
}

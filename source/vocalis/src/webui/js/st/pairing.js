// SillyTavern pairing controls: reveal, rotate, unpair, and copy the vault-backed token.
// `pairLoad` runs on Settings entry so a locked-vault response remains distinct from “unpaired.”
// A 423 means status is unknown; generating from that state after unlock could revoke a working token.
// Each render masks the token until explicitly revealed. Use a CSS class rather than input type=password
// to avoid browser credential saving and preserve the select-to-copy fallback when clipboard access fails.
// All four controls bind at module load; `pairLoad` is the module's only export. Dependencies are imports,
// not inline page globals.

import { $ } from '../util/dom.js';
import { jget, jpost, jdel } from '../util/http.js';
import { modal } from '../ui/modal.js';
// ── SillyTavern pairing (7.0 §8, m2) ─────────────────────────────────────────
// Same masking discipline as the Kobold field directly above, and for the same reasons: the
// class moves, `el.type` never does.
/** @type {VEl} */ ($('pairShow')).addEventListener('change', () => {
  /** @type {VEl} */ ($('pairToken')).classList.toggle('masked', !(/** @type {HTMLInputElement} */ ($('pairShow')).checked));
});

/**
 * @typedef {object} PairingResp
 * @property {boolean} paired
 * @property {string} token
 */
/** @param {PairingResp} j */
function pairRender(j) {
  /** @type {HTMLInputElement} */ ($('pairToken')).value = j.token || '';
  /** @type {VEl} */ ($('pairState')).textContent = j.paired
    ? 'Paired. Paste this into the Vocalis extension in SillyTavern.'
    : 'Not paired — the extension cannot reach Vocalis until you generate a token.';
  // Showing is a deliberate act each time, exactly as the Kobold field treats it: a token left
  // legible on screen outlives the reason it was revealed.
  /** @type {HTMLInputElement} */ ($('pairShow')).checked = false;
  /** @type {VEl} */ ($('pairToken')).classList.add('masked');
  /** @type {HTMLButtonElement} */ ($('pairCopy')).disabled = /** @type {HTMLButtonElement} */ ($('pairClear')).disabled = !j.paired;
}

export async function pairLoad() {
  try {
    pairRender(await jget('/wbedit/pairing'));
  } catch (e) {
    // 🔴 A LOCKED VAULT IS NOT AN UNPAIRED ONE. The token lives in the vault, so a 423 means
    // "cannot tell", and rendering that as "Not paired" could lead the user to press Generate —
    // which, after unlocking, would REVOKE a working pairing.
    /** @type {VEl} */ ($('pairState')).textContent =
      /** @type {ErrLike} */ (e).status === 423
        ? 'The vault is locked — unlock it to see whether SillyTavern is paired.'
        : /** @type {ErrLike} */ (e).message || 'could not check the pairing.';
    /** @type {HTMLInputElement} */ ($('pairToken')).value = '';
    /** @type {HTMLButtonElement} */ ($('pairCopy')).disabled = /** @type {HTMLButtonElement} */ ($('pairClear')).disabled = true;
  }
}

/** @type {VEl} */ ($('pairNew')).addEventListener('click', async () => {
  if (
    /** @type {HTMLInputElement} */ ($('pairToken')).value &&
    !(await modal(
      'Generate a new pairing token?',
      'The current token stops working <b>immediately</b>. SillyTavern will not be able to reach ' +
        'Vocalis until you paste the new one into the extension.',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Generate', class: 'danger', value: 1 },
      ],
    ))
  )
    return;
  try {
    pairRender(await jpost('/wbedit/pairing/rotate'));
  } catch (e) {
    /** @type {VEl} */ ($('pairState')).textContent = /** @type {ErrLike} */ (e).message || 'could not generate a pairing token.';
  }
});

/** @type {VEl} */ ($('pairClear')).addEventListener('click', async () => {
  if (
    !(await modal(
      'Unpair SillyTavern?',
      'The extension will no longer be able to reach Vocalis. You can generate a new token ' + 'at any time.',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Unpair', class: 'danger', value: 1 },
      ],
    ))
  )
    return;
  try {
    pairRender(await jdel('/wbedit/pairing'));
  } catch (e) {
    /** @type {VEl} */ ($('pairState')).textContent = /** @type {ErrLike} */ (e).message || 'could not clear the pairing.';
  }
});

/** @type {VEl} */ ($('pairCopy')).addEventListener('click', async () => {
  const v = /** @type {HTMLInputElement} */ ($('pairToken')).value;
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v);
    /** @type {VEl} */ ($('pairState')).textContent = 'Copied.';
  } catch (e) {
    // Clipboard access is refused outside a secure context and on some browsers without a
    // gesture. Select the text so the copy is still one keystroke away rather than impossible.
    /** @type {HTMLInputElement} */ ($('pairShow')).checked = true;
    /** @type {VEl} */ ($('pairToken')).classList.remove('masked');
    /** @type {VEl} */ ($('pairToken')).removeAttribute('readonly');
    /** @type {HTMLInputElement} */ ($('pairToken')).select();
    /** @type {VEl} */ ($('pairState')).textContent = 'Could not reach the clipboard — the token is selected, press Ctrl+C.';
  }
});

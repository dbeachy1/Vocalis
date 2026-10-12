// Nomi pairing uses a separate token from SillyTavern so rotating one credential cannot revoke the other.
// `nomiPairLoad` runs on Settings entry so a locked-vault response remains distinct from “unpaired.”
// `ui/tabs.js` imports this module directly; its four controls bind at module load, while `nomiPairLoad`
// is the only export. Dependencies are imports, not inline page globals.

import { $ } from '../util/dom.js';
import { jget, jpost, jdel } from '../util/http.js';
import { modal } from '../ui/modal.js';
// ── Nomi pairing (7.2-m4) ────────────────────────────────────────────────────
// 🔴 A SEPARATE TOKEN FROM THE SILLYTAVERN ONE, on purpose. Two clients, two install paths, two
// rotations — revoking a leaked Nomi credential must not stop SillyTavern narration. The
// handlers deliberately MIRROR js/st/pairing.js rather than being factored together with it: the
// shared part is ~15 lines of DOM plumbing, and a shared helper parameterized by four element ids
// and three sentences of copy would be harder to read than the duplicate, while making it easy to
// accidentally point both panels at one endpoint. The thing that must never be shared is the URL,
// and separate files make that obvious on sight — more obvious than the adjacent blocks did.
/** @type {VEl} */ ($('nomiPairShow')).addEventListener('change', () => {
  /** @type {VEl} */ ($('nomiPairToken')).classList.toggle('masked', !(/** @type {HTMLInputElement} */ ($('nomiPairShow')).checked));
});

/**
 * @typedef {object} NomiPairingResp
 * @property {boolean} paired
 * @property {string} token
 */
/** @param {NomiPairingResp} j */
function nomiPairRender(j) {
  /** @type {HTMLInputElement} */ ($('nomiPairToken')).value = j.token || '';
  /** @type {VEl} */ ($('nomiPairState')).textContent = j.paired
    ? 'Paired. Paste this into the Chrome extension’s Options page.'
    : 'Not paired — the extension cannot speak until you generate a token.';
  /** @type {HTMLInputElement} */ ($('nomiPairShow')).checked = false;
  /** @type {VEl} */ ($('nomiPairToken')).classList.add('masked');
  /** @type {HTMLButtonElement} */ ($('nomiPairCopy')).disabled = /** @type {HTMLButtonElement} */ ($('nomiPairClear')).disabled =
    !j.paired;
}

export async function nomiPairLoad() {
  try {
    nomiPairRender(await jget('/nomi/pairing'));
  } catch (e) {
    // 🔴 A LOCKED VAULT IS NOT AN UNPAIRED ONE — same trap as the SillyTavern panel. Rendering
    // 423 as "Not paired" invites a Generate that REVOKES a working pairing to fix nothing.
    /** @type {VEl} */ ($('nomiPairState')).textContent =
      /** @type {ErrLike} */ (e).status === 423
        ? 'The vault is locked — unlock it to see whether Nomi is paired.'
        : /** @type {ErrLike} */ (e).message || 'could not check the pairing.';
    /** @type {HTMLInputElement} */ ($('nomiPairToken')).value = '';
    /** @type {HTMLButtonElement} */ ($('nomiPairCopy')).disabled = /** @type {HTMLButtonElement} */ ($('nomiPairClear')).disabled = true;
  }
}

/** @type {VEl} */ ($('nomiPairNew')).addEventListener('click', async () => {
  if (
    /** @type {HTMLInputElement} */ ($('nomiPairToken')).value &&
    !(await modal(
      'Generate a new Nomi pairing token?',
      'The current token stops working <b>immediately</b>. The Chrome extension will not be able ' +
        'to speak until you paste the new one into its Options page. ' +
        '<br><br>This does <b>not</b> affect SillyTavern — that token is separate.',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Generate', class: 'danger', value: 1 },
      ],
    ))
  )
    return;
  try {
    nomiPairRender(await jpost('/nomi/pairing/rotate'));
  } catch (e) {
    /** @type {VEl} */ ($('nomiPairState')).textContent = /** @type {ErrLike} */ (e).message || 'could not generate a pairing token.';
  }
});

/** @type {VEl} */ ($('nomiPairClear')).addEventListener('click', async () => {
  if (
    !(await modal(
      'Unpair Nomi?',
      'The Chrome extension will no longer be able to reach /speak. You can generate a new token ' + 'at any time.',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Unpair', class: 'danger', value: 1 },
      ],
    ))
  )
    return;
  try {
    nomiPairRender(await jdel('/nomi/pairing'));
  } catch (e) {
    /** @type {VEl} */ ($('nomiPairState')).textContent = /** @type {ErrLike} */ (e).message || 'could not clear the pairing.';
  }
});

/** @type {VEl} */ ($('nomiPairCopy')).addEventListener('click', async () => {
  const v = /** @type {HTMLInputElement} */ ($('nomiPairToken')).value;
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v);
    /** @type {VEl} */ ($('nomiPairState')).textContent = 'Copied.';
  } catch (e) {
    /** @type {HTMLInputElement} */ ($('nomiPairShow')).checked = true;
    /** @type {VEl} */ ($('nomiPairToken')).classList.remove('masked');
    /** @type {VEl} */ ($('nomiPairToken')).removeAttribute('readonly');
    /** @type {HTMLInputElement} */ ($('nomiPairToken')).select();
    /** @type {VEl} */ ($('nomiPairState')).textContent = 'Could not reach the clipboard — the token is selected, press Ctrl+C.';
  }
});

// sys/login.js — the ⚙ Settings tab's two credential controls: change the admin login, and mint a
// new vault recovery key (7.3-m4s, closing §5's m4).
//
// 63 lines, one contiguous cut, three definitions and three wirings. It is the last piece of §5's
// m4 group — `sys/comfy.js` and `sys/model.js` landed at m4c, and this sat unclaimed because the
// parse-time pin's note on it read *"security-sensitive area (vault recovery key, CSRF) with a
// standing do-not-split note. Read it first."* Read first, then moved: see the three checks below.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 IT EXPORTS NOTHING, AND HERE THAT IS A SECURITY PROPERTY AS WELL AS A MEASUREMENT.
//
// The fourth bare side-effect import, after `wb/wire.js`, `voice/autoplay.js` and
// `voice/rvcimport.js`. Measured first, as with those three: `applyLogin`, `showRecoveryKey` and
// `rotateRecovery` have zero references outside this range, in the page or in the module tree, and
// all three wiring statements sit inside it.
//
// 📌 But this one would be worth not exporting even if something did call it. `applyLogin` changes
// the admin password and, on an encrypted install, makes the server RE-WRAP the vault DEK;
// `rotateRecovery` immediately revokes the current recovery key. Putting either on
// `Object.assign(window, …)` hands every script on the page — and the console — a one-word route
// to both. Nothing published, nothing to call.
//
// ⚠️ SO THE IMPORT IS THE WHOLE FEATURE. Drop the line from index.html's shim and Apply, Generate
// new recovery key, and Enter-in-the-password-field all go silently dead, with no ReferenceError
// to say so.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ TWO NAMES LEAVE `_PARSE_TIME_SURFACE` IN ONE COMMIT, BOTH THE EASY WAY.
//
//     $('applyLogin').onclick=applyLogin;              ← bare values, read during PARSING
//     $('rotateRecovery').onclick=rotateRecovery;
//
// Both wiring statements were inside the moved range, so they traveled with their functions and
// now resolve against hoisted local declarations — no arrow, nothing left behind in the page. That
// is the m4r/m6b shape and it is the preferred one; the pin is down to a list that is now mostly
// names whose wiring belongs to a block owned by no feature. Five names have left it in total.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE THREE THINGS "READ IT FIRST" MEANT, CHECKED RATHER THAN ASSUMED:
//
//   1. 🔴 `index.html` IS A TEMPLATE AND A MODULE IS NOT. `index()` substitutes `{{CSRF}}`,
//      `{{ADMIN_USER}}` and `{{UI_STATE}}` at serve time; `/webui/js/<path>` serves bytes, so a
//      placeholder moved into a module ships as the literal seven characters — and a CSRF token
//      that is the string "{{CSRF}}" fails every state-changing POST on this page.
//      ✅ **Checked: there are no `{{…}}` placeholders anywhere in the moved range.** `CSRF` is
//      read from a `<meta name=csrf>` element by an inline `const`, which is the pattern
//      DESIGN_7_1 §3 prescribes for exactly this reason, and it stays inline (§11.4's list).
//   2. 🔴 THE TWO GUARDS IN `applyLogin` READ `ENCRYPTED`, AND A STALE COPY DISARMS BOTH — the
//      one demanding the current password before a re-wrap, and the one refusing to remove the
//      login while a vault exists. `ENCRYPTED` is a `let` the /health poller REASSIGNS, so it is
//      on §11.4's never-put-this-on-the-shim list and stays declared in the page. This module
//      reaches it as an inline global, resolved at CALL time, which reads the live binding.
//      ✅ That is the correct direction (§3.1) and the whole point of the asymmetry.
//   3. ✅ Behavior is byte-identical. §6 step 4: nothing reformatted, nothing renamed, no
//      "while I'm here" guard added — including the unguarded `$('applyLogin').onclick=…`, which
//      is safe because the ⚙ tab's markup is unconditional (the page has no `{% %}` blocks at all).
//
// ⚠️ `applyLogin` HAD NO BANNER OF ITS OWN — it sat under `── 5.0-M8: account-local UI state lives
// server-side ──`, which is the `UIS` shim and has nothing to do with credentials. Third instance
// of §11.10 in this milestone, and the useful part is that the measurement HID the pairing: ranked
// by banner, "admin login" scored 5 lines and "Recovery-key rotation" 85, so the two halves of this
// file looked like a small nothing and a separate medium thing. They are adjacent in the source.

import { $, esc } from '../util/dom.js';
import { CSRF } from '../util/uistate.js'; // 7.3-m13
import { modal } from '../ui/modal.js';
import { pollReady } from './model.js';
// ✅ 7.3-m12d. `ENCRYPTED` was an inline global this file reached at call time, and the header's
// point 2 below is why that was tolerable and never comfortable: a stale copy disarms both vault
// guards in `applyLogin`. It is a live module binding now — `pollReady` calls `setEncrypted` and
// this file sees the new value on the next read, by specification rather than by the shim's luck.
// ⚠️ `CSRF` STAYS an inline global for one more milestone: the `UIS` factory is a top-level IIFE
// that reads it AT PARSE TIME, so both move together at m13.
import { ENCRYPTED } from './modelstate.js';

async function applyLogin() {
  const u = /** @type {HTMLInputElement} */ ($('setU')).value.trim(),
    p = /** @type {HTMLInputElement} */ ($('setP')).value,
    p2 = /** @type {HTMLInputElement} */ ($('setP2')).value,
    cur = /** @type {HTMLInputElement} */ ($('setCur')).value;
  if (p !== p2) {
    await modal('Passwords do not match', 'Re-enter the password and confirmation.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  // ONE PASSWORD, TWO USES. With a vault, the server re-wraps the DEK before it writes the new
  // login hash, and it needs the CURRENT password to do that — so the form must collect it. It
  // did not, and every password change on an encrypted install 401'd with no field to fix it.
  if (ENCRYPTED && p && !cur) {
    await modal(
      'Current password required',
      'Encryption is on, so changing this password also re-wraps your vault key — which needs the password you use today.',
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    return;
  }
  if (!p && ENCRYPTED) {
    await modal(
      'Cannot remove the login',
      'Encryption is on, and the login password is what unwraps your vault key. A vault with no login can never be unlocked. Turn encryption off first if you really want an open UI.',
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    return;
  }
  if (
    !p &&
    !(await modal('Remove the login?', 'This clears the admin password — the web UI becomes <b>open</b> to anyone on the LAN. Continue?', [
      { label: 'Cancel', value: 0 },
      { label: 'Remove login', class: 'danger', value: 1 },
    ]))
  )
    return;
  try {
    const r = await fetch('/admin/set-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ username: u, password: p, current_password: cur }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const d = await r.json();
    /** @type {HTMLInputElement} */ ($('setP')).value = '';
    /** @type {HTMLInputElement} */ ($('setP2')).value = '';
    /** @type {HTMLInputElement} */ ($('setCur')).value = '';
    await modal(
      'Saved',
      d.auth
        ? 'Admin login is now <b>on</b>. Use your username and password next time.'
        : 'Admin login is now <b>off</b> — the UI is open on the LAN.',
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    pollReady();
  } catch (e) {
    await modal('Could not save', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
}
/** @type {VEl} */ ($('applyLogin')).onclick = applyLogin;

// ── Recovery-key rotation ───────────────────────────────────────────────────
// Shown ONCE. The server keeps only the wrap the key produces, never the key, so there is no
// "show it again" route to fall back on — by design. That makes this modal the single moment
// it can be written down, which is why the confirm step warns BEFORE the key is minted rather
// than after: once the POST returns, the old key is already dead.
/** @param {string} key */
function showRecoveryKey(key) {
  const body =
    '<p>Write this down and keep it somewhere safe — ideally <b>offline</b>. It is shown once and is not stored on the server.</p>' +
    '<pre id="recKeyOut" style="user-select:all;white-space:pre-wrap;word-break:break-all;font-size:1.071429rem;' +
    'line-height:1.7;padding:10px;border-radius:6px;background:var(--bg);border:1px solid var(--line)">' +
    esc(key) +
    '</pre>' +
    '<p><button id="recKeyCopy">Copy</button> <span class="small muted" id="recKeyMsg"></span></p>' +
    '<p class="small muted">Your old recovery key no longer works. Your password and your data are unchanged.</p>';
  // Attached AFTER the call, not inside the actions list: an action button resolves and CLOSES
  // the modal, and Copy must not. modal() sets mBody synchronously in the promise executor, so
  // the node exists by the time this line runs.
  const p = modal('Your new recovery key', body, [{ label: 'I have written it down', class: 'primary', value: 1 }]);
  const btn = $('recKeyCopy');
  if (btn)
    btn.onclick = async () => {
      // navigator.clipboard is undefined on a plain-http LAN origin — which is exactly how Vocalis
      // is served — so Copy is best effort and the key stays selectable either way.
      try {
        await navigator.clipboard.writeText(key);
        /** @type {VEl} */ ($('recKeyMsg')).textContent = 'Copied to the clipboard.';
      } catch (e) {
        /** @type {VEl} */ ($('recKeyMsg')).textContent = 'Could not copy automatically — select the key above and copy it.';
      }
    };
  return p;
}
async function rotateRecovery() {
  const pw = /** @type {HTMLInputElement} */ ($('recPw')).value;
  if (!pw) {
    await modal('Password required', 'Confirm your password to generate a new recovery key.', [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  if (
    !(await modal(
      'Replace your recovery key?',
      'This generates a new recovery key and <b>immediately revokes the current one</b>. Any copy of the old key you have written down stops working.<br><br>Your password, your login and your data are unchanged, and you stay logged in.<br><br>The new key is shown <b>once</b> — have somewhere to write it down before you continue.',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Generate new key', class: 'danger', value: 1 },
      ],
    ))
  )
    return;
  const btn = /** @type {HTMLButtonElement} */ ($('rotateRecovery'));
  btn.disabled = true;
  try {
    const r = await fetch('/vault/rotate-recovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ password: pw }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const d = await r.json();
    /** @type {HTMLInputElement} */ ($('recPw')).value = '';
    await showRecoveryKey(d.recovery_key);
  } catch (e) {
    await modal('Could not generate a new key', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    btn.disabled = false;
  }
}
/** @type {VEl} */ ($('rotateRecovery')).onclick = rotateRecovery;
// The field is not in a <form>, so Enter did nothing at all — you had to reach for the mouse
// after typing the password. Fire the button instead.
/** @type {VEl} */ ($('recPw')).addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    rotateRecovery();
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ THE `── admin login ──` BANNER'S LAST TWO LINES ARRIVED AT 7.3-m12d, and they were the entire
// remaining content of a banner whose functions moved at m4s. `ADMIN_USER` is read EXACTLY ONCE —
// here — to seed the username box with whoever is currently logged in, so that changing only the
// password does not require retyping the name.
//
// ⚠️ IT COMES FROM A `<meta>` TAG, NOT FROM A `{{…}}` SUBSTITUTION, which is what makes it movable
// at all. This file's own header warns that `index.html` is a template and a module is not — true,
// and it is why the header also records checking that no `{{…}}` placeholder was in the moved
// range. `<meta name="admin-user">` is ordinary markup this module reads at module-eval, after the
// document is parsed. 📌 The same is true of `CSRF`, and the shim's note claiming otherwise is
// wrong (§11.27's shape); what actually holds `CSRF` in the page is the parse-time `UIS` IIFE.
const ADMIN_USER = /** @type {HTMLMetaElement} */ (document.querySelector('meta[name="admin-user"]') || {}).content || 'admin';
/** @type {HTMLInputElement} */ ($('setU')).value = ADMIN_USER;

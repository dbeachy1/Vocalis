// Chrome supplies the extension APIs used here. Their callback-based storage contract is declared
// in `types/host-chrome.d.ts` for static checking.
'use strict';

// The extension's two settings: the Vocalis server base URL that content.js posts /speak to,
// and the pairing token it authenticates with. Stored in chrome.storage.sync so they follow the
// signed-in profile.
//
// Gated speech endpoints require the Vocalis pairing token. It is separate from the SillyTavern
// token, so either client can be rotated independently.
const DEFAULT_SERVER = 'http://127.0.0.1:7870';
/**
 * `document.getElementById`, for the six ids `options.html` defines.
 *
 * ⚠️ THE NON-NULL IS A DELIBERATE LIE, AND IT IS THE SAME ONE `src/webui/js/util/dom.js`
 * MAKES. Every id passed here is a literal that this extension's own `options.html` declares, so a
 * null means the markup was edited without the script - which stays a runtime "Cannot read
 * properties of null", exactly as it is today. The checker was never going to catch that.
 *
 * ⚠️ IT DOES NOT WIDEN THE ELEMENT TYPE, THOUGH, AND THAT IS WHERE IT PARTS FROM `dom.js`.
 * Six elements is few enough to name each one where it is used, so `$('status').value` is still an
 * error here rather than a lie every future reader has to be told about.
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
// Use `el`, not `$`: script-level declarations share a TypeScript global scope with the
// SillyTavern extension, where `$` is the jQuery helper.
const el = id => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {string} url whatever is in the server box
 * @returns {string} the URL with trailing slashes stripped, or the default when it is blank
 */
function normalize(url) {
  return (url || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER; // strip trailing slash(es)
}

// ⚠️ Trim only. The token is 32 url-safe bytes from `secrets.token_urlsafe`, so it survives a
// copy-paste unescaped — but a stray leading/trailing space from selecting the line in a browser
// is the single most likely paste error, and it would fail `hmac.compare_digest` with no clue.
/**
 * @param {string} t whatever is in the token box
 * @returns {string}
 */
function normalizeToken(t) {
  return (t || '').trim();
}

// Load the saved values (or the defaults) into the fields.
chrome.storage.sync.get({ server: DEFAULT_SERVER, token: '' }, ({ server, token }) => {
  /** @type {HTMLInputElement} */ (el('server')).value = server;
  /** @type {HTMLInputElement} */ (el('token')).value = token;
});

function save() {
  const server = normalize(/** @type {HTMLInputElement} */ (el('server')).value);
  const token = normalizeToken(/** @type {HTMLInputElement} */ (el('token')).value);
  chrome.storage.sync.set({ server, token }, () => {
    /** @type {HTMLInputElement} */ (el('server')).value = server; // reflect the normalized value
    /** @type {HTMLInputElement} */ (el('token')).value = token;
    // Say WHICH state was saved. "Saved ✓" over an empty token box is how someone concludes the
    // extension is configured and then spends an evening on a silent 401.
    el('status').textContent = token ? 'Saved ✓' : 'Saved — but no token, so Vocalis will refuse';
    el('status').style.color = token ? '#1a9e4b' : '#b26a00';
    setTimeout(
      () => {
        el('status').textContent = '';
      },
      token ? 1500 : 4000,
    );
  });
}

el('save').addEventListener('click', save);
for (const id of ['server', 'token']) {
  el(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') save();
  });
}

// ── Connection and token test ────────────────────────────────────────────────
//
// 🔴 TWO REQUESTS, DELIBERATELY, BECAUSE THERE ARE TWO SETTINGS AND THEY FAIL DIFFERENTLY.
// `/health` is open, so it isolates "can I reach this address at all" from anything about
// credentials; `/speak/ping` is behind the very same gate a real `/speak` goes through, so it
// tests the token without rendering a syllable. Collapsing them into one call would report a
// wrong URL and a wrong token identically, which is the exact confusion this button exists to
// remove.
//
// ⚠️ IT TESTS WHAT IS IN THE BOXES, NOT WHAT WAS SAVED. Testing the saved values would make
// "edit, test, it works, forget to save" a trap the button itself sets.
/**
 * @param {'ok'|'bad'|'busy'} kind the `#result` class; `options.html` styles exactly these three
 * @param {string} title the bold first line
 * @param {string} [detail] the sentence under it, absent for a verdict that needs no explanation
 */
function show(kind, title, detail) {
  const box = el('result');
  box.className = kind;
  box.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = title;
  box.appendChild(b);
  if (detail) box.appendChild(document.createTextNode(detail));
}

async function test() {
  const server = normalize(/** @type {HTMLInputElement} */ (el('server')).value);
  const token = normalizeToken(/** @type {HTMLInputElement} */ (el('token')).value);
  /** @type {HTMLButtonElement} */ (el('test')).disabled = /** @type {HTMLButtonElement} */ (el('save')).disabled = true;
  show('busy', 'Testing…', `${server}`);
  try {
    // ── 1. the address ──
    // ⚠️ A TIMEOUT, because an unreachable-but-routable host does not refuse — it hangs until
    // the browser's own timeout, which is far longer than anyone will wait staring at a button.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let health;
    try {
      health = await fetch(`${server}/health`, { signal: ctrl.signal });
    } catch (e) {
      // 📌 The browser will not say WHY (CORS and DNS and refused-connection are one opaque
      // TypeError by design), so name the three real causes rather than guessing at one.
      show(
        'bad',
        'Could not reach the server.',
        `Nothing answered at ${server}. Check the address and port, that Vocalis is running, and ` +
          'that a non-localhost address uses https:// with a certificate this browser trusts.',
      );
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!health.ok) {
      show(
        'bad',
        `The server answered ${health.status} on /health.`,
        'Something is listening at that address, but it does not look like Vocalis.',
      );
      return;
    }
    // 🔴 CONFIRM IT IS VOCALIS, not merely something that returns 200. A wrong port on a box
    // running several services is the likeliest misconfiguration, and "reachable" would
    // otherwise be reported as success right before /speak fails for a reason this button
    // already had the evidence to name.
    let locked = false;
    try {
      const h = await health.json();
      if (h.product !== 'Vocalis') {
        show('bad', 'That address is not Vocalis.', 'Something else is running on this port. Check the port number.');
        return;
      }
      locked = !!h.locked;
    } catch (e) {
      show('bad', 'That address is not Vocalis.', 'It answered, but not with anything Vocalis says.');
      return;
    }

    // ── 2. the token ──
    if (!token) {
      show(
        'bad',
        'The server is reachable, but no pairing token is set.',
        'Open Vocalis ▸ ⚙ Settings ▸ Nomi extension, press Generate, copy the token, and paste ' + 'it above.',
      );
      return;
    }
    const ping = await fetch(`${server}/speak/ping`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (ping.ok) {
      show('ok', 'Working.', `${server} is reachable and this token is accepted.`);
      return;
    }
    if (ping.status === 401) {
      // 🔴 LOCKED IS NOT UNPAIRED, and telling them apart is the whole reason /health was read
      // first. Vocalis answers 401 for both; reporting a locked vault as a bad token sends the
      // user to rotate a credential that was never wrong — which would then need re-pasting
      // everywhere for no reason.
      show(
        'bad',
        locked ? 'The Vocalis vault is locked.' : 'The server rejected this token.',
        locked
          ? 'The address and token cannot be checked until you log in to the Vocalis web UI and ' +
              'unlock it. Nothing here needs changing yet.'
          : 'It may have been rotated, or it may be the SillyTavern token — they are separate. ' +
              'Copy the one from ⚙ Settings ▸ Nomi extension.',
      );
      return;
    }
    show('bad', `The server answered ${ping.status}.`, 'The address looks right; this is something other than the token.');
  } finally {
    /** @type {HTMLButtonElement} */ (el('test')).disabled = /** @type {HTMLButtonElement} */ (el('save')).disabled = false;
  }
}

el('test').addEventListener('click', test);

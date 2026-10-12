// Repro: select a template, flush, reload — does the picker remember?
// Reports each observable link in the chain so the break, if any, is named.
// Usage: node repro_template_amnesia_spec.mjs <base-url> <chrome-path>
// NO BACKTICKS inside evaluate() template literals.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { STAMP_OUTGOING, ON_NEW_DOCUMENT } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log('  ok   ' + what);
  } else {
    console.error('  FAIL ' + what);
    failed++;
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let msgId = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('cannot open CDP socket ' + wsUrl)));
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, m => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, ready, send };
}

async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  }
  return r.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 25000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // During repaint, a node-dependent poll may throw. Retry that race, but retain the last
    // exception so a persistent expression error is reported when the wait times out.
    try {
      // 🔴 `Promise.resolve(...)`, NEVER `!!(expr)` AND NEVER A BARE VALUE. On a promise the
      // alternatives are true synchronously and always - `!!` on a thenable, and a promise
      // serialized by Runtime.evaluate as `{}` - so the wait returns on its first poll and waits
      // for nothing. Returning a promise from `evaluate` keeps the wait pending until its value
      // resolves and exposes the intended boolean result.
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`)) return true;
      lastThrow = null;
    } catch (err) {
      lastThrow = err && err.message ? err.message : String(err);
    }
    // ⚠️ BRACED DELIBERATELY. This read `if (...) return false;` with the return ON the if, so
    // inserting the line above it un-braced would have moved the return OUT of the branch and
    // made every wait in this file return false on its first poll - a corruption that parses.
    if (Date.now() - t0 > timeoutMs) {
      if (lastThrow) console.log(`  (wait gave up after ${timeoutMs}ms; last page exception: ${lastThrow})`);
      return false;
    }
    await sleep(100);
  }
}

const profile = await mkdtemp(join(tmpdir(), 'vocalis-tpl-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Keep browser audio muted while media behavior remains testable.
    // Playback state, duration, and completion events still run with --mute-audio.
    '--mute-audio',
    '--window-size=1920,1200',
    'about:blank',
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
    // Both variables point into the owned profile so cleanup contains extracted scratch.
    env: { ...process.env, TEMP: profile, TMP: profile },
  },
);
process.on('exit', () => {
  try {
    chrome.kill();
  } catch {
    /* gone */
  }
});

async function devtoolsPort() {
  for (let i = 0; i < 100; i++) {
    try {
      const txt = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const port = txt.split('\n')[0].trim();
      if (port) return port;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error('Chrome never reported a DevTools port');
}

async function boot(cdp) {
  // Called three times on the same page. `Page.navigate` answers when the browser has STARTED, so on
  // the later calls the old page, which already has `__bootDone`, could answer the gate. Stamp the
  // page being left (about:blank on the first call, where it is harmless) and require its absence.
  await evaluate(cdp, STAMP_OUTGOING);
  await cdp.send('Page.navigate', { url: baseUrl });
  if (!(await waitFor(cdp, ON_NEW_DOCUMENT + ' && window.__bootDone === true', 45000))) {
    throw new Error('page never finished booting');
  }
  await evaluate(cdp, 'document.querySelector(\'#tabs button[data-tab="acestep"]\').click()');
}

try {
  const port = await devtoolsPort();
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find(t => t.type === 'page') || list[0];
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // ── nav 1: create a template through the real route ──────────────────────
  await boot(cdp);
  const tplId = await evaluate(
    cdp,
    `
      (async () => {
        const csrf = (document.querySelector('meta[name=csrf]') || {}).content || '';
        const r = await fetch('/acestep/templates', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ name: 'ReproSong', lyrics: 'la la la repro',
                                 caption: 'synth pop, test fixture' }) });
        const j = await r.json();
        return (j.template && j.template.id) || j.id || null;
      })()`,
  );
  ok(!!tplId, 'a template was created: ' + tplId);

  // ── nav 2: fresh boot, select it like a user, watch the draft flush ──────
  await boot(cdp);
  ok(
    await waitFor(
      cdp,
      '[...(document.getElementById("aceTemplate")||{options:[]}).options]' + '.some(o => o.value === ' + JSON.stringify(tplId) + ')',
      20000,
    ),
    'the picker offers the template after boot',
  );
  await evaluate(
    cdp,
    `
      (() => {
        const s = document.getElementById('aceTemplate');
        s.value = ${JSON.stringify(tplId)};
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
  );
  ok(
    await waitFor(cdp, 'document.getElementById("aceTemplate").value === ' + JSON.stringify(tplId), 8000),
    'the picker shows the selection after the change handler settled',
  );
  // ⚠️ A debounced write is sampled with a POLL, never a fixed sleep: on a loaded box the
  // 400 ms debounce plus the POST can land later than any fixed clock, and the sibling
  // two-tab spec failed exactly that way in a full -n 12 run.
  let draftAfterSelect = null;
  for (let t0 = Date.now(); Date.now() - t0 < 15000;) {
    draftAfterSelect = await evaluate(
      cdp,
      `
          (async () => {
            const r = await fetch('/ui-state');
            const j = await r.json();
            let d = null;
            try { d = JSON.parse(j['vocalis-ace-draft'] || 'null'); } catch (e) { d = null; }
            return d && { tpl: d.tpl, hasForm: !!d.form };
          })()`,
    );
    if (draftAfterSelect && draftAfterSelect.tpl === tplId) break;
    await sleep(250);
  }
  console.log('  server draft after select: ' + JSON.stringify(draftAfterSelect));
  ok(draftAfterSelect && draftAfterSelect.tpl === tplId, 'WRITE side: the flushed draft carries the selected template id');

  // ── nav 3: reload and verify the selection survived ──────────────────────
  await boot(cdp);
  await waitFor(
    cdp,
    '[...(document.getElementById("aceTemplate")||{options:[]}).options]' + '.some(o => o.value === ' + JSON.stringify(tplId) + ')',
    20000,
  );
  // 🔴 WAIT FOR THE RESTORE ITSELF. `loadAceTemplates` paints the picker and THEN calls
  // `restoreDraft` (ace/form.js), so the options being present proves the restore has not
  // happened yet and may not have by the time they are read. This was `sleep(1500)`, "settle:
  // restore runs after the list arrives", which is a guess about how long the box takes. The
  // restore also fills the form from the draft, and the lyrics are empty on a fresh boot, so the
  // lyrics coming back is the event that says it ran. If it never does, the checks below still
  // read the page and fail on what it shows (the picker would read "— new song —").
  const restored = await waitFor(cdp, 'document.getElementById("aceLyrics").value === "la la la repro"', 20000);
  if (!restored)
    console.log(
      '  (the draft restore never filled the form; lyrics read ' +
        JSON.stringify(await evaluate(cdp, '(document.getElementById("aceLyrics") || {}).value')) +
        ')',
    );
  const after = await evaluate(
    cdp,
    `
      (async () => {
        const s = document.getElementById('aceTemplate');
        const r = await fetch('/ui-state');
        const j = await r.json();
        let d = null;
        try { d = JSON.parse(j['vocalis-ace-draft'] || 'null'); } catch (e) { d = null; }
        const marker = [...document.querySelectorAll('#paneAcestep *')]
          .filter(el => el.children.length === 0 && /not saved to a template/.test(el.textContent))
          .map(el => getComputedStyle(el).display !== 'none');
        return { picker: s ? s.value : '(no element)',
                 label: s && s.selectedOptions[0] ? s.selectedOptions[0].textContent : '',
                 serverDraftTpl: d ? d.tpl : null,
                 markerVisible: marker.some(Boolean) };
      })()`,
  );
  console.log('  after reload: ' + JSON.stringify(after));
  ok(after.serverDraftTpl === tplId, 'READ side precondition: the server draft still carries the id after reload');
  ok(after.picker === tplId, 'THE CLAIM: the picker still shows the selected template after a reload');

  await evaluate(cdp, 'undefined');
} catch (e) {
  console.error('  FAIL (spec crashed): ' + (e && e.message ? e.message : e));
  failed++;
} finally {
  try {
    chrome.kill();
  } catch {
    /* gone */
  }
  // Wait for exit before removing the profile: `kill()` returns immediately, and open handles
  // can make recursive deletion fail with EBUSY. The bounded timer prevents a missed exit event
  // from hanging cleanup.
  if (chrome.exitCode === null && chrome.signalCode === null)
    await new Promise(r => {
      chrome.once('exit', r);
      setTimeout(r, 4000);
    });
  for (let i = 0; i < 6; i++) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
}
process.exit(failed ? 1 : 0);

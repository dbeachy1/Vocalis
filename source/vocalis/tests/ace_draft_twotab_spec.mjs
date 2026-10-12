// Repro: TWO tabs, whole-blob PUT — does the stale tab erase the fresh tab's draft?
// Usage: node repro_twotab_spec.mjs <base-url> <chrome-path>
// NO BACKTICKS inside evaluate() template literals.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_FETCH_LOG, fetchCountAtLeast, STAMP_OUTGOING, ON_NEW_DOCUMENT } from './_specwait.mjs';

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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-2tab-cdp-'));
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

async function pageCdp(port, targetId) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const t = targetId ? list.find(x => x.id === targetId) : list.find(x => x.type === 'page') || list[0];
  const cdp = connect(t.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

async function boot(cdp) {
  // Called twice on tab A (and once on tab B). `Page.navigate` answers when the browser has STARTED,
  // so on A's second call the old page, which already has `__bootDone`, could answer the gate. Stamp
  // the page THIS tab is about to leave (about:blank on a first call, where it is harmless) and
  // require its absence. The stamp goes on `cdp`'s own page, so the other tab is not touched.
  await evaluate(cdp, STAMP_OUTGOING);
  await cdp.send('Page.navigate', { url: baseUrl });
  if (!(await waitFor(cdp, ON_NEW_DOCUMENT + ' && window.__bootDone === true', 45000))) {
    throw new Error('page never finished booting');
  }
}

const draftOnServer = async cdp =>
  evaluate(
    cdp,
    `
      (async () => {
        const r = await fetch('/ui-state');
        const j = await r.json();
        let d = null;
        try { d = JSON.parse(j['vocalis-ace-draft'] || 'null'); } catch (e) { d = null; }
        return d ? { tpl: d.tpl } : null;
      })()`,
  );

// ⚠️ A DEBOUNCED WRITE IS SAMPLED WITH A POLL, NEVER A FIXED SLEEP. This spec first sampled the
// server 1.2s after the select; on a loaded -n 12 box the 400ms debounce plus the POST landed
// LATER than that, and the write-side check failed while the thing under test was fine. Worse,
// the same clock made the claim vacuous in the other direction: if tab B's flush had not landed
// by the sample, "nothing was erased" passed without testing erasure at all.
async function pollUntil(fn, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(250);
  }
}

try {
  const port = await devtoolsPort();
  const A = await pageCdp(port);

  // ── A: create the template, then boot fresh ──────────────────────────────
  await boot(A);
  const tplId = await evaluate(
    A,
    `
      (async () => {
        const csrf = (document.querySelector('meta[name=csrf]') || {}).content || '';
        const r = await fetch('/acestep/templates', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ name: 'TwoTabSong', lyrics: 'la la clobber',
                                 caption: 'test fixture' }) });
        const j = await r.json();
        return (j.template && j.template.id) || j.id || null;
      })()`,
  );
  ok(!!tplId, 'a template was created: ' + tplId);
  await boot(A);
  await evaluate(A, 'document.querySelector(\'#tabs button[data-tab="acestep"]\').click()');

  // ── B: a second tab boots NOW — its state snapshot predates the selection ─
  const made = await A.send('Target.createTarget', { url: 'about:blank' });
  const B = await pageCdp(port, made.targetId);
  // The fetch log goes in BEFORE B's page scripts run (a new-document script), because the thing
  // to be seen is B's own boot-time write and a log installed after `boot` could miss it.
  await B.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL_FETCH_LOG });
  await boot(B);
  console.log('  tab B booted (stale snapshot taken)');
  // 🔴 WAIT FOR B'S BOOT-TIME FLUSH TO HAVE LANDED, NOT FOR A NUMBER OF MILLISECONDS. A booting page
  // writes its tab and view state to /ui-state once the 400 ms debounce fires (measured
  // 2026-10-12: one POST of vocalis-vstab, vocalis-ss-view and vocalis-tab about 560 ms after the
  // navigation began). This was `sleep(1500)`, "let any boot-time flush from B settle first": on an
  // idle box that is enough, on a loaded one the POST can still be in flight when A selects. The
  // claim below is about B's LATER flush, so B's boot flush has to be out of the way first; the
  // fetch log records the response, i.e. the server has it.
  if (!(await waitFor(B, fetchCountAtLeast('/ui-state', 1, 'POST'), 30000)))
    throw new Error(
      "tab B never flushed its boot-time state to /ui-state, so 'B's boot flush is out of the way' cannot be established " +
        '(B fetches: ' +
        JSON.stringify(await evaluate(B, 'window.__specFetch ? window.__specFetch.log : "log not installed"')) +
        ')',
    );

  // ── A: select the template, flush, verify server-side ────────────────────
  ok(
    await waitFor(
      A,
      '[...(document.getElementById("aceTemplate")||{options:[]}).options]' + '.some(o => o.value === ' + JSON.stringify(tplId) + ')',
      20000,
    ),
    'A: the picker offers the template',
  );
  await evaluate(
    A,
    `
      (() => {
        const s = document.getElementById('aceTemplate');
        s.value = ${JSON.stringify(tplId)};
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
  );
  const afterSelect = await pollUntil(async () => {
    const d = await draftOnServer(A);
    return d && d.tpl === tplId ? d : null;
  });
  console.log('  server draft after A selects: ' + JSON.stringify(afterSelect));
  ok(afterSelect, 'A: the flushed draft carries the id');

  // ── B: an ordinary action — click a different main tab — triggers B's flush ─
  await evaluate(B, 'document.querySelector(\'#tabs button[data-tab="voices"]\').click()');
  // 🔴 THE CLAIM IS ONLY A CLAIM ONCE B'S FLUSH HAS LANDED. A booted on the acestep tab, so
  // the server saying vocalis-tab=voices is proof B's write arrived — checking the draft
  // before that proves nothing about erasure.
  const bLanded = await pollUntil(() =>
    evaluate(
      B,
      `
      (async () => {
        const j = await (await fetch('/ui-state')).json();
        return j['vocalis-tab'] === 'voices';
      })()`,
    ),
  );
  ok(bLanded, 'B: the tab-click flush landed on the server');
  const afterB = await draftOnServer(A);
  console.log('  server draft after B clicks a tab: ' + JSON.stringify(afterB));
  ok(afterB && afterB.tpl === tplId, "THE CLAIM: tab B's flush did not erase tab A's draft");
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

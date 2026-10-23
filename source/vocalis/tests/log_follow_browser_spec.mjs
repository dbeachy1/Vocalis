// Vocalis 12.2.2 — live logs show their last line when their tab comes back, in a REAL browser.
//
// 🔴 WHY A BROWSER. The fix rests on two things only a layout engine does, and the fake elements
// in log_autoscroll_behavior.mjs simply assume them: a ResizeObserver fires when a tab's
// `display:none` is lifted, and the browser restores the hidden pane's old scroll offset WITHOUT
// first sending a scroll event at it. If it did send one, Book's scroll listener would turn
// auto-scroll off before the observer ran and the fix would do nothing. (Doug, 2026-10-23: lines
// that arrived while he was on another tab left the Book log showing old text, auto-scroll still
// on, until the next line arrived.)
//
// The lines are appended the way `logInto` appends them: a div, then a scroll to the tail when
// the log is following. While the tab is hidden that scroll does nothing, which is the point.
//
// ⚠️ No backticks inside the CDP expressions — they are template literals here.
//
// Usage: node log_follow_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node log_follow_browser_spec.mjs <base-url> <chrome-path>');
  process.exit(2);
}

let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CDP plumbing (mirrors sticky_tabs_browser_spec.mjs) ──────────────────────
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
    ws.addEventListener('error', () => rej(new Error(`cannot open CDP socket ${wsUrl}`)));
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, ready, send };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) {
    throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

// A poll that throws is "not yet"; the last throw is reported if the wait gives up.
async function waitFor(cdp, expression, timeoutMs = 20000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    try {
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`)) return true;
      lastThrow = null;
    } catch (err) {
      lastThrow = err && err.message ? err.message : String(err);
    }
    if (Date.now() - t0 > timeoutMs) {
      if (lastThrow) console.log(`  (wait gave up after ${timeoutMs}ms; last page exception: ${lastThrow})`);
      return false;
    }
    await sleep(100);
  }
}

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-logfollow-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Mute browser audio in these specs; see power_line_browser_spec.mjs.
    '--mute-audio',
    '--ignore-certificate-errors',
    '--window-size=1400,1000',
    'about:blank',
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
    env: { ...process.env, TEMP: profile, TMP: profile },
  },
);

let cleanedUp = false;
const cleanup = async () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    chrome.kill();
  } catch {
    /* already gone */
  }
  // Wait for Chrome to go before deleting its profile; an immediate delete fails on Windows.
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
};
process.on('exit', () => {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
});

async function devtoolsPort() {
  for (let i = 0; i < 100; i++) {
    try {
      const txt = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const port = txt.split('\n')[0].trim();
      if (port) return port;
    } catch {
      /* not written yet */
    }
    await sleep(100);
  }
  throw new Error('Chrome never reported a DevTools port');
}

// Page helpers, installed once after load. `add` appends like `logInto`; `tab` clicks a real tab
// and waits two frames, which is when the browser has laid the panel out and delivered its
// ResizeObserver callbacks; `gap` is how far the log is from its last line.
const HELPERS = `(() => {
  window.__add = (id, n, label, follow) => {
    const p = document.getElementById(id);
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'l';
      d.textContent = label + ' ' + i;
      p.appendChild(d);
      if (follow()) p.scrollTop = p.scrollHeight;
    }
  };
  window.__tab = async t => { document.querySelector('[data-tab="' + t + '"]').click(); await ${NEXT_FRAME}; };
  window.__gap = id => { const p = document.getElementById(id); return Math.round(p.scrollHeight - p.scrollTop - p.clientHeight); };
  window.__book = () => document.getElementById('autoscroll').checked;
  window.__blk = () => document.getElementById('blkAutoscroll').checked;
  window.__always = () => true;
  return true; })()`;

let exitCode = 1;
try {
  const port = await devtoolsPort();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target in Chrome');

  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    }
  });

  await cdp.send('Page.navigate', { url: baseUrl });
  ok(await waitFor(cdp, `document.readyState === 'complete'`), 'the page loads');
  ok(await waitFor(cdp, `window.__bootDone === true`), 'the app finishes booting');
  await evaluate(cdp, HELPERS);

  // ── Book ▸ Generate, auto-scroll on: lines arrive while on another tab ─────
  await evaluate(
    cdp,
    `(async () => { await window.__tab('book'); document.querySelector('[data-bktab="generate"]').click();
      const p = document.getElementById('log'); p.innerHTML = ''; window.__add('log', 150, 'line', window.__book);
      p.scrollIntoView({ block: 'center', behavior: 'instant' }); await ${NEXT_FRAME}; return true; })()`,
  );
  const start = await evaluate(cdp, `({ gap: window.__gap('log'), on: window.__book() })`);
  ok(start.on && start.gap <= 1, `Book starts on its last line with auto-scroll on (gap ${start.gap})`);
  await evaluate(cdp, `(async () => { await window.__tab('playground'); window.__add('log', 40, 'away', window.__book); return true; })()`);
  ok((await evaluate(cdp, `document.getElementById('log').clientHeight`)) === 0, 'the Book log is hidden while on Playground');
  const back = await evaluate(
    cdp,
    `(async () => { await window.__tab('book'); return { gap: window.__gap('log'), on: window.__book() }; })()`,
  );
  ok(back.on, 'coming back does not turn Book auto-scroll off');
  ok(back.gap <= 1, `coming back shows the Book log's last line at once (gap ${back.gap})`);

  // ── scroll up with the wheel, then click the box ────────────────────────────
  await evaluate(
    cdp,
    `(async () => { document.getElementById('log').scrollIntoView({ block: 'center', behavior: 'instant' }); await ${NEXT_FRAME}; return true; })()`,
  );
  const at = await evaluate(
    cdp,
    `(() => { const b = document.getElementById('log').getBoundingClientRect(), c = document.getElementById('autoscroll').getBoundingClientRect();
      return { px: b.x + b.width / 2, py: b.y + b.height / 2, cx: c.x + c.width / 2, cy: c.y + c.height / 2 }; })()`,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.px, y: at.py, deltaX: 0, deltaY: -1200 });
  ok(await waitFor(cdp, `!window.__book()`), 'scrolling the Book log up turns auto-scroll off');
  await evaluate(cdp, `(() => { window.__add('log', 5, 'unfollowed', window.__book); return true; })()`);
  ok((await evaluate(cdp, `window.__gap('log')`)) > 300, 'with auto-scroll off, new lines leave the log where it was');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: at.cx, y: at.cy, button: 'left', clickCount: 1 });
  }
  const jumped = await evaluate(cdp, `({ gap: window.__gap('log'), on: window.__book() })`);
  ok(jumped.on, 'clicking the box turns auto-scroll on');
  ok(jumped.gap <= 1, `clicking the box jumps to the last line before any new line (gap ${jumped.gap})`);
  await evaluate(cdp, NEXT_FRAME);
  ok(await evaluate(cdp, `window.__book()`), 'the jump itself does not turn auto-scroll back off');

  // ── auto-scroll off: coming back keeps your place ──────────────────────────
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: at.cx, y: at.cy, button: 'left', clickCount: 1 });
  }
  ok(!(await evaluate(cdp, `window.__book()`)), 'clicking the box again turns auto-scroll off');
  await evaluate(cdp, `(async () => { document.getElementById('log').scrollTop = 200; await ${NEXT_FRAME}; return true; })()`);
  await evaluate(
    cdp,
    `(async () => { await window.__tab('playground'); window.__add('log', 20, 'away again', window.__book); await window.__tab('book'); return true; })()`,
  );
  const kept = await evaluate(cdp, `({ top: document.getElementById('log').scrollTop, on: window.__book() })`);
  ok(!kept.on && kept.top === 200, `with auto-scroll off, coming back keeps your place (scrollTop ${kept.top})`);

  // ── Playground: follows while at its last line, stays put when you scrolled up ─
  await evaluate(
    cdp,
    `(async () => { await window.__tab('playground'); const p = document.getElementById('pgLog'); p.innerHTML = '';
      p.scrollIntoView({ block: 'center', behavior: 'instant' }); window.__add('pgLog', 100, 'pg', window.__always); await ${NEXT_FRAME};
      await window.__tab('book'); window.__add('pgLog', 30, 'pg away', window.__always); await window.__tab('playground'); return true; })()`,
  );
  const pg = await evaluate(cdp, `window.__gap('pgLog')`);
  ok(pg <= 1, `Playground: at its last line before, it shows the last line when you come back (gap ${pg})`);
  await evaluate(
    cdp,
    `(async () => { document.getElementById('pgLog').scrollTop = 100; await ${NEXT_FRAME};
      await window.__tab('book'); window.__add('pgLog', 30, 'pg away again', window.__always); await window.__tab('playground'); return true; })()`,
  );
  const pgKept = await evaluate(cdp, `document.getElementById('pgLog').scrollTop`);
  ok(pgKept === 100, `Playground: scrolled up to read, it stays put when you come back (scrollTop ${pgKept})`);

  // ── Bulk, auto-scroll on ─────────────────────────────────────────────────────
  await evaluate(cdp, `(async () => { await window.__tab('bulk'); return true; })()`);
  ok(await evaluate(cdp, `document.getElementById('blkLog').clientHeight > 0`), 'the Bulk log is on screen on its tab');
  await evaluate(
    cdp,
    `(async () => { const p = document.getElementById('blkLog'); p.innerHTML = ''; window.__add('blkLog', 120, 'blk', window.__blk);
      await window.__tab('book'); window.__add('blkLog', 30, 'blk away', window.__blk); await window.__tab('bulk'); return true; })()`,
  );
  const blk = await evaluate(cdp, `({ gap: window.__gap('blkLog'), on: window.__blk() })`);
  ok(blk.on && blk.gap <= 1, `Bulk: coming back shows the last line with auto-scroll on (gap ${blk.gap})`);

  ok(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? ': ' + pageErrors.join(' | ') : ''}`);
  exitCode = failed ? 1 : 0;
} catch (err) {
  console.error('  FAIL spec crashed:', err);
  exitCode = 1;
} finally {
  await cleanup();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(exitCode);

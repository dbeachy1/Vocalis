// Vocalis 9.0.8 — the hardware strip's two FALLBACK paths, in a real browser.
//
// 🔴 THESE ARE THE PATHS THAT EXIST SO THE FEATURE DEGRADES SAFELY, AND THEY WERE THE UNTESTED
// ONES. `test_system_stream.py` pins the route and the cap at the Flask level, and
// `power_line_browser_spec.mjs` pins that the happy path uses the stream and that the 4 Hz poll
// stops. Neither touches what happens when the stream is NOT available — which is the case that
// decides whether 9.0.8 is an improvement or a silent regression:
//
//   · REFUSED — past `MAX_STRIP_STREAMS` the server answers 503. `EventSource` sets
//     `readyState === CLOSED` on a non-SSE response and never retries, and `hwstrip.js` treats
//     that as its cue to poll `/system/stats` exactly as it did before 9.0.8. If that cue is ever
//     wrong the strip goes DEAD rather than slow, and nothing on the page says so.
//
//   · STALLED — a stream that connects and then goes quiet is the one failure a poll cannot have.
//     `STALL_MS` hands over to the poll after 3s of silence. Forced here by making the server's
//     frame interval far longer than that, so the stream is genuinely open and genuinely silent —
//     not closed, not errored, which is exactly the state the escape exists for.
//
// ⚠️ THE FLAG ALONE IS NOT THE ASSERTION. `__stripTransport === 'poll'` only says what the page
// BELIEVES; the check that matters is that requests to `/system/stats` resume, counted off the
// browser's own resource timeline. A fallback that flipped the flag and started no timer would
// leave the strip frozen and pass a flag-only test.
//
// ⚠️ No backticks inside the CDP expressions — they are template literals here.
//
// Usage: node strip_fallback_browser_spec.mjs <base-url> <chrome-path> <refused|stalled>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [baseUrl, chromePath, mode] = process.argv.slice(2);
if (!baseUrl || !chromePath || !['refused', 'stalled'].includes(mode)) {
  console.error('usage: node strip_fallback_browser_spec.mjs <base-url> <chrome-path> <refused|stalled>');
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

// ── CDP plumbing (mirrors power_line_browser_spec.mjs) ───────────────────────
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

async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (r.exceptionDetails) {
    throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

// The deadline (this default and every explicit one) only bounds a HANG; a passing run never waits
// it out. 8 to 20 s was too short with dozens of these specs running at once, so it is 60 s (2026-10-12).
async function waitFor(cdp, expression, timeoutMs = 60000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED". `evaluate` turns a page exception into
    // a thrown Error, so before this guard any wait whose expression dereferenced a node was a
    // race rather than a wait - the FIRST poll landing mid-repaint killed the spec. The wait is
    // FOR the repaint, so polling during it is the normal case and the early polls being false
    // is the entire point. Proved by mutation on 2026-08-20, not reasoned about.
    // ⚠️ THE THROW IS REMEMBERED, NOT SWALLOWED - an expression with a typo in it throws on
    // every poll, and without this it would simply time out saying nothing about why.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-fallback-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--ignore-certificate-errors',
    '--window-size=1400,1000',
    'about:blank',
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
    // Both variables point into the owned profile so cleanup contains extracted scratch.
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

const STATS_COUNT = `performance.getEntriesByType('resource').filter(e => e.name.includes('/system/stats')).length`;

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
  await waitFor(cdp, `document.readyState === 'complete'`);
  await waitFor(cdp, `window.__bootDone === true`);
  // The browser keeps only the first 250 resource-timing entries by default and silently drops the
  // rest; the page polls several endpoints a second, so a count that is waited on for longer than a
  // few seconds could stop rising for that reason. Lift the cap before anything is counted.
  await evaluate(cdp, `(performance.setResourceTimingBufferSize(100000), true)`);

  if (mode === 'stalled') {
    // The server's frame interval is far longer than STALL_MS, so the stream opens, delivers, and
    // then goes silent while staying OPEN — the exact state the escape exists for.
    ok(await waitFor(cdp, `window.__stripTransport === 'stream'`), 'the stream opens normally before it goes quiet');
    ok(await waitFor(cdp, `window.__stripTransport === 'poll'`), '🔴 a stream that connects and then says nothing hands over to the poll');
  } else {
    // Every stream is refused with a 503, so the page must never report 'stream' at all.
    ok(await waitFor(cdp, `window.__stripTransport === 'poll'`), '🔴 a refused stream (503 past the cap) falls back to polling');
    ok((await evaluate(cdp, `window.__stripTransport`)) !== 'stream', 'and it never claims to be on the stream');
  }

  // 🔴 THE FLAG IS NOT THE FEATURE. A fallback that flipped the flag and started no timer would
  // leave the strip frozen for ever and pass every check above. Count what actually goes over the
  // wire — the old regime is ~4/s, so anything at all in two seconds proves the poll is running.
  const before = await evaluate(cdp, STATS_COUNT);
  // WAIT FOR THE REQUESTS THEMSELVES. This was `sleep(2000)` and a count of what had arrived by
  // then, so a slow machine that managed one request in two seconds failed a poll that was running
  // fine. Two new `/system/stats` requests on the timeline is the claim; how long they take to
  // arrive is only bounded (to catch a poll that never starts). The label's "in 2 s" is the old
  // window and is kept byte-for-byte as asked; it is no longer a duration.
  const pollRan = await waitFor(cdp, `${STATS_COUNT} >= ${before + 2}`);
  const polls = (await evaluate(cdp, STATS_COUNT)) - before;
  ok(pollRan && polls >= 2, `🔴 and the poll is really running again — ${polls} request(s) to /system/stats in 2 s`);

  // And the strip is actually painting off it, rather than merely being requested.
  ok(
    await waitFor(cdp, `getComputedStyle(document.getElementById('cpuLine')).display !== 'none'`),
    'the CPU line is on screen, so the strip is alive on the fallback path',
  );

  ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join(' | ') || 'none'})`);
  exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error(`  FAIL harness: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

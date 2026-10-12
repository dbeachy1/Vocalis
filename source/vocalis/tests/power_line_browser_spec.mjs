// Browser checks for the header's power line using a stubbed /system/stats reading.
// The server tests stop at JSON, while copied-layout checks are not enforced against index.html.
// Driving the real page verifies rendered order and the client transport path together.
//
// No npm dependencies — Node ships WebSocket and fetch, Chrome speaks CDP. CDP plumbing mirrors
// devices_browser_spec.mjs.
//
// Usage: node power_line_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node power_line_browser_spec.mjs <base-url> <chrome-path>');
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

// ── CDP plumbing (mirrors devices_browser_spec.mjs) ──────────────────────────
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
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

// The deadline only bounds a HANG; a passing run never waits it out. 20 s (8 s on some calls) was too
// short with dozens of these specs running at once, so the default is 60 s (2026-10-12).
async function waitFor(cdp, expression, timeoutMs = 60000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // Resolve promise-valued expressions before coercion; a thenable is truthy immediately.
    // Retry transient page exceptions during repaint, but retain the last one for timeout output.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-pow-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Keep browser audio muted while media behavior remains testable.
    // Playback state, duration, and completion events still run with --mute-audio.
    '--mute-audio',
    '--ignore-certificate-errors',
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

let cleanedUp = false;
const cleanup = async () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    chrome.kill();
  } catch {
    /* already gone */
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
  // The browser keeps only the first 250 resource-timing entries by default and silently drops the
  // rest; the page polls several endpoints a second, so once it is full a request count stops rising
  // and a "fewer than 3 requests" check below would pass for that reason. Lift the cap first.
  await evaluate(cdp, `(performance.setResourceTimingBufferSize(100000), true)`);

  // ── the line paints itself, off the page's OWN sampler ──────────────────
  // Nothing here calls the renderer. The page samples the box on its own, the server's power
  // block is stubbed to a fixed reading, and this waits for the row to appear. That is the whole
  // chain — route, payload, fan-out, shape gate, three querySelectors.
  //
  // The stream check is separate from paint checks: fallback polling can render the same values.
  // `window.__stripTransport` distinguishes the active SSE path from that fallback.
  ok(
    await waitFor(
      cdp,
      `document.getElementById('powerLine') &&
                           getComputedStyle(document.getElementById('powerLine')).display !== 'none'`,
    ),
    'the power line appears in the header when the server reports watts',
  );

  const txt = await evaluate(cdp, `document.getElementById('powerLine').innerText.replace(/\\s+/g, ' ').trim()`);
  ok(/\bpower\b/.test(txt), `the row is labeled "power" (got ${JSON.stringify(txt)})`);
  ok(/\b655\b/.test(txt) && /W/.test(txt), 'it prints the live figure in watts');
  ok(/\bavg\b/.test(txt), 'the averages are labeled avg');
  ok(/\b640\b.*\b620\b.*\b300\b/.test(txt), 'and are the 1/5/15-minute figures in that order, like load average');
  ok(/\bpeak\b/.test(txt) && /\b812\b/.test(txt), 'the peak is on the same row — the spike a UI-side sample would have missed');

  // ── 🔴 the strip is on ONE HELD CONNECTION, not four requests a second ───
  //
  // `'stream'` is set when the `EventSource` is opened and
  // replaced with `'poll'` the moment anything falls back — a 503 past the server's cap, a
  // browser without `EventSource`, or a stream that connects and then goes quiet past
  // `STALL_MS`. Reading `'stream'` here therefore proves the push channel is the one carrying
  // the numbers above, and it is the assertion that goes red if the route is ever lost.
  ok(
    await waitFor(cdp, `window.__stripTransport === 'stream'`),
    '🔴 the hardware strip is fed by the SSE stream, not by the fallback poll',
  );

  // 🔴 AND THE POLL ACTUALLY STOPPED, WHICH THE FLAG ABOVE DOES NOT PROVE. A version that opened
  // the stream and left the old `setInterval` armed would set `__stripTransport` to `'stream'`,
  // paint perfectly, pass every other assertion in this file, and still leave the old polling
  // interval active. Count requests to verify the network traffic rather than trusting the flag.
  //
  // ⚠️ COUNTED OFF THE BROWSER'S OWN RESOURCE TIMELINE, never off a counter in the page: the
  // question is what went over the network, not what the app believes about itself.
  //
  // 🔴 THIS IS AN ABSENCE CHECK OVER ELAPSED PAGE TIME, so some time has to pass, and the window is
  // counted in TIMER FIRINGS of the page, not in wall-clock milliseconds. It was `sleep(2000)` from
  // the test runner: if the page was stalled for most of that second (a loaded machine), the armed
  // 250 ms poll would have fired once or not at all and "fewer than 3 requests" passed having shown
  // nothing. Eight ticks of a 250 ms timer in the page itself are eight chances for the poll's own
  // 250 ms timer to fire, whatever the clock says; both are delayed together. The signal that would
  // remove the timer altogether does not exist in the product: a flag saying whether the strip's
  // poll interval is armed (or a count of its fires).
  const statsIn = ticks =>
    evaluate(
      cdp,
      `(async () => {
          const count = () => performance.getEntriesByType('resource').filter(e => e.name.includes('/system/stats')).length;
          const before = count();
          await new Promise(res => {
              let n = 0;
              const id = setInterval(() => { if (++n >= ${ticks}) { clearInterval(id); res(); } }, 250);
          });
          return count() - before;
      })()`,
    );
  const polls = await statsIn(8);
  // The old behavior is 4/s — eight in this window. One is allowed because the one-shot pokes are
  // deliberately kept (a model load, a ComfyUI bounce, becoming visible again all fire one), and a
  // threshold of three tells the two regimes apart without being able to drift into flakiness.
  ok(polls < 3, `🔴 the 4 Hz poll of /system/stats is gone — ${polls} request(s) in 2 s, was ~8`);

  // ── every readout owns its own tooltip (7.3.4's lesson) ─────────────────
  const titles = await evaluate(
    cdp,
    `(() => {
        const q = k => (document.querySelector('#powerLine [data-r="' + k + '"]') || {}).title || '';
        return { now: q('now'), avg: q('avg'), peak: q('peak') };
    })()`,
  );
  ok(
    titles.now && titles.avg && titles.peak && new Set(Object.values(titles)).size === 3,
    'each of the three readouts has its own tooltip, not one shared by the row',
  );
  ok(
    /NOT wall draw/.test(titles.now),
    '🔴 the live figure says out loud that it is not wall draw — it is CPU + cards, and a ' + 'plug meter will always read higher',
  );
  ok(/CPU package/.test(titles.now) && /GPU/.test(titles.now), 'and names what it summed, with the split');
  // The peak persists while live readings change, so its tooltip must show the CPU/GPU split
  // captured at that peak rather than attributing it from the current sample.
  ok(
    /\b219\b/.test(titles.peak) && /\b593\b/.test(titles.peak),
    'the peak tooltip carries the split AT THE PEAK (CPU 219 + GPUs 593), not the live one',
  );

  // ── it is a ROW UNDER the other two, not a third column ─────────────────
  // 🔴 THE CHECK THE LAYOUT TESTS STRUCTURALLY CANNOT MAKE: those measure a hand copy of this
  // header. This is the real page.
  // ⚠️ PLAIN NUMBERS, NOT DOMRects. CDP's returnByValue does not call DOMRect.toJSON, so a
  // rect comes back as {} and every comparison below silently reads `undefined` — which fails
  // in the direction that looks like a layout bug and is not one. (It cost one run here.)
  const geo = await evaluate(
    cdp,
    `(() => {
        const b = el => { const r = el.getBoundingClientRect();
                          return {top: r.top, bottom: r.bottom, left: r.left, right: r.right}; };
        const g = id => b(document.getElementById(id));
        return { psi: g('psiLine'), pow: g('powerLine'),
                 stack: b(document.querySelector('.hdr-stack')) };
    })()`,
  );
  ok(geo.pow.top >= geo.psi.bottom - 0.5, 'the power line is below the memory-pressure line');
  ok(Math.abs(geo.pow.right - geo.stack.right) <= 0.5, 'flush with the button stack’s right edge, like the two lines above it');
  ok(geo.pow.left > geo.stack.left, 'and inside the stack rather than starting a column of its own');

  // ── absent where the box cannot report it ───────────────────────────────
  // Every Windows box, and every box for the first second after a restart. Driven through the
  // renderer directly because the stub server always answers with watts.
  const hidden = await evaluate(
    cdp,
    `(async () => {
        const m = await import('/webui/js/sys/hwstrip.js');
        m.stopIdleVram();                       // or the next 250 ms poll paints it straight back
        m.renderStrip({gpus: [], cpu: {pct: 1, cores: 32}, power: null});
        return getComputedStyle(document.getElementById('powerLine')).display;
    })()`,
  );
  ok(hidden === 'none', 'a box that reports no watts gets no line at all, rather than a row of dashes forever');

  ok(pageErrors.length === 0, `the page threw nothing: ${pageErrors.join(' | ') || 'clean'}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`  FAIL harness: ${err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

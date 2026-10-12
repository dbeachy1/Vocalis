// Measure candidate playback and autoplay in headless Chrome. Short tone fixtures cannot expose
// the buffering delay of production-size FLAC, so this covers play, discard, and save paths.
//
// The 8-second bound detects stalled playback while leaving headroom for normal startup latency.
//
// Do not add backticks inside evaluate() template literals; they terminate the expression string.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// A `-1` sentinel means the media element was absent at the deadline, not merely slow.
//
// `TIME_TO_AUDIO` resolves `readyState:-1, paused:null, networkState:-1, currentTime:-1,
// duration:-1` when `document.querySelector(sel)` returned **null** at the deadline. Those are
// "there was no element", not "the element was not ready". A genuine slow-start reports real
// numbers (`readyState:0..2`, `paused:true`), and a decode failure reports `err: 'media error N'`.
//
// Use the project pytest configuration: these specs share a Chrome process, and overriding its
// worker distribution or timeout can create misleading intermittent failures.
//
// A missing-element sentinel is distinct from a slow start or decode error. If it recurs, inspect
// `#aceTray` at the deadline instead of widening `BUDGET`; a longer wait cannot restore a missing row.
//
// Usage: node acestep_playback_spec.mjs <base-url> <chrome-path>
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: acestep_playback_spec.mjs <base-url> <chrome-path>');
  process.exit(2);
}

let failed = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) failed++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let nextId = 1;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const api = { ws, pending };
  api.ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', e => rej(new Error(`cdp socket: ${e.message || e}`)));
  });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  api.send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return api;
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 30000) {
  let lastThrow = null;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // During repaint, a node-dependent poll may throw. Retry that race, but retain the last
    // exception so a persistent expression error is reported when the wait times out.
    try {
      // Returning a promise from `evaluate` keeps the wait pending until its value resolves and
      // exposes the intended boolean result; coercing a thenable would return immediately.
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`)) return true;
      lastThrow = null;
    } catch (err) {
      lastThrow = err && err.message ? err.message : String(err);
    }
    await sleep(120);
  }
  if (lastThrow) console.log(`  (wait gave up; last page exception: ${lastThrow})`);
  return false;
}

const profile = await mkdtemp(join(tmpdir(), 'vocalis-acepb-'));
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
    // Without this Chrome refuses programmatic play() and every measurement below is a refusal
    // rather than a stall, which would make this spec assert the opposite of what it means to.
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
    // Both variables point into the owned profile so cleanup contains extracted scratch.
    env: { ...process.env, TEMP: profile, TMP: profile },
  },
);

let stderrBuf = '';
chrome.stderr.on('data', d => {
  stderrBuf += d.toString();
});

const cleanup = async () => {
  try {
    chrome.kill('SIGKILL');
  } catch (e) {
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

async function devtoolsPort() {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const m = stderrBuf.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return m[1];
    await sleep(100);
  }
  throw new Error(`Chrome never reported a DevTools port: ${stderrBuf.slice(0, 400)}`);
}

/** Time, in ms, from now until that row's <audio> is actually producing sound. */
const TIME_TO_AUDIO = `(sel, budget) => new Promise(resolve => {
    const t0 = performance.now();
    const started = () => {
        const a = document.querySelector(sel);
        if (!a) return null;
        if (a.error) return {ms: performance.now() - t0, err: 'media error ' + a.error.code};
        // readyState >= 3 is HAVE_FUTURE_DATA: decoded frames exist for the current position.
        // currentTime alone can advance on an element that has nothing to play.
        if (a.readyState >= 3 && !a.paused && a.currentTime > 0) {
            return {ms: performance.now() - t0, dur: a.duration};
        }
        return null;
    };
    const tick = setInterval(() => {
        const got = started();
        if (got) { clearInterval(tick); resolve(got); }
        else if (performance.now() - t0 > budget) {
            clearInterval(tick);
            const a = document.querySelector(sel);
            resolve({ms: performance.now() - t0, timedOut: true,
                      readyState: a ? a.readyState : -1,
                      paused: a ? a.paused : null,
                      networkState: a ? a.networkState : -1,
                      currentTime: a ? a.currentTime : -1,
                      duration: a ? a.duration : -1});
        }
    }, 50);
})`;

const BUDGET = 8000;

try {
  const port = await devtoolsPort();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page') || list[0];
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const thrown = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      thrown.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: baseUrl });
  ok(await waitFor(cdp, 'window.__bootDone === true', 45000), 'the page finished booting');

  await evaluate(cdp, `document.querySelector('#tabs button[data-tab="acestep"]').click()`);
  ok(
    await waitFor(cdp, `getComputedStyle(document.querySelector('section[data-panel="acestep"]')).display !== 'none'`),
    'the ACE-Step tab is open',
  );

  // Autoplay ON before anything is generated, so the discard and save paths below exercise it.
  await evaluate(
    cdp,
    `(() => {
        const b = document.getElementById('aceAutoplay');
        if (!b.checked) { b.click(); }
        return b.checked; })()`,
  );
  ok(await evaluate(cdp, `document.getElementById('aceAutoplay').checked === true`), 'Autoplay is on');

  // Two presses on two cards should produce four candidates.
  await evaluate(
    cdp,
    `(() => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
        };
        set('aceTitle', 'Playback Timing');
        set('aceCaption', 'solo acoustic guitar, sparse');
        set('aceLyrics', '[verse]\\ntiming only');
    })()`,
  );
  await evaluate(cdp, `document.getElementById('aceGenBtn').click()`);
  // Wait for the Generate button to become enabled before the next press. The browser drops clicks
  // while the POST is in flight, so a fixed delay can lose a press on a busy server.
  //
  // The readiness sentinel distinguishes a lost press and missing row from a playback failure.
  const pressAt = Date.now();
  const backAgain = await waitFor(cdp, `document.getElementById('aceGenBtn').disabled === false`, 60000);
  // 📌 THE NUMBER IS PRINTED EVEN WHEN IT PASSES, like the timings below it: this is the
  // margin the old `sleep(1200)` was spending, so a figure creeping toward a second is the early
  // warning that the press window is closing again.
  ok(backAgain, `the first press finished and the Generate button came back in ${Date.now() - pressAt} ms`);
  await evaluate(cdp, `document.getElementById('aceGenBtn').click()`);

  const four = await waitFor(cdp, `document.querySelectorAll('#aceTray .acerow audio').length >= 4`, 60000);
  ok(
    four,
    'four candidates finished and offer players' +
      (four
        ? ''
        : // 📌 REPORTS ITS OWN CAUSE. A bare "expected 4" sends the next reader to the
          // playback code; the row count and the button's state say in one line whether a press
          // was lost, whether the tray is still filling, or whether the players never attached.
          ' ' +
          JSON.stringify(
            await evaluate(
              cdp,
              `(() => ({
                  rows: document.querySelectorAll('#aceTray .acerow').length,
                  players: document.querySelectorAll('#aceTray .acerow audio').length,
                  genDisabled: document.getElementById('aceGenBtn').disabled,
                  genLabel: (document.getElementById('aceGenBtn').textContent || '').trim(),
               }))()`,
            ),
          )),
  );

  // ── 1. PRESS PLAY ───────────────────────────────────────────────────────────────────────
  const rowSel = "'#aceTray .acerow:nth-of-type(1) audio'";
  await evaluate(
    cdp,
    `(() => {
        const a = document.querySelector('#aceTray .acerow audio');
        a.play();
        return true; })()`,
  );
  const manual = await evaluate(cdp, `(${TIME_TO_AUDIO})('#aceTray .acerow audio', ${BUDGET})`);
  ok(
    !manual.timedOut,
    `pressing play produces audio in ${Math.round(manual.ms)} ms ` + `(budget ${BUDGET}) ${manual.timedOut ? JSON.stringify(manual) : ''}`,
  );

  // ── 2. DISCARD, AND AUTOPLAY TAKES THE NEXT ─────────────────────────────────────────────
  const before = await evaluate(cdp, `document.querySelectorAll('#aceTray .acerow audio').length`);
  await evaluate(cdp, `document.querySelector('#aceTray .acerow button[data-act="discard"]').click()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#aceTray .acerow audio').length === ${before - 1}`, 15000),
    'the discarded candidate leaves the tray',
  );
  const afterDiscard = await evaluate(cdp, `(${TIME_TO_AUDIO})('#aceTray .acerow audio', ${BUDGET})`);
  ok(
    !afterDiscard.timedOut,
    `autoplay after Discard produces audio in ${Math.round(afterDiscard.ms)} ms ` +
      `${afterDiscard.timedOut ? JSON.stringify(afterDiscard) : ''}`,
  );

  // ── 3. SAVE, AND AUTOPLAY TAKES THE NEXT ────────────────────────────────────────────────
  await evaluate(cdp, `document.querySelector('#aceTray .acerow button[data-act="save"]').click()`);
  ok(await waitFor(cdp, `!!document.getElementById('vcNameIn')`, 8000), 'Save asks for a name');
  await evaluate(
    cdp,
    `(() => {
        const i = document.getElementById('vcNameIn');
        i.value = 'Timed Save';
        i.dispatchEvent(new Event('input', {bubbles: true}));
        document.querySelector('#mActs button.ok').click(); })()`,
  );
  ok(
    await waitFor(
      cdp,
      `[...document.querySelectorAll('#aceLibrary .acesong')]
            .some(r => /Timed Save/.test(r.innerText))`,
      20000,
    ),
    'the saved song reaches the library',
  );
  const afterSave = await evaluate(cdp, `(${TIME_TO_AUDIO})('#aceTray .acerow audio', ${BUDGET})`);
  ok(
    !afterSave.timedOut,
    `autoplay after Save produces audio in ${Math.round(afterSave.ms)} ms ` + `${afterSave.timedOut ? JSON.stringify(afterSave) : ''}`,
  );

  // ── 4. AND A SAVED SONG PLAYS FROM THE LIBRARY ──────────────────────────────────────────
  // Its bytes come through the vault rather than the proxy, exercising the production streaming path.
  await evaluate(
    cdp,
    `(() => {
        const a = document.querySelector('#aceLibrary .acesong audio');
        a.play(); return true; })()`,
  );
  const lib = await evaluate(cdp, `(${TIME_TO_AUDIO})('#aceLibrary .acesong audio', ${BUDGET})`);
  ok(!lib.timedOut, `a saved song plays in ${Math.round(lib.ms)} ms ${lib.timedOut ? JSON.stringify(lib) : ''}`);

  ok(thrown.length === 0, `the page threw nothing: ${thrown.join(' | ') || 'clean'}`);
} catch (e) {
  console.error(`  FAIL harness: ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

process.exit(failed ? 1 : 0);

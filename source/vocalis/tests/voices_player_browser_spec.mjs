// Browser-level checks for the shared Voices player.
//
// Markup and Flask client tests cannot establish that the browser loads or plays the audio.
// This spec checks media readiness, duration, playback progress, and element errors through CDP.
//
// No npm dependencies — Node 24 ships a global WebSocket and fetch, and Chrome speaks CDP over
// both. That keeps the kobold_ui_smoke.mjs / voices_ui_smoke.mjs convention intact.
//
// Usage: node voices_player_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

// `target` is the voice the harness wants played — the MULTI-MEGABYTE fixture. Picking "the
// first row" instead would silently drift onto whichever voice happens to sort first, and a
// small one exercises a single vault block rather than the streaming path every real voice
// takes.
const [baseUrl, chromePath, target] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node voices_player_browser_spec.mjs <base-url> <chrome-path> [voice]');
  process.exit(2);
}
const targetSel = target ? `#vList .item [data-vplay="${target}"]` : `#vList .item [data-vplay]`;

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

// ── CDP plumbing ─────────────────────────────────────────────────────────────
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

// Runtime.evaluate, unwrapped. userGesture matters: the player is opened from a click handler
// and Chrome's autoplay policy only relaxes under a real activation, so evaluating without it
// would fail for a reason the user never hits.
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

async function waitFor(cdp, expression, what, timeoutMs = 15000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // 🔴 `Promise.resolve(...)` IS THE WHOLE FIX. This was `!!(${expression})`, and when the
    // expression is a promise — every `fetch(...).then(...)` poll in these specs — `!!aPromise`
    // is `true` SYNCHRONOUSLY AND ALWAYS, whatever it resolves to. `evaluate` then awaited a
    // bare `true`. So the wait returned on its first poll every time and waited for nothing.
    //
    // ⚠️ IT FAILS AS A PASS, WHICH IS WHY IT SURVIVED. A broken wait does not hang, it races —
    // green whenever the machine is quick and red under a loaded suite, which reads exactly
    // like an environment flake. train_disk_browser_spec chased it twice on 2026-08-18 and
    // fixed the SYMPTOM (waiting on a better condition) while the wait itself still did not.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-cdp-'));
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
    // A self-signed/mkcert cert must not be what fails this spec.
    '--ignore-certificate-errors',
    // Deliberately NOT --autoplay-policy=no-user-gesture-required: the click IS the gesture,
    // and relaxing the policy here would hide a real "it never starts" regression.
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
  // 🔴 WAIT FOR CHROME TO ACTUALLY GO BEFORE DELETING ITS PROFILE. `kill()` returns at once and
  // Windows keeps the handles a moment longer, so an immediate recursive delete throws EBUSY -
  // and the `.catch()` that used to be on this line swallowed it. 182 dirs / 4.76 GB from one
  // suite run, measured 2026-08-18. Retried, because the exit event is not the last word either.
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

// Chrome writes the port it actually bound into DevToolsActivePort.
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

  // Collect network failures for the audio request — a red row in the Network tab is exactly
  // what a human would look at, so make the spec able to report the same thing.
  await cdp.send('Network.enable');
  const netFailures = [];
  const audioStatuses = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.loadingFailed') netFailures.push(m.params);
    if (m.method === 'Network.responseReceived' && /\/voices\/.*\/audio/.test(m.params.response.url)) {
      audioStatuses.push({ url: m.params.response.url, status: m.params.response.status });
    }
  });

  await cdp.send('Page.navigate', { url: baseUrl });
  // 🔴 `readyState === "complete"` IS NOT ENOUGH ON ITS OWN, AND 7.3-m8b PROVED IT. The very next
  // line calls `switchTab('voices')`, and `switchTab` names SIX module exports now — alignDevCols,
  // loadDevices, devPollStart, kobLoadAll, kobPollStop and, as of m8b, `loadVoiceList`. Those live
  // behind the `<script type="module">` shim at the bottom of the page, which fetches ~30 files and
  // then runs `Object.assign(window, …)`. `switchTab` itself is an inline function DECLARATION, so
  // it is hoisted and exists the instant the classic script is instantiated — which is why this
  // gate opened on a half-wired page and the run died with
  // `ReferenceError: loadVoiceList is not defined at switchTab`.
  //
  // ⚠️ AND `Page.navigate` IS WHY `complete` COULD BE TRUE TOO EARLY: the poll is asked of
  // whatever document is current, and `about:blank` is already complete. Same shape as the reload
  // race in clips_favorites_browser_spec.mjs, which stamps the outgoing document; here the
  // typeof-check does the job, because the name it asks about cannot exist in either the old
  // document or a half-installed new one.
  ok(
    await waitFor(
      cdp,
      'document.readyState === "complete" ' + '&& window.__uiReady === true && window.__bootDone === true',
      'the page loads and js/main.js has run',
    ),
    'the page loads',
  );

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
  // page's GLOBAL scope — so `switchTab('voices')` below would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);

  // Voices tab, then wait for the list to come back from /voices.
  await evaluate(cdp, `switchTab('voices')`);
  const listed = await waitFor(cdp, `document.querySelectorAll('#vList .item').length > 0`, 'the voice list renders');
  ok(listed, 'the Voices tab lists at least one voice');
  if (!listed) throw new Error('no voices rendered — the fixture did not reach the page');

  ok(
    await evaluate(cdp, `document.querySelectorAll('#vList audio').length === 0`),
    '🔴 no <audio> exists before you press ▶ (the tab issues no media request on open)',
  );

  // Press the green ▶ — a real click, carrying a user gesture.
  ok(await evaluate(cdp, `!!document.querySelector('${targetSel}')`), `the target voice ${target || '(first row)'} is on screen`);
  await evaluate(cdp, `document.querySelector('${targetSel}').click()`);

  ok(await waitFor(cdp, `document.querySelector('#vList .vplayer audio')`, 'the player appears'), 'pressing ▶ opens a player');

  // A failing snapshot says "no audio element" and leaves you guessing whether it never
  // appeared, errored, or was destroyed under you. Sample the first few seconds so the
  // failure output names which.
  //
  // 🔴 THE TIMELINE IS THE WAIT'S OWN POLL HISTORY NOW. It was fifteen samples taken 200 ms apart
  // BEFORE the wait, i.e. a fixed 3 s pause on every run (a passing one too) that existed only to
  // fill in a failure message. The same facts come from the polls of the wait below, so a fast
  // machine no longer pays 3 s and a slow one is not cut off at 3 s: each distinct state is
  // recorded with the time it was first seen, and only a failing run prints it.
  // 🔴 THE ASSERTION THIS WHOLE FILE EXISTS FOR. "Shows a bar but 00:00 and never plays" is
  // readyState 0 / duration NaN. Every string test in the suite passed through that bug.
  const timeline = [];
  let loaded = false;
  {
    const t0 = Date.now();
    let lastSnap = '';
    for (;;) {
      const snap = await evaluate(
        cdp,
        `(() => {
            const a = document.querySelector('#vList .vplayer audio');
            if (!a) return { gone: true, rows: document.querySelectorAll('#vList .item').length };
            return { readyState: a.readyState, networkState: a.networkState,
                     dur: a.duration, err: a.error ? a.error.code : null };
        })()`,
      );
      if (JSON.stringify(snap) !== lastSnap) {
        lastSnap = JSON.stringify(snap);
        timeline.push({ t: Date.now() - t0, ...snap });
      }
      if (!snap.gone && snap.readyState >= 1 && Number.isFinite(snap.dur) && snap.dur > 0) {
        loaded = true;
        break;
      }
      if (Date.now() - t0 > 20000) break; // a bound on a hang, not a duration anything depends on
      await sleep(100); // the step of a deadline-bounded wait
    }
  }

  const state = await evaluate(
    cdp,
    `(() => {
        const a = document.querySelector('#vList .vplayer audio');
        if (!a) return null;
        return { readyState: a.readyState, networkState: a.networkState,
                 duration: a.duration, currentSrc: a.currentSrc, paused: a.paused,
                 error: a.error ? { code: a.error.code, message: a.error.message } : null };
    })()`,
  );

  if (!loaded) console.error(`  timeline: ${JSON.stringify(timeline)}`);
  ok(loaded, `🔴 the media LOADS: readyState >= 1 and a real duration ` + `(got ${JSON.stringify(state)})`);
  ok(state && !state.error, `🔴 the audio element reports no error (got ${JSON.stringify(state?.error)})`);
  ok(
    audioStatuses.length > 0 && audioStatuses.every(s => s.status === 200 || s.status === 206),
    `the audio request succeeds (got ${JSON.stringify(audioStatuses)})`,
  );
  ok(
    !netFailures.some(f => /voices/.test(f.requestId) || f.type === 'Media'),
    `no network failure for the media (got ${JSON.stringify(netFailures.map(f => f.errorText))})`,
  );

  // And it actually advances — a loaded-but-frozen player is still broken.
  if (loaded) {
    await evaluate(cdp, `document.querySelector('#vList .vplayer audio').play().catch(()=>{})`);
    const advanced = await waitFor(
      cdp,
      `(() => {
            const a = document.querySelector('#vList .vplayer audio');
            return a && !a.paused && a.currentTime > 0;
        })()`,
      'playback advances',
      8000,
    );
    ok(advanced, '🔴 pressing ▶ actually PLAYS — currentTime advances and it is not paused');
  }

  // 🔴 SEEKING. A player you cannot scrub is broken even though it plays perfectly, and the
  // way it fails is silent: the playhead snaps straight back, as if the click never landed.
  // Chrome decides a resource is seekable from Accept-Ranges / a 206 — drop those and
  // `seekable` is EMPTY and every currentTime write is discarded. Assert the browser
  // considers it seekable AND that a seek actually sticks, because the first without the
  // second would still pass on a resource that silently refuses to move.
  if (loaded) {
    const seek = await evaluate(
      cdp,
      `(async () => {
            const a = document.querySelector('#vList .vplayer audio');
            const target = Math.min(30, a.duration / 2);
            a.currentTime = target;
            // 🔴 THE TIMER IS ONLY THE DEADLINE, AND THE OUTCOME SAYS WHICH ONE FIRED. This raced
            // 'seeked' against a 3 s timer and reported the same either way, so a seek the browser
            // never completed read as "it landed" if currentTime happened to be right already.
            const seeked = await new Promise(r => {
                a.addEventListener('seeked', () => r(true), { once: true });
                setTimeout(() => r(false), 20000);
            });
            return { seeked, seekableRanges: a.seekable.length,
                     seekableEnd: a.seekable.length ? a.seekable.end(0) : 0,
                     asked: target, landed: a.currentTime, duration: a.duration };
        })()`,
    );
    // seekable.length alone is NOT the question — a non-seekable resource still reports one
    // range, ending at 0. It is the END that says how far you may scrub.
    ok(
      seek.seekableEnd > seek.duration / 2,
      `🔴 the browser considers the clip SEEKABLE to its end — needs Accept-Ranges / a 206 ` + `(got ${JSON.stringify(seek)})`,
    );
    ok(
      seek.seeked && Math.abs(seek.landed - seek.asked) < 1.5,
      `🔴 a seek STICKS: asked for ${seek.asked?.toFixed?.(2)}s, landed at ` +
        `${seek.landed?.toFixed?.(2)}s (a snap-back to 0 is the bug)`,
    );
  }

  // 🔴 THE REGRESSION THIS FILE WAS BUILT FOR. Every re-render of #vList replaces it
  // wholesale — switchVTab, the ★ toggle, the sort, a rename, an upload, ↻ — and it used to
  // take the open player with it MID-LOAD. What the user saw was a bar stuck at 00:00 that
  // never played and ignored its seek bar. Force a re-render and require the SAME element to
  // come through it, still playing: re-creating it would restart the audio from zero, which
  // is its own bug (toggle a favorite mid-listen and the voice jumps back to the start).
  if (loaded) {
    await evaluate(cdp, `document.querySelector('#vList .vplayer audio').dataset.mark='keepme'`);
    const at = await evaluate(cdp, `document.querySelector('#vList .vplayer audio').currentTime`);
    await evaluate(cdp, `renderVoiceList()`);
    await waitFor(cdp, `!!document.querySelector('#vList .vplayer audio[data-mark="keepme"]')`, 8000);
    ok(
      await evaluate(cdp, `!!document.querySelector('#vList .vplayer audio[data-mark="keepme"]')`),
      '🔴 a re-render of the list does NOT destroy the open player — the same node survives',
    );
    ok(
      await evaluate(
        cdp,
        `(() => {
            const a = document.querySelector('#vList .vplayer audio');
            return a && !a.paused && a.currentTime >= ${at};
        })()`,
      ),
      '🔴 and it is still playing across the re-render, not restarted from zero',
    );
  }

  // Opening a DIFFERENT row moves the one player rather than leaving two behind. It must be a
  // different row: ▶ on the row that already holds the player is the dismiss gesture, so
  // indexing blindly would toggle it off and read as a failure.
  const rows = await evaluate(cdp, `document.querySelectorAll('#vList .item [data-vplay]').length`);
  if (rows > 1) {
    await evaluate(
      cdp,
      `(() => {
            const open = document.querySelector('#vList .vplayer').dataset.for;
            [...document.querySelectorAll('#vList .item [data-vplay]')]
                .find(b => b.dataset.vplay !== open).click();
        })()`,
    );
    await waitFor(cdp, `document.querySelectorAll('#vList .vplayer').length === 1`, 8000);
    ok(
      await evaluate(cdp, `document.querySelectorAll('#vList .vplayer').length === 1`),
      'a second ▶ moves the ONE player instead of opening another',
    );
    ok(
      await evaluate(
        cdp,
        `(() => {
            const p = document.querySelector('#vList .vplayer');
            return p && p.closest('.item').querySelector(` +
          '`[data-vplay="${p.dataset.for}"]`' +
          `) !== null;
        })()`,
      ),
      'and it lands inside the card whose ▶ was pressed',
    );
  }

  // ── the candidate rows alternate their background, MEASURED (7.2-m5) ─────────
  //
  // 🔴 THE SMOKE SPEC CAN ONLY SEE THAT THE RULE IS IN THE STYLESHEET. Whether it APPLIES is a
  // cascade question, and it is the one that can plausibly go wrong: every candidate row carries
  // `.panel`, which sets `background:var(--panel)`, so a selector that lost on specificity would
  // leave the rows identical with the CSS looking perfectly correct and the smoke spec green.
  // `#vcCandidates>[data-vccard]:nth-child(even)` is (1,2,0) against `.panel`'s (0,1,0) and wins
  // — but that is an argument. This is the measurement.
  //
  // ⚠️ THE ROWS ARE FAKE AND INJECTED, DELIBERATELY. A real one needs VoxCPM installed and a
  // generated candidate — minutes of GPU work to look at a background color — and the selector
  // cannot tell the difference between a real row and a div with the same attribute. What is
  // under test is the cascade, not the renderer; `voices_ui_smoke.mjs` covers the renderer.
  // ⚠️ getComputedStyle resolves through hidden ancestors, so the Create sub-tab does not have to
  // be open — and it is not, on a box with no VoxCPM.
  // ⚠️ BOTH THEMES, because `--panel` is #ffffff in the light one: a `--stripe` defined only in
  // `:root` renders as a near-black bar across every other row, which is worse than no stripes.
  const stripes = await evaluate(
    cdp,
    `(() => {
        const box = document.getElementById('vcCandidates');
        if (!box) return {err: 'there is no #vcCandidates in the page'};
        const held = box.innerHTML;
        box.innerHTML = '<div class="panel" data-vccard="a"></div>'
                      + '<div class="panel" data-vccard="b"></div>'
                      + '<div class="panel" data-vccard="c"></div>';
        const read = () => [0, 1, 2].map(i => getComputedStyle(box.children[i]).backgroundColor);
        const was = document.documentElement.getAttribute('data-theme');
        document.documentElement.setAttribute('data-theme', 'dark');
        const dark = read();
        document.documentElement.setAttribute('data-theme', 'light');
        const light = read();
        if (was) document.documentElement.setAttribute('data-theme', was);
        else document.documentElement.removeAttribute('data-theme');
        box.innerHTML = held;
        return {dark, light};
    })()`,
  );
  ok(!stripes.err, `the candidate list is in the page${stripes.err ? ` (${stripes.err})` : ''}`);
  for (const theme of ['dark', 'light']) {
    const got = stripes[theme];
    if (!got) continue;
    ok(got[0] !== got[1], `${theme} theme: row 2 is a different color from row 1 (${got[0]} vs ${got[1]})`);
    // 🔴 The third row is what makes this "alternating" rather than "the second one is odd".
    // A rule that shaded everything after the first would pass the check above.
    ok(got[0] === got[2], `${theme} theme: and row 3 is back to row 1's color, so they alternate (${got[2]})`);
  }

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} FAILED` : '\nall browser assertions passed');
} catch (err) {
  console.error(`  FAIL ${err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

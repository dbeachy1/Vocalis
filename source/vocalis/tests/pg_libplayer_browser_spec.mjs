// Vocalis 7.3.1 — the Playground library's player, in a REAL browser.
//
// Browser coverage for the Playground library player: playback toggles to Stop and the
// player opens inline beside the selected row.
//   * WHERE the player opens is a DOM-position fact. A `vm` smoke can prove `renderPgLib` returns a
//     row containing a button; it cannot prove the <audio> ends up in the <tr> underneath THAT row
//     rather than in a box above the table, because in a `vm` there is no table.
//   * ▶ vs ■ is a fact about `audio.paused`, which only a real media element has.
//
// 🔴 CHECK 6 IS THE ONE THIS FILE EXISTS FOR, and it is about the implementation rather than the
// feature. `renderPgLib` rebuilds `#pgLib` wholesale on a sort, a page, a checkbox, a favorite and
// every `loadPgLib` — so a player written into that HTML would be destroyed mid-playback several
// times a minute, and the old top-of-list position was immune to all of it. The fix is a single
// persistent node that is PARKED and RE-MOUNTED inside one synchronous turn; check 6 repaints while
// a clip is playing and demands the same node, still playing. Get the move wrong — split it across
// a task, drop the park — and the browser pauses the element at the next stable state, which is a
// silent stop a route test can never see.
//
// ⚠️ THE CLIPS ARE REAL FILES SERVED BY THE REAL ROUTE, not a stubbed fetch. A 404 or undecodable
// bytes leave `paused` true forever, and every ■ assertion below would fail for a reason that has
// nothing to do with the code under test. The wrapper seeds three ffmpeg-encoded mp3s.
//
// No npm dependencies — Node ships WebSocket and fetch, Chrome speaks CDP. The plumbing mirrors
// vc_autoplay_browser_spec.mjs.
//
// Usage: node pg_libplayer_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node pg_libplayer_browser_spec.mjs <base-url> <chrome-path>');
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

async function waitFor(cdp, expression, timeoutMs = 20000) {
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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-pgplay-cdp-'));
// ⚠️ `--autoplay-policy=no-user-gesture-required` is not a shortcut around a real gesture — every
// click below IS a real gesture (CDP's userGesture:true). It removes the OTHER autoplay input, the
// per-origin Media Engagement Index, which is a property of a fresh profile rather than of the app
// and would make ▶ start or not start depending on how many times this spec had run before.
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
    '--autoplay-policy=no-user-gesture-required',
    '--ignore-certificate-errors',
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

// The ref of the row DIRECTLY ABOVE the player, which is the whole "in line" requirement in one
// expression: '(home)' when it is parked above the table, '(loose)' if it is somewhere else again.
const WHERE = `(() => {
    const a = document.querySelector('#pgLibPlayer audio');
    if (!a) return '(no player)';
    if (document.getElementById('pgLibHome').contains(a)) return '(home)';
    const tr = a.closest('tr');
    if (!tr || !tr.classList.contains('pgplayrow')) return '(loose)';
    const prev = tr.previousElementSibling;
    return (prev && prev.classList.contains('pgrow')) ? prev.dataset.ref : '(no row above)';
})()`;
const FACE = ref => `(() => {
    const b = document.querySelector('#pgLib button[data-play="' + ${JSON.stringify(ref)} + '"]');
    return b ? b.textContent.trim() : '(no button)';
})()`;

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
  await waitFor(cdp, `window.__uiReady === true && window.__bootDone === true`);
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);

  // ── the library, drawn by the REAL loader from the REAL route ───────────
  await evaluate(cdp, `(async () => { switchTab('playground'); await loadPgLib(); return true; })()`);
  ok(await waitFor(cdp, `document.querySelectorAll('#pgLib tr.pgrow').length === 3`, 8000), 'the three seeded clips are in the library');
  const refs = await evaluate(cdp, `[...document.querySelectorAll('#pgLib tr.pgrow')].map(r => r.dataset.ref)`);
  const [first, second] = refs;
  ok(await evaluate(cdp, `document.querySelectorAll('#pgLib button[data-play]').length === 3`), 'every row carries its own play button');
  ok(
    await evaluate(
      cdp,
      `[...document.querySelectorAll('#pgLib button[data-play]')]
                             .every(b => b.textContent.trim() === '▶')`,
    ),
    'and they all start as ▶',
  );
  ok(await evaluate(cdp, `!document.querySelector('#pgLibPlayer audio')`), 'nothing is playing yet');

  // ── 1. ▶ opens the player IN THE ROW, not above the table ──────────
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('#pgLib button[data-play="' + ${JSON.stringify(second)} + '"]').click();
        return true; })()`,
  );
  ok(await waitFor(cdp, `document.querySelector('#pgLibPlayer audio')`, 8000), 'pressing ▶ creates a player');
  ok((await evaluate(cdp, WHERE)) === second, '🔴 and it opens IN LINE — in the row directly under the clip you pressed ▶ on');
  ok(
    await evaluate(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('#pgLib tbody tr')];
        const pl = rows.findIndex(r => r.classList.contains('pgplayrow'));
        return pl === 2;   // header-less tbody: row0, row1(clicked), player
    })()`,
    ),
    'the player row sits between the clicked row and the next clip, not at the top',
  );
  ok(
    await evaluate(cdp, `document.getElementById('pgLibHome').children.length === 0`),
    'the box above the list is empty — the player is not in two places',
  );

  // ── 2. the button becomes ■ while it plays ─────────────────────────
  ok(
    await waitFor(
      cdp,
      `(() => { const a = document.querySelector('#pgLibPlayer audio');
                                    return a && !a.paused; })()`,
      8000,
    ),
    'the clip actually starts playing (a real mp3 over the real route)',
  );
  ok((await evaluate(cdp, FACE(second))) === '■', '🔴 the ▶ on that row has become ■ — you can stop it right there');
  ok((await evaluate(cdp, FACE(first))) === '▶', 'and only that row: every other row still offers ▶');
  ok(
    await evaluate(
      cdp,
      `document.querySelector('#pgLib button[data-play="'
        + ${JSON.stringify(second)} + '"]').title === 'Stop'`,
    ),
    'its tooltip says Stop too, not Play',
  );

  // ── 3. ■ stops it, right there ─────────────────────────────────────
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('#pgLib button[data-play="' + ${JSON.stringify(second)} + '"]').click();
        return true; })()`,
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const a = document.querySelector('#pgLibPlayer audio');
                                     return !!a && a.paused && a.currentTime === 0; })()`,
    ),
    '🔴 pressing ■ STOPS it — paused and rewound, not merely paused',
  );
  ok((await evaluate(cdp, FACE(second))) === '▶', 'and the button goes back to ▶');
  ok((await evaluate(cdp, WHERE)) === second, 'the player stays open in the row, so ▶ plays it again without hunting for it');

  // ── 4. ▶ again plays the same clip again ───────────────────────────
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('#pgLib button[data-play="' + ${JSON.stringify(second)} + '"]').click();
        return true; })()`,
  );
  ok(
    (await waitFor(
      cdp,
      `(() => { const a = document.querySelector('#pgLibPlayer audio');
                                    return a && !a.paused; })()`,
      8000,
    )) && (await evaluate(cdp, FACE(second))) === '■',
    'pressing ▶ again restarts it and the button flips back to ■',
  );

  // ── 5. the native controls own the glyph too ────────────────────────────
  // Pausing with the player's own ⏸ has to put ▶ back, or the row offers to stop
  // something that already stopped. The glyph follows the AUDIO, not the click that started it.
  await evaluate(cdp, `(() => { document.querySelector('#pgLibPlayer audio').pause(); return true; })()`);
  await waitFor(cdp, `document.querySelector('#pgLibPlayer audio').paused`, 8000);
  ok((await evaluate(cdp, FACE(second))) === '▶', 'pausing with the native control puts ▶ back on the row');
  await evaluate(cdp, `(() => { document.querySelector('#pgLibPlayer audio').play(); return true; })()`);
  await waitFor(cdp, `!document.querySelector('#pgLibPlayer audio').paused`, 8000);

  // ── 6. 🔴 A REPAINT MUST NOT STOP THE MUSIC ───────────────────
  // The player is a child of the table now, and renderPgLib rebuilds the table constantly. This
  // is the check that the park-and-remount is a MOVE and not a re-creation: same node (the mark
  // survives), same position in the DOM, still playing.
  await evaluate(
    cdp,
    `(() => { document.querySelector('#pgLibPlayer audio').dataset.specMark = 'x';
                                  return true; })()`,
  );
  const wasAt = await evaluate(cdp, `document.querySelector('#pgLibPlayer audio').currentTime`);
  await evaluate(cdp, `(() => { renderPgLib(); return true; })()`);
  ok(
    await evaluate(
      cdp,
      `(() => { const a = document.querySelector('#pgLibPlayer audio');
                                     return !!a && a.dataset.specMark === 'x'; })()`,
    ),
    '🔴 a repaint MOVES the very same player node — it is not rebuilt',
  );
  ok(await evaluate(cdp, `!document.querySelector('#pgLibPlayer audio').paused`), '🔴 …and the clip is still playing across the repaint');
  ok((await evaluate(cdp, WHERE)) === second, 'and it is still in its row afterward');
  ok((await evaluate(cdp, FACE(second))) === '■', 'the repainted row draws ■, not a stale ▶');
  await waitFor(cdp, `document.querySelector('#pgLibPlayer audio').currentTime > ${wasAt}`, 8000);
  ok(
    (await evaluate(cdp, `document.querySelector('#pgLibPlayer audio').currentTime`)) > wasAt,
    'the playhead really did keep moving (paused would be a lie without this)',
  );

  // ── 7. ▶ on another row moves the player to THAT row ───────────────
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('#pgLib button[data-play="' + ${JSON.stringify(first)} + '"]').click();
        return true; })()`,
  );
  ok(
    (await waitFor(cdp, `document.querySelectorAll('#pgLib tr.pgplayrow').length === 1`, 8000)) && (await evaluate(cdp, WHERE)) === first,
    'playing another clip moves the player to that row — never two players on the page',
  );
  ok(
    (await waitFor(
      cdp,
      `(() => { const a = document.querySelector('#pgLibPlayer audio');
                                    return a && !a.paused; })()`,
      8000,
    )) &&
      (await evaluate(cdp, FACE(first))) === '■' &&
      (await evaluate(cdp, FACE(second))) === '▶',
    'the new row wears ■ and the old one is back to ▶',
  );

  // ── 8. filtered off the page, it parks at home and plays on ─────────────
  // The alternative is a player that vanishes with its row, i.e. audio you can hear and cannot
  // stop. Home is where it came from, so this is also the pre-7.3.1 behavior, kept for the one
  // case that needs it.
  await evaluate(
    cdp,
    `(() => { const s = document.getElementById('pgSearch');
        s.value = 'zzzz-no-such-clip'; s.dispatchEvent(new Event('input', {bubbles: true}));
        return true; })()`,
  );
  ok(await evaluate(cdp, `document.querySelectorAll('#pgLib tr.pgrow').length === 0`), 'filtering everything out empties the list');
  ok((await evaluate(cdp, WHERE)) === '(home)', 'the player parks above the list when its row is filtered away');
  ok(
    await evaluate(cdp, `!document.querySelector('#pgLibPlayer audio').paused`),
    '🔴 …and it is STILL PLAYING — a filter must not silently kill playback',
  );
  await evaluate(
    cdp,
    `(() => { const s = document.getElementById('pgSearch');
        s.value = ''; s.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`,
  );
  ok((await evaluate(cdp, WHERE)) === first, 'clearing the filter puts it back in its row');

  ok(pageErrors.length === 0, `the page threw no errors (${pageErrors.join(' | ') || 'none'})`);

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
} catch (e) {
  console.error(`spec error: ${(e && e.stack) || e}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

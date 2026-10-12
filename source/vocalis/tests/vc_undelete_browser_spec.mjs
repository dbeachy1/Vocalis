// Vocalis 7.3-m4e/m4f — the Create-a-voice queue's LIST CONTROLS, in a REAL browser:
// ↩ Undelete last (the one-slot recycle bin) and the fifty-per-page footer.
//
// They share a file because they are the same question asked twice — what the render paths do
// with the list — and because they interact: a delete on page 2 must leave you on page 2, with
// the range and the total following it. Two specs would each have half of that.
//
// The one-slot undo behavior keeps the most recently removed clip available until another delete
// replaces it.
//
// 🔴 THE PROPERTY UNDER TEST IS "WHAT REACHED THE SERVER", AND ONLY A FAKE `fetch` CAN SEE IT.
// The whole feature is that a ✕ gesture LOOKS like a delete and is not one yet. A spec that reads
// the DOM alone cannot tell the deferral from a plain delete — both remove the row — so every
// check below that matters is a claim about `window.__deleted`, the list of tokens the route was
// actually asked to remove. `jget`/`jpost` resolve `fetch` off the global at call time and no
// milestone of this split can move that, which is why the stub is stable as well as necessary.
//
// ⚠️ AND THE RENDER PATHS ARE THE ACTUAL RISK, not the bin. `loadCandidates` re-reads the list
// from the server, which still HAS the binned clip — so it comes straight back unless every path
// that presents the list agrees to hide it: renderCandidates, the incremental prepend, the removal
// sweep beside it, the header's counts and total, and Select all. The refresh checks below are
// there because "it worked until the batch landed a round" is the shape of the bug this feature
// invites, and a batch lands one every 30–60 s.
//
// 📌 The clip `src` is a 44-byte silent WAV as a data: URI, for the reason
// vc_autoplay_browser_spec.mjs records: `preload="none"` should mean no request, but a URL that
// 404s puts §20.1's dead-clip notice INTO a row, which is a mutation in the box autoplay watches.
//
// No npm dependencies — Node ships WebSocket and fetch, Chrome speaks CDP. The plumbing mirrors
// vc_autoplay_browser_spec.mjs.
//
// Usage: node vc_undelete_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node vc_undelete_browser_spec.mjs <base-url> <chrome-path>');
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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-vcun-cdp-'));
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

// The tokens with a row on screen, top first.
const ROWS = `[...document.querySelectorAll('#vcCandidates [data-vccard]')].map(e => e.dataset.vccard)`;

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
  // 🔴 `complete`, not a function probe — js/voice/candidates.js is a module and modules run
  // after parsing, so gating on an inline name opens before the shim has published anything.
  await waitFor(cdp, `document.readyState === 'complete'`);

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
  // page's GLOBAL scope — so every name this spec drives would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  // ── the control exists, in its expected location ────────────────────────
  ok(await evaluate(cdp, `!!document.getElementById('vcUndel')`), 'the ↩ Undelete last button is in the page');
  ok(
    await evaluate(cdp, `document.getElementById('vcUndel').disabled === true`),
    'and it starts DISABLED, exactly like ✕ Delete selected with nothing ticked',
  );
  ok(
    await evaluate(
      cdp,
      `(() => {
        const kids = [...document.getElementById('vcCandHead').children];
        const moreTop = kids.indexOf(document.getElementById('vcCandMoreTop'));
        const undel = kids.indexOf(document.getElementById('vcUndel'));
        const del = kids.indexOf(document.getElementById('vcDelSel'));
        return moreTop >= 0 && moreTop < undel && undel < del;
    })()`,
    ),
    'it sits between Show all and ✕ Delete selected, in the expected location',
  );
  ok(
    await evaluate(
      cdp,
      `document.getElementById('vcUndel').classList.contains('recover')
                            && document.getElementById('vcUndel').classList.contains('xs')`,
    ),
    'and it is the amber `recover` button at `xs` — the same shape as the red one beside it',
  );

  // ── the harness: BE the candidates route, and record what reaches it ────
  await evaluate(
    cdp,
    `(() => {
        const WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
        window.__cands = [];
        window.__deleted = [];          // 🔴 every token the route was actually asked to remove
        window.__saved = [];
        const REAL = window.fetch.bind(window);
        const jres = o => new Response(JSON.stringify(o),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        window.fetch = (input, init) => {
            const u = String(typeof input === 'string' ? input : (input && input.url) || '');
            if (u.includes('/voices/design/candidates')) {
                return Promise.resolve(jres({
                    candidates: window.__cands.map((t, i) => ({
                        token: t, url: WAV, size: 100_000, created: 1754500000 - i,
                        duration_s: 1.5, seed: 1000 + i,
                    })),
                    total_bytes: 100_000 * window.__cands.length,
                }));
            }
            if (u.includes('/voices/design/delete')) {
                const toks = (JSON.parse((init && init.body) || '{}').tokens) || [];
                window.__deleted.push(...toks);
                window.__cands = window.__cands.filter(t => !toks.includes(t));
                return Promise.resolve(jres({ deleted: toks.length }));
            }
            if (u.includes('/voices/design/save')) {
                window.__saved.push(JSON.parse((init && init.body) || '{}').token);
                return Promise.resolve(jres({ name: 'spec', label: 'Spec voice', peak_dbfs: -3 }));
            }
            return REAL(input, init);
        };
        // A clean panel: empty the bin, set what the server has, let the REAL loader draw it.
        window.__seed = toks => {
            vcUndelete();
            window.__cands = toks.slice();
            window.__deleted = [];
            return loadCandidates();
        };
        window.__dlg = label => [...document.getElementById('mActs').children]
            .find(b => b.textContent === label);
        window.__tick = t => { const cb = document.querySelector('[data-vcsel="' + t + '"]');
            cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); };
        return true;
    })()`,
  );

  // ── 1. 🔴 a ✕ removes the row and sends NOTHING ─────────────────────────
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  ok(await evaluate(cdp, `JSON.stringify(${ROWS}) === '["a","b","c"]'`), 'the real render path drew the seeded queue');
  await evaluate(cdp, `document.querySelector('[data-vcdel="a"]').click()`);
  await waitFor(cdp, `!document.querySelector('[data-vccard="a"]')`, 8000);
  ok(
    await evaluate(cdp, `JSON.stringify(${ROWS}) === '["b","c"]'`),
    'pressing ✕ takes the row off the list at once — it has to FEEL like a delete',
  );
  ok(
    await evaluate(cdp, `window.__deleted.length === 0 && window.__cands.includes('a')`),
    '🔴 …and NOTHING was sent: the clip is still on the server, in the recycle bin',
  );

  // ── 2. the button wakes up, and putting it back is exact ────────────────
  ok(await evaluate(cdp, `document.getElementById('vcUndel').disabled === false`), 'a filled bin enables ↩ Undelete last');
  await evaluate(cdp, `document.getElementById('vcUndel').click()`);
  await waitFor(cdp, `!!document.querySelector('[data-vccard="a"]')`, 8000);
  ok(
    await evaluate(cdp, `JSON.stringify(${ROWS}) === '["a","b","c"]'`),
    "🔴 undeleting puts the row back IN ITS PLACE — newest-first order is the server's, and " + 'nothing about the bin should reorder it',
  );
  ok(
    await evaluate(cdp, `document.getElementById('vcUndel').disabled === true`),
    'and the button goes back to disabled — the bin is empty again',
  );

  // ── 3. 🔴 ONE DELETION DEEP: the next ✕ is what commits the last one ────
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(cdp, `document.querySelector('[data-vcdel="a"]').click()`);
  await waitFor(cdp, `!document.querySelector('[data-vccard="a"]')`, 8000);
  await evaluate(cdp, `document.querySelector('[data-vcdel="b"]').click()`);
  await waitFor(cdp, `window.__deleted.length > 0`, 8000);
  ok(
    await evaluate(cdp, `JSON.stringify(window.__deleted) === '["a"]'`),
    '🔴 the SECOND delete commits the first — "a" is off the server, and only "a"',
  );
  ok(await evaluate(cdp, `window.__cands.includes('b')`), 'and "b" is not: it has taken the bin\'s one slot');
  await evaluate(cdp, `document.getElementById('vcUndel').click()`);
  await waitFor(cdp, `!!document.querySelector('[data-vccard="b"]')`, 8000);
  ok(
    await evaluate(cdp, `JSON.stringify(${ROWS}) === '["b","c"]'`),
    '🔴 …so undeleting now brings back "b" and NOT "a" — one deletion is all it holds',
  );

  // ── 4. 🔴 ONE **DELETION**, NOT ONE CLIP: a mass-delete comes back whole ─
  // The accident most worth undoing is ✕ Delete selected with twenty rows ticked, so the bin is
  // keyed on the gesture. A bin holding one clip would return one row of the twenty and read as
  // broken, which is worse than not having the button.
  await evaluate(cdp, `window.__seed(['a','b','c','d'])`);
  await evaluate(
    cdp,
    `(() => { window.__tick('a'); window.__tick('b'); window.__tick('c');
        document.getElementById('vcDelSel').click(); return true; })()`,
  );
  ok(
    await waitFor(cdp, `document.getElementById('mTitle').textContent === 'Delete candidates'`, 8000),
    'the mass-delete still confirms first',
  );
  ok(
    await evaluate(cdp, `/Undelete last/.test(document.getElementById('mBody').innerHTML)`),
    '🔴 and the dialog now says the delete is undoable, rather than "they do not come back"',
  );
  await evaluate(cdp, `window.__dlg('Delete').click()`);
  await waitFor(cdp, `${ROWS}.length === 1`, 8000);
  ok(
    await evaluate(cdp, `JSON.stringify(${ROWS}) === '["d"]' && window.__deleted.length === 0`),
    'three rows leave together, and nothing is sent',
  );
  await evaluate(cdp, `document.getElementById('vcUndel').click()`);
  await waitFor(cdp, `${ROWS}.length === 4`, 8000);
  ok(
    await evaluate(cdp, `JSON.stringify(${ROWS}) === '["a","b","c","d"]'`),
    '🔴 ALL THREE come back together — the bin holds one DELETION, not one clip',
  );

  // ── 5. 🔴 A REFRESH UNDERNEATH A BINNED CLIP MUST NOT RESURRECT IT ──────
  // This is the one that would actually have shipped broken. `loadCandidates` re-reads from the
  // server, which still has the clip, and the overnight batch triggers exactly that every 30–60 s
  // — so "it worked until a round landed" is the failure mode, and it lands while he is watching.
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(cdp, `document.querySelector('[data-vcdel="a"]').click()`);
  await waitFor(cdp, `!document.querySelector('[data-vccard="a"]')`, 8000);
  await evaluate(cdp, `loadCandidates()`);
  await waitFor(cdp, `JSON.stringify(${ROWS}) === '["b","c"]'`, 8000);
  ok(await evaluate(cdp, `JSON.stringify(${ROWS}) === '["b","c"]'`), '🔴 a full refresh does not bring the binned row back');
  // ── 5a. 🔴 AND A DEFERRED DELETE MUST NOT CUT OFF THE CLIP HE IS AUDITIONING (§17.4) ──
  //
  // The whole triage flow is: play the top one, and while it runs, tick or ✕ the rows below.
  // `renderCandidates` assigns innerHTML, which destroys every <audio> in the box — so a delete
  // that repaints kills the clip that is playing. The old path got this right by accident, via
  // `loadCandidates`'s incremental branch; deferring means `vcBinDelete` repaints directly and
  // has to carry the rule itself. Asserted on NODE IDENTITY, because that is the only thing that
  // distinguishes "the row survived" from "an identical row was drawn over it" — and only the
  // former keeps playing.
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(
    cdp,
    `(() => {
        const a = document.querySelector('[data-vccard="a"] audio');
        Object.defineProperty(a, 'paused', { get: () => false, configurable: true });
        window.__topAudio = a; return true; })()`,
  );
  await evaluate(cdp, `document.querySelector('[data-vcdel="c"]').click()`);
  await waitFor(cdp, `!document.querySelector('[data-vccard="c"]')`, 8000);
  ok(
    await evaluate(
      cdp,
      `JSON.stringify(${ROWS}) === '["a","b"]'
        && document.querySelector('[data-vccard="a"] audio') === window.__topAudio`,
    ),
    '🔴 deleting another row while a clip plays removes THAT row and leaves the playing ' +
      '<audio> element untouched — a repaint here would stop the clip mid-audition',
  );

  // ── 6. the header counts what is on screen, not what the server has ─────
  // ⚠️ 100 kB a clip, not 100 B: fmtSize renders anything under a megabyte in whole KB, so a
  // three-figure byte count would print "0 KB" and this check would pass on a fixture that
  // could not tell 300 bytes from 300 million.
  await evaluate(cdp, `window.__seed(['a','b','c','d'])`);
  await evaluate(cdp, `document.querySelector('[data-vcdel="a"]').click()`);
  await waitFor(cdp, `!document.querySelector('[data-vccard="a"]')`, 8000);
  ok(
    await evaluate(
      cdp,
      `/^3 candidates · 300 KB on disk/.test(
        document.getElementById('vcCandTotals').textContent)`,
    ),
    '🔴 the header counts the VISIBLE rows and subtracts the held bytes — 19 rows over the ' +
      'words "20 candidates" is the header contradicting the list it sits on',
  );

  // ── 7. 🔴 SAVE DOES NOT FILL THE BIN ────────────────────────────────────
  // Saving deletes the candidate on purpose (7.2-m5) and its bytes now live inside a real voice.
  // Offering to resurrect a candidate whose voice already exists is a confusing state, not a
  // safety net — so the save path is the one caller that still deletes immediately.
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(cdp, `document.querySelector('[data-vcsave="a"]').click()`);
  await waitFor(cdp, `!!document.getElementById('vcNameIn')`, 8000);
  await evaluate(
    cdp,
    `(() => { document.getElementById('vcNameIn').value = 'Spec voice';
        window.__dlg('Save voice').click(); return true; })()`,
  );
  await waitFor(cdp, `document.getElementById('mTitle').textContent === 'Voice created'`, 8000);
  await evaluate(cdp, `window.__dlg('OK').click()`);
  ok(
    await evaluate(
      cdp,
      `JSON.stringify(window.__deleted) === '["a"]'
                            && JSON.stringify(window.__saved) === '["a"]'`,
    ),
    '🔴 saving deletes its candidate for REAL, at once — no deferral',
  );
  ok(
    await evaluate(cdp, `document.getElementById('vcUndel').disabled === true`),
    '🔴 …and the bin stays empty: a saved voice is not something to offer to undelete',
  );

  // ── 8. on the way out, the bin is committed ─────────────────────────────
  // Closing the tab does the thing he thinks already happened. Best-effort by design: if it does
  // not land the clip is still there next visit, which is the safe direction for a panel whose
  // stated contract is "nothing here expires; only you delete it".
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(cdp, `document.querySelector('[data-vcdel="a"]').click()`);
  await waitFor(cdp, `!document.querySelector('[data-vccard="a"]')`, 8000);
  await evaluate(cdp, `(() => { window.dispatchEvent(new Event('beforeunload')); return true; })()`);
  await waitFor(cdp, `window.__deleted.length > 0`, 8000);
  ok(
    await evaluate(cdp, `JSON.stringify(window.__deleted) === '["a"]'`),
    '🔴 leaving the page commits the bin — a deferred delete must not survive the tab',
  );

  // ── 9. paging, clicked for real (7.3-m4f) ──────────────────────────────
  //
  // voices_ui_smoke.mjs drives the RENDERING at 120 rows and covers the boundaries, the clamp and
  // the wording; what it cannot prove is that the
  // buttons are wired to anything, because it never clicks one. A footer that renders perfectly
  // and does nothing is the exact failure §17.4 was about — a control that exists and cannot be
  // used — so the clicks are checked where clicks are real.
  await evaluate(cdp, `window.__seed(Array.from({length: 120}, (_, i) => 'p' + i))`);
  ok(await evaluate(cdp, `${ROWS}.length === 50 && ${ROWS}[0] === 'p0'`), 'the queue opens on fifty rows, newest first');
  ok(
    await evaluate(cdp, `/Page 1 of 3/.test(document.getElementById('vcCandMore').innerHTML)`),
    'and the footer says which page of how many',
  );
  await evaluate(cdp, `document.getElementById('vcNext').click()`);
  await waitFor(cdp, `${ROWS}[0] === 'p50'`, 8000);
  ok(
    await evaluate(
      cdp,
      `${ROWS}.length === 50 && ${ROWS}[0] === 'p50'
        && /Page 2 of 3/.test(document.getElementById('vcCandMore').innerHTML)`,
    ),
    '🔴 clicking Next › actually turns the page',
  );
  await evaluate(cdp, `document.getElementById('vcPrev').click()`);
  await waitFor(cdp, `${ROWS}[0] === 'p0'`, 8000);
  ok(
    await evaluate(
      cdp,
      `${ROWS}[0] === 'p0'
        && document.getElementById('vcPrev').disabled === true`,
    ),
    'and ‹ Previous turns it back, then disables itself at the start',
  );
  await evaluate(cdp, `document.getElementById('vcShowAll').click()`);
  await waitFor(cdp, `${ROWS}.length === 120`, 8000);
  ok(
    await evaluate(
      cdp,
      `${ROWS}.length === 120
        && /Show 50 per page/.test(document.getElementById('vcCandMore').innerHTML)`,
    ),
    'Show all opens the lot, and offers the way back to fifty',
  );
  await evaluate(cdp, `document.getElementById('vcPaged').click()`);
  await waitFor(cdp, `${ROWS}.length === 50`, 8000);
  ok(await evaluate(cdp, `${ROWS}.length === 50 && ${ROWS}[0] === 'p0'`), '…and the way back works, from page 1');

  // ── 9a. 🔴 PAGING AND THE BIN AGREE. Deleting off page 2 must not silently move you. ──
  await evaluate(cdp, `document.getElementById('vcNext').click()`);
  await waitFor(cdp, `${ROWS}[0] === 'p50'`, 8000);
  await evaluate(cdp, `document.querySelector('[data-vcdel="p50"]').click()`);
  await waitFor(cdp, `!document.querySelector('[data-vccard="p50"]')`, 8000);
  ok(
    await evaluate(
      cdp,
      `${ROWS}[0] === 'p51' && ${ROWS}.length === 50
        && /Page 2 of 3/.test(document.getElementById('vcCandMore').innerHTML)
        && /showing 51–100 of 119/.test(document.getElementById('vcCandMore').innerHTML)`,
    ),
    '🔴 a delete on page 2 leaves you on page 2, and the range and total follow it',
  );

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

// Vocalis 7.3-m4 — Autoplay for the Create-a-voice candidate queue, in a REAL browser.
//
// The whole feature is DOM observation — a MutationObserver on #vcCandidates plus two click
// listeners — so there is nothing for a `vm`-based smoke to run. voices_ui_smoke.mjs can prove what
// renderCandidates RETURNS; it is structurally incapable of proving that ticking a checkbox starts
// a clip, or (much more importantly) that a clip finishing does NOT start the next one.
//
// Negative behavior is central: playback stops when a clip finishes and does not advance until
// save or delete. An unrelated repaint and deleting a non-top row must not start playback.
//
// ⚠️ HOW PLAYBACK IS OBSERVED. Headless Chrome will not decode audio, and the candidate <audio>
// elements point at real routes, so asserting on real playback would be testing the browser. This
// stubs HTMLMediaElement.prototype.play to RECORD the token it was called on — exactly the boundary
// the module owns: it decides what to play and when, the browser owns the rest.
//
// 🔴 AND `fetch` IS WHAT IS STUBBED — NOT `vcDelete` (7.3-m4b). It used to be
// `window.vcDelete = async () => {}`, which worked for exactly as long as `vcDelete` was an inline
// function declaration and therefore a property of the global object. The moment the candidate
// queue became js/voice/candidates.js, its own click handler held a MODULE BINDING: the assignment
// still succeeded, was never consulted, and the real delete ran against a route with no such
// candidate — the silent failure tests/test_webui_modules.py exists to catch, and it caught this.
//
// ⚠️ THE REPLACEMENT IS A BETTER SPEC, not merely a legal one. `jget`/`jpost` resolve `fetch` off
// the global at CALL time, and no split can move that, so a fake fetch is stable across every
// remaining milestone. It also serves the candidate list, which means the rows on screen are drawn
// by the REAL renderCandidates from a REAL loadCandidates after a REAL vcDelete — the whole
// gesture → server → repaint → observer chain autoplay actually rides on. The old spec removed the
// row itself with a synthetic `window.__drop`, so it could not have noticed if that chain broke.
//
// No npm dependencies — Node ships WebSocket and fetch, Chrome speaks CDP. The plumbing below
// mirrors devices_browser_spec.mjs.
//
// Usage: node vc_autoplay_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { INSTALL_NET_IDLE, NET_IDLE, NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node vc_autoplay_browser_spec.mjs <base-url> <chrome-path>');
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

/** How long to watch for a play that must NOT happen.
 *
 * 🔴 EVERY REMAINING SLEEP IN THIS FILE IS ONE OF THESE, AND THEY STAY. Six of this spec's seven
 * claims are ABSENCES — "deleting the top row plays nothing", "a clip reaching its end plays
 * NOTHING", "the arm is SPENT". You cannot `waitFor` something that must never happen: the only
 * way to assert an absence is to watch for a while and find nothing, so real time has to pass.
 * Converting these to conditions would not make them faster, it would make them vacuous.
 *
 * ⚠️ Named rather than sprinkled as a literal so it reads as the designed window it is. `vcPlay`
 * is called straight out of the delete/repaint handlers — no timer, no fetch — so anything that
 * was going to play has played long before this elapses; the margin is for a loaded box, not for
 * a scheduled call. The file's ONE positive claim is a `waitFor`, as it should be.
 */
// 🔴 SUPERSEDED 2026-10-12 (Doug: "Real engineers don't do sleeps in specs because they're
// inherently indeterminate. They vary by system load."): `QUIET_MS` and the six `sleep(QUIET_MS)`
// calls are gone. The argument above is right that an absence cannot be waited FOR, and wrong that
// real time has to pass: what an absence check needs is a positive signal that everything the
// action could have set going has FINISHED, and then a read of the record that was armed before
// the action. `__played` is that record (reset in the same evaluate that performs the action, so
// it sees every `play()` from that moment on). The signal is `quiet()` below: no request in flight,
// no response body still being read, and a frame drawn since. That covers the delete's whole tail
// (`vcCommitBin`, then `loadCandidates`) and every MutationObserver callback, which is delivered
// in a microtask and so has run before any later task can observe the page. 250 ms was a guess at
// how long that took on the author's machine.
/** Resolves once the page has nothing left in flight and has painted a frame since. Throws on a hang. */
async function quiet(cdp) {
  if (!(await waitFor(cdp, NET_IDLE, 30000)))
    throw new Error('the page never went idle: a request or a response body stayed in flight for 30 s');
  await evaluate(cdp, NEXT_FRAME);
}

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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-vcap-cdp-'));
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
  // 🔴 `complete`, not a function probe. js/voice/autoplay.js is a module, and modules run after
  // parsing — gating on an inline name opens too early. That is the m4 lesson from
  // clips_favorites_browser_spec.mjs, which threw ReferenceError doing exactly that.
  await waitFor(cdp, `document.readyState === 'complete'`);

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
  // page's GLOBAL scope — so every name this spec drives would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  // ── the control exists in the page ─────────────────────────
  ok(await evaluate(cdp, `!!document.getElementById('vcAutoplay')`), 'the Autoplay checkbox is in the page');
  ok(await evaluate(cdp, `document.getElementById('vcAutoplay').checked === false`), 'and it is OFF by default');
  ok(
    await evaluate(
      cdp,
      `(() => {
        const kids = [...document.getElementById('vcCandHead').children];
        const totals = kids.indexOf(document.getElementById('vcCandTotals'));
        const sep = kids.findIndex(e => e.classList.contains('vsep'));
        const box = kids.findIndex(e => e.contains(document.getElementById('vcAutoplay')));
        const del = kids.indexOf(document.getElementById('vcDelSel'));
        return totals >= 0 && totals < sep && sep < box && box < del;
    })()`,
    ),
    'it sits after the totals sentence, behind a vertical separator, before Delete selected',
  );

  // ── the harness: record play() calls, and BE the candidates route ───────
  //
  // The fake fetch owns three routes and passes everything else through, so the page's own
  // pollers, the UI-state store and the voices list all keep talking to the real server:
  //
  //   GET  /voices/design/candidates  → `window.__cands`, in list order (newest first)
  //   POST /voices/design/delete      → removes those tokens from it, exactly as the server would
  //   POST /voices/design/save        → succeeds, so the save path reaches its own vcDelete
  //
  // ⚠️ The clip `src` is a 44-byte silent WAV as a data: URI. `preload="none"` means the browser
  // should never fetch it, and `play()` is stubbed — but a real URL that 404s would put a dead
  // player on the row, and vcClipDead APPENDS a notice to the card, which is a childList mutation
  // inside the very box the MutationObserver is watching. Deterministic beats "probably fine".
  await evaluate(
    cdp,
    `(() => {
        window.__played = [];
        HTMLMediaElement.prototype.play = function () {
            window.__played.push(this.dataset.vcaudio || '?');
            return Promise.resolve();
        };

        const WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
        window.__cands = [];
        window.__deleted = [];
        const REAL = window.fetch.bind(window);
        const jres = o => new Response(JSON.stringify(o),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        window.fetch = (input, init) => {
            const u = String(typeof input === 'string' ? input : (input && input.url) || '');
            if (u.includes('/voices/design/candidates')) {
                return Promise.resolve(jres({
                    candidates: window.__cands.map((t, i) => ({
                        token: t, url: WAV, size: 1000, created: 1754500000 - i,
                        duration_s: 1.5, seed: 1000 + i,
                    })),
                    total_bytes: 1000 * window.__cands.length,
                }));
            }
            if (u.includes('/voices/design/delete')) {
                const toks = (JSON.parse((init && init.body) || '{}').tokens) || [];
                window.__deleted.push(...toks);
                window.__cands = window.__cands.filter(t => !toks.includes(t));
                return Promise.resolve(jres({ deleted: toks.length }));
            }
            if (u.includes('/voices/design/save')) {
                return Promise.resolve(jres({ name: 'spec', label: 'Spec voice', peak_dbfs: -3 }));
            }
            return REAL(input, init);
        };

        // "This is what the server has now" — then the REAL loader draws it.
        // EMPTYING THE RECYCLE BIN FIRST IS NOT TIDINESS (7.3-m4e). A delete DEFERS now: the clip
        // stays on the server and the row is hidden by vcLive(). So re-seeding the same tokens
        // after a delete would draw the list MINUS the one just binned, and every check below that
        // names a top row would be off by one against a panel that is behaving correctly.
        // (No backticks in this comment on purpose -- the whole block is a template literal, and
        //  one backtick inside it ends the string. That cost a run.)
        window.__seed = toks => {
            vcUndelete();
            window.__cands = toks.slice();
            return loadCandidates();
        };
        // The button in the live dialog whose face reads <label>.
        window.__dlg = label => [...document.getElementById('mActs').children]
            .find(b => b.textContent === label);
        return true;
    })()`,
  );

  // The in-flight counter wraps the fake `fetch` installed just above, so the fake routes' answers
  // are counted as well as the real ones. Installed before any action whose absence is checked.
  await evaluate(cdp, INSTALL_NET_IDLE);

  // ── 1. OFF: nothing plays, whatever happens ─────────────────────────────
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  ok(
    await evaluate(
      cdp,
      `document.querySelectorAll('#vcCandidates [data-vccard]').length === 3
                            && !!document.querySelector('[data-vcdel="a"]')`,
    ),
    'the REAL loadCandidates + renderCandidates drew the seeded queue',
  );
  await evaluate(
    cdp,
    `(() => { window.__played = [];
        document.querySelector('[data-vcdel="a"]').click(); return true; })()`,
  );
  ok(
    await waitFor(cdp, `!document.querySelector('[data-vccard="a"]')`, 8000),
    'the REAL ✕ Delete ran and the row left the list (deferred into the bin — see ' +
      'vc_undelete_browser_spec.mjs; what matters here is that the row goes at once)',
  );
  await quiet(cdp);
  ok(await evaluate(cdp, `window.__played.length === 0`), 'with Autoplay OFF, deleting the top row plays nothing');

  // ── 2. ticking it plays the top row ─────────────────────────────────────
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(
    cdp,
    `(() => { window.__played = [];
        document.getElementById('vcAutoplay').click(); return true; })()`,
  );
  // The one POSITIVE claim in this file, so it is the one that becomes a wait: something must
  // happen, and waiting for it is both faster and stricter than sleeping past it.
  ok(await waitFor(cdp, `JSON.stringify(window.__played) === '["a"]'`, 5000), 'ticking Autoplay starts the TOP row');

  // ── 3. deleting the top row plays the next one ──────────────────────────
  await evaluate(
    cdp,
    `(() => { window.__played = [];
        document.querySelector('[data-vcdel="a"]').click(); return true; })()`,
  );
  await waitFor(cdp, `JSON.stringify(window.__played) === '["b"]'`, 8000);
  ok(await evaluate(cdp, `JSON.stringify(window.__played) === '["b"]'`), 'deleting the top row plays the next one');

  // ── 4. saving does the same — a saved row leaves exactly like a deleted one ──
  // 🔴 DRIVEN THROUGH THE REAL NAME DIALOG, because that is what a save IS: the click only arms
  // autoplay, and the row does not go until `/voices/design/save` returns and the save path calls
  // `vcDelete` itself. A spec that removed the row by hand would pass with that call deleted.
  await evaluate(
    cdp,
    `(() => { window.__played = [];
        document.querySelector('[data-vcsave="b"]').click(); return true; })()`,
  );
  ok(await waitFor(cdp, `!!document.getElementById('vcNameIn')`, 8000), "pressing ✓ Save asks for the voice name in the app's own modal");
  await evaluate(
    cdp,
    `(() => { document.getElementById('vcNameIn').value = 'Spec voice';
        window.__dlg('Save voice').click(); return true; })()`,
  );
  await waitFor(cdp, `JSON.stringify(window.__played) === '["c"]'`, 8000);
  ok(
    await evaluate(
      cdp,
      `JSON.stringify(window.__played) === '["c"]'
                            && !document.querySelector('[data-vccard="b"]')`,
    ),
    'SAVING the top row plays the next one too (saving deletes the candidate)',
  );
  // Dismiss the "Voice created" dialog so the overlay is not sitting over the checks below.
  await waitFor(cdp, `document.getElementById('mTitle').textContent === 'Voice created'`, 8000);
  await evaluate(cdp, `(() => { window.__dlg('OK').click(); return true; })()`);

  // ── 5. 🔴 a clip that simply ENDS advances nothing ──────────────────────
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(
    cdp,
    `(() => { window.__played = [];
        document.querySelector('[data-vcaudio="a"]').dispatchEvent(new Event('ended'));
        return true; })()`,
  );
  await quiet(cdp);
  ok(await evaluate(cdp, `window.__played.length === 0`), '🔴 a clip reaching its end plays NOTHING — a triage queue, not a jukebox');

  // ── 6. 🔴 a repaint that is not a save/delete advances nothing ──────────
  // ↻ Generate, Show all and the overnight batch all rebuild this list. Without the arming step
  // each of them would start playback unexpectedly.
  await evaluate(
    cdp,
    `(async () => { window.__played = []; await window.__seed(['z','a','b']);
        return true; })()`,
  );
  await quiet(cdp);
  ok(
    await evaluate(
      cdp,
      `window.__played.length === 0
                            && document.querySelector('#vcCandidates [data-vccard]').dataset.vccard === 'z'`,
    ),
    '🔴 a plain repaint (a new candidate landing on top) plays NOTHING',
  );

  // ── 7. 🔴 deleting a NON-top row does not restart what is playing ───────
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(
    cdp,
    `(() => { window.__played = [];
        document.querySelector('[data-vcdel="c"]').click(); return true; })()`,
  );
  await waitFor(cdp, `!document.querySelector('[data-vccard="c"]')`, 8000);
  await quiet(cdp);
  ok(await evaluate(cdp, `window.__played.length === 0`), '🔴 deleting a row that is NOT on top plays nothing — the top clip keeps going');

  // ── 7a. 🔴 …AND THE ARM IS SPENT BY IT. The regression check for the defect above.
  // Not advancing was always right; not CLEARING was the bug. The arm survived, and the next
  // thing to change the top row fired it — which is a new candidate arriving, from ↻ Generate or
  // from the overnight batch landing a round. A clip then starts on its own, minutes after the
  // click that armed it, over whatever he was auditioning at the time.
  await evaluate(
    cdp,
    `(async () => { window.__played = []; await window.__seed(['z','a','b']);
        return true; })()`,
  );
  await quiet(cdp);
  ok(
    await evaluate(cdp, `window.__played.length === 0`),
    '🔴 …and the arm is SPENT by that delete — a candidate landing on top later plays nothing',
  );

  // ── 7b. ✕ Delete selected arms too — it lives OUTSIDE #vcCandidates ─────
  // 🔴 The header's mass-delete carries no data-vcdel, so `arm` cannot see it and autoplay.js
  // gives it a listener of its own. Nothing else in this spec touches that second listener, and
  // without it the header mass-delete would not arm autoplay.
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(
    cdp,
    `(() => { window.__played = [];
        const cb = document.querySelector('[data-vcsel="a"]');
        cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles: true}));
        document.getElementById('vcDelSel').click(); return true; })()`,
  );
  ok(
    await waitFor(cdp, `document.getElementById('mTitle').textContent === 'Delete candidates'`, 8000),
    'the mass-delete confirms first — 87 clips is irreversible at a scale a misclick can reach',
  );
  await evaluate(cdp, `(() => { window.__dlg('Delete').click(); return true; })()`);
  await waitFor(cdp, `JSON.stringify(window.__played) === '["b"]'`, 8000);
  ok(
    await evaluate(cdp, `JSON.stringify(window.__played) === '["b"]'`),
    "✕ Delete selected advances as well, through autoplay.js's second arm",
  );

  // ── 8. unticking stops it advancing ─────────────────────────────────────
  await evaluate(cdp, `window.__seed(['a','b','c'])`);
  await evaluate(
    cdp,
    `(() => {
        document.getElementById('vcAutoplay').click();        // now OFF
        window.__played = [];
        document.querySelector('[data-vcdel="a"]').click(); return true; })()`,
  );
  await waitFor(cdp, `!document.querySelector('[data-vccard="a"]')`, 8000);
  await quiet(cdp);
  ok(await evaluate(cdp, `window.__played.length === 0`), 'unticking Autoplay stops it advancing');

  // ── 9. the tick survives a reload (UIS, so it is server-side) ───────────
  await evaluate(cdp, `(() => { document.getElementById('vcAutoplay').click(); return true; })()`);
  await waitFor(cdp, `document.getElementById('vcAutoplay').checked === true`);

  // 🔴 POLL THE SERVER — NEVER SLEEP A GUESS AT THE DEBOUNCE. This was `sleep(500)`, i.e. 100 ms
  // of margin over `UIS`'s 400 ms debounce plus a POST. Under a loaded 16-worker run that margin
  // is gone: the navigate below beats the write, the reloaded page truthfully reports the OLD
  // value, and the check goes red against a product that is working perfectly. Asking the server
  // what it actually holds is the same wait with no constant in it — and it is a stronger check,
  // because it proves the tick went to the VAULT rather than to this browser's localStorage,
  // which is the entire reason UIS exists (5.0-M8 §4).
  //
  // ⚠️ NOT `waitFor`, WHICH CANNOT DO THIS. It wraps its expression in `!!(…)`, and `!!` of an
  // async IIFE is a truthy Promise the instant it is created — so an async condition handed to
  // `waitFor` passes VACUOUSLY on the first poll, whatever the server says.
  const storedTick = () =>
    evaluate(
      cdp,
      `(async () => { try { const r = await fetch('/ui-state', { cache: 'no-store' });
                              const d = await r.json(); return d['vocalis-vc-autoplay'] || null; }
                        catch (e) { return 'ERR: ' + e; } })()`,
    );
  let landed = false;
  // 300 polls of 100 ms is only the bound on a hang (it was 100); a passing run leaves on the
  // first poll that finds the server holding the tick.
  for (let i = 0; i < 300 && !landed; i++) {
    landed = (await storedTick()) === '1';
    if (!landed) await sleep(100);
  }
  ok(landed, "the tick reaches the SERVER as account UI state — not this browser's localStorage");

  await cdp.send('Page.navigate', { url: baseUrl });
  await waitFor(cdp, `document.readyState === 'complete'`);
  // 🔴 GATE ON `__uiReady`, NOT ON `readyState`. `complete` means the DOCUMENT is parsed - it
  // says nothing about whether the MODULES have run, and the tick is restored by `wireAutoplay()`
  // at the top level of js/voice/autoplay.js. Under a loaded 32-worker run, parsing and executing
  // an 877 KB bundle takes longer than the 8 s budget below, which used to start counting from
  // `complete`: the box is still unrestored when the clock runs out, and the check goes red
  // against a product that is working. Seen 2026-08-18 as "FAIL the Autoplay setting survives a
  // reload", green in isolation.
  //
  // ⚠️ AND THE RESTORE IS NOT A FETCH, WHICH IS WHY THIS IS A FLAG AND NOT A LONGER SLEEP. The
  // server substitutes `{{UI_STATE}}` into the page, so `UIS.getItem` is a parse-time read with no
  // request behind it - "the modules ran" IS the precondition, exactly. `__bootDone` is kept
  // beside it only because a page still filling in is not one to measure; it is strictly later
  // than `__uiReady` and never the thing being waited for here.
  ok(
    await waitFor(cdp, `window.__uiReady === true && window.__bootDone === true`, 30000),
    'the reloaded page has run its modules (which is what restores the tick)',
  );
  ok(await waitFor(cdp, `document.getElementById('vcAutoplay').checked === true`, 8000), 'the Autoplay setting survives a reload');

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

// Vocalis 7.0-m1e — the Character Cards / World Books tab, in a REAL browser.
//
// 🔴 WHY THIS EXISTS ON TOP OF wbedit_ui_smoke.mjs. That file slices helpers out of index.html
// and runs them in a VM; it cannot see a ReferenceError in a click handler, a pane that opens
// behind another one, or a `max-width` a theme overrode. 6.1's record: regex checks AND
// Flask-test-client checks both passed while the player was visibly broken. And 6.3's: a
// class-only assertion passed while ST's theme killed the box-shadow with !important — which is
// why the width check below reads getComputedStyle rather than the stylesheet.
//
// Everything is driven through the actual controls. Nothing calls a render helper directly.
//
// Usage: node wbedit_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { NEXT_FRAME, reportNetworkFailures } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node wbedit_browser_spec.mjs <base-url> <chrome-path>');
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
  const listeners = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else listeners.forEach(fn => fn(m));
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
  return { ws, ready, send, on: fn => listeners.push(fn) };
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

// 🔴 ONE BUDGET FOR EVERY WAIT THAT FAILS, BECAUSE A TIMEOUT CAN DESTROY ITS OWN EVIDENCE.
// pytest.ini caps a single test at 60s (`--timeout=60 --timeout-method=thread`), and a GREEN run
// of this file already takes ~52s of it. So the generous 30s budgets written all over this file
// do not do what their comments claim: when one of them actually elapses, the test does not print
// a red check — pytest kills the whole xdist worker (`[gw0] node down: Not properly terminated`),
// `subprocess.run` never returns, and NOTHING the spec printed reaches the log. Measured, twice,
// while proving the two repaired checks below can fail.
//
// The per-test ceiling is raised to 100s in test_wbedit_browser.py; this is the other half. Every
// wait in this file draws its timeout from ONE shared allowance, and only a wait that FAILS spends
// any of it. A correct run costs nothing. A broken one is bounded: the first stall gets its full
// budget and reports properly, later stalls return fast, and the spec always gets to the end and
// prints all 271 lines.
// 🔴 BIG ENOUGH THAT ONE LEGITIMATE TIMEOUT CANNOT ZERO IT. At 30000 this was smaller than the
// waits drawing on it: a single 20 s wait that expires leaves 10 s, the next one spends that,
// and every check after it fails in ~1 ms "waiting for" something it never actually waited for.
// Failed waits consume the shared allowance; later checks still run and report independently.
let waitBudgetMs = 90000;

// 🔴 A DEADLINE IS A BOUND ON A HANG, NOT A PREDICTION OF HOW LONG THE PAGE TAKES (2026-10-12).
// The 5 s, 8 s and 10 s deadlines written at the call sites were measured on an idle box, and with
// eight copies of this spec running at once the persona editor took longer than 10 s to draw and
// the imported card longer than 10 s to come back: the waits gave up on a page that was merely
// slow. A passing wait returns the moment its condition holds, so a longer bound costs nothing
// when it is not needed; MIN_WAIT_MS is the floor every call site's bound is raised to. Only a wait
// that FAILS spends any of the shared allowance below, so the cost of a longer bound is paid by
// failing runs alone.
const MIN_WAIT_MS = 20000;

async function waitFor(cdp, expression, timeoutMs = 30000) {
  let lastThrow = null;
  const allowed = Math.min(Math.max(timeoutMs, MIN_WAIT_MS), Math.max(0, waitBudgetMs));
  const t0 = Date.now();
  for (;;) {
    // 🔴 `Promise.resolve(...)` IS THE WHOLE FIX. This was `!!(${expression})`, and when the
    // expression is a promise — every `fetch(...).then(...)` poll in these specs — `!!aPromise`
    // is `true` SYNCHRONOUSLY AND ALWAYS, whatever it resolves to. `evaluate` then awaited a
    // bare `true`. So the wait returned on its first poll every time and waited for nothing.
    //
    // ⚠️ IT FAILS AS A PASS, WHICH IS WHY IT SURVIVED. A broken wait does not hang, it races —
    // green whenever the machine is quick and red under a loaded suite, which reads exactly
    // like an environment flake. A poll that throws is "not yet", not "failed". `evaluate`
    // turns a page exception
    // into a thrown Error, so an unguarded wait whose expression touches a node is a race:
    // the first poll landing mid-repaint kills the spec, and it presents as a flake because
    // the window is narrow. A typo in an expression still throws on every poll and would
    // otherwise just time out saying nothing about why.
    try {
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`)) return true;
      lastThrow = null;
    } catch (err) {
      lastThrow = err && err.message ? err.message : String(err);
    }
    if (Date.now() - t0 > allowed) {
      waitBudgetMs -= Date.now() - t0;
      if (lastThrow) console.log(`  (wait gave up; last page exception: ${lastThrow})`);
      return false;
    }
    await sleep(100);
  }
}

// 🔴 A SETTLE, NOT A SLEEP. Where the thing to wait for is "the list stopped rearranging" there is
// no single predicate to poll: the roster is already non-empty and already rendered, and what the
// next assertion needs is that it has stopped MOVING. So poll the value and stop when two
// consecutive reads agree. `sleep(300)` was a guess that the repaint had finished by then, which is
// true on an idle box and false on a loaded one — the exact shape that makes a suite flaky at -n 16.
// ⚠️ 2026-10-12: NO CALLER LEFT. Its three uses (the Library sort changes) now wait for the roster's
// own repaint, which is a real signal; two reads agreeing was still a guess that a slow fetch had
// finished. Kept, unused, for a future "has stopped moving" check that has no event to wait on.
async function settled(cdp, expression, quietMs = 120, timeoutMs = 8000) {
  const t0 = Date.now();
  let last = Symbol('nothing read yet');
  for (;;) {
    const now = await evaluate(cdp, expression);
    if (now === last) return true;
    last = now;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(quietMs);
  }
}

// 🔴 NEVER `await waitFor(...)` AND THROW THE RESULT AWAY. `waitFor` RETURNS false ON TIMEOUT —
// it does not raise — so a dropped result is a silent thirty-second stall: the page never
// reaches the state the block depends on, the wait gives up, and the NEXT check goes red for a
// reason that names none of this. Sixteen sites in this file did exactly that, and they are the
// single biggest source of confusing red in the suite.
//
// `mustWait` is `waitFor` that reports itself. It prints a check line either way, so a timeout
// is red AT THE POINT IT HAPPENS and the line names what was being waited for — and because it
// prints on success too, the wait is on the anti-deletion roster in test_wbedit_browser.py like
// every other check. `what` must stay a stable PREFIX of the printed line; the timeout detail is
// appended after it.
async function mustWait(cdp, expression, what, timeoutMs = 30000) {
  const t0 = Date.now();
  const got = await waitFor(cdp, expression, timeoutMs);
  if (got) {
    ok(true, what);
    return true;
  }
  ok(false, what + ' — TIMED OUT after ' + (Date.now() - t0) + 'ms, waiting for: ' + expression.replace(/\s+/g, ' ').trim());
  return false;
}

// 🔴 "IT WROTE NOTHING" IS A CLAIM ABOUT REQUESTS, SO THE REQUESTS ARE RECORDED (2026-10-12). The
// checks that say a gesture stores nothing or does nothing (the face picker's release and Cancel,
// the Revert dialog's Cancel) used to sleep for a while and then read the server, hoping any write
// that was going to happen had landed by then. This wrapper notes every non-GET `fetch` at the
// moment it is MADE, with its answer promise, so a check can take the writes a gesture caused, wait
// for exactly those to answer, and read the server once. The fetch log in _specwait.mjs notes a
// request when its RESPONSE arrives, which is too late to say "none was made". Idempotent, and it
// survives until the document does (nothing here navigates after the first load).
// ⚠️ NO BACKTICKS INSIDE: this is a template literal.
const INSTALL_WRITE_LOG = `(() => {
    if (window.__wbWrites) return true;
    const real = window.fetch;
    window.__wbWrites = [];
    window.fetch = function (...a) {
        const req = a[0], init = a[1] || {};
        const method = String(init.method || (req && req.method) || 'GET').toUpperCase();
        const p = real.apply(this, a);
        if (method !== 'GET' && method !== 'HEAD')
            window.__wbWrites.push({url: String(req && req.url ? req.url : req), method, p: p.catch(() => null)});
        return p;
    };
    return true;
})()`;

// 🔴 IS THE PAGE STILL SCROLLING? A smooth scroll (wbScrollToRow) is started by the TAIL of wbOpen,
// two frames after the open has otherwise finished, so "the editor is shown" does not mean "the
// page has stopped moving". SCROLL_TRACKER keeps one flag from the browser's own events (a scroll
// event sets it, scrollend clears it) and SCROLL_AT_REST waits for it to be clear after giving
// the product's two-frame start (plus two more for the first scroll event) time to happen.
// Bounded at 15 s; resolves false on a hang rather than throwing. ⚠️ NO BACKTICKS INSIDE.
const SCROLL_TRACKER = `(() => {
    if (window.__scr) return true;
    window.__scr = {moving: false};
    window.addEventListener('scroll', () => { window.__scr.moving = true; });
    window.addEventListener('scrollend', () => { window.__scr.moving = false; });
    return true;
})()`;
const SCROLL_AT_REST = `(async () => {
    await ${NEXT_FRAME};
    await ${NEXT_FRAME};
    for (let i = 0; i < 300; i++) {
        if (!window.__scr.moving) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
})()`;

const profile = await mkdtemp(join(tmpdir(), 'vocalis-wbedit-cdp-'));
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
    '--window-size=1900,1000',
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
  // and swallowing the removal error leaves the temporary profile behind. Retry briefly because
  // the process exit event can precede Windows releasing its file handles.
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

const port = await devtoolsPort();
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const cdp = connect(page.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

// 🔴 A PAGE ERROR IS A FAILURE, NOT NOISE. A ReferenceError in a click handler leaves a button
// looking dead while every regex check in wbedit_ui_smoke.mjs still passes — which is exactly
// how `toast()` (a function this app does not have) would have shipped.
const pageErrors = [];
cdp.on(m => {
  if (m.method === 'Runtime.exceptionThrown')
    pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});

// Why a request failed, in Chrome's own words, printed if the spec ends red: see
// reportNetworkFailures in _specwait.mjs for what it found on 2026-10-12.
await reportNetworkFailures(cdp.send, cdp.on);

await cdp.send('Page.navigate', { url: baseUrl });
// 🔴 THE GATE NAMES A MODULE EXPORT, NOT JUST INLINE CODE (7.1-m6). `wbLoadLib` is defined by the
// inline script, so it exists the instant that script parses and says NOTHING about whether the
// module tree loaded and the `Object.assign(window, …)` shim ran. That is the one new way this
// page can be broken: a module that 404s, or whose own import fails, leaves every name the shim
// publishes `undefined` while `readyState` still reaches 'complete' — and the symptom is some
// unrelated check twenty assertions later failing on a TypeError that names none of it.
//
// `wbState` (state.js) and `wbStream` (pass.js) are the first and the newest module exports, so
// requiring both here means a broken module tree fails LOUDLY, at the top, with this sentence.
// ⚠️ Add the newest module's export to this list as each one lands — a gate that only ever checks
// the first two modules stops covering the tree it is there to cover.
await mustWait(
  cdp,
  `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`,
  'the page loads, the editor JS is on it, and the module tree published its exports',
);

// 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
// `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
// page's GLOBAL scope — so every name this spec drives would be a ReferenceError. The HARNESS
// publishes what the harness needs; _websrc.mjs has the list and the argument.
// ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
await evaluate(cdp, PUBLISH_SPEC_SURFACE);
await evaluate(cdp, SCROLL_TRACKER);
// 🔴 THE SAVE-AS PICKER IS DISARMED FOR THE WHOLE RUN, AND EVERY EXPORT CHECK BELOW LEANS ON IT.
// 11.1.8 made `wbDownload` offer `window.showSaveFilePicker` before falling back to the
// `<a download>` it has always used — and `evaluate` sends `userGesture: true`, so a click driven
// from here arrives WITH activation and reaches the picker for real. In headless Chrome that means
// a native dialog nothing in this file can answer: the promise never settles, so the run HANGS
// rather than failing, which is the worst shape a test can take (and it would present as a flake).
// Assigning `undefined` on the window instance shadows the `Window.prototype` method, which is
// what `typeof pick !== 'function'` in `dl.js` reads, so the anchor path is back for the blocks
// that were written against it.
// ⚠️ The picker path is NOT left untested by this — it has its own block below, which installs a
// stub, drives the button and puts this line's `undefined` back in a `finally`.
await evaluate(cdp, `window.showSaveFilePicker = undefined; true`);
// ── the shell width, MEASURED (§6.0.1) ───────────────────────────────────────
// 🔴 getComputedStyle, never the class or the stylesheet text.
{
  const w = await evaluate(cdp, `getComputedStyle(document.querySelector('main')).maxWidth`);
  ok(w === '1800px', `the shell computes to 1800px, not 1080 (${w})`);
  const f = await evaluate(cdp, `getComputedStyle(document.querySelector('footer')).maxWidth`);
  ok(f === '1800px', `and so does the footer — the second hand-written 1080 (${f})`);
}

// ── the sub-tab strip, and opening a pane through a real click ───────────────
await evaluate(cdp, `switchTab('sillytavern')`);
{
  const labels = await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].map(b => b.textContent.trim())`);
  ok(
    // 10.19 added Vocalis Extension Settings (Polish Text and Send's server-owned settings).
    labels.join(' · ') === 'Logs · Character Voices · Character Cards · World Books · Personas · Scene Clips · Vocalis Extension Settings',
    `the strip reads: ${labels.join(' · ')}`,
  );

  // 🔴 THE RESTORE ALLOW-LIST HAS TO COVER EVERY TAB ON THE STRIP, OR REFRESH LOSES HIS PLACE.
  // `ST_TABS` was hand-written as ['logs','characters','clips'] and never grew when 7.0 added
  // three more panes. `switchStTab` faithfully SAVED 'cards'; this list then rejected it as
  // unknown on the next load and silently fell back to Logs. Unknown values fail silently, so the
  // persisted-tab allow-list must stay aligned with the visible strip.
  const strip = await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].map(b => b.dataset.sttab).join(',')`);
  const known = await evaluate(cdp, `ST_TABS.join(',')`);
  ok(known === strip, `every sub-tab on the strip can be restored after a reload (${known} vs ${strip})`);
}

// The round trip itself, without reloading the page (which would reset every later block): what
// switchStTab persists must be what the restore would accept.
{
  await evaluate(cdp, `switchStTab('cards')`);
  await waitFor(cdp, `UIS.getItem('vocalis-sttab') === 'cards'`, 5000);
  const saved = await evaluate(cdp, `UIS.getItem('vocalis-sttab')`);
  ok(saved === 'cards', `opening Character Cards records it as the tab to come back to (${saved})`);
  ok(
    await evaluate(cdp, `ST_TABS.includes(UIS.getItem('vocalis-sttab'))`),
    'and a reload would accept that value rather than falling back to Logs',
  );
}
await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].find(b => b.dataset.sttab === 'books').click()`);
await waitFor(cdp, `document.querySelector('[data-stpanel="books"]').style.display !== 'none'`, 8000);
ok(await evaluate(cdp, `document.querySelector('[data-stpanel="books"]').style.display !== 'none'`), 'clicking World Books opens its pane');
ok(await evaluate(cdp, `document.querySelector('[data-stpanel="clips"]').style.display === 'none'`), '…and closes the one that was open');

// ── §8.3 the third kind ──────────────────────────────────────────────────────
//
// 🔴 The sub-tab key is not the document kind, and personas is the member where they differ by a
// single 's' — `personas` vs `persona`. That is the one this pane would get wrong, and getting it
// wrong renders "nothing imported yet" over a full library while every route test passes. So the
// check is that the pane asks the ROUTE the right question, not merely that the button exists.
{
  await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].find(b => b.dataset.sttab === 'personas').click()`);
  await waitFor(cdp, `document.querySelector('[data-stpanel="personas"]').style.display !== 'none'`, 8000);
  ok(
    await evaluate(cdp, `document.querySelector('[data-stpanel="personas"]').style.display !== 'none'`),
    'clicking Personas opens its pane',
  );
  ok(await evaluate(cdp, `WB_KIND.personas === 'persona'`), 'and the pane maps its tab key to the document kind the store records');

  // 🔴 9.5.12 — THE FILE IMPORT IS HERE NOW, AND THIS ASSERTION USED TO SAY THE OPPOSITE. "A
  // persona is not a file" is true of SILLYTAVERN — two maps in `power_user`, nothing in the PNG,
  // a backup JSON that skips every key that already exists — and it was read as a fact about
  // Vocalis, where a persona has been a document with a spec marker since §8.3 and ⬇ Export has
  // been handing one out ever since. Keep the file picker available for exported JSON and authored
  // Markdown personas.
  ok(await evaluate(cdp, `!!document.getElementById('wbImportBtn_personas')`), 'Personas has ⬆ Import file… — 9.5.12');
  ok(
    await evaluate(cdp, `document.getElementById('wbFile_personas').accept.includes('.md')`),
    '…and it takes prose as well as .json, because that is the shape a written-for-you persona arrives in',
  );
  ok(
    await evaluate(cdp, `!document.getElementById('wbFile_personas').accept.includes('.png')`),
    '…but not a PNG: a persona avatar holds only the picture, so it is not a way in on its own',
  );
  ok(await evaluate(cdp, `!document.getElementById('wbAssembleBtn_personas')`), 'and no Assemble — a persona has no sections');
  ok(await evaluate(cdp, `!!document.getElementById('wbStSweep_personas')`), 'the sweep IS there — §8.2a, we pull it from Vocalis');

  // 🔴 The empty state must not name a button that is not on the pane, nor send him looking for
  // a file that cannot exist. This is the line that goes stale if the controls above change.
  //
  // ⚠️ WAIT FOR THE FETCH. The pane renders "Loading…" first and only then the empty state, so
  // reading it straight after the click is a race that passes alone and fails under a loaded
  // 16-worker suite — which is exactly how it first showed up.
  await mustWait(
    cdp,
    `!/Loading/.test(document.getElementById('wbLib_personas').textContent)`,
    'the Personas library finishes its first fetch',
    10000,
  );
  const empty = await evaluate(cdp, `document.getElementById('wbLib_personas').textContent`);
  ok(
    /Import from SillyTavern/.test(empty) && /⬆ Import file/.test(empty),
    `the empty state names the sweep AND the file picker (${JSON.stringify(empty.slice(0, 90))})`,
  );

  // ── §9a.11 / 7.5.15 — ✚ New Persona, and it is the PNG half of the ask too ────────────────
  //
  // 🔴 THE CHECK THAT MATTERS IS THAT THE RESULT CAN BE TYPED INTO. `persona.jobs` skipped blank
  // and missing fields identically until this milestone, so a persona minted from nothing
  // collected ZERO jobs and the editor would have opened on "no editable fields" — a create
  // button whose document is inert. The route tests can assert the field LIST; only a browser
  // can say the editor really drew boxes for them and that typing into one saves.
  ok(await evaluate(cdp, `!!document.getElementById('wbNewPersona_personas')`), '✚ New Persona is on the pane — §9a.11');
  ok(/New Persona/.test(empty), 'and the empty state names it as the third way in');

  // `wbAskName` is a modal, so the fixture name is entered through the visible field.
  await evaluate(cdp, `document.getElementById('wbNewPersona_personas').click()`);
  await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`, 8000);
  await evaluate(
    cdp,
    `(() => {
        const i = document.querySelector('#mBody input[type=text]');
        i.value = 'Test User';
        [...document.querySelectorAll('#mActs button')].find(b => /OK/.test(b.textContent)).click();
        return true; })()`,
  );
  ok(await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`, 8000), 'naming it closes the dialog');
  ok(
    await waitFor(cdp, `/Test User/.test(document.getElementById('wbLib_personas').textContent)`, 10000),
    'the created persona lands in the Library',
  );

  // 🔴 IT OPENS, AND IT OPENS ON TWO EMPTY BOXES. Both, because `title` is the one SillyTavern
  // DELETES rather than blanks — so before `persona_empty` a new persona had no editable fields
  // and could only be populated by editing its SillyTavern source first.
  const fields = await waitFor(cdp, `document.querySelectorAll('#wbFields_personas textarea').length === 2`, 10000);
  const drew = await evaluate(
    cdp,
    `(() => {
        const t = [...document.querySelectorAll('#wbFields_personas textarea')];
        const labels = [...document.querySelectorAll('#wbFields_personas .wbfield')]
            .map(f => (f.textContent.match(/description|title/) || [''])[0]).filter(Boolean);
        return { n: t.length, blank: t.every(x => x.value === ''), labels: labels.join(',') };
    })()`,
  );
  ok(fields && drew.n === 2 && drew.blank, `the editor opens on two EMPTY boxes to type into (${JSON.stringify(drew)})`);
  ok(
    /description/.test(drew.labels) && /title/.test(drew.labels),
    '…and they are description and title — the title row is the older gap this closes',
  );

  // The round trip: type, save, and the revision really carries it.
  const saved = await evaluate(
    cdp,
    `(async () => {
        const t = document.querySelector('#wbFields_personas textarea');
        t.value = 'Reads code fluently and wants the conclusion first.';
        t.dispatchEvent(new Event('input', {bubbles: true}));
        await wbSaveEdits('personas');
        const id = wbState('personas').doc.id;
        const d = await (await fetch('/wbedit/documents/' + id)).json();
        const n = d.revisions[d.revisions.length - 1];
        const r = await (await fetch('/wbedit/documents/' + id + '/revision/' + n)).json();
        return { n, description: r.content.description, spec: r.content.spec,
                 st_ref: d.st_ref, avatar: 'avatar' in r.content };
    })()`,
  );
  ok(saved.n === 1 && /Reads code fluently/.test(saved.description || ''), `typing into an empty field saves as revision ${saved.n}`);
  ok(saved.spec === 'vocalis_persona_v1', 'and the stored document is still a persona by its spec marker');
  // 🔴 NO INVENTED AVATAR FILENAME. It is the identity AND the st_ref; guessing an existing
  // filename could make a send edit another persona's descriptor.
  ok(saved.st_ref === '' && !saved.avatar, 'and it has no invented avatar filename to collide with a real persona');

  // ── 9.5.12 — ⬆ Upload PNG IS ON SCREEN FOR A PERSONA WITH NO PICTURE ──────────────────────
  //
  // 🔴 THE BUG THIS REPLACES WAS INVISIBLE TO EVERY OTHER LAYER. The button has existed since
  // §8.3 and the route has always accepted a first picture (`test_wbedit_persona_import.py`
  // proves the server half). It lived inside `#wbCardWrap_personas`, and `wbShowCard` hid that
  // wrap whenever `doc.avatar` was false — so on the one document that needed it, the control
  // was in the DOM but hidden when the persona had no image, leaving no visible way to add one.
  //
  // ⚠️ `offsetParent` IS THE ASSERTION, NOT `getElementById`. The old state passes an existence
  // check — that is exactly how this survived — and it passes a `display` check on the button
  // itself, whose own style was never touched. Only "is it laid out" can tell them apart.
  const pic = await evaluate(
    cdp,
    `(() => {
        const up = document.getElementById('wbPicUpload_personas');
        const img = document.getElementById('wbCard_personas');
        const focus = document.getElementById('wbPicFocus_personas');
        return {
          avatar: !!wbState('personas').doc.avatar,
          upload: !!(up && up.offsetParent),
          note: (document.getElementById('wbCardNote_personas') || {}).textContent || '',
          imgShown: !!(img && img.offsetParent),
          imgSrc: !!(img && img.getAttribute('src')),
          focus: !!(focus && focus.offsetParent),
        };
    })()`,
  );
  ok(!pic.avatar && pic.upload, 'a persona with no picture still offers ⬆ Upload PNG — the whole point of 9.5.12');
  ok(/Upload PNG/.test(pic.note), `…and the empty slot says what to do with it (${JSON.stringify(pic.note)})`);
  ok(!pic.imgShown && !pic.imgSrc, '…with no <img> in the flow, so an empty slot is not a broken-image glyph');
  // ◎ Set face would arm a drag over an image that is not there and store a rect describing
  // nothing. Hidden rather than disabled: a disabled button swallows the press and reads as broken.
  ok(!pic.focus, '…and ◎ Set face stays away until there is a picture to drag a square over');

  // ── 9.5.12 — AND THE BUTTON ACTUALLY WORKS, PRESSED THE WAY HE WOULD PRESS IT ─────────────
  //
  // 🔴 A REAL `change` ON A REAL <input type=file>, VIA DataTransfer. Every other layer of this
  // fix is asserted one step away from him: the route accepts a first picture, the control is on
  // screen, the URL carries a stamp. The upload HANDLER — read the file, POST the raw bytes,
  // reopen, repaint — is exercised by none of them, and it is the piece his question was about.
  //
  // ⚠️ THE BYTES GO UP RAW (§4.3). Not a canvas re-encode and not base64 in a JSON field: an
  // animated PNG has to stay animated and a ComfyUI chunk has to survive. A 5×5 fixture is enough
  // to prove which picture is on screen, because `naturalWidth` names it.
  const gaveFace = await evaluate(
    cdp,
    `(async () => {
        const bin = Uint8Array.from(atob('${'iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAIAAAACDbGyAAAAEUlEQVR4nGM48P8dMmKgkA8AcDBC5gLzfDoAAAAASUVORK5CYII='}'), c => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bin], 'me.png', {type: 'image/png'}));
        const input = document.getElementById('wbPicFile_personas');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        // 🔴 WAIT FOR EVERYTHING THE CHECKS BELOW READ, NOT JUST THE PICTURE'S WIDTH. The picture
        // decoding at 5 px wide comes before the pane has shown it, recorded the avatar on the
        // document and drawn ◎ Set face, so stopping at the width could read those a moment too
        // early. Bound raised from 15 s to 30 s: it is a bound on a hang, and an upload, a reopen
        // and a decode on a loaded box took longer than 15 s (2026-10-12).
        for (let i = 0; i < 120; i++) {
            const im = document.getElementById('wbCard_personas');
            if (im && im.getAttribute('src')) {
                try { await im.decode(); } catch (e) {}
                const focus = document.getElementById('wbPicFocus_personas');
                if (im.naturalWidth === 5 && im.offsetParent && wbState('personas').doc.avatar && focus && focus.offsetParent) break;
            }
            await new Promise(r => setTimeout(r, 250));
        }
        const im = document.getElementById('wbCard_personas');
        const focus = document.getElementById('wbPicFocus_personas');
        return {w: im.naturalWidth, shown: !!im.offsetParent,
                avatar: !!wbState('personas').doc.avatar,
                stamped: (im.getAttribute('src') || '').includes('?v='),
                focus: !!(focus && focus.offsetParent),
                note: (document.getElementById('wbCardNote_personas') || {}).textContent || ''};
    })()`,
  );
  ok(gaveFace.w === 5 && gaveFace.shown, `⬆ Upload PNG gives a pictureless persona a face (${JSON.stringify(gaveFace)})`);
  ok(gaveFace.avatar && gaveFace.stamped, '…the reopened document reports a picture, and its URL carries the stamp');
  ok(gaveFace.focus && !/No picture yet/.test(gaveFace.note), '…and ◎ Set face arrives with it, the empty-slot note gone');

  // ── 9.5.12 — ⬆ Import file…, DRIVEN, WITH THE SHAPE OF FILE HE WAS HANDED ─────────────────
  //
  // 🔴 THE SEAM IS WHICH DOOR THE PANE KNOCKS ON. `wbImport` picks its URL from `wbDocKind(kind)`,
  // and the shared `/wbedit/documents` cannot take this file at all — it would answer "not a
  // character card or worldbook", a sentence about the wrong two kinds, because §4.2 detects a
  // persona by our own spec marker and a file written elsewhere carries none. A route test proves
  // the new door works and a markup test proves the button exists; neither can see the pane
  // posting to the wrong one.
  //
  // ⚠️ NO BACKSLASH ESCAPES IN A CDP SNIPPET. It is a template literal on its way through node, so
  // an escape is eaten before Chrome ever sees it — the newlines are built with a join.
  const importedPersona = await evaluate(
    cdp,
    `(async () => {
        const md = ['# Test Persona 1 — User Persona', '', 'Human, thirty. Dark hair, dark eyes.'].join(String.fromCharCode(10));
        const dt = new DataTransfer();
        dt.items.add(new File([md], 'Test-Persona-1.md', {type: 'text/markdown'}));
        const input = document.getElementById('wbFile_personas');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        // 🔴 WAIT FOR THE LAST THING THE IMPORT DOES, NOT THE FIRST. wbImport reloads the roster
        // (the name appears in it), THEN opens the new document, THEN writes the trimming message.
        // This loop used to stop at the roster, and under load the next lines read st.doc while it
        // still held the PREVIOUS persona ("Test User", opened by the New Persona block): the id was
        // that one's, its revision 0 has no "Dark hair", and the stored-as-persona check failed for
        // a document nobody had imported. So: the roster has it, the open editor IS that document,
        // and the message is up. Bounded at 15 s; on a hang the checks print what was there.
        const said = () => ((document.getElementById('wbMsgEd_personas') || {}).textContent || '') +
                           ((document.getElementById('wbMsg_personas') || {}).textContent || '');
        for (let i = 0; i < 150; i++) {
            const open = wbState('personas').doc;
            if (/Test Persona 1/.test(document.getElementById('wbLib_personas').textContent)
                && open && open.name === 'Test Persona 1' && /trim/.test(said())) break;
            await new Promise(r => setTimeout(r, 100));
        }
        const st = wbState('personas');
        const id = st.doc ? st.doc.id : '';
        const rev = id ? await (await fetch('/wbedit/documents/' + id + '/revision/0')).json() : {};
        return {lib: /Test Persona 1/.test(document.getElementById('wbLib_personas').textContent),
                name: st.doc ? st.doc.name : '',
                // The editor is open by the time the toast lands, and wbSay mirrors it into
                // the editor's own strip (wbMsgEd_*, minted on demand) while the library copy
                // is left empty, so only one is on screen. Read both, or read the wrong one.
                // NO BACKTICKS IN HERE: this is a template literal, and one ends it.
                msg: ((document.getElementById('wbMsgEd_personas') || {}).textContent || '') +
                     ((document.getElementById('wbMsg_personas') || {}).textContent || ''),
                spec: (rev.content || {}).spec || '',
                kept: /Dark hair/.test(((rev.content || {}).description) || '')};
    })()`,
  );
  // `# Test Persona 1 — User Persona` is a DOCUMENT title; the persona is called Test Persona 1.
  ok(
    importedPersona.lib && importedPersona.name === 'Test Persona 1',
    `⬆ Import file… takes a .md persona and names it from the heading (${JSON.stringify(importedPersona.name)})`,
  );
  ok(
    importedPersona.spec === 'vocalis_persona_v1' && importedPersona.kept,
    '…stored as a persona document, with the whole file kept as the description',
  );
  ok(/trim/.test(importedPersona.msg), `…and the message says the trimming is his (${JSON.stringify(importedPersona.msg.slice(0, 80))})`);

  // §6.4.1 — one prompt card for the whole tab, and a persona description is editable by a pass,
  // so it belongs on this pane too.
  ok(
    await evaluate(cdp, `document.getElementById('wbPromptCard').style.display !== 'none'`),
    'the prompt card is shown on Personas — its description is passable prose',
  );

  // 🔴 THE CARD IS DRIVEN, NOT JUST LOOKED AT (7.1-m9). Until this landed, the only assertion
  // about the prompt card in a real browser was the `display` check above — so the whole card
  // could have been moved into a module, failed to load, and left every one of its controls dead
  // with the suite green. `wbLoadPrompt` is one call that exercises most of the module:
  // `jget` → `wbShowPrompt` → `wbShotsText` for the pairs, then `wbLoadPromptRevs` → `wbWhen`
  // for the picker. If `prompt.js` or `fmt.js` failed to resolve, every one of these is empty.
  const card = await evaluate(
    cdp,
    `(async () => {
        await wbLoadPrompt();
        const sel = document.getElementById('wbPromptRev');
        return {sys: document.getElementById('wbPromptSys').value.length,
                state: document.getElementById('wbPromptState').textContent,
                opts: sel.options.length,
                dirty: wbPromptDirty(),
                pairs: wbShotsText([{user:'u', assistant:'a'}])};
    })()`,
  );
  ok(card.sys > 0, `the prompt card loads its system prompt from the server (${card.sys} chars)`);
  // The state line is built from the fingerprint the route returns — an empty one means
  // `wbShowPrompt` ran against nothing rather than that the prompt is unset.
  ok(/few-shot pair/.test(card.state), `and reports its few-shot pairs and fingerprint (${card.state.slice(0, 60)})`);
  ok(card.opts >= 1, `the revision picker is populated rather than a dead box (${card.opts} options)`);
  // 🔴 FRESHLY LOADED MEANS NOT DIRTY. `wbPromptDirty` compares against `wbPromptLoaded`, which is
  // now module-private — if the move had broken that snapshot this reads `true` straight after a
  // load, and every revision-minting button would start warning about unsaved edits that are not
  // there. Nothing else in the suite would notice.
  ok(card.dirty === false, `a just-loaded card is not dirty — the private snapshot survived the move`);
  ok(card.pairs === 'u\n\na', `wbShotsText still renders a pair as user/blank/assistant (${JSON.stringify(card.pairs)})`);

  // Back to Books: everything below drives that pane.
  await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].find(b => b.dataset.sttab === 'books').click()`);
  await waitFor(cdp, `document.querySelector('[data-stpanel="books"]').style.display !== 'none'`, 5000);
}

// ── import, then drive the editor ────────────────────────────────────────────
const BOOK = {
  name: 'Sample World Book 1',
  entries: {
    0: {
      uid: 0,
      key: ['ledger'],
      comment: 'Sample Entry 1',
      constant: false,
      order: 100,
      disable: false,
      content: 'Test Character 1 keeps the ledger of every debt in the lower district.',
    },
    1: {
      uid: 1,
      key: ['weather'],
      comment: 'Weather',
      constant: false,
      order: 100,
      disable: false,
      content: 'The rains come off the estuary in the ninth month.',
    },
    2: {
      uid: 2,
      key: ['wards'],
      comment: 'X-the upper wards',
      constant: true,
      order: 50,
      disable: false,
      content: 'Test Character 1 never goes above the upper level.',
    },
  },
};
const docId = await evaluate(
  cdp,
  `(async () => {
    const r = await fetch('/wbedit/documents', {method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({document: ${JSON.stringify(BOOK)}})});
    return (await r.json()).id;
})()`,
);
ok(!!docId, 'a worldbook imports');

await evaluate(cdp, `wbLoadLib('books')`);
await mustWait(cdp, `document.querySelector('#wbLib_books .wbopen')`, 'the World Books roster paints a row to open');
ok(
  await evaluate(cdp, `document.querySelector('#wbLib_books').textContent.includes('Sample World Book 1')`),
  'it appears in the Library by name',
);
await mustWait(cdp, `document.querySelector('#wbWarmBooks .wbwarmbook')`, 'the latest World Book is pre-rendered in the background');
ok(await evaluate(cdp, `document.getElementById('wbWarmBooks').hidden`), 'the pre-rendered book stays hidden until its row is opened');

await evaluate(cdp, `document.querySelector('#wbLib_books .wbopen').click()`);
ok(
  await waitFor(cdp, `document.querySelectorAll('#wbFields_books .wbfield').length === 3`),
  'clicking Open renders every field on one scrollable page (§6.1.2)',
);

// 🔴 I9 — an X entry remains editable. Dimming is a visual cue, not an edit restriction.
{
  const xs = await evaluate(
    cdp,
    `(() => {
        const f = [...document.querySelectorAll('#wbFields_books .wbfield')]
            .find(d => d.textContent.includes('X-the upper wards'));
        if (!f) return {present: false};
        return {present: true, ticked: f.querySelector('.wbtick').checked,
                editable: !f.querySelector('.wbtext').disabled,
                text: f.querySelector('.wbtext').value};
    })()`,
  );
  ok(
    xs.present && xs.ticked && xs.editable && /Test Character 1/.test(xs.text || ''),
    'an X entry is present, ticked, editable and shows its text (I9)',
  );
}

// ── the preflight (§6.2) ─────────────────────────────────────────────────────
{
  // 🔴 WAIT FOR THE PREFLIGHT LINE, THEN READ IT. The fields are painted before wbOpen reaches its
  // last step (wbPreflight), so the wait above for three fields is not a wait for this line, and
  // under load this read returned '' ("the preflight counts the ticked fields ()", 2026-10-12).
  // No ok() on the wait: a hang leaves the text empty and the check below prints it.
  await waitFor(cdp, `/3 of 3 fields selected/.test(document.querySelector('#wbPreflight_books').textContent)`, 15000);
  const before = await evaluate(cdp, `document.querySelector('#wbPreflight_books').textContent`);
  ok(/3 of 3 fields selected/.test(before), `the preflight counts the ticked fields (${before})`);
  await evaluate(cdp, `document.querySelector('#wbNone_books').click()`);
  const after = await evaluate(cdp, `document.querySelector('#wbPreflight_books').textContent`);
  ok(/no fields selected/.test(after), 'and updates when you untick them');
  await evaluate(cdp, `document.querySelector('#wbAll_books').click()`);
}

// ── m4x: toggle all, and collapse unticked ───────────────────────────────────
//
// Toggle-all inverts the current selection, allowing a user to isolate entries for editing and
// collapse the rest without changing the selection contract.
{
  // 🔴 INVERT, NOT SET-ALL. Untick exactly one, flip, and that one must be the ONLY one ticked —
  // which is the operation neither "tick all" nor "tick none" can express.
  const inv = await evaluate(
    cdp,
    `(async () => {
        const ticks = [...document.querySelectorAll('#wbFields_books .wbtick')];
        ticks.forEach(c => { c.checked = true; });
        ticks[1].checked = false;
        // No pause after the click: wbInvertTicks (edit.js) flips the boxes, repaints the fold and
        // rewrites the preflight line inside the click handler, so everything is settled when
        // click() returns. This was a 150 ms sleep, waiting for nothing.
        document.querySelector('#wbInvert_books').click();
        return {state: ticks.map(c => c.checked),
                pre: document.querySelector('#wbPreflight_books').textContent};
    })()`,
  );
  ok(
    inv.state.length === 3 && inv.state[0] === false && inv.state[1] === true && inv.state[2] === false,
    'toggle all INVERTS every tick, so the one unticked field becomes the only ticked one',
  );
  // 📌 A selection change that does not re-run the preflight leaves a stale count in front of a
  // ~35-minute decision.
  ok(/1 of 3 fields selected/.test(inv.pre), `and the preflight follows it rather than describing the previous selection (${inv.pre})`);

  const fold = await evaluate(
    cdp,
    `(async () => {
        // Synchronous, like the invert above: wbFoldUnticked toggles the classes and the label
        // inside the handler. (Was a 150 ms sleep.)
        document.querySelector('#wbFold_books').click();
        const boxes = [...document.querySelectorAll('#wbFields_books .wbfield')];
        return {folded: boxes.map(b => b.classList.contains('wbfold')),
                heads: boxes.map(b => !!b.querySelector('.wbhead')),
                ticks: boxes.map(b => !!b.querySelector('.wbtick')),
                label: document.querySelector('#wbFold_books').textContent};
    })()`,
  );
  ok(
    fold.folded[0] === true && fold.folded[1] === false && fold.folded[2] === true,
    'collapse unticked folds exactly the unticked fields and leaves the ticked one open',
  );
  // 🔴 The header row is what makes the fold reversible. Hiding it would take the checkbox with
  // it, and then the control that undoes the hiding is inside the thing that was hidden.
  ok(
    fold.heads.every(Boolean) && fold.ticks.every(Boolean),
    'and every folded field keeps its header row and its checkbox, so it can be ticked back',
  );
  ok(/show all/i.test(fold.label), 'and the button says how to undo it rather than repeating what it just did');

  const back = await evaluate(
    cdp,
    `(async () => {
        const boxes = [...document.querySelectorAll('#wbFields_books .wbfield')];
        // click() on a checkbox dispatches the change event synchronously, and that handler (open.js) runs
        // wbFoldPaint and wbPreflight before returning. (Was a 150 ms sleep.)
        boxes[0].querySelector('.wbtick').click();
        return {folded: boxes[0].classList.contains('wbfold'),
                pre: document.querySelector('#wbPreflight_books').textContent};
    })()`,
  );
  ok(back.folded === false, 'ticking a folded field brings its body straight back — the header is a control, not a label');
  ok(/2 of 3 fields selected/.test(back.pre), `and that tick reaches the preflight too (${back.pre})`);

  // Leave the pane as the rest of the spec expects it.
  await evaluate(
    cdp,
    `document.querySelector('#wbFold_books').click();
                         document.querySelector('#wbAll_books').click()`,
  );
}

// ── a hand edit mints a revision — the half of 7.0 with no model in it ───────
{
  await evaluate(
    cdp,
    `(() => {
        const t = document.querySelector('#wbFields_books .wbtext');
        t.value = 'Edited by hand in a real browser.';
        t.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbSaveWrap_books').style.display !== 'none'`, 5000);
  ok(
    await evaluate(cdp, `document.querySelector('#wbSaveWrap_books').style.display !== 'none'`),
    'editing a field reveals the Save control',
  );
  await evaluate(cdp, `document.querySelector('#wbSave_books').click()`);
  // mustWait, not ok(await waitFor(...)): on a loaded box this is the wait that expires first,
  // and a plain ok() reports "FAIL saving mints a revision" without saying it TIMED OUT — which
  // reads as the editor being broken rather than the box being slow.
  await mustWait(
    cdp,
    `document.querySelector('#wbRevPick_books').options.length === 2`,
    'saving mints a revision, and the picker offers both',
  );

  // An async IIFE, not a bare top-level await: Runtime.evaluate only accepts the latter in
  // replMode, and without it the page reports a SyntaxError that reads like a bug in the app.
  const rev = n =>
    evaluate(
      cdp,
      `(async () => (await (await fetch(
        '/wbedit/documents/${docId}/revision/' + ${n})).json()).content.entries['0'].content)()`,
    );
  const original = await rev(0);
  ok(/Test Character 1 keeps the ledger/.test(original), 'revision 0 is still the bytes as imported (I8)');
  ok((await rev(1)) === 'Edited by hand in a real browser.', 'and revision 1 carries the edit');
}

// ── an em dash reaches the textarea as an em dash (item 1) ───────────────────
//
// `test_wbedit_encoding.py` proves every SERVER leg is clean — store, disk bytes, both import
// routes, the PNG chunk and a model pass. This is the leg no Python test can reach: what the
// The server path is covered by Python tests; this browser check covers the fetch/JSON/DOM path
// and ensures it does not reinterpret the em dash on its way to the text field.
//
// 🔴 EVERY ASSERTED STRING IS BUILT FROM CODE POINTS, NOT TYPED AS LITERALS. A spec carrying the
// literal characters can be corrupted by any tool that rewrites this file with the wrong
// encoding — and it would then assert mojibake equals mojibake and pass, which is worse than no
// test at all. `String.fromCodePoint` is pure ASCII in source and cannot be mangled by a re-save.
// (Prose in these comments is exempt: nothing compares against it.)
//
// It cleans up after itself: the §8.2 blocks below read the Library, so an extra book left
// lying about would change what they count.
{
  // em dash · right single quote · curly double quotes · ellipsis · "Privet" · "konnichiwa"
  // · grinning face. Pure-ASCII source, so no re-save of this file can alter what is asserted.
  const HARD = String.fromCodePoint(
    0x2014,
    0x20,
    0x2019,
    0x20,
    0x201c,
    0x20,
    0x201d,
    0x20,
    0x2026,
    0x20,
    0x41f,
    0x440,
    0x438,
    0x432,
    0x435,
    0x442,
    0x20,
    0x3053,
    0x3093,
    0x306b,
    0x3061,
    0x306f,
    0x20,
    0x1f600,
  );
  const TYPED = 'Flagstaff ' + String.fromCodePoint(0x2014) + ' typed in a real browser ' + String.fromCodePoint(0x2026);
  const DOC = {
    name: 'Encoding probe',
    entries: {
      0: {
        uid: 0,
        key: ['dash'],
        comment: 'Dash',
        constant: false,
        order: 100,
        disable: false,
        content: 'Sample World Book 5 ' + HARD + ' polished',
      },
    },
  };
  const probeId = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({document: ${JSON.stringify(DOC)}, name: 'Encoding probe'})});
        return (await r.json()).id;
    })()`,
  );
  ok(!!probeId, 'a document carrying the hard characters imports');

  await evaluate(cdp, `wbOpen('books', '${probeId}', 0)`);
  await mustWait(cdp, `wbState('books').rev?.n === 0`, 'the encoding probe opens at revision 0');

  // Compare CODE POINTS, not the rendered string: text that round-trips its own corruption is
  // equal to itself. The array of code points is what a latin-1 reinterpretation destroys.
  const seen = await evaluate(
    cdp,
    `(() => {
        const t = document.querySelector('#wbFields_books .wbtext');
        return {value: t.value, points: [...t.value].map(c => c.codePointAt(0))};
    })()`,
  );
  const PREFIX = 'Sample World Book 5 ';
  const want = PREFIX + HARD + ' polished';
  // The em dash is HARD's first code point, so it sits right after the prefix. Counted from the
  // prefix rather than written as a number: the anonymization pass lengthened the prefix and a
  // hard-coded 7 then pointed at the "W" of "World" (2026-10-09).
  const dashAt = [...PREFIX].length;
  ok(seen.value === want, 'the editor field shows the characters that were stored, not mojibake');
  ok(seen.points[dashAt] === 0x2014, `the em dash arrives as U+2014 (got U+${(seen.points[dashAt] || 0).toString(16)})`);
  ok(!seen.value.includes(String.fromCodePoint(0xe2)), 'and no stray latin-1 a-circumflex (U+00E2)');

  // browser → server → browser: a hand edit must not corrupt on the way back out either.
  await evaluate(
    cdp,
    `(() => {
        const t = document.querySelector('#wbFields_books .wbtext');
        t.value = ${JSON.stringify(TYPED)};
        t.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbSaveWrap_books').style.display !== 'none'`, 5000);
  await evaluate(cdp, `document.querySelector('#wbSave_books').click()`);
  await mustWait(cdp, `wbState('books').doc?.latest === 1`, 'the hand-typed em dash is saved as a new revision');
  const back = await evaluate(
    cdp,
    `(async () => (await (await fetch(
        '/wbedit/documents/${probeId}/revision/1')).json()).content.entries['0'].content)()`,
  );
  ok(back === TYPED, 'an em dash typed into the editor survives the save and comes back intact');

  await evaluate(
    cdp,
    `(async () => { await fetch('/wbedit/documents/${probeId}',
        {method:'DELETE'}); })()`,
  );
  await evaluate(cdp, `wbOpen('books', '${docId}', 0)`);
  await mustWait(cdp, `wbState('books').rev?.n === 0`, 'the probe is deleted and Sample World Book 1 is back on screen at revision 0');
}

// ── the editor opens INLINE, under the row that was clicked (§6.1.2a) ────────
//
// The editor must open below the selected row and scroll into view; DOM presence alone does not
// prove that the opened pane is visible to the user.
{
  const where = await evaluate(
    cdp,
    `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        const pane = document.querySelector('#wbEditor_books');
        if(!row || !pane) return {ok: false};
        const slot = row.nextElementSibling;
        return {ok: true,
                slotIsSlot: !!slot && slot.classList.contains('wbslot'),
                paneInSlot: !!slot && slot.contains(pane),
                paneVisible: pane.style.display !== 'none',
                paneBelowRow: pane.getBoundingClientRect().top >= row.getBoundingClientRect().top};
    })()`,
  );
  ok(where.ok && where.slotIsSlot && where.paneInSlot, 'the editor is parked in a slot directly after the row that was clicked');
  ok(where.paneVisible && where.paneBelowRow, 'and it is visible, below that row rather than far down the page');
}

// 🔴 THE REGRESSION THAT MATTERS: reloading the roster wipes the container the pane is parked in.
// getElementById cannot find a DETACHED node, so without re-placing it from a held reference the
// editor would vanish for the rest of the session and every later wbEl() would answer null.
{
  await evaluate(cdp, `wbLoadLib('books')`);
  await mustWait(cdp, `document.querySelector('#wbLib_books .wbrow')`, 'the roster reload puts its rows back');
  const survived = await evaluate(
    cdp,
    `(() => {
        const pane = document.querySelector('#wbEditor_books');
        if(!pane) return {alive: false};
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        const slot = row && row.nextElementSibling;
        return {alive: true, reparked: !!slot && slot.contains(pane)};
    })()`,
  );
  ok(survived.alive, 'the editor node survives a roster reload rather than being detached');
  ok(survived.reparked, 'and it is put back under its row');
}

// ── the row is a disclosure control ─────────────────────────────────────────
//
// The row opens and closes its document, updates the button label, and scrolls the selected row
// into view.
{
  // The label follows the state. It is the only on-screen answer to "is this one open?" once
  // the editor is parked several rows down and out of view.
  ok(
    await evaluate(
      cdp,
      `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        return row && row.querySelector('button.wbopen').textContent.trim() === 'Close';
    })()`,
    ),
    "the open row's button reads Close while it is open",
  );

  // 🔴 The PORTRAIT carries `.wbopen` too and is the row's first child, so a bare `.wbopen`
  // selector writes the word "Close" over the picture. This is that bug, pinned.
  ok(
    await evaluate(
      cdp,
      `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        const face = row.querySelector('.wbface');
        return !face || !/^(Open|Close)$/.test(face.textContent.trim());
    })()`,
    ),
    'and the label was not written over the portrait',
  );

  // A second click on the SAME row closes it. Clicking the name, not the button — the whole row
  // is the target now.
  await evaluate(
    cdp,
    `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        row.querySelector('b').click();
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbEditor_books').style.display === 'none'`, 5000);
  ok(
    await evaluate(cdp, `document.querySelector('#wbEditor_books').style.display === 'none'`),
    'clicking the row again collapses it — same control both ways',
  );
  ok(
    await evaluate(
      cdp,
      `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        return row.querySelector('button.wbopen').textContent.trim() === 'Open';
    })()`,
    ),
    '…and the button goes back to reading Open',
  );

  // Clicking the row's empty space (the flex spacer, not the name or the button) opens it —
  // that is what "the entire row should be clickable" means in practice.
  await evaluate(
    cdp,
    `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        row.querySelector('div[style*="flex:1"]').click();
    })()`,
  );
  // ⚠️ WAIT, DO NOT SLEEP. Opening a row is three sequential fetches (document, fields,
  // revision). A fixed 400 ms is comfortable when this file runs alone and is NOT under a
  // loaded 16-worker suite — which is the only place it failed.
  ok(
    await waitFor(cdp, `document.querySelector('#wbEditor_books').style.display !== 'none'`, 10000),
    'clicking the empty part of the row opens it — the row IS the target, not the button',
  );
  // 🔴 AND LET THIS OPEN FINISH BEFORE THE NEXT BLOCK, WHICH MEASURES SCROLLING. The editor being
  // shown is the FIRST thing wbOpen does; its last is wbScrollToRow, a smooth scroll started two
  // frames after the preflight line is written. Under load that tail landed in the next block,
  // after its 3000px spacer was in, and carried the page to the spacer's far side: that block read
  // its starting position as 3085 and reported "opening a row ... scrolls the page to it (3085 →
  // 3085)" (2026-10-12). The preflight text is wbOpen's last paint, and the scroll is awaited
  // at rest. Unlabeled by design: a hang here shows up as the next block's own failures.
  await waitFor(cdp, `/fields? selected/.test(document.querySelector('#wbPreflight_books').textContent)`, 15000);
  await evaluate(cdp, SCROLL_AT_REST);
}

// ── opening scrolls the row into view (§6.1.2a) ──────────────────────────────
//
// 🔴 The editor opens INLINE, under the row — which is ABOVE the click when the row is below the
// fold, so the page not moving reads as "nothing happened" over a document that opened perfectly.
// Opening a row below the fold scrolls it into view without moving away from the list.
{
  // Make the list long enough that the last row is genuinely off screen, then jump to the top so
  // the open cannot be satisfied by the page already being in the right place.
  await evaluate(
    cdp,
    `(() => {
        const lib = document.getElementById('wbLib_books');
        const spacer = document.createElement('div');
        spacer.style.height = '3000px';
        spacer.id = 'wbTallSpacer';
        lib.parentNode.insertBefore(spacer, lib);
        window.scrollTo({top: 0, behavior: 'auto'});
    })()`,
  );
  await waitFor(cdp, `window.scrollY === 0 && !!document.getElementById('wbTallSpacer')`, 5000);

  await evaluate(
    cdp,
    `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        row.querySelector('b').click();                    // close
    })()`,
  );
  await mustWait(
    cdp,
    `document.querySelector('#wbEditor_books').style.display === 'none'`,
    'the second click on the row closes the editor',
    10000,
  );
  // Any smooth scroll still running from an earlier open is waited out FIRST: an instant scroll
  // layered on a running smooth one only moves where that animation eases from (see the note in
  // open.js), so the reset below would lose to it. Then the page is put at the top and the
  // starting position is read, here, after everything that could move it has.
  await evaluate(cdp, SCROLL_AT_REST);
  await evaluate(cdp, `window.scrollTo({top: 0, behavior: 'instant'})`);
  await waitFor(cdp, `window.scrollY === 0`, 5000);
  const before = await evaluate(cdp, `window.scrollY`);
  // 🔴 THE SCROLL IS WATCHED BY ITS OWN EVENTS, ARMED BEFORE THE CLICK THAT CAUSES IT. `started` is
  // the number of `scrollend`s seen at the moment the first `scroll` event moved the page past
  // `before`, so a stray `scrollend` from some earlier scroll cannot be mistaken for this one's,
  // and `ended > started` is true only after THIS smooth scroll has actually come to rest. The
  // loop that was here sampled scrollY every 100 ms until two samples agreed, which is a guess
  // about how long the animation takes and is wrong whenever the box is slow enough to pause it.
  await evaluate(
    cdp,
    `(() => {
        window.__wbScroll = {started: -1, ended: 0};
        window.addEventListener('scroll', () => {
            if (window.__wbScroll.started < 0 && window.scrollY > ${before})
                window.__wbScroll.started = window.__wbScroll.ended;
        });
        window.addEventListener('scrollend', () => { window.__wbScroll.ended++; });
        return true;
    })()`,
  );
  await evaluate(
    cdp,
    `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        row.querySelector('b').click();                    // open, from the top of the page
    })()`,
  );
  // ⚠️ The scroll is issued by `wbOpen`, at the END of three fetches — so waiting for the editor
  // is what makes the settle loop below meaningful. Without it the loop can start and finish
  // before the page has been asked to move at all, and report "it never scrolled".
  await mustWait(
    cdp,
    `document.querySelector('#wbEditor_books').style.display !== 'none'`,
    'and a third click opens it again from the top of the page',
    10000,
  );
  // 🔴 WAIT FOR THE SCROLL TO COME TO REST, NOT MERELY TO START. It is a SMOOTH scroll, so a
  // `waitFor(scrollY > n)` returns mid-animation and the next line measures a position the page
  // is still traveling through — which reported the row at 2700px of an 849px viewport and
  // looked exactly like the feature being broken. `scrollend` is the browser saying it stopped.
  // 🔴 AND IT HAS TO HAVE *STARTED* FIRST (the `started` mark armed above). The old settle loop
  // exited as soon as two samples 100 ms apart agreed, and `0` then `0` before the smooth scroll
  // had begun agree: "not started yet" read as "finished", and the check reported `0 → 0` and
  // failed as though the feature were broken. It passed alone and went red in the parallel suite.
  // If it genuinely never scrolls this still fails, one timeout later and honestly: `scrolledAndRested`
  // is false and is folded into the first check below.
  const scrolledAndRested = await waitFor(
    cdp,
    `window.__wbScroll.started >= 0 && window.__wbScroll.ended > window.__wbScroll.started`,
    15000,
  );

  const placed = await evaluate(
    cdp,
    `(() => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        const top = row.getBoundingClientRect().top;
        return {top, h: window.innerHeight, y: window.scrollY};
    })()`,
  );
  ok(scrolledAndRested && placed.y > before, `opening a row below the fold scrolls the page to it (${before} → ${placed.y})`);
  // A third of the way down, give or take — the point is that it is ON screen and not jammed
  // against the top edge, so the rows above it still read as context.
  ok(
    placed.top > 0 && placed.top < placed.h * 0.6,
    `and the row lands about a third down, not at the very top (${Math.round(placed.top)}px of ${placed.h})`,
  );

  await evaluate(cdp, `document.getElementById('wbTallSpacer').remove()`);
}

// ── nothing in the Library header escapes its panel ──────────────────────────
//
// The Library header controls must fit inside the panel, not just inside the viewport.
//
// ⚠️ Measured against the PANEL's right edge, not the viewport: the panel is what he can see and
// click inside, and an element can sit inside a 1900px window while being outside its own box.
{
  await evaluate(cdp, `switchStTab('cards')`);
  await waitFor(cdp, `document.querySelector('[data-stpanel="cards"]').style.display !== 'none'`, 8000);
  // Wait for layout geometry after changing panel visibility; style assignment alone does not guarantee a nonzero rect.
  await waitFor(
    cdp,
    `(() => { const b = document.getElementById('wbStSweep_cards');
        return !!b && b.getBoundingClientRect().width > 0; })()`,
    8000,
  );
  const hdr = await evaluate(
    cdp,
    `(() => {
        const bar = document.querySelector('[data-stpanel="cards"] .logwrap');
        const panel = bar.closest('.panel');
        const edge = panel.getBoundingClientRect().right;
        const over = [...bar.children]
            .filter(el => getComputedStyle(el).display !== 'none')
            .map(el => ({id: el.id || el.tagName.toLowerCase(),
                         right: Math.round(el.getBoundingClientRect().right),
                         w: Math.round(el.getBoundingClientRect().width)}))
            .filter(x => x.right > Math.round(edge) + 1);
        const sweep = document.getElementById('wbStSweep_cards').getBoundingClientRect();
        return {over, edge: Math.round(edge), sweepW: Math.round(sweep.width),
                sweepRight: Math.round(sweep.right)};
    })()`,
  );
  ok(hdr.over.length === 0, `no Library header control is pushed outside its panel (${JSON.stringify(hdr.over)})`);
  ok(
    hdr.sweepW > 0 && hdr.sweepRight <= hdr.edge + 1,
    `⟳ Import from SillyTavern is inside the panel and clickable (right ${hdr.sweepRight} vs edge ${hdr.edge})`,
  );

  // The drop-downs are content-sized, not stretched by the global form rule.
  const widths = await evaluate(
    cdp,
    `(() => {
        const s = document.getElementById('wbSort_cards');
        return {sort: Math.round(s.getBoundingClientRect().width),
                cs: getComputedStyle(s).width};
    })()`,
  );
  ok(widths.sort > 40 && widths.sort < 260, `the sort drop-down is a drop-down, not a full-width bar (${widths.sort}px)`);

  // ── §9a.11 / 7.5.19 — ✚ New Character Card, the half that stayed parked until now ─────────
  //
  // 🔴 WHAT ONLY A BROWSER CAN SAY IS THAT THE RESULT CAN BE TYPED INTO. The route tests assert
  // the field LIST and the fourteen validator keys; neither of them can tell you the editor
  // actually drew boxes. A card is born with every field blank, and the pre-7.4 collector
  // skipped absent and blank alike — so the failure mode this guards is a create button whose
  // document opens on "This document has no editable fields".
  ok(await evaluate(cdp, `!!document.getElementById('wbNewCard_cards')`), '✚ New Character Card is on the Cards pane — §9a.11');

  // `wbAskName` is a modal, so the fixture name is entered through the visible field.
  await evaluate(cdp, `document.getElementById('wbNewCard_cards').click()`);
  await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`, 8000);
  await evaluate(
    cdp,
    `(() => {
        const i = document.querySelector('#mBody input[type=text]');
        i.value = 'Test Character 2';
        [...document.querySelectorAll('#mActs button')].find(b => /OK/.test(b.textContent)).click();
        return true; })()`,
  );
  ok(await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`, 8000), 'naming the card closes the dialog');
  ok(
    await waitFor(cdp, `/Test Character 2/.test(document.getElementById('wbLib_cards').textContent)`, 10000),
    'the created card lands in the Cards Library',
  );

  // 🔴 IT OPENS ON BOXES, AND THEY ARE EMPTY. `card_empty` (7.4 / §9a.32) is what makes a
  // first-ever value saveable; without it every one of these rows is absent.
  //
  // ⚠️ THE WAIT IS NOT DECORATION — WITHOUT IT THIS MEASURES THE HOST. The step above waits for
  // the card to appear in the LIBRARY, and the editor pane draws in a separate async step after
  // that, so a bare `evaluate` here reads `#wbFields_cards` before it has been filled in. It
  // passes on an idle box and fails under a loaded 16-worker run with `{"n":0,"blank":true}` —
  // `blank` is vacuously true over an empty list, so the failure then reads as "the editor drew
  // nothing" rather than "the assertion was taken too early", and the very next `evaluate`
  // dies on `Cannot set properties of null`.
  //
  // 📌 NO `ok()` ON THE WAIT ITSELF. A timeout leaves n at 0 and the existing assertion fails
  // with exactly the message it always did — only the moment it is taken has changed, so the
  // roster in the .py file needs no new line.
  await waitFor(cdp, `document.querySelectorAll('#wbFields_cards textarea').length >= 5`, 10000);
  const cardDrew = await evaluate(
    cdp,
    `(() => {
        const t = [...document.querySelectorAll('#wbFields_cards textarea')];
        return { n: t.length, blank: t.every(x => x.value === '') };
    })()`,
  );
  ok(cardDrew.n >= 5 && cardDrew.blank, `the editor opens the new card on EMPTY boxes to type into (${JSON.stringify(cardDrew)})`);

  // The round trip: type, save, and the revision really carries it — and the stored document is
  // still a valid V2 card rather than something the editor flattened on the way through.
  const cardSaved = await evaluate(
    cdp,
    `(async () => {
        const t = document.querySelector('#wbFields_cards textarea');
        t.value = 'Tall, and entirely unimpressed.';
        t.dispatchEvent(new Event('input', {bubbles: true}));
        await wbSaveEdits('cards');
        const id = wbState('cards').doc.id;
        const d = await (await fetch('/wbedit/documents/' + id)).json();
        const n = d.revisions[d.revisions.length - 1];
        const r = await (await fetch('/wbedit/documents/' + id + '/revision/' + n)).json();
        const c = r.content;
        return { n, spec: c.spec, version: c.spec_version, st_ref: d.st_ref,
                 world: d.world_ref, flat: ('description' in c),
                 typed: JSON.stringify(c.data).includes('entirely unimpressed') };
    })()`,
  );
  ok(cardSaved.n === 1 && cardSaved.typed, `typing into an empty card field saves as revision ${cardSaved.n}`);
  ok(cardSaved.spec === 'chara_card_v2' && cardSaved.version === '2.0', 'and the stored document is still a valid V2 card after the edit');
  // 🔴 THE ONE THAT IS ABOUT HIS PROSE, NOT ABOUT TIDINESS. A flat V1 alias would now be stale
  // against `data.description`, and `readFromV2` logs BOTH VALUES on a mismatch — his text into
  // SillyTavern's log. Absent is silent; empty is not (`characters.js:706`).
  ok(!cardSaved.flat, 'and carries no flat V1 alias to go stale and log his description');
  // Association remains forward-only; this action does not create a World Book link.
  ok(cardSaved.st_ref === '' && cardSaved.world === '', 'it has no SillyTavern ref yet and no world book attached');

  // 🔴 PUT THE TAB BACK. Everything below this drives the World Books pane, and a block that
  // leaves another sub-tab open breaks the NEXT one — the find-bar check needs a visible
  // textarea to select inside, and reported "undefined" rather than anything about find.
  await evaluate(cdp, `switchStTab('books')`);
  await waitFor(cdp, `document.querySelector('[data-stpanel="books"]').style.display !== 'none'`, 8000);
}

// Library order and row renaming are verified through the rendered controls.
{
  // Sorting is client-side over the fetched roster, so this drives the real control and reads
  // the real rows rather than asserting on a comparator in isolation.
  const names = async () => await evaluate(cdp, `[...document.querySelectorAll('#wbLib_books .wbrow b')].map(b => b.textContent)`);

  ok(await evaluate(cdp, `!!document.getElementById('wbSort_books')`), 'the Library has a sort control');
  ok(await evaluate(cdp, `document.getElementById('wbSort_books').value === 'new'`), 'and it defaults to newest first');

  // 🔴 A SORT CHANGE RELOADS THE ROSTER (`wbLoadLib`: one fetch, then ONE repaint of #wbLib_books),
  // so "the roster has changed" is a repaint count, not a quiet period. These three changes used
  // to be followed by `settled(...)`, which polled the rows' text until two reads 120 ms apart
  // agreed: on a loaded box the fetch had not answered yet, nothing had moved, and two identical
  // reads of the OLD order counted as settled. `changeSortTo` records the repaint count and makes
  // the change; the caller then waits for the count to go past what was recorded.
  await evaluate(
    cdp,
    `window.__wbRosterPaints = 0;
     new MutationObserver(() => { window.__wbRosterPaints++; })
         .observe(document.getElementById('wbLib_books'), {childList: true});
     true`,
  );
  const changeSortTo = async how => {
    const seen = await evaluate(cdp, `window.__wbRosterPaints`);
    await evaluate(
      cdp,
      `(() => {
          const s = document.getElementById('wbSort_books');
          s.value = ${JSON.stringify(how)}; s.dispatchEvent(new Event('change'));
      })()`,
    );
    return seen;
  };

  const seenAtAz = await changeSortTo('az');
  await mustWait(cdp, `window.__wbRosterPaints > ${seenAtAz}`, 'Name A–Z re-renders the roster');
  const az = await names();
  const sorted = [...az].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  ok(JSON.stringify(az) === JSON.stringify(sorted), `Name A–Z actually orders the rows (${az.join(', ')})`);

  const seenAtZa = await changeSortTo('za');
  const zaRepainted = await waitFor(cdp, `window.__wbRosterPaints > ${seenAtZa}`, 15000);
  const za = await names();
  ok(zaRepainted && JSON.stringify(za) === JSON.stringify([...sorted].reverse()), `and Z–A reverses it (${za.join(', ')})`);

  const seenAtNew = await changeSortTo('new');
  // No check follows on the rows themselves; the wait is so the repaint is not still in flight
  // when the next block starts driving the roster. A hang is a failure, not a pass.
  if (!(await waitFor(cdp, `window.__wbRosterPaints > ${seenAtNew}`, 15000)))
    throw new Error('choosing Newest first never repainted the roster, so the next block would run against a list still loading');

  // 🔴 A TOTAL ORDER, OR THE LIST RESHUFFLES ON EVERY REPAINT. Documents pushed by one sweep
  // share `imported_at`, so date order alone leaves equal rows free to swap between renders —
  // which he would see as the roster rearranging itself whenever he pressed ⟳.
  // ⚠️ Checked under a DATE sort on purpose: that is the comparator that can tie. Under a name
  // sort the primary key already separates them and the tie-break is never reached, so running
  // this while 'za' was selected asserted nothing about stability at all.
  const stable = await evaluate(
    cdp,
    `(() => {
        const same = [{id: 'b', name: 'Beta',  imported_at: 5},
                      {id: 'a', name: 'Alpha', imported_at: 5},
                      {id: 'c', name: 'Gamma', imported_at: 5}];
        const once  = wbSortDocs('books', same).map(d => d.id).join(',');
        const twice = wbSortDocs('books', same).map(d => d.id).join(',');
        return {once, twice};
    })()`,
  );
  ok(
    stable.once === stable.twice && stable.once === 'a,b,c',
    `rows sharing a timestamp keep one stable order (${stable.once} then ${stable.twice})`,
  );
}

// ── ✎ Rename: the route shipped in m2, the button did not until m4d ──────────
{
  ok(await evaluate(cdp, `!!document.getElementById('wbRename_books')`), 'the editor has a Rename button');

  // Drive the app modal instead of native prompt; a native prompt blocks CDP evaluation. This also exercises the shared name-entry flow.
  const renamed = await evaluate(
    cdp,
    `(async () => {
        const row = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .find(r => r.textContent.includes('Sample World Book 1'));
        // 🔴 ENSURE OPEN, NEVER BLIND-CLICK. The row is a DISCLOSURE control: a click on a row
        // that is ALREADY open closes it, and Rename then has no document, so this block and the
        // whole Save-to-SillyTavern block below it run against "Open a document first." and fail
        // for a reason that names none of this. It used to get away with a bare click only
        // because a roster reload DETACHED the editor and left it shut — the review's §5.6 bug.
        // Now that wbLoadLib re-parks it, the sort block above hands this one an open editor.
        // Written as "open it if it is not open" so it is right under both behaviors.
        const isOpen = () => {
            const ed = document.getElementById('wbEditor_books');
            return !!ed && ed.style.display !== 'none'
                   && (wbState('books').doc || {}).id === ${JSON.stringify(docId)};
        };
        if(!isOpen()) row.querySelector('b').click();
        // 🔴 WAIT FOR THE OPEN TO HAVE FINISHED, NOT FOR 600 ms OF HOPE. "Shown" (isOpen) is only
        // the first half of wbOpen: Rename reads st.doc and st.rev, and the fields are painted
        // after the revision arrives. A fixed 600 ms after isOpen() was the pause here; the loop
        // now waits for a revision and painted fields, bounded at 15 s like the other loops.
        const isLoaded = () => isOpen() && !!wbState('books').rev
                               && document.querySelectorAll('#wbFields_books .wbfield').length > 0;
        for(let i = 0; i < 150 && !isLoaded(); i++) await new Promise(r => setTimeout(r, 100));
        // A spy, not a stub with a value: if any path still reaches the browser's own dialog it
        // trips this and returns null, so the flow fails visibly instead of silently working.
        window.__nativePrompt = false;
        window.prompt = () => { window.__nativePrompt = true; return null; };
        document.getElementById('wbRename_books').click();
        // No pause after the click: the Rename handler calls wbAskName, whose modal() writes
        // #mBody and turns the overlay on synchronously inside the click, before it first awaits.
        // This was a 300 ms sleep, waiting for nothing. (The block above, not a sleep, is what
        // guarantees st.doc exists for the handler to find.)
        const box = document.querySelector('#mBody input[type="text"]');
        if(!box) return {title: 'NO MODAL INPUT', roster: '', native: false};
        box.value = 'Sample World Book 1 (renamed)';
        [...document.querySelectorAll('#mActs button')].find(b => b.textContent === 'OK').click();
        // WAIT FOR THE CONDITION, NOT FOR A NUMBER. This was a flat 900ms and it lost the race
        // under a loaded 16-worker suite while passing every time in isolation: OK fires a PUT,
        // then wbLoadLib, then wbOpen, and three round trips do not fit in a fixed sleep on a box
        // that is also running fifteen other test processes. The assertion is about the END
        // STATE, so poll for it and let the check below report whatever is actually there.
        for(let i = 0; i < 60; i++){
            if(/renamed/.test(document.getElementById('wbDocName_books').textContent)) break;
            await new Promise(r => setTimeout(r, 100));
        }
        return {title: document.getElementById('wbDocName_books').textContent,
                roster: document.getElementById('wbLib_books').textContent,
                native: window.__nativePrompt === true};
    })()`,
  );
  ok(/Sample World Book 1 \(renamed\)/.test(renamed.title), `renaming updates the open editor's title (${renamed.title})`);
  // 🔴 The roster carries the name too, and a rename that only changed the header would look
  // like it worked until the next reload.
  ok(/Sample World Book 1 \(renamed\)/.test(renamed.roster), 'and the Library row, not just the header');
  // 🔴 THE SPY, NOT A SOURCE SCAN. The first cut of this check grepped the page's script text
  // for `prompt(` — and failed on the COMMENTS explaining why the native dialog was removed.
  // `test_st_extension_smoke` already has that lesson written down: a substring test over a
  // whole file is a check that punishes documenting the rule it enforces. This one observes
  // the call instead, which is the thing actually being forbidden.
  ok(renamed.native === false, "and no code path still asks through the browser's native prompt()");
}

// ── ⬆ Send to SillyTavern (§7, m3): the half of export that writes ────────────
// 🔴 THE PRESS IS DRIVEN, NOT JUST THE MARKUP. m1e's whole reason for existing is that the seam
// between the button and the route is where the defect lives — the route specs call the route with
// what the route expects, and a smoke test finds the string either way. Here the button is clicked
// with no SillyTavern tab in existence, and the pane must end up saying so.
{
  ok(await evaluate(cdp, `!!document.getElementById('wbSend_books')`), 'the editor has a Save to SillyTavern button');
  // It has to be visibly distinct from Export: Export writes to his downloads folder, Save
  // changes a document in a different product.
  ok(
    await evaluate(
      cdp,
      `document.getElementById('wbSend_books').className !==
         document.getElementById('wbExport_books').className`,
    ),
    'and Save does not look like Export — only one of them writes outside Vocalis',
  );
  // Export closes the ENTRY group after ⇄ Import & merge…, its inbound counterpart. Keep it there
  // and outside the toolbar group so the row does not wrap or mix unrelated actions.
  //
  // ⚠️ LAST IN THE GROUP RATHER THAN DIRECTLY BESIDE ⇄ Import & merge…, AND THAT IS MEASURED, NOT
  // A PREFERENCE. Between the merge door and ⇊ Fix positions, this button pushed ⇊ Fix positions
  // onto the next wrapped line — which is the exact regression the strip check at the end of this
  // file exists to catch ("it sits with ✚ Add entry and ⬆ Import entry, the two it belongs with").
  // Appended after it instead, every control that was on a line stays on it.
  //
  // Sibling order and not a rect: `.logwrap` is `flex-wrap: wrap`, so two buttons sharing a visual
  // line prove nothing about which group a reader puts them in — and this block runs with the
  // books pane possibly off screen, where every rect is 0.
  const exportHome = await evaluate(
    cdp,
    `(() => {
        const ex = document.getElementById('wbExport_books');
        const merge = document.getElementById('wbMergeImport_books');
        const send = document.getElementById('wbSend_books');
        const fix = document.getElementById('wbFixDepths_books');
        return {afterMerge: !!(merge.compareDocumentPosition(ex) & Node.DOCUMENT_POSITION_FOLLOWING),
                lastInGroup: ex.previousElementSibling === fix,
                beforeSend: !!(ex.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING),
                sameGroup: ex.parentElement === merge.parentElement,
                label: ex.textContent.trim()};
    })()`,
  );
  ok(exportHome.afterMerge && exportHome.lastInGroup, 'and ⬇ Export… closes the entry group, after ⇄ Import & merge…');
  ok(exportHome.sameGroup && exportHome.beforeSend, 'in that group rather than the Save/Send/Close one it used to live in');
  // The ellipsis is the promise that a dialog follows — the same convention ⬆ Import file… and
  // ⇄ Import & merge… keep, and since 11.1.8 this button does open one.
  ok(/^⬇ Export…$/.test(exportHome.label), `and its label says a dialog is coming (${JSON.stringify(exportHome.label)})`);
  // 🔴 NEVER DISABLED. He can overwrite the document in SillyTavern's own client at any time,
  // so "Vocalis already sent this revision" is not evidence about what is over there now.
  ok(
    await evaluate(cdp, `document.getElementById('wbSend_books').disabled === false`),
    'and it is enabled — a previous send is never a reason to refuse another',
  );

  const sent = await evaluate(
    cdp,
    `(async () => {
        document.getElementById('wbSend_books').click();
        // Same repair as the rename above: poll for the state, do not guess how long it takes.
        // A flat 700ms was thin under a loaded suite, and the failure read as "the send status is
        // not busy" — a product claim — when it was really "the click had not landed yet".
        for(let i = 0; i < 60; i++){
            const m = document.getElementById('wbMsg_books');
            if(m && /sending|waiting/i.test(m.textContent)) break;
            await new Promise(r => setTimeout(r, 100));
        }
        const el = document.getElementById('wbMsg_books');
        return {text: el.textContent, cls: el.className,
                status: await (await fetch('/wbedit/st-push')).json()};
    })()`,
  );
  // Pending on the server is what proves the click reached the route rather than dying in JS.
  ok(!!(sent.status.pending || sent.status.running), 'pressing Send records a job the extension can collect');
  ok(/sending|waiting/i.test(sent.text), `and the pane says a send is under way (${JSON.stringify(sent.text)})`);
  // 🔴 'busy' has no timeout by design, so a path that sets one and never closes it leaves an
  // amber spinner forever. Queueing keeps it busy on purpose — the Cancel below is its exit.
  ok(/wbbusy/.test(sent.cls), 'the send status is the busy tone, not plain chatter');

  // 🔴 m4w / §9a.17. No extension exists in this browser, so nothing will collect the job — which
  // is EXACTLY the state a throttled background tab presents. It used to be reported as "no
  // SillyTavern tab is listening" after 14s, over a tab that was sitting right there. It must now
  // say it is queued, keep the job, and offer a way out.
  const queued = await evaluate(
    cdp,
    `(async () => {
        for(let i = 0; i < 40; i++){
            await new Promise(r => setTimeout(r, 500));
            const el = document.getElementById('wbMsg_books');
            if(/queued/i.test(el.textContent)){
                return {text: el.textContent, cls: el.className,
                        btn: (el.querySelector('button.sm') || {}).textContent || '',
                        status: await (await fetch('/wbedit/st-push')).json()};
            }
        }
        return {text: document.getElementById('wbMsg_books').textContent, status: null, btn: ''};
    })()`,
  );
  ok(
    /background/i.test(queued.text) && !/No SillyTavern tab is listening/i.test(queued.text),
    'an uncollected send says the tab is in the background and QUEUED, never that none is listening',
  );
  ok(!!(queued.status && queued.status.pending), 'and the job is kept rather than withdrawn on a 14-second guess');
  ok(/cancel/i.test(queued.btn), 'and a queued send offers Cancel, because a busy line with no exit is not an answer');

  // 🔴 WITHDRAWING IS STILL RIGHT WHEN HE ASKS FOR IT. A send left pending fires whenever a tab
  // next opens, as an unannounced write into his install — that decision is now his, not a timer's.
  const canceled = await evaluate(
    cdp,
    `(async () => {
        document.getElementById('wbMsg_books').querySelector('button.sm').click();
        // Wait for the pane's own announcement, which wbStSendCancel makes only AFTER its DELETE
        // has been answered, so the status read below cannot be ahead of the withdrawal. This was
        // a flat 600 ms. If the words never come the checks below still report what was on screen.
        for(let i = 0; i < 150 && !/canceled/i.test(document.getElementById('wbMsg_books').textContent); i++)
            await new Promise(r => setTimeout(r, 100));
        return {text: document.getElementById('wbMsg_books').textContent,
                status: await (await fetch('/wbedit/st-push')).json()};
    })()`,
  );
  ok(
    canceled.status && !canceled.status.pending && !canceled.status.running,
    'pressing Cancel withdraws the job so no write fires when a tab next opens',
  );
  ok(/canceled/i.test(canceled.text), 'and it says so, rather than leaving the queued line up over nothing');
}

// ── m4n: the revision picker says WHEN, and a save says so in green ───────────
{
  const opts = await evaluate(
    cdp,
    `(() => {
        const sel = document.getElementById('wbRevPick_books');
        return [...sel.options].map(o => o.textContent);
    })()`,
  );
  // The picker uses a fixed display format rather than locale-dependent date output.
  ok(
    opts.length > 0 && opts.every(t => /\[\d{1,2}-[A-Z][a-z]{2}-\d{4} \d{1,2}:\d{2} [AP]M\]/.test(t)),
    `every revision in the picker carries its date and time (${JSON.stringify(opts[0])})`,
  );
  // Newest at the top: what he reaches for is the latest or the one before it, and revision 0
  // heading a thirty-entry list buries both.
  const nums = opts.map(t => Number((t.match(/revision (\d+)/) || [])[1]));
  ok(nums.length > 1 && nums[0] > nums[nums.length - 1], `the newest revision is at the top of the picker (${nums.join(',')})`);

  // 🔴 The save confirmation, and the scroll position. Both were the same complaint: the page
  // jumped and the one record of the save was a gray line that erased itself in six seconds.
  const saved = await evaluate(
    cdp,
    `(async () => {
        const ta = document.querySelector('#wbFields_books .wbtext');
        ta.value = ta.value + ' Edited in a browser.';
        ta.dispatchEvent(new Event('input', {bubbles: true}));
        // The 200 ms sleep that was here waited for nothing: the input handler (wbMarkDirty) marks
        // the field dirty and shows the Save controls synchronously. The scroll is 'instant' so
        // 220 is where the page is when Save is pressed, whatever the stylesheet says.
        window.scrollTo({top: 220, behavior: 'instant'});
        document.getElementById('wbSave_books').click();
        // 🔴 WAIT FOR THE TOAST WE EXPECT, THEN FOR THE FRAME THAT RESTORES THE SCROLL. This was a
        // flat 1400 ms and then "read whatever the toast says". Under a loaded 16-worker run the
        // save had not finished, the toast still held the PREVIOUS step's line, and the check
        // failed with ("send canceled — nothing was written to SillyTavern.✕") for a save that was
        // fine (2026-10-12). wbSaveEdits writes 'saved as revision N' LAST, after the reload, and
        // queues the scroll restore (requestAnimationFrame) just before it, so two frames after
        // the toast the restore has certainly run and the y below is the page's real answer.
        // A save that never finishes leaves the old toast up, and the check below prints it.
        // (NO BACKTICKS IN HERE: this is a template literal, and one ends it.)
        for(let i = 0; i < 300; i++){
            if(/saved as revision \d+/.test(document.getElementById('wbMsg_books').textContent)) break;
            await new Promise(r => setTimeout(r, 50));
        }
        await ${NEXT_FRAME};
        const el = document.getElementById('wbMsg_books');
        return {text: el.textContent, cls: el.className, y: window.scrollY,
                x: !!el.querySelector('button.wbx')};
    })()`,
  );
  ok(/saved as revision \d+/.test(saved.text), `saving says which revision it made (${JSON.stringify(saved.text)})`);
  // 'ok' is m4m's terminal tone: green, and it stays until dismissed. A save is exactly the
  // event that must still be on screen when he looks back up.
  ok(/wbok/.test(saved.cls), 'and it is green, not gray chatter that erases itself');
  ok(saved.x, 'and it carries an ✕ so he can dismiss it himself');
  ok(saved.y > 0, `and the save did not throw away his scroll position (y=${saved.y})`);
}

// ── Preview one names the field it will use (§6.1.3, item 7) ─────────────────
{
  const pick = await evaluate(
    cdp,
    `(() => {
        const s = document.querySelector('#wbPreviewPick_books');
        if(!s) return {present: false};
        return {present: true, count: s.options.length,
                first: s.options[0] ? s.options[0].textContent : '',
                ticked: document.querySelectorAll('#wbFields_books .wbtick:checked').length};
    })()`,
  );
  ok(pick.present, 'Preview one offers a field picker');
  ok(pick.count === pick.ticked, `it lists exactly the ticked fields (${pick.count} options, ${pick.ticked} ticked)`);
  ok(/\w/.test(pick.first) && /chars/.test(pick.first), `and each option names the field and its size (${pick.first})`);

  // Unticking has to remove it from the picker — offering a field Run pass would skip is worse
  // than offering nothing.
  await evaluate(
    cdp,
    `(() => {
        const c = document.querySelector('#wbFields_books .wbtick');
        c.checked = false; c.dispatchEvent(new Event('change', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbPreviewPick_books').options.length === ${pick.count - 1}`, 5000);
  const after = await evaluate(cdp, `document.querySelector('#wbPreviewPick_books').options.length`);
  ok(after === pick.count - 1, 'unticking a field removes it from the picker');
  await evaluate(cdp, `document.querySelector('#wbAll_books').click()`);
}

// ── find & replace across every field (§6.6) ────────────────────────────────
//
// 🔴 Highlighting is the BROWSER's selection, not markup: a <textarea> renders its value as plain
// text, so the assertion is on selectionStart/selectionEnd, which is what the user actually sees.
{
  await evaluate(cdp, `wbFindOpen('books')`);
  ok(await evaluate(cdp, `document.querySelector('#wbFind_books').style.display !== 'none'`), 'the find bar opens');

  await evaluate(
    cdp,
    `(() => {
        const q = document.querySelector('#wbFindQ_books');
        q.value = 'Test Character 1'; q.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbFindCount_books').textContent.includes('of ')`, 5000);
  const found = await evaluate(cdp, `document.querySelector('#wbFindCount_books').textContent`);
  ok(/of \d+/.test(found), `it reports a running count (${found})`);
  ok(
    /\d+ match/.test(await evaluate(cdp, `[...document.querySelectorAll('#wbFields_books .wbcount')].map(x=>x.textContent).join('')`)),
    'and each field header carries its own match count',
  );

  await evaluate(cdp, `wbFindGo('books', 1)`);
  const sel = await evaluate(
    cdp,
    `(() => {
        const t = document.activeElement;
        if(!t || t.tagName !== 'TEXTAREA') return {ok: false};
        return {ok: true, picked: t.value.slice(t.selectionStart, t.selectionEnd)};
    })()`,
  );
  ok(sel.ok && sel.picked === 'Test Character 1', `the current match is selected in the textarea itself (${sel.picked})`);

  // 🔴 AND THE MATCH IS VISIBLE, NOT PARKED UNDER THE PINNED CHROME (9.0.8). `wbFindGo` scrolls
  // with `block:'nearest'`, which brings the field into the VIEWPORT — whose top is behind the
  // sticky header and the pinned tab bar. Stepping UP to a match therefore left it selected,
  // focused and invisible. Selection alone cannot see that: `sel.picked` above is exactly right
  // for a textarea sitting entirely behind the header.
  const findGeom = await evaluate(
    cdp,
    `(() => {
        const t = document.activeElement;
        const bar = document.getElementById('tabs');
        if (!t || !bar) return null;
        return { top: t.getBoundingClientRect().top,
                 bottom: t.getBoundingClientRect().bottom,
                 chromeEndsAt: bar.getBoundingClientRect().bottom,
                 vh: window.innerHeight }; })()`,
  );
  ok(
    findGeom && findGeom.bottom > findGeom.chromeEndsAt && findGeom.top < findGeom.vh,
    'and the field it jumped to is actually on screen, below the pinned header — ' + JSON.stringify(findGeom),
  );

  // 🔴 A replace MUST mark the field dirty through the normal path, or Save never appears and
  // the edit is silently unsaveable.
  await evaluate(
    cdp,
    `(() => {
        const r = document.querySelector('#wbFindR_books');
        r.value = '{{user}}'; r.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await evaluate(cdp, `wbFindReplaceOne('books')`);
  await waitFor(cdp, `document.querySelector('#wbSaveWrap_books').style.display !== 'none'`, 5000);
  ok(
    await evaluate(cdp, `document.querySelector('#wbSaveWrap_books').style.display !== 'none'`),
    'replacing marks the document dirty and reveals Save',
  );
  ok(
    await evaluate(
      cdp,
      `[...document.querySelectorAll('#wbFields_books .wbtext')]
            .some(t => t.value.includes('{{user}}'))`,
    ),
    'and {{user}} is inserted VERBATIM — nothing treats the replacement as a template',
  );

  // A search with no matches must SAY so. Silence is indistinguishable from a broken search.
  await evaluate(
    cdp,
    `(() => {
        const q = document.querySelector('#wbFindQ_books');
        q.value = 'zzz-not-present-zzz'; q.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbFindCount_books').textContent.includes('no matches')`, 5000);
  ok(
    /no matches/.test(await evaluate(cdp, `document.querySelector('#wbFindCount_books').textContent`)),
    'a search with nothing to find says "no matches" rather than going quiet',
  );

  // Search includes entry titles stored in the settings fold, not only visible textareas.
  await evaluate(
    cdp,
    `(() => {
        const q = document.querySelector('#wbFindQ_books');
        q.value = 'Sample Entry 1'; q.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbFindCount_books').textContent.includes('of ')`, 5000);
  const titleCount = await evaluate(cdp, `document.querySelector('#wbFindCount_books').textContent`);
  ok(/of [1-9]/.test(titleCount), `a title-only match is found (${titleCount})`);

  // …and stepping onto it OPENS the ⚙ fold and selects the text in the real control, rather
  // than counting a hit nobody can see (the §9a.22 failure, in the fold that hides titles).
  await evaluate(cdp, `wbFindGo('books', 1)`);
  await waitFor(cdp, `!!document.activeElement && document.activeElement.tagName === 'INPUT'`, 5000);
  const titleSel = await evaluate(
    cdp,
    `(() => {
        const t = document.activeElement;
        if(!t || t.tagName !== 'INPUT') return {ok: false, tag: t && t.tagName};
        const lab = t.closest('.wbsf');
        return {ok: true, name: lab && lab.dataset.name,
                picked: String(t.value).slice(t.selectionStart, t.selectionEnd),
                foldOpen: !t.closest('.wbsetbody:not(.wbkeysbody)').hasAttribute('hidden')};
    })()`,
  );
  ok(
    titleSel.ok && titleSel.name === 'comment' && titleSel.picked === 'Sample Entry 1' && titleSel.foldOpen,
    `stepping to a title hit opens the settings fold and selects it in the Title control ` + `(${JSON.stringify(titleSel)})`,
  );

  await evaluate(cdp, `wbFindClose('books')`);
  ok(await evaluate(cdp, `document.querySelector('#wbFind_books').style.display === 'none'`), 'and it closes again');
}

// ── §9a.31: the entry accordion ──────────────────────────────────────────────
//
// Opening a book leaves the first entry open and the remaining entries collapsed.
//
// 🔴 THIS IS A BROWSER TEST BECAUSE EVERY CLAIM IN IT IS ABOUT LAYOUT AND EVENTS. Whether a
// `<textarea>` is actually not rendered, whether a click on a header reaches the checkbox or the
// fold, and whether Find can still land on a hit inside a closed row are all questions a source
// grep answers with a guess. The header change in particular — `<label>` to `<div>` — is invisible
// to every other kind of test and is the entire mechanism of the request.
//
// Its own four-entry book, deleted at the end: the §8.2 blocks below count the Library.
{
  const ACC = {
    name: 'Accordion probe',
    entries: {
      0: {
        uid: 0,
        key: ['alpha'],
        comment: 'Alpha',
        constant: false,
        order: 100,
        disable: false,
        content: 'The first entry, which opens by default.',
      },
      1: {
        uid: 1,
        key: ['beta'],
        comment: 'Beta',
        constant: false,
        order: 100,
        disable: false,
        content: 'The second entry, shut until he asks for it.',
      },
      2: {
        uid: 2,
        key: ['gamma'],
        comment: 'Gamma',
        constant: false,
        order: 100,
        disable: false,
        content: 'The third entry, holding the word quokka.',
      },
      3: {
        uid: 3,
        key: ['delta'],
        comment: 'Delta',
        constant: false,
        order: 100,
        disable: false,
        content: 'The fourth entry.',
      },
    },
  };
  const accId = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({document: ${JSON.stringify(ACC)}, name: 'Accordion probe'})});
        return (await r.json()).id;
    })()`,
  );
  await evaluate(cdp, `wbOpen('books', '${accId}', 0)`);
  await mustWait(cdp, `wbState('books').rev?.n === 0`, 'the accordion probe opens at revision 0');

  // The state a freshly selected book is born in. Asserted on OFFSETHEIGHT, not on the class:
  // a class that is set while the CSS rule is missing or misspelled is a fold that does not
  // fold, and the whole complaint was about the height of the page.
  const born = await evaluate(
    cdp,
    `(() => {
        const rows = [...document.querySelectorAll('#wbFields_books .wbfield')];
        return {n: rows.length,
                shut: rows.map(r => r.classList.contains('wbshut')),
                tall: rows.map(r => r.querySelector('.wbtext').offsetHeight > 0)};
    })()`,
  );
  ok(
    born.n === 4 && born.shut.join() === 'false,true,true,true',
    `selecting a World Book opens the first entry and collapses the rest (${born.shut.join()})`,
  );
  ok(
    born.tall.join() === 'true,false,false,false',
    `and the collapsed bodies are really off the page, not merely class-marked (${born.tall.join()})`,
  );

  // 🔴 The fold hides the body; it never edits it. A "collapse" that dropped the text would be
  // a data-loss bug wearing a view feature's clothes, and Save would write the truncation.
  ok(
    await evaluate(
      cdp,
      `[...document.querySelectorAll('#wbFields_books .wbtext')]
            .every(t => t.value.length > 0)`,
    ),
    'a collapsed entry still holds its full text — the fold is a view, never a truncation',
  );

  // Use a fold-control header instead of a label, which forwards clicks to its wrapped checkbox.
  const headTag = await evaluate(cdp, `document.querySelector('#wbFields_books .wbhead').tagName`);
  ok(headTag === 'DIV', `an entry header is a fold control rather than a label wrapping its checkbox (${headTag})`);
  ok(
    await evaluate(cdp, `!!document.querySelector('#wbFields_books .wbhead .wbcar')`),
    'and it carries a twisty saying which way the row will go',
  );

  // Use SillyTavern's mode glyph and place the dot before the entry title; the browser verifies its rendered order.
  const dot = await evaluate(
    cdp,
    `(() => {
        const row = document.querySelector('#wbFields_books .wbfield');
        const kids = [...row.querySelector('.wbhead').children];
        const d = kids.findIndex(k => k.classList.contains('wbdot'));
        const b = kids.findIndex(k => k.tagName === 'B');
        return {d, b, glyph: d >= 0 ? kids[d].textContent.trim() : '',
                tip: d >= 0 ? (kids[d].getAttribute('title') || '') : ''};
    })()`,
  );
  ok(dot.d >= 0 && dot.b >= 0 && dot.d < dot.b, `the injection-mode dot sits LEFT of the entry title (dot at ${dot.d}, title at ${dot.b})`);
  ok(dot.glyph === '🟢', `and it is SillyTavern's own glyph for the mode, not ours (${dot.glyph})`);
  ok(/keyword/i.test(dot.tip), `with the tooltip still carrying the only explanation of what the mode means (${dot.tip.slice(0, 40)})`);

  // A real click, dispatched at the header — not a call to the toggle function. The function
  // working while the binding is missing is exactly the failure this block exists to catch.
  await evaluate(cdp, `document.querySelectorAll('#wbFields_books .wbhead')[0].click()`);
  await waitFor(cdp, `document.querySelectorAll('#wbFields_books .wbfield')[0].classList.contains('wbshut')`, 5000);
  ok(
    await evaluate(cdp, `document.querySelectorAll('#wbFields_books .wbfield')[0].classList.contains('wbshut')`),
    'clicking an entry title bar collapses that entry',
  );
  await evaluate(cdp, `document.querySelectorAll('#wbFields_books .wbhead')[0].click()`);
  await waitFor(cdp, `!document.querySelectorAll('#wbFields_books .wbfield')[0].classList.contains('wbshut')`, 5000);
  ok(
    await evaluate(cdp, `!document.querySelectorAll('#wbFields_books .wbfield')[0].classList.contains('wbshut')`),
    'and clicking it again opens it back up',
  );

  // The checkbox toggles selection without folding its row; the header handler must exempt it.
  const tick = await evaluate(
    cdp,
    `(() => {
        const row = document.querySelectorAll('#wbFields_books .wbfield')[0];
        const c = row.querySelector('.wbtick');
        const was = c.checked;
        c.click();
        return {flipped: c.checked !== was, shut: row.classList.contains('wbshut')};
    })()`,
  );
  ok(tick.flipped && !tick.shut, `clicking the checkbox ticks the entry and does NOT fold it (${JSON.stringify(tick)})`);
  await evaluate(cdp, `document.querySelector('#wbAll_books').click()`);

  // The two bulk controls.
  await evaluate(cdp, `document.querySelector('#wbCollapseAll_books').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('#wbFields_books .wbfield')].every(r => r.classList.contains('wbshut'))`, 5000);
  ok(
    await evaluate(
      cdp,
      `[...document.querySelectorAll('#wbFields_books .wbfield')]
            .every(r => r.classList.contains('wbshut'))`,
    ),
    'collapse all closes every entry, including the one that opened by default',
  );

  // 🔴 §9a.21's rule, and the reason it is checked HERE: collapsing is a view operation and it
  // must never change what a pass would include. I13 quietly became a rule about eyesight once
  // already; a hidden entry that stops being sent is a pass silently doing less than it says.
  const passOn = await evaluate(
    cdp,
    `(() => {
        const rows = [...document.querySelectorAll('#wbFields_books .wbfield')];
        return {ticked: rows.filter(r => r.querySelector('.wbtick').checked).length,
                total: rows.length};
    })()`,
  );
  ok(
    passOn.ticked === passOn.total && passOn.total === 4,
    `every collapsed entry is still ticked and still included in a pass (${passOn.ticked}/${passOn.total})`,
  );

  await evaluate(cdp, `document.querySelector('#wbExpandAll_books').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('#wbFields_books .wbfield')].every(r => !r.classList.contains('wbshut'))`, 5000);
  ok(
    await evaluate(
      cdp,
      `[...document.querySelectorAll('#wbFields_books .wbfield')]
            .every(r => !r.classList.contains('wbshut'))`,
    ),
    'expand all opens every one of them again',
  );

  // 🔴 A COLLAPSED ENTRY WITH UNSAVED EDITS MUST STILL OFFER SAVE. The row is hidden, the edit
  // is not: a Save control that vanished when he folded the row would leave him no way to commit
  // an edit he had already made, which is the m5g failure in a new fold.
  await evaluate(
    cdp,
    `(() => {
        const t = document.querySelectorAll('#wbFields_books .wbtext')[2];
        t.value = t.value + ' EDITED'; t.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelectorAll('#wbFields_books .wbfield')[2].classList.contains('wbdirty')`, 5000);
  await evaluate(cdp, `document.querySelector('#wbCollapseAll_books').click()`);
  await waitFor(cdp, `document.querySelectorAll('#wbFields_books .wbfield')[2].classList.contains('wbshut')`, 5000);
  const dirty = await evaluate(
    cdp,
    `(() => {
        const row = document.querySelectorAll('#wbFields_books .wbfield')[2];
        return {marked: row.classList.contains('wbdirty'),
                shut: row.classList.contains('wbshut'),
                save: document.querySelector('#wbSaveWrap_books').style.display !== 'none',
                after: getComputedStyle(row.querySelector('.wbhead'), '::after').content};
    })()`,
  );
  ok(dirty.shut && dirty.marked && dirty.save, `an edited entry that is then collapsed still offers Save (${JSON.stringify(dirty)})`);
  ok(/unsaved/.test(dirty.after), `and its collapsed header says it is unsaved rather than looking idle (${dirty.after})`);

  // 🔴 §9a.22 AGAIN, IN THE NEW FOLD. "FIND SEARCHED ENTRIES HE COULD NOT SEE" is the record of
  // this precise class of bug, and every fold added afterward re-opens it. `quokka` is in the
  // THIRD entry's body only, and every entry is collapsed at this point.
  await evaluate(cdp, `wbFindOpen('books')`);
  await evaluate(
    cdp,
    `(() => {
        const q = document.querySelector('#wbFindQ_books');
        q.value = 'quokka'; q.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbFindCount_books').textContent.includes('of ')`, 5000);
  ok(
    /of [1-9]/.test(await evaluate(cdp, `document.querySelector('#wbFindCount_books').textContent`)),
    'Find still searches the bodies of collapsed entries',
  );
  await evaluate(cdp, `wbFindGo('books', 1)`);
  await waitFor(cdp, `!!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.wbfield'))`, 5000);
  const landed = await evaluate(
    cdp,
    `(() => {
        const t = document.activeElement;
        const row = t && t.closest && t.closest('.wbfield');
        return {tag: t && t.tagName, shut: !!row && row.classList.contains('wbshut'),
                visible: !!t && t.offsetHeight > 0,
                picked: t && t.value ? t.value.slice(t.selectionStart, t.selectionEnd) : ''};
    })()`,
  );
  ok(
    landed.tag === 'TEXTAREA' && !landed.shut && landed.visible && landed.picked === 'quokka',
    `and stepping onto a match OPENS the collapsed entry it is in (${JSON.stringify(landed)})`,
  );
  await evaluate(cdp, `wbFindClose('books')`);

  // 🔴 §9a.29a MEETS §9a.31, AND §9a.35 CHANGED WHAT "ON SCREEN" MEANS. A refused keyless entry
  // used to have its Keywords box inside the ⚙ fold, so the refusal had to open the fold as well
  // as un-shut the row. Keywords now sit ABOVE the fold and are always built — so what has to be
  // proved here is that un-shutting the accordion is now SUFFICIENT: the control the refusal is
  // about is visible without opening anything. Driven through the real marking function with a
  // real locator, because the interaction is the thing at risk.
  await evaluate(cdp, `document.querySelector('#wbCollapseAll_books').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('#wbFields_books .wbfield')].every(r => r.classList.contains('wbshut'))`, 5000);
  const refused = await evaluate(
    cdp,
    `(() => {
        const st = wbState('books');
        const f = st.fields.find(x => !!x.entry);
        wbMarkKeyless('books', [{entry: f.entry}]);
        const row = [...document.querySelectorAll('#wbFields_books .wbfield')]
            .find(r => r.classList.contains('wbkeyless'));
        const kb = row && row.querySelector('.wbkeysbody');
        return {found: !!row, shut: !!row && row.classList.contains('wbshut'),
                setVisible: !!row && row.querySelector('.wbset').offsetHeight > 0,
                keyVisible: !!kb && kb.offsetHeight > 0,
                keyControl: !!kb && !!kb.querySelector('.wbsf[data-name="key"]'),
                foldStillShut: !!row && row.querySelector('.wbsetbody:not(.wbkeysbody)').hasAttribute('hidden')};
    })()`,
  );
  ok(
    refused.found && !refused.shut && refused.setVisible,
    `a refused keyless entry is OPENED, not marked red behind a fold (${JSON.stringify(refused)})`,
  );
  // 🔴 §9a.35 — THE CONTROL THE REFUSAL IS ABOUT IS ON SCREEN, and it is the keywords box rather
  // than the ⚙ button beside it. This is the assertion the old one was standing in for.
  ok(
    refused.keyVisible && refused.keyControl,
    `…and the Primary keywords box itself is visible on the refused row (${JSON.stringify(refused)})`,
  );
  // ⚠️ AND THE FOLD IS NOT DRAGGED OPEN TO GET THERE. Opening it would dump 38 controls under
  // every refused entry to reveal one that was already showing — the page-height cost §9a.31
  // exists to avoid, paid for nothing.
  ok(refused.foldStillShut, 'and the ⚙ fold is left alone — nothing had to be opened to show it');

  // 🔴 §9a.29's PASSIVE marker, on a book that ARRIVED broken. §9a.29a's red refusal only speaks
  // when he presses Save; this has to speak while he is merely reading, which is the only moment
  // an imported-keyless entry is discoverable at all.
  const inertId = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({name: 'Inert probe', document: {entries: {
                '0': {uid: 0, comment: 'Dead', content: 'Stored, shown, never fired.'},
                '1': {uid: 1, key: ['guild'], comment: 'Alive', content: 'This one fires.'},
                '2': {uid: 2, constant: true, comment: 'Always', content: 'Every prompt.'}}}})});
        return (await r.json()).id;
    })()`,
  );
  await evaluate(cdp, `wbOpen('books', '${inertId}', 0)`);
  await mustWait(cdp, `wbState('books').openId === ${JSON.stringify(inertId)}`, 'a book holding a keyless entry opens');
  const marked = await evaluate(
    cdp,
    `(() => {
        const st = wbState('books');
        const rows = [...document.querySelectorAll('#wbFields_books .wbfield')];
        const at = label => rows.find(r => (st.fields[+r.dataset.i] || {}).label === label);
        const read = r => r ? {inert: r.classList.contains('wbinert'),
                               tag: !!r.querySelector('.wbinerttag')} : null;
        return {dead: read(at('Dead')), alive: read(at('Alive')), always: read(at('Always'))};
    })()`,
  );
  ok(
    marked.dead && marked.dead.inert && marked.dead.tag,
    `a keyless entry is marked inert on sight, without pressing Save (${JSON.stringify(marked.dead)})`,
  );
  // 🔴 The exemptions matter more than the marking: a blanket "every entry needs a keyword"
  // would paint every legitimate always-on entry as broken.
  ok(
    marked.alive && !marked.alive.inert && marked.always && !marked.always.inert,
    `and a keyed entry and an always-injected one are left alone (${JSON.stringify(marked)})`,
  );
  await evaluate(
    cdp,
    `(async () => { await fetch('/wbedit/documents/${inertId}',
        {method:'DELETE'}); })()`,
  );

  // A document with no entries has no accordion, so it must not carry the controls for one —
  // the dead-control-over-an-empty-book screen can make Add entry appear broken.
  const emptyId = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({document: {name: 'No entries probe', entries: {}},
                                  name: 'No entries probe'})});
        return (await r.json()).id;
    })()`,
  );
  await evaluate(cdp, `wbOpen('books', '${emptyId}', 0)`);
  await mustWait(cdp, `wbState('books').openId === ${JSON.stringify(emptyId)}`, 'the entry-less probe opens');
  ok(
    await evaluate(
      cdp,
      `document.querySelector('#wbExpandAll_books').style.display === 'none'
                         && document.querySelector('#wbCollapseAll_books').style.display === 'none'`,
    ),
    'a book with no entries hides the expand and collapse controls rather than offering dead ones',
  );
  // §9a.28 item 2 — the mode filter goes with them. A filter offering four modes over ZERO
  // entries, sitting directly above "no editable fields", is the empty state that can look broken.
  ok(
    await evaluate(cdp, `document.querySelector('#wbEntryModeWrap_books').style.display === 'none'`),
    'and it hides the injection-mode filter too — four modes over zero entries is a dead control',
  );
  // 🔴 §9a.28 item 3 — and the empty state names the control that fixes it. "This document has
  // no editable fields" is CORRECT about an empty book and tells him nothing.
  const emptySaid = await evaluate(cdp, `document.querySelector('#wbFields_books').textContent`);
  ok(
    /no entries yet/.test(emptySaid) && /Add entry/.test(emptySaid),
    `an empty World Book says so and points at Add entry (${emptySaid.trim().slice(0, 70)})`,
  );

  await evaluate(
    cdp,
    `(async () => {
        await fetch('/wbedit/documents/${accId}', {method:'DELETE'});
        await fetch('/wbedit/documents/${emptyId}', {method:'DELETE'});
    })()`,
  );
  await evaluate(cdp, `wbOpen('books', '${docId}', 0)`);
  await mustWait(cdp, `wbState('books').rev?.n === 0`, 'the probes are deleted and Sample World Book 1 is back on screen');
}

// ── §9a.27 / §9a.30: Save as new revision on the top line, with a spinner ────
//
// Save as new revision is available beside Save to SillyTavern at the top and shows a spinner during the write.
//
// 🔴 THE SPEC CLICKS THE TOP BUTTON. Clicking the bottom one would prove nothing about the new
// control, which is the whole milestone.
{
  await evaluate(cdp, `wbOpen('books', '${docId}', wbState('books').doc.latest)`);
  await mustWait(cdp, `wbState('books').fields?.length > 0`, 'Sample World Book 1 is open at its latest revision for the top-line Save');

  const geom = await evaluate(
    cdp,
    `(() => {
        const top = document.querySelector('#wbSaveTop_books');
        const send = document.querySelector('#wbSend_books');
        if(!top || !send) return {ok: false};
        const a = top.getBoundingClientRect(), b = send.getBoundingClientRect();
        return {ok: true, left: a.right <= b.left + 1, sameRow: Math.abs(a.top - b.top) < 6,
                primary: top.className.includes('primary'), disabled: top.disabled};
    })()`,
  );
  ok(
    geom.ok && geom.left && geom.sameRow,
    `Save as new revision sits on the top line, left of Save to SillyTavern (${JSON.stringify(geom)})`,
  );
  // 📌 "Blue" is the existing `.primary` class the bottom button already wears — a second
  // trigger for a control that exists, not a new color decision.
  ok(geom.primary, 'and it wears the same primary blue as the one at the bottom');
  // 🔴 DISABLED WHEN CLEAN, NEVER HIDDEN. Hiding it would shift the whole row sideways the
  // moment a document goes dirty, moving Save to SillyTavern under the cursor.
  ok(geom.disabled === true, 'it is DISABLED on a clean document rather than hidden, so the row never moves');

  await evaluate(
    cdp,
    `(() => {
        const t = document.querySelector('#wbFields_books .wbtext');
        t.value = t.value + ' TOPSAVE'; t.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  await waitFor(cdp, `document.querySelector('#wbSaveTop_books').disabled === false`, 5000);
  ok(await evaluate(cdp, `document.querySelector('#wbSaveTop_books').disabled === false`), 'and it enables on the first keystroke');

  const before = await evaluate(cdp, `wbState('books').doc.latest`);
  await evaluate(cdp, `document.querySelector('#wbSaveTop_books').click()`);
  await mustWait(cdp, `wbState('books').doc?.latest === ${before + 1}`, 'clicking the TOP button mints a new revision');
  // 🔴 ONE HANDLER, NOT A COPY. If the top button had its own save path, the bottom wrap would
  // still be showing an edit that has already been saved.
  // 🔴 WAIT FOR THE REPAINT, NOT JUST FOR THE STATE. `mustWait` above returns the instant
  // `doc.latest` increments — that is the STORE. Hiding the bottom wrap is a DOM write that
  // happens in the render pass after it, so reading `style.display` on the next line races the
  // repaint and loses under load. It failed exactly once in a 16-worker run and passes alone,
  // which is this repo's documented signature for a spec that measures too early rather than a
  // feature that is broken.
  ok(
    await waitFor(cdp, `document.querySelector('#wbSaveWrap_books').style.display === 'none'`, 5000),
    'and it clears the shared dirty state, so both controls are wired to one handler',
  );
  ok(
    await evaluate(cdp, `document.querySelector('#wbSaveTop_books').disabled === true`),
    'the top button goes back to disabled once there is nothing left to save',
  );

  // §9a.30 — the spinner and the disable are one change, driven straight at the helper so the
  // in-flight state is observable without racing a real 2-second request.
  const busy = await evaluate(
    cdp,
    `(() => {
        const top = document.querySelector('#wbSaveTop_books');
        const bot = document.querySelector('#wbSave_books');
        wbSaveBusy('books', true, top);
        const mid = {topSpins: top.innerHTML.includes('spin'), topOff: top.disabled,
                     botOff: bot.disabled, botSpins: bot.innerHTML.includes('spin')};
        wbSaveBusy('books', false, top);
        return {mid, restored: top.innerHTML, botBack: bot.innerHTML};
    })()`,
  );
  ok(busy.mid.topSpins && busy.mid.topOff, `the pressed button turns into a spinner and is disabled (${JSON.stringify(busy.mid)})`);
  // 🔴 Two seconds of a live button is two seconds in which a second click mints a SECOND
  // revision — so BOTH triggers go dead, not only the one he pressed.
  ok(busy.mid.botOff && !busy.mid.botSpins, 'the other trigger is disabled too, but does not spin — it is one action, not two');
  ok(
    /Save as new revision/.test(busy.restored) && /Save as new revision/.test(busy.botBack),
    `and both captions come back afterward, so a failed save leaves no stuck spinner (${busy.restored})`,
  );
}

// ── the Assemble control is on World Books and not on Character Cards ────────
ok(await evaluate(cdp, `!!document.querySelector('#wbAssembleBtn_books')`), 'World Books offers "Assemble sections…" (§6.5)');
ok(await evaluate(cdp, `!document.querySelector('#wbAssembleBtn_cards')`), '…and Character Cards does not — a card has no sections');
ok(
  await evaluate(cdp, `document.querySelector('#wbFile_cards').accept.includes('.png')`),
  'the card importer accepts a .png — a character card IS a PNG (§4.3.1)',
);

// ── avatars on screen (§4.3, m2a) ────────────────────────────────────────────
//
// 🔴 THE CIRCLE IS CUT IN THE BROWSER, SO ONLY A BROWSER CAN TELL YOU IT IS CUT RIGHT. The route
// tests prove the bytes come back verbatim; they cannot see whether `wbFitFace` ran, whether it
// used the focus rect or silently fell back to centering, or whether the box is round. A card is
// built here rather than fetched so the source dimensions are known and the arithmetic below is
// an equality rather than a "looks plausible".
{
  // A REAL, DECODABLE 400×600 PNG from a canvas, with a `chara` chunk spliced in before IEND.
  // Non-square on purpose: with a square source every branch of the math gives the same
  // answer, and a fallback-to-centered bug would pass.
  const CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Test Character 2',
      description: 'A tall woman who keeps her own counsel.',
      personality: 'Wry.',
      first_mes: 'You again.',
      extensions: { taproom_avatar_focus: { x: 0.1, y: 0.2, w: 0.5 } },
    },
  };
  const built = await evaluate(
    cdp,
    `(async () => {
        const T = (() => { const t = [];
            for (let n = 0; n < 256; n++) { let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                t[n] = c >>> 0; } return t; })();
        const crc = b => { let c = 0xFFFFFFFF;
            for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
            return (c ^ 0xFFFFFFFF) >>> 0; };
        const cv = document.createElement('canvas');
        cv.width = 400; cv.height = 600;
        const g = cv.getContext('2d');
        g.fillStyle = '#345'; g.fillRect(0, 0, 400, 600);
        g.fillStyle = '#fc0'; g.fillRect(40, 120, 200, 200);   // where the focus rect points
        const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
        const src = new Uint8Array(await blob.arrayBuffer());
        const payload = new TextEncoder().encode('chara\\0' + btoa(JSON.stringify(${JSON.stringify(CARD)})));
        const chunk = new Uint8Array(12 + payload.length);
        const dv = new DataView(chunk.buffer);
        dv.setUint32(0, payload.length);
        chunk.set(new TextEncoder().encode('tEXt'), 4);
        chunk.set(payload, 8);
        dv.setUint32(8 + payload.length, crc(chunk.subarray(4, 8 + payload.length)));
        const out = new Uint8Array(src.length + chunk.length);       // splice before IEND
        out.set(src.subarray(0, src.length - 12), 0);
        out.set(chunk, src.length - 12);
        out.set(src.subarray(src.length - 12), src.length - 12 + chunk.length);

        const fd = new FormData();
        fd.append('file', new Blob([out], {type: 'image/png'}), 'Test Character 2.png');
        const r = await fetch('/wbedit/documents', {method: 'POST', body: fd});
        const j = await r.json();
        // …and a second card with no picture at all, to prove the placeholder path. Its NAME is
        // changed on the card itself, not in the request: a card's own name wins over the
        // filename, so passing \`name\` here would be ignored and the initial would be an S.
        const plainCard = ${JSON.stringify(CARD)};
        plainCard.data = {...plainCard.data, name: 'Plain Test Character 2'};
        const r2 = await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: plainCard})});
        return {id: j.id, avatar: j.avatar, plain: (await r2.json()).id};
    })()`,
  );
  ok(built.avatar === true, 'a PNG card imports and the server says it brought a picture');

  await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].find(b => b.dataset.sttab === 'cards').click()`);
  await evaluate(cdp, `wbLoadLib('cards')`);
  // 🔴 BY id, NEVER "the first .wbface" — the roster also holds the pictureless card, and
  // whichever the store lists first is not ours to assume.
  const faceSel = `#wbLib_cards .wbface[data-id="${built.id}"]`;
  ok(
    await waitFor(
      cdp,
      `document.querySelector('${faceSel} img')?.complete
                           && document.querySelector('${faceSel} img').naturalWidth > 0`,
    ),
    'the Library roster renders a face, and it decodes',
  );

  const face = await evaluate(
    cdp,
    `(() => {
        const box = document.querySelector('${faceSel}'), img = box.querySelector('img');
        const bs = getComputedStyle(box), is = getComputedStyle(img);
        return {radius: bs.borderRadius, overflow: bs.overflow,
                boxW: box.clientWidth, boxH: box.clientHeight,
                natW: img.naturalWidth, natH: img.naturalHeight,
                fitted: img.classList.contains('wbfit'),
                w: is.width, h: is.height, left: is.left, top: is.top};
    })()`,
  );
  // 🔴 COMPUTED STYLE, NOT THE CLASS — 6.3's scar: a class-only assertion passed while the
  // theme killed the rule with !important, and nothing painted.
  ok(face.radius === '50%' && face.overflow === 'hidden', `the face is a circle that clips (${face.radius}, ${face.overflow})`);
  ok(face.boxW === 40 && face.boxH === 40, `and it is square, 40×40 (${face.boxW}×${face.boxH})`);
  // 🔴 m4p / §9a.10 MOVED THE CROP TO THE SERVER, AND THIS CHECK MOVED WITH IT RATHER THAN
  // BEING DELETED. It used to read `natW === 400 && natH === 600` and then assert four computed
  // offsets, because the roster fetched the whole card and `wbFitFace` cut it. The roster now
  // fetches a 96 px crop that is already the circle's content, so the source is square and the
  // offsets are the identity. **The property being defended has not changed** — the circle must
  // show the focus rect and not the largest centered square — so it is asserted twice below, once
  // harder than the original could: in PIXELS.
  ok(face.natW === 96 && face.natH === 96, `the roster face is the 96px server crop, not the 400×600 card (${face.natW}×${face.natH})`);
  ok(face.fitted, 'wbFitFace ran on load');
  // 🔴 THE NO-DOUBLE-CROP ASSERTION. With no `data-focus`, wbFitFace takes the largest centered
  // square of a square image — which is all of it — so the geometry is the identity. If someone
  // re-adds `data-focus` to this path, the server crop gets cropped again and these go to
  // 80/80/−8/−8: the circle would show a corner of the face.
  ok(
    face.w === '40px' && face.h === '40px' && face.left === '0px' && face.top === '0px',
    `and it is not cropped a second time (${face.w} ${face.h} ${face.left} ${face.top})`,
  );
  // 🔴 AND THE CROP REALLY IS AT THE RECT — PROVEN IN PIXELS, WHICH THE GEOMETRY VERSION COULD
  // ONLY IMPLY. The fixture paints #fc0 at exactly (40,120,200,200), which is where
  // {x:0.1, y:0.2, w:0.5} points on a 400×600 card. Center the thumbnail on anything else and
  // this reads the #345 background instead.
  const pix = await evaluate(
    cdp,
    `(() => {
        const img = document.querySelector('${faceSel} img');
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        const d = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data;
        return {r: d[0], g: d[1], b: d[2]};
    })()`,
  );
  ok(
    pix.r > 200 && pix.g > 140 && pix.b < 90,
    `the server cut it at the focus rect, not the center (rgb ${pix.r},${pix.g},${pix.b} — want ~255,204,0)`,
  );

  // 🔴 AND THE ORIGINAL FOUR NUMBERS STILL MATTER, on the path that still does client-side
  // cropping: the §9a.10 fallback. This is the same assertion this block has always made, moved
  // to where `wbFitFace` is still the thing doing the work — so m4o's protection is intact.
  //
  // side = 0.5·400 = 200 → k = 40/200 = 0.2. width 80, height 120, left −8, top −24. If the rect
  // were ignored and the largest centered square used instead, this would be 40/60/0/−10 — a
  // different answer in all four numbers.
  const backOff = await evaluate(
    cdp,
    `(async () => {
        const box = document.querySelector('${faceSel}'), img = box.querySelector('img');
        wbFaceFallback(img);
        // The wait IS the load event; the timer is only a bound on a hang, and 4 s was a bound a
        // loaded box could meet with the image still arriving (then naturalWidth is 0 below).
        await new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 20000); });
        wbFitFace(img);
        const is = getComputedStyle(img);
        return {src: img.getAttribute('src'), natW: img.naturalWidth, natH: img.naturalHeight,
                w: is.width, h: is.height, left: is.left, top: is.top};
    })()`,
  );
  ok(
    // 9.7.7 — `split('?')`: the fallback URL carries the avatar's stamp now, for the reason the
    // roster's does. The four numbers below are what this check is about and they are untouched.
    backOff.src.split('?')[0].endsWith('/avatar') && backOff.natW === 400 && backOff.natH === 600,
    `the fallback fetches the whole 400×600 card (${backOff.src} ${backOff.natW}×${backOff.natH})`,
  );
  ok(
    backOff.w === '80px' && backOff.h === '120px' && backOff.left === '-8px' && backOff.top === '-24px',
    `and the browser cuts it at the focus rect, not centered (${backOff.w} ${backOff.h} ${backOff.left} ${backOff.top})`,
  );

  const plain = await evaluate(
    cdp,
    `(() => {
        const box = document.querySelector('#wbLib_cards .wbface[data-id="${built.plain}"]');
        return {found: !!box, img: !!box?.querySelector('img'),
                initial: box?.querySelector('.wbinitial')?.textContent};
    })()`,
  );
  ok(
    plain.found && !plain.img && plain.initial === 'P',
    `a card with no picture gets its initial, never a stand-in face (${plain.initial})`,
  );

  // Avoid lazy loading Library faces; request them at high priority and keep the initial visible while they load.
  //
  // Library faces are prominent content; the browser checks that they are fetched at high priority.
  {
    const face = await evaluate(
      cdp,
      `(() => {
        const img = document.querySelector('#wbLib_cards .wbface img')
                 || document.querySelector('#wbLib_books .wbface img');
        if(!img) return {none: true};
        return {lazy: img.getAttribute('loading'),
                priority: img.getAttribute('fetchpriority'),
                initial: (img.parentNode.querySelector('.wbinitial') || {}).textContent || ''};
    })()`,
    );
    if (!face.none) {
      ok(face.lazy !== 'lazy', `a Library face is not lazy-loaded (loading=${face.lazy})`);
      ok(face.priority === 'high', `and it is fetched at high priority (${face.priority})`);
      // The letter underneath is what stops a still-downloading face reading as "no picture".
      ok(face.initial.trim().length === 1, `a face carries its initial underneath the picture (${JSON.stringify(face.initial)})`);
    }
  }

  // The Editor's big image: the WHOLE card, uncropped.
  await evaluate(cdp, `document.querySelector('#wbLib_cards .wbopen[data-id="${built.id}"]').click()`);
  ok(
    await waitFor(cdp, `document.querySelector('#wbCard_cards')?.naturalWidth > 0`),
    'opening the card shows the big picture beside the fields',
  );
  const big = await evaluate(
    cdp,
    `(() => {
        const img = document.querySelector('#wbCard_cards');
        return {wrap: document.querySelector('#wbCardWrap_cards').style.display,
                natW: img.naturalWidth, natH: img.naturalHeight,
                objectFit: getComputedStyle(img).objectFit};
    })()`,
  );
  ok(
    big.natW === 400 && big.natH === 600 && big.objectFit === 'fill',
    'and it is the whole card — the rect describes the circle, not the picture',
  );

  // ── items 9/10: clicking the picture toggles it to full size ─────────────
  //
  // Check rendered width rather than a CSS class so the test proves the click handler is wired.
  const shrunk = await evaluate(cdp, `document.querySelector('#wbCard_cards').getBoundingClientRect().width`);
  await evaluate(cdp, `document.querySelector('#wbCard_cards').click()`);
  await waitFor(cdp, `document.querySelector('#wbCard_cards').getBoundingClientRect().width > ${shrunk}`, 5000);
  const zoomed = await evaluate(cdp, `document.querySelector('#wbCard_cards').getBoundingClientRect().width`);
  ok(zoomed > shrunk, `clicking the card picture actually makes it bigger (${Math.round(shrunk)}px → ${Math.round(zoomed)}px)`);
  // ⚠️ `getBoundingClientRect` is the BORDER box and `.wbcard` carries a 1px border, so the
  // honest comparison is natural width plus 2 — not equality. Asserting equality here failed at
  // 402 vs 400 and said "never an upscale" about a picture that was exactly its own size.
  ok(
    Math.abs(zoomed - big.natW) <= 4,
    `and "full size" means the PNG's own pixels, never an upscale (${Math.round(zoomed)} vs ${big.natW} + border)`,
  );

  // The same click puts it back — one control, both directions, like the Library row.
  await evaluate(cdp, `document.querySelector('#wbCard_cards').click()`);
  await waitFor(cdp, `Math.round(document.querySelector('#wbCard_cards').getBoundingClientRect().width) === ${Math.round(shrunk)}`, 5000);
  ok(
    Math.round(await evaluate(cdp, `document.querySelector('#wbCard_cards').getBoundingClientRect().width`)) === Math.round(shrunk),
    'and clicking it again shrinks it back',
  );

  // 🔴 The <img> is REUSED across documents, so a zoom left on must not follow the next
  // character in. Same reused-element hazard the stale-src note records.
  await evaluate(cdp, `document.querySelector('#wbCard_cards').click()`); // leave it zoomed
  await waitFor(cdp, `document.querySelector('#wbCard_cards').classList.contains('wbfull')`, 5000);
  await evaluate(cdp, `wbOpen('cards', '${built.id}')`);
  await mustWait(
    cdp,
    `document.querySelector('#wbCard_cards')?.naturalWidth > 0`,
    'the card picture decodes again before the zoom is measured',
  );
  ok(
    !(await evaluate(cdp, `document.querySelector('#wbCard_cards').classList.contains('wbfull')`)),
    'opening another document opens it shrunk, not at whatever zoom the last one was left at',
  );

  // Reopening a document WITHOUT a picture must not leave the previous character's face up.
  //
  // 🔴 9.5.12 REWROTE WHAT THIS READS, AND THE REWRITE IS THE POINT. It used to assert the stale
  // face was gone by checking that the WRAP was `display:none` — which was true, and was also the
  // line that hid ⬆ Upload PNG on every document that had no picture yet. So the spec would have
  // gone RED on the fix and GREEN on the bug: a protection asserted through an implementation
  // detail pins the detail, not the protection. What was actually being protected is that no
  // stale face is on screen, and that is now asserted directly — the <img> is out of the flow and
  // carries no src — while the wrap stays up so the upload control can be reached.
  await evaluate(cdp, `wbOpen('cards', '${built.plain}')`);
  ok(
    await waitFor(
      cdp,
      `!document.querySelector('#wbCard_cards').offsetParent
                           && !document.querySelector('#wbCard_cards').getAttribute('src')`,
    ),
    'reopening a pictureless card clears the big image rather than keeping a stale face',
  );
  ok(
    await evaluate(cdp, `!!document.getElementById('wbPicUpload_cards').offsetParent`),
    '…and ⬆ Upload PNG is on screen for it, which is how a card imported as JSON gets a face at all',
  );
}

// ── ⬇ Export (§6.3.2, m3) ────────────────────────────────────────────────────
//
// The button is a plain navigation, so a click here would make the headless browser download a
// file rather than tell us anything. What only a browser can answer is whether the control is
// wired to the OPEN revision — the route tests prove the server honors `?revision=`, and this
// proves the UI asks for the right one. #wbCard_cards is still showing the pictureless card from
// the block above, so reopen the one with a face first.
{
  ok(
    await evaluate(cdp, `!!document.querySelector('#wbExport_cards') && !!document.querySelector('#wbExport_books')`),
    'both sub-tabs offer ⬇ Export',
  );
  await evaluate(cdp, `wbOpen('books', '${docId}', 0)`);
  await mustWait(cdp, `wbState('books').rev?.n === 0`, 'the Export block opens Sample World Book 1 at revision 0');

  // ⚠️ `window.location` CANNOT BE REDEFINED in Chrome, so the navigation is watched from
  // outside the page instead of stubbed inside it. That is the better test anyway: it observes
  // the request the browser actually made, not one a stub agreed to record.
  const requested = [];
  cdp.on(m => {
    if (m.method === 'Network.requestWillBeSent') requested.push(m.params.request.url);
  });
  await cdp.send('Network.enable');
  await evaluate(cdp, `document.querySelector('#wbExport_books').click()`);
  // 🔴 OBSERVED NODE-SIDE, so there is no page predicate to poll: the CDP listener fills
  // `requested`, and the wait watches that array. Still a condition, still not a duration.
  // (Bound raised from 5 s to 15 s: it is only a bound on a hang, and a loaded box can use 5.)
  for (let i = 0; i < 300 && !requested.some(u => u.includes('/export')); i++) await sleep(50);
  const url = requested.find(u => u.includes('/export'));
  ok(
    !!url && url.includes(`/wbedit/documents/${docId}/export?revision=0`),
    `Export asks for the revision on screen, not the latest (${url})`,
  );
  await cdp.send('Network.disable');
}

// ── ⬇ Export… asks WHERE to put it (11.1.8) ──────────────────────────────────
//
// The file-picker boundary must request a destination, write the exported JSON bytes, and do nothing if the picker is cancelled.
//
// 🔴 THE PICKER IS STUBBED, NOT ALLOWED. Headless Chrome cannot show a native dialog, so the real
// one never settles and this block would hang. The stub is also what makes the WRITE readable:
// `FileSystemWritableFileStream` hands its bytes to the operating system and nothing in the page
// can read them back, so the only place the exported JSON is observable is the `write()` call.
// ⚠️ Both halves restore `window.showSaveFilePicker = undefined` in a `finally` — the run-wide
// disarming at the top of this file is what every other export check depends on.
{
  const saved = await evaluate(
    cdp,
    `(async () => {
        const real = HTMLAnchorElement.prototype.click;
        let anchors = 0;
        HTMLAnchorElement.prototype.click = function(){ anchors++; };
        const calls = [], chunks = [];
        let closed = false;
        window.showSaveFilePicker = async o => { calls.push(o); return {
            createWritable: async () => ({ write: async b => chunks.push(b),
                                           close: async () => { closed = true; } }) }; };
        switchStTab('books');
        try{
            document.getElementById('wbExport_books').click();
            for(let i = 0; i < 300 && !closed; i++) await new Promise(r => setTimeout(r, 50));
            const text = chunks.length ? await chunks[0].text() : '';
            let entries = 'NOT JSON';
            try{ const j = JSON.parse(text); entries = j && j.entries ? Object.keys(j.entries).length : 'no entries key'; }
            catch(e){ entries = 'NOT JSON: ' + e.message; }
            const ex = document.getElementById('wbExport_books').getBoundingClientRect();
            return {call: calls[0] || null, anchors, closed, entries, bytes: text.length,
                    docName: document.getElementById('wbDocName_books').textContent,
                    live: ex.width > 10, h: ex.height,
                    msg: document.getElementById('wbMsg_books').textContent};
        } finally { HTMLAnchorElement.prototype.click = real; window.showSaveFilePicker = undefined; }
    })()`,
  );
  ok(saved.live, `the books editor is really on screen, so these reads mean something (${JSON.stringify(saved.msg)})`);
  ok(saved.h > 0 && saved.h < 40, `⬇ Export…'s label sits on one line (${saved.h}px)`);
  ok(!!saved.call, 'Export opens the browser’s own Save-As dialog rather than firing at the downloads folder');
  ok(
    saved.call && saved.call.suggestedName === saved.docName + '.json',
    `and it arrives pre-filled with the name the SERVER chose (${saved.call && saved.call.suggestedName})`,
  );
  // 🔴 A STABLE `id` IS THE "SAME BACKUP FOLDER EVERY TIME" FEATURE — Chrome keys the last-used
  // directory on it. Without it the dialog reopens at Downloads and the second book costs the same
  // navigation as the first, which is most of what he asked to be rid of.
  ok(
    saved.call && saved.call.id === 'vocalis-wbedit-export',
    `and names an id, so it reopens where he last saved (${saved.call && saved.call.id})`,
  );
  ok(saved.closed === true, 'the stream is CLOSED, not just written — an unclosed writable never reaches disk');
  // 🔴 THE BYTES, PARSED. "It called the picker" is satisfied by a handler that writes nothing, and
  // a backup file is exactly the artifact nobody opens until the day it matters.
  ok(
    typeof saved.entries === 'number' && saved.entries > 0,
    `and what it writes is the standard worldbook JSON (entries: ${saved.entries})`,
  );
  ok(saved.anchors === 0, 'with no download fired behind the dialog — one save, not two');
  ok(
    /saved/i.test(saved.msg) && !/downloaded/i.test(saved.msg),
    `and the message line says saved, not downloaded (${JSON.stringify(saved.msg)})`,
  );

  // ── Cancel ───────────────────────────────────────────────────────────────────────────────
  // 🔴 THE ONE THAT WOULD HAVE SHIPPED. `dl.js` treats any picker rejection as "this browser has
  // no picker" and falls through to the anchor — which is right for a SecurityError from an
  // expired gesture and catastrophic for `AbortError`, because Cancel would then download the file
  // he just declined into the folder he was trying to avoid. Only the name on the exception
  // separates the two, and nothing but this assertion holds that apart.
  const cancelled = await evaluate(
    cdp,
    `(async () => {
        const real = HTMLAnchorElement.prototype.click;
        let anchors = 0;
        HTMLAnchorElement.prototype.click = function(){ anchors++; };
        window.showSaveFilePicker = async () => { const e = new Error('user cancelled'); e.name = 'AbortError'; throw e; };
        const msg = () => document.getElementById('wbMsg_books').textContent;
        try{
            document.getElementById('wbExport_books').click();
            for(let i = 0; i < 300 && !/nothing was saved/i.test(msg()); i++) await new Promise(r => setTimeout(r, 50));
            return {anchors, msg: msg()};
        } finally { HTMLAnchorElement.prototype.click = real; window.showSaveFilePicker = undefined; }
    })()`,
  );
  ok(cancelled.anchors === 0, 'pressing Cancel saves NOTHING — no download fires behind the dismissed dialog');
  ok(
    /nothing was saved/i.test(cancelled.msg),
    `and the line says so rather than leaving the busy spinner up (${JSON.stringify(cancelled.msg)})`,
  );

  // ── and the browser that has no picker at all ────────────────────────────────────────────
  // Firefox and Safari. The fallback is the anchor this module shipped with, and the roster-row
  // block further down proves the NAME it saves under; what is asserted here is only that the
  // branch is still reachable from this button once the picker is gone.
  const noPicker = await evaluate(
    cdp,
    `(async () => {
        const real = HTMLAnchorElement.prototype.click;
        const seen = [];
        HTMLAnchorElement.prototype.click = function(){ seen.push(this.download); };
        try{
            document.getElementById('wbExport_books').click();
            for(let i = 0; i < 300 && !seen.length; i++) await new Promise(r => setTimeout(r, 50));
            return {seen, msg: document.getElementById('wbMsg_books').textContent};
        } finally { HTMLAnchorElement.prototype.click = real; }
    })()`,
  );
  ok(
    noPicker.seen[0] === saved.docName + '.json',
    `a browser with no Save-As dialog still downloads it (${JSON.stringify(noPicker.seen)})`,
  );
  ok(/downloaded/i.test(noPicker.msg), `and says downloaded, which is what happened (${JSON.stringify(noPicker.msg)})`);
}

// ── m4o: the picture, and which square of it is the face ─────────────────────
// 🔴 DRIVEN WITH A REAL POINTER, not asserted on markup. The whole control is a drag, and the
// trap it exists to avoid — the browser's own image-drag swallowing every pointermove after the
// first — is invisible to every kind of test that does not actually drag.
{
  // ⚠️ The id is read out of the DOM rather than closed over: `built` belongs to an earlier
  // block's scope and referencing it here is a ReferenceError that fails every check in this
  // block for a reason that names none of them.
  // ⚠️ And the Cards roster is REFRESHED FIRST. Earlier blocks leave the page on World Books,
  // where `#wbLib_cards` holds whatever it held when that pane was last drawn — so grabbing a
  // row straight away found nothing and threw on `.click()` of null.
  // ⚠️ And the §8.2 worldbook FILTER is cleared: the block above leaves one set, so a roster
  // reload on its own comes back empty and the row lookup throws on null.
  // ⚠️ NOT `return wbLoadLib(...)`. `evaluate` awaits whatever the expression yields, so handing
  // it a promise makes this call as long-lived as that promise — and a reload that never
  // settles becomes a spec that hangs rather than one that fails. Fire it, then poll the DOM.
  // 🔴 THE CARDS SUB-TAB HAS TO BE THE VISIBLE ONE. Earlier blocks leave the page on World
  // Books, and `wbOpen` shows the EDITOR pane without showing the sub-tab that contains it —
  // so the picture had no layout box at all, `getBoundingClientRect()` was 0x0, and every
  // point in the drag clamped to the same coordinate. A drag test on an invisible element
  // fails in a way that says nothing about the drag.
  await evaluate(cdp, `switchStTab('cards')`);
  await waitFor(cdp, `document.querySelector('[data-stpanel="cards"]').style.display !== 'none'`, 5000);
  await evaluate(
    cdp,
    `(() => {
        wbSetBookFilter('');
        const sel = document.getElementById('wbBook_cards');
        if(sel) sel.value = '';
        wbLoadLib('cards');
        return true;
    })()`,
  );
  // 🔴 A ROW WITH A PICTURE, not merely the first row. A card imported as JSON has no avatar, so
  // its <img> is hidden (9.5.12 — the wrap itself stays up, carrying ⬆ Upload PNG), and every
  // measurement of an unrendered image is 0x0 — which reads as "the drag does not work" rather
  // than "there is nothing to drag on". `.wbface img` exists only where a face actually loaded.
  ok(
    await waitFor(cdp, `!!document.querySelector('#wbLib_cards .wbface img')`, 10000),
    'the Character Cards roster has a row with a picture to work with',
  );
  const cardId = await evaluate(cdp, `document.querySelector('#wbLib_cards .wbface img').closest('[data-id]').dataset.id`);
  await evaluate(cdp, `(() => { wbOpen('cards', '${cardId}'); return true; })()`);
  ok(
    await waitFor(cdp, `document.getElementById('wbCard_cards')?.naturalWidth > 0`, 10000),
    'and opening it shows the picture the face square is drawn on',
  );

  ok(
    await evaluate(
      cdp,
      `!!document.getElementById('wbPicUpload_cards')
                            && !!document.getElementById('wbPicFocus_cards')
                            && !!document.getElementById('wbPicApply_cards')
                            && !!document.getElementById('wbPicCancel_cards')`,
    ),
    'the card editor has Upload PNG, Set face, and 9.5.13’s Apply/Cancel under the picture',
  );
  // Books have no picture, so the controls must not be emitted for that pane at all.
  ok(await evaluate(cdp, `!document.getElementById('wbPicUpload_books')`), 'and a World Book has neither, because it has no picture');

  // ── 9.5.13 — THE PICKER IS ADJUSTABLE, AND NOTHING IS WRITTEN UNTIL ✓ Apply face ──────────
  //
  // Dragging previews a crop rectangle; only Apply writes it, and the test compares against the original stored rectangle.
  //
  // ⚠️ EVERY GESTURE IS DRIVEN THROUGH REAL PointerEvents ON REAL ELEMENTS. A check that called
  // `wbPicApply` directly would pass with the handles unbuilt and the listener bound to the wrong
  // node — which is precisely the failure `wbPicBind` moving from the <img> to the wrap fixes, and
  // it is invisible to anything that does not press the handle itself.
  // 🔴 THE FIXTURE CARD ALREADY CARRIES A RECT, AND THE FIRST DRAFT OF THESE CHECKS DID NOT KNOW
  // IT. Written as `!stored.w` — "nothing has been written" — they were really asserting "this
  // card has no face", which is false here: `{x:0.1, y:0.2, w:0.5}` is in the fixture. Worse, the
  // Apply check polled for `f && f.w` and so returned the PRE-EXISTING rect on its first read and
  // went green without Apply having written anything at all. Every one of them is now measured
  // against this baseline, which is the only thing that can tell "unchanged" from "absent".
  const base = await evaluate(cdp, `(async () => (await (await fetch('/wbedit/documents/${cardId}')).json()).focus)()`);
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

  // 🔴 "STORES NOTHING" IS A CLAIM ABOUT REQUESTS, SO THE REQUESTS ARE RECORDED (INSTALL_WRITE_LOG,
  // top of file). The two checks below used to be answered by waiting (a 250 ms pause, and eight
  // reads over ~2 s) and then reading the stored rect, hoping any write that was going to happen
  // had landed by then. Every handler in the picker except Apply is synchronous, so a write could
  // only be ISSUED inside the gesture; the wrapper notes it at that moment, so the check can wait
  // for exactly those requests to answer and then read the server once.
  await evaluate(cdp, INSTALL_WRITE_LOG);
  const armed = await evaluate(
    cdp,
    `(async () => {
        // No pause after the click: wbPicToggle (open.js) arms the picker, draws the square and
        // swaps the buttons synchronously inside the click handler. This was a 250 ms sleep.
        document.getElementById('wbPicFocus_cards').click();
        const sq = document.getElementById('wbSq_cards');
        return {
          shown: !!sq && sq.style.display !== 'none' && parseFloat(sq.style.width) > 0,
          square: !!sq && sq.style.width === sq.style.height,
          handles: sq ? sq.querySelectorAll('.wbh').length : 0,
          guide: sq ? sq.querySelectorAll('.wbsqc').length : 0,
          applyShown: document.getElementById('wbPicApply_cards').style.display !== 'none',
          setFaceHidden: document.getElementById('wbPicFocus_cards').style.display === 'none',
          rect: JSON.parse(JSON.stringify(wbState('cards').pick.rect || null)),
        };
    })()`,
  );
  // 🔴 OPENING ON A SQUARE IS HALF THE FIX. *"it's hard to get the oval exactly centered… in one
  // shot"* — starting empty made the FIRST drag decide everything, so the centered square was the
  // one answer a freehand gesture could not produce. Now it is where the control starts.
  ok(armed.shown, `◎ Set face opens on a square already on the picture (${JSON.stringify(armed.rect)})`);
  // 🔴 A CIRCLE NEEDS A SQUARE. The rect carries `w` and no `h` — that is the fork's format — so
  // the side must be computed in width-fractions, or the circle lands as an ellipse on any picture
  // that is not square. A card is 2:3, so this fails loudly if it is ever done in element pixels.
  ok(armed.square, 'and it is square on screen, not the shape of the 2:3 card');
  ok(armed.handles === 4, `with four corner handles to resize by (${armed.handles})`);
  ok(armed.guide === 1, 'and a dashed circle inside showing what the avatar will actually be');
  ok(armed.applyShown && armed.setFaceHidden, '✓ Apply face replaces ◎ Set face while picking');

  // Drag the square BODY. The stored rect must move and keep its size — this is the gesture that
  // did not exist at all before, and the reason the whole control was a one-shot.
  //
  // 🔴 THE "stores nothing" HALF WAITS, AND THE MUTATION TEST IS WHY. Restoring the pre-9.5.13
  // write on `pointerup` reddened Cancel and the picker-closes check but NOT this one: the read
  // ran in the same tick as the dispatch, so the forbidden POST was still in flight and the
  // check passed on timing. A negative claim about an async side effect has to hold across a
  // WINDOW; an instant proves nothing.
  // ⚠️ SUPERSEDED (2026-10-12): the window was a fixed ~2 s of reads, which is a duration guess.
  // It is now the set of requests the gesture made (recorded by the fetch wrapper installed above),
  // awaited to completion, so the check holds on any machine speed. The mutation-test lesson stands.
  const moved = await evaluate(
    cdp,
    `(async () => {
        const sq = document.getElementById('wbSq_cards');
        const before = JSON.parse(JSON.stringify(wbState('cards').pick.rect));
        const b = sq.getBoundingClientRect();
        const at = (x, y) => ({clientX: x, clientY: y, bubbles: true, pointerId: 1});
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        const writes0 = window.__wbWrites.length;
        sq.dispatchEvent(new PointerEvent('pointerdown', at(cx, cy)));
        sq.dispatchEvent(new PointerEvent('pointermove', at(cx, cy + 20)));
        sq.dispatchEvent(new PointerEvent('pointerup', at(cx, cy + 20)));
        const after = JSON.parse(JSON.stringify(wbState('cards').pick.rect));
        // Reading in the same tick as the dispatch made this pass on timing: with the pre-9.5.13
        // one-shot deliberately restored, the POST was still in flight and the check went green
        // over the exact behavior it exists to forbid. A pause of ~2 s (eight reads) papered over
        // that. What closes it is to take the requests the gesture made, wait for THOSE to answer,
        // and only then read the server: if the release wrote, the write is in the list and has
        // landed by the read; if it did not, the list is empty and the read is the verdict.
        const mine = window.__wbWrites.slice(writes0).filter(w => w.url.includes('/wbedit/documents/${cardId}'));
        await Promise.all(mine.map(w => w.p));
        const stored = (await (await fetch('/wbedit/documents/${cardId}')).json()).focus;
        return {before, after, stored, writes: mine.map(w => w.method + ' ' + w.url)};
    })()`,
  );
  ok(moved.after.y > moved.before.y, `dragging the square moves it (y ${moved.before.y} -> ${moved.after.y})`);
  ok(Math.abs(moved.after.w - moved.before.w) < 1e-6, `and moving does not resize it (w ${moved.before.w} -> ${moved.after.w})`);
  // 🔴 THE ONE THAT WOULD HAVE CAUGHT THE OLD BEHAVIOR. A release must write NOTHING.
  ok(
    same(moved.stored, base) && moved.writes.length === 0,
    `and a release stores nothing — Apply is the only writer (${JSON.stringify(moved.stored)} vs ${JSON.stringify(base)})`,
  );

  // Drag a CORNER. The side must change while the rect stays square and inside the picture.
  const resized = await evaluate(
    cdp,
    `(async () => {
        const sq = document.getElementById('wbSq_cards');
        const h = sq.querySelector('.wbh-se');
        const before = JSON.parse(JSON.stringify(wbState('cards').pick.rect));
        const b = h.getBoundingClientRect();
        const at = (x, y) => ({clientX: x, clientY: y, bubbles: true, pointerId: 1});
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        h.dispatchEvent(new PointerEvent('pointerdown', at(cx, cy)));
        h.dispatchEvent(new PointerEvent('pointermove', at(cx - 40, cy - 40)));
        h.dispatchEvent(new PointerEvent('pointerup', at(cx - 40, cy - 40)));
        const after = JSON.parse(JSON.stringify(wbState('cards').pick.rect));
        const el = document.getElementById('wbSq_cards');
        return {before, after, square: el.style.width === el.style.height};
    })()`,
  );
  ok(resized.after.w < resized.before.w, `dragging a corner resizes it (w ${resized.before.w} -> ${resized.after.w})`);
  ok(resized.square, 'and it is still square after a resize');
  ok(
    resized.after.x >= 0 && resized.after.y >= 0 && resized.after.x + resized.after.w <= 1.0001,
    `and still inside the picture (${JSON.stringify(resized.after)})`,
  );

  // ✕ Cancel writes nothing and puts the stored rect back.
  const canceled = await evaluate(
    cdp,
    `(async () => {
        // wbPicCancel (open.js) is synchronous and writes nothing; the 250 ms sleep that was here
        // was a guess that a write, had there been one, would have landed. Same method as the
        // release above: take the requests the click made, let them answer, then read once.
        const writes0 = window.__wbWrites.length;
        document.getElementById('wbPicCancel_cards').click();
        const mine = window.__wbWrites.slice(writes0).filter(w => w.url.includes('/wbedit/documents/${cardId}'));
        await Promise.all(mine.map(w => w.p));
        const doc = await (await fetch('/wbedit/documents/${cardId}')).json();
        return {stored: doc.focus, writes: mine.length, picking: !!wbState('cards').pick.on,
                setFaceBack: document.getElementById('wbPicFocus_cards').style.display !== 'none',
                applyGone: document.getElementById('wbPicApply_cards').style.display === 'none'};
    })()`,
  );
  ok(
    same(canceled.stored, base) && canceled.writes === 0,
    `✕ Cancel leaves the stored rect alone (${JSON.stringify(canceled.stored)} vs ${JSON.stringify(base)})`,
  );
  ok(!canceled.picking && canceled.setFaceBack && canceled.applyGone, 'and puts the buttons back to ◎ Set face');

  // ✓ Apply face is what writes. Re-enter, adjust, apply, read the server back.
  //
  // 🔴 IT POLLS FOR THE *CHANGE*, NEVER FOR PRESENCE. This card already HAS a rect, so a poll of
  // the form "if (f && f.w) return f" handed back the fixture's own value on the first read — the
  // check then measured the fixture and would have gone green with Apply doing nothing at all.
  // Waiting for the value to stop matching the baseline is the only form of this that can fail.
  //
  // ⚠️ AND THE NOTE LIVES OUT HERE BECAUSE THE BLOCK BELOW IS A TEMPLATE LITERAL. Written inside
  // it, the backticks quoting that code sample ENDED the string mid-comment — a SyntaxError with
  // no relation to what it was describing. Comments injected into a CDP snippet carry the same
  // rule as the code around them.
  const applied = await evaluate(
    cdp,
    `(async () => {
        // Synchronous, as for the first arming above (was a 250 ms sleep).
        document.getElementById('wbPicFocus_cards').click();
        const sq = document.getElementById('wbSq_cards');
        const b = sq.getBoundingClientRect();
        const at = (x, y) => ({clientX: x, clientY: y, bubbles: true, pointerId: 1});
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        sq.dispatchEvent(new PointerEvent('pointerdown', at(cx, cy)));
        sq.dispatchEvent(new PointerEvent('pointermove', at(cx, cy + 15)));
        sq.dispatchEvent(new PointerEvent('pointerup', at(cx, cy + 15)));
        const wanted = JSON.parse(JSON.stringify(wbState('cards').pick.rect));
        document.getElementById('wbPicApply_cards').click();
        const wasBase = ${JSON.stringify(base)};
        const eq = f => JSON.stringify(f || null) === JSON.stringify(wasBase || null);
        // A condition poll with a bound, not a pause: it returns the moment the stored rect differs
        // from the baseline. 250 ms is the step between reads and 80 steps (20 s) the bound on a hang.
        for (let i = 0; i < 80; i++) {                 // up to 20s, returns the moment it lands
            const f = (await (await fetch('/wbedit/documents/${cardId}')).json()).focus;
            if (!eq(f)) return {wanted, stored: f, picking: !!wbState('cards').pick.on};
            await new Promise(r => setTimeout(r, 250));
        }
        return {wanted, stored: null, picking: !!wbState('cards').pick.on};
    })()`,
  );
  ok(
    applied.stored && applied.stored.w > 0 && applied.stored.w <= 1 && applied.stored.x >= 0 && applied.stored.y >= 0,
    `✓ Apply face stores the rect as fractions of the image (${JSON.stringify(applied.stored)})`,
  );
  ok(
    applied.stored && Math.abs(applied.stored.y - applied.wanted.y) < 0.02,
    `and stores the square he actually adjusted to (y wanted ${applied.wanted && applied.wanted.y} vs stored ${applied.stored && applied.stored.y})`,
  );
  ok(!applied.picking, 'and closes the picker, because the answer is in');

  // Clearing has to be expressible: absent means "largest centered square" to both products,
  // and a zero-width rect is a window their thumbnail endpoint would honor.
  // 🔴 POLL, DO NOT SLEEP. This was a flat 700ms wait for a click to reach the server and come
  // back, which is a bet on how loaded the box is — and under a 16-worker suite it lost: the
  // read-back returned the rect the DRAG had stored two checks earlier, so the check reported
  // "Clear face zeroes the rect" when the clear simply had not landed yet. It passed in
  // isolation, which is how a fixed sleep always presents. Same class as check I15's 4s → 10s
  // in 8cfa87c, and the same fix is better: stop when the answer arrives, and give it room.
  const cleared = await evaluate(
    cdp,
    `(async () => {
        document.getElementById('wbPicFocusClear_cards').click();
        const read = async () => (await (await fetch('/wbedit/documents/${cardId}')).json()).focus;
        for (let i = 0; i < 80; i++) {                 // up to 20s, and it returns the moment it can
            const f = await read();
            if (!f || !f.w) return f;
            await new Promise(r => setTimeout(r, 250));
        }
        return await read();                           // still set after 10s — a real finding
    })()`,
  );
  ok(!cleared || !cleared.w, `Clear face removes the rect rather than zeroing it (${JSON.stringify(cleared)})`);

  // ── 9.5.12 — A PICTURE REPLACED BEHIND THE PAGE'S BACK IS STILL SEEN ──────────────────────
  //
  // 🔴 THE FIRST VERSION OF THIS CHECK WAS DECORATION, AND THE MUTATION TEST IS THE ONLY REASON
  // THAT IS KNOWN. It uploaded the new picture FROM THE PAGE and asserted the reopen showed it —
  // and it passed with the old `max-age=300` header put back, i.e. it could not fail for the
  // reason it existed. RFC 9111 §4.4 is why: a successful unsafe request invalidates the cache
  // entry for that URI, so the upload's own POST evicts the entry and the header never comes into
  // it. The five-minute staleness I had reasoned my way to does not happen on the upload path.
  //
  // 🔴 SO THE HEADER IS MEASURED WHERE NOTHING IN THIS BROWSER DID THE WRITE. Node POSTs the
  // replacement; the page never issues that request, so its cached copy is the only thing that
  // could answer the next open. Under `max-age=300` that is exactly what happens and this goes
  // red. It is a real path, not a contrivance: `⟳ Import from SillyTavern` pushes new avatar
  // bytes through `/pair/documents/<id>/avatar` while an editor tab sits open on that card.
  //
  // ⚠️ THE ASSERTION IS THE PIXELS. `naturalWidth` is what the <img> actually decoded; a header
  // check is satisfied by a route that has stopped varying its ETag and would paint the old face
  // anyway. The two fixtures differ in SIZE, so the number names which picture is on screen.
  const FIVE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAIAAAACDbGyAAAAEUlEQVR4nGM48P8dMmKgkA8AcDBC5gLzfDoAAAAASUVORK5CYII=';
  const NINE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAJCAIAAABv85FHAAAAEUlEQVR4nGMwTpuJCzEMczkAitNg018LF6QAAAAASUVORK5CYII=';
  const putAvatar = async b64 =>
    (
      await fetch(`${baseUrl}/wbedit/documents/${cardId}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: Buffer.from(b64, 'base64'),
      })
    ).status;
  const settle = `(async () => {
        const im = document.getElementById('wbCard_cards');
        try { await im.decode(); } catch (e) {}
        return im.naturalWidth;
    })()`;

  const putFirst = await putAvatar(FIVE_PX);
  await evaluate(cdp, `wbOpen('cards', '${cardId}')`);
  const firstWidth = await evaluate(cdp, settle);
  ok(putFirst === 201 && firstWidth === 5, `the editor shows the picture the server holds (${putFirst}, ${firstWidth}px)`);

  const putSecond = await putAvatar(NINE_PX);
  await evaluate(cdp, `wbOpen('cards', '${cardId}')`);
  const secondWidth = await evaluate(cdp, settle);
  ok(
    putSecond === 201 && secondWidth === 9,
    `and a picture replaced behind the page's back is seen, not the cached one (${putSecond}, ${secondWidth}px)`,
  );

  // ── The roster thumbnail must receive the same cache-busting update as the editor image ──
  //
  // 🔴 9.5.12 FIXED HALF OF THIS AND THE HALF IT LEFT IS THE HALF HE LOOKS AT. It stamped
  // `/avatar`, which is the big picture in the editor — the check above. The roster row's `<img>`
  // points at `/thumb`, which stayed on a bare URL, so uploading a new PNG updated the editor and
  // left the face beside the name showing the old character until a hard reload.
  //
  // 🔴 THE ASSERTION IS THE PIXELS, AND IT HAS TO BE A COLOR RATHER THAN A SIZE. The editor
  // check above can read `naturalWidth` because it draws the card itself; every thumbnail is
  // 96×96 whatever went in, so the only thing that names WHICH face is on screen is what it looks
  // like. Two solid fixtures, read back off a canvas.
  //
  // 🔴 AND NODE DOES BOTH WRITES, for the reason the editor check gives above: a POST from the
  // page evicts the page's own cache entry (RFC 9111 §4.4), so a check that uploads from the
  // browser cannot fail for the reason it exists. This is a real path either way — `⟳ Import from
  // SillyTavern` replaces avatar bytes under an open roster.
  const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGO8IyfHgA0wYRUdtBIA4FYBKCgCg6AAAAAASUVORK5CYII=';
  const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGOUk7vDgA0wYRUdtBIA3toBKOMzcq4AAAAASUVORK5CYII=';
  // The circle's own pixels: draw the row's <img> at its natural size and sample the middle.
  // `decode()` rather than a load listener — the element is already in the DOM by the time this
  // runs, so a listener would wait for an event that has fired.
  // 🔴 RETRIED ON AN ERROR ANSWER ONLY (2026-10-12). "No face in the roster" and "did not decode"
  // are what a read taken while the roster is mid-repaint, or the image is mid-fetch, looks like,
  // and under load they came back as "rgb undefined,undefined,undefined". They are not an answer
  // about WHICH picture is on screen, so they are asked again (a fresh reload each time, bounded at
  // 40 tries 100 ms apart). A wrong COLOR is an answer and is returned at once: the stale-cache
  // bug this exists for decodes fine and shows the old picture, so retrying cannot hide it.
  const rosterPixel = `(async () => {
      const once = async () => {
        await wbLoadLib('cards');
        const div = [...document.querySelectorAll('#wbLib_cards .wbface')]
            .find(d => d.dataset.id === '${cardId}');
        const im = div && div.querySelector('img');
        if (!im) return {err: 'no face in the roster'};
        try { await im.decode(); } catch (e) { return {err: 'the face did not decode: ' + e}; }
        const c = document.createElement('canvas');
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext('2d').drawImage(im, 0, 0);
        const p = c.getContext('2d').getImageData(im.naturalWidth >> 1, im.naturalHeight >> 1, 1, 1).data;
        return {r: p[0], g: p[1], b: p[2], src: im.getAttribute('src')};
      };
      let out = await once();
      for (let i = 0; i < 40 && out.err; i++) {
        await new Promise(r => setTimeout(r, 100));
        out = await once();
      }
      return out;
    })()`;

  await putAvatar(RED);
  const wasRed = await evaluate(cdp, rosterPixel);
  ok(
    wasRed.r > 180 && wasRed.b < 80,
    `the roster circle shows the picture the server holds (rgb ${wasRed.r},${wasRed.g},${wasRed.b}${wasRed.err ? ' — ' + wasRed.err : ''})`,
  );

  await putAvatar(BLUE);
  const nowBlue = await evaluate(cdp, rosterPixel);
  ok(
    nowBlue.b > 180 && nowBlue.r < 80,
    `and a face replaced behind the page's back updates the circle too, without a reload ` +
      `(rgb ${nowBlue.r},${nowBlue.g},${nowBlue.b} at ${nowBlue.src})`,
  );

  // 🔴 THE SECOND INPUT, WHICH `avatar_at` CANNOT SEE — AND WHY THE TOKEN IS `thumb_at`.
  // `set_focus` mints no revision, does not set
  // `avatar_dirty` and does not touch the PNG, so the picture's (size, mtime) is byte-identical
  // across a rect edit: a URL stamped with `avatar_at` would have fixed ⬆ Upload PNG and left
  // ◎ Set face silently stale, which is the same bug wearing the other input.
  //
  // The fixture is two-tone — top-left quadrant red, bottom-right blue, green between — so the
  // circle's color names which crop is on screen rather than merely that the URL moved.
  // Thresholds are measured, not guessed: `thumbs.render` puts (221,30,31) and (29,30,221) at the
  // center of those two crops.
  const HALVES =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAJklEQVR4nGO8IyfHAAMWq77B2UxwFhogXYJR5IQInMMVdoIWdgAA9NQFFzkLfYMAAAAASUVORK5CYII=';
  await putAvatar(HALVES);
  const setFocus = async rect =>
    (
      await fetch(`${baseUrl}/wbedit/documents/${cardId}/focus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus: rect }),
      })
    ).status;
  await setFocus({ x: 0, y: 0, w: 0.5 });
  const topLeft = await evaluate(cdp, rosterPixel);
  await setFocus({ x: 0.5, y: 0.5, w: 0.5 });
  const bottomRight = await evaluate(cdp, rosterPixel);
  ok(
    topLeft.r > 180 && topLeft.b < 80,
    `the roster circle is cut at the face square (rgb ${topLeft.r},${topLeft.g},${topLeft.b}${topLeft.err ? ' — ' + topLeft.err : ''})`,
  );
  ok(
    bottomRight.b > 180 && bottomRight.r < 80,
    `and MOVING that square re-cuts it, on the same unchanged picture — which is the half ` +
      `avatar_at cannot see (rgb ${bottomRight.r},${bottomRight.g},${bottomRight.b} at ${bottomRight.src})`,
  );
  await setFocus(null);
}

// ── §8.2 — filter the Character Cards roster by worldbook (m2f) ──────────────
//
// Filter characters by their associated World Book.
//
// 🔴 THE RENAME CASE IS THE WHOLE REASON THIS IS HERE. The link is stored as a book ID precisely
// so that renaming the book cannot break it; an implementation that stored the NAME instead would
// pass every other check in this file and every route test, and then quietly return an empty
// roster the first time a book is renamed. Only a rename-then-filter proves the difference.
//
// ⚠️ Deliberately NOT reusing 'Sample World Book 1': the locked-vault block below asserts that name is on
// screen, and renaming it here would couple two unrelated tests through global state.
{
  const cardNaming = (name, world) =>
    JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name,
        description: 'Keeps to the lower district.',
        personality: 'Dry.',
        first_mes: 'Mm.',
        extensions: { world },
      },
    });
  const bookNamed = name =>
    JSON.stringify({
      name,
      entries: {
        0: {
          uid: 0,
          key: ['k'],
          comment: 'c',
          constant: false,
          order: 100,
          disable: false,
          content: 'A line of lore.',
        },
      },
    });

  const made = await evaluate(
    cdp,
    `(async () => {
        const post = async body => (await (await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: body})})).json());
        // 1. The book first, then a card naming it — resolved at import.
        const ledger = await post(${bookNamed('Sample World Book 2')});
        const quill  = await post(${cardNaming('Test Character 1', 'Sample World Book 2')});
        // 2. 🔴 AND THE OTHER ORDER — the card first, naming a book that does not exist yet.
        //    Files can arrive in either order. If the name is discarded before the book exists,
        //    the link cannot be made and the character would silently never
        //    appear under its book.
        const late   = await post(${cardNaming('Late Arrival Character', 'Sample World Book 3')});
        const streets = await post(${bookNamed('Sample World Book 3')});
        return {ledger: ledger.id, quill: quill.id, quillWorld: quill.world_id,
                late: late.id, lateWorld: late.world_id, streets: streets.id};
    })()`,
  );

  ok(made.quillWorld === made.ledger, 'a card naming a book we already hold is linked to it at import');
  ok(made.lateWorld === '', 'a card naming a book we do NOT hold imports unlinked rather than failing');

  await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].find(b => b.dataset.sttab === 'cards').click()`);
  await evaluate(cdp, `wbLoadLib('cards')`);

  ok(
    await evaluate(cdp, `!document.querySelector('#wbBook_books')`),
    'the World Books pane has no worldbook filter — it would have nothing to filter by',
  );

  const opts = await evaluate(cdp, `[...document.querySelectorAll('#wbBook_cards option')].map(o => o.textContent)`);
  ok(
    opts[0] === 'All worldbooks' && opts.includes('Sample World Book 2') && opts.includes('Sample World Book 3'),
    `the dropdown offers every worldbook, unfiltered first (${opts.join(' · ')})`,
  );

  // Driven through the real control — a `change` event on the select, not a call to wbLoadLib.
  //
  // 🔴 `applied` IS NOT CEREMONY. Assigning a `value` that matches no option leaves a select on
  // '', which is this control's "All worldbooks" — so a dropdown one load out of date makes
  // every assertion below pass against an UNFILTERED roster, i.e. the filter is never exercised
  // and the spec still reports green. That is exactly how the first run of this block passed
  // its rename check while silently testing nothing, so the pick is verified rather than
  // assumed. `wbLoadLib` is awaited first because it is what refreshes the option list.
  const pick = async (id, here, gone) => {
    await evaluate(cdp, `wbLoadLib('cards')`);
    const applied = await evaluate(
      cdp,
      `(() => {
            const s = document.getElementById('wbBook_cards');
            s.value = ${JSON.stringify(String(id))};
            if (s.value !== ${JSON.stringify(String(id))}) return false;
            s.dispatchEvent(new Event('change', {bubbles: true}));
            return true;
        })()`,
    );
    // 🔴 WAIT FOR THE ROSTER THE FILTER PRODUCES, NOT FOR 400 ms. This is the site that went
    // red in the full 16-worker suite while passing alone: the repaint had not happened yet,
    // the stale roster was read, and the check blamed the BACKFILL — a feature that was
    // working — for the harness being early.
    //
    // 🔴 AND IT WAITS ON BOTH SIDES, WHICH THE FIRST ATTEMPT DID NOT. Waiting only for the
    // name that should APPEAR is satisfied by the UNFILTERED roster, which already contains
    // every card — so the wait returned instantly on the pre-filter state and the very next
    // assertion (`!roster.includes(gone)`) failed. A predicate that the starting state already
    // satisfies is not a wait at all. One name in and one name out cannot both hold until the
    // repaint has actually happened.
    const has = n =>
      `document.querySelector('#wbLib_cards').textContent.toLowerCase()` + `.includes(${JSON.stringify(String(n).toLowerCase())})`;
    await waitFor(cdp, `${has(here)} && !${has(gone)}`, 8000);
    return {
      applied,
      roster: await evaluate(cdp, `document.querySelector('#wbLib_cards').textContent`),
    };
  };

  let r = await pick(made.ledger, 'Test Character 1', 'Test Character 2');
  ok(
    r.applied && r.roster.includes('Test Character 1') && !r.roster.includes('Test Character 2'),
    'choosing a book narrows the roster to the characters associated with it',
  );

  // 🔴 THE BACKFILL, END TO END. The card was imported before its book existed.
  r = await pick(made.streets, 'Late Arrival Character', 'Test Character 1');
  ok(
    r.applied && r.roster.includes('Late Arrival Character'),
    'a card imported BEFORE its book is linked once the book arrives — import order does not matter',
  );

  // 🔴 THE RENAME. Same book, new name, same id — the roster must not change.
  await evaluate(
    cdp,
    `(async () => (await fetch('/wbedit/documents/${made.ledger}/rename', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'Renamed Sample World Book 2'})})).json())()`,
  );
  r = await pick(made.ledger, 'Test Character 1', 'Late Arrival Character');
  ok(
    r.applied && r.roster.includes('Test Character 1'),
    'renaming the worldbook does NOT break the association — the link is the id, not the name',
  );
  const renamed = await evaluate(cdp, `[...document.querySelectorAll('#wbBook_cards option')].map(o => o.textContent)`);
  ok(renamed.includes('Renamed Sample World Book 2') && !renamed.includes('Sample World Book 2'), 'and the dropdown shows the new name');

  // "— not associated —" identifies cards without a current book link.
  r = await pick('none', 'Test Character 2', 'Test Character 1');
  ok(
    r.applied && r.roster.includes('Test Character 2') && !r.roster.includes('Test Character 1'),
    'the "not associated" option finds the cards linked to no book',
  );

  // 🔴 AN EMPTY FILTERED ROSTER IS NOT AN EMPTY LIBRARY. Saying "nothing imported yet"
  // over eight cards he can see on the other setting sends him to re-import everything.
  const emptyBook = await evaluate(
    cdp,
    `(async () => (await (await fetch('/wbedit/documents', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({document: ${bookNamed('Sample World Book 8')}})})).json()).id)()`,
  );
  r = await pick(emptyBook, 'no character cards are associated', 'Test Character 1');
  ok(
    r.applied && /no character cards are associated/i.test(r.roster) && !/nothing imported yet/i.test(r.roster),
    'a filter that matches nothing says so, rather than claiming the library is empty',
  );

  // 🔴 THE EXPORT BOUNDARY. The card is linked by id, so the name has to be put back on the way
  // out — and after a rename it must be the NEW one, or SillyTavern receives a stale link.
  const exported = await evaluate(
    cdp,
    `(async () => (await (await fetch(
        '/wbedit/documents/${made.quill}/export?revision=0')).json()).data.extensions.world)()`,
  );
  ok(
    exported === 'Renamed Sample World Book 2',
    `an exported card carries the book's CURRENT name, not the one it was imported with (${exported})`,
  );

  await pick(''); // leave the roster unfiltered for whatever runs next
  ok(
    (await evaluate(cdp, `document.querySelector('#wbLib_cards').textContent`)).includes('Test Character 2'),
    'clearing the filter brings the whole roster back',
  );
}

// ── a locked vault must not OUTLIVE the lock ─────────────────────────────────
//
// Vocalis boots locked and `pollReady` redeems the SUK to re-unlock silently a second or two
// later — no prompt, nothing retyped. Every other pane picks that up; this one did not, and sat
// on "the vault is locked" over a library that had been readable for minutes. A ↻ button was the
// old cover for it, which is the wrong shape for "wait a moment and look again" and is why the
// button is gone.
//
// ⚠️ `jget` IS STUBBED HERE, which this file otherwise refuses to do — the alternative is
// locking the document store mid-spec. What is being tested is the RECOVERY, and the stub only
// supplies the 423 the server would have sent.
{
  ok(
    await evaluate(cdp, `!document.querySelector('#wbRefresh_cards') && !document.querySelector('#wbRefresh_books')`),
    'the ↻ button is gone from both sub-tabs',
  );

  // 🔴 THE RETRY IS GUARDED ON THE PANE BEING ON SCREEN, so the spec has to actually be on it.
  // The avatar block above left the CARDS tab showing; calling wbLoadLib('books') from there
  // reproduces the guard refusing to retry a pane nobody is looking at, which is correct
  // behavior and a broken test. Switch first — and switching itself calls wbLoadLib, so the
  // stub goes in afterward or the tab change eats the 423.
  await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].find(b => b.dataset.sttab === 'books').click()`);
  await mustWait(
    cdp,
    `stTabNow() === 'books' && document.querySelector('#wbLib_books .wbopen')`,
    'the World Books pane is on screen before the 423 is injected',
  );

  // 🔴 THIS ASSERTION USED TO BE `return true`. The IIFE installed the stub and handed back a
  // literal, so `ok(locked, …)` could not fail — the anti-deletion roster was spending a slot
  // proving nothing. What matters is that the stub was REACHED: the two checks below are only
  // about recovery if a 423 was really injected. So: count the hits, and require the stub to
  // have stood down again afterward.
  //
  // 🔴 STUBBED AT `fetch`, NOT AT `jget` — 7.1-m11c, and the comment this replaces predicted it:
  // *"if `wbLoadLib` ever stops going through `jget` … the stub never fires, no error is ever
  // raised, and those two checks would be watching an ordinary successful load and passing."*
  // What it did not anticipate is that `wbLoadLib` still goes through **a** `jget` — the one
  // `open.js` IMPORTS from `js/util/http.js`. Assigning `window.jget` succeeds and is then simply
  // never consulted, so the prediction comes true with the mechanism inverted. Exactly this cost
  // fifteen misleading red checks in m11b (§5.12); converted here BEFORE `open.js` moves rather
  // than after.
  //
  // 📌 A REAL 423 RESPONSE, not a synthetic Error, which is also strictly more faithful: it now
  // exercises `jget`'s own not-ok branch — the one that reads `message` off the body and hangs
  // `status` on the thrown error — instead of hand-building the object that branch produces.
  await evaluate(
    cdp,
    `(() => {
        const real = window.fetch.bind(window);
        window.__vaultReal = real;
        window.__vaultHits = 0;
        window.fetch = async (u, opts) => {
            if (String(u).startsWith('/wbedit/documents?')) {
                window.__vaultHits++;
                window.fetch = real;                      // ONE 423, then the vault is open
                return new Response(JSON.stringify({message: 'the vault is locked'}),
                                    {status: 423, headers: {'Content-Type': 'application/json'}});
            }
            return real(u, opts);
        };
        wbLoadLib('books');
    })()`,
  );
  ok(
    await waitFor(cdp, `window.__vaultHits === 1 && window.fetch === window.__vaultReal`, 5000),
    "a 423 is injected for one call, through the loader's own jget, and the stub then stands down",
  );
  // ⚠️ 10 s, NOT 4 (7.3-m4k). This went red once in a 16-worker full run and passed both in
  // isolation and on the re-run — a load-dependent timeout, not a regression. The wait is for a
  // repaint that follows an injected 423 through the loader's own jget, and on a box already
  // running fifteen other workers plus several headless Chromes that is simply not always four
  // seconds. A `waitFor` returns as soon as its condition holds, so a longer ceiling costs
  // nothing when the code is right and only ever changes what happens when it is wrong — and
  // "fails sometimes" is the one result that teaches people to re-run instead of to read.
  ok(
    await waitFor(cdp, `document.querySelector('#wbLib_books').textContent.includes('vault is locked')`, 10000),
    'the pane says the vault is locked rather than "nothing imported yet" (I15)',
  );
  ok(
    await waitFor(cdp, `document.querySelector('#wbLib_books').textContent.includes('Sample World Book 1')`, 12000),
    '…and heals itself once the vault opens, with no button to press',
  );
}

// ── §9a.9 / m4m — the import status line: amber+spinner, green tally, dismiss ─
//
// 🔴 THE PROPERTY UNDER TEST IS THAT TWO OF THE THREE STATES DO **NOT** EVAPORATE. The user pressed
// ⟳ Import from SillyTavern, looked away, and came back to an empty line — the sweep's tally had
// erased itself after six seconds, so a press that worked and a press that did nothing looked
// identical. "Has a class" is not the check; the check is that it is still on screen after the
// old timeout would have fired, and that the ONLY thing that clears it is his ✕.
//
// ⚠️ THE THREE PANES EACH HAVE THEIR OWN STATUS LINE, which is what makes this one wait instead
// of three: park a different state on each and read all three after a single 6.5s sleep. That
// sleep is deliberate and cannot be a `waitFor` — the assertion is about elapsed time passing
// WITHOUT a change, and there is no event to wait for.
// ⚠️ SUPERSEDED: it is no longer a sleep. The chatter line's own expiry (wbHush) IS an observable
// event, and the wait below is on that; see "WAIT FOR THE EXPIRY TO FIRE".
//
// ⚠️ Color is read from `getComputedStyle`, never from the class name. 6.3's scar: a class-only
// assertion stayed green while the theme killed the property with `!important`.
{
  await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].find(b => b.dataset.sttab === 'cards').click()`);
  await mustWait(cdp, `stTabNow() === 'cards'`, 'the Character Cards pane is on screen for the status-line block');

  const paint = await evaluate(
    cdp,
    `(() => {
        wbSay('cards',    'asked SillyTavern for everything — importing…', 'busy');
        wbSay('books',    'imported 1 character, 12 unchanged', 'ok');
        wbSay('personas', 'saved as revision 4');
        const rd = k => {
            const el = document.querySelector('#wbMsg_' + k);
            return {text: el.textContent, color: getComputedStyle(el).color,
                    spin: !!el.querySelector('.spin'), x: !!el.querySelector('button.wbx')};
        };
        return {cards: rd('cards'), books: rd('books'), personas: rd('personas')};
    })()`,
  );

  // A color var is authored as a hex string and computes to `rgb(...)`, so compare through
  // the browser rather than by string: paint a probe with the var and read it back.
  const asRgb = await evaluate(
    cdp,
    `(() => {
        const p = document.createElement('span');
        document.body.appendChild(p);
        const one = v => { p.style.color = 'var(' + v + ')'; return getComputedStyle(p).color; };
        const out = {warn: one('--warn'), ok: one('--ok'), mut: one('--mut')};
        p.remove();
        return out;
    })()`,
  );

  ok(paint.cards.spin, 'an import in progress carries a spinner');
  ok(paint.cards.color === asRgb.warn, `and it is amber, not the old gray (${paint.cards.color} vs ${asRgb.warn})`);
  ok(!paint.cards.x, 'a job still running offers no ✕ — there is nothing finished to dismiss');

  ok(paint.books.color === asRgb.ok, `a finished import is green (${paint.books.color} vs ${asRgb.ok})`);
  ok(paint.books.text.includes('imported 1 character, 12 unchanged'), 'and it says what actually happened, not just that it happened');
  ok(paint.books.x, 'and it carries an ✕ to dismiss it');
  ok(!paint.books.spin, 'a finished import is not still spinning');

  ok(paint.personas.color === asRgb.mut && !paint.personas.x, 'ordinary chatter is unchanged — muted, and not something to dismiss');

  // The whole point. The old line cleared itself at 6s; these two must not.
  //
  // 🔴 WAIT FOR THE EXPIRY TO FIRE — DO NOT SLEEP PAST IT. This was `sleep(6600)`: the 6 s
  // timeout plus a margin, a fixed sleep standing in for an event that is directly observable.
  // `wbSay` sets `setTimeout(() => wbHush(kind), 6000)` and sets it ONLY for ordinary chatter
  // (`say.js:78`), so the chatter line going empty IS the proof that the expiry ran. Waiting on
  // that and then reading the other two is the same assertion with the causality the right way
  // round: a timer that never fires now times out HERE and says so, instead of leaving the two
  // checks below to go red describing something else.
  //
  // ⚠️ THE PRINTED NAME IS UNCHANGED, deliberately. It is the same claim — chatter still expires
  // on its own — so it keeps its line in the roster rather than retiring one name and
  // registering another that means exactly the same thing.
  await mustWait(
    cdp,
    `document.querySelector('#wbMsg_personas').textContent === ''`,
    'while ordinary chatter still expires on its own, as it always did',
    12000,
  );
  const later = await evaluate(
    cdp,
    `(() => {
        const rd = k => document.querySelector('#wbMsg_' + k).textContent;
        return {cards: rd('cards'), books: rd('books')};
    })()`,
  );
  ok(later.cards.includes('importing'), 'the running line is still there after the old six-second timeout would have wiped it');
  ok(later.books.includes('12 unchanged'), 'and so is the tally — the only record a press leaves behind');

  await evaluate(cdp, `document.querySelector('#wbMsg_books button.wbx').click()`);
  ok(await waitFor(cdp, `document.querySelector('#wbMsg_books').textContent === ''`, 3000), 'clicking the ✕ is what clears it');
  ok(
    await evaluate(cdp, `document.querySelector('#wbMsg_books').className === 'small muted'`),
    'and dismissing puts the line back to neutral, not to a green empty one',
  );

  // A second press must not stack on the first — the line is one control, not a log.
  await evaluate(cdp, `wbSay('cards', 'nothing to import', 'ok')`);
  const replaced = await evaluate(
    cdp,
    `(() => {
        const el = document.querySelector('#wbMsg_cards');
        return {text: el.textContent, spins: el.querySelectorAll('.spin').length,
                xs: el.querySelectorAll('button.wbx').length};
    })()`,
  );
  ok(
    !replaced.text.includes('importing') && replaced.spins === 0 && replaced.xs === 1,
    'a new status replaces the old one rather than accumulating beside it',
  );

  // 🔴 The tally is server text and goes in with `esc()`. A book called `<b>x` must not be
  // able to put a tag in the status line — this is the one place m4m started writing innerHTML.
  await evaluate(cdp, `wbSay('cards', 'could not read: <img src=x onerror="window.__pwn=1">', 'bad')`);
  ok(
    await evaluate(
      cdp,
      `window.__pwn === undefined
        && document.querySelector('#wbMsg_cards').textContent.includes('<img src=x')`,
    ),
    'a document name in the tally is escaped, never parsed as markup',
  );

  // 🔴 7.1-§5.2 — PIN THE MECHANISM, because the OUTCOME is already covered and cannot see this.
  // *"clicking the ✕ is what clears it"* above presses a real ✕ and watches the line go empty —
  // and it would pass just as loudly with an `onclick="wbHush('books')"` attribute, which is what
  // this used to be. That attribute resolves its function name off `window` at click time, so
  // under the module split (DESIGN_7_1_FRONTEND_REFACTOR.md §5) it finds nothing and the ✕
  // renders, clicks, and silently does nothing. Asserting the wiring is the only way to stop the
  // attribute quietly coming back: `data-*` plus one delegated listener, no inline handler.
  const wired = await evaluate(
    cdp,
    `(() => {
        wbSay('cards', 'a thing happened', 'ok');
        const x = document.querySelector('#wbMsg_cards button.wbx');
        return !!x && x.hasAttribute('data-wbhush') && !x.hasAttribute('onclick');
    })()`,
  );
  ok(wired, 'and it dismisses by DELEGATION — data-wbhush, never an onclick attribute');

  await evaluate(cdp, `wbHush('cards')`);
}

// ── §9a.13 — the LIVE model log, while the model is still thinking ───────────
//
// A running pass must create a visible row at send time, before a reply exists. The row shows the
// request, waiting state, and spinner, then updates in place when the reply arrives.
//
// ⚠️ `jget` IS STUBBED HERE, which this file otherwise refuses to do. The alternative is a real
// KoboldCpp holding a real pass open on the box, and the seam under test is the browser's: what
// this pane paints for a given log body. The stub supplies only the body the route would send —
// exactly the license the locked-vault block above takes, and for the same reason.
{
  await evaluate(cdp, `switchStTab('books')`);
  await mustWait(
    cdp,
    `stTabNow() === 'books' && document.querySelector('#wbLib_books .wbopen')`,
    'the World Books pane is back, with a row, for the model-log block',
    10000,
  );

  // Polling is automatic on all three panes; a manual refresh control would imply otherwise.
  //
  // 🔴 BY ELEMENT LOOKUP, NEVER BY SCANNING THE PAGE SOURCE. The rename check above records the
  // lesson: a substring test over a whole file punishes documenting the rule it enforces, and
  // `index.html` now carries a comment containing the words "Refresh button" explaining why the
  // control was removed. A source scan would match that comment and be wrong.
  ok(
    await evaluate(
      cdp,
      `!document.getElementById('wbLogRefresh_books')
                            && !document.getElementById('wbLogRefresh_cards')
                            && !document.getElementById('wbLogRefresh_personas')`,
    ),
    'the model log has no Refresh button on any pane',
  );

  // Keep the log between the World Books library and Review card, matching the workflow order:
  // select a document, edit it, send it to the model, and review the response.
  ok(
    await evaluate(
      cdp,
      `(() => {
        const log = document.getElementById('wbLog_books');
        const rev = document.getElementById('wbReview_books');
        return !!(log && rev
            && (log.compareDocumentPosition(rev) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`,
    ),
    'the log pane comes before the Review card in the DOM',
  );
  ok(
    await evaluate(
      cdp,
      `(() => {
        const log = document.getElementById('wbLog_books');
        const lib = document.getElementById('wbLib_books');
        return !!(log && lib
            && (lib.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`,
    ),
    'and after the World Books library it belongs to',
  );

  // ── §9a.13a: the SAVED log must not read as the live one ─────────────────
  //
  // 🔴 After a restart the live view is gone and this file survives, so the UI can show "3 runs, 6
  // exchanges" and reasonably read it as the pass he had been watching. Opening a document is
  // what shows the saved log, so this is driven by opening one.
  // 🔴 AWAITED, AND THE PANE IS BLANKED FIRST. Two traps, and this block sat in both. (1) The
  // header is NOT cleared between documents, so an earlier block had already left `saved ·
  // revision 0` on screen and waiting for it matched instantly, against a `wbOpen` that had not
  // even finished its first fetch. (2) `wbOpen` is three sequential fetches and then fires
  // `wbLoadSavedLog` UNAWAITED — so the saved log lands whenever it lands. Starting the live
  // view before that has settled means `wbOpen`'s tail runs `wbLogStop` (killing the poll that
  // was just armed) and then paints the SAVED log over the live one. The window then sits dead
  // for the rest of the block, showing "No pass has been run against this revision", and four
  // checks fail for a reason that names none of them.
  await evaluate(
    cdp,
    `(() => {
        document.getElementById('wbLogCount_books').textContent = '';
        document.getElementById('wbLogBody_books').innerHTML = '';
        return true;
    })()`,
  );
  await evaluate(cdp, `wbOpen('books', '${docId}', 0)`);
  // From a blanked header this can only be THIS open's saved log — and `wbOpen` runs `wbLogStop`
  // before it fires `wbLoadSavedLog`, so seeing it means both have already happened.
  ok(
    await waitFor(cdp, `document.getElementById('wbLogCount_books').textContent.startsWith('saved')`, 30000),
    'the saved log header says saved, not live',
  );
  ok(
    await evaluate(
      cdp,
      `(() => {
        const h = document.getElementById('wbLogCount_books');
        return h.textContent.includes('revision') && !h.querySelector('.spin');
    })()`,
    ),
    'and it names the revision and never spins, because nothing is in flight',
  );

  // ── the live view, driven the way Run pass drives it ─────────────────────
  //
  // A pass id on the state plus `wbLogStart` is the entirety of what the Run button does for
  // this pane, so nothing here reaches past a visible control.
  await evaluate(
    cdp,
    `(() => {
        window.__wbLogBody = {available: true, running: true, dropped: 0, exchanges: [{
            n: 1,
            request: {max_length: 512, temperature: 0.7, messages: [
                {role: 'system', content: 'You rewrite ONE field. <START> opens each example.'},
                {role: 'user', content: 'Rewrite this entry: Test Character 1 keeps the ledger.'}]},
            reply: null}]};
        // 🔴 STUB \`fetch\`, NOT \`jget\` — 7.1-m11b. This used to replace \`window.jget\`, which worked
        // for as long as \`wbLoadLog\` resolved \`jget\` off the global object. It now IMPORTS it from
        // \`js/util/http.js\`, and a module binding is not reachable from \`window\`: the assignment
        // still succeeds, the stub is simply never consulted, and the poll quietly talks to the
        // real server instead. That cost fifteen red checks whose messages all named the DOM.
        //
        // \`fetch\` is a genuine browser global that \`http.js\` does not import, so stubbing HERE
        // survives every remaining module move. \`devices_browser_spec.mjs\` already did it this way.
        const real = window.fetch.bind(window);
        window.__wbRealGet = real;
        window.__wbLogHits = 0;
        window.fetch = async (u, opts) => {
            if(/\\/wbedit\\/pass\\/.+\\/log$/.test(String(u))){
                window.__wbLogHits++;
                return new Response(JSON.stringify(window.__wbLogBody),
                                    {status: 200, headers: {'Content-Type': 'application/json'}});
            }
            return real(u, opts);
        };
        wbState('books').pass = {id: 'spec-pass'};
        wbLogStart('books');
    })()`,
  );
  // 🔴 THIS ASSERTION USED TO BE `return true` AT THE END OF THE SETUP IIFE — an ok() that
  // could not fail, holding a slot on the anti-deletion roster. What the block needs to be
  // true before any of the six checks below mean anything is that the pane is ACTUALLY
  // POLLING: `wbLogStart` has to arm a repeating timer and that timer has to fetch
  // /wbedit/pass/<id>/log. Gut `wbLogStart` and the old check stayed green while every check
  // under it failed for a reason that named the DOM instead.
  //
  // ⚠️ WAITED FOR, NEVER READ WITH A BARE `evaluate`. The poll is armed asynchronously and its
  // first tick is a WB_LOG_POLL_MS interval away; reading the hit count straight after the
  // setup is the same race that made st_characters_live_spec's `stPollTimer` check flaky.
  ok(
    await waitFor(
      cdp,
      `wbState('books').pass?.id === 'spec-pass' && !!wbState('books').logTimer
         && window.__wbLogHits >= 1`,
      30000,
    ),
    'a pass is under way with its first request sent and no reply yet',
  );

  // ⚠️ 30s, NOT 10s, AND THAT IS ABOUT THE MACHINE RATHER THAN THE FEATURE. Everything in this
  // block waits on a ONE-SECOND poll, so a 10s budget is ten ticks — and under the full suite's
  // 16 xdist workers, with a real Chrome in the loop, ten ticks is a coin flip. This file passed
  // alone and failed in the suite on the first full run after these checks landed, which is
  // exactly the shape the repo's other three known flakes take. A generous budget costs nothing
  // when the behavior is right (the wait returns the moment the text appears) and still fails
  // when it is wrong.
  ok(
    await waitFor(cdp, `document.getElementById('wbLogBody_books').textContent.includes('waiting for the model')`, 30000),
    'the poll paints the open row without waiting for a reply',
  );

  const inflight = await evaluate(
    cdp,
    `(() => {
        const body = document.getElementById('wbLogBody_books');
        const head = document.getElementById('wbLogCount_books');
        return {text: body.textContent, head: head.textContent,
                rows: body.querySelectorAll('.wblogx').length,
                bodySpin: !!body.querySelector('.spin'),
                headSpin: !!head.querySelector('.spin')};
    })()`,
  );
  // 🔴 THIS ONE. Twenty-six seconds of "no exchange yet" over a request that had plainly been
  // sent. The request body is on screen the moment it leaves, reply or no reply.
  ok(inflight.text.includes('Rewrite this entry: Test Character 1 keeps the ledger.'), 'the REQUEST is on screen before any reply exists');
  ok(inflight.text.includes('waiting for the model'), 'and the open row says it is waiting, not that nothing was sent');
  ok(inflight.bodySpin, 'and the open row carries a spinner');
  ok(inflight.headSpin, 'the header spins while the pass is running');
  ok(
    inflight.head.startsWith('live') && inflight.head.includes('waiting for the model'),
    `and the live header says live, never saved (${JSON.stringify(inflight.head)})`,
  );
  ok(inflight.rows === 1, `the in-flight request is ONE row, not a row per poll (${inflight.rows})`);

  // ── the reply lands: the SAME row closes, and it is escaped ──────────────
  //
  // 🔴 CLOSED IN PLACE, NOT APPENDED. The server pairs the reply with the last open row; a UI
  // that keyed on anything else would show the request twice — once open forever and once
  // answered — which would look like two calls per field.
  await evaluate(
    cdp,
    `(() => {
        window.__wbLogBody.exchanges[0].reply =
            'Test Character 1 audits the ledger. <START> {{user}} '
            + '<img src=x onerror="window.__logPwn = 1">';
        window.__wbLogBody.running = false;
        return true;
    })()`,
  );
  // No button is pressed here on purpose: the window keeps itself current (WB_LOG_POLL_MS), and
  // that is the reason there is no longer a ↻ Refresh beside it.
  const closed = await evaluate(
    cdp,
    `(async () => {
        const read = () => {
            const body = document.getElementById('wbLogBody_books');
            const head = document.getElementById('wbLogCount_books');
            const st = wbState('books');
            const src = window.__wbLogBody;
            return {rows: body.querySelectorAll('.wblogx').length, text: body.textContent,
                    bodySpin: !!body.querySelector('.spin'),
                    headSpin: !!head.querySelector('.spin'),
                    imgs: body.querySelectorAll('img').length,
                    clean: window.__logPwn === undefined,
                    // 🔴 CARRIED INTO THE MESSAGE ON PURPOSE. When this block first broke, the
                    // symptom was "0 rows" and the cause was NEITHER of wbLoadLog's two empty
                    // branches — the pane had been repainted by wbLoadSavedLog and the live poll
                    // had been stopped under it. hits (how many times the log route was actually
                    // asked for) plus the header text says that in one read; without them it is an
                    // afternoon of guessing which branch rendered the empty pane.
                    //
                    // ⚠️ NO BACKTICKS ANYWHERE IN THIS COMMENT. It lives inside a backtick
                    // template literal, so a stray one closes the string and node reports
                    // "missing ) after argument list" pointing at the line the literal STARTS on
                    // — which names none of this. That is exactly how it broke.
                    diag: JSON.stringify({head: head.textContent, hits: window.__wbLogHits,
                                          timer: !!st.logTimer, live: st.logLive,
                                          src: src && {run: src.running, n: src.exchanges.length,
                                                       rep: !!src.exchanges[0].reply}})};
        };
        // 150 x 200ms = 30s, for the same reason the waitFor above is 30s: this is waiting on a
        // one-second poll on a box running fifteen other test workers.
        for(let i = 0; i < 150; i++){
            const r = read();
            if(r.text.includes('{{user}}')) return Object.assign(r, {polled: true});
            await new Promise(f => setTimeout(f, 200));
        }
        return Object.assign(read(), {polled: false});
    })()`,
  );
  ok(closed.polled, `the poll picks the reply up on its own, with no button to press ${closed.diag}`);
  ok(closed.rows === 1, `the reply closes the open row in place rather than adding a second (${closed.rows} rows)`);
  ok(
    closed.text.includes('Test Character 1 audits the ledger.') && !closed.text.includes('waiting for the model'),
    'and the closed row shows the reply where the spinner was',
  );
  ok(!closed.bodySpin, 'nothing is left spinning once the reply is in');
  ok(!closed.headSpin, 'and the header stops spinning when the pass is no longer running');
  // 🔴 `esc()` ON EVERY PIECE. This pane renders raw model output and raw card text, and a card
  // is ALLOWED to contain angle brackets — `<START>` is literally in the baseline prompt, and it
  // is in the system message above as well as in this reply.
  ok(
    closed.clean && closed.imgs === 0 && closed.text.includes('<START>') && closed.text.includes('{{user}}'),
    'a reply carrying <START> and {{user}} renders as text, never as markup',
  );

  // ── follow the tail, but never take the scrollbar off him ────────────────
  //
  // 🔴 `wbRenderLog` REPLACES innerHTML WHOLESALE, so every poll is a chance to throw the scroll
  // position away — once a second, which is exactly when he is reading. `wbLogPaint` measures
  // before the write and restores after. Both directions matter and they are different bugs: a
  // pane at the bottom must STAY at the bottom (or a running pass stops showing its newest
  // exchange), and a pane he scrolled UP must stay where he put it (or the text he is reading
  // jumps out from under him).
  //
  // ⚠️ The timer is stopped first. The assertion is about what ONE repaint does to the scroll
  // position, and a 1s poll landing between the measurement and the read would be measuring a
  // repaint the test never asked for.
  await evaluate(
    cdp,
    `(() => {
        wbLogStop('books');
        const long = i => 'exchange ' + i + ' ' + 'lorem ipsum dolor sit amet consectetur '.repeat(20);
        window.__wbLogBody = {available: true, running: true, dropped: 0,
            exchanges: Array.from({length: 14}, (_, i) => ({
                n: i + 1,
                request: {messages: [{role: 'user', content: long(i)}]},
                reply: 'and the model answered ' + i}))};
        return true;
    })()`,
  );
  await evaluate(cdp, `wbLoadLog('books')`);
  const tall = await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('wbLogBody_books');
        return {scrollH: el.scrollHeight, clientH: el.clientHeight};
    })()`,
  );
  ok(
    tall.scrollH > tall.clientH + 200,
    `the log window overflows, so a scroll position means something (${tall.scrollH} vs ${tall.clientH})`,
  );

  await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('wbLogBody_books');
        el.scrollTop = el.scrollHeight;
        window.__wbLogBody.exchanges.push({n: 98,
            request: {messages: [{role: 'user', content: 'the newest row'}]}, reply: null});
        return true;
    })()`,
  );
  await evaluate(cdp, `wbLoadLog('books')`);
  const atTail = await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('wbLogBody_books');
        return {gap: el.scrollHeight - el.scrollTop - el.clientHeight,
                sawIt: el.textContent.includes('the newest row')};
    })()`,
  );
  ok(
    atTail.sawIt && atTail.gap < 40,
    `a new row leaves a pane that was at the bottom still at the bottom (gap ${Math.round(atTail.gap)}px)`,
  );

  const parked = await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('wbLogBody_books');
        el.scrollTop = 200;
        window.__wbLogBody.exchanges.push({n: 99,
            request: {messages: [{role: 'user', content: 'a second newest row'}]}, reply: null});
        return el.scrollTop;
    })()`,
  );
  await evaluate(cdp, `wbLoadLog('books')`);
  const held = await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('wbLogBody_books');
        return {top: el.scrollTop, sawIt: el.textContent.includes('a second newest row')};
    })()`,
  );
  ok(
    held.sawIt && Math.abs(held.top - parked) < 4,
    `a new row does not yank the pane away from where he scrolled it (${parked} -> ${held.top})`,
  );

  // Put the page back the way the next block expects to find it: no stub, no phantom pass, no
  // timer fetching a log for a pass that never existed.
  await evaluate(
    cdp,
    `(() => {
        wbLogStop('books');
        if(window.__wbRealGet){ window.fetch = window.__wbRealGet; window.__wbRealGet = null; }
        wbState('books').pass = null;
        document.getElementById('wbLog_books').style.display = 'none';
        return true;
    })()`,
  );
}

// ── SillyTavern pairing, in Settings (§8, m2) ────────────────────────────────
//
// 🔴 THIS BLOCK EXISTS BECAUSE A DRAFT OF IT CALLED `confirmModal()`, WHICH THIS APP DOES NOT
// HAVE — the same shape as the `toast()` near-miss the file's header records. A ReferenceError
// in a click handler leaves the button looking dead and every regex check still passing.
{
  await evaluate(cdp, `switchTab('settings')`);
  await waitFor(cdp, `!!document.querySelector('#pairToken') && !!document.querySelector('#pairNew')`, 8000);
  ok(
    await evaluate(cdp, `!!document.querySelector('#pairToken') && !!document.querySelector('#pairNew')`),
    'Settings offers a pairing token, beside the other credential',
  );

  const before = await evaluate(cdp, `document.querySelector('#pairToken').value`);
  ok(before === '', `it starts unpaired (${JSON.stringify(before)})`);
  // 🔴 MASKED BY COMPUTED STYLE, not by the class being present. `-webkit-text-security` is
  // exactly the kind of rule a theme can override, and 6.3's scar is a class-only assertion
  // passing while nothing painted.
  const sec = await evaluate(cdp, `getComputedStyle(document.querySelector('#pairToken')).webkitTextSecurity`);
  ok(sec === 'disc', `the field is masked (${sec})`);

  // Generate, through the button — with nothing paired the confirm is skipped by design.
  await evaluate(cdp, `document.querySelector('#pairNew').click()`);
  ok(await waitFor(cdp, `document.querySelector('#pairToken').value.length > 30`, 6000), 'Generate mints a token and puts it on screen');
  const tok = await evaluate(cdp, `document.querySelector('#pairToken').value`);

  // …and it is the real credential: the paired route accepts it and refuses without it.
  const probe = await evaluate(
    cdp,
    `(async () => {
        const withTok = await fetch('/pair/ping', {headers: {Authorization: 'Bearer ${tok}'}});
        const without = await fetch('/pair/ping');
        return {ok: withTok.status, bare: without.status};
    })()`,
  );
  ok(
    probe.ok === 200 && probe.bare === 401,
    `the token on screen actually opens /pair/* (${probe.ok}) and nothing does without it (${probe.bare})`,
  );

  ok(
    await evaluate(
      cdp,
      `document.querySelector('#pairShow').checked === false
                            && document.querySelector('#pairToken').classList.contains('masked')`,
    ),
    'a freshly minted token is masked, not left legible on screen',
  );
  ok(await evaluate(cdp, `document.querySelector('#pairState').textContent.includes('Paired')`), 'and the state line says so');
}

// ── m4y / §9a.4: the injection-mode dot, and the filter that must not narrow a pass ──────────
//
// Its own book, imported last and opened last, because it needs FOUR modes and every earlier check
// in this file counts on Sample World Book 1 having exactly three entries.
{
  const MODES_BOOK = {
    name: 'Modes',
    entries: {
      0: {
        uid: 0,
        key: ['a'],
        comment: 'Always',
        constant: true,
        disable: false,
        content: 'This one is in every prompt.',
      },
      1: {
        uid: 1,
        key: ['b'],
        comment: 'Keyword',
        constant: false,
        disable: false,
        content: 'This one waits for its keyword.',
      },
      2: {
        uid: 2,
        key: ['c'],
        comment: 'Vector',
        constant: false,
        vectorized: true,
        disable: false,
        content: 'This one is retrieved by similarity.',
      },
      // 🔴 The one that matters: present, keyworded, and injected by nothing.
      3: {
        uid: 3,
        key: ['d'],
        comment: 'Dead',
        constant: false,
        disable: true,
        content: 'This one is skipped entirely by SillyTavern.',
      },
    },
  };
  const mid = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({document: ${JSON.stringify(MODES_BOOK)}})});
        return (await r.json()).id;
    })()`,
  );
  await evaluate(cdp, `wbOpen('books', ${JSON.stringify(mid)})`);
  await mustWait(
    cdp,
    `document.querySelectorAll('#wbFields_books .wbfield').length === 4`,
    'the four-mode book opens with all four entries',
  );

  const dots = await evaluate(
    cdp,
    `(() => {
        return [...document.querySelectorAll('#wbFields_books .wbfield')].map(b => {
            const d = b.querySelector('.wbdot');
            return {mode: b.dataset.mode, cls: d ? d.className : '',
                    glyph: d ? d.textContent : '', tip: d ? d.getAttribute('title') : ''};
        });
    })()`,
  );
  ok(
    dots.map(d => d.mode).join(',') === 'constant,normal,vectorized,disabled',
    `every entry carries its injection mode (${dots.map(d => d.mode).join(',')})`,
  );
  // 🔴 DISABLED MUST NOT READ AS NORMAL. It is present and keyworded and injects nothing; green
  // would tell him it was working. The fork checks `disable` before the tri-state and so do we.
  ok(
    dots[3].mode === 'disabled' && !/mnormal/.test(dots[3].cls),
    'a DISABLED entry is never rendered as normal — it injects nothing and must not look live',
  );
  // 🔴 The color is never the only carrier: the tooltip is the real answer.
  ok(
    dots.every(d => (d.tip || '').length > 20),
    'every dot carries a tooltip that spells the mode out in words, not color alone',
  );
  ok(
    /always injected/i.test(dots[0].tip) && /every/i.test(dots[0].tip),
    `the always-injected tooltip says it costs tokens on every message (${JSON.stringify(dots[0].tip)})`,
  );
  ok(
    dots[0].glyph !== dots[3].glyph && dots[0].glyph !== dots[2].glyph,
    'and the two states most easily misread carry their own glyph, not just their own color',
  );

  // The filter, and the rule that makes it safe.
  const filtered = await evaluate(
    cdp,
    `(async () => {
        const sel = document.getElementById('wbEntryMode_books');
        sel.value = 'constant';
        sel.dispatchEvent(new Event('change'));
        // No pauses in this block: the mode filter's change handler (wire.js), the tick-all
        // click and the preflight rewrite are all synchronous, so each result is final when its
        // call returns. These were two 150 ms sleeps, waiting for nothing.
        const boxes = [...document.querySelectorAll('#wbFields_books .wbfield')];
        document.getElementById('wbAll_books').click();
        return {shown: boxes.filter(b => !b.classList.contains('wbhide')).length,
                ticked: wbTicked('books').length,
                pre: document.getElementById('wbPreflight_books').textContent};
    })()`,
  );
  ok(filtered.shown === 1, `the filter narrows the entry list to the chosen mode (${filtered.shown} shown)`);
  // 🔴 THE RULE FROM THE DESIGN DOC: tick-all over a filtered view means "every entry I can see".
  // Otherwise he filters to Always-injected, ticks all, and runs an instruction over a quarter of
  // the book believing it covered the lot.
  ok(filtered.ticked === 1, `tick all over a filtered list selects only what is visible (${filtered.ticked})`);
  // Safe is not the same as honest: "1 of 1" would be true and would still mislead.
  ok(
    /of 4 fields/.test(filtered.pre) && /3 hidden and NOT in this pass/.test(filtered.pre),
    `and the preflight names the whole book and what it is hiding (${filtered.pre})`,
  );

  // 🔴 m5e / §9a.22 — AND FIND OBEYS THE FILTER, FOR THE SAME REASON THE PASS DOES.
  //
  // The mode filter is books-only. `wbFindScan` collected
  // hits from every `.wbtext` including `.wbhide` ones, so Ctrl+F3 stepped onto a hit inside a
  // `display:none` field — `.focus()` does nothing there, the counter advanced, and the screen
  // sat still. 🔴 And `wbFindReplaceAll` walks the SAME hit list, so a replace was rewriting
  // entries he had filtered off the screen. Asserting the hit list is what covers both.
  const findFiltered = await evaluate(
    cdp,
    `(async () => {
        wbFindOpen('books');
        document.getElementById('wbFindQ_books').value = 'This one';
        wbFindScan('books');
        wbFindGo('books', 1);
        // (A 100 ms sleep stood here. wbFindScan and wbFindGo are synchronous: they pick the hit,
        // focus it and scroll it in the same call.)
        const st = wbState('books');
        const cur = st.find.hits[st.find.at];
        return {hits: st.find.hits.length, at: st.find.at,
                anyHidden: st.find.hits.some(h =>
                    h.ta.closest('.wbfield').classList.contains('wbhide')),
                // 🔴 STRUCTURE, NOT document.activeElement. By this point in the run the books
                // pane's ancestor tab panel is hidden, so focus() is a no-op no matter what
                // wbFindGo targets, and an activeElement assertion would fail for a reason that
                // has nothing to do with the rule. Same lesson as the m4z Add-entry check.
                // (And no backticks in here: this comment is inside a template literal.)
                curHidden: !!(cur && cur.ta.closest('.wbfield').classList.contains('wbhide')),
                curText: cur ? cur.ta.value : '',
                count: document.getElementById('wbFindCount_books').textContent};
    })()`,
  );
  ok(
    findFiltered.hits === 1 && !findFiltered.anyHidden,
    `find searches only the entries the filter is showing (${findFiltered.hits} hit(s))`,
  );
  // 🔴 A keyboard search must scroll the hit into view; `.focus()` on a `display:none` field does
  // nothing, so the browser assertion checks both visibility and focus.
  ok(
    !findFiltered.curHidden && /in every prompt/.test(findFiltered.curText),
    `Ctrl+F3 lands on a field he can actually see (${JSON.stringify(findFiltered.curText)})`,
  );
  // Honest, not merely safe — the same rule the preflight follows two inches away.
  ok(
    /3 hidden by the filter and NOT searched/.test(findFiltered.count),
    `and the count says what it did not search (${findFiltered.count})`,
  );

  const cleared = await evaluate(
    cdp,
    `(async () => {
        const sel = document.getElementById('wbEntryMode_books');
        sel.value = ''; sel.dispatchEvent(new Event('change'));
        // Synchronous handler (filter, preflight and rescan all run inside the dispatch); this
        // was a 150 ms sleep.
        return {shown: [...document.querySelectorAll('#wbFields_books .wbfield')]
                    .filter(b => !b.classList.contains('wbhide')).length,
                hits: wbState('books').find.hits.length,
                pre: document.getElementById('wbPreflight_books').textContent};
    })()`,
  );
  ok(cleared.shown === 4 && !/hidden/.test(cleared.pre), 'clearing the filter brings every entry back and drops the warning with it');
  // 🔴 THE HIT LIST IS REBUILT ON A FILTER CHANGE. Left stale it would still point at rows the
  // filter had just moved, which is the dead Ctrl+F3 again by a slower route.
  ok(cleared.hits === 4, `changing the filter rescans rather than leaving stale hits behind (${cleared.hits})`);
  await evaluate(cdp, `wbFindClose('books')`);
}

// ── m4z / §9a.19: a book created from nothing, and an entry added to it ──────────────────────
//
// The Library supports creating a World Book and adding entries to it.
{
  const made = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/books', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Test World Book 2'})});
        const doc = await r.json();
        await wbOpen('books', doc.id);
        return {id: doc.id, source: doc.source,
                fields: document.querySelectorAll('#wbFields_books .wbfield').length,
                // 🔴 The rule is STRUCTURAL, not "is it painted right now": the button must live
                // OUTSIDE the field list, so an empty book still has the control that fills it.
                // (Visibility would only measure which sub-tab happens to be open here.)
                addOutsideFields: !!document.getElementById('wbAddEntry_books')
                    && !document.getElementById('wbFields_books')
                            .contains(document.getElementById('wbAddEntry_books')),
                text: document.getElementById('wbFields_books').textContent};
    })()`,
  );
  ok(made.source === 'new', `a book Vocalis authored is not marked as uploaded (${made.source})`);
  // §9a.28 item 3 — an empty-state message must name the control that fixes the empty book.
  ok(
    made.fields === 0 && /no entries yet/i.test(made.text) && /Add entry/i.test(made.text),
    'a new World Book opens empty, and says so rather than looking broken',
  );
  // 🔴 THE BUTTON THAT FIXES THE EMPTY STATE MUST EXIST DURING IT. In the field list it would
  // only have appeared once there was already something to add to.
  ok(made.addOutsideFields === true, 'and ✚ Add entry is in the toolbar, so it is reachable while the book is still empty');

  const added = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents/${made.id}/entry?revision=0', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({comment:'Sample Entry 1'})});
        const out = await r.json();
        await wbOpen('books', ${JSON.stringify(made.id)}, out.revision);
        const box = document.querySelector('#wbFields_books .wbfield');
        return {revision: out.revision, fields: document.querySelectorAll('#wbFields_books .wbfield').length,
                label: box ? box.querySelector('b').textContent : '',
                body: box ? box.querySelector('.wbtext').value : '',
                mode: box ? box.dataset.mode : ''};
    })()`,
  );
  ok(
    added.fields === 1 && added.label === 'Sample Entry 1',
    `the new entry is visible in the editor that made it (${added.fields}, ${added.label})`,
  );
  // 🔴 A blank entry would be written to disk perfectly and then skipped by `jobs()` — created,
  // stored, and unreachable from the UI that created it.
  ok(added.body.trim().length > 0, 'and it is born with placeholder text, never blank, or it would be invisible');
  ok(added.mode === 'normal', 'and it carries an injection mode like any other entry');

  // ── m5e / §9a.24: ✚ Add entry puts him IN the new entry, not back at the top ──────────────
  //
  // 🔴 DRIVEN THROUGH THE REAL BUTTON, because the bug is entirely in what happens AFTER the
  // route returns — calling the route directly (as the checks above do) cannot see it. The book
  // is made long enough that "the bottom" and "the top" are different places; with three short
  // entries the page does not scroll and the check would pass against the broken code.
  // 🔴 THE BOOKS SUB-TAB HAS TO BE THE VISIBLE ONE, or `#wbFields_books` sits inside a hidden
  // panel: every `getBoundingClientRect()` is 0x0 and `.focus()` is a no-op, so both assertions
  // below would fail for a reason that has nothing to do with scrolling. Earlier blocks leave
  // the page on Character Cards — the same trap the m4o drag block records.
  // 🔴 THE OUTER TAB TOO, NOT JUST THE SUB-TAB. `section[data-panel="sillytavern"]` is
  // `display:none` by this point in the run — a later block navigated away — and every
  // descendant then has a 0x0 rect no matter which sub-tab is selected. The first attempt at
  // this check switched only the sub-tab and measured 0x0 all the way up to a `SECTION:none`.
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#tabs button')]
        .find(b => b.dataset.tab === 'sillytavern').click()`,
  );
  await evaluate(cdp, `switchStTab('books')`);
  await waitFor(cdp, `document.querySelector('[data-stpanel="books"]').style.display !== 'none'`, 8000);
  ok(
    await waitFor(
      cdp,
      `getComputedStyle(
           document.querySelector('[data-panel="sillytavern"]')).display !== 'none'`,
    ),
    'the SillyTavern section is on screen, so a scroll position means something',
  );
  const landed = await evaluate(
    cdp,
    `(async () => {
        // ⚠️ DRAIN THE ROSTER LOAD BEFORE OPENING ANYTHING. switchStTab fires wbLoadLib and does
        // not await it; wbPlaceEditor parks the editor pane in a .wbslot after the open row, so a
        // roster re-render landing afterward replaces that slot and leaves the pane DETACHED —
        // every rect 0x0 while getComputedStyle still reports the inline display:block. The
        // second load is awaited too, so the row for the book made below exists before wbOpen and
        // the pane is placed in the slot rather than in its fallback home.
        await wbLoadLib('books');
        const big = {name: 'Long Book', entries: {}};
        for (let i = 0; i < 25; i++) {
            big.entries[String(i)] = {uid: i, key: ['k' + i], comment: 'Entry ' + i,
                constant: false, disable: false, order: 100,
                content: ('Filler line for entry ' + i + '. ').repeat(40)};
        }
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify({document: big})});
        const doc = await r.json();
        await wbLoadLib('books');
        await wbOpen('books', doc.id);
        // Instant, so the page IS at the top when this returns. (This was scrollTo(0, 0) followed
        // by a 100 ms sleep to let it get there.)
        window.scrollTo({top: 0, behavior: 'instant'});
        // 🔴 THE PAGE'S SCROLLING IS RECORDED FROM HERE, BY ITS OWN EVENTS. The series below used to
        // be sampled every 100 ms for 1.6 s after the OK press (16 samples), and the verdict was
        // whether the last six agreed: a guess at how long the add takes and how long a
        // wrongly-started animation lasts. Now the add is awaited by its own signal (the cursor is
        // in the new entry), the page gets two frames, and then it is awaited at rest (scrollend).
        // trace is scrollY at every scroll event, in order.
        const trace = [];
        let lastScrollEvent = '';
        const onScroll = () => { trace.push(Math.round(window.scrollY)); lastScrollEvent = 'scroll'; };
        const onScrollEnd = () => { lastScrollEvent = 'end'; };
        window.addEventListener('scroll', onScroll);
        window.addEventListener('scrollend', onScrollEnd);
        // 🔴 DRIVE THE REAL DIALOG — 7.1-m11c. This used to be an assignment stubbing
        // wbAskName, which worked only while wbAddEntry resolved that name off window. open.js
        // IMPORTS it from ui/modal.js now, so the assignment succeeds and is never consulted: the
        // real dialog opens, nothing answers it, and the entry is never added. The three checks
        // below then reported "25 fields" and "never scrolled" — all pointing at appending, none
        // at the stub. §5.12, in its assignment form; the m11b lesson was about calls.
        //
        // ⚠️ NO BACKTICKS IN HERE. This comment sits INSIDE a template literal, and §5 says
        // the file has been bitten twice by exactly that. It was bitten a third time writing this.
        //
        // 📌 The Rename block earlier drives the modal the same way, and it is the better
        // test: it exercises wbAskName for real instead of replacing it.
        document.getElementById('wbAddEntry_books').click();
        for(let i = 0; i < 60 && !document.querySelector('#mBody input[type="text"]'); i++)
            await new Promise(r => setTimeout(r, 50));
        const nameBox = document.querySelector('#mBody input[type="text"]');
        if(!nameBox){
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('scrollend', onScrollEnd);
        }
        if(!nameBox) return {count: -1, label: 'THE ✚ DIALOG NEVER OPENED', settled: false,
                             onScreen: false, top: 0, vh: 0, focused: false,
                             why: 'no #mBody input appeared within 3s of clicking ✚'};
        nameBox.value = 'Appended';
        [...document.querySelectorAll('#mActs button')].find(b => b.textContent === 'OK').click();
        // 🔴 THE SERIES, NOT ONE END-STATE NUMBER. "never scrolled" and "scrolled correctly, then
        // was dragged back by a smooth animation" are different bugs with the same end state, and
        // only the series tells them apart — it was a clean 7914 → 33 decay curve that identified
        // wbScrollToRow as the other party. It is now recorded by the scroll events armed above.
        //
        // First wait for the add to finish: wbLandOnNewEntry focuses the new entry from a
        // requestAnimationFrame, so the cursor being in the 26th field IS the completion signal.
        // Bounded at 20 s; on a hang this falls through and the checks below print what was there.
        const cursorInNewEntry = () => {
            const fs = document.querySelectorAll('#wbFields_books .wbfield');
            const on = document.activeElement;
            return fs.length === 26 && !!on && on.classList.contains('wbtext') && fs[fs.length - 1].contains(on);
        };
        for (let i = 0; i < 400 && !cursorInNewEntry(); i++) await new Promise(res => setTimeout(res, 50));
        // What the entry does after it is focused is the thing under test: only scroll events from
        // here on count towards "nothing drags the page back". The jump itself is dispatched
        // after this point (scroll events fire in the next frame), so it is in the series too.
        const markAt = trace.length;
        // Two frames: the second of wbLandOnNewEntry's scrollIntoView calls runs in the frame after
        // the focus one. Then the page must be at rest: either it never moved (lastScrollEvent is
        // still empty and the loop gives up, bounded at 7.5 s) or the last thing it did was end.
        await ${NEXT_FRAME};
        for (let i = 0; i < 150 && lastScrollEvent !== 'end'; i++) await new Promise(res => setTimeout(res, 50));
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('scrollend', onScrollEnd);
        const fields = [...document.querySelectorAll('#wbFields_books .wbfield')];
        const last = fields[fields.length - 1];
        const box = last.getBoundingClientRect();
        const on = document.activeElement;
        const panel = document.querySelector('[data-stpanel="books"]');
        const host = document.getElementById('wbFields_books');
        const hostBox = host.getBoundingClientRect();
        return {count: fields.length,
                label: last.querySelector('b').textContent,
                // Diagnostics in the message: a 0x0 rect means something upstream is hidden, and
                // "onScreen was false" on its own does not say which thing.
                // The series goes in the failure message: a single end-state number cannot say
                // whether the scroll never happened or happened and was undone.
                why: 'scrollY at each scroll event: ' + trace.join(' ')
                     + ' · host=' + Math.round(hostBox.height) + 'px'
                     + ' · body=' + document.body.scrollHeight + 'px',
                // 🔴 THE PAGE MUST BE STILL. A decaying series is a second scroll fighting this
                // one, which is exactly how this shipped broken: the jump was right and something
                // smoothly pulled it back over the next second and a half.
                // Every scroll event after the cursor landed sits within 4px of where the page
                // finally rested, and nothing is still moving (the last event is not a scroll).
                settled: lastScrollEvent !== 'scroll'
                         && trace.slice(markAt).every(v => Math.abs(v - Math.round(window.scrollY)) < 4),
                // The new row is ON SCREEN — its box overlaps the viewport rather than sitting
                // hundreds of pixels below it, which is what "scrolled back to the top" looks like.
                onScreen: box.top < window.innerHeight && box.bottom > 0,
                top: Math.round(box.top), vh: window.innerHeight,
                focused: !!(on && on.classList.contains('wbtext')
                            && last.contains(on)),
                // 9a.35 — the mandatory field, on the row he just made. A new entry with no
                // keywords cannot be saved (9a.29a), so this is the one control that has to be
                // in front of him without a click. Measured, not inferred: offsetHeight sees
                // through both fold classes AND the accordion.
                keysShown: (() => {
                    const kb = last.querySelector('.wbkeysbody');
                    return !!kb && kb.offsetHeight > 0
                           && !!kb.querySelector('.wbsf[data-name="key"] .wbsv');
                })(),
                // ...and the fold is still shut, so this is not "we opened everything".
                foldShut: last.querySelector('.wbsetbody:not(.wbkeysbody)').hasAttribute('hidden')};
    })()`,
  );
  ok(landed.count === 26 && landed.label === 'Appended', `the entry is appended to a long book (${landed.count} fields, ${landed.label})`);
  // 🔴 The report, in one assertion.
  ok(
    landed.onScreen,
    `adding an entry scrolls to the new entry, not back to the top (top=${landed.top}px of ${landed.vh}px · ${landed.why})`,
  );
  // 🔴 AND IT STAYS THERE. Without this the bug reproduces and the check still passes whenever
  // the sample happens to land early in the animation.
  ok(landed.settled, `and nothing drags the page back afterward (${landed.why})`);
  // Being on screen is not enough — he has to be able to start typing into it.
  ok(landed.focused, 'and the cursor is in the new entry, ready for him to type');
  // Keep required keywords visible without expanding the optional settings fold.
  ok(landed.keysShown, 'and its Primary keywords box is on screen — the field it cannot be saved without');
  ok(landed.foldShut, '…without auto-expanding the ⚙ fold to get there, which was the lesser fix');

  // The empty book cannot be SENT — sending would REPLACE a live book over there with nothing.
  const refused = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/books', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Empty'})});
        const doc = await r.json();
        const s = await fetch('/wbedit/documents/' + doc.id + '/send', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: '{}'});
        return {status: s.status, error: (await s.json()).error || ''};
    })()`,
  );
  ok(refused.status === 400 && /REPLACE/.test(refused.error), `an empty book is refused on the press, with the reason (${refused.status})`);
}

// The roster exposes entry download and import beside the existing row actions.
{
  // The books roster is on screen from the block above. Close whatever it left open, so
  // `openId` staying null is a real statement about the ⬇ click and not about the state it
  // inherited.
  await evaluate(cdp, `wbCloseEditor('books')`);
  await evaluate(cdp, `wbLoadLib('books')`);
  await mustWait(
    cdp,
    `document.querySelectorAll('#wbLib_books .wbrow').length > 0`,
    'the World Books roster is painted for the download checks',
  );

  const shape = await evaluate(
    cdp,
    `(() => {
        const row = document.querySelector('#wbLib_books .wbrow');
        const btns = [...row.querySelectorAll('button')].map(b => b.className);
        return {order: btns.join('|'),
                title: (row.querySelector('.wbdl') || {}).title || '',
                everyRow: [...document.querySelectorAll('#wbLib_books .wbrow')]
                    .every(r => !!r.querySelector('button.wbdl'))};
    })()`,
  );
  // 🔴 THE POSITION IS THE REQUEST — "after, to the right of Open or Close" — and it is also the
  // safe one: 🗑 stays at the far end, so the button that cannot be undone does not move under
  // his cursor.
  ok(/sm wbopen\|sm wbdl\|sm wbdel/.test(shape.order), `⬇ sits between Open/Close and 🗑 on the row (${shape.order})`);
  ok(shape.everyRow === true, 'and every row has one, not just the first');
  ok(/backup/i.test(shape.title), 'and it says what the file is for');

  // 🔴 THE ANCHOR IS INTERCEPTED, NOT THE DOWNLOAD ALLOWED. Headless Chrome would either write a
  // file into the CI machine's download directory or silently refuse — and neither answers the
  // question, which is what NAME the page asked the browser to save. `HTMLAnchorElement.click`
  // is where that name is finally readable, because the element is created and removed inside
  // `wbDownload` and never exists in the DOM for a query to find.
  const got = await evaluate(
    cdp,
    `(async () => {
        const real = HTMLAnchorElement.prototype.click;
        const seen = [];
        HTMLAnchorElement.prototype.click = function(){ seen.push({name: this.download,
                                                                  blob: String(this.href).slice(0, 5)}); };
        try{
            const row = document.querySelector('#wbLib_books .wbrow');
            const name = row.querySelector('b').textContent;
            row.querySelector('.wbdl').click();
            for(let i = 0; i < 300 && !seen.length; i++) await new Promise(r => setTimeout(r, 50));
            return {name, saved: seen[0] || null, opened: wbState('books').openId,
                    msg: document.getElementById('wbMsg_books').textContent};
        } finally { HTMLAnchorElement.prototype.click = real; }
    })()`,
  );
  ok(
    !!got.saved && got.saved.name === got.name + '.json',
    `⬇ saves the book under its own name (${got.saved && got.saved.name} for ${got.name})`,
  );
  // 🔴 A `blob:` href and not the route's URL: that is the whole reason this is a fetch. A
  // navigation would have shown him a page of JSON on any answer that is not a 200.
  ok(
    !!got.saved && got.saved.blob === 'blob:',
    'from bytes the page already has, so a locked vault can be reported instead of navigated to',
  );
  // 🔴 THE ROW IS THE OPEN/CLOSE CONTROL. Without ⬇ being excluded from it, downloading a book
  // also opens it — which on a 110-entry book is a second of layout he did not ask for.
  ok(got.opened == null, `and downloading does not open the book (openId=${got.opened})`);
  ok(/downloaded/i.test(got.msg), 'and the message line says it happened');

  // ── ⬆ Import entry ───────────────────────────────────────────────────────────────────────
  //
  // Synthetic source fixture: a compiled book wrapper around one entry, uid 18, `order` 68, and
  // fields (`outletName`, `triggers`, `matchCreatorNotes`) that
  // are not in this codebase's DEFAULTS and must survive anyway.
  //
  // The destination already has uid 18. Renumber imported entries before insertion so an
  // ad hoc source uid cannot overwrite an existing entry.
  const merged = await evaluate(
    cdp,
    `(async () => {
        const target = {name: 'Sample World Book 4', entries: {'18': {uid: 18, key: ['ledger'],
            comment: 'Occupied 18', order: 100, constant: false, disable: false,
            content: 'The entry that was already here, and must still be here afterward.'}}};
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify({document: target})});
        const doc = await r.json();
        await wbLoadLib('books');
        await wbOpen('books', doc.id);
        const file = {entries: {'18': {uid: 18, key: ['Test Character 5', 'her mom'], keysecondary: [],
            comment: 'Test Character 5', content: 'Test Character 5 is Test Character 6 mother, a software engineer.',
            constant: false, vectorized: false, selective: true, order: 68, position: 0,
            disable: false, probability: 100, depth: 4, outletName: '', triggers: [],
            matchCreatorNotes: false, displayIndex: 18}}};
        const input = document.getElementById('wbEntryFile_books');
        const dt = new DataTransfer();
        dt.items.add(new File([JSON.stringify(file)], 'test-character-5.json', {type: 'application/json'}));
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        // 🔴 WAIT ON THE MESSAGE, NOT ON THE FIELD COUNT. The second field is painted in the
        // MIDDLE of wbImportEntry — wbOpen rebuilds the list, and only after it returns does the
        // function say what it did. A poll that stops at "2 fields" therefore samples the message
        // line while it still reads "reading test-character-5.json…", and the renumbering check below is a
        // coin flip that mostly lands the right way. The message is the last thing to happen, so
        // waiting on it waits for all of it.
        const said = () => document.getElementById('wbMsg_books').textContent;
        for(let i = 0; i < 400 && !/imported/i.test(said()); i++)
            await new Promise(res => setTimeout(res, 50));
        const rev = await (await fetch('/wbedit/documents/' + doc.id + '/revision/'
                                       + wbState('books').rev.n)).json();
        const entries = rev.content.entries;
        return {labels: [...document.querySelectorAll('#wbFields_books .wbfield b')]
                            .map(b => b.textContent),
                msg: said(),
                keys: Object.keys(entries).sort(),
                occupied: entries['18'].content,
                mine: Object.values(entries).find(e => e.comment === 'Test Character 5'),
                buttonOutside: !!document.getElementById('wbImportEntry_books')
                    && !document.getElementById('wbFields_books')
                            .contains(document.getElementById('wbImportEntry_books'))};
    })()`,
  );
  ok(merged.buttonOutside === true, '⬆ Import entry is in the toolbar beside ✚ Add entry, reachable on an empty book');
  ok(merged.labels.includes('Test Character 5'), `the imported entry is in the editor that imported it (${merged.labels.join(', ')})`);
  ok(/The entry that was already here/.test(merged.occupied), 'and the entry that already held uid 18 is untouched');
  ok(
    !!merged.mine && merged.mine.uid !== 18 && merged.keys.includes(String(merged.mine.uid)),
    `the incoming uid is reassigned, and the container key agrees with it (${merged.mine && merged.mine.uid})`,
  );
  // 🔴 The renumbering is the one thing about this operation he cannot see anywhere else.
  ok(/18 → /.test(merged.msg), `and the message line says what it was renumbered to (${merged.msg})`);
  // §10's round-trip rule: what SillyTavern wrote, SillyTavern gets back — including keys this
  // codebase has never named.
  ok(
    !!merged.mine && merged.mine.order === 68 && 'outletName' in merged.mine && 'matchCreatorNotes' in merged.mine,
    'the entry keeps its own order and the fields Vocalis has never heard of',
  );
  ok(
    !!merged.mine && merged.mine.key.join(',') === 'Test Character 5,her mom',
    'and its keywords, or SillyTavern would store it and never fire it',
  );
}

// ── 9.6: ⇄ Import & merge, driven the way he would drive it ───────────────────────────────────
//
// Import updates merge unchanged entries and present conflicts for an explicit choice.
//
// 🔴 EVERY OTHER LAYER OF THIS IS ASSERTED ONE STEP AWAY FROM HIM. The five-row table is proved
// against hand-built dicts, the route is proved with a Flask client, and neither of them has ever
// rendered the dialog — which is the whole feature as far as he is concerned. The failure this
// catches is the one 7.0 already had once: green route tests over a pane that shows nothing.
//
// The browser previews first, then posts the file again with the selected answers. This verifies
// that choices and revision data survive the handoff between those requests.
{
  const merging = await evaluate(
    cdp,
    `(async () => {
        const wait = async (test) => {
            for (let i = 0; i < 400; i++) {
                try { if (test()) return true; } catch (e) {}
                await new Promise(r => setTimeout(r, 50));
            }
            return false;
        };
        const entry = (uid, comment, content) => ({uid, comment, content, key: [comment],
            constant: false, disable: false, order: 100, position: 0});
        const book = (...es) => {
            const out = {};
            es.forEach(e => { out[String(e.uid)] = e; });
            return {name: 'Merge Target', entries: out};
        };

        // Revision 0 - the import, and therefore the merge base.
        const made = await (await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: book(entry(1, 'Ledger', 'the ledger is kept'),
                                                 entry(2, 'Weather', 'it rains'),
                                                 entry(3, 'Harbor', 'the harbor is shut'))})})).json();

        // Revision 1 - HIS edits, through the same route the Save button uses. TWO of them, and
        // that is 9.6.2's doing: with the dialog now pre-selecting the file, one conflict can only
        // ever exercise one of the two answers. Weather is left on its default and Harbor is
        // clicked over to his text, so the apply path is proved BOTH ways in the same round trip.
        await fetch('/wbedit/documents/' + made.id + '/edit', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({revision: 0, edits: [
                {locator: ['entries', '2', 'content'], text: 'it POURS, bitterly'},
                {locator: ['entries', '3', 'content'], text: 'the harbor is SHUT, and mined'}]})});

        await wbLoadLib('books');
        await wbOpen('books', made.id);

        // The file: one entry he never touched (must take the update) and one he did (must ask).
        const file = book(entry(1, 'Ledger', 'the ledger is kept, in a locked room'),
                          entry(2, 'Weather', 'it drizzles'),
                          entry(3, 'Harbor', 'the harbor is open again'));
        const input = document.getElementById('wbMergeFile_books');
        const dt = new DataTransfer();
        dt.items.add(new File([JSON.stringify(file)], 'update.json', {type: 'application/json'}));
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));

        const overlay = document.getElementById('overlay');
        const opened = await wait(() => overlay.classList.contains('on')
                                        && document.querySelectorAll('#mBody .mergeRow').length > 0);
        const rows = [...document.querySelectorAll('#mBody .mergeRow')];
        const labels = rows.map(r => r.querySelector('b').textContent);
        const weather = rows.find(r => r.textContent.indexOf('Weather') >= 0);
        const harbor = rows.find(r => r.textContent.indexOf('Harbor') >= 0);
        const sides = weather ? [...weather.querySelectorAll('.mergeText')].map(t => t.textContent) : [];
        const preset = weather ? weather.querySelector('input[type=radio]:checked').value : '';
        const summary = document.getElementById('mBody').textContent;

        // 🔴 HE TOUCHES ONE ROW AND SKIMS THE OTHER, WHICH IS THE ONLY WAY THIS CLICK STILL MEANS
        // ANYTHING. Until 9.6.2 the scenario clicked "theirs" on the single conflict - and now that
        // the file is the pre-selected answer, that click sets a radio to the value it already had.
        // The assertion under it would then pass on a build that dropped the choice map entirely.
        // So the click moves a row AWAY from the default, and Weather is left exactly as the
        // dialog drew it. (No backticks in here: this comment is inside a template literal.)
        if (harbor) harbor.querySelector('input[value=mine]').click();
        const apply = [...document.getElementById('mActs').querySelectorAll('button')]
                          .find(b => b.textContent === 'Apply');
        apply.click();

        // The message is the LAST thing wbMergeImport does - wbOpen repaints first - so waiting on
        // it waits for all of it. Same rule the Import entry scenario records one screen up.
        const said = () => document.getElementById('wbMsg_books').textContent;
        const reported = await wait(() => said().indexOf('merged as revision') >= 0);
        const doc = await (await fetch('/wbedit/documents/' + made.id)).json();
        const head = await (await fetch('/wbedit/documents/' + made.id + '/revision/'
                                        + doc.latest)).json();
        const by = {};
        Object.values(head.content.entries).forEach(e => { by[e.comment] = e.content; });
        return {opened, reported, labels, sides, preset, summary, msg: said(),
                latest: doc.latest, by, revs: doc.revision_index};
    })()`,
  );

  ok(merging.opened === true, 'picking a file opens the merge dialog with something in it');
  // 🔴 THE DECISIONS, AND ONLY THE DECISIONS. A pane that also lists the entry it resolved on its
  // own is a pane he scrolls, and the whole value of the feature is that what he has to read is
  // small. `Ledger` took the update without asking; `Weather` is the one he has to look at.
  ok(
    merging.labels.length === 2 && merging.labels.join(',') === 'Weather,Harbor',
    `only the entries that need him are listed (${JSON.stringify(merging.labels)})`,
  );
  ok(merging.summary.indexOf('2 things need you') >= 0, `and the dialog counts them in words (${merging.summary.slice(0, 120)})`);
  ok(
    merging.sides.length === 2 && merging.sides[0].indexOf('POURS') >= 0 && merging.sides[1].indexOf('drizzles') >= 0,
    `both versions are on screen to compare, his first (${JSON.stringify(merging.sides)})`,
  );
  // 🔴 9.6.2: The imported version is the default selection. This check used to assert the
  // opposite; a merge mints
  // its result ON TOP of his head, so his text is one step back in the revision picker whatever he
  // answers — while the file he just picked is stored nowhere at all, so a skimmed dialog full of
  // "keep mine" is the only outcome that destroys writing. See `fieldPicker`.
  ok(merging.preset === 'theirs', `and the pre-selected answer takes the file (${merging.preset})`);

  ok(merging.reported === true, `applying reports what it did (${merging.msg})`);
  ok(merging.latest === 2, `one revision was minted, not two (latest ${merging.latest})`);
  ok(merging.by.Ledger === 'the ledger is kept, in a locked room', `the entry he never touched took the update (${merging.by.Ledger})`);
  // 🔴 THE ROW HE NEVER TOUCHED, WHICH IS WHAT THE DEFAULT IS FOR. Nothing was clicked on
  // Weather: this is the dialog's own pre-selection traveling all the way into the document.
  ok(merging.by.Weather === 'it drizzles', `a conflict he skimmed past took the file (${merging.by.Weather})`);
  // The choice he made in a radio button survived a modal, a second multipart upload, the route's
  // validation and the applier. That whole chain has no other test — and it is only a test at all
  // because this click moves the row AWAY from what the dialog had already selected.
  ok(merging.by.Harbor === 'the harbor is SHUT, and mined', `and the one he clicked "Keep mine" on kept his (${merging.by.Harbor})`);
  // 🔴 THE MERGE IS THE NEW RECONCILIATION POINT. Without this the NEXT file would be compared
  // against revision 0 and would re-ask every question this dialog just settled.
  ok(
    Array.isArray(merging.revs) && (merging.revs.find(r => r.n === 2) || {}).kind === 'import',
    `the revision it wrote is marked as the new base (${JSON.stringify(merging.revs)})`,
  );
}

// ── 9.6: the CARD merge dialog, which is the one that shipped wrong ───────────────────────────
//
// The summary must report card-field conflicts even when the embedded lorebook is empty.
//
// 🔴 THE SUMMARY WAS BUILT FROM THE ENTRY TALLY ALONE. A card with no embedded lorebook has zero
// entries, so every count was zero and the "nothing differs" sentence fired over a conflict the
// same dialog was already listing underneath it. Neither the merge specs nor the route specs could
// see it: both are right, and the lie was assembled in the browser out of two correct answers.
//
// The same dialog covers the three answer choices and highlights the user's edits in the card's
// field panes.
{
  const cardMerge = await evaluate(
    cdp,
    `(async () => {
        const wait = async (test) => {
            for (let i = 0; i < 400; i++) {
                try { if (test()) return true; } catch (e) {}
                await new Promise(r => setTimeout(r, 50));
            }
            return false;
        };
        const card = (desc) => ({spec: 'chara_card_v2', spec_version: '2.0', data: {
            name: 'Test Merge Character', description: desc, personality: 'quick', scenario: 'the plains',
            first_mes: 'Hey.', mes_example: ''}});
        // 🔴 This fixture exceeds the former 400-character preview limit and has a distinctive
        // final word, so the check can detect truncation.
        // Long enough to overflow the pane's 18em cap, not merely longer than the old cut: the
        // scroll check below is what proves an untruncated pane BOUNDS itself rather than
        // growing the dialog forever, and at 12 repeats it fitted and the check was vacuous.
        const filler = 'She runs the ridge line every morning and counts the carts. '.repeat(40);

        // Revision 0 - the import, and the merge base.
        const made = await (await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: card('a scout')})})).json();

        // Revision 1 - HIS edit, through the route the Save button uses.
        await fetch('/wbedit/documents/' + made.id + '/edit', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({revision: 0, edits: [
                {locator: ['data', 'description'],
                 text: 'a scout. ' + filler + 'and the fastest of the pair'}]})});

        await wbLoadLib('cards');
        await wbOpen('cards', made.id);

        const input = document.getElementById('wbMergeFile_cards');
        const dt = new DataTransfer();
        dt.items.add(new File([JSON.stringify(card('a seasoned scout'))], 'test-merge-character.json',
                              {type: 'application/json'}));
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));

        const overlay = document.getElementById('overlay');
        const opened = await wait(() => overlay.classList.contains('on')
                                        && document.querySelectorAll('#mBody .mergeRow').length > 0);
        const summary = document.getElementById('mBody').textContent;
        const row = document.querySelector('#mBody .mergeRow');
        const panes = [...row.querySelectorAll('.mergeText')];
        const greens = [...panes[0].querySelectorAll('ins')].map(n => n.textContent);
        const yoursText = panes[0].textContent;
        const answers = [...row.querySelectorAll('input[type=radio]')].map(r => r.value);
        const box = row.querySelector('textarea.mergeEdit');
        const seed = box ? box.value : '';
        const hiddenAtFirst = box ? !box.classList.contains('on') : null;

        // He takes the third answer and writes the two together.
        row.querySelector('input[value=edited]').click();
        const shownAfterPick = box.classList.contains('on');
        box.value = 'a seasoned scout, and the fastest of the pair';
        // The scrollHeight is what a resizable, scrolling pane has that a truncated one does not:
        // there is more text than the box shows, and all of it is really in the DOM.
        const scrolls = panes[0].scrollHeight > panes[0].clientHeight;

        const panel = overlay.querySelector('.modal');
        const roomy = {wide: panel.classList.contains('wide'), tall: panel.classList.contains('tall')};

        [...document.getElementById('mActs').querySelectorAll('button')]
            .find(b => b.textContent === 'Apply').click();
        const said = () => document.getElementById('wbMsg_cards').textContent;
        const reported = await wait(() => said().indexOf('merged as revision') >= 0);
        const doc = await (await fetch('/wbedit/documents/' + made.id)).json();
        const head = await (await fetch('/wbedit/documents/' + made.id + '/revision/'
                                        + doc.latest)).json();
        return {opened, summary, greens, answers, seed, hiddenAtFirst, shownAfterPick, roomy,
                reported, description: head.content.data.description,
                yoursLen: yoursText.length, tail: yoursText.slice(-28), scrolls,
                ellipsis: yoursText.indexOf('…') >= 0};
    })()`,
  );

  ok(cardMerge.opened === true, 'a character card opens the merge dialog too');
  // 🔴 The editor and library row must show the same pending state.
  ok(
    cardMerge.summary.indexOf('Nothing in this file differs') < 0,
    `the summary does not claim nothing differs while listing a decision (${cardMerge.summary.slice(0, 140)})`,
  );
  ok(
    cardMerge.summary.indexOf('1 field to decide') >= 0,
    `it counts the card's FIELDS, which is where a card keeps everything (${cardMerge.summary.slice(0, 140)})`,
  );
  // 🔴 "if you just showed me what I edited in the top box over the previous version... green"
  ok(
    cardMerge.greens.join(' ').indexOf('the fastest of the pair') >= 0,
    `the selected edit is marked green in the top pane (${JSON.stringify(cardMerge.greens)})`,
  );
  ok(cardMerge.answers.join(',') === 'mine,theirs,edited', `there are three answers, not two (${cardMerge.answers.join(',')})`);
  // "when I edit, start with the imported version as the template"
  ok(cardMerge.seed === 'a seasoned scout', `the edit box starts from the FILE (${cardMerge.seed})`);
  ok(cardMerge.hiddenAtFirst === true && cardMerge.shownAfterPick === true, 'and it stays out of the way until that answer is chosen');
  ok(cardMerge.roomy.wide && cardMerge.roomy.tall, 'the dialog is wide, and scrolls its own body so Apply stays reachable');
  // 🔴 "you're truncating the text with dots" — the whole entry is in the pane, and the pane
  // scrolls rather than the text being cut. The old build capped this at 400 characters.
  ok(cardMerge.yoursLen > 700 && !cardMerge.ellipsis, `the pane holds the whole entry with no ellipsis (${cardMerge.yoursLen} chars)`);
  ok(
    cardMerge.tail.indexOf('the fastest of the pair') >= 0,
    `including its last words, which the old 400-character cut ate (${JSON.stringify(cardMerge.tail)})`,
  );
  ok(cardMerge.scrolls === true, 'and it scrolls rather than growing the dialog without limit');
  ok(cardMerge.reported === true, 'applying a card merge reports what it did');
  // The whole chain: a textarea he typed into, through a modal, a second multipart upload, the
  // route's orphan check and the applier.
  ok(
    cardMerge.description === 'a seasoned scout, and the fastest of the pair',
    `and what he typed is what landed (${cardMerge.description})`,
  );
}

// ── m5d / §9a.21: every card field is on the page, and machinery arrives unticked ────────────
//
// Render alternate greetings from the character-card data.
//
// 🔴 ONLY A BROWSER CAN ANSWER THE SECOND HALF. The route test proves `pass_default` crosses the
// wire; it cannot see whether the renderer turned that into a `checked` attribute, and the two
// failure modes are opposite and both bad — ticked machinery means an instruction meant for
// character prose rewrites a system prompt, and an unticked description means his ordinary pass
// silently skips the field he actually cares about.
//
// ⚠️ Structure and state, never `offsetParent`: by this point in the run an ancestor tab panel is
// hidden, and a visibility assertion here fails for a reason that has nothing to do with the rule.
{
  const CARD = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Ninefield',
      description: 'Keeps her own counsel.',
      personality: 'Wry.',
      scenario: 'A tavern.',
      first_mes: 'You again.',
      mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Hm.',
      creator_notes: 'Do not redistribute.',
      system_prompt: 'You are {{char}}. Never break character.',
      post_history_instructions: 'Stay in scene.',
      alternate_greetings: ['The door was already open.', '   ', 'Late again.'],
    },
  });
  const shown = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: ${CARD}})});
        const doc = await r.json();
        await wbOpen('cards', doc.id);
        const rows = [...document.querySelectorAll('#wbFields_cards .wbfield')].map(b => ({
            label: b.querySelector('b').textContent,
            ticked: b.querySelector('.wbtick').checked,
        }));
        return {rows, ticked: wbTicked('cards').length,
                pre: document.getElementById('wbPreflight_cards').textContent};
    })()`,
  );
  const labels = shown.rows.map(r => r.label);
  const tickOf = l => (shown.rows.find(r => r.label === l) || {}).ticked;

  ok(
    labels.includes('alternate_greetings[0]') && labels.includes('alternate_greetings[2]'),
    `each alternate greeting is its own field, blanks skipped (${labels.join(' · ')})`,
  );
  // 🔴 THE INDEX IS THE ORIGINAL ONE. '[1]' here would mean the blank was compacted away, and
  // an edit would then be written onto the wrong greeting.
  ok(
    !labels.includes('alternate_greetings[1]'),
    'and the indices are the ORIGINAL ones, so an edit lands on the greeting he is looking at',
  );
  ok(
    ['creator_notes', 'system_prompt', 'post_history_instructions'].every(f => labels.includes(f)),
    'creator notes, system prompt and post-history instructions are on the page too',
  );
  ok(
    ['description', 'personality', 'scenario', 'first_mes', 'mes_example'].every(f => tickOf(f) === true),
    'the prose fields arrive ticked, exactly as before',
  );
  ok(
    ['creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings[0]', 'alternate_greetings[2]'].every(
      f => tickOf(f) === false,
    ),
    'and the machinery arrives UNTICKED — I13 is a rule about passes, not about eyesight',
  );
  ok(shown.ticked === 5 && /5 of 10 fields/.test(shown.pre), `the preflight counts all ten and selects five (${shown.pre})`);
}

// ── 7.4 / §9a.32: the field that is not on the card YET ──────────────────────────────────────
//
// Expose additional character-card fields so existing values can be edited.
//
// 🔴 ONLY A BROWSER CAN ANSWER THE HALF THAT MATTERS. The route test proves the empty row crosses
// the wire unticked; it cannot see that the checkbox is DISABLED, and `checked = true` on a
// disabled box succeeds — so ⊕ tick all would select fields the server refuses to collect for a
// pass, the preflight would count them, and Run would silently drop them. Visible, tickable,
// counted, dead: the exact shape this pane has shipped twice before.
{
  const THIN = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Sparse', description: 'Nothing else is filled in.' },
  });
  const got = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: ${THIN}})});
        const doc = await r.json();
        await wbOpen('cards', doc.id);
        const row = l => [...document.querySelectorAll('#wbFields_cards .wbfield')]
            .find(b => b.querySelector('b').textContent === l);
        const sys = row('system_prompt');
        const before = {
            present: !!sys,
            disabled: sys ? sys.querySelector('.wbtick').disabled : null,
            tagged: sys ? /empty/i.test(sys.textContent) : null,
            body: sys ? sys.querySelector('.wbtext').value : null,
            filled: row('description') ? row('description').querySelector('.wbtick').disabled : null,
        };
        // ⊕ tick all — the verb that used to reach every checkbox on the page.
        document.getElementById('wbAll_cards').click();
        const after = {
            sysTicked: sys ? sys.querySelector('.wbtick').checked : null,
            counted: wbTicked('cards').length,
            pre: document.getElementById('wbPreflight_cards').textContent,
        };
        return {id: doc.id, before, after};
    })()`,
  );
  ok(got.before.present === true, 'a card field with no text still gets a row, so it can be given a first value');
  ok(
    got.before.body === '' && got.before.tagged === true,
    'the row is empty and says so rather than looking like a field that lost its text',
  );
  ok(
    got.before.disabled === true && got.before.filled === false,
    'its checkbox is disabled — and a field that HAS text is untouched by that',
  );
  // 🔴 The one a route test cannot reach.
  ok(got.after.sysTicked === false, '⊕ tick all does not select it, so no pass can be built out of fields the server drops');
  ok(
    got.after.counted === 1 && /1 of 1 field/.test(got.after.pre),
    `and the preflight counts only the field a pass can actually reach (${got.after.pre})`,
  );

  // The other half: typing into it and saving really does put the field on the card.
  const saved = await evaluate(
    cdp,
    `(async () => {
        const sys = [...document.querySelectorAll('#wbFields_cards .wbfield')]
            .find(b => b.querySelector('b').textContent === 'system_prompt');
        const ta = sys.querySelector('.wbtext');
        ta.value = 'Answer only in character.';
        ta.dispatchEvent(new Event('input'));
        await wbSaveEdits('cards');
        for(let i = 0; i < 100 && wbState('cards').rev.n === 0; i++)
            await new Promise(r => setTimeout(r, 50));
        const rev = await (await fetch('/wbedit/documents/' + ${JSON.stringify(got.id)}
                                       + '/revision/' + wbState('cards').rev.n)).json();
        const now = [...document.querySelectorAll('#wbFields_cards .wbfield')]
            .find(b => b.querySelector('b').textContent === 'system_prompt');
        return {stored: rev.content.data.system_prompt,
                stillDisabled: now ? now.querySelector('.wbtick').disabled : null};
    })()`,
  );
  ok(
    saved.stored === 'Answer only in character.',
    'typing into the empty row and pressing Save puts the field on the card for the first time',
  );
  ok(saved.stillDisabled === false, 'and it is an ordinary field from then on — text, and a checkbox a pass can use');
}

// ── m5g / §9a.26: the typed settings fold ────────────────────────────────────────────────────
//
// Preserve the supported World Book entry settings and their null/default distinctions.
//
// 🔴 THE CHECK THAT MATTERS IS THE ONE THAT WRITES NOTHING. `sticky: null` means "not set" and
// `sticky: 0` means "explicitly none". A number box that renders null as empty and reads empty back
// as 0 rewrites every entry whose fold he merely OPENS — across a whole book, in a save he made for
// an unrelated reason, with nothing in either product to tell him. The route tests can prove
// `coerce` keeps the two apart; only a browser can prove the WIDGET does.
//
// ⚠️ Structure and state, never `offsetParent` — by here the SillyTavern panel is on a hidden outer
// tab and every rect is 0×0.
{
  await evaluate(cdp, `switchStTab('books')`);
  const SETBOOK = JSON.stringify({
    name: 'Settings',
    entries: {
      0: {
        uid: 0,
        key: ['ledger'],
        comment: 'Sample Entry 1',
        constant: false,
        order: 100,
        sticky: null,
        caseSensitive: null,
        position: 0,
        content: 'Test Character 1 keeps the ledger.',
      },
      1: {
        uid: 1,
        key: ['weather'],
        comment: 'Weather',
        constant: false,
        order: 100,
        content: 'The rains come off the estuary.',
      },
    },
  });

  const drawn = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: ${SETBOOK}, name: 'Settings'})});
        const doc = await r.json();
        window.__setDoc = doc.id;
        await wbOpen('books', doc.id);
        const box = document.querySelector('#wbFields_books .wbfield');
        const body = box.querySelector('.wbsetbody:not(.wbkeysbody)');
        const before = body.innerHTML.length;
        box.querySelector('.wbsetog').click();
        // 9a.35 — key is no longer in the fold, so the lookup asks the row rather than the fold.
        // Deliberately NOT split into two helpers: the point of this block is that every typed
        // control is drawn correctly, and which BODY each lives in is 9a.35's business, asserted
        // on its own below (keyOutsideFold).
        const ctl = n => box.querySelector('.wbsf[data-name="' + n + '"]');
        const q = n => { const l = ctl(n); return l && l.querySelector('.wbsv'); };
        return {
            lazy: before === 0 && body.innerHTML.length > 0,
            open: !body.hasAttribute('hidden'),
            sticky: q('sticky') && q('sticky').type,
            stickyValue: q('sticky') ? q('sticky').value : null,
            constant: q('constant') && q('constant').type,
            position: q('position') && q('position').tagName,
            positionValue: q('position') ? q('position').value : null,
            caseSensitive: q('caseSensitive') ? q('caseSensitive').value : null,
            key: q('key') ? q('key').value : null,
            groups: [...body.querySelectorAll('.wbsetgrp > h5')].map(h => h.textContent),
            // 9a.35 — the mandatory field is OUTSIDE the fold and the optional ones are inside.
            keyOutsideFold: !!ctl('key') && !!ctl('key').closest('.wbkeysbody')
                            && !body.querySelector('.wbsf[data-name="key"]'),
            edits: wbSetEdits('books').length,
            dirty: box.classList.contains('wbdirty'),
        };
    })()`,
  );

  ok(drawn.lazy && drawn.open, 'the settings fold is built on first open, not with the row');
  ok(
    drawn.sticky === 'number' && drawn.constant === 'checkbox' && drawn.position === 'SELECT' && drawn.key === 'ledger',
    `each field gets its own control type (sticky=${drawn.sticky} constant=${drawn.constant} ` +
      `key-outside-fold=${drawn.keyOutsideFold} ` +
      `position=${drawn.position} key=${drawn.key})`,
  );
  // 🔴 §9a.35 — AND THE MANDATORY ONE IS NOT IN THE FOLD. Asserted in BOTH directions: the
  // control is inside `.wbkeysbody`, AND the fold does not also carry one. A half-move that left
  // a second copy behind would look right on screen and give Save two controls for one field.
  ok(drawn.keyOutsideFold, `Primary keywords sits outside the ⚙ fold, and only there (${drawn.keyOutsideFold})`);
  // 🔴 THE TRI-STATE, DRAWN. An unset sticky is a BLANK box — not a 0 — and the nullable bool
  // says "use global" rather than showing an unticked checkbox that claims he chose No.
  ok(drawn.stickyValue === '', `an unset sticky renders blank, never 0 (${JSON.stringify(drawn.stickyValue)})`);
  ok(drawn.caseSensitive === 'null', `a nullable boolean offers 'use global' and is on it (${drawn.caseSensitive})`);
  // 🔴 AND OPENING IT IS NOT AN EDIT. This is the assertion the whole milestone turns on, and it
  // FAILED FIRST TIME WITH 28: most of the 38 keys are simply absent from a real swept entry, an
  // untouched control still renders as something (an unticked checkbox reads back `false`, a
  // select sits on its first option), and every one of those differs from "absent". A save made
  // for an unrelated reason would have written 28 fields into an entry he only glanced at.
  ok(drawn.edits === 0 && !drawn.dirty, `opening the fold proposes no edits at all (${drawn.edits})`);
  // The same rule from the other side: an entry missing nearly every key must still propose
  // nothing. Entry 1 in this book has neither `sticky` nor `position` nor any of the flags.
  const bare = await evaluate(
    cdp,
    `(async () => {
        const box = [...document.querySelectorAll('#wbFields_books .wbfield')][1];
        box.querySelector('.wbsetog').click();
        const body = box.querySelector('.wbsetbody:not(.wbkeysbody)');
        return {controls: body.querySelectorAll('.wbsf').length, edits: wbSetEdits('books').length};
    })()`,
  );
  ok(
    bare.controls > 30 && bare.edits === 0,
    `an entry missing nearly every key proposes nothing either (${bare.controls} controls, ${bare.edits} edits)`,
  );
  ok(drawn.groups.length >= 6 && drawn.groups[0] === 'Identity', `the settings are grouped, Identity first (${drawn.groups.join(' · ')})`);

  // Change something ELSE and save. The untouched nullable must still be null afterward — the
  // end-to-end form of the bug: a save made for one reason silently rewriting a field it merely
  // rendered.
  const saved = await evaluate(
    cdp,
    `(async () => {
        const body = document.querySelector('#wbFields_books .wbfield .wbsetbody:not(.wbkeysbody)');
        const ord = body.querySelector('.wbsf[data-name="order"] .wbsv');
        ord.value = '250';
        ord.dispatchEvent(new Event('input', {bubbles: true}));
        const dirtyBefore = document.querySelector('#wbFields_books .wbfield').classList.contains('wbdirty');
        const proposed = wbSetEdits('books');
        await wbSaveEdits('books');
        const d = await (await fetch('/wbedit/documents/' + window.__setDoc)).json();
        const rev = await (await fetch('/wbedit/documents/' + window.__setDoc + '/revision/' + d.latest)).json();
        const e = rev.content.entries['0'];
        return {dirtyBefore, proposed: proposed.length, latest: d.latest,
                order: e.order, orderType: typeof e.order,
                sticky: e.sticky, hasSticky: 'sticky' in e,
                stillOpen: !document.querySelector('#wbFields_books .wbfield .wbsetbody:not(.wbkeysbody)').hasAttribute('hidden'),
                content: e.content};
    })()`,
  );

  ok(
    saved.dirtyBefore && saved.proposed === 1,
    `changing one control marks the row and proposes exactly that one edit (${saved.proposed})`,
  );
  ok(
    saved.latest === 1 && saved.order === 250 && saved.orderType === 'number',
    `the value lands as a NUMBER in one new revision (rev ${saved.latest}, order ${JSON.stringify(saved.order)} ${saved.orderType})`,
  );
  // 🔴 THE DATA-LOSS ASSERTION. Without the null/0 distinction this reads 0 and the entry has
  // silently become explicitly-non-sticky.
  ok(saved.hasSticky && saved.sticky === null, `an untouched nullable is still 'not set' after the save (${JSON.stringify(saved.sticky)})`);
  ok(saved.content === 'Test Character 1 keeps the ledger.', 'and the prose is untouched by a settings save');
  ok(saved.stillOpen, 'the fold he was working in is still open after the save');
}

// ── m4p / §9a.10: the roster face is a thumbnail, and a miss falls back ───────────────────────
//
// Request visible Library faces eagerly so the roster does not show late-arriving images.
//
// 🔴 ONLY A BROWSER CAN ANSWER THE PART THAT MATTERS, which is that the crop is applied ONCE. The
// server bakes the rect into the thumbnail, so `wbFaceHtml` must NOT also hand the row a
// `data-focus` — `wbFitFace` would then crop the crop, and the circle would show a corner of a
// face. The route tests cannot see that; it lives entirely in what the renderer emits.
{
  await evaluate(cdp, `switchStTab('cards')`);
  // A real 1×1 PNG. Small enough to inline, valid enough for Pillow — the point here is the
  // wiring, and `test_wbedit_thumbs.py` is where the pixels are checked.
  const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const face = await evaluate(
    cdp,
    `(async () => {
        await wbLoadLib('cards');
        const r = await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: {spec: 'chara_card_v2', spec_version: '2.0',
                data: {name: 'Thumbnail', description: 'x', first_mes: 'y'}}, name: 'Thumbnail'})});
        const doc = await r.json();
        const bin = Uint8Array.from(atob('${PNG1}'), c => c.charCodeAt(0));
        await fetch('/wbedit/documents/' + doc.id + '/avatar',
                    {method: 'POST', headers: {'Content-Type': 'image/png'}, body: bin});
        await fetch('/wbedit/documents/' + doc.id + '/focus',
                    {method: 'POST', headers: {'Content-Type': 'application/json'},
                     body: JSON.stringify({focus: {x: 0.1, y: 0.2, w: 0.5}})});
        await wbLoadLib('cards');
        const div = [...document.querySelectorAll('#wbLib_cards .wbface')]
            .find(d => d.dataset.id === doc.id);
        const img = div && div.querySelector('img');
        const t = await fetch('/wbedit/documents/' + doc.id + '/thumb');
        return {
            id: doc.id,
            src: img ? img.getAttribute('src') : null,
            hasFocus: div ? div.hasAttribute('data-focus') : null,
            focusFull: div ? div.dataset.focusFull : null,
            eager: img ? (img.getAttribute('loading') || '') : null,
            priority: img ? img.getAttribute('fetchpriority') : null,
            status: t.status, type: t.headers.get('Content-Type'),
            cache: t.headers.get('Cache-Control'),
            etag: t.headers.get('ETag'),
        };
    })()`,
  );

  ok(
    (face.src || '').split('?')[0] === '/wbedit/documents/' + face.id + '/thumb',
    `the roster face asks for the thumbnail, not the full card (${face.src})`,
  );
  // 🔴 9.7.7 — AND IT IS STAMPED, WHICH IS WHAT MAKES A REPLACED FACE APPEAR. The pixels are
  // checked below, where Node does the write; this is the shape, and it is asserted against the
  // ETAG because the URL's token and the conditional request's tag must be the same string —
  // a URL that changes while the 304 keeps answering is worse than no token at all.
  ok(
    /[?&]v=[0-9a-f]{16}$/.test(face.src || '') && (face.etag || '').includes((face.src || '').split('v=')[1] || 'x'),
    `and carries the thumbnail's own cache key, the same one the ETag is built from (${face.src} vs ${face.etag})`,
  );
  // 🔴 THE CROP IS APPLIED ONCE. `data-focus` here would make wbFitFace crop the crop.
  ok(face.hasFocus === false, 'and carries no data-focus, because the server already applied the rect');
  // ⚠️ PARSED, NOT STRING-COMPARED. The rect round-trips through meta.json and comes back with
  // its keys in a different order; asserting on the serialized form tests the JSON encoder.
  ok(
    face.focusFull && JSON.parse(face.focusFull).x === 0.1 && JSON.parse(face.focusFull).y === 0.2 && JSON.parse(face.focusFull).w === 0.5,
    `but keeps the rect for the fallback (${face.focusFull})`,
  );
  // m4d's rule survives m4p: the faces are the content he came to look at.
  ok(
    face.eager === '' && face.priority === 'high',
    `still eager and high priority (loading=${JSON.stringify(face.eager)} fetchpriority=${face.priority})`,
  );
  ok(face.status === 200 && /webp/.test(face.type || ''), `the route serves a WebP (${face.status} ${face.type})`);
  ok(
    /no-cache/.test(face.cache || '') && !/max-age/.test(face.cache || ''),
    `and never lets the browser hold a stale crop (${face.cache})`,
  );

  // 🔴 THE DEGRADE PATH, DRIVEN. §9a.10: "a miss must degrade to serving the full image, not to
  // a broken circle." Fired directly, because provoking a real 415 needs an undecodable PNG and
  // the interesting half is what the handler does, not what triggered it.
  const fell = await evaluate(
    cdp,
    `(async () => {
        const div = [...document.querySelectorAll('#wbLib_cards .wbface')]
            .find(d => d.dataset.id === '${face.id}');
        const img = div.querySelector('img');
        wbFaceFallback(img);
        const after = {src: img.getAttribute('src'), focus: div.dataset.focus,
                       present: !!div.querySelector('img')};
        // Again — a 404 on the fallback must not ping-pong the two src assignments forever.
        wbFaceFallback(img);
        return {...after, goneOnSecond: !div.querySelector('img'),
                initial: !!div.querySelector('.wbinitial')};
    })()`,
  );

  ok(
    fell.present && (fell.src || '').split('?')[0] === '/wbedit/documents/' + face.id + '/avatar',
    `a thumbnail miss falls back to the full avatar (${fell.src})`,
  );
  // 9.7.7 — the degraded path is stamped too, from `data-avatar-at`. Without it a row that falls
  // back after a replaced picture paints the OLD avatar out of the memory cache, which reads as
  // the fallback being broken rather than as a stale byte.
  ok(/[?&]v=[0-9a-f]+-[0-9a-f]+$/.test(fell.src || ''), `and the fallback URL is stamped as well (${fell.src})`);
  ok(
    fell.focus && JSON.parse(fell.focus).x === 0.1 && JSON.parse(fell.focus).w === 0.5,
    `and restores the rect so the browser crops it correctly (${fell.focus})`,
  );
  ok(fell.goneOnSecond && fell.initial, 'a second failure drops the img and uncovers the initial, rather than looping');
}

// ── m4k / §9a.5: a card's embedded lorebook reads as part of the card ────────────────────────
//
// Hide embedded book entries from the character-card fields shown in the editor.
//
// 🔴 THE HEADING IS DRAWN ONCE, AND IT HAS TO VANISH WITH THE LAST ROW IT LABELS. A heading left
// standing after the m4y mode filter empties its group would float over the NEXT section and label
// that — a worse lie than the label this was added to fix, and one only a browser can see.
{
  await evaluate(cdp, `switchStTab('cards')`);
  const CARDBOOK = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Test Character 13',
      description: 'Keeps her own counsel.',
      first_mes: 'Hello.',
      extensions: { world: '' },
      character_book: {
        name: 'Notes',
        entries: [
          { id: 0, comment: 'Her childhood home', content: 'A blue house.', constant: true },
          { id: 1, content: 'An entry nobody named.' },
        ],
      },
    },
  });
  const grouped = await evaluate(
    cdp,
    `(async () => {
        await wbLoadLib('cards');
        const r = await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: ${CARDBOOK}})});
        const doc = await r.json();
        await wbLoadLib('cards');
        await wbOpen('cards', doc.id);
        const host = document.getElementById('wbFields_cards');
        const kids = [...host.children].map(el => ({tag: el.tagName,
            cls: el.className, text: el.tagName === 'H4' ? el.textContent : null,
            label: el.querySelector('b') ? el.querySelector('b').textContent : null}));
        return {id: doc.id, kids,
                heads: kids.filter(k => k.tag === 'H4').length,
                ticked: wbTicked('cards').length,
                // 🔴 §9a.32 — THE FIELDS THAT COULD BE TICKED, not every row on the page. A card
                // draws a row for each field it does not carry yet so a first value can be typed
                // into it, and those can never be in a pass — counting them here would turn "is
                // anything silently unticked?" into "does this card fill in every field?", which
                // checks whether the renderer exposes every field, independently of its prose.
                total: wbState('cards').fields.filter(f => !f.empty).length};
    })()`,
  );

  const labels = grouped.kids.filter(k => k.label).map(k => k.label);
  ok(
    labels.includes('card book · Her childhood home') && labels.includes('card book · entry 1'),
    `an embedded entry says it belongs to the card (${labels.join(' · ')})`,
  );
  ok(grouped.heads === 1, `and one heading is drawn for the group, not one per row (${grouped.heads})`);
  // The heading must come BEFORE the entries it labels and AFTER the card's own fields.
  const headAt = grouped.kids.findIndex(k => k.tag === 'H4');
  const firstBook = grouped.kids.findIndex(k => k.label && k.label.startsWith('card book'));
  ok(headAt > 0 && headAt < firstBook, `the heading sits above the entries and below the card's own fields (${headAt} < ${firstBook})`);
  ok(
    /inside this card/i.test((grouped.kids[headAt] || {}).text || ''),
    `and it says the lorebook is inside the card (${(grouped.kids[headAt] || {}).text})`,
  );
  // 🔴 VISIBLE AND TICKED. A rename sweep must include the lorebook; a hidden or unticked field
  // would let the run report success after silently skipping it.
  ok(
    grouped.ticked === grouped.total && grouped.total >= 4,
    `every field including the card book arrives ticked (${grouped.ticked}/${grouped.total})`,
  );

  // 🔴 §9a.31's BOUNDARY, on the hardest document in the suite: a card that carries an embedded
  // lorebook, so it holds the card's own prose AND rows that read like worldbook entries.
  // §6.1.2 — "every field on ONE scrollable page" — is the reason this editor exists, and a
  // collapsed card would undo it. Nothing on this pane may fold.
  //
  // 📌 AND THE `card book · …` ROWS ARE COVERED BY THE SAME ASSERTION, which is the subtle part.
  // `card.py`'s `add()` takes an `entry` dict but puts only `constant` and `mode` into `meta` —
  // it never emits `entry` itself — so a card's embedded entries carry NO `f.entry` on the wire
  // and are, to every consumer of that flag, ordinary card fields. That is why gating on the
  // server flag rather than on the locator shape lands this correctly without a `kind` test:
  // the accordion is books-only because the flag is books-only. See the §9a.31 note about the
  // typed-settings gap this implies for a card's lorebook.
  const boundary = await evaluate(
    cdp,
    `(() => {
        const st = wbState('cards');
        const rows = [...document.querySelectorAll('#wbFields_cards .wbfield')];
        return {n: rows.length,
                tags: [...new Set(rows.map(r => r.querySelector('.wbhead').tagName))],
                cars: rows.filter(r => r.querySelector('.wbcar')).length,
                shut: rows.filter(r => r.classList.contains('wbshut')).length,
                flags: rows.filter(r => !!(st.fields[+r.dataset.i] || {}).entry).length};
    })()`,
  );
  ok(
    boundary.n >= 4 && boundary.tags.join() === 'LABEL' && boundary.cars === 0,
    `every row on a Character Card keeps its label header and gets no twisty (${JSON.stringify(boundary)})`,
  );
  ok(
    boundary.shut === 0 && boundary.flags === 0,
    `so nothing on a card is ever collapsed, embedded lorebook included (${boundary.shut} shut, ${boundary.flags} flagged)`,
  );
  ok(
    await evaluate(
      cdp,
      `document.querySelector('#wbExpandAll_cards').style.display === 'none'
                         && document.querySelector('#wbCollapseAll_cards').style.display === 'none'`,
    ),
    'and the expand/collapse controls stay hidden on the Character Cards pane',
  );

  // Always-injected keeps only the `constant: true` entry; Normal keeps only the other one.
  // Either way ONE row of the group survives, so the heading stays. Vectorized matches neither,
  // which is the case that has to take the heading with it.
  const filtered = await evaluate(
    cdp,
    `(async () => {
        const host = document.getElementById('wbFields_cards');
        const seen = q => { wbModeFilter['cards'] = q; wbFilterPaint('cards');
            const h = host.querySelector('h4.wbgroup');
            return {head: h ? !h.classList.contains('wbhide') : null,
                    rows: [...host.querySelectorAll('.wbfield')]
                        .filter(b => !b.classList.contains('wbhide'))
                        .map(b => b.querySelector('b').textContent)}; };
        const all = seen(''), constant = seen('constant'), normal = seen('normal');
        const vectorized = seen('vectorized');
        wbModeFilter['cards'] = ''; wbFilterPaint('cards');
        return {all, constant, normal, vectorized};
    })()`,
  );
  ok(
    filtered.all.head === true && filtered.constant.head === true && filtered.normal.head === true,
    'the heading shows while any of its rows do',
  );
  ok(
    filtered.constant.rows.length === 1 && filtered.constant.rows[0] === 'card book · Her childhood home',
    `the mode filter reaches the card book's own entries (${filtered.constant.rows.join(', ')})`,
  );
  // 🔴 The one only a browser can answer. A heading left standing over an emptied group floats
  // onto whatever comes next and labels THAT.
  ok(
    filtered.vectorized.head === false && filtered.vectorized.rows.length === 0,
    `and the heading is hidden once its last row is filtered away (${filtered.vectorized.rows.length} rows left)`,
  );
}

// ── m4h / §9a.2: the round face beside a Character Voices row ────────────────────────────────
//
// Join character-card rows to SillyTavern thumbnails by `st_ref` and render the image beside the name.
//
// 🔴 THE JOIN IS ON `st_ref`, NOT ON THE NAME. The design doc set this up as a name lookup and
// then had to ask what a collision renders; m5b had already given the voice registry SillyTavern's
// own primary key (the avatar filename), and a card document carries the same string. So the three
// cases to prove are: joined by avatar, joined by name when there is no avatar and exactly one
// card answers, and NOT joined when two do.
{
  const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const faces = await evaluate(
    cdp,
    `(async () => {
        const mk = async (name, ref, withPng) => {
            const r = await fetch('/wbedit/documents', {method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({document: {spec: 'chara_card_v2', spec_version: '2.0',
                    data: {name: name, description: 'x', first_mes: 'y'}}, name: name})});
            const doc = await r.json();
            if (withPng) {
                const bin = Uint8Array.from(atob('${PNG1}'), c => c.charCodeAt(0));
                await fetch('/wbedit/documents/' + doc.id + '/avatar',
                            {method: 'POST', headers: {'Content-Type': 'image/png'}, body: bin});
            }
            return doc;
        };
        // NO BACKTICKS IN THIS COMMENT — it is inside a template literal and one ends the string.
        // A JSON-imported card has an EMPTY st_ref (only the ST sweep sets it), so these three
        // exercise the name half: one unambiguous, two sharing a name, and a voice row with no
        // card at all. The st_ref half is driven directly below, because setting one from here
        // would mean standing up the whole pairing flow for a one-line precedence rule.
        const keyed = await mk('Voice Fixture Character', '', true);
        const twinA = await mk('Duplicate Test Character', '', true);
        const twinB = await mk('Duplicate Test Character', '', true);
        return {keyed: keyed.id, twinA: twinA.id, twinB: twinB.id};
    })()`,
  );

  // 🔴 The registry is the other half, and it is driven through its real route so the join is
  // tested against the shape SillyTavern actually pushes — `{name, avatar}` since m5b.
  const rendered = await evaluate(
    cdp,
    `(async () => {
        const put = await fetch('/st/characters', {method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({characters: {
                'Voice Fixture Character':    {voice: ''},
                'Duplicate Test Character':    {voice: ''},
                'No Card Character':  {voice: ''},
                'Test User': {voice: ''},
            }})});
        if (!put.ok) return {putFailed: put.status};
        switchStTab('characters');
        await loadStChars();
        const rows = [...document.querySelectorAll('#stList .stRow')].map(r => {
            const box = r.querySelector('.wbface');
            return {name: r.dataset.name,
                    hasImg: !!(box && box.querySelector('img')),
                    initial: box && box.querySelector('.wbinitial')
                             ? box.querySelector('.wbinitial').textContent : null,
                    clickable: box ? box.classList.contains('wbopen') : null,
                    src: box && box.querySelector('img')
                         ? box.querySelector('img').getAttribute('src') : null};
        });
        // NO BACKTICKS IN HERE — this comment is inside a template literal and one closes it.
        // stFacesNow(), not stFaces: the map is private to js/st/chars.js as of 7.3-m11b and the
        // module publishes a getter over it. Reading the let off the shim would give a value
        // copied once at load, i.e. the empty seed, and this check would be about nothing.
        return {rows, faceKeys: Object.keys(stFacesNow().byName)};
    })()`,
  );

  const row = n => (rendered.rows || []).find(r => r.name === n) || {};
  ok(
    !rendered.putFailed && (rendered.rows || []).length === 4,
    `the Character Voices list renders its rows (${(rendered.rows || []).length})`,
  );
  ok(
    // 9.7.7 — `split('?')`: the URL carries the thumbnail's cache key now, so an `endsWith` on
    // the bare path would go red on a fix that has nothing to do with this join.
    !!row('Voice Fixture Character').hasImg && (row('Voice Fixture Character').src || '').split('?')[0].endsWith('/thumb'),
    `a character with a card gets its face, via the thumbnail route (${row('Voice Fixture Character').src})`,
  );
  // ⚠️ THE COMMON CASE, not an edge case: he has narrated for characters he never imported.
  ok(
    row('No Card Character').hasImg === false && row('No Card Character').initial === 'N',
    `a character with no card in the Library gets its initial, never a broken image (${row('No Card Character').initial})`,
  );
  // The persona created earlier in this browser run has a picture but no character card. The
  // voice registry has no avatar key for user messages, so this exercises the unambiguous-name
  // half of the same join and proves Character Voices searches persona documents too.
  ok(
    !!row('Test User').hasImg && (row('Test User').src || '').split('?')[0].endsWith('/thumb'),
    `a persona in Character Voices gets its persona face (${row('Test User').src})`,
  );
  // 🔴 TWO CARDS SHARE THIS NAME, so neither face is selected by an ambiguous match.
  ok(
    row('Duplicate Test Character').hasImg === false && row('Duplicate Test Character').initial === 'D',
    `an ambiguous name draws the initial rather than guessing between two cards (${row('Duplicate Test Character').initial})`,
  );
  ok(
    rendered.faceKeys.includes('duplicate test character'),
    'and the ambiguity was seen rather than missed, so the row is a decision not an accident',
  );
  // The Library's delegated open handler is bound to wbLib, so a face out here would promise a
  // click that does nothing.
  ok(row('Voice Fixture Character').clickable === false, 'a face outside the Library is not dressed up as a click target');

  // 🔴 THE PRECEDENCE RULE, DRIVEN DIRECTLY. `st_ref` is SillyTavern's own primary key and it
  // must beat the name — including when the name is one the ambiguity rule would refuse. Set up
  // by hand because only the ST sweep writes an `st_ref`, and standing up the pairing flow to
  // prove one branch would be a lot of machinery for a lookup.
  // ⚠️ THE FIXTURE IS AN ARGUMENT NOW (7.3-m11b). This used to be
  // `const saved = stFaces; stFaces = {…}; … stFaces = saved;` — a spec reassigning a page
  // global, which stopped working the moment `stFaces` became private to js/st/chars.js.
  // `stFaceFor`'s fourth parameter defaults to the module's own map, so production is unchanged
  // and this reads as what it always was: a pure lookup driven with a table. 📌 It is also
  // safer than the version it replaces — an exception between the two assignments used to leave
  // the injected map live for every check that followed.
  const precedence = await evaluate(
    cdp,
    `(() => {
        const FIXTURE = {loaded: true,
            byRef:  {'test-avatar.png': {id: 'REF', name: 'Duplicate Test Character', avatar: true, focus: null}},
            byName: {twin: null, solo: {id: 'NAME', name: 'Solo', avatar: true, focus: null}}};
        const pick = html => (html.match(/data-id="([^"]*)"/) || [])[1];
        return {
            byRef:     pick(stFaceFor('Duplicate Test Character', {avatar: 'test-avatar.png'}, 34, FIXTURE)),
            refWins:   pick(stFaceFor('Anything', {avatar: 'test-avatar.png'}, 34, FIXTURE)),
            unknownRef: pick(stFaceFor('Solo', {avatar: 'gone.png'}, 34, FIXTURE)),
            byName:    pick(stFaceFor('Solo', {}, 34, FIXTURE)),
            ambiguous: pick(stFaceFor('Duplicate Test Character', {}, 34, FIXTURE)),
        };
    })()`,
  );

  ok(
    precedence.byRef === 'REF' && precedence.refWins === 'REF',
    `the avatar filename wins over the name, even an ambiguous one (${precedence.byRef}/${precedence.refWins})`,
  );
  ok(precedence.byName === 'NAME', `an entry with no avatar still resolves by an unambiguous name (${precedence.byName})`);
  ok(precedence.ambiguous === '', `and refuses to choose when two cards share that name (${JSON.stringify(precedence.ambiguous)})`);
  // ⚠️ An avatar we do not hold must NOT fall through to the name — the entry has said which
  // character it is, and we simply do not have that card.
  ok(
    precedence.unknownRef === '',
    `an unknown avatar draws the initial rather than falling back to the name (${JSON.stringify(precedence.unknownRef)})`,
  );

  // 🔴 11.2.6 — THE CLIPS FACE CHOOSES WHERE THE VOICE LIST REFUSES. A scene can provide
  // her initial because the name was ambiguous and no document carried her filename. A Clips row
  // binds no voice, so it picks: the exact avatar, else a card over a persona, else one with a
  // picture, else the newest import.
  const scene = await evaluate(
    cdp,
    `(() => {
        const d = (id, kind, avatar, at, st_ref) => ({id, name: 'Test Character 9', kind, avatar, imported_at: at, st_ref, focus: null});
        const P = d('PERSONA', 'persona', true, 900), C_OLD = d('CARD_OLD', 'card', true, 100),
              C_NEW = d('CARD_NEW', 'card', true, 200), C_BARE = d('CARD_BARE', 'card', false, 999),
              C_REF = d('CARD_REF', 'card', true, 50, 'Test Character 9.png');
        const F = (docs) => ({loaded: true, byName: {'test character 9': null},
            byRef: Object.fromEntries(docs.filter(x => x.st_ref).map(x => [x.st_ref, x])),
            all: {'test character 9': docs}});
        const pick = html => (html.match(/data-id="([^"]*)"/) || [])[1];
        return {
            ref:     pick(stSceneFaceFor('Test Character 9', 'Test Character 9.png', 20, F([P, C_OLD, C_REF]))),
            card:    pick(stSceneFaceFor('Test Character 9', '', 20, F([P, C_OLD]))),
            unknown: pick(stSceneFaceFor('Test Character 9', 'gone.png', 20, F([P, C_OLD]))),
            picture: pick(stSceneFaceFor('Test Character 9', '', 20, F([C_BARE, C_OLD]))),
            newest:  pick(stSceneFaceFor('Test Character 9', '', 20, F([C_OLD, C_NEW]))),
            persona: pick(stSceneFaceFor('Test Character 9', '', 20, F([P]))),
            none:    pick(stSceneFaceFor('No Card Character', '', 20, F([P, C_OLD]))),
            face:    /<img/.test(stSceneFaceFor('Test Character 9', '', 20, F([P, C_OLD]))),
        };
    })()`,
  );
  ok(scene.ref === 'CARD_REF', `a Clips face takes the exact SillyTavern avatar first (${scene.ref})`);
  ok(scene.card === 'CARD_OLD' && scene.face, `🔴 an ambiguous name still draws a picture, a card over a persona (${scene.card})`);
  ok(scene.unknown === 'CARD_OLD', `an avatar no document carries falls back to the name, not to the initial (${scene.unknown})`);
  ok(scene.picture === 'CARD_OLD', `a card with a picture beats a newer one without (${scene.picture})`);
  ok(scene.newest === 'CARD_NEW', `between two cards with pictures, the newest import wins (${scene.newest})`);
  ok(scene.persona === 'PERSONA', `a persona is used when it is the only document of that name (${scene.persona})`);
  ok(scene.none === '', `a name with no document at all draws the initial (${JSON.stringify(scene.none)})`);
}

// generation-token behavior
{
  const gen = await evaluate(
    cdp,
    `(() => {
        const before = wbGen('books');
        const bumped = wbBump('books');
        return {
            grows:    bumped === before + 1,
            staleOld: wbStale('books', before),
            freshNew: !wbStale('books', bumped),
            // Per pane, not per tab: a bump on one kind must not invalidate another's in-flight
            // work, or opening a card would abandon a book's load for no reason.
            perKind:  (() => { const c = wbGen('cards'); wbBump('books'); return !wbStale('cards', c); })(),
        };
    })()`,
  );
  ok(gen.grows, 'wbBump advances the pane generation');
  ok(gen.staleOld, 'a token taken before a bump reads as stale');
  ok(gen.freshNew, 'and the token the bump returned does not');
  ok(gen.perKind, 'the generation is per pane, so bumping books does not invalidate cards');

  // 5.1 — the actual bug: open A, and while its fetches are in flight, open B. The pane must
  // finish on B, and must not be left holding A's revision or A's fields.
  const race = await evaluate(
    cdp,
    `(async () => {
        const ids = [...document.querySelectorAll('#wbLib_books .wbrow')].map(r => r.dataset.id);
        if (ids.length < 2) return {skipped: true};
        const st = wbState('books');
        const a = wbOpen('books', ids[0]);          // deliberately not awaited
        const b = wbOpen('books', ids[1]);          // overtakes it
        await Promise.all([a, b]);
        return {
            skipped: false,
            doc: st.doc && st.doc.id,
            want: ids[1],
            // The three that used to disagree with each other after a race.
            coherent: !!(st.doc && st.rev && st.fields) && st.openId === st.doc.id,
        };
    })()`,
  );
  if (race.skipped) {
    ok(true, 'two racing opens leave the pane on the second document (skipped: needs two books)');
    ok(true, 'and its revision and fields belong to that same document');
  } else {
    ok(race.doc === race.want, `two racing opens leave the pane on the second document (${race.doc} vs ${race.want})`);
    ok(race.coherent, 'and its revision and fields belong to that same document');
  }

  // 5.7 — a dropped promise used to be silent. `wbGo` must put SOMETHING on the message line.
  const said = await evaluate(
    cdp,
    `(async () => {
        wbHush('books');
        await wbGo('books', Promise.reject(Object.assign(new Error('nope'), {status: 500})));
        // 🔴 THE DOM, NOT wbEl. 7.1-m13 deleted the inline wbEl — js/util/dom.js holds the only
        // copy now, and the shim does not publish it, so a bare wbEl(...) in here would throw
        // ReferenceError INSIDE the page: twelve red checks and then a 100-second hang with no
        // output (§5.11). wbEl(kind, id) was only ever getElementById(id + '_' + kind).
        // ⚠️ No backticks in this comment on purpose — it is inside a template literal (§5.13).
        const el = document.getElementById('wbMsg_books');   // wbSay is the FUNCTION; wbMsg is the element
        const generic = el ? el.textContent.trim() : '';
        wbHush('books');
        await wbGo('books', Promise.reject(Object.assign(new Error('x'), {status: 423})));
        const locked = el ? el.textContent.trim() : '';
        wbHush('books');
        return {generic, locked};
    })()`,
  );
  ok(said.generic.length > 0, `a rejected background call reaches the message line (${said.generic})`);
  ok(/lock/i.test(said.locked), `and a 423 says the vault is locked rather than a raw error (${said.locked})`);

  // 5.4 — the pollers are per pane. A module global here meant an import on one pane silently
  // killed another pane's poller and left it on 'busy' for the session.
  const pollers = await evaluate(
    cdp,
    `({sweep: typeof wbSweepPoll === 'object' && wbSweepPoll !== null,
           send:  typeof wbSendPoll  === 'object' && wbSendPoll  !== null})`,
  );
  ok(pollers.sweep && pollers.send, 'the sweep and send pollers are keyed per pane, not module globals');
}

// ── 7.3.9c: the ⚙ fold's pending edits survive a refresh ─────────────────────────────────────
//
// Blur saves changes from every settings control, not only `.wbtext`. Keywords, Title, Order and
// every other control in the settings fold
// lived in the DOM and nowhere else, so a refresh mid-edit lost them with no message and no trace.
//
// 🔴 **THE SECOND CHECK IS THE ONE THAT MATTERS AND IT IS NOT "IS THE VALUE ON SCREEN".** It is
// `wbSetEdits`, because Save reads the DOM through that function and it walks only
// `.wbsetbody[data-built]` — so a restore that painted the value into a fold left unbuilt would
// show a dirty row promising an edit that Save then silently dropped. That is a WORSE outcome than
// not restoring at all, which is why the restore builds the fold even though it stays shut.
{
  await evaluate(cdp, `switchStTab('books')`);
  const DBOOK = JSON.stringify({
    name: 'FoldDrafts',
    entries: {
      0: {
        uid: 0,
        key: ['ledger'],
        comment: 'Sample Entry 1',
        constant: false,
        order: 100,
        content: 'Test Character 1 keeps the ledger.',
      },
    },
  });

  const stashed = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: ${DBOOK}, name: 'FoldDrafts'})});
        const doc = await r.json();
        window.__foldDoc = doc.id;
        await wbOpen('books', doc.id);
        const box = document.querySelector('#wbFields_books .wbfield');
        box.querySelector('.wbsetog').click();                  // build + open the fold
        const body = box.querySelector('.wbsetbody:not(.wbkeysbody)');
        // 🔴 9a.35 — KEYWORDS ARE NO LONGER IN THE FOLD, and this spec is the reason to say so
        // rather than to quietly repoint it: the two controls now live in two bodies, and the
        // stash has to reach BOTH. Reading key out of the always-visible box and order out of
        // the fold in the same gesture is what proves that.
        // (No backticks in here: this whole block is a template literal and one would end it.)
        const key = box.querySelector('.wbkeysbody .wbsf[data-name="key"] .wbsv');
        key.value = 'ledger, quill';
        // change, not input: the stash is deliberately not per-keystroke.
        key.dispatchEvent(new Event('change', {bubbles: true}));
        const ord = body.querySelector('.wbsf[data-name="order"] .wbsv');
        ord.value = '250';
        ord.dispatchEvent(new Event('change', {bubbles: true}));
        // 🔴 WAIT FOR THE SERVER TO HOLD BOTH DRAFTS, NOT FOR 300 ms. This was a flat sleep with the
        // comment "let the PUTs land"; on a loaded box they had not, and the read below saw one
        // draft or none. The fact the checks depend on is the stored draft, so that is polled:
        // one entry per stashed control (two here), bounded at 15 s. If they never both arrive
        // the loop ends and the checks print what the server did hold.
        const readDrafts = async () => {
            const d = await (await fetch('/wbedit/documents/' + doc.id)).json();
            const drafts = await (await fetch('/wbedit/documents/' + doc.id + '/draft/' + d.latest)).json();
            return {d, drafts};
        };
        let held = await readDrafts();
        for(let i = 0; i < 300 && Object.keys(held.drafts.fields || {}).length < 2; i++){
            await new Promise(r2 => setTimeout(r2, 50));
            held = await readDrafts();
        }
        // 🔴 SHUT THE FOLD AGAIN, AND THIS IS WHAT MAKES THE NEXT CHECK MEAN ANYTHING. m5g keeps
        // "which folds are open" per DOCUMENT (st.setOpen), so reopening the same book re-opens the
        // fold he was working in — which would leave it built for a reason that has nothing to do
        // with the restore, and the assertion below would pass on a broken build. Closing it here
        // is the real case anyway: pending edits in a fold he has not opened this session.
        box.querySelector('.wbsetog').click();
        return {fields: held.drafts.fields || {}, latest: held.d.latest};
    })()`,
  );

  const kKey = JSON.stringify(['entries', '0', 'key']);
  const kOrd = JSON.stringify(['entries', '0', 'order']);
  ok(
    stashed.fields[kKey] === '["ledger","quill"]',
    `a Keywords edit is stashed on the server as JSON (${JSON.stringify(stashed.fields[kKey])})`,
  );
  // 🔴 JSON-ENCODED, NOT RAW. A raw null would collide with the wire's "clear this draft", so the
  // number arriving as the STRING "250" is the encoding doing its job, not a coercion bug.
  ok(stashed.fields[kOrd] === '250', `and a numeric setting keeps its type through the encoding (${JSON.stringify(stashed.fields[kOrd])})`);

  // Show pending-change counts in the roster so unsaved work remains visible when the document is closed.
  // Before this, pending state was visible only inside a reopened document, so users could miss it.
  // open every row and look.
  const marked = await evaluate(
    cdp,
    `(async () => {
        await wbLoadLib('books');
        const row = document.querySelector('#wbLib_books .wbrow[data-id="' + window.__foldDoc + '"]');
        const tag = row && row.querySelector('.wbpend');
        const other = [...document.querySelectorAll('#wbLib_books .wbrow')]
            .filter(r => r.dataset.id !== window.__foldDoc && r.querySelector('.wbpend')).length;
        // A live probe rather than parsing the hex here: the browser resolves var(--warn) to the
        // same rgb() string it resolves the real element's color to, so the two are comparable
        // without this spec knowing anything about the palette or the active theme.
        const probe = document.createElement('span');
        probe.style.color = 'var(--warn)';
        document.body.appendChild(probe);
        const warn = getComputedStyle(probe).color;
        const muted = tag ? getComputedStyle(tag.previousElementSibling).color : null;
        probe.remove();
        return {text: tag ? tag.textContent.trim() : null,
                color: tag ? getComputedStyle(tag).color : null, warn, muted, other};
    })()`,
  );
  ok(marked.text === '(2 pending edits)', `the Library row says how many are pending (${JSON.stringify(marked.text)})`);
  // ⚠️ THE COMPUTED COLOR, NOT THE CLASS — a class-only check passes while a theme rule with
  // `!important` paints it something else, which is exactly how a "green" box-shadow shipped
  // invisible here once. Also asserted DIFFERENT from the revision count beside it, because the
  // whole job of the marker is to not read as more gray furniture.
  ok(
    marked.color && marked.color === marked.warn && marked.color !== marked.muted,
    `and it is painted --warn orange, distinct from the muted text beside it ` +
      `(${marked.color} vs warn ${marked.warn} vs muted ${marked.muted})`,
  );
  ok(marked.other === 0, `and no row without drafts is marked (${marked.other} false positives)`);

  // The refresh: reopen the document from scratch, exactly as a page load would.
  const back = await evaluate(
    cdp,
    `(async () => {
        await wbOpen('books', window.__foldDoc);
        const box = document.querySelector('#wbFields_books .wbfield');
        const body = box.querySelector('.wbsetbody:not(.wbkeysbody)');
        // 9a.35 — two bodies now, so the restore is read from both: key lives in the
        // always-visible box, everything else is still in the fold. (No backticks: template.)
        const keys = box.querySelector('.wbkeysbody');
        const q = n => (n === 'key' ? keys : body).querySelector('.wbsf[data-name="' + n + '"] .wbsv');
        return {
            built: body.hasAttribute('data-built'),
            keysBuilt: keys.hasAttribute('data-built'),
            keysShown: keys.offsetHeight > 0,
            shut: body.hasAttribute('hidden'),
            key: q('key') ? q('key').value : null,
            order: q('order') ? q('order').value : null,
            dirty: box.classList.contains('wbdirty'),
            edits: wbSetEdits('books').length,
            said: (document.getElementById('wbMsg_books') || {}).textContent || '',
        };
    })()`,
  );

  ok(
    back.key === 'ledger, quill' && back.order === '250',
    `the fold's pending edits come back after a reopen (key=${JSON.stringify(back.key)} order=${JSON.stringify(back.order)})`,
  );
  ok(back.built && back.shut, `and the fold is BUILT while still shut — the state Save depends on (built=${back.built} shut=${back.shut})`);
  // The required keywords field must be rendered and visible; a built-but-hidden field is not usable.
  ok(
    back.keysBuilt && back.keysShown,
    `the primary-keywords box is built AND visible without opening anything (built=${back.keysBuilt} shown=${back.keysShown})`,
  );
  ok(back.dirty && back.edits === 2, `Save can actually see them: ${back.edits} proposed edits on a dirty row`);
  ok(/restored/.test(back.said), `and he is told (${back.said.trim()})`);

  // And they commit. Without the `data-touched` re-assert this saves nothing at all.
  const committed = await evaluate(
    cdp,
    `(async () => {
        await wbSaveEdits('books');
        const d = await (await fetch('/wbedit/documents/' + window.__foldDoc)).json();
        const rev = await (await fetch('/wbedit/documents/' + window.__foldDoc + '/revision/' + d.latest)).json();
        const e = rev.content.entries['0'];
        const drafts = await (await fetch('/wbedit/documents/' + window.__foldDoc + '/draft/' + d.latest)).json();
        return {key: e.key, order: e.order, left: Object.keys(drafts.fields || {}).length};
    })()`,
  );
  ok(
    JSON.stringify(committed.key) === '["ledger","quill"]' && committed.order === 250,
    `a restored fold edit lands in the revision (key=${JSON.stringify(committed.key)} order=${committed.order})`,
  );
  ok(committed.left === 0, `and the draft is cleared by the save (${committed.left} left)`);

  // ⚠️ A control put BACK to what the revision says must clear its draft, not store a no-op —
  // otherwise reopening "restores" a value identical to the content and marks it dirty forever.
  const cleared = await evaluate(
    cdp,
    `(async () => {
        const box = document.querySelector('#wbFields_books .wbfield');
        if(box.querySelector('.wbsetbody:not(.wbkeysbody)[hidden]')) box.querySelector('.wbsetog').click();
        const ord = box.querySelector('.wbsf[data-name="order"] .wbsv');
        // 🔴 THE BAD ORDER IS FORCED, NOT WAITED OUT. This block was two flat 200 ms sleeps, then
        // (2026-10-12) a wait for the first stash to be answered before the put-back was sent.
        // Both stepped around a product bug: the page sent the two writes side by side, the
        // server answered them in whichever order they arrived, and when "999" arrived last the
        // server kept a draft he had withdrawn. That is how this check failed once in a full run
        // with "1 left". So the first draft write is HELD here, unanswered, while the put-back is
        // made. A page that sends the put-back anyway gets it answered first and the 999 last,
        // every time. A page that takes turns (wbDraftTurn in wb/edit.js) sends nothing until
        // the first is answered.
        const realFetch = window.fetch;
        let sent = 0, answered = 0, release = null, second = null;
        const gate = {};
        const done = new Promise(r2 => { gate.open = r2; });
        const tally = p => p.finally(() => { if(++answered === 2) gate.open(); });
        window.fetch = function(u, init){
            if(!(init && init.method === 'PUT' && /\\/draft$/.test(String(u)))) return realFetch.apply(this, arguments);
            sent++;
            if(sent === 1) return new Promise((res, rej) => {
                release = () => tally(realFetch.call(window, u, init)).then(res, rej); });
            const p = tally(realFetch.call(window, u, init));
            if(sent === 2) second = p;
            return p;
        };
        let sentWhileHeld, timedOut = false;
        try {
            ord.value = '999';
            ord.dispatchEvent(new Event('change', {bubbles: true}));
            ord.value = '250';                                  // back to the saved value
            ord.dispatchEvent(new Event('change', {bubbles: true}));
            // One turn of the event loop: everything the page was going to send with the first
            // write unanswered has been sent by now (a turn, not a duration).
            await new Promise(r2 => setTimeout(r2, 0));
            sentWhileHeld = sent;
            if(second) await second.catch(() => {});            // the put-back, answered FIRST
            release();
            // Both writes answered by the server. 15 s is a ceiling on a page that never sends
            // the second one, not a wait.
            timedOut = await Promise.race([done.then(() => false),
                new Promise(r2 => setTimeout(() => r2(true), 15000))]);
        } finally {
            window.fetch = realFetch;
        }
        const d = await (await fetch('/wbedit/documents/' + window.__foldDoc)).json();
        const drafts = await (await fetch('/wbedit/documents/' + window.__foldDoc + '/draft/' + d.latest)).json();
        return {left: Object.keys(drafts.fields || {}).length, sentWhileHeld, timedOut,
            seen: {sent, answered, pageDraftAt: wbState('books').draftAt || null,
                pageRevision: (wbState('books').rev || {}).n, latest: d.latest,
                serverDrafts: drafts.fields || null,
                said: (document.getElementById('wbMsg_books') || {}).textContent || null}};
    })()`,
  );
  if (cleared.left !== 0 || cleared.timedOut)
    console.log(`  (draft not cleared; the page and server held: ${JSON.stringify(cleared.seen)})`);
  ok(
    cleared.sentWhileHeld === 1,
    `draft writes take turns: with the first one unanswered, the put-back is not sent beside it (${cleared.sentWhileHeld} on the wire)`,
  );
  ok(!cleared.timedOut, 'and both writes are sent and answered once the first is let through');
  ok(cleared.left === 0, `putting a control back to its stored value clears the draft (${cleared.left} left)`);
  // A cleared draft used to stay in the page's map as an entry holding null, and Revert and the
  // download warning both count the map's entries: "Throw away 2 unsaved edits" after one.
  ok(
    Object.keys(cleared.seen.pageDraftAt || {}).length === 0,
    `and the page no longer counts it as an unsaved edit (${JSON.stringify(cleared.seen.pageDraftAt)})`,
  );

  // Expose a visible revert action beside the active edit controls and confirm before discarding changes.
  // `↺ Discard`, at the bottom of the page, in a row that only appears once you are already
  // mid-edit. Which is the same discoverability complaint as Ctrl+F and the ↻: present, working,
  // and nowhere he would look.
  const revert = await evaluate(
    cdp,
    `(async () => {
        await wbOpen('books', window.__foldDoc);
        const btn = document.getElementById('wbRevertTop_books');
        const save = document.getElementById('wbSaveTop_books');
        const cleanState = btn.disabled;
        const ta = document.querySelector('#wbFields_books .wbtext');
        const original = ta.value;
        // 🔴 REVERT PRESSED WITH THE STASH STILL ON ITS WAY, FORCED. Clicking Revert blurs the box
        // he was typing in, and that blur is what sends the stash, so in real use the two are
        // always this close. Revert used to count the unsaved edits before the stash was
        // answered: a first edit read as "nothing to discard" and stayed, in the box and on the
        // server. So the stash is HELD here while Revert is pressed. A page that counts first has
        // said "nothing to discard" by the next turn of the event loop; a page that waits has said
        // nothing, and asks once the stash is let through.
        const realFetch = window.fetch;
        let letStashGo = null, early = null;
        window.fetch = function(u, init){
            if(!letStashGo && init && init.method === 'PUT' && /\\/draft$/.test(String(u)))
                return new Promise((res, rej) => {
                    letStashGo = () => realFetch.call(window, u, init).then(res, rej); });
            return realFetch.apply(this, arguments);
        };
        try {
            ta.value = 'typed but not saved';
            ta.dispatchEvent(new Event('input', {bubbles: true}));
            ta.dispatchEvent(new Event('blur', {bubbles: true}));
            btn.click();
            await new Promise(r2 => setTimeout(r2, 0));         // one turn, not a duration
            early = {held: !!letStashGo, said: (document.getElementById('wbMsg_books') || {}).textContent || ''};
            if(letStashGo) letStashGo();
        } finally {
            window.fetch = realFetch;
        }
        await wbDraftsSettled('books');
        await ${NEXT_FRAME};
        early.title = document.getElementById('mTitle').textContent.trim();
        const cancelEarly = [...document.querySelectorAll('#mActs button')].find(b => b.textContent.trim() === 'Cancel');
        if(cancelEarly) cancelEarly.click();
        // 🔴 WAIT FOR THE STASH TO BE ANSWERED, NOT 300 ms. The blur sends the draft; when the PUT
        // returns, wbSaveDraft patches the roster row ("(1 pending edit)") and records the draft in
        // st.draftAt. Both matter below: the row is asserted directly, and Revert reads draftAt to
        // decide whether there is anything to discard at all (with none it says "nothing to
        // discard" and opens no dialog, so the next two blocks would find no dialog to answer).
        // Bounded at 15 s; on a hang the checks print what the row held.
        const pendingRow = () => {
            const r3 = document.querySelector('#wbLib_books .wbrow[data-id="' + window.__foldDoc + '"]');
            const t = r3 && r3.querySelector('.wbpend');
            return t ? t.textContent.trim() : null;
        };
        for(let i = 0; i < 300 && !(pendingRow() === '(1 pending edit)'
                                    && Object.keys(wbState('books').draftAt || {}).length > 0); i++)
            await new Promise(r2 => setTimeout(r2, 50));
        const probe = document.createElement('span');
        probe.style.color = 'var(--warn)';
        document.body.appendChild(probe);
        const warn = getComputedStyle(probe).color;
        probe.remove();
        return {
            early, cleanState, dirtyState: btn.disabled, label: btn.textContent.trim(),
            color: getComputedStyle(btn).color, warn,
            // Node.DOCUMENT_POSITION_FOLLOWING: the revert button comes AFTER save in the row.
            rightOfSave: !!(save.compareDocumentPosition(btn) & 4),
            original,
            // 7.3.9g — the roster row, WITHOUT reloading the library. The listing was fetched
            // before this draft existed, so a marker here can only have come from the live patch.
            rowNow: (() => {
                const r3 = document.querySelector('#wbLib_books .wbrow[data-id="' + window.__foldDoc + '"]');
                const t = r3 && r3.querySelector('.wbpend');
                return t ? t.textContent.trim() : null;
            })(),
        };
    })()`,
  );
  ok(
    revert.early.held && !/nothing to discard/.test(revert.early.said) && /^Revert changes\?$/.test(revert.early.title),
    `Revert waits for a stash still on its way instead of saying there is nothing to discard (${JSON.stringify(revert.early)})`,
  );
  ok(
    revert.rowNow === '(1 pending edit)',
    `the Library row gains the marker as he types, with no reload (${JSON.stringify(revert.rowNow)})`,
  );
  ok(
    revert.cleanState === true && revert.dirtyState === false,
    `Revert is disabled with nothing to revert and lights up on an edit ` + `(clean=${revert.cleanState} dirty=${revert.dirtyState})`,
  );
  ok(
    /Revert changes/.test(revert.label) && revert.rightOfSave,
    `it says Revert changes and sits to the RIGHT of Save (${JSON.stringify(revert.label)}, right=${revert.rightOfSave})`,
  );
  ok(revert.color === revert.warn, `and it is the orange one, by computed color (${revert.color} vs ${revert.warn})`);

  // 🔴 IT ASKS FIRST, AND CANCEL MUST MEAN CANCEL. A draft is the only copy of something he
  // typed and never saved; the server deletes the file outright.
  await evaluate(cdp, INSTALL_WRITE_LOG);
  const asked = await evaluate(
    cdp,
    `(async () => {
        // The dialog is read once Revert has got as far as asking: wbDiscard first waits for any
        // stash still on its way (none here, it was answered above), then calls wbConfirm, and
        // modal() writes the title and buttons synchronously. This was a 120 ms sleep.
        const writes0 = window.__wbWrites.length;
        document.getElementById('wbRevertTop_books').click();
        await wbDraftsSettled('books');
        await ${NEXT_FRAME};
        const title = document.getElementById('mTitle').textContent.trim();
        const labels = [...document.querySelectorAll('#mActs button')].map(b => b.textContent.trim());
        [...document.querySelectorAll('#mActs button')].find(b => b.textContent.trim() === 'Cancel').click();
        // 🔴 "CANCEL MEANS CANCEL" IS A NEGATIVE CLAIM, so it was a 200 ms sleep and a read of the
        // text. If Cancel went on to discard anyway, its DELETE is issued in the microtasks right
        // after the click; two frames cover them, and the write log (INSTALL_WRITE_LOG) says
        // whether any request was made. The text is read after any such request has answered.
        await ${NEXT_FRAME};
        const made = window.__wbWrites.slice(writes0);
        await Promise.all(made.map(w => w.p));
        return {title, labels, writes: made.length, keptText: document.querySelector('#wbFields_books .wbtext').value};
    })()`,
  );
  ok(
    /^Revert changes\?$/.test(asked.title) && asked.labels.includes('Revert changes'),
    `it asks before destroying anything (${JSON.stringify(asked.title)} / ${asked.labels.join(', ')})`,
  );
  ok(
    asked.keptText === 'typed but not saved' && asked.writes === 0,
    `and Cancel keeps the unsaved text (${JSON.stringify(asked.keptText)})`,
  );

  const reverted = await evaluate(
    cdp,
    `(async () => {
        // The dialog is there once Revert has got as far as asking (see above); this was a 120 ms sleep.
        document.getElementById('wbRevertTop_books').click();
        await wbDraftsSettled('books');
        await ${NEXT_FRAME};
        [...document.querySelectorAll('#mActs button')]
            .find(b => b.textContent.trim() === 'Revert changes').click();
        // 🔴 WAIT FOR THE REVERT TO HAVE FINISHED, NOT 600 ms. wbDiscard deletes the draft, says
        // "reverted N unsaved edit(s)", and only THEN reopens the document, which is what puts the
        // stored text back and grays the button out. The text being the original again IS the
        // reopen's signal (the typed text cannot equal it), so wait for the message, the original
        // text and the disabled button together; bounded at 15 s, and on a hang the checks below
        // print what was on screen.
        const original = ${JSON.stringify(revert.original)};
        for(let i = 0; i < 300; i++){
            const t = document.querySelector('#wbFields_books .wbtext');
            if(/reverted/.test(document.getElementById('wbMsg_books').textContent)
               && t && t.value === original && document.getElementById('wbRevertTop_books').disabled) break;
            await new Promise(r2 => setTimeout(r2, 50));
        }
        const d = await (await fetch('/wbedit/documents/' + window.__foldDoc)).json();
        const drafts = await (await fetch('/wbedit/documents/' + window.__foldDoc + '/draft/' + d.latest)).json();
        const r3 = document.querySelector('#wbLib_books .wbrow[data-id="' + window.__foldDoc + '"]');
        return {text: document.querySelector('#wbFields_books .wbtext').value,
                left: drafts.total, again: document.getElementById('wbRevertTop_books').disabled,
                rowNow: r3 ? !!r3.querySelector('.wbpend') : null};
    })()`,
  );
  ok(reverted.text === revert.original, `confirming puts the stored text back (${JSON.stringify(reverted.text.slice(0, 40))})`);
  ok(
    reverted.left === 0 && reverted.again === true,
    `the draft is gone from the vault and the button grays out again (${reverted.left} left)`,
  );
  // 🔴 The editor and library row must clear the pending marker together after the revert.
  ok(reverted.rowNow === false, `and the Library row drops its marker in the same breath, with no refresh (${reverted.rowNow})`);
}

// Update the live diff as the user edits, showing additions and removals beside the original text.
// 🔴 THE ROW IS SEEDED THROUGH `wbAddProposal`, because a real proposal needs the model and this
// suite has no model. That is the ONLY shortcut: the seed is the same call the SSE handler makes
// when an announcement lands (§6.3.1), and everything after it is the real thing — a real `input`
// event on the real textarea, through the delegated listener `wbWire` registered at module load,
// measured against the real stylesheet. The SSE → `wbAddProposal` hop is pinned separately, in
// wbedit_ui_smoke.mjs §4.
{
  await evaluate(cdp, `switchTab('sillytavern')`);
  await evaluate(cdp, `switchStTab('cards')`);
  await waitFor(cdp, `document.querySelector('[data-stpanel="cards"]').style.display !== 'none'`, 5000);
  const seeded = await evaluate(
    cdp,
    `(() => {
        document.getElementById('wbReview_cards').style.display = '';
        document.getElementById('wbProposals_cards').innerHTML = '';
        wbAddProposal('cards', {index: 0, label: 'Test Character 1', status: 'edited',
                                original: 'Test Character 1 keeps the ledger.',
                                revised: 'Renamed Character 1 keeps the ledger.', review: 'pending'});
        const div = document.querySelector('#wbProposals_cards .wbprop');
        return {before: div.querySelector('.wbbefore').innerHTML,
                after: div.querySelector('.wbhl').innerHTML,
                banded: div.classList.contains('wbchanged')};
    })()`,
  );
  ok(
    /<del>Test<\/del>/.test(seeded.before),
    `the row arrives with the model's removal already red on the left (${seeded.before.slice(0, 40)})`,
  );
  ok(
    /<ins>Renamed<\/ins>/.test(seeded.after),
    `and its addition green on the right, which no build before this one drew (${seeded.after.slice(0, 40)})`,
  );
  ok(seeded.banded === true, 'a row that differs from the document is banded, so the changed ones are findable by scrolling');

  // The point of the milestone: it is HIS typing that moves the color, not the model's reply.
  const typed = await evaluate(
    cdp,
    `(() => {
        const div = document.querySelector('#wbProposals_cards .wbprop');
        const ta = div.querySelector('.wbedited');
        ta.value = 'Test Character 1 keeps the accounts.';
        ta.dispatchEvent(new Event('input', {bubbles: true}));
        return {before: div.querySelector('.wbbefore').innerHTML,
                after: div.querySelector('.wbhl').innerHTML};
    })()`,
  );
  ok(
    /<del>ledger\.<\/del>/.test(typed.before) && !/<del>Test<\/del>/.test(typed.before),
    `typing in the after box moves the red on the left (${typed.before.slice(-40)})`,
  );
  ok(/<ins>accounts\.<\/ins>/.test(typed.after), `and the green on the right follows the same keystroke (${typed.after.slice(-40)})`);

  // 🔴 THE BAND MEANS "THIS ROW DIFFERS", NOT "THE MODEL TOUCHED IT" — so typing the original
  // back has to clear it. A band that only ever goes on is a band nobody can trust.
  const undone = await evaluate(
    cdp,
    `(() => {
        const div = document.querySelector('#wbProposals_cards .wbprop');
        const ta = div.querySelector('.wbedited');
        ta.value = 'Test Character 1 keeps the ledger.';
        ta.dispatchEvent(new Event('input', {bubbles: true}));
        return {banded: div.classList.contains('wbchanged'),
                before: div.querySelector('.wbbefore').innerHTML};
    })()`,
  );
  ok(undone.banded === false && !/<del>[^<]/.test(undone.before), 'putting the original text back clears the band and every mark with it');

  // 🔴 GEOMETRY, MEASURED. The green is painted in a layer BEHIND a transparent textarea, and a
  // layer that wraps at a different width paints under the wrong words — which looks like a
  // broken diff and is actually a stylesheet disagreeing with itself. getComputedStyle and
  // clientWidth, never the class names (6.3's record: a class-only assertion passed while ST's
  // theme had killed the paint with !important).
  const paint = await evaluate(
    cdp,
    `(() => {
        const div = document.querySelector('#wbProposals_cards .wbprop');
        const ta = div.querySelector('.wbedited');
        ta.value = 'Test Character 1 keeps the accounts.';
        ta.dispatchEvent(new Event('input', {bubbles: true}));
        const hl = div.querySelector('.wbhl');
        const ins = hl.querySelector('ins'), del = div.querySelector('.wbbefore del');
        const a = getComputedStyle(hl), b = getComputedStyle(ta);
        return {insBg: getComputedStyle(ins).backgroundColor,
                delBg: getComputedStyle(del).backgroundColor,
                insPad: getComputedStyle(ins).paddingLeft,
                hlW: hl.clientWidth, taW: ta.clientWidth,
                hlColor: a.color,
                font: a.fontSize + '/' + a.fontFamily + '/' + a.lineHeight,
                taFont: b.fontSize + '/' + b.fontFamily + '/' + b.lineHeight};
    })()`,
  );
  ok(paint.insBg === 'rgba(70, 180, 90, 0.28)', `the addition is painted the diff green, not merely given a class (${paint.insBg})`);
  ok(paint.delBg === 'rgba(220, 70, 70, 0.28)', `and the removal the diff red (${paint.delBg})`);
  ok(paint.hlW === paint.taW, `the highlight layer wraps at exactly the textarea's width (${paint.hlW} vs ${paint.taW})`);
  ok(paint.font === paint.taFont, `and the two layers agree on size, family and leading (${paint.font})`);
  ok(
    paint.hlColor === 'rgba(0, 0, 0, 0)',
    `the layer paints backgrounds only — its own text is transparent, so nothing doubles (${paint.hlColor})`,
  );
  // An empty <ins> is what an UNCHANGED field produces, and `.wbbody ins`'s 1px of padding would
  // then shift every line after it by 2px for no visible reason at all.
  ok(paint.insPad === '0px', `a diff span in the highlight layer carries no padding of its own (${paint.insPad})`);
}

// The association dropdown allows selecting a book or clearing the link.
// unassociate it with a world book in Vocalis… I should be able to click a drop-down that says
// what world book it's associated with. Or I should unassociate it with any world book, which is
// what I want to do."* So the reads below are now reads of a `<select>`, and the last two blocks
// DRIVE it — which is the only thing that can prove the wiring, because the route tests in
// `test_wbedit_routes.py` prove the write and cannot see whether a press reaches it.
//
// 🔴 EVERY DRIVE IS ASSERTED AT TWO LAYERS — the `<select>` AND the server's own record, read
// back with `fetch` in the same breath. A DOM-only check passes on an optimistic render that
// never issued the request; a server-only check passes on a handler nothing is wired to. Their
// DISAGREEMENT is what localizes the fault, and this pane has paid for that lesson before.
//
// ⚠️ LAST IN THE FILE ON PURPOSE. It creates a book and two cards, and the roster blocks above
// compute their expected order from the live list — safe against extra rows, but not worth
// betting a rename-by-position on. Nothing runs after this except the page-error check.
{
  await evaluate(cdp, `switchStTab('cards')`);
  await waitFor(cdp, `document.querySelector('[data-stpanel="cards"]').style.display !== 'none'`, 8000);

  const made = await evaluate(
    cdp,
    `(async () => {
        const post = async (url, body) => await (await fetch(url, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)})).json();
        const book = await post('/wbedit/books', {name: 'Sample World Book 7'});
        const card = doc => ({spec: 'chara_card_v2', spec_version: '2.0',
                              data: {name: 'Linked Sample Character', description: 'Keeps the ledger.',
                                     personality: '', scenario: '', first_mes: '',
                                     mes_example: '', extensions: {world: doc}}});
        const linked = await post('/wbedit/documents', {document: card('Sample World Book 7'), name: 'Linked Sample Character'});
        const orphan = await post('/wbedit/documents',
                                  {document: card('A Book Kept Only In SillyTavern'),
                                   name: 'Unheld Sample Character'});
        return {book: book.id, linked: linked.id, orphan: orphan.id};
    })()`,
  );

  // 🔴 THE SELECTED OPTION, NEVER `.textContent` OF THE `<select>`. A select's textContent is
  // every option's label concatenated, so `/Sample World Book 7/.test(el.textContent)` would be satisfied by
  // a control merely OFFERING the book while showing "— no world book —" — which is the exact
  // state an unassociate produces, i.e. the assertion would pass on the bug it exists to catch.
  //
  // ⚠️ EVERY DEREFERENCE IS GUARDED. A `waitFor` whose expression can throw is a race, not a wait:
  // one poll landing while `wbShowWorld` has emptied the select would kill the spec, and it would
  // present as a flake rather than as a failure.
  const WORLD_SHOWN = `(() => {
      const s = document.getElementById('wbWorldPick_cards');
      const w = document.getElementById('wbWorldWrap_cards');
      if (!s || !w) return null;
      const o = s.options[s.selectedIndex];
      return {shown: o ? o.textContent : '', value: s.value, visible: w.offsetParent !== null,
              live: !s.disabled, count: s.options.length};
  })()`;

  // 🔴 `live` IS THE ONLY HONEST SETTLE, AND ASKING FOR "NOT EMPTY" INSTEAD IS HOW THIS BLOCK
  // READ THE PREVIOUS CARD THREE TIMES. `wbOpen` calls `wbShowWorld` unawaited, so a wait
  // satisfied by whatever the select happens to be holding is satisfied INSTANTLY by the card
  // before it — the spec then asserts against a control that has not been redrawn yet. The pane
  // now blanks and disables the select before its fetch (which is a real fix, not a spinner: it
  // was clickable while showing the wrong character's book), and `!disabled` is that edge.
  const WORLD_LIVE = `((r) => !!r && r.visible && r.live)(${WORLD_SHOWN})`;

  // ── the ordinary case: we hold the book ──────────────────────────────────────────────────
  await evaluate(cdp, `wbOpen('cards', '${made.linked}')`);
  await mustWait(cdp, WORLD_LIVE, 'the world control is drawn for a linked card', 10000);
  const linked = await evaluate(cdp, WORLD_SHOWN);
  ok(
    /Sample World Book 7/.test(linked.shown),
    `the control names the world book the card is associated with (${JSON.stringify(linked.shown)})`,
  );
  ok(!/not in Vocalis/.test(linked.shown), '…without the caveat, because Vocalis holds this one');
  // The selector lists the books Vocalis holds — plus the one row that
  // is not a book: "— no world book —", the whole point of the control.
  ok(linked.count >= 2, `the dropdown offers the Vocalis books and an unassociate row (${linked.count} options)`);

  // ── 🔴 THE ONE THAT SEPARATES THE TWO DESIGNS: it follows a RENAME ───────────────────────
  //
  // §8.2 holds the link as an ID so a rename cannot break it, and `world_ref` stays the name the
  // CARD says — frozen on import day. A pane that printed `world_ref` passes every other check
  // here and then shows the OLD name while the SEND resolves the current one, so the screen
  // disagrees with what SillyTavern is about to be handed.
  await evaluate(
    cdp,
    `(async () => await fetch('/wbedit/documents/${made.book}/rename', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'Renamed Sample World Book 7'})}))()`,
  );
  await evaluate(cdp, `wbOpen('cards', '${made.linked}')`);
  await mustWait(
    cdp,
    `(${WORLD_LIVE}) && /Renamed Sample World Book 7/.test((${WORLD_SHOWN}).shown)`,
    'the card reopens after its book was renamed',
    10000,
  );
  // 🔴 THE DISPLAYED NAME AGAINST THE CARD'S OWN FROZEN COPY, read from the server in the same
  // breath. Asserting only that it says "Renamed Sample World Book 7" would also pass for an implementation
  // that re-read `world_ref` from a card that had somehow been rewritten; this says the two
  // DISAGREE and the screen is showing the resolved one, which is the only shape §8.2 permits.
  const renamed = await evaluate(
    cdp,
    `(async () => {
        const d = await (await fetch('/wbedit/documents/${made.linked}')).json();
        const s = document.getElementById('wbWorldPick_cards');
        const o = s && s.options[s.selectedIndex];
        return {shown: o ? o.textContent : '', frozen: d.world_ref, resolved: d.world_name};
    })()`,
  );
  ok(
    /Renamed Sample World Book 7/.test(renamed.shown) && renamed.frozen === 'Sample World Book 7',
    `the control follows the rename while the card's own copy stays frozen ` +
      `(shown ${JSON.stringify(renamed.shown)}, card says ${JSON.stringify(renamed.frozen)})`,
  );
  ok(
    !renamed.shown.includes(renamed.frozen) || renamed.frozen !== renamed.resolved,
    '…so the pane cannot be printing the name the card carries',
  );

  // ── the informative middle state: the card names a book we do not hold ───────────────────
  await evaluate(cdp, `wbOpen('cards', '${made.orphan}')`);
  await mustWait(cdp, WORLD_LIVE, 'the world control is drawn for an unheld book', 10000);
  const orphan = await evaluate(cdp, WORLD_SHOWN);
  ok(
    /A Book Kept Only In SillyTavern/.test(orphan.shown) && /not in Vocalis/.test(orphan.shown),
    `a book Vocalis does not hold is named AND flagged (${JSON.stringify(orphan.shown)})`,
  );
  // 🔴 IT IS NOT SELECTABLE AS A BOOK. There is no id to post — §8.2 links by identity — so the
  // option carries a sentinel the change handler refuses. Selecting "— no world book —" over it
  // is how he resolves the state, and that is the drive two blocks below.
  ok(orphan.value === 'not in vocalis', `the unheld book's option is a state, not an id (${JSON.stringify(orphan.value)})`);

  // ── a card with no world book still gets the control ─────────────────────────────────────
  //
  // ⚠️ THIS REVERSES 7.5.20's "a card with no world book draws no line at all", deliberately.
  // That was right for a status LINE — a row reading "no world book" on every character who
  // lives outside a setting is noise — and it is wrong for the only control that can give one a
  // book. There is nowhere else in Vocalis to associate a card with a World Book.
  const madeCard = await evaluate(
    cdp,
    `(async () => {
        const c = await (await fetch('/wbedit/cards', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: 'No Card Character'})})).json();
        await wbOpen('cards', c.id);
        return c.id;
    })()`,
  );
  // ⚠️ THE SETTLE IS ITS OWN STEP, not a read taken inside the same IIFE. `wbOpen` resolves
  // BEFORE `wbShowWorld`'s fetch does (it is deliberately unawaited — see the pane), so a read
  // bundled with the open sees the placeholder, and it would go on seeing it however many
  // assertions were piled on top.
  await mustWait(cdp, WORLD_LIVE, 'the control is drawn for a card that has no world book', 10000);
  const nobody = { id: madeCard, ...(await evaluate(cdp, WORLD_SHOWN)) };
  ok(nobody.visible, 'a card with no world book still shows the control that could give it one');
  ok(nobody.value === '' && /no world book/.test(nobody.shown), `…reading "— no world book —" (${JSON.stringify(nobody.shown)})`);

  // ── 🔴 DRIVE IT: pick a book for a card that had none ────────────────────────────────────
  //
  // The first of the two writes, and the first thing here that could not be proved by a route
  // test. `wbGo` is what the handler wraps the request in, so the settle is awaited by polling
  // the SERVER — never a timer, and never the DOM alone.
  await evaluate(
    cdp,
    `(() => { const s = document.getElementById('wbWorldPick_cards');
              s.value = '${made.book}'; s.dispatchEvent(new Event('change')); })()`,
  );
  await mustWait(
    cdp,
    `(async () => {
        const d = await (await fetch('/wbedit/documents/${nobody.id}')).json();
        return d.world_id === '${made.book}';
    })()`,
    'picking a book from the dropdown reaches the store',
    15000,
  );
  // 🔴 AND THEN WAIT FOR THE SCREEN SEPARATELY. The poll above is satisfied the instant the POST
  // lands, which is BEFORE the handler's `wbOpen` has redrawn anything — so a DOM read taken on
  // the strength of it is reading the control as it was before the press. Two waits, because
  // they are two claims: the store took the write, and the pane shows what the store took.
  await mustWait(
    cdp,
    `((r) => !!r && r.live && r.value === '${made.book}')(${WORLD_SHOWN})`,
    'and the control redraws onto the book it just wrote',
    15000,
  );
  // Wait for the current frame-paced select redraw, not the previous selection’s settled state.
  const LIVE_WORLD = `(async () => {
      for (let i = 0; i < 600; i++) {
        const r = ${WORLD_SHOWN};
        if (r && r.live) return r;
        await new Promise(res => requestAnimationFrame(res));
      }
      return ${WORLD_SHOWN};
  })()`;
  const picked = await evaluate(
    cdp,
    `(async () => {
        const d = await (await fetch('/wbedit/documents/${nobody.id}')).json();
        const r = (await ${LIVE_WORLD}) || {shown: '', value: null};
        return {shown: r.shown, value: r.value,
                set: d.world_set, ref: d.world_ref, latest: d.latest, revs: d.revisions.length};
    })()`,
  );
  ok(picked.value === made.book, `the control settles on the book it wrote (${JSON.stringify(picked.shown)})`);
  // 🔴 BOTH HALVES OF THE LINK, or a rename of that book re-resolves it to nothing later.
  ok(picked.ref === 'Renamed Sample World Book 7', `the card's own copy of the name was written too (${JSON.stringify(picked.ref)})`);
  ok(picked.set === true, 'the record says the user chose this, which is what lets a send carry it');
  // `set_focus`'s rule: this is metadata about the card, not an edit to its text.
  ok(picked.latest === 0 && picked.revs === 1, `changing the world book minted no revision (latest ${picked.latest})`);

  // Drive the explicit unassociate action and verify the saved relationship is cleared.
  await evaluate(
    cdp,
    `(() => { const s = document.getElementById('wbWorldPick_cards');
              s.value = ''; s.dispatchEvent(new Event('change')); })()`,
  );
  await mustWait(
    cdp,
    `(async () => {
        const d = await (await fetch('/wbedit/documents/${nobody.id}')).json();
        return d.world_id === '' && d.world_ref === '';
    })()`,
    'unassociating from the dropdown reaches the store',
    15000,
  );
  await mustWait(
    cdp,
    `((r) => !!r && r.live && r.value === '')(${WORLD_SHOWN})`,
    'and the control redraws onto "— no world book —"',
    15000,
  );
  const cleared = await evaluate(
    cdp,
    `(async () => {
        const d = await (await fetch('/wbedit/documents/${nobody.id}')).json();
        const r = (await ${LIVE_WORLD}) || {shown: '', value: null};
        return {shown: r.shown, value: r.value, set: d.world_set};
    })()`,
  );
  ok(
    cleared.value === '' && /no world book/.test(cleared.shown),
    `the control settles on "— no world book —" (${JSON.stringify(cleared.shown)})`,
  );
  ok(cleared.set === true, 'and the record marks it as HIS answer, not as a link we failed to resolve');

  // ── 🔴 DRIVE IT ON A CARD WHOSE BYTES REALLY DO NAME A BOOK ──────────────────────────────
  //
  // The card above was authored here and never carried `extensions.world` at all, so its export
  // proves only that nothing was invented. SillyTavern's Storyteller identity is a card imported with a
  // world baked into it, which is the one where the unassociate has something to undo.
  //
  // 🔴 IT HAS TO STICK THROUGH THE EXPORT. A file that still named the book would re-import
  // itself straight back into the association he just removed — the unassociate undoing itself
  // one round trip later, which is indistinguishable from it never having worked at all.
  await evaluate(cdp, `wbOpen('cards', '${made.linked}')`);
  await mustWait(cdp, WORLD_LIVE, 'the imported card is back on screen with its book selected', 10000);
  await evaluate(
    cdp,
    `(() => { const s = document.getElementById('wbWorldPick_cards');
              s.value = ''; s.dispatchEvent(new Event('change')); })()`,
  );
  await mustWait(
    cdp,
    `(async () => (await (await fetch('/wbedit/documents/${made.linked}')).json()).world_id === '')()`,
    'unassociating a card that was imported WITH a world reaches the store',
    15000,
  );
  const importedClear = await evaluate(
    cdp,
    `(async () => {
        const rev = await (await fetch('/wbedit/documents/${made.linked}/revision/0')).json();
        const out = await (await fetch('/wbedit/documents/${made.linked}/export')).json();
        return {stored: rev.content.data.extensions.world,
                exported: out.data.extensions.world};
    })()`,
  );
  // The stored revision still says "Sample World Book 7" — §8.2's rule that the card's own bytes are never
  // rewritten by a link change, which is why nothing here mints a revision. The BOUNDARY is where
  // the answer changes, and that is what SillyTavern and a re-import both read.
  ok(importedClear.stored === 'Sample World Book 7', `the card's own bytes were not rewritten (${JSON.stringify(importedClear.stored)})`);
  ok(importedClear.exported === '', `and the exported card no longer names the book (${JSON.stringify(importedClear.exported)})`);
}

// ── 9.4 · ⇊ Fix positions, and ⬇ Export file ────────────────────────────────────────────────
//
// 🔴 A ROUTE TEST CANNOT SEE ANY OF THIS. `test_wbedit_depthfix.py` proves the transform and both
// routes; what it cannot prove is that the button reaches them — and this feature's wiring has a
// shape that fails silently in exactly that gap. `wbFixDepths` calls `modal()` WITHOUT awaiting
// it, then reaches into the dialog's DOM to wire the live count line. That works only because
// `modal` does its DOM work synchronously inside the Promise executor; if it ever stops doing so,
// every assertion in `test_wbedit_depthfix.py` still passes and the dialog silently shows a count
// that never changes. This is the 7.0 lesson with a different name: the JS passed the sub-tab key
// to a route filtering on the document kind, 28 route tests were green, and one click found it.
{
  // 🔴 BACK TO BOOKS FIRST. The section above drives the Cards pane, and a control inside a
  // `display:none` panel measures 0x0 — so the geometry checks below would fail for a reason that
  // has nothing to do with the button. Same trap `getComputedStyle` sets on a hidden row.
  await evaluate(cdp, `[...document.querySelectorAll('#stTabs button')].find(b => b.dataset.sttab === 'books').click()`);
  // ⚠️ `?.style.display !== 'none'` is `undefined !== 'none'`, which is TRUE when the panel is
  // not there at all — a wait that answers yes to the one state it exists to wait out. Ask for
  // the element AND for it being laid out.
  await waitFor(
    cdp,
    `(() => { const p = document.querySelector('[data-stpanel="books"]'); return !!p && p.offsetParent !== null; })()`,
    8000,
  );

  const POSBOOK = {
    name: 'Positions Book',
    entries: {
      // ⚠️ DISTINCTIVE TITLES AND KEYWORDS, because the leak check below tests for them. The
      // first version used single letters and tested for a name from a different fixture, so
      // three of the four things a dialog could leak were not in the regex at all.
      0: {
        uid: 0,
        key: ['ledgerkey'],
        comment: 'Ledgertitle',
        constant: false,
        order: 100,
        disable: false,
        position: 0,
        content: 'ledgerbody',
      },
      1: {
        uid: 1,
        key: ['weatherkey'],
        comment: 'Weathertitle',
        constant: false,
        order: 100,
        disable: false,
        position: 1,
        content: 'weatherbody',
      },
      2: { uid: 2, key: ['wardskey'], comment: 'Wardstitle', constant: true, order: 50, disable: false, position: 0, content: 'wardsbody' },
      3: {
        uid: 3,
        key: ['tideskey'],
        comment: 'Tidestitle',
        constant: false,
        order: 100,
        disable: false,
        position: 5,
        content: 'tidesbody',
      },
    },
  };
  const posId = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({document: ${JSON.stringify(POSBOOK)}})});
        const j = await r.json();
        await wbLoadLib('books');
        await wbOpen('books', j.id);
        return j.id;
    })()`,
  );
  ok(!!posId, 'a book with real entry positions imports and opens');

  // The button is IN the toolbar and VISIBLE — `wbEntryCtl` hides it over a book with no entries,
  // so "it exists in the markup" is not the claim being made here.
  const btn = await evaluate(
    cdp,
    `(() => {
        const b = document.getElementById('wbFixDepths_books');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return {label: b.textContent.trim(), shown: getComputedStyle(b).display !== 'none', w: r.width, h: r.height};
    })()`,
  );
  ok(btn && btn.shown && btn.w > 0 && btn.h > 0, `⇊ Fix positions is on screen (${JSON.stringify(btn)})`);
  // 🔴 A BUTTON LABEL NEVER WRAPS — MEASURED ON THE TEXT, NOT ON THE BOX. `btn.h < 40` was a
  // height ceiling with ~13px of slack over a 26px `.sm` button, and `button { white-space:
  // nowrap }` in `controls.css` makes the wrap it names impossible from this feature's side
  // anyway. `Range.getClientRects().length` is the repo's own idiom (`lora_curate_browser_spec`)
  // and it counts the LINE BOXES the label actually occupies, so it still answers correctly if a
  // future stylesheet lets the label wrap.
  const label = await evaluate(
    cdp,
    `(() => {
        const b = document.getElementById('wbFixDepths_books');
        const r = document.createRange();
        r.selectNodeContents(b);
        return {lines: r.getClientRects().length, text: b.textContent.trim()};
    })()`,
  );
  ok(label && label.lines === 1, `and its label sits on one line (${JSON.stringify(label)})`);
  // 🔴 THE WHOLE STRIP, NOT FOUR OF ITS TWENTY-TWO CONTROLS. The first version of this check
  // compared ⇊ Fix positions with ⊕ expand all, ✚ Add entry and ⬆ Import entry — and those four
  // are CONTIGUOUS SIBLINGS in the middle of the row, so it was invariant to a wrap anywhere
  // before the first or after the last of them. After the last is exactly where a wrap happens
  // when you append a button there, which is what this check was added for. It widened the hole
  // from two buttons to four; it did not close it.
  //
  // Every visible BUTTON in the container, because buttons are all `.sm` and share a height, so
  // "same top" is unambiguous for them in a way it is not for the `h2` and the labels beside
  // them. A wrap anywhere in the strip puts at least one button on a different line, and the
  // failure names it.
  const strip = await evaluate(
    cdp,
    `(() => {
        const row = document.getElementById('wbFixDepths_books').parentElement;
        const read = () => {
            const out = [];
            for (const el of row.querySelectorAll('button')) {
                const r = el.getBoundingClientRect();
                if (!r.width && !r.height) continue;        // display:none — not on this row
                out.push({id: el.id || el.textContent.trim().slice(0, 12),
                          top: Math.round(r.top), right: Math.round(r.right)});
            }
            return out;
        };
        const lines = list => new Set(list.map(b => b.top)).size;
        const withFix = read();
        // The counterfactual, measured rather than reasoned about: hide the new button and read
        // the same row again. That is what turns "the strip did not wrap" — a claim about the
        // WINDOW — into a claim this feature is answerable for.
        const fix = document.getElementById('wbFixDepths_books');
        const was = fix.style.display;
        fix.style.display = 'none';
        const withoutFix = read();
        fix.style.display = was;
        const rowRight = Math.round(row.getBoundingClientRect().right);
        const top = id => Math.round(document.getElementById(id).getBoundingClientRect().top);
        return {buttons: withFix.length, lines: lines(withFix), linesWithout: lines(withoutFix),
                overflow: withFix.filter(b => b.right > rowRight + 1).map(b => b.id),
                withEntryControls: top('wbFixDepths_books') === top('wbAddEntry_books')
                    && top('wbFixDepths_books') === top('wbImportEntry_books')};
    })()`,
  );
  // ⚠️ The floor is the vacuity guard: every claim below is trivially true over an empty set, and
  // an empty set is exactly what a renamed container id would produce.
  ok(strip.buttons >= 8, `the editor toolbar has its full row of controls to measure (${strip.buttons})`);
  // 🔴 THE COUNTERFACTUAL, NOT "IT DID NOT WRAP". The first version compared four CONTIGUOUS
  // siblings, so it was blind to a wrap anywhere before the first or after the last of them — and
  // after the last is exactly where appending a button puts one. It widened the hole from two
  // buttons to four; it did not close it. Measuring the whole row then found what it had been
  // hiding: at a 1900px window this toolbar wraps onto TWO lines, and the release that added the
  // check shipped a green assertion saying otherwise.
  //
  // So the property is the one this FEATURE is answerable for. `.logwrap` is `flex-wrap: wrap` on
  // purpose and some width always wraps 22 controls; what ⇊ Fix positions must not do is be the
  // control that costs a line, and the only honest way to say that is to take it away and look.
  ok(
    strip.lines === strip.linesWithout,
    `⇊ Fix positions did not cost the toolbar a line — the same wrap with it and without it (${JSON.stringify(strip)})`,
  );
  // 🔴 AND NOTHING IS PUSHED OUT OF REACH, which is the complaint §9a.31 actually records: a
  // wrapped row is fine; a control past the container's right edge is a control he cannot find.
  ok(strip.overflow.length === 0, `and no control is pushed outside the strip (${JSON.stringify(strip.overflow)})`);
  ok(strip.withEntryControls, 'and it sits with ✚ Add entry and ⬆ Import entry, the two it belongs with');

  await evaluate(cdp, `document.getElementById('wbFixDepths_books').click()`);
  ok(await waitFor(cdp, `document.getElementById('overlay')?.classList.contains('on')`), 'it opens the preview dialog');

  const dlg = await evaluate(
    cdp,
    `(() => {
        const body = document.getElementById('mBody');
        const n = body.querySelector('b[id$="_n"]');
        const depth = body.querySelector('input[type="number"]');
        const boxes = [...body.querySelectorAll('input[type="checkbox"]')];
        return {title: document.getElementById('mTitle').textContent,
                count: n && n.textContent, depth: depth && depth.value,
                boxes: boxes.length,
                left: (body.querySelector('[id$="_left"]') || {}).textContent || '',
                // ⚠️ EVERY STRING THIS BOOK CARRIES — body, keyword AND title, for all four
                // entries. The first version tested for "Test Character 1", which is not in
                // POSBOOK at all (a dead alternation), and named neither the keywords nor the
                // comments — so a dialog that rendered entry TITLES would have passed it.
                leaks: /ledgerkey|weatherkey|wardskey|tideskey|Ledgertitle|Weathertitle|Wardstitle|Tidestitle|ledgerbody|weatherbody|wardsbody|tidesbody/.test(body.textContent)};
    })()`,
  );
  // Two conditional entries at 0/1 move by default; the constant one and the ↑EM one do not.
  ok(dlg.count === '2', `the preview counts what would move, before anything is written (${dlg.count})`);
  ok(dlg.depth === '4', `and offers the fork's own default depth (${dlg.depth})`);
  // One tick: the ↑EM entry. No flickering constant here, so there is exactly one checkbox — a
  // control that does not exist when it would do nothing, §9a.28's rule.
  ok(dlg.boxes === 1, `only the extras that apply are offered (${dlg.boxes} checkbox)`);
  // 🔴 I16 ONE LAYER OUT: these are personal books and a COUNT is the whole answer.
  ok(!dlg.leaks, 'the dialog renders no entry text at all');
  // Two of the book's four entries move; of the two left, one is the steady always-injected entry
  // and one is the ↑EM entry being offered above.
  ok(
    /2 left alone/.test(dlg.left) && /always injected and steady/.test(dlg.left) && /offered above/.test(dlg.left),
    `and it says how many are left alone, and why (${JSON.stringify(dlg.left)})`,
  );

  // 🔴 THE LIVE COUNT — the assertion the non-awaited `modal()` exists for. Ticking the extra has
  // to move the number, and it is the server's number for that combination, not `2 + 1` computed
  // here (which is wrong the moment one entry qualifies under both extras).
  const after = await evaluate(
    cdp,
    `(() => {
        const box = document.querySelector('#mBody input[type="checkbox"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', {bubbles: true}));
        return document.querySelector('#mBody b[id$="_n"]').textContent;
    })()`,
  );
  ok(after === '3', `ticking an extra repaints the count from the server's own figure (${after})`);
  // 🔴 AND THE LEFT-ALONE LINE MOVES WITH IT. The handoff's preview requirement is three numbers,
  // not two; the first build showed total and moving and left the third to subtraction. Asserted
  // on the TICKED state deliberately — the buckets shift between combinations (the ↑EM entry
  // leaves `offered` the moment its tick goes on), so a check on the default state alone would
  // pass over a breakdown that is computed once and stale everywhere else.
  const leftAfter = await evaluate(cdp, `document.querySelector('#mBody [id$="_left"]').textContent`);
  ok(/^1 left alone/.test(leftAfter), `the left-alone count follows the tick too (${JSON.stringify(leftAfter)})`);

  // Untick it again and commit the plain fix, so what lands is the default rule.
  const result = await evaluate(
    cdp,
    `(async () => {
        const box = document.querySelector('#mBody input[type="checkbox"]');
        box.checked = false;
        box.dispatchEvent(new Event('change', {bubbles: true}));
        [...document.querySelectorAll('#mActs button')].find(b => /Fix positions/.test(b.textContent)).click();
        // Check the resulting dialog state rather than returning a constant that could pass even
        // when the click missed. The modal takes the overlay down synchronously when a button
        // resolves its promise, so whether it remains visible answers whether the click landed.
        // No backticks in here - this whole block is a template literal.
        return !document.getElementById('overlay').classList.contains('on');
    })()`,
  );
  ok(result === true, 'the dialog commits and closes');
  ok(
    await waitFor(cdp, `/moved 2 entries to depth 4/.test(document.getElementById('wbMsg_books').textContent)`),
    'the message line says what moved and where',
  );

  const moved = await evaluate(
    cdp,
    `(async () => {
        const d = await (await fetch('/wbedit/documents/${posId}')).json();
        const rev = await (await fetch('/wbedit/documents/${posId}/revision/' + d.latest)).json();
        const e = rev.content.entries;
        return {latest: d.latest,
                a: [e['0'].position, e['0'].depth], b: [e['1'].position, e['1'].depth],
                c: [e['2'].position], d4: [e['3'].position],
                text: [e['0'].content, e['2'].content].join('|'),
                keys: JSON.stringify(e['0'].key)};
    })()`,
  );
  ok(moved.latest === 1, `it minted exactly one revision (${moved.latest})`);
  ok(moved.a[0] === 4 && moved.a[1] === 4 && moved.b[0] === 4, `both conditional entries are at depth 4 (${JSON.stringify(moved)})`);
  ok(moved.c[0] === 0, 'the steady always-injected entry stayed where it was');
  ok(moved.d4[0] === 5, 'and the ↑EM entry was not moved by the default rule');
  // 🔴 THE NEGATIVE HALF, IN THE BROWSER TOO. `verify` refuses server-side; this checks that the
  // source text and keywords also remain unchanged in the browser.
  ok(moved.text === 'ledgerbody|wardsbody' && moved.keys === '["ledgerkey"]', `no entry text or keyword changed (${moved.text})`);

  // ── ⬇ Export file, beside ⬆ Import file ───────────────────────────────────────────────────
  //
  // The Library export control reaches `wbDownload`, and reports a useful message when no book is open.
  // The download itself is `wbDownload`,
  // already covered; what is new is that a second control reaches it, and that the Library one
  // says something useful when nothing is open — which is the state the Library strip is usually
  // in. Asserting the branch is what proves the button is wired at all: an unwired button and a
  // wired one are indistinguishable in the markup.
  const exportBtn = await evaluate(
    cdp,
    `(() => {
        const b = document.getElementById('wbExportFile_books');
        if (!b) return null;
        const imp = document.getElementById('wbImportBtn_books');
        const r = b.getBoundingClientRect(), ri = imp.getBoundingClientRect();
        return {label: b.textContent.trim(), h: r.height,
                sameRow: Math.abs(r.top - ri.top) < 2, rightOfImport: r.left > ri.left};
    })()`,
  );
  ok(exportBtn && /Export file/.test(exportBtn.label), `⬇ Export file… is in the Library strip (${exportBtn && exportBtn.label})`);
  ok(exportBtn && exportBtn.sameRow && exportBtn.rightOfImport, 'and it sits on the same row as ⬆ Import file…, to its right');
  ok(exportBtn && exportBtn.h < 40, `its label sits on one line too (${exportBtn && exportBtn.h}px)`);

  const closedMsg = await evaluate(
    cdp,
    `(async () => {
        // Two synchronous clicks and a read, with no pauses: wbCloseEditor clears st.doc inside
        // the click, and the Export file handler (wire.js, exportOpenDoc) reaches wbSay on the
        // same stack when nothing is open. Both were followed by a 50 ms sleep.
        document.getElementById('wbClose_books').click();
        document.getElementById('wbExportFile_books').click();
        return document.getElementById('wbMsg_books').textContent;
    })()`,
  );
  ok(
    /⬇ on its row/.test(closedMsg),
    `with nothing open it points at the row button rather than dead-ending (${JSON.stringify(closedMsg)})`,
  );

  // ── the zero case, which the shipped dialog could reach and the shipped dialog got wrong ───
  //
  // 🔴 TWO DEFECTS LIVE HERE AND NEITHER IS EXOTIC. A book whose only movable
  // entries are the OFFERED ones opens with a base count of 0 — the dialog's own repaint already
  // said "will move — nothing to do" — and the primary button stayed armed beside it, so pressing
  // it POSTed, the route refused with a 400 and showed an error that contradicted the dialog.
  // `offer_unstable` DEPENDS ON THE EXAMPLES TICK, while the label carrying it
  // was rendered once from the base plan: ticking "examples" moved the headline and left the
  // label under it stale.
  const zeroId = await evaluate(
    cdp,
    `(async () => {
        const book = {name: 'Only Extras', entries: {
            0: {uid: 0, key: ['aa'], comment: 'AA', constant: true, useProbability: true,
                probability: 50, order: 100, disable: false, position: 0, content: 'aaa'},
            1: {uid: 1, key: ['bb'], comment: 'BB', constant: true, useProbability: true,
                probability: 50, order: 100, disable: false, position: 5, content: 'bbb'}}};
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify({document: book})});
        const j = await r.json();
        await wbLoadLib('books');
        await wbOpen('books', j.id);
        return j.id;
    })()`,
  );
  ok(!!zeroId, 'a book whose only candidates are the offered extras imports and opens');

  await evaluate(cdp, `document.getElementById('wbFixDepths_books').click()`);
  ok(
    await waitFor(cdp, `document.getElementById('overlay')?.classList.contains('on')`),
    'the dialog still opens for it — there IS something it could do',
  );

  const zero = await evaluate(
    cdp,
    `(() => {
        const body = document.getElementById('mBody');
        const primary = document.querySelector('#mActs button.primary');
        const boxes = [...body.querySelectorAll('input[type="checkbox"]')];
        return {count: body.querySelector('b[id$="_n"]').textContent,
                says: body.querySelector('span[id$="_w"]').textContent,
                armed: !!primary && !primary.disabled,
                boxes: boxes.length,
                unstableLabel: (body.querySelector('b[id$="_uc"]') || {}).textContent};
    })()`,
  );
  ok(zero.count === '0' && /nothing to do/.test(zero.says), `it opens at nothing-would-move (${JSON.stringify(zero)})`);
  ok(zero.boxes === 2, `and offers both extras (${zero.boxes} checkboxes)`);
  ok(zero.armed === false, 'and Fix positions is DISABLED, so the only thing it can do is not produce a red error');
  ok(zero.unstableLabel === '1', `the always-injected label starts at the base plan's figure (${zero.unstableLabel})`);

  // Tick the EXAMPLES box only. Nothing moves yet — but the entry it releases is an always-
  // injected one, so it lands in the OTHER offer, and that label has to follow.
  const afterExamples = await evaluate(
    cdp,
    `(() => {
        const body = document.getElementById('mBody');
        const box = body.querySelector('input[id$="_e"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', {bubbles: true}));
        const primary = document.querySelector('#mActs button.primary');
        return {count: body.querySelector('b[id$="_n"]').textContent,
                unstableLabel: (body.querySelector('b[id$="_uc"]') || {}).textContent,
                armed: !!primary && !primary.disabled};
    })()`,
  );
  ok(
    afterExamples.unstableLabel === '2',
    `the always-injected label is recounted once the examples tick is on (${JSON.stringify(afterExamples)})`,
  );
  ok(afterExamples.count === '0' && afterExamples.armed === false, 'and with nothing moving yet the button is still disabled');

  const afterBoth = await evaluate(
    cdp,
    `(() => {
        const body = document.getElementById('mBody');
        const box = body.querySelector('input[id$="_u"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', {bubbles: true}));
        const primary = document.querySelector('#mActs button.primary');
        return {count: body.querySelector('b[id$="_n"]').textContent,
                armed: !!primary && !primary.disabled};
    })()`,
  );
  ok(
    afterBoth.count === '2' && afterBoth.armed === true,
    `ticking both arms the button and moves the count (${JSON.stringify(afterBoth)})`,
  );

  // Cancel: nothing here should mint, and the busy line from the preview must not be left
  // spinning behind the dialog — the defect a screenshot caught before this block existed.
  // 🔴 "CANCEL MINTS NOTHING" IS A NEGATIVE CLAIM, so it used to be: click, sleep 60 ms, read the
  // revision count. A mint is a POST issued in the microtasks right after the click, so the click
  // is now made INSIDE the reading step, with the write log (INSTALL_WRITE_LOG) noting any
  // request it causes; two frames let the dialog's continuation finish (it also takes the busy
  // line down), any such request is awaited, and only then is the server read.
  await evaluate(cdp, INSTALL_WRITE_LOG);
  const afterCancel = await evaluate(
    cdp,
    `(async () => {
        const writes0 = window.__wbWrites.length;
        [...document.querySelectorAll('#mActs button')].find(b => /Cancel/.test(b.textContent)).click();
        await ${NEXT_FRAME};
        const made = window.__wbWrites.slice(writes0);
        await Promise.all(made.map(w => w.p));
        const d = await (await fetch('/wbedit/documents/${zeroId}')).json();
        const msg = document.getElementById('wbMsg_books');
        return {latest: d.latest, msg: msg.textContent, writes: made.length,
                spinning: !!msg.querySelector('.spin'), open: document.getElementById('overlay').classList.contains('on')};
    })()`,
  );
  ok(
    afterCancel.latest === 0 && afterCancel.open === false && afterCancel.writes === 0,
    `canceling mints nothing (${JSON.stringify(afterCancel)})`,
  );
  ok(!afterCancel.spinning, 'and leaves no spinner running behind it');
}

// == 9.5.4 · A PRESS THAT CHANGES NOTHING STILL HAS TO ANSWER =================================
//
// Report when all entry positions already match their depth; an empty result still needs feedback.
//
// It DID answer — on `#wbMsg_books`, and that strip lives in the library header while the button
// lives in the editor toolbar, which `wbPlaceEditor` grafts into a roster row. On a book part-way
// down the list the reply rendered off the top of the window, so the press looked inert. Both
// halves are asserted: the dialog here, the address of the message line in the block below.
{
  const doneId = await evaluate(
    cdp,
    `(async () => {
        const book = {name: 'Already At Depth', entries: {
            0: {uid: 0, key: ['aa'], comment: 'AA', constant: false, order: 100,
                disable: false, position: 4, depth: 4, content: 'aaa'},
            1: {uid: 1, key: ['bb'], comment: 'BB', constant: false, order: 100,
                disable: false, position: 4, depth: 9, content: 'bbb'}}};
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify({document: book})});
        const j = await r.json();
        await wbLoadLib('books');
        await wbOpen('books', j.id);
        return j.id;
    })()`,
  );
  ok(!!doneId, 'a book with every entry already at depth imports and opens');

  await evaluate(cdp, `document.getElementById('wbFixDepths_books').click()`);
  ok(
    await waitFor(cdp, `document.getElementById('overlay')?.classList.contains('on')`),
    'pressing it opens a DIALOG rather than writing to a message line he cannot see',
  );

  const nothing = await evaluate(
    cdp,
    `(() => {
        const acts = [...document.querySelectorAll('#mActs button')];
        return {title: document.getElementById('mTitle').textContent,
                body: document.getElementById('mBody').textContent,
                buttons: acts.map(b => b.textContent)};
    })()`,
  );
  ok(/Nothing to fix/.test(nothing.title), `the dialog names the outcome (${nothing.title})`);
  ok(/already at/i.test(nothing.body), `and says WHY nothing moved (${nothing.body.slice(0, 90)})`);
  // 🔴 ONE BUTTON. There is nothing to cancel — the book is already right — so a Cancel/Confirm
  // pair would invent a decision out of an acknowledgment.
  ok(nothing.buttons.length === 1 && /OK/.test(nothing.buttons[0]), `one button, and it is OK (${JSON.stringify(nothing.buttons)})`);

  // Same method as the Cancel above: the click is made inside the reading step so the write log
  // (INSTALL_WRITE_LOG) sees what it causes; two frames, then await those, then read. This was a
  // click, a 60 ms sleep and a read.
  const closed = await evaluate(
    cdp,
    `(async () => {
        const writes0 = window.__wbWrites.length;
        [...document.querySelectorAll('#mActs button')].find(b => /OK/.test(b.textContent)).click();
        await ${NEXT_FRAME};
        const made = window.__wbWrites.slice(writes0);
        await Promise.all(made.map(w => w.p));
        const d = await (await fetch('/wbedit/documents/${doneId}')).json();
        return {latest: d.latest, writes: made.length, open: document.getElementById('overlay').classList.contains('on'),
                spinning: !!document.getElementById('wbMsg_books').querySelector('.spin')};
    })()`,
  );
  ok(closed.open === false, 'OK dismisses it');
  // 🔴 AND IT MINTS NOTHING. An acknowledgment that quietly wrote a revision would put an
  // identical snapshot in the picker — a rollback target that does nothing.
  ok(closed.latest === 0 && closed.writes === 0, `nothing was written (revision ${closed.latest})`);
  ok(!closed.spinning, 'and the "looking at where the entries sit" spinner did not survive the dialog');
}

// == 9.5.4 · THE MESSAGE LINE IS WHERE THE BUTTON IS ==========================================
//
// Show save progress beside the active row as well as in the page-level status strip.
//
// 🔴 ASSERTED AT BOTH STRIPS, BECAUSE EITHER ONE ALONE PASSES ON THE BUG. Reading only
// `#wbMsgEd_books` is satisfied by a build that renders the message TWICE; reading only
// `#wbMsg_books` is satisfied by the shipped code, which is what put the message off screen in
// the first place. The claim is "exactly one is visible, and it is the one next to him".
{
  await evaluate(
    cdp,
    `(async () => {
        const book = {name: 'Strip Address', entries: {
            0: {uid: 0, key: ['aa'], comment: 'AA', constant: false, order: 100,
                disable: false, position: 1, content: 'aaa'}}};
        const r = await fetch('/wbedit/documents', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify({document: book})});
        const j = await r.json();
        await wbLoadLib('books');
        await wbOpen('books', j.id);
    })()`,
  );

  const withEditor = await evaluate(
    cdp,
    `(() => {
        wbSay('books', 'sending to SillyTavern…', 'busy');
        const ed = document.getElementById('wbMsgEd_books');
        const lib = document.getElementById('wbMsg_books');
        return {
            editorOpen: document.getElementById('wbEditor_books').style.display !== 'none',
            edText: ed.textContent, edSpin: !!ed.querySelector('.spin'),
            edShown: getComputedStyle(ed).display !== 'none',
            libText: lib.textContent, libShown: getComputedStyle(lib).display !== 'none',
        };
    })()`,
  );
  ok(withEditor.editorOpen, 'the editor is open for this block');
  ok(/sending to SillyTavern/.test(withEditor.edText), `the message reaches the editor's own strip (${withEditor.edText})`);
  ok(withEditor.edSpin, 'and it carries the spinner, beside the button he pressed');
  ok(withEditor.edShown && !withEditor.libShown, 'exactly one strip is on screen, and it is the editor one');
  // The text still lives in `#wbMsg_books` whether or not it is shown — 23 assertions in this
  // file read it, and they are asserting the MESSAGE, not its address.
  ok(/sending to SillyTavern/.test(withEditor.libText), 'the library strip still HOLDS the text for anything reading it');

  // 🔴 THE DISMISS HAS TO REACH BOTH. The ✕ carries `data-wbhush` and the listener is delegated on
  // `document`, so the press can arrive from either copy; clearing one would leave the other
  // holding a message he had just dismissed.
  const dismissed = await evaluate(
    cdp,
    `(() => {
        wbSay('books', 'saved to SillyTavern', 'ok');
        const x = document.querySelector('#wbMsgEd_books button.wbx');
        const had = !!x;
        if (x) x.click();
        return {had, ed: document.getElementById('wbMsgEd_books').textContent,
                lib: document.getElementById('wbMsg_books').textContent};
    })()`,
  );
  ok(dismissed.had, 'the editor copy carries its own ✕');
  ok(dismissed.ed === '' && dismissed.lib === '', `and one press clears both (${JSON.stringify(dismissed)})`);

  // Close the editor and the library strip is the one that comes back — otherwise a message about
  // the LIBRARY (an import, a sweep) would land in a hidden element and be lost.
  const closedEditor = await evaluate(
    cdp,
    `(() => {
        document.getElementById('wbClose_books').click();
        wbSay('books', 'imported 1 book', 'ok');
        const ed = document.getElementById('wbMsgEd_books');
        const lib = document.getElementById('wbMsg_books');
        return {edText: ed.textContent, libText: lib.textContent,
                libShown: getComputedStyle(lib).display !== 'none'};
    })()`,
  );
  ok(closedEditor.libShown, 'with the editor closed the library strip is visible again');
  ok(/imported 1 book/.test(closedEditor.libText), 'and it carries the message');
  ok(closedEditor.edText === '', 'while the editor copy is left empty rather than stale');
}

// Keep the merge action on each character row so it remains available while editing a card.
// 🔴 `switchStTab('cards')` FIRST, AND THE LIVE-MEASUREMENT CHECK BELOW IS WHY. Every block above
// drives the panes directly and leaves whichever sub-tab it liked on screen; measured through a
// `display:none` ancestor every rect is 0×0, and "same row" (|0-0| < 2) is then TRUE for two
// buttons that could be anywhere. A geometry suite that silently measures nothing is worse than
// none, so `live` asserts the buttons have real width before anything is concluded from them.
//
// ⚠️ GEOMETRY, NOT `parentElement`, for the placement itself. The claim is where he SEES it — on
// the open card's own header line, beside ⬇ Export — and a DOM-ancestry check would stay green if
// the row wrapped and put it on a line of its own. The negative half matters just as much: still
// finding it up in the Library strip would mean there are two of them.
{
  const mergeHome = await evaluate(
    cdp,
    `(async () => {
        const wait = async (test) => {
            for (let i = 0; i < 1500; i++) {
                try { if (test()) return true; } catch (e) {}
                await new Promise(r => setTimeout(r, 10));
            }
            return false;
        };
        switchStTab('cards');
        const made = await (await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: {spec: 'chara_card_v2', spec_version: '2.0', data: {
                name: 'Cheetara 966', description: 'the fastest', personality: 'wry',
                scenario: 'the plains', first_mes: 'Hello.', mes_example: ''}}})})).json();
        await wbLoadLib('cards');
        await wbOpen('cards', made.id);
        await wait(() => document.getElementById('wbDocName_cards').textContent === 'Cheetara 966');

        const b = document.getElementById('wbMergeImport_cards');
        const ex = document.getElementById('wbExport_cards');
        const file = document.getElementById('wbMergeFile_cards');
        const strip = document.getElementById('wbImportBtn_cards');
        if (!b || !ex || !strip) return null;
        const r = b.getBoundingClientRect(), re = ex.getBoundingClientRect(),
              rs = strip.getBoundingClientRect();
        return {label: b.textContent.trim(), h: r.height,
                live: r.width > 10 && re.width > 10 && rs.width > 10,
                sameRowAsExport: Math.abs(r.top - re.top) < 2, rightOfExport: r.left > re.left,
                offTheLibraryStrip: Math.abs(r.top - rs.top) > 2,
                fileTraveledWithIt: !!file && b.parentElement === file.parentElement};
    })()`,
  );
  ok(mergeHome && mergeHome.live, `the cards pane is really on screen, so these rects mean something (${JSON.stringify(mergeHome)})`);
  ok(mergeHome && /Import &? ?merge/.test(mergeHome.label), `⇄ Import & merge… is on the open card (${mergeHome && mergeHome.label})`);
  ok(mergeHome && mergeHome.sameRowAsExport && mergeHome.rightOfExport, 'on the same header line as ⬇ Export, to its right');
  ok(mergeHome && mergeHome.offTheLibraryStrip, 'and no longer up in the Library strip, which is the trip he called goofy');
  ok(mergeHome && mergeHome.h < 40, `⇄ Import & merge…'s own label does not wrap either (${mergeHome && mergeHome.h}px)`);
  ok(mergeHome && mergeHome.fileTraveledWithIt, 'its hidden file input moved with it, so the picker it opens is still the one wired');
}

// Rapid open/close must not leave asynchronous proposal rendering with missing card data.
// 🔴 THE DELAY IS ON THE DRAFT READ ONLY, AND IT IS THE PROBE, SO IT IS ASSERTED. A wrapper that
// silently matched nothing would leave this block green against the broken build — the race would
// simply never open. `held` counts the requests it actually held, and the check below fails if it
// is zero.
//
// ⚠️ AND `shown` IS THE OTHER HALF OF THE SAME GUARANTEE: it says the editor was really on screen
// with rows in it before ✕ was pressed. Without it a close that landed during the FIRST fetch
// would pass while testing a window with no accessible controls.
//
// 🔴 IT WAITS ON THE NEW DOCUMENT'S NAME, NOT ON "the editor is visible". The block above leaves
// a card open, so a visibility test is satisfied by the PREVIOUS one before this open has made a
// single request — ✕ then lands during the first fetch, `wbOpen` bails at the guard that was
// already there, and the whole block passes without ever entering the window it exists to test.
// Measured: that is exactly what the first version of this did, and `held` came back 0.
const raced = await evaluate(
  cdp,
  `(async () => {
        const wait = async (test) => {
            for (let i = 0; i < 1500; i++) {
                try { if (test()) return true; } catch (e) {}
                await new Promise(r => setTimeout(r, 10));
            }
            return false;
        };
        const made = await (await fetch('/wbedit/documents', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({document: {spec: 'chara_card_v2', spec_version: '2.0', data: {
                name: 'Snarf 966', description: 'a cook', personality: 'anxious',
                scenario: 'the lair', first_mes: 'Snarf snarf.', mes_example: ''}}})})).json();
        await wbLoadLib('cards');
        wbCloseEditor('cards'); // start from nothing open, so 'shown' below is about THIS open

        const realFetch = window.fetch;
        let held = 0;
        // 🔴 A GATE THE SPEC OPENS, NOT A 300 ms TIMER. The draft read used to be answered after a
        // fixed 300 ms, which is the window ✕ had to land in; on a slow box the page took longer
        // than that to draw its fields, and on a fast one the window was gone. Now the read is held
        // until this block has SEEN the editor on screen with its rows drawn and has pressed ✕,
        // and only then released, so the race is entered on every machine. The gating flag goes
        // false when it is released so a later draft read (if the page asks again) is never held:
        // a gate nobody opens would hang the spec rather than fail it. (No backticks in here.)
        const gates = [];
        let gating = true;
        window.fetch = function (url, opts) {
            if (gating && String(url).indexOf('/draft/') >= 0) {
                held++;
                return new Promise(r => gates.push(() => r(realFetch.call(window, url, opts))));
            }
            return realFetch.call(window, url, opts);
        };
        try {
            const msg = document.getElementById('wbMsg_cards');
            msg.textContent = '';
            msg.className = 'small muted';
            const opening = wbOpen('cards', made.id);
            const shown = await wait(() =>
                document.getElementById('wbEditor_cards').style.display !== 'none'
                && document.getElementById('wbDocName_cards').textContent === 'Snarf 966'
                && document.querySelectorAll('#wbFields_cards .wbfield').length > 0);
            document.getElementById('wbClose_cards').click();
            gating = false;
            gates.splice(0).forEach(open => open());
            await opening;
            // Two frames instead of the 400 ms that was here: wbOpen has returned, so what could
            // still land is work it queued for the next paint (a requestAnimationFrame), and a
            // frame is the unit that work is measured in.
            await ${NEXT_FRAME};
            return {held, shown, msg: msg.textContent, cls: msg.className,
                    rows: document.querySelectorAll('#wbFields_cards .wbfield').length,
                    shut: document.getElementById('wbEditor_cards').style.display === 'none',
                    openId: !!(wbState('cards').openId)};
        } finally { window.fetch = realFetch; }
    })()`,
);
ok(raced.held > 0, `the draft read really was held open, so the race window exists (${raced.held} request(s))`);
ok(raced.shown, 'the editor was on screen with its fields drawn — the moment ✕ Close becomes pressable');
ok(raced.rows > 0, `and closing leaves those rows in the DOM, which is what made the crash reachable (${raced.rows})`);
ok(
  !/wbbad/.test(raced.cls) && !/Cannot read propert|undefined/i.test(raced.msg),
  `closing it straight away prints no error (${JSON.stringify(raced.cls)} ${JSON.stringify(raced.msg)})`,
);
ok(raced.shut && !raced.openId, 'and the late open does not re-populate the pane he already dismissed');

// Ctrl+F remains available on the ACE step page; its shortcut guard must check the outer tab.
// 🔴 THE GUARD ASKED ABOUT THE SUB-TAB AND NEVER ABOUT THE TAB. `st/tabs.js` checked `stTabNow()`
// — which is persisted in UIS and so goes on answering 'books' from every other tab and across
// reloads — and then whether the editor PANE was `display:none`. `switchTab` hides the
// `<section data-panel>`, not the pane inside it, so on the ACE-Step tab both tests passed, the
// handler called `preventDefault()`, and the browser's own find never opened. The app is mostly
// long lists; taking that key away from them is a regression in nearly every tab.
//
// 🔴 BOTH ARMS, OR THIS CHECK IS DECORATION. "Ctrl+F is not captured on the ACE tab" passes just
// as happily when the handler is deleted, when the editor was never opened, and when the key
// binding never existed. The first arm — it IS captured, here, with the editor open — is what
// makes the second one mean something.
await evaluate(cdp, `document.querySelector('#stTabs button[data-sttab="books"]').click()`);
await evaluate(cdp, `wbOpen('books', '${docId}', 0)`);
const findArmed = await waitFor(cdp, `document.getElementById('wbEditor_books').style.display !== 'none'`, 10000);
ok(findArmed, 'a worldbook is open in the editor, which is the only state Ctrl+F is for');
const CTRL_F = `(() => { const e = new KeyboardEvent('keydown', {key: 'f', ctrlKey: true, bubbles: true, cancelable: true});
      document.dispatchEvent(e); return e.defaultPrevented; })()`;
ok(await evaluate(cdp, CTRL_F), '🔴 Ctrl+F IS taken by the find bar while the editor is the thing you are looking at');
ok(
  await waitFor(cdp, `document.getElementById('wbFind_books').style.display !== 'none'`, 5000),
  'and it really opened the find bar, not merely swallowed the key',
);

// Now stand somewhere else. The sub-tab is unchanged and the editor pane's own display is
// unchanged — which is exactly the state that used to swallow the key.
await evaluate(cdp, `document.querySelector('#tabs button[data-tab="acestep"]').click()`);
const away = await evaluate(
  cdp,
  `(() => { const p = document.querySelector('section[data-panel="sillytavern"]');
      const ed = document.getElementById('wbEditor_books');
      return {panelHidden: p.style.display === 'none', paneStillShown: ed.style.display !== 'none'}; })()`,
);
ok(away.panelHidden, 'switching tabs hides the SillyTavern panel');
ok(away.paneStillShown, '🔴 …but NOT the editor pane inside it — which is why the old guard could not tell where you were standing');
ok((await evaluate(cdp, CTRL_F)) === false, '🔴 Ctrl+F on another tab is LEFT ALONE, so the browser opens its own find');
await evaluate(cdp, `document.querySelector('#tabs button[data-tab="sillytavern"]').click()`);
ok(await evaluate(cdp, CTRL_F), 'and coming back to SillyTavern hands the key to the editor again');

// Undeleting a card must restore its source data and make it visible in the active roster.
// `Undelete` un-declined the ref and fetched nothing — the DATA lives in SillyTavern and only the
// ⟳ sweep can pull it. So the row left the bin, no document arrived, and the one surviving record
// of WHICH document had been deleted was consumed by the press. It now runs the import too, and
// puts the ref back when nothing comes of it.
//
// 🔴 THIS IS THE JOIN, WHICH IS THE PART THE OTHER TESTS CANNOT SEE. `test_wbedit_dismissed.py`
// proves each route in isolation; `test_webui_modules.py` proves the registry string matches at
// both ends. Neither can prove that pressing the BUTTON walks restore → sweep → check → rollback,
// and that is precisely the seam the bug lived in — every route it called was already correct.
//
// ⚠️ THE SWEEP IS ENDED OUT OF BAND RATHER THAN WAITED OUT. No SillyTavern extension is paired
// here, so the request would sit pending for `PENDING_S` (10 minutes). `DELETE /wbedit/st-sweep`
// is the same door the Cancel button uses, and the client's next 2s poll sees neither `pending`
// nor `running` and takes its terminal branch — the real code path, on a real timer, in seconds.
{
  const GHOST = 'SpecGhost.png';
  // The fixture is seeded through the rollback route itself, which is the only door that can put a
  // ref in the bin without deleting a document — and a ref with NO document is exactly the state
  // that guarantees the import cannot bring it back, so the failing arm is reached deterministically
  // instead of by hoping SillyTavern stays silent.
  await evaluate(
    cdp,
    `(async () => { await fetch('/wbedit/dismissed', {method:'POST',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify({ref: '${GHOST}'})}); })()`,
  );
  await evaluate(cdp, `wbLoadLib('cards')`);
  const ROW = `document.querySelector('#wbDismissed_cards [data-ref="${GHOST}"]')`;
  // ⚠️ EVERY WAIT BELOW IS WRITTEN SO IT CANNOT THROW — `?.` on each hop and `|| []` on each list.
  // `waitFor` treats a page exception as "not yet", so an unguarded dereference does not fail the
  // check, it turns the wait into a race that goes red only under a loaded suite.
  const BINNED = `fetch('/wbedit/dismissed').then(r => r.json()).then(j => (j.refs || []).includes('${GHOST}'))`;
  // 🔴 EVERY BUDGET HERE IS SECONDS, NOT THE FILE'S 30 s DEFAULT, AND THAT IS A CORRECTNESS FIX
  // RATHER THAN TIDYING. This block is LAST, on top of a ~52 s green run, against a 100 s per-test
  // ceiling. At the default, three of these waits failing spends the whole 90 s shared allowance,
  // pytest kills the xdist worker mid-run, and NOTHING the spec printed reaches the log — measured
  // exactly that way while mutation-proving this block, where the reverted handler produced
  // `worker 'gw0' crashed` instead of six red lines naming what broke. The gesture itself settles
  // in about three seconds (one 2 s sweep poll plus round trips), so these are generous.
  ok(await waitFor(cdp, `!!${ROW}`, 6000), 'a deleted document shows a row in the recycle bin');

  await evaluate(cdp, `${ROW}.querySelector('.wbundel').click()`);
  // 🔴 THE ROW SURVIVES THE PRESS. This is the assertion that fails against the old code, where
  // the handler's `wbLoadLib` ran the moment the restore returned and took the row with it.
  ok(
    await waitFor(cdp, `!!${ROW} && /Undeleting/.test(${ROW}?.querySelector('.wbundel')?.textContent || '')`, 6000),
    '🔴 pressing Undelete keeps the row on screen and says it is working',
  );
  ok(
    await evaluate(cdp, `${ROW}?.querySelector('.wbpurge')?.disabled === true`),
    '…and disables ✕ Delete permanently beside it, so a purge cannot land mid-gesture',
  );
  // ⚠️ A WAIT, NOT A READ: `busy(true)` paints the label BEFORE the restore is awaited, so reading
  // this the instant the label appears is a race against the round trip rather than a check of it.
  ok(
    await waitFor(cdp, `Promise.resolve(${BINNED}).then(v => !v)`, 6000),
    'the ref really is un-declined while the import runs — the row is not merely being drawn',
  );

  // No extension is paired, so the request would sit pending for ten minutes. This is the door
  // the Cancel button uses; the client's next 2 s poll then takes its terminal branch.
  await evaluate(cdp, `fetch('/wbedit/st-sweep', {method:'DELETE'}).then(() => 0)`);
  ok(await waitFor(cdp, BINNED, 10000), '🔴 …and when the import brings nothing back, the ref goes STRAIGHT BACK in the bin');
  ok(
    await waitFor(cdp, `!!${ROW} && ${ROW}?.querySelector('.wbundel')?.disabled === false`, 6000),
    'the row is live again, so a second attempt is the same one click',
  );
  ok(
    await waitFor(cdp, `/did not come back/.test(document.getElementById('wbMsg_cards')?.textContent || '')`, 6000),
    'and the message line says so rather than leaving him to notice',
  );

  await evaluate(cdp, `(async () => { await fetch('/wbedit/dismissed/${GHOST}/purge', {method:'POST'}); await wbLoadLib('cards'); })()`);
}

// 🔴 The last check, and it would have caught `toast()`.
ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.slice(0, 2).join(' | ')})`);

await cleanup();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

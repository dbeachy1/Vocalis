// Vocalis 5.1.2 — a character that SillyTavern registers while you are sitting on the
// SillyTavern ▸ Characters tab appears there, in a REAL browser, with no reload.
//
// The bug: press Play in SillyTavern with this tab open and the character was registered
// server-side immediately, but the panel had rendered once on tab-open and never asked again.
// You only saw the row by navigating away and back. The Nomi tab has had a live poll since
// 3.x (pollNomiNew); the ST tab never got one.
//
// Why a browser and not a markup regex: everything this feature is made of is behavior over
// time — an interval firing, a row spliced into a sorted list, a dirty-state baseline that
// must NOT light up Save, and a deleted row that must NOT come back. A string test of
// renderStChars() output cannot see any of it, and would have passed on the broken build.
//
// Same CDP plumbing and the same no-npm rule as voices_player_browser_spec.mjs.
//
// Usage: node st_characters_live_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { INSTALL_FETCH_LOG, fetchCount, fetchCountAtLeast } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node st_characters_live_spec.mjs <base-url> <chrome-path>');
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

// The panel polls on an interval, so anything waiting on it needs more than one tick of headroom.
//
// 🔴 ONE NUMBER, AND IT IS CHECKED AGAINST THE APP. This file used to carry the interval twice —
// `POLL_WAIT = 12000` here and a bare `sleep(6000)` below — both hand-derived from "the panel
// polls every 4s". Two copies of a constant nobody would think to update: raise
// `setInterval(pollStNew, …)` to 10 s and the 6 s window silently stops containing a tick, which
// turns a real assertion ("a deleted row is NOT resurrected") into one that cannot fail. See
// `verifyPollInterval` below — the spec reads the module and refuses to run on a mismatch, so the
// duplication cannot rot in silence.
const POLL_MS = 4000; // mirrors chars.js `stPollStart`
const POLL_WAIT = POLL_MS * 3;

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

async function waitFor(cdp, expression, timeoutMs = POLL_WAIT) {
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
    await sleep(150);
  }
}

// The SillyTavern extension's own call — issued from OUTSIDE the page, exactly as ST does it,
// so nothing about the page's own state can be what makes the row appear.
async function stRegister(...names) {
  const r = await fetch(new URL('v1/st/characters', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characters: names }),
  });
  if (!r.ok) throw new Error(`POST /v1/st/characters -> ${r.status}`);
  return r.json();
}

const rowNames = `[...document.querySelectorAll('#stList .stRow')].map(r=>r.dataset.name)`;
const rowOf = n => `document.querySelector('#stList .stRow[data-name="${n}"]')`;

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-cdp-st-'));
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
    // 🔴 NOT --disable-background-timer-throttling. The whole feature is a setInterval in a
    // foreground tab; the spec keeps the page visible and asserts the real thing fires.
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

  await cdp.send('Page.navigate', { url: baseUrl });
  ok(await waitFor(cdp, 'document.readyState === "complete" && window.__uiReady === true && window.__bootDone === true'), 'the page loads');

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in
  // the page's GLOBAL scope — so `switchTab(…)` below would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ `window.__uiReady` REPLACED a bare `readyState` gate in the same commit: readyState
  // is true before js/main.js has run, and this publish must not race the module graph.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  // Counts the page's own requests as their responses arrive — see the absence check below.
  await evaluate(cdp, INSTALL_FETCH_LOG);

  // 🔴 THE POLL INTERVAL THIS FILE'S WAITS ARE BUILT ON, CHECKED AGAINST THE APP.
  //
  // Every timing claim below is "more than one tick", expressed as a multiple of `POLL_MS`.
  // That number lives in `chars.js`, and a copy of it here is a copy that can rot — silently,
  // and in the direction that matters: raise the interval and the absence windows stop
  // containing a tick, so "a deleted row is NOT resurrected" passes because nothing had time to
  // resurrect it. `/webui/js/` is served precisely so a spec can read a module (`ui.py:250`),
  // so the file is the authority and this is a check rather than a second declaration.
  const servedInterval = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/webui/js/st/chars.js');
        if (!r.ok) return -1;
        const m = /setInterval\\(pollStNew, *(\\d+)\\)/.exec(await r.text());
        return m ? Number(m[1]) : 0;
    })()`,
  );
  if (servedInterval !== POLL_MS) {
    throw new Error(
      `chars.js polls every ${servedInterval}ms but this spec's waits are built ` +
        `on ${POLL_MS}ms — update POLL_MS, or every "more than one tick" window ` +
        `below is covering less than a tick and proving nothing`,
    );
  }

  // SillyTavern ▸ Characters, with the register EMPTY — the state the bug was reported in.
  await evaluate(cdp, `switchTab('sillytavern')`);
  await evaluate(cdp, `switchStTab('characters')`);
  ok(
    await waitFor(cdp, `${rowNames}.length === 0 && /No characters yet/.test($('stList').textContent)`),
    'the tab opens on an empty character list',
  );
  // ⚠️ `waitFor`, NOT a bare `evaluate` — this was a real flake, caught by the 7.0 review's
  // own full-suite run and reproduced only under `-n 16` load (3/3 green in isolation).
  // The timer is assigned asynchronously, so reading it on the instant the list renders
  // is a race: the check above waits for the DOM, and this one used to assume the timer had
  // been set by then. Every neighboring check already waits; this one was the outlier.
  // ⚠️ `stPollRunning()`, NOT the bare `stPollTimer` this read until 7.3-m11b. The timer is
  // private to js/st/chars.js now and the module publishes a predicate over it — reading the
  // `let` off `window` would be a value copied once at load, which is null, so the three
  // `!stPollRunning()` checks below would pass against nothing. That module's header has it.
  ok(await waitFor(cdp, `stPollRunning()`), 'opening the tab starts the live poll');

  // ── 🔴 THE BUG. Register a character the way SillyTavern does, touch nothing in the
  // page, and require the row to arrive on its own.
  await stRegister('Test Character 3');
  const appeared = await waitFor(cdp, `${rowOf('Test Character 3')}`);
  ok(appeared, '🔴 a character registered by SillyTavern APPEARS without navigating away and back');
  if (!appeared) throw new Error('the row never arrived — the live poll is not working');

  // A row that arrives half-built is its own bug: the dropdown must be populated and the
  // knobs must carry the character's values, exactly as a full render gives them.
  const built = await evaluate(
    cdp,
    `(() => {
        const r = ${rowOf('Test Character 3')}, pre = r.dataset.pre;
        return { opts: $(pre+'Voice') ? $(pre+'Voice').options.length : 0,
                 exag: $(pre+'Exag') ? $(pre+'Exag').value : null,
                 aud: !!$(pre+'Aud'), del: !!r.querySelector('.stDel'),
                 seen: /seen \\d{4}-\\d{2}-\\d{2}/.test(r.textContent) };
    })()`,
  );
  ok(
    built.opts > 0 && built.exag === '0.5' && built.aud && built.del && built.seen,
    `the inserted row is fully wired — voice dropdown, knobs, Audition, 🗑, last_seen ` + `(got ${JSON.stringify(built)})`,
  );

  // 🔴 AND SAVE STAYS DISABLED. The dirty check compares the collected rows against a
  // baseline snapshot; a row appearing under you is not an edit YOU made, and a Save button
  // that goes green on its own invites you to write back a map you never looked at.
  ok(await evaluate(cdp, `$('stSave').disabled === true`), '🔴 the new row does NOT falsely mark the tab dirty — Save stays disabled');

  // Sorted insertion: the list renders alphabetically, so arrivals must splice into place
  // rather than pile up at the bottom.
  await stRegister('Test Character 1', 'Test Character 4');
  ok(await waitFor(cdp, `${rowOf('Test Character 1')} && ${rowOf('Test Character 4')}`), 'more characters arrive on later ticks');
  const order = await evaluate(cdp, rowNames);
  ok(
    JSON.stringify(order) === JSON.stringify(['Test Character 1', 'Test Character 3', 'Test Character 4']),
    `arrivals land in ALPHABETICAL position, not appended (got ${JSON.stringify(order)})`,
  );

  // 🔴 AN UNSAVED EDIT SURVIVES. This is why the poll inserts instead of re-rendering: you
  // could be halfway through setting Test Character 3's voice when another character arrives.
  await evaluate(
    cdp,
    `(() => {
        const pre = ${rowOf('Test Character 3')}.dataset.pre, el = $(pre+'Exag');
        el.value = '1.25'; el.dispatchEvent(new Event('input', {bubbles:true}));
    })()`,
  );
  ok(await evaluate(cdp, `$('stSave').disabled === false`), 'editing a row enables Save (the dirty check works at all)');
  await stRegister('Test Character 2');
  ok(await waitFor(cdp, `${rowOf('Test Character 2')}`), 'a character arrives mid-edit');
  ok(
    await evaluate(cdp, `$(${rowOf('Test Character 3')}.dataset.pre+'Exag').value === '1.25'`),
    '🔴 the in-progress edit is NOT clobbered by the arrival',
  );
  ok(
    await evaluate(cdp, `$('stSave').disabled === false`),
    '🔴 and the tab is STILL dirty afterward — the arrival did not swallow the edit',
  );

  // 🔴 A DELETED ROW STAYS DELETED. 🗑 removes the row and applies on Save, so a poll that
  // re-inserted every server-side name would undo the click a few seconds later.
  await evaluate(cdp, `${rowOf('Test Character 4')}.querySelector('.stDel').click()`);
  ok(await evaluate(cdp, `${rowOf('Test Character 4')} === null`), 'the 🗑 removes the row');
  await stRegister('Test Character 4'); // ST re-registers on every narration
  // 🔴 THE CLAIM IS AN ABSENCE, SO THE WAIT IS FOR THE POLLS THAT COULD HAVE BROKEN IT — COUNTED,
  // NOT TIMED. This was `sleep(POLL_MS * 1.5)`: "a tick has to elapse". On a loaded machine 1.5
  // intervals can contain no completed poll at all, and then "the row is not back" is true because
  // nothing had run, not because the poll behaved. (Before that it was a literal `sleep(6000)`.)
  // The page's fetch log records each `/st/characters` GET as its response arrives, which is
  // BEFORE the poll's own code has acted on it. A poll whose request started after the register
  // returned is the second response from here; the third arriving proves the page has finished
  // with the second. By then the server has held "Test Character 4" for two full polls and the
  // page was shown it twice.
  const pollsBefore = await evaluate(cdp, fetchCount('/st/characters', 'GET'));
  const polledEnough = await waitFor(cdp, fetchCountAtLeast('/st/characters', pollsBefore + 3, 'GET'), POLL_MS * 6);
  if (!polledEnough)
    console.error(
      `  (the poll answered ${(await evaluate(cdp, fetchCount('/st/characters', 'GET'))) - pollsBefore} time(s) in ${POLL_MS * 6} ms; 3 were needed)`,
    );
  ok(
    polledEnough && (await evaluate(cdp, `${rowOf('Test Character 4')} === null`)),
    '🔴 a row deleted pending Save is NOT resurrected by the poll',
  );

  // ↺ Reset re-renders the last loaded state — the characters that popped in have to be
  // part of it, or Reset silently drops them until the next tick puts them back.
  await evaluate(cdp, `$('stReset').click()`);
  const afterReset = await evaluate(cdp, rowNames);
  ok(
    JSON.stringify(afterReset) === JSON.stringify(['Test Character 1', 'Test Character 2', 'Test Character 3', 'Test Character 4']),
    `↺ Reset keeps the characters that arrived live (got ${JSON.stringify(afterReset)})`,
  );
  ok(await evaluate(cdp, `$('stSave').disabled === true`), 'and Reset leaves the tab clean');

  // The poll is scoped to the panel that needs it: leaving stops it, so a tab left on
  // Kobold or Playground is not quietly hitting /st/characters every 4 seconds forever.
  await evaluate(cdp, `switchStTab('logs')`);
  ok(await evaluate(cdp, `!stPollRunning()`), 'the Logs sub-tab stops the poll');
  // Coming back re-loads the tab first, so the poll restarts only once that GET lands —
  // deliberately, so a switch away mid-load cannot leave a poll running behind you.
  await evaluate(cdp, `switchStTab('characters')`);
  ok(await waitFor(cdp, `stPollRunning()`, 5000), 'coming back restarts it');
  await evaluate(cdp, `switchTab('playground')`);
  ok(await evaluate(cdp, `!stPollRunning()`), 'leaving the SillyTavern tab stops it too');

  // 🔴 THE RACE. loadStChars() awaits a GET before starting the poll, so leaving DURING that
  // GET would otherwise start a poll after the switch handler already stopped it — and
  // nothing would ever stop it again. Fire the load and leave without awaiting it.
  await evaluate(cdp, `switchTab('sillytavern')`);
  await evaluate(cdp, `switchStTab('characters')`);
  await waitFor(cdp, `stPollRunning()`, 5000);
  await evaluate(cdp, `(() => { loadStChars(); switchStTab('logs'); })()`, { awaitPromise: false });
  await waitFor(cdp, `!stPollRunning()`, 8000); // the poll ENDING is observable; do not time it
  ok(await evaluate(cdp, `!stPollRunning()`), '🔴 leaving mid-load does not strand a poll behind you');

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} FAILED` : '\nall browser assertions passed');
} catch (err) {
  console.error(`  FAIL ${err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

// Vocalis 9.3 — the KoboldCpp ticked-cards warning, in a REAL browser, against a REAL server.
//
// Browser coverage for the warning shown when KoboldCpp needs the selected CUDA devices
// to be free. The test verifies the route status, click handler, and modal join together.
// WHY, when test_kobold_routes.py already asserts the payload and kobold_ui_smoke.mjs already runs
// `kobGpuWarnHtml` under `vm`: neither can see the JOIN. The route sends `vocalis_gpus` on the
// status poll; the click handler reads `kob.status`; the dialog is a `modal()` three files away.
// Every one of those can be right on its own while the button loads a model with both cards still
// held — a route field nothing reads, a poll that has not landed, a modal whose Cancel resolves
// truthy. That gap is the 2026-07-24 lesson (a markup test AND a Flask test-client test both green
// while the player was visibly dead), and it is where this feature's failure would live.
//
// 🔴 AND IT DRIVES THE FULL RECOVERY LOOP, not just the dialog: warn -> go to Devices ->
// untick the cards -> come back -> Load, with no warning, and the POST actually happens. The last
// half is the part that makes the warning worth having; a warning you cannot get past by doing the
// right thing is one you learn to click through.
//
// ⚠️ THE SECOND HALF OF EVERY CLAIM IS ASSERTED IN PYTHON, not here: `fake.loaded` on the server
// side says whether a load was really posted to KoboldCpp. A DOM check alone is satisfied by an
// optimistic render, and the disagreement between the two layers is what localizes a fault.
//
// No npm dependencies — Node ships WebSocket and fetch, Chrome speaks CDP. CDP plumbing mirrors
// power_line_browser_spec.mjs / devices_browser_spec.mjs.
//
// Usage: node kobold_warn_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { watch, saw, NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node kobold_warn_browser_spec.mjs <base-url> <chrome-path>');
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

// 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED", and `Promise.resolve(...)` rather than
// `!!(expr)` — both of those are the fixes power_line_browser_spec.mjs documents at length. A wait
// whose expression can throw is a RACE, not a wait, and it presents as a flake.
// The deadline (default and the explicit ones below) is only a bound on a HANG: a passing run never
// waits it out, and a deadline of 8 to 20 s is too short when dozens of these specs run at once.
async function waitFor(cdp, expression, timeoutMs = 60000) {
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

// The modal's buttons carry no ids — they are built from the `actions` array — so they are found
// by their LABEL, which is also the thing a user reads. A renamed button fails here, loudly, which
// is correct: the label is the contract.
const clickModalButton = (cdp, label) =>
  evaluate(
    cdp,
    `(() => {
        const b = [...document.querySelectorAll('#mActs button')].find(x => x.textContent.includes(${JSON.stringify(label)}));
        if (!b) return false;
        b.click();
        return true;
    })()`,
  );

// How many times the content of element `id` has been rewritten so far (local helper; the first call
// starts the count). A poll that repaints its panel from a response is observable this way: the
// count rises AFTER the page has stored what the response said, which a logged response is not.
const paintCount = id => `(() => {
    const W = (window.__paints = window.__paints || {}), id = ${JSON.stringify(id)};
    if (!(id in W)) {
        W[id] = 0;
        new MutationObserver(m => { W[id] += m.length; })
            .observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
    }
    return W[id];
})()`;

// Docker edition: unticking a card that is running ACE-Step first opens "Stop ACE-Step on these cards?"
// (saveDevices in sys/devices.js), and NOTHING is saved until it is answered. Cancel puts the box back.
// This waits for that dialog by title and answers Save and stop, so the untick the spec is making
// actually reaches the server. It returns false if the dialog never appeared.
const confirmStopAce = async cdp =>
  (await waitFor(
    cdp,
    `document.getElementById('overlay').classList.contains('on') && /Stop ACE-Step/.test(document.getElementById('mTitle').textContent)`,
    60000,
  )) && (await clickModalButton(cdp, 'Save and stop'));

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-kobwarn-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Mute browser audio so the test never uses the host's output devices.
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
  // 🔴 WAIT FOR CHROME TO ACTUALLY GO BEFORE DELETING ITS PROFILE — kill() returns at once and
  // Windows keeps the handles a moment longer.
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
  // 🔴 BOTH FLAGS, then PUBLISH. `readyState === 'complete'` is not enough on its own: index.html
  // loads a BUNDLE and publishes nothing on `window`, so `switchTab` below would be a
  // ReferenceError — which reads as a broken tab bar rather than as a missing wait. `__uiReady`
  // means the modules ran, `__bootDone` means the boot fetches settled, and PUBLISH_SPEC_SURFACE
  // is what makes the page's own module instances reachable by name. See tests/_websrc.mjs.
  ok(
    await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`, 45000),
    'the page loads and finishes booting',
  );
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);

  // ── the tab comes up against the stub KoboldCpp ────────────────────────
  // 9.5-m1: KoboldCpp is `LLM > KoboldCpp` now, not a top-level tab. TWO calls, and the
  // second is not optional -- `switchTab('llm')` opens whichever sub-tab was last saved,
  // which on a fresh profile is llama.cpp (left-most wins). Without the sub-tab call this
  // spec would wait on a #kobMain that is correctly hidden.
  await evaluate(cdp, `switchTab('llm')`);
  await evaluate(cdp, `switchLlmTab('kobold')`);
  ok(
    await waitFor(cdp, `document.getElementById('kobMain').style.display !== 'none'`),
    'the KoboldCpp tab finds the server and shows the Model panel',
  );
  ok(
    await waitFor(cdp, `document.getElementById('kobSel').options.length > 0 && !document.getElementById('kobLoad').disabled`),
    'a config is listed and Load is live',
  );
  // 🔴 THE POLL HAS TO HAVE LANDED, or the click below would be testing "no status yet" — which
  // is silent by design and would pass this whole file for the wrong reason.
  ok(
    await waitFor(cdp, `/No model loaded|Loaded/.test(document.getElementById('kobStatus').innerText)`),
    'and the status poll has landed, so the tab knows what the cards are doing',
  );

  // ── 1. Load asks first, and NAMES the cards ────────────────────────────
  await evaluate(cdp, `document.getElementById('kobLoad').click()`);
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`), 'clicking Load opens a dialog rather than loading');
  const title = await evaluate(cdp, `document.getElementById('mTitle').textContent`);
  ok(/cards ticked/i.test(title), `the dialog is about the ticked cards (got ${JSON.stringify(title)})`);
  const body = await evaluate(cdp, `document.getElementById('mBody').innerText.replace(/\\s+/g, ' ')`);
  ok(/cuda:0/.test(body) && /cuda:1/.test(body), 'it names both card ids — the rows to go and untick');
  ok(/Test Card A/.test(body) && /Test Card B/.test(body), 'and their labels, so you know which card it is');
  ok(/Devices/.test(body), 'and says where to untick them');
  ok(/2 cards/.test(body), 'and counts them');

  // ── 2. Cancel means cancel — including from the keyboard ───────────────
  // 🔴 `modal()` resolves `actions[0].value` on Esc and on the backdrop, so an actions array with
  // the confirm first makes Esc the DESTRUCTIVE answer. That is exactly the defect this milestone
  // fixed one function away, in `kobConfirmDrop`. Assert it here on the real dialog.
  //
  // "IT DID NOT LOAD" IS A `watch` INSTALLED BEFORE THE KEY, NOT A LOOK 600 ms LATER. A fall-through
  // would set the status line to "Loading…" in the click handler's own continuation, which runs as
  // soon as the dialog's promise resolves, before the next painted frame; so the signal that the
  // handler has had its turn is the overlay closing plus one painted frame, and the watch has seen
  // every DOM change in between. (This was `sleep(600)` and one look: a duration standing in for
  // "the handler has run", with no way to know it had.)
  await evaluate(cdp, watch('kobLoading', `/Loading/i.test(document.getElementById('kobStatus').innerText)`));
  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
  ok(await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`), 'Esc closes the dialog');
  await evaluate(cdp, NEXT_FRAME);
  const afterEsc = await evaluate(cdp, `document.getElementById('kobStatus').innerText`);
  ok(!/Loading/i.test(afterEsc) && !(await evaluate(cdp, saw('kobLoading'))), '🔴 and Esc CANCELS — it does not fall through to the load');

  // ── 3. the dialog can take you to the panel it is talking about ────────
  await evaluate(cdp, `document.getElementById('kobLoad').click()`);
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`), 'Load asks again — the warning is not one-shot');
  ok(await clickModalButton(cdp, 'Devices'), 'the dialog offers to open the Devices panel');
  ok(
    await waitFor(
      cdp,
      `!document.getElementById('overlay').classList.contains('on') && document.getElementById('devList').getBoundingClientRect().width > 0`,
    ),
    'and it closes the dialog and lands on ⚙ Settings ▸ Devices, laid out and reachable',
  );

  // ── 4. untick the cards — the fix the warning is asking for ────────────
  ok(await waitFor(cdp, `document.querySelectorAll('#devList .devchk').length === 2`), 'both cards are listed there');
  await evaluate(
    cdp,
    `(() => {
        for (const b of document.querySelectorAll('#devList .devchk')) {
          if (b.checked) { b.checked = false; b.dispatchEvent(new Event('change', {bubbles: true})); }
        }
    })()`,
  );
  // Docker edition: both cards run ACE-Step, so the save asks "Stop ACE-Step on these cards?" first.
  // (Two change events fire in a row; the second dialog replaces the first and covers both cards.)
  ok(await confirmStopAce(cdp), 'unticking cards that run ACE-Step asks before stopping it, and Save and stop saves');
  // Asked of the SERVER, not of the checkbox that was just clicked: the claim is that the save
  // landed, and a box reads unticked the instant it is clicked whether anything was saved or not.
  ok(
    await waitFor(cdp, `fetch('/devices').then(r => r.json()).then(d => d.devices.every(x => !x.enabled))`),
    'unticking them reaches the server',
  );

  // ⚠️ AND UNTICKING EVERYTHING RAISES VOCALIS'S OWN DIALOG — "Rendering on the CPU now", the
  // standing warning from the 2026-07-28 incident. It is not this feature's, but it IS on screen,
  // and a spec that walked past it would be asserting "no dialog" below against a page that had
  // one open the whole time. Dismiss it deliberately, and assert it appeared: unticking every card
  // is the recovery action described by this warning, so the two dialogs meet here by construction.
  ok(
    await waitFor(cdp, `document.getElementById('mTitle').textContent.includes('CPU')`),
    'and Vocalis says out loud that renders now fall back to the CPU',
  );
  ok(await clickModalButton(cdp, 'OK'), 'that dialog is dismissable');
  ok(await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`), 'and it closes');

  // ── 5. back to Kobold: no warning, and the load actually posts ─────────
  const paintsBefore = await evaluate(cdp, paintCount('kobStatus'));
  await evaluate(cdp, `switchTab('llm')`);
  await evaluate(cdp, `switchLlmTab('kobold')`);
  ok(
    await waitFor(cdp, `fetch('/kobold/status').then(r => r.json()).then(s => (s.vocalis_gpus || []).length === 0)`),
    'the status poll now reports nothing ticked',
  );
  // ⚠️ The click reads `kob.status`, not the route — but re-entering the tab runs `kobLoadAll`,
  // which polls immediately, and the untick was saved before the switch. So the tab's own copy is
  // already the post-untick one once that poll's answer has been taken in. That is what this waits
  // for (it was `sleep(1500)`): `kobPoll` stores the status and THEN rewrites `#kobStatus`, so the
  // first rewrite after the switch means the tab holds the new status. Leaving Settings stopped the
  // old poll, so nothing else rewrites it in between. A hang here fails the check that follows.
  const repainted = await waitFor(cdp, `${paintCount('kobStatus')} > ${paintsBefore}`);
  if (!repainted) throw new Error('the KoboldCpp tab never repainted its status after the switch, so its copy of the status is unknown');
  // 🔴 "Loading…" IS A TRANSIENT, SO IT IS WATCHED FOR, NOT POLLED FOR. The stub KoboldCpp reports
  // the model loaded the instant the load is posted, so the status line reads "Loading…" only from
  // the click until the answer to the next status poll, a few tens of milliseconds, and a check that
  // looks every 100 ms can land entirely after it (seen once in 8 copies at once, 2026-10-12: the
  // click had worked and the line already read "Loaded"). The watch is installed before the click
  // and sees every DOM change, so the check is "it showed Loading at some point after the click".
  await evaluate(cdp, watch('kobLoadShown', `/Loading/.test(document.getElementById('kobStatus').innerText)`));
  await evaluate(cdp, `document.getElementById('kobLoad').click()`);
  ok(await waitFor(cdp, saw('kobLoadShown')), '🔴 with the cards free, Load just loads — no dialog in the way');
  // ⚠️ NAME THE DIALOG IF THERE IS ONE. "a dialog is open" could be the ticked-cards warning that
  // should not have fired, or a `Could not load` error from the POST — opposite faults with the
  // same symptom, and a bare boolean cannot tell them apart.
  const stray = await evaluate(
    cdp,
    `document.getElementById('overlay').classList.contains('on') ? document.getElementById('mTitle').textContent + ' :: ' + document.getElementById('mBody').innerText.replace(/\\s+/g, ' ').slice(0, 300) : ''`,
  );
  ok(stray === '', `and no dialog was opened (got ${JSON.stringify(stray)})`);

  ok(pageErrors.length === 0, `the page threw nothing: ${pageErrors.join(' | ') || 'clean'}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`  FAIL harness: ${err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

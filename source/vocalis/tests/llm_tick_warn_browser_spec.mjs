// Vocalis 9.5-m3 — "warn me if I enable a device while an LLM model is loaded", in a REAL browser.
//
// Browser coverage for warning users before enabling a device while an LLM model is loaded.
// The check applies to the shared device-enable action rather than individual tabs.
// WHY A BROWSER, when test_llm_holding.py already asserts the route: the route is one end of a
// JOIN and every interesting failure lives in the other end. The setting is painted by
// `loadAppSettings`, the probe is fired from a DELEGATED change handler, the dialog is a `modal()`
// in a third file, and the save is `saveDevices()` in a fourth. Each can be perfectly correct
// while the checkbox saves before the dialog is answered, or Cancel leaves the card ticked, or the
// handler never fires because the rows were re-rendered under it.
//
// 🔴 THE ORDER IS THE FEATURE. A warning that appears AFTER the save is not a warning, it is a
// notification — and the Python side proves the ordering by asserting that a Cancel posted
// NOTHING, which the DOM alone cannot see.
//
// Usage: node llm_tick_warn_browser_spec.mjs <base-url> <chrome-path> [screenshot-path]
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { watch, saw, NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath, shotPath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node llm_tick_warn_browser_spec.mjs <base-url> <chrome-path> [screenshot-path]');
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

// ── CDP plumbing (mirrors kobold_warn_browser_spec.mjs) ──────────────────────
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

// 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED", and `Promise.resolve(...)` rather than
// `!!(expr)`. A wait whose expression can throw is a RACE, not a wait, and it presents as a flake.
// The default deadline is 60 s, not 20: it only bounds a HANG, and a passing run never waits it out.
// With 40+ copies of this spec at once, a save that is merely slow took longer than 20 s.
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

// Docker edition: unticking a card that is running ACE-Step first opens "Stop ACE-Step on these cards?"
// (saveDevices in sys/devices.js) and nothing is saved until it is answered; Cancel puts the box back.
// Waits for that dialog by title and answers Save and stop; false if it never appeared.
// (8 s before 2026-10-12; raised for the same reason as the waitFor default above.)
const confirmStopAce = async cdp => {
  const shown = await waitFor(
    cdp,
    `document.getElementById('overlay').classList.contains('on') && /Stop ACE-Step/.test(document.getElementById('mTitle').textContent)`,
    60000,
  );
  if (!shown) {
    console.log('  (the "Stop ACE-Step" dialog never appeared)');
    await describePage(cdp);
    return false;
  }
  return clickModalButton(cdp, 'Save and stop');
};

// Click the FIRST device checkbox that is currently off. `.click()` and not `.checked = true`:
// assigning the property fires no `change`, so the delegated handler under test would never run
// and the spec would be asserting a page nobody had interacted with.
//
// 🔴 ONLY WHEN THE PAGE HAS NOTHING ABOUT ITS DEVICES OR SETTINGS IN FLIGHT. `loadDevices` repaints
// the whole list, and replaces every checkbox, from whatever its GET was answered with; a tick made
// while such a GET is out can be repainted away. (The 10 s poll that causes the worst case is
// stopped below; the first load, started by `switchTab`, is the one this waits for.)
const tickFirstOff = async cdp => {
  await pageQuiet(cdp, 'before ticking a card');
  return evaluate(
    cdp,
    `(() => {
        const c = [...document.querySelectorAll('#devList .dev .devchk')].find(x => !x.checked);
        if (!c) return null;
        const id = c.closest('.dev').dataset.id;
        c.click();
        return id;
    })()`,
  );
};

// Is the dialog on screen OUR dialog? Title-matched, because other modals legitimately open in
// this panel (the CPU-fallback notice) and "the overlay is closed" is a different, weaker claim.
// As a page expression so `watch` can run it on every DOM change.
const LLM_DIALOG_OPEN = `document.getElementById('overlay').classList.contains('on') &&
    /LLM is holding/i.test(document.getElementById('mTitle').textContent)`;

// Clear whatever modal is up, whichever it is, so the next step starts from a known page.
const dismissAnyModal = async cdp => {
  if (!(await evaluate(cdp, `document.getElementById('overlay').classList.contains('on')`))) return;
  await evaluate(cdp, `(() => { const b = document.querySelector('#mActs button'); if (b) b.click(); })()`);
  await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`);
};

const chkState = cdp =>
  evaluate(
    cdp,
    `[...document.querySelectorAll('#devList .dev')].map(d => ({
        id: d.dataset.id, on: d.querySelector('.devchk').checked }))`,
  );

// Every `fetch` the page makes, with when it STARTED and when it was answered (`end: null` = still
// in flight). Local, because `_specwait.mjs`'s log records a request only when its response
// arrives, so it cannot say "nothing is in flight" and cannot say which save came after which.
// The waits below are built on it, and `describePage` prints it when one gives up.
const INSTALL_TRACE = `(() => {
    if (window.__trace) return true;
    const trace = (window.__trace = []), real = window.fetch;
    window.fetch = function (...a) {
        const req = a[0], init = a[1] || {};
        const e = {
            url: String(req && req.url ? req.url : req),
            method: String(init.method || (req && req.method) || 'GET').toUpperCase(),
            start: Math.round(performance.now()), status: null, end: null,
        };
        trace.push(e);
        const p = real.apply(this, a);
        p.then(r => { e.status = r.status; e.end = Math.round(performance.now()); },
               () => { e.status = 0; e.end = Math.round(performance.now()); });
        return p;
    };
    return true;
})()`;

// What the page looked like when a wait gave up: the dialog (title and body), the warning box,
// the settings the SERVER holds, and the last requests with their status and how long they took
// (end: null means still in flight).
const describePage = async cdp => {
  try {
    const d = await evaluate(
      cdp,
      `(async () => {
          const ov = document.getElementById('overlay');
          const srv = await fetch('/settings/app', { cache: 'no-store' }).then(r => r.json()).catch(e => ({ error: String(e) }));
          const dev = await fetch('/devices', { cache: 'no-store' }).then(r => r.json()).catch(e => ({ error: String(e) }));
          return {
              serverDevices: (dev.devices || []).map(d => d.id + '=' + d.enabled),
              now: Math.round(performance.now()),
              dialogOpen: ov.classList.contains('on'),
              dialogTitle: document.getElementById('mTitle').textContent,
              dialogBody: (document.getElementById('mBody').innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
              warnBoxChecked: document.getElementById('devWarnLlm').checked,
              deviceBoxes: [...document.querySelectorAll('#devList .dev')].map(d => d.dataset.id + '=' + d.querySelector('.devchk').checked),
              serverWarnLlm: srv.devices_warn_llm_loaded,
              lastRequests: (window.__trace || []).filter(e => !['comfyui/status', 'acestep/status', '/health'].some(p => e.url.includes(p))).slice(-22).map(e => e.method + ' ' + e.url + ' -> ' + e.status + ' @' + e.start + '..' + e.end),
          };
      })()`,
    );
    console.log(`  (page state: ${JSON.stringify(d)})`);
  } catch (err) {
    console.log(`  (could not read the page state: ${err && err.message ? err.message : err})`);
  }
};

// ── waiting for a save to be FINISHED, not for time to pass ─────────────────────────────────
// 🔴 WHY THESE EXIST (2026-10-12, 40 copies of this spec at once, 5 failures: "re-ticking the warning
// saves too" red, or every check green and then `devices_warn_llm_loaded` False in the file when
// the Python half read it; at 12 and 24 copies nothing failed). The spec walked on after
// `sleep(600)` with the previous step's `PUT /devices` still in flight. That route
// (`devices_route` in web/ui.py) reads app_settings.yaml, changes `devices`, and writes the WHOLE
// file back without the `settings.APP_LOCK` that `PUT /settings/app` takes for this exact reason. So
// a settings save that lands between its read and its write would be overwritten with the old
// value: a lost update, which is the reading that fits "server said True, file ended False". It was
// not seen directly (no request trace of that run). Waiting for each save to be answered before the
// next action keeps the spec off that race either way. The race is in the product and is reported.

// Nothing is in flight that could still repaint the Devices panel or change the warning setting.
const PAGE_QUIET = `!window.__trace.some(e => e.end === null &&
    ['/devices', '/enhance/info', '/settings/app', '/llm/holding'].some(p => e.url.includes(p)))`;

const pageQuiet = async (cdp, when) => {
  if (await waitFor(cdp, PAGE_QUIET)) return;
  console.log(`  (the page still had a request in flight ${when})`);
  await describePage(cdp);
  throw new Error(`requests about devices or settings never finished ${when}`);
};

const traceMark = cdp => evaluate(cdp, `window.__trace.length`);

// The first request after `mark` that matches, as a page expression.
const firstSince = (mark, method, part) =>
  `window.__trace.slice(${mark}).find(e => e.method === ${JSON.stringify(method)} && e.url.includes(${JSON.stringify(part)}))`;

// `saveDevices` is finished when its PUT was answered, `loadEnhanceInfo` (which it awaits next)
// was answered after it, and nothing else about the panel is in flight. A PUT that failed ends it
// at once (nothing more is coming; the caller reads the status).
const deviceSaveDone = mark => `(() => {
    const t = window.__trace.slice(${mark});
    const i = t.findIndex(e => e.method === 'PUT' && e.url.includes('/devices'));
    if (i < 0 || t[i].end === null) return false;
    if (t[i].status !== 200) return true;
    return t.slice(i + 1).some(e => e.url.includes('/enhance/info') && e.end !== null) && ${PAGE_QUIET};
})()`;

// True once the save started after `mark` has been answered 200 and the page has run on from it.
const awaitDeviceSave = async (cdp, mark, what) => {
  const done = await waitFor(cdp, deviceSaveDone(mark));
  const status = done ? await evaluate(cdp, `(${firstSince(mark, 'PUT', '/devices')} || {}).status`) : null;
  // The response is logged before the page's own code sees it; one painted frame later it has.
  if (done && status === 200) return evaluate(cdp, NEXT_FRAME);
  console.log(`  (${what}: the device save did not finish cleanly; done=${done}, PUT /devices answered ${status})`);
  await describePage(cdp);
  return false;
};

// True once the `PUT /settings/app` started after `mark` was answered, nothing else is in flight,
// and the SERVER reads back `want`. All three: the answer alone does not say it was accepted, and
// the read-back alone could be the value from before the click.
const awaitWarnSave = async (cdp, mark, want, what) => {
  const done = await waitFor(
    cdp,
    `(() => { const e = ${firstSince(mark, 'PUT', '/settings/app')}; return !!e && e.end !== null && ${PAGE_QUIET}; })() &&
     fetch('/settings/app', { cache: 'no-store' }).then(r => r.json()).then(j => j.devices_warn_llm_loaded === ${want})`,
  );
  if (done) return true;
  console.log(`  (${what}: the warning setting never read back as ${want})`);
  await describePage(cdp);
  return false;
};

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-llmtick-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // 🔴 MUTE — Browser audio must remain muted.
    '--mute-audio',
    '--ignore-certificate-errors',
    '--window-size=1400,1100',
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
  ok(
    await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`, 45000),
    'the page loads and finishes booting',
  );
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  await evaluate(cdp, INSTALL_TRACE);
  await evaluate(cdp, `switchTab('settings')`);
  ok(await waitFor(cdp, `document.querySelectorAll('#devList .dev').length > 0`), 'the Devices panel lists cards');
  // 🔴 THE 10 s DEVICE POLL IS STOPPED, because its answer can repaint the list over a save that is
  // still in flight. Measured 2026-10-12, 56 copies at once, request trace of a failing run:
  //   PUT /devices @15125..19034    (the "Stop ACE-Step" save, answered after 3.9 s)
  //   GET /devices @15886..15905    (the poll, 10.0 s after the panel opened: 5883 + 10000)
  // The GET was served from the file the PUT had not yet written, so the page repainted card cuda:0
  // as TICKED while the server then held it unticked; the next step found no unticked card to
  // enable. The spec is about the warning, not about that poll, and the poll's moment is not
  // something the spec controls, so it is switched off (`devPollStop`, the page's own call, the one
  // `switchTab` makes when you leave Settings). The race is a product defect and is reported.
  await evaluate(
    cdp,
    `(() => { if (typeof devPollStop !== 'function') throw new Error('devPollStop is not published, so the device poll cannot be stopped'); devPollStop(); return true; })()`,
  );

  // ── 1. the control is in the notification settings and is ON ────────────
  ok((await evaluate(cdp, `document.getElementById('devWarnLlm') !== null`)) === true, 'the warning checkbox exists');
  ok(
    (await evaluate(cdp, `document.getElementById('devWarnLlm').checked`)) === true,
    'and it is ON by default — the box is how you turn the warning OFF, not on',
  );
  // 🔴 UNDER THE DEVICE LIST, which is where he said to put it. A setting about the thing you
  // are looking at, next to the thing you are looking at.
  const placed = await evaluate(
    cdp,
    `(() => {
        const list = document.getElementById('devList'), box = document.getElementById('devWarnLlm');
        return !!(list.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING)
            && list.closest('.panel') === box.closest('.panel');
    })()`,
  );
  ok(placed === true, 'and it sits below the device list, inside the same Devices panel');

  // ── 2. ticking a card while a model is loaded ASKS FIRST ───────────────
  const id = await tickFirstOff(cdp);
  ok(!!id, `there is a card to enable (${id})`);
  ok(
    await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`),
    'ticking it opens a dialog rather than just saving',
  );
  const body = await evaluate(cdp, `document.getElementById('mBody').innerText.replace(/\\s+/g, ' ')`);
  ok(/llama\.cpp/.test(body), 'the dialog names the ENGINE that is holding the cards');
  ok(/big-70b/.test(body), 'and the model, which is the thing you would go and unload');
  ok(new RegExp(id.replace(':', ':')).test(body), 'and the card being enabled, so it is clear which tick this is about');

  // ── LOOK AT IT, HERE AND NOT AT THE END ───────────────────────────────
  // 🔴 `modal()` REUSES ONE OVERLAY, so a second dialog opening overwrites the first in place
  // and a screenshot taken later shows whichever spoke last. Captured at the end, this picture
  // twice came back as `saveDevices`'s CPU-fallback notice — while the spec reported success,
  // because the title HAD matched at the moment of the wait. Here, nothing has been saved yet, so
  // no other modal can exist and the image cannot be of anything else.
  if (shotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    const still = await evaluate(cdp, `document.getElementById('mTitle').textContent`);
    ok(/LLM is holding/i.test(still), `and the screenshot is of THIS dialog (title at capture: ${JSON.stringify(still)})`);
    console.log(`  (screenshot written to ${shotPath})`);
  }

  // ── 3. Cancel means cancel, and the tick goes BACK ─────────────────────
  ok(await clickModalButton(cdp, 'Cancel'), 'the dialog offers Cancel');
  ok(await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`), 'and Cancel closes it');
  // The handler puts the box back AFTER the dialog's promise resolves, which is a moment after the
  // overlay closes; wait for that (a miss falls through to the check below, which then fails).
  await waitFor(cdp, `document.querySelector('#devList .dev[data-id=${JSON.stringify(id)}] .devchk').checked === false`);
  const afterCancel = await chkState(cdp);
  // THE CARD THAT WAS CLICKED, not "all of them": the fixture deliberately leaves a second card
  // enabled so that unticking later does not empty the list and trip the CPU-fallback modal.
  ok(
    afterCancel.some(d => d.id === id && d.on === false),
    `🔴 the card is UNTICKED again after Cancel — the checkbox must not keep a state the save never took (${JSON.stringify(afterCancel)})`,
  );

  // ── 4. Enable anyway goes through ──────────────────────────────────────
  const mark4 = await traceMark(cdp);
  const id2 = await tickFirstOff(cdp);
  ok(id2 === id, 'the same card can be ticked again after a Cancel');
  ok(
    await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`),
    'and it asks again — a Cancel is not a permanent answer',
  );
  ok(await clickModalButton(cdp, 'Enable anyway'), 'the dialog offers Enable anyway');
  // THE CARD THAT WAS TICKED, here and on the server. These two checks used to ask for "any card
  // enabled", which the fixture's second card (on from the start) satisfies before anything is
  // saved - so they could not fail when the enable did not land.
  const idSel = `#devList .dev[data-id=${JSON.stringify(id)}] .devchk`;
  ok(await waitFor(cdp, `document.querySelector(${JSON.stringify(idSel)}).checked === true`), 'and the card ends up enabled');
  // The SERVER is the one that has to agree; the Python half re-reads /devices for the same fact.
  ok(
    await waitFor(
      cdp,
      `fetch('/devices', { cache: 'no-store' }).then(r => r.json()).then(j => (j.devices || []).some(d => d.id === ${JSON.stringify(id)} && d.enabled))`,
    ),
    'and the enable actually reached the server',
  );
  // The next step starts only when this save is over: the page is still awaiting `/enhance/info`
  // after it, and a second device save begun now overlaps this one (see the note on the waits).
  if (!(await awaitDeviceSave(cdp, mark4, 'Enable anyway'))) throw new Error('the Enable anyway save never finished cleanly');

  // ── 5. UNTICKING never asks — that is how you GIVE the memory back ─────
  // The card just enabled, NOT merely "one that is checked" — the fixture's second card is on
  // too, and unticking that one instead would leave the list non-empty for a different reason.
  //
  // 🔴 THE "NEVER SHOWS THE WARNING" CLAIM IS A `watch` INSTALLED BEFORE THE CLICK, PLUS A POSITIVE
  // SIGNAL THAT THE SAVE RAN TO ITS END. It was `sleep(600)` and one look at the overlay: under load
  // the save (and any dialog it opens) arrives after 600 ms, so the look found nothing yet, and the
  // next step then started with this save still in flight.
  await evaluate(cdp, watch('untick', LLM_DIALOG_OPEN));
  const mark5 = await traceMark(cdp);
  await pageQuiet(cdp, 'before unticking the card');
  await evaluate(cdp, `document.querySelector(${JSON.stringify(idSel)}).click()`);
  // Docker edition: this card runs ACE-Step, so the untick is held behind "Stop ACE-Step on these
  // cards?". Answer it, or the untick never saves and the card stays on for the steps below.
  ok(await confirmStopAce(cdp), 'unticking a card that runs ACE-Step asks before stopping it, and Save and stop saves the untick');
  const unticked = await awaitDeviceSave(cdp, mark5, 'unticking a card');
  // 🔴 ASSERTED ON THE DIALOG'S TITLE, NOT ON THE OVERLAY. Another modal can legitimately be
  // open at this instant: unticking the last ticked card pops `saveDevices`'s CPU-fallback
  // notice, and other modals in this panel are not this feature's business. "The overlay is closed"
  // therefore passes or fails for reasons unrelated to what is under test - measured: it passed
  // by luck on the first green run, against the CPU notice rather than against anything here.
  // The claim that matters is narrower and exact: unticking never shows THIS warning.
  ok(
    unticked && !(await evaluate(cdp, saw('untick'))),
    'unticking a card never shows the LLM warning — it is the safe direction, and blocking it once broke the only way to free a satellite',
  );
  await dismissAnyModal(cdp);

  // —— 6. with the warning OFF, the tick is silent ——————————
  const mark6 = await traceMark(cdp);
  await evaluate(cdp, `document.getElementById('devWarnLlm').click()`);
  ok(await awaitWarnSave(cdp, mark6, false, 'unticking the warning'), 'unticking the warning saves to the server');
  await evaluate(cdp, watch('tickWarnOff', LLM_DIALOG_OPEN));
  const mark6b = await traceMark(cdp);
  const id3 = await tickFirstOff(cdp);
  if (!id3) await describePage(cdp);
  ok(!!id3, 'there is still a card to enable with the warning off');
  // With the warning off `okToEnable` returns without asking anything, so a dialog could only have
  // opened before the save started; the finished save is the signal that the tick ran through.
  const enabledOff = id3 ? await awaitDeviceSave(cdp, mark6b, 'enabling a card with the warning off') : false;
  ok(enabledOff && !(await evaluate(cdp, saw('tickWarnOff'))), 'and with it off, enabling a device asks nothing at all');
  ok(
    !!id3 &&
      (await waitFor(
        cdp,
        `document.querySelector(${JSON.stringify(`#devList .dev[data-id=${JSON.stringify(id3)}] .devchk`)}).checked === true`,
      )),
    'the device is enabled directly',
  );
  await dismissAnyModal(cdp);

  // —— 7. LOOK AT THE THING ITSELF ——————————————
  // The picture is of the WARNING, not of the settings page with the warning turned off. A
  // screenshot that does not contain the feature proves the capture ran and nothing else.
  const mark7 = await traceMark(cdp);
  await evaluate(cdp, `document.getElementById('devWarnLlm').click()`); // back ON
  ok(await awaitWarnSave(cdp, mark7, true, 're-ticking the warning'), 're-ticking the warning saves too, so the setting is not one-way');
  await dismissAnyModal(cdp);

  ok(pageErrors.length === 0, `no uncaught page exceptions (${JSON.stringify(pageErrors.slice(0, 3))})`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`SPEC ERROR: ${err && err.stack ? err.stack : err}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

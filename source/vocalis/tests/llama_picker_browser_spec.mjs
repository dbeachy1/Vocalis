// Vocalis 9.5-m2c — the llama.cpp Model picker, in a REAL browser.
//
// Browser coverage for the compact llama.cpp model picker and its model detail display.
// The picker exposes the same relevant model information as Kobold without rendering the
// full model list at once.
// WHY A BROWSER, when test_llama_routes.py already asserts every payload: none of those can see
// the JOIN. The drop-down is `paintPicker()`, the detail line is `renderDetail()`, the confirm is
// a `modal()` in a third file, and the poll rewrites the options every four seconds. Each can be
// right alone while the panel lists too many rows, resets the selection during polling, or offers
// Load for a model already resident. Browser coverage verifies the joined behavior and server
// state, which a markup-only test cannot observe.
//
// 🔴 AND IT LOOKS AT THE PAGE. The final step captures a screenshot so a human can inspect the
// rendered panel directly.
//
// ⚠️ THE SECOND HALF OF EVERY CLAIM IS ASSERTED IN PYTHON — `fake.loaded` / `fake.unloaded` say
// what actually reached llama-server. A DOM check alone is satisfied by an optimistic render, and
// the two layers disagreeing is what localizes the fault.
//
// CDP plumbing mirrors kobold_warn_browser_spec.mjs, which works; a hand-rolled one hung at 180 s.
//
// Usage: node llama_picker_browser_spec.mjs <base-url> <chrome-path> [screenshot-path]
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { INSTALL_FETCH_LOG, fetchCount, fetchCountAtLeast, NEXT_FRAME, TRANSITIONS_FINISHED } from './_specwait.mjs';

const [baseUrl, chromePath, shotPath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node llama_picker_browser_spec.mjs <base-url> <chrome-path> [screenshot-path]');
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
// `!!(expr)`. A wait whose expression can throw is a RACE, not a wait, and it presents as a flake.
// The deadline (default and any explicit one) only bounds a HANG; a passing run never waits it out.
// Explicit ones of 8 to 30 s were removed 2026-10-12: too short with dozens of these specs at once.
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
// by their LABEL, which is also the thing a user reads.
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

// Set the drop-down the way a human does. Assigning `.value` alone fires no `change`, so the
// repaint under test would never run and the spec would be asserting the PREVIOUS paint.
const pick = (cdp, id) =>
  evaluate(
    cdp,
    `(() => {
        const s = document.getElementById('llaSel');
        s.value = ${JSON.stringify(id)};
        s.dispatchEvent(new Event('change'));
        return s.value;
    })()`,
  );

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-llapick-cdp-'));
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
    '--window-size=1400,1000',
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
  // ReferenceError — which reads as a broken tab bar rather than as a missing wait.
  ok(
    await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`, 45000),
    'the page loads and finishes booting',
  );
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  await evaluate(cdp, INSTALL_FETCH_LOG);

  // ── the sub-tab comes up against the stub router ──────────────────────
  // TWO calls, and the second is not optional: `switchTab('llm')` opens whichever sub-tab was
  // last saved. Naming it here is what makes this spec independent of that default rather than
  // dependent on it.
  await evaluate(cdp, `switchTab('llm')`);
  await evaluate(cdp, `switchLlmTab('llama')`);
  ok(
    await waitFor(cdp, `document.getElementById('llaMain').style.display !== 'none'`),
    'the llama.cpp tab finds the router and shows the Model panel',
  );
  ok(
    await waitFor(cdp, `document.getElementById('llaSel').options.length === 10`),
    'every model the router offers is in the drop-down — all ten of them',
  );
  // 🔴 THE POLL HAS TO HAVE LANDED, or every check below is testing "no status yet", which is
  // silent by design and would pass this whole file for the wrong reason.
  ok(
    await waitFor(cdp, `/holding the cards|no model is holding/.test(document.getElementById('llaStatus').innerText)`),
    'and the status poll has landed, so the tab knows what the cards are doing',
  );

  // ── 0. A MODEL VOCALIS DID NOT LOAD IS STILL THE LAST MODEL LOADED ─────
  // Persisting only dropdown/Button loads misses models started externally. If one unloads or the
  // server restarts, the panel must retain the last loaded model instead of falling back to row one.
  //
  // `alpha-70b` is resident in this fixture from the first poll and nothing here has clicked
  // anything yet — which is exactly what "something else loaded it" looks like from the browser.
  ok(
    await waitFor(cdp, `fetch('/ui-state').then(r => r.json()).then(s => s['vocalis-lla-model'] === 'alpha-70b')`),
    'a model already on the cards is remembered with nobody having clicked anything',
  );

  // ── 1. the ninety-seven rows are GONE ──────────────────────────────────
  ok((await evaluate(cdp, `document.getElementById('llaModels') === null`)) === true, 'the per-model list is gone from the DOM entirely');
  // The drop-down still NAMES every model, so the assertion has to exclude it: what must not
  // appear is an unselected model's id anywhere ELSE on the panel.
  const outside = await evaluate(
    cdp,
    `[...document.querySelectorAll('#llaMain *')]
        .filter(el => el.tagName !== 'SELECT' && el.tagName !== 'OPTION' && !el.querySelector('select'))
        .map(el => el.textContent).join(' | ')`,
  );
  ok(!/gamma|delta|epsilon|zeta|eta|theta|iota|kappa/.test(outside), 'and no unselected model is named anywhere outside the drop-down');

  // ── 2. one detail line, KoboldCpp's shape and KoboldCpp's place ─────────
  ok((await evaluate(cdp, `document.getElementById('llaDetail') !== null`)) === true, 'there is a single detail line, #llaDetail');
  const detailCls = await evaluate(cdp, `document.getElementById('llaDetail').className`);
  ok(/small/.test(detailCls) && /muted/.test(detailCls), `it is small+muted like #kobDetail (got ${JSON.stringify(detailCls)})`);

  // ── 3. it describes the SELECTED model, and the selection starts on the loaded one ──
  ok(
    (await evaluate(cdp, `document.getElementById('llaSel').value`)) === 'alpha-70b',
    'the drop-down opens on the model that is holding the cards',
  );
  const alphaText = await evaluate(cdp, `document.getElementById('llaDetail').innerText.replace(/\\s+/g, ' ')`);
  ok(/loaded/.test(alphaText), `the detail line says the selected model is loaded (got ${JSON.stringify(alphaText)})`);
  ok(/ctx 8,192 of 131,072/.test(alphaText), 'and gives ctx AS LOADED against what it was trained for — the pair, never one of them');
  ok(
    /24\.0 B/.test(alphaText) && /15\.0 GB/.test(alphaText) && /IQ4_XS/.test(alphaText),
    'and params, size and quant — the same info the KoboldCpp tab shows',
  );

  // ── 4. Load is ABSENT for the model already in; Unload is offered ───────
  ok(
    (await evaluate(cdp, `getComputedStyle(document.getElementById('llaLoad')).display === 'none'`)) === true,
    'Load is not offered for the model that is already loaded',
  );
  ok(
    (await evaluate(cdp, `getComputedStyle(document.getElementById('llaUnload')).display !== 'none'`)) === true,
    'Unload is offered, because something is holding the cards',
  );

  // ── 5. changing the selection repaints AT ONCE, without waiting for the 4 s poll ──
  ok((await pick(cdp, 'bravo-8b')) === 'bravo-8b', 'the drop-down accepts a different model');
  const betaText = await evaluate(cdp, `document.getElementById('llaDetail').innerText.replace(/\\s+/g, ' ')`);
  ok(/sleeping/.test(betaText), `the detail line follows the selection immediately (got ${JSON.stringify(betaText)})`);
  ok(!/ctx 8,192/.test(betaText), "and does not leave the previous model's numbers behind");
  ok(
    (await evaluate(cdp, `getComputedStyle(document.getElementById('llaLoad')).display !== 'none'`)) === true,
    'Load comes back for a different model, because a swap is a real thing to want',
  );
  ok(
    (await evaluate(cdp, `document.getElementById('llaUnload').title.includes('alpha-70b')`)) === true,
    'and Unload still names ALPHA — it acts on what is HELD, not on what is selected',
  );

  // ── 6. the selection survives the 4 s poll ─────────────────────────────
  // 📌 The poll rewrites the options; it must not reset the user's current selection. Waited out
  // rather than mocked, because the timer is the behavior under test.
  //
  // 🔴 "A POLL GOES BY" IS COUNTED IN POLL RESPONSES, NOT IN SECONDS. This was `sleep(4600)` for a
  // 4000 ms interval: a poll that is late, or slow to answer, had not run by then and the check
  // passed having proven nothing. `pollOnce` asks `/llama/models` once per poll and repaints after
  // both answers; the fetch log records a response BEFORE the page paints from it, so the wait is
  // for TWO more responses: by the second, the poll behind the first has certainly repainted.
  const modelsBefore = await evaluate(cdp, fetchCount('/llama/models', 'GET'));
  const polled = await waitFor(cdp, fetchCountAtLeast('/llama/models', modelsBefore + 2, 'GET'));
  ok(
    polled && (await evaluate(cdp, `document.getElementById('llaSel').value`)) === 'bravo-8b',
    'a poll goes by and the drop-down still holds what he picked',
  );

  // ── 7. Unload asks first, and Cancel means cancel ──────────────────────
  await evaluate(cdp, `document.getElementById('llaUnload').click()`);
  ok(
    await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`),
    'clicking Unload opens a dialog rather than unloading',
  );
  const unloadBody = await evaluate(cdp, `document.getElementById('mBody').innerText.replace(/\\s+/g, ' ')`);
  ok(/alpha-70b/.test(unloadBody), 'the unload dialog names the model that is actually resident');
  ok(/that reply dies/.test(unloadBody), 'and says what it costs — anything mid-reply on it dies');
  ok(!/ticked/.test(unloadBody), 'and does NOT warn about the cards: giving memory back is the safe direction');
  ok(await clickModalButton(cdp, 'Cancel'), 'the dialog offers Cancel');
  ok(await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`), 'and Cancel closes it');

  // ── 8. Load asks first, warns about the cards, and then actually loads ──
  ok((await pick(cdp, 'model-c-24b')) === 'model-c-24b', 'a model that is not loaded at all can be picked');
  const modelCText = await evaluate(cdp, `document.getElementById('llaDetail').innerText.replace(/\\s+/g, ' ')`);
  ok(/not loaded/.test(modelCText), `and reads as not loaded (got ${JSON.stringify(modelCText)})`);
  await evaluate(cdp, `document.getElementById('llaLoad').click()`);
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`), 'clicking Load opens a dialog rather than loading');
  const loadBody = await evaluate(cdp, `document.getElementById('mBody').innerText.replace(/\\s+/g, ' ')`);
  ok(/model-c-24b/.test(loadBody), 'the load dialog names the model that was picked');
  ok(/cuda:0/.test(loadBody) && /cuda:1/.test(loadBody), 'and names the cards Vocalis is still holding, so they can be unticked');
  ok(await clickModalButton(cdp, 'Continue'), 'the dialog offers Continue');
  ok(
    await waitFor(cdp, `/model-c-24b/.test(document.getElementById('llaStatus').innerText)`),
    'and the load really reaches llama-server — the status line ends up naming it on the cards',
  );

  // ── 9. TWO models resident at once. `--models-max` defaults to 4. ────────────
  // 🔴 The first version of `paintPicker()` read `rows.find(m => m.holds_vram)` — ONE model —
  // so on any box not running `--models-max 1` it offered Load for a model that was already in,
  // and pointed Unload at a DIFFERENT resident model. A one-model configuration would not expose
  // this mismatch, so the fixture keeps two models resident.
  ok(
    await waitFor(cdp, `/alpha-70b/.test(document.getElementById('llaStatus').innerText)`),
    'the tab names BOTH resident models, not just the first',
  );
  ok(
    (await evaluate(cdp, `getComputedStyle(document.getElementById('llaLoad')).display === 'none'`)) === true,
    'Load is not offered for model-c-24b either, now that it is in',
  );
  ok(
    (await evaluate(cdp, `document.getElementById('llaUnload').title.includes('model-c-24b')`)) === true,
    'and Unload points at the resident model he is actually looking at',
  );
  ok((await pick(cdp, 'alpha-70b')) === 'alpha-70b', 'picking the other resident model');
  ok(
    (await evaluate(cdp, `document.getElementById('llaUnload').title.includes('alpha-70b')`)) === true,
    'moves Unload to that one — one rule, painted and clicked from the same function',
  );

  // ── 10. A LOAD IS REMEMBERED EVEN WHEN THE DROP-DOWN WAS NEVER TOUCHED ──────
  // 🔴 THE CASE THE `change` LISTENER CANNOT SEE. A fresh browser opens on whatever the fallback
  // chain picked; pressing Load on the row that was already showing fires no `change` event at
  // all, so a memory written only from `change` would miss a model loaded without changing the picker.
  // `pick()` above dispatches the event on purpose — this step deliberately does not.
  await evaluate(cdp, `document.getElementById('llaSel').value = 'model-p-3b'`);
  ok(
    await waitFor(cdp, `getComputedStyle(document.getElementById('llaLoad')).display !== 'none'`),
    'a poll repaints around a selection set without a change event, and offers Load for it',
  );
  await evaluate(cdp, `document.getElementById('llaLoad').click()`);
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`), 'Load asks first here too');
  const papaBody = await evaluate(cdp, `document.getElementById('mBody').innerText.replace(/\\s+/g, ' ')`);
  ok(/model-p-3b/.test(papaBody), `the dialog names the untouched selection (got ${JSON.stringify(papaBody.slice(0, 80))})`);
  ok(await clickModalButton(cdp, 'Continue'), 'and Continue goes ahead');
  // 🔴 THE SECOND LAYER, AND IT IS THE ONE THAT MATTERS FOR "the server restarts". The DOM can
  // hold a selection in memory and lose it on the next boot; only the account-local UI state on
  // the SERVER survives that, so this asks the server what it stored rather than asking the page.
  ok(
    await waitFor(cdp, `fetch('/ui-state').then(r => r.json()).then(s => s['vocalis-lla-model'] === 'model-p-3b')`),
    'and the load is written to the account-local UI state server-side, where a restart cannot lose it',
  );

  // ── 11. RELOAD THE PAGE. It opens on the model he loaded, not on row one. ────
  // The selected model must survive both page reloads and server restarts.
  // 🔴 `model-p-3b` IS NEITHER OF THE OLD ANSWERS, which is the whole point of choosing it: the first
  // row is `alpha-70b` and the models holding the cards are `alpha-70b` and `model-c-24b`. A spec
  // that reloaded onto a model which was also resident would pass on the OLD code.
  await cdp.send('Page.navigate', { url: baseUrl });
  ok(
    await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`, 45000),
    'the page reloads and finishes booting again',
  );
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  await evaluate(cdp, INSTALL_FETCH_LOG); // the navigation took the first one with the document
  await evaluate(cdp, `switchTab('llm')`);
  await evaluate(cdp, `switchLlmTab('llama')`);
  ok(await waitFor(cdp, `document.getElementById('llaSel').options.length === 10`), 'the drop-down fills again after the reload');
  ok(
    (await evaluate(cdp, `document.getElementById('llaSel').value`)) === 'model-p-3b',
    'and it opens on the model he last loaded — not the first row, and not whatever is resident',
  );
  const papaDetail = await evaluate(cdp, `document.getElementById('llaDetail').innerText.replace(/\\s+/g, ' ')`);
  ok(
    papaDetail.trim() !== '' && papaDetail.trim() !== '—',
    `the detail line follows the restored pick (got ${JSON.stringify(papaDetail)})`,
  );

  // ── 12. LOOK AT IT. A geometry assertion can pass on a layout that reads wrong. ──
  if (shotPath) {
    await evaluate(cdp, `document.getElementById('overlay').classList.remove('on')`);
    // The overlay fades out; the picture is taken when that transition has finished and a frame
    // has been painted (this was `sleep(400)`, a guess at the fade's length).
    await evaluate(cdp, TRANSITIONS_FINISHED);
    await evaluate(cdp, NEXT_FRAME);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`  (screenshot written to ${shotPath})`);
  }

  ok(pageErrors.length === 0, `no uncaught page exceptions (${JSON.stringify(pageErrors.slice(0, 3))})`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`SPEC ERROR: ${err && err.stack ? err.stack : err}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

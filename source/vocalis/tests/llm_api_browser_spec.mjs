// Vocalis 11.1 — LLM ▸ API and "Worldbook editor uses", in a REAL browser.
//
// Browser coverage for the LLM API tab: provider search and selection, connection progress,
// and help text for the available engine types.
// WHY A BROWSER, when test_llmapi.py asserts every route: the feature is a JOIN — the help block
// and the engine drop-down in one partial, the API pane in another, two modules painting them, a
// debounce, a sequence guard, and a key that must never reach the DOM. Each can be right alone
// while the screen shows a Connect button that never spins, a stale list under a newer query, or
// an engine option that stays grey after its model was picked.
//
// 🔴 THE SPINNER IS ASSERTED ON A REQUEST THAT IS PROVABLY STILL IN FLIGHT. The fake OpenRouter
// holds `/v1/key` until this spec calls its `/__release`, so "disabled and spinning" is checked
// while the answer cannot have arrived yet — never on a guess about how long one takes.
//
// ⚠️ THE SECOND HALF OF EVERY CLAIM IS ASSERTED IN PYTHON: what the fake providers received, what
// landed in the encrypted section and in app_settings.yaml. A DOM check alone is satisfied by an
// optimistic render.
//
// CDP plumbing mirrors llama_picker_browser_spec.mjs.
//
// Usage: node llm_api_browser_spec.mjs <base-url> <chrome-path> <shot-path> <openrouter-url> <featherless-url> <key>
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { NEXT_FRAME, TRANSITIONS_FINISHED } from './_specwait.mjs';

const [baseUrl, chromePath, shotPath, orUrl, flUrl, KEY] = process.argv.slice(2);
if (!baseUrl || !chromePath || !orUrl || !flUrl || !KEY) {
  console.error('usage: node llm_api_browser_spec.mjs <base> <chrome> <shot> <or-url> <fl-url> <key>');
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

// ── CDP plumbing (mirrors llama_picker_browser_spec.mjs) ─────────────────────
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

// 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED" — a wait whose expression can throw is a race.
// The deadline only bounds a HANG (a passing run never waits it out); 20 s was too short with dozens
// of these specs running at once, so the default is 60 s (2026-10-12).
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

const $v = id => `document.getElementById(${JSON.stringify(id)})`;
const text = (cdp, id) => evaluate(cdp, `(${$v(id)}.innerText || '').replace(/\\s+/g, ' ').trim()`);

// Type the way a human does: set the value, then fire `input` — the debounce listens to that.
const type = (cdp, id, value) =>
  evaluate(
    cdp,
    `(() => { const e = ${$v(id)}; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`,
  );
const choose = (cdp, id, value) =>
  evaluate(
    cdp,
    `(() => { const e = ${$v(id)}; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change')); return e.value; })()`,
  );
const click = (cdp, id) => evaluate(cdp, `(${$v(id)}.click(), true)`);

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-llmapi-cdp-'));
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
  // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
  // Both variables point into the owned profile so cleanup contains extracted scratch.
  { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TEMP: profile, TMP: profile } },
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

const boot = async cdp => {
  await cdp.send('Page.navigate', { url: baseUrl });
  const up = await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`, 45000);
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  return up;
};

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
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });

  ok(await boot(cdp), 'the page loads and finishes booting');
  await evaluate(cdp, `switchTab('llm')`);

  // ── 1. the help text, ABOVE the sub-tabs ────────────────────────────────────
  const help = await text(cdp, 'llmHelp');
  ok(
    /SillyTavern/.test(help) && /edit your worldbooks/.test(help),
    `the help says local engines serve SillyTavern AND the editor (${JSON.stringify(help.slice(0, 80))}…)`,
  );
  ok(/used only by the worldbook editor/.test(help), 'the help says the API is used only by the worldbook editor');
  ok(
    await evaluate(
      cdp,
      `${$v('llmIntro')}.getBoundingClientRect().bottom <= ${$v('llmTabs')}.getBoundingClientRect().top + 1 && ${$v('llmIntro')}.offsetHeight > 0`,
    ),
    'it sits above the sub-tab strip and is visible',
  );
  const strip = await evaluate(cdp, `[...document.querySelectorAll('#llmTabs button')].map(b => b.textContent.trim())`);
  ok(
    JSON.stringify(strip) === JSON.stringify(['llama.cpp', 'KoboldCpp', 'API']),
    `the strip is llama.cpp · KoboldCpp · API (got ${JSON.stringify(strip)})`,
  );

  // ── 2. the engine drop-down before anything is configured ───────────────────
  ok(await waitFor(cdp, `${$v('llmEngine')}.options.length === 4`), 'the editor-engine drop-down lists four engines');
  ok((await evaluate(cdp, `${$v('llmEngine')}.value`)) === 'kobold', 'and an unset choice reads KoboldCpp');
  ok(
    await evaluate(
      cdp,
      `(() => { const o = [...${$v('llmEngine')}.options].find(x => x.value === 'openrouter'); return o.disabled && /no API key/.test(o.textContent); })()`,
    ),
    'OpenRouter is greyed out, saying why',
  );

  // ── 3. the API pane, empty ──────────────────────────────────────────────────
  await evaluate(cdp, `switchLlmTab('api')`);
  ok(await waitFor(cdp, `/No OpenRouter key saved/.test(${$v('apiKeyState')}.innerText)`), 'the API pane opens on OpenRouter with no key');
  ok(await evaluate(cdp, `${$v('apiConnect')}.disabled && ${$v('apiSearch')}.disabled`), 'Connect and search are disabled without a key');
  ok(await evaluate(cdp, `${$v('apiResults')}.style.display === 'none'`), 'there is no model list before anything is typed');

  // ── 4. save a key: it goes in, and never comes back out ─────────────────────
  await evaluate(cdp, `${$v('apiToken')}.value = ${JSON.stringify(KEY)}`);
  await click(cdp, 'apiKeySave');
  ok(await waitFor(cdp, `/key is saved/.test(${$v('apiKeyState')}.innerText)`), 'Save key → "A OpenRouter key is saved"');
  ok((await evaluate(cdp, `${$v('apiToken')}.value`)) === '', 'the input is emptied after the save');
  ok(!(await evaluate(cdp, `document.documentElement.outerHTML.includes(${JSON.stringify(KEY)})`)), 'the key is nowhere in the page');
  ok(
    await evaluate(cdp, `!${$v('apiConnect')}.disabled && !${$v('apiSearch')}.disabled`),
    'Connect and search are enabled once a key is saved',
  );

  // ── 5. Connect spins while the provider is still answering (R6) ─────────────
  await click(cdp, 'apiConnect');
  ok(
    await waitFor(
      cdp,
      `${$v('apiConnect')}.disabled && !!${$v('apiConnect')}.querySelector('.spin') && /Connecting/.test(${$v('apiConnect')}.innerText)`,
    ),
    'Connect → disabled, spinner, "Connecting…" while /v1/key is held',
  );
  // 11.1 code review: a repaint mid-Connect used to re-enable the spinning button, and a key
  // changed mid-check would be judged by the old key's answer. Both are held while it spins.
  ok(
    await evaluate(cdp, `${$v('apiKeySave')}.disabled && ${$v('apiKeyRemove')}.disabled && ${$v('apiProvider')}.disabled`),
    'Save key, Remove and the provider switch are held while Connect is in flight',
  );
  await evaluate(cdp, `switchLlmTab('api')`); // a repaint mid-Connect (apiLoadAll → refresh → paint)
  ok(
    await waitFor(cdp, `${$v('apiConnect')}.disabled && !!${$v('apiConnect')}.querySelector('.spin')`),
    'a repaint during Connect does not re-enable the spinning button',
  );
  await fetch(`${orUrl}/__release`);
  ok(
    await waitFor(
      cdp,
      `!${$v('apiConnect')}.disabled && !${$v('apiConnect')}.querySelector('.spin') && /key OK/.test(${$v('apiConnectState')}.innerText)`,
    ),
    'released → the spinner goes, the button comes back, and the verdict is shown',
  );
  ok(/\$7\.50 left/.test(await text(cdp, 'apiConnectState')), 'the verdict carries the key’s remaining credit');
  ok(
    await evaluate(cdp, `!${$v('apiKeySave')}.disabled && !${$v('apiKeyRemove')}.disabled && !${$v('apiProvider')}.disabled`),
    'and the held controls come back',
  );

  // ── 6. search, then click (R5) ──────────────────────────────────────────────
  await type(cdp, 'apiSearch', 'glm');
  ok(
    await waitFor(cdp, `${$v('apiResults')}.style.display !== 'none' && ${$v('apiResults')}.querySelectorAll('.apirow').length > 0`),
    'typing "glm" shows matches',
  );
  const ids = await evaluate(cdp, `[...document.querySelectorAll('#apiResults .apirow .id')].map(e => e.textContent)`);
  ok(
    ids[0] === 'z-ai/glm-4.6' && ids.length <= 50,
    `the best match leads and the list is capped (got ${JSON.stringify(ids.slice(0, 4))}, ${ids.length} rows)`,
  );
  ok(
    /203k ctx/.test(await evaluate(cdp, `document.querySelector('#apiResults .apirow .facts').textContent`)),
    'each row states its context',
  );
  await evaluate(cdp, `document.querySelector('#apiResults .apirow').click()`);
  ok(await waitFor(cdp, `/z-ai\\/glm-4\\.6/.test(${$v('apiSelected')}.innerText)`), 'clicking a row picks it');
  ok(await evaluate(cdp, `${$v('apiResults')}.style.display === 'none' && ${$v('apiSearch')}.value === ''`), 'and the list closes');
  ok(/sent to OpenRouter/.test(await text(cdp, 'apiPrivacy')), 'the pane says field text is sent to OpenRouter');

  // ── 7. the engine drop-down follows, and the readout names the model ────────
  ok(
    await waitFor(
      cdp,
      `(() => { const o = [...${$v('llmEngine')}.options].find(x => x.value === 'openrouter'); return o && !o.disabled; })()`,
    ),
    'OpenRouter becomes selectable once it has a key and a model',
  );
  await choose(cdp, 'llmEngine', 'openrouter');
  ok(
    await waitFor(cdp, `${$v('llmEngineModel')}.innerText === 'model: z-ai/glm-4.6'`),
    'choosing it → the readout says the model a pass would use',
  );
  // Measure alignment against the select itself; the readout must not be centered across its label
  // and control or inherit the smaller typography.
  const geo = await evaluate(
    cdp,
    `(() => { const s = ${$v('llmEngine')}.getBoundingClientRect(), m = ${$v('llmEngineModel')}.getBoundingClientRect();
       return { dy: Math.abs((s.top + s.bottom) / 2 - (m.top + m.bottom) / 2),
                sel: getComputedStyle(${$v('llmEngine')}).fontSize, txt: getComputedStyle(${$v('llmEngineModel')}).fontSize }; })()`,
  );
  ok(geo.dy <= 2, `the model readout is vertically centred on the drop-down (off by ${geo.dy.toFixed(1)}px)`);
  ok(geo.sel === geo.txt, `and is the drop-down's text size (${geo.txt} vs ${geo.sel})`);

  // ── 8. Featherless: a slow search must not overwrite a newer one ────────────
  await choose(cdp, 'apiProvider', 'featherless');
  ok(
    await waitFor(cdp, `/No Featherless key saved/.test(${$v('apiKeyState')}.innerText)`),
    'switching provider shows Featherless’s own (empty) state',
  );
  await evaluate(cdp, `${$v('apiToken')}.value = ${JSON.stringify(KEY)}`);
  await click(cdp, 'apiKeySave');
  ok(await waitFor(cdp, `/key is saved/.test(${$v('apiKeyState')}.innerText)`), 'a Featherless key saves separately');
  // Count completed answers to the HELD query from inside the page, so the check below runs after
  // it has really landed — an absence assertion needs to know the thing it is excluding happened.
  await evaluate(
    cdp,
    `(() => { window.__heldDone = false; const f = window.fetch; window.fetch = (...a) => f(...a).then(r => { if (String(a[0]).includes('q=hold')) r.clone().json().then(() => setTimeout(() => (window.__heldDone = true), 0)); return r; }); return true; })()`,
  );
  await type(cdp, 'apiSearch', 'hold');
  ok(await waitFor(cdp, `${$v('apiSearchSpin')}.style.display !== 'none'`), 'a search in flight shows the spinner in the box');
  await type(cdp, 'apiSearch', 'glm');
  ok(
    await waitFor(
      cdp,
      `[...document.querySelectorAll('#apiResults .apirow .id')].map(e => e.textContent).join() === 'zai-org/GLM-4.6,zai-org/GLM-4-32B-0414'`,
    ),
    'the newer query paints, plan-filtered',
  );
  await fetch(`${flUrl}/__release`);
  ok(await waitFor(cdp, `window.__heldDone === true`), 'the older, held query then answers');
  ok(
    (await evaluate(cdp, `[...document.querySelectorAll('#apiResults .apirow .id')].map(e => e.textContent).join()`)) ===
      'zai-org/GLM-4.6,zai-org/GLM-4-32B-0414',
    'and it does NOT overwrite the newer list',
  );

  // ── 9. reload: the provider shown and the pick both survive ─────────────────
  ok(await boot(cdp), 'the page reloads');
  await evaluate(cdp, `switchTab('llm')`);
  await evaluate(cdp, `switchLlmTab('api')`);
  ok(
    await waitFor(cdp, `${$v('apiProvider')}.value === 'featherless' && /key is saved/.test(${$v('apiKeyState')}.innerText)`),
    'it reopens on Featherless, the provider last shown',
  );
  await choose(cdp, 'apiProvider', 'openrouter');
  ok(
    await waitFor(cdp, `/z-ai\\/glm-4\\.6/.test(${$v('apiSelected')}.innerText) && /203k ctx/.test(${$v('apiSelected')}.innerText)`),
    'OpenRouter’s pick survives the reload with its facts',
  );
  ok(await waitFor(cdp, `${$v('llmEngine')}.value === 'openrouter'`), 'and so does the editor-engine choice');

  // ── 10. LOOK AT IT ──────────────────────────────────────────────────────────
  if (shotPath) {
    // Taken once the page has stopped moving: every finite transition done and a frame painted
    // (this was `sleep(300)`, a guess at how long the reload's repaint takes).
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

// Release audit 2026-10-11 — the Docker flag reaching the page, in a REAL browser against a REAL server.
//
// The server tells the page one boolean (`/health` -> `docker`), and the page switches its texts and
// controls on it. A Flask test can see the boolean and a Node slice can see each helper, but neither
// can see the JOIN: /health -> pollReady -> `<html data-docker>` -> CSS `.docker-only`/`.plain-only`,
// and /health -> DOCKER -> the KoboldCpp panel's wording. This spec drives that join.
//
// One spec, three modes (argv[4]):
//   plain         a source run: the manual book path is offered, loopback examples stay, the
//                 KoboldCpp detail line reads the .kcpps file and reports a missing model file.
//   docker        the package: data-docker="1", the manual book path is not offered, the address
//                 notes show, the KoboldCpp detail line says the files are not readable from here.
//   docker-unset  the package with no KoboldCpp address at all: "not set up yet", never
//                 "isn't answering at https://127.0.0.1:5001".
//
// No npm dependencies — Node ships WebSocket and fetch, Chrome speaks CDP (kobold_warn_browser_spec.mjs).
//
// Usage: node docker_flag_browser_spec.mjs <base-url> <chrome-path> <plain|docker|docker-unset>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

const [baseUrl, chromePath, mode] = process.argv.slice(2);
if (!baseUrl || !chromePath || !['plain', 'docker', 'docker-unset'].includes(mode)) {
  console.error('usage: node docker_flag_browser_spec.mjs <base-url> <chrome-path> <plain|docker|docker-unset>');
  process.exit(2);
}
const DOCKER = mode !== 'plain';

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

// A poll that throws is "not yet", not "failed" (see kobold_warn_browser_spec.mjs).
// The deadline only bounds a HANG; a passing run never waits it out. 15 to 20 s was too short with
// dozens of these specs running at once, so the default is 60 s (2026-10-12).
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

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-dockerflag-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--ignore-certificate-errors',
    '--window-size=1920,1200',
    'about:blank',
  ],
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

  // ── 1. the flag reaches the page ───────────────────────────────────────
  ok(
    await waitFor(cdp, `document.documentElement.dataset.docker === ${JSON.stringify(DOCKER ? '1' : '0')}`),
    `/health's docker flag lands on <html data-docker> (${DOCKER ? '1' : '0'})`,
  );
  const health = await evaluate(cdp, `fetch('/health').then(r => r.json()).then(h => h.docker)`);
  ok(health === DOCKER, `and it is the server's own answer (${JSON.stringify(health)})`);

  // ── 2. item 4: the manual book path ────────────────────────────────────
  const disp = id => evaluate(cdp, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).display`);
  const manual = await disp('bookManualPath');
  ok(
    DOCKER ? manual === 'none' : manual !== 'none',
    `the "…or enter a server path manually" disclosure is ${DOCKER ? 'not offered' : 'offered'} (display ${manual})`,
  );
  ok(
    await evaluate(cdp, `!!document.getElementById('path') && !!document.getElementById('parseBtn')`),
    'the path input is still in the DOM (the uploaded-book picker fills it)',
  );

  // ── 3. items 5 and 8: switched text ────────────────────────────────────
  const note = await disp('kobUrlDockerNote');
  ok(DOCKER ? note !== 'none' : note === 'none', `the loopback advice under the KoboldCpp address is ${DOCKER ? 'shown' : 'hidden'}`);
  const llaNote = await disp('llaUrlDockerNote');
  ok(DOCKER ? llaNote !== 'none' : llaNote === 'none', `and under the llama.cpp address (${llaNote})`);
  const ph = await evaluate(cdp, `document.getElementById('kobUrl').placeholder`);
  ok(DOCKER ? /host\.docker\.internal/.test(ph) : /127\.0\.0\.1/.test(ph), `the KoboldCpp address example is ${JSON.stringify(ph)}`);
  const tip = await evaluate(cdp, `document.getElementById('vRefresh').title`);
  ok(
    DOCKER ? !/voice_samples/.test(tip) : /voice_samples/.test(tip),
    `the Voices refresh tooltip is ${DOCKER ? 'true for the encrypted edition' : 'unchanged'}`,
  );
  const outputHand = await evaluate(
    cdp,
    `(() => { const s = [...document.querySelectorAll('.plain-only')].find(e => /copied into/.test(e.textContent)); return s ? getComputedStyle(s).display : 'absent'; })()`,
  );
  ok(
    DOCKER ? outputHand === 'none' : outputHand !== 'none' && outputHand !== 'absent',
    `"(or copied into output/ by hand)" is ${DOCKER ? 'not shown' : 'shown'}`,
  );

  // ── 4. item 2 / 8: the KoboldCpp panel ─────────────────────────────────
  await evaluate(cdp, `switchTab('llm')`);
  await evaluate(cdp, `switchLlmTab('kobold')`);
  if (mode === 'docker-unset') {
    ok(
      await waitFor(cdp, `document.getElementById('kobUnavail').style.display !== 'none'`),
      'the KoboldCpp tab shows its unavailable panel',
    );
    const msg = await evaluate(cdp, `document.getElementById('kobUnavailMsg').innerText.replace(/\\s+/g, ' ')`);
    ok(/not set up yet/.test(msg), `with no address it says "not set up yet" (got ${JSON.stringify(msg)})`);
    ok(!/isn't answering/.test(msg) && !/127\.0\.0\.1/.test(msg), 'and never "isn\'t answering at https://127.0.0.1:5001"');
    ok(/host\.docker\.internal/.test(msg), 'and says where the address goes and what it looks like');
  } else {
    ok(await waitFor(cdp, `document.getElementById('kobMain').style.display !== 'none'`), 'the KoboldCpp tab finds the server');
    ok(await waitFor(cdp, `document.getElementById('kobSel').options.length > 0`), 'a config is listed');
    const detail = await evaluate(cdp, `document.getElementById('kobDetail').innerText.replace(/\\s+/g, ' ')`);
    const red = await evaluate(
      cdp,
      `[...document.querySelectorAll('#kobDetail span')].some(s => /var\\(--err\\)/.test(s.getAttribute('style') || ''))`,
    );
    if (DOCKER) {
      ok(
        /details of this config are not readable from here/.test(detail),
        `the config line says so neutrally (got ${JSON.stringify(detail)})`,
      );
      ok(!red && !/not found|model file missing/.test(detail), 'and nothing is red or "not found"');
    } else {
      ok(/ctx/.test(detail), `a source run reads the .kcpps file (got ${JSON.stringify(detail)})`);
      ok(red && /model file missing/.test(detail), 'and still reports a model file that is really missing, in red');
    }
  }

  ok(pageErrors.length === 0, `the page threw nothing: ${pageErrors.join(' | ') || 'clean'}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`  FAIL harness: ${err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

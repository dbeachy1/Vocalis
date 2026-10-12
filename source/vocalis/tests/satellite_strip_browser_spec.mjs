// Vocalis 10.21 — the header's FAN slot and satellite block, in a REAL browser (design doc
// DESIGN_10_21_FAN_AND_SATELLITE_STRIP.md §7, §9).
//
// WHY, when nothing else in the suite can see this: same argument as power_line_browser_spec.mjs
// next door. A payload test stops at the JSON; a hand-copied markup test (test_strip_layout.py)
// measures a fixture nothing enforces against `hwstrip.js`. Between the JSON and a printed FAN
// percentage or a satellite's own VRAM bar sit `renderVram`'s shape signature, the keyed
// `buildVram`/`updateVram` split, and a real layout — and none of that is reachable without a
// live DOM.
//
// 🔴 THIS SPEC DRIVES THE RENDERER DIRECTLY, NOT A LIVE `/system/stats` POLL CARRYING SATELLITES.
// This spec focuses on satellite rendering; primary GPU sampling is tested separately.
// (`runtime/satstats.py`) that folds a satellite's readings into the strip sample — is a SEPARATE,
// concurrently-built change (design doc §4-§6) that this file's own brief explicitly does not
// touch. Rather than wait on it or fake it at the Flask layer, this imports `hwstrip.js` exactly
// as the live page already does and calls its one relevant export, `renderStrip`, with fabricated
// `StripSample` objects shaped exactly like the design doc's payload contract — `test_power_line_
// browser.py`'s own "hidden" case sets the precedent for driving the renderer this way.
// `stopIdleVram()` is called first, or the next 250 ms poll of the real (stubbed-empty)
// `/system/stats` paints straight over whatever this pushes.
//
// 🔴 EVERY `waitFor` EXPRESSION HERE IS A BARE `=== null` / `!== null` COMPARISON — NEVER A
// DEREFERENCE. `querySelector` returning `null` and being compared is the one shape of expression
// that cannot throw mid-repaint; a poll that reads `.textContent` off a maybe-absent node is a
// RACE, not a wait (see power_line_browser_spec.mjs's own note on this, and the incident it cites).
//
// Usage: node satellite_strip_browser_spec.mjs <base-url> <chrome-path> [screenshot-path]
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { NEXT_FRAME, TRANSITIONS_FINISHED } from './_specwait.mjs';

const [baseUrl, chromePath, shotPath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node satellite_strip_browser_spec.mjs <base-url> <chrome-path> [screenshot-path]');
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

// ── CDP plumbing (mirrors power_line_browser_spec.mjs / devices_browser_spec.mjs) ────────────
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

// The deadline only bounds a HANG; a passing run never waits it out. 20 s was too short with dozens
// of these specs running at once, so the default is 60 s (2026-10-12).
async function waitFor(cdp, expression, timeoutMs = 60000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // See power_line_browser_spec.mjs's own note on `Promise.resolve(...)` and on remembering a
    // thrown poll rather than swallowing it — copied verbatim, not reinvented.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-sat-cdp-'));
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
  // Both flags, as the sibling specs do: `readyState === 'complete'` alone fires before the bundle's
  // modules have run, and the page's own `hwstrip.js` instance (used below) does not exist until they have.
  if (!(await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`, 60000)))
    throw new Error('the page never finished booting (readyState/__uiReady/__bootDone)');

  // 🔴 STOP THE LIVE SAMPLER FIRST. `startIdleVram()` is already running off `js/main.js`'s boot
  // sequence by the time this fires; without this, its next 250 ms poll of the (stubbed-empty)
  // `/system/stats` paints straight over every fabricated sample below.
  //
  // ⚠️ THE PAGE'S OWN INSTANCE, NOT A FRESH `import()`. The page loads `/webui/bundle/app.js`, so
  // `import('/webui/js/sys/hwstrip.js')` builds a SECOND copy of the module (checked 2026-10-12:
  // `window.__VOCALIS__['sys/hwstrip.js'] !== ` that import). `stopIdleVram()` on the copy stopped
  // nothing: the real sampler kept running and repainting the same DOM while this spec read it.
  // `window.__VOCALIS__` hands back the instance that is wired to the page (see tests/_websrc.mjs).
  await evaluate(
    cdp,
    `(async () => {
      const m = (window.__VOCALIS__ && window.__VOCALIS__['sys/hwstrip.js']) || (await import('/webui/js/sys/hwstrip.js'));
      window.__hw = m;
      m.stopIdleVram();
      // 🔴 THE NUMBERS' 500 ms GATE RUNS ON \`performance.now()\`, SO THE SPEC DRIVES THAT CLOCK.
      // \`renderStrip\` only rewrites the printed figures once 480 ms have passed since the last time
      // it did (\`strip.numDue\`). The spec used to SLEEP 600 ms to get past it; a sleep is a guess
      // about the machine, while advancing the page's clock by that amount is exact. The skew is
      // added to every \`performance.now()\` the page reads, from here on.
      if (!window.__clockSkew) {
        window.__clockSkew = 0;
        const real = performance.now.bind(performance);
        performance.now = () => real() + window.__clockSkew;
      }
    })()`,
  );
  // Move the page's clock forward by \`ms\` without waiting.
  const advanceClock = ms => evaluate(cdp, `(window.__clockSkew += ${ms}, true)`);

  // ── fixtures — shaped like the renderer's payload contract ─────────────────────────────────
  // Minimal: `cores` is the only field `renderCpu` requires non-null, and every field this spec
  // does not set reads `undefined`, which every consumer below treats the same as `null`.
  const CPU = { pct: 10, cores: 8 };
  // Primary-host card — an AMD Radeon sample, all six sensors present so the FAN slot's
  // position relative to the other four is unambiguous. `over` lets one field vary per call
  // without restating the rest (used for the fan_pct 20 -> 0 -> null sequence below).
  const primaryGpu = (over = {}) =>
    Object.assign(
      {
        index: 0,
        name: 'AMD Radeon Graphics',
        total_gb: 32,
        used_gb: 5,
        free_gb: 27,
        vocalis_gb: 2,
        util_pct: 10,
        sclk_mhz: 800,
        mclk_mhz: 1258,
        fan_pct: 20,
        power_w: 45,
        temp_c: 52,
      },
      over,
    );
  // Satellite GPU sample with both usage and Vocalis-owned memory.
  const SATELLITE_GPU = {
    index: 0,
    device: 'cuda:0',
    name: 'NVIDIA GeForce RTX 4090',
    total_gb: 24.0,
    used_gb: 3.8,
    free_gb: 20.2,
    vocalis_gb: 1.4,
    util_pct: 1,
    sclk_mhz: 330,
    mclk_mhz: 10501,
    power_w: 68,
    temp_c: 49,
    fan_pct: 0,
  };
  const sample = (gpus, satellites) => ({ gpus, cpu: CPU, power: null, ups: null, temps: null, satellites });
  const render = s => evaluate(cdp, `window.__hw.renderStrip(${JSON.stringify(s)})`);

  // ── 1. the FAN slot sits directly after MEM, and prints the live reading ───────────────────
  await render(sample([primaryGpu()], []));
  const order1 = await evaluate(cdp, `[...document.querySelectorAll('.card[data-g="0"] .ustat')].map(e => e.getAttribute('data-r'))`);
  ok(
    JSON.stringify(order1) === JSON.stringify(['sclk', 'mclk', 'fan', 'pw', 'temp']),
    `FAN sits directly after MEM in the sensor row, in this order (got ${JSON.stringify(order1)})`,
  );
  const fanText20 = await evaluate(cdp, `(document.querySelector('.card[data-g="0"] [data-r="fan"]') || {}).innerText || ''`);
  ok(/FAN\s*20\s*%/.test(fanText20.replace(/\s+/g, ' ')), `the live fan reading prints (got ${JSON.stringify(fanText20)})`);

  // ── 2. 0% is a real reading, never an omission ─────────────────────────────────────────────
  // 🔴 A VALUE-ONLY CHANGE, NOT A SHAPE CHANGE. `sensorBits()` records presence, not value, so
  // 20 -> 0 does not touch `renderVram`'s signature and the printed figure only rewrites once
  // `numDue` is true again on its own clock. 600 ms is comfortably past hwstrip.js's own
  // `NUM_MS` gate (500 ms), so the next render is guaranteed to redraw the number, not just glide
  // the bar. (Those 600 ms are now added to the page's clock rather than slept: it was
  // `sleep(600)`, which only gets past the gate if the machine really let 600 ms go by.)
  await advanceClock(600);
  await render(sample([primaryGpu({ fan_pct: 0 })], []));
  const fanText0 = await evaluate(cdp, `(document.querySelector('.card[data-g="0"] [data-r="fan"]') || {}).innerText || ''`);
  ok(/FAN\s*0\s*%/.test(fanText0.replace(/\s+/g, ' ')), `FAN 0 % is shown, not omitted (got ${JSON.stringify(fanText0)})`);

  // ── 3. absent, not blanked, when the sensor is null ────────────────────────────────────────
  await render(sample([primaryGpu({ fan_pct: null })], []));
  const fanGone = await evaluate(cdp, `document.querySelector('.card[data-g="0"] [data-r="fan"]') === null`);
  ok(fanGone, 'the fan slot is omitted, not blanked, when fan_pct is null');

  // ── geometry baseline: the primary card, with no satellite in the DOM ──────────────────────
  const rect = () =>
    evaluate(
      cdp,
      `(() => { const r = document.querySelector('.card[data-g="0"]').getBoundingClientRect();
                return { left: r.left, top: r.top }; })()`,
    );
  const before = await rect();

  // ── 4. the satellite block appears, with its cap line and a two-color bar ─────────────────
  await render(sample([primaryGpu()], [{ name: 'test-satellite', gpus: [SATELLITE_GPU] }]));
  ok(
    await waitFor(cdp, `document.querySelector('.card[data-g="test-satellite:cuda:0"]') !== null`),
    'the satellite block appears in #vramCards below the primary card',
  );
  const cap = await evaluate(cdp, `(document.querySelector('.card[data-g="test-satellite:cuda:0"] .cap span') || {}).textContent || ''`);
  ok(cap.trim() === 'test-satellite · cuda:0 NVIDIA GeForce RTX 4090', `the cap line reads exactly that (got ${JSON.stringify(cap)})`);
  const bar = await evaluate(
    cdp,
    `(() => { const c = document.querySelector('.card[data-g="test-satellite:cuda:0"]');
              const voc = c.querySelector('.vvoc'), used = c.querySelector('.vused');
              return { vocW: voc.style.width, vocL: voc.style.left, usedW: used.style.width }; })()`,
  );
  ok(
    parseFloat(bar.vocW) > 0 && parseFloat(bar.usedW) > 0,
    `the satellite's VRAM bar carries BOTH colors — Vocalis's share and other apps (got ${JSON.stringify(bar)})`,
  );
  ok(bar.vocL === '0%', "Vocalis's share starts at the left, same rule as the primary card");

  const afterAppear = await rect();
  ok(
    Math.abs(afterAppear.left - before.left) <= 0.5 && Math.abs(afterAppear.top - before.top) <= 0.5,
    `the primary card did not move when the satellite block appeared — vertical growth only ` +
      `(before ${JSON.stringify(before)}, after ${JSON.stringify(afterAppear)})`,
  );

  // ── 4a. THIS BOX'S CPU ROWS SIT ABOVE EVERY CARD ────────────────────────────────
  // CPU rows belong to the primary host. Keep them above all cards so a satellite card cannot
  // make the primary CPU and memory readings appear to belong to the satellite.
  //
  // 🔴 GEOMETRY, NOT DOM ORDER. The claim is visual — "you cannot mistake whose CPU that is" —
  // and `#vram` is a flex column, so a future `order:` or `flex-direction:column-reverse` would
  // reverse what the eye sees while `compareDocumentPosition` still said "before". Comparing the
  // rows' painted bottom against the cards' painted top is the same question the eye asks.
  const stack = await evaluate(
    cdp,
    `(() => {
       const bot = id => document.getElementById(id).getBoundingClientRect().bottom;
       const cards = [...document.querySelectorAll('#vram .card[data-g]')]
         .map(c => ({ key: c.getAttribute('data-g'), top: c.getBoundingClientRect().top }));
       return { cpu: bot('cpuLine'), cpuMem: bot('cpuMemLine'), cards };
     })()`,
  );
  ok(stack.cards.length === 2, `both cards are on screen for this check (got ${stack.cards.length})`);
  const lowestRow = Math.max(stack.cpu, stack.cpuMem);
  const covered = stack.cards.filter(c => c.top < lowestRow).map(c => c.key);
  ok(
    covered.length === 0,
    `this box's CPU and CPU MEM rows are painted ABOVE every card, primary and satellite alike ` +
      `— a card starting higher than the CPU rows end is a row that reads as belonging to that card ` +
      `(rows end at ${lowestRow.toFixed(1)}px; cards start at ` +
      `${JSON.stringify(stack.cards.map(c => [c.key, +c.top.toFixed(1)]))}` +
      `${covered.length ? `; ABOVE THE ROWS: ${JSON.stringify(covered)}` : ''})`,
  );

  // ── 5. it vanishes elegantly when the payload drops satellites ────────────────────────────
  await render(sample([primaryGpu()], []));
  ok(
    await waitFor(cdp, `document.querySelector('.card[data-g="test-satellite:cuda:0"]') === null`),
    'the satellite block leaves the DOM entirely once satellites is empty — no heading, nothing left behind',
  );
  const afterGone = await rect();
  ok(
    Math.abs(afterGone.left - before.left) <= 0.5 && Math.abs(afterGone.top - before.top) <= 0.5,
    `the primary card did not move when the satellite block vanished ` +
      `(before ${JSON.stringify(before)}, after ${JSON.stringify(afterGone)})`,
  );

  // ── 6. and it comes back on its next good sample ───────────────────────────────────────────
  await render(sample([primaryGpu()], [{ name: 'test-satellite', gpus: [SATELLITE_GPU] }]));
  ok(
    await waitFor(cdp, `document.querySelector('.card[data-g="test-satellite:cuda:0"]') !== null`),
    'the satellite block comes back once the payload reports it again',
  );

  // ── 7. a card whose memory is UNKNOWN prints no numbers it does not have (October 10, 2026) ─
  // Seen live: an AMD satellite answered with total_gb/used_gb/free_gb/name all null and a Vocalis
  // share of 4.2, and the row read "0.0 / 0.0 GB · 4.2" over an empty bar. Each case uses its own
  // satellite NAME so the card is rebuilt and its first paint is not held back by the numbers' gate.
  const UNKNOWN = {
    index: 0,
    device: 'cuda:0',
    name: null,
    total_gb: null,
    used_gb: null,
    free_gb: null,
    vocalis_gb: 4.2,
    util_pct: null,
    sclk_mhz: null,
    mclk_mhz: null,
    fan_pct: null,
    power_w: null,
    temp_c: null,
  };
  const satCard = async (name, gpu) => {
    await render(sample([primaryGpu()], [{ name, gpus: [gpu] }]));
    const key = `${name}:${gpu.device}`;
    await waitFor(cdp, `document.querySelector('.card[data-g="${key}"] [data-r="cap"]') !== null`);
    return evaluate(
      cdp,
      `(() => { const c = document.querySelector('.card[data-g="${key}"]');
                const bar = c.querySelector('.bar');
                return { text: c.querySelector('[data-r="cap"]').textContent.replace(/\\s+/g, ' ').trim(),
                         html: c.querySelector('[data-r="cap"]').innerHTML,
                         capTitle: c.querySelector('[data-r="cap"]').title,
                         rowTitle: c.querySelector('.brow').title,
                         barHidden: bar.style.visibility === 'hidden',
                         vocW: c.querySelector('.vvoc').style.width, usedW: c.querySelector('.vused').style.width,
                         caption: c.querySelector('.cap span').textContent.trim() }; })()`,
    );
  };

  const unk = await satCard('unk-share', UNKNOWN);
  ok(unk.text === '— GB · 4.2', `unknown memory with a Vocalis share shows a dash and the share (got ${JSON.stringify(unk.text)})`);
  ok(!/0\.0/.test(unk.text), 'no 0.0 figure is printed for an unknown card');
  ok(/color:var\(--ok\)/.test(unk.html), 'the Vocalis share keeps its green look');
  ok(
    unk.barHidden && parseFloat(unk.vocW) === 0 && parseFloat(unk.usedW) === 0,
    `no bar is drawn for an unknown card (got ${JSON.stringify([unk.barHidden, unk.vocW, unk.usedW])})`,
  );
  ok(
    !/0\.0/.test(unk.rowTitle + unk.capTitle) && /Vocalis holds 4\.2 GB/.test(unk.rowTitle + unk.capTitle),
    `the tooltips say it is not reported, not 0.0 (got ${JSON.stringify([unk.rowTitle, unk.capTitle])})`,
  );
  ok(unk.caption === 'unk-share · cuda:0', `a null name leaves a caption without one (got ${JSON.stringify(unk.caption)})`);

  const unkNone = await satCard('unk-none', Object.assign({}, UNKNOWN, { vocalis_gb: null }));
  ok(unkNone.text === '— GB', `unknown memory and no Vocalis share shows just the dash (got ${JSON.stringify(unkNone.text)})`);
  ok(unkNone.barHidden, 'no bar for an unknown card without a share either');

  // Missing keys (an older satellite) are the same as null, and one null is enough.
  const gone = Object.assign({}, UNKNOWN);
  delete gone.total_gb;
  delete gone.used_gb;
  const unkMissing = await satCard('unk-missing', gone);
  ok(unkMissing.text === '— GB · 4.2', `absent memory keys read like null (got ${JSON.stringify(unkMissing.text)})`);
  const half = await satCard('unk-half', Object.assign({}, SATELLITE_GPU, { used_gb: null }));
  ok(
    half.text === '— GB · 1.4' && half.barHidden,
    `a null used_gb alone makes the whole-card figure unknown (got ${JSON.stringify(half.text)})`,
  );
  const half2 = await satCard('unk-half2', Object.assign({}, SATELLITE_GPU, { total_gb: null }));
  ok(
    half2.text === '— GB · 1.4' && half2.barHidden,
    `a null total_gb alone makes the whole-card figure unknown (got ${JSON.stringify(half2.text)})`,
  );

  // Real numbers print exactly as before, on a satellite card...
  const real = await satCard('real-sat', SATELLITE_GPU);
  ok(real.text === '3.8 / 24.0 GB · 1.4', `a satellite card with real numbers is unchanged (got ${JSON.stringify(real.text)})`);
  ok(!real.barHidden && parseFloat(real.vocW) > 0 && parseFloat(real.usedW) > 0, 'its bar is drawn, both greens');
  ok(
    /3\.8 of 24\.0 GB used/.test(real.rowTitle) && /free 20\.2 GB/.test(real.rowTitle),
    `its tooltip is unchanged (got ${JSON.stringify(real.rowTitle)})`,
  );
  // ...a real zero is a number, shown as 0.0, with a bar...
  const zero = await satCard('zero-sat', Object.assign({}, SATELLITE_GPU, { used_gb: 0, free_gb: 24, vocalis_gb: 0 }));
  ok(zero.text === '0.0 / 24.0 GB', `a real 0.0 used is still shown (got ${JSON.stringify(zero.text)})`);
  ok(!zero.barHidden, 'a real zero keeps its (empty) bar');
  // ...an unknown free figure alone drops the "free" clause instead of printing 0.0...
  const noFree = await satCard('nofree-sat', Object.assign({}, SATELLITE_GPU, { free_gb: null }));
  ok(
    noFree.text === '3.8 / 24.0 GB · 1.4' && !/free/.test(noFree.rowTitle + noFree.capTitle),
    `a null free_gb is left out of the tooltips (got ${JSON.stringify([noFree.rowTitle, noFree.capTitle])})`,
  );
  // ...and the local card is untouched.
  await advanceClock(600); // past the numbers' 500 ms gate, so the next render rewrites the local card's text (was sleep(600))
  await render(sample([primaryGpu()], [{ name: 'real-sat', gpus: [SATELLITE_GPU] }]));
  const local = await evaluate(cdp, `document.querySelector('.card[data-g="0"] [data-r="cap"]').textContent.replace(/\\s+/g, ' ').trim()`);
  ok(local === '5.0 / 32.0 GB · 2.0', `the local card is unchanged (got ${JSON.stringify(local)})`);
  await render(sample([primaryGpu()], [{ name: 'test-satellite', gpus: [SATELLITE_GPU] }]));

  // ── one screenshot, WITH the satellite block present — LOOK at it, don't just measure it ──
  if (shotPath) {
    // Let the .25 s bar transition settle so the shot isn't mid-glide: wait for the transitions that
    // are running to finish (was sleep(300)). Only FINITE animations: the page has infinite ones
    // (.spin, .bar>div.indet) that never "finish", and waiting on one of those would hang.
    await evaluate(cdp, TRANSITIONS_FINISHED);
    await evaluate(cdp, NEXT_FRAME);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`  (screenshot written to ${shotPath})`);
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

// Vocalis 5.3-m3 — the ⚙ Settings Devices and Satellites panels, in a REAL browser.
//
// Why this exists, when devices_ui_smoke.mjs already covers the same helpers:
//
// That one runs renderDevices/renderSats under `vm` with a hand-built fake `$`. It proved the
// HTML those functions RETURN is right. It cannot see whether that HTML ever reaches the page:
// a boot order that renders before the panel exists, a listener bound to an element id that no
// longer matches, a `closest()` against a text node — every one of those leaves the string
// assertions passing and the panel dead. That is the 2026-07-24 lesson from the Voices player,
// where a markup test AND a Flask test-client test both passed while the thing was visibly
// broken in the browser.
//
// So this drives headless Chrome over the DevTools Protocol and asks the DOM: are the rows
// actually there, does ticking one persist through a reload, and does adding a satellite show
// its secret exactly once.
//
// No npm dependencies — Node ships WebSocket and fetch, Chrome speaks CDP. Same convention as
// voices_player_browser_spec.mjs, whose CDP plumbing this mirrors.
//
// Usage: node devices_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node devices_browser_spec.mjs <base-url> <chrome-path>');
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

// ── CDP plumbing (mirrors voices_player_browser_spec.mjs) ────────────────────
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

//
// The deadline (this default and every explicit one) only bounds a HANG; a passing run never waits
// it out. 20 s and the explicit 8 to 30 s were too short with dozens of these specs running at once,
// so they are 60 s (2026-10-12).
async function waitFor(cdp, expression, timeoutMs = 60000) {
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

// Docker edition: unticking a card that is running ACE-Step first opens "Stop ACE-Step on these cards?"
// (saveDevices in sys/devices.js) and NOTHING is saved until it is answered; Cancel puts the box back.
// Waits for that dialog by title and answers Save and stop, so the untick the spec is making actually
// reaches the server. Returns false if the dialog never appeared.
const confirmStopAce = async cdp =>
  (await waitFor(
    cdp,
    `document.getElementById('overlay').classList.contains('on') && /Stop ACE-Step/.test(document.getElementById('mTitle').textContent)`,
  )) &&
  (await evaluate(
    cdp,
    `(() => {
        const b = [...document.querySelectorAll('#mActs button')].find(x => /Save and stop/.test(x.textContent));
        if (!b) return false;
        b.click();
        return true;
    })()`,
  ));

// ── waiting for a device save to be FINISHED (local; see llm_tick_warn_browser_spec.mjs) ─────────
// Every `fetch` the page makes, with when it started and when it was answered (`end: null` = still
// in flight). `_specwait.mjs`'s log records a request only when its response arrives, so it cannot
// say "nothing is in flight" or "this came after that".
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
const traceMark = cdp => evaluate(cdp, `window.__trace.length`);
// No request about the devices panel is still in flight.
const PAGE_QUIET = `!window.__trace.some(e => e.end === null && ['/devices', '/enhance/info', '/llm/holding'].some(p => e.url.includes(p)))`;
// `saveDevices` is finished when its PUT was answered, `loadEnhanceInfo` (which it awaits next) was
// answered after it, and nothing else about the panel is in flight. A failed PUT ends it at once.
const deviceSaveDone = mark => `(() => {
    const t = window.__trace.slice(${mark});
    const i = t.findIndex(e => e.method === 'PUT' && e.url.includes('/devices'));
    if (i < 0 || t[i].end === null) return false;
    if (t[i].status !== 200) return true;
    return t.slice(i + 1).some(e => e.url.includes('/enhance/info') && e.end !== null) && ${PAGE_QUIET};
})()`;
// True once the save begun after `mark` has been answered 200 and the page has run on from it (the
// response is logged BEFORE the page's own code sees it; one painted frame later it has).
const awaitDeviceSave = async (cdp, mark, what) => {
  const done = await waitFor(cdp, deviceSaveDone(mark));
  const status = done
    ? await evaluate(cdp, `(window.__trace.slice(${mark}).find(e => e.method === 'PUT' && e.url.includes('/devices')) || {}).status`)
    : null;
  if (done && status === 200) return evaluate(cdp, NEXT_FRAME);
  const recent = await evaluate(
    cdp,
    `window.__trace.slice(-12).map(e => e.method + ' ' + e.url + ' -> ' + e.status + ' @' + e.start + '..' + e.end)`,
  ).catch(() => []);
  console.log(
    `  (${what}: the device save did not finish cleanly; done=${done}, PUT /devices status=${status}; last requests: ${JSON.stringify(recent)})`,
  );
  return false;
};

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-dev-cdp-'));
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

  // A page error is the failure mode a string test cannot see at all: the panel renders
  // nothing because boot threw three functions earlier.
  const pageErrors = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    }
  });

  await cdp.send('Page.navigate', { url: baseUrl });
  // The sibling specs gate on BOTH flags: `readyState === 'complete'` alone fires before the bundle's
  // modules have run and before the boot fetches (which fill this very panel) have settled.
  // `__uiReady` = the modules ran, `__bootDone` = the boot data arrived or failed. No `ok` line is
  // added for it (the wrapper audits them); a page that never gets there stops the spec.
  if (!(await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`, 90000)))
    throw new Error('the page never finished booting (readyState/__uiReady/__bootDone)');

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
  // page's GLOBAL scope — so every name this spec drives would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  await evaluate(cdp, INSTALL_TRACE);
  // ── the Devices panel is actually populated ─────────────────────────────
  const panelRows = await waitFor(cdp, `document.querySelectorAll('#devList .dev').length > 0`);
  if (!panelRows)
    console.log(
      `  (no device row appeared; #devList says ${JSON.stringify(await evaluate(cdp, `document.getElementById('devList').innerText.slice(0, 200)`))}; page errors so far: ${JSON.stringify(pageErrors.slice(0, 3))})`,
    );
  ok(panelRows, 'the Devices panel renders at least one device row in the DOM');

  const shape = await evaluate(
    cdp,
    `(() => {
        const r = document.querySelector('#devList .dev');
        if (!r) return null;
        return { id: r.dataset.id, hasChk: !!r.querySelector('.devchk'),
                 hasWk: !!r.querySelector('.wk') };
    })()`,
  );
  ok(shape && shape.id, 'the row carries its device id in the DOM');
  ok(shape && shape.hasChk, 'it has an enable checkbox');
  // 5.4.1 removed the per-device worker box: one replica per card is a constant now, because
  // a second worker on one card measured SLOWER (1.527x aggregate against 1.604x for one).
  // Asserted ABSENT rather than merely deleted from the spec — a control that quietly came
  // back would go on writing a `workers` the server no longer honors, and nothing else here
  // would notice.
  ok(shape && !shape.hasWk, 'and NO worker box — one replica per device is not a setting');

  // ── a change round-trips through the server ─────────────────────────────
  // The listener is delegated, so this is also the check that it is bound to a live element:
  // a stale binding leaves the box ticked on screen and nothing saved.
  const wasEnabled = await evaluate(cdp, `document.querySelector('#devList .dev .devchk').checked`);
  const mark1 = await traceMark(cdp);
  await evaluate(
    cdp,
    `(() => {
        const c = document.querySelector('#devList .dev .devchk');
        c.checked = !c.checked;
        c.dispatchEvent(new Event('change', {bubbles:true}));
    })()`,
  );
  // A card that was ticked (and so runs ACE-Step) is being unticked: the save waits for the confirm.
  if (wasEnabled) ok(await confirmStopAce(cdp), 'unticking a card that runs ACE-Step asks before stopping it, and Save and stop saves');
  const saved = await waitFor(cdp, `fetch('/devices').then(r=>r.json()).then(d=>d.devices[0].enabled === ${!wasEnabled})`);
  ok(saved, 'ticking a device persists to the server');

  const afterReload = await evaluate(
    cdp,
    `(async () => {
        const d = await (await fetch('/devices')).json();
        return d.devices[0].enabled;
    })()`,
  );
  ok(afterReload === !wasEnabled, 'and it is still there on the next read (it survives a reload)');
  // 🔴 THE FIRST SAVE IS FINISHED BEFORE THE REQUEST COUNT BELOW IS TAKEN. `saveDevices` asks
  // `/enhance/info` AFTER its PUT is answered, so a count taken as soon as the server holds the new
  // value can be overtaken by that first save's own ask, and "the page re-asked" would then be
  // satisfied by the wrong request.
  if (!(await awaitDeviceSave(cdp, mark1, 'the first tick'))) throw new Error('the first device save never finished cleanly');

  // ── the enhance gate re-asks after a device tick (7.2-m6) ──────────────
  //
  // `enhance_available()` requires an installed venv and a ticked local card. Re-fetch it after a
  // device change so availability updates without requiring a full page reload.
  //
  // ⚠️ THE ASSERTION IS "IT RE-ASKED", NOT "IT BECAME AVAILABLE", and that is deliberate.
  // Whether this box can actually enhance depends on a venv and on real CUDA cards, so asserting
  // the checkbox ENABLES would make the test pass or fail on the host's hardware — the exact
  // dependency `gpu_registry` is mocked to avoid. What went wrong was that the page never asked
  // the server again, and a request count is that failure, exactly.
  const asked = await evaluate(
    cdp,
    `(() => performance.getEntriesByType('resource')
        .filter(e => e.name.includes('/enhance/info')).length)()`,
  );
  const mark2 = await traceMark(cdp);
  const tickedNow = await evaluate(
    cdp,
    `(() => {
        const c = document.querySelector('#devList .dev .devchk');
        c.checked = !c.checked;
        c.dispatchEvent(new Event('change', {bubbles:true}));
        return c.checked;
    })()`,
  );
  // This toggle UNticks when the first one re-ticked it; answer the ACE-Step confirm then too.
  if (!tickedNow) ok(await confirmStopAce(cdp), 'and unticking it again asks again, rather than assuming the first answer');
  ok(
    await waitFor(
      cdp,
      `performance.getEntriesByType('resource')
        .filter(e => e.name.includes('/enhance/info')).length > ${asked}`,
    ),
    'ticking a device makes the page re-ask whether enhancement is available',
  );
  // And the control's disabled state agrees with the answer that came back, in both directions —
  // this is what was stuck on screen while the server had already changed its mind.
  //
  // 🔴 AFTER THE SAVE IS FINISHED AND ASKED WITH A WAIT. The resource-timing entry above exists as
  // soon as the response ARRIVES, before `loadEnhanceInfo` has stored `enh.ok` and set the control,
  // so reading the two at that moment could catch them between the answer and the repaint. A state
  // that is stuck still never agrees and fails when the deadline passes; one that is merely about to
  // agree is no longer read too early.
  if (!(await awaitDeviceSave(cdp, mark2, 'the second tick'))) throw new Error('the second device save never finished cleanly');
  const agrees = await waitFor(cdp, `document.getElementById('bkEnh').disabled === !enh.ok`);
  ok(agrees, 'and Enhance every chapter tracks that answer instead of its boot-time value');

  // ── adding a satellite, in the page, shows the secret once ──────────────
  await evaluate(
    cdp,
    `(() => {
        document.getElementById('satName').value = 'test-satellite';
        document.getElementById('satUrl').value = 'https://test-satellite.invalid:7880';
        document.getElementById('satAdd').click();
    })()`,
  );
  ok(
    await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`),
    'adding a satellite opens the one-time secret modal',
  );

  const secret = await evaluate(cdp, `(document.querySelector('#mBody input') || {}).value || ''`);
  ok(/^[0-9a-f]{64}$/.test(secret), 'the modal shows a 64-hex-character secret');

  // 🔴 The one-time contract, asked of the page rather than of the route. Dismiss the modal,
  // then reload the panel: if the secret can come back, it is in the DOM on every settings
  // read and in whatever the browser decides to remember.
  await evaluate(cdp, `[...document.querySelectorAll('#mActs button')].pop().click()`);
  // 🔴 THE DIALOG CLOSING, NOT ITS BUTTONS LEAVING THE DOM. This waited for `#mActs` to hold no
  // button, which never happens: `modal()` empties that row only when the NEXT dialog opens, so the
  // wait always ran out its deadline (8 s) and its result was ignored. It was a sleep in disguise;
  // with a longer deadline it became a 60 s stall, which is how it was found (2026-10-12).
  if (!(await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`)))
    throw new Error('the one-time secret dialog never closed');
  const leaked = await evaluate(
    cdp,
    `(async () => {
        const body = await (await fetch('/devices')).text();
        return body.includes(${JSON.stringify(secret)}) ||
               document.body.innerHTML.includes(${JSON.stringify(secret)});
    })()`,
  );
  ok(leaked === false, 'and the secret appears nowhere afterward — not in the page, not in /devices');

  // ── the satellite renders as down, with its cards absent but explained ──
  // 🔴 30s, NOT THE 20s DEFAULT, AND THE NUMBER IS DERIVED RATHER THAN GUESSED. `renderSats`
  // only runs from `loadDevices`, which the add handler does call — but `loadDevices` early-
  // returns while `devBusy` is set, so an add landing during an in-flight poll is SWALLOWED and
  // the row waits for the next tick of `setInterval(loadDevices, 10000)`. Worst case is
  // therefore two poll periods plus the route's health check of every satellite, which is
  // already past a 20s budget before the machine is loaded at all.
  //
  // ⚠️ IT PRESENTS AS AN ENVIRONMENT FLAKE, WHICH IS WHY IT SURVIVED: 3/3 green alone in 15s,
  // and intermittently red in a 16-worker suite — where the two checks after it fail too, since
  // both read fields off the row this one waits for. Raising the deadline weakens nothing; the
  // assertion is unchanged and still fails if the row never arrives.
  // (2026-10-12: the explicit 30 s is gone; the default is 60 s now, so this has more than the
  // derived minimum above.)
  ok(await waitFor(cdp, `document.querySelectorAll('#satList .satrow').length === 1`), 'the new satellite appears in the Satellites panel');
  const satText = await evaluate(cdp, `document.getElementById('satList').innerText`);
  ok(/not running/i.test(satText), 'a satellite that is not running says so rather than vanishing');
  ok(/not pinned/i.test(satText), '🔴 an https satellite with no certificate reads as NOT pinned — never as secure');

  // ── October 11, 2026: the satellite's name is the brightest text in its row, in BOTH themes ──
  // Doug found the whole first line grey. Cause: `#satList` is `class="small muted"` and `color`
  // inherits, so every unclassed piece of the row was `--mut`. This reads COMPUTED colors from the
  // laid-out page, in the dark theme (his screenshot) and the light one, because the inherited-color
  // cause is the same in both and a rule that fixes one theme only is the usual way this regresses.
  // The "theme's normal text color" is `body`'s computed color (`color:var(--fg)`), not a literal,
  // so the check follows the theme variables rather than a hard-coded white.
  for (const theme of ['dark', 'light']) {
    const c = await evaluate(
      cdp,
      `(() => {
          document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
          const cs = (el) => getComputedStyle(el).color;
          const probe = (v) => { const p = document.createElement('span'); p.style.color = 'var(' + v + ')';
                                 document.body.appendChild(p); const r = cs(p); p.remove(); return r; };
          const lum = (rgb) => { const m = rgb.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => {
                                   v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
                                 return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
          const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
          const row = document.querySelector('#satList .satrow');
          const first = row.firstElementChild, second = first.nextElementSibling;
          const name = first.querySelector('b'), url = first.querySelector('.muted');
          const spans = [...first.querySelectorAll('span')];
          const panelBg = getComputedStyle(document.getElementById('satList').closest('.panel')).backgroundColor;
          const err = second.querySelector('.warn');
          const dlab = document.querySelector('#devList .dev .dlab');
          return { fg: cs(document.body), mut: probe('--mut'), warn: probe('--warn'),
                   name: cs(name), nameWeight: Number(getComputedStyle(name).fontWeight),
                   nameText: name.textContent, url: cs(url), urlContrast: contrast(cs(url), panelBg),
                   stateTexts: spans.filter(s => /running|pinned/.test(s.textContent)).map(s => [s.textContent, cs(s)]),
                   secondLine: cs(second), errText: err ? err.textContent : null, errColor: err ? cs(err) : null,
                   dlab: dlab ? cs(dlab) : null };
      })()`,
    );
    ok(c.name === c.fg, `[${theme}] the satellite name is the theme's normal text color (${c.name} vs fg ${c.fg})`);
    ok(c.name !== c.mut, `[${theme}] and it is NOT the muted color (${c.mut})`);
    ok(c.nameWeight >= 600, `[${theme}] and it is bold (weight ${c.nameWeight})`);
    ok(c.urlContrast >= 4.5, `[${theme}] the secondary URL still reads: contrast ${c.urlContrast.toFixed(2)} against the panel`);
    ok(
      c.stateTexts.length >= 2 && c.stateTexts.every(([, col]) => col !== c.mut),
      `[${theme}] the state words (not running / not pinned) are not muted: ${JSON.stringify(c.stateTexts)}`,
    );
    ok(c.secondLine === c.mut, `[${theme}] the second line (secret, certificate) stays secondary`);
    ok(
      c.errText && c.errColor === c.warn,
      `[${theme}] the unreachable message "${c.errText}" uses the warning color (${c.errColor} vs ${c.warn})`,
    );
    ok(c.dlab === c.fg, `[${theme}] the local device label is the normal text color, not inherited muted (${c.dlab} vs ${c.fg})`);
  }
  await evaluate(cdp, `document.documentElement.setAttribute('data-theme', 'dark')`);

  // ── 11.2: the SillyTavern batch box, typed into and saved, in a real page ──
  //
  // Browser coverage verifies the delegated Save handler updates the server-backed field after
  // the row is re-rendered by polling; markup-only checks cannot prove that event path.
  ok(
    await evaluate(cdp, `document.querySelector('#satList .satStBatch').value === '1'`),
    'the SillyTavern batch box starts at 1 — the configured default',
  );
  await evaluate(
    cdp,
    `(() => {
        const b = document.querySelector('#satList .satStBatch');
        b.value = '4';
        document.querySelector('#satList .satStBatchSave').click();
    })()`,
  );
  // 30s for the same reason the row wait above uses it: the save reloads the panel, and that
  // reload health-probes a satellite that is not running. (Now the 60 s default; see above.)
  ok(
    await waitFor(cdp, `fetch('/devices').then(r=>r.json()).then(d=>d.satellites[0].st_max_batch === 4)`),
    'typing a batch size and pressing Save reaches the server',
  );
  ok(
    await waitFor(cdp, `document.querySelector('#satList .satStBatch') && document.querySelector('#satList .satStBatch').value === '4'`),
    'and the row comes back showing it, rather than snapping back to the default',
  );
  // 🔴 AND A REFUSED VALUE SAYS SO, rather than saving something else. 0 is the interesting one:
  // it is the value a person types meaning "off", and off is 1 here.
  //
  // October 11, 2026: wait for the Save button to be live again first. The wait above is satisfied by
  // the value the spec TYPED (the box still holds '4' before the reload redraws it), so on a slow
  // run this block could type '0' and click the previous save's still-disabled "Saving…" button,
  // which does nothing, and the refusal never appeared (one failure in five runs of the unchanged
  // code path while this file was being edited; passed alone on every rerun).
  await waitFor(cdp, `!document.querySelector('#satList .satStBatchSave').disabled`);
  await evaluate(
    cdp,
    `(() => {
        const b = document.querySelector('#satList .satStBatch');
        b.value = '0';
        document.querySelector('#satList .satStBatchSave').click();
    })()`,
  );
  ok(
    await waitFor(
      cdp,
      `document.getElementById('satErr').style.display === '' && /batch/i.test(document.getElementById('satErr').textContent)`,
    ),
    'a batch size of 0 is refused ON SCREEN, naming the setting',
  );
  ok(
    await evaluate(cdp, `fetch('/devices').then(r=>r.json()).then(d=>d.satellites[0].st_max_batch === 4)`),
    '…and the saved number is untouched by the refusal',
  );

  // ── the label column is sized to the text, not to the panel ────────────
  // Geometry is the whole point of this check and the reason it cannot live in the markup
  // smoke test: `flex:1` on the label is a perfectly reasonable-looking declaration that
  // strands everything after it half a panel away from the name it belongs to. Only a
  // laid-out page knows where it ended up. Since 5.4.1 removed the worker box, what the
  // column now positions is the drift note and the ⟳ button — the failure mode is the same
  // one, so the check stays and measures the label column itself.
  // ⚠️ The panel must be OPEN first — inside `display:none` every rectangle is zero and every
  // assertion below would pass vacuously.
  await evaluate(cdp, `switchTab('settings')`);
  await waitFor(cdp, `document.getElementById('devList').getBoundingClientRect().width > 0`);
  const geo = await evaluate(
    cdp,
    `(() => {
        const list = document.getElementById('devList');
        const lr = list.getBoundingClientRect();
        // A Range measures the TEXT, not the box holding it. scrollWidth would report the
        // padded column width for every row and the slack would look like 18px even if the
        // column were three times too wide.
        const rng = document.createRange();
        return { width: lr.width, rows: [...list.querySelectorAll('.dev')].map(r => {
            const lab = r.querySelector('.dlab');
            rng.selectNodeContents(lab);
            const text = rng.getBoundingClientRect();
            const box = lab.getBoundingClientRect();
            return { slack: box.right - text.right, labRight: Math.round(box.right),
                     leftOver: lr.right - box.right };
        })};
    })()`,
  );
  ok(geo.width > 200 && geo.rows.length > 0, 'the Devices panel is laid out and measurable');
  ok(
    geo.rows.every(r => r.slack >= 0),
    'no label is clipped by its own column',
  );
  ok(Math.min(...geo.rows.map(r => r.slack)) <= 40, 'the column ends just past the longest label — a little white space, not an inch');
  ok(
    geo.rows.every(r => r.leftOver > 60),
    'and it is NOT stretched to the right edge of the panel',
  );
  ok(new Set(geo.rows.map(r => r.labRight)).size === 1, 'every row ends its label column in the same place');

  // ── the column must not CREEP wider on every render ─────────────────────
  // 🔴 The `removeProperty` before measuring is what stops it: scrollWidth reports the
  // element's own width once that exceeds the text, so measuring while the last value is
  // still applied re-reports it. Two renders were not enough to see it — the arithmetic is
  // +18px a pass, and the existing `gap <= 40` check passes at 36. Three renders is where it
  // shows, and with a 10-second poll running, three is a quiet afternoon.
  const creep = await evaluate(
    cdp,
    `(() => {
        const list = document.getElementById('devList');
        const w = () => parseFloat(getComputedStyle(list).getPropertyValue('--dlabw')) || 0;
        renderDevices(); const a = w();
        renderDevices(); renderDevices(); const b = w();
        return { a, b };
    })()`,
  );
  ok(creep.a > 0 && creep.b === creep.a, `the label column is stable across renders (${creep.a} -> ${creep.b})`);

  // ── a poll must not destroy the row the user is interacting with ───────
  // 🔴 renderDevices() replaces the whole list and runs from a 10-second timer. With a
  // satellite that is down each poll holds ~5 s of that window, so the moment it lands is
  // unpredictable. 5.4.1 removed the worker box, which took the old guard with it (it tested
  // for a focused `.wk` that no longer exists) — so the unchanged-html short circuit is now
  // the WHOLE of the protection, and it is checked here rather than assumed: an identical
  // render must leave the very same DOM node in place, still focused.
  const kept = await evaluate(
    cdp,
    `(() => {
        const chk = document.querySelector('#devList .devchk');
        chk.focus();
        const before = document.querySelector('#devList .dev');
        renderDevices();                       // the poll, landing on unchanged data
        const after = document.querySelector('#devList .dev');
        return { sameNode: before === after,
                 stillFocused: document.activeElement === chk };
    })()`,
  );
  ok(kept.sameNode, 'an unchanged re-render leaves the existing rows in the DOM untouched');
  ok(kept.stillFocused, 'and focus stays on the control the user is using');

  // ── unticking the LAST card is allowed, and the click is not undone ─────
  // Unchecking the last enabled card releases the satellite's VRAM without stopping its server.
  // Verify the real page keeps the checkbox unticked; a DOM-only revert would not reach the route.
  const untick = await evaluate(
    cdp,
    `(async () => {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        // 🔴 THE 10 s POLL IS STOPPED FOR THE REST OF THIS SPEC (devPollStop, the page's own call).
        // Its GET can be answered from the file BEFORE a save in flight has written it and then
        // repaint the list over that save: the box this block is asserting on is put back to its
        // old state, and the next step finds nothing to do. Seen in llm_tick_warn_browser_spec.mjs
        // with a request trace (a poll GET served while the "Stop ACE-Step" PUT was out, 56 copies
        // at once); the poll's moment is not something this spec controls, and nothing below is
        // about the poll. The race is a product defect and is reported.
        devPollStop();
        await loadDevices({force:true});
        const boxes = [...document.querySelectorAll('#devList .devchk')];
        boxes.forEach(b => { b.checked = true; });
        boxes[0].dispatchEvent(new Event('change', {bubbles:true}));
        // 🔴 POLL, NEVER A FIXED SLEEP. 250 ms is plenty on an idle box and not reliably enough
        // under the full parallel suite — and if this save has not landed, the untick below
        // races it and the panel ends up in neither state.
        // These in-page loops step 100 ms and are bounded at 600 steps (60 s) - a bound on a hang,
        // not a duration. They were 40 steps (4 s), which a loaded machine can outlast.
        for (let i = 0; i < 600; i++) {
            const d = await (await fetch('/devices')).json();
            if (d.devices.every(x => x.enabled)) break;
            await new Promise(r => setTimeout(r, 100));
        }
        // …now take every last one off.
        boxes.forEach(b => { b.checked = false; });
        boxes[0].dispatchEvent(new Event('change', {bubbles:true}));
        // Docker edition: these cards run ACE-Step, so the save is first held behind the Stop ACE-Step
        // confirm (and only THEN raises the CPU-fallback notice this block goes on to assert). Answer it.
        let stopAsked = false;
        for (let i = 0; i < 600; i++) {
            const lit = document.getElementById('overlay').classList.contains('on');
            const stopBtn = [...document.querySelectorAll('#mActs button')].find(x => /Save and stop/.test(x.textContent));
            if (lit && stopBtn && /Stop ACE-Step/.test(document.getElementById('mTitle').textContent)) {
                stopAsked = true;
                stopBtn.click();
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        for (let i = 0; i < 600; i++) {
            await new Promise(r => setTimeout(r, 100));
            const d = await (await fetch('/devices')).json();
            if (d.devices.every(x => !x.enabled)) break;
        }
        // 🔴 THE SERVER AGREEING IS NOT THE CLIENT HAVING FINISHED, and that gap is this test's
        // flake. The warning text and the modal are raised by the save handler's own
        // continuation, which runs AFTER the response the loop above is watching for. So
        // serverAgrees goes true a tick before the overlay is lit, and reading the assertion
        // right here samples a page that is about to be correct — invisible on an idle box,
        // intermittent under sixteen workers. Wait for the thing being ASSERTED, not for its
        // precondition. Bounded, so a genuinely dead panel still fails instead of hanging.
        //
        // ⚠️ NO BACKTICKS ANYWHERE IN HERE. This whole block is inside a template literal, so
        // quoting an identifier the way the rest of the codebase does ends the string early and
        // node dies with "missing ) after argument list" before a single check runs.
        for (let i = 0; i < 600; i++) {
            const lit = document.getElementById('overlay').classList.contains('on');
            const warned = /nothing is ticked/i.test(document.getElementById('devList').innerText);
            if (lit && warned) break;
            await new Promise(r => setTimeout(r, 100));
        }
        const saved = await (await fetch('/devices')).json();
        const out = {
            serverAgrees: saved.devices.every(x => !x.enabled),
            stillUnticked: [...document.querySelectorAll('#devList .devchk')].every(b => !b.checked),
            warns: /nothing is ticked/i.test(document.getElementById('devList').innerText),
            told: document.getElementById('overlay').classList.contains('on'),
            stopAsked,
        };
        // Dismiss the "rendering on the CPU now" modal so it cannot sit over the later checks.
        const okBtn = [...document.querySelectorAll('#mActs button')].pop();
        if (okBtn) okBtn.click();
        return out;
    })()`,
  );
  ok(untick.stopAsked, 'unticking every card that runs ACE-Step asks "Stop ACE-Step on these cards?" first');
  ok(untick.serverAgrees, 'unticking every card is saved, not refused');
  ok(untick.stillUnticked, '🔴 and the checkbox stays off — his click is not reverted');
  ok(untick.warns, 'the panel says renders now fall back to the CPU');
  ok(untick.told, 'and he is told once, after the save — a warning, not a gate');

  // Put them back so the checks below run against a normal panel.
  //
  // THE SAVE IS WAITED FOR, NOT 300 ms. This was an in-page `setTimeout(r, 300)` after the click.
  // The block below replaces `window.fetch` with a stub, so a save still in flight when it starts
  // would have its `/enhance/info` ask answered by the stub, and its PUT could land among the
  // calls the ordering check reads. The save is over when its PUT and the ask after it were answered.
  const markBack = await traceMark(cdp);
  await evaluate(
    cdp,
    `(() => {
        const boxes = [...document.querySelectorAll('#devList .devchk')];
        boxes.forEach(b => { b.checked = true; });
        boxes[0].dispatchEvent(new Event('change', {bubbles:true}));
    })()`,
  );
  if (!(await awaitDeviceSave(cdp, markBack, 'putting the cards back')))
    throw new Error('the save that puts the cards back never finished cleanly');

  // ── ⟳ Reconnect, and the delegated listener actually bound to it ────────
  // 🔴 Only a real DOM can answer this. The button is rendered as a STRING by devRow and
  // reached by a delegated `closest('.devSync')` on a list that re-renders under it — the
  // exact combination this file exists for. A markup test would assert the string and learn
  // nothing about whether clicking does anything.
  //
  // The rows are injected because the spec's satellite is not running, so it contributes no
  // card rows at all — and the divergence this button fixes only exists on a card row.
  const sync = await evaluate(
    cdp,
    `(async () => {
        // Drop focus from the check above so nothing here depends on where it was left.
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        // No worker field on these rows: 5.4.1 made it one replica per enabled card, so a
        // ticked row expects exactly 1 and the loaded:0 below is a genuine divergence.
        // (No backticks in here -- this whole block is a template literal.)
        const rows = [
            {id:'cuda:0', label:'Test Card A', satellite:null, reachable:true,
             enabled:true, loaded:null},
            {id:'test-satellite:cuda:0', label:'satellite test-satellite', satellite:'test-satellite', reachable:true,
             enabled:true, loaded:0}];
        const sats = [{name:'test-satellite', url:'https://test-satellite.invalid:7880', reachable:true, ready:false,
                       loading:false, cert:'', secret_set:true, version:'1.1', verified:true}];
        devs.rows = rows; devs.sats = sats;
        const list = document.getElementById('devList');
        delete list.dataset.html;                 // the "unchanged, leave it" short circuit
        renderDevices();
        const local = document.querySelector('#devList .dev[data-id="cuda:0"]');
        const sat = document.querySelector('#devList .dev[data-id="test-satellite:cuda:0"]');
        const btn = sat && sat.querySelector('.devSync');
        const out = {onSatellite: !!btn, sat: btn && btn.dataset.sat,
                     onLocal: !!(local && local.querySelector('.devSync')),
                     drift: !!(sat && /0 loaded/.test(sat.innerText)),
                     localDrift: !!(local && /loaded/i.test(local.innerText))};
        if (!btn) return out;

        const realFetch = window.fetch, calls = [];
        const json = o => new Response(JSON.stringify(o),
                                      {headers:{'Content-Type':'application/json'}});
        window.fetch = (url, opts) => {
            const method = (opts && opts.method) || 'GET';
            calls.push(method + ' ' + String(url));
            if (String(url).indexOf('/reconnect') >= 0)
                return Promise.resolve(json({plan:{'test-satellite:cuda:0':2},
                                             loaded:{'cuda:0':2}, reachable:true}));
            if (String(url) === '/devices' && method === 'GET')
                return Promise.resolve(json({devices: rows, satellites: sats}));
            return Promise.resolve(json({ok:true}));
        };
        try {
            btn.click();
            // A bounded in-page loop on the thing waited for (the stubbed reconnect call being made),
            // stepping 50 ms. 600 steps (30 s) bound a hang; it was 80 (4 s).
            for (let i = 0; i < 600 && !calls.some(c => c.indexOf('/reconnect') >= 0); i++)
                await new Promise(r => setTimeout(r, 50));
        } finally { window.fetch = realFetch; }
        out.calls = calls;
        return out;
    })()`,
  );
  ok(sync.onSatellite, 'a satellite card row carries a ⟳ reconnect button');
  ok(sync.sat === 'test-satellite', 'and it names the satellite it acts on');
  ok(sync.onLocal === false, 'a local card has none — there is no other machine to get back in step with');
  ok(sync.drift, 'a ticked satellite card holding NO model says so on the row');
  ok(sync.localDrift === false, 'and a local card says nothing about loaded counts');
  const calls = sync.calls || [];
  ok(
    calls.some(c => c === 'POST /satellites/test-satellite/reconnect'),
    `clicking ⟳ posts the reconnect (saw: ${calls.join(', ') || 'nothing'})`,
  );
  // 🔴 Ordering, not just presence. The route applies what is SAVED, and `devReconnect`
  // awaits `saveDevices()` before posting. If the reconnect could overtake that PUT the
  // satellite would be told the PREVIOUS selection, which is the same silent divergence the
  // button exists to end. (Pre-5.4.1 the PUT came from the worker box's blur; now it is an
  // explicit await, so this check is what holds that contract in place.)
  const put = calls.findIndex(c => c.startsWith('PUT /devices'));
  const post = calls.findIndex(c => c === 'POST /satellites/test-satellite/reconnect');
  ok(put >= 0 && post > put, `the panel is saved BEFORE the reconnect is sent (${calls.join(', ')})`);

  ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join(' | ') || 'none'})`);

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} check(s) failed` : '\nall device panel browser checks passed');
} catch (e) {
  console.error(`spec error: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

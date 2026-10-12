// Vocalis 7.2-m3 — the ⚙ Settings ▸ Appearance text-size slider, in a REAL browser.
//
// Browser geometry verifies the text-size setting's visible effect. Markup and route tests can
// pass while rendered text remains unchanged, so measure the actual text on screen.
//
// So every check here reads a COMPUTED pixel size off a real rendered element, never the CSS
// source and never the input's value. `getComputedStyle` is the only witness that cannot be
// fooled by a rule that is present but overridden, a listener bound to a stale id, or a
// variable set on the wrong node.
//
// Usage: node ui_font_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node ui_font_browser_spec.mjs <base-url> <chrome-path>');
  process.exit(2);
}

let failed = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) failed++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let msgId = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const ready = new Promise(res => {
    ws.addEventListener('open', res);
  });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return {
    ws,
    ready,
    send(method, params = {}) {
      const id = ++msgId;
      return new Promise(res => {
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

// 🔴 `Promise.resolve(...).then(v => !!v)`, NOT `!!(...)` — 7.3-m12b, AND THIS ONE LINE IS WHY THIS
// FILE HAS A THREE-ATTEMPT RETRY LOOP AND A DOCUMENTED "PARKED TIMING RACE" THAT DOES NOT EXIST.
//
// `evaluate` passes `awaitPromise: true`, which awaits the value the EXPRESSION produces. The
// expression was `!!(<expr>)` — and `!!` of a pending Promise is `true`, computed synchronously,
// before anything is awaited. So **every `waitFor` given a promise-valued condition returned true
// on its first poll, having tested nothing.** There is exactly one such caller and it is the one
// that mattered:
//
//     waitFor(cdp, `fetch('/settings/app').then(r => r.json()).then(j => j.ui_font_px === 20)`)
//     → ok   and persisted to the server, not just this browser        ← vacuous since it was written
//
// ⚠️ AND IT DID NOT MERELY FAIL TO CHECK — IT CAUSED THE FAILURE IT WAS HIDING. The PUT behind that
// assertion is debounced by 250ms (`uiFontApply`). Returning instantly meant the spec ran
// `Page.navigate` a few milliseconds later, which discards the pending timer, so **the server never
// received the value at all**: `app_settings.yaml` did not exist on disk at the end of a full run.
// The reload then correctly restored the server's 16, and the "slider catches up to 20" check was
// only ever passing on a TRANSIENT — the parse-time cache sync set 20, and boot's
// `loadAppSettings()` reverted it to 16 a few hundred ms later. 7.3-m12b moved that sync into a
// module, which collapsed the transient, and the check went red every time.
//
// 📌 THE HEADER OF `test_ui_font_browser.py` DIAGNOSED THIS AS "the server loses the write", under a
// lost-update race in `PUT /settings/app`. It is a real hazard and it is not what was happening: the
// write was never SENT. The evidence that separates them is the same in both worlds — `server=16` —
// which is why the wrong diagnosis survived two sessions. What settled it was dumping the file.
async function waitFor(cdp, expression, timeoutMs = 20000) {
  let lastThrow = null;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED". `evaluate` turns a page exception
    // into a thrown Error, so an unguarded wait whose expression touches a node is a race:
    // the first poll landing mid-repaint kills the spec, and it presents as a flake because
    // the window is narrow. Proved by mutation on 2026-08-20, both arms.
    // ⚠️ Remembered, not swallowed - a typo in an expression throws on every poll and would
    // otherwise just time out saying nothing about why.
    try {
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`)) return true;
      lastThrow = null;
    } catch (err) {
      lastThrow = err && err.message ? err.message : String(err);
    }
    await sleep(120);
  }
  if (lastThrow) console.log(`  (wait gave up; last page exception: ${lastThrow})`);
  return false;
}

/** The computed font-size of an element, in px, as a number. THE witness for this whole file.
 *
 * ⚠️ RETURNS null FOR A MISSING ELEMENT rather than letting `getComputedStyle(null)` throw. The
 * raw version aborted the whole spec with *"parameter 1 is not of type 'Element'"* and a stack
 * pointing at `<anonymous>:1:12` — which named neither the selector nor the check. Every caller
 * compares against a number, so null fails its own assertion with the selector in the message.
 */
const sizeOf = (cdp, sel) =>
  evaluate(
    cdp,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)});
              return el ? parseFloat(getComputedStyle(el).fontSize) : null; })()`,
  );

const profile = await mkdtemp(join(tmpdir(), 'vocalis-uifont-cdp-'));
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
  if (!(await waitFor(cdp, `document.querySelector('#uiFont')`))) throw new Error('the Appearance panel never rendered');
  // ⚠️ `readyState === 'complete'` GOES FIRST, and `uiFontApply` alone is not enough. It is an
  // inline declaration, so it exists as soon as the classic script parses — before the
  // `<script type="module">` shim has fetched its modules and run its `Object.assign`. The
  // `.ulab` sensor row this spec measures is rendered by `loadDevices()`, which became a
  // js/sys/devices.js export in 7.3-m4, so without this the check below can reach a page where
  // the function it depends on is not on `window` yet. This spec passed on timing luck the day
  // that landed; clips_favorites_browser_spec.mjs, gated the same way, did not.
  await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`);

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
  // page's GLOBAL scope — so every name this spec drives would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  // 🔴 WAIT FOR THE PAGE TO FINISH BOOTING, DELIBERATELY, BEFORE MEASURING ANYTHING.
  // `#uiFont` is static markup and exists the moment the body parses — it says nothing about
  // whether the async boot has run. Two separate flakes came out of measuring too early:
  //
  //   · `.ulab` (the sensor row) is rendered by `loadDevices()`, so the floor checks below hit
  //     a null element and reported "nullpx" on a slow round.
  //   · `loadAppSettings()` applies the stored size when it lands; a drag performed before that
  //     was silently undone by it.
  //
  // ⚠️ AWAITED, NOT SLEPT. `loadAppSettings` returns a promise and `evaluate` awaits it, so this
  // is a fact about the page rather than a guess about how long the box takes.
  await evaluate(cdp, `loadAppSettings()`);
  if (!(await waitFor(cdp, `document.querySelector('.ulab')`)))
    throw new Error(
      'the device rows never rendered — the sensor-row floor checks would be ' +
        'vacuous, and gpu_registry is meant to be mocked for this spec',
    );

  // ── the baseline ────────────────────────────────────────────────────────
  // 🔴 16, MEASURED. This is the assertion that would have caught "looks the same" being a
  // real regression rather than a subtle change — it reads the rendered body, so a --fs that
  // never reaches the page fails here regardless of what the stylesheet says.
  const base = await sizeOf(cdp, 'body');
  ok(Math.abs(base - 16) < 0.5, `the page renders at the 16px base (measured ${base}px)`);

  // `font:inherit` keeps form controls at the same size as the surrounding text. Verify the
  // editable description field as well as the page chrome.
  const ta = await sizeOf(cdp, '#vcPrompt');
  ok(Math.abs(ta - base) < 0.5, `the Description box matches the page base size (${ta}px)`);

  // ── a drag is never undone by a settings response still in flight ───────
  // 🔴 THIS IS AN ASSERTION, NOT SETUP. `loadAppSettings()` applies the server's value when it
  // lands; if that lands after a drag it would snap the size back. The spec used to hit this
  // by accident — the drag checks failed intermittently depending on which won — so it now
  // provokes the race on purpose: set the size, THEN replay a late settings response, and
  // require the drag to survive it.
  await evaluate(
    cdp,
    `(() => { const s = $('uiFont'); s.value = 22;
        s.dispatchEvent(new Event('input', {bubbles:true})); })()`,
  );
  await evaluate(cdp, `loadAppSettings()`); // the stale response, arriving late
  await waitFor(cdp, `Math.abs(parseFloat(getComputedStyle(document.body).fontSize) - 22) < 0.5`, 8000);
  const big = await sizeOf(cdp, 'body');
  ok(Math.abs(big - 22) < 0.5, `dragging to 22 makes the page 22px (measured ${big}px)`);
  const taBig = await sizeOf(cdp, '#vcPrompt');
  ok(Math.abs(taBig - 22) < 0.5, `and the text boxes come with it (${taBig}px)`);
  ok((await evaluate(cdp, `$('uiFontOut').textContent`)) === '22 px', 'the readout says 22 px');

  // ── the sensor row's FLOOR, which is the one thing that must NOT track downward ─────────
  // `max(0.75rem,12px)`. At 22px base it scales UP with everything else; at 12px base it
  // must refuse to go below 12. A plain factor would keep it proportionally tiny forever,
  // which is the 7.5pt defect this milestone exists to end.
  const sensorBig = await sizeOf(cdp, '.ulab');
  ok(sensorBig > 12.5, `the sensor row scales UP with the base (${sensorBig}px at 22px base)`);

  await evaluate(
    cdp,
    `(() => { const s = $('uiFont'); s.value = 12;
        s.dispatchEvent(new Event('input', {bubbles:true})); })()`,
  );
  await waitFor(cdp, `Math.abs(parseFloat(getComputedStyle(document.body).fontSize) - 12) < 0.5`, 8000);
  const sensorSmall = await sizeOf(cdp, '.ulab');
  ok(Math.abs(sensorSmall - 12) < 0.5, `and FLOORS at 12px when the base goes to its minimum (${sensorSmall}px) — never 7.5pt again`);

  // ── it survives a reload, BEFORE FIRST PAINT ────────────────────────────
  // 🔴 The pre-paint <head> script is the reason this is not a flash-then-jump. Measured
  // immediately on load rather than after the settings fetch: if only loadAppSettings applied
  // it, the page would paint at 16 and lurch, and this check would still pass — so it also
  // asserts the value came from localStorage, which is what the head script reads.
  await evaluate(
    cdp,
    `(() => { const s = $('uiFont'); s.value = 20;
        s.dispatchEvent(new Event('input', {bubbles:true})); })()`,
  );
  // The local cache is written synchronously, so it is true immediately.
  ok((await evaluate(cdp, `localStorage.getItem('vocalis-ui-font')`)) === '20', 'the choice is cached locally for the pre-paint script');

  // 🔴 THE SERVER MUST HAVE IT TOO, and this is asked SEPARATELY from the reload check
  // below. localStorage alone would satisfy "it survives a reload" while silently failing the
  // thing the server copy is FOR: a new browser profile, a second machine, a cleared cache.
  // The first version of this spec conflated the two and would have passed on the local cache
  // alone.
  //
  // ⚠️ POLLED, NOT SLEPT. The PUT is debounced by 250ms (one drag must not fire thirty writes
  // at a load→mutate→save route), so any fixed sleep here is either a race or a guess that
  // rots the moment the debounce changes. `waitFor` states the condition instead.
  //
  // 🔴 AND UNTIL 7.3-m12b THIS LINE CHECKED NOTHING — see the note on `waitFor`. Its condition is
  // a Promise, the old implementation tested `!!(<promise>)`, and that is `true` synchronously.
  // The assertion passed on its first poll without ever reading a response; worse, returning
  // instantly is what let `Page.navigate` below discard the pending 250ms debounce, so the PUT
  // this line claims to verify was never sent at all. **This is now the line that WAITS for the
  // write**, which is also what makes the reload measurement below mean anything.
  ok(
    // The 20 s is only the bound on a hang (it was 5 s): the debounce is 250 ms, but under load the
    // PUT can be sent later than that, and what this waits for is the server holding the value.
    await waitFor(cdp, `fetch('/settings/app').then(r => r.json()).then(j => j.ui_font_px === 20)`, 20000),
    'and persisted to the server, not just this browser',
  );

  // 🔴 STAMP THE OUTGOING DOCUMENT (7.3-m12b) — `#uiFont` is in the markup of the page we are
  // LEAVING, so `waitFor(document.querySelector('#uiFont'))` was satisfied by the old document
  // and every measurement below could be taken before the new one had committed. That is
  // §11.22's `clips_favorites` bug verbatim, which gated a reload on `readyState === 'complete'`
  // — a condition the OUTGOING document also satisfies. A reload builds a fresh global, so the
  // stamp cannot survive it; property access on `window` never throws, so this is safe to poll
  // against either context.
  await evaluate(cdp, `window.__preReload = 1`);
  await cdp.send('Page.navigate', { url: baseUrl });
  await waitFor(cdp, `!window.__preReload && document.querySelector('#uiFont')`);
  // 🔴 RE-PUBLISH AFTER A RELOAD — 7.3-m13. A reload builds a FRESH global object, so everything
  // the harness put on `window` before the navigation is gone with the old document. That is the
  // same fact the `__preReload` stamp above relies on, used in the other direction, and forgetting
  // it costs a `ReferenceError: $ is not defined` several assertions later rather than here.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  const afterReload = await sizeOf(cdp, 'body');
  // ⚠️ REPORT THE THREE INPUTS, NOT JUST THE OUTCOME. "it survives a reload (16px)" names the
  // symptom and nothing else, and there are three independent ways to get it: the local cache
  // was swept, the server never received the value, or the pre-paint script did not run. Each
  // needs a different fix, and guessing between them cost a round of this spec.
  const why = await evaluate(
    cdp,
    `(() => ({
        cached: localStorage.getItem('vocalis-ui-font'),
        rootVar: document.documentElement.style.getPropertyValue('--fs'),
    }))()`,
  );
  const served = await evaluate(cdp, `fetch('/settings/app').then(r => r.json()).then(j => j.ui_font_px).catch(e => 'ERR')`);
  ok(
    Math.abs(afterReload - 20) < 0.5,
    `it survives a reload (${afterReload}px; cache=${why?.cached}, ` + `--fs=${why?.rootVar || 'unset'}, server=${served})`,
  );
  // 🔴 THE READINESS GATE THAT LINE 139 APPLIES TO THE FIRST LOAD AND THIS PATH NEVER HAD
  // (added 7.3-m12b). `#uiFont` is static markup, so the `waitFor` above returns the instant the
  // body parses — thousands of lines before the `<script type="module">` shim has fetched ~58
  // modules and run its `Object.assign`. That was survivable only because `uiFontApply` used to
  // be an INLINE declaration that existed at parse time; m12b moved it into js/ui/theme.js, so
  // the control sync now happens at module-eval, and this gate is the difference between
  // measuring "does the control catch up" and measuring "did the module graph finish in 5s".
  //
  // ⚠️ §11.6 ITEM 3 / §11.18 FOR THE THIRD TIME, AND IT PRESENTED AS A FLAKE: this batch failed
  // 3/3 attempts on a loaded box and passed twice on a quiet one, minutes apart. A gate that
  // opens before the shim publishes does not fail — it fails LATER, somewhere else, sometimes.
  // ⚠️ THE STAMP IS IN THIS CONDITION TOO, for the same reason it is in the one above: without it
  // the OUTGOING document — which has a complete readyState and a published `uiFontApply` —
  // satisfies this instantly and the gate measures nothing.
  const tLive = Date.now();
  const live = await waitFor(
    cdp,
    `!window.__preReload && document.readyState === 'complete' ` + `&& window.__uiReady === true && window.__bootDone === true`,
    20000,
  );
  ok(live, `the module graph is live after the reload (${Date.now() - tLive}ms)`);

  // ⚠️ WAIT, do not sample. The pre-paint script sets `--fs` before the DOM exists, so it
  // cannot touch the slider; the slider is reconciled by js/ui/theme.js's cache sync at
  // module-eval and again by loadAppSettings() when the settings fetch lands. Reading it
  // immediately after the element appears is a race, and it is the race this spec hit on its
  // first run — the page was already 20px while the control still read 16. That is a genuine
  // (if brief) wrong-looking UI, so the wait is bounded and short rather than generous.
  //
  // 📌 THE 5s IS MEASURED FROM A LIVE MODULE GRAPH, NOT FROM `Page.navigate`, and the gate above
  // is what makes that true — which is why this bound did not have to GROW when m12b moved the
  // sync out of the page. Growing it would have hidden the thing it exists to measure. The
  // elapsed time is printed so a window that really is widening shows up as a number creeping
  // toward the bound instead of as an intermittent red.
  const tSync = Date.now();
  ok(
    await waitFor(cdp, `$('uiFont').value === '20'`, 5000),
    `and the slider catches up to show where it is (ended at ` +
      `${await evaluate(cdp, `$('uiFont').value`)}, ${Date.now() - tSync}ms after the modules ` +
      `went live)`,
  );

  // ── reset ───────────────────────────────────────────────────────────────
  await evaluate(cdp, `$('uiFontReset').click()`);
  await waitFor(cdp, `Math.abs(parseFloat(getComputedStyle(document.body).fontSize) - 16) < 0.5`, 8000);
  const reset = await sizeOf(cdp, 'body');
  ok(Math.abs(reset - 16) < 0.5, `Reset returns to the 16px default (${reset}px)`);

  ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join(' | ') || 'none'})`);

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} check(s) failed` : '\nall text-size browser checks passed');
} catch (e) {
  console.error(`spec error: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

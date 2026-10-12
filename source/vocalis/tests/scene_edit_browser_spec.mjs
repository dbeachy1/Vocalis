// Vocalis 6.1-m1b — copy a clip, stage it over a line, Apply. In a REAL browser.
//
// Browser coverage for copying a clip into a scene line, selecting a replacement clip,
// and applying the edit through the actual page controls.
// 🔴 Everything here is driven through the actual controls — the Copy button in the Playground
// library, the Chapters button, the ⇄ in the chapter row, the confirm modal, Apply. Nothing calls
// scStage() or scApplyEdits() directly. The seam between "the renderer is right" and "the verb is
// right" is where all four of 6.0's defects lived, and calling the functions directly would skip
// exactly that seam.
//
// Usage: node scene_edit_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node scene_edit_browser_spec.mjs <base-url> <chrome-path>');
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

async function waitFor(cdp, expression, timeoutMs = 30000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // 🔴 `Promise.resolve(...)` IS THE WHOLE FIX. This was `!!(${expression})`, and when the
    // expression is a promise — every `fetch(...).then(...)` poll in these specs — `!!aPromise`
    // is `true` SYNCHRONOUSLY AND ALWAYS, whatever it resolves to. `evaluate` then awaited a
    // bare `true`. So the wait returned on its first poll every time and waited for nothing.
    //
    // ⚠️ IT FAILS AS A PASS, WHICH IS WHY IT SURVIVED. A broken wait does not hang, it races —
    // green on a fast run and red under load, which can resemble an environment flake. A stronger
    // condition cannot repair a wait that returns before its promise settles.
    // 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED". `evaluate` turns a page exception into
    // a thrown Error, so before this guard any wait whose expression dereferenced a node was a
    // race rather than a wait - the FIRST poll landing mid-repaint killed the spec. The wait is
    // FOR the repaint, so polling during it is expected; transient exceptions are retried.
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

/** Click the modal's primary confirmation button to exercise the staged edit workflow. */
const confirmModal = cdp =>
  evaluate(
    cdp,
    `(() => {
    const b = [...document.querySelectorAll('#mActs button')].find(x => x.className === 'primary');
    if (!b) return false;
    b.click();
    return true;
})()`,
  );

const profile = await mkdtemp(join(tmpdir(), 'vocalis-edit-cdp-'));
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
    '--autoplay-policy=no-user-gesture-required',
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
  // Windows may retain handles briefly after the exit event, so cleanup retries profile removal.
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

const openClips = `(() => {
    document.querySelector('#tabs button[data-tab="sillytavern"]').click();
    document.querySelector('#stTabs button[data-sttab="clips"]').click();
})()`;

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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const pageErrors = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    }
  });

  await cdp.send('Page.navigate', { url: baseUrl });
  // 🔴 `window.__uiReady` AS WELL AS `readyState` — 7.3-m2b. This spec clicks a real `#tabs`
  // button, and that listener parks the click in `window.__pendingTab` until js/main.js's module
  // body sets `__uiReady` (§11.6 item 3). Gate on `readyState` alone and the click is swallowed:
  // the tab never opens, the section stays hidden, and the failure reads as a layout bug.
  // clips_chapters_browser_spec.mjs has the full account — it flaked this way three times.
  await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`);

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
  // page's GLOBAL scope — so every name this spec drives would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  // ── the scene is listed, and its chapters open ──────────────────────────
  await evaluate(cdp, openClips);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#scList button[data-act="chapters"]').length > 0`),
    'the Clips tab lists the seeded scene',
  );

  await evaluate(cdp, `document.querySelector('#scList button[data-act="chapters"]').click()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#scList tr.scDet a[data-seek]').length === 3`),
    'its chapters open, one row per message',
  );

  // 🔴 Before anything is copied there is nothing to paste, and offering the buttons anyway
  // would be a control that cannot work.
  ok(
    await evaluate(cdp, `!document.querySelector('#scList tr.scDet button[data-paste]')`),
    'the paste buttons appear only once a clip is copied — precondition: none yet',
  );

  // ── copy a Playground clip, through the button in the library ───────────
  await evaluate(cdp, `document.querySelector('#tabs button[data-tab="playground"]').click()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#pgLib button[data-copyclip]').length > 0`),
    'the Playground library lists the clip, with a Copy button on it',
  );
  await evaluate(cdp, `document.querySelector('#pgLib button[data-copyclip]').click()`);
  // The confirmation has to be where he pressed the button — the Clips tab's own clipboard bar
  // is two tab switches away, and a copy with no visible effect reads as one that failed.
  ok(
    await waitFor(
      cdp,
      `(() => {
        const b = document.getElementById('pgOriginBar');
        return b && b.style.display !== 'none' && /A better take/.test(b.textContent);
    })()`,
    ),
    'copying says so, in the Playground, where the button was pressed',
  );

  // ── stage a replacement over line 2 ─────────────────────────────────────
  await evaluate(cdp, openClips);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#scList tr.scDet button[data-paste]').length > 0`),
    'back in the chapters, every line now offers paste-before, replace and paste-after',
  );

  await evaluate(cdp, `document.querySelector('#scList tr.scDet button[data-paste="replace|1"]').click()`);
  ok(
    await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`),
    'Replace asks first — nothing is staged on a stray click',
  );
  await confirmModal(cdp);

  ok(
    await waitFor(cdp, `document.querySelectorAll('#scList tr.scStagedRep').length === 1`),
    'the staged edit is shown in the running order, in color, on the line it will replace',
  );
  // 🔴 A class is not a style. 6.0 §2.3 shipped a rail that computed to `none` because the
  // class was asserted and the rule was not there. Ask the browser what it actually painted.
  const painted = await evaluate(
    cdp,
    `(() => {
        const td = document.querySelector('#scList tr.scStagedRep td');
        const bg = getComputedStyle(td).backgroundColor;
        return { bg, transparent: /rgba\\(0, 0, 0, 0\\)|transparent/.test(bg) };
    })()`,
  );
  ok(painted && !painted.transparent, `and the color is really painted, not just a class name (${painted?.bg})`);
  ok(
    await evaluate(cdp, `/replaces this line when you Apply/.test(document.getElementById('scList').textContent)`),
    'the row says what will replace it, and that nothing has happened yet',
  );

  // ── Apply ───────────────────────────────────────────────────────────────
  ok(await evaluate(cdp, `!!document.getElementById('scEditApply')`), 'the Apply bar appeared with the staged edit');
  const before = await evaluate(cdp, `document.querySelectorAll('#scList tr[data-ref]').length`);

  await evaluate(
    cdp,
    `(() => {
        document.getElementById('scEditName').value = 'Sample Story One (fixed)';
        document.getElementById('scEditApply').click();
    })()`,
  );
  // The job is a 202 + poll, so wait for the finished modal rather than a fixed sleep.
  ok(
    await waitFor(
      cdp,
      `document.getElementById('overlay').classList.contains('on')
                           && /Edited/.test(document.getElementById('mTitle').textContent)`,
      60000,
    ),
    'Apply wrote a NEW scene and said so',
  );
  await confirmModal(cdp);

  // ⚠️ BY HEADER, NOT `td:nth-child(3)` — m4i / §9a.3 inserted a Character column in
  // front of Name, and a fixed index then reads the SPEAKER instead of the title. Five
  // checks across three specs carried that assumption; all of them look the column up now.
  const NAMES = `[...document.querySelectorAll('#scList tr[data-ref]')].map(tr => {
        // 9.5.7 - strip the sort arrow; see clips_table_layout_spec.mjs for what -1 costs.
        const h = [...document.querySelectorAll('#scList thead th')].map(x => x.textContent.replace(/[▲▼]/g, '').trim());
        return tr.children[h.indexOf('Name')].textContent; })`;
  ok(
    await waitFor(cdp, NAMES + `.some(td => /Sample Story One \\(fixed\\)/.test(td))`),
    'the edited scene is in the list under the name he gave it',
  );
  ok(
    await evaluate(cdp, NAMES + `.some(td => /^Sample Story One(?!\\s*\\(fixed\\))/.test(td.trim()))`),
    'and the original is still in the list, untouched — the whole point of the feature',
  );
  const after = await evaluate(cdp, `document.querySelectorAll('#scList tr[data-ref]').length`);
  ok(after === before + 1, `exactly one scene was added (${before} → ${after})`);

  // The plan is spent. Leaving it staged invites applying it twice, which is legal but is never
  // what he means one second after it landed.
  ok(await evaluate(cdp, `!document.getElementById('scEditApply')`), 'and the staged plan is cleared once it has been applied');

  ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join(' | ') || 'none'})`);

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} check(s) failed` : '\nall edit-flow checks passed');
} catch (e) {
  console.error(`spec error: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

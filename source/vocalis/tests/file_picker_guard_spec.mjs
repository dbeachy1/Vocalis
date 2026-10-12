// Vocalis 7.5.25 — the spacebar must not open a file dialog, in a REAL browser.
//
// A focused native file input can open its picker when Space is pressed, even though Space
// is also the page-scroll key. This browser spec verifies that keyboard handling prevents
// unintended picker activation while preserving normal page behavior.
// 🔴 A NATIVE `<input type="file">` OPENS ITS PICKER ON ENTER **OR SPACE** WHILE FOCUSED, and
// SPACE IS THE PAGE-SCROLL KEY. Fourteen of Vocalis's nineteen file inputs are `display:none`
// behind a `<label class="filebtn">` and cannot hold focus. Five are bare and visible, one Tab
// away from the scroll key — so focus lands on one, he presses Space to scroll, and a file dialog
// opens. From the outside that is indistinguishable from the browser doing it by itself, which is
// precisely why it survived a session of hunting: the search was for something that CLICKED.
//
// WHY THIS NEEDS A BROWSER AT ALL, and it is not a formality: the thing under test is a native
// browser behavior reacting to a real key event. There is no server, no route, and no DOM
// assertion that can see it — `preventDefault` leaves no trace in the page. The only observer is
// Chrome's own `Page.fileChooserOpened`, so the spec drives CDP and counts the event. With
// `Page.setInterceptFileChooserDialog` on, the dialog is REPORTED and never shown, which is what
// makes it safe to press the very key that misbehaves.
//
// ⚠️ AND ENTER MUST STILL OPEN ONE. The fix is an asymmetry, not a ban: a keyboard user's route to
// a file input is Enter, and nobody presses Enter meaning "scroll". A guard that killed both keys
// would trade a visible annoyance for an invisible accessibility regression, so the Enter case is
// pinned here as a POSITIVE assertion — this spec fails if someone "tidies" the guard into
// swallowing every key.
//
// Usage: node file_picker_guard_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node file_picker_guard_spec.mjs <base-url> <chrome-path>');
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

// The deadline only bounds a HANG; a passing run never waits it out. 20 s (30 s on the boot gate) was
// too short with dozens of these specs running at once, so the default is 60 s (2026-10-12).
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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-picker-'));
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
    '--window-size=1600,1200',
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
  // Report the dialog instead of showing it. Without this the spec would open a real modal
  // file chooser on the machine running the suite and hang there until the timeout.
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

  const chooser = [];
  const pageErrors = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.fileChooserOpened') chooser.push(m.params);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    }
  });

  // Resolves once at least one chooser report has arrived (a 50 ms step inside a deadline-bounded
  // loop), or after the 60 s hang bound, when the count the caller reads is 0 and its check fails.
  const untilChooser = async () => {
    const t0 = Date.now();
    while (chooser.length === 0 && Date.now() - t0 < 60000) await sleep(50);
    // Any second report would follow the first on the same path; one more frame lets it in.
    if (chooser.length > 0) await evaluate(cdp, NEXT_FRAME);
  };

  /** Press one key at whatever currently has focus, and count the dialogs it opened.
   *
   * 🔴 `keyDown` WITH `text`, NEVER `rawKeyDown`. Measured on a bare `data:` page carrying
   * nothing but an `<input type=file>`: Space opens the chooser under either form, but ENTER
   * OPENS IT ONLY UNDER `keyDown` — `rawKeyDown` delivers the keydown without the activation,
   * so Enter silently appears not to open a picker at all. That difference is invisible and it
   * inverts the meaning of the Enter check below: written with `rawKeyDown` it reads a harness
   * artifact as "Chrome has no Enter route", which is the exact wrong conclusion to draw right
   * before deciding what a guard is allowed to swallow. */
  async function press(key) {
    chooser.length = 0;
    const code = key === ' ' ? 'Space' : 'Enter';
    const vk = key === ' ' ? 32 : 13;
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      text: key === ' ' ? ' ' : '\r',
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    // 🔴 WHAT "THE KEY HAS BEEN HANDLED" MEANS HERE (this was `sleep(600)`, "the event is async; a bare
    // await would race it"). Chrome answers `Input.dispatchKeyEvent` only after the page has handled
    // the event, so by now the guard has run and the picker, if the key was going to open one, has
    // been asked for. That request then travels from the page to the browser, which reports it to
    // this script as `Page.fileChooserOpened`; one painted frame in the page afterwards means the
    // request has left it, and the report follows on the same path. The key that SHOULD open one
    // (Enter) is waited for as an event, so a slow report cannot be miscounted as "none".
    await evaluate(cdp, NEXT_FRAME);
    if (key === 'Enter') await untilChooser();
    return chooser.length;
  }
  // A page expression: the element exists and is laid out (no `display:none` ancestor), i.e. the tab
  // that holds it is on screen and it can take focus.
  const visibleId = id =>
    `(() => { const el = document.getElementById(${JSON.stringify(id)}); return !!el && el.offsetParent !== null; })()`;
  const focus = id =>
    evaluate(
      cdp,
      `(() => {
        const el = document.getElementById(${JSON.stringify(id)});
        if (!el) return false; el.focus();
        return document.activeElement === el; })()`,
    );

  await cdp.send('Page.navigate', { url: baseUrl });
  await waitFor(cdp, `document.readyState === 'complete'`);
  await waitFor(cdp, `window.__uiReady === true && window.__bootDone === true`);

  // ── the input this was actually reported on ──────────────────────────────
  await evaluate(cdp, `document.querySelector('[data-tab="voices"]').click()`);
  await waitFor(cdp, visibleId('vAddFile')); // the tab switch is done when its input can take focus (was sleep(300))
  ok(
    await evaluate(
      cdp,
      `(() => {
        const el = document.getElementById('vAddFile');
        return !!el && getComputedStyle(el).display !== 'none'; })()`,
    ),
    'the Upload-a-voice input is a bare, visible file input — it can hold focus',
  );
  ok(await focus('vAddFile'), 'and focus really lands on it, which is the whole precondition');
  ok((await press(' ')) === 0, '🔴 SPACE on it opens NO file dialog — the scroll key stays the scroll key');

  // ── …and the same holds on the other bare ones, because the guard is class-wide ──
  await evaluate(cdp, `document.querySelector('[data-tab="book"]').click()`);
  await waitFor(cdp, visibleId('bookFile')); // (was sleep(300))
  if (await focus('bookFile')) {
    ok((await press(' ')) === 0, 'Space opens none on the Book upload either — the guard is not per-input');
    // 🔴 THE POSITIVE HALF. Enter is the keyboard route to a file input and must survive.
    // `bookFile` is the one to prove it on: `vAddFile` has its own Enter handler that means
    // "Upload", so a zero there would say nothing about the guard.
    ok((await press('Enter')) === 1, '🔴 but ENTER still opens one — the fix is an asymmetry, not a ban on keyboard access');
  } else {
    ok(false, 'Space opens none on the Book upload either — the guard is not per-input');
  }

  // ── the control: an ordinary text box is untouched, and still types a space ──
  await evaluate(cdp, `document.querySelector('[data-tab="voices"]').click()`);
  await waitFor(cdp, visibleId('vAddName')); // (was sleep(300))
  await focus('vAddName');
  await evaluate(cdp, `document.getElementById('vAddName').value = 'ab'`);
  ok((await press(' ')) === 0, 'Space in a text box opens nothing (it never did — this is the control)');
  ok(
    (await evaluate(cdp, `document.getElementById('vAddName').value`)) === 'ab ',
    '…and still TYPES a space, so the guard did not reach past file inputs',
  );

  ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join(' | ') || 'none'})`);
  exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error(`  FAIL harness: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

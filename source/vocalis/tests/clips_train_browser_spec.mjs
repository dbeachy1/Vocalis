// Browser coverage for sending a SillyTavern scene clip to Training Clips.
// Route and render tests cover the server copy and button markup; this spec verifies the
// click handler, route selection for the row kind, tab transition, and selection of the
// arriving clip. It also exercises the scenes-to-training module cycle at click time.
// Docker edition: Voice Training is not shipped, so the destination is the Speech library
// (Voice Studio ▸ Speech) and the button is ＋ Speech; the file keeps its original name.

// Keep CDP expressions free of unescaped backticks and backslash escapes inside CDP template literals.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { STAMP_OUTGOING, ON_NEW_DOCUMENT } from './_specwait.mjs';

const [base, chromePath] = process.argv.slice(2);
let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

const userDir = mkdtempSync(join(tmpdir(), 'vocalis-train-'));
// 🔴 PORT 0 — Chrome picks a free one and reports it in DevToolsActivePort. Anything derived from
// a pid collides the moment two suites run on this box, and a collision does not fail cleanly:
// /json/list answers from the OTHER Chrome and this spec drives someone else's browser.
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Keep browser audio muted while media behavior remains testable.
    // Playback state, duration, and completion events still run with --mute-audio.
    '--mute-audio',
    '--window-size=1200,800',
    '--autoplay-policy=no-user-gesture-required',
    base,
  ],
  {
    stdio: 'ignore',
    // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
    // Both variables point into the owned profile so cleanup contains extracted scratch.
    env: { ...process.env, TEMP: userDir, TMP: userDir },
  },
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function activePort() {
  try {
    const first = readFileSync(join(userDir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const n = parseInt(first, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function cdpTarget() {
  for (let i = 0; i < 100; i++) {
    const port = activePort();
    if (port === null) {
      await sleep(100);
      continue;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('Chrome never came up');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    ws.addEventListener('open', () =>
      resolve({
        send(method, params) {
          return new Promise(res => {
            pending.set(++id, res);
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.addEventListener('error', reject);
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result));
  return r.result && r.result.result ? r.result.result.value : undefined;
}

// 🔴 30s, NOT 10s, AND THE DEFAULT IS THE FIX. Every wait in this file is a PRECONDITION or a
// state transition — none of them is the assertion itself — so patience only ever delays a
// genuine failure; it can never turn a red green. Ten seconds was not enough for a table row to
// acquire a BOX in a 16-worker run on a loaded box: the row-layout wait below timed out, and the
// paint check after it then reported `🎓 Train is a real control with a real size (0x0px)` —
// a measurement of "not yet", read as "wrong". Passed alone, red under load, which is the tell.
// Sibling specs already sit higher for the same reason: clips_chapters_browser_spec.mjs waits
// 20s, and folders_browser_spec.mjs raised its boot gate 15s -> 45s after the identical flake.
async function waitFor(cdp, expr, tries = 300) {
  let lastThrow = null;
  for (let i = 0; i < tries; i++) {
    // 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED". `evaluate` turns a page exception
    // into a thrown Error, so an unguarded wait whose expression touches a node is a race:
    // the first poll landing mid-repaint kills the spec, and it presents as a flake because
    // the window is narrow. Poll through transient page exceptions while retaining diagnostics.
    // ⚠️ Remembered, not swallowed - a typo in an expression throws on every poll and would
    // otherwise just time out saying nothing about why.
    try {
      // 🔴 `Promise.resolve(...)`, NEVER `!!(expr)` AND NEVER A BARE VALUE. On a promise the
      // alternatives are true synchronously and always - `!!` on a thenable, and a promise
      // serialized by Runtime.evaluate as `{}`. Await the resolved result so the condition is
      // checked before the wait returns.
      if (await evaluate(cdp, `Promise.resolve(${expr}).then(v => !!v)`)) return true;
      lastThrow = null;
    } catch (err) {
      lastThrow = err && err.message ? err.message : String(err);
    }
    await sleep(100);
  }
  if (lastThrow) console.log(`  (wait gave up; last page exception: ${lastThrow})`);
  return false;
}

const OPEN_TAB = `(() => { switchTab('sillytavern'); switchStTab('clips'); return true; })()`;
// The row the harness seeds as a ONE-speaker scene, i.e. the one that must send without a warning.
const SOLO = 'A_lighthouse_ab12cd30';
// …and the two-hander, which must ask first. Both stems are fixed by the Python side.
const DUET = 'The_ferry_ab12cd31';
const cell = ref => `[...document.querySelectorAll('#scList tr[data-ref]')]` + `.find(r => r.dataset.ref === ${JSON.stringify(ref)})`;

// 🔴 THE REAL DIALOG, NOT A STUB, AND `window.modal = …` WOULD NOT HAVE WORKED ANYWAY.
// `modal` is a module import in js/scenes/scenes.js — an ES binding resolved at load — so
// assigning `window.modal` from here replaces a name the module never reads, and the spec would
// have hung on a dialog it thought it had disabled. Driving `#overlay` is both the honest test and
// the only one available: it is the same dialog the user sees, with the same buttons in the same order
// (`actions[0]` is the cancel by convention — Esc and the backdrop both fire it).
const OVERLAY_OPEN = `document.getElementById('overlay').classList.contains('on')`;
const OVERLAY_TITLE = `document.getElementById('mTitle').textContent`;
const CLICK_CANCEL = `document.querySelector('#mActs button').click()`;

try {
  const cdp = await connect(await cdpTarget());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // Module scripts execute before `load`, and `complete` is after it, so this is the cheapest
  // correct "the module graph has run" signal. `__uiReady` is js/main.js's own stamp.
  await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`);
  // ⚠️ THE PAGE HAS NO ERROR COLLECTOR OF ITS OWN — the spec installs one. (The 6.2 favorites
  // spec ends on `window.__vocalisErrors`, which nothing in `src/webui/` ever sets, so that
  // check has always read `no uncaught page errors (none)` whatever happened. This one is real:
  // a ReferenceError from the new cross-module imports would surface HERE and nowhere else,
  // because every call into them sits inside a click handler.)
  // ⚠️ `window.addEventListener`, NOT the bare call. `test_webui_modules.py`'s spec scan reads
  // every BARE call in a CDP expression as a page-scope name that has to be exported or defined,
  // and answered `addEventListener <- clips_train_browser_spec.mjs`. It is right to: a bare call
  // in one of these snippets is exactly the ReferenceError shape it exists to catch, and it
  // cannot tell a DOM global from a name a module owns. Qualify, do not exempt.
  // 🔴 AT DOCUMENT START, AND THE RELOAD IS WHAT MAKES THAT TRUE (7.5.8).
  //
  // This used to be a plain `evaluate` here, i.e. a listener added AFTER the readiness gate, on a
  // page the Python driver navigated long before the spec connected. Everything boot threw was
  // already in the past, so the check only ever saw whatever finished LAST — and it still caught
  // `TypeError: Cannot set properties of null (setting 'innerHTML')` about one run in three, which
  // means that error is late, not early. 7.5.8 moved the gate to `__bootDone` and would have
  // widened the blind spot to cover the whole of boot: the same bug, quietly passing.
  //
  // 📌 AND IT KEEPS `.stack`. `String(e.reason)` is the message alone, which is why three sessions
  // have argued about this failure from RATES instead of reading it. `minify` is off in
  // tools/build_webui.mjs on purpose, so identifiers survive and a stack names a greppable
  // function. ⚠️ `e.error`/`e.reason` can be a non-Error (a string, a rejected fetch), hence the
  // optional chain rather than a bare `.stack`.
  const COLLECT = `window.__specErrors = [];
        window.addEventListener('error', e => window.__specErrors.push(
            String(e.message) + (e.error?.stack ? '\\n' + e.error.stack : '')));
        window.addEventListener('unhandledrejection', e => window.__specErrors.push(
            'unhandled: ' + String(e.reason) + (e.reason?.stack ? '\\n' + e.reason.stack : '')));`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECT });
  // ⚠️ EVALUATED ONCE PER DOCUMENT. The reload builds a fresh global with the collector already
  // installed; without it the registration above applies only to the NEXT navigation, and
  // `window.__specErrors` on this one comes back `undefined` — the vacuous shape this replaces.
  await evaluate(cdp, STAMP_OUTGOING); // the gate below must be met by the NEW page; see _specwait.mjs
  await cdp.send('Page.reload');
  await waitFor(cdp, `${ON_NEW_DOCUMENT} && document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`);
  // 🔴 The page publishes nothing on `window` since 7.3-m13; the HARNESS publishes what the
  // harness drives. After the readiness gate, before the first assertion, and awaited.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  await evaluate(cdp, OPEN_TAB);
  await evaluate(cdp, `loadScenes()`);
  ok(await waitFor(cdp, `document.querySelectorAll('#scList tr[data-ref]').length >= 2`), 'the Scene Clips tab lists the scenes');

  // ⚠️ AND WAIT FOR LAYOUT — the row is in the DOM immediately, but its box is 0x0 until the
  // table is laid out. Waiting on the row confirms layout without making the later button-size
  // assertion tautological.
  //
  // 🔴 THE PRECONDITION IS THE ROW'S BOX, NOT THE BUTTON'S. Waiting on the button's own size
  // would make the assertion below tautological: it could then only fail by timing out.
  // ⚠️ AND THE WAIT IS ASSERTED. `waitFor` RETURNS false on timeout, it does not throw, so an
  // unchecked one is a precondition that quietly did not hold - and the assertion below then fails
  // with a confusing message about paint instead of the true cause. Every other wait in this file
  // is checked; these two were the exception.
  ok(
    await waitFor(cdp, `(document.querySelector('#scList tr[data-ref]')?.getBoundingClientRect().height || 0) > 0`),
    'the row has a laid-out box before anything inside it is measured',
  );

  // ── the button is a real, visible, clickable control ─────────────────────────────────
  //
  // A zero-sized or transparent button passes every regex ever written about it — the lesson
  // `feedback_assert_computed_style_not_class` records, where a class-only assertion passed
  // while nothing painted.
  const paint = await evaluate(
    cdp,
    `(() => {
        const b = ${cell(SOLO)}.querySelector('button[data-act="speech"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return { w: r.width, h: r.height, text: b.textContent.trim(),
                 display: cs.display, vis: cs.visibility, op: cs.opacity };
    })()`,
  );
  ok(
    paint && paint.w > 20 && paint.h > 6,
    `＋ Speech is a real control with a real size (${paint && paint.w.toFixed(0)}x${paint && paint.h.toFixed(0)}px)`,
  );
  ok(paint && paint.vis !== 'hidden' && paint.display !== 'none' && Number(paint.op) > 0.5, 'and it is actually visible on the row');

  // Nothing is in the pool yet — the assertion below is worthless without this.
  const before = await evaluate(cdp, `fetch('/train/sources').then(r => r.json()).then(rows => rows.length)`);
  ok(before === 0, `the speech pool starts empty (${before})`);

  // ── the round trip ───────────────────────────────────────────────────────────────────
  //
  // A real click, through the real delegated handler, on the ONE-speaker scene: no modal is
  // expected, so anything that opens one here would hang this spec rather than pass it.
  await evaluate(cdp, `${cell(SOLO)}.querySelector('button[data-act="speech"]').click()`);
  const landed = await waitFor(
    cdp,
    `fetch('/train/sources').then(r => r.json())` + `.then(rows => rows.map(x => x.ref).join(',') === 'A_lighthouse.mp3')`,
  );
  const pool = await evaluate(cdp, `fetch('/train/sources').then(r => r.json()).then(rows => rows.map(x => x.ref).join(','))`);
  ok(landed, `the scene lands in the speech pool under its NAME, not its stem (${pool})`);

  // §2's badge, read back off the store rather than off the row we just built.
  const prov = await evaluate(cdp, `fetch('/train/sources').then(r => r.json()).then(rows => (rows[0] || {}).provenance)`);
  ok(prov === 'scene', `and it is badged as coming from a scene (${prov})`);

  // 🔴 THE HALF NOTHING ELSE CAN SEE: the page LEAVES for Voice Studio ▸ Speech and the arriving
  // clip is LISTED there, loaded by the button itself. (Docker edition: this was Voice Training,
  // where the arriving clip was also TICKED for "name the voice and press Start". Speech has no
  // equivalent selection to arrive in, so the check is that the row is on screen without a refresh.)
  ok(
    await waitFor(cdp, `document.querySelector('section[data-panel="voicestudio"]')` + `.style.display !== 'none'`),
    'the page moves to Voice Studio',
  );
  ok(await waitFor(cdp, `document.querySelector('[data-vspanel="speech"]')` + `.style.display !== 'none'`), '…on the Speech sub-tab');
  const listed = await waitFor(
    cdp,
    `[...document.querySelectorAll('#spList [data-sprow]')]` + `.map(r => r.dataset.sprow).join(',') === 'A_lighthouse.mp3'`,
  );
  const which = await evaluate(cdp, `[...document.querySelectorAll('#spList [data-sprow]')]` + `.map(r => r.dataset.sprow).join(',')`);
  ok(listed, `the arriving clip is already listed in the Speech clips (${which}) — no refresh needed`);

  // The scene itself is untouched: it is COPIED into the pool, and a Clips tab that had lost a
  // row would be the worst possible reading of a button called "send".
  await evaluate(cdp, OPEN_TAB);
  await evaluate(cdp, `loadScenes()`);
  ok(await waitFor(cdp, `${cell(SOLO)} !== undefined`), 'the scene is still in Scene Clips afterward — it was copied, not moved');

  // ── the second press: the 409 replace contract ───────────────────────────────────────
  //
  // The pool already holds that name, so this must ASK rather than silently overwriting or
  // silently failing. Cancel, and the pool must be exactly as it was.
  await evaluate(cdp, `${cell(SOLO)}.querySelector('button[data-act="speech"]').click()`);
  ok(await waitFor(cdp, OVERLAY_OPEN), 'a second send of the same scene ASKS before replacing');
  const asked = await evaluate(cdp, OVERLAY_TITLE);
  ok(/already/i.test(asked || ''), `…and the question is about the collision (“${asked}”)`);
  await evaluate(cdp, CLICK_CANCEL);
  ok(await waitFor(cdp, `!(${OVERLAY_OPEN})`), 'Cancel closes it');
  const still = await evaluate(cdp, `fetch('/train/sources').then(r => r.json()).then(rows => rows.length)`);
  ok(still === 1, `…and left the pool exactly as it was (${still} clip)`);

  // 🔴 THE BUTTON COMES BACK. It is disabled and swapped for a spinner while the post is in
  // flight, restored in a `finally` — a cancel that left it spinning would look identical to a
  // hang, and that row would be dead for the life of the page.
  const restored = await waitFor(
    cdp,
    `(() => {
        const b = ${cell(SOLO)}.querySelector('button[data-act="speech"]');
        return !!b && !b.disabled && /Speech/.test(b.textContent);
    })()`,
  );
  ok(restored, 'the button is live again after a cancel — not left spinning');

  // ── the multi-speaker scene: NO WARNING IN THIS EDITION ──────────────────────────────
  //
  // The original 7.5 spec asserted that a two-hander WARNED before it was sent, because a training
  // dataset is ONE voice and a blend is only discovered hours into a run. The Speech library holds
  // clips for any use, so the Docker edition sends a two-speaker scene straight through. This
  // pins that: no dialog opens, and the scene lands in the pool beside the first one.
  await evaluate(cdp, OPEN_TAB);
  await evaluate(cdp, `loadScenes()`);
  ok(await waitFor(cdp, `${cell(DUET)} !== undefined`), 'the two-speaker scene is listed');
  await evaluate(cdp, `${cell(DUET)}.querySelector('button[data-act="speech"]').click()`);
  const both = await waitFor(
    cdp,
    `fetch('/train/sources').then(r => r.json())` +
      `.then(rows => rows.map(x => x.ref).sort().join(',') === 'A_lighthouse.mp3,The_ferry.mp3')`,
  );
  ok(both, 'a scene with two speakers in it is sent straight through, with no warning to answer');
  ok(!(await evaluate(cdp, OVERLAY_OPEN)), 'and no dialog is left open');

  const errs = await evaluate(cdp, `(window.__specErrors || []).join(' | ')`);
  ok(!errs, `no uncaught page errors (${errs || 'none'})`);

  cdp.close();
} finally {
  chrome.kill();
  // 🔴 `userDir` IS THIS SPEC'S CHROME PROFILE (`--user-data-dir` above), and nothing ever
  // removed it — 12-27 MB left in %TEMP% on every single run. The first attempt at this fix put a
  // sync delete right here, which is the very race that caused the leak in the other thirty specs:
  // `kill()` returns at once and Windows keeps the process's file handles a moment longer, so the
  // delete throws EBUSY. Wait for the exit, then retry.
  if (chrome.exitCode === null && chrome.signalCode === null)
    await new Promise(r => {
      chrome.once('exit', r);
      setTimeout(r, 4000);
    });
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(userDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

// 8.9 — virtual folders, driven in a REAL headless browser (CDP, no npm).
//
// WHY, when `test_folders.py` covers the store, `test_folders_routes.py` covers the routes and
// `voices_ui_smoke.mjs` covers the renderer: because every one of those can pass while the page is
// visibly broken. The smoke runs `renderVoiceList` in a bare `vm` with a stubbed `$` and NO CSS —
// so it cannot see a folder row painted to zero height, a `✕` wrapped onto its own line, or a
// filing that never reaches the server.
//
// 🔴 THE CHECK THAT CARRIES THIS FILE IS PERSISTENCE ACROSS A RELOAD. A folder held in the page's
// own state passes every other assertion here — it renders, it opens, it counts — and is gone the
// moment he refreshes. That is the same defect the star spec exists for, and surviving a reload is
// the entire point of a server-backed store.
//
// 🔴 THE SECOND IS LAYOUT, which no `vm` can reach: the folder name must ELLIPSE while the count
// and the buttons stay on the row. This project's recorded rule is that a label never wraps and
// the culprit is always a cell that was not `flex:0`, so the assertion is on real
// `getBoundingClientRect()` values rather than on a class name.
//
// ⚠️ No backticks inside the CDP expressions: they are template literals here, and an unescaped
// one ends the literal (a whole spec became a syntax error that way in 6.2).
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';
import { reportNetworkFailures, STAMP_OUTGOING, ON_NEW_DOCUMENT } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node folders_browser_spec.mjs <base-url> <chrome-path>');
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

// ── CDP plumbing ─────────────────────────────────────────────────────────────
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

// Runtime.evaluate, unwrapped. userGesture matters: the player is opened from a click handler
// and Chrome's autoplay policy only relaxes under a real activation, so evaluating without it
// would fail for a reason the user never hits.
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

//: 🔴 THE PATIENCE THE BOOT GATE ALREADY ARGUES FOR, APPLIED TO THE INTERACTIONS TOO.
//: Its comment measured this box: ~7s per page load idle, ~22s under the full suite. Every
//: wait in this file sits in that same suite, and each follows a SERVER ROUND TRIP plus a
//: re-render — so 15s was a coin flip, not a check. The conditions are unchanged; only the
//: patience is. A spec that is red solely because the machine is busy teaches people to
//: re-run, which is the habit that lets a real failure through.
const LOADED_MS = 45000;

async function waitFor(cdp, expression, what, timeoutMs = 15000) {
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

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-folders-cdp-'));
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
    // 🔴 A NARROW WINDOW, AND IT IS THE WHOLE REASON THE NO-WRAP ASSERTION IS A TEST.
    // At the 1200px the other specs use, a 60-character folder name plus its three buttons fit
    // with room to spare — so the row cannot wrap however the CSS is broken, and the assertion
    // passes under every mutation. Measured: removing `flex:0 0 auto` AND `white-space:nowrap`
    // from `.vfacts` still went green at 1200px. At 560 the row is genuinely constrained, the
    // name has to ellipse, and the same mutation turns it red.
    '--window-size=560,900',
    // A self-signed/mkcert cert must not be what fails this spec.
    '--ignore-certificate-errors',
    // Deliberately NOT --autoplay-policy=no-user-gesture-required: the click IS the gesture,
    // and relaxing the policy here would hide a real "it never starts" regression.
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

// Chrome writes the port it actually bound into DevToolsActivePort.
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
  // Why a request failed, in Chrome's own words, printed if the spec ends red. (Added 2026-10-12
  // when this spec failed in a full run with the list painted "No uploaded voices." over a server
  // that held two. That turned out not to be a lost request: the boot gate after the reload had
  // been answered by the OLD page. See ON_NEW_DOCUMENT in _specwait.mjs.)
  await reportNetworkFailures(cdp.send, fn => cdp.ws.addEventListener('message', ev => fn(JSON.parse(ev.data))));

  // 🔴 INSTALLED ONCE PER DOCUMENT, and "per document" is the subtlety: `Page.reload` builds a
  // fresh global, so a collector installed before the navigation goes with the old one and the
  // check comes back `undefined` — which is exactly the shape of a vacuous assertion. `boot()`
  // therefore re-installs it, and is called on both loads.
  const COLLECT = `(() => { window.__specErrors = [];
      window.addEventListener('error', e => window.__specErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', e => window.__specErrors.push('unhandled: ' + String(e.reason)));
      return true; })()`;

  const boot = async () => {
    ok(
      await waitFor(
        cdp,
        // ON_NEW_DOCUMENT: on the second call the page that is about to be replaced already meets
        // the rest of this gate. See _specwait.mjs; this is what failed here on 2026-10-12.
        `${ON_NEW_DOCUMENT} && document.readyState === "complete" && window.__uiReady === true && window.__bootDone === true`,
        'the page finishes booting',
        // ⚠️ 45s, NOT the 15s default. This spec runs inside the full suite alongside fifteen other
        // pytest workers, and Chrome's cold start plus ~30 module fetches genuinely exceeds 15s on a
        // loaded box — measured: every run that took ~22s here failed the boot gate, every ~7s run
        // passed. That is a patience problem, not a race in the page: the CONDITION is unchanged and
        // still has to become true, so nothing is weakened. A spec that is red only when the machine
        // is busy is worse than no spec, because it teaches people to re-run.
        45000,
      ),
      'the page loads and js/main.js has run',
    );
    await evaluate(cdp, COLLECT);
    await evaluate(cdp, PUBLISH_SPEC_SURFACE);
    await evaluate(cdp, `switchTab('voices')`);
    return waitFor(cdp, `document.querySelectorAll('#vList .item').length > 0`, 'the voice list renders', LOADED_MS);
  };

  await cdp.send('Page.navigate', { url: baseUrl });
  const listed = await boot();
  ok(listed, 'the Voices tab lists at least one voice');
  if (!listed) throw new Error('no voices rendered — the fixture did not reach the page');

  // ── the ✚ Folder button is BUILT BY THE MODULE, not written into index.html ──────────────
  // It moved out of the page to keep index.html under its line ceiling, which makes "does it
  // exist" a real question: a wrong anchor id makes `folderAddButton` no-op in total silence.
  const addBtn = await evaluate(
    cdp,
    `(() => { const b = document.querySelector('[data-vfadd="voices_tts"]');
        if (!b) return {missing: true};
        const r = b.getBoundingClientRect();
        return {w: r.width, h: r.height}; })()`,
  );
  ok(!addBtn.missing, '🔴 the ✚ Folder button exists — it is built by ui/folders.js, not by index.html');
  ok(!addBtn.missing && addBtn.w > 20 && addBtn.h > 8, `and it has a real size (${Math.round(addBtn.w)}x${Math.round(addBtn.h)})`);

  // ── create a folder, then file a voice into it through the real UI ───────────────────────
  const made = await evaluate(
    cdp,
    `fetch('/folders/voices_tts', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({name:'Auditions from the second session, the long ones'})}).then(r => r.json())`,
  );
  ok(made && /^f_[0-9a-f]{8}$/.test(made.id || ''), `the folder is created server-side (${made && made.id})`);
  const fid = JSON.stringify(String(made.id));

  await evaluate(cdp, `loadVoiceList()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#vList .vfolder').length === 1`, 'the folder row appears', LOADED_MS),
    'the folder renders as a row in the list',
  );

  const bar = await evaluate(
    cdp,
    `(() => { const f = document.querySelector('#vList .vfolder'); const r = f.getBoundingClientRect();
        const nm = f.querySelector('.vfname').getBoundingClientRect();
        const del = f.querySelector('[data-fact="del"]').getBoundingClientRect();
        return {h: r.height, nameTop: nm.top, delTop: del.top, delRight: del.right, barRight: r.right}; })()`,
  );
  ok(bar.h > 12, `the folder row has a real height (${Math.round(bar.h)}px), so it is not painted away`);
  // 🔴 THE NO-WRAP RULE, MEASURED — and the two assertions below are the ones that can actually
  // FAIL, which took three mutations to establish and is worth recording:
  //
  //   ✗ "✕ is on the same line as the name" (Δtop) is STRUCTURALLY VACUOUS. `.vfolder` is a flex
  //     container and flex does not wrap unless told to, so the button physically cannot drop to a
  //     second line however the CSS is broken. It passed every mutation, at both widths. Deleted
  //     rather than kept as reassurance.
  //   ✓ THE ROW HEIGHT catches the name wrapping INSIDE its own cell and growing the row.
  //   ✓ THE ACTIONS STAYING INSIDE THE ROW catches the real bug this project keeps hitting — a
  //     cell that was not allowed to shrink. Verified: removing `min-width:0` from `.vfoldname`
  //     (the classic flex overflow) turns this red; with it, green.
  ok(bar.h < 64, `the folder row is ONE line tall (${Math.round(bar.h)}px) — a long name ellipses instead of wrapping`);
  ok(
    bar.delRight <= bar.barRight + 1,
    `🔴 the actions stay INSIDE the row (✕ right ${Math.round(bar.delRight)} ≤ row right ${Math.round(bar.barRight)}) — the name is the only thing allowed to give`,
  );

  // Tick the first voice and press the folder's own move button, exactly as a user would.
  const firstName = String(await evaluate(cdp, `document.querySelector('#vList .item .vchk').value`));
  const ref = JSON.stringify(firstName);
  await evaluate(
    cdp,
    `(() => { const c = document.querySelector('#vList .item .vchk');
        c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`,
  );
  await evaluate(cdp, `document.querySelector('#vList .vfolder [data-fact="move"]').click()`);
  ok(
    await waitFor(
      cdp,
      `fetch('/voices').then(r => r.json()).then(v => (v.find(x => x.name === ${ref}) || {}).folder === ${fid})`,
      'the server records the filing',
    ),
    '🔴 ⇥ Move selected here reaches the SERVER — the row is filed, not merely re-styled',
  );

  // ── THE CHECK THIS FILE CARRIES: it survives a reload ────────────────────────────────────
  await evaluate(cdp, STAMP_OUTGOING);
  // Measured here 2026-10-12 with the reload slowed by 1.5 s: asked straight after this command,
  // the plain gate answered true and the stamp was still set, i.e. the OLD page had answered.
  await cdp.send('Page.reload', { ignoreCache: true });
  const relisted = await boot();
  ok(relisted, 'the list comes back after a reload');
  ok(
    await waitFor(cdp, `document.querySelectorAll('#vList .vfolder').length === 1`, 'the folder is still there', LOADED_MS),
    '🔴 the folder SURVIVES a reload — it lives on the server, not in the page',
  );
  ok(
    await evaluate(cdp, `document.querySelector('#vList .vfolder .vfn').textContent.trim() === '(1)'`),
    'and it still counts the voice filed into it',
  );

  // ── open it, and check the child lands IN PLACE ──────────────────────────────────────────
  // 🔴 WAIT FOR THE BUTTON BEFORE CLICKING IT. This line used to `querySelector(...).click()`
  // outright, two statements after a `Page.reload` — so if the list had not re-rendered yet,
  // `querySelector` returned null and the click never happened. The `waitFor` below then timed
  // out honestly, and the failure read as 'clicking the folder opens it', which points at the
  // folder code rather than at a spec that clicked nothing.
  //
  // ⚠️ IT FAILED TWICE UNDER FULL-SUITE LOAD AT THIS EXACT CHECK. A spec that fails at the
  // SAME point under contention is a race; one that fails at a different point each time is
  // the machine. That distinction is what separated this from the load-sensitive specs.
  const openBtn = await waitFor(
    cdp,
    `document.querySelector('#vList .vfolder [data-fact="open"]') !== null`,
    'the open control is rendered',
    LOADED_MS,
  );
  ok(openBtn, 'the folder row offers a way to open it');
  if (openBtn) await evaluate(cdp, `document.querySelector('#vList .vfolder [data-fact="open"]').click()`);
  // 🔴 THE ONE THAT FAILED TWICE. Opening a folder is not a class toggle: `folders.js:727`
  // does `setFolderOpen()` then `await o.reload()` — a server fetch AND a full re-render of
  // the voice list. At the 15s default that is a coin-flip on a box the boot gate measured
  // at ~22s for a page load under this same suite.
  const opened = await waitFor(cdp, `document.querySelector('#vList .vfolder.open') !== null`, 'the folder opens', LOADED_MS);
  ok(opened, 'clicking the folder opens it');
  if (!opened) {
    // 🔴 SAY WHY, DO NOT JUST TIME OUT. `.open` is applied by the RE-RENDER, not by the click:
    // `setFolderOpen()` writes UIS and `folders.js:282` renders
    // `class="vfolder${e.open ? ' open' : ''}"` on the next paint. So a timeout here has at
    // least four distinct causes and a duration distinguishes none of them:
    //   · the click never landed (no button, or it was a drop-TARGET span with no data-fact)
    //   · UIS never took the value
    //   · the reload landed but rendered from stale state
    //   · the reload simply has not happened yet
    // A deadline that grows every time this fails is a test being talked out of its result.
    const why = await evaluate(
      cdp,
      `(() => { const f = document.querySelector('#vList .vfolder');
          return {
            folders: document.querySelectorAll('#vList .vfolder').length,
            html: f ? f.outerHTML.slice(0, 400) : null,
            hasOpenBtn: !!document.querySelector('#vList .vfolder [data-fact="open"]'),
            isDropTarget: !!document.querySelector('#vList .vfolder .vftarget'),
            ticked: document.querySelectorAll('#vList input[type=checkbox]:checked').length,
            // 🔴 IS THE WHOLE LIST EMPTY, OR ONLY THE FOLDERS? That single distinction
            // separates 'the list is mid-render' from 'folders specifically were dropped',
            // and no amount of waiting would have told them apart.
            items: document.querySelectorAll('#vList .item').length,
            listHtmlHead: (document.querySelector('#vList') || {}).innerHTML
              ? document.querySelector('#vList').innerHTML.slice(0, 200) : '(no #vList)',
            listChildren: (document.querySelector('#vList') || {children: []}).children.length,
            // 🔴 THE LAST FORK: did the SERVER say empty, or did the client drop it? The list
            // rendered its empty state, which means the fetch SUCCEEDED and returned zero —
            // the error branch would have rendered a message instead. So ask the server again,
            // now, and compare.
            stateVlist: (() => { try { return JSON.stringify((window.state && window.state.vlist) || null).slice(0, 120); }
                                 catch (e) { return 'unreadable'; } })(),
            uis: (() => { try { return JSON.stringify(Object.entries(localStorage)
                    .filter(([k]) => k.indexOf('folder') >= 0)); } catch (e) { return 'unreadable'; } })(),
          }; })()`,
    );
    console.error('  DIAG folder-open failed: ' + JSON.stringify(why));
    const live = await evaluate(
      cdp,
      `fetch('/voices').then(r => r.json()).then(d => ({
        n: (d.voices || d || []).length, keys: Object.keys(d).slice(0, 6) }))`,
    );
    console.error('  DIAG /voices right now: ' + JSON.stringify(live));
  }
  // 🔴 REAL DOM ORDER AND REAL LAYOUT, never a string index into innerHTML. The child must be the
  // element immediately after the folder row, and must be painted below it.
  // 🔴 GUARDED, BECAUSE `ok()` RECORDS A FAILURE AND CARRIES ON. When the wait above failed,
  // this ran anyway with `f === null`, threw `Cannot read properties of null (reading
  // 'nextElementSibling')`, and killed the whole spec — so every check BELOW never ran,
  // including this test's headline: that deleting a folder keeps the voice. A cascade does
  // not merely add noise; it hides the assertions that matter behind the first casualty.
  const order = !opened
    ? { none: true }
    : await evaluate(
        cdp,
        `(() => { const f = document.querySelector('#vList .vfolder.open');
        if (!f) return {none: true};
        const next = f.nextElementSibling;
        if (!next) return {none: true};
        return {isItem: next.classList.contains('item'),
                ref: next.getAttribute('data-vrow'),
                folderBottom: f.getBoundingClientRect().bottom,
                childTop: next.getBoundingClientRect().top}; })()`,
      );
  ok(!order.none && order.isItem, '🔴 the open folder is IMMEDIATELY followed by a voice row, not by another folder');
  ok(order.ref === firstName, `and it is the voice that was filed into it (${order.ref})`);
  ok(order.childTop >= order.folderBottom - 2, 'and it is painted BELOW its folder, not beside or above it');

  // ── deleting the folder KEEPS the voice ──────────────────────────────────────────────────
  const gone = await evaluate(cdp, `fetch('/folders/voices_tts/' + ${fid}, {method:'DELETE'}).then(r => r.json())`);
  ok(gone && gone.deleted === true, 'the folder is deleted');
  await evaluate(cdp, `loadVoiceList()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#vList .vfolder').length === 0`, 'the folder row goes', LOADED_MS),
    'the folder row disappears',
  );
  ok(
    await evaluate(cdp, `document.querySelectorAll('#vList .item[data-vrow=' + JSON.stringify(${ref}) + ']').length === 1`),
    '🔴 and the VOICE is still listed — deleting a folder removes the label, never the item',
  );

  const errs = await evaluate(cdp, `JSON.stringify(window.__specErrors || ['collector missing'])`);
  ok(errs === '[]', `no uncaught page errors (${errs})`);

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} FAILED` : '\nall browser assertions passed');
} catch (err) {
  console.error(`  FAIL ${err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

// Vocalis 7.5.17 — multi-select delete on the Stems library, in a REAL browser.
//
// Verify multi-delete selection, filtering, confirmation totals, request contents, and the
// resulting library state in a browser where checkbox and disclosure interactions are real.
//
// WHY A BROWSER, when `/stems/library` DELETE has taken a LIST since 4.0 and `test_stems.py`
// already covers `delete_sets` down to the bytes: because everything new here is in the page, and
// two of the four things worth checking are INTERACTIONS that no route test can reach —
//
//   1. 🔴 A TICK MUST NOT ALSO EXPAND THE SET. The checkbox sits inside `[data-swhead]`, whose
//      delegated handler toggles the disclosure. Without the exclusion, selecting six sets leaves
//      six audio players open behind the dialog, and the second click that would collapse one
//      unticks it again. This is exactly the class of bug a `.click()` in a route test cannot see.
//   2. 🔴 THE SELECTION IS READ OFF THE DOM, so filtering must not carry a hidden tick into a
//      delete. The action applies only to the visible selection.
//   3. the bar appears only when something is ticked, and its running total is real;
//   4. one request goes out with every ref in it, and the sets really leave the library.
//
// Usage: node stems_bulk_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_NET_IDLE, NET_IDLE, NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node stems_bulk_browser_spec.mjs <base-url> <chrome-path>');
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

async function waitFor(cdp, expression, timeoutMs = 20000) {
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

/** Read `expression` until it stops changing — the same helper `wbedit_browser_spec` carries.
 *
 * 🔴 "THE ROWS EXIST" IS NOT "THE LIST HAS FINISHED ARRIVING", AND THE GAP EATS A CLICK.
 * `ssLoadAll()` is fired by BOTH the Voice Studio tab click and the stems sub-tab click
 * (`voiceswap.js:86` and `:487`), so one user action starts two async loads. Waiting for four
 * checkboxes is satisfied by the first; the second repaints `#ssLib` afterward and replaces
 * every node in it — including a box ticked in between, which then reads `checked === false`.
 * Seen 2026-08-15 under a full 16-worker run, green alone.
 */
//
// 🔴 SUPERSEDED 2026-10-12 — "STOPPED CHANGING FOR 120 ms" IS A SLEEP IN A LOOP. This read
// `expression` twice, `quietMs` apart, and called the list finished when both reads agreed. The
// two loads above are the case it was written for, and on a loaded machine the second repaint can
// land more than 120 ms after the first: both reads then agree on the half-finished list and the
// tick made next goes to a node that is about to be thrown away. "Finished arriving" means the
// page has no request in flight and no response body still being read: each step of the load chain
// continues in the microtasks that run right after the last body is read, so once the count is zero
// in a LATER task the chain has ended, and the frame after it has painted. INSTALL_NET_IDLE counts
// exactly that. The deadline is only a bound on a hang, and a page that never goes idle is an error.
async function settled(cdp) {
  if (!(await waitFor(cdp, NET_IDLE, 30000)))
    throw new Error('the page never went idle: a request or a response body stayed in flight for 30 s');
  await evaluate(cdp, NEXT_FRAME);
  return true;
}

const profile = await mkdtemp(join(tmpdir(), 'vocalis-ssbulk-'));
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

const tick = ref => `(() => {
    const b = document.querySelector('#ssLib input[data-sspick="${ref}"]');
    b.checked = true; b.dispatchEvent(new Event('change', {bubbles: true})); return true; })()`;

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
  await waitFor(cdp, `document.readyState === 'complete'`);
  // 🔴 BOTH FLAGS — see the twin note in train_disk_browser_spec.mjs. `__uiReady` is "the
  // modules ran"; `__bootDone` is "the data arrived and the page is wired". Clicking a tab
  // between the two is a click into a page that has not attached its handlers yet, and it is
  // dropped in silence. This file and train_disk were the only two browser specs waiting on
  // `__uiReady` alone, and the only two that flaked on a dropped interaction today.
  await waitFor(cdp, `window.__uiReady === true && window.__bootDone === true`, 30000);
  await evaluate(cdp, INSTALL_NET_IDLE); // before the first click, so no request goes uncounted

  // Real clicks on the real tabs — `switchTab` is module-private since the 7.3 split.
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('[data-tab="voicestudio"]').click();
        document.querySelector('[data-vstab="stems"]').click();
        return true; })()`,
  );
  ok(
    await waitFor(cdp, `document.querySelectorAll('#ssLib input[data-sspick]').length === 4`, 15000),
    'every stem set in the library carries a checkbox',
  );
  // 🔴 AND THEN LET THE SECOND LOAD LAND. See `settled` — the tab click and the sub-tab click
  // each call `ssLoadAll()`, so the check above is satisfied by the first render while a second
  // is still in flight, and it repaints `#ssLib` wholesale. Ticking a box in that window leaves
  // the tick on a node that is about to be thrown away.
  await settled(cdp);
  ok(await evaluate(cdp, `document.getElementById('ssBulk').style.display === 'none'`), 'the bulk bar is hidden while nothing is ticked');

  // ── 🔴 a tick must not also expand the set ───────────────────────────────
  const before = await evaluate(cdp, `document.querySelectorAll('#ssLib .stemset.open').length`);
  await evaluate(
    cdp,
    `(() => {
        const b = document.querySelector('#ssLib input[data-sspick]');
        b.click(); return true; })()`,
  );
  const after = await evaluate(cdp, `document.querySelectorAll('#ssLib .stemset.open').length`);
  ok(after === before, `clicking the checkbox does NOT expand the set (${before} open before, ${after} after)`);
  ok(await evaluate(cdp, `document.querySelector('#ssLib input[data-sspick]').checked === true`), '…and the box really is ticked');
  ok(await evaluate(cdp, `document.getElementById('ssBulk').style.display !== 'none'`), 'the bulk bar appears as soon as one is ticked');
  // …and the header still toggles when clicked anywhere else, or the exclusion went too wide.
  await evaluate(cdp, `document.querySelector('#ssLib .stemhead .t').click()`);
  ok(
    await evaluate(cdp, `document.querySelectorAll('#ssLib .stemset.open').length === ${before + 1}`),
    'clicking the header itself still opens the set — the exclusion is narrow',
  );

  // ── the running total is real ────────────────────────────────────────────
  await evaluate(cdp, `(() => { document.getElementById('ssBulkNone').click(); return true; })()`);
  ok(await evaluate(cdp, `document.getElementById('ssBulk').style.display === 'none'`), 'Clear unticks everything and hides the bar again');
  await evaluate(cdp, tick('Alpha_aaaaaaaa'));
  await evaluate(cdp, tick('Beta_bbbbbbbb'));
  const note = await evaluate(cdp, `document.getElementById('ssBulkNote').textContent`);
  ok(/2 sets selected/.test(note) && /to reclaim/.test(note), `the bar totals what is ticked (${note})`);

  // ── 🔴 filtering must not carry a hidden tick into a delete ──────────────
  await evaluate(
    cdp,
    `(() => {
        const f = document.getElementById('ssLibFilter');
        f.value = 'Gamma'; f.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`,
  );
  ok(await waitFor(cdp, `document.querySelectorAll('#ssLib input[data-sspick]').length === 1`, 8000), 'the filter narrows the list');
  ok(
    await evaluate(cdp, `document.getElementById('ssBulk').style.display === 'none'`),
    'and a tick that scrolled out of the filter is NOT still selected — the DOM is the truth',
  );
  await evaluate(
    cdp,
    `(() => {
        const f = document.getElementById('ssLibFilter');
        f.value = ''; f.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`,
  );
  await waitFor(cdp, `document.querySelectorAll('#ssLib input[data-sspick]').length === 4`);

  // ── 8.9.14: FOLDERS ON THIS CARD, WHICH NOTHING IN tests/ HAD EVER TOUCHED ───────────────
  //
  // 🔴 `stems_library` WAS THE ONE SCOPE WITH NO FOLDER COVERAGE ANYWHERE. Every other panel's
  // ✚ Folder / ⇤ Remove from folder pair is asserted by some browser spec; a grep for
  // `data-vfout` across tests/ returned nothing for this card. So deleting the 4th argument at
  // its `folderAddButton` call would have silently removed the only way OUT of a folder here and
  // the whole suite would have stayed green — which is precisely how 8.9 shipped with ten lists
  // that could file rows and never unfile them.
  //
  // This card is also the worst place for that, because its tick set is shared with
  // `🗑 Delete selected` over gigabytes of separations.
  await evaluate(
    cdp,
    `(() => { document.getElementById('ssLibFilter').value = '';
      document.getElementById('ssLibFilter').dispatchEvent(new Event('input', {bubbles: true})); return true; })()`,
  );
  await waitFor(cdp, `document.querySelectorAll('#ssLib input[data-sspick]').length === 4`);

  ok(
    await evaluate(cdp, `!!document.querySelector('[data-vfadd="stems_library"]')`),
    'the ✚ Folder button is on the stems library toolbar',
  );
  ok(
    await evaluate(cdp, `!!document.querySelector('[data-vfout="stems_library"]')`),
    '⇤ Remove from folder is on the stems library toolbar too',
  );

  // Make the folder through the route rather than the ✚ prompt: this spec is about the two
  // toolbar verbs, and driving a modal here would be testing `promptForName` a third time.
  const fid = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/folders/stems_library', {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Sample Folder'})});
        const j = await r.json();
        document.getElementById('ssLibRefresh').click();
        return (j.folder && j.folder.id) || (j.id || ''); })()`,
  );
  ok(!!fid, `the folder was created server-side (${JSON.stringify(fid)})`);
  ok(await waitFor(cdp, `!!document.querySelector('#ssLib .vfolder')`, 8000), 'and its row appears in the library');

  // Tick ONE set and file it with ⇥ Move selected here, which lives on the folder row.
  const picked = await evaluate(
    cdp,
    `(() => { const b = document.querySelector('#ssLib input[data-sspick]');
        b.checked = true; b.dispatchEvent(new Event('change', {bubbles: true})); return b.dataset.sspick; })()`,
  );
  await evaluate(cdp, `document.querySelector('#ssLib .vfolder [data-fact="move"]').click()`);
  ok(
    await waitFor(
      cdp,
      `(async () => { const d = await (await fetch('/folders/stems_library')).json();
          return (d.assign || {})[${JSON.stringify(picked)}] === ${JSON.stringify(fid)}; })()`,
      8000,
    ),
    'ticking a stem set and pressing ⇥ Move selected here FILES it, and the server agrees',
  );

  // ⚠️ THE FOLDER MUST BE OPENED FIRST, and getting this wrong is how the first draft of this
  // block failed. Filing a row moves it INSIDE the folder, and a folder starts CLOSED — so the
  // set is not rendered, has no checkbox, and cannot be ticked. A `querySelector` for any tick
  // still matches one of the three sets left at the root, which is why the mistake reads as
  // "⇤ did not work" rather than as "there was nothing selected". One level of folders means a
  // filed row is reachable only through its folder; that IS the feature.
  ok(
    await waitFor(cdp, `document.querySelectorAll('#ssLib input[data-sspick]').length === 3`, 8000),
    '…and the filed set leaves the root list, because a closed folder hides its children',
  );
  await evaluate(cdp, `document.querySelector('#ssLib .vfolder [data-fact="open"]').click()`);
  ok(
    await waitFor(cdp, `!!document.querySelector('#ssLib input[data-sspick="' + ${JSON.stringify(picked)} + '"]')`, 8000),
    'opening the folder shows the set inside it, checkbox and all',
  );
  await evaluate(
    cdp,
    `(() => { const b = document.querySelector('#ssLib input[data-sspick="' + ${JSON.stringify(picked)} + '"]');
        if (!b) return false; b.checked = true; b.dispatchEvent(new Event('change', {bubbles: true})); return true; })()`,
  );
  await evaluate(cdp, `document.querySelector('[data-vfout="stems_library"]').click()`);
  ok(
    await waitFor(
      cdp,
      `(async () => { const d = await (await fetch('/folders/stems_library')).json();
          return !(d.assign || {})[${JSON.stringify(picked)}]; })()`,
      8000,
    ),
    '⇤ Remove from folder takes it back to the root, and the server agrees',
  );

  // 🔴 THE 8.9.14 FIX, PINNED. This list is RECONCILED, and a set's row HTML does not mention its
  // folder — so filing produces a byte-identical `__sig`, `reconcile` keeps the element and only
  // repositions it, and a checkbox's live `checked` SURVIVES the move. The panel therefore had to
  // clear the boxes itself. Before it did, the rows landed back at the root still ticked with
  // `🗑 Delete selected` live above them, reading "1 set selected · N GB to reclaim" — a
  // selection the user believes they already spent, aimed at the one irreversible button here.
  ok(
    await waitFor(cdp, `document.querySelectorAll('#ssLib input[data-sspick]:checked').length === 0`, 8000),
    '…and the ticks are CLEARED, so 🗑 Delete selected is not left armed with rows you just moved',
  );
  ok(
    await evaluate(cdp, `getComputedStyle(document.getElementById('ssBulk')).display === 'none'`),
    '…and the bulk bar is hidden rather than hanging over an empty selection',
  );

  // Put the card back the way the delete section below expects it: no folder, nothing ticked.
  await evaluate(
    cdp,
    `(async () => { await fetch('/folders/stems_library/' + ${JSON.stringify(fid)}, {method: 'DELETE'});
        document.getElementById('ssLibRefresh').click(); return true; })()`,
  );
  ok(
    await waitFor(
      cdp,
      `document.querySelectorAll('#ssLib input[data-sspick]').length === 4
        && !document.querySelector('#ssLib .vfolder')`,
      8000,
    ),
    'removing the folder returns all four sets to the main list, none of them deleted',
  );
  await settled(cdp);

  // ── Select all, then delete, in ONE request ──────────────────────────────
  await evaluate(cdp, `(() => { document.getElementById('ssBulkAll').click(); return true; })()`);
  ok(
    /4 sets selected/.test(await evaluate(cdp, `document.getElementById('ssBulkNote').textContent`)),
    'Select all ticks every visible set',
  );
  // Count the DELETE calls, so "one request" is measured rather than assumed.
  await evaluate(
    cdp,
    `(() => {
        window.__dels = [];
        const real = window.fetch;
        window.fetch = (u, o) => { if (o && o.method === 'DELETE' && String(u).includes('/stems/library'))
            window.__dels.push(JSON.parse(o.body).refs); return real(u, o); };
        return true; })()`,
  );
  await evaluate(cdp, `document.getElementById('ssBulkDel').click()`);
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`, 8000), 'it asks before deleting four sets');
  const body = await evaluate(cdp, `document.getElementById('mBody').innerText.replace(/\\s+/g, ' ')`);
  ok(
    /Deleting 4 sets/.test(body) && /of WAV files/.test(body),
    `the confirm names the count and the size (${JSON.stringify(body.slice(0, 70))})`,
  );
  ok(/Alpha/.test(body) && /Delta/.test(body), '…and enumerates them, so what will go is readable before the press');
  await evaluate(
    cdp,
    `(() => {
        [...document.querySelectorAll('#mActs button')].find(b => /Delete/.test(b.textContent)).click();
        return true; })()`,
  );
  ok(await waitFor(cdp, `document.querySelectorAll('#ssLib input[data-sspick]').length === 0`, 15000), 'all four sets leave the library');
  const dels = await evaluate(cdp, `window.__dels`);
  ok(dels.length === 1 && dels[0].length === 4, `and it went as ONE request carrying all four refs (${JSON.stringify(dels)})`);

  ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join(' | ') || 'none'})`);
  exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error(`  FAIL harness: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

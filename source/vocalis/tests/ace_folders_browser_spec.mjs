// Browser coverage for the ACE-Step library tick column and folder controls.
// Route tests verify filing; this spec verifies that the controls render and selection
// survives the two-second list reconciliation. It also confirms that removing an item
// from a folder reaches the server, since the reverse action is available only when rows
// are selectable. The row audio element is checked across reconciliation to catch rebuilds.

// Keep CDP expressions free of unescaped backticks because they are embedded in template literals.
// Usage: node ace_folders_browser_spec.mjs <base-url> <chrome-path>

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_FETCH_LOG, NEXT_FRAME, fetchCount, fetchCountAtLeast } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node ace_folders_browser_spec.mjs <base-url> <chrome-path>');
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

// ── CDP plumbing (the shape every browser spec in this tree uses) ─────────────
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

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // 🔴 `Promise.resolve(...)`, never `!!(expr)` — on a promise the latter is true synchronously
    // and always, so the wait returns on its first poll and waits for nothing. It fails as a PASS,
    // which is why it survived 25 specs; see feedback_a_wait_that_does_not_wait.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-acefold-'));
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
    // Wide enough that the four-track library grid is not fighting for room: the tick column is
    // asserted to cost the TITLE nothing, and a cramped window would make that assertion about
    // the window instead of about the column.
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
  // 🔴 WAIT FOR CHROME TO GO BEFORE DELETING ITS PROFILE — kill() returns at once, Windows holds
  // the handles a moment longer, and a swallowed EBUSY leaked 4.76 GB per suite run.
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

// 🔴 "N POLL CYCLES LATER" IS COUNTED IN POLLS, NOT IN SECONDS. `refreshAce` (ace/tray.js) fetches
// the library every 2 s and repaints from the answer. These were `sleep(5200)` and `sleep(5000)`,
// which are two or three cycles on an idle machine and fewer on a loaded one, so "survives two
// repaints" could be asserted after fewer than two. The fetch log records a response BEFORE the
// page paints from it, so the wait is for `repaints + 1` more responses: by the last one, the
// earlier ones have certainly been painted. Returns false if the poll stopped, which fails the
// check that calls this rather than passing it unproven.
const repaintsLater = async (cdp, repaints) => {
  const before = await evaluate(cdp, fetchCount('/acestep/library', 'GET'));
  return waitFor(cdp, fetchCountAtLeast('/acestep/library', before + repaints + 1, 'GET'), 30000);
};

// One song row, by the id the server stamps folders against.
const ROW = id => `document.querySelector('#aceLibrary .acesong[data-song="' + ${id} + '"]')`;
const TICK = id => `${ROW(id)}.querySelector('input.acetick')`;

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

  await cdp.send('Page.navigate', { url: baseUrl });
  // 🔴 BOTH FLAGS. `__uiReady` is "the modules ran"; `__bootDone` is "the data arrived and the
  // page is wired". A click between the two is dropped in silence.
  // ⚠️ 45s, not the default: this spec runs inside the full suite beside a dozen other workers,
  // and Chrome's cold start plus the module fetches genuinely exceeds 15s on a loaded box. The
  // CONDITION is unchanged, so nothing is weakened — only the patience.
  ok(
    await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`, 45000),
    'the page boots',
  );
  await evaluate(
    cdp,
    `(() => { window.__specErrors = [];
        window.addEventListener('error', e => window.__specErrors.push(String(e.message)));
        window.addEventListener('unhandledrejection', e => window.__specErrors.push('unhandled: ' + String(e.reason)));
        return true; })()`,
  );
  await evaluate(cdp, INSTALL_FETCH_LOG);

  // The tray only repaints while its panel is on screen (`visible()` in ace/tray.js), so the tab
  // click is not navigation here — it is what starts the list this whole spec is about.
  await evaluate(cdp, `document.querySelector('#tabs button[data-tab="acestep"]').click()`);
  const listed = await waitFor(cdp, `document.querySelectorAll('#aceLibrary .acesong:not(.acedlhead)').length === 2`, 20000);
  ok(listed, 'the ACE library renders both saved songs');
  if (!listed) throw new Error('the library never rendered — the fixture did not reach the page');

  // ── 1. every card has a tick, and it names the row's own identity ────────────────────────
  const ticks = await evaluate(
    cdp,
    `(() => {
        const rows = [...document.querySelectorAll('#aceLibrary .acesong:not(.acedlhead)')];
        return rows.map(r => {
          const b = r.querySelector('input.acetick');
          return {song: r.getAttribute('data-song'), vrow: r.getAttribute('data-vrow'),
                  ref: b ? b.getAttribute('data-acetick') : null,
                  type: b ? b.getAttribute('type') : null,
                  w: b ? Math.round(b.getBoundingClientRect().width) : 0}; }); })()`,
  );
  ok(
    ticks.length === 2 && ticks.every(t => t.type === 'checkbox' && t.w > 4),
    `🔴 every library card carries a tick, and it is painted (${JSON.stringify(ticks.map(t => t.w))})`,
  );
  // 🔴 ONE IDENTITY. The tick, the drag ref and the key the server stamps `folder` against must
  // all be the song's `id` — a second identity would agree with the first only by coincidence.
  ok(
    ticks.every(t => t.ref && t.ref === t.song && t.ref === t.vrow),
    'each tick names the SAME id the row is keyed and filed on',
  );

  // 🔴 THE TWO SONGS ARE IDENTIFIED BY WHAT THE FIXTURE MADE THEM, NEVER BY THEIR ORDER IN THE
  // LIST. The library sorts newest-first off `time.time()`, and two saves in one millisecond order
  // by whichever the clock happened to separate — an index into the rendered rows would make this
  // spec pass or fail on the resolution of the system clock. `A` is the song made from a template
  // (so the template filter KEEPS it) and `B` is the one that is not (so the filter HIDES it),
  // which is the property every step below actually depends on.
  const pair = await evaluate(
    cdp,
    `fetch('/acestep/library').then(r => r.json()).then(d => ({
        a: (d.songs.find(s => s.template_id) || {}).id,
        b: (d.songs.find(s => !s.template_id) || {}).id,
        tpl: (d.songs.find(s => s.template_id) || {}).template_id }))`,
  );
  ok(!!(pair.a && pair.b && pair.tpl && pair.a !== pair.b), `the fixture's two songs are distinguishable (${JSON.stringify(pair)})`);
  const A = JSON.stringify(String(pair.a));
  const B = JSON.stringify(String(pair.b));
  const TPL = JSON.stringify(String(pair.tpl));

  // ── 2. both toolbar buttons ─────────────────────────────────────────────────────────────
  const btns = await evaluate(
    cdp,
    `(() => { const g = s => { const b = document.querySelector(s);
          if (!b) return {missing: true};
          const r = b.getBoundingClientRect();
          return {text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height)}; };
        return {add: g('[data-vfadd="acelib"]'), out: g('[data-vfout="acelib"]')}; })()`,
  );
  ok(!btns.add.missing && btns.add.w > 20 && btns.add.h > 8, `the ✚ Folder button is on the library toolbar (${JSON.stringify(btns.add)})`);
  // 🔴 The control is rendered only when the panel supports `selected()`, so its presence also
  // confirms that the tick column is available.
  ok(
    !btns.out.missing && /Remove from folder/.test(btns.out.text || '') && btns.out.w > 40 && btns.out.h > 8,
    `⇤ Remove from folder is on the toolbar too (${JSON.stringify(btns.out)})`,
  );
  // ⚠️ The toolbar already carries the Download-as radio pair, and ⇤ Remove from folder is its
  // widest control. Check layout as well as markup because string assertions cannot detect wrapping.
  // ⚠️ CENTERS, NOT `top`. `#aceDlPick` is a 13px radio INPUT and the folder buttons are ~30px
  // tall, so they are on the same line with tops ~8px apart — comparing `top` fails on a toolbar
  // that is perfectly fine, which is exactly the sort of check that gets deleted rather than
  // fixed. Two controls are on one line when their vertical centers agree.
  // 🔴 8.9.14 — AND THE CENTERS ALONE PROVED NOTHING, SO THE TOOLBAR IS MEASURED AGAINST ITS
  // PANEL. `.aceacts` is `display:flex` with no `flex-wrap`, i.e. nowrap — and a nowrap flex
  // container's children share a line BY CONSTRUCTION, whatever the CSS does. So "their centers
  // agree" is not a fact about this toolbar, it is a fact about flexbox, and the assertion
  // degenerated to "these three selectors matched something".
  //
  // Measured, not reasoned about: a replica of one of these toolbars with a ~74-character button
  // label burst 226px OUTSIDE its panel and every center still agreed — and in the same mutation
  // the whole bar dropped onto a second line under its own <h2>, which is literally the defect
  // this check is named for. `scrollWidth > clientWidth` on the bar does not see it either: the
  // bar is itself a flex item and grows to fit its contents.
  //
  // What CAN fail is containment — the last control's right edge against the panel's. That is the
  // thing a wrapped or overflowing label actually breaks. The center comparison is kept below it
  // because it catches the different defect of ONE control dropping out of line with its
  // siblings, which containment cannot see.
  const bar = await evaluate(
    cdp,
    `(() => {
        const c = s => { const e = document.querySelector(s); if (!e) return -1;
          const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
        const box = s => { const e = document.querySelector(s); if (!e) return null;
          const p = e.closest('.panel') || e.closest('section') || document.body;
          return {right: Math.round(e.getBoundingClientRect().right),
                  panelRight: Math.round(p.getBoundingClientRect().right)}; };
        return {add: c('[data-vfadd="acelib"]'), out: c('[data-vfout="acelib"]'), pick: c('#aceDlPick'),
                fit: box('[data-vfout="acelib"]')}; })()`,
  );
  ok(
    bar.add > 0 && Math.abs(bar.add - bar.out) <= 2 && Math.abs(bar.out - bar.pick) <= 4,
    `✚ Folder, ⇤ Remove from folder and the Download-as picker sit on ONE line (${JSON.stringify(bar)})`,
  );
  ok(
    // 🔴 The zero guard: a hidden panel returns zero-sized rectangles, which satisfy ordinary
    // containment comparisons. Require nonzero panel and control bounds before checking fit.
    !!bar.fit && bar.fit.right > 0 && bar.fit.panelRight > 0 && bar.fit.right <= bar.fit.panelRight + 1,
    `⇤ Remove from folder stays INSIDE the library panel (${JSON.stringify(bar.fit)})`,
  );

  // ── 3. a tick is not a click on the card ────────────────────────────────────────────────
  // The checkbox sits inside `.acewhat`, which IS the row's open/close target — so a missing
  // guard opens the lyrics box, loads the song into the form above and scrolls the page, all from
  // a gesture that meant "include this one in the next move".
  await evaluate(cdp, `${TICK(A)}.click()`);
  ok(await evaluate(cdp, `${TICK(A)}.checked === true`), 'and the tick really is set by a plain click on the box');
  ok(
    await evaluate(
      cdp,
      `${ROW(A)}.querySelector('.acelyr').hidden === true && document.querySelectorAll('#aceLibrary .acesong.open').length === 0`,
    ),
    '🔴 ticking a song does NOT open it — no lyrics box, no row selected',
  );
  // …and the row itself still opens, i.e. the guard took the tick out and nothing else with it.
  await evaluate(cdp, `${ROW(A)}.querySelector('.acename').click()`);
  ok(await waitFor(cdp, `${ROW(A)}.querySelector('.acelyr').hidden === false`, 8000), 'clicking the row itself still opens the lyrics box');
  await evaluate(cdp, `${ROW(A)}.querySelector('.acename').click()`); // put it back
  await waitFor(cdp, `${ROW(A)}.querySelector('.acelyr').hidden === true`, 8000);

  // ── 4. the tick survives the 2 s repaint ────────────────────────────────────────────────
  // 🔴 THE CHECK THIS FILE CARRIES. Asserting straight after the click proves nothing: the box is
  // ticked in the DOM either way, and the list is not repainted until the next tick of the timer.
  // Sleeping past TWO full cycles is what separates a Set that survives from a DOM read that does
  // not — and stamping the <audio> proves the row was not rebuilt to achieve it.
  await evaluate(cdp, `(() => { ${ROW(A)}.querySelector('audio').__keep = 'acetick'; return true; })()`);
  // (Two repaints are waited for by counting library responses, not by a fixed `sleep(5200)`.)
  const twoRepaints = await repaintsLater(cdp, 2);
  ok(twoRepaints && (await evaluate(cdp, `${TICK(A)}.checked === true`)), '🔴 the tick survives two full 2 s repaints of the library');
  ok(
    await evaluate(cdp, `${ROW(A)}.querySelector('audio').__keep === 'acetick'`),
    'and the player was never rebuilt underneath it — the tick is not part of the row signature',
  );

  // ── 5. the filter drops the ticks it hides ──────────────────────────────────────────────
  // This panel's filter is the template picker above it (§4.5.3), and it re-fetches the library
  // narrowed to one template. A tick left pointing at a song the filter has hidden would travel
  // invisibly with the next ⇥ Move, so the render prunes to what is on screen.
  await evaluate(cdp, `${TICK(B)}.click()`);
  ok(await evaluate(cdp, `${TICK(A)}.checked === true && ${TICK(B)}.checked === true`), 'both songs can be ticked at once');
  await evaluate(
    cdp,
    `(() => { const s = document.getElementById('aceTemplate');
        s.value = ${TPL};
        s.dispatchEvent(new Event('change', {bubbles: true}));
        return s.value === ${TPL}; })()`,
  );
  ok(
    await waitFor(
      cdp,
      `(() => { const rows = [...document.querySelectorAll('#aceLibrary .acesong:not(.acedlhead)')];
          return rows.length === 1 && rows[0].getAttribute('data-song') === ${A}; })()`,
      15000,
    ),
    'selecting a template narrows the library to the song made from it',
  );
  // Clear the filter: the hidden song comes back, and it must come back UNTICKED.
  await evaluate(
    cdp,
    `(() => { const s = document.getElementById('aceTemplate');
        s.value = ''; s.dispatchEvent(new Event('change', {bubbles: true})); return true; })()`,
  );
  ok(
    await waitFor(cdp, `document.querySelectorAll('#aceLibrary .acesong:not(.acedlhead)').length === 2`, 15000),
    'and clearing it brings the whole library back',
  );
  ok(await evaluate(cdp, `${TICK(B)}.checked === false`), '🔴 the template filter drops the tick it hides');
  ok(await evaluate(cdp, `${TICK(A)}.checked === true`), 'while the song that stayed on screen keeps its tick');

  // ── 6. ⇥ Move selected here files the ticked song, on the SERVER ────────────────────────
  const made = await evaluate(
    cdp,
    `fetch('/folders/acelib', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({name:'Sample Folder'})}).then(r => r.json())`,
  );
  ok(made && /^f_[0-9a-f]{8}$/.test(made.id || ''), `a folder is created server-side (${made && made.id})`);
  const fid = JSON.stringify(String(made.id));
  ok(
    await waitFor(cdp, `document.querySelectorAll('#aceLibrary .vfolder').length === 1`, 15000),
    'the folder renders as a row in the library',
  );
  ok(
    await evaluate(cdp, `document.querySelector('#aceLibrary .vfolder [data-fact="move"]') !== null`),
    '⇥ Move selected here is offered on it — selectable is on for this panel now',
  );
  await evaluate(cdp, `document.querySelector('#aceLibrary .vfolder [data-fact="move"]').click()`);
  ok(
    await waitFor(
      cdp,
      `fetch('/acestep/library').then(r => r.json()).then(d =>
          (d.songs.find(s => s.id === ${A}) || {}).folder === ${fid}
          && !(d.songs.find(s => s.id === ${B}) || {}).folder)`,
      15000,
    ),
    '🔴 ⇥ Move selected here files the ticked song on the SERVER — and only the ticked one',
  );
  ok(
    await waitFor(cdp, `document.querySelector('#aceLibrary .vfolder .vfn').textContent.trim() === '(1)'`, 10000),
    'the folder counts the song it now holds',
  );
  // The selection is spent: those rows went where they were sent.
  ok(
    await waitFor(cdp, `document.querySelectorAll('#aceLibrary input.acetick:checked').length === 0`, 10000),
    'and the tick set is spent once the rows have gone',
  );

  // ── 7. a card inside an OPEN folder has a tick too ──────────────────────────────────────
  await evaluate(cdp, `document.querySelector('#aceLibrary .vfolder [data-fact="open"]').click()`);
  ok(await waitFor(cdp, `document.querySelector('#aceLibrary .vfolder.open') !== null`, 10000), 'the folder opens');
  const inside = await evaluate(
    cdp,
    `(() => { const f = document.querySelector('#aceLibrary .vfolder.open');
        const next = f.nextElementSibling;
        if (!next) return {none: true};
        const b = next.querySelector ? next.querySelector('input.acetick') : null;
        // ⚠️ MEASURE A CELL, NOT THE ROW. A .acesong is display:contents (its four cells are the
        // grid items), and an element that generates no box has an EMPTY client-rect list — so
        // getBoundingClientRect() on the row itself answers 0,0,0,0 and every geometry comparison
        // against it is quietly false. The first cell is the row, as far as layout is concerned.
        const cell = next.querySelector ? next.querySelector('.acewhat') : null;
        return {song: next.getAttribute('data-song'), tick: !!b,
                below: !!cell && cell.getBoundingClientRect().top >= f.getBoundingClientRect().bottom - 2,
                order: [...document.getElementById('aceLibrary').children].map(
                  k => k.className + ':' + (k.getAttribute('data-song') || '')).join(' | ')}; })()`,
  );
  ok(
    !inside.none && inside.song === String(pair.a) && inside.below,
    `the open folder is immediately followed by the song it holds (${JSON.stringify(inside)})`,
  );
  ok(!inside.none && inside.tick, '🔴 a card INSIDE an open folder carries a tick too — never conditional on where the row sits');

  // ── 8. ⇤ Remove from folder takes it back to the root ───────────────────────────────────
  // Unfiling needs a visible toolbar action, just like filing.
  await evaluate(cdp, `${TICK(A)}.click()`);
  ok(await evaluate(cdp, `${TICK(A)}.checked === true`), 'the filed song can be ticked where it sits, inside its folder');
  // Stamped BEFORE the un-file: coming back out of a folder moves the row up the list, and a
  // reorder that rebuilt the row instead of moving the node would stop a song mid-play — the whole
  // reason this list is reconciled rather than re-innerHTMLed. The same node afterward is the only
  // form of that check that can fail.
  await evaluate(cdp, `(() => { ${ROW(A)}.querySelector('audio').__keep = 'unfile'; return true; })()`);
  await evaluate(cdp, `document.querySelector('[data-vfout="acelib"]').click()`);
  ok(
    await waitFor(cdp, `fetch('/acestep/library').then(r => r.json()).then(d => !(d.songs.find(s => s.id === ${A}) || {}).folder)`, 15000),
    '🔴 ⇤ Remove from folder unfiles the song on the SERVER, not merely in the page',
  );
  // …and it is painted at the ROOT, i.e. after the divider that separates the folder block from
  // the unfiled rows. `folderRows` emits that divider whenever the scope has any folders, which
  // is what makes "back to the root" a place you can see rather than an absence.
  const rooted = `(() => { const kids = [...document.getElementById('aceLibrary').children];
          const gap = kids.findIndex(k => k.classList.contains('vfgap'));
          const row = kids.findIndex(k => k.getAttribute('data-song') === ${A});
          return {gap: gap, row: row, good: gap >= 0 && row > gap,
                  order: kids.map(k => k.className + ':' + (k.getAttribute('data-song') || '')).join(' | ')}; })()`;
  const rootedOk = await waitFor(cdp, `${rooted}.good`, 10000);
  ok(rootedOk, `🔴 ⇤ Remove from folder puts it back at the ROOT, below the divider (${JSON.stringify(await evaluate(cdp, rooted))})`);
  ok(
    await evaluate(cdp, `${ROW(A)}.querySelector('audio').__keep === 'unfile'`),
    'and the player survived the move out of the folder — the row was moved, not rebuilt',
  );
  // 🔴 AND THE FOLDER ON SCREEN AGREES WITH THE STORE. This is the assertion that catches a
  // reload which merely RE-RENDERS: every row's `.folder` stamp came down with the row, so
  // repainting from the rows already in hand puts the song straight back into the folder the
  // server has just taken it out of — the count stays (1) over a store that says (0), and it
  // self-corrects on the next unrelated refresh, i.e. it is reported later as something else.
  ok(
    await waitFor(cdp, `document.querySelector('#aceLibrary .vfolder .vfn').textContent.trim() === '(0)'`, 10000),
    '🔴 and the folder itself reads (0) again — the panel REFETCHED rather than re-rendering',
  );

  // ── 9. dragging a TICKED row takes the whole tick set ───────────────────────────────────
  // Dragging a checked row must carry the full selection (`dragRefs`), not only the row under the
  // pointer. This also verifies that `selected` reaches `folderWireDrag`.
  await evaluate(cdp, `${TICK(A)}.click()`);
  await evaluate(cdp, `${TICK(B)}.click()`);
  ok(await evaluate(cdp, `document.querySelectorAll('#aceLibrary input.acetick:checked').length === 2`), 'both rows are ticked again');
  // ⚠️ A MouseEvent CARRYING A REAL `DataTransfer`, NOT A `DragEvent`. Two reasons, and neither is
  // cosmetic. `test_webui_modules.py` resolves every identifier a CDP snippet names against what
  // the page can actually resolve, and its built-ins list has `MouseEvent`/`DataTransfer` but not
  // `DragEvent` — a spec that names one fails that guard by name, and the fix is never to widen the
  // list. And the code under test cannot tell the difference: `folderWireDrag` reads
  // `ev.dataTransfer` behind an `if` (a drag with no data is legal in this codebase's own note), so
  // every line of dragstart/dragover/drop runs exactly as it does under a real drag.
  // 📌 What this does NOT cover is the browser's own drag machinery — the pointer gesture that
  // decides a drag has started. `dragRefs`, which is the decision this check is about, is pinned
  // directly by `tests/voices_ui_smoke.mjs` as well.
  await evaluate(
    cdp,
    `(() => { const dt = new DataTransfer();
        const drag = t => { const e = new MouseEvent(t, {bubbles: true, cancelable: true});
                            Object.defineProperty(e, 'dataTransfer', {value: dt});
                            return e; };
        ${ROW(B)}.dispatchEvent(drag('dragstart'));
        const f = document.querySelector('#aceLibrary .vfolder');
        f.dispatchEvent(drag('dragover'));
        f.dispatchEvent(drag('drop'));
        return true; })()`,
  );
  ok(
    await waitFor(
      cdp,
      `fetch('/acestep/library').then(r => r.json()).then(d =>
          d.songs.length === 2 && d.songs.every(s => s.folder === ${fid}))`,
      15000,
    ),
    '🔴 dragging a ticked row takes the WHOLE tick set, not just the row under the cursor',
  );

  // ── 9b. ⇤ Remove from folder after a multi-select and delayed press ────────────────────────
  //
  // 🔴 Section 8 covers one immediately removed row. This case selects several rows and waits
  // across multiple 2s repaints before pressing Remove. Repainting must preserve the visible tick
  // set while the selection is being made.
  // 🔴 WAIT FOR THE PAINT BEFORE CLICKING, AND WAIT FOR THE TICK AFTER IT. The step above polls
  // the SERVER — it returns the instant the store says both songs are filed, which is BEFORE the
  // 2 s poll has repainted the page with them inside the folder. Clicking then is a race, and it
  // is one that only loses on a loaded box: this passed standalone every time and failed all four
  // of its checks inside the full suite, which is precisely the shape
  // `feedback_why_a_spec_passes_alone` warns about. Nothing asserted here is weakened — both rows
  // must still be present, and both ticks must still be set.
  ok(
    await waitFor(cdp, `document.querySelectorAll('#aceLibrary input.acetick').length === 2`, 15000),
    'both filed songs are painted inside the open folder, with ticks',
  );
  // 🔴 ONE AT A TIME, EACH WAITED FOR. Both clicks fired back to back lost one of the two ticks
  // under full-suite load and never once standalone: the list reconciles every 2 s, so a repaint
  // landing between the two round trips replaces the row the second click was aimed at, and the
  // click lands on a node that is no longer in the document — where it still toggles the box but
  // its change event reaches no delegated listener. Waiting for the first tick to be PAINTED
  // closes the window, and it is also what a person does.
  //
  // 🔴 …AND WAITING IS NOT ENOUGH, WHICH IS WHAT 9.7.0's FIX MISSED. A click swallowed by a node
  // replacement is LOST, not late: the box it toggled is detached, so no amount of waiting on the
  // live node will ever see `checked === true`. 9.7.0 hardened the SECOND click by waiting for the
  // first to paint, and the first click has exactly the same window against the repaint that
  // follows the server-side move — which is why this went red twice in the 9.7.3 full suite while
  // passing standalone and under eight-spec contention.
  //
  // ⚠️ NOTHING IS WEAKENED: the tick must still become true, inside the same overall budget. What
  // changes is the GESTURE — a person whose click did not take clicks again, on whatever node is
  // there now, which is precisely what re-evaluating the selector does. A retry cannot mask a
  // broken tick column, because a column that does not tick never goes green however often it is
  // pressed; it can only recover the one failure mode that is invisible to a wait.
  // ⚠️ `?.` ON BOTH, BECAUSE THE ROW ITSELF CAN BE MID-REPLACEMENT. `ROW(id)` is a
  // `querySelector` that answers null for the instant the reconcile has removed the old node and
  // not yet inserted the new one, and `null.querySelector` inside a `waitFor` is the throwing-poll
  // hazard rather than a failed check — it would kill the spec and present as a flake, which is
  // the very thing this block is being repaired for.
  const TICK_OF = id => `document.querySelector('#aceLibrary .acesong[data-song="' + ${id} + '"]')?.querySelector('input.acetick')`;
  const tickIt = async id => {
    for (let i = 0; i < 5; i++) {
      await evaluate(cdp, `${TICK_OF(id)}?.click()`);
      if (await waitFor(cdp, `${TICK_OF(id)}?.checked === true`, 2500)) return true;
    }
    return false;
  };
  ok(await tickIt(A), 'the first filed song ticks inside its folder');
  await tickIt(B);
  const bothTicked = await waitFor(cdp, `document.querySelectorAll('#aceLibrary input.acetick:checked').length === 2`, 10000);
  ok(
    bothTicked,
    'both filed songs are ticked where they sit, inside the open folder' +
      (bothTicked
        ? ''
        : ` (${JSON.stringify(
            await evaluate(
              cdp,
              `(() => ({rows: [...document.querySelectorAll('#aceLibrary .acesong:not(.acedlhead)')].map(r => r.getAttribute('data-song')),
                  ticks: [...document.querySelectorAll('#aceLibrary input.acetick')].map(b => b.dataset.acetick + ':' + b.checked)}))()`,
            ),
          )})`),
  );
  // Three repaints, waited for by counting library responses (this was `sleep(5000)`, "three full
  // poll cycles — the interval is 2 s", which under load was fewer).
  ok(
    (await repaintsLater(cdp, 3)) && (await evaluate(cdp, `document.querySelectorAll('#aceLibrary input.acetick:checked').length === 2`)),
    '🔴 and both ticks are still there three poll cycles later — the prune keeps what is on screen',
  );
  await evaluate(cdp, `document.querySelector('[data-vfout="acelib"]').click()`);
  ok(
    await waitFor(
      cdp,
      `fetch('/acestep/library').then(r => r.json()).then(d => d.songs.length === 2 && d.songs.every(s => !s.folder))`,
      15000,
    ),
    '🔴 ⇤ Remove from folder unfiles EVERY ticked row, not one of them',
  );
  ok(
    await waitFor(cdp, `document.querySelector('#aceLibrary .vfolder .vfn').textContent.trim() === '(0)'`, 10000),
    'and the folder reads (0) on screen — the panel refetched rather than re-rendering',
  );

  // ── 10. the tick column costs the title nothing ─────────────────────────────────────────
  // 🔴 The tick is a new flex item in the title cell of a four-track grid. Verify that adding it
  // preserves a one-line row and leaves the title wider than the player.
  const geom = await evaluate(
    cdp,
    `(() => { const r = document.querySelector('#aceLibrary .acesong:not(.acedlhead)');
        const el = r.querySelector('.acename');
        const cell = r.querySelector('.acewhat').getBoundingClientRect();
        const name = el.getBoundingClientRect();
        const box = r.querySelector('input.acetick').getBoundingClientRect();
        const pcell = r.querySelector('.acepcell').getBoundingClientRect();
        // NOTE no backticks in this comment - one would end the template literal.
        // THE MEASUREMENT IS THE COLUMN AND THE CLIPPING, NEVER THE RENDERED WIDTH OF THE TITLE.
        // .acename shrink-wraps its text when the cell has room to spare, so a bare width
        // assertion is really an assertion about how long the fixture song is called - it read
        // 124px for "Sample Track One" and 75px for "Sample Track Two" on the same layout. What can
        // actually go wrong is the tick squeezing the TRACK, and what that looks like on screen
        // is an ellipsized title, i.e. scrollWidth greater than clientWidth.
        return {cellW: Math.round(cell.width), cellH: Math.round(cell.height),
                nameW: Math.round(name.width), playerW: Math.round(pcell.width),
                clipped: el.scrollWidth > el.clientWidth + 1,
                boxTop: Math.round(box.top), nameTop: Math.round(name.top)}; })()`,
  );
  ok(geom.cellH < 64, `the row is still ONE line tall with the tick in it (${geom.cellH}px)`);
  // 🔴 The title track is 1.4fr and the player is 0.8fr. The tick and folder controls add items to
  // the title and actions cells, so check that neither reduces the title's share or clips its text.
  ok(
    geom.cellW > geom.playerW,
    `the title column still has room for a title — wider than the player (${geom.cellW}px vs ${geom.playerW}px)`,
  );
  ok(!geom.clipped, `and the title is not ellipsized at this width (${geom.nameW}px of ${geom.cellW}px)`);
  ok(
    Math.abs(geom.boxTop - geom.nameTop) < 24,
    `the tick sits on the title's line, not above it (Δ${Math.abs(geom.boxTop - geom.nameTop)}px)`,
  );

  // ── 9.0.12: THE TOOLBAR MUST NOT SIZE THE ROWS' ACTIONS COLUMN ────────────────────────
  //
  // 🔴 THE CHECK ABOVE WAS TRUE THROUGHOUT THE DEFECT IT IS NAMED FOR, WHICH IS WHY THIS ONE
  // EXISTS. Its own note says the folder buttons "are new items in the header's ACTIONS cell, and
  // either could have taken the width back out of the title without anything looking broken" -
  // and that is exactly what happened once ✖ Folder, ⇤ Remove from folder and 🎤 Send to Voice
  // Swap were all sitting there. The fourth track is auto-sized, so it takes the width of the
  // WIDEST cell in the column: the toolbar, at ~756px against a song row's own 526px of buttons.
  // Every row then carried ~230px of dead stripe to the right of ✕, and the player fell from
  // 401px to 317px. The action cell must size to its contents rather than stretch the song rows.
  //
  // `cellW > playerW` was 576 against 317 all the way through it. A column comparison cannot see
  // a column that is too WIDE - only the gap between a cell and the content it is supposed to be
  // sized by can, and that gap is the 14px of padding the outer cells carry and nothing else.
  const tail = await evaluate(
    cdp,
    `(() => { const row = document.querySelector('#aceLibrary .acesong:not(.acedlhead) > .acerow');
        const acts = row.querySelector('.aceacts');
        const kids = acts.children;
        const last = kids[kids.length - 1];
        const a = acts.getBoundingClientRect(), l = last.getBoundingClientRect();
        return {gap: Math.round(a.right - l.right), cellW: Math.round(a.width),
                lastLabel: (last.textContent || '').trim()}; })()`,
  );
  ok(
    tail.gap >= 0 && tail.gap <= 16,
    `the row's actions reach the right edge of their own cell - no dead track (gap ${tail.gap}px of ` +
      `${tail.cellW}px, after ${JSON.stringify(tail.lastLabel)})`,
  );

  // ── 9.0.12: THE TITLE HAS A FLOOR, AND BELOW IT THE PAGE SCROLLS ────────────────────
  //
  // The title track was minmax(0, 1.4fr), i.e. no floor - so
  // once the fixed tracks had taken theirs it absorbed the entire shortfall and every song read
  // as one character and an ellipsis while the player sat at its own 240px floor beside it.
  //
  // ⚠️ MEASURED AT A NARROWED VIEWPORT, BECAUSE THAT IS THE ONLY PLACE THE FLOOR EXISTS. At the
  // 1600px this spec runs at there is slack in the grid and the title is 457px wide with or
  // without a minimum, so a check taken here is vacuous. The override is cleared straight after
  // so nothing below it measures a window this spec has moved.
  // The page's own width is read back instead of sleeping `sleep(150)` for the resize to land: the
  // measurement below is only about the narrowed layout once `innerWidth` says it is narrowed.
  const wideWidth = await evaluate(cdp, `window.innerWidth`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (!(await waitFor(cdp, `window.innerWidth === 1100`, 10000)))
    throw new Error(`the 1100px viewport never took effect (innerWidth ${await evaluate(cdp, `window.innerWidth`)})`);
  await evaluate(cdp, NEXT_FRAME);
  const narrow = await evaluate(
    cdp,
    `(() => { const row = document.querySelector('#aceLibrary .acesong:not(.acedlhead) > .acerow');
        const t = row.querySelector('.acewhat').getBoundingClientRect();
        const p = row.querySelector('.acepcell').getBoundingClientRect();
        const d = document.documentElement;
        return {titleW: Math.round(t.width), playerW: Math.round(p.width),
                scrollW: d.scrollWidth, clientW: d.clientWidth}; })()`,
  );
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  // Wait for the window to be back at the width it had before (this was `sleep(150)`).
  if (!(await waitFor(cdp, `window.innerWidth === ${wideWidth}`, 10000)))
    throw new Error(`the viewport never returned to ${wideWidth}px (innerWidth ${await evaluate(cdp, `window.innerWidth`)})`);
  await evaluate(cdp, NEXT_FRAME);
  ok(narrow.titleW >= 240, `narrowed to 1100px the title column keeps its floor rather than collapsing (${narrow.titleW}px)`);
  ok(
    narrow.scrollW > narrow.clientW,
    `and the row overflows into a horizontal scrollbar instead, which is what he asked for ` +
      `(scrollWidth ${narrow.scrollW} vs clientWidth ${narrow.clientW})`,
  );

  const errs = await evaluate(cdp, `JSON.stringify(window.__specErrors || ['collector missing'])`);
  ok(errs === '[]', `no uncaught page errors (${errs})`);

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} FAILED` : '\nall browser assertions passed');
} catch (err) {
  console.error(`  FAIL ${err && err.stack ? err.stack : err}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

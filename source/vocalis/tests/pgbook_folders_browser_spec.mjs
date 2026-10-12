// Vocalis 8.9.13 — the tick column and the un-file gesture on the Playground clip library and
// the Books shelf, in a REAL browser.
//
// Browser coverage for selection and folder move/unfile controls in the Playground clip
// library and Books shelf. The tick column and reverse folder action must both be available.
// WHY A BROWSER, when both panels are string templates a regex could read:
//
//   🔴 "IN A FOLDER" IS A LAYOUT THAT ONLY EXISTS AFTER TWO ROUND TRIPS. A row is inside a folder
//      because the SERVER stamped `.folder` on it and the client happens to have that folder OPEN.
//      Neither fact is in the source. `folderRows` emits the open folder's children between its
//      own header row and the next folder, so "does a row inside an open folder have a tick" is a
//      question about a DOM built from a fetch, a piece of UI state and a template — and the
//      answer was allowed to be "no" on eight of the ten lists 8.9 touched.
//
//   🔴 REMOVING A ROW FROM A FOLDER MUST COMPLETE A ROUND TRIP. `⇤ Remove from folder` POSTs
//      `{refs, folder: null}` and then the panel has to REFETCH, because the stamps it is holding
//      are now stale. A panel that repainted from memory would draw the rows straight back into
//      the folder they just left and then "fix" itself on the next keystroke — which is a bug that
//      heals before you can point at it, and the exact shape no source-level check can see.
//
//   🔴 AND "THE TICK SET IS THE ONE THE BUTTON READS" IS A CLAIM ABOUT TWO CLOSURES. `⇥ Move
//      selected here` reads `folderWire`'s `selected()`; `⇤ Remove from folder` reads
//      `folderAddButton`'s. Both were written from the same `Set` — but a panel that passed the
//      option to one and not the other renders a page where every control looks present, one of
//      them silently does nothing, and both spellings are three characters apart in the source.
//      Pressing them is the only way to tell those apart.
//
//   ⚠️ THE FILTER CHECK IS THE QUIET ONE. A tick on a row the search box has hidden is still in
//      the set, so `⇥ Move selected here` files a row that is not on screen and never was. It
//      leaves no error, no log line and nothing to notice — just a clip in a folder nobody put it
//      in. Typing into the box and reading the count back is the whole test.
//
// The two panels are in one spec because they are one contract and one fixture: the Playground is
// a real `<table>` (folder rows are `<tr>`s — a `<div>` in a `<tbody>` is silently discarded by
// the parser) and the Books shelf is a `<div>` list, so running both proves the shape holds in
// both boxes rather than in whichever one happened to be written first.
//
// Usage: node pgbook_folders_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node pgbook_folders_browser_spec.mjs <base-url> <chrome-path>');
  process.exit(2);
}

// The four clips and three books the Python driver seeds. Refs, not positions: the library sorts
// newest-first and the shelf by render time, and a spec that indexed into either would be
// asserting the sort order every time it meant to assert the folder layout.
const PG_A = 'Test Voice/Sample_Track_01_ab12cd01';
const PG_B = 'Test Voice/Sample_Track_02_ab12cd02';
const PG_C = 'Test Voice/Sample_Track_03_ab12cd03';
const PG_D = 'Test Voice/Sample_Track_04_ab12cd04';
const BK_A = 'Sample_Book_01';
const BK_B = 'Sample_Book_02';
const BK_C = 'Sample_Book_03';

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
    //
    // 🔴 AND A POLL THAT THROWS IS "NOT YET", NOT "FAILED". `evaluate` turns a page exception into
    // a thrown Error, so before this try/catch ANY wait whose expression dereferenced a node was a
    // race rather than a wait: the FIRST poll landing mid-repaint killed the whole spec.
    // Caught live on 2026-08-20, in the full suite, at the BOOKS un-file step —
    // `document.querySelector('#libList .vfolder .vfn').textContent.includes('(0)')`. Pressing
    // ⇤ Remove from folder refetches and re-renders `#libList`, and there is a window in that
    // repaint with no `.vfolder` in the document at all. The wait is FOR the repaint, so polling
    // during it is the normal case, and the whole point of a wait is that the early polls are
    // false. It threw `TypeError: Cannot read properties of null` instead, after 42 green
    // assertions, and passed on the previous full run at the same commit — i.e. it presented as a
    // flake while being a defect in the wait itself.
    //
    // ⚠️ THE THROW IS REMEMBERED, NOT SWALLOWED. Retrying past an exception would otherwise trade
    // a loud wrong failure for a silent 20-second one: an expression with a typo in it throws on
    // every poll and would just time out, saying nothing about why. On timeout the last exception
    // is printed, so the diagnosis this used to give for free is still there — it simply arrives
    // when the condition never came true, rather than the first time it was not yet true.
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

// ── page-side helpers, built as source so every check reads the LIVE DOM ────────────────────
//
// 📌 EVERY ROW IS FOUND BY `data-vrow`, WHICH IS THE FOLDER MODEL'S OWN IDENTITY. That attribute
// is what `folderWireDrag` grabs and what `folderAssign` sends, so a spec that located rows any
// other way could pass while the panel ticked one identity and filed another — the exact bug
// this contract's rule 9 exists to forbid.
const rowOf = (hostId, ref) =>
  `[...document.querySelectorAll('#${hostId} [data-vrow]')].find(e => e.getAttribute('data-vrow') === ${JSON.stringify(ref)})`;

/** Tick (or untick) one row's checkbox, and read the answer back THROUGH the repaint the click
 *  may have caused — the Playground rebuilds its whole table on a tick, so the node clicked is
 *  detached by the time it returns and reading `.checked` off it would measure a corpse. */
const clickTick = (hostId, ref) => `(() => {
    const row = ${rowOf(hostId, ref)};
    if (!row) return 'NO ROW';
    const cb = row.querySelector('input[type="checkbox"]');
    if (!cb) return 'NO CHECKBOX';
    cb.click();
    const after = ${rowOf(hostId, ref)};
    const cb2 = after && after.querySelector('input[type="checkbox"]');
    return cb2 ? (cb2.checked ? 'ticked' : 'unticked') : 'ROW VANISHED'; })()`;

/** Does every row on screen have a tick? Returns `{rows, ticks}` so a shortfall names itself. */
const tickCount = hostId => `(() => {
    const rows = [...document.querySelectorAll('#${hostId} [data-vrow]')];
    return {rows: rows.length, ticks: rows.filter(r => r.querySelector('input[type="checkbox"]')).length,
            refs: rows.map(r => r.getAttribute('data-vrow'))}; })()`;

/** The Playground's tbody, top to bottom: 'F' a folder row, '-' the root divider, 'P' the inline
 *  player, otherwise the row's ref. This is the layout `folderRows` promises. */
const PG_LAYOUT = `(() => [...document.querySelectorAll('#pgLib tbody > tr')].map(tr =>
    tr.classList.contains('vfolderrow') ? 'F'
    : tr.classList.contains('vfgaprow') ? '-'
    : tr.classList.contains('pgplayrow') ? 'P'
    : (tr.getAttribute('data-vrow') || '?')))()`;

/** The same for the Books shelf, which is a div list rather than a table. */
const BK_LAYOUT = `(() => [...document.getElementById('libList').children].map(el =>
    el.classList.contains('vfolder') ? 'F'
    : el.classList.contains('vfgap') ? '-'
    : (el.getAttribute('data-vrow') || '?')))()`;

const setFilter = (id, value) => `(() => {
    const el = document.getElementById('${id}');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', {bubbles: true}));
    return el.value; })()`;

const checkedRefs = hostId => `[...document.querySelectorAll('#${hostId} [data-vrow]')]
    .filter(r => { const c = r.querySelector('input[type="checkbox"]'); return c && c.checked; })
    .map(r => r.getAttribute('data-vrow'))`;

/** `true` when every ref sits between the folder header and the root divider — i.e. is drawn
 *  INSIDE the open folder rather than merely present somewhere in the list. */
const insideOpenFolder = (layout, refs) => {
  const f = layout.indexOf('F');
  const gap = layout.indexOf('-');
  if (f < 0 || gap < 0) return false;
  return refs.every(r => {
    const i = layout.indexOf(r);
    return i > f && i < gap;
  });
};
const atRoot = (layout, refs) => {
  const gap = layout.indexOf('-');
  return gap >= 0 && refs.every(r => layout.indexOf(r) > gap);
};

const profile = await mkdtemp(join(tmpdir(), 'vocalis-pgbook-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Mute browser audio; host output devices are not test fixtures.
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
  // 🔴 BOTH FLAGS. `__uiReady` is "the modules ran"; `__bootDone` is "the data arrived and the
  // page is wired". A click between the two is dropped in silence.
  await waitFor(cdp, `window.__uiReady === true && window.__bootDone === true`, 30000);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // PART ONE — the Playground clip library (scope `playground_clips`, a real <table>)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await waitFor(cdp, `document.querySelectorAll('#pgLib tr.pgrow').length === 4`, 20000);

  const pgTicks = await evaluate(cdp, tickCount('pgLib'));
  ok(
    pgTicks.rows === 4 && pgTicks.ticks === 4,
    `PG: the library shows all four clips, each with a tick (${pgTicks.ticks}/${pgTicks.rows})`,
  );
  ok(
    await evaluate(cdp, `!!document.querySelector('[data-vfout="playground_clips"]')`),
    'PG: the ⇤ Remove from folder button is on the toolbar beside ✚ Folder',
  );
  // 🔴 LAID OUT BEFORE MEASURED, AND THIS IS A REAL FAILURE THAT HAPPENED. On 2026-08-19 a full
  // run caught this panel while it was still hidden: every rect came back 0, so `pgFit` was
  // {out:0,ref:0,panelRight:0,barH:0,btnH:0} — and BOTH containment assertions below PASSED on it
  // (`0 <= 0 + 1`, `0 <= 0 * 2`). Only the `a > 0` in the line check noticed, by accident.
  // ⚠️ A hidden element does not report "hidden"; `getBoundingClientRect()` just answers zeros,
  // and zero satisfies every "fits inside" test ever written. Waiting is the fix for the race;
  // the `btnH > 0` guards below are the fix for the vacuity, and BOTH are needed — either one
  // alone leaves a check that can pass while measuring nothing.
  //
  // 🔴 AND IF IT TIMES OUT, IT SAYS WHY. This failed once in a full 32-worker run with every
  // geometry value zero and passed in isolation — the "panel not rendered" shape, which for
  // clips_favorites turned out to be a leaked job making the page steal its own tab. That drain
  // is in conftest now, so this arrives by a route it does not cover; naming that route on the
  // next occurrence is cheaper than a third session guessing at it.
  //
  // ⚠️ THE TIMEOUT IS UNCHANGED, deliberately. The clips wait was CORRECT and its subject had been
  // navigated away from — widening it would have waited longer for something never coming back,
  // and buried the cause. Diagnose, do not widen.
  const pgToolbarUp = await waitFor(
    cdp,
    `(() => { const e = document.querySelector('[data-vfadd="playground_clips"]');
        return !!e && e.getBoundingClientRect().top > 0; })()`,
  );
  ok(
    pgToolbarUp,
    'PG: the clip library toolbar is laid out before anything measures it' +
      (pgToolbarUp
        ? ''
        : ' — ' +
          JSON.stringify(
            await evaluate(
              cdp,
              `(() => {
                  const e = document.querySelector('[data-vfadd="playground_clips"]');
                  if (!e) return { toolbar: 'not in the DOM at all' };
                  let hidden = null;
                  for (let n = e; n && n !== document.documentElement; n = n.parentElement)
                      if (getComputedStyle(n).display === 'none') {
                          hidden = n.tagName + '#' + (n.id || '') + '[' + (n.dataset.panel || '') + ']'; break; }
                  const active = document.querySelector('#tabs button.active');
                  return { rendered: e.offsetParent !== null,
                           top: e.getBoundingClientRect().top,
                           firstHiddenAncestor: hidden || 'none - laid out, just not below zero',
                           activeTab: active ? active.dataset.tab : '(none)',
                           bootDone: window.__bootDone === true,
                           scrollY: window.scrollY }; })()`,
            ),
          )),
  );
  ok(
    await evaluate(
      cdp,
      `(() => {
          const t = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : -1; };
          const a = t('[data-vfadd="playground_clips"]'), o = t('[data-vfout="playground_clips"]'), r = t('#pgLibRefresh');
          return a > 0 && a === o && o === r; })()`,
    ),
    'PG: ✚ Folder, ⇤ Remove from folder and the refresh beside them sit on ONE line',
  );
  // 🔴 8.9.14 — CONTAINMENT, BECAUSE THE COMPARISON ABOVE CANNOT FAIL. This toolbar is a flex
  // container with no `flex-wrap`, so its children share a line BY CONSTRUCTION and three equal
  // `top` values are a fact about flexbox, not about this bar. Measured rather than argued: a
  // replica carrying a ~74-character button label burst 226px outside its panel with every `top`
  // still equal, and in the same mutation `.logwrap`'s own `flex-wrap:wrap` dropped the whole bar
  // onto a second line under its `<h2>` — literally the defect the line above is named for.
  // `scrollWidth > clientWidth` does not see it either: the bar is a flex item and grows to fit.
  // The last control's right edge against the panel's is what a wrapped or overflowing label
  // actually breaks, so that is what is asserted.
  // ⚠️ MEASURED WITH THE PANEL SQUEEZED TO 900px, AND THAT IS THE WHOLE POINT. The browser runs
  // at 1600px wide, where this toolbar has hundreds of pixels of slack — so a containment check
  // at the natural width passes under every mutation and is just the vacuous check again in a
  // new shape. `folders_browser_spec.mjs` already learned this once: an equivalent width
  // assertion "passed under every mutation" at 1200px and only became a test at 560px.
  // 900px is a real window, and it is the width the toolbar overflow was measured at.
  // The panel's inline width is restored immediately so nothing below sees a narrowed layout.
  const pgFit = await evaluate(
    cdp,
    `(() => {
        const e = document.querySelector('[data-vfout="playground_clips"]');
        const r = document.querySelector('#pgLibRefresh');
        if (!e || !r) return null;
        const p = e.closest('.panel') || e.closest('section') || document.body;
        const prev = p.style.width;
        p.style.width = '900px';
        void p.offsetWidth;
        const pr = Math.round(p.getBoundingClientRect().right);
        const out = {out: Math.round(e.getBoundingClientRect().right),
                     ref: Math.round(r.getBoundingClientRect().right), panelRight: pr,
                     barH: Math.round(r.parentElement.getBoundingClientRect().height),
                     btnH: Math.round(r.getBoundingClientRect().height)};
        p.style.width = prev;
        void p.offsetWidth;
        return out; })()`,
  );
  ok(
    // `btnH > 0` FIRST: a hidden panel measures as all zeros and every comparison below is then
    // trivially true. The guard is what makes this a test rather than a formality.
    !!pgFit && pgFit.btnH > 0 && pgFit.panelRight > 0 && pgFit.out <= pgFit.panelRight + 1 && pgFit.ref <= pgFit.panelRight + 1,
    `PG: the folder buttons and the refresh stay INSIDE a 900px panel (${JSON.stringify(pgFit)})`,
  );
  // 🔴 AND THE BAR IS STILL ONE ROW TALL AT THAT WIDTH. This is the half the right-edge check
  // cannot see: `.logwrap` sets `flex-wrap:wrap`, so when the controls stop fitting the bar does
  // not overflow — it WRAPS, every control moves down together, and all three `top` values stay
  // equal to each other while the toolbar is now two rows under its own heading. Comparing the
  // bar's height to one button's height is what actually detects that.
  ok(
    !!pgFit && pgFit.btnH > 0 && pgFit.barH <= pgFit.btnH * 2,
    `PG: the toolbar is still ONE row tall at 900px (${JSON.stringify(pgFit)})`,
  );

  // ── 8.9.14: the tick cell's click target, MEASURED, because two readings of it disagreed ──
  //
  // `pg/playground.js` records above `pgRow` that this cell needs no click guard, on the strength
  // of an `elementFromPoint` probe: the column is pinned to 24px by its header, so the 13px
  // checkbox overflows its content box and "no point inside the cell misses the input". A later
  // review recomputed it — 24px border-box minus 8px padding each side leaves an 8px CONTENT box,
  // and `.pgtable td{vertical-align:middle}` on a row whose Name cell carries badge pills makes
  // the row 40-60px tall against a ~19px checkbox margin-box — and concluded the top and bottom
  // strips must be exposed.
  //
  // 🔴 ONE OF THOSE IS WRONG, AND THE CONSEQUENCE IS NOT COSMETIC: a click that misses falls
  // through to the row handler and calls `pgLoadClip`, which REWRITES the text and settings in
  // the editor above, discarding unsaved input. So it is measured here rather than argued, in the
  // real browser, against the real stylesheet — and the assertion is the one that matters to the
  // user (does a click in this cell change the editor?), not the geometry that explains it.
  // ⚠️ THE ASSERTION IS ON BEHAVIOR, NOT GEOMETRY, and that distinction is the whole lesson here.
  // A geometry check ("the box covers the cell") is what the old note relied on, and it is both
  // fragile and beside the point: what matters is whether a click in this cell can destroy the
  // editor's contents. Measure THAT, and the cell can be any size it likes.
  const tickHazard = await evaluate(
    cdp,
    `(() => {
        const td = document.querySelector('#pgLib tr.pgrow td.pgtick');
        if (!td) return {err: 'no td.pgtick — the guard the row handler bails on is gone'};
        td.scrollIntoView({block: 'center'});
        const ta = document.getElementById('pgText');
        const sentinel = 'UNSAVED WORK THE USER WAS TYPING';
        ta.value = sentinel;
        const r = td.getBoundingClientRect();
        // The corner: as far from the checkbox as it is possible to be while still inside the cell.
        const x = r.left + 2.5, y = r.top + 2.5;
        const hit = document.elementFromPoint(x, y);
        if (hit) hit.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: x, clientY: y}));
        return {cell: [Math.round(r.width), Math.round(r.height)],
                hitTag: hit ? hit.tagName : 'null', kept: ta.value === sentinel}; })()`,
  );
  ok(
    !tickHazard.err && tickHazard.kept,
    `a click in the tick cell's corner does NOT rewrite the editor — unsaved text survives (${JSON.stringify(tickHazard)})`,
  );

  // ── ticking is not clicking. The checkbox lives INSIDE the row whose click loads the clip into
  // the editor above, opens the inline player and moves the selection — all of it off-screen from
  // where the pointer was. `pgLoadClip` is what must NOT run.
  const pgBefore = await evaluate(
    cdp,
    `({text: document.getElementById('pgText').value,
       active: document.querySelectorAll('#pgLib tr.pgrow.active').length,
       player: document.querySelectorAll('#pgLib tr.pgplayrow').length})`,
  );
  ok((await evaluate(cdp, clickTick('pgLib', PG_A))) === 'ticked', `PG: ${PG_A} takes a tick`);
  const pgAfter = await evaluate(
    cdp,
    `({text: document.getElementById('pgText').value,
       active: document.querySelectorAll('#pgLib tr.pgrow.active').length,
       player: document.querySelectorAll('#pgLib tr.pgplayrow').length})`,
  );
  ok(
    pgAfter.text === pgBefore.text && pgAfter.active === pgBefore.active && pgAfter.player === pgBefore.player,
    `PG: ticking a row does not load the clip — no editor rewrite, no inline player, no row lit ` +
      `(${JSON.stringify(pgBefore)} -> ${JSON.stringify(pgAfter)})`,
  );

  // 🔴 AND NEITHER DOES A CLICK IN THE TICK CELL'S PADDING (8.9.13). The guard above catches the
  // checkbox itself (`tagName === 'INPUT'`), so ticking was always safe — but a click a few pixels
  // beside a 13px box, still inside its `<td>`, fell through to the row handler and ran
  // `pgLoadClip`, which REWRITES the text and settings in the editor above. Aiming at the box and
  // getting the editor overwritten is the wrong verb, not a near miss. Books never had it: its
  // checkbox sits in a `<label class="vpick">` and the card handler bails on the label.
  // The click is aimed at the CELL, deliberately missing the input — `elementFromPoint` at the
  // cell's right edge, so this measures where the pointer really lands rather than trusting a
  // selector.
  ok((await evaluate(cdp, clickTick('pgLib', PG_B))) === 'ticked', `PG: ${PG_B} takes a tick too`);
  ok(
    (await evaluate(cdp, `document.getElementById('pgDelSel').textContent`)).includes('(2)'),
    'PG: the tick set is the one the panel reads — Delete selected counts both of them',
  );

  // ── ⇥ Move selected here ──────────────────────────────────────────────────
  await evaluate(cdp, `(() => { document.querySelector('#pgLib [data-fact="move"]').click(); return true; })()`);
  ok(
    await waitFor(cdp, `document.querySelector('#pgLib .vfolderrow .vfn').textContent.includes('(2)')`),
    'PG: ⇥ Move selected here files the ticked clips — the folder row counts two',
  );
  let pgLayout = await evaluate(cdp, PG_LAYOUT);
  ok(
    atRoot(pgLayout, [PG_C, PG_D]) && !pgLayout.includes(PG_A) && !pgLayout.includes(PG_B),
    `PG: and they left the root — the closed folder is holding them (${JSON.stringify(pgLayout)})`,
  );
  ok(
    !(await evaluate(cdp, `document.getElementById('pgDelSel').textContent`)).includes('('),
    'PG: the move cleared the ticks — the clips went where they were sent',
  );

  // ── 🔴 SELECT-ALL MUST NOT REACH WHAT THE FOLDER IS HIDING. A header checkbox that ticked the
  // whole dataset and then handed it to `⇥ Move selected here` would file two clips nothing on
  // screen mentions. `pgVisible` is published by the render for exactly this reason.
  await evaluate(cdp, `(() => { document.getElementById('pgSelAll').click(); return true; })()`);
  const swept = await evaluate(cdp, checkedRefs('pgLib'));
  ok(
    swept.length === 2 && !swept.includes(PG_A) && !swept.includes(PG_B),
    `PG: select-all cannot reach the rows a closed folder is hiding (${JSON.stringify(swept)})`,
  );
  await evaluate(cdp, `(() => { document.getElementById('pgSelAll').click(); return true; })()`);

  // ── open the folder: the children render between the header and the divider, and rule 1 says
  // every one of them carries a tick — the half of the contract eight panels got wrong.
  await evaluate(cdp, `(() => { document.querySelector('#pgLib [data-fact="open"]').click(); return true; })()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#pgLib tr.pgrow').length === 4`),
    'PG: opening the folder brings its clips back on screen',
  );
  pgLayout = await evaluate(cdp, PG_LAYOUT);
  const pgOpenTicks = await evaluate(cdp, tickCount('pgLib'));
  ok(
    insideOpenFolder(pgLayout, [PG_A, PG_B]) && pgOpenTicks.rows === 4 && pgOpenTicks.ticks === 4,
    `PG: every row INSIDE the open folder carries a tick (${pgOpenTicks.ticks}/${pgOpenTicks.rows}, ${JSON.stringify(pgLayout)})`,
  );

  ok((await evaluate(cdp, clickTick('pgLib', PG_A))) === 'ticked', 'PG: ticking a row inside the open folder registers');
  ok((await evaluate(cdp, clickTick('pgLib', PG_B))) === 'ticked', 'PG: and so does its neighbor inside the folder');

  // ── 🔴 ⇤ Remove from folder — VERIFY THE COMPLETE ROUND TRIP ────────
  await evaluate(cdp, `(() => { document.querySelector('[data-vfout="playground_clips"]').click(); return true; })()`);
  ok(
    await waitFor(cdp, `document.querySelector('#pgLib .vfolderrow .vfn').textContent.includes('(0)')`),
    'PG: ⇤ Remove from folder takes them back out to the root — the folder empties',
  );
  pgLayout = await evaluate(cdp, PG_LAYOUT);
  ok(
    atRoot(pgLayout, [PG_A, PG_B, PG_C, PG_D]),
    `PG: and all four clips are below the divider again, unfiled (${JSON.stringify(pgLayout)})`,
  );

  // 🔴 …AND IT CLEARS THE TICKS, because an un-file IS a `move` — `folderAddButton` names the
  // action to its `reload` now, and the rows have gone where they were sent. Leaving a spent
  // selection ticked is how `Delete selected` gets handed a set the user believes they already
  // used, which is the one direction that is not reversible.
  ok(
    !(await evaluate(cdp, `document.getElementById('pgDelSel').textContent`)).includes('('),
    'PG: the un-file cleared the ticks too — an un-file is a move like any other',
  );

  // ── the filter drops the ticks it hides ──────────────────────────────────
  // Two ticks, one of which the search box is about to hide. Without the prune the hidden one is
  // still in the set, and the next ⇥ Move files a clip that was never on screen.
  ok((await evaluate(cdp, clickTick('pgLib', PG_A))) === 'ticked', 'PG: re-ticking one clip for the filter check');
  ok((await evaluate(cdp, clickTick('pgLib', PG_B))) === 'ticked', 'PG: and a second one, which the filter will hide');
  await evaluate(cdp, setFilter('pgSearch', 'sample track 01'));
  ok(await waitFor(cdp, `document.querySelectorAll('#pgLib tr.pgrow').length === 1`), 'PG: filtering to one clip leaves one row on screen');
  ok(
    (await evaluate(cdp, `document.getElementById('pgDelSel').textContent`)).includes('(1)'),
    'PG: a filter drops the ticks it hides — the hidden row is out of the set, not merely off screen',
  );
  await evaluate(cdp, setFilter('pgSearch', ''));
  await waitFor(cdp, `document.querySelectorAll('#pgLib tr.pgrow').length === 4`);
  const pgLeft = await evaluate(cdp, checkedRefs('pgLib'));
  ok(
    pgLeft.length === 1 && pgLeft[0] === PG_A && (await evaluate(cdp, `document.getElementById('pgDelSel').textContent`)).includes('(1)'),
    `PG: and the tick is GONE, not merely hidden — clearing the box does not bring it back (${JSON.stringify(pgLeft)})`,
  );

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // PART TWO — the Books shelf (scope `books`, a <div> list)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('[data-tab="book"]').click();
        document.querySelector('[data-bktab="library"]').click();
        return true; })()`,
  );
  await waitFor(cdp, `document.querySelectorAll('#libList .bookcard').length === 3`, 20000);

  const bkTicks = await evaluate(cdp, tickCount('libList'));
  ok(
    bkTicks.rows === 3 && bkTicks.ticks === 3,
    `BOOKS: the shelf shows all three books, each with a tick (${bkTicks.ticks}/${bkTicks.rows})`,
  );
  ok(
    await evaluate(cdp, `!!document.querySelector('[data-vfout="books"]')`),
    'BOOKS: the ⇤ Remove from folder button is on the toolbar beside ✚ Folder',
  );
  ok(
    await evaluate(
      cdp,
      `(() => {
          const t = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : -1; };
          const a = t('[data-vfadd="books"]'), o = t('[data-vfout="books"]'), r = t('#libRefresh');
          return a > 0 && a === o && o === r; })()`,
    ),
    'BOOKS: ✚ Folder, ⇤ Remove from folder and the refresh beside them sit on ONE line',
  );
  // See the PG notes above — same reasoning, same 900px squeeze, same two halves.
  const bkFit = await evaluate(
    cdp,
    `(() => {
        const e = document.querySelector('[data-vfout="books"]');
        const r = document.querySelector('#libRefresh');
        if (!e || !r) return null;
        const p = e.closest('.panel') || e.closest('section') || document.body;
        const prev = p.style.width;
        p.style.width = '900px';
        void p.offsetWidth;
        const pr = Math.round(p.getBoundingClientRect().right);
        const out = {out: Math.round(e.getBoundingClientRect().right),
                     ref: Math.round(r.getBoundingClientRect().right), panelRight: pr,
                     barH: Math.round(r.parentElement.getBoundingClientRect().height),
                     btnH: Math.round(r.getBoundingClientRect().height)};
        p.style.width = prev;
        void p.offsetWidth;
        return out; })()`,
  );
  ok(
    // Same zero guard as the clip library above — this side happened to be laid out on the run
    // that exposed it, which is exactly why it needs the guard too.
    !!bkFit && bkFit.btnH > 0 && bkFit.panelRight > 0 && bkFit.out <= bkFit.panelRight + 1 && bkFit.ref <= bkFit.panelRight + 1,
    `BOOKS: the folder buttons and the refresh stay INSIDE a 900px panel (${JSON.stringify(bkFit)})`,
  );
  ok(
    !!bkFit && bkFit.btnH > 0 && bkFit.barH <= bkFit.btnH * 2,
    `BOOKS: the toolbar is still ONE row tall at 900px (${JSON.stringify(bkFit)})`,
  );

  const bkBefore = await evaluate(
    cdp,
    `({title: document.getElementById('outTitle').textContent,
       active: document.querySelectorAll('#libList .bookcard.active').length})`,
  );
  ok((await evaluate(cdp, clickTick('libList', BK_A))) === 'ticked', `BOOKS: ${BK_A} takes a tick`);
  const bkAfter = await evaluate(
    cdp,
    `({title: document.getElementById('outTitle').textContent,
       active: document.querySelectorAll('#libList .bookcard.active').length})`,
  );
  ok(
    bkAfter.title === bkBefore.title && bkAfter.active === bkBefore.active,
    `BOOKS: ticking a card does not open the book — the Chapters panel below is untouched ` +
      `(${JSON.stringify(bkBefore)} -> ${JSON.stringify(bkAfter)})`,
  );
  ok((await evaluate(cdp, clickTick('libList', BK_B))) === 'ticked', `BOOKS: ${BK_B} takes a tick too`);

  await evaluate(cdp, `(() => { document.querySelector('#libList [data-fact="move"]').click(); return true; })()`);
  ok(
    await waitFor(cdp, `document.querySelector('#libList .vfolder .vfn').textContent.includes('(2)')`),
    'BOOKS: ⇥ Move selected here files the ticked books — the folder row counts two',
  );
  let bkLayout = await evaluate(cdp, BK_LAYOUT);
  ok(
    atRoot(bkLayout, [BK_C]) && !bkLayout.includes(BK_A) && !bkLayout.includes(BK_B),
    `BOOKS: and they left the shelf root — the closed folder is holding them (${JSON.stringify(bkLayout)})`,
  );
  ok((await evaluate(cdp, checkedRefs('libList'))).length === 0, 'BOOKS: the move cleared the ticks — the books went where they were sent');

  await evaluate(cdp, `(() => { document.querySelector('#libList [data-fact="open"]').click(); return true; })()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#libList .bookcard').length === 3`),
    'BOOKS: opening the folder brings its books back on screen',
  );
  bkLayout = await evaluate(cdp, BK_LAYOUT);
  const bkOpenTicks = await evaluate(cdp, tickCount('libList'));
  ok(
    insideOpenFolder(bkLayout, [BK_A, BK_B]) && bkOpenTicks.rows === 3 && bkOpenTicks.ticks === 3,
    `BOOKS: every card INSIDE the open folder carries a tick (${bkOpenTicks.ticks}/${bkOpenTicks.rows}, ${JSON.stringify(bkLayout)})`,
  );

  ok((await evaluate(cdp, clickTick('libList', BK_A))) === 'ticked', 'BOOKS: ticking a card inside the open folder registers');
  ok((await evaluate(cdp, clickTick('libList', BK_B))) === 'ticked', 'BOOKS: and so does its neighbor inside the folder');

  await evaluate(cdp, `(() => { document.querySelector('[data-vfout="books"]').click(); return true; })()`);
  ok(
    await waitFor(cdp, `document.querySelector('#libList .vfolder .vfn').textContent.includes('(0)')`),
    'BOOKS: ⇤ Remove from folder takes them back out to the root — the folder empties',
  );
  bkLayout = await evaluate(cdp, BK_LAYOUT);
  ok(atRoot(bkLayout, [BK_A, BK_B, BK_C]), `BOOKS: and all three books are below the divider again, unfiled (${JSON.stringify(bkLayout)})`);

  ok(
    (await evaluate(cdp, checkedRefs('libList'))).length === 0,
    'BOOKS: the un-file cleared the ticks too — an un-file is a move like any other',
  );

  // The shelf never repaints on a tick (that would close the Chapters panel under it), so the
  // checkbox state after a FILTER round trip is the honest read of the module `Set` — the boxes
  // on screen were written from it by `libRow`, not left over from the browser.
  ok((await evaluate(cdp, clickTick('libList', BK_A))) === 'ticked', 'BOOKS: re-ticking one book for the filter check');
  ok((await evaluate(cdp, clickTick('libList', BK_B))) === 'ticked', 'BOOKS: and a second one, which the filter will hide');
  await evaluate(cdp, setFilter('libFilter', 'sample book 01'));
  ok(
    await waitFor(cdp, `document.querySelectorAll('#libList .bookcard').length === 1`),
    'BOOKS: filtering to one book leaves one card on screen',
  );
  await evaluate(cdp, setFilter('libFilter', ''));
  await waitFor(cdp, `document.querySelectorAll('#libList .bookcard').length === 3`);
  const bkLeft = await evaluate(cdp, checkedRefs('libList'));
  ok(
    bkLeft.length === 1 && bkLeft[0] === BK_A,
    `BOOKS: a filter drops the ticks it hides, and clearing the box does not bring them back (${JSON.stringify(bkLeft)})`,
  );

  // ── 9.5.7 — THE SHELF'S ORDER ──────────────────────────────────────────────────────────────
  //
  // The Book library defaults to newest-first. Its drop-down changes order without fetching
  // `/library` or `/book/jobs` again, so this verifies the sort moved into `renderLibrary`.
  //
  // 🔴 THE FIXTURE'S DATES ARE A PERMUTATION OF ITS TITLES, not a ramp along them: Book 01 oldest,
  // Book 03 middle, Book 02 newest. Dated in title order, sorting by date ASCENDING and sorting by
  // title produce the identical three rows in the identical three places — so an A→Z check would
  // pass against a `libOrder` that had lost its title branch altogether. Measured, not assumed:
  // mutating that branch to read `rendered_at` was a no-op against the ramp and fails against this.
  const bkOrder = `[...document.querySelectorAll('#libList .bookcard')].map(el => el.getAttribute('data-vrow'))`;
  const setSort = v => `(() => {
      const el = document.getElementById('libSort');
      el.value = ${JSON.stringify(v)};
      el.dispatchEvent(new Event('change', {bubbles: true}));
      return el.value; })()`;

  ok(
    (await evaluate(cdp, bkOrder)).join(',') === [BK_B, BK_C, BK_A].join(','),
    `BOOKS: the shelf opens newest-render-first, which is the order it has always had (${JSON.stringify(await evaluate(cdp, bkOrder))})`,
  );
  await evaluate(cdp, setSort('name'));
  ok(
    (await evaluate(cdp, bkOrder)).join(',') === [BK_A, BK_B, BK_C].join(','),
    `BOOKS: Title A→Z turns it over (${JSON.stringify(await evaluate(cdp, bkOrder))})`,
  );
  // ⚠️ AND IT DOES NOT REFETCH. `renderLibrary` re-renders from `state.books`; a control wired to
  // `loadLibrary` would work on screen and quietly hit two routes on every change. The tick is the
  // observable: `libSel` is a module `Set` that a reload would not survive, so a tick still
  // standing after two order changes is the proof the shelf was re-rendered rather than re-fetched.
  const bkAfterSort = await evaluate(cdp, checkedRefs('libList'));
  ok(
    bkAfterSort.length === 1 && bkAfterSort[0] === BK_A,
    `BOOKS: changing the order re-renders and does NOT refetch — the tick survives (${JSON.stringify(bkAfterSort)})`,
  );
  await evaluate(cdp, setSort('new'));

  ok(pageErrors.length === 0, `no uncaught page errors (${JSON.stringify(pageErrors.slice(0, 3))})`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`  FAIL ${err && err.stack ? err.stack : err}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

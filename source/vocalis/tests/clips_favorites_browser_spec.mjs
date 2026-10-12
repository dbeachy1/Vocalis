// 6.2 — the star on a Clips row, driven in a REAL headless browser (CDP, no npm).
//
// WHY, when test_clip_favorites.py covers the route and clips_ui_smoke.mjs covers the renderer:
// because both of those have passed before while the page was visibly broken. The smoke runs the
// helpers in a bare `vm` with a stubbed `$` and no CSS at all, so it cannot see a button that is
// painted invisible, a click that lands on the wrong element, or a star that does not survive the
// round trip to the server. This drives the real page against the real routes.
//
// 🔴 The check that carries this file is PERSISTENCE ACROSS A RELOAD. A star kept in the page's
// own state would pass every other check here — it renders, it filters, it toggles back — and
// then be gone the moment the page refreshed, which is the same persistence class as several other
// settings that were being written to localStorage and swept on boot by UIS.
//
// ⚠️ No backticks and no \d inside the CDP expressions: they are template literals here, and an
// unescaped backtick ends the literal (a whole spec became a syntax error that way in 6.2).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

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

const userDir = mkdtempSync(join(tmpdir(), 'vocalis-fav-'));
// Ask Chrome to bind port 0 and read the allocated port from its profile. PID-derived ports can
// collide between concurrent suites and accidentally target another browser session.
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

// Chrome writes the port it actually bound on the first line of this file, once it is listening.
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

async function waitFor(cdp, expr, tries = 100) {
  let lastThrow = null;
  for (let i = 0; i < tries; i++) {
    // 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED". `evaluate` turns a page exception
    // into a thrown Error, so an unguarded wait whose expression touches a node can fail during
    // repaint. Poll through transient page errors while retaining the last exception for output.
    // ⚠️ Remembered, not swallowed - a typo in an expression throws on every poll and would
    // otherwise just time out saying nothing about why.
    try {
      // 🔴 `Promise.resolve(...)`, NEVER `!!(expr)` AND NEVER A BARE VALUE. On a promise the
      // alternatives are true synchronously and always: `!!` on a thenable, or a promise
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

// 🔴 EVALUATED ONCE PER DOCUMENT — and "per document" is the whole subtlety. `Page.reload` builds
// a fresh global, so a collector installed before the navigation goes with the old one and
// `window.__specErrors` comes back `undefined`, which is exactly the shape of the vacuous check
// this replaces. It runs at BOTH publish points below for that reason.
const COLLECT_ERRORS = `(() => { window.__specErrors = [];
    window.addEventListener('error', e => window.__specErrors.push(String(e.message)));
    window.addEventListener('unhandledrejection',
                            e => window.__specErrors.push('unhandled: ' + String(e.reason)));
    return true; })()`;

try {
  const cdp = await connect(await cdpTarget());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // 🔴 `readyState === 'complete'` IS THE LOAD-BEARING HALF -- OR IT WAS UNTIL 7.3-m7.
  //
  // `loadScenes` USED TO BE an inline function declaration, so it existed the moment the classic
  // script was parsed -- which is BEFORE the `<script type="module">` shim at the bottom of the
  // page has fetched ~27 module files and run its `Object.assign(window, ...)`. This gate
  // therefore opened while the page was only half wired, and `switchTab()` on the next line threw
  // `ReferenceError: kobPollStop is not defined` the moment 7.3-m4 moved the KoboldCpp area into
  // a module. switchTab now names FIVE module exports (alignDevCols, loadDevices, devPollStart,
  // kobLoadAll, kobPollStop) and that number only grows for the rest of 7.3.
  //
  // ✅ 7.3-m7 MOVED `loadScenes` INTO js/scenes/scenes.js, so both halves of this gate are now
  // load-bearing and they agree: `typeof loadScenes === 'function'` is itself a "the shim has
  // published" signal today. ⚠️ KEEP `readyState === 'complete'` ANYWAY. It is the half that is
  // true for the WHOLE shim rather than for one module's turn in the `Object.assign` argument
  // list, and the day scenes.js is imported directly by js/main.js instead of published on the
  // shim, the cheap half silently stops meaning anything.
  //
  // Module scripts execute before the `load` event, and `complete` is after `load`, so this is
  // the cheapest correct "the shim has published" signal there is. wbedit_browser_spec.mjs has
  // gated this way since 7.1; every spec that drives page functions directly needs to.
  await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`);

  // 🔴 THE ERROR CHECK AT THE BOTTOM OF THIS FILE WAS VACUOUS FOR ITS WHOLE LIFE, and this is
  // the fix. It read `window.__vocalisErrors ? …length : 0` — and **nothing in `src/webui/` has
  // ever set `__vocalisErrors`**, so the expression was `0` whatever the page did and the spec
  // printed `no uncaught page errors (none)` through any number of real ones. Found while
  // writing clips_train_browser_spec.mjs (7.5), which copied the line and then went looking for
  // what fills it in. A check whose subject does not exist is worse than no check: it reads as
  // coverage. The collector has to be installed HERE, before anything is driven, or it misses
  // the errors it exists to catch.
  // ⚠️ `window.addEventListener`, NOT the bare call — `test_webui_modules.py`'s spec scan reads
  // every BARE call in a CDP expression as a page-scope name that must be exported or defined,
  // and it is right to: a bare call here is exactly the ReferenceError shape it guards.
  await evaluate(cdp, COLLECT_ERRORS);

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
  // page's GLOBAL scope — so every name this spec drives would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  await evaluate(cdp, OPEN_TAB);
  await evaluate(cdp, `loadScenes()`);
  ok(await waitFor(cdp, `document.querySelectorAll('#scList tr[data-ref]').length >= 2`), 'the Clips tab lists the scenes');

  // ⚠️ AND THEN WAIT FOR LAYOUT, WHICH IS NOT THE SAME THING AS WAITING FOR THE MARKUP. The row
  // above is in the DOM the instant `loadScenes()` writes it; it has a BOX only once the browser
  // has laid the table out. Measuring in the gap gives `getBoundingClientRect()` a 0x0 rect for a
  // button that is otherwise valid. Checking the row's box distinguishes incomplete layout from
  // an element hidden by an ancestor without weakening the final star-size assertion.
  //
  // 🔴 THE PRECONDITION IS THE ROW'S BOX, NOT THE STAR'S. Waiting on the star's own size would
  // make the assertion below tautological — it would then only be able to fail by timing out.
  // Waiting on the ROW says "the table has been laid out"; the assertion still has to establish
  // that the star WITHIN it is a real, sized, visible control rather than a 0x0 placeholder.
  // ⚠️ AND THE WAIT IS ASSERTED. `waitFor` RETURNS false on timeout, it does not throw, so an
  // unchecked one is a precondition that quietly did not hold - and the assertion below then fails
  // with a confusing message about paint instead of the true cause. Every other wait in this file
  // is checked; these two were the exception.
  //
  // 🔴 AND WHEN IT TIMES OUT, IT SAYS WHY. The row
  // is in the DOM (the assertion above it found two), and the star reports visible, inline-block
  // and the right glyph — so the element is fine and something ABOVE it is not being rendered.
  // `offsetParent === null` is the one fact that separates "not laid out yet" from "inside a
  // display:none ancestor", and naming that ancestor turns the next occurrence into a diagnosis
  // instead of a third round of this.
  //
  // ⚠️ IT DIAGNOSES, IT DOES NOT WIDEN. The 20 s timeout is untouched and the assertion still has
  // to hold — a longer wait is the change that would make the next occurrence invisible rather
  // than explicable.
  const laidOut = await waitFor(cdp, `(document.querySelector('#scList tr[data-ref]')?.getBoundingClientRect().height || 0) > 0`);
  ok(
    laidOut,
    'the row has a laid-out box before anything inside it is measured' +
      (laidOut
        ? ''
        : ' — ' +
          JSON.stringify(
            await evaluate(
              cdp,
              `(() => {
                  const tr = document.querySelector('#scList tr[data-ref]');
                  if (!tr) return { row: 'gone from the DOM entirely' };
                  // The first ancestor that is actually switched off, which is the answer if the
                  // row is fine and its section is hidden.
                  let hidden = null;
                  for (let n = tr; n && n !== document.documentElement; n = n.parentElement) {
                      if (getComputedStyle(n).display === 'none') {
                          hidden = n.tagName + '#' + (n.id || '') + '.' + (n.className || ''); break; }
                  }
                  const active = document.querySelector('#tabs button.active');
                  return {
                    rows: document.querySelectorAll('#scList tr[data-ref]').length,
                    offsetParent: tr.offsetParent === null ? 'null (nothing renders it)' : 'present',
                    firstHiddenAncestor: hidden || 'none — it is laid out, just zero-height',
                    activeTab: active ? active.dataset.tab : '(no active tab)',
                    stTab: (typeof stTabNow === 'function' ? stTabNow() : '(stTabNow unavailable)'),
                    bootDone: window.__bootDone === true,
                  }; })()`,
            ),
          )),
  );

  // The star has to be a real, clickable, VISIBLE control — not merely present in the markup.
  // A zero-sized or transparent button passes every regex check ever written about it.
  const paint = await evaluate(
    cdp,
    `(() => {
        const b = document.querySelector('#scList tr[data-ref] button[data-act="fav"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return { w: r.width, h: r.height, glyph: b.textContent.trim(),
                 color: cs.color, display: cs.display, vis: cs.visibility, op: cs.opacity };
    })()`,
  );
  ok(
    paint && paint.w > 6 && paint.h > 6,
    `the star is a real control with a real size (${paint && paint.w.toFixed(0)}x${paint && paint.h.toFixed(0)}px)`,
  );
  ok(paint && paint.vis !== 'hidden' && paint.display !== 'none' && Number(paint.op) > 0.5, 'and it is actually visible');
  ok(paint && paint.glyph === '☆', 'an unstarred row shows a hollow star');

  // 🔴 The name cell must be the NAME. The star lives in a column of its own precisely because
  // the inline rename editor replaces the name cell wholesale, and two other browser specs read
  // that cell to learn a row's name.
  // ⚠️ FOUND BY HEADER, NOT BY INDEX. This read `tr.children[2]` and m4i / §9a.3 inserted a
  // Character column in front of Name — so the check went on passing its own star assertion
  // while reading the wrong cell for the name. The property it defends has not changed; the
  // way it locates the cell has to survive another column being added.
  const nameCell = await evaluate(
    cdp,
    `(() => {
        // 9.5.7 - strip the sort arrow; see clips_table_layout_spec.mjs for what -1 costs.
        const heads = [...document.querySelectorAll('#scList thead th')].map(h => h.textContent.replace(/[▲▼]/g, '').trim());
        const tr = document.querySelector('#scList tr[data-ref]');
        return { star: tr.children[1].textContent.trim(),
                 name: tr.children[heads.indexOf('Name')].textContent.trim() };
    })()`,
  );
  ok(
    nameCell && nameCell.star === '☆' && !/star/i.test(nameCell.name) && nameCell.name.length > 3,
    `the star is in its OWN column, and the name cell is still the name ("${nameCell && nameCell.name}")`,
  );

  // Click it for real — the same event a mouse makes, through the same delegated handler.
  const ref = await evaluate(cdp, `document.querySelector('#scList tr[data-ref]').dataset.ref`);
  await evaluate(cdp, `document.querySelector('#scList tr[data-ref] button[data-act="fav"]').click()`);
  ok(
    await waitFor(cdp, `document.querySelector('#scList tr[data-ref] button[data-act="fav"]')` + `.textContent.trim() === '★'`),
    'clicking it fills the star in',
  );

  // …and the SERVER agrees, which is the half a page-local star would fake.
  //
  // 🔴 WAIT FOR THE SERVER, NOT FOR THE GLYPH — this check was a flake and the glyph is why.
  // The star is OPTIMISTIC by design (`index.html:5145`): the click flips the row and re-renders
  // BEFORE the POST goes out, then corrects from the answer. So the `waitFor` above returns the
  // instant the click is handled, with `/clips/favorite` still in flight, and this fetch raced
  // it. Under load the write had not landed and the assertion read `the server has it too ()` —
  // an empty list, correctly reported, for a write that simply had not happened yet.
  //
  // ⚠️ The product is RIGHT here and was never the bug: optimistic-then-corrected is deliberate,
  // and its own comment explains why the server owns the set. The test was asserting on the one
  // thing it had not waited for.
  const arrived = await waitFor(
    cdp,
    `fetch('/clips/items').then(r => r.json()).then(rows =>` +
      ` rows.filter(x => x.favorite).map(x => x.ref).join(',') === ${JSON.stringify(ref)})`,
  );
  const server = await evaluate(
    cdp,
    `fetch('/clips/items').then(r => r.json()).then(rows =>` + ` rows.filter(x => x.favorite).map(x => x.ref).join(','))`,
  );
  ok(arrived && server === ref, `the server has it too (${server})`);

  // The filter, additive to the others.
  await evaluate(
    cdp,
    `document.getElementById('scFavOnly').checked = true;` + `document.getElementById('scFavOnly').dispatchEvent(new Event('change'))`,
  );
  // waitFor rather than a bare read — every other assertion here already waits, and this one
  // was the exception. A wait only ensures the DOM settles; it does not resolve the intermittent
  // case where the active favorite filter shows no rows while the server still stores the flag.
  // The current hypothesis is a stale row object after a concurrent refresh replaces
  // `scLib.items`. Confirm that ownership path before changing production behavior.
  const settled = await waitFor(
    cdp,
    `[...document.querySelectorAll('#scList tr[data-ref]')]` + `.map(r => r.dataset.ref).join(',') === ` + JSON.stringify(ref),
  );
  const only = await evaluate(cdp, `[...document.querySelectorAll('#scList tr[data-ref]')]` + `.map(r => r.dataset.ref).join(',')`);
  ok(settled, `favorites only shows exactly the starred row (${only})`);

  await evaluate(
    cdp,
    `document.getElementById('scFavOnly').checked = false;` + `document.getElementById('scFavOnly').dispatchEvent(new Event('change'))`,
  );
  ok(await waitFor(cdp, `document.querySelectorAll('#scList tr[data-ref]').length >= 2`), 'un-ticking it brings the others back');

  // 🔴 THE ORDERING GUARD, driven deterministically — the cause of the intermittent failure
  // the 6.4 session handed over ("★ favorites only shows nothing", roughly 1 in 3).
  //
  // `loadScenes` is called from seven places and two can be in flight at once — the tab switch
  // fires one WITHOUT awaiting it, and Refresh, an enhance, an edit or a join can each start
  // another. It used to assign `scLib.items` whenever each answer happened to arrive, so the
  // LAST TO RESOLVE won rather than the last to be ASKED FOR. A stale answer landing after a
  // star was clicked replaced the array with rows fetched before it — every one
  // `favorite:false`, and the row the click handler was holding no longer in the array at all
  // — so the filter went empty and STAYED empty while the server had the star all along.
  //
  // Frequency is not a test. This forces the interleave: an older load made deliberately slow,
  // a newer one made fast, and the newer one must win.
  // 🔴 IT STUBS `fetch`, NOT `jget`, AND THAT CHANGED AT 7.3-m7 — DO NOT PUT `jget` BACK.
  //
  // This forced the interleave with `window.jget = …` for as long as the Clips code was inline and
  // resolved the name off the global object. `loadScenes` now lives in js/scenes/scenes.js and
  // `import`s `jget` from js/util/http.js, so the assignment still SUCCEEDS and is never
  // consulted: the real list arrives, `scLib.items` reads `scene1_…,scene0_…`, and the one red
  // check describes an ordering bug that is not there. `tests/test_webui_modules.py` had an
  // explicit exemption for this line saying "must become a `fetch` stub when Clips moves"; the
  // exemption is deleted and the guard now expires it automatically (see the note beside it).
  //
  // `fetch` is the right thing to stub because the split cannot move it — it is the browser's.
  const seq = await evaluate(
    cdp,
    `(async () => {
        const real = window.fetch;
        let n = 0;
        // ⚠️ ONLY THE CALL UNDER TEST IS FAKED. This stubbed EVERY jget, which made the guard
        // depend on loadScenes making exactly one — and m4i / §9a.3 gave it a second (the faces
        // the Character column draws). The counter then advanced twice per load and the check
        // read SEQ3, reporting a stub artifact as an ordering bug. Delegating everything else
        // keeps the interleave exactly as forced and stops the next fetch breaking it again.
        // 🔴 THE OLDER ANSWER IS HELD BY A GATE, NOT BY A TIMER. This delayed the first answer 400 ms
        // and the second 10 ms and counted on the first arriving last, then slept a further 500 ms
        // "to let it settle" - an interleave that was only true while the machine was fast enough
        // for the 10 ms one to beat the 400 ms one by the margin. Now the older answer is released
        // only AFTER the newer load has completed, so the order is forced rather than hoped for.
        let releaseOlder;
        const olderGate = new Promise(r => { releaseOlder = r; });
        // A real Response, because jget reads .status, .ok and .json() off it.
        const answer = mine => new Response(
            JSON.stringify([{ kind: 'scene', ref: 'SEQ' + mine, name: 'seq ' + mine }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        window.fetch = (url, opts) => {
            if (!String(url).startsWith('/clips/items')) return real(url, opts);
            n++; const mine = n;
            return mine === 1 ? olderGate.then(() => answer(mine)) : Promise.resolve(answer(mine)); };
        // Only a bound on a hang: the checks below fail on a wrong order, never on this.
        const bound = (p, what) => Promise.race([p, new Promise((_, no) =>
            setTimeout(() => no(new Error(what + ' never completed')), 30000))]);
        try {
            const older = loadScenes();          // asked FIRST, answers LAST
            const newer = loadScenes();          // asked SECOND, answers FIRST
            await bound(newer, 'the newer load');
            releaseOlder();                      // only now does the stale answer arrive
            await bound(older, 'the older load');
        } finally { releaseOlder(); }
        window.fetch = real;
        return scLib.items.map(x => x.ref).join(',');
    })()`,
  );
  ok(seq === 'SEQ2', `a slow older load must not overwrite a newer one (scLib.items = ${seq})`);
  await evaluate(cdp, `loadScenes()`); // put the real list back for the reload check
  ok(
    await waitFor(cdp, `document.querySelectorAll('#scList tr[data-ref]').length >= 2`),
    'the real list comes back after the ordering probe',
  );

  // 🔴 THE CHECK THIS FILE EXISTS FOR. Reload the page: a star kept in the page's own state
  // would have passed everything above and be gone here.
  // 🔴 STAMP THE OUTGOING DOCUMENT BEFORE RELOADING IT. The gate below is the right gate, but on
  // a reload it is asked of the page we are about to DESTROY, and that page satisfies it — it has
  // been `complete` with `loadScenes` defined for seconds. So the first poll could return true
  // against the old context, and `OPEN_TAB` on the next line would then evaluate into the new
  // document mid-install, where nothing is defined yet.
  //
  // Not hypothetical: this failed a full 16-worker run as `ReferenceError: switchTab is not
  // defined` and passed in isolation, which is exactly the shape of a race. `switchTab` is an
  // inline function DECLARATION, so it is hoisted and exists the instant the classic script is
  // instantiated — the only way it can be missing is if the document being addressed is not the
  // one that ran that script.
  //
  // A reload builds a FRESH global, so the stamp cannot survive it. Property access on `window`
  // never throws, so the expression is safe to poll against either context.
  await evaluate(cdp, `window.__preReload = 1`);
  await cdp.send('Page.reload');
  // Same gate as the first one above -- the shim must have published before switchTab is safe --
  // plus the stamp, which is what makes it a gate on the NEW document rather than on either.
  await waitFor(
    cdp,
    `!window.__preReload && document.readyState === 'complete' ` + `&& window.__uiReady === true && window.__bootDone === true`,
  );
  // 🔴 RE-PUBLISH AFTER A RELOAD — 7.3-m13. A reload builds a FRESH global object, so everything
  // the harness put on `window` before the navigation is gone with the old document. That is the
  // same fact the `__preReload` stamp above relies on, used in the other direction, and forgetting
  // it costs a `ReferenceError: $ is not defined` several assertions later rather than here.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  await evaluate(cdp, COLLECT_ERRORS); // fresh document, fresh collector — see its comment
  await evaluate(cdp, OPEN_TAB);
  await evaluate(cdp, `loadScenes()`);
  ok(await waitFor(cdp, `document.querySelectorAll('#scList tr[data-ref]').length >= 2`), 'the tab comes back after a reload');
  const after = await evaluate(
    cdp,
    `(() => {
        const tr = [...document.querySelectorAll('#scList tr[data-ref]')]
            .find(r => r.dataset.ref === ${JSON.stringify(ref)});
        return tr ? tr.querySelector('button[data-act="fav"]').textContent.trim() : null;
    })()`,
  );
  ok(after === '★', `the star SURVIVES a reload (${after}) — it is on the server, not in the page`);

  // And un-starring is a real toggle, not a one-way trip.
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#scList tr[data-ref]')]` +
      `.find(r => r.dataset.ref === ${JSON.stringify(ref)})` +
      `.querySelector('button[data-act="fav"]').click()`,
  );
  ok(
    await waitFor(cdp, `fetch('/clips/items').then(r => r.json())` + `.then(rows => rows.every(x => !x.favorite))`),
    'and un-starring clears it on the server too',
  );

  // ⚠️ RE-INSTALLED AFTER THE RELOAD, and forgetting that is how this check goes quietly vacuous
  // a second time: `Page.reload` builds a fresh global, so the collector above went with the old
  // document — the same fact the `__preReload` stamp relies on, used in the other direction.
  // Everything from the reload onward is what this now covers; the pre-reload half is covered by
  // the identical collector at the top.
  const errs = await evaluate(cdp, `(window.__specErrors || []).join(' | ')`);
  ok(!errs, `no uncaught page errors after the reload (${errs || 'none'})`);

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

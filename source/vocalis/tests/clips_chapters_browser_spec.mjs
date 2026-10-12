// Vocalis 6.1 §10.3 + §10.4 + §10.5 — the Clips tab's chapters and its player, in a REAL browser.
//
// Browser coverage for inline chapter placement, chapter-link playback, and player controls.
// Each assertion checks the rendered state and the action available at that point.
//   §10.3 "Can you render the chapters right below the row where I click chapters, so I can see
//         it without scrolling down to the bottom? It's kind of goofy to scroll to the bottom
//         and reorient myself."
//   §10.4 "When I click one of the links to play it, it says 'oh, click play first'. How about
//         you start playing automatically when I click that, if it's not playing?"
//   §10.5 "If I click just play on one of the rows, it still puts the player bar at the very top
//         of clips. It needs to put it in line, just like if I clicked chapters… And I don't see
//         a way to hide the play controls once they're up."
//
// 🔴 Note what §10.5 says about the two before it: BOTH shipped green, and the placement was
// still wrong for the commonest action in the tab, because every check was written about the
// chapters path. The §10.5 checks below are deliberately about ▶ Play — the path that had no
// geometric assertion at all and so was free to put the bar anywhere on screen.
//
// 🔴 Why these checks are shaped the way they are. m0's version of this file asserted that a
// panel became visible and ended up in the viewport, and the check that made it worth anything
// was a PRECONDITION proving the geometry was non-trivial. The same discipline applies here, in
// two places:
//
//   - "the chapters are on screen" is trivially true of an accordion on a short page, so the
//     assertion is ADJACENCY — the detail row's top edge is flush with the clicked row's bottom
//     edge, to within a pixel. That is false for every other placement, including the m0 panel.
//     🔴 VERIFIED RED: rendering the detail rows at the foot of the table instead fails this
//     while "the chapters are in the viewport" still passes at top 395px of a 420px viewport,
//     which is precisely the vacuous check it replaced.
//   - the seek is driven from a DELIBERATELY unloaded player (au.load() puts readyState back to
//     0 synchronously), because that is the state a real 46-minute scene is in when he clicks a
//     chapter immediately after expanding it.
//     ⚠️ Be honest about what that check is worth: it does NOT catch a missing wait-for-metadata,
//     and it was written believing it would. Neutering scSeekPlay to assign currentTime
//     unconditionally leaves this spec GREEN — assigning at readyState 0 sets the element's
//     default playback start position and Blink begins playback there. So this is an end-to-end
//     check that a cold click lands on its offset, not a guard against that particular mistake.
//     Do not re-label it as one.
//
// No npm dependencies — Node ships WebSocket and fetch, Chrome speaks CDP. CDP plumbing mirrors
// devices_browser_spec.mjs.
//
// Usage: node clips_chapters_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node clips_chapters_browser_spec.mjs <base-url> <chrome-path>');
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

// ── CDP plumbing (mirrors devices_browser_spec.mjs) ──────────────────────────
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
    // ⚠️ A broken wait races: fast runs pass while loaded runs fail, which looks like an
    // environment flake. Polling must await the expression's result, not a more convenient symptom.
    // 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED". `evaluate` turns a page exception into
    // a thrown Error, so before this guard any wait whose expression dereferenced a node was a
    // race rather than a wait - the FIRST poll landing mid-repaint killed the spec. The wait is
    // FOR the repaint, so polling during it is the normal case and early false results are expected.
    // Mutation coverage checks both the eventual success and remembered-error paths.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-chap-cdp-'));
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
    // The seek checks below assert that audio is actually RUNNING. Without this the autoplay
    // policy can reject play() for reasons that have nothing to do with the code under test,
    // and our .catch(()=>{}) would swallow it into a silent flake.
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
  // 🔴 Wait for Chrome to exit before deleting its profile; Windows may keep handles open briefly
  // after `kill()` returns. The bounded fallback handles a delayed exit event.
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

// §10.1 moved Clips under SillyTavern, so the tab is a sub-tab and the section that scopes the
// "exactly one <audio>" checks is the SillyTavern panel it now lives in.
const CLIPS = `document.querySelector('[data-stpanel="clips"]')`;

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

  // Use a controlled viewport so the geometry checks do not depend on fixture size or the
  // number of scenes in a user's library.
  //
  // ⚠️ Pin the viewport height between these asserted preconditions: the chapter button must be
  // visible, while the chapter section must extend below the fold so clicking it scrolls content.
  // At 1100px wide the button ends at 607px and the section ends at 712px; 660px is centered
  // between those bounds. A 900px viewport has no scrollbar because the page fits, so its
  // geometry cannot exercise the intended scroll behavior. Re-derive the height if layout changes.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 660,
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
  // 🔴 `window.__uiReady`, NOT JUST `readyState` — 7.3-m2b, AND THIS SPEC'S FLAKE IS WHY.
  //
  // The lines below drive the app through a REAL `#tabs` button click, which is the point of this
  // spec. That listener is `window.__uiReady ? switchTab(t) : (window.__pendingTab = t)` — so before
  // js/main.js's module body runs, a click is PARKED rather than executed (§11.6 item 3). The tab
  // never opens, the SillyTavern section stays `display:none`, and every geometry check below then
  // measures a zero-sized box: `the section runs off the bottom of the window (0px vs 570px)`.
  //
  // ⚠️ IT PRESENTED AS A LAYOUT FLAKE — red under a 16-file parallel browser sweep, green alone in
  // four seconds — and "the chapters are not in the viewport" points at the feature, not at the
  // gate. The `#stTabs` sub-tab click on the next line has no such guard, so it DID run and the row
  // list DID render, which made the first checks pass and the geometric ones fail: the most
  // misleading possible shape.
  //
  // 📌 `__uiReady` is the RIGHT signal here, better than `typeof switchTab === 'function'`, because
  // it is the exact flag the listener consults. Use the typeof form when the spec calls a page
  // function directly (clips_favorites, voices_player); use this one when it clicks the tab bar.
  await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`);

  // 🔴 7.3-m13: THE PAGE PUBLISHES NOTHING ON `window` ANY MORE. index.html's
  // `Object.assign(window, …)` shim is deleted (§10 item 2), and `Runtime.evaluate` runs in the
  // page's GLOBAL scope — so every name this spec drives would be a ReferenceError. The HARNESS
  // publishes what the harness needs; _websrc.mjs has the list and the argument.
  // ⚠️ AFTER the readiness gate and BEFORE the first assertion, and AWAITED.
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  // ── the Clips tab lists the seeded scenes ───────────────────────────────
  // Two clicks since §10.1: the top-level SillyTavern tab, then its Clips sub-tab. Driving it
  // through the real buttons rather than calling switchStTab() directly is the point — it is
  // the path that would break if the pane were nested wrongly.
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('#tabs button[data-tab="sillytavern"]').click();
        document.querySelector('#stTabs button[data-sttab="clips"]').click();
    })()`,
  );
  ok(
    await waitFor(cdp, `document.querySelectorAll('#scList button[data-act="chapters"]').length > 1`),
    'the Clips tab lists scenes, each with a Chapters button',
  );
  // It has to be VISIBLE, not merely populated: a pane left outside the SillyTavern section
  // renders its rows into a subtree switchTab() has hidden, and every geometry check below
  // would then be measuring a zero-sized box.
  // 🔴 WAIT FOR THE BOX, DO NOT MERELY ASSERT IT. The gate above is on MARKUP — the buttons are in
  // the DOM the instant they are written — and this line read GEOMETRY on the very next tick.
  // `getBoundingClientRect()` returns ZEROS for a node that exists but has not been laid out, so
  // an immediate `evaluate` here cannot tell "the pane is hidden" from "the browser has not got
  // there yet", and it went red in a 16-worker run while passing alone. Waiting costs nothing
  // when the layout is already done and does not weaken the check: a pane that genuinely never
  // gets a box still times out and still fails, with the same message.
  ok(
    await waitFor(
      cdp,
      `(() => {
        const p = ${CLIPS}, r = p && p.getBoundingClientRect();
        return !!(r && r.width > 0 && r.height > 0);
    })()`,
    ),
    'and the pane is actually on screen under SillyTavern',
  );

  // ── §10.3 — the chapters open UNDER THE ROW, and he keeps his place ─────
  // Click the SECOND row: the first is flush with the top of the table, where "adjacent to the
  // row" and "at the top of the section" are nearly the same place and a mistake would hide.
  //
  // 🔴 Precondition: the row must be on screen when it is clicked. §10.1 pushed the list down
  // by a sub-tab strip and this check began measuring a click on a button below the fold —
  // which no user can perform, so whatever it proved was not about the feature.
  const clickable = await evaluate(
    cdp,
    `(() => {
        window.scrollTo(0, 0);
        const btn = document.querySelectorAll('#scList button[data-act="chapters"]')[1];
        const r = btn.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight,
                 sectionBottom: ${CLIPS}.getBoundingClientRect().bottom };
    })()`,
  );
  ok(
    clickable && clickable.top >= 0 && clickable.bottom <= clickable.vh,
    `precondition: the Chapters button under test is on screen to be clicked ` +
      `(${Math.round(clickable?.top)}–${Math.round(clickable?.bottom)}px of ${clickable?.vh}px)`,
  );
  // Non-vacuity, carried over from m0: the page is longer than the window, so "the chapters
  // ended up on screen" is a fact about where they were put and not about everything fitting.
  // Measured HERE, unscrolled, because after the click the page may legitimately have moved.
  ok(
    clickable && clickable.sectionBottom > clickable.vh,
    `precondition: the section runs off the bottom of the window ` + `(${Math.round(clickable?.sectionBottom)}px vs ${clickable?.vh}px)`,
  );

  await evaluate(cdp, `document.querySelectorAll('#scList button[data-act="chapters"]')[1].click()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#scList tr.scDet a[data-seek]').length > 0`),
    'the chapters arrive, one seekable row per message, fetched per row on demand',
  );

  const geom = await evaluate(
    cdp,
    `(() => {
        const btn = document.querySelectorAll('#scList button[data-act="chapters"]')[1];
        const row = btn.closest('tr');
        const det = row.nextElementSibling;
        const sect = ${CLIPS};
        const r = row.getBoundingClientRect(), d = det.getBoundingClientRect();
        return {
            isDetail: det.classList.contains('scDet'),
            ref: det.dataset.detref, rowRef: row.dataset.ref,
            gap: d.top - r.bottom, detTop: d.top, detBottom: d.bottom,
            rowTop: r.top, rowBottom: r.bottom,
            vh: window.innerHeight, scrollY: window.scrollY,
            // 9.0.8 — the line "on screen" has to be measured from. The header is sticky
            // and the tab bar pins under it, so a row at top:40 is inside the viewport and
            // behind the chrome. Read off the bar itself rather than off the CSS variable, so
            // this is the pixels a person would see and not the app's own bookkeeping.
            stick: document.getElementById('tabs').getBoundingClientRect().bottom,
            sectionBottom: sect.getBoundingClientRect().bottom,
            nDetails: document.querySelectorAll('#scList tr.scDet').length,
        };
    })()`,
  );

  // 🔴 THE assertion, and the reason it is adjacency rather than "is on screen": an accordion
  // on a short page is on screen wherever you put it, so visibility alone would also be true
  // of the m0 panel this replaced.
  ok(
    geom && geom.isDetail && Math.abs(geom.gap) < 1.5,
    `the chapters open IMMEDIATELY under the row that was clicked ` +
      `(next row is the detail: ${geom?.isDetail}, ` +
      `gap ${geom?.gap?.toFixed(2)}px between that row's bottom and its top)`,
  );
  ok(geom && geom.ref === geom.rowRef, `and under the RIGHT row — the detail carries the same ref (${geom?.ref})`);
  // §10.3's actual promise is that he does not have to REORIENT — "it's kind of goofy to scroll
  // to the bottom and reorient myself" — not that the page never moves a pixel. So: the
  // chapters are on screen AND the row he clicked is still on screen, which is what keeping
  // your place means. scNudgeOpen puts the row at the top only when the detail would otherwise
  // be below the fold; in a tall window it does nothing at all.
  // 🔴 WHOLLY in the viewport, not just its top edge. Without scNudgeOpen the detail opens at
  // 456px in a 480px window and its top is "on screen" while every chapter in it is below the
  // fold — which is m0's defect wearing a different hat, and a top-only check passes against
  // it. (This fixture's five chapters do fit; a scene with fifty could not, and the promise
  // then is the same as any long list — you can see where it starts and scroll.)
  // 🔴 9.0.8 — `>= geom.stick`, NOT `>= 0`. Inside the viewport is not the same as visible once
  // anything is pinned at the top, and this page has had a sticky header for a long time and a
  // pinned tab bar since 9.0.8. A `>= 0` check passes for chapters sitting entirely behind the
  // chrome, which is the same defect this section is about wearing yet another hat.
  ok(
    geom && geom.detTop >= geom.stick && geom.detBottom <= geom.vh,
    `the chapters are WHOLLY visible below the pinned header ` +
      `(${Math.round(geom?.detTop)}–${Math.round(geom?.detBottom)}px, chrome ends at ${Math.round(geom?.stick)}px, window ${geom?.vh}px)`,
  );
  ok(
    geom && geom.rowTop >= geom.stick && geom.rowBottom <= geom.vh,
    `and he keeps his place — the row he clicked is still visible, not behind the header ` +
      `(${Math.round(geom?.rowTop)}–${Math.round(geom?.rowBottom)}px, chrome ends at ${Math.round(geom?.stick)}px)`,
  );
  ok(geom && geom.nDetails === 1, `exactly one row is expanded (${geom?.nDetails})`);
  // "Under the row" only means something if there is list BELOW it. A detail row rendered as a
  // footer would still be adjacent to *something*, so pin that a scene row follows it.
  ok(
    await evaluate(
      cdp,
      `(() => {
        const det = document.querySelector('#scList tr.scDet');
        const next = det && det.nextElementSibling;
        return !!(next && next.dataset.ref && !next.classList.contains('scDet'));
    })()`,
    ),
    'and there are still scenes listed BELOW it — it opened mid-list, not as a footer',
  );

  // ── §10.5 — the player has a ROW of its own, under the clip it plays ────
  // The player row belongs directly below the clip row whether or not chapter details are open.
  //
  // 🔴 And expanding now gives NO player at all. m0a attached a silent one here so a chapter
  // link had something to seek; §10.4 made the link start playback on its own, and once ▶/■
  // became a toggle on the bar (§10.5) an unasked-for bar would have turned the row's button
  // red without a note being played.
  ok(
    await evaluate(cdp, `${CLIPS}.querySelectorAll('audio').length === 0`),
    'expanding a scene puts NO player on screen by itself — the bar is something you ask for',
  );

  await evaluate(cdp, `document.querySelector('#scList tr.scDet a[data-seek]').click()`);
  ok(await waitFor(cdp, `document.querySelector('#scList tr.scPlay audio')`), 'clicking a chapter brings the player up');

  const place = await evaluate(
    cdp,
    `(() => {
        const play = document.querySelector('#scList tr.scPlay');
        const row = play.previousElementSibling, det = play.nextElementSibling;
        const r = row.getBoundingClientRect(), p = play.getBoundingClientRect();
        return { ref: play.dataset.playref, rowRef: row.dataset.ref,
                 isDet: !!det && det.classList.contains('scDet'),
                 gap: p.top - r.bottom,
                 audios: ${CLIPS}.querySelectorAll('audio').length,
                 atTop: !!document.querySelector('#scPlayer audio'),
                 topShown: getComputedStyle(document.getElementById('scPlayer')).display };
    })()`,
  );
  // The same adjacency assertion the chapters get, and for the same reason: "at the top of the
  // section" is also on screen, so only the gap tells the two apart.
  ok(
    place && place.ref === place.rowRef && Math.abs(place.gap) < 1.5,
    `the player opens IMMEDIATELY under the clip it is playing ` + `(gap ${place?.gap?.toFixed(2)}px, ref ${place?.ref})`,
  );
  ok(place && place.isDet, 'and the chapters follow directly under the player — one block, in the running order');
  ok(
    place && place.audios === 1 && !place.atTop && place.topShown === 'none',
    `exactly one <audio>, and the fallback bar at the top of the tab is empty and hidden ` +
      `(${place?.audios} audio, top display=${place?.topShown})`,
  );

  // Reset the player to HAVE_NOTHING and click a chapter in the SAME task — the state a real
  // 46-minute scene is in when he clicks a chapter right after expanding it. ⚠️ See the header:
  // this is an end-to-end check that a cold click lands, NOT a guard against assigning
  // currentTime before metadata. Blink handles that case on its own and this stays green
  // without the wait.
  const cold = await evaluate(
    cdp,
    `(() => {
        const det = document.querySelector('#scList tr.scDet');
        const au = document.querySelector('#scList tr.scPlay audio');
        const links = det.querySelectorAll('a[data-seek]');
        const last = links[links.length - 1];
        au.load();                               // synchronously back to HAVE_NOTHING
        const readyAtClick = au.readyState;
        last.click();
        return { readyAtClick, want: Number(last.dataset.seek), n: links.length };
    })()`,
  );
  ok(
    cold && cold.readyAtClick === 0,
    `precondition: the player had NO metadata at the moment the chapter was clicked ` +
      `(readyState ${cold?.readyAtClick}) — so the check below is a COLD seek, not a warm one`,
  );
  ok(cold && cold.want > 0, `the chapter under test is a real offset, not 0 (${cold?.want}s of ${cold?.n} chapters)`);

  const landed = await waitFor(
    cdp,
    `(() => {
        const au = document.querySelector('#scList tr.scPlay audio');
        return au && Math.abs(au.currentTime - ${cold?.want ?? -1}) < 0.75;
    })()`,
    15000,
  );
  const after = await evaluate(
    cdp,
    `(() => {
        const au = document.querySelector('#scList tr.scPlay audio');
        return au ? { t: au.currentTime, paused: au.paused, ready: au.readyState } : null;
    })()`,
  );
  ok(
    landed,
    `clicking a chapter on an UNLOADED player still lands on its offset ` + `(wanted ${cold?.want}s, got ${after?.t?.toFixed(2)}s)`,
  );
  // §10.4's actual ask: it plays, rather than telling him to press ▶ first.
  ok(after && after.paused === false, `and it STARTS PLAYING — no "Nothing playing" modal (paused=${after?.paused})`);
  ok(await evaluate(cdp, `!document.getElementById('overlay').classList.contains('on')`), 'no modal was raised by the chapter click');

  // ── the landmine: a re-render must not collapse the row ─────────────────
  // renderScenes() rebuilds #scList from six call sites. Search is the one that will bite —
  // he types, and the row he just opened closes under him.
  // ⚠️ By ref, not by previousElementSibling: since §10.5 the row before the detail may be the
  // PLAYER row rather than the scene's own, and a sibling walk silently reads the wrong cell.
  const survived = await evaluate(
    cdp,
    `(() => {
        const det = document.querySelector('#scList tr.scDet');
        const ref = det.dataset.detref;
        const own = document.querySelector(\`#scList tr[data-ref="\${ref}"]\`);
        // ⚠️ FOUND BY HEADER, NOT BY INDEX — the THIRD place this bit. The comment here used to
        // read "the NAME is column 3, the star took a column of its own", which was true until
        // m4i / §9a.3 inserted Character in front of it; this then searched for the SPEAKER's
        // name (or the em dash for a scene with none), the row filtered itself out, and the
        // failure reported as "typing in Search collapses the expanded row". Two sibling specs
        // had the same hardcoded index and were repaired the same way.
        // 9.5.7 - strip the sort arrow; see clips_table_layout_spec.mjs for what -1 costs.
        const heads = [...document.querySelectorAll('#scList thead th')].map(h => h.textContent.replace(/[▲▼]/g, '').trim());
        const name = own.children[heads.indexOf('Name')].textContent.trim();
        const before = document.querySelector('#scList tr.scPlay audio').currentTime;
        const box = document.getElementById('scSearch');
        box.value = name.slice(0, 6);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const still = document.querySelector('#scList tr.scDet');
        const au = document.querySelector('#scList tr.scPlay audio');
        return { ref, open: !!still, same: still && still.dataset.detref === ref,
                 hasPlayer: !!au, playing: au ? !au.paused : false, before,
                 t: au ? au.currentTime : -1 };
    })()`,
  );
  ok(
    survived && survived.open && survived.same,
    'typing in Search does not collapse the expanded row — the expansion is state, not markup',
  );
  // The player is re-parented by the same rebuild. Moving a media element does not stop it
  // provided it is back in the document in the same task; if that ever regresses, it regresses
  // as a dropout every keystroke.
  ok(
    survived && survived.hasPlayer && survived.playing,
    `and its player survives the re-render still playing (t=${survived?.t?.toFixed(2)}s)`,
  );

  await evaluate(
    cdp,
    `(() => {
        const box = document.getElementById('scSearch');
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );

  // ── ← / → seek five seconds, 6.1 ───────────────────────────────────────
  // Left and right arrows seek by five seconds only while a clip is playing.
  const keys = await evaluate(
    cdp,
    `(() => {
        const au = document.querySelector('#scList tr.scPlay audio');
        const key = (k, target) => (target || document.body).dispatchEvent(
            new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        const start = au.currentTime;
        key('ArrowLeft');
        const back = au.currentTime;
        key('ArrowRight'); key('ArrowRight');
        const fwd = au.currentTime;
        // 🔴 And NOT while he is typing: the arrows are cursor movement in a text field. The
        // search box is right there above the list, so this is the collision that would happen.
        const box = document.getElementById('scSearch');
        box.focus();
        const beforeTyping = au.currentTime;
        key('ArrowLeft', box);
        return { start, back, fwd, beforeTyping, afterTyping: au.currentTime,
                 playing: !au.paused };
    })()`,
  );
  ok(
    keys && Math.abs(keys.start - keys.back - 5) < 0.3,
    `← goes back five seconds (${keys?.start?.toFixed(2)}s → ${keys?.back?.toFixed(2)}s)`,
  );
  ok(
    keys && Math.abs(keys.fwd - keys.back - 10) < 0.3,
    `→ goes forward five (twice: ${keys?.back?.toFixed(2)}s → ${keys?.fwd?.toFixed(2)}s)`,
  );
  ok(
    keys && keys.beforeTyping === keys.afterTyping,
    `and an arrow in the search box moves the CURSOR, not the playhead ` + `(${keys?.beforeTyping?.toFixed(2)}s unchanged)`,
  );
  ok(keys && keys.playing, 'the clip is still playing through all of it');

  // ── ▶ Play on another row: one player, and it FOLLOWS the row ───────────
  // This is the check that would have caught the §10.5 complaint. Before it, ▶ Play on a row
  // whose chapters were not open sent the bar to the top of the section — on screen, so a
  // visibility assertion would have passed, and useless, because "the very top of clips" can be
  // a long way from the row he pressed.
  const second = await evaluate(
    cdp,
    `(() => {
        const det = document.querySelector('#scList tr.scDet');
        const openRef = det.dataset.detref;
        const other = [...document.querySelectorAll('#scList button[data-act="play"]')]
            .find(b => b.dataset.ref !== openRef);
        other.click();
        const play = document.querySelector('#scList tr.scPlay');
        const row = play && play.previousElementSibling;
        const r = row && row.getBoundingClientRect(), p = play && play.getBoundingClientRect();
        return {
            openRef, played: other.dataset.ref,
            audios: ${CLIPS}.querySelectorAll('audio').length,
            atTop: !!document.querySelector('#scPlayer audio'),
            nRows: document.querySelectorAll('#scList tr.scPlay').length,
            under: row && row.dataset.ref, gap: (p && r) ? p.top - r.bottom : null,
            hasAudio: !!(play && play.querySelector('audio')),
            // 🔴 Re-queried rather than read off the clicked node: the click re-renders the list,
            // so that node is detached and still carries the OLD label. Reading it would report
            // "Play" no matter what shipped. (And no backticks in here — an unescaped one ends
            // the outer template literal and the whole spec becomes a syntax error.)
            label: document.querySelector(
                \`#scList button[data-act="play"][data-ref="\${other.dataset.ref}"]\`).textContent.trim(),
        };
    })()`,
  );
  ok(
    second && second.audios === 1,
    `▶ Play on a different clip MOVES the one player rather than adding a second ` + `(${second?.audios} <audio> in the tab)`,
  );
  ok(
    second && second.nRows === 1 && second.under === second.played && Math.abs(second.gap) < 1.5 && second.hasAudio,
    `and the player MOVES WITH IT — one row, under the clip that was pressed ` +
      `(under ${second?.under}, gap ${second?.gap?.toFixed(2)}px)`,
  );
  ok(second && !second.atTop, '🔴 NOT the bar at the top of the tab — that placement is the complaint §10.5 fixed');
  // "the play button should go to a stop… with a red icon"
  ok(second && second.label === '■ Stop', `the button he pressed now reads Stop (${second?.label})`);

  // ── ■ Stop puts the bar away, which is the only way to be rid of it ─────
  // Pressing Stop again stops playback and removes the player controls from the page.
  const stopped = await evaluate(
    cdp,
    `(() => {
        const ref = document.querySelector('#scList tr.scPlay').dataset.playref;
        const btn = document.querySelector(\`#scList button[data-act="play"][data-ref="\${ref}"]\`);
        btn.click();
        const again = document.querySelector(\`#scList button[data-act="play"][data-ref="\${ref}"]\`);
        return { rows: document.querySelectorAll('#scList tr.scPlay').length,
                 audios: ${CLIPS}.querySelectorAll('audio').length,
                 topShown: getComputedStyle(document.getElementById('scPlayer')).display,
                 label: again.textContent.trim() };
    })()`,
  );
  ok(
    stopped && stopped.rows === 0 && stopped.audios === 0,
    `pressing it again stops and puts the bar away ` + `(${stopped?.rows} player rows, ${stopped?.audios} <audio>)`,
  );
  ok(stopped && stopped.topShown === 'none', 'and it did not simply move to the top of the tab — nothing is on screen');
  ok(stopped && stopped.label === '▶ Play', `and the button reads Play again (${stopped?.label})`);

  // ── 9.6.7: the clip runs OUT, and the button has to notice ──────────────
  //
  // When audio ends, the button must leave Stop state and reflect that playback has ended.
  //
  // 🔴 EVERY CHECK ABOVE DRIVES THE BUTTON, WHICH IS WHY NONE OF THEM COULD SEE THIS. `scStop`
  // was the only thing that ever cleared `scLib.playing`, and `scStop` only ever ran from a
  // press — so the one way a clip ordinarily finishes had no code path at all. A test that
  // presses ▶ and then presses ■ proves the toggle and says nothing about the audio.
  //
  // ⚠️ SEEK, DO NOT WAIT: the seeded scene is minutes long. Landing just short of `duration` and
  // letting it run off the end fires the real `ended` on the real element, which is the event
  // under test — a synthetic `dispatchEvent` would pass against a listener bound to nothing.
  // The `fired` flag is that probe: it says the browser really reached the end rather than the
  // assertion below reading a state that was already true.
  const finished = await evaluate(
    cdp,
    `(async () => {
        const btn0 = document.querySelector('#scList button[data-act="play"]');
        const ref = btn0.dataset.ref;
        btn0.click();
        const au = document.getElementById('scAudio');
        await new Promise(r => au.readyState >= 1 ? r(null)
                                : au.addEventListener('loadedmetadata', () => r(null), {once: true}));
        const label = () => document.querySelector(
            \`#scList button[data-act="play"][data-ref="\${ref}"]\`);
        const before = label().textContent.trim();
        let fired = false;
        au.addEventListener('ended', () => { fired = true; }, {once: true});
        au.currentTime = Math.max(0, au.duration - 0.08);
        // A bounded condition loop on the ended event itself; 20 s is only a bound on a hang
        // (it was 5 s). fired false fails the "really reached its end" check below.
        for (let i = 0; i < 800 && !fired; i++) await new Promise(r => setTimeout(r, 25));
        // This was a further fixed 50 ms "for the button to repaint". The repaint is the page's own
        // listener on this same element's 'ended' (scenes.js binds it when it builds the element,
        // before this probe's listener, and scPaintPlayButtons is synchronous), so it has already
        // run once 'fired' is true. The button leaving Stop is waited for anyway, bounded: a
        // button that never does fails the 'reads Close' check rather than being papered over.
        for (let i = 0; i < 200 && label().textContent.trim() === before; i++) await new Promise(r => setTimeout(r, 25));
        const b = label();
        return {before, fired, ended: au.ended,
                label: b.textContent.trim(), danger: b.className.indexOf('danger') >= 0,
                title: b.title,
                rows: document.querySelectorAll('#scList tr.scPlay').length,
                hasAudio: !!document.querySelector('#scList tr.scPlay audio'),
                at: au.currentTime, dur: au.duration};
    })()`,
  );
  ok(finished && finished.before === '■ Stop', `precondition: it was playing, and the button said so (${finished?.before})`);
  ok(
    finished && finished.fired && finished.ended,
    `the clip really reached its end (ended=${finished?.ended}, at ${finished?.at?.toFixed(2)}s)`,
  );
  // After playback ends, Close dismisses the player row rather than leaving a stale Stop control.
  ok(
    finished && finished.label === '✕ Close' && !finished.danger,
    `and the button reads Close instead of staying on a red Stop (${finished?.label}, danger=${finished?.danger})`,
  );
  ok(
    finished && /[Pp]ut the player away/.test(finished.title || ''),
    `its tooltip says what the press does now (${JSON.stringify(finished?.title)})`,
  );
  ok(
    finished && finished.rows === 1 && finished.hasAudio,
    `while the player itself is still there for him to close (${finished?.rows} row)`,
  );

  // …and pressing it does exactly what it says. ✕ Close and ■ Stop are ONE action, so this is
  // §10.5's "a way to hide the play controls" still working at the one moment he is most likely
  // to want it — which a label-only fix would have left as a button that lies in the other
  // direction. It doubles as the teardown: the next block presses the first ▶ Play expecting to
  // START something, and a clip left owning the player would toggle OFF instead.
  const closed = await evaluate(
    cdp,
    `(async () => {
        const b = document.querySelector('#scList tr.scPlay').previousElementSibling
                    .querySelector('button[data-act="play"]');
        const was = b.textContent.trim();
        b.click();
        // Wait, bounded, for the player row to go (scStop is synchronous, like the Stop press
        // above, which is read with no wait at all). This was a fixed 120 ms; a player row that
        // never goes fails the 'player disappears' check below.
        for (let i = 0; i < 200 && document.querySelectorAll('#scList tr.scPlay').length !== 0; i++)
          await new Promise(r => setTimeout(r, 25));
        return {was, rows: document.querySelectorAll('#scList tr.scPlay').length,
                audios: ${CLIPS}.querySelectorAll('audio').length,
                topShown: getComputedStyle(document.getElementById('scPlayer')).display,
                label: document.querySelector('#scList button[data-act="play"]').textContent.trim()};
    })()`,
  );
  ok(closed && closed.was === '✕ Close', `precondition: the button under the press said Close (${closed?.was})`);
  ok(
    closed && closed.rows === 0 && closed.audios === 0 && closed.topShown === 'none',
    `pressing Close makes the player disappear, exactly as the word promises ` +
      `(${closed?.rows} rows, ${closed?.audios} <audio>, top ${closed?.topShown})`,
  );
  ok(closed && closed.label === '▶ Play', `and the row goes back to offering Play (${closed?.label})`);

  // ── the fallback: filter the playing clip out of the list ───────────────
  // 🔴 The player row only exists while its clip is RENDERED, and Search can hide it mid
  // playback. The element has to go somewhere or it leaves the document and Blink stops it —
  // which is why #scPlayer still exists. Without this check that path is never exercised, and
  // a search would silently kill playback.
  const hidden = await evaluate(
    cdp,
    `(() => {
        document.querySelector('#scList button[data-act="play"]').click();
        const box = document.getElementById('scSearch');
        box.value = 'zzz no clip is called this zzz';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const au = ${CLIPS}.querySelector('audio');
        return { rows: document.querySelectorAll('#scList tr.scPlay').length,
                 audios: ${CLIPS}.querySelectorAll('audio').length,
                 atTop: !!document.querySelector('#scPlayer audio'),
                 topShown: getComputedStyle(document.getElementById('scPlayer')).display,
                 playing: !!au && !au.paused };
    })()`,
  );
  ok(
    hidden && hidden.rows === 0 && hidden.atTop && hidden.topShown !== 'none',
    `filtering the playing clip out of the list falls back to the bar at the top, shown ` +
      `(${hidden?.rows} rows, atTop=${hidden?.atTop}, display=${hidden?.topShown})`,
  );
  ok(
    hidden && hidden.audios === 1 && hidden.playing,
    `and playback carries on through it — the element never left the document ` + `(playing=${hidden?.playing})`,
  );
  await evaluate(
    cdp,
    `(() => {
        const box = document.getElementById('scSearch');
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
  ok(
    await evaluate(
      cdp,
      `(() => {
        const play = document.querySelector('#scList tr.scPlay');
        return !!(play && play.querySelector('audio'))
               && getComputedStyle(document.getElementById('scPlayer')).display === 'none';
    })()`,
    ),
    'and clearing the search brings its row — and the player — back inline',
  );

  // ── toggling: same button closes, another row moves the expansion ───────
  const toggled = await evaluate(
    cdp,
    `(() => {
        const det = document.querySelector('#scList tr.scDet');
        const own = document.querySelector(\`#scList tr[data-ref="\${det.dataset.detref}"]\`);
        own.querySelector('button[data-act="chapters"]').click();
        return document.querySelectorAll('#scList tr.scDet').length;
    })()`,
  );
  ok(toggled === 0, `clicking Chapters again closes it (${toggled} expanded)`);

  // ── m4i / §9a.3: whose voice is this? ───────────────────────────────────────────────
  //
  // Show the speaker avatar and name beside each clip, with a character-name filter.
  //
  // The seeded scene has two speakers, so it exercises the "+N others" form and the filter at once.
  const who = await evaluate(
    cdp,
    `(() => {
        // 9.5.7 - strip the sort arrow; see clips_table_layout_spec.mjs for what -1 costs.
        const heads = [...document.querySelectorAll('#scList thead th')].map(h => h.textContent.replace(/[▲▼]/g, '').trim());
        const tr = document.querySelector('#scList tr[data-ref]');
        const cells = [...tr.querySelectorAll('td')];
        const idx = heads.indexOf('Character');
        const cell = cells[idx];
        return {heads, idx,
                // The cell text includes the circle's initial letter, so the NAME is read from
                // its own span; the initials badge and speaker count are separate elements.
                text: cell ? cell.textContent.replace(/\\s+/g, ' ').trim() : null,
                name: cell && cell.querySelector('.scWhoName') ? cell.querySelector('.scWhoName').textContent : null,
                tip: cell && cell.querySelector('[title]') ? cell.querySelector('[title]').getAttribute('title') : null,
                face: !!(cell && cell.querySelector('.wbface')),
                cols: cells.length};
    })()`,
  );

  ok(who.idx >= 0, `the Clips table has a Character column (${who.heads.join(' | ')})`);
  // "the very first column after the checkbox" — the star took that slot in 6.2, so this sits
  // immediately after it and before the clip's own name, which is the order he asked for.
  ok(who.idx === 2, `and it sits before Name, right after the star (index ${who.idx})`);
  ok(who.face, 'the row draws a circular face for the speaker');
  ok(who.name === 'Test Character 1', `and names the first speaker (${JSON.stringify(who.name)})`);
  // A two-hander is not one character, and the row must not claim it is.
  ok(/\+1/.test(who.text), `with a count of the others rather than a second circle (${who.text})`);
  ok(
    (who.tip || '').includes('Test Character 1') && (who.tip || '').includes('Test Character 2'),
    `and the tooltip names them all (${who.tip})`,
  );

  // The drop-down is built from the characters actually present, and it narrows the list.
  const filt = await evaluate(
    cdp,
    `(async () => {
        const sel = document.getElementById('scCharFilter');
        const opts = [...sel.options].map(o => o.textContent);
        sel.value = 'Test Character 2';
        sel.dispatchEvent(new Event('change'));
        const shown = document.querySelectorAll('#scList tr[data-ref]').length;
        sel.value = 'Nobody At All';
        sel.dispatchEvent(new Event('change'));
        const missing = sel.value;
        sel.value = '';
        sel.dispatchEvent(new Event('change'));
        return {opts, shown, missing, all: document.querySelectorAll('#scList tr[data-ref]').length};
    })()`,
  );

  ok(
    filt.opts.includes('Test Character 1') && filt.opts.includes('Test Character 2'),
    `the character filter is built from who is actually present (${filt.opts.join(', ')})`,
  );
  ok(filt.shown >= 1, `picking a character keeps the scenes they speak in (${filt.shown})`);
  // A scene contains clips from both speakers, so filtering by either name must find it.
  ok(filt.all >= filt.shown, `and clearing the filter puts them all back (${filt.all})`);
  // A name that is not an option must not silently re-point the filter at whatever sits at
  // that index — it falls back to showing everything.
  ok(filt.missing === '', `a filter value that no longer exists falls back to all (${JSON.stringify(filt.missing)})`);

  ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join(' | ') || 'none'})`);

  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} check(s) failed` : '\nall Chapters browser checks passed');
} catch (e) {
  console.error(`spec error: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

// Vocalis 8.0.2 — paging and a multi-select delete on the STEMS tab's song list, in a REAL browser.
//
// Browser coverage for paging and multi-select deletion on the Stems song list. Deletion
// applies only to uploaded items, not songs owned by the ACE-Step library.
// 🔴 THE FEATURE EXISTS BECAUSE TWO PANELS WERE THE SAME LIST AND ONLY ONE COULD DELETE. `ssLoadSongs`
// and `vsLoadSongs` both GET `/voiceswap/songs`, so a song carries the same `stems stored` badge in
// the Stems tab and in Voice Swap ▸ Sources — which is what he was reporting when he said he kept
// seeing "some of the same stuff" in both. Sources got paging and a bulk delete at 8.0.1 and this
// panel got neither, so the same row was deletable in one place and not the other.
//
// WHY A BROWSER, when `/voiceswap/songs` DELETE has taken a list of refs since M4 and
// `test_voiceswap.py` covers it down to the bytes: because the route was never the limitation, and
// the four things worth checking are ones no route test can reach.
//
//   1. 🔴 A TICK MUST NOT ALSO SELECT THE ROW AS THE SONG TO SPLIT. The checkbox sits inside the
//      `.vsrow` whose delegated handler sets `ss.song`. Get the exclusion wrong and ticking six rows
//      for deletion silently re-points the tray six times, and Split then runs on a song he never
//      chose — a 90-second Demucs pass on the wrong file, invisible until it finishes.
//   2. 🔴 SELECT ALL MUST REACH EVERY PAGE AND ONLY THE UPLOADS. Both halves are the request. A
//      per-page Select all is the slower version of the one-at-a-time it replaces; and one that
//      swept in the ACE library row would offer to delete a file this panel must never touch.
//   3. 🔴 THE SELECTION SURVIVES PAGING AND DIES ON A FILTER, WHICH ARE NOT THE SAME RULE. It is a
//      Set rather than a DOM read because page 2 would otherwise forget page 1 — so the safety a DOM
//      read gets for free has to be re-established: every render drops the ticks the filter hides.
//   4. 🔴 DELETING A SONG MUST NOT DELETE ITS STEMS, AND THE DIALOG MUST SAY SO. A set is keyed on
//      the song's content hash, not on the song file existing, so the stems survive by construction.
//      That is the exact thing he was confused about, so a silent survival is not enough — the
//      confirm has to name it, and the set has to still be in `#ssLib` afterward.
//
// ⚠️ THE FIXTURE IS 30 UPLOADS ON PURPOSE. 25 per page is the whole feature; with 24 rows every
// paging assertion below is vacuously true and the spec would stay green through the pager being
// deleted outright.
//
// Usage: node ss_songs_bulk_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_NET_IDLE, NET_IDLE, NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node ss_songs_bulk_browser_spec.mjs <base-url> <chrome-path>');
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

/** Read `expression` until it stops changing.
 *
 * 🔴 "THE ROWS EXIST" IS NOT "THE LIST HAS FINISHED ARRIVING". `ssLoadAll()` awaits `ssLoadLib()`
 * and then `ssLoadSongs()`, and `ssLoadLib` re-renders the picker itself once the sets land — so one
 * tab click repaints `#ssPicker` twice. A tick made in that window is thrown away by the render that
 * lands next and the count read back is the one from before, which fails as "the checkbox does
 * nothing", pointing at the feature instead of at the wait. Green alone, red under 16 workers.
 */
// 🔴 SUPERSEDED 2026-10-12 — "STOPPED CHANGING FOR 120 ms" IS A SLEEP IN A LOOP. This read
// `expression` twice, `quietMs` apart, and called the list finished when both reads agreed. On a
// loaded machine the second repaint of one tab click (`ssLoadLib`, then `ssLoadSongs`) can land
// more than 120 ms after the first, so the two reads agreed on the HALF-finished list and the tick
// made next was thrown away; the clicks that repaint synchronously only ever used the sleep to
// confirm what the first read already showed. What "finished arriving" means is that the page has
// no request in flight and no response body still being read: every step of that load chain
// continues in the microtasks that run right after the last body is read, so once the count is
// zero in a LATER task the chain has ended, and the frame after it has painted. INSTALL_NET_IDLE
// counts exactly that, and the wait is for it. The deadline is only a bound on a hang, and a page
// that never goes idle is an error rather than a pass.
async function settled(cdp) {
  if (!(await waitFor(cdp, NET_IDLE, 30000)))
    throw new Error('the page never went idle: a request or a response body stayed in flight for 30 s');
  await evaluate(cdp, NEXT_FRAME);
  return true;
}

const rowCount = `document.querySelectorAll('#ssPicker .item').length`;
const refs = `[...document.querySelectorAll('#ssPicker .item')].map(r => r.dataset.song || '')`;
const boxRefs = `[...document.querySelectorAll('#ssPicker input[data-sssrcpick]')].map(b => b.dataset.sssrcpick)`;
const ticked = `document.querySelectorAll('#ssPicker input[data-sssrcpick]:checked').length`;
const pagerTxt = `document.getElementById('ssPickerPager').textContent`;
const totalsTxt = `document.getElementById('ssPickerTotals').textContent`;
const badges = `[...document.querySelectorAll('#ssPicker .item')].filter(r => /stems stored/.test(r.textContent)).length`;
// ⚠️ `data-sspick` is the STEM SET's checkbox (stemwidget.js:104) and `data-sssrcpick` is the new
// SONG one. Two lists on one tab, two attributes — near-identical names, exact-match selectors.
const libRefs = `[...document.querySelectorAll('#ssLib [data-sspick]')].map(b => b.dataset.sspick)`;

const settle = cdp => settled(cdp);

async function setName(cdp, value) {
  await evaluate(
    cdp,
    `(() => {
        const f = document.getElementById('ssPickerFilter');
        f.value = ${JSON.stringify(value)};
        f.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`,
  );
  await settle(cdp);
}

/** Tick one row by its song ref, the way a human does — a real click on the box. */
async function tick(cdp, ref) {
  const ticked = await evaluate(
    cdp,
    `(() => {
        const b = document.querySelector(
            '#ssPicker input[data-sssrcpick=' + JSON.stringify(${JSON.stringify(ref)}) + ']');
        if (!b) return false;
        b.click(); return true; })()`,
  );
  if (!ticked) {
    // A box that is not there is reported with what the picker holds, so a failure names the
    // state the list was in instead of leaving it to be guessed.
    const held = await evaluate(
      cdp,
      `({ rows: document.querySelectorAll('#ssPicker .item').length,
          folders: document.querySelectorAll('#ssPicker .vfolder').length,
          pager: document.getElementById('ssPickerPager').textContent,
          totals: document.getElementById('ssPickerTotals').textContent,
          inFlight: window.__specNet ? window.__specNet.n : null,
          first: [...document.querySelectorAll('#ssPicker .item')].slice(0, 3).map(r => r.dataset.song || '') })`,
    );
    console.log(`  (no box for ${ref}; the picker holds ${JSON.stringify(held)})`);
  }
  return ticked;
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
  await evaluate(cdp, INSTALL_NET_IDLE); // before the first click, so no request goes uncounted

  await evaluate(
    cdp,
    `(() => {
        document.querySelector('[data-tab="voicestudio"]').click();
        document.querySelector('[data-vstab="stems"]').click();
        return true; })()`,
  );
  // 32 songs: 30 uploads + 1 ACE-Step output + 1 ACE library song. Page 1 shows 25 of them.
  ok(await waitFor(cdp, `${rowCount} === 25`, 15000), 'a 32-song list paints TWENTY-FIVE rows, not all of them');
  await settle(cdp);

  // ── 🔴 8.6.6: SONGS AND YOUR STEMS ARE ONE CARD, AND THE PILLS SWAP IT ──────
  //
  // Checked HERE, in the browser, rather than only as source text, because all three ways this
  // breaks are invisible to a source assertion: a mismatched attribute value hides both halves
  // and leaves an EMPTY card, a toolbar that does not swap leaves the songs filter sitting over
  // the stems list, and a pill whose label wraps is a two-line tower that reads as a design.
  const pill = v => `document.querySelector('[data-ssview="${v}"]')`;
  const shown = id => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
  const viewShown = v => `getComputedStyle(document.querySelector('[data-ssviewpanel="${v}"]')).display !== 'none'`;
  ok(await evaluate(cdp, `!!${pill('songs')} && !!${pill('lib')}`), 'both view pills are in the card header');
  ok(
    await evaluate(cdp, `${viewShown('songs')} && !${viewShown('lib')} && ${shown('ssSongsTools')} && !${shown('ssLibTools')}`),
    'it opens on Songs — the stems half and its toolbar are both hidden, not just the list',
  );
  // 🔴 THE LABEL IS ONE LINE. A Range over the contents yields one client rect per line box,
  // so this is font-size independent and verifies the one-line button-label contract. See
  // feedback_buttons_are_horizontal.
  ok(
    await evaluate(
      cdp,
      `['songs','lib'].every(v => {
          const r = document.createRange(); r.selectNodeContents(document.querySelector('[data-ssview="'+v+'"]'));
          return r.getClientRects().length === 1; })`,
    ),
    "…and neither pill's label wraps onto a second line",
  );
  // Mark the live rows on BOTH sides, so "the card changed" can be told apart from "the card
  // was rebuilt" — a rebuild is what 8.6.1 fixed in `ssRenderLib`, and it costs him the player
  // he is listening to.
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('#ssPicker .item').__pin = 'song';
        document.querySelector('#ssLib .stemset').__pin = 'stem'; return true; })()`,
  );
  await evaluate(cdp, `${pill('lib')}.click()`);
  ok(
    await evaluate(cdp, `${viewShown('lib')} && !${viewShown('songs')} && ${shown('ssLibTools')} && !${shown('ssSongsTools')}`),
    '🔴 clicking Your stems swaps the card CONTENT and its toolbar together',
  );
  ok(
    await evaluate(cdp, `getComputedStyle(${pill('lib')}).backgroundColor !== getComputedStyle(${pill('songs')}).backgroundColor`),
    'and the chosen pill is filled — read off the COMPUTED style, because a class alone can be overridden',
  );
  await evaluate(cdp, `${pill('songs')}.click()`);
  ok(
    await evaluate(cdp, `${viewShown('songs')} && !${viewShown('lib')}`),
    'and back again, which is the whole ask — no scrolling either way',
  );
  ok(
    await evaluate(
      cdp,
      `document.querySelector('#ssPicker .item').__pin === 'song'
          && document.querySelector('#ssLib .stemset').__pin === 'stem'`,
    ),
    '🔴 …and BOTH halves are the same DOM they were — a pill hides, it never re-renders, so a ' +
      'stem playing in the half he flipped away from is still playing when he flips back',
  );

  // ── the pager ────────────────────────────────────────────────────────────
  const p1 = await evaluate(cdp, pagerTxt);
  ok(/Page 1 of 2/.test(p1), `and says where you are — "Page 1 of 2" (${JSON.stringify(p1)})`);
  ok(
    await evaluate(cdp, `document.getElementById('ssSrcPrev').disabled === true`),
    'Previous is disabled on page 1 rather than absent, so the control does not move under him',
  );
  ok(await evaluate(cdp, `document.getElementById('ssSrcNext').disabled === false`), 'and Next is live');
  ok(/showing 1–25/.test(await evaluate(cdp, totalsTxt)), 'the totals line says WHICH twenty-five, not just how many there are');
  // 🔴 NO PAGE-SIZE CONTROL — the same instruction Sources got: *"without giving me page sizes."*
  ok(!/show all|per page/i.test(p1), `and offers no page-size control — he asked for 25, full stop (${JSON.stringify(p1)})`);

  const page1Refs = await evaluate(cdp, refs);
  await evaluate(cdp, `document.getElementById('ssSrcNext').click()`);
  await settle(cdp);
  ok((await evaluate(cdp, `${rowCount}`)) === 7, 'Next lands on the remaining seven — 25 + 7 = the whole list, nothing dropped');
  ok(/Page 2 of 2/.test(await evaluate(cdp, pagerTxt)), 'and the pager keeps up');
  ok(
    await evaluate(cdp, `document.getElementById('ssSrcNext').disabled === true`),
    'Next is disabled at the end — there is no page 3 to walk into',
  );
  const page2Refs = await evaluate(cdp, refs);
  ok(
    page2Refs.every(r => !page1Refs.includes(r)),
    'page 2 shares no row with page 1 — the slice is a real window, not a re-sort',
  );

  // ── 🔴 AND THE PAGE IT LANDS ON IS NOT UNDER THE PINNED BAR ──────────────
  //
  // `ssSrcGo` got the same 9.0.8 change as `vsSrcGo`: `scrollIntoView({block:'start'})` aligns the
  // target flush with the VIEWPORT top, which is behind the sticky header and the pinned tab bar,
  // so turning a page put the top of the list you asked for underneath the chrome. The Sources
  // pager is pinned in vs_sources_bulk_browser_spec.mjs; this is the other half, and it exists
  // because the fix touched BOTH pagers while only one of them was covered.
  //
  // 🔴 THE PAGE IS GIVEN ROOM TO SCROLL, WITHOUT WHICH THIS CANNOT FAIL. The sibling check was
  // written first without it and passed with the fix deleted — there is not enough page BELOW the
  // picker for `block:'start'` to reach the top, so the list landed under nothing and the
  // assertion proved nothing. The height is put back immediately: everything after this measures
  // rows and ticks on the page as the fixture built it.
  const ssLanding = await evaluate(
    cdp,
    `(async () => {
        const p = document.getElementById('ssPicker');
        const bar = document.getElementById('tabs');
        const main = document.querySelector('main');
        if (!p || !bar || p.offsetParent === null) return { skip: 'the speech picker is not rendered' };
        const wasMinH = main.style.minHeight;
        main.style.minHeight = (document.documentElement.scrollHeight + 3000) + 'px';
        // 🔴 THE PRODUCT'S SMOOTH SCROLL IS WAITED FOR BY ITS OWN END EVENT, NOT BY A DURATION. This
        // was a fixed 700 ms ("it is a smooth scroll"): on a loaded machine the animation has not
        // finished by then and the position is read mid-flight. Start from the top (instant, so a
        // scroll is certain to be needed), install the scrollend listener BEFORE the call, and
        // read the landing only when it fires. The 15 s deadline is only a bound on a hang; if it is
        // the one that fires, landed is false and the really-scrolled check below fails.
        // ⚠️ ONLY A scrollend THAT ARRIVES AWAY FROM THE TOP COUNTS, which was learned in the first
        // version (6 of 16 copies at once read scrollY 0): the Next and Previous presses earlier in
        // this spec start smooth scrolls of their own (ssSrcGo), and the instant jump to the top
        // below cancels one and queues a scrollend that the browser delivers in its next rendering
        // step, i.e. AFTER this listener is installed. That stale event ended the wait before the
        // scroll under test had started. The scroll under test lands below the top; the stale one
        // is delivered at the top and is ignored.
        window.scrollTo({ top: 0, behavior: 'instant' });
        const ended = new Promise(r => {
          document.addEventListener('scrollend', () => { if (window.scrollY > 0) r(true); });
          setTimeout(() => r(false), 15000);
        });
        window.__VOCALIS__['util/dom.js'].scrollUnderStick(p);
        const landed = await ended;
        const out = { landed, listTop: p.getBoundingClientRect().top,
                      barBottom: bar.getBoundingClientRect().bottom,
                      stickH: getComputedStyle(document.documentElement).getPropertyValue('--stick-h').trim(),
                      scrolled: window.scrollY };
        main.style.minHeight = wasMinH;
        window.scrollTo(0, 0);
        return out; })()`,
  );
  if (ssLanding.skip) {
    ok(false, `the speech picker is rendered so its scroll landing can be measured (${ssLanding.skip})`);
  } else {
    ok(
      ssLanding.landed && ssLanding.scrolled > 0,
      `the page really scrolled, so the landing is a real measurement (scrollY ${ssLanding.scrolled})`,
    );
    ok(
      ssLanding.listTop >= ssLanding.barBottom - 1,
      '🔴 paging the speech list leaves its top BELOW the pinned tab bar, not behind it — ' + JSON.stringify(ssLanding),
    );
  }

  // ── 🔴 A CHECKBOX ON EVERY ROW, AND THE *DELETE* IS WHAT NARROWS (8.9.14) ─
  // ⚠️ The checkbox is universal: a row can be filed or queued even when its source owns deletion.
  // Delete acts only on removable rows, reports how many are spared, and disables when none can be
  // removed. The server still rejects an un-deletable ref (web/voiceswap.py:253); that refusal is
  // the enforcement boundary. Read across BOTH pages so a missed row cannot escape the check.
  const boxesAll = (await evaluate(cdp, boxRefs)).slice();
  await evaluate(cdp, `document.getElementById('ssSrcPrev').click()`);
  await settle(cdp);
  boxesAll.push(...(await evaluate(cdp, boxRefs)));
  const allRefs = page1Refs.concat(page2Refs);
  ok(
    boxesAll.length === 32 && allRefs.every(r => boxesAll.includes(r)),
    `🔴 EVERY row carries a checkbox, all thirty-two of them (${boxesAll.length} boxes)`,
  );
  ok(
    allRefs.some(r => r.startsWith('acelib/')) && boxesAll.some(r => r.startsWith('acelib/')),
    '🔴 the ACE library song is LISTED and HAS a checkbox — it can be filed and queued here even ' + 'though it is deleted where it lives',
  );
  ok(allRefs.some(r => r.startsWith('acestep/')) && boxesAll.some(r => r.startsWith('acestep/')), '…and the same for an ACE-Step output');

  // ── 🔴 THE HEADER CHECKBOX, AND IT REACHES EVERY PAGE ────────────────────
  // It is visible with NOTHING ticked — a Select all control hidden until an item is selected is
  // not usable.
  ok(
    await evaluate(cdp, `getComputedStyle(document.getElementById('ssSrcBulk')).display !== 'none'`),
    'the bulk bar is on screen before anything is ticked — the header box is the affordance',
  );
  ok(
    /Select all \(32 shown\)/.test(await evaluate(cdp, `document.getElementById('ssSrcAllNote').textContent`)),
    'and says how many it would take, so the number is not a surprise after the click',
  );
  await evaluate(cdp, `document.getElementById('ssSrcAll').click()`);
  await settle(cdp);
  ok(
    /32 selected/.test(await evaluate(cdp, totalsTxt)),
    '🔴 the header box ticks all THIRTY-TWO, not the 25 on screen — the visible page count is not ' +
      'the selected set, and a per-page Select all would be the slower version of the ' +
      'one-at-a-time it replaces',
  );
  // 🔴 AND THE BAR SAYS WHAT THE DELETE WILL SPARE: the two
  // ACE rows ARE ticked (they can be filed and queued) and the delete will not touch them, so the
  // bar has to say so rather than promising to delete thirty-two things.
  ok(
    /30 of 32 selected can be deleted here/.test(await evaluate(cdp, `document.getElementById('ssSrcBulkNote').textContent`)),
    '🔴 …and the bar says only 30 of the 32 can be deleted here — the two ACE rows are spared, ' + 'and it says so BEFORE the press',
  );
  ok(
    await evaluate(
      cdp,
      `document.getElementById('ssSrcAll').checked === true
                            && document.getElementById('ssSrcAll').indeterminate === false`,
    ),
    'the header box reads as fully checked when the whole set is in',
  );

  await evaluate(cdp, `document.getElementById('ssSrcBulkNone').click()`);
  await settle(cdp);
  ok(!/selected/.test(await evaluate(cdp, totalsTxt)), 'Clear puts them all back');

  // ── 🔴 8.9.14: FOLDERS ON THIS PICKER, over the SAME scope Voice Swap ▸ Sources files into ──
  //
  // `index.html` tells the user in bold that this "is the same list as Voice Swap ▸ Sources, which
  // reads the same store", and `folders.SCOPES` names both panels against `voiceswap_songs` — but
  // only one of the two had folders, so a song filed over there arrived here unfiled, unlabeled
  // and unmovable, which reads as the filing having been lost. Scope is the DATASET, not the panel.
  //
  // ⚠️ THE ROW FILED HERE IS DELIBERATELY AN ACE-STEP ONE. It is the row that had no checkbox at
  // all until this release, so it is the one that proves the gate is gone — and it is filed into a
  // folder by a panel that is not allowed to DELETE it, which is the whole point of separating the
  // two rules.
  const ssFid = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/folders/voiceswap_songs', {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Sample Folder'})});
        const j = await r.json();
        document.getElementById('ssPickerRefresh').click();
        return (j.folder && j.folder.id) || j.id || ''; })()`,
  );
  ok(!!ssFid, `a folder was created in voiceswap_songs (${JSON.stringify(ssFid)})`);
  ok(
    await waitFor(cdp, `!!document.querySelector('#ssPicker [data-vfadd="voiceswap_songs"], [data-vfadd="voiceswap_songs"]')`, 8000),
    'the ✚ Folder button is on the Stems ▸ Songs toolbar',
  );
  ok(
    await evaluate(cdp, `!!document.querySelector('[data-vfout="voiceswap_songs"]')`),
    '⇤ Remove from folder is on it too — the way back out',
  );
  ok(await waitFor(cdp, `!!document.querySelector('#ssPicker .vfolder')`, 8000), 'and the folder row paints in the list');

  const aceRef = await evaluate(
    cdp,
    `(() => { const b = [...document.querySelectorAll('#ssPicker input[data-sssrcpick]')]
        .find(x => String(x.dataset.sssrcpick || '').startsWith('acestep/'));
        if (!b) return ''; b.click(); return b.dataset.sssrcpick; })()`,
  );
  ok(!!aceRef, `the ACE-Step row can be ticked at all — it had no checkbox before 8.9.14 (${JSON.stringify(aceRef)})`);
  await evaluate(cdp, `document.querySelector('#ssPicker .vfolder [data-fact="move"]').click()`);
  ok(
    await waitFor(
      cdp,
      `(async () => { const d = await (await fetch('/folders/voiceswap_songs')).json();
          return (d.assign || {})[${JSON.stringify(aceRef)}] === ${JSON.stringify(ssFid)}; })()`,
      8000,
    ),
    '⇥ Move selected here FILES the ACE-Step row, and the server agrees',
  );

  // Open the folder, tick it inside, and take it back out. A filed row is reachable only through
  // its folder — that is what one level of folders MEANS — so the open is not optional.
  await evaluate(cdp, `document.querySelector('#ssPicker .vfolder [data-fact="open"]').click()`);
  await settle(cdp);
  await evaluate(
    cdp,
    `(() => { const b = document.querySelector('#ssPicker input[data-sssrcpick="' + ${JSON.stringify(aceRef)} + '"]');
        if (!b) return false; b.click(); return true; })()`,
  );
  await evaluate(cdp, `document.querySelector('[data-vfout="voiceswap_songs"]').click()`);
  ok(
    await waitFor(
      cdp,
      `(async () => { const d = await (await fetch('/folders/voiceswap_songs')).json();
          return !(d.assign || {})[${JSON.stringify(aceRef)}]; })()`,
      8000,
    ),
    '⇤ Remove from folder takes it back to the root, and the server agrees',
  );
  // 🔴 AND THE SCREEN AGREES TOO. A panel that merely re-rendered would repaint the row straight
  // back into the folder from its own stale `.folder` stamp — store right, screen wrong, and it
  // self-corrects on the next unrelated refresh, which is how it arrives later as a bug report
  // about something else. The count is the cheapest thing that can only be right after a refetch.
  ok(
    await waitFor(
      cdp,
      `(() => { const f = document.querySelector('#ssPicker .vfolder');
          return !!f && String(f.textContent || '').indexOf('(0)') >= 0; })()`,
      8000,
    ),
    'and the folder reads (0) on screen, so the rows were REFETCHED and not just repainted',
  );

  // Put the list back as the sections below expect it: no folder, nothing ticked.
  await evaluate(
    cdp,
    `(async () => { await fetch('/folders/voiceswap_songs/' + ${JSON.stringify(ssFid)}, {method: 'DELETE'});
        document.getElementById('ssPickerRefresh').click(); return true; })()`,
  );
  ok(
    await waitFor(cdp, `!document.querySelector('#ssPicker .vfolder')`, 8000),
    'removing the folder puts every song back in the main list, none of them deleted',
  );
  await evaluate(cdp, `document.getElementById('ssSrcBulkNone').click()`);
  await settle(cdp);

  // ── 🔴 A TICK IS NOT A PICK ──────────────────────────────────────────────
  const one = page1Refs.find(r => r.startsWith('uploads/'));
  ok(await tick(cdp, one), `a row takes a tick (${JSON.stringify(one)})`);
  ok(/1 selected/.test(await evaluate(cdp, totalsTxt)), 'the totals line counts it immediately');
  ok(
    await evaluate(cdp, `!document.querySelector('#ssPicker .item.active')`),
    '🔴 …and ticking it did NOT also choose it as the song to split — no row went active',
  );
  ok(
    await evaluate(cdp, `document.getElementById('ssSrcAll').indeterminate === true`),
    'and the header box goes indeterminate on a partial selection rather than lying either way',
  );

  // ── 🔴 THE SELECTION SURVIVES PAGING ─────────────────────────────────────
  await evaluate(cdp, `document.getElementById('ssSrcNext').click()`);
  await settle(cdp);
  ok((await evaluate(cdp, `${ticked}`)) === 0, "page 2's own boxes are all clear — the page-1 tick is not painted on a page-2 row");
  ok(
    /1 selected/.test(await evaluate(cdp, totalsTxt)),
    '🔴 but the SELECTION still holds it — paging away from a tick must not silently drop it',
  );
  const onTwo = page2Refs.find(r => r.startsWith('uploads/'));
  await tick(cdp, onTwo);
  ok(/2 selected/.test(await evaluate(cdp, totalsTxt)), 'a second tick on this page joins it rather than replacing it');

  // ── 🔴 …AND DIES ON A FILTER, WHICH IS THE OPPOSITE RULE ─────────────────
  // "Delete selected" against rows he cannot see is the one mistake on this panel that costs him
  // audio, so every render prunes the Set to what the filter shows.
  await setName(cdp, 'Sample Track Two');
  ok((await evaluate(cdp, `${rowCount}`)) === 1, 'a name filter narrows to the one ACE-Step row');
  ok(
    !/selected/.test(await evaluate(cdp, totalsTxt)),
    '🔴 and the two ticks it hid are DROPPED, not carried into the next Delete selected',
  );
  // ⚠️ 8.9.14 — THE BAR STAYS, AND THE DELETE DISABLES ITSELF. It used to vanish whenever nothing
  // was deletable, which was right while it held only a delete. It now also carries `Clear`,
  // `➕ Add to split queue` and the ticks that `⇥ Move selected here` / `⇤ Remove from folder`
  // read — all of which work perfectly on an ACE-Step row. Hiding it here would remove three
  // working verbs to spare one that is merely grayed out.
  ok(
    await evaluate(cdp, `getComputedStyle(document.getElementById('ssSrcBulk')).display !== 'none'`),
    'the bar stays for the ACE-Step row — it still files, un-files and queues, only the delete goes',
  );
  ok(
    await evaluate(cdp, `document.getElementById('ssSrcBulkDel').disabled === true`),
    '…and 🗑 Delete selected is DISABLED, because this panel owns none of what is left',
  );
  ok(
    await evaluate(cdp, `getComputedStyle(document.getElementById('ssPickerPager')).display === 'none'`),
    'and one page needs no pager at all',
  );

  // ── the filter puts you back on page 1 ───────────────────────────────────
  await setName(cdp, '');
  await evaluate(cdp, `document.getElementById('ssSrcNext').click()`);
  await settle(cdp);
  ok((await evaluate(cdp, `${rowCount}`)) === 7, 'back on page 2 to set the trap');
  await setName(cdp, 'Track');
  ok(
    (await evaluate(cdp, `${rowCount}`)) === 25,
    '🔴 typing a filter lands on page ONE — the clamp alone would leave him on page 2 of a ' +
      'list that just changed under him, which reads as "the filter ate my rows"',
  );

  // ── 🔴 THE DELETE, AND THE STEMS THAT SURVIVE IT ─────────────────────────
  // "aaaaaa0" matches Track 01…09 and nothing else: after six a's, Track 10/20/30 carry a digit
  // that is not 0. Nine rows, one page, and Track 01 among them — the one with a stem set.
  await setName(cdp, 'aaaaaa0');
  ok((await evaluate(cdp, `${rowCount}`)) === 9, 'a filter narrows to nine uploads');
  ok(
    (await evaluate(cdp, `${badges}`)) === 1,
    'exactly one of them shows the “stems stored” badge — the badge this whole panel confused ' +
      'him about, because Sources shows the very same one',
  );
  const setsBefore = await evaluate(cdp, libRefs);
  ok(setsBefore.length === 1, `and the stem set is in Your stems below (${JSON.stringify(setsBefore)})`);

  await evaluate(cdp, `document.getElementById('ssSrcAll').click()`);
  await settle(cdp);
  ok(
    /9 selected/.test(await evaluate(cdp, totalsTxt)),
    '🔴 Select all under a filter takes the nine it is SHOWING — never the thirty behind it',
  );
  await evaluate(cdp, `document.getElementById('ssSrcBulkDel').click()`);
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`, 8000), 'Delete selected confirms first');
  const body = await evaluate(cdp, `document.getElementById('mBody').textContent`);
  ok(/deleted from disk/.test(body), `the dialog says an upload leaves the disk (${JSON.stringify(body.slice(0, 100))})`);
  // Release audit 2026-10-11: this used to assert that the dialog names "Voice Swap ▸ Sources", the
  // second panel that read the same store. Voice Swap is not in the Docker package, so naming it
  // would point at a tab that does not exist; the dialog now says only that the song goes from
  // this list.
  ok(
    /go from this list\./.test(body) && !/Voice Swap/.test(body),
    '🔴 and says it goes from this list, without naming a panel the package does not have',
  );
  ok(
    /stems are kept/.test(body),
    "🔴 …and says the stems SURVIVE — a set is keyed on the song's content hash, not on the " +
      'file, so silence here would read as "my stems went with it"',
  );
  await evaluate(
    cdp,
    `(() => {
        const b = [...document.querySelectorAll('#mActs button')]
            .find(x => /Delete/.test(x.textContent));
        if (b) b.click(); return !!b; })()`,
  );

  ok(await waitFor(cdp, `${rowCount} === 0`, 15000), 'the nine go from the list');
  await setName(cdp, '');
  await settle(cdp);
  ok(
    /23 songs/.test(await evaluate(cdp, totalsTxt)),
    '🔴 and the list comes back nine shorter — 21 uploads + the two rows it may not touch',
  );
  ok(
    !/selected/.test(await evaluate(cdp, totalsTxt)),
    'with an empty selection — a delete that left its own ticks behind would offer to run twice',
  );
  ok((await evaluate(cdp, `${badges}`)) === 0, 'no “stems stored” badge is left, because the song that carried it is gone');
  // 🔴 THE SET ITSELF IS STILL THERE. This is the whole point of the confirm wording.
  const setsAfter = await evaluate(cdp, libRefs);
  ok(
    setsAfter.length === 1 && setsAfter[0] === setsBefore[0],
    `🔴 …but its STEM SET is untouched in Your stems (${JSON.stringify(setsAfter)}) — deleting a ` +
      'song never deletes the separation made from it',
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

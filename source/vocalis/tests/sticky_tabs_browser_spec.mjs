// Vocalis 9.0.8 / 9.0.10 — BOTH tab rows stay under the header while the page scrolls, in a
// REAL browser.
//
// 🔴 WHY A BROWSER, AND WHY GEOMETRY RATHER THAN A COMPUTED STYLE. `position:sticky` is the one
// declaration in CSS that fails SILENTLY and completely: any ancestor with `overflow` set to
// anything but `visible` turns it back into `position:static` while `getComputedStyle` keeps
// reporting `'sticky'`. So asserting the style would pass over a bar that does not stick, today
// and after any future wrapper is added around `<main>`. The only honest question is where the
// element ENDS UP once the document has actually scrolled, and that needs a layout engine.
//
// 🔴 AND THE HEADER'S HEIGHT IS NOT A CONSTANT, which is the second thing checked here. `header`
// is itself sticky at `top:0`, so the tabs pin below it at a `--hdr-h` that `js/ui/stickytabs.js`
// MEASURES — the header grows and shrinks at runtime as GPU cards arrive and sensor rows appear.
// A hard-coded offset would be right on one box and would either overlap the header or leave a
// band of page background under it everywhere else, so the spec compares the two rectangles
// rather than trusting a number.
//
// ⚠️ No backticks inside the CDP expressions — they are template literals here.
//
// Usage: node sticky_tabs_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { NEXT_FRAME } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node sticky_tabs_browser_spec.mjs <base-url> <chrome-path>');
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

// ── CDP plumbing (mirrors power_line_browser_spec.mjs) ───────────────────────
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
    // `Promise.resolve(...)`, never `!!(...)` — see power_line_browser_spec.mjs's long note: a
    // bare `!!aPromise` is synchronously true and the wait returns on its first poll.
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

/**
 * Resize the page's viewport by emulation, and return only once the PAGE has taken the new size
 * and a frame has been drawn since. False when the page never reached that size, which the
 * check that follows folds in so an unproven resize cannot pass.
 *
 * 🔴 THIS REPLACES `sleep(250)` / `sleep(400)` / `sleep(300)` AFTER EVERY RESIZE (2026-10-12).
 * What those waited for is the `resize` event and the ResizeObserver callbacks that run
 * `measure()` in `js/ui/stickytabs.js`; both are delivered by the browser's rendering step, so
 * how long that takes depends on how busy the machine is, and a fixed pause is only the author's
 * machine. `window.innerWidth/innerHeight` is the page's own proof it has been resized; the
 * resize steps run in the rendering step ahead of the animation-frame callbacks and the
 * ResizeObserver step follows layout in that same step, so two frames drawn after that proof
 * (NEXT_FRAME) mean `measure()` has run for the new size.
 */
async function resizeViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return viewportSettled(cdp, width, height);
}
async function viewportSettled(cdp, width, height) {
  const there = await waitFor(cdp, `window.innerWidth === ${width} && window.innerHeight === ${height}`, 30000);
  await evaluate(cdp, NEXT_FRAME);
  return there;
}

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-sticky-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Mute browser audio in these specs; see power_line_browser_spec.mjs.
    '--mute-audio',
    '--ignore-certificate-errors',
    // 🔴 A SHORT WINDOW ON PURPOSE. The whole feature is about a page taller than the viewport,
    // and 1200px of height on an empty Playground tab is not reliably scrollable.
    '--window-size=1400,700',
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
  // Wait for Chrome to actually go before deleting its profile — an immediate recursive delete
  // throws EBUSY on Windows, and a swallowed one leaked 4.76 GB from a single suite run.
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

/** The two rectangles the whole feature is about, plus the scroll position they were read at. */
const GEOM = `(() => {
    const t = document.getElementById('tabs').getBoundingClientRect();
    const h = document.querySelector('header').getBoundingClientRect();
    return {
      tabTop: t.top, tabBottom: t.bottom, tabLeft: t.left, tabRight: t.right,
      hdrBottom: h.bottom, hdrHeight: h.height,
      scrollY: window.scrollY,
      viewport: window.innerHeight,
      hdrVar: getComputedStyle(document.documentElement).getPropertyValue('--hdr-h').trim(),
      pos: getComputedStyle(document.getElementById('tabs')).position,
    }; })()`;

/**
 * 🔴 BOTH PINNED ROWS AT ONCE (9.0.10) — the top bar and the open panel's sub-tab bar.
 * Read together and in one round trip, because the whole claim is about where they sit RELATIVE
 * to each other: two rows can each be "on screen" and still be stacked on top of one another.
 */
const TWO_ROWS = `(() => {
    const root = document.documentElement;
    const t = document.getElementById('tabs').getBoundingClientRect();
    const sub = document.getElementById('vsTabs');
    const s = sub.getBoundingClientRect();
    const h = document.querySelector('header').getBoundingClientRect();
    const cs = getComputedStyle(root);
    return {
      hdrBottom: h.bottom,
      tabTop: t.top, tabBottom: t.bottom, tabHeight: t.height,
      subTop: s.top, subBottom: s.bottom, subHeight: s.height,
      subPos: getComputedStyle(sub).position,
      subBg: getComputedStyle(sub).backgroundColor,
      tabsHVar: cs.getPropertyValue('--tabs-h').trim(),
      stickVar: cs.getPropertyValue('--stick-h').trim(),
      scrollY: window.scrollY,
      viewport: window.innerHeight,
    }; })()`;

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
  await waitFor(cdp, `window.__bootDone === true`);

  // ── the measurement reached the page ────────────────────────────────────
  // `--hdr-h` is what `js/ui/stickytabs.js` publishes, and it is the only link between the
  // header's real height and where the tab bar pins. A stale or missing value is the failure
  // that leaves a band of page background between the two, so it is checked against the header
  // itself rather than against a number written here.
  const before = await evaluate(cdp, GEOM);
  ok(before.pos === 'sticky', `the tab bar is position:sticky (got ${JSON.stringify(before.pos)})`);
  ok(
    before.hdrVar.endsWith('px') && Math.abs(parseFloat(before.hdrVar) - before.hdrHeight) < 0.5,
    `--hdr-h tracks the header's measured height (${before.hdrVar} vs ${before.hdrHeight.toFixed(1)}px)`,
  );

  // ── make the document genuinely taller than the window ───────────────────
  // ⚠️ THE PAGE IS MADE SCROLLABLE, AND THAT IS A PRECONDITION RATHER THAN THE THING UNDER TEST.
  // The fixture length is not under test; the contract is that the bar stays pinned
  // once the document scrolls. Growing `<main>` changes no ancestor's
  // `overflow`, so the landmine this spec exists for is fully in play.
  await evaluate(cdp, `(() => { document.querySelector('main').style.minHeight = '4000px'; return true; })()`);
  // `behavior: 'instant'`: the spec issues this scroll, so it is finished when the call returns
  // and the `getBoundingClientRect` below forces the layout that places the sticky bar. This was
  // `scrollTo(0, 1200)` followed by `sleep(150)`.
  await evaluate(cdp, `window.scrollTo({ top: 1200, behavior: 'instant' })`);

  const after = await evaluate(cdp, GEOM);
  ok(after.scrollY > 600, `the page really scrolled (scrollY ${after.scrollY})`);

  // 🔴 THE ASSERTION THE FEATURE IS. Before the fix the bar scrolled away with the content, so
  // its top would be far above the viewport — a large negative number — while the header, which
  // has always been sticky, stayed at the top.
  ok(
    after.tabTop > 0 && after.tabBottom < after.viewport,
    `🔴 the tab bar is still on screen after scrolling ${after.scrollY}px ` +
      `(top ${after.tabTop.toFixed(1)}, bottom ${after.tabBottom.toFixed(1)}, viewport ${after.viewport})`,
  );
  ok(
    Math.abs(after.tabTop - after.hdrBottom) <= 2,
    `and it sits flush under the header rather than over or below it ` +
      `(tab top ${after.tabTop.toFixed(1)} vs header bottom ${after.hdrBottom.toFixed(1)})`,
  );

  // 🔴 PINNED IS NOT THE SAME AS USABLE. A bar that is on screen but painted under the header, or
  // under a card that scrolled over it, is exactly as useless as one that scrolled away — and it
  // measures identically. `elementFromPoint` is the only check that answers "would a click on
  // Voice Studio reach Voice Studio", which is the thing he actually asked for.
  const hit = await evaluate(
    cdp,
    `(() => {
        const b = [...document.querySelectorAll('#tabs button')].find(x => x.dataset.tab === 'voicestudio');
        if (!b) return 'no voicestudio button';
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!el) return 'nothing at that point';
        return el === b || b.contains(el) ? 'hit' : 'covered by ' + el.tagName + '#' + (el.id || '') + '.' + el.className;
    })()`,
  );
  ok(hit === 'hit', `🔴 a click at the center of the pinned "Voice Studio" tab reaches it (${hit})`);

  // ⚠️ AND THE BAR IS OPAQUE. Its spacing became padding rather than margin precisely so the
  // background covers the whole band; leave it transparent and content scrolls visibly through
  // the 14px gap under the buttons while the bar sits pinned.
  const bg = await evaluate(cdp, `getComputedStyle(document.getElementById('tabs')).backgroundColor`);
  ok(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', `the pinned bar is opaque, so content does not scroll through it (${bg})`);

  // ── switching tabs from the pinned bar, without going back to the top ────
  // The point of the whole thing, end to end: scroll down, click a tab, and land on it.
  await evaluate(
    cdp,
    `(() => {
        const b = [...document.querySelectorAll('#tabs button')].find(x => x.dataset.tab === 'voicestudio');
        b.click(); return true; })()`,
  );
  ok(
    await waitFor(cdp, `document.querySelector('#tabs button[data-tab="voicestudio"]').classList.contains('active')`, 8000),
    'clicking it from the pinned bar switches the tab',
  );

  // ── 🔴 9.0.10 — BOTH ROWS PIN, STACKED, AND THE TOP ONE IS CLICKABLE ─────
  //
  // Both the global tab row and Voice Studio sub-tab row stay pinned, adjacent, and clickable.
  //
  // 🔴 WHAT 9.0.8 ACTUALLY DID, AND WHY GEOMETRY ALONE CANNOT SEE IT. `position`/`top` were set on
  // `.tabs`, and every sub-tab bar carries that class, so `#vsTabs` pinned at the SAME `top` as
  // `#tabs` — same z-index, later in the document, therefore painted OVER it. The top row was
  // never off-screen: its rectangle was correct, `pos` was 'sticky', and every check above this
  // one passed while it was invisible. Two things separate that from the fix — the rows are
  // ADJACENT rather than coincident, and a click at the center of a top-row tab reaches the tab.
  //
  // ⚠️ AND THE SECOND ROW NEEDS ITS OWN SECTION MADE TALL, WHICH GROWING `<main>` DOES NOT DO. A
  // sticky element is clamped to its CONTAINING BLOCK, and `#vsTabs`'s is the Voice Studio
  // `<section>` — not `<main>`. With only `<main>` grown, the section on this fixture is a few
  // hundred px of empty panels, so by scrollY 1200 it has gone past the top of the window entirely
  // and its sticky child is clamped to its bottom edge: the row read -180.9 to -123.8, off-screen
  // above, while `getComputedStyle` cheerfully reported 'sticky'. That is the exact silent failure
  // the header of this file is about, caught by geometry as designed. In the app the section IS
  // the page's content, so it is tall whenever the page is; here it has to be said out loud.
  await evaluate(cdp, `(() => { document.querySelector('section[data-panel="voicestudio"]').style.minHeight = '4000px'; return true; })()`);
  await evaluate(cdp, `window.scrollTo({ top: 1200, behavior: 'instant' })`);
  // The sub-tab row has just been brought onto the page by the click above, and `stickytabs.js`
  // learns that through a ResizeObserver, which is delivered in the rendering step. NEXT_FRAME is
  // that step having happened since; it replaces `sleep(200)` (which was a guess at the same).
  await evaluate(cdp, NEXT_FRAME);
  const two = await evaluate(cdp, TWO_ROWS);
  ok(two.scrollY > 600, `still scrolled with Voice Studio open (scrollY ${two.scrollY})`);
  ok(two.subPos === 'sticky', `🔴 the sub-tab row is pinned too, not just the top one (got ${two.subPos})`);
  ok(
    two.tabTop > 0 && two.subTop > 0 && two.subBottom < two.viewport,
    `both rows are fully on screen after scrolling ${two.scrollY}px ` +
      `(tabs ${two.tabTop.toFixed(1)}-${two.tabBottom.toFixed(1)}, sub ${two.subTop.toFixed(1)}-${two.subBottom.toFixed(1)}, ` +
      `viewport ${two.viewport})`,
  );
  ok(
    Math.abs(two.subTop - two.tabBottom) <= 2,
    `🔴 and they are STACKED, not coincident — the sub row sits flush under the top row ` +
      `(sub top ${two.subTop.toFixed(1)} vs tabs bottom ${two.tabBottom.toFixed(1)}; ` +
      `under 9.0.8 both pinned at ${two.tabTop.toFixed(1)})`,
  );
  ok(
    Math.abs(two.tabTop - two.hdrBottom) <= 2,
    `with the top row still flush under the header (${two.tabTop.toFixed(1)} vs ${two.hdrBottom.toFixed(1)})`,
  );

  // 🔴 THE REGRESSION CHECK. With the panel scrolled, a click on "Playground" in the TOP row
  // must reach Playground rather than the sub-tab bar painted over it.
  const hitTop = await evaluate(
    cdp,
    `(() => {
        const b = [...document.querySelectorAll('#tabs button')].find(x => x.dataset.tab === 'playground');
        if (!b) return 'no playground button';
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!el) return 'nothing at that point';
        return el === b || b.contains(el) ? 'hit' : 'covered by ' + el.tagName + '#' + (el.id || '') + '.' + el.className;
    })()`,
  );
  ok(hitTop === 'hit', `🔴 a click on a TOP-row tab reaches it with the sub-tab row pinned too (${hitTop})`);

  const hitSub = await evaluate(
    cdp,
    `(() => {
        const b = [...document.querySelectorAll('#vsTabs button')].find(x => x.dataset.vstab === 'speech');
        if (!b) return 'no speech button';
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!el) return 'nothing at that point';
        return el === b || b.contains(el) ? 'hit' : 'covered by ' + el.tagName + '#' + (el.id || '') + '.' + el.className;
    })()`,
  );
  // Docker edition: this probes the Speech sub-tab; the legacy probe was the Voice Swap one.
  ok(hitSub === 'hit', `and a click on the pinned "Speech" sub-tab still reaches it (${hitSub})`);

  // Same reason as the top bar: transparent and the panel scrolls visibly through the 14px band
  // under the buttons.
  ok(two.subBg !== 'rgba(0, 0, 0, 0)' && two.subBg !== 'transparent', `the pinned sub-tab row is opaque too (${two.subBg})`);

  // 🔴 `--tabs-h` IS MEASURED, NOT A CONSTANT — it is the sub row's whole offset, and the top row
  // wraps to two lines on a narrow window. A stale value stacks the rows wrong in exactly the way
  // the assertions above are about.
  ok(
    two.tabsHVar.endsWith('px') && Math.abs(parseFloat(two.tabsHVar) - two.tabHeight) < 0.5,
    `--tabs-h tracks the top row's measured height (${two.tabsHVar} vs ${two.tabHeight.toFixed(1)}px)`,
  );

  // 🔴 AND `--stick-h` COUNTS BOTH ROWS. It is what `stickTop()`/`scrollUnderStick()` in
  // util/dom.js spend, so a value that stops at the top row lands every pager's first item
  // underneath the sub-tab bar — the bug 9.0.8 fixed for the header, one row later.
  ok(
    parseFloat(two.stickVar) >= two.subBottom - 0.5,
    `🔴 --stick-h covers the WHOLE pinned band, both rows (${two.stickVar} vs sub-row bottom ${two.subBottom.toFixed(1)}px)`,
  );

  // ⚠️ AND THE ROW THAT IS NOT A NAVIGATION ROW STAYS PUT. Bulk's Clean up | Enhance selector
  // shares the `.tabs` class but lives inside a `.panel` card (`section > .panel > .tabs`), so
  // 9.0.8 pinned it as well — floating a strip of page background over the card it belongs to AND
  // over the top tab bar. `getComputedStyle` reads it without opening the tab, because `display:
  // none` on the section does not change the computed value of `position`.
  const blk = await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('blkModeTabs');
        if (!el) return 'missing';
        return getComputedStyle(el).position;
    })()`,
  );
  ok(blk === 'static', `Bulk's mode selector is a control in a card, not a pinned row (got ${blk})`);

  // ── a header taller than the window gives the page back ─────────────────
  // 🔴 A STICKY ELEMENT OFFSET PAST THE BOTTOM OF THE VIEWPORT IS SIMPLY GONE. On a short window,
  // pinning at a `top` bigger than the viewport would make the control unreachable — so
  // `stickytabs.js` stands down and the bar scrolls
  // with the page as it always did. Forced here by shrinking the window rather than by faking
  // the variable, so the guard is exercised the way a real narrow window would.
  // The window size it must come back to when the override is cleared, read before it is changed.
  const base = await evaluate(cdp, `({ w: window.innerWidth, h: window.innerHeight })`);
  const crampedSized = await resizeViewport(cdp, 1400, Math.max(120, Math.round(before.hdrHeight * 1.2)));
  const cramped = await evaluate(cdp, GEOM);
  ok(
    crampedSized && cramped.pos === 'static',
    `on a window barely taller than the header the bar stands down rather than pinning off-screen (got ${cramped.pos})`,
  );
  // 🔴 AND THE SECOND ROW GOES WITH IT — it pins BELOW the first, so its `top` is the larger of the
  // two and it would be the first thing pushed past the bottom edge. A stand-down that dropped
  // only the top row would leave the sub-tabs pinned at an offset measured from a bar that is no
  // longer there.
  ok(
    (await evaluate(cdp, TWO_ROWS)).subPos === 'static',
    'and the sub-tab row stands down with it rather than pinning off-screen on its own',
  );
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const restoredSized = await viewportSettled(cdp, base.w, base.h);
  ok(
    restoredSized && (await evaluate(cdp, GEOM)).pos === 'sticky',
    'and it pins again the moment there is room — the stand-down is not one-way',
  );

  // ── 🔴 A NARROW WINDOW WRAPS THE ROW. IT COULD NOT, AND THREE COMMENTS SAID IT COULD (9.0.15) ──
  //
  // `.tabs` was `display:flex` with no `flex-wrap`, i.e. `nowrap` — while this very file's module
  // header says *"the row wraps to a second line on a narrow window"* and *"`#tabs` grows a line
  // when the window is narrow enough to wrap it"*, and `controls.css` said the same a third time.
  // 🔴 WHAT IT ACTUALLY DID, MEASURED IN BOTH ARMS RATHER THAN REASONED ABOUT. My first version of
  // this comment said the buttons shrank and their LABELS wrapped inside their own boxes. They do
  // not: running the mutant showed every label still on one line and the row 513px wide of its
  // container, with the last three tabs — KoboldCpp, Video and ⚙ Settings — sitting entirely past
  // the right edge and the whole document carrying a horizontal scrollbar. Buttons cannot shrink
  // below min-content, so with `nowrap` the row overflows rather than squeezing.
  //   nowrap : rows 1, overflowPx 513, lastPastEdge 513
  //   wrap   : rows 2, overflowPx   0, lastPastEdge   0
  //
  // 📌 THE LABEL CHECK STAYS ANYWAY, and it is measured with a Range over each button's contents —
  // a Range's client rects ARE its line boxes, so `> 1` IS "this label wrapped". It is not the
  // symptom that occurred, it is the symptom the obvious alternative fix would cause: reaching for
  // `min-width:0` or a smaller font to make twelve tabs fit one line is what breaks the labels, and
  // this is the assertion that would catch it. A height comparison would have needed a line-height
  // guess and would go quietly vacuous the day `--fs` moves.
  const WRAPTEST = `(() => {
      const bs = [...document.querySelectorAll('#tabs button')];
      const lines = b => { const r = document.createRange(); r.selectNodeContents(b);
                           return r.getClientRects().length; };
      const worst = bs.map(b => ({ label: (b.textContent || '').trim(), lines: lines(b) }))
                      .sort((a, c) => c.lines - a.lines)[0];
      const rows = new Set(bs.map(b => Math.round(b.getBoundingClientRect().top)));
      const bar = document.getElementById('tabs');
      const br = bar.getBoundingClientRect();
      const last = bs[bs.length - 1].getBoundingClientRect();
      return { buttons: bs.length, rows: rows.size, worst,
               overflowPx: Math.round(bar.scrollWidth - bar.clientWidth),
               lastPastEdge: Math.round(last.right - br.right),
               docOverflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
               tabsH: parseFloat(getComputedStyle(document.documentElement)
                                 .getPropertyValue('--tabs-h')) || 0 }; })()`;

  const wide = await evaluate(cdp, WRAPTEST);
  ok(wide.buttons >= 10, `the top row has all its tabs to lay out (${wide.buttons})`);
  ok(wide.rows === 1, `at 1400px wide the row still fits on one line (${wide.rows} row(s))`);

  const narrowSized = await resizeViewport(cdp, 700, 900);
  const narrow = await evaluate(cdp, WRAPTEST);
  ok(narrowSized && narrow.rows > 1, `at 700px the tab row WRAPS to more lines instead of squeezing (${JSON.stringify(narrow)})`);
  ok(
    narrow.overflowPx === 0 && narrow.lastPastEdge <= 0,
    `and the row no longer runs off its own right edge (overflow ${narrow.overflowPx}px, last tab ${narrow.lastPastEdge}px past the edge)`,
  );
  ok(
    narrow.worst && narrow.worst.lines === 1,
    `and no button's label breaks across two lines inside its own box (worst: ${JSON.stringify(narrow.worst)})`,
  );
  // AND THE MEASURED HEIGHT FOLLOWED. `--tabs-h` is what the sub-tab row's `top` is calculated
  // from, so a second line that stickytabs.js never saw would park the sub-tabs over the top row —
  // the exact 9.0.10 bug, arriving through a wrap instead of through a missing offset.
  ok(
    narrow.tabsH > wide.tabsH,
    `and --tabs-h grew with the extra line, so the sub-tab offset follows it (${wide.tabsH} -> ${narrow.tabsH})`,
  );
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  // The growth probe below measures the header at the restored size, so the restore is awaited;
  // a restore that never happened must fail the first check of that section rather than pass.
  const restoredAgain = await viewportSettled(cdp, base.w, base.h);

  // ── 🔴 THE HEADER GROWS AT RUNTIME, AND THE OFFSET HAS TO FOLLOW ─────────
  //
  // This also matters on hosts with multiple GPUs. Every fixture here stubs the GPU registry to `[]`,
  // so the header is at its SHORTEST — no cards, no sensor rows. A multi-GPU host can add cards,
  // swap, memory-pressure, board-temp, power and UPS after the first sample, not
  // at page load. Measuring `--hdr-h` instead of hard-coding it is the entire reason
  // `js/ui/stickytabs.js` exists; if its ResizeObserver never fires, the offset is stale precisely
  // on the box it was built for while every card-less fixture goes on passing.
  //
  // ⚠️ GROWN THROUGH A REAL HEADER ROW, not an injected div. `#powerLine` is what `renderStrip`
  // unhides when the box reports watts, so this is the shape the app actually produces.
  const grew = await evaluate(
    cdp,
    `(async () => {
        const root = document.documentElement;
        const hdr = document.querySelector('header');
        const bar = document.getElementById('tabs');
        const before = { hdr: hdr.getBoundingClientRect().height,
                         v: getComputedStyle(root).getPropertyValue('--hdr-h').trim(),
                         top: getComputedStyle(bar).top };
        // 🔴 AN ELEMENT NOTHING ELSE MANAGES, AND THE REALISTIC VERSION IS WHY. This first
        // unhid the powerLine row — the one renderStrip shows when the box reports watts —
        // because that is the shape the app really produces. But renderStrip OWNS that row: it
        // runs on every strip sample, and this fixture stubs the power snapshot to None, so the
        // next sample re-hid it. The measurement won that race in isolation and lost it under a
        // full suite, reading 133.6 to 133.6px. Realism is worth a lot; it is not worth a check
        // that reports the opposite of the truth once the machine is busy.
        // (No backticks in here — this whole expression is a template literal.)
        // ⚠️ AN EXPLICIT HEIGHT, AND THE SECOND FAILED ATTEMPT IS WHY. The header is
        // display:flex in a ROW, so a normal-height child sits BESIDE the existing content and
        // the header's height stays whatever its tallest child already was — appending a
        // sensor-sized div read 133.6 to 133.6px, the same numbers as the racing version it
        // replaced, for a completely different reason. What is under test is "the offset follows
        // a header that got taller", so the probe simply IS taller.
        const row = document.createElement('div');
        row.id = 'growthProbe';
        row.style.height = '220px';
        row.style.flex = '0 0 auto';
        document.querySelector('header').appendChild(row);
        // Two frames for layout; the ResizeObserver callback that publishes --hdr-h is delivered
        // in the first of them. Then wait, bounded, for the variable to match the header: this
        // was a fixed 250 ms "beat for the ResizeObserver callback to land", i.e. a guess at how
        // long a busy machine takes to deliver it. (No backticks in here.)
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        let settled = false;
        for (let i = 0; i < 400 && !settled; i++) {
          settled = Math.abs(parseFloat(getComputedStyle(root).getPropertyValue('--hdr-h')) -
                             hdr.getBoundingClientRect().height) < 0.5;
          if (!settled) await new Promise(r => setTimeout(r, 25));
        }
        const after = { hdr: hdr.getBoundingClientRect().height,
                        v: getComputedStyle(root).getPropertyValue('--hdr-h').trim(),
                        stick: getComputedStyle(root).getPropertyValue('--stick-h').trim(),
                        top: getComputedStyle(bar).top };
        return { before, after, settled }; })()`,
  );
  ok(
    restoredAgain && grew.after.hdr > grew.before.hdr + 4,
    `the header really got taller when a sensor row appeared (${grew.before.hdr.toFixed(1)} → ${grew.after.hdr.toFixed(1)}px)`,
  );
  ok(
    grew.settled && Math.abs(parseFloat(grew.after.v) - grew.after.hdr) < 0.5,
    `🔴 --hdr-h followed it rather than going stale (${grew.after.v} vs ${grew.after.hdr.toFixed(1)}px)`,
  );
  ok(
    parseFloat(grew.after.top) > parseFloat(grew.before.top) + 4,
    `and the pinned bar moved down with it (top ${grew.before.top} → ${grew.after.top})`,
  );
  // `--stick-h` is the one the scroll helpers spend, so it has to track the same growth or a pager
  // starts landing its list under a header that has since got taller.
  ok(
    parseFloat(grew.after.stick) > grew.after.hdr - 0.5,
    `and --stick-h grew with it, so the scroll helpers stay correct (${grew.after.stick})`,
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

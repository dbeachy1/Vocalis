// Browser geometry coverage for Clips table column widths.
// Markup and route checks cannot show how auto table layout allocates surplus width or
// squeezes a column to its minimum content size. This spec measures the rendered cells and
// captures an optional screenshot for visual review.

// Keep CDP expressions free of unescaped backticks and backslash escapes inside CDP template literals.
// Usage: node clips_table_layout_spec.mjs <base-url> <chrome-path> [--shot <png-path>]

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

const argv = process.argv.slice(2);
const shotIx = argv.indexOf('--shot');
const shotPath = shotIx >= 0 ? argv[shotIx + 1] : null;
// ⚠️ GUARDED ON `shotIx >= 0`. Without the guard `indexOf` answers -1, `shotIx + 1` is 0, and
// the filter drops argv[0] - so the spec ran fine WITH --shot and printed its usage line without
// it. The suite caught it on the first run that did not pass a screenshot path.
const [baseUrl, chromePath] = shotIx >= 0 ? argv.filter((a, i) => i !== shotIx && i !== shotIx + 1) : argv;
if (!baseUrl || !chromePath) {
  console.error('usage: node clips_table_layout_spec.mjs <base-url> <chrome-path> [--shot <png>]');
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

// ── CDP plumbing (mirrors clips_chapters_browser_spec.mjs) ───────────────────
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
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

// 🔴 A poll that THROWS is "not yet", not "failed" — the wait is FOR the repaint, so an early
// poll dereferencing a node that is not there yet is the normal case. Copied from
// clips_chapters_browser_spec.mjs, where it is written out at length and was proved by mutation.
async function waitFor(cdp, expression, timeoutMs = 20000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-tablay-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--ignore-certificate-errors',
    'about:blank',
  ],
  // Chrome's scratch must land inside the profile — see the chapters spec for the 609-orphan
  // measurement behind these two variables.
  { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TEMP: profile, TMP: profile } },
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
  // Windows keeps the handles a moment longer, so an immediate recursive delete throws EBUSY —
  // and a `.catch()` on that line swallows it. 182 dirs / 4.76 GB from one suite run, measured
  // `test_stems_ui.py` asserts this shape on every spec that makes a profile, and it
  // is what caught this file. Retried, because the exit event is not the last word either.
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

  // Use the intended 1600×900 desktop viewport. At narrower widths, buttons may wrap by design
  // (`td.scacts{white-space:normal}`), which exercises a different layout.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  const pageErrors = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });

  await cdp.send('Page.navigate', { url: baseUrl });
  await waitFor(cdp, `document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`);
  await evaluate(cdp, PUBLISH_SPEC_SURFACE);
  await evaluate(
    cdp,
    `(() => {
        document.querySelector('#tabs button[data-tab="sillytavern"]').click();
        document.querySelector('#stTabs button[data-sttab="clips"]').click();
    })()`,
  );
  ok(await waitFor(cdp, `document.querySelectorAll('#scList tbody tr[data-ref]').length > 1`), 'the Clips tab lists the seeded scenes');
  ok(
    await waitFor(
      cdp,
      `(() => { const r = document.querySelector('#scList table').getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
    ),
    'and the table has a laid-out box to measure',
  );

  // ── the measurement ──────────────────────────────────────────────────────
  // Every figure comes off the FIRST data row and its own header cells, by index, so it survives
  // a column being added on either side of the ones under test.
  //
  // 🔴 9.5.7 — THE ARROW COMES OFF THE HEADER TEXT BEFORE THE LOOKUP. The headers are sortable
  // now, and the active one carries ' ▲'/' ▼', so `heads.indexOf('Built')` answered -1 the moment
  // the default sort landed on that column. `cells[-1]` is `undefined` and the whole measurement
  // died on `getBoundingClientRect` of nothing — a locator failure that reads as a layout failure.
  // ⚠️ Stripped rather than matched with `startsWith`: the arrow MOVES between columns as you
  // click, so an exact name has to keep working whichever header is currently the sorted one.
  const m = await evaluate(
    cdp,
    `(() => {
        const heads = [...document.querySelectorAll('#scList thead th')].map(th => th.textContent.replace(/[▲▼]/g, '').trim());
        const ix = n => heads.indexOf(n);
        const row = document.querySelector('#scList tbody tr[data-ref]');
        const cells = [...row.children];
        const cell = n => cells[ix(n)];
        const w = el => el.getBoundingClientRect().width;
        // The width the cell's own content actually wants, measured by cloning it into a
        // shrink-to-fit box: a <td> reports the COLUMN's width, never its content's.
        const contentWidth = el => {
            const probe = document.createElement('span');
            probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden';
            probe.className = el.className;
            probe.innerHTML = el.innerHTML;
            document.body.appendChild(probe);
            const got = probe.getBoundingClientRect().width;
            probe.remove();
            return got;
        };
        // 🔴 HOW MANY LINES THE TEXT ACTUALLY TAKES, WHICH IS NOT THE CELL'S HEIGHT. A <td>'s
        // box is the ROW's height, so the first cut of this check read 47px for the date and
        // called it wrapped — when the thing that was two lines tall was the BUTTON cell beside
        // it. A Range over the cell's contents reports one client rect per line box, which is
        // the question being asked. Caught by running it, not by reading it.
        const lines = el => {
            const r = document.createRange();
            r.selectNodeContents(el);
            return r.getClientRects().length;
        };
        // 🔴 THE COLUMN IS SIZED BY THE WIDEST CELL IN IT, and that is the mechanism behind the
        // gap in the screenshot: one row with a long chat name sets the column's width and every
        // other row pays for it in empty space.
        const widestFrom = Math.max(
            ...[...document.querySelectorAll('#scList tbody tr[data-ref]')].map(tr => contentWidth(tr.children[ix('From')])),
        );
        const lineH = parseFloat(getComputedStyle(row).lineHeight) || 20;
        const acts = cells[cells.length - 1];
        const btns = [...acts.querySelectorAll('button, a')];
        // How many visual ROWS the action controls occupy: distinct top offsets, rounded, which
        // is what "scrunched into three lines" means as a number.
        // 🔴 CLUSTERED, NOT A Set OF EXACT TOPS. A button and an <a> sitting on the SAME line
        // differ by a few pixels of vertical-align, and counting raw tops reported two rows for
        // one line - a metric that would have gone green on a fix that changed nothing. Anything
        // within half a line height is the same row.
        const tops = [];
        for (const b of btns) {
            const t = b.getBoundingClientRect().top;
            if (!tops.some(x => Math.abs(x - t) < lineH * 0.6)) tops.push(t);
        }
        return {
            table: w(document.querySelector('#scList table')),
            fromW: w(cell('From')), fromContent: contentWidth(cell('From')),
            builtW: w(cell('Built')), builtContent: contentWidth(cell('Built')),
            builtH: cell('Built').getBoundingClientRect().height,
            builtLines: lines(cell('Built')),
            widestFrom,
            // 🔴 CLIPPING IS ASKED OF THE LONG ROW, NOT THE MEASURED ONE. The row under test is
            // the SHORT one — it is the row that showed the hole — and its own value fits with
            // room to spare, so asking it about ellipsis answers "no" whatever the cap does.
            fromClipped: (() => {
                const cells = [...document.querySelectorAll('#scList tbody tr[data-ref]')].map(tr => tr.children[ix('From')]);
                const worst = cells.reduce((a, b) => (contentWidth(b) > contentWidth(a) ? b : a));
                return worst.scrollWidth > worst.clientWidth + 1 && !!worst.getAttribute('title');
            })(),
            fromTitled: !!cell('From').getAttribute('title'),
            // What the action set wants on ONE line, so the floor under the column is derived
            // from the buttons rather than chosen. The cell's margin rule adds 3px of gap each.
            // NOTE: this block is inside a TEMPLATE LITERAL - no backticks, comments included.
            btnSum: Math.round(btns.reduce((a, b) => a + b.getBoundingClientRect().width + 3, 0)),
            nameW: w(cells[ix('Name')]),
            actsW: acts.getBoundingClientRect().width,
            actRows: tops.length, buttons: btns.length,
            lineH,
        };
    })()`,
  );
  console.log(
    `  … table ${Math.round(m.table)}px · From ${Math.round(m.fromW)}px (content ${Math.round(m.fromContent)}px) · Built ${Math.round(m.builtW)}px on ${m.builtLines} line(s), widest From in column ${Math.round(m.widestFrom)}px · Name ${Math.round(m.nameW)}px · actions ${Math.round(m.actsW)}px, ${m.buttons} controls on ${m.actRows} line(s), ${m.btnSum}px on one line`,
  );

  // Non-vacuity: there must be enough controls in the cell for "scrunched" to be a thing that
  // can happen at all. A one-button row would satisfy every check below trivially.
  ok(m.buttons >= 5, `precondition: the row carries a real set of controls (${m.buttons})`);

  // 🔴 THE DATE IS ONE FACT AND MUST NOT BREAK. `2026-08-23 04:32:48` has three hyphens and a
  // space in it, so its min-content width is the width of `04:32:48` — which is what let the
  // auto layout squeeze the column and split the date across two lines.
  ok(m.builtLines === 1, `🔴 the Built timestamp stays on ONE line (${m.builtLines})`);

  // 🔴 NO HOLE IN THE MIDDLE OF THE TABLE. `From` is a content column: it may have padding
  // around its text but it must not be handed the table's surplus while its neighbors are
  // squeezed. 80px is generous — the screenshot's gap was several hundred.
  // 🔴 ONE LONG CHAT NAME MUST NOT CHARGE EVERY ROW FOR IT. The fixture seeds a row whose origin
  // is far longer than the rest precisely so this can fail: uncapped, that row's max-content sets
  // the column, and every short row shows the difference as a hole.
  ok(m.widestFrom > 300, `precondition: one row's From really is long enough to blow the column out (${Math.round(m.widestFrom)}px)`);
  ok(
    m.fromW < 260,
    `🔴 the From column is CAPPED, so the longest chat name does not set every row's width ` +
      `(${Math.round(m.fromW)}px against a ${Math.round(m.widestFrom)}px longest value)`,
  );
  ok(
    m.fromClipped && m.fromTitled,
    `…and the row that no longer fits IS ellipsized, with a title carrying the whole of it (clipped ${m.fromClipped}, this row titled ${m.fromTitled})`,
  );

  // 🔴 AND THE SURPLUS GOES SOMEWHERE DELIBERATE. Name is the column that should absorb it: it
  // holds the longest, most-truncatable text on the row.
  ok(
    m.nameW > m.fromW,
    `the slack goes to Name, which is the column that can use it (Name ${Math.round(m.nameW)}px vs From ${Math.round(m.fromW)}px)`,
  );

  // 🔴 THE ACTIONS ARE NOT SCRUNCHED. Two lines is the design (`td.scacts{white-space:normal}`
  // exists so a narrow window returns width to Name); three is the complaint.
  ok(m.actRows <= 2, `🔴 the action buttons fit on at most two lines at 1600px (${m.actRows})`);

  // ── 9.5.7 — THE HEADERS SORT, AND THIS IS THE ONLY PLACE THE CLICK IS REAL ─────────────────
  //
  // The real-browser click verifies sorting through the delegated header listener; calling
  // `scSortBy` directly would check ordering without covering that wiring.
  //
  // 🔴 clips_ui_smoke.mjs CALLS `scSortBy` DIRECTLY. That measures the ordering and says nothing
  // about the wiring — whether the `<th data-sort>` this table emits is reachable by the
  // delegated `closest('th[data-sort]')` listener four hundred lines below it, and whether the
  // four OTHER click listeners on `#scList` let a header click through. Both are joins, and a
  // unit test cannot prove anyone calls the function. This is a real press, on a real header, in
  // a real browser.
  //
  // ⚠️ NAME IS THE COLUMN TO PRESS, and the expected order comes from the FIXTURE'S OWN TITLES,
  // never from whatever the list happened to be showing a moment ago. The driver seeds
  // `scene0`="Test User", `scene1`="Sample Story One", `scene2`="Sample Story Two", so
  // A→Z is 1, 2, 0 (the sanitized fixture titles; it was 0, 2, 1 before the titles were made generic) — an order that differs from the Built order. An earlier draft asserted "the same rows
  // as before, because they all tie on Built"; they do not tie (`clip_sources` dates a scene from
  // its files), and a check written against the previous order would have been asserting the
  // fixture rather than the sort.
  const scNames = `[...document.querySelectorAll('#scList tbody tr[data-ref]')].map(tr => tr.getAttribute('data-ref'))`;
  const scArrowOn = `(() => {
      const th = [...document.querySelectorAll('#scList thead th')].find(h => /[▲▼]/.test(h.textContent));
      return th ? (th.getAttribute('data-sort') || '?') + ' ' + (/▲/.test(th.textContent) ? 'up' : 'down') : 'none'; })()`;
  const clickHead = k => `(() => {
      const th = document.querySelector('#scList thead th[data-sort="${k}"]');
      if (!th) return 'no such header';
      th.click();
      return 'clicked'; })()`;

  const before = await evaluate(cdp, scNames);
  ok(
    (await evaluate(cdp, scArrowOn)) === 'created_ts down',
    `the table opens sorted on Built, newest first (${await evaluate(cdp, scArrowOn)})`,
  );

  ok((await evaluate(cdp, clickHead('name'))) === 'clicked', 'the Name header is there to be pressed');
  ok(
    await waitFor(cdp, `${scArrowOn} === 'name up'`),
    `🔴 CLICKING A HEADER SORTS: the arrow moves to Name and points up (${await evaluate(cdp, scArrowOn)})`,
  );
  const asc = await evaluate(cdp, scNames);
  ok(
    asc.join(',') === 'scene1_ab12cd31,scene2_ab12cd32,scene0_ab12cd30',
    `…and the rows are in TITLE order — Sample Story One, Sample Story Two, Test User (${JSON.stringify(asc)})`,
  );
  ok(asc.join(',') !== before.join(','), `…which is not the order Built had them in (${JSON.stringify(before)})`);

  ok((await evaluate(cdp, clickHead('name'))) === 'clicked', 'pressing the same header again');
  ok(
    await waitFor(cdp, `${scArrowOn} === 'name down'`),
    `🔴 …FLIPS IT: same column, arrow turned over (${await evaluate(cdp, scArrowOn)})`,
  );
  const desc = await evaluate(cdp, scNames);
  ok(desc.join(',') === [...asc].reverse().join(','), `and the rows are the exact reverse, not merely different (${JSON.stringify(desc)})`);

  // ⚠️ THE TICK-ALL BOX LIVES IN A `<th>` TOO. `closest('th[data-sort]')` is what keeps a press on
  // it from sorting instead of selecting the page — a bare `th` selector would have swallowed it.
  await evaluate(cdp, `(() => { document.getElementById('scSelAll').click(); return true; })()`);
  ok(
    (await evaluate(cdp, scArrowOn)) === 'name down',
    `ticking the select-all box in its own header does NOT re-sort the list (${await evaluate(cdp, scArrowOn)})`,
  );
  ok(
    (await evaluate(cdp, `[...document.querySelectorAll('#scList tbody input.scSel')].every(c => c.checked)`)) === true,
    '…it selects the page, which is what that header cell is for',
  );

  ok(pageErrors.length === 0, `no page exceptions while laying the table out (${pageErrors.join(' | ') || 'none'})`);

  if (shotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`  … screenshot written to ${shotPath}`);
  }

  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`  FAIL ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(exitCode === 0 && !failed ? 0 : 1);

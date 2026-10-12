// Browser geometry coverage for the enhancement queue layout.
// Markup tests cannot detect flex sizing that collapses header cells or the queue list.
// This spec measures the laid-out boxes and captures an optional screenshot for visual review.

// Keep CDP expressions free of unescaped backticks and backslash escapes inside CDP template literals.
// Usage: node clips_queue_layout_spec.mjs <base-url> <chrome-path> [--shot <png-path>]

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLISH_SPEC_SURFACE } from './_websrc.mjs';

const argv = process.argv.slice(2);
const shotIx = argv.indexOf('--shot');
const shotPath = shotIx >= 0 ? argv[shotIx + 1] : null;
// Guarded on `shotIx >= 0`: `indexOf` answers -1 with no flag, `shotIx + 1` is 0, and an
// unguarded filter would drop argv[0] — the spec then runs WITH --shot and prints usage without.
const [baseUrl, chromePath] = shotIx >= 0 ? argv.filter((a, i) => i !== shotIx && i !== shotIx + 1) : argv;
if (!baseUrl || !chromePath) {
  console.error('usage: node clips_queue_layout_spec.mjs <base-url> <chrome-path> [--shot <png>]');
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

// ── CDP plumbing (mirrors clips_table_layout_spec.mjs) ───────────────────────
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

// 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED" — the wait is FOR the repaint, so an early poll
// dereferencing a node that is not there yet is the normal case, and letting it kill the spec
// presents as a flake. Same helper, same reason, as the table-layout spec.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-qlay-cdp-'));
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
  // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
  // Both variables point into the owned profile so cleanup contains extracted scratch.
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
  // Wait for Chrome to actually go before deleting its profile: kill() returns at once and
  // Windows keeps the handles a moment longer, so an immediate recursive delete throws EBUSY.
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

  // Use the intended 1600×900 desktop viewport; a narrow viewport legitimately wraps the header
  // and measures a different responsive layout.
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
  // The queue is seeded server-side in ui-state and restored by `scEnhRestore` on the tab's first
  // load — the real path, not a poke at module state. Its pump then offers the head to a box whose
  // cards the driver has made permanently busy, so the queue stays exactly as long as it was
  // seeded and the wait line appears underneath it.
  const seeded = await waitFor(cdp, `document.querySelectorAll('#scEnhList .scEnhItem').length >= 12`);
  if (!seeded)
    // ⚠️ THE DIAGNOSTIC IS PART OF THE SPEC, NOT A LEFTOVER. Three things have to line up for this
    // fixture — the refs seeded into ui-state, the refs the route actually lists, and the tab
    // having loaded at all — and "0 rows" tells you which one failed only if it prints all three.
    console.log(
      '  … ' +
        (await evaluate(
          cdp,
          `(() => {
             const st = window.__UI_STATE__ || {};
             const rows = [...document.querySelectorAll('#scList tbody tr[data-ref]')].map(r => r.getAttribute('data-ref'));
             return 'seeded=' + (st['sc-enhq'] || 'MISSING') + ' | table rows=' + JSON.stringify(rows.slice(0, 3)) +
                    ' of ' + rows.length + ' | strip=' + !!document.querySelector('.scEnhQ');
          })()`,
        )),
    );
  ok(seeded, 'the seeded queue is restored and drawn as rows');

  const m = await evaluate(
    cdp,
    `(() => {
        const q = document.querySelector('.scEnhQ');
        const head = q.querySelector('.scEnhHead');
        const list = document.getElementById('scEnhList');
        const rows = [...list.querySelectorAll('.scEnhItem')];
        const r = el => el.getBoundingClientRect();
        // 🔴 HOW MANY LINES A PIECE OF TEXT ACTUALLY TAKES, WHICH IS NOT ITS BOX HEIGHT. A flex
        // cell is stretched to the row, so reading its height answers a question about the row.
        // A Range over its contents reports one client rect per LINE BOX, which is the question.
        const lines = el => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getClientRects().length; };
        const note = head.querySelector('.scEnhNote');
        const counts = head.querySelector('.scEnhCounts');
        const cells = [...head.children];
        const rowH = rows.length ? r(rows[0]).height : 0;
        // Distinct left edges, rounded: "lined up" as a number. Fourteen pills wrapping in a
        // block produce one per pill; a list produces exactly one.
        const lefts = [...new Set(rows.map(x => Math.round(r(x).left)))];
        // Distinct top edges: a vertical list has one row per line, so this equals rows.length.
        const tops = [...new Set(rows.map(x => Math.round(r(x).top)))];
        const xs = rows.map(x => x.querySelector('.scEnhX')).filter(Boolean);
        const xLefts = [...new Set(xs.map(b => Math.round(r(b).left)))];
        return {
          rows: rows.length,
          headLines: cells.map(c => lines(c)),
          // 🔴 CLUSTERED CENTERS, NOT RAW TOPS. The header is align-items:center and its cells
          // are different heights (a 28px button beside 22px of text), so cells on the SAME line
          // have different tops — the first cut of this check read 2 and called a perfectly
          // straight header wrapped. The table-layout spec learned the same thing about the
          // action buttons. Caught by running it.
          headTops: (() => {
            const cs = [];
            for (const c of cells) { const b = r(c); const mid = b.top + b.height / 2;
              if (!cs.some(x => Math.abs(x - mid) < 8)) cs.push(mid); }
            return cs.length;
          })(),
          noteText: note ? note.textContent.trim() : '',
          noteLines: note ? lines(note) : 0,
          countsLines: counts ? lines(counts) : 0,
          countsText: counts ? counts.textContent.trim() : '',
          rowH,
          listH: r(list).height,
          listW: r(list).width,
          panelW: r(q.parentElement).width,
          xTravel: xs.length ? Math.round(r(xs[0]).left - r(rows[0]).left) : 0,
          scrollH: list.scrollHeight,
          scrolls: list.scrollHeight > list.clientHeight + 1,
          lefts: lefts.length,
          tops: tops.length,
          xLefts: xLefts.length,
          xCount: xs.length,
          xW: xs.length ? r(xs[0]).width : 0,
          xH: xs.length ? r(xs[0]).height : 0,
          // Every row's ✕ must be inside the box: a name long enough to widen the flex row would
          // push it out to the right, which is what min-width:0 on the name cell prevents.
          // NOTE: this block is inside a TEMPLATE LITERAL - no backticks, comments included.
          xInside: xs.every(b => r(b).right <= r(list).right + 1),
          // 🔴 REPORTED AS A PAIRING, NOT A COUNT. A row whose start POST is in flight is
          // deliberately NOT draggable, and this fixture always has one of those in flight or
          // about to be — the pump offers the head, the box refuses 409 busy, it retries. A bare
          // count is therefore 13 or 14 depending on when the measurement lands, which is a flake
          // dressed as an assertion. The invariant is the pairing: waiting ⇒ draggable, and
          // not-draggable ⇒ it says why.
          notDraggable: rows
            .filter(x => x.getAttribute('draggable') !== 'true')
            .map(x => (x.querySelector('.scEnhState') || {}).textContent || ''),
          waitingDraggable: rows.filter(
            x => !/starting/.test((x.querySelector('.scEnhState') || {}).textContent || '') && x.getAttribute('draggable') === 'true',
          ).length,
          waiting: rows.filter(x => !/starting/.test((x.querySelector('.scEnhState') || {}).textContent || '')).length,
          // The drag checks below must grab a row that is actually draggable, for the same reason.
          dragIx: rows.findIndex((x, i) => i > 0 && x.getAttribute('draggable') === 'true'),
          posLefts: [...new Set(rows.map(x => Math.round(r(x.querySelector('.scEnhPos')).right)))].length,
          pageW: document.documentElement.scrollWidth,
          viewW: document.documentElement.clientWidth,
        };
    })()`,
  );
  console.log(
    `  … ${m.rows} rows of ${Math.round(m.rowH)}px in a ${Math.round(m.listH)}px box (content ${Math.round(m.scrollH)}px) · ` +
      `header on ${m.headTops} line(s), cells taking ${m.headLines.join('/')} line(s) · ` +
      `${m.lefts} distinct row left edge(s), ${m.tops} distinct top(s), ${m.xLefts} distinct ✕ column(s)`,
  );

  // ── the header ────────────────────────────────────────────────────────────
  // 🔴 THE SQUISH, AS A NUMBER. Each cell carried `style="flex:0"` = `flex:0 1 0%`, so it was
  // sized by `min-width:auto`, i.e. its min-content, i.e. its longest word: "⚠️ this queue runs in
  // this tab — leave it open" came out eight lines tall. This is the check that was RED before
  // the fix and is the reason the header is no longer a `.row`.
  // ✅ 11.2.7 — THAT WARNING IS GONE. The queue moved to the server, so the tab no longer has to be
  // kept open and the sentence would be false. The check that
  // measured it as one line became a check that it is not there at all; the count and header
  // checks below still guard the squish itself.
  ok(m.noteText === '' && m.noteLines === 0, `🔴 there is no "leave this tab open" warning any more (${JSON.stringify(m.noteText)})`);
  ok(m.countsLines === 1, `🔴 and so is the running/waiting count — "${m.countsText}" (${m.countsLines})`);
  ok(
    m.headLines.every(n => n === 1),
    `no header cell is stacked into its own words (${m.headLines.join('/')})`,
  );
  ok(m.headTops === 1, `and the whole header sits on one line, so the controls are where they were (${m.headTops})`);
  ok(m.pageW <= m.viewW + 1, `the strip does not push the page into a horizontal scroll (${m.pageW} vs ${m.viewW})`);

  // ── the list ──────────────────────────────────────────────────────────────
  // 🔴 "VERTICAL AND LINED UP", AS TWO NUMBERS. Pills are inline: they wrap at the container edge,
  // so N of them occupy far fewer than N line boxes and start at N different x positions. A list
  // is exactly the opposite of both, which is why these two are the checks and not a class name.
  ok(m.rows >= 12, `precondition: enough items queued for wrapping to be possible at all (${m.rows})`);
  ok(m.lefts === 1, `🔴 every row starts at the SAME x — the thing pills could not do (${m.lefts} distinct left edge(s))`);
  ok(m.tops === m.rows, `🔴 one row per line, top to bottom (${m.tops} distinct tops for ${m.rows} rows)`);
  ok(m.posLefts === 1, `the position numbers are right-aligned in one column, so 9 and 10 line up (${m.posLefts})`);

  // 🔴 TEN ROWS AND A SCROLL, WHICH IS WHAT HE ASKED FOR IN THOSE WORDS. The box must be about ten
  // rows tall — not fourteen, or there was no point, and not three. It must also actually scroll:
  // a `max-height` with `overflow:hidden` would satisfy the height check and silently hide four
  // items, which is worse than the ragged block it replaced.
  ok(m.rowH > 20 && m.rowH < 44, `a row is a sane height (${Math.round(m.rowH)}px)`);
  ok(
    m.listH >= m.rowH * 9 && m.listH <= m.rowH * 12,
    `🔴 the box is about ten rows tall (${Math.round(m.listH)}px = ${(m.listH / m.rowH).toFixed(1)} rows)`,
  );
  ok(
    m.scrollH > m.listH + m.rowH,
    `precondition: there is genuinely more content than fits (${Math.round(m.scrollH)}px of ${Math.round(m.listH)}px)`,
  );
  ok(m.scrolls, '🔴 …and the overflow SCROLLS rather than being clipped away');

  // 🔴 THE BOX IS NOT AS WIDE AS THE PANEL, AND THIS CHECK EXISTS BECAUSE THE PICTURE CAUGHT WHAT
  // THE NUMBERS DID NOT. Every check above passed on a first cut whose box was the full 1,585px
  // shell width — perfectly aligned rows in which the ✕ was fourteen hundred pixels from the name
  // it removes. "Lined up" and "reachable" are different properties and only one of them was being
  // measured. This is the second one: a row is a short name and two small controls, so the travel
  // from the name to its own ✕ has to stay short.
  ok(
    m.listW < m.panelW * 0.75,
    `the queue box is its own width, not the whole panel (${Math.round(m.listW)}px of ${Math.round(m.panelW)}px)`,
  );
  ok(m.xTravel < 820, `🔴 …so the ✕ stays beside the name it removes (${m.xTravel}px from the row's left edge)`);

  // ── the ✕, which is the verb he uses most ─────────────────────────────────
  ok(m.xCount === m.rows, `every row has its own ✕ (${m.xCount} for ${m.rows} rows)`);
  ok(m.xLefts === 1, `🔴 and they are in ONE column, so the pointer does not move between rows (${m.xLefts})`);
  ok(m.xW >= 10 && m.xH >= 16, `the ✕ is a real target, not a hairline (${Math.round(m.xW)}×${Math.round(m.xH)}px)`);
  ok(m.xInside, 'no row pushes its ✕ outside the box, however long the scene name is');

  // ── the drag ──────────────────────────────────────────────────────────────
  ok(m.waitingDraggable === m.waiting, `every WAITING row is draggable (${m.waitingDraggable} of ${m.waiting})`);
  ok(
    m.notDraggable.every(t => /starting/.test(t)),
    `and the only rows that refuse a drag are the ones whose start is in flight (${JSON.stringify(m.notDraggable)})`,
  );
  // 🔴 THE HANDLER IS REACHED, AND THAT IS A DIFFERENT FACT FROM `draggable="true"`. A row can be
  // draggable with nothing listening, which looks identical until you try it. Synthesized
  // DragEvents carry a real dataTransfer here, so this drives the actual dragstart → dragover →
  // drop path the mouse would, and then reads the ORDER off the repainted list.
  const moved = await evaluate(
    cdp,
    `(() => {
        const DRAG_IX = ${m.dragIx};
        const list = document.getElementById('scEnhList');
        const rows = [...list.querySelectorAll('.scEnhItem')];
        const before = rows.map(r => r.getAttribute('data-ref'));
        const src = rows[DRAG_IX], dst = rows[0];
        const dt = new DataTransfer();
        const at = (el, y) => { const b = el.getBoundingClientRect(); return { clientX: b.left + 20, clientY: y }; };
        const fire = (el, type, extra) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }));
        fire(src, 'dragstart', at(src, src.getBoundingClientRect().top + 5));
        const dragging = list.querySelectorAll('.scEnhDragging').length;
        const b0 = dst.getBoundingClientRect();
        fire(dst, 'dragover', { clientX: b0.left + 20, clientY: b0.top + 2 });
        const marked = list.querySelectorAll('.scEnhDropBefore').length;
        fire(dst, 'drop', { clientX: b0.left + 20, clientY: b0.top + 2 });
        fire(src, 'dragend', {});
        const after = [...document.getElementById('scEnhList').querySelectorAll('.scEnhItem')].map(r => r.getAttribute('data-ref'));
        return { before, after, dragging, marked, wanted: before[DRAG_IX], firstNow: after[0] };
    })()`,
  );
  ok(moved.dragging === 1, `dragstart marks exactly the row being dragged (${moved.dragging})`);
  ok(moved.marked === 1, `dragover paints exactly one insertion point (${moved.marked})`);
  ok(m.dragIx > 0, `precondition: there is a draggable row below the head to grab (index ${m.dragIx})`);
  ok(moved.firstNow === moved.wanted, `🔴 dropping row 4 on the top half of row 1 makes it first (${moved.firstNow} === ${moved.wanted})`);
  ok(
    moved.after.length === moved.before.length && new Set(moved.after).size === moved.after.length,
    `and nothing is lost or duplicated by the move (${moved.before.length} → ${moved.after.length})`,
  );
  ok(
    JSON.stringify(moved.after) === JSON.stringify([moved.wanted, ...moved.before.filter(r => r !== moved.wanted)]),
    'the rest keep their relative order — a reorder, not a reshuffle',
  );

  ok(pageErrors.length === 0, `no page exceptions while laying the queue out (${pageErrors.join(' | ') || 'none'})`);

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

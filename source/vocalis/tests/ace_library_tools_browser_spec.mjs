// Browser coverage for ACE-Step library filtering, sorting, paging, and bulk deletion.
// These controls are display-only: the route still returns the full list. The spec verifies
// that select-all reaches filtered items across pages while hidden items lose their ticks,
// and that filtering does not replace an active audio row during reconciliation.

// Keep CDP expressions free of unescaped backticks because they are embedded in template literals.
// Usage: node ace_library_tools_browser_spec.mjs <base-url> <chrome-path>

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_FETCH_LOG, fetchCount, fetchCountAtLeast, uiStateIs, STAMP_OUTGOING, ON_NEW_DOCUMENT } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node ace_library_tools_browser_spec.mjs <base-url> <chrome-path>');
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
    // and always, so the wait returns on its first poll and waits for nothing.
    // 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED": the wait is FOR a repaint, so landing
    // mid-repaint is the normal case and an early false is the entire point.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-acetools-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Every library row is a real <audio> pointed at real bytes. Browser audio is muted while
    // playback state, duration, and completion events remain testable.
    '--mute-audio',
    '--ignore-certificate-errors',
    '--window-size=1600,1200',
    'about:blank',
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Chrome unpacks component extensions through the PROCESS's TEMP, not --user-data-dir, so
    // without this every launch leaves `scoped_dir<pid>_<rand>` orphans in %TEMP% root.
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
  // kill() returns at once and Windows holds the handles a moment longer; a swallowed EBUSY here
  // leaked gigabytes per suite run before it was waited on.
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

// The song rows on screen, in the order they are painted. `:not(.acedlhead)` drops the heading
// row; the filter/order bar is not a `.acesong` at all, so it never appears here.
const NAMES = `[...document.querySelectorAll('#aceLibrary .acesong:not(.acedlhead) .acename')].map(n => n.textContent.trim())`;
const COUNT = `document.querySelectorAll('#aceLibrary .acesong:not(.acedlhead)').length`;
// Type into the filter box. `input` is what `filtWire` listens for; `bubbles` because the
// listener is on the element itself but the page's own handlers are delegated off document.
const TYPE = s =>
  `(() => { const b = document.getElementById('aceLibFilter'); b.value = ${s};
      b.dispatchEvent(new Event('input', {bubbles: true})); return b.value; })()`;
const SORT = v =>
  `(() => { const s = document.getElementById('aceLibSort'); s.value = ${v};
      s.dispatchEvent(new Event('change', {bubbles: true})); return s.value; })()`;

// 🔴 "TWO POLL CYCLES LATER" IS COUNTED IN POLLS, NOT IN SECONDS. `refreshAce` fetches the library
// every 2 s and repaints from the answer. This used to be `sleep(4500)`, which is two cycles on an
// idle machine and fewer on a loaded one. The fetch log records a response BEFORE the page paints
// from it, so the wait is for THREE more responses: by the third, two repaints are certainly done.
// False if the poll stopped, which fails the check that calls this rather than passing it unproven.
const twoRepaintsLater = async cdp => {
  const before = await evaluate(cdp, fetchCount('/acestep/library', 'GET'));
  return waitFor(cdp, fetchCountAtLeast('/acestep/library', before + 3, 'GET'), 30000);
};

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

  // The tray repaints only while its panel is on screen (`visible()` in ace/tray.js), so this
  // click is not navigation — it is what starts the list the whole spec is about.
  await evaluate(cdp, `document.querySelector('#tabs button[data-tab="acestep"]').click()`);

  // ── 1. THE PAGE IS 25 LONG, AND THAT IS THE POINT OF PAGING ─────────────────────────────
  // The fixture holds 30 songs. Without a pager every one of them renders, each with its own
  // <audio preload="metadata"> — which is what "as the library grows, it becomes unwieldy" is.
  const paged = await waitFor(cdp, `${COUNT} === 25`, 25000);
  ok(paged, '🔴 the library paints ONE page of 25, not all 30 songs');
  if (!paged) throw new Error(`the library never paged — it shows ${await evaluate(cdp, COUNT)} rows`);

  const bar = await evaluate(
    cdp,
    `(() => { const g = s => { const e = document.querySelector(s); if (!e) return {missing: true};
          const r = e.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)}; };
        const b = document.querySelector('#aceLibrary .acelibbar');
        const head = document.querySelector('#aceLibrary .acedlhead');
        const kids = [...document.getElementById('aceLibrary').children];
        return {filt: g('#aceLibFilter'), sort: g('#aceLibSort'), all: g('#aceSelAll'), del: g('#aceLibDel'),
                barTop: b ? Math.round(b.getBoundingClientRect().top) : -1,
                headBottom: head ? Math.round(head.getBoundingClientRect().bottom) : -1,
                order: kids.slice(0, 3).map(k => k.className).join(' | ')}; })()`,
  );
  ok(
    !bar.filt.missing && !bar.sort.missing && !bar.all.missing && !bar.del.missing,
    `the filter box, the order picker, the All tick and 🗑 Delete selected are all on the bar (${JSON.stringify(bar)})`,
  );
  ok(bar.filt.w > 80 && bar.sort.w > 60 && bar.del.w > 60, `and every one of them has real width (${JSON.stringify(bar)})`);
  // 🔴 THE BAR IS BELOW THE HEADING, NOT ABOVE IT. `reconcile` re-inserts `data-keep` furniture at
  // the FRONT of the host, so walking the keep list forwards lands them in REVERSE — which is
  // exactly what happened before 9.7.0 and is only visible with two of them.
  ok(bar.barTop >= bar.headBottom - 2, `🔴 the filter bar sits UNDER the Library heading, not above it (${JSON.stringify(bar)})`);

  const pager = await evaluate(
    cdp,
    `(() => { const p = document.getElementById('aceLibPager');
        return {text: (p.textContent || '').replace(/\\s+/g, ' ').trim(),
                shown: getComputedStyle(p).display !== 'none'}; })()`,
  );
  ok(pager.shown && /Page 1 of 2/.test(pager.text), `the pager says which page you are on (${JSON.stringify(pager)})`);

  // ── 2. NEXT GOES TO THE REST OF THEM ────────────────────────────────────────────────────
  await evaluate(cdp, `document.getElementById('aceLibNext').click()`);
  ok(await waitFor(cdp, `${COUNT} === 5`, 10000), 'Next ▸ paints the remaining 5 songs');
  ok(
    await waitFor(cdp, `/Page 2 of 2/.test(document.getElementById('aceLibPager').textContent)`, 10000),
    'and the pager follows you onto page 2',
  );
  // 🔴 AND THE 2 s POLL DOES NOT DRAG YOU BACK. `refreshAce` repaints from the server every two
  // seconds; a painter that reset the page on every payload would make page 2 unreadable, and the
  // symptom — "it keeps jumping back" — would read as a browser fault rather than as this.
  ok((await twoRepaintsLater(cdp)) && (await evaluate(cdp, `${COUNT} === 5`)), '🔴 and two full poll cycles later you are STILL on page 2');

  // ── 3. THE FILTER, AND IT TAKES YOU BACK TO PAGE 1 ──────────────────────────────────────
  await evaluate(cdp, TYPE(`'zzz'`));
  ok(await waitFor(cdp, `${COUNT} === 1`, 10000), 'typing in the filter box narrows the list to the one match');
  const one = await evaluate(cdp, NAMES);
  ok(one.length === 1 && /ZZZ Sample Track/i.test(one[0]), `and the row it leaves is the right one (${JSON.stringify(one)})`);
  ok(
    await evaluate(cdp, `getComputedStyle(document.getElementById('aceLibPager')).display === 'none'`),
    'the pager disappears when the filter leaves one page',
  );
  ok(
    await evaluate(cdp, `/1 of 30 songs/.test(document.getElementById('aceLibCount').textContent)`),
    `the count describes what is ON SCREEN against the whole library ` +
      `(${JSON.stringify(await evaluate(cdp, `document.getElementById('aceLibCount').textContent`))})`,
  );

  // 🔴 EVERY WORD, IN ANY ORDER — the shared matcher, not a substring. "one sample" has to find
  // "Sample Track One", which no single-substring filter can do.
  await evaluate(cdp, TYPE(`'one sample'`));
  ok(await waitFor(cdp, `${COUNT} === 1`, 10000), '🔴 two words in either order find the song a substring never would');

  // A filter that matches nothing says so, quoting what was typed — it must never say "Nothing
  // saved yet" over a full library, which is the sentence that makes someone think their songs
  // are gone.
  await evaluate(cdp, TYPE(`'qqzzxx'`));
  ok(await waitFor(cdp, `${COUNT} === 0`, 10000), 'a filter that matches nothing empties the list');
  const none = await evaluate(cdp, `document.getElementById('aceLibrary').textContent`);
  ok(/Nothing matches/.test(none) && /qqzzxx/.test(none), '🔴 and it says "Nothing matches" quoting the query, never "Nothing saved yet"');
  // 🔴 THE HEADER AND THE BAR SURVIVE THE EMPTY STATE, IN ORDER. `reconcile`'s empty path assigns
  // innerHTML and puts the furniture back — the one path where the reversal bug bit, and the one
  // moment it is worst, because the user is mid-keystroke.
  const emptyOrder = await evaluate(
    cdp,
    `[...document.getElementById('aceLibrary').children].map(k => k.className.split(' ')[0]).join('|')`,
  );
  ok(/^acesong\|acelibbar/.test(emptyOrder), `🔴 the heading and the bar keep their order over an empty list (${emptyOrder})`);

  await evaluate(cdp, TYPE(`''`));
  ok(await waitFor(cdp, `${COUNT} === 25`, 10000), 'clearing the box brings the whole library back, on page 1');

  // ── 4. THE ORDER ────────────────────────────────────────────────────────────────────────
  // Newest first is the default and is what the server already sends, so the two A–Z orders are
  // where a real sort has to happen.
  const newestFirst = await evaluate(cdp, NAMES);
  ok(
    /ZZZ Sample Track/i.test(newestFirst[0] || ''),
    `Newest first puts the last-saved song at the top (${JSON.stringify(newestFirst[0])})`,
  );

  await evaluate(cdp, SORT(`'name'`));
  ok(
    await waitFor(cdp, `${NAMES}[0].indexOf('AAA Sample Track') === 0`, 10000),
    '🔴 Name A–Z puts the alphabetically first song at the top',
  );
  const az = await evaluate(cdp, NAMES);
  ok(
    az.length === 25 && az.every((n, i) => i === 0 || az[i - 1].localeCompare(n) <= 0),
    `and the whole page really is in order (${JSON.stringify(az.slice(0, 3))} … ${JSON.stringify(az.slice(-1))})`,
  );

  await evaluate(cdp, SORT(`'namez'`));
  ok(await waitFor(cdp, `${NAMES}[0].indexOf('ZZZ Sample Track') === 0`, 10000), 'Name Z–A flips it');

  await evaluate(cdp, SORT(`'old'`));
  ok(await waitFor(cdp, `${NAMES}[0].indexOf('AAA Sample Track') === 0`, 10000), 'Oldest first reads the save time the other way');

  // 🔴 THE CHOICE FOLLOWS THE ACCOUNT. It is written through UIS, so it survives a reload — the
  // bug this line exists for is a picker that reads its own markup default and silently disagrees
  // with the list beside it. `vocalis-ace-dl` shipped exactly that mismatch.
  await evaluate(cdp, SORT(`'name'`));
  // 🔴 WAIT FOR THE SERVER TO HOLD IT, THEN RELOAD. UIS writes are debounced 400 ms, and this was
  // `sleep(600)`: under load the write had not been sent when the page reloaded, the reload read
  // the old order, and the two checks below failed three runs in five (2026-10-12, five copies of
  // this spec at once). The saved state is the fact the reload depends on, so that is what is asked.
  if (!(await waitFor(cdp, uiStateIs('vocalis-ace-libsort', 'name'), 20000)))
    throw new Error('the chosen order never reached /ui-state, so a reload cannot be expected to keep it');
  // The gate below must be met by the NEW page; the old one already meets the rest of it. This
  // is the likeliest cause of this spec's 2026-10-12 full-run failure ("the order picker still
  // SHOWS the order it was left on", the first check after this reload). See _specwait.mjs.
  await evaluate(cdp, STAMP_OUTGOING);
  await cdp.send('Page.navigate', { url: baseUrl });
  ok(
    await waitFor(
      cdp,
      `${ON_NEW_DOCUMENT} && document.readyState === 'complete' && window.__uiReady === true && window.__bootDone === true`,
      45000,
    ),
    'the page reloads',
  );
  // 🔴 RE-ARM THE ERROR COLLECTOR. `Page.navigate` replaces the document, so the listeners
  // installed at the top are gone — and `window.__specErrors` with them. Without this the final
  // check reads `["collector missing"]` and fails, which is the honest failure: a collector that
  // is not there cannot say the page threw nothing.
  await evaluate(
    cdp,
    `(() => { window.__specErrors = [];
        window.addEventListener('error', e => window.__specErrors.push(String(e.message)));
        window.addEventListener('unhandledrejection', e => window.__specErrors.push('unhandled: ' + String(e.reason)));
        return true; })()`,
  );
  await evaluate(cdp, INSTALL_FETCH_LOG); // the reload took the first one with the document
  await evaluate(cdp, `document.querySelector('#tabs button[data-tab="acestep"]').click()`);
  ok(await waitFor(cdp, `${COUNT} === 25`, 25000), 'the library comes back after the reload');
  ok(
    await evaluate(cdp, `document.getElementById('aceLibSort').value === 'name'`),
    '🔴 the order picker still SHOWS the order it was left on',
  );
  ok(
    await evaluate(cdp, `${NAMES}[0].indexOf('AAA Sample Track') === 0`),
    '…and the list is really in that order, not merely labeled with it',
  );

  // ── 5. SELECT ALL REACHES EVERY PAGE ────────────────────────────────────────────────────
  // 🔴 THIS IS THE ASSERTION PAGING EXISTS TO THREATEN. `All` has to tick the 5 songs on page 2
  // as well as the 25 on page 1, or a 30-song delete is two gestures and a 300-song one is twelve.
  await evaluate(cdp, `document.getElementById('aceSelAll').click()`);
  ok(
    await waitFor(cdp, `/Delete selected \\(30\\)/.test(document.getElementById('aceLibDel').textContent)`, 10000),
    '🔴 All ticks every one of the 30 songs, including the 5 on the page you cannot see',
  );
  ok(
    await evaluate(cdp, `document.querySelectorAll('#aceLibrary input.acetick:checked').length === 25`),
    'and the 25 boxes actually on screen are all painted ticked',
  );
  ok(
    await evaluate(cdp, `document.getElementById('aceLibDel').disabled === false`),
    '🗑 Delete selected is enabled once something is selected',
  );

  // 🔴 AND THE SELECTION SURVIVES THE 2 s REPAINT. `TICKED` is the truth and `applyTicks` paints
  // it after every reconcile; an implementation that rendered `checked` into the row instead
  // would pass every assertion above and lose the lot two seconds later.
  ok(
    (await twoRepaintsLater(cdp)) &&
      (await evaluate(cdp, `/Delete selected \\(30\\)/.test(document.getElementById('aceLibDel').textContent)`)),
    '🔴 and all 30 are still selected two poll cycles later',
  );

  // Untick: the same control clears it, which is the half of "toggle all" that gets forgotten.
  await evaluate(cdp, `document.getElementById('aceSelAll').click()`);
  ok(
    await waitFor(cdp, `document.getElementById('aceLibDel').disabled === true`, 10000),
    'pressing All again clears the selection and disables the delete',
  );

  // ── 6. THE FILTER PRUNES THE TICKS IT HIDES ─────────────────────────────────────────────
  // The rule that points the OTHER way from §5, one function apart in the source: paging is
  // navigation and keeps its ticks, filtering is search and drops them. A tick left pointing at a
  // row nobody can see would travel invisibly into the next delete.
  await evaluate(cdp, `document.getElementById('aceSelAll').click()`);
  ok(await waitFor(cdp, `/\\(30\\)/.test(document.getElementById('aceLibDel').textContent)`, 10000), 'all 30 ticked again');
  await evaluate(cdp, TYPE(`'zzz'`));
  ok(
    await waitFor(cdp, `/Delete selected \\(1\\)/.test(document.getElementById('aceLibDel').textContent)`, 10000),
    '🔴 filtering to one song drops the other 29 ticks rather than carrying them into the delete',
  );
  // The tri-state: one of one is ALL of what is on screen, so the box reads checked here.
  ok(
    await evaluate(cdp, `document.getElementById('aceSelAll').checked === true`),
    'and the All box reads checked when everything on screen is ticked',
  );

  // ── 7. 🗑 DELETE SELECTED, ON THE SERVER ────────────────────────────────────────────────
  // The button must be topmost at its center. A sibling overlay can make a visible control inert;
  // a width check cannot catch that, but `elementFromPoint` can.
  // ⚠️ SCROLLED INTO VIEW FIRST. `elementFromPoint` is VIEWPORT-relative and answers `null` for a
  // point outside it — so a button sitting below the fold reads exactly like a covered one, and
  // the check would fail for a reason that is not the bug it is about.
  // `behavior: 'instant'`: the scroll is finished when the call returns, so there is nothing to
  // wait for. (This was a default scroll followed by `sleep(200)`.)
  await evaluate(
    cdp,
    `(() => { document.getElementById('aceLibDel').scrollIntoView({block: 'center', behavior: 'instant'}); return true; })()`,
  );
  const hit = await evaluate(
    cdp,
    `(() => { const b = document.getElementById('aceLibDel'); const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return {same: el === b, got: el ? (el.id || el.className || el.tagName) : null,
                top: Math.round(r.top), vh: window.innerHeight}; })()`,
  );
  ok(hit.same, `🔴 a click at the center of 🗑 Delete selected lands ON it, nothing is covering it (${JSON.stringify(hit)})`);

  await evaluate(cdp, `document.getElementById('aceLibDel').click()`);
  // 🔴 `#overlay.on`, NOT `querySelector('.modal')`. There is ONE overlay element in the page and
  // every dialog in the product reuses it, so it is in the DOM from the first paint — a wait on
  // its EXISTENCE is true on its first poll and waits for nothing. `.on` is what media.css flips
  // to `display:flex`, i.e. the only thing that means "a dialog is up".
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`, 10000), 'it asks before deleting anything');
  // The confirm names the song, because a delete you cannot check is a delete you cannot consent to.
  const confirmText = await evaluate(cdp, `document.getElementById('overlay').textContent || ''`);
  ok(
    /ZZZ Sample Track/i.test(confirmText),
    `and the confirm names the song it is about to delete (${JSON.stringify(confirmText.slice(0, 120))})`,
  );
  await evaluate(
    cdp,
    // ⚠️ SCOPED TO `#mActs`, the dialog's own button row. A page-wide `querySelectorAll('button')`
    // would also see every row's ✕ and whichever one it found first would be pressed instead.
    `(() => { const b = [...document.querySelectorAll('#mActs button')].find(x => /^Delete$/.test(x.textContent.trim()));
        if (b) b.click(); return !!b; })()`,
  );
  ok(
    await waitFor(cdp, `fetch('/acestep/library').then(r => r.json()).then(d => d.songs.length === 29)`, 15000),
    '🔴 🗑 Delete selected really deletes it, on the SERVER — 30 songs became 29',
  );
  ok(
    await waitFor(
      cdp,
      `fetch('/acestep/library').then(r => r.json()).then(d => !d.songs.some(s => /ZZZ Sample Track/i.test(s.name)))`,
      10000,
    ),
    'and it deleted the ticked one, not some other row',
  );
  ok(
    await waitFor(cdp, `document.getElementById('aceLibDel').disabled === true`, 10000),
    'the selection is spent afterward — the rows it named are gone',
  );

  // ── 8. A BULK DELETE OF SEVERAL, WHICH IS THE WHOLE REQUEST ─────────────────────────────
  await evaluate(cdp, TYPE(`'Track 1'`));
  const many = await waitFor(cdp, `${COUNT} >= 5`, 10000);
  ok(many, 'the filter narrows to a handful of tracks');
  await evaluate(cdp, `document.getElementById('aceSelAll').click()`);
  const picked = await evaluate(cdp, `document.querySelectorAll('#aceLibrary input.acetick:checked').length`);
  ok(picked >= 5, `and All ticks all ${picked} of them`);
  await evaluate(cdp, `document.getElementById('aceLibDel').click()`);
  ok(
    await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`, 10000),
    'the confirm names the count for a bulk delete',
  );
  await evaluate(
    cdp,
    `(() => { const b = [...document.querySelectorAll('#mActs button')].find(x => /^Delete \\d+$/.test(x.textContent.trim()));
        if (b) b.click(); return !!b; })()`,
  );
  ok(
    await waitFor(cdp, `fetch('/acestep/library').then(r => r.json()).then(d => d.songs.length === ${29 - picked})`, 15000),
    `🔴 ${picked} songs go in ONE press — the server handles the selected songs in one request`,
  );

  await evaluate(cdp, TYPE(`''`));
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

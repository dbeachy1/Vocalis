// Vocalis 7.3.19 — the header's board/VRM temperature readout, in a REAL browser.
//
// WHY a browser test when test_temps.py already covers the reader exhaustively: that file stops at
// the dict. Everything this one checks lives past it — `renderStrip`'s fan-out, the shape signature
// (which the two temperature bits had to be added to individually, because a box can publish the
// board sensor without the VRM one), the `numDue` gate, and two things no Python test can see:
//
//   1. WHERE IT LANDS. Keep the readout in the existing UPS/VRAM column rather than adding a
//      grid track. Its zero-width, right-aligned text overflows left under the brand.
//   2. 🔴 THAT THE FOURTH COLUMN IS REALLY GONE, not merely emptied. An empty `auto` track still
//      reserves its 14px column-gap, which took that width off the strip opposite and left every
//      spanning row short of the stack's right edge. So the checks below count the TRACKS and
//      measure the two spanning rows against the stack, rather than trusting that hiding an
//      element undid the column. test_strip_layout.py cannot see any of this: it measures a HAND
//      COPY of this header that nothing enforces against index.html.
//
// Usage: node board_temp_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node board_temp_browser_spec.mjs <base-url> <chrome-path>');
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

// ── CDP plumbing (mirrors ups_line_browser_spec.mjs) ─────────────────────────
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

// The deadline only bounds a HANG; a passing run never waits it out. 20 s (8 s on some calls) was too
// short with dozens of these specs running at once, so the default is 60 s (2026-10-12).
async function waitFor(cdp, expression, timeoutMs = 60000) {
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
    // FOR the repaint, so polling during it is the normal case and the early polls being false
    // is the entire point; mutation coverage checks both outcomes.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-temp-cdp-'));
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
    '--window-size=1920,1200',
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
  // after `kill()` returns. The bounded fallback handles cases where the exit event is delayed.
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

//: Drive the renderer directly with one temps block, for the states the stub server does not serve.
//: 🔴 THE 560 ms WAIT IS LOAD-BEARING — `renderStrip` gates every value it writes behind
//: `strip.numDue`, which is false unless NUM_MS (500) has passed. Successive CDP calls land ~10 ms
//: apart, so without this the 2nd and 3rd fixtures are never painted and every comparison reads the
//: FIRST one against itself. That made four checks vacuous in the UPS spec and passed while doing it.
//:
//: 2026-10-12: THE 560 ms IS NOW ADDED TO THE PAGE'S CLOCK, NOT SLEPT. The gate reads
//: `performance.now()`, so the wait was a guess about how long the machine takes to let 560 ms go by;
//: advancing the clock by 560 ms is exactly what the gate needs and cannot be short. And the module
//: is the page's OWN instance (`window.__VOCALIS__`), because the page loads a bundle and a fresh
//: `import()` builds a second copy: `stopIdleVram()` on that copy stopped nothing, so the real
//: sampler kept painting the stub while this read the DOM.
const withTemps = temps => `(async () => {
    const m = (window.__VOCALIS__ && window.__VOCALIS__['sys/hwstrip.js']) || (await import('/webui/js/sys/hwstrip.js'));
    m.stopIdleVram();                       // or the next 250 ms poll paints the stub back
    if (!window.__clockSkew) {
        window.__clockSkew = 0;
        const real = performance.now.bind(performance);
        performance.now = () => real() + window.__clockSkew;
    }
    window.__clockSkew += 560;                       // > NUM_MS, so numDue is true — see above
    m.renderStrip({gpus: [], cpu: {pct: 1, cores: 32}, power: null, ups: null,
                   temps: ${JSON.stringify(temps)}});
    const el = document.getElementById('boardTemp');
    const one = k => {
        const n = el.querySelector('[data-r="' + k + '"]');
        return n ? { text: n.innerText.trim(), color: getComputedStyle(n).color } : null;
    };
    // ⚠️ ALL THREE, and the missing one KILLED THE HARNESS rather than failing a check: reading
    // .color off an undefined node throws, which aborted the spec and took every remaining
    // assertion with it. A fixture helper returning a subset of what the checks read is a landmine
    // for whichever check is added last.
    // Keep this template-literal comment free of backticks; a literal backtick would end the string.
    return { display: getComputedStyle(el).display, title: el.title,
             text: el.innerText.replace(/\\s+/g, ' ').trim(),
             mb: one('mb'), vrm: one('vrm'), ram: one('ram') };
})()`;

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

  // ── it paints itself, off the page's OWN poll ───────────────────────────
  // ⚠️ Allow 45s for the page's asynchronous boot before checking the first `/system/stats` poll.
  // This verifies eventual rendering from server data, not a specific startup latency.
  const appeared = await waitFor(
    cdp,
    `document.getElementById('boardTemp') &&
                           getComputedStyle(document.getElementById('boardTemp')).display !== 'none'`,
    45000,
  );
  // Distinguish missing server data, a missed poll, missing markup, and a hidden element.
  if (!appeared) {
    const diag = await evaluate(
      cdp,
      `(async () => {
            const el = document.getElementById('boardTemp');
            let served = null;
            try { served = (await (await fetch('/system/stats')).json()).temps; }
            catch (e) { served = 'fetch failed: ' + e.message; }
            return { served, hidden: document.hidden,
                     el: el ? el.outerHTML.slice(0, 300) : 'NO #boardTemp IN THE MARKUP',
                     stack: (document.querySelector('.hdr-stack') || {}).className,
                     ups: (document.getElementById('upsLine') || {}).style?.display,
                     pow: (document.getElementById('powerLine') || {}).style?.display };
        })()`,
    );
    console.error(`  diag ${JSON.stringify(diag)}`);
  }
  ok(appeared, 'the board temperature readout appears when the server reports board sensors');

  const txt = await evaluate(cdp, `document.getElementById('boardTemp').innerText.replace(/\\s+/g, ' ').trim()`);
  ok(/board/i.test(txt), `the board figure is labeled (got ${JSON.stringify(txt)})`);
  ok(/\bVRM\b/.test(txt), 'and the VRM figure is labeled as such');
  ok(/\b37\b/.test(txt) && /°C/.test(txt), 'it prints the board temperature in °C');
  ok(/\b54\b/.test(txt), 'and the VRM temperature');
  ok(/\bRAM\b/.test(txt) && /\b43\b/.test(txt), 'and the hottest DIMM, labeled RAM');
  // ⚠️ NO DECIMAL. hwmon reports millidegrees and the reader rounds; printing 37.0 would imply a
  // tenth of a degree of meaning that a board thermistor does not have.
  ok(!/\d+\.\d+\s*°C/.test(txt), 'with no decimal — a board thermistor is not precise to a tenth');

  // ── settled header geometry ───────────────────────────────────────────────
  // 🔴 Wait for the brand version before measuring the left-overflowing temperature text. The
  // brand width determines the stack position, while the brand and temperatures are populated by
  // separate polls that can complete in either order. Measuring before both settle checks a
  // transient layout rather than the final header. A brief boot-time overlap is cosmetic and
  // self-healing; it is documented with the header markup.
  // ⚠️ PLAIN NUMBERS, NOT DOMRects — CDP's returnByValue does not call DOMRect.toJSON, so a rect
  // comes back as {} and every comparison silently reads `undefined`.
  // Reveal the header controls first. The stub omits the engine and GPU cards, so hidden controls
  // would have 0x0 bounds and make the alignment checks meaningless.
  const branded = await waitFor(cdp, `(document.getElementById('ver').textContent || '').trim().length > 0`, 45000);
  ok(
    branded,
    'the brand carries its version before any geometry is measured — a header whose ' +
      '#ver is still empty is ~105px narrower and every left-overflow measurement below is of ' +
      'a page that never reaches a user',
  );
  const geo = await evaluate(
    cdp,
    `(() => {
        for (const id of ['cbBtn', 'freeBtn', 'voxBtn', 'comfyBtn', 'logoutBtn']) {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        }
        // Reveal the edition tag too; hidden elements have 0x0 bounds and invalidate centering checks.
        const _ed = document.getElementById('edition');
        if (_ed) _ed.hidden = false;
        const stackEl = document.querySelector('.hdr-stack');
        const cs = getComputedStyle(stackEl);
        const b = el => { const r = el.getBoundingClientRect();
                          return {top: r.top, bottom: r.bottom, left: r.left, right: r.right}; };
        const g = id => b(document.getElementById(id));
        // The row container is zero-width by design, so measure the rendered child extents instead.
        // Keep comments in this evaluated template free of backticks.
        const kids = [...document.getElementById('boardTemp').children]
                        .map(c => c.getBoundingClientRect());
        const ink = kids.length
            ? { top: Math.min(...kids.map(r => r.top)), bottom: Math.max(...kids.map(r => r.bottom)),
                left: Math.min(...kids.map(r => r.left)), right: Math.max(...kids.map(r => r.right)) }
            : null;
        // The UPS row is also zero-width; measure its child text bounds for the logout-position check.
        const ukids = [...document.getElementById('upsLine').children]
                          .map(c => c.getBoundingClientRect());
        const upsInk = ukids.length
            ? { top: Math.min(...ukids.map(r => r.top)), bottom: Math.max(...ukids.map(r => r.bottom)),
                left: Math.min(...ukids.map(r => r.left)), right: Math.max(...ukids.map(r => r.right)) }
            : null;
        return { temp: g('boardTemp'), logout: g('logoutBtn'), ready: g('ready'), ink, upsInk,
                 // Read brand lines by element so an added child cannot silently shift their meaning.
                 // Keep this embedded comment free of backticks; the surrounding source is a template literal.
                 h1: b(document.querySelector('.hdr-brand h1')), verEl: g('ver'), edition: g('edition'),
                 brandBox: b(document.querySelector('.hdr-brand')),
                 psi: g('psiLine'), ups: g('upsLine'), pow: g('powerLine'), swap: g('swapLine'),
                 cb: g('cbBtn'), free: g('freeBtn'), vox: g('voxBtn'),
                 // Compare painted child extents instead of the grid bounding box: its rows have different
                 // widths, and the box includes whitespace that can appear to overlap adjacent content.
                 brand: [...document.querySelector('.hdr-brand').children].map(b),
                 stack: b(stackEl), tracks: cs.gridTemplateColumns, gap: parseFloat(cs.columnGap) };
    })()`,
  );
  const mid = r => (r.top + r.bottom) / 2;
  const col1Right = Math.max(geo.cb.right, geo.free.right);
  const where =
    `[ink ${geo.ink && geo.ink.left.toFixed(1)}-${geo.ink && geo.ink.right.toFixed(1)} · ` +
    `psi ${geo.psi.left.toFixed(1)}-${geo.psi.right.toFixed(1)} · ` +
    `ups right ${geo.ups.right.toFixed(1)} · col1 right ${col1Right.toFixed(1)} · ` +
    `tracks ${geo.tracks} gap ${geo.gap}]`;

  // Keep the temperature readout in the existing UPS/VRAM column and aligned to the same right
  // edge; a separate grid track adds header width. Measure after the brand and stats polls settle,
  // then compare the rendered text extents with the buttons.
  ok(
    Math.abs(mid(geo.temp) - mid(geo.psi)) <= 2,
    `it shares the mem-pressure row rather than taking one of its own — centers ` +
      `${mid(geo.temp).toFixed(1)} vs ${mid(geo.psi).toFixed(1)} ${where}`,
  );
  ok(geo.temp.top < geo.ups.top - 2, `and sits ABOVE the UPS line, one row up, which is where it goes ${where}`);
  // 🔴 9.0.7 — Center the brand, version, edition, and Log out as one three-line group. Keep the
  // separate safety check that Log out stays above the UPS line; it also catches extra brand rows
  // or larger type that would make the header taller than its stack.
  const line1 = {
    top: Math.min(geo.h1.top, geo.verEl.top),
    bottom: Math.max(geo.h1.bottom, geo.verEl.bottom),
    left: Math.min(geo.h1.left, geo.verEl.left),
    right: Math.max(geo.h1.right, geo.verEl.right),
  };
  const cx = r => (r.left + r.right) / 2;
  // 🔴 THE ZERO GUARD. A hidden element reports every edge as 0, and 0 satisfies "these centers
  // agree" as happily as a correct layout does — the failure mode a full run caught twice in
  // 8.9.14. The probe unhides #edition and #logoutBtn above; this is what proves it worked.
  ok(
    line1.right > 0 && geo.edition.right > 0 && geo.logout.right > 0,
    `all three brand lines are actually laid out before they are measured ` +
      `[line1 ${line1.left.toFixed(1)}-${line1.right.toFixed(1)} · ` +
      `edition ${geo.edition.left.toFixed(1)}-${geo.edition.right.toFixed(1)} · ` +
      `logout ${geo.logout.left.toFixed(1)}-${geo.logout.right.toFixed(1)}]`,
  );
  ok(
    Math.abs(cx(line1) - cx(geo.edition)) <= 1.5 && Math.abs(cx(geo.edition) - cx(geo.logout)) <= 1.5,
    `the three brand lines share one center axis — Vocalis ${cx(line1).toFixed(1)}, ` +
      `Encrypted Edition ${cx(geo.edition).toFixed(1)}, ⎋ Log out ${cx(geo.logout).toFixed(1)}`,
  );
  // CONTIGUOUS, which is the "just above" half of the ask. The gap is one 2px row-gap plus the
  // button's 4px margin; anything beyond ~14px means a `1fr` track has crept back BETWEEN two of
  // the three, which is exactly the layout this change replaced.
  ok(
    geo.logout.top - geo.edition.bottom >= -1 && geo.logout.top - geo.edition.bottom <= 14,
    `⎋ Log out sits directly under the Encrypted Edition line, not a stretched track below it — ` +
      `gap ${(geo.logout.top - geo.edition.bottom).toFixed(1)}px`,
  );
  // …and the group is centered VERTICALLY in the brand, not merely packed to the top: the space
  // above the first line and below the last are the two `1fr` tracks and must agree.
  ok(
    line1.top - geo.brandBox.top <= 4 && geo.brandBox.bottom - geo.logout.bottom > 8,
    `and the group sits at the TOP of the column with the slack below it — ` +
      `${(line1.top - geo.brandBox.top).toFixed(1)}px above, ` +
      `${(geo.brandBox.bottom - geo.logout.bottom).toFixed(1)}px below`,
  );
  // 🔴 AND THE BRAND STILL DOES NOT OUTGROW .hdr-stack. If this fails, something has stopped the
  // stack being the tallest item in the header (a fourth brand line, a sixth stack row, a #vram
  // taller than either) — fix THAT, do not shrink the brand to hide it.
  ok(
    geo.logout.bottom <= geo.upsInk.bottom + 2,
    `⎋ Log out does not hang below the UPS line, i.e. the brand has not grown past the stack — ` +
      `button ${geo.logout.bottom.toFixed(1)} vs UPS ink ${geo.upsInk.bottom.toFixed(1)}`,
  );
  // Keep the logout button above the UPS row so the temperature readouts that overflow left retain their lane.
  ok(
    geo.logout.bottom < geo.upsInk.top,
    `it sits clear ABOVE the UPS line rather than in its row — button bottom ` +
      `${geo.logout.bottom.toFixed(1)} vs UPS ink top ${geo.upsInk.top.toFixed(1)}`,
  );
  // Keep the logout button within the brand's left edge; its left edge must not drift past the h1 margin.
  ok(
    geo.logout.left >= geo.brand[0].left - 1,
    `and no part of the group hangs left of "Vocalis" — button ${geo.logout.left.toFixed(1)} vs h1 ` + `${geo.brand[0].left.toFixed(1)}`,
  );
  // 🔴 AND IT CLEARS THE READOUTS THAT OVERFLOW INTO ITS SPACE — THE COLLISION THIS MOVE CREATES
  // AND NOTHING ELSE WOULD CATCH. #boardTemp and #upsLine are `width:0`, right-aligned to stack
  // column 1 and overflowing LEFT, so they grow toward this button every time their strings get
  // longer (an `LB` status, a wider runtime, a fourth temperature).
  // ⚠️ 9.0.7 CAUGHT EXACTLY THAT, and it is why this is an OVERLAP test now rather than a
  // comparison against the UPS line alone. Centering the group moved the button 42px right and
  // 30px up, out of the UPS row and into the BOARD TEMPERATURE row, where its right edge came
  // down 2.1px inside that line's ink — a two-pixel collision with a readout the old assertion
  // was not even looking at. An x-comparison against one specific row is a check that only sees
  // the collision it was written for.
  const overlaps = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  ok(
    !overlaps(geo.logout, geo.upsInk) && !overlaps(geo.logout, geo.ink),
    `and ⎋ Log out collides with NEITHER left-overflowing readout — button ` +
      `[${geo.logout.left.toFixed(1)}-${geo.logout.right.toFixed(1)} x ${geo.logout.top.toFixed(1)}-${geo.logout.bottom.toFixed(1)}], ` +
      `board ink [${geo.ink && geo.ink.left.toFixed(1)}-${geo.ink && geo.ink.right.toFixed(1)} x ${geo.ink && geo.ink.top.toFixed(1)}-${geo.ink && geo.ink.bottom.toFixed(1)}], ` +
      `UPS ink [${geo.upsInk.left.toFixed(1)}-${geo.upsInk.right.toFixed(1)} x ${geo.upsInk.top.toFixed(1)}-${geo.upsInk.bottom.toFixed(1)}]`,
  );
  // 🔴 Moving Log out off the brand's first line narrows the brand and shifts the stack left. The
  // Free Vocalis VRAM control moved from 283.3px to 193.7px; assert that it clears Log out and
  // starts before its former position rather than relying on a guessed fixed offset.
  ok(
    geo.free.left < 240 && geo.free.left > geo.logout.right,
    `Free Vocalis VRAM starts where Log out used to — ${geo.free.left.toFixed(1)}, left of the ` +
      `283.3 it sat at while the button shared the brand's first line`,
  );
  // 🔴 THE SAME EDGE AS THE UPS LINE, AND IT IS THE BUTTON'S RATHER THAN THE TRACK'S.
  // `justify-self:end` lands on the column-1 TRACK edge, and a track is only as narrow as its
  // widest item — so if this line inflates column 1 it stops short of `Free Vocalis VRAM` and the
  // alignment is off by exactly that much. Measured against the button, never against the track.
  ok(
    geo.ink && Math.abs(geo.ink.right - col1Right) <= 1.5,
    `its printed text ends on the first button column's edge — Free Vocalis VRAM ${where}`,
  );
  ok(Math.abs(geo.ups.right - geo.temp.right) <= 1.5, `and on exactly the same edge as the UPS line below it ${where}`);
  ok(geo.temp.right < geo.stack.right - 5, 'NOT flush with the stack — that is the distinction from the three rows it sits among');

  // 🔴 IT OVERFLOWS LEFT, UNDER THE BRAND, AND ROW 4 IS HIGHER UP THAN THE UPS LINE'S ROW 5 — so
  // the brand's own height buys less clearance here than it does one row down. If this ever
  // lands on top of "Vocalis v… — Studio", the edition tag or Log out, it reads as a rendering
  // fault, and no other check in this file would see it. Overlap is absence of separation on
  // BOTH axes.
  // ⚠️ Check each brand element rather than the `.hdr-brand` container; its broad rectangle can
  // overlap whitespace where neither side paints pixels.
  const hits = (geo.ink ? geo.brand : []).filter(
    el => geo.ink.left < el.right && geo.ink.right > el.left && geo.ink.top < el.bottom && geo.ink.bottom > el.top,
  );
  ok(
    hits.length === 0,
    `and clears every line of the brand rather than printing over it (` +
      `${hits.length} hit(s)${
        hits.length
          ? ': ' +
            hits.map(el => `${el.left.toFixed(1)}-${el.right.toFixed(1)} x ` + `${el.top.toFixed(1)}-${el.bottom.toFixed(1)}`).join(' | ')
          : ''
      }, ink ` +
      `${geo.ink && geo.ink.left.toFixed(1)}-${geo.ink && geo.ink.right.toFixed(1)} x ` +
      `${geo.ink && geo.ink.top.toFixed(1)}-${geo.ink && geo.ink.bottom.toFixed(1)})`,
  );

  // 🔴 THE FOURTH COLUMN IS GONE, AND THIS IS WHAT PROVES IT. Three tracks, not four — an empty
  // fourth reserved its 14px gap even at 0px wide, which stole that much from the strip opposite
  // and left every spanning row short of the stack's right edge.
  ok(geo.tracks.split(/\s+/).length === 3, `the stack is back to THREE columns (got ${geo.tracks})`);
  ok(Math.abs(geo.psi.right - geo.stack.right) <= 1.5, `so the mem-pressure row reaches the stack's right edge again ${where}`);
  ok(Math.abs(geo.swap.right - geo.stack.right) <= 1.5, `and so does the swap/uptime row ${where}`);

  // 🔴 AND IT MUST NOT HAVE MOVED THE BUTTONS. A nowrap readout pinned into column 1 feeds its
  // min-content width into the track algorithm unless `width:0` keeps it out, and a column 1 that
  // swells shoves the whole button block apart. The buttons' own spacing is the independent
  // witness — this is the check that fails if `width:0` is ever dropped as redundant.
  ok(
    Math.abs(geo.vox.left - col1Right - geo.gap) <= 1.5,
    `the button columns are untouched — the gap between them is still ${geo.gap}px ${where}`,
  );

  // ── absent where the box has no board sensor ────────────────────────────
  // Every Windows box, and every Linux box whose SuperIO has no driver. The server answers None.
  const absent = await evaluate(cdp, withTemps(null));
  ok(absent.display === 'none', 'a box with no board sensor gets no readout at all, rather than dashes forever');

  // ── a partial answer still renders ──────────────────────────────────────
  const partial = await evaluate(cdp, withTemps({ mb: 37, warn: { mb: 60, vrm: 95 } }));
  ok(
    partial.display !== 'none' && partial.mb && !partial.vrm,
    'a board that publishes only the motherboard sensor still gets its one figure',
  );

  // ── the emphasis PAINTS, and per READOUT ────────────────────────────────
  // 🔴 ASSERTING THE CLASS IS NOT ASSERTING THE COLOR — a class-only spec passed once in this
  // header while nothing painted, because a theme rule outranked it. getComputedStyle, always.
  // The thresholds come from the SERVER's payload, never a literal here: sending `warn` at all
  // exists so this number has one home, and hardcoding 60/95 in the fixture would re-create the
  // copy it removes.
  const warn = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/system/stats'); const j = await r.json();
        return (j.temps || {}).warn;
    })()`,
  );
  ok(
    warn && typeof warn.mb === 'number' && typeof warn.vrm === 'number' && typeof warn.ram === 'number',
    `the server sends its own warning thresholds (got ${JSON.stringify(warn)})`,
  );
  const cool = await evaluate(cdp, withTemps({ mb: 37, vrm: 54, ram: 43, dimms: 2, warn }));
  const hotVrm = await evaluate(cdp, withTemps({ mb: 37, vrm: warn.vrm + 5, ram: 43, dimms: 2, warn }));
  const hotMb = await evaluate(cdp, withTemps({ mb: warn.mb + 5, vrm: 54, ram: 43, dimms: 2, warn }));
  const hotRam = await evaluate(cdp, withTemps({ mb: 37, vrm: 54, ram: warn.ram + 5, dimms: 2, warn }));

  ok(hotVrm.vrm.color !== cool.vrm.color, `a VRM past ${warn.vrm} °C is painted differently from one at 54`);
  // 🔴 PER-READOUT, NOT PER-ROW. The failure this prevents is the one the top system row already
  // had and had to be corrected for: a row-level class turns the board figure amber because the
  // VRM is hot, and then neither number means anything on its own.
  ok(hotVrm.mb.color === cool.mb.color, 'and the board figure beside it is left alone — the emphasis is per readout, not per row');
  ok(
    hotMb.mb.color !== cool.mb.color && hotMb.vrm.color === cool.vrm.color,
    'the same the other way round: a hot board does not repaint the VRM figure',
  );
  // 🔴 RAM's THRESHOLD IS THE MODULE'S OWN, NOT ONE OF OURS — runtime/temps.py reads temp1_max
  // off the DIMM rather than inventing a number, so this is also the check that the published
  // limit actually reached the page.
  ok(hotRam.ram.color !== cool.ram.color, `a DIMM past its own published ${warn.ram} °C limit warns`);
  ok(
    hotRam.mb.color === cool.mb.color && hotRam.vrm.color === cool.vrm.color,
    'and leaves the two board figures alone — three readouts, three independent ambers',
  );
  ok(cool.mb.color === cool.vrm.color, 'while an ordinary reading leaves both alone — a header that is always amber says nothing');

  // ── the tooltip carries what the numbers cannot ─────────────────────────
  ok(/motherboard/i.test(cool.title) && /VRM/.test(cool.title) && /RAM/.test(cool.title), 'the tooltip names all three sensors');
  ok(
    /hottest/i.test(cool.title) && /2 modules/.test(cool.title),
    'and says the RAM figure is the HOTTEST of the 2 modules, not their average — an average ' +
      'is the one figure a single overheating stick cannot move',
  );
  ok(
    /case|airflow|exhaust/i.test(cool.title),
    '🔴 and says what makes these two different from every other temperature here: they are ' +
      'about the case, not about a die reporting on itself',
  );
  ok(
    cool.title.includes(String(warn.mb)) && cool.title.includes(String(warn.vrm)),
    'and states both amber thresholds, from the server rather than from the stylesheet',
  );

  ok(pageErrors.length === 0, `the page threw nothing: ${pageErrors.join(' | ') || 'clean'}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`  FAIL harness: ${err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

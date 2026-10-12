// Vocalis 7.3.18 — the header's UPS line, in a REAL browser, fed by a REAL /system/stats.
//
// WHY a browser test when test_ups.py already covers the reader exhaustively: that file stops at
// the dict. Everything this one checks lives past it — `renderStrip`'s fan-out, the shape
// signature (which the UPS bit had to be added to, because unlike swap this line appears and
// disappears at RUNTIME), the `numDue` gate, the querySelectors, and two things no Python test
// can see at all:
//
//   1. WHERE IT LANDS. The battery line spans columns 1-2 and aligns with the bottom left
//      button. That differs from the `1/-1` span used by its three neighbors, and is invisible
//      to tests that do not measure the real page. test_strip_layout.py measures a copy that
//      nothing enforces against index.html.
//   2. WHETHER THE EMPHASIS PAINTS. 🔴 Asserting the class is not asserting the color: a
//      class-only spec passed once here while nothing painted, because a theme rule outranked
//      it. `OB` and `LB` are checked with getComputedStyle against the real stylesheet.
//
// Usage: node ups_line_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node ups_line_browser_spec.mjs <base-url> <chrome-path>');
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

// The deadline only bounds a HANG; a passing run never waits it out. 20 s (8 s on some calls) was too
// short with dozens of these specs running at once, so the default is 60 s (2026-10-12).
async function waitFor(cdp, expression, timeoutMs = 60000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // Resolve promise-valued expressions before coercion; a thenable is truthy immediately.
    // Retry transient page exceptions during repaint, but retain the last one for timeout output.
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
const profile = await mkdtemp(join(tmpdir(), 'vocalis-ups-cdp-'));
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
  // Wait for exit before removing the profile: `kill()` returns immediately, and open handles
  // can make recursive deletion fail with EBUSY. The bounded timer prevents a missed exit event
  // from hanging cleanup.
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

//: Drive the renderer directly with one UPS block, and report what the row printed and how it
//: was painted. Used for the states the stub server does not serve (OB, LB, absent).
//
//: 🔴 THE 560 ms WAIT IS LOad-BEARING AND ITS ABSENCE MADE FOUR OF THESE CHECKS VACUOUS.
//: `renderStrip` gates every value it writes behind `strip.numDue`, which is false unless
//: NUM_MS (500) has passed since the last paint — a figure rewritten faster than that cannot be
//: read, so the header deliberately throttles. Successive `renderStrip` calls over CDP land
//: ~10 ms apart, so without this the 2nd, 3rd and 4th fixtures were never painted at all and
//: every color comparison was reading the FIRST one against itself. Three of them failed,
//: which is how it was caught — but `heavy.color === onBatt.color` PASSED, and passed for the
//: worst possible reason: both were stale copies of the same untouched row.
//:
//: 2026-10-12: THE 560 ms IS NOW ADDED TO THE PAGE'S CLOCK, NOT SLEPT. The gate reads
//: `performance.now()`, so the wait was a guess about how long the machine takes to let 560 ms go by;
//: advancing the clock by 560 ms is exactly what the gate needs and cannot be short. And the module
//: is the page's OWN instance (`window.__VOCALIS__`), because the page loads a bundle and a fresh
//: `import()` builds a second copy: `stopIdleVram()` on that copy stopped nothing, so the real
//: sampler kept painting the stub while this read the DOM.
const withUps = (ups, cpu = '{pct:1, cores:32}') => `(async () => {
    const m = (window.__VOCALIS__ && window.__VOCALIS__['sys/hwstrip.js']) || (await import('/webui/js/sys/hwstrip.js'));
    m.stopIdleVram();                       // or the next 250 ms poll paints the stub back
    if (!window.__clockSkew) {
        window.__clockSkew = 0;
        const real = performance.now.bind(performance);
        performance.now = () => real() + window.__clockSkew;
    }
    window.__clockSkew += 560;                       // > NUM_MS, so numDue is true — see above
    m.renderStrip({gpus: [], cpu: ${cpu}, power: null, ups: ${JSON.stringify(ups)}});
    const el = document.getElementById('upsLine');
    const cs = getComputedStyle(el.querySelector('.ustat') || el);
    return { display: getComputedStyle(el).display, color: cs.color, weight: cs.fontWeight,
             text: el.innerText.replace(/\\s+/g, ' ').trim(), title: el.title,
             cls: el.className };
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
  ok(
    await waitFor(
      cdp,
      `document.getElementById('upsLine') &&
                           getComputedStyle(document.getElementById('upsLine')).display !== 'none'`,
    ),
    'the UPS line appears in the header when the server reports a UPS',
  );

  // 🔴 #ver BEFORE ANY GEOMETRY — the exact mid-boot hazard board_temp was fixed for, in this
  // same release. The UPS line is painted by hwstrip's poll and #ver by pollReady, two
  // DIFFERENT pollers, so "the UPS line appeared" does not imply the brand is filled — and the
  // brand's ~105px decides `.hdr-stack`'s left edge, which every left-overflow ink measurement
  // below hangs off. Measured mid-boot they describe a header no user ever sees: a false green
  // on a real collision on some runs, a spurious red on others.
  ok(
    await waitFor(cdp, `(document.getElementById('ver').textContent || '').trim().length > 0`, 45000),
    'the brand carries its version before any geometry is measured',
  );

  const txt = await evaluate(cdp, `document.getElementById('upsLine').innerText.replace(/\\s+/g, ' ').trim()`);
  ok(/\bUPS\b/.test(txt), `the row is labeled "UPS" (got ${JSON.stringify(txt)})`);
  ok(/\bOL\b/.test(txt), 'it prints the status token');
  ok(/\b47\s*%/.test(txt), 'the load percent');
  ok(/\b705\b/.test(txt) && /W/.test(txt), 'the derived watts');
  ok(/\bbatt\b/.test(txt) && /\b100\s*%/.test(txt), 'the battery charge');
  ok(/\b24\b/.test(txt) && /min/.test(txt), 'and the runtime in minutes, not seconds');
  // 🔴 THE RESOLUTION IS 15 W AND A DECIMAL WOULD CLAIM OTHERWISE. `ups.load` is an integer
  // percent of a 1500 W rating, so there is no reading between 705 and 720.
  ok(!/\d+\.\d+\s*W/.test(txt), 'the watts figure carries no decimal — its resolution is 15 W');

  // ── CONTROL PLACEMENT ─────────────────────────────────────────────
  // ⚠️ PLAIN NUMBERS, NOT DOMRects — CDP's returnByValue does not call DOMRect.toJSON, so a
  // rect comes back as {} and every comparison silently reads `undefined`.
  // ⚠️ THE BUTTONS ARE UNHIDDEN FIRST, AND WITHOUT THAT THIS MEASURES NOTHING. The stub server
  // reports no engine loaded and no GPUs, so `voxBtn` and `comfyBtn` are `display:none` and
  // hand back a 0×0 rect, which makes the alignment checks meaningless. Reveal all four controls
  // so the test measures the same layout shape used by the real header.
  const geo = await evaluate(
    cdp,
    `(() => {
        for (const id of ['cbBtn', 'freeBtn', 'voxBtn', 'comfyBtn']) {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        }
        const stackEl = document.querySelector('.hdr-stack');
        const cs = getComputedStyle(stackEl);
        const b = el => { const r = el.getBoundingClientRect();
                          return {top: r.top, bottom: r.bottom, left: r.left, right: r.right}; };
        const g = id => b(document.getElementById(id));
        // ⚠️ THE UPS ROW'S OWN RECT IS ZERO-WIDTH BY DESIGN — width:0 is what keeps it out of
        // the track algorithm - so its border box says nothing about where the text is. The
        // CONTENT extent is the union of its children, and that is what has to be measured.
        // NO BACKTICKS IN HERE: this is inside a template literal, and one of them ends the
        // string and turns the remainder of the file into a parse error 25 lines later.
        const kids = [...document.getElementById('upsLine').children]
                        .map(c => c.getBoundingClientRect());
        const upsInk = kids.length
            ? { top: Math.min(...kids.map(r => r.top)), bottom: Math.max(...kids.map(r => r.bottom)),
                left: Math.min(...kids.map(r => r.left)), right: Math.max(...kids.map(r => r.right)) }
            : null;
        return { pow: g('powerLine'), ups: g('upsLine'), vox: g('voxBtn'), comfy: g('comfyBtn'),
                 cb: g('cbBtn'), free: g('freeBtn'), stack: b(stackEl),
                 // 🔴 THE CHILDREN, NOT THE CONTAINER (8.0.1b), which is the same correction
                 // board_temp_browser_spec.mjs made and for a sharper reason here. .hdr-brand is
                 // now align-self:stretch — that is what lets Log out hang off the header's
                 // bottom edge onto this very row — so its rect spans the WHOLE header height by
                 // construction, and every left-overflow line now "overlaps" a box in which the
                 // brand paints nothing. Overlap is about ink, so measure ink: h1, the version,
                 // the edition tag and the button, each on its own.
                 ink: upsInk,
                 brand: [...document.querySelector('.hdr-brand').children].map(b),
                 // The USED track sizes, so a mismatch can be attributed to the right thing:
                 // a track wider than its button means a spanning row inflated it.
                 tracks: cs.gridTemplateColumns, gap: parseFloat(cs.columnGap) };
    })()`,
  );
  // This line owns column 1, ends flush with `Free Vocalis VRAM`, and shares the power row.
  const where =
    `[ups ${geo.ups.left.toFixed(1)}–${geo.ups.right.toFixed(1)} · ` +
    `pow ${geo.pow.left.toFixed(1)}–${geo.pow.right.toFixed(1)} · ` +
    `stack ${geo.stack.left.toFixed(1)}–${geo.stack.right.toFixed(1)} · ` +
    `free ${geo.free.left.toFixed(1)}–${geo.free.right.toFixed(1)} · ` +
    `tracks ${geo.tracks} gap ${geo.gap}]`;
  ok(Math.abs(geo.ups.top - geo.pow.top) <= 2, `it shares the power line's row rather than taking one of its own ${where}`);
  ok(geo.ups.right <= geo.pow.left + 0.5, `and does not land on top of it — UPS left, power right ${where}`);
  // Align to the button edge rather than the track edge. `justify-self:end` lands
  // on the column-1 TRACK edge, and a track is only as narrow as its widest item — so if this
  // line inflates column 1 it stops short of `Free Vocalis VRAM`. Measure the button, not the track.
  ok(
    Math.abs(geo.ups.right - Math.max(geo.cb.right, geo.free.right)) <= 1.5,
    `its right edge is the FIRST button column's — Free Vocalis VRAM, not Stop ComfyUI ` + `${where}`,
  );
  ok(geo.ups.right < geo.stack.right - 5, 'and NOT flush with the stack — that is the distinction from the lines above it');
  // 🔴 IT OVERFLOWS LEFT, OUT OF THE STACK, AND THAT IS THE DESIGN RATHER THAN A BUG. The line
  // is ~225px and the column is ~149px, so it cannot both end on the button's edge and start
  // inside the stack. It runs left under `.hdr-brand`; its final row passes through the empty
  // space below the two-line brand. Checking that it stays inside the stack would reject this layout.
  ok(
    geo.ink && Math.abs(geo.ink.right - Math.max(geo.cb.right, geo.free.right)) <= 1.5,
    `the printed text itself ends on that edge, not just the zero-width box ${where}`,
  );
  ok(
    geo.ink && geo.ink.left < geo.stack.left - 5,
    `and reaches LEFT past the stack, under the brand, rather than growing column 1 ` +
      `(ink ${geo.ink && geo.ink.left.toFixed(1)}–${geo.ink && geo.ink.right.toFixed(1)}) ${where}`,
  );
  // Measure clearance from the brand because ⎋ Log out shares this row; a full row of vertical
  // clearance is no longer available. The horizontal gap must remain positive at this width.
  // ⚠️ AND IT IS NOT STRUCTURAL. This text is zero-width at column 1's right edge, so where it
  // BEGINS is (stack.left + track1 − inkWidth) — every term of which moves on its own: the
  // brand's width sets stack.left, the widest button sets track1, and the UPS string itself
  // grows with a longer runtime or an LB status. Nothing keeps the gap open, which is exactly
  // why it is measured here per element rather than reasoned about once.
  const hits = (geo.ink ? geo.brand : []).filter(
    el => geo.ink.left < el.right && geo.ink.right > el.left && geo.ink.top < el.bottom && geo.ink.bottom > el.top,
  );
  ok(
    hits.length === 0,
    `and clears every line of the brand — INCLUDING ⎋ Log out, which now shares this row — ` +
      `rather than printing over it (${hits.length} hit(s)${
        hits.length
          ? ': ' +
            hits.map(el => `${el.left.toFixed(1)}-${el.right.toFixed(1)} x ` + `${el.top.toFixed(1)}-${el.bottom.toFixed(1)}`).join(' | ')
          : ''
      }, ink ` +
      `${geo.ink && geo.ink.left.toFixed(1)}–${geo.ink && geo.ink.right.toFixed(1)} x ` +
      `${geo.ink && geo.ink.top.toFixed(1)}–${geo.ink && geo.ink.bottom.toFixed(1)})`,
  );
  // 🔴 AND IT MUST NOT HAVE MOVED THE BUTTONS. A `grid-column` span over `auto` tracks feeds
  // the item's own min-content width into the track sizing algorithm, so a long nowrap line
  // spanning columns 1-2 can WIDEN those columns and shove the whole button block apart. That
  // is a visible regression in the surrounding header, and it is invisible to every check above —
  // all of which measure the UPS line against tracks it may
  // itself have stretched. The buttons' own spacing is the independent witness.
  // ⚠️ AGAINST THE WIDEST ITEM IN COLUMN 1, NOT THE FIRST ONE. `justify-items:start` leaves
  // the narrower button short of its own track's edge — "Load Chatterbox" sits 15 px inside a
  // column sized by "Free Vocalis VRAM" — and measuring from it reads that ordinary slack as
  // 15 px of stretch. The track edge is where the WIDER of the two ends.
  const col1Right = Math.max(geo.cb.right, geo.free.right);
  const btnGap = geo.vox.left - col1Right;
  ok(
    Math.abs(btnGap - geo.gap) <= 1.5,
    `the UPS line has not stretched the button columns — the gap between them is still the ` +
      `grid's ${geo.gap} px (got ${btnGap.toFixed(1)}) ${where}`,
  );

  // ── absent where there is no UPS ────────────────────────────────────────
  // Every box without NUT, and every state runtime/ups.py refuses to render: stale reading,
  // missing field, and the OB-with-zero-load case where the unit's output is switched off.
  // The server answers None for all of them, so the page sees exactly this.
  const absent = await evaluate(cdp, withUps(null));
  ok(absent.display === 'none', 'a box with no UPS gets no line at all, rather than a row of dashes forever');

  // ── the emphasis PAINTS, not merely classes ─────────────────────────────
  // 🔴 ASSERTING THE CLASS IS NOT ASSERTING THE COLOR. A class-only spec passed here once
  // while nothing painted. These read getComputedStyle against the real stylesheet.
  // `warn_pct` is read off the row the SERVER served, not typed in here — the whole point of
  // sending it is that this threshold has one home, and a literal 85 in the fixture would
  // quietly re-create the copy it exists to remove.
  const warnPct = await evaluate(
    cdp,
    `(async () => {
        const r = await fetch('/system/stats'); const j = await r.json();
        return (j.ups || {}).warn_pct;
    })()`,
  );
  ok(typeof warnPct === 'number' && warnPct > 0 && warnPct < 100, `the server sends its own load-warning threshold (got ${warnPct})`);
  const base = {
    load_pct: 47,
    w: 705,
    batt_pct: 100,
    runtime_s: 1440,
    input_v: 123.3,
    nominal_w: 1500,
    model: 'PR1500LCD',
    charging: false,
    replace_batt: false,
    age_s: 1.2,
    warn_pct: warnPct,
  };
  const online = await evaluate(cdp, withUps({ ...base, status: 'OL' }));
  const onBatt = await evaluate(cdp, withUps({ ...base, status: 'OB' }));
  const lowBatt = await evaluate(cdp, withUps({ ...base, status: 'LB', batt_pct: 8, runtime_s: 240 }));
  const over = warnPct + 7; // comfortably past it, whatever it is
  const heavy = await evaluate(cdp, withUps({ ...base, status: 'OL', load_pct: over, w: over * 15 }));

  ok(onBatt.color !== online.color, 'ON BATTERY is painted differently from online — a shutdown timer is running');
  ok(
    lowBatt.color !== online.color && lowBatt.color !== onBatt.color,
    'LOW BATTERY is painted differently again — one step past the warning',
  );
  ok(Number(lowBatt.weight) >= 600, 'and is bolder, because it is the one state here that means data loss is imminent');
  ok(
    heavy.color === onBatt.color,
    `${over}% load warns in the same amber as on-battery — that is the condition that made ` +
      'the old 865 W unit alarm, and the reason this UPS was bought',
  );
  ok(online.color !== heavy.color, 'while a normal load is left alone — a header that is always amber says nothing');

  // ── the tooltip carries what the number cannot ──────────────────────────
  ok(
    /wall draw/i.test(online.title),
    '🔴 the tooltip says this IS wall draw — the power line above says it is NOT, and the ' + 'pair only makes sense if both say so',
  );
  ok(/15 W/.test(online.title), 'and states the 15 W step, so the figure is not read as precise to the watt');
  ok(
    /sustained/i.test(online.title) && /spike|4 Hz/i.test(online.title),
    'and that it cannot show the sub-second spikes the power line is sampled at 4 Hz for',
  );
  ok(/300-second|countdown/i.test(onBatt.title), 'on battery it says a countdown to poweroff is running — the reason for the emphasis');

  ok(pageErrors.length === 0, `the page threw nothing: ${pageErrors.join(' | ') || 'clean'}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`  FAIL harness: ${err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);

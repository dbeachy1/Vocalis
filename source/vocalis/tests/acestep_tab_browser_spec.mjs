// Exercise the ACE-Step tab in headless Chrome. Checks drive controls and assert their effects;
// element presence alone cannot prove a click handler was attached.
// Do not place backticks inside evaluate() template literals: they terminate the JavaScript source.
//
// Usage: node acestep_tab_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALL_FETCH_LOG, fetchCount, fetchCountAtLeast } from './_specwait.mjs';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node acestep_tab_browser_spec.mjs <base-url> <chrome-path>');
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

async function waitFor(cdp, expression, timeoutMs = 25000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // Await promise-valued expressions so polling waits for the page result, not the Promise
    // object. Transient page errors during repaint are retried; persistent errors are reported
    // when the wait times out.
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

// 🔴 "N POLLS LATER" IS COUNTED IN POLLS, NOT IN SECONDS. Three places here used to `sleep(5200)` to
// let a poll repaint the page ("longer than one 4 s poll", "longer than two full 2 s poll cycles"),
// which is that many polls on an idle machine and fewer on a loaded one. The fetch log records a
// response BEFORE the page paints from it, so this waits for `repaints + 1` more responses from
// the route: when the last one arrives, the earlier ones have certainly been painted.
//   `/acestep/status` is polled by sys/acestep.js every 4 s (rows repaint from it);
//   `/acestep/jobs` and `/acestep/library` by ace/tray.js every 2 s (the candidate tray and the library).
// Returns false if the poll stopped, which fails the check that calls this rather than passing it.
const repaintsLater = async (cdp, route, repaints) => {
  const before = await evaluate(cdp, fetchCount(route, 'GET'));
  return waitFor(cdp, fetchCountAtLeast(route, before + repaints + 1, 'GET'), 45000);
};

const profile = await mkdtemp(join(tmpdir(), 'vocalis-ace-cdp-'));
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
  // Wait for Chrome to exit before removing its profile. Windows may retain file handles briefly
  // after the exit event, so cleanup retries transient removal failures.
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

try {
  const port = await devtoolsPort();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page') || list[0];
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const thrown = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      thrown.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: baseUrl });
  ok(await waitFor(cdp, 'window.__bootDone === true', 45000), 'the page finished booting');
  await evaluate(cdp, INSTALL_FETCH_LOG);

  // ── the tab opens ────────────────────────────────────────────────────────
  // ⚠️ Through the REAL tab button, not by unhiding the panel: the tab handlers are what start
  // the tray poller and paint the card rows, and a panel revealed by hand skips all of it.
  await evaluate(cdp, `document.querySelector('#tabs button[data-tab="acestep"]').click()`);
  ok(
    await waitFor(cdp, `getComputedStyle(document.querySelector('section[data-panel="acestep"]')).display !== 'none'`),
    'pressing the ACE-Step tab button opens its panel',
  );

  // One row per authorized card, painted from /acestep/status.
  ok(await waitFor(cdp, `document.querySelectorAll('#aceCards .acecard').length === 2`), 'both authorized cards get a row');

  // ── CARD CONTROLS TRACK INVENTORY, LOAD STATE, AND POLLING ────────────────────────────────
  // Cover model inventory after service startup, load eligibility, unloading only an occupied
  // card, and selection persistence across the 4-second status repaint.
  {
    const row0 = `document.querySelector('#aceCards .acecard[data-device="cuda:0"]')`;
    const sel0 = `${row0}.querySelector('.acemodel')`;

    // The dropdown is populated at all — the empty-inventory bug left exactly one "—".
    const optCount = await evaluate(cdp, `${sel0}.options.length`);
    ok(optCount === 3, `the model dropdown offers the inventory, not a placeholder (${optCount})`);

    // cuda:0 holds turbo, so Load has nothing to do and says so.
    ok(
      await evaluate(cdp, `${row0}.querySelector('.aceload').disabled === true`),
      'Load is disabled while the chosen model is the one already loaded',
    );

    // Select the other model, then survive a repaint.
    // The status poll is 4 s and repaints every row from `b.model || inv.default`, so a
    // selection that lives only in the DOM is gone by the next tick. Waiting longer than one
    // full poll is the whole point of this assertion — a check that ran immediately passed
    // on the broken build.
    await evaluate(
      cdp,
      `(() => { const s = ${sel0};
            s.value = 'acestep-v15-xl-sft';
            s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
    ok(await evaluate(cdp, `${sel0}.value === 'acestep-v15-xl-sft'`), 'choosing a different model takes effect');
    ok(
      await evaluate(cdp, `${row0}.querySelector('.aceload').disabled === false`),
      'and Load becomes live, because the choice now differs from what is loaded',
    );

    // One full status repaint is waited for (it was `sleep(5200)`, "longer than one 4 s poll").
    // `repaints` of 1 means two more /acestep/status responses: the first may have been in flight
    // before the choice; the second proves the page finished painting from the first.
    ok(
      (await repaintsLater(cdp, '/acestep/status', 1)) && (await evaluate(cdp, `${sel0}.value === 'acestep-v15-xl-sft'`)),
      'the selection SURVIVES a status repaint — the 4 s tick used to revert it to turbo',
    );

    // Unload reflects whether the card is holding a model.
    // cuda:0 has a model, so it is live here. The disabled case is asserted by
    // test_the_unload_button_is_dead_on_a_card_holding_nothing, which runs against a stub
    // reporting model_loaded: false to cover the empty-card case.
    ok(await evaluate(cdp, `${row0}.querySelector('.aceunload').disabled === false`), 'Unload is live on a card that is holding a model');

    // Pressing Load requests the load.
    // The bug was that nothing was wired to anything pressable at all. Swapping a loaded
    // model raises the confirm first, so drive that too and take the destructive branch.
    await evaluate(cdp, `${row0}.querySelector('.aceload').click()`);
    ok(
      await waitFor(
        cdp,
        `document.getElementById('overlay').classList.contains('on')
             && /swap the model/i.test(document.getElementById('mTitle').textContent)`,
        8000,
      ),
      'Load on a card holding something warns before dropping it',
    );
    await evaluate(
      cdp,
      `[...document.querySelectorAll('#overlay button')]
            .find(b => /^Load /.test(b.textContent)).click()`,
    );
    ok(
      await waitFor(
        cdp,
        `/loading/i.test(document.querySelector('#aceCards .acecard[data-device="cuda:0"] '
                                                 + '.acestate').textContent)`,
        8000,
      ),
      'confirming it reports the load in flight — i.e. /acestep/init was actually called',
    );

    // Measure card boxes after layout. An extra grid child can create an implicit row and an
    // auto-sized track can widen the device column; bounding boxes catch shifts that markup
    // and handler assertions cannot.
    ok(
      await waitFor(
        cdp,
        `(document.querySelector('#aceCards .acecard[data-device="cuda:0"] .acemodel')
              ?.getBoundingClientRect().height || 0) > 0`,
        8000,
      ),
      'the card row has a laid-out box before its geometry is measured',
    );
    const geo = await evaluate(
      cdp,
      `(() => {
            const r = document.querySelector('#aceCards .acecard[data-device="cuda:0"]');
            const at = e => { const b = e.getBoundingClientRect();
                              return { x: Math.round(b.x), y: Math.round(b.y) }; };
            const lora = r.querySelector('.acelora');
            return { dev: at(r.querySelector('.acedev')), sel: at(r.querySelector('.acemodel')),
                     lora: lora ? at(lora) : null }; })()`,
    );
    ok(
      geo.sel.x - geo.dev.x <= 120,
      `the model dropdown sits beside its device label, not pushed right by the LoRA box ` +
        `(${geo.sel.x - geo.dev.x}px — it was ~250 with the cell in column 1)`,
    );
    ok(geo.lora !== null, 'the LoRA cell IS offered on a card that holds a model — that is when its routes work');
    ok(geo.lora && geo.lora.y > geo.sel.y, 'and it is a SECOND ROW, below the model dropdown rather than beside it');
    ok(
      geo.lora && Math.abs(geo.lora.x - geo.sel.x) <= 2,
      `starting at the dropdown's own x, so the card reads as one block ` + `(${geo.lora && geo.lora.x} vs ${geo.sel.x})`,
    );
  }

  // An empty form must show the "Nothing to generate" message in the shared #overlay. Checking
  // that the overlay is visible proves the click handler ran; a selector could match a hidden modal.
  await evaluate(cdp, `document.getElementById('aceGenBtn').click()`);
  const refused = await waitFor(
    cdp,
    `document.getElementById('overlay').classList.contains('on')
         && /nothing to generate/i.test(document.getElementById('mTitle').textContent)`,
    8000,
  );
  ok(
    refused,
    'Generate with an empty form raises "Nothing to generate" — i.e. the click ' +
      'handler is ATTACHED. This is the assertion the shipped bug failed.',
  );
  await evaluate(cdp, `document.querySelector('#mActs button').click()`);
  ok(
    await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`, 5000),
    'and the modal closes again, so the next press is not clicking through a veil',
  );

  // Drive each mode and assert the controls painted by `paintModeState`.
  const mode = id => `[...document.querySelectorAll('#aceModes button')]` + `.find(b => /${id}/i.test(b.textContent))`;
  const shown = sel => `getComputedStyle(document.getElementById('${sel}')).display !== 'none'`;

  // At the tested 1920px viewport, the mode buttons fit on one row. Distinct offsetTops checks
  // their actual layout rather than the wrapper's CSS declaration.
  const modeRows = await evaluate(cdp, `new Set([...document.querySelectorAll('#aceModes button')].map(b => b.offsetTop)).size`);
  ok(modeRows === 1, `every mode button is on ONE line (${modeRows} lines)`);

  // The Mode heading governs the meaning of the other fields, so it needs stronger visual
  // hierarchy than an ordinary field label. Check computed styles rather than a CSS class.
  const hd = await evaluate(
    cdp,
    `(() => {
        const l = document.querySelector('label.acemodehd'), c = getComputedStyle(l);
        const t = getComputedStyle(document.querySelector('#aceForm label:not(.acemodehd)'));
        return { size: parseFloat(c.fontSize), weight: Number(c.fontWeight), color: c.color,
                 plainSize: parseFloat(t.fontSize), plainColor: t.color }; })()`,
  );
  ok(hd.size > hd.plainSize, `the Mode heading is BIGGER than an ordinary field label ` + `(${hd.size}px vs ${hd.plainSize}px)`);
  ok(
    hd.color !== hd.plainColor && hd.weight >= 700,
    `and brighter and bolder than one (${hd.color} vs ${hd.plainColor}, weight ${hd.weight})`,
  );

  // Center the two buttons on the input. Comparing centers keeps the alignment check meaningful
  // if either control's height or padding changes.
  const mid = await evaluate(
    cdp,
    `(() => {
        const c = e => { const b = e.getBoundingClientRect(); return b.y + b.height / 2; };
        return { input: c(document.getElementById('aceQuery')),
                 write: c(document.getElementById('aceWrite')),
                 tidy: c(document.getElementById('aceTidy')) }; })()`,
  );
  ok(
    Math.abs(mid.write - mid.input) <= 2 && Math.abs(mid.tidy - mid.input) <= 2,
    `✨ Write it for me and ✨ Tidy up are centered on the Describe box, not hung off its bottom ` +
      `(${(mid.write - mid.input).toFixed(1)}px, ${(mid.tidy - mid.input).toFixed(1)}px)`,
  );
  // The first mode is a from-scratch writing action; "Custom" is ambiguous because Vocalis has
  // no custom-versus-Simple distinction.
  ok(
    await evaluate(
      cdp,
      `!/\\bCustom\\b/.test(document.getElementById('aceModes').textContent)
         && ${mode('Write song')} !== undefined`,
    ),
    'the from-scratch mode is called Write song, and the word Custom is gone from the selector',
  );

  await evaluate(cdp, `${mode('Remix')}.click()`);
  ok(
    await waitFor(cdp, shown('aceSourceRow'), 5000),
    '🔴 pressing Remix reveals the Source row — the mode buttons are WIRED, not decorative',
  );
  ok(
    await evaluate(cdp, `document.getElementById('aceBpm').disabled === true`),
    'and Remix makes BPM inert, because the source decides it (design §3)',
  );
  ok(await evaluate(cdp, shown('aceCoverWrap')), 'Keep original is offered for Remix — the creative dial of a remix');

  await evaluate(cdp, `${mode('Repaint')}.click()`);
  ok(await waitFor(cdp, shown('aceRepaintFrom'), 5000), 'Repaint swaps in the From/To range');
  ok(await evaluate(cdp, `!(${shown('aceCoverWrap')})`), 'and drops Keep original, which is a remix control rather than a repaint one');

  await evaluate(cdp, `${mode('Extract')}.click()`);
  ok(await waitFor(cdp, shown('aceTrackRow'), 5000), 'Extract reveals the track picker');
  ok(
    await evaluate(cdp, `document.querySelectorAll('#aceTracks input[type=radio]').length === 12`),
    '🔴 as RADIOS — extract sends track_name, ONE name that upstream calls .upper() on, so a ' +
      'multi-select here would send a list into .upper()',
  );

  await evaluate(cdp, `${mode('Complete')}.click()`);
  ok(
    await waitFor(cdp, `document.querySelectorAll('#aceTracks input[type=checkbox]').length === 12`, 5000),
    '🔴 and Complete makes them CHECKBOXES — it sends track_classes, a LIST that gets joined',
  );

  await evaluate(cdp, `${mode('Retake')}.click()`);
  ok(await waitFor(cdp, shown('aceRetakeRow'), 5000), 'Retake reveals the seed/variance row');
  ok(
    await evaluate(cdp, `!(${shown('aceSourceRow')})`),
    '🔴 and asks for NO source — Retake perturbs the noise of a song described by the same ' +
      'words, which is why it is the one source-ish mode that needs no audio',
  );

  // A source mode without a selected source must surface the server rejection in the UI.
  await evaluate(
    cdp,
    `(() => {
        document.getElementById('aceCaption').value = 'alternative metal';
        document.getElementById('aceCaption').dispatchEvent(new Event('input', {bubbles:true}));
    })()`,
  );
  await evaluate(cdp, `${mode('Remix')}.click()`);
  await evaluate(cdp, `document.getElementById('aceGenBtn').click()`);
  ok(
    await waitFor(
      cdp,
      `document.getElementById('overlay').classList.contains('on')
         && /work from|source/i.test(document.getElementById('mBody').textContent)`,
      10000,
    ),
    '🔴 Remix with no Source is REFUSED with a sentence, not rendered as an ordinary song',
  );
  await evaluate(cdp, `document.querySelector('#mActs button').click()`);
  await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`, 5000);

  // Back to Write song, and everything the other modes added goes away again.
  await evaluate(cdp, `${mode('Write song')}.click()`);
  ok(
    await waitFor(
      cdp,
      `!(${shown('aceSourceRow')}) && !(${shown('aceTrackRow')})
                            && !(${shown('aceRetakeRow')})`,
      5000,
    ),
    'Write song puts the card back — no stranded rows from a mode the user left',
  );
  ok(
    await evaluate(cdp, `document.getElementById('aceBpm').disabled === false`),
    'and BPM is live again, so the dimming is a MODE state and not a one-way trip',
  );

  // Verify the page's ace:cardmodels dispatch and payload, including each loaded model's task
  // map. Synthetic consumer events below do not replace this producer-side assertion.
  const cm = await evaluate(
    cdp,
    `new Promise(res => {
        const t = setTimeout(() => res(null), 12000);
        document.addEventListener('ace:cardmodels', e => {
            clearTimeout(t);
            res({ models: (e.detail && e.detail.models) || [],
                  tasks: Object.values((e.detail && e.detail.byDevice) || {})
                      .flatMap(i => Object.entries((i && i.tasks) || {}))
                      .reduce((m, kv) => (m[kv[0]] = kv[1], m), {}) });
        }, { once: true });
    })`,
  );
  ok(
    cm && cm.models.includes('acestep-v15-turbo') && cm.models.includes('acestep-v15-xl-base'),
    '🔴 the page itself dispatches ace:cardmodels naming the LOADED models — the producer is ' + 'wired, not dead code',
  );
  ok(
    cm &&
      Array.isArray(cm.tasks['acestep-v15-xl-base']) &&
      cm.tasks['acestep-v15-xl-base'].includes('extract') &&
      cm.tasks['acestep-v15-xl-base'].includes('lego') &&
      cm.tasks['acestep-v15-xl-base'].includes('complete') &&
      Array.isArray(cm.tasks['acestep-v15-xl-sft']) &&
      cm.tasks['acestep-v15-xl-sft'].includes('text2music') &&
      !cm.tasks['acestep-v15-xl-sft'].includes('extract') &&
      !cm.tasks['acestep-v15-xl-sft'].includes('lego') &&
      !cm.tasks['acestep-v15-xl-sft'].includes('complete') &&
      Array.isArray(cm.tasks['acestep-v15-turbo']) &&
      !cm.tasks['acestep-v15-turbo'].includes('extract'),
    'and carries the per-model task map the gate feeds on (extract, lego and complete on xl-base ONLY: the publisher lists xl-sft as Standard, whatever the engine claims)',
  );

  // Verify that mode availability follows the loaded models' task map. Unsupported tasks must
  // not be offered for a card that cannot run them. Synthetic events here test the consumer;
  // the producer is pinned above on the page's own dispatch.
  ok(await evaluate(cdp, `${mode('Extract')}.disabled === false`), 'Extract is enabled while the cards report supporting it');
  await evaluate(
    cdp,
    `document.dispatchEvent(new CustomEvent('ace:cardmodels', { detail: {
        models: ['acestep-v15-turbo'],
        byDevice: { 'cuda:0': {
            tasks: { 'acestep-v15-turbo': ['text2music', 'repaint', 'cover', 'cover-nofsq'],
                     'acestep-v15-xl-sft': ['text2music', 'repaint', 'cover', 'cover-nofsq'],
                     'acestep-v15-xl-base': ['text2music', 'repaint', 'cover', 'cover-nofsq', 'extract', 'lego', 'complete'] },
            task_models: { extract: ['acestep-v15-xl-base'], lego: ['acestep-v15-xl-base'],
                           complete: ['acestep-v15-xl-base'] } } } } }))`,
  );
  ok(
    await waitFor(cdp, `${mode('Extract')}.disabled === true`, 5000),
    '🔴 a card that cannot run extract DISABLES the button — the gating is wired, not dead code',
  );
  ok(
    await evaluate(cdp, `${mode('Extract')}.title === "Extract needs the acestep-v15-xl-base model. Load it from this card's model menu."`),
    'and says which model to load, in one sentence, because a mode that merely vanished would be ' +
      'indistinguishable from one this build never had',
  );
  ok(
    await evaluate(cdp, `${mode('Replace')}.disabled === true && ${mode('Complete')}.disabled === true`),
    'Replace and Complete are disabled too: only xl-base lists all three editing tasks',
  );
  // xl-sft LOADED is the same story: the engine claims it can extract, the publisher says it cannot, and
  // the server's narrowed list is what the page receives.
  await evaluate(
    cdp,
    `document.dispatchEvent(new CustomEvent('ace:cardmodels', { detail: {
        models: ['acestep-v15-xl-sft'],
        byDevice: { 'cuda:0': {
            tasks: { 'acestep-v15-xl-sft': ['text2music', 'repaint', 'cover', 'cover-nofsq'],
                     'acestep-v15-xl-base': ['text2music', 'repaint', 'cover', 'cover-nofsq', 'extract', 'lego', 'complete'] },
            task_models: { extract: ['acestep-v15-xl-base'] } } } } }))`,
  );
  ok(
    await waitFor(
      cdp,
      `${mode('Extract')}.disabled === true && /needs the acestep-v15-xl-base model/.test(${mode('Extract')}.title)
         && ${mode('Write song')}.disabled === false`,
      5000,
    ),
    '🔴 with xl-sft loaded Extract is disabled with the same sentence, and normal generation (Write song) is unaffected',
  );
  ok(
    await evaluate(cdp, `${mode('Remix')}.disabled === false`),
    'while Remix stays live — turbo supports cover, so the gate is per TASK and not a blanket',
  );

  // Put the full inventory back so the rest of the spec runs against every mode.
  await evaluate(
    cdp,
    `document.dispatchEvent(new CustomEvent('ace:cardmodels', { detail: {
        models: ['acestep-v15-xl-base'],
        byDevice: { 'cuda:0': { tasks: { 'acestep-v15-xl-base': ['text2music', 'repaint', 'cover',
            'cover-nofsq', 'extract', 'lego', 'complete'] } } } } }))`,
  );
  await waitFor(cdp, `${mode('Extract')}.disabled === false`, 5000);

  // ── fill it in and generate for real ─────────────────────────────────────
  await evaluate(
    cdp,
    `(() => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
        };
        set('aceTitle', 'Sample Track One');
        set('aceCaption', 'alternative metal, hard rock, driving drums');
        set('aceLyrics', '[verse]\\nthe embers hold their shape');
    })()`,
  );
  // ── save it as a template FIRST, so the song is attributed to one ────────
  // Save before generation because `template_id` travels on the generate
  // request, so a song generated before any template exists is attributed to nothing — and the
  // library filter below would then pass for the wrong reason (an unfiltered list also
  // "contains the song"). Save first, generate second, and the filter has something to prove.
  await evaluate(cdp, `document.getElementById('aceTplSave').click()`);
  ok(
    await waitFor(
      cdp,
      `[...document.getElementById('aceTemplate').options]
            .some(o => /Sample Track One/.test(o.textContent))`,
      10000,
    ),
    'Save as… puts the song template in the picker',
  );
  // The saved template becomes selected so the next Generate carries its `template_id`
  // and everything downstream of it is testing the unattributed path.
  const selectedAfterSave = await evaluate(
    cdp,
    `(() => {
        const s = document.getElementById('aceTemplate');
        return (s.options[s.selectedIndex] || {}).textContent || '';
    })()`,
  );
  ok(
    /Sample Track One/.test(selectedAfterSave),
    `saving selects the template it just made (picker reads ${JSON.stringify(selectedAfterSave)})`,
  );

  await evaluate(cdp, `document.getElementById('aceGenBtn').click()`);

  // Expect two candidates, one per card (§4.5.3). One would mean fan-out is broken; with a
  // single stub backend that would have been indistinguishable from working — which is why the
  // harness stubs TWO.
  ok(await waitFor(cdp, `document.querySelectorAll('#aceTray .acerow').length === 2`, 20000), 'one press produced one candidate per card');

  // The tray polls every 2s; the stub finishes after ~1s.
  ok(
    await waitFor(cdp, `document.querySelectorAll('#aceTray .acerow audio').length === 2`, 25000),
    'both candidates finish and offer an <audio> to listen to',
  );

  // ── The candidates tray shares the library grid and its layout contract ────────────────
  //
  // `#aceTray` and `#aceLibrary` share one rule in acestep.css: the same four tracks, `.aceacts`
  // and `.acemeta` cells. The library's three global buttons had been parked in the fourth
  // cell, that track is auto-sized so it took the widest cell in the COLUMN, and every song row
  // carried ~230px of dead stripe funded by the two fr tracks. The fix also put
  // `min-width:max-content` on `.aceacts` and `.acemeta`, and BOTH lists now depend on it.
  //
  // Measure both consumers of the shared rule so the tray remains covered alongside the library.
  //
  // The gap IS the padding and nothing else: `.acerow>*` carries `padding:4px 12px 4px 0` and the
  // last cell of a row gets 14px on the right, so a correct row lands at 14 and the defect landed
  // at ~230. Measure a finished row: a queued row's one-button cell can have a large gap while
  // sharing column widths with completed rows.
  const trayTail = await evaluate(
    cdp,
    `(() => { const row = [...document.querySelectorAll('#aceTray .acerow')].find(r => r.querySelector('audio'));
        if (!row) return {err: 'no finished candidate row'};
        const acts = row.querySelector('.aceacts');
        const kids = acts.children, last = kids[kids.length - 1];
        const a = acts.getBoundingClientRect(), l = last.getBoundingClientRect();
        return {gap: Math.round(a.right - l.right), cellW: Math.round(a.width),
                lastLabel: (last.textContent || '').trim()}; })()`,
  );
  ok(
    !trayTail.err && trayTail.gap >= 0 && trayTail.gap <= 16,
    `a finished candidate's actions reach the right edge of their own cell too (gap ${trayTail.gap}px ` +
      `of ${trayTail.cellW}px, after ${JSON.stringify(trayTail.lastLabel)})`,
  );

  // ── THE PLAYER MUST SURVIVE THE 2 s REPAINT ──────────────────────────────────────────────
  // The tray polls every 2 s. Replacing rows with `innerHTML` recreates each audio element and
  // resets playback, so this stamps and compares the same DOM node across a repaint.
  // Element presence after a tick is not enough; a replacement would also exist.
  // This stamps the specific node and checks the SAME node is still there, which is the only
  // form of the question that can fail on the broken build.
  await evaluate(
    cdp,
    `(() => {
        document.querySelectorAll('#aceTray audio').forEach((a, i) => { a.__keep = 'k' + i; });
        return true; })()`,
  );
  // Two full tray repaints are waited for by counting /acestep/jobs responses (this was
  // `sleep(5200)`, "longer than two full 2 s poll cycles").
  const twoTrayRepaints = await repaintsLater(cdp, '/acestep/jobs', 2);
  const kept =
    twoTrayRepaints &&
    (await evaluate(
      cdp,
      `(() => {
        const a = [...document.querySelectorAll('#aceTray audio')];
        return a.length && a.every(x => typeof x.__keep === 'string'); })()`,
    ));
  ok(kept, 'the <audio> elements SURVIVE the tray repaint — the same DOM nodes, not fresh ones');

  // The proxy may return bytes the browser cannot play. Check the media element's decode state,
  // not only the row or HTTP response; the fixture is a real FLAC generated by ffmpeg.
  const decoded = await waitFor(
    cdp,
    `(() => {
        const a = document.querySelector('#aceTray .acerow audio');
        if (!a) return false;
        if (a.error) throw new Error('audio element reported error code ' + a.error.code);
        if (a.readyState >= 1) return true;
        a.load();
        return false;
    })()`,
    20000,
  );
  ok(decoded, 'the proxied candidate is real audio the browser can decode, not just 200 bytes');

  // ── SEEKABILITY IS SEPARATE FROM PLAYABILITY ──────────────────────────────────────────────
  // A plain 200 without `Accept-Ranges` can play successfully while seeking still snaps back.
  // Check the browser's seekable range and finite duration, not only the response headers.
  // `seekable` and a finite `duration` are the media
  // element's own verdict — a header assertion belongs in the route test (it has one) and would
  // not have caught a body the browser could not index into.
  const seekable = await waitFor(
    cdp,
    `(() => {
        const a = document.querySelector('#aceTray .acerow audio');
        if (!a || a.readyState < 1) { if (a) a.load(); return false; }
        // NOTE no backticks in here - one ends this template literal. Number.isFinite is
        // qualified deliberately: test_webui_modules reads an unqualified name a spec drives as
        // one the page is expected to own, and flags the bare global as unreachable.
        return a.seekable.length > 0 && a.seekable.end(0) > 0
               && Number.isFinite(a.duration) && a.duration > 0;
    })()`,
    20000,
  );
  ok(seekable, 'the browser reports the candidate as seekable with a real duration — the ' + '"0:00 / 0:00, scrub does nothing" bug');
  // And a seek actually holds, rather than snapping back to where it was.
  const sought = await evaluate(
    cdp,
    `(() => {
        const a = document.querySelector('#aceTray .acerow audio');
        a.currentTime = 1.0;
        return a.currentTime;
    })()`,
  );
  ok(sought > 0.5, `setting the playhead moves it and it stays moved (got ${sought})`);

  // A stopped backend can make every proxied candidate unavailable. Intercept only the page's
  // `/acestep/status` request; keep `/acestep/jobs` on the real server so candidate rows remain.
  // Docker edition: `unit` is the owned child's phase ('active' once running), and the banner tells
  // "running but not ready" (nothing to press) from "not running" (press Start) by it, so a STOPPED
  // backend has to report unit 'inactive' as well as up:false for this block's banner to be the right one.
  await evaluate(
    cdp,
    `(() => {
        const real = window.fetch;
        window.__aceDown = true;
        window.fetch = function (u, o) {
          const url = (typeof u === 'string') ? u : (u && u.url) || '';
          if (window.__aceDown && url.indexOf('/acestep/status') !== -1) {
            return real(u, o).then(r => r.json()).then(j => {
              const body = Object.assign({}, j, {
                running: 0,
                backends: (j.backends || []).map(b => Object.assign({}, b, { up: false, model_loaded: null, unit: 'inactive' })),
              });
              return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
            });
          }
          return real(u, o);
        };
        return true; })()`,
  );
  // `waitFor` returns only whether its expression matched. Wait for the banner state, then read
  // its text separately.
  const bannerShown = await waitFor(
    cdp,
    `(() => {
        const b = document.getElementById('aceTrayDead');
        return !!b && b.style.display !== 'none' && b.textContent.length > 0; })()`,
    15000,
  );
  ok(bannerShown, 'the tray says out loud that the backends are down, instead of showing dead players');
  const banner = await evaluate(cdp, `(document.getElementById('aceTrayDead') || {}).textContent || ''`);
  ok(
    /cuda:0/.test(String(banner)) && /cuda:1/.test(String(banner)),
    `the banner NAMES both cards, so it is actionable (got ${JSON.stringify(banner)})`,
  );
  ok(/[Nn]othing has been lost/.test(String(banner)), 'and it answers the actual fear — the songs are not gone');
  ok(/Start ACE-Step/.test(String(banner)), 'and it names the button that fixes it');

  // And it goes away by itself when they come back, without a page reload.
  await evaluate(cdp, `(() => { window.__aceDown = false; return true; })()`);
  ok(
    await waitFor(
      cdp,
      `(() => {
          const b = document.getElementById('aceTrayDead');
          return !!b && b.style.display === 'none'; })()`,
      15000,
    ),
    'and it clears itself once the backends answer again',
  );

  // ── keep one ─────────────────────────────────────────────────────────────
  await evaluate(cdp, `document.querySelector('#aceTray .acerow button[data-act="save"]').click()`);
  ok(
    await waitFor(
      cdp,
      `document.getElementById('overlay').classList.contains('on')
         && !!document.getElementById('vcNameIn')`,
      8000,
    ),
    'Save asks what to call it before it commits anything',
  );
  await evaluate(
    cdp,
    `(() => {
        const i = document.getElementById('vcNameIn');
        i.value = 'Sample Track One';
        i.dispatchEvent(new Event('input', {bubbles: true}));
        // The OK button is the one promptForName gives class 'ok'; Cancel is its sibling.
        document.querySelector('#mActs button.ok').click();
    })()`,
  );

  ok(
    await waitFor(
      cdp,
      `[...document.querySelectorAll('#aceLibrary .acerow')]
            .some(r => /Sample Track One/.test(r.innerText))`,
      20000,
    ),
    'the kept song appears in the permanent library under the name given',
  );

  // A kept song leaves the candidates tray, preventing it from appearing in both transient and
  // permanent lists (§6.4).
  ok(
    await waitFor(cdp, `document.querySelectorAll('#aceTray .acerow').length === 1`, 8000),
    'and stops being a candidate, rather than living in both lists at once',
  );

  // The download link is the format the picker says, not always FLAC (§4.5.4).
  const dl = await evaluate(
    cdp,
    `(() => {
        const a = document.querySelector('#aceLibrary .acerow a[download]');
        return a ? {href: a.getAttribute('href'), name: a.getAttribute('download')} : null;
    })()`,
  );
  ok(dl && /\/audio\?format=/.test(dl.href), `the library row offers a download naming its format (got ${JSON.stringify(dl)})`);

  // Titles can repeat across generated takes, so source options include the seed to distinguish
  // candidates with the same title.
  // The re-click is how the picker refetches: `ui/tabs.js` loads the sources on tab ENTRY,
  // precisely because the ordinary way a new one appears is a render finishing on this tab.
  await evaluate(cdp, `document.querySelector('#tabs button[data-tab="acestep"]').click()`);
  const seeded = await waitFor(
    cdp,
    `[...document.querySelectorAll('#aceSource option')]` + `.some(o => /Sample Track One — seed \\d+/.test(o.textContent))`,
    10000,
  );
  ok(
    seeded,
    'the Source picker names the saved song WITH its seed, so two takes of one title ' +
      'are told apart by the thing that actually differs',
  );

  // Selecting a template filters the library to songs generated from it (§4.5.3). Prove both
  // directions because a no-op filter could still show a song while its template is selected.
  // `wouldLoseWork()` compares the form with the loaded template. Switching is silent while the
  // values match, so change a lyric first to verify confirmation only when unsaved work exists.
  await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('aceLyrics');
        el.value = '[verse]\\nthe embers hold their shape\\n[chorus]\\nan unsaved line';
        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
    })()`,
  );
  await evaluate(
    cdp,
    `(() => {
        const s = document.getElementById('aceTemplate');
        s.value = '';
        s.dispatchEvent(new Event('change', {bubbles: true}));
    })()`,
  );
  const guarded = await waitFor(
    cdp,
    `document.getElementById('overlay').classList.contains('on')
         && /unsaved words/i.test(document.getElementById('mTitle').textContent)`,
    6000,
  );
  ok(
    guarded,
    'switching template after EDITING the lyrics asks before discarding them — the ' +
      'guard fires on unsaved WORK, not merely on a non-empty box',
  );
  if (guarded) {
    await evaluate(
      cdp,
      `[...document.querySelectorAll('#mActs button')]
            .find(b => /discard/i.test(b.textContent)).click()`,
    );
  }

  ok(
    await waitFor(
      cdp,
      `!document.getElementById('overlay').classList.contains('on')
         && document.getElementById('aceTemplate').value === ''`,
      8000,
    ),
    'and discarding really does move the picker to “— new song —”',
  );

  // With no template selected the library is unfiltered, so the song is still there. Then
  // select the template again and it must STILL be there — the same row, reached through the
  // filter. What would fail here is a filter keyed on the wrong id, which is the realistic bug.
  ok(
    await waitFor(
      cdp,
      `[...document.querySelectorAll('#aceLibrary .acerow')]
            .some(r => /Sample Track One/.test(r.innerText))`,
      10000,
    ),
    'with no template selected the library shows everything, including the saved song',
  );

  await evaluate(
    cdp,
    `(() => {
        const s = document.getElementById('aceTemplate');
        s.value = [...s.options].find(o => /Sample Track One/.test(o.textContent)).value;
        s.dispatchEvent(new Event('change', {bubbles: true}));
    })()`,
  );
  ok(
    await waitFor(
      cdp,
      `[...document.querySelectorAll('#aceLibrary .acerow')]
            .some(r => /Sample Track One/.test(r.innerText))`,
      10000,
    ),
    'and selecting the template it was made from still finds it — the filter keys on the ' +
      'right id rather than quietly emptying the shelf',
  );

  // Saving a template shows temporary confirmation. Assert computed color, not the class: a theme
  // rule with `!important` can override the class. `button.ok` is the
  // page's existing green, so this resolves --ok through the browser and compares against that,
  // which holds on both skins instead of hardcoding one theme's hex.
  await evaluate(cdp, `document.getElementById('aceTplUpdate').click()`);
  const flashed = await waitFor(
    cdp,
    `(() => {
        const b = document.getElementById('aceTplUpdate');
        if (!/Saved/.test(b.textContent)) return false;
        const probe = document.createElement('span');
        probe.style.backgroundColor =
            getComputedStyle(document.documentElement).getPropertyValue('--ok').trim();
        document.body.appendChild(probe);
        const want = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return getComputedStyle(b).backgroundColor === want;
    })()`,
    10000,
  );
  ok(
    flashed,
    'pressing Save flips the button to a GREEN "✓ Saved" — the acknowledgment that ' +
      'was missing entirely, asserted on the painted color rather than the class',
  );
  // The button returns to its normal label. A permanent "Saved" label would hide later feedback;
  // this also checks that a double press restores the original label.
  ok(
    await waitFor(
      cdp,
      `(() => {
        const b = document.getElementById('aceTplUpdate');
        return /Save$/.test(b.textContent.trim()) && !b.classList.contains('ok');
    })()`,
      10000,
    ),
    'and it returns to “💾 Save” a couple of seconds later rather than staying claimed',
  );

  // Clicking a library row opens the generated song details (§4.5.3).
  const libRow = `document.querySelector('#aceLibrary .acesong:not(.acedlhead)')`;

  // Keep the audio element as a sibling of the expandable row. Including expansion state in the
  // rendered row would replace it during reconciliation and interrupt playback; stamp its node
  // to verify identity across the update.
  await evaluate(cdp, `(() => { ${libRow}.querySelector('audio').__keep = 'lib'; return true; })()`);
  await evaluate(cdp, `${libRow}.querySelector('.acewhat').click()`);
  ok(await waitFor(cdp, `${libRow}.querySelector('.acelyr').hidden === false`, 8000), 'clicking a library row opens the box under it');
  ok(
    await evaluate(cdp, `/the embers hold their shape/.test(${libRow}.querySelector('.acelyr').innerText)`),
    'and the box holds the lyrics that song was actually generated from',
  );

  // Wait through two polls before judging. `setExpanded` opens the box by touching the live DOM,
  // so an immediate assertion could pass even when open/closed state is lost on the next render;
  // the row is not rebuilt until the next 2 s tick. Mutation-tested: with the bad implementation
  // in place, the immediate version of this check passed and the delayed version fails.
  // The two polls are counted off /acestep/library responses (this was `sleep(5200)`); both checks
  // below depend on them, so a poll that never came fails the first.
  const twoLibRepaints = await repaintsLater(cdp, '/acestep/library', 2);
  ok(
    twoLibRepaints && (await evaluate(cdp, `${libRow}.querySelector('audio').__keep === 'lib'`)),
    'the <audio> survives the repaints that follow an expand — the same node, so a song ' +
      'playing while you read its lyrics keeps playing',
  );
  ok(
    await evaluate(cdp, `${libRow}.querySelector('.acelyr').hidden === false`),
    'and the box is still open two polls later, rather than being closed by the repaint',
  );

  // The form above is repopulated, and because this song still matches the template it was made
  // from, the picker names that template rather than dropping to "— new song —".
  ok(
    await waitFor(cdp, `/the embers hold their shape/.test(document.getElementById('aceLyrics').value)`, 8000),
    'and the song is loaded back into the form above',
  );
  ok(
    await evaluate(
      cdp,
      `(() => {
        const s = document.getElementById('aceTemplate');
        return /Sample Track One/.test((s.options[s.selectedIndex] || {}).textContent || '');
    })()`,
    ),
    'a song still matching its template shows that template in the picker',
  );

  // Opening a library row must leave the generation seed unset. A pinned seed would make both
  // cards repeat the same take; prefill it first to prove the click actively clears it. The seed
  // remains visible on the row, and `writeAceAdvanced` clears omitted settings.
  await evaluate(
    cdp,
    `(() => {
        const el = document.querySelector('.aceadv[data-k="seed"]');
        el.value = '123456';
        el.dispatchEvent(new Event('change', {bubbles: true}));
        return true; })()`,
  );
  await evaluate(cdp, `${libRow}.querySelector('.acewhat').click()`);
  // The first click closes the row (the handler is synchronous); the second reopens it and hands
  // the song to the form. Wait for the close itself rather than `sleep(400)` between the two.
  if (!(await waitFor(cdp, `${libRow}.querySelector('.acelyr').hidden === true`, 8000)))
    throw new Error('the first click did not close the open library row, so the reopen below would not be a reopen');
  await evaluate(cdp, `${libRow}.querySelector('.acewhat').click()`);
  ok(
    await waitFor(cdp, `document.querySelector('.aceadv[data-k="seed"]').value === ''`, 8000),
    '🔴 clicking a library row leaves the Seed box BLANK — a hidden pinned seed would make ' +
      'both cards render the same song with nothing on screen saying so',
  );

  // Clicking `.acewhat` again closes the row. The lyrics box remains selectable without closing it.
  await evaluate(cdp, `${libRow}.querySelector('.acewhat').click()`);
  ok(await waitFor(cdp, `${libRow}.querySelector('.acelyr').hidden === true`, 8000), 'clicking the row again collapses it');

  // The download action is a primary library control. Compare its computed color with `--acc`
  // resolved by the browser, not a literal; a hardcoded rgb() would
  // pass on the dark skin and fail on the light one, where the accent is a different blue.
  const dlBtn = await evaluate(
    cdp,
    `(() => {
        const a = document.querySelector('#aceLibrary .acesong:not(.acedlhead) a.acedl');
        if (!a) return null;
        const probe = document.createElement('span');
        probe.style.backgroundColor =
            getComputedStyle(document.documentElement).getPropertyValue('--acc').trim();
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const cs = getComputedStyle(a);
        return {text: a.textContent.trim(), bg: cs.backgroundColor, accent, fg: cs.color,
                radius: parseFloat(cs.borderTopLeftRadius)};
    })()`,
  );
  ok(
    dlBtn && /Download/.test(dlBtn.text) && dlBtn.bg === dlBtn.accent && dlBtn.fg === 'rgb(255, 255, 255)' && dlBtn.radius >= 12,
    `the download is a rounded accent-blue pill labeled Download (${JSON.stringify(dlBtn)})`,
  );

  // Resolve the favorite star color from `--warn` in the browser so this works across skins.
  await evaluate(cdp, `${libRow}.querySelector('button[data-act="star"]').click()`);
  const gold = await waitFor(
    cdp,
    `(() => {
        const m = document.querySelector('#aceLibrary .acesong:not(.acedlhead) .favmark');
        if (!m) return false;
        const probe = document.createElement('span');
        probe.style.color = getComputedStyle(document.documentElement)
                                .getPropertyValue('--warn').trim();
        document.body.appendChild(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(m).color === want;
    })()`,
    10000,
  );
  ok(gold, 'favoriting a song paints its ★ gold rather than leaving it the body text color');

  // When the form diverges from its saved template, the picker should report no selected template.
  // The song retains its template ID, so the picker must compare current values rather than trust
  // an ID that could name a template no longer describing the song.
  await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('aceLyrics');
        el.value = '[verse]\\nthe template has moved on';
        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
    })()`,
  );
  await evaluate(cdp, `document.getElementById('aceTplUpdate').click()`);
  await waitFor(cdp, `/Saved/.test(document.getElementById('aceTplUpdate').textContent)`, 10000);

  // Template controls should remain visually distinct from ordinary field labels. Compare their
  // computed styles with the Mode heading and BPM label so theme rules are included.
  const labelInk = await evaluate(
    cdp,
    `(() => {
        const lab = el => getComputedStyle(el.closest('div').querySelector('label'));
        // NOTE no backticks in this comment - one would end the template literal (see the header).
        // parentElement, NOT closest('div'): #aceModes IS a div, so closest returns ITSELF and the
        // label lookup comes back null.
        const mode = getComputedStyle(document.getElementById('aceModes').parentElement.querySelector('label'));
        const tpl = lab(document.getElementById('aceTemplate'));
        const ref = lab(document.getElementById('aceRef'));
        const bpm = lab(document.getElementById('aceBpm'));
        return JSON.stringify({
          modeC: mode.color, modeS: mode.fontSize,
          tplC: tpl.color, tplS: tpl.fontSize,
          refC: ref.color, refS: ref.fontSize,
          bpmC: bpm.color, bpmS: bpm.fontSize,
        });
    })()`,
  );
  const ink = JSON.parse(labelInk);
  ok(ink.bpmC !== ink.modeC, `the two label inks really are different, or nothing below means anything (${labelInk})`);
  ok(ink.tplC === ink.modeC, `Song template is painted like Mode, not like a field label (${labelInk})`);
  ok(ink.tplS === ink.modeS, `…and at Mode's size, because it names what every box below belongs to (${labelInk})`);
  ok(ink.refC === ink.modeC, `Sing it like is full strength, not the muted gray (${labelInk})`);
  ok(ink.refS === ink.bpmS, `…but NOT heading-sized — it is a field, and only Mode heads this card (${labelInk})`);

  // Revert is hidden while the form matches the template and restores saved values after edits.
  const revShown = `getComputedStyle(document.getElementById('aceTplRevert')).display !== 'none'`;
  ok(
    await waitFor(cdp, `!(${revShown})`, 8000),
    'with the boxes matching the template there is nothing to revert, so the button is not offered',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const b = [...document.querySelectorAll('#aceForm button')].map(x => x.id);
          return b.indexOf('aceTplRevert') === b.indexOf('aceTplSave') + 1
              && b.indexOf('aceTplDel') === b.indexOf('aceTplRevert') + 1; })()`,
    ),
    'it sits after Save as… and before Delete, matching the controls’ action order',
  );
  await evaluate(
    cdp,
    `(() => {
        const el = document.getElementById('aceLyrics');
        el.value = '[verse]\\nwords typed by mistake';
        el.dispatchEvent(new Event('input', {bubbles: true}));
    })()`,
  );
  ok(await waitFor(cdp, revShown, 8000), 'editing the boxes offers the way back');
  await evaluate(cdp, `document.getElementById('aceTplRevert').click()`);
  ok(
    await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`, 8000),
    'reverting asks first — what it throws away can be an evening of lyrics',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const b = [...document.querySelectorAll('#mActs button')].find(x => /Discard my edits/.test(x.textContent));
          if (!b) return false; b.click(); return true; })()`,
    ),
    'the confirm offers a button that says what it does',
  );
  ok(
    await waitFor(cdp, `/the template has moved on/.test(document.getElementById('aceLyrics').value)`, 8000),
    'and the saved words come back',
  );
  ok(await waitFor(cdp, `!(${revShown})`, 8000), '…leaving nothing to revert, so the button goes away again');

  await evaluate(cdp, `${libRow}.querySelector('.acewhat').click()`);
  ok(
    await waitFor(cdp, `/the embers hold their shape/.test(document.getElementById('aceLyrics').value)`, 8000),
    'reopening the song restores ITS lyrics, not the template it has diverged from',
  );
  ok(
    await evaluate(cdp, `document.getElementById('aceTemplate').value === ''`),
    'and the picker drops to “— new song —”, because no saved template would reproduce this ' + 'song any more',
  );

  ok(thrown.length === 0, `the page threw nothing: ${thrown.join(' | ') || 'clean'}`);
} catch (e) {
  console.error(`  FAIL harness: ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

process.exit(failed ? 1 : 0);

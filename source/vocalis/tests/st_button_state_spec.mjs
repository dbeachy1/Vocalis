// Vocalis 5.4 — the narrate button's STATE MACHINE, driven in a real browser.
//
// The narrate button must leave its pending state when a new AI reply starts a prerender.
// This browser spec checks the polling and state transitions across the full render path.
// Every existing check was blind to it, and it is worth being precise about why:
//   * test_st_extension_smoke.py reads the source. The tokens were all present; they were in
//     the wrong function.
//   * st_button_colors_spec.mjs asks Chrome what `.vocalis_ready` PAINTS. Nothing ever put
//     that class on a button.
//   * the Python suite tests the server, and the server was right.
// The gap was that no test ever ran the client's control flow. That is what this closes.
//
// It drives the REAL, UNMODIFIED index.js as a real ES module. SillyTavern's jQuery is stood in
// for by st_dom_shim.js (see its header for the line between "plumbing" and "the thing under
// test"); the transport module is stubbed so the spec can script what the server says and count
// what was asked. No npm — Node ships http/WebSocket/fetch, Chrome speaks CDP.
//
// Usage: node st_button_state_spec.mjs <extension-dir> <shim-path> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { TIMERS_DRAINED, trackTimers } from './_specwait.mjs';

const [extDir, shimPath, chromePath] = process.argv.slice(2);
if (!extDir || !shimPath || !chromePath) {
  console.error('usage: node st_button_state_spec.mjs <extension-dir> <shim> <chrome-path>');
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

// ── CDP plumbing (same recipe as st_button_colors_spec.mjs) ──────────────────
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

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

// 🔴 A CONDITION, NOT A DURATION. This file had no wait helper at all, which is how it ended up
// asserting against a page it had merely hoped was ready. See tests/st_scene_range_spec.mjs for the
// same fix and the same reasoning.
//
// 🔴 THE DEADLINE IS ONLY A BOUND ON A HANG (2026-10-12). It was a per-call guess of how long a quick
// machine needs (8 s by default, 5 s and 10 s in places), which is a time bet in the same family as a
// sleep: a passing run never waits it out, but a loaded one that is merely slow would fail it. Never
// shorter than 30 s now.
async function waitFor(cdp, expression, requestedMs = 8000) {
  const timeoutMs = Math.max(requestedMs, 30000);
  const t0 = Date.now();
  for (;;) {
    // 🔴 `Promise.resolve(...)` — see the note in train_disk_browser_spec.mjs. `!!aPromise` is
    // `true` synchronously and always, so this wait returned on its first poll every time.
    // The `.catch()` stays: a poll that throws (an element not painted yet) is a not-yet,
    // not a failure.
    if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`).catch(() => false)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(50);
  }
}

// ── the page ─────────────────────────────────────────────────────────────────
// Two AI messages already on screen, shaped the way SillyTavern paints them: `.mes[mesid]`
// wrapping a `.mes_text` and the `.extraMesButtons` slot `injectButtons` prepends into.
const MESSAGE_ROW = (id, name, text) => `
  <div class="mes" mesid="${id}">
    <div class="mes_block">
      <div class="ch_name flex-container justifySpaceBetween">
        <span class="name_text">${name}</span>
        <div class="mes_buttons"><div class="extraMesButtons"></div></div>
      </div>
      <div class="mes_text">${text}</div>
    </div>
  </div>`;

// Read before PAGE is built: the page's timer tracking below is sized from the extension's own
// intervals, so a change to either number there moves the tracking with it. (The checks that
// refuse to run on an unreadable number stay where they always were, further down.)
const indexJs = await readFile(join(extDir, 'index.js'), 'utf-8');
const pollMs = Number(/const POLL_MS = (\d+)/.exec(indexJs)?.[1] ?? 0);
const retryMs = Number(/const PRELOAD_RETRY_MS = (\d+)/.exec(indexJs)?.[1] ?? 0);

const PAGE = `<!doctype html><meta charset="utf-8">
<div id="extensions_settings2"></div>
<div id="message_template"><div class="mes_buttons"><div class="extraMesButtons"></div></div></div>
<div id="chat">
  ${MESSAGE_ROW(0, 'Test Character', 'An older line, already rendered once.')}
  ${MESSAGE_ROW(1, 'Test Character', 'The reply under test, long enough to be worth rendering.')}
</div>
<script type="module">
  import { installJQuery, fireReady } from '/st_dom_shim.js';
  installJQuery(window);
  window.toastr = { error(){}, success(){}, info(){}, warning(){} };

  // 🔴 WHICH OF THE EXTENSION'S TIMERS ARE STILL PENDING — the signal for "nothing is scheduled any
  // more", which is what every "it stops" / "it does not do X" check in this file is really about.
  // Those checks used to be a fixed sleep (3 poll intervals, a quarter of one, one, two retry
  // intervals) followed by a read, i.e. a bet on how long the machine takes to run the timer the
  // check is afraid of. Every setTimeout / setInterval of ${Math.max(pollMs, retryMs)} ms or less that the page code
  // sets is counted from set until it fires or is cleared (an interval until it is cleared), so
  // "pending() === 0" means no sweep debounce, no state poll and no preload retry is armed — and
  // if one WERE armed, the wait for zero would run it, and the request it makes would then be seen.
  // That cap is the larger of POLL_MS and PRELOAD_RETRY_MS, read from index.js. Longer timers (the
  // probe back-off, the import interval) are not counted. The wrapper is installed BEFORE the
  // extension is imported so it sees every timer the extension sets.
  // NO BACKTICKS IN THIS BLOCK: it is inside a template literal.
  ${trackTimers(Math.max(pollMs, retryMs))}

  // What the server says, scripted per poll, plus a count of what was asked. The spec drives
  // BOTH: this is how it can tell "the color is right" from "the client stopped asking".
  window.__srv = {
      calls: { prerender: 0, states: 0 },
      prerenderReply: { cache_key: 'k1', state: 'queued' },
      // consumed one entry per fetchStates call, last entry repeats
      script: [],
      lastAsked: null,
  };

  const listeners = new Map();
  const ctxStub = {
      chat: [
          { mes: 'An older line, already rendered once.', name: 'Test Character' },
          { mes: 'The reply under test, long enough to be worth rendering.', name: 'Test Character' },
      ],
      extensionSettings: { vocalis: { enabled: true, autoNarrate: false, preRender: true,
                                      serverUrl: 'https://stub.invalid' } },
      saveSettingsDebounced() {},
      substituteParams: (s) => s,
      eventSource: {
          on(type, fn) { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(fn); },
          emit(type, ...a) { return Promise.all((listeners.get(type) ?? []).map(f => f(...a))); },
      },
      event_types: {
          CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
          USER_MESSAGE_RENDERED: 'user_message_rendered',
          CHAT_LOADED: 'chat_loaded',
          MORE_MESSAGES_LOADED: 'more_messages_loaded',
          CHAT_CHANGED: 'chat_changed',
          GROUP_UPDATED: 'group_updated',
          MESSAGE_SWIPED: 'message_swiped',
          MESSAGE_DELETED: 'message_deleted',
          MESSAGE_EDITED: 'message_edited',
          MESSAGE_UPDATED: 'message_updated',
      },
  };
  // Map#get on a missing key returns undefined, so the on() above needs a real default.
  ctxStub.eventSource.on = (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
  };
  window.SillyTavern = { getContext: () => ctxStub };
  window.__emit = (type, ...a) => ctxStub.eventSource.emit(type, ...a);

  // 🔴 CAPTURE WHY BOOT FAILED. Without this a throw in the import or in init is swallowed by
  // the module's own rejection and the only symptom is __booted staying false - the spec then
  // reports "extension never finished init" with no reason, which is a whole debugging session
  // spent rediscovering a stack trace the browser already had.
  // NOTE: this block is inside a TEMPLATE LITERAL. No backticks, no dollar-brace.
  try {
      await import('/index.js');   // the REAL extension, unmodified
      await fireReady();           // its jQuery(async () => …) init, against the DOM above
      window.__booted = true;
  } catch (e) {
      window.__bootError = String((e && e.stack) || e);
  }
</script>`;

// The transport, stubbed. Same export surface as the real vocalis-stream.js.
const STREAM_STUB = `
export async function prerender(url, body) {
    const s = window.__srv;
    s.calls.prerender++;
    // 9.5.10 SS18d - WHICH MESSAGE, IN WHICH ORDER. A count alone cannot tell "walked the chat
    // from here" from "sent the same message four times", and the chain's whole contract is the
    // order: never skip one the server refused, never speak the user's own line.
    s.prerenderAsked = (s.prerenderAsked || []).concat([body.input]);
    // One scripted answer per call, consumed; falls through to prerenderReply, which is what
    // every section written before this one uses.
    if (s.prerenderScript && s.prerenderScript.length) return s.prerenderScript.shift();
    return s.prerenderReply;
}
export async function fetchStates(url, bodies) {
    const s = window.__srv;
    s.calls.states++;
    s.lastAsked = bodies.map(b => b.input);
    const step = s.script.length ? s.script[Math.min(s.calls.states - 1, s.script.length - 1)] : [];
    // Answer in request order, defaulting anything unscripted to "none".
    return bodies.map((b, i) => step[i] ?? { state: 'none' });
}
export async function cancelPrerender() { return { canceled: 0 }; }
// 🔴 6.0: the stub must export the SAME SURFACE as the real vocalis-stream.js. A named import
// of an export that does not exist is a LINK-time error, so index.js never evaluates at all —
// and the symptom is not "scenes are broken", it is "the extension does not boot", with every
// check in the file failing for a reason that names none of this.
export async function estimateScene() { return { total: 0, cached: 0, uncached: 0,
    est_audio_s: null, est_render_s: null, render_rate: null, gap_s: 0.7 }; }
export async function createScene() { return { job_id: 'stub', items: 0, skipped: 0 }; }
export async function sceneStatus() { return { status: 'done', ref: null }; }
export async function cancelScene() { return { ok: true }; }
export async function probeHealth() { return { ok: true, info: {} }; }
export async function registerCharacters() { return {}; }
export async function pairPing() { return { ok: true, paired: true }; }
export async function pushDocument() { return { ok: true, created: true, revision: 0 }; }
export async function pushAvatar() { return { ok: true }; }
export async function pairPoll() { return { ok: true, sweep: false }; }
export async function sweepDone() { return; }
// 7.0-m3 (send-to-ST) joins the stub surface for the reason the note above gives.
export async function fetchPlan() { return { ok: false, reason: 'no plan in the stub' }; }
export async function pushDone() { return; }
// m4o: the card picture for a send. Same rule as every name above it — a stub that does not
// export something index.js imports is a MODULE-LOAD failure, so nothing runs and every check
// in the file fails on a missing function rather than on its subject.
export async function fetchAvatar() { return { ok: false, reason: 'no avatar in the stub' }; }
export async function fetchExtensionSettings() { return { ok: false, reason: 'no settings in the stub' }; }
// 7.0-m2: pairPing joins the stub surface for the reason the note above gives - a named
// import of something the stub does not export is a MODULE-LOAD failure, so index.js never
// runs and every check here fails on a missing function rather than on its subject.
// NOTE: this stub is a TEMPLATE LITERAL. No backticks and no dollar-brace in here, or the
// literal ends early and the spec file itself stops parsing.
// 7.4 §18b — the chain is DRIVEN through this stub. It records every call and hands the spec
// the callbacks, so onPlaying/onEnded fire when the spec says so rather than on a real audio
// element's schedule. NOTE: still inside a TEMPLATE LITERAL — no backticks, no dollar-brace.
export function playStream(opts) {
    window.__played = (window.__played || []).concat([opts.body.input]);
    window.__stream = { opts, stopped: false };
    return { stop() { window.__stream.stopped = true; } };
}
`;

const BAR_STUB = `export function showNarrationPlayerBar() {}
export function hideNarrationPlayerBar() {}`;

// ── serve it (ES modules need real URLs, and so does the import of ./vocalis-stream.js) ──
const polishJs = await readFile(join(extDir, 'polish-send.js'), 'utf-8');
const shimJs = await readFile(shimPath, 'utf-8');
const ROUTES = {
  '/': ['text/html; charset=utf-8', PAGE],
  '/index.js': ['text/javascript', indexJs],
  '/polish-send.js': ['text/javascript', polishJs],
  '/vocalis-stream.js': ['text/javascript', STREAM_STUB],
  '/scripts/narration-player-bar.js': ['text/javascript', BAR_STUB],
  '/st_dom_shim.js': ['text/javascript', shimJs],
};
const server = createServer((req, res) => {
  const hit = ROUTES[req.url.split('?')[0]];
  if (!hit) {
    res.writeHead(404);
    res.end('no');
    return;
  }
  res.writeHead(200, { 'content-type': hit[0] });
  res.end(hit[1]);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-state-'));
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
  server.close();
  // 🔴 WAIT FOR CHROME TO ACTUALLY GO BEFORE DELETING ITS PROFILE. `kill()` returns at once and
  // Windows keeps the handles a moment longer, so an immediate recursive delete throws EBUSY -
  // and swallowing the removal error leaves the temporary profile behind. Retry briefly because
  // the process exit event can precede Windows releasing its file handles.
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

let port = null;
chrome.stderr.on('data', buf => {
  const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(String(buf));
  if (m && !port) port = m[1];
});
for (let i = 0; i < 100 && !port; i++) await sleep(100);
if (!port) {
  console.error('FAIL chrome never reported a debugging port');
  await cleanup();
  process.exit(1);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const cdp = connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await cdp.ready;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

const classOf = id =>
  evaluate(cdp, `(document.querySelector('#chat .mes[mesid="${id}"] .vocalis_narrate') || {className: '<no button>'}).className`);
const colorClass = async id => {
  const c = await classOf(id);
  for (const [cls, name] of [
    ['vocalis_cached', 'green'],
    ['vocalis_ready', 'blue'],
    ['vocalis_pending', 'yellow'],
  ]) {
    if (c.includes(cls)) return name;
  }
  return c === '<no button>' ? '<no button>' : 'orange';
};

// True once the extension has no sweep, poll or retry timer armed (see __timersPending in the
// page). The deadline is only a bound on a hang: a timer that keeps re-arming is exactly what a
// check using this is looking for, and it reports false after the bound rather than hanging.
const drained = (deadlineMs = 30000) => waitFor(cdp, TIMERS_DRAINED, deadlineMs);
const settle = async () => {
  if (!(await drained()))
    throw new Error(`the extension's timers never drained (${await evaluate(cdp, 'window.__timersPending()')} still armed)`);
};

try {
  // ── boot ─────────────────────────────────────────────────────────────────
  await cdp.send('Page.navigate', { url: origin });
  let booted = false;
  for (let i = 0; i < 450 && !booted; i++) {
    // (bounded condition loop; 450 x 100 ms is only a bound on a hang — it was 100, i.e. 10 s)
    await sleep(100);
    booted = await evaluate(cdp, 'window.__booted === true').catch(() => false);
  }
  ok(booted, 'the real extension boots against the shim');
  if (!booted) {
    const why = await evaluate(cdp, 'window.__bootError || "(no error captured)"').catch(() => '(unreadable)');
    throw new Error(`extension never finished init — ${why}`);
  }
  ok((await classOf(1)) !== '<no button>', 'injectButtons put a narrate button on each message');

  // ── 1. the chat-load path (this one always worked — it is the control) ────
  await evaluate(
    cdp,
    `window.__srv.script = [[{state:'cached'},{state:'cached'}]];
                         window.__emit('chat_loaded')`,
  );
  await waitFor(
    cdp,
    `(document.querySelector('#chat .mes[mesid="'+1+'"] .vocalis_narrate')||{className:''}).className.includes('vocalis_cached')`,
    15000,
  );
  ok((await colorClass(1)) === 'green', 'CHAT_LOADED sweeps and paints a cached message green');

  // ── 2. 🔴 THE REGRESSION ─────────────────────────────────────────────────
  // A brand-new AI reply, delivered the way SillyTavern actually delivers one: a new row is
  // appended to #chat, a new entry is pushed onto ctx.chat, and CHARACTER_MESSAGE_RENDERED
  // fires for it. That is ALL. No swipe, no chat load, no user message — nothing that would
  // run a sweep.
  //
  // ⚠️ THE FIRST VERSION OF THIS SPEC GOT THIS WRONG AND WAS WORTHLESS. It reused message 1
  // and emitted MESSAGE_SWIPED first to clear the green, because that seemed like a tidy way
  // to reset. A swipe calls forgetState + scheduleSweep, and that sweep armed the poll — so
  // the spec passed against the very code it was written to catch. A repro that reaches the
  // right end state by the wrong path is not a repro. The rule this cost: drive the events
  // the application actually emits, in the order it emits them, and NOTHING else.
  await evaluate(
    cdp,
    `
        const c = SillyTavern.getContext();
        c.chat.push({ mes: 'A brand new reply that the server will now render.', name: 'Test Character' });
        const id = c.chat.length - 1;
        const row = document.createElement('div');
        row.className = 'mes';
        row.setAttribute('mesid', String(id));
        row.innerHTML = '<div class="mes_block"><div class="mes_text">A brand new reply that the server will now render.</div>'
                      + '<div class="mes_buttons"><div class="extraMesButtons"></div></div></div>';
        document.getElementById('chat').appendChild(row);
        // ST's own template injection puts the button on a newly rendered message.
        $('#chat .mes[mesid="' + id + '"] .extraMesButtons')
            .prepend($('#message_template .extraMesButtons').nodes[0].innerHTML
                     || '<div class="mes_button vocalis_narrate fa-solid fa-volume-high"></div>');
        window.__newId = id;
        window.__srv.calls = { prerender: 0, states: 0 };
        window.__srv.prerenderReply = { cache_key: 'k-new', state: 'queued' };
        // What the server reports on successive polls: still rendering, then the buffer
        // governor releases (blue), then promoted (green).
        window.__srv.script = [
            [{state:'rendering', detail:'next'}],
            [{state:'playable'}],
            [{state:'cached'}],
        ];
        window.__emit('character_message_rendered', id);
    `,
  );

  await waitFor(cdp, `window.__srv.calls.prerender === 1`, 8000);
  const NEW = await evaluate(cdp, 'window.__newId');
  ok((await evaluate(cdp, 'window.__srv.calls.prerender')) === 1, 'a new reply is pre-rendered exactly once');
  ok((await colorClass(NEW)) === 'yellow', 'the pre-render response paints it yellow immediately');

  // Now the part that was broken. No further events — only time.
  await waitFor(cdp, `window.__srv.calls.states >= 1`, 15000);
  const afterOne = await colorClass(NEW);
  ok(afterOne === 'blue' || afterOne === 'yellow', `the client polls on its own after a pre-render (still ${afterOne})`);
  ok(
    (await evaluate(cdp, 'window.__srv.calls.states')) >= 1,
    '🔴 polling STARTS from the pre-render path, with no sweep and no further events',
  );

  // 🔴 THESE TWO WAITS (AND 2c'S) NEVER WAITED FOR ANYTHING (found 2026-10-12). They were written
  // `mesid="'+NEW+'"`, which inside this Node template literal sends the page the identifier
  // `NEW` — a ReferenceError there, which `waitFor` reads as "not yet" — so each ran its whole
  // 15 s deadline and returned false, and the `ok` after it passed only because 15 s was long
  // enough for the walk to finish: a 15 s sleep in the shape of a condition. They interpolate the
  // id now and end when the color does (the timeline in the test log shows 14-15 s each before).
  await waitFor(
    cdp,
    `(document.querySelector('#chat .mes[mesid="${NEW}"] .vocalis_narrate')||{className:''}).className.includes('vocalis_ready') ||(document.querySelector('#chat .mes[mesid="${NEW}"] .vocalis_narrate')||{className:''}).className.includes('vocalis_cached')`,
    15000,
  );
  ok((await colorClass(NEW)) === 'blue' || (await colorClass(NEW)) === 'green', 'it reaches blue when the buffer governor releases');

  await waitFor(
    cdp,
    `(document.querySelector('#chat .mes[mesid="${NEW}"] .vocalis_narrate')||{className:''}).className.includes('vocalis_cached')`,
    15000,
  );
  ok((await colorClass(NEW)) === 'green', '🔴 it reaches green on its own — the whole yellow → blue → green walk, unattended');

  // ── 2b. 🔴 messages that appear with NO event at all ──────────────────────
  // Reconcile already-rendered rows after the handler attaches. CHAT_LOADED can fire before an
  // async extension import registers its listener, so cached rows must not depend on winning
  // that startup race. This simulates chat-load and "show more" rows without emitting an event.
  const beforeSilent = await evaluate(cdp, 'window.__srv.calls.states');
  await evaluate(
    cdp,
    `
        window.__srv.script = [[{state:'cached'},{state:'cached'}]];
        const ctxb = SillyTavern.getContext();
        const chat = document.getElementById('chat');
        for (const text of ['An older line from further up the scrollback.',
                            'Another older line, also already rendered.']) {
            ctxb.chat.push({ mes: text, name: 'Test Character' });
            const id = ctxb.chat.length - 1;
            const row = document.createElement('div');
            row.className = 'mes';
            row.setAttribute('mesid', String(id));
            row.innerHTML = '<div class="mes_block"><div class="mes_text"></div>'
                          + '<div class="mes_buttons"><div class="extraMesButtons">'
                          + '<div class="mes_button vocalis_narrate fa-solid fa-volume-high"></div>'
                          + '</div></div></div>';
            row.querySelector('.mes_text').textContent = text;
            chat.appendChild(row);
            window.__silentIds = (window.__silentIds || []).concat(id);
        }
    `,
  );
  await waitFor(cdp, `window.__srv.calls.states > ${beforeSilent}`, 15000);
  const silentIds = await evaluate(cdp, 'window.__silentIds');
  ok(
    (await evaluate(cdp, 'window.__srv.calls.states')) > beforeSilent,
    '🔴 rows added with NO event are probed anyway (the chat-load race)',
  );
  const silentColors = [];
  for (const id of silentIds) silentColors.push(await colorClass(id));
  ok(
    silentColors.every(c => c === 'green'),
    `🔴 scrolled-back cached messages come up green (${silentColors.join(', ')})`,
  );

  // ── 2c. 🔴 a message that LEAVES the DOM and comes back ───────────────────
  // Chat windowing removes off-screen rows and recreates them when they return. Reconcile the
  // current DOM from message state; a cached id alone cannot prove that a new row is painted.
  const beforeReturn = await evaluate(cdp, 'window.__srv.calls.states');
  const returned = await evaluate(
    cdp,
    `(() => {
        const id = window.__silentIds[0];
        const row = document.querySelector('#chat .mes[mesid="' + id + '"]');
        const chat = document.getElementById('chat');
        row.remove();                                    // scrolled out of the window
        const fresh = row.cloneNode(true);               // …and repainted on the way back
        fresh.querySelector('.vocalis_narrate').className =
            'mes_button vocalis_narrate fa-solid fa-volume-high';   // no color, as ST paints it
        chat.appendChild(fresh);
        return id;
    })()`,
  );
  await waitFor(
    cdp,
    `(document.querySelector('#chat .mes[mesid="${returned}"] .vocalis_narrate')||{className:''}).className.includes('vocalis_cached')`,
    15000,
  );
  ok((await colorClass(returned)) === 'green', '🔴 a message that left the window and came back is still green');
  ok(
    (await evaluate(cdp, 'window.__srv.calls.states')) === beforeReturn,
    'and it cost no extra request — repainted from what the client already knew',
  );

  // ── 3. and then it shuts up ──────────────────────────────────────────────
  // The other half of the design: a chat that is not rendering makes no traffic. A fix that
  // armed the poll unconditionally would pass every check above and quietly hammer the
  // server for as long as the tab was open.
  // 🔴 WHAT THE ABSENCE IS ANCHORED TO (2026-10-12). This was `sleep(pollMs * 3)` between two reads
  // of the request counter: "you cannot waitFor something that must never happen, so real time has
  // to pass". It does not have to pass — what makes a poll tick is an ARMED TIMER, and the page
  // reports exactly that (__timersPending: every sweep, poll and retry timer set and not yet
  // fired or cleared). A poll that stopped leaves no timer, so "stopped" is the count reaching
  // zero; a poll that never stops keeps re-arming, the count never reaches zero, and the check
  // fails — on any machine speed, where three guessed intervals could be shorter than one real tick
  // on a starved box and then prove nothing. The counter is read before and after anyway.
  if (!pollMs) throw new Error('could not read POLL_MS out of index.js — the timers below ' + 'would not be tracked');
  const stoppedDead = await drained();
  const settled = await evaluate(cdp, 'window.__srv.calls.states');
  const pendingNow = await evaluate(cdp, 'window.__timersPending()');
  const after = await evaluate(cdp, 'window.__srv.calls.states');
  ok(
    stoppedDead && pendingNow === 0 && after === settled,
    `polling stops dead once everything on screen is terminal (${settled} -> ${after}, ` + `${pendingNow} timer(s) left armed)`,
  );

  // ── 3b. 🔴 8.2: A STATE THIS FILE HAS NO COLOR FOR MUST NOT FREEZE THE BUTTON ──────────
  //
  // A message already assigned to a prerender job must be shown as cached even when the server
  // reports a state the client does not recognize.
  //
  // `/v1/audio/state` answers `rendering`/`playable`. `/v1/audio/prerender` answered **`running`**
  // — `PrerenderQueue.submit`'s own word — whenever the message it was asked to speculate on was
  // already the job on the card, which is routine: `narrateMessage` speculates on mesId+1 while
  // mesId plays. `applyState` then did all three wrong things at once: no entry in `CLASS_FOR`
  // so the button was painted ORANGE, no entry in `ACTIVE` so the poll never armed, and a
  // RECORDED state so the sweep's reconcile skipped it forever. The render finished and cached;
  // nothing was left that would ever ask again.
  //
  // 🔴 EVERY OTHER CHECK IN THIS FILE WAS BLIND TO IT, and it is worth being precise about why:
  // this stub only ever scripted words the client already knew. The defect lived in the JOIN —
  // one process's vocabulary against another's — which neither side's tests can see alone.
  //
  // Two arms, and the second is the one that matters more:
  //   a. the literal word the old server sends, which an un-updated install still sends today;
  //   b. a word NOBODY has ever sent, so the check is about the HANDLING and not about `running`.
  for (const [state, label, note] of [
    ['running', 'a `running`', 'the server\'s own word for "already on the card"'],
    ['sizzling', 'an unknown', 'a state no version of the server has ever sent'],
  ]) {
    await evaluate(
      cdp,
      `
      (() => {
        const c = SillyTavern.getContext();
        c.chat.push({ mes: 'A reply the server answers ${state} for, long enough to render.', name: 'Test Character' });
        const id = c.chat.length - 1;
        const row = document.createElement('div');
        row.className = 'mes';
        row.setAttribute('mesid', String(id));
        row.innerHTML = '<div class="mes_block"><div class="mes_text"></div>'
                      + '<div class="mes_buttons"><div class="extraMesButtons">'
                      + '<div class="mes_button vocalis_narrate fa-solid fa-volume-high"></div>'
                      + '</div></div></div>';
        row.querySelector('.mes_text').textContent = c.chat[id].mes;
        document.getElementById('chat').appendChild(row);
        window.__oddId = id;
        window.__srv.calls = { prerender: 0, states: 0 };
        window.__srv.prerenderReply = { cache_key: 'k-${state}', state: '${state}' };
        // Whatever it asks next, the truth is: this is rendering, and then it is cached.
        window.__srv.script = [[{state:'rendering'}], [{state:'cached'}]];
        window.__emit('character_message_rendered', id);
      })()
      `,
    );
    await waitFor(cdp, `window.__srv.calls.prerender === 1`, 8000);
    const ODD = await evaluate(cdp, 'window.__oddId');

    // 🔴 THE CLAIM, AND IT IS AN ABSENCE OF A FREEZE, NOT A PARTICULAR COLOR. `running` is
    // aliased straight to yellow; the unknown word cannot be, so its recovery is the sweep
    // asking the one route whose vocabulary is authoritative. Both must END somewhere true.
    ok(await waitFor(cdp, `window.__srv.calls.states >= 1`, 15000), `🔴 ${label} state keeps the client ASKING (${note})`);
    await waitFor(
      cdp,
      `(document.querySelector('#chat .mes[mesid="' + ${ODD} + '"] .vocalis_narrate')||{className:''}).className.includes('vocalis_cached')`,
      15000,
    );
    ok((await colorClass(ODD)) === 'green', `🔴 and it reaches green unattended — ${label} state does not strand the button orange`);
  }
  // And the alias specifically: `running` is the server saying "rendering", so it must color
  // like one the instant the response lands, not only after a poll has been round the houses.
  await evaluate(
    cdp,
    `
    (() => {
      const c = SillyTavern.getContext();
      c.chat.push({ mes: 'One more, to catch the color at the moment the response lands.', name: 'Test Character' });
      const id = c.chat.length - 1;
      const row = document.createElement('div');
      row.className = 'mes';
      row.setAttribute('mesid', String(id));
      row.innerHTML = '<div class="mes_block"><div class="mes_text"></div>'
                    + '<div class="mes_buttons"><div class="extraMesButtons">'
                    + '<div class="mes_button vocalis_narrate fa-solid fa-volume-high"></div>'
                    + '</div></div></div>';
      row.querySelector('.mes_text').textContent = c.chat[id].mes;
      document.getElementById('chat').appendChild(row);
      window.__aliasId = id;
      window.__srv.calls = { prerender: 0, states: 0 };
      window.__srv.prerenderReply = { cache_key: 'k-alias', state: 'running' };
      window.__srv.script = [[{state:'rendering'}]];   // never advances: the color must not need it
      window.__emit('character_message_rendered', id);
    })()
    `,
  );
  const ALIAS = await evaluate(cdp, 'window.__aliasId');
  await waitFor(
    cdp,
    `(document.querySelector('#chat .mes[mesid="' + ${ALIAS} + '"] .vocalis_narrate')||{className:''}).className.includes('vocalis_pending')`,
    8000,
  );
  ok((await colorClass(ALIAS)) === 'yellow', '🔴 `running` paints YELLOW from the pre-render response itself');
  // ⚠️ And settle it before moving on. A message left in an ACTIVE state polls for the rest of
  // the run and would consume the scripted answers the sections below set up for themselves.
  await evaluate(cdp, `window.__srv.script = [[{state:'cached'}]]`);
  await waitFor(
    cdp,
    `(document.querySelector('#chat .mes[mesid="' + ${ALIAS} + '"] .vocalis_narrate')||{className:''}).className.includes('vocalis_cached')`,
    15000,
  );

  // ── 4. 7.4 §18: ⬆ Preload, from the shift-click menu ─────────────────────
  //
  // Manual preload remains available with automatic pre-render disabled, including for messages
  // the automatic path skipped.
  await evaluate(
    cdp,
    `
        SillyTavern.getContext().extensionSettings.vocalis.preRender = false;
        window.__srv.calls.prerender = 0;
        window.__srv.prerenderReply = { cache_key: 'k-manual', state: 'queued' };
        // The gesture: shift-click on the speaker opens the menu (it always has — §2.2).
        const b = document.querySelector('#chat .mes[mesid="0"] .vocalis_narrate');
        b.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, shiftKey: true, button: 0}));
        // 🔴 AND THE CLICK THAT FOLLOWS IT. A browser fires pointerdown → pointerup → click for
        // one shift-click, and the extension's handler SWALLOWS that click (pressHandled) —
        // which is also what clears the flag. Dispatching only the pointerdown leaves it set, so
        // the NEXT ordinary click in the spec is eaten and the check fails against code that is
        // perfectly correct. Drive the whole gesture the browser really produces.
        b.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}));
    `,
  );
  await waitFor(cdp, `!!document.querySelector('.vocalis_scene_menu')`, 8000);
  const menuRows = await evaluate(cdp, `[...document.querySelectorAll('.vocalis_scene_menu_item')].map(el => el.textContent)`);
  ok(
    menuRows.some(t => /Preload this message/.test(t)),
    `the shift-click menu offers Preload (${menuRows.join(' | ')})`,
  );
  ok(
    menuRows.some(t => /Autoplay from here on/.test(t)),
    'and Autoplay from here on',
  );
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.vocalis_scene_menu_item')]
        .find(el => /Preload this message/.test(el.textContent)).click()`,
  );
  await waitFor(cdp, `window.__srv.calls.prerender === 1`, 8000);
  // 🔴 THE POINT OF THE WHOLE ITEM: it works with pre-rendering switched off. The automatic
  // path returns at its first line in this state, which is exactly why he could not preload.
  ok((await evaluate(cdp, 'window.__srv.calls.prerender')) === 1, '🔴 Preload asks the server even with "pre-render new messages" off');
  ok(
    (await evaluate(cdp, 'SillyTavern.getContext().extensionSettings.vocalis.preRender')) === false,
    'and it does not switch that setting on behind his back',
  );
  await evaluate(cdp, 'SillyTavern.getContext().extensionSettings.vocalis.preRender = true');

  // ── 5. 7.4 §18b: autoplay from here on ───────────────────────────────────
  //
  // The selected message starts autoplay, and later messages continue through the real menu and
  // stream stub.
  await evaluate(
    cdp,
    `
        window.__played = [];
        const b0 = document.querySelector('#chat .mes[mesid="0"] .vocalis_narrate');
        b0.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, shiftKey: true, button: 0}));
        b0.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}));  // see above
    `,
  );
  await waitFor(cdp, `!!document.querySelector('.vocalis_scene_menu')`, 8000);
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.vocalis_scene_menu_item')]
        .find(el => /Autoplay from here on/.test(el.textContent)).click()`,
  );
  await waitFor(cdp, `(window.__played || []).length === 1`, 8000);
  ok((await evaluate(cdp, 'window.__played')).length === 1, 'Autoplay starts playing at the message it was asked from');
  // 🔴 THE CHAIN. Ending one message has to start the next with no click anywhere.
  await evaluate(cdp, `window.__stream.opts.onEnded()`);
  await waitFor(cdp, `(window.__played || []).length === 2`, 8000);
  const chained = await evaluate(cdp, 'window.__played');
  ok(chained.length === 2 && chained[1] !== chained[0], `🔴 it walks on to the next message by itself (${chained.length} played)`);
  // The rail is the only thing on screen that says the mode is on.
  ok(
    await evaluate(cdp, `document.querySelectorAll('#chat .mes.vocalis_autoplay').length > 0`),
    'and the messages it still has to read are marked',
  );
  // 🔴 EVERY STOP PATH ENDS IT — this is the ⏹ toggle, the one a listener actually presses.
  // NOTE: no backticks in here — it is a template literal (the trap this file's stub records).
  await evaluate(
    cdp,
    `(() => {
        const playing = document.querySelector('#chat .mes .vocalis_narrate.fa-stop');
        (playing || document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate')).click();
    })()`,
  );
  const beforeStop = (await evaluate(cdp, 'window.__played')).length;
  await evaluate(cdp, `window.__stream.opts.onEnded()`);
  // 🔴 ANCHOR THE ABSENCE TO THE EVENT, NOT TO A STOPWATCH. This was a bare `sleep(400)`, which
  // is a guess about when the stop handler runs — and if it ran LATE, the absence check below
  // passed for the wrong reason: nothing had started the next clip yet because nothing had
  // finished stopping the current one.
  //
  // The stop has an observable half — the autoplay marks coming off — so wait for that first.
  // Once it holds, the handler has demonstrably run, and "nothing played" is a statement about
  // the code rather than about the scheduler.
  ok(await waitFor(cdp, `document.querySelectorAll('#chat .mes.vocalis_autoplay').length === 0`, 5000), 'and the marks come off with it');
  // ⚠️ AND THEN UNTIL NOTHING IS SCHEDULED, because "it did not start the next one" is still an
  // absence and a chained start could be a timer behind the repaint. This was `sleep(pollMs / 4)`,
  // margin after a known event; the margin is now "every timer the extension had armed has run".
  await settle();
  ok(
    (await evaluate(cdp, 'window.__played')).length === beforeStop,
    '🔴 pressing stop ends the chain — it does not fall silent and then start the next one',
  );

  // ── 6. 7.4 §18c: the stop icon on a message that was re-created ──────────
  //
  // A playing message may leave the viewport and return with a freshly rendered stop control.
  //
  // 🔴 THE COLOR WAS RECONCILED AND THE GLYPH WAS NOT. Chat windowing removes the row and the
  // one that comes back is built from the template, wearing a speaker — while `current` still
  // says that message is playing. Checked exactly the way 2c checks the color, because it is
  // the same event with a different axis.
  await evaluate(
    cdp,
    `
        window.__played = [];
        document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').click();
    `,
  );
  await waitFor(cdp, `(window.__played || []).length === 1`, 8000);
  await evaluate(cdp, `window.__stream.opts.onPlaying(document.createElement('audio'))`);
  await waitFor(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('fa-stop')`, 8000);
  ok(
    await evaluate(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('fa-stop')`),
    'a playing message shows the stop icon (the control)',
  );
  const back = await evaluate(
    cdp,
    `(() => {
        const row = document.querySelector('#chat .mes[mesid="1"]');
        const chat = document.getElementById('chat');
        row.remove();                                     // scrolled out of the window
        const fresh = row.cloneNode(true);                // …and repainted on the way back
        fresh.querySelector('.vocalis_narrate').className =
            'mes_button vocalis_narrate fa-solid fa-volume-high';    // as ST paints it: a speaker
        chat.appendChild(fresh);
        return fresh.querySelector('.vocalis_narrate').className;
    })()`,
  );
  ok(!back.includes('fa-stop'), 'precondition: the row comes back wearing a speaker');
  await waitFor(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('fa-stop')`, 15000);
  ok(
    await evaluate(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('fa-stop')`),
    '🔴 a message that was re-created WHILE PLAYING gets its stop icon back',
  );

  // ── 6b. 🔴 the GREEN SPEAKER — the same bug through a repaint, not a mutation ────────────
  //
  // Repainting the button can preserve its color while losing the stop glyph; reconcile both states.
  //
  // 🔴 GREEN SPEAKER IS THE DIAGNOSIS. The color is reconciled on every repaint and the glyph
  // was not, so a button rebuilt inside an existing row comes back wearing the right color and
  // the wrong icon. This drives exactly that: replace the BUTTON (leaving `#chat`'s children
  // alone, so the MutationObserver never fires and the sweep's reconcile cannot save it), then
  // let an ordinary state update paint it. Nothing here scrolls, and nothing is removed.
  const repainted = await evaluate(
    cdp,
    `(() => {
        const slot = document.querySelector('#chat .mes[mesid="1"] .extraMesButtons');
        slot.innerHTML = '<div class="mes_button vocalis_narrate fa-solid fa-volume-high '
                       + 'vocalis_cached interactable" tabindex="0"></div>';   // green speaker
        return slot.querySelector('.vocalis_narrate').className;
    })()`,
  );
  ok(
    !repainted.includes('fa-stop') && repainted.includes('vocalis_cached'),
    'precondition: the rebuilt button is a GREEN SPEAKER, exactly as he described it',
  );
  await evaluate(cdp, `window.__srv.script = [[{state:'cached'}]]; window.__emit('message_updated', 1)`);
  await waitFor(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('fa-stop')`, 15000);
  ok(
    await evaluate(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('fa-stop')`),
    '🔴 a repaint of the PLAYING message keeps the stop icon — no green speaker',
  );
  // ⚠️ WAIT FOR THE COLOR SEPARATELY, and the reason is the product being right: an edit drops
  // that message's state (its text changed, so whatever audio we had describes a line that no
  // longer exists) and re-probes for it. The glyph is reasserted in the same turn as the
  // repaint; the color cannot come back until the server answers. Sampling both at the
  // glyph's moment reads orange and fails a check about the fix having trampled the color —
  // which it had not.
  await waitFor(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('vocalis_cached')`, 15000);
  ok(
    await evaluate(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('vocalis_cached')`),
    'and it is still green — the color axis is untouched by the fix',
  );
  ok(
    await evaluate(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').classList.contains('fa-stop')`),
    'and the stop icon survived the color landing on top of it',
  );
  await evaluate(cdp, `document.querySelector('#chat .mes[mesid="1"] .vocalis_narrate').click()`);

  // ── 7. 🔴 9.1 §1 — THE YELLOW BAND, AND THE RED SQUARE THAT IS NOT THE SAME THING ───
  //
  // Keep a visible row marker for the message whose playback is active so it remains easy to
  // locate while scrolling through the chat.
  //
  // st_button_colors_spec.mjs asks Chrome what `.vocalis_speaking` PAINTS. It cannot notice
  // that no code path ever adds the class — which is the exact hole this whole file exists to
  // close, stated in its own header. So this drives the real client through the four moments
  // the band has to survive: it appears, it stays through a PAUSE, it comes back after the row
  // is destroyed and rebuilt, and it goes when playback stops.
  const bandRows = `[...document.querySelectorAll('#chat .mes.vocalis_speaking')].map(r => r.getAttribute('mesid'))`;
  const isAudible = id =>
    evaluate(cdp, `document.querySelector('#chat .mes[mesid="${id}"] .vocalis_narrate').classList.contains('vocalis_audible')`);

  // ⚠️ A CONDITION, NOT AN ASSUMPTION: the click that closed 6b stops playback
  // asynchronously enough that reading the DOM on the next line is a race, and a race in a
  // PRECONDITION is the worst place for one — it fails naming the wrong subject.
  await waitFor(cdp, `${bandRows}.length === 0`, 8000);
  ok((await evaluate(cdp, bandRows)).length === 0, 'precondition: with nothing loaded, no row wears the band');

  // 🔴 THE FAKE IS AN EventTarget WITH A WRITABLE `paused`, AND THAT IS THE REAL CONTRACT.
  // A real `<audio>` would be worse here, not better: `paused` is read-only, so the only way to
  // move it is genuine playback, which headless autoplay policy may refuse — and the spec would
  // then be measuring Chrome's policy. What index.js actually depends on is three things, all
  // of them present here: `.paused`, and the element's own `play`/`pause` events. That IS what
  // SillyTavern's transport bar does to it (`audio-player.js` `pause()` calls
  // `this.audio.pause()` on the element and tells us nothing).
  await evaluate(
    cdp,
    `
        window.__played = [];
        window.__fakeAudio = Object.assign(new EventTarget(), { paused: false });
        document.querySelector('#chat .mes[mesid="0"] .vocalis_narrate').click();
    `,
  );
  await waitFor(cdp, `(window.__played || []).length === 1`, 8000);
  await evaluate(cdp, `window.__stream.opts.onPlaying(window.__fakeAudio)`);
  await waitFor(cdp, `${bandRows}.length === 1`, 8000);

  const wearing = await evaluate(cdp, bandRows);
  ok(wearing.length === 1 && wearing[0] === '0', `🔴 the loaded message's ROW wears the band, and only it (${JSON.stringify(wearing)})`);
  ok(await isAudible(0), 'and its button is marked AUDIBLE — the red square');

  // Pausing clears the audible indicator but keeps the speaking-row band while the stop control
  // remains available.
  await evaluate(cdp, `window.__fakeAudio.paused = true; window.__fakeAudio.dispatchEvent(new Event('pause'))`);
  await waitFor(cdp, `!document.querySelector('#chat .mes[mesid="0"] .vocalis_narrate').classList.contains('vocalis_audible')`, 8000);
  ok(!(await isAudible(0)), 'pausing takes the red off the stop square…');
  ok(
    (await evaluate(cdp, bandRows)).join() === '0',
    '🔴 …and the band STAYS THROUGH THE PAUSE — the landmark has to be there when he comes looking',
  );
  ok(
    await evaluate(cdp, `document.querySelector('#chat .mes[mesid="0"] .vocalis_narrate').classList.contains('fa-stop')`),
    'and the stop square is still a stop square, which is what the band is keyed to',
  );

  await evaluate(cdp, `window.__fakeAudio.paused = false; window.__fakeAudio.dispatchEvent(new Event('play'))`);
  await waitFor(cdp, `document.querySelector('#chat .mes[mesid="0"] .vocalis_narrate').classList.contains('vocalis_audible')`, 8000);
  ok(await isAudible(0), 'and resuming brings the red back');

  // 🔴 THE 7.4 §18c FAILURE, ON THE NEW AXIS. The fork's chat windowing destroys a row that
  // scrolls out and builds a fresh one from the template on the way back, wearing no class
  // anyone set. That is what made the stop GLYPH vanish on the one message he was trying to
  // find; a band painted once at playback start would reproduce it exactly — in the feature
  // whose entire purpose is to survive a scroll.
  const stripped = await evaluate(
    cdp,
    `(() => {
        const row = document.querySelector('#chat .mes[mesid="0"]');
        const chat = document.getElementById('chat');
        row.remove();
        const fresh = row.cloneNode(true);
        fresh.classList.remove('vocalis_speaking');                      // as ST rebuilds it
        fresh.querySelector('.vocalis_narrate').className =
            'mes_button vocalis_narrate fa-solid fa-volume-high';
        chat.insertBefore(fresh, chat.firstChild);
        return fresh.className;
    })()`,
  );
  ok(!stripped.includes('vocalis_speaking'), 'precondition: the rebuilt row comes back with no band');
  await waitFor(cdp, `${bandRows}.join() === '0'`, 15000);
  ok(
    (await evaluate(cdp, bandRows)).join() === '0',
    '🔴 a row re-created WHILE LOADED gets its band back — the reconcile covers it, not just the glyph',
  );

  // And it goes. A marker with no off switch is worse than none: every row he scrolled past
  // would end up yellow.
  await evaluate(cdp, `document.querySelector('#chat .mes[mesid="0"] .vocalis_narrate').click()`);
  await waitFor(cdp, `${bandRows}.length === 0`, 8000);
  ok((await evaluate(cdp, bandRows)).length === 0, 'pressing stop takes the band off');
  ok(!(await isAudible(0)), 'and the red with it');

  // ── 9. 9.5.10 §18d: PRELOAD FROM HERE ON ─────────────────────────────────
  //
  // Shift-click starts a sequential preload from the selected message through newer messages.
  //
  // 🔴 THE CONTRACT IS THE ORDER, NOT THE COUNT, and that is why the stub records the text of
  // every submit. The server takes four waiting jobs and refuses the fifth (`prerender.py`
  // MAX_QUEUE), so the only thing standing between this feature and "preloads five messages and
  // stops" is that a `declined` makes the walk WAIT ON THAT MESSAGE and ask again. A spec that
  // counted requests would pass on a chain that skipped every refused message — which is the
  // exact bug.
  //
  // Driven through the real menu with "Pre-render new messages" OFF: every submit below can then
  // only have come from the chain, and the automatic path cannot lend it a request it never
  // made. That is also the state the row exists for — the checkbox being off is what leaves a
  // chat full of orange in the first place.
  if (!retryMs)
    throw new Error('could not read PRELOAD_RETRY_MS out of index.js — the two quiet ' + 'windows below would be unanchored guesses');
  await evaluate(
    cdp,
    `
        SillyTavern.getContext().extensionSettings.vocalis.preRender = false;
        window.__srv.script = [];            // every probe answers "none": nothing here is cached
        window.__srv.prerenderAsked = [];
        window.__srv.prerenderReply = { cache_key: 'k-chain', state: 'queued', queued: 1 };
    `,
  );
  const anchor = await evaluate(
    cdp,
    `(() => {
        const c = SillyTavern.getContext();
        const chat = document.getElementById('chat');
        const add = (text, isUser) => {
            c.chat.push(isUser ? { mes: text, name: 'Test User', is_user: true } : { mes: text, name: 'Test Character' });
            const id = c.chat.length - 1;
            const row = document.createElement('div');
            row.className = 'mes';
            row.setAttribute('mesid', String(id));
            row.innerHTML = '<div class="mes_block"><div class="mes_text"></div>'
                          + '<div class="mes_buttons"><div class="extraMesButtons">'
                          + '<div class="mes_button vocalis_narrate fa-solid fa-volume-high"></div>'
                          + '</div></div></div>';
            row.querySelector('.mes_text').textContent = text;
            chat.appendChild(row);
            return id;
        };
        window.__chain = [
            add('CHAIN one, the message he shift-clicked on.'),
            add('CHAIN mine, the user line nothing may ever speak.', true),
            add('CHAIN two, the next character line after it.'),
            add('CHAIN three, the last one already in the chat.'),
        ];
        return window.__chain[0];
    })()`,
  );
  // The second submit is REFUSED with a full queue — back-pressure, not a no.
  await evaluate(cdp, `window.__srv.prerenderScript = [{ cache_key: 'c1', state: 'queued', queued: 1 }, { state: 'declined', queued: 4 }]`);
  const shiftOpen = async id => {
    await evaluate(
      cdp,
      `(() => {
          const b = document.querySelector('#chat .mes[mesid="' + ${id} + '"] .vocalis_narrate');
          b.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, shiftKey: true, button: 0}));
          b.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}));   // section 4's note
          return true;
      })()`,
    );
    return waitFor(cdp, `!!document.querySelector('.vocalis_scene_menu')`, 8000);
  };
  const menuLabels = () => evaluate(cdp, `[...document.querySelectorAll('.vocalis_scene_menu_item')].map(el => el.textContent)`);
  const clickRow = re =>
    evaluate(
      cdp,
      `(() => {
          const row = [...document.querySelectorAll('.vocalis_scene_menu_item')].find(el => ${re}.test(el.textContent));
          if (!row) return false;
          row.click();
          return true;
      })()`,
    );

  ok(await shiftOpen(anchor), 'the shift-click menu opens on the message he pointed at');
  const chainRows = await menuLabels();
  ok(
    chainRows.some(t => /Preload from here on/.test(t)),
    `the menu offers Preload from here on (${chainRows.join(' | ')})`,
  );
  // 🔴 AND THE DIGITS DID NOT MOVE. Keep the existing Add and Remove shortcuts in place when
  // inserting the new menu row; changing their positions would silently rebind those keys.
  ok(
    chainRows[4].includes('Add to current scene') && chainRows[5].includes('Remove from current scene'),
    `🔴 5 is still Add and 6 is still Remove (${chainRows[4]} / ${chainRows[5]})`,
  );
  ok(await clickRow('/Preload from here on/'), 'the row is there to be pressed');

  // Two submits: the anchor, then the next CHARACTER line — his own message is stepped over.
  await waitFor(cdp, `(window.__srv.prerenderAsked || []).length === 2`, 8000);
  const firstTwo = await evaluate(cdp, 'window.__srv.prerenderAsked');
  ok(/CHAIN one/.test(firstTwo[0]), `it starts AT the message he shift-clicked (${firstTwo[0]})`);
  ok(
    /CHAIN two/.test(firstTwo[1]) && !firstTwo.some(t => /CHAIN mine/.test(t)),
    `🔴 and walks forward past his own line without speaking it (${firstTwo[1]})`,
  );

  // 🔴 THE REFUSED ONE IS RE-SENT, NOT SKIPPED. This is the whole feature: `declined` means the
  // queue is full, and a walk that advanced through it would leave a hole in the run that nothing
  // would ever fill — the button orange, the chain reporting success.
  // (The deadline only bounds a hang: the retry is one real `retryMs` timer, so it was `retryMs * 3`.)
  ok(await waitFor(cdp, `(window.__srv.prerenderAsked || []).length >= 3`, retryMs + 30000), 'the chain asks again after a full queue');
  const afterRetry = await evaluate(cdp, 'window.__srv.prerenderAsked');
  ok(afterRetry[2] === afterRetry[1], `🔴 the message the server refused is the one it re-sends (${afterRetry[2]})`);

  // …and then it carries on to the end of the chat.
  ok(await waitFor(cdp, `(window.__srv.prerenderAsked || []).length === 4`, 8000), 'and moves on once that one is taken');
  const walked = await evaluate(cdp, 'window.__srv.prerenderAsked');
  ok(/CHAIN three/.test(walked[3]), `the last message in the chat is reached (${walked[3]})`);
  // Was `sleep(pollMs)`: an absence ("the walk does not loop") judged after a guessed second. The
  // walk's only way to send again is a timer (the retry) or a new reply; with no timer armed it has
  // nothing left to do, so the check waits for exactly that and then counts.
  await settle();
  ok(
    (await evaluate(cdp, 'window.__srv.prerenderAsked')).length === 4,
    'and it stops there — the walk does not loop over what it has sent',
  );

  // 🔴 ARMED AT THE END, which is the "on" half of "from here on". Nothing else in this
  // configuration would touch a new reply: the checkbox is off, which is why the row exists.
  await evaluate(
    cdp,
    `(() => {
        const c = SillyTavern.getContext();
        const text = 'CHAIN four, a reply that arrived after the walk finished.';
        c.chat.push({ mes: text, name: 'Test Character' });
        const id = c.chat.length - 1;
        const row = document.createElement('div');
        row.className = 'mes';
        row.setAttribute('mesid', String(id));
        row.innerHTML = '<div class="mes_block"><div class="mes_text"></div>'
                      + '<div class="mes_buttons"><div class="extraMesButtons">'
                      + '<div class="mes_button vocalis_narrate fa-solid fa-volume-high"></div>'
                      + '</div></div></div>';
        row.querySelector('.mes_text').textContent = text;
        document.getElementById('chat').appendChild(row);
        window.__emit('character_message_rendered', id);
        return id;
    })()`,
  );
  ok(await waitFor(cdp, `(window.__srv.prerenderAsked || []).length === 5`, 8000), '🔴 a new reply is preloaded by the armed chain');
  ok(
    (await evaluate(cdp, 'SillyTavern.getContext().extensionSettings.vocalis.preRender')) === false,
    'and it did not switch "Pre-render new messages" on behind his back',
  );

  // The off switch, and it has to be findable: the row is the only place the mode is visible.
  ok(await shiftOpen(anchor), 'the menu reopens while the chain is armed');
  const armedRows = await menuLabels();
  ok(
    armedRows.some(t => /Stop preloading/.test(t)),
    `the row becomes Stop preloading (${armedRows.join(' | ')})`,
  );
  ok(await clickRow('/Stop preloading/'), 'and it can be pressed');
  await evaluate(
    cdp,
    `(() => {
        const c = SillyTavern.getContext();
        c.chat.push({ mes: 'CHAIN five, which arrives after he stopped it.', name: 'Test Character' });
        window.__emit('character_message_rendered', c.chat.length - 1);
        return true;
    })()`,
  );
  await settle(); // was `sleep(pollMs)`: anything the stopped chain or the new reply scheduled has run
  ok((await evaluate(cdp, 'window.__srv.prerenderAsked')).length === 5, '🔴 STOP MEANS STOP — a reply arriving after it is not preloaded');

  // 🔴 `declined` WITH AN EMPTY QUEUE IS THE SWITCH, NOT BACK-PRESSURE. The server declines for
  // two reasons and only one of them is worth waiting on; polling a box whose pre-rendering is
  // OFF would be a request every four seconds until the tab closes, and the run would never move.
  await evaluate(
    cdp,
    `
        window.__srv.prerenderAsked = [];
        window.__srv.prerenderScript = [{ state: 'declined', queued: 0 }];
    `,
  );
  ok(await shiftOpen(anchor), 'the menu reopens to start it again');
  await clickRow('/Preload from here on/');
  await waitFor(cdp, `(window.__srv.prerenderAsked || []).length === 1`, 8000);
  // Was `sleep(retryMs * 2)` ("anchored to the retry interval"). A chain that wrongly retried would
  // have a retry timer armed; waiting for no armed timer runs it, and the request it makes shows in
  // the count below. (The retry timer is tracked because the page's cap is the larger of POLL_MS
  // and PRELOAD_RETRY_MS.)
  await settle();
  ok(
    (await evaluate(cdp, 'window.__srv.prerenderAsked')).length === 1,
    '🔴 a server with pre-rendering switched off is asked ONCE, not on a four-second loop',
  );
  ok(await shiftOpen(anchor), 'the menu reopens after the chain gave up');
  const endedRows = await menuLabels();
  ok(
    endedRows.some(t => /Preload from here on/.test(t)) && !endedRows.some(t => /Stop preloading/.test(t)),
    `and the mode really ended — the row offers to start it again (${endedRows.join(' | ')})`,
  );
  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`);
} catch (e) {
  console.error(`  FAIL ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

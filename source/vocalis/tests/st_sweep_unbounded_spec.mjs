// Vocalis 6.0 §6.1 — what the sweep costs when chat windowing is OFF, MEASURED.
//
// §6.1 shrank when the fork added `showMessageWindow`: the
// worst case became 500 painted messages instead of 4,260, and it stopped scaling with how far
// back you jump. But `chat_truncation: 0` still means UNLIMITED and turns windowing off
// entirely, so the unbounded path survives for anyone who deliberately set it. The design's
// instruction for m1 is therefore a check, not a build:
//
//   > Confirm the sweep degrades sanely there, and confirm the reconciliation holds when the
//   > window drops the far edge mid-scroll. Measure this path before adopting viewport-bounded
//   > probing.
//
// "Sanely" is not a thing a test can assert, so this measures the three quantities that decide
// it and prints them, and asserts only the properties that must hold at ANY size:
//
//   1. the client CHUNKS to the server's cap — ceil(N/200) requests, never one oversized batch
//      that the route would 400 (and that 400 would blank every color on screen);
//   2. `substituteParams` runs ONCE PER MESSAGE, not once per sweep — the `cleaned` memo is
//      keyed on raw text, and without it a poll cycle would re-clean the whole chat every
//      second, and non-deterministic macros would mint a fresh cache key each time;
//   3. a settled chat costs ZERO further requests, so the unbounded cost is paid once per load
//      rather than continuously.
//
// Usage: node st_sweep_unbounded_spec.mjs <extension-dir> <shim-path> <chrome-path> [N]
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { TIMERS_DRAINED, trackTimers } from './_specwait.mjs';

const [extDir, shimPath, chromePath, nArg] = process.argv.slice(2);
if (!extDir || !shimPath || !chromePath) {
  console.error('usage: node st_sweep_unbounded_spec.mjs <ext-dir> <shim> <chrome> [N]');
  process.exit(2);
}
// 2,000 by default: comfortably past the 200-item cap and the 500-message window, big enough
// for the per-message costs to be legible, small enough to stay a test rather than a benchmark.
const N = Number(nArg || 2000);

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

// 🔴 A CONDITION, NOT A DURATION. This file had no wait helper, so it timed the things it could
// have watched. See tests/st_scene_range_spec.mjs for the same fix.
async function waitFor(cdp, expression, timeoutMs = 15000) {
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

// The page paints ALL N messages at once — which is exactly what `chat_truncation: 0` plus a
// `/chat-jump` does, and what the fork's windowed view exists to stop.
// Read before PAGE is built: the page's timer tracking below needs the extension's poll interval.
const indexJs = await readFile(join(extDir, 'index.js'), 'utf-8');
const pollMs = Number(/const POLL_MS = (\d+)/.exec(indexJs)?.[1] ?? 0);

const PAGE = `<!doctype html><meta charset="utf-8">
<div id="extensions_settings2"></div>
<div id="message_template"><div class="mes_buttons"><div class="extraMesButtons"></div></div></div>
<div id="chat"></div>
<script type="module">
  import { installJQuery, fireReady } from '/st_dom_shim.js';
  installJQuery(window);
  window.toastr = { error(){}, success(){}, info(){}, warning(){} };

  // 🔴 WHICH OF THE EXTENSION'S TIMERS ARE STILL PENDING — the signal for "nothing is scheduled any
  // more", which is what "a settled chat makes no further requests" is really about. That check
  // used to be a sleep of three poll intervals between two reads of the request counter, a bet on how long
  // the machine takes to run a timer the check is afraid of. Every setTimeout / setInterval of
  // POLL_MS or less that the page code sets is counted from set until it fires or is cleared (an
  // interval until it is cleared), so "pending() === 0" means no sweep debounce and no state poll
  // is armed — and if one WERE armed, the wait for zero would run it and the request it makes
  // would then be seen. Longer timers (the probe back-off, the import interval) are not counted.
  // The wrapper is installed BEFORE the extension is imported so it sees every timer it sets.
  // NO BACKTICKS IN THIS BLOCK: it is inside a template literal.
  ${trackTimers(pollMs)}

  const N = ${N};
  window.__srv = { calls: { prerender: 0, states: 0 }, batchSizes: [], cleans: 0,
                   prerenderReply: { cache_key: 'k', state: 'queued' } };

  const chatArr = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < N; i++) {
      chatArr.push({ mes: 'Message number ' + i + ', long enough to be worth rendering aloud.',
                     name: 'Test Character' });
      const row = document.createElement('div');
      row.className = 'mes';
      row.setAttribute('mesid', String(i));
      row.innerHTML = '<div class="mes_block"><div class="mes_text">line ' + i + '</div>' +
                      '<div class="mes_buttons"><div class="extraMesButtons"></div></div></div>';
      frag.appendChild(row);
  }
  document.getElementById('chat').appendChild(frag);

  const listeners = new Map();
  const ctxStub = {
      chat: chatArr,
      extensionSettings: { vocalis: { enabled: true, autoNarrate: false, preRender: false,
                                      serverUrl: 'https://stub.invalid' } },
      saveSettingsDebounced() {},
      // 🔴 COUNTED. This is the expensive per-message call — it is what runs the macro
      // engine over every line — and the whole question of whether the memo works is
      // "how many times did this run for N messages".
      substituteParams: (s) => { window.__srv.cleans++; return s; },
      eventSource: { on(){}, emit(){ return Promise.resolve(); } },
      event_types: {
          CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
          USER_MESSAGE_RENDERED: 'user_message_rendered',
          CHAT_LOADED: 'chat_loaded', MORE_MESSAGES_LOADED: 'more_messages_loaded',
          CHAT_CHANGED: 'chat_changed', GROUP_UPDATED: 'group_updated',
          MESSAGE_SWIPED: 'message_swiped', MESSAGE_DELETED: 'message_deleted',
          MESSAGE_EDITED: 'message_edited', MESSAGE_UPDATED: 'message_updated',
      },
  };
  ctxStub.eventSource.on = (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
  };
  window.SillyTavern = { getContext: () => ctxStub };
  window.__emit = (type, ...a) => Promise.all((listeners.get(type) ?? []).map(f => f(...a)));

  // 🔴 CAPTURE WHY BOOT FAILED. Without this, a throw in the import or in init is swallowed
  // by the module's own rejection and the only symptom is __booted staying false - the spec
  // then reports "never finished init" with no reason, which is a debugging session spent
  // rediscovering a stack trace the browser already had. (7.0-m2: this is how a stray
  // backtick inside a template literal in index.js was found.)
  // NOTE: inside a TEMPLATE LITERAL - no backticks, no dollar-brace in this block.
  try {
      await import('/index.js');
      await fireReady();
      window.__booted = true;
  } catch (e) {
      window.__bootError = String((e && e.stack) || e);
  }
</script>`;

// The transport stub records the SHAPE of every batch — the real fetchStates chunks to
// MAX_STATE_ITEMS, and this is where a client that stopped chunking would show up.
const STREAM_STUB = `
const MAX_STATE_ITEMS = 200;
export async function prerender() { window.__srv.calls.prerender++; return window.__srv.prerenderReply; }
export async function fetchStates(url, items) {
    const s = window.__srv;
    const out = [];
    for (let i = 0; i < items.length; i += MAX_STATE_ITEMS) {
        const batch = items.slice(i, i + MAX_STATE_ITEMS);
        s.calls.states++;
        s.batchSizes.push(batch.length);
        out.push(...batch.map(() => ({ state: 'cached' })));
    }
    return out;
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
export function playStream() { return { stop() {} }; }
`;

const BAR_STUB = `export function showNarrationPlayerBar() {}
export function hideNarrationPlayerBar() {}`;

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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-sweep-'));
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

try {
  await cdp.send('Page.navigate', { url: origin });
  let booted = false;
  for (let i = 0; i < 300 && !booted; i++) {
    await sleep(100);
    booted = await evaluate(cdp, 'window.__booted === true').catch(() => false);
  }
  ok(booted, `the extension boots against ${N} painted messages`);
  if (!booted) {
    const why = await evaluate(cdp, 'window.__bootError || \"(no error captured)\"').catch(() => '(unreadable)');
    throw new Error('extension never finished init - ' + why);
  }

  // ── the unbounded sweep, timed ───────────────────────────────────────────
  //
  // 🔴 THE COUNTERS ARE NOT RESET HERE, AND THAT REMOVED A RACE THAT FAILED THIS SPEC TWICE IN A
  // FULL SUITE WHILE PASSING ALONE. The page's own boot block is
  // `await import('/index.js'); await fireReady(); window.__booted = true;` — `fireReady()` is
  // awaited but THE SWEEP IT STARTS IS NOT. So a reset placed after `__booted` lands at an
  // arbitrary point relative to in-flight sweep work: on an idle box the requests arrive after the
  // reset and are counted, and under load they arrive BEFORE it and the reset throws away the only
  // evidence of the very sweep this is measuring. The symptom was `0 requests for 2000 messages`
  // with all 2000 buttons green — which is not a broken client, it is this spec having deleted the
  // count and then asked for it.
  //
  // 📌 COUNTING FROM PAGE LOAD IS STRICTLY STRONGER, WHICH IS WHY IT IS THE FIX RATHER THAN A
  // TOLERANCE. `cleans === N` now means "substituteParams ran once per message across the whole
  // page lifetime" instead of "within one arbitrarily chosen window", so a memo that failed to
  // hold ACROSS the boot sweep and `chat_loaded` — invisible before — now fails this line. No
  // assertion was relaxed and nothing was skipped.
  //
  // ⚠️ `chat_loaded` is still emitted, because the sweep at that event is this file's subject. A
  // settled chat costs zero further requests (assertion 3 below), so it adds nothing to the totals
  // when the boot sweep has already run — which is the behavior, not a workaround for it.
  const t0 = Date.now();
  await evaluate(cdp, `window.__emit('chat_loaded')`);
  let calls = 0;
  const want = Math.ceil(N / 200);
  for (let i = 0; i < 600; i++) {
    // up to 60 s
    await sleep(100);
    calls = await evaluate(cdp, 'window.__srv.calls.states');
    if (calls >= want) break;
  }
  const elapsed = Date.now() - t0;
  const cleans = await evaluate(cdp, 'window.__srv.cleans');
  const sizes = await evaluate(cdp, 'JSON.stringify(window.__srv.batchSizes)');
  const painted = await evaluate(cdp, `document.querySelectorAll('#chat .vocalis_narrate.vocalis_cached').length`);

  console.log(`\n  MEASURED at chat_truncation: 0, ${N} messages painted at once:`);
  console.log(`    /v1/audio/state requests : ${calls}   (batches ${sizes})`);
  console.log(`    substituteParams calls   : ${cleans}`);
  console.log(`    buttons painted green    : ${painted}`);
  // ⚠️ WHAT THIS NUMBER IS, SINCE THE RESET WENT AWAY: the wait from `chat_loaded` until the
  // request count was already satisfied — which is ~0 ms whenever the boot sweep got there first.
  // It is NOT the sweep's own cost and must not be quoted as one; the sweep may have finished
  // before this clock started. Printed, never asserted.
  console.log(`    wait after chat_loaded   : ${elapsed} ms (in headless Chrome, stub server)\n`);

  ok(calls === want, `the client CHUNKS: ${calls} requests for ${N} messages (${want} expected at 200/batch)`);
  ok(
    JSON.parse(sizes).every(n => n <= 200),
    'no batch exceeds the route cap — an oversized one 400s and blanks every color',
  );
  ok(cleans === N, `substituteParams ran ONCE PER MESSAGE (${cleans} for ${N}) — the cleaned memo holds`);
  ok(painted === N, `all ${N} buttons ended green (${painted})`);

  // ── and then it shuts up ─────────────────────────────────────────────────
  // The unbounded cost must be paid ONCE per load. If a settled chat kept re-probing, the
  // 4,260-message case would not be a slow load, it would be a permanent load.
  // 🔴 THE ABSENCE IS ANCHORED TO WHAT COULD BREAK IT, NOT TO A STOPWATCH (2026-10-12). This was
  // `sleep(pollMs * 3)` between two reads of the request counter: three poll intervals of real
  // time, "comfortably longer than one tick" — and on a starved box three intervals can hold no
  // tick at all, so a poll that never stopped would still pass. What makes a request happen after
  // the chat has settled is an ARMED TIMER (a sweep debounce or a poll tick), and the page reports
  // exactly that (__timersPending). The wait is for the count to reach zero: a poll that never
  // stops keeps re-arming, the count never reaches zero, and the check fails; one that stops
  // leaves nothing that can fire. The counter is read before and after anyway.
  if (!pollMs) throw new Error('could not read POLL_MS out of index.js — the timers below ' + 'would not be tracked');
  const stoppedDead = await waitFor(cdp, TIMERS_DRAINED, 30000);
  const settled = await evaluate(cdp, 'window.__srv.calls.states');
  const pendingNow = await evaluate(cdp, 'window.__timersPending()');
  const after = await evaluate(cdp, 'window.__srv.calls.states');
  if (!stoppedDead || pendingNow !== 0) console.error(`  (still armed: ${pendingNow} timer(s) pending)`);
  ok(
    stoppedDead && pendingNow === 0 && after === settled,
    `a settled chat makes no further requests (${settled} -> ${after}), so the cost is paid once`,
  );

  // ── the reconciliation, at the far edge ──────────────────────────────────
  // §6.1's second half. The window drops rows; the row that comes back is a NEW element
  // wearing no class. It must repaint from memory and cost NOTHING.
  const before = await evaluate(cdp, 'window.__srv.calls.states');
  await evaluate(
    cdp,
    `(() => {
        const chat = document.getElementById('chat');
        const rows = [...chat.querySelectorAll('.mes')].slice(0, 300);   // the far edge
        rows.forEach(r => r.remove());
        for (const r of rows) {
            const fresh = r.cloneNode(true);
            fresh.querySelector('.vocalis_narrate').className =
                'mes_button vocalis_narrate fa-solid fa-volume-high';    // as ST repaints it
            chat.insertBefore(fresh, chat.firstChild);
        }
    })()`,
  );
  await waitFor(cdp, `document.querySelectorAll('#chat .vocalis_narrate.vocalis_cached').length === ${N}`, 15000);
  const repainted = await evaluate(cdp, `document.querySelectorAll('#chat .vocalis_narrate.vocalis_cached').length`);
  const afterReturn = await evaluate(cdp, 'window.__srv.calls.states');
  ok(repainted === N, `🔴 300 messages dropped and re-added are all still green (${repainted}/${N})`);
  ok(afterReturn === before, `and it cost no request (${before} -> ${afterReturn}) — repainted from what we knew`);
} catch (e) {
  console.error(`  FAIL ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

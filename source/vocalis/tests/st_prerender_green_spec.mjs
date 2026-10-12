// Vocalis 8.1 — GREEN MEANS CACHED, AND IT STAYS GREEN UNTIL THE TEXT CHANGES.
//
// A cached pre-render remains green until its text changes; adding another rendered message must
// not invalidate the earlier cached state.
//
// 🔴 THE DEFECT, AND IT IS A MISSING LINE RATHER THAN A WRONG ONE.
// `onCharacterMessageRendered` calls `forgetState(mesId)` — which paints the button ORANGE
// immediately — on the correct reasoning that a regenerated message's old green describes audio
// of text that no longer exists. It then re-probes ONLY when the message is the last one:
//
//     forgetState(mesId);
//     if (autoNarrate || autoChain) { narrateMessage(mesId); return; }
//     if (mesId === ctx().chat.length - 1) prerenderMessage(mesId);   // <- the only recovery
//
// Every OTHER path that forgets a state — `onMessageSwiped`, `onMessageEdited`, `cancelGesture`
// — calls `scheduleSweep()` straight after, precisely so the color is re-asked. This one does
// not. So any CHARACTER_MESSAGE_RENDERED for a message that is not the newest strips the green
// and nothing ever puts it back: the sweep only probes ids it has NO state for, and this id has
// no state, but nothing schedules the sweep. It sits orange until a chat load or a scroll-back
// happens to run one.
//
// ⚠️ AND THE FORGET IS TOO BROAD EVEN WHEN IT IS RECOVERED. The reason to drop the color is
// that the TEXT CHANGED. ST fires this event on re-renders that change nothing — and dropping a
// green there is a claim ("I have nothing for this") that is false at the moment it is made,
// which is the mirror image of the stale-green problem the forget was written to prevent.
//
// So the two properties, and they are the whole spec:
//   1. same text  -> the color SURVIVES the event. No flicker, no probe needed.
//   2. new text   -> the color drops, AND a sweep is scheduled so it comes back on its own.
//
// Usage: node st_prerender_green_spec.mjs <extension-dir> <shim-path> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { TIMERS_DRAINED, trackTimers } from './_specwait.mjs';

const [extDir, shimPath, chromePath] = process.argv.slice(2);
if (!extDir || !shimPath || !chromePath) {
  console.error('usage: node st_prerender_green_spec.mjs <ext-dir> <shim> <chrome>');
  process.exit(2);
}
const N = 10;

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
    throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw');
  }
  return r.result.value;
}

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

// Read before PAGE is built: the page's timer tracking below needs the extension's poll interval.
const indexJs = await readFile(join(extDir, 'index.js'), 'utf-8');
const pollMs = Number(/const POLL_MS = (\d+)/.exec(indexJs)?.[1] ?? 0);
if (!pollMs) throw new Error('could not read POLL_MS out of index.js');

const PAGE = `<!doctype html><meta charset="utf-8">
<div id="extensions_settings2"></div>
<div id="message_template"><div class="mes_buttons"><div class="extraMesButtons"></div></div></div>
<div id="chat"></div>
<script type="module">
  import { installJQuery, fireReady } from '/st_dom_shim.js';
  installJQuery(window);
  window.toastr = { error(){}, success(){}, info(){}, warning(){} };

  // 🔴 WHICH OF THE EXTENSION'S TIMERS ARE STILL PENDING — the signal for "its debounces have fired
  // and its poll has stopped". The sweep (250 ms) and the state poll (POLL_MS) are setTimeouts, and
  // this spec used to wait for them in multiples of POLL_MS ("sleep(pollMs * 2) and hope"). Every
  // timer of POLL_MS or less that the page code sets is counted from set until it fires or is
  // cleared, so "pending() === 0" means nothing is armed: no sweep is waiting and no poll will
  // tick, on any machine speed. Longer timers (the probe back-off) are not counted. The wrapper
  // is installed BEFORE the extension is imported so it sees every timer the extension sets.
  // NO BACKTICKS IN THIS BLOCK: it is inside a template literal.
  ${trackTimers(pollMs, { intervals: false })}

  const N = ${N};
  window.__srv = { calls: { prerender: 0, states: 0 }, answer: 'cached', failNext: 0,
                   prerenderReply: { cache_key: 'k', state: 'cached' } };

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
      extensionSettings: { vocalis: { enabled: true, autoNarrate: false, preRender: true,
                                      serverUrl: 'https://stub.invalid' } },
      saveSettingsDebounced() {},
      substituteParams: (s) => s,
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
  window.__chat = chatArr;
  window.__green = (id) => !!document.querySelector(
      '#chat .mes[mesid="' + id + '"] .vocalis_narrate.vocalis_cached');
  window.__yellow = (id) => !!document.querySelector(
      '#chat .mes[mesid="' + id + '"] .vocalis_narrate.vocalis_pending');
  window.__greenCount = () =>
      document.querySelectorAll('#chat .vocalis_narrate.vocalis_cached').length;
  // The fork's chat windowing: a row LEAVES the DOM when it scrolls away, and the one that comes
  // back is a NEW element built from the template, wearing no color at all.
  window.__drop = (id) => {
      const r = document.querySelector('#chat .mes[mesid="' + id + '"]');
      window.__parked = r; r.remove();
  };
  window.__restore = () => {
      const fresh = window.__parked.cloneNode(true);
      fresh.querySelector('.vocalis_narrate').className =
          'mes_button vocalis_narrate fa-solid fa-volume-high';
      document.getElementById('chat').appendChild(fresh);
  };

  // NOTE: inside a TEMPLATE LITERAL - no backticks, no dollar-brace in this block.
  try {
      await import('/index.js');
      await fireReady();
      window.__booted = true;
  } catch (e) {
      window.__bootError = String((e && e.stack) || e);
  }
</script>`;

// Everything is cached, always — this spec is about what the CLIENT does to a color it has
// already been told is green, so the server must never be the reason one goes orange.
const STREAM_STUB = `
export async function prerender() { window.__srv.calls.prerender++; return window.__srv.prerenderReply; }
export async function fetchStates(url, items) {
    const s = window.__srv;
    s.calls.states++;
    if (s.failNext > 0) { s.failNext--; throw new Error('state failed (500)'); }
    return items.map(() => ({ state: s.answer, cache_key: 'k' }));
}
export async function cancelPrerender() { return { canceled: 0 }; }
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
export async function fetchPlan() { return { ok: false, reason: 'no plan in the stub' }; }
export async function pushDone() { return; }
export async function fetchAvatar() { return { ok: false, reason: 'no avatar in the stub' }; }
export async function fetchExtensionSettings() { return { ok: false, reason: 'no settings in the stub' }; }
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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-green-'));
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
  if (!booted) {
    const why = await evaluate(cdp, 'window.__bootError || \"(no error captured)\"').catch(() => '(unreadable)');
    throw new Error('extension never finished init - ' + why);
  }

  // "Everything the extension scheduled has run": no sweep debounce is waiting and no poll is armed
  // (see __timersPending in the page). This replaces every `sleep(pollMs * n)` that used to stand
  // for "long enough for the extension to have acted". It reports what is still pending on a
  // timeout; callers that fold the wait into a check use `drained` instead of `settle`.
  const drained = () => waitFor(cdp, TIMERS_DRAINED, 20000);
  const settle = async () => {
    if (!(await drained()))
      throw new Error(`the extension's timers never drained (${await evaluate(cdp, 'window.__timersPending()')} still pending)`);
  };

  // Start with every rendered message cached.
  await evaluate(cdp, `window.__emit('chat_loaded')`);
  const allGreen = await waitFor(cdp, `window.__greenCount() === ${N}`, 15000);
  ok(allGreen, `all ${N} messages start green (cached)`);
  // The opening sweeps may still be pending behind that first probe; they must be done before the
  // request counters are read as a baseline below.
  await settle();

  // ── 1. the same message re-rendered, text UNCHANGED ──────────────────────
  // ST fires CHARACTER_MESSAGE_RENDERED on re-renders that change nothing. The audio we have
  // is still audio of this exact text, so the green is still TRUE and must not blink.

  const asked0 = await evaluate(cdp, 'window.__srv.calls.states + window.__srv.calls.prerender');
  await evaluate(cdp, `window.__emit('character_message_rendered', 3)`);
  // Immediately — not after a recovery sweep. The claim is that it never went orange at all.
  const stillGreen = await evaluate(cdp, 'window.__green(3)');
  ok(stillGreen, '🔴 a re-render of UNCHANGED text leaves an older message green (no flicker to orange)');

  // ── 2. and it is still green once everything settles ─────────────────────
  // Was `sleep(pollMs * 2)`: an absence check ("nothing walks back over it") that waited a guessed
  // time. Now it waits until the extension has nothing left scheduled — a sweep that the event
  // wrongly armed would be pending here and would have fired before this returns.
  await settle();
  ok(await evaluate(cdp, 'window.__green(3)'), 'and it is still green after the poll window — nothing walks back over it');
  // ⚠️ THE OTHER HALF OF THE CLAIM — "no flicker AND NO REQUEST" — was never asserted, and the
  // zero-latency stub makes the color reads alone too forgiving: an implementation that
  // forgot and synchronously re-probed would look green whenever the server answered fast.
  // The counters are the honest witness: unchanged text must cost the server NOTHING.
  ok(
    (await evaluate(cdp, 'window.__srv.calls.states + window.__srv.calls.prerender')) === asked0,
    'and an unchanged re-render asked the server for nothing — the memory did the work',
  );

  // ── 3. NEW text still drops the color, and RECOVERS on its own ──────────
  // The stale-green protection is the reason the forget exists, and it must survive the fix:
  // green on a line the user just regenerated is the button promising instant playback of
  // words that are gone. What must ALSO be true is that it comes back without a chat reload.
  await evaluate(cdp, `window.__chat[5].mes = 'Completely different words now, freshly regenerated.'`);
  await evaluate(cdp, `window.__emit('character_message_rendered', 5)`);
  // 🔴 IMMEDIATELY, exactly as check 1 reads its stillGreen — the forget paints synchronously
  // in the handler. Without this read the whole stale-green half was vacuous: delete the
  // forget entirely and green(5) is ALREADY true, so the waitFor below passed instantly and
  // the one behavior this spec's header names as "must survive the fix" was unwatched.
  ok(
    !(await evaluate(cdp, 'window.__green(5)')),
    '🔴 CHANGED text drops the color AT ONCE — stale green over regenerated words is the bug',
  );
  ok(await waitFor(cdp, 'window.__green(5)', 10000), '🔴 and a sweep puts it back on its own — never orange forever');

  // ── 4. the neighbors were never touched ─────────────────────────────────
  ok(
    await evaluate(cdp, `window.__greenCount() === ${N}`),
    `all ${N} are green again — one message's event never costs the others their color`,
  );

  // ── 5. several pre-renders in a row ──────────────────────────────────────
  // Each new reply fires the event; the older ones must not be collateral.
  for (const id of [7, 8, 9]) {
    await evaluate(cdp, `window.__emit('character_message_rendered', ${id})`);
    await settle(); // was `sleep(50)`: each event is fully acted on before the next arrives
  }
  await settle(); // was `sleep(pollMs * 2)`
  const finalGreen = await evaluate(cdp, 'window.__greenCount()');
  ok(finalGreen === N, `🔴 after pre-rendering several in a row, all ${N} are STILL green (${finalGreen}/${N})`);

  // ── 6. YELLOW THAT FINISHES OFF-SCREEN GOES GREEN WHEN IT COMES BACK ─────
  //
  // ⚠️ THIS ONE PASSES ON THE CODE BEFORE THE FIX TOO, AND IS KEPT ANYWAY — SAYING SO, because
  // a check whose label implies it caught something it did not is worse than no check.
  // Measured both ways: the old sweep repainted the restored row yellow from memory and did NOT
  // add it to the probe list, but `runProbe([])` then called `schedulePoll`, which re-armed
  // because the row was back on screen in an ACTIVE state — so it healed one round trip later.
  // The sweep now asks about ACTIVE states directly, which removes that dependency rather than
  // fixing a bug: the property below no longer relies on the poll re-arming to be true.
  // Pin the end-to-end color state after each render.
  // 🔴 The real defect behind "sometimes yellow never goes green" is check 7.
  // ⚠️ 9.5.21 §18e: THE PRERENDER REPLY MOVES WITH `answer`, and it has to. An edit now also
  // re-preloads the message (that is the feature), so a stub that answered `rendering` to the
  // state probe while answering `cached` to the preload would paint this row green a moment
  // after turning it yellow — a fixture disagreeing with itself, not a bug in either file.
  await evaluate(cdp, `window.__srv.answer = 'rendering'; window.__srv.prerenderReply = { cache_key: 'k', state: 'rendering' }`);
  await evaluate(cdp, `window.__emit('message_edited', 4)`); // forces a re-probe of one row
  ok(await waitFor(cdp, 'window.__yellow(4)', 10000), 'a message can be yellow to begin with');

  // ⚠️ PREMISE FIRST: prove the poll actually ticks WHILE the yellow is on screen, so that "the poll
  // has stopped" below means something. This was `sleep(pollMs * 2)` followed by a count
  // comparison: on a starved 16-worker box two windows could contain no tick at all and the
  // premise failed for a reason that was the box, not the extension. It waits for a tick instead
  // (the request counter moving), bounded only so a hung poll fails rather than hangs.
  const ticking0 = await evaluate(cdp, 'window.__srv.calls.states');
  ok(
    await waitFor(cdp, `window.__srv.calls.states > ${ticking0}`, 30000),
    'premise: with a yellow on screen, the poll ticks inside two windows on this box',
  );

  await evaluate(cdp, 'window.__drop(4)'); // it scrolls out of the window…
  await evaluate(cdp, `window.__srv.answer = 'cached'; window.__srv.prerenderReply = { cache_key: 'k', state: 'cached' }`); // …and finishes while it is away
  // 🔴 WAIT FOR THE POLL TO ACTUALLY STOP BEFORE RESTORING, or this check is a race that the
  // old code wins by accident: an in-flight `pollTimer` armed before the drop would re-probe
  // the row and turn it green without the sweep ever having to. `schedulePoll` gives up as soon
  // as nothing ACTIVE is on screen. This was `sleep(pollMs * 3)`, a read, `sleep(pollMs * 2)` and
  // a comparison — "three ticks is comfortably past it", a guess about the box. The page now
  // reports whether any sweep or poll timer is still armed (__timersPending): "stopped" is that
  // count reaching zero, and then the request counter is read twice to show it no longer moves.
  const pollStopped = await drained();
  const quiet = await evaluate(cdp, 'window.__srv.calls.states');
  const stoppedPending = await evaluate(cdp, 'window.__timersPending()');
  if (!pollStopped || stoppedPending !== 0) console.error(`  (poll still armed: ${stoppedPending} timer(s) pending)`);
  ok(
    pollStopped && stoppedPending === 0 && (await evaluate(cdp, 'window.__srv.calls.states')) === quiet,
    'the poll stops once the only moving message is off screen (so the next check is real)',
  );

  await evaluate(cdp, 'window.__restore()'); // …and the user scrolls back
  // The event ST fires when a batch of rows is painted — `onMessagesPainted` -> `scheduleSweep`.
  // That sweep is the ONLY thing that runs here, which is what makes this a test of the sweep.
  await evaluate(cdp, `window.__emit('more_messages_loaded')`);
  ok(
    await waitFor(cdp, 'window.__green(4)', 10000),
    '🔴 a yellow that finished OFF-SCREEN is re-asked and goes green — not repainted stale',
  );

  // ── 7. ONE FAILED PROBE MUST NOT FREEZE THE COLORS FOR THE SESSION ──────
  // The other half of the same complaint, and the more dangerous one: `runProbe`'s catch used
  // to latch `probeStopped` and only a chat change, a settings edit or the Test button ever
  // cleared it. So a single transient — a timeout, a 500, a 401 while the vault re-locked —
  // permanently stopped every color on screen from advancing, while the renders carried on
  // and finished. Pressing play still worked, which is exactly what he described.
  await evaluate(cdp, `window.__srv.answer = 'rendering'; window.__srv.prerenderReply = { cache_key: 'k', state: 'rendering' }`);
  await evaluate(cdp, `window.__emit('message_edited', 6)`);
  ok(await waitFor(cdp, 'window.__yellow(6)', 10000), 'and another one is yellow');

  await evaluate(
    cdp,
    `window.__srv.failNext = 1; window.__srv.answer = 'cached'; window.__srv.prerenderReply = { cache_key: 'k', state: 'cached' }`,
  );
  await evaluate(cdp, `window.__emit('chat_loaded')`); // this probe throws
  ok(
    await waitFor(cdp, 'window.__green(6)', 20000),
    '🔴 a failed probe BACKS OFF AND RECOVERS — one transient does not freeze yellow forever',
  );
} catch (e) {
  console.error(`  FAIL ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

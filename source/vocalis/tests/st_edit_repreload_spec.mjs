// Vocalis 9.5.21 §18e — AN EDIT RE-PRELOADS THE MESSAGE IT CHANGED.
//
// When preloading is enabled, editing a message should schedule a fresh preload for the
// edited text without requiring a separate manual action.
// 🔴 THE DEFECT WAS A MISSING LINE, AND EVERY LINE THAT WAS THERE WAS CORRECT.
// `onMessageEdited` threw the old render away — right, because the text it described is gone —
// and stopped. So with **Pre-render new messages** ticked, the one message he had just touched
// was the only one in the chat that was not ready, and the only way back was the shift-click
// menu. Inverted, and invisible: every color was honest, the button simply had nothing behind
// it.
//
// 🔴 IN A REAL BROWSER, AGAINST THE REAL `index.js`, because the bug is event ORDERING. ST
// emits MESSAGE_EDITED and then MESSAGE_UPDATED for ONE edit and this file listens to both, so a
// naive fix sends the text twice and lets the second event's `cancelPrerenderFor` cancel the
// render the first just queued. A source check can see a call; it cannot see how many times it
// happens or what the sibling handler did to it in between. Same reasoning as
// `st_prerender_green_spec.mjs`, whose harness this borrows.
//
// ⚠️ AND THE WIRE IS CHECKED, NOT THE CALL COUNT ALONE. The stub records every prerender BODY,
// so "it re-preloaded" is asserted as *the NEW text reached the server*. Preloading the pre-edit
// text would satisfy a counter, cache under a key nothing will ever ask for again, and look
// exactly like working.
// Usage: node st_edit_repreload_spec.mjs <extension-dir> <shim-path> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { TIMERS_DRAINED, trackTimers } from './_specwait.mjs';

const [extDir, shimPath, chromePath] = process.argv.slice(2);
if (!extDir || !shimPath || !chromePath) {
  console.error('usage: node st_edit_repreload_spec.mjs <ext-dir> <shim> <chrome>');
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

const PAGE = `<!doctype html><meta charset="utf-8">
<div id="extensions_settings2"></div>
<div id="message_template"><div class="mes_buttons"><div class="extraMesButtons"></div></div></div>
<div id="chat"></div>
<script type="module">
  import { installJQuery, fireReady } from '/st_dom_shim.js';
  installJQuery(window);
  window.toastr = { error(){}, success(){}, info(){}, warning(){} };

  // 🔴 WHICH SHORT TIMERS ARE STILL PENDING — the signal "the debounces have all fired". The
  // extension debounces the edit re-preload (250 ms) and the sweep (250 ms) with setTimeout, and
  // this spec used to sleep a fixed 600 ms / 900 ms and hope both had fired and acted. Every timer
  // of 300 ms or less that the page code sets is counted from set until it fires or is cleared, so
  // "pending() === 0" means no debounce is left to fire — whatever the machine's speed. Longer
  // timers (the 1 s poll, the retry back-offs) are not debounces and are not counted. The wrapper
  // is installed BEFORE the extension is imported so it sees every timer the extension sets.
  // NO BACKTICKS IN THIS BLOCK: it is inside a template literal.
  ${trackTimers(300, { intervals: false })}

  const N = ${N};
  // EVERY prerender body, in order. The count is the cheap question; the text is the real one.
  window.__srv = { prerenders: [], state: 'cached', have: new Set() };

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
  // One of the messages is user-authored, while the automatic path speaks the character. Preserve
  // that distinction when preloading again so the draft is not read in the character's voice.
  chatArr[4].is_user = true;
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
  // 🔴 READ LIVE, NEVER CAPTURED. Init REPLACES this object —
  //     c.extensionSettings[MODULE] = Object.assign({}, DEFAULTS, c.extensionSettings[MODULE])
  // (index.js:4245) — so a reference taken here, before the import, is the pre-init copy the
  // extension abandoned. Writing to it changes nothing and every 'switched off' check passes
  // for the wrong reason. Cost me two failing checks to notice, which is the whole argument.
  window.__settings = () => window.SillyTavern.getContext().extensionSettings.vocalis;
  // What SillyTavern does to the array before it emits anything: updateMessage() writes the new
  // text into chat[] BEFORE MESSAGE_EDITED fires (script.js:9548, then :9774). A spec that edited
  // after emitting would be testing an order the fork does not have. NO BACKTICKS IN THIS BLOCK:
  // it is inside a template literal, and one would end it.
  window.__edit = (id, text) => { chatArr[id].mes = text; };
  window.__green = (id) => !!document.querySelector(
      '#chat .mes[mesid="' + id + '"] .vocalis_narrate.vocalis_cached');
  window.__bodies = () => window.__srv.prerenders.map(b => String((b && b.input) || ''));

  // NOTE: inside a TEMPLATE LITERAL - no backticks, no dollar-brace in this block.
  try {
      await import('/index.js');
      await fireReady();
      window.__booted = true;
  } catch (e) {
      window.__bootError = String((e && e.stack) || e);
  }
</script>`;

// The server always has it, so nothing here goes orange for a reason of the server's own: this
// spec is about what the CLIENT decides to send after an edit.
const STREAM_STUB = `
export async function prerender(url, body) {
    window.__srv.prerenders.push(body);
    window.__srv.have.add(String(body && body.input));
    return { cache_key: 'k' + window.__srv.prerenders.length, state: window.__srv.state };
}
// The server has EXACTLY what was preloaded, and nothing else. A stub that answered 'cached' for
// every row would paint the button green whether or not the edit re-preloaded anything, which is
// the vacuity a mutation run caught: with the fix removed, 'it goes back to green' still passed.
export async function fetchStates(url, items) {
    return items.map(it => window.__srv.have.has(String(it && it.input))
        ? { state: 'cached', cache_key: 'k' }
        : { state: 'none' });
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

const indexJs = await readFile(join(extDir, 'index.js'), 'utf-8');
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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-editpre-'));
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
    const why = await evaluate(cdp, 'window.__bootError || "(no error captured)"').catch(() => '(unreadable)');
    throw new Error('extension never finished init - ' + why);
  }
  // 🔴 THE DEBOUNCE IS 250 ms IN index.js, AND NO WAIT HERE IS MEASURED IN MILLISECONDS. Waiting a
  // fixed 900 ms (and 600 ms for the opening sweep) either measured the timer rather than the
  // behavior or, on a loaded box, ended before the timer had fired and reported the fix missing
  // when it was merely pending. The wait is for the debounces themselves: the page counts the
  // short timers it has pending (see __timersPending), and "settled" is that count reaching
  // zero. A timer that was never set is not waited for — which is right, because none will fire.
  const settle = async () => {
    if (!(await waitFor(cdp, TIMERS_DRAINED, 20000)))
      throw new Error(`debounce timers never drained (${await evaluate(cdp, 'window.__timersPending()')} still pending)`);
  };
  await evaluate(cdp, `window.__emit('chat_loaded')`);
  await settle(); // let the opening sweep settle, so nothing below is racing it
  const reset = () => evaluate(cdp, `window.__srv.prerenders.length = 0`);

  // ── 1. an edit, pre-rendering ON: the NEW text goes back to the server ───────
  await reset();
  await evaluate(cdp, `window.__edit(3, 'A completely different line, rewritten by hand.')`);
  await evaluate(cdp, `window.__emit('message_edited', 3)`);
  await evaluate(cdp, `window.__emit('message_updated', 3)`); // ST emits BOTH for one edit
  await settle();
  const bodies = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__bodies())`));
  ok(bodies.length > 0, 'an edit re-preloads the message with nobody asking it to');
  // 🔴 NOT `every()`. It is TRUE on an empty array, so with the fix removed this check
  // passed while reporting `got []` — a guard that cannot fail for the reason it names.
  ok(
    bodies.length === 1 && /rewritten by hand/.test(bodies[0]),
    `and sends the NEW text, never the text he replaced (got ${JSON.stringify(bodies)})`,
  );
  // 🔴 ONE REQUEST, NOT TWO. Both ST events reach the same handler; without the debounce the
  // second one's `cancelPrerenderFor` also stands down the render the first had just queued.
  ok(bodies.length === 1, `one edit sends exactly one preload, not one per event (sent ${bodies.length})`);
  ok(await waitFor(cdp, 'window.__green(3)', 8000), 'and the button goes back to green on its own');

  // ── 2. his own line is not read back in the character's voice ───────────────
  await reset();
  await evaluate(cdp, `window.__edit(4, 'My own line, edited.')`);
  await evaluate(cdp, `window.__emit('message_edited', 4)`);
  await settle();
  ok(
    (await evaluate(cdp, `window.__srv.prerenders.length`)) === 0,
    "editing the USER's own message preloads nothing — the automatic path speaks the character",
  );

  // ── 3. pre-rendering OFF and no chain armed: an edit asks for nothing ───────
  // ⚠️ Unticking the box also runs `cancelAllPrerenders()`. Reviving a render here would
  // contradict the control he had just used, which is why the checkbox is the gate.
  await reset();
  await evaluate(cdp, `window.__settings().preRender = false`);
  await evaluate(cdp, `window.__edit(5, 'Edited while pre-rendering is switched off.')`);
  await evaluate(cdp, `window.__emit('message_edited', 5)`);
  await settle();
  ok((await evaluate(cdp, `window.__srv.prerenders.length`)) === 0, 'with pre-rendering off and no chain armed, an edit preloads nothing');

  // ── 4. the box unticked BETWEEN the edit and the timer firing ───────────────
  // The state is re-asked when the timer fires rather than captured when it is set, so a
  // decision made during those 250 ms wins.
  await reset();
  await evaluate(cdp, `window.__settings().preRender = true`);
  await evaluate(cdp, `window.__edit(6, 'Edited, and then the box was unticked.')`);
  await evaluate(cdp, `window.__emit('message_edited', 6)`);
  await evaluate(cdp, `window.__settings().preRender = false`);
  await settle();
  ok((await evaluate(cdp, `window.__srv.prerenders.length`)) === 0, 'unticking the box during the debounce cancels the pending re-preload');

  // ── 5. a delete during the debounce must not preload the WRONG message ──────
  // 🔴 THE TIMER IS KEYED ON AN INDEX, AND A DELETE SHIFTS EVERY INDEX AFTER IT. This is the
  // failure the pending map exists to make impossible, and it would be silent: a perfectly
  // well-formed request describing a message nobody edited.
  await reset();
  await evaluate(cdp, `window.__settings().preRender = true`);
  await evaluate(cdp, `window.__edit(7, 'Edited a moment before a delete.')`);
  await evaluate(cdp, `window.__emit('message_edited', 7)`);
  await evaluate(cdp, `window.__chat.splice(2, 1); window.__emit('message_deleted', 2)`);
  await settle();
  const afterDelete = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__bodies())`));
  ok(
    afterDelete.length === 0,
    `a delete during the debounce drops the pending re-preload rather than sending it at a ` +
      `shifted index (sent ${JSON.stringify(afterDelete)})`,
  );
} catch (e) {
  console.error(`  FAIL ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

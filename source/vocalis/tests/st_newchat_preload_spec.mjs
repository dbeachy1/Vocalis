// Vocalis 9.6.4 §18f — A NEW CHAT'S GREETING IS PRELOADED, LIKE ANY OTHER NEW MESSAGE.
//
// When preloading is enabled, creating a chat should preload its greeting.
//
// 🔴 THE GREETING WAS SUBMITTED AND THEN CANCELED BY THE CHAT CHANGE THAT INTRODUCED IT.
// Nothing was missing and nothing was red: the request went out, the server took it, and a
// second request from the same tab — the `cancel({all:true})` `onChatChanged` fires — threw it
// away a moment later. `PrerenderQueue.cancel(None)` takes the queue AND the running job
// (prerender.py:316), so the two orderings are a coin toss on the solo path and a certainty on
// the group one:
//
//   · SOLO  — CHAT_CHANGED, then CHARACTER_MESSAGE_RENDERED(0, 'first_message')
//             (script.js:9057, :9063). The cancel is ISSUED first and may be SERVED second.
//   · GROUP — CHARACTER_MESSAGE_RENDERED per greeting (group-chats.js:304), CHAT_CHANGED only
//             afterward (:319). The cancel always lands last, so the greeting always dies.
//
// 🔴 SO THE STUB MODELS THE CANCEL, NOT JUST THE SUBMIT. A stub whose `cancelPrerender` is a
// no-op — which is what every other ST spec here has, correctly, for its own subject — cannot
// see this bug at all: the greeting's body is recorded, the assertion passes, and the feature is
// broken. This one keeps a `live` set, wipes it on `{all:true}`, and resolves the cancel only
// AFTER the wipe. That is the whole defect in three lines, and it is why the check below asks
// "what does the server still hold?" rather than "was a request sent?".
//
// ⚠️ AND THE CANCEL IS DELIBERATELY HELD IN FLIGHT. The race is invisible at zero latency —
// both orderings look identical when the wipe happens synchronously. With the cancel held, a build
// without the fix loses the greeting every run rather than one run in ten, which is the
// difference between a regression test and a flake.
//
// 🔴 HELD BY A GATE THE SPEC RELEASES, NOT BY A TIMER (2026-10-12). It was a 300 ms `setTimeout`
// (`CANCEL_MS`) in the stub plus fixed sleeps of 600, 300 and 1400 ms in the spec. A timer is a
// bet on how long the machine takes: under load the spec's second `evaluate` of scenario 7 could
// arrive after the timer had fired and the "second chat arrives while the first stand-down is on
// the wire" case silently stopped being tested, and the 1400 ms settle was a guess at how long the
// extension needs. Now the stub's `cancelPrerender` parks on a gate and the spec calls
// `window.__serve()` once it has done what the scenario needs done while the cancel is in flight.
// `__serve` releases every held cancel, lets the extension's promise chain run, and throws if a
// stand-down is still unserved — so what follows it is a settled state, not a hopeful one.
//
// Usage: node st_newchat_preload_spec.mjs <extension-dir> <shim-path> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const [extDir, shimPath, chromePath] = process.argv.slice(2);
if (!extDir || !shimPath || !chromePath) {
  console.error('usage: node st_newchat_preload_spec.mjs <ext-dir> <shim> <chrome>');
  process.exit(2);
}

// (There used to be a `CANCEL_MS = 300` here: how long the stub took to serve a stand-down. It is
// a gate now — see the header — so nothing in this file depends on how fast the machine is.)

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

// A condition, never a duration: poll `expression` (100 ms step) until it is true or `deadlineMs`
// passes. The deadline only bounds a hang. A page exception counts as "not yet".
async function waitFor(cdp, expression, deadlineMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    // The proven shape (tests/test_spec_guards.py pins it): the VALUE of the expression, so a
    // promise is awaited, and a poll that throws is "not yet".
    try {
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`)) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() - t0 > deadlineMs) return false;
    await sleep(100);
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

  // 'live' is what the SERVER still holds. 'prerenders' is every body it was ever handed.
  // The difference between those two is the entire subject of this file.
  // 'cancels' counts stand-downs RECEIVED, 'cancelsDone' those SERVED (the wipe has happened),
  // 'gates' holds the resolvers of the ones still parked, and 'probes' counts /state requests —
  // the sweep's only visible footprint.
  window.__srv = { prerenders: [], live: new Set(), cancels: 0, cancelsDone: 0, gates: [], probes: 0 };

  // Release every parked stand-down and return only once each has been served and the extension
  // has acted on the answer. The extension's follow-up (re-submitting the newest greeting) is a
  // chain of promise continuations, all of which run before the next task, so one task yield
  // (a zero-delay timer, not a wait) is enough to know they have run. Throws if a stand-down is
  // still unserved, so a half-served state can never be mistaken for a settled one.
  window.__serve = async () => {
      window.__srv.gates.splice(0).forEach(release => release());
      await new Promise(r => setTimeout(r, 0));
      const s = window.__srv;
      if (s.cancelsDone !== s.cancels)
          throw new Error('a stand-down is still unserved: received ' + s.cancels + ', served ' + s.cancelsDone);
      return true;
  };

  const chatArr = [];
  function paint() {
      const chatEl = document.getElementById('chat');
      chatEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (let i = 0; i < chatArr.length; i++) {
          const row = document.createElement('div');
          row.className = 'mes';
          row.setAttribute('mesid', String(i));
          row.innerHTML = '<div class="mes_block"><div class="mes_text">line ' + i + '</div>' +
                          '<div class="mes_buttons"><div class="extraMesButtons"></div></div></div>';
          frag.appendChild(row);
      }
      chatEl.appendChild(frag);
  }
  for (let i = 0; i < 3; i++)
      chatArr.push({ mes: 'A line from the chat already in progress, number ' + i + '.', name: 'Test Character' });
  paint();

  const listeners = new Map();
  const ctxStub = {
      chat: chatArr,
      characterId: 0,
      characters: [{ name: 'Test Character', avatar: 'test-character.png' }],
      name2: 'Test Character',
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
  // 🔴 READ LIVE, NEVER CAPTURED — init REPLACES this object (see st_edit_repreload_spec.mjs).
  window.__settings = () => window.SillyTavern.getContext().extensionSettings.vocalis;
  window.__bodies = () => window.__srv.prerenders.map(b => String((b && b.input) || ''));
  window.__held = () => Array.from(window.__srv.live);

  // What SillyTavern does on doNewChat -> getChat -> getChatResult: the chat array is replaced
  // by the greeting, printMessages repaints, then CHAT_CHANGED, then CHARACTER_MESSAGE_RENDERED
  // with type 'first_message'. NO BACKTICKS IN THIS BLOCK - it is inside a template literal.
  window.__newChatSolo = async (greeting) => {
      chatArr.splice(0, chatArr.length, { mes: greeting, name: 'Test Character' });
      paint();
      await window.__emit('chat_changed', 'chat-' + Math.random());
      await window.__emit('character_message_rendered', 0, 'first_message');
  };
  // What getGroupChat does: a greeting per member, each announced, and CHAT_CHANGED LAST.
  window.__newChatGroup = async (greetings) => {
      chatArr.splice(0, chatArr.length);
      for (const g of greetings) {
          chatArr.push({ mes: g, name: 'Test Character' });
          paint();
          await window.__emit('character_message_rendered', chatArr.length - 1, 'first_message');
      }
      await window.__emit('chat_changed', 'group-' + Math.random());
  };
  // A chat that arrives with no per-message event at all.
  window.__newChatSilent = async (text, isUser) => {
      chatArr.splice(0, chatArr.length, { mes: text, name: 'Test Character', is_user: !!isUser });
      paint();
      await window.__emit('chat_changed', 'silent-' + Math.random());
  };
  // The ordering the real failure exposed: CHAT_CHANGED fires while the replacement chat is
  // still empty, and the greeting appears only after the cancel callback has already run. There
  // is no per-message event, so the DOM observer is the only reliable "it exists now" signal.
  window.__newChatLate = async (text) => {
      chatArr.splice(0, chatArr.length);
      paint();
      await window.__emit('chat_changed', 'late-' + Math.random());
      // The greeting must appear only AFTER the stand-down was served and the extension's callback
      // has run against the empty chat. That used to be a timer of CANCEL_MS + 150; it is the
      // event itself now.
      await window.__serve();
      chatArr.push({ mes: text, name: 'Test Character' });
      paint();
  };

  try {
      await import('/index.js');
      await fireReady();
      window.__booted = true;
  } catch (e) {
      window.__bootError = String((e && e.stack) || e);
  }
</script>`;

// 🔴 THE STUB IS THE SERVER'S CANCEL SEMANTICS, NOT A SPY. `submit` is idempotent per key and
// `cancel(None)` takes everything including what is running — both read off prerender.py — so
// "did it preload?" is answered by what is STILL HELD after the dust settles, which is the only
// question the user can perceive.
const STREAM_STUB = `
export async function prerender(url, body) {
    window.__srv.prerenders.push(body);
    window.__srv.live.add(String(body && body.input));
    return { cache_key: 'k' + window.__srv.prerenders.length, state: 'queued' };
}
export async function cancelPrerender(url, opts) {
    if (!(opts && opts.all)) { window.__srv.live.delete(null); return { canceled: 0 }; }
    window.__srv.cancels++;
    // Served LATE: parked on a gate until the spec calls window.__serve(), and the promise
    // resolves only once the wipe has happened — so a caller that waits for it is safe and a
    // caller that does not is not.
    await new Promise(r => window.__srv.gates.push(r));
    const n = window.__srv.live.size;
    window.__srv.live.clear();
    window.__srv.cancelsDone++;
    return { canceled: n };
}
export async function fetchStates(url, items) {
    window.__srv.probes++;
    return items.map(it => window.__srv.live.has(String(it && it.input))
        ? { state: 'queued', cache_key: 'k' } : { state: 'none' });
}
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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-newchat-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // 🔴 MUTE — his speakers are not a test fixture. See st_edit_repreload_spec.mjs.
    '--mute-audio',
    'about:blank',
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Chromium unpacks component extensions through the PROCESS's TEMP, not --user-data-dir.
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
  // Let the opening sweep settle, so nothing below is racing it. This was `sleep(600)`, a guess at
  // "250 ms debounce plus the request". The sweep's one visible footprint is the stub's /state
  // probe counter, and CHAT_LOADED re-arms the (debounced) sweep, so exactly one more probe
  // arrives. The stub answers a probe in a microtask, so by the time the counter has moved and
  // this poll has seen it, the extension has already applied the answer.
  const probesBefore = await evaluate(cdp, `(() => { const n = window.__srv.probes; window.__emit('chat_loaded'); return n; })()`);
  if (!(await waitFor(cdp, `window.__srv.probes > ${probesBefore}`, 20000)))
    throw new Error(
      `the opening sweep never asked the server about the chat (probes ${probesBefore} -> ${await evaluate(cdp, 'window.__srv.probes')})`,
    );

  // 🔴 GIVE THE OUTGOING CHAT SOMETHING TO CANCEL. `cancelAllPrerenders` only reaches the wire
  // when `preKeys` is non-empty, so without this the stand-down is a resolved promise and every
  // check below would pass for the wrong reason — the race it exists to test would never happen.
  //
  // The submit leaves synchronously inside the event handler and the extension records its key in
  // a promise continuation; one task yield (a zero-delay timer, not a wait) lets that run. This was
  // `sleep(300)`, which waited for nothing in particular.
  const arm = async () => {
    await evaluate(
      cdp,
      `window.__emit('character_message_rendered', window.__chat.length - 1).then(() => new Promise(r => setTimeout(r, 0)))`,
    );
  };
  const reset = () => evaluate(cdp, `window.__srv.prerenders.length = 0; window.__srv.cancels = 0; window.__srv.cancelsDone = 0`);
  // Serve the stand-down the chat change has parked on the wire, and return once the extension has
  // acted on the answer. It was `sleep(1400)` ("comfortably past CANCEL_MS plus the 250 ms sweep
  // debounce"). The sweep needs no wait of its own: it only READS the server and never submits or
  // cancels, so nothing it does can change what the server holds or how many requests were sent.
  const settle = () => evaluate(cdp, `window.__serve()`);

  await arm();
  ok((await evaluate(cdp, `window.__srv.live.size`)) > 0, 'the outgoing chat has a live pre-render to stand down');

  // ── 1. SOLO: the greeting survives the stand-down the chat change fires ──────
  await reset();
  await evaluate(cdp, `window.__newChatSolo('The test character looks up as you come in, and smiles warmly.')`);
  await settle();
  ok((await evaluate(cdp, `window.__srv.cancels`)) === 1, 'a new chat stands the old one down (the race is real, not stubbed away)');
  const held = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__held())`));
  ok(
    held.some(t => /looks up as you come in/.test(t)),
    `a new chat's greeting is still held by the server after the stand-down (holds ${JSON.stringify(held)})`,
  );
  ok(held.length === 1, `and nothing from the chat he left is held with it (holds ${JSON.stringify(held)})`);

  // ── 2. GROUP: CHAT_CHANGED arrives LAST, so this one is not a race at all ────
  await arm();
  await reset();
  await evaluate(
    cdp,
    `window.__newChatGroup(['The test character waves from the sofa, already talking.',` +
      ` 'Mara glances over the top of her book and says nothing.'])`,
  );
  await settle();
  const groupHeld = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__held())`));
  ok(
    groupHeld.some(t => /glances over the top of her book/.test(t)),
    `a group chat's newest greeting survives the CHAT_CHANGED that follows it (holds ${JSON.stringify(groupHeld)})`,
  );

  // ── 3. A greeting that arrives with NO per-message event is preloaded anyway ─
  await arm();
  await reset();
  await evaluate(cdp, `window.__newChatSilent('A greeting that arrived with no per-message event at all.')`);
  await settle();
  const silent = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__held())`));
  ok(
    silent.some(t => /no per-message event at all/.test(t)),
    `a chat change alone preloads the newest message (holds ${JSON.stringify(silent)})`,
  );

  // ── 4. CHAT_CHANGED CAN PRECEDE THE GREETING IT IS SUPPOSED TO PRELOAD ──────
  await arm();
  await reset();
  await evaluate(cdp, `window.__newChatLate('A greeting populated only after CHAT_CHANGED finished.')`);
  await settle();
  const late = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__held())`));
  ok(
    late.some(t => /populated only after CHAT_CHANGED/.test(t)),
    `a greeting populated after CHAT_CHANGED is still submitted (holds ${JSON.stringify(late)})`,
  );

  // ── 5. HIS OWN LINE IS NEVER READ BACK IN THE CHARACTER'S VOICE ──────────────
  // The automatic path speaks the character, and §18f must not widen that by arriving through a
  // different door. `prerenderMessage`'s is_user guard is the one doing the work; this proves
  // the new call site did not bypass it.
  await arm();
  await reset();
  await evaluate(cdp, `window.__newChatSilent('My own typing, and it must never be spoken back.', true)`);
  await settle();
  ok((await evaluate(cdp, `window.__srv.prerenders.length`)) === 0, "a chat whose newest message is the USER's preloads nothing");

  // ── 6. THE CHECKBOX IS STILL THE GATE ───────────────────────────────────────
  await arm();
  await evaluate(cdp, `window.__settings().preRender = false`);
  await reset();
  await evaluate(cdp, `window.__newChatSilent('A greeting arriving with pre-rendering switched off.')`);
  await settle();
  ok((await evaluate(cdp, `window.__srv.prerenders.length`)) === 0, 'with "Pre-render new messages" unticked, a new chat preloads nothing');
  await evaluate(cdp, `window.__settings().preRender = true`);

  // ── 7. TWO CHATS IN QUICK SUCCESSION, AND THE SECOND ONE STILL ENDS UP HELD ──
  //
  // 🔴 THIS IS WHERE AN "IS THIS STILL MY CHAT?" GUARD WOULD BREAK IT, WHICH IS WHY THERE IS NOT
  // ONE. The first chat's stand-down is still on the wire when the second arrives; the second has
  // nothing of its own left to cancel, so its submit goes out immediately — straight into the
  // path of a cancel that has not landed yet. The thing that repairs it is the FIRST chat's
  // callback firing late and re-submitting whatever is newest by then. An epoch check would
  // suppress exactly that callback and leave the greeting dead, and it would look like caution.
  //
  // ⚠️ SO THE ASSERTION IS ON WHAT THE SERVER STILL HOLDS, NOT ON WHAT WAS SENT. A count of
  // requests is satisfied by the doomed first submit and says nothing about whether he can click
  // the message.
  await arm();
  await reset();
  await evaluate(cdp, `window.__newChatSilent('The chat he opened and immediately left again.')`);
  await evaluate(cdp, `window.__newChatSilent('The chat he actually settled on.')`);
  await settle();
  const after = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__held())`));
  ok(
    after.some(t => /actually settled on/.test(t)),
    `two chat changes inside one stand-down still leave the settled chat held (holds ${JSON.stringify(after)})`,
  );
  ok(!after.some(t => /immediately left again/.test(t)), `and nothing of the chat he abandoned is held (holds ${JSON.stringify(after)})`);
} catch (e) {
  console.error(`  FAIL ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

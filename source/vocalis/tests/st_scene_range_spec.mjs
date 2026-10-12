// Vocalis 6.0 §2 — selecting a range and the bar that prices it, driven in a real browser.
//
// The pieces here are only real when something drives them: a menu that is CLIPPED looks fine
// in the source, a count taken off the DOM looks fine until the chat is longer than the window,
// and a document-level keydown listener that is never removed looks like nothing at all until
// the number keys stop working in SillyTavern's message box.
//
// It drives the REAL, UNMODIFIED index.js, same recipe as st_button_state_spec.mjs.
//
// Usage: node st_scene_range_spec.mjs <extension-dir> <shim-path> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const [extDir, shimPath, chromePath] = process.argv.slice(2);
if (!extDir || !shimPath || !chromePath) {
  console.error('usage: node st_scene_range_spec.mjs <ext-dir> <shim> <chrome>');
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

// 🔴 A CONDITION, NOT A DURATION. Every wait in this file was `sleep(150)` — long enough on an idle
// box, a coin-flip at -n 16, and silent when it lost: the menu simply had not opened yet, and the
// assertion on the next line blamed the MENU for the harness being early. There are exactly two
// states worth waiting for here, so those are what we poll.
//
// ⚠️ The three loops further down that already poll a condition (the debounced estimate, the
// `__srv.created` round trip, the cache going green) are NOT this bug and are left alone — a loop
// that tests a predicate is a wait, whatever it is spelled like.
//
// 🔴 THE DEADLINE IS ONLY A BOUND ON A HANG (2026-10-12). It was a per-call guess of how long a quick
// machine needs (8 s by default), which is a time bet in the same family as a sleep: a passing run
// never waits it out, but a loaded one that is merely slow would fail it. Never shorter than 30 s now.
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
const MENU_COUNT = `document.querySelectorAll('.vocalis_scene_menu').length`;
const menuOpen = cdp => waitFor(cdp, `${MENU_COUNT} === 1`);
const menuGone = cdp => waitFor(cdp, `${MENU_COUNT} === 0`);

// 🔴 THE WHOLE POINT OF THE FIXTURE: `chat` holds 40 messages, and only the last 10 are in the
// DOM. That is what SillyTavern actually does — `chat_truncation` paints a window and
// `getContext().chat` is the ENTIRE array regardless (§2.4). Message 6 is a USER message, so a
// range spanning it must not count it (§2.1).
const PAGE = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/style.css">
<!-- 🔴 SillyTavern's OWN stylesheet, replayed. It carries a blanket "Remove Black Shadow"
     block that kills box-shadow with !important on a list of selectors including .mes, and
     that is what made the §2.3 rail compute to none in a real SillyTavern while every
     class assertion below still passed. The fixture has to fight the same fight, or this
     file goes on certifying a rail nobody can see. -->
<style>
  .custom-drawer-icon, .inline-drawer-icon, .right_menu_button,
  input[type='checkbox'], .mes { filter: none; box-shadow: none !important; }
</style>
<div id="extensions_settings2"></div>
<div id="message_template"><div class="mes_buttons"><div class="extraMesButtons"></div></div></div>
<div id="chat"></div>
<script type="module">
  import { installJQuery, fireReady } from '/st_dom_shim.js';
  installJQuery(window);
  // 9.2 - RECORDED, not swallowed. "Remove from current scene" on a message that is not in
  // the selection has to SAY so, and a stub that throws the text away cannot tell that apart
  // from the silent no-op it is there to prevent.
  window.__toasts = [];
  const toast = (kind) => (msg) => { window.__toasts.push(kind + ': ' + msg); };
  window.toastr = { error: toast('error'), success: toast('success'),
                    info: toast('info'), warning: toast('warning') };

  const TOTAL = 40, PAINTED_FROM = 30;
  const chatArr = [];
  for (let i = 0; i < TOTAL; i++) {
      chatArr.push({
          mes: 'Line ' + i + ', long enough to be worth rendering aloud.',
          name: (i === 6 ? 'Test Speaker' : 'Test Character'),
          is_user: i === 6,          // §2.1 — a USER message inside the range
          is_system: i === 9,        // and a system one, which bodyFor() already refuses
      });
  }
  const chatEl = document.getElementById('chat');
  for (let i = PAINTED_FROM; i < TOTAL; i++) {          // only the last 10 are on screen
      const row = document.createElement('div');
      row.className = 'mes';
      row.setAttribute('mesid', String(i));
      row.innerHTML = '<div class="mes_block"><div class="mes_text">line ' + i + '</div>' +
                      '<div class="mes_buttons"><div class="extraMesButtons"></div></div></div>';
      chatEl.appendChild(row);
  }

  window.__srv = { estimates: [], created: [], stateAsks: [], cached: [], status: null };
  const listeners = new Map();
  const ctxStub = {
      chat: chatArr,
      name2: 'Test Character',
      extensionSettings: { vocalis: { enabled: true, autoNarrate: false, preRender: false,
                                      serverUrl: 'https://stub.invalid' } },
      saveSettingsDebounced() {},
      substituteParams: (s) => s,
      getCurrentChatId: () => 'chat-1',
      POPUP_TYPE: { INPUT: 'input', CONFIRM: 'confirm' },
      POPUP_RESULT: { AFFIRMATIVE: 1 },
      callGenericPopup: async () => window.__popupAnswer,
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

  // Shift-click, as a browser delivers it: pointerdown carries shiftKey.
  window.__shiftClick = (mesId) => {
      const b = document.querySelector('#chat .mes[mesid="' + mesId + '"] .vocalis_narrate');
      b.dispatchEvent(new PointerEvent('pointerdown',
          { bubbles: true, cancelable: true, shiftKey: true, button: 0 }));
      return !!b;
  };
  window.__menuPick = (label) => {
      const items = [...document.querySelectorAll('.vocalis_scene_menu_item')];
      const hit = items.find(el => el.textContent.includes(label));
      if (!hit) return false;
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
  };

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

const STREAM_STUB = `
export async function prerender() { return { cache_key: 'k', state: 'queued' }; }
export async function fetchStates(url, items) {
    // 6.2: driven by the fixture. window.__srv.cached is the set of mesids the SERVER has in
    // its speech cache right now, and the test grows it while a build is "running" -- which is
    // exactly what a real scene build does, one message at a time. (No backticks anywhere in
    // this stub: it is itself a template literal, and one unescaped backtick ends it. And no
    // regex escapes either -- in a template literal \d is just "d", so /^Line (\d+)/ silently
    // matched nothing and every mesid came back null. [0-9] says the same thing and survives.)
    window.__srv.stateAsks.push(items.map(b => /^Line ([0-9]+)/.exec(String(b.input || ''))?.[1]));
    return items.map(b => {
        const m = /^Line ([0-9]+)/.exec(String(b.input || ''));
        const id = m ? Number(m[1]) : -1;
        return { state: (window.__srv.cached || []).includes(id) ? 'cached' : 'none' };
    });
}
export async function cancelPrerender() { return { canceled: 0 }; }
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
export async function estimateScene(url, items, gap) {
    window.__srv.estimates.push(items.length);
    return { total: items.length, cached: 2, uncached: items.length - 2,
             est_audio_s: 2760, est_render_s: 700, render_rate: 40, gap_s: gap };
}
export async function createScene(url, payload) {
    window.__srv.created.push(payload);
    // 6.3: the 202 carries no enhance / enhance_unavailable any more -- the build does not
    // enhance, so there is nothing for it to report about enhancement. (No backticks in here:
    // this whole stub is a template literal, and one would end it.)
    return { job_id: 'j1', items: payload.items.length, skipped: 0 };
}
export async function sceneStatus() {
    return window.__srv.status
        || { status: 'done', ref: 'x_ab12cd34', total: 1, done: 1 };
}
export async function cancelScene() { return { ok: true }; }
`;

const BAR_STUB = `export function showNarrationPlayerBar() {}
export function hideNarrationPlayerBar() {}`;

const indexJs = await readFile(join(extDir, 'index.js'), 'utf-8');
const polishJs = await readFile(join(extDir, 'polish-send.js'), 'utf-8');
const shimJs = await readFile(shimPath, 'utf-8');
const cssText = await readFile(join(extDir, 'style.css'), 'utf-8');
const ROUTES = {
  '/': ['text/html; charset=utf-8', PAGE],
  '/index.js': ['text/javascript', indexJs],
  '/polish-send.js': ['text/javascript', polishJs],
  '/vocalis-stream.js': ['text/javascript', STREAM_STUB],
  '/scripts/narration-player-bar.js': ['text/javascript', BAR_STUB],
  '/st_dom_shim.js': ['text/javascript', shimJs],
  '/style.css': ['text/css', cssText],
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

const profile = await mkdtemp(join(tmpdir(), 'vocalis-scene-'));
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

const barText = () => evaluate(cdp, `(document.getElementById('vocalis_scene_bar') || {}).textContent || ''`);

// The bar is written synchronously by `renderRangeBar`, but the ESTIMATE that follows rewrites a
// span of it 250 ms later — so a check that races the debounce reads a bar mid-sentence. Polling
// the whole text is what the estimate assertions below already do; this is that, named.
// ⚠️ `barText` cannot throw (it falls back to '' when the bar is gone), which is the whole
// requirement for a wait: an expression that CAN throw is a race dressed as a poll.
//
// The deadline is only a bound on a hang. It was 40 x 50 ms = 2 s, which is a time bet again: the
// estimate behind the text is a debounce plus a request, and on a loaded box 2 s can be too little
// for a bar that is on its way. Every loop below that polls a condition has the same bound now.
const untilTrue = async (probe, deadlineMs = 30000) => {
  const t0 = Date.now();
  while (!(await probe())) {
    if (Date.now() - t0 > deadlineMs) return false;
    await sleep(50);
  }
  return true;
};
const waitBar = async re => {
  await untilTrue(async () => re.test(await barText()));
  return re.test(await barText());
};

// One shift-click, one row picked, and the menu gone again.
const pick = async (mesId, label) => {
  await evaluate(cdp, `window.__shiftClick(${mesId})`);
  await menuOpen(cdp);
  const hit = await evaluate(cdp, `window.__menuPick(${JSON.stringify(label)})`);
  await menuGone(cdp);
  return hit;
};

try {
  await cdp.send('Page.navigate', { url: origin });
  let booted = false;
  for (let i = 0; i < 450 && !booted; i++) {
    // (bounded condition loop; 450 x 100 ms is only a bound on a hang — it was 150, i.e. 15 s)
    await sleep(100);
    booted = await evaluate(cdp, 'window.__booted === true').catch(() => false);
  }
  ok(booted, 'the extension boots');
  if (!booted) {
    const why = await evaluate(cdp, 'window.__bootError || \"(no error captured)\"').catch(() => '(unreadable)');
    throw new Error('extension never finished init - ' + why);
  }

  // ── §2.2: the menu, and where it LIVES ───────────────────────────────────
  ok(await evaluate(cdp, 'window.__shiftClick(39)'), 'shift-click reaches the narrate button');
  await menuOpen(cdp);
  ok(await evaluate(cdp, `document.querySelectorAll('.vocalis_scene_menu').length === 1`), 'shift-click opens the scene menu');
  ok(
    await evaluate(cdp, `document.querySelector('.vocalis_scene_menu').parentElement === document.body`),
    '🔴 the menu is appended to BODY — inside .mes_buttons it would be clipped (§2.2)',
  );
  // 🔴 THE PROPERTY, NOT THE COUNT. This was `length === 4`, and 7.4 added two per-message rows
  // (Preload, Autoplay from here on) — so a check about ONE conditional row failed for a reason
  // that had nothing to do with it, and the only available fix was to bump a magic number that
  // says nothing about what the menu is for. Assert what the rule actually is: every scene row
  // is there, and the one that needs a selection is not.
  const noRangeRows = await evaluate(cdp, `[...document.querySelectorAll('.vocalis_scene_menu_item')].map(el => el.textContent)`);
  ok(
    !noRangeRows.some(t => /Create audio scene/.test(t)) &&
      ['Set scene start here', 'Set scene end here', 'Start of chat', 'Clear selection'].every(want =>
        noRangeRows.some(t => t.includes(want)),
      ),
    `"Create audio scene…" appears only once a range exists (${noRangeRows.join(' | ')})`,
  );

  // 🔴 A shift-click must not ALSO narrate or arm the long press. Both would fire off the
  // same button, and the second one is invisible until a spinner appears behind the menu.
  ok(
    await evaluate(
      cdp,
      `!document.querySelector('#chat .mes[mesid="39"] .vocalis_narrate').className
            .includes('fa-spinner')`,
    ),
    'and it does not arm the long-press behind the menu',
  );

  // ── §2.1 + §2.4: the count comes from `chat`, and skips the user's own ───
  ok(await evaluate(cdp, `window.__menuPick('Set scene end here')`), 'pick: set scene end');
  await menuGone(cdp);
  await evaluate(cdp, 'window.__shiftClick(39)'); // reopen on the same row
  await menuOpen(cdp);
  ok(await evaluate(cdp, `window.__menuPick('Start of chat')`), 'pick: start of chat → here');
  await menuGone(cdp);

  const text = await barText();
  ok(/#0 → #39/.test(text), `the bar spans the whole chat (${JSON.stringify(text.slice(0, 60))})`);
  // 40 messages, minus the user message at 6, minus the system message at 9 = 38.
  ok(
    /\b38 character messages\b/.test(text),
    '🔴 38 of 40 — counted from `chat`, NOT from the 10 rows in the DOM (§2.4), and the ' +
      "user's own line and the system one are excluded (§2.1)",
  );

  // The estimate is DEBOUNCED (250 ms) — every shift-click moves an endpoint, and the server
  // stats one file per cached message to answer, so firing per keystroke-equivalent would be
  // rude. Wait for it rather than racing it.
  await untilTrue(async () => /~46 min/.test(await barText()));
  ok(/~46 min/.test(await barText()), 'the bar shows the scene length');
  ok(/build ~12 min/.test(await barText()), '…and the BUILD time, separately (§2.3)');
  ok((await evaluate(cdp, 'window.__srv.estimates.slice(-1)[0]')) === 38, 'and the estimate was asked about the same 38 the bar counted');

  // ── §2.3: the rail, on the painted rows only ─────────────────────────────
  // The range is #0 → #39; rows 30–39 are the only ones in the DOM, and all ten of them are
  // character messages (the user's line is #6 and the system one is #9, both off screen).
  // "Messages in range but not painted simply are not on screen — the count in the bar is the
  // truth", so 10 rails against 38 counted is the CORRECT disagreement, not a bug.
  ok(
    await evaluate(cdp, `document.querySelectorAll('#chat .mes.vocalis_in_scene').length === 10`),
    'the left rail marks the 10 painted in-range rows, while the bar still counts all 38',
  );

  // 🔴 AND IT ACTUALLY PAINTS. The class being present is not the feature — the green edge
  // on the message is. ST's blanket `box-shadow: none !important` above beat the unweighted
  // rule outright, so the selection was invisible on the messages in a real SillyTavern
  // while the assertion directly above passed. Read the COMPUTED value, not the class.
  const railShadow = await evaluate(cdp, `getComputedStyle(document.querySelector('#chat .mes.vocalis_in_scene')).boxShadow`);
  ok(
    /inset/.test(railShadow) && /124, 179, 66|rgb\(124/.test(railShadow),
    `🔴 the rail SURVIVES ST's blanket box-shadow:none !important (computed ${railShadow})`,
  );

  // ── 9.2 §2.5: messages added and removed ONE AT A TIME ───────────────
  // Removing a message from the selected range leaves a visible gap in the selection.
  ok(await pick(35, 'Remove from current scene'), 'pick: remove from current scene');
  ok(await waitBar(/\b37 character messages\b/), `removing #35 takes the count to 37 (${await barText()})`);
  ok(/· 1 skipped/.test(await barText()), '🔴 …and the bar SAYS one was skipped — the only place a hole punched off screen can be seen');
  ok(
    await evaluate(cdp, `document.querySelectorAll('#chat .mes.vocalis_in_scene').length === 9`),
    'the rail leaves the row it was taken out of — 9 painted now, not 10',
  );
  ok(
    await evaluate(cdp, `!document.querySelector('#chat .mes[mesid="35"]').classList.contains('vocalis_in_scene')`),
    '…and it is #35 that lost it',
  );
  await untilTrue(async () => (await evaluate(cdp, 'window.__srv.estimates.slice(-1)[0]')) === 37);
  ok(
    (await evaluate(cdp, 'window.__srv.estimates.slice(-1)[0]')) === 37,
    'and the estimate is re-asked about the 37 that are left, not the 38 that were',
  );

  // 🔴 THE HOLE SURVIVES A MOVE OF THE SPAN, which is the whole reason the selection is a set.
  // #0 → #37 is 36 character messages; a model that re-filled the span from its anchors would put
  // #35 back and say 36, and nothing on screen would ever mention it again.
  ok(await pick(37, 'Set scene end here'), 'pick: set scene end at #37');
  ok(await waitBar(/#0 → #37/), `the span moves to #0 → #37 (${await barText()})`);
  ok(
    /\b35 character messages\b/.test(await barText()) && /· 1 skipped/.test(await barText()),
    `🔴 #35 is STILL out after the endpoint moved (${await barText()})`,
  );

  // Adding it back is the exact inverse, and the note goes with it.
  ok(await pick(35, 'Add to current scene'), 'pick: add to current scene');
  ok(await waitBar(/\b36 character messages\b/), `adding #35 back takes the count to 36 (${await barText()})`);
  ok(!/skipped/.test(await barText()), '…and nothing is skipped any more');

  // An added message lives OUTSIDE the span, so it moves the edge the bar prints. The span now
  // ends at #34 and the scene does not.
  ok(await pick(34, 'Set scene end here'), 'pick: set scene end at #34');
  ok(
    await waitBar(/#0 → #35/),
    `🔴 the span ends at #34 and the bar still reads #35 — an added message is not inside it (${await barText()})`,
  );

  // Taking out something that was never in is not a silent no-op.
  const toastsBefore = await evaluate(cdp, 'window.__toasts.length');
  ok(await pick(39, 'Remove from current scene'), 'pick: remove a message that is not in the selection');
  ok((await evaluate(cdp, 'window.__toasts.length')) > toastsBefore, '…it says so rather than doing nothing visible');

  // 🔴 AND "CLEAR SELECTION" IS THE ONE THING THAT EMPTIES THE HOLES. Everything above keeps them
  // on purpose, so a fresh #0 → #39 has to be all 38 again — not 37 with an exclusion carried over
  // from a selection nobody can remember. (It also puts the state back for the Create checks.)
  ok(await pick(39, 'Clear selection'), 'pick: clear selection');
  ok((await barText()) === '', 'the bar goes away');
  await pick(39, 'Set scene end here');
  await pick(39, 'Start of chat');
  ok(await waitBar(/\b38 character messages\b/), `a fresh selection is all 38 again (${await barText()})`);
  ok(!/skipped/.test(await barText()), '🔴 …with no hole carried over from the last one');

  // ── the teardown that nothing would ever notice ──────────────────────────
  await evaluate(cdp, 'window.__shiftClick(39)');
  await menuOpen(cdp);
  ok(await evaluate(cdp, `document.querySelectorAll('.vocalis_scene_menu').length === 1`), 'the menu reopens');
  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await menuGone(cdp);
  ok(await evaluate(cdp, `document.querySelectorAll('.vocalis_scene_menu').length === 0`), 'Escape dismisses it');
  // 🔴 The listener is on DOCUMENT, because a click anywhere must dismiss. Removing only the
  // node leaves it alive, and it swallows the digits 1-5 for the rest of the session — which
  // in SillyTavern means typing a number into the message box stops working.
  const swallowed = await evaluate(
    cdp,
    `(() => {
        const e = new KeyboardEvent('keydown', {key:'3', bubbles:true, cancelable:true});
        document.dispatchEvent(e);
        return e.defaultPrevented;
    })()`,
  );
  ok(!swallowed, '🔴 and its document keydown handler went with it — a leaked one eats the number keys');

  // ── Create sends bodyFor() output, byte for byte ─────────────────────────
  await evaluate(cdp, `window.__popupAnswer = 'The ferry'`);
  await evaluate(cdp, 'window.__shiftClick(39)');
  await menuOpen(cdp);
  ok(await evaluate(cdp, `window.__menuPick('Create audio scene')`), '"Create audio scene…" appears once a range exists');
  await untilTrue(async () => !!(await evaluate(cdp, 'window.__srv.created.length')));
  const sent = await evaluate(cdp, 'JSON.stringify(window.__srv.created[0] || null)');
  const payload = JSON.parse(sent || 'null');
  ok(payload && payload.title === 'The ferry', 'Create posts the title he typed');
  ok(payload && payload.items.length === 38, '…with the same 38 items');
  ok(
    payload && payload.items.every(it => 'input' in it && 'character' in it),
    '🔴 every item is bodyFor() output — {input, character} — or the cache keys never match',
  );
  ok(
    payload && payload.items.every(it => typeof it.mesid === 'number'),
    'plus mesid, which is a HINT for jumping back and never the identity (§4)',
  );
  ok(payload && payload.gap_s === 0.7, 'the serialized scene retains the configured 0.7 second gap');

  // ── 6.2: the buttons go green AS the build caches them ───────────────────
  // 🔴 `schedulePoll` re-asks only about messages in ACTIVE,
  // and an UNCACHED message is terminal by that rule — nothing the extension knows about will
  // change it. That is right for an idle chat and wrong during a build, when the server is
  // caching those very messages one at a time. The old code's only repaint was one
  // `scheduleSweep()` when the job finished, so the whole range went green at once, minutes
  // after the first message actually did.
  //
  // The check has to be that a button goes green **while the bar still says Building**. An
  // assertion that they are green at the END passes against the defect.
  await evaluate(cdp, `window.__srv.status = { status: 'rendering', total: 38, done: 0, cached: 0 }`);
  await evaluate(cdp, 'window.__shiftClick(39)');
  await menuOpen(cdp);
  await evaluate(cdp, `window.__menuPick('Set scene end here')`);
  await menuGone(cdp);
  await evaluate(cdp, 'window.__shiftClick(39)');
  await menuOpen(cdp);
  await evaluate(cdp, `window.__menuPick('Start of chat')`);
  await menuGone(cdp);
  await evaluate(cdp, 'window.__shiftClick(39)');
  await menuOpen(cdp);
  await evaluate(cdp, `window.__menuPick('Create audio scene')`);
  await untilTrue(() => evaluate(cdp, 'window.__srv.created.length > 1'));
  ok(await evaluate(cdp, 'window.__srv.created.length > 1'), 'a second build starts, and stays running');
  // Precondition: nothing is green yet, so what follows is a change and not a starting state.
  const greens = () => evaluate(cdp, `document.querySelectorAll('#chat .mes .vocalis_narrate.vocalis_cached').length`);
  ok((await greens()) === 0, 'precondition: no message is green when the build starts');

  // The server caches #35. Nothing else happens — no chat event, no click, no reload.
  await evaluate(cdp, `window.__srv.cached = [35]`);
  const wentGreen = await untilTrue(() =>
    evaluate(
      cdp,
      `document.querySelector('#chat .mes[mesid="35"] .vocalis_narrate')
                     .classList.contains('vocalis_cached')`,
    ),
  );
  ok(wentGreen, '🔴 a message cached BY THE BUILD turns its speaker green, with no other event');
  // …and this is the half that fails against the old code: the build is STILL RUNNING.
  ok(/Building scene/.test(await barText()), 'and it did so while the bar still says Building — not in one lump at the end');
  ok((await greens()) === 1, `only the one the server has cached is green (${await greens()}), not the whole range`);

  // It stops asking about what is already green: the poll shrinks as the build progresses
  // rather than re-probing 74 messages a second for the length of a long scene.
  const asksBefore = await evaluate(cdp, 'window.__srv.stateAsks.length');
  await waitFor(cdp, `window.__srv.stateAsks.length > ${asksBefore}`, 8000);
  const lastAsk = await evaluate(cdp, 'JSON.stringify(window.__srv.stateAsks.slice(-1)[0] || [])');
  ok((await evaluate(cdp, 'window.__srv.stateAsks.length')) > asksBefore, 'the build keeps re-asking each second while it runs');
  ok(!JSON.parse(lastAsk).includes('35'), `and a message that has gone green is never asked about again (${lastAsk})`);

  await evaluate(cdp, `window.__srv.status = null`); // let it finish
  await untilTrue(async () => !(await evaluate(cdp, 'window.__srv.status')) && !/Building scene/.test(await barText()));
} catch (e) {
  console.error(`  FAIL ${e.message}`);
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

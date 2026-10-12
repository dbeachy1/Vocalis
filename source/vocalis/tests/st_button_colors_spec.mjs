// Vocalis 5.4 — the narrate button's four colors, resolved by a REAL browser.
//
// Why this exists when test_st_extension_smoke.py already reads style.css: a source check can
// see that a rule is present and where it sits in the file. It cannot see what the browser
// DOES with it. The cascade is the thing under test here — `.vocalis_narrate:hover` and
// `.vocalis_narrate.vocalis_cached` have IDENTICAL specificity (0,2,0), so which one paints a
// hovered green button is decided by nothing but source order, and getting it backward turns
// every colored button orange under the pointer while every string test goes on passing.
// That is the same shape of failure as the Voices player: markup assertions all green, the
// feature visibly broken. So: real Chrome, real stylesheet, real getComputedStyle.
//
// It deliberately does NOT fake SillyTavern. The extension is jQuery-bound to ST's DOM and its
// event bus, and a hand-rolled stand-in for both would be a test of the stand-in. Driving the
// buttons inside real ST is m4, in a real browser, against the live box.
//
// No npm — Node ships WebSocket and fetch, Chrome speaks CDP. Same convention as
// voices_player_browser_spec.mjs.
//
// Usage: node st_button_colors_spec.mjs <path-to-style.css> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [cssPath, chromePath] = process.argv.slice(2);
if (!cssPath || !chromePath) {
  console.error('usage: node st_button_colors_spec.mjs <style.css> <chrome-path>');
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

// ── CDP plumbing (same recipe as voices_player_browser_spec.mjs) ──────────────
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

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-css-'));
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
  // 🔴 Wait for Chrome to exit before deleting its profile. `kill()` returns immediately, and
  // Windows may keep file handles open until the child exits.
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
const page = targets.find(t => t.type === 'page');
const cdp = connect(page.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

try {
  // The REAL stylesheet, plus the two rules ST itself contributes that this button lives
  // inside: `.mes_button` is what gives it its base look, and the extension's own comment
  // notes ST sets `* { box-sizing: border-box }`.
  const css = await readFile(cssPath, 'utf-8');

  // 9.1 §1 — a row shaped the way SillyTavern builds one, down to the level the band needs:
  // `.mes` → `.mes_block` → `.ch_name`, with the speaker's name and the button strip inside it.
  //
  // 🔴 THE PAUSED STOP SQUARE ONLY EVER OCCURS ON A BAND, so testing it off one — which is
  // what check 3 below does, deliberately, as the guard on `.vocalis_playing` not recoloring —
  // says nothing about what he will actually see. `band_paused` is the real combination: the
  // row is `.vocalis_speaking`, the button is a green `fa-stop`, and it is sitting on #ffd23f.
  const BAND_ROW = (id, key, rowCls, btnCls) => `
        <div class="mes${rowCls}" mesid="${id}">
          <div class="mes_block">
            <div class="ch_name flex-container justifySpaceBetween" id="${key}_bar">
              <span class="name_text" id="${key}_name">Test User</span>
              <div class="mes_buttons">
                <div class="mes_button mes_translate fa-solid" id="${key}_stbtn"></div>
                <div class="mes_button vocalis_narrate fa-solid vocalis_cached${btnCls}" id="${key}_btn"></div>
              </div>
            </div>
          </div>
        </div>`;

  const html = `<!doctype html><meta charset="utf-8">
      <style>
        * { box-sizing: border-box }
        .mes_button { color: #888 }
        /* What the band has to beat. Every ST dark theme drives the header text from
           --SmartThemeBodyColor, which is near-white — so without the forced foreground the
           speaker's own name is the least legible thing on the row the band is marking. */
        .ch_name { color: #e8e8e8; font-weight: bolder }
        .mes_block .ch_name { max-width: 100%; min-height: 22px; align-items: flex-start }
      </style>
      <style>${css}</style>
      <div id="chat">
        <div class="mes" mesid="0"><div class="mes_button vocalis_narrate fa-solid" id="b_none"></div></div>
        <div class="mes" mesid="1"><div class="mes_button vocalis_narrate fa-solid vocalis_pending" id="b_pending"></div></div>
        <div class="mes" mesid="2"><div class="mes_button vocalis_narrate fa-solid vocalis_ready" id="b_ready"></div></div>
        <div class="mes" mesid="3"><div class="mes_button vocalis_narrate fa-solid vocalis_cached" id="b_cached"></div></div>
        <div class="mes" mesid="4"><div class="mes_button vocalis_narrate fa-solid vocalis_cached vocalis_playing" id="b_playing"></div></div>
        ${BAND_ROW(5, 'band_off', '', '')}
        ${BAND_ROW(6, 'band_paused', ' vocalis_speaking', ' vocalis_playing')}
        ${BAND_ROW(7, 'band_audible', ' vocalis_speaking', ' vocalis_playing vocalis_audible')}
      </div>`;
  await cdp.send('Page.navigate', {
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html),
  });
  // 🔴 WAIT FOR THE ELEMENT, NEVER FOR A DURATION. `sleep(300)` was a bet that navigation
  // finishes in 300 ms, and on a loaded box it does not: under the full 16-worker suite this
  // spec failed with `getComputedStyle: parameter 1 is not of type Element` — which is
  // `getElementById` returning null on a page that had not landed yet, reported as if the
  // stylesheet were broken. A red check that names the wrong thing is worse than a slow one.
  //
  // ⚠️ BOUNDED, so a genuinely broken page still fails rather than hanging the worker: ~5 s of
  // polling and then one last attempt whose failure is the real error, with the real message.
  //
  // (2026-10-12: the bound was 100 x 50 ms = 5 s of polling, which is itself a time bet on a loaded
  // box. It is 30 s now — only a bound on a hang; a passing run leaves at the first poll that sees
  // the element. The 50 ms is the step between polls.)
  const pageDeadline = Date.now() + 30000;
  while (Date.now() < pageDeadline) {
    const there = await evaluate(cdp, `!!document.getElementById('band_audible_btn')`).catch(() => false);
    if (there === true) break;
    await sleep(50);
  }

  const colorOf = id => evaluate(cdp, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).color`);

  // 1. Each state resolves to its own color, and they are all DIFFERENT. Four states that
  //    render identically would pass every source check ever written.
  const seen = {};
  for (const id of ['b_none', 'b_pending', 'b_ready', 'b_cached']) seen[id] = await colorOf(id);
  ok(seen.b_none === 'rgb(255, 150, 51)', `orange is the default (${seen.b_none})`);
  ok(seen.b_pending === 'rgb(255, 210, 63)', `pending is yellow (${seen.b_pending})`);
  ok(seen.b_ready === 'rgb(77, 163, 255)', `playable is blue (${seen.b_ready})`);
  ok(seen.b_cached === 'rgb(124, 179, 66)', `cached is green (${seen.b_cached})`);
  ok(new Set(Object.values(seen)).size === 4, 'all four states are visually distinct');

  // 2. 🔴 The cascade trap, tested as the browser sees it rather than by source order.
  //    Chrome applies :hover through forced pseudo-state, so this is the real cascade.
  const { nodeId: rootId } = await cdp.send('DOM.getDocument').then(r => ({ nodeId: r.root.nodeId }));
  for (const [id, expected, name] of [
    ['b_pending', 'rgb(255, 226, 122)', 'yellow'],
    ['b_ready', 'rgb(133, 194, 255)', 'blue'],
    ['b_cached', 'rgb(156, 204, 101)', 'green'],
  ]) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: rootId, selector: '#' + id });
    await cdp.send('CSS.enable').catch(() => {});
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    const hovered = await colorOf(id);
    ok(hovered === expected, `a hovered ${name} button stays ${name} instead of reverting to orange (${hovered})`);
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  }

  // 3. Playing does not repaint. The glyph carries playback; the color carries the render
  //    state, and .vocalis_playing used to force red over the top of it.
  const playing = await colorOf('b_playing');
  ok(playing === seen.b_cached, `a PLAYING cached button is still green (${playing}) — color and glyph are separate axes`);

  // ── 4. 🔴 9.1 §1 — THE HEADER BAND, AND THE RED SQUARE THAT SITS ON IT ────────────────
  //
  // The header band distinguishes the active row while scrolling through the chat.
  //
  // Everything here is cascade, which is exactly what a source check cannot see: the band is
  // one `background` competing with a theme, and its five icon colors are five rules of
  // IDENTICAL (1,4,0) specificity separated by nothing but source order — the same trap check
  // 2 exists for, one level deeper. st_button_state_spec.mjs proves the classes get applied;
  // this proves what Chrome does with them once they are.
  const bgOf = id => evaluate(cdp, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).backgroundColor`);

  const bandBg = await bgOf('band_paused_bar');
  const plainBg = await bgOf('band_off_bar');
  ok(bandBg === 'rgb(255, 210, 63)', `the loaded message's header bar is YELLOW (${bandBg})`);
  ok(plainBg === 'rgba(0, 0, 0, 0)', `🔴 and every other row's is untouched (${plainBg}) — a band on all of them is not a landmark`);

  // The foreground, which is the half that turns a landmark into an unreadable one. Checked
  // against the plain row as the control, so this cannot pass by the theme color being dark
  // in the fixture to begin with.
  const bandName = await colorOf('band_paused_name');
  const plainName = await colorOf('band_off_name');
  ok(bandName === 'rgb(20, 23, 28)', `the speaker's name goes dark on the band (${bandName})`);
  ok(plainName !== bandName, `…and only on the band — an ordinary row keeps the theme's color (${plainName})`);
  ok((await colorOf('band_paused_stbtn')) === 'rgb(20, 23, 28)', "ST's own icons on the band go dark with it");

  // 🔴 …AND OURS DOES NOT. `#chat .mes.vocalis_speaking .ch_name .mes_button` is (1,3,1) with
  // !important and beats `.vocalis_narrate`'s own (0,2,0) outright, so without the
  // `:not(.vocalis_narrate)` the one icon in the strip carrying information is repainted the
  // same dark gray as the seven that carry none — taking the red square with it.
  const paused = await colorOf('band_paused_btn');
  const audible = await colorOf('band_audible_btn');
  ok(paused !== 'rgb(20, 23, 28)', `🔴 the narrate button keeps its own color on the band (${paused})`);
  ok(audible === 'rgb(179, 23, 15)', `an AUDIBLE button is RED (${audible})`);
  ok(paused !== audible, `🔴 and a PAUSED one is not (${paused}) — "even if the sound is paused, it should be yellow", but not red`);

  // Legibility, MEASURED rather than restated. Asserting the hex would only repeat the
  // stylesheet back to itself; the property that matters is that these survive being put on
  // #ffd23f at all, and #7cb342 — the color they replace — does not: it lands at 1.7:1.
  const contrast = await evaluate(
    cdp,
    `(() => {
        const lin = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        const lum = s => {
          // ⚠️ [0-9.], NOT a backslash-d class — this whole expression is a TEMPLATE
          // LITERAL, so a lone backslash is eaten before Chrome ever sees it and the class
          // silently becomes [d.], which matches nothing in 'rgb(255, 210, 63)'. It then fails
          // as a null deref inside the helper, naming neither the regex nor the color.
          // (And no backticks in this comment either, for the same reason: they would end
          // the literal here. Same note as the stubs in st_button_state_spec.mjs.)
          const [r, g, b] = s
            .match(/[0-9.]+/g)
            .slice(0, 3)
            .map(Number)
            .map(v => lin(v / 255));
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (x + 0.05) / (y + 0.05);
        };
        const bg = getComputedStyle(document.getElementById('band_paused_bar')).backgroundColor;
        const of = id => ratio(bg, getComputedStyle(document.getElementById(id)).color);
        return {
          name: of('band_paused_name'),
          paused: of('band_paused_btn'),
          audible: of('band_audible_btn'),
          undarkened: ratio(bg, 'rgb(124, 179, 66)'),
        };
     })()`,
  );
  for (const [k, what] of [
    ['name', "the speaker's name"],
    ['paused', 'the paused stop square'],
    ['audible', 'the red stop square'],
  ]) {
    ok(contrast[k] >= 4.5, `${what} clears 4.5:1 against the band (${contrast[k].toFixed(2)}:1)`);
  }
  ok(
    contrast.undarkened < 2.5,
    `🔴 and the UNDARKENED green would not (${contrast.undarkened.toFixed(2)}:1) — which is why these rules exist`,
  );
} catch (e) {
  console.error('FAIL ' + e.message);
  failed++;
}

await cleanup();
console.log(failed ? `\n${failed} check(s) failed` : '\nall color checks passed');
process.exit(failed ? 1 : 0);

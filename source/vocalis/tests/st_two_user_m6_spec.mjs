// Two-user SillyTavern integration spec: two isolated installs, two Vocalis instances, one browser.
// It covers per-user extension settings and the cross-instance authentication boundary, which
// unit tests cannot exercise together. Run it only with explicitly supplied integration
// endpoints and credentials; it is intentionally separate from pytest.
//
// 🔴 **BUILD THE FIXTURE WITH `scripts/run-two-user-m6.sh`.** The runner creates the isolated
// installs and seeded voices, verifies own-user success plus cross-user and anonymous rejection,
// then starts the browser claims. Refuse to run if those setup checks fail.
//
// Each SillyTavern install must complete first-run onboarding so the extension settings panel is
// present. The runner uses separate install roots; do not point it at the working repository.
// Login fetches the fork's X-CSRF-Token before posting credentials because missing CSRF and bad
// credentials both return 403.
//
// Usage: node st_two_user_m6_spec.mjs <st-base> <chrome-path> <vocalisA> <tokenA> <vocalisB> <tokenB>
// Exit 0 = every claim held.
//
// 🔴 THE TWO LOGINS COME FROM THE ENVIRONMENT, NEVER FROM THIS FILE. Set them in your shell before running:
//
//     export ST_TEST_USER_A=… ST_TEST_PASS_A=…      # the ADMIN account
//     export ST_TEST_USER_B=… ST_TEST_PASS_B=…      # the NON-ADMIN account
//
// The run refuses to start without all four rather than falling back to a default, because a
// default here is a credential in git by another name.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [stBase, chromePath, vocA, tokA, vocB, tokB] = process.argv.slice(2);
if (!stBase || !chromePath || !vocA || !tokA || !vocB || !tokB) {
  console.error('usage: node st_two_user_m6_spec.mjs <st-base> <chrome> <vocA> <tokA> <vocB> <tokB>');
  process.exit(2);
}

const { ST_TEST_USER_A, ST_TEST_PASS_A, ST_TEST_USER_B, ST_TEST_PASS_B } = process.env;
if (!ST_TEST_USER_A || !ST_TEST_PASS_A || !ST_TEST_USER_B || !ST_TEST_PASS_B) {
  console.error('missing credentials: set ST_TEST_USER_A, ST_TEST_PASS_A, ST_TEST_USER_B, ST_TEST_PASS_B');
  console.error('  A = the admin account, B = the non-admin account. Never hard-code them here.');
  process.exit(2);
}

const USERS = [
  { handle: ST_TEST_USER_A, password: ST_TEST_PASS_A, url: vocA, token: tokA, admin: true },
  { handle: ST_TEST_USER_B, password: ST_TEST_PASS_B, url: vocB, token: tokB, admin: false },
];

let failed = 0;
const ok = (cond, what) => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let msgId = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else listeners.forEach(fn => fn(m));
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
  return { ws, ready, send, on: fn => listeners.push(fn) };
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

// One shared budget for waits that FAIL — wbedit_browser_spec.mjs's rule, same reason: a timeout
// that eats the whole run destroys the evidence of every check after it.
let waitBudgetMs = 60000;
async function waitFor(cdp, expression, timeoutMs = 20000) {
  let lastThrow = null;
  const allowed = Math.min(timeoutMs, Math.max(0, waitBudgetMs));
  const t0 = Date.now();
  for (;;) {
    // 🔴 `Promise.resolve(...)` ensures asynchronous page expressions are awaited; boolean coercion
    // would treat every Promise as true and return before the condition resolves.
    //
    // Treat transient page exceptions during repaint as not-yet, but retain the last error so a
    // misspelled expression is reported when the wait times out.
    try {
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`)) return true;
      lastThrow = null;
    } catch (err) {
      lastThrow = err && err.message ? err.message : String(err);
    }
    if (Date.now() - t0 > allowed) {
      waitBudgetMs -= Date.now() - t0;
      if (lastThrow) console.log(`  (wait gave up; last page exception: ${lastThrow})`);
      return false;
    }
    await sleep(200);
  }
}
async function mustWait(cdp, expression, what, timeoutMs = 20000) {
  const t0 = Date.now();
  if (await waitFor(cdp, expression, timeoutMs)) {
    ok(true, what);
    return true;
  }
  ok(false, `${what} — TIMED OUT after ${Date.now() - t0}ms waiting for: ` + expression.replace(/\s+/g, ' ').trim());
  return false;
}

/** Poll an ASYNC condition — one that has to `fetch` before it can answer.
 *
 * 🔴 DO NOT PASS AN ASYNC IIFE TO `waitFor`. It wraps its expression as `!!(<expr>)`, and
 * `!!somePromise` is `true` **immediately** — a boolean, not a promise, so `awaitPromise` has
 * nothing left to await and the loop returns on the first tick no matter what the condition
 * would have answered. The wait passes instantly, forever, and looks exactly like a wait that
 * worked. Nothing in the suite does this today; this helper exists so nothing starts.
 *
 * Here the value is compared AFTER the promise resolves, which is what makes it a real wait.
 */
async function waitForAsync(cdp, asyncExpression, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    if ((await evaluate(cdp, asyncExpression)) === true) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(200);
  }
}

// ── one browser profile PER USER ──────────────────────────────────────────────
// 🔴 SEPARATE PROFILES, NOT SEPARATE TABS. The fork authenticates with a session cookie on one
// origin, so two tabs in one profile are the SAME user — and a test that "logged in as both"
// in one profile would silently be testing one account twice, which is exactly the shape of
// failure this milestone is about.
async function launchChrome(tag) {
  const profile = await mkdtemp(join(tmpdir(), `vocalis-m6-${tag}-`));
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
      '--window-size=1600,1000',
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
      // Both variables point into the owned profile so cleanup contains extracted scratch.
      env: { ...process.env, TEMP: profile, TMP: profile },
    },
  );
  let port = null;
  for (let i = 0; i < 150 && !port; i++) {
    try {
      const txt = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      port = txt.split('\n')[0].trim() || null;
    } catch {
      /* not written yet */
    }
    if (!port) await sleep(100);
  }
  if (!port) throw new Error(`Chrome (${tag}) never reported a DevTools port`);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const cdp = connect(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const errors = [];
  cdp.on(m => {
    if (m.method === 'Runtime.exceptionThrown')
      errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  return {
    proc: chrome,
    profile,
    cdp,
    errors,
    kill: async () => {
      try {
        chrome.kill();
      } catch {
        /* already gone */
      }
      // 🔴 Wait for Chrome to exit before deleting its profile. Windows may keep file handles open
      // briefly after `kill()`, so retry removal after the process exit event.
      // (2026-10-12: this named a variable that did not exist in this file, so the first `kill()`
      // threw a ReferenceError and the profile was never deleted. The process is `chrome` here now.)
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
    },
  };
}

/** Log in through the fork's own API, from the page, so the session cookie lands in this
 *  profile exactly as a human login would leave it.
 *
 * ⚠️ Fetch the CSRF token before login. The fork returns **403** for missing CSRF and incorrect
 * credentials, so omitting it obscures the actual failure. */
async function login(cdp, user) {
  await cdp.send('Page.navigate', { url: `${stBase}/login` });
  await waitFor(cdp, `document.readyState === 'complete'`);
  const res = await evaluate(
    cdp,
    `(async () => {
        const c = await (await fetch('/csrf-token')).json();
        const r = await fetch('/api/users/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-CSRF-Token': c.token},
            body: JSON.stringify({handle: ${JSON.stringify(user.handle)},
                                  password: ${JSON.stringify(user.password)}}),
        });
        return {status: r.status, body: await r.text()};
    })()`,
  );
  return res;
}

const sessions = [];
try {
  // ── set each user up, in their own browser ────────────────────────────────
  for (const user of USERS) {
    const s = await launchChrome(user.handle);
    sessions.push({ ...s, user });
    const r = await login(s.cdp, user);
    ok(r.status === 200, `${user.handle}: logged in to SillyTavern (${r.status} ${r.body || ''})`);

    await cdpNavigateHome(s.cdp);
    // The extension is installed in this user's OWN folder (`data/<handle>/extensions/Vocalis`),
    // which is claim 6's per-user install path: it needs no admin rights at all.
    await mustWait(
      s.cdp,
      `!!(window.SillyTavern && SillyTavern.getContext
                                 && SillyTavern.getContext().extensionSettings)`,
      `${user.handle}: SillyTavern context is available`,
    );
    await mustWait(s.cdp, `!!document.querySelector('#vocalis_url')`, `${user.handle}: the Vocalis settings panel rendered in the drawer`);

    // Configure through the REAL controls — set the value and fire `change`, which is the
    // event the extension binds (a direct settings poke would prove nothing about wiring).
    await evaluate(
      s.cdp,
      `(() => {
            const u = document.querySelector('#vocalis_url');
            u.value = ${JSON.stringify(user.url)};
            u.dispatchEvent(new Event('change', {bubbles: true}));
            const t = document.querySelector('#vocalis_token');
            t.value = ${JSON.stringify(user.token)};
            t.dispatchEvent(new Event('change', {bubbles: true}));
            return true;
        })()`,
    );
    const saved = await evaluate(
      s.cdp,
      `(() => { const s = SillyTavern.getContext().extensionSettings.vocalis;
                      return {url: s.serverUrl, tok: s.pairToken}; })()`,
    );
    ok(saved.url === user.url && saved.tok === user.token, `${user.handle}: the drawer wrote its own serverUrl + token (${saved.url})`);
  }

  // ── claim 1 — a NON-ADMIN can configure Vocalis, and it PERSISTS a reload ──
  // 🔴 Let the extension's change handlers call `saveSettingsDebounced()`. The settings endpoint
  // replaces the full in-memory settings file, so a hand-built partial POST would overwrite state
  // the test is observing and could race other interactions in the tab.
  for (const s of sessions) {
    await evaluate(
      s.cdp,
      `(() => { SillyTavern.getContext().saveSettingsDebounced();
                                        return true; })()`,
    ).catch(() => {});
  }
  // 🔴 WAIT FOR THE WRITE TO LAND — DO NOT SLEEP THE DEBOUNCE. This was `sleep(4000)`: one
  // second of `debounce(saveSettings, 1000)`, plus the write, plus three seconds of margin. The
  // margin is a guess, not a bound — the debounce timer RESTARTS on every other
  // `saveSettingsDebounced` in the tab, so under load four seconds can genuinely not be enough
  // while on an idle box it is 3.5 s of waiting for nothing.
  //
  // The write is directly observable: read it back out of their own settings endpoint. Exactly
  // the fix 7.5.18 made in `createPersona`/`writePersona`, for exactly this reason — a scheduled
  // write is not a write.
  for (const s of sessions) {
    const landed = await waitForAsync(
      s.cdp,
      `(async () => {
            const r = await fetch('/api/settings/get', {method: 'POST',
                headers: SillyTavern.getContext().getRequestHeaders(), body: '{}'});
            if (!r.ok) return false;
            const b = await r.json();
            const saved = JSON.parse(String(b && b.settings ? b.settings : '{}'));
            const v = (saved.extension_settings || {}).vocalis || {};
            return v.serverUrl === ${JSON.stringify(s.user.url)}
                && v.pairToken === ${JSON.stringify(s.user.token)};
        })()`,
      20000,
    );
    // Loud, and with the reason. A silent timeout here would surface as claim 1 going red
    // several lines later, describing a persistence bug that is really this wait giving up.
    if (!landed) {
      throw new Error(
        `${s.user.handle}: the extension settings never reached settings.json ` + `— the reload below would have tested nothing`,
      );
    }
  }
  for (const s of sessions) {
    await cdpNavigateHome(s.cdp);
    await mustWait(
      s.cdp,
      `!!(window.SillyTavern && SillyTavern.getContext()
                                  && SillyTavern.getContext().extensionSettings
                                  && SillyTavern.getContext().extensionSettings.vocalis)`,
      `${s.user.handle}: settings are back after a reload`,
    );
    const after = await evaluate(
      s.cdp,
      `(() => { const v = SillyTavern.getContext().extensionSettings.vocalis;
                      return {url: v.serverUrl, tok: v.pairToken}; })()`,
    );
    ok(
      after.url === s.user.url && after.tok === s.user.token,
      `claim 1: ${s.user.handle}${s.user.admin ? '' : ' (NON-ADMIN)'} kept its own ` + `Vocalis config across a reload (${after.url})`,
    );
  }

  // ── claim 2 — the two users' settings are genuinely independent ────────────
  {
    const a = await evaluate(sessions[0].cdp, `SillyTavern.getContext().extensionSettings.vocalis.serverUrl`);
    const b = await evaluate(sessions[1].cdp, `SillyTavern.getContext().extensionSettings.vocalis.serverUrl`);
    ok(a === vocA && b === vocB && a !== b, `claim 2: each user's own settings.json carries only their own Vocalis (${a} | ${b})`);
    const ta = await evaluate(sessions[0].cdp, `SillyTavern.getContext().extensionSettings.vocalis.pairToken`);
    const tb = await evaluate(sessions[1].cdp, `SillyTavern.getContext().extensionSettings.vocalis.pairToken`);
    ok(ta === tokA && tb === tokB && ta !== tb, 'claim 2: …and only their own pairing token');
  }

  // ── claim 3 (browser half) — a token does not work against the other server ─
  // The wire-level proof is rig_probe; this is the same fact THROUGH THE EXTENSION'S OWN
  // helper, from the page, cross-origin — the path a real narration takes.
  {
    const crossed = await evaluate(
      sessions[0].cdp,
      `(async () => {
            const r = await fetch(${JSON.stringify(vocB)} + '/v1/audio/voices',
                {headers: {'Authorization': 'Bearer ' + ${JSON.stringify(tokA)}}});
            return r.status;
        })()`,
    );
    ok(crossed === 401, `claim 3: user A's token is refused by user B's Vocalis, cross-origin (${crossed})`);
    const own = await evaluate(
      sessions[0].cdp,
      `(async () => {
            const r = await fetch(${JSON.stringify(vocA)} + '/v1/audio/voices',
                {headers: {'Authorization': 'Bearer ' + ${JSON.stringify(tokA)}}});
            return r.status;
        })()`,
    );
    ok(own === 200, `claim 3: …and accepted by their own (${own})`);
  }

  // ── claim 0, from the browser — an anonymous call is refused ───────────────
  {
    const anon = await evaluate(
      sessions[0].cdp,
      `(async () => {
            const r = await fetch(${JSON.stringify(vocA)} + '/v1/audio/voices');
            const b = await r.json().catch(() => ({}));
            return {status: r.status, shape: !!(b.error && b.error.message && b.error.type)};
        })()`,
    );
    ok(anon.status === 401 && anon.shape, `claim 0: an anonymous /v1 call from the page is 401 in OpenAI shape (${anon.status})`);
  }

  // ── claim 5 — A cannot touch B's work, through the page ────────────────────
  {
    const scene = await evaluate(
      sessions[0].cdp,
      `(async () => {
            const r = await fetch(${JSON.stringify(vocB)} + '/v1/audio/scene', {
                method: 'POST',
                headers: {'Content-Type': 'application/json',
                          'Authorization': 'Bearer ' + ${JSON.stringify(tokA)}},
                body: JSON.stringify({title: 'hostile', items: []}),
            });
            return r.status;
        })()`,
    );
    ok(scene === 401, `claim 5: A cannot open a scene on B's Vocalis — refused at the FIRST request (${scene})`);
    const cancel = await evaluate(
      sessions[0].cdp,
      `(async () => {
            const r = await fetch(${JSON.stringify(vocB)} + '/v1/audio/prerender/cancel', {
                method: 'POST',
                headers: {'Content-Type': 'application/json',
                          'Authorization': 'Bearer ' + ${JSON.stringify(tokA)}},
                body: JSON.stringify({all: true}),
            });
            return r.status;
        })()`,
    );
    ok(cancel === 401, `claim 5: …and cannot wipe B's prerender queue (${cancel})`);
  }

  // ── the extension's OWN pairing check reports paired, per user ─────────────
  for (const s of sessions) {
    const ping = await evaluate(
      s.cdp,
      `(async () => {
            const m = await import('/scripts/extensions/third-party/Vocalis/vocalis-stream.js');
            return await m.pairPing(${JSON.stringify(s.user.url)},
                                    ${JSON.stringify(s.user.token)});
        })()`,
    );
    ok(
      ping && ping.ok === true && ping.paired === true,
      `${s.user.handle}: the extension's own pairPing says paired (${JSON.stringify(ping)})`,
    );
  }

  // ── claim 4 (the gate half) — a real narration REGISTER is accepted ────────
  // 🔴 The whole point of m6 at the narration path: the same call that 401s without a token
  // succeeds with it, through the extension's real helper, cross-origin from the ST page.
  for (const s of sessions) {
    const reg = await evaluate(
      s.cdp,
      `(async () => {
            const r = await fetch(${JSON.stringify(s.user.url)} + '/v1/audio/stream', {
                method: 'POST',
                headers: {'Content-Type': 'application/json',
                          'Authorization': 'Bearer ' + ${JSON.stringify(s.user.token)}},
                body: JSON.stringify({input: 'A two user acceptance check.', voice: 'TestVoice'}),
            });
            return {status: r.status, body: await r.text()};
        })()`,
    );
    ok(
      reg.status === 200 && reg.body.includes('stream_url'),
      `claim 4: ${s.user.handle} registers a narration stream on their own Vocalis ` + `(${reg.status})`,
    );
    const bare = await evaluate(
      s.cdp,
      `(async () => {
            const r = await fetch(${JSON.stringify(s.user.url)} + '/v1/audio/stream', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({input: 'A two user acceptance check.', voice: 'TestVoice'}),
            });
            return r.status;
        })()`,
    );
    ok(bare === 401, `claim 4: …and the identical call WITHOUT the token is refused (${bare})`);
  }

  // ── claim 6 — the per-user install needed no admin ─────────────────────────
  for (const s of sessions) {
    const disc = await evaluate(
      s.cdp,
      `(async () => {
            const r = await fetch('/api/extensions/discover', {
                headers: SillyTavern.getContext().getRequestHeaders(),
            });
            const list = await r.json();
            return list.filter(e => String(e.name || '').includes('Vocalis'));
        })()`,
    );
    const local = (disc || []).some(e => e.type === 'local');
    ok(
      local,
      `claim 6: ${s.user.handle}${s.user.admin ? '' : ' (NON-ADMIN)'} loads Vocalis ` +
        `from their OWN extensions folder — no admin rights involved ` +
        `(${JSON.stringify(disc)})`,
    );
  }

  // ── no page errors from the extension ─────────────────────────────────────
  for (const s of sessions) {
    const ours = s.errors.filter(e => /vocalis/i.test(String(e)));
    ok(ours.length === 0, `${s.user.handle}: the extension threw nothing in the page (${ours.length})`);
  }
} finally {
  for (const s of sessions) await s.kill();
}

async function cdpNavigateHome(cdp) {
  await cdp.send('Page.navigate', { url: `${stBase}/` });
  await waitFor(cdp, `document.readyState === 'complete'`);
  // The extension is loaded with `await import(url)` on ST's own schedule, so the drawer is
  // the thing to wait on, never a timer.
  await waitFor(cdp, `!!document.querySelector('#vocalis_url')`, 15000);
}

process.exit(failed ? 1 : 0);

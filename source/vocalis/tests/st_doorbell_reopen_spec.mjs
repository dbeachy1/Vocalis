// The pairing channel's boundary, run against the real code.
//
// B.2 🔴 THE DOORBELL NEVER RE-OPENED AFTER A NON-200. Per the SSE spec a non-200 FAILS the
//     connection: `error` fires, `readyState` goes CLOSED, and there is no auto-reconnect.
//     `openStream`'s only caller was `startPolling`, reachable from init or a settings edit — so
//     ONE vault auto-lock (which 401s `/pair/stream`) or one 503 at `MAX_STREAMS` permanently
//     demoted that tab to the throttled 5 s polling that m5c exists to delete. Silent, permanent,
//     and it deletes a shipped feature.
// B.3   The master **Enabled** checkbox did not reach the pairing channel: a switched-off
//     extension still exported every worldbook, card and persona, and still wrote into the install.
// B.7   `sweeping` / `pushing` are per-TAB, while the no-overlap guarantee is per-REQUEST. A
//     sweep in one tab could otherwise read a card between another tab's `merge-attributes` and
//     `edit-avatar` calls.
//
// 🔴 THIS RUNS THE REAL FUNCTIONS, NOT A COPY OF THEM — the `st_persona_sync_spec.mjs` rule.
// `index.js` imports from `/scripts/...` so it cannot be imported standalone, but the whole
// pairing-channel block is contiguous at module scope: slice it out, evaluate it with the
// browser's side of the world injected as parameters (so they SHADOW the globals), and drive it.
// A test that greps `index.js` for a string passes against a function nothing ever calls.
//
// Usage: node st_doorbell_reopen_spec.mjs <extension-dir>
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const extDir = process.argv[2];
if (!extDir) {
  console.error('usage: node st_doorbell_reopen_spec.mjs <ext-dir>');
  process.exit(2);
}

let failed = 0;
const ok = (cond, what) => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

const src = await readFile(join(extDir, 'index.js'), 'utf-8');

/** Everything from `from` up to the closing brace of the declaration `until` opens. A rename or a
 *  move is a loud failure here rather than a silently-skipped test. */
function region(from, until) {
  const start = src.indexOf(from);
  if (start === -1) throw new Error(`anchor not found: ${from}`);
  const at = src.indexOf(until, start);
  if (at === -1) throw new Error(`anchor not found: ${until}`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${until}`);
}

let CHANNEL;
try {
  CHANNEL = region('const SWEEP_POLL_MS = 5000;', 'function startPolling(');
} catch (e) {
  console.error(`  FAIL the pairing-channel block could not be located: ${e.message}`);
  process.exit(1);
}
ok(CHANNEL.includes('function openStream('), 'the extracted block contains openStream');
ok(CHANNEL.includes('function startFallbackPoll('), 'the extracted block contains startFallbackPoll');
ok(CHANNEL.includes('async function pollForSweep('), 'the extracted block contains pollForSweep');

// ── the browser, as this block sees it ────────────────────────────────────────────────────────
const ES_CONNECTING = 0,
  ES_OPEN = 1,
  ES_CLOSED = 2;

function makeTab(settings, opts = {}) {
  const world = {
    clock: 1_000_000,
    sources: [],
    intervals: [],
    polls: 0,
    pollAnswer: opts.pollAnswer || (() => ({ ok: true, sweep: false, push: null })),
    runSweep: opts.runSweep || (async () => {}),
    runPush: opts.runPush || (async () => {}),
  };

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = ES_CONNECTING;
      this.handlers = {};
      this.onerror = null;
      this.closed = false;
      world.sources.push(this);
    }
    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    }
    close() {
      this.closed = true;
      this.readyState = ES_CLOSED;
    }
    /** The server answered 200 and the stream is live. */
    succeed() {
      this.readyState = ES_OPEN;
      (this.handlers.open || []).forEach(f => f());
    }
    /** A NON-200 (a locked vault's 401, a 503 at MAX_STREAMS): the spec fails the connection. */
    failResponse() {
      this.readyState = ES_CLOSED;
      if (this.onerror) this.onerror();
    }
    /** A transport drop: the browser retries this one itself, so we must not. */
    dropTransport() {
      this.readyState = ES_CONNECTING;
      if (this.onerror) this.onerror();
    }
  }

  const fakeSetInterval = (fn, ms) => {
    const h = { fn, ms, cleared: false };
    world.intervals.push(h);
    return h;
  };
  const fakeClearInterval = h => {
    if (h) h.cleared = true;
  };
  const fakeDate = { now: () => world.clock };

  const pairPoll = async () => {
    world.polls++;
    return world.pollAnswer();
  };

  const api = new Function(
    'settings',
    'pairPoll',
    'runSweep',
    'runPush',
    '$',
    'EventSource',
    'setInterval',
    'clearInterval',
    'Date',
    // 9.5.17 — the build stamp the poll now carries. Injected rather than left to the `typeof`
    // guards below, because it is read INSIDE `pollForSweep`'s call rather than named at the top
    // of the block: an undeclared const there is a ReferenceError at call time, which takes the
    // whole spec out before it reports anything, instead of a named FAIL.
    'EXT_BUILD',
    // 9.7.3 — same reasoning, same hazard: `pollForSweep` awaits the tab's build self-check before
    // it polls, and that function is declared above this block rather than inside it. Injected as a
    // no-op so this spec keeps testing the doorbell instead of the network.
    'checkOwnBuild',
    // c3ba2a68 — the same hazard a third time: the doorbell's `work` and `open` handlers now ask
    // Polish to re-read its settings (`void polishRuntime?.refresh()`), and `polishRuntime` is a
    // module-scope `let` declared far above this block. The `?.` guards a null, not an undeclared
    // name, so without this the first `open` event was a ReferenceError that ended the spec.
    'polishRuntime',
    // ⚠️ `typeof` guards, not bare names: a symbol this block does not declare is exactly what
    // a REGRESSION looks like, and it has to surface as a named FAIL rather than as a
    // ReferenceError that takes the whole spec out before it reports anything.
    `${CHANNEL}
         const has = (t) => t === 'function';
         return { startPolling, openStream, stopStream, startFallbackPoll, pollForSweep,
                  reopenStreamIfDue: has(typeof reopenStreamIfDue) ? reopenStreamIfDue : () => {},
                  streamRetryDelayMs: has(typeof streamRetryDelayMs) ? streamRetryDelayMs
                                                                     : () => NaN,
                  claimRunLock: has(typeof claimRunLock) ? claimRunLock : () => true,
                  releaseRunLock: has(typeof releaseRunLock) ? releaseRunLock : () => {},
                  state: () => ({
                      stImportTimer, stStreamSrc,
                      stStreamBackoff: typeof stStreamBackoff === 'undefined' ? null
                                                                             : stStreamBackoff,
                      stStreamRetryAt: typeof stStreamRetryAt === 'undefined' ? null
                                                                             : stStreamRetryAt }) };`,
  )(
    settings,
    pairPoll,
    (...a) => world.runSweep(...a),
    (...a) => world.runPush(...a),
    () => ({ text: () => ({ removeClass: () => ({ addClass: () => {} }) }) }),
    FakeEventSource,
    fakeSetInterval,
    fakeClearInterval,
    fakeDate,
    'spec-build',
    async () => 'current',
    { refresh: async () => {}, onRendered: () => {} },
  );

  world.api = api;
  world.live = () => world.intervals.filter(h => !h.cleared);
  world.tick = () => world.live().forEach(h => h.fn());
  world.last = () => world.sources[world.sources.length - 1];
  return world;
}

const paired = () => ({ enabled: true, serverUrl: 'https://test-server.invalid:7870', pairToken: 'tok' });

// ══ B.2 — one non-200 must not be permanent ═══════════════════════════════════════════════════
console.log('\nB.2 — the doorbell re-opens after a non-200');
{
  const tab = makeTab(paired());
  tab.api.startPolling();
  ok(tab.sources.length === 1, 'startPolling opens exactly one stream');
  tab.last().succeed();
  ok(tab.live().length === 0, 'a live stream leaves no fallback timer running');

  // The vault auto-locks: /pair/stream answers 401, which per the SSE spec CLOSES the source.
  tab.last().failResponse();
  ok(tab.live().length === 1, 'a non-200 falls back to the 5s poll');
  ok(tab.api.state().stStreamSrc.readyState === ES_CLOSED, 'and the EventSource really is CLOSED — nothing will retry it by itself');

  // Before the backoff has elapsed, a tick must NOT hammer a server that is answering 401.
  tab.clock += 1000;
  tab.tick();
  ok(tab.sources.length === 1, 'the fallback tick does not reconnect before the backoff elapses');

  // 🔴 THE REGRESSION. Nothing used to call openStream() again, ever.
  tab.clock += 10_000;
  tab.tick();
  ok(tab.sources.length === 2, 'the fallback tick RE-OPENS the stream once the backoff has elapsed');

  tab.last().succeed();
  ok(tab.live().length === 0, 'and a stream that comes back retires the fallback timer again');
  ok(tab.api.state().stStreamBackoff === 0, 'a working connection resets the backoff, so a tab up for a week is not stuck at the ceiling');
}
{
  const tab = makeTab(paired());
  tab.api.startPolling();
  tab.last().succeed();
  // A transport DROP leaves the source CONNECTING and the browser retries it itself. Re-opening
  // here would throw away a native reconnect that is already in flight.
  tab.last().dropTransport();
  ok(tab.live().length === 1, 'a transport drop still arms the fallback poll');
  tab.clock += 600_000;
  tab.tick();
  ok(tab.sources.length === 1, 'a transport drop is left to the browser: we never re-open a CONNECTING source');
}
{
  const tab = makeTab(paired());
  const d = tab.api.streamRetryDelayMs;
  ok(d(0) === 5000 && d(1) === 10000 && d(2) === 20000, 'the retry backoff is exponential from 5s');
  ok(d(99) === 300000, 'and is capped at five minutes, however long the server stays down');
}
{
  // A server that stays down: successive attempts must space out rather than run every 5s.
  const tab = makeTab(paired());
  tab.api.startPolling();
  const attempts = [];
  for (let i = 0; i < 4; i++) {
    tab.last().failResponse();
    const before = tab.sources.length;
    let waited = 0;
    while (tab.sources.length === before && waited < 600_000) {
      tab.clock += 1000;
      waited += 1000;
      tab.tick();
    }
    attempts.push(waited);
  }
  ok(
    attempts[1] > attempts[0] && attempts[2] > attempts[1],
    `a server that stays down is retried further and further apart (${attempts.join(', ')}ms)`,
  );
}

// ══ B.3 — the master Enabled checkbox gates the pairing channel ═══════════════════════════════
console.log('\nB.3 — Enabled gates the pairing channel');
{
  const tab = makeTab({ enabled: false, serverUrl: 'https://test-server.invalid:7870', pairToken: 'tok' });
  tab.api.startPolling();
  ok(tab.sources.length === 0, 'a switched-off extension opens no stream');
  ok(tab.live().length === 0, 'and arms no fallback poll');
}
{
  const off = { enabled: false, serverUrl: 'https://test-server.invalid:7870', pairToken: 'tok' };
  const tab = makeTab(off);
  await tab.api.pollForSweep();
  ok(tab.polls === 0, 'a switched-off extension never claims a sweep, so it exports nothing and writes nothing');
  off.enabled = true;
  await tab.api.pollForSweep();
  ok(tab.polls === 1, 'and ticking the box back on restores the channel');
}
{
  const tab = makeTab({ enabled: false, serverUrl: 'https://test-server.invalid:7870', pairToken: 'tok' });
  tab.api.startFallbackPoll();
  ok(tab.live().length === 0, 'the degraded channel is gated too, not only the stream');
}

// ══ B.7 — one run at a time ACROSS tabs, not merely within one ════════════════════════════════
console.log('\nB.7 — the cross-tab run lock');
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };

  let releaseSweep;
  const sweepRunning = new Promise(res => {
    releaseSweep = res;
  });
  const a = makeTab(paired(), {
    pollAnswer: () => ({ ok: true, sweep: true, push: null }),
    runSweep: () => sweepRunning,
  });
  const b = makeTab(paired(), { pollAnswer: () => ({ ok: true, sweep: false, push: null }) });

  const aRun = a.api.pollForSweep();
  await Promise.resolve(); // let A get as far as its await
  ok(a.polls === 1, 'tab A claims the sweep');

  await b.api.pollForSweep();
  ok(
    b.polls === 0,
    'tab B does not claim a job while tab A is mid-run — a sweep can no longer read a card ' +
      'between a send’s merge-attributes and its edit-avatar',
  );

  releaseSweep();
  await aRun;
  await b.api.pollForSweep();
  ok(b.polls === 1, 'and tab B polls again the moment tab A’s run ends');
}
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  // 🔴 A CRASHED TAB MUST NOT BLOCK THE FEATURE FOREVER. The lease expires; it is re-stamped as
  // work happens rather than on a timer, because Chrome throttles a hidden tab's timers.
  store.set('vocalis_st_run_lock', JSON.stringify({ id: 'a-tab-that-died', until: 5 }));
  const tab = makeTab(paired());
  await tab.api.pollForSweep();
  ok(tab.polls === 1, 'an expired lease from a crashed tab is taken over, not waited on forever');
}
{
  // 🔴 THE DOORBELL IS A BROADCAST, so two tabs are woken by the same frame in the same
  // millisecond — and a `localStorage` read-modify-write is not atomic across tabs, so both can
  // find the slot free. The claim writes and then READS BACK, which makes it last-writer-wins
  // with both sides agreeing on the winner. This stubs the slot being overwritten by the other
  // tab in exactly that window.
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: k => store.set(k, JSON.stringify({ id: 'the-other-tab', until: 9e15 })),
    removeItem: k => store.delete(k),
  };
  const tab = makeTab(paired());
  await tab.api.pollForSweep();
  ok(tab.polls === 0, 'a tab that loses the write race sees the other tab’s id when it reads back, and stands down');
}
{
  // Storage can be absent or throw on access (a sandboxed frame, third-party cookie blocking).
  // Every failure mode has to degrade to the behavior that shipped, never to a stall.
  const saved = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('access denied');
    },
  });
  const tab = makeTab(paired());
  let threw = false;
  try {
    await tab.api.pollForSweep();
  } catch {
    threw = true;
  }
  ok(!threw && tab.polls === 1, 'no usable storage degrades to the per-tab guards alone rather than blocking the feature');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: saved,
    writable: true,
  });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

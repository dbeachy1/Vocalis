// Vocalis 3.0-M4 — extension <-> server smoke, driven by tests/test_st_extension_smoke.py.
//
// Runs the REAL sillytavern/extension/vocalis-stream.js under plain Node against a
// real HTTP server running the real stream blueprint (generation faked server-side).
// Browser audio is faked (window / Audio / URL.createObjectURL), so the MediaSource
// branch is skipped and playback takes the module's blob-fallback path. What this
// DOES prove end-to-end: the register POST, /v1 OpenAI error-shape parsing, relative
// stream/status URL resolution against the server base, a real chunked progressive-
// MP3 transfer, the /status truncation check, and the onTruncated retry closure.
// The MediaSource pump itself is the field-proven Nomi v1.5 recipe — validated live.
//
// Usage: node st_player_smoke.mjs <serverBase> <path-to-vocalis-stream.js> [pairing-token]
// Exit 0 = all checks passed.
//
// 7.0-m6: when a pairing token is given it rides every /v1 helper call, and the Python side
// records what actually arrived — the two halves of the credential are agreed on by nobody
// (test_st_extension_smoke's own words), so the smoke is where "the client sends what the
// gate reads" gets proven over a real socket.
import { copyFile, mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [base, srcPath, token] = process.argv.slice(2);
if (!base || !srcPath) {
  console.error('usage: node st_player_smoke.mjs <serverBase> <vocalis-stream.js> [token]');
  process.exit(2);
}

// ── fake browser globals (audio sink only — fetch/URL/Blob are real Node) ──────
let lastBlob = null;
globalThis.window = globalThis; // window.MediaSource -> undefined
globalThis.URL.createObjectURL = b => {
  lastBlob = b;
  return 'blob:smoke';
};
globalThis.URL.revokeObjectURL = () => {};
globalThis.Audio = class {
  constructor(src) {
    this.src = src;
    this._ls = {};
  }
  addEventListener(ev, fn) {
    (this._ls[ev] = this._ls[ev] || []).push(fn);
  }
  _fire(ev, arg) {
    for (const f of this._ls[ev] || []) f(arg);
  }
  pause() {}
  async play() {
    // "playback": instant start + end
    queueMicrotask(() => {
      this._fire('playing');
      // The 10 ms only makes "playback" asynchronous so 'playing' is observed before 'ended'.
      // Nothing in this file waits for it to elapse: the spec awaits the onEnded callback itself.
      setTimeout(() => this._fire('ended'), 10);
    });
  }
};

// The extension file is plain .js (ESM in the browser); Node needs .mjs to parse
// it as a module, so import a byte-identical temp copy.
const tmp = await mkdtemp(join(tmpdir(), 'vocalis-smoke-'));
const mjs = join(tmp, 'vocalis-stream.mjs');
await copyFile(srcPath, mjs);
const { playStream, probeHealth, fetchVoices, registerCharacters, prerender, cancelPrerender, fetchStates, MAX_STATE_ITEMS } = await import(
  pathToFileURL(mjs).href
);

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'ok - ' : 'FAIL - ') + msg);
  if (!cond) failed++;
};
const withTimeout = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), 30000))]);

// 1. /health probe (the settings-panel Test button)
const h = await withTimeout(probeHealth(base), 'probeHealth');
ok(h.ok === true, `probeHealth reaches the server (${JSON.stringify(h.info || h.error)})`);

// 2. voice list (settings dropdowns)
const vs = await withTimeout(fetchVoices(base, token), 'fetchVoices');
ok(vs.includes('v'), `fetchVoices returns stems (${JSON.stringify(vs)})`);

// 2b. character push (the extension's chat-open registration)
const added = await withTimeout(registerCharacters(base, ['SmokeChar'], token), 'registerCharacters');
ok(added === 1, `registerCharacters upserted a new name (${added})`);

// 3. happy path AS A CHARACTER: register -> stream -> play -> ended -> /status
// says done ('Test Character' is pre-assigned a server-side voice, so this proves
// the character->voice resolution over the wire too)
await withTimeout(
  new Promise((resolve, reject) => {
    let played = false;
    playStream({
      serverBase: base,
      token,
      body: { input: 'Hello smoke world, this is a full message.', character: 'Test Character' },
      onPlaying: () => {
        played = true;
      },
      onEnded: () => {
        ok(played, 'onPlaying fired before onEnded');
        resolve();
      },
      onError: m => reject(new Error('unexpected onError: ' + m)),
      onTruncated: () => reject(new Error('unexpected onTruncated')),
    });
  }),
  'happy path',
);
{
  const buf = Buffer.from(await lastBlob.arrayBuffer());
  ok(buf.length > 1000, `stream delivered audio (${buf.length} bytes)`);
  ok(buf[0] === 0xff || buf.subarray(0, 3).toString() === 'ID3', 'payload is MP3');
}

// 3b. 5.2 pre-render, over the same real socket. The check that matters is the
// KEY IDENTITY one: the extension's two helpers must put the same body on the wire,
// or the server derives two different cache keys and every message renders twice
// with nothing anywhere reporting it. Proving it here — through the real client
// helpers rather than by posting hand-built JSON — is the point.
{
  const body = { input: 'A line the user has not clicked yet.', character: 'Test Character' };
  const pre = await withTimeout(prerender(base, body, token), 'prerender');
  ok(typeof pre.cache_key === 'string' && pre.cache_key.length === 32, `prerender returns a cache key (${pre.cache_key})`);
  ok(['queued', 'running', 'cached'].includes(pre.state), `prerender accepted the job (state=${pre.state})`);

  // wait for the producer to finish and promote (raw fetches carry the bearer by hand — the
  // python side asserts EVERY /v1 request arrived authenticated)
  const bearer = { Authorization: `Bearer ${String(token || '')}` };
  // A condition, not a duration: ask the server whether the job is done. The 100 ms is only the
  // step between asks; the 60 s deadline only bounds a hang (it was 200 asks, i.e. about 20 s,
  // which a heavily loaded suite run could in principle exceed while the render was still going).
  let stats = null;
  const statsDeadline = Date.now() + 60000;
  while (!(stats && stats.completed >= 1) && Date.now() < statsDeadline) {
    await new Promise(r => setTimeout(r, 100));
    stats = await (await fetch(`${base}/v1/audio/prerender/stats`, { headers: bearer })).json();
  }
  ok(stats && stats.completed >= 1, `the pre-render completed (${JSON.stringify(stats)})`);

  // The click. Same body, same helper contract -> the server must recognize it.
  // (Raw fetch, so the header is built by hand — the helpers' path is everything above.)
  const reg = await (
    await fetch(`${base}/v1/audio/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(token || '')}`,
      },
      body: JSON.stringify(body),
    })
  ).json();
  ok(reg.cache_key === pre.cache_key, 'prerender and stream agree on the cache key (the whole feature rides on this)');
  ok(reg.cached === true && reg.source === 'cache', `the click is a cache hit (cached=${reg.cached}, source=${reg.source})`);

  const canceled = await withTimeout(cancelPrerender(base, { all: true }, token), 'cancelPrerender');
  ok(typeof canceled.canceled === 'number', 'cancelPrerender answers with a count');

  // 3c. 5.4 button state, over the same socket and through the same helper. The message
  // above is now cached, so this is the green case — and the third route that has to agree
  // with the other two about the key. A probe that resolves differently would leave the
  // button orange on a message that plays instantly, silently.
  const unseen = { input: 'A line nobody has ever asked for.', character: 'Test Character' };
  const got = await withTimeout(fetchStates(base, [body, unseen, { input: '   ' }], token), 'fetchStates');
  ok(got.length === 3, `fetchStates answers one state per item (${got.length})`);
  ok(got[0].cache_key === pre.cache_key, 'the probe and the render agree on the cache key (§5.3)');
  ok(got[0].state === 'cached', `a cached message reads green (state=${got[0].state})`);
  ok(got[1].state === 'none', `an unrendered message reads orange (state=${got[1].state})`);
  ok(got[2].state === 'none' && got[2].cache_key === null, 'an unspeakable item degrades to none instead of failing its siblings');

  // 🔴 The probe must not have QUEUED the unrendered one — that is the whole reason it is
  // not just a call to /v1/audio/prerender.
  const after = await (await fetch(`${base}/v1/audio/prerender/stats`, { headers: bearer })).json();
  ok(after.queued === 0, `the probe queued nothing (queued=${after.queued})`);

  // The client chunks to the server's cap rather than sending one oversized batch: a chat
  // with truncation switched off paints more than this in one go.
  const many = await withTimeout(fetchStates(base, Array(MAX_STATE_ITEMS + 5).fill(unseen), token), 'fetchStates over the cap');
  ok(many.length === MAX_STATE_ITEMS + 5, `fetchStates chunks past the ${MAX_STATE_ITEMS}-item cap (${many.length} back)`);
}

// 4. /v1 error shape: unknown voice -> onError with the server's message
await withTimeout(
  new Promise((resolve, reject) => {
    playStream({
      serverBase: base,
      token,
      body: { input: 'hi', voice: 'no-such-voice' },
      onError: m => {
        ok(String(m).includes('unknown voice'), `error shape parsed ("${m}")`);
        resolve();
      },
      onEnded: () => reject(new Error('unknown voice should not play')),
      onTruncated: () => reject(new Error('unknown voice should not truncate')),
    });
  }),
  'unknown voice',
);

// 5+6. truncation: server dies mid-generation -> /status=error -> onTruncated;
// calling retry() re-registers and truncates again (proves the retry closure).
let truncations = 0;
await withTimeout(
  new Promise((resolve, reject) => {
    playStream({
      serverBase: base,
      token,
      body: { input: 'BOOM this message dies mid stream on the server.' },
      onTruncated: retry => {
        truncations++;
        if (truncations === 1) retry();
        else resolve();
      },
      onError: m => reject(new Error('unexpected onError: ' + m)),
      onEnded: () => reject(new Error('truncated stream must not report onEnded')),
    });
  }),
  'truncation + retry',
);
ok(truncations === 2, 'retry() re-registered and the truncation check fired again');

// 7. Error-BODY shapes. §4 above proves the OpenAI shape over a real socket, but
// 5.0's lock gate answers BEFORE the blueprint with a different, flatter shape, and
// the real server cannot produce it without locking the vault out from under whoever
// else is on the box. So these four are driven against a stubbed fetch — LAST, because
// stubbing it clobbers the real one every check above depends on. LOCKED is copied
// verbatim from _LOCKED_BODY (src/vocalis_server.py). The regression this guards: a
// parser that reads only `error` renders a bare "locked" and throws away the one
// sentence that tells the user what to do about it.
const LOCKED = {
  status: 401,
  body: { error: 'locked', message: 'Vocalis is locked. Log in to unlock.' },
};
const NESTED = {
  status: 400,
  body: { error: { message: 'unknown voice: nope.wav', type: 'invalid_request_error' } },
};
const FLATSTR = {
  status: 401,
  body: { error: 'authentication required — log in to the Vocalis admin UI' },
};
const NOTJSON = { status: 503, body: null };
// 7.0-m6: the gate's own 401 — OpenAI shape, and the one case `info.auth` must be true for,
// because it is what routes the user to §6.2's "set your token" guidance instead of a raw toast.
const AUTH401 = {
  status: 401,
  body: {
    error: {
      message: 'pairing token required — copy it from the Vocalis web UI',
      type: 'invalid_request_error',
    },
  },
};

const errorFor = c => {
  globalThis.fetch = async () => ({
    ok: false,
    status: c.status,
    json: async () => {
      if (c.body === null) throw new Error('not json');
      return c.body;
    },
  });
  return new Promise(resolve => {
    playStream({
      serverBase: base,
      body: { input: 'x' },
      onError: (m, info) => resolve({ m, info }),
    });
  });
};

{
  const locked = await withTimeout(errorFor(LOCKED), 'locked body');
  ok(locked.m === 'Vocalis is locked. Log in to unlock.', 'lock body -> the unlock instruction, not a bare "locked"');
  // 🔴 m6: a locked vault is NOT an auth failure — `auth: true` here would fire the "set your
  // token" guidance at a user whose token is right, whose next step is Generate, which ROTATES it.
  ok(locked.info.locked === true && locked.info.auth !== true, 'a locked 401 reports locked, never auth');
  const auth = await withTimeout(errorFor(AUTH401), 'auth 401 body');
  ok(auth.m === 'pairing token required — copy it from the Vocalis web UI', 'the gate 401 surfaces its own message');
  ok(auth.info.auth === true && auth.info.locked !== true, 'a token-rejected 401 reports auth, never locked');
  ok(
    (await withTimeout(errorFor(NESTED), 'nested body')).m === 'unknown voice: nope.wav',
    'OpenAI nested shape still wins over a sibling message',
  );
  const flat = await withTimeout(errorFor(FLATSTR), 'flat body');
  ok(flat.m === 'authentication required — log in to the Vocalis admin UI', 'flat string error is surfaced as-is');
  ok(
    (await withTimeout(errorFor(NOTJSON), 'unparseable body')).m === 'register failed (503)',
    'unparseable body falls back to the status code',
  );
}

// 🔴 THE TEMP COPY GOES. It is one small .mjs, but this runs inside pytest on every suite
// run and an unremoved mkdtemp is the shape that reached 282 GB in August. Sync and last,
// because process.exit does not wait for a promise.
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a held handle is litter, not a failed spec */
}
process.exit(failed ? 1 : 0);

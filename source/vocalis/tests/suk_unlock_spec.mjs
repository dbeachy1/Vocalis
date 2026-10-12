// A locked-vault 401 re-opens the vault with the tab's Session Unlock Key instead of signing the
// user out (2026-10-09, M1 on the AMD test host: ⏏ Free Vocalis VRAM restarts the server, and the first poller
// to land after the restart got the locked 401 and navigated to /login before /health could
// redeem). Runs the real util/suk.js and util/http.js against stubbed browser globals.
//
// Usage: node suk_unlock_spec.mjs   (exit 0 = all checks passed)
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'webui', 'js');

class MemoryStorage {
  constructor() {
    this.m = new Map();
  }
  get length() {
    return this.m.size;
  }
  key(i) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(k, String(v));
  }
  removeItem(k) {
    this.m.delete(k);
  }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const LOCKED = { error: 'locked', message: 'Vocalis is locked. Log in to unlock.' };

globalThis.window = globalThis;
globalThis.document = { querySelector: () => null, addEventListener() {}, visibilityState: 'visible' };
globalThis.addEventListener = () => {};
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
// 🔴 NAVIGATION IS AN EVENT, SO THE STUB ANNOUNCES IT (2026-10-12). A 401 that cannot be recovered
// navigates to /login and leaves the promise pending forever, so a check has nothing to await —
// and these three used to `await new Promise(r => setTimeout(r, 20))` and then look at
// `location.href`: 20 ms of hope that the fetch stub, the clone/parse of the body and the SUK
// redemption had all run, which a loaded machine can easily outlast. Assigning `href` now resolves
// whoever is waiting in `navigated()`, so the assertion runs at the moment the page would have left.
let navWaiters = [];
globalThis.location = {
  _href: '/',
  get href() {
    return this._href;
  },
  set href(v) {
    this._href = v;
    navWaiters.splice(0).forEach(resolve => resolve(v));
  },
};
/** Resolves with the new href once the code under test navigates; rejects (saying what the stub saw)
 *  if it never does within the bound, which only exists so a genuine hang fails instead of hanging. */
function navigated(deadlineMs = 30000) {
  if (location.href !== '/') return Promise.resolve(location.href);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      navWaiters = navWaiters.filter(w => w !== done);
      reject(new Error(`the code under test never navigated; requests seen: ${JSON.stringify(calls.map(c => c.u))}`));
    }, deadlineMs);
    const done = v => {
      clearTimeout(timer);
      resolve(v);
    };
    navWaiters.push(done);
  });
}

/** Install a scripted server: `routes` maps a URL to a function returning a Response. */
let calls = [];
function serve(routes) {
  calls = [];
  globalThis.fetch = async (u, init) => {
    calls.push({ u, method: (init && init.method) || 'GET', body: init && init.body });
    const h = routes[u];
    if (!h) throw new Error('unexpected request ' + u);
    return h(init);
  };
}

const { jget } = await import(pathToFileURL(join(JS, 'util', 'http.js')).href);
const { redeemSuk } = await import(pathToFileURL(join(JS, 'util', 'suk.js')).href);

let failed = 0;
async function check(name, fn) {
  try {
    globalThis.location._href = '/';
    sessionStorage.m.clear();
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

await check('a locked 401 redeems the SUK and retries the request once', async () => {
  sessionStorage.setItem('vocalis-suk', 'suk-1');
  let unlocked = false;
  serve({
    '/comfyui/status': () => (unlocked ? json(200, { available: false }) : json(401, LOCKED)),
    '/health': () => json(200, { locked: !unlocked }),
    '/vault/unlock-suk': init => {
      assert.equal(JSON.parse(init.body).suk, 'suk-1');
      unlocked = true;
      return json(200, { ok: true, suk: 'suk-2' });
    },
  });
  assert.deepEqual(await jget('/comfyui/status'), { available: false });
  assert.equal(location.href, '/', 'must not navigate to /login');
  assert.equal(sessionStorage.getItem('vocalis-suk'), 'suk-2', 'the fresh SUK is stored');
  assert.deepEqual(
    calls.map(c => c.u),
    ['/comfyui/status', '/health', '/vault/unlock-suk', '/comfyui/status'],
  );
});

await check('concurrent locked 401s spend the single-use SUK exactly once', async () => {
  sessionStorage.setItem('vocalis-suk', 'suk-1');
  let unlocked = false;
  serve({
    '/a': () => (unlocked ? json(200, { a: 1 }) : json(401, LOCKED)),
    '/b': () => (unlocked ? json(200, { b: 1 }) : json(401, LOCKED)),
    '/health': () => json(200, { locked: !unlocked }),
    // Single-use: only the key the tab started with is accepted, so a second spend would fail.
    '/vault/unlock-suk': init => {
      if (JSON.parse(init.body).suk !== 'suk-1') return json(401, { error: 'suk_rejected' });
      unlocked = true;
      return json(200, { ok: true, suk: 'suk-2' });
    },
  });
  const [a, b] = await Promise.all([jget('/a'), jget('/b'), redeemSuk()]);
  assert.deepEqual([a, b], [{ a: 1 }, { b: 1 }]);
  assert.equal(calls.filter(c => c.u === '/vault/unlock-suk').length, 1);
  assert.equal(sessionStorage.getItem('vocalis-suk'), 'suk-2');
});

await check('a sign-in 401 (not locked) still goes to /login without redeeming', async () => {
  sessionStorage.setItem('vocalis-suk', 'suk-1');
  serve({ '/x': () => json(401, { error: 'auth required' }) });
  const pending = jget('/x');
  await navigated();
  assert.equal(location.href, '/login');
  assert.equal(calls.length, 1, 'no redemption for a plain sign-in 401');
  void pending;
});

await check('a rejected SUK drops the key and falls back to /login', async () => {
  sessionStorage.setItem('vocalis-suk', 'stale');
  serve({
    '/y': () => json(401, LOCKED),
    '/health': () => json(200, { locked: true }),
    '/vault/unlock-suk': () => json(401, { error: 'suk_rejected' }),
  });
  void jget('/y');
  await navigated();
  assert.equal(location.href, '/login');
  assert.equal(sessionStorage.getItem('vocalis-suk'), null);
});

await check('without a SUK a locked 401 goes straight to /login', async () => {
  serve({ '/z': () => json(401, LOCKED) });
  void jget('/z');
  await navigated();
  assert.equal(location.href, '/login');
  assert.equal(calls.length, 1);
});

if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nall checks passed');

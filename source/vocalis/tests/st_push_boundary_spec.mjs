// Run the real boundary functions. Source excerpts from parse errors must not reach sweep results,
// storage, or rendered output. Push failures retain actionable status, and each SillyTavern write
// has a timeout so a stalled request cannot leave the tab permanently busy.
//
// 🔴 THIS RUNS THE REAL FUNCTIONS, NOT A COPY OF THEM — the `st_persona_sync_spec.mjs` rule. A
// test that greps `index.js` for a string passes against a function that is never called.
//
// Usage: node st_push_boundary_spec.mjs <extension-dir>
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const extDir = process.argv[2];
if (!extDir) {
  console.error('usage: node st_push_boundary_spec.mjs <ext-dir>');
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

/** Source from `from` (or from `until` when `from` is absent) through the closing brace of the
 *  declaration `until` opens. A rename or a move is a loud failure rather than a skipped test.
 *  ⚠️ A MISSING `from` IS NOT AN ERROR HERE: that is exactly what the pre-fix file looks like,
 *  and the behavioral checks below have to be the thing that reports it. */
function region(from, until) {
  const at = src.indexOf(until);
  if (at === -1) return null;
  let start = from ? src.indexOf(from) : -1;
  if (start === -1 || start > at) start = at;
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
const one = decl => region(null, decl) || '';

const SWEEPS = region('async function sweepBooks(', 'async function fetchCardPng(');
const WRITES = region('async function writePlan(', 'async function writeCard(');
ok(SWEEPS !== null, 'the sweep block (sweepBooks … fetchCardPng) brace-matches out of index.js');
ok(WRITES !== null, 'the write block (writePlan … writeCard) brace-matches out of index.js');
if (SWEEPS === null || WRITES === null) process.exit(1);

// The helpers the two blocks lean on, each brace-matched individually because they do not sit
// next to the blocks. ⚠️ ABSENT IS ALLOWED, AND IS THE POINT: that is what the pre-fix file looks
// like, and the BEHAVIORAL checks below have to be what reports it — not a crash at load.
const CEILING = (src.match(/^const ST_(?:CALL|WRITE)_TIMEOUT_MS = \d+;$/m) || [])[0] || 'const ST_CALL_TIMEOUT_MS = 60000;';
const HELPERS = [
  one('function errClass('),
  one('const PUSH_FAIL = {'),
  one('function notePushFailure('),
  one('async function runSweep('),
  CEILING,
  one('async function stFetch('),
  one('function withTimeout('),
  // 11.1.8 — the cache bust. `bustAvatar` is REAL here (its two module reaches are injected), so
  // the checks below drive the actual helper rather than a stand-in that cannot be wrong.
  one('async function bustAvatar('),
].join('\n');

// ── the browser and SillyTavern, as these functions see them ─────────────────────────────────
function build(inject) {
  const body = `
        let sweeping = false;
        ${HELPERS}
        ${SWEEPS}
        ${WRITES}
        const has = (t) => t === 'function';
        return {
            sweepBooks, sweepCards, sweepPersonas, fetchCardPng, writeBook, writeCard, bustAvatar,
            // 9a.33 — createCard sits INSIDE the WRITES slice (between writeBook and writeCard),
            // so it is defined here already; returning it is what lets the checks below drive it
            // directly rather than only through writeCard's create branch.
            // NO BACKTICKS IN THIS COMMENT — it is inside a template literal, and this file has
            // now been bitten by that a fourth time.
            createCard: has(typeof createCard) ? createCard : null,
            runSweep: has(typeof runSweep) ? runSweep : null,
            errClass: has(typeof errClass) ? errClass : null,
        };`;
  return new Function(
    'ctx',
    'settings',
    'pushDocument',
    'pushAvatar',
    'fetchAvatar',
    'sweepDone',
    'sweepSay',
    'PUSH_REASONS',
    'refreshRunLock',
    'fetch',
    'console',
    'setTimeout',
    'clearTimeout',
    // 11.1.8 — SillyTavern's own modules, which `bustAvatar` reaches by absolute URL. They are
    // parameters for one reason: a real dynamic import of /script.js resolves against the
    // FILESYSTEM ROOT under Node and can only ever reject, so a spec that let it run would prove
    // that the catch works and nothing else. Naming them here is what lets the checks below see
    // which function was called, with which filename, and in what order.
    'stScript',
    'stPersonas',
    body,
  )(
    inject.ctx,
    inject.settings,
    inject.pushDocument,
    inject.pushAvatar,
    inject.fetchAvatar || (async () => ({ ok: false })),
    inject.sweepDone || (async () => {}),
    inject.sweepSay || (() => {}),
    inject.PUSH_REASONS || PUSH_REASONS_REAL,
    inject.refreshRunLock || (() => {}),
    inject.fetch || (async () => ({ ok: false, status: 0 })),
    { error: () => {}, warn: () => {}, log: () => {} },
    // ⚠️ The 60 s production ceiling compressed to 30 ms. The VALUE is not what is under test —
    // that a ceiling exists at all is, and a spec that really waited a minute would not be run.
    (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 30)),
    clearTimeout,
    inject.stScript || (async () => ({ bustAvatarThumbnails: async () => 0 })),
    inject.stPersonas || (async () => ({ getUserAvatar: f => `User Avatars/${f}` })),
  );
}

// `PUSH_REASONS` lives above the extracted blocks; take the real object rather than inventing one,
// so a renamed key is a failure here instead of a green test over a changed contract.
const PUSH_REASONS_REAL = new Function(`${one('const PUSH_REASONS = {')}; return PUSH_REASONS;`)();
ok(PUSH_REASONS_REAL && PUSH_REASONS_REAL.unreachable === 'SillyTavern did not answer', 'PUSH_REASONS is the real one out of index.js');

// 🔴 THE STRING THAT MUST NEVER CROSS, AND IT IS NOT A HAND-BUILT LOOKALIKE — the message below
// is produced by a real `JSON.parse` of a real malformed document on the engine running this spec.
//
// ⚠️ THE SHAPE MATTERS. V8 has two JSON failure messages and only one of them leaks: an
// unterminated string gives "Unterminated string in JSON at position 67" and quotes nothing, while
// an unexpected token gives `Unexpected token 'h', ..."ontent": the sealed "... is not valid JSON`
// — a ~20-character WINDOW OF THE SOURCE. A book that was written correctly and then corrupted
// hits the second one, which is the case B.5 is about.
const LORE = 'the sealed vault beneath Test World Book 2 holds the third heir';
const NEEDLE = 'the sealed';
const leakySyntaxError = () => {
  try {
    JSON.parse(`{"content": ${LORE}}`);
  } catch (e) {
    return e;
  }
  throw new Error('JSON.parse did not throw — the fixture is wrong');
};
ok(leakySyntaxError().message.includes(NEEDLE), "V8's SyntaxError really does quote the source — the premise of B.5 holds on this engine");

const leaked = errors => errors.some(s => String(s).includes(NEEDLE));

const settings = { enabled: true, serverUrl: 'https://test-server.invalid:7870', pairToken: 'tok' };
const filed = () => ({ ok: true, created: true, id: 'doc1', revision: 1, avatar: true });
const newTally = () => ({ books: 0, cards: 0, personas: 0, unchanged: 0, errors: [], stop: '' });

/** A hang has to report as a FAIL, not as a spec that never exits. */
const HUNG = Symbol('hung');
//
// The 3 s here was a bound on a hang, but a bound that a loaded machine could in principle exceed
// with the operation still on its way (2026-10-12). It is 30 s now — still only a bound: a passing
// run settles `p` and leaves at once, and the timer is cleared so a long bound costs nothing.
const orHang = (p, ms = 30000) => {
  let timer;
  const hung = new Promise(res => {
    timer = setTimeout(() => res(HUNG), ms);
  });
  return Promise.race([p, hung]).finally(() => clearTimeout(timer));
};

// ══ B.5 — SillyTavern's exception text must not cross ═════════════════════════════════════════
console.log('\nB.5 — the class of failure crosses, never the payload');
{
  const pushed = [];
  const api = build({
    settings,
    ctx: () => ({
      getWorldInfoNames: () => ['Book A', 'Test World Book 2', 'Book C'],
      loadWorldInfo: async name => {
        if (name === 'Test World Book 2') throw leakySyntaxError();
        return { entries: {} };
      },
    }),
    pushDocument: async (u, t, ref) => {
      pushed.push(ref);
      return filed();
    },
    pushAvatar: async () => ({ ok: true }),
  });
  const tally = newTally();
  const r = await orHang(
    api.sweepBooks(tally).then(
      () => 'returned',
      e => e,
    ),
  );
  ok(r === 'returned', 'a book that fails to PARSE no longer takes the whole sweep down with it');
  ok(!leaked(tally.errors), "a truncated book's SyntaxError does not put source content into tally.errors");
  ok(
    tally.errors.some(s => s.includes('Test World Book 2') && s.includes('SyntaxError')),
    'the CLASS of the failure is reported against the book name, which is metadata',
  );
  ok(pushed.includes('Book A') && pushed.includes('Book C'), 'and the other twelve books still go across');
}
{
  // The same shape one level up: whatever else throws inside a sweep, `runSweep`'s own catch is
  // the last thing between SillyTavern's message and the vault.
  let posted = null;
  const api = build({
    settings,
    ctx: () => ({
      getWorldInfoNames: () => {
        throw leakySyntaxError();
      },
    }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    sweepDone: async (u, t, tally) => {
      posted = tally;
    },
  });
  ok(api.runSweep !== null, 'runSweep brace-matches out of index.js');
  if (api.runSweep) {
    await orHang(api.runSweep());
    ok(posted !== null, 'runSweep still reports, so the Library does not spin for five minutes');
    ok(posted && !leaked(posted.errors), 'and what it POSTs carries no window of the document it choked on');
  }
}
{
  // `/api/characters/all` answering a truncated body: `r.json()` parses card data, and its
  // SyntaxError must not be interpolated into `tally.errors`.
  const api = build({
    settings,
    ctx: () => ({ getRequestHeaders: () => ({}) }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw leakySyntaxError();
      },
    }),
  });
  const tally = newTally();
  await orHang(api.sweepCards(tally));
  ok(!leaked(tally.errors), 'a truncated /api/characters/all body does not put card text into tally.errors');
  ok(
    tally.errors.some(s => s.includes('character list') && s.includes('SyntaxError')),
    'the character-list failure still says WHAT went wrong',
  );
}
{
  const api = build({
    settings,
    ctx: () => ({ getRequestHeaders: () => ({}) }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: async () => {
      throw leakySyntaxError();
    },
  });
  const img = await orHang(api.fetchCardPng('x.png'));
  ok(
    img !== HUNG && !String(img.error).includes(NEEDLE),
    'fetchCardPng reports the class, not the message — the caller renders this into the UI',
  );
}
{
  const api = build({
    settings,
    ctx: () => ({}),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
  });
  ok(api.errClass !== null, 'errClass brace-matches out of index.js');
  if (api.errClass) {
    const e = api.errClass;
    ok(e(leakySyntaxError()) === 'SyntaxError', 'errClass names a SyntaxError');
    ok(
      e(Object.assign(new Error('x'), { name: `evil ${LORE}` })) === 'Error',
      'a name that is not a bare identifier is refused — `name` is writable',
    );
    ok(e('a thrown string') === 'Error' && e(null) === 'Error' && e(undefined) === 'Error', 'a thrown non-Error is survivable');
  }
}

// ══ B.4 — the locked / rejected distinction survives the call site ════════════════════════════
console.log('\nB.4 — locked and rejected keep their sentence');
for (const [label, answer, needle] of [
  ['a mid-sweep auto-lock', { ok: false, locked: true }, 'unlock'],
  ['a rotated token', { ok: false, paired: false }, 're-copy'],
]) {
  const pushed = [];
  const api = build({
    settings,
    ctx: () => ({
      getWorldInfoNames: () => ['Book A', 'Book B', 'Book C'],
      loadWorldInfo: async () => ({ entries: {} }),
    }),
    pushDocument: async (u, t, ref) => {
      pushed.push(ref);
      return ref === 'Book A' ? filed() : answer;
    },
    pushAvatar: async () => ({ ok: true }),
  });
  const tally = newTally();
  await orHang(api.sweepBooks(tally));
  ok(
    tally.errors.some(s => s.toLowerCase().includes(needle)),
    `${label} is reported as the sentence that fixes it, not as a list of document names`,
  );
  ok(!pushed.includes('Book C'), `${label} ends the sweep instead of filing one identical error per remaining document`);
  ok(tally.stop, `${label} sets tally.stop, so runSweep skips the remaining phases`);
}
{
  const pushed = [];
  const api = build({
    settings,
    ctx: () => ({
      getWorldInfoNames: () => ['Book A', 'Book B', 'Book C'],
      loadWorldInfo: async () => ({ entries: {} }),
    }),
    pushDocument: async (u, t, ref) => {
      pushed.push(ref);
      return ref === 'Book B' ? { ok: false, error: 'the document is too large' } : filed();
    },
    pushAvatar: async () => ({ ok: true }),
  });
  const tally = newTally();
  await orHang(api.sweepBooks(tally));
  ok(pushed.includes('Book C') && !tally.stop, 'an ordinary per-document failure is NOT fatal — one oversized book must not end the sweep');
  ok(
    tally.errors.some(s => s.includes('Book B') && s.includes('too large')),
    'and it still says which document and why',
  );
}
{
  // The same distinction at the other two call sites, which had the identical bug.
  const api = build({
    settings,
    ctx: () => ({
      getRequestHeaders: () => ({}),
      powerUserSettings: {
        personas: { 'me.png': 'Test User' },
        persona_descriptions: { 'me.png': { description: 'a description' } },
      },
    }),
    pushDocument: async () => ({ ok: false, locked: true }),
    pushAvatar: async () => ({ ok: true }),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => [{ avatar: 'x.png', name: 'X' }],
    }),
  });
  const cards = newTally();
  await orHang(api.sweepCards(cards));
  ok(
    cards.stop && cards.errors.some(s => s.toLowerCase().includes('unlock')),
    'sweepCards reports a locked vault as a locked vault, not as a failed card',
  );
  const personas = newTally();
  await orHang(api.sweepPersonas(personas));
  ok(personas.stop && personas.errors.some(s => s.toLowerCase().includes('unlock')), 'sweepPersonas does too');
}
{
  // 🔴 AND `runSweep` HAS TO ACT ON IT: a locked vault in the books phase must not be followed
  // by a cards phase that files thirteen more copies of the same sentence.
  let posted = null;
  const api = build({
    settings,
    ctx: () => ({
      getWorldInfoNames: () => ['Book A', 'Book B', 'Book C'],
      loadWorldInfo: async () => ({ entries: {} }),
      getRequestHeaders: () => ({}),
      powerUserSettings: {
        personas: { 'me.png': 'Test User' },
        persona_descriptions: { 'me.png': { description: 'a description' } },
      },
    }),
    pushDocument: async () => ({ ok: false, locked: true }),
    pushAvatar: async () => ({ ok: true }),
    sweepDone: async (u, t, tally) => {
      posted = tally;
    },
    fetch: async url => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/all')
          ? [
              { avatar: 'x.png', name: 'X' },
              { avatar: 'y.png', name: 'Y' },
            ]
          : { json_data: '{}' },
    }),
  });
  if (api.runSweep) {
    await orHang(api.runSweep());
    ok(
      posted && posted.errors.length === 1,
      'a locked vault produces ONE sentence for the whole sweep, not one row per document ' +
        `(got ${posted ? posted.errors.length : 'nothing'})`,
    );
  }
}

// ══ B.6 — a hung SillyTavern write must not wedge the tab ═════════════════════════════════════
console.log('\nB.6 — the SillyTavern write calls are bounded');
{
  const hang = (url, init) =>
    new Promise((_, reject) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  const api = build({
    settings,
    ctx: () => ({
      characters: [{ avatar: 'x.png' }],
      getRequestHeaders: () => ({}),
      getCharacters: async () => {},
    }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: hang,
  });
  const r = await orHang(api.writeCard({ kind: 'card', target: 'x.png', merge: {} }));
  ok(
    r !== HUNG,
    'a merge-attributes that never answers RETURNS — it used to leave `pushing` true for the ' +
      'life of the page, and that tab deaf to every doorbell ring',
  );
  ok(
    r !== HUNG && r.ok === false && r.reason === PUSH_REASONS_REAL.unreachable,
    'and it reports "SillyTavern did not answer", which is the only thing we actually know',
  );
}
{
  const api = build({
    settings,
    ctx: () => ({
      getWorldInfoNames: () => [],
      saveWorldInfo: () => new Promise(() => {}), // their call, no signal to abort
      updateWorldInfoList: async () => {},
      reloadWorldInfoEditor: () => {},
    }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
  });
  const r = await orHang(api.writeBook({ kind: 'worldbook', target: 'Book A', book: {} }));
  ok(r !== HUNG, 'a saveWorldInfo that never resolves RETURNS rather than wedging the tab');
  ok(
    r !== HUNG && r.ok === false && r.reason === PUSH_REASONS_REAL.unreachable,
    'and reports "did not answer" rather than "refused" — the write may still land',
  );
}
{
  // ⚠️ And the ceiling must not fire on a write that simply worked.
  let got = 0;
  const api = build({
    settings,
    ctx: () => ({
      characters: [{ avatar: 'x.png' }],
      getRequestHeaders: () => ({}),
      getCharacters: async () => {
        got++;
      },
    }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: async () => ({ ok: true, status: 200, text: async () => '' }),
  });
  const r = await orHang(api.writeCard({ kind: 'card', target: 'x.png', merge: {} }));
  ok(r !== HUNG && r.ok === true && got === 1, 'a normal card write still succeeds and still refreshes the roster');
}
// ── 7.4 / §9a.33: a card SillyTavern has never seen is CREATED ───────────────────────────────
//
// `createCard` handles a card that is not yet in SillyTavern. These checks guard against reporting
// success when no file was written and losing the server-selected filename, which would create a
// duplicate on the next save.
{
  const seen = [];
  const api = build({
    settings,
    ctx: () => ({ name1: 'Test User', getRequestHeaders: () => ({}), getCharacters: async () => {} }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: async (url, init) => {
      seen.push({
        url,
        type: init && init.body && init.body.get ? String(init.body.get('file_type')) : '',
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ file_name: 'Test_Character2' }),
        text: async () => '',
      };
    },
  });
  const r = await orHang(
    api.writeCard({
      kind: 'card',
      create: true,
      name: 'Test_Character',
      card: { spec: 'chara_card_v2', data: { name: 'Test_Character' } },
      avatar: false,
    }),
  );
  ok(r !== HUNG && r.ok === true && r.created === true, 'a card SillyTavern has never seen is created rather than refused');
  // 🔴 THEIR `getPngName` DISAMBIGUATES A COLLISION, so the key cannot be guessed from our side.
  ok(
    r !== HUNG && r.ref === 'Test_Character2.png',
    'and it reports the filename SillyTavern chose, which is what stops the next Save making a second copy',
  );
  ok(
    seen.length === 1 && seen[0].url.includes('/api/characters/import') && seen[0].type === 'json',
    'through their own importer, as JSON — not merge-attributes, which addresses a file that does not exist yet',
  );
}
{
  // 🔴 A 200 IS NOT A SUCCESS. Their handler catches its own errors and answers `{error: true}`
  // with status 200 (`characters.js:1903`), and returns an empty `file_name` when the write
  // failed. Reporting "created" off the status alone says the character exists in SillyTavern
  // when nothing was written.
  const api = build({
    settings,
    ctx: () => ({ name1: 'Test User', getRequestHeaders: () => ({}), getCharacters: async () => {} }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: true }),
      text: async () => '',
    }),
  });
  const r = await orHang(api.writeCard({ kind: 'card', create: true, name: 'Test_Character', card: {}, avatar: false }));
  ok(r !== HUNG && r.ok === false, 'a 200 carrying {error:true} is a failed create, not a cheerful one');
}
{
  // 🔴 Preserve the created ref when picture upload fails. A retry must update the existing card
  // rather than creating a duplicate and abandoning the first.
  let rosterRefreshes = 0;
  const api = build({
    settings,
    ctx: () => ({
      name1: 'Test User',
      getRequestHeaders: () => ({}),
      getCharacters: async () => {
        rosterRefreshes++;
      },
    }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetchAvatar: async () => ({ ok: false, reason: 'nope' }),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ file_name: 'Test_Character' }),
      text: async () => '',
    }),
  });
  const r = await orHang(
    api.writeCard({
      kind: 'card',
      create: true,
      name: 'Test_Character',
      card: {},
      avatar: true,
      id: 'd1',
    }),
  );
  ok(
    r !== HUNG && r.ok === false && r.reason === PUSH_REASONS_REAL.picture && r.created === true && r.ref === 'Test_Character.png',
    'a create whose picture failed still reports the reference, so his retry is a merge and not a duplicate',
  );
  ok(
    rosterRefreshes === 1,
    'a created card refreshes the roster before a picture failure can return, so it is visible without a hard reload',
  );
}
{
  // A stalled `loadWorldInfo` or `/api/characters/all` must time out: otherwise `sweeping` stays
  // true and `pollForSweep` returns immediately on every later poll.
  const api = build({
    settings,
    ctx: () => ({
      getWorldInfoNames: () => ['Book A'],
      loadWorldInfo: () => new Promise(() => {}),
      getRequestHeaders: () => ({}),
    }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
  });
  const tally = newTally();
  const r = await orHang(api.sweepBooks(tally));
  ok(
    r !== HUNG,
    'a loadWorldInfo that never answers RETURNS — otherwise `sweeping` never clears ' +
      'and the tab stops collecting work for the life of the page',
  );
}
{
  const hang = (url, init) =>
    new Promise((_, reject) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  const api = build({
    settings,
    ctx: () => ({ getRequestHeaders: () => ({}) }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: hang,
  });
  const tally = newTally();
  const r = await orHang(api.sweepCards(tally));
  ok(r !== HUNG, 'and so does an /api/characters/all that never answers');
}

// ══ 11.1.8 — a new picture that needed Ctrl+Shift+R to appear ════════════════════════════════
//
// 🔴 A repaint reuses the avatar URL, so the browser can serve its cached image into new markup.
// The server's `invalidateThumbnail` clears its crop but cannot invalidate the browser cache.
//
// 🔴 THESE DRIVE THE REAL `bustAvatar` AND THE REAL WRITE PATHS. A check that only asserted the
// helper works would say nothing about whether anything calls it — the failure being fixed here is
// entirely a call-site failure, so every check below goes in through `writeCard`/`createCard`.
console.log('\n11.1.8 — a sent picture reaches the page it is already on');
/** Record what `bustAvatar` reaches for: the primed URL, and the thumbnail bust behind it. */
function bustRecorder(over = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      // Only the prime is interesting here; everything else answers like a happy SillyTavern.
      if (init && init.cache === 'reload') calls.push({ prime: url });
      return {
        ok: true,
        status: 200,
        json: async () => ({ file_name: over.fileName || 'Test_Character2' }),
        text: async () => '',
      };
    },
    stScript: async () => {
      if (over.noBustFn) return {};
      return {
        bustAvatarThumbnails: async (kind, file) => {
          if (over.bustHangs) return new Promise(() => {});
          calls.push({ bust: `${kind}:${file}` });
          return 1;
        },
      };
    },
  };
}
{
  const rec = bustRecorder();
  const order = [];
  const api = build({
    settings,
    ctx: () => ({
      characters: [{ avatar: 'Cleo.png' }],
      getRequestHeaders: () => ({}),
      getCharacters: async () => order.push('roster'),
    }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetchAvatar: async () => ({ ok: true, blob: new Blob(['png']) }),
    fetch: async (url, init) => {
      if (init && init.cache === 'reload') order.push('prime');
      return await rec.fetch(url, init);
    },
    stScript: async () => {
      order.push('bust');
      return await rec.stScript();
    },
  });
  const r = await orHang(api.writeCard({ kind: 'card', target: 'Cleo.png', merge: {}, avatar: true, id: 'd1' }));
  ok(r !== HUNG && r.ok === true && r.avatar === true, 'a merge that carries a picture still succeeds');
  ok(
    rec.calls.some(c => c.bust === 'character:Cleo.png'),
    'and the new picture is busted out of the browser cache under the card key SillyTavern uses',
  );
  ok(
    rec.calls.some(c => c.prime === '/characters/Cleo.png'),
    'the full-size image is re-primed too — no thumbnail URL addresses the zoomed-avatar popup',
  );
  // 🔴 ORDER, NOT JUST PRESENCE. A bust repaints the elements that exist when it runs, and
  // `getCharacters()` replaces them; busting first leaves the outcome resting on the prime alone.
  ok(
    order.indexOf('roster') !== -1 && order.indexOf('roster') < order.indexOf('bust'),
    '…and it happens AFTER the roster refetch, which replaces the elements it repaints',
  );
}
{
  // ⚠️ AND NOT OTHERWISE. A text-only merge changes nothing the browser has cached, so a bust
  // there would be two requests and a DOM walk bought with nothing.
  const rec = bustRecorder();
  const api = build({
    settings,
    ctx: () => ({ characters: [{ avatar: 'Cleo.png' }], getRequestHeaders: () => ({}), getCharacters: async () => {} }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: rec.fetch,
    stScript: rec.stScript,
  });
  const r = await orHang(api.writeCard({ kind: 'card', target: 'Cleo.png', merge: {} }));
  ok(r !== HUNG && r.ok === true && rec.calls.length === 0, 'a merge with no picture busts nothing');
}
{
  // 🔴 THE CREATE PATH IS NOT EXEMPT, AND IT IS THE ONE THAT LOOKS LIKE IT SHOULD BE. Their
  // importer writes the gray placeholder face and `getCharacters()` paints it under this exact
  // filename BEFORE `/edit-avatar` runs — so a brand-new card is holding a one-second-old picture.
  //
  // ⚠️ AND IT MUST BUST THE NAME THEIR `getPngName` CHOSE, not the one we asked for: a second
  // `Test_Character` is filed as `Test_Character2.png`, and a bust aimed at `Test_Character.png` would repaint
  // somebody else's face.
  const rec = bustRecorder({ fileName: 'Test_Character2' });
  const api = build({
    settings,
    ctx: () => ({ name1: 'Test User', getRequestHeaders: () => ({}), getCharacters: async () => {} }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetchAvatar: async () => ({ ok: true, blob: new Blob(['png']) }),
    fetch: rec.fetch,
    stScript: rec.stScript,
  });
  const r = await orHang(api.writeCard({ kind: 'card', create: true, name: 'Test_Character', card: {}, avatar: true, id: 'd1' }));
  ok(r !== HUNG && r.ok === true && r.ref === 'Test_Character2.png', 'a created card still reports the filename SillyTavern chose');
  ok(
    rec.calls.some(c => c.bust === 'character:Test_Character2.png'),
    '…and busts THAT name, not the one Vocalis asked for',
  );
}
{
  // 🔴 B.6 AGAIN, ON A COSMETIC CALL. The write has already landed and the answer is already
  // true; a repaint that never comes back must not hold it, and must never turn it into a
  // failure. This is the shape that wedged `pushing = true` for the life of the page.
  const rec = bustRecorder({ bustHangs: true });
  const api = build({
    settings,
    ctx: () => ({ characters: [{ avatar: 'Cleo.png' }], getRequestHeaders: () => ({}), getCharacters: async () => {} }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetchAvatar: async () => ({ ok: true, blob: new Blob(['png']) }),
    fetch: rec.fetch,
    stScript: rec.stScript,
  });
  const r = await orHang(api.writeCard({ kind: 'card', target: 'Cleo.png', merge: {}, avatar: true, id: 'd1' }));
  ok(r !== HUNG && r.ok === true, 'a repaint that never answers cannot wedge a send that already landed');
}
{
  // ⚠️ A SILLYTAVERN THAT MOVED THE FUNCTION COSTS A REFRESH, NEVER THE SEND. `bustAvatarThumbnails`
  // is not on `getContext()` — it is reached through their module, which is a real coupling to
  // somebody else's file, so the absent case has to be a warning and not a throw.
  const rec = bustRecorder({ noBustFn: true });
  const api = build({
    settings,
    ctx: () => ({ characters: [{ avatar: 'Cleo.png' }], getRequestHeaders: () => ({}), getCharacters: async () => {} }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetchAvatar: async () => ({ ok: true, blob: new Blob(['png']) }),
    fetch: rec.fetch,
    stScript: rec.stScript,
  });
  const r = await orHang(api.writeCard({ kind: 'card', target: 'Cleo.png', merge: {}, avatar: true, id: 'd1' }));
  ok(r !== HUNG && r.ok === true && r.avatar === true, 'a script.js without bustAvatarThumbnails still reports the send it really made');
}
{
  // 🔴 THE PRIME IS A CACHE KEY, SO IT HAS TO BE THE SAME STRING THE PAGE ASKS FOR. Their zoom
  // handler builds `/characters/` plus the ENCODED filename (`script.js:8925`); a prime on the raw
  // one fills a second cache entry that nothing ever reads, and the old face survives the send.
  const rec = bustRecorder();
  const api = build({
    settings,
    ctx: () => ({ characters: [{ avatar: 'Anne Marie.png' }], getRequestHeaders: () => ({}), getCharacters: async () => {} }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetchAvatar: async () => ({ ok: true, blob: new Blob(['png']) }),
    fetch: rec.fetch,
    stScript: rec.stScript,
  });
  await orHang(api.writeCard({ kind: 'card', target: 'Anne Marie.png', merge: {}, avatar: true, id: 'd1' }));
  ok(
    rec.calls.some(c => c.prime === '/characters/Anne%20Marie.png'),
    'a filename with a space is primed percent-encoded, the way their own page addresses it',
  );
}
{
  // The persona half of the same helper: their `USER_AVATAR_PATH` is not exported, so the URL has
  // to come from `getUserAvatar` rather than from a hand-built copy of their constant.
  const rec = bustRecorder();
  const api = build({
    settings,
    ctx: () => ({ getRequestHeaders: () => ({}) }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: rec.fetch,
    stScript: rec.stScript,
    stPersonas: async () => ({ getUserAvatar: f => `User Avatars/${f}` }),
  });
  await orHang(api.bustAvatar('persona', 'me.png'));
  ok(
    rec.calls.some(c => c.prime === 'User Avatars/me.png'),
    'a persona primes the URL THEIR module builds, not one assembled here',
  );
  ok(
    rec.calls.some(c => c.bust === 'persona:me.png'),
    '…and busts it as a persona, whose thumbnail folder is a different one',
  );
}
{
  // An empty filename is a plan that carries no picture reaching here by accident. Two requests
  // and a DOM walk against `undefined` is not a harmless no-op — it repaints every avatar whose
  // URL happens to name nothing.
  const rec = bustRecorder();
  const api = build({
    settings,
    ctx: () => ({ getRequestHeaders: () => ({}) }),
    pushDocument: async () => filed(),
    pushAvatar: async () => ({ ok: true }),
    fetch: rec.fetch,
    stScript: rec.stScript,
  });
  await orHang(api.bustAvatar('character', ''));
  ok(rec.calls.length === 0, 'and an empty filename reaches neither of them');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

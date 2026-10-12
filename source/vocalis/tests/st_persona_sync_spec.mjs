// 7.0 code review §5.1 — the persona send reported success and reverted itself.
//
// `persona_descriptions[avatar]` is the STORED map. What the prompt uses, and what the Persona
// panel shows, is a set of FLAT fields that SillyTavern mirrors from the descriptor only when
// the persona is SWITCHED (`personas.js:933-940`). Writing the map alone therefore meant the
// edit never reached the prompt — and the next input event read the STALE textarea and wrote
// it back over the stored value.
//
// 🔴 THIS RUNS THE REAL FUNCTION, NOT A COPY OF IT. `index.js` imports from `/scripts/...`, so
// it cannot be imported standalone — but the fix is one self-contained function, and extracting
// its source and evaluating it is far stronger than asserting that some string appears in the
// file. The review's own test audit found a security guard whose only check was satisfied by a
// DOCSTRING; a test that cannot fail is worse than no test, because it reports coverage.
//
// Usage: node st_persona_sync_spec.mjs <extension-dir>
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const extDir = process.argv[2];
if (!extDir) {
  console.error('usage: node st_persona_sync_spec.mjs <ext-dir>');
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

/** Brace-match a named function out of the file and return its source, '' if it is not there.
 *
 * 🔴 SAME RULE AS EVERY EXTRACTION IN THIS FILE: what runs is the REAL code, so a rename or a
 * move is a loud failure here rather than a silently-skipped test. */
function extract(decl) {
  const s = src.indexOf(decl);
  if (s === -1) return '';
  let d = 0;
  for (let i = src.indexOf('{', s); i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(s, i + 1);
    }
  }
  return '';
}

// Brace-match the function out of the file, so a rename or a move is a loud failure here
// rather than a silently-skipped test.
const start = src.indexOf('function syncActivePersona(');
ok(start !== -1, 'syncActivePersona is present in index.js');
if (start === -1) process.exit(1);
let depth = 0,
  end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
ok(end !== -1, 'its body brace-matches');
const syncActivePersona = new Function(`${src.slice(start, end)}; return syncActivePersona;`)();

const PANEL = { value: '' };
globalThis.document = { getElementById: id => (id === 'persona_description' ? PANEL : null) };

function powerUser(activeText, descriptions) {
  return { persona_description: activeText, persona_descriptions: descriptions };
}

// ── the bug, end to end ──────────────────────────────────────────────────────────────────────
{
  const pu = powerUser('the old text', { 'me.png': { description: 'the NEW text', depth: 4 } });
  PANEL.value = 'the old text';
  syncActivePersona('me.png', 'the old text', pu);

  ok(pu.persona_description === 'the NEW text', 'the flat field the PROMPT reads is updated');
  ok(PANEL.value === 'the NEW text', 'the textarea is updated, so his next keystroke cannot write the old text back');
  ok(pu.persona_description_depth === 4, 'the other flat fields follow the descriptor');
}

// ── a persona that is NOT the active one must not touch the live state ───────────────────────
{
  const pu = powerUser('the ACTIVE persona text', {
    'other.png': { description: 'edited elsewhere' },
  });
  PANEL.value = 'the ACTIVE persona text';
  syncActivePersona('other.png', 'something else entirely', pu);

  ok(pu.persona_description === 'the ACTIVE persona text', 'editing a background persona leaves the active one alone');
  ok(PANEL.value === 'the ACTIVE persona text', 'and leaves the visible panel alone');
}

// ── absent optional keys must not be invented ────────────────────────────────────────────────
{
  const pu = powerUser('old', { 'me.png': { description: 'new' } });
  pu.persona_description_depth = 7;
  PANEL.value = 'old';
  syncActivePersona('me.png', 'old', pu);

  ok(pu.persona_description === 'new', 'the description still lands');
  ok(pu.persona_description_depth === 7, 'a key the descriptor does not carry is left as it was, never reset to a default');
}

// ── the panel being closed is normal, not an error ───────────────────────────────────────────
{
  const pu = powerUser('old', { 'me.png': { description: 'new' } });
  globalThis.document = { getElementById: () => null };
  let threw = false;
  try {
    syncActivePersona('me.png', 'old', pu);
  } catch {
    threw = true;
  }

  ok(!threw, 'a closed Persona panel does not throw mid-send');
  ok(pu.persona_description === 'new', 'and the prompt is still corrected');
}

// ── a descriptor that vanished between the write and the sync ────────────────────────────────
{
  const pu = powerUser('old', {});
  let threw = false;
  try {
    syncActivePersona('gone.png', 'old', pu);
  } catch {
    threw = true;
  }
  ok(!threw, 'a missing descriptor is survivable');
}

// ── §9a.11 / 7.5.16 — createPersona, run for real against fakes ──────────────────────────────
//
// 🔴 THE SAME RULE AS ABOVE: this evaluates the REAL function out of index.js. A spec that
// greps for `overwrite_name` passes against a function nothing calls, and the review's own
// audit already found one guard whose only check was satisfied by a docstring.
//
// The checks cover the critical data and synchronization decisions made when creating a persona:
//
//   1. the minted avatar filename never collides with an existing persona;
//   2. the two `power_user` KEYS go before the picture, so their `addMissingPersonas` can never
//      find an unclaimed avatar file and name it "[Unnamed Persona]" — with a rollback for the
//      failed upload the other order was protecting against;
//   3. the recorded filename is the one the server returned;
//   4. a persona with no picture in Vocalis still gets a face, because a persona without one is
//      not a state their UI can render;
//   5. the answer waits for the settings write to LAND, because `pair.py` adopts the ref we
//      return and a ref adopted for a persona that was never saved is a one-way door.
//
// The extracted functions are exercised across orphan-avatar handling, default-avatar fallback,
// and durable-settings checks before returning a ref.
{
  const cpStart = src.indexOf('async function createPersona(');
  ok(cpStart !== -1, 'createPersona is present in index.js');
  if (cpStart === -1) process.exit(1);
  let d2 = 0,
    cpEnd = -1;
  for (let i = src.indexOf('{', cpStart); i < src.length; i++) {
    if (src[i] === '{') d2++;
    else if (src[i] === '}') {
      d2--;
      if (d2 === 0) {
        cpEnd = i + 1;
        break;
      }
    }
  }
  ok(cpEnd !== -1, 'and its body brace-matches');

  // 7.5.18 — the poll is no longer inline here; it is `settingsLanded`, shared with the merge
  // branch below. Both go into the SAME evaluation, so this still runs the real code of each
  // rather than a re-implementation of the waiting.
  const slSrc = extract('async function settingsLanded(');
  ok(slSrc !== '', 'settingsLanded is present in index.js');

  const REASONS = {
    refused: 'refused',
    invalid: 'invalid',
    missing: 'missing',
    unreachable: 'unreachable',
    unsupported: 'unsupported',
    picture: 'picture',
  };

  // The world these functions see. `order` is the tape the crash-plan check reads.
  function harness(over = {}) {
    const order = [];
    // 📌 A PROXY, because the thing under test is an ORDINARY PROPERTY ASSIGNMENT and the tape
    // has to see it. `pu.personas[ref] = name` leaves no trace a fake can observe otherwise,
    // so the order check would have been unwritable — which is exactly how the wrong order
    // shipped green in the first place.
    const rawPersonas = Object.assign({}, over.personas);
    const personas = new Proxy(rawPersonas, {
      set(t, k, v) {
        order.push('keys');
        t[k] = v;
        return true;
      },
      deleteProperty(t, k) {
        order.push('rollback');
        delete t[k];
        return true;
      },
    });
    const pu = { personas, persona_descriptions: Object.assign({}, over.descriptions) };
    const emitted = [];
    const registered = [];
    const ctxObj = {
      powerUserSettings: pu,
      getRequestHeaders: () => ({}),
      saveSettingsDebounced: () => order.push('save'),
      eventSource: {
        emit: async (t, p) => {
          emitted.push([t, p]);
        },
      },
      event_types: { PERSONA_CREATED: 'persona_created' },
    };
    const stFetch = async (url, opt) => {
      order.push(`fetch:${url}`);
      if (url === '/img/user-default.png') {
        return { ok: true, blob: async () => ({ default: true }) };
      }
      if (url === '/api/avatars/upload') {
        if (over.uploadFails) return { ok: false, status: over.uploadStatus || 500, text: async () => 'no' };
        return {
          ok: true,
          json: async () => ({
            path: over.serverPath || (opt && [...opt.body.entries()].find(e => e[0] === 'overwrite_name')[1]),
          }),
        };
      }
      // The read-back that turns "we scheduled a write" into "the write LANDED".
      // `over.neverLands` models the settings read-back missing after the one-second debounce;
      // polling distinguishes a scheduled write from a durable one.
      if (url === '/api/settings/get') {
        if (over.neverLands) {
          return {
            ok: true,
            json: async () => ({
              settings: JSON.stringify({ power_user: { personas: {} } }),
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            settings: JSON.stringify({ power_user: { personas: pu.personas } }),
          }),
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    };
    const fn = new Function(
      'ctx',
      'settings',
      'fetchAvatar',
      'PUSH_REASONS',
      'stFetch',
      'withTimeout',
      'console',
      'FormData',
      'File',
      'setTimeout',
      'avatarFiled',
      'registerCharacters',
      'errClass',
      `${slSrc}\n${src.slice(cpStart, cpEnd)}; return createPersona;`,
    )(
      () => ctxObj,
      { serverUrl: 'x', pairToken: 'y' },
      over.fetchAvatar || (async () => ({ ok: true, blob: { ours: true } })),
      REASONS,
      stFetch,
      p => p,
      { error: () => {}, warn: () => {}, log: () => {} },
      globalThis.FormData,
      globalThis.File,
      // The 250 ms poll compressed to 1 ms. The VALUE is not under test — that the answer
      // WAITS for the write at all is, and a spec that really waited 3 s would not be run.
      (fn2, ms) => setTimeout(fn2, Math.min(Number(ms) || 0, 1)),
      // 🔴 9.5.16 — THE FILE CHECK, INJECTED SO IT CAN BE MADE TO SAY NO. The create now
      // confirms the avatar reached `/api/avatars/get` as well as the two settings keys,
      // because the panel renders from the FILES. Defaulting to `true` keeps every existing
      // check meaning what it meant; `over.avatarFiled` is how the new one below makes the
      // file go missing — the state that reported success and showed nothing.
      over.avatarFiled || (async () => true),
      async (...args) => {
        registered.push(args);
        if (over.registrationFails) throw new Error('offline');
        return 1;
      },
      e => (e && e.name) || 'Error',
    );
    return { fn, pu, order, emitted, registered };
  }

  // ── 9.5.16: the keys land, the FILE does not, and it must NOT report success ──────────────
  //
  // 🔴 THE EXACT STATE THAT REPORTED "created in SillyTavern" AND SHOWED NOTHING. The panel is
  // built from `/api/avatars/get`; `settingsLanded` only ever confirmed the two `power_user` keys.
  // A key whose file is missing renders no row, `addMissingPersonas` only ever adds the other way
  // round, and nothing prunes it — so the persona is complete, verified, and invisible forever.
  {
    const h = harness({ avatarFiled: async () => false });
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      avatar: false,
      persona: { description: 'An engineer.', title: '' },
    });
    ok(r.ok === false, 'a create whose picture is not in /api/avatars/get is NOT a success');
    ok(!r.ref, '…and it reports no ref, so pair.py cannot adopt one for a persona nobody can see');
    // 🔴 ROLLED BACK. Two keys pointing at a file that is not there is a persona nothing renders
    // and nothing cleans up, and he cannot delete what he cannot see.
    ok(
      Object.keys(h.pu.personas).length === 0 && Object.keys(h.pu.persona_descriptions).length === 0,
      '…and the two keys are rolled back rather than left half-made',
    );
  }

  // ── the ordinary create ──────────────────────────────────────────────────────────────────
  {
    const h = harness();
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      persona: { description: 'Reads code fluently.', title: 'the user' },
      avatar: true,
      id: 'doc1',
    });
    ok(r.ok === true && r.created === true, 'a create answers ok and says it created');
    ok(/^\d+-TestUser\.png$/.test(r.ref), `the ref is minted their way — timestamp + ASCII of the name (${r.ref})`);
    ok(h.pu.personas[r.ref] === 'Test User', 'the display name lands in power_user.personas under that ref');
    const d = h.pu.persona_descriptions[r.ref];
    ok(d && d.description === 'Reads code fluently.' && d.title === 'the user', 'and the descriptor carries the prose Vocalis sent');
    // 📌 Pinned from their source: initPersona writes IN_PROMPT(0), DEFAULT_DEPTH(2),
    // DEFAULT_ROLE(0), lorebook ''. A persona made here must match one made in their UI.
    ok(
      d.position === 0 && d.depth === 2 && d.role === 0 && d.lorebook === '',
      'the descriptor defaults match initPersona, so it is indistinguishable from theirs',
    );
    ok(h.emitted.length === 1 && h.emitted[0][0] === 'persona_created', 'PERSONA_CREATED is emitted, as their own createPersona does');
    ok(h.registered.length === 1, 'the landed persona is registered in Character Voices before createPersona returns');
    const pushed = h.registered[0];
    ok(
      pushed[0] === 'x' && pushed[1][0].name === 'Test User' && pushed[1][0].avatar === r.ref && pushed[2] === 'y',
      'registration carries the display name, final avatar identity and pairing token',
    );
  }

  // ── 🔴 the crash plan: the picture goes FIRST ────────────────────────────────────────────
  {
    const h = harness();
    await h.fn({ kind: 'persona', create: true, name: 'Test User', persona: {}, avatar: true });
    const up = h.order.indexOf('fetch:/api/avatars/upload');
    const save = h.order.indexOf('save');
    ok(up !== -1 && save !== -1 && up < save, 'the commit waits until the picture is known to have landed');
  }
  {
    const h = harness({ uploadFails: true });
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      persona: {},
      avatar: true,
    });
    ok(r.ok === false, 'a failed upload fails the create');
    ok(
      Object.keys(h.pu.personas).length === 0 && Object.keys(h.pu.persona_descriptions).length === 0,
      '…and rolls the two keys back — no persona pointing at a file that is not there',
    );
    ok(h.order.indexOf('save') === -1, '…and never schedules a commit of the doomed state');
  }
  // Write the settings keys before uploading the avatar. SillyTavern's `addMissingPersonas`
  // assigns `[Unnamed Persona]` to any avatar file that appears without a persona entry.
  {
    const h = harness();
    await h.fn({ kind: 'persona', create: true, name: 'Test User', persona: {}, avatar: true });
    const keyed = h.order.indexOf('keys');
    const up = h.order.indexOf('fetch:/api/avatars/upload');
    ok(keyed !== -1 && up !== -1 && keyed < up, 'the two power_user keys are written BEFORE the avatar file exists');
  }
  // And when their server answers with a different filename than we asked for, the keys MOVE
  // rather than being left on the name we guessed — same window, other end.
  {
    const h = harness({ serverPath: 'theirs.png' });
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      persona: {},
      avatar: true,
    });
    ok(r.ref === 'theirs.png' && h.pu.personas['theirs.png'] === 'Test User', 'a server-chosen filename MOVES the keys onto it');
    ok(Object.keys(h.pu.personas).length === 1, '…and leaves none behind on the name we asked for');
    ok(h.registered[0][1][0].avatar === 'theirs.png', '…and Character Voices receives that final server-selected filename');
  }

  // Character Voices is a best-effort availability surface. The persona is already durably
  // landed at this point, so a transient Vocalis failure must not rewrite history and claim the
  // import failed.
  {
    const h = harness({ registrationFails: true });
    const r = await h.fn({ kind: 'persona', create: true, name: 'Test User', persona: {}, avatar: false });
    ok(r.ok === true && r.created === true, 'registration failure does not turn a landed persona into a failed import');
    ok(h.registered.length === 1, '…and proactive registration was attempted without requiring an audio request');
  }

  // ── 🔴 a minted ref must never land on a persona he already has ──────────────────────────
  {
    // Force the collision by pinning Date.now, then check it walked past it.
    const realNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const taken = { '1700000000000-TestUser.png': 'Existing Test Persona' };
      const h = harness({ personas: taken });
      const r = await h.fn({
        kind: 'persona',
        create: true,
        name: 'Test User',
        persona: {},
        avatar: true,
      });
      ok(r.ref !== '1700000000000-TestUser.png', `a colliding ref is stepped past, never reused (${r.ref})`);
      ok(
        h.pu.personas['1700000000000-TestUser.png'] === 'Existing Test Persona',
        '…and the existing persona remains unchanged, with its descriptor intact',
      );
    } finally {
      Date.now = realNow;
    }
  }

  // ── 🔴 the server has the last word on the filename ──────────────────────────────────────
  {
    const h = harness({ serverPath: 'what-the-server-actually-wrote.png' });
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      persona: {},
      avatar: true,
    });
    ok(r.ref === 'what-the-server-actually-wrote.png', 'the ref recorded is the path their server answered with, not the one we asked for');
    ok(h.pu.personas['what-the-server-actually-wrote.png'] === 'Test User', '…and power_user is keyed to that same name');
  }

  // ── 🔴 A SCHEDULED WRITE IS NOT A WRITE ─────────────────────────────────────────────────
  //
  // 🔴 A scheduled settings write is not yet durable. `saveSettingsDebounced` waits one second
  // and exposes no flush, so persona creation must wait for the settings keys to land before it
  // returns a ref. `pair.py` adopts that ref; returning before persistence would make every later
  // save take the merge path against a persona that was never actually saved.
  {
    const h = harness({ neverLands: true });
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      persona: {},
      avatar: true,
    });
    ok(r.ok === false, 'a create whose settings write never lands is reported as a FAILURE, not a success');
    // 🔴 THE HALF THAT MATTERS MORE. `pair.py` adopts ANY ref it is handed — deliberately,
    // since createCard reports one for a character that landed without its picture. Handing
    // one back here would adopt a persona that is not in settings.json.
    ok(!r.ref, '…and carries NO ref, so Vocalis cannot adopt a persona that was never saved');
    ok(!r.created, '…and does not claim it created one');
  }
  {
    const h = harness();
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      persona: {},
      avatar: true,
    });
    ok(
      h.order.filter(x => x === 'fetch:/api/settings/get').length >= 1 && r.ok === true,
      'the ordinary create reads the settings back before answering ok',
    );
  }

  // ── a persona with no picture in Vocalis still gets a face ───────────────────────────────
  {
    const h = harness();
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      persona: {},
      avatar: false,
    });
    ok(h.order.includes('fetch:/img/user-default.png'), 'with no picture of ours it uploads THEIR default, as createDummyPersona does');
    ok(r.ok === true && r.avatar === false, '…the create still succeeds, and says the picture was not ours');
  }
  {
    const h = harness({ fetchAvatar: async () => ({ ok: false, reason: 'locked' }) });
    const r = await h.fn({
      kind: 'persona',
      create: true,
      name: 'Test User',
      persona: {},
      avatar: true,
      id: 'doc1',
    });
    ok(
      h.order.includes('fetch:/img/user-default.png') && r.ok === true,
      'a picture Vocalis cannot hand over falls back to the default rather than failing',
    );
  }
}

// ── persona playback identity: the message carries its authored avatar filename ─────────────
{
  const avatarSrc = extract('function personaAvatarForMessage(');
  const bodySrc = extract('function bodyFor(');
  ok(avatarSrc !== '', 'personaAvatarForMessage is present in index.js');
  ok(bodySrc !== '', 'bodyFor is present in index.js');
  if (avatarSrc && bodySrc) {
    let chat = [
      {
        is_user: true,
        is_system: false,
        name: 'Duplicate Name',
        mes: 'hello',
        force_avatar: '/thumbnail?type=persona&file=server-renamed%20persona.png',
      },
    ];
    const fn = new Function('ctx', 'messageText', 'window', `${avatarSrc}\n${bodySrc}; return bodyFor;`)(
      () => ({ chat, groupId: null, characters: [], characterId: -1 }),
      () => 'hello',
      { location: { href: 'https://st.example/chat' } },
    );
    const body = fn(0);
    ok(body.character === 'Duplicate Name', 'user narration keeps the persona display name');
    ok(
      body.character_avatar === 'server-renamed persona.png',
      'user narration carries the exact decoded avatar filename, so duplicate names remain distinct on first playback',
    );

    chat = [
      {
        is_user: true,
        is_system: false,
        name: 'Duplicate Name',
        mes: 'hello',
        force_avatar: '/thumbnail?type=avatar&file=some-character.png',
      },
    ];
    ok(fn(0).character_avatar === '', 'a non-persona thumbnail is not misbound as the user persona identity');

    chat[0].force_avatar = 'https://other.example/thumbnail?type=persona&file=lookalike.png';
    ok(fn(0).character_avatar === '', 'a cross-origin lookalike URL is not trusted as a persisted SillyTavern persona identity');
  }
}

// ── 🔴 7.5.18 — the MERGE branch told the same small lie about success ────────────────────────
//
// The merge path returns no new `st_ref`, but it still must not report a settings edit as saved
// until the changed fields are present in the read-back.
//
// 🔴 THE PREDICATE HAD TO BE THE FIELDS, NOT THE KEY, AND THAT IS WHAT THE SECOND CHECK PINS.
// On a create, `personas[ref]` existing at all is proof, because it was not there a moment ago.
// On a merge the key is ALREADY in settings.json and already saved — so the same test passes
// against the PRE-EDIT file and waits for precisely nothing. That is not a weaker check, it is a
// vacuous one, and it would have shipped looking exactly like a fix.
{
  const wpSrc = extract('async function writePersona(');
  ok(wpSrc !== '', 'writePersona is present in index.js');
  const slSrc = extract('async function settingsLanded(');

  const REASONS = {
    refused: 'refused',
    invalid: 'invalid',
    missing: 'missing',
    unreachable: 'unreachable',
    unsupported: 'unsupported',
    picture: 'picture',
  };

  // Two copies on purpose: `pu` is the tab's memory, `saved` is settings.json. The whole defect
  // lives in the gap between them, so a harness that keeps one object cannot express it.
  function mharness(over = {}) {
    const order = [];
    const clone = o => JSON.parse(JSON.stringify(o));
    const onDisk = { description: 'the OLD text', title: 'old' };
    const saved = {
      personas: { 'me.png': 'Test User' },
      persona_descriptions: { 'me.png': clone(over.onDisk || onDisk) },
    };
    const pu = {
      personas: clone(saved.personas),
      persona_descriptions: clone(saved.persona_descriptions),
    };
    const ctxObj = {
      powerUserSettings: pu,
      getRequestHeaders: () => ({}),
      // The commit. `neverLands` is the tab closed inside the 1 s debounce window — memory
      // was mutated, settings.json never heard about it.
      saveSettingsDebounced: () => {
        order.push('save');
        if (over.neverLands) return;
        saved.persona_descriptions = clone(pu.persona_descriptions);
      },
    };
    const stFetch = async url => {
      order.push(`fetch:${url}`);
      if (url === '/api/settings/get') {
        return {
          ok: true,
          json: async () => ({ settings: JSON.stringify({ power_user: saved }) }),
        };
      }
      // 9.5.15's picture branch. `over.uploadFails` is how the refusal path is reached.
      if (url === '/api/avatars/upload') {
        return over.uploadFails ? { ok: false, status: 400, text: async () => '' } : { ok: true, json: async () => ({ path: 'me.png' }) };
      }
      return { ok: false, status: 404, text: async () => '' };
    };
    const fn = new Function(
      'ctx',
      'PUSH_REASONS',
      'stFetch',
      'console',
      'setTimeout',
      'syncActivePersona',
      'createPersona',
      // 🔴 9.5.15 GAVE THE MERGE A PICTURE BRANCH AND THIS HARNESS COULD NOT REACH IT. Every merge
      // check here passed a plan with no `avatar`, so the upload block was skipped and these four
      // names were never needed — the "never ran it with an avatar" gap one level down from the
      // one the avatar-bearing merge path exercises, so the test reaches that branch directly.
      'fetchAvatar',
      'settings',
      'FormData',
      'File',
      // 🔴 11.1.8 — THE REPAINT SEAMS, AND `withTimeout` IS ONE OF THEM. It was never passed, so
      // the `getUserAvatars` repaint 9.5.19 added threw ReferenceError into its own catch on every
      // run of this spec: the block was green and had never executed. `bustAvatar` sits OUTSIDE
      // that catch by design — the cache bust must not be silently skippable — so the same gap
      // would have taken the whole merge down instead.
      'stPersonas',
      'withTimeout',
      'bustAvatar',
      `${slSrc}\n${wpSrc}; return writePersona;`,
    )(
      () => ctxObj,
      REASONS,
      stFetch,
      { error: () => {}, warn: () => {}, log: () => {} },
      // 250 ms compressed to 1 ms. The VALUE is not under test; that the answer waits at all is.
      (f, ms) => setTimeout(f, Math.min(Number(ms) || 0, 1)),
      () => {}, // syncActivePersona — its own checks are above
      async () => ({ ok: true, created: true }), // the create branch, not this one
      over.fetchAvatar || (async () => ({ ok: true, blob: new Blob(['png']) })),
      { serverUrl: 'https://voc', pairToken: 'tok' },
      globalThis.FormData,
      globalThis.File,
      async () => {
        order.push('repaint');
        return { getUserAvatars: async () => [], getUserAvatar: f => `User Avatars/${f}` };
      },
      p => Promise.resolve(p),
      async (kind, file) => {
        order.push(`bust:${kind}:${file}`);
      },
    );
    return { fn, pu, saved, order };
  }

  // ── 9.5.14: the merge response identifies the persona it changed ──────────────────────────
  //
  // 🔴 `created` and `saved` both report success, so a merge response must name the persona it
  // changed. This assertion keeps the subject explicit in the confirmation.
  {
    const h = mharness();
    const r = await h.fn({ kind: 'persona', target: 'me.png', persona: { description: 'x' } });
    ok(r.ok === true, 'the merge succeeds');
    ok(r.wrote === 'Test User', `and it reports WHICH persona it wrote to (${JSON.stringify(r.wrote)})`);
  }

  // ⚠️ AND IT MUST NOT INVENT ONE. A key present with an empty display name is a persona
  // SillyTavern itself renders unnamed; reporting something confident there would be worse than
  // reporting nothing, and `wb/st.js` already falls back to the plain wording on an empty string.
  {
    const h = mharness();
    h.pu.personas['me.png'] = '';
    const r = await h.fn({ kind: 'persona', target: 'me.png', persona: { description: 'x' } });
    ok(r.ok === true && r.wrote === '', 'an unnamed persona reports an empty name, never a guess');
  }

  // ── 9.5.15: the picture-bearing merge path ────────────────────────────────────────────────
  //
  // A plan without `avatar` skips the upload block, so it cannot verify the response path after
  // picture handling. This case exercises the merge with the picture flag set.
  {
    const h = mharness();
    const r = await h.fn({ kind: 'persona', target: 'me.png', avatar: true, id: 'doc1', persona: { description: 'x' } });
    ok(r.ok === true, 'a merge that also carries a picture succeeds');
    ok(r.avatar === true, '…and reports that the picture traveled');
    ok(r.wrote === 'Test User', `…and STILL names what it wrote to (${JSON.stringify(r.wrote)})`);

    // 🔴 11.1.8 — A repaint reuses the avatar URL, so the browser can serve its cached image into
    // the new markup. The server's `invalidateThumbnail` clears its crop but cannot invalidate the
    // browser cache; bust the browser URL after repainting the avatar list.
    ok(
      h.order.includes('bust:persona:me.png'),
      '…and the browser cache is busted under the avatar FILENAME, which is the persona identity',
    );
    // `wrote` contains a display name, not an addressable avatar filename. A cache bust using it
    // would target no file while appearing to pass this check.
    ok(!h.order.some(s => s.startsWith('bust:') && s.includes('Test User')), '…never under the display name, which addresses no file');
    ok(
      h.order.indexOf('repaint') !== -1 && h.order.indexOf('repaint') < h.order.indexOf('bust:persona:me.png'),
      '…and AFTER the panel repaint, which replaces the elements the bust rewrites',
    );
  }

  // ⚠️ AND NOT ON A TEXT-ONLY MERGE. Nothing the browser is holding has changed, so a bust there
  // is two requests and a walk of every `<img>` on the page bought with nothing.
  {
    const h = mharness();
    const r = await h.fn({ kind: 'persona', target: 'me.png', persona: { description: 'x' } });
    ok(r.ok === true && !h.order.some(s => s.startsWith('bust:')), 'a merge with no picture busts nothing');
  }

  // A refused upload costs the picture and nothing else: the text is already committed.
  {
    const h = mharness({ uploadFails: true });
    const r = await h.fn({ kind: 'persona', target: 'me.png', avatar: true, id: 'doc1', persona: { description: 'x' } });
    ok(r.ok === false && r.reason === REASONS.picture, 'a refused picture upload reports `picture`, not a whole-send failure');
    ok(r.wrote === 'Test User', '…and names the persona whose text DID land, so the report is actionable');
  }

  // ── the ordinary merge ───────────────────────────────────────────────────────────────────
  {
    const h = mharness();
    const r = await h.fn({
      kind: 'persona',
      target: 'me.png',
      persona: { description: 'the NEW text' },
    });
    ok(
      r.ok === true && h.order.includes('fetch:/api/settings/get'),
      'a merge answers ok only after the edit is read back out of settings.json',
    );
    ok(h.saved.persona_descriptions['me.png'].description === 'the NEW text', '…and what it read back really is the edit');
  }

  // ── 🔴 the vacuity trap: the key is there THE WHOLE TIME, and the fields are stale ────────
  {
    const h = mharness({ neverLands: true });
    const r = await h.fn({
      kind: 'persona',
      target: 'me.png',
      persona: { description: 'the NEW text' },
    });
    ok(
      h.saved.personas['me.png'] === 'Test User',
      'the persona key is in settings.json before the edit and stays there — a key check would pass',
    );
    ok(
      r.ok === false && r.reason === REASONS.refused,
      '…and the merge is still reported as a FAILURE, because it is the FIELDS that are checked',
    );
    ok(
      h.saved.persona_descriptions['me.png'].description === 'the OLD text',
      '…the edit really never reached the file, so the failure it reports is the truth',
    );
  }

  // ── ⚠️ `null` means the key is DELETED, and a landed delete is an ABSENT key ──────────────
  //
  // `_persona_plan` sends `title: null` to clear a title, because their own editor deletes the
  // key rather than blanking it. Comparing `saved[k] === v` against null would never match a
  // landed delete — every send that clears a title would burn the full poll ceiling and then
  // report a failure that did not happen.
  {
    const h = mharness();
    const r = await h.fn({
      kind: 'persona',
      target: 'me.png',
      persona: { description: 'kept', title: null },
    });
    ok(r.ok === true, 'clearing a title with null is recognized as landed, not waited out and failed');
    ok(!('title' in h.saved.persona_descriptions['me.png']), '…and it landed as an ABSENT key, the way their own editor leaves it');
  }

  // ── a persona removed from SillyTavern is refused before any merge work ──────────────────
  {
    const h = mharness();
    const r = await h.fn({ kind: 'persona', target: 'gone.png', persona: { description: 'x' } });
    ok(
      r.ok === false && r.reason === REASONS.missing,
      'a persona that is no longer in power_user is refused, never recreated by the merge',
    );
    ok(!h.order.includes('save'), '…and nothing is committed for it');
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

// ── 9.5.16 — the create confirms the FILE, not only the two settings keys ──────────────────
//
// 🔴 THE STORE `settingsLanded` CHECKS IS NOT THE STORE THE PANEL RENDERS FROM. SillyTavern builds
// its persona list from `/api/avatars/get` — one row per FILE — and `addMissingPersonas` only ever
// adds a key for a file that lacks one. Nothing runs the other way, so a key whose file is missing
// is a persona that exists in settings but never appears. The create path must confirm the file
// itself before reporting success.
//
// ⚠️ EXTRACTED AND RUN, like `syncActivePersona` above — an assertion that some string appears in
// the file is satisfied by a docstring, which this suite's own audit already caught once.
{
  const src2 = await readFile(join(extDir, 'index.js'), 'utf-8');
  const body = extract('async function avatarFiled(');
  ok(body !== '', 'avatarFiled is present in index.js');

  if (body) {
    /** Run the real function against a stubbed SillyTavern, one answer at a time. */
    const run = async answer => {
      const stubs = `
        const ctx = () => ({ getRequestHeaders: () => ({}) });
        const stFetch = async () => (${answer});
      `;
      const fn = new Function(stubs + body + '\nreturn avatarFiled;')();
      return await fn('1699-TestUser.png');
    };

    ok(
      (await run(`{ ok: true, json: async () => ['1699-TestUser.png', 'other.png'] }`)) === true,
      'a file that IS in /api/avatars/get confirms the create',
    );
    ok(
      (await run(`{ ok: true, json: async () => ['other.png'] }`)) === false,
      'a file that is NOT in the list refuses it — the settings keys alone are not the answer',
    );
    // 🔴 THE DEFAULT ON FAILURE IS FALSE. This gates a success report, so an unanswerable question
    // must read as "cannot confirm"; true would restore the silent success it exists to remove.
    ok((await run(`{ ok: false, json: async () => [] }`)) === false, 'a refused /api/avatars/get is not a confirmation');
    ok(
      (await run(`{ ok: true, json: async () => { throw new Error('bad json'); } }`)) === false,
      'and neither is a body that will not parse',
    );
    ok((await run(`{ ok: true, json: async () => ({ notAnArray: true }) }`)) === false, 'and neither is a shape that is not a list');
  }
}

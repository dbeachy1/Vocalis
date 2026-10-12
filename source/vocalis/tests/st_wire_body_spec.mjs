// 9.5.17 — what the extension actually PUTS ON THE WIRE, which is a different question from what
// the server does with a body it is handed.
//
// 🔴 THE DEFECT THIS EXISTS FOR. 9.5.14 added `wrote` — the display name of the persona a send
// wrote to — so that "created X" and "updated X" stop being one word apart. `writePersona`
// computed it, `pair.py` accepted it, `wb/st.js` rendered it, and `test_pair_push.py` pinned the
// route's handling of it. It still arrived empty, every time, because `pushDone` builds its POST
// body FIELD BY FIELD and nobody added the field there. Every layer was correct about a value the
// wire silently dropped.
//
// 🔴 SO THE SUBJECT HERE IS THE BODY, AND NOTHING ELSE. A test that hands `pair.py` a dict is
// testing the server; a test that calls `writePersona` is testing the branch. Only this one can
// see a field that exists on both sides and travels between them as nothing. It is the "check
// performed on a DIFFERENT OBJECT from the one that ships" failure, which this codebase keeps
// finding at seams — see feedback_a_join_is_where_the_defects_hide.
//
// Usage: node st_wire_body_spec.mjs <extension-dir>
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const extDir = process.argv[2];
if (!extDir) {
  console.error('usage: node st_wire_body_spec.mjs <ext-dir>');
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

const src = await readFile(join(extDir, 'vocalis-stream.js'), 'utf-8');

/** Brace-match a named function out of the file. A rename is a loud failure, not a skipped test. */
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

const body = extract('export async function pushDone(');
ok(body !== '', 'pushDone is present in vocalis-stream.js');

if (body) {
  // Run the REAL function with fetch captured, and read the body it built.
  let sent = null;
  const fakeFetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true };
  };
  const fn = new Function(
    'fetch',
    'AbortController',
    'setTimeout',
    'clearTimeout',
    'REPORT_TIMEOUT_MS',
    body.replace(/^export /, '') + '\nreturn pushDone;',
  )(
    fakeFetch,
    class {
      constructor() {
        this.signal = null;
      }
      abort() {}
    },
    () => 0,
    () => {},
    1000,
  );

  await fn('https://voc', 'tok', {
    ok: true,
    created: false,
    id: 'doc1',
    revision: 3,
    ref: 'me.png',
    reloaded: true,
    avatar: true,
    wrote: 'Test User',
    reason: '',
  });

  ok(sent !== null, 'it POSTs to Vocalis');
  ok(sent && sent.url.endsWith('/pair/push'), '…at /pair/push');
  // 🔴 THE ONE THAT WAS BROKEN FOR THREE RELEASES.
  ok(sent && sent.body.wrote === 'Test User', '…and the body carries wrote (' + (sent && JSON.stringify(sent.body.wrote)) + ')');
  // The rest of the contract, pinned in the same place, because the failure mode is structural:
  // this body is assembled by hand, so ANY field the server reads can go missing here silently.
  for (const [k, want] of [
    ['ok', true],
    ['created', false],
    ['id', 'doc1'],
    ['revision', 3],
    ['ref', 'me.png'],
    ['reloaded', true],
    ['avatar', true],
  ]) {
    ok(sent && sent.body[k] === want, '…and ' + k + ' (' + (sent && JSON.stringify(sent.body[k])) + ')');
  }

  // ⚠️ AND A RESULT WITHOUT THE FIELD MUST NOT BECOME `undefined` ON THE WIRE. `pair.py` reads it
  // with `or ""`, so either would work today — but a JSON body carrying `"wrote": null` is a
  // different contract from one carrying `""`, and the pane tests it for truthiness.
  sent = null;
  await fn('https://voc', 'tok', { ok: true, created: true, id: 'doc2' });
  ok(sent && sent.body.wrote === '', 'a result with no name sends an empty string, never null');
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

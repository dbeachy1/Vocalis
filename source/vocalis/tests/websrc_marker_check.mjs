// Prove tests/_websrc.mjs's marker matching tolerates RESPACING and nothing else. 8.3.2.
//
// 🔴 WHY THIS EXISTS. 8.3.2 ran the whole JavaScript tree through Prettier, and roughly two hundred
// markers across the .mjs harnesses were written against the dense style that preceded it
// (`const vOrder=list=>`). `relaxSpace` in _websrc.mjs only relaxed whitespace a marker ALREADY
// had, so every one of those stopped matching — which a harness reports as "the function was
// deleted", and the fix that suggests itself is deleting the check. `relaxSpace` now also allows
// whitespace the marker does NOT have, wherever the JavaScript grammar says whitespace is
// insignificant.
//
// That is a real loosening of a guard, so it gets a guard of its own. The claim being defended is
// narrow and this file states it as three separate facts:
//
//   1. ROUND TRIP, OVER THE REAL CORPUS. For every top-level definition actually in the tree, the
//      marker built from its source line and the marker built from a DENSIFIED copy of that same
//      line must locate exactly the same set of files. That is the property Prettier needed, tested
//      against the actual definitions rather than against fixtures somebody thought of — and it
//      holds in the direction that matters, dense marker against spaced source.
//   2. THE IDENTIFIER BOUNDARY IS STILL RIGID. `const vOrder` must not come to match `constvOrder`.
//   3. STRING INTERIORS ARE STILL RIGID. `$('kobSave')` must not come to match `$(' kobSave')` —
//      a different element id, which would point a slice at the wrong code while looking like a
//      pass. This is the one that makes the relaxation safe to apply globally.
//
// Usage: node websrc_marker_check.mjs        (exit 0 = pass, 1 = fail, reasons on stderr)
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defRe, textRe, loadWebSources, webSources } from './_websrc.mjs';
import { stripComments } from './_jscomments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (cond, what) => {
  if (!cond) {
    failures++;
    console.error('FAIL: ' + what);
  }
};

// ── 2 + 3: the two places whitespace is significant ──────────────────────────────────────────
//
// Each case is [regexBuilder, marker, subject, shouldMatch, why].
const RIGID = [
  // Respacing IS tolerated — the whole point.
  [defRe, 'const vOrder=list=>', 'const vOrder = list => x;', true, 'dense marker, spaced source'],
  [defRe, 'const vOrder = list =>', 'const vOrder=list=>x;', true, 'spaced marker, dense source'],
  [defRe, 'const vOrder=list=>', 'const vOrder=list=>x;', true, 'unchanged source still matches'],
  [defRe, 'const devs={rows:[],sats:[]};', 'const devs = { rows: [], sats: [] };', true, 'object literal respaced'],
  [defRe, 'function foo(a,b)', 'function foo(a, b) {', true, 'parameters respaced'],
  [defRe, 'export function bar()', 'export function bar() {', true, 'the export allowance'],
  [textRe, 'if(!ok){', 'if (!ok) {', true, 'a guard, respaced'],

  // 🔴 2. Whitespace between two identifier characters is MANDATORY and load-bearing.
  [defRe, 'const vOrder=list=>', 'constvOrder = list => x;', false, 'must NOT match constvOrder'],
  [defRe, 'function foo(a,b)', 'functionfoo(a, b) {', false, 'must NOT match functionfoo'],
  [textRe, 'return x', 'returnx', false, 'must NOT match returnx'],

  // 🔴 3. Inside a string or template literal, the bytes ARE the value.
  [textRe, "$('kobSave').addEventListener", "$('kobSave').addEventListener('click', f)", true, 'the real id still matches'],
  [textRe, "$('kobSave').addEventListener", "$(' kobSave').addEventListener('click', f)", false, 'must NOT match a DIFFERENT element id'],
  [textRe, "fetch('/api/voices/delete')", "fetch('/api/ voices/delete')", false, 'must NOT match a DIFFERENT route'],
  [textRe, '`a b`', '`ab`', false, 'must NOT collapse a space inside a template literal'],
  // ...but whitespace OUTSIDE the literal, next to it, is still elastic.
  [textRe, "$('kobSave')", "$( 'kobSave' )", true, 'whitespace around a literal is still insignificant'],

  // 🔴 A MARKER THAT STARTS INSIDE A STRING LITERAL. Several harnesses do this, because that is
  // where the interesting text begins. The leading `'` LOOKS like an opening quote, so a naive
  // literal scan pairs it with the next one, swallows `').style.display=(blkMode==='` into one
  // rigid atom, and the marker matches nothing at all once the line is respaced — which reads as
  // a deleted feature. relaxSpace detects the leftover unterminated quote and re-reads the whole
  // fragment as code. Regression-tested here because the failure is SILENT.
  [
    textRe,
    "blkToEnhanceWrap').style.display=(blkMode==='cleanup'",
    "$('blkToEnhanceWrap').style.display=(blkMode==='cleanup')?'':'none';",
    true,
    'an unbalanced-quote marker still matches the dense source it was written against',
  ],
  [
    textRe,
    "blkToEnhanceWrap').style.display=(blkMode==='cleanup'",
    "$('blkToEnhanceWrap').style.display = (blkMode === 'cleanup') ? '' : 'none';",
    true,
    '🔴 …and the respaced source too — this is the case that silently matched nothing',
  ],
  [
    textRe,
    "blkToEnhanceWrap').style.display=(blkMode==='cleanup'",
    "$('blkToEnhanceWrapX').style.display = (blkMode === 'cleanup') ? '' : 'none';",
    false,
    '…while the leading fragment stays string-rigid — a different element id must not match',
  ],

  // 🔴 THE MIRROR-IMAGE FRAGMENT, AND THE ONE THAT PUNISHES A LAZY FIX. Here the quote OPENS a
  // string the marker truncates, so everything after it is user-visible copy and must stay rigid.
  // An earlier cut of relaxSpace treated all unpaired markers as code, which let `saved,but`
  // satisfy a check about the exact wording of a message. Widening is the one thing a marker may
  // never do, so both directions are pinned.
  [
    textRe,
    ":'The voice was saved, but the candidate clip could not be deleted",
    "x ? 'ok' :'The voice was saved, but the candidate clip could not be deleted.'",
    true,
    'a marker that opens a string still matches the real copy',
  ],
  [
    textRe,
    ":'The voice was saved, but the candidate clip could not be deleted",
    "x :'The voice was saved,but the candidate clip could not be deleted.'",
    false,
    '🔴 …and the sentence keeps its own spacing — `saved,but` is different copy',
  ],
];

for (const [build, marker, subject, want, why] of RIGID) {
  const got = build(marker).test(subject);
  ok(got === want, `${why}\n  marker  ${JSON.stringify(marker)}\n  subject ${JSON.stringify(subject)}\n  matched ${got}, wanted ${want}`);
}

// ── 1: the round trip, over every real definition in the tree ────────────────────────────────

/** Characters after which a `/` opens a REGEX rather than dividing. Mirrors _websrc.mjs. */
const REGEX_START_AFTER = new Set([...'([{,;:!&|?+-~*%<>=^', '']);

/**
 * `line` with every INSIGNIFICANT space removed — the inverse of what relaxSpace tolerates, and a
 * faithful stand-in for how these markers were written before 8.3.2.
 *
 * String and template literals are stepped over whole, because whitespace inside one is not
 * insignificant and removing it would make this check assert something false.
 */
const densify = line => {
  let out = '';
  // The last significant character emitted — what tells a regex literal from a division sign.
  let prev = '';
  for (let i = 0; i < line.length;) {
    const c = line[i];
    // ⚠️ REGEX LITERALS ARE STEPPED OVER WHOLE, same as strings, and for a sharper reason: a
    // character class can CONTAIN a quote. `js/util/dom.js`'s `esc` is `.replace(/[&<>"]/g, …)`,
    // and reading that `"` as the start of a string made this generator emit a fixture that was
    // not valid code — which then failed to match and looked like relaxSpace's fault. It was not;
    // the fixture was the lie. (Whitespace inside a regex is significant anyway.)
    if (c === '/' && REGEX_START_AFTER.has(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < line.length) {
        const d = line[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < line.length && /[gimsuy]/.test(line[j])) j++;
        out += line.slice(i, j);
        prev = '/';
        i = j;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) {
        out += c;
        i++;
        continue;
      }
      out += line.slice(i, j + 1);
      prev = c;
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j])) j++;
      const l = out[out.length - 1];
      const r = line[j];
      // Keep it only where identifier characters sit on both sides.
      if (/[A-Za-z0-9_$]/.test(l || '') && /[A-Za-z0-9_$]/.test(r || '')) out += ' ';
      i = j;
      continue;
    }
    out += c;
    prev = c;
    i++;
  }
  return out;
};

/** Where the first comment on `line` begins, or `line.length` if it carries none. */
const commentStart = line => {
  const bare = stripComments(line);
  for (let i = 0; i < line.length; i++) if (bare[i] !== line[i]) return i;
  return line.length;
};

await loadWebSources(resolve(HERE, '..', 'src', 'webui', 'index.html'));
const files = webSources().files;

// A top-level definition, as the corpus actually writes them.
const DEF = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+[A-Za-z_$][\w$]*/;

const where = re =>
  files
    .filter(f => re.test(f.raw))
    .map(f => f.label)
    .join(',');

let checked = 0;
let densified = 0;
for (const f of files) {
  for (const rawLine of f.raw.split('\n')) {
    // The marker is the line as written, trimmed of its trailing noise — a definition marker is a
    // PREFIX of the line, which is how every harness writes one.
    //
    // ⚠️ THE MARKER IS THE RAW LINE CUT AT ITS FIRST COMMENT — both halves of that matter.
    //
    // CUT, because a marker is a fragment of CODE and no harness pastes a line's explanatory
    // comment into one. Left on, `let CURRENT = null; // the loaded template's id` densifies to a
    // fixture carrying an unpaired apostrophe, which relaxSpace correctly reads as string interior
    // — the fixture being unrealistic, not the matcher being wrong.
    //
    // RAW, because markers are matched against `f.raw`, comments included (sliceText is documented
    // to accept a section comment AS a marker). Handing this loop the STRIPPED line instead put
    // blanked-out JSDoc casts in the middle of it — `export const $ = id =>` followed by twenty
    // spaces where `/** @type … */` had been — and then neither form matched anything, which reads
    // as four modules losing their definitions.
    //
    // stripComments preserves offsets byte for byte, so the first place the two texts disagree is
    // exactly where the comment starts.
    const line = rawLine.slice(0, commentStart(rawLine)).replace(/\s+$/, '');
    if (!DEF.test(line) || line.length > 160) continue;

    const dense = densify(line);
    checked++;
    if (dense === line) continue; // nothing to prove: Prettier left this one dense
    densified++;

    const asWritten = where(defRe(line));
    const asDense = where(defRe(dense));
    ok(
      asWritten === asDense && asWritten !== '',
      `the round trip lost or moved a definition in ${f.label}\n` +
        `  line   ${JSON.stringify(line)}\n` +
        `  dense  ${JSON.stringify(dense)}\n` +
        `  as written -> ${asWritten || '(nothing)'}\n` +
        `  densified  -> ${asDense || '(nothing)'}`,
    );
  }
}

// ⚠️ A PASS OVER A CORPUS WITH NOTHING TO DENSIFY PROVES NOTHING — the exact vacuity this whole
// milestone is about. If Prettier were ever removed, `dense === line` would hold everywhere and
// every assertion above would be skipped in silence.
ok(checked > 500, `only ${checked} top-level definitions found — expected the whole tree`);
ok(
  densified > 400,
  `only ${densified} of ${checked} definitions carried insignificant whitespace — the round-trip ` +
    'check is inert, which means the corpus is no longer Prettier-formatted',
);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`ok — ${RIGID.length} rigidity cases, ${checked} definitions round-tripped (${densified} of them respaced)`);

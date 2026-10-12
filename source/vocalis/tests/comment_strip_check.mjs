// Prove tests/_jscomments.mjs removes comments AND NOTHING ELSE. 8.3-m0,
// DESIGN_8_3_JSDOC_TYPES.md §4.1 item 4 — the guard for the guard.
//
// 🔴 THE ORACLE IS ESBUILD, RUN OVER THE REAL TREE. esbuild is already a devDependency and already
// strips comments to build src/webui/bundle/app.js, so transforming a module with its comments and
// transforming the same module with them blanked must produce byte-identical output. They can only
// differ if _jscomments.mjs changed something that was not a comment. Every .js under
// src/webui/js/ is checked, so this is a statement about the actual corpus rather than about
// fixtures somebody thought of.
//
// ⚠️ THE HAND-WRITTEN CASES ARE STILL WORTH THEIR LINES, because the esbuild oracle is silent
// about the one property esbuild does not preserve and this module must: OFFSETS. A stripper that
// deleted comments instead of blanking them would pass equivalence and break every `sliceBy`
// offset and every line number in a failure message.
//
// Usage: node comment_strip_check.mjs        (exit 0 = pass, 1 = fail, reasons on stderr)
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { stripComments } from './_jscomments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_ROOT = resolve(HERE, '..', 'src', 'webui', 'js');

let failures = 0;
const ok = (cond, what) => {
  if (!cond) {
    failures++;
    console.error('FAIL: ' + what);
  }
};

// ── the cases esbuild cannot speak to ────────────────────────────────────────────────────
//
// Each pair is [source, expected]. `·` is not used — the expectation is spelled with real spaces
// so a diff in the failure output is readable.
const CASES = [
  // A URL is not a comment. This is the case that kills the regex implementation.
  ["const u = 'https://test-server.invalid:8001';", "const u = 'https://test-server.invalid:8001';"],
  ['const p = "//" + host;', 'const p = "//" + host;'],
  // `//` inside a character class is a regex, not a comment.
  ['const re = /[//]/;', 'const re = /[//]/;'],
  ['const re = /https:\\/\\//;', 'const re = /https:\\/\\//;'],
  // Comment-shaped text inside a template literal is code.
  ['const t = `a // not a comment`;', 'const t = `a // not a comment`;'],
  ['const t = `a /* nor this */ b`;', 'const t = `a /* nor this */ b`;'],
  // ...but a comment inside a ${} interpolation IS a comment.
  ['const t = `a ${ b /* c */ } // no`;', 'const t = `a ${ b         } // no`;'],
  // 🔴 A nested plain template inside a brace-carrying `${…}`. The entry loop used to DISCARD
  // the saved brace depth when the inner backtick closed, so the object literal's `}` was
  // misread as the interpolation's close and the comment after it survived as "template text"
  // — regression case: an oracle that drops comments from both sides cannot detect it.
  ['const x = `${ obj({ k: `v` }) /* strip me */ }`;', 'const x = `${ obj({ k: `v` })                }`;'],
  // The same shape with an arrow body — the exact line the finding predicted would reopen it.
  ['const y = `${ xs.map(x => { return `y`; }) /* gone */ }`;', 'const y = `${ xs.map(x => { return `y`; })            }`;'],
  // The plain cases.
  ['a(); // trailing', 'a();            '],
  ['/* block */ a();', '            a();'],
  // Division is not a regex, and the comment after it still goes.
  ['const x = a / b; // half', 'const x = a / b;        '],
  // A regex after `return` is a regex; the `//` in it survives.
  ['return /[//]/.test(s); // yes', 'return /[//]/.test(s);       '],
  // An apostrophe inside a comment must not open a string and swallow the rest of the file.
  ["// don't\nconst a = 1;", '        \nconst a = 1;'],
];

for (const [src, want] of CASES) {
  const got = stripComments(src);
  ok(got === want, `stripComments(${JSON.stringify(src)})\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
}

// ── offsets, on every real module ────────────────────────────────────────────────────────
const walk = async dir => {
  let out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};

const modules = await walk(JS_ROOT);
ok(modules.length > 50, `found ${modules.length} modules under src/webui/js — expected the whole tree`);

let stripped = 0;
for (const p of modules) {
  const src = (await readFile(p, 'utf8')).replace(/\r\n/g, '\n');
  const out = stripComments(src);

  // 🔴 BYTE-FOR-BYTE THE SAME LENGTH, and the same newlines in the same places. sliceBy() in
  // _websrc.mjs indexes into this text.
  ok(out.length === src.length, `${p}: length changed ${src.length} -> ${out.length}`);
  ok(out.split('\n').length === src.split('\n').length, `${p}: line count changed`);

  // ── the esbuild oracle ───────────────────────────────────────────────────────────────
  // `target: 'esnext'` so esbuild downlevels NOTHING — a transpiled `??=` would differ between
  // the two inputs for reasons that have nothing to do with comments.
  //
  // 🔴 `minifyWhitespace` IS WHAT MAKES THIS AN ORACLE, and its absence made the first version
  // of this check fail on 11 files for no reason. esbuild's `transform` PRESERVES ordinary
  // comments — only the bundle path drops them, which is why build_webui.mjs can say 1.30 MB
  // becomes 631 KB. Without this flag the original keeps its comments, the stripped copy has
  // none, and every commented file "differs". `minifySyntax` and `minifyIdentifiers` stay OFF so
  // that a genuine failure names the real function instead of `t`.
  const opts = { loader: 'js', target: 'esnext', format: 'esm', minifyWhitespace: true };
  let a, b;
  try {
    a = transformSync(src, opts).code;
    b = transformSync(out, opts).code;
  } catch (e) {
    failures++;
    console.error(`FAIL: ${p}: esbuild could not parse one of the two forms — ${e.message}`);
    continue;
  }
  ok(a === b, `${p}: stripping changed something that was NOT a comment (esbuild output differs)`);

  if (out !== src) stripped++;
}

// ⚠️ A PASS OVER A TREE WITH NO COMMENTS PROVES NOTHING. If this ever reads 0, the stripper is a
// no-op and every assertion above is vacuous — the exact shape this whole milestone is about.
ok(stripped > 40, `only ${stripped} of ${modules.length} modules contained a comment — the stripper looks inert`);

// ── 🔴 THE CONTRACT THE FIRST VERSION OF m0 BROKE ────────────────────────────────────────
//
// `sliceText` is DOCUMENTED to accept a comment as a marker — its docstring lists "a `// ── …`
// section comment" as a marker form, and voices_ui_smoke.mjs passes three of them. m0's first cut
// stripped the corpus that markers are matched against as well as the corpus that assertions read,
// which deleted the needle along with the haystack and took two harnesses red.
//
// _websrc.mjs now keeps both forms per file: markers match `raw`, content comes from `text`, and
// the two share one set of offsets because stripComments preserves length. This proves both halves
// of that in one assertion, so the split cannot silently collapse back to one corpus.
const { loadWebSources, sliceText } = await import('./_websrc.mjs');
await loadWebSources(resolve(HERE, '..', 'src', 'webui', 'index.html'));

let slice = null;
try {
  // 🔴 NO END MARKER. The legacy call ended at `// ── Voice Studio (4.0): sub-tabs`, a banner in
  // `media/voiceswap.js` (Voice Swap's screen). That module is not in this product, so the marker
  // matched nowhere and `sliceText` threw "end text marker not found". In the legacy tree the
  // banner was in ANOTHER file than the start marker, which `sliceText` answers by returning the
  // rest of the start marker's file — exactly what omitting the end marker asks for, without the
  // dependence on a file that is not here.
  slice = sliceText('// ── Voices management', null);
} catch (e) {
  failures++;
  console.error(
    'FAIL: a COMMENT marker no longer locates anything — markers must match the raw ' +
      `source, not the stripped copy. ${e.message.split('\n')[0]}`,
  );
}
if (slice !== null) {
  ok(slice.length > 500, `the comment-marker slice came back ${slice.length} chars — expected the whole Voices section`);
  // ✅ AND THE CONTENT IS STILL COMMENT-FREE. Idempotence is the cheapest proof available: if
  // anything in the returned text were still a comment, stripping again would change it.
  ok(
    stripComments(slice) === slice,
    'the slice located by a comment marker still contains comments — content must come from the STRIPPED copy',
  );
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`ok — ${CASES.length} cases, ${modules.length} modules, ${stripped} of them carried comments`);

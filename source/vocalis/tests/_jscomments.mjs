// Blank JavaScript comments OUT OF a source string without moving a single byte. 8.3-m0,
// DESIGN_8_3_JSDOC_TYPES.md §4.
//
// 🔴 WHY THIS EXISTS. 8.3 adds JSDoc type annotations to every module under src/webui/js/, and
// ~560 assertions across the .mjs harnesses match regexes against MODULE SOURCE TEXT loaded by
// _websrc.mjs. Three of those assertions are already one helpful comment away from lying:
//
//     voices_ui_smoke.mjs:915  ok(!/Overwrite\?/.test(voicesJs), 'no "Overwrite?" prompt survives')
//     voices_ui_smoke.mjs:916  ok(!/overwrite:\s*true/.test(voicesJs), 'nothing sends the flag')
//     swaplib_ui_smoke.mjs:67  ok(!/\bvs\.libFilter\b/.test(renderSrc), 'no code reads it')
//
// A comment written to explain WHY the overwrite prompt was removed, quoting the string, turns all
// three red against code that is perfectly correct. The mirror case is worse and silent: an
// unanchored POSITIVE assertion (`ok(/fetch\('\/api\/voices\/delete'\)/.test(src))`) is satisfied
// by a JSDoc @example quoting that call, so the check passes whether or not the call still exists.
// That is a green check over no product — the failure class _websrc.mjs and webui_syntax_check.mjs
// were both written to prevent.
//
// ⚠️ IT DOES *NOT* RETIRE _websrc.mjs's wbStream ambiguity, tempting as that reading is. Markers
// deliberately match against RAW source (comments included — `sliceText` is documented to accept
// a comment as a marker, and voices_ui_smoke passes three), so index.html's own comment quoting
// `function wbStream` is still in the haystack `defRe` searches. The column-0 anchor there is
// still load-bearing; do not delete it citing this file.
//
// 🔴 OFFSETS ARE PRESERVED, AND THAT IS THE WHOLE DESIGN CONSTRAINT. The obvious implementation is
// esbuild's transform, which is already a dependency and already strips comments for the bundle —
// but it REFORMATS, so every offset and line number shifts. `sliceBy` in _websrc.mjs is entirely
// offset-based (`file.text.match(re).index`, then `.slice()`), and every failure message a harness
// prints names a line. So: comment bytes become SPACES, newlines inside block comments are KEPT,
// and `stripComments(s).length === s.length` for every input. Nothing downstream can tell the
// difference except that the comments are gone.
//
// ⚠️ ESBUILD IS STILL THE ORACLE, JUST NOT THE IMPLEMENTATION. test_webui_comment_strip.py asserts
// that esbuild-transforming the stripped source is byte-identical to esbuild-transforming the
// original, over every real module in the tree. esbuild drops comments either way, so the two can
// only differ if this file changed something that was NOT a comment. That is the check that makes
// a hand-rolled tokenizer safe to rely on, and it runs against the actual corpus rather than
// against invented fixtures.
//
// 🔴 A REGEX CANNOT DO THIS JOB. `s.replace(/\/\/.*$/gm, '')` truncates every line containing a
// URL — `'https://example.invalid:8001'` is in this tree, so is `'//' + host` — and hands back source that no
// longer parses, which the harnesses then report as the app being broken. The cases that must
// survive untouched are: `//` in a string, `/*` in a string, `//` inside a regex character class
// (`/[//]/`), comment-shaped text inside a template literal, and `${}` interpolation nesting.

/** Characters after which a `/` begins a REGEX rather than a division. */
const REGEX_OK_AFTER = new Set([...'([{,;:!&|?+-~*%<>=^', '\n', '']);

/** Keywords after which a `/` begins a regex — `return /x/` is a regex, `a / x` is division. */
const REGEX_OK_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * `src` with every comment replaced by spaces, byte for byte, newlines preserved.
 *
 * Strings, template literals (including `${}` nesting) and regex literals are walked through
 * untouched — a `//` inside any of them is code, not a comment.
 *
 * @param {string} src
 * @returns {string} the same length as `src`, with the same line breaks in the same places
 */
export function stripComments(src) {
  // 🔴 `split('')`, NEVER `Array.from`. `Array.from` splits by CODE POINT, so every 🔴 and ⚠️ in
  // this tree — and there are hundreds — collapses a surrogate pair into one element while
  // `src[i]` below still indexes by UTF-16 unit. The two run out of step at the first astral
  // character and every write after it lands on the wrong slot: measured as ace/advanced.js
  // losing 7 bytes and esbuild reporting `Expected ";" but found "mport"`, an `import` with its
  // first letter eaten. `split('')` splits by code unit, which is what `src[i]` and `src.length`
  // both use, and `join('')` puts the pairs back together untouched.
  const out = src.split('');
  const n = src.length;

  // The last non-whitespace character emitted as CODE, and the identifier ending at it. Together
  // they answer the only genuinely ambiguous question in JavaScript tokenizing: is this `/` the
  // start of a regex, or a division sign?
  let prev = '';
  let prevWord = '';

  // Template-literal nesting. A `${` inside a template pushes back into code, and the matching
  // `}` pops back into the template — so this has to be a stack, not a boolean. `braceDepth`
  // tracks `{`/`}` seen in code so the pop happens on the RIGHT `}`.
  const tmpl = [];
  let braceDepth = 0;

  let i = 0;
  while (i < n) {
    const c = src[i];

    // ── comments ─────────────────────────────────────────────────────────────────────
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue; // the '\n' itself is left alone
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2; // unterminated: blank to EOF, do not throw
      for (; i < stop; i++) if (src[i] !== '\n') out[i] = ' ';
      continue; // 🔴 newlines KEPT — line numbers must hold
    }

    // ── string literals ──────────────────────────────────────────────────────────────
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++; // an escaped quote is not the terminator
        i++;
      }
      i++;
      prev = c;
      prevWord = '';
      continue;
    }

    // ── template literals ────────────────────────────────────────────────────────────
    if (c === '`') {
      tmpl.push(braceDepth);
      braceDepth = 0;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        // 🔴 `braceDepth = tmpl.pop()`, NEVER a bare `tmpl.pop()`. Discarding the popped
        // value leaves braceDepth at 0 after a nested template closes inside a `${…}` —
        // so the enclosing object literal's `}` is then misread as the interpolation's
        // close, everything to the next backtick becomes "template text", and a comment
        // in there SURVIVES stripping. That is precisely the assertion-satisfied-by-a-
        // comment hole this module exists to close, and both guards were structurally
        // blind to it (the esbuild oracle drops comments from both sides). The resume
        // loop below always restored correctly; only this entry loop dropped it.
        if (src[i] === '`') {
          braceDepth = tmpl.pop();
          i++;
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          // Back into CODE until the matching '}' — and code in there can hold comments,
          // more templates, more strings. Let the outer loop handle it.
          braceDepth = 0;
          i += 2;
          break;
        }
        i++;
      }
      prev = '`';
      prevWord = '';
      continue;
    }
    if (c === '}' && tmpl.length && braceDepth === 0) {
      // Closing a `${…}` — resume the template that opened it.
      braceDepth = tmpl.pop();
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '`') {
          i++;
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          tmpl.push(braceDepth);
          braceDepth = 0;
          i += 2;
          break;
        }
        i++;
      }
      prev = '`';
      prevWord = '';
      continue;
    }

    // ── regex literals ───────────────────────────────────────────────────────────────
    // Only reachable when the next char is neither '/' nor '*', so this cannot swallow a
    // comment. `/[//]/` and `/https:\/\//` are the cases that matter.
    if (c === '/' && (REGEX_OK_AFTER.has(prev) || REGEX_OK_KEYWORDS.has(prevWord))) {
      i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          i++;
          break;
        } else if (d === '\n') break; // unterminated — it was division after all
        i++;
      }
      prev = '/';
      prevWord = '';
      continue;
    }

    // ── plain code ───────────────────────────────────────────────────────────────────
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);

    if (!/\s/.test(c)) {
      prev = c;
      prevWord = /[A-Za-z_$0-9]/.test(c) ? prevWord + c : '';
    } else if (c === '\n') {
      prev = '\n';
      prevWord = '';
    }
    i++;
  }

  return out.join('');
}

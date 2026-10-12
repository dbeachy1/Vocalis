// Shared module-aware source loader for harnesses that extract front-end code from the page.
// Each extracted definition is checked for a unique, nonempty marker so a moved or missing
// definition fails clearly instead of silently producing an empty test slice.
//
// Markers may contain JavaScript punctuation, so they are regex-escaped; a trailing word-boundary
// is added only when appropriate. Missing start, missing end, and empty/reversed slices have
// distinct errors. The helper throws because it has no harness-local assertion function to record
// a failure safely.
//
// No npm dependencies (the devices_ui_smoke.mjs / clips_ui_smoke.mjs convention).
//
// Usage, from a harness that already has the page path in argv:
//
//     import { loadWebSources, sourceOf, sliceDef, stripModuleSyntax } from './_websrc.mjs';
//     const { html, main } = await loadWebSources(htmlPath);
//     const devs = sliceDef('const devs={rows:[],sats:[]};', 'async function loadVoices(){');
//
// ⚠️ CONVERTING A HARNESS: the old shape was `ok(from > 0 && to > from, 'located the helpers')`
// followed by `process.exit(1)`. The replacement is a bare `sliceDef(…)` — it throws with the
// marker in the message and node exits 1 with a stack — so DROP the located-it check rather than
// wrapping the call in a try/catch to keep the failure counter tidy. Where presence is the thing
// being ASSERTED rather than a precondition (wbedit's "wbWire is defined somewhere"), use
// `sourceOfOrNull` and keep the `ok`.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stripComments } from './_jscomments.mjs';

/** Thrown for every marker that cannot be located, or that locates an empty/backward slice. */
export class MarkerNotFound extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarkerNotFound';
  }
}

// Keyed by the RESOLVED page path. Reading index.html plus the module tree is ~20 files, and
// voices_ui_smoke.mjs alone takes 40+ slices — caching keeps that one read, and (more usefully)
// guarantees every slice in a run sees the SAME bytes even if a sibling session saves a file
// mid-run. `current` is the most recently loaded bundle, which is what the bare `sourceOf` /
// `sliceDef` exports operate on; every harness loads exactly one page.
const cache = new Map();
let current = null;

// Normalized to LF — a CRLF checkout silently zeroes out newline-anchored regexes and every check
// downstream then reads as passing. (voices_ui_smoke.mjs learned this the hard way.)
const readLf = async p => (await readFile(p, 'utf8')).replace(/\r\n/g, '\n');

// Expand the same restricted literal-include subset as the Python page assembler. Keeping the
// real page path preserves module discovery and path-based caching; the paired assembly test
// detects any unsupported template behavior added to either implementation.
const INCLUDE = /\{%-?\s*include\s+['"]([^'"]+)['"]\s*-?%\}/g;

/** `readLf` plus include expansion, resolved against the page's own directory (the Jinja root). */
const readPageSource = async (p, root = dirname(resolve(p)), depth = 0) => {
  // A cycle would otherwise hang the harness with no output, which reads as a wedged suite.
  if (depth > 10) throw new Error(`include nesting too deep at ${p} - is there a cycle?`);
  const src = await readLf(p);
  let out = '';
  let last = 0;
  for (const m of src.matchAll(INCLUDE)) {
    out += src.slice(last, m.index) + (await readPageSource(join(root, m[1]), root, depth + 1));
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
};

// Every `.js` under the tree, depth first, SORTED. `readdir` order is filesystem-dependent, and
// first-match-wins below is a real tie-break during the split — `$`, `esc` and the four `j*`
// helpers are deliberately defined twice (DESIGN_7_1_FRONTEND_REFACTOR.md §7), so an unsorted
// walk would resolve a duplicated signature to a different file on a different box.
const walkJs = async dir => {
  let out = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};

//: `<link rel="stylesheet" href="/webui/css/…">`, in the order the page writes them.
const CSS_LINK = /<link[^>]*rel="stylesheet"[^>]*href="\/webui\/css\/([^"]+)"/g;

/**
 * The page AS SERVED: index.html with its linked stylesheets inlined where the links are.
 *
 * 🔴 **EVERY HARNESS THAT GREPS THE PAGE FOR A CSS RULE MUST GO THROUGH THIS.** Until 7.3.19 the
 * page carried an 886-line inline `<style>` block, so "read index.html" and "read the page's CSS"
 * were the same act and six smokes did the former while meaning the latter. The split broke all of
 * them at once — `.masked{-webkit-text-security:disc;}` is still in the product, still correct, and
 * simply no longer in that file.
 *
 * ⚠️ **AND THE FAILURE MODE OF THE OBVIOUS FIX IS SILENCE.** Deleting those assertions, or pointing
 * them at one stylesheet, would leave a green suite that no longer checks the rule. Reassembling the
 * document keeps every existing check meaning exactly what it meant, with no edit to the assertion
 * itself — which matters because these are `ok(/…/.test(html))` one-liners whose subject is the
 * regex, not the plumbing.
 *
 * The links are replaced IN PLACE rather than appended, so source order — which is the cascade,
 * see tests/test_webui_css.py — survives into anything that cares about it.
 */
export async function readPage(htmlPath) {
  const key = resolve(htmlPath);
  const html = await readPageSource(key);
  const cssRoot = join(dirname(key), 'css');
  let out = '';
  let last = 0;
  for (const m of html.matchAll(CSS_LINK)) {
    out += html.slice(last, m.index) + '<style>\n' + (await readLf(join(cssRoot, m[1]))) + '</style>';
    last = m.index + m[0].length;
  }
  return out + html.slice(last);
}

/**
 * Read index.html and every module beside it, once. Returns { htmlPath, html, blocks, main,
 * jsRoot, files } and makes it the target of the bare lookups below.
 *
 * ⚠️ `html` here is the FILE, not the served page — `readPage` above is what a CSS assertion
 * wants. This bundle's subject is JavaScript, and every `sliceDef`/`sourceOf` lookup below reads
 * `files`, which is unaffected by the stylesheet split.
 *
 * `files` is the search corpus, in priority order: the page's inline script FIRST, then the
 * modules. 🔴 THE PAGE COMING FIRST IS THE CORRECT TIE-BREAK IN BOTH ERAS. While a helper is
 * duplicated, the inline copy is the one the inline callers actually run, so that is the one a
 * slice is about; when the inline copy is finally deleted the module copy is the only candidate
 * left and the same lookup silently starts being right about the new arrangement.
 */
export async function loadWebSources(htmlPath) {
  const key = resolve(htmlPath);
  let bundle = cache.get(key);
  if (!bundle) {
    const html = await readPageSource(key);
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    // 🔴 THE LONGEST inline block, NOT the last one. 7.1 (DESIGN_7_1_FRONTEND_REFACTOR.md §5.3)
    // adds `<script type="module">` tags to the page and the first one to land sat AFTER the
    // app script — so `blocks.length - 1` selected a three-line shim and every slice resolved
    // to -1. That is not hypothetical; it turned a spec red the moment the first module moved.
    //
    // ⚠️ AT THE END OF THIS MILESTONE THERE IS NO INLINE APP SCRIPT (§10 item 1) and `main`
    // becomes whichever pre-paint block is longest — a dozen lines of theme restore. That is
    // not a failure mode for THIS module, because `files` still holds every module; it is only
    // a failure mode for a harness that keeps reaching for `main` directly instead of asking
    // `sourceOf`. Convert the reach, do not re-point the block picker.
    // 🔴 COMMENTS ARE BLANKED OUT OF THE JS CORPUS — 8.3-m0, DESIGN_8_3_JSDOC_TYPES.md §4.
    // 8.3 puts JSDoc type annotations on every module here, and ~560 assertions in the .mjs
    // harnesses regex over this text. Without this, an unanchored positive assertion is
    // satisfied by a comment QUOTING the code it was meant to prove exists — green over no
    // product — and a negative assertion goes red because someone documented why a thing was
    // removed. `_jscomments.mjs` replaces comment bytes with spaces and keeps every newline, so
    // `sliceBy`'s offset arithmetic and every line number in a failure message are unchanged.
    //
    // 🔴 EVERY ENTRY CARRIES BOTH FORMS, AND WHICH ONE IS USED IS THE WHOLE DESIGN.
    //
    //   `raw`  — the file as written. MARKERS are matched against this.
    //   `text` — the same bytes with comments blanked. CONTENT is returned from this.
    //
    // The first version of m0 stripped both and broke two harnesses, because `sliceText` is
    // DOCUMENTED to accept a comment as a marker — its own docstring lists "a `// ── …` section
    // comment" as a marker form, and voices_ui_smoke.mjs uses three of them
    // (`'// What the boxes held'`, `'// ── Voices management'`, `'// ── Voice Studio (4.0)'`).
    // Blanking the haystack deleted the needle.
    //
    // ✅ THE SPLIT WORKS ONLY BECAUSE `stripComments` PRESERVES OFFSETS. `sliceBy` finds `from`
    // in `raw` and slices `text` at that same index; the two are the same length, byte for
    // byte, so one set of offsets addresses both. A stripper that DELETED comments would make
    // this impossible and is the reason that constraint is not negotiable.
    //
    // ⚠️ `html` AND `blocks` STAY RAW, DELIBERATELY. Seven harnesses assert against the markup
    // — `ok(!/id="vcSeed"/.test(html), 'the Seed input is gone')` has to see the real page, and
    // `readPage` above reassembles stylesheets for the CSS checks. Only the JAVASCRIPT corpus
    // is stripped; `main` is stripped because it IS JavaScript, extracted from the page.
    const mainRaw = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');
    const main = stripComments(mainRaw);

    const base = dirname(key);
    const jsRoot = join(base, 'js');
    const files = [{ label: 'index.html#script', path: key, text: main, raw: mainRaw }];
    for (const p of await walkJs(jsRoot)) {
      const raw = await readLf(p);
      files.push({
        label: relative(base, p).split(sep).join('/'),
        path: p,
        text: stripComments(raw),
        raw,
      });
    }
    bundle = { htmlPath: key, html, blocks, main, jsRoot, files };
    cache.set(key, bundle);
  }
  current = bundle;
  return bundle;
}

/** The bundle the bare lookups are operating on. Throws if nothing has been loaded yet. */
export function webSources() {
  if (!current) {
    throw new Error(
      '_websrc.mjs: nothing loaded yet — "await loadWebSources(htmlPath)" first. ' +
        'A harness does that once, with the path it took from argv.',
    );
  }
  return current;
}

// Regex metacharacters, escaped. See hardening 1 in the header: the six harnesses' markers are
// real source text, not identifiers, and `[]`/`{}`/`.`/`(` in them are not decoration.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isWord = c => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * A marker as a regex over the SAME TOKENS, with the whitespace between them made elastic.
 *
 * 🔴 WHITESPACE IS NOT PART OF WHAT A MARKER ASSERTS, AND 8.3.2 IS WHERE THAT STOPPED BEING FREE.
 * The old body was `s.replace(/\s+/g, '\\s+')` — runs of whitespace matched runs of whitespace, so
 * a marker survived a REFLOW but not a RESPACE. Its own comment warned that "a marker must never
 * rely on the ABSENCE of whitespace to be unique", and roughly two hundred of them did exactly
 * that: `const vOrder=list=>` has no space to relax, so Prettier writing `const vOrder = list =>`
 * left the marker matching nothing. That reads as "the function was deleted" and the fix it invites
 * is deleting the check.
 *
 * ⚠️ THIS IS A RE-ANCHOR, NOT A WIDENING, and the distinction is the whole reason it is safe to do
 * globally. Whitespace between two JavaScript tokens is insignificant by the grammar — `a.b`, `a .b`
 * and `a . b` are one expression — so a marker that tolerates it names exactly the same token
 * sequence it named before. Nothing new becomes matchable except respacing.
 *
 * Which is why the two places where whitespace IS significant are still rigid:
 *
 *   1. BETWEEN TWO IDENTIFIER CHARACTERS whitespace is mandatory and load-bearing. `const vOrder`
 *      keeps `\s+` — it must not decay to `\s*` or the marker would also match `constvOrder`.
 *   2. INSIDE A STRING OR TEMPLATE LITERAL nothing is elastic at all, because there the bytes are
 *      the value. `$('kobSave')` must not come to match `$(' kobSave')`, which is a different
 *      element id and would point the slice at the wrong code while looking like a pass.
 *
 * Everywhere else — either side of `=`, `(`, `,`, `=>`, `{`, `:` — optional whitespace is allowed
 * whether or not the marker was written with any.
 */
/** A quote here can only be CLOSING one — no valid JavaScript puts an opening quote after these. */
const CLOSER_BEFORE = /[A-Za-z0-9_$)\]]/;

/** Characters after which a `/` opens a REGEX rather than dividing. `''` covers start-of-marker. */
const REGEX_START_AFTER = new Set([...'([{,;:!&|?+-~*%<>=^', '']);

/**
 * Split a marker into whitespace runs, whole string/template literals, and single characters.
 *
 * 🔴 A MARKER IS A FRAGMENT, SO ITS QUOTES DO NOT ALWAYS PAIR THE WAY THEY LOOK, AND GUESSING
 * WRONG IS SILENT. Several harnesses start a marker in the MIDDLE of a string literal, because
 * that is where the interesting text begins:
 *
 *     blkToEnhanceWrap').style.display=(blkMode==='cleanup'
 *
 * Read naively left to right, the first `'` looks like an OPENING quote, so the literal scan
 * pairs it with the next one and swallows `').style.display=(blkMode==='` into a single rigid
 * atom — no elasticity around that `=` or `(` at all. The marker then matches NOTHING once
 * Prettier respaces the line, which reads as "the feature was deleted": exactly the silent-garbage
 * failure this module exists to end, reintroduced by the fix for a different one. (Found during
 * 8.3.2 on this very marker, in bulk_staged_smoke.mjs.)
 *
 * ✅ THE DISAMBIGUATION IS A GRAMMAR RULE, NOT A HEURISTIC. `blkToEnhanceWrap'` has an identifier
 * character immediately before the quote, and there is no valid JavaScript in which an OPENING
 * quote follows one — `foo'bar'` does not parse. So that quote must be a CLOSER, the fragment
 * began inside a string, and everything up to and including it is string interior: rigid.
 *
 * ⚠️ AND THE OPPOSITE FRAGMENT MUST NOT BE TREATED THE SAME WAY. A marker like
 *
 *     :'The voice was saved, but the candidate clip could not be deleted
 *
 * has its quote after a `:`, so it OPENS a string the marker then truncates. Everything after it
 * is string interior and must stay rigid too — an earlier cut of this function relaxed unpaired
 * markers wholesale, which made that sentence's own spacing elastic and let `saved,but` satisfy a
 * check about user-visible copy. That is a real widening, and widening is the one thing these
 * markers must never do.
 *
 * So: an unmatched quote is string interior in whichever direction it opens, and never code.
 *
 * ⚠️ REGEX LITERALS ARE ATOMS TOO, AND FOR THE SAME REASON. `js/util/dom.js` defines `esc` with
 * `.replace(/[&<>"]/g, …)` — that `"` is a character class member, not the start of a string, and
 * reading it as one swallows the rest of the line into a rigid atom. Whitespace inside a regex IS
 * significant anyway (`/a b/` is not `/ab/`), so taking the whole literal verbatim is both the
 * safe answer and the correct one.
 */
const atomize = s => {
  /** @type {Array<{t:'ws'|'str'|'ch', v:string}>} */
  const atoms = [];
  let i = 0;

  // The fragment begins inside a string: take the leading run up to that closing quote verbatim.
  const firstQuote = s.search(/['"`]/);
  if (firstQuote > 0 && CLOSER_BEFORE.test(s[firstQuote - 1])) {
    atoms.push({ t: 'str', v: s.slice(0, firstQuote + 1) });
    i = firstQuote + 1;
  }

  // The last significant character emitted as CODE — the only thing that distinguishes a regex
  // literal from a division sign. Same rule as tests/_jscomments.mjs.
  let prev = '';

  for (; i < s.length;) {
    const c = s[i];
    if (c === '/' && REGEX_START_AFTER.has(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < s.length) {
        const d = s[j];
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
        while (j < s.length && /[gimsuy]/.test(s[j])) j++;
        atoms.push({ t: 'str', v: s.slice(i, j) }); // rigid — see the note above
        prev = '/';
        i = j;
        continue;
      }
      // Unterminated: it was a division sign after all. Fall through and treat it as one char.
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      atoms.push({ t: 'ws', v: s.slice(i, j) });
      i = j;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      // Unterminated: the literal runs off the end of the fragment. Rigid to the end — see above.
      atoms.push({ t: 'str', v: s.slice(i, Math.min(j + 1, s.length)) });
      prev = c;
      i = j + 1;
    } else {
      atoms.push({ t: 'ch', v: c });
      prev = c;
      i++;
    }
  }
  return atoms;
};

const relaxSpace = s => {
  const atoms = atomize(s);

  let out = '';
  for (let k = 0; k < atoms.length; k++) {
    const a = atoms[k];
    if (a.t === 'ws') {
      // Mandatory only when identifier characters sit on both sides of it.
      const before = atoms[k - 1];
      const after = atoms[k + 1];
      const l = before && before.t !== 'ws' ? before.v[before.v.length - 1] : undefined;
      const r = after && after.t !== 'ws' ? after.v[0] : undefined;
      out += isWord(l) && isWord(r) ? '\\s+' : '\\s*';
      continue;
    }
    // Between two adjacent non-whitespace atoms, allow whitespace the marker did not have —
    // unless both sides are identifier characters, where inserting any would split one token.
    const prev = atoms[k - 1];
    if (prev && prev.t !== 'ws') {
      const l = prev.v[prev.v.length - 1];
      const r = a.v[0];
      if (!(isWord(l) && isWord(r))) out += '\\s*';
    }
    out += escapeRe(a.v);
  }
  return out;
};

/**
 * A DEFINITION marker: anchored to the start of a line, with an optional `export ` in front so the
 * same marker works before and after a move.
 *
 * 🔴 THE COLUMN-0 ANCHOR IS NOT FUSSINESS. A plain `includes('function wbStream')` matches
 * index.html's own COMMENT about that function — the one warning that `wbCloseStream` must not
 * shadow it, which quotes the marker verbatim. Searching for a mention finds the warning, picks
 * the wrong file and slices garbage. Every top-level definition is at column 0 in both the page
 * and a module.
 *
 * ⚠️ WHICH IS ALSO ITS LIMIT: a marker that gets INDENTED by the split — a listener registration
 * gathered into a wiring function, the way `wbWire` swallowed three `wbWire('cards')` calls in
 * 7.1-m13 — stops matching here and needs `sliceText`.
 */
export const defRe = sig => new RegExp('^(?:export\\s+)?' + relaxSpace(sig) + (/\w$/.test(sig) ? '\\b' : ''), 'm');

/**
 * A LITERAL marker: the same escaping and whitespace relaxation, no column anchor and no `export`
 * allowance. For the markers that are not definitions at all — a listener registration, a section
 * comment, an `if(` guard — and for anything the split has re-indented.
 */
export const textRe = text => new RegExp(relaxSpace(text), 'm');

const fileList = b => b.files.length + ' file(s): ' + b.files.map(f => f.label).join(', ');

const notFound = (what, marker, kind, b) =>
  new MarkerNotFound(
    what +
      ' marker not found: "' +
      marker +
      '"\n' +
      '  searched ' +
      fileList(b) +
      '\n' +
      (kind === 'def'
        ? '  A definition marker is anchored to column 0, with an optional "export ". If the code ' +
          'moved AND was re-indented, use sliceText(); if it was renamed or deleted, this is a ' +
          'real finding — fix the marker, do not delete the check.'
        : '  A literal marker is matched anywhere in a file, whitespace-insensitively. If the text ' +
          'was rewritten (a section comment is the usual casualty), re-anchor the check on a ' +
          'definition with sliceDef() instead of on prose.'),
  );

/** The corpus entry — { label, path, text } — whose file defines `sig`. Throws if none does. */
export function fileOf(sig) {
  const b = webSources();
  const re = defRe(sig);
  const hit = b.files.find(f => re.test(f.raw)); // markers live in RAW — see loadWebSources
  if (!hit) throw notFound('definition', sig, 'def', b);
  return hit;
}

/**
 * The FULL SOURCE OF THE FILE that defines `sig` — page inline script or module, whichever it is.
 *
 * 📌 The whole file, deliberately, not just the definition: the useful question is nearly always
 * "is this fact true near this definition" (wbedit asserts that `wbWire`'s three call sites live
 * in the same file as `wbWire`, because that module exports nothing and a definition that arrived
 * without its callers is a module that loads and wires nothing). Use `sliceDef` when you want the
 * definition alone.
 */
export const sourceOf = sig => fileOf(sig).text;

/**
 * `sourceOf` for the case where PRESENCE IS THE ASSERTION rather than a precondition — returns
 * null instead of throwing, so the harness's own `ok()` can name what is missing and carry on
 * with its remaining checks.
 */
export function sourceOfOrNull(sig) {
  const b = webSources();
  const re = defRe(sig);
  const hit = b.files.find(f => re.test(f.raw)); // markers RAW, content stripped
  return hit ? hit.text : null;
}

// The engine under sliceDef/sliceText. `reOf` decides what a marker means; everything else —
// including all four ways this can fail — is common.
const sliceBy = (startMarker, endMarker, reOf, kind) => {
  const b = webSources();
  const startRe = reOf(startMarker);
  const file = b.files.find(f => startRe.test(f.raw));
  // 🔴 SAY WHICH MARKER WENT MISSING. The alternative — returning '' — makes three unrelated
  // checks fail for a reason none of them names, and the fix that suggests itself is to delete
  // them. A renamed or deleted function is a real finding and deserves to read like one.
  if (!file) throw notFound(kind === 'def' ? 'start definition' : 'start text', startMarker, kind, b);

  // 🔴 OFFSET FOUND IN `raw`, CONTENT TAKEN FROM `text`. Same length, so the index addresses
  // both — that is what lets a COMMENT still be a valid marker while the returned slice is
  // comment-free.
  const from = file.raw.match(startRe).index;
  const restRaw = file.raw.slice(from);
  const rest = file.text.slice(from);
  if (endMarker == null) return rest; // to the end of the file, by request

  const endRe = reOf(endMarker);
  const after = restRaw.match(endRe);
  if (after && after.index > 0) return rest.slice(0, after.index);

  // 🔴 THE END MARKER MATCHED THE START POSITION — an empty slice dressed up as a successful
  // one. kobold_ui_smoke.mjs and wbedit both hit the prefix form of this: 'function wbStream' as
  // an end marker also matches the START of `function wbStream`, and it matches `wbCloseStream`
  // besides. Never return the '' quietly.
  if (after) {
    throw new MarkerNotFound(
      'end marker "' +
        endMarker +
        '" matches AT the start marker "' +
        startMarker +
        '" in ' +
        file.label +
        ', so the slice would be empty. The two markers are the same text, or ' +
        'one is a prefix of the other — name the definition that FOLLOWS instead.',
    );
  }

  // 🔴 NOT FOUND AFTER THE START IS THREE DIFFERENT FACTS, and wbedit's copy could only tell one
  // of them because it never looked past the file the start marker was in:
  //
  //   a. the end marker is EARLIER in this same file — the slice the caller meant runs backward.
  //      `''` was the old answer and it fails every check downstream against unchanged code.
  //   b. the end marker is in ANOTHER file — the normal case once the split separates two
  //      functions that used to be adjacent. Slicing to the end of the start marker's file is
  //      right, and it is the one case that must NOT throw.
  //   c. the end marker is NOWHERE — renamed, deleted, or mistyped. A real finding.
  //
  // ⚠️ (b) HANDS BACK A LARGER SLICE THAN THE CALLER EXPECTED, not a smaller one, and that
  // matters for the harnesses that `vm.runInContext` their slice: it may now carry the rest of a
  // module, including `export` keywords and functions with imported dependencies. Run it through
  // `stripModuleSyntax` and expect the sandbox to need more stubs. A check that `.test()`s for a
  // string only the intended function contains cannot pass FALSELY on a longer slice, but a
  // check asserting something is ABSENT can — tighten those by naming the next definition.
  if (endRe.test(file.raw)) {
    throw new MarkerNotFound(
      'end marker "' +
        endMarker +
        '" is in ' +
        file.label +
        ' but BEFORE the start marker "' +
        startMarker +
        '", so the slice runs backward. Swap them, or name a marker that ' +
        'follows the start.',
    );
  }
  if (b.files.some(f => endRe.test(f.raw))) return rest;
  throw notFound(kind === 'def' ? 'end definition' : 'end text', endMarker, kind, b);
};

/**
 * The text from one DEFINITION to the next, within whichever file the first one lives in. Omit
 * `endSig` to run to the end of that file.
 *
 * This is the replacement for `main.slice(main.indexOf(a), main.indexOf(b))`, and unlike it, every
 * way of going wrong raises with the offending marker in the message.
 */
export const sliceDef = (startSig, endSig) => sliceBy(startSig, endSig, defRe, 'def');

/**
 * `sliceDef` for markers that are not definitions — `$('kobSave').addEventListener`, a `// ── …`
 * section comment, `if(!(window.CSS&&CSS.supports` — or for a definition the split has indented.
 * Matched anywhere in a file rather than at column 0.
 *
 * ⚠️ PREFER `sliceDef` WHERE YOU HAVE THE CHOICE. Without the anchor a marker can match a comment
 * that quotes it, which is the failure the anchor exists to prevent.
 */
export const sliceText = (startText, endText) => sliceBy(startText, endText, textRe, 'text');

/**
 * Make a module's source runnable by `vm.runInContext`, which compiles a CLASSIC script: `import`
 * and `export` are SyntaxErrors there, and a SyntaxError at this point reads as "the feature is
 * broken" rather than as "this code is a module now".
 *
 * 🔴 STRIPPED WITH /gm, NOT ONCE. wbedit hit this: a slice that runs on past its intended end (see
 * case (b) in sliceBy) carries the NEXT function's `export` too, and stripping only the first
 * leaves `export function wbMins` sitting in the middle of the snippet.
 *
 * ⚠️ Imports are removed, NOT resolved — whatever they named still has to exist in the sandbox, so
 * the usual symptom of a slice that has grown is a ReferenceError naming a helper you now need to
 * stub. The multi-line import form (js/wb/wire.js, js/wb/open.js) is why this runs to the first
 * `;` rather than to end of line.
 *
 * ⚠️ There is no `export default` or `export { … }` anywhere in src/webui/js/ today and this does
 * not handle either: a bare `{ a, b };` left behind by the second form is a block statement whose
 * body throws ReferenceError at run time. If a re-export appears, delete the line instead.
 */
export const stripModuleSyntax = src => src.replace(/^import\s[\s\S]*?;[^\S\n]*$/gm, '').replace(/^export\s+/gm, '');

// ═════════════════════════════════════════════════════════════════════════════════════════
// 🔴 THE BROWSER SPECS' PAGE SURFACE — 7.3-m13, AND IT MOVED FROM PRODUCTION INTO THE HARNESS.
//
// Until m13, `index.html` ended with `Object.assign(window, …fifty module namespaces…)`. That shim
// existed for the shrinking inline script, and the browser specs were its second beneficiary: they
// drive the page through CDP `Runtime.evaluate`, which runs an expression in the page's GLOBAL
// scope, so `switchTab('devices')` or `loadVoiceList()` worked because the shim had published them.
//
// §10 item 2 deletes that shim. The names are module exports now and nothing puts them on `window`,
// so every spec that calls one gets `ReferenceError` — which, per
// `test_webui_modules.py::test_every_function_the_browser_specs_drive_is_still_reachable`, costs a
// 100-second run, twelve FAILed checks and no error message worth reading.
//
// ✅ SO THE HARNESS PUBLISHES WHAT THE HARNESS NEEDS. This is not the shim moved sideways — the
// difference is the whole point:
//
//   * It runs in the TEST, against a page that ships clean. Nothing a user loads has it.
//   * ⚠️ IT IS **NOT** LIVE, AND THIS BULLET USED TO CLAIM IT WAS. It said the `Object.assign(
//     window, await import(…))` copies "LIVE namespace objects" so "a reassigned export cannot
//     freeze the way the production shim's one-time copy did". That is false, and it is §11.4's
//     own misconception wearing the opposite face: `Object.assign` READS each property off the
//     namespace object and writes a plain data property onto `window`, once. It is the same
//     one-time copy the shim did — the module namespace being live does not make the copy live.
//     🔴 SO A REASSIGNED EXPORT IS FROZEN ON `window` HERE EXACTLY AS IT WAS ON THE SHIM. Nothing
//     is broken by it today only because the modules holding reassigned state — sys/modelstate.js
//     is the one to watch — are NOT on the list below, and the ones that are reassign nothing. A
//     spec that starts asserting on a value some module rebinds will read the value it had at
//     publish time and will be wrong in the direction that looks like a product bug.
//     📌 The right fix if that day comes is the one the page already uses: publish an ACCESSOR
//     (`stTabNow()`, `vcTabNow()`), never the binding.
//   * The list is HERE, in one place, rather than in eight spec files.
//
// ⚠️ ADD A MODULE HERE ONLY WHEN A SPEC DRIVES ONE OF ITS EXPORTS. This is a test surface, not a
// convenience: publishing everything would let a spec depend on a name no page caller has, which is
// how `wbLoadLog` became module-private on a correct measurement and broke a spec anyway.
export const SPEC_SURFACE = [
  'util/dom.js',
  'util/fmt.js',
  'util/filter.js',
  'util/appstate.js',
  'util/uistate.js',
  'ui/tabs.js',
  'ui/tabswitch.js',
  'ui/modal.js',
  'ui/audition.js',
  'ui/theme.js',
  'ui/fav.js',
  'ui/voicepicker.js',
  'sys/devices.js',
  'sys/model.js',
  'sys/enhance.js',
  'sys/hwstrip.js',
  'sys/kobold.js',
  'sys/llama.js',
  'llm/tabs.js',
  'llm/tabstate.js',
  'media/stemwidget.js',
  'media/bulk.js',
  'voice/candidates.js',
  'voices/voices.js',
  'voices/vcstate.js',
  'st/tabs.js',
  'st/tabstate.js',
  'st/chars.js',
  'st/nomi.js',
  'st/log.js',
  'scenes/scenes.js',
  'pg/playground.js',
  'pg/pgstate.js',
  'book/library.js',
  'book/books.js',
  'wb/state.js',
  'wb/edit.js',
  'wb/open.js',
  'wb/log.js',
  'wb/kind.js',
  'wb/face.js',
  'wb/prompt.js',
  'wb/apply.js',
  'wb/st.js',
  'wb/say.js',
  'wb/pass.js',
  'wb/fmt.js',
];

/** The expression a spec evaluates once, after the page is ready, to make module exports reachable
 *  as page globals for the rest of that spec.
 *
 *  ⚠️ AWAIT IT. It returns a promise; `Runtime.evaluate` with `awaitPromise: true` resolves it, and
 *  a spec that fires and forgets will race its own first assertion.
 *
 *  ⚠️ AND GATE ON `window.__uiReady` FIRST, not on `typeof someName === 'function'`. Those gates
 *  used to work because the shim published before boot; now the name a gate tests for does not
 *  exist until THIS expression has run, so gating on it deadlocks. `js/main.js` sets `__uiReady` in
 *  its module body — the earliest correct moment, and the same signal the tab bar uses.
 *
 *  🔴 AND IF THE SPEC THEN MEASURES GEOMETRY, ADD `window.__bootDone === true` (7.5.8). The two
 *  flags are different facts and the difference became visible when boot stopped being serial:
 *
 *      __uiReady   the MODULES RAN. Set in main.js's module body, before a fetch is issued. It is
 *                  what the #tabs listener consults, so it is the right — and only — gate for a
 *                  spec that clicks a real tab button.
 *      __bootDone  the BOOT DATA ARRIVED. Set at the end of main.js's boot IIFE, once every boot
 *                  fetch has settled, before the Studio resumes (which can take seconds and steal
 *                  the tab). This is the one that means the page has its full HEIGHT.
 *
 *  Gate on both when you click a tab AND measure it, which is most of them. A spec that measures a
 *  box before `__bootDone` is racing a page that is still filling in, and it fails as an absurd
 *  precondition — "the section runs off the bottom of the window (0px vs 570px)" — rather than as
 *  anything resembling a missing wait. */
/* 🔴 IT REPORTS THE MODULE THAT FAILED. IT USED TO SWALLOW IT AND RETURN `true` ANYWAY.
 *
 * The old body was `try { … } catch (e) {}` around the import, with an unconditional `return true`
 * after the loop — so a module that 404'd, threw at evaluation, or had been renamed produced a
 * silent nothing, and every spec that awaits this expression carried on asserting against a page
 * missing exactly the names it was about to test. That is the failure this file's own header says
 * the design exists to prevent, written into the one line that does the work.
 *
 * ⚠️ EVERY FAILURE COLLECTED, THEN ONE THROW AT THE END — not a throw on the first. The message
 * has to name ALL of them, because a renamed directory breaks a dozen at once and stopping at the
 * first turns one cause into a dozen sequential red runs.
 *
 * 🔴 A THROW RATHER THAN A RETURNED STRING, AND THE CALL SITES ARE WHY. All fifteen callers write
 * `await evaluate(cdp, PUBLISH_SPEC_SURFACE);` and DISCARD the result, so any value this resolves
 * to — `true`, a list of failures, anything — is read by nobody. The specs' `evaluate` helpers do
 * check `exceptionDetails` and rethrow, so a rejection is the one signal that reaches them without
 * editing fifteen files.
 *
 * 🔴 BUT A BARE "IT FAILED" CANNOT BE THE TRIGGER, AND THIS IS THE PART THAT WAS MEASURED RATHER
 * THAN REASONED. Making every failure fatal turned `test_scene_edit_browser.py` red — 19 of the 46
 * reporting "Failed to fetch dynamically imported module". Run ALONE that same spec publishes all
 * 46 with zero failures; it only fails at `-n 16`. So the common failure here is the suite's own
 * load against a dev server, not a broken module, and a fatal throw on it buys a FLAKY suite —
 * which is a worse defect than the silence it replaced, because a suite that cries wolf gets
 * ignored wholesale.
 *
 * So the two are told apart instead of lumped together:
 *   * a message containing "Failed to fetch" is a TRANSPORT failure. Probe the URL with `fetch()`
 *     — which does not touch the module map, so it is a clean second opinion — and if the file
 *     genuinely serves, treat it as the load flake it is and carry on.
 *   * anything else is the module EVALUATING badly (a real SyntaxError, a real ReferenceError at
 *     module scope), and that is fatal on the first occurrence. It is also the case that no amount
 *     of retrying would fix.
 *   * a transport failure whose probe ALSO fails is a genuinely unreachable module — a rename, a
 *     404, a route regression — and is fatal.
 *
 * ⚠️ A FAILED IMPORT CANNOT SIMPLY BE RETRIED, which is why the retry carries `?republish=n`: a
 * module whose fetch fails is recorded as ERRORED in the document's module map, and re-importing
 * the same specifier replays that error without going back to the network. A different specifier
 * is a different map key, so it re-fetches. `fetch()` sidesteps the map entirely and is what
 * decides whether the file is reachable at all.
 *
 * 🔴 AND TOLERATING A LOSS WITHOUT RECOVERING IT IS THE WORST OF THE THREE OPTIONS, which is why
 * the retry exists rather than a shrug. Measured: when `ui/tabs.js` was merely skipped,
 * `clips_favorites_browser_spec.mjs` did not fail at the publish — it failed two lines later with
 * `ReferenceError: switchTab is not defined`, which reads as a product bug in the tab bar. Both the
 * old `catch (e) {}` and a bare tolerate produce that. Publishing the module is the only outcome
 * that leaves the spec asserting what it was written to assert.
 *
 * 📌 THE DUPLICATE INSTANCE THE RETRY CREATES IS CONFINED TO ONE MODULE, and that is what makes it
 * sound enough to do. Only the top specifier carries the query; the module's own relative imports
 * (`./tabs.js` -> `./modal.js`) resolve WITHOUT it, so they hit the entries the page already
 * loaded. The republished copy therefore shares every dependency and every piece of shared state
 * with the page — the only thing duplicated is that one file's own module-level bindings.
 *
 * 🔴 `window.__VOCALIS__` IS TRIED FIRST, AND IT IS ABOUT INSTANCE IDENTITY, NOT SPEED (7.5.6).
 * This worked for its whole life on an accident that stopped being true: the page loaded
 * `/webui/js/scenes/scenes.js`, this imported the SAME URL, and the browser's module map returned
 * the SAME instance — so `loadScenes` here was the one wired to the DOM. Now that index.html loads
 * `/webui/bundle/app.js`, that URL is a STRANGER: importing it builds a second copy of the module
 * with its own `scLib`, attached to nothing on screen. Every assertion would then be interrogating
 * a private replica of the app while the visible one sat untouched — and it would fail as wrong
 * VALUES, never as an error, which is the worst way for a harness to be broken.
 *
 * The bundle publishes every module namespace on `window.__VOCALIS__`, keyed by these same
 * specifiers, so the registry hands back the page's real instances. ⚠️ THE IMPORT FALLBACK BELOW
 * STAYS: a spec pointed at a page that is not bundled (or one served before a build) still works,
 * and the day the registry is missing a key the answer is a real module, not a silent skip.
 *
 * 📌 And the deterministic half of this guarantee does not live here at all —
 * `test_webui_modules.py::test_every_module_the_spec_surface_publishes_is_actually_served` asks
 * "is every one of these 46 reachable?" through the Flask test client, where there is no browser,
 * no concurrency and nothing to flake. */
export const PUBLISH_SPEC_SURFACE = `(async () => { const failed = [], flaked = [], reg = window.__VOCALIS__ || null;
     for (const m of ${JSON.stringify(SPEC_SURFACE)}) {
       if (reg && reg[m]) { Object.assign(window, reg[m]); continue; }
       try { Object.assign(window, await import('/webui/js/' + m)); }
       catch (e) {
         const msg = (e && e.message) ? e.message : String(e);
         if (!/Failed to fetch/i.test(msg)) { failed.push(m + ': ' + msg); continue; }
         let served = false;
         try { const r = await fetch('/webui/js/' + m, {cache: 'no-store'}); served = r.ok; }
         catch (e2) { served = false; }
         if (!served) { failed.push(m + ': ' + msg); continue; }
         let recovered = false;
         for (let n = 1; n <= 3 && !recovered; n++) {
           try { Object.assign(window, await import('/webui/js/' + m + '?republish=' + n));
                 recovered = true; }
           catch (e3) { await new Promise(r => setTimeout(r, 150 * n)); }
         }
         (recovered ? flaked : failed).push(m + ': ' + msg);
       }
     }
     if (failed.length) throw new Error(
       'the spec surface failed to publish, so this spec would be asserting against a page '
       + 'missing the very names it tests: ' + failed.join(' | '));
     if (flaked.length) console.warn('spec surface: ' + flaked.length
       + ' module(s) lost to transport under load, all still served: '
       + flaked.map(f => f.split(':')[0]).join(', '));
     return true; })()`;

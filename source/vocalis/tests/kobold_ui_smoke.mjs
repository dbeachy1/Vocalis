// Vocalis 4.7-m1 — the KoboldCpp tab's render helpers, driven by tests/test_kobold_ui.py.
//
// The Python tests here talk to the ROUTES. None of them would notice that the drop-down
// renders two identical labels for different configs, that a remote host silently shows a
// 0 GB VRAM figure, or that the admin token input quietly became type="password" again —
// and each of those is a specific thing this design spent pages deciding. So the real
// helpers get sliced out of the real index.html and exercised.
//
// No npm dependencies (the bulk_staged_smoke.mjs / stems_widget_smoke.mjs convention).
//
// Usage: node kobold_ui_smoke.mjs <path-to-index.html>
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
// 🔴 7.3-m6c: THE m0 MODULE-AWARE LOADER. `main` below is the page's inline block and nothing else,
// so every `main.indexOf(…)` here answers -1 the moment its subject moves into src/webui/js/ — and
// -1 makes `main.slice` return '' rather than raising, so the checks downstream report the feature
// as broken when it is merely somewhere else. That is precisely what m6c did to the six `runBook`
// checks below. `sliceDef` searches the page AND the module tree and throws with the marker named.
// The page-first tie-break is what keeps the `jget`/`jpost` slices reading the INLINE copies, which
// is what the still-inline callers run — see _websrc.mjs's loadWebSources note.
// ⚠️ `sliceText` NOT `sliceDef` SINCE 8.8-m10: every marker in this file names a statement that
// now begins with a JSDoc cast comment, so a column-0 definition anchor can no longer find it.
// The markers below carry the cast's parens, which is what keeps each one unambiguous.
import { readPage, loadWebSources, defRe, sliceDef, sliceText, sourceOf, stripModuleSyntax, textRe } from './_websrc.mjs';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node kobold_ui_smoke.mjs <index.html>');
  process.exit(2);
}

// Normalized to LF — see the note in voices_ui_smoke.mjs. A CRLF checkout silently zeroes
// out newline-anchored regexes.
// The page AS SERVED: index.html with its stylesheets inlined. Every CSS assertion
// below depends on that - those rules left this file for src/webui/css/ at 7.3.19.
const html = await readPage(htmlPath);
await loadWebSources(htmlPath); // the corpus sliceDef/sourceOf search: the page plus every module
let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
// 🔴 THE LONGEST inline block, NOT the last one. 7.1 (DESIGN_7_1_FRONTEND_REFACTOR.md §5.3) adds
// `<script type="module">` tags to the page, and the first one to land sat AFTER the app script —
// so `blocks.length - 1` silently selected a three-line shim and every slice below resolved to -1.
// That is not a hypothetical: it turned this spec red the moment the first module was extracted.
// The app script is the big one by three orders of magnitude, and it stays the big one until the
// split finishes, at which point there is no inline app script and these specs need rewriting
// against the real DOM anyway (§5's own note).
const main = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

// 🔴 7.3-m4: THE KOBOLD CODE IS NOT IN index.html ANY MORE. It is js/sys/kobold.js. `kobjs` below
// is that file read whole, and it is now used for exactly two WHOLE-FILE facts — "the module is
// where this harness says it is" and the feature detection in §1 — because both are claims about
// the file rather than about one helper. Every SLICE goes through `sliceDef` instead (8.3.2): a
// marker `indexOf` cannot find answers -1, `slice(-1, …)` is silently '' and the checks downstream
// then read as a broken feature, whereas `sliceDef` raises MarkerNotFound naming the marker that
// moved. It also searches the page AND the module tree, so `jget`/`jpost` (still duplicated inline
// during the split) and `runBook` (js/book/job.js) resolve without this file knowing where they sit.
//
// ⚠️ The path is DERIVED from the index.html argument rather than added as a second one, so
// test_kobold_ui.py's invocation is unchanged.
//
// 🔴 `export ` IS STRIPPED, AND IT IS NOT COSMETIC — vm.runInContext() is not a module context, so
// one leaked keyword is `SyntaxError: Unexpected token 'export'` and every check below it never
// runs. `kobjs` strips it up front; the `sliceDef` slices that get RUN go through
// `stripModuleSyntax` for the same reason. (`sliceDef`'s own end markers allow an optional
// `export `, so a slice now ends BEFORE those seven characters rather than keeping them as its
// tail — which is the specific way this harness broke at 7.3-m4.)
const kobPath = join(dirname(htmlPath), 'js', 'sys', 'kobold.js');
const kobjs = (await readFile(kobPath, 'utf8')).replace(/\r\n/g, '\n').replace(/^export /gm, '');
// ⚠️ 8.3.2 RE-ANCHOR, NOT A WIDENING. The claim is unchanged — kobold.js is the file that defines
// the write-only settings renderer — but 8.3.2 ran the module through Prettier, so the dense
// literal this used to `includes()` is now `export function kobRenderSettings(s) {`. `defRe` builds
// a regex over the SAME tokens with the whitespace between them elastic, plus a column-0 anchor, so
// a renamed helper or a changed signature still fails here; only respacing stopped mattering.
ok(defRe('function kobRenderSettings(s){').test(kobjs), `read the KoboldCpp module at ${kobPath}`);

// ── 1. the admin token field: every attribute here is load-bearing ───────────
// These are markup facts no render helper can show, so they are checked against the file.
const tok = html.match(/<input[^>]*id="kobToken"[^>]*>/);
ok(!!tok, 'found the KoboldCpp admin token input');
if (tok) {
  const t = tok[0];
  // type="text" is what keeps Chrome's password manager off the field entirely. As a
  // password input it would autofill the VOCALIS login password (credentials are keyed by
  // ORIGIN and /login is on this one) — and Kobold answers a wrong password with a silent [].
  ok(/type="text"/.test(t), 'the token input is type="text" — NOT type="password"');
  ok(!/type="password"/.test(t), "and is not a password field (Chrome's manager triggers on that, full stop)");
  // The price of the swap. Browsers exclude password fields from spellcheck/translation
  // telemetry; text inputs are NOT excluded, and Chrome's Enhanced Spellcheck ships their
  // contents to Google ("spell-jacking"). One attribute buys back what the swap gives up.
  ok(/spellcheck="false"/.test(t), 'spellcheck="false" is present — without it this ships the admin password to a spellcheck service');
  ok(/autocomplete="off"/.test(t), 'autocomplete="off" (which actually works on a text input)');
  ok(/class="masked"/.test(t), 'it starts masked');
  ok(
    !/password/i.test((t.match(/id="[^"]*"/) || [''])[0] + (t.match(/name="[^"]*"/) || [''])[0]),
    'the word "password" stays out of the id/name (Chrome\'s field heuristics read them)',
  );
}
ok(/\.masked\{-webkit-text-security:disc;\}/.test(html), 'the mask is CSS (-webkit-text-security)');

// The Show toggle must flip the CLASS, never el.type. `el.type='text'` is the obvious
// one-liner, looks identical on screen, and re-arms spell-jacking AND hands the field back
// to Chrome's password manager — undoing both decisions invisibly.
// ⚠️ The two markers are unchanged, so this is the same code it always sliced; only the LOOKUP
// moved off `kobjs.indexOf` (see the header). A listener that gets gathered into a wiring function
// now throws with its own name in the message instead of quietly slicing ''.
const showHandler = sliceText("($('kobShow')).addEventListener", "($('kobSave')).addEventListener");
ok(/classList\.toggle\('masked'/.test(showHandler), 'the Show toggle flips the CSS class');
ok(!/\.type\s*=/.test(showHandler), 'the Show toggle NEVER assigns el.type');

// Where the mask is unsupported the value is visible, so an unchecked "Show" box beside it
// would claim the opposite of what is on screen. Hide it: degrade, don't mislead.
// ⚠️ 8.3.2 RE-ANCHOR, NOT A WIDENING: Prettier put a space after the comma between the two
// arguments. `textRe` relaxes the whitespace BETWEEN tokens and stays byte-rigid INSIDE a string
// literal, so `'-webkit-text-security'` and `'disc'` — which are the feature actually being
// detected — must still be exactly those. Detecting a different property would still fail.
ok(
  textRe("CSS.supports('-webkit-text-security','disc')").test(kobjs),
  'the mask is feature-detected, and the Show checkbox hides when it cannot work',
);

// ── 2. the write-only contract, as the UI honors it ─────────────────────────
// ⚠️ The `ok(from > 0 && to > from, 'located kobRenderSettings…')` precondition that used to sit
// here is not deleted, it is SUPERSEDED: `sliceDef` raises MarkerNotFound naming whichever marker
// moved and node exits 1 with a stack, which is strictly louder than one counted FAIL. That is the
// documented conversion — see "CONVERTING A HARNESS" in tests/_websrc.mjs.
const settingsSrc = stripModuleSyntax(sliceText('function kobRenderSettings(s){', 'if(!(window.CSS&&CSS.supports'));

const els = {};
const mkEl = () => ({
  innerHTML: '',
  textContent: '',
  value: '',
  placeholder: '',
  disabled: false,
  style: {},
  classList: { toggle() {}, add() {}, remove() {} },
  addEventListener() {},
});
const sandbox = { $: id => (els[id] ||= mkEl()), esc: s => String(s), window: {}, CSS: null };
vm.createContext(sandbox);
vm.runInContext(settingsSrc, sandbox);

// A password that is SET must still leave the input EMPTY. The moment the GET returns the
// value to pre-populate it, the secret is in the DOM, in every settings fetch, and in
// whatever Chrome decides to remember. `_set` is the whole reason this is safe.
sandbox.kobRenderSettings({ kobold_url: 'https://test-server.invalid:5001', kobold_adminpassword_set: true });
ok(els.kobToken.value === '', 'a SET password still leaves the input empty — it never round-trips');
ok(els.kobUrl.value === 'https://test-server.invalid:5001', 'the URL does round-trip (it is not a secret)');
ok(/set/i.test(els.kobToken.placeholder), 'the UI renders STATE ("set"), not a value');
ok(els.kobClear.disabled === false, 'Clear is live when a password is set');

sandbox.kobRenderSettings({ kobold_url: '', kobold_adminpassword_set: false });
ok(els.kobClear.disabled === true, 'Clear is disabled when there is nothing to clear');
ok(/no password/i.test(els.kobPwState.textContent), 'and it says loading is disabled until one is set');

// Omitted != empty: a URL edit must not carry a password key at all, or it wipes the stored one.
const saveHandler = sliceText("($('kobSave')).addEventListener", "($('kobClear')).addEventListener");
// ⚠️ 8.3.2 RE-ANCHOR, NOT A WIDENING. The claim is the GUARD: the key is assigned only inside
// `if ($('kobToken').value)`. Every token is still required, in the same order — the elastic part
// is only the whitespace Prettier introduced around `(`, `)` and `=`. `'kobToken'` stays byte-exact
// because `$(' kobToken')` is a different element and matching it would prove nothing.
ok(
  // ⚠️ 8.8-m9: the same re-anchor a second time. The box is read through a cast now, so the
  // parens are admitted — the GUARD is still what is pinned, and the assignment still has to sit
  // inside it. `'kobToken'` remains byte-exact for the reason above.
  textRe("if(($('kobToken')).value)body.kobold_adminpassword=").test(saveHandler),
  'Save sends the password ONLY when one was typed (omitted = untouched)',
);
// Omitting the end marker runs the slice to the end of the file — what the old one-argument
// `kobjs.slice(indexOf(…))` did. The 600-char window below is unchanged.
const clearHandler = sliceText("($('kobClear')).addEventListener");
ok(
  // The empty STRING is the whole claim (an omitted key would leave the password alone), so `''`
  // stays rigid; only the space Prettier put after the colon is tolerated.
  textRe("kobold_adminpassword:''").test(clearHandler.slice(0, 600)),
  'Clear sends an explicit empty string (which is what CLEARS it)',
);

// ── 3. the detail line ───────────────────────────────────────────────────────
// The located-it precondition is `sliceDef`'s job now: a bad slice used to run the WHOLE file in
// the sandbox below, so this exited loudly rather than letting that happen. MarkerNotFound does
// the same thing and names the marker that moved.
const detailSrc = stripModuleSyntax(sliceText('function kobRenderDetail(){', "($('kobSel')).addEventListener('change'"));

const sb2 = {
  $: id => (els[id] ||= mkEl()),
  esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]),
  kob: { configs: [], info: { host: 'test-server.invalid' } },
};
vm.createContext(sb2);
vm.runInContext(detailSrc, sb2);

sb2.$('kobSel').value = 'a.kcpps';
sb2.kob.configs = [
  {
    name: 'a.kcpps',
    label: 'A',
    detail: {
      contextsize: 98304,
      gpulayers: 999,
      usevulkan: [1, 2],
      model_param: '/ai-models/x.gguf',
      model_exists: true,
    },
  },
];
sb2.kobRenderDetail();
ok(/98,304/.test(els.kobDetail.innerHTML), 'the detail line shows the context size');
ok(/999/.test(els.kobDetail.innerHTML), 'and gpulayers');

// REMOTE: the detail line must degrade DELIBERATELY, not describe the wrong box's configs.
sb2.kob.configs = [{ name: 'a.kcpps', label: 'A' }]; // no detail -> remote
sb2.kobRenderDetail();
ok(
  /details live on test-server\.invalid/.test(els.kobDetail.innerHTML),
  'remote: the detail line says the files live on the other box rather than reading this one',
);

// "missing" must distinguish not-there from can't-see-it (the 5.x locked-vault case).
sb2.kob.configs = [{ name: 'a.kcpps', label: 'A', detail: { model_param: '/x.gguf', model_exists: false } }];
sb2.kobRenderDetail();
ok(/model file missing/.test(els.kobDetail.innerHTML), 'one missing model reads as missing');
sb2.kob.configs = [
  {
    name: 'a.kcpps',
    label: 'A',
    detail: { model_param: '/x.gguf', model_exists: false, models_all_missing: true },
  },
];
sb2.kobRenderDetail();
ok(
  /locked vault/.test(els.kobDetail.innerHTML) && !/model file missing/.test(els.kobDetail.innerHTML),
  'but EVERY model missing at once reads as a locked vault, not four deleted models',
);

// a corrupt kcpps is reported on its row, not 500ing the tab
sb2.kob.configs = [{ name: 'a.kcpps', label: 'A', detail: { error: 'unreadable: bad json' } }];
sb2.kobRenderDetail();
ok(/unreadable/.test(els.kobDetail.innerHTML), 'a corrupt config reports its error on the row');

// a config name is DATA, never markup — it comes off Kobold's disk
sb2.kob.configs = [
  {
    name: '<img src=x onerror=alert(1)>.kcpps',
    label: 'X',
    detail: { model_param: '<script>bad()</script>' },
  },
];
sb2.$('kobSel').value = '<img src=x onerror=alert(1)>.kcpps';
sb2.kobRenderDetail();
ok(
  !/<img src=x/.test(els.kobDetail.innerHTML) && !/<script>bad/.test(els.kobDetail.innerHTML),
  'a config name / model path with markup in it is escaped, not injected',
);

// ── 4. error codes must NEVER reach the screen ───────────────────────────────
// `jget` threw `new Error(j.error)` without attaching `e.body`, so each error branch fell through
// to `e.message` and rendered only the machine code instead of a useful sentence.
// ⚠️ sliceDef, not main.indexOf (7.3-m6c) — and it still reads the INLINE jget, because
// _websrc.mjs searches the page before the modules and `$`/`esc`/`j*` are deliberately duplicated
// during the split (DESIGN_7_1 §7). When the inline copies are finally deleted at m13 the same
// call silently starts being right about js/util/http.js instead, which is the point of the
// tie-break: this check is about the behavior, not about which of the two files holds it today.
ok(
  // 8.3.2: `e.body = j` now has spaces around the `=`. Re-anchored, not widened — still the same
  // three tokens in the same order, still inside jget's slice alone.
  textRe('e.body=j').test(sliceDef('async function jget', 'async function jpost')),
  'jget carries the response body on the thrown Error (this is what was broken)',
);

const errSrc = stripModuleSyntax(sliceDef('function kobErrHtml(e){', 'async function kobLoadAll('));
const sb3 = {
  esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]),
  kobSettingsLink: t => `<a href="#" data-kobsettings="1">${t || 'Settings'}</a>`,
};
vm.createContext(sb3);
vm.runInContext(errSrc, sb3);

for (const [code, body] of [
  ['kobold_auth', { error: 'kobold_auth', message: 'raw detail' }],
  ['kobold_unreachable', { error: 'kobold_unreachable', message: 'Connection refused', url: 'https://test-server.invalid:5001' }],
  ['unknown_config', { error: 'unknown_config', message: 'no such config' }],
]) {
  const html = sb3.kobErrHtml({ body, message: code });
  // The rendered sentence must not BE the code. (A code appearing inside a quoted detail
  // line is fine; the test is that the message isn't just the tag.)
  ok(!new RegExp(`^\\s*${code}\\s*$`).test(html.replace(/<[^>]*>/g, '').trim()), `${code} renders a sentence, not the bare tag`);
  ok(html.replace(/<[^>]*>/g, '').trim().length > 30, `${code} says something substantial`);
}
const authHtml = sb3.kobErrHtml({ body: { error: 'kobold_auth' }, message: 'kobold_auth' });
ok(/data-kobsettings/.test(authHtml), 'the auth error links straight to ⚙ Settings ▸ KoboldCpp');
ok(/admin password/i.test(authHtml), 'and names the actual cause');
// Kobold reports wrong-password, admin-off, and missing-admindir identically (`[]` with HTTP 200),
// so the UI must list only causes it can distinguish.
ok(/admin mode is off|admindir/i.test(authHtml), 'and admits the other causes it cannot rule out (Kobold reports them identically)');

const unreachHtml = sb3.kobErrHtml({
  body: { error: 'kobold_unreachable', url: 'https://test-server.invalid:5001' },
  message: 'kobold_unreachable',
});
ok(/data-kobsettings/.test(unreachHtml), 'the unreachable error links to Settings too');
ok(/test-server\.invalid:5001/.test(unreachHtml), 'and NAMES THE URL it tried');

// ── 5. the buttons must READ the state, not just fire at it ──────────────────
// With a model loaded, the status said "● Loaded" while the enabled button still offered Load,
// allowing a duplicate load request.
const buttonsSrc = stripModuleSyntax(sliceDef('function kobButtons(){', 'async function kobPoll(){'));
const els2 = {};
const mkEl2 = () => ({
  innerHTML: '',
  textContent: '',
  value: '',
  title: '',
  disabled: false,
  style: {},
  options: [],
  classList: { toggle() {}, add() {}, remove() {} },
});
const sb4 = {
  $: id => (els2[id] ||= mkEl2()),
  kob: { configs: [], status: null, loading: false, unloading: false },
};
vm.createContext(sb4);
vm.runInContext(buttonsSrc, sb4);

const sel = sb4.$('kobSel');
sel.options = [{}, {}];

// nothing loaded -> Load live, no Unload
sel.value = 'a.kcpps';
sb4.kob.status = { loaded: false };
sb4.kobButtons();
ok(els2.kobLoad.disabled === false && els2.kobLoad.textContent === 'Load', 'idle: Load is live');
ok(els2.kobUnload.style.display === 'none', 'idle: there is no Unload button to press');

// the SELECTED config is the loaded one -> Load goes quiet, Unload appears
sb4.kob.status = { loaded: true, config: 'a.kcpps' };
sb4.kobButtons();
ok(els2.kobUnload.style.display === '', 'loaded: an Unload button EXISTS (this is what was missing)');
ok(els2.kobUnload.disabled === false, 'loaded: and it is pressable');
ok(
  els2.kobLoad.disabled === true && els2.kobLoad.textContent === 'Loaded',
  'loaded: Load does not offer to re-load the model that is already in',
);
ok(/already loaded/i.test(els2.kobLoad.title), 'and says why it is disabled');

// a DIFFERENT config selected while one is loaded -> Load live again (that's a swap), Unload stays
sel.value = 'b.kcpps';
sb4.kobButtons();
ok(
  els2.kobLoad.disabled === false && els2.kobLoad.textContent === 'Load',
  'a different config selected: Load is live again — that is a swap',
);
ok(els2.kobUnload.style.display === '', 'and Unload is still there — two different things you might want');

// mid-flight: nothing is pressable, and both buttons say what is happening
sb4.kob.loading = true;
sb4.kobButtons();
ok(els2.kobLoad.disabled === true && els2.kobLoad.textContent === 'Loading…', 'mid-load: Load reports itself');
ok(els2.kobUnload.disabled === true, 'mid-load: Unload is locked out');
sb4.kob.loading = false;
sb4.kob.unloading = true;
sb4.kobButtons();
ok(els2.kobUnload.textContent === 'Unloading…', 'mid-unload: Unload reports itself');
ok(els2.kobLoad.disabled === true, 'mid-unload: Load is locked out');

// a model loaded OUTSIDE Vocalis (no config named) still offers Unload — it is holding the cards
sb4.kob.loading = false;
sb4.kob.unloading = false;
sb4.kob.status = { loaded: true, config: null, how: 'outside' };
sb4.kobButtons();
ok(els2.kobUnload.style.display === '', 'a model loaded outside Vocalis can still be unloaded');
ok(els2.kobLoad.disabled === false, 'and Load stays live, because no selected config matches it');

// ── 6. the unload confirm must not undersell what it does ───────────────────
// The design claimed the HTTP listener survives an unload; that was measured FALSE (the
// socket belongs to the model child that gets killed). A warning that undersells gets trusted.
//
// The sentence lives in kobDropWarnHtml() because m3's pre-render offer drops a model just as
// dead as the Unload button does, and two copies would drift — the copy that drifts being the
// one that gets softer. So assert it where it lives, and assert both callers pull it in.
const conf = sliceText('function kobDropWarnHtml(', "($('kobUnload')).addEventListener");
ok(/reply dies/i.test(conf), 'the confirm says an in-flight SillyTavern reply dies');
// NOT /drop/ — that matched the function NAME and passed vacuously once the text moved into it.
ok(/stops answering|connections drop/i.test(conf), 'and that the CONNECTION drops too, not just the reply');
ok(
  /can't tell whether KoboldCpp is busy|exposes no way to ask/i.test(conf),
  'and admits Vocalis cannot tell whether Kobold is busy — the modal IS the safety',
);
ok(
  /kobDropWarnHtml\(\)/.test(sliceText('function kobConfirmDrop(', "($('kobUnload')).addEventListener")),
  'the Unload/Load confirm states the consequence rather than carrying its own copy',
);

// ── 7. m3: the pre-render offer ─────────────────────────────────────────────
// Unloading kills a live chat, so "Unload and render" must remain an explicit choice beside
// "Render anyway". It must never be the default or happen automatically.
// 🔴 THIS SLICE IS THE REASON THE LOADER CAME TO THIS HARNESS (7.3-m6c). `runBook` moved to
// js/book/job.js and `main` is the page's inline block alone, so both markers went to -1 at once:
// `main.slice(-1, -1)` is '', and the six checks below all went red naming a KoboldCpp offer that
// had not changed a byte. The header of this file predicted it — "move those slices when those
// areas move" — which is not the same as noticing on the day. `sliceDef` follows both markers into
// whichever file holds them, tolerates the `export ` on runBook's line, and throws with the marker
// named if either is ever genuinely gone.
const rb = sliceDef('async function runBook(', 'function openStream(');
ok(/kobold_loaded/.test(rb), 'runBook answers the kobold_loaded 409');
ok(
  // The two prose labels are button TEXT and unaffected by the reformat; only `label:'Cancel'`
  // needed re-anchoring, because Prettier writes it `{ label: 'Cancel', value: 0 }`. Still the
  // same property on the same literal — a Cancel button renamed or dropped fails exactly as before.
  /Unload and render/.test(rb) && /Render anyway/.test(rb) && textRe("label:'Cancel'").test(rb),
  'and offers all three: unload, render anyway, cancel',
);
ok(/kobDropWarnHtml\(\)/.test(rb), 'the offer states what dropping the model costs — same sentence as the Unload button');
// The unload POST, located whitespace-elastically (8.3.2 respaced `extra.force = true`). The route
// STRING stays byte-exact: a POST to some other path is not this claim.
const unlAt = textRe("jpost('/kobold/unload'").exec(rb);
ok(!!unlAt && textRe('extra.force=true').test(rb), 'Unload and render unloads, then re-posts with force');
// The render must not proceed on a FAILED unload — that is the one outcome nobody picked.
const unl = unlAt ? rb.slice(unlAt.index) : '';
// 🔴 THE ORDERING CLAIM IS PRESERVED, NOT COLLAPSED INTO CONTAINMENT: the early `return` still has
// to come BEFORE the forced re-post. Both ends are now located whitespace-elastically, and both
// must be PRESENT — the old `indexOf(…) < indexOf(…)` answered -1 for a missing needle, and -1
// compares less than everything, so a deleted `return;` would have passed this check over nothing.
const retAt = textRe('return;').exec(unl);
const forceAt = textRe('extra.force=true').exec(unl);
ok(!!retAt && !!forceAt && retAt.index < forceAt.index, 'a failed unload stops, rather than rendering anyway');
// A book render is hours long; an 80B co-resident has never been timed against one. A
// concrete slowdown here would be a number with nothing behind it.
ok(!/\d+ ?[x×] slower|\d+ ?% slower/i.test(rb), 'the offer does not invent a slowdown figure');
// The loop, not the old single try/catch: a new narrator and a loaded Kobold are independent
// facts of one click, and the second 409 used to land in "Start failed" as a bare error code.
ok(/answered\.has\(b\.error\)/.test(rb), 'a 409 already answered is not re-posted in a loop');
ok(
  // 8.3.2 respaced this to `j.message || j.error`. Re-anchored on the same tokens in the same
  // order — the PREFERENCE is the claim, so swapping the two operands still fails.
  textRe('j.message||j.error').test(sourceOf('async function jpost')),
  'jpost throws the sentence, not the machine-readable code',
);

// ── 8. the drop-down remembers the selected config (5.1.3) ────────────────
// It didn't: pick a config, leave the tab, come back, and it had snapped to the first row —
// the select was rebuilt from /kobold/configs on every entry and only ever honored the
// server's computed default. The pick now lives in the account-local UI state, so it also
// survives a restart and follows him to another browser (5.0-M8), which is what makes this
// different from the localStorage the design rejected for `last_config` (§2a).
const configsSrc = stripModuleSyntax(sliceDef('async function kobLoadConfigs(){', 'function kobRenderDetail(){'));

const els5 = {};
const mkSel = () => ({
  innerHTML: '',
  textContent: '',
  value: '',
  title: '',
  disabled: false,
  style: {},
  options: [],
  classList: { toggle() {}, add() {}, remove() {} },
});
let body = null,
  store = {},
  writes = 0;
const sb5 = {
  $: id => (els5[id] ||= mkSel()),
  esc: s => String(s == null ? '' : s),
  jget: async () => body,
  kob: { configs: [] },
  UIS: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
      writes++;
    },
  },
  kobRenderDetail() {},
  kobButtons() {},
  kobErrHtml: e => String(e),
};
vm.createContext(sb5);
vm.runInContext(configsSrc, sb5);

const CONFIGS = [
  { name: 'a.kcpps', label: 'A' },
  { name: 'b.kcpps', label: 'B' },
];

// no pick stored -> the server's default still decides, exactly as before
body = { configs: CONFIGS, default: 'a.kcpps' };
await sb5.kobLoadConfigs();
ok(els5.kobSel.value === 'a.kcpps', 'with nothing picked yet, the server default still wins');

// a stored pick BEATS the server default — including when the default is the loaded config.
// The status box below the drop-down is what reports live truth; this control is an input.
store['vocalis-kob-cfg'] = 'b.kcpps';
await sb5.kobLoadConfigs();
ok(els5.kobSel.value === 'b.kcpps', 'a saved config survives leaving and re-entering the tab');

// gone from Kobold -> fall through, never a stuck value and never an empty select
store['vocalis-kob-cfg'] = 'deleted-long-ago.kcpps';
await sb5.kobLoadConfigs();
ok(els5.kobSel.value === 'a.kcpps', 'a renamed/deleted pick falls back to the server default');

// 🔴 Rendering must never WRITE the pick: preselecting the first row and then storing it
// would freeze day one's default in place and make it indistinguishable from a real choice.
ok(writes === 0, 'rendering the drop-down never writes a pick — only a human choosing one does');

const chg = sliceText("($('kobSel')).addEventListener('change'", 'function kobButtons(){');
ok(/UIS\.setItem\('vocalis-kob-cfg'/.test(chg), 'choosing a row persists it (server-side, so a restart keeps it)');

// ── 9. 9.3: the ticked-cards warning ────────────────────────────────────────
// Warn when a local model load would use CUDA devices already selected for speech processing.
//
// The Python tests assert the two FACTS the route sends (which cards are ticked, and whether the
// setting is on). What none of them can see is the policy the browser applies to them: that the
// setting off means silent, that a remote KoboldCpp is silent, and that the dialog NAMES the
// cards rather than saying "some cards are in use" — which is a sentence you can only act on by
// going and looking.
const warnSrc = stripModuleSyntax(sliceText('function kobGpuWarnHtml(){', 'async function kobConfirmGpus('));
const sb6 = { kob: { status: null }, esc: s => String(s == null ? '' : s) };
vm.createContext(sb6);
vm.runInContext(warnSrc, sb6);

ok(sb6.kobGpuWarnHtml() === '', 'before the first poll there is nothing to warn about');
// A REMOTE KoboldCpp: the route sends neither field, because its model lands on hardware these
// cards are not part of. Same gate as the pre-render conflict, and the same reason.
sb6.kob.status = { local: false, loaded: false, vram_measurable: false };
ok(sb6.kobGpuWarnHtml() === '', "a remote KoboldCpp never warns about this box's cards");
sb6.kob.status = { warn_gpus: false, vocalis_gpus: [{ id: 'cuda:0', label: 'RTX 4090' }] };
ok(sb6.kobGpuWarnHtml() === '', 'the setting off is silent even with a card ticked');
sb6.kob.status = { warn_gpus: true, vocalis_gpus: [] };
ok(sb6.kobGpuWarnHtml() === '', 'nothing ticked is silent — which is the state the warning is FOR');

sb6.kob.status = {
  warn_gpus: true,
  vocalis_gpus: [
    { id: 'cuda:0', label: 'RTX 4090' },
    { id: 'cuda:1', label: 'R9700' },
  ],
};
const warnHtml = sb6.kobGpuWarnHtml();
ok(/cuda:0/.test(warnHtml) && /cuda:1/.test(warnHtml), 'it names the card IDS — the rows to untick');
ok(/RTX 4090/.test(warnHtml) && /R9700/.test(warnHtml), 'and their labels, so you know which card it is');
ok(/2 cards/.test(warnHtml), 'and counts them');
ok(/Devices/.test(warnHtml), 'and says WHERE to untick them, not just that something is wrong');
ok(/KoboldCpp/.test(warnHtml), 'and names the other tenant');
// One card must not read "1 cards".
sb6.kob.status = { warn_gpus: true, vocalis_gpus: [{ id: 'cuda:0', label: 'RTX 4090' }] };
ok(/a card ticked/.test(sb6.kobGpuWarnHtml()), 'one card reads as "a card", never "1 cards"');

// 🔴 CANCEL IS THE FIRST ACTION, IN BOTH DIALOGS. `modal()` resolves `actions[0].value` on Esc AND
// on a backdrop click, so with Continue first, Esc on "Unload the model and free the cards?"
// RESOLVED 1 and dropped the model — the destructive default on the key everyone presses to back
// out. This is the check that keeps the order from drifting back.
const dropActs = sliceText('function kobConfirmDrop(', 'function kobGpuWarnHtml(');
ok(
  /label:'Cancel'/.test(dropActs.replace(/\s+/g, '')) &&
    dropActs.replace(/\s+/g, '').indexOf("label:'Cancel'") < dropActs.replace(/\s+/g, '').indexOf("label:'Continue'"),
  'the drop confirm lists Cancel FIRST — Esc and the backdrop resolve actions[0]',
);
const gpuActs = sliceText('async function kobConfirmGpus(', "($('kobUnload')).addEventListener");
const gpuFlat = gpuActs.replace(/\s+/g, '');
ok(
  gpuFlat.indexOf("label:'Cancel'") >= 0 && gpuFlat.indexOf("label:'Cancel'") < gpuFlat.indexOf("label:'Loadanyway'"),
  'and so does the ticked-cards dialog',
);
ok(/kobOpenDevices\(\)/.test(gpuActs), 'which offers to OPEN the Devices panel — a link in the body would open it behind the modal');

// The Load button folds the warning into the swap confirm rather than opening a second modal
// behind it: two dialogs for one click is a nag, and the second one gets dismissed unread.
const loadHandler = sliceText("($('kobLoad')).addEventListener", 'export function kobDropWarnHtml(');
ok(/kobGpuWarnHtml\(\)/.test(loadHandler), 'Load asks the ticked-cards question before it posts');
ok(/kobConfirmDrop\([\s\S]*gpus/.test(loadHandler), 'and passes it INTO the swap confirm — one dialog, not two');
ok(/kobConfirmGpus\(gpus\)/.test(loadHandler), 'and shows it on its own when there is no model to drop');
// 📌 The POST must still be reachable: a warning that returned early unconditionally would pass
// every check above while making the button dead.
ok(/jpost\('\/kobold\/load'/.test(loadHandler), 'and the load itself still happens');

// ── 9b. 9.5.9: ONE checkbox, both directions ────────────────────────────────
// One warning setting covers both directions: enabling a speech device while an LLM is loaded,
// and loading an LLM while a speech device is enabled.
//
// 🔴 THE CLAIM IS THAT THE SECOND SWITCH IS GONE, AND IT IS A JOIN, so asserting one half of it
// passes on a half-done change. The panel must not paint a control; the module must not save a
// per-engine key; and the ONE box that survives must SAY it covers both directions. Drop only the
// markup and `kobRenderSettings` still reaches for an element that no longer exists, which is a
// TypeError on every settings load — in a renderer whose other job is painting the password state.
sandbox.kobRenderSettings({ kobold_url: '', kobold_adminpassword_set: false });
ok(els.kobWarnGpus === undefined, 'kobRenderSettings no longer reaches for a per-engine warn box');
ok(!/kobold_warn_gpus/.test(kobjs), 'and the module never saves a per-engine warn key — one switch, or the two disagree');
ok(!/<input[^>]*id="kobWarnGpus"/.test(html), 'the KoboldCpp panel has no warn checkbox of its own any more');
ok(!/<input[^>]*id="llaWarnGpus"/.test(html), 'and neither does the llama.cpp one');

// The survivor, and what it has to say for itself. A box relabeled for one direction while
// governing two is the control-reporting-the-opposite-of-the-app failure in slow motion.
const devBox = (html.match(/<input[^>]*id="devWarnLlm"[^>]*>/) || [''])[0];
ok(!!devBox, 'the one warning checkbox is #devWarnLlm, under ⚙ Settings ▸ Devices');
ok(/checked/.test(devBox), 'and ships ticked, so the warning exists before anyone goes looking for it');
const devLabel = (html.match(/<label[^>]*>\s*<input[^>]*id="devWarnLlm"[\s\S]*?<\/label>/) || [''])[0];
ok(/enable a device/i.test(devLabel), 'its label still names the tick-a-card direction');
ok(/load an LLM model/i.test(devLabel), '…and now the load-a-model direction too, which is what it gained at 9.5.9');

// And the KoboldCpp section still says where its control went. A panel that quietly loses a
// checkbox reads as a feature that was removed, which is the opposite of what happened.
const kobPanel = html.slice(html.indexOf('id="kobTestResult"'), html.indexOf('id="kobTestResult"') + 2000);
ok(/Warn me if I enable a device/.test(kobPanel), 'the KoboldCpp section names the box that governs it now');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);

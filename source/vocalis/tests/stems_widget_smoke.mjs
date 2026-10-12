// Vocalis 4.0-M4 — the stem widget, driven by tests/test_stems_ui.py.
//
// index.html has no build step, so a syntax error anywhere in its inline script kills
// the ENTIRE web UI at parse time and nothing on the Python side would notice. Check 1
// below is therefore the important one: parse the real script block, every time.
//
// Then the widget itself (§7). Its load-bearing rule comes straight from §7h — "a
// brand-new element has no previous width, so it has nothing to animate from"; anything
// that repaints must be built once and UPDATED IN PLACE. For the stem widget that means
// a pill click re-points the existing <audio> rather than re-rendering the row, because
// a rebuilt <audio> loses its playback position and restarts. So we assert the shape
// that makes that possible: ONE player per set, with a stable id, and pills that address
// it by that id instead of triggering a re-render.
//
// No npm dependencies (the st_player_smoke.mjs convention): the pure render helpers are
// sliced out of the real file and run against tiny stubs.
//
// Usage: node stems_widget_smoke.mjs <path-to-index.html>
// Exit 0 = all checks passed.
import vm from 'node:vm';
import { loadWebSources, sliceDef, stripModuleSyntax } from './_websrc.mjs';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node stems_widget_smoke.mjs <index.html>');
  process.exit(2);
}

// 🔴 CONVERTED TO _websrc.mjs IN 7.3-m4m, AND IT DID NOT DEGRADE GRACEFULLY BEFORE.
// This harness sliced `const stemW={};` → `const vs={songs:` out of the inline block. m4m moved
// the first marker into js/media/stemwidget.js, so `indexOf` answered -1, `main.slice(-1, to)`
// handed `vm` garbage, and `sandbox.stemPills` came back undefined — an uncaught TypeError that
// took the ~20 checks below with it. `sliceDef` crosses into the module instead, and throws with
// the marker named when it genuinely cannot find one. §3.5, §7.1.
const { html, main, files } = await loadWebSources(htmlPath);
let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

// ── 1. the whole inline script must PARSE ────────────────────────────────────
// 🔴 THIS IS THE SUITE'S ONLY WHOLE-JS SYNTAX CHECK OVER THE INLINE BLOCK (§7). index.html has no
// build step, so a syntax error anywhere in it kills the entire web UI at parse time and nothing
// on the Python side would notice. `loadWebSources` picks the longest block — see its own note on
// why "longest" and not "last" — so the block selection that used to live here is gone, but the
// parse itself must stay exactly where it is.
ok(html.length > 20000, `the page loaded (${html.length} chars)`);
// ✅ 7.3-m13: `main` IS THE MODULE TREE NOW, NOT AN INLINE BLOCK. This asserted
// `main.length > 20000` — "the main script block is the big one" — which was a guard against
// `loadWebSources` picking a pre-paint stub. m13 deleted the inline application script, so the
// biggest thing in the page is a 780-character pre-paint block and the check went red saying so.
// 🔴 The property it was really protecting is that the CORPUS is the whole front end, and that is
// now a question about the module tree rather than about one block — so ask it there.
// 🔴 DOCKER TREE: THE 500-CHARACTER FLOOR ON `main` WAS TUNED TO THE LEGACY PRE-PAINT BLOCK (780
// chars) and failed here at 321 — the Docker page's theme-restore block is simply shorter, and
// `main` is only that block. The comment above already says the property is about the CORPUS, so
// the floor is applied to the module tree (`files`, every js/ module) where it can actually fail
// if the front end stops loading. `main` is still asserted non-empty because it is what gets parsed
// below.
const corpusChars = files.filter(f => f.label.startsWith('js/')).reduce((n, f) => n + f.text.length, 0);
ok(main.length > 0, `the page's inline pre-paint block loaded (${main.length} chars)`);
ok(corpusChars > 20000, `the module tree loaded (${corpusChars} chars)`);
try {
  new vm.Script(main, { filename: 'index.html#script' });
  ok(true, 'the whole UI script parses');
} catch (e) {
  ok(false, `the whole UI script parses — ${e.message}`);
  process.exit(1); // nothing below can mean anything if it doesn't
}

// ── 2. the widget's render helpers, against stubs ────────────────────────────
// Slice from the widget's state out to the end of stemPills(): these are pure string
// builders, so they run with no DOM at all.
// 🔴 DOCKER TREE: THE END MARKER IS GONE, ON PURPOSE. This used to end at `const vs={songs:`
// (Voice Swap's state, which sat right after the widget in the legacy page). Voice Swap execution
// is not part of this product, so that marker no longer exists anywhere and `sliceDef` correctly
// refused to guess ("end definition marker not found"). With the end marker omitted the slice runs
// to the end of `js/media/stemwidget.js`, which is now exactly the widget (`stemW`, `stemWidgetHTML`,
// `STEM_MODE`, `stemBadges`, `stemPills`) and nothing else — the Voice-Swap strip helpers that used
// to ride along are not in this file any more, so the `vs` and `logInto` stubs they needed are gone.
const widget = stripModuleSyntax(sliceDef('const stemW={};'));

const sandbox = {
  esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  fmtSize: n => `${n}B`,
  fmtDur: n => `${n}s`,
  fmtDate: n => `${n}`,
  document: { addEventListener() {} }, // the delegated click handler binds here
  $: () => null,
};
vm.createContext(sandbox);
vm.runInContext(widget, sandbox);

const set = {
  ref: 'Sample_Track_One_6bb06561',
  song: 'Sample Track One',
  source: 'demucs',
  mode: '4stem',
  duration_s: 225.6,
  size: 1234,
  created_ts: 0,
  swappable: true,
  swaps: 2,
  stems: [
    { file: 'instrumental.wav', label: 'Instrumental', size: 40 },
    { file: 'vocals.wav', label: 'Vocals', size: 30 },
    { file: 'drums.wav', label: 'Drums', size: 20 },
    { file: 'bass.wav', label: 'Bass', size: 10 },
    { file: 'other.wav', label: 'Other', size: 5 },
  ],
};

const pills = sandbox.stemPills(set);
ok(pills.length === 5, 'a 4-stem set renders 5 pills — the 2-stem base plus the parts');
ok(pills[0].label === 'Instrumental', 'the instrumental leads: it is the stem a swap borrows');
ok(pills[1].url === '/stems/library/Sample_Track_One_6bb06561/vocals.wav/audio', 'a pill points at its stem audio route');
ok(pills[1].dl.endsWith('?download=1'), 'and carries its own download URL');

const badges = sandbox.stemBadges(set);
ok(badges.some(b => b.text === '4-stem') && badges.some(b => b.text === 'split'), 'a Demucs set is badged by mode and provenance');
ok(
  sandbox.stemBadges({ ...set, source: 'uploaded' }).some(b => b.text === 'uploaded'),
  'an uploaded set says so — you want to know which is which (§7)',
);

const out = sandbox.stemWidgetHTML({
  title: set.song,
  badges,
  pills,
  meta: '225.6s · 5 stems',
  zip: `/stems/library/${set.ref}/zip`,
  acts: '<button class="sm danger" data-ssdel="x">✕</button>',
});

// THE invariant: one player, addressed by id, never rebuilt by a pill click.
const players = out.match(/<audio\b/g) || [];
ok(players.length === 1, `ONE player for the whole set, not one per stem (got ${players.length})`);
const id = (out.match(/data-swset="(sw\d+)"/) || [])[1];
ok(!!id, 'the set carries a widget id');
ok(out.includes(`id="${id}a"`), 'the player has a STABLE id derived from it…');
ok(
  (out.match(new RegExp(`data-sw="${id}"`, 'g')) || []).length === 5,
  '…and every pill addresses that same player by id (so a click re-points, not rebuilds)',
);
// (`const stemW` is lexical, not a property of the sandbox global — read it back
// through the context rather than off the object.)
const registry = vm.runInContext('stemW', sandbox);
ok(registry[id] === pills, 'the pills are registered for the delegated click handler');

ok(out.includes('class="pill on"'), 'the first pill starts selected — no silent player');
ok(out.includes('src="/stems/library/Sample_Track_One_6bb06561/instrumental.wav/audio"'), 'and the player starts on it');
ok(out.includes(`id="${id}d"`) && out.includes('⬇ All'), 'download-follows-selection, plus ⬇ All to zip the set');
ok(out.includes('href="/stems/library/Sample_Track_One_6bb06561/zip"'), 'the zip link is wired');
ok(!out.includes('class="stemset open"'), 'sets are COLLAPSED by default (§7)');
ok(sandbox.stemWidgetHTML({ title: 'x', pills, open: true }).includes('stemset open'), '…but the one you just made opens');

// Two widgets on one page must not fight over the same element ids.
const a = sandbox.stemWidgetHTML({ title: 'A', pills });
const b = sandbox.stemWidgetHTML({ title: 'B', pills });
const idA = (a.match(/data-swset="(sw\d+)"/) || [])[1];
const idB = (b.match(/data-swset="(sw\d+)"/) || [])[1];
ok(idA !== idB, 'each widget gets its own id — a library of sets is independent players');

// A set with no vocal is renderable (it is storable and downloadable, just not
// swappable — §5). It must not blow up on the missing stem.
const lone = { ...set, stems: [{ file: 'instrumental.wav', label: 'Instrumental', size: 40 }] };
const lonePills = sandbox.stemPills(lone);
ok(
  lonePills.length === 1 && sandbox.stemWidgetHTML({ title: 'x', pills: lonePills }).includes('Instrumental'),
  'a lone instrumental still renders — storable, just not swappable',
);

// An EMPTY pill list (a swap group whose instrumental was deleted and whose swaps
// predate the dry-vocal store) must degrade rather than emit a broken player.
const empty = sandbox.stemWidgetHTML({ title: 'x', pills: [] });
ok(empty.includes('<audio') && !empty.includes('undefined'), 'an empty set renders without leaking "undefined" into the markup');

// 🔴 8.6.1 — The same key must produce identical markup on every render. `ui/reconcile.js`
// replaces a row when its HTML differs; unstable element ids would therefore replace the row on
// every pass and interrupt playback or close its expanded details.
const k1 = sandbox.stemWidgetHTML({ title: 'A', pills, key: 'set-one' });
const k2 = sandbox.stemWidgetHTML({ title: 'A', pills, key: 'set-one' });
ok(k1 === k2, 'the same key renders byte-identical markup — reconcile can leave the row alone');
const k3 = sandbox.stemWidgetHTML({ title: 'A', pills, key: 'set-two' });
ok(k3 !== k1, '...and a different key does not share a widget id with it');
ok(k1.includes('data-setkey="set-one"'), 'the row carries its key, which is what reconcile matches on');

// ── 8.9 — the folder overlay's two options ──────────────────────────
//
// 🔴 THE `tag` OPTION EXISTS BECAUSE `#ssLib` IS A RECONCILED HOST. `ui/reconcile.js` removes any
// child that carries neither its key attribute nor `data-keep`, so appending the `in <folder>`
// tag AFTER the widget — as `swaplib.js` legitimately does, because it does not reconcile —
// would put a bare `<span>` in that host and the next pass would delete it. Silently, and only
// when a filter is set, which is the one state nobody re-checks. It has to be INSIDE the row.
const tagged = sandbox.stemWidgetHTML({ title: 'A', pills, key: 'set-one', tag: '<span class="vftag">Sample Folder</span>' });
ok(tagged.includes('vftag'), 'the folder tag renders');
ok(
  tagged.indexOf('vftag') < tagged.lastIndexOf('</div>'),
  '🔴 …INSIDE the row, not after it — a sibling of a reconciled row is deleted on the next pass',
);
ok(!sandbox.stemWidgetHTML({ title: 'A', pills, key: 'set-one' }).includes('vftag'), 'and nothing is emitted without one');

// The drag handle goes on the ROOT rather than on a wrapper: the same element has to carry
// `data-setkey` for reconcile AND `data-vrow` for `folderWireDrag`, and an extra level would
// either hide the key from reconcile or duplicate it.
const drg = sandbox.stemWidgetHTML({ title: 'A', pills, key: 'set-one', drag: 'a_song_ab12cd34' });
ok(drg.includes('data-vrow="a_song_ab12cd34"'), 'the row drags as its ref');
ok(drg.includes('draggable="true"'), '...and is actually draggable — `data-vrow` alone does nothing');
ok(
  drg.indexOf('data-vrow') < drg.indexOf('>'),
  '🔴 both on the ROOT element, the same one reconcile keys on — a wrapper would hide `data-setkey`',
);
ok(!k1.includes('data-vrow'), 'a panel with no folder overlay wired gets neither attribute');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);

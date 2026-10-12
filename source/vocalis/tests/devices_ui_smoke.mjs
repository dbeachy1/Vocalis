// Vocalis 5.3-m3 — the ⚙ Settings device rows, driven by tests/test_devices_ui.py.
//
// test_devices_route.py talks to the ROUTE. Nothing there would notice that the worker control
// came back as a drop-down, that a sleeping satellite's rows render DISABLED (so a satellite
// could only ever be configured while it was running), or that a row carries `cuda:0` instead of
// the full `test-satellite:cuda:0` — and that last one is the load-bearing name the whole remote-worker
// branch turns on. So the real helpers get sliced out of the real index.html and exercised.
//
// No npm dependencies (the kobold_ui_smoke.mjs / stems_widget_smoke.mjs convention).
//
// Usage: node devices_ui_smoke.mjs <path-to-index.html>
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { defRe, loadWebSources, readPage, sliceDef, stripModuleSyntax } from './_websrc.mjs';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node devices_ui_smoke.mjs <index.html>');
  process.exit(2);
}

// Normalized to LF — see the note in voices_ui_smoke.mjs. A CRLF checkout silently zeroes out
// newline-anchored regexes, and every check below reads as passing.
// The page AS SERVED: index.html with its stylesheets inlined. Every CSS assertion
// below depends on that - those rules left this file for src/webui/css/ at 7.3.19.
const html = await readPage(htmlPath);
// The JS corpus — the page's inline script plus every module beside it — so the slice below can be
// taken by MARKER rather than by `indexOf`. `readPage` above stays: its subject is the served page's
// CSS, which this bundle deliberately does not reassemble.
await loadWebSources(htmlPath);
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
const inlineApp = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

// 🔴 7.3-m4: EVERY HELPER THIS FILE SLICES NOW LIVES IN js/sys/devices.js. Rather than repointing
// each slice at a second variable, the module is APPENDED to the app source — "the application's
// script" is the inline block plus the modules it has been split into, and that is what these
// slices have always meant. Each `indexOf` below then finds its target wherever it currently is,
// and keeps working when the next milestone moves more of it.
//
// ⚠️ THE ONE WAY THIS GOES WRONG: a needle that exists in BOTH halves resolves to the inline one,
// because that half comes first. Checked for every needle in this file — devs, loadVoices, satRow,
// renderSats, satRemove, satRotate and satUploadCert appear only in the module now. If you add a
// slice for a name index.html still defines (`$`, `esc`, `jget`), anchor it explicitly instead.
//
// 🔴 `export ` IS STRIPPED, and it is not cosmetic: vm.runInContext() is not a module context, so
// one leaked keyword is `SyntaxError: Unexpected token 'export'` and every check after it never
// runs. A slice's START needle is safe by itself, but its END needle is not — an `indexOf` landing
// on an exported declaration sits PAST the `export `, keeping those seven characters as the
// slice's tail. That is exactly how kobold_ui_smoke.mjs broke in this same commit.
const devPath = join(dirname(htmlPath), 'js', 'sys', 'devices.js');
const devjs = (await readFile(devPath, 'utf8')).replace(/\r\n/g, '\n').replace(/^export /gm, '');
const main = inlineApp + '\n' + devjs;
// ⚠️ 8.3.2 RE-ANCHOR, NOT A WIDENING. The claim is unchanged — devices.js is the file that declares
// the three-bucket `devs` state — but 8.3.2 reformatted the module, so the dense literal this used
// to `includes()` is now `export const devs = { rows: [], sats: [], subs: [] };`. `defRe` builds a
// regex over the SAME tokens with the whitespace between them elastic and a column-0 anchor, so a
// renamed or emptied bucket still fails here; only respacing stopped mattering.
ok(defRe('const devs={rows:[],sats:[],subs:[]};').test(devjs), `read the devices module at ${devPath}`);

// ── 1. markup facts no render helper can show ────────────────────────────────
ok(/<div id="devList"/.test(html), 'the Devices panel has a #devList host');
ok(!/id="gpuList"/.test(html), 'the old single GPU checkbox list is gone');
ok(!/id="workers"/.test(html), 'and the old one-size-fits-all "Workers per card" box is gone');

// The .off rule is the sleeping-satellite contract expressed in CSS: dimmed, never removed.
ok(/\.dev\.off\{opacity:/.test(html), 'an unreachable satellite row is DIMMED by CSS (.dev.off)');
ok(!/\.dev\.off\{[^}]*display:none/.test(html), 'and never display:none — a card that vanishes is a UI that lies');

// Keep the label from stretching across the panel; alignDevCols sets its width from the widest
// label so the worker control stays beside the device it configures.
ok(!/\.dev \.dlab\{[^}]*flex:1[;}]/.test(html), 'the device label does not stretch to fill the row');
ok(/\.dev \.dlab\{[^}]*var\(--dlabw/.test(html), 'its width comes from the measured --dlabw column');

// ── 2. the helpers, run for real ─────────────────────────────────────────────
// 🔴 8.3.2: THE SAME TWO MARKERS, BY DEFINITION RATHER THAN BY `indexOf`. This was
// `main.indexOf('const devs={rows:[],sats:[],subs:[]};')` and `main.indexOf('async function
// loadVoices(){')`, guarded by `ok(from > 0 && to > from, 'located the device helpers…')`. Prettier
// respaced both declarations, so both `indexOf`es answered -1 and `main.slice(-1, -1)` handed the vm
// one character of garbage — every check below then failed for a reason none of them could name.
// `sliceDef` names the identical pair of definitions with the whitespace between their tokens made
// elastic (and a column-0 anchor, so a comment quoting one cannot be mistaken for it), and it THROWS
// with the missing marker in the message. The located-it precondition is therefore gone rather than
// relaxed — _websrc.mjs's "CONVERTING A HARNESS" note says to drop it, because the throw is a
// strictly louder version of the same failure. `stripModuleSyntax` because the slice now arrives
// with its `export ` keywords intact, and vm.runInContext compiles a classic script.
const devSrc = stripModuleSyntax(sliceDef('const devs={rows:[],sats:[],subs:[]};', 'async function loadVoices(){'));

const els = {};
// `style` carries the two CSSStyleDeclaration methods alignDevCols() uses, and querySelectorAll
// returns a list rather than being absent: a fake that answers less than the DOM does turns a
// render helper's ordinary call into a TypeError, which reads as a broken helper.
const mkEl = () => ({
  innerHTML: '',
  textContent: '',
  value: '',
  dataset: {},
  style: { removeProperty() {}, setProperty() {} },
  classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
  addEventListener() {},
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
});
const posts = [];
const modals = [];
const sandbox = {
  $: id => (els[id] ||= mkEl()),
  esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]),
  jget: async () => {
    throw new Error('not used');
  },
  loadEnhanceInfo: async () => {},
  fetch: (url, opt) => {
    posts.push({ url, body: JSON.parse(opt.body) });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  },
  modal: async (...args) => {
    modals.push(args);
    return sandbox.__modalAnswer;
  },
  document: {
    querySelectorAll: selector => (selector === '#devList .dev' ? sandbox.__rows || [] : []),
  },
  // 🔴 REQUIRED, and its absence was invisible. `saveDevices` defers a repaint through
  // `setTimeout` on exactly one path — when the CPU-fallback banner has to appear or
  // disappear — and that path is reached only when the previous render left every row
  // unticked. `saveDevices` is `async`, so a ReferenceError there is not a crash: it becomes a
  // rejected promise nobody awaits, the function abandons before its `fetch`, and the payload
  // checks below report "no PUT happened" with no hint as to why. Recorded rather than run:
  // firing renderDevices here would repaint over the very html a later check reads.
  setTimeout: fn => {
    (sandbox.__deferred ||= []).push(fn);
    return 0;
  },
};
vm.createContext(sandbox);
// `devs` is a top-level `const`, which lands in the script's lexical scope rather than on the
// context object — so hand it out explicitly instead of reaching for sandbox.devs (undefined).
vm.runInContext(devSrc + '\n;this.devs=devs;', sandbox);

// ── 3. a device row is a TICK and nothing else ───────────────────────────────
// The row intentionally has no worker-count control. Per-device worker input did not improve
// throughput and the server no longer honors that field, so the test also guards against clients
// sending it again.
sandbox.devs.rows = [{ id: 'cuda:0', label: 'Card A', satellite: null, reachable: true, enabled: true }];
sandbox.devs.sats = [];
sandbox.renderDevices();
const one = els.devList.innerHTML;
ok(!/class="wk"/.test(one), 'there is NO worker input on the row');
ok(!/<select/.test(one), 'and no drop-down either — a device row is a checkbox and a label');
ok(/class="devchk"/.test(one), 'the tick is what a row is for');

// ── 4. local cards ───────────────────────────────────────────────────────────
sandbox.devs.rows = [
  { id: 'cuda:0', label: 'Card A', satellite: null, reachable: true, enabled: true },
  { id: 'cuda:1', label: 'Card B', satellite: null, reachable: true, enabled: false },
];
sandbox.renderDevices();
const two = els.devList.innerHTML;
ok(/data-id="cuda:0"/.test(two) && /data-id="cuda:1"/.test(two), 'both local cards render a row');
ok((two.match(/checked/g) || []).length === 1, 'exactly the ENABLED card is ticked');

// ── 5. a sleeping satellite: grayed, present, and still editable ─────────────
sandbox.devs.rows.push({
  id: 'test-satellite:cuda:0',
  label: 'cuda:0',
  satellite: 'test-satellite',
  reachable: false,
  enabled: true,
});
sandbox.devs.sats = [{ name: 'test-satellite', url: 'https://test-satellite.invalid:7880', reachable: false }];
sandbox.renderDevices();
const sleeping = els.devList.innerHTML;
ok(
  /data-id="test-satellite:cuda:0"/.test(sleeping),
  '🔴 the row carries the FULL satellite device id — `cuda:0` here would send a remote worker down the local-VRAM path',
);
ok(/class="gpu dev off"/.test(sleeping), 'the sleeping row is dimmed');
const satRow = sleeping.slice(sleeping.indexOf('data-id="test-satellite:cuda:0"'));
ok(
  !/disabled/.test(satRow.slice(0, 400)),
  'but its controls remain enabled while the satellite is stopped, so it can be configured before startup',
);
ok(/not running/.test(sleeping), 'and the panel says so rather than showing it as absent');
ok(/test-satellite\.invalid:7880/.test(sleeping), 'the satellite group names the machine it is talking about');

// A satellite never yet reached knows no cards. Say that, rather than rendering an empty group
// that reads as "this machine has zero cards".
sandbox.devs.rows = sandbox.devs.rows.filter(d => !d.satellite);
sandbox.renderDevices();
ok(
  /appear here once it has been reached/.test(els.devList.innerHTML),
  'a never-reached satellite explains itself instead of rendering an empty group',
);

// ── 5b. the per-subsystem ticks (7.6 §4.4) ───────────────────────────────────
// The registry comes from the SERVER — devices.js must not hold a second copy of a tab name,
// or the panel goes on naming a button that has been renamed.
sandbox.devs.subs = [
  { key: 'render', label: 'Playground · Book · Bulk · Nomi · SillyTavern', hint: 'speech' },
  { key: 'voicecreate', label: 'Voices → Create a voice', hint: 'VoxCPM2' },
  { key: 'training', label: 'Voice Studio → Voice Training', hint: 'RVC' },
];
sandbox.devs.rows = [
  {
    id: 'cuda:0',
    label: 'Card A',
    satellite: null,
    reachable: true,
    enabled: true,
    capable: ['render', 'voicecreate', 'training'],
    uses: { training: false },
  },
  {
    id: 'test-satellite:cuda:0',
    label: 'cuda:0',
    satellite: 'test-satellite',
    reachable: true,
    enabled: true,
    capable: ['render'],
    uses: {},
  },
];
sandbox.devs.sats = [{ name: 'test-satellite', url: 'https://test-satellite.invalid:7880', reachable: true }];
sandbox.renderDevices();
const uses = els.devList.innerHTML;
ok(/class="devuses"/.test(uses), 'a ticked card grows an indented per-subsystem list');
ok(/data-sub="training"/.test(uses), 'and the list is built from the registry the server sent');

// 🔴 CAPABILITY, NOT AUTHORIZATION. A satellite is a Chatterbox render box — it cannot run
// VoxCPM2 or RVC at all, so those boxes must be ABSENT, not present-and-unticked. An unticked
// box says "you could, but I said no", which is the UI promising what the server cannot keep.
const satBlock = uses.slice(uses.indexOf('data-id="test-satellite:cuda:0"'));
ok(/data-sub="render"/.test(satBlock), 'the satellite row offers the one thing it can do');
ok(
  !/data-sub="voicecreate"/.test(satBlock) && !/data-sub="training"/.test(satBlock),
  '🔴 and offers NOTHING it cannot do — absent, never a dead unticked box',
);

// 🔴 ABSENT MEANS CHECKED. Every config written before 7.6 has no `uses` map, so every box must
// arrive ticked; reading it as `=== true` would switch every subsystem off on every install.
const cardBlock = uses.slice(uses.indexOf('data-id="cuda:0"'), uses.indexOf('data-id="test-satellite:cuda:0"'));
ok(/data-sub="render"[^>]*checked/.test(cardBlock), 'a subsystem with no saved entry is ticked');
ok(!/data-sub="training"[^>]*checked/.test(cardBlock), 'and an explicit false is not');

// An unticked CARD is out entirely, so narrowing it further is a control over nothing.
sandbox.devs.rows = [
  {
    id: 'cuda:0',
    label: 'Card A',
    satellite: null,
    reachable: true,
    enabled: false,
    capable: ['render'],
    uses: {},
  },
];
sandbox.devs.sats = [];
sandbox.renderDevices();
ok(
  /class="devuses" hidden/.test(els.devList.innerHTML),
  'an unticked card hides its sub-list rather than offering ticks that mean nothing',
);

// ── 6. the save payload ──────────────────────────────────────────────────────
// 7.6: the row's per-subsystem ticks live in a `.devuses` block that is a SIBLING of `.dev`
// inside `.devwrap`, so the fake has to answer `closest` as the DOM would. A fake that answers
// less than the DOM does turns an ordinary call into a TypeError, which reads as a broken helper.
const fakeRow = (id, enabled, uses = {}) => ({
  dataset: { id },
  querySelector: sel => (sel === '.devchk' ? { checked: enabled } : null),
  closest: sel =>
    sel === '.devwrap'
      ? {
          querySelectorAll: () =>
            Object.entries(uses).map(([sub, checked]) => ({
              dataset: { sub },
              checked,
            })),
        }
      : null,
});
sandbox.__rows = [fakeRow('cuda:0', true, { render: true, training: false }), fakeRow('test-satellite:cuda:0', false, { render: true })];
sandbox.saveDevices();
ok(posts.length === 1 && posts[0].url === '/devices', 'a change PUTs to /devices');
ok(
  JSON.stringify(posts[0].body) ===
    JSON.stringify({
      devices: [
        { id: 'cuda:0', enabled: true, uses: { render: true, training: false } },
        { id: 'test-satellite:cuda:0', enabled: false, uses: { render: true } },
      ],
    }),
  'every row goes in the payload — enabled and disabled alike, so an unticked row is an explicit 0',
);

// 🔴 And NOTHING else goes in it. `querySelector` returns null for anything but the tick
// above, so a payload still reaching for `.wk` would throw here rather than quietly shipping a
// field the route ignores.
ok(
  posts[0].body.devices.every(d => Object.keys(d).join() === 'id,enabled,uses'),
  'a row carries its id, its tick and its per-subsystem map, and no dead worker field',
);

// 🔴 A row whose sub-list is absent must send an EMPTY map, never a set of falses. That is what
// a pre-7.6 browser tab looks like, and "absent means allowed" only survives if the client
// declines to invent denials the user never clicked.
posts.length = 0;
sandbox.__rows = [
  {
    dataset: { id: 'cuda:0' },
    querySelector: sel => (sel === '.devchk' ? { checked: true } : null),
    closest: () => null,
  },
];
sandbox.saveDevices();
ok(JSON.stringify(posts[0].body.devices[0].uses) === '{}', 'a row with no sub-list narrows nothing rather than denying everything');

// An empty list must never be POSTed: it would wipe every device setting on the box.
posts.length = 0;
sandbox.__rows = [];
sandbox.saveDevices();
ok(posts.length === 0, 'an empty row set saves NOTHING rather than wiping the configuration');

// Revoking ACE authorization is confirmed before the settings write. Cancel reloads the server
// state and sends no PUT; confirming sends the same settings through the existing route.
const revokingRow = () => fakeRow('cuda:0', false, { acestep: true });
sandbox.devs.rows = [{ id: 'cuda:0', enabled: true, uses: { acestep: true } }];
sandbox.__rows = [revokingRow()];
sandbox.__modalAnswer = 0;
posts.length = 0;
modals.length = 0;
await sandbox.saveDevices();
ok(
  modals.length === 1 && modals[0][0] === 'Stop ACE-Step on these cards?' && /render already submitted/.test(modals[0][1]),
  'revoking ACE asks before saving and explains the active-render effect',
);
ok(posts.length === 0, 'canceling the revocation confirmation sends no settings PUT');

sandbox.__modalAnswer = 1;
modals.length = 0;
await sandbox.saveDevices();
ok(posts.length === 1 && posts[0].url === '/devices', 'confirming the revocation submits the existing device settings');

// October 10, 2026 — a satellite's card renders Chatterbox speech and nothing else, so unticking it
// has no ACE-Step to stop. An absent `uses.acestep` reads as "allowed", which used to count as a
// revocation and raised the dialog for every satellite card. The rows below are shaped like the
// server's /devices payload: `capable` is what the card can run at all.
const aceAsked = () => modals.some(m => m[0] === 'Stop ACE-Step on these cards?');
sandbox.devs.rows = [{ id: 'test-satellite:cuda:0', satellite: 'test-satellite', enabled: true, uses: {}, capable: ['render', 'stems'] }];
sandbox.__rows = [fakeRow('test-satellite:cuda:0', false, { render: true })];
sandbox.__modalAnswer = 0;
posts.length = 0;
modals.length = 0;
await sandbox.saveDevices();
ok(!aceAsked(), 'unticking a satellite card does not ask about stopping ACE-Step');
ok(posts.length === 1 && posts[0].body.devices[0].enabled === false, 'the satellite card untick is saved');

// ...and a satellite row with no ACE-Step key at all (the payload shape of the defect) is the same.
sandbox.devs.rows = [
  { id: 'test-satellite:cuda:0', satellite: 'test-satellite', enabled: true, uses: {}, capable: ['render'] },
  { id: 'cpu', satellite: null, enabled: true, uses: {}, capable: ['render'] },
];
sandbox.__rows = [fakeRow('test-satellite:cuda:0', false, {}), fakeRow('cpu', false, {})];
posts.length = 0;
modals.length = 0;
await sandbox.saveDevices();
ok(!aceAsked(), 'unticking a card whose capable list has no ACE-Step never asks (satellite or cpu)');

// A local card that can run ACE-Step still asks, with the same payload shape.
sandbox.devs.rows = [{ id: 'cuda:0', satellite: null, enabled: true, uses: {}, capable: ['render', 'acestep'] }];
sandbox.__rows = [fakeRow('cuda:0', false, {})];
sandbox.__modalAnswer = 0;
posts.length = 0;
modals.length = 0;
await sandbox.saveDevices();
ok(aceAsked() && modals[0][1].includes('cuda:0'), 'unticking a local card that can run ACE-Step still asks first');
ok(posts.length === 0, 'canceling that question sends no settings PUT');

// Mixed save: only the card that could run ACE-Step is named.
sandbox.devs.rows = [
  { id: 'cuda:0', satellite: null, enabled: true, uses: { acestep: true }, capable: ['render', 'acestep'] },
  { id: 'test-satellite:cuda:0', satellite: 'test-satellite', enabled: true, uses: {}, capable: ['render'] },
];
sandbox.__rows = [fakeRow('cuda:0', true, { acestep: false }), fakeRow('test-satellite:cuda:0', false, {})];
modals.length = 0;
await sandbox.saveDevices();
ok(
  aceAsked() && modals[0][1].includes('cuda:0') && !modals[0][1].includes('test-satellite'),
  'the question names only the local ACE-Step card',
);
sandbox.__modalAnswer = 1;

// 2026-10-12 — A POLL ANSWER MUST NOT REPAINT THE LIST OVER A SAVE IN PROGRESS. The 10 s poll's
// answer describes the server before the save. Painted, it puts back the tick the user has just
// changed, and the panel then shows the opposite of what is stored until the next poll. Both
// orders are driven by the fakes below, not by a clock: the poll that answers while the "Stop
// ACE-Step?" question is open, and the poll that was sent before the save and answers after it.
const twoCards = () => [
  {
    id: 'cuda:0',
    label: 'Card A',
    satellite: null,
    reachable: true,
    enabled: true,
    uses: { acestep: true },
    capable: ['render', 'acestep'],
  },
  { id: 'cuda:1', label: 'Card B', satellite: null, reachable: true, enabled: true, uses: {}, capable: ['render'] },
];
const serverBeforeTheSave = () => ({ devices: twoCards(), satellites: [], subsystems: [] });
const plainModal = sandbox.modal;
const shown = () => JSON.stringify(String(sandbox.$('devList').innerHTML).slice(0, 70));
// A canceled save starts a reload it does not wait for, so let any reload the step before this one
// started finish first (one task yield, not a duration), or it would draw over this setup.
const untickFirstCard = async () => {
  await new Promise(resolve => setImmediate(resolve));
  sandbox.devs.rows = twoCards();
  sandbox.__rows = [fakeRow('cuda:0', false, { acestep: true }), fakeRow('cuda:1', true, {})];
  sandbox.$('devList').innerHTML = 'AS THE USER LEFT IT';
  posts.length = 0;
  modals.length = 0;
};

await untickFirstCard();
sandbox.jget = async () => serverBeforeTheSave();
sandbox.modal = async (...args) => {
  modals.push(args);
  await sandbox.loadDevices(); // the poll answers while the question is on screen
  return 1;
};
await sandbox.saveDevices();
ok(aceAsked() && posts.length === 1 && posts[0].body.devices[0].enabled === false, 'the untick is asked about and then saved');
ok(
  sandbox.$('devList').innerHTML === 'AS THE USER LEFT IT',
  `🔴 a poll that answers while the question is open does not repaint the list with the old ticks (list: ${shown()})`,
);

await untickFirstCard();
sandbox.modal = plainModal;
let answerThePoll;
sandbox.jget = () => new Promise(resolve => (answerThePoll = resolve));
const earlyPoll = sandbox.loadDevices(); // sent before the save, still unanswered
await sandbox.saveDevices();
answerThePoll(serverBeforeTheSave());
await earlyPoll;
ok(posts.length === 1, 'the save went through while that poll was out');
ok(
  sandbox.$('devList').innerHTML === 'AS THE USER LEFT IT',
  `🔴 a poll sent before the save and answered after it is thrown away, not painted (list: ${shown()})`,
);

sandbox.jget = async () => serverBeforeTheSave();
await sandbox.loadDevices();
ok(sandbox.$('devList').innerHTML !== 'AS THE USER LEFT IT', 'and the next poll, sent after the save finished, is painted as usual');

// Canceling the question reloads the list at once: that answer arrives after the save has ended
// and must be painted, or Cancel would leave the box showing a change that was never saved.
// 🔴 IT WAS NOT PAINTED, AND THIS CHECK IS WHAT FOUND IT. The server's answer after a Cancel is
// the same list `renderDevices` drew last, and it skips a redraw whose html is unchanged — so the
// box the user had unticked stayed unticked on screen with the card still enabled on the server.
// The list here is in exactly that state: redrawn by the poll just above, then "changed by the
// user" without the html knowing.
await untickFirstCard();
sandbox.__modalAnswer = 0;
await sandbox.saveDevices();
await new Promise(resolve => setImmediate(resolve)); // the reload Cancel started is not awaited by it
sandbox.__modalAnswer = 1;
ok(
  posts.length === 0 && sandbox.$('devList').innerHTML !== 'AS THE USER LEFT IT',
  `Cancel saves nothing and repaints the list from the server (PUTs: ${posts.length}; list: ${shown()})`,
);
// One failed read must not leave its error on screen once the server answers again. The good
// answer is the same list that was drawn before the failure, which is exactly when the
// unchanged-html short circuit used to keep the error text up.
sandbox.jget = async () => serverBeforeTheSave();
await sandbox.loadDevices();
sandbox.jget = async () => {
  throw new Error('the server is restarting');
};
await sandbox.loadDevices();
ok(/could not read the device list/.test(sandbox.$('devList').innerHTML), 'a failed read says so in the list');
sandbox.jget = async () => serverBeforeTheSave();
await sandbox.loadDevices();
ok(
  !/could not read the device list/.test(sandbox.$('devList').innerHTML) && /devwrap/.test(sandbox.$('devList').innerHTML),
  `🔴 and the next good read draws the cards again, though they are the same cards as before (list: ${shown()})`,
);
sandbox.jget = async () => {
  throw new Error('not used');
};

// ── 7. the settings rows are not written back by a resumed render ────────────
ok(!/setGpus\(/.test(main), 'setGpus is gone — a resumed job no longer overwrites the saved device rows');

// ── 8. the Satellites panel ──────────────────────────────────────────────────
ok(/<div id="satList"/.test(html), 'the Satellites panel has a #satList host');
ok(/id="satName"/.test(html) && /id="satUrl"/.test(html), 'add-a-satellite takes a name and a URL');

const devs2 = vm.runInContext('devs', sandbox);
devs2.rows = [];
devs2.sats = [
  {
    name: 'test-satellite',
    url: 'https://test-satellite.invalid:7880',
    reachable: true,
    version: '5.3',
    secret_set: true,
    cert: 'test-satellite.pem',
    verified: true,
    note: 'TLS, pinned',
  },
];
sandbox.renderSats();
const pinned = els.satList.innerHTML;
ok(/pinned/.test(pinned), 'a pinned satellite says so');
ok(/test-satellite\.pem/.test(pinned), 'and names the certificate it is pinned to');
ok(/shared secret set/.test(pinned), 'the secret shows as STATE, not a value');

// §17 — An uncapped VRAM field means the satellite may use the whole card. Its empty value uses
// "all" as the placeholder; "none" would incorrectly imply zero capacity. This fixture omits
// `vram_cap_gb`, matching a newly added satellite.
ok(/class="satCap"[^>]*placeholder="all"/.test(pinned), '🔴 an uncapped VRAM box reads "all" — the amount ALLOWED, not the absent limit');
ok(!/placeholder="none"/.test(pinned), 'and never the backward word');
ok(/class="satCap"[^>]*value=""/.test(pinned), 'with no number in the box until one is saved — the placeholder is not a value');

// And a saved cap actually reaches the box. Without this the two checks above pass just as well
// against a field that can only ever be empty.
devs2.sats = [{ ...devs2.sats[0], vram_cap_gb: 12.5, vram_cap_live: 12.5 }];
sandbox.renderSats();
const capped = els.satList.innerHTML;
ok(/class="satCap"[^>]*value="12\.5"/.test(capped), 'a saved cap shows in the box');
ok(/in effect/.test(capped) && !/not in effect/.test(capped), 'and reads as in effect once the satellite reports the same number back');
// The row must distinguish an unsupported cap from a supported cap that has not taken effect.
// `vram_cap_live: null` on a reachable satellite means it has not reported cap support; a
// different numeric value means the setting is supported but not yet applied.
devs2.sats = [{ ...devs2.sats[0], vram_cap_live: 0 }];
sandbox.renderSats();
const notTaken = els.satList.innerHTML;
ok(/⚠ not taken yet/.test(notTaken), '🔴 a satellite that did NOT take the cap is called out, not averaged into one comfortable number');
ok(!/first that understands/.test(notTaken), '🔴 …and is NOT told to update a build that already understands the setting');
devs2.sats = [{ ...devs2.sats[0], version: '1.10', vram_cap_live: null }];
sandbox.renderSats();
const tooOld = els.satList.innerHTML;
ok(
  /⚠ too old for this/.test(tooOld) && /first that understands/.test(tooOld),
  'a satellite that never mentioned a cap at all IS the one to update',
);
// ⚠️ Not while it is DOWN. `vram_cap_live` is null there too — we do not know what it would have
// said — and a second amber badge under "not running" reads as a separate, contradictory fault.
devs2.sats = [{ ...devs2.sats[0], reachable: false, vram_cap_live: null }];
sandbox.renderSats();
ok(
  !/not taken yet|too old for this|in effect/.test(els.satList.innerHTML),
  'an unreachable satellite claims nothing about the cap either way',
);

// ── 11.2 — the SillyTavern batch box ─────────────────────────────────────────
// The setting caps SillyTavern speech batch size. The default preserves serial processing; the
// UI explains what the setting controls and how to respond to playback pauses.
devs2.sats = [{ ...devs2.sats[0], reachable: true, vram_cap_gb: 0, vram_cap_live: 0 }];
sandbox.renderSats();
const stb = els.satList.innerHTML;
// 🔴 NEVER EMPTY, unlike the VRAM box above it. 1 already means "off" (the serial path), so there
// is no blank state to read as "unlimited" — the number in effect is always on screen. A fixture
// with no `st_max_batch` at all is the state every satellite configured before 11.2 is in.
ok(/class="satStBatch"[^>]*value="1"/.test(stb), '🔴 a satellite with no setting shows the default of 1, not an empty box');
ok(/SillyTavern max batch size/.test(stb), 'the control is labelled in his words');
ok(/class="satStBatchSave[^"]*"/.test(stb), 'and has its own Save, like the cap box');
// Explain the setting in its tooltip and keep the playback-pause remedy visible without requiring
// a hover.
ok(/title="[^"]*batch[^"]*for SillyTavern speech[^"]*"/i.test(stb), 'the hover says what the number is for');
ok(/hands nothing back until every chunk in it has finished/i.test(stb), '…and WHY a wide batch arrives late');
ok(/If speech playback pauses, lower this\./.test(stb), '🔴 the remedy is on screen, not only in a tooltip');
ok(/Books, scene builds and pre-rendered guesses are not affected/i.test(stb), 'and the hover bounds what the setting touches');
// A saved number reaches the box — without this the check above passes against a field that can
// only ever read 1.
devs2.sats = [{ ...devs2.sats[0], st_max_batch: 8 }];
sandbox.renderSats();
ok(/class="satStBatch"[^>]*value="8"/.test(els.satList.innerHTML), 'a saved batch size shows in the box');
// 🔴 AND THE POLL MUST NOT EAT A DIGIT OUT OF IT. `renderSats` runs from the same 10-second poll
// that repaints live status and replaces the whole list; a number input does not fire `change`
// until blur, so a repaint mid-type destroys a digit the server has never seen. The guard names
// the controls that hold unsaved state, and a second such control has to be named in it too.
ok(
  /classList\.contains\('satCap'\)\s*\|\|\s*document\.activeElement\.classList\.contains\('satStBatch'\)/.test(devjs),
  '🔴 the repaint guard covers BOTH number boxes, not just the first one written',
);

// 🔴 §6's trap. Unpinned self-signed TLS is barely better than plain HTTP against an active
// attacker on the LAN, so an https URL alone must never render as secure.
devs2.sats = [
  {
    name: 'test-satellite',
    url: 'https://test-satellite.invalid:7880',
    reachable: false,
    secret_set: true,
    cert: '',
    verified: false,
    note: 'TLS but NOT pinned',
  },
];
sandbox.renderSats();
const unpinned = els.satList.innerHTML;
ok(/not pinned/.test(unpinned), 'an https satellite with no certificate reads as NOT pinned — never as secure');
ok(/class="warn"/.test(unpinned), 'and is badged amber rather than reassuringly');
ok(/not running/.test(unpinned), 'a satellite that is down says so');

// The secret must appear in exactly one place in this UI: the one-time modal. Anything that
// can redisplay it puts it in the DOM on every settings read.
ok(
  !/s\.secret\b/.test(main.slice(main.indexOf('function satRow('), main.indexOf('function renderSats('))),
  'the satellite row never reads a secret VALUE — only the secret_set bool',
);
ok(/It is shown once and cannot be retrieved/.test(main), 'the one-time modal says plainly that the secret cannot be retrieved');

// Removing a satellite is destructive to its saved worker counts: it must be confirmed.
const rm = main.slice(main.indexOf('async function satRemove('), main.indexOf('function satUploadCert('));
ok(/await modal\(/.test(rm), 'Remove is confirmed before it fires');
ok(/method:'DELETE'|jdel\(/.test(rm), 'and it actually DELETEs');

// Rotating breaks the link until the new secret is pasted in on the other side.
const rot = main.slice(main.indexOf('async function satRotate('), main.indexOf('async function satRemove('));
ok(/await modal\(/.test(rot), 'a secret rotation is confirmed first');
ok(/stop answering/.test(rot), 'and warns that the satellite stops answering until it is updated too');

console.log(failed ? `\n${failed} check(s) failed` : '\nall device UI checks passed');
process.exit(failed ? 1 : 0);

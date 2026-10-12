import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { installDom } from './dom.js';
import { buildRawStamp, RAW_ENVELOPE_VERSION } from '../persist.js';

/** @typedef {import('./dom.js').Element} Element */

/**
 * The panel with the fork's record and a backend measurement behind it — the path §6.4a actually changed.
 *
 * ⚠️ ITS OWN FILE BECAUSE `probeRecord` AND `hasServerPlugins` MEMOISE. They answer once per module
 * instance, which is right in a browser and means a suite cannot un-probe them. `node --test` gives each
 * file its own registry, so this one probes as supported and `panel.test.js` probes as absent, and neither
 * has to reach into the other's state to do it.
 */
register(pathToFileURL('./test/loader.mjs'));

installDom();

const PROMPT_A = 'SYSTEM\nWORLD\nUser: hello';
const PROMPT_B = 'SYSTEM\nWORLD-moved\nUser: hello\nBot: hi\nUser: again';
// This turn has no `noteTimings`; its bar and summary must come from record `usage`, not live timings.
const PROMPT_C = 'SYSTEM\nWORLD-moved\nUser: hello\nBot: hi\nUser: again\nBot: sure\nUser: once more';

globalThis.SillyTavern = { libs: { sha256: text => `h(${text.length}:${text.slice(0, 12)})` } };

/**
 * What the fork answers, per path.
 *
 * ⚠️ TYPED AS THE WIRE, NOT AS `CacheRecord`. These are JSON bodies the client has not narrowed yet, and the
 * route's `rewriteSites` really do carry only `id`, `atChar` and `delta` — `atFinal` and `prepended` are
 * `rewriteSitesOf`'s answers about them, not fields the fork sends. Declaring the record type here would make
 * the fixture agree with the reader instead of with the server.
 * @type {Record<string, unknown>}
 */
const routes = {
    '/api/prompt-record/': { supported: true, depth: 10, backends: ['text', 'chat', 'kobold', 'novel'] },
    '/api/prompt-record/text': {
        supported: true,
        depth: 10,
        backend: 'text',
        records: [
            {
                seq: 1, prevSeq: null, at: 1, backend: 'text', apiType: 'llamacpp', chatId: 'chat-under-test',
                genType: 'normal', length: PROMPT_A.length, hash: `h(${PROMPT_A.length}:${PROMPT_A.slice(0, 12)})`,
                rewrittenBy: [], rewriteSites: [], text: PROMPT_A,
            },
            {
                seq: 2, prevSeq: 1, at: 2, backend: 'text', apiType: 'llamacpp', chatId: 'chat-under-test',
                genType: 'normal', length: PROMPT_B.length, hash: `h(${PROMPT_B.length}:${PROMPT_B.slice(0, 12)})`,
                rewrittenBy: ['mnemosyne'],
                rewriteSites: [{ id: 'mnemosyne', atChar: 0, delta: 7 }],
                text: PROMPT_B,
            },
            // 🔴 NO `noteTimings` STAGED FOR THIS SEQ, DELIBERATELY — see the `PROMPT_C` comment above. Its
            // `at: -1` sorts it oldest of every turn in this fixture (older than the raw row's `requestedAt:
            // 0` below), so it never shifts the existing index-0 ("the newest row") assertions elsewhere in
            // this file.
            // Keep this oldest itemized turn at mesId 0 so its chat position agrees with its timestamp.
            {
                seq: 3, prevSeq: null, at: -1, backend: 'text', apiType: 'llamacpp', chatId: 'chat-under-test',
                genType: 'normal', length: PROMPT_C.length, hash: `h(${PROMPT_C.length}:${PROMPT_C.slice(0, 12)})`,
                rewrittenBy: [], rewriteSites: [], text: PROMPT_C,
                usageState: 'available',
                usage: { schema: 'input-cache-v1', inputTokens: 100, cachedTokens: 40, uncachedTokens: 60, provider: 'llamacpp', api: 'text-completions' },
            },
        ],
    },
    // For the raw row's `view` click test — the same 'raw-alongside' record, this time with its prompt text,
    // as `fetchRecordPrompt` would find it while it is still in the server's memory.
    '/api/prompt-record/chat': {
        supported: true,
        depth: 10,
        backend: 'chat',
        records: [
            {
                recordId: 'raw-alongside', seq: 999, prevSeq: null, at: 0, backend: 'chat', apiType: 'deepseek',
                chatId: 'chat-under-test', genType: 'quiet', length: 4, hash: null, rewrittenBy: [], rewriteSites: [],
                text: 'the raw prompt, held only in server memory',
            },
        ],
    },
};

/**
 * A reply, as the record client reads one.
 *
 * 🔴 DELIBERATELY NOT A `Response`, AND THE CAST IS WHERE THAT IS DECLARED — the rule `test/dom.js` states
 * for `document`, applied to the wire. `record.js` reads `ok`, `status`, `headers.get` and `json()`, so those
 * are what this answers; growing it into the rest of `Response` would mean inventing behaviour and then
 * testing the invention.
 * @param {{ok: boolean, status: number, headers?: {get: () => string|null}, json: () => Promise<unknown>}} reply
 *   The four members that are really answered
 * @returns {Response} It, as `fetch` promises to return
 */
function asResponse(reply) {
    return /** @type {Response} */ (/** @type {unknown} */ (reply));
}

/**
 * @param {RequestInfo|URL} url What was asked for
 * @returns {Promise<Response>} The stubbed reply
 */
globalThis.fetch = async (url) => {
    const body = routes[String(url)];

    if (body === undefined) {
        return asResponse({ ok: false, status: 404, json: async () => ({}) });
    }

    return asResponse({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
};

// 🔴 THE LOADER PUTS `test/stubs/` HERE, AND THESE CASTS ARE WHERE THAT IS DECLARED. TypeScript resolves
// these specifiers through `types/sillytavern.d.ts`, which describes only what the extension imports from the
// real app — so the members a test reads off the stubs (`context`, `lastPopup`) are invisible to it. Naming
// the stub's own module type here says the substitution is intended, and leaves those ambient declarations
// describing SillyTavern rather than widened to describe the rig.
const script = await import('../../../script.js');
const extensions = /** @type {typeof import('./stubs/extensions.js')} */ (
    /** @type {unknown} */ (await import('../../../extensions.js')));
const popup = /** @type {typeof import('./stubs/popup.js')} */ (
    /** @type {unknown} */ (await import('../../../popup.js')));
const { noteTimings } = await import('../record.js');
const { openPanel, refreshPanel } = await import('../panel.js');

/**
 * One entry of `itemizedPrompts`, carrying only the fields the panel reads.
 *
 * 🔴 DELIBERATELY PARTIAL. SillyTavern's record carries a dozen more section strings, and every one of them
 * is absent on some install or some turn — which is why `attribution.js` skips a section with no text rather
 * than treating it as an empty one. Inventing them here would test the panel against a turn no install
 * actually produces.
 * @param {number} mesId Which chat message this prompt produced
 * @param {string} prompt The prompt
 * @returns {STItemizedPrompt} An itemized entry
 */
function itemized(mesId, prompt) {
    return {
        mesId,
        rawPrompt: prompt,
        this_max_context: 8_000,
        tokenizer: 'test',
        storyString: 'SYSTEM\nWORLD',
        worldInfoString: 'WORLD',
        mesSendString: prompt,
    };
}

script.itemizedPrompts.push(itemized(0, PROMPT_C), itemized(1, PROMPT_A), itemized(2, PROMPT_B));
extensions.context.chat = [{ mes: 'hello' }, { mes: 'hi' }, { mes: 'again' }, { mes: 'sure' }];

// The backend reused far more than the shared prefix — #350's shape, which is the whole point of §6.4a.
noteTimings(2, { cache_n: 3_000, prompt_n: 200, prompt_ms: 1_200 });

// 🔴 A RAW ROW ALONGSIDE A RECORD-MEASURED MESSAGE ROW, ADDED TO THE SHARED FIXTURE ABOVE RATHER THAN
// DRAWN SEPARATELY — this file draws once at module scope and every test below shares that one render.
// `requestedAt: 0` deliberately sorts it OLDEST of the three turns, so it lands last and none of the
// existing index-0 ("the newest row") assertions below shift. Unverified end to end until `index.js`
// merges `chatMetadata.cacheLens.rawRequests` into `buildRows()` (DESIGN_RAW_GENERATION_ROWS.md §7.4, §8).
const rawAlongsideRecord = buildRawStamp({
    id: 'raw-alongside', backend: 'chat', apiType: 'deepseek', seq: '999', generationType: 'quiet',
    requestedAt: 0, completedAt: 1, status: 'completed', usageState: 'available',
    inputTokens: 400, cachedTokens: 250, uncachedTokens: 150,
});

assert.ok(rawAlongsideRecord, 'the raw fixture stamp must itself be valid');
extensions.context.chatMetadata = { cacheLens: { v: RAW_ENVELOPE_VERSION, rawRequests: [rawAlongsideRecord] } };

void openPanel();
await refreshPanel();

/**
 * The element the panel drew into.
 *
 * ⚠️ THE ROOT SURVIVES A REFRESH; ITS CHILDREN DO NOT. `refreshPanel` calls `replaceChildren` on the same
 * container, so this stays the right element — but any node queried out of it before a refresh is one the
 * panel has since thrown away, which is why the expansion below reads the root again.
 * @returns {Element} The root the panel drew into
 */
function drawn() {
    assert.ok(popup.lastPopup, 'the panel should have opened a popup to draw into');

    // The stub takes the content as an opaque object, because nothing about a popup depends on what it is
    // holding. The panel builds it out of `test/dom.js`, and this is where the test says so.
    return /** @type {Element} */ (popup.lastPopup.content);
}

const content = drawn();

/**
 * @param {Element} root The panel root
 * @param {number} mesId Which message row
 * @returns {Element} The row element
 */
function rowByMesId(root, mesId) {
    const row = root.querySelectorAll('.cachelens-row').find(candidate => candidate.dataset.mesid === String(mesId));

    assert.ok(row, `no message row for #${mesId}`);

    return row;
}

/**
 * One drawer detail line's value, by its label — `.cachelens-detail` is `[label, value]` (`panel.js`'s
 * `detail()`), 2026-09-18 redesign.
 * @param {Element} row A row element (already expanded)
 * @param {string} label The detail line's fixed label, e.g. "Cache"
 * @returns {string|undefined} The value text, or undefined when that line was not printed
 */
function detailValue(row, label) {
    const found = row.querySelectorAll('.cachelens-detail').find(candidate => candidate.children[0]?.textContent === label);

    return found?.children[1]?.textContent;
}

/**
 * Click a row's head and refresh, so its drawer is open for the next read. Idempotent for the same reason
 * `persist-panel.test.js`'s copy is: `expanded` is module state that outlives one test.
 * @param {Element} row A row element
 * @returns {Promise<void>} When the refresh has drawn the open drawer
 */
async function expandRow(row) {
    if (row.querySelectorAll('.cachelens-expansion').length > 0) {
        return;
    }

    const head = row.querySelector('.cachelens-head');

    assert.ok(head, 'a row must have a head to click');
    head.dispatch('click');
    await refreshPanel();
}

test('the newest row draws the measurement, not the prefix', () => {
    const bar = content.querySelectorAll('.cachelens-bar')[0];

    assert.ok(bar, 'the newest row should have a bar');
    assert.equal(bar.classList.contains('cachelens-bar-predicted'), false, 'a measured turn is not a prediction');
    assert.match(bar.title, /Measured by the backend: 3,000 of 3,200 tokens reused/);
    // 3,000 of an 8,000-token window.
    assert.equal(bar.querySelectorAll('.cachelens-green')[0].style.width, '37.5%');
});

// 🔴 A TICK, NEVER A THIRD SEGMENT.
test('the shared prefix is a tick on the measured bar', () => {
    const bar = content.querySelectorAll('.cachelens-bar')[0];
    const ticks = bar.querySelectorAll('.cachelens-tick');

    assert.equal(ticks.length, 1);
    assert.match(ticks[0].title, /LOWER bound on reuse/);
    assert.equal(bar.querySelectorAll('.cachelens-green').length, 1);
    assert.equal(bar.querySelectorAll('.cachelens-red').length, 1);
});

// ⚠️ A MARK THAT CLIPS TO NOTHING IS A SILENT OMISSION, AND THE UNIT IS WHAT PREVENTS IT. The bar is
// `overflow: hidden` for its rounded corners and the hairline is centred on its position with a -1px margin,
// so a bare percentage pushed half the tick outside the bar at 0% — leaving the dark ring and not the white
// line, which reads as a notch in the segment rather than as the prefix mark. Only `clamp` can bound the
// travel by the bar's own rendered width; a percentage computed in `renderBar` cannot see it.
test('the tick is bounded by the bar, not by a bare percentage', () => {
    const tick = content.querySelectorAll('.cachelens-bar')[0].querySelectorAll('.cachelens-tick')[0];
    const left = tick.style.left;

    assert.match(left, /^clamp\(1px, [\d.]+%, calc\(100% - 1px\)\)$/, `tick left was ${left}`);
});

// The collapsed row shows the measured summary; the drawer carries the change location and cache details.
test('the collapsed row shows the measured summary, not a token/window count', () => {
    const summary = content.querySelectorAll('.cachelens-summary')[0].textContent;

    assert.equal(summary, 'cached 3,000 (93.8%) · uncached 200 (6.3%)');
    assert.doesNotMatch(content.querySelectorAll('.cachelens-row')[0].textContent, /eligible/);
});

test('the drawer says where it changed and what it cost, as separate lines', async () => {
    const newest = content.querySelectorAll('.cachelens-row')[0];

    await expandRow(newest);

    const opened = drawn().querySelectorAll('.cachelens-row')[0];

    assert.match(detailValue(opened, 'Changed since last turn') ?? '', /^at (char|token) \d/);
    assert.match(detailValue(opened, 'Cache') ?? '', /the backend reused 3,000 tokens and processed 200/);
});

// 🔴 §6.2c: char 0 on a plugin is the silent prepend fallback, and it is the reason the field exists.
// A char-zero rewrite is the prepend fallback; show it as a warning without claiming a configured depth.
test('a plugin that wrote at char 0 is surfaced, warned, and not accused of a depth', async () => {
    const newest = content.querySelectorAll('.cachelens-row')[0];

    await expandRow(newest);

    const opened = drawn().querySelectorAll('.cachelens-row')[0];
    const detailRow = opened.querySelectorAll('.cachelens-detail').find(candidate => candidate.children[0]?.textContent === 'Server plugin edits');

    assert.ok(detailRow, 'the drawer should carry a "Server plugin edits" line');

    // The value span is always an `Element` (`panel.js`'s `detail()` builds it with `el()`), never the
    // `TextNode` half of `children`'s union — the cast is where that is declared, the same "I know which
    // kind this is" cast `bar.js`'s `row.stamp` narrowing already uses.
    const value = /** @type {Element} */ (detailRow.children[1]);

    assert.match(value.textContent, /at the very start/);
    assert.equal(detailRow.classList.contains('cachelens-warn'), true);
    assert.match(value.title, /fell back to prepending/);
    assert.doesNotMatch(value.title, /depth \d/);
});

// The provenance label names a modifier; the separate edit detail identifies where it wrote.
test('the plugin is named as a modifier, never as the complete list', async () => {
    const newest = content.querySelectorAll('.cachelens-row')[0];

    await expandRow(newest);

    const shown = detailValue(drawn().querySelectorAll('.cachelens-row')[0], 'Prompt shown is') ?? '';

    assert.match(shown, /modified by mnemosyne/);
    assert.doesNotMatch(shown, /rewritten by/);
});

// The expansion's verdict is the §6.4b payoff: the backend reused far more than the prefix, so the change is
// not what this turn paid for.
//
// 🔴 USES `expandRow`, NOT A BARE `dispatch('click')`. Earlier tests in this file already opened this same
// row's drawer through `expandRow`, and `expanded` (in `panel.js`) is module state that outlives one test — a
// second, un-guarded click here would TOGGLE IT CLOSED rather than open it.
test('the expansion says whether the change is what the turn paid for', async () => {
    await expandRow(content.querySelectorAll('.cachelens-row')[0]);

    const verdict = drawn().querySelector('.cachelens-verdict');

    assert.ok(verdict, 'a measured row should carry a verdict');
    assert.match(verdict.textContent, /not what the turn paid for/);
    assert.equal(verdict.classList.contains('cachelens-verdict-recovered'), true);
});

test('a raw row alongside a record-measured message row draws its own split without disturbing the message row', () => {
    const rawRow = content.querySelectorAll('.cachelens-row-raw')[0];

    assert.ok(rawRow, 'the raw stamp added to the shared fixture should have produced a raw row');

    const rawSummary = rawRow.querySelector('.cachelens-summary');

    assert.ok(rawSummary, 'a raw row must always show a summary next to its bar');
    // The collapsed row is now only the bar and the summary — `400 input` moved into the drawer's "Input"
    // line (checked in the raw-drawer test below).
    assert.match(rawSummary.textContent, /cached 250 \(62\.5%\) · uncached 150 \(37\.5%\)/);

    // The message row's own measurement (asserted in detail by the tests above) is untouched: still the
    // newest row, still reporting the backend's actual/processed split.
    const newestSummary = content.querySelectorAll('.cachelens-summary')[0].textContent;

    assert.equal(newestSummary, 'cached 3,000 (93.8%) · uncached 200 (6.3%)');
});

// m-8: `rawAlongsideRecord` above was built with `requestedAt: 0` — persist.js's absent-sentinel for a raw
// stamp with no real request time — and has no `measuredAt` at all (RawRow carries no such field). Before
// the fix, `renderWhen` treated `0` as a real, finite timestamp and rendered it as a 1969/1970 date; the
// guard now treats non-positive as absent, same as missing, so this row shows no time column at all.
test('a raw row whose requestedAt is the 0 absent-sentinel draws no time column, never a 1969 date (m-8)', () => {
    const rawRow = content.querySelectorAll('.cachelens-row-raw')[0];

    assert.ok(rawRow, 'the raw stamp added to the shared fixture should have produced a raw row');
    assert.equal(rawRow.querySelector('.cachelens-when'), null, 'a 0 requestedAt with no measuredAt fallback must render no time column');
});

// The expanded raw-row drawer shows the full input split and backend details.
test('the raw row drawer states its input split in full, and its backend', async () => {
    const rawRow = content.querySelectorAll('.cachelens-row-raw')[0];

    await expandRow(rawRow);

    const opened = drawn().querySelectorAll('.cachelens-row-raw')[0];

    assert.equal(detailValue(opened, 'Input'), '400 tokens — cached 250 (62.5%), uncached 150 (37.5%)');
    assert.equal(detailValue(opened, 'Backend'), 'chat / deepseek');
    assert.ok(detailValue(opened, 'What this is')?.includes('quiet generation'));
    assert.ok(detailValue(opened, 'Prompt')?.includes('use view'));
});

// The `view` click fetches the prompt on demand through `fetchRecordPrompt`; the `routes` stub serves the prompt
// record endpoint with the same `recordId`, exercising a successful round trip rather than only the request.
// Nothing about the fetched text is stored on the row or its stamp — checked by asserting neither gained a
// new own-enumerable key after the click.
test('clicking view on a raw row fetches its prompt without storing it on the row or stamp', async () => {
    const rawRow = content.querySelectorAll('.cachelens-row-raw')[0];
    const view = rawRow.querySelector('.cachelens-view');

    assert.ok(view, 'a raw row must always offer a view button');

    // 🔴 THE ROW ELEMENT NEVER HOLDS THE ROW/STAMP DATA IN THE FIRST PLACE — `renderRow`/`handleRawView` only
    // ever close over it, never attach it to the DOM node — so "nothing stored on the row" is checked the way
    // this shim can actually observe it: no new own key (property or `dataset` entry) appears on the element
    // after the click, for the fetched text or anything else.
    const keysBefore = Object.keys(rawRow);
    const datasetKeysBefore = Object.keys(rawRow.dataset);

    view.dispatch('click');
    // `handleRawView` is fire-and-forget from the click handler (`void handleRawView(...)`, same pattern as
    // every other row click in `panel.js`), so there is no promise here to await directly. It chains several
    // real `await`s (`probeRecord`'s fetch, `fetchRecords`' fetch, then the popup), so a fixed few
    // `Promise.resolve()` turns are not reliably enough — `setImmediate` flushes the microtask queue AND one
    // macrotask turn, which is enough for the whole chain to settle.
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(Object.keys(rawRow), keysBefore, 'the row element must gain no new field from the fetched text');
    assert.deepEqual(Object.keys(rawRow.dataset), datasetKeysBefore, 'the row element\'s dataset must gain no new entry either');
    assert.ok(popup.lastPopup, 'the view click should have opened a popup');

    const popupText = /** @type {Element} */ (popup.lastPopup.content).querySelector('.cachelens-full-text');

    assert.ok(popupText, 'the popup should show the fetched prompt');
    assert.equal(popupText.textContent, 'the raw prompt, held only in server memory');
});

// 🔴 THE END-TO-END PROOF FOR `timingsFromRecordUsage` (`record.js`, `index.js`). This turn carries no
// `noteTimings` staging at all — `PROMPT_C`'s own comment above says why — so a measured bar here can only
// have come from the record's `usage`, through `index.js`'s `recordTimings` fallback.
test('a message row whose matched record carries validated usage draws a measured bar from it, live', async () => {
    const row = rowByMesId(content, 0);

    assert.ok(row, 'the PROMPT_C turn should have produced a row');

    const bar = row.querySelector('.cachelens-bar');

    assert.ok(bar, 'the row should have a bar');
    assert.equal(bar.classList.contains('cachelens-bar-predicted'), false, 'usage-derived timings measure the turn, they do not predict it');

    const summaryEl = row.querySelector('.cachelens-summary');

    assert.ok(summaryEl, 'the row should have a summary');

    const summary = summaryEl.textContent;

    assert.equal(summary, 'cached 40 (40.0%) · uncached 60 (60.0%)');

    await expandRow(row);

    // ⚠️ `content`, NOT `drawn()` — the previous test's `view` click opened a SECOND, nested popup (the
    // fetched-prompt popup), which left `popup.lastPopup` pointing at IT rather than at the panel. `content`
    // is a direct reference to the panel's own container element, which `refreshPanel` mutates in place
    // (`replaceChildren`) and which a nested popup never touches — see the `⚠️ THE ROOT SURVIVES A REFRESH`
    // comment on `drawn()` above for why re-querying from a stable root, rather than trusting `lastPopup`,
    // is what every other test in this file already does for a plain refresh.
    const opened = rowByMesId(content, 0);

    // `measurementSource: 'live'` — this session's own fetch, not a stamp saved with the chat.
    assert.match(detailValue(opened, 'Cache') ?? '', /the backend reused 40 tokens and processed 60/);
    assert.match(detailValue(opened, 'Cache') ?? '', /measured this session/);
});

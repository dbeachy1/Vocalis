import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { installDom } from './dom.js';

/**
 * The measurement going into a chat message, and coming back out of one after the page that took it is gone.
 *
 * Verify that a measurement is written to the chat message and that a later page load can render it without
 * relying on in-memory sequence maps, staged timings, or server records. `persist.test.js` covers stamp shape;
 * this file covers the write and reload path.
 *
 * ⚠️ ITS OWN FILE, for the same reason `panel-record.test.js` is: `probeRecord` and `hasServerPlugins`
 * memoise per module instance. Here they must answer "no record route at all", which is what a reload
 * against a stock install looks like and is the hostile case for §14.6.
 */
register(pathToFileURL('./test/loader.mjs'));

installDom();

globalThis.SillyTavern = { libs: { sha256: text => `h(${text.length})` } };

/** @typedef {import('./dom.js').Element} Element */

/**
 * Every request the panel can make, counted, so "no record fetch" is measured rather than asserted.
 * @type {string[]}
 */
const fetched = [];

/**
 * ⚠️ NOT A `Response`, AND MUST NOT GROW INTO ONE — the same rule as `test/dom.js`. `probeRecord` reads `ok`
 * and `status`, and the record route's reader reads `json()`; anything else the extension starts taking off a
 * response should fail here rather than be quietly approximated.
 * @param {RequestInfo|URL} url What was asked for
 * @returns {Promise<Response>} A 404, always — §14.6's hostile case is a stock install with no record route
 */
globalThis.fetch = async (url) => {
    fetched.push(String(url));

    return /** @type {Response} */ (/** @type {unknown} */ ({ ok: false, status: 404, json: async () => ({}) }));
};

/**
 * The stubs, reached twice on purpose.
 *
 * 🔴 THE CLIMB IMPORT IS A LIVE CHECK THAT THE LOADER IS INSTALLED, and it is the only one there can
 * be. `../../../script.js` is the specifier `index.js` and `panel.js` use, and outside a real install it
 * resolves to a file above the repo that does not exist — so if `register` above ever stopped taking effect,
 * this line throws rather than the suite quietly testing a module the source under test never received.
 *
 * The typed handles then come from `./stubs/` directly, because `types/sillytavern.d.ts` describes the REAL
 * app's surface and only the part the extension imports — so the affordances a test needs, the recorded
 * `handlers`, the mutable `context`, `lastPopup`, are invisible through the climb specifier. Node caches
 * modules by resolved URL and both paths resolve to the same files, so these are the same instances.
 *
 * ⚠️ AND THAT LAST SENTENCE IS ASSERTED BELOW RATHER THAN BELIEVED. It used to be a cast, which said the
 * same thing with no way to be wrong out loud: a loader remapped to somewhere else would have satisfied the
 * cast and handed every test a second copy of the module, with the source mutating the first one.
 */
const climbed = await import('../../../script.js');
const script = await import('./stubs/script.js');
const extensions = await import('./stubs/extensions.js');
const popup = await import('./stubs/popup.js');

assert.equal(climbed.eventSource, script.eventSource, 'the loader must resolve the climb to test/stubs/');

/** The stub's context: a real `STContext`, plus the save counter §14.4 needs to watch move. */
const context = extensions.context;
const { STAMP_VERSION, readStamp, buildRawStamp, RAW_ENVELOPE_VERSION } = await import('../persist.js');
const { noteTimings } = await import('../record.js');
const { buildRows, captureMeasurement, init } = await import('../index.js');
const { openPanel, refreshPanel } = await import('../panel.js');

const PROMPT_A = 'SYSTEM\nWORLD\nUser: hello';
const PROMPT_B = 'SYSTEM\nWORLD\nUser: hello\nBot: hi\nUser: again';

/**
 * @param {number} mesId Which chat message this prompt produced
 * @param {string} prompt The prompt as the browser built it
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

/**
 * A chat message as the core builds one, with the swipe bookkeeping the streaming path leaves behind.
 *
 * 🔴 DELIBERATELY WIDER THAN `STChatMessage`, AND THE CAST IS WHERE THAT IS DECLARED.
 * `types/sillytavern.d.ts` describes only the members the extension reads, on purpose; `swipes` and the swipe
 * entry's three timestamps are the core's own bookkeeping. Trimming them to fit the declaration would leave a
 * fixture that no longer looks like the message `syncMesToSwipe` is actually handed — and that shape is the
 * whole habitat of the streaming swipe trap below.
 * @param {string} text The message
 * @param {Record<string, unknown>} [extra] Its `extra` bag
 * @returns {STChatMessage} The message
 */
function message(text, extra = {}) {
    const swipe = { send_date: 0, gen_started: 0, gen_finished: 0, extra: structuredClone(extra) };

    return /** @type {STChatMessage} */ ({
        mes: text,
        extra,
        swipe_id: 0,
        swipes: [text],
        swipe_info: [swipe],
    });
}

/**
 * One row's element, so an assertion is about the turn it names.
 *
 * ⚠️ SCOPED, BECAUSE THE PANEL IS A LIST AND THE LABELS ARE SHARED. Asking the whole panel whether it
 * contains "no baseline" is answered by the first turn of the chat, which legitimately has none — and the
 * assertion then passes or fails for a reason that has nothing to do with the turn under test.
 * @param {Element} content The panel root
 * @param {number} mesId Which turn
 * @returns {Element} The row element
 */
function rowFor(content, mesId) {
    // ⚠️ The shim's `dataset` is a bare object, not a `DOMStringMap` — `test/dom.js` covers exactly the
    // surface the panel touches and no more — so reading a key off it is stated here rather than assumed.
    const row = content.querySelectorAll('.cachelens-row')
        .find(node => node.dataset.mesid === String(mesId));

    assert.ok(row, `no row for #${mesId}`);

    return row;
}

/**
 * One drawer detail line's value, by its label — `.cachelens-detail` is `[label, value]`
 * (`panel.js`'s `detail()`), 2026-09-18 redesign: the collapsed row's old `cachelens-measured`/
 * `cachelens-changed` columns moved into these, inside the drawer that opens on click.
 * @param {Element} row A row element (already expanded)
 * @param {string} label The detail line's fixed label, e.g. "Cache"
 * @returns {string|undefined} The value text, or undefined when that line was not printed
 */
function detailValue(row, label) {
    const found = row.querySelectorAll('.cachelens-detail').find(candidate => candidate.children[0]?.textContent === label);

    return found?.children[1]?.textContent;
}

/**
 * Click a row's head and refresh, so its drawer is open for the next read.
 *
 * 🔴 IDEMPOTENT, BECAUSE `expanded` IS MODULE STATE THAT OUTLIVES ONE TEST (by design — see `panel.js`'s own
 * comment on it). Several tests in this file reuse `mesId: 3` for unrelated fixtures, so a row already left
 * open by an earlier test in the same run must not be TOGGLED CLOSED by a later one clicking it again.
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

/**
 * What the panel last drew into.
 *
 * ⚠️ THE STUB HOLDS IT AS `object`, BECAUSE A POPUP IS HANDED WHATEVER THE PANEL CONSTRUCTED and has no
 * business knowing more. So the one cast to the shim's `Element` lives here rather than at every call site,
 * and "the panel was never opened" fails as an assertion instead of as a property access on null.
 * @returns {Element} The panel root
 */
function panelContent() {
    const shown = popup.lastPopup;

    assert.ok(shown, 'the panel was never opened');

    return /** @type {Element} */ (shown.content);
}

/**
 * Put the world into a known state: this chat, these prompts, no measurements staged anywhere.
 * @param {STItemizedPrompt[]} entries Itemized entries, oldest first
 * @param {STChatMessage[]} chat The chat messages
 * @returns {void}
 */
function setUp(entries, chat) {
    script.itemizedPrompts.length = 0;
    script.itemizedPrompts.push(...entries);
    context.chat = chat;
    context.chatId = 'chat-under-test';
    context.saves = 0;
    fetched.length = 0;
}

// 🔴 THE STAMP IS WRITTEN THROUGH THE REAL WIRING, NOT BY A TEST CALLING THE WRITER DIRECTLY. §14.4's whole
// point is WHERE it happens: `GENERATION_TIMINGS` fires before the message exists on the non-streaming path,
// so `MESSAGE_RECEIVED` is the first moment there is a `mesId` to attach anything to.
test('the measurement is written into the message when the message arrives', async () => {
    init();

    const chat = [message('hello'), message('hi'), message('again'), message('there')];

    setUp([itemized(1, PROMPT_A), itemized(3, PROMPT_B)], chat);
    noteTimings('99', { cache_n: 34_931, prompt_n: 10_617, prompt_ms: 20_760 });

    // The seq the response header carried, which is how the staged timings are found again.
    const rows = await buildRows();

    assert.ok(rows, 'rows build before anything is stamped');

    // Drive it exactly as the app does: the core emits, and the handler stamps.
    // ⚠️ THROUGH `emit`, NOT BY PULLING ONE HANDLER OUT. The stub now keeps every listener for an event
    // rather than only the last one registered (see `test/stubs/script.js`), so reaching for a single
    // function would drive whichever one happened to be first and quietly skip the rest.
    assert.ok(script.eventSource.handlers.get('message_received')?.length, 'init() wired MESSAGE_RECEIVED, or nothing below is being driven at all');
    await script.eventSource.emit('message_received', 3);
    // The handler deliberately does not return its promise — the core awaits `MESSAGE_RECEIVED` immediately
    // before rendering the reply — so the test waits for the same work the way the app's next tick does.
    await captureMeasurement(3);

    const stamp = readStamp(chat[3]);

    assert.ok(stamp, 'the message carries a stamp');
    assert.equal(stamp.v, STAMP_VERSION);
    assert.equal(stamp.promptChars, PROMPT_B.length);
    assert.ok(context.saves > 0, 'the chat is saved, or the stamp never reaches the file');
});

// 🔴 THE STREAMING SWIPE TRAP, WHICH IS THE ONE THAT HIDES. Streaming calls `syncMesToSwipe(messageId)` and
// THEN emits `MESSAGE_RECEIVED`, so the core's copy of `extra` is taken before the stamp exists. Rows render
// correctly all session; then the reader swipes away and back, `syncSwipeToMes` restores `extra` from a
// `swipe_info` entry that never held `cacheLens`, and THAT ONE ROW goes blank while its neighbours are fine.
// Deleting the `syncMesToSwipe(mesId)` call in `captureMeasurement` must fail this test.
test('a stamp survives a swipe away and back on the streaming path', async () => {
    const chat = [message('hello'), message('hi'), message('again'), message('there')];

    setUp([itemized(1, PROMPT_A), itemized(3, PROMPT_B)], chat);
    noteTimings('99', { cache_n: 34_931, prompt_n: 10_617, prompt_ms: 20_760 });

    // The core's ordering on the streaming path: the swipe copy is taken FIRST.
    script.syncMesToSwipe(3);

    // The swipe bookkeeping is asserted rather than optional-chained past: the trap is only reachable on a
    // message that HAS it, so a fixture that lost it would otherwise prove nothing and still pass.
    const copied = chat[3].swipe_info?.[0];

    assert.ok(copied?.extra, 'the fixture carries swipe bookkeeping');
    assert.equal(copied.extra.cacheLens, undefined, 'the core copied before the stamp existed');

    await captureMeasurement(3);
    assert.ok(chat[3].extra?.cacheLens, 'the message itself has it');

    // `syncSwipeToMes` restores `extra` wholesale from the swipe entry. This is the moment the row went
    // blank, and it is the only place the loss is observable.
    const restored = chat[3].swipe_info?.[chat[3].swipe_id ?? 0]?.extra;

    assert.ok(restored, 'the swipe the reader lands back on still exists');
    chat[3].extra = structuredClone(restored);

    assert.ok(readStamp(chat[3]), 'the stamp is still there after swiping away and back');
});

// 🔴 §14.6: NO PROBE, NO RECORD FETCH, NO SEQ. Every one of those is RAM the reload destroyed. This is the
// reload: the prompts came back from IndexedDB, the chat came back from the server, and nothing else did.
test('a reloaded page draws the measured bar from the chat alone', async () => {
    const stamped = message('there', {
        cacheLens: {
            v: 1, seq: null, at: Date.now() - 3 * 86_400_000, maxContext: 8_000,
            promptChars: PROMPT_B.length, eligibleChars: 12, eligibleTokens: 3, promptTokens: 11,
            actualTokens: 34_931, processedTokens: 10_617, promptMs: 20_760,
            divergedAt: 12, baselineSeq: null, rewrittenBy: [], rewriteSites: [], clientChanges: [],
        },
    });
    const chat = [message('hello'), message('hi'), message('again'), stamped];

    setUp([itemized(1, PROMPT_A), itemized(3, PROMPT_B)], chat);

    const { rows } = await buildRows();
    // 🔴 NARROWED VIA `rowKey`, WHICH IS COMMON TO BOTH ROW KINDS, RATHER THAN `mesId`, WHICH ONLY A
    // `MessageRow` HAS. `rows` is `Row[]` — a discriminated union since DESIGN_RAW_GENERATION_ROWS.md §8 — so
    // predicating on `mesId` inside the `.find()` callback itself would be a typecheck error; `rowKey` is
    // declared on every row and `message:<mesId>` is its pinned format for a message row. The cast on the
    // result is the same "I know which kind this is" cast `bar.js` already uses for `row.stamp`.
    const row = /** @type {import('../index.js').MessageRow|undefined} */ (rows.find(candidate => candidate.rowKey === 'message:3'));

    assert.ok(row, 'the reloaded turn is a row at all');
    assert.deepEqual(row.timings, { cache_n: 34_931, prompt_n: 10_617, prompt_ms: 20_760 });
    assert.equal(row.measurementSource, 'recorded');
    assert.equal(row.recorded, true);

    // Nothing that answered here came from the record route — every request to it 404'd.
    assert.ok(fetched.every(url => url.startsWith('/api/')), fetched.join(' | '));

    void openPanel();
    await refreshPanel();

    const collapsed = rowFor(panelContent(), 3);

    // The collapsed row's own summary already carries the measured split — `bar.js`'s `summaryFor`.
    assert.ok(collapsed.querySelector('.cachelens-summary'), 'the collapsed row shows a summary next to the bar');

    await expandRow(collapsed);

    const cache = detailValue(rowFor(panelContent(), 3), 'Cache');

    assert.ok(cache, 'the drawer should carry a Cache line');
    assert.match(cache, /the backend reused 34,931 tokens and processed 10,617/);
    // §6.3: say which source produced what you are showing, and when it was taken.
    assert.match(cache, /measured 3 days ago, saved with the chat/);
});

// 🔴 §14.5. "Not recorded" and "recorded, and the backend reported no cache_n" are opposite facts about the
// same blank column: the first will never resolve, and the second is about the backend's build. A reader
// told nothing assumes the second and goes looking at llama.cpp flags for a number nobody kept.
test('a turn from before persistence says so, and does not borrow the other explanation', async () => {
    const chat = [message('hello'), message('hi'), message('again'), message('there')];

    setUp([itemized(1, PROMPT_A), itemized(3, PROMPT_B)], chat);

    void openPanel();
    await refreshPanel();

    await expandRow(rowFor(panelContent(), 3));

    const cache = detailValue(rowFor(panelContent(), 3), 'Cache');

    assert.equal(cache, "no measurement was saved — this turn is older than Cache Lens's recording");
});

test('a turn that WAS recorded and measured to nothing says that instead', async () => {
    const stamped = message('there', {
        cacheLens: {
            v: 1, seq: null, at: Date.now(), maxContext: 8_000, promptChars: PROMPT_B.length,
            eligibleChars: 12, eligibleTokens: null, promptTokens: null,
            // The backend reported nothing at all for this generation — a chat-completion provider, or a
            // llama.cpp build old enough not to send `timings`.
            actualTokens: null, processedTokens: null, promptMs: null,
            divergedAt: 12, baselineSeq: null, rewrittenBy: [], rewriteSites: [], clientChanges: [],
        },
    });
    const chat = [message('hello'), message('hi'), message('again'), stamped];

    setUp([itemized(1, PROMPT_A), itemized(3, PROMPT_B)], chat);

    void openPanel();
    await refreshPanel();

    await expandRow(rowFor(panelContent(), 3));

    const cache = detailValue(rowFor(panelContent(), 3), 'Cache');

    assert.equal(cache, 'the backend did not report cache usage for this turn');
});

// ⚠️ A PARTIAL REPORT IS NOT A BLANK ONE. A build that sends `prompt_ms`/`prompt_n` but no `cache_n` has told
// the panel something, and printing "the backend did not report cache usage for this turn" over the top of
// it would throw away the half that did arrive.
//
// The bar requires both counts to draw a split. The cache line can still report available processed counts and
// prefill time while stating that the reused count is missing.
test('a partial report is shown as far as it goes', async () => {
    const stamped = message('there', {
        cacheLens: {
            v: 1, seq: null, at: Date.now(), maxContext: 8_000, promptChars: PROMPT_B.length,
            eligibleChars: 12, eligibleTokens: null, promptTokens: null,
            actualTokens: null, processedTokens: 10_617, promptMs: 40,
            divergedAt: 12, baselineSeq: null, rewrittenBy: [], rewriteSites: [], clientChanges: [],
        },
    });
    const chat = [message('hello'), message('hi'), message('again'), stamped];

    setUp([itemized(1, PROMPT_A), itemized(3, PROMPT_B)], chat);

    void openPanel();
    await refreshPanel();

    await expandRow(rowFor(panelContent(), 3));

    const cache = detailValue(rowFor(panelContent(), 3), 'Cache');

    assert.match(cache ?? '', /processed 10,617 tokens but did not say how many it reused/);
    assert.match(cache ?? '', /0\.04s prefill/);
});

// 🔴 A STAMPED TURN WHOSE PROMPT AGED OUT OF THE BROWSER'S STORE IS STILL A ROW. This is not exotic: the
// prompt store is bounded, so a long chat's oldest entries come back with an empty `rawPrompt` — exactly
// what the row builder's filter drops. Dropping them once persistence exists throws away the only copy of
// the number, and the panel goes emptier the longer the chat gets.
test('a measurement outlives the prompt it was taken from', async () => {
    const stamped = message('there', {
        cacheLens: {
            v: 1, seq: null, at: Date.now(), maxContext: 8_000, promptChars: 112_044,
            eligibleChars: 2_249, eligibleTokens: 601, promptTokens: 45_548,
            actualTokens: 34_931, processedTokens: 10_617, promptMs: 20_760,
            divergedAt: 2_249, baselineSeq: null, rewrittenBy: [], rewriteSites: [], clientChanges: [],
        },
    });
    const chat = [message('hello'), message('hi'), message('again'), stamped];

    // The itemized store kept nothing for turn 3 — the empty `rawPrompt` a long chat's store hands back.
    setUp([itemized(1, PROMPT_A), itemized(3, '')], chat);

    const { rows, droppedRows } = await buildRows();
    // See the identical `rowKey` narrowing note above — `mesId` does not exist on the `Row` union directly.
    const row = /** @type {import('../index.js').MessageRow|undefined} */ (rows.find(candidate => candidate.rowKey === 'message:3'));

    assert.ok(row, 'the stamped turn is still a row');
    assert.equal(row.promptKnown, false);
    assert.equal(row.baselineMissing, 'no-prompt');
    assert.deepEqual(row.timings, { cache_n: 34_931, prompt_n: 10_617, prompt_ms: 20_760 });
    // It was rescued, so it is not one of the turns the header announces as not listed.
    assert.equal(droppedRows, 0);

    // 🔴 AND ITS COUNTS ARE NOT OVERWRITTEN WITH ZERO. `countTokens('')` answers 0, and writing that over
    // the stamp would read `0 / 8,000` on a turn whose prompt was 45,548 tokens.
    assert.equal(row.promptTokens, 45_548);
    assert.equal(row.prefixTokens, 601);

    void openPanel();
    await refreshPanel();

    const collapsed = rowFor(panelContent(), 3);

    // Nothing to open, so nothing offers to open it — an empty popup captioned as this turn's prompt reads
    // as the prompt having BEEN empty. `cachelens-copy` was renamed `cachelens-view` in the 2026-09-18
    // redesign, and the rule is unchanged: no prompt known, no button.
    assert.equal(collapsed.querySelectorAll('.cachelens-view').length, 0);
    assert.equal(rowFor(panelContent(), 1).querySelectorAll('.cachelens-view').length, 1);

    await expandRow(collapsed);

    const drawn = rowFor(panelContent(), 3);

    // ⚠️ NEVER "first turn" or anything read as "the cache was empty", which every reader takes to mean the
    // first turn of the chat. This one is the fourth message of four and the cache was not empty when it
    // arrived — `changedLine`'s `no-prompt` branch, worded in the drawer's plain-English style.
    assert.equal(detailValue(drawn, 'Changed since last turn'), 'this prompt no longer stored');
    assert.match(detailValue(drawn, 'Cache') ?? '', /the backend reused 34,931 tokens and processed 10,617/);
});

// 🔴 A REGENERATE MUST NOT RE-STAMP ITSELF WITH THE ANSWER IT IS REPLACING. The row builder prefers the
// stored stamp over live RAM — it has to, because a swipe restores `extra` from the swipe on screen while
// the RAM map still holds whichever generation ran last. So without `freshFor`, capturing a message that
// already carries a stamp would read that stamp back out and write it straight in again, and the row would
// go on reporting a measurement of a generation that no longer exists.
test('regenerating a message replaces its measurement rather than re-writing the old one', async () => {
    const stamped = message('there', {
        cacheLens: {
            v: 1, seq: '10', at: 1, maxContext: 8_000, promptChars: PROMPT_B.length,
            eligibleChars: 12, eligibleTokens: 3, promptTokens: 11,
            actualTokens: 111, processedTokens: 222, promptMs: 333,
            divergedAt: 12, baselineSeq: null, rewrittenBy: [], rewriteSites: [], clientChanges: [],
        },
    });
    const chat = [message('hello'), message('hi'), message('again'), stamped];

    setUp([itemized(1, PROMPT_A), itemized(3, PROMPT_B)], chat);
    // The new generation's own numbers, staged under the seq its response header carried.
    noteTimings('777', { cache_n: 38_797, prompt_n: 6_669, prompt_ms: 900 });

    const { rows } = await buildRows({ freshFor: 3 });

    // See the `rowKey` narrowing note above.
    const fresh = /** @type {import('../index.js').MessageRow|undefined} */ (rows.find(candidate => candidate.rowKey === 'message:3'));

    assert.ok(fresh, 'the regenerated turn is still a row');
    assert.equal(fresh.recorded, false, 'freshFor hides the old stamp');

    await captureMeasurement(3);

    const stamp = readStamp(chat[3]);

    // The re-dating below is the assertion, so a stamp that came back null or undated is a failure of it
    // rather than a shape to navigate around.
    assert.ok(stamp);
    assert.ok(stamp.at !== null);
    assert.notEqual(stamp.actualTokens, 111, 'the replaced measurement must not be written back');
    assert.equal(stamp.at > 1, true, 'the stamp is re-dated to when it was actually taken');
});

// =====================================================================================================
// Raw generation rows (DESIGN_RAW_GENERATION_ROWS.md §7, §8). `index.js` (a concurrent coder's file, off
// limits here) does not yet merge `chatMetadata.cacheLens.rawRequests` into `buildRows()`'s output, so the
// two tests below are UNVERIFIED end to end until that seam closes — they pin the `rows`/`messageRows`/
// `rowKey` contract panel.js is already built against, using the real, already-implemented `persist.js`
// validator to build the fixture rather than a hand-written object that could drift from what
// `readRawRequests` actually accepts.
// =====================================================================================================

test('a raw generation stamp in chat metadata becomes a raw row, and never a message row', async () => {
    const raw = buildRawStamp({
        id: 'raw-reload', backend: 'chat', apiType: 'deepseek', seq: '900', generationType: 'quiet',
        requestedAt: 50, completedAt: 60, status: 'completed', usageState: 'available',
        inputTokens: 800, cachedTokens: 600, uncachedTokens: 200,
    });

    assert.ok(raw, 'the fixture stamp must itself be valid');

    const chat = [message('hello'), message('hi'), message('again'), message('there')];

    setUp([itemized(1, PROMPT_A), itemized(3, PROMPT_B)], chat);
    context.chatMetadata = { cacheLens: { v: RAW_ENVELOPE_VERSION, rawRequests: [raw] } };

    const { rows, messageRows } = await buildRows();
    const rawRow = rows.find(candidate => candidate.kind === 'raw');

    assert.ok(rawRow, 'a completed quiet record should produce exactly one raw row');
    assert.equal(rawRow.rowKey, 'raw:raw-reload');
    assert.equal(rawRow.stamp.id, 'raw-reload');
    // 🔴 A RUNTIME CHECK, NOT A TAUTOLOGY, DESPITE WHAT THE DECLARED TYPE PROMISES. `messageRows` is typed
    // `MessageRow[]`, so TypeScript already treats `kind !== 'raw'` as always true and refuses the direct
    // comparison — but that is a claim about the TYPE, not about what `index.js` actually returns at runtime,
    // which is exactly what this assertion exists to catch if the two ever disagree. Widening to `Row` for
    // the comparison keeps the check real without fighting the type system over a guarantee it cannot verify.
    assert.ok(messageRows.every(candidate => /** @type {import('../index.js').Row} */ (candidate).kind !== 'raw'), 'messageRows must never include a raw row');
});

test('a raw row carries dataset.rowkey and no dataset.mesid', async () => {
    const raw = buildRawStamp({
        id: 'raw-render', backend: 'chat', apiType: 'deepseek', seq: '901', generationType: 'quiet',
        requestedAt: 5, completedAt: 6, status: 'completed', usageState: 'absent',
        inputTokens: null, cachedTokens: null, uncachedTokens: null,
    });

    assert.ok(raw, 'the fixture stamp must itself be valid');

    const chat = [message('hello')];

    setUp([itemized(1, PROMPT_A)], chat);
    context.chatMetadata = { cacheLens: { v: RAW_ENVELOPE_VERSION, rawRequests: [raw] } };

    void openPanel();
    await refreshPanel();

    const rawRow = panelContent().querySelectorAll('.cachelens-row-raw')[0];

    assert.ok(rawRow, 'a raw row should have rendered');
    assert.equal(rawRow.dataset.rowkey, 'raw:raw-render');
    assert.equal(rawRow.dataset.mesid, undefined);
});

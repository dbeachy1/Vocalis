import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { installDom } from './dom.js';
import { buildRawStamp, RAW_ENVELOPE_VERSION } from '../persist.js';
import { VERSION } from '../version.js';

/** @typedef {import('./dom.js').Element} Element */

/**
 * 🔴 THE PANEL RENDERS HERE OR IT RENDERS NOWHERE A TEST CAN SEE. `panel.js` and `index.js` statically
 * import SillyTavern, so the rest of the suite cannot touch them — and a syntax error in `panel.js` reached
 * `main` twice with 84 tests green. `test/parse.test.js` catches a file that will not parse; this catches
 * one that parses and then throws while drawing a row, which is the next failure along and the one that
 * would look, to a reader, exactly like the panel being empty.
 *
 * The loader below puts `test/stubs/` where the app would be, so the real `panel.js` runs against a real
 * `index.js`, `bar.js`, `record.js`, `prefix.js` and `attribution.js`. Nothing here is a copy of the code
 * under test.
 */
register(pathToFileURL('./test/loader.mjs'));

installDom();

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
const { openPanel, refreshPanel } = await import('../panel.js');

/**
 * What the fork route will answer, per path. A test assigns to this before drawing.
 * @type {Record<string, unknown>}
 */
let routes = {};

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
    const path = String(url);
    const body = routes[path];

    if (body === undefined) {
        return asResponse({ ok: false, status: 404, json: async () => ({}) });
    }

    return asResponse({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
};

/**
 * One entry of `itemizedPrompts`, carrying only the fields the panel reads.
 *
 * 🔴 DELIBERATELY PARTIAL. SillyTavern's record carries a dozen more section strings, and every one of them
 * is absent on some install or some turn — which is why `attribution.js` skips a section with no text rather
 * than treating it as an empty one. Inventing them here would test the panel against a turn no install
 * actually produces.
 * @param {number} mesId Which chat message this prompt produced
 * @param {string} prompt The prompt as the browser built it
 * @param {Partial<STItemizedPrompt>} [extra] Itemized fields to override
 * @returns {STItemizedPrompt} An itemized entry
 */
function itemized(mesId, prompt, extra = {}) {
    return {
        mesId,
        rawPrompt: prompt,
        this_max_context: 8_000,
        tokenizer: 'test',
        storyString: 'STORY',
        worldInfoString: 'WORLD',
        mesSendString: prompt,
        ...extra,
    };
}

/**
 * One drawer detail line's value, by its label — `.cachelens-detail` is `[label, value]` (`panel.js`'s
 * `detail()`): the collapsed row's former columns and `^-` notes line moved into these,
 * inside the drawer that opens on click.
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
 * @param {Element} row A row element
 * @returns {Promise<void>} When the refresh has drawn the open drawer
 */
async function expandRow(row) {
    const head = row.querySelector('.cachelens-head');

    assert.ok(head, 'a row must have a head to click');
    head.dispatch('click');
    await refreshPanel();
}

/**
 * The element the panel most recently drew into.
 *
 * ⚠️ ASKED FOR PER DRAW, NEVER HELD ACROSS ONE. `openPanel` builds a fresh container and a fresh popup every
 * time, so a root kept from an earlier test still matches every selector and answers about the wrong render.
 * @returns {Element} The root the panel drew into
 */
function drawn() {
    assert.ok(popup.lastPopup, 'the panel should have opened a popup to draw into');

    // The stub takes the content as an opaque object, because nothing about a popup depends on what it is
    // holding. The panel builds it out of `test/dom.js`, and this is where the test says so.
    return /** @type {Element} */ (popup.lastPopup.content);
}

/**
 * Draw the panel over a given chat and hand back its root element.
 *
 * Pad `chat` to cover every itemized `mesId`. `buildRows` requires `chatMessages[mesId]` to exist before an
 * itemized entry becomes a row (a `/gen` quiet
 * generation pushes one with no message behind it at all, and that must NOT become a phantom message row —
 * see `raw-requests.test.js` for the regression test). Every fixture in this file that passes a short `chat`
 * array alongside a larger `mesId` was always shorthand for "there is a real turn here", never a deliberate
 * claim that the message is missing — padding here keeps that intent true under the new rule without every
 * one of this file's tests having to restate it by hand. A test that wants to prove the phantom case itself
 * builds its own fixture directly against `buildRows`, bypassing this helper (see `raw-requests.test.js`).
 * Only fills a slot that is genuinely empty — an explicit message a test already put at that index (with
 * `is_user`, specific `mes` text, etc.) is never overwritten.
 * @param {STItemizedPrompt[]} entries Itemized entries, oldest first
 * @param {STChatMessage[]} chat The chat messages
 * @returns {Promise<Element>} The rendered panel
 */
async function draw(entries, chat) {
    script.itemizedPrompts.length = 0;
    script.itemizedPrompts.push(...entries);

    const padded = [...chat];

    for (const entry of entries) {
        const mesId = Number(entry.mesId);

        if (Number.isFinite(mesId) && !padded[mesId]) {
            padded[mesId] = { mes: `placeholder turn ${mesId}` };
        }
    }

    extensions.context.chat = padded;

    // `openPanel` awaits the popup, which never resolves, so it is deliberately not awaited here.
    void openPanel();
    await refreshPanel();

    return drawn();
}

test('the panel draws a row per turn without throwing', async () => {
    routes = {};

    const content = await draw(
        [itemized(1, 'SYSTEM\nUser: hello'), itemized(2, 'SYSTEM\nUser: hello\nBot: hi\nUser: again')],
        [{ mes: 'hello' }, { mes: 'hi' }, { mes: 'again' }],
    );
    const rows = content.querySelectorAll('.cachelens-row');

    assert.equal(rows.length, 2);
    assert.equal(content.querySelectorAll('.cachelens-bar').length, 2);
});

// 🔴 A GAP IN THE NUMBERS IS EXPECTED AND WAS READ AS A BUG. Rows are numbered by chat message, and a
// message with no recorded prompt has no row.
test('a break in the row numbering says what it is, where it is', async () => {
    routes = {};

    const content = await draw(
        [itemized(1, 'SYSTEM\nUser: hello'), itemized(9, 'SYSTEM\nUser: hello\nBot: hi\nUser: later')],
        [{ mes: 'hello' }, { mes: 'hi' }],
    );
    const gaps = content.querySelectorAll('.cachelens-gap');

    assert.equal(gaps.length, 1);
    assert.match(gaps[0].textContent, /#2–#8/);
    assert.match(gaps[0].textContent, /Expected, not a dropped turn/);
});

test('consecutive rows produce no gap line', async () => {
    routes = {};

    const content = await draw(
        [itemized(1, 'SYSTEM\nUser: hello'), itemized(2, 'SYSTEM\nUser: hello\nBot: hi')],
        [{ mes: 'hello' }, { mes: 'hi' }],
    );

    assert.equal(content.querySelectorAll('.cachelens-gap').length, 0);
    assert.doesNotMatch(content.textContent, /Numbered by chat message/);
});

// Generation messages use the id of the message they produce, so user messages create gaps between listed
// generations. The ordinary case draws nothing between rows.
test('the reader own messages put no line between the rows', async () => {
    routes = {};

    const content = await draw(
        [itemized(1, 'SYSTEM\nUser: hello'), itemized(3, 'SYSTEM\nUser: hello\nBot: hi\nUser: again')],
        [{ mes: 'hello', is_user: true }, { mes: 'hi' }, { mes: 'again', is_user: true }, { mes: 'sure' }],
    );

    assert.equal(content.querySelectorAll('.cachelens-gap').length, 0);
    assert.equal(content.querySelectorAll('.cachelens-row').length, 2);
    // The numbering is explained once, in the header, where it costs one line instead of nine.
    assert.match(content.textContent, /Numbered by chat message, so the ids step over your own messages/);
});

// Two messages sent before generating is ONE run, and it is silent for the same reason.
test('a run of the reader own messages is silent too', async () => {
    routes = {};

    const content = await draw(
        [itemized(1, 'SYSTEM\nUser: hello'), itemized(4, 'SYSTEM\nUser: hello\nBot: hi\nUser: again\nUser: still')],
        [
            { mes: 'hello', is_user: true },
            { mes: 'hi' },
            { mes: 'again', is_user: true },
            { mes: 'still', is_user: true },
            { mes: 'sure' },
        ],
    );

    assert.equal(content.querySelectorAll('.cachelens-gap').length, 0);
    assert.match(content.textContent, /Numbered by chat message/);
});

// 🔴 AND THE RARE ONE STILL GETS ITS LINE — that is the signal the nine captions were drowning. A rowless
// message that is not one the reader sent is a different fact, and the panel checked neither what it was
// nor that the reader sent it, so it stays uncommitted rather than claiming "your message".
test('a run the panel cannot account for still gets a line, and no header note', async () => {
    routes = {};

    const content = await draw(
        [itemized(1, 'SYSTEM\nUser: hello'), itemized(4, 'SYSTEM\nUser: hello\nBot: hi\nUser: again')],
        [{ mes: 'hello', is_user: true }, { mes: 'hi' }, { mes: 'again', is_user: true }, { mes: 'dropped' }, { mes: 'sure' }],
    );
    const gaps = content.querySelectorAll('.cachelens-gap');

    assert.equal(gaps.length, 1);
    assert.match(gaps[0].textContent, /#2–#3 — no prompt recorded/);
    assert.doesNotMatch(gaps[0].textContent, /your message/);
    // ⚠️ NOTHING ON SCREEN IS EXPLAINED BY THE NUMBERING NOTE HERE, so printing it would be padding that
    // also mis-attributes the one gap that IS showing.
    assert.doesNotMatch(content.textContent, /Numbered by chat message/);
});

// 🔴 §6.2b. A World Book rewriting the prompt every turn had no name anywhere in the panel.
//
// The `client-side: X changed` note used to print beside every
// row; it now lives in the drawer's "Changed in the browser" line, which is also where the header's old
// always-on "applied in the browser" sentence moved to (see the header test above). `mesId: 555` is unique to
// this test in the file, so this test cannot inherit an open/closed drawer state some other test left behind
// on a smaller, commonly reused id.
test('a client-side component that changed is named in the drawer', async () => {
    routes = {};

    const content = await draw(
        [
            itemized(554, 'SYSTEM\nUser: hello', { worldInfoString: 'ashwood' }),
            itemized(555, 'SYSTEM\nUser: hello\nBot: hi\nUser: again', { worldInfoString: 'greyhollow' }),
        ],
        [{ mes: 'hello' }, { mes: 'hi' }, { mes: 'again' }],
    );
    const row = content.querySelectorAll('.cachelens-row').find(candidate => candidate.dataset.mesid === '555');

    assert.ok(row, 'the newer turn should be a row');

    await expandRow(row);

    const opened = drawn().querySelectorAll('.cachelens-row').find(candidate => candidate.dataset.mesid === '555');

    assert.ok(opened, 'the row should still be there after the refresh');

    const changedInBrowser = detailValue(opened, 'Changed in the browser');

    assert.match(changedInBrowser ?? '', /World Info/);
    assert.match(changedInBrowser ?? '', /assembled in the browser/);
});

// The header used to carry an always-on muted line explaining that World
// Info, the author's note, summaries and vector results are applied in the browser — printed whether or not
// it mattered to anything on screen. That explanation now lives only where it is actually relevant: a
// row's "Changed in the browser" drawer line, printed only when one of those actually changed for that turn
// (see the client-side test right below this one).
test('the always-on browser-applied line is gone from the header', async () => {
    routes = {};

    const content = await draw([itemized(1, 'SYSTEM\nUser: hello')], [{ mes: 'hello' }]);
    const header = content.querySelectorAll('.cachelens-mode-line').map(node => node.textContent).join(' ');

    assert.doesNotMatch(header, /applied in the browser, so no server plugin list will ever name them/);
});

// The visible version identifies the module that rendered the panel when a per-user copy shadows the global
// extension or an open tab still holds old modules.
test('the header stamps the version of the code that drew the panel', async () => {
    routes = {};

    const content = await draw([itemized(1, 'SYSTEM\nUser: hello')], [{ mes: 'hello' }]);
    const stamp = content.querySelectorAll('.cachelens-version');

    assert.equal(stamp.length, 1);
    assert.equal(stamp[0].textContent, `Cache Lens ${VERSION}`);

    // It rides with the rows, not in a separate view a screenshot could crop out or a reader forget to open.
    assert.ok(content.querySelectorAll('.cachelens-row').length > 0);
});

test('an empty chat says so rather than drawing nothing', async () => {
    routes = {};

    const content = await draw([], []);

    assert.equal(content.querySelectorAll('.cachelens-row').length, 0);
    assert.match(content.textContent, /No turns with a recorded prompt/);
});

// ⚠️ An entry with an empty prompt is a turn the panel can say nothing about. It is left out, and the count
// of what was left out must say what it actually is — it used to announce them as chat-completion turns.
test('turns with no prompt are counted honestly, not as hidden chat completions', async () => {
    routes = {};

    const content = await draw(
        [itemized(1, ''), itemized(2, 'SYSTEM\nUser: hello')],
        [{ mes: 'hello' }],
    );
    const header = content.querySelectorAll('.cachelens-mode-line').map(node => node.textContent).join(' ');

    assert.match(header, /1 turn\(s\) not listed/);
    assert.doesNotMatch(header, /chat-completion turn\(s\) hidden/);
});

test('the expansion opens on click and names where the prompt changed', async () => {
    routes = {};

    const content = await draw(
        [itemized(1, 'SYSTEM\nWORLD\nUser: hello'), itemized(2, 'SYSTEM\nWORLD-changed\nUser: hello')],
        [{ mes: 'hello' }, { mes: 'hi' }],
    );

    content.querySelectorAll('.cachelens-head')[0].dispatch('click');
    await refreshPanel();

    const expansion = drawn().querySelector('.cachelens-expansion');

    assert.ok(expansion, 'clicking a row should open its expansion');
    // The diff view's own head line ("Changed at char…") was dropped so it would not
    // duplicate the drawer's own "Changed since last turn" detail line, which now states the same fact in
    // plainer words (in tokens when the stub tokenizer answered, in characters otherwise).
    assert.match(detailValue(drawn().querySelectorAll('.cachelens-row')[0], 'Changed since last turn') ?? '', /^at (char|token) \d/);
});

// 🔴 A GREYED ROW'S DIFF IS TESTED IN `test/panel-greyed.test.js`, ITS OWN FILE. `hasServerPlugins()` (like
// `probeRecord()`) memoises per module instance, and every test above this line in this file has already
// called it with `routes = {}` (a 404), latching `serverPluginsSeen` to `false` for the rest of this file's
// run — this file's `routes` object is mutable per test, but that particular cached answer is not. Getting a
// row greyed at all needs `hasServerPlugins()` to answer `true` on its FIRST call, which only a dedicated
// file, probed before anything else runs, can guarantee.

// A native `<button>` gets Enter/Space activation for free; the
// row head is a `<div role="button">` (it also has to contain the bar, summary and view button), so this is
// what makes it actually reachable from the keyboard rather than merely labelled as one.
/**
 * @param {Element} root The panel root
 * @param {string} mesId Which message row, as `dataset.mesid` carries it
 * @returns {Element} The row element
 */
function findRow(root, mesId) {
    const row = root.querySelectorAll('.cachelens-row').find(candidate => candidate.dataset.mesid === mesId);

    assert.ok(row, `no row for #${mesId}`);

    return row;
}

/**
 * @param {Element} row A row element
 * @returns {Element} Its head
 */
function headOf(row) {
    const head = row.querySelector('.cachelens-head');

    assert.ok(head, 'a row must have a head');

    return head;
}

test('Enter and Space on a row head toggle its drawer, same as a click', async () => {
    routes = {};

    const content = await draw(
        [itemized(556, 'SYSTEM\nWORLD\nUser: hello'), itemized(557, 'SYSTEM\nWORLD-changed\nUser: hello')],
        [{ mes: 'hello' }, { mes: 'hi' }],
    );
    const head = headOf(findRow(content, '557'));

    assert.equal(head.getAttribute('aria-expanded'), 'false');

    head.dispatch('keydown', { key: 'Enter' });
    await refreshPanel();

    let row = findRow(drawn(), '557');

    assert.ok(row.querySelector('.cachelens-expansion'), 'Enter should open the drawer');
    assert.equal(headOf(row).getAttribute('aria-expanded'), 'true');

    headOf(row).dispatch('keydown', { key: ' ' });
    await refreshPanel();

    row = findRow(drawn(), '557');
    assert.equal(row.querySelectorAll('.cachelens-expansion').length, 0, 'Space should close it again');

    // A key that is neither Enter nor Space must not toggle it.
    headOf(row).dispatch('keydown', { key: 'Tab' });
    await refreshPanel();

    row = findRow(drawn(), '557');
    assert.equal(row.querySelectorAll('.cachelens-expansion').length, 0, 'an unrelated key must not toggle it');
});

// `keydown` bubbles: pressing Enter while the
// `view` button itself has focus reaches `head`'s own keydown listener too, since the button is a descendant
// of `head`. Without the `event.target !== head` guard `panel.js` now has, that keypress both opened the
// button's popup (or, for a raw row past its server memory, showed the toast) AND toggled the drawer.
// `dispatch`'s `target` override (`test/dom.js`) is what lets this test simulate the bubbled event's shape
// without a real bubbling DOM: `target` is the button, `head.dispatch(...)` is where the (bubbled) listener
// actually runs, exactly as it would in a browser.
test('Enter on the view button does not also toggle the row\'s drawer', async () => {
    routes = {};

    const content = await draw(
        [itemized(560, 'SYSTEM\nWORLD\nUser: hello'), itemized(561, 'SYSTEM\nWORLD-changed\nUser: hello')],
        [{ mes: 'hello' }, { mes: 'hi' }],
    );
    const row = findRow(content, '561');
    const head = headOf(row);
    const view = row.querySelector('.cachelens-view');

    assert.ok(view, 'the row should have a view button');
    assert.equal(head.getAttribute('aria-expanded'), 'false');

    // The bubbled keydown, as `head`'s listener would actually receive it: `target` is the button.
    head.dispatch('keydown', { key: 'Enter', target: view });
    await refreshPanel();

    const after = findRow(drawn(), '561');

    assert.equal(after.querySelectorAll('.cachelens-expansion').length, 0, 'Enter on the view button must not open the drawer');
    assert.equal(headOf(after).getAttribute('aria-expanded'), 'false');

    // A keydown with no `target` override still defaults to `head` itself (`test/dom.js`'s `dispatch`), so
    // the ordinary activation path — Enter pressed while the row itself has focus — is unaffected by the
    // guard and still toggles it, same as the test above.
    headOf(after).dispatch('keydown', { key: 'Enter' });
    await refreshPanel();

    assert.ok(findRow(drawn(), '561').querySelector('.cachelens-expansion'), 'Enter on the head itself should still toggle it');
});

// =====================================================================================================
// Raw generation rows (DESIGN_RAW_GENERATION_ROWS.md). panel.js is coded against the pinned row/Mode
// contract even though `index.js` (a concurrent coder's file, off limits here) does not merge
// `chatMetadata.cacheLens.rawRequests` into `buildRows()`'s output yet — so every test below documents the
// contract panel.js already honours and is UNVERIFIED end to end until that seam closes. See this coder's
// report for exactly which assertions are expected to be red for that reason alone.
// =====================================================================================================

/**
 * A raw-generation stamp, validated through the real `persist.js` normalizer — the same one `index.js` will
 * call once it merges `chatMetadata.cacheLens.rawRequests` into rows. Building it through `buildRawStamp`
 * rather than a hand-written object literal means this fixture can never drift from what the real
 * validation actually accepts.
 * @param {Record<string, unknown>} [overrides] Fields to override
 * @returns {import('../persist.js').RawRequestStamp} The stamp
 */
function rawStamp(overrides = {}) {
    const stamp = buildRawStamp({
        id: 'raw-1', backend: 'chat', apiType: 'deepseek', seq: '501', generationType: 'quiet',
        requestedAt: 5_000, completedAt: 5_200, status: 'completed', usageState: 'available',
        inputTokens: 1_200, cachedTokens: 900, uncachedTokens: 300,
        ...overrides,
    });

    assert.ok(stamp, 'the fixture itself must be a valid RawRequestStamp');

    return /** @type {import('../persist.js').RawRequestStamp} */ (stamp);
}

/**
 * Install raw-generation stamps into the chat's metadata, in the shape `readRawRequests` expects
 * (DESIGN_RAW_GENERATION_ROWS.md §7.1).
 * @param {import('../persist.js').RawRequestStamp[]} stamps The stamps
 * @returns {void}
 */
function setRawRequests(stamps) {
    extensions.context.chatMetadata = { cacheLens: { v: RAW_ENVELOPE_VERSION, rawRequests: stamps } };
}

test('a raw row renders the RAW badge, its own class, the exact tooltip, and an aria-label', async () => {
    routes = {};
    setRawRequests([rawStamp()]);

    const content = await draw([itemized(1, 'SYSTEM\nUser: hello')], [{ mes: 'hello' }]);
    const rawRows = content.querySelectorAll('.cachelens-row-raw');

    assert.equal(rawRows.length, 1, 'exactly one raw row should render');

    const row = rawRows[0];

    assert.match(row.textContent, /RAW/);
    assert.equal(row.title, 'Raw generation request (SillyTavern quiet generation). It is not part of roleplay chat history.');

    const ariaLabel = row.getAttribute('aria-label');

    assert.ok(ariaLabel, 'the row must carry an aria-label');
    assert.equal(ariaLabel, row.title);
    assert.ok(ariaLabel.length > 0, 'the aria-label must not be empty');
});

// Raw rows expose a `view` button and an expandable drawer, matching message-row interaction. The button is
// named `view`; it is not a copy control.
test('a raw row has a view button, not a copy control, and clicking it opens a drawer', async () => {
    routes = {};
    setRawRequests([rawStamp()]);

    const content = await draw([itemized(1, 'SYSTEM\nUser: hello')], [{ mes: 'hello' }]);
    const row = content.querySelectorAll('.cachelens-row-raw')[0];

    assert.equal(row.querySelectorAll('.cachelens-copy').length, 0, 'there was never a copy control on a raw row');
    assert.equal(row.querySelectorAll('.cachelens-view').length, 1, 'a raw row must always offer a view button');

    const head = row.querySelector('.cachelens-head');

    assert.ok(head, 'a raw row has a head to click');
    head.dispatch('click');
    await refreshPanel();

    const afterClick = drawn().querySelectorAll('.cachelens-row-raw')[0];

    assert.equal(afterClick.querySelectorAll('.cachelens-expansion').length, 1, 'clicking a raw row should now open its drawer');
    assert.equal(headOf(afterClick).getAttribute('aria-expanded'), 'true');
});

test('raw and message rows interleave in one list and only ten render', async () => {
    routes = {};
    setRawRequests(Array.from({ length: 4 }, (_, index) => rawStamp({ id: `raw-${index}`, requestedAt: 100 + index * 10 })));

    const entries = Array.from({ length: 8 }, (_, index) => itemized(index + 1, `SYSTEM\nUser: turn ${index}`));
    const chat = entries.map((_, index) => ({ mes: `turn ${index}` }));

    const content = await draw(entries, chat);

    assert.equal(content.querySelectorAll('.cachelens-row').length, 10);
});

test('a raw row between two message rows creates no gap, and a genuine message gap still appears above the right row', async () => {
    routes = {};
    // The raw row's own timestamp is irrelevant to gap computation — raw rows never enter `messageRows` at
    // all (DESIGN_RAW_GENERATION_ROWS.md §8), so it can sit anywhere in `requestedAt` order without creating
    // or hiding a message-id gap.
    setRawRequests([rawStamp({ id: 'raw-mid', requestedAt: 5 })]);

    const content = await draw(
        [itemized(1, 'SYSTEM\nUser: hello'), itemized(9, 'SYSTEM\nUser: hello\nBot: hi\nUser: later')],
        [{ mes: 'hello' }, { mes: 'hi' }],
    );
    const gaps = content.querySelectorAll('.cachelens-gap');

    // Exactly the one genuine #2-#8 message gap — never a second, phantom one around the raw row.
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].textContent, /#2–#8/);
});

// The collapsed row's old `renderRawCounts`/`renderRawMeasured`
// columns (`500 input`, `cached 0 · uncached 500`, etc.) are gone — the collapsed row now shows only
// `bar.js`'s `summaryFor`, and the fuller `N input` phrasing moved into the drawer's "Input" line. This test
// checks the collapsed summary text for all five states, and the drawer's "Input" line for the one state
// that actually has numbers to show.
test('raw usage states render distinctly and never fabricate a zero', async () => {
    routes = {};
    setRawRequests([
        rawStamp({
            id: 'raw-avail', requestedAt: 10, status: 'completed', usageState: 'available',
            inputTokens: 500, cachedTokens: 0, uncachedTokens: 500,
        }),
        rawStamp({
            id: 'raw-absent', requestedAt: 20, status: 'completed', usageState: 'absent',
            inputTokens: null, cachedTokens: null, uncachedTokens: null,
        }),
        rawStamp({
            id: 'raw-invalid', requestedAt: 30, status: 'completed', usageState: 'invalid',
            inputTokens: null, cachedTokens: null, uncachedTokens: null,
        }),
        rawStamp({
            id: 'raw-failed', requestedAt: 40, status: 'failed', usageState: 'absent',
            inputTokens: null, cachedTokens: null, uncachedTokens: null,
        }),
        rawStamp({
            id: 'raw-cancelled', requestedAt: 50, status: 'cancelled', usageState: 'absent',
            inputTokens: null, cachedTokens: null, uncachedTokens: null,
        }),
    ]);

    const content = await draw([], []);
    const rows = content.querySelectorAll('.cachelens-row-raw');

    assert.equal(rows.length, 5);

    /**
     * @param {Element} row A raw row
     * @returns {string} Its collapsed summary text
     */
    const summaryTextOf = (row) => {
        const summaryEl = row.querySelector('.cachelens-summary');

        assert.ok(summaryEl, 'a raw row must always show a summary');

        return summaryEl.textContent;
    };
    const summaries = rows.map(summaryTextOf);

    // A REAL cache-hit count of 0 is not suppressed — only a MISSING or INVALID one is.
    assert.ok(summaries.some(text => text === 'cached 0 (0.0%) · uncached 500 (100.0%)'), summaries.join(' || '));
    assert.ok(summaries.some(text => text === 'usage not reported'), summaries.join(' || '));
    assert.ok(summaries.some(text => text === 'invalid usage reported'), summaries.join(' || '));
    assert.ok(summaries.some(text => text === 'failed'), summaries.join(' || '));
    assert.ok(summaries.some(text => text === 'cancelled'), summaries.join(' || '));

    // 🔴 NEVER A BARE 0 WHERE A COUNT WOULD BE, for every row except the one that legitimately measured a
    // zero cache-hit count above.
    for (const text of summaries) {
        if (!text.startsWith('cached 0')) {
            assert.doesNotMatch(text, /\b0\b/, `a non-available raw row must never print a bare 0: "${text}"`);
        }
    }

    // The fuller phrasing, with the real zero still visible, lives in the drawer now.
    const available = rows.find(row => summaryTextOf(row).startsWith('cached 0'));

    assert.ok(available, 'the available-usage raw row should be findable by its summary');
    await expandRow(available);

    const opened = drawn().querySelectorAll('.cachelens-row-raw').find(row => summaryTextOf(row).startsWith('cached 0'));

    assert.ok(opened, 'the same row should still be there after the refresh');
    assert.equal(detailValue(opened, 'Input'), '500 tokens — cached 0 (0.0%), uncached 500 (100.0%)');
});

/**
 * @param {Element} root The panel root
 * @param {number} mesId Which message row
 * @returns {Element} The row element
 *
 * ⚠️ LOOKED UP BY `dataset.mesid`, NEVER BY POSITION. `buildRows()`'s newest-first ordering mixes raw and
 * message rows by `requestedAt`, and this test's raw stamp does not know or care where index.js's tie-break
 * places it relative to the two message rows — the point under test is `rowKey` identity surviving a
 * refresh, not any particular DOM position.
 */
function messageRowByMesId(root, mesId) {
    const row = root.querySelectorAll('.cachelens-row').find(candidate => candidate.dataset.mesid === String(mesId));

    assert.ok(row, `no message row for #${mesId}`);

    return row;
}

// Expansion state is keyed by `rowKey`, so unrelated message and raw rows toggle independently and refreshes
// preserve the open state.
test('expansion is keyed by rowKey: rows toggle independently, and a refresh preserves what is open', async () => {
    routes = {};
    setRawRequests([rawStamp({ id: 'raw-solo', requestedAt: 1 })]);

    // 🔴 `expanded` IS MODULE STATE THAT OUTLIVES ONE TEST, BY DESIGN — it is how a refresh preserves what
    // the reader opened, and every test in this file shares the one `panel.js` module instance. mesId 777 is
    // used nowhere else in this file, so this test cannot inherit an open/closed state some earlier test's
    // click left behind on a smaller, commonly reused id (1, 2, 3, 9 all recur above). `draw()`'s own padding
    // (see its header comment) gives mesId 777 a real placeholder message so it is not treated as the
    // `/gen` phantom case this fix removes.
    await draw(
        [itemized(1, 'SYSTEM\nUser: hello'), itemized(777, 'SYSTEM\nUser: hello\nBot: hi\nUser: again')],
        [{ mes: 'hello' }, { mes: 'hi' }, { mes: 'again' }],
    );

    const clickHead = messageRowByMesId(drawn(), 777).querySelector('.cachelens-head');

    assert.ok(clickHead, 'the message row has a head to click');
    clickHead.dispatch('click');
    await refreshPanel();

    const rawRowAfterClick = drawn().querySelectorAll('.cachelens-row-raw')[0];

    assert.equal(rawRowAfterClick.querySelectorAll('.cachelens-expansion').length, 0, 'an raw row that was never clicked stays closed');
    assert.ok(messageRowByMesId(drawn(), 777).querySelector('.cachelens-expansion'), 'the clicked message row should be expanded');

    // A refresh with nothing newly clicked must not collapse what is already open — the whole point of
    // keying `expanded` by `rowKey` rather than recreating it from scratch on every draw.
    await refreshPanel();

    assert.ok(messageRowByMesId(drawn(), 777).querySelector('.cachelens-expansion'), 'a refresh must preserve the open expansion');

    // And the raw row expands independently, on its own click — the rowKey-keyed `expanded` Set holds both
    // states at once without either disturbing the other.
    headOf(drawn().querySelectorAll('.cachelens-row-raw')[0]).dispatch('click');
    await refreshPanel();

    assert.ok(drawn().querySelectorAll('.cachelens-row-raw')[0].querySelector('.cachelens-expansion'), 'the raw row should now be expanded too');
    assert.ok(messageRowByMesId(drawn(), 777).querySelector('.cachelens-expansion'), 'the message row is still expanded, undisturbed by the raw row\'s own click');
});

test('a raw envelope this build cannot read is reported once in the header, not silently dropped', async () => {
    routes = {};
    // A future envelope version — `persist.js`'s own `readRawRequests` already refuses this (§7.2, §13); the
    // header text is panel.js's job once `index.js` surfaces `mode.rawEnvelopeUnreadable`. Unverified until
    // that wiring lands.
    extensions.context.chatMetadata = { cacheLens: { v: RAW_ENVELOPE_VERSION + 1, rawRequests: [] } };

    const content = await draw([itemized(1, 'SYSTEM\nUser: hello')], [{ mes: 'hello' }]);
    const header = content.querySelectorAll('.cachelens-mode-line').map(node => node.textContent).join(' ');

    assert.match(header, new RegExp(`schema v${RAW_ENVELOPE_VERSION + 1}`));
});

import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { installDom } from './dom.js';

/** @typedef {import('./dom.js').Element} Element */

/**
 * The panel with a server plugin loaded and no record support at all — the combination that greys a row
 * (`record.js`'s `provenanceFor`, DESIGN.md §6.3).
 *
 * ⚠️ ITS OWN FILE BECAUSE `hasServerPlugins` MEMOISES, the same reason `panel-record.test.js` and
 * `persist-panel.test.js` are each their own file. It answers once per module instance from whatever
 * `/api/plugins/client-config` said on its FIRST call — every other test file's first call 404s that route
 * (no plugin), latching `false` for the rest of that file's run — so getting a genuinely greyed row needs a
 * file whose very first network call answers with a plugin present.
 *
 * A greyed row still shows its diff, clearly labeled as computed from the browser's copy. This file exercises
 * that path end to end with the plugin present on the module's first configuration request.
 */
register(pathToFileURL('./test/loader.mjs'));

installDom();

globalThis.SillyTavern = { libs: { sha256: text => `h(${text.length}:${text.slice(0, 12)})` } };

/**
 * @param {RequestInfo|URL} url What was asked for
 * @returns {Promise<Response>} The stubbed reply
 */
globalThis.fetch = async (url) => {
    const path = String(url);

    if (path === '/api/plugins/client-config') {
        // Any 200 means a plugin is loaded — `hasServerPlugins()` reads only `response.ok`.
        return /** @type {Response} */ (/** @type {unknown} */ ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }));
    }

    // '/api/prompt-record/' and anything else: a 404, same as a fork build with no record route at all —
    // `provenanceFor`'s "no record support, but a plugin is loaded" branch is what this file means to test.
    return /** @type {Response} */ (/** @type {unknown} */ ({ ok: false, status: 404, json: async () => ({}) }));
};

// 🔴 THE LOADER PUTS `test/stubs/` HERE, AND THESE CASTS ARE WHERE THAT IS DECLARED — the same rule the
// other panel test files state.
const script = await import('../../../script.js');
const extensions = /** @type {typeof import('./stubs/extensions.js')} */ (
    /** @type {unknown} */ (await import('../../../extensions.js')));
const popup = /** @type {typeof import('./stubs/popup.js')} */ (
    /** @type {unknown} */ (await import('../../../popup.js')));
const { openPanel, refreshPanel } = await import('../panel.js');

/**
 * One entry of `itemizedPrompts`, carrying only the fields the panel reads.
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
        storyString: 'STORY',
        worldInfoString: 'WORLD',
        mesSendString: prompt,
    };
}

script.itemizedPrompts.push(
    itemized(1, 'SYSTEM\nWORLD\nUser: hello'),
    itemized(2, 'SYSTEM\nWORLD-changed\nUser: hello'),
);
// 🔴 THREE MESSAGES, NOT TWO — 2026-09-18, THE `/gen` PHANTOM-ROW FIX. `buildRows` now requires
// `chatMessages[mesId]` to actually exist for an itemized entry to become a row, and this file's two
// itemized entries above use mesId 1 and 2 — `chat[2]` needs a real message behind it, or the turn under
// test here would itself be filtered out as the very phantom case that fix exists to catch.
extensions.context.chat = [{ mes: 'hello' }, { mes: 'hi' }, { mes: 'again' }];

void openPanel();
await refreshPanel();

/**
 * The element the panel drew into.
 * @returns {Element} The root the panel drew into
 */
function drawn() {
    assert.ok(popup.lastPopup, 'the panel should have opened a popup to draw into');

    return /** @type {Element} */ (popup.lastPopup.content);
}

/**
 * One drawer detail line's value, by its label.
 * @param {Element} row A row element (already expanded)
 * @param {string} label The detail line's fixed label
 * @returns {string|undefined} The value text, or undefined when that line was not printed
 */
function detailValue(row, label) {
    const found = row.querySelectorAll('.cachelens-detail').find(candidate => candidate.children[0]?.textContent === label);

    return found?.children[1]?.textContent;
}

test('a turn with no record and a plugin loaded is greyed', () => {
    const row = drawn().querySelectorAll('.cachelens-row')[0];

    assert.ok(row, 'the newer turn should be a row');
    assert.ok(row.querySelector('.cachelens-bar')?.classList.contains('cachelens-bar-greyed'), 'the bar should be drawn greyed');
});

// 🔴 THE RESTORED RULE ITSELF: "a reader who clicked in is asking for whatever there is, so it is shown WITH
// what it was computed from stated first. What §6.3 forbids is presenting the browser's copy as the sent
// prompt, not showing it at all." — the original expansion's own comment, reinstated in `panel.js` after an
// intermediate version of this redesign briefly suppressed the diff for a greyed row entirely.
test('a greyed row still shows the diff, captioned as the browser\'s own copy', async () => {
    const row = drawn().querySelectorAll('.cachelens-row')[0];
    const head = row.querySelector('.cachelens-head');

    assert.ok(head, 'the row should have a head to click');
    head.dispatch('click');
    await refreshPanel();

    const opened = drawn().querySelectorAll('.cachelens-row')[0];
    const changed = detailValue(opened, 'Changed since last turn');

    assert.match(changed ?? '', /^at (char|token) \d/, 'the position is still stated, not withheld');
    assert.match(changed ?? '', /compared using the browser's copy, which may not be what the server sent/);

    const changedRow = opened.querySelectorAll('.cachelens-detail').find(candidate => candidate.children[0]?.textContent === 'Changed since last turn');

    assert.ok(changedRow, 'the "Changed since last turn" line should be present');
    assert.equal(changedRow.classList.contains('cachelens-warn'), true);

    // And the diff view itself — prev/this lines and the ruler — is drawn, not skipped.
    assert.ok(opened.querySelectorAll('.cachelens-line').length > 0, 'the diff lines should still be drawn for a greyed row');
    assert.ok(opened.querySelector('.cachelens-ruler'), 'the ruler should still be drawn for a greyed row');

    // No priced verdict, though — `verdictFor` (bar.js) refuses a greyed row on its own, regardless of what
    // this drawer does.
    assert.equal(opened.querySelectorAll('.cachelens-verdict').length, 0, 'a greyed row must never carry a priced verdict');
});

import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { installDom } from './dom.js';

/** @typedef {import('./dom.js').Element} Element */

/**
 * The panel on a CHAT-COMPLETION chat, where SillyTavern itemizes the prompt as a message array.
 *
 * Chat-completion entries carry a message array in `generate_data.prompt`; `buildRows` must normalize that array
 * with `JSON.stringify` so it matches the request representation.
 *
 * ⚠️ ITS OWN FILE BECAUSE `main_api` AND THE RECORD PROBE ARE MODULE STATE. Every other suite runs as text
 * completion; `node --test` gives this file its own registry, so it can be chat completion from the first
 * import without disturbing anyone.
 */
register(pathToFileURL('./test/loader.mjs'));

installDom();

globalThis.SillyTavern = { libs: { sha256: text => `h(${text.length}:${text.slice(0, 12)})` } };

/** A multi-line lorebook entry — the newline is what a verbatim search inside JSON can never find. */
const LORE = '[Lore: Sample Town]\nSample Town is a mining town in the north.\n';
const SYSTEM = `You are Marla.\n${LORE}`;
const REPLY = 'Hi there, "traveller".';

/** The first generation's prompt, as SillyTavern's `getChat()` builds it: `{role, content}`, in that order. */
const MESSAGES_1 = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'hello' },
];

/** The second: the first, plus the reply it produced, plus the reader's next message. */
const MESSAGES_2 = [
    ...MESSAGES_1,
    { role: 'assistant', content: REPLY },
    { role: 'user', content: 'again' },
];

const TEXT_1 = JSON.stringify(MESSAGES_1);
const TEXT_2 = JSON.stringify(MESSAGES_2);

/**
 * A fork record for one chat-completion generation, the way `chat-completions.js` writes it: `text` is
 * `JSON.stringify(messages)`, and `hash` is that string's hash.
 * @param {number} seq Its seq
 * @param {string} text The recorded prompt
 * @param {object} [extra] Anything else on the record
 * @returns {object} The record, as the route sends it
 */
function chatRecord(seq, text, extra = {}) {
    return {
        seq, prevSeq: seq > 1 ? seq - 1 : null, at: seq * 1_000, backend: 'chat', apiType: 'custom',
        chatId: 'chat-under-test', genType: 'normal', length: text.length,
        hash: `h(${text.length}:${text.slice(0, 12)})`, rewrittenBy: [], rewriteSites: [], text,
        status: 'completed', ...extra,
    };
}

/** @type {Record<string, unknown>} */
const routes = {
    '/api/prompt-record/': { supported: true, depth: 10, backends: ['text', 'chat', 'kobold', 'novel'] },
    '/api/prompt-record/chat': {
        supported: true,
        depth: 10,
        backend: 'chat',
        records: [
            chatRecord(1, TEXT_1),
            chatRecord(2, TEXT_2, {
                usageState: 'available',
                usage: { schema: 'input-cache-v1', inputTokens: 40, cachedTokens: 30, uncachedTokens: 10, provider: 'deepseek', api: 'chat-completions' },
            }),
        ],
    },
};

/**
 * @param {{ok: boolean, status: number, headers?: {get: () => string|null}, json: () => Promise<unknown>}} reply
 *   The four members `record.js` reads — see `panel-record.test.js` for why this is not a `Response`
 * @returns {Response} It, as `fetch` promises to return
 */
function asResponse(reply) {
    return /** @type {Response} */ (/** @type {unknown} */ (reply));
}

globalThis.fetch = async (url) => {
    const body = routes[String(url)];

    if (body === undefined) {
        return asResponse({ ok: false, status: 404, json: async () => ({}) });
    }

    return asResponse({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
};

const script = /** @type {typeof import('./stubs/script.js')} */ (
    /** @type {unknown} */ (await import('../../../script.js')));
const extensions = /** @type {typeof import('./stubs/extensions.js')} */ (
    /** @type {unknown} */ (await import('../../../extensions.js')));
const popup = /** @type {typeof import('./stubs/popup.js')} */ (
    /** @type {unknown} */ (await import('../../../popup.js')));
const { buildRows } = await import('../index.js');
const persist = await import('../persist.js');
const { openPanel, refreshPanel } = await import('../panel.js');

script.setMainApi('openai');

/**
 * One chat-completion itemized entry: `rawPrompt` is the message ARRAY, exactly as SillyTavern stores it.
 * @param {number} mesId The message this generation produced
 * @param {Array<{role: string, content: string}>} messages The prompt
 * @returns {STItemizedPrompt} The entry
 */
function itemized(mesId, messages) {
    return {
        mesId,
        rawPrompt: messages,
        this_max_context: 8_000,
        tokenizer: 'test',
        storyString: SYSTEM,
        worldInfoString: LORE,
    };
}

script.itemizedPrompts.push(itemized(1, MESSAGES_1), itemized(3, MESSAGES_2));
extensions.context.chat = [
    { mes: 'hello', is_user: true },
    { mes: REPLY },
    { mes: 'again', is_user: true },
    { mes: 'Sure.' },
];

test('🔴 a chat-completion turn is a row, not a dropped entry', async () => {
    const { messageRows, droppedRows } = await buildRows();

    assert.deepEqual(messageRows.map(row => row.mesId), [3, 1]);
    assert.equal(droppedRows, 0, 'a message array is a prompt; nothing was dropped');
});

test('the row compares the message array at the level the fork records it', async () => {
    const { messageRows } = await buildRows();
    const newest = messageRows[0];

    assert.equal(newest.promptKnown, true);
    assert.equal(newest.promptText, TEXT_2);
    assert.equal(newest.promptChars, TEXT_2.length);
});

// §4.1 on a message array: the cache's copy grew by the reply, which comes back as the next assistant message.
// The reusable prefix therefore runs through that reply and stops where the reader's new message begins.
test('the reusable prefix runs through the previous reply, not just the previous prompt', async () => {
    const { messageRows } = await buildRows();
    const newest = messageRows[0];
    const readerTail = '},{"role":"user","content":"again"}]';

    assert.equal(newest.hasBaseline, true);
    assert.equal(newest.prefixChars, TEXT_2.length - readerTail.length);
    assert.ok(newest.prefixChars > TEXT_1.length, 'reuse extends past the whole previous prompt');
});

test('a multi-line lorebook inside a message is found, not reported as trimmed out', async () => {
    const { messageRows } = await buildRows();

    assert.equal(messageRows[0].clientUnplaced.includes('World Info'), false);
    assert.equal(messageRows[1].clientUnplaced.includes('World Info'), false);
});

test('the matched record\'s usage draws the bar', async () => {
    const { messageRows } = await buildRows();

    assert.equal(messageRows[0].measurementSource, 'live');
    assert.equal(messageRows[0].timings?.cache_n, 30);
    assert.equal(messageRows[0].timings?.prompt_n, 10);
});

test('an empty message array is still no prompt', async () => {
    script.itemizedPrompts.push({ mesId: 5, rawPrompt: [], this_max_context: 8_000, tokenizer: 'test' });
    extensions.context.chat.push({ mes: 'hm', is_user: true }, { mes: 'Mm.' });

    try {
        const { messageRows, droppedRows } = await buildRows();

        assert.equal(messageRows.some(row => row.mesId === 5), false);
        assert.equal(droppedRows, 1);
    } finally {
        script.itemizedPrompts.pop();
        extensions.context.chat.length = 4;
    }
});

// Mixed text/chat histories can contain timed older turns and untimed newer turns. The newest rows must remain
// above older ones, with raw rows kept in their corresponding positions.
test('🔴 an untimed newer turn sorts above timed older ones, and a raw row keeps its place between them', async () => {
    const savedPrompts = script.itemizedPrompts.splice(0);
    const savedChat = extensions.context.chat;
    const savedMetadata = extensions.context.chatMetadata;
    const stampAt = (/** @type {number} */ at, /** @type {string} */ seq) => ({
        cacheLens: persist.buildStamp({ seq, at, requestAt: at, promptChars: 500, eligibleChars: 400 }),
    });
    // Nothing a record could claim by hash or by elimination: two records, two candidate turns.
    const later = [{ role: 'system', content: 'Other system.' }, { role: 'user', content: 'later' }];

    extensions.context.chat = [
        { mes: 'a', is_user: true },
        { mes: 'old reply one', extra: stampAt(1_000, '70') },
        { mes: 'b', is_user: true },
        { mes: 'old reply two', extra: stampAt(2_000, '71') },
        { mes: 'c', is_user: true },
        { mes: 'new reply one' },
        { mes: 'd', is_user: true },
        { mes: 'new reply two' },
    ];
    extensions.context.chatMetadata = {
        cacheLens: {
            v: persist.RAW_ENVELOPE_VERSION,
            rawRequests: [persist.buildRawStamp({
                id: 'raw-between', backend: 'chat', apiType: 'custom', seq: '72', generationType: 'quiet',
                requestedAt: 1_500, completedAt: 1_600, status: 'completed', usageState: 'absent',
            })],
        },
    };
    script.itemizedPrompts.push(
        { mesId: 1, rawPrompt: '', this_max_context: 8_000, tokenizer: 'test' },
        { mesId: 3, rawPrompt: '', this_max_context: 8_000, tokenizer: 'test' },
        itemized(5, later),
        itemized(7, [...later, { role: 'assistant', content: 'new reply one' }, { role: 'user', content: 'd' }]),
    );

    try {
        const { rows } = await buildRows();

        assert.deepEqual(rows.map(row => row.rowKey), ['message:7', 'message:5', 'message:3', 'raw:raw-between', 'message:1']);
        assert.equal(rows[0].requestedAt, null, 'the borrowed sort time is never recorded as the row\'s own');
    } finally {
        script.itemizedPrompts.splice(0, script.itemizedPrompts.length, ...savedPrompts);
        extensions.context.chat = savedChat;
        extensions.context.chatMetadata = savedMetadata;
    }
});

test('🔴 the panel draws the rows and says nothing about turns not listed', async () => {
    void openPanel();
    await refreshPanel();

    assert.ok(popup.lastPopup, 'the panel should have opened');

    const content = /** @type {Element} */ (popup.lastPopup.content);

    assert.equal(content.querySelectorAll('.cachelens-row').length, 2);
    assert.doesNotMatch(content.textContent, /not listed/);
    assert.doesNotMatch(content.textContent, /No turns with a recorded prompt/);
    assert.equal(content.querySelectorAll('.cachelens-summary')[0].textContent, 'cached 30 (75.0%) · uncached 10 (25.0%)');
});

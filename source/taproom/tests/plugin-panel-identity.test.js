import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { CHARACTER_IDS_FILE, writeCharacterIds } from '../src/character-ids.js';
import { resolvePanelIdentity } from '../src/plugin-identity.js';
import { unregisterStorageProvider } from '../src/storage.js';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * The ambient identity on a plugin request.
 *
 * An interactive panel needs the same scoping axes a generation carries, and the interesting failures here
 * are all of the quiet kind. A plugin that receives an avatar FILENAME has been handed the renameable handle
 * §22 exists to abolish. A plugin that trusts a `charId` from the query can be steered into writing one
 * character's memories into another's partition by its own markup. Neither errors; both corrupt.
 *
 * So these tests are written against those two, plus the degradation rule: an unreadable map must produce a
 * request that carries no character, never a failed button.
 */

/** A middleware call, with `next` captured so a test can prove it was reached. */
async function run(request) {
    let reached = false;
    await resolvePanelIdentity(request, {}, () => { reached = true; });
    return reached;
}

/** The shape Express hands a middleware, with only the parts this one touches. */
function makeRequest({ query = {}, headers = {}, root = undefined } = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

    return {
        query,
        get: (name) => lower[String(name).toLowerCase()],
        user: root ? { directories: { root } } : undefined,
    };
}

describe('🪪 the identity a plugin request arrives with', () => {
    /** @type {string} */
    let root;

    beforeEach(async () => {
        root = makeScratchDirectory('panel-identity');
        unregisterStorageProvider();
        await writeCharacterIds(root, { version: 1, ids: { 'Naomi.png': 'char-uuid-naomi' } });
    });

    afterEach(() => {
        unregisterStorageProvider();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('the probe ran at all — otherwise every assertion below is vacuous', async () => {
        const request = makeRequest({ headers: { 'X-ST-Char-Avatar': 'Naomi.png' }, root });

        expect(await run(request)).toBe(true);
        expect(request.query.charId).toBe('char-uuid-naomi');
    });

    test('🔴 THE CAPABILITY: an avatar key in the header becomes a charId in the query', async () => {
        // The whole point of the middleware. The client cannot do this — `character-ids.json` is server-owned
        // (§22.8.2) — so if this stops working a panel silently loses its character scope.
        const request = makeRequest({ headers: { 'X-ST-Char-Avatar': 'Naomi.png' }, root });

        await run(request);

        expect(request.query.charId).toBe('char-uuid-naomi');
    });

    test('🔴 THE WITNESS: the avatar key itself never reaches the plugin', async () => {
        // §25.8 refused to give plugins any route back to an avatar filename. A key riding through in the
        // query would be exactly that, through a door nobody was watching — so prove the resolved request
        // holds the id and nothing that could name a file.
        const request = makeRequest({ headers: { 'X-ST-Char-Avatar': 'Naomi.png' }, root });

        await run(request);

        expect(JSON.stringify(request.query)).not.toContain('Naomi');
        expect(request.query.charAvatar).toBeUndefined();
    });

    test('🔴 a charId supplied by the caller is DISCARDED, not merged', async () => {
        // A panel fragment can put anything in `data-panel-params`. Trusting it would let a plugin's own
        // markup steer its scoping — one character's durable facts written into another's partition.
        const request = makeRequest({
            query: { charId: 'forged-by-the-fragment' },
            headers: { 'X-ST-Char-Avatar': 'Naomi.png' },
            root,
        });

        await run(request);

        expect(request.query.charId).toBe('char-uuid-naomi');
    });

    test('🔴 and discarded even when nothing resolves to replace it', async () => {
        // The dangerous ordering. If the delete only happened on the success path, a request with a forged
        // charId and no header would sail through wearing it.
        const request = makeRequest({ query: { charId: 'forged-by-the-fragment' }, root });

        await run(request);

        expect(request.query.charId).toBeUndefined();
    });

    test('an avatar nobody has minted resolves to no charId, and is not an error', async () => {
        // Lookup, never mint: a character that has never generated has no memories either, so absence is the
        // honest answer rather than a fresh id for an empty partition.
        const request = makeRequest({ headers: { 'X-ST-Char-Avatar': 'Stranger.png' }, root });

        expect(await run(request)).toBe(true);
        expect(request.query.charId).toBeUndefined();
    });

    test('🔴 looking a character up does NOT mint one', async () => {
        // The map on disk must be byte-identical afterwards. A panel open that grows `character-ids.json`
        // would rewrite it — a decrypt plus an encrypt on an encrypted install — every time a user clicked.
        const before = fs.readFileSync(path.join(root, CHARACTER_IDS_FILE), 'utf8');

        await run(makeRequest({ headers: { 'X-ST-Char-Avatar': 'Stranger.png' }, root }));

        expect(fs.readFileSync(path.join(root, CHARACTER_IDS_FILE), 'utf8')).toBe(before);
    });

    test('a request with no character header passes straight through', async () => {
        // The group-chat case, and the no-character case. Both are ordinary.
        const request = makeRequest({ query: { chatId: 'chat-7' }, root });

        expect(await run(request)).toBe(true);
        expect(request.query.charId).toBeUndefined();
        expect(request.query.chatId).toBe('chat-7');
    });

    test('the plugin\'s own query parameters are left alone', async () => {
        // The middleware owns four names and must not touch anything else — a panel's paging state travels
        // in this same query string.
        const request = makeRequest({
            query: { offset: '40', view: 'browse', scope: 'chat' },
            headers: { 'X-ST-Char-Avatar': 'Naomi.png' },
            root,
        });

        await run(request);

        expect(request.query.offset).toBe('40');
        expect(request.query.view).toBe('browse');
        expect(request.query.scope).toBe('chat');
    });

    test('a percent-encoded avatar name is decoded before the lookup', async () => {
        // A header value is latin-1, so the client encodes. A name with a space is the common case and would
        // otherwise miss the map silently.
        await writeCharacterIds(root, { version: 1, ids: { 'Mitchell Voss.png': 'char-uuid-voss' } });

        const request = makeRequest({ headers: { 'X-ST-Char-Avatar': 'Mitchell%20Voss.png' }, root });

        await run(request);

        expect(request.query.charId).toBe('char-uuid-voss');
    });

    test('a malformed percent-sequence misses the map rather than throwing', async () => {
        const request = makeRequest({ headers: { 'X-ST-Char-Avatar': '%E0%A4%A' }, root });

        expect(await run(request)).toBe(true);
        expect(request.query.charId).toBeUndefined();
    });

    test.each([['..'], ['.'], ['../../etc/passwd'], ['a\\b'], ['']])(
        'an implausible avatar key (%p) is refused before any lookup',
        async (avatar) => {
            const request = makeRequest({ headers: { 'X-ST-Char-Avatar': avatar }, root });

            expect(await run(request)).toBe(true);
            expect(request.query.charId).toBeUndefined();
        },
    );

    test('🔴 an unreadable map degrades to no character, and still calls next()', async () => {
        // A locked vault is a normal state. `readCharacterIds` throws on anything that is not ENOENT, and a
        // panel that 500s on a button click because memory happens to be locked is a worse answer than a
        // panel that shows one less filter.
        fs.writeFileSync(path.join(root, CHARACTER_IDS_FILE), 'this is not json', 'utf8');

        const request = makeRequest({ headers: { 'X-ST-Char-Avatar': 'Naomi.png' }, root });

        expect(await run(request)).toBe(true);
        expect(request.query.charId).toBeUndefined();
    });

    test('no authenticated user root means no lookup, and no crash', async () => {
        const request = makeRequest({ headers: { 'X-ST-Char-Avatar': 'Naomi.png' } });

        expect(await run(request)).toBe(true);
        expect(request.query.charId).toBeUndefined();
    });
});

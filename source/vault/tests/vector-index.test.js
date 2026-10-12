import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import createVaultProvider from '../src/provider.js';
import * as session from '../src/session.js';
import { createVaultState } from '../src/vault-state.js';

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** What SillyTavern actually puts in the index: the VERBATIM message, not just an embedding. */
const MESSAGES = [
    { hash: 111, text: 'I have been waiting for you in the forest clearing.', index: 0 },
    { hash: 222, text: 'The healing herbs are kept in the third drawer.', index: 1 },
    { hash: 333, text: 'Do not tell anyone what you saw at the lake.', index: 2 },
];

/** @type {string} */
let dataRoot;
/** @type {any} */
let provider;
/** @type {any} */
let index;
/** @type {string} */
let collection;

/**
 * A vector, deterministic per message, so queries are predictable.
 * @param {number} seed A seed
 * @returns {number[]} A vector
 */
function vectorFor(seed) {
    return [Math.sin(seed), Math.cos(seed), seed / 1000];
}


/**
 * This suite's own provider state.
 *
 * 🔴 A FRESH ONE PER TEST **IS** THE RESET. Before `vault-state.js` the modules held six
 * globals between them, so a test had to remember which `reset*()` calls applied to it -- and
 * `tests/verify.test.js` records a test that passed with its guard DELETED because the shared
 * `dataRoot` was already set by a previous `beforeEach`. Nothing here can do that now: a provider
 * built around this object cannot see any other test's state, because there is no other state to see.
 */
let vault;
beforeEach(async () => {
    vault = createVaultState();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vectors-'));
    fs.mkdirSync(path.join(dataRoot, HANDLE), { recursive: true });
    session.closeAll(vault);

    provider = createVaultProvider(vault);
    provider.init({
        dataRoot,
        accountsEnabled: true,
        basicAuthMode: false,
        authenticationDelegated: false,
        users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
    });

    await provider.unlock(HANDLE, PASSWORD);

    // Exactly the path SillyTavern builds: vectors/<source>/<collectionId>/<model>
    collection = path.join(dataRoot, HANDLE, 'vectors', 'transformers', 'chat-abc123', 'default');
    index = provider.vectorIndex(collection);

    await index.createIndex();
    await index.beginUpdate();

    for (const message of MESSAGES) {
        await index.upsertItem({ vector: vectorFor(message.hash), metadata: message });
    }

    await index.endUpdate();
});

afterEach(() => {
    session.closeAll(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * Every byte under the user's directory.
 * @returns {string} All of it
 */
function everyByteOnDisk() {
    /** @type {string[]} */
    const files = [];

    /** @param {string} dir A directory */
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            entry.isDirectory() ? walk(full) : files.push(full);
        }
    };

    walk(path.join(dataRoot, HANDLE));
    return files.map(f => fs.readFileSync(f).toString('latin1')).join('\n');
}

/**
 * 🔴 VECTRA WAS THE WORST OF THE THREE, AND IT COULD NOT BE WRAPPED.
 *
 * It requires node:fs at module scope, takes a folder path and nothing else, and offers no options.fs, no
 * storage adapter and no serializer hook. There is no seam to hook. So it is not wrapped — it is replaced.
 *
 * And what it holds is not embeddings. It is `metadata.text`: THE VERBATIM MESSAGE. SillyTavern inlines the
 * raw chunk of every vectorised chat message, World Info entry and Data Bank document straight into
 * index.json. Encrypting `chats/` while leaving that file alone would have been theatre of the purest kind:
 * the entire conversation, sitting in cleartext, in a file the funnel never touched.
 */
describe('🔴 the vector index: the verbatim chat text lives here', () => {
    test('🔴 THE MESSAGES ARE NOT ON THE DISK', () => {
        const disk = everyByteOnDisk();

        for (const message of MESSAGES) {
            expect(disk).not.toContain(message.text);
        }

        // Nor the fragments, nor the metadata keys that would frame them.
        expect(disk).not.toContain('waiting for you');
        expect(disk).not.toContain('healing herbs');
        expect(disk).not.toContain('"hash"');
        expect(disk).not.toContain('"text"');
    });

    test('🔴 and the index file EXISTS — otherwise the assertion above proves nothing', () => {
        // The vacuous-green trap, for the third time. An index that was never written holds no plaintext
        // either, and would sail through the test above. Assert the thing is THERE before asserting what it
        // does not say.
        expect(provider.exists(path.join(collection, 'index.json'))).toBe(true);

        // And it is really on the platter -- under an encrypted name, which is why it cannot simply be
        // stat()ed at its logical path. `vectors/` is skeleton, so walk from there.
        /** @type {string[]} */
        const files = [];

        /** @param {string} dir A directory */
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                entry.isDirectory() ? walk(full) : files.push(full);
            }
        };

        walk(path.join(dataRoot, HANDLE, 'vectors'));

        expect(files.length).toBeGreaterThan(0);

        // Not one of them is named index.json, either: the filename is ciphertext like everything else.
        expect(files.filter(f => f.endsWith('index.json'))).toEqual([]);
    });

    test('and SillyTavern reads them straight back', async () => {
        const items = await index.listItems();

        expect(items).toHaveLength(3);
        expect(items.map(i => i.metadata.text).sort()).toEqual(MESSAGES.map(m => m.text).sort());
    });

    test('the index survives a lock and unlock — it is on the disk, not in RAM', async () => {
        provider.lock(HANDLE);
        await provider.unlock(HANDLE, PASSWORD);

        const reopened = provider.vectorIndex(collection);
        const items = await reopened.listItems();

        expect(items.map(i => Number(i.metadata.hash)).sort()).toEqual([111, 222, 333]);
    });

    test('🔴 a LOCKED index cannot be read — and does not pretend to be empty', async () => {
        // An empty answer here would be a disaster: SillyTavern would conclude the collection has no
        // vectors, re-embed the entire chat, and write a second index over the top of the first.
        provider.lock(HANDLE);

        const locked = provider.vectorIndex(collection);

        await expect(locked.listItems()).rejects.toThrow();
    });

    test('🔴 an index that EXISTS but will not DECRYPT throws — it never reads as empty', async () => {
        // 🔴 THE ONE THE LOCKED TEST ABOVE DOES NOT ACTUALLY COVER.
        //
        // A mutation proved it: making read() swallow errors and return an empty index left the whole suite
        // green. The locked test passes because `exists()` throws first, on the locked vault, before the
        // read is ever attempted -- so it was testing `exists()`, not the read path. Decorative.
        //
        // This is the case that matters: the file is RIGHT THERE, and it cannot be decoded. Wrong key,
        // tampering, corruption. If read() answered "no items", SillyTavern would conclude the collection is
        // empty, re-embed the entire chat, and write a fresh index straight over the top of one it simply
        // could not read. The data would be gone, and nothing would have reported an error.
        //
        // EPROVIDER means "it is there and I cannot read it". It must propagate.
        /** @type {string[]} */
        const files = [];

        /** @param {string} dir A directory */
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                entry.isDirectory() ? walk(full) : files.push(full);
            }
        };

        walk(path.join(dataRoot, HANDLE, 'vectors'));
        expect(files).toHaveLength(1);

        // Flip a byte in the ciphertext. The file still exists; it just no longer authenticates.
        const sealed = fs.readFileSync(files[0]);
        sealed[sealed.length - 1] ^= 0xff;
        fs.writeFileSync(files[0], sealed);

        const corrupted = provider.vectorIndex(collection);

        expect(await corrupted.isIndexCreated()).toBe(true);
        await expect(corrupted.listItems()).rejects.toThrow(/EPROVIDER|decrypt/i);
    });
});

describe('the query', () => {
    test('finds the nearest vectors, best first', async () => {
        const results = await index.queryItems(vectorFor(222), 2);

        expect(results).toHaveLength(2);
        expect(Number(results[0].item.metadata.hash)).toBe(222);
        expect(results[0].score).toBeGreaterThan(results[1].score);

        // An exact hit on a normalised cosine similarity is 1.
        expect(results[0].score).toBeCloseTo(1, 5);
    });

    test('topK bounds the result', async () => {
        expect(await index.queryItems(vectorFor(111), 1)).toHaveLength(1);
        expect(await index.queryItems(vectorFor(111), 10)).toHaveLength(3);
    });
});

/**
 * 🔴 THE FILTER DECIDES WHAT GETS DELETED.
 *
 * `listItemsByMetadata()` is how SillyTavern finds the vectors belonging to a set of message hashes so it
 * can destroy them. A filter that matched too much would delete the wrong messages' vectors; one that
 * matched nothing would silently stop deletions working and let the index rot.
 */
describe('🔴 listItemsByMetadata — it feeds deleteItem, so it does not guess', () => {
    test('$in selects exactly the hashes asked for', async () => {
        const found = await index.listItemsByMetadata({ hash: { '$in': [111, 333] } });

        expect(found.map(i => Number(i.metadata.hash)).sort()).toEqual([111, 333]);
    });

    test('and deleting by that filter removes those, and ONLY those', async () => {
        const doomed = await index.listItemsByMetadata({ hash: { '$in': [222] } });

        await index.beginUpdate();

        for (const item of doomed) {
            await index.deleteItem(item.id);
        }

        await index.endUpdate();

        const left = await index.listItems();

        expect(left.map(i => Number(i.metadata.hash)).sort()).toEqual([111, 333]);
    });

    test('🔴 AN UNKNOWN OPERATOR THROWS — it does not quietly match everything', async () => {
        // The failure this prevents: a filter operator nobody implemented, silently treated as "matches",
        // handed to deleteItem -- and the whole collection is gone. Or silently treated as "matches
        // nothing", and deletion quietly stops working for ever. Neither is worth pretending to speak
        // Mongo. Throw, on the first call, and let someone read the message.
        await expect(index.listItemsByMetadata({ hash: { '$gt': 100 } }))
            .rejects.toThrow(/does not support the metadata operator '\$gt'/);
    });
});

describe('the update contract', () => {
    test('upsert outside an update is refused', async () => {
        await expect(index.upsertItem({ vector: [1, 2, 3], metadata: {} }))
            .rejects.toThrow(/beginUpdate/);
    });

    test('an abandoned update changes nothing on the disk', async () => {
        await index.beginUpdate();
        await index.upsertItem({ vector: vectorFor(999), metadata: { hash: 999, text: 'never committed' } });
        await index.cancelUpdate();

        const items = await index.listItems();

        expect(items).toHaveLength(3);
        expect(everyByteOnDisk()).not.toContain('never committed');
    });

    test('deleteIndex removes the collection', async () => {
        await index.deleteIndex();

        expect(await index.isIndexCreated()).toBe(false);
    });

    test('getIndexStats counts what is there', async () => {
        expect(await index.getIndexStats()).toMatchObject({ items: 3 });
    });
});

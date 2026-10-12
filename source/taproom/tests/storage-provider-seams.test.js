import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const SEAM_PROVIDER = path.join(testDirectory, 'fixtures', 'seam-provider.js');
const SAMPLE_CARD = path.join(path.dirname(testDirectory), 'default', 'content', 'default_Seraphina.png');

const PASSWORD = 'the-password';

/**
 * Give the default user a password, so accounts are meaningfully on.
 * @param {string} dataRoot The data root
 * @returns {Promise<void>}
 */
async function setPassword(dataRoot) {
    const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), expiredInterval: 0 /* no stray timer — see setPassword in integration/harness.mjs */ });
    await store.init();

    const user = await store.getItem('user:default-user');
    const salt = crypto.randomBytes(16).toString('base64');

    user.password = crypto.scryptSync(PASSWORD.normalize(), salt, 64).toString('base64');
    user.salt = salt;

    await store.setItem('user:default-user', user);
}

/**
 * 🔴 THE THREE LIBRARY SEAMS, AND WHETHER ANYTHING ACTUALLY CALLS THEM.
 *
 * `multer`, `node-persist` and `vectra` each write user data with their own `fs` calls. They do not go
 * through `storage.*`, so not one guard in the funnel applies to them. The fork offers three hooks so a
 * provider can take those bytes back.
 *
 * A hook that nobody calls is indistinguishable from a hook that works — and TWO OF THESE WERE DEAD:
 *
 *   - `storage.multerStorage()` was asked for at MODULE SCOPE, before any provider had registered. It
 *     always answered null. The plaintext fallback was installed permanently, on every install that ever
 *     ran, and no provider's engine was ever called. Nothing failed. Uploads worked. They went to the disk
 *     in the clear.
 *
 *   - `keyValueOptions()` was wired correctly, but no provider implemented it — and the plaintext character
 *     cache that resulted survived two milestones because the end-to-end test never listed characters.
 *
 * So this suite does not ask "did the seam behave correctly?" It asks the prior question, the one the boot
 * gate had to learn to ask: **DID SILLYTAVERN EVEN CALL YOU?**
 */
describe('🔴 the library seams are actually WIRED', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let journalPath;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let cookie;
    /** @type {number} */
    let importStatus;

    /** @returns {string} Everything the provider was asked to do */
    const journal = () => fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf-8') : '';

    beforeAll(async () => {
        scratch = makeScratchDirectory('seams');
        dataRoot = path.join(scratch, 'data');
        journalPath = path.join(scratch, 'seams.journal');

        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();
        await setPassword(dataRoot);

        installStorageProvider(providersPath, SEAM_PROVIDER);

        server = await startSillyTavern({
            dataRoot,
            configPath,
            storageProvidersPath: providersPath,
            enableUserAccounts: true,
            providerEnv: { ST_SEAM_JOURNAL: journalPath },
        });

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;

        const login = await fetch(`${base}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
        });

        // A throw, not an `expect`, for the same reason as the two boot checks above: an assertion in a
        // hook is a lint error (`jest/no-standalone-expect`) and reports the failure without the one
        // thing that explains it. A login that fails here has failed for a reason the body will name.
        if (login.status !== 200) throw new Error(`Login failed with ${login.status}.\n\n${await login.text()}`);
        cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

        // Import a character card, over multipart, exactly as the browser does. This is the ONLY thing that
        // makes multer run.
        const form = new FormData();
        form.append('avatar', new Blob([fs.readFileSync(SAMPLE_CARD)]), 'seam_card.png');
        form.append('file_type', 'png');

        const imported = await fetch(`${base}/api/characters/import`, {
            method: 'POST',
            headers: { Cookie: cookie },
            body: form,
        });

        importStatus = imported.status;

        // And list the characters, which is the ONLY thing that makes the node-persist cache run.
        await fetch(`${base}/api/characters/all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({}),
        });

        // And ask for a vector collection's hashes. This reaches getIndex() -- and therefore the third seam
        // -- without needing an embedding model, because listing does not embed anything.
        await fetch(`${base}/api/vector/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ collectionId: 'seam-collection', source: 'transformers' }),
        });

        await new Promise(resolve => setTimeout(resolve, 1500));
    }, 240_000);

    afterAll(async () => {
        await server?.stop();

        if (scratch) {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    test('🔴 multerStorage() IS CALLED — it was dead code, and nothing said so', () => {
        // THE REGRESSION THIS EXISTS TO PREVENT.
        //
        // `const uploadStorage = storage.multerStorage() ?? multer.diskStorage(...)` sat at module scope,
        // and providers are loaded much later in the boot. So it got null, every time, and the fallback was
        // wired in permanently. A provider could implement the perfect StorageEngine and multer would never
        // once ask for it -- while every character card, chat and world info the user imported staged on the
        // disk in plaintext.
        expect(journal()).toContain('multerStorage._handleFile');
    });

    test('🔴 and the upload really was written BY THE PROVIDER, and read back through it', () => {
        // "It called us" is necessary but not sufficient: an engine that is called and whose bytes are then
        // ignored is no better than one that is never called.
        //
        // The provider marks every byte it writes with a prefix that plain fs could not have produced. So an
        // import that SUCCEEDS is the proof of the whole round trip: multer staged the marked bytes, and
        // SillyTavern then read that file back -- through the provider, which stripped the mark -- and
        // parsed a valid PNG out of it. Had any reader held its own file descriptor into the staging
        // directory (Jimp did, and so did yauzl), it would have seen the marker, failed to parse the image,
        // and this would be a 400.
        expect(importStatus).toBe(200);

        // And nothing was left behind: SillyTavern unlinks the staged file itself, through the funnel, the
        // moment it has read it. (multer's own `_removeFile` is only for when a LATER middleware rejects the
        // request, so it does not fire on the happy path at all.)
        const staging = path.join(dataRoot, 'default-user', '_uploads');
        const left = fs.existsSync(staging) ? fs.readdirSync(staging) : [];

        expect(left).toEqual([]);
    });

    test('🔴 keyValueOptions() IS CALLED — the character cache goes through the provider', () => {
        // The other seam that leaked. node-persist writes the character-card cache with its own fs calls,
        // so with nobody hooking parse/stringify, every card sat in <handle>/_cache/characters/ as plain
        // JSON -- name, description, personality -- while the rest of the account was ciphertext.
        expect(journal()).toContain('keyValueOptions() asked for: default-user');
        expect(journal()).toContain('keyValueOptions.stringify');
    });

    test('🔴 vectorIndex() IS CALLED — the seam for the library that stores VERBATIM CHAT TEXT', () => {
        // vectra cannot be wrapped: it requires node:fs at module scope, takes a folder path and nothing
        // else, and offers no serializer hook. So the fork does not wrap it -- it offers this seam and lets
        // a provider REPLACE it outright.
        //
        // Which matters more than any of the others, because vectra does not store embeddings. It stores
        // `metadata.text`: the VERBATIM message. Every vectorised chat line, World Info entry and Data Bank
        // document, inlined into index.json. A seam nobody called would mean the entire conversation sitting
        // in cleartext in a file the funnel never touched -- while chats/ next door was flawless ciphertext.
        expect(journal()).toContain('vectorIndex() asked for:');
    });

    test('🔴 and the cache on the disk is the PROVIDER\'S bytes, not node-persist\'s JSON', () => {
        const cacheDirectory = path.join(dataRoot, 'default-user', '_cache', 'characters');
        const entries = fs.existsSync(cacheDirectory) ? fs.readdirSync(cacheDirectory) : [];

        // 🔴 Not vacuous. An EMPTY cache would pass any "no plaintext here" assertion trivially, which is
        // precisely how the real leak survived. Assert that the thing exists before asserting what it holds.
        expect(entries.length).toBeGreaterThan(0);

        for (const entry of entries) {
            const contents = fs.readFileSync(path.join(cacheDirectory, entry), 'utf-8');
            expect(contents.startsWith('SEAM:')).toBe(true);
        }
    });
});

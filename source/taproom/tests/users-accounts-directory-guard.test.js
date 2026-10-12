import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';
import { unregisterStorageProvider } from '../src/storage.js';
import { makeScratchDirectory } from './util/st-server.js';

// `users.js` pulls in a chain that reads the config at module scope and `process.exit(1)`s without one, so
// it cannot be imported statically — a static import is hoisted above `beforeAll` and the module would exit
// while Jest was still collecting this file. Same reason as session-cookie-name.test.js.
/** @type {typeof import('../src/users.js')} */
let users;

/**
 * `<dataRoot>/_storage/` is a `node-persist` store. Initialization reads the whole directory and parses
 * each file as a `{key, value, ttl}` record; an unrelated registry file can stop startup before the port binds.
 * The preflight should identify the offending path and its owner before the library reports a generic parse error.
 *
 * ## What is actually pinned here, and what is deliberately not
 *
 * The boot fails either way — that is the library's behaviour and not ours to change. What these tests pin
 * is that it fails **legibly**: naming the file, naming the directory's real owner, and pointing at the
 * rule, instead of `[node-persist][readFile] … does not look like a valid storage file!` against a hashed
 * filename the operator has never seen.
 *
 * The tests distinguish the guard's actionable diagnostic from `node-persist`'s generic parse failure.
 * They also cover the shared recovery path, which uses the same account-store initialization.
 */
describe('🗄️ the account store refuses files it did not write, and says which', () => {
    /** @type {string} */
    let root;

    beforeAll(async () => {
        const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
        setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));
        users = await import('../src/users.js');
    });

    beforeEach(() => {
        root = makeScratchDirectory('accounts-guard');
        unregisterStorageProvider();
    });

    afterEach(() => {
        unregisterStorageProvider();
        fs.rmSync(root, { recursive: true, force: true });
    });

    /**
     * Put a file in the account store directory.
     * @param {string} name The filename
     * @param {string} body Its contents
     * @returns {void}
     */
    function placeInAccountStore(name, body) {
        const directory = path.join(root, '_storage');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, name), body, 'utf-8');
    }

    /** A `node-persist` datum filename: `sha256(key)`, 64 lowercase hex digits. */
    const DATUM = 'a'.repeat(64);

    test('🔴 the real regression: the provider registry that bricked :8001 is caught and NAMED', async () => {
        placeInAccountStore(
            'vault-foreign-stores.json',
            JSON.stringify({ version: 1, stores: [{ directory: 'memory', owner: 'Mnemosyne', forbidden: [] }] }),
        );

        // 🔴 NOT `/vault-foreign-stores\.json/` ALONE — node-persist's own error contains the path too, so
        // that assertion passes with the guard removed. It has to be OUR refusal, naming OUR file.
        const failure = users.initUserStorage(root);

        await expect(failure).rejects.toThrow(/REFUSING TO START/);
        await expect(failure).rejects.toThrow(/vault-foreign-stores\.json/);
    });

    test('the message says what the directory is for, so the reader knows why their file cannot stay', async () => {
        placeInAccountStore('vault-foreign-stores.json', '{}');

        await expect(users.initUserStorage(root)).rejects.toThrow(/account store/i);
    });

    test('and it points at the rule rather than only forbidding — a provider needs somewhere to GO', async () => {
        placeInAccountStore('notes.txt', 'anything at all');

        // Refusing without saying where state belongs just moves the confusion. §11.1.2 is the answer.
        await expect(users.initUserStorage(root)).rejects.toThrow(/DESIGN_STORAGE_PROVIDER_API\.md/);
    });

    test('every offender is listed, not just the first one found', async () => {
        placeInAccountStore('vault-foreign-stores.json', '{}');
        placeInAccountStore('some-other-plugin.json', '{}');

        const failure = users.initUserStorage(root);

        await expect(failure).rejects.toThrow(/vault-foreign-stores\.json/);
        await expect(failure).rejects.toThrow(/some-other-plugin\.json/);
    });

    test('🟢 a directory holding only real datum files is left completely alone', async () => {
        placeInAccountStore(DATUM, JSON.stringify({ key: 'user:admin', value: { handle: 'admin' } }));

        // The guard is filename-shaped on purpose: it never opens an account file, and must not start.
        await expect(users.initUserStorage(root)).resolves.toBeUndefined();
    });

    test('🟢 a data root with no account store yet is a first run, not a violation', async () => {
        await expect(users.initUserStorage(root)).resolves.toBeUndefined();
    });

    test('⚠️ the check is a PRE-FLIGHT: nothing is created or altered when it refuses', async () => {
        placeInAccountStore('vault-foreign-stores.json', '{}');

        // `toThrow()` bare would pass with the guard removed — the library throws too. Pin OUR refusal.
        await expect(users.initUserStorage(root)).rejects.toThrow(/REFUSING TO START/);

        // A refusal that had already half-initialised the store — minting the default user, say — would be
        // a worse failure than the one it replaced, because it would be invisible on the next boot.
        expect(fs.readdirSync(path.join(root, '_storage')).sort()).toEqual(['vault-foreign-stores.json']);
    });
});

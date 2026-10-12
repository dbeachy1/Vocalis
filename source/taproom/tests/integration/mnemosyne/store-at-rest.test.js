import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { DEPENDENCIES, preflight, serverDirectory } from '../preflight.mjs';
import { HANDLE, findMarker, login, makeMarker, post, prepareDataRoot, shareModelCache, startServer } from '../harness.mjs';

/**
 * 🔴 SUITE B §7 B4 — THE MEMORY STORE'S OWN BYTES ARE CIPHERTEXT.
 *
 * ## Why this is not covered by Suite A, and why it is the one that would hurt
 *
 * Vault does not encrypt the memory store, **by design and correctly**: Mnemosyne calls
 * `context.registerForeignStore` to declare `<user>/memory/` as its own — a directory Vault must
 * leave alone because a second layer of encryption over a live SQLCipher database would break it, and
 * because Vault's `verify` would otherwise report those files as corrupt.
 *
 * That declaration is a **promise**, and `foreign-stores.js` says so in as many words: the registry
 * records `forbidden: ['SQLite format 3\0']` precisely so a standalone `verify` can hold the plugin
 * to it. Nothing had ever checked the promise against the bytes a running stack actually writes.
 *
 * So this is the shape of the failure it exists to catch: Vault steps aside, the plugin's own
 * encryption is broken or never keyed, and the result is a **plaintext SQLite database of the user's
 * memories sitting inside an encrypted vault** — with every other test in both suites still green,
 * because every other test looks at chats. `bolt-in.test.js` §7 B1 scans for a marker from a CHAT; a
 * memory is a different string on a different path, and this file is where it is hunted.
 *
 * ## Both controls, because two different detectors are in play
 *
 * The plan's §4 rule is that a negative assertion is worth nothing until something proves the detector
 * can fire, and there are two detectors here rather than one:
 *
 *   - **The scanner** — `findMarker` walking the tree. Its failure mode is not seeing the memory
 *     directory AT ALL, which would report a beautiful clean result for a directory it never opened.
 *     Control: a plaintext file carrying the same marker is dropped into that exact directory and the
 *     same call must find it.
 *   - **The header check** — "the file does not begin `SQLite format 3`". Its failure mode is reading
 *     the wrong offset, or the wrong file. Control: a real plaintext database, built with the same
 *     native module the plugin uses, must come back with the header present.
 *
 * ⚠️ Deliberately NOT built on Vault's `bin/verify.js`, per the plan: a control that shares its oracle
 * with the thing under test cannot fail independently of it.
 */

/** Where Mnemosyne puts it — `src/index.js`: `<userDirectory>/memory/store.db`. */
const MEMORY_DIRECTORY = 'memory';
const STORE_FILE = 'store.db';

/** The SQLite magic. A SQLCipher database must NOT start with it; a plain one must. */
const SQLITE_HEADER = 'SQLite format 3';

/** The remembered text. The only place this string is ever written. */
const SECRET = makeMarker('B4-MEMORY-AT-REST');
const MEMORY_TEXT = `The user confided that ${SECRET}, and it lives only in the memory store.`;

const gate = preflight('suite B — the memory store at rest', [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne]);
const suite = gate.run ? describe : describe.skip;

/**
 * Open a database through the PLUGIN'S OWN native module.
 *
 * 🔴 Its module, resolved from its `node_modules`, rather than a copy of the same package hoisted into
 * the test tree. The control has to be built by the same code that writes the real thing or it is
 * asserting about a different SQLite. `better-sqlite3-multiple-ciphers` is CommonJS and native, hence
 * `createRequire` — the same reason `store.js` uses it.
 *
 * ⚠️ If this throws `Could not locate the bindings file`, the native module was never built:
 * `npm approve-scripts better-sqlite3-multiple-ciphers && npm rebuild better-sqlite3-multiple-ciphers`
 * inside the plugin. `npm install` blocks that script by default and leaves no error until something
 * imports it.
 * @param {string} file Path to the database file
 * @returns {any} An open database handle
 */
function openPlainDatabase(file) {
    const pluginDirectory = path.join(serverDirectory, 'plugins', 'SillyTavern-Mnemosyne');
    const requireFromPlugin = createRequire(path.join(pluginDirectory, 'package.json'));
    const Database = requireFromPlugin('better-sqlite3-multiple-ciphers');

    // No `pragma key`, so this one is a plain database on purpose — that is the whole point of it.
    // ⚠️ A file, never `:memory:`: SQLCipher cannot key an in-memory database, and the misleading
    // `SQLITE_ERROR` it raises has cost this project time before.
    return new Database(file);
}

suite('🔐 §7 B4: the memory store Vault leaves alone is encrypted by the plugin itself', () => {
    /** @type {any} */
    let server;
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let memoryDirectory;
    /** @type {string} */
    let storePath;
    /** @type {Buffer} */
    let storeBytes;
    /** Leaks found anywhere in the scratch tree, with the memory planted. */
    let leaks = [];

    beforeAll(async () => {
        const prepared = await prepareDataRoot('integration-mnemosyne-store-at-rest');

        scratch = prepared.scratch;
        dataRoot = prepared.dataRoot;
        shareModelCache(dataRoot);

        const boot = await startServer({
            ...prepared,
            withVault: true,
            pluginsPath: path.join(serverDirectory, 'plugins'),
        });

        server = boot.server;

        const cookie = await login(boot);

        // One memory, through the plugin's own route, so the store is written by the real code on the
        // real path. `scenario` needs no server-minted charId — see `memory-isolation.test.js` for why
        // that matters, and why it does not matter here.
        const planted = await post(boot.base, '/api/plugins/mnemosyne/memory', {
            text: MEMORY_TEXT, tier: 'scenario', chatId: 'b4-the-chat', personaId: 'b4-the-persona',
        }, cookie);

        if (planted.status !== 201) {
            throw new Error(`Planting the memory failed (${planted.status}): ${JSON.stringify(planted.body)}\n\n${server.output()}`);
        }

        // 🔴 STOPPED BEFORE READING THE BYTES. SQLCipher writes through a page cache and a WAL, and a
        // store read while the process still holds it open can be missing the very rows just written —
        // which would make every negative assertion below pass for the most boring possible reason.
        await server.stop();

        memoryDirectory = path.join(dataRoot, HANDLE, MEMORY_DIRECTORY);
        storePath = path.join(memoryDirectory, STORE_FILE);
        storeBytes = fs.existsSync(storePath) ? fs.readFileSync(storePath) : Buffer.alloc(0);
        leaks = findMarker(scratch, SECRET);
    }, 600_000);

    afterAll(async () => {
        await server?.stop();
    });

    describe('the store was really written — the rest is about a file that has to exist', () => {
        test('🗄️ Mnemosyne created its store where it says it does', () => {
            // Vacuity guard, and not a formality: every assertion in this file is about the CONTENTS of
            // this file, and `fs.readFileSync` of a path that does not exist would hand the checks below
            // an empty buffer that satisfies all of them perfectly.
            expect(fs.existsSync(storePath)).toBe(true);
            expect(storeBytes.length).toBeGreaterThan(0);
        });

        test('🧱 and Vault deliberately left that directory alone, as the foreign-store contract says', () => {
            // The premise of the whole file. If Vault HAD encrypted this directory, the ciphertext
            // assertions below would pass without Mnemosyne having done anything at all — and the
            // foreign-store declaration would be a lie in the other direction.
            const names = fs.readdirSync(memoryDirectory);

            expect(names).toContain(STORE_FILE);
            expect(names.filter(name => name.startsWith('venc1~'))).toEqual([]);
        });
    });

    describe('🔴 and it is ciphertext', () => {
        test('🔴 the file does not even look like a database — no SQLite header', () => {
            expect(storeBytes.subarray(0, SQLITE_HEADER.length).toString('latin1')).not.toBe(SQLITE_HEADER);
        });

        test('🔴 the remembered text is nowhere in the store\'s raw bytes', () => {
            expect(storeBytes.includes(Buffer.from(SECRET))).toBe(false);
        });

        test('🔴 nor anywhere else in the tree — not a stray copy, a temp file, a WAL or a journal', () => {
            // Broader than the store on purpose. SQLCipher writes `-wal` and `-shm` alongside, an
            // extraction path could leave a scratch copy, and a marker that survives in any of them is
            // the same disclosure as one in the database.
            expect(leaks).toEqual([]);
        });
    });

    describe('🔴 the controls — without these, everything above is decoration', () => {
        /** @type {string} */
        let plantedPlaintext;

        afterAll(() => {
            fs.rmSync(plantedPlaintext, { force: true });
        });

        test('✅ CONTROL: the scanner really does reach the memory directory', () => {
            // 🔴 THE FAILURE THIS CATCHES IS THE QUIET ONE. `findMarker` walks with `readdirSync`, and a
            // directory it never descends produces exactly the same empty result as a directory full of
            // ciphertext. So the same marker goes into that exact directory through an ordinary write,
            // and the same call must come back with it.
            plantedPlaintext = path.join(memoryDirectory, 'control-plaintext.txt');
            fs.writeFileSync(plantedPlaintext, `this file is deliberately plaintext and says ${SECRET}\n`);

            const found = findMarker(scratch, SECRET);

            expect(found.length).toBeGreaterThan(0);
            expect(found.map(one => one.file)).toContain(plantedPlaintext);
        });

        test('✅ CONTROL: a real plaintext database DOES carry the header the store lacks', () => {
            // The other detector. Built with the plugin's own native module and no key, so "the header
            // check is looking at the right offset of the right kind of file" is demonstrated rather
            // than assumed. Without it, `not.toBe('SQLite format 3')` would also pass against a typo.
            const controlPath = path.join(scratch, 'control-plain.db');
            const database = openPlainDatabase(controlPath);

            try {
                database.exec('CREATE TABLE control(text TEXT)');
                database.prepare('INSERT INTO control(text) VALUES (?)').run(MEMORY_TEXT);
            } finally {
                database.close();
            }

            const controlBytes = fs.readFileSync(controlPath);

            expect(controlBytes.subarray(0, SQLITE_HEADER.length).toString('latin1')).toBe(SQLITE_HEADER);

            // …and it leaks, which is the point: the same two checks that clear the real store convict
            // this one. A pair that cannot separate these two files is not a pair of checks at all.
            expect(controlBytes.includes(Buffer.from(SECRET))).toBe(true);
        });
    });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';
import { registerStorageProvider, unregisterStorageProvider } from '../src/storage.js';
import { makeScratchDirectory } from './util/st-server.js';

// `users.js` pulls in a chain that reads the config at module scope and `process.exit(1)`s without one, so
// it cannot be imported statically — a static import is hoisted above `beforeAll` and the module would exit
// while Jest was still collecting this file. Same reason as users-accounts-directory-guard.test.js.
/** @type {typeof import('../src/users.js')} */
let users;

/**
 * 🔴 THE BACKUP ARCHIVE IS A PUMP, NOT A SLURP — and these are the three properties that make it one.
 *
 * `createBackupArchive` used to read EVERY file fully into a Buffer and hand it to archiver, which
 * queues what it is given and drains only as fast as the HTTP response accepts bytes. On a large
 * account, or a slow client, resident memory tracked the size of the whole data root — in the one
 * process serving every user. It now appends one read STREAM at a time and waits for archiver to finish
 * that entry before walking on, so the walk advances at the pace the client drains.
 *
 * Memory itself is not what these tests measure — an RSS assertion would be a flake generator. What is
 * pinned is the MECHANISM, which is deterministic:
 *
 *   1. The archive still arrives, complete and correct, with the excluded entries still excluded — the
 *      pump must not change what the backup IS.
 *   2. 🔴 A read that fails mid-walk still aborts the archive and rethrows — the invariant documented
 *      in `createBackupArchive` itself. With Buffers the failure was a rejected `await` inside the
 *      loop; with streams it reaches NOBODY unless the loop listens, because archiver pipes every
 *      appended stream into a PassThrough of its own at append time and pipe() does not forward
 *      errors. The first draft of the fix leaned on archiver's own error path and THIS TEST caught it:
 *      the source's error fired unhandled — in production, an uncaught exception taking down the
 *      process serving every user — while the entry sat unfinished for ever. If this regresses, a
 *      failed backup is at best a client holding a connection to a zip that never ends, and at worst
 *      a server restart for everybody.
 *   3. 🔴 A client that DISCONNECTS stops the walk. Without the close-race, a vanished client leaves
 *      nobody draining the archive, and the loop would go on opening every remaining file into
 *      archiver's buffers — the same unbounded growth through a different door, triggerable by anyone
 *      who starts a backup and drops the connection. The walk must stop EARLY: strictly fewer files
 *      opened than exist, and the promise must resolve, not hang.
 *
 * The files in test 3 are incompressible on purpose: deflate collapses repetitive filler so completely
 * that entire entries fit inside the pipeline's internal buffers even with the response gone, which
 * would let the walk run to the end and fail the assertion for a reason that has nothing to do with the
 * code under test.
 */
describe('🗜️ createBackupArchive pumps instead of slurping', () => {
    /** @type {string} */
    let root;

    beforeAll(async () => {
        const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
        setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));
        users = await import('../src/users.js');
    });

    beforeEach(() => {
        root = makeScratchDirectory('backup-archive');
        globalThis.DATA_ROOT = root;
        unregisterStorageProvider();
    });

    afterEach(() => {
        unregisterStorageProvider();
        delete globalThis.DATA_ROOT;
        fs.rmSync(root, { recursive: true, force: true });
    });

    /**
     * The response, as far as `createBackupArchive` is concerned: a writable stream with `attachment`,
     * `headersSent`, `end` and `destroy`. Collects everything the archive writes.
     */
    class MockResponse extends PassThrough {
        constructor() {
            super();
            this.headersSent = false;
            /** @type {Buffer[]} */
            this.chunks = [];
            this.on('data', chunk => this.chunks.push(chunk));
        }

        attachment() {
            this.headersSent = true;
            return this;
        }

        get body() {
            return Buffer.concat(this.chunks);
        }
    }

    /**
     * A provider whose every member throws if called, ready to be overridden with the two or three
     * members a test actually means to exercise. `registerStorageProvider` validates the full member
     * list, so all of them must exist; none of them should be REACHED unless a test says so.
     * @param {object} overrides Members this test expects to be called
     * @returns {object} A registrable provider
     */
    function stubProvider(overrides) {
        const provider = { id: 'backup-archive-test-provider' };
        const members = [
            'owns', 'init', 'isReady', 'readFile', 'readFileSync', 'createReadStream', 'exists', 'stat',
            'readdir', 'writeFile', 'writeFileSync', 'createWriteStream', 'mkdir', 'unlink', 'rename',
            'copyFile', 'cp', 'rm', 'sendFile', 'unlock', 'lock', 'rekey',
        ];
        for (const member of members) {
            provider[member] = () => {
                throw new Error(`provider.${member} was not expected to be called by this test`);
            };
        }
        return Object.assign(provider, overrides);
    }

    /**
     * Seed a user directory with files.
     * @param {string} handle The user handle
     * @param {Record<string, Buffer|string>} files Relative path → contents
     * @returns {string} The user's root
     */
    function seedUser(handle, files) {
        const userRoot = path.join(root, handle);
        for (const [relative, contents] of Object.entries(files)) {
            const target = path.join(userRoot, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, contents);
        }
        return userRoot;
    }

    test('the archive arrives complete, and the excluded entries stay out', async () => {
        seedUser('backup-user-a', {
            'settings.json': '{ "theme": "dark" }',
            'chats/testchar/a chat.jsonl': '{"mes": "hello"}',
            '_cache/characters/deadbeef': 'derived, excluded, must not appear',
        });

        const response = new MockResponse();
        const drained = new Promise(resolve => response.on('end', resolve));

        await users.createBackupArchive('backup-user-a', response);
        await drained;

        // A real zip — and zip stores entry names verbatim, so the names are assertable without
        // unzipping (same discipline as the vault backup-scope suite).
        const body = response.body.toString('latin1');
        expect(response.body.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04', 'latin1'));
        expect(body).toContain('settings.json');
        expect(body).toContain('chats/testchar/a chat.jsonl');
        expect(body).not.toContain('_cache');
    }, 15_000);

    test('🔴 a read that fails mid-walk aborts the archive and rethrows — no hung response', async () => {
        const userRoot = seedUser('backup-user-b', {
            'a-first.txt': 'archived before the failure',
            'm-poisoned.txt': 'the bytes behind this one cannot be served',
            'z-last.txt': 'never reached',
        });
        const poisoned = path.resolve(userRoot, 'm-poisoned.txt');

        // Only the poisoned file is the provider's; everything else falls through to the plain
        // filesystem. The stream fails on first read, not on creation — archiver starts consuming the
        // stream the moment it is appended, so this is a MID-CONSUMPTION failure, which is exactly
        // where a provider fails in production and exactly the case pipe() does not forward.
        registerStorageProvider(stubProvider({
            owns: p => path.resolve(p) === poisoned,
            init: () => { },
            isReady: () => true,
            createReadStream: () => new Readable({
                read() {
                    this.destroy(new Error('the provider could not read this file'));
                },
            }),
        }));

        const response = new MockResponse();

        await expect(users.createBackupArchive('backup-user-b', response))
            .rejects.toThrow('the provider could not read this file');

        // The response must NOT have been ended as if the archive completed — the rejection is the
        // route's signal to destroy it (users-private.js /backup), and an `end` here would hand the
        // client a truncated zip dressed up as a finished one.
        expect(response.writableEnded).toBe(false);
    }, 15_000);

    test('🔴 a client that disconnects stops the walk — the account is not read to the end', async () => {
        // Six incompressible files. The first response chunk severs the connection; the pump must
        // notice and stop opening files, instead of pulling all six into archiver's buffers with
        // nobody draining them.
        const files = {};
        for (let i = 0; i < 6; i++) {
            files[`f${i}.bin`] = crypto.randomBytes(256 * 1024);
        }
        const userRoot = seedUser('backup-user-c', files);

        /** @type {string[]} */
        const opened = [];
        registerStorageProvider(stubProvider({
            owns: p => p.endsWith('.bin') && path.resolve(p).startsWith(path.resolve(userRoot)),
            init: () => { },
            isReady: () => true,
            createReadStream: (p) => {
                opened.push(p);
                return fs.createReadStream(p);
            },
        }));

        const response = new MockResponse();
        response.once('data', () => response.destroy());

        // Resolves — neither a rejection nor a hang. A hang here IS the regression: it means the walk
        // is waiting on an entry nobody will ever drain.
        await users.createBackupArchive('backup-user-c', response);

        expect(opened.length).toBeGreaterThan(0);
        expect(opened.length).toBeLessThan(6);
    }, 15_000);
});

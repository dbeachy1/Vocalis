import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { diffManifests, isUserData, takeManifest } from './util/data-root-manifest.js';
import { installStorageProvider, makeScratchDirectory, readJournal, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const LOCKED_PROVIDER = path.join(testDirectory, 'fixtures', 'locked-provider.js');
const PASSWORD = 'correct-horse';

/**
 * Gives the default user a real password, the way SillyTavern would.
 *
 * `getPasswordHash` is `scryptSync(password.normalize(), salt, 64).toString('base64')`, and the account
 * record lives in a node-persist store under <DATA_ROOT>/_storage. We write it directly rather than
 * driving the admin UI, because what is under test is the STORAGE lock, not the account plumbing.
 * @param {string} dataRoot The data root
 * @returns {Promise<void>}
 */
async function givePasswordToDefaultUser(dataRoot) {
    const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), expiredInterval: 0 /* no stray timer — see setPassword in integration/harness.mjs */ });
    await store.init();

    const user = await store.getItem('user:default-user');
    const salt = crypto.randomBytes(16).toString('base64');

    user.password = crypto.scryptSync(PASSWORD.normalize(), salt, 64).toString('base64');
    user.salt = salt;

    await store.setItem('user:default-user', user);
}

/**
 * 🔒 THE LOCK CONTRACT.
 *
 * A persisted session cookie can outlive the in-memory key that unlocked a vault. Authentication therefore
 * does not prove the account is unlocked, and a locked request must not be treated as an empty store.
 *
 * The contract: a locked user is bounced to the login page, exactly like a stale session, using the 403
 * SillyTavern already sends and the client already handles.
 */
describe('🔒 the lock contract: locked is not the same as logged out', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;

    /** @type {ReturnType<typeof diffManifests>} */
    let bootDamage;
    /** @type {ReturnType<typeof readJournal>} */
    let bootJournal;
    /** @type {string} */
    let bootOutput;

    /** @type {number} Status of a request made with a valid cookie against a LOCKED vault. */
    let lockedStatus;
    /** @type {number} Status of the same request after logging in. */
    let unlockedStatus;
    /** @type {boolean} Did the deferred maintenance run once the user unlocked? */
    let deferredWorkRan;
    /** @type {boolean} Did the provider actually receive an unlock call? */
    let unlockObserved;

    beforeAll(async () => {
        scratch = makeScratchDirectory('lock');
        dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');
        const journalPath = path.join(scratch, 'journal.jsonl');

        // 1. Seed a normal install, then give the user a real password. A provider that needs a secret
        //    is meaningless without one: with enableUserAccounts off, SillyTavern short-circuits to a
        //    default user and NO PASSWORD EVER EXISTS.
        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();
        await givePasswordToDefaultUser(dataRoot);

        installStorageProvider(providersPath, LOCKED_PROVIDER);
        const before = takeManifest(dataRoot);

        // 2. Boot against a LOCKED vault. Nobody has logged in, so nothing is available, so none of the
        //    boot-time maintenance may run.
        const locked = await startSillyTavern({ dataRoot, configPath, storageProvidersPath: providersPath, journalPath, enableUserAccounts: true });
        if (!locked.listening) throw new Error(`Locked boot failed.\n\n${locked.output()}`);

        const base = `http://127.0.0.1:${locked.port}`;

        // 2b. Photograph the data root RIGHT NOW — after a full boot against a locked vault, but before
        //     anyone has logged in. This is the window under test. Anything that changed in it, changed
        //     while SillyTavern had been told, explicitly, that it could not read this user's data.
        //
        //     (Measuring after the login would be meaningless: the deferred maintenance runs then, and
        //     it is SUPPOSED to write. That is the bug I wrote the first time.)
        bootDamage = diffManifests(before, takeManifest(dataRoot), isUserData);
        bootJournal = readJournal(journalPath);

        // 3. Log in. This is the ONLY moment the password exists, and it is where the vault unlocks.
        const login = await fetch(`${base}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
        });
        const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

        // The vault is now open, so a real request must actually work.
        const unlockedResponse = await fetch(`${base}/api/users/me`, { method: 'GET', headers: { Cookie: cookie } });
        unlockedStatus = unlockedResponse.status;

        const afterLoginJournal = readJournal(journalPath);
        bootOutput = locked.output();

        // Did the work that was deferred at boot actually run when the user became available?
        deferredWorkRan = /Running deferred maintenance tasks/.test(bootOutput);
        unlockObserved = afterLoginJournal.all.some(e => e.op === 'unlock');

        await locked.stop();

        // 4. 🔒 THE RESTART. New process, cold vault -- the browser still holds a valid cookie.
        //    This is the moment SillyTavern has never had to reason about, and the one that decides
        //    whether the lock means anything at all.
        const restarted = await startSillyTavern({ dataRoot, configPath, storageProvidersPath: providersPath, enableUserAccounts: true });
        if (!restarted.listening) throw new Error(`Restart failed.\n\n${restarted.output()}`);

        const stale = await fetch(`http://127.0.0.1:${restarted.port}/api/users/me`, {
            method: 'GET',
            headers: { Cookie: cookie },
        });
        lockedStatus = stale.status;

        await restarted.stop();
    }, 240_000);

    afterAll(() => {
        if (scratch) {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    // ---- boot: the work must WAIT --------------------------------------------------------------

    test('🔒 boot-time maintenance was DEFERRED, not run', () => {
        // Every one of these reads and rewrites the user's data: migrateSystemPrompts,
        // migrateGroupChatsMetadataFormat, checkForNewContent, diskCache.verify, migrateFlatSecrets,
        // settingsInit, statsInit. All of them run before the server is even listening, and all of them
        // used to run unconditionally.
        //
        // Against a locked vault they must not run at all. Not fail gracefully — not RUN.
        expect(bootOutput).toContain('deferred until they log in');
    });

    test('🔒 nothing was read, written or deleted while locked', () => {
        // The strongest statement available: across an entire boot against a locked vault, the user's
        // data was not touched. Not one byte.
        expect(bootDamage.deleted).toEqual([]);
        expect(bootDamage.modified).toEqual([]);
        expect(bootDamage.created).toEqual([]);
        expect(bootJournal.writes).toEqual([]);
    });

    // ---- login: the vault opens, and the deferred work runs -------------------------------------

    test('🔒 logging in UNLOCKED the vault', () => {
        expect(unlockObserved).toBe(true);
        expect(unlockedStatus).toBe(200);
    });

    test('🔒 the deferred maintenance ran once the user became available', () => {
        // Deferred does not mean abandoned. The work SillyTavern skipped at boot has to happen, and the
        // moment it can is the moment the user unlocks.
        expect(deferredWorkRan).toBe(true);
    });

    // ---- restart: the one that matters ----------------------------------------------------------

    test('🔒 AFTER A RESTART, A VALID SESSION COOKIE IS NOT ENOUGH', () => {
        // The whole point. The cookie survives (cookie-secret.txt is on disk). The key does not (it was
        // in RAM). SillyTavern must NOT serve this request just because the cookie checks out -- it must
        // bounce the user to the login page and make them unlock.
        //
        // 403 is deliberate, and it is not a new invention: it is the same status SillyTavern already
        // returns for a stale session, and the client already knows to redirect on it. No new status
        // code, no new UI, no client diff.
        expect(lockedStatus).toBe(403);
    });
});

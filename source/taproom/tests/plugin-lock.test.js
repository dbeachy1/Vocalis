import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const CONTEXT_FIXTURE = path.join(testDirectory, 'fixtures', 'context-plugin.mjs');
const SUBKEY_PROVIDER = path.join(testDirectory, 'fixtures', 'subkey-provider.js');

const PASSWORD = 'correct-horse';
const RECOVERY_KEY = 'recovery-key-for-the-test';

/** Short enough that a test can wait for it; long enough that a login is not swept mid-request. */
const IDLE_MS = 2_000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Every shim we installed, so afterAll can take them out again. */
const installed = [];

/**
 * Turn an absolute path into something an `import` statement will accept on any platform.
 * @param {string} absolutePath The path to import
 * @returns {string} A file:// URL
 */
function pathToImportSpecifier(absolutePath) {
    return new URL(`file:///${absolutePath.split(path.sep).join('/')}`).href;
}

/**
 * Install the probe plugin. See `plugin-context.test.js` for why this writes into the real `plugins/`.
 * @param {string} name Base name for the installed shim
 * @returns {void}
 */
function installProbe(name) {
    const target = path.join(PLUGINS_DIRECTORY, `${name}.mjs`);
    fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(pathToImportSpecifier(CONTEXT_FIXTURE))};\n`, 'utf-8');
    installed.push(target);
}

/**
 * Give the default user a password, so accounts are meaningfully on and a vault can be unlocked.
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
 * Boot with the subkey provider and a probe, and log the user in so a key is actually held.
 * @param {string} label A scratch-directory hint
 * @param {Record<string, string>} extraEnv Anything else the provider needs
 * @returns {Promise<{server: any, cookie: string, readLines: () => string[]}>} The running server
 */
async function bootLoggedIn(label, extraEnv = {}) {
    const scratch = makeScratchDirectory(label);
    const dataRoot = path.join(scratch, 'data');
    const configPath = path.join(scratch, 'config.yaml');
    const providersPath = path.join(scratch, 'storage-providers');
    const journalPath = path.join(scratch, 'plugin-journal.txt');

    const seed = await startSillyTavern({ dataRoot, configPath });
    if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
    await seed.stop();
    await setPassword(dataRoot);

    installStorageProvider(providersPath, SUBKEY_PROVIDER);

    const server = await startSillyTavern({
        dataRoot,
        configPath,
        pluginsPath: PLUGINS_DIRECTORY,
        storageProvidersPath: providersPath,
        enableUserAccounts: true,
        providerEnv: {
            SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
            SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
            // Only OUR fixtures register. Jest runs suites in parallel and plugins/ is shared and not
            // configurable, so another suite's shim may be on disk while this server boots (fixture-gate.mjs).
            ST_FIXTURE_IDS: 'context-probe',
            ST_PLUGIN_JOURNAL: journalPath,
            ST_KEYED_STATE: path.join(scratch, 'vault-keys.json'),
            ST_KEYED_HANDLE: 'default-user',
            ST_KEYED_PASSWORD: PASSWORD,
            ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
            ...extraEnv,
        },
    });

    if (!server.listening) throw new Error(`Provider boot failed.\n\n${server.output()}`);

    const login = await fetch(`http://127.0.0.1:${server.port}/api/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
    });

    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

    return {
        server,
        cookie,
        readLines: () => fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [],
    };
}

/**
 * 🔴 IS ANYTHING HOLDING A DERIVED KEY EVER TOLD THE VAULT SHUT?
 *
 * A component that derived a subkey holds key material whose entire promise is that it dies with the vault.
 * Nothing else in this process will tell it. Without the notification, that promise is kept by hope: the
 * plugin holds the key until the process exits, which is precisely the thing the design says it must not do.
 *
 * ⚠️ THE POINT IS THAT IT FIRES ON *EVERY* PATH, NOT THAT IT FIRES. There is more than one way a vault
 * shuts, and the obvious one is not the common one. Hooking logout would have been easy and would have been
 * wrong — almost nobody logs out. They close the tab and walk away, and the IDLE SWEEP is what locks them.
 * A notification wired into `users-private.js` would have covered the rare case and missed the normal one,
 * which is why this is hooked in `storage.lock()` and why both paths are tested below.
 */
describe('the storage lock notification', () => {
    afterAll(() => {
        for (const target of installed) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    describe('when the user logs out', () => {
        /** @type {string[]} */
        let lines = [];

        beforeAll(async () => {
            installProbe('zz-lock-logout-probe');
            const { server, cookie, readLines } = await bootLoggedIn('plugin-lock-logout');

            await fetch(`http://127.0.0.1:${server.port}/api/users/logout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
            });

            await server.stop();
            lines = readLines();
        }, 120_000);

        test('the key was held in the first place — otherwise dropping it proves nothing', () => {
            expect(lines).toContain('ready fired for: default-user');
            expect(lines).toContain('lock had a key to drop: true');
        });

        test('the lock handler fires', () => {
            expect(lines).toContain('lock fired for: default-user');
        });

        test('🔒 by the time we are told, the vault is shut and the key is gone', () => {
            // If either of these says otherwise, the derived key outlived the vault it was supposed to die
            // with, and the whole reason for deriving it rather than minting a new secret is gone.
            expect(lines).toContain('lock isStorageReady: false');
            expect(lines).toContain('lock deriveSubkey: null');
        });
    });

    describe('🔴 when the idle sweep locks them — the path that actually happens', () => {
        /** @type {string[]} */
        let lines = [];

        beforeAll(async () => {
            installProbe('zz-lock-idle-probe');
            const { server, cookie, readLines } = await bootLoggedIn('plugin-lock-idle', {
                ST_KEYED_IDLE_LOCK_MS: String(IDLE_MS),
            });

            // ⚠️ THE USER HAS TO ASK FOR THE LOCK. The provider's number is only a recommendation as of
            // 2026-07-27, so booting with `ST_KEYED_IDLE_LOCK_MS` set no longer arms anything — without
            // this the sweep never fires, and every assertion below fails for a reason that has nothing to
            // do with what this file is testing.
            const armed = await fetch(`http://127.0.0.1:${server.port}/api/users/idle-lock`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ minutes: IDLE_MS / 60_000 }),
            });

            if (!armed.ok) throw new Error(`Could not arm the idle lock: ${armed.status}`);

            // No further requests: the user has "walked away". The sweep runs at lockMs/4, so this is
            // several sweeps' worth of grace before we look.
            await sleep(IDLE_MS * 3);

            await server.stop();
            lines = readLines();
        }, 120_000);

        test('the key was held in the first place', () => {
            expect(lines).toContain('ready fired for: default-user');
            expect(lines).toContain('lock had a key to drop: true');
        });

        test('the lock handler fires with nobody having logged out', () => {
            // Nothing called logout. This fired because `storage.lock()` is the funnel, and the sweep goes
            // through it. A notification hooked into the logout endpoint would see nothing here.
            expect(lines).toContain('lock fired for: default-user');
        });

        test('🔒 and the key is gone', () => {
            expect(lines).toContain('lock deriveSubkey: null');
        });
    });
});

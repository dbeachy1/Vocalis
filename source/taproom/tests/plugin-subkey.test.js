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

/** A provider that offers `deriveSubkey`. */
const SUBKEY_PROVIDER = path.join(testDirectory, 'fixtures', 'subkey-provider.js');
/** A provider that does NOT — `ownsUser` says true, but there is no derivation. The trap. */
const KEYED_PROVIDER = path.join(testDirectory, 'fixtures', 'keyed-provider.js');

const PASSWORD = 'correct-horse';
const RECOVERY_KEY = 'recovery-key-for-the-test';

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
 * Boot with a provider and a probe plugin, log the user in, and hand back what the plugin wrote down.
 * @param {string} providerFixture Absolute path to the provider fixture
 * @param {string} label A scratch-directory hint
 * @returns {Promise<string[]>} The journal lines
 */
async function bootAndUnlock(providerFixture, label) {
    const scratch = makeScratchDirectory(label);
    const dataRoot = path.join(scratch, 'data');
    const configPath = path.join(scratch, 'config.yaml');
    const providersPath = path.join(scratch, 'storage-providers');
    const journalPath = path.join(scratch, 'plugin-journal.txt');

    // 1. Seed the data root with no provider, so the accounts store exists and a password can be set.
    //    Without accounts there is no login, no password, and nothing to unlock -- and the whole test
    //    would pass while proving nothing.
    const seed = await startSillyTavern({ dataRoot, configPath });
    if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
    await seed.stop();
    await setPassword(dataRoot);

    // 2. Boot again, this time with the provider and the probe.
    installStorageProvider(providersPath, providerFixture);

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

            // The provider fixture runs in the CHILD process and cannot be configured any other way. Both
            // fixtures here are built on `keyed-provider`, so both need its whole set: without ST_KEYED_STATE
            // it writes its vault file to '' and the boot dies before the server ever listens.
            ST_KEYED_STATE: path.join(scratch, 'vault-keys.json'),
            ST_KEYED_HANDLE: 'default-user',
            // 🔑 Must match what the login below presents, or `unlock` finds no DEK and the vault stays shut.
            ST_KEYED_PASSWORD: PASSWORD,
            ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
        },
    });

    if (!server.listening) throw new Error(`Provider boot failed.\n\n${server.output()}`);

    // 3. Log in. This is the only moment the password exists, and it is where the vault unlocks -- and
    //    therefore the only moment `onStorageReady` can fire and a key can be derived.
    await fetch(`http://127.0.0.1:${server.port}/api/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
    });

    // The ready handlers are awaited inside the login request, so by the time it returns the plugin has
    // already written its lines. Stop the server before reading, so nothing is still buffered.
    await server.stop();

    return fs.existsSync(journalPath)
        ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
        : [];
}

/**
 * 🔴 CAN A PLUGIN ACTUALLY GET A KEY, AND DOES IT GET THE RIGHT ANSWER WHEN IT CANNOT?
 *
 * `deriveSubkey` returns null for three different reasons, and two of them demand opposite responses from
 * the caller: "no provider" means give up and say so, "locked" means wait. A bare null cannot be acted on,
 * which is why `hasSecureStorage()` exists.
 *
 * ⚠️ The trap this suite exists to nail down: `ownsUser()` looks like the right predicate and is not. It
 * answers a question about password resets, and deliberately answers YES when it does not know -- because a
 * wrong "no" there destroys data. Reuse it here and a provider with no `deriveSubkey` reports "yes, there is
 * a vault", the plugin concludes "locked, I will wait", and it waits for ever for a key that does not exist.
 * `keyed-provider` is exactly that provider, and it is why it is in this file.
 */
describe('deriveSubkey and hasSecureStorage', () => {
    afterAll(() => {
        for (const target of installed) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    describe('a provider that offers derivation', () => {
        /** @type {string[]} */
        let lines = [];

        beforeAll(async () => {
            installProbe('zz-subkey-probe');
            lines = await bootAndUnlock(SUBKEY_PROVIDER, 'plugin-subkey');
        }, 120_000);

        test('the unlock is observed at all — otherwise everything below is vacuous', () => {
            expect(lines).toContain('ready fired for: default-user');
        });

        test('at init, before any login, there is no key — and the answer is "locked", not "never"', () => {
            // The distinction the whole design turns on. A provider IS installed and CAN derive, so
            // hasSecureStorage is true; the user simply has not unlocked yet, so the key is null.
            // A plugin seeing this must wait, not give up.
            expect(lines).toContain('init hasSecureStorage: true');
            expect(lines).toContain('init isStorageReady: false');
            expect(lines).toContain('init deriveSubkey: null');
        });

        test('once unlocked, a key of the requested length comes back', () => {
            expect(lines).toContain('ready hasSecureStorage: true');
            expect(lines).toContain('ready isStorageReady: true');
            expect(lines).toContain('ready deriveSubkey: Buffer(32)');
        });

        test('🔴 the same label twice yields the same bytes — or nothing can be decrypted twice', () => {
            expect(lines).toContain('same label twice is stable: true');
        });

        test('🔴 a different label yields different bytes — or domain separation is a fiction', () => {
            // A provider that ignored `info` would hand identical bytes to every caller and still pass
            // every other assertion in this file. This is the one that notices.
            expect(lines).toContain('different label differs: true');
        });

        test('the requested length is honoured', () => {
            expect(lines).toContain('length honoured: true');
        });
    });

    describe('🔴 a provider that does NOT offer derivation — the ownsUser trap', () => {
        /** @type {string[]} */
        let lines = [];

        beforeAll(async () => {
            installProbe('zz-trap-probe');
            lines = await bootAndUnlock(KEYED_PROVIDER, 'plugin-subkey-trap');
        }, 120_000);

        test('the unlock is observed at all — otherwise everything below is vacuous', () => {
            expect(lines).toContain('ready fired for: default-user');
        });

        test('hasSecureStorage is FALSE even though the provider owns the user and is unlocked', () => {
            // `keyed-provider.ownsUser('default-user')` is TRUE here and the vault is open. If
            // hasSecureStorage were built on ownsUser, this would say true, the plugin would wait for a key,
            // and it would wait until the process died. It must say false: there is no derivation here.
            expect(lines).toContain('ready isStorageReady: true');
            expect(lines).toContain('ready hasSecureStorage: false');
        });

        test('and the key is null, as it must be', () => {
            expect(lines).toContain('ready deriveSubkey: null');
        });
    });
});

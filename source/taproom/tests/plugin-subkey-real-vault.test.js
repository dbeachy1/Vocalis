import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(testDirectory);

// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const CONTEXT_FIXTURE = path.join(testDirectory, 'fixtures', 'context-plugin.mjs');

/**
 * The real Vault, not a fixture.
 *
 * Resolve the provider from an explicit path, an installed `storage-providers/vault` directory, or a sibling
 * checkout. Prefer the installed path because a deployment may not contain the sibling source checkout.
 */
const VAULT = [
    process.env.ST_VAULT_PATH,
    // Installed, as on any real deployment. This is also where `integration/preflight.mjs` resolves it.
    path.join(serverDirectory, 'storage-providers', 'vault'),
    // A sibling checkout, as on a development box with both repositories side by side.
    path.resolve(path.dirname(serverDirectory), 'SillyTavern-Vault'),
].find(candidate => candidate && fs.existsSync(path.join(candidate, 'src', 'provider.js')));

const vaultIsPresent = Boolean(VAULT);
const describeIfVault = vaultIsPresent ? describe : describe.skip;

const PASSWORD = 'correct-horse-battery-staple';
const HANDLE = 'default-user';

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
 * 🔴 THE SEAM NEITHER SIDE TESTS.
 *
 * Vault tests `deriveSubkey` against its own DEK, in its own process (`provider.test.js`, `vault.test.js`).
 * This fork tests its broker against a FIXTURE provider (`subkey-provider.js`) that it wrote itself, to a
 * contract it wrote itself. Vault's end-to-end suite boots this fork for real — and never asks for a subkey.
 *
 * So both sides are green and **nothing has ever run the real Vault through the real broker into a real
 * plugin.** That is the classic place for an integration to be silently wrong: each side tests its own half
 * against its own idea of the other, and the two ideas are never compared.
 *
 * The specific ways it could be wrong, all of which look fine in isolation:
 *
 *   - Vault returns something that is not a `Buffer` (an ArrayBuffer, a hex string) and the fork forwards it
 *     verbatim, so the failure surfaces inside the plugin's database driver, a very long way from here.
 *   - `deriveSubkey` is not an own function property of the provider object, so `hasSecureStorage()` says
 *     false, and every plugin concludes "no vault here" on an install that plainly has one.
 *   - Vault throws while locked instead of returning null, and the fork's `?? null` never gets the chance.
 *
 * This boots the actual SillyTavern with the actual Vault installed as the storage provider and an actual
 * plugin asking for an actual key.
 */
describeIfVault('🔴 real Vault, through the fork, into a plugin', () => {
    /** @type {string[]} */
    let lines = [];
    /** @type {string} */
    let output = '';

    beforeAll(async () => {
        const scratch = makeScratchDirectory('real-vault');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');
        const journalPath = path.join(scratch, 'plugin-journal.txt');
        const userDir = path.join(dataRoot, HANDLE);

        // 1. A stock install with no provider. This is what creates the ACCOUNT.
        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        // 2. Give the account a password, the way the admin UI would. Without one there is no login, no
        //    secret, and nothing for Vault to derive a DEK from.
        const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), expiredInterval: 0 /* no stray timer — see setPassword in integration/harness.mjs */ });
        await store.init();
        const user = await store.getItem(`user:${HANDLE}`);
        const salt = crypto.randomBytes(16).toString('base64');
        user.password = crypto.scryptSync(PASSWORD.normalize(), salt, 64).toString('base64');
        user.salt = salt;
        await store.setItem(`user:${HANDLE}`, user);

        // 3. 🔴 EMPTY THE ACCOUNT, KEEP THE ACCOUNT. Vault refuses to encrypt an account that already holds
        //    data — doing so would leave every existing plaintext file present-but-permanently-unreadable.
        //    A "fresh" install is not empty; it seeds ~196 files of default content on first boot. So this
        //    has to happen AFTER the account exists and BEFORE the first boot with the provider. Copied
        //    from Vault's own end-to-end suite, where the ordering is explained at length.
        fs.rmSync(userDir, { recursive: true, force: true });

        // 4. Install the REAL Vault as the storage provider. It has no runtime dependencies, so a plain copy
        //    is enough; node_modules and .git are its own business.
        fs.mkdirSync(providersPath, { recursive: true });
        fs.cpSync(VAULT, path.join(providersPath, 'vault'), {
            recursive: true,
            filter: src => !src.includes('node_modules') && !src.includes(`${path.sep}.git`),
        });

        installProbe('zz-real-vault-probe');

        // 5. Boot for real: real encryption, real plugin.
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
            },
        });

        if (!server.listening) throw new Error(`Encrypted boot failed.\n\n${server.output()}`);

        // 6. Log in. This creates the vault, unlocks it, and is the only moment a DEK exists.
        const login = await fetch(`http://127.0.0.1:${server.port}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: HANDLE, password: PASSWORD }),
        });

        const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

        // 7. Log out, so the lock notification fires against a real vault shutting.
        await fetch(`http://127.0.0.1:${server.port}/api/users/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
        });

        output = (await server.stop()).output ?? '';
        lines = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];
    }, 180_000);

    afterAll(() => {
        for (const target of installed) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the real Vault registered and the plugin loaded — otherwise this suite proves nothing', () => {
        expect(output).toContain('Storage provider');
        expect(lines.length).toBeGreaterThan(0);
    });

    test('🔴 hasSecureStorage sees the REAL Vault', () => {
        // If this is false against a live encrypted install, every plugin concludes "no vault here" and
        // fails loudly on a machine that plainly has one. It is the difference between `deriveSubkey` being
        // an own function property of Vault's provider object and being anything else.
        expect(lines).toContain('ready hasSecureStorage: true');
        expect(lines).toContain('ready isStorageReady: true');
    });

    test('🔴 a real key comes back, derived from a real DEK', () => {
        // Buffer(32) -- not an ArrayBuffer, not a hex string, not a TypedArray. The fork forwards whatever
        // Vault returns verbatim, so the shape is Vault's contract and this is where it is checked.
        expect(lines).toContain('ready deriveSubkey: Buffer(32)');
    });

    test('🔴 the same label twice gives the same bytes — or nothing decrypts twice', () => {
        expect(lines).toContain('same label twice is stable: true');
    });

    test('🔴 different labels give different keys — Vault namespaces, but does not collide', () => {
        // Vault confines the caller's label inside `sillytavern-encrypted-storage:plugin:` so that no caller
        // can ask for `content:v1` and be handed kContent. That is Vault's policy and a good one; what
        // matters here is that it did not flatten distinct labels into one key on the way.
        expect(lines).toContain('different label differs: true');
    });

    test('the requested length is honoured', () => {
        expect(lines).toContain('length honoured: true');
    });

    test('🔴 before ANY login, the answer is already "wait", never "there is no vault here"', () => {
        // THIS TEST FOUND A REAL BUG AND IS THE REASON THIS SUITE EXISTS.
        //
        // Vault creates a user's vault lazily, on their first unlock -- `ownsUser` is literally "does a
        // vault file exist yet". So at this moment, on a live encrypted install, no user has ever logged in
        // and NO vault file exists for anyone. The first version of `hasSecureStorage` consulted `ownsUser`
        // and therefore answered FALSE here, which a plugin is told to read as "there is no key here and
        // there never will be -- fail loudly". On a working encrypted install. At startup. Every time.
        //
        // The fixture provider could never have caught it: it seeds its vault from env at init, so its
        // `ownsUser` was true from the first instant. Only the real Vault is lazy.
        expect(lines).toContain('init hasSecureStorage: true');
        expect(lines).toContain('init isStorageReady: false');
        expect(lines).toContain('init deriveSubkey: null');
    });

    test('🔒 and when the real vault shuts, the plugin is told and the key is gone', () => {
        expect(lines).toContain(`lock fired for: ${HANDLE}`);
        expect(lines).toContain('lock had a key to drop: true');
        expect(lines).toContain('lock deriveSubkey: null');
    });
});

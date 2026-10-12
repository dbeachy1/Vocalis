import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { startSillyTavern, makeScratchDirectory } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/** See `plugin-context.test.js` — the plugins directory is not configurable, so fixtures go in the real one. */
// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const READFILE_FIXTURE = path.join(testDirectory, 'fixtures', 'readfile-plugin.mjs');
const SEAM_PROVIDER = path.join(testDirectory, 'fixtures', 'seam-provider.js');

const HANDLE = 'default-user';
const TARGET = 'characters/probe.txt';

/** What the plugin must get back. */
const PLAINTEXT = 'CANARY-READFILE-PLAINTEXT-6d02';

/** The seam provider's on-disk marker (`seam-provider.js:34`). Planted by hand so the file looks written. */
const MARK = 'SEAM:';

/** Every file we created, so afterAll can take them out again. */
const created = [];

/**
 * Turn an absolute path into something an `import` statement will accept on any platform.
 * @param {string} absolutePath The path to import
 * @returns {string} A file:// URL
 */
function pathToImportSpecifier(absolutePath) {
    return new URL(`file:///${absolutePath.split(path.sep).join('/')}`).href;
}

/**
 * Install a plugin fixture so a boot will pick it up.
 * @param {string} fixturePath Absolute path to the fixture module
 * @param {string} name Base name for the installed shim
 * @returns {void}
 */
function installPlugin(fixturePath, name) {
    const target = path.join(PLUGINS_DIRECTORY, `${name}.mjs`);
    fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(pathToImportSpecifier(fixturePath))};\n`, 'utf-8');
    created.push(target);
}

/**
 * 🔴 §20 — DOES `context.readFile` GO THROUGH THE PROVIDER, OR JUST THROUGH `fs`?
 *
 * That is the entire capability and it is invisible on a plaintext install, where both answers are identical.
 * A suite that booted without a provider would pass against an implementation that called `fs.readFile`
 * directly — and would have proved nothing, because the reason §20 exists is that **raw `fs` returns
 * ciphertext on an encrypted install** and a plugin has no way to ask the fork to decrypt.
 *
 * So this boots against the seam provider, whose on-disk bytes carry a `SEAM:` prefix, and plants a file that
 * is already marked — as though the provider had written it. Then the fixture reads that one file **twice**:
 * once through `context.readFile` and once through raw `fs`. The assertion is not merely that the first
 * succeeded; it is that **the two answers differ**, which is the only form of this test that cannot pass by
 * accident.
 */
describe('📄 §20 — context.readFile reads through the provider, not around it', () => {
    /** @type {Record<string, string>} */
    let out = {};
    /** @type {number} */
    let status = 0;

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-readfile');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        // The provider fixture has to sit in a directory of its own that the server is pointed at.
        fs.mkdirSync(providersPath, { recursive: true });
        fs.copyFileSync(SEAM_PROVIDER, path.join(providersPath, 'seam-provider.js'));

        // 🔴 PLANT THE FILE **MARKED**. `unmark` is tolerant — it returns unmarked bytes unchanged
        // (`seam-provider.js:78`) — so planting plaintext would make the provider read and the `fs` read
        // identical, and the witness assertion below would pass while proving nothing at all.
        const planted = path.join(dataRoot, HANDLE, TARGET);
        fs.mkdirSync(path.dirname(planted), { recursive: true });
        fs.writeFileSync(planted, `${MARK}${PLAINTEXT}`, 'utf-8');

        installPlugin(READFILE_FIXTURE, 'zz-readfile-probe');

        // startSillyTavern, not bootSillyTavern: the latter shuts down again immediately, and this suite has
        // to talk to a LIVE server.
        const server = await startSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            storageProvidersPath: providersPath,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'readfile-probe',
                ST_READFILE_TARGET: TARGET,
            },
        });

        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/readfile-probe/probe?handle=${HANDLE}`);
            status = response.status;
            out = status === 200 ? await response.json() : {};
        } finally {
            await server.stop();
        }
    }, 120_000);

    afterAll(() => {
        for (const target of created) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the probe ran at all — otherwise every assertion below is vacuous', () => {
        expect(status).toBe(200);
        expect(out.present).toBe('function');
    });

    test('🔴 the plugin gets PLAINTEXT back, through the provider', () => {
        // The capability. Without this a plugin on an encrypted install can find a card and not read it.
        expect(out.read).toBe(`OK ${PLAINTEXT}`);
    });

    test('🔴 THE WITNESS: a raw fs read of the same file returns the MARKED bytes, so the two differ', () => {
        // This is the mutation §20.5 names. An implementation that called `fs.readFile` instead of
        // `storage.readFile` would make these two identical and would still pass the test above on a
        // plaintext install. Here it cannot: the provider read is unmarked and the direct read is not.
        expect(out.direct).toBe(`OK ${MARK}${PLAINTEXT}`);
        expect(out.direct).not.toBe(out.read);
    });

    test('a path climbing out of the user directory is refused', () => {
        expect(out.climb).toMatch(/^THREW/);
        expect(out.climb).toMatch(/outside the user's directory/);
        expect(out.climb).toMatch(/readfile-probe/);
    });

    test('an absolute path is refused too — path.resolve would otherwise silently honour it', () => {
        expect(out.absolute).toMatch(/^THREW/);
        expect(out.absolute).toMatch(/outside the user's directory/);
    });

    test('🔴 a missing file THROWS, named with the plugin — it never comes back empty', () => {
        // §6.5. A memory plugin that read "vault locked" or "no such file" as "this character has no card"
        // would extract a baseline of nothing and never know it had been wrong.
        expect(out.missing).toMatch(/^THREW/);
        expect(out.missing).toMatch(/readfile-probe/);
        expect(out.missing).not.toBe('OK ');
    });

    test('a handle that is really a path segment is refused, as userDirectory refuses one', () => {
        expect(out.badhandle).toMatch(/^THREW/);
        expect(out.badhandle).toMatch(/user handle/);
    });
});

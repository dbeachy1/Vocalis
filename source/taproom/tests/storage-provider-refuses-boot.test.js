import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { diffManifests, isUserData, takeManifest } from './util/data-root-manifest.js';
import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const REFUSING_PROVIDER = path.join(testDirectory, 'fixtures', 'refusing-provider.js');

/**
 * 🔴 A PROVIDER THAT REFUSES THE CONFIGURATION MUST STOP THE BOOT, AND MUST CHANGE NOTHING.
 *
 * Vault rejects configurations it cannot protect, including passwordless accounts. A missing or failed
 * provider must stop boot: plaintext fallback can expose an existing store, and startup maintenance may
 * rewrite data the provider cannot read. This test checks the refusal, its diagnostic, and that existing
 * data remains unchanged.
 */
describe('🔴 a provider that refuses its configuration stops the boot', () => {
    /** @type {string} */
    let scratch;
    /** @type {import('./util/st-server.js').BootResult} */
    let boot;
    /** @type {ReturnType<typeof diffManifests>} */
    let damage;

    beforeAll(async () => {
        scratch = makeScratchDirectory('refuses-boot');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        // 1. Boot once on the plain filesystem so the data root is a real one — the default user, their
        //    settings, the bundled characters and presets. This is the install we are about to threaten.
        const seed = await startSillyTavern({ dataRoot, configPath });

        if (!seed.listening) {
            throw new Error(`The seed boot never came up, so this test cannot run.\n\n${seed.output()}`);
        }

        await seed.stop();

        // 2. Photograph it, byte for byte.
        const before = takeManifest(dataRoot);

        if (![...before.keys()].some(isUserData)) {
            throw new Error('The seed boot produced no user data, so this test would prove nothing.');
        }

        // 3. Now boot against a provider that refuses at init().
        installStorageProvider(providersPath, REFUSING_PROVIDER);
        const refused = await startSillyTavern({ dataRoot, configPath, storageProvidersPath: providersPath });

        boot = await refused.stop();

        // 4. Count the bodies.
        damage = diffManifests(before, takeManifest(dataRoot), isUserData);
    }, 240_000);

    afterAll(() => {
        if (scratch) {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    test('the server did NOT come up', () => {
        expect(boot.listening).toBe(false);
    });

    test('it said why, rather than dying silently', () => {
        // The operator has to be able to find out what happened from the output alone. A refusal that
        // exits quietly is indistinguishable from a crash, and gets "fixed" by removing the provider.
        expect(boot.output).toContain('REFUSING TO START');
        expect(boot.output).toContain('an enabled account has NO PASSWORD');
    });

    test('the refusal names the provider, so the operator knows what to go and fix', () => {
        expect(boot.output).toContain('refusing-provider');
    });

    test('🔴 NOTHING WAS DELETED', () => {
        expect(damage.deleted).toEqual([]);
    });

    test('🔴 NOTHING WAS REWRITTEN', () => {
        expect(damage.modified).toEqual([]);
    });

    test('🔴 NOTHING NEW WAS WRITTEN', () => {
        expect(damage.created).toEqual([]);
    });
});

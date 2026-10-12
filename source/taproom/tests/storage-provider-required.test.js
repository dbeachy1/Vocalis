import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';

import { loadStorageProviders } from '../src/storage-provider-loader.js';
import { unregisterStorageProvider } from '../src/storage.js';

let scratch;

afterEach(() => {
    unregisterStorageProvider();
    if (scratch) {
        fs.rmSync(scratch, { recursive: true, force: true });
        scratch = undefined;
    }
});

function makeScratch() {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'required-provider-'));
    return scratch;
}

describe('required storage provider', () => {
    test('refuses a missing provider path', async () => {
        const providersPath = path.join(makeScratch(), 'missing');
        const environment = { requiredProviderId: 'vault' };

        await expect(loadStorageProviders(providersPath, environment)).rejects.toThrow(/Required storage provider 'vault' is missing/);
    });

    test('refuses an empty provider path', async () => {
        const providersPath = makeScratch();

        await expect(loadStorageProviders(providersPath, { requiredProviderId: 'vault' })).rejects.toThrow(/Required storage provider 'vault' is missing/);
    });

    test('refuses a loaded provider with the wrong identity before registration', async () => {
        const providersPath = makeScratch();
        const providerFile = path.join(providersPath, 'wrong.mjs');
        fs.writeFileSync(providerFile, "export default async () => ({ id: 'other-provider', init: async () => { throw new Error('must not initialize'); } });\n");

        await expect(loadStorageProviders(providersPath, { requiredProviderId: 'vault' }))
            .rejects.toThrow(/Required storage provider 'vault', but 'other-provider' was loaded/);
    });

    test('keeps provider absence optional when no requirement is configured', async () => {
        const providersPath = path.join(makeScratch(), 'missing');

        await expect(loadStorageProviders(providersPath, {})).resolves.toBeUndefined();
    });
});

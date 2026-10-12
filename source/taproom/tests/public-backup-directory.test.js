import path from 'node:path';
import process from 'node:process';
import { describe, expect, test } from '@jest/globals';

import { getPublicBackupDirectory } from '../src/constants.js';

describe('shared backup directory', () => {
    test('resolves under the configured writable data root', () => {
        const dataRoot = path.join(process.cwd(), '.test-data-root');

        expect(getPublicBackupDirectory(dataRoot)).toBe(path.join(dataRoot, 'backups'));
        expect(path.isAbsolute(getPublicBackupDirectory(dataRoot))).toBe(true);
    });

    test('retains the source-mode working-directory fallback', () => {
        const previousDataRoot = globalThis.DATA_ROOT;
        delete globalThis.DATA_ROOT;
        try {
            expect(getPublicBackupDirectory()).toBe(path.resolve(process.cwd(), 'backups'));
        } finally {
            if (previousDataRoot === undefined) delete globalThis.DATA_ROOT;
            else globalThis.DATA_ROOT = previousDataRoot;
        }
    });
});

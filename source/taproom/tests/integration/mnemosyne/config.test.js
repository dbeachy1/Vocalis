import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

/**
 * 🚧 Suite B's counterpart to `integration/vault/config.test.js` — the harness, not the product.
 *
 * Same two jobs: prove the lifecycle hooks are wired so scratch trees get swept, and give
 * `testPathIgnorePatterns` something real to exclude, so the proof that `npm run test:unit` ignores
 * `integration/` is not a proof about an empty folder.
 *
 * ⚠️ This suite will eventually install Mnemosyne into the repository's one real `plugins/`, because
 * that directory is not steerable (`server-main.js` builds it as `path.join(serverDirectory,
 * 'plugins')`). That is why the config sets `maxWorkers: 1` — see `fixtures/fixture-gate.mjs` for
 * what parallel test FILES do to a process-wide directory.
 */

const suiteDirectory = path.dirname(fileURLToPath(import.meta.url));

describe('🚧 the mnemosyne integration config', () => {
    test('🔑 globalSetup ran, so scratch trees will be swept', () => {
        expect(typeof process.env.ST_TEST_SCRATCH_MANIFEST).toBe('string');
        expect(process.env.ST_TEST_SCRATCH_MANIFEST).not.toBe('');
    });

    test('🎯 roots points at this suite and not at the whole tests folder', () => {
        expect(path.basename(suiteDirectory)).toBe('mnemosyne');
        expect(path.basename(path.dirname(suiteDirectory))).toBe('integration');
    });
});

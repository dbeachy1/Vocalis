import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

/**
 * 🚧 The first file in Suite A, and it deliberately tests the harness rather than the product.
 *
 * Two jobs, and the second one is the reason it was written first.
 *
 * 1. A new jest config that forgets `globalSetup`/`globalTeardown` still runs green — it just leaks
 *    every scratch tree it creates, silently, forever. Nothing else notices. So this asserts the
 *    lifecycle is wired before any suite starts making directories.
 *
 * 2. It is the bait that makes the `npm run test:unit` gate proof mean something. `jest.config.mjs`
 *    sets no `testMatch` and no `roots`, so jest's defaults WOULD discover this file; the
 *    `testPathIgnorePatterns` entry for `<rootDir>/integration/` is the only thing stopping it. An
 *    empty `integration/` folder would prove nothing about that rule, because there would be nothing
 *    to discover either way.
 */

const suiteDirectory = path.dirname(fileURLToPath(import.meta.url));

describe('🚧 the vault integration config', () => {
    test('🔑 globalSetup ran, so scratch trees will be swept', () => {
        expect(typeof process.env.ST_TEST_SCRATCH_MANIFEST).toBe('string');
        expect(process.env.ST_TEST_SCRATCH_MANIFEST).not.toBe('');
    });

    test('🎯 roots points at this suite and not at the whole tests folder', () => {
        expect(path.basename(suiteDirectory)).toBe('vault');
        expect(path.basename(path.dirname(suiteDirectory))).toBe('integration');
    });
});

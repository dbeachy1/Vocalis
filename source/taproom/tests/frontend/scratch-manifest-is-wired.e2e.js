import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory } from '../util/st-server.js';

/**
 * 🚧 THE PLAYWRIGHT HALF OF `integration/vault/config.test.js`, AND IT TESTS THE HARNESS ON PURPOSE.
 *
 * That file's comment predicted this exact failure — *"a new jest config that forgets
 * `globalSetup`/`globalTeardown` still runs green — it just leaks"* — and the assertion was written on the
 * jest side only. The Playwright side then did precisely that, for months: `playwright.config.js` had a
 * `globalSetup` that claimed a port slot and nothing else, and no teardown at all. Thirty `*.e2e.js` specs
 * each made a ~30 MB SillyTavern data root per run and nothing ever removed one — 292 directories and
 * 8.75 GB in five days, found by looking at `%TEMP%` rather than by anything going red.
 *
 * 🔴 SO THE POINT IS THAT A LEAK CANNOT FAIL A RUN AND THIS IS THE ONLY THING THAT WILL. Deleting the
 * `globalTeardown` line, or moving the manifest below the `ST_TEST_PORT_BASE` early return — the shape the
 * original wiring had — leaves every spec in this directory passing. Only this file goes red.
 *
 * ⚠️ IT MUST NOT BOOT A SERVER, AND IT MUST NOT NAME THE BOOT CALL EITHER. This belongs in the ordinary
 * parallel batch beside the DOM-only specs — the wiring it checks is the same wiring, and a server would
 * cost 30 MB to prove nothing extra. But `util/server-booting-specs.js` decides that by searching the file
 * for the boot function's name followed by an open paren, and it searches the whole file: an earlier draft
 * of this comment mentioned the call by name and put this spec in the isolated set, where it would have
 * spent a whole process on three assertions about an environment variable.
 */
test.describe('🚧 the browser suite scratch lifecycle', () => {
    test('🔑 globalSetup ran, so scratch trees will be swept', () => {
        // The worker is forked after `globalSetup`, which is the whole reason `process.env` carries this.
        expect(typeof process.env.ST_TEST_SCRATCH_MANIFEST).toBe('string');
        expect(process.env.ST_TEST_SCRATCH_MANIFEST).not.toBe('');
    });

    test('🎯 the manifest is named where the next run can reclaim it', () => {
        const manifestPath = /** @type {string} */ (process.env.ST_TEST_SCRATCH_MANIFEST);

        // `reclaimOrphanedRuns` is the only thing that ever cleans up after a killed run, and it finds its
        // work by matching `st-run-<pid>-<n>.manifest` in the temp directory. A manifest named anything
        // else, or put anywhere else, is swept by this run and by nothing afterwards.
        expect(path.dirname(path.resolve(manifestPath))).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(manifestPath)).toMatch(/^st-run-\d+-\d+\.manifest$/);
    });

    test('🧹 a scratch directory made now is recorded in it', () => {
        const manifestPath = /** @type {string} */ (process.env.ST_TEST_SCRATCH_MANIFEST);
        const directory = makeScratchDirectory('manifest-guard');

        try {
            // The env var existing is not the same as the append working, and the two failed together:
            // `makeScratchDirectory` skips the append silently when the variable is absent, so a spec that
            // only checked the variable would still pass against a manifest nothing writes to.
            expect(fs.readFileSync(manifestPath, 'utf-8')).toContain(directory);
        } finally {
            // Removed here rather than left for the teardown: this one is the test's own litter, and the
            // sweep proving itself on it would prove nothing about the specs that matter.
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

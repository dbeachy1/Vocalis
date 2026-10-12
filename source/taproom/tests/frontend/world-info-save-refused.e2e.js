/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';
import { testSetup } from './frontent-test-utils.js';

/*
 * 🔴 A LOREBOOK WRITE THE SERVER REFUSED MUST NOT LOOK LIKE A SAVE.
 *
 * `/api/worldinfo/edit` answers 409 when the target file is envelope-wrapped and the storage provider
 * that wrote it is not registered (`DESIGN_STORAGE_PROVENANCE.md` §7 surface 4) — the guard that stops a
 * plausible-looking plaintext world being written over the user's ciphertext. `loadWorldInfo` already
 * announces the READ half of that refusal. The WRITE half said nothing whatsoever: `_save` never looked
 * at the response, so a 409 resolved exactly like a 200.
 *
 * 🔴 AND THE SILENCE WAS NOT MERELY UNHELPFUL, BECAUSE `saveWorldInfo` SEEDS THE CACHE FIRST. After a
 * refusal the client held, in `worldInfoCache`, a document that was not on disk — and the cache is what
 * every later `loadWorldInfo` reads. So the editor, the prompt builder and any extension that asked went
 * on being served the unwritten version indefinitely, indistinguishably from a real save, while
 * `WORLDINFO_UPDATED` fired to announce it. The bytes were safe; the user's belief about them was not.
 *
 * ## Why the 409 is injected rather than staged with a real envelope
 *
 * `tests/worldinfo-unavailable-guard.test.js` already proves the SERVER refuses, with real enveloped
 * bytes and a real absent provider. What is under test here is the CLIENT's reaction to that refusal,
 * and routing the response is the honest way to isolate it: no provider fixture, no password, no
 * onboarding — just the status the server is independently known to send. Staging the envelope too
 * would test the server a second time and leave this spec passing or failing for reasons that have
 * nothing to do with the handler.
 *
 * ⚠️ THE POSITIVE CONTROL IS LOAD-BEARING. Every assertion in the refusal test is a negative — no cache
 * entry, no event, no change on disk — and all three pass just as happily if `saveWorldInfo` was never
 * reached, if the world was never created, or if the page failed to load the module. The accepted-write
 * test runs the identical sequence with the route removed and demands the opposite of each one.
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** The book under test. */
const BOOK = 'STAGE_REFUSED_WRITE';

/** What the fork's 409 body looks like — `{ storage: … }`, as `src/endpoints/worldinfo.js` sends it. */
const REFUSAL_BODY = JSON.stringify({
    storage: { unavailable: true, requiresProvider: 'never-installed', identity: 'default-user' },
});

test.describe('World Info: a refused save does not look like a save', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let worldsDirectory;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('wi-save-refused-e2e');
        const dataRoot = path.join(scratch, 'data');
        server = await startSillyTavern({
            dataRoot,
            configPath: path.join(scratch, 'config.yaml'),
        });
        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;
        await stepPastFirstRun(dataRoot);
        worldsDirectory = path.join(dataRoot, 'default-user', 'worlds');
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    /** The book's bytes on disk — what a reload would actually read. */
    function onDisk() {
        return JSON.parse(fs.readFileSync(path.join(worldsDirectory, `${BOOK}.json`), 'utf-8'));
    }

    /**
     * Open the app and create the book for real, through the normal path, so the starting state is a
     * world that genuinely exists both on disk and in the cache.
     * @param {import('@playwright/test').Page} page Playwright page
     */
    async function openAndSeed(page) {
        fs.rmSync(path.join(worldsDirectory, `${BOOK}.json`), { force: true });

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

        // 🔴 `APP_READY`, NOT a locator. `#world_editor_select` is in the static markup, so it attaches
        // long before `initWorldInfo` has run — waiting on it drives a half-initialised page, and the
        // failure lands far from the cause: `world_names` is still undefined and `createNewWorldInfo`
        // dies inside `checkOverwriteExistingData` with "cannot read properties of undefined". The
        // helper's own comment documents this rake; it was stepped on here anyway.
        await testSetup.awaitAppReady({ page });

        const created = await page.evaluate(async (name) => {
            const { createNewWorldInfo } = await import('./scripts/world-info.js');
            return await createNewWorldInfo(name, { interactive: false });
        }, BOOK);

        expect(created, 'the fixture book was not created, so nothing below means anything').toBe(true);
        expect(onDisk()).toEqual({ entries: {} });
    }

    /**
     * Attempt an immediate whole-document save of a book with one entry in it, and report everything an
     * observer could use to decide whether it worked.
     * @param {import('@playwright/test').Page} page Playwright page
     */
    function attemptSave(page) {
        return page.evaluate(async (name) => {
            const { saveWorldInfo, worldInfoCache } = await import('./scripts/world-info.js');
            const { eventSource, event_types } = await import('./script.js');

            let announced = false;
            const listener = (updatedName) => {
                if (updatedName === name) announced = true;
            };
            eventSource.on(event_types.WORLDINFO_UPDATED, listener);

            try {
                const document = { entries: { 0: { uid: 0, key: ['marker'], content: 'written' } } };
                const saved = await saveWorldInfo(name, document, true);

                return {
                    saved,
                    cached: worldInfoCache.has(name),
                    announced,
                };
            } finally {
                eventSource.removeListener(event_types.WORLDINFO_UPDATED, listener);
            }
        }, BOOK);
    }

    test('🔴 a 409 evicts the optimistic cache entry, fires no event, and reports failure', async ({ page }) => {
        await openAndSeed(page);

        await page.route('**/api/worldinfo/edit', (route) => route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: REFUSAL_BODY,
        }));

        const result = await attemptSave(page);

        // The caller is told, rather than left to assume.
        expect(result.saved, 'a refused save reported success').toBe(false);

        // 🔴 The assertion the whole spec exists for: nothing unwritten survives in the cache to be
        // served to the editor, the prompt builder or an extension.
        expect(result.cached, 'the cache kept a document the server refused to write').toBe(false);

        // No announcement of an update that did not happen.
        expect(result.announced, 'WORLDINFO_UPDATED fired for a write that was refused').toBe(false);

        // And the file is untouched — the status code is only a proxy for this.
        expect(onDisk()).toEqual({ entries: {} });
    });

    test('the user is told, rather than left to find out later', async ({ page }) => {
        await openAndSeed(page);

        await page.route('**/api/worldinfo/edit', (route) => route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: REFUSAL_BODY,
        }));

        await attemptSave(page);

        // Named for the provider the fork knows is missing, and sticky (`timeOut: 0`) because a refused
        // write is not something to miss while looking elsewhere.
        await expect(page.locator('#toast-container .toast-error')).toContainText('never-installed', { timeout: 10_000 });
    });

    test('an accepted save still caches, still announces, and still lands on disk', async ({ page }) => {
        await openAndSeed(page);

        // No route: the real endpoint answers. Identical sequence, opposite expectations — this is what
        // stops the three negatives above from passing vacuously.
        const result = await attemptSave(page);

        expect(result.saved).toBe(true);
        expect(result.cached).toBe(true);
        expect(result.announced).toBe(true);
        expect(onDisk().entries['0'].content).toBe('written');
    });
});

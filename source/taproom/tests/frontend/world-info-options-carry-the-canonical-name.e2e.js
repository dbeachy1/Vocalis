/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 EVERY WORLD OPTION CARRIES ITS CANONICAL NAME, INCLUDING THE ONES BUILT AT BOOT.
 *
 * `markUnavailableWorlds()` rewrites an unreadable world's option label to "⚠ <name>" — disabled,
 * titled with the reason, prefixed so the row reads as unavailable at a glance. Every helper that
 * has to turn an option back into a world name therefore reads `dataset.worldName` and falls back to
 * the LABEL only when it is missing:
 *
 *     const canonical = this.dataset?.worldName ?? $(this).text();      // getWIElement
 *     String(option.data('worldName') ?? option.text());                // updateWorldInfoList
 *
 * That fallback is the thing this spec protects, because it is a trap rather than a safety net: for a
 * MARKED option the label is "⚠ Book" and the canonical name is "Book", so the comparison silently
 * finds nothing — which is precisely the bug both of those comments were written about. Rename and
 * the two selection helpers no-op with no error anywhere, and `updateWorldInfoList` drops the open
 * book out of the editor on the next refresh.
 *
 * 🔴 SO THE FALLBACK MUST NEVER BE REACHED, and until this spec it was reached constantly.
 * `updateWorldInfoList` sets the dataset; `loadWorldInfoSettings` — which is what actually builds
 * these two dropdowns at boot, from an interpolated HTML string — did not. So from page load until
 * something happened to trigger a full list refresh, every option on screen was a fallback case, and
 * the unreadable ones were broken. The fix is that both builders now agree.
 *
 * ⚠️ THE MARKER ASSERTION IS THE NEGATIVE CONTROL AND IT IS LOAD-BEARING. "The dataset matches the
 * name" passes trivially if `markUnavailableWorlds` never ran, if the envelope stopped reading as
 * unavailable, or if the fixture's unreadable book quietly became readable — and in all three cases
 * the interesting half is untested. Asserting that the marked option's LABEL differs from its
 * canonical name is what proves the divergence this spec exists for is actually present.
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** A perfectly ordinary book. */
const ORDINARY = 'OPTIONS_ORDINARY_BOOK';
/** A book whose storage provider is not installed, so it lists but cannot be read. */
const UNREADABLE = 'OPTIONS_UNREADABLE_BOOK';

/** The shape of a book the fork can see but not decode: an envelope naming a provider nobody has. */
const ENVELOPED = Buffer.from('stenv:1:never-installed:VGhpcyBpcyBub3QgcGxhaW50ZXh0Lg==', 'utf-8');

test.describe('World Info: the dropdowns carry canonical names, not labels', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeAll(async () => {
        // ⚠️ Inside the hook, not via describe.configure: `test.setTimeout()` is what raises a HOOK's
        // budget. `describe.configure({ timeout })` governs the tests and leaves beforeAll on 30s.
        test.setTimeout(180_000);

        const scratch = makeScratchDirectory('wi-options-canonical-name-e2e');
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

        const worldsDirectory = path.join(dataRoot, 'default-user', 'worlds');
        fs.mkdirSync(worldsDirectory, { recursive: true });
        fs.writeFileSync(path.join(worldsDirectory, `${ORDINARY}.json`), JSON.stringify({ entries: {} }));
        fs.writeFileSync(path.join(worldsDirectory, `${UNREADABLE}.json`), ENVELOPED);
    });

    test.afterAll(async () => {
        if (server) {
            await server.stop();
        }
    });

    /**
     * Boots the page and reads both world dropdowns once the marker has had a chance to run.
     * @param {import('@playwright/test').Page} page Playwright page
     * @returns {Promise<Record<string, {value: string, label: string, dataName: string|undefined, disabled: boolean}[]>>} Options per select
     */
    async function readDropdowns(page) {
        await page.goto(base, { waitUntil: 'domcontentloaded' });

        // getContext() throws during early boot (TDZ on script.js's module bindings), so swallow and retry.
        await page.waitForFunction(() => {
            try {
                return typeof globalThis.SillyTavern?.getContext?.() === 'object';
            } catch {
                return false;
            }
        }, undefined, { timeout: 120_000 });

        // `markUnavailableWorlds()` is deliberately fire-and-forget — it enriches the list a beat after
        // it is built — so wait for its effect rather than for the list to merely exist.
        await page.waitForFunction((unreadable) => Array.from(
            document.querySelectorAll('#world_editor_select option:not([value=""])'),
        ).some(o => o.textContent.trim().endsWith(unreadable) && o.disabled), UNREADABLE, { timeout: 60_000 });

        return page.evaluate(() => {
            const read = (id) => Array.from(document.querySelectorAll(`${id} option:not([value=""])`)).map(o => ({
                value: o.value,
                label: o.textContent.trim(),
                dataName: o.dataset.worldName,
                disabled: o.disabled,
            }));

            return { editor: read('#world_editor_select'), global: read('#world_info') };
        });
    }

    test('🔴 every option in both dropdowns carries data-world-name', async ({ page }) => {
        const dropdowns = await readDropdowns(page);

        for (const [which, options] of Object.entries(dropdowns)) {
            expect(options.length, `${which} should list both fixture books`).toBeGreaterThanOrEqual(2);

            for (const option of options) {
                expect(option.dataName, `${which} option "${option.label}" has no canonical name`)
                    .toBeTruthy();
            }

            expect(options.map(o => o.dataName).sort())
                .toEqual(expect.arrayContaining([ORDINARY, UNREADABLE]));
        }
    });

    test('🔴 the unreadable book is marked — so the label genuinely diverges from the name', async ({ page }) => {
        // THE NEGATIVE CONTROL. Without this, the test above passes on a fixture where nothing was ever
        // marked and the fallback would have worked anyway.
        const { editor } = await readDropdowns(page);

        // 🔴 Found by LABEL, deliberately: this test has to hold whether or not the dataset is set, or
        // it stops being a control on the fixture and becomes a second copy of the test above.
        const marked = editor.find(o => o.label.includes(UNREADABLE));
        const ordinary = editor.find(o => o.label.includes(ORDINARY));

        expect(marked).toBeDefined();
        expect(marked.disabled).toBe(true);
        expect(marked.label).not.toBe(UNREADABLE);
        expect(marked.label).toContain(UNREADABLE);

        // And the readable one is NOT marked, so "the label differs" is a property of unavailability
        // rather than of every option.
        expect(ordinary).toBeDefined();
        expect(ordinary.disabled).toBe(false);
        expect(ordinary.label).toBe(ORDINARY);
    });

    test('🔴 identifying a world by option never has to read the label', async ({ page }) => {
        // The invariant the helpers actually depend on, stated directly: resolving every option through
        // the same expression they use must produce the canonical names and never a marked label.
        const { editor } = await readDropdowns(page);
        const resolved = editor.map(o => o.dataName ?? o.label);

        expect(resolved).toEqual(expect.arrayContaining([ORDINARY, UNREADABLE]));
        expect(resolved.some(name => name.startsWith('⚠'))).toBe(false);
    });
});

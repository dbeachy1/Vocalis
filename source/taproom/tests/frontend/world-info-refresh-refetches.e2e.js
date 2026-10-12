/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';
import { testSetup } from './frontent-test-utils.js';

/*
 * 🔴 THE REFRESH BUTTON DID NOT REFRESH ANYTHING.
 *
 * The refresh action must fetch current World Info rather than re-rendering stale in-memory data.
 *
 * Two layers of staleness, and the button cleared neither:
 *
 *   1. `updateEditor` is REASSIGNED inside `displayWorldEntries` to a closure over the `data` it was
 *      handed. `#world_refresh` called `updateEditor(previous)`, so it re-rendered the same in-memory
 *      object it had already rendered. It could not observe a change of any kind — not from another
 *      tab, not from an extension, not from the disk.
 *   2. Even a refetch would not have helped on its own: `worldInfoCache` is seeded by `saveWorldInfo`
 *      and never invalidated for a write THIS page did not make, so `loadWorldInfo` answers from it.
 *
 * A worldbook is the one thing in SillyTavern that several writers touch — the editor, an extension,
 * a second tab, a tool pushing generated lore in. Refresh is the affordance the UI offers for exactly
 * that, and it was decorative.
 *
 * ## Why the change is made on disk rather than through a second browser context
 *
 * What is under test is whether the button goes back to the SERVER. Writing the file directly is the
 * cleanest way to produce a document this page provably has never seen: no second session to
 * synchronise, no second cache to reason about, and the server reads it back through its ordinary
 * `/api/worldinfo/get` path. It is also exactly what the page experiences when another writer wins —
 * bytes on disk it has no idea about.
 *
 * ⚠️ THE NEGATIVE CONTROL IS LOAD-BEARING. "The entry is visible after Refresh" passes just as well if
 * the entry had always been visible, if the fixture never seeded a stale view, or if the editor
 * re-rendered from a cache that happened to be right. So every test asserts the BEFORE state too, and
 * `the stale view is genuinely stale` fails loudly if the fixture stops producing one.
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** The book the editor is looking at. */
const BOOK = 'STAGE_REFRESH_TARGET';
/** A book created entirely behind the page's back, to test the dropdown half. */
const UNSEEN_BOOK = 'STAGE_REFRESH_UNSEEN';
/** Comment text of the entry the page starts out knowing about. */
const KNOWN = 'entry-the-page-already-has';
/** Comment text of the entry written behind its back. */
const ARRIVED = 'entry-that-arrived-elsewhere';

test.describe('World Info: Refresh goes back to the server', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let worldsDirectory;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('wi-refresh-refetches-e2e');
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

    /**
     * One world book document with the given entry comments, in the shape the server stores.
     * @param {string[]} comments One entry per comment
     * @returns {object} The document
     */
    const bookWith = (comments) => ({
        entries: Object.fromEntries(comments.map((comment, uid) => [
            String(uid),
            { uid, key: [`key-${uid}`], keysecondary: [], comment, content: `content of ${comment}`, disable: false },
        ])),
    });

    /** @param {string} name Book name @returns {string} Its path on disk */
    const bookPath = (name) => path.join(worldsDirectory, `${name}.json`);

    /**
     * Boot the app, create the book with one entry through the normal path, and open it in the editor.
     * @param {import('@playwright/test').Page} page Playwright page
     * @returns {Promise<void>}
     */
    async function openWithOneEntry(page) {
        fs.rmSync(bookPath(BOOK), { force: true });
        fs.rmSync(bookPath(UNSEEN_BOOK), { force: true });

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        // 🔴 APP_READY, not a locator: `#world_editor_select` is in the static markup and attaches long
        // before `initWorldInfo` has run, so waiting on it drives a half-initialised page.
        await testSetup.awaitAppReady({ page });

        const seeded = await page.evaluate(async ({ name, document }) => {
            const { createNewWorldInfo, saveWorldInfo, updateWorldInfoList, showWorldEditor } = await import('./scripts/world-info.js');
            const created = await createNewWorldInfo(name, { interactive: false });
            if (!created) return { created };
            await saveWorldInfo(name, document, true);
            await updateWorldInfoList();
            await showWorldEditor(name);
            return { created };
        }, { name: BOOK, document: bookWith([KNOWN]) });

        expect(seeded.created, 'the fixture book was not created, so nothing below means anything').toBe(true);
        await expect(page.locator('#world_popup_entries_list .world_entry')).toHaveCount(1);
    }

    /** @param {import('@playwright/test').Page} page Playwright page @returns {Promise<string[]>} Rendered entry comments */
    const renderedComments = (page) => page.evaluate(() =>
        Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'))
            .map(el => String(el.querySelector('textarea[name="comment"]')?.value ?? '')));

    /**
     * Press Refresh the way a user does, through the handler rather than the mouse.
     *
     * ⚠️ `#world_refresh` lives inside the World Info drawer, which is `display: none` until the
     * drawer is opened — Playwright's `.click()` waits for visibility and times out, even forced.
     * A jQuery trigger runs the same bound handler the UI would, which is what is under test.
     * @param {import('@playwright/test').Page} page Playwright page
     * @returns {Promise<void>}
     */
    const pressRefresh = (page) => page.evaluate(() => $('#world_refresh').trigger('click'));

    /** @param {import('@playwright/test').Page} page Playwright page @returns {Promise<string[]>} Dropdown book names */
    const listedBooks = (page) => page.evaluate(() =>
        Array.from(document.querySelectorAll('#world_editor_select option'))
            .map(o => String(o.dataset.worldName ?? '')).filter(Boolean));

    test('the stale view is genuinely stale — the fixture produces the bug', async ({ page }) => {
        await openWithOneEntry(page);

        // Another writer wins: the file now has two entries, and this page has no idea.
        fs.writeFileSync(bookPath(BOOK), JSON.stringify(bookWith([KNOWN, ARRIVED])), 'utf-8');

        expect(await renderedComments(page)).toEqual([KNOWN]);
        expect(
            await page.evaluate(async name => {
                const { worldInfoCache } = await import('./scripts/world-info.js');
                return Object.keys(worldInfoCache.get(name)?.entries ?? {}).length;
            }, BOOK),
            'the cache should still be holding the one-entry copy, or the test below proves nothing',
        ).toBe(1);
    });

    test('🔴 Refresh shows an entry written by someone else', async ({ page }) => {
        await openWithOneEntry(page);
        fs.writeFileSync(bookPath(BOOK), JSON.stringify(bookWith([KNOWN, ARRIVED])), 'utf-8');
        expect(await renderedComments(page)).toEqual([KNOWN]);

        await pressRefresh(page);
        await expect(page.locator('#world_popup_entries_list .world_entry')).toHaveCount(2);

        expect(await renderedComments(page)).toEqual([KNOWN, ARRIVED]);
    });

    test('…and the cache is left holding what is actually on disk', async ({ page }) => {
        await openWithOneEntry(page);
        fs.writeFileSync(bookPath(BOOK), JSON.stringify(bookWith([KNOWN, ARRIVED])), 'utf-8');

        await pressRefresh(page);
        await expect(page.locator('#world_popup_entries_list .world_entry')).toHaveCount(2);

        const cached = await page.evaluate(async name => {
            const { worldInfoCache } = await import('./scripts/world-info.js');
            return Object.values(worldInfoCache.get(name)?.entries ?? {}).map(e => e.comment);
        }, BOOK);
        expect(cached).toEqual([KNOWN, ARRIVED]);
    });

    test('a book created elsewhere appears in the dropdown after Refresh', async ({ page }) => {
        await openWithOneEntry(page);
        expect(await listedBooks(page)).not.toContain(UNSEEN_BOOK);

        fs.writeFileSync(bookPath(UNSEEN_BOOK), JSON.stringify(bookWith(['lore-from-elsewhere'])), 'utf-8');

        await pressRefresh(page);
        await expect.poll(() => listedBooks(page)).toContain(UNSEEN_BOOK);
    });

    test('Refresh keeps the book you were looking at selected', async ({ page }) => {
        await openWithOneEntry(page);
        fs.writeFileSync(bookPath(UNSEEN_BOOK), JSON.stringify(bookWith(['lore-from-elsewhere'])), 'utf-8');

        await pressRefresh(page);
        await expect(page.locator('#world_popup_entries_list .world_entry')).toHaveCount(1);

        const selected = await page.evaluate(() =>
            String($('#world_editor_select').find(':selected').data('worldName') ?? ''));
        expect(selected).toBe(BOOK);
    });

    test('Refresh with no book open does not throw', async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await testSetup.awaitAppReady({ page });

        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));

        await page.evaluate(() => $('#world_editor_select').val('').trigger('change'));
        await pressRefresh(page);
        // The handler is async; give it a real settling signal rather than a bare sleep — the world
        // list refetch it performs is observable, and an exception would have landed by then.
        await expect.poll(() => listedBooks(page)).not.toContain(BOOK + '-never-exists');

        expect(errors).toEqual([]);
    });

    /*
     * 🔴 AND THE CACHE MUST NOT SURVIVE SOMEONE ELSE'S WRITE.
     *
     * Fixing the button fixes the button. Everything else that reads a world book — the prompt
     * builder through `getSortedEntries`, any extension, the next editor open — goes through
     * `loadWorldInfo`, which answers from `worldInfoCache`. Nothing invalidated that cache for a
     * write this tab did not make, so after someone else saved a book this tab went on building
     * PROMPTS from lore that is not on disk, with no button involved and nothing to notice.
     *
     * The fork already streams `worldinfo.updated` to other tabs and refreshes the dropdown from it.
     * The cache is now dropped on the same event. Two real pages are used rather than a synthesised
     * event, because the whole question is whether a write from a DIFFERENT client reaches this one:
     * `payloadOf` discards a tab's own echo by client id, and a faked event would skip exactly the
     * mechanism under test.
     *
     * ⚠️ INVALIDATE, NOT RELOAD — `src/event-stream.js` is explicit that reloading the editor on this
     * event destroys unsaved work in the tab that is typing. So the assertion is that the cache is
     * gone and the next read is fresh, NOT that the open editor redrew itself.
     */
    test('🔴 a write from another tab drops the cached copy held here', async ({ page, context }) => {
        await openWithOneEntry(page);
        expect(
            await page.evaluate(async name => {
                const { worldInfoCache } = await import('./scripts/world-info.js');
                return worldInfoCache.has(name);
            }, BOOK),
            'this tab should be holding a cached copy, or the invalidation below proves nothing',
        ).toBe(true);

        // A second real client, with its own event-stream identity.
        const other = await context.newPage();
        await other.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await testSetup.awaitAppReady({ page: other });
        await other.evaluate(async ({ name, document }) => {
            const { saveWorldInfo } = await import('./scripts/world-info.js');
            await saveWorldInfo(name, document, true);
        }, { name: BOOK, document: bookWith([KNOWN, ARRIVED]) });

        await expect.poll(() => page.evaluate(async name => {
            const { worldInfoCache } = await import('./scripts/world-info.js');
            return worldInfoCache.has(name);
        }, BOOK), { timeout: 15_000 }).toBe(false);

        // And the next read goes to the server and sees what the other tab wrote.
        const fresh = await page.evaluate(async name => {
            const { loadWorldInfo } = await import('./scripts/world-info.js');
            const data = await loadWorldInfo(name);
            return Object.values(data?.entries ?? {}).map(e => e.comment);
        }, BOOK);
        expect(fresh).toEqual([KNOWN, ARRIVED]);

        await other.close();
    });

    test('a tab does not forget a book because of its OWN save', async ({ page }) => {
        // The echo guard: saving here seeds the cache on purpose, and dropping it on our own event
        // would throw away the copy we just wrote and re-fetch for nothing.
        await openWithOneEntry(page);

        await page.evaluate(async ({ name, document }) => {
            const { saveWorldInfo } = await import('./scripts/world-info.js');
            await saveWorldInfo(name, document, true);
        }, { name: BOOK, document: bookWith([KNOWN, ARRIVED]) });

        // ⚠️ A REAL WAIT, AND THERE IS NOTHING TO POLL FOR. This asserts that something does NOT
        // happen, so the only honest way to run it is to give the event a generous chance to arrive
        // and land — a poll would pass the instant it looked, before the echo could have been
        // processed at all.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(2000);
        const cached = await page.evaluate(async name => {
            const { worldInfoCache } = await import('./scripts/world-info.js');
            return Object.values(worldInfoCache.get(name)?.entries ?? {}).map(e => e.comment);
        }, BOOK);
        expect(cached).toEqual([KNOWN, ARRIVED]);
    });
});

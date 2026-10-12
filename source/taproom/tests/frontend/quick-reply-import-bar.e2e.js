/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 WHAT THIS GUARDS, and why it is a second file.
 *
 * `quick-reply-import-replace.e2e.js` proves the replace writes the right FILE. That was the reported
 * bug's root cause and it is fixed. This proves the replace leaves the user looking at the right BAR,
 * which is a different question with a different answer, and the one the bug report's Verification
 * section asks in items 4-7 -- none of which the file-level spec covers.
 *
 * The distinction matters because the two failures look identical from the user's chair. The report says
 * "the on-screen Quick Reply buttons continue to execute the old commands"; a set that has silently
 * fallen out of Global Quick Reply Sets renders no buttons at all, and a set whose links were rebuilt
 * carelessly renders two. Neither is visible in the set file, which by then is perfectly correct.
 *
 * ⚠️ This spec needs the set to be ON the bar, so it seeds `extension_settings.quickReplyV2.config`
 * with a link to it. The file-level spec deliberately does not -- it is measuring disk, and the bar
 * would only add boot cost. That seeding is the whole reason these cannot share a server.
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const SET_NAME = 'Nudges';
const OLD_LABEL = 'Nudge';
const NEW_LABEL = 'Nudge Harder';

/**
 * The button's command increments a chat variable, so "did it run, and how many times" is a number we
 * can read rather than a side effect we have to infer. A QR whose message is only a slash command
 * executes it and sends nothing to the chat.
 */
const COUNTER = '/addvar key=qrHits 1';

/** A v2 Quick Reply set carrying one button, as the export/import format has it. */
function qrSet(label, extra = {}, qrExtra = {}) {
    return {
        version: 2,
        name: SET_NAME,
        disableSend: false,
        placeBeforeInput: false,
        injectInput: false,
        color: 'transparent',
        onlyBorderColor: false,
        idIndex: 2,
        qrList: [{
            id: 1,
            icon: '',
            showLabel: false,
            label,
            title: '',
            message: COUNTER,
            contextList: [],
            preventAutoExecute: true,
            isHidden: false,
            executeOnStartup: false,
            executeOnUser: false,
            executeOnAi: false,
            executeOnChatChange: false,
            executeOnGroupMemberDraft: false,
            executeOnNewChat: false,
            executeBeforeGeneration: false,
            automationId: '',
            ...qrExtra,
        }],
        ...extra,
    };
}

test.describe('Quick Reply import keeps the button bar honest', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let setFile;
    /** @type {string} */
    let settingsFile;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('qr-import-bar-e2e');
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

        setFile = path.join(dataRoot, 'default-user', 'QuickReplies', `${SET_NAME}.json`);
        settingsFile = path.join(dataRoot, 'default-user', 'settings.json');
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    /**
     * The PERSISTED set, or null while it is momentarily not on disk.
     *
     * ⚠️ Replace deletes before it saves and `save()` is debounced, so there is a real window where this
     * file is absent or half-written. A polled read that throws fails hard instead of retrying and
     * reports a broken product from a working one — which is exactly how the sibling spec flaked with
     * ENOENT before its reader was made the only route to this file.
     * @returns {?object} The parsed set, or null if it is missing or not yet complete
     */
    function persistedSet() {
        try {
            return JSON.parse(fs.readFileSync(setFile, 'utf-8'));
        } catch {
            return null;
        }
    }

    /** The Global Quick Reply Sets list as it reached disk — the names, in order. */
    function persistedGlobalSets() {
        const json = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        return (json.extension_settings?.quickReplyV2?.config?.setList ?? []).map(it => it.set);
    }

    /**
     * Block until the app has rewritten `settings.json` since `since`.
     *
     * 🔴 WITHOUT THIS THE GLOBAL-SETS ASSERTION IS VACUOUS, and it silently was: `settings.save()` writes
     * through `saveSettingsDebounced`, so straight after an import the file still holds the value this
     * spec seeded. Polling "is the set still listed" passed on its first read against a build that had
     * just dropped the set, because the write had not landed yet.
     *
     * Reading the live object instead is not the fix -- `QuickReplySettings.toJSON()` returns `config:
     * this.config`, the live `QuickReplyConfig` instance, so `extension_settings.quickReplyV2.config` is
     * a class holding `QuickReplySet` objects and `HTMLElement`s, which does not survive `page.evaluate`.
     * Waiting for the write and reading the file is what is left, and it is what a reload would see.
     *
     * A replace always rewrites settings -- `doDeleteQrSet()` calls `settings.save()` unconditionally --
     * so a timeout here means the import did not run, not that nothing needed saving.
     */
    async function waitForSettingsWrite(since) {
        await expect.poll(() => fs.statSync(settingsFile).mtimeMs, { timeout: 15_000 }).toBeGreaterThan(since);
    }

    /** Put the set on disk, put it on the bar, and load a page that reads both. */
    async function seedAndOpen(page, set = qrSet(OLD_LABEL)) {
        fs.mkdirSync(path.dirname(setFile), { recursive: true });
        fs.writeFileSync(setFile, JSON.stringify(set, null, 4), 'utf-8');

        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        settings.extension_settings = settings.extension_settings ?? {};
        settings.extension_settings.quickReplyV2 = {
            isEnabled: true,
            isCombined: false,
            isPopout: false,
            showPopoutButton: false,
            config: { setList: [{ set: SET_NAME, isVisible: true }] },
            characterConfigs: {},
        };
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4), 'utf-8');

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#send_form')).toBeAttached({ timeout: 30_000 });
        await expect(page.locator('#qr--set-importFile')).toBeAttached({ timeout: 30_000 });
    }

    /** Hand the import file input an edited export, the way choosing a file does. */
    function chooseFile(page, contents) {
        return page.setInputFiles('#qr--set-importFile', {
            name: `${SET_NAME}.json`,
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(contents, null, 4), 'utf-8'),
        });
    }

    /**
     * Every Quick Reply button currently on the bar, by visible label.
     *
     * ⚠️ Reads `.qr--button-label`, not the button. A QR with a context list renders a `⋮` expander
     * inside the same element, so the button's own text content is `Nudge⋮`.
     */
    function barLabels(page) {
        return page.locator('#qr--bar .qr--button .qr--button-label').allTextContents();
    }

    /** How many times the buttons' command has run this chat. */
    function hits(page) {
        return page.evaluate(() => {
            // @ts-ignore -- the page's global, not Node's
            const value = SillyTavern.getContext().chatMetadata?.variables?.qrHits;
            return value === undefined ? 0 : Number(JSON.parse(value));
        });
    }

    /** Import `set` over the existing one and answer the overwrite prompt. */
    async function replaceWith(page, set) {
        await chooseFile(page, set);
        const dialog = page.locator('dialog.popup').filter({ hasText: 'already exists' });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await dialog.locator('.popup-button-ok').click();
        await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    }

    test('the set is on the bar to begin with', async ({ page }) => {
        await seedAndOpen(page);

        // If this fails nothing below is testing what it claims to: the rest of the file is about what
        // an import does to a bar that HAS the set on it.
        await expect.poll(() => barLabels(page), { timeout: 30_000 }).toEqual([OLD_LABEL]);
    });

    test('🔴 replacing keeps the set in Global Quick Reply Sets', async ({ page }) => {
        await seedAndOpen(page);
        await expect.poll(() => barLabels(page), { timeout: 30_000 }).toEqual([OLD_LABEL]);

        const before = fs.statSync(settingsFile).mtimeMs;
        await replaceWith(page, qrSet(NEW_LABEL));
        await waitForSettingsWrite(before);

        /*
         * `doDeleteQrSet()` splices the old set out of every config's `setList`, because those links hold
         * a direct object reference rather than a name and the object is about to be gone. The replace
         * path then splices the NEW set into `QuickReplySet.list` -- and nothing puts it back on the bar.
         * The user's set drops out of Global Quick Reply Sets, `settings.save()` persists that, and the
         * buttons are gone until they notice and re-add it by hand.
         *
         * This is the report's "the buttons continue to execute the old commands" seen from the other
         * side: the set file is now correct, and the bar is still wrong.
         */
        expect(persistedGlobalSets(), 'the set was dropped from Global Quick Reply Sets').toEqual([SET_NAME]);

        // Which is what a reload reads, so the bar comes back populated rather than empty.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(() => barLabels(page), { timeout: 30_000 }).toEqual([NEW_LABEL]);
    });

    test('🔴 the new label shows on the bar without a reload', async ({ page }) => {
        await seedAndOpen(page);
        await expect.poll(() => barLabels(page), { timeout: 30_000 }).toEqual([OLD_LABEL]);

        await replaceWith(page, qrSet(NEW_LABEL));

        // Verification item 4. Exactly one button, carrying the new label — not zero (the set fell off
        // the bar), not two (the old links were rebuilt without being torn down).
        await expect.poll(() => barLabels(page), { timeout: 15_000 }).toEqual([NEW_LABEL]);
    });

    test('🔴 the replaced button fires exactly once per click', async ({ page }) => {
        await seedAndOpen(page);
        await expect.poll(() => barLabels(page), { timeout: 30_000 }).toEqual([OLD_LABEL]);

        await replaceWith(page, qrSet(NEW_LABEL));
        await expect.poll(() => barLabels(page), { timeout: 15_000 }).toEqual([NEW_LABEL]);

        expect(await hits(page), 'the command ran before anyone clicked it').toBe(0);
        await page.locator('#qr--bar .qr--button').first().click();

        /*
         * Verification item 7, and the report's own warning about the fix: "a naive rebuild that re-binds
         * without unbinding will produce double-firing buttons, which is a worse bug than this one."
         *
         * ⚠️ Poll up to a settled value rather than reading once — the command is executed asynchronously,
         * so a single read right after the click can catch 0 and call a double-fire a pass.
         */
        await expect.poll(() => hits(page), { timeout: 15_000 }).toBe(1);
        await page.waitForTimeout(1_000);
        expect(await hits(page), 'the button fired more than once for one click').toBe(1);
    });

    test('hidden entries and auto-execute flags survive the round trip', async ({ page }) => {
        await seedAndOpen(page);
        await expect.poll(() => barLabels(page), { timeout: 30_000 }).toEqual([OLD_LABEL]);

        // Verification item 5. `isHidden` also has a visible consequence: the bar renders `qrList` minus
        // the hidden ones, so a flag lost in the round trip shows up as a button that should not be there.
        await replaceWith(page, qrSet(NEW_LABEL, {}, {
            isHidden: true,
            executeOnAi: true,
            executeOnStartup: true,
            automationId: 'nudge-auto',
        }));

        await expect.poll(() => {
            const qr = persistedSet()?.qrList[0];
            return qr ? [qr.isHidden, qr.executeOnAi, qr.executeOnStartup, qr.automationId] : null;
        }, { timeout: 15_000 }).toEqual([true, true, true, 'nudge-auto']);

        await expect.poll(() => barLabels(page), { timeout: 15_000 }).toEqual([]);
    });

    test('delete-and-recreate still works', async ({ page }) => {
        await seedAndOpen(page);
        await expect.poll(() => barLabels(page), { timeout: 30_000 }).toEqual([OLD_LABEL]);

        /*
         * Verification item 6. The report calls this "the only reliable route" and says users depend on
         * it, so it is the one path that must not regress no matter what the replace path does.
         *
         * ⚠️ Dispatched, not clicked. `#qr--set` and `#qr--set-delete` live in a collapsed inline drawer,
         * so Playwright's visibility wait never resolves and a real `selectOption()` burns the whole test
         * timeout — the same trap `quick-reply-set-color.e2e.js` hit. The handlers are what is under test;
         * the drawer's open state is not. The confirm popup it raises IS visible and is clicked for real.
         */
        await page.evaluate((name) => {
            const select = /** @type {HTMLSelectElement} */ (document.querySelector('#qr--set'));
            select.value = name;
            select.dispatchEvent(new Event('change'));
            document.querySelector('#qr--set-delete').dispatchEvent(new Event('click'));
        }, SET_NAME);
        const confirmDelete = page.locator('dialog.popup').filter({ hasText: 'Are you sure you want to delete' });
        await expect(confirmDelete).toBeVisible({ timeout: 15_000 });
        await confirmDelete.locator('.popup-button-ok').click();

        await expect.poll(() => fs.existsSync(setFile), { timeout: 15_000 }).toBe(false);

        // Re-importing the same name now has no existing set, so no prompt — it just lands. Polling the
        // label rather than existence-then-read closes the gap where the file is there but half-written.
        await chooseFile(page, qrSet(NEW_LABEL));
        await expect.poll(() => persistedSet()?.qrList[0].label ?? null, { timeout: 15_000 }).toBe(NEW_LABEL);
    });
});

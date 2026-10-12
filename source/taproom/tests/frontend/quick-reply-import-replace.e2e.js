/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 WHAT THIS GUARDS. Importing a Quick Reply set whose name already exists asks "overwrite?" and then
 * ignores the answer, because `Popup.show.confirm()` is async and both call sites forgot to await it. A
 * pending Promise is truthy, so `if (replace)` is taken every time -- Cancel deletes the user's set just
 * as thoroughly as OK does -- and the replace runs CONCURRENTLY with the dialog the user is still
 * reading.
 *
 * That concurrency is what produced the reported symptom rather than the obvious one. The old set is
 * deleted and unrendered while the modal is up; the popup's own teardown restores focus and fires the
 * settings drawer's change handlers against a `currentQrSet` that has been swapped underneath them, and
 * those handlers call `save()` -- a 200 ms debounce -- on whichever set they are holding. Whether the
 * file on disk ends up new or old therefore depends on how long the user took to click, which is
 * exactly the "it did not take, and a hard reload does not fix it" report.
 *
 * ⚠️ These are file-system assertions on purpose. The bug's signature is that the UI looks updated and
 * the persisted set is not -- checking the DOM would have agreed with the buggy build. Quick Reply sets
 * live in `<data>/<user>/QuickReplies/<name>.json` (`readAndParseFromDirectory` in
 * `endpoints/settings.js`), so that file is the thing a reload would read, and it is what is measured.
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const SET_NAME = 'Nudges';
const OLD_MESSAGE = '/inject id=nudge position=chat depth=1 [a nudge]';
const NEW_MESSAGE = '/inject id=nudge position=chat depth=1 [a nudge] | /trigger';

/** A v2 Quick Reply set carrying one button, as the export/import format has it. */
function qrSet(message, extra = {}) {
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
            label: 'Nudge',
            title: '',
            message,
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
        }],
        ...extra,
    };
}

test.describe('Quick Reply set import replaces, and only when told to', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let setFile;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('qr-import-replace-e2e');
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
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    /** Put the set on disk in its pre-import state and load a page that reads it. */
    async function seedAndOpen(page) {
        fs.mkdirSync(path.dirname(setFile), { recursive: true });
        fs.writeFileSync(setFile, JSON.stringify(qrSet(OLD_MESSAGE), null, 4), 'utf-8');

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#send_form')).toBeAttached({ timeout: 30_000 });
        await expect(page.locator('#qr--set-importFile')).toBeAttached({ timeout: 30_000 });

        // The extension reads the set at init. If it did not, nothing below is testing an overwrite.
        await expect.poll(async () => page.evaluate(async () => {
            const { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
            return QuickReplySet.list.map(it => it.name);
        }), { timeout: 30_000 }).toContain(SET_NAME);
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
     * The PERSISTED set, or null while it is momentarily not on disk.
     *
     * ⚠️ EVERY POLLED READ OF THIS FILE MUST GO THROUGH HERE. There IS a legitimate window where the set
     * is absent — replace deletes before it saves, and `save()` is debounced 200 ms — so a reader that
     * throws makes `expect.poll` fail hard instead of retrying, which reads as a product failure.
     *
     * 🔴 That is not hypothetical: the entry-count assertion below called `fs.readFileSync` directly and
     * flaked with ENOENT in a full-suite run, reporting a broken product from a green one. The guard was
     * written for this exact window and then bypassed one line later, so it is now the only reader.
     * `JSON.parse` is inside the try as well — a file caught half-written is the same "not yet" answer.
     * @returns {?object} The parsed set, or null if it is missing or not yet complete
     */
    function persistedSet() {
        try {
            return JSON.parse(fs.readFileSync(setFile, 'utf-8'));
        } catch {
            return null;
        }
    }

    /** The message the persisted set carries — what a reload would show. */
    function persistedMessage() {
        return persistedSet()?.qrList[0].message ?? null;
    }

    test('confirming the overwrite replaces the persisted set', async ({ page }) => {
        await seedAndOpen(page);
        await chooseFile(page, qrSet(NEW_MESSAGE));

        const dialog = page.locator('dialog.popup').filter({ hasText: 'already exists' });
        await expect(dialog).toBeVisible({ timeout: 15_000 });

        // 🔴 NOTHING MAY HAVE HAPPENED YET. Un-awaited, the delete landed here — with the dialog still on
        // screen and the user's set already off disk. Reading it at this instant is the whole point.
        expect(persistedMessage(), 'the set was destroyed before the user answered').toBe(OLD_MESSAGE);

        await dialog.locator('.popup-button-ok').click();

        // `save()` is debounced 200 ms, so poll rather than read once.
        await expect.poll(persistedMessage, { timeout: 15_000 }).toBe(NEW_MESSAGE);
    });

    test('🔴 cancelling the overwrite leaves the existing set alone', async ({ page }) => {
        await seedAndOpen(page);
        await chooseFile(page, qrSet(NEW_MESSAGE));

        const dialog = page.locator('dialog.popup').filter({ hasText: 'already exists' });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await dialog.locator('.popup-button-cancel').click();

        // The dialog says the existing set will be DELETED and cannot be undone. Cancel has to mean it.
        // Un-awaited, `if (replace)` sees a pending Promise, takes the branch, and the set is already
        // gone by the time this button is clicked.
        await page.waitForTimeout(2_000);
        expect(fs.existsSync(setFile), 'the set file was deleted despite cancelling').toBe(true);
        expect(persistedMessage()).toBe(OLD_MESSAGE);
    });

    test('the overwrite prompt names the set it is about to delete', async ({ page }) => {
        await seedAndOpen(page);
        await chooseFile(page, qrSet(NEW_MESSAGE));

        const dialog = page.locator('dialog.popup').filter({ hasText: 'already exists' });
        await expect(dialog).toBeVisible({ timeout: 15_000 });

        // The import site interpolated a bare `name`, which is not in scope there -- it resolved to
        // `window.name`, so the prompt read `A Quick Reply Set named "" already exists.` Nothing threw,
        // and the one dialog whose whole job is to identify what is about to be destroyed did not.
        await expect(dialog).toContainText(`"${SET_NAME}"`);

        await dialog.locator('.popup-button-cancel').click();
    });

    test('replacing with a shorter set drops the removed entries', async ({ page }) => {
        await seedAndOpen(page);

        // Distinguishes replace from merge: a merge-by-id implementation leaves the second entry behind.
        const two = qrSet(OLD_MESSAGE);
        two.qrList.push({ ...two.qrList[0], id: 2, label: 'Second' });
        fs.writeFileSync(setFile, JSON.stringify(two, null, 4), 'utf-8');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#qr--set-importFile')).toBeAttached({ timeout: 30_000 });

        await chooseFile(page, qrSet(NEW_MESSAGE));
        const dialog = page.locator('dialog.popup').filter({ hasText: 'already exists' });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await dialog.locator('.popup-button-ok').click();

        await expect.poll(() => persistedSet()?.qrList.length ?? null, { timeout: 15_000 }).toBe(1);
        expect(persistedMessage()).toBe(NEW_MESSAGE);
    });

    test('importing a name that does not exist still just creates it', async ({ page }) => {
        await seedAndOpen(page);

        const fresh = qrSet(NEW_MESSAGE);
        fresh.name = 'Nudges Two';
        await chooseFile(page, fresh);

        // No existing set of that name, so no prompt at all — this path must stay untouched.
        const freshFile = path.join(path.dirname(setFile), 'Nudges Two.json');
        await expect.poll(() => fs.existsSync(freshFile), { timeout: 15_000 }).toBe(true);
        expect(JSON.parse(fs.readFileSync(freshFile, 'utf-8')).qrList[0].message).toBe(NEW_MESSAGE);
        expect(persistedMessage(), 'the untouched set was disturbed').toBe(OLD_MESSAGE);
        fs.unlinkSync(freshFile);
    });
});

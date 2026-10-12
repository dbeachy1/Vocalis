/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/**
 * THE EXTENSIONS DIALOG OFFERS ONLY WHAT THE SERVER CAN DO, AND REPORTS WHAT THE SERVER ANSWERED
 * (Taproom, October 11, 2026, pre-release audit).
 *
 * The server half is `tests/extensions-management.test.js`. This is the page half: given what
 * `GET /api/extensions/capabilities` says, the dialog must not draw Update, Switch branch, Move or Delete buttons
 * that cannot work (a bundled extension gets a disabled, explained Delete), must say once why updating is
 * unavailable, must not offer "Install for all users" where the server refuses it, and must show a failed delete
 * instead of "deleted" followed by a reload.
 *
 * The capabilities, the extension list and the manifests are answered by the test (page.route), because the machine
 * running the suite has git and a writable extension folder, and the claim is about the page's reaction to the
 * server's report, not about this machine.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const PACKAGE_CAPABILITIES = {
    update: false,
    updateMessage: 'This package has no git, so an installed extension cannot be updated in place. Remove it and install it again to get a newer version.',
    globalInstall: false,
    globalInstallMessage: 'Installing an extension for all users is not available in this package.',
    bundled: ['Vocalis'],
    bundledMessage: 'This extension comes with Taproom, so it cannot be deleted, moved, or updated on its own.',
};

const ORDINARY_CAPABILITIES = {
    update: true,
    updateMessage: '',
    globalInstall: true,
    globalInstallMessage: '',
    bundled: [],
    bundledMessage: '',
};

test.describe('extensions dialog (front-end) follows the server\'s capabilities', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('extensions-capabilities-e2e');

        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;
        await stepPastFirstRun(path.join(scratch, 'data'));
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    /**
     * Answer the extension list, its manifests and the capabilities, then open the Extensions dialog.
     * @param {import('@playwright/test').Page} page The page
     * @param {object} capabilities What the server reports
     * @param {object} [extra] Extra routes
     * @param {(page: import('@playwright/test').Page) => Promise<void>} [extra.before] Runs before the page loads
     * @returns {Promise<void>}
     */
    async function openDialog(page, capabilities, extra = {}) {
        await page.route('**/api/extensions/capabilities', route => route.fulfill({ json: capabilities }));
        await page.route('**/api/extensions/discover', route => route.fulfill({
            json: [{ type: 'global', name: 'third-party/Vocalis' }, { type: 'local', name: 'third-party/Mine' }],
        }));
        for (const name of ['Vocalis', 'Mine']) {
            await page.route(`**/scripts/extensions/third-party/${name}/manifest.json`, route => route.fulfill({
                json: { display_name: name, version: '1.0.0', author: 'Test', loading_order: 100 },
            }));
        }
        await extra.before?.(page);

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.locator('#extensions-settings-button .drawer-toggle').click();
        await page.locator('#extensions_details').click();
        await expect(page.locator('.extensions_info .extension_block[data-name="/Mine"]')).toBeAttached({ timeout: 30_000 });
    }

    test('🔴 in this package: updating is disabled with the reason, and nothing offers what cannot work', async ({ page }) => {
        await openDialog(page, PACKAGE_CAPABILITIES);

        // One sentence, in the dialog, once.
        await expect(page.locator('.extensions_update_unavailable')).toHaveText(PACKAGE_CAPABILITIES.updateMessage);

        // Clearly disabled, with the reason as the tooltip.
        for (const label of ['Update all', 'Update enabled']) {
            const button = page.locator('.extensions_toolbar button', { hasText: label });
            await expect(button).toBeDisabled();
            await expect(button).toHaveAttribute('title', PACKAGE_CAPABILITIES.updateMessage);
        }

        // "Notify on extension updates" cannot notify, so it cannot be ticked, and says why.
        await expect(page.locator('#extensions_notify_updates')).toBeDisabled();

        // The personal extension: delete only (no update, no branches, and with the all-users folder read-only, no move).
        const mine = page.locator('.extension_block[data-name="/Mine"]');
        await expect(mine.locator('.btn_delete')).toHaveCount(1);
        await expect(mine.locator('.btn_update, .btn_branch, .btn_move')).toHaveCount(0);

        // The bundled extension: nothing but a disabled, explained Delete.
        const bundled = page.locator('.extension_block[data-name="/Vocalis"]');
        await expect(bundled.locator('.btn_update, .btn_branch, .btn_move, .btn_delete')).toHaveCount(0);
        const bundledDelete = bundled.locator('.btn_bundled');
        await expect(bundledDelete).toBeDisabled();
        await expect(bundledDelete).toHaveAttribute('title', PACKAGE_CAPABILITIES.bundledMessage);
    });

    test('in this package: "Install for all users" is not offered, "Install just for me" is', async ({ page }) => {
        await openDialog(page, PACKAGE_CAPABILITIES);
        await page.keyboard.press('Escape');

        await page.locator('#third_party_extension_button').click();
        const popup = page.locator('dialog.popup').last();
        await expect(popup.locator('.popup-button-ok')).toHaveText('Install just for me');
        await expect(popup.locator('.popup-controls')).not.toContainText('Install for all users');
    });

    test('on an ordinary server every control is still offered', async ({ page }) => {
        await openDialog(page, ORDINARY_CAPABILITIES);

        await expect(page.locator('.extensions_update_unavailable')).toHaveCount(0);
        for (const label of ['Update all', 'Update enabled']) {
            await expect(page.locator('.extensions_toolbar button', { hasText: label })).toBeEnabled();
        }
        await expect(page.locator('#extensions_notify_updates')).toBeEnabled();

        const mine = page.locator('.extension_block[data-name="/Mine"]');
        await expect(mine.locator('.btn_update, .btn_branch, .btn_move, .btn_delete')).toHaveCount(4);
    });

    test('🔴 a delete the server refuses is reported as refused: no "deleted" toast, no reload', async ({ page }) => {
        const refusal = 'The extension folder is not writable.';
        await openDialog(page, ORDINARY_CAPABILITIES, {
            before: async (p) => {
                await p.route('**/api/extensions/delete', route => route.fulfill({ status: 409, contentType: 'text/plain', body: refusal }));
            },
        });
        await page.evaluate(() => { globalThis.__beforeDelete = true; });

        await page.locator('.extension_block[data-name="/Mine"] .btn_delete').click();
        await page.locator('dialog.popup .popup-button-ok').last().click();

        await expect(page.locator('.toast-error', { hasText: refusal })).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.toast-success', { hasText: 'deleted' })).toHaveCount(0);

        // A reload would have been scheduled one second after a "success"; give it longer than that.
        await page.waitForTimeout(2500);
        expect(await page.evaluate(() => globalThis.__beforeDelete === true)).toBe(true);
    });
});

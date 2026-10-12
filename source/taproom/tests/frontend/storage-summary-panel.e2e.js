/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `document`. Lint sees one file and cannot tell the two contexts apart.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(path.dirname(here));
const MIXED_PROVIDER = path.join(serverDirectory, 'tests', 'fixtures', 'mixed-provider.js');

const PASSWORD = 'the-password';
const RECOVERY_KEY = 'TEST_ONLY_RECOVERY_KEY_FIXTURE_0000000000000001';

/** A character created THROUGH the provider, so its card bytes carry an envelope naming it. */
const SECRET_CHARACTER = 'SecretPerson';

/**
 * 🪪 §7 SURFACE 5, IN A REAL BROWSER — `DESIGN_STORAGE_PROVENANCE.md`.
 *
 * The endpoint suite proves the server returns the grouped counts; the pure-logic suite proves the sentence
 * reads correctly. Neither can prove the panel is REACHABLE and DRAWS — that the button is wired, the popup
 * opens, and the sentence lands on the DOM without being turned into a link. That is the exact gap the
 * mixed-mode and data-type browser suites exist for on the other surfaces: a selector or data-flow mistake is
 * invisible to Node.
 *
 * Two phases, the same shape as the data-type suite: with the provider installed the panel must be REASSURING
 * (live data is not reported as lost), and with it gone the panel must NAME what needs which plugin.
 */
// ⚠️ 180s, NOT PLAYWRIGHT'S 30s DEFAULT, BECAUSE `beforeAll` BOOTS A REAL SERVER. A boot starved of
//    CPU by the parallel batch is a machine-load measurement, not a failing assertion, and reporting
//    it as one hides the real ones.
//
// 🔴 AND THE LINE BELOW IS ONLY HALF OF IT — `test.setTimeout()` INSIDE THE HOOK IS THE OTHER HALF.
//    `describe.configure({ timeout })` sets the budget for the TESTS and does nothing for a hook:
//    measured with a pair of throwaway specs whose `beforeAll` sleeps 40s, the one carrying only the
//    line below died with `"beforeAll" hook timeout of 30000ms exceeded` and the one calling
//    `test.setTimeout()` in the hook passed. This spec was "fixed" with the line below alone, passed
//    the next run on lighter contention, and failed again exactly as before.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('storage provenance — the surface-5 "what did my uninstall take?" panel', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>|null} */
    let server = null;
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let configPath;
    /** @type {string} */
    let providersPath;
    /** @type {string} */
    let base;

    /**
     * Boot (or reboot) against the SAME data root, with the provider or without. Without it models uninstall.
     * @param {{provider: boolean}} options Whether to load the storage provider
     * @returns {Promise<void>} When it is listening
     */
    async function boot({ provider }) {
        if (server) {
            await server.stop();
            server = null;
        }

        server = await startSillyTavern({
            dataRoot,
            configPath,
            enableUserAccounts: true,
            ...(provider
                ? {
                    storageProvidersPath: providersPath,
                    providerEnv: {
                        ST_KEYED_STATE: path.join(scratch, 'vault-keys.json'),
                        ST_KEYED_HANDLE: 'default-user',
                        ST_KEYED_PASSWORD: PASSWORD,
                        ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
                    },
                }
                : {}),
        });

        if (!server.listening) {
            throw new Error(`Boot ${provider ? 'with' : 'without'} provider failed.\n\n${server.output()}`);
        }

        base = `http://127.0.0.1:${server.port}`;
    }

    /**
     * Log in through the UI, dismiss the one-time recovery-key modal if it appears, and wait for the loader.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<void>} When the app is ready to drive
     */
    async function login(page) {
        await page.goto(base, { waitUntil: 'domcontentloaded' });

        await page.locator('.userSelect').first().waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('.userSelect').filter({ hasText: 'default-user' }).first().click();
        await page.locator('#userPassword').waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('#userPassword').fill(PASSWORD);
        await page.locator('#userPassword').press('Enter');

        // A newly-unlocked vault shows its recovery key once, in a modal that covers the page — dismiss it
        // before touching anything, exactly as the other suites do.
        const ack = page.locator('dialog.popup').filter({ hasText: 'recovery key' }).first();
        await page.waitForTimeout(4000);
        if (await ack.count()) {
            const box = ack.locator('input[type="checkbox"]').first();
            if (await box.count()) await box.check().catch(() => {});
            await ack.locator('.popup-button-ok, button:has-text("Done")').first().click().catch(() => {});
        }

        await page.locator('#loader').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
    }

    /**
     * Open the storage panel from the User Settings drawer and return the popup's text.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<{text: string, html: string}>} The popup's text and its HTML (to check for links)
     */
    async function openPanel(page) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.locator('#storage_summary_button').waitFor({ state: 'visible', timeout: 15_000 });
        await page.locator('#storage_summary_button').click();

        // Both the reassuring and the naming messages contain "storage provider", so it is a reliable filter
        // for "the panel opened" without assuming which message it shows.
        const dialog = page.locator('dialog.popup').filter({ hasText: 'storage provider' }).last();
        await dialog.waitFor({ state: 'visible', timeout: 15_000 });

        return {
            text: (await dialog.locator('.popup-content').first().innerText()).trim(),
            html: await dialog.locator('.popup-content').first().innerHTML(),
        };
    }

    /**
     * Close whatever popup is open, so the next test starts clean.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<void>} When it is closed
     */
    async function closePanel(page) {
        await page.locator('dialog.popup[open] .popup-button-ok').last().click().catch(() => {});
    }

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        scratch = makeScratchDirectory('storage-summary-panel-e2e');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');

        // Seed with NO provider: creates the data tree and the default (plaintext, readable) character.
        await boot({ provider: false });
        await server.stop();
        server = null;

        const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), expiredInterval: 0 /* no stray timer — see setPassword in integration/harness.mjs */ });
        await store.init();
        const user = await store.getItem('user:default-user');
        const salt = crypto.randomBytes(16).toString('base64');
        user.password = crypto.scryptSync(PASSWORD.normalize(), salt, 64).toString('base64');
        user.salt = salt;
        await store.setItem('user:default-user', user);

        // Step past onboarding, or headless init blocks behind the "Initializing…" modal for ever.
        await stepPastFirstRun(dataRoot);

        installStorageProvider(providersPath, MIXED_PROVIDER);
        await boot({ provider: true });

        // Create a character THROUGH the provider, so its card is enveloped on disk and unreadable once gone.
        const loginResponse = await fetch(`${base}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
        });
        expect(loginResponse.status).toBe(200);
        const cookie = loginResponse.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

        const create = await fetch(`${base}/api/characters/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ ch_name: SECRET_CHARACTER, description: '', first_mes: '', file_name: SECRET_CHARACTER }),
        });
        expect(create.status).toBe(200);

        const enc = fs.readdirSync(path.join(dataRoot, 'default-user', 'characters')).filter((n) => n.startsWith('enc~') && n.endsWith('.png'));
        expect(enc).toHaveLength(1);
    });

    test.afterAll(async () => {
        if (server) await server.stop();
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    });

    test('🔴 provider installed: the panel is reassuring — live data is not reported as lost', async ({ page }) => {
        await login(page);
        const { text } = await openPanel(page);

        // The character above is enveloped on disk but reads fine through the installed provider. A panel that
        // listed it would tell a user with a working vault that their data is gone — the exact miscount the
        // logical-name walk prevents, asserted here through the whole client stack.
        expect(text).toContain('Nothing you have needs a storage provider that is not installed.');
        expect(text).not.toContain('SecretPerson');

        await closePanel(page);
    });

    test('🔴 uninstalled: the panel names the provider, counts the data, and never links it', async ({ page }) => {
        await boot({ provider: false });

        // Round out the account with one planted chat, so the sentence exercises the count join too.
        const chatDir = path.join(dataRoot, 'default-user', 'chats', 'SomeCharacter');
        fs.mkdirSync(chatDir, { recursive: true });
        fs.writeFileSync(path.join(chatDir, 'a-chat.jsonl'), `stenv:1:mixed-provider:${Buffer.from('x').toString('base64')}`);

        await login(page);
        const { text, html } = await openPanel(page);

        // 🪪 The provenance sentence, in a real browser. The plugin is gone from disk and process; the name,
        // the source and the counts all come from the record the fork wrote while it ran.
        expect(text).toContain('FIXTURE Mixed-Mode Provider');
        expect(text).toContain('\'mixed-provider\'');
        expect(text).toContain('1 character');
        expect(text).toContain('1 chat');

        // 🔴 source is shown but never followed (§3.1): the URL is in the text, and there is no anchor.
        expect(text).toContain('example.invalid/fixtures/mixed-provider');
        expect(html).not.toContain('<a ');
        expect(html).not.toContain('href');

        await closePanel(page);
    });
});

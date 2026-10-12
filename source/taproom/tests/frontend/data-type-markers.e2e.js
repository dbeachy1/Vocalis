/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `document` and `getComputedStyle`. Lint sees one file and cannot tell the two contexts apart.

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

/** A group created THROUGH the provider, so its definition bytes carry an envelope naming it. */
const SECRET_GROUP = 'SecretGroup';

/** A world created THROUGH the provider, so its bytes carry an envelope naming it. */
const SECRET_WORLD = 'a-secret-world';

/**
 * 🪪 §7 SURFACE 4, IN A REAL BROWSER — `DESIGN_STORAGE_PROVENANCE.md`.
 *
 * The endpoint suite proves the server now returns a character card with `storage.unavailable` instead of
 * dropping it. It cannot prove the card is DRAWN, and that is the exact gap the mixed-mode-markers suite was
 * written to close for chats: the chat list passed every server test while showing no marker at all, because
 * the client was asking a subtly wrong question and the server was answering it perfectly.
 *
 * The character card carries the same risk on a different pipeline: the `storage` field has to survive
 * `getCharacters` → the entity list → `getCharacterBlock`, and the dimming class and the provenance title
 * have to land on the real DOM node. A selector or a data-flow mistake here is invisible to Node, so it is
 * asserted in the browser or it is not asserted at all.
 *
 * ⚠️ It boots its own server, installs a storage provider and then removes it — the same shape and the same
 * reasons as mixed-mode-markers.e2e.js, including stepping past onboarding and the recovery-key modal.
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

test.describe('storage provenance — non-chat data types (front-end)', () => {
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
     * Boot (or reboot) against the SAME data root, with the provider or without it. Booting without it is
     * how "uninstall" is modelled.
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
     * Log in through the UI and land on the character list.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<void>} When the character list is visible
     */
    async function openCharacterList(page) {
        await page.goto(base, { waitUntil: 'domcontentloaded' });

        await page.locator('.userSelect').first().waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('.userSelect').filter({ hasText: 'default-user' }).first().click();
        await page.locator('#userPassword').waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('#userPassword').fill(PASSWORD);
        await page.locator('#userPassword').press('Enter');

        // A new vault shows its recovery key once, in a modal that covers the page — dismiss it before
        // touching anything, same as the chat-marker suite.
        const ack = page.locator('dialog.popup').filter({ hasText: 'recovery key' }).first();
        await page.waitForTimeout(4000);
        if (await ack.count()) {
            const box = ack.locator('input[type="checkbox"]').first();
            if (await box.count()) await box.check().catch(() => {});
            await ack.locator('.popup-button-ok, button:has-text("Done")').first().click().catch(() => {});
        }

        await page.locator('#loader').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});

        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_print_characters_block .character_select').first().waitFor({ state: 'visible', timeout: 25_000 });
        await page.waitForTimeout(2000);
    }

    /**
     * Read every character card's state out of the DOM.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<Array<{name: string, unavailable: boolean, title: string|null, description: string|null}>>} The cards
     */
    function readCards(page) {
        return page.evaluate(() => Array.from(document.querySelectorAll('#rm_print_characters_block .character_select')).map((block) => ({
            name: block.querySelector('.ch_name')?.textContent?.trim() ?? null,
            unavailable: block.classList.contains('character_select_unavailable'),
            title: block.querySelector('.ch_name')?.getAttribute('title') ?? null,
            description: block.querySelector('.ch_description')?.textContent?.trim() ?? null,
        })));
    }

    /**
     * Read every group block's state out of the entity list — groups render as `.group_select` in the same
     * list as characters.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<Array<{name: string, unavailable: boolean, title: string|null, description: string|null}>>} The blocks
     */
    function readGroups(page) {
        return page.evaluate(() => Array.from(document.querySelectorAll('#rm_print_characters_block .group_select')).map((block) => ({
            name: block.querySelector('.ch_name')?.textContent?.trim() ?? null,
            unavailable: block.classList.contains('character_select_unavailable'),
            title: block.querySelector('.ch_name')?.getAttribute('title') ?? null,
            description: block.querySelector('.group_select_block_list')?.textContent?.trim() ?? null,
        })));
    }

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        scratch = makeScratchDirectory('data-type-markers-e2e');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');

        // Seed boot with NO provider: this creates the data tree and ships the default character, which keeps
        // the library non-empty either way.
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

        // Create a character THROUGH the provider, so its card is enveloped on disk and unreadable once the
        // plugin is gone.
        const login = await fetch(`${base}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

        const create = await fetch(`${base}/api/characters/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ ch_name: SECRET_CHARACTER, description: '', first_mes: '', file_name: SECRET_CHARACTER }),
        });
        expect(create.status).toBe(200);

        // A GROUP DEFINITION through the provider too — the fifth data type (§12.3). Its groups/<id>.json is
        // enveloped, so it disappears from the list once the plugin is gone unless the fork keeps it.
        const group = await fetch(`${base}/api/groups/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ name: SECRET_GROUP, members: [] }),
        });
        expect(group.status).toBe(200);

        // A WORLD INFO file through the provider, for the world-editor dropdown case (§12.3).
        const world = await fetch(`${base}/api/worldinfo/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ name: SECRET_WORLD, data: { entries: { 0: { uid: 0, key: ['k'], content: 'secret' } } } }),
        });
        expect(world.status).toBe(200);

        // All three have to be enveloped on disk under mangled names, or the uninstall proves nothing.
        for (const [dir, ext] of [['characters', '.png'], ['groups', '.json'], ['worlds', '.json']]) {
            const enc = fs.readdirSync(path.join(dataRoot, 'default-user', dir)).filter((n) => n.startsWith('enc~') && n.endsWith(ext));
            expect(enc).toHaveLength(1);
        }
    });

    test.afterAll(async () => {
        if (server) await server.stop();
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    });

    test('provider installed: the character reads normally and is NOT marked unavailable', async ({ page }) => {
        await openCharacterList(page);
        const cards = await readCards(page);

        // ⚠️ EXISTS FIRST — an empty list would pass every "nothing is falsely marked" assertion.
        expect(cards.length).toBeGreaterThanOrEqual(1);
        expect(cards.some((c) => c.name === SECRET_CHARACTER)).toBe(true);

        // Nothing readable wears the dimming class or the provenance title.
        for (const card of cards) {
            expect(card.unavailable).toBe(false);
        }
    });

    test('🔴 uninstalled: the card is STILL in the library, dimmed and naming the provider (§11, surface 4)', async ({ page }) => {
        await boot({ provider: false });
        await openCharacterList(page);
        const cards = await readCards(page);

        // 🔴 THE REGRESSION SURFACE 4 EXISTS FOR. Before the server change the nameless stub was filtered out
        // of /all and the card simply vanished — a library that renders short reads as deleted data. It has
        // to be present.
        const dead = cards.find((c) => c.unavailable);
        expect(dead).toBeDefined();

        // 🪪 The provenance sentence, in a real browser. The plugin is gone from disk and process; everything
        // after the id comes from the record the fork wrote while it ran, and nothing here is mocked.
        expect(dead.title).toContain('FIXTURE Mixed-Mode Provider');

        // 🔴 §7: the id keeps its place beside the name, so a user can check the plugin they found matches the
        // one the file names.
        expect(dead.title).toContain('\'mixed-provider\'');

        // 🔴 Rendered as TEXT — source is accurate but never a link (§3.1). The URL is in the sentence and
        // there is no anchor near it.
        expect(dead.title).toContain('example.invalid/fixtures/mixed-provider');
        expect(dead.title).not.toContain('<a');

        // The card body carries the reason too, so the explanation is visible without hovering.
        expect(dead.description).toBe(dead.title);

        // And the default character that predates the provider is untouched — readable, unmarked, in the same
        // list at the same time.
        expect(cards.some((c) => !c.unavailable)).toBe(true);
    });

    test('🔴 uninstalled: the GROUP is STILL in the list, dimmed and naming the provider (§12.3)', async ({ page }) => {
        // The fifth data type, in a real browser. The server keeps the enveloped group instead of dropping it;
        // this proves the client draws the returned stub as unreadable rather than as a normal empty group —
        // the same selector-mistake risk the character card carries, on a different render path.
        await openCharacterList(page);
        const groups = await readGroups(page);

        const dead = groups.find((g) => g.unavailable);
        expect(dead).toBeDefined();

        // 🪪 The provenance sentence, from the record the fork wrote while the plugin ran — id kept beside the
        // name, and the block body carries the reason so it is legible without hovering.
        expect(dead.title).toContain('FIXTURE Mixed-Mode Provider');
        expect(dead.title).toContain('\'mixed-provider\'');
        expect(dead.description).toContain('FIXTURE Mixed-Mode Provider');
    });

    test('🔴 uninstalled: the WORLD EDITOR dropdown marks the unreadable option, disabled and named (§12.3)', async ({ page }) => {
        // The dropdown is built from a flat name list that carries no provenance, so before this the unreadable
        // world sat in the list under its scrambled name looking ordinary. The marker fetches the one endpoint
        // that DOES carry it and disables + titles the option. It fires on settings load, so the option is
        // marked without opening the WI panel — wait for it rather than assuming instantaneous.
        await openCharacterList(page);

        await page.waitForFunction(() => {
            const select = document.querySelector('#world_editor_select');
            return select && Array.from(select.options).some((o) => o.disabled && o.classList.contains('world_option_unavailable'));
        }, null, { timeout: 20_000 });

        const marked = await page.evaluate(() => {
            const select = document.querySelector('#world_editor_select');
            const option = Array.from(select.options).find((o) => o.classList.contains('world_option_unavailable'));
            return option ? { disabled: option.disabled, title: option.getAttribute('title'), text: option.textContent } : null;
        });

        expect(marked).not.toBeNull();
        expect(marked.disabled).toBe(true);
        expect(marked.title).toContain('FIXTURE Mixed-Mode Provider');
        expect(marked.title).toContain('\'mixed-provider\'');
        expect(marked.text).toContain('⚠');
    });
});

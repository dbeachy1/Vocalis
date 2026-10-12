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

/** The group planted before the provider exists, so its definition stays plaintext and it stays visible. */
const GROUP_ID = '1700000000000';

/** Its chat that predates the plugin, and its chat created after — the mixed pair, in the group directory. */
const LEGACY_GROUP_CHAT = 'legacy-group-chat';
const SECRET_GROUP_CHAT = 'secret-group-chat';

/**
 * 🔒 THE MARKERS, IN A REAL BROWSER — `DESIGN_MIXED_MODE.md` §7, §9.1, §11.
 *
 * Everything else in this repository proves the marker's DATA (the endpoint's answers, end to end against a
 * live server) or its DECISION (`resolveChatMarker`, as a pure function). Neither can see whether a user
 * ends up looking at a PADLOCK, and that gap was not theoretical:
 *
 * 🔴 **The chat list never showed a marker at all — not the padlock, not the §11 dead row — and every
 * server test passed.** The rows carry `file_name` WITHOUT the `.jsonl` extension, because the list is built
 * from the chat *search* response, while `/api/storage/chat-status` joins the name onto `chats/<dir>/` and
 * asks the disk about it. So every chat resolved to a path that does not exist, came back "not encrypted",
 * and §7.2 correctly drew nothing. The endpoint was being asked the wrong question and answering it
 * perfectly. The message-bar padlock worked the whole time, because ITS call site appends the extension —
 * which is exactly why "one of the two placements works" was never noticed without a browser.
 *
 * ## What this suite covers, in the two states that matter
 *
 * | State | Asserted |
 * |---|---|
 * | Provider installed | Padlock on the encrypted chats, captioned with the PROVIDER's words; NOTHING on the plaintext chat (§7.2); padlock in the message bar (§7.1) |
 * | Provider uninstalled | Every encrypted chat is a dead row naming the provider (§11); the plaintext chat is untouched and unmarked; backups list their dead rows and a restore attempt is REFUSED by name (§9.1) |
 *
 * ⚠️ **It boots its own server** rather than using the shared :8000 baseURL, because it needs a storage
 * provider installed and then removed. It also steps past onboarding and the recovery-key modal — see the
 * comments in `seed`, both of which silently blocked every click before they were handled.
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

test.describe('mixed-mode storage markers (front-end)', () => {
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
    /** @type {string} */
    let avatar;
    /** @type {string} */
    let charDir;

    const chatBody = (marker) => [
        { user_name: 'User', character_name: charDir, create_date: '2026-07-20', chat_metadata: {} },
        { name: charDir, is_user: false, mes: `hello from ${marker}`, send_date: '2026-07-20' },
    ];

    /**
     * Boot (or reboot) against the SAME data root, with the provider or without it. Booting without it is
     * how "uninstall" is modelled — the plugin is simply not loaded, which is what uninstalling does.
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
     * Log in through the UI, open the character, and open the "Manage chat files" panel.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<void>} When the chat manager is open
     */
    async function openChatManager(page) {
        await page.goto(base, { waitUntil: 'domcontentloaded' });

        await page.locator('.userSelect').first().waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('.userSelect').filter({ hasText: 'default-user' }).first().click();
        await page.locator('#userPassword').waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('#userPassword').fill(PASSWORD);
        await page.locator('#userPassword').press('Enter');

        // 🔴 A NEW VAULT SHOWS ITS RECOVERY KEY ONCE, IN A MODAL THAT COVERS THE PAGE. Correct product
        // behaviour — the key is the only way back in — and it is why every click below timed out until this
        // existed. Dismiss it before touching anything.
        const ack = page.locator('dialog.popup').filter({ hasText: 'recovery key' }).first();
        await page.waitForTimeout(4000);
        if (await ack.count()) {
            const box = ack.locator('input[type="checkbox"]').first();
            if (await box.count()) await box.check().catch(() => {});
            await ack.locator('.popup-button-ok, button:has-text("Done")').first().click().catch(() => {});
        }

        await page.locator('#loader').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});

        // The chat manager is only reachable with a character open.
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_print_characters_block .character_select').first().waitFor({ state: 'visible', timeout: 25_000 });
        await page.locator('#rm_print_characters_block .character_select').first().click();
        await page.waitForTimeout(3000);

        await page.locator('#options_button').click();
        await page.locator('#option_select_chat').click();
        await page.locator('#select_chat_div').waitFor({ state: 'visible', timeout: 25_000 });
        await page.waitForTimeout(2000);
    }

    /**
     * The same thing for a GROUP: log in, open the group, open its "Manage chat files" panel.
     *
     * Worth a second function rather than a flag, because the two differ in the step that matters — a group
     * is selected from `.group_select` in the same list as characters, and the chat manager it opens is fed
     * by a different branch of `displayChats` reading a different directory.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<void>} When the chat manager is open on the group
     */
    async function openGroupChatManager(page) {
        await page.goto(base, { waitUntil: 'domcontentloaded' });

        await page.locator('.userSelect').first().waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('.userSelect').filter({ hasText: 'default-user' }).first().click();
        await page.locator('#userPassword').waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('#userPassword').fill(PASSWORD);
        await page.locator('#userPassword').press('Enter');

        const ack = page.locator('dialog.popup').filter({ hasText: 'recovery key' }).first();
        await page.waitForTimeout(4000);
        if (await ack.count()) {
            const box = ack.locator('input[type="checkbox"]').first();
            if (await box.count()) await box.check().catch(() => {});
            await ack.locator('.popup-button-ok, button:has-text("Done")').first().click().catch(() => {});
        }

        await page.locator('#loader').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});

        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_print_characters_block .group_select').first().waitFor({ state: 'visible', timeout: 25_000 });
        await page.locator('#rm_print_characters_block .group_select').first().click();
        await page.waitForTimeout(3000);

        await page.locator('#options_button').click();
        await page.locator('#option_select_chat').click();
        await page.locator('#select_chat_div').waitFor({ state: 'visible', timeout: 25_000 });
        await page.waitForTimeout(2000);
    }

    /**
     * Read every chat row's marker state straight out of the DOM.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<Array<{name: string, markerVisible: boolean, markerTitle: string|null, deadRow: boolean, preview: string|null}>>} The rows
     */
    function readRows(page) {
        return page.evaluate(() => Array.from(document.querySelectorAll('#select_chat_div .select_chat_block')).map((block) => {
            const icon = block.querySelector('.select_chat_block_encrypted_marker');
            const style = icon ? getComputedStyle(icon) : null;

            return {
                name: block.getAttribute('file_name'),
                markerVisible: !!icon && style.display !== 'none' && style.visibility !== 'hidden',
                markerTitle: icon ? icon.getAttribute('title') : null,
                deadRow: block.classList.contains('select_chat_block_unavailable'),
                preview: block.querySelector('.select_chat_block_mes')?.textContent?.trim() ?? null,
            };
        }));
    }

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        scratch = makeScratchDirectory('mixed-markers-e2e');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');

        // Seed boot with NO provider: this is what creates the data tree, and it ships a character, which is
        // what makes the chat manager reachable at all.
        await boot({ provider: false });
        avatar = fs.readdirSync(path.join(dataRoot, 'default-user', 'characters')).find((n) => n.endsWith('.png'));
        charDir = path.parse(avatar).name;
        await server.stop();
        server = null;

        // Give the account a password, so login has a secret to unlock the provider with.
        const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), expiredInterval: 0 /* no stray timer — see setPassword in integration/harness.mjs */ });
        await store.init();
        const user = await store.getItem('user:default-user');
        const salt = crypto.randomBytes(16).toString('base64');
        user.password = crypto.scryptSync(PASSWORD.normalize(), salt, 64).toString('base64');
        user.salt = salt;
        await store.setItem('user:default-user', user);

        // 🔴 STEP PAST ONBOARDING, OR NOTHING BELOW RUNS. A fresh data root is a FIRST RUN and `getSettings()`
        // ends at `doOnboarding()`, which waits for a human — headless never answers, so init blocks behind an
        // "Initializing…" modal covering the whole page. Same trick and same reason as plugin-panels.e2e.js.
        await stepPastFirstRun(dataRoot);

        // 🔴 The plaintext chat is planted with raw `fs` BEFORE the provider exists. That is what makes it a
        // legacy chat; one created through the provider could never stand in for "predates the plugin".
        const chatsDir = path.join(dataRoot, 'default-user', 'chats', charDir);
        fs.mkdirSync(chatsDir, { recursive: true });
        fs.writeFileSync(path.join(chatsDir, 'plaintext-chat.jsonl'), chatBody('the plaintext chat').map((m) => JSON.stringify(m)).join('\n'));

        // The GROUP half, planted the same way and for the same reason. Its definition is plaintext because
        // it predates the plugin — which is what keeps the group itself visible, and therefore what makes
        // its chat list reachable at all. A group created through the provider has an encrypted definition
        // and disappears from `/api/groups/all` entirely once the plugin is gone; that is the non-chat data
        // type gap, not this suite's subject.
        const groupChatsDir = path.join(dataRoot, 'default-user', 'group chats');
        fs.mkdirSync(groupChatsDir, { recursive: true });
        fs.writeFileSync(
            path.join(groupChatsDir, `${LEGACY_GROUP_CHAT}.jsonl`),
            chatBody('the legacy group chat').map((m) => JSON.stringify(m)).join('\n'),
        );

        const groupsDir = path.join(dataRoot, 'default-user', 'groups');
        fs.mkdirSync(groupsDir, { recursive: true });
        fs.writeFileSync(path.join(groupsDir, `${GROUP_ID}.json`), JSON.stringify({
            id: GROUP_ID,
            name: 'The Group',
            members: [avatar],
            avatar_url: '',
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 0,
            disabled_members: [],
            chat_id: LEGACY_GROUP_CHAT,
            chats: [LEGACY_GROUP_CHAT, SECRET_GROUP_CHAT],
            auto_mode_delay: 5,
        }, null, 4));

        installStorageProvider(providersPath, MIXED_PROVIDER);
        await boot({ provider: true });

        // Seed one encrypted chat through the API, and save twice so a backup exists to refuse later.
        const login = await fetch(`${base}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

        const save = (name, body) => fetch(`${base}/api/chats/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ avatar_url: avatar, file_name: name, chat: body, force: true }),
        });

        await save('encrypted-chat', chatBody('the encrypted chat'));
        await save('encrypted-chat', [...chatBody('the encrypted chat'), { name: 'User', is_user: true, mes: 'again', send_date: '2026-07-20' }]);
        await save('plaintext-chat', [...chatBody('the plaintext chat'), { name: 'User', is_user: true, mes: 'again', send_date: '2026-07-20' }]);

        // And the group's encrypted chat, written now that the provider is installed — the group's other
        // chat was planted before it, so the group directory goes mixed exactly as the character one does.
        const groupSave = await fetch(`${base}/api/chats/group/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ id: SECRET_GROUP_CHAT, chat: chatBody('the secret group chat'), force: true }),
        });
        expect(groupSave.status).toBe(200);
    });

    test.afterAll(async () => {
        if (server) await server.stop();
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    });

    test('🔴 provider installed: encrypted chats get the padlock, the plaintext one gets NOTHING', async ({ page }) => {
        await openChatManager(page);
        const rows = await readRows(page);

        // ⚠️ EXISTS FIRST — a list that failed to render would pass every "no false padlock" assertion.
        expect(rows.length).toBeGreaterThanOrEqual(2);

        const encrypted = rows.find((r) => r.name === 'encrypted-chat');
        const plaintext = rows.find((r) => r.name === 'plaintext-chat');
        expect(encrypted).toBeDefined();
        expect(plaintext).toBeDefined();

        // 🔴 The regression this file exists for: before the fix, this was false for every row.
        expect(encrypted.markerVisible).toBe(true);

        // 🔴 The words are the PROVIDER'S, verbatim from describe('storage.chatMarker') — not fork text.
        expect(encrypted.markerTitle).toBe('FIXTURE: this chat is encrypted at rest.');
        expect(encrypted.deadRow).toBe(false);

        // 🔴 §7.2: presence is the signal, absence is the default. A padlock here would be a lie a user
        // could act on by typing something into a chat they believe is protected.
        expect(plaintext.markerVisible).toBe(false);
        expect(plaintext.markerTitle).toBeNull();
    });

    test('the message-bar padlock appears for an open encrypted chat (§7.1, second placement)', async ({ page }) => {
        await openChatManager(page);
        await page.locator('#select_chat_div .select_chat_block[file_name="encrypted-chat"]').click();
        await page.waitForTimeout(3000);

        const header = page.locator('#chatEncryptedMarker');
        await expect(header).toBeVisible();
        await expect(header).toHaveAttribute('title', 'FIXTURE: this chat is encrypted at rest.');
    });

    test('🔴 a GROUP chat gets the padlock too — the other directory chats live in', async ({ page }) => {
        // The endpoint resolved names under `chats/` only, so a group chat could never be reported as
        // encrypted and the padlock could never draw for one — the same silent, server-test-invisible
        // shape as the `.jsonl` bug this file was written for, in the directory nobody had covered.
        await openGroupChatManager(page);
        const rows = await readRows(page);

        // ⚠️ EXISTS FIRST — a list that failed to render would pass every "no false padlock" assertion.
        expect(rows.length).toBeGreaterThanOrEqual(2);

        const encrypted = rows.find((r) => r.name === SECRET_GROUP_CHAT);
        const plaintext = rows.find((r) => r.name === LEGACY_GROUP_CHAT);
        expect(encrypted).toBeDefined();
        expect(plaintext).toBeDefined();

        expect(encrypted.markerVisible).toBe(true);
        expect(encrypted.markerTitle).toBe('FIXTURE: this chat is encrypted at rest.');
        expect(encrypted.deadRow).toBe(false);

        // §7.2 holds identically here: the group chat that predates the plugin gets nothing at all.
        expect(plaintext.markerVisible).toBe(false);
        expect(plaintext.markerTitle).toBeNull();
    });

    test('🔴 uninstalled: every encrypted chat is a dead row NAMING the provider (§11)', async ({ page }) => {
        await boot({ provider: false });
        await openChatManager(page);
        const rows = await readRows(page);

        // With no provider to demangle, the encrypted chats appear under their marked on-disk names. The
        // point is that they APPEAR — hiding the row is how a user concludes their data is gone.
        const marked = rows.filter((r) => r.name.startsWith('enc~'));
        expect(marked.length).toBeGreaterThanOrEqual(1);

        for (const row of marked) {
            expect(row.deadRow).toBe(true);
            expect(row.markerVisible).toBe(true);

            // 🪪 THE PROVENANCE SENTENCE, IN A REAL BROWSER — `DESIGN_STORAGE_PROVENANCE.md` §7. The plugin
            // is gone from the disk and from the process; everything after the id comes from the record the
            // fork wrote while it was still running, and nothing in this chain is mocked.
            expect(row.markerTitle).toContain('FIXTURE Mixed-Mode Provider');

            // 🔴 §7: the id KEEPS its place beside the name. A friendly name that replaced it would leave a
            // user unable to check that the plugin they found is the plugin the file actually names.
            expect(row.markerTitle).toContain('\'mixed-provider\'');

            // 🔴 Rendered as TEXT. `source` is recorded from a plugin that genuinely ran here, which makes
            // it accurate — and §5 still forbids the fork building a link, a fetch or an install command
            // out of it. The URL is in the sentence; there is no anchor anywhere near it.
            expect(row.markerTitle).toContain('example.invalid/fixtures/mixed-provider');
            expect(row.markerTitle).not.toContain('<a');

            // The preview is useless for a chat nothing can read, so the reason replaces it. This is the
            // difference between "my chats are broken" and "I uninstalled the wrong thing, put it back".
            expect(row.preview).toBe(row.markerTitle);
        }

        // And the chat that predates the plugin is completely untouched by all of it (§1).
        const plaintext = rows.find((r) => r.name === 'plaintext-chat');
        expect(plaintext).toBeDefined();
        expect(plaintext.markerVisible).toBe(false);
        expect(plaintext.deadRow).toBe(false);
    });

    test('🔴 uninstalled: the GROUP\'s encrypted chat is still a ROW, and says what is missing (§14.7)', async ({ page }) => {
        // 🔴 IT USED TO VANISH. A group's chats are found by ID from its definition, not by scanning the
        // directory, so with the provider gone the logical name did not exist and the row was filtered out
        // — "my chats are gone" rather than the dead row §11 requires. The server now emits the row and
        // carries its state with it, because the status endpoint resolves a path and there is no path.
        await openGroupChatManager(page);
        const rows = await readRows(page);

        const dead = rows.find((r) => r.name === SECRET_GROUP_CHAT);
        expect(dead).toBeDefined();
        expect(dead.deadRow).toBe(true);
        expect(dead.markerVisible).toBe(true);

        // The "provider unknown" wording, and it is the correct one here (§14.7): there is no file to read
        // an id from, and naming one off a sibling's envelope would be an inference dressed as a fact.
        expect(dead.markerTitle).toBe('This chat requires a storage provider that is not installed.');
        expect(dead.preview).toBe('This chat requires a storage provider that is not installed.');

        // The group chat that predates the plugin is untouched, in the same list, at the same time.
        const plaintext = rows.find((r) => r.name === LEGACY_GROUP_CHAT);
        expect(plaintext).toBeDefined();
        expect(plaintext.markerVisible).toBe(false);
        expect(plaintext.deadRow).toBe(false);
    });

    test('🔴 uninstalled: a backup that needs the plugin says so, and RESTORING it is refused by name (§9.1)', async ({ page }) => {
        await openChatManager(page);

        await page.locator('button:has-text("Backups")').first().click();
        await page.locator('.chatBackupsListItem').first().waitFor({ state: 'visible', timeout: 20_000 });

        const dead = page.locator('.chatBackupsListItemUnavailable');
        expect(await dead.count()).toBeGreaterThanOrEqual(1);

        // The row explains itself in place, in BACKUP words — not the chat sentence, because the unreadable
        // backup can belong to a chat that is itself plaintext and needs no plugin at all (§14.5). It is
        // upgraded by the provenance registry exactly as the chat row is, and it still says backup and
        // restore, which is what the user was trying to do when they got here.
        const info = dead.locator('.chatBackupsListItemInfo').first();
        await expect(info).toContainText('This backup requires FIXTURE Mixed-Mode Provider (\'mixed-provider\') to restore it.');
        await expect(info).toContainText('example.invalid/fixtures/mixed-provider');

        // 🔴 THE MOMENT §9.1 WAS WRITTEN FOR. The button stays clickable on purpose — a disabled button
        // explains nothing — and the server's 409 is what turns the click into a sentence. That refusal
        // carries the registry record too, so the toast names the plugin rather than repeating a slug.
        await dead.first().locator('.fa-rotate-left').click();
        await expect(page.locator('#toast-container')).toContainText(
            'This backup requires FIXTURE Mixed-Mode Provider (\'mixed-provider\') to restore it.',
            { timeout: 20_000 },
        );
    });
});

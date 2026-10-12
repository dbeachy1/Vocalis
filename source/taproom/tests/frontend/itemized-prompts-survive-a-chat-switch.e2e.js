/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 WHAT THIS GUARDS. Coming BACK to a chat used to erase that chat's whole itemized-prompt history.
 *
 * Every implicit save goes through `saveItemizedPrompts(getCurrentChatId())`, and a chat switch runs
 * `clearChat()` -- which empties the in-memory array -- well before `loadItemizedPrompts()` refills it
 * for the incoming chat. In between, `getCurrentChatId()` has ALREADY flipped to the incoming chat, so
 * a save landing in that window writes the emptied array under the incoming chat's key. The read that
 * follows then faithfully returns the empty array that was just written over the real one.
 *
 * `getChatResult()` calls `saveChatConditional()` INSIDE that window, one line above the load, whenever
 * the incoming chat comes back empty -- proven with a stack trace on 2026-08-26:
 *
 *     saveItemizedPrompts <- saveChatConditional <- getChatResult <- getChat <- selectCharacterById
 *
 * ⚠️ LEAVING A CHAT WAS ALWAYS FINE; RETURNING IS THE DESTRUCTIVE HALF. A test that only switches AWAY
 * passes against the broken code, which is why the away step below is a control rather than the claim.
 *
 * ⚠️ THE VICTIM HERE IS A GREETING-LESS CARD, AND THAT IS NOT A CONTRIVANCE. `getChatResult()` saves
 * only when `chat.length === 0`, and a card with no `first_mes` has nothing to push, so its chat file is
 * written empty and comes back empty on EVERY open -- the window is entered every single time. A card
 * with a greeting reaches it only when the chat genuinely fails to load, which is why Seraphina is
 * carried alongside as the case that must keep working either way.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

test.describe('a chat keeps its itemized prompts across a chat switch', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let scratch;

    test.beforeEach(async () => {
        test.setTimeout(240_000);
        scratch = makeScratchDirectory('itemized-prompts-switch-e2e');
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
    });

    test.afterEach(async () => {
        if (server) await server.stop();
        server = null;
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
        scratch = null;
    });

    /**
     * Wait until the app can actually write.
     *
     * ⚠️ `getContext()` THROWS during early boot, an empty `characters` array is truthy, and the CSRF
     * token is undefined until `firstLoadInit()` has fetched it -- so every write before that is refused
     * 403 in silence. Gate on all three inside a try/catch or the poll rejects instead of retrying.
     * @param {import('@playwright/test').Page} page The page
     */
    async function waitForBoot(page) {
        await page.waitForFunction(() => {
            try {
                const ctx = globalThis.SillyTavern?.getContext?.();
                return (ctx?.characters?.length ?? 0) > 0 && !!ctx.getRequestHeaders?.()['X-CSRF-Token'];
            } catch {
                return false;
            }
        }, null, { timeout: 120_000 });
    }

    /**
     * Read how many itemized prompt sets are stored for a chat.
     *
     * ⚠️ Read through raw IndexedDB, never `await import('/lib.js')`: a dynamic import inside
     * `page.evaluate` creates a SECOND module instance with fresh defaults, so you inspect a localforage
     * that has never been used and conclude the store is empty.
     * @param {import('@playwright/test').Page} page The page
     * @param {string} chatId Chat ID to read
     * @returns {Promise<number|string>} Number of sets, or 'MISSING' when the key is absent
     */
    function storedSets(page, chatId) {
        return page.evaluate(async (key) => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('SillyTavern_Prompts');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                const value = await new Promise((resolve, reject) => {
                    const read = db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get(key);
                    read.onsuccess = () => resolve(read.result);
                    read.onerror = () => reject(read.error);
                });
                return Array.isArray(value) ? value.length : (value === undefined ? 'MISSING' : typeof value);
            } finally {
                db.close();
            }
        }, chatId);
    }

    /**
     * Put one itemized prompt set into the store for a chat, standing in for a generated turn.
     * @param {import('@playwright/test').Page} page The page
     * @param {string} chatId Chat ID to seed
     * @param {string} marker Text to store, so a survivor can be told from a fresh write
     */
    function seedSet(page, chatId, marker) {
        return page.evaluate(async ([key, text]) => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('SillyTavern_Prompts');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                await new Promise((resolve, reject) => {
                    const write = db.transaction('keyvaluepairs', 'readwrite').objectStore('keyvaluepairs')
                        .put([{ mesId: 0, rawPrompt: text }], key);
                    write.onsuccess = () => resolve(null);
                    write.onerror = () => reject(write.error);
                });
            } finally {
                db.close();
            }
        }, [chatId, marker]);
    }

    /**
     * Open a character's chat and wait until it is genuinely the current one.
     *
     * 🔴 `selectCharacterById(-1)` SILENTLY DOES NOTHING, so a name that does not match leaves the
     * previous chat open and every later assertion tests the wrong chat. The index is checked here.
     * @param {import('@playwright/test').Page} page The page
     * @param {string} name Character name
     * @returns {Promise<string>} The chat ID now open
     */
    async function openCharacter(page, name) {
        const result = await page.evaluate(async (characterName) => {
            const ctx = globalThis.SillyTavern.getContext();
            const index = ctx.characters.findIndex(character => character.name === characterName);
            if (index < 0) {
                return { error: `no character named ${characterName}` };
            }
            await ctx.selectCharacterById(index);
            for (let attempt = 0; attempt < 100; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                const chatId = ctx.getCurrentChatId();
                if (chatId && String(chatId).startsWith(characterName)) {
                    return { chatId };
                }
            }
            return { error: `timed out opening ${characterName}`, chatId: ctx.getCurrentChatId() };
        }, name);
        expect(result.error ?? null, `opening ${name}`).toBeNull();
        return result.chatId;
    }

    /**
     * Create a character card through the API the UI uses.
     * @param {import('@playwright/test').Page} page The page
     * @param {string} name Character name
     * @param {string} greeting First message, empty for a greeting-less card
     */
    async function createCharacter(page, name, greeting) {
        const status = await page.evaluate(async ([characterName, firstMessage]) => {
            const ctx = globalThis.SillyTavern.getContext();
            const response = await fetch('/api/characters/create', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ ch_name: characterName, description: 'x', first_mes: firstMessage, file_name: characterName }),
            });
            await ctx.getCharacters();
            return response.status;
        }, [name, greeting]);
        expect(status, `creating ${name}`).toBe(200);
    }

    test('returning to a chat does not erase its itemized prompts', async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await waitForBoot(page);

        await createCharacter(page, 'Quiet', '');
        const quietChat = await openCharacter(page, 'Quiet');
        const seraphinaChat = await openCharacter(page, 'Seraphina');

        /*
         * Seeded and THEN reloaded, deliberately. Writing to the store while the chat is open leaves the
         * store and the in-memory array disagreeing, which no real generated turn ever does -- and the
         * mismatch makes `clearChat()`'s own (correct) save look like the destructive one.
         */
        await seedSet(page, quietChat, 'QUIET-MARKER');
        await seedSet(page, seraphinaChat, 'SERAPHINA-MARKER');
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await waitForBoot(page);

        // Opening the greeting-less card enters the window on its own: this alone used to wipe it.
        await openCharacter(page, 'Quiet');
        expect(await storedSets(page, quietChat), 'Quiet keeps its prompts when opened').toBe(1);

        // The control. Leaving has always been safe, so a failure here means something else broke.
        await openCharacter(page, 'Seraphina');
        expect(await storedSets(page, quietChat), 'Quiet keeps its prompts after switching away').toBe(1);
        expect(await storedSets(page, seraphinaChat), 'Seraphina keeps its prompts when opened').toBe(1);

        // The claim.
        await openCharacter(page, 'Quiet');
        expect(await storedSets(page, quietChat), 'Quiet keeps its prompts on the way back in').toBe(1);
        expect(await storedSets(page, seraphinaChat), 'Seraphina keeps its prompts after switching away').toBe(1);
    });

    test('a group chat keeps its itemized prompts across a chat switch', async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await waitForBoot(page);

        await createCharacter(page, 'Quiet', '');

        /*
         * ⚠️ THIS ONE PASSES AGAINST THE PREVIOUS COMMIT TOO, AND THAT IS THE FINDING. The report
         * this spec came from asked whether groups lose prompts the same way; measured both ways on
         * 2026-08-26, they do not. `getGroupChat()` reaches `loadItemizedPrompts` before anything saves,
         * so the window is open but nothing walks into it. It stays here as the guard that keeps it that
         * way -- a test that cannot fail today is worth having only if it is labelled as one.
         *
         * 🔴 `POST /api/groups/create` COMES BACK WITH `chat_id: ''` AND `chats: []`, and
         * `openGroupChat(id)` on such a group resolves without opening anything -- `groupId` stays null
         * and every later assertion quietly tests whatever character was selected instead. Clicking the
         * card in the list is what creates the group's first chat.
         */
        const groupName = 'Chorus';
        const created = await page.evaluate(async (name) => {
            const ctx = globalThis.SillyTavern.getContext();
            const members = ctx.characters.map(character => character.avatar);
            const response = await fetch('/api/groups/create', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ name, members, disabled_members: [], chat_metadata: {}, fav: false, generation_mode: 0 }),
            });
            return response.status;
        }, groupName);
        expect(created, 'creating the group').toBe(200);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForBoot(page);

        /**
         * Click the group's card and wait until the group chat is genuinely open.
         * @param {import('@playwright/test').Page} page The page
         * @param {string} name Group name
         * @returns {Promise<string?>} The group's chat ID, or null on a timeout
         */
        const openGroup = (page, name) => page.evaluate(async (groupLabel) => {
            /*
             * ⚠️ THE GROUP LIST IS PRINTED LATER THAN `characters` IS POPULATED, so the boot gate is not
             * late enough for this and querying straight after it finds nothing about one run in three.
             * The absence is a race, not a missing group -- wait for the card rather than concluding.
             */
            let card = null;
            for (let attempt = 0; attempt < 150 && !card; attempt++) {
                card = Array.from(document.querySelectorAll('#rm_print_characters_block .group_select'))
                    .find(element => element.textContent?.includes(groupLabel)) ?? null;
                if (!card) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            if (!card) {
                return null;
            }
            card.click();
            for (let attempt = 0; attempt < 150; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                // 🔴 `getContext()` MUST BE RE-FETCHED EVERY POLL. `groupId` is a plain property on the
                // object the call builds, not a getter, so a context captured before the click reports
                // `null` for ever and the poll times out on a group that opened perfectly.
                const ctx = globalThis.SillyTavern.getContext();
                if (ctx.groupId && ctx.getCurrentChatId()) {
                    return ctx.getCurrentChatId();
                }
            }
            return null;
        }, name);

        const groupChat = await openGroup(page, groupName);
        expect(groupChat, 'opening the group').toBeTruthy();

        await seedSet(page, groupChat, 'GROUP-MARKER');
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await waitForBoot(page);

        // `getCurrentChatId()` takes its `selected_group` branch here, and `getGroupChat()` holds the
        // same window open across three awaits before it reaches `loadItemizedPrompts`.
        expect(await openGroup(page, groupName), 'reopening the group').toBe(groupChat);
        expect(await storedSets(page, groupChat), 'the group keeps its prompts when opened').toBe(1);

        await openCharacter(page, 'Quiet');
        expect(await storedSets(page, groupChat), 'the group keeps its prompts after switching away').toBe(1);

        expect(await openGroup(page, groupName), 'returning to the group').toBe(groupChat);
        expect(await storedSets(page, groupChat), 'the group keeps its prompts on the way back in').toBe(1);
    });

    test('a turn whose generation failed still keeps its itemized prompt', async ({ page }) => {
        /*
         * 🔴 THE OTHER HALF OF THE SAME ORDERING BUG, AND IT NEEDS NO SEEDED MARKER.
         *
         * `Generate()` itemizes the prompt BEFORE it calls the backend, so a turn whose generation fails
         * leaves a real 41-field entry in memory with no message committed and nothing to trigger a chat
         * save. The only thing that would have written it is `clearChat()`'s save on the way out -- and
         * that save was dead, because `selectCharacterById()` sets `this_chid` to `undefined` before
         * calling it, so `getCurrentChatId()` had already stopped answering. Measured on 2026-08-26: the
         * entry was never persisted at all, on any of the three checks below.
         *
         * ⚠️ A SUCCESSFUL turn does NOT show this. Its reply commits a message, the chat file stops being
         * empty, and `saveChatConditional()` persists the entry the ordinary way -- which is why the
         * scenario has to be a FAILED generation to be about anything.
         */
        await page.route('**/api/backends/chat-completions/status', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [{ id: 'mock-model' }] }),
        }));
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'no model loaded' } }),
        }));

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await waitForBoot(page);
        await createCharacter(page, 'Quiet', '');

        /*
         * ⚠️ `Generate()` returns immediately while `online_status === 'no_connection'`, so without this
         * the send does nothing, the chat stays empty and every assertion below passes for the wrong
         * reason. Everything in the API drawer is `display:none`, so jQuery triggers rather than clicks.
         */
        const status = await page.evaluate(async () => {
            $('#main_api').val('openai').trigger('change');
            $('#chat_completion_source').val('custom').trigger('change');
            $('#custom_api_url_text').val('http://127.0.0.1:9/v1').trigger('input');
            $('#api_button_openai').trigger('click');
            for (let attempt = 0; attempt < 150; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                // Re-fetched every poll: `onlineStatus` is a plain property of the object `getContext()`
                // builds, not a getter, so a captured context never changes its mind.
                const onlineStatus = globalThis.SillyTavern.getContext().onlineStatus;
                if (onlineStatus && onlineStatus !== 'no_connection') {
                    return onlineStatus;
                }
            }
            return globalThis.SillyTavern.getContext().onlineStatus;
        });
        expect(status, 'connecting to the mock backend').not.toBe('no_connection');

        const quietChat = await openCharacter(page, 'Quiet');

        const sent = await page.evaluate(async () => {
            const before = globalThis.SillyTavern.getContext().chat.length;
            $('#send_textarea').val('hello there').trigger('input');
            $('#send_but').trigger('click');
            for (let attempt = 0; attempt < 100; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                const chat = globalThis.SillyTavern.getContext().chat;
                if (chat.length >= before + 1) {
                    return { messages: chat.length };
                }
            }
            return { messages: globalThis.SillyTavern.getContext().chat.length };
        });
        expect(sent.messages, 'the user message was committed').toBeGreaterThan(0);

        /*
         * 🔴 `selectCharacterById()` SILENTLY DOES NOTHING WHILE `is_send_press` IS SET -- its whole body
         * is inside `if (!is_send_press)`, with no toast and no log. The user message lands long before
         * the backend answers, so switching straight after it leaves the old chat open and every
         * assertion below then reads a store nothing has touched. Wait for the send buttons to come back.
         */
        await page.waitForFunction(
            () => $('#send_but').is(':visible') && !$('#mes_stop').is(':visible'),
            null,
            { timeout: 60_000 },
        );

        // Leaving is what has to persist it: nothing else will, and nothing else did.
        await openCharacter(page, 'Seraphina');
        expect(await storedSets(page, quietChat), 'the failed turn is written out on the way out').toBe(1);

        await openCharacter(page, 'Quiet');
        expect(await storedSets(page, quietChat), 'and it is still there on the way back in').toBe(1);
    });
});

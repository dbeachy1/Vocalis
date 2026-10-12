/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 WHAT THIS GUARDS. Reloading the page must not silently change who you are talking AS.
 *
 * With `auto_load_chat` on, a refresh re-opens the chat you were in, and `loadPersonaForCurrentChat()`
 * then decides which persona that chat gets: chat lock, then character connection, then the default
 * persona. Every one of those three has to survive the round trip, because the failure is invisible --
 * the chat looks identical and the next message is simply sent as somebody else.
 *
 * The reload is the whole point. Nothing here can be asserted without a real boot: the ordering between
 * `getSettings()` restoring `user_avatar`, `RA_autoloadchat()` re-opening the chat, and the CHAT_CHANGED
 * that follows exists only in a live page.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

test.describe('the persona of the current chat survives a reload', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string[]} */
    let settingsFiles;

    /*
     * 🔴 A SERVER PER TEST, NOT PER FILE, AND THE SECOND TEST IS WHY. `auto_load_chat` plus a saved
     * `active_character` means the NEXT test's first page load arrives with the previous test's chat
     * already open -- so `/go` hits the "already selected" branch, emits no CHAT_CHANGED, and the setup
     * silently skips the persona selection it was written to arrange. The chat lock and character
     * connection left behind by earlier tests leak the same way, and personas accumulate under
     * duplicate names. A fresh data root costs a few seconds and removes the whole class.
     */
    test.beforeEach(async () => {
        test.setTimeout(240_000);
        const scratch = makeScratchDirectory('persona-reload-e2e');
        const dataRoot = path.join(scratch, 'data');
        server = await startSillyTavern({
            dataRoot,
            configPath: path.join(scratch, 'config.yaml'),
        });
        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;
        settingsFiles = await stepPastFirstRun(dataRoot);
    });

    test.afterEach(async () => {
        if (server) await server.stop();
        server = null;
    });

    /** Auto-load is what makes a refresh land back in the chat -- without it there is nothing to assert. */
    function seedSettings() {
        for (const file of settingsFiles) {
            const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
            json.power_user = json.power_user ?? {};
            json.power_user.auto_load_chat = true;
            json.power_user.persona_show_notifications = false;
            fs.writeFileSync(file, JSON.stringify(json, null, 4), 'utf-8');
        }
    }

    /**
     * Open the app and wait until it is genuinely up.
     * @param {import('@playwright/test').Page} page The page
     */
    async function openApp(page) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await waitForBoot(page);
    }

    /**
     * Wait until the app is genuinely up.
     *
     * ⚠️ `getContext()` THROWS during early boot (a TDZ on script.js's module bindings), and an empty
     * `characters` array is truthy -- so gate on its length inside a try/catch or the poll rejects instead
     * of retrying.
     *
     * 🔴 AND `characters` IS NOT LATE ENOUGH. `firstLoadInit()` calls `getCharacters()` BEFORE
     * `initPersonas()`, so a page that has characters can still answer `Unknown command:
     * "/persona-create"` -- which is what the first version of this spec did, silently, for three runs.
     * The persona commands are registered by the thing under test, so they are the honest gate.
     * @param {import('@playwright/test').Page} page The page
     */
    async function waitForBoot(page) {
        await page.waitForFunction(() => {
            try {
                const ctx = globalThis.SillyTavern?.getContext?.();
                return (ctx?.characters?.length ?? 0) > 0 && !!ctx.SlashCommandParser?.commands?.['persona-create'];
            } catch {
                return false;
            }
        }, null, { timeout: 120_000 });
    }

    /**
     * Run a slash command through the LIVE module instance.
     *
     * ⚠️ Only the flat bits of the result come back. `SlashCommandClosureResult` carries the closure --
     * and through it the whole parser -- so returning it whole is a serialisation problem, not a result.
     */
    function run(page, command) {
        return page.evaluate(async (cmd) => {
            try {
                const result = await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions(cmd, { handleParserErrors: false });
                return { pipe: result?.pipe ?? null, isError: !!result?.isError, error: String(result?.errorMessage ?? '') };
            } catch (error) {
                return { pipe: null, isError: true, error: String(error?.message ?? error) };
            }
        }, command);
    }

    /**
     * Who the page thinks it is, and what the chat says about it.
     *
     * ⚠️ `persona` is read off the DOM because `user_avatar` is module-scope in `personas.js` and reaches
     * `getContext()` nowhere. The `.selected` class is set by `updatePersonaUIStates()`, which is exactly
     * what paints the highlight the user reads the answer from -- so it is the honest place to ask, and
     * `name1` alone is not: two personas may share a name.
     */
    function state(page) {
        return page.evaluate(() => {
            const ctx = globalThis.SillyTavern.getContext();
            return {
                name1: ctx.name1,
                persona: document.querySelector('#user_avatar_block .avatar-container.selected')?.getAttribute('data-avatar-id') ?? null,
                chatPersona: ctx.chatMetadata?.persona ?? null,
                defaultPersona: ctx.powerUserSettings.default_persona ?? null,
                characterId: ctx.characterId,
                chatId: ctx.getCurrentChatId(),
            };
        });
    }

    /** Wait until the auto-loaded chat is actually open. */
    async function waitForChat(page) {
        await waitForBoot(page);
        await page.waitForFunction(() => {
            try {
                const ctx = globalThis.SillyTavern.getContext();
                return ctx.characterId !== undefined && !!ctx.getCurrentChatId();
            } catch {
                return false;
            }
        }, null, { timeout: 120_000 });
        // The persona is chosen on CHAT_CHANGED, which is emitted at the END of the chat load, and the
        // things that could still overwrite it are debounced. Give them room to be wrong.
        await page.waitForTimeout(3_000);
    }

    /**
     * A default persona, a second persona, and a chat open on the first character.
     *
     * ⚠️ Personas are addressed by the avatar key `/persona-create` hands back, never by name -- a name
     * is not unique and `/persona <name>` warns and takes the first match, which is a silent way to
     * assert against the wrong persona.
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<{other: string, chosen: string}>} The two avatar keys
     */
    async function setUpChat(page) {
        seedSettings();
        await openApp(page);

        const other = await run(page, '/persona-create name=Other');
        expect(other.isError, `/persona-create failed: ${other.error}`).toBe(false);
        expect(other.pipe, 'no avatar key came back').toBeTruthy();
        await run(page, '/persona-lock type=default on');

        const chosen = await run(page, '/persona-create name=Chosen');
        expect(chosen.isError, `/persona-create failed: ${chosen.error}`).toBe(false);
        expect(chosen.pipe, 'no avatar key came back').toBeTruthy();

        // 🔴 `/go`, NOT `selectCharacterById()`. Only the click handler and `/go` call
        // `setActiveCharacter()`, and `active_character` is the entire reason a refresh re-opens the chat
        // -- select the character the direct way and the reload lands on the welcome screen instead, so
        // the spec times out having tested nothing.
        const name = await page.evaluate(() => globalThis.SillyTavern.getContext().characters[0].name);
        const go = await run(page, `/go ${name}`);
        expect(go.isError, `/go ${name} failed: ${go.error}`).toBe(false);
        await waitForChat(page);

        const opened = await state(page);
        expect(opened.defaultPersona, 'the default persona must be the OTHER one, or nothing here proves anything').toBe(other.pipe);
        expect(opened.persona, 'opening the chat should have applied the default persona').toBe(other.pipe);

        return { other: other.pipe, chosen: chosen.pipe };
    }

    /**
     * Refresh the page the way Ctrl+Shift+R does, and report what the chat came back as.
     * @param {import('@playwright/test').Page} page The page
     * @param {object} before The state before the reload
     * @returns {Promise<object>} The state after it
     */
    async function reloadInto(page, before) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForChat(page);
        const after = await state(page);
        expect(after.chatId, 'the reload did not re-open the chat, so nothing was tested').toBe(before.chatId);
        return after;
    }

    test('🔴 a persona locked to the chat is still selected after a reload', async ({ page }) => {
        const { chosen } = await setUpChat(page);

        await run(page, `/persona ${chosen}`);
        await run(page, '/persona-lock type=chat on');
        await page.evaluate(() => globalThis.SillyTavern.getContext().saveMetadata());
        await page.waitForTimeout(2_000);

        const before = await state(page);
        expect(before.persona).toBe(chosen);
        expect(before.chatPersona, 'the chat lock was never written').toBe(chosen);

        const after = await reloadInto(page, before);
        expect(after.persona, 'the reload silently switched the persona').toBe(chosen);
    });

    test('🔴 a persona connected to the character is still selected after a reload', async ({ page }) => {
        const { chosen } = await setUpChat(page);

        await run(page, `/persona ${chosen}`);
        await run(page, '/persona-lock type=character on');
        await page.waitForTimeout(2_000);

        const before = await state(page);
        expect(before.persona).toBe(chosen);
        expect(before.chatPersona, 'this case is about the CHARACTER connection, so the chat must not be locked').toBeNull();

        const after = await reloadInto(page, before);
        expect(after.persona, 'the reload silently switched the persona').toBe(chosen);
    });

    test('🔴 a persona chosen by hand in a chat is still selected after a reload', async ({ page }) => {
        const { chosen } = await setUpChat(page);

        // No lock of any kind -- just "I am talking as this persona in this chat right now", which is
        // what a user does when they pick a persona from the list and carry on typing.
        await run(page, `/persona ${chosen}`);
        await page.waitForTimeout(2_000);

        const before = await state(page);
        expect(before.persona).toBe(chosen);
        expect(before.chatPersona, 'nothing should have locked this chat').toBeNull();

        const after = await reloadInto(page, before);
        expect(after.persona, 'the reload reset the chat to the default persona').toBe(chosen);
    });

    test('a chat nobody chose a persona in still follows the default persona', async ({ page }) => {
        const { other, chosen } = await setUpChat(page);

        // 🔴 THE OTHER HALF OF THE BARGAIN. Remembering the persona per chat must not freeze a chat to
        // whatever the default happened to be the first time it was opened -- change the default, and a
        // conversation that was only ever held as "whoever is default" has to follow it. Nothing is
        // chosen by hand here: the chat is opened, the default is repointed, and the reload has to
        // honour the new one.
        const before = await state(page);
        expect(before.persona, 'the chat should be running on the default persona').toBe(other);

        await run(page, `/persona ${chosen}`);
        await run(page, '/persona-lock type=default on');
        await run(page, `/persona ${other}`);
        await page.waitForTimeout(2_000);

        // ⚠️ Selecting the new default by hand records it, which is not the case under test -- put the
        // chat back on the persona it opened with, and forget that either selection ever happened.
        await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            delete ctx.chatMetadata.persona_last_used;
            await ctx.saveMetadata();
        });

        const repointed = await state(page);
        expect(repointed.defaultPersona, 'the default persona was not repointed').toBe(chosen);
        expect(repointed.persona).toBe(other);

        const after = await reloadInto(page, repointed);
        expect(after.persona, 'the new default persona never reached the chat').toBe(chosen);
    });
});

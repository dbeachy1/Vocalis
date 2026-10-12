/* eslint-env browser */
// ^ The callbacks handed to page.evaluate()/waitForFunction() run in the PAGE, not in Node, so they
//   legitimately reach for `document` and `globalThis`. Lint sees one file and cannot tell the two
//   contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 WHAT THIS GUARDS: ARRIVING SOMEWHERE OLD MUST NOT COST MORE THAN ARRIVING SOMEWHERE RECENT.
 *
 * `showMoreMessages` only ever prepended, and nothing was ever removed, so `/chat-jump 40` in a chat of
 * several thousand messages painted EVERY message between 40 and the end in one DOM insert. The feature
 * that motivated the change — a calendar that jumps to a day — makes exactly the far jumps that are
 * worst under the old behavior, so the calendar without the window is a trap rather than a feature.
 *
 * The regression this exists to catch is silent: a jump to message 40 still *works* unwindowed. It just
 * takes seconds and hands every extension with per-message UI a few thousand elements to catch up on.
 * Nothing fails; it is merely slow. So the assertion is on the PAINTED COUNT, not on the outcome of the
 * jump, and it is written as a hard ceiling rather than an exact number so that tuning the window size
 * does not require editing the test.
 *
 * ⚠️ SUFFIX ASSUMPTIONS ARE THE OTHER HALF. Before windowing, the painted messages were always a suffix
 * of `chat`, so several things keyed "the last message" off DOM position — `last_mes` was awarded to
 * `$('#chat .mes').last()`. Windowed, that hands swipe buttons and the swipe key handlers to whatever
 * message happens to sit at the bottom of the viewport, which is a correctness bug and not a cosmetic
 * one. That is asserted here directly.
 */

/** Deterministic anchor, so the rendered months do not depend on when the suite runs. */
const FIRST_MESSAGE_AT = Date.UTC(2025, 0, 5, 9, 0, 0);
const HOURS_BETWEEN_MESSAGES = 3.4;
const MESSAGE_COUNT = 3000;
const CHAT_NAME = 'a-year-of-chat';

/** The default #Msg. to Load, which is what an unwindowed initial paint is bounded by. */
const CHAT_TRUNCATION_DEFAULT = 100;

/** The default #Msg. to Keep — the ceiling past which the far edge of the window is dropped. */
const CHAT_WINDOW_MAX_DEFAULT = 500;

/**
 * How many calendar months the fixture chat covers, first message to last.
 *
 * ⚠️ LOCAL time, not UTC. The calendar buckets messages with `timestampToMoment`, which renders in the
 * viewer's zone, so a message near a month boundary belongs to whichever month the BROWSER says. Node and
 * the browser share this machine's zone, so reading it locally here is what keeps the two in agreement.
 */
function monthsSpanned() {
    const first = new Date(FIRST_MESSAGE_AT);
    const last = new Date(FIRST_MESSAGE_AT + ((MESSAGE_COUNT - 1) * HOURS_BETWEEN_MESSAGES * 3600 * 1000));

    return ((last.getFullYear() - first.getFullYear()) * 12) + (last.getMonth() - first.getMonth()) + 1;
}

test.describe.configure({ mode: 'serial' });

test.describe('windowed chat view and the date calendar', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let charDir;

    /**
     * A chat long enough, and old enough, that painting all of it is visibly the wrong thing.
     * @param {string} characterName Name the messages are attributed to.
     * @returns {object[]} Chat file lines, header first.
     */
    function buildLongChat(characterName) {
        const lines = [{
            user_name: 'User',
            character_name: characterName,
            create_date: new Date(FIRST_MESSAGE_AT).toISOString(),
            chat_metadata: {},
        }];

        for (let i = 0; i < MESSAGE_COUNT; i++) {
            const sentAt = new Date(FIRST_MESSAGE_AT + (i * HOURS_BETWEEN_MESSAGES * 3600 * 1000));
            lines.push({
                name: i % 2 === 0 ? 'User' : characterName,
                is_user: i % 2 === 0,
                is_system: false,
                send_date: sentAt.toISOString(),
                mes: `message number ${i}`,
                extra: {},
            });
        }

        return lines;
    }

    /** Painted message ids, straight out of the DOM. */
    function readPainted(page) {
        return page.evaluate(() => {
            const ids = Array.from(document.querySelectorAll('#chat .mes[mesid]'))
                .map(el => Number(el.getAttribute('mesid')))
                .filter(n => !isNaN(n));

            const lastMes = document.querySelector('#chat .mes.last_mes');

            return {
                count: ids.length,
                firstId: ids.length ? Math.min(...ids) : null,
                lastId: ids.length ? Math.max(...ids) : null,
                lastMesId: lastMes ? Number(lastMes.getAttribute('mesid')) : null,
                hasShowMoreUp: !!document.querySelector('#show_more_messages'),
                hasShowMoreDown: !!document.querySelector('#show_more_messages_down'),
                chatLength: globalThis.SillyTavern.getContext().chat.length,
            };
        });
    }

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('chat-window-e2e');
        dataRoot = path.join(scratch, 'data');

        server = await startSillyTavern({
            dataRoot,
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        // 🔴 STEP PAST ONBOARDING, OR NOTHING BELOW RUNS — a fresh data root is a first run, and
        // `getSettings()` ends at `doOnboarding()`, which waits for a human that headless never sends.
        await stepPastFirstRun(dataRoot);

        // The shipped character is what makes a chat reachable at all.
        const avatar = fs.readdirSync(path.join(dataRoot, 'default-user', 'characters')).find(n => n.endsWith('.png'));
        if (!avatar) {
            throw new Error('The data root shipped no character, so there is nothing to hang a chat on.');
        }
        charDir = path.parse(avatar).name;

        const chatsDirectory = path.join(dataRoot, 'default-user', 'chats', charDir);
        fs.mkdirSync(chatsDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(chatsDirectory, `${CHAT_NAME}.jsonl`),
            buildLongChat(charDir).map(line => JSON.stringify(line)).join('\n'),
            'utf-8',
        );
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    test.beforeEach(async ({ page }) => {
        // Loading a 3,000-message chat is the point of the fixture, and it is not quick.
        test.setTimeout(180_000);
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

        // `getContext()` THROWS during early boot (a TDZ on script.js's module bindings), so the poll
        // has to swallow that and retry rather than reject.
        await page.waitForFunction(() => {
            try {
                return !!globalThis.SillyTavern?.getContext()?.characters?.length;
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });

        // The data root ships exactly one character, and it is the one the chat was planted under.
        // Selected through the context rather than by clicking the list: the character drawer is closed
        // on load, so the row exists but is not visible, and opening the drawer is not what is under test.
        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().selectCharacterById(0);
        });

        await page.waitForFunction(() => {
            try {
                return globalThis.SillyTavern.getContext().characterId !== undefined;
            } catch {
                return false;
            }
        }, null, { timeout: 30_000 });

        await page.evaluate(async (chatName) => {
            await globalThis.SillyTavern.getContext().openCharacterChat(chatName);
        }, CHAT_NAME);

        await page.waitForFunction((expected) => {
            try {
                return globalThis.SillyTavern.getContext().chat.length === expected;
            } catch {
                return false;
            }
        }, MESSAGE_COUNT, { timeout: 30_000 });

        await expect(page.locator('#chat .mes[mesid]').first()).toBeAttached({ timeout: 30_000 });
    });

    test('the initial paint is bounded, and the newest message owns last_mes', async ({ page }) => {
        const painted = await readPainted(page);

        expect(painted.chatLength).toBe(MESSAGE_COUNT);
        expect(painted.count).toBeLessThanOrEqual(CHAT_TRUNCATION_DEFAULT + 1);
        expect(painted.lastId).toBe(MESSAGE_COUNT - 1);

        // At the tail, last_mes belongs on the newest message — the pre-existing behavior.
        expect(painted.lastMesId).toBe(MESSAGE_COUNT - 1);
        expect(painted.hasShowMoreUp).toBe(true);
        expect(painted.hasShowMoreDown).toBe(false);
    });

    test('jumping far back paints a window, not everything from there to the end', async ({ page }) => {
        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions('/chat-jump 40');
        });

        await page.waitForFunction(() => !!document.querySelector('#chat .mes[mesid="40"]'), null, { timeout: 30_000 });

        const painted = await readPainted(page);

        // 🔴 THE REGRESSION. Unwindowed this is MESSAGE_COUNT - 40 = 2960 elements in one insert.
        expect(painted.count).toBeLessThanOrEqual(CHAT_WINDOW_MAX_DEFAULT);
        expect(painted.firstId).toBeLessThanOrEqual(40);
        expect(painted.lastId).toBeLessThan(MESSAGE_COUNT - 1);

        // 🔴 The suffix assumption. The bottom of #chat is no longer the end of the chat, so nothing
        // down there may carry last_mes — it drives the swipe buttons and the swipe key handlers.
        expect(painted.lastMesId).toBeNull();

        // Message 40 sits within one window's lead-in of the start, so the window reaches id 0 and
        // there is correctly nothing above it. What matters is that there is something BELOW: the
        // rest of the chat is still reachable, it is simply not painted.
        expect(painted.firstId).toBe(0);
        expect(painted.hasShowMoreUp).toBe(false);
        expect(painted.hasShowMoreDown).toBe(true);
    });

    test('a window in the middle of the chat can be extended in either direction', async ({ page }) => {
        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions('/chat-jump 1500');
        });
        await page.waitForFunction(() => !!document.querySelector('#chat .mes[mesid="1500"]'), null, { timeout: 30_000 });

        const painted = await readPainted(page);

        expect(painted.firstId).toBeGreaterThan(0);
        expect(painted.lastId).toBeLessThan(MESSAGE_COUNT - 1);
        expect(painted.hasShowMoreUp).toBe(true);
        expect(painted.hasShowMoreDown).toBe(true);
        expect(painted.lastMesId).toBeNull();
    });

    test('the window extends downwards and slides rather than growing without bound', async ({ page }) => {
        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions('/chat-jump 40');
        });
        await page.waitForFunction(() => !!document.querySelector('#chat .mes[mesid="40"]'), null, { timeout: 30_000 });

        const before = await readPainted(page);

        const ceiling = await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            // Extend downwards well past the ceiling; the far edge should be dropped, not kept.
            for (let i = 0; i < 8; i++) {
                await ctx.showMoreMessagesDown();
            }
            return ctx.getDisplayedMessageRange();
        });

        expect(ceiling.lastId).toBeGreaterThan(before.lastId);
        // The default #Msg. to Keep is 500; the window must not have grown past it.
        expect(ceiling.count).toBeLessThanOrEqual(CHAT_WINDOW_MAX_DEFAULT);
        expect(ceiling.firstId).toBeGreaterThan(before.firstId);
    });

    test('MORE_MESSAGES_LOADED reports which messages are painted', async ({ page }) => {
        const payload = await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();

            return await new Promise((resolve) => {
                const handler = (data) => {
                    ctx.eventSource.removeListener(ctx.eventTypes.MORE_MESSAGES_LOADED, handler);
                    resolve(data ?? null);
                };
                ctx.eventSource.on(ctx.eventTypes.MORE_MESSAGES_LOADED, handler);
                ctx.showMoreMessages();
            });
        });

        expect(payload).not.toBeNull();
        expect(typeof payload.firstId).toBe('number');
        expect(typeof payload.lastId).toBe('number');
        expect(payload.lastId).toBeGreaterThanOrEqual(payload.firstId);
    });

    test('showMessageWindow is on getContext and reports the range it painted', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            const range = await ctx.showMessageWindow(1500, { before: 20, after: 20 });
            return { range, painted: ctx.getDisplayedMessageRange(), tail: ctx.isChatTailDisplayed() };
        });

        expect(result.range.firstId).toBe(1480);
        expect(result.range.lastId).toBe(1520);
        expect(result.painted.count).toBe(41);
        expect(result.tail).toBe(false);
    });

    test('the calendar marks populated days and jumps the chat to the one picked', async ({ page }) => {
        await page.locator('#options_button').click();
        await page.locator('#option_jump_to_date').click();

        const grid = page.locator('.chat_calendar_grid');
        await expect(grid).toBeVisible({ timeout: 15_000 });

        // ⚠️ The ☰ menu must be gone. Its shared handler calls hideMenu() only after the branch returns,
        // and this branch AWAITS the popup — so without dismissing it up front the menu sits open behind
        // the calendar until a day is picked.
        await expect(page.locator('#options')).toBeHidden();

        // The calendar opens on the month of the NEWEST message, so paging back is what reaches the old
        // ones — which is the motion the feature exists for.
        const label = page.locator('.chat_calendar_label');
        const openingMonth = await label.textContent();

        const markedDays = page.locator('.chat_calendar_day.has_messages');
        await expect(markedDays.first()).toBeVisible();

        await page.locator('.chat_calendar_nav.fa-chevron-left').click();
        await expect(label).not.toHaveText(openingMonth ?? '');

        // Page back to the very first month. The span is derived from the fixture rather than hard-coded
        // so that retuning the fixture does not silently turn this into a no-op.
        //
        // ⚠️ The count has to be exact. Reaching the first month DISABLES this chevron, and `.disabled`
        // carries `pointer-events: none` — so one click too many does not no-op, it hangs until the test
        // times out against a parent that swallows the event.
        const clicksFromNewestToOldest = monthsSpanned() - 1;
        for (let i = 0; i < clicksFromNewestToOldest - 1; i++) {
            await page.locator('.chat_calendar_nav.fa-chevron-left').click();
        }

        // Nothing older than the first message, so the back chevron takes itself out of play.
        await expect(page.locator('.chat_calendar_nav.fa-chevron-left')).toHaveClass(/disabled/);

        const target = markedDays.first();
        const targetId = Number(await target.getAttribute('data-first-id'));
        expect(Number.isNaN(targetId)).toBe(false);

        await target.click();

        await page.waitForFunction((id) => !!document.querySelector(`#chat .mes[mesid="${id}"]`), targetId, { timeout: 30_000 });

        const painted = await readPainted(page);

        // Landed on the day, and did NOT paint everything from that day to now.
        expect(painted.firstId).toBeLessThanOrEqual(targetId);
        expect(painted.lastId).toBeGreaterThanOrEqual(targetId);
        expect(painted.count).toBeLessThanOrEqual(CHAT_WINDOW_MAX_DEFAULT);
    });
});

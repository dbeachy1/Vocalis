/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory } from '../util/st-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/*
 * 🔴 A BACKGROUND SUMMARIZER MUST NOT BE ABLE TO TAKE A MESSAGE'S BUTTONS AWAY.
 *
 * ## Why "until the character replies again" is the whole diagnosis
 *
 * Exactly one rule in the fork can hide that row, and it is keyed on a body attribute. NOTHING
 * un-hides it — `.last_mes` simply MOVES to the newly appended message, so the selector stops
 * matching the one you were looking at. A reply therefore appears to "fix" it, and nothing else
 * does. That is the signature of a body flag that was set and never cleared.
 *
 * ## And the flag had no owner
 *
 * `data-generating` is one global boolean. Seven call sites in `script.js` toggle it — Generate, the
 * streaming processor, the group loop, `/gen lock=`, `/genraw lock=`, `/genstream lock=`, the
 * summarizer — and so may ANY extension, because `deactivateSendButtons()` is on the public context.
 * `SillyTavern-MessageSummarize` does precisely that whenever its `block_chat` setting is on (it is
 * on by default), and its unlock lives in a different function behind a completion check, so a
 * summary pass that does not reconcile leaves the lock held forever.
 *
 * Blocking chat input while something summarizes in the background is a reasonable thing for an
 * extension to want. Taking away your ability to edit or copy a message that finished minutes ago
 * is not, and it was never what that rule was for: the rule exists so you cannot act on a reply that
 * is still being written.
 *
 * ## So the two states are separated, and this spec pins the separation
 *
 *   `data-generating`          — the INPUT lock. #send_but / #mes_continue / #mes_impersonate.
 *                                Anyone may hold it, including extensions.
 *   `data-generating-message`  — a reply is being written into the last message. Set in exactly one
 *                                place, by a non-quiet Generate(), cleared by activateSendButtons().
 *   `data-swiping`             — during a swipe the row genuinely belongs to the animation. Kept.
 *
 * ## Why this is a pure-CSS render and not a server boot
 *
 * What is under test is which selector matches which body state — a fact about the shipped
 * stylesheet and nothing else. Booting SillyTavern adds no information and the states would have to
 * be forced by hand anyway. So the real `style.css` is loaded into a blank page carrying a realistic
 * two-message chat, and the attributes are set directly.
 */

const CSS = [
    'public/css/fontawesome.min.css',
    'public/css/solid.min.css',
    'public/style.css',
    // `.extraMesButtons` ships `display: none` and is switched back on by `body.expandMessageActions`.
    // With that setting enabled, the EXTRA buttons become hidden while the input is locked.
    'public/css/toggle-dependent.css',
].map(rel => pathToFileURL(path.join(repoRoot, rel)).href);

/**
 * A blank page carrying a two-message chat and a send form, at file:// scope.
 * @returns {string} URL of the fixture
 */
function makePage() {
    const scratch = makeScratchDirectory('message-actions-input-lock');
    const links = CSS.map(href => `<link rel="stylesheet" href="${href}">`).join('\n');
    const file = path.join(scratch, 'chat.html');
    fs.writeFileSync(file, `<!DOCTYPE html>
<meta charset="utf-8">
${links}
<body class="expandMessageActions">
<div id="chat">
    <div class="mes" mesid="0">
        <div class="mes_block"><div class="ch_name flex-container justifySpaceBetween">
            <div class="flex-container flex1 alignitemscenter"><span class="name_text">Test</span></div>
            <div class="mes_buttons">
                <div class="extraMesButtons">
                    <div class="mes_button mes_copy fa-solid fa-copy"></div>
                </div>
                <div class="mes_button mes_edit fa-solid fa-pencil"></div>
            </div>
        </div></div>
    </div>
    <div class="mes last_mes" mesid="1">
        <div class="mes_block"><div class="ch_name flex-container justifySpaceBetween">
            <div class="flex-container flex1 alignitemscenter"><span class="name_text">Test</span></div>
            <div class="mes_buttons" id="lastRow">
                <div class="extraMesButtons" id="lastExtra">
                    <div class="mes_button mes_copy fa-solid fa-copy" id="lastCopy"></div>
                    <div class="mes_button vocalis_narrate fa-solid fa-volume-high" id="lastExtension"></div>
                </div>
                <div class="mes_button mes_edit fa-solid fa-pencil" id="lastEdit"></div>
            </div>
        </div></div>
        <div class="mes_reasoning_actions" id="lastReasoning"></div>
    </div>
</div>
<div id="form_sheld"><div id="send_but" class="fa-solid fa-paper-plane"></div>
<div id="mes_continue" class="fa-solid fa-arrow-right"></div>
<div id="mes_impersonate" class="fa-solid fa-user"></div></div>
</body>`, 'utf-8');
    return pathToFileURL(file).href;
}

/**
 * Put the body into one generation state and read back what is visible.
 * @param {import('@playwright/test').Page} page The page
 * @param {object} state Body dataset attributes to set; everything else is cleared
 * @returns {Promise<object>} display of each element under test
 */
function underState(page, state) {
    return page.evaluate(async (state) => {
        await document.fonts.ready;
        for (const key of ['generating', 'generatingMessage', 'swiping']) delete document.body.dataset[key];
        Object.assign(document.body.dataset, state);
        const show = id => getComputedStyle(document.getElementById(id)).display;
        const row = document.getElementById('lastRow').getBoundingClientRect();
        return {
            row: show('lastRow'),
            rowWidth: Number(row.width.toFixed(2)),
            extra: show('lastExtra'),
            extensionButton: show('lastExtension'),
            reasoning: show('lastReasoning'),
            sendBut: show('send_but'),
            continueBut: show('mes_continue'),
            impersonate: show('mes_impersonate'),
        };
    }, state);
}

test.describe('the last message keeps its buttons unless THAT message is being written', () => {
    test('idle: the row, the extras and the extension button are all visible', async ({ page }) => {
        await page.goto(makePage());
        const idle = await underState(page, {});

        expect(idle.row).toBe('flex');
        expect(idle.extensionButton).not.toBe('none');
        // A zero-width row would make every "not hidden" assertion below vacuously true.
        expect(idle.rowWidth, 'the fixture collapsed the row — nothing below would prove anything').toBeGreaterThan(0);
        expect(idle.sendBut).not.toBe('none');
    });

    test('🔴 an extension holding the input lock does NOT hide the message actions', async ({ page }) => {
        await page.goto(makePage());
        // Exactly the state `ctx.deactivateSendButtons()` leaves behind: an extension blocking chat
        // while it summarizes in the background, and the state a stale lock is stuck in forever.
        const locked = await underState(page, { generating: 'true' });

        expect(locked.row).toBe('flex');
        expect(locked.extra).not.toBe('none');
        expect(locked.extensionButton).not.toBe('none');
        expect(locked.reasoning).not.toBe('none');
        expect(locked.rowWidth).toBeGreaterThan(0);
    });

    test('…but it still locks the input, which is what that flag is for', async ({ page }) => {
        await page.goto(makePage());
        const locked = await underState(page, { generating: 'true' });

        expect(locked.sendBut).toBe('none');
        expect(locked.continueBut).toBe('none');
        expect(locked.impersonate).toBe('none');
    });

    test('a reply actually being written into the last message DOES hide its actions', async ({ page }) => {
        await page.goto(makePage());
        // Generate() sets both: the input lock and the message-scoped flag.
        const generating = await underState(page, { generating: 'true', generatingMessage: 'true' });

        expect(generating.row).toBe('none');
        expect(generating.reasoning).toBe('none');
        expect(generating.sendBut).toBe('none');
    });

    test('the message flag alone is enough to hide the row', async ({ page }) => {
        await page.goto(makePage());
        const generating = await underState(page, { generatingMessage: 'true' });

        expect(generating.row).toBe('none');
        expect(generating.reasoning).toBe('none');
    });

    test('a swipe still hides the row — there the animation owns it', async ({ page }) => {
        await page.goto(makePage());
        const swiping = await underState(page, { swiping: 'true' });

        expect(swiping.row).toBe('none');
        expect(swiping.reasoning).toBe('none');
        expect(swiping.sendBut).toBe('none');
    });

    test('only the LAST message is ever hidden — earlier ones keep their actions throughout', async ({ page }) => {
        await page.goto(makePage());
        const earlier = await page.evaluate(async () => {
            await document.fonts.ready;
            const out = {};
            for (const state of ['generating', 'generatingMessage', 'swiping']) {
                for (const key of ['generating', 'generatingMessage', 'swiping']) delete document.body.dataset[key];
                document.body.dataset[state] = 'true';
                out[state] = getComputedStyle(document.querySelector('#chat .mes[mesid="0"] .mes_buttons')).display;
            }
            return out;
        });

        expect(earlier).toEqual({ generating: 'flex', generatingMessage: 'flex', swiping: 'flex' });
    });
});

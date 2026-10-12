/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 WHAT THIS GUARDS. The Quick Reply set color picker fires `change` for its own programmatic
 * assignments, and the settings drawer makes two of them -- once when it is built, and again on every
 * set switch via `onQrSetChange()`. Upstream swallowed the first with a one-shot `initialColorChange`
 * flag; `prepareQrEditor()` re-runs on every `rerender()`, so the flag was reset while the previous
 * element's listener stayed live with its own flag already spent.
 *
 * The consequence was a write nobody asked for: merely loading the page saved the selected set with
 * `rgba(0, 0, 0, 0)` written over its `transparent`. Since `updateColor()` tests `!= 'transparent'`, a
 * set the user never colored came back marked as colored. It was found while instrumenting the import
 * race in `quick-reply-import-replace.e2e.js` -- the same stray write, aimed at whichever object
 * `currentQrSet` was holding.
 *
 * ⚠️ The change event is dispatched directly rather than by driving the widget. `#qr--color` is a
 * third-party web component, so clicking through its shadow DOM would test the component; what is under
 * test is the handler's contract with it, which is `evt.detail.rgb`. The programmatic-echo case is
 * reproduced honestly, by loading the page and letting the real assignment happen.
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** A v2 Quick Reply set with one button, at a given color. */
function qrSet(name, color) {
    return {
        version: 2,
        name,
        disableSend: false,
        placeBeforeInput: false,
        injectInput: false,
        color,
        onlyBorderColor: false,
        idIndex: 2,
        qrList: [{
            id: 1, icon: '', showLabel: false, label: 'B', title: '', message: '/echo hi',
            contextList: [], preventAutoExecute: true, isHidden: false, executeOnStartup: false,
            executeOnUser: false, executeOnAi: false, executeOnChatChange: false,
            executeOnGroupMemberDraft: false, executeOnNewChat: false, executeBeforeGeneration: false,
            automationId: '',
        }],
    };
}

test.describe('Quick Reply set color is written only when it changes', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let setDirectory;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('qr-set-color-e2e');
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
        setDirectory = path.join(dataRoot, 'default-user', 'QuickReplies');
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    /** Seed two sets — one uncolored, one colored — and open a page that loads them. */
    async function seedAndOpen(page) {
        fs.mkdirSync(setDirectory, { recursive: true });
        fs.writeFileSync(path.join(setDirectory, 'Alpha.json'), JSON.stringify(qrSet('Alpha', 'transparent'), null, 4), 'utf-8');
        fs.writeFileSync(path.join(setDirectory, 'Beta.json'), JSON.stringify(qrSet('Beta', 'rgba(255, 0, 0, 1)'), null, 4), 'utf-8');

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#qr--color')).toBeAttached({ timeout: 30_000 });
        await expect.poll(async () => page.evaluate(async () => {
            const { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
            return QuickReplySet.list.map(it => it.name);
        }), { timeout: 30_000 }).toContain('Alpha');
    }

    /** The color the set carries on disk — what a reload would read. */
    function storedColor(name) {
        return JSON.parse(fs.readFileSync(path.join(setDirectory, `${name}.json`), 'utf-8')).color;
    }

    /** Hand the handler a color the way the picker does. */
    function pick(page, rgb) {
        return page.evaluate((rgb) => {
            document.querySelector('#qr--color').dispatchEvent(new CustomEvent('change', { detail: { rgb } }));
        }, rgb);
    }

    test('🔴 loading the page does not rewrite a set that has no color', async ({ page }) => {
        await seedAndOpen(page);

        // The drawer assigns the picker its starting value, the picker echoes a `change` back, and the
        // handler used to treat that echo as the user choosing `rgba(0, 0, 0, 0)`. `save()` is debounced
        // 200 ms; wait past it so a write would have landed.
        await page.waitForTimeout(2_000);
        expect(storedColor('Alpha'), 'a set the user never colored was rewritten on load').toBe('transparent');
        expect(storedColor('Beta')).toBe('rgba(255, 0, 0, 1)');
    });

    test('choosing a color still saves it', async ({ page }) => {
        await seedAndOpen(page);
        await pick(page, 'rgba(0, 0, 255, 1)');

        // The guard must not be so broad that it swallows the real thing it exists to allow.
        await expect.poll(() => storedColor('Alpha'), { timeout: 15_000 }).toBe('rgba(0, 0, 255, 1)');
    });

    test('clearing a color stores transparent, not a transparent-looking rgba', async ({ page }) => {
        await seedAndOpen(page);
        await pick(page, 'rgba(0, 0, 255, 1)');
        await expect.poll(() => storedColor('Alpha'), { timeout: 15_000 }).toBe('rgba(0, 0, 255, 1)');

        // ⚠️ `dispatchEvent`, not `click`: the QR settings live inside a collapsed inline drawer, so the
        // button is attached but not visible and a real click waits out its timeout. What is under test
        // is the handler, exactly as with the synthetic `change` above.
        await page.locator('#qr--colorClear').dispatchEvent('click');

        // `updateColor()` decides "is this set colored?" with `!= 'transparent'`, so storing
        // `rgba(0, 0, 0, 0)` here would leave the set flagged as colored forever. Clear has to mean
        // uncolored, and the model has to say so rather than waiting for the picker to echo it back.
        await expect.poll(() => storedColor('Alpha'), { timeout: 15_000 }).toBe('transparent');
        expect(await page.evaluate(async () => {
            const { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
            return QuickReplySet.get('Alpha').color;
        })).toBe('transparent');
    });

    test('re-picking the color a set already has writes nothing', async ({ page }) => {
        await seedAndOpen(page);
        const writes = [];
        page.on('request', r => {
            if (r.url().includes('/api/quick-replies/save')) writes.push(JSON.parse(r.postData()).name);
        });

        await pick(page, 'transparent');
        await pick(page, 'rgba(0, 0, 0, 0)');
        await page.waitForTimeout(2_000);

        // Both spellings mean the same color as the stored `transparent`. Comparing the strings alone
        // would treat every one of these as a change, which is the bug in its original form.
        expect(writes).toEqual([]);
    });
});

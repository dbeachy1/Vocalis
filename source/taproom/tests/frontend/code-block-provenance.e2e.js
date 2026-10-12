/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `globalThis` and dynamic `import()` of the app's own modules. Lint sees one file and cannot tell the
//   two contexts apart.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/**
 * 🔴 A REPLY THAT OPENS WITH AN INDENT MUST NOT RENDER AS CODE, AND THE THRESHOLD IS EXACTLY FOUR.
 *
 * Upstream never had to think about this. `trim_spaces` trims the model's reply at STORE time
 * (`script.js:7416`), so a stray indent never survived to reach the renderer. This fork ships that flag
 * OFF, because trimming before storing makes the next prompt differ from what the backend generated and
 * costs a full reprocess every turn. Turning it off brought back the thing it had been incidentally suppressing.
 *
 * The test covers both sides of the four-space boundary: three leading spaces remain prose, while four
 * render as a code block. This catches fixes that trim all indentation and break actual code blocks.
 *
 * These run against a booted server rather than in `MessageFormatter.e2e.js`, whose `testSetup.awaitST`
 * expects an instance already listening on the config's base URL.
 */
test.describe.configure({ mode: 'serial', timeout: 240_000 });

test.describe('leading whitespace in a reply is not a code block', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    let base = '';

    test.beforeAll(async () => {
        test.setTimeout(240_000);

        const scratch = makeScratchDirectory('code-block-provenance');
        const dataRoot = path.join(scratch, 'data');

        server = await startSillyTavern({ dataRoot, configPath: path.join(scratch, 'config.yaml') });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }

        base = `http://127.0.0.1:${server.port}`;
        await stepPastFirstRun(dataRoot);
    });

    test.afterAll(async () => {
        await server?.stop?.();
    });

    /**
     * @param {import('@playwright/test').Page} page The page
     * @returns {Promise<void>} When the app has settled enough to import from
     */
    async function openApp(page) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            try {
                return !!globalThis.SillyTavern?.getContext();
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });
    }

    /**
     * @param {import('@playwright/test').Page} page The page
     * @param {string} text The message text
     * @returns {Promise<string>} The rendered HTML
     */
    function render(page, text) {
        return page.evaluate(async (value) => {
            /** @type {any} */
            const script = await import('./script.js');
            return script.messageFormatting(value, 'Storyteller', false, false, 1);
        }, text);
    }

    test('🔴 four leading spaces render as prose, not as highlighted code', async ({ page }) => {
        await openApp(page);

        const html = await render(page, '    Elise climbed up onto the balcony rail.');

        expect(html).not.toContain('<pre>');
        expect(html).not.toContain('<code');
        expect(html).toContain('Elise');
    });

    test('🔴 a leading tab renders as prose too', async ({ page }) => {
        await openApp(page);

        const html = await render(page, '\tTest Speaker felt a draught from the open door.');

        expect(html).not.toContain('<pre>');
        expect(html).not.toContain('<code');
        expect(html).toContain('Test Speaker');
    });

    test('three leading spaces were always fine, and still are', async ({ page }) => {
        await openApp(page);

        // The control. This is the message that rendered CORRECTLY on the live install, and it is what
        // established that the boundary is the markdown threshold rather than something intermittent.
        const html = await render(page, '   Elise climbed up onto the balcony rail.');

        expect(html).not.toContain('<pre>');
        expect(html).toContain('Elise');
    });

    test('🔴 a genuine fenced code block is still a code block', async ({ page }) => {
        await openApp(page);

        // The fix is `trimStart` and nothing more. A fence sits at column 0, so it is untouched — which is
        // the reason for trimming only the start rather than de-indenting every line.
        const html = await render(page, '```\nconst x = 1;\n```');

        expect(html).toContain('<code');
    });

    test('an indented block later in the message is still code, because only the start is trimmed', async ({ page }) => {
        await openApp(page);

        const html = await render(page, 'Here is the snippet:\n\n    const x = 1;\n');

        expect(html).toContain('<code');
    });
});

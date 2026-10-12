/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `globalThis` and dynamic `import()` of the app's own modules. Lint sees one file and cannot tell the
//   two contexts apart.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/**
 * 🔴 THE HALF NODE CANNOT REACH: DOES THE BROWSER ACTUALLY SEND THE SHAPE?
 *
 * `tests/prompt-cache-geometry-wire.test.js` proves the server end — a shape header arrives, is validated,
 * and comes back out of `st.log` naming the part that changed. Every one of those assertions is satisfied by
 * a header this test suite typed itself. None of them can tell whether `Generate()` ever sets one.
 *
 * And that is exactly where this would fail quietly. `setPendingPromptShape` is called deep inside
 * `finishGenerating`, and the value is consumed by `getGenerationHeaders`, which lives in a different module
 * and is called from three more. An ordering mistake between those two — the header built before the shape
 * is stashed, a path that skips the stash, a stash cleared by an interleaved quiet generation — produces no
 * error anywhere. It produces a diagnostic that runs for months saying `no shape to compare`, on the one
 * install it was built for, while every unit test stays green.
 *
 * So this drives a REAL generation in a REAL page and reads the header off the wire.
 *
 * ⚠️ THE BACKEND IS STUBBED AT THE BROWSER, NOT THE SERVER, so the request captured is byte-for-byte the one
 * SillyTavern would have posted to a model host — headers included, which is the whole subject here.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('the prompt shape reaches the wire', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    let base = '';

    test.beforeAll(async () => {
        test.setTimeout(180_000);

        const scratch = makeScratchDirectory('prompt-shape-e2e');
        const dataRoot = path.join(scratch, 'data');

        server = await startSillyTavern({ dataRoot, configPath: path.join(scratch, 'config.yaml') });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }

        base = `http://127.0.0.1:${server.port}`;

        // A fresh data root is a first run, and `getSettings()` ends at `doOnboarding()`, which waits for a
        // human that headless never sends.
        await stepPastFirstRun(dataRoot);
    });

    test.afterAll(async () => {
        await server?.stop?.();
    });

    /**
     * Open the shipped character and put the client on the text path with a stub backend.
     * @param {import('@playwright/test').Page} page Page under test
     * @returns {Promise<void>} When the client believes it is connected
     */
    async function ready(page) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

        // `getContext()` throws during early boot (a TDZ on script.js's module bindings), so the poll has to
        // swallow that and retry rather than reject.
        await page.waitForFunction(() => {
            try {
                return !!globalThis.SillyTavern?.getContext()?.characters?.length;
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });

        await page.evaluate(async () => {
            const context = globalThis.SillyTavern.getContext();
            await context.selectCharacterById(0);

            const script = await import('/script.js');
            const { textgenerationwebui_settings } = await import('/scripts/textgen-settings.js');

            // `page.route` answers the POST, so no model host is involved — but `Generate` refuses to send
            // while `online_status` is `no_connection`, which is the honest gate and not one to bypass.
            textgenerationwebui_settings.server_urls[textgenerationwebui_settings.type] = 'http://127.0.0.1:1/stub';
            textgenerationwebui_settings.streaming = false;

            script.changeMainAPI('textgenerationwebui');
            script.setOnlineStatus('stub-model');
        });
    }

    /**
     * Send a message and hand back the headers and body SillyTavern actually posted for it.
     *
     * ⚠️ FILTERED TO `normal`, AND THE FIRST RUN OF THIS SPEC IS WHY. A turn can put more than one request
     * on this route — the user's generation plus whatever background work the client kicks off around it —
     * and taking "the next POST" grabbed one of those instead: a 866-character history where the turn under
     * test had 4,929. The assertion then read as "the shape shrank", which is a real failure mode and was
     * not the one happening. `X-ST-Gen-Type` is on every generation request precisely so a consumer can
     * tell them apart, so it is used rather than assumed away.
     * @param {import('@playwright/test').Page} page Page under test
     * @param {string} text What the user types
     * @returns {Promise<{headers: Record<string, string>, body: any}>} The captured request
     */
    async function captureGeneration(page, text) {
        /** @type {Array<{headers: Record<string, string>, body: any}>} */
        const seen = [];
        const isUserTurn = (entry) => decodeURIComponent(entry.headers['x-st-gen-type'] ?? '') === 'normal';

        await page.route('**/api/backends/text-completions/generate**', async (route) => {
            seen.push({
                headers: route.request().headers(),
                body: JSON.parse(route.request().postData() ?? 'null'),
            });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ text: ' The shutters burst inward.' }] }),
            });
        });

        await page.locator('#send_textarea').fill(text);
        await page.locator('#send_but').click();

        await expect.poll(() => seen.some(isUserTurn), {
            timeout: 60_000,
            message: `SillyTavern posted no 'normal' text completion, so there is no header to read. Saw: ${seen.map(e => decodeURIComponent(e.headers['x-st-gen-type'] ?? '(none)')).join(', ') || 'nothing'}.`,
        }).toBe(true);

        await page.unroute('**/api/backends/text-completions/generate**');

        return /** @type {{headers: Record<string, string>, body: any}} */ (seen.find(isUserTurn));
    }

    /**
     * The assertion that makes every other one mean something: this header describes THIS prompt.
     *
     * A header full of plausible numbers that do not describe the prompt it rode with is worse than no
     * header — the server would place a divergence in the wrong region and hand whoever is chasing a cold
     * turn a confident number pointing at the wrong part of the prompt.
     * @param {{headers: Record<string, string>, body: any}} captured A captured generation request
     * @returns {void}
     */
    function expectShapeDescribes(captured) {
        const shape = captured.headers['x-st-prompt-shape'];

        expect(shape, 'Generate() sent no X-ST-Prompt-Shape header.').toBeTruthy();

        // The same grammar `readIdentityHeaders` enforces. A shape that failed it would be dropped server
        // side and, again, silently.
        expect(shape).toMatch(/^v1(;[a-z]{1,12}=\d{1,12})+$/);

        const fields = new Map(shape.slice(3).split(';').map((pair) => {
            const [name, value] = pair.split('=');
            return [name, Number(value)];
        }));

        // `story`, `ex`, `hist` and `cont` are the four parts `getCombinedPrompt` joins, in that order.
        const layout = ['story', 'ex', 'hist', 'cont'].reduce((sum, name) => sum + (fields.get(name) ?? 0), 0);

        expect(typeof captured.body.prompt).toBe('string');
        expect(captured.body.prompt.length).toBeGreaterThan(0);

        // Not exact: the join is followed by a carriage-return strip and, when the user has it on, a newline
        // collapse. Both only ever shrink it, so the parts must cover the prompt and overshoot only slightly.
        expect(layout).toBeGreaterThanOrEqual(captured.body.prompt.length);
        expect(layout - captured.body.prompt.length).toBeLessThan(Math.max(64, captured.body.prompt.length * 0.02));

        // And the counts are real, not zeroes standing in for "did not measure".
        expect(fields.get('msgs')).toBeGreaterThan(0);

        // The message this generation will become. It is what lets a `st.log` line be matched to a message
        // in the UI, so it has to survive the wire, not merely be formatted correctly in a unit test.
        expect(Number.isFinite(fields.get('mesid')), 'Generate() sent no mesid.').toBe(true);
        expect(fields.get('mesid')).toBeGreaterThanOrEqual(0);
    }

    test('🔴 a real generation carries a shape header, and it describes the prompt that was sent', async ({ page }) => {
        await ready(page);

        const captured = await captureGeneration(page, 'And then?');

        // If the header is missing the diagnostic is dead on arrival: the server logs "no shape to compare"
        // for ever and nobody finds out, because nothing errors. Asserted here as well as inside the helper
        // so that the headline fact of this spec is visible in the file rather than one call away.
        expect(captured.headers['x-st-prompt-shape'], 'Generate() sent no X-ST-Prompt-Shape header.').toBeTruthy();

        expectShapeDescribes(captured);
    });

    test('🔴 the next generation gets its own shape, freshly computed rather than the last one left behind', async ({ page }) => {
        await ready(page);

        const first = await captureGeneration(page, 'Once more.');
        const second = await captureGeneration(page, 'And again.');

        // The stash is deliberately consume-once, so that a generation which did not go through `Generate()`
        // cannot inherit somebody else's shape. The failure mode of that design is the opposite one: a
        // second turn that sends nothing because the first emptied it and nothing refilled it.
        expect(first.headers['x-st-prompt-shape']).toBeTruthy();
        expect(second.headers['x-st-prompt-shape'], 'The second generation sent no shape — the stash was consumed and never refilled.').toBeTruthy();

        // ⚠️ NOT "the history grew". An earlier draft asserted that and failed on a race in this harness
        // rather than on the product: the second click can land while the previous reply is still being
        // written into the chat, so the history legitimately reads smaller. Measuring each shape against
        // its OWN prompt is both race-free and a stronger statement — a stale copy of the first header
        // cannot describe the second prompt unless the two happen to be identical, which the last
        // assertion rules out.
        expectShapeDescribes(first);
        expectShapeDescribes(second);

        expect(second.body.prompt).not.toBe(first.body.prompt);
    });
});

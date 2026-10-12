/* eslint-env browser */
// ^ The callbacks handed to page.evaluate()/waitForFunction() run in the PAGE, not in Node, so they legitimately
//   reach for `document` and `globalThis`. Lint sees one file and cannot tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(path.dirname(here));
const FIXTURE = path.join(serverDirectory, 'tests', 'fixtures', 'panel-interactive-plugin.mjs');

const PLUGINS_DIRECTORY = makeScratchDirectory('panel-actions-plugins');
const SHIM = path.join(PLUGINS_DIRECTORY, 'zz-panel-actions-e2e.mjs');

/**
 * 🔴 THE ONLY COVERAGE THE HOST HALF OF `DESIGN_PLUGIN_PANEL_UI.md` HAS, AND IT CANNOT BE ANYWHERE ELSE.
 *
 * Regions and actions are DOM manipulation in a browser: a click walked up to an action element, a fetch, a
 * sanitize, an `outerHTML` swap, focus put back. Nothing about that is visible to a server-side test, and
 * capability 7's own build proved the point — the duplicate-DOM-id bug shipped green through the entire
 * server suite and was only ever found by driving a real page.
 *
 * The assertions here are chosen so that the plausible host defects FAIL rather than merely look different:
 *
 *  - A host that redraws the whole panel on every action passes "the pager changed" and fails "the header
 *    did not". Every partial route returns exactly one region for that reason.
 *  - A host that builds the action URL from the fragment instead of the registration passes everything about
 *    rendering and fails the leading-slash refusal.
 *  - A host that forwards the avatar header into the query passes every visible test. So the assertion is a
 *    negative one, read back off the server.
 *
 * ⚠️ THIS SUITE BOOTS ITS OWN SERVER, because it needs a plugin installed — and steps past onboarding, or
 * `firstLoadInit` blocks on a form no headless browser will ever fill in.
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

test.describe('interactive plugin panels (front-end)', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('panel-actions-e2e');
        fs.writeFileSync(SHIM, `export { info, init } from ${JSON.stringify(new URL(`file:///${FIXTURE.split(path.sep).join('/')}`).href)};\n`, 'utf-8');

        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'panel-interactive',
            },
        });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        await stepPastFirstRun(path.join(scratch, 'data'));
    });

    test.afterAll(async () => {
        if (server) await server.stop();
        if (fs.existsSync(SHIM)) fs.unlinkSync(SHIM);
    });

    /** Load the page and open the panel, leaving a fresh popup on screen for each test. */
    test.beforeEach(async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#pluginPanelButtons > .pluginPanelButton').first()).toBeAttached({ timeout: 30_000 });
        await page.locator('#pluginPanelButtons > .pluginPanelButton').first().click();
        await expect(page.locator('.popup-content.pluginPanel #probe-header')).toBeVisible({ timeout: 15_000 });
    });

    test('the probe ran at all — the panel opened with its regions intact', async ({ page }) => {
        // Otherwise every assertion below is vacuous: they all describe changes to a panel that must exist first.
        await expect(page.locator('#probe-header')).toHaveText('header v1');
        await expect(page.locator('#probe-row-1')).toBeVisible();
        await expect(page.locator('#probe-pager')).toBeVisible();
    });

    test('🔴 an action replaces ONLY its named region', async ({ page }) => {
        // The whole point of §5. A host that swapped the panel would still show "pager v2" and would fail the
        // second half — which is why /bump returns the pager alone.
        await page.locator('#probe-page').click();

        await expect(page.locator('#probe-pager')).toHaveText('pager v2');
        await expect(page.locator('#probe-header')).toHaveText('header v1');
        await expect(page.locator('#probe-row-1')).toBeVisible();
    });

    test('🔴 the request goes to the plugin\'s OWN mount, with ambient context', async ({ page }) => {
        await page.locator('#probe-page').click();
        await expect(page.locator('#probe-pager')).toHaveText('pager v2');

        const seen = await page.evaluate(async () => (await fetch('/api/plugins/panel-interactive/seen')).json());

        // The fragment's own parameter survives...
        expect(seen.query.offset).toBe('40');
        // ...alongside the context the host owns. `tz` is what makes a plugin able to render a local date.
        expect(typeof seen.query.tz).toBe('string');
        expect(seen.query.tz.length).toBeGreaterThan(0);
    });

    test('🔴 API v7: an action carries the text-completion connection, and only on text completion', async ({ page }) => {
        // `context.generate()` from a panel action must work with no generation behind it — a rescan clicked
        // right after a restart. The host sends the connection; the server captures it. A fresh user is on
        // Horde, which `generate()` cannot drive, so nothing is sent there — the panel open in `beforeEach` is
        // the last request the fixture recorded.
        const onHorde = await page.evaluate(async () => (await fetch('/api/plugins/panel-interactive/seen')).json());
        expect(onHorde.connection).toBeNull();

        // Switch to text completion the way a user does, then act. (One click only: the action replaces the
        // pager region, and the button with it.)
        await page.evaluate(() => {
            const select = /** @type {HTMLSelectElement} */ (document.getElementById('main_api'));
            select.value = 'textgenerationwebui';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('#probe-page').click();

        await expect.poll(async () => (await page.evaluate(async () => (await fetch('/api/plugins/panel-interactive/seen')).json())).connection, { timeout: 10_000 }).not.toBeNull();
        const onText = await page.evaluate(async () => (await fetch('/api/plugins/panel-interactive/seen')).json());
        const connection = JSON.parse(decodeURIComponent(onText.connection));

        expect(typeof connection.api_type).toBe('string');
        expect(connection.api_type.length).toBeGreaterThan(0);
        expect(typeof connection.api_server).toBe('string');
        expect(onText.envelope).toBe(true);
    });

    test('the persona axis arrives, and the character key never travels in the query', async ({ page }) => {
        // ⚠️ `personaId` IS an avatar filename, and that is correct rather than a leak — §22.7: a persona
        // avatar is named `${Date.now()}.png` and there is no rename endpoint for one, so the filename is the
        // identity. It is `charAvatar` that must never appear, because a CHARACTER's filename is renameable
        // and is exactly the handle §22 exists to abolish.
        //
        // 🔴 The strong form of that negative lives in `plugin-panel-identity.test.js`, where the map and the
        // header can both be controlled. Here there is no character selected, so this asserts the shape of
        // the contract rather than the resolution: the host sends persona directly and character never here.
        await page.locator('#probe-page').click();
        await expect(page.locator('#probe-pager')).toHaveText('pager v2');

        const seen = await page.evaluate(async () => (await fetch('/api/plugins/panel-interactive/seen')).json());

        expect(seen.query.charAvatar).toBeUndefined();
        expect(typeof seen.query.personaId).toBe('string');
        expect(seen.query.personaId.length).toBeGreaterThan(0);
    });

    test('data-panel-remove deletes a region, and a sibling in the same response updates', async ({ page }) => {
        await page.locator('#probe-remove').click();

        await expect(page.locator('#probe-row-1')).toHaveCount(0);
        await expect(page.locator('#probe-row-2')).toBeVisible();
        await expect(page.locator('#probe-header')).toHaveText('header v2');
    });

    test('the root region replaces the whole panel body', async ({ page }) => {
        await page.locator('#probe-whole').click();

        await expect(page.locator('#probe-redrawn')).toBeVisible();
        await expect(page.locator('#probe-header')).toHaveCount(0);
    });

    test('a region that is not on screen is ignored, and nothing else changes', async ({ page }) => {
        // §5.2: a stale click is ordinary. The failure this guards against is a host that treats an unmatched
        // region as an error and shows the user a scary message about their own timing.
        await page.locator('#probe-ghost').click();
        await page.waitForTimeout(300);

        await expect(page.locator('#probe-header')).toHaveText('header v1');
        await expect(page.locator('#probe-error')).toHaveText('');
        await expect(page.locator('text=should not appear')).toHaveCount(0);
    });

    test('🔴 a failed action renders into the error region, never in silence', async ({ page }) => {
        await page.locator('#probe-boom').click();

        await expect(page.locator('#probe-error')).toContainText('500');
        // And the panel is still usable afterwards — a failure must not wedge the host's pending flag.
        await page.locator('#probe-page').click();
        await expect(page.locator('#probe-pager')).toHaveText('pager v2');
    });

    test('🔴 an action path without a leading slash makes NO request at all', async ({ page }) => {
        // §6.2. The host builds the URL from the registration, so a malformed path must be refused BEFORE the
        // fetch rather than concatenated into something odd.
        //
        // 🔴 WATCH THE NETWORK, NOT THE PLUGIN'S HIT COUNTER. Counting requests that reached the router is
        // the obvious test and it is vacuous: with the guard removed the host builds
        // `/api/plugins/panel-interactiveescape-the-mount`, which misses the mount, so the plugin sees
        // nothing either way and the test passes over the bug. Caught by mutation, fixed by asserting on what
        // the browser actually sent.
        const attempted = [];
        page.on('request', request => attempted.push(request.url()));

        await page.locator('#probe-escape').click();
        await page.waitForTimeout(300);

        expect(attempted.filter(url => url.includes('escape-the-mount'))).toEqual([]);
    });

    test('🔴 focus and the caret survive a swap', async ({ page }) => {
        // §7.5, and the reason inline editing is usable at all: without it the caret vanishes the moment the
        // region under it redraws.
        //
        // 🔴 DRIVEN FROM THE KEYBOARD, NOT A CLICK, AND THAT IS THE ONLY WAY IT TESTS ANYTHING. Clicking a
        // button moves focus off the input before the action even fires, so there is nothing to preserve and
        // a host that had no preservation at all would pass. Pressing the bound key leaves focus in the box
        // while the response replaces it.
        await page.locator('#probe-input').click();
        await page.locator('#probe-input').evaluate((el) => /** @type {any} */ (el).setSelectionRange(3, 3));

        await page.keyboard.press('PageDown');
        await expect(page.locator('#probe-pager')).toHaveText('pager v2');

        const state = await page.evaluate(() => ({
            focused: document.activeElement?.id,
            start: /** @type {any} */ (document.activeElement)?.selectionStart,
        }));

        expect(state.focused).toBe('probe-input');
        expect(state.start).toBe(3);
    });

    test('data-panel-form sends the input\'s CURRENT value, not the rendered one', async ({ page }) => {
        // A host that read the `value` attribute out of the markup instead of the live property would send
        // "initial" for ever, and every edit would silently save the old text.
        await page.locator('#probe-input').fill('typed just now');
        await page.locator('#probe-save').click();

        await expect(page.locator('#probe-echo')).toHaveText('typed just now');
    });

    test('🔴 a form body is sent as form-urlencoded, not as the default JSON content type', async ({ page }) => {
        // `getRequestHeaders()` hardcodes `Content-Type: application/json`, and the server runs
        // `bodyParser.json` — so a form-encoded body announced as JSON is rejected with a 400 before any
        // plugin handler runs. The host therefore asks for `omitContentType` and sets the real one.
        //
        // Pinned because the failure is total (every save 400s), the cause is three files away from the
        // symptom, and a well-meaning "just use getRequestHeaders()" cleanup would reintroduce it.
        const posts = [];
        page.on('request', request => {
            if (request.method() === 'POST' && request.url().includes('/echo')) {
                posts.push({ type: request.headers()['content-type'], body: request.postData() });
            }
        });

        await page.locator('#probe-input').fill('over the wire');
        await page.locator('#probe-save').click();
        await expect(page.locator('#probe-echo')).toHaveText('over the wire');

        expect(posts).toHaveLength(1);
        expect(posts[0].type).toContain('application/x-www-form-urlencoded');
        expect(posts[0].body).toContain('text=over+the+wire');
    });

    test('🔴 a second activation during a pending action is ignored', async ({ page }) => {
        // §7.3. The failure mode is specific and bad: a double-tap on delete removing two rows.
        //
        // 🔴 DRIVEN FROM THE KEYBOARD, BECAUSE A SECOND *CLICK* PROVES NOTHING. `.pluginPanel-pending` sets
        // `pointer-events: none`, so the CSS swallows a second click whether or not the host guards against
        // one — the first version of this test passed with the guard deleted. A key reaches the handler
        // regardless of pointer-events, so it is the only activation that actually asks the question.
        const attempted = [];
        page.on('request', request => {
            if (request.url().includes('/slow')) attempted.push(request.url());
        });

        await page.locator('#probe-slow').focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('Space');

        await expect(page.locator('#probe-header')).toHaveText('slow done', { timeout: 10_000 });
        // Long enough that a second request the host wrongly allowed has certainly been sent by now.
        await page.waitForTimeout(600);

        expect(attempted).toHaveLength(1);
    });

    test('a key bound with data-panel-key fires its action', async ({ page }) => {
        await page.keyboard.press('PageDown');

        await expect(page.locator('#probe-pager')).toHaveText('pager v2');
    });

    test('a key the panel did NOT bind is left alone', async ({ page }) => {
        // The fixture binds PageDown only. PageUp must reach the page behind the popup rather than being
        // swallowed by a host that grabbed every navigation key it knew about.
        await page.keyboard.press('PageUp');
        await page.waitForTimeout(200);

        await expect(page.locator('#probe-pager')).toContainText('older');
    });
});

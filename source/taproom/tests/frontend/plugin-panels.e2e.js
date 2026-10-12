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
const FIXTURE = path.join(serverDirectory, 'tests', 'fixtures', 'panel-plugin.mjs');

/**
 * 🔴 THE SHIM GOES IN SCRATCH, AND THE SERVER IS TOLD TO LOOK THERE — see the same block in
 * `plugin-text-path.e2e.js`, which had this identical defect. Writing the shim into the repository's real
 * `plugins/` while booting without a `pluginsPath` means the server looks in `<dataRoot>/no-plugins-installed`
 * and never loads it, so the panel never registers and every assertion below times out waiting for a button
 * that was never going to appear.
 */
const PLUGINS_DIRECTORY = makeScratchDirectory('panels-plugins');
const SHIM = path.join(PLUGINS_DIRECTORY, 'zz-panel-probe-e2e.mjs');

/**
 * 🔴 THE ONLY COVERAGE THE FRONT-END HALF OF §14 HAS.
 *
 * Everything else asserted for plugin panels is server-side — the registry, validation, ordering, URL
 * resolution. None of it can see whether a user ends up with a BUTTON, which is the entire capability. Two
 * things here were real defects that the server suite passed straight over:
 *
 * 1. **Duplicate DOM ids.** One plugin may register several panels; the id was built from the plugin id
 *    alone, so two buttons shared one id and only the first was ever findable. The second's status light was
 *    permanently dead while everything else about it worked.
 * 2. **The DOMPurify claim in §14.5 was untested.** A renderer that skipped sanitizing would have shipped
 *    green.
 *
 * ⚠️ THIS SUITE BOOTS ITS OWN SERVER rather than using the shared :8000 baseURL, because it needs a plugin
 * installed. It also has to step past onboarding — see the note in `beforeAll`.
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

/**
 * Switch the main API the way the select's own `change` handler sees it.
 *
 * ⚠️ NOT `page.selectOption`. `#main_api` lives in the API connections drawer, which is closed on load, and
 * `selectOption` waits for the element to be visible — so this test waited out its full 180s budget on every
 * run and failed on a timeout that said nothing about panels. What the test is about is the host's reaction to
 * the API changing, not the drawer, so the value is set and `change` fired directly.
 * @param {import('@playwright/test').Page} page The page
 * @param {string} api The `main_api` value to select
 * @returns {Promise<void>}
 */
async function selectMainApi(page, api) {
    await page.evaluate((value) => {
        const select = /** @type {HTMLSelectElement} */ (document.getElementById('main_api'));
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }, api);
}

test.describe('plugin UI panels (front-end)', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('panels-e2e');
        fs.writeFileSync(SHIM, `export { info, init } from ${JSON.stringify(new URL(`file:///${FIXTURE.split(path.sep).join('/')}`).href)};\n`, 'utf-8');

        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                // Only OUR fixtures register. Jest runs suites in parallel and plugins/ is shared and not
                // configurable, so another suite's shim may be on disk while this server boots (fixture-gate.mjs).
                ST_FIXTURE_IDS: 'panel-probe',
                ST_PLUGIN_JOURNAL: path.join(scratch, 'journal.txt'),
            },
        });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        // 🔴 STEP PAST ONBOARDING, OR NOTHING BELOW RUNS. A fresh data root is a FIRST RUN, and `getSettings()`
        // ends with `await doOnboarding(...)`, which waits for a human to fill in a form. Headless never does,
        // so `firstLoadInit` blocks there and no late init — including the panel host — ever happens. That is
        // correct product behaviour, not a bug: a harness that boots a virgin data root has to clear it.
        await stepPastFirstRun(path.join(scratch, 'data'));
    });

    test.afterAll(async () => {
        // Unlinked in the same hook that installed it — the §12.7 lesson about a leaked registration.
        if (server) await server.stop();
        if (fs.existsSync(SHIM)) fs.unlinkSync(SHIM);
    });

    test.beforeEach(async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        // The host renders after its own fetch, so wait on the buttons rather than on a load state.
        await expect(page.locator('#pluginPanelButtons > .pluginPanelButton').first()).toBeAttached({ timeout: 30_000 });
    });

    /**
     * 🔴 ONE DROPPED REQUEST AT STARTUP MUST NOT COST THE BUTTONS FOR THE WHOLE SESSION.
     *
     * The host learns which panels exist from `/api/plugins/client-config`, once. A request that failed
     * answers `{}` — the same as a server with no plugins — and the host used to stop there for good, so the
     * buttons stayed missing until a reload (2026-10-10). It asks again when a chat is opened.
     */
    test('🔴 a startup config request that fails is asked again when a chat opens, and the buttons arrive', async ({ page }) => {
        let requests = 0;

        await page.route('**/api/plugins/client-config', async (route) => {
            requests += 1;

            if (requests === 1) {
                await route.abort();
                return;
            }

            await route.continue();
        });

        // `beforeEach` already loaded the page with a working request; load it again with the first one failing.
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            try {
                return !!globalThis.SillyTavern?.getContext()?.characters?.length;
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });

        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().selectCharacterById(0);
        });

        await expect(page.locator('#pluginPanelButtons > .pluginPanelButton').first()).toBeAttached({ timeout: 30_000 });
        expect(requests).toBeGreaterThan(1);
    });

    test('a server plugin gets a button, one per registration, in registration order', async ({ page }) => {
        const labels = await page.$$eval('#pluginPanelButtons > .pluginPanelButton',
            els => els.map(el => el.getAttribute('aria-label')));

        expect(labels).toEqual(['First Panel', 'Second Panel', 'Status Presentation Panel']);
    });

    test('every button has a UNIQUE dom id, even when one plugin registers several', async ({ page }) => {
        // 🔴 THE REGRESSION. `panel.id` is the PLUGIN's id, and this fixture registers several panels from one
        // plugin. Built from the plugin id alone, the buttons shared an id, `getElementById` only ever found
        // the first, and the second's light never updated. Invalid HTML that looked like working code.
        const ids = await page.$$eval('#pluginPanelButtons > .pluginPanelButton', els => els.map(el => el.id));

        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(3);
    });

    test('an emoji renders as text and ignores iconColor; a FontAwesome icon takes it', async ({ page }) => {
        const [emoji, glyph] = await page.$$eval('#pluginPanelButtons > .pluginPanelButton',
            els => els.map(el => ({ text: el.textContent, classes: el.className, color: el.style.color })));

        expect(emoji.text).toBe('🧠');
        // The fixture registers iconColor on BOTH; an emoji's colour lives in the font, so it must be ignored.
        expect(emoji.color).toBe('');

        expect(glyph.classes).toContain('fa-solid');
        expect(glyph.classes).toContain('fa-brain');
        expect(glyph.color).toBe('rgb(200, 162, 255)');
    });

    test('the current API mode immediately changes status presentation without a generation', async ({ page }) => {
        const button = page.locator('#pluginPanelButtons > .pluginPanelButton').nth(2);

        await selectMainApi(page, 'textgenerationwebui');
        await expect.poll(async () => button.evaluate(el => ({
            disabled: el.getAttribute('aria-disabled'),
            color: el.style.color,
            cursor: getComputedStyle(el).cursor,
            title: el.title,
        }))).toEqual({
            disabled: null,
            color: 'rgb(255, 255, 255)',
            cursor: 'pointer',
            title: 'registered fallback tooltip',
        });

        // The intentionally slower chat response must not repaint after the newer text response.
        await selectMainApi(page, 'openai');
        await selectMainApi(page, 'textgenerationwebui');
        // Deliberately cross the fixture's 150 ms response inversion; condition polling would pass before the
        // obsolete response arrived and would not exercise the race this assertion exists to catch.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(300);
        await expect(button).not.toHaveAttribute('aria-disabled');

        await selectMainApi(page, 'openai');

        await expect.poll(async () => button.evaluate(el => ({
            active: el.classList.contains('pluginPanelButton--active'),
            disabled: el.getAttribute('aria-disabled'),
            color: el.style.color,
            cursor: getComputedStyle(el).cursor,
            title: el.title,
        }))).toEqual({
            active: false,
            disabled: 'true',
            color: 'rgb(85, 91, 99)',
            cursor: 'default',
            title: 'disabled while structured work mode is active',
        });

        await button.click();
        await button.dispatchEvent('keydown', { key: 'Enter' });
        await button.dispatchEvent('keydown', { key: ' ' });
        await expect(page.locator('#probe-fragment')).toHaveCount(0);

        await selectMainApi(page, 'textgenerationwebui');
        await expect(button).not.toHaveAttribute('aria-disabled');
        await expect(button).toHaveAttribute('tabindex', '0');
        await button.click();
        await expect(page.locator('#probe-fragment')).toHaveCount(1);
    });

    test('🔔 §26: a PUSHED notification repaints the button, and does not disturb one that got none', async ({ page }) => {
        // 🔴 THE END-TO-END CLAIM OF CAPABILITY 18. Every other test here is about what a plugin REGISTERED;
        // this is the only one about what a plugin SAID later. The colour raised by /raise is deliberately
        // neither registered iconColor, so the assertion cannot pass on a registered colour left untouched.
        const before = await page.$$eval('#pluginPanelButtons > .pluginPanelButton', els => els.map(el => el.style.color));

        expect(before[1]).toBe('rgb(200, 162, 255)');

        // A GET, so no CSRF token is needed — the fork's protection is on state-changing verbs.
        await page.evaluate(async () => {
            await fetch('/api/plugins/panel-probe/raise');
        });

        // A reload is the honest trigger: `initPluginPanels` runs `refreshAllStatuses`, which is exactly the
        // path a real page takes. Driving the internal function directly would test a function rather than the
        // wiring, and the wiring is what broke.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#pluginPanelButtons > .pluginPanelButton').first()).toBeAttached({ timeout: 30_000 });

        await expect.poll(
            async () => (await page.$$eval('#pluginPanelButtons > .pluginPanelButton', els => els.map(el => el.style.color)))[1],
            { timeout: 15_000 },
        ).toBe('rgb(0, 128, 0)');

        const after = await page.$$eval('#pluginPanelButtons > .pluginPanelButton',
            els => els.map(el => ({ color: el.style.color, count: el.dataset.count, title: el.title })));

        // The pushed count and summary ride along with the colour.
        expect(after[1].count).toBe('9');
        expect(after[1].title).toBe('the probe notified');

        // ⚠️ THE CONTROL, and it is the regression this capability already caused once. The emoji button gets
        // no colour — an emoji's colour is in the font — and a notification must not change that. The first
        // version of the client cleared every button's colour on refresh, which silently wiped the REGISTERED
        // colour of the glyph button on every page load.
        expect(after[0].color).toBe('');
    });

    test('🎨 §26: the pushed colour SURVIVES THE CASCADE, and lands on a button that is actually visible', async ({ page }) => {
        // 🔴 THE PIXEL HALF, AND WHY THE TEST ABOVE DOES NOT COVER IT. Every other colour assertion in this
        // file reads `el.style.color` — the inline attribute the client WROTE. That is a claim about
        // JavaScript, not about what a user sees. A single stylesheet rule carrying `!important` on
        // `.pluginPanelButton`, a theme that repaints descendants, or an ancestor rule of higher specificity
        // all beat an inline style, and every assertion above keeps passing while the button never changes
        // colour on screen. `getComputedStyle` is what the browser actually resolved after the cascade, which
        // is the only version of this claim a user could verify.
        //
        // Mnemosyne's install-level gate cannot reach this either: it asserts that `color: 'purple'` is
        // dispatched to a button whose icon CAN wear a colour, and then stops at the network boundary. Server
        // proves it was sent; this proves it was painted.
        const buttons = page.locator('#pluginPanelButtons > .pluginPanelButton');

        await page.evaluate(async () => {
            await fetch('/api/plugins/panel-probe/raise');
        });

        // Same honest trigger as the test above: a reload runs `initPluginPanels` → `refreshAllStatuses`,
        // the real page's path, rather than poking the client's internals.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(buttons.first()).toBeAttached({ timeout: 30_000 });

        await expect.poll(
            async () => buttons.nth(1).evaluate(el => getComputedStyle(el).color),
            { timeout: 15_000 },
        ).toBe('rgb(0, 128, 0)');

        // A colour nobody can see is not a notification. A computed colour reads back perfectly well off an
        // element that is `display:none`, zero-sized, or behind `visibility:hidden`; this is the assertion
        // that says the thing wearing the colour is on screen.
        await expect(buttons.nth(1)).toBeVisible();

        // ⚠️ THE VACUITY GUARD, and it is not hypothetical: `getComputedStyle` ALWAYS returns some colour, so
        // if the ambient theme text colour happened to be this same green the poll above would pass without
        // the push having done anything at all. The emoji button is the control — it deliberately takes no
        // pushed colour, so it shows the ambient colour, and that must differ from the pushed green or this
        // test proves nothing. Change the fixture's raised colour to the theme default and this fires.
        const ambient = await buttons.nth(0).evaluate(el => getComputedStyle(el).color);
        expect(ambient).not.toBe('rgb(0, 128, 0)');
    });

    test('clicking shows the plugin\'s fragment, and its injected handler DOES NOT run', async ({ page }) => {
        await page.click('#pluginPanelButtons > .pluginPanelButton:first-child');
        await expect(page.locator('#probe-fragment')).toHaveText('panel body', { timeout: 15_000 });

        // 🔴 §14.5's whole claim, and the payload matters. The fragment carries
        // `<img src="x" onerror="window.PANEL_PROBE_RAN = true">` rather than a `<script>` tag, because a
        // script injected via innerHTML never runs anyway — a `<script>`-based probe passes whether or not
        // DOMPurify is called, and ours did exactly that until a mutation run exposed it. An onerror handler
        // DOES fire, so this genuinely distinguishes sanitized from unsanitized.
        // Mutation: drop the DOMPurify call in openPanel and this flips to true.
        //
        // Wait for the image to have SETTLED rather than for a fixed delay: DOMPurify keeps the <img> and
        // strips only the handler, so the element is there either way, and `complete` turns true once the load
        // has failed — which is precisely the moment an unsanitized `onerror` would have fired. Deterministic,
        // where a sleep would be a guess that goes flaky on a slow machine.
        await page.waitForFunction(() => {
            const img = document.querySelector('.popup img, #probe-fragment ~ img');
            return !img || img.complete;
        }, undefined, { timeout: 10_000 });

        expect(await page.evaluate(() => window.PANEL_PROBE_RAN === true)).toBe(false);
    });

    test('🔴 a <style> block in a fragment cannot restyle the host', async ({ page }) => {
        // THE DEFECT, and it was live. `style` sits in DOMPurify's default ALLOWED_TAGS, so the fragment's
        // `<style>#send_but { display: none !important }</style>` survived sanitizing verbatim — and the popup
        // is IN the document, so that rule applied to the whole page and hid SillyTavern's own send button
        // from a plugin panel. Nothing logged, 200 on the wire, green in every test that existed.
        //
        // Mutation: drop FORBID_TAGS from sanitizePanel and both assertions below flip.
        const sendButton = page.locator('#send_but');
        await expect(sendButton).toBeVisible();

        await page.click('#pluginPanelButtons > .pluginPanelButton:first-child');
        await expect(page.locator('#probe-fragment')).toHaveText('panel body', { timeout: 15_000 });

        // The tag is gone rather than merely inert -- an inert `<style>` is not a thing, so if it is in the
        // document at all it is applying.
        expect(await page.locator('.popup style').count()).toBe(0);

        // ⚠️ THE ASSERTION THAT MATTERS, and the one a `count()` check alone would not make: what the browser
        // actually resolved for an element the panel has no business touching. `!important` in the fixture
        // means a surviving rule beats anything the host's own stylesheet says, so this cannot pass by luck.
        await expect(sendButton).toBeVisible();
    });

    test('🎨 a registered stylesheet reaches the panel, and CANNOT reach past it', async ({ page }) => {
        const sendButton = page.locator('#send_but');
        await expect(sendButton).toBeVisible();

        await page.click('#pluginPanelButtons > .pluginPanelButton:first-child');
        await expect(page.locator('#probe-fragment')).toHaveText('panel body', { timeout: 15_000 });

        // Half one: the plugin's own CSS actually applied. Before `stylesheetPath` existed a plugin had no
        // channel for CSS at all, so every class it emitted matched nothing -- which is how Mnemosyne shipped
        // a month grid that rendered as one run-on line of digits, and a scope selector that gave the user no
        // clue which filter the list was under.
        await expect.poll(
            async () => page.locator('.probe-styled').evaluate(el => getComputedStyle(el).color),
            { timeout: 10_000 },
        ).toBe('rgb(1, 2, 3)');

        // 🔴 Half two, and the reason the host WRAPS rather than concatenates. The fixture's stylesheet also
        // carries `#send_but { display: none !important }` -- a plugin reaching straight past its panel at
        // SillyTavern's own chrome. `@scope (#pluginPanel-<id>)` leaves that selector matching nothing, so
        // §10.1's "a panel looks like part of the application" survives contact with a plugin that would
        // rather it did not. Remove the wrapper and this assertion is what fails.
        //
        // ⚠️ NOT a `:root { --SmartThemeBodyColor }` probe, which is the obvious choice and is VACUOUS: those
        // variables are set as inline styles on `documentElement` and beat any stylesheet rule, scoped or
        // not. That version of this test passed with the wrapper deliberately removed.
        await expect(sendButton).toBeVisible();

        // The scope root is on the container the client built, not somewhere a fragment could have named it.
        expect(await page.locator('#pluginPanel-panel-probe.pluginPanel').count()).toBe(1);
    });
});

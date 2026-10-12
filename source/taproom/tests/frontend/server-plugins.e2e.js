/* eslint-env browser */
// ^ The callbacks handed to page.evaluate()/waitForFunction() run in the PAGE, not in Node, so they legitimately
//   reach for `document` and `globalThis`. Lint sees one file and cannot tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';
import { LOCKED_TEXT } from '../fixtures/locked-settings-plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(path.dirname(here));
const FIXTURES = path.join(serverDirectory, 'tests', 'fixtures');

// 🔴 THE SHIMS GO IN SCRATCH, AND THE SERVER IS TOLD TO LOOK THERE. Writing into the repository's real
// `plugins/` while booting without a `pluginsPath` means the server looks somewhere else entirely and never
// loads them — every assertion then times out waiting for a section that was never going to appear.
const PLUGINS_DIRECTORY = makeScratchDirectory('server-plugins-plugins');

/** Each shim we wrote, so afterAll takes them out again — the §12.7 lesson about a leaked registration. */
const shims = [];

/**
 * Install a fixture as a shim the loader will pick up.
 * @param {string} fixture Base name of the fixture module
 * @param {string} name Base name for the installed shim
 * @returns {void}
 */
function installShim(fixture, name) {
    const source = path.join(FIXTURES, fixture);
    const target = path.join(PLUGINS_DIRECTORY, `${name}.mjs`);
    const specifier = new URL(`file:///${source.split(path.sep).join('/')}`).href;

    fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(specifier)};\n`, 'utf-8');
    shims.push(target);
}

/**
 * 🔴 THE ONLY COVERAGE THE FRONT-END HALF OF §28 HAS.
 *
 * The server suite (`tests/plugin-settings.test.js`) asserts the registry, the validation, the URL resolution
 * and the inventory. None of that can see whether a user ends up with a ROW they can read and a form they can
 * open, which is the entire capability. Three claims live only here:
 *
 * 1. **A broken plugin is VISIBLE.** The whole reason §28 is worth more than the settings feature that
 *    prompted it. Server-side, "the record exists" is all that can be proven.
 * 2. **The fragment is sanitized and scoped.** §14.5's DOMPurify pass and §10.3's `@scope` wrapper both apply
 *    to this second host, and a renderer that skipped either would ship green against the server suite.
 * 3. **A 503 renders the plugin's own words and NO FORM.** §28.5 — the one failure here that would cost a
 *    user their real configuration rather than their afternoon.
 */
// ⚠️ 180s, NOT PLAYWRIGHT'S 30s DEFAULT, BECAUSE `beforeAll` BOOTS A REAL SERVER — and `test.setTimeout()`
//    inside the hook is the other half of it, because `describe.configure({ timeout })` budgets the TESTS and
//    does nothing for a hook. See the long note in plugin-panels.e2e.js.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('server plugins in the Extensions dialog (front-end)', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('server-plugins-e2e');

        installShim('settings-plugin.mjs', 'zz-settings-probe-e2e');
        installShim('locked-settings-plugin.mjs', 'zz-locked-probe-e2e');
        installShim('broken-plugin.mjs', 'zz-broken-probe-e2e');
        installShim('query-plugin.mjs', 'zz-query-probe-e2e');

        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'settings-probe,locked-probe,broken-probe,query-probe',
                ST_PLUGIN_JOURNAL: path.join(scratch, 'journal.txt'),
            },
        });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        // 🔴 STEP PAST ONBOARDING, OR NOTHING BELOW RUNS. A fresh data root is a FIRST RUN and `getSettings()`
        // ends waiting for a human to fill in a form; headless never does, so no late init ever happens.
        await stepPastFirstRun(path.join(scratch, 'data'));
    });

    test.afterAll(async () => {
        if (server) await server.stop();
        for (const shim of shims) {
            if (fs.existsSync(shim)) fs.unlinkSync(shim);
        }
    });

    test.beforeEach(async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

        // The dialog lives behind the Extensions drawer. Opened by its toggle rather than by unhiding the
        // block, so the test exercises the route a user actually takes.
        await page.locator('#extensions-settings-button .drawer-toggle').click();
        await page.locator('#extensions_details').click();

        // The section is filled after its own fetch, so wait on a row rather than on the dialog.
        await expect(page.locator('.serverPlugins_info .serverPlugin_block').first()).toBeAttached({ timeout: 30_000 });
    });

    test('🔴 A PLUGIN THAT THREW DURING STARTUP IS VISIBLE WITHOUT EXPANDING ANYTHING', async ({ page }) => {
        const broken = page.locator('.serverPlugin_block[data-source="zz-broken-probe-e2e.mjs"]');

        await expect(broken).toHaveClass(/serverPlugin_failed/);
        await expect(broken.locator('.serverPlugin_name')).toHaveText('Broken Probe');
        await expect(broken.locator('.serverPlugin_status')).toHaveText('Failed to start');

        // Failures sort first: on an install with eight plugins the broken one must not have to be hunted for.
        const first = page.locator('.serverPlugins_info .serverPlugin_block').first();
        await expect(first).toHaveAttribute('data-source', 'zz-broken-probe-e2e.mjs');
    });

    test('a plugin that loaded is listed too, so the section is an inventory and not an error log', async ({ page }) => {
        const loaded = page.locator('.serverPlugin_block[data-source="zz-settings-probe-e2e.mjs"]');

        await expect(loaded).not.toHaveClass(/serverPlugin_failed/);
        await expect(loaded.locator('.serverPlugin_status')).toHaveText('Loaded');
        await expect(loaded.locator('.serverPlugin_description').first()).toHaveText('Registers settings and no panel. Test fixture.');
    });

    test('🔴 A PLUGIN WITH NO PANEL STILL GETS ITS SETTINGS — the whole reason this capability exists', async ({ page }) => {
        // This fixture registers no panel at all, so it draws no button. If the settings row were reached
        // through the panel registration, there would be nothing here. Scoped by id rather than by a bare
        // count: another fixture in this boot registers a panel on purpose.
        await expect(page.locator('#pluginPanelButton_settings-probe_0')).toHaveCount(0);

        const row = page.locator('.serverPlugin_block[data-source="zz-settings-probe-e2e.mjs"]');
        await row.locator('.serverPlugin_settingsToggle').click();

        await expect(page.locator('#pluginSettings-settings-probe #probe-settings')).toHaveText('settings body');
    });

    test('the fragment is sanitized: its injected handler DOES NOT run, and its <style> cannot restyle the host', async ({ page }) => {
        const row = page.locator('.serverPlugin_block[data-source="zz-settings-probe-e2e.mjs"]');
        await row.locator('.serverPlugin_settingsToggle').click();
        await expect(page.locator('#pluginSettings-settings-probe #probe-settings')).toBeVisible();

        // An `onerror` on a broken image DOES fire on innerHTML insertion, unlike a `<script>` tag — which is
        // why the fixture uses one. A probe built from a script tag would pass whether DOMPurify ran or not.
        await expect.poll(() => page.evaluate(() => globalThis.SETTINGS_PROBE_RAN === true)).toBe(false);

        // The fragment's `<style>` block targets host chrome on purpose. FORBID_TAGS must have removed it.
        await expect(page.locator('#send_but')).toBeVisible();
    });

    test('🎨 a registered stylesheet reaches the settings fragment, and CANNOT reach past it', async ({ page }) => {
        const row = page.locator('.serverPlugin_block[data-source="zz-settings-probe-e2e.mjs"]');
        await row.locator('.serverPlugin_settingsToggle').click();

        const styled = page.locator('#pluginSettings-settings-probe .probe-settings-styled');
        await expect(styled).toBeVisible();

        // The plugin's own rule landed…
        await expect.poll(() => styled.evaluate(el => getComputedStyle(el).color)).toBe('rgb(4, 5, 6)');

        // …and its second rule, which reaches for host chrome outside the container, matched nothing. That is
        // the `@scope` wrapper doing its job in a host where an unscoped sheet would be styling the dialog.
        await expect(page.locator('#send_but')).toBeVisible();
    });

    test('🔴 A 503 RENDERS THE PLUGIN\'S OWN WORDS AND NEVER A FORM', async ({ page }) => {
        const row = page.locator('.serverPlugin_block[data-source="zz-locked-probe-e2e.mjs"]');
        await row.locator('.serverPlugin_settingsToggle').click();

        const body = page.locator('#pluginSettings-locked-probe');

        // The plugin's explanation, verbatim — not a host error, not a toast.
        await expect(body.locator('#probe-locked')).toHaveText(LOCKED_TEXT);
        await expect(body.locator('.pluginSettings_problem')).toHaveCount(0);

        // 🔴 AND NOTHING TO SAVE. A form here would be one full of shipped defaults over settings the plugin
        // could not read — a Save away from destroying the user's real configuration.
        await expect(body.locator('input, select, textarea')).toHaveCount(0);
    });

    test('🔴 A REGISTERED QUERY REACHES THE PLUGIN AS ITS OWN PARAMETER, ALONGSIDE THE AMBIENT ONES', async ({ page }) => {
        // The fixture registered `/frag?view=settingsview` and echoes back what the SERVER parsed. Before the
        // merge, the fetch appended a second `?`: the server saw `view="settingsview?tz=…"` and no `tz` at
        // all, and the plugin fell back to its default view — a 200, well-formed and styled, showing the
        // wrong screen. That is why this asserts on the echo rather than on the page looking right.
        const row = page.locator('.serverPlugin_block[data-source="zz-query-probe-e2e.mjs"]');
        await row.locator('.serverPlugin_settingsToggle').click();

        const body = page.locator('#pluginSettings-query-probe');

        await expect(body.locator('#probe-view')).toHaveText('view=settingsview');
        // `tz` is the ambient parameter that is always set, so it is the one that proves the merge rather
        // than the environment. Fused, it was swallowed into the `view` value above and arrived as nothing.
        await expect(body.locator('#probe-tz')).not.toHaveText('tz=');
    });

    test('🔴 THE PANEL FETCH MERGES TOO — it is the same helper, and it had the same bug', async ({ page }) => {
        // registerPanel goes through the identical resolveMountedPath and the identical fetch, so a fix that
        // only touched the settings host would leave the older capability broken in exactly the same way.
        // The dialog is modal and sits over the chat, so it has to go before the panel button is reachable.
        // Closed by its own Close button rather than with Escape: Escape is claimed by a panel that binds
        // `data-panel-key="escape"`, and depending on it here would couple this test to that unrelated rule.
        await page.locator('.popup:visible .popup-button-ok').click();
        await expect(page.locator('.extensions_info')).toHaveCount(0);

        await page.locator('#pluginPanelButton_query-probe_0').click();

        const panel = page.locator('#pluginPanel-query-probe');

        await expect(panel.locator('#probe-view')).toHaveText('view=panelview');
        await expect(panel.locator('#probe-tz')).not.toHaveText('tz=');
    });

    test('collapsing gives the shared action slot back, so panel actions elsewhere keep working', async ({ page }) => {
        const row = page.locator('.serverPlugin_block[data-source="zz-settings-probe-e2e.mjs"]');
        const toggle = row.locator('.serverPlugin_settingsToggle');

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#pluginSettings-settings-probe #probe-settings')).toBeVisible();

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        // Torn down rather than hidden: a container left mounted holds the slot that every panel action reads.
        await expect(page.locator('#pluginSettings-settings-probe #probe-settings')).toHaveCount(0);
    });
});

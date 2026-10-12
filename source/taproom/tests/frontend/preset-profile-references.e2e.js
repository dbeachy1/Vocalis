/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 WHAT THIS GUARDS. A connection profile stores its settings preset BY NAME, and nothing kept the two
 * in step. Delete the preset and every profile naming it points at nothing; rename it and the same thing
 * happens with no error at all, because a rename is save-new-then-delete-old.
 *
 * The damage lands far from the cause. Applying such a profile skips the preset step and quietly runs on
 * whatever preset happened to be loaded, and an extension that reads `profile.preset` to size a request
 * -- Qvink Memory's summariser does -- fails days later with a message that names nothing actionable.
 *
 * It has to be asserted in a browser: the preset list, the `<select>` a rename reads its old name from,
 * and `extension_settings.connectionManager` all exist only in a live page.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

test.describe('presets and the connection profiles that name them', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeEach(async () => {
        test.setTimeout(240_000);
        const scratch = makeScratchDirectory('preset-profile-refs-e2e');
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
    });

    /**
     * Open the app and wait until the preset managers are registered.
     * @param {import('@playwright/test').Page} page The page
     */
    async function openApp(page) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        /*
         * ⚠️ `getContext()` throws during early boot (a TDZ on script.js's module bindings), so the poll
         * has to catch or it rejects instead of retrying.
         *
         * 🔴 AND THE MANAGER EXISTING IS NOT THE LIST EXISTING. `firstLoadInit()` calls
         * `initPresetManager()` BEFORE `getSettings()`, and it is `getSettings()` that loads the preset
         * lists -- so there is a window where `getPresetManager('textgenerationwebui')` answers happily
         * and `savePreset()` writes into an array that is about to be REPLACED wholesale. The preset
         * then simply is not there, and the failure reads as "the rename did not take". Intermittent,
         * and it cost a green run that meant nothing.
         */
        await page.waitForFunction(() => {
            try {
                return (globalThis.SillyTavern?.getContext?.().getPresetManager?.('textgenerationwebui')?.getAllPresets()?.length ?? 0) > 0;
            } catch {
                return false;
            }
        }, null, { timeout: 120_000 });
    }

    /**
     * Save a copy of the current text-completion settings under a new name, and hand back a profile that
     * points at it -- the arrangement every one of these tests starts from.
     * @param {import('@playwright/test').Page} page The page
     * @param {string} presetName Name to save the preset under
     * @returns {Promise<{profiles: object[], presetNames: string[]}>} State after the arrangement
     */
    function seedPresetAndProfile(page, presetName) {
        return page.evaluate(async (presetName) => {
            const ctx = globalThis.SillyTavern.getContext();
            const manager = ctx.getPresetManager('textgenerationwebui');
            await manager.savePreset(presetName);

            ctx.extensionSettings.connectionManager = ctx.extensionSettings.connectionManager ?? { profiles: [], selectedProfile: null };
            ctx.extensionSettings.connectionManager.profiles.push(
                { id: 'referring', mode: 'tc', name: 'Refers To It', preset: presetName },
                { id: 'innocent', mode: 'tc', name: 'Refers To Something Else', preset: 'a preset that was never made' },
                // A chat-completion profile of the same name proves the mode discriminator does its job:
                // `cc` and `tc` keep separate preset lists that may hold the same name.
                { id: 'other-mode', mode: 'cc', name: 'Same Name, Other Mode', preset: presetName },
            );

            // ⚠️ `preset_names` is an ARRAY of names for the keyed APIs (text completion is one) and an
            // object of {name: index} for the rest. Reading it one way gives you array INDICES and an
            // assertion that fails for a reason that has nothing to do with the subject.
            const { preset_names } = manager.getPresetList();
            return {
                profiles: structuredClone(ctx.extensionSettings.connectionManager.profiles),
                presetNames: Array.isArray(preset_names) ? preset_names : Object.keys(preset_names),
            };
        }, presetName);
    }

    /** What the profiles say now. */
    function profiles(page) {
        return page.evaluate(() => structuredClone(globalThis.SillyTavern.getContext().extensionSettings.connectionManager.profiles));
    }

    test('🔴 deleting a preset says which connection profiles are left pointing at it', async ({ page }) => {
        await openApp(page);
        const seeded = await seedPresetAndProfile(page, 'Doomed');
        expect(seeded.presetNames, 'the preset was never saved, so nothing here is under test').toContain('Doomed');

        const deleted = await page.evaluate(async () => {
            return globalThis.SillyTavern.getContext().getPresetManager('textgenerationwebui').deletePreset('Doomed');
        });
        expect(deleted, 'the delete itself failed').toBe(true);

        // The user-visible half: a warning at the moment they did it, naming the profile, rather than an
        // unrelated error from somewhere else days later.
        const warning = page.locator('#toast-container .toast-warning');
        await expect(warning).toContainText('Refers To It', { timeout: 15_000 });
        await expect(warning, 'a profile pointing at an unrelated preset was dragged in').not.toContainText('Refers To Something Else');
        await expect(warning, 'the other mode keeps its own preset list, so its profile is not affected').not.toContainText('Same Name, Other Mode');
    });

    test('🔴 renaming a preset repoints the connection profiles that name it', async ({ page }) => {
        await openApp(page);
        await seedPresetAndProfile(page, 'Before');

        const renamed = await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            const manager = ctx.getPresetManager('textgenerationwebui');
            // A rename acts on the SELECTED preset, and `getSelectedPresetName()` reads the `<select>`.
            const option = Array.from(manager.select instanceof HTMLElement ? manager.select.options : $(manager.select)[0].options)
                .find(o => o.text === 'Before');
            option.selected = true;
            await manager.renamePreset('After');
            const { preset_names } = manager.getPresetList();
            return Array.isArray(preset_names) ? preset_names : Object.keys(preset_names);
        });

        expect(renamed, 'the rename did not take').toContain('After');
        expect(renamed).not.toContain('Before');

        const after = await profiles(page);
        expect(after.find(p => p.id === 'referring').preset, 'the profile was left pointing at a preset that no longer exists').toBe('After');
        expect(after.find(p => p.id === 'innocent').preset, 'an unrelated profile was rewritten').toBe('a preset that was never made');
        expect(after.find(p => p.id === 'other-mode').preset, 'a chat-completion profile was rewritten from the text-completion list').toBe('Before');

        // A rename knows the new name, so there is nothing for the user to fix and nothing to say.
        await expect(page.locator('#toast-container .toast-warning')).toHaveCount(0);
    });

    test('🔴 applying a profile whose preset is gone says so, and leaves the loaded one alone', async ({ page }) => {
        await openApp(page);
        // ⚠️ The Connection Manager's own markup is injected by the extension well after the preset
        // managers exist, so the app being up is not the same as this control being there.
        await page.locator('#connection_profiles').waitFor({ state: 'attached', timeout: 90_000 });

        /*
         * 🔴 THE ARRANGEMENT IS THE TEST. `/preset` answers a name it cannot find by FUZZY-matching it,
         * so the profile names something MISSING but close to a SURVIVING preset -- and the survivor is
         * deliberately not the one already loaded. If the guess ever reaches, this catches it; if it does
         * not, `/preset` keeps the current preset and says so only to the console, which is just as
         * silent from where the user sits. Both outcomes are what the warning exists to end.
         *
         * "Sampler Two" is loaded, "Sampler One" exists, the profile asks for "Sampler Onx". Measured
         * behaviour today is that nothing moves; the assertion pins that, so a future change to the
         * fuzzy threshold cannot start swapping presets under a profile without this going red.
         */
        const before = await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            const manager = ctx.getPresetManager('textgenerationwebui');
            await manager.savePreset('Sampler One');
            await manager.savePreset('Sampler Two');
            Array.from($(manager.select)[0].options).find(o => o.text === 'Sampler Two').selected = true;

            ctx.extensionSettings.connectionManager = ctx.extensionSettings.connectionManager ?? { profiles: [], selectedProfile: null };
            // ⚠️ `preset` and nothing else. A profile carrying an api or a model would send this test
            // through `/api` and `/model` against a server with no backend, which is not the subject and
            // is slow enough to hide one.
            ctx.extensionSettings.connectionManager.profiles.push({ id: 'stale', mode: 'tc', name: 'Points At A Ghost', preset: 'Sampler Onx' });

            return manager.getSelectedPresetName();
        });
        expect(before).toBe('Sampler Two');

        // 🔴 THROUGH THE `<select>`, because that is the only door. `/profile` does not apply anything
        // itself -- it moves `#connection_profiles` and dispatches `change`, and the handler on that
        // element is what applies the profile. A profile pushed straight into the settings array has no
        // option to move to, so `/profile` finds index -1 and silently applies nothing, which reads
        // exactly like the warning under test never firing.
        const applied = await page.evaluate(async () => {
            const select = document.getElementById('connection_profiles');
            const option = document.createElement('option');
            option.value = 'stale';
            option.textContent = 'Points At A Ghost';
            select.appendChild(option);
            select.value = 'stale';
            select.dispatchEvent(new Event('change'));
            await new Promise(resolve => setTimeout(resolve, 3000));
            return globalThis.SillyTavern.getContext().getPresetManager('textgenerationwebui').getSelectedPresetName();
        });

        expect(applied, 'a preset the profile never named was fuzzy-matched and loaded in its place').toBe('Sampler Two');

        const warning = page.locator('#toast-container .toast-warning');
        await expect(warning).toContainText('Sampler Onx', { timeout: 15_000 });
        await expect(warning).toContainText('Points At A Ghost');
    });
});

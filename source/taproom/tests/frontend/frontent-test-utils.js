const baseURL = process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8000';

export const testSetup = {
    /**
     * Navigates to the home page without waiting for SillyTavern to load.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    goST: async ({ page }) => {
        await page.goto('/');
    },

    /**
     * Waits for SillyTavern to fully load by navigating to the home page and waiting for `APP_READY`.
     *
     * 🔴 THIS USED TO WAIT FOR THE PRELOADER TO DISAPPEAR, AND THAT IS NOT WHEN THE APP IS LOADED.
     *
     * `firstLoadInit()` hides the loader at the very end (script.js, right before it emits `APP_READY`) --
     * but it ALSO hides it from inside `getSettings()`, at `if (firstRun) { await initLoaderHandle?.hide();
     * await doOnboarding(...) }`. On a data root that has never completed onboarding, that line runs, the
     * preloader vanishes, and the app then STOPS DEAD on a modal asking the user their name. Nothing in a
     * headless run ever answers it, so `getSettings()` never returns, `settingsReady` never flips, and
     * every init step after it -- `initTags`, `getCharacters`, `getBackgrounds`, `initPersonas`,
     * `initWorldInfo`, and the rest -- never runs at all.
     *
     * So the old gate resolved at the exact moment the app had stopped to ask a question, and specs then
     * drove a half-initialised page. It fails FAR from the cause and looks nothing like it: the World Info
     * rename specs clicked `#world_popup_name_button` and nothing happened, because `displayWorldEntries`
     * had never bound it. No error, no rejection, no pending request -- just a button wired to nothing.
     *
     * The fix is both halves. Onboarding gets answered (below), and readiness is now the app's own
     * `APP_READY`, which is emitted on the last line of `firstLoadInit()` and means what it says.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitST: async ({ page }) => {
        await page.goto('/');
        if (await testSetup.isLoginPage({ page })) {
            // eslint-disable-next-line playwright/no-networkidle
            await page.waitForLoadState('networkidle');
            const userSelect = page.locator('#userList .userSelect').last();
            if (await userSelect.count()) {
                await userSelect.click();
            }
            await page.waitForURL(url => url.toString().startsWith(baseURL) && url.pathname !== '/login');
        }

        // ⚠️ RACED, never waited for in sequence. Onboarding appears on a fresh data root and never again
        // once dismissed, so a plain `waitFor` would cost its timeout on every one of the hundreds of runs
        // where it correctly never shows. Whichever lands first decides: if the app went ready, there was
        // no onboarding to answer.
        const ready = testSetup.awaitAppReady({ page });
        ready.catch(() => { });
        const onboarding = page.locator('dialog[open] .onboarding')
            .waitFor({ state: 'visible', timeout: 0 })
            .then(() => 'onboarding', () => 'never');

        if (await Promise.race([ready.then(() => 'ready'), onboarding]) === 'onboarding') {
            // The name does not matter -- what matters is that `doOnboarding` returns, so `getSettings`
            // can finish and the rest of init can run. `cancelButton: false`, so OK is the only way out.
            await page.locator('dialog[open] .popup-button-ok').click();
        }

        await ready;
    },

    /**
     * Resolves when the app emits `APP_READY` -- the last line of `firstLoadInit()`, and the only signal
     * that every init step actually ran.
     *
     * Safe to call at any point in the load, including after the event has already fired: `eventSource` is
     * constructed with `APP_READY` in its `autoFireAfterEmit` set (scripts/events.js), so a listener added
     * late is invoked immediately with the last arguments. The hook is installed once and guarded, because
     * `waitForFunction` re-runs its predicate on every animation frame and would otherwise pile up a
     * listener per poll.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitAppReady: async ({ page }) => {
        await page.waitForFunction(() => {
            if (globalThis.__stAppReady) {
                return true;
            }

            try {
                // ⚠️ `getContext()` THROWS while script.js is still evaluating ("Cannot access 'chat'
                // before initialization"), which is most of the window this predicate runs in. That is a
                // not-ready answer, not a failure -- swallow it and poll again.
                const eventSource = globalThis.SillyTavern?.getContext?.()?.eventSource;

                if (eventSource && !globalThis.__stAppReadyHooked) {
                    globalThis.__stAppReadyHooked = true;
                    eventSource.on('app_ready', () => { globalThis.__stAppReady = true; });
                }
            } catch {
                // still evaluating -- try again next frame
            }

            return !!globalThis.__stAppReady;
        }, null, { timeout: 0 });
    },

    /**
     * Checks if the current page is the login page by looking for a body element with the class 'login'.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    isLoginPage: async ({ page }) => {
        return await page.locator('body.login').count() > 0;
    },
};

/**
 * The page's own globals — the half of `tools/deploy-gates/` that runs INSIDE the browser.
 *
 * 🔴 **A SEPARATE FILE FROM `playwright.d.ts` BECAUSE IT IS A SEPARATE CLAIM.** Playwright is the driver, and
 * this is the application it drives; they arrive together only because one file happens to use both. Kept in
 * the same file, "what the test runner offers" and "what the deployed app puts on `window`" would read as one
 * dependency, and the next person adding a page global would put it under a header about a node module.
 *
 * 🔴 **AND NOTHING IN `src/` CAN SEE THIS, WHICH IS THE POINT.** Only `tsconfig.tools.json` includes
 * `types/tools/`. Mnemosyne is a SERVER plugin: a `src/` file reaching for `SillyTavern.getContext()` would be
 * reaching for a browser it does not have, and over there it stays an error — the same reason `src/` has no
 * `lib: DOM`. See DESIGN_TYPES.md §4.
 *
 * ⚠️ Like every other declaration in `types/`, this describes what WE call, not what SillyTavern offers.
 */

/**
 * The page's own global, for the callbacks that run inside the browser.
 *
 * 🔴 **DECLARED HERE, WITH PLAYWRIGHT, BECAUSE IT IS THE SAME SEAM.** `tsconfig.tools.json` is the only config
 * that includes `types/tools/`, so nothing in `src/` can see this — which is the point. Mnemosyne is a server
 * plugin; a `src/` file that reached for `SillyTavern.getContext()` would be reaching for a browser it does
 * not have, and it stays an error over there.
 *
 * ⚠️ **`| undefined` IS LOAD-BEARING.** The gate's readiness probe runs *before* the app has finished
 * initializing, which is precisely when this global does not exist yet — that is what the probe is waiting
 * for, and its `?.` is doing real work rather than being defensive. Every other use runs after the probe has
 * passed, and each says so with a cast at the site instead of this declaration lying for all of them.
 */
declare var SillyTavern: SillyTavernPage | undefined;

/** The handful of members the gates reach for on the page's global. Not SillyTavern's API — a slice of it. */
interface SillyTavernPage {
    getContext(): SillyTavernPageContext;
}

interface SillyTavernPageContext {
    /**
     * The character list. Read ONLY as an `!== undefined` liveness signal — the gate never looks inside it,
     * and `unknown[]` is what keeps it that way.
     *
     * ⚠️ `getContext()` itself throws while the app is still initializing (a TDZ error out of `st-context.js`),
     * which the probe swallows. Being callable is not the same as being ready.
     */
    characters?: unknown[];
    /**
     * 🔴 The page's own CSRF and session headers. The gate seeds and deletes its memory through the real REST
     * routes using these, which is what makes it a test of the deployed surface rather than of a fixture.
     */
    getRequestHeaders(): Record<string, string>;
}

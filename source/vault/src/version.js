import fs from 'node:fs';

/**
 * This build's version, read from the manifest rather than written out here.
 *
 * A second copy of a version number is a second copy that goes stale, and this one would go stale in the
 * least visible way available: it is shown to a user who has UNINSTALLED the plugin and is trying to work
 * out which build wrote the files they can no longer read. A wrong answer there sends them to the wrong
 * release.
 *
 * ⚠️ **GUARDED, AND IT FALLS BACK RATHER THAN THROWING.** This is reached while dialogs are being built,
 * including one the user cannot dismiss (the recovery-key wall). A module that failed to load over a
 * missing `package.json` would take out the screen that exists to stop an account becoming permanently
 * unrecoverable. An unknown version is a cosmetic loss; a throw here is not.
 *
 * ## Why this is its own file
 *
 * It lived in `strings.js`, which is a table of things to SAY. Reading a file off the disk at module load,
 * with its own try/catch and its own workaround for the test runner's module loader, is not that — it is
 * one fact about the build, wanted by anything that reports provenance. It is here so `strings.js` can go
 * back to being only copy.
 */

/**
 * 🔴 `new URL(..., import.meta.url)`, NOT `import.meta.dirname`.
 *
 * The latter is undefined inside Jest's ESM VM, so the read failed, the `catch` swallowed it, and every
 * install reported its version as `unknown` — to a user who has uninstalled the plugin and is trying to
 * work out which build wrote the files they can no longer read. A silent fallback that only misfires under
 * the test runner is exactly the kind of thing that ships.
 * @type {string}
 */
export const VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version ?? 'unknown';
    } catch {
        return 'unknown';
    }
})();

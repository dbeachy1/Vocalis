/**
 * The version of THIS code, as a literal that travels with it.
 *
 * The header reports the version compiled into these modules. A per-user extension copy can shadow the global
 * copy, and an open tab keeps previously loaded modules; showing the version identifies the code behind the panel
 * and helps distinguish a stale tab from a server-side problem.
 *
 * Keep this value literal rather than fetching `manifest.json`: a stale tab talks to the current server, so a
 * runtime fetch would display the server version instead of the loaded module version. `version.test.js` checks
 * this literal against `manifest.json` and `package.json`.
 *
 * ⚠️ NO IMPORTS, EVER. `panel.js` and `index.js` statically import SillyTavern's `script.js`, so the suite
 * cannot reach them (`test/parse.test.js`). This module stays dependency-free so any test can import it and
 * read the constant directly, rather than the drift guard having to scrape source text.
 */

/** Bump with `manifest.json` and `package.json`, or `version.test.js` fails. */
export const VERSION = '1.3.5';

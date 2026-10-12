import { defineConfig } from '@playwright/test';

import { serverBootingSpecs } from './util/server-booting-specs.js';
import { workerCount } from './util/worker-count.js';

const baseURL = process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8000';

/**
 * The specs that boot a REAL SillyTavern server in `beforeAll` (see `run-browser-specs.mjs`), derived
 * by reading them rather than listed here — `util/server-booting-specs.js` says why.
 *
 * 🔴 THESE MUST NOT BE SWEPT INTO A PLAIN `playwright test`. They cost a server and a browser each, and
 * the DOM-only specs beside them cost neither, so running the two sets together at one worker count is
 * wrong for whichever set it was not chosen for. Worse, it used to be actively broken: a bare
 * `playwright test` — which is what `npm run test:e2e`, and therefore `npm test`, used to be — ran them
 * at `workers: 4, fullyParallel: true`, and the result was not a clean failure. One spec reached
 * another's server and asserted against the wrong fixture: `storage-summary-panel` expected "1
 * character" and was handed `mixed-provider`'s "2 chats and 1 group chat".
 *
 * So `playwright test` skips them by default and `run-browser-specs.mjs` sets `ST_BROWSER_SPEC=1` to opt
 * them back in, as one parallel run of their own. Run one by hand the same way:
 * `ST_BROWSER_SPEC=1 npx playwright test plugin-panels --workers=1`.
 */
const isolated = Boolean(process.env.ST_BROWSER_SPEC);

export default defineConfig({
    testMatch: '*.e2e.js',
    testIgnore: isolated ? [] : serverBootingSpecs().map(name => `**/${name}.e2e.js`),

    /*
     * Claims this run a port range, so a concurrent `test:unit` cannot hand our workers its ports, and
     * names the manifest that makes the scratch directories sweepable. The jest side has done both since
     * it hit those failures; the Playwright side had no hook at all, which was survivable only while the
     * browser suite ran one spec at a time.
     *
     * 🔴 THE TEARDOWN IS NOT OPTIONAL AND ITS ABSENCE IS SILENT. There was a `globalSetup` here and no
     * teardown, so every `*.e2e.js` spec's data root — ~30 MB each, 292 of them in five days — stayed in
     * the temp directory forever, on passing runs. Nothing goes red when this line is missing; that is
     * what `frontend/scratch-manifest-is-wired.e2e.js` is for.
     */
    globalSetup: './util/playwright-global-setup.js',
    globalTeardown: './util/playwright-global-teardown.js',

    use: {
        baseURL,
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },

    /*
     * 🔴 `fullyParallel` MUST BE OFF FOR THE SERVER-BOOTING SPECS, and it is the trap in making them
     * parallel at all. It splits the tests INSIDE one file across workers — each of which re-runs that
     * file's `beforeAll`, so a spec that boots one server in `beforeAll` and walks it through a sequence
     * (install the provider, uninstall it, check what the library shows) would instead boot several
     * servers and run the steps against different ones, out of order. Every one of these specs is
     * written as such a sequence. File-level parallelism is all they can take, and all they need: there
     * are eight of them.
     */
    fullyParallel: !isolated,
    workers: isolated ? workerCount() : 4,
});

import { ownsManifest, sweepManifest } from './scratch.js';
import { releasePortSlot } from './st-server.js';

/**
 * Runs once, in the main process, after every spec — the Playwright half of `util/global-teardown.js`.
 *
 * `playwright.config.js` had a `globalSetup` and no teardown at all, which is half a lifecycle: the run
 * claimed a port slot it never handed back, and once the setup started naming a manifest there would have
 * been nobody to read it. Deletes exactly the scratch directories this run recorded — not an `st-*` glob,
 * which would take a concurrent run's live directories with it.
 *
 * 🔴 A MANIFEST WE INHERITED IS NOT OURS TO SWEEP, and this is the trap that a shared teardown walks
 * straight into. `run-browser-specs.mjs` hands the same manifest to eight concurrent children; whichever
 * one finishes first would delete the data roots the other seven are still serving from, and the failure
 * would read as a spec's own server dying. {@link ownsManifest} is the pid check that stops it — the owner
 * sweeps, and the owner is the process that outlives every child appending to the file.
 *
 * This does not run if the run is killed rather than finished. `globalSetup`'s reclaim pass is what covers
 * that case, and it is why the manifest is named for a pid at all.
 * @returns {Promise<void>}
 */
export default async function globalTeardown() {
    // Unconditionally, and before the returns below: the slot has to come back even for a run that never
    // got a manifest. It matches on the pid INSIDE the lock, so a child that merely inherited a band
    // releases nothing and cannot hand back a range its parent is still using.
    releasePortSlot();

    const manifestPath = process.env.ST_TEST_SCRATCH_MANIFEST;

    if (!manifestPath || !ownsManifest(manifestPath)) {
        return;
    }

    const removed = sweepManifest(manifestPath);

    if (removed > 0) {
        console.log(`Removed ${removed} scratch ${removed === 1 ? 'directory' : 'directories'}.`);
    }
}

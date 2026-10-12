import { sweepManifest } from './scratch.js';
import { releasePortSlot } from './st-server.js';

/**
 * Runs once, in the main process, after every suite.
 *
 * Deletes exactly the scratch directories this run recorded — not an `st-*` glob, which would delete a
 * concurrent run's live directories, and not a glob filtered by creation time, which silently collected
 * half as many when the two were measured against each other.
 *
 * This does not run if the run is killed rather than finished. `globalSetup`'s reclaim pass is what
 * covers that case.
 * @returns {Promise<void>}
 */
export default async function globalTeardown() {
    // Before the early return below: the slot has to come back even for a run that never got a manifest,
    // or a suite selection that skipped setup leaks a port range until the pid is reused.
    releasePortSlot();

    const manifestPath = process.env.ST_TEST_SCRATCH_MANIFEST;

    if (!manifestPath) {
        return;
    }

    const removed = sweepManifest(manifestPath);

    if (removed > 0) {
        console.log(`Removed ${removed} scratch ${removed === 1 ? 'directory' : 'directories'}.`);
    }
}

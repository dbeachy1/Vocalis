import { newManifestPath, reclaimOrphanedRuns } from './scratch.js';
import { claimPortSlot } from './st-server.js';

/**
 * Runs once, in the main process, before Playwright forks a worker.
 *
 * Two jobs, and neither of them can be done any later than this.
 *
 * 🔴 THE PER-WORKER BAND IS NOT ENOUGH ON ITS OWN, AND THIS IS THE HALF JEST ALREADY HAD. Worker slot 0
 * of a Playwright run and worker 1 of a concurrent `test:unit` both sit at the bottom of the same pool
 * unless something moves one of them, and then they hand each other ports — the failure `claimPortSlot`
 * exists for, which `util/global-setup.js` has been claiming a slot against since jest hit it. Playwright
 * had no equivalent hook, so its runs sat on the floor. That was survivable only while the browser suite
 * ran one spec at a time; it is not now.
 *
 * 🔴 AND THE MANIFEST IS THE OTHER HALF, WHICH WAS MISSING FOR LONGER AND COST MORE. `makeScratchDirectory`
 * records a directory only if `ST_TEST_SCRATCH_MANIFEST` names a file; with no manifest the `if` is skipped
 * and the directory is invisible to BOTH removal paths at once — this run's teardown has nothing to read,
 * and the next run's `reclaimOrphanedRuns` has no manifest to find. Thirty `*.e2e.js` specs make one data
 * root each, ~30 MB apiece, and every one of them leaked on every run INCLUDING the green ones: 8.75 GB
 * across 292 directories in five days, found by looking at the disk rather than by anything going red. A
 * leak fails nothing, so nothing but this hook will ever notice it.
 *
 * ⚠️ BOTH ARE PASSED THROUGH `process.env`, WHICH WORKS BECAUSE WORKERS ARE FORKED AFTER THIS. Same
 * contract jest's hook relies on. Nothing here may be moved into a fixture or a `beforeAll` — by then
 * the worker exists, has already computed its band, and has already made its scratch directory.
 * @returns {Promise<void>}
 */
export default async function globalSetup() {
    // ⚠️ ABOVE THE PORT-SLOT RETURN BELOW, AND THAT ORDER IS THE WHOLE FIX. The early return is the COMMON
    // path — every child `run-browser-specs.mjs` spawns takes it, because it inherits a slot. A manifest
    // set underneath it would cover only the hand-run case and leave the browser suite leaking exactly as
    // it did.
    //
    // An inherited manifest wins for the same reason an inherited slot does: the runner names one for the
    // whole suite and every child appends to it, so claiming a second one here would hide this process's
    // directories from the sweep that is going to look for them.
    if (!process.env.ST_TEST_SCRATCH_MANIFEST) {
        const reclaimed = reclaimOrphanedRuns();

        if (reclaimed > 0) {
            console.log(`Reclaimed ${reclaimed} scratch ${reclaimed === 1 ? 'directory' : 'directories'} from a run that did not finish.`);
        }

        process.env.ST_TEST_SCRATCH_MANIFEST = newManifestPath();
    }

    // ⚠️ AN INHERITED SLOT WINS. `run-browser-specs.mjs` claims one slot for the whole browser suite and
    // hands each child a band inside it; claiming a second one here would throw that assignment away and
    // put every child back on its own slot's floor — which is where they collide.
    if (process.env.ST_TEST_PORT_BASE) {
        return;
    }

    process.env.ST_TEST_PORT_BASE = String(claimPortSlot());
}

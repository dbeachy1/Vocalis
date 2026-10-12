import { newManifestPath, reclaimOrphanedRuns } from './scratch.js';
import { claimPortSlot } from './st-server.js';

/**
 * Runs once, in the main process, before any suite.
 *
 * Three jobs. First, clean up after any previous run that was killed before it could clean up after
 * itself — `globalTeardown` never runs for those, so this is the only thing that ever will. Second,
 * name a manifest for this run: `makeScratchDirectory` appends every scratch directory it creates to
 * that file, and the teardown deletes exactly what it finds there. Third, claim a port range, so a
 * second run happening at the same time cannot hand our workers their ports.
 *
 * ⚠️ The claimed range is a FIXED width, not this run's worker count — see `SLOT_WORKERS`. A wide run
 * and a narrow one have to agree on where each slot starts, or their slots interleave.
 *
 * Jest forks its workers after this hook and hands them `process.env`, and it keeps globalTeardown in
 * this same process, so the environment reaches both ends.
 * @returns {Promise<void>}
 */
export default async function globalSetup() {
    const reclaimed = reclaimOrphanedRuns();

    if (reclaimed > 0) {
        console.log(`Reclaimed ${reclaimed} scratch ${reclaimed === 1 ? 'directory' : 'directories'} from a run that did not finish.`);
    }

    process.env.ST_TEST_SCRATCH_MANIFEST = newManifestPath();
    process.env.ST_TEST_PORT_BASE = String(claimPortSlot());
}

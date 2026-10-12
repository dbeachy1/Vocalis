import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Scratch-directory bookkeeping, shared by globalSetup and globalTeardown.
 *
 * The suites create an `st-<label>-XXXXXX` directory each — ~211 files, ~29 MB — and for a long time
 * nothing removed any of them: 243 directories and 7.6 GB accumulated over five days. Cleaning them up
 * cannot be done from a per-suite `afterAll`, because each Jest worker is blind to the others'
 * directories and because a suite that times out never reaches its `afterAll` at all, which is exactly
 * the suite that leaks.
 *
 * So each run records what it creates in a manifest, and deletes exactly that at the end. The manifest
 * is named for the process that owns it, which is what makes {@link reclaimOrphanedRuns} possible.
 */

const MANIFEST_PREFIX = 'st-run-';
const MANIFEST_SUFFIX = '.manifest';
const MANIFEST_PATTERN = /^st-run-(\d+)-\d+\.manifest$/;

/**
 * Name a manifest for this process.
 * @returns {string} Path to this run's manifest
 */
export function newManifestPath() {
    return path.join(os.tmpdir(), `${MANIFEST_PREFIX}${process.pid}-${Date.now()}${MANIFEST_SUFFIX}`);
}

/**
 * Is this manifest ours to sweep?
 *
 * 🔴 A PROCESS MUST NEVER SWEEP A MANIFEST IT INHERITED. `run-browser-specs.mjs` names ONE manifest for
 * the whole browser run and hands it to every child, exactly as it hands out port bands — so a child's
 * `globalTeardown` sees a valid manifest full of directories, most of them belonging to the siblings
 * still running against them. Sweeping it there deletes a live spec's data root mid-test: the same
 * failure an `st-*` glob causes, reached from the other side.
 *
 * The manifest's own filename carries the pid that named it, which settles the question without
 * guessing — the same fact {@link reclaimOrphanedRuns} leans on, asked about a live process instead of a
 * dead one. Whoever named it is the process that outlives every worker appending to it.
 * @param {string} manifestPath The manifest to ask about
 * @returns {boolean} True if this process created it
 */
export function ownsManifest(manifestPath) {
    const match = MANIFEST_PATTERN.exec(path.basename(manifestPath));
    return match !== null && Number.parseInt(match[1], 10) === process.pid;
}

/**
 * Is this a path we are willing to delete recursively?
 *
 * The sweep is driven by a file, and a recursive delete deserves a second opinion that does not come
 * from that file. A truncated or interleaved append should cost a leaked directory, never someone
 * else's tree.
 * @param {string} target The recorded path
 * @returns {boolean} True if it looks like one of ours
 */
function isOurScratchDirectory(target) {
    const resolved = path.resolve(target);
    return path.dirname(resolved) === path.resolve(os.tmpdir())
        && path.basename(resolved).startsWith('st-')
        && !path.basename(resolved).endsWith(MANIFEST_SUFFIX);
}

/**
 * Delete every directory a manifest records, then the manifest itself.
 * @param {string} manifestPath The manifest to act on
 * @returns {number} How many directories were removed
 */
export function sweepManifest(manifestPath) {
    /** @type {string[]} */
    let recorded = [];

    try {
        recorded = fs.readFileSync(manifestPath, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean);
    } catch {
        return 0;
    }

    let removed = 0;

    for (const target of new Set(recorded)) {
        if (!isOurScratchDirectory(target)) {
            continue;
        }

        try {
            // Retry generously. A server child is killed moments before this runs, and on Windows the
            // handles on its data root are not always released by the time the process is reaped — a
            // one-second budget left four of twenty-two directories behind, and every one of them
            // deleted cleanly seconds later. Only the stubborn ones pay for the longer budget.
            fs.rmSync(path.resolve(target), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
            removed++;
        } catch {
            // Cleanup is not the run's verdict. A directory we cannot remove is a wasted 29 MB, not a
            // failure, and throwing here would fail an otherwise green suite.
        }
    }

    try {
        fs.rmSync(manifestPath, { force: true });
    } catch {
        // Same reasoning.
    }

    return removed;
}

/**
 * Is a process still running?
 * @param {number} pid The process to ask about
 * @returns {boolean} True if it exists, or if we cannot tell
 */
export function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means it exists and is not ours to signal. Only ESRCH proves it is gone, and anything
        // we cannot interpret is treated as alive — leaking is the safe direction.
        return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
    }
}

/**
 * Clean up after runs that never got to clean up after themselves.
 *
 * `globalTeardown` handles the normal exit, including a run where every suite failed. It does NOT run
 * when the run is killed — Ctrl-C, a crashed Jest, a closed terminal, a reboot — and that run's
 * directories would otherwise sit in the temp directory forever, because nothing else can prove they
 * are safe to delete.
 *
 * The manifest's own filename carries the pid that owned it, which settles that question without any
 * guessing: if that process is gone, the run is over and its directories are unreachable garbage. A
 * concurrent run's process is by definition still alive, so this cannot touch it — which is the whole
 * reason an `st-*` glob was not an option.
 * @returns {number} How many directories were reclaimed
 */
export function reclaimOrphanedRuns() {
    const temp = os.tmpdir();
    /** @type {string[]} */
    let entries = [];

    try {
        entries = fs.readdirSync(temp);
    } catch {
        return 0;
    }

    let reclaimed = 0;

    for (const entry of entries) {
        const match = MANIFEST_PATTERN.exec(entry);

        if (!match) {
            continue;
        }

        if (isProcessAlive(Number.parseInt(match[1], 10))) {
            continue;
        }

        reclaimed += sweepManifest(path.join(temp, entry));
    }

    return reclaimed;
}

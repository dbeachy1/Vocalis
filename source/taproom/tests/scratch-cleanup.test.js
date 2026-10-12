import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, afterEach } from '@jest/globals';

import { newManifestPath, ownsManifest, reclaimOrphanedRuns, sweepManifest } from './util/scratch.js';

/**
 * 🧹 THE CLEANUP THAT HAS TO BE SAFE BEFORE IT IS THOROUGH.
 *
 * The suites here boot real servers against scratch data roots — ~211 files and ~29 MB each — and for a
 * long time nothing ever removed them: 243 directories, 7.6 GB, over five days.
 *
 * The obvious cleanup is a glob: delete `st-*` from the temp directory. It is also the one thing that
 * must never be written, because it deletes the LIVE scratch directories of a run happening at the same
 * time — another checkout, another terminal, CI on the same box — and takes that run down with it.
 *
 * So these tests are mostly about what the sweep REFUSES to touch. The thoroughness is easy; the
 * restraint is the part that would be expensive to get wrong, and the part a future reader is most
 * likely to "simplify" away.
 */
describe('🧹 scratch cleanup', () => {
    /** @type {string[]} */
    let litter = [];

    /**
     * Make a scratch directory with something in it, and remember to clean it up.
     * @param {string} label A hint for whoever finds it
     * @returns {string} The directory
     */
    function makeDirectory(label) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), `st-${label}-`));
        fs.writeFileSync(path.join(directory, 'payload.txt'), 'x', 'utf-8');
        litter.push(directory);
        return directory;
    }

    /**
     * Write a manifest naming the given directories, owned by the given pid.
     * @param {number} pid The owning process
     * @param {string[]} directories What it created
     * @returns {string} The manifest path
     */
    function makeManifest(pid, directories) {
        const manifestPath = path.join(os.tmpdir(), `st-run-${pid}-${Date.now()}.manifest`);
        fs.writeFileSync(manifestPath, directories.map(directory => `${directory}\n`).join(''), 'utf-8');
        litter.push(manifestPath);
        return manifestPath;
    }

    /**
     * A pid that is definitely not running: start a process, then wait for it to be gone.
     * @returns {Promise<number>} The dead process's pid
     */
    async function deadPid() {
        const child = spawn(process.execPath, ['-e', '']);
        const pid = /** @type {number} */ (child.pid);
        await new Promise(resolve => child.once('exit', resolve));
        return pid;
    }

    afterEach(() => {
        for (const target of litter) {
            try {
                fs.rmSync(target, { recursive: true, force: true });
            } catch {
                // Best effort — this is the test's own litter, not the subject.
            }
        }

        litter = [];
    });

    test('sweeps exactly what the manifest records, and the manifest with it', () => {
        const mine = makeDirectory('sweep-mine');
        const manifestPath = makeManifest(process.pid, [mine]);

        expect(sweepManifest(manifestPath)).toBe(1);
        expect(fs.existsSync(mine)).toBe(false);
        expect(fs.existsSync(manifestPath)).toBe(false);
    });

    test('leaves a scratch directory it was never told about', () => {
        const recorded = makeDirectory('sweep-recorded');
        const unrecorded = makeDirectory('sweep-unrecorded');

        sweepManifest(makeManifest(process.pid, [recorded]));

        // Same prefix, same temp directory, one character apart from the one that was deleted. A glob
        // would have taken it; only the manifest distinguishes them.
        expect(fs.existsSync(unrecorded)).toBe(true);
    });

    test('refuses a recorded path that is not a scratch directory in the temp directory', () => {
        const outsider = fs.mkdtempSync(path.join(os.tmpdir(), 'not-ours-'));
        const nested = path.join(os.tmpdir(), 'st-decoy-nested', 'st-deeper');
        fs.mkdirSync(nested, { recursive: true });
        litter.push(outsider, path.join(os.tmpdir(), 'st-decoy-nested'));

        // A manifest is a file, and a file can be truncated, interleaved by concurrent appends, or just
        // wrong. It does not get to name an arbitrary path for a recursive delete.
        expect(sweepManifest(makeManifest(process.pid, [outsider, nested, os.homedir()]))).toBe(0);
        expect(fs.existsSync(outsider)).toBe(true);
        expect(fs.existsSync(nested)).toBe(true);
        expect(fs.existsSync(os.homedir())).toBe(true);
    });

    test('reclaims the directories of a run whose process is gone', async () => {
        const abandoned = makeDirectory('reclaim-abandoned');
        const manifestPath = makeManifest(await deadPid(), [abandoned]);

        // This is the case globalTeardown cannot cover: Ctrl-C, a crashed Jest, a closed terminal. If
        // the next run does not reclaim these, nothing ever will and the temp directory grows forever.
        expect(reclaimOrphanedRuns()).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(abandoned)).toBe(false);
        expect(fs.existsSync(manifestPath)).toBe(false);
    });

    test('🔴 does NOT reclaim the directories of a run that is still going', () => {
        const live = makeDirectory('reclaim-live');

        // Owned by a process that is very much alive: this one. A concurrent run's directories look
        // exactly like this, and deleting them would break a run that has done nothing wrong.
        const manifestPath = makeManifest(process.pid, [live]);

        reclaimOrphanedRuns();

        expect(fs.existsSync(live)).toBe(true);
        expect(fs.existsSync(manifestPath)).toBe(true);
    });

    test('owns the manifest it named itself', () => {
        // Nothing is created here — the name alone answers the question, which is the point: the pid is in
        // the filename precisely so ownership never depends on remembering anything.
        expect(ownsManifest(newManifestPath())).toBe(true);
    });

    test('🔴 does NOT own a manifest it merely INHERITED', () => {
        const sibling = makeDirectory('inherited-sibling');
        const inherited = makeManifest(process.ppid, [sibling]);

        // This is exactly what a `run-browser-specs.mjs` child finds in `ST_TEST_SCRATCH_MANIFEST`: a real
        // manifest, full of real directories, every one of them somebody else's. Eight children share it,
        // so a teardown that swept whatever it was handed would delete seven live data roots the moment
        // the first spec finished — and the six failures afterwards would read as servers dying on their
        // own. The pid in the name is what separates "the manifest I was given" from "the manifest I own".
        expect(ownsManifest(inherited)).toBe(false);
        expect(fs.existsSync(sibling)).toBe(true);
    });

    test('does not own a file in the temp directory that is not a manifest at all', () => {
        expect(ownsManifest(path.join(os.tmpdir(), `st-run-${process.pid}.manifest`))).toBe(false);
        expect(ownsManifest(path.join(os.tmpdir(), `st-not-a-manifest-${process.pid}`))).toBe(false);
    });
});

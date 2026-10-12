/**
 * Run the fork's server-booting browser specs, each in its OWN Playwright process, several at a time.
 *
 * These specs each boot a real SillyTavern server in `beforeAll` and tear it down in `afterAll`. A fresh
 * Playwright process per spec prevents server-child state and ports from leaking across specs on Windows;
 * it does not retry failed assertions.
 *
 * The parent run reserves a port slot and assigns a distinct band to each child. Each child starts its own
 * Playwright run at worker index 0, so the explicit band keeps parallel specs from colliding.
 *
 * ⚠️ OUTPUT IS BUFFERED PER CHILD AND PRINTED WHOLE. Eight `stdio: 'inherit'` children interleave their
 * reporters line by line into something no one can read. The cost is that nothing appears for a spec until
 * it finishes; the log stays a sequence of complete, attributable spec results.
 *
 * These specs require Playwright's browser binaries. Unit and integration suites do not use this runner.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { newManifestPath, ownsManifest, reclaimOrphanedRuns, sweepManifest } from './util/scratch.js';
import { claimPortSlot, PORT_BAND_SIZE, releasePortSlot } from './util/st-server.js';
import { serverBootingSpecs } from './util/server-booting-specs.js';
import { workerCount } from './util/worker-count.js';

/**
 * Playwright's CLI entry point, resolved rather than assumed so a hoisted or nested install is found
 * wherever npm put it.
 *
 * ⚠️ VIA `package.json`, NOT `playwright/cli.js`. The package's `exports` map does not list `./cli.js`,
 * so asking for it directly is `ERR_PACKAGE_PATH_NOT_EXPORTED` — the file is right there and the
 * resolver refuses to name it. `./package.json` is exported by convention, and its directory is the
 * package root.
 */
const PLAYWRIGHT_CLI = path.join(
    path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')),
    'cli.js',
);

/** Derived by reading the specs — see `util/server-booting-specs.js` for why there is no list here. */
const SPECS = serverBootingSpecs();
const CONCURRENCY = Math.max(1, Math.min(workerCount(), SPECS.length));

/**
 * How long a child may take to get a server accepting connections.
 *
 * The serial runner could leave this at the flat 60s default, because a spec booting alone on an idle box
 * is done in about four seconds. Under {@link CONCURRENCY} concurrent boots it is the loaded case, which
 * is what jest's own scaling exists for — so the same formula is passed down through the documented
 * `ST_TEST_BOOT_TIMEOUT_MS` override rather than left to a default written for the idle one.
 * @returns {number} Milliseconds
 */
function bootTimeoutMs() {
    if (CONCURRENCY === 1) {
        return 60_000;
    }

    const threads = os.availableParallelism?.() ?? os.cpus().length;
    return Math.min(200_000, 60_000 + 8_000 * Math.max(0, threads - 8));
}

const runBase = claimPortSlot();
const bootTimeout = String(bootTimeoutMs());

/**
 * ONE manifest for the whole run, handed down with the port band.
 *
 * 🔴 EVERY SPEC BELOW MAKES A ~30 MB DATA ROOT AND NOTHING EVER REMOVED ONE. `makeScratchDirectory` records
 * what it creates only when this variable names a file, and until it did, each root was invisible to both
 * removal paths at once — no teardown to read a manifest, and no manifest for the next run's reclaim to
 * find. 292 directories and 8.75 GB accumulated in five days of green runs, because a leak fails nothing.
 *
 * One manifest rather than one per child, for the same reason there is one port slot: the children are
 * this process's business, and the sweep belongs where the `cacheRoot` sweep already is, at the end of the
 * whole run. {@link ownsManifest} is what keeps the eight children from sweeping it out from under each
 * other — they inherit this path, and an inherited manifest is never a child's to delete.
 */
const manifestPath = process.env.ST_TEST_SCRATCH_MANIFEST ?? newManifestPath();
process.env.ST_TEST_SCRATCH_MANIFEST = manifestPath;

if (ownsManifest(manifestPath)) {
    // Only when the manifest is ours: a wrapper that handed us one has already done this, and a second
    // pass would be reading the temp directory to no purpose.
    const reclaimed = reclaimOrphanedRuns();

    if (reclaimed > 0) {
        console.log(`Reclaimed ${reclaimed} scratch ${reclaimed === 1 ? 'directory' : 'directories'} from a run that did not finish.`);
    }
}

/**
 * A private Playwright transform cache per child.
 *
 * 🔴 THE SHARED ONE IS NOT SAFE TO START EIGHT PROCESSES AGAINST AT ONCE, AND IT FAILS AS A SYNTAX ERROR
 * IN CODE THAT HAS NONE. Playwright transpiles the config and every module it imports into
 * `os.tmpdir()/playwright-transform-cache`, keyed by content. Eight children launched in the same
 * millisecond all miss, all transform the same files, and all write them — and three of the eight read a
 * half-written entry: `SyntaxError: The requested module './util/server-booting-specs.js' does not provide
 * an export named 'serverBootingSpecs'`, from a file that exports exactly that, in a package that is
 * `type: module`. Every plausible reading of that message is about ESM interop and every one of them is
 * wrong; the file was simply half there. A cache per child cannot be raced, and re-transpiling a handful
 * of small modules costs nothing next to booting a server.
 */
const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pw-cache-'));

/**
 * A private artifact directory per child, under the one Playwright would have used anyway.
 *
 * 🔴 THE SHARED ONE IS RACED THE SAME WAY THE TRANSFORM CACHE WAS, AND IT KILLS WHOLE SPECS. Playwright
 * empties its `outputDir` at the start of every run, and twelve children starting in the same
 * millisecond all empty the same `tests/test-results` — so one of them is walking the directory another
 * has just removed: `Error: ENOENT: no such file or directory, scandir '…/tests/test-results'`, before a
 * single test runs. Measured at two of the first twelve, on a run whose 23 other specs passed; the two
 * look like ordinary spec failures and are nothing of the kind.
 *
 * ⚠️ A SUBDIRECTORY, NOT A TEMP DIRECTORY. Videos and screenshots of a failure are the point of this
 * folder, so they have to survive the run and be where someone would look for them. Nobody scans the
 * parent, so nobody can race on it.
 */
const outputRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-results');

/**
 * Run one spec in its own Playwright process, on its own port band.
 * @param {string} spec Spec base name
 * @param {number} index Its position in this run, which is also its band
 * @returns {Promise<{spec: string, ok: boolean, output: string}>} How it went
 */
function runSpec(spec, index) {
    return new Promise((resolve) => {
        // `ST_BROWSER_SPEC` opts the server-booting specs back in: `playwright.config.js` ignores them by
        // default so a bare `playwright test` cannot sweep them up with the DOM-only ones.
        //
        // Node runs Playwright's CLI directly rather than going through `npx` and a shell: eight shells
        // is eight processes doing nothing, and `spawn` with an argument array under `shell: true` warns
        // (DEP0190) because it concatenates rather than escapes them — a spec name is ours, but the fix
        // is free.
        const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', spec, '--workers=1', '--output', path.join(outputRoot, spec)], {
            env: {
                ...process.env,
                ST_BROWSER_SPEC: '1',
                ST_TEST_PORT_BASE: String(runBase + index * PORT_BAND_SIZE),
                ST_TEST_BOOT_TIMEOUT_MS: bootTimeout,
                PWTEST_CACHE_DIR: path.join(cacheRoot, String(index)),
            },
        });

        let output = '';
        child.stdout.on('data', chunk => output += chunk.toString());
        child.stderr.on('data', chunk => output += chunk.toString());
        child.on('close', code => resolve({ spec, ok: code === 0, output }));
    });
}

const queue = SPECS.map((spec, index) => ({ spec, index }));
const failed = [];

console.log(`Running ${SPECS.length} browser specs, ${CONCURRENCY} at a time, one process each.`);

/**
 * Take specs off the shared queue until it is empty. One of these runs per concurrent slot.
 * @returns {Promise<void>}
 */
async function drain() {
    for (let next = queue.shift(); next; next = queue.shift()) {
        const result = await runSpec(next.spec, next.index);

        console.log(`\n─── ${result.spec} ───\n`);
        console.log(result.output.trimEnd());

        if (!result.ok) {
            failed.push(result.spec);
        }
    }
}

try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => drain()));
} finally {
    // Transpiled copies of this repo's own modules, worth nothing once the run is over.
    fs.rmSync(cacheRoot, { recursive: true, force: true });

    // And the data roots the children made, which are 8.75 GB of the same kind of nothing. The transform
    // cache next to them has been swept since the day it was written; these were not, which is the whole
    // shape of the bug — the cleanup site already existed and the bigger litter was not brought to it.
    if (ownsManifest(manifestPath)) {
        const removed = sweepManifest(manifestPath);

        if (removed > 0) {
            console.log(`Removed ${removed} scratch ${removed === 1 ? 'directory' : 'directories'}.`);
        }
    }

    // And the slot claimed at the top, which was never handed back — every run left an `st-portslot-N.lock`
    // behind. Harmless in the end, because `claimPortSlot` reclaims a slot whose owner is dead, but a run
    // that has to walk past other people's abandoned locks to find a free slot is one that eventually
    // overlaps a live one for no reason. Matches on the pid inside the lock, so it can only release ours.
    releasePortSlot();
}

console.log('');
if (failed.length > 0) {
    console.error(`FAILED: ${failed.join(', ')}`);
    process.exit(1);
}
console.log(`All ${SPECS.length} browser specs passed, each in its own process.`);

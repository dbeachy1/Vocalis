import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from './scratch.js';

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every Jest worker is its own process, so the only way two workers can hand out the same port is if
 * they are drawing from the same pool. They are not: each worker gets a private band, derived from its
 * worker id, and never looks outside it. That turns a cross-process race into a single-process one,
 * which the reservation set below closes completely.
 *
 * Worker IDs repeat across concurrent test runs, so a worker-only band can still collide. A per-run slot
 * offsets each worker's band and keeps independently started runs separate.
 *
 * So the band is offset per RUN as well: {@link claimPortSlot} takes one of the slots below — wide
 * enough for every worker this run will have — and hands its base down through the environment. The
 * claim is a lock file named for the owning pid, which is the trick the scratch manifest already uses
 * and settles the same question: a slot whose owner is gone is free, and a live run's slot can never be
 * taken from it.
 *
 * The bands stay under 32768 deliberately — that is where Linux starts allocating ephemeral ports, and
 * a band that overlapped it would be racing the kernel instead of the other workers.
 */
export const PORT_BAND_SIZE = 48;
const PORT_FLOOR = 20_000;
const PORT_SPAN = 32_768 - PORT_FLOOR;
const SLOT_PREFIX = 'st-portslot-';
const SLOT_PATTERN = /^st-portslot-(\d+)\.lock$/;

/**
 * How many workers a slot is sized for.
 *
 * ⚠️ FIXED, NEVER the run's actual worker count. A run with 12 workers and a run with 1 have to agree
 * on where slot 1 begins, or the narrow run's slot 1 lands inside the wide run's slot 0 and the whole
 * scheme hands out the same ports it was built to keep apart. `jest.config.mjs` caps workers at 12, so
 * 16 is headroom; past 16 the wrap in {@link bandBase} shares bands within a run, which is the old
 * behaviour rather than a new failure.
 */
const SLOT_WORKERS = 16;
const SLOT_WIDTH = SLOT_WORKERS * PORT_BAND_SIZE;
const SLOT_COUNT = Math.max(1, Math.floor(PORT_SPAN / SLOT_WIDTH));
const WORKER_ID = workerId();
const PORT_BAND_BASE = bandBase();

/**
 * Which concurrent worker slot this process is, one-based.
 *
 * 🔴 IT IS NOT ONLY JEST THAT RUNS THESE IN PARALLEL, AND ASSUMING SO COST THE BROWSER SUITE ITS
 * PARALLELISM ENTIRELY. Playwright never sets `JEST_WORKER_ID`, so every Playwright worker read the
 * default of 1, computed the SAME band, and handed the others its ports — one spec reaching another
 * spec's server and asserting against the wrong fixture. `run-browser-specs.mjs` was written around
 * that by never having two workers: seven server-booting specs, one at a time, four and a half minutes
 * of a sixteen-core machine idling. The banding was right; it was looking for the wrong variable.
 *
 * `TEST_PARALLEL_INDEX` is Playwright's slot number — zero-based, bounded by `--workers`, and REUSED
 * when a worker is replaced, which is exactly the property a band needs. (`TEST_WORKER_INDEX` counts
 * every worker ever started, so it climbs past the band count on a retry-heavy run and wraps into
 * somebody else's ports.)
 * @returns {number} This process's worker slot, one-based
 */
function workerId() {
    const jest = Number.parseInt(process.env.JEST_WORKER_ID ?? '', 10);

    if (Number.isFinite(jest)) {
        return Math.max(1, jest);
    }

    const playwright = Number.parseInt(process.env.TEST_PARALLEL_INDEX ?? '', 10);

    if (Number.isFinite(playwright)) {
        return Math.max(1, playwright + 1);
    }

    return 1;
}

/**
 * Where this worker's band starts.
 *
 * `ST_TEST_PORT_BASE` is this run's slot, set by `globalSetup`. It is absent when a suite is run without
 * that hook, and the floor is then the same pool every run used before slots existed — no worse than it
 * was, and still per-worker.
 * @returns {number} First port of this worker's band
 */
function bandBase() {
    const runBase = Number.parseInt(process.env.ST_TEST_PORT_BASE ?? '', 10);
    const base = Number.isFinite(runBase) ? runBase : PORT_FLOOR;

    // Wrap inside the range rather than trusting the arithmetic. A worker id beyond the width the slot
    // was sized for has to land on a usable port, never above the ephemeral floor.
    return PORT_FLOOR + ((base - PORT_FLOOR + (WORKER_ID - 1) * PORT_BAND_SIZE) % (PORT_SPAN - PORT_BAND_SIZE));
}

/**
 * Take a port range for this run and return where it starts.
 *
 * Called once, from `globalSetup`, in the main process — the pid recorded has to be the one that
 * outlives every worker, or the slot is released while suites are still booting into it.
 *
 * 🔴 THE PID GOES INSIDE THE FILE, NEVER IN ITS NAME. A first version wrote
 * `st-portslot-<slot>-<pid>.lock` and trusted `wx` to make the claim exclusive. It cannot: two runs
 * claiming the same slot write two DIFFERENT filenames, both succeed, and both are handed port 20000.
 * That is not a smaller version of the bug this function exists to fix, it is the same bug with a lock
 * file next to it — measured, both runs reporting `band=20000`. One name per slot is what makes `wx`
 * mean anything.
 * @returns {number} First port of this run's range
 */
export function claimPortSlot() {
    const temp = os.tmpdir();

    for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const lockPath = path.join(temp, `${SLOT_PREFIX}${slot}.lock`);

        if (tryClaim(lockPath)) {
            return PORT_FLOOR + slot * SLOT_WIDTH;
        }

        /** @type {number} */
        let owner = Number.NaN;

        try {
            owner = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        } catch {
            continue;
        }

        // A slot whose owner is gone is free — the same question the scratch manifest asks, answered the
        // same way. Anything we cannot read the owner of is left alone.
        if (!Number.isFinite(owner) || isProcessAlive(owner)) {
            continue;
        }

        try {
            fs.rmSync(lockPath);
        } catch {
            continue;
        }

        if (tryClaim(lockPath)) {
            return PORT_FLOOR + slot * SLOT_WIDTH;
        }
    }

    // Every slot is spoken for. Overlap rather than refuse to run: `canBind` and the boot-collision retry
    // are still there, and they are what this scheme makes rare rather than replaces.
    return PORT_FLOOR + (process.pid % SLOT_COUNT) * SLOT_WIDTH;
}

/**
 * Write our pid into a slot lock, if nobody else holds it.
 * @param {string} lockPath The lock file for the slot
 * @returns {boolean} True if the slot is now ours
 */
function tryClaim(lockPath) {
    try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Hand this run's port range back, from `globalTeardown`.
 *
 * Matches on the pid INSIDE the file rather than remembering a path, so a teardown that never saw the
 * setup still releases the right slot and never someone else's.
 * @returns {void}
 */
export function releasePortSlot() {
    const temp = os.tmpdir();
    /** @type {string[]} */
    let entries = [];

    try {
        entries = fs.readdirSync(temp);
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!SLOT_PATTERN.test(entry)) {
            continue;
        }

        const lockPath = path.join(temp, entry);

        try {
            if (Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10) === process.pid) {
                fs.rmSync(lockPath);
            }
        } catch {
            // A leaked lock costs one slot until the next run finds the owner dead and reclaims it.
        }
    }
}

/** Ports this worker has handed out and not yet got back. */
const reservedPorts = new Set();
let portCursor = 0;

/**
 * How long to wait for a boot before calling it dead.
 *
 * 60s is generous for one server and far too tight for twenty-five of them: a boot that takes four
 * seconds in isolation took sixty-five when the whole suite ran in parallel on a 32-thread machine, and
 * the harness called a perfectly healthy server dead. Scale the ceiling with the hardware, because the
 * worker count scales with it too.
 *
 * This costs nothing when things are healthy — the wait loop breaks the moment the server accepts a
 * connection, and breaks the moment the child dies. It is a ceiling, not a delay. The cap sits below
 * the 240s the suites give their `beforeAll` hooks, so a real hang still fails as a harness error with
 * the child's output attached rather than as a bare Jest timeout.
 * @returns {number} Milliseconds to wait for a server to start accepting connections
 */
function defaultBootTimeoutMs() {
    const override = Number.parseInt(process.env.ST_TEST_BOOT_TIMEOUT_MS ?? '', 10);

    if (Number.isFinite(override) && override > 0) {
        return override;
    }

    if (!process.env.JEST_WORKER_ID) {
        return 60_000;
    }

    const threads = os.availableParallelism?.() ?? os.cpus().length;
    return Math.min(200_000, 60_000 + 8_000 * Math.max(0, threads - 8));
}

/**
 * Boots a real SillyTavern, as a real subprocess, against a scratch data root.
 *
 * Nothing else in this repository boots SillyTavern — the "mock server" in this same directory is a
 * fake *LLM* endpoint, and Playwright expects you to have started a server by hand. But the storage
 * provider's entire contract is about what happens during boot, so the boot is the thing that has to
 * be tested, and it has to be the real one: the actual `server.js`, the actual promise chain, the
 * actual maintenance tasks. Importing modules and calling functions would prove nothing.
 */

/**
 * A booted SillyTavern.
 * @typedef {object} BootResult
 * @property {boolean} listening Did the server get far enough to accept a TCP connection?
 * @property {number|null} exitCode The process's exit code, if it exited on its own
 * @property {string} output Everything it wrote to stdout and stderr, combined
 */

/**
 * Can this process bind this port right now?
 * @param {number} port The port to try
 * @returns {Promise<boolean>} True if the bind succeeded
 */
async function canBind(port) {
    return await new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
}

/**
 * Ask the kernel for any free port.
 * @returns {Promise<number>} Whatever it gave us
 */
async function anyFreePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}

/**
 * Find a free TCP port, out of this worker's private band.
 *
 * ⚠️ The obvious implementation — bind `:0`, read the port, close, hand it back — is a TOCTOU race, and
 * it is the one that made three suites fail in the parallel run. The port is *released* by the probe and
 * only re-bound by the spawned child some milliseconds later, so any other worker probing in that window
 * can be handed the same number. The loser's child dies on EADDRINUSE before it ever listens, and the
 * suite reports a boot failure for code that was never reached. Negligible at two workers, routine at
 * twenty-five.
 *
 * So: draw from a band no other worker draws from, and remember what we handed out until it comes back.
 * `canBind` still has a window, but only against processes outside the band, and {@link startSillyTavern}
 * retries if one of those wins.
 *
 * The caller owns the port until it calls {@link releasePort}.
 * @returns {Promise<number>} A port nobody is listening on
 */
export async function getFreePort() {
    for (let offset = 0; offset < PORT_BAND_SIZE; offset++) {
        const port = PORT_BAND_BASE + ((portCursor + offset) % PORT_BAND_SIZE);

        if (reservedPorts.has(port) || !await canBind(port)) {
            continue;
        }

        portCursor = (portCursor + offset + 1) % PORT_BAND_SIZE;
        reservedPorts.add(port);
        return port;
    }

    // The whole band is spoken for. Fall back rather than fail: an ephemeral port is worse, not useless.
    return await anyFreePort();
}

/**
 * Hand a port back to this worker's band.
 * @param {number} port The port to release
 * @returns {void}
 */
export function releasePort(port) {
    reservedPorts.delete(port);
}

/**
 * Create a scratch directory that will not collide with a parallel test worker.
 *
 * Records the directory in this run's manifest so `globalTeardown` can remove it. That is the only
 * thing that ever removes these — an `afterAll` cannot, because a suite that times out or crashes
 * never reaches one, and that is exactly the suite that leaks.
 * @param {string} label A hint for whoever finds it in the temp directory
 * @returns {string} Path to a fresh, empty directory
 */
export function makeScratchDirectory(label) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `st-${label}-`));
    const manifestPath = process.env.ST_TEST_SCRATCH_MANIFEST;

    if (manifestPath) {
        try {
            // O_APPEND, so the workers can all write to this without coordinating. One short line per
            // directory, which is within the size a single append delivers atomically.
            fs.appendFileSync(manifestPath, `${directory}\n`, 'utf-8');
        } catch {
            // An unrecorded directory leaks. That is a worse outcome than recording it, and a better
            // one than failing a suite over housekeeping.
        }
    }

    return directory;
}

/**
 * Can we open a TCP connection to this port?
 *
 * This is the readiness check, and it is deliberately a socket probe rather than a scrape of the log
 * output. A log line is a claim; an accepted connection is the server actually being up.
 * @param {number} port Port to probe
 * @returns {Promise<boolean>} True if something accepted the connection
 */
async function isAccepting(port) {
    return await new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const done = (result) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(500);
        socket.on('connect', () => done(true));
        socket.on('error', () => done(false));
        socket.on('timeout', () => done(false));
    });
}

/**
 * A SillyTavern that is up and taking requests.
 * @typedef {object} RunningServer
 * @property {number} port The port it is listening on
 * @property {boolean} listening Did it get far enough to accept a TCP connection?
 * @property {() => string} output Everything it has written to stdout and stderr so far
 * @property {() => Promise<BootResult>} stop Shut it down and collect the result
 */

/**
 * Start SillyTavern against a data root and wait for it to come up (or fall over). The caller is
 * responsible for calling stop().
 *
 * The boot gate needs this rather than a boot-and-die helper, because the code that actually destroys
 * the user's data does not run at boot. data-maid's orphan sweep, the vector index that deletes itself,
 * the character cache that repairs itself into cleartext — all of them are REQUEST-time paths. A gate
 * that never makes an HTTP request has never once exercised them.
 * @param {object} options Boot options
 * @param {string} options.dataRoot The data root to boot against
 * @param {string} options.configPath Path to a config.yaml — created by SillyTavern if absent
 * @param {string} [options.storageProvidersPath] Directory holding a storage provider, if any
 * @param {string} [options.journalPath] Where the provider fixture should record every call it receives
 * @param {boolean} [options.enableUserAccounts] Turn on real accounts, so there is a login and a password
 * @param {Record<string, string>} [options.providerEnv] Extra environment for the provider fixture, which
 * runs in the child process and cannot be configured any other way
 * @param {Record<string, string>} [options.configEnv] Config keys to set on the child, in the
 * `SILLYTAVERN_SECTION_KEY` form `keyToEnv` builds. Distinct from `providerEnv` because it configures
 * SillyTavern rather than a fixture: the logging block in particular is read before `--configPath` is
 * even parsed, so a test that needs its own log file has no other way to ask for one.
 * @param {number} [options.timeoutMs] How long to wait for the server to start accepting connections.
 * Defaults to a ceiling scaled to the machine's thread count — see {@link defaultBootTimeoutMs}.
 * @returns {Promise<RunningServer>} The running server
 */
export async function startSillyTavern({ dataRoot, configPath, storageProvidersPath, pluginsPath, journalPath, enableUserAccounts, providerEnv, configEnv, timeoutMs }) {
    // Require an explicit config path so a missing argument cannot create a file in the caller's cwd.
    if (typeof configPath !== 'string' || configPath.length === 0) {
        throw new Error('startSillyTavern requires a configPath — pass one inside your scratch directory. Without it the child writes a config file named "undefined" into the current working directory.');
    }

    const deadline = timeoutMs ?? defaultBootTimeoutMs();

    // If we lose a port to something outside our band, that is not a boot failure — it is a bad draw.
    // Take another one. A server that genuinely cannot boot fails identically on every attempt, so this
    // cannot turn a real failure into a green run; it only stops a collision from being reported as one.
    for (let attempt = 1; ; attempt++) {
        const server = await attemptBoot({ dataRoot, configPath, storageProvidersPath, pluginsPath, journalPath, enableUserAccounts, providerEnv, configEnv, timeoutMs: deadline });

        // 🔴 A COLLISION OUTRANKS `listening`, AND GETTING THAT PRECEDENCE WRONG IS THE WHOLE BUG.
        //
        // `listening` means "something accepted a connection on that port" — it does NOT mean our child
        // did. When the port was already taken, the FOREIGN listener answers the probe, this loop used
        // to short-circuit on `server.listening` and hand back a "booted" server whose actual child had
        // died on EADDRINUSE. The caller then talks to a stranger: a seed boot appears to succeed while
        // laying down no data root at all, and the failure surfaces hundreds of lines later as an
        // undefined account rather than as the port collision it is.
        //
        // The child's own words are the authority here, so they are consulted FIRST. `attemptBoot` also
        // refuses to call an exited child `listening`, which closes the same hole from the other side.
        const collided = /already in use|EADDRINUSE/i.test(server.output());

        if (!collided || attempt >= 3) {
            return server;
        }

        await server.stop();
    }
}

/**
 * One attempt at booting a server on one port.
 * @param {object} options Boot options — see {@link startSillyTavern}
 * @param {string} options.dataRoot The data root to boot against
 * @param {string} options.configPath Path to a config.yaml
 * @param {string} [options.storageProvidersPath] Directory holding a storage provider, if any
 * @param {string} [options.journalPath] Where the provider fixture should record its calls
 * @param {boolean} [options.enableUserAccounts] Turn on real accounts
 * @param {Record<string, string>} [options.providerEnv] Extra environment for the provider fixture
 * @param {Record<string, string>} [options.configEnv] Config keys to set on the child
 * @param {number} options.timeoutMs How long to wait for it to start accepting connections
 * @returns {Promise<RunningServer>} The server, listening or not
 */
async function attemptBoot({ dataRoot, configPath, storageProvidersPath, pluginsPath, journalPath, enableUserAccounts, providerEnv, configEnv, timeoutMs }) {
    const port = await getFreePort();

    const env = {
        ...process.env,
        // Keep the boot hermetic and quiet: no browser, no listening on a LAN interface, no auto-update
        // of the plugins directory, and above all no reaching for the user's real data root.
        SILLYTAVERN_DATAROOT: dataRoot,
        SILLYTAVERN_LISTEN: 'false',
        SILLYTAVERN_BROWSERLAUNCH_ENABLED: 'false',
        SILLYTAVERN_ENABLESERVERPLUGINS: 'false',
        NODE_ENV: 'test',
    };

    // 🔴 ALWAYS SET, EVEN WHEN THE TEST DID NOT ASK FOR A PROVIDER — otherwise the boot inherits the
    // fork's default, which is `<serverDirectory>/storage-providers`: the REAL directory a real
    // deployment installs into.
    //
    // Tests that omit providers must get a deterministic empty provider directory regardless of local
    // installations; otherwise an installed provider changes unrelated suites.
    //
    // The fallback is a path that deliberately does NOT exist: `loadStorageProviders` returns early on
    // a missing directory, so this reproduces "no provider installed" exactly, on any machine,
    // regardless of what is really sitting in the repository.
    env.SILLYTAVERN_STORAGEPROVIDERSPATH = storageProvidersPath || path.join(dataRoot, 'no-storage-providers-installed');

    // Use an explicit plugin directory as well; installed plugins do not honor `ST_FIXTURE_IDS` and can
    // otherwise change unrelated suite behavior.
    env.SILLYTAVERN_PLUGINSPATH = pluginsPath || path.join(dataRoot, 'no-plugins-installed');

    if (journalPath) {
        env.ST_HOSTILE_JOURNAL = journalPath;
        env.ST_LOCKED_JOURNAL = journalPath;
    }

    if (enableUserAccounts) {
        env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'true';
    }

    // The provider runs in the CHILD process, so anything a fixture needs to be told has to be handed
    // across the process boundary. This is the seam for that.
    Object.assign(env, providerEnv ?? {});

    // Config keys the child must have before it reads `--configPath`. `getConfigValue` checks the
    // environment first, so this wins over whatever ends up in the scratch config.yaml.
    Object.assign(env, configEnv ?? {});

    const child = spawn(process.execPath, [
        'server.js',
        `--dataRoot=${dataRoot}`,
        `--configPath=${configPath}`,
        `--port=${port}`,
        '--listen=false',
        '--autorun=false',
        // The gate drives POST endpoints directly. CSRF is a browser concern and simulating the token
        // dance would test the token dance, not the storage funnel.
        '--disableCsrf',
    ], {
        cwd: serverDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    /** @type {number|null} */
    let exitCode = null;
    let exited = false;

    child.stdout.on('data', chunk => output += chunk.toString());
    child.stderr.on('data', chunk => output += chunk.toString());
    child.on('exit', (code) => {
        exited = true;
        exitCode = code;
    });

    // Wait for it to accept a connection, or to die trying.
    const deadline = Date.now() + timeoutMs;
    let listening = false;

    while (Date.now() < deadline && !exited) {
        if (await isAccepting(port)) {
            listening = true;
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    // 🔴 A CHILD THAT IS GONE IS NOT SERVING ANYTHING, whatever answered the probe.
    //
    // `isAccepting` asks a PORT, not a process, so on a contended port it can be satisfied by a stranger
    // while our own child is busy dying on EADDRINUSE. Requiring the child to still be alive is what
    // makes `listening` a statement about the server this function actually started. Without it the
    // harness reports a boot that never happened, which is `PLAN_INTEGRATION_TESTS.md` §4 — a thing that
    // could not run, reporting green — committed by the test harness itself.
    if (exited) {
        listening = false;
    }

    return {
        port,
        listening,
        output: () => output,
        stop: async () => {
            await shutDown(child, exited);
            releasePort(port);
            return { listening, exitCode, output };
        },
    };
}

/**
 * Boot SillyTavern, wait for it to come up, and shut it straight down again.
 * @param {object} options Boot options — see {@link startSillyTavern}
 * @param {string} options.dataRoot The data root to boot against
 * @param {string} options.configPath Path to a config.yaml
 * @param {string} [options.storageProvidersPath] Directory holding a storage provider, if any
 * @param {string} [options.journalPath] Where the hostile provider should record its calls
 * @param {number} [options.timeoutMs] How long to wait for it to start accepting connections
 * @returns {Promise<BootResult>} What happened
 */
export async function bootSillyTavern(options) {
    const server = await startSillyTavern(options);
    return await server.stop();
}

/**
 * Stop the server and wait for it to be gone.
 *
 * ⚠️ A KNOWN LIMITATION, STATED SO NOBODY TRUSTS THIS GATE FURTHER THAN IT DESERVES.
 *
 * SillyTavern flushes state on the way out: `statsOnExit()` writes stats.json and the chat backup queue
 * drains. We would like to observe those writes. On Linux — which is what test-host runs, and where this
 * gate will run in anger — SIGINT reaches the child and its exit handlers do run.
 *
 * On WINDOWS they do not. Node maps `child.kill()` onto `TerminateProcess`, which is unconditional:
 * there is no signal to catch and no handler fires. So on Windows this gate covers the BOOT path only,
 * and exit-time writes are simply not exercised.
 *
 * That is acceptable, because the boot path is what the gate is actually for — all six of the
 * destructive code paths fire during boot, before the server ever accepts a connection. But it does
 * mean a green run on test-host-2 is a weaker statement than a green run on test-host, and the exit-time writes need
 * their own coverage at F4.
 * @param {import('node:child_process').ChildProcess} child The server process
 * @param {boolean} alreadyExited Whether it has already gone
 * @returns {Promise<void>}
 */
async function shutDown(child, alreadyExited) {
    if (alreadyExited || child.exitCode !== null) {
        return;
    }

    const gone = new Promise(resolve => child.once('exit', resolve));

    // SIGINT is what SillyTavern installs its exit handlers for. On Windows there is no real signal
    // delivery to a detached child, but Node emulates termination well enough for our purposes, and
    // the exit handlers do run.
    child.kill('SIGINT');

    const timer = new Promise(resolve => setTimeout(resolve, 10_000).unref?.());
    const raced = await Promise.race([gone.then(() => 'exited'), timer.then(() => 'timeout')]);

    if (raced === 'timeout') {
        child.kill('SIGKILL');
        await gone;
    }
}

/**
 * Step a scratch data root past first-run onboarding, waiting for the settings file to exist first.
 *
 * 🔴 STEP PAST ONBOARDING, OR NOTHING A BROWSER SPEC DOES WILL RUN. A fresh data root is a FIRST RUN;
 * `getSettings()` ends in `doOnboarding()`, which waits for a human to fill in a form. Headless never
 * does, so `firstLoadInit` blocks there for ever and no extension, panel or player bar ever initialises.
 *
 * 🔴 AND IT HAS TO WAIT, WHICH EIGHT HAND-ROLLED COPIES OF THIS DID NOT. `startSillyTavern` returns when
 * the PORT accepts a connection, and the default user's `settings.json` is copied in by the content
 * migration, which is still running at that moment. Read the tree right then and there may be no settings
 * file to rewrite — the walk finds nothing, onboarding is never disabled, and the spec fails much later
 * with something that looks nothing like the cause. Observed on `narration-player-bar` in a full
 * `test:browser` run and not once in isolation, which is exactly the profile: the race only loses when
 * seven other servers have just been booted on the same machine. So this polls for the file rather than
 * assuming boot finished writing it.
 *
 * ⚠️ FAILURE THROWS RATHER THAN RETURNING AN EMPTY LIST. Every copy of this ended in
 * `expect(settingsFiles.length).toBeGreaterThan(0)` precisely because a silent zero is unreadable at the
 * point it eventually bites; a throw from here says which directory was searched and for how long.
 * @param {string} dataRoot The scratch data root the server was booted against
 * @param {number} [timeoutMs] How long to wait for the settings file to appear
 * @returns {Promise<Array<string>>} Every settings file that was rewritten
 */
export async function stepPastFirstRun(dataRoot, timeoutMs = 30_000) {
    const find = (dir) => {
        const found = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) found.push(...find(full));
            else if (entry.name === 'settings.json') found.push(full);
        }
        return found;
    };

    const deadline = Date.now() + timeoutMs;
    let settingsFiles = [];

    while (Date.now() < deadline) {
        // The root itself can be missing for a moment on a boot this early, and a missing directory is
        // "not written yet" rather than an error — it is the same wait either way.
        settingsFiles = fs.existsSync(dataRoot) ? find(dataRoot) : [];

        if (settingsFiles.length > 0) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (settingsFiles.length === 0) {
        throw new Error(`No settings.json appeared under ${dataRoot} within ${timeoutMs}ms — the boot never finished writing the default user, so onboarding cannot be stepped past.`);
    }

    for (const file of settingsFiles) {
        const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
        json.firstRun = false;
        fs.writeFileSync(file, JSON.stringify(json, null, 4), 'utf-8');
    }

    return settingsFiles;
}

/**
 * Install a storage provider into a scratch directory, so a boot can pick it up.
 * @param {string} providersPath Directory to install into
 * @param {string} fixturePath Absolute path to the provider module
 * @returns {void}
 */
export function installStorageProvider(providersPath, fixturePath) {
    fs.mkdirSync(providersPath, { recursive: true });

    // Re-export rather than copy: the fixture imports from `src/storage.js` by relative path, and a
    // copy sitting in a temp directory would not be able to find it.
    const shim = `export { default } from ${JSON.stringify(pathToImportSpecifier(fixturePath))};\n`;
    fs.writeFileSync(path.join(providersPath, 'provider.js'), shim, 'utf-8');
}

/**
 * Turn an absolute path into something an `import` statement will accept on any platform.
 * @param {string} absolutePath The path to import
 * @returns {string} A file:// URL
 */
function pathToImportSpecifier(absolutePath) {
    return new URL(`file:///${absolutePath.split(path.sep).join('/')}`).href;
}

/**
 * The result of poking one endpoint.
 * @typedef {object} EndpointResult
 * @property {string} label What we called
 * @property {number} status The HTTP status it answered with, or 0 if the request itself blew up
 * @property {string} body The response body, truncated
 */

/**
 * Drive the endpoints that destroy things.
 *
 * These are the six paths from the design's §8, and NONE of them run at boot. They are the reason the
 * gate has to hold a server open and talk to it:
 *
 *   /api/data-maid/report ..... 🔴 THE WORST ONE. It cross-references the user's images and Data Bank
 *                               files against the chats that mention them. If the chats cannot be
 *                               parsed it comes back with EVERY image classified as an orphan, and
 *                               presents them to the user as safe to delete. The user then confirms a
 *                               lie, and /api/data-maid/delete unlinks the lot.
 *   /api/characters/all ....... the parsed-card cache. A decode failure is a silent MISS, and the miss
 *                               is repaired by writing the card back out in CLEARTEXT.
 *   /api/settings/get ......... reads settings, presets, worlds, themes — the whole settings tree.
 *   /api/chats/recent ......... walks every chat directory.
 *   /api/stats/get ............ the stats the boot path already refused to rebuild.
 *
 * We do not assert on their status codes here — a locked store legitimately fails a request. What
 * matters is what they did to the disk while failing, and the manifest answers that.
 * @param {number} port Port the server is listening on
 * @returns {Promise<EndpointResult[]>} What each one answered
 */
export async function pokeDestructiveEndpoints(port) {
    const calls = [
        { label: 'data-maid/report', method: 'POST', url: '/api/data-maid/report', body: {} },
        { label: 'characters/all', method: 'POST', url: '/api/characters/all', body: { shallow: false } },
        { label: 'settings/get', method: 'POST', url: '/api/settings/get', body: {} },
        { label: 'chats/recent', method: 'POST', url: '/api/chats/recent', body: {} },
        { label: 'stats/get', method: 'POST', url: '/api/stats/get', body: {} },
    ];

    const results = [];

    for (const call of calls) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}${call.url}`, {
                method: call.method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(call.body),
            });
            results.push({ label: call.label, status: response.status, body: (await response.text()).slice(0, 2000) });
        } catch (error) {
            results.push({ label: call.label, status: 0, body: String(error) });
        }
    }

    return results;
}

/**
 * A single call the provider received.
 * @typedef {object} JournalEntry
 * @property {string} op The operation attempted
 * @property {string} path The logical path, relative to the data root
 */

/**
 * Read back everything the hostile provider was asked to do.
 *
 * `reads` means CONTENT reads — the ones the hostile provider refuses. Structural calls (exists, stat,
 * readdir, mkdir) are kept separate: the fixture answers those truthfully, because a broken vault still
 * has a directory tree, and pretending otherwise would stop SillyTavern before it reached anything
 * worth testing.
 * @param {string} journalPath Path to the journal the provider wrote
 * @returns {{all: JournalEntry[], reads: JournalEntry[], writes: JournalEntry[], structural: JournalEntry[]}} The record
 */
export function readJournal(journalPath) {
    const READS = new Set(['readFile', 'readFileSync', 'createReadStream', 'sendFile']);
    const WRITES = new Set(['writeFile', 'writeFileSync', 'createWriteStream', 'unlink', 'rename', 'copyFile', 'cp', 'rm']);
    const STRUCTURAL = new Set(['exists', 'stat', 'readdir', 'mkdir']);

    if (!fs.existsSync(journalPath)) {
        return { all: [], reads: [], writes: [], structural: [] };
    }

    const all = fs.readFileSync(journalPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));

    return {
        all,
        reads: all.filter(entry => READS.has(entry.op)),
        writes: all.filter(entry => WRITES.has(entry.op)),
        structural: all.filter(entry => STRUCTURAL.has(entry.op)),
    };
}

import { availableParallelism } from 'node:os';

/**
 * How many suites may run at once.
 *
 * Shared by Jest and the browser runner so their concurrency limits stay consistent.
 *
 * Each worker may also boot a SillyTavern subprocess, so process and memory use grow faster than the
 * worker count. Startup is I/O-bound; beyond the measured concurrency knee, more workers add contention.
 *
 * `availableParallelism()` reports threads, not physical cores. Node has no API for physical core count;
 * querying it requires a per-OS subprocess (a CIM
 * query on Windows, `/proc/cpuinfo` on Linux, `sysctl` on macOS), which is a spawn and a failure
 * mode at config-load time. Every SMT machine made this decade has two threads per core, so halving
 * is the same answer without the subprocess; a machine without SMT gets half its cores, which is the
 * safe direction to be wrong in when each worker owns two processes anyway.
 *
 * The ceiling of 12 caps contention on high-core hosts. Run fewer any time with
 * `--maxWorkers=N` (jest) or `--workers=N` (Playwright), which both honour the flag over this.
 * @returns {number} Suites to run concurrently
 */
export function workerCount() {
    return Math.max(1, Math.min(12, Math.floor(availableParallelism() / 2)));
}

import { format } from 'node:util';

/**
 * A bounded in-memory copy of this plugin's normal operational log lines for the diagnostics panel.
 *
 * The tape records only `normal()` lines from `logging.js`; `sensitive()` lines are never recorded. This
 * classification is enforced at the logging call sites, so misclassifying a line there also exposes it here.
 * The tape is process-global because normal lines contain no user-specific values and therefore need no
 * per-user lock cleanup. It avoids reading `st.log`, whose resolved path is not exposed to plugins and whose
 * debug log can contain conversation text or other subsystems' output.
 *
 * The tape is volatile and starts empty after restart. The panel reports this limitation so an empty tape is
 * not mistaken for evidence that no failures occurred.
 */

/**
 * How many lines to keep.
 *
 * Retain enough recent ingest diagnostics for a long chat while keeping memory bounded. This is a diagnostic
 * window, not an archive; older lines remain available in the server log.
 */
const MAX_LINES = 300;

/** @typedef {{ at: number, level: string, text: string }} TapeLine */

/** @type {TapeLine[]} */
let tape = [];

/**
 * Record one emitted line.
 *
 * Format at write time so the tape retains the emitted value rather than mutable argument objects. This is a
 * best-effort logging seam and never throws to its caller.
 *
 * @param {string} level `debug` | `info` | `warn` | `error`
 * @param {unknown[]} args The call site's arguments, exactly as passed
 * @param {number} [at] Injectable clock, for tests
 * @returns {void}
 */
export function recordLine(level, args, at = Date.now()) {
    try {
        const text = format(...args);

        tape.push({ at, level, text });

        if (tape.length > MAX_LINES) {
            tape = tape.slice(-MAX_LINES);
        }
    } catch {
        // A formatting failure is not worth taking a caller down for; the line is simply not recorded.
    }
}

/**
 * Every line held, oldest first.
 *
 * Returns a copy: the panel renders asynchronously with respect to everything that writes here, and handing
 * out the live array would let a render see it mutate underneath itself.
 *
 * @returns {TapeLine[]}
 */
export function readTape() {
    return tape.slice();
}

/**
 * Drop everything. For tests, and for nothing else — there is no user-facing "clear log", deliberately: the
 * tape's whole value is that it is the record nobody curated.
 *
 * @returns {void}
 */
export function resetTape() {
    tape = [];
}

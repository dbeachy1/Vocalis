import { normal, sensitive } from '../logging.js';

/**
 * Structural faults — the declines that mean something is *wrong*, said once per user and then never again.
 *
 * 🔴 The distinction this module encodes: a fork that sends no window for a chat generation, or a chat
 * generation carrying no chat identity, is a **permanent** condition that would otherwise be reported on every
 * single generation for ever. The ordinary "not yet" declines (too few turns, cooling down) are logged EVERY
 * time, deliberately, because watching that counter tick is how you know the gate is alive. Only the permanent
 * ones come here.
 *
 * ⚠️ **Say-once is a scarce resource, and that shapes what may call this.** One report per `handle:fault` for
 * the life of the process means the FIRST caller wins for ever, so a benign cause reaching this module does not
 * merely add noise — it disarms the diagnostic. Ingest learned that the hard way: a window-less request from a
 * third-party UI extension was spending the `no-window` warning that exists to catch a broken fork. Before
 * reporting anything here, be sure the condition is genuinely wrong rather than merely unhandled; see
 * `isChatGeneration` in ./index.js.
 *
 * Its own module because two very different callers need it — the trigger gate and the card baseline — and
 * neither should have to import the other to say something once.
 */

/**
 * Structural faults already reported, keyed `handle:fault`, so a broken install says so once instead of on
 * every generation for ever.
 *
 * These are the declines that mean something is *wrong* — a chat generation arriving with no window, or with no
 * chat identity — as opposed to the ordinary "not yet" declines (too few turns, cooling down), which are logged
 * every time precisely because watching them tick is how you know the gate is alive.
 */
const reportedFaults = new Set();

/**
 * Say a structural fault once per user, then never again.
 *
 * 🔴 **`message` and `args` are the NORMAL half and must carry no handle.** The split is done here, once,
 * rather than at each call site, precisely so that a future fault cannot leak a handle into a published line by
 * being written in the older style — the caller has nowhere to put one even if it tries. The handle is added
 * below, on the SENSITIVE line, where it belongs.
 *
 * The faults this reports are fork-wide rather than per-user (no window on a chat generation, no chat identity
 * on one), so the operator half is fully actionable without naming anybody.
 *
 * @param {string} handle The user this fault is being reported for — SENSITIVE, never in `message`
 * @param {string} fault Internal fault key, from a fixed set
 * @param {string} message Format string for the NORMAL half — no handle, no chat id, no character name
 * @param {...any} args Format arguments for the NORMAL half — counts and constants only
 * @returns {void}
 */
export function reportOnce(handle, fault, message, ...args) {
    const key = `${handle}:${fault}`;
    if (reportedFaults.has(key)) {
        return;
    }
    reportedFaults.add(key);
    normal().warn(message, ...args);
    sensitive().warn('[Mnemosyne] The user just warned about is %s (fault: %s).', handle, fault);
}

/**
 * Test seam. 🔴 Say-once state keyed by handle, so without a reset a test asserting that a broken install
 * warns passes alone and fails after any earlier test on the same handle has already consumed the warning.
 * @returns {void}
 */
export function _resetFaults() {
    reportedFaults.clear();
}

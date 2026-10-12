import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT THROWS DURING STARTUP, WHICH IS THE FAILURE §28 IS REALLY ABOUT.
 *
 * Everything else in the Extensions dialog reports itself. A server plugin that throws in `init` reported
 * itself to `st.log` and nowhere else — so a user installed a plugin, opened SillyTavern, and got an
 * application that quietly did less than it did yesterday with nothing on screen to say why. There is no
 * symptom to search for, because the symptom is an absence.
 *
 * This fixture makes that state reachable in a test. It parses, it declares itself properly, and then it
 * throws — so the fork knows its id, its name and its description, and must put all three in the inventory
 * with a status that says it is not running.
 *
 * ⚠️ THROWS ONLY WHEN IT WAS ASKED FOR. Jest runs suites in parallel and a shim can be on disk while another
 * suite's server boots; a fixture that threw unconditionally would scatter startup errors through unrelated
 * runs. See fixture-gate.mjs.
 */

export const info = {
    id: 'broken-probe',
    name: 'Broken Probe',
    description: 'Throws while initializing. Test fixture.',
};

/** The message the throw carries. Exported so the suite asserts on the same string the plugin threw. */
export const BROKEN_MESSAGE = 'the probe refused to start, on purpose';

/**
 * @returns {Promise<void>}
 */
export async function init() {
    if (!fixtureIsEnabled('broken-probe')) {
        return;
    }

    // A plain `Error`, so its `name` is the only shape-safe thing about it and the suite can prove the
    // inventory reports the TYPE to everyone and the MESSAGE only to an admin.
    throw new Error(BROKEN_MESSAGE);
}

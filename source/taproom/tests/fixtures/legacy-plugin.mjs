import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN WRITTEN BEFORE THE CONTEXT EXISTED, AND UNAWARE OF IT.
 *
 * Every server plugin ever published declares `init(router)` and takes exactly one argument. The claim made
 * by the context change is that they all keep working untouched, because JavaScript ignores surplus
 * arguments. That claim is cheap to make and cheap to test, so test it — a backward-compatibility promise
 * that nobody exercises is just a comment.
 *
 * This fixture is deliberately, exactly what a plugin looked like before: one parameter, no awareness that a
 * second one is now being passed.
 */

/** Where the journal goes. Shared with the other fixture; lines are prefixed to tell them apart. */
const journalPath = process.env.ST_PLUGIN_JOURNAL ?? '';

/**
 * Write one line to the journal.
 * @param {string} what What happened
 * @returns {void}
 */
function journal(what) {
    if (journalPath) {
        fs.appendFileSync(journalPath, `${what}\n`, 'utf-8');
    }
}

export const info = {
    id: 'legacy-probe',
    name: 'Legacy Probe',
    description: 'A one-argument plugin from before the context existed. Test fixture; does nothing else.',
};

/**
 * Note the arity: ONE. Do not add a second parameter to this function -- that is the whole point of it.
 * @param {import('express').Router} router The plugin's own router
 * @returns {Promise<void>}
 */
export async function init(router) {
    // Another suite's shim may be sitting in the shared plugins/ directory while THIS suite's server boots
    // (see fixture-gate.mjs). Registering from here would rewrite that suite's prompts and fail its
    // assertions, so a fixture nobody asked for does nothing at all.
    if (!fixtureIsEnabled("legacy-probe")) {
        return;
    }
    journal(`legacy: init called, declared arity ${init.length}, router is ${typeof router}`);
    journal('legacy: loaded');
}

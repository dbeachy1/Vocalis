import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT RECORDS WHICH BACKEND FAMILY IT WAS CALLED FOR.
 *
 * `OutgoingPrompt.backend` advertised `'kobold'` to every plugin author who read the typedef, and for the
 * whole life of the seam there was no call site behind it: a memory plugin on KoboldAI Classic registered,
 * lit its button, logged that it was running, and silently never fired. "Silently never fired" is
 * indistinguishable from working unless something asks the plugin what it saw, which is what this does.
 *
 * It records and rewrites, and decides nothing.
 */

/** Where the journal goes. Set by the test, across the process boundary, because plugins run in the child. */
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
    id: 'backend-probe',
    name: 'Backend Probe',
    description: 'Records which backend family each generation reached it as. Test fixture.',
};

/**
 * @param {import('express').Router} _router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(_router, context) {
    // Another suite's shim may be sitting in the shared plugins/ directory while THIS suite's server boots
    // (see fixture-gate.mjs). A fixture nobody asked for does nothing at all.
    if (!fixtureIsEnabled('backend-probe')) {
        return;
    }

    context.onPrompt(async (outgoing) => {
        journal(`saw backend: ${outgoing.backend}`);
        journal(`saw apiType: ${outgoing.apiType}`);
        journal(`saw budget: ${outgoing.budget}`);
        journal(`saw window length: ${outgoing.recentMessages === undefined ? 'undefined' : outgoing.recentMessages.length}`);
        journal(`saw prompt: ${JSON.stringify(outgoing.prompt)}`);

        // A rewrite the backend stub can be asked about. If this string reaches the model host, the seam
        // ran AND its result was actually used — two different claims, both worth pinning.
        return `[[SEEN-BY-BACKEND-PROBE]] ${outgoing.prompt}`;
    }, { recentMessages: 4 });
}

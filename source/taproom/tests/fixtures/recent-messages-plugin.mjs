import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT REGISTERS THREE INTERCEPTORS ASKING FOR DIFFERENT AMOUNTS OF HISTORY.
 *
 * §17.6's claim is that the window size belongs to the PLUGIN and that each handler receives exactly what it
 * declared — not the largest anybody asked for, or the number is decorative and any budgeting built on it is a
 * fiction. One handler asking for 5, one for 20 and one asking for nothing at all is the smallest arrangement
 * that can tell a correct implementation from a plausible one: hand all three the same array and two of these
 * assertions fail.
 *
 * It writes down what it was handed and decides nothing, exactly as `context-plugin.mjs` does.
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
    id: 'recent-probe',
    name: 'Recent Messages Probe',
    description: 'Records the recent-message window each of its interceptors receives. Test fixture.',
};

/**
 * Describe a window without reproducing the whole conversation in a log file.
 * @param {string} label Which handler this is
 * @param {any} outgoing What the fork handed over
 * @returns {void}
 */
function describeWindow(label, outgoing) {
    const window = outgoing.recentMessages;

    if (window === undefined) {
        // 🔴 THE ASSERTION THAT MATTERS MOST FOR THE UNDECLARED HANDLER. `undefined` and `[]` are different
        // facts — "nobody asked" versus "a chat with no turns" — and a plugin must be able to tell them apart.
        journal(`${label} window: undefined`);
        return;
    }

    journal(`${label} window length: ${window.length}`);
    journal(`${label} window indices: ${window.map(turn => turn.index).join(',')}`);
    journal(`${label} window roles: ${window.map(turn => turn.role).join(',')}`);
    journal(`${label} window names: ${window.map(turn => turn.name ?? '-').join(',')}`);
    journal(`${label} window first content: ${JSON.stringify(window[0]?.content)}`);
    journal(`${label} window last content: ${JSON.stringify(window[window.length - 1]?.content)}`);

    // ST's internal shape must not survive the normalization. A plugin reading `mes` would be reading the
    // fork's internals, and would break the moment they moved.
    const leaked = window.some(turn => 'mes' in turn || 'is_user' in turn || 'is_system' in turn || 'extra' in turn);
    journal(`${label} window leaked internals: ${leaked}`);
}

/**
 * @param {import('express').Router} _router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(_router, context) {
    // Another suite's shim may be sitting in the shared plugins/ directory while THIS suite's server boots
    // (see fixture-gate.mjs). Registering from here would rewrite that suite's prompts and fail its
    // assertions, so a fixture nobody asked for does nothing at all.
    if (!fixtureIsEnabled("recent-probe")) {
        return;
    }
    // Declared FIVE. Must receive five, whatever anybody else asked for.
    context.onPrompt(async (outgoing) => {
        describeWindow('five', outgoing);
        journal(`five genType: ${outgoing.genType}`);
        return undefined;
    }, { recentMessages: 5 });

    // Declared TWENTY, and therefore also what the client is asked to send.
    context.onPrompt(async (outgoing) => {
        describeWindow('twenty', outgoing);
        return undefined;
    }, { recentMessages: 20 });

    // Declared NOTHING. The fork ships no default, so this one gets no window at all — not a partial one.
    context.onPrompt(async (outgoing) => {
        describeWindow('undeclared', outgoing);

        // Prove the ordinary contract is untouched by any of this: a text-path handler still returns a string
        // and it still reaches the backend.
        return `[[SEEN-BY-RECENT-PROBE]] ${outgoing.prompt}`;
    });

    // 🔴 A NONSENSE DECLARATION IS REFUSED AT REGISTRATION, IN THE PLUGIN'S OWN `init`, NEVER CLAMPED. The
    // alternative is a plugin that silently receives a different amount of history than it budgeted for.
    for (const bad of [0, -1, 2.5, '20', 100000]) {
        try {
            context.onPrompt(async () => undefined, { recentMessages: bad });
            journal(`bad declaration ${JSON.stringify(bad)}: ACCEPTED`);
        } catch {
            journal(`bad declaration ${JSON.stringify(bad)}: refused`);
        }
    }
}

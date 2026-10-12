import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT LOGS FOUR WAYS, SO THE LOG FILE CAN BE ASKED WHICH ONES SURVIVED.
 *
 * `context.logger` (§23) lets a plugin assert that a line is safe. The claim is only worth something if the
 * fork's writer actually honours it AND still suppresses everything else — and neither half can be proved from
 * inside the plugin, because the plugin cannot see what was written. So this fixture only *emits*. Every
 * assertion lives in the test, against the log file the server wrote.
 *
 * Each line carries a canary unique to what it is proving, so a test failure names the exact broken guarantee
 * rather than reporting that a log did not look right.
 */

/** Where the journal goes. Set by the test, across the process boundary, because plugins run in the child. */
const journalPath = process.env.ST_PLUGIN_JOURNAL ?? '';

/**
 * The canaries. Deliberately absurd strings: they must be impossible to confuse with real log content, and
 * `indexOf` on the log file has to be an honest question.
 */
export const CANARY = Object.freeze({
    /** Content-free and vouched for — the ONLY one that may appear in `st.log` on a default install. */
    NORMAL: 'CANARY-NORMAL-VOUCHED-8f21',
    /** Vouched-for lines are not a way around classification: naming SENSITIVE must still suppress. */
    SENSITIVE: 'CANARY-SENSITIVE-EXPLICIT-4b73',
    /** The accident case. Bare `console.*` must keep behaving exactly as it did before §23 existed. */
    CONSOLE: 'CANARY-CONSOLE-SEAM-1d09',
});

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
    id: 'logger-probe',
    name: 'Logger Probe',
    description: 'Logs one line of each classification so a test can read the log back. Test fixture; does nothing else.',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    if (!fixtureIsEnabled('logger-probe')) {
        return;
    }

    journal(`logger: ${typeof context.logger}`);
    journal(`LogClass: ${typeof context.LogClass}`);

    // 🔴 The context must expose the logger and the vocabulary, and NOTHING ELSE from logger.js. A plugin that
    // can reach initLogger or shutdownLogger can redirect, close or rotate the operator's log — which is a
    // strictly worse failure than the one §23 set out to fix.
    journal(`initLogger reachable: ${'initLogger' in context}`);
    journal(`shutdownLogger reachable: ${'shutdownLogger' in context}`);
    journal(`installConsoleSeam reachable: ${'installConsoleSeam' in context}`);

    if (typeof context.logger !== 'object' || typeof context.LogClass !== 'object') {
        // Say it loudly. A missing channel would otherwise look identical to a working one whose lines were
        // all suppressed — which is the exact ambiguity this suite exists to remove.
        journal('logger: MISSING');
        return;
    }

    journal(`LogClass.NORMAL: ${context.LogClass.NORMAL}`);
    journal(`LogClass.SENSITIVE: ${context.LogClass.SENSITIVE}`);

    // The line §23 exists for: content-free, operationally useful, and vouched for.
    context.logger.info(context.LogClass.NORMAL, `ingest: ${CANARY.NORMAL} — %d stored, %d superseded.`, 3, 1);

    // Naming a class is not a way around classification. This one must be suppressed like any other.
    context.logger.warn(context.LogClass.SENSITIVE, `extractor returned: ${CANARY.SENSITIVE}`);

    // The accident case — the debugging line nobody removed. The seam must still catch it.
    console.log(`candidate memory: ${CANARY.CONSOLE}`);

    journal('logger probe emitted all three lines');
}

import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT MEASURES WHETHER THE VECTORS MEAN ANYTHING.
 *
 * Separate from `embed-plugin.mjs` on purpose: that fixture asks "can a plugin embed at all, and is it told
 * the truth about which model did it". This one asks the question nothing anywhere asked for twenty months —
 * whether the numbers that come back are vectors OF anything. `Cohee/jina-embeddings-v2-base-en` answered
 * every one of that fixture's checks correctly (right count, right dimension, unit-normalised, deterministic,
 * different per text) while producing vectors with no semantic content at all: deleting one trailing period
 * moved a sentence as far from itself as a completely unrelated sentence. Shape checks cannot catch that;
 * only a similarity ladder can.
 *
 * It embeds the probe TWICE rather than dotting a vector with itself — a self-dot is ~1.0 by normalisation
 * alone, an arithmetic identity that would pass with the pipeline unplugged. Two independent embeddings of
 * the same text go through the real path both times.
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
    id: 'embed-ladder',
    name: 'Embed Ladder',
    description: 'Embeds a similarity ladder and records the cosine of each rung. Test fixture.',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    // See fixture-gate.mjs — another suite's boot may load this shim from a shared directory.
    if (!fixtureIsEnabled('embed-ladder')) {
        return;
    }

    // 🔴 STAY ASLEEP UNLESS THE SUITE THAT WANTS THE MODEL ASKED FOR IT. The first embed() downloads the
    // shipped default model on a cold cache — inside whoever's boot gate happened to load this fixture.
    if (process.env.ST_EMBED_LADDER !== '1') {
        return;
    }

    if (typeof context?.embed !== 'function') {
        journal('ladder: MISSING');
        return;
    }

    try {
        const probe = 'Elara owns a black cat named Pepper.';
        const { vectors, model } = await context.embed([
            probe,
            probe, //                                          embedded again: identical text, real path
            'Elara owns a black cat named Pepper', //          ONLY the trailing period deleted
            'Elara owns a black cat called Pepper.', //        one word swapped
            'The quarterly budget review is scheduled for Thursday afternoon.', // unrelated
        ]);

        // Vectors are unit-normalised (embed-plugin.mjs asserts it), so cosine is a plain dot product.
        const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

        journal(`ladder model: ${model}`);
        journal(`ladder identical: ${dot(vectors[0], vectors[1])}`);
        journal(`ladder punctuation: ${dot(vectors[0], vectors[2])}`);
        journal(`ladder swapped: ${dot(vectors[0], vectors[3])}`);
        journal(`ladder unrelated: ${dot(vectors[0], vectors[4])}`);
    } catch (error) {
        journal(`ladder THREW: ${error.message}`);
    }
}

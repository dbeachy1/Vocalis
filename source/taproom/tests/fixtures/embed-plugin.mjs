import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT EMBEDS SOMETHING AND WRITES DOWN WHAT CAME BACK.
 *
 * Separate from `context-plugin.mjs` on purpose. That fixture is shared by five suites and must stay cheap;
 * the first `embed()` call loads a real model — over the network, if it is not cached — and every suite that
 * touched it would pay for that. This one exists to pay it, once, deliberately.
 *
 * What it is really here to catch: an `embed()` that returns plausible numbers and a plausible model name that
 * have nothing to do with each other. A stub returning a constant name passes every test that only checks a
 * name is present, and a vector filed under the wrong model's name is corruption that compares cleanly and is
 * never noticed. So this records the model name AND the dimension of what came back, and the test checks that
 * they agree with each other.
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
    id: 'embed-probe',
    name: 'Embed Probe',
    description: 'Embeds text through the plugin context and records what came back. Test fixture.',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork now provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    // Another suite's shim may be sitting in the shared plugins/ directory while THIS suite's server boots
    // (see fixture-gate.mjs). Registering from here would rewrite that suite's prompts and fail its
    // assertions, so a fixture nobody asked for does nothing at all.
    if (!fixtureIsEnabled("embed-probe")) {
        return;
    }
    // 🔴 STAY ASLEEP UNLESS THE SUITE THAT WANTS THE MODEL ASKED FOR IT.
    //
    // `plugins/` is shared mutable state across parallel jest workers (§10.0): every suite installs its shim
    // into the same real directory, so while this one is installed, OTHER suites' boots load it too. Embedding
    // unasked means downloading a model inside someone else's 90-second boot gate — a flake that appears only
    // under parallelism, only on a cold cache, and never in the suite that caused it.
    if (process.env.ST_EMBED_PROBE !== '1') {
        return;
    }

    if (typeof context?.embed !== 'function') {
        journal('embed: MISSING');
        return;
    }

    try {
        const { vectors, model } = await context.embed(['the cat sat on the mat', 'a wholly unrelated sentence']);

        journal(`embed model: ${model}`);
        journal(`embed count: ${vectors.length}`);
        journal(`embed dimension: ${vectors[0].length}`);
        journal(`embed all numbers: ${vectors.every(v => v.every(x => typeof x === 'number' && Number.isFinite(x)))}`);

        // Unit-normalised is a promise the caller is told it can rely on: cosine similarity is then a plain dot
        // product, and a caller that believed it and was wrong gets silently wrong distances for ever.
        const magnitude = Math.sqrt(vectors[0].reduce((sum, x) => sum + x * x, 0));
        journal(`embed normalised: ${Math.abs(magnitude - 1) < 1e-3}`);

        // 🔴 Two different texts must not produce the same vector. This is the one that fails if `embed`
        // returns zeros, or echoes the first vector, or is a stub -- all of which satisfy every check above.
        journal(`embed differs by text: ${JSON.stringify(vectors[0]) !== JSON.stringify(vectors[1])}`);

        // The name must be stable across calls, or nothing can be filed under it.
        const again = await context.embed(['the cat sat on the mat']);
        journal(`embed model stable: ${again.model === model}`);

        // ...and the same text must give the same vector back, or the store is unsearchable.
        journal(`embed deterministic: ${JSON.stringify(again.vectors[0]) === JSON.stringify(vectors[0])}`);
    } catch (error) {
        journal(`embed THREW: ${error.message}`);
    }

    // An empty batch is the degenerate case that would most plausibly answer "no model", which is the one
    // answer the contract must never give.
    try {
        const empty = await context.embed([]);
        journal(`embed empty count: ${empty.vectors.length}`);
        journal(`embed empty still names a model: ${typeof empty.model === 'string' && empty.model.length > 0}`);
    } catch (error) {
        journal(`embed empty THREW: ${error.message}`);
    }

    // 🔴 A string is iterable. `embed('hello')` must not quietly return five vectors, one per letter.
    try {
        await context.embed('hello');
        journal('embed bare string: ACCEPTED');
    } catch {
        journal('embed bare string: refused');
    }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(testDirectory);

const PLUGINS_DIRECTORY = makeScratchDirectory('plugins-ladder');
const LADDER_FIXTURE = path.join(testDirectory, 'fixtures', 'embed-ladder-plugin.mjs');
const DEFAULT_CONFIG = path.join(serverDirectory, 'default', 'config.yaml');

/**
 * This suite checks that the model in `default/config.yaml` produces meaningful similarity ordering through
 * the real embedding pipeline. Shape-only checks can pass for collapsed vectors, so the ladder compares
 * related and unrelated strings without imposing absolute model-quality thresholds.
 *
 *   - Compare punctuation against identical text; a collapsed score range cannot satisfy this relationship.
 *   - Assert relative shape rather than absolute scores so routine model changes do not create a quality gate.
 *   - Round before comparing floating-point score differences.
 *
 * ⚠️ THIS SUITE DOWNLOADS THE SHIPPED MODEL (~90MB) into a cache shared with the integration suites at
 * `temp/integration-model-cache`, so it is a one-time cost per machine, not per run. `temp/` is gitignored
 * wholesale. The download happens inside the boot (the fixture embeds in init()), hence the long gate.
 */

/**
 * The embedding model `default/config.yaml` ships. Parsed rather than hard-coded, so this suite always
 * tests what an install would actually get — a default changed without this suite noticing would be the
 * twenty-month gap all over again.
 * @returns {string} The model name
 */
function shippedEmbeddingModel() {
    const config = fs.readFileSync(DEFAULT_CONFIG, 'utf-8');
    const match = config.match(/^\s+embedding:\s*(\S+)\s*$/m);

    if (!match) {
        throw new Error(`No embedding model found in ${DEFAULT_CONFIG} — has the config key moved?`);
    }

    return match[1];
}

/**
 * Point the scratch data root's model cache at one that survives between runs.
 *
 * `src/transformers.js` caches models at `<DATA_ROOT>/_cache`, and every run of this suite gets a brand-new
 * scratch data root — so without this, every run re-downloads the model. Same shared directory as
 * `integration/harness.mjs` uses, deliberately: transformers.js keys the cache by model name inside it, so
 * the suites can share one copy of the same model without conflict.
 * @param {string} dataRoot The scratch data root, which does not exist yet
 * @returns {void}
 */
function shareModelCache(dataRoot) {
    const shared = path.join(serverDirectory, 'temp', 'integration-model-cache');

    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });

    // `junction` is honoured on Windows — the one link type needing no privileges — and ignored elsewhere.
    fs.symlinkSync(shared, path.join(dataRoot, '_cache'), 'junction');
}

/**
 * Round to two decimals, so margin comparisons are exact rather than float-noise theatre.
 * @param {number} x A cosine
 * @returns {number} The same, to two decimals
 */
function round2(x) {
    return Math.round(x * 100) / 100;
}

describe('the shipped embedding model, and the vector query built on it', () => {
    /** @type {string[]} */
    let lines = [];
    /** @type {import('./util/st-server.js').RunningServer|null} */
    let server = null;
    /** @type {string} */
    let base = '';
    /** @type {string} */
    let shim = '';

    /**
     * What the journal recorded for one rung of the ladder.
     * @param {string} rung The rung's label
     * @returns {number} Its cosine against the probe
     */
    function score(rung) {
        const prefix = `ladder ${rung}: `;
        const line = lines.find(one => one.startsWith(prefix));
        return line ? Number(line.slice(prefix.length)) : Number.NaN;
    }

    /**
     * POST some JSON at the booted server. No CSRF (the boot disables it) and no login (single-user mode).
     * @param {string} route The route
     * @param {object} body The body
     * @returns {Promise<{status: number, body: any}>} The response
     */
    async function post(route, body) {
        const response = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    beforeAll(async () => {
        const scratch = makeScratchDirectory('embedder-sanity');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        // 🔴 The shipped config, VERBATIM. Every other embedding suite patches the model line to something
        // small; this one exists to test the line nobody patches, because that is the line every install runs.
        fs.copyFileSync(DEFAULT_CONFIG, configPath);
        shareModelCache(dataRoot);

        shim = path.join(PLUGINS_DIRECTORY, 'zz-embed-ladder.mjs');
        const specifier = new URL(`file:///${LADDER_FIXTURE.split(path.sep).join('/')}`).href;
        fs.writeFileSync(shim, `export { info, init } from ${JSON.stringify(specifier)};\n`, 'utf-8');

        server = await startSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'embed-ladder',
                ST_PLUGIN_JOURNAL: journalPath,
                ST_EMBED_LADDER: '1',
            },
            // The fixture embeds inside init(), so the server does not accept a connection until the model
            // is downloaded and loaded — a cold cache pays the whole download inside this gate.
            timeoutMs: 300_000,
        });

        if (!server.listening) {
            throw new Error(`The server never came up.\n\n${server.output()}`);
        }

        base = `http://127.0.0.1:${server.port}`;
        lines = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];
    }, 360_000);

    afterAll(async () => {
        if (server) {
            await server.stop();
        }

        if (shim && fs.existsSync(shim)) {
            fs.unlinkSync(shim);
        }
    }, 30_000);

    describe('🔴 the shipped default produces MEANINGFUL vectors, not just well-formed ones', () => {
        test('the ladder ran and embed() did not throw — otherwise everything below is vacuous', () => {
            expect(lines.length).toBeGreaterThan(0);
            expect(lines).not.toContain('ladder: MISSING');

            const threw = lines.find(line => line.startsWith('ladder THREW')) ?? null;
            expect(threw).toBeNull();

            for (const rung of ['identical', 'punctuation', 'swapped', 'unrelated']) {
                expect(Number.isFinite(score(rung))).toBe(true);
            }
        });

        test('🔴 the model that ran is the one default/config.yaml ships', () => {
            // Without this line the suite could quietly test a fallback, a cached older model, or an env
            // override, and say nothing at all about what an install actually gets.
            expect(lines).toContain(`ladder model: ${shippedEmbeddingModel()}`);
        });

        test('identical text scores ~1.0', () => {
            expect(round2(score('identical'))).toBeGreaterThanOrEqual(0.99);
        });

        test('🔴 deleting one trailing period barely moves the score', () => {
            // THE RUNG THAT CATCHES A COLLAPSED MODEL, and it is asserted against IDENTICAL on purpose.
            // Under the broken jina conversion this difference was 0.60; under any working sentence
            // embedder it is a few hundredths. Asserting "punctuation beats unrelated" instead would have
            // passed the broken model, because in a collapsed range everything is near everything.
            expect(round2(score('identical') - score('punctuation'))).toBeLessThanOrEqual(0.15);
        });

        test('one swapped word stays clear of an unrelated sentence', () => {
            // The other side of the shape: related text must be DISTINGUISHABLE from noise. Under the
            // broken model paraphrase and non-sequitur were statistically indistinguishable (0.32 vs 0.30).
            expect(round2(score('swapped') - score('unrelated'))).toBeGreaterThanOrEqual(0.15);
        });

        test('the unrelated sentence ranks last', () => {
            expect(score('unrelated')).toBeLessThan(score('punctuation'));
            expect(score('unrelated')).toBeLessThan(score('swapped'));
            expect(score('unrelated')).toBeLessThan(score('identical'));
        });
    });

    describe('🔴 /api/vector/query respects its threshold in BOTH fields it returns', () => {
        // Regression for the queryCollection bug fixed 2026-08-05: `metadata` was filtered by threshold and
        // `hashes` was built from the UNFILTERED result — and the chat-message retrieval path reads
        // `hashes`, so Vector Storage's score-threshold setting silently did nothing for chat memory while
        // working as documented for files and the Data Bank. Found by the Mnemosyne session when a
        // threshold of 3 — above the maximum possible cosine — returned every item in the collection.
        const COLLECTION = 'threshold-regression';
        const PROBE = 'Elara owns a black cat named Pepper.';

        beforeAll(async () => {
            const insert = await post('/api/vector/insert', {
                collectionId: COLLECTION,
                source: 'transformers',
                items: [
                    { hash: 101, text: PROBE, index: 0 },
                    { hash: 102, text: 'Elara owns a black cat called Pepper.', index: 1 },
                    { hash: 103, text: 'The quarterly budget review is scheduled for Thursday afternoon.', index: 2 },
                ],
            });

            expect(insert.status).toBe(200);
        }, 120_000);

        test('🔴 an impossible threshold returns nothing — in both fields', async () => {
            // Above the maximum possible cosine, so nothing can survive. Before the fix, `hashes` came back
            // fully populated here — this exact request is how the bug was found.
            const { status, body } = await post('/api/vector/query', {
                collectionId: COLLECTION, source: 'transformers', searchText: PROBE, topK: 10, threshold: 3,
            });

            expect(status).toBe(200);
            expect(body.metadata).toEqual([]);
            expect(body.hashes).toEqual([]);
        }, 60_000);

        test('threshold 0 returns everything, and the two fields agree', async () => {
            const { status, body } = await post('/api/vector/query', {
                collectionId: COLLECTION, source: 'transformers', searchText: PROBE, topK: 10, threshold: 0,
            });

            expect(status).toBe(200);
            expect([...body.hashes].sort()).toEqual([101, 102, 103]);
            expect(body.hashes).toEqual(body.metadata.map(x => Number(x.hash)));
        }, 60_000);

        test('a real threshold keeps the identical item, drops the unrelated one, and the fields agree', async () => {
            // 0.5 sits far above what any working embedder gives a non-sequitur and far below what it gives
            // identical text — deliberately loose at both ends, since this asserts the filter, not the model.
            const { status, body } = await post('/api/vector/query', {
                collectionId: COLLECTION, source: 'transformers', searchText: PROBE, topK: 10, threshold: 0.5,
            });

            expect(status).toBe(200);
            expect(body.hashes).toContain(101);
            expect(body.hashes).not.toContain(103);
            expect(body.hashes).toEqual(body.metadata.map(x => Number(x.hash)));
        }, 60_000);
    });
});

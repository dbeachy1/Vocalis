import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { bootSillyTavern, makeScratchDirectory } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(testDirectory);

// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const EMBED_FIXTURE = path.join(testDirectory, 'fixtures', 'embed-plugin.mjs');
const DEFAULT_CONFIG = path.join(serverDirectory, 'default', 'config.yaml');

/**
 * 🔴 A SMALL MODEL, AND — THE POINT — NOT ANY MODEL THIS FORK WOULD PICK ON ITS OWN.
 *
 * `transformers.js` falls back to `Xenova/all-mpnet-base-v2` (768), and `default/config.yaml` ships
 * `Cohee/jina-embeddings-v2-base-en` (also 768). Both defaults are 768, so a test run against a 768 model
 * could not tell "asked the model" apart from "guessed a default" — the numbers would look right either way.
 *
 * MiniLM is **384**. That single fact is what makes this suite able to fail: the dimension proves which model
 * actually ran, independently of what the name says it was. Name and dimension have to agree, and only the
 * configured model makes them agree.
 *
 * It is also ~23MB, against ~90MB and ~160MB — this test downloads it.
 */
const TEST_MODEL = 'Xenova/all-MiniLM-L6-v2';
const TEST_MODEL_DIMENSION = 384;

/** Every shim we installed, so afterAll can take them out again. */
const installed = [];

/**
 * Turn an absolute path into something an `import` statement will accept on any platform.
 * @param {string} absolutePath The path to import
 * @returns {string} A file:// URL
 */
function pathToImportSpecifier(absolutePath) {
    return new URL(`file:///${absolutePath.split(path.sep).join('/')}`).href;
}

/**
 * Install a plugin fixture so a boot will pick it up. See `plugin-context.test.js` — the plugins directory is
 * not configurable, so this writes into the repository's own and takes it out again afterwards.
 * @param {string} fixturePath Absolute path to the fixture module
 * @param {string} name Base name for the installed shim
 * @returns {void}
 */
function installPlugin(fixturePath, name) {
    const target = path.join(PLUGINS_DIRECTORY, `${name}.mjs`);
    fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(pathToImportSpecifier(fixturePath))};\n`, 'utf-8');
    installed.push(target);
}

/**
 * Write a real config.yaml naming a specific embedding model.
 *
 * ⚠️ THROUGH THE FILE, NOT THROUGH THE ENVIRONMENT. `getConfigValue` reads `SILLYTAVERN_*` before it reads
 * the file, so an env override would have proved that env overrides work and said nothing about the config
 * key anybody actually sets. This starts from the shipped default so the server boots against a realistic
 * file rather than a stub, and changes exactly one line.
 * @param {string} configPath Where to write it
 * @param {string} model The embedding model to name
 * @returns {void}
 */
function writeConfigWithEmbeddingModel(configPath, model) {
    const config = fs.readFileSync(DEFAULT_CONFIG, 'utf-8');
    const patched = config.replace(/^(\s+)embedding:.*$/m, `$1embedding: ${model}`);

    // If the shipped default ever stops naming an embedding model, the replace above silently does nothing and
    // this suite would quietly test the fallback instead of what it says it tests.
    if (!patched.includes(`embedding: ${model}`)) {
        throw new Error(`Could not set the embedding model in ${DEFAULT_CONFIG} — has the config key moved?`);
    }

    fs.writeFileSync(configPath, patched, 'utf-8');
}

/**
 * 🔴 CAN A PLUGIN EMBED TEXT, AND IS IT TOLD WHICH MODEL DID IT?
 *
 * Retrieval means embedding a query and comparing it to stored vectors. A memory plugin that cannot embed is a
 * database nobody can search, so this is the capability the rest of the plugin API is in aid of.
 *
 * The model name is the part that needs a test with teeth. Vectors are self-evidently working or not — they
 * are numbers, and wrong ones look wrong. A wrong *name* looks like nothing at all: vectors filed under it
 * compare cleanly against vectors from a different model and return confident nonsense, for ever, and no
 * assertion about vectors alone would ever notice. A stub returning a constant name passes everything except
 * the two tests below that pin the name to the dimension and to the config file.
 *
 * ⚠️ THIS SUITE DOWNLOADS A MODEL (~23MB) on its first run against a cold cache, and each boot gets a fresh
 * scratch data root, so that is every run. It is the only test here that touches the network; that is the
 * price of testing the real embedding path instead of a mock of it, and mocking it would have tested nothing.
 */
describe('🔴 embedding, through the plugin context', () => {
    /** @type {string[]} */
    let lines = [];
    /** @type {string} */
    let output = '';

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-embed');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        writeConfigWithEmbeddingModel(configPath, TEST_MODEL);
        installPlugin(EMBED_FIXTURE, 'zz-embed-probe');

        const result = await bootSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                // Only OUR fixtures register. Jest runs suites in parallel and plugins/ is shared and not
                // configurable, so another suite's shim may be on disk while this server boots (fixture-gate.mjs).
                ST_FIXTURE_IDS: 'embed-probe',
                ST_PLUGIN_JOURNAL: journalPath,
                // The fixture is inert without this. Only this boot wants a model downloaded — see the
                // fixture, and §10.0 on `plugins/` being shared across parallel workers.
                ST_EMBED_PROBE: '1',
            },
            // The fixture embeds inside init(), so the server does not accept a connection until the model has
            // been fetched and loaded. The default 60s gate is a cold download away from flaking.
            timeoutMs: 240_000,
        });

        output = result.output ?? '';
        lines = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];
    }, 300_000);

    afterAll(() => {
        for (const target of installed) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the plugin loaded and embed() did not throw — otherwise everything below is vacuous', () => {
        expect(lines.length).toBeGreaterThan(0);
        expect(output).toContain('server plugin(s) are currently loaded');
        expect(lines).not.toContain('embed: MISSING');

        // A download failure lands here. The fixture's message is carried into the assertion so that a broken
        // test environment reads as one, rather than as a broken capability.
        const threw = lines.find(line => line.startsWith('embed THREW')) ?? null;
        expect(threw).toBeNull();
    });

    test('vectors come back, one per text, and they are actually numbers', () => {
        expect(lines).toContain('embed count: 2');
        expect(lines).toContain('embed all numbers: true');
    });

    test('🔴 the model name is the one config.yaml asked for, not a default and not a constant', () => {
        // The fork's code default is all-mpnet-base-v2 and the shipped config says jina-embeddings-v2-base-en.
        // Either would be a plausible-looking answer here. Only reading the config gives this one.
        expect(lines).toContain(`embed model: ${TEST_MODEL}`);
    });

    test('🔴 the dimension proves the NAMED model is the one that ran', () => {
        // The test with the teeth. A stub could return the configured name while a different model — or no
        // model — produced the numbers, and every other assertion here would still pass. 384 is MiniLM and
        // nothing else in play is 384: both defaults are 768.
        expect(lines).toContain(`embed dimension: ${TEST_MODEL_DIMENSION}`);
    });

    test('the name is stable across calls, or nothing could be filed under it', () => {
        expect(lines).toContain('embed model stable: true');
    });

    test('vectors are unit-normalised, so cosine similarity is a plain dot product', () => {
        // Callers are told they can rely on this. One that believed it and was wrong gets silently wrong
        // distances rather than an error.
        expect(lines).toContain('embed normalised: true');
    });

    test('🔴 different texts give different vectors, and the same text gives the same one', () => {
        // Zeros, or an echo of the first vector, would satisfy every shape check above. A store that cannot
        // reproduce a vector for the same text cannot be searched at all.
        expect(lines).toContain('embed differs by text: true');
        expect(lines).toContain('embed deterministic: true');
    });

    test('an empty batch still names a model rather than answering null', () => {
        // The degenerate case: no text means nothing needs the pipeline, so the model would be null exactly
        // when a caller is least expecting it. A vector without its model is unusable, and so is a contract
        // that holds only when the input is non-empty.
        expect(lines).toContain('embed empty count: 0');
        expect(lines).toContain('embed empty still names a model: true');
    });

    test('🔴 a bare string is refused, not embedded one letter at a time', () => {
        // A string is iterable and the batch path iterates. `embed('hello')` returning five letter-vectors is
        // in the right shape, wrong in a way nothing downstream could detect.
        expect(lines).toContain('embed bare string: refused');
    });
});

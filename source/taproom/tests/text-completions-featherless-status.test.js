import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 THE FEATHERLESS "CONNECT" HANG, AND WHY THIS FILE EXISTS.
 *
 * Featherless may return a large `/v1/models` catalog and does not provide an `ETag` for a cheap change
 * check. The server caches the last response and downloads a new list only when requested or when no cache
 * exists. This suite uses a small scripted catalog because routing behavior does not depend on its size.
 *
 * This suite drives the real `/status` route against a scripted fake Featherless backend — a 3-model
 * list stands in for the real 22,009, since the ROUTING logic under test (cache hit/miss, refresh,
 * single-model lookup) does not depend on the list's size. What it proves:
 *
 *   1. A first connect with no cache downloads the full list and writes it to disk.
 *   2. A connect with a model already picked validates ONLY that one model against Featherless — the
 *      fake backend must never see a second `/v1/models` list request — and answers from the cache.
 *   3. An unknown model is refused with a 400 that names it, and still does not re-download the list.
 *   4. `refresh_models: true` forces a fresh download even though a cache already exists.
 *   5. With neither a model nor a refresh, and a cache already on disk, the route answers from disk with
 *      no network call to Featherless at all.
 *
 * Mounted the same way `text-completions-no-server-url.test.js` mounts this route: boot a real
 * SillyTavern via `startSillyTavern` and talk to it over HTTP, because that is the only way this
 * repository exercises `src/endpoints/backends/text-completions.js` — there is no lighter-weight router
 * mount anywhere else in the test tree to imitate instead.
 */
describe('🔴 Featherless /status caches the model list instead of re-downloading it on every Connect', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;
    /** @type {http.Server} */
    let backend;
    /** @type {string} */
    let backendUrl;

    /** A small stand-in for Featherless's real 22,009-model catalog — see the file comment. */
    const KNOWN_MODELS = [
        { id: 'zai-org/GLM-5.2', model_class: 'chat', context_length: 128000 },
        { id: 'meta-llama/Llama-4', model_class: 'chat', context_length: 64000 },
        { id: 'mistralai/Mixtral', model_class: 'chat', context_length: 32000 },
    ];

    /** Every `/v1/models` list request the fake backend received. */
    const listHits = [];
    /** Every `/v1/models/{id}` single-model request the fake backend received, by requested id. */
    const modelHits = [];

    beforeAll(async () => {
        scratch = makeScratchDirectory('featherless-status');

        backend = http.createServer((request, response) => {
            const url = new URL(request.url, 'http://localhost');

            if (url.pathname === '/v1/models') {
                listHits.push(url.pathname);
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ data: KNOWN_MODELS }));
                return;
            }

            const singleModelMatch = url.pathname.match(/^\/v1\/models\/(.+)$/);

            if (singleModelMatch) {
                const requestedId = decodeURIComponent(singleModelMatch[1]);
                modelHits.push(requestedId);
                const model = KNOWN_MODELS.find(m => m.id === requestedId);

                if (model) {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify(model));
                } else {
                    response.writeHead(404, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ error: 'not found' }));
                }
                return;
            }

            response.writeHead(404);
            response.end();
        });

        await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
        backendUrl = `http://127.0.0.1:${backend.address().port}`;

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
    }, 120_000);

    afterAll(async () => {
        await st?.stop();
        await new Promise(resolve => backend?.close(() => resolve(undefined)));
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    /**
     * @param {object} [extra] Extra body fields (`model`, `refresh_models`)
     * @returns {Promise<{status: number, body: any}>} The route's answer
     */
    async function status(extra = {}) {
        const response = await fetch(`${base}/api/backends/text-completions/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_type: 'featherless',
                api_server: backendUrl,
                ...extra,
            }),
        });

        return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    // Tests below run in declaration order against ONE shared server and ONE shared fake backend,
    // deliberately — each one depends on the cache state the previous one left behind, the same way a
    // real user's session of repeated Connect clicks would.

    test('🔴 first connect with no cache fetches the full list once and writes the cache file to disk', async () => {
        const { status: code, body } = await status();

        expect(code).toBe(200);
        expect(body.cached).toBe(false);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data).toHaveLength(KNOWN_MODELS.length);
        expect(typeof body.cached_at).toBe('string');
        expect(listHits).toHaveLength(1);

        const cacheKey = new URL(backendUrl).host.toLowerCase().replace(/[^a-z0-9.-]/g, '');
        const cacheFile = path.join(scratch, 'data', '_cache', 'model-lists', `${cacheKey}.json`);
        expect(fs.existsSync(cacheFile)).toBe(true);

        const written = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        expect(written.models).toEqual(KNOWN_MODELS);
    });

    test('🔴 a connect with a model already picked hits ONLY the single-model URL, never the list again', async () => {
        const listHitsBefore = listHits.length;

        const { status: code, body } = await status({ model: KNOWN_MODELS[0].id });

        expect(code).toBe(200);
        expect(body.cached).toBe(true);
        expect(body.result).toBe(KNOWN_MODELS[0].id);
        // An ordinary Connect returns cache metadata without the catalog.
        expect(body.data).toEqual([]);
        expect(body.cached_models).toBe(KNOWN_MODELS.length);
        expect(modelHits).toContain(KNOWN_MODELS[0].id);

        // The entire point of the cache: this connect must not have re-downloaded the list.
        expect(listHits.length).toBe(listHitsBefore);
    });

    test('an unknown model is refused with a 400 that names it, and the list is still not re-fetched', async () => {
        const listHitsBefore = listHits.length;

        const { status: code, body } = await status({ model: 'nobody-serves-this/model' });

        expect(code).toBe(400);
        expect(body.error).toMatch(/nobody-serves-this\/model/);
        expect(listHits.length).toBe(listHitsBefore);
    });

    test('🔴 refresh_models: true forces a full re-fetch even though a cache already exists', async () => {
        const listHitsBefore = listHits.length;

        const { status: code, body } = await status({ refresh_models: true });

        expect(code).toBe(200);
        expect(body.cached).toBe(false);
        expect(body.data).toHaveLength(KNOWN_MODELS.length);
        expect(listHits.length).toBe(listHitsBefore + 1);
    });

    test('with no model and no refresh, an existing cache answers from disk with zero network calls', async () => {
        const listHitsBefore = listHits.length;
        const modelHitsBefore = modelHits.length;

        const { status: code, body } = await status();

        expect(code).toBe(200);
        expect(body.cached).toBe(true);
        expect(body.data).toEqual([]);
        expect(body.cached_models).toBe(KNOWN_MODELS.length);
        expect(listHits.length).toBe(listHitsBefore);
        expect(modelHits.length).toBe(modelHitsBefore);
    });
});

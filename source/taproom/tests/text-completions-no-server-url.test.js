import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 A BLANK SERVER URL IS REFUSED BY NAME, NOT BY `fetch` THROWING FROM UNDICI.
 *
 * `resolveTextCompletionsUrl` is string concatenation. Hand it an empty `api_server` and it returns the
 * RELATIVE path `/v1/completions`, which `fetch` rejects with a bare `ERR_INVALID_URL` — a code, and nothing
 * naming the api type, the setting, or which of the several places a server URL can come from was empty.
 *
 * That is not hypothetical. It happened live: Qvink Memory issues its summaries through
 * `ConnectionManagerRequestService.sendRequest`, which passes `profile['api-url']` verbatim, and a connection
 * profile stores `''` for a blank Server URL. The user saw four toasts reading "Response not OK" and the log
 * held one line ending `[ERR_INVALID_URL]`. Everything needed to diagnose it was in scope at the failure and
 * was discarded.
 *
 * The client-side half — the `??` that should have been `||`, which let the empty string through in the first
 * place — is pinned in `tests/frontend/plugin-text-path.e2e.js`, because `custom-request.js` transitively
 * imports the whole application and cannot be loaded here. This file pins the server's backstop: whatever
 * reaches the route, an unusable target is refused with a message a human can act on.
 */
describe('🔴 text completions refuse an unusable server URL, and say which setting is empty', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;

    /** Every request that reached the scripted backend — the control for "it was never sent". */
    const reached = [];
    /** @type {http.Server} */
    let backend;
    /** @type {string} */
    let backendUrl;

    beforeAll(async () => {
        scratch = makeScratchDirectory('no-server-url');

        backend = http.createServer((request, response) => {
            let body = '';
            request.on('data', chunk => body += chunk.toString());
            request.on('end', () => {
                reached.push({ url: request.url });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ choices: [{ text: 'ok' }] }));
            });
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
     * @param {string} apiServer What the client put in `api_server`
     * @returns {Promise<{status: number, body: any}>} The route's answer
     */
    async function generate(apiServer) {
        const response = await fetch(`${base}/api/backends/text-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_type: 'ooba',
                api_server: apiServer,
                prompt: 'The rendered prompt.',
                max_tokens: 8,
                stream: false,
            }),
        });

        return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    test('🔴 an empty server URL is a 400 that names the api type — not an opaque ERR_INVALID_URL', async () => {
        const { status, body } = await generate('');

        expect(status).toBe(400);
        expect(body.status).toBe('NO_SERVER_URL');

        // The message has to be actionable on its own, because it is what reaches the toast.
        expect(body.response).toMatch(/ooba/);
        expect(body.response).toMatch(/connection profile/i);
    });

    test('🔴 and the request was never sent — a refusal that still calls the backend is not a refusal', async () => {
        // Stated separately because the assertion above passes just as well on a route that fires the request,
        // fails somewhere downstream, and happens to answer 400.
        expect(reached).toHaveLength(0);
    });

    test('a relative path is refused the same way — that is the exact shape the bug produced', async () => {
        // `'' + '/v1/completions'` is what the concatenation yields, so this is the literal failing value.
        const { status, body } = await generate('/v1');

        expect(status).toBe(400);
        expect(body.status).toBe('NO_SERVER_URL');
        expect(reached).toHaveLength(0);
    });

    test('🔴 CONTROL: a real absolute URL still reaches the backend and is not refused', async () => {
        // Without this the suite is satisfied by a route that refuses EVERYTHING, which would take the whole
        // text path down while every assertion above stayed green.
        const { status } = await generate(backendUrl);

        expect(status).not.toBe(400);
        expect(reached.length).toBeGreaterThan(0);
        expect(reached[0].url).toBe('/v1/completions');
    });
});

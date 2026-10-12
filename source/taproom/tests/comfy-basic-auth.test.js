import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

import { getComfyAuthCredential } from '../public/scripts/extensions/stable-diffusion/comfy-auth.js';
import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 THE COMFYUI CLIENT SENT `Authorization` ON ONE OF ITS NINE CALLS.
 *
 * `/interrupt` had it. `/system_stats`, four `/object_info` lookups, `POST /prompt`, the `/history`
 * poll and the `/view` image fetch all went out bare — so a ComfyUI behind any authenticating proxy
 * was reachable for cancellation and nothing else. The `auto` (A1111) router in the same file sends it
 * on all fourteen of its calls, so this was an omission rather than a design.
 *
 * Two properties are asserted here, and the second is the one that makes the feature safe rather than
 * merely present:
 *
 *   ON  — every one of the nine carries `Basic base64(user:password)`.
 *   OFF — every one of the nine carries NO `Authorization` header at all, *while the username and
 *         password are still populated in settings*. Off must be byte-for-byte what this endpoint did
 *         before it could authenticate, and "the fields happen to be empty" is not what makes it so.
 *
 * ⚠️ `getBasicAuthHeader('')` IS NOT NOTHING — it is the string `Basic ` (base64 of the empty string),
 * because the `auto` router it was written for sends the header unconditionally. Spreading that onto
 * these fetches would put a header on the wire where there was none, which is why the endpoint uses
 * `getComfyAuthHeaders` and why the OFF assertions below check for absence rather than for emptiness.
 */
describe('🔴 ComfyUI carries HTTP basic auth on every call, and none when the box is unchecked', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;

    /** @type {http.Server} */
    let comfy;
    /** @type {string} */
    let comfyUrl;

    /**
     * Every request the fake ComfyUI received: `{ path, method, authorization }`.
     * `authorization` is `undefined` when the header was absent, which is the distinction under test.
     * @type {Array<{path: string, method: string, authorization: string|undefined}>}
     */
    let received = [];

    /**
     * When set, the fake ComfyUI answers 401 to anything that does not present exactly this header.
     * @type {string|null}
     */
    let requiredAuth = null;

    /** Paths to enforce {@link requiredAuth} on. Empty means "all of them". */
    let enforceOnly = [];

    const USER = 'comfy';
    const PASSWORD = 'sekrit:with:colons';
    const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

    /** A one-pixel PNG, so the `/view` fetch has something real to hand back. */
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

    /**
     * The `/object_info` payload, shaped exactly as the four list endpoints destructure it. They index
     * into `data.KSampler.input.required.…` without guarding, so a thinner fixture fails as a
     * TypeError that looks nothing like an auth problem.
     */
    const OBJECT_INFO = {
        KSampler: { input: { required: { sampler_name: [['euler']], scheduler: [['normal']] } } },
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['some_model.safetensors']] } } },
        UNETLoader: { input: { required: { unet_name: [['some_unet.safetensors']] } } },
        VAELoader: { input: { required: { vae_name: [['some_vae.safetensors']] } } },
    };

    beforeAll(async () => {
        scratch = makeScratchDirectory('comfy-basic-auth');

        comfy = http.createServer((request, response) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            const authorization = request.headers.authorization;

            // Drain the body before answering — `POST /prompt` sends one, and leaving it unread stalls
            // the socket on some Node versions.
            request.on('data', () => { });
            request.on('end', () => {
                received.push({ path: url.pathname, method: request.method ?? '', authorization });

                const enforced = requiredAuth && (enforceOnly.length === 0 || enforceOnly.includes(url.pathname));

                if (enforced && authorization !== requiredAuth) {
                    response.writeHead(401, { 'Content-Type': 'text/plain' });
                    return response.end('Unauthorized');
                }

                const json = (payload) => {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify(payload));
                };

                switch (true) {
                    case url.pathname === '/system_stats':
                        return json({ system: { os: 'test' } });
                    case url.pathname === '/object_info':
                        return json(OBJECT_INFO);
                    case url.pathname === '/prompt':
                        return json({ prompt_id: 'test-prompt-id' });
                    case url.pathname.startsWith('/history/'):
                        return json({
                            'test-prompt-id': {
                                status: { status_str: 'success' },
                                outputs: { 9: { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } },
                            },
                        });
                    case url.pathname === '/view':
                        response.writeHead(200, { 'Content-Type': 'image/png' });
                        return response.end(PNG);
                    case url.pathname === '/interrupt':
                        return json({});
                    default:
                        response.writeHead(404);
                        return response.end();
                }
            });
        });

        await new Promise(resolve => comfy.listen(0, '127.0.0.1', resolve));
        comfyUrl = `http://127.0.0.1:${/** @type {any} */(comfy.address()).port}`;

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
    }, 240_000);

    afterAll(async () => {
        await st?.stop();
        await new Promise(resolve => comfy?.close(() => resolve(undefined)));
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    beforeEach(() => {
        received = [];
        requiredAuth = null;
        enforceOnly = [];
    });

    /**
     * Call one of the comfy endpoints the way the client does.
     * @param {string} route The route under `/api/sd/comfy`
     * @param {string} auth The credential to put in the body
     * @param {object} [extra] Any further body fields
     * @returns {Promise<{status: number, text: string}>} What the route answered
     */
    async function call(route, auth, extra = {}) {
        const response = await fetch(`${base}/api/sd/comfy/${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: comfyUrl, auth, ...extra }),
        });

        return { status: response.status, text: await response.text() };
    }

    /**
     * Drive a full generation, which is the only way to reach `/prompt`, `/history` and `/view`.
     * @param {string} auth The credential to put in the body
     * @returns {Promise<{status: number, text: string}>} What the route answered
     */
    async function generate(auth) {
        return await call('generate', auth, { prompt: JSON.stringify({ prompt: {} }) });
    }

    /** The five read-only routes, plus the generation that covers the remaining three. */
    const LIST_ROUTES = ['ping', 'samplers', 'models', 'schedulers', 'vaes'];

    /**
     * @param {string} pathname The ComfyUI path
     * @returns {Array<{path: string, method: string, authorization: string|undefined}>} Requests to it
     */
    function requestsTo(pathname) {
        return received.filter(entry => entry.path === pathname || (pathname === '/history' && entry.path.startsWith('/history/')));
    }

    describe('the credential the client composes', () => {
        // These are the client half of rule 1 -- the server can only send what it is given, so "off sends
        // nothing" has to be true before the request is built, not just after.
        const POPULATED = { comfy_auth_username: USER, comfy_auth_password: PASSWORD };

        test('🔴 unchecked composes NOTHING even with the username and password still filled in', () => {
            expect(getComfyAuthCredential({ ...POPULATED, comfy_auth_enabled: false })).toBe('');
        });

        test('checked composes username:password', () => {
            expect(getComfyAuthCredential({ ...POPULATED, comfy_auth_enabled: true })).toBe(`${USER}:${PASSWORD}`);
        });

        test('a password containing colons survives — the split is the FIRST colon, server-side', () => {
            // `sekrit:with:colons` is not an accident: basic auth is `user:everything-else`, and a client
            // that validated against colons would refuse a legal password.
            expect(getComfyAuthCredential({ ...POPULATED, comfy_auth_enabled: true })).toBe(`${USER}:sekrit:with:colons`);
        });

        test('absent settings compose nothing rather than throwing "undefined:undefined"', () => {
            expect(getComfyAuthCredential(undefined)).toBe('');
            expect(getComfyAuthCredential({})).toBe('');
            expect(getComfyAuthCredential({ comfy_auth_enabled: true })).toBe(':');
        });
    });

    describe('🔴 checkbox OFF — not one of the nine carries a header', () => {
        test('the five list routes send no Authorization at all', async () => {
            for (const route of LIST_ROUTES) {
                const { status } = await call(route, '');
                expect({ route, status }).toEqual({ route, status: 200 });
            }

            expect(received).toHaveLength(LIST_ROUTES.length);
            // `toBeUndefined` rather than `toBe('')`: `Basic ` is what a naive implementation puts here,
            // and it is a header, on the wire, where previously there was none.
            for (const entry of received) {
                expect({ path: entry.path, authorization: entry.authorization }).toEqual({ path: entry.path, authorization: undefined });
            }
        });

        test('and neither do /prompt, /history or /view', async () => {
            const { status } = await generate('');
            expect(status).toBe(200);

            for (const pathname of ['/prompt', '/history', '/view']) {
                const calls = requestsTo(pathname);
                expect({ pathname, count: calls.length }).toEqual({ pathname, count: 1 });
                expect({ pathname, authorization: calls[0].authorization }).toEqual({ pathname, authorization: undefined });
            }
        });
    });

    describe('checkbox ON — every one of the nine carries the credential', () => {
        test('the five list routes authenticate against a server that demands it', async () => {
            requiredAuth = EXPECTED;

            for (const route of LIST_ROUTES) {
                const { status } = await call(route, `${USER}:${PASSWORD}`);
                expect({ route, status }).toEqual({ route, status: 200 });
            }

            for (const entry of received) {
                expect({ path: entry.path, authorization: entry.authorization }).toEqual({ path: entry.path, authorization: EXPECTED });
            }
        });

        test('and so do /prompt, /history and /view', async () => {
            requiredAuth = EXPECTED;

            const { status } = await generate(`${USER}:${PASSWORD}`);
            expect(status).toBe(200);

            for (const pathname of ['/prompt', '/history', '/view']) {
                const calls = requestsTo(pathname);
                expect({ pathname, count: calls.length }).toEqual({ pathname, count: 1 });
                expect({ pathname, authorization: calls[0].authorization }).toEqual({ pathname, authorization: EXPECTED });
            }
        });

        test('the generated image still comes back — authenticating must not break the payload', async () => {
            requiredAuth = EXPECTED;

            const { status, text } = await generate(`${USER}:${PASSWORD}`);
            const body = JSON.parse(text);

            expect(status).toBe(200);
            expect(body.format).toBe('png');
            expect(Buffer.from(body.data, 'base64').equals(PNG)).toBe(true);
        });
    });

    describe('a rejected credential says so', () => {
        test('🔴 a wrong password surfaces as an authentication error, not a generic ComfyUI failure', async () => {
            requiredAuth = EXPECTED;

            const { status, text } = await generate(`${USER}:wrong-password`);

            expect(status).toBe(500);
            // The message reaches a toast. "ComfyUI returned an error" sends the user to their workflow;
            // this has to send them to the checkbox.
            expect(text).toMatch(/401/);
            expect(text).toMatch(/credential/i);
            expect(text).not.toMatch(/recognizable outputs/i);
        });

        test('so does an unchecked box against a server that requires one', async () => {
            requiredAuth = EXPECTED;

            const { status } = await call('ping', '');

            // `/ping` answers with a bare status rather than the message, so the assertion that matters
            // here is the wire: it really did go out unauthenticated, which is what the 401 is about.
            expect(status).toBe(500);
            expect(requestsTo('/system_stats')[0].authorization).toBeUndefined();
        });
    });

    describe('🔴 the /view fetch — the one that fails after the work is already done', () => {
        test('a 401 at /view alone is reported as a credential problem, having generated the image first', async () => {
            // Enforced ONLY on /view, which reproduces the exact shape of the bug this rule exists for:
            // the prompt is accepted, the GPU does the work, the history poll succeeds, and retrieval is
            // where the missing header bites. Everything up to that point looks like a healthy run.
            requiredAuth = EXPECTED;
            enforceOnly = ['/view'];

            const { status, text } = await generate('');

            expect(status).toBe(500);
            expect(requestsTo('/prompt')).toHaveLength(1);
            expect(requestsTo('/history')).toHaveLength(1);
            expect(text).toMatch(/401/);
            expect(text).toMatch(/credential/i);
        });

        test('CONTROL: with the credential, that same server returns the image', async () => {
            // Without this, the assertions above are satisfied by a /view that is broken for every
            // request, which would take image generation down while the suite stayed green.
            requiredAuth = EXPECTED;
            enforceOnly = ['/view'];

            const { status, text } = await generate(`${USER}:${PASSWORD}`);

            expect(status).toBe(200);
            expect(JSON.parse(text).format).toBe('png');
        });
    });
});

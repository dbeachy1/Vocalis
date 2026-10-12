import { afterEach, beforeAll, describe, test, expect, jest } from '@jest/globals';
import { once, EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

/**
 * 🔴 EVERY FIXTURE IN THIS FILE IS SYNTHETIC, PER CACHE LENS RAW GENERATION ROWS DESIGN §12 AND §15.2's OWN
 * REQUIREMENT THAT NO TEST LOG, FIXTURE OR SNAPSHOT CONTAIN PROMPT, CONTENT, REASONING OR AUTHORIZATION DATA.
 * Message "content" below is a fixed, non-personal placeholder string; SSE bodies carry only ids and token
 * counts; the "API key" is a fixed throwaway literal that reaches nothing but a mocked `fetch`.
 */

// 🔴 MUST BE REGISTERED BEFORE `chat-completions.js` IS IMPORTED. `chat-completions.js` does
// `import fetch from 'node-fetch'` — a static, top-level binding — so the mock has to be in place before
// that import resolves, or the real `node-fetch` package (and a real network call) would be bound instead.
// See jest's ESM docs: `jest.unstable_mockModule` + a dynamic `import()` afterward is the supported pattern
// for mocking an ES module dependency of the module under test.
const mockFetch = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({
    __esModule: true,
    default: mockFetch,
}));

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/prompt-record.js').getRecords} */
let getRecords;
/** @type {typeof import('../src/prompt-record.js').clearRecords} */
let clearRecords;
/** @type {typeof import('../src/util.js').forwardFetchResponse} */
let forwardFetchResponse;
/** @type {typeof import('../src/logger.js').log} */
let log;
/** @type {typeof import('../src/logger.js').LogClass} */
let LogClass;
/** @type {typeof import('../src/constants.js').CHAT_COMPLETION_SOURCES} */
let CHAT_COMPLETION_SOURCES;

beforeAll(async () => {
    // `chat-completions.js` pulls in `prompt-converters.js`, which reads the config file AT MODULE SCOPE
    // (`getConfigValue('promptPlaceholder', ...)` on its very first line) and calls `process.exit(1)` if no
    // config path was ever set — same reason `session-cookie-name.test.js` and the other tests that reach
    // `users.js` set this before their first dynamic import.
    const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/backends/chat-completions.js'));
    ({ getRecords, clearRecords } = await import('../src/prompt-record.js'));
    ({ forwardFetchResponse } = await import('../src/util.js'));
    ({ log, LogClass } = await import('../src/logger.js'));
    ({ CHAT_COMPLETION_SOURCES } = await import('../src/constants.js'));
});

afterEach(() => {
    jest.restoreAllMocks();
    mockFetch.mockReset();
    // The tracked-prompt map in `prompt-record.js` is module-level state that outlives any one test.
    clearRecords();
});

/**
 * Pull the `POST /generate` handler straight off the router, bypassing HTTP entirely. This is transport
 * WIRING under test — the router's dispatch, the DeepSeek helper, `forwardFetchResponse` — not Express's own
 * routing, and no HTTP server or `supertest`-style client is needed to exercise it.
 * @param {import('express').Router} expressRouter
 * @param {string} method HTTP method, lowercase
 * @param {string} routePath The route path, exactly as registered
 * @returns {Function} The registered handler
 */
function findRouteHandler(expressRouter, method, routePath) {
    const layer = expressRouter.stack.find(candidate => candidate.route
        && candidate.route.path === routePath
        && candidate.route.methods[method]);

    if (!layer) {
        throw new Error(`No ${method.toUpperCase()} route registered for ${routePath} — cannot find the handler under test.`);
    }

    return layer.route.stack[0].handle;
}

const HANDLE = 'synthetic-test-user';

/**
 * A minimal stand-in for an Express `Request`, carrying exactly what the router and the DeepSeek helper
 * read: `body`, `user`, a header reader, and a `socket` (an `EventEmitter`, so a test can simulate a client
 * disconnect with `req.socket.emit('close')`, exactly like `sendDeepSeekRequest`'s own abort wiring expects).
 * @param {object} [overrides]
 * @param {object} [overrides.body]
 * @param {Record<string, string>} [overrides.headers]
 * @returns {object}
 */
function makeRequest({ body, headers = {} } = {}) {
    return {
        body,
        user: { profile: { handle: HANDLE }, directories: { root: 'synthetic-root' } },
        socket: new EventEmitter(),
        get(name) {
            const lower = String(name).toLowerCase();
            const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === lower);
            return key ? headers[key] : undefined;
        },
    };
}

/**
 * A minimal stand-in for an Express `Response`. It IS a real `PassThrough` so the streaming path's real
 * `.pipe()` calls, backpressure and `'close'`/`'finish'` events all behave exactly as they do against a real
 * `http.ServerResponse` — only the non-streaming `status()`/`send()` pair is a hand-rolled shim, because the
 * non-streaming path never touches the underlying stream at all.
 */
class MockResponse extends PassThrough {
    constructor() {
        super();
        this.statusCode = 200;
        this.statusMessage = '';
        this.headers = {};
        this.headersSent = false;
        this.socket = new EventEmitter();
        this.sentBody = undefined;
    }

    setHeader(name, value) {
        this.headers[name] = value;
    }

    status(code) {
        this.statusCode = code;
        return this;
    }

    send(body) {
        this.headersSent = true;
        this.sentBody = body;
        return this;
    }
}

/**
 * A fake `node-fetch` `Response`, duck-typed to exactly what `sendDeepSeekRequest`/`forwardFetchResponse`
 * read (`ok`, `status`, `statusText`, `json()`, `text()`, `body`) — see the design note above the `mockFetch`
 * declaration for why this does not need to be a real `node-fetch` `Response` instance: nothing in either
 * consumer does an `instanceof` check.
 * @param {object} [options]
 * @param {number} [options.status]
 * @param {string} [options.statusText]
 * @param {object} [options.json]
 * @param {string} [options.text]
 * @param {import('stream').Readable} [options.body]
 * @returns {object}
 */
function fakeFetchResponse({ status = 200, statusText = 'OK', json, text, body } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        json: async () => json,
        text: async () => (text !== undefined ? text : (json !== undefined ? JSON.stringify(json) : '')),
        body,
    };
}

/**
 * A synthetic, non-personal chat-completion request body for the DeepSeek backend.
 * `reverse_proxy`/`proxy_password` sidestep `readSecret()` reading a real secrets store — the router only
 * cares that SOME API key string is present, and a mocked `fetch` never actually uses it.
 * @param {object} [overrides]
 * @returns {object}
 */
function deepSeekRequestBody(overrides = {}) {
    return {
        chat_completion_source: CHAT_COMPLETION_SOURCES.DEEPSEEK,
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Synthetic test message; not real conversation content.' }],
        reverse_proxy: 'https://deepseek.example.test',
        proxy_password: 'synthetic-test-key',
        stream: false,
        ...overrides,
    };
}

/**
 * The single record this test's request produced, if any. Asserts there is exactly one so a test cannot
 * silently pass by reading a stale record left by a previous run.
 * @returns {import('../src/prompt-record.js').PromptRecord}
 */
function theOnlyRecord() {
    const records = getRecords(HANDLE, 'chat');
    expect(records).toHaveLength(1);
    return records[0];
}

describe('sendDeepSeekRequest — the generation never reached the provider', () => {
    /**
     * The missing-key guard runs before the `finalizeRecord` closure and socket `'close'` handler. This
     * regression check ensures that a request rejected before contacting the provider still finalizes its
     * prompt record.
     *
     * ⚠️ `failed`, not `cancelled`. Nobody disconnected — the request was refused for a configuration
     * reason before a provider was ever contacted. And it carries no usage, because §11.1 says a
     * non-completed outcome never does and there was nothing to measure regardless.
     */
    test('a request refused for a missing API key finalizes "failed" instead of leaving the record pending', async () => {
        const handler = findRouteHandler(router, 'post', '/generate');
        // Neither half of the key check can be satisfied: no reverse proxy, and `readSecret` finds nothing
        // under a synthetic user root. This is the shape a real account with no DeepSeek key produces.
        const request = makeRequest({ body: deepSeekRequestBody({ reverse_proxy: undefined, proxy_password: undefined }) });
        const response = new MockResponse();

        await handler(request, response);

        expect(response.statusCode).toBe(400);

        const record = theOnlyRecord();

        expect(record.status).toBe('failed');
        expect(record.completedAt).toEqual(expect.any(Number));
        expect(record.usage).toBeUndefined();
        expect(record.usageState).toBe('absent');
    });
});

describe('sendDeepSeekRequest — non-streaming', () => {
    test('a completed response finalizes "completed" with normalized usage, and the browser gets the provider JSON byte-identically', async () => {
        const handler = findRouteHandler(router, 'post', '/generate');
        const providerJson = {
            id: 'synthetic-completion-1',
            choices: [{ message: { role: 'assistant', content: 'Synthetic reply text.' } }],
            usage: {
                prompt_tokens: 1000,
                prompt_cache_hit_tokens: 800,
                prompt_cache_miss_tokens: 200,
                completion_tokens: 12,
                total_tokens: 1012,
            },
        };
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({ status: 200, json: providerJson }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: false }) });
        const res = new MockResponse();

        await handler(req, res);

        // Byte-identical: not "equivalent JSON", the exact object the provider sent, unreshaped.
        expect(res.sentBody).toEqual(providerJson);
        expect(JSON.stringify(res.sentBody)).toBe(JSON.stringify(providerJson));

        const record = theOnlyRecord();
        expect(record.status).toBe('completed');
        expect(record.usageState).toBe('available');
        expect(record.usage).toEqual({
            schema: 'input-cache-v1',
            inputTokens: 1000,
            cachedTokens: 800,
            uncachedTokens: 200,
            provider: 'deepseek',
            api: 'chat-completions',
        });
    });

    test('a provider HTTP error finalizes "failed", and no error body or message reaches the record', async () => {
        const handler = findRouteHandler(router, 'post', '/generate');
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({
            status: 500,
            statusText: 'Internal Server Error',
            text: 'synthetic upstream failure detail, never persisted',
        }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: false }) });
        const res = new MockResponse();

        await handler(req, res);

        expect(res.statusCode).toBe(500);

        const record = theOnlyRecord();
        expect(record.status).toBe('failed');
        expect(record.usage).toBeUndefined();
        expect(record.usageState).not.toBe('available');
        // The record has no field at all that could hold error text or a message — confirm the whole
        // record, not just the two fields above, carries nothing derived from the provider's error body.
        expect(JSON.stringify(record)).not.toContain('synthetic upstream failure detail');
    });
});

describe('sendDeepSeekRequest — streaming', () => {
    /** One SSE `data:` event, terminated by a blank line. */
    function sseEvent(dataObjectOrRaw) {
        const payload = typeof dataObjectOrRaw === 'string' ? dataObjectOrRaw : JSON.stringify(dataObjectOrRaw);
        return Buffer.from(`data: ${payload}\n\n`, 'utf8');
    }

    test('forwarded bytes are exactly identical to the input bytes, and a normal end finalizes "completed" with the observed usage', async () => {
        const handler = findRouteHandler(router, 'post', '/generate');
        const upstream = new PassThrough();
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: upstream }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: true }) });
        const res = new MockResponse();

        const collected = [];
        res.on('data', chunk => collected.push(Buffer.from(chunk)));
        const finished = once(res, 'finish');

        await handler(req, res);

        const chunks = [
            sseEvent({ id: 'synthetic-chunk-1', choices: [{ delta: { content: 'Hi' } }] }),
            sseEvent({
                id: 'synthetic-chunk-2',
                usage: { prompt_tokens: 500, prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 200 },
            }),
            Buffer.from('data: [DONE]\n\n', 'utf8'),
        ];

        for (const chunk of chunks) {
            upstream.write(chunk);
        }
        upstream.end();

        await finished;

        const expected = Buffer.concat(chunks);
        const actual = Buffer.concat(collected);
        expect(actual.equals(expected)).toBe(true);

        const record = theOnlyRecord();
        expect(record.status).toBe('completed');
        expect(record.usageState).toBe('available');
        expect(record.usage).toEqual({
            schema: 'input-cache-v1',
            inputTokens: 500,
            cachedTokens: 300,
            uncachedTokens: 200,
            provider: 'deepseek',
            api: 'chat-completions',
        });
    });

    test('backpressure is preserved: a downstream write() returning false pauses forwarding until "drain"', async () => {
        // 🔴 WHY THIS CONTROLS `res.write()` DIRECTLY RATHER THAN RELYING ON BUFFER-SIZE THRESHOLDS: every
        // stream in this chain (`upstream`, `DeepSeekUsageObserver`, and the `PassThrough`-based `res` mock)
        // calls its own transform callback synchronously, so a burst small enough to fit in default/small
        // `highWaterMark`s round-trips before `.write()` even returns and never actually observes a `false`
        // — that is what made an earlier version of this test flaky. Forcing `res.write()` to report
        // backpressure on demand tests the real mechanism deterministically: Node's own `.pipe()`
        // implementation pauses its SOURCE when `dest.write()` returns false and resumes it on `dest`'s
        // `'drain'` event. A naive `on('data', chunk => to.write(chunk))` forwarder (not `.pipe()`) would
        // ignore the `false` return entirely and this test would fail on the second assertion below.
        const handler = findRouteHandler(router, 'post', '/generate');
        const upstream = new PassThrough();
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: upstream }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: true }) });
        const res = new MockResponse();

        const collected = [];
        let signalBackpressure = true;
        jest.spyOn(res, 'write').mockImplementation((chunk, encodingOrCallback, maybeCallback) => {
            collected.push(Buffer.from(chunk));
            const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
            if (typeof callback === 'function') {
                queueMicrotask(callback);
            }
            return !signalBackpressure;
        });

        await handler(req, res);

        upstream.write(Buffer.from('synthetic-chunk-one'));
        await new Promise(resolve => setImmediate(resolve));
        expect(collected).toHaveLength(1);

        // A second chunk while `res.write()` is still reporting backpressure must NOT be forwarded yet —
        // the pipe chain is expected to be paused, holding it back.
        upstream.write(Buffer.from('synthetic-chunk-two'));
        await new Promise(resolve => setImmediate(resolve));
        expect(collected).toHaveLength(1);

        // Draining releases exactly the held-back chunk.
        signalBackpressure = false;
        res.emit('drain');
        await new Promise(resolve => setImmediate(resolve));
        expect(collected).toHaveLength(2);
        expect(Buffer.concat(collected).toString('utf8')).toBe('synthetic-chunk-onesynthetic-chunk-two');
    });

    test('a downstream close destroys the upstream stream, as it does today', async () => {
        const handler = findRouteHandler(router, 'post', '/generate');
        const upstream = new PassThrough();
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: upstream }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: true }) });
        const res = new MockResponse();
        res.resume();

        await handler(req, res);

        expect(upstream.destroyed).toBe(false);
        res.socket.emit('close');
        expect(upstream.destroyed).toBe(true);
    });

    test('an abort (client disconnect) finalizes "cancelled" with no usage', async () => {
        const handler = findRouteHandler(router, 'post', '/generate');
        const upstream = new PassThrough();
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: upstream }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: true }) });
        const res = new MockResponse();
        res.resume();

        await handler(req, res);

        // The existing abort / client-disconnect path: the INCOMING request's socket closing, not the
        // response's. `sendDeepSeekRequest` reuses exactly this listener to both abort the upstream fetch
        // and finalize the record.
        req.socket.emit('close');

        const record = theOnlyRecord();
        expect(record.status).toBe('cancelled');
        expect(record.usage).toBeUndefined();
        expect(record.usageState).not.toBe('available');
    });

    test('a provider HTTP error on the streaming path finalizes "failed" with no usage', async () => {
        const handler = findRouteHandler(router, 'post', '/generate');
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({
            status: 503,
            statusText: 'Service Unavailable',
            text: 'synthetic streaming provider failure',
            body: Readable.from([]),
        }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: true }) });
        const res = new MockResponse();
        res.resume();

        await handler(req, res);
        await once(res, 'finish');

        const record = theOnlyRecord();
        expect(record.status).toBe('failed');
        expect(record.usage).toBeUndefined();
    });

    test('a mid-stream provider/stream error finalizes "failed" with no usage', async () => {
        const handler = findRouteHandler(router, 'post', '/generate');
        const upstream = new PassThrough();
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: upstream }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: true }) });
        const res = new MockResponse();
        res.resume();

        await handler(req, res);

        upstream.write(sseEvent({ id: 'synthetic-chunk-1' }));
        upstream.emit('error', new Error('synthetic mid-stream failure'));

        const record = theOnlyRecord();
        expect(record.status).toBe('failed');
        expect(record.usage).toBeUndefined();
    });

    test('finalization happens exactly once even when abort and stream error both fire', async () => {
        const warnSpy = jest.spyOn(log, 'warn');
        const handler = findRouteHandler(router, 'post', '/generate');
        const upstream = new PassThrough();
        mockFetch.mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: upstream }));

        const req = makeRequest({ body: deepSeekRequestBody({ stream: true }) });
        const res = new MockResponse();
        res.resume();

        await handler(req, res);

        // Both fire "in the same tick" — the abort first, then a stream error racing right behind it.
        req.socket.emit('close');
        upstream.emit('error', new Error('synthetic race failure'));

        const record = theOnlyRecord();
        // The FIRST one to land wins — the abort — and the second is a locally-guarded no-op, never a
        // contradictory finalization landing on the record.
        expect(record.status).toBe('cancelled');

        const contradictoryWarning = warnSpy.mock.calls.find(call => typeof call[1] === 'string' && call[1].includes('contradictory'));
        expect(contradictoryWarning).toBeUndefined();
    });
});

describe('forwardFetchResponse — every other provider is unaffected by the observer parameter', () => {
    function createPipeTarget() {
        const target = new PassThrough();
        target.statusCode = 200;
        target.statusMessage = '';
        target.socket = new EventEmitter();
        return target;
    }

    test('a 401 from the provider is remapped to 400 for the browser, with no observer argument at all', async () => {
        const to = createPipeTarget();
        const upstream = new PassThrough();
        upstream.end();

        await forwardFetchResponse(fakeFetchResponse({ status: 401, statusText: 'Unauthorized', body: upstream }), to);

        expect(to.statusCode).toBe(400);
    });

    test('a non-2xx response still forwards the error body and returns, exactly as before', async () => {
        const to = createPipeTarget();
        const chunks = [];
        to.on('data', chunk => chunks.push(Buffer.from(chunk)));
        const finished = once(to, 'finish');
        const warnSpy = jest.spyOn(log, 'warn').mockImplementation(() => undefined);

        await forwardFetchResponse(fakeFetchResponse({ status: 502, statusText: 'Bad Gateway', text: 'synthetic gateway failure' }), to);
        await finished;

        expect(to.statusCode).toBe(502);
        expect(Buffer.concat(chunks).toString('utf8')).toBe('synthetic gateway failure');
        expect(warnSpy).toHaveBeenCalledWith(LogClass.NORMAL, 'Streaming request failed with status 502 Bad Gateway');
    });

    test('a normal 2xx stream still forwards bytes and destroys the upstream on a downstream close, exactly as before', async () => {
        const to = createPipeTarget();
        const upstream = new PassThrough();

        const collected = [];
        to.on('data', chunk => collected.push(Buffer.from(chunk)));

        await forwardFetchResponse(fakeFetchResponse({ status: 200, body: upstream }), to);

        upstream.write(Buffer.from('synthetic-provider-bytes'));
        expect(upstream.destroyed).toBe(false);

        to.socket.emit('close');
        expect(upstream.destroyed).toBe(true);
    });
});

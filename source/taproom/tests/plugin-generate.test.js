import http from 'node:http';

import { captureConnection, generate, readInstructEnvelope, readConnectionHeader, panelConnectionCapture, resolveTextCompletionsUrl, filterBodyForBackend, _clearConnections } from '../src/plugin-generate.js';
import { TEXTGEN_TYPES, FEATHERLESS_KEYS } from '../src/constants.js';
import { registerStorageProvider, unregisterStorageProvider } from '../src/storage.js';

/**
 * `context.generate` — a plugin runs a completion against the backend the user is already talking to.
 *
 * The witness is a real fake backend, not the function's intent: every assertion that matters checks what left
 * the process (the request body the server received) or what came back, following the lesson in
 * DESIGN_MEMORY_PLUGIN_API.md §12.5 — an interceptor that runs but changes nothing looked green until the test
 * observed the far end of the wire.
 */
describe('context.generate — backend completion for plugins', () => {
    /** @type {http.Server} */
    let server;
    /** @type {number} */
    let port;
    /** @type {{url: string, method: string, body: any, headers: any}|undefined} */
    let lastRequest;

    /**
     * Write a completions body as SSE, the way every backend in the family answers `stream: true`.
     *
     * ⚠️ ONE FRAME PER WRITE, AND `[DONE]` LAST. The point of the fake is that it exercises the framing, not
     * just the JSON: a parser that only ever sees a single whole frame is not being tested against the thing
     * that actually goes wrong on the wire (see the split-frame test below, which writes deliberately badly).
     * @param {import('http').ServerResponse} res
     * @param {object[]} chunks Payloads to send, in order
     * @returns {void}
     */
    const sse = (res, chunks) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of chunks) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    };

    /** One completions frame, in the shape the OpenAI-completions family sends. */
    const frame = (text, finishReason = null) => ({ choices: [{ text, index: 0, finish_reason: finishReason }] });

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', chunk => { raw += chunk; });
            req.on('end', () => {
                lastRequest = { url: req.url, method: req.method, body: raw ? JSON.parse(raw) : {}, headers: req.headers };

                if (req.url === '/v1/completions') {
                    // Split across frames on purpose: a backend streams words, and the accumulation is the
                    // thing under test. Concatenated, this is the sentence every caller below expects.
                    sse(res, [frame('REMEMBERED: '), frame('the cabin '), frame('by the lake', 'stop')]);
                    return;
                }
                if (req.url === '/fail/v1/completions') {
                    res.writeHead(500);
                    res.end('backend on fire');
                    return;
                }
                if (req.url === '/echo400/v1/completions') {
                    // What a real OpenAI-compatible backend does with a body it does not like: it quotes it back.
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'unknown field', body: lastRequest.body } }));
                    return;
                }
                if (req.url === '/empty/v1/completions') {
                    sse(res, [{ choices: [{}] }]); // ok status, streamed, but no text field
                    return;
                }
                if (req.url === '/nochoices/v1/completions') {
                    sse(res, [{ id: 'x', object: 'text_completion' }]); // well-formed frames, no choices at all
                    return;
                }
                if (req.url === '/reasoning/v1/completions') {
                    // A reasoning model: two channels per frame, and only one of them is the answer.
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ choices: [{ text: '', reasoning: 'The user mentioned a cabin. I should' }] })}\n\n`);
                    res.write(`data: ${JSON.stringify({ choices: [{ text: 'the cabin', reasoning: ' record the place.' }] })}\n\n`);
                    res.write(`data: ${JSON.stringify({ choices: [{ text: '', finish_reason: 'stop' }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                if (req.url === '/truncated/v1/completions') {
                    // The reasoning-model failure ask 3 exists for: the whole budget went on thinking.
                    sse(res, [{ choices: [{ text: '', reasoning: 'thinking'.repeat(50), finish_reason: 'length' }] }]);
                    return;
                }
                if (req.url === '/split/v1/completions') {
                    // 🔴 A FRAME TORN ACROSS TWO TCP WRITES, which is routine on a real connection and is the
                    // one thing a per-read parser gets wrong. `flushHeaders` + separate writes forces it.
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.flushHeaders();
                    const whole = `data: ${JSON.stringify(frame('the cabin by the lake', 'stop'))}\n\n`;
                    res.write(whole.slice(0, 30));
                    setTimeout(() => {
                        res.write(whole.slice(30));
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }, 20);
                    return;
                }
                if (req.url === '/crlf/v1/completions') {
                    // A proxy that normalises line endings: the separator is CRLFCRLF, not LFLF.
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify(frame('by the lake', 'stop'))}\r\n\r\n`);
                    res.write('data: [DONE]\r\n\r\n');
                    res.end();
                    return;
                }
                if (req.url === '/streamerror/v1/completions') {
                    // Featherless's shape: headers are fine, and the failure is announced inside the stream.
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ error: { message: 'No successful response received from completion service', prompt: 'SECRET CONVERSATION TEXT' } })}\n\n`);
                    res.end();
                    return;
                }
                if (req.url === '/multibyte/v1/completions') {
                    // 🔴 A frame whose JSON contains non-ASCII, written so a TCP boundary lands INSIDE a
                    // multi-byte character. `chunk.toString('utf8')` destroys the character in both
                    // directions and reports nothing; the failure looks like a model emitting garbage.
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.flushHeaders();
                    const whole = Buffer.from(
                        `data: ${JSON.stringify(frame('Marta studies sea otters — she calls them “résumé thieves” 🦦', 'stop'))}\n\ndata: [DONE]\n\n`,
                        'utf8');
                    // Walk one byte at a time through the region holding the accented and emoji bytes.
                    let i = 0;
                    (function pump() {
                        if (i >= whole.length) { return res.end(); }
                        const step = (i > 40 && i < whole.length - 30) ? 1 : 17;
                        res.write(whole.subarray(i, i + step));
                        i += step;
                        setImmediate(pump);
                    })();
                    return;
                }
                if (req.url === '/keepalive/v1/completions') {
                    // 🔴 Featherless's dropped stream, measured at roughly 1 run in 3: keepalive comments
                    // and then a closed connection. No data frames, no finish_reason, no usage.
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(': FEATHERLESS PROCESSING\n\n');
                    res.write(': FEATHERLESS PROCESSING\n\n');
                    res.write(': FEATHERLESS PROCESSING\n\n');
                    res.end();
                    return;
                }
                if (req.url === '/silence/v1/completions') {
                    // The same failure with nothing at all in the body.
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.end();
                    return;
                }
                if (req.url === '/garbage/v1/completions') {
                    // Not a stream and not a completions object either — a different failure, different words.
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<html><body>502 Bad Gateway</body></html>');
                    return;
                }
                if (req.url === '/noterminator/v1/completions') {
                    // 🔴 The stream simply ENDS after the last frame, with no trailing blank line. Nothing
                    // obliges a backend to write one, and the frame that gets lost is the one carrying
                    // finish_reason.
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify(frame('the cabin '))}\n\n`);
                    res.write(`data: ${JSON.stringify(frame('by the lake', 'stop'))}`);
                    res.end();
                    return;
                }
                if (req.url === '/notstreaming/v1/completions') {
                    // A backend that ignores `stream: true` and answers in one piece anyway.
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ choices: [{ text: 'answered in one piece', finish_reason: 'stop' }] }));
                    return;
                }
                // --- Chat Completion (plugin API 8): the OpenAI chat wire, streamed as `delta.content` ---
                if (req.url === '/v1/chat/completions') {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'REMEMBERED: ' }, finish_reason: null }] })}\n\n`);
                    // A reasoning model's channel rides the same frames and must be ignored here too.
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'the cabin ', reasoning_content: 'The user mentioned a cabin.' }, finish_reason: null }] })}\n\n`);
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'by the lake' }, finish_reason: 'stop' }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                if (req.url === '/nonstream/v1/chat/completions') {
                    // A chat backend that ignores `stream: true` answers with `message.content`.
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'answered in one piece' }, finish_reason: 'stop' }] }));
                    return;
                }
                res.writeHead(404);
                res.end();
            });
        });

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    beforeEach(() => {
        _clearConnections();
        lastRequest = undefined;
    });

    const base = () => `http://127.0.0.1:${port}`;

    test('replays the captured backend and returns the completion text', async () => {
        captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), model: 'kobold-rp' });

        const { text } = await generate({ handle: 'user-one', prompt: 'What do I remember?', maxTokens: 64, temperature: 0.2, stop: ['\n\n'] });

        expect(text).toBe('REMEMBERED: the cabin by the lake');
        // What actually left the process:
        expect(lastRequest.url).toBe('/v1/completions');
        expect(lastRequest.body.prompt).toBe('What do I remember?');
        // 🔴 `true`, AND THIS ASSERTION USED TO READ `false`. Featherless's DeepSeek-V4-Pro answers a
        // non-streaming completions request with HTTP 500 while streaming the identical body correctly, so the
        // hardcoded `false` made `context.generate` unusable on a reasoning model — invisibly, because the
        // smaller models and the keyless local backend development used answer either way.
        expect(lastRequest.body.stream).toBe(true);
        expect(lastRequest.body.max_tokens).toBe(64);
        expect(lastRequest.body.temperature).toBe(0.2);
        expect(lastRequest.body.stop).toEqual(['\n\n']);
        expect(lastRequest.body.model).toBe('kobold-rp');
    });

    test('threads a GBNF grammar and repPen to the backend, and omits them for a pre-v3 caller', async () => {
        captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), model: 'kobold-rp' });

        const grammar = 'root ::= "[NONE]" | line+';
        await generate({ handle: 'user-one', prompt: 'extract', grammar, repPen: 1.15 });
        expect(lastRequest.body.grammar).toBe(grammar);
        expect(lastRequest.body.rep_pen).toBe(1.15);
        expect(lastRequest.body.rep_pen_range).toBe(512);

        // A caller that names neither gets the byte-identical pre-v3 request: the fields must not appear.
        await generate({ handle: 'user-one', prompt: 'extract' });
        expect(lastRequest.body).not.toHaveProperty('grammar');
        expect(lastRequest.body).not.toHaveProperty('rep_pen');
        expect(lastRequest.body).not.toHaveProperty('rep_pen_range');
    });

    test('an empty grammar string is treated as no grammar — the sampler field is not sent', async () => {
        captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base() });

        await generate({ handle: 'user-one', prompt: 'x', grammar: '' });
        expect(lastRequest.body).not.toHaveProperty('grammar');
    });

    /**
     * 🔴 THE 401 REGRESSION. `context.generate` shipped with exactly one header — `Content-Type` — so every
     * request to a backend that requires a key came back 401, and automatic memory could never complete a single
     * pass on Featherless, TogetherAI, InfermaticAI, HuggingFace, Mancer or DreamGen. It worked in development
     * only because development used a keyless local backend.
     *
     * The witness is the header that reached the fake server, never the resolver's return value: the previous
     * code would also have "called a resolver" correctly and still sent the request bare, because the headers
     * object it built was thrown away. See DESIGN_MEMORY_PLUGIN_API.md §12.5.
     */
    describe('authentication (the fork request of 2026-08-31)', () => {
        /** A stand-in for `setAdditionalHeadersByType`, which cannot be imported here — see plugin-generate.js. */
        const fakeResolver = (headers, type, server, directories, secretId) => {
            headers['Authorization'] = `Bearer key-for-${type}-${directories.root}-${secretId ?? 'default'}`;
        };

        test('\u{1F534} the Authorization header reaches the wire — not merely the resolver being called', async () => {
            const calls = [];
            captureConnection('featherlessuser', {
                api_type: TEXTGEN_TYPES.FEATHERLESS,
                api_server: base(),
                model: 'deepseek',
                directories: { root: '/data/user-one' },
                secretId: 'secret-7',
                setHeaders: (...args) => { calls.push(args); fakeResolver(...args); },
            });

            await generate({ handle: 'featherlessuser', prompt: 'what is worth remembering?' });

            expect(lastRequest.headers.authorization).toBe('Bearer key-for-featherless-/data/user-one-secret-7');
            expect(lastRequest.headers['content-type']).toBe('application/json');

            // The resolver is handed the same four facts the route hands its own copy.
            expect(calls).toHaveLength(1);
            const [, type, server, directories, secretId] = calls[0];
            expect(type).toBe(TEXTGEN_TYPES.FEATHERLESS);
            expect(server).toBe(base());
            expect(directories).toEqual({ root: '/data/user-one' });
            expect(secretId).toBe('secret-7');
        });

        test('the key is resolved at SEND time, so a rotated secret is not replayed from the capture', async () => {
            let current = 'first-key';
            captureConnection('rotator', {
                api_type: TEXTGEN_TYPES.FEATHERLESS,
                api_server: base(),
                directories: { root: '/data/rot' },
                setHeaders: (headers) => { headers['Authorization'] = `Bearer ${current}`; },
            });

            await generate({ handle: 'rotator', prompt: 'x' });
            expect(lastRequest.headers.authorization).toBe('Bearer first-key');

            current = 'rotated-key'; // the operator changed it; nothing re-captured the connection
            await generate({ handle: 'rotator', prompt: 'x' });
            expect(lastRequest.headers.authorization).toBe('Bearer rotated-key');
        });

        test('no resolver and no directories means the request goes bare, exactly as before', async () => {
            captureConnection('localuser', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base() });

            await generate({ handle: 'localuser', prompt: 'x' });

            expect(lastRequest.headers.authorization).toBeUndefined();
            expect(lastRequest.headers['content-type']).toBe('application/json');
        });

        test('a resolver with no directories does not fire — half a connection authenticates nothing', async () => {
            let fired = false;
            captureConnection('halfuser', {
                api_type: TEXTGEN_TYPES.FEATHERLESS,
                api_server: base(),
                setHeaders: () => { fired = true; },
            });

            await generate({ handle: 'halfuser', prompt: 'x' });
            expect(fired).toBe(false);
        });
    });

    /**
     * 🔴 THE 400 BEHIND THE 401. A plugin cannot see which backend is behind `context.generate`, so it passes
     * `grammar` and `repPen` whenever the API advertises them. Featherless does not list any of `grammar`,
     * `rep_pen` or `rep_pen_range`, and rejects a body carrying them — so fixing auth alone would only have
     * moved the failure. The route has always filtered; this path now uses the same list.
     */
    describe('per-backend body filtering', () => {
        test('\u{1F534} Featherless never receives grammar, rep_pen or rep_pen_range', async () => {
            captureConnection('f', { api_type: TEXTGEN_TYPES.FEATHERLESS, api_server: base(), model: 'ds' });

            await generate({ handle: 'f', prompt: 'extract', grammar: 'root ::= line+', repPen: 1.15, maxTokens: 64 });

            expect(lastRequest.body).not.toHaveProperty('grammar');
            expect(lastRequest.body).not.toHaveProperty('rep_pen');
            expect(lastRequest.body).not.toHaveProperty('rep_pen_range');
            // and the request is still a usable completion, not a stripped husk
            expect(lastRequest.body.prompt).toBe('extract');
            expect(lastRequest.body.max_tokens).toBe(64);
            expect(lastRequest.body.model).toBe('ds');
            // nothing survives that the backend's own allowlist does not name
            expect(Object.keys(lastRequest.body).every(k => FEATHERLESS_KEYS.includes(k))).toBe(true);
        });

        test('KoboldCpp still receives them — it honours grammar, and filtering it would break constrained decoding', async () => {
            captureConnection('k', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base() });

            await generate({ handle: 'k', prompt: 'extract', grammar: 'root ::= line+', repPen: 1.15 });

            expect(lastRequest.body.grammar).toBe('root ::= line+');
            expect(lastRequest.body.rep_pen).toBe(1.15);
            expect(lastRequest.body.rep_pen_range).toBe(512);
        });

        test('filterBodyForBackend returns an unlisted backend its body unchanged, and never mutates the caller', () => {
            const body = { prompt: 'p', grammar: 'g', rep_pen: 1.1 };

            expect(filterBodyForBackend(TEXTGEN_TYPES.KOBOLDCPP, body)).toBe(body);

            const filtered = filterBodyForBackend(TEXTGEN_TYPES.FEATHERLESS, body);
            expect(filtered).not.toHaveProperty('grammar');
            expect(body.grammar).toBe('g'); // the caller's object is untouched
        });
    });

    test('throws when no backend was ever captured for the user (fail loud, not a hang)', async () => {
        await expect(generate({ handle: 'nobody', prompt: 'hi' })).rejects.toThrow(/no active backend/i);
    });

    test('refuses an unsupported backend rather than send a malformed request', async () => {
        captureConnection('ollamauser', { api_type: TEXTGEN_TYPES.OLLAMA, api_server: base() });

        await expect(generate({ handle: 'ollamauser', prompt: 'hi' })).rejects.toThrow(/not supported/i);
        expect(lastRequest).toBeUndefined(); // nothing left the process
    });

    test('throws when the backend returns non-OK (never a silent empty string)', async () => {
        captureConnection('user-two', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/fail` });

        await expect(generate({ handle: 'user-two', prompt: 'hi' })).rejects.toThrow(/500/);
    });

    test('\u{1F534} a 400 that echoes the prompt does NOT put the conversation in the thrown message', async () => {
        captureConnection('leaky', { api_type: TEXTGEN_TYPES.FEATHERLESS, api_server: `${base()}/echo400` });

        const secret = 'Seraphina: the cabin by the lake, and what we said there';
        const error = await generate({ handle: 'leaky', prompt: secret }).catch(e => e);

        // The status survives -- Mnemosyne parses it with /returned (\d{3})\b/ and a plugin can act on it.
        expect(error.message).toMatch(/returned 400\b/);
        // The conversation does not. This is the whole point of the branch.
        expect(error.message).not.toContain(secret);
        expect(error.message).not.toContain('cabin');
    });

    test('throws when an OK reply carries no completion text', async () => {
        captureConnection('user-three', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/empty` });

        await expect(generate({ handle: 'user-three', prompt: 'hi' })).rejects.toThrow(/no completion text/i);
    });

    test('throws when the frames are well-formed but carry no choices at all', async () => {
        captureConnection('user-three', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/nochoices` });

        await expect(generate({ handle: 'user-three', prompt: 'hi' })).rejects.toThrow(/no completion text/i);
    });

    /**
     * 🔴 THE STREAMING PATH (asks 1 and 3 of the 2026-08-31 change request).
     *
     * `stream: false` was hardcoded, and Featherless's `deepseek-ai/DeepSeek-V4-Pro` answers a non-streaming
     * `/v1/completions` with HTTP 500 — reproduced 7/7 non-streaming against 0/7 streaming, same key, same
     * body. The model is up and ST's own chat path talks to it fine, because that path streams. Only this one
     * did not, so automatic memory could not complete a pass on this model while every
     * smaller model and every keyless local backend hid it by answering either way.
     */
    describe('streaming the plugin path', () => {
        test('accumulates frames into one answer and reports why the model stopped', async () => {
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base() });

            const { text, finishReason } = await generate({ handle: 'user-one', prompt: 'x' });

            // Three frames on the wire, one string to the plugin: the promise is unchanged, and the plugin
            // never sees a chunk.
            expect(text).toBe('REMEMBERED: the cabin by the lake');
            expect(finishReason).toBe('stop');
        });

        test('🔴 a frame torn across two TCP writes still arrives whole', async () => {
            // The failure this guards is not a crash: a per-read parser drops the straddling frame and returns
            // a SHORTER answer, which reads as a model that said less rather than as a bug.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/split` });

            const { text } = await generate({ handle: 'user-one', prompt: 'x' });

            expect(text).toBe('the cabin by the lake');
        });

        test('CRLF frame separators parse — a proxy that normalises line endings is not a dead stream', async () => {
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/crlf` });

            const { text, finishReason } = await generate({ handle: 'user-one', prompt: 'x' });

            expect(text).toBe('by the lake');
            expect(finishReason).toBe('stop');
        });

        test('🔴 the reasoning channel NEVER reaches the plugin', async () => {
            // A reasoning model's chunks carry `text` AND `reasoning`, and the second is model-generated prose
            // about the user's conversation. A plugin that received it could `console.error` a chain of
            // thought about a private chat straight into st.log — the DESIGN_LOG_HYGIENE.md leak, through a
            // channel the log classes cannot see.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/reasoning` });

            const { text } = await generate({ handle: 'user-one', prompt: 'x' });

            expect(text).toBe('the cabin');
            expect(text).not.toContain('The user mentioned');
            expect(text).not.toContain('record the place');
        });

        test('🔴 an empty answer with finish_reason:length is REPORTED, not thrown and not called garbage', async () => {
            // Ask 3's whole case. On a reasoning model the chain of thought is billed against max_tokens and
            // then discarded, so a generous-looking ceiling returns "" — indistinguishable, from the text
            // alone, from a model with nothing to say. A caller that cannot tell stores the empty answer,
            // leaves its high-water mark where it was, and re-extracts the same window for ever.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/truncated` });

            const { text, finishReason } = await generate({ handle: 'user-one', prompt: 'x' });

            expect(text).toBe('');
            expect(finishReason).toBe('length');
        });

        test('🔴 an error announced INSIDE a 200 stream throws, and never quotes the body', async () => {
            // Featherless's shape exactly: the headers are fine, so the status check upstream cannot catch it.
            // An OpenAI-compatible error commonly echoes the request — and the request this sends is the
            // user's conversation, so the message must carry the backend name and nothing else.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/streamerror` });

            const error = await generate({ handle: 'user-one', prompt: 'x' }).catch(e => e);

            expect(error).toBeInstanceOf(Error);
            expect(error.message).toMatch(/error inside a streamed response/i);
            expect(error.message).not.toContain('SECRET CONVERSATION TEXT');
        });

        test('🔴 a stream that ends without a trailing blank line keeps its last frame', async () => {
            // Draining only on `\n\n` discards it — and it is the frame carrying finish_reason, so the loss
            // reads as a short answer that stopped for no stated reason rather than as an error.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/noterminator` });

            const { text, finishReason } = await generate({ handle: 'user-one', prompt: 'x' });

            expect(text).toBe('the cabin by the lake');
            expect(finishReason).toBe('stop');
        });

        test('🔴 a multi-byte character split across TCP writes survives intact', async () => {
            // The chunk boundary falls wherever the network puts it. Decoding each chunk independently
            // yields U+FFFD at the seam and orphaned continuation bytes after it — silently, and only for
            // non-ASCII, so it is invisible in English and certain in anything else. The symptom is a stored
            // memory full of replacement characters, which reads as a bad model rather than a bad reader.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/multibyte` });

            const { text } = await generate({ handle: 'user-one', prompt: 'x' });

            expect(text).toBe('Marta studies sea otters — she calls them “résumé thieves” 🦦');
            expect(text).not.toContain('�');
        });

        test('🔴 a stream that carries only keepalives and closes THROWS — it never returns ""', async () => {
            // Measured on Featherless at roughly 1 run in 3. Transport failing, not a model declining, and
            // the two want opposite handling: a dropped stream is worth retrying next tick, an answer of ""
            // is not and burns the caller's attempt on nothing. Returning the empty string the accumulator
            // holds would be exactly the silent-empty failure the non-streaming version was written to
            // refuse — the promise has to survive the move to streaming.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/keepalive` });

            const error = await generate({ handle: 'user-one', prompt: 'x' }).catch(e => e);

            expect(error).toBeInstanceOf(Error);
            expect(error.message).toMatch(/closed it without sending any completion data/i);
            expect(error.message).toMatch(/retry/i);
        });

        test('a stream that sends nothing at all throws the same way', async () => {
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/silence` });

            await expect(generate({ handle: 'user-one', prompt: 'x' })).rejects.toThrow(/closed it without sending any completion data/i);
        });

        test('a body that is neither a stream nor a completion says so in different words', async () => {
            // ⚠️ The two failures are named apart on purpose: a caller turning these into operator-facing
            // text needs "the backend dropped the stream" (retry) to read differently from "the backend
            // sent something that is not a completion" (the connection is pointed at the wrong thing).
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/garbage` });

            const error = await generate({ handle: 'user-one', prompt: 'x' }).catch(e => e);

            expect(error.message).toMatch(/neither a completions stream nor a completions object/i);
            expect(error.message).not.toMatch(/retry/i);
        });

        test('a backend that ignores stream:true and answers in one piece still works', async () => {
            // Nothing forces a backend to honour the flag, and the alternative to handling this is returning
            // an empty string — the one outcome this file promises never to produce quietly.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: `${base()}/notstreaming` });

            const { text, finishReason } = await generate({ handle: 'user-one', prompt: 'x' });

            expect(text).toBe('answered in one piece');
            expect(finishReason).toBe('stop');
        });
    });

    test('rejects a missing prompt and a missing handle', async () => {
        await expect(generate({ handle: 'user-one', prompt: '' })).rejects.toThrow(/prompt/i);
        await expect(generate({ prompt: 'hi' })).rejects.toThrow(/handle/i);
    });

    test('last capture wins — the active backend is the most recent one', async () => {
        captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: 'http://127.0.0.1:1', model: 'stale' });
        captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), model: 'live' });

        const { text } = await generate({ handle: 'user-one', prompt: 'x' });

        expect(text).toContain('REMEMBERED');
        expect(lastRequest.body.model).toBe('live');
    });

    test('an incomplete connection is not stored (no api_server means no capture)', async () => {
        captureConnection('user-four', { api_type: TEXTGEN_TYPES.KOBOLDCPP });

        await expect(generate({ handle: 'user-four', prompt: 'hi' })).rejects.toThrow(/no active backend/i);
    });

    /**
     * Plugin API 8 — `generate()` against a Chat Completion connection (Mnemosyne's change request of
     * 2026-09-22). The witness is the same fake backend: what reached `/v1/chat/completions`, and what came back.
     */
    describe('a Chat Completion connection (plugin API 8)', () => {
        /** The reader the route injects; here it hands out one key per slot so the header can be asserted. */
        const readSecret = (directories, key, id) => ({ api_key_custom: `custom-key-${id ?? 'active'}`, api_key_openai: 'openai-key' })[key] ?? '';
        const directories = { root: '/nowhere' };

        const chat = (overrides = {}) => ({
            family: 'chat', api_type: 'custom', api_server: `${base()}/v1`, model: 'zai-org/GLM-5.2',
            directories, secretId: null, secretKey: 'api_key_custom', keyRequired: false, readSecret,
            ...overrides,
        });

        test('🔴 posts ONE user turn to the source\'s /chat/completions and returns the streamed answer', async () => {
            captureConnection('kim', chat());

            const { text, finishReason } = await generate({ handle: 'kim', prompt: 'Extract what matters.', maxTokens: 700, temperature: 0.2, stop: ['\n\n'] });

            expect(text).toBe('REMEMBERED: the cabin by the lake');
            expect(finishReason).toBe('stop');
            expect(lastRequest.url).toBe('/v1/chat/completions');
            expect(lastRequest.body).toEqual({
                model: 'zai-org/GLM-5.2',
                messages: [{ role: 'user', content: 'Extract what matters.' }],
                stream: true,
                max_tokens: 700,
                temperature: 0.2,
                stop: ['\n\n'],
            });
            // Never `prompt`: that is the completions shape, and a chat endpoint 400s it.
            expect(lastRequest.body.prompt).toBeUndefined();
        });

        test('🔴 the key is read from the captured SLOT at send time, and the user\'s extra headers and body ride along', async () => {
            captureConnection('lee', chat({ secretId: 'k2', extraHeaders: { 'X-Custom': 'yes' }, extraBody: { top_k: 40 } }));

            await generate({ handle: 'lee', prompt: 'x' });

            expect(lastRequest.headers.authorization).toBe('Bearer custom-key-k2');
            expect(lastRequest.headers['x-custom']).toBe('yes');
            expect(lastRequest.body.top_k).toBe(40);
        });

        test('`wrap: true` is satisfied without an envelope — the chat template is the framing', async () => {
            captureConnection('mo', chat());

            const { text } = await generate({ handle: 'mo', prompt: 'Extract.', wrap: true });

            expect(text).toBe('REMEMBERED: the cabin by the lake');
            expect(lastRequest.body.messages[0].content).toBe('Extract.');
        });

        test('grammar and repPen are dropped, as the OpenAI-schema text backends drop them', async () => {
            captureConnection('nia', chat());

            await generate({ handle: 'nia', prompt: 'x', grammar: 'root ::= "a"', repPen: 1.1 });

            expect(lastRequest.body.grammar).toBeUndefined();
            expect(lastRequest.body.rep_pen).toBeUndefined();
        });

        test('a chat backend that ignores stream:true and answers with message.content still works', async () => {
            captureConnection('ola', chat({ api_server: `${base()}/nonstream/v1` }));

            const { text } = await generate({ handle: 'ola', prompt: 'x' });

            expect(text).toBe('answered in one piece');
        });

        test('🔴 a vendor-converted source is refused BY NAME with the sentence Mnemosyne\'s diagnose.js matches', async () => {
            captureConnection('pat', chat({ api_type: 'claude', api_server: 'unsupported:' }));

            await expect(generate({ handle: 'pat', prompt: 'x' })).rejects.toThrow(/'claude' is not supported yet/);
        });

        test('a source that requires a key and has none throws before anything leaves the process', async () => {
            captureConnection('quinn', chat({ api_type: 'openrouter', secretKey: 'api_key_openrouter', keyRequired: true }));

            await expect(generate({ handle: 'quinn', prompt: 'x' })).rejects.toThrow(/no API key configured/);
            expect(lastRequest).toBeUndefined();
        });

        test('a Custom source without a key sends bare, as the route does for a local server', async () => {
            captureConnection('ren', chat({ secretKey: 'api_key_custom', readSecret: () => '' }));

            await generate({ handle: 'ren', prompt: 'x' });

            expect(lastRequest.headers.authorization).toBeUndefined();
        });

        test('last capture wins across families — a chat generation after a text one replays chat', async () => {
            captureConnection('sam', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), model: 'kobold-rp' });
            captureConnection('sam', chat());

            await generate({ handle: 'sam', prompt: 'x' });

            expect(lastRequest.url).toBe('/v1/chat/completions');
        });

        test('the "no active backend" sentence no longer claims a text-completion API is required', async () => {
            await expect(generate({ handle: 'nobody', prompt: 'x' })).rejects.toThrow(/no active backend captured for 'nobody'\. generate runs only after that user has generated at least once, or opened a plugin panel\.$/);
        });

        describe('a panel request in chat mode', () => {
            const panelRequest = (handle, connection) => ({
                user: { profile: { handle }, directories },
                get: (name) => (name === 'X-ST-Connection' ? encodeURIComponent(JSON.stringify(connection)) : undefined),
            });

            test('🔴 a Rescan clicked in Chat Completion after a restart has a connection to run against', async () => {
                let passed = false;
                panelConnectionCapture(() => { }, readSecret)(
                    panelRequest('tess', { family: 'chat', chat_completion_source: 'custom', custom_url: `${base()}/v1/`, reverse_proxy: '', model: 'zai-org/GLM-5.2' }),
                    /** @type {any} */ ({}), () => { passed = true; });

                expect(passed).toBe(true);
                const { text } = await generate({ handle: 'tess', prompt: 'Rescan.', wrap: true });

                expect(text).toBe('REMEMBERED: the cabin by the lake');
                expect(lastRequest.url).toBe('/v1/chat/completions');
                expect(lastRequest.body.model).toBe('zai-org/GLM-5.2');
                expect(lastRequest.headers.authorization).toBe('Bearer custom-key-active');
            });

            test('the fixed sources resolve their base URL server-side; the header never carries one', () => {
                expect(readConnectionHeader(panelRequest('u', { family: 'chat', chat_completion_source: 'openai', model: 'gpt-4o' })))
                    .toEqual({ family: 'chat', api_type: 'openai', api_server: '', custom_url: '', reverse_proxy: '', model: 'gpt-4o' });
            });

            test('a chat header naming no source, or a non-http custom URL, is refused', () => {
                expect(readConnectionHeader(panelRequest('v', { family: 'chat', model: 'x' }))).toBeUndefined();
                expect(readConnectionHeader(panelRequest('v', { family: 'chat', chat_completion_source: 'custom', custom_url: 'file:///etc' }))).toBeUndefined();
            });

            test('a vendor source from a panel is captured so the refusal names it, not "no active backend"', async () => {
                panelConnectionCapture(() => { }, readSecret)(panelRequest('wes', { family: 'chat', chat_completion_source: 'makersuite', model: 'gemini' }), /** @type {any} */ ({}), () => { });

                await expect(generate({ handle: 'wes', prompt: 'x' })).rejects.toThrow(/'makersuite' is not supported yet/);
            });
        });
    });

    /**
     * Plugin API v7 §3 — `generate()` from a panel action with no generation behind it.
     *
     * 🔴 THE SCENARIO: the server has just restarted, so nothing is captured, and the user's first act is a
     * click on a panel's Rescan button. Before v7 that click's `generate()` threw "no active backend" until the
     * user sent a chat message — the one thing a rescan exists not to need. The panel request now carries the
     * connection and envelope, and the middleware in front of every plugin router captures them.
     */
    describe('a panel request carries the connection (API v7)', () => {
        /**
         * A plugin-router request as the panel host sends it.
         * @param {string} handle The logged-in user
         * @param {Record<string, string>} headers Header values, already encoded
         * @returns {any}
         */
        const panelRequest = (handle, headers) => ({
            user: { profile: { handle }, directories: { root: '/nowhere' } },
            get: (name) => headers[name],
        });

        /**
         * Run the middleware to completion.
         * @param {any} request
         * @param {(...args: any[]) => void} [setHeaders]
         * @returns {boolean} Whether it called next()
         */
        const runCapture = (request, setHeaders = () => { }) => {
            let passed = false;
            panelConnectionCapture(setHeaders)(request, /** @type {any} */ ({}), () => { passed = true; });
            return passed;
        };

        const connectionHeader = (connection) => encodeURIComponent(JSON.stringify(connection));

        test('🔴 the first click after a restart can generate, wrapped, with nothing captured before it', async () => {
            await expect(generate({ handle: 'erin', prompt: 'x' })).rejects.toThrow(/no active backend/i);

            const envelope = { prefix: '<|im_start|>user\n', suffix: '<|im_end|>\n<|im_start|>assistant\n', stop: ['<|im_end|>'] };
            const passed = runCapture(panelRequest('erin', {
                'X-ST-Connection': connectionHeader({ api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), model: 'kobold-rp' }),
                'X-ST-Instruct-Envelope': encodeURIComponent(JSON.stringify(envelope)),
            }));

            expect(passed).toBe(true);

            const { text } = await generate({ handle: 'erin', prompt: 'Extract.', wrap: true });

            expect(text).toBe('REMEMBERED: the cabin by the lake');
            expect(lastRequest.body.prompt).toBe(`${envelope.prefix}Extract.${envelope.suffix}`);
            expect(lastRequest.body.model).toBe('kobold-rp');
        });

        test('the send authenticates through the injected resolver, as a generation-captured one does', async () => {
            const calls = [];
            runCapture(panelRequest('fay', {
                'X-ST-Connection': connectionHeader({ api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base() }),
            }), (headers, type, server, directories, secretId) => {
                calls.push({ type, server, root: directories.root, secretId });
                headers.Authorization = 'Bearer from-resolver';
            });

            await generate({ handle: 'fay', prompt: 'x' });

            expect(calls).toEqual([{ type: TEXTGEN_TYPES.KOBOLDCPP, server: base(), root: '/nowhere', secretId: null }]);
            expect(lastRequest.headers.authorization).toBe('Bearer from-resolver');
        });

        test('`localhost` is rewritten exactly as the /generate route rewrites it', () => {
            expect(readConnectionHeader(panelRequest('g', {
                'X-ST-Connection': connectionHeader({ api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: 'http://localhost:5001' }),
            }))).toEqual({ family: 'text', api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: 'http://127.0.0.1:5001', model: undefined });
        });

        test('a request without the header changes nothing — the status poll, or another API selected', async () => {
            captureConnection('hal', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), model: 'kept' });

            expect(runCapture(panelRequest('hal', {}))).toBe(true);
            await generate({ handle: 'hal', prompt: 'x' });

            expect(lastRequest.body.model).toBe('kept');
        });

        test('a malformed or non-http header is refused and captures nothing', async () => {
            for (const bad of ['not json', connectionHeader({ api_type: 'koboldcpp' }), connectionHeader({ api_type: 'koboldcpp', api_server: 'file:///etc/passwd' }), connectionHeader({ api_type: 'koboldcpp', api_server: 'http://x', model: 5 })]) {
                expect(runCapture(panelRequest('ivy', { 'X-ST-Connection': bad }))).toBe(true);
            }

            await expect(generate({ handle: 'ivy', prompt: 'x' })).rejects.toThrow(/no active backend/i);
        });

        test('🔴 a locked user is not captured — the lock cleared the names in the envelope on purpose', async () => {
            // Only `isReady` matters here; the rest satisfy registration's member check and are never called.
            const unused = () => { throw new Error('not used by this test'); };
            registerStorageProvider(/** @type {any} */ ({
                id: 'locked-for-test', owns: () => false, isReady: () => false,
                init: unused, readFile: unused, readFileSync: unused, createReadStream: unused, exists: unused, stat: unused,
                readdir: unused, writeFile: unused, writeFileSync: unused, createWriteStream: unused, mkdir: unused,
                unlink: unused, rename: unused, copyFile: unused, cp: unused, rm: unused, sendFile: unused,
                unlock: unused, lock: unused, rekey: unused,
            }));

            try {
                runCapture(panelRequest('jo', {
                    'X-ST-Connection': connectionHeader({ api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base() }),
                    'X-ST-Instruct-Envelope': encodeURIComponent(JSON.stringify({ prefix: 'Test User: ', suffix: '\nMarcus:', stop: [] })),
                }));
            } finally {
                unregisterStorageProvider();
            }

            await expect(generate({ handle: 'jo', prompt: 'x' })).rejects.toThrow(/no active backend/i);
        });

        test('no logged-in user, no capture', async () => {
            const request = { user: undefined, get: () => connectionHeader({ api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base() }) };

            expect(runCapture(request)).toBe(true);
            await expect(generate({ handle: 'undefined', prompt: 'x' })).rejects.toThrow(/no active backend/i);
        });
    });

    test('resolveTextCompletionsUrl maps the completions family and leaves an unknown backend untouched', () => {
        expect(resolveTextCompletionsUrl(TEXTGEN_TYPES.KOBOLDCPP, 'http://x:5001')).toBe('http://x:5001/v1/completions');
        expect(resolveTextCompletionsUrl(TEXTGEN_TYPES.OLLAMA, 'http://x:11434')).toBe('http://x:11434/api/generate');
        expect(resolveTextCompletionsUrl('something-unknown', 'http://x:9')).toBe('http://x:9');
    });

    /**
     * §19 — `generate({wrap})`, the instruct envelope.
     *
     * 🔴 THE POINT OF THESE IS THAT THE SERVER CANNOT TELL THE TWO TEMPLATES APART. ChatML and
     * Alpaca-Single-Turn put their framing in COMPLETELY DIFFERENT preset fields — Alpaca's `input_sequence`,
     * `output_sequence` and `input_suffix` are all `""` — so the obvious server-side implementation, reading
     * template fields and concatenating them, sends Alpaca's prompt entirely unwrapped while reporting
     * success. A server that reads fields instead of the envelope cannot pass both of the first two tests.
     */
    describe('the instruct envelope (§19)', () => {
        /** ChatML's framing, as the client's `getSingleTurnInstructEnvelope` derives it. */
        const CHATML = {
            prefix: '<|im_start|>system\n',
            suffix: '<|im_end|>\n<|im_start|>assistant\n',
            stop: ['<|im_end|>'],
        };

        /** Alpaca-Single-Turn's, which shares not one field with the above. */
        const ALPACA = {
            prefix: 'Below is an instruction that describes a task. Write a response that appropriately completes the request.\n\n### Instruction:\n',
            suffix: '\n\n### Response:\n',
            stop: [],
        };

        test('a ChatML-shaped envelope produces exactly these bytes', async () => {
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), envelope: CHATML });

            await generate({ handle: 'user-one', prompt: 'Summarise.', wrap: true });

            expect(lastRequest.body.prompt).toBe('<|im_start|>system\nSummarise.<|im_end|>\n<|im_start|>assistant\n');
            expect(lastRequest.body.stop).toEqual(['<|im_end|>']);
        });

        test('an Alpaca-shaped envelope produces entirely different ones, from the same server code', async () => {
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), envelope: ALPACA });

            await generate({ handle: 'user-one', prompt: 'Summarise.', wrap: true });

            expect(lastRequest.body.prompt).toBe(`${ALPACA.prefix}Summarise.${ALPACA.suffix}`);
            // No stops of its own and none passed: the field is omitted rather than sent empty.
            expect(lastRequest.body).not.toHaveProperty('stop');
        });

        test('🔴 wrap:false and wrap omitted send the prompt byte-identical to before — the compatibility witness', async () => {
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), envelope: CHATML });

            await generate({ handle: 'user-one', prompt: 'Summarise.', wrap: false });
            expect(lastRequest.body.prompt).toBe('Summarise.');

            await generate({ handle: 'user-one', prompt: 'Summarise.' });
            expect(lastRequest.body.prompt).toBe('Summarise.');
            expect(lastRequest.body).not.toHaveProperty('stop');
        });

        test('the envelope terminator survives 3 stops of the plugin\'s own, and the plugin loses the 4th', async () => {
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), envelope: CHATML });

            await generate({ handle: 'user-one', prompt: 'x', wrap: true, stop: ['a', 'b', 'c'] });
            expect(lastRequest.body.stop).toEqual(['<|im_end|>', 'a', 'b', 'c']);

            // 🔴 THE TERMINATOR IS NEVER THE ONE DROPPED. A wrapped prompt that cannot stop runs on past its
            // answer; a plugin missing its 4th stop of its own is a smaller failure and a documented one.
            await generate({ handle: 'user-one', prompt: 'x', wrap: true, stop: ['a', 'b', 'c', 'd'] });
            expect(lastRequest.body.stop).toEqual(['<|im_end|>', 'a', 'b', 'c']);
        });

        test('🔴 wrap:true with no captured envelope THROWS, and sends nothing at all', async () => {
            // An older client: it captured a connection but carried no envelope header.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base() });

            await expect(generate({ handle: 'user-one', prompt: 'x', wrap: true })).rejects.toThrow(/envelope/i);

            // Being wrapped and NOT being wrapped is the failure this refuses to commit quietly (§6.5): an
            // unframed instruction is CONTINUED as prose by an RP-tuned model, which reads as a bad answer
            // rather than as a missing capability.
            expect(lastRequest).toBeUndefined();
        });

        test('🔴 wrap:true with an ALL-EMPTY envelope throws too — instruct mode off is not framing', async () => {
            // The default state of a fresh profile: instruct mode disabled, so the client's
            // `getSingleTurnInstructEnvelope` returns `{prefix:"", suffix:"", stop:[]}`. That IS a well-formed
            // envelope, so it is stored — and the old `!connection.envelope` guard never fired against it,
            // because an object is truthy. `"" + prompt + ""` sent the prompt bare, through the one shape the
            // test above did not cover, in the configuration most installs are actually in.
            captureConnection('user-one', {
                api_type: TEXTGEN_TYPES.KOBOLDCPP,
                api_server: base(),
                envelope: { prefix: '', suffix: '', stop: [] },
            });

            await expect(generate({ handle: 'user-one', prompt: 'x', wrap: true })).rejects.toThrow(/envelope/i);
            expect(lastRequest).toBeUndefined();
        });

        test('a prefix alone or a suffix alone is framing, and is sent', async () => {
            // ⚠️ EITHER, NOT BOTH. A template that opens with an instruction header and relies on a stop
            // sequence to close is framed; refusing it would break a legitimate template to catch the empty one.
            captureConnection('user-one', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), envelope: { prefix: '### Instruction:\n', suffix: '', stop: [] } });
            await generate({ handle: 'user-one', prompt: 'x', wrap: true });
            expect(lastRequest.body.prompt).toBe('### Instruction:\nx');

            captureConnection('user-two', { api_type: TEXTGEN_TYPES.KOBOLDCPP, api_server: base(), envelope: { prefix: '', suffix: '\n### Response:\n', stop: [] } });
            await generate({ handle: 'user-two', prompt: 'x', wrap: true });
            expect(lastRequest.body.prompt).toBe('x\n### Response:\n');
        });

        test('wrap:false with an all-empty envelope still succeeds — the guard is about WRAPPING, not the envelope', async () => {
            // Nothing asked to be framed, so nothing is refused. A plugin that never sets `wrap` is unaffected
            // by this change no matter what the client captured.
            captureConnection('user-one', {
                api_type: TEXTGEN_TYPES.KOBOLDCPP,
                api_server: base(),
                envelope: { prefix: '', suffix: '', stop: [] },
            });

            await generate({ handle: 'user-one', prompt: 'Summarise.' });
            expect(lastRequest.body.prompt).toBe('Summarise.');
        });
    });
});

/**
 * `readInstructEnvelope` — the wire half of §19.
 *
 * ⚠️ A HEADER, FOR §16.2's REASON. The envelope is three short strings, so it fits the channel the backend
 * fetch never copies. §17's window had to take the body only because a whole conversation does not fit here.
 */
describe('readInstructEnvelope — reading the envelope off the wire', () => {
    /**
     * @param {Record<string, string>} headers
     * @returns {any} Something shaped enough like an Express request
     */
    const fakeRequest = (headers) => ({ get: (name) => headers[name] });

    /**
     * @param {object} envelope
     * @returns {any} A request carrying it exactly as the client sends it
     */
    const carrying = (envelope) => fakeRequest({ 'X-ST-Instruct-Envelope': encodeURIComponent(JSON.stringify(envelope)) });

    test('round-trips an envelope whose sequences contain newlines and non-ASCII', () => {
        const envelope = { prefix: '<|im_start|>system\n', suffix: '\n### Réponse:\n', stop: ['<|im_end|>'] };

        expect(readInstructEnvelope(carrying(envelope))).toEqual(envelope);
    });

    test('absent, empty, unparseable and wrong-shaped all yield undefined rather than a half-envelope', () => {
        expect(readInstructEnvelope(fakeRequest({}))).toBeUndefined();
        expect(readInstructEnvelope(fakeRequest({ 'X-ST-Instruct-Envelope': '' }))).toBeUndefined();
        expect(readInstructEnvelope(fakeRequest({ 'X-ST-Instruct-Envelope': 'not json' }))).toBeUndefined();
        // A prefix and a suffix but no stops: an envelope missing a field is not an envelope.
        expect(readInstructEnvelope(carrying({ prefix: 'a', suffix: 'b' }))).toBeUndefined();
    });

    test('an all-empty envelope is a REAL envelope — instruct mode is simply off', () => {
        // "This template has no framing" and "this client sent nothing" are different facts, and this layer
        // keeps them distinguishable on purpose.
        //
        // ⚠️ THE OLD COMMENT HERE SAID THIS MADE `wrap: true` "a no-op that succeeds", AND THAT WAS THE BUG.
        // Succeeding meant sending the instruction unframed, which `generate` explicitly refuses to do. Both
        // now throw there; what stays different is the FACT recorded, not the outcome of wrapping.
        expect(readInstructEnvelope(carrying({ prefix: '', suffix: '', stop: [] }))).toEqual({ prefix: '', suffix: '', stop: [] });
    });

    test('empty stop strings are dropped — they would match everything', () => {
        expect(readInstructEnvelope(carrying({ prefix: '', suffix: '', stop: ['', 'x', 42] })).stop).toEqual(['x']);
    });
});

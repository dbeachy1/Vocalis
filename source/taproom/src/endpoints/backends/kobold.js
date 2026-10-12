import * as storage from '../../storage.js';
import express from 'express';
import fetch from 'node-fetch';

import { forwardFetchResponse, delay } from '../../util.js';
import { getOverrideHeaders, setAdditionalHeaders, setAdditionalHeadersByType } from '../../additional-headers.js';
import { TEXTGEN_TYPES } from '../../constants.js';
import { hasPromptInterceptors, readIdentityHeaders, runPromptInterceptors, takeRecentMessages, REWRITTEN_BY, REWRITE_SITES } from '../../generation-interceptors.js';
import { recordOutgoingPrompt } from '../../prompt-record.js';
import { log, LogClass } from '../../logger.js';

export const router = express.Router();

router.post('/generate', async function (request, response_generate) {
    if (!request.body) return response_generate.sendStatus(400);

    if (request.body.api_server.indexOf('localhost') != -1) {
        request.body.api_server = request.body.api_server.replace('localhost', '127.0.0.1');
    }

    // 🔴 THE STRIP, UNCONDITIONALLY AND ABOVE THE GATE — the same rule as the other three backends. The
    // client attaches `st_recent_messages` to every non-openai/non-horde generation, which has always
    // included this route, and this route never removed it. Nothing reached the model host, because the
    // payload below is built by naming fields — but "the strip is where the field's LIFETIME is defined",
    // and a rule with an exception on one route of four is a rule nobody can apply from memory.
    const recentMessages = takeRecentMessages(request);

    // ⚠️ HOISTED OUT OF THE `if` BELOW BECAUSE THE RECORD NEEDS IT TOO, AND IT IS SAFE TO HOIST: these are
    // pure header reads with no side effects and no writes to the request.
    const identity = readIdentityHeaders(request);

    /** @type {string[]} Plugins whose interceptors actually changed the prompt; see `prompt-record.js`. */
    let rewrittenBy = [];

    /** @type {Array<{id: string, atChar: number, delta: number}>} Where each of those changes begins. */
    let rewriteSites = [];

    // §17: and the interceptor itself, which was simply never wired here. `OutgoingPrompt` advertises
    // `backend: 'kobold'` to every plugin author who reads it, and there was no call site to make that
    // true: a memory plugin on KoboldAI Classic registered, lit its button, logged that it was running,
    // and silently never fired. Silent, wrong, and indistinguishable from working.
    //
    // ⚠️ WRAPPED, BECAUSE THIS ROUTE HAS NO TOP-LEVEL try/catch — its only one is inside the retry loop,
    // far below here. A wedged interceptor now throws by design, and an escaped throw on this route is a
    // rejection nobody answers: the client waits on a request that will never get a reply.
    if (hasPromptInterceptors() && typeof request.body.prompt === 'string') {
        try {
            const intercepted = await runPromptInterceptors({
                handle: request.user?.profile?.handle,
                backend: 'kobold',
                apiType: 'kobold',
                prompt: request.body.prompt,
                budget: request.body.max_context_length,
                charName: identity.charName,
                chatId: identity.chatId,
                genType: identity.genType,
                charAvatar: identity.charAvatar,
                personaId: identity.personaId,
                userRoot: request.user?.directories?.root,
                recentMessages: recentMessages,
            });

            request.body.prompt = intercepted.prompt;
            rewrittenBy = intercepted[REWRITTEN_BY] ?? [];
            rewriteSites = intercepted[REWRITE_SITES] ?? [];
        } catch (error) {
            log.error(LogClass.NORMAL, 'A prompt interceptor failed, so this generation is refused rather than sent without it.');
            log.error(LogClass.SENSITIVE, 'Prompt interceptor error:', error);
            return response_generate.sendStatus(500);
        }
    }

    // 🔴 AFTER THE INTERCEPTORS AND BEFORE THE WIRE — see `prompt-record.js`. Unconditional: "no plugin ran"
    // is an answer a consumer needs just as much as "this plugin rewrote it".
    const promptRecord = recordOutgoingPrompt({
        handle: request.user?.profile?.handle,
        backend: 'kobold',
        apiType: 'kobold',
        chatId: identity.chatId,
        genType: identity.genType,
        shape: identity.promptShape,
        prompt: request.body.prompt,
        rewrittenBy: rewrittenBy,
        rewriteSites: rewriteSites,
    });

    // ⚠️ THE CORRELATION HANDLE, AND IT IS A HEADER BECAUSE THE STREAMING PATH HAS NO JSON ENVELOPE.
    // A client that just made a generation needs to know WHICH record is its own; matching by time or by
    // chat id is guesswork the moment two generations overlap. Headers precede the body on both the
    // streaming and non-streaming paths, so this is the one channel that works for both.
    if (promptRecord && !response_generate.headersSent) {
        response_generate.setHeader('X-ST-Prompt-Seq', String(promptRecord.seq));
    }

    const request_prompt = request.body.prompt;
    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', async function () {
        if (request.body.can_abort && !response_generate.writableEnded) {
            try {
                log.info(LogClass.NORMAL, 'Aborting Kobold generation...');
                // send abort signal to koboldcpp
                const abortResponse = await fetch(`${request.body.api_server}/extra/abort`, {
                    method: 'POST',
                });

                if (!abortResponse.ok) {
                    log.error(LogClass.NORMAL, 'Error sending abort request to Kobold:', abortResponse.status);
                }
            } catch (error) {
                log.error(LogClass.NORMAL, 'Failed to send the abort request to Kobold');
                log.error(LogClass.SENSITIVE, error);
            }
        }
        controller.abort();
    });

    let this_settings = {
        prompt: request_prompt,
        use_story: false,
        use_memory: false,
        use_authors_note: false,
        use_world_info: false,
        max_context_length: request.body.max_context_length,
        max_length: request.body.max_length,
    };

    if (!request.body.gui_settings) {
        this_settings = {
            prompt: request_prompt,
            use_story: false,
            use_memory: false,
            use_authors_note: false,
            use_world_info: false,
            max_context_length: request.body.max_context_length,
            max_length: request.body.max_length,
            rep_pen: request.body.rep_pen,
            rep_pen_range: request.body.rep_pen_range,
            rep_pen_slope: request.body.rep_pen_slope,
            temperature: request.body.temperature,
            tfs: request.body.tfs,
            top_a: request.body.top_a,
            top_k: request.body.top_k,
            top_p: request.body.top_p,
            min_p: request.body.min_p,
            typical: request.body.typical,
            sampler_order: request.body.sampler_order,
            singleline: !!request.body.singleline,
            use_default_badwordsids: request.body.use_default_badwordsids,
            mirostat: request.body.mirostat,
            mirostat_eta: request.body.mirostat_eta,
            mirostat_tau: request.body.mirostat_tau,
            grammar: request.body.grammar,
            sampler_seed: request.body.sampler_seed,
        };
        if (request.body.stop_sequence) {
            this_settings.stop_sequence = request.body.stop_sequence;
        }
    }

    log.debug(LogClass.SENSITIVE, this_settings);
    const args = {
        body: JSON.stringify(this_settings),
        headers: Object.assign(
            { 'Content-Type': 'application/json' },
            getOverrideHeaders((new URL(request.body.api_server))?.host),
        ),
        signal: controller.signal,
    };

    const MAX_RETRIES = 50;
    const delayAmount = 2500;
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const url = request.body.streaming ? `${request.body.api_server}/extra/generate/stream` : `${request.body.api_server}/v1/generate`;
            const response = await fetch(url, { method: 'POST', ...args });

            if (request.body.streaming) {
                // Pipe remote SSE stream to Express response
                await forwardFetchResponse(response, response_generate);
                return;
            } else {
                if (!response.ok) {
                    const errorText = await response.text();
                    log.warn(LogClass.NORMAL, `Kobold returned error: ${response.status} ${response.statusText}`);
                    log.warn(LogClass.SENSITIVE, 'Kobold error body:', errorText);

                    try {
                        const errorJson = JSON.parse(errorText);
                        const message = errorJson?.detail?.msg || errorText;
                        return response_generate.status(400).send({ error: { message } });
                    } catch {
                        return response_generate.status(400).send({ error: { message: errorText } });
                    }
                }

                const data = await response.json();
                log.debug(LogClass.SENSITIVE, 'Endpoint response:', data);
                return response_generate.send(data);
            }
        } catch (error) {
            // response
            switch (error?.status) {
                case 403:
                case 503: // retry in case of temporary service issue, possibly caused by a queue failure?
                    log.warn(LogClass.NORMAL, `KoboldAI is busy. Retry attempt ${i + 1} of ${MAX_RETRIES}...`);
                    await delay(delayAmount);
                    break;
                default:
                    log.error(LogClass.NORMAL, 'Kobold generation request failed');
                    if ('status' in error) {
                        // The NORMAL line this rule looks for is hoisted OUT of this guard on
                        // purpose. Inside it, a thrown value carrying no .status would log nothing
                        // at all, which is the exact failure the rule exists to prevent. The pair
                        // is non-adjacent; it is not missing.
                        // eslint-disable-next-line no-restricted-syntax
                        log.error(LogClass.SENSITIVE, 'Status Code from Kobold:', error.status);
                    }
                    return response_generate.send({ error: true });
            }
        }
    }

    log.error(LogClass.NORMAL, 'Max retries exceeded. Giving up.');
    return response_generate.send({ error: true });
});

router.post('/status', async function (request, response) {
    if (!request.body) return response.sendStatus(400);
    let api_server = request.body.api_server;
    if (api_server.indexOf('localhost') != -1) {
        api_server = api_server.replace('localhost', '127.0.0.1');
    }

    const args = {
        headers: { 'Content-Type': 'application/json' },
    };

    setAdditionalHeaders(request, args, api_server);

    const result = {};

    /** @type {any} */
    const [koboldUnitedResponse, koboldExtraResponse, koboldModelResponse] = await Promise.all([
        // We catch errors both from the response not having a successful HTTP status and from JSON parsing failing

        // Kobold United API version
        fetch(`${api_server}/v1/info/version`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => ({ result: '0.0.0' })),

        // KoboldCpp version
        fetch(`${api_server}/extra/version`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => ({ version: '0.0' })),

        // Current model
        fetch(`${api_server}/v1/model`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => null),
    ]);

    result.koboldUnitedVersion = koboldUnitedResponse.result;
    result.koboldCppVersion = koboldExtraResponse.result;
    result.model = !koboldModelResponse || koboldModelResponse.result === 'ReadOnly' ?
        'no_connection' :
        koboldModelResponse.result;

    response.send(result);
});

router.post('/transcribe-audio', async function (request, response) {
    try {
        const server = request.body.server;

        if (!server) {
            log.error(LogClass.NORMAL, 'Server is not set');
            return response.sendStatus(400);
        }

        if (!request.file) {
            log.error(LogClass.NORMAL, 'No audio file found');
            return response.sendStatus(400);
        }

        log.debug(LogClass.SENSITIVE, 'Transcribing audio with KoboldCpp', server);

        const fileBase64 = storage.readFileSync(request.file.path).toString('base64');
        storage.unlink(request.file.path);

        const headers = {};
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.KOBOLDCPP, server, request.user.directories);

        const url = new URL(server);
        url.pathname = '/api/extra/transcribe';

        const result = await fetch(url, {
            method: 'POST',
            headers: {
                ...headers,
            },
            body: JSON.stringify({
                prompt: '',
                audio_data: fileBase64,
            }),
        });

        if (!result.ok) {
            const text = await result.text();
            log.error(LogClass.NORMAL, 'KoboldCpp request failed', result.statusText);
            log.error(LogClass.SENSITIVE, 'KoboldCpp error body:', text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        log.debug(LogClass.SENSITIVE, 'KoboldCpp transcription response', data);
        return response.json(data);
    } catch (error) {
        log.error(LogClass.NORMAL, 'KoboldCpp transcription failed');
        log.error(LogClass.SENSITIVE, 'KoboldCpp transcription failed', error);
        response.status(500).send('Internal server error');
    }
});

router.post('/embed', async function (request, response) {
    try {
        const { server, items } = request.body;

        if (!server) {
            log.warn(LogClass.NORMAL, 'KoboldCpp URL is not set');
            return response.sendStatus(400);
        }

        const headers = {};
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.KOBOLDCPP, server, request.user.directories);

        const embeddingsUrl = new URL(server);
        embeddingsUrl.pathname = '/api/extra/embeddings';

        const embeddingsResult = await fetch(embeddingsUrl, {
            method: 'POST',
            headers: {
                ...headers,
            },
            body: JSON.stringify({
                input: items,
            }),
        });

        /** @type {any} */
        const data = await embeddingsResult.json();

        if (!Array.isArray(data?.data)) {
            log.warn(LogClass.NORMAL, 'KoboldCpp API response was not an array');
            return response.sendStatus(500);
        }

        const model = data.model || 'unknown';
        const embeddings = data.data.map(x => Array.isArray(x) ? x[0] : x).sort((a, b) => a.index - b.index).map(x => x.embedding);
        return response.json({ model, embeddings });
    } catch (error) {
        log.error(LogClass.NORMAL, 'KoboldCpp embedding request failed');
        log.error(LogClass.SENSITIVE, 'KoboldCpp embedding failed', error);
        response.status(500).send('Internal server error');
    }
});

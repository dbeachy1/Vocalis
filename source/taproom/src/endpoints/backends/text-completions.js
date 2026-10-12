import { Readable } from 'node:stream';
import fetch from 'node-fetch';
import express from 'express';
import _ from 'lodash';

import { hasPromptInterceptors, runPromptInterceptors, readIdentityHeaders, takeRecentMessages, REWRITTEN_BY, REWRITE_SITES } from '../../generation-interceptors.js';
import { recordOutgoingPrompt, finalizePromptRecord } from '../../prompt-record.js';
// Use the shared normalizer so chat and text-completion paths apply the same missing-versus-zero rules.
import { normalizeDeepSeekChatUsage, createDeepSeekUsageObserver } from '../../deepseek-usage.js';
import { captureConnection, readInstructEnvelope, resolveTextCompletionsUrl, filterBodyForBackend } from '../../plugin-generate.js';
import { readCachedModelList, writeCachedModelList } from '../../model-list-cache.js';

import {
    TEXTGEN_TYPES,
    OLLAMA_KEYS,
} from '../../constants.js';
import { forwardFetchResponse, trimV1, getConfigValue } from '../../util.js';
import { setAdditionalHeaders, setAdditionalHeadersByType } from '../../additional-headers.js';
import { createHash } from 'node:crypto';
import { log, LogClass, redact } from '../../logger.js';

export const router = express.Router();

/**
 * Content-free diagnostics for a provider that splits a completion into two channels.
 *
 * Featherless serving DeepSeek V4 returns `choices[0].reasoning` and `choices[0].text` as separate
 * channels, and classifies EVERYTHING as reasoning until the model emits `</think>`. On a turn where
 * the model answers without thinking that closer never arrives, so `text` is empty for the whole
 * stream and the client renders a full thinking drawer above an EMPTY message body. The reply is not
 * lost -- it is only reachable by expanding the drawer -- and `finish_reason` is a normal `stop`, so
 * nothing about the response looks like an error.
 *
 * 🔴 THIS COUNTS AND CLASSIFIES. IT NEVER QUOTES. No prompt, no completion, no chat text, not even a
 * truncated sample -- which is what makes it `LogClass.NORMAL` (DESIGN_LOG_HYGIENE.md §4.3) rather
 * than SENSITIVE, and therefore readable without turning debug mode on. Adding a "just a few
 * characters for context" sample here would silently reclassify the line; don't.
 *
 * ⚠️ It observes the EXPRESS RESPONSE, not the upstream body, because `forwardFetchResponse` owns
 * that stream's lifecycle (`from.body.pipe(to)`), and a second reader on it would steal chunks. What
 * is tallied here is exactly what reached the browser.
 *
 * ⚠️ `apiType` and `includeReasoning` are PASSED IN, not read from `request.body`. By the time this
 * runs, `filterBodyForBackend` has replaced the body with the one bound for the backend, and both of
 * those are client-only fields it strips — reading them here reports `undefined`, which is exactly
 * what the first deployed version of this line did.
 *
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {{apiType: string, includeReasoning: any}} captured Values taken before the body was filtered
 */
function logReasoningChannelSplit(request, response, { apiType, includeReasoning }) {
    const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : '';

    // The CLASSIFICATION of the prompt tail, never the tail itself. Which of these it is decides
    // whether the provider believes the completion begins inside a think block.
    const promptEndsWith = prompt.endsWith('<think>')
        ? 'open<think>'
        : prompt.endsWith('</think>') ? 'closed</think>' : 'neither';

    let pending = '';
    let frames = 0, textChars = 0, reasoningChars = 0;
    let sawOpenTag = false, sawCloseTag = false;
    let finish = null;
    let reported = false;

    const originalWrite = response.write.bind(response);
    response.write = function (chunk, ...rest) {
        try {
            pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
            let newline;
            while ((newline = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, newline).trim();
                pending = pending.slice(newline + 1);
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                const choice = JSON.parse(payload)?.choices?.[0];
                if (!choice) continue;
                frames++;
                const text = typeof choice.text === 'string' ? choice.text : '';
                const reasoning = typeof choice.reasoning === 'string'
                    ? choice.reasoning
                    : (typeof choice.thinking === 'string' ? choice.thinking : '');
                textChars += text.length;
                reasoningChars += reasoning.length;
                if (text.includes('<think>') || reasoning.includes('<think>')) sawOpenTag = true;
                if (text.includes('</think>') || reasoning.includes('</think>')) sawCloseTag = true;
                if (choice.finish_reason) finish = choice.finish_reason;
            }
        } catch {
            // A partial or non-JSON frame is a normal streaming artifact, and never a reason to
            // disturb the stream we are only observing.
        }

        return originalWrite(chunk, ...rest);
    };

    // Both, because a client that disconnects mid-stream emits `close` without `finish`, and the
    // aborted case is one worth seeing. `reported` keeps it to one line either way.
    const report = () => {
        if (reported) return;
        reported = true;
        const emptyBody = textChars === 0 && reasoningChars > 0;
        log.info(LogClass.NORMAL, '[reasoning-split] ' +
            `api=${apiType} promptChars=${prompt.length} promptEndsWith=${promptEndsWith} ` +
            `include_reasoning=${includeReasoning} ` +
            `maxTokens=${request.body?.max_tokens ?? request.body?.max_new_tokens} | ` +
            `frames=${frames} textChars=${textChars} reasoningChars=${reasoningChars} ` +
            `sawOpenTag=${sawOpenTag} sawCloseTag=${sawCloseTag} finish=${finish} | ` +
            `verdict=${emptyBody ? 'EMPTY BODY - entire reply arrived in the reasoning channel' : 'ok'}`);
    };
    response.on('finish', report);
    response.on('close', report);
}

/**
 * Special boy's steaming routine. Wrap this abomination into proper SSE stream.
 * @param {import('node-fetch').Response} jsonStream JSON stream
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @returns {Promise<any>} Nothing valuable
 */
async function parseOllamaStream(jsonStream, request, response) {
    try {
        if (!jsonStream.body) {
            throw new Error('No body in the response');
        }

        let partialData = '';
        jsonStream.body.on('data', (data) => {
            const chunk = data.toString();
            partialData += chunk;
            while (true) {
                let json;
                try {
                    json = JSON.parse(partialData);
                } catch (e) {
                    break;
                }
                const text = json.response || '';
                const thinking = json.thinking || '';
                const chunk = { choices: [{ text, thinking }] };
                response.write(`data: ${JSON.stringify(chunk)}\n\n`);
                partialData = '';
            }
        });

        request.socket.on('close', function () {
            if (jsonStream.body instanceof Readable) jsonStream.body.destroy();
            response.end();
        });

        jsonStream.body.on('end', () => {
            log.info(LogClass.NORMAL, 'Streaming request finished');
            response.write('data: [DONE]\n\n');
            response.end();
        });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error forwarding the text completion streaming response');
        log.error(LogClass.SENSITIVE, 'Streaming forward error:', error);
        if (!response.headersSent) {
            return response.status(500).send({ error: true });
        } else {
            return response.end();
        }
    }
}

/**
 * Abort KoboldCpp generation request.
 * @param {import('express').Request} request the generation request
 * @param {string} url Server base URL
 * @returns {Promise<void>} Promise resolving when we are done
 */
async function abortKoboldCppRequest(request, url) {
    try {
        log.info(LogClass.NORMAL, 'Aborting Kobold generation...');
        const args = {
            method: 'POST',
            headers: {},
        };

        setAdditionalHeaders(request, args, url);
        const abortResponse = await fetch(`${url}/api/extra/abort`, args);

        if (!abortResponse.ok) {
            log.error(LogClass.NORMAL, 'Error sending abort request to Kobold:', abortResponse.status, abortResponse.statusText);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to send the abort request to KoboldCpp');
        log.error(LogClass.SENSITIVE, error);
    }
}

/**
 * Logs which models a backend's status check found, without dumping an unbounded list into the log.
 *
 * 🔴 THIS EXISTS BECAUSE OF FEATHERLESS, BUT IS NOT A FEATHERLESS SPECIAL CASE. Measured 2026-09-22:
 * Featherless's `/v1/models` answers with 22,009 ids (7 MB; the download itself is about 0.6 s), and the
 * previous unconditional `redact(modelIds)` wrote every one of them into a single st.log line on every
 * Connect — while the browser built a picker from the same 22k entries, a connect took 30–60 seconds.
 * Every other backend's list is small enough that this was never visible, so the fix is
 * general: ANY type whose catalog grows past 50 ids gets the same treatment, rather than one more
 * `apiType === FEATHERLESS` branch to keep in sync.
 * @param {string[]} modelIds Every model id the backend reported
 * @returns {void}
 */
function logModelsAvailable(modelIds) {
    if (modelIds.length > 50) {
        log.info(LogClass.NORMAL, `Models available: ${modelIds.length} models, first 10:`, redact(modelIds.slice(0, 10)));
    } else {
        log.info(LogClass.NORMAL, 'Models available:', redact(modelIds));
    }
}

/**
 * Featherless-only branch of the `/status` route (§ Featherless connect-speed fix, 2026-09-22).
 *
 * Featherless sends `Cache-Control: private, no-store` and no `ETag` on `/v1/models`, so there is no
 * cheap "has this changed" check upstream. Cache the last downloaded list and provide an explicit refresh
 * action; users can also type a model name directly. This keeps the list already paid for on disk
 * ({@link readCachedModelList} / {@link writeCachedModelList}), and only re-downloads it when a person
 * explicitly asks (`refresh_models: true`) or when nothing has ever been cached for this host.
 *
 * The single-model lookup (`GET /v1/models/{id}`, ~825 bytes, verified live 2026-09-22: a known id 200s
 * with `{id, model_class, context_length, availability, ...}`, an unknown one does not) lets a person
 * type in a model id and have it validated against Featherless without ever downloading the full list.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {string} baseUrl Featherless server URL, already trimmed of a trailing /v1
 * @param {{headers: Record<string, string>}} args `fetch()` args carrying this request's auth headers
 * @returns {Promise<import('express').Response>} The response, already sent
 */
async function handleFeatherlessModelsStatus(request, response, baseUrl, args) {
    // The cache key is the HOST this connection targets, not a hardcoded 'api.featherless.ai' — a
    // self-hosted proxy or a test fixture targets a different host and must not share a cache file with
    // the real service.
    const cacheKey = new URL(baseUrl).host;
    // `refresh_models` downloads and returns the catalog. A normal Connect returns only the cached count and
    // timestamp; the cache also serves the first Connect after a restart.
    const wantsRefresh = request.body.refresh_models === true;
    const requestedModel = typeof request.body.model === 'string' && request.body.model.length > 0
        ? request.body.model
        : null;

    const cached = readCachedModelList(cacheKey);

    // Refresh requested, or nothing cached yet: the ONLY branch that downloads the full list — the one
    // this whole change exists to make rare.
    if (wantsRefresh || !cached) {
        log.info(LogClass.NORMAL, `Featherless status check for '${cacheKey}': fetching the full model list (refresh_models=${wantsRefresh}, hadCache=${!!cached}).`);

        const modelsReply = await fetch(`${baseUrl}/v1/models`, args);

        if (!modelsReply.ok) {
            log.error(LogClass.NORMAL, 'Featherless models endpoint is offline.', modelsReply.status);
            return response.sendStatus(400);
        }

        /** @type {any} */
        const data = await modelsReply.json();

        if (!Array.isArray(data?.data)) {
            log.error(LogClass.NORMAL, 'Featherless models response is not an array.');
            return response.sendStatus(400);
        }

        logModelsAvailable(data.data.map(x => x.id));
        const record = writeCachedModelList(cacheKey, data.data);

        return response.send({ result: requestedModel || data.data[0]?.id || 'Valid', data: data.data, cached_models: data.data.length, cached_at: record.cachedAt, cached: false });
    }

    // An ordinary Connect returns the selected model response and cache metadata, not the full catalog. The
    // list leaves the server only when the caller explicitly requests a refresh.
    if (requestedModel) {
        const t0 = Date.now();
        const modelUrl = `${baseUrl}/v1/models/${encodeURIComponent(requestedModel)}`;
        const modelReply = await fetch(modelUrl, args);

        if (!modelReply.ok) {
            log.info(LogClass.NORMAL, `Featherless does not know model '${requestedModel}' for '${cacheKey}' (status ${modelReply.status}, ${Date.now() - t0} ms).`);
            return response.status(400).send({ error: `Featherless does not know model ${requestedModel}` });
        }

        log.info(LogClass.NORMAL, `Featherless status check for '${cacheKey}': model '${requestedModel}' confirmed in ${Date.now() - t0} ms; ${cached.models.length} models cached from ${cached.cachedAt}, none sent.`);
        return response.send({ result: requestedModel, data: [], cached_models: cached.models.length, cached_at: cached.cachedAt, cached: true });
    }

    // No model selected, but a cache exists: the count and date, with no network call at all.
    log.info(LogClass.NORMAL, `Featherless status check for '${cacheKey}': no model selected; ${cached.models.length} models cached from ${cached.cachedAt}, none sent, no network call.`);
    return response.send({ result: 'Valid', data: [], cached_models: cached.models.length, cached_at: cached.cachedAt, cached: true });
}

//************** Ooba/OpenAI text completions API
router.post('/status', async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    try {
        if (request.body.api_server.indexOf('localhost') !== -1) {
            request.body.api_server = request.body.api_server.replace('localhost', '127.0.0.1');
        }

        log.debug(LogClass.NORMAL, 'Trying to connect to API', redact(request.body));
        const baseUrl = trimV1(request.body.api_server);

        const args = {
            headers: { 'Content-Type': 'application/json' },
        };

        setAdditionalHeaders(request, args, baseUrl);

        const apiType = request.body.api_type;
        let url = baseUrl;
        let result = '';

        // 🔴 FEATHERLESS SPLITS OFF HERE, BEFORE THE SHARED FETCH-AND-LOG BELOW EVER RUNS. Every other
        // type still falls through the switch and the generic flow exactly as before; this is the one
        // early return in the whole route, and it exists so the cache (see `handleFeatherlessModelsStatus`)
        // can answer without ever touching the network, which the shared flow below has no way to do.
        if (apiType === TEXTGEN_TYPES.FEATHERLESS) {
            return await handleFeatherlessModelsStatus(request, response, baseUrl, args);
        }

        switch (apiType) {
            case TEXTGEN_TYPES.GENERIC:
            case TEXTGEN_TYPES.OOBA:
            case TEXTGEN_TYPES.VLLM:
            case TEXTGEN_TYPES.APHRODITE:
            case TEXTGEN_TYPES.KOBOLDCPP:
            case TEXTGEN_TYPES.LLAMACPP:
            case TEXTGEN_TYPES.INFERMATICAI:
            case TEXTGEN_TYPES.OPENROUTER:
                url += '/v1/models';
                break;
            case TEXTGEN_TYPES.DREAMGEN:
                url += '/api/openai/v1/models';
                break;
            case TEXTGEN_TYPES.MANCER:
                url += '/oai/v1/models';
                break;
            case TEXTGEN_TYPES.TABBY:
                url += '/v1/model/list';
                break;
            case TEXTGEN_TYPES.TOGETHERAI:
                url += '/api/models?&info';
                break;
            case TEXTGEN_TYPES.OLLAMA:
                url += '/api/tags';
                break;
            case TEXTGEN_TYPES.HUGGINGFACE:
                url += '/info';
                break;
        }

        const modelsReply = await fetch(url, args);
        const isPossiblyLmStudio = modelsReply.headers.get('x-powered-by') === 'Express';

        if (!modelsReply.ok) {
            log.error(LogClass.NORMAL, 'Models endpoint is offline.');
            return response.sendStatus(400);
        }

        /** @type {any} */
        let data = await modelsReply.json();

        // Rewrap to OAI-like response
        if (apiType === TEXTGEN_TYPES.TOGETHERAI && Array.isArray(data)) {
            data = { data: data.map(x => ({ id: x.name, ...x })) };
        }

        if (apiType === TEXTGEN_TYPES.OLLAMA && Array.isArray(data.models)) {
            data = { data: data.models.map(x => ({ id: x.name, ...x })) };
        }

        if (apiType === TEXTGEN_TYPES.HUGGINGFACE) {
            data = { data: [] };
        }

        if (!Array.isArray(data.data)) {
            log.error(LogClass.NORMAL, 'Models response is not an array.');
            return response.sendStatus(400);
        }

        const modelIds = data.data.map(x => x.id);
        logModelsAvailable(modelIds);

        // Set result to the first model ID
        result = modelIds[0] || 'Valid';

        if (apiType === TEXTGEN_TYPES.OOBA && !isPossiblyLmStudio) {
            try {
                const modelInfoUrl = baseUrl + '/v1/internal/model/info';
                const modelInfoReply = await fetch(modelInfoUrl, args);

                if (modelInfoReply.ok) {
                    /** @type {any} */
                    const modelInfo = await modelInfoReply.json();
                    log.debug(LogClass.SENSITIVE, 'Ooba model info:', modelInfo);

                    const modelName = modelInfo?.model_name;
                    result = modelName || result;
                    response.setHeader('x-supports-tokenization', 'true');
                }
            } catch (error) {
                log.error(LogClass.NORMAL, 'Failed to get Ooba model info');
                log.error(LogClass.SENSITIVE, `Failed to get Ooba model info: ${error}`);
            }
        } else if (apiType === TEXTGEN_TYPES.TABBY) {
            try {
                const modelInfoUrl = baseUrl + '/v1/model';
                const modelInfoReply = await fetch(modelInfoUrl, args);

                if (modelInfoReply.ok) {
                    /** @type {any} */
                    const modelInfo = await modelInfoReply.json();
                    log.debug(LogClass.SENSITIVE, 'Tabby model info:', modelInfo);

                    const modelName = modelInfo?.id;
                    result = modelName || result;
                } else {
                    // TabbyAPI returns an error 400 if a model isn't loaded

                    result = 'None';
                }
            } catch (error) {
                log.error(LogClass.NORMAL, 'Failed to get TabbyAPI model info');
                log.error(LogClass.SENSITIVE, `Failed to get TabbyAPI model info: ${error}`);
            }
        }

        return response.send({ result, data: data.data });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Text completion backend status check failed');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/props', async function (request, response) {
    if (!request.body.api_server) return response.sendStatus(400);

    try {
        const baseUrl = trimV1(request.body.api_server);
        const args = {
            headers: {},
        };

        setAdditionalHeaders(request, args, baseUrl);

        const apiType = request.body.api_type;
        let propsUrl = baseUrl + '/props';
        if (apiType === TEXTGEN_TYPES.LLAMACPP && request.body.model) {
            propsUrl += `?model=${encodeURIComponent(request.body.model)}`;
            log.debug(LogClass.SENSITIVE, `Querying llama-server props with model parameter: ${request.body.model}`);
        }
        const propsReply = await fetch(propsUrl, args);

        if (!propsReply.ok) {
            return response.sendStatus(400);
        }

        /** @type {any} */
        const props = await propsReply.json();
        // TEMPORARY: llama.cpp's /props endpoint has a bug which replaces the last newline with a \0
        if (apiType === TEXTGEN_TYPES.LLAMACPP && props.chat_template && props.chat_template.endsWith('\u0000')) {
            props.chat_template = props.chat_template.slice(0, -1) + '\n';
        }
        // 🔴 GUARDED, BECAUSE A BACKEND IS ALLOWED TO HAVE NO CHAT TEMPLATE AND ONE REALLY DOES.
        //
        // `createHash(...).update(undefined)` throws a TypeError, the catch below turns it into a 500, and the
        // client's `if (response.ok)` then skips the whole derivation without a word — so "my context size
        // stopped updating" arrives with no error anywhere. The line directly above already guards
        // `props.chat_template` for the null-byte fix; this one did not, which is the kind of asymmetry that
        // only shows up when something finally returns the empty case.
        //
        // llama-server in router mode (`--models-preset`) is that something. Asked without `?model=`, it
        // describes the ROUTER rather than any model — `"role":"router"`, `"model_path":"none"`, no
        // `chat_template` at all — which is exactly what a connection with a blank Model field sends.
        // Verified on a live router 2026-08-25: bare `/props` 500s here, `/props?model=<name>` returns
        // properties with `n_ctx` 47104.
        //
        // ⚠️ AND THE HASH MUST STAY ABSENT RATHER THAN BECOME THE HASH OF "". `power_user.chat_template_hash`
        // is a map key for saved template mappings, so hashing the empty string would file every
        // template-less backend under one shared, real-looking key.
        props.chat_template_hash = props.chat_template
            ? createHash('sha256').update(props.chat_template).digest('hex')
            : undefined;
        log.debug(LogClass.SENSITIVE, `Model properties: ${JSON.stringify(props)}`);
        return response.send(props);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to get text completion backend model properties');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/generate', async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    /**
     * Finalize this generation's prompt record, once. Declared out here rather than inside the `try` so the
     * `catch` at the bottom can reach it — a generation that threw is still a generation that ENDED, and a
     * record left `pending` claims the opposite for ever. Replaced with the real closure below, once there
     * is a record to finalize; until then it is deliberately a no-op, because a request that fails before
     * `recordOutgoingPrompt` runs has nothing to report.
     * @type {(status: "completed"|"failed"|"cancelled", usageResult?: {usageState?: "available"|"absent"|"invalid", usage?: object}) => void}
     */
    let finalizeRecord = () => {};

    try {
        if (request.body.api_server.indexOf('localhost') !== -1) {
            request.body.api_server = request.body.api_server.replace('localhost', '127.0.0.1');
        }

        const apiType = request.body.api_type;
        const baseUrl = request.body.api_server;

        // Captured here because `filterBodyForBackend` below REPLACES `request.body` with the one bound
        // for the backend, and `include_reasoning` is a client-only field it strips. The diagnostic at the
        // streaming branch runs after that point, so reading it there reports `undefined`.
        const includeReasoning = request.body.include_reasoning;

        // Remember which backend this user is talking to, so a plugin's `context.generate()` can later reach the
        // same one without a request of its own (see plugin-generate.js). Last-write-wins: the most recent real
        // generation is by definition the active backend. Cheap, and it decides nothing.
        //
        // The instruct envelope (§19) rides the same Map entry: three opaque strings the client computed from
        // ITS OWN instruct template, which the fork stores and concatenates without ever reading a template
        // field. It comes in a header for the same reason identity does -- the body below goes to the backend.
        // `directories` and `secret_id` ride along so a later `context.generate()` can authenticate the same way
        // this route does. They are the ADDRESS of the key, not the key -- plugin-generate.js resolves it at send
        // time, so a rotated or locked-away secret is never replayed from a stale copy.
        captureConnection(request.user?.profile?.handle, {
            api_type: apiType,
            api_server: baseUrl,
            model: request.body.model,
            envelope: readInstructEnvelope(request),
            directories: request.user?.directories,
            secretId: request.body.secret_id ?? null,
            setHeaders: setAdditionalHeadersByType,
        });

        // 🔴 THE STRIP, AND IT IS ABOVE THE GATE ON PURPOSE. `st_recent_messages` is the one thing the client
        // puts in the body that must never reach a backend -- §17.2 -- and the body below is serialised
        // VERBATIM. It is taken off here whether or not anybody is listening, because "no plugin registered"
        // must not be the difference between stripped and leaked. Moving this inside the `if` re-opens exactly
        // the hole §16.2 closed for the small fields.
        const recentMessages = takeRecentMessages(request);

        // 🔴 SHOW THE PROMPT TO ANYONE WHO REGISTERED, BEFORE IT LEAVES. This is the server-side mirror of
        // the client's `runGenerationInterceptors`, and it is the only chance a server plugin has to take
        // part in generation.
        //
        // ⚠️ NOTHING MAY BE ADDED TO `request.body` HERE. Every branch below serialises it VERBATIM --
        // `JSON.stringify(request.body)` -- so an extra field is not a local note, it is transmitted to the
        // backend. `prompt` is replaced in place because it is already part of the contract; `budget` is
        // READ from the body and never written back.
        // ⚠️ HOISTED OUT OF THE `if` BELOW BECAUSE THE RECORD NEEDS IT TOO, AND IT IS SAFE TO HOIST: these are
        // pure header reads with no side effects and no writes to the request.
        const identity = readIdentityHeaders(request);

        /** @type {string[]} Plugins whose interceptors actually changed the prompt; see `prompt-record.js`. */
        let rewrittenBy = [];

        /** @type {Array<{id: string, atChar: number, delta: number}>} Where each of those changes begins. */
        let rewriteSites = [];

        if (hasPromptInterceptors()) {
            const intercepted = await runPromptInterceptors({
                handle: request.user?.profile?.handle,
                backend: 'text',
                apiType: apiType,
                prompt: request.body.prompt,
                // The client already fitted the prompt to this and sends it because the backend needs it
                // too. It has always been here; nothing had to be plumbed to get it.
                budget: request.body.truncation_length,
                // Character/chat identity and the generation kind, carried in headers so they never enter the
                // body that this path forwards to the backend verbatim (see readIdentityHeaders).
                charName: identity.charName,
                chatId: identity.chatId,
                genType: identity.genType,
                // §22: the avatar filename goes in, a stable `charId` comes out — resolved in
                // `runPromptInterceptors` and stripped there, so this path never learns about the map.
                charAvatar: identity.charAvatar,
                personaId: identity.personaId,
                userRoot: request.user?.directories?.root,
                // The structured turns the client rendered this prompt FROM (§17). The interceptor slices
                // this per plugin; what arrives here is the largest window anybody asked for.
                recentMessages: recentMessages,
            });

            request.body.prompt = intercepted.prompt;
            rewrittenBy = intercepted[REWRITTEN_BY] ?? [];
            rewriteSites = intercepted[REWRITE_SITES] ?? [];
        }

        // 🔴 AFTER THE INTERCEPTORS AND BEFORE THE WIRE — THE ONLY POINT WHERE "WHAT WAS ACTUALLY SENT" EXISTS.
        // Above this line the prompt is what the client built; below it, it is gone. The browser's own copy
        // (`itemizedPrompts[].rawPrompt`) is taken before the request is even made, so without this the client
        // has no way to know a plugin rewrote it. Unconditional on purpose: "no plugin ran" is an answer a
        // consumer needs just as much, and it is the one a stock install gives.
        const promptRecord = recordOutgoingPrompt({
            handle: request.user?.profile?.handle,
            backend: 'text',
            apiType: apiType,
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
        if (promptRecord && !response.headersSent) {
            response.setHeader('X-ST-Prompt-Seq', String(promptRecord.seq));
        }

        // 🔴 TEXT COMPLETIONS FINALIZE TOO, AND THIS IS THE PATH THAT ACTUALLY MATTERS HERE.
        // Finalize terminal prompt records on this route as well as chat completions. Quiet generations can
        // originate here; leaving them pending prevents their raw-generation data from being persisted.
        const recordRef = promptRecord
            ? { handle: request.user?.profile?.handle, backend: 'text', recordId: promptRecord.recordId }
            : null;
        let recordFinalized = false;

        /**
         * Finalize this generation's prompt record, once.
         *
         * ⚠️ THE LOCAL FLAG IS THE MECHANISM, not `finalizePromptRecord`'s own idempotency. That is a
         * backstop for a repeated IDENTICAL update; relying on it alone would let an abort landing in the
         * same tick as a stream error race to log a spurious "contradictory" when both were one generation
         * ending badly. Same reasoning as the chat-completions helper.
         * @param {"completed"|"failed"|"cancelled"} status The terminal status
         * @param {{usageState?: "available"|"absent"|"invalid", usage?: object}} [usageResult] Usage to
         * attach — §11.1: `cancelled` and `failed` never pass one.
         * @returns {void}
         */
        finalizeRecord = function (status, usageResult) {
            if (!recordRef || recordFinalized) {
                return;
            }

            recordFinalized = true;

            const result = finalizePromptRecord({
                handle: recordRef.handle,
                backend: recordRef.backend,
                recordId: recordRef.recordId,
                status,
                completedAt: Date.now(),
                usageState: usageResult?.usageState,
                usage: usageResult?.usage,
            });

            log.debug(LogClass.NORMAL, `Text completions transport: recordId ${recordRef.recordId} seq ${result.seq ?? 'unknown'} apiType ${apiType} -> status "${status}", usageState "${usageResult?.usageState ?? 'absent'}", result reason "${result.reason}".`);
        };

        log.debug(LogClass.SENSITIVE, request.body);

        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', async function () {
            if (request.body.api_type === TEXTGEN_TYPES.KOBOLDCPP && !response.writableEnded) {
                await abortKoboldCppRequest(request, trimV1(baseUrl));
            }

            controller.abort();
            // A downstream close before this generation reached a terminal status of its own is a
            // cancellation, not a failure (§6.5).
            finalizeRecord('cancelled');
        });

        // The per-backend URL is resolved by plugin-generate.js so the /generate route and `context.generate()`
        // agree on it exactly — the factor-out that lets a plugin reach this backend without an Express request.
        const url = resolveTextCompletionsUrl(apiType, baseUrl);

        // 🔴 SAY WHICH SETTING IS EMPTY, INSTEAD OF LETTING `fetch` THROW ERR_INVALID_URL FROM UNDICI.
        //
        // `resolveTextCompletionsUrl` is string concatenation: a blank `api_server` yields the RELATIVE path
        // `/v1/completions`, and `fetch` rejects that with a bare `ERR_INVALID_URL` naming neither the api type
        // nor the setting. That is what a live Qvink Memory failure looked like — four red toasts reading
        // "Response not OK" and a server log line with a code and nothing else. The information needed to
        // diagnose it existed here and was thrown away.
        //
        // ⚠️ NORMAL class is correct and is not a hygiene slip: `apiType` and the EMPTINESS of a server URL are
        // configuration, not user content. No prompt, no chat, no handle. The URL itself stays SENSITIVE
        // because a self-hosted endpoint can carry a hostname the operator would not publish.
        if (!URL.canParse(url)) {
            log.error(LogClass.NORMAL, `Text completion generation refused: api_type '${apiType}' has no usable server URL, so the request was never sent. The resolved target is not absolute — check the Server URL for this API, and the "Server URL" field of the connection profile if an extension made this request.`);
            log.error(LogClass.SENSITIVE, `The unusable target resolved to '${url}' from api_server '${baseUrl}'.`);

            return response.status(400).send({
                error: true,
                status: 'NO_SERVER_URL',
                response: `No server URL is configured for API type '${apiType}'. The request was not sent. If this came from an extension, check that its connection profile has a Server URL.`,
            });
        }

        const args = {
            method: 'POST',
            body: JSON.stringify(request.body),
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            timeout: 0,
        };

        setAdditionalHeaders(request, args, baseUrl);

        if (request.body.api_type === TEXTGEN_TYPES.TOGETHERAI) {
            request.body = filterBodyForBackend(TEXTGEN_TYPES.TOGETHERAI, request.body);
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.INFERMATICAI) {
            request.body = filterBodyForBackend(TEXTGEN_TYPES.INFERMATICAI, request.body);
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.FEATHERLESS) {
            request.body = filterBodyForBackend(TEXTGEN_TYPES.FEATHERLESS, request.body);
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.DREAMGEN) {
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.GENERIC) {
            request.body = filterBodyForBackend(TEXTGEN_TYPES.GENERIC, request.body);
            if (Array.isArray(request.body.stop)) { request.body.stop = request.body.stop.slice(0, 4); }
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.OPENROUTER) {
            if (Array.isArray(request.body.provider) && request.body.provider.length > 0) {
                request.body.provider = {
                    allow_fallbacks: request.body.allow_fallbacks ?? true,
                    order: request.body.provider,
                };
            } else {
                delete request.body.provider;
            }

            if (Array.isArray(request.body.quantizations) && request.body.quantizations.length > 0) {
                request.body.provider ??= {};
                request.body.provider.quantizations = request.body.quantizations;
            }

            request.body = filterBodyForBackend(TEXTGEN_TYPES.OPENROUTER, request.body);
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.VLLM) {
            request.body = filterBodyForBackend(TEXTGEN_TYPES.VLLM, request.body);
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.OLLAMA) {
            const keepAlive = Number(getConfigValue('ollama.keepAlive', -1, 'number'));
            const numBatch = Number(getConfigValue('ollama.batchSize', -1, 'number'));
            if (numBatch > 0) {
                request.body.num_batch = numBatch;
            }
            args.body = JSON.stringify({
                model: request.body.model,
                prompt: request.body.prompt,
                stream: request.body.stream ?? false,
                keep_alive: keepAlive,
                raw: true,
                options: _.pickBy(request.body, (_, key) => OLLAMA_KEYS.includes(key)),
            });
        }

        if (request.body.api_type === TEXTGEN_TYPES.OLLAMA && request.body.stream) {
            const stream = await fetch(url, args);
            // ⚠️ OLLAMA'S STREAM IS NOT FINALIZED, AND THAT IS A KNOWN GAP RATHER THAN AN OVERSIGHT.
            // `parseOllamaStream` is fire-and-forget and owns the response from here, so there is no point
            // in this function where its outcome is known. An Ollama streaming record therefore stays
            // `pending` and produces no raw row, exactly as every backend did before this change. Fixing it
            // means giving `parseOllamaStream` the record reference, which is a change to a function this
            // work has no other reason to touch.
            parseOllamaStream(stream, request, response);
        } else if (request.body.stream) {
            const completionsStream = await fetch(url, args);
            // Counts which channel the bytes went down. Content-free; see the function's own note.
            logReasoningChannelSplit(request, response, { apiType, includeReasoning });

            if (!completionsStream.ok) {
                // `forwardFetchResponse` handles the error body itself and never pipes, so the observer
                // would never see an `end` — finalize here or this record never leaves `pending`.
                finalizeRecord('failed');
                await forwardFetchResponse(completionsStream, response);
                return;
            }

            // ⚠️ THE OBSERVER FORWARDS EVERY BYTE UNCHANGED; it only reads `data:` events looking for a
            // `usage` object. `forwardFetchResponse`'s third parameter is optional and every other caller
            // still passes two, so nothing else in the app is affected.
            const observer = recordRef ? createDeepSeekUsageObserver({ recordId: recordRef.recordId }) : null;

            if (observer) {
                observer.on('end', () => finalizeRecord('completed', observer.getResult()));
                observer.on('error', () => finalizeRecord('failed'));
                completionsStream.body?.on?.('error', () => finalizeRecord('failed'));
            }

            // Pipe remote SSE stream to Express response
            await forwardFetchResponse(completionsStream, response, observer ?? undefined);
        } else {
            const completionsReply = await fetch(url, args);

            if (completionsReply.ok) {
                /** @type {any} */
                const data = await completionsReply.json();
                log.debug(LogClass.SENSITIVE, 'Endpoint response:', data);

                // Map InfermaticAI response to OAI completions format
                if (apiType === TEXTGEN_TYPES.INFERMATICAI) {
                    data.choices = (data?.choices || []).map(choice => ({ text: choice?.message?.content || choice.text, logprobs: choice?.logprobs, index: choice?.index }));
                }

                // Before the body is sent, and without altering it by a byte (§6.4).
                finalizeRecord('completed', normalizeDeepSeekChatUsage(data?.usage, { provider: apiType, api: 'text-completions' }));

                return response.send(data);
            } else {
                const text = await completionsReply.text();
                const errorBody = { error: true, status: completionsReply.status, response: text };

                // No error body or message is stored on the record — only that it failed (§6.4).
                finalizeRecord('failed');

                return !response.headersSent
                    ? response.send(errorBody)
                    : response.end();
            }
        }
    } catch (error) {
        const status = error?.status ?? error?.code ?? 'UNKNOWN';
        const text = error?.error ?? error?.statusText ?? error?.message ?? 'Unknown error on /generate endpoint';
        let value = { error: true, status: status, response: text };
        log.error(LogClass.NORMAL, 'Text completion generation failed');
        log.error(LogClass.SENSITIVE, 'Endpoint error:', error);

        // The generation is over however it got here, so its record must not be left claiming to be in
        // flight. No error text reaches the record — only that it failed.
        finalizeRecord('failed');

        return !response.headersSent
            ? response.send(value)
            : response.end();
    }
});

const ollama = express.Router();

ollama.post('/download', async function (request, response) {
    try {
        if (!request.body.name || !request.body.api_server) return response.sendStatus(400);

        const name = request.body.name;
        const url = String(request.body.api_server).replace(/\/$/, '');
        log.debug(LogClass.SENSITIVE, 'Pulling Ollama model:', name);

        const fetchResponse = await fetch(`${url}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                stream: false,
            }),
        });

        if (!fetchResponse.ok) {
            log.error(LogClass.NORMAL, 'Download error:', fetchResponse.status, fetchResponse.statusText);
            return response.status(500).send({ error: true });
        }

        log.debug(LogClass.SENSITIVE, 'Ollama pull response:', await fetchResponse.json());
        return response.send({ ok: true });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Ollama model download failed');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

ollama.post('/caption-image', async function (request, response) {
    try {
        if (!request.body.server_url || !request.body.model) {
            return response.sendStatus(400);
        }

        log.debug(LogClass.SENSITIVE, 'Ollama caption request:', request.body);
        const baseUrl = trimV1(request.body.server_url);

        const fetchResponse = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: request.body.model,
                prompt: request.body.prompt,
                images: [request.body.image],
                stream: false,
            }),
        });

        if (!fetchResponse.ok) {
            const errorText = await fetchResponse.text();
            log.error(LogClass.NORMAL, 'Ollama caption error:', fetchResponse.status, fetchResponse.statusText);
            log.error(LogClass.SENSITIVE, 'Ollama caption error body:', errorText);
            return response.status(500).send({ error: true });
        }

        /** @type {any} */
        const data = await fetchResponse.json();
        log.debug(LogClass.SENSITIVE, 'Ollama caption response:', data);

        const caption = data?.response || '';

        if (!caption) {
            log.error(LogClass.NORMAL, 'Ollama caption is empty.');
            return response.status(500).send({ error: true });
        }

        return response.send({ caption });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Ollama image captioning failed');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

const llamacpp = express.Router();

llamacpp.post('/props', async function (request, response) {
    try {
        if (!request.body.server_url) {
            return response.sendStatus(400);
        }

        log.debug(LogClass.SENSITIVE, 'LlamaCpp props request:', request.body);
        const baseUrl = trimV1(request.body.server_url);

        const fetchResponse = await fetch(`${baseUrl}/props`, {
            method: 'GET',
        });

        if (!fetchResponse.ok) {
            log.error(LogClass.NORMAL, 'LlamaCpp props error:', fetchResponse.status, fetchResponse.statusText);
            return response.status(500).send({ error: true });
        }

        const data = await fetchResponse.json();
        log.debug(LogClass.SENSITIVE, 'LlamaCpp props response:', data);

        return response.send(data);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to get LlamaCpp server properties');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

llamacpp.post('/slots', async function (request, response) {
    try {
        if (!request.body.server_url) {
            return response.sendStatus(400);
        }
        if (!/^(erase|info|restore|save)$/.test(request.body.action)) {
            return response.sendStatus(400);
        }

        log.debug(LogClass.SENSITIVE, 'LlamaCpp slots request:', request.body);
        const baseUrl = trimV1(request.body.server_url);

        let fetchResponse;
        if (request.body.action === 'info') {
            fetchResponse = await fetch(`${baseUrl}/slots`, {
                method: 'GET',
            });
        } else {
            if (!/^\d+$/.test(request.body.id_slot)) {
                return response.sendStatus(400);
            }
            if (request.body.action !== 'erase' && !request.body.filename) {
                return response.sendStatus(400);
            }

            fetchResponse = await fetch(`${baseUrl}/slots/${request.body.id_slot}?action=${request.body.action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: request.body.action !== 'erase' ? `${request.body.filename}` : undefined,
                }),
            });
        }

        if (!fetchResponse.ok) {
            log.error(LogClass.NORMAL, 'LlamaCpp slots error:', fetchResponse.status, fetchResponse.statusText);
            return response.status(500).send({ error: true });
        }

        const data = await fetchResponse.json();
        log.debug(LogClass.SENSITIVE, 'LlamaCpp slots response:', data);

        return response.send(data);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to get LlamaCpp slots');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

const tabby = express.Router();

tabby.post('/download', async function (request, response) {
    try {
        const baseUrl = String(request.body.api_server).replace(/\/$/, '');

        const args = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.body),
            timeout: 0,
        };

        setAdditionalHeaders(request, args, baseUrl);

        // Check key permissions
        const permissionResponse = await fetch(`${baseUrl}/v1/auth/permission`, {
            headers: args.headers,
        });

        if (permissionResponse.ok) {
            /** @type {any} */
            const permissionJson = await permissionResponse.json();

            if (permissionJson.permission !== 'admin') {
                return response.status(403).send({ error: true });
            }
        } else {
            log.error(LogClass.NORMAL, 'API Permission error:', permissionResponse.status, permissionResponse.statusText);
            return response.status(500).send({ error: true });
        }

        const fetchResponse = await fetch(`${baseUrl}/v1/download`, args);

        if (!fetchResponse.ok) {
            log.error(LogClass.NORMAL, 'Download error:', fetchResponse.status, fetchResponse.statusText);
            return response.status(500).send({ error: true });
        }

        return response.send({ ok: true });
    } catch (error) {
        log.error(LogClass.NORMAL, 'TabbyAPI model download failed');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.use('/ollama', ollama);
router.use('/llamacpp', llamacpp);
router.use('/tabby', tabby);

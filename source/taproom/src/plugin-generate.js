/**
 * Server-side generation for plugins — the engine behind `context.generate()`.
 *
 * This is the sibling of `embed` (§13.1 of DESIGN_MEMORY_PLUGIN_API.md), but where `embed` forwards to a LOCAL
 * transformers model, `generate` forwards to **the backend the user is already talking to**. A memory plugin's
 * ingest needs to run an LLM pass of its own — "what in this conversation is worth remembering?" — and a plugin
 * has no backend of its own and must not acquire one.
 *
 * 🔴 THE DEFAULT BACKEND IS THE ACTIVE ONE, CAPTURED. The fork keeps no persistent backend config: the
 * connection (`api_type`, `api_server`, `model`) arrives per-request in `request.body` and is gone when the
 * request ends. But a plugin only ever wants to generate in service of a conversation that is itself
 * generating — so a live connection has just passed through. `captureConnection()` stashes it per handle;
 * `generate()` replays the last one. Last-active is active. See DESIGN_MEMORY_PLUGIN_API.md §15.
 * ⚠️ "A plugin only generates in service of a generation" stopped being true with the panel rescan (API v7),
 * so panel requests now carry the connection too — see `panelConnectionCapture`.
 *
 * ⚠️ THE FORK DECIDES NOTHING ABOUT THE PROMPT. The plugin owns its prompt format; `generate` takes a rendered
 * string and returns text. No persona, no instruct-wrapping unless asked — that is the plugin's business, or a
 * later `config.yaml` option, never the fork's judgement.
 *
 * 🔴 THE WIRE STREAMS; THE PLUGIN NEVER SEES A CHUNK. This line used to say "no streaming" and that was a
 * statement about the API, read as a statement about the transport, and the transport is where it was wrong:
 * `stream: false` was hardcoded, and Featherless's `deepseek-ai/DeepSeek-V4-Pro` answers a non-streaming
 * `/v1/completions` with HTTP 500 (7/7, against 0/7 streaming, same key and same body). ST's own chat path
 * talks to that model happily because that path streams — so the model looks up, the UI works, and only the
 * plugin path is dead. Streaming is also the better-exercised path on every backend here, for the same reason.
 * `generate()` accumulates and still resolves once, so the plugin's contract is unchanged.
 */

import { StringDecoder } from 'node:string_decoder';

import fetch from 'node-fetch';

import {
    TEXTGEN_TYPES,
    TOGETHERAI_KEYS,
    INFERMATICAI_KEYS,
    FEATHERLESS_KEYS,
    OPENROUTER_KEYS,
    VLLM_KEYS,
    OPENAI_KEYS,
} from './constants.js';
import { trimV1, getPluginTimeoutMs } from './util.js';
import { log, LogClass } from './logger.js';
import * as storage from './storage.js';
import { OPENAI_WIRE_CHAT_SOURCES, resolveOpenAiWireChatSource } from './chat-source.js';

/**
 * A single-turn instruct wrapper, as the CLIENT computed it (§19.3).
 *
 * 🔴 THREE OPAQUE STRINGS, AND THE FORK NEVER LEARNS WHAT THEY MEAN. The tempting design is to ship the active
 * instruct preset here and read `input_sequence` / `output_sequence` out of it — and it produces correct output
 * for ChatML and SILENT GARBAGE for Alpaca-Single-Turn, whose `input_sequence`, `output_sequence` and
 * `input_suffix` are all `""` and whose framing lives in entirely different fields. There are ~30 shipped
 * presets and they disagree about which fields carry the framing. The client owns `instruct-mode.js`, so the
 * client computes the envelope; the server concatenates strings it cannot tell apart, which is exactly right
 * and is §3 applied to formatting.
 * @typedef {object} InstructEnvelope
 * @property {string} prefix Goes before the plugin's prompt
 * @property {string} suffix Goes after it, and cues the model to answer
 * @property {string[]} stop Terminators for this template
 */

/**
 * `setAdditionalHeadersByType`, handed in by the route rather than imported here (see the map below).
 * @callback HeaderResolver
 * @param {object} requestHeaders Headers object to assign onto
 * @param {string} type The backend's `api_type`
 * @param {string|null} server The backend base URL, for per-host config overrides
 * @param {import('./users.js').UserDirectoryList} directories Where this user's secrets live
 * @param {string|null} secretId Which secret to use, when the user has several
 * @returns {void}
 */

/**
 * The last backend connection seen for each user, so `generate()` can reach the one they are talking to.
 * In-memory only: a connection is a routing fact about the live session, not durable data.
 *
 * 🔴 `directories` AND `secretId` ARE HERE, THE API KEY IS NOT, AND THAT IS THE WHOLE POINT. What is stored
 * is the ADDRESS of the secret store plus which secret to pick — never the secret. `generate()` resolves the key
 * at send time through the same resolver the route uses, so a key that is rotated, revoked, or made unreadable
 * by `storage.lock()` between the capture and the send is not replayed from a stale copy in this map. Caching
 * the resolved `Authorization` header here would be one line shorter and would put a live bearer token in
 * process memory for the lifetime of the session, which is exactly what §16.2 forbids.
 *
 * 🔴 `setHeaders` IS INJECTED BY THE ROUTE AND MUST NOT BECOME AN IMPORT HERE. Importing
 * `additional-headers.js` reaches `endpoints/secrets.js`, whose TOP LEVEL evaluates
 * `getConfigValue('allowKeysExposure')` — and `getConfigValue` calls `process.exit(1)` when no config path is
 * set. This module is driven directly by the unit suite, which sets none, so a static import turns every
 * `plugin-generate` test into an immediate process death with a stack pointing at config loading. Injection
 * keeps this module free of side-effecting dependencies, and it is what makes the auth path testable at all:
 * a test can hand in a fake resolver and assert on the header that reached the wire.
 *
 * 🔴 A CHAT CONNECTION (plugin API 8) SITS IN THE SAME MAP, UNDER THE SAME RULES. `family: 'chat'` marks one;
 * `api_type` is then the `chat_completion_source` and `api_server` the resolved base URL. It carries
 * `secretKey` (the SLOT, e.g. `api_key_custom`) and `readSecret` (injected by the route, for the same reason
 * `setHeaders` is) so the key is read at send time; `extraHeaders` / `extraBody` are the user's own
 * `custom_include_headers` / `custom_include_body`, already parsed. Those two CAN hold a bearer token the user
 * typed into the Custom source's "additional headers" box — the same class of content as the envelope's
 * names, and cleared by `clearConnectionFor` on `storage.lock()` for the same reason. "Last-active is active"
 * is unchanged: a user alternating text and chat generations gets whichever one just passed.
 * @typedef {object} CapturedConnection
 * @property {'text'|'chat'} family
 * @property {string} api_type
 * @property {string} api_server
 * @property {string|undefined} model
 * @property {InstructEnvelope|undefined} envelope
 * @property {import('./users.js').UserDirectoryList|undefined} directories
 * @property {string|null} secretId
 * @property {HeaderResolver|undefined} setHeaders
 * @property {string} secretKey
 * @property {boolean} keyRequired
 * @property {SecretReader|undefined} readSecret
 * @property {Record<string, string>} extraHeaders
 * @property {Record<string, unknown>} extraBody
 */

/**
 * `readSecret` from `endpoints/secrets.js`, injected rather than imported (see above).
 * @callback SecretReader
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key The secret slot
 * @param {string|null} [id] Which of several secrets in that slot
 * @returns {string} The secret, or '' when none is stored
 */

/** @type {Map<string, CapturedConnection>} */
const connections = new Map();

/**
 * Read the instruct envelope a generation carries out-of-band, in a header.
 *
 * ⚠️ A HEADER, FOR §16.2's REASON AND NOT §17.2's. The envelope is three short strings — it fits the channel
 * the backend fetch never copies, so it cannot leak by construction. §17's window had to take the body only
 * because a whole conversation does not fit a header; nothing about that applies here. URL-encoded because a
 * template sequence contains newlines and may be non-ASCII, neither of which a raw header value can carry.
 *
 * Absent, malformed or the wrong shape all yield `undefined` — meaning "this client did not send one", which
 * `generate({wrap: true})` turns into a loud throw rather than a quiet unwrapped prompt.
 * @param {import('express').Request} request The generation request
 * @returns {InstructEnvelope|undefined} The envelope, or undefined
 */
export function readInstructEnvelope(request) {
    const raw = request?.get?.('X-ST-Instruct-Envelope');
    if (typeof raw !== 'string' || raw === '') {
        return undefined;
    }

    try {
        const parsed = JSON.parse(decodeURIComponent(raw));
        if (typeof parsed?.prefix !== 'string' || typeof parsed?.suffix !== 'string' || !Array.isArray(parsed?.stop)) {
            throw new Error('not an envelope');
        }

        return {
            prefix: parsed.prefix,
            suffix: parsed.suffix,
            stop: parsed.stop.filter(one => typeof one === 'string' && one !== ''),
        };
    } catch (error) {
        // Loud, because the consequence downstream is a plugin's `wrap: true` throwing with a message that
        // points at the client rather than at this line.
        log.error(LogClass.NORMAL, 'A generation carried an X-ST-Instruct-Envelope that could not be read. context.generate({wrap:true}) will refuse for this user.');
        log.error(LogClass.SENSITIVE, 'Instruct envelope parse error:', error);
        return undefined;
    }
}

/**
 * Remember the backend a user's generation just used, so a later `context.generate()` for that user reaches the
 * same one. Called from the generation routes. Cheap and last-write-wins — the most recent real generation is,
 * by definition, the active backend. Ignores an incomplete connection rather than storing a broken one.
 *
 * A text connection is `{api_type, api_server, ...}` as always; a chat connection (API 8) is the same call with
 * `family: 'chat'`, `api_type` = the chat source, and the chat-only fields described on the map above.
 * @param {string|undefined} handle The authenticated user, `request.user?.profile?.handle`
 * @param {Partial<CapturedConnection> & {api_type: string, api_server: string}} connection
 * @returns {void}
 */
export function captureConnection(handle, connection) {
    if (typeof handle !== 'string' || !handle || !connection?.api_type || !connection?.api_server) {
        return;
    }

    connections.set(handle, {
        family: connection.family === 'chat' ? 'chat' : 'text',
        api_type: connection.api_type,
        api_server: connection.api_server,
        model: connection.model,
        envelope: connection.envelope,
        directories: connection.directories,
        secretId: connection.secretId ?? null,
        setHeaders: connection.setHeaders,
        secretKey: typeof connection.secretKey === 'string' ? connection.secretKey : '',
        keyRequired: connection.keyRequired === true,
        readSecret: typeof connection.readSecret === 'function' ? connection.readSecret : undefined,
        extraHeaders: isPlainObject(connection.extraHeaders) ? { ...connection.extraHeaders } : {},
        extraBody: isPlainObject(connection.extraBody) ? { ...connection.extraBody } : {},
    });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the text-completion connection a PANEL request carries, in `X-ST-Connection`.
 *
 * 🔴 WHY A PANEL REQUEST CARRIES ONE (API v7). The captured connection used to arrive only with a generation,
 * so `generate()` threw until the user had generated once this process. A rescan is started by a click in a
 * panel: after a server restart the first click failed until the user sent a chat message — the very thing a
 * rescan exists to avoid needing. So the panel host sends the same three facts the `/generate` body carries,
 * and {@link panelConnectionCapture} stores them through the same {@link captureConnection}.
 *
 * ⚠️ SAME TRUST AS THE GENERATION BODY, NOT LESS. The `/generate` route takes `api_server` from the request
 * body of the same logged-in browser and posts to it with the user's key; this is that browser saying the same
 * thing in a header. Only an http(s) URL is accepted, and the route's `localhost` rewrite is applied here too,
 * so the two captures of one connection cannot differ.
 * @param {import('express').Request} request A request to a plugin's router
 * @returns {{api_type: string, api_server: string, model: string|undefined}|undefined} The connection, or
 * undefined when absent or malformed
 */
export function readConnectionHeader(request) {
    const raw = request?.get?.('X-ST-Connection');
    if (typeof raw !== 'string' || raw === '') {
        return undefined;
    }

    try {
        const parsed = JSON.parse(decodeURIComponent(raw));

        if (parsed.model !== undefined && parsed.model !== null && typeof parsed.model !== 'string') {
            throw new Error('model is not a string');
        }
        const model = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined;

        // API 8: a Chat Completion connection. The client names the SOURCE and, for the sources that have
        // one, the user-typed URL; the base URL of the fixed sources (OpenAI, OpenRouter) is the server's to
        // know, so it is resolved in `panelConnectionCapture` rather than trusted from the header.
        if (parsed?.family === 'chat') {
            if (typeof parsed?.chat_completion_source !== 'string' || parsed.chat_completion_source === '') {
                throw new Error('not a chat connection');
            }
            const customUrl = typeof parsed.custom_url === 'string' ? parsed.custom_url : '';
            const reverseProxy = typeof parsed.reverse_proxy === 'string' ? parsed.reverse_proxy : '';
            for (const url of [customUrl, reverseProxy]) {
                if (url !== '') {
                    const protocol = new URL(url).protocol;
                    if (protocol !== 'http:' && protocol !== 'https:') {
                        throw new Error(`unsupported protocol ${protocol}`);
                    }
                }
            }

            return {
                family: 'chat',
                api_type: parsed.chat_completion_source,
                api_server: '',
                custom_url: customUrl.indexOf('localhost') !== -1 ? customUrl.replace('localhost', '127.0.0.1') : customUrl,
                reverse_proxy: reverseProxy,
                model,
            };
        }

        if (typeof parsed?.api_type !== 'string' || parsed.api_type === '' || typeof parsed?.api_server !== 'string') {
            throw new Error('not a connection');
        }

        const protocol = new URL(parsed.api_server).protocol;
        if (protocol !== 'http:' && protocol !== 'https:') {
            throw new Error(`unsupported protocol ${protocol}`);
        }

        return {
            family: 'text',
            api_type: parsed.api_type,
            // The `/generate` route's own rewrite, so both captures of one connection are byte-identical.
            api_server: parsed.api_server.indexOf('localhost') !== -1 ? parsed.api_server.replace('localhost', '127.0.0.1') : parsed.api_server,
            model,
        };
    } catch (error) {
        // The consequence is a `generate()` that throws "no active backend" from a panel action, which points
        // at the plugin; this line points at the header.
        log.error(LogClass.NORMAL, 'A plugin panel request carried an X-ST-Connection that could not be read. context.generate() from that panel will use whatever connection was captured before, if any.');
        log.error(LogClass.SENSITIVE, 'X-ST-Connection parse error:', error);
        return undefined;
    }
}

/**
 * Middleware for every plugin router: capture the connection a panel request carries.
 *
 * Mounted in front of each plugin's router by `plugin-loader.js`, beside `resolvePanelIdentity`, so it runs
 * before any plugin handler — which is what lets a handler call `context.generate()` on the first click after a
 * restart. A request without the header (the status poll, anything not sent by the panel host) changes nothing.
 *
 * ⚠️ `setHeaders` IS INJECTED, for the reason given on the `connections` map: importing
 * `additional-headers.js` here would kill the unit suite at load.
 * @param {HeaderResolver} setHeaders `setAdditionalHeadersByType`, for authenticating the later send
 * @param {SecretReader} [readSecret] `readSecret` from `endpoints/secrets.js`, for a chat connection's key (API 8)
 * @returns {import('express').RequestHandler} The middleware
 */
export function panelConnectionCapture(setHeaders, readSecret) {
    return (request, _response, next) => {
        const handle = request.user?.profile?.handle;
        const connection = readConnectionHeader(request);

        // 🔴 NOT WHILE THE USER'S STORAGE IS LOCKED. `storage.lock()` calls `clearConnectionFor` because the
        // envelope carries the character and persona names as plaintext (see that function). A panel request
        // arriving after the lock would put them straight back — the retention the clear exists to end.
        if (connection && typeof handle === 'string' && handle !== '' && !storage.isReady(handle)) {
            log.debug(LogClass.NORMAL, 'context.generate: a plugin panel request carried a connection while its user\'s storage is locked; not captured.');
        } else if (connection && typeof handle === 'string' && handle !== '') {
            const previous = connections.get(handle);

            if (connection.family === 'chat') {
                // A panel carries no `custom_include_headers` / `custom_include_body`: those live in the client's
                // settings and a panel request is not a generation. A replay from a panel therefore goes without
                // them, which is the ordinary case for a custom endpoint.
                const resolved = resolveOpenAiWireChatSource(connection.api_type, { customUrl: connection.custom_url, reverseProxy: connection.reverse_proxy });
                captureConnection(handle, {
                    family: 'chat',
                    api_type: connection.api_type,
                    // A source off the OpenAI wire is captured with a placeholder so `generate()` refuses it BY
                    // NAME rather than reporting "no active backend", which would send the user looking elsewhere.
                    api_server: resolved?.apiUrl || 'unsupported:',
                    model: connection.model,
                    directories: request.user?.directories,
                    secretId: null,
                    secretKey: resolved?.secretKey ?? '',
                    keyRequired: resolved?.keyRequired ?? false,
                    readSecret,
                    extraHeaders: resolved?.headers ?? {},
                });
            } else {
                captureConnection(handle, {
                    ...connection,
                    envelope: readInstructEnvelope(request),
                    directories: request.user?.directories,
                    // A panel is not a connection profile, so it names no secret — the same as an ordinary
                    // generation, whose body carries no `secret_id` either.
                    secretId: null,
                    setHeaders,
                });
            }

            // Only a change is logged: the panel host sends this on every open and every action, and a line
            // per click saying nothing new would bury the one that matters.
            const now = connections.get(handle);
            if (now && (!previous || previous.family !== now.family || previous.api_type !== now.api_type || previous.api_server !== now.api_server || previous.model !== now.model)) {
                log.info(LogClass.NORMAL, `context.generate: captured a ${now.family} '${now.api_type}' connection from a plugin panel request (${previous ? 'replacing a different one' : 'none was captured before'}).`);
            }
        }

        next();
    };
}

/**
 * Resolve the completions URL for a text-generation backend.
 *
 * Factored out of the `/generate` route (`endpoints/backends/text-completions.js`) so the route and
 * `generate()` agree on it exactly — the same extraction that lets a plugin reach this backend without a
 * request of its own. The default returns the trimmed base unchanged, preserving the route's original
 * behaviour for an api_type it does not recognise.
 * @param {string} apiType
 * @param {string} baseUrl
 * @returns {string} the full URL
 */
export function resolveTextCompletionsUrl(apiType, baseUrl) {
    const url = trimV1(baseUrl);

    switch (apiType) {
        case TEXTGEN_TYPES.GENERIC:
        case TEXTGEN_TYPES.VLLM:
        case TEXTGEN_TYPES.FEATHERLESS:
        case TEXTGEN_TYPES.APHRODITE:
        case TEXTGEN_TYPES.OOBA:
        case TEXTGEN_TYPES.TABBY:
        case TEXTGEN_TYPES.KOBOLDCPP:
        case TEXTGEN_TYPES.TOGETHERAI:
        case TEXTGEN_TYPES.INFERMATICAI:
        case TEXTGEN_TYPES.HUGGINGFACE:
            return url + '/v1/completions';
        case TEXTGEN_TYPES.DREAMGEN:
            return url + '/api/openai/v1/completions';
        case TEXTGEN_TYPES.MANCER:
            return url + '/oai/v1/completions';
        case TEXTGEN_TYPES.LLAMACPP:
            return url + '/completion';
        case TEXTGEN_TYPES.OLLAMA:
            return url + '/api/generate';
        case TEXTGEN_TYPES.OPENROUTER:
            return url + '/v1/chat/completions';
        default:
            return url;
    }
}

/**
 * What each backend will actually accept in a completions body.
 *
 * 🔴 THE ROUTE HAS ALWAYS DONE THIS AND THE PLUGIN PATH NEVER DID, WHICH IS WHY A PLUGIN COULD 400 A BACKEND
 * THE UI TALKS TO FINE. These are the same lists `/generate` filters against; the map exists so there is ONE
 * place that decides what a backend takes, imported by both, rather than two copies that drift. A backend with
 * no entry here is sent its body unfiltered — which is the route's behaviour too, and is correct for the
 * llama.cpp-descended ones (KoboldCpp, Ooba, Tabby, Aphrodite) that accept sampler fields no OpenAI schema lists.
 *
 * ⚠️ AN ALLOWLIST DROPS SILENTLY, AND THAT IS THE POINT. `grammar` and `rep_pen` are real capabilities on
 * KoboldCpp and meaningless on Featherless; a plugin cannot see which backend is behind `context.generate` and
 * must not have to. Dropping the field it cannot honour is the behaviour the plugin API's `grammar` capability
 * has always PROMISED ("a backend that does not understand grammar ignores it") and, until this map, did not
 * deliver — the field went to the wire and the backend rejected the whole request.
 * @type {Record<string, string[]>}
 */
const BODY_ALLOWLISTS = {
    [TEXTGEN_TYPES.TOGETHERAI]: TOGETHERAI_KEYS,
    [TEXTGEN_TYPES.INFERMATICAI]: INFERMATICAI_KEYS,
    [TEXTGEN_TYPES.FEATHERLESS]: FEATHERLESS_KEYS,
    [TEXTGEN_TYPES.GENERIC]: OPENAI_KEYS,
    [TEXTGEN_TYPES.VLLM]: VLLM_KEYS,
    [TEXTGEN_TYPES.OPENROUTER]: OPENROUTER_KEYS,
};

/**
 * Drop every body field the named backend does not accept.
 *
 * Shared by the `/generate` route and by `generate()` so the two cannot disagree about what a backend takes —
 * the same reason `resolveTextCompletionsUrl` lives here. Returns a NEW object; the caller's is untouched.
 * @param {string} apiType The backend's `api_type`
 * @param {object} body The completions body
 * @returns {object} the body with unsupported fields removed, or the same body for an unlisted backend
 */
export function filterBodyForBackend(apiType, body) {
    const allowed = BODY_ALLOWLISTS[apiType];
    if (!allowed || !body || typeof body !== 'object') {
        return body;
    }

    return Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
}

/**
 * The backends `generate()` can drive today: the OpenAI-completions family, whose response is
 * `{ choices: [{ text }] }`. The others reachable by the route — Ollama's `/api/generate`, llama.cpp's
 * `/completion`, OpenRouter's chat shape — take a different request and return a different response, so
 * `generate` refuses them loudly rather than send something malformed. Widening this is a follow-up.
 * @type {Set<string>}
 */
const COMPLETIONS_FAMILY = new Set([
    TEXTGEN_TYPES.GENERIC,
    TEXTGEN_TYPES.VLLM,
    TEXTGEN_TYPES.FEATHERLESS,
    TEXTGEN_TYPES.APHRODITE,
    TEXTGEN_TYPES.OOBA,
    TEXTGEN_TYPES.TABBY,
    TEXTGEN_TYPES.KOBOLDCPP,
    TEXTGEN_TYPES.TOGETHERAI,
    TEXTGEN_TYPES.INFERMATICAI,
    TEXTGEN_TYPES.HUGGINGFACE,
    TEXTGEN_TYPES.DREAMGEN,
    TEXTGEN_TYPES.MANCER,
]);

/** Completions cannot take an unbounded output; default when the caller names none. */
const DEFAULT_MAX_TOKENS = 512;

/**
 * Fold one SSE frame's JSON payload into the running accumulation.
 *
 * 🔴 `text` ONLY, AND `reasoning` IS DROPPED ON THE FLOOR. A reasoning model's chunks carry two channels —
 * `choices[0].text` and `choices[0].reasoning` — and only the first is the answer. The second is model-generated
 * prose ABOUT THE USER'S CONVERSATION, and a plugin that received it would be receiving chat content the fork
 * never agreed to hand out; one `console.error` in third-party plugin code then writes a chain of thought about
 * a private conversation into `st.log`. Same reasoning as the error-body rule further down, different channel.
 * `thinking` and `reasoning_content` are the same thing under other backends' names, and are equally ignored —
 * this reads the one field it wants rather than excluding the ones it knows about, so a backend inventing a
 * third name for it cannot leak by default.
 *
 * ⚠️ THE LAST NON-NULL `finish_reason` WINS. Backends differ about which frame carries it: some put it on the
 * final content frame, some on a trailing content-free one, and OpenAI-compatible frames legitimately carry
 * `finish_reason: null` throughout. Overwriting on null would erase the answer.
 * @param {object} payload One parsed `data:` frame
 * @param {{text: string, finishReason: string|undefined, sawText: boolean}} acc Mutated in place
 * @returns {void}
 */
function foldChunk(payload, acc) {
    const choice = payload?.choices?.[0];
    if (!choice) {
        return;
    }

    // ⚠️ `sawText` IS TRACKED SEPARATELY FROM `text` BEING NON-EMPTY, and the two are genuinely different
    // facts. A model that answered with the empty string and a backend that never sent a `text` field at all
    // look identical in the accumulator and must not: the first is an answer, the second is a broken reply,
    // and the second is the one this file promises to throw on rather than return quietly.
    // Three shapes, one answer channel each: a completions frame carries `text`; a streamed chat frame (API 8)
    // carries `delta.content`; a chat backend that ignored `stream: true` answers with `message.content`.
    // Still never `reasoning` / `reasoning_content` under any of them, for the reason in the docblock.
    const text = typeof choice.text === 'string' ? choice.text
        : typeof choice.delta?.content === 'string' ? choice.delta.content
            : typeof choice.message?.content === 'string' ? choice.message.content
                : undefined;
    if (typeof text === 'string') {
        acc.sawText = true;
        acc.text += text;
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        acc.finishReason = choice.finish_reason;
    }
}

/**
 * Read an SSE completions stream to its end and return what the model actually said.
 *
 * 🔴 FRAMES SPLIT ACROSS TCP CHUNKS, AND THE NAIVE VERSION OF THIS LOSES TEXT SILENTLY. A `data:` line is not
 * guaranteed to arrive whole — a long chunk routinely straddles two reads — so the buffer is drained only up to
 * the last complete `\n\n` boundary and the remainder is carried forward. Parsing each read in isolation drops
 * exactly the frames that were big enough to matter, and drops them as a shorter answer rather than as an error.
 *
 * ⚠️ A BACKEND THAT IGNORES `stream: true` IS HANDLED, NOT ASSUMED AWAY. Nothing forces a backend to honour the
 * flag, and one that answers with a plain completions object would otherwise yield an empty string here — the
 * silent-empty failure this file exists to refuse. If no frame ever parsed, the whole body is tried as JSON.
 * @param {import('node-fetch').Response} reply The streaming response, status already checked
 * @param {string} apiType For error messages — configuration, never user content
 * @returns {Promise<{text: string, finishReason: string|undefined}>} the accumulated completion
 */
async function readCompletionStream(reply, apiType) {
    if (!reply.body) {
        throw new Error(`context.generate: backend '${apiType}' returned no response body.`);
    }

    const acc = { text: '', finishReason: undefined, sawText: false };
    let buffer = '';
    let raw = '';
    let sawFrame = false;
    let errored = false;

    /**
     * Fold every `data:` line of one complete frame.
     * @param {string} frame One SSE frame, without its trailing blank line
     * @returns {void}
     */
    const readFrame = (frame) => {
        for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) {
                continue;
            }

            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') {
                continue;
            }

            let payload;
            try {
                payload = JSON.parse(data);
            } catch {
                // A frame we cannot parse is not fatal on its own — a keep-alive comment or a backend's
                // own dialect. Losing the whole pass over one is worse than reading the rest.
                continue;
            }

            sawFrame = true;

            // 🔴 AN ERROR CAN ARRIVE AFTER A 200, AND ITS BODY CAN ECHO THE PROMPT. Featherless's
            // no_response error is exactly this shape. The status check above cannot catch it, because
            // the headers were fine; only the stream says so. The body goes to SENSITIVE for the same
            // reason the non-OK path does — an OpenAI-compatible error commonly quotes the request.
            if (payload?.error) {
                errored = true;
                continue;
            }

            foldChunk(payload, acc);
        }
    };

    // 🔴 A `StringDecoder`, NEVER `chunk.toString('utf8')`. A TCP chunk boundary falls wherever the network
    // put it, which is routinely in the MIDDLE of a multi-byte character — and `toString` on a buffer ending
    // mid-sequence yields U+FFFD, then the next chunk opens with orphaned continuation bytes and yields more.
    // The character is destroyed in both directions and nothing reports it. This is invisible in English and
    // certain in anything else: an accent, a dash the model likes, an emoji, any CJK. The failure surfaces as
    // a memory with replacement characters in it, blamed on the model. `StringDecoder` holds the incomplete
    // sequence back until its remaining bytes arrive.
    const decoder = new StringDecoder('utf8');

    for await (const chunk of reply.body) {
        const piece = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        raw += piece;
        buffer += piece;

        // ⚠️ `\r\n\r\n` TOO. SSE's separator is a blank line, and a blank line is CRLFCRLF on any backend
        // fronted by a proxy that normalises line endings. Splitting on `\n\n` alone leaves those frames
        // stuck in the buffer for ever, which reads as a model that said nothing.
        const frames = buffer.replace(/\r\n/g, '\n').split('\n\n');
        buffer = frames.pop() ?? '';

        frames.forEach(readFrame);
    }

    // ⚠️ `end()` FLUSHES WHATEVER THE DECODER IS STILL HOLDING. A stream truncated mid-character leaves bytes
    // in it; without this they vanish silently, which is the same class of loss as dropping the last frame.
    const tail = decoder.end();
    raw += tail;
    buffer += tail;

    // 🔴 THE LAST FRAME NEED NOT HAVE A BLANK LINE AFTER IT. Nothing obliges a backend to write the trailing
    // separator before closing the connection — end-of-stream terminates the final frame just as well — and
    // draining only on `\n\n` silently discards it. That frame is the one carrying `finish_reason`, so the
    // loss shows up as a truncated answer with no explanation rather than as an error.
    if (buffer.trim()) {
        readFrame(buffer.replace(/\r\n/g, '\n'));
    }

    if (errored && !acc.text) {
        log.error(LogClass.NORMAL, `context.generate: backend '${apiType}' opened a stream and then reported an error in it. Automatic features that generate (memory ingest, summarisation) cannot run against this backend until it is fixed.`);
        log.error(LogClass.SENSITIVE, 'The backend\'s streamed error follows. It may echo the prompt, which is why it is on this channel:', raw);

        throw new Error(`context.generate: backend '${apiType}' reported an error inside a streamed response. The backend's message is not repeated here because it can echo the prompt; enable debug logging to see it.`);
    }

    if (!sawFrame) {
        // 🔴 A STREAM THAT CARRIED NOTHING IS A DROPPED STREAM, AND IT GETS ITS OWN SENTENCE. Measured on
        // Featherless at ROUGHLY ONE RUN IN THREE: three `: FEATHERLESS PROCESSING` keepalive comments and
        // then a closed connection — no data frames, no `finish_reason`, no `usage`. That is TRANSPORT
        // failing, not a model declining to answer, and the two want opposite handling: a dropped stream is
        // worth retrying on the next tick, while an answer of "" is not and burns a caller's attempt. So this
        // throws rather than returning the empty string it accumulated, which keeps the promise this file's
        // docblock has always made — "a reply with no text throws" — through the move to streaming.
        //
        // ⚠️ AN SSE COMMENT IS A LINE STARTING `:` AND IS THE NORMAL KEEPALIVE, so its presence is evidence
        // the stream really opened rather than evidence of a malformed body. Naming the two cases apart
        // matters downstream: Mnemosyne's `diagnose.js` turns these sentences into operator-facing text, and
        // "the backend dropped the stream" and "the backend sent something that is not a completion" call for
        // different actions.
        const looksLikeStream = raw.trim() === '' || raw.split('\n').every(line => line.trim() === '' || line.startsWith(':'));

        if (looksLikeStream) {
            throw new Error(`context.generate: backend '${apiType}' opened a stream and closed it without sending any completion data. This is usually transient — retry.`);
        }

        // The backend ignored `stream: true` and answered in one piece. Read it the old way rather than
        // report an empty completion, which is the one outcome this file promises never to produce quietly.
        try {
            foldChunk(JSON.parse(raw), acc);
        } catch {
            throw new Error(`context.generate: backend '${apiType}' returned a response that was neither a completions stream nor a completions object.`);
        }
    }

    // 🔴 "NO TEXT" IS ONLY A FAILURE WHEN THE BACKEND ALSO NEVER SAID WHY IT STOPPED. A reply carrying neither
    // is a broken reply and throws, exactly as the non-streaming version did. But `finish_reason: 'length'`
    // with nothing before it is a COMPLETE ANSWER to "what happened" — the model spent the whole budget on a
    // chain of thought and never reached the text — and throwing there would hand the caller a bare retry
    // signal for a condition that retrying cannot fix. It would re-run the identical call, under the identical
    // ceiling, for ever. That distinction is the entire reason `finishReason` is returned at all.
    if (!acc.sawText && !acc.finishReason) {
        throw new Error(`context.generate: backend '${apiType}' returned no completion text.`);
    }

    return { text: acc.text, finishReason: acc.finishReason };
}

/**
 * Run one completion for a plugin, against the backend the given user is talking to.
 *
 * 🔴 FAIL LOUD, NEVER HANG, NEVER RETURN A SILENT EMPTY STRING. No captured connection, an unsupported backend,
 * a non-OK response, a reply with no text — every one throws. The caller (a memory ingest pass) treats any
 * throw as "retry next tick"; an empty string returned quietly would read as a model with nothing to say and
 * poison the store with nothing.
 *
 * ⚠️ AN EMPTY `text` WITH A `finishReason` IS NOT THAT FAILURE, AND IS THE REASON `finishReason` EXISTS. On a
 * reasoning model the chain of thought is billed against `max_tokens` and then discarded here, so a ceiling
 * that is generous for the answer is easily short of the answer's cost: measured on DeepSeek-V4-Pro, a 519-char
 * window took 1487 completion tokens to reach a 484-char answer. Under a 1000-token ceiling the identical call
 * comes back empty with `finish_reason: length` — indistinguishable, from `{text}` alone, from a model with
 * nothing to say. A plugin that cannot tell those apart records the empty answer, leaves its high-water mark
 * where it was, and re-extracts the same window for ever.
 *
 * @param {{handle: string, prompt: string, maxTokens?: number, temperature?: number, stop?: string[], wrap?: boolean, grammar?: string, repPen?: number}} params
 * @returns {Promise<{text: string, finishReason?: string}>} the completion text, and why the model stopped
 */
export async function generate(params) {
    const { handle, prompt, maxTokens, temperature, stop, wrap, grammar, repPen } = params ?? {};

    if (typeof handle !== 'string' || !handle) {
        throw new Error('context.generate: a user handle is required.');
    }
    if (typeof prompt !== 'string' || !prompt) {
        throw new Error('context.generate: a non-empty prompt is required.');
    }

    const connection = connections.get(handle);
    if (!connection) {
        // ⚠️ "no active backend captured" is load-bearing: Mnemosyne's `diagnose.js` matches on it.
        throw new Error(`context.generate: no active backend captured for '${handle}'. generate runs only after that user has generated at least once, or opened a plugin panel.`);
    }

    // API 8: a captured Chat Completion connection takes the chat path. Everything below is text completions.
    if (connection.family === 'chat') {
        return await generateOverChat(connection, { prompt, maxTokens, temperature, stop });
    }

    if (!COMPLETIONS_FAMILY.has(connection.api_type)) {
        throw new Error(`context.generate: backend '${connection.api_type}' is not supported yet — only the OpenAI-completions family. This is a follow-up.`);
    }

    const url = resolveTextCompletionsUrl(connection.api_type, connection.api_server);

    // 🔴 REFUSE RATHER THAN SEND IT BARE. A plugin asking to be wrapped and silently not being wrapped is the
    // §6.5 failure mode exactly: on an instruct-tuned model an unframed instruction gets CONTINUED as prose
    // rather than followed, so the plugin gets fluent nonsense back and nothing anywhere says why.
    //
    // 🔴 AND AN ENVELOPE THAT FRAMES NOTHING IS NOT AN ENVELOPE. `getSingleTurnInstructEnvelope` returns
    // `{prefix: "", suffix: "", stop: []}` when instruct mode is off, and that is a well-formed envelope, so
    // `readInstructEnvelope` stores it and this guard's `!connection.envelope` never fired — an object is
    // truthy. `"" + prompt + ""` then sent the prompt BARE, which is the exact thing the paragraph above
    // refuses, arriving through the one shape the test did not cover. It is the DEFAULT state of a fresh
    // profile (instruct disabled), so the common case was the broken one: the plugin got prose continuation
    // back and reported "the extractor returned output that could not be parsed", advising a stronger model,
    // because from inside the plugin that is precisely what it looks like.
    //
    // ⚠️ PREFIX AND SUFFIX DECIDE IT, NEVER `stop`. A template may legitimately frame with no stop sequences;
    // framing is what this guard is about. And `readInstructEnvelope` is deliberately unchanged — an empty
    // envelope and a missing header are different facts and must stay distinguishable on the wire. The bug
    // was only ever that this line did not act on the distinction.
    const framed = connection.envelope
        && (connection.envelope.prefix !== '' || connection.envelope.suffix !== '');
    if (wrap && !framed) {
        throw new Error(`context.generate: wrap was requested but no instruct envelope was captured for '${handle}'. The client that generated last is older than this capability, or sent an unreadable one — the prompt has NOT been sent unwrapped.`);
    }

    const envelope = wrap ? connection.envelope : undefined;

    const body = {
        prompt: envelope ? envelope.prefix + prompt + envelope.suffix : prompt,
        stream: true,
        max_tokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS,
    };
    if (Number.isFinite(temperature)) {
        body.temperature = temperature;
    }

    // Constrained decoding (§ plugin API v3). A GBNF string the backend's grammar sampler enforces token by
    // token, so on a backend that honours it malformed output is impossible by construction rather than
    // parsed-and-hoped-for. KoboldCpp reads it on the completions endpoint. `repPen` maps to the KoboldAI
    // `rep_pen` sampler — a grammar with no natural stop can otherwise let a low-temperature model loop.
    //
    // ⚠️ SET UNCONDITIONALLY HERE, AND FILTERED BELOW. The old comment claimed "a backend that does not
    // understand `grammar` ignores it", and that was never true of an OpenAI-compatible backend: Featherless
    // rejects the whole request. `filterBodyForBackend` is what finally makes the claim hold, by removing the
    // field before the wire for every backend whose schema does not list it.
    if (typeof grammar === 'string' && grammar) {
        body.grammar = grammar;
    }
    if (Number.isFinite(repPen)) {
        body.rep_pen = repPen;
        body.rep_pen_range = 512;
    }

    // ⚠️ THE ENVELOPE'S TERMINATORS GO FIRST, AND THE CAP IS 4. The route caps stops at 4 for the completions
    // family and this mirrors it rather than quietly raising it. A plugin that passes 4 stops of its own
    // therefore loses some of them -- but never the terminator, because a wrapped prompt without its
    // terminator runs on past the answer, which is a worse failure than a missing stop of the plugin's own.
    const stops = [...(envelope?.stop ?? []), ...(Array.isArray(stop) ? stop : [])];
    if (stops.length) {
        body.stop = stops.slice(0, 4);
    }
    if (connection.model) {
        body.model = connection.model;
    }

    // 🔴 FILTER BEFORE SENDING, EXACTLY AS THE ROUTE DOES. `grammar`, `rep_pen` and `rep_pen_range` are set
    // above because a plugin asked for them and cannot see which backend is behind this call; several backends
    // in COMPLETIONS_FAMILY reject a body carrying a field their schema does not list, so an unfiltered send
    // turns an advisory sampler hint into a hard 400 for the whole pass.
    const wireBody = filterBodyForBackend(connection.api_type, body);

    // 🔴 AUTHENTICATE, THROUGH THE SAME FUNCTION THE ROUTE USES. Six backends in COMPLETIONS_FAMILY REQUIRE a
    // key (Featherless, TogetherAI, InfermaticAI, HuggingFace, Mancer, DreamGen) and the rest accept an optional
    // one; without this the request went out bare and came back 401, so `context.generate` worked ONLY against a
    // keyless local backend — which is what development used, which is why it survived to a live install.
    //
    // ⚠️ THE BY-TYPE RESOLVER, NOT `setAdditionalHeaders`. The latter wants an express request, and this path
    // has none by design — that is the entire premise of a captured connection. The by-type form takes the four
    // facts it actually needs, and `captureConnection` stored them for this.
    //
    // ⚠️ A CONNECTION CAPTURED WITHOUT A RESOLVER SENDS BARE, exactly as before. That is a keyless local
    // backend (the unit suite's fake, KoboldCpp on a LAN) and it is the one case where bare was always right.
    const headers = { 'Content-Type': 'application/json' };
    if (connection.setHeaders && connection.directories) {
        connection.setHeaders(headers, connection.api_type, connection.api_server, connection.directories, connection.secretId);
    }

    return await sendAndRead(connection, url, headers, wireBody);
}

/**
 * The chat-completions half of `generate()` (plugin API 8, the Mnemosyne change request of 2026-09-22).
 *
 * 🔴 ONE `user` TURN, NEVER `system`. The extraction prompt is self-framing, and a user turn is the shape every
 * OpenAI-wire source accepts; some upstreams behind a Custom URL reject a conversation with no user message
 * at all. `wrap` is satisfied WITHOUT an envelope here — the chat template IS the framing, and the text path's
 * "no instruct envelope was captured" refusal would be wrong by construction — so it is accepted and ignored.
 * `grammar` and `repPen` are dropped, exactly as `filterBodyForBackend` drops them for the OpenAI-schema text
 * backends.
 *
 * ⚠️ THE KEY IS READ AT SEND TIME, from the slot the route named at capture. A source that requires one and
 * has none throws before anything leaves the process, with the same "check that an API key is configured"
 * sentence the HTTP-401 path uses, because that is what the operator has to do about it.
 * @param {CapturedConnection} connection
 * @param {{prompt: string, maxTokens?: number, temperature?: number, stop?: string[]}} params
 * @returns {Promise<{text: string, finishReason?: string}>}
 */
async function generateOverChat(connection, { prompt, maxTokens, temperature, stop }) {
    if (!OPENAI_WIRE_CHAT_SOURCES.has(connection.api_type) || !/^https?:/.test(connection.api_server)) {
        // ⚠️ "is not supported yet" is load-bearing: Mnemosyne's `diagnose.js` matches on that fragment.
        throw new Error(`context.generate: chat completion source '${connection.api_type}' is not supported yet — only the OpenAI-wire sources (openai, custom, openrouter). This is a follow-up.`);
    }

    const url = `${connection.api_server}/chat/completions`;

    const body = {
        ...connection.extraBody,
        model: connection.model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        max_tokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS,
    };
    if (Number.isFinite(temperature)) {
        body.temperature = temperature;
    }
    // The same 4-stop cap as the text path; there is no envelope, so every slot is the plugin's own.
    if (Array.isArray(stop) && stop.length) {
        body.stop = stop.slice(0, 4);
    }

    const headers = { 'Content-Type': 'application/json', ...connection.extraHeaders };
    const apiKey = connection.readSecret && connection.directories && connection.secretKey
        ? connection.readSecret(connection.directories, connection.secretKey, connection.secretId)
        : '';
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (connection.keyRequired) {
        log.error(LogClass.NORMAL, `context.generate: chat completion source '${connection.api_type}' has no API key stored for this user. Automatic features that generate (memory ingest, summarisation) cannot run against it until one is configured.`);
        throw new Error(`context.generate: chat completion source '${connection.api_type}' has no API key configured. Check that an API key is configured for it.`);
    }

    return await sendAndRead(connection, url, headers, body);
}

/**
 * Send one completion request and read its answer — the half of `generate()` that text and chat share.
 * @param {CapturedConnection} connection For its `api_type`, which every message names
 * @param {string} url Where to POST
 * @param {Record<string, string>} headers Already authenticated
 * @param {object} wireBody Already filtered for the backend
 * @returns {Promise<{text: string, finishReason?: string}>}
 */
async function sendAndRead(connection, url, headers, wireBody) {
    // 🔴 A SIGNAL, BECAUSE node-fetch HAS NO DEFAULT TIMEOUT AND THIS DOCBLOCK PROMISES "NEVER HANG".
    //
    // Every other backend call in the codebase passes an AbortController from its own request; this one has
    // no request to hang off and got nothing in its place, so a wedged or half-open backend hung the plugin
    // call for ever. When the plugin is calling this from inside its own `onPrompt`, that composed into a
    // generation the user could never complete. Expiry is an error the plugin can see and retry, which is
    // the contract it already has for a refused connection.
    //
    // 🔴 AND IT STAYS ARMED UNTIL THE STREAM IS DRAINED, NOT UNTIL THE HEADERS LAND. On a streaming request
    // `fetch` resolves the moment the response headers arrive, which is the START of the work rather than the
    // end — a `clearTimeout` there disarms the guard before a single byte of the answer exists, and a backend
    // that opens a stream and then goes quiet hangs exactly as if there had never been a timeout. That is the
    // failure this controller was added to fix, and streaming would have quietly reintroduced it.
    const controller = new AbortController();
    const generateTimeoutMs = getPluginTimeoutMs('plugins.generateTimeoutMs', 300000);
    const timer = setTimeout(() => controller.abort(), generateTimeoutMs);
    timer.unref?.();

    /** @type {import('node-fetch').Response} */
    let reply;

    try {
        reply = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(wireBody),
            signal: controller.signal,
        });
    } catch (error) {
        clearTimeout(timer);

        if (controller.signal.aborted) {
            throw new Error(`context.generate: backend '${connection.api_type}' did not answer within ${generateTimeoutMs}ms.`);
        }

        throw error;
    }

    // 🔴 THE BACKEND'S RESPONSE BODY IS CHAT TEXT, AND IT MUST NOT RIDE OUT ON AN ERROR MESSAGE. An
    // OpenAI-compatible 400 commonly ECHOES THE REQUEST IT REJECTED — and the request `generate` sends is a
    // plugin's extraction prompt, which is the user's conversation. Interpolating it into the thrown message
    // handed that text to arbitrary third-party plugin code, where one `console.error(err.message)` writes a
    // chat transcript into `st.log` on a default install. That is exactly the leak DESIGN_LOG_HYGIENE.md exists
    // to prevent, arriving through the one channel the log classes cannot see.
    //
    // ⚠️ THE STATUS STAYS IN THE MESSAGE, IN THIS SHAPE. It is fork-authored, carries nothing of the user's,
    // and is the only part a caller can act on — Mnemosyne's `diagnose.js` reads it with `/returned (\d{3})\b/`
    // to turn a dead pass into a publishable sentence. The body goes to SENSITIVE, which a default install
    // suppresses and a debugging operator can switch on deliberately.
    if (!reply.ok) {
        clearTimeout(timer);
        const detail = await reply.text().catch(() => '');

        // ⚠️ NORMAL FIRST, AND IT NAMES api_type AND STATUS ONLY. Both are configuration, not user content
        // -- the same classification the route gives them -- and without this line the operator of a
        // permanently failing install gets a suppressed call site and nothing else (§5.3.1).
        log.error(LogClass.NORMAL, `context.generate: backend '${connection.api_type}' rejected a plugin's generation with HTTP ${reply.status}. Automatic features that generate (memory ingest, summarisation) cannot run against this backend until it is fixed. Check that an API key is configured for it.`);
        log.error(LogClass.SENSITIVE, 'The backend\'s response body follows. It may echo the prompt, which is why it is on this channel:', detail);

        throw new Error(`context.generate: backend '${connection.api_type}' returned ${reply.status}. The backend's response body is not repeated here because it can echo the prompt; enable debug logging to see it.`);
    }

    try {
        return await readCompletionStream(reply, connection.api_type);
    } catch (error) {
        // ⚠️ THE ABORT LANDS HERE NOW, NOT ON THE FETCH. A stream that opens and then stalls fails while its
        // body is being read, so the timeout's error surfaces from the read rather than from the request — and
        // it must still say the same thing, because that sentence is a plugin's only way to tell a wedged
        // backend from a broken one.
        if (controller.signal.aborted) {
            throw new Error(`context.generate: backend '${connection.api_type}' did not answer within ${generateTimeoutMs}ms.`);
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 🔑 Drop this user's captured connection.
 *
 * 🔴 THE ENVELOPE IS NOT A ROUTING FACT — IT CARRIES THE CHARACTER NAME AND THE PERSONA NAME. `prefix` and
 * `suffix` come from `getSingleTurnInstructEnvelope`, which runs `substituteParams` with the name overrides
 * and composes `${name}: ${mes}`, so both names sit in this map as literal text. Called beside
 * `notifications.clearFor` in `storage.lock()`, and for the identical reason it states there: the provider
 * has this instant made that content unreadable on disk, and a plaintext copy left in a live map puts it
 * back within reach of the very next request. Retention past the lock that was meant to end it.
 * @param {string} handle User handle
 * @returns {void}
 */
export function clearConnectionFor(handle) {
    connections.delete(handle);
}

/**
 * Forget every captured connection. Tests only.
 * @returns {void}
 */
export function _clearConnections() {
    connections.clear();
}

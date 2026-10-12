/**
 * Where an OpenAI-wire chat-completion source lives and how it is authenticated.
 *
 * 🔴 ONE RESOLUTION, TWO CALLERS, BECAUSE THE ROUTE ALREADY HAD TWO COPIES. `chat-completions.js` decided the
 * URL, the secret slot and the fixed headers for `openai` / `openrouter` / `custom` once in `/status` and again
 * in `/generate`, and the Mnemosyne change request of 2026-09-22 (plugin API 8) needed a THIRD copy so that
 * `context.generate()` can replay a captured chat connection. Three copies of "which key, which URL" drift;
 * this module is the one place, and the route and the plugin path both read it.
 *
 * ⚠️ NO SIDE-EFFECTING IMPORTS. `plugin-generate.js` is driven directly by the unit suite with no config path,
 * and `endpoints/secrets.js` exits the process at load without one (see the `connections` map there). So this
 * file names the secret SLOT (`api_key_custom`) and never reads it — the caller injects the reader, exactly as
 * `setAdditionalHeadersByType` is injected for text backends.
 */

import { CHAT_COMPLETION_SOURCES, OPENROUTER_HEADERS } from './constants.js';

const API_OPENAI = 'https://api.openai.com/v1';
const API_OPENROUTER = 'https://openrouter.ai/api/v1';

/**
 * The chat sources whose wire format is OpenAI's `/chat/completions` unchanged: `messages` in,
 * `choices[0].delta.content` (streamed) or `choices[0].message.content` out. Every other source in the route
 * converts to a vendor shape (Claude, Gemini, Cohere, Mistral, ...) and a plugin replay against those would be
 * malformed by construction, so `generate()` refuses them loudly instead.
 * @type {Set<string>}
 */
export const OPENAI_WIRE_CHAT_SOURCES = new Set([
    CHAT_COMPLETION_SOURCES.OPENAI,
    CHAT_COMPLETION_SOURCES.OPENROUTER,
    CHAT_COMPLETION_SOURCES.CUSTOM,
]);

/**
 * @typedef {object} ResolvedChatSource
 * @property {string} apiUrl Base URL; `/chat/completions` and `/models` are appended by the caller
 * @property {string} secretKey Which secret slot holds the key (`SECRET_KEYS.*` value), or '' for none
 * @property {boolean} keyRequired Whether a missing key is an error (Custom endpoints may be keyless)
 * @property {Record<string, string>} headers Fixed headers the source needs beyond Authorization
 */

/**
 * Resolve URL, secret slot and fixed headers for an OpenAI-wire chat source.
 *
 * ⚠️ A REVERSE PROXY IS RESOLVED TO ITS URL ONLY. The route sends `proxy_password` as the bearer token in that
 * case; that password arrives in the request body and is never stored, so a replay through a proxy is
 * `keyRequired: false` with an empty slot — bare, which is right for a proxy without a password and refused
 * by the proxy itself otherwise. A captured connection does not get to remember a password (§16.2).
 * @param {string} source `chat_completion_source`
 * @param {{customUrl?: string, reverseProxy?: string}} [options]
 * @returns {ResolvedChatSource|null} null when the source is not on the OpenAI wire
 */
export function resolveOpenAiWireChatSource(source, { customUrl = '', reverseProxy = '' } = {}) {
    switch (source) {
        case CHAT_COMPLETION_SOURCES.OPENAI:
            return {
                apiUrl: trimTrailingSlash(new URL(reverseProxy || API_OPENAI).toString()),
                secretKey: reverseProxy ? '' : 'api_key_openai',
                keyRequired: !reverseProxy,
                headers: {},
            };
        case CHAT_COMPLETION_SOURCES.OPENROUTER:
            return {
                apiUrl: API_OPENROUTER,
                secretKey: 'api_key_openrouter',
                keyRequired: true,
                headers: { ...OPENROUTER_HEADERS },
            };
        case CHAT_COMPLETION_SOURCES.CUSTOM:
            return {
                apiUrl: trimTrailingSlash(String(customUrl || '')),
                secretKey: 'api_key_custom',
                // The route sends a Custom request without a key when none is configured (a local server).
                keyRequired: false,
                headers: {},
            };
        default:
            return null;
    }
}

/**
 * `new URL(x).toString()` appends a slash to a bare origin, and the route then produces `//chat/completions`
 * on OpenAI proper. Strip it once here rather than at each join.
 * @param {string} url
 * @returns {string}
 */
function trimTrailingSlash(url) {
    return url.replace(/\/+$/, '');
}

import { describe, test, expect } from '@jest/globals';

import { OPENAI_WIRE_CHAT_SOURCES, resolveOpenAiWireChatSource } from '../src/chat-source.js';

/**
 * chat-source.js — the one place the OpenAI-wire chat sources are resolved (plugin API 8). The route's
 * `/status` and `/generate` and a plugin's `context.generate()` all read this, so what it says is what
 * every one of them does.
 */
describe('resolveOpenAiWireChatSource', () => {
    test('the three OpenAI-wire sources, and only those, are on the list', () => {
        expect([...OPENAI_WIRE_CHAT_SOURCES].sort()).toEqual(['custom', 'openai', 'openrouter']);
        expect(resolveOpenAiWireChatSource('claude')).toBeNull();
        expect(resolveOpenAiWireChatSource('makersuite')).toBeNull();
        expect(resolveOpenAiWireChatSource('')).toBeNull();
    });

    test('OpenAI: its own URL and key slot; a reverse proxy replaces the URL and drops the slot', () => {
        expect(resolveOpenAiWireChatSource('openai')).toEqual({
            apiUrl: 'https://api.openai.com/v1', secretKey: 'api_key_openai', keyRequired: true, headers: {},
        });
        // The proxy password arrives in the request body and is never a captured fact, so a proxied source
        // resolves to "no slot, key not required" — the replay goes bare and the proxy decides.
        expect(resolveOpenAiWireChatSource('openai', { reverseProxy: 'https://proxy.example/' })).toEqual({
            apiUrl: 'https://proxy.example', secretKey: '', keyRequired: false, headers: {},
        });
    });

    test('OpenRouter: fixed URL, its slot, and the Referer/X-Title headers it requires', () => {
        const resolved = resolveOpenAiWireChatSource('openrouter');

        expect(resolved.apiUrl).toBe('https://openrouter.ai/api/v1');
        expect(resolved.secretKey).toBe('api_key_openrouter');
        expect(resolved.keyRequired).toBe(true);
        expect(Object.keys(resolved.headers).length).toBeGreaterThan(0);
    });

    test('Custom: the user\'s URL with a trailing slash trimmed, its slot, and a key that is optional', () => {
        expect(resolveOpenAiWireChatSource('custom', { customUrl: 'https://api.featherless.ai/v1/' })).toEqual({
            apiUrl: 'https://api.featherless.ai/v1', secretKey: 'api_key_custom', keyRequired: false, headers: {},
        });
    });
});

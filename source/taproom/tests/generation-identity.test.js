import { describe, test, expect } from '@jest/globals';

import { readIdentityHeaders } from '../src/generation-interceptors.js';

/**
 * `readIdentityHeaders` decodes the character/chat identity a generation carries out-of-band.
 *
 * The end-to-end proof (that it reaches the interceptor and never the backend) lives in
 * `plugin-prompt-interceptor.test.js`. This covers the decode edge cases that a single happy-path request does
 * not exercise: absence, emptiness, and a malformed escape that must not take a generation down.
 */
describe('readIdentityHeaders — decoding the out-of-band identity', () => {
    /** @param {Record<string,string>} headers @returns {any} a stand-in for an Express request */
    const fakeRequest = (headers) => ({ get: (name) => headers[name] });

    test('decodes URL-encoded character and chat identity (incl. non-ASCII)', () => {
        const request = fakeRequest({
            'X-ST-Char-Name': encodeURIComponent('Aria ✨'),
            'X-ST-Chat-Id': encodeURIComponent('chat 2026-07-17'),
        });

        expect(readIdentityHeaders(request)).toEqual({ charName: 'Aria ✨', chatId: 'chat 2026-07-17' });
    });

    test('absent headers become undefined, never empty string', () => {
        expect(readIdentityHeaders(fakeRequest({}))).toEqual({ charName: undefined, chatId: undefined });
    });

    test('an empty header is undefined', () => {
        const request = fakeRequest({ 'X-ST-Char-Name': '', 'X-ST-Chat-Id': '' });
        expect(readIdentityHeaders(request)).toEqual({ charName: undefined, chatId: undefined });
    });

    test('a malformed percent-encoding is taken raw rather than failing the generation', () => {
        const request = fakeRequest({ 'X-ST-Char-Name': '%E0%A4%A', 'X-ST-Chat-Id': 'ok' }); // truncated escape
        const out = readIdentityHeaders(request);

        expect(out.charName).toBe('%E0%A4%A');
        expect(out.chatId).toBe('ok');
    });
});

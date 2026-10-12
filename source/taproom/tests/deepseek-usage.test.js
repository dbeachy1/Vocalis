import crypto from 'node:crypto';

import { describe, test, expect } from '@jest/globals';

import {
    DeepSeekUsageObserver,
    MAX_INCOMPLETE_SSE_EVENT_BYTES,
    normalizeDeepSeekChatUsage,
} from '../src/deepseek-usage.js';

/**
 * 🔴 EVERY FIXTURE IN THIS FILE IS SYNTHETIC. No prompt, completion, reasoning, or authorization text is
 * ever constructed here — see Cache Lens raw generation rows design §12 and §15.1's own requirement that
 * no test log, fixture or snapshot contain any of that. The SSE bodies below carry only ids, token counts
 * and structural JSON; where a non-ASCII byte is needed to prove UTF-8 boundary safety, it's an emoji or an
 * accented letter in a throwaway `id` field, never anything resembling generated content.
 */

/**
 * Feed a `DeepSeekUsageObserver` a sequence of chunks and collect everything it forwards.
 * @param {DeepSeekUsageObserver} observer
 * @param {Buffer[]} chunks
 * @returns {Promise<Buffer>} Every forwarded byte, concatenated in order.
 */
function runObserver(observer, chunks) {
    return new Promise((resolve, reject) => {
        const forwarded = [];

        observer.on('data', (chunk) => forwarded.push(chunk));
        observer.on('end', () => resolve(Buffer.concat(forwarded)));
        observer.on('error', reject);

        for (const chunk of chunks) {
            observer.write(chunk);
        }
        observer.end();
    });
}

/** One SSE event: a `data:` line, terminated by the given blank-line style (default `"\n\n"`). */
function event(dataLine, terminator = '\n\n') {
    return `data: ${dataLine}${terminator}`;
}

describe('normalizeDeepSeekChatUsage — pure normalization, total and side-effect free', () => {
    test('primary Chat Completions cache fields normalize correctly', () => {
        const result = normalizeDeepSeekChatUsage({
            prompt_tokens: 1000,
            prompt_cache_hit_tokens: 800,
            prompt_cache_miss_tokens: 200,
            completion_tokens: 50,
            total_tokens: 1050,
        });

        expect(result).toEqual({
            usageState: 'available',
            usage: {
                schema: 'input-cache-v1',
                inputTokens: 1000,
                cachedTokens: 800,
                uncachedTokens: 200,
                provider: 'deepseek',
                api: 'chat-completions',
            },
        });
    });

    test('prompt_tokens_details.cached_tokens fallback normalizes correctly when the top-level hit count is absent', () => {
        const result = normalizeDeepSeekChatUsage({
            prompt_tokens: 1000,
            prompt_cache_miss_tokens: 200,
            prompt_tokens_details: { cached_tokens: 800 },
        });

        expect(result).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 1000, cachedTokens: 800, uncachedTokens: 200, provider: 'deepseek', api: 'chat-completions' },
        });
    });

    /**
     * DeepSeek may report cached tokens as a flat `cached_tokens` field instead of nested details.
     * A reported zero is available usage and must remain distinct from missing usage.
     */
    test('a flat cached_tokens is read, and a reported zero is a measurement rather than an absence', () => {
        const result = normalizeDeepSeekChatUsage(
            { prompt_tokens: 48, completion_tokens: 29, total_tokens: 77, cached_tokens: 0 },
            { provider: 'featherless', api: 'text-completions' },
        );

        expect(result).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 48, cachedTokens: 0, uncachedTokens: 48, provider: 'featherless', api: 'text-completions' },
        });
    });

    test('a plain OpenAI usage object with no cache field at all is still absent, never a zero', () => {
        const result = normalizeDeepSeekChatUsage({ prompt_tokens: 48, completion_tokens: 29, total_tokens: 77 });

        expect(result).toEqual({ usageState: 'absent' });
    });

    test('DeepSeek native spellings win over a flat cached_tokens when a provider sends both', () => {
        const result = normalizeDeepSeekChatUsage({
            prompt_tokens: 1000,
            prompt_cache_hit_tokens: 800,
            prompt_cache_miss_tokens: 200,
            cached_tokens: 7,
        });

        expect(result.usageState).toBe('available');
        expect(result.usage.cachedTokens).toBe(800);
    });

    test('a missing miss count derives uncachedTokens from inputTokens - cachedTokens', () => {
        const result = normalizeDeepSeekChatUsage({
            prompt_tokens: 100,
            prompt_cache_hit_tokens: 30,
            // prompt_cache_miss_tokens intentionally absent
        });

        expect(result).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 100, cachedTokens: 30, uncachedTokens: 70, provider: 'deepseek', api: 'chat-completions' },
        });
    });

    test('an inputTokens absent from prompt_tokens can be derived from hit + miss when both are valid', () => {
        const result = normalizeDeepSeekChatUsage({
            prompt_cache_hit_tokens: 300,
            prompt_cache_miss_tokens: 700,
            // prompt_tokens intentionally absent
        });

        expect(result).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 1000, cachedTokens: 300, uncachedTokens: 700, provider: 'deepseek', api: 'chat-completions' },
        });
    });

    test('missing all cache-accounting fields is absent, never a fabricated zero', () => {
        // Shaped exactly like a plain, non-cache-aware OpenAI usage object.
        const result = normalizeDeepSeekChatUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });

        expect(result).toEqual({ usageState: 'absent' });
        expect(result).not.toHaveProperty('usage');
    });

    test('an entirely missing usage object (undefined or null) is absent', () => {
        expect(normalizeDeepSeekChatUsage(undefined)).toEqual({ usageState: 'absent' });
        expect(normalizeDeepSeekChatUsage(null)).toEqual({ usageState: 'absent' });
    });

    describe('invalid: contradictory, negative, fractional, NaN-like, or over-input counts', () => {
        test('a negative count is invalid', () => {
            expect(normalizeDeepSeekChatUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: -5, prompt_cache_miss_tokens: 105 }))
                .toEqual({ usageState: 'invalid' });
        });

        test('a fractional count is invalid', () => {
            expect(normalizeDeepSeekChatUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 30.5, prompt_cache_miss_tokens: 69.5 }))
                .toEqual({ usageState: 'invalid' });
        });

        test('a NaN-like count is invalid', () => {
            expect(normalizeDeepSeekChatUsage({ prompt_tokens: NaN, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 }))
                .toEqual({ usageState: 'invalid' });
            expect(normalizeDeepSeekChatUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 'thirty', prompt_cache_miss_tokens: 70 }))
                .toEqual({ usageState: 'invalid' });
        });

        test('hit + miss that do not sum to the reported input is invalid (contradictory)', () => {
            expect(normalizeDeepSeekChatUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 100 }))
                .toEqual({ usageState: 'invalid' });
        });

        test('a cached count exceeding the reported input is invalid (over-input)', () => {
            expect(normalizeDeepSeekChatUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 5 }))
                .toEqual({ usageState: 'invalid' });
        });

        test('no partial measurement ever leaks out of an invalid result', () => {
            const result = normalizeDeepSeekChatUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 5 });
            expect(result).toEqual({ usageState: 'invalid' });
            expect(result).not.toHaveProperty('usage');
        });
    });
});

describe('DeepSeekUsageObserver — bounded SSE observation over a pass-through stream', () => {
    test('forwards bytes exactly, unchanged, including non-JSON and comment lines', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'fwd-1' });
        const input = Buffer.from(
            ': keepalive\n\n' +
            event('{"id":"c1","choices":[{"delta":{"content":"..."}}]}') +
            event('not json at all') +
            event('[DONE]'),
            'utf8',
        );

        const output = await runObserver(observer, [input]);

        expect(output.equals(input)).toBe(true);
    });

    test('forwards raw random bytes exactly, byte for byte, even though none of it parses as SSE', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'fwd-2' });
        const input = crypto.randomBytes(4096);

        const output = await runObserver(observer, [input]);

        expect(output.equals(input)).toBe(true);
    });

    test('recognizes a usage event whose JSON is split across arbitrary, one-byte-at-a-time chunks', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'split-1' });
        // A non-ASCII byte sequence in a throwaway field, to prove the boundary logic never corrupts a
        // chunk split that lands inside a multi-byte UTF-8 character.
        const payload = { id: 'café-🎉-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 } };
        const input = Buffer.from(event(JSON.stringify(payload)), 'utf8');

        // One byte per chunk — the most adversarial split possible.
        const chunks = Array.from({ length: input.length }, (_, i) => input.subarray(i, i + 1));

        const output = await runObserver(observer, chunks);

        expect(output.equals(input)).toBe(true);
        expect(observer.getResult()).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 1000, cachedTokens: 800, uncachedTokens: 200, provider: 'deepseek', api: 'chat-completions' },
        });
    });

    test('recognizes several SSE events delivered in a single chunk, keeping the latest valid usage', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'multi-1' });
        const first = event(JSON.stringify({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 } }));
        const second = event(JSON.stringify({ usage: { prompt_tokens: 500, prompt_cache_hit_tokens: 450, prompt_cache_miss_tokens: 50 } }));
        const input = Buffer.from(first + second, 'utf8');

        const output = await runObserver(observer, [input]);

        expect(output.equals(input)).toBe(true);
        expect(observer.getResult()).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 500, cachedTokens: 450, uncachedTokens: 50, provider: 'deepseek', api: 'chat-completions' },
        });
    });

    test('handles [DONE], CRLF blank lines, and an ordinary close', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'crlf-1' });
        const usageEvent = event(JSON.stringify({ usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300 } }), '\r\n\r\n');
        const doneEvent = event('[DONE]', '\r\n\r\n');
        const input = Buffer.from(usageEvent + doneEvent, 'utf8');

        const output = await runObserver(observer, [input]);

        expect(output.equals(input)).toBe(true);
        expect(observer.getResult()).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 1000, cachedTokens: 700, uncachedTokens: 300, provider: 'deepseek', api: 'chat-completions' },
        });
    });

    test('recognizes a usage event with no trailing blank line, closed by an ordinary stream end', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'no-trailing-blank' });
        // No "\n\n" at all — some producers close the socket right after the last data line.
        const input = Buffer.from(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } })}`, 'utf8');

        const output = await runObserver(observer, [input]);

        expect(output.equals(input)).toBe(true);
        expect(observer.getResult()).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 10, cachedTokens: 4, uncachedTokens: 6, provider: 'deepseek', api: 'chat-completions' },
        });
    });

    test('with no usage event ever observed, the result is absent', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'absent-1' });
        const input = Buffer.from(event('{"id":"c1","choices":[{"delta":{"content":"hi"}}]}') + event('[DONE]'), 'utf8');

        await runObserver(observer, [input]);

        expect(observer.getResult()).toEqual({ usageState: 'absent' });
    });

    test('a large incomplete event disables observation at the bound without interrupting forwarded output', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'overflow-1' });

        // One "data:" line that never gets its closing blank line, well past the bound, delivered in
        // several large chunks the way a real socket would.
        const chunkSize = 1024 * 1024; // 1 MiB
        const chunkCount = Math.ceil(MAX_INCOMPLETE_SSE_EVENT_BYTES / chunkSize) + 2; // guaranteed to exceed the bound
        const chunks = ['data: {"usage":{'];
        for (let i = 0; i < chunkCount; i++) {
            chunks.push(Buffer.alloc(chunkSize, 'x').toString('utf8'));
        }
        // A legitimate usage event AFTER the overflow — must NOT be recognized, because observation for
        // this request is permanently disabled once the bound is exceeded.
        chunks.push('"}}' + event(JSON.stringify({ usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 5 } })));

        const inputBuffers = chunks.map(c => Buffer.from(c, 'utf8'));
        const expectedTotal = Buffer.concat(inputBuffers);

        const output = await runObserver(observer, inputBuffers);

        // Forwarding is completely unaffected by the overflow.
        expect(output.equals(expectedTotal)).toBe(true);
        expect(observer.getResult()).toEqual({ usageState: 'invalid' });
    });

    test('getResult reports invalid when a usage object was seen but never validly, and no valid one followed', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'bad-usage-1' });
        // Contradictory: hit (900) exceeds the reported input (100).
        const input = Buffer.from(event(JSON.stringify({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 5 } })), 'utf8');

        await runObserver(observer, [input]);

        expect(observer.getResult()).toEqual({ usageState: 'invalid' });
    });

    test('a later invalid usage event never displaces an earlier valid one', async () => {
        const observer = new DeepSeekUsageObserver({ recordId: 'valid-then-invalid' });
        const good = event(JSON.stringify({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } }));
        const bad = event(JSON.stringify({ usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 5 } }));

        await runObserver(observer, [Buffer.from(good + bad, 'utf8')]);

        expect(observer.getResult()).toEqual({
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 100, cachedTokens: 60, uncachedTokens: 40, provider: 'deepseek', api: 'chat-completions' },
        });
    });
});

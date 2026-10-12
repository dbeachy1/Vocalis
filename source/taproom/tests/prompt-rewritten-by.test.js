import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    REWRITTEN_BY,
    REWRITE_SITES,
    clearPromptInterceptors,
    onPrompt,
    runPromptInterceptors,
} from '../src/generation-interceptors.js';

/**
 * 🔴 WHO ACTUALLY CHANGED THE PROMPT, WHICH IS NOT THE SAME AS WHO RAN.
 *
 * `prompt-record.js` reports the outgoing prompt back to the client, and the single most useful thing it can
 * say is whether what left the server is what the browser built. An empty `rewrittenBy` means the browser's
 * own copy is the truth for that generation — so a consumer can skip fetching a hundred kilobytes it already
 * has, and can trust the copy it is showing.
 *
 * That only holds if the list is honest. "An interceptor was registered" does not answer the question: a
 * plugin that declined, or returned the string unaltered, changed nothing. If those get named, the list
 * degrades into a roster of who was installed, every generation looks rewritten, and the optimisation and the
 * trust both evaporate.
 */
describe('REWRITTEN_BY — named only for actually changing it', () => {
    beforeEach(() => {
        clearPromptInterceptors();
    });

    test('nobody registered: the list is empty', async () => {
        const result = await runPromptInterceptors({ backend: 'text', prompt: 'untouched' });

        // The early-return path. It has no list to build, so the absence has to read as "nothing rewrote it"
        // rather than as a missing field.
        expect(result[REWRITTEN_BY] ?? []).toEqual([]);
    });

    test('a plugin that declines is not named', async () => {
        onPrompt('declines', async () => undefined);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'untouched' });

        expect(result.prompt).toBe('untouched');
        expect(result[REWRITTEN_BY]).toEqual([]);
    });

    test('a plugin that returns the prompt unchanged is not named', async () => {
        onPrompt('passthrough', async (outgoing) => outgoing.prompt);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'untouched' });

        // 🔴 THE CASE THAT MAKES THIS A VALUE COMPARISON AND NOT AN IDENTITY ONE. Returning the string you
        // were handed is the most natural way to write a no-op, and naming it as a rewrite would mean every
        // install with a well-behaved plugin reported every turn as modified.
        expect(result.prompt).toBe('untouched');
        expect(result[REWRITTEN_BY]).toEqual([]);
    });

    test('a plugin that changes the prompt is named', async () => {
        onPrompt('mnemosyne', async (outgoing) => `${outgoing.prompt}\n[recalled memory]`);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'base' });

        expect(result.prompt).toBe('base\n[recalled memory]');
        expect(result[REWRITTEN_BY]).toEqual(['mnemosyne']);
    });

    test('with several registered, only the ones that changed it appear, in order', async () => {
        onPrompt('quiet-one', async () => undefined);
        onPrompt('first-writer', async (outgoing) => `${outgoing.prompt} +A`);
        onPrompt('echo', async (outgoing) => outgoing.prompt);
        onPrompt('second-writer', async (outgoing) => `${outgoing.prompt} +B`);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'base' });

        expect(result.prompt).toBe('base +A +B');
        expect(result[REWRITTEN_BY]).toEqual(['first-writer', 'second-writer']);
    });

    test('on the chat path, an untouched message array is not a rewrite', async () => {
        onPrompt('copies-only', async (outgoing) => outgoing.messages.map(m => ({ ...m })));

        const messages = [{ role: 'system', content: 'you are helpful' }, { role: 'user', content: 'hi' }];
        const result = await runPromptInterceptors({ backend: 'chat', messages: messages });

        // A handler that copies the array and edits nothing is the shape the client-side interceptor API
        // teaches. Comparing by identity would call every one of those a rewrite.
        expect(result[REWRITTEN_BY]).toEqual([]);
    });

    test('on the chat path, an edited message array IS a rewrite', async () => {
        onPrompt('injector', async (outgoing) => [...outgoing.messages, { role: 'system', content: '[memory]' }]);

        const result = await runPromptInterceptors({
            backend: 'chat',
            messages: [{ role: 'user', content: 'hi' }],
        });

        expect(result.messages).toHaveLength(2);
        expect(result[REWRITTEN_BY]).toEqual(['injector']);
    });

    test('the marker is a symbol, so it cannot reach a request body or a plugin', async () => {
        onPrompt('writer', async (outgoing) => `${outgoing.prompt}!`);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'base' });

        // 🔴 THE REASON IT IS A SYMBOL. Every endpoint serialises `request.body` verbatim to the model, and
        // `OutgoingPrompt` is a documented shape plugin authors write against. A plain string key would read
        // as a new field of that contract and would survive a JSON round-trip into places it has no business
        // being; a symbol does neither.
        expect(Object.keys(result)).not.toContain('rewrittenBy');
        expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('rewrittenBy');
        expect(result[REWRITTEN_BY]).toEqual(['writer']);
    });
});

describe('REWRITE_SITES — where the change landed, not where it was configured to land', () => {
    beforeEach(() => {
        clearPromptInterceptors();
    });

    test('nothing rewrote it: no sites', async () => {
        onPrompt('declines', async () => undefined);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'untouched' });

        expect(result[REWRITE_SITES]).toEqual([]);
    });

    test('an append is reported at the end of the original prompt', async () => {
        onPrompt('appender', async (outgoing) => `${outgoing.prompt}[memory]`);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'BASE PROMPT' });

        expect(result[REWRITE_SITES]).toEqual([{ id: 'appender', atChar: 'BASE PROMPT'.length, delta: '[memory]'.length }]);
    });

    test('a prepend is reported at character zero — the case worth catching', async () => {
        onPrompt('prepender', async (outgoing) => `[memory]${outgoing.prompt}`);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'BASE PROMPT' });

        // 🔴 THIS IS WHY THE FIELD EXISTS. A plugin configured to write at depth 4 that instead lands at
        // char 0 has fallen back to prepending — the §27 degradation, which is silent and which costs
        // essentially all cache reuse. Its SETTING still says depth 4; only an observation can say 0.
        expect(result[REWRITE_SITES][0]).toEqual({ id: 'prepender', atChar: 0, delta: '[memory]'.length });
    });

    test('a splice in the middle reports the splice point', async () => {
        onPrompt('splicer', async (outgoing) => outgoing.prompt.replace('MIDDLE', 'MIDDLE[memory]'));

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'START MIDDLE END' });

        expect(result[REWRITE_SITES][0].atChar).toBe('START MIDDLE'.length);
        expect(result[REWRITE_SITES][0].delta).toBe('[memory]'.length);
    });

    test('removing text reports a negative delta', async () => {
        onPrompt('trimmer', async (outgoing) => outgoing.prompt.replace('REMOVE ME', ''));

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'KEEP REMOVE ME KEEP' });

        expect(result[REWRITE_SITES][0].delta).toBe(-'REMOVE ME'.length);
    });

    test('several writers each get their own site, in order', async () => {
        onPrompt('first', async (outgoing) => `[a]${outgoing.prompt}`);
        onPrompt('second', async (outgoing) => `${outgoing.prompt}[b]`);

        const result = await runPromptInterceptors({ backend: 'text', prompt: 'BASE' });

        expect(result[REWRITE_SITES].map(s => s.id)).toEqual(['first', 'second']);
        expect(result[REWRITE_SITES][0].atChar).toBe(0);
        // The second writer's offset is against the prompt AS IT STOOD after the first, which is the only
        // meaning that lets a consumer point at the final string it also receives.
        expect(result[REWRITE_SITES][1].atChar).toBe('[a]BASE'.length);
    });

    test('an offset never lands inside a surrogate pair', async () => {
        // An emoji in a persona is enough to hit this, and an offset splitting the pair would index into
        // half a code point — a slice at it renders as a replacement glyph.
        const base = 'persona 😀 tail';
        onPrompt('astral', async () => 'persona 😃 tail');

        const result = await runPromptInterceptors({ backend: 'text', prompt: base });
        const at = result[REWRITE_SITES][0].atChar;

        expect(base.codePointAt(at)).not.toBeUndefined();
        expect(base.charCodeAt(at)).not.toBeGreaterThanOrEqual(0xDC00);
    });
});

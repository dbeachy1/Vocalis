import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    PROMPT_HISTORY_DEPTH,
    clearRecords,
    finalizePromptRecord,
    getRecords,
    recordOutgoingPrompt,
} from '../src/prompt-record.js';

/**
 * 🔴 WHAT THIS MODULE IS FOR, AND THEREFORE WHAT THESE TESTS ARE PROTECTING.
 *
 * `generation-interceptors.js` lets a server plugin rewrite the prompt after the browser has already recorded
 * what it built. From that moment the browser's copy — `itemizedPrompts[].rawPrompt`, which is what the
 * prompt-itemization popup shows — is not what the model received, and nothing anywhere reports the
 * difference. A cache view reading that copy would report near-total reuse on a turn the backend reprocessed
 * from the splice point down: confidently wrong, and wrong precisely on the installs that have a memory
 * plugin, which are the ones where it matters.
 *
 * So the contract is narrow and worth stating: the last `PROMPT_HISTORY_DEPTH` prompts AS SENT, in memory,
 * never on disk, per user and backend, each saying who changed it. Every test below is one clause of that.
 */
describe('recordOutgoingPrompt — the last N, as sent', () => {
    beforeEach(() => {
        clearRecords();
    });

    test('records the prompt verbatim, with its length and hash', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'hello world' });

        expect(record.text).toBe('hello world');
        expect(record.length).toBe('hello world'.length);
        // A hash so a client can ask "is this the string I built?" without moving a hundred kilobytes.
        expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('the same text always hashes the same, and different text never does', () => {
        const a = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'identical' });
        const b = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'identical' });
        const c = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'different' });

        expect(b.hash).toBe(a.hash);
        expect(c.hash).not.toBe(a.hash);
    });

    test('keeps exactly PROMPT_HISTORY_DEPTH, dropping the oldest', () => {
        for (let i = 1; i <= PROMPT_HISTORY_DEPTH + 3; i++) {
            recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: `prompt ${i}` });
        }

        const records = getRecords('test-user', 'text');

        expect(records).toHaveLength(PROMPT_HISTORY_DEPTH);
        // Newest last, and the first three are gone rather than merely unreachable.
        //
        // ⚠️ DERIVED FROM THE CONSTANT, NOT WRITTEN OUT. These read `toBe('prompt 4')` and
        // `toBe('prompt 8')` when the depth was five, so raising it to ten turned a correct test red for
        // no reason but arithmetic — the behaviour under test never changed. A test that has to be
        // edited every time a tuning constant moves is a test that will eventually be edited wrongly.
        expect(records[0].text).toBe('prompt 4');
        expect(records[records.length - 1].text).toBe(`prompt ${PROMPT_HISTORY_DEPTH + 3}`);
    });

    test('seq keeps counting past the window, so a dropped record is visible as a gap', () => {
        for (let i = 1; i <= PROMPT_HISTORY_DEPTH + 2; i++) {
            recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: `prompt ${i}` });
        }

        const records = getRecords('test-user', 'text');

        // 🔴 THE SEQUENCE IS NOT AN ARRAY INDEX. A consumer holding seq 2 and finding the oldest record at
        // seq 3 knows its baseline was evicted; a per-window counter would have renumbered and told it
        // everything was fine.
        expect(records[0].seq).toBe(3);
        expect(records[records.length - 1].seq).toBe(PROMPT_HISTORY_DEPTH + 2);
    });

    test('prevSeq chains the records, and is null only for the very first', () => {
        const first = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'one' });
        const second = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'two' });

        expect(first.prevSeq).toBeNull();
        expect(second.prevSeq).toBe(first.seq);
    });

    test('carries the generation kind, so a consumer can tell a summarisation from a turn', () => {
        recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'a', genType: 'normal', chatId: 'chat-1' });
        const quiet = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'b', genType: 'quiet', chatId: 'chat-1' });

        // This is what stops "the previous message" being mistaken for "what is in the cache": a quiet
        // generation between two turns overwrote the backend's slot, and only genType reveals it.
        expect(quiet.genType).toBe('quiet');
        expect(quiet.prevSeq).toBe(1);
    });

    test('rewrittenBy is empty when nothing rewrote the prompt', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'untouched' });

        // Empty means the browser's own copy IS the truth for this generation, which is the common case and
        // the one a consumer can act on most cheaply.
        expect(record.rewrittenBy).toEqual([]);
    });

    test('rewrittenBy names the plugins it was given, and copies the array', () => {
        const caller = ['mnemosyne'];
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'spliced', rewrittenBy: caller });

        expect(record.rewrittenBy).toEqual(['mnemosyne']);

        // Copied, not aliased: a caller reusing its array must not retroactively edit a stored record.
        caller.push('something-else');
        expect(record.rewrittenBy).toEqual(['mnemosyne']);
    });
});

describe('the store is partitioned, because one user must never read another', () => {
    beforeEach(() => {
        clearRecords();
    });

    test('two users on one install never see each other', () => {
        recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'dougs private prompt' });
        recordOutgoingPrompt({ handle: 'claudetest', backend: 'text', prompt: 'other prompt' });

        expect(getRecords('test-user', 'text')).toHaveLength(1);
        expect(getRecords('test-user', 'text')[0].text).toBe('dougs private prompt');
        expect(getRecords('claudetest', 'text')[0].text).toBe('other prompt');
    });

    test('backends are counted separately, because they hold separate caches', () => {
        recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'to llama' });
        recordOutgoingPrompt({ handle: 'test-user', backend: 'kobold', prompt: 'to kobold' });

        // A sequence shared across backends would be meaningless: these are two machines' worth of state, and
        // "the request before this one" only means anything within one of them.
        expect(getRecords('test-user', 'text')).toHaveLength(1);
        expect(getRecords('test-user', 'kobold')).toHaveLength(1);
        expect(getRecords('test-user', 'text')[0].seq).toBe(1);
        expect(getRecords('test-user', 'kobold')[0].seq).toBe(1);
    });

    test('an unknown user reads nothing rather than reading somebody', () => {
        recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'private' });

        expect(getRecords('nobody', 'text')).toEqual([]);
        expect(getRecords(undefined, 'text')).toEqual([]);
    });

    test('clearing one user leaves the others alone', () => {
        recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'mine' });
        recordOutgoingPrompt({ handle: 'claudetest', backend: 'text', prompt: 'theirs' });

        clearRecords('test-user');

        expect(getRecords('test-user', 'text')).toEqual([]);
        expect(getRecords('claudetest', 'text')).toHaveLength(1);
    });

    test('getRecords hands back a copy, so a caller cannot edit the store', () => {
        recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: 'original' });

        const records = getRecords('test-user', 'text');
        records.push({ forged: true });

        expect(getRecords('test-user', 'text')).toHaveLength(1);
    });
});

describe('what it declines to record', () => {
    beforeEach(() => {
        clearRecords();
    });

    test('a non-string prompt records nothing instead of a record full of undefined', () => {
        // The chat path's prompt is an array of messages. A caller that has not serialised it has nothing to
        // record, and saying so is better than storing `length: undefined` for something to trip over later.
        expect(recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: undefined })).toBeNull();
        expect(recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: ['a', 'b'] })).toBeNull();
        expect(getRecords('test-user', 'chat')).toEqual([]);
    });

    test('an empty prompt IS recorded, because empty is a fact and not a failure', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'text', prompt: '' });

        expect(record).not.toBeNull();
        expect(record.length).toBe(0);
    });
});

/**
 * 🔴 WHAT `finalizePromptRecord` IS FOR, AND THEREFORE WHAT THESE TESTS PROTECT.
 *
 * Cache Lens raw generation rows design §6.2: a `PromptRecord` starts `pending` and this is the only way
 * it ever leaves that state. It is telemetry about a generation that has ALREADY happened — the provider
 * response is already on its way to (or already at) the browser by the time this is called — so every test
 * below is one clause of "this function may report, but it may never fail, alter, throw across, or corrupt
 * that response," plus the durable-identity contract raw Cache Lens rows depend on.
 */
describe('finalizePromptRecord — the only way a record leaves pending', () => {
    beforeEach(() => {
        clearRecords();
    });

    test('mints a unique recordId per record, and every new record starts pending', () => {
        const a = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'one' });
        const b = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'two' });

        expect(a.recordId).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/));
        expect(b.recordId).not.toBe(a.recordId);
        expect(a.status).toBe('pending');
        // Absent, not zero or null — see the PromptRecord typedef note on `completedAt`.
        expect(a.completedAt).toBeUndefined();
        expect(a.usageState).toBeUndefined();
    });

    test.each(['completed', 'failed', 'cancelled'])('transitions pending -> %s exactly once', (status) => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'x' });

        const result = finalizePromptRecord({
            handle: 'test-user', backend: 'chat', recordId: record.recordId,
            status, completedAt: 12345, usageState: 'absent',
        });

        expect(result).toEqual({ ok: true, reason: 'applied', recordId: record.recordId, seq: record.seq });

        const [stored] = getRecords('test-user', 'chat');
        expect(stored.status).toBe(status);
        expect(stored.completedAt).toBe(12345);
        expect(stored.usageState).toBe('absent');
        expect(stored.usage).toBeUndefined();
    });

    /**
     * 🔴 §11.1's "failed and cancelled carry no usage" is enforced HERE, not by the caller being careful.
     *
     * The DeepSeek helper passes a usage result on the completed path alone, so no current caller can
     * produce this record — which is a fact about today's call graph, not a property of the store. A
     * request that dies mid-stream may well have had a valid usage sighting before it died, and the next
     * provider adapter written against this API will reach for it. The result would be a record the design
     * forbids and the Cache Lens row model does not expect: a failed row that nonetheless draws a cache
     * ratio. Refusing the shape is what makes the invariant true rather than merely observed.
     */
    test.each(['failed', 'cancelled'])('a %s record carries no usage, even when the caller offers a valid one', (status) => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'x' });

        const result = finalizePromptRecord({
            handle: 'test-user', backend: 'chat', recordId: record.recordId,
            status,
            usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 100, cachedTokens: 60, uncachedTokens: 40, provider: 'deepseek', api: 'chat-completions' },
        });

        expect(result.ok).toBe(true);

        const [stored] = getRecords('test-user', 'chat');

        expect(stored.status).toBe(status);
        expect(stored.usage).toBeUndefined();
        // `absent` rather than `invalid`: the measurement was not contradictory, it is simply not something
        // this outcome is allowed to hold. Reporting it as invalid would accuse the provider of nonsense.
        expect(stored.usageState).toBe('absent');
    });

    test('stores a validated usage measurement on a completed record, copied rather than aliased', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'x' });
        const usage = { schema: 'input-cache-v1', inputTokens: 1000, cachedTokens: 800, uncachedTokens: 200, provider: 'deepseek', api: 'chat-completions' };

        finalizePromptRecord({
            handle: 'test-user', backend: 'chat', recordId: record.recordId,
            status: 'completed', completedAt: 999, usageState: 'available', usage,
        });

        const [stored] = getRecords('test-user', 'chat');
        expect(stored.usageState).toBe('available');
        expect(stored.usage).toEqual(usage);

        // 🔴 NEVER RETAINS A REFERENCE. Mutating the caller's object after the call must not reach the
        // stored record — finalizePromptRecord's invariant list requires a copy, not an alias.
        usage.inputTokens = 999999;
        expect(getRecords('test-user', 'chat')[0].usage.inputTokens).toBe(1000);
    });

    test('a completed status with a self-contradictory usage measurement is stored as invalid, never fabricated', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'x' });

        // cachedTokens (20) exceeds inputTokens (10) — the provider's own numbers cannot both be true.
        finalizePromptRecord({
            handle: 'test-user', backend: 'chat', recordId: record.recordId,
            status: 'completed', usageState: 'available', usage: { inputTokens: 10, cachedTokens: 20, uncachedTokens: 5 },
        });

        const [stored] = getRecords('test-user', 'chat');
        expect(stored.usageState).toBe('invalid');
        expect(stored.usage).toBeUndefined();
    });

    test('repeating the identical terminal update is idempotent: no change, no error', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'x' });
        const base = { handle: 'test-user', backend: 'chat', recordId: record.recordId, status: 'completed', usageState: 'absent' };

        const first = finalizePromptRecord({ ...base, completedAt: 1 });
        // A different completedAt on the retry: the identical-update invariant is about status/usage
        // agreeing, not about a race producing the exact same millisecond twice.
        const second = finalizePromptRecord({ ...base, completedAt: 2 });

        expect(first).toEqual({ ok: true, reason: 'applied', recordId: record.recordId, seq: record.seq });
        expect(second).toEqual({ ok: true, reason: 'idempotent', recordId: record.recordId, seq: record.seq });

        // The FIRST result survives untouched.
        expect(getRecords('test-user', 'chat')[0].completedAt).toBe(1);
    });

    test('a second, contradictory terminal update is rejected and logged; the first survives', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'x' });

        finalizePromptRecord({ handle: 'test-user', backend: 'chat', recordId: record.recordId, status: 'completed', completedAt: 1, usageState: 'absent' });
        const rejected = finalizePromptRecord({ handle: 'test-user', backend: 'chat', recordId: record.recordId, status: 'failed', completedAt: 2, usageState: 'absent' });

        expect(rejected).toEqual({ ok: false, reason: 'contradictory', recordId: record.recordId, seq: record.seq });

        const [stored] = getRecords('test-user', 'chat');
        expect(stored.status).toBe('completed');
        expect(stored.completedAt).toBe(1);
    });

    test('an unrecognized status is rejected rather than applied', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'x' });

        const result = finalizePromptRecord({ handle: 'test-user', backend: 'chat', recordId: record.recordId, status: 'bogus' });

        expect(result).toEqual({ ok: false, reason: 'invalid-status', recordId: record.recordId });
        expect(getRecords('test-user', 'chat')[0].status).toBe('pending');
    });

    test('finalizing an unknown recordId does not throw and does not fail the call', () => {
        expect(() => finalizePromptRecord({ handle: 'test-user', backend: 'chat', recordId: 'never-existed', status: 'completed' })).not.toThrow();

        const result = finalizePromptRecord({ handle: 'test-user', backend: 'chat', recordId: 'never-existed', status: 'completed' });
        expect(result).toEqual({ ok: false, reason: 'not-found', recordId: 'never-existed' });
    });

    test('finalizing an evicted record does not throw and does not resurrect it', () => {
        const evicted = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'evict-me' });

        for (let i = 0; i < PROMPT_HISTORY_DEPTH; i++) {
            recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: `filler ${i}` });
        }

        expect(getRecords('test-user', 'chat').some(r => r.recordId === evicted.recordId)).toBe(false);

        const result = finalizePromptRecord({ handle: 'test-user', backend: 'chat', recordId: evicted.recordId, status: 'completed' });
        expect(result).toEqual({ ok: false, reason: 'not-found', recordId: evicted.recordId });

        // Nothing was resurrected: the window still holds only the PROMPT_HISTORY_DEPTH filler records.
        expect(getRecords('test-user', 'chat')).toHaveLength(PROMPT_HISTORY_DEPTH);
    });

    test('a wrong handle or backend does not locate another user or backend\'s record', () => {
        const record = recordOutgoingPrompt({ handle: 'test-user', backend: 'chat', prompt: 'x' });

        expect(finalizePromptRecord({ handle: 'claudetest', backend: 'chat', recordId: record.recordId, status: 'completed' }))
            .toEqual({ ok: false, reason: 'not-found', recordId: record.recordId });
        expect(finalizePromptRecord({ handle: 'test-user', backend: 'text', recordId: record.recordId, status: 'completed' }))
            .toEqual({ ok: false, reason: 'not-found', recordId: record.recordId });

        expect(getRecords('test-user', 'chat')[0].status).toBe('pending');
    });
});

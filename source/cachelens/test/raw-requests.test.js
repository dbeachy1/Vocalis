import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * Raw-generation capture orchestration and the unified row model, DESIGN_RAW_GENERATION_ROWS.md §7.4, §8,
 * §9, §11.3, §15.3.
 *
 * ⚠️ ITS OWN FILE, for the reason `panel-record.test.js` and `persist-panel.test.js` both state: `probeRecord`
 * and `hasServerPlugins` memoise per module instance, and `captureRawRecords`'s own in-flight-promise /
 * rerun-flag state (`index.js`) is equally module-scoped. `node --test` gives each file its own module
 * registry, so this suite's serialization tests never race another file's in-flight capture, and this file's
 * repeated captures across tests never see another file's memoised probe answer.
 */
register(pathToFileURL('./test/loader.mjs'));

globalThis.SillyTavern = { libs: { sha256: text => `h(${text.length}:${text.slice(0, 12)})` } };

/** The backend family every test in this file uses — matches the stub's default `main_api`. */
const BACKEND = 'text';

/** Quiet records the backend route currently answers with. Mutated per test. @type {object[]} */
let currentRecords = [];

/** When true, the backend route's response is held open until `releaseRecordsFetch()` is called. */
let holdRecordsFetch = false;
/** @type {((value?: unknown) => void)|null} */
let releaseRecordsFetch = null;

/**
 * A reply, as the record client reads one — deliberately not a `Response`, the same rule `test/dom.js` and
 * `panel-record.test.js` state: `record.js` reads `ok`, `status`, `headers.get` and `json()`, so those are
 * what this answers.
 * @param {{ok: boolean, status: number, headers?: {get: () => string|null}, json: () => Promise<unknown>}} reply
 * @returns {Response} It, as `fetch` promises to return
 */
function asResponse(reply) {
    return /** @type {Response} */ (/** @type {unknown} */ (reply));
}

/**
 * @param {RequestInfo|URL} url What was asked for
 * @returns {Promise<Response>} The stubbed reply
 */
globalThis.fetch = async (url) => {
    const path = String(url);

    if (path === '/api/prompt-record/') {
        return asResponse({
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ supported: true, depth: 10, backends: ['text', 'chat', 'kobold', 'novel'] }),
        });
    }

    if (path === `/api/prompt-record/${BACKEND}`) {
        if (holdRecordsFetch) {
            // Held open until a test calls `releaseRecordsFetch()` — the race-condition tests use this to
            // land a chat switch, or a second `captureRawRecords()` call, while the fetch is still in flight.
            await new Promise((resolve) => {
                releaseRecordsFetch = resolve;
            });
        }

        // Snapshot at the moment the response is actually produced — a test that wants the fetch to answer
        // with what changed WHILE it was held sets `currentRecords` again before releasing.
        const records = currentRecords;

        return asResponse({
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ supported: true, depth: 10, backend: BACKEND, records }),
        });
    }

    // '/api/plugins/client-config' and anything else: a 404, same as a stock install with no plugins loaded.
    return asResponse({ ok: false, status: 404, json: async () => ({}) });
};

// 🔴 THE LOADER PUTS `test/stubs/` HERE, AND THESE CASTS ARE WHERE THAT IS DECLARED — the same rule
// `panel-record.test.js` states: `types/sillytavern.d.ts` describes only what the extension imports from the
// real app, so the members a test reads off the stubs are invisible to it without this.
const extensions = /** @type {typeof import('./stubs/extensions.js')} */ (
    /** @type {unknown} */ (await import('../../../extensions.js')));
const script = /** @type {typeof import('./stubs/script.js')} */ (
    /** @type {unknown} */ (await import('../../../script.js')));

const { context, resetContext, switchChat } = extensions;

const { buildRows, captureRawRecords } = await import('../index.js');
const { RAW_ENVELOPE_VERSION, buildStamp, readRawRequests, writeRawRequests } = await import('../persist.js');

/**
 * A quiet prompt-record, shaped as the route sends it (DESIGN_RAW_GENERATION_ROWS.md §6.1) — the wire fields
 * `record.js`/`index.js` actually read. `usage` is dropped by the caller (set to `undefined`) for any test
 * that wants an older-build or non-completed shape.
 * @param {Partial<{recordId: string, seq: number, chatId: string, status: string, at: number,
 * completedAt: number|undefined, backend: string, apiType: string, usageState: string|undefined,
 * usage: object|undefined}>} overrides Fields to replace
 * @returns {Record<string, unknown>} The record, as the fetch mock above will serve it — deliberately not
 * typed as `CacheRecord`: a test needs to `delete` fields off it (the older-build fixture below) to prove
 * their ABSENCE, which a record.js-shaped type would refuse
 */
function quietRecord(overrides = {}) {
    return {
        recordId: 'rec-1',
        seq: 1,
        chatId: context.chatId,
        genType: 'quiet',
        status: 'completed',
        at: 1_000,
        completedAt: 1_100,
        backend: BACKEND,
        apiType: 'deepseek',
        usageState: 'available',
        usage: { schema: 'input-cache-v1', inputTokens: 100, cachedTokens: 40, uncachedTokens: 60, provider: 'deepseek', api: 'chat-completions' },
        ...overrides,
    };
}

/**
 * A `RawRequestStamp`, built directly (not through `buildRawStamp`) for tests that inject persisted history
 * straight into `chatMetadata` — the "already on disk, server holds nothing" rehydration shape.
 * @param {Partial<import('../persist.js').RawRequestStamp>} fields Overrides on top of a valid default
 * @returns {import('../persist.js').RawRequestStamp} The stamp
 */
function rawStamp(fields) {
    return /** @type {import('../persist.js').RawRequestStamp} */ ({
        v: RAW_ENVELOPE_VERSION, id: 'raw-1', backend: BACKEND, apiType: 'deepseek', seq: '1',
        generationType: 'quiet', requestedAt: 1_000, completedAt: 1_100, status: 'completed',
        usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null,
        ...fields,
    });
}

/**
 * Take and clear the currently held-open fetch's release callback, if any — a named function rather than
 * inline `const release = releaseRecordsFetch; releaseRecordsFetch = null; release?.();` at each call site, so
 * the callback's type is the one declared above rather than whatever a particular call site's control-flow
 * analysis narrows it to.
 * @returns {((value?: unknown) => void)|null} The callback that was waiting, or null when nothing was held
 */
function takeRelease() {
    const release = releaseRecordsFetch;

    releaseRecordsFetch = null;

    return release;
}

/**
 * Poll a condition across event-loop ticks (never the real clock — this is waiting for OTHER promises already
 * in flight to reach a checkpoint, not for time to pass) until it is true or a bounded number of ticks elapse.
 * @param {() => boolean} conditionFn What to check
 * @param {number} [maxTicks] How many `setImmediate` ticks to allow
 * @returns {Promise<boolean>} Whether the condition became true
 */
async function waitFor(conditionFn, maxTicks = 25) {
    for (let i = 0; i < maxTicks; i++) {
        if (conditionFn()) {
            return true;
        }

        await new Promise((resolve) => setImmediate(resolve));
    }

    return conditionFn();
}

test.beforeEach(() => {
    resetContext();
    currentRecords = [];
    holdRecordsFetch = false;
    releaseRecordsFetch = null;
    // `itemizedPrompts` is a module-level array the stub never clears on its own (nothing else in this file
    // uses it) — only the mesId-ordering regression test below pushes into it, and this keeps that from
    // leaking rows into whichever test happens to run next.
    script.itemizedPrompts.length = 0;
});

test('a completed quiet record becomes exactly one raw stamp and one raw row', async () => {
    switchChat('chat-raw-1');
    currentRecords = [quietRecord({ recordId: 'rec-a', chatId: 'chat-raw-1' })];

    const result = await captureRawRecords();

    assert.equal(result.added, 1);
    assert.equal(result.saved, true);
    assert.equal(context.metadataSaves, 1);

    const stamps = readRawRequests(context.chatMetadata);

    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].id, 'rec-a');
    assert.equal(stamps[0].usageState, 'available');
    assert.equal(stamps[0].inputTokens, 100);
    assert.equal(stamps[0].cachedTokens, 40);
    assert.equal(stamps[0].uncachedTokens, 60);

    const { rows, messageRows, mode } = await buildRows();
    const rawRowsListed = rows.filter(row => row.kind === 'raw');

    assert.equal(rawRowsListed.length, 1);
    assert.equal(rawRowsListed[0].rowKey, 'raw:rec-a');
    assert.equal(messageRows.length, 0, 'no chat messages exist, so there are no message rows');
    assert.equal(mode.rawRows, 1);
});

test('repeated captures do not duplicate the row, and a no-op capture performs no save', async () => {
    switchChat('chat-raw-2');
    currentRecords = [quietRecord({ recordId: 'rec-b', chatId: 'chat-raw-2' })];

    const first = await captureRawRecords();

    assert.equal(first.added, 1);
    assert.equal(context.metadataSaves, 1);

    // §7.4 step 9: the merge changed nothing on this pass, so NOTHING is saved — not a debounced save.
    const second = await captureRawRecords();

    assert.equal(second.added, 0);
    assert.equal(second.saved, false);
    assert.equal(context.metadataSaves, 1, 'no save when nothing changed');

    const third = await captureRawRecords();

    assert.equal(third.added, 0);
    assert.equal(context.metadataSaves, 1);

    assert.equal(readRawRequests(context.chatMetadata).length, 1, 'still exactly one stamp, never duplicated');
});

test('two quiet requests completing out of order retain request order by requestedAt', async () => {
    switchChat('chat-raw-3');
    // `seq` disagrees with request time on purpose — §11.2 forbids ordering by seq/completion order, and this
    // proves `requestedAt` (not `seq`) is what actually drives the sort.
    currentRecords = [
        quietRecord({ recordId: 'rec-early', chatId: 'chat-raw-3', seq: 5, at: 1_000 }),
        quietRecord({ recordId: 'rec-late', chatId: 'chat-raw-3', seq: 3, at: 2_000 }),
    ];

    await captureRawRecords();

    const { rows } = await buildRows();
    const rawKeys = rows.filter(row => row.kind === 'raw').map(row => row.rowKey);

    assert.deepEqual(rawKeys, ['raw:rec-late', 'raw:rec-early'], 'newest requestedAt first, even though seq disagrees');
});

test('a chat switch during an in-flight fetch writes nothing to either chat', async () => {
    switchChat('chat-raw-4a');
    currentRecords = [quietRecord({ recordId: 'rec-race', chatId: 'chat-raw-4a' })];
    holdRecordsFetch = true;

    const pending = captureRawRecords();

    assert.ok(await waitFor(() => releaseRecordsFetch !== null), 'fetch should be holding open by now');

    // The reader switches chats while the capture that started for chat-raw-4a is still awaiting its fetch.
    // `script.js` replaces `chat_metadata` wholesale on every chat load, so this is a genuinely different
    // object, not a mutation of the one the capture snapshotted.
    switchChat('chat-raw-4b');

    takeRelease()?.();

    const result = await pending;

    assert.equal(result.added, 0);
    assert.equal(result.saved, false);
    assert.equal(context.metadataSaves, 0, 'never saved into either chat');
    assert.equal(readRawRequests(context.chatMetadata).length, 0, 'nothing written to the new chat either');
});

test('persisted raw rows rehydrate after a reload with no server record present', async () => {
    switchChat('chat-raw-5');

    const stamp = rawStamp({
        id: 'rec-old', seq: '9', requestedAt: 5_000, completedAt: 5_100,
        usageState: 'available', inputTokens: 50, cachedTokens: 20, uncachedTokens: 30,
    });

    writeRawRequests(context.chatMetadata, [stamp]);
    // The server holds nothing at all — a reload or a restart past the server's bounded record window.
    currentRecords = [];

    const { rows, mode } = await buildRows();
    const rawRowsListed = rows.filter(row => row.kind === 'raw');

    assert.equal(rawRowsListed.length, 1);
    assert.equal(rawRowsListed[0].rowKey, 'raw:rec-old');
    assert.equal(rawRowsListed[0].stamp.inputTokens, 50);
    assert.equal(mode.rawRows, 1);
});

test('repeated seq values after a server restart do not collide — ids differ', async () => {
    switchChat('chat-raw-6');
    currentRecords = [quietRecord({ recordId: 'rec-before-restart', chatId: 'chat-raw-6', seq: 1 })];

    await captureRawRecords();

    // The server restarted: its seq counter is back at 1, but this is a genuinely different request — §11.2
    // forbids deduplicating by `seq`, and this is exactly the collision that rule exists to prevent.
    currentRecords = [
        quietRecord({ recordId: 'rec-before-restart', chatId: 'chat-raw-6', seq: 1 }),
        quietRecord({ recordId: 'rec-after-restart', chatId: 'chat-raw-6', seq: 1, at: 9_000 }),
    ];

    await captureRawRecords();

    const stamps = readRawRequests(context.chatMetadata);

    assert.equal(stamps.length, 2, 'two distinct ids, not merged into one by their shared seq');
    assert.deepEqual(new Set(stamps.map(s => s.id)), new Set(['rec-before-restart', 'rec-after-restart']));
});

test('raw and message rows sort together into one ten-row budget', async () => {
    switchChat('chat-raw-7');

    // Three message rows, built purely from stored stamps — no live `itemizedPrompts`/record correlation, the
    // same "everything RAM destroyed" shape `persist-panel.test.js` exercises for a rehydrated panel.
    context.chat = [0, 1, 2].map(n => ({
        mes: `reply ${n}`,
        extra: {
            cacheLens: buildStamp({
                seq: String(100 + n), at: 500, maxContext: 8_000, promptChars: 100, eligibleChars: 50,
                actualTokens: 40, processedTokens: 10, promptMs: 200, requestAt: 3_000 + n * 1_000,
            }),
        },
    }));

    // Eight raw stamps, spread across timestamps that interleave with the three message rows above
    // (3000, 4000, 5000), so the newest-ten slice has to choose across BOTH kinds rather than filling from
    // one kind first.
    const eightRawStamps = Array.from({ length: 8 }, (_, i) => rawStamp({
        id: `raw-${i}`, seq: String(200 + i), requestedAt: 1_000 + i * 500, completedAt: 1_050 + i * 500,
    }));

    writeRawRequests(context.chatMetadata, eightRawStamps);
    currentRecords = [];

    const { rows, messageRows, mode } = await buildRows();

    assert.equal(rows.length, 10, 'the combined budget is exactly ten, out of eleven total candidates');
    assert.equal(messageRows.length, 3, 'all three message rows are among the ten newest overall');
    assert.equal(mode.rawRows, 7, 'the remaining seven slots are the seven newest raw rows');

    for (let i = 1; i < rows.length; i++) {
        // Every row in this fixture has a real `requestedAt`; `?? 0` mirrors the comparator's ordering-only
        // treatment of missing values without persisting a timestamp.
        assert.ok((rows[i - 1].requestedAt ?? 0) >= (rows[i].requestedAt ?? 0), `row ${i} is not older than row ${i - 1}`);
    }
});

test('raw rows do not affect message-id gap calculations, and messageRows excludes them', async () => {
    switchChat('chat-raw-8');

    // A miniature alternating chat: user (id 0), reply (id 1, stamped), user (id 2), reply (id 3, stamped).
    context.chat = [
        { mes: 'hello', is_user: true },
        {
            mes: 'hi',
            extra: { cacheLens: buildStamp({ seq: '1', at: 10, maxContext: 100, promptChars: 10, eligibleChars: 5, actualTokens: 4, processedTokens: 1, promptMs: 5, requestAt: 1_000 }) },
        },
        { mes: 'again', is_user: true },
        {
            mes: 'hey',
            extra: { cacheLens: buildStamp({ seq: '2', at: 20, maxContext: 100, promptChars: 12, eligibleChars: 6, actualTokens: 5, processedTokens: 1, promptMs: 5, requestAt: 2_000 }) },
        },
    ];

    // A raw row, timestamped so it lands between the two message rows in the combined ordering.
    writeRawRequests(context.chatMetadata, [rawStamp({ id: 'raw-a', seq: '50', requestedAt: 1_500, completedAt: 1_550 })]);
    currentRecords = [];

    const { rows, messageRows, userMesIds } = await buildRows();

    assert.equal(messageRows.length, 2);
    assert.ok(messageRows.every(row => row.kind === 'message'));
    assert.equal(rows.filter(row => row.kind === 'raw').length, 1);

    // The gap span comes from `messageRows` alone: ids 1 and 3, so index 2 (the reader's second message) is
    // the only id inside that span the reader actually sent. A raw row sitting between them in TIME must not
    // shrink, grow, or shift that span.
    assert.deepEqual(userMesIds, new Set([2]));
});

test('a pending record is not persisted until it reaches a terminal status', async () => {
    switchChat('chat-raw-9');
    currentRecords = [quietRecord({ recordId: 'rec-pending', chatId: 'chat-raw-9', status: 'pending', completedAt: undefined })];

    const pendingResult = await captureRawRecords();

    assert.equal(pendingResult.added, 0);
    assert.equal(pendingResult.saved, false);
    assert.equal(readRawRequests(context.chatMetadata).length, 0);

    currentRecords = [quietRecord({ recordId: 'rec-pending', chatId: 'chat-raw-9', status: 'completed', completedAt: 1_200 })];

    const doneResult = await captureRawRecords();

    assert.equal(doneResult.added, 1);
    assert.equal(readRawRequests(context.chatMetadata).length, 1);
});

test('every usage/status combination produces a row and never substitutes a fabricated zero', async () => {
    switchChat('chat-raw-10');
    currentRecords = [
        quietRecord({ recordId: 'rec-available', chatId: 'chat-raw-10' }),
        quietRecord({ recordId: 'rec-absent', chatId: 'chat-raw-10', usageState: 'absent', usage: undefined }),
        quietRecord({
            recordId: 'rec-invalid', chatId: 'chat-raw-10', usageState: 'available',
            usage: { schema: 'input-cache-v1', inputTokens: 10, cachedTokens: 999, uncachedTokens: 5 },
        }),
        quietRecord({ recordId: 'rec-failed', chatId: 'chat-raw-10', status: 'failed', usageState: undefined, usage: undefined, completedAt: 1_100 }),
        quietRecord({ recordId: 'rec-cancelled', chatId: 'chat-raw-10', status: 'cancelled', usageState: undefined, usage: undefined, completedAt: 1_100 }),
    ];

    await captureRawRecords();

    const stamps = readRawRequests(context.chatMetadata);
    const byId = new Map(stamps.map(s => [s.id, s]));

    assert.equal(byId.size, 5, 'every one of the five candidates became a row');

    const available = byId.get('rec-available');

    assert.ok(available, 'rec-available');
    assert.equal(available.usageState, 'available');
    assert.equal(available.inputTokens, 100);
    assert.equal(available.cachedTokens, 40);
    assert.equal(available.uncachedTokens, 60);

    for (const id of ['rec-absent', 'rec-invalid', 'rec-failed', 'rec-cancelled']) {
        const stamp = byId.get(id);

        assert.ok(stamp, id);
        assert.notEqual(stamp.usageState, 'available', id);
        assert.equal(stamp.inputTokens, null, `${id} inputTokens must be null, never a substituted 0`);
        assert.equal(stamp.cachedTokens, null, `${id} cachedTokens must be null, never a substituted 0`);
        assert.equal(stamp.uncachedTokens, null, `${id} uncachedTokens must be null, never a substituted 0`);
    }

    assert.equal(byId.get('rec-invalid')?.usageState, 'invalid');
    assert.equal(byId.get('rec-failed')?.status, 'failed');
    assert.equal(byId.get('rec-cancelled')?.status, 'cancelled');
});

test('rawUsageSupported is false when the fetched records carry no usage fields at all', async () => {
    switchChat('chat-raw-11');

    // An older Taproom build: no `usageState` field on the wire at all (not even 'absent') —
    // `usageCountsOf` reads this as 'unknown', DESIGN_RAW_GENERATION_ROWS.md §11.4's honest-degradation case.
    const olderBuildRecord = quietRecord({ recordId: 'rec-old-build', chatId: 'chat-raw-11' });

    delete olderBuildRecord.usageState;
    delete olderBuildRecord.usage;
    currentRecords = [olderBuildRecord];

    const { mode } = await buildRows();

    assert.equal(mode.rawUsageSupported, false);

    // And the persisted stamp still never fabricates a zero for it — 'unknown' degrades to 'absent' once
    // written down, because the schema only ever has three persisted states, and 'absent' is the honest one.
    await captureRawRecords();

    const stamps = readRawRequests(context.chatMetadata);

    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].usageState, 'absent');
    assert.equal(stamps[0].inputTokens, null);
});

test('overlapping captureRawRecords() calls perform exactly one extra fetch, not two', async () => {
    switchChat('chat-raw-12');
    currentRecords = [quietRecord({ recordId: 'rec-x', chatId: 'chat-raw-12' })];
    holdRecordsFetch = true;

    let backendFetchCount = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
        if (String(url) === `/api/prompt-record/${BACKEND}`) {
            backendFetchCount++;
        }

        return originalFetch(url);
    };

    try {
        const first = captureRawRecords();

        assert.ok(await waitFor(() => releaseRecordsFetch !== null), 'first pass should be holding open by now');

        // A second call while the first is still in flight — must join the SAME promise and queue exactly one
        // rerun, never start a second concurrent fetch (§11.3).
        const second = captureRawRecords();

        assert.equal(backendFetchCount, 1, 'only the first pass has reached the network so far');
        assert.equal(first, second, 'both callers join the exact same in-flight promise');

        takeRelease()?.();

        // The first pass finishes and, because a rerun was queued, immediately starts a second pass — which
        // is also held by the mock.
        assert.ok(await waitFor(() => releaseRecordsFetch !== null), 'the queued rerun should now be holding open');

        takeRelease()?.();

        await Promise.all([first, second]);

        assert.equal(backendFetchCount, 2, 'exactly one rerun — two fetches total, never three');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// Without timestamps or sequence handles, message rows must use numeric `mesId` ordering rather than the
// lexicographic `rowKey` fallback (for example, `message:15` sorts before `message:9` as a string).
test('🔴 ten message rows with no stamps and no records sort by mesId descending, not by rowKey string', async () => {
    switchChat('chat-raw-13');
    currentRecords = [];

    // Fifteen chat slots so every mesId below has somewhere to read `is_user`/`mes` from; only 5-14 get an
    // itemized prompt, so only those ten become rows.
    context.chat = Array.from({ length: 15 }, (_, n) => ({ mes: `turn ${n}` }));

    for (let mesId = 5; mesId <= 14; mesId++) {
        script.itemizedPrompts.push({
            mesId, rawPrompt: `prompt for turn ${mesId}`, this_max_context: 1_000, tokenizer: 'test',
        });
    }

    const { rows, messageRows } = await buildRows();

    assert.equal(rows.filter(row => row.kind === 'raw').length, 0, 'no raw rows in this fixture');
    assert.equal(messageRows.length, 10);

    // Every one of these ten rows has no stamp (nothing was ever captured) and no matched record (`records`
    // is `[]`), so every `requestedAt` is `null` and every `seq` is `null` — the exact tie the bug reached.
    for (const row of messageRows) {
        assert.equal(row.requestedAt, null, `mesId ${row.mesId} should have no requestedAt to fall back to`);
    }

    assert.deepEqual(
        messageRows.map(row => row.mesId),
        [14, 13, 12, 11, 10, 9, 8, 7, 6, 5],
        'strict descending mesId order, not a lexicographic rowKey shuffle',
    );
});

// An unreadable envelope must remain untouched: treating its empty read result as a new empty store would let
// a later capture overwrite data written by a newer version.
test('🔴 an unreadable raw envelope is left byte-for-byte untouched by a capture, never overwritten', async () => {
    switchChat('chat-raw-14');

    const futureEnvelope = {
        v: 2,
        rawRequests: [{ v: 2, id: 'rec-future', shapeThisBuildHasNeverSeen: true, tokensByColour: { green: 9 } }],
    };

    // A structural clone, so the assertion below is comparing against an independent copy rather than the
    // same object a bug could have mutated in place and still pass by reference.
    const originalEnvelope = structuredClone(futureEnvelope);

    context.chatMetadata.cacheLens = futureEnvelope;
    currentRecords = [quietRecord({ recordId: 'rec-new', chatId: 'chat-raw-14' })];

    const result = await captureRawRecords();

    assert.equal(result.added, 0, 'nothing is merged in when the envelope cannot be read');
    assert.equal(result.saved, false, 'no save — an unreadable envelope is never written to');
    assert.equal(context.metadataSaves, 0);

    // §7.2: `readRawRequests` on an unreadable envelope is ALSO `[]`, by design — this assertion is about the
    // OBJECT ON DISK (`chatMetadata.cacheLens`), not about what this build can parse out of it, because that
    // second question would pass even when the object had been silently replaced with `v: 1` and one stamp.
    assert.deepEqual(context.chatMetadata.cacheLens, originalEnvelope, 'the envelope is byte-for-byte identical to what it was before the capture');
    assert.equal(readRawRequests(context.chatMetadata).length, 0, 'unreadable to THIS build, same as before — but the underlying object was never touched');
});

// A quiet generation may have an itemized prompt at `mesId = chat.length` without adding a chat message.
// That entry must not become a message row when the same request is already represented by a raw row.
test('🔴 a quiet generation\'s itemized entry has no chat message and must not become a phantom message row', async () => {
    switchChat('chat-raw-15');
    context.chat = [{ mes: 'hello', is_user: true }, { mes: 'hi there' }];

    script.itemizedPrompts.push(
        // The real turn: mesId 1 has a message at `chat[1]`.
        { mesId: 1, rawPrompt: 'SYSTEM\nUser: hello', this_max_context: 1_000, tokenizer: 'test' },
        // The phantom: mesId 2 === chat.length, exactly the shape a `/gen` quiet generation pushes. No
        // `chat[2]` exists — this is the entry that must be filtered out, not listed, and not usable as a
        // baseline for anything.
        { mesId: 2, rawPrompt: 'the quiet /gen request, formatted', this_max_context: 1_000, tokenizer: 'test' },
    );

    // The RAW row for that same quiet generation — already persisted, as `captureRawRecords` would have
    // written it once the request completed.
    context.chatMetadata.cacheLens = {
        v: RAW_ENVELOPE_VERSION,
        rawRequests: [rawStamp({ id: 'raw-quiet-2', requestedAt: 500, usageState: 'available', inputTokens: 63, cachedTokens: 40, uncachedTokens: 23 })],
    };

    const { rows, messageRows, droppedRows, mode } = await buildRows();

    assert.equal(messageRows.some(row => row.mesId === 2), false, 'mesId 2 has no chat message and must never become a message row');
    assert.ok(messageRows.some(row => row.mesId === 1), 'the real turn at mesId 1 should still be a row');

    const rawRowsListed = rows.filter(row => row.kind === 'raw');

    assert.equal(rawRowsListed.length, 1, 'the raw row for the same generation should still be listed');
    assert.equal(rawRowsListed[0].rowKey, 'raw:raw-quiet-2');

    // The phantom entry is not a dropped turn — it was never a turn at all, so it must not inflate the
    // header's "N turn(s) not listed" count.
    assert.equal(droppedRows, 0);
    assert.equal(mode.rawRows, 1);
});

// A later NORMAL generation landing at that same mesId must work as ordinary: SillyTavern replaces the
// itemized entry in place by `mesId` once a real message exists there, and the filter added above reads
// `chatMessages[mesId]` fresh on every call — nothing here is sticky per-mesId.
test('a later normal generation at the same mesId the quiet request used renders as an ordinary message row', async () => {
    switchChat('chat-raw-16');
    // The chat has now genuinely grown to three messages — mesId 2 is a real reply this time, not a phantom.
    context.chat = [{ mes: 'hello', is_user: true }, { mes: 'hi there' }, { mes: 'a real reply' }];

    script.itemizedPrompts.push(
        { mesId: 1, rawPrompt: 'SYSTEM\nUser: hello', this_max_context: 1_000, tokenizer: 'test' },
        // Same mesId the phantom case used above, but this time SillyTavern replaced the entry once the
        // message actually landed — `chatMessages[2]` now exists.
        { mesId: 2, rawPrompt: 'SYSTEM\nUser: hello\nBot: hi there\nUser: a real reply', this_max_context: 1_000, tokenizer: 'test' },
    );

    const { messageRows, droppedRows } = await buildRows();

    assert.ok(messageRows.some(row => row.mesId === 2), 'a real message at this mesId must render as an ordinary row');
    assert.equal(droppedRows, 0);
});

// A polish can leave an itemized entry at `mesId = chat.length`, then the user's own message can occupy that
// slot. Exclude user messages even when present so the polish prompt is not rendered as a generated turn.
test('🔴 a polish\'s itemized entry must not become a message row once the reader\'s own message fills that id', async () => {
    switchChat('chat-raw-17');
    // The polish ran against the draft when the chat held two messages, so its entry landed at mesId 2. The
    // reader then sent, and `chat[2]` is THEIR message — a message the reader typed, never a generation.
    context.chat = [{ mes: 'hello', is_user: true }, { mes: 'hi there' }, { mes: 'the polished draft', is_user: true }];

    script.itemizedPrompts.push(
        { mesId: 1, rawPrompt: 'SYSTEM\nUser: hello', this_max_context: 1_000, tokenizer: 'test' },
        // The polish's own prompt, still sitting at the id the reader's message now occupies.
        { mesId: 2, rawPrompt: 'the polish request, formatted', this_max_context: 1_000, tokenizer: 'test' },
    );

    // The RAW row for that same polish, as `captureRawRecords` persisted it when the request completed.
    context.chatMetadata.cacheLens = {
        v: RAW_ENVELOPE_VERSION,
        rawRequests: [rawStamp({ id: 'raw-polish-2', requestedAt: 500, usageState: 'available', inputTokens: 59_742, cachedTokens: 42_752, uncachedTokens: 16_990 })],
    };

    const { rows, messageRows, droppedRows, mode } = await buildRows();

    assert.equal(messageRows.some(row => row.mesId === 2), false, 'the reader typed mesId 2, so it can never be a message row');
    assert.ok(messageRows.some(row => row.mesId === 1), 'the real turn at mesId 1 should still be a row');

    const rawRowsListed = rows.filter(row => row.kind === 'raw');

    assert.equal(rawRowsListed.length, 1, 'the polish is listed once, as the raw row it is');
    assert.equal(rawRowsListed[0].rowKey, 'raw:raw-polish-2');

    // Not a turn, so not a dropped one either — the header's "N turn(s) not listed" count must not move.
    assert.equal(droppedRows, 0);
    assert.equal(mode.rawRows, 1);
});

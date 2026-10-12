import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// `fetchRecordPrompt` reaches the host's `getRequestHeaders` helper through `probeRecord`, so register the
// loader before importing `record.js`, as in `raw-requests.test.js`.
register(pathToFileURL('./test/loader.mjs'));

// A stand-in for the bundled hasher, installed before `record.js` is imported so `hashPrompt` finds it.
globalThis.SillyTavern = {
    libs: {
        sha256: (text) => `h(${text.length}:${text.slice(0, 12)})`,
    },
};

/**
 * The backend family `fetchRecordPrompt`'s tests use.
 * @type {string}
 */
const RECORD_BACKEND = 'text';

/** Records the stubbed `/api/prompt-record/<backend>` route answers with. Mutated per test. @type {object[]} */
let fetchRecordsResponse = [];

/**
 * @param {RequestInfo|URL} url What was asked for
 * @returns {Promise<Response>} The stubbed reply
 */
globalThis.fetch = async (url) => {
    const path = String(url);

    if (path === '/api/prompt-record/') {
        return /** @type {Response} */ (/** @type {unknown} */ ({
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ supported: true, depth: 10, backends: ['text', 'chat', 'kobold', 'novel'] }),
        }));
    }

    if (path === `/api/prompt-record/${RECORD_BACKEND}`) {
        return /** @type {Response} */ (/** @type {unknown} */ ({
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ supported: true, depth: 10, backend: RECORD_BACKEND, records: fetchRecordsResponse }),
        }));
    }

    // '/api/plugins/client-config' and anything else: a 404, same as a stock install with no plugins loaded.
    return /** @type {Response} */ (/** @type {unknown} */ ({ ok: false, status: 404, json: async () => ({}) }));
};

const { PROVENANCE, backendFamily, correlate, describeRewrites, evictionNote, fetchRecordPrompt, hashPrompt, isTerminalRecord, projectQuietRecord, provenanceFor, rewriteSitesOf, timingsFromRecordUsage, usageCountsOf } = await import('../record.js');

/** @typedef {import('../record.js').CacheRecord} CacheRecord */
/** @typedef {import('../record.js').RewriteSite} RewriteSite */
/** @typedef {import('../record.js').RawRewriteSite} RawRewriteSite */

/**
 * A record shaped like the route's, carrying only the fields these tests read.
 *
 * 🔴 DELIBERATELY PARTIAL, AND THE CAST IS WHERE THAT IS DECLARED. The wire type makes every field but
 * `seq` optional precisely so that "the server said nothing" stays distinguishable from "the server said X",
 * and the degraded paths tested below are the ones that fire when a field is absent. A fixture that filled
 * the rest in would be asserting a completeness the route never promises.
 * @param {Partial<CacheRecord>} fields Overrides
 * @returns {CacheRecord} The fixture
 */
function record(fields) {
    return /** @type {CacheRecord} */ ({
        seq: 1,
        at: 1_700_000_000_000,
        backend: 'text',
        apiType: 'llamacpp',
        chatId: 'chat-a',
        genType: 'normal',
        length: 10,
        hash: 'hash-1',
        rewrittenBy: [],
        prevSeq: null,
        text: 'a prompt',
        ...fields,
    });
}

test('backend families match what the four endpoints pass in', () => {
    assert.equal(backendFamily('textgenerationwebui'), 'text');
    assert.equal(backendFamily('kobold'), 'kobold');
    assert.equal(backendFamily('koboldhorde'), 'kobold');
    assert.equal(backendFamily('novel'), 'novel');
    assert.equal(backendFamily('openai'), 'chat');
    assert.equal(backendFamily('horde'), null);
});

test('provenance says which source produced the prompt, every time', () => {
    const rewritten = provenanceFor(record({ rewrittenBy: ['mnemosyne'], text: 'sent text' }), true, true);

    assert.equal(rewritten.provenance, PROVENANCE.SENT);
    assert.equal(rewritten.text, 'sent text');
    // "modified by", not "rewritten by": the row names what a plugin did, and it is not an accusation.
    assert.match(rewritten.label, /modified by mnemosyne/);

    const untouched = provenanceFor(record({ rewrittenBy: [] }), true, true);

    assert.equal(untouched.provenance, PROVENANCE.CONFIRMED);
    assert.match(untouched.label, /no server plugin changed it/);
});

// 🔴 `rewrittenBy` SEES SERVER-SIDE PLUGINS ONLY. World Info, the author's note, summaries and vectors are
// applied in the browser, so they never appear in it. A user whose World Book rewrote his prompt every turn
// was shown "no plugin changed it" on every one of them. No label may claim to be the complete list.
test('no provenance label claims to be the complete list of what shaped the prompt', () => {
    const cases = [
        provenanceFor(record({ rewrittenBy: ['mnemosyne'] }), true, true),
        provenanceFor(record({ rewrittenBy: [] }), true, true),
        provenanceFor(null, false, false),
    ];

    for (const answer of cases) {
        assert.doesNotMatch(answer.label, /no plugin changed it|nothing rewrote it/);
        assert.match(answer.detail, /never appear here|not the complete list/);
    }
});

test('every provenance answer carries a detail a reader can hover', () => {
    const answers = [
        provenanceFor(record({ rewrittenBy: ['mnemosyne'] }), true, true),
        provenanceFor(record({ rewrittenBy: [] }), true, true),
        provenanceFor(null, true, true),
        provenanceFor(null, false, true),
        provenanceFor(null, false, false),
    ];

    for (const answer of answers) {
        assert.equal(typeof answer.detail, 'string');
        assert.ok(answer.detail.length > 0, `empty detail on: ${answer.label}`);
    }
});

test('🔴 without the record and with a plugin loaded, the row claims nothing', () => {
    const greyed = provenanceFor(null, false, true);

    assert.equal(greyed.provenance, PROVENANCE.UNKNOWN);
    assert.equal(greyed.text, null);
    assert.equal(greyed.label, 'final prompt not visible to the client');
});

test("without the record and with no plugin loaded, the browser's copy is the truth", () => {
    const plain = provenanceFor(null, false, false);

    assert.equal(plain.provenance, PROVENANCE.BROWSER);
    assert.match(plain.label, /no server plugin is loaded/);
});

test('🔴 a turn with no record is judged by whether anything COULD have rewritten it', () => {
    // When no server plugin is present, a missing record does not make the browser's prompt less trustworthy.
    const noPlugins = provenanceFor(null, true, false);

    assert.equal(noPlugins.provenance, PROVENANCE.BROWSER);
    assert.match(noPlugins.label, /no server plugin is loaded/);

    const withPlugins = provenanceFor(null, true, true);

    assert.equal(withPlugins.provenance, PROVENANCE.UNKNOWN);
    assert.match(withPlugins.label, /not visible to the client/);
});

test('🔴 a predecessor that IS the previous turn is not reported as an eviction', () => {
    // The bug this test exists for: identifying the predecessor by "did we correlate the previous turn?"
    // labelled an ordinary consecutive pair `evicted by: normal` whenever the previous turn had no record
    // yet, which is common on a fresh page.
    const previous = record({ seq: 4, hash: 'hash-prev' });
    const current = record({ seq: 5, prevSeq: 4, hash: 'hash-cur' });

    assert.deepEqual(evictionNote(current, previous, 'hash-prev'), { ok: true, note: null });
});

test('a summarisation in between is named', () => {
    const quiet = record({ seq: 4, genType: 'quiet', hash: 'hash-quiet' });
    const current = record({ seq: 5, prevSeq: 4 });

    assert.deepEqual(evictionNote(current, quiet, 'hash-prev'), { ok: false, note: 'evicted by: quiet' });
});

test('another chat overwriting the cache is named as such, whatever it was doing', () => {
    const other = record({ seq: 4, chatId: 'chat-b', genType: 'normal', hash: 'hash-other' });
    const current = record({ seq: 5, prevSeq: 4, chatId: 'chat-a' });

    assert.deepEqual(evictionNote(current, other, 'hash-prev'), { ok: false, note: 'evicted by: another chat' });
});

test('a predecessor that aged out is unknown rather than assumed away', () => {
    const current = record({ seq: 9, prevSeq: 3 });
    const aged = evictionNote(current, null, 'hash-prev');

    assert.equal(aged.ok, false);
    // `note` is nullable — a null one is the row saying nothing at all, which is a different answer from the
    // one this test is about, so it is asserted rather than assumed.
    assert.ok(aged.note);
    assert.match(aged.note, /predecessor unknown/);
});

test('an unnameable generation in between is still not the previous turn', () => {
    const stranger = record({ seq: 4, genType: 'normal', hash: 'hash-stranger' });
    const current = record({ seq: 5, prevSeq: 4 });

    assert.deepEqual(evictionNote(current, stranger, 'hash-prev'), { ok: false, note: 'predecessor is not the previous turn' });
});

test('the first generation on a backend is not an eviction', () => {
    assert.deepEqual(evictionNote(record({ prevSeq: null }), null, null), { ok: true, note: 'first generation on this backend' });
});

test('with no record at all there is no predecessor annotation, per the degraded mode', () => {
    assert.deepEqual(evictionNote(null, null, null), { ok: true, note: null });
});

test('correlation prefers the seq watched go past, then the hash, then elimination', () => {
    // The stub hasher installed above always answers; the hash rung below is built on what it returned.
    const eightHash = hashPrompt('turn eight prompt');

    assert.ok(eightHash);

    const bySeq = record({ seq: 7, hash: 'unrelated', text: 'rewritten seven' });
    const byHash = record({ seq: 8, hash: eightHash, text: 'turn eight prompt' });
    const leftover = record({ seq: 9, hash: 'unrelated too', text: 'rewritten nine' });
    const turns = [
        { mesId: 9, rawPrompt: 'nine as the browser built it', seq: null },
        { mesId: 8, rawPrompt: 'turn eight prompt', seq: null },
        { mesId: 7, rawPrompt: 'seven as the browser built it', seq: '7' },
    ];

    const matched = correlate(turns, [bySeq, byHash, leftover], 'chat-a');

    assert.equal(matched.get(7), bySeq);
    assert.equal(matched.get(8), byHash);
    assert.equal(matched.get(9), leftover, 'exactly one record and one turn left over is a forced answer');
});

test('🔴 elimination refuses when more than one candidate fits', () => {
    const a = record({ seq: 1, hash: 'a' });
    const b = record({ seq: 2, hash: 'b' });
    const turns = [
        { mesId: 2, rawPrompt: 'rewritten away', seq: null },
        { mesId: 1, rawPrompt: 'also rewritten away', seq: null },
    ];

    assert.equal(correlate(turns, [a, b], 'chat-a').size, 0);
});

test('elimination will not reach into another chat or a quiet generation', () => {
    const elsewhere = record({ seq: 1, chatId: 'chat-b', hash: 'x' });
    const quiet = record({ seq: 2, genType: 'quiet', hash: 'y' });
    const turns = [{ mesId: 1, rawPrompt: 'rewritten away', seq: null }];

    assert.equal(correlate(turns, [elsewhere, quiet], 'chat-a').size, 0);
});

test('no records means no correlation and no throw', () => {
    assert.equal(correlate([{ mesId: 1, rawPrompt: 'x', seq: null }], null, 'chat-a').size, 0);
    assert.equal(correlate([], [], null).size, 0);
});

test('🔴 identical prompts correlate to the newest matching record, not the oldest', () => {
    // Duplicate prompt hashes are normal. Match newest-first so a newer turn is not assigned to an older
    // record with unrelated predecessor metadata.
    const same = hashPrompt('an identical prompt');

    assert.ok(same);

    const stale = record({ seq: 3, hash: same, chatId: 'chat-elsewhere' });
    const mine = record({ seq: 4, hash: same, chatId: 'chat-a' });
    const turns = [{ mesId: 6, rawPrompt: 'an identical prompt', seq: null }];

    assert.equal(correlate(turns, [stale, mine], 'chat-a').get(6), mine);
});

test('duplicate hashes are handed out newest first, one per turn', () => {
    const same = hashPrompt('same prompt');

    assert.ok(same);

    const older = record({ seq: 1, hash: same });
    const newer = record({ seq: 2, hash: same });
    const turns = [
        { mesId: 4, rawPrompt: 'same prompt', seq: null },
        { mesId: 2, rawPrompt: 'same prompt', seq: null },
    ];

    const matched = correlate(turns, [older, newer], 'chat-a');

    assert.equal(matched.get(4), newer);
    assert.equal(matched.get(2), older);
});

/**
 * A record carrying rewrite sites, some of them deliberately malformed.
 *
 * ⚠️ THE CAST IS FOR THE MALFORMED ENTRIES, NOT FOR THE SHAPE. `RawRewriteSite` already promises none of
 * its three fields, because the wire does not — `RewriteSite` is the RESOLVED shape, whose `atFinal` and
 * `prepended` are what `rewriteSitesOf` derives. What still needs the cast is a `null` entry, which is not
 * a site at all and which several tests pass deliberately, because dropping it is what the filter is for.
 * @param {Array<RawRewriteSite|null>} sites Rewrite sites as a record carries them
 * @param {number} [length] How long the prompt as sent was
 * @returns {CacheRecord} A record carrying them
 */
function withSites(sites, length = 200_000) {
    return record({ rewriteSites: /** @type {RawRewriteSite[]} */ (sites), text: 'x'.repeat(length) });
}

// ⚠️ OFFSETS ARE SEQUENTIAL, NOT FINAL. The first writer's offset is against a string the second one then
// changed, so a later insertion at or before a position pushes that position right.
test('a later writer shifts an earlier one, and only when it wrote before it', () => {
    const shifted = rewriteSitesOf(withSites([
        { id: 'first', atChar: 100, delta: 50 },
        { id: 'second', atChar: 60, delta: 10 },
    ]));

    assert.equal(shifted[0].atFinal, 110);
    assert.equal(shifted[1].atFinal, 60);

    const untouched = rewriteSitesOf(withSites([
        { id: 'first', atChar: 100, delta: 50 },
        { id: 'second', atChar: 400, delta: 10 },
    ]));

    assert.equal(untouched[0].atFinal, 100);
});

test('a deletion by a later writer pulls an earlier position back', () => {
    const sites = rewriteSitesOf(withSites([
        { id: 'first', atChar: 1_000, delta: 40 },
        { id: 'second', atChar: 20, delta: -300 },
    ]));

    assert.equal(sites[0].atFinal, 700);
});

// ⚠️ A POSITION THAT DOES NOT EXIST IN THE PROMPT AS SENT IS NOT PRINTED.
test('an offset past the end of the prompt is withheld rather than pointed at', () => {
    const [site] = rewriteSitesOf(withSites([{ id: 'a', atChar: 199_990, delta: 1_000 }]));

    assert.equal(site.atFinal, null);
    assert.equal(site.atChar, 199_990);

    const note = describeRewrites([site]);

    // The note is nullable, and a null one would surface on the next line as a TypeError rather than as the
    // assertion that actually failed.
    assert.ok(note);
    assert.match(note.title, /could not be located/);
});

test('malformed sites are dropped rather than guessed at', () => {
    const sites = rewriteSitesOf(withSites([
        { id: 'good', atChar: 10, delta: 5 },
        { id: 'nodelta', atChar: 10 },
        { atChar: 10, delta: 5 },
        { id: 'negative', atChar: -1, delta: 5 },
        null,
    ]));

    assert.equal(sites.length, 1);
    assert.equal(sites[0].id, 'good');
});

test('no rewriteSites at all is an empty list and no note', () => {
    assert.deepEqual(rewriteSitesOf(record({})), []);
    assert.deepEqual(rewriteSitesOf(null), []);
    assert.equal(describeRewrites([]), null);
    // ⚠️ `describeRewrites` guards on `Array.isArray` and answers null, but its signature does not admit
    // null — the cast states what the callee already handles, not a claim about this value.
    assert.equal(describeRewrites(null), null);
});

// 🔴 THE WHOLE REASON THE FIELD EXISTS. A depth anchor that cannot place itself falls back to prepending
// SILENTLY, putting its text ahead of everything the cache had.
test('char 0 is surfaced as a possible silent prepend fallback, and warns', () => {
    const note = describeRewrites(rewriteSitesOf(withSites([{ id: 'mnemosyne', atChar: 0, delta: 1_240 }])));

    assert.ok(note);
    assert.equal(note.warn, true);
    assert.match(note.text, /at the very start/);
    assert.match(note.title, /fell back to prepending/);
    // Both readings, because this code was never told the configured depth and must not invent one.
    assert.match(note.title, /If it is configured to prepend/);
});

// 🔴 NEVER PRINT A DEPTH YOU WERE NOT TOLD. A plugin's settings say where it MEANT to write; the record says
// where it landed, and the case worth showing is the one where those disagree.
test('the note quotes only observed numbers, never a configured depth', () => {
    const note = describeRewrites(rewriteSitesOf(withSites([{ id: 'mnemosyne', atChar: 198_400, delta: 1_240 }])));

    assert.ok(note);
    assert.equal(note.text, 'mnemosyne added 1,240 chars at char 198,400');
    assert.equal(note.warn, false);
    assert.match(note.title, /observed, not configured/);
    assert.doesNotMatch(note.title, /depth \d/);
});

test('a negative delta reads as a removal, not an addition', () => {
    const note = describeRewrites(rewriteSitesOf(withSites([{ id: 'trimmer', atChar: 500, delta: -340 }])));

    assert.ok(note);
    assert.equal(note.text, 'trimmer removed 340 chars at char 500');
});

test('a same-length edit is a rewrite in place, not a zero-char addition', () => {
    const note = describeRewrites(rewriteSitesOf(withSites([{ id: 'masker', atChar: 500, delta: 0 }])));

    assert.ok(note);
    assert.equal(note.text, 'masker rewrote in place at char 500');
});

/**
 * A valid `input-cache-v1` usage object — the one shape `usageCountsOf` accepts as-is.
 * @returns {NonNullable<CacheRecord['usage']>}
 */
function validUsage() {
    return { schema: 'input-cache-v1', inputTokens: 100, cachedTokens: 40, uncachedTokens: 60, provider: 'deepseek', api: 'chat-completions' };
}

/**
 * A `quiet` record carrying every field `projectQuietRecord` must drop, deliberately populated with content
 * that would be an obvious, provable leak if any of it ever reached the projection. Built independently of
 * `record()` above because that helper's defaults model an ordinary user-facing generation, not a raw
 * formatter request — a quiet record needs `recordId`/`status`/`completedAt`/`usageState`/`usage`, none of
 * which `record()` sets.
 * @param {Partial<CacheRecord>} fields Overrides
 * @returns {CacheRecord}
 */
function quietRecord(fields) {
    return /** @type {CacheRecord} */ ({
        seq: 42,
        at: 1_700_000_000_000,
        backend: 'chat',
        apiType: 'deepseek',
        chatId: 'chat-a',
        genType: 'quiet',
        recordId: 'rid-42',
        status: 'completed',
        completedAt: 1_700_000_001_000,
        usageState: 'available',
        usage: validUsage(),
        // The fields `projectQuietRecord` must drop — short synthetic non-personal strings, present only to
        // prove the drop rather than to model anything real.
        text: 'quiet formatter prompt text must never persist',
        hash: 'hash-of-quiet-prompt',
        shape: { depth: 4 },
        rewrittenBy: ['some-plugin'],
        rewriteSites: [{ id: 'some-plugin', atChar: 0, delta: 10 }],
        ...fields,
    });
}

test('usageCountsOf accepts a valid measurement unchanged', () => {
    assert.deepEqual(usageCountsOf(quietRecord({})), { usageState: 'available', inputTokens: 100, cachedTokens: 40, uncachedTokens: 60 });
});

// A legacy record with no `usageState` is unknown, not absent, and must not fabricate counts.
test('a record with no usageState field at all is unknown, not absent, and fabricates nothing', () => {
    const counts = usageCountsOf(record({}));

    assert.equal(counts.usageState, 'unknown');
    assert.equal(counts.inputTokens, null);
    assert.equal(counts.cachedTokens, null);
    assert.equal(counts.uncachedTokens, null);
});

test("usageState: 'absent' yields null counts, never a fabricated zero", () => {
    const counts = usageCountsOf(quietRecord({ usageState: 'absent', usage: undefined }));

    assert.equal(counts.usageState, 'absent');
    assert.equal(counts.inputTokens, null);
    assert.equal(counts.cachedTokens, null);
    assert.equal(counts.uncachedTokens, null);
});

test('usageCountsOf rejects a wrong schema and returns null counts, not zero', () => {
    const counts = usageCountsOf(quietRecord({ usage: { ...validUsage(), schema: 'some-other-schema' } }));

    assert.equal(counts.usageState, 'invalid');
    assert.equal(counts.inputTokens, null);
    assert.equal(counts.cachedTokens, null);
    assert.equal(counts.uncachedTokens, null);
});

test('usageCountsOf rejects a negative count', () => {
    const counts = usageCountsOf(quietRecord({ usage: { ...validUsage(), cachedTokens: -1, uncachedTokens: 101 } }));

    assert.equal(counts.usageState, 'invalid');
    assert.equal(counts.cachedTokens, null);
});

test('usageCountsOf rejects a fractional count', () => {
    const counts = usageCountsOf(quietRecord({ usage: { ...validUsage(), inputTokens: 100.5 } }));

    assert.equal(counts.usageState, 'invalid');
    assert.equal(counts.inputTokens, null);
});

test('usageCountsOf rejects cachedTokens greater than inputTokens', () => {
    const counts = usageCountsOf(quietRecord({ usage: { ...validUsage(), inputTokens: 10, cachedTokens: 20, uncachedTokens: 0 } }));

    assert.equal(counts.usageState, 'invalid');
    assert.equal(counts.cachedTokens, null);
});

test('usageCountsOf rejects counts that do not sum to inputTokens', () => {
    const counts = usageCountsOf(quietRecord({ usage: { ...validUsage(), inputTokens: 100, cachedTokens: 40, uncachedTokens: 50 } }));

    assert.equal(counts.usageState, 'invalid');
    assert.equal(counts.uncachedTokens, null);
});

test('isTerminalRecord accepts completed, failed and cancelled', () => {
    for (const status of ['completed', 'failed', 'cancelled']) {
        assert.equal(isTerminalRecord(record({ status })), true, status);
    }
});

// 🔴 A RECORD WITH NO `status` AT ALL IS AN OLDER TAPROOM, NOT A TERMINAL ONE. There is no way to know
// whether the request it describes ever finished, so it must not be treated as safe to persist.
test('isTerminalRecord refuses pending and a record with no status field at all', () => {
    assert.equal(isTerminalRecord(record({ status: 'pending' })), false);
    assert.equal(isTerminalRecord(record({})), false);
    assert.equal(isTerminalRecord(null), false);
    assert.equal(isTerminalRecord(undefined), false);
});

test('projectQuietRecord refuses anything that is not a quiet record', () => {
    assert.equal(projectQuietRecord(record({ genType: 'normal' })), null);
    assert.equal(projectQuietRecord(record({ genType: 'impersonate' })), null);
    assert.equal(projectQuietRecord(null), null);
    assert.equal(projectQuietRecord(undefined), null);
});

// 🔴 THIS IS THE PRIVACY BOUNDARY ITSELF, NOT A TIDINESS CHECK. The five fields below are how a quiet
// record's actual prompt content could reach a raw row; each one is populated in the fixture specifically
// so its absence from the projection is proven rather than assumed.
test('🔴 projectQuietRecord drops text, hash, shape, rewrittenBy and rewriteSites', () => {
    const projection = projectQuietRecord(quietRecord({}));

    assert.ok(projection);
    assert.equal('text' in projection, false);
    assert.equal('hash' in projection, false);
    assert.equal('shape' in projection, false);
    assert.equal('rewrittenBy' in projection, false);
    assert.equal('rewriteSites' in projection, false);
});

// 🔴 THE MECHANISM, NOT JUST A COMMENT. A future field added to the wire record must not silently ride along
// into a raw row — this is what actually enforces that, rather than trusting the function's own restraint.
test('🔴 projectQuietRecord returns exactly the specified key set, no more and no less', () => {
    const projection = projectQuietRecord(quietRecord({}));

    assert.ok(projection);
    assert.deepEqual(Object.keys(projection).sort(), [
        'apiType', 'at', 'backend', 'cachedTokens', 'chatId', 'completedAt', 'genType',
        'inputTokens', 'recordId', 'seq', 'status', 'uncachedTokens', 'usageState',
    ].sort());
});

test('projectQuietRecord carries validated usage counts, not the raw usage object', () => {
    const projection = projectQuietRecord(quietRecord({}));

    assert.ok(projection);
    assert.equal(projection.usageState, 'available');
    assert.equal(projection.inputTokens, 100);
    assert.equal(projection.cachedTokens, 40);
    assert.equal(projection.uncachedTokens, 60);
    assert.equal(projection.recordId, 'rid-42');
    assert.equal(projection.status, 'completed');
});

test('projectQuietRecord never fabricates counts for a record with invalid usage', () => {
    const projection = projectQuietRecord(quietRecord({ usage: { ...validUsage(), inputTokens: 10, cachedTokens: 20, uncachedTokens: 0 } }));

    assert.ok(projection);
    assert.equal(projection.usageState, 'invalid');
    assert.equal(projection.inputTokens, null);
    assert.equal(projection.cachedTokens, null);
    assert.equal(projection.uncachedTokens, null);
});

// 🔴 A NEW OBJECT, NEVER A REFERENCE BACK TO THE ORIGINAL. If the projection held a reference to the source
// record (or a shallow copy of it), later code touching the source could still reach the dropped text
// through it — the whole point of projecting immediately is that this is structurally impossible.
test('🔴 the projection does not share identity with the input, and mutating the input afterward does not change it', () => {
    const source = quietRecord({});
    const projection = projectQuietRecord(source);

    assert.ok(projection);
    assert.notEqual(/** @type {object} */ (projection), /** @type {object} */ (source));

    source.status = 'failed';
    source.text = 'mutated after projection — must never leak through';
    // @ts-expect-error test-only mutation of a fixture's nested usage object
    source.usage.inputTokens = 999_999;

    assert.equal(projection.status, 'completed');
    assert.equal(projection.inputTokens, 100);
});

// Map validated record usage to the `{ cache_n, prompt_n }` shape consumed by the bar and persistence helpers.
test('timingsFromRecordUsage maps a record with available usage onto cache_n/prompt_n', () => {
    const timings = timingsFromRecordUsage(quietRecord({}));

    assert.deepEqual(timings, { cache_n: 40, prompt_n: 60 });
});

test('timingsFromRecordUsage returns null for a record with no usable usage', () => {
    assert.equal(timingsFromRecordUsage(null), null);
    assert.equal(timingsFromRecordUsage(undefined), null);
    // No `usageState` at all — an ordinary, non-finalized record, not a measurement.
    assert.equal(timingsFromRecordUsage(record({})), null);
    assert.equal(timingsFromRecordUsage(quietRecord({ usageState: 'absent', usage: undefined })), null);
    // Invalid usage is not a measurement either — never substituted with zero.
    assert.equal(timingsFromRecordUsage(quietRecord({ usage: { ...validUsage(), inputTokens: 10, cachedTokens: 20, uncachedTokens: 0 } })), null);
});

// `fetchRecordPrompt` is the sanctioned on-demand read of a raw record's prompt. `projectQuietRecord` remains the boundary
// for anything STORED; this function is a read for the view button only, never written onto a row or stamp.
test('fetchRecordPrompt returns the matching record\'s text', async () => {
    fetchRecordsResponse = [
        { recordId: 'rid-1', seq: 1, text: 'first prompt' },
        { recordId: 'rid-2', seq: 2, text: 'second prompt' },
    ];

    assert.equal(await fetchRecordPrompt(RECORD_BACKEND, 'rid-2'), 'second prompt');
});

test('fetchRecordPrompt returns null when the record has aged out of the server\'s memory', async () => {
    fetchRecordsResponse = [{ recordId: 'rid-1', seq: 1, text: 'still here' }];

    assert.equal(await fetchRecordPrompt(RECORD_BACKEND, 'rid-long-gone'), null);
});

test('fetchRecordPrompt returns null when the matched record carries no text field', () => {
    fetchRecordsResponse = [{ recordId: 'rid-3', seq: 3 }];

    return fetchRecordPrompt(RECORD_BACKEND, 'rid-3').then((text) => assert.equal(text, null));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildRawStamp,
    buildStamp,
    describeAge,
    mergeRawRequests,
    RAW_ENVELOPE_VERSION,
    rawEnvelopeVersionOf,
    readRawRequests,
    readStamp,
    STAMP_VERSION,
    stampVersionOf,
    timingsFromStamp,
    writeRawRequests,
} from '../persist.js';

/**
 * What may go into a chat file and what may be claimed from one coming back out.
 *
 * `persist.js` imports nothing, like `prefix.js` and `bar.js`, so these decisions are testable without a
 * browser — which matters more here than anywhere else in the extension, because a wrong answer is written
 * to disk and read back as a fact days later.
 */

/** @typedef {import('../persist.js').StampFields} StampFields */

/**
 * @param {Partial<StampFields>} [overrides] Overrides
 * @returns {StampFields} The fields `buildStamp` takes for one measured turn
 */
function fields(overrides = {}) {
    return {
        seq: 4127,
        at: 1_756_180_000_000,
        maxContext: 38_912,
        promptChars: 112_044,
        eligibleChars: 2_249,
        eligibleTokens: 601,
        promptTokens: 45_548,
        actualTokens: 34_931,
        processedTokens: 10_617,
        promptMs: 20_760,
        divergedAt: 2_249,
        baselineSeq: 4_126,
        rewrittenBy: ['mnemosyne'],
        rewriteSites: [{ id: 'mnemosyne', atChar: 12_904, delta: 812, atFinal: 12_904, prepended: false }],
        clientChanges: ['World Info'],
        ...overrides,
    };
}

test('a stamp round-trips through a message with every field intact', () => {
    const stamp = buildStamp(fields());

    // `buildStamp` answers null for a turn not worth a byte, which this one is not — asserted rather than
    // assumed, because a null slipping through here would round-trip as `deepEqual(null, null)` and pass.
    assert.ok(stamp);

    const message = { extra: { cacheLens: JSON.parse(JSON.stringify(stamp)) } };

    assert.deepEqual(readStamp(message), stamp);
    assert.equal(stamp.v, STAMP_VERSION);
});

test('the correlation handle survives as a string, whatever it arrived as', () => {
    /**
     * The null `buildStamp` can answer is not one of the cases under test — every fixture here carries a
     * prompt — so it is refused once rather than navigated around on each of the four lines below.
     * @param {unknown} seq Whatever the handle arrived as
     * @returns {string|null} The handle as it was stamped
     */
    const seqOf = (seq) => {
        const stamp = buildStamp(fields({ seq }));

        assert.ok(stamp);

        return stamp.seq;
    };

    assert.equal(seqOf(4127), '4127');
    assert.equal(seqOf('4127'), '4127');
    assert.equal(seqOf(null), null);
    assert.equal(seqOf(undefined), null);
});

// 🔴 A MISSING NUMBER IS MISSING. Substituting a zero for `cache_n` would put a solid red bar on a turn
// nobody measured, which is the fabrication the whole design exists to refuse.
test('absent measurements are null, never a substituted zero', () => {
    const stamp = buildStamp(fields({ actualTokens: undefined, processedTokens: NaN, eligibleTokens: null }));

    assert.ok(stamp);
    assert.equal(stamp.actualTokens, null);
    assert.equal(stamp.processedTokens, null);
    assert.equal(stamp.eligibleTokens, null);
    assert.notEqual(stamp.actualTokens, 0);
});

// 🔴 §14.5. "The backend reported no cache_n" and "nobody was recording when this turn happened" are
// different facts about the same blank column, and only a stamp that EXISTS can tell them apart.
test('a turn the backend said nothing about is still stamped, so it is not read as unrecorded', () => {
    const stamp = buildStamp(fields({ actualTokens: null, processedTokens: null, promptMs: null }));

    assert.ok(stamp, 'a measured-nothing turn still gets a stamp');
    assert.equal(stamp.promptChars, 112_044);
    assert.equal(timingsFromStamp(stamp), null);
});

test('a turn with neither a measurement nor a prompt is not worth a byte', () => {
    assert.equal(buildStamp({ promptChars: 0 }), null);
    assert.equal(buildStamp({}), null);
});

// 🔴 `divergedAt` IS NOT `eligibleChars` WEARING ANOTHER NAME, THOUGH A PREFIX SCAN MAKES THEM EQUAL. A
// turn with no baseline has an eligible prefix of zero characters and NO divergence at all, and once both
// are 0 nothing distinguishes them unless one is allowed to be null.
test('no baseline is a null divergence, not a divergence at character zero', () => {
    const stamp = buildStamp(fields({ eligibleChars: 0, divergedAt: null }));

    assert.ok(stamp);
    assert.equal(stamp.eligibleChars, 0);
    assert.equal(stamp.divergedAt, null);

    const atZero = buildStamp(fields({ eligibleChars: 0, divergedAt: 0 }));

    assert.ok(atZero);
    assert.equal(atZero.divergedAt, 0);
});

test('the timings come back under the names the backend used, so the live code path is reused', () => {
    const raw = timingsFromStamp(readStamp({ extra: { cacheLens: buildStamp(fields()) } }));

    assert.deepEqual(raw, { cache_n: 34_931, prompt_n: 10_617, prompt_ms: 20_760 });
});

test('a partial report yields only the fields the backend actually gave', () => {
    assert.deepEqual(timingsFromStamp(buildStamp(fields({ actualTokens: null }))), { prompt_n: 10_617, prompt_ms: 20_760 });
    assert.equal(timingsFromStamp(null), null);
});

// 🔴 A SCHEMA THIS BUILD DOES NOT KNOW IS REFUSED, NOT BEST-EFFORT PARSED. A reader that guesses at an
// unfamiliar shape prints the guesses as measurements.
test('an unknown schema version is refused rather than parsed hopefully', () => {
    const future = { extra: { cacheLens: { v: 99, actualTokens: 34_931 } } };

    assert.equal(readStamp(future), null);
});

// 🔴 AND REFUSING IT MUST NOT READ AS "NOT RECORDED". Those are opposite facts: one is a measurement this
// code cannot parse and is sitting right there in the chat file, the other is a turn nobody measured.
test('too-new-to-read is distinguishable from never-recorded', () => {
    assert.equal(stampVersionOf({ extra: { cacheLens: { v: 99 } } }), 99);
    assert.equal(stampVersionOf({ extra: { cacheLens: buildStamp(fields()) } }), STAMP_VERSION);

    // Never recorded: no stamp of any version.
    assert.equal(stampVersionOf({ extra: {} }), null);
    assert.equal(stampVersionOf({}), null);
    assert.equal(stampVersionOf(null), null);
});

test('junk on the message is not a stamp', () => {
    assert.equal(readStamp({ extra: { cacheLens: 'yes' } }), null);
    assert.equal(readStamp({ extra: { cacheLens: [] } }), null);
    assert.equal(stampVersionOf({ extra: { cacheLens: { noVersion: true } } }), null);
});

test('malformed rewrite sites and non-string component names are dropped, not carried', () => {
    const stamp = buildStamp(fields({
        rewriteSites: [{ id: 'ok', atChar: 5, delta: 2 }, { id: 42, atChar: 5, delta: 2 }, { atChar: 5, delta: 2 }],
        rewrittenBy: ['ok', 7, null],
        clientChanges: 'World Info',
    }));

    assert.ok(stamp);
    assert.deepEqual(stamp.rewriteSites, [{ id: 'ok', atChar: 5, delta: 2, atFinal: null, prepended: false }]);
    assert.deepEqual(stamp.rewrittenBy, ['ok']);
    assert.deepEqual(stamp.clientChanges, []);
});

// 🔴 THE AGE IS PART OF THE CLAIM (§6.3). A stat measured three days ago describes the backend as it was
// configured three days ago, and the row has to be able to say so.
test('the age of a measurement is stated in units a reader can act on', () => {
    const now = 1_756_180_000_000;

    assert.equal(describeAge(now, now), 'just now');
    assert.equal(describeAge(now - 90_000, now), 'just now');
    assert.equal(describeAge(now - 3 * 60_000, now), '3 minutes ago');
    assert.equal(describeAge(now - 5 * 3_600_000, now), '5 hours ago');
    assert.equal(describeAge(now - 3 * 86_400_000, now), '3 days ago');
    assert.equal(describeAge(now - 2 * 86_400_000, now), '2 days ago');
});

// ⚠️ A chat file written on another machine, or a clock that resynced, gives a measurement a timestamp in
// the future. "in 3 days" beside a number reads as a bug in the number rather than in the clock.
test('a timestamp from the future is not dated', () => {
    const now = 1_756_180_000_000;

    assert.equal(describeAge(now + 86_400_000, now), 'earlier');
    assert.equal(describeAge(null, now), null);
    // The clock itself going missing is guarded, and this line is the only thing that pins that guard.
    assert.equal(describeAge(now, null), null);
});

// 🔴 §8: ADDITIVE, SO A LEGACY STAMP WITH NONE READS BACK AS NULL RATHER THAN ZERO, and giving it a real
// value does not disturb any field that already existed under STAMP_VERSION 1.
test('requestAt round-trips on an ordinary stamp, and its absence reads back as null, not zero', () => {
    const withIt = buildStamp(fields({ requestAt: 1_756_179_000_000 }));

    assert.ok(withIt);
    assert.equal(withIt.requestAt, 1_756_179_000_000);

    const rehydrated = readStamp({ extra: { cacheLens: JSON.parse(JSON.stringify(withIt)) } });

    assert.ok(rehydrated);
    assert.equal(rehydrated.requestAt, 1_756_179_000_000);

    const legacy = buildStamp(fields());

    assert.ok(legacy);
    assert.equal(legacy.requestAt, null);
});

/**
 * Raw-generation rows (DESIGN_RAW_GENERATION_ROWS.md §7). `persist.js` imports nothing here either, so
 * these decisions are testable without a browser — the same reason the ordinary-stamp tests above are.
 */

/** @typedef {import('../persist.js').RawRequestFields} RawRequestFields */

/**
 * @param {Partial<RawRequestFields>} [overrides] Overrides
 * @returns {RawRequestFields} The fields `buildRawStamp` takes for one completed, measured quiet generation
 */
function rawFields(overrides = {}) {
    return {
        id: 'a3f1c2d4-0000-4000-8000-000000000001',
        backend: 'chat',
        apiType: 'deepseek',
        seq: '123',
        generationType: 'quiet',
        requestedAt: 1_756_180_000_000,
        completedAt: 1_756_180_002_000,
        status: 'completed',
        usageState: 'available',
        inputTokens: 500,
        cachedTokens: 300,
        uncachedTokens: 200,
        ...overrides,
    };
}

test('a valid raw envelope round-trips through buildRawStamp, writeRawRequests and readRawRequests', () => {
    const stamp = buildRawStamp(rawFields());

    assert.ok(stamp);
    assert.equal(stamp.v, RAW_ENVELOPE_VERSION);

    /** @type {Record<string, unknown>} */
    const chatMetadata = {};

    writeRawRequests(chatMetadata, [stamp]);

    // Round-trip through JSON, the way the chat file actually carries it, so the test cannot pass by
    // accident of object identity.
    const rehydrated = JSON.parse(JSON.stringify(chatMetadata));

    assert.deepEqual(readRawRequests(rehydrated), [stamp]);
    assert.equal(rawEnvelopeVersionOf(rehydrated), RAW_ENVELOPE_VERSION);
});

// 🔴 §7.1: THIS EXTENSION OWNS ONLY THE VERSIONED RAW-REQUEST FIELDS. A writer that replaced either object
// wholesale would discard whatever a lorebook, a summarizer, or a future Cache Lens version put beside them.
test('unknown sibling fields in chatMetadata and in chatMetadata.cacheLens survive a write', () => {
    const chatMetadata = {
        note_panel_open: true,
        cacheLens: {
            v: RAW_ENVELOPE_VERSION,
            rawRequests: [],
            futureField: 'left alone by an older build',
        },
    };

    const stamp = buildRawStamp(rawFields());

    assert.ok(stamp);
    writeRawRequests(chatMetadata, [stamp]);

    assert.equal(chatMetadata.note_panel_open, true);
    assert.equal(/** @type {{ futureField?: unknown }} */ (chatMetadata.cacheLens).futureField, 'left alone by an older build');
    assert.deepEqual(readRawRequests(chatMetadata), [stamp]);
});

// 🔴 "TOO NEW TO READ" MUST NEVER RENDER AS "NOT RECORDED" (mirrors stampVersionOf's own test above), and
// refusing an envelope this build cannot parse must never touch what is actually stored.
test('an unknown envelope version is reported by rawEnvelopeVersionOf and yields no rows, leaving stored data untouched', () => {
    const chatMetadata = { cacheLens: { v: 99, rawRequests: [{ v: 99, id: 'from-the-future' }] } };
    const before = JSON.stringify(chatMetadata);

    assert.equal(rawEnvelopeVersionOf(chatMetadata), 99);
    assert.deepEqual(readRawRequests(chatMetadata), []);
    assert.equal(JSON.stringify(chatMetadata), before);

    // Never recorded at all is the opposite fact, and must read as null, not 0 or some other falsy stand-in.
    assert.equal(rawEnvelopeVersionOf({}), null);
    assert.equal(rawEnvelopeVersionOf(null), null);
});

test('a malformed entry is skipped while its valid siblings survive', () => {
    const good = buildRawStamp(rawFields());

    assert.ok(good);

    const chatMetadata = {
        cacheLens: {
            v: RAW_ENVELOPE_VERSION,
            rawRequests: [
                good,
                { v: RAW_ENVELOPE_VERSION, id: null, status: 'completed' }, // no identity
                { v: RAW_ENVELOPE_VERSION, id: 'no-status' }, // no recognized status
                { v: RAW_ENVELOPE_VERSION, id: 'wrong-status', status: 'pending' }, // never terminal here
                'not even an object',
                null,
            ],
        },
    };

    assert.deepEqual(readRawRequests(chatMetadata), [good]);
});

// 🔴 THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE. Substituting a zero for a missing or contradictory
// DeepSeek usage report would draw a solid bar for a request nobody actually measured.
test("usageState 'absent' and 'invalid' keep inputTokens/cachedTokens/uncachedTokens as null, never 0", () => {
    const absent = buildRawStamp(rawFields({ usageState: 'absent', inputTokens: undefined, cachedTokens: undefined, uncachedTokens: undefined }));

    assert.ok(absent);
    assert.equal(absent.usageState, 'absent');
    assert.equal(absent.inputTokens, null);
    assert.equal(absent.cachedTokens, null);
    assert.equal(absent.uncachedTokens, null);
    assert.notEqual(absent.inputTokens, 0);

    // Declared "invalid" outright.
    const invalid = buildRawStamp(rawFields({ usageState: 'invalid', inputTokens: 500, cachedTokens: 300, uncachedTokens: 200 }));

    assert.ok(invalid);
    assert.equal(invalid.usageState, 'invalid');
    assert.equal(invalid.inputTokens, null);
    assert.equal(invalid.cachedTokens, null);
    assert.equal(invalid.uncachedTokens, null);

    // Declared "available" but self-contradictory (cached + uncached !== input) is demoted to invalid rather
    // than rendering two real numbers beside a fabricated third.
    const contradictory = buildRawStamp(rawFields({ usageState: 'available', inputTokens: 500, cachedTokens: 300, uncachedTokens: 999 }));

    assert.ok(contradictory);
    assert.equal(contradictory.usageState, 'invalid');
    assert.equal(contradictory.inputTokens, null);
    assert.equal(contradictory.cachedTokens, null);
    assert.equal(contradictory.uncachedTokens, null);
});

test('failed and cancelled stamps carry no usage, regardless of what usageState or token fields were handed in', () => {
    const failed = buildRawStamp(rawFields({ status: 'failed', usageState: 'available', inputTokens: 500, cachedTokens: 300, uncachedTokens: 200 }));

    assert.ok(failed);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.usageState, 'absent');
    assert.equal(failed.inputTokens, null);
    assert.equal(failed.cachedTokens, null);
    assert.equal(failed.uncachedTokens, null);

    const cancelled = buildRawStamp(rawFields({ status: 'cancelled', usageState: 'available', inputTokens: 500, cachedTokens: 300, uncachedTokens: 200 }));

    assert.ok(cancelled);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.usageState, 'absent');
    assert.equal(cancelled.inputTokens, null);
});

test('mergeRawRequests appends an unseen id, is idempotent for a repeat of the same terminal record, and never duplicates', () => {
    const first = buildRawStamp(rawFields({ id: 'first' }));
    const second = buildRawStamp(rawFields({ id: 'second', seq: '124' }));

    assert.ok(first);
    assert.ok(second);

    // Append an unseen id.
    const step1 = mergeRawRequests([], [first]);

    assert.equal(step1.changed, true);
    assert.deepEqual(step1.merged, [first]);

    // A second, different unseen id appends without disturbing the first.
    const step2 = mergeRawRequests(step1.merged, [second]);

    assert.equal(step2.changed, true);
    assert.deepEqual(step2.merged, [first, second]);

    // Repeating the exact same terminal record again is a no-op: nothing moved, nothing duplicated.
    const repeat = buildRawStamp(rawFields({ id: 'first' }));

    assert.ok(repeat);

    const step3 = mergeRawRequests(step2.merged, [repeat]);

    assert.equal(step3.changed, false);
    assert.deepEqual(step3.merged, step2.merged);
    assert.equal(step3.merged.length, 2);
});

// §7.4 step 7: replace only when the same id moves from incomplete legacy data to a terminal validated form.
test('mergeRawRequests upgrades a less-complete entry for the same id, and never regresses a more-complete one', () => {
    const stillAbsent = buildRawStamp(rawFields({ id: 'race', status: 'completed', usageState: 'absent', inputTokens: undefined, cachedTokens: undefined, uncachedTokens: undefined }));
    const nowAvailable = buildRawStamp(rawFields({ id: 'race', status: 'completed', usageState: 'available' }));

    assert.ok(stillAbsent);
    assert.ok(nowAvailable);

    const upgraded = mergeRawRequests([stillAbsent], [nowAvailable]);

    assert.equal(upgraded.changed, true);
    assert.deepEqual(upgraded.merged, [nowAvailable]);

    // Feeding the absent version back in after the available one is already stored must not regress it.
    const guarded = mergeRawRequests(upgraded.merged, [stillAbsent]);

    assert.equal(guarded.changed, false);
    assert.deepEqual(guarded.merged, [nowAvailable]);
});

test('a stamp built from hostile input neither throws nor produces a half-valid stamp', () => {
    assert.doesNotThrow(() => buildRawStamp({ id: undefined }));
    assert.equal(buildRawStamp({ id: undefined, status: 'completed' }), null, 'no identity is not worth keeping');

    assert.doesNotThrow(() => buildRawStamp(rawFields({ inputTokens: 'a lot', cachedTokens: NaN })));
    const stringInput = buildRawStamp(rawFields({ inputTokens: 'a lot', cachedTokens: NaN }));

    assert.ok(stringInput);
    assert.equal(stringInput.usageState, 'invalid');
    assert.equal(stringInput.inputTokens, null);
    assert.equal(stringInput.cachedTokens, null);
    assert.equal(stringInput.uncachedTokens, null);

    const negative = buildRawStamp(rawFields({ cachedTokens: -50 }));

    assert.ok(negative);
    assert.equal(negative.usageState, 'invalid');
    assert.equal(negative.cachedTokens, null);

    assert.doesNotThrow(() => readRawRequests(/** @type {any} */ (null)));
    assert.deepEqual(readRawRequests(/** @type {any} */ (null)), []);
    assert.deepEqual(readRawRequests({ cacheLens: { v: RAW_ENVELOPE_VERSION, rawRequests: 'not an array' } }), []);
    assert.deepEqual(readRawRequests({ cacheLens: { v: RAW_ENVELOPE_VERSION, rawRequests: null } }), []);

    assert.doesNotThrow(() => writeRawRequests(/** @type {any} */ (null), []));
    assert.doesNotThrow(() => mergeRawRequests(/** @type {any} */ (null), /** @type {any} */ (undefined)));
    assert.deepEqual(mergeRawRequests(/** @type {any} */ (null), /** @type {any} */ (undefined)), { merged: [], changed: false });
});

// Persisted chat data is untrusted: fractional counts can satisfy the sum check while representing an
// impossible backend measurement. Exercise the read path because capture validation is checked separately.
test('a fractional token count read from a chat file is refused as invalid, never rendered as a fraction', () => {
    const chatMetadata = {
        cacheLens: {
            v: RAW_ENVELOPE_VERSION,
            rawRequests: [{
                v: RAW_ENVELOPE_VERSION, id: 'x', backend: 'chat', apiType: 'deepseek', seq: '1',
                generationType: 'quiet', requestedAt: 1, completedAt: 2, status: 'completed',
                usageState: 'available', inputTokens: 100.5, cachedTokens: 0.5, uncachedTokens: 100,
            }],
        },
    };

    const [stamp] = readRawRequests(chatMetadata);

    assert.ok(stamp);
    assert.equal(stamp.usageState, 'invalid');
    assert.equal(stamp.inputTokens, null);
    assert.equal(stamp.cachedTokens, null);
    assert.equal(stamp.uncachedTokens, null);
});

// A higher usage rank must not erase populated identity fields omitted by the incoming candidate.
test('mergeRawRequests fills usage from the incoming candidate without erasing identity fields it left null', () => {
    const existingEntry = buildRawStamp(rawFields({
        id: 'fw-1', status: 'completed', usageState: 'absent', backend: 'chat', apiType: 'deepseek', seq: '412',
        inputTokens: undefined, cachedTokens: undefined, uncachedTokens: undefined,
    }));
    const incomingEntry = buildRawStamp(rawFields({
        id: 'fw-1', status: 'completed', usageState: 'available', backend: undefined, apiType: undefined, seq: undefined,
    }));

    assert.ok(existingEntry);
    assert.ok(incomingEntry);
    // Confirm the fixture actually exercises the bug: incoming really is missing what existing has.
    assert.equal(incomingEntry.backend, null);
    assert.equal(incomingEntry.seq, null);

    const result = mergeRawRequests([existingEntry], [incomingEntry]);

    assert.equal(result.changed, true);
    assert.equal(result.merged.length, 1);

    const [merged] = result.merged;

    // The usage group came from incoming, as it should — that is the actual upgrade.
    assert.equal(merged.usageState, 'available');
    assert.equal(merged.inputTokens, incomingEntry.inputTokens);
    assert.equal(merged.cachedTokens, incomingEntry.cachedTokens);
    assert.equal(merged.uncachedTokens, incomingEntry.uncachedTokens);

    // And the identity fields incoming left null were backfilled from existing, not erased.
    assert.equal(merged.backend, 'chat');
    assert.equal(merged.apiType, 'deepseek');
    assert.equal(merged.seq, '412');
});

// `absent` and `invalid` are different states with no usage counts to preserve. A later capture can correct
// either state, so they share a rank and the incoming state wins.
test("mergeRawRequests lets a later capture correct usageState between 'absent' and 'invalid' in either direction", () => {
    const wasInvalid = buildRawStamp(rawFields({ id: 'flip', usageState: 'available', inputTokens: 10, cachedTokens: 999, uncachedTokens: 999 }));

    assert.ok(wasInvalid);
    assert.equal(wasInvalid.usageState, 'invalid', 'fixture check: contradictory counts really do demote to invalid');

    const laterAbsent = buildRawStamp(rawFields({ id: 'flip', usageState: 'absent', inputTokens: undefined, cachedTokens: undefined, uncachedTokens: undefined }));

    assert.ok(laterAbsent);

    const correctedForward = mergeRawRequests([wasInvalid], [laterAbsent]);

    assert.equal(correctedForward.changed, true);
    assert.equal(correctedForward.merged[0].usageState, 'absent');

    // And the reverse direction is not blocked either — both are the same tied tier.
    const wasAbsent = buildRawStamp(rawFields({ id: 'flip', usageState: 'absent', inputTokens: undefined, cachedTokens: undefined, uncachedTokens: undefined }));
    const laterInvalid = buildRawStamp(rawFields({ id: 'flip', usageState: 'available', inputTokens: 10, cachedTokens: 999, uncachedTokens: 999 }));

    assert.ok(wasAbsent);
    assert.ok(laterInvalid);
    assert.equal(laterInvalid.usageState, 'invalid');

    const correctedBackward = mergeRawRequests([wasAbsent], [laterInvalid]);

    assert.equal(correctedBackward.changed, true);
    assert.equal(correctedBackward.merged[0].usageState, 'invalid');
});

// Missing timestamps can be filled by a later capture; real timestamps must not regress to fabricated zeroes.
test('mergeRawRequests fills a fabricated-zero requestedAt/completedAt from a later capture, and never regresses a real one', () => {
    const zeroStamped = buildRawStamp(rawFields({ id: 'ts', requestedAt: 0, completedAt: 0 }));
    const realStamped = buildRawStamp(rawFields({ id: 'ts', requestedAt: 1_756_180_000_000, completedAt: 1_756_180_002_000 }));

    assert.ok(zeroStamped);
    assert.ok(realStamped);

    const filled = mergeRawRequests([zeroStamped], [realStamped]);

    assert.equal(filled.changed, true);
    assert.equal(filled.merged[0].requestedAt, 1_756_180_000_000);
    assert.equal(filled.merged[0].completedAt, 1_756_180_002_000);

    // Feeding the fabricated-zero version back in afterward must not regress the real timestamp.
    const guarded = mergeRawRequests(filled.merged, [zeroStamped]);

    assert.equal(guarded.changed, false);
    assert.equal(guarded.merged[0].requestedAt, 1_756_180_000_000);
    assert.equal(guarded.merged[0].completedAt, 1_756_180_002_000);
});

// Preserve unknown fields on a version-compatible entry when an older build reads and saves it.
test('unknown fields on an individual raw-request entry survive a read/write round trip', () => {
    const chatMetadata = {
        cacheLens: {
            v: RAW_ENVELOPE_VERSION,
            rawRequests: [{
                v: RAW_ENVELOPE_VERSION, id: 'future-entry', backend: 'chat', apiType: 'deepseek', seq: '9',
                generationType: 'quiet', requestedAt: 1, completedAt: 2, status: 'completed',
                usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null,
                sourceHint: 'a field only a newer Cache Lens build understands',
            }],
        },
    };

    const [stamp] = readRawRequests(chatMetadata);

    assert.ok(stamp);
    assert.equal(/** @type {{ sourceHint?: unknown }} */ (stamp).sourceHint, 'a field only a newer Cache Lens build understands');

    writeRawRequests(chatMetadata, [stamp]);

    const rehydrated = JSON.parse(JSON.stringify(chatMetadata));
    const [rewritten] = readRawRequests(rehydrated);

    assert.ok(rewritten);
    assert.equal(/** @type {{ sourceHint?: unknown }} */ (rewritten).sourceHint, 'a field only a newer Cache Lens build understands');
});

// The unknown field must also survive a merge collision with a freshly built candidate for the same id, since
// `mergeRawEntry` starts from `{ ...existing, ...incoming }` and `incoming` never carries the extra key.
test('unknown fields on a raw-request entry survive a merge collision with a fresh candidate for the same id', () => {
    /** @type {import('../persist.js').RawRequestStamp} */
    const existingWithExtra = /** @type {any} */ ({
        ...buildRawStamp(rawFields({ id: 'extra-merge', usageState: 'absent', inputTokens: undefined, cachedTokens: undefined, uncachedTokens: undefined })),
        sourceHint: 'kept across the merge',
    });
    const incomingUpgrade = buildRawStamp(rawFields({ id: 'extra-merge', usageState: 'available' }));

    assert.ok(incomingUpgrade);

    const result = mergeRawRequests([existingWithExtra], [incomingUpgrade]);

    assert.equal(result.changed, true);
    assert.equal(/** @type {{ sourceHint?: unknown }} */ (result.merged[0]).sourceHint, 'kept across the merge');
    assert.equal(result.merged[0].usageState, 'available');
});

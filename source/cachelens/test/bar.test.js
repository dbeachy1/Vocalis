import assert from 'node:assert/strict';
import test from 'node:test';

import { barSplit, describeChange, measuredSplit, measurementFromRawStamp, measurementFromTimings, summaryFor, verdictFor } from '../bar.js';

/** @typedef {import('../index.js').Row} Row */
/** @typedef {import('../index.js').MessageRow} MessageRow */
/** @typedef {import('../index.js').RawRow} RawRow */
/** @typedef {import('../bar.js').RawStampLike} RawStampLike */

/**
 * A raw-request stamp, shaped the way DESIGN_RAW_GENERATION_ROWS.md §7.2 defines it — only the fields
 * `bar.js` reads, since `measurementFromRawStamp` is deliberately duck-typed rather than importing
 * `persist.js`'s real type.
 * @param {Partial<RawStampLike>} fields Overrides
 * @returns {RawStampLike} The fixture
 */
function rawStamp(fields) {
    return {
        status: 'completed',
        usageState: 'available',
        inputTokens: 1_200,
        cachedTokens: 900,
        uncachedTokens: 300,
        ...fields,
    };
}

/**
 * A raw row, shaped the way `buildRows` will produce one (DESIGN_RAW_GENERATION_ROWS.md §8) — only the
 * fields `bar.js` reads from a raw row.
 *
 * 🔴 DELIBERATELY PARTIAL, SAME DISCIPLINE AS `row()` BELOW. `bar.js` never reads `rowKey`, `requestedAt`,
 * `seq` or `measurement` off a raw row — only `kind` and `stamp` — so this fixture supplies exactly those
 * two rather than inventing values for fields nothing here looks at. The cast says "this stands in for a
 * raw row here"; it does not say the object is complete. Now that `index.js` has landed `RawRow` as a real
 * type with `kind`/`stamp` fields, the two overlap enough for a direct assertion — no `unknown` step needed.
 * @param {Partial<RawStampLike>} stampFields Overrides for the stamp
 * @returns {RawRow} The fixture
 */
function rawRow(stampFields) {
    return /** @type {RawRow} */ ({ kind: 'raw', stamp: rawStamp(stampFields) });
}

/**
 * A row shaped like `buildRows` produces, carrying only the fields `bar.js` reads.
 *
 * 🔴 DELIBERATELY PARTIAL, AND THE CAST IS WHERE THAT IS DECLARED. Filling in the two dozen fields
 * this module never looks at would mean inventing defaults for them — and the derivation below exists
 * precisely because a hard-coded default hides the regression it was written to catch. The cast says "this
 * stands in for a row here"; it does not say the object is complete.
 *
 * 🔴 `MessageRow`, NOT `Row`. Now that `index.js` has landed `Row = MessageRow | RawRow`, `Partial<Row>` only
 * ever includes the fields the two variants share (`kind`, `rowKey`, `requestedAt`, `seq`, `measurement`) —
 * `keyof` a union is the intersection of its members' keys — so `baselineMissing` and every other
 * message-only field this fixture sets were never expressible as `Partial<Row>` once the union landed. This
 * fixture has always meant a message row; the type now says so.
 * @param {Partial<MessageRow>} fields Overrides
 * @returns {MessageRow} The fixture
 */
function row(fields) {
    const merged = {
        mesId: 350,
        hasBaseline: true,
        greyed: false,
        greyedReason: '',
        promptChars: 180_000,
        prefixChars: 6_900,
        promptTokens: 45_466,
        prefixTokens: 1_734,
        maxContext: 47_104,
        timings: null,
        promptKnown: true,
        ...fields,
    };

    // 🔴 DERIVED, NOT DEFAULTED, AND NEVER DEFAULTED TO `first-turn`. `buildRows` always sets this beside
    // `hasBaseline` because the two cannot be allowed to disagree, and `bar.js` deliberately says NOTHING
    // when the reason is absent rather than assuming the most confident of the three. A fixture that
    // hard-coded `first-turn` would hide exactly the regression that rule exists to catch.
    return /** @type {MessageRow} */ ({
        ...merged,
        baselineMissing: Object.hasOwn(fields, 'baselineMissing')
            ? fields.baselineMissing
            : (merged.hasBaseline ? null : 'first-turn'),
    });
}

test('measuredSplit takes both fields or neither', () => {
    assert.deepEqual(measuredSplit({ cache_n: 38_797, prompt_n: 6_669 }), { reused: 38_797, processed: 6_669 });

    // 🔴 `cache_n` alone is NOT drawable. The red segment would have to come from the client tokenizer's
    // estimate, merging a measurement with a prediction inside one bar — DESIGN.md §6.4.
    assert.equal(measuredSplit({ cache_n: 38_797 }), null);
    assert.equal(measuredSplit({ prompt_n: 6_669 }), null);
    assert.equal(measuredSplit({ cache_n: 38_797, prompt_n: null }), null);
    assert.equal(measuredSplit(null), null);
    assert.equal(measuredSplit({}), null);
    assert.equal(measuredSplit({ cache_n: -1, prompt_n: 10 }), null);
    assert.equal(measuredSplit({ cache_n: 0, prompt_n: 0 }), null);
});

test('a fully-processed turn is measured, not predicted', () => {
    assert.deepEqual(measuredSplit({ cache_n: 0, prompt_n: 43_623 }), { reused: 0, processed: 43_623 });
});

// 🔴 THE REGRESSION TEST FOR §6.4a. These are the two consecutive turns off a live 45,500-token chat that
// proved the prefix undrawable: identical eligible, 22× different actual. If both ever draw the same green,
// the bar is back on the prediction and the panel is lying again.
test('#349 and #350 — identical prefix, 22x different actual', () => {
    const missed = barSplit(row({ mesId: 349, promptTokens: 45_356, timings: { cache_n: 1_733, prompt_n: 43_623 } }));
    const hit = barSplit(row({ timings: { cache_n: 38_797, prompt_n: 6_669 } }));

    assert.equal(missed.kind, 'measured');
    assert.equal(hit.kind, 'measured');
    assert.equal(missed.green, 1_733);
    assert.equal(hit.green, 38_797);
    assert.equal(missed.total, 45_356);
    assert.equal(hit.total, 45_466);

    // The prefix is identical on both, and it is a tick on both — never the segment.
    assert.equal(missed.prefixMark, 1_734);
    assert.equal(hit.prefixMark, 1_734);

    /**
     * @param {import('../bar.js').BarSpec} split A bar
     * @returns {number} The share of it that is green
     */
    const share = (split) => split.green / split.total;

    assert.ok(share(hit) > 0.85, `expected the cached turn above 85%, got ${share(hit)}`);
    assert.ok(share(missed) < 0.05, `expected the missed turn under 5%, got ${share(missed)}`);
});

test('the measured bar scales to the context window, so rows are comparable', () => {
    const split = barSplit(row({ timings: { cache_n: 38_797, prompt_n: 6_669 } }));

    assert.equal(split.denominator, 47_104);
    assert.equal(split.toWindow, true);
    assert.equal(split.inTokens, true);
    assert.match(split.title, /38,797 of 45,466 tokens reused \(85\.3%\)/);
});

test('no recorded window scales to the prompt and says the tail is not headroom', () => {
    const split = barSplit(row({ maxContext: 0, timings: { cache_n: 38_797, prompt_n: 6_669 } }));

    assert.equal(split.denominator, 45_466);
    assert.equal(split.toWindow, false);
});

// ⚠️ A CHARACTER COUNT OVER A TOKEN WINDOW IS A 4x LIE. 180,000 characters against a 47,104-token window
// paints a full bar for a prompt that is really about a quarter of the window. Characters may only ever be
// scaled to the prompt.
test('character counts never divide by the token window', () => {
    const split = barSplit(row({ promptTokens: null, prefixTokens: null }));

    assert.equal(split.kind, 'predicted');
    assert.equal(split.inTokens, false);
    assert.equal(split.green, 6_900);
    assert.equal(split.total, 180_000);
    assert.equal(split.denominator, 180_000);
    assert.equal(split.toWindow, false);
});

test('without a measurement the prefix is the bar, and says it is a prediction', () => {
    const split = barSplit(row({}));

    assert.equal(split.kind, 'predicted');
    assert.equal(split.green, 1_734);
    assert.equal(split.total, 45_466);
    assert.equal(split.denominator, 47_104);
    // Nothing to compare the prediction against, so there is no tick to draw beside it.
    assert.equal(split.prefixMark, null);
    assert.match(split.title, /LOWER bound/);
});

// The measurement does not depend on knowing what the prompt text was, so a row greyed for unknown
// provenance still gets a truthful bar — what is withheld is the divergence below it.
test('a greyed row still draws its measurement, and the tooltip says what is withheld', () => {
    const split = barSplit(row({
        greyed: true,
        greyedReason: 'final prompt not visible to the client',
        timings: { cache_n: 38_797, prompt_n: 6_669 },
    }));

    assert.equal(split.kind, 'measured');
    assert.equal(split.green, 38_797);
    // The prefix comparison is what cannot be stood behind, so the tick is suppressed even though the
    // segments are not.
    assert.equal(split.prefixMark, null);
    assert.match(split.title, /final prompt not visible to the client/);
});

test('a greyed row with no measurement draws no bar at all', () => {
    const split = barSplit(row({ greyed: true, greyedReason: 'evicted by a quiet generation' }));

    assert.equal(split.kind, 'greyed');
    assert.equal(split.total, 0);
    assert.equal(split.title, 'evicted by a quiet generation');
});

// §7.2 `empty-prev`: no baseline is not zero reuse, and a solid red bar would report a catastrophic miss
// where nothing happened at all.
test('the first turn renders no bar rather than a zero bar', () => {
    const split = barSplit(row({ hasBaseline: false, prefixTokens: null, prefixChars: 0 }));

    assert.equal(split.kind, 'no-baseline');
    assert.equal(split.total, 0);
});

test('the first turn WITH a measurement draws it, and says why it is all red', () => {
    const split = barSplit(row({
        hasBaseline: false,
        prefixTokens: null,
        prefixChars: 0,
        timings: { cache_n: 0, prompt_n: 45_466 },
    }));

    assert.equal(split.kind, 'measured');
    assert.equal(split.green, 0);
    assert.equal(split.prefixMark, null);
    assert.match(split.title, /nothing in the cache to reuse/);
});

// ⚠️ A hairline placed by a character offset against a token-scaled bar is the same lie as scaling the
// segments by characters, and worse for being thin and confident.
// Keep a case where the backend-measured split differs sharply from the prefix prediction. The measured value
// must remain the bar's segment; the prefix is only a lower-bound tick.
test('#353 — the row Test User reported: 82.6% green, and the prefix is only a tick', () => {
    const split = barSplit(row({
        mesId: 353,
        prefixChars: 6_800,
        promptTokens: 45_478,
        prefixTokens: 1_726,
        maxContext: 45_530,
        timings: { cache_n: 37_587, prompt_n: 7_891 },
    }));

    assert.equal(split.kind, 'measured');
    assert.equal(split.green, 37_587);
    assert.equal(split.total, 45_478);
    assert.equal(split.denominator, 45_530);

    // What the eye is asked for: overwhelmingly green. `panel.js:renderBar` turns these into widths with no
    // arithmetic of its own, so this ratio IS the bar.
    assert.ok(split.green / split.denominator > 0.8, `green was ${(split.green / split.denominator * 100).toFixed(1)}% of the window`);
    assert.ok((split.total - split.green) / split.denominator < 0.2);

    // ⚠️ AND THE 3.8% IS STILL THERE — as the tick, which is what he was seeing drawn as the segment. The
    // gap between these two numbers on one row is the entire finding of DESIGN.md §6.4.
    assert.equal(split.prefixMark, 1_726);
    assert.ok(split.prefixMark / split.denominator < 0.04);
    assert.ok(split.green > split.prefixMark * 20);
});

test('the tick waits for the tokenizer rather than using characters', () => {
    const split = barSplit(row({ prefixTokens: null, promptTokens: null, timings: { cache_n: 38_797, prompt_n: 6_669 } }));

    assert.equal(split.kind, 'measured');
    // The measurement is in tokens whatever the client tokenizer has done, so the bar is not provisional.
    assert.equal(split.inTokens, true);
    assert.equal(split.prefixMark, null);
});

// 🔴 §6.4a's other half. `eligible 1,734 (3.8%)` sat in the cost position and was read as a cost, on a turn
// that had actually reused 85.3%. The column now answers WHAT CHANGED and never prices anything.
test('the change column locates a cause and never quotes a reuse share', () => {
    const change = describeChange(row({}));

    assert.equal(change.label, 'changed at 1,734 (3.8% in)');
    assert.equal(change.muted, false);
    assert.doesNotMatch(change.label, /eligible|reus/i);
    assert.match(change.title, /does not price/);
});

test('the change column falls back to characters until the tokenizer answers', () => {
    const change = describeChange(row({ prefixTokens: null, promptTokens: null }));

    assert.equal(change.label, 'changed at 6,900 (3.8% in)');
});

test('a prompt entirely inside the shared prefix is unchanged, not 100% eligible', () => {
    const change = describeChange(row({ prefixChars: 180_000 }));

    assert.equal(change.label, 'unchanged');
});

test('the change column says nothing it cannot stand behind', () => {
    assert.equal(describeChange(row({ greyed: true, greyedReason: 'evicted' })).label, 'not established');
    assert.equal(describeChange(row({ greyed: true, greyedReason: 'evicted' })).muted, true);
    assert.equal(describeChange(row({ hasBaseline: false })).label, 'no baseline');
});

// 🔴 THE VERDICT IS THE §3.1 PAYOFF: the same divergence, opposite answers, and only the backend can tell
// them apart. #349 paid for its change in full; #350 did not pay for the same change at all.
test('#349 paid for the change, #350 did not', () => {
    const missed = verdictFor(row({ promptTokens: 45_356, timings: { cache_n: 1_733, prompt_n: 43_623 } }));
    const hit = verdictFor(row({ timings: { cache_n: 38_797, prompt_n: 6_669 } }));

    // Both turns are measured and diverge, so both have a verdict — asserted rather than assumed, because
    // a null here would otherwise read as a passing test that checked nothing.
    assert.ok(missed);
    assert.ok(hit);
    assert.equal(missed.kind, 'paid-in-full');
    assert.match(missed.text, /43,623 after this point/);
    assert.equal(hit.kind, 'recovered');
    assert.match(hit.text, /not what the turn paid for/);
});

// ⚠️ `cache_n` is the model's tokenizer and `prefixTokens` is the browser's. Comparing them is a signal;
// subtracting them and printing the difference would be dishonest, so the verdict never does.
test('the verdict never prints a client-minus-backend difference', () => {
    const hit = verdictFor(row({ timings: { cache_n: 38_797, prompt_n: 6_669 } }));

    assert.ok(hit);
    assert.doesNotMatch(hit.text, /37,063/);
});

test('a tokenizer disagreement of a few tokens does not read as recovery', () => {
    const verdict = verdictFor(row({ timings: { cache_n: 1_800, prompt_n: 43_666 } }));

    assert.ok(verdict);
    assert.equal(verdict.kind, 'paid-in-full');
});

test('there is no verdict without a measurement to base it on', () => {
    assert.equal(verdictFor(row({})), null);
    assert.equal(verdictFor(row({ greyed: true, timings: { cache_n: 100, prompt_n: 100 } })), null);
    assert.equal(verdictFor(row({ hasBaseline: false, timings: { cache_n: 0, prompt_n: 100 } })), null);
});

test('an unchanged prompt still gets its cost stated', () => {
    const verdict = verdictFor(row({ prefixChars: 180_000, timings: { cache_n: 45_000, prompt_n: 466 } }));

    assert.ok(verdict);
    assert.equal(verdict.kind, 'no-divergence');
    assert.match(verdict.text, /45,000 tokens and processed 466/);
});

test('with no token counts the verdict states the cost and refuses to link it to the change', () => {
    const verdict = verdictFor(row({ prefixTokens: null, promptTokens: null, timings: { cache_n: 38_797, prompt_n: 6_669 } }));

    assert.ok(verdict);
    assert.equal(verdict.kind, 'unmeasured');
    assert.match(verdict.text, /not yet known/);
});

// 🔴 DESIGN_RAW_GENERATION_ROWS.md §9 — THE PROVIDER-NEUTRAL MEASUREMENT MODEL.

test('measurementFromTimings reproduces measuredSplit exactly, including every refusal', () => {
    assert.deepEqual(
        measurementFromTimings({ cache_n: 38_797, prompt_n: 6_669, prompt_ms: 412.5 }),
        { source: 'llama-timings', inputTokens: 45_466, cachedTokens: 38_797, uncachedTokens: 6_669, prefillMs: 412.5 },
    );

    // No prompt_ms reported: null, never a zero — the same rule the DeepSeek adapter follows unconditionally.
    assert.deepEqual(
        measurementFromTimings({ cache_n: 0, prompt_n: 43_623 }),
        { source: 'llama-timings', inputTokens: 43_623, cachedTokens: 0, uncachedTokens: 43_623, prefillMs: null },
    );

    // Every refusal `measuredSplit` has, reproduced exactly: one count missing, a negative, both zero, no
    // timings at all.
    assert.equal(measurementFromTimings({ cache_n: 38_797 }), null);
    assert.equal(measurementFromTimings({ prompt_n: 6_669 }), null);
    assert.equal(measurementFromTimings({ cache_n: 38_797, prompt_n: null }), null);
    assert.equal(measurementFromTimings(null), null);
    assert.equal(measurementFromTimings({}), null);
    assert.equal(measurementFromTimings({ cache_n: -1, prompt_n: 10 }), null);
    assert.equal(measurementFromTimings({ cache_n: 0, prompt_n: 0 }), null);
});

test('measurementFromRawStamp returns a measurement only for available, internally consistent usage', () => {
    assert.deepEqual(
        measurementFromRawStamp(rawStamp({})),
        { source: 'deepseek-usage', inputTokens: 1_200, cachedTokens: 900, uncachedTokens: 300, prefillMs: null },
    );

    // absent, invalid, failed and cancelled all refuse — a raw stamp with none of `available`'s guarantees.
    assert.equal(measurementFromRawStamp(rawStamp({ usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null })), null);
    assert.equal(measurementFromRawStamp(rawStamp({ usageState: 'invalid' })), null);
    assert.equal(measurementFromRawStamp(rawStamp({ status: 'failed', usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null })), null);
    assert.equal(measurementFromRawStamp(rawStamp({ status: 'cancelled', usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null })), null);

    // Counts that do not sum are invalid whatever usageState claims.
    assert.equal(measurementFromRawStamp(rawStamp({ cachedTokens: 900, uncachedTokens: 301 })), null);

    // A negative count, or a null in place of a finite one — the same "both/all or neither" discipline as
    // `measuredSplit`.
    assert.equal(measurementFromRawStamp(rawStamp({ cachedTokens: -1, uncachedTokens: 1_201 })), null);
    assert.equal(measurementFromRawStamp(rawStamp({ inputTokens: null })), null);

    assert.equal(measurementFromRawStamp(null), null);
    assert.equal(measurementFromRawStamp(undefined), null);
});

// 🔴 DESIGN_RAW_GENERATION_ROWS.md §8, §10 — RAW ROWS.

test('barSplit dispatches on row.kind, and a message row with no kind at all behaves exactly as before', () => {
    // The defensive default: `row.kind` absent entirely still draws the ordinary message-row bar.
    const split = barSplit(row({ timings: { cache_n: 38_797, prompt_n: 6_669 } }));

    assert.equal(split.kind, 'measured');
    assert.equal(split.green, 38_797);
});

test('a raw row with available usage draws a measured bar scaled to inputTokens, never a window', () => {
    const split = barSplit(rawRow({ inputTokens: 1_200, cachedTokens: 900, uncachedTokens: 300 }));

    assert.equal(split.kind, 'raw-measured');
    assert.equal(split.green, 900);
    assert.equal(split.total, 1_200);
    assert.equal(split.denominator, 1_200);
    // Not a context-window estimate — a raw formatter request has no `this_max_context` to scale to.
    assert.equal(split.toWindow, false);
    assert.equal(split.inTokens, true);
    // No prompt comparison exists for a raw row, so there is nothing to tick.
    assert.equal(split.prefixMark, null);
    assert.match(split.title, /900 of 1,200 tokens reused \(75\.0%\), 300 processed/);
});

test('absent and invalid raw usage draw no green segment, with distinct kinds and titles, and never say 0', () => {
    const absent = barSplit(rawRow({ usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null }));
    const invalid = barSplit(rawRow({ usageState: 'invalid' }));

    assert.equal(absent.kind, 'raw-no-usage');
    assert.equal(absent.green, 0);
    assert.equal(absent.total, 0);
    assert.equal(absent.title, 'usage not reported');

    assert.equal(invalid.kind, 'raw-invalid-usage');
    assert.equal(invalid.green, 0);
    assert.equal(invalid.total, 0);
    assert.equal(invalid.title, 'invalid usage reported');

    assert.notEqual(absent.kind, invalid.kind);
    assert.notEqual(absent.title, invalid.title);
    // Neither title reports a count at all — "not reported" is not the same fact as "reported as zero".
    assert.doesNotMatch(absent.title, /\b0\b/);
    assert.doesNotMatch(invalid.title, /\b0\b/);
});

test('failed and cancelled raw requests show their status, an empty bar, and no cache ratio', () => {
    const failed = barSplit(rawRow({ status: 'failed', usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null }));
    const cancelled = barSplit(rawRow({ status: 'cancelled', usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null }));

    assert.equal(failed.kind, 'raw-failed');
    assert.equal(failed.green, 0);
    assert.equal(failed.total, 0);
    assert.match(failed.title, /failed/);

    assert.equal(cancelled.kind, 'raw-cancelled');
    assert.equal(cancelled.green, 0);
    assert.equal(cancelled.total, 0);
    assert.match(cancelled.title, /cancelled/);

    assert.notEqual(failed.kind, cancelled.kind);
    assert.notEqual(failed.title, cancelled.title);
});

test('status is checked before usage state, so a failed request never reads as merely "usage not reported"', () => {
    // A stamp that is somehow both failed and claims available usage still reports the failure — the status
    // is definitive about what happened to the request.
    const split = barSplit(rawRow({ status: 'failed' }));

    assert.equal(split.kind, 'raw-failed');
});

test('describeChange never claims "no baseline" for a raw row', () => {
    const change = describeChange(rawRow({}));

    assert.equal(change.muted, true);
    assert.notEqual(change.label, 'no baseline');
    assert.doesNotMatch(change.label, /no baseline/);
    assert.doesNotMatch(change.title, /first generation on this backend/);
});

test('verdictFor returns null for a raw row', () => {
    assert.equal(verdictFor(rawRow({})), null);
    assert.equal(verdictFor(rawRow({ status: 'failed', usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null })), null);
});

// `summaryFor` supplies the collapsed row's only text beside the bar. These tests pin its text and colorable
// counts; `barSplit` behavior is covered above.
test('summaryFor: a measured message row reports cached/uncached tokens and percentages, unmuted', () => {
    const summary = summaryFor(row({ timings: { cache_n: 9_800, prompt_n: 8_773 } }));

    assert.equal(summary.text, 'cached 9,800 (52.8%) · uncached 8,773 (47.2%)');
    assert.equal(summary.muted, false);
    assert.equal(summary.cached, 9_800);
    assert.equal(summary.uncached, 8_773);
});

test('summaryFor: a measured raw row reports cached/uncached tokens and percentages, unmuted', () => {
    const summary = summaryFor(rawRow({ inputTokens: 20_345, cachedTokens: 8_192, uncachedTokens: 12_153 }));

    assert.equal(summary.text, 'cached 8,192 (40.3%) · uncached 12,153 (59.7%)');
    assert.equal(summary.muted, false);
    assert.equal(summary.cached, 8_192);
    assert.equal(summary.uncached, 12_153);
});

test('summaryFor: a predicted row in tokens is prefixed "est." and muted', () => {
    const summary = summaryFor(row({ timings: null, promptTokens: 18_573, prefixTokens: 9_800 }));

    assert.equal(summary.text, `est. cached 9,800 (52.8%) · uncached 8,773 (47.2%)`);
    assert.equal(summary.muted, true);
    assert.match(summary.title, /lower-bound estimate/);
    assert.equal(summary.cached, 9_800);
    assert.equal(summary.uncached, 8_773);
});

test('summaryFor: a predicted row in characters notes " chars" and stays muted', () => {
    const summary = summaryFor(row({
        timings: null, promptTokens: null, prefixTokens: null, promptChars: 18_573, prefixChars: 9_800,
    }));

    assert.equal(summary.text, 'est. cached 9,800 (52.8%) chars · uncached 8,773 (47.2%) chars');
    assert.equal(summary.muted, true);
});

test('summaryFor: greyed, no-baseline and no-prompt rows all say "not measured" and never a 0', () => {
    const greyed = summaryFor(row({ greyed: true, greyedReason: 'a server plugin rewrote the prompt' }));
    const noBaseline = summaryFor(row({ hasBaseline: false, baselineMissing: 'first-turn' }));
    const noPrompt = summaryFor(row({ promptKnown: false, hasBaseline: false, baselineMissing: 'no-prompt' }));

    for (const summary of [greyed, noBaseline, noPrompt]) {
        assert.equal(summary.text, 'not measured');
        assert.equal(summary.muted, true);
        assert.equal(summary.cached, null);
        assert.equal(summary.uncached, null);
    }
});

test('summaryFor: raw failure states report their status text, muted, with no counts', () => {
    const failed = summaryFor(rawRow({ status: 'failed', usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null }));
    const cancelled = summaryFor(rawRow({ status: 'cancelled', usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null }));
    const noUsage = summaryFor(rawRow({ usageState: 'absent', inputTokens: null, cachedTokens: null, uncachedTokens: null }));
    const invalidUsage = summaryFor(rawRow({ usageState: 'invalid', inputTokens: null, cachedTokens: null, uncachedTokens: null }));

    assert.equal(failed.text, 'failed');
    assert.equal(cancelled.text, 'cancelled');
    assert.equal(noUsage.text, 'usage not reported');
    assert.equal(invalidUsage.text, 'invalid usage reported');

    for (const summary of [failed, cancelled, noUsage, invalidUsage]) {
        assert.equal(summary.muted, true);
        assert.equal(summary.cached, null);
        assert.equal(summary.uncached, null);
    }
});

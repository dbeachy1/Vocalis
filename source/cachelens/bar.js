/**
 * What the bar draws — pure, so the rule that decides what a row may claim is testable.
 *
 * 🔴 THE BAR DRAWS THE BACKEND'S MEASUREMENT WHENEVER THERE IS ONE, NEVER THE PREFIX PREDICTION.
 * Two consecutive real turns off a live 45,500-token chat carried an *identical* 1,734-token shared prefix
 * and reused 1,733 and 38,797 tokens respectively — 22× apart, and utterly indistinguishable to a prefix
 * comparison. Drawing the prefix painted the second turn 3.8% green on a turn that reused 85.3%.
 *
 * ⚠️ AND THE PREFIX IS A LOWER BOUND ON REUSE, NOT AN UPPER ONE. This corrects DESIGN.md §6.4, which had it
 * backwards. llama.cpp's `--cache-reuse` recovers content that only MOVED POSITION — exactly what trimming
 * the oldest messages out of a full context does every turn — and a prefix scan structurally cannot see that
 * recovery. So the prefix survives as a tick mark against the measurement, never as the green segment.
 *
 * The same module also decides the row's two labels, because they are the same distinction one step on:
 * `describeChange` says WHAT CHANGED and `verdictFor` says WHETHER THAT IS WHAT THE TURN PAID FOR. Keeping
 * them here keeps the panel from re-deriving either.
 *
 * This module imports nothing, like `prefix.js` and `attribution.js`, for the same reason: `panel.js` cannot
 * be loaded outside a browser, so any decision left in it is a decision no test can reach.
 *
 * 🔴 RAW ROWS ADD A SECOND MEASUREMENT SOURCE, AND ADAPTERS — NOT RENDERERS — UNDERSTAND PROVIDER SCHEMAS
 * (DESIGN_RAW_GENERATION_ROWS.md §9). `measurementFromTimings` and `measurementFromRawStamp` translate
 * llama.cpp's `timings` and a DeepSeek raw-request stamp into one provider-neutral `CacheMeasurement`, and
 * `barSplit` dispatches on `row.kind` before doing anything else: a `'raw'` row (§8, §10) has no prompt, no
 * baseline, no prefix and no divergence, so it never reaches the message-row logic below and never fabricates
 * a `describeChange`/`verdictFor` answer for a comparison that was never made. Missing usage is never zero —
 * "the provider reported no cache accounting" and "the provider reported zero reuse" are opposite facts, the
 * same rule `measuredSplit` already enforces for `cache_n`/`prompt_n` one paragraph down.
 */

/**
 * The backend's own split of a prompt it served.
 * @typedef {object} MeasuredSplit
 * @property {number} reused Tokens it reused from cache (`cache_n`)
 * @property {number} processed Tokens it actually processed (`prompt_n`)
 */

/**
 * What the full width of a bar represents.
 * @typedef {object} Scale
 * @property {number} denominator What 100% of the bar means
 * @property {boolean} toWindow Whether that denominator is the context window rather than the prompt
 * @property {boolean} inTokens Whether the counts are tokens. 🔴 THE WINDOW IS A LEGITIMATE
 * DENOMINATOR ONLY WHEN THIS IS TRUE — a character count over a token window paints a 45,000-character
 * prompt at 96% of a 47,104-token window when it is really about 24% of it.
 */

/**
 * The provider-neutral measurement `bar.js` and `panel.js` consume — one shape for every backend, built by
 * an adapter that understands that backend's own schema (DESIGN_RAW_GENERATION_ROWS.md §9).
 * @typedef {object} CacheMeasurement
 * @property {'llama-timings'|'deepseek-usage'} source Which adapter produced it
 * @property {number} inputTokens The whole prompt the provider was asked to process
 * @property {number} cachedTokens Tokens it reused
 * @property {number} uncachedTokens Tokens it actually processed
 * @property {number|null} prefillMs Milliseconds it spent on the prompt, or null when the provider does not
 * report one — DeepSeek never does, and inventing a zero there would be the exact substitution this module
 * forbids everywhere else (see `measuredSplit` above and `measurementFromRawStamp` below)
 */

/**
 * The raw-request stamp's shape, as far as this module reads it (DESIGN_RAW_GENERATION_ROWS.md §7.2).
 *
 * ⚠️ DUCK-TYPED, NOT IMPORTED. `persist.js` owns the real `RawRequestStamp` type and is being built
 * concurrently by another coder; importing it here would couple this pure module to a type that may not
 * exist yet. This module reads four fields and validates every one of them, the same discipline
 * `measuredSplit` already applies to `timings` below.
 * @typedef {object} RawStampLike
 * @property {'completed'|'failed'|'cancelled'|string} [status] The terminal state of the request
 * @property {'available'|'absent'|'invalid'|string} [usageState] Whether usage was captured
 * @property {number|null} [inputTokens] The whole prompt, when `usageState` is `'available'`
 * @property {number|null} [cachedTokens] Tokens reused, when `usageState` is `'available'`
 * @property {number|null} [uncachedTokens] Tokens processed, when `usageState` is `'available'`
 */

/**
 * Everything the bar needs, decided in one place.
 * @typedef {object} BarSpec
 * @property {string} kind `measured`, `no-prompt`, `greyed`, `no-baseline`, `predicted`, `raw-measured`,
 * `raw-no-usage`, `raw-invalid-usage`, `raw-failed` or `raw-cancelled`
 * @property {number} green The reused portion, in whatever units `inTokens` names
 * @property {number} total The whole prompt, in the same units
 * @property {number} denominator What 100% of the bar means
 * @property {boolean} toWindow Whether that denominator is the context window
 * @property {boolean} inTokens Whether the counts are tokens
 * @property {number|null} prefixMark Where to tick the prefix prediction on a measured bar. Tokens only —
 * a character offset against a token-scaled bar is the same 4x lie as scaling the segments by characters,
 * and worse for being a thin confident line.
 * @property {string} title What to say about it
 */

/**
 * The "what changed" column of a row.
 * @typedef {object} ChangeColumn
 * @property {string} label The short text
 * @property {string} title The tooltip
 * @property {boolean} muted Whether to render it as unavailable rather than as a number
 */

/**
 * Whether the change is what the turn paid for.
 * @typedef {object} Verdict
 * @property {string} kind `no-divergence`, `unmeasured`, `recovered` or `paid-in-full`
 * @property {string} text The sentence
 */

/**
 * Whether a count is a real number rather than absent.
 *
 * ⚠️ A TYPE PREDICATE, BECAUSE `Number.isFinite` ALONE DOES NOT NARROW A `number|null`. The counts are null
 * until the tokenizer answers, and the compiler has to be told that a finite one is no longer null — see
 * `barSplit`, where the prompt total is either a token count or a character count and mixing them is the
 * bug this module exists to prevent.
 * @param {number|null|undefined} value A count
 * @returns {value is number} Whether it is a real number
 */
function counted(value) {
    return Number.isFinite(value);
}

/**
 * @param {number|null|undefined} value A number, or the absence of one
 * @returns {string} It, with thousands separators, or an em dash when it is not a number — which is the
 * whole point of the function: a count nobody has taken renders as a dash, never as a zero
 */
export function fmt(value) {
    return counted(value) ? value.toLocaleString() : '—';
}

/**
 * @param {number} part A part
 * @param {number} whole The whole
 * @returns {string} The share, to one decimal, or an em dash when there is no whole
 */
export function pct(part, whole) {
    return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

/**
 * The backend's own split of the prompt it just served.
 *
 * 🔴 BOTH FIELDS OR NEITHER. `cache_n` alone cannot be drawn: the red segment would have to come from the
 * client tokenizer's estimate of the prompt, which merges a measurement with a prediction inside a single
 * bar and makes the result unreadable as either. DESIGN.md §6.4 — read the fields you want and treat missing
 * ones as missing, never substituted.
 * @param {import('./record.js').RawTimings|null|undefined} timings The backend's `timings` object,
 * passed through unaltered
 * @returns {MeasuredSplit|null} The split, or null when the backend did not report one
 */
export function measuredSplit(timings) {
    if (!timings || typeof timings !== 'object') {
        return null;
    }

    const { cache_n: reused, prompt_n: processed } = timings;

    // Both fields or neither — a backend that reported only one of them has not reported a split.
    if (!counted(reused) || !counted(processed)) {
        return null;
    }

    if (reused < 0 || processed < 0 || reused + processed === 0) {
        return null;
    }

    return { reused, processed };
}

/**
 * The llama.cpp adapter: turn `timings` into the provider-neutral measurement.
 *
 * 🔴 IMPLEMENTED IN TERMS OF `measuredSplit`, NEVER BY RESTATING ITS RULES. Both counts or neither, no
 * negatives, not both zero — `measuredSplit` already applies exactly those rules and is exported and relied
 * on elsewhere (other modules and the existing tests), so this calls it rather than duplicating its checks
 * and risking the two disagreeing later.
 * @param {import('./record.js').RawTimings|null|undefined} timings The backend's `timings` object,
 * passed through unaltered
 * @returns {CacheMeasurement|null} The measurement, or null when the backend did not report one
 */
export function measurementFromTimings(timings) {
    const measured = measuredSplit(timings);

    if (!measured) {
        return null;
    }

    return {
        source: 'llama-timings',
        inputTokens: measured.reused + measured.processed,
        cachedTokens: measured.reused,
        uncachedTokens: measured.processed,
        prefillMs: timings?.prompt_ms ?? null,
    };
}

/**
 * The DeepSeek adapter: turn a raw-request stamp into the provider-neutral measurement.
 *
 * 🔴 ONLY WHEN `usageState === 'available'` AND THE THREE COUNTS ARE INTERNALLY CONSISTENT. A `usageState`
 * of `'absent'` or `'invalid'` — or three counts that do not sum — means the provider did not hand back
 * something this module can stand behind, and `null` here is what tells `barSplit` not to draw a bar rather
 * than draw one from a zero it invented (DESIGN_RAW_GENERATION_ROWS.md §6.3, §9).
 * @param {RawStampLike|null|undefined} stamp The raw-request stamp, duck-typed
 * @returns {CacheMeasurement|null} The measurement, or null when there is nothing to draw
 */
export function measurementFromRawStamp(stamp) {
    if (!stamp || typeof stamp !== 'object' || stamp.usageState !== 'available') {
        return null;
    }

    const { inputTokens, cachedTokens, uncachedTokens } = stamp;

    if (!counted(inputTokens) || !counted(cachedTokens) || !counted(uncachedTokens)) {
        return null;
    }

    if (inputTokens < 0 || cachedTokens < 0 || uncachedTokens < 0) {
        return null;
    }

    if (cachedTokens + uncachedTokens !== inputTokens) {
        return null;
    }

    return {
        source: 'deepseek-usage',
        inputTokens,
        cachedTokens,
        uncachedTokens,
        // DeepSeek reports no prefill time. Inventing a zero here would be the exact substitution this
        // module forbids everywhere else — "not reported" and "reported as none" are opposite facts.
        prefillMs: null,
    };
}

/**
 * Everything the bar needs, decided in one place.
 *
 * ⚠️ THE WINDOW IS A LEGITIMATE DENOMINATOR ONLY WHEN THE NUMERATOR IS IN TOKENS. A character count over a
 * token window paints a 45,000-character prompt at 96% of a 47,104-token window when it is really about 24%
 * of it — a bar that is wrong by 4× while looking authoritative. When the counts are characters, or when no
 * window was recorded for the turn, the bar scales to the prompt instead and says its tail is not headroom.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @returns {BarSpec} What to draw and what to say about it
 */
export function barSplit(row) {
    // 🔴 DISPATCH FIRST, BEFORE ANY MESSAGE-ROW FIELD IS READ. A raw row has no prompt, no baseline, no
    // prefix and no divergence (DESIGN_RAW_GENERATION_ROWS.md §8, §10), so it must never fall into the
    // message-row logic below. Anything that is not literally `'raw'` — including a row with no `kind` field
    // at all — is treated as a message row, defensively, so nothing regresses if some caller has not been
    // updated to set `kind` yet.
    if (row.kind === 'raw') {
        return barSplitForRaw(row);
    }

    const measured = measuredSplit(row.timings);

    if (measured) {
        const total = measured.reused + measured.processed;
        // The measurement does not depend on knowing what the prompt text was, so a row greyed for unknown
        // provenance or an eviction still gets a truthful bar. Those flags describe confidence in the
        // PREDICTION, and the prediction is no longer what is being drawn — but they still qualify the tick
        // and the expansion below, so they are said out loud in the title.
        const notes = [
            `Measured by the backend: ${fmt(measured.reused)} of ${fmt(total)} tokens reused (${pct(measured.reused, total)}), ${fmt(measured.processed)} processed.`,
        ];

        // 🔴 "NO BASELINE" IS THREE DIFFERENT FACTS AND ONLY ONE OF THEM IS "THE CACHE WAS EMPTY".
        // Persistence added the other two: a stored row whose own prompt has aged out of the browser, and a
        // row whose PREDECESSOR's has. Both arrive here with `hasBaseline: false`, and this note used to
        // key off that alone — so either would have been announced as the first generation on the backend,
        // a confident claim about a turn that may be five hundred messages deep.
        const missing = row.baselineMissing === null ? null : {
            'first-turn': 'First generation on this backend — there was nothing in the cache to reuse.',
            'no-prompt': "Drawn from the measurement stored with this chat. The prompt itself is no longer in this browser's store, so there is nothing here to compare it against.",
            'predecessor-gone': "The previous turn's prompt is no longer in this browser's store, so there was nothing to compare this one against. The measurement is unaffected.",
        }[row.baselineMissing];

        if (missing) {
            notes.push(missing);
        }

        if (row.greyed) {
            notes.push(`The prompt text itself is not trustworthy here (${row.greyedReason || 'not established'}), so the divergence below is withheld — this measurement is not.`);
        }

        return {
            kind: 'measured',
            green: measured.reused,
            total,
            ...scaleTo(row, total, true),
            prefixMark: prefixMarkFor(row),
            title: notes.join(' '),
        };
    }

    // 🔴 BEFORE THE `hasBaseline` BRANCH, BECAUSE THAT BRANCH WOULD CALL THIS TURN THE FIRST OF THE CHAT.
    // A stamp with no `cache_n` on a turn whose prompt has aged out of IndexedDB reaches here with
    // `hasBaseline: false` and nothing else, and `no-baseline`'s sentence — "first turn, nothing was in the
    // cache" — would be a confident, wrong claim about an arbitrary turn. There is no bar to draw here and
    // no prediction to draw one from; what there is, is a reason.
    if (row.baselineMissing === 'no-prompt') {
        return {
            kind: 'no-prompt',
            green: 0,
            total: 0,
            denominator: 0,
            toWindow: false,
            inTokens: false,
            prefixMark: null,
            title: "The prompt for this turn is no longer in this browser's store, so nothing can be predicted or compared. The stored measurement is all this row has, and this backend did not report one.",
        };
    }

    if (row.greyed) {
        return {
            kind: 'greyed',
            green: 0,
            total: 0,
            denominator: 0,
            toWindow: false,
            inTokens: false,
            prefixMark: null,
            title: row.greyedReason || 'not established',
        };
    }

    if (!row.hasBaseline) {
        // No baseline is not zero reuse. The first turn of a chat had nothing in the cache to reuse, and a
        // solid red bar would report a catastrophic miss where nothing happened at all. Which of the two
        // reasons applies is stated rather than assumed — see the note in the measured branch above.
        return {
            kind: 'no-baseline',
            green: 0,
            total: 0,
            denominator: 0,
            toWindow: false,
            inTokens: false,
            prefixMark: null,
            title: row.baselineMissing === 'predecessor-gone'
                ? "the previous turn's prompt is no longer in this browser's store, so there is nothing to compare against"
                : 'first turn — nothing was in the cache to compare against',
        };
    }

    // Nothing measured, so the prediction is all there is. Tokens once the tokenizer has answered, characters
    // until then: the split is the same shape either way and the panel never blocks on the tokenizer
    // (DESIGN.md §10).
    // Both counts or neither, and read into consts so that `counted` can narrow them away from null.
    // A token total with a character prefix is the 4x lie `scaleTo` exists to prevent.
    const promptTokens = row.promptTokens;
    const prefixTokens = row.prefixTokens;
    const inTokens = counted(promptTokens) && counted(prefixTokens);
    const total = inTokens ? promptTokens : row.promptChars;
    const green = inTokens ? prefixTokens : row.prefixChars;

    return {
        kind: 'predicted',
        green,
        total,
        ...scaleTo(row, total, inTokens),
        prefixMark: null,
        title: `Predicted from the shared prefix — the backend did not report what it reused. A LOWER bound: cache-reuse recovers text that only moved position, and a prefix scan cannot see that.${inTokens ? '' : ' Character counts, until the tokenizer answers.'}`,
    };
}

/**
 * The summary shown beside a collapsed row's bar. Convert the existing `BarSpec` from `barSplit(row)` into
 * text and two colorable numbers without re-deriving its classification rules.
 *
 * 🔴 MISSING IS NEVER ZERO, HERE TOO. A `kind` with nothing measured (`greyed`, `no-baseline`, `no-prompt`,
 * `raw-failed`, `raw-cancelled`, `raw-no-usage`, `raw-invalid-usage`) returns `cached: null, uncached: null`
 * — never `0` — so `panel.js` cannot accidentally print a green zero for a turn nobody measured.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @returns {{ text: string, title: string, muted: boolean, cached: number|null, uncached: number|null }} The
 * summary line, its tooltip, whether to render it muted, and the two counts to color-tint (both null when
 * nothing was measured or predicted)
 */
export function summaryFor(row) {
    const split = barSplit(row);
    const uncounted = { cached: null, uncached: null };

    switch (split.kind) {
        case 'measured':
        case 'raw-measured': {
            const cached = split.green;
            const uncached = split.total - split.green;

            return {
                text: `cached ${fmt(cached)} (${pct(cached, split.total)}) · uncached ${fmt(uncached)} (${pct(uncached, split.total)})`,
                title: split.title,
                muted: false,
                cached,
                uncached,
            };
        }

        case 'predicted': {
            const cached = split.green;
            const uncached = split.total - split.green;
            const unit = split.inTokens ? '' : ' chars';

            return {
                text: `est. cached ${fmt(cached)} (${pct(cached, split.total)})${unit} · uncached ${fmt(uncached)} (${pct(uncached, split.total)})${unit}`,
                title: 'A lower-bound estimate from the shared prefix — the backend reported no cache usage for this turn.',
                muted: true,
                cached,
                uncached,
            };
        }

        case 'greyed':
        case 'no-baseline':
        case 'no-prompt':
            return { text: 'not measured', title: split.title, muted: true, ...uncounted };

        case 'raw-failed':
            return { text: 'failed', title: split.title, muted: true, ...uncounted };

        case 'raw-cancelled':
            return { text: 'cancelled', title: split.title, muted: true, ...uncounted };

        case 'raw-no-usage':
            return { text: 'usage not reported', title: split.title, muted: true, ...uncounted };

        case 'raw-invalid-usage':
            return { text: 'invalid usage reported', title: split.title, muted: true, ...uncounted };

        default:
            // Defensive only — `barSplit` is exhaustive over its own `kind` values today. Treated the same as
            // the other unmeasured kinds rather than throwing, so an unrecognized future kind degrades to
            // "not measured" instead of breaking the row.
            console.debug('[cache-lens] bar.js summaryFor: unrecognized BarSpec kind, treating as unmeasured', { kind: split.kind });
            return { text: 'not measured', title: split.title, muted: true, ...uncounted };
    }
}

/**
 * An empty raw-row bar — no green, no red, nothing to divide by. Every branch of `barSplitForRaw` that has
 * no measurement to draw shares this shape; only the `kind` and the `title` differ.
 * @param {string} kind One of the `raw-*` `BarSpec.kind` values
 * @param {string} title What to say about it
 * @returns {BarSpec} The empty bar
 */
function emptyRawBar(kind, title) {
    return { kind, green: 0, total: 0, denominator: 0, toWindow: false, inTokens: false, prefixMark: null, title };
}

/**
 * The raw-row branch of `barSplit` (DESIGN_RAW_GENERATION_ROWS.md §10).
 *
 * 🔴 STATUS BEFORE USAGE STATE. Design §11.1 says a failed or cancelled request "carries no usage", which in
 * practice means its stamp's `usageState` is already `'absent'` — but checking status first, rather than
 * falling through to the generic "usage not reported" branch, is what lets a failed row say it FAILED instead
 * of the strictly-true-but-unhelpful "usage not reported". A reader wants to know the request did not
 * complete, not that a field is empty.
 *
 * 🔴 NOT TO A CONTEXT-WINDOW ESTIMATE. A raw formatter request has no `this_max_context` — there is no prompt
 * whose window this row could report — and inventing one would repeat the 4x scaling lie `scaleTo` exists to
 * prevent for message rows. The measured bar is drawn to `inputTokens` and nothing else.
 * @param {import('./index.js').RawRow} row A raw row from `buildRows`
 * @returns {BarSpec} What to draw and what to say about it
 */
function barSplitForRaw(row) {
    const stamp = /** @type {RawStampLike|null|undefined} */ (row.stamp);

    if (stamp?.status === 'failed') {
        return emptyRawBar('raw-failed', 'This raw generation request failed. No cache accounting is available for it.');
    }

    if (stamp?.status === 'cancelled') {
        return emptyRawBar('raw-cancelled', 'This raw generation request was cancelled. No cache accounting is available for it.');
    }

    const measurement = measurementFromRawStamp(stamp);

    if (measurement) {
        return {
            kind: 'raw-measured',
            green: measurement.cachedTokens,
            total: measurement.inputTokens,
            denominator: measurement.inputTokens,
            toWindow: false,
            inTokens: true,
            // A raw row has no prompt to compare against, so there is no prefix prediction to tick.
            prefixMark: null,
            title: `Measured by the provider: ${fmt(measurement.cachedTokens)} of ${fmt(measurement.inputTokens)} tokens reused (${pct(measurement.cachedTokens, measurement.inputTokens)}), ${fmt(measurement.uncachedTokens)} processed. This is a raw generation request (a SillyTavern quiet generation) — there is no prompt baseline here to compare it against.`,
        };
    }

    if (stamp?.usageState === 'invalid') {
        // Not zero reuse — the provider's own counts did not add up, so nothing here can be drawn or trusted.
        return emptyRawBar('raw-invalid-usage', 'invalid usage reported');
    }

    // `usageState === 'absent'`, or a stamp too malformed to say otherwise. Never drawn as zero reuse: "the
    // provider reported no cache accounting" and "the provider reported zero reuse" are opposite facts.
    return emptyRawBar('raw-no-usage', 'usage not reported');
}

/**
 * 🔴 A `MessageRow`, NOT A `Row`. This is reachable only from the message-row path of `barSplit` and the
 * `predicted` branch below it — the raw-row branch returns before either is ever called — so the narrower,
 * more truthful type is the one that describes what this function actually receives.
 * @param {import('./index.js').MessageRow} row A message row
 * @param {number} total The prompt, in whatever units the bar is using
 * @param {boolean} inTokens Whether those units are tokens
 * @returns {Scale} What the full width represents
 */
function scaleTo(row, total, inTokens) {
    const toWindow = inTokens && row.maxContext > 0;

    return { denominator: toWindow ? row.maxContext : total, toWindow, inTokens };
}

/**
 * Where to tick the prefix prediction on a measured bar.
 *
 * ⚠️ TOKENS ONLY. A character offset placed against a token-scaled bar is the same 4× lie as scaling the
 * segments by characters, and it would be worse here for being a thin confident line.
 *
 * 🔴 A `MessageRow`, NOT A `Row` — only ever called from the measured branch of the message-row path in
 * `barSplit`, which a raw row never reaches.
 * @param {import('./index.js').MessageRow} row A message row
 * @returns {number|null} The prefix in tokens, or null when it should not be marked
 */
function prefixMarkFor(row) {
    const prefixTokens = row.prefixTokens;

    if (row.greyed || !row.hasBaseline || !counted(prefixTokens)) {
        return null;
    }

    return prefixTokens;
}

/**
 * How far into the prompt the text first changed — the "what changed" half of the row.
 *
 * 🔴 THIS NUMBER IS NOT A COST AND MUST NOT BE LABELLED AS ONE. It used to read `eligible 1,734 (3.8%)`
 * beside a turn that reused 85.3%, and a percentage in the cost position is read as a cost every time. Once
 * `--cache-reuse` is on, where the text changed and what the change cost are genuinely different questions:
 * the first finds the CAUSE (a lorebook entry that moves, a reply the client trimmed), the second is the
 * backend's own answer and is the only one that can price anything. DESIGN.md §6.4a.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @returns {ChangeColumn} The column
 */
export function describeChange(row) {
    // 🔴 A RAW ROW MUST NOT CLAIM `'no baseline'` (DESIGN_RAW_GENERATION_ROWS.md §10). That phrase means
    // "the first generation on this backend" — a confident, specific claim about chat history that would be
    // false for an arbitrary formatter request. A raw row has no prompt, no baseline and no prefix at all, so
    // this returns its own muted, raw-specific column rather than reusing message-row language that does not
    // apply to it. Decision recorded for `panel.js`: the column always renders (muted), it is never skipped.
    if (row.kind === 'raw') {
        return {
            label: 'no prompt comparison',
            title: 'This is a raw generation request (a SillyTavern quiet generation). It has no prompt baseline, no shared prefix and no divergence to compare — this column does not apply to it.',
            muted: true,
        };
    }

    if (row.greyed) {
        return {
            label: 'not established',
            title: row.greyedReason || 'The prompt as sent could not be established, so nothing can be compared against it.',
            muted: true,
        };
    }

    // Same ordering rule as `barSplit`: a turn whose prompt is gone is not a turn with no baseline, and
    // "no baseline" reads as "first turn of the chat" to everyone who sees it.
    if (row.baselineMissing === 'no-prompt') {
        return {
            label: 'prompt not kept',
            title: "The measurement for this turn was stored with the chat, but the prompt it was taken from is no longer in this browser's store — a long chat's store drops the oldest ones. The bar is still the backend's own number; only the comparison is missing.",
            muted: true,
        };
    }

    if (row.baselineMissing === 'predecessor-gone') {
        return {
            label: 'predecessor not kept',
            title: "The previous turn's prompt is no longer in this browser's store, so there is nothing to compare this one against. This is not the first turn of the chat and the cache was not empty — the comparison simply cannot be made from here.",
            muted: true,
        };
    }

    if (!row.hasBaseline) {
        return {
            label: 'no baseline',
            title: 'The first generation on this backend. There was no previous prompt to compare against.',
            muted: true,
        };
    }

    if (row.prefixChars >= row.promptChars) {
        return {
            label: 'unchanged',
            title: 'Every character of this prompt was already in the shared prefix — the healthy append-only turn.',
            muted: false,
        };
    }

    const prefixTokens = row.prefixTokens;
    const promptTokens = row.promptTokens;
    const inTokens = counted(prefixTokens) && counted(promptTokens) && promptTokens > 0;
    const at = inTokens ? prefixTokens : row.prefixChars;
    const of = inTokens ? promptTokens : row.promptChars;

    return {
        label: `changed at ${fmt(at)} (${pct(at, of)} in)`,
        title: `The first ${fmt(at)} ${inTokens ? 'tokens' : 'characters'} of this prompt are the same as last turn; it differs from there on. This locates the CAUSE of a cache break — it does not price one, because cache-reuse can recover text that only moved position.`,
        muted: false,
    };
}

/**
 * ⚠️ A CLIENT TOKEN COUNT AND A BACKEND TOKEN COUNT ARE NOT THE SAME RULER. `cache_n` comes from the model's
 * tokenizer and `prefixTokens` from whatever the browser had; comparing them is legitimate as a signal and
 * dishonest as a subtraction, so the verdict below never prints the difference. Two per cent of the prompt is
 * the slack — far more than any tokenizer disagreement, far less than the 22× gap this exists to name.
 */
const RECOVERY_SLACK = 0.02;

/**
 * Whether the change is what the turn paid for — the sentence that turns the divergence display from a cost
 * metric into a cause finder.
 *
 * The two live turns that motivated this had the SAME divergence and opposite answers: #349 reused 1,733
 * tokens against a 1,734-token prefix and reprocessed everything after it, while #350 reused 38,797 against
 * the same prefix because `--cache-reuse` recovered what had only moved position.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @returns {Verdict|null} The verdict, or null when there is nothing to say
 */
export function verdictFor(row) {
    // A raw row has no prompt comparison, so there is no divergence for a verdict to be about.
    if (row.kind === 'raw') {
        return null;
    }

    const measured = measuredSplit(row.timings);

    if (!measured || !row.hasBaseline || row.greyed) {
        return null;
    }

    if (row.prefixChars >= row.promptChars) {
        return {
            kind: 'no-divergence',
            text: `Nothing changed, and the backend reused ${fmt(measured.reused)} tokens and processed ${fmt(measured.processed)}.`,
        };
    }

    const prefixTokens = row.prefixTokens;
    const promptTokens = row.promptTokens;

    if (!counted(prefixTokens) || !counted(promptTokens) || promptTokens <= 0) {
        return {
            kind: 'unmeasured',
            text: `The backend reused ${fmt(measured.reused)} tokens and processed ${fmt(measured.processed)}. What that has to do with the change below is not yet known — the tokenizer has not answered.`,
        };
    }

    if (measured.reused - prefixTokens > promptTokens * RECOVERY_SLACK) {
        return {
            kind: 'recovered',
            text: `The backend reused ${fmt(measured.reused)} tokens — far more than the ${fmt(prefixTokens)} before this change. Most of what moved was recovered anyway (cache-reuse), so this change is not what the turn paid for.`,
        };
    }

    return {
        kind: 'paid-in-full',
        text: `Reuse stopped here: the backend reused ${fmt(measured.reused)} tokens and reprocessed ${fmt(measured.processed)} after this point. This change is what the turn paid for.`,
    };
}

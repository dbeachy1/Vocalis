/**
 * The measurement, written into the chat so it outlives the page that took it.
 *
 * 🔴 THE PROMPTS ALWAYS SURVIVED. THE MEASUREMENT NEVER DID. `itemized-prompts.js` persists every
 * `rawPrompt` and its component breakdown to IndexedDB keyed by chat id, and the chat itself is on the
 * server; none of that was ever the problem. What was written down nowhere is the backend's own report:
 * `GENERATION_TIMINGS` fires once, `noteTimings` puts the object in a RAM map keyed by `seq`, and the map
 * dies with the page. So leaving a chat and coming back drew a blank bar on every row — blank for the
 * honest reason, and unfixable by anything that does not write the number down.
 *
 * 🔴 AND RECOMPUTING ON LOAD IS A FABRICATION, WHICH IS THE WHOLE REASON THIS FILE EXISTS. The prompts
 * surviving makes "just re-run the prefix scan" the tempting one-liner, and it yields ELIGIBLE — a
 * different number from ACTUAL, measured 22x apart on two consecutive live turns. A rehydrated panel
 * drawing eligible would repaint a turn that reused 76.7% at 4.9% green and look completely normal. A
 * blank row is the honest rendering of a measurement nobody kept; a recomputed one is a lie that no
 * screenshot could catch. `cache_n` is a one-shot report about what the backend's cache physically held,
 * after `--cache-reuse` shifting and whatever eviction happened between turns. Captured, or gone.
 *
 * ⚠️ IT IMPORTS NOTHING, like `prefix.js` and `bar.js`, so what a stamp may hold and what a row may claim
 * from one are decided somewhere a test can reach. DESIGN.md §14.
 */

/**
 * The schema of what goes into `message.extra.cacheLens`.
 *
 * 🔴 BUMP THIS WHENEVER A FIELD CHANGES MEANING, NEVER MERELY WHEN ONE IS ADDED. `readStamp` refuses a
 * version it does not know, and refusing is the point: a stamp is a measurement, and a reader that
 * best-effort-parses an unfamiliar shape is guessing at numbers it will then print as facts.
 */
export const STAMP_VERSION = 1;

/**
 * What goes on the message, at `message.extra.cacheLens`.
 *
 * 🔴 EVERY NUMBER IS NULLABLE, AND NULL IS NEVER A ZERO. `finite` refuses a substituted zero on
 * purpose: "the backend reported no `cache_n`" and "the backend reported zero reuse" are opposite facts
 * about a blank column, and a schema that cannot hold the first one turns it into the second.
 *
 * ⚠️ TWO TOKEN COUNTS FROM TWO DIFFERENT RULERS LIVE IN HERE, NAMED APART ON PURPOSE. `promptTokens` and
 * `eligibleTokens` come from whatever tokenizer the browser had; `actualTokens` and `processedTokens` are
 * the backend's own, from the model's tokenizer. `bar.js` already forbids subtracting one from the other.
 * @typedef {object} Stamp
 * @property {number} v The schema version — `STAMP_VERSION` at the time it was written
 * @property {string|null} seq The correlation handle
 * @property {number|null} at Milliseconds since the epoch, for `describeAge`
 * @property {number} maxContext The context window this turn was sent into
 * @property {number} promptChars The whole prompt, in characters
 * @property {number} eligibleChars The shared prefix, in characters
 * @property {number|null} eligibleTokens The shared prefix, by the BROWSER's tokenizer
 * @property {number|null} promptTokens The whole prompt, by the BROWSER's tokenizer
 * @property {number|null} actualTokens What the BACKEND said it reused (`cache_n`)
 * @property {number|null} processedTokens What the BACKEND said it processed (`prompt_n`)
 * @property {number|null} promptMs What the backend spent on the prompt
 * @property {number|null} divergedAt Where the text first differed. NOT the same field as `eligibleChars`,
 * though a prefix scan makes them the same number — a turn with no baseline has an eligible prefix of zero
 * and no divergence at all, and the two read identically once both are 0 unless one may be null.
 * @property {string|null} baselineSeq The handle of what this was compared against
 * @property {string[]} rewrittenBy Server-side plugins that changed the prompt
 * @property {import('./record.js').RewriteSite[]} rewriteSites Where each of them wrote
 * @property {string[]} clientChanges Client-side components that differed from the previous turn
 * @property {number|null} requestAt DESIGN_RAW_GENERATION_ROWS.md §8: the matched server record's own `at`,
 * when one was found. ADDITIVE — a legacy stamp with none reads back as null and the row model falls back to
 * the existing measurement timestamp. Adding it does not change what any existing field means, which is why
 * `STAMP_VERSION` does not move for it (§13).
 */

/**
 * What `buildStamp` is handed. The same fields as a `Stamp`, but unvalidated and in whatever shape the
 * caller had them — `finite`, `handle`, `strings` and `sites` are what turn one into the other.
 * @typedef {object} StampFields
 * @property {*} [seq]
 * @property {*} [at]
 * @property {*} [maxContext]
 * @property {*} [promptChars]
 * @property {*} [eligibleChars]
 * @property {*} [eligibleTokens]
 * @property {*} [promptTokens]
 * @property {*} [actualTokens]
 * @property {*} [processedTokens]
 * @property {*} [promptMs]
 * @property {*} [divergedAt]
 * @property {*} [baselineSeq]
 * @property {*} [rewrittenBy]
 * @property {*} [rewriteSites]
 * @property {*} [clientChanges]
 * @property {*} [requestAt]
 */

/**
 * @param {*} value Anything
 * @returns {number|null} It, when it is a real number, and null otherwise — never a substituted zero
 */
function finite(value) {
    return Number.isFinite(value) ? value : null;
}

/**
 * @param {*} value Anything
 * @returns {string|null} The correlation handle as a string, or null
 */
function handle(value) {
    return value === null || value === undefined || value === '' ? null : String(value);
}

/**
 * @param {*} value Anything
 * @returns {string[]} Only the strings in it
 */
function strings(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

/**
 * The rewrite sites, in the shape `rewriteAt` and `describeRewrites` actually consume.
 * @param {*} value Anything
 * @returns {import('./record.js').RewriteSite[]} Sites
 */
function sites(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter(site => typeof site?.id === 'string' && Number.isFinite(site.delta) && Number.isFinite(site.atChar))
        .map(site => ({
            id: site.id,
            atChar: site.atChar,
            delta: site.delta,
            atFinal: finite(site.atFinal),
            prepended: site.prepended === true,
        }));
}

/**
 * Build the object that goes on the message.
 *
 * ⚠️ TWO TOKEN COUNTS FROM TWO DIFFERENT RULERS LIVE IN HERE, AND THEY ARE NAMED APART ON PURPOSE.
 * `promptTokens` and `eligibleTokens` come from whatever tokenizer the browser had; `actualTokens` and
 * `processedTokens` are the backend's own, from the model's tokenizer. `bar.js` already forbids
 * subtracting one from the other, and the fork's §16.3 field list called the backend's `prompt_n`
 * "promptTokens" — the same name this codebase uses for the client's count of the whole prompt. Keeping
 * that collision would have put the two rulers one typo apart, so `prompt_n` is `processedTokens` here.
 * @param {StampFields} fields Everything worth keeping about one generation
 * @returns {Stamp|null} The stamp, or null when there is nothing in it worth a byte
 */
export function buildStamp(fields) {
    const stamp = {
        v: STAMP_VERSION,
        seq: handle(fields.seq),
        at: finite(fields.at),
        maxContext: finite(fields.maxContext) ?? 0,
        promptChars: finite(fields.promptChars) ?? 0,
        eligibleChars: finite(fields.eligibleChars) ?? 0,
        eligibleTokens: finite(fields.eligibleTokens),
        promptTokens: finite(fields.promptTokens),
        actualTokens: finite(fields.actualTokens),
        processedTokens: finite(fields.processedTokens),
        promptMs: finite(fields.promptMs),
        // ⚠️ NOT THE SAME FIELD AS `eligibleChars`, THOUGH A PREFIX SCAN MAKES THEM THE SAME NUMBER. A turn
        // with no baseline has an eligible prefix of zero characters and NO divergence at all, and the two
        // read identically once both are 0 unless one of them is allowed to be null.
        divergedAt: finite(fields.divergedAt),
        baselineSeq: handle(fields.baselineSeq),
        rewrittenBy: strings(fields.rewrittenBy),
        rewriteSites: sites(fields.rewriteSites),
        clientChanges: strings(fields.clientChanges),
        // ADDITIVE (§8) — a legacy stamp with no `requestAt` reads back as null, same as any other absent
        // measurement, and never changes what version 1 meant before this field existed.
        requestAt: finite(fields.requestAt),
    };

    const measured = stamp.actualTokens !== null || stamp.processedTokens !== null || stamp.promptMs !== null;

    // 🔴 A STAMP WITH NO MEASUREMENT IS STILL WORTH WRITING, AND THAT IS §14.5's DISTINCTION. "The backend
    // reported no cache_n" and "nobody was recording when this turn happened" are different facts about a
    // blank column, and only a stamp that exists can tell them apart. What is worth nothing is a stamp for
    // a generation with neither a measurement nor a prompt behind it.
    if (!measured && stamp.promptChars === 0) {
        return null;
    }

    return stamp;
}

/**
 * The stamp as it sits in the chat file, before any of it is believed.
 *
 * 🔴 WHAT COMES OFF THE MESSAGE IS UNTRUSTED JSON, AND THE CAST SAYS SO RATHER THAN HIDING IT. Every
 * field read through this is then put through `finite`, `handle`, `strings` or `sites`, which is where the
 * actual validation lives — the cast buys property access, never belief. A chat file can hold a stamp
 * written by any build, including one newer than this code.
 * @param {STChatMessage|null|undefined} message A chat message
 * @returns {Record<string, unknown>|null} The raw object, or null when there is nothing object-shaped there
 */
function readRaw(message) {
    const raw = message?.extra?.cacheLens;

    if (!raw || typeof raw !== 'object') {
        return null;
    }

    return /** @type {Record<string, unknown>} */ (raw);
}

/**
 * The schema version of whatever is on this message, whether or not this build can read it.
 *
 * 🔴 SEPARATE FROM `readStamp` SO "TOO NEW TO READ" NEVER RENDERS AS "NOT RECORDED". Those are opposite
 * facts — one is a measurement this code cannot parse, the other is a turn nobody measured — and a panel
 * that collapses them tells a reader to stop looking for a number that is sitting right there in the chat
 * file. It is the same class of error as a stale tab reporting the deployed version.
 * @param {STChatMessage|null|undefined} message A chat message
 * @returns {number|null} The version on it, or null when there is no stamp at all
 */
export function stampVersionOf(message) {
    const raw = readRaw(message);

    return raw === null ? null : finite(raw.v);
}

/**
 * Read a stamp back, refusing anything this build does not understand.
 * @param {STChatMessage|null|undefined} message A chat message
 * @returns {Stamp|null} The normalized stamp, or null when there is none this build can read
 */
export function readStamp(message) {
    const raw = readRaw(message);

    if (raw === null || raw.v !== STAMP_VERSION) {
        return null;
    }

    return {
        v: STAMP_VERSION,
        seq: handle(raw.seq),
        at: finite(raw.at),
        maxContext: finite(raw.maxContext) ?? 0,
        promptChars: finite(raw.promptChars) ?? 0,
        eligibleChars: finite(raw.eligibleChars) ?? 0,
        eligibleTokens: finite(raw.eligibleTokens),
        promptTokens: finite(raw.promptTokens),
        actualTokens: finite(raw.actualTokens),
        processedTokens: finite(raw.processedTokens),
        promptMs: finite(raw.promptMs),
        divergedAt: finite(raw.divergedAt),
        baselineSeq: handle(raw.baselineSeq),
        rewrittenBy: strings(raw.rewrittenBy),
        rewriteSites: sites(raw.rewriteSites),
        clientChanges: strings(raw.clientChanges),
        requestAt: finite(raw.requestAt),
    };
}

/**
 * The stamp's measurement, in the shape the backend reported it — which is the shape `bar.js` reads.
 *
 * ⚠️ THE FIELD NAMES ARE THE BACKEND'S, NOT THIS MODULE'S, AND THAT IS DELIBERATE. `measuredSplit` and
 * `renderMeasured` read `cache_n` / `prompt_n` / `prompt_ms` off an object passed through unaltered from
 * llama.cpp. Handing them the same names means a rehydrated row goes down exactly the same code path as a
 * live one, rather than a parallel one that can drift away from it.
 * @param {Stamp|null} stamp From `readStamp`
 * @returns {import('./record.js').RawTimings|null} A timings object, or null when the stamp recorded
 * no measurement
 */
export function timingsFromStamp(stamp) {
    if (!stamp) {
        return null;
    }

    const raw = {};

    if (stamp.actualTokens !== null) {
        raw.cache_n = stamp.actualTokens;
    }

    if (stamp.processedTokens !== null) {
        raw.prompt_n = stamp.processedTokens;
    }

    if (stamp.promptMs !== null) {
        raw.prompt_ms = stamp.promptMs;
    }

    return Object.keys(raw).length > 0 ? raw : null;
}

/** Boundaries for `describeAge`, largest unit first. */
const AGE_STEPS = [
    { limit: 86_400_000 * 2, divisor: 86_400_000, unit: 'day' },
    { limit: 3_600_000 * 2, divisor: 3_600_000, unit: 'hour' },
    { limit: 60_000 * 2, divisor: 60_000, unit: 'minute' },
];

/**
 * How long ago the measurement was taken, in words.
 *
 * 🔴 THE AGE IS PART OF THE CLAIM, NOT DECORATION. A stat measured three days ago describes the backend as
 * it was configured three days ago — `--cache-reuse`, the slot count and the context size have all
 * changed under this panel before. §6.3 says state which source produced what you are showing; for a
 * stored measurement, WHEN is half of that sentence.
 * @param {number|null} at Milliseconds since the epoch, from the stamp
 * @param {number|null} now Milliseconds since the epoch, passed in rather than read, so this stays
 * testable — and nullable because the body checks it, even though the one production call site always has
 * a real clock to hand
 * @returns {string|null} A phrase like `3 days ago`, or null when the stamp carried no time
 */
export function describeAge(at, now) {
    if (at === null || now === null || !Number.isFinite(at) || !Number.isFinite(now)) {
        return null;
    }

    const elapsed = now - at;

    // A clock that went backwards — a resynced machine, a chat file from another box — is not an age, and
    // "in 3 days" printed beside a measurement would read as a bug in the measurement rather than in the
    // clock. Say it happened, and do not date it.
    if (elapsed < 0) {
        return 'earlier';
    }

    for (const step of AGE_STEPS) {
        if (elapsed >= step.limit) {
            const count = Math.floor(elapsed / step.divisor);

            return `${count} ${step.unit}${count === 1 ? '' : 's'} ago`;
        }
    }

    return 'just now';
}

/**
 * Raw-generation rows (SillyTavern `quiet` generations, DESIGN_RAW_GENERATION_ROWS.md).
 *
 * 🔴 A `quiet` GENERATION CREATES NO ASSISTANT MESSAGE, SO THERE IS NOTHING TO HANG A `message.extra.cacheLens`
 * STAMP ON. That is why this schema lives under `chatMetadata.cacheLens` instead of on a message — §7.1. It is
 * a second, sibling envelope to the per-message one above, not a replacement for it, and it obeys the same
 * rule this whole file is built around: a null is never a zero, and missing is never normalized to zero.
 */

/**
 * The schema of `chatMetadata.cacheLens`.
 *
 * 🔴 BUMP THIS WHENEVER A FIELD'S MEANING CHANGES, NEVER MERELY WHEN ONE IS ADDED — the same rule
 * `STAMP_VERSION` states above, for the same reason: `readRawRequests` refuses an envelope it does not
 * recognize rather than guessing at an unfamiliar shape and printing the guess as a measurement.
 */
export const RAW_ENVELOPE_VERSION = 1;

/**
 * One raw-generation measurement, as persisted at `chatMetadata.cacheLens.rawRequests[]` (§7.2).
 *
 * 🔴 THIS STAMP CONTAINS NO PROMPT LENGTH, PROMPT HASH, TEXT, RESPONSE TEXT, REASONING, PROVIDER ERROR BODY,
 * HEADERS, MODEL CREDENTIALS, OR USER IDENTITY (§12). That is the entire reason this feature is allowed to
 * exist: a raw formatter request never becomes roleplay history, and this schema is the enforcement point —
 * a field that is not declared here cannot be written here.
 *
 * ⚠️ `inputTokens` / `cachedTokens` / `uncachedTokens` ARE NULL WHENEVER `usageState` IS NOT `'available'`,
 * NEVER A SUBSTITUTED ZERO — same rule as every numeric field in `Stamp` above. `usageState: 'absent'` means
 * the backend reported no cache accounting for this request; `usageState: 'invalid'` means it reported
 * something self-contradictory. Both are opposite facts from "the backend said zero," and a schema that
 * cannot hold them separately would turn one into the other.
 * @typedef {object} RawRequestStamp
 * @property {number} v The entry schema version — `RAW_ENVELOPE_VERSION` at the time it was written
 * @property {string} id The prompt-record UUID (`recordId`, §6.1) — durable merge-by-id identity. Never the
 * `seq`, which restarts with the server process (§11.2) and is never a safe deduplication key.
 * @property {string|null} backend The backend family the request went through (e.g. `'chat'`)
 * @property {string|null} apiType The specific API within that backend (e.g. `'deepseek'`)
 * @property {string|null} seq The correlation handle in effect when this was captured — display-only here;
 * `id` is what `mergeRawRequests` keys on
 * @property {string|null} generationType SillyTavern's own generation type — `'quiet'` for every row this
 * release renders (§2.1)
 * @property {number} requestedAt Milliseconds since the epoch, defaulting to 0 like `Stamp.maxContext` above
 * when the source did not carry one — this is an ordering field (§8), not a measurement, so it follows the
 * same "default rather than null" convention as `maxContext`/`promptChars`/`eligibleChars`
 * @property {number} completedAt Milliseconds since the epoch; same default-to-0 convention as `requestedAt`
 * @property {'completed'|'failed'|'cancelled'} status The record's terminal state (§11.1) — a raw stamp is
 * never built for a `pending` record, so this schema has no place to put one
 * @property {'available'|'absent'|'invalid'} usageState Whether the token counts below mean anything
 * @property {number|null} inputTokens Total tokens the backend reported for this request's input
 * @property {number|null} cachedTokens How many of those the backend reused from its cache
 * @property {number|null} uncachedTokens How many of those the backend actually processed
 */

/**
 * What `buildRawStamp` is handed — the same fields as a `RawRequestStamp`, unvalidated and in whatever shape
 * the caller had them, mirroring `StampFields` above.
 * @typedef {object} RawRequestFields
 * @property {*} [id]
 * @property {*} [backend]
 * @property {*} [apiType]
 * @property {*} [seq]
 * @property {*} [generationType]
 * @property {*} [requestedAt]
 * @property {*} [completedAt]
 * @property {*} [status]
 * @property {*} [usageState]
 * @property {*} [inputTokens]
 * @property {*} [cachedTokens]
 * @property {*} [uncachedTokens]
 */

/**
 * @param {*} value Anything
 * @returns {'completed'|'failed'|'cancelled'|null} `value`, when it is one of `RawRequestStamp.status`'s
 * three legal values (§11.1), and null otherwise. A concrete checker rather than a generic `oneOf` over an
 * array, matching this file's existing preference (`finite`, `handle`, `strings`, `sites`) for small typed
 * helpers over one generic — and it is what lets TypeScript narrow the result to the literal union instead of
 * widening it back to `string`.
 */
function rawStatus(value) {
    return value === 'completed' || value === 'failed' || value === 'cancelled' ? value : null;
}

/**
 * @param {*} value Anything
 * @returns {'available'|'absent'|'invalid'|null} `value`, when it is one of `RawRequestStamp.usageState`'s
 * three legal values, and null otherwise
 */
function rawUsageState(value) {
    return value === 'available' || value === 'absent' || value === 'invalid' ? value : null;
}

/**
 * @param {*} value Anything
 * @returns {number|null} It, when it is a real, non-negative INTEGER, and null otherwise. Stricter than
 * `finite` above because a raw token count is a physical quantity a backend cannot report negative or
 * fractional — §6.3 requires "finite, non-negative integers" of the Taproom normalizer that produces these,
 * and this is the same rule enforced again on the untrusted-JSON side of the boundary (§7.2), in case a
 * hand-edited chat file or an older/buggy writer put something else there.
 *
 * Token counts from persisted chat data are untrusted. Require a non-negative integer here as on the capture
 * path; this also rejects `NaN`, infinity, and fractional counts before the consistency check.
 */
function nonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Validate and normalize one raw-generation record's fields into a `RawRequestStamp`, or refuse it.
 *
 * Shared by `buildRawStamp` (fresh data from the prompt-record read API) and the per-entry reader inside
 * `readRawRequests` (persisted JSON coming back out) — both cross the same untrusted boundary the header
 * comment above describes, so both get the same validation rather than two versions that can drift apart.
 * @param {*} fields Whatever the caller or the chat file had
 * @returns {RawRequestStamp|null} The stamp, or null when there is nothing worth keeping
 */
function normalizeRawFields(fields) {
    const id = handle(fields?.id);
    const status = rawStatus(fields?.status);

    // 🔴 NOTHING WORTH KEEPING WITHOUT BOTH AN IDENTITY AND A RECOGNIZED TERMINAL STATUS. `id` is the
    // merge-by-id key (§7.4 step 7, §11.2) — a stamp without one can never be deduplicated or upgraded, only
    // ever duplicated on the next capture. A status this build does not recognize (including `'pending'`,
    // which should never have reached here — §7.4 step 5) is not a fact this code can render honestly, so it
    // is refused here exactly the way `readStamp` above refuses a schema version it does not know.
    if (id === null || status === null) {
        console.debug('[cache-lens] persist.js normalizeRawFields: refused, no identity or no recognized terminal status', {
            id, rawStatus: fields?.status,
        });

        return null;
    }

    // 🔴 FAILED AND CANCELLED REQUESTS CARRY NO USAGE (§11.1), REGARDLESS OF WHAT THE INPUT CLAIMED. Forcing
    // this rather than trusting an incoming `usageState` keeps a stray usage object attached to a failed or
    // cancelled record from ever reaching a row as a fabricated measurement.
    const usageEligible = status === 'completed';
    let usageState = usageEligible ? (rawUsageState(fields?.usageState) ?? 'absent') : 'absent';

    let inputTokens = null;
    let cachedTokens = null;
    let uncachedTokens = null;

    if (usageState === 'available') {
        inputTokens = nonNegativeInteger(fields?.inputTokens);
        cachedTokens = nonNegativeInteger(fields?.cachedTokens);
        uncachedTokens = nonNegativeInteger(fields?.uncachedTokens);

        // 🔴 "AVAILABLE" IS A CLAIM THE NUMBERS MUST BACK UP, OR IT IS WITHDRAWN. An entry claiming available
        // usage but missing one of the three counts, or whose counts do not sum honestly (§6.3 rule 6: cached
        // <= input and cached + uncached === input), is self-contradictory input arriving across the §7.2
        // untrusted-JSON boundary. Rendering it anyway would draw a bar built from a partly-fabricated
        // measurement — the exact fabrication this whole module exists to refuse. Demote to invalid and
        // withhold all three rather than keeping two real numbers beside a silent zero.
        const consistent = inputTokens !== null && cachedTokens !== null && uncachedTokens !== null
            && cachedTokens <= inputTokens && cachedTokens + uncachedTokens === inputTokens;

        if (!consistent) {
            console.debug('[cache-lens] persist.js normalizeRawFields: demoted available usage to invalid, self-contradictory input', {
                id, inputTokens, cachedTokens, uncachedTokens,
            });

            usageState = 'invalid';
            inputTokens = null;
            cachedTokens = null;
            uncachedTokens = null;
        }
    }

    console.debug('[cache-lens] persist.js normalizeRawFields: accepted', { id, status, usageState, inputTokens, cachedTokens, uncachedTokens });

    return {
        v: RAW_ENVELOPE_VERSION,
        id,
        backend: handle(fields?.backend),
        apiType: handle(fields?.apiType),
        seq: handle(fields?.seq),
        generationType: handle(fields?.generationType),
        requestedAt: finite(fields?.requestedAt) ?? 0,
        completedAt: finite(fields?.completedAt) ?? 0,
        status,
        usageState,
        inputTokens,
        cachedTokens,
        uncachedTokens,
    };
}

/**
 * Build a raw-generation stamp from a metadata-only prompt-record projection (§6.6, §7.4 step 6).
 * @param {RawRequestFields} fields Everything worth keeping about one `quiet` generation
 * @returns {RawRequestStamp|null} The stamp, or null when there is nothing in it worth a byte — no
 * identifiable record, or a status this build does not understand as terminal
 */
export function buildRawStamp(fields) {
    return normalizeRawFields(fields);
}

/**
 * Read the raw-request envelope's version off a chat's metadata, whether or not this build can read the
 * envelope itself.
 *
 * 🔴 SEPARATE FROM `readRawRequests` FOR EXACTLY THE REASON `stampVersionOf` IS SEPARATE FROM `readStamp`
 * ABOVE. "Too new to read" and "nothing recorded" are opposite facts, and the panel states the first once in
 * its mode text (§7.2) rather than silently rendering as though nothing were ever captured.
 * @param {Record<string, unknown>|null|undefined} chatMetadata The chat's own metadata object
 * @returns {number|null} The version present, or null when there is no `cacheLens` envelope at all
 */
export function rawEnvelopeVersionOf(chatMetadata) {
    const cacheLens = chatMetadata && typeof chatMetadata === 'object' ? chatMetadata.cacheLens : null;

    if (!cacheLens || typeof cacheLens !== 'object') {
        return null;
    }

    return finite(/** @type {{ v?: unknown }} */ (cacheLens).v);
}

/**
 * One entry of `chatMetadata.cacheLens.rawRequests`, before any of it is believed.
 * @param {*} raw Whatever sat in the array
 * @returns {RawRequestStamp|null} The normalized stamp, or null when the entry is malformed or too new
 */
function readRawEntry(raw) {
    if (!raw || typeof raw !== 'object' || raw.v !== RAW_ENVELOPE_VERSION) {
        // An entry version this build does not know is refused exactly like an unknown envelope version —
        // §13's "entry version" carve-out exists so one future-shaped record does not poison a whole list.
        console.debug('[cache-lens] persist.js readRawEntry: skipped, not an object or unrecognized entry version', {
            entryVersion: raw && typeof raw === 'object' ? /** @type {{ v?: unknown }} */ (raw).v : undefined,
        });

        return null;
    }

    const normalized = normalizeRawFields(raw);

    if (normalized === null) {
        return null;
    }

    // Preserve unknown optional fields for forward compatibility. Normalized fields are spread second, so
    // known fields still replace the untrusted input values and remain subject to validation.
    return /** @type {RawRequestStamp} */ ({ ...raw, ...normalized });
}

/**
 * Read every raw-generation stamp back out of a chat's metadata, refusing what this build cannot understand.
 *
 * 🔴 EVERY READ CROSSES AN UNTRUSTED JSON BOUNDARY (§7.2). This never throws: an unreadable envelope answers
 * an empty list rather than an exception, and a malformed individual entry is skipped while its valid
 * siblings still render — a hand-edited chat file, a partial write, or a future build's entry shape must
 * never take down the whole panel.
 * @param {Record<string, unknown>|null|undefined} chatMetadata The chat's own metadata object
 * @returns {RawRequestStamp[]} The stamps this build can read, oldest-array-order preserved; empty when
 * there is no envelope, the envelope version is unrecognized, or `rawRequests` is not an array
 */
export function readRawRequests(chatMetadata) {
    const cacheLens = chatMetadata && typeof chatMetadata === 'object' ? chatMetadata.cacheLens : null;

    if (!cacheLens || typeof cacheLens !== 'object') {
        // Not logged as a refusal — "no cacheLens object at all" is the ordinary, expected shape of a chat
        // with no raw-generation history yet, not a malformed read. `rawEnvelopeVersionOf` is the place a
        // caller checks "too new to read" versus "nothing recorded" (§7.2's mode-text distinction).
        return [];
    }

    const envelopeVersion = /** @type {{ v?: unknown }} */ (cacheLens).v;

    if (envelopeVersion !== RAW_ENVELOPE_VERSION) {
        console.debug('[cache-lens] persist.js readRawRequests: envelope version unreadable by this build', { envelopeVersion, expected: RAW_ENVELOPE_VERSION });

        return [];
    }

    const rawRequests = /** @type {{ rawRequests?: unknown }} */ (cacheLens).rawRequests;

    if (!Array.isArray(rawRequests)) {
        console.debug('[cache-lens] persist.js readRawRequests: rawRequests is not an array', { rawRequestsType: typeof rawRequests });

        return [];
    }

    const stamps = [];

    for (const entry of rawRequests) {
        const stamp = readRawEntry(entry);

        if (stamp !== null) {
            stamps.push(stamp);
        }
    }

    if (stamps.length !== rawRequests.length) {
        console.debug('[cache-lens] persist.js readRawRequests: skipped malformed entries', {
            total: rawRequests.length, kept: stamps.length, skipped: rawRequests.length - stamps.length,
        });
    }

    return stamps;
}

/**
 * Where `usageState` ranks for `betterUsage` below — higher means more informative.
 *
 * `absent` and `invalid` are distinct states, not degrees of completeness, so a newer capture may correct
 * either one. `available` outranks both because it includes token counts.
 */
const USAGE_STATE_RANK = { absent: 0, invalid: 0, available: 1 };

/**
 * Decide the winning usage group (`usageState` plus its token trio) between `existing` and `incoming` for the
 * same record id.
 *
 * 🔴 THE FOUR FIELDS MOVE AS ONE UNIT, NEVER FIELD BY FIELD. A token count is only meaningful paired with the
 * state that claims it available — filling `inputTokens` from one source while `usageState` comes from
 * another is exactly the self-contradictory "half-valid stamp" `normalizeRawFields` above already refuses to
 * build in the first place, and a field-wise fill would reintroduce it one merge later.
 * @param {RawRequestStamp} existing What is already stored for this id
 * @param {RawRequestStamp} incoming The freshly built candidate for the same id
 * @returns {{ usageState: RawRequestStamp['usageState'], inputTokens: number|null, cachedTokens: number|null, uncachedTokens: number|null }}
 * The winning group, copied whole from whichever side wins
 */
function betterUsage(existing, incoming) {
    const existingRank = USAGE_STATE_RANK[existing.usageState] ?? 0;
    const incomingRank = USAGE_STATE_RANK[incoming.usageState] ?? 0;
    const winner = incomingRank >= existingRank ? incoming : existing;

    return { usageState: winner.usageState, inputTokens: winner.inputTokens, cachedTokens: winner.cachedTokens, uncachedTokens: winner.uncachedTokens };
}

/**
 * Fields, besides the usage group `betterUsage` decides separately, that may be individually backfilled from
 * `existing` when `incoming` is missing them. Never `v`, `id`, or `status` — `v` and `id` are always present
 * by construction, and `status` is terminal and never transitions (§11.1), so there is nothing to fill.
 */
const FILLABLE_FIELDS = ['backend', 'apiType', 'seq', 'generationType', 'requestedAt', 'completedAt'];

/**
 * Whether `value` counts as "nothing recorded yet" for `field`, and so may be filled from an older entry.
 *
 * ⚠️ `requestedAt`/`completedAt` USE `0` AS THEIR ABSENT-SENTINEL, NOT `null` — the same default-rather-
 * -than-null convention `RawRequestStamp.requestedAt`'s own doc comment states, mirroring `Stamp.maxContext`
 * above. Every other fillable field is a nullable handle, so `null` is what "missing" means for those.
 * @param {string} field One of `FILLABLE_FIELDS`
 * @param {*} value The field's current value
 * @returns {boolean} True when `value` is that field's "nothing recorded" sentinel
 */
function isMissingField(field, value) {
    return field === 'requestedAt' || field === 'completedAt' ? value === 0 : value === null;
}

/**
 * Decide what should be stored for one record id, given what is already there and what a fresh capture
 * produced for the same id — §7.4 step 7's "moves from incomplete legacy data to a terminal validated form."
 *
 * Merge newer usage information without discarding populated identity fields. A higher usage rank must not
 * replace the whole entry when the incoming capture omits backend, API type, sequence, or generation type.
 *
 * The promise now actually holds. NEVER LETS A REGRESSION WIN: every field in `FILLABLE_FIELDS` is filled
 * from `existing` only when `incoming` is missing it, never the other way round, and the usage group is
 * decided as one atomic unit by `betterUsage` rather than field by field, for the reason stated there. When
 * nothing is gained and nothing is lost, the result is field-for-field identical to `existing` — which is
 * what keeps `mergeRawRequests` idempotent and §7.4 step 9's "no-op does not save" true, exactly as before.
 * @param {RawRequestStamp} existing What is already stored for this id
 * @param {RawRequestStamp} incoming The freshly built candidate for the same id
 * @returns {RawRequestStamp} What should be stored for this id — a field-wise combination of the two, never
 * a wholesale swap of one for the other. Any unknown sibling keys `existing` carried survive
 * on the result, because `incoming` never carries them to overwrite what `existing` has
 */
function mergeRawEntry(existing, incoming) {
    const merged = /** @type {Record<string, unknown>} */ ({ ...existing, ...incoming });

    for (const field of FILLABLE_FIELDS) {
        const now = /** @type {Record<string, unknown>} */ (incoming)[field];
        const was = /** @type {Record<string, unknown>} */ (existing)[field];

        if (isMissingField(field, now) && !isMissingField(field, was)) {
            merged[field] = was;
        }
    }

    const usage = betterUsage(existing, incoming);

    merged.usageState = usage.usageState;
    merged.inputTokens = usage.inputTokens;
    merged.cachedTokens = usage.cachedTokens;
    merged.uncachedTokens = usage.uncachedTokens;

    return /** @type {RawRequestStamp} */ (merged);
}

/**
 * Whether two raw stamps agree on every field `RawRequestStamp` declares. Used only to detect a genuine no-op
 * (§7.4 step 9) — deliberately ignores unknown sibling keys because they cannot differ
 * between `existing` and a `mergeRawEntry` result (`incoming` never supplies them) and so can never be the
 * reason something "changed".
 * @param {RawRequestStamp} a One stamp
 * @param {RawRequestStamp} b The other
 * @returns {boolean} True when every declared field matches
 */
function sameRawStamp(a, b) {
    return a.v === b.v && a.id === b.id && a.backend === b.backend && a.apiType === b.apiType
        && a.seq === b.seq && a.generationType === b.generationType && a.requestedAt === b.requestedAt
        && a.completedAt === b.completedAt && a.status === b.status && a.usageState === b.usageState
        && a.inputTokens === b.inputTokens && a.cachedTokens === b.cachedTokens && a.uncachedTokens === b.uncachedTokens;
}

/**
 * Merge freshly captured raw stamps into the ones already persisted, deduplicating by `id` alone.
 *
 * 🔴 NEVER BY TIMESTAMP, SEQ, OR COMPLETION ORDER (§11.2). `seq` restarts with the server process and two
 * concurrent tabs share one handle/backend stream, so only `id` (the prompt-record UUID) is safe identity.
 * @param {RawRequestStamp[]} existing What is already in `chatMetadata.cacheLens.rawRequests`
 * @param {RawRequestStamp[]} incoming Freshly built candidates from this capture pass
 * @returns {{ merged: RawRequestStamp[], changed: boolean }} The merged list, in `existing`'s order with
 * unseen `incoming` ids appended in their given order, and whether anything actually moved — §7.4 step 9
 * forbids saving when `changed` is false
 */
export function mergeRawRequests(existing, incoming) {
    const existingList = Array.isArray(existing) ? existing : [];
    const incomingList = Array.isArray(incoming) ? incoming : [];

    const byId = new Map(existingList.map(stamp => [stamp.id, stamp]));
    let changed = false;
    let appended = 0;
    let upgraded = 0;

    for (const candidate of incomingList) {
        if (!candidate || typeof candidate.id !== 'string') {
            continue;
        }

        const current = byId.get(candidate.id);

        if (current === undefined) {
            byId.set(candidate.id, candidate);
            changed = true;
            appended++;
            continue;
        }

        const combined = mergeRawEntry(current, candidate);

        if (!sameRawStamp(current, combined)) {
            byId.set(candidate.id, combined);
            changed = true;
            upgraded++;
        }
    }

    console.debug('[cache-lens] persist.js mergeRawRequests: merged', {
        existingCount: existingList.length, incomingCount: incomingList.length, appended, upgraded, changed,
    });

    const merged = [];
    const seen = new Set();

    for (const stamp of existingList) {
        const current = byId.get(stamp.id);

        if (current !== undefined && !seen.has(stamp.id)) {
            merged.push(current);
            seen.add(stamp.id);
        }
    }

    for (const candidate of incomingList) {
        if (candidate && typeof candidate.id === 'string' && !seen.has(candidate.id)) {
            merged.push(/** @type {RawRequestStamp} */ (byId.get(candidate.id)));
            seen.add(candidate.id);
        }
    }

    return { merged, changed };
}

/**
 * Install the raw-request envelope onto a chat's metadata, preserving every unknown sibling field.
 *
 * 🔴 NEVER REPLACES `chatMetadata` OR `chatMetadata.cacheLens` WHOLESALE (§7.1). This extension owns only the
 * versioned raw-request fields; a writer that assigned a brand-new object to either would discard whatever a
 * lorebook, a summarizer, or a future Cache Lens version put beside them. Mutates only the object handed to
 * it — the caller owns deciding whether and when to call `context.saveMetadata()`.
 * @param {Record<string, unknown>|null|undefined} chatMetadata The chat's own metadata object
 * @param {RawRequestStamp[]} stamps The full list to install — callers pass `mergeRawRequests(...).merged`
 * @returns {void}
 */
export function writeRawRequests(chatMetadata, stamps) {
    if (!chatMetadata || typeof chatMetadata !== 'object') {
        // Nothing to mutate. A caller handing this anything else has already lost the chat-identity guard
        // §7.4 step 8 requires be checked before every write, so refusing here is correct rather than
        // throwing — the caller is responsible for verifying identity before ever reaching this call. Logged
        // rather than silently swallowed, because a caller that ever hits this has a bug worth finding.
        console.debug('[cache-lens] persist.js writeRawRequests: refused, chatMetadata is not an object', { chatMetadataType: typeof chatMetadata });

        return;
    }

    const existingCacheLens = /** @type {{ cacheLens?: unknown }} */ (chatMetadata).cacheLens;
    const siblingFields = existingCacheLens && typeof existingCacheLens === 'object' ? existingCacheLens : {};
    const rawRequests = Array.isArray(stamps) ? stamps : [];

    console.debug('[cache-lens] persist.js writeRawRequests: installing envelope', {
        count: rawRequests.length, hadPriorSiblingFields: Object.keys(siblingFields).length > 0,
    });

    chatMetadata.cacheLens = {
        ...siblingFields,
        v: RAW_ENVELOPE_VERSION,
        rawRequests,
    };
}

/**
 * DeepSeek input/cache usage: a pure normalizer for the JSON shape, and a bounded streaming observer for
 * the SSE shape. Both exist so `chat-completions.js` can hand DeepSeek's own accounting to
 * `finalizePromptRecord()` without any other module ever having an opinion about DeepSeek's wire format —
 * see Cache Lens raw generation rows design §5 (dependency direction) and §6.3/§6.5.
 *
 * 🔴 THIS FILE NEVER SEES A PROMPT, A COMPLETION, OR REASONING TEXT. Both exports below take or observe
 * only the `usage` object DeepSeek reports and discard everything else immediately — the streaming
 * observer in particular forwards every byte it is given unchanged and keeps no copy of any of them past
 * the moment it decides whether they contained a `usage` object. See §12 (privacy and security).
 */

import { Transform } from 'node:stream';

import { log, LogClass } from './logger.js';

/**
 * A finite, non-negative integer — the only shape any token count in a DeepSeek usage object is allowed to
 * have. Anything else (negative, fractional, `NaN`, a string) is not "close enough to zero" or "close
 * enough to a number"; design §6.3 rule 1 requires this exactly.
 *
 * ⚠️ `null` AND `undefined` ARE ABSENT, NOT INVALID, AND `readCount` BELOW IS WHERE THAT IS DECIDED — this
 * comment used to list `null` among the values this function rejects, which described neither the code nor
 * the behavior anyone wants. A provider sending `prompt_cache_hit_tokens: null` is saying it has no value
 * for the field, which is the same thing as omitting it; treating that as a contradiction would report
 * `invalid` for a response that is merely quiet, and §6.3 rule 8 is explicit that missing is never
 * normalized to zero and never inflated into an error.
 * @param {unknown} value
 * @returns {boolean}
 */
function isCountValue(value) {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * The provider-neutral input/cache usage measurement Cache Lens draws its raw-row bar from.
 * @typedef {object} InputCacheUsage
 * @property {"input-cache-v1"} schema
 * @property {number} inputTokens
 * @property {number} cachedTokens
 * @property {number} uncachedTokens
 * @property {"deepseek"} provider
 * @property {"chat-completions"} api
 */

/**
 * Normalize a DeepSeek Chat Completions `usage` object into the provider-neutral input/cache shape.
 *
 * Pure and total: for any input, including `undefined`, `null`, or garbage, this returns exactly one of
 * the three states below and never throws.
 *
 * Rules, in order (design §6.3):
 * 1. Accept only finite, non-negative integers for every count considered below — see {@link isCountValue}.
 *    A count that is PRESENT but fails this check makes the whole result `invalid`, even if a fallback
 *    field would otherwise have produced a valid answer; a provider that sent one bad number for a field is
 *    not trusted to have the alternate field right either.
 * 2. Prefer `prompt_cache_hit_tokens` for `cachedTokens`; fall back to `prompt_tokens_details.cached_tokens`
 *    when `prompt_cache_hit_tokens` is absent.
 * 3. Prefer `prompt_cache_miss_tokens` for `uncachedTokens`.
 * 4. Prefer `prompt_tokens` for `inputTokens`; if absent and `prompt_cache_hit_tokens` /
 *    `prompt_cache_miss_tokens` are both present and valid, use their sum.
 * 5. If miss is absent but input and cached are both present and valid, derive
 *    `uncachedTokens = inputTokens - cachedTokens`.
 * 6. Require `cachedTokens <= inputTokens` and `cachedTokens + uncachedTokens === inputTokens`.
 * 7. Contradictory or negative values produce `invalid`. 🔴 NO PARTIAL MEASUREMENT IS EVER EXPOSED — a
 *    result is either the fully-checked triple, or none of it; there is no shape in which two of the three
 *    counts are returned and the third is missing.
 * 8. Missing cache fields produce `absent`. 🔴 MISSING IS NEVER NORMALIZED TO ZERO. "The provider reported
 *    no cache accounting" (this generation's `usage` object simply has no
 *    `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`/`prompt_tokens_details.cached_tokens`, which is
 *    exactly what a plain OpenAI-shaped `usage` object with only `prompt_tokens`/`completion_tokens`/
 *    `total_tokens` looks like) and "the provider reported zero reuse" are opposite facts, and a schema
 *    that stored the first as `cachedTokens: 0` would silently turn one into the other. `usageState`
 *    exists so this schema can hold both without conflating them.
 *
 * The DeepSeek Responses API reserved mapping (not implemented — see design §4 and §6.3, an explicit
 * non-goal until a Responses transport exists): `input_tokens` -> `inputTokens`,
 * `input_tokens_details.cached_tokens` -> `cachedTokens`, `input_tokens - cached_tokens` -> `uncachedTokens`.
 * This normalizer also accepts the flat `cached_tokens` field returned by text-completion providers. Its
 * established export name remains for compatibility; accepted shapes are listed at `cachedTokens` below.
 * @param {unknown} usage The raw `usage` object from a chat- or text-completions response, or a parsed SSE
 * `usage` field
 * @param {{provider?: string, api?: string}} [origin] What produced it, for the record's own provenance
 * fields. Defaults to DeepSeek chat completions, which was the only caller when this was written.
 * @returns {{usageState: "available", usage: InputCacheUsage} | {usageState: "absent"} | {usageState: "invalid"}}
 */
export function normalizeDeepSeekChatUsage(usage, origin = {}) {
    if (usage === null || typeof usage !== 'object') {
        return { usageState: 'absent' };
    }

    let sawInvalidField = false;

    /**
     * Classify one raw field: a valid count, `undefined` for absent, or `undefined` while flagging
     * `sawInvalidField` for present-but-bad. The caller cannot tell "absent" from "invalid" from the
     * return value alone by design — rule 1 above means ANY invalid field anywhere invalidates the whole
     * result, so the distinction only has to be made once, at the end.
     * @param {unknown} value
     * @returns {number|undefined}
     */
    const readCount = (value) => {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (isCountValue(value)) {
            return value;
        }
        sawInvalidField = true;
        return undefined;
    };

    const hit = readCount(usage.prompt_cache_hit_tokens);
    const detailsCached = readCount(usage.prompt_tokens_details?.cached_tokens);
    // Some text-completion providers place `cached_tokens` directly on `usage`, rather than under
    // `prompt_tokens_details` or `prompt_cache_hit_tokens`.
    const flatCached = readCount(usage.cached_tokens);
    const miss = readCount(usage.prompt_cache_miss_tokens);
    const promptTokens = readCount(usage.prompt_tokens);

    if (sawInvalidField) {
        return { usageState: 'invalid' };
    }

    // Rule 2: prefer prompt_cache_hit_tokens, then prompt_tokens_details.cached_tokens, then a flat
    // cached_tokens. Ordered most-specific first: the two DeepSeek-native spellings before the generic
    // OpenAI-compatible one, so a provider that sends both is read the way its own documentation says.
    const cachedTokens = hit !== undefined ? hit : (detailsCached !== undefined ? detailsCached : flatCached);

    // Rule 3: uncachedTokens comes from prompt_cache_miss_tokens when it was present.
    let uncachedTokens = miss;

    // Rule 4: inputTokens prefers prompt_tokens; else the sum of hit/miss when BOTH are present and valid.
    let inputTokens = promptTokens;
    if (inputTokens === undefined && hit !== undefined && miss !== undefined) {
        inputTokens = hit + miss;
    }

    // Rule 5: derive uncachedTokens from inputTokens - cachedTokens when miss is absent but the other two
    // are present. A negative result here is a genuine contradiction (the provider's own cached count
    // exceeds its own input count) and is caught by the consistency check below rather than special-cased
    // here — there is nothing more this function can decide by rejecting it earlier.
    if (uncachedTokens === undefined && inputTokens !== undefined && cachedTokens !== undefined) {
        uncachedTokens = inputTokens - cachedTokens;
    }

    // Rule 8: any of the three still missing means the provider's usage object carried no usable cache
    // accounting at all — absent, not a fabricated zero.
    if (cachedTokens === undefined || uncachedTokens === undefined || inputTokens === undefined) {
        return { usageState: 'absent' };
    }

    // Rule 6/7: internal consistency. A provider reporting cachedTokens > inputTokens, or whose hit/miss do
    // not sum to its own inputTokens, has sent numbers that cannot both be true — reject the whole triple.
    if (cachedTokens > inputTokens || uncachedTokens < 0 || cachedTokens + uncachedTokens !== inputTokens) {
        return { usageState: 'invalid' };
    }

    return {
        usageState: 'available',
        usage: {
            schema: 'input-cache-v1',
            inputTokens,
            cachedTokens,
            uncachedTokens,
            provider: typeof origin.provider === 'string' && origin.provider ? origin.provider : 'deepseek',
            api: typeof origin.api === 'string' && origin.api ? origin.api : 'chat-completions',
        },
    };
}

/**
 * Upper bound on how many bytes of ONE incomplete SSE event this observer will hold before giving up on it
 * (design §6.5). This is not a limit on the stream as a whole — bytes are forwarded unconditionally and
 * without limit regardless of this bound; it only bounds the private buffer this module keeps while
 * waiting for a blank line to complete the event it is currently trying to read.
 *
 * 🔴 4 MiB, BECAUSE A RUNAWAY BUFFER HERE MUST NEVER BECOME A SECOND DENIAL-OF-SERVICE SURFACE ON TOP OF
 * WHATEVER THE PROVIDER IS ALREADY SENDING. A single SSE `usage` event is a few hundred bytes; anything
 * that grows an "incomplete event" past a few megabytes without a blank line is not a slow network, it is
 * either a malformed/adversarial upstream or a proxy that stripped the event framing — in either case the
 * right answer is to stop trying to parse THIS request's usage, not to keep growing a private buffer
 * alongside whatever backpressure the actual response body is already managing on its own.
 */
export const MAX_INCOMPLETE_SSE_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * Find the next SSE event boundary in `buffer` — a blank line, i.e. two line terminators back to back with
 * nothing between them.
 *
 * This scans raw bytes rather than decoding to text first, and that is deliberate: `0x0A` (LF) and `0x0D`
 * (CR) never appear as part of a multi-byte UTF-8 continuation sequence (continuation bytes are always
 * `0x80`-`0xBF`), so a byte-level scan for these two values is well-defined regardless of where a chunk
 * boundary happens to fall inside a multi-byte character. Handles `"\n\n"`, `"\r\n\r\n"`, `"\n\r\n"` and
 * `"\r\n\n"` — i.e. either side of the blank line may be LF or CRLF independently, which covers every SSE
 * producer this module is likely to see without assuming one house style.
 * @param {Buffer} buffer
 * @returns {{eventEnd: number, nextStart: number}|null} `eventEnd` is where the event's own text ends (the
 * terminator of its last content line, exclusive of the blank line itself); `nextStart` is where the next
 * event's bytes begin. `null` when no complete blank-line boundary exists yet.
 */
function findEventBoundary(buffer) {
    let i = 0;

    while (i < buffer.length) {
        if (buffer[i] !== 0x0A) {
            i += 1;
            continue;
        }

        const lineEnd = i + 1;

        if (buffer[lineEnd] === 0x0A) {
            // "\n\n"
            return { eventEnd: lineEnd, nextStart: lineEnd + 1 };
        }

        if (buffer[lineEnd] === 0x0D && buffer[lineEnd + 1] === 0x0A) {
            // "\n\r\n" — also matches the second half of "\r\n\r\n", since we only look at what follows
            // this LF and do not care what preceded it.
            return { eventEnd: lineEnd, nextStart: lineEnd + 2 };
        }

        i = lineEnd;
    }

    return null;
}

/**
 * A DeepSeek Chat Completions streaming response, observed for `usage` while every byte is forwarded to
 * the browser unchanged. A Node `Transform`, so the caller pipes it directly into the existing forwarding
 * path: `providerResponse.body.pipe(observer).pipe(expressResponse)`.
 *
 * 🔴 FORWARDING IS UNCONDITIONAL AND COMES FIRST. `_transform` calls `this.push(chunk)` before doing
 * anything else, and every parsing step after that is wrapped so that nothing it does — a thrown error, an
 * unexpected shape, the overflow bound above — can delay, alter, or drop a single byte already pushed. See
 * design §6.5: "forwards each byte immediately and unchanged" is the first bullet for a reason.
 *
 * 🔴 NOTHING PARSED HERE IS EVER LOGGED. `_processEventText` parses only enough of each `data:` line to
 * find a `usage` object, hands it to {@link normalizeDeepSeekChatUsage}, and discards the parsed value
 * immediately; the only things that reach the log are the module's own decisions (disabled, overflowed,
 * usage available) and the resulting NUMBERS, never the SSE text itself. See design §12.
 */
export class DeepSeekUsageObserver extends Transform {
    /**
     * @param {object} [options]
     * @param {string} [options.recordId] The prompt-record id this stream belongs to. Used only to label
     * this observer's own log lines so they can be matched to the eventual `finalizePromptRecord` call;
     * never sent anywhere and never itself sensitive.
     */
    constructor({ recordId } = {}) {
        super();

        /** @type {string|undefined} */
        this._recordId = recordId;
        /** @type {Buffer} Bytes since the last complete SSE event boundary. Bounded by {@link MAX_INCOMPLETE_SSE_EVENT_BYTES}. */
        this._eventBuffer = Buffer.alloc(0);
        /** @type {boolean} False once overflow or a parsing error has permanently disabled observation for this stream. */
        this._observing = true;
        /** @type {boolean} Whether observation was disabled specifically by the size bound, vs. never observing anything. */
        this._overflowed = false;
        /** @type {InputCacheUsage|null} The most recent VALID usage seen. Never overwritten by a later invalid one. */
        this._latestAvailable = null;
        /** @type {boolean} Whether at least one usage-bearing event failed normalization, for when no valid one ever arrives. */
        this._sawInvalidUsage = false;
    }

    /**
     * @param {Buffer} chunk
     * @param {BufferEncoding} _encoding
     * @param {(error?: Error|null) => void} callback
     */
    _transform(chunk, _encoding, callback) {
        // Unconditional and first: see the class doc. Nothing below this line may affect what was just
        // pushed.
        this.push(chunk);

        if (this._observing) {
            try {
                this._observe(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            } catch {
                // A bug in this parser must never be able to break the stream it only watches.
                //
                // 🔴 A FIXED REASON CODE, NEVER THE EXCEPTION'S MESSAGE. This code handles provider bytes,
                // and V8's own `JSON.parse` messages quote up to ~30 characters of the offending input
                // (`Unexpected token 'x', "…" is not valid JSON`). Today the only parse is caught locally in
                // `_processEventText` and its error never reaches here — so nothing leaks — but that is a
                // fact about the current call graph rather than a property of this line, and the whole point
                // of the SSE observer is that it never lets stream content out. Pinning the reason to a
                // literal closes it permanently instead of relying on the next editor noticing.
                this._disableObservation('parse-error');
            }
        }

        callback();
    }

    /**
     * @param {(error?: Error|null) => void} callback
     */
    _flush(callback) {
        // Some SSE producers close the connection right after the final event without a trailing blank
        // line. Give whatever is left one last look as though the stream's end were itself the boundary,
        // so a usage event landing in the very last write is not silently dropped.
        if (this._observing && this._eventBuffer.length > 0) {
            try {
                this._processEventText(this._eventBuffer.toString('utf8'));
            } catch {
                // Same rule as `_transform`'s catch above: the fact is loggable, the exception's message is
                // not, because this one is raised by code holding the tail of a provider stream.
                log.debug(LogClass.NORMAL, `DeepSeek usage observer: error parsing trailing stream data at close (recordId ${this._recordId ?? 'unknown'}); the message is withheld because it can quote stream content.`);
            }
        }

        this._eventBuffer = Buffer.alloc(0);
        callback();
    }

    /**
     * @param {Buffer} chunk
     */
    _observe(chunk) {
        this._eventBuffer = this._eventBuffer.length === 0 ? chunk : Buffer.concat([this._eventBuffer, chunk]);

        for (;;) {
            const boundary = findEventBoundary(this._eventBuffer);

            if (!boundary) {
                break;
            }

            const eventText = this._eventBuffer.subarray(0, boundary.eventEnd).toString('utf8');
            // Copy rather than keep a subarray view: a view would keep the whole underlying (possibly
            // large) concatenated allocation alive for as long as any slice of it is referenced.
            this._eventBuffer = Buffer.from(this._eventBuffer.subarray(boundary.nextStart));

            this._processEventText(eventText);
        }

        if (this._eventBuffer.length > MAX_INCOMPLETE_SSE_EVENT_BYTES) {
            this._disableObservation('overflow');
        }
    }

    /**
     * @param {string} eventText One complete SSE event's text, terminator included, blank line excluded.
     */
    _processEventText(eventText) {
        const lines = eventText.split(/\r\n|\n|\r/);

        for (const line of lines) {
            if (!line.startsWith('data:')) {
                continue;
            }

            const payload = line.slice('data:'.length).trim();

            if (payload === '' || payload === '[DONE]') {
                continue;
            }

            /** @type {unknown} */
            let parsed;

            try {
                parsed = JSON.parse(payload);
            } catch {
                // Not JSON, or truncated by something between us and the provider. There is nothing else
                // to do with a line this module cannot parse, and the bytes were already forwarded
                // untouched regardless — see the class doc. Never log `payload` itself.
                continue;
            }

            this._considerUsage(/** @type {{usage?: unknown}} */ (parsed)?.usage);
        }
    }

    /**
     * @param {unknown} rawUsage The `usage` field of one parsed SSE data chunk, if it had one
     */
    _considerUsage(rawUsage) {
        if (rawUsage === undefined || rawUsage === null || typeof rawUsage !== 'object') {
            return;
        }

        const normalized = normalizeDeepSeekChatUsage(rawUsage);

        if (normalized.usageState === 'available') {
            // Retains only the latest VALID usage object (design §6.5): this overwrites any previous valid
            // one, and a later invalid one (handled below) will never overwrite this.
            this._latestAvailable = normalized.usage;
            log.debug(LogClass.NORMAL, `DeepSeek usage observer: usage available (recordId ${this._recordId ?? 'unknown'}, inputTokens=${normalized.usage.inputTokens} cachedTokens=${normalized.usage.cachedTokens} uncachedTokens=${normalized.usage.uncachedTokens}).`);
        } else if (normalized.usageState === 'invalid') {
            this._sawInvalidUsage = true;
            log.debug(LogClass.NORMAL, `DeepSeek usage observer: a usage object in the stream failed normalization (recordId ${this._recordId ?? 'unknown'}).`);
        }
        // 'absent' here just means this particular usage object had no cache-accounting fields — not news,
        // and not distinguishable in the final result from never having seen a usage object at all.
    }

    /**
     * @param {string} reason For the log line only; never anything derived from stream content.
     */
    _disableObservation(reason) {
        if (!this._observing) {
            return;
        }

        this._observing = false;
        this._eventBuffer = Buffer.alloc(0);

        if (reason === 'overflow') {
            this._overflowed = true;
            log.debug(LogClass.NORMAL, `DeepSeek usage observer: incomplete SSE event exceeded ${MAX_INCOMPLETE_SSE_EVENT_BYTES} bytes, disabling usage observation for this request; forwarding is unaffected (recordId ${this._recordId ?? 'unknown'}).`);
        } else {
            log.debug(LogClass.NORMAL, `DeepSeek usage observer: disabling usage observation for this request; forwarding is unaffected (recordId ${this._recordId ?? 'unknown'}). Reason: ${reason}`);
        }
    }

    /**
     * The observed result, in exactly the shape {@link normalizeDeepSeekChatUsage} returns — so a caller
     * can pass it straight through to `finalizePromptRecord({ ..., ...observer.getResult() })`.
     *
     * Precedence: an overflow always wins (design §6.5: overflow explicitly records `invalid`); otherwise
     * the latest VALID usage object wins if one was ever seen, regardless of any invalid ones seen before
     * or after it; otherwise `invalid` if at least one usage object was seen but never validly; otherwise
     * `absent`, meaning no usage object was ever observed in this stream at all.
     * @returns {{usageState: "available", usage: InputCacheUsage} | {usageState: "absent"} | {usageState: "invalid"}}
     */
    getResult() {
        if (this._overflowed) {
            return { usageState: 'invalid' };
        }

        if (this._latestAvailable) {
            return { usageState: 'available', usage: { ...this._latestAvailable } };
        }

        if (this._sawInvalidUsage) {
            return { usageState: 'invalid' };
        }

        return { usageState: 'absent' };
    }
}

/**
 * Convenience factory, equivalent to `new DeepSeekUsageObserver(options)`. Exists so a caller that is
 * otherwise functional-style (`chat-completions.js` is) does not need a bare `new` in the middle of a
 * pipe chain.
 * @param {object} [options]
 * @param {string} [options.recordId]
 * @returns {DeepSeekUsageObserver}
 */
export function createDeepSeekUsageObserver(options) {
    return new DeepSeekUsageObserver(options);
}

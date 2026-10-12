/**
 * The outgoing-prompt record — what was ACTUALLY sent, reported back to the client that sent it.
 *
 * `generation-interceptors.js` lets a server plugin rewrite the prompt on its way to the model. That module
 * describes itself as the mirror of the client's `runGenerationInterceptors`, and it is — but it left the
 * mirror half-built. A plugin can now change the prompt, and NOBODY can see the result. The browser still
 * holds the string it assembled (`itemizedPrompts[].rawPrompt`, which is what the prompt-itemization popup
 * shows), and the moment any interceptor is registered that string stops being what the model received.
 * Nothing reports the difference, so every client-side consumer of the prompt is quietly wrong.
 *
 * 🔴 THIS IS NOT A DIAGNOSTIC FOR ONE EXTENSION. It reports the outgoing prompt; it has no opinion about what
 * anyone does with it. A KV-cache view compares successive prompts, an audit tool asks what a plugin
 * injected, a token-accounting extension wants the real length. Every one of those is a consumer, and none of
 * their algorithms belong here — this stores the prompt and says who changed it, and that is all.
 *
 * Ten recent prompts are kept in memory and are never written to disk. Retention is fixed so consumers can
 * resolve the records the feature promises to expose.
 *
 * ⚠️ NEVER PERSISTED, BY DESIGN AND NOT BY OMISSION. A file of recent prompts would be a new artifact holding
 * a copy of the conversation, sitting outside the encrypted store and surviving a restart nobody asked it to
 * survive — in a fork whose headline property is that a running SillyTavern does not write your chat anywhere
 * (`README.md`). The prompt is in memory for the length of the request regardless; this keeps the last few,
 * and a process restart is the end of them.
 */

import crypto from 'node:crypto';

import { log, LogClass } from './logger.js';
import { analyzeGeometry, parsePromptShape, describeShapeChange, describeLayout, describePartDiff, locateRegion, Verdict } from './prompt-cache-geometry.js';

/**
 * How many recent generations are kept per (handle, backend), with their text.
 *
 * Ten records match the consumer's ten-row panel. This counts generations per (handle, backend), not visible
 * turns; background summarization and other non-chat generations also consume entries.
 *
 * ⚠️ TEN RECORDS IS NOT TEN VISIBLE TURNS, AND A CONSUMER MUST NOT ASSUME IT IS. This counts every
 * generation reaching the backend — summarisation, vector queries, impersonate, quiet prompts, a group
 * member's turn. On a chat with a summariser running, ten records can span five visible turns. That is what
 * `chatId` and `genType` are on the record for.
 */
export const PROMPT_HISTORY_DEPTH = 10;

/**
 * 🔴 THE CEILING EXISTS BECAUSE A HANDLE IS NOT A SESSION. A user with several tabs, a group chat and a
 * background summariser is one handle making many requests, and the map below is keyed by (handle, backend).
 * Without a bound, a long-running server accumulates one entry per pair for ever. At ten prompts of ~112 KB
 * each, a tracked pair costs ~1.1 MB, so thirty-two of them is a ~36 MB worst case that a home install will
 * never approach — but "it is only a megabyte" is how every leak starts.
 */
const MAX_TRACKED_KEYS = 32;

/**
 * One recorded generation, as a consumer receives it.
 * @typedef {object} PromptRecord
 * @property {number} seq Monotonic per (handle, backend). The ordering a consumer needs to tell "the previous
 * turn" from "a summarisation that ran in between" — see `prevSeq`.
 * @property {number} at `Date.now()` when the prompt was recorded, immediately before it was sent.
 * @property {string} backend Which family handled it: `text`, `chat`, `kobold`, `novel`.
 * @property {string} [apiType] The specific backend within that family, when the endpoint knows one.
 * @property {string} [chatId] Which chat this generation belongs to, when the client sent identity headers.
 * @property {string} [genType] What kind of generation it was — `normal`, `quiet`, `impersonate`, …
 * @property {number} length Characters in the outgoing prompt.
 * @property {string} hash SHA-256 of the outgoing prompt, hex. Lets a client ask "is this the string I built?"
 * without moving a hundred kilobytes to find out.
 * @property {string[]} rewrittenBy Ids of the plugins whose interceptors actually CHANGED the prompt. Empty
 * when the prompt left exactly as the client built it.
 *
 * ⚠️ SERVER-SIDE PLUGINS ONLY, AND A CONSUMER MUST NOT PRESENT IT AS THE COMPLETE LIST OF MODIFIERS. World
 * Info, author's note, summaries and vector results are applied by the CLIENT before the prompt is sent, so
 * none of them appear here. A panel naming one plugin while silent about a lorebook that rewrites every turn
 * is misleading by omission — say "modified by X", never "the thing that changed this".
 * @property {Array<{id: string, atChar: number, delta: number}>} rewriteSites Where each of those plugins'
 * changes actually begins, and by how many characters it grew the prompt. Observed, not configured: a
 * plugin's depth setting says where it MEANT to write, and this says where it landed.
 * @property {number|null} prevSeq The `seq` of the previous generation on this (handle, backend), or null if
 * this is the first one. A consumer comparing against "last turn" must check that this points where it
 * thinks it does.
 * @property {string} [shape] The client's `X-ST-Prompt-Shape` header, verbatim: the length of each part the
 * browser assembled, as `v1;name=number;...`. Numbers only, by contract — see `prompt-cache-geometry.js`.
 * Absent when the client did not send one, which an older or non-browser client will not.
 * @property {string} text The prompt itself, as sent.
 * @property {string} recordId Globally unique, immutable identity for this generation, minted with
 * `crypto.randomUUID()` when the record is created. This is the durable identity a consumer correlates
 * against for deduplication — see the note under `seq` below for why `seq` cannot be used for that.
 * @property {"pending"|"completed"|"failed"|"cancelled"} status Where this generation is in its lifecycle.
 * Every record is created `pending` and moves to exactly one terminal status via
 * {@link finalizePromptRecord}; terminal statuses never transition again (Cache Lens raw generation rows
 * design §11.1).
 * @property {number} [completedAt] `Date.now()` when the generation reached a terminal status. Absent
 * while `status` is `pending`.
 * @property {"available"|"absent"|"invalid"} [usageState] What is known about the provider's input/cache
 * token accounting for this generation, set alongside `status` by {@link finalizePromptRecord}. `absent`
 * ("the provider reported no cache accounting") and `invalid` ("what the provider reported did not add up")
 * are different facts and must never be collapsed into the same zero — see `usage` below.
 * @property {object} [usage] Present only when `usageState` is `available`. A provider-neutral token/cache
 * measurement — see `finalizePromptRecord` and `normalizeDeepSeekChatUsage` in `deepseek-usage.js` for the
 * schema and how it is produced. Always a fresh, validated copy; never the provider's own response object.
 *
 * 🔴 `seq` IS ORDERING AND IN-FLIGHT CORRELATION; `recordId` IS DURABLE IDENTITY; THEY ARE NOT
 * INTERCHANGEABLE. `seq` is a per-(handle, backend) counter that restarts at 1 every time the process
 * restarts, so two different generations either side of a restart can legitimately share the same `seq`.
 * A raw Cache Lens row persisted before a restart and later correlated against a post-restart record by
 * `seq` alone would silently attach to the wrong generation's usage. `recordId` cannot collide this way
 * because it is minted fresh, once, per record, and nothing ever reuses one — that is exactly the bug a
 * future reader correlating by `seq` across a restart would reintroduce.
 */

/**
 * @typedef {object} TrackedBackend
 * @property {number} nextSeq
 * @property {PromptRecord[]} records Newest last.
 */

/** @type {Map<string, TrackedBackend>} */
const tracked = new Map();

/**
 * @param {string} handle User handle
 * @param {string} backend Backend family
 * @returns {string} The map key
 */
function keyFor(handle, backend) {
    return `${handle || '(anonymous)'} ${backend}`;
}

/**
 * Below this fraction of the prompt being reusable, the turn is called cold in the log.
 *
 * Half is not a tuned number, it is a statement: when more than half the prompt has to be recomputed, the
 * cache did not do its job on this turn, whatever the reason. The reason is reported separately, and the
 * exact reusable count is on every line either way — so nothing here decides what is true, only what is
 * loud enough to grep for.
 */
const COLD_TURN_REUSE_FLOOR = 0.5;

/**
 * Why this turn went cold, in one sentence, chosen by the shape of the change.
 * @param {import('./prompt-cache-geometry.js').PromptGeometry} geometry What changed
 * @param {string} region Where the reuse loop stalled
 * @returns {string} The explanation
 */
function coldReason(geometry, region) {
    switch (geometry.verdict) {
        case Verdict.INSERTION_ABOVE:
            return `Something was INSERTED above the rest of the prompt, in the ${region}, at character ${geometry.stalledAtChar} — cache reuse cannot shift content later, so everything below it is lost.`;
        case Verdict.DELETION_ABOVE:
            return 'Content was removed above the history and the rest slid earlier, which cache reuse absorbs — so this cost is the changed tail, not the shift.';
        case Verdict.TAIL_CHANGE:
            return `Nothing was displaced: the prompt diverges at character ${geometry.atChar}, in the ${region}, and never re-converges. The content that was cached is gone rather than moved — a window that rolled over completely, a swipe, or an edit high in the history.`;
        default:
            return 'The reuse loop could not characterise the change.';
    }
}

/**
 * Generation kinds that may be logged verbatim.
 *
 * 🔴 `genType` ARRIVES IN A REQUEST HEADER, SO IT IS INPUT. Every other value on the geometry line is a
 * number this process computed; this one is a string a client chose, and a line mixing safe prose with an
 * unvetted string is exactly what `LogClass.NORMAL` must never carry (logger design §4.3). Whitelisting is
 * cheaper than classifying the whole line SENSITIVE, which would hide it on an install with debugMode off —
 * i.e. on the install that needs it.
 */
const LOGGABLE_GEN_TYPES = new Set(['normal', 'quiet', 'impersonate', 'continue', 'swipe', 'regenerate', 'ask_command']);

/**
 * What the backend REPORTED about an earlier prompt, as one line, or null when nothing was reported.
 *
 * 🔴 THIS IS THE ONLY MEASURED NUMBER ON ANY OF THESE LINES. Everything else the geometry logs is this
 * process comparing two strings it holds — a prediction, and a character-level one at that, while the real
 * reuse loop runs over tokens. `pcached` is llama.cpp's own count of what it did not have to recompute.
 * When the two disagree, the backend is right and the analyzer has a bug; that is the point of carrying it.
 *
 * ⚠️ IT BELONGS TO AN EARLIER SEQ, NOT THIS ONE. `GENERATION_TIMINGS` fires when a generation finishes, so
 * the browser can only echo it on the NEXT request. The line names the seq it actually measured, which is
 * why it prints its own seq rather than borrowing the record's.
 * @param {Map<string, number>|null} shape The parsed shape header
 * @returns {string|null} The line, or null when this request carried no measurement
 */
/**
 * What the analyzer PREDICTED for a seq, so the backend's later measurement can be compared against it.
 *
 * 🔴 THE PREDICTION AND THE MEASUREMENT MUST APPEAR TOGETHER, BECAUSE ON 2026-08-27 THEY DISAGREED BY
 * EIGHTY POINTS AND NOTHING SAID SO. `replayReuseLoop` works in LINES; llama.cpp works in tokens. A history
 * line differing by two characters keeps nearly all its tokens, so the backend resyncs and recovers ~85%,
 * while the line-based replay treats the whole line as lost and reports 5%. Both numbers were already in
 * `st.log`, three lines apart, and the contradiction still went unnoticed for hours.
 * @type {Map<string, number>}
 */
const predictedReuse = new Map();

/** Enough to outlive the record window several times over; pruned so a long session cannot grow it. */
const PREDICTION_MEMORY = 200;

/**
 * @param {string} key Identity of the generation
 * @param {number} fraction What the analyzer expected to be reusable
 * @returns {void}
 */
function rememberPrediction(key, fraction) {
    predictedReuse.set(key, fraction);

    while (predictedReuse.size > PREDICTION_MEMORY) {
        predictedReuse.delete(predictedReuse.keys().next().value);
    }
}

function describeMeasuredGeneration(shape, keyPrefix) {
    if (!shape || !shape.has('pseq') || !shape.has('pcached')) {
        return null;
    }

    const cached = shape.get('pcached');
    const processed = shape.get('pproc') ?? 0;
    const total = cached + processed;
    const fraction = total > 0 ? cached / total : 0;
    const percent = (fraction * 100).toFixed(1);
    const predicted = predictedReuse.get(`${keyPrefix}:${shape.get('pseq')}`);
    const against = Number.isFinite(predicted)
        ? ` The analyzer predicted ${(predicted * 100).toFixed(1)}% — ${Math.abs(predicted - fraction) * 100 < 10 ? 'agreed' : `OFF BY ${(Math.abs(predicted - fraction) * 100).toFixed(1)} POINTS, so the estimate for this turn is not to be trusted`}.`
        : '';

    return {
        fraction,
        line: `seq ${shape.get('pseq')} MEASURED by the backend: reused ${cached} of ${total} tokens (${percent}%), processed ${processed}, prefill ${shape.get('pms') ?? 0} ms.${against}`,
        seq: shape.get('pseq'),
        reprocessed: processed,
        total,
    };
}

/**
 * Say why this turn will or will not reuse the backend's KV cache.
 *
 * This is the diagnostic the fork exists to be able to run: a cold turn is a fact about two strings, and
 * guessing at it from wall-clock timings is how weeks get spent. `prompt-cache-geometry.js` states the
 * privacy contract in full — every value below is a length, an offset or a fixed keyword.
 *
 * ⚠️ COMPARED AGAINST THE PREVIOUS RECORD FOR THIS (handle, backend), NOT THE PREVIOUS TURN OF THIS CHAT.
 * That is deliberate and it is the truthful model: a single-slot backend holds the last prompt it was sent,
 * whatever chat it came from. A summarisation or a vector query landing between two chat turns really does
 * evict the cache, and a diagnostic that quietly skipped those would report a cold turn as warm.
 * @param {PromptRecord} record The prompt about to be sent
 * @param {PromptRecord} [previous] The prompt the backend is holding, when there is one
 * @returns {void}
 */
function logCacheGeometry(record, previous) {
    if (!previous) {
        return;
    }

    try {
        const geometry = analyzeGeometry(previous.text, record.text);
        const shape = parsePromptShape(record.shape);
        const previousShape = parsePromptShape(previous.shape);
        const percent = geometry.length > 0 ? (geometry.reusable / geometry.length * 100).toFixed(1) : '0.0';
        const genType = LOGGABLE_GEN_TYPES.has(String(record.genType)) ? String(record.genType) : 'other';
        // 🔴 THE REGION NAMES WHERE THE DIFFERENCE IS, AND IT IS COMPUTED FROM THE EXACT CHARACTER.
        // It used to be computed from `stalledAtChar`, which is line-granular like the replay that
        // produces it — so a prompt part beginning mid-line was reported against the part before it.
        // Three turns on the live install were logged as diverging in the example messages while the
        // example block was byte-identical; the change was two characters into the chat history.
        const region = locateRegion(shape, geometry.atChar);
        const delta = `${geometry.delta >= 0 ? '+' : ''}${geometry.delta}`;
        // The message this generation will become, so a log line can be matched to a message in the UI
        // without pasting a screenshot. Absent on a client too old to send it, hence the empty string.
        const messageLabel = shape?.has('mesid') ? ` (msg ${shape.get('mesid')})` : '';

        log.debug(LogClass.NORMAL, `Prompt cache geometry [${record.backend}/${genType}] seq ${previous.seq}->${record.seq}${messageLabel}: ${geometry.verdict}, reusable ${geometry.reusable}/${geometry.length} chars (${percent}%), previous ${geometry.prevLength} (${delta}), first difference at ${geometry.atChar} in the ${region}, reuse stalls at ${geometry.stalledAtChar}.`);
        log.debug(LogClass.NORMAL, `Prompt cache geometry [${record.backend}/${genType}] seq ${record.seq}${messageLabel} parts: ${describeShapeChange(previousShape, shape)}.`);
        log.debug(LogClass.NORMAL, `Prompt cache geometry [${record.backend}/${genType}] seq ${record.seq}${messageLabel} layout: ${describeLayout(shape)}.`);
        log.debug(LogClass.NORMAL, `Prompt cache geometry [${record.backend}/${genType}] seq ${record.seq}${messageLabel} content: ${describePartDiff(previous.text, previousShape, record.text, shape)}.`);

        // The backend's own verdict on an earlier turn, echoed back by the browser. Logged on its own line
        // so `grep MEASURED` gives a clean column of what actually happened, next to what was predicted.
        const keyPrefix = `${record.handle}:${record.backend}`;

        rememberPrediction(`${keyPrefix}:${record.seq}`, geometry.length > 0 ? geometry.reusable / geometry.length : 0);

        const measured = describeMeasuredGeneration(shape, keyPrefix);

        if (measured) {
            log.debug(LogClass.NORMAL, `Prompt cache geometry [${record.backend}/${genType}] ${measured.line}`);
        }

        // 🔴 THE WARNING FIRES ON WHAT THE BACKEND ACTUALLY DID, NOT ON WHAT THIS FILE EXPECTED.
        // The estimate below is a line-level replay of a token-level loop, and on 2026-08-27 it called six
        // consecutive healthy turns cold — predicting 5% where the backend reused 78-88%. Test User greps
        // `COLD TURN`, so a warning that cries wolf is worse than no warning at all. The measurement lags
        // one turn by construction (timings only exist once a generation has finished), and a true warning
        // one turn late beats a false one on time.
        if (measured && measured.fraction < COLD_TURN_REUSE_FLOOR) {
            log.warn(LogClass.NORMAL, `Prompt cache geometry [${record.backend}/${genType}] seq ${measured.seq}: COLD TURN. The backend reused ${(measured.fraction * 100).toFixed(1)}% and had to process ${measured.reprocessed} of ${measured.total} tokens.`);
        }

        // 🔴 THE WARNING KEYS ON THE COST, NOT ON THE SHAPE, AND GETTING THAT BACKWARDS NEARLY SHIPPED.
        // It first fired only on `INSERTION_ABOVE`, which is one way a turn goes cold and not the only one:
        // `cold-turn-reproduction.e2e.js` drove turns that reused 2,920 characters of 5,105 — 43 % of the
        // prompt reprocessed — and logged no warning at all, because the whole history had rolled over
        // rather than been pushed down. Anyone grepping COLD TURN would have found nothing and concluded
        // their slow turns were something else entirely.
        // ⚠️ PREDICTED, NOT MEASURED, AND NAMED THAT WAY ON PURPOSE. This is the early warning — it is
        // available on the turn itself, where the truth is not — and it explains the SHAPE of the change,
        // which no measurement can. It just may not borrow the words `COLD TURN`, because those now mean
        // the backend said so.
        if (geometry.reusable < geometry.length * COLD_TURN_REUSE_FLOOR) {
            log.warn(LogClass.NORMAL, `Prompt cache geometry [${record.backend}/${genType}] seq ${record.seq}${messageLabel}: PREDICTED COLD. ${geometry.length - geometry.reusable} of ${geometry.length} characters look unreusable (${(100 - Number(percent)).toFixed(1)}%). ${coldReason(geometry, region)} — a line-level estimate; the MEASURED line for this seq, one turn later, is the authority.`);
        }
    } catch (error) {
        // A diagnostic must never be able to fail a generation. The prompt has already been recorded and is
        // on its way to the model; this only decides whether a line appears in the log.
        log.warn(LogClass.NORMAL, 'Prompt cache geometry could not be computed for this generation.', error);
    }
}

/**
 * Record one outgoing prompt.
 *
 * 🔴 CALLED FROM THE ENDPOINTS, NOT FROM INSIDE `runPromptInterceptors`. That function returns early when no
 * interceptor is registered — deliberately, so a stock install mints nothing — and a recorder living inside
 * it would therefore capture nothing on a stock install. That is precisely the configuration where a client
 * most needs to be told that what it built IS what went out, so the recording has to happen whether or not
 * any plugin is listening.
 *
 * ⚠️ THE CALLER MUST NOT PUT THE RESULT ON `request.body`. Every backend endpoint serialises the body
 * verbatim to the model, so a field added there is not a note to ourselves, it is transmitted.
 * @param {object} params What was sent
 * @param {string} [params.handle] The user
 * @param {string} params.backend Backend family: `text`, `chat`, `kobold`, `novel`
 * @param {string} [params.apiType] The specific backend
 * @param {string} [params.chatId] From the identity headers, when present
 * @param {string} [params.genType] From the identity headers, when present
 * @param {string} params.prompt The outgoing prompt, as it will be sent
 * @param {string[]} [params.rewrittenBy] Plugins whose interceptors changed it
 * @param {Array<{id: string, atChar: number, delta: number}>} [params.rewriteSites] Where each change begins
 * @returns {PromptRecord|null} The record, or null if there was no string prompt to record
 */
export function recordOutgoingPrompt({ handle, backend, apiType, chatId, genType, prompt, shape, rewrittenBy = [], rewriteSites = [] }) {
    if (typeof prompt !== 'string') {
        // Not an error: the chat path's prompt is an array of messages, and a caller that has not serialised
        // it has nothing for us to record. Saying so beats storing a record whose `length` is `undefined`.
        return null;
    }

    const key = keyFor(handle, backend);
    const existing = tracked.get(key) ?? { nextSeq: 1, records: [] };
    const previous = existing.records[existing.records.length - 1];

    /** @type {PromptRecord} */
    const record = {
        seq: existing.nextSeq,
        at: Date.now(),
        backend,
        apiType,
        chatId,
        genType,
        length: prompt.length,
        hash: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
        rewrittenBy: [...rewrittenBy],
        rewriteSites: rewriteSites.map(site => ({ ...site })),
        prevSeq: previous ? previous.seq : null,
        shape: typeof shape === 'string' ? shape : undefined,
        text: prompt,
        // Raw generation rows (Cache Lens durable raw-row design §6.1): durable identity and lifecycle.
        // `completedAt`, `usageState` and `usage` are intentionally absent here — they exist only once
        // `finalizePromptRecord` moves this record out of `pending`.
        recordId: crypto.randomUUID(),
        status: 'pending',
    };

    logCacheGeometry(record, previous);

    existing.nextSeq += 1;
    existing.records.push(record);

    while (existing.records.length > PROMPT_HISTORY_DEPTH) {
        existing.records.shift();
    }

    tracked.set(key, existing);

    // Evict the least recently created key. `Map` iterates in insertion order and `set` on an existing key
    // does not reorder it, so this is approximate rather than true LRU — deliberately, because it is a memory
    // ceiling and not a cache, and an install that reaches it has more backends than anyone configures.
    while (tracked.size > MAX_TRACKED_KEYS) {
        const oldest = tracked.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        tracked.delete(oldest);
    }

    return record;
}

/**
 * Read back what was recorded.
 * @param {string} [handle] The user
 * @param {string} backend Backend family
 * @returns {PromptRecord[]} Newest last, at most `PROMPT_HISTORY_DEPTH`
 */
export function getRecords(handle, backend) {
    const existing = tracked.get(keyFor(handle, backend));

    return existing ? [...existing.records] : [];
}

/**
 * Terminal statuses a record may settle into. Not exported: callers of {@link finalizePromptRecord} pass a
 * status string and get a structured rejection back if it is not one of these, rather than being handed the
 * set to check themselves — the validation belongs with the function that enforces it.
 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * A finite, non-negative integer — the only shape any token count is ever allowed to have. Anything else
 * (negative, fractional, NaN, a string, missing) is not "close enough"; see design §6.3 rule 1.
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Two usage measurements are equivalent when they carry the same three counts, and never by reference.
 * Used only to decide whether a repeated terminal finalization is the identical update (idempotent) or a
 * contradictory one (rejected) — see {@link finalizePromptRecord}.
 * @param {object|undefined} a
 * @param {object|undefined} b
 * @returns {boolean}
 */
function usageEquivalent(a, b) {
    if (a === b) {
        // Covers both-undefined, which is the common case for `absent`/`invalid` outcomes.
        return true;
    }

    if (!a || !b) {
        return false;
    }

    return a.inputTokens === b.inputTokens && a.cachedTokens === b.cachedTokens && a.uncachedTokens === b.uncachedTokens;
}

/**
 * Validate and copy a caller-supplied usage measurement into the shape that is safe to store.
 *
 * 🔴 THIS NEVER RETAINS THE CALLER'S OBJECT. A fresh plain object is built field by field, so nothing a
 * provider adapter passed in — however it was itself sourced — can be a reference to a provider response
 * or SSE payload that outlives this call. This is the second, independent validation pass: `usage` here is
 * expected to already be the output of `normalizeDeepSeekChatUsage` or an equivalent adapter, but
 * finalization does not trust that on faith, because a caller bug upstream must degrade to `invalid`
 * telemetry, never to a corrupted or fabricated stored measurement.
 * @param {"available"|"absent"|"invalid"|undefined} usageState What the caller claims
 * @param {object} [usage] The measurement the caller claims goes with it
 * @returns {{usageState: "available"|"absent"|"invalid", usage: object|undefined}}
 */
function sanitizeUsage(usageState, usage) {
    if (usageState !== 'available') {
        // `absent` and `invalid` never carry a usage object — see the PromptRecord typedef note on why
        // those two must not collapse into the same zero. Any stray `usage` payload on a non-available
        // claim is simply dropped rather than stored.
        return { usageState: usageState === 'absent' || usageState === 'invalid' ? usageState : 'absent', usage: undefined };
    }

    if (!usage || typeof usage !== 'object') {
        // Claimed 'available' but nothing to back it up — a caller bug. Telemetry degrades honestly.
        return { usageState: 'invalid', usage: undefined };
    }

    const inputTokens = Number(usage.inputTokens);
    const cachedTokens = Number(usage.cachedTokens);
    const uncachedTokens = Number(usage.uncachedTokens);

    if (!isValidCount(inputTokens) || !isValidCount(cachedTokens) || !isValidCount(uncachedTokens)
        || cachedTokens > inputTokens || cachedTokens + uncachedTokens !== inputTokens) {
        return { usageState: 'invalid', usage: undefined };
    }

    return {
        usageState: 'available',
        usage: {
            schema: typeof usage.schema === 'string' ? usage.schema : 'input-cache-v1',
            inputTokens,
            cachedTokens,
            uncachedTokens,
            provider: typeof usage.provider === 'string' ? usage.provider : 'deepseek',
            api: typeof usage.api === 'string' ? usage.api : 'chat-completions',
        },
    };
}

/**
 * @typedef {object} FinalizeResult
 * @property {boolean} ok Whether the record now reflects (or already reflected) the requested outcome.
 * @property {"applied"|"idempotent"|"contradictory"|"not-found"|"invalid-status"|"error"} reason Which of
 * the invariants below decided the outcome, so a caller can log or branch on it without re-deriving it.
 * @property {string} recordId Echoed back so a caller logging the result does not need to keep it separately.
 * @property {number} [seq] The located record's `seq`, when a record was found at all.
 */

/**
 * Finalize the outcome of one outgoing generation: what happened to it, and what the provider reported
 * about cache reuse, if anything. This is the only way a `PromptRecord` leaves `pending`.
 *
 * 🔴 THIS IS TELEMETRY, NOT THE REQUEST. Every invariant below exists to guarantee that whatever this
 * function does, it never throws past its caller and never has an opinion about the provider response the
 * caller has already sent (or is about to send) to the browser — the whole body is wrapped in `try`/`catch`
 * for exactly that reason, and the `catch` logs and returns a structured failure rather than propagating.
 *
 * Invariants (Cache Lens raw generation rows design §6.2), one clause per line:
 * - Locates exactly one record by `(handle, backend, recordId)`.
 * - `pending` may transition once to a terminal status.
 * - Repeating the IDENTICAL terminal update is idempotent: no change, no error, the stored record is left
 *   exactly as it was.
 * - A second, CONTRADICTORY terminal update is rejected and logged; the first result is kept, never
 *   replaced.
 * - A missing or already-evicted record (the ten-slot window in {@link PROMPT_HISTORY_DEPTH} moved on) is a
 *   debug-level diagnostic, not a request failure — a client can call this well after its own record fell
 *   out of the window, and that is expected traffic.
 * - Numeric fields are copied and validated; see {@link sanitizeUsage}. The caller's `usage` object is
 *   never retained by reference.
 * @param {object} params
 * @param {string} [params.handle] The user this record belongs to
 * @param {string} params.backend Backend family the record was tracked under
 * @param {string} params.recordId The record's durable identity, from {@link recordOutgoingPrompt}
 * @param {"completed"|"failed"|"cancelled"} params.status The terminal status to apply
 * @param {number} [params.completedAt] `Date.now()` at the moment of finalization; defaults to now if
 * omitted or not a finite number
 * @param {"available"|"absent"|"invalid"} [params.usageState] What the caller found out about cache usage
 * @param {object} [params.usage] The measurement, required only when `usageState` is `'available'`
 * @returns {FinalizeResult}
 */
export function finalizePromptRecord({ handle, backend, recordId, status, completedAt, usageState, usage }) {
    try {
        if (!TERMINAL_STATUSES.has(status)) {
            // ⚠️ THE REJECTED VALUE IS NOT ECHOED, AND THAT IS THE SAME RULE `LOGGABLE_GEN_TYPES` ABOVE
            // EXISTS FOR. Every caller in this repo passes a literal, so nothing client-chosen reaches
            // here today — but this is the one branch where the value is known to be bad, and a
            // `LogClass.NORMAL` line mixing safe prose with an unvetted string is exactly what the logger
            // design forbids. The record id and backend are enough to find the call site.
            log.warn(LogClass.NORMAL, `finalizePromptRecord: rejected an unrecognized terminal status for recordId ${recordId} (backend ${backend}).`);
            return { ok: false, reason: 'invalid-status', recordId };
        }

        const existing = tracked.get(keyFor(handle, backend));
        const record = existing?.records.find(candidate => candidate.recordId === recordId);

        if (!record) {
            log.debug(LogClass.NORMAL, `finalizePromptRecord: no live record for recordId ${recordId} (backend ${backend}, attempted status ${status}) — already evicted, or handle/backend do not match. Ignored.`);
            return { ok: false, reason: 'not-found', recordId };
        }

        const resolvedCompletedAt = Number.isFinite(completedAt) ? completedAt : Date.now();
        // 🔴 A FAILED OR CANCELLED REQUEST CARRIES NO USAGE, AND THE INVARIANT LIVES HERE RATHER THAN IN
        // THE CALLER. Design §11.1 states it, and today's only caller honors it — `finalizeRecord` in the
        // DeepSeek helper passes a usage result on the completed path alone. That is the caller being
        // careful, which is not the same as the record being unable to hold a contradiction: a request
        // that failed mid-stream may well have had a valid usage sighting before it died, and the next
        // provider adapter to be written will reach for it. Such a record would be one §11.1 forbids and
        // one the Cache Lens row model does not expect, so the shape is refused structurally.
        const sanitized = status === 'completed'
            ? sanitizeUsage(usageState, usage)
            : { usageState: /** @type {'absent'} */ ('absent'), usage: undefined };

        if (record.status === 'pending') {
            record.status = status;
            record.completedAt = resolvedCompletedAt;
            record.usageState = sanitized.usageState;
            record.usage = sanitized.usage;

            const usageLog = sanitized.usage
                ? `, inputTokens=${sanitized.usage.inputTokens} cachedTokens=${sanitized.usage.cachedTokens} uncachedTokens=${sanitized.usage.uncachedTokens}`
                : '';
            log.debug(LogClass.NORMAL, `finalizePromptRecord: seq ${record.seq} recordId ${recordId} (backend ${backend}) -> ${status}, usageState ${sanitized.usageState}${usageLog}.`);

            return { ok: true, reason: 'applied', recordId, seq: record.seq };
        }

        // Already terminal. Two code paths finalizing the same recordId is a real race — an abort landing
        // in the same tick as the provider's own error, or a duplicate event — and it must be silent when
        // both sides agree, because that is the identical-update invariant, not a bug.
        const identical = record.status === status
            && record.usageState === sanitized.usageState
            && usageEquivalent(record.usage, sanitized.usage);

        if (identical) {
            return { ok: true, reason: 'idempotent', recordId, seq: record.seq };
        }

        log.warn(LogClass.NORMAL, `finalizePromptRecord: contradictory finalization for seq ${record.seq} recordId ${recordId} (backend ${backend}) — already ${record.status}/${record.usageState}, rejected a second ${status}/${sanitized.usageState}. Keeping the first.`);
        return { ok: false, reason: 'contradictory', recordId, seq: record.seq };
    } catch (error) {
        // No exception from telemetry finalization may fail or alter the provider response. Whatever went
        // wrong here, the generation itself has already happened; this function only decides whether a
        // stamp exists for it, and a bug in that decision must not become a bug in the response path.
        log.warn(LogClass.NORMAL, `finalizePromptRecord: swallowed an internal error while finalizing recordId ${recordId} (backend ${backend}).`, error?.message ?? error);
        return { ok: false, reason: 'error', recordId };
    }
}

/**
 * Forget everything recorded for a user.
 *
 * ⚠️ THIS IS NOT HOUSEKEEPING. A logout that left prompt text in memory would mean recent conversation
 * outliving the session it belonged to.
 * @param {string} [handle] The user to forget, or every user when omitted
 */
export function clearRecords(handle) {
    if (handle === undefined) {
        tracked.clear();
        return;
    }

    for (const key of [...tracked.keys()]) {
        if (key.startsWith(`${handle} `)) {
            tracked.delete(key);
        }
    }
}

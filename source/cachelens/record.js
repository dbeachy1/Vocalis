/**
 * The fork record — what the server actually sent, and what to do when it cannot say.
 *
 * Taproom lets a server plugin rewrite the prompt on its way to the model, which happens after the browser
 * recorded `itemizedPrompts[].rawPrompt`. On such an install the browser's copy is not what the backend
 * received, and nothing in stock SillyTavern reports the difference. DESIGN.md §6.2a is the fork's answer:
 * a read route returning the last few outgoing prompts as sent, each naming the plugins that changed it.
 *
 * 🔴 THIS MODULE'S JOB IS TO KNOW WHICH IT IS LOOKING AT, AND SAY SO. Presenting the browser's copy as
 * "what the backend received" is the exact failure the fork feature exists to prevent, and it would be worse
 * for being invisible. Every answer here carries its provenance, and where provenance cannot be established
 * the answer is "I do not know" rather than the likely one.
 */

/**
 * One record from the fork's route, as DESIGN.md §6.2 / §6.2a define it on the wire.
 *
 * ⚠️ EVERY FIELD BUT `seq` IS OPTIONAL HERE ON PURPOSE. This crosses a network boundary from a fork that
 * may be older than this panel, and the whole module exists to distinguish "the server said X" from "the
 * server said nothing". A field typed as always-present would let a reader treat an absent one as a value.
 * @typedef {object} CacheRecord
 * @property {number} seq Monotonic per backend — request ordering, and the correlation handle
 * @property {number|null} [prevSeq] The `seq` before this one. With its `genType` and `chatId`, this is how
 * §4.2 decides whether the baseline is really what the cache held.
 * @property {string} [genType] `normal`, `quiet`, `impersonate`, … — what kind of generation it was
 * @property {string} [chatId] Which chat it belonged to
 * @property {number} [length] Length of the outgoing prompt
 * @property {string} [hash] SHA-256 of the outgoing prompt — "is this the string I built?" in one comparison
 * @property {unknown} [shape] Prompt-shape metadata the route already sends alongside `text`. Nothing in
 * this module has read it before now; `projectQuietRecord` drops it for the same reason it drops `text` and
 * `hash` — it is derived from the prompt itself, and a `quiet` record's prompt must never become durable.
 * @property {string[]} [rewrittenBy] Ids of the plugins that ACTUALLY changed the prompt. Empty when it left
 * exactly as the browser built it. Server-side only — see `SERVER_SIDE_ONLY`.
 * @property {RawRewriteSite[]} [rewriteSites] Where each of those plugins wrote, as sent (§6.2c) —
 * resolve it with `rewriteSitesOf` rather than reading it directly
 * @property {string} [text] The prompt itself, as sent. On `backend: 'chat'` this is
 * `JSON.stringify(messages)`, not the literal vendor payload.
 * @property {number} [at] Milliseconds since the epoch
 * @property {string} [backend] The backend family that served it
 * @property {string} [apiType] The specific API within that family
 * @property {string} [recordId] Globally unique, immutable, durable identity — DESIGN_RAW_GENERATION_ROWS.md
 * §6.1. Generated once by `crypto.randomUUID()` when the server creates the record, so it survives a server
 * restart (unlike `seq`, which restarts with the process). This is what durable raw rows deduplicate by.
 * @property {string} [status] `pending` | `completed` | `failed` | `cancelled` — DESIGN_RAW_GENERATION_ROWS.md
 * §11.1. A record with no `status` field at all is an older Taproom that predates this addition; per §7.4
 * step 5 that is never terminal and is never persisted, because there is no way to know it finished.
 * @property {number} [completedAt] Epoch milliseconds. Absent while the record is `pending`.
 * @property {string} [usageState] `available` | `absent` | `invalid` — whether `usage` below can be trusted.
 * A missing field means an older Taproom did not report usage state; it differs from an explicit `'absent'`
 * report and is normalized as `'unknown'` by `usageCountsOf`.
 * @property {RecordUsage} [usage] Present only when `usageState === 'available'`
 */

/**
 * The normalized usage measurement a record may carry, DESIGN_RAW_GENERATION_ROWS.md §6.1 / §6.3.
 * @typedef {object} RecordUsage
 * @property {string} [schema] Must be `'input-cache-v1'` for `usageCountsOf` to accept it
 * @property {number} [inputTokens] Total tokens the provider counted as input
 * @property {number} [cachedTokens] Of those, how many the provider's cache already held
 * @property {number} [uncachedTokens] Of those, how many the provider had to process fresh
 * @property {string} [provider] e.g. `'deepseek'`
 * @property {string} [api] e.g. `'chat-completions'`
 */

/**
 * A rewrite site as the ROUTE sends it (§6.2c) — three fields, and none of them guaranteed.
 *
 * 🔴 SEPARATE FROM `RewriteSite` BECAUSE THE WIRE CANNOT PROMISE THE RESOLVED SHAPE. `atFinal` and
 * `prepended` do not exist on the wire at all; `rewriteSitesOf` derives them. And the filter it runs first —
 * `typeof site?.id === 'string'`, both offsets finite, `atChar >= 0` — only makes sense because the fork may
 * send junk, so a type asserting the fields are present would be contradicting the code that checks them.
 * @typedef {object} RawRewriteSite
 * @property {string} [id] The plugin
 * @property {number} [atChar] Where its edit begins, in the prompt as it stood when that plugin ran
 * @property {number} [delta] How much longer it made the prompt. Negative if it removed text.
 */

/**
 * The same site once `rewriteSitesOf` has resolved it — the shape the row and `describeRewrites` consume.
 * @typedef {object} RewriteSite
 * @property {string} id The plugin
 * @property {number} atChar Where its edit begins, in the prompt AS IT STOOD WHEN THAT PLUGIN RAN. Offsets
 * are sequential, so a second writer's offset is against the string the first one produced.
 * @property {number} delta How much longer it made the prompt. Negative if it removed text.
 * @property {number|null} atFinal The same position walked forward through the writers that followed it, or
 * null when the arithmetic lands outside the prompt as sent — withheld rather than pointing a reader at a
 * character that is not there.
 * @property {boolean} prepended Whether it wrote at char 0 — either meant, or a depth anchor that could not
 * place itself and fell back to prepending silently. This code cannot tell which.
 */

/**
 * The backend's own timings object, passed through unaltered (§6.2a).
 *
 * 🔴 DELIBERATELY NOT NORMALISED, AND EVERY FIELD IS OPTIONAL BECAUSE OF IT. Backends disagree about
 * what they report, and a normaliser would assert a schema the fork cannot check. Read the fields you want
 * and treat missing ones as missing, never substituted.
 * @typedef {object} RawTimings
 * @property {number|null} [cache_n] Tokens the backend reused from its cache (recent llama.cpp builds)
 * @property {number|null} [prompt_n] Tokens it actually processed
 * @property {number|null} [prompt_ms] Milliseconds it spent on the prompt
 *
 * ⚠️ NULL AS WELL AS ABSENT, BECAUSE THIS ARRIVES AS JSON. A backend that reports the field with a null
 * value is saying the same thing as one that omits it, and `measuredSplit` already refuses both — the type
 * saying otherwise was the type being wrong, not the code.

/**
 * What the probe route said about this install (§6.2a).
 * @typedef {object} ProbeResult
 * @property {boolean} supported Whether the fork has the record feature at all
 * @property {number} depth How many prompts it keeps
 * @property {string[]} backends The families it will answer for
 */

/**
 * What a row may claim about the prompt it is showing.
 * @typedef {object} ProvenanceResult
 * @property {string} provenance One of `PROVENANCE`
 * @property {string|null} text The prompt as sent, when the record holds it
 * @property {string[]} rewrittenBy Server-side plugins that changed it
 * @property {string} label The short phrase the row prints
 * @property {string} detail The caveat the tooltip carries — what this answer does not cover
 */

/**
 * Whether the baseline is really the cache predecessor, and what to say when it is not.
 * @typedef {object} EvictionNote
 * @property {boolean} ok Whether the row may compare against the previous turn
 * @property {string|null} note What to print, or null when there is nothing to say
 */

/**
 * The rewrite sites, as a sentence for the row.
 * @typedef {object} RewriteNote
 * @property {string} text The sentence
 * @property {string} title The tooltip
 * @property {boolean} warn Whether a plugin wrote at char 0
 */

/**
 * SillyTavern's request headers, imported when a request is actually made rather than at module load.
 *
 * ⚠️ LAZY SO THAT THE DECISIONS BELOW ARE TESTABLE. `provenanceFor`, `evictionNote` and `correlate` are the
 * rules that decide what a row may claim, and one of them shipped a real bug (see `evictionNote`) that a unit
 * test would have caught. A static import of `script.js` makes this whole module unloadable outside a
 * browser, and the tests would then have to be written against a copy — which is the same as not having them.
 * The specifier resolves identically either way; only the moment changes.
 * @returns {Promise<Record<string, string>>} Headers for a fetch to SillyTavern's own API
 */
async function requestHeaders() {
    const { getRequestHeaders } = await import('../../../../script.js');

    return getRequestHeaders();
}

/** Backend families the record route knows, matching what the four endpoints pass in (DESIGN.md §6.2a). */
const KNOWN_BACKENDS = ['text', 'chat', 'kobold', 'novel'];

/**
 * Generation types that produce a visible assistant turn, and so can legitimately be matched to a row.
 * A `quiet` summarisation or an `impersonate` is a generation this panel never lists.
 */
const USER_FACING_GEN_TYPES = ['normal', 'swipe', 'regenerate', 'continue'];

/**
 * How a turn's row got the prompt it is showing.
 * @enum {string}
 */
export const PROVENANCE = {
    /** The fork record's own text, byte-identical to what left the server, and a plugin changed it. */
    SENT: 'sent',
    /** The browser's copy, confirmed identical to what left the server by matching hashes. */
    CONFIRMED: 'confirmed',
    /** The browser's copy, on an install where nothing could have rewritten it. */
    BROWSER: 'browser',
    /** Nothing that can be stood behind — the final prompt is not visible to the client. */
    UNKNOWN: 'unknown',
};

/**
 * 🔴 `rewrittenBy` SEES SERVER-SIDE PLUGINS ONLY, AND A ROW MUST NEVER READ AS THE COMPLETE LIST. World Info,
 * the author's note, summaries and vector results are applied IN THE BROWSER, before the request is made, so
 * the server sees a finished prompt with no seam and nothing to report. A user whose World Book rewrites his
 * prompt every turn was shown "no plugin changed it" on every one of them; naming one server plugin while
 * silently omitting the client-side ones is misleading by omission, which is the failure this whole module
 * exists to prevent.
 */
const SERVER_SIDE_ONLY = "Server-side plugins only. World Info, the author's note, summaries and vector results are applied in the browser before the prompt is sent, so they never appear here — this is not the complete list of what shaped this prompt. Where one of them is what changed, the row's 'changed inside' note names it instead.";

/** @type {ProbeResult|null} */
let probed = null;

/** @type {boolean|null} */
let serverPluginsSeen = null;

/** seq (as a string, which is how the header and the timings event carry it) -> the backend's timings. */
const timingsBySeq = new Map();

/**
 * Map a SillyTavern `main_api` onto the record route's backend family.
 * @param {string} mainApi The value of `main_api`
 * @returns {string|null} The family, or null when this API never reaches the recorder
 */
export function backendFamily(mainApi) {
    switch (mainApi) {
        case 'textgenerationwebui':
            return 'text';
        case 'kobold':
        case 'koboldhorde':
            return 'kobold';
        case 'novel':
            return 'novel';
        case 'openai':
            return 'chat';
        default:
            return null;
    }
}

/**
 * Probe once for the fork record.
 *
 * ⚠️ A 404 IS AN OLDER FORK, NOT AN ERROR, and the difference matters: the envelope's `supported: true` with
 * an empty `records` array means the feature is there and nothing has been recorded yet, which resolves on
 * the next generation. A 404 never resolves, so the panel degrades permanently rather than waiting.
 * @returns {Promise<ProbeResult>} What the server said
 */
export async function probeRecord() {
    if (probed) {
        return probed;
    }

    try {
        const response = await fetch('/api/prompt-record/', { method: 'GET', headers: await requestHeaders() });

        if (!response.ok) {
            probed = { supported: false, depth: 0, backends: [] };
            return probed;
        }

        const body = await response.json();

        probed = {
            supported: body?.supported === true,
            depth: Number(body?.depth) || 0,
            backends: Array.isArray(body?.backends) ? body.backends : KNOWN_BACKENDS,
        };
    } catch {
        // A network failure is indistinguishable from an absent route from here, and both mean the same
        // thing to the reader: this panel cannot confirm anything about what was sent.
        probed = { supported: false, depth: 0, backends: [] };
    }

    return probed;
}

/**
 * Is any server plugin loaded on this install?
 *
 * 🔴 THIS IS THE QUESTION THE DEGRADED MODE TURNS ON. Without the record there is no way to know whether a
 * plugin rewrote a prompt, so the honest fallback is the weaker question the fork can already answer: is
 * there any server plugin here at all? `/api/plugins/client-config` is only mounted when the plugins
 * directory has something in it, so a 404 means nothing could have rewritten anything and the browser's copy
 * is exactly right. A 200 means something might have, and DESIGN.md §6.3 says to grey those turns rather
 * than draw a green bar nobody can stand behind.
 *
 * ⚠️ It is deliberately the pessimistic reading. A plugin that never touches prompts greys the panel on an
 * old fork, and that is the correct trade: the alternative is a confident bar that is silently wrong on
 * exactly the installs this tool is most needed on.
 * @returns {Promise<boolean>} True if at least one server plugin is loaded, or if we could not find out
 */
export async function hasServerPlugins() {
    if (serverPluginsSeen !== null) {
        return serverPluginsSeen;
    }

    try {
        const response = await fetch('/api/plugins/client-config', { method: 'GET', headers: await requestHeaders() });

        serverPluginsSeen = response.ok;
    } catch {
        serverPluginsSeen = true;
    }

    return serverPluginsSeen;
}

/**
 * Fetch the recorded prompts for one backend family.
 * @param {string} backend One of the known families
 * @returns {Promise<CacheRecord[]|null>} Records oldest first, or null when the feature is absent or the
 * request failed
 */
export async function fetchRecords(backend) {
    const probe = await probeRecord();

    if (!probe.supported || !KNOWN_BACKENDS.includes(backend)) {
        return null;
    }

    try {
        const response = await fetch(`/api/prompt-record/${backend}`, { method: 'GET', headers: await requestHeaders() });

        if (!response.ok) {
            return null;
        }

        const body = await response.json();

        return Array.isArray(body?.records) ? body.records : null;
    } catch {
        return null;
    }
}

/**
 * Fetch one record's raw prompt text, on demand, for the "view" button.
 *
 * Read a quiet record's prompt only when the user activates the view action and pass it directly to the popup.
 * Do not store it on a row, stamp, log, or module-level cache; `projectQuietRecord` remains the boundary for
 * data that enters a collection. A prompt that has aged out of the server's in-memory record window returns null.
 * @param {string} backend One of the known families
 * @param {string|undefined} recordId The record's durable identity, as carried on a raw row's stamp
 * @returns {Promise<string|null>} The prompt text, or null when the record, or its text, could not be found
 */
export async function fetchRecordPrompt(backend, recordId) {
    const records = await fetchRecords(backend);
    const match = Array.isArray(records) ? records.find(candidate => candidate?.recordId === recordId) : null;
    const text = match && typeof match.text === 'string' ? match.text : null;

    console.debug('[cache-lens] record.js fetchRecordPrompt: on-demand prompt read for the view button', {
        recordId, backend, found: match !== null && match !== undefined, textLength: text === null ? null : text.length,
    });

    return text;
}

/**
 * Remember what a backend reported about one generation.
 *
 * ⚠️ MEASURED, AND KEPT SEPARATE FROM ANYTHING PREDICTED. `raw` is the backend's own object passed through
 * unaltered — llama.cpp's `prompt_n`, `prompt_ms`, and `cache_n` on recent builds. A missing field is
 * missing; nothing here fills one in.
 * @param {string|number|null} seq The correlation handle from `X-ST-Prompt-Seq`
 * @param {RawTimings|null|undefined} raw The backend's timings object
 * @returns {void}
 */
export function noteTimings(seq, raw) {
    if (seq === null || seq === undefined || !raw) {
        return;
    }

    timingsBySeq.set(String(seq), raw);

    // The record store itself keeps five; there is no reason for this to grow past a session's worth of
    // turns, and it is only ever read for rows that still have a record behind them.
    if (timingsBySeq.size > 64) {
        const oldest = timingsBySeq.keys().next().value;

        if (oldest !== undefined) {
            timingsBySeq.delete(oldest);
        }
    }
}

/**
 * What the backend reported for a given record, if anything.
 * @param {string|number|null|undefined} seq The record's seq
 * @returns {RawTimings|null} The backend's own object, or null
 */
export function getTimings(seq) {
    if (seq === null || seq === undefined) {
        return null;
    }

    return timingsBySeq.get(String(seq)) ?? null;
}

/**
 * Hash a prompt the way the server hashed it, so "is this the string I built?" is one comparison.
 * @param {string|null|undefined} text The prompt
 * @returns {string|null} Lowercase hex SHA-256, or null when the bundled hasher is unavailable, or when
 * there was no prompt to hash
 */
export function hashPrompt(text) {
    const sha256 = globalThis.SillyTavern?.libs?.sha256;

    if (typeof sha256 !== 'function' || typeof text !== 'string') {
        return null;
    }

    try {
        return sha256(text);
    } catch {
        return null;
    }
}

/**
 * The metadata-only shape a `quiet` record is reduced to by `projectQuietRecord` — DESIGN_RAW_GENERATION_ROWS.md
 * §6.6 / §12 / §13. Every raw-row field this module will ever hand a caller, and nothing else.
 * @typedef {object} QuietRecordProjection
 * @property {string|undefined} recordId
 * @property {number} seq
 * @property {string|undefined} backend
 * @property {string|undefined} apiType
 * @property {string|undefined} chatId
 * @property {string} genType Always `'quiet'` — the projection's own guard refuses anything else
 * @property {number|undefined} at
 * @property {string|undefined} status
 * @property {number|undefined} completedAt
 * @property {string} usageState `available` | `absent` | `invalid` | `unknown`, from `usageCountsOf`
 * @property {number|null} inputTokens
 * @property {number|null} cachedTokens
 * @property {number|null} uncachedTokens
 */

/**
 * The validated usage counts `usageCountsOf` produces from a record's `usage` object.
 * @typedef {object} UsageCounts
 * @property {string} usageState `available` | `absent` | `invalid` | `unknown`
 * @property {number|null} inputTokens `null` unless `usageState === 'available'` — `0` is a real cache-hit
 * count and must never stand in for a missing measurement
 * @property {number|null} cachedTokens Same rule as `inputTokens`
 * @property {number|null} uncachedTokens Same rule as `inputTokens`
 */

/** The only usage schema `usageCountsOf` trusts — DESIGN_RAW_GENERATION_ROWS.md §6.1 / §9. Anything else,
 * present or not, is `'invalid'`: a schema the fork's own docs promise is stable, and a value the record
 * claims is something else is not a measurement this module has any way to interpret. */
const USAGE_SCHEMA = 'input-cache-v1';

/** Statuses DESIGN_RAW_GENERATION_ROWS.md §11.1 calls terminal. A record in one of these never transitions
 * again, which is what makes it safe to persist. */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Whether a value is a plausible token count — finite, an integer, never negative.
 * @param {unknown} value A candidate `inputTokens` / `cachedTokens` / `uncachedTokens`
 * @returns {value is number} True only for a finite non-negative integer
 */
function isFiniteNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Convert a record's `usage` into the three validated counts a raw stamp will hold.
 *
 * DESIGN_RAW_GENERATION_ROWS.md §6.1 / §6.3 / §9 / §15.3. A measurement is accepted ONLY when every one of
 * these holds: `usageState === 'available'`, `usage.schema === 'input-cache-v1'`, all three counts are
 * finite non-negative integers, `cachedTokens <= inputTokens`, and `cachedTokens + uncachedTokens ===
 * inputTokens`. Anything else is `'invalid'`, and rejection never falls back to a partial or zero count —
 * 🔴 EVERY COUNT IS `null` RATHER THAN `0` WHEN THERE IS NO MEASUREMENT, because `0` is a real cache-hit
 * count and must never stand in for a missing one.
 *
 * `'absent'` and `'unknown'` are deliberately different facts, and this function is the one place that keeps
 * them apart rather than collapsing them:
 * - `'absent'`: this Taproom build HAS the `usageState` field, and it says `'absent'` — the record genuinely
 *   has no cache accounting to report.
 * - `'unknown'`: the record carries no `usageState` field, as with older Taproom builds that do not report it.
 *   This differs from `'absent'`, an explicit report that the provider supplied no cache accounting.
 * @param {CacheRecord|null|undefined} record A parsed record from the route
 * @returns {UsageCounts} The validated counts, or nulls with a reason state
 */
export function usageCountsOf(record) {
    const nullCounts = { inputTokens: null, cachedTokens: null, uncachedTokens: null };
    const identity = { recordId: record?.recordId, seq: record?.seq, backend: record?.backend, apiType: record?.apiType };

    if (!record || record.usageState === undefined || record.usageState === null) {
        // No `usageState` field at all — an older Taproom build that predates the additive fields in
        // DESIGN_RAW_GENERATION_ROWS.md §6.1. This is 'unknown', never 'absent': the two read the same to a
        // naive check, but only 'unknown' means "upgrade the server and this resolves itself".
        console.debug('[cache-lens] record.js usageCountsOf: no usageState field, older Taproom build', identity);
        return { usageState: 'unknown', ...nullCounts };
    }

    if (record.usageState === 'absent') {
        console.debug('[cache-lens] record.js usageCountsOf: usageState absent', identity);
        return { usageState: 'absent', ...nullCounts };
    }

    if (record.usageState !== 'available') {
        // A value that is neither 'available', 'absent', nor undefined — including the wire's own 'invalid'
        // and anything this build has never seen — is never trusted, so it reads as 'invalid' rather than a
        // silently accepted new state this module was not written to understand.
        console.debug('[cache-lens] record.js usageCountsOf: usageState not available', { ...identity, usageState: record.usageState });
        return { usageState: 'invalid', ...nullCounts };
    }

    const usage = record.usage;

    /**
     * @param {string} reason A short, log-safe reason code — never any text that could carry provider content
     * @returns {UsageCounts}
     */
    const reject = (reason) => {
        console.debug('[cache-lens] record.js usageCountsOf: rejected as invalid', { ...identity, reason });
        return { usageState: 'invalid', ...nullCounts };
    };

    if (!usage || typeof usage !== 'object') {
        return reject('usageState available but usage object missing');
    }

    if (usage.schema !== USAGE_SCHEMA) {
        return reject('unrecognized usage schema');
    }

    const { inputTokens, cachedTokens, uncachedTokens } = usage;

    if (!isFiniteNonNegativeInteger(inputTokens) || !isFiniteNonNegativeInteger(cachedTokens) || !isFiniteNonNegativeInteger(uncachedTokens)) {
        return reject('a count is not a finite non-negative integer');
    }

    if (cachedTokens > inputTokens) {
        return reject('cachedTokens exceeds inputTokens');
    }

    if (cachedTokens + uncachedTokens !== inputTokens) {
        return reject('cachedTokens + uncachedTokens does not sum to inputTokens');
    }

    console.debug('[cache-lens] record.js usageCountsOf: accepted', { ...identity, inputTokens, cachedTokens, uncachedTokens });

    return { usageState: 'available', inputTokens, cachedTokens, uncachedTokens };
}

/**
 * A record's validated usage, in the `timings` shape the message-row bar already reads.
 *
 * Normalize provider usage to the `{ cache_n, prompt_n }` shape consumed by `bar.js` and `persist.js`.
 * `cachedTokens` is reused input; `uncachedTokens` is processed input. Validation remains in
 * `usageCountsOf`, and missing or invalid counts are never replaced with zero.
 * @param {CacheRecord|null|undefined} record A parsed record from the route
 * @returns {RawTimings|null} `{ cache_n, prompt_n }`, or null when the record carries no usable usage
 */
export function timingsFromRecordUsage(record) {
    if (!record || record.usageState === undefined || record.usageState === null) {
        return null;
    }

    const counts = usageCountsOf(record);

    if (counts.usageState !== 'available' || counts.cachedTokens === null || counts.uncachedTokens === null) {
        return null;
    }

    return { cache_n: counts.cachedTokens, prompt_n: counts.uncachedTokens };
}

/**
 * Whether a record has reached a terminal status, and so may be persisted.
 *
 * DESIGN_RAW_GENERATION_ROWS.md §7.4 step 5 / §11.1: a `pending` record stays live-only and is eligible on a
 * later refresh — it is never persisted. 🔴 A RECORD WITH NO `status` FIELD AT ALL IS ALSO NOT TERMINAL, AND
 * IS NOT PERSISTED: that shape is an older Taproom that predates DESIGN_RAW_GENERATION_ROWS.md §6.1, and
 * there is no way to know whether the request it describes ever finished, so treating a missing status as
 * terminal would risk durably storing a request that later failed or was still in flight when observed.
 * @param {CacheRecord|null|undefined} record A parsed record from the route
 * @returns {boolean} True only for `completed`, `failed`, or `cancelled`
 */
export function isTerminalRecord(record) {
    const terminal = typeof record?.status === 'string' && TERMINAL_STATUSES.includes(record.status);

    console.debug('[cache-lens] record.js isTerminalRecord', { recordId: record?.recordId, seq: record?.seq, status: record?.status, terminal });

    return terminal;
}

/**
 * Project a `quiet` record down to metadata only, before it can reach any durable store.
 *
 * DESIGN_RAW_GENERATION_ROWS.md §6.6 / §12: the record route's response carries the full prompt `text`
 * because ordinary rows still need it for the rewritten-prompt behavior — that contract is unchanged. But a
 * `quiet` record is a raw formatter request (Vocalis Quote-and-Send and callers like it), and its prompt must
 * never become a persisted artifact. 🔴 NOTHING FROM `text`, `hash`, `shape`, `rewrittenBy` OR `rewriteSites`
 * MAY REACH A RAW ROW, A STAMP, A DEBUG LOG, AN EXCEPTION MESSAGE, A TEST SNAPSHOT, OR A TOOLTIP — this
 * function is the one and only place that boundary is drawn, and every caller that stores a quiet record in
 * an extension collection MUST project it through here first, immediately, before it touches any collection.
 *
 * The result is a NEW object, built field by field — never the input with keys deleted, and never a shallow
 * copy — so nothing downstream can hold a reference back through the projection to the original record (and,
 * through it, to the text). Mutating the input after projecting never changes the projection.
 * @param {CacheRecord|null|undefined} record A parsed record from the route
 * @returns {QuietRecordProjection|null} The metadata-only projection, or null when `record` is missing or is
 * not a `quiet` record — callers are expected to call this only on quiet records, but the guard is
 * unconditional regardless of what a caller believes it is holding
 */
export function projectQuietRecord(record) {
    if (!record || record.genType !== 'quiet') {
        console.debug('[cache-lens] record.js projectQuietRecord: not a quiet record, refusing to project', {
            recordId: record?.recordId, seq: record?.seq, genType: record?.genType,
        });
        return null;
    }

    const counts = usageCountsOf(record);

    /** @type {QuietRecordProjection} */
    const projection = {
        recordId: record.recordId,
        seq: record.seq,
        backend: record.backend,
        apiType: record.apiType,
        chatId: record.chatId,
        genType: record.genType,
        at: record.at,
        status: record.status,
        completedAt: record.completedAt,
        usageState: counts.usageState,
        inputTokens: counts.inputTokens,
        cachedTokens: counts.cachedTokens,
        uncachedTokens: counts.uncachedTokens,
    };

    console.debug('[cache-lens] record.js projectQuietRecord: projected to metadata-only', {
        recordId: projection.recordId, seq: projection.seq, backend: projection.backend, apiType: projection.apiType,
        status: projection.status, usageState: projection.usageState,
    });

    return projection;
}

/**
 * Match each turn to the record of the generation that produced it.
 *
 * Three ways, in descending order of how much they can be stood behind:
 *
 * 1. **The seq we watched go past.** `GENERATION_TIMINGS` carries the correlation handle for the generation
 *    that was in flight at the time, so a turn bound then is bound exactly.
 * 2. **A hash match.** If the server's SHA-256 equals the hash of the browser's copy, that record IS this
 *    turn — and, since the bytes are identical, no plugin changed anything on the way out.
 * 3. **Elimination.** What is left over among records from this chat that were ordinary user-facing
 *    generations — used only when exactly one candidate fits exactly one turn.
 *
 * 🔴 AND WHEN NONE OF THE THREE FITS, THE TURN GETS NO RECORD. The point of the fork feature is to stop the
 * panel presenting a plausible prompt as a confirmed one; inventing a correlation here would put that
 * failure back, one level down where it is harder to see.
 * @param {Array<{mesId: number, rawPrompt: string, seq?: string|null}>} turns Newest first
 * @param {CacheRecord[]|null} records From `fetchRecords`, oldest first
 * @param {string|null} chatId The chat these turns belong to
 * @returns {Map<number, CacheRecord>} mesId -> record
 */
export function correlate(turns, records, chatId) {
    /** @type {Map<number, CacheRecord>} */
    const matched = new Map();

    if (!Array.isArray(records) || records.length === 0 || !Array.isArray(turns)) {
        return matched;
    }

    const unclaimed = new Set(records);
    const bySeq = new Map(records.map(record => [String(record.seq), record]));

    // 1. Bound at generation time, by the seq the response header carried.
    for (const turn of turns) {
        const record = turn.seq !== null && turn.seq !== undefined ? bySeq.get(String(turn.seq)) : undefined;

        if (record && unclaimed.has(record)) {
            matched.set(turn.mesId, record);
            unclaimed.delete(record);
        }
    }

    // 2. Byte-identical to what the browser built.
    //
    // Identical prompts can share a hash. Turns are visited newest-first, so claim the newest unclaimed record
    // to keep the prompt match aligned with record ordering and predecessor metadata.
    for (const turn of turns) {
        if (matched.has(turn.mesId)) {
            continue;
        }

        const hash = hashPrompt(turn.rawPrompt);

        if (!hash) {
            continue;
        }

        let best = null;

        for (const candidate of unclaimed) {
            if (candidate.hash === hash && (best === null || candidate.seq > best.seq)) {
                best = candidate;
            }
        }

        if (best) {
            matched.set(turn.mesId, best);
            unclaimed.delete(best);
        }
    }

    // 3. What is left, and only where the answer is forced rather than merely likely.
    const leftovers = [...unclaimed].filter(record => {
        const sameChat = chatId === null || record.chatId === undefined || record.chatId === chatId;
        const visible = record.genType === undefined || USER_FACING_GEN_TYPES.includes(record.genType);

        return sameChat && visible;
    });
    const stillMissing = turns.filter(turn => !matched.has(turn.mesId));

    if (leftovers.length === 1 && stillMissing.length === 1) {
        matched.set(stillMissing[0].mesId, leftovers[0]);
    }

    return matched;
}

/**
 * Decide what a row may claim about the prompt it is showing.
 * @param {CacheRecord|null} record The correlated record, if any
 * @param {boolean} recordSupported Whether the fork has the feature at all
 * @param {boolean} pluginsPresent Whether any server plugin is loaded
 * @returns {ProvenanceResult} What to show and what to say about it
 */
export function provenanceFor(record, recordSupported, pluginsPresent) {
    if (record) {
        const rewrittenBy = Array.isArray(record.rewrittenBy) ? record.rewrittenBy : [];
        const text = typeof record.text === 'string' ? record.text : null;

        if (rewrittenBy.length > 0) {
            return {
                provenance: PROVENANCE.SENT,
                text,
                rewrittenBy,
                label: `as sent — modified by ${rewrittenBy.join(', ')}`,
                detail: SERVER_SIDE_ONLY,
            };
        }

        return {
            provenance: PROVENANCE.CONFIRMED,
            text,
            rewrittenBy,
            label: 'as sent — no server plugin changed it',
            detail: SERVER_SIDE_ONLY,
        };
    }

    // 🔴 NO RECORD FOR THIS TURN IS NOT AUTOMATICALLY "UNKNOWN". The server keeps five, so any older turn —
    // and every turn at all after a browser reload — arrives here. What decides the answer is whether
    // anything on this install COULD have rewritten the prompt, which is the same question the degraded mode
    // turns on. With no server plugin loaded, the browser's copy is what was sent, and greying the row would
    // be refusing to answer a question that has an answer.
    if (recordSupported && pluginsPresent) {
        return {
            provenance: PROVENANCE.UNKNOWN,
            text: null,
            rewrittenBy: [],
            label: 'no server record for this turn, and a server plugin is loaded — final prompt not visible to the client',
            detail: 'The record keeps only the most recent generations per backend, so an older turn — or any turn after a browser reload — has none. With a server plugin loaded, what it sent cannot be reconstructed.',
        };
    }

    if (pluginsPresent) {
        return {
            provenance: PROVENANCE.UNKNOWN,
            text: null,
            rewrittenBy: [],
            label: 'final prompt not visible to the client',
            detail: "This build does not report what the server sent, and a server plugin is loaded, so the browser's copy cannot be assumed to be it.",
        };
    }

    return {
        provenance: PROVENANCE.BROWSER,
        text: null,
        rewrittenBy: [],
        label: "browser's copy — no server plugin is loaded, so nothing changed it on the way out",
        detail: SERVER_SIDE_ONLY,
    };
}

/**
 * Describe what ran between two generations, when the record can say.
 *
 * DESIGN.md §4.2: the comparison is against the previous request that actually reached the backend, not the
 * previous row in the chat. When something else got in between — a summarisation, a vector query, another
 * chat — the cache the turn met was not the one the previous turn left, and the row says so instead of
 * drawing a confidently wrong bar.
 * Identify the predecessor by the hash of the previous prompt as sent, not by whether its record was
 * correlated to a row. A matching `prevSeq` is insufficient when the prior turn has not been correlated.
 * @param {CacheRecord|null} record This turn's record
 * @param {CacheRecord|null} predecessor The record this turn's `prevSeq` points at, if it is still held
 * @param {string|null} previousPromptHash Hash of the previous turn's prompt as sent — the previous record's
 * own `hash` when it was correlated, or the hash of the browser's copy when nothing rewrote it
 * @returns {EvictionNote} Whether the baseline is the cache predecessor, and what to say
 */
export function evictionNote(record, predecessor, previousPromptHash) {
    if (!record) {
        // Without the record there is nothing to say, and DESIGN.md §6.3 is explicit that the row shows no
        // predecessor annotation rather than assuming the previous chat turn.
        return { ok: true, note: null };
    }

    if (record.prevSeq === null || record.prevSeq === undefined) {
        return { ok: true, note: 'first generation on this backend' };
    }

    if (!predecessor) {
        return { ok: false, note: 'predecessor unknown — the cache may have been overwritten' };
    }

    if (previousPromptHash && predecessor.hash === previousPromptHash) {
        return { ok: true, note: null };
    }

    const differentChat = predecessor.chatId !== undefined
        && record.chatId !== undefined
        && predecessor.chatId !== record.chatId;

    if (differentChat) {
        return { ok: false, note: 'evicted by: another chat' };
    }

    if (predecessor.genType && !USER_FACING_GEN_TYPES.includes(predecessor.genType)) {
        return { ok: false, note: `evicted by: ${predecessor.genType}` };
    }

    // Same chat, an ordinary generation, and yet not the prompt this row is comparing against. Something
    // happened in between that cannot be named — a discarded swipe, another tab — and naming it anyway is
    // the confidently-wrong bar §4.2 exists to prevent.
    return { ok: false, note: 'predecessor is not the previous turn' };
}

/**
 * Whether a site the route sent carries the three fields the resolver needs.
 *
 * ⚠️ A TYPE PREDICATE, BECAUSE `.filter` DOES NOT NARROW AN ELEMENT TYPE WITHOUT ONE — and the whole
 * point of this filter is that the wire may carry junk. The `typeof` tests are what `Number.isFinite`
 * already implies at runtime (it is false for anything that is not a number); they are spelled out so the
 * compiler agrees, rather than being told to trust the result.
 * @param {RawRewriteSite} site A site as sent
 * @returns {site is {id: string, atChar: number, delta: number}} Whether it can be resolved
 */
function usableSite(site) {
    return typeof site?.id === 'string'
        && typeof site.atChar === 'number' && Number.isFinite(site.atChar) && site.atChar >= 0
        && typeof site.delta === 'number' && Number.isFinite(site.delta);
}

/**
 * Where each server plugin actually wrote, mapped onto the prompt as sent.
 *
 * 🔴 AN OBSERVATION, NEVER A CONFIGURATION. A plugin's configured depth says where it MEANT to write; only
 * this says where it landed, and the two come apart precisely in the case worth showing — the depth anchor
 * that cannot find its place degrades to prepending SILENTLY. So the panel prints what the record observed
 * and never a depth it was not told.
 *
 * ⚠️ OFFSETS ARE SEQUENTIAL, NOT FINAL. `atChar` is against the prompt as it stood when that plugin ran, so
 * with two writers the first one's offset is in a string the second one then changed. Each is walked forward
 * through the writers that followed it: a later insertion at or before a position pushes that position right
 * by its delta, and one after it does not move it at all.
 *
 * ⚠️ AND A POSITION THAT DOES NOT EXIST IN THE TEXT IS NOT PRINTED. If the arithmetic lands outside the
 * prompt as sent, the mapping is wrong in some way this code cannot see, and `atFinal` is withheld rather
 * than pointing a reader at a character that is not there.
 * @param {CacheRecord|null} record A record from the route
 * @returns {RewriteSite[]} The sites, in the order the plugins ran, with malformed entries dropped
 */
export function rewriteSitesOf(record) {
    const raw = Array.isArray(record?.rewriteSites) ? record.rewriteSites : [];
    const sites = raw.filter(usableSite);
    const length = typeof record?.text === 'string' ? record.text.length : null;

    return sites.map((site, index) => {
        let position = site.atChar;

        for (let later = index + 1; later < sites.length; later++) {
            if (sites[later].atChar <= position) {
                position += sites[later].delta;
            }
        }

        const fits = length === null
            ? false
            : position >= 0 && position + Math.max(0, site.delta) <= length;

        return {
            id: site.id,
            atChar: site.atChar,
            delta: site.delta,
            atFinal: fits ? position : null,
            // 🔴 THE WHOLE REASON THE FIELD EXISTS. A plugin that wrote at char 0 either meant to prepend or
            // is a depth anchor that could not place itself and fell back to prepending without saying so.
            // This code cannot tell which — it was never told the configured depth — so it reports the
            // observation and lets the row say both readings out loud.
            prepended: site.atChar === 0,
        };
    });
}

/**
 * The sites, as a sentence for the row.
 *
 * 🔴 EVERY NUMBER HERE IS OBSERVED. There is no configured depth in this string and there must never be one:
 * a plugin's settings say where it intended to write, and the case worth surfacing is exactly the one where
 * intention and outcome disagree.
 * @param {RewriteSite[]|null|undefined} sites From `rewriteSitesOf`, which answers null when nothing
 * rewrote the prompt — the guard on the first line is what that null is for
 * @returns {RewriteNote|null} The note, or null when nothing rewrote it
 */
export function describeRewrites(sites) {
    if (!Array.isArray(sites) || sites.length === 0) {
        return null;
    }

    const parts = sites.map((site) => {
        const at = site.atFinal ?? site.atChar;
        const where = site.prepended ? 'at the very start' : `at char ${at.toLocaleString()}`;

        if (site.delta > 0) {
            return `${site.id} added ${site.delta.toLocaleString()} chars ${where}`;
        }

        if (site.delta < 0) {
            return `${site.id} removed ${Math.abs(site.delta).toLocaleString()} chars ${where}`;
        }

        return `${site.id} rewrote in place ${where}`;
    });
    const prepended = sites.filter(site => site.prepended);
    const unplaceable = sites.some(site => site.atFinal === null);
    const notes = ['Where each server plugin actually wrote — observed, not configured.'];

    if (prepended.length > 0) {
        notes.push(`${prepended.map(site => site.id).join(', ')} wrote at char 0. If it is configured to inject at a depth, it could not place itself and fell back to prepending — which happens silently, and puts its text ahead of everything the cache had. If it is configured to prepend, this is simply what that looks like.`);
    }

    if (unplaceable) {
        notes.push('One offset could not be located in the prompt as sent, so it is shown as the plugin reported it.');
    }

    return { text: parts.join('  ·  '), title: notes.join(' '), warn: prepended.length > 0 };
}

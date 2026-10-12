/**
 * Cache Lens — how much of each turn's prompt the backend's KV cache could reuse.
 *
 * A local backend reuses the prompt prefix up to its first difference. The panel shows that reuse per turn;
 * see DESIGN.md §1.
 *
 * This module is the entry point and the model: it decides what each row means. `panel.js` decides what it
 * looks like, `prefix.js` and `attribution.js` do the arithmetic, and `record.js` talks to the fork.
 */

// `syncMesToSwipe` is exported by script.js but is not available through `getContext()`.
import { eventSource, event_types, itemizedPrompts, main_api, syncMesToSwipe } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

import { attributeOffset, changedClientComponents, locateSections, unplacedClientComponents } from './attribution.js';
import { measurementFromRawStamp, measurementFromTimings } from './bar.js';
import { openPanel, refreshPanel } from './panel.js';
import {
    RAW_ENVELOPE_VERSION,
    buildRawStamp,
    buildStamp,
    mergeRawRequests,
    rawEnvelopeVersionOf,
    readRawRequests,
    readStamp,
    stampVersionOf,
    timingsFromStamp,
    writeRawRequests,
} from './persist.js';
import { describeReuse } from './prefix.js';
import {
    PROVENANCE,
    backendFamily,
    correlate,
    evictionNote,
    fetchRecords,
    getTimings,
    hasServerPlugins,
    hashPrompt,
    describeRewrites,
    isTerminalRecord,
    noteTimings,
    probeRecord,
    projectQuietRecord,
    provenanceFor,
    rewriteSitesOf,
    timingsFromRecordUsage,
    usageCountsOf,
} from './record.js';

/** How many turns the panel lists. DESIGN.md §12.2 — the record is per-chat and unbounded, so this is a render budget. */
const ROW_COUNT = 10;

/** Context either side of the divergence in the expanded row (DESIGN.md §8). */
export const EXPANSION_CONTEXT = { before: 30, after: 70 };

/**
 * Client-side prompt hash -> the `X-ST-Prompt-Seq` the server answered with.
 *
 * Pair the browser-sent prompt hash with the server-returned sequence header. Rewritten prompts cannot be
 * matched by hashing the stored text; timestamps or chat ids are ambiguous when generations overlap.
 */
const seqByClientHash = new Map();

/** Token counts are expensive and stable; keyed by (chatId, mesId, hash of what was counted). */
const tokenCache = new Map();

/** @type {boolean} */
let fetchWrapped = false;

/**
 * Note the correlation handle for a generation the browser just made.
 * @param {string|null} clientHash Hash of the prompt as the browser sent it, or null when it could
 * not be hashed
 * @param {string} seq The value of `X-ST-Prompt-Seq`
 * @returns {void}
 */
function noteSeq(clientHash, seq) {
    if (!clientHash || !seq) {
        return;
    }

    seqByClientHash.set(clientHash, seq);

    while (seqByClientHash.size > 64) {
        const oldest = seqByClientHash.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        seqByClientHash.delete(oldest);
    }
}

/**
 * Watch generation requests go past and keep the seq they came back with.
 *
 * Read the response header without consuming the body or replacing the response. Failure only loses this
 * turn's correlation; it does not affect the request.
 * @returns {void}
 */
function installSeqCapture() {
    if (fetchWrapped) {
        return;
    }

    fetchWrapped = true;

    const original = globalThis.fetch;

    globalThis.fetch = async function cacheLensFetch(input, init) {
        const response = await original.call(this, input, init);

        try {
            const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));

            if (!/\/api\/(backends\/|novelai\/generate)/.test(url)) {
                return response;
            }

            const seq = response.headers?.get?.('X-ST-Prompt-Seq');

            if (!seq) {
                return response;
            }

            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            // The chat path records `JSON.stringify(messages)`, which is the level the browser's own copy
            // exists at; the text paths record the prompt string itself.
            const sent = typeof body?.prompt === 'string'
                ? body.prompt
                : (Array.isArray(body?.messages) ? JSON.stringify(body.messages) : null);

            if (typeof sent === 'string') {
                noteSeq(hashPrompt(sent), seq);
            }
        } catch {
            // A generation whose seq we could not capture simply falls back to hashing, and failing that to
            // saying it does not know. Nothing here is worth failing a generation over.
        }

        return response;
    };
}

/**
 * The chat id the panel is looking at.
 * @returns {string|null} The current chat's id, or null when there is no chat
 */
function currentChatId() {
    const chatId = getContext()?.chatId;

    return typeof chatId === 'string' && chatId.length > 0 ? chatId : null;
}

/**
 * Data for one chat message in the panel. `buildRows` resolves its provenance and ordering once so `bar.js`
 * and `panel.js` do not independently infer them.
 *
 * Measurements may come from the stored stamp, this page's live state, or a prefix scan. `measurementSource`
 * and `recorded` preserve that distinction; a stored measurement describes the backend when it was recorded.
 * Missing measurements remain `null`, never zero, so “not measured” stays distinct from “measured as none.”
 *
 * This is the message half of `Row = MessageRow | RawRow`. SillyTavern `quiet` generations have no chat
 * message, prompt text, or baseline; consumers dispatch on `kind` before reading message-only fields.
 * @typedef {object} MessageRow
 * @property {'message'} kind Discriminant; see `RawRow` below
 * @property {string} rowKey `message:<mesId>` — expansion state and DOM identity key off this, not `mesId`,
 * so the same code can key a `raw:<recordId>` row identically
 * @property {number|null} requestedAt Request time and primary newest-first sort key: matched server record
 * `at`, then stamp `requestAt`, then stamp `at`; otherwise `null`. `buildRows` sorts missing times last and
 * uses `mesId` as the message-row tie-breaker.
 * @property {import('./bar.js').CacheMeasurement|null} measurement This row's measurement, provider-neutral
 * (§9) — `measurementFromTimings(timings)` for a message row. `null` when nothing was measured.
 * @property {number} mesId Which message in the chat
 * @property {string|null} seq The correlation handle, kept on the row so `captureMeasurement` can write it
 * into the stamp without redoing the matching
 * @property {string|null} baselineSeq The handle of whatever this row compared against
 * @property {import('./record.js').RewriteSite[]} rewriteSites Where each server plugin actually wrote —
 * observed, never configured (§6.2c)
 * @property {string} promptText The prompt this row is showing, at the best provenance available
 * @property {boolean} promptKnown Whether prompt text is available; stored measurements may outlive browser
 * prompt storage.
 * @property {string|null} baselineText What it was compared against, when there was anything
 * @property {boolean} hasBaseline Whether a comparison happened at all
 * @property {'first-turn'|'no-prompt'|'predecessor-gone'|null} baselineMissing Why no comparison exists;
 * `hasBaseline` alone cannot distinguish these cases.
 * @property {number} prefixChars The shared prefix, in characters
 * @property {number} promptChars The whole prompt, in characters
 * @property {number} charRatio `prefixChars / promptChars`
 * @property {number} maxContext The context window, or 0 when none was recorded
 * @property {string} tokenizer Which tokenizer produced the browser-side counts
 * @property {string} provenance One of `PROVENANCE`
 * @property {string} provenanceLabel The short phrase the row prints
 * @property {string} provenanceDetail The caveat the tooltip carries
 * @property {string[]} rewrittenBy Server-side plugins that changed the prompt; client-side changes are in
 * `clientChanges`.
 * @property {string|null} evictionNote What got in between this turn and its baseline, if anything
 * @property {boolean} greyed Whether prompt text is untrustworthy; the backend measurement remains valid.
 * @property {string|null} greyedReason Why
 * @property {boolean} recorded Whether a stamp was found on the message
 * @property {number|null} measuredAt When the measurement was taken, for `describeAge`
 * @property {'recorded'|'live'|null} measurementSource Which of the three sources drew this row
 * @property {number|null} unreadableStamp Version of a stamp this build cannot read, distinct from no stamp.
 * @property {string|null} attribution The prompt section the divergence falls in
 * @property {import('./record.js').RewriteSite|null} rewriteHit The plugin whose inserted text the
 * divergence landed inside. A plugin's insertion is not one of the prompt's own sections, so attributing it
 * to Chat History would send a reader to fix the wrong thing.
 * @property {import('./record.js').RewriteNote|null} rewriteNote Rewrite sites summarized as a sentence
 * @property {string[]} clientChanges Client-side components that differ from the previous turn's. World
 * Info, the author's note, summaries and vectors are applied in the browser, so `rewrittenBy` is silent
 * about them by construction.
 * @property {string[]} clientUnplaced Components in the breakdown but absent from the prompt, such as World
 * Info removed by the context limiter.
 * @property {import('./record.js').RawTimings|null} timings The backend's own numbers
 * @property {number|null} promptTokens The whole prompt, by the browser's tokenizer
 * @property {number|null} prefixTokens The shared prefix, by the browser's tokenizer
 */

/**
 * Data for a SillyTavern `quiet` generation, including raw formatter requests such as Quote-and-Send. It has
 * no chat message, prompt text, baseline, prefix, or itemized breakdown, so message-only consumers must not
 * treat it as a prompt comparison. Consumers dispatch on `kind` before using row-specific fields.
 * @typedef {object} RawRow
 * @property {'raw'} kind Discriminant; see `MessageRow` above
 * @property {string} rowKey `raw:<recordId>`; `stamp.id` is the durable prompt-record UUID used for merges
 * @property {number} requestedAt `stamp.requestedAt` — newest-first ordering's primary key (§8)
 * @property {string|null} seq The correlation handle in effect when this was captured — display-only; `id`
 * (inside `stamp`) is the durable identity
 * @property {import('./bar.js').CacheMeasurement|null} measurement `measurementFromRawStamp(stamp)` — `null`
 * when usage was not available, the request failed, or it was cancelled. Never a fabricated zero.
 * @property {import('./persist.js').RawRequestStamp} stamp The persisted stamp this row was built from
 */

/**
 * One row of the panel, message or raw (DESIGN_RAW_GENERATION_ROWS.md §8). Both variants carry `rowKey`,
 * `kind`, `requestedAt`, `seq` and `measurement`; `MessageRow` and `RawRow` add the rest.
 * @typedef {MessageRow | RawRow} Row
 */

/**
 * What the panel may claim, as opposed to what any single row says.
 * @typedef {object} Mode
 * @property {boolean} recordSupported Whether the fork has the record feature at all
 * @property {number} depth How many prompts the fork keeps
 * @property {boolean} pluginsPresent Whether any server plugin is loaded
 * @property {string|null} backend The backend family, or null when this API never reaches the recorder
 * @property {number} recordsSeen How many records the fetch returned
 * @property {boolean} rawUsageSupported DESIGN_RAW_GENERATION_ROWS.md §11.4: false when the fetched records
 * expose no usage fields at all — `usageCountsOf` answering `'unknown'` for a record that is otherwise
 * terminal, meaning this Taproom build predates the additive usage fields. Raw rows can still be listed; they
 * simply carry no measurement, and a zero is never substituted for one.
 * @property {number|null} rawEnvelopeUnreadable The chat's raw-envelope version when this build cannot read
 * it (`rawEnvelopeVersionOf` present and not equal to `RAW_ENVELOPE_VERSION`), else `null` — the same
 * "too new to read" vs. "nothing recorded" distinction `unreadableStamp` states for a message row (§7.2).
 * @property {number} rawRows How many of the listed rows are `kind: 'raw'`
 */

/**
 * One turn as `buildRows` stages it, before it becomes a `Row`.
 * @typedef {object} Turn
 * @property {number} mesId Which message
 * @property {string|null|undefined} rawPrompt The browser's copy, absent once it ages out of the store. A
 * chat-completion message array is already `JSON.stringify`'d here — see `promptTextOf`
 * @property {boolean} messageArray Whether that copy was a chat-completion message array, so a section's text
 * has to be JSON-escaped before it can be found in it
 * @property {string|null} seq The handle this page watched go past
 * @property {STItemizedPrompt|null} itemized The breakdown the browser kept
 * @property {import('./persist.js').Stamp|null} stamp The measurement stored with the message
 * @property {number|null} stampVersion The schema version on the message, readable or not
 */

/**
 * The payload of `event_types.GENERATION_TIMINGS`, as DESIGN.md §6.2a defines it.
 * @typedef {object} TimingsEvent
 * @property {string|number|null} [seq] The correlation handle, the same value `X-ST-Prompt-Seq` carries
 * @property {import('./record.js').RawTimings|null} [raw] The backend's own object, passed through unaltered
 */

/**
 * Whether a staged turn has a prompt the server could have recorded.
 *
 * Keep stamp-only turns out of correlation: its final pass assigns a record only when one prompt candidate
 * matches one turn, so turns without prompts would skew that candidate count.
 * @param {Turn} turn A staged turn
 * @returns {turn is Turn & {rawPrompt: string}} Whether it has one
 */
function hasPrompt(turn) {
    return typeof turn.rawPrompt === 'string';
}

/**
 * One itemized entry's prompt as the text this panel compares, or null when it holds none.
 *
 * Chat-completion entries contain a message array, while other providers may supply a string. Normalize the
 * array with `JSON.stringify` to match the request body hashed by `installSeqCapture`, keeping both sides
 * comparable.
 * @param {STItemizedPrompt|null|undefined} entry One entry of `itemizedPrompts`
 * @returns {string|null} The prompt text, or null for an empty or absent prompt
 */
function promptTextOf(entry) {
    const raw = entry?.rawPrompt;

    if (typeof raw === 'string') {
        return raw.length > 0 ? raw : null;
    }

    // An empty array is the chat-completion form of the empty string: nothing the panel could say anything about.
    return Array.isArray(raw) && raw.length > 0 ? JSON.stringify(raw) : null;
}

/**
 * A piece of text as it appears INSIDE a `JSON.stringify(messages)` prompt.
 *
 * Message-array prompts are JSON strings; escape section text the same way before searching so present
 * components are not reported as unplaced.
 * @param {string|undefined} text The text as the itemized record holds it
 * @returns {string|undefined} The same text, JSON-escaped, or it unchanged when it is not a string
 */
function jsonEscaped(text) {
    return typeof text === 'string' ? JSON.stringify(text).slice(1, -1) : text;
}

/**
 * @param {string|undefined} text Unchanged
 * @returns {string|undefined} The same text
 */
function verbatim(text) {
    return text;
}

/**
 * The prompt sections of one itemized record, in prompt order, for attribution.
 *
 * Preserve section nesting so attribution reports the most specific matching section.
 * @param {STItemizedPrompt} itemized One entry of `itemizedPrompts`
 * @param {STChatMessage[]} chatMessages The chat, for naming individual turns
 * @param {(text: string|undefined) => string|undefined} [encode] How a section's text appears in the prompt —
 * `jsonEscaped` for a message-array prompt, verbatim otherwise
 * @returns {import('./attribution.js').SectionSpec[]} Sections in prompt order
 */
function sectionsOf(itemized, chatMessages, encode = verbatim) {
    /** @type {import('./attribution.js').SectionSpec[]} */
    const historyChildren = [
        { name: 'Summary', text: encode(itemized.summarizeString) },
        { name: "Author's Note", text: encode(itemized.authorsNoteString) },
        { name: 'Vector Memories', text: encode(itemized.chatVectorsString) },
        { name: 'Data Bank', text: encode(itemized.dataBankVectorsString) },
    ];

    // Turns, named by their position in the chat. A short message that occurs many times resolves to nothing
    // and the history block answers for it instead, which is the ambiguity rule doing its job.
    for (let index = 0; index < chatMessages.length; index++) {
        const message = chatMessages[index];

        if (typeof message?.mes === 'string' && message.mes.length > 0) {
            historyChildren.push({ name: `Chat History (turn ${index})`, text: encode(message.mes) });
        }
    }

    return [
        {
            name: 'Story String',
            text: encode(itemized.storyString),
            children: [
                { name: 'Instruct Scaffold', text: encode(itemized.instruction) },
                { name: 'World Info', text: encode(itemized.worldInfoString) },
                { name: 'Character Definition', text: encode(itemized.charDescription) },
                { name: 'Character Personality', text: encode(itemized.charPersonality) },
                { name: 'Scenario', text: encode(itemized.scenarioText) },
                { name: 'User Persona', text: encode(itemized.userPersona) },
            ],
        },
        { name: 'Examples', text: encode(itemized.examplesString) },
        {
            name: 'Chat History',
            text: encode(itemized.mesSendString),
            // Depth-injected sections have no fixed relative position in chat history.
            orderedChildren: false,
            children: historyChildren,
        },
    ];
}

/**
 * Which server plugin's insertion an offset landed inside, if any.
 *
 * Only inserted text has a span in the final prompt; removals and in-place rewrites cannot own an offset.
 * @param {import('./record.js').RewriteSite[]} sites From `rewriteSitesOf`
 * @param {number} offset A character offset into the prompt as sent
 * @returns {import('./record.js').RewriteSite|null} The site, or null
 */
function rewriteAt(sites, offset) {
    if (!Number.isFinite(offset)) {
        return null;
    }

    return sites.find(site => site.atFinal !== null
        && site.delta > 0
        && offset >= site.atFinal
        && offset < site.atFinal + site.delta) ?? null;
}

/**
 * Count tokens once per distinct string per turn.
 * @param {string} key Cache key
 * @param {string} text The text to count
 * @returns {Promise<number|null>} The count, or null if the tokenizer failed
 */
async function countTokens(key, text) {
    if (tokenCache.has(key)) {
        return tokenCache.get(key);
    }

    try {
        const count = await getContext().getTokenCountAsync(text);

        tokenCache.set(key, count);

        return count;
    } catch {
        return null;
    }
}

/**
 * Which of the message ids inside the listed span are messages the reader sent.
 *
 * Generation messages are stamped with the next message id, leaving gaps where user messages occur. These
 * gaps are not missing generations. Consider only message rows: raw rows have no `mesId` and cannot identify
 * or close a message-id gap.
 * @param {STChatMessage[]} chatMessages The chat
 * @param {MessageRow[]} listed The message rows the panel is about to draw
 * @returns {Set<number>} The ids, within the listed span, of messages the reader sent
 */
function userMessageIds(chatMessages, listed) {
    /** @type {Set<number>} */
    const ids = new Set();

    if (listed.length === 0) {
        return ids;
    }

    // Rows are newest first, so the span runs from the last row's id up to the first's.
    for (let index = listed[listed.length - 1].mesId; index <= listed[0].mesId; index++) {
        if (chatMessages[index]?.is_user === true) {
            ids.add(index);
        }
    }

    return ids;
}

/**
 * Raw-generation capture orchestration (DESIGN_RAW_GENERATION_ROWS.md §7.4, §11.3).
 *
 * A global in-flight promise and one queued rerun serialize captures. Each pass snapshots and rechecks chat,
 * character, group, and metadata identity before mutation, so results from a prior chat are discarded safely.
 * A second chat waits for the active fetch rather than running concurrently.
 * @type {Promise<{added: number, saved: boolean}>|null}
 */
let activeCapture = null;

/** Whether a capture was requested while one was already in flight — resolved by exactly one extra pass. */
let captureRerunQueued = false;

/**
 * One pass of §7.4 steps 1–10, run to completion without regard for what triggered it.
 *
 * This is the only raw-stamp write path; log decisions and discard reasons so missing rows can be diagnosed.
 * @returns {Promise<{added: number, saved: boolean}>} How many stamps were newly merged in, and whether a
 * save actually went out — a test's hook into whether this pass did anything
 */
async function runCaptureOnce() {
    try {
        // Step 1: snapshot chat/character/group identity and the metadata OBJECT ITSELF, not a copy of its
        // fields — §7.4 step 1, §11.3. `script.js` replaces `chat_metadata` wholesale on every chat load, so
        // `!==` against this snapshot is what later steps use to detect "the reader has moved on".
        const context = getContext();
        const chatId = currentChatId();
        const characterId = context?.characterId ?? null;
        const groupId = context?.groupId ?? null;
        const chatMetadata = context?.chatMetadata ?? null;
        const family = backendFamily(main_api);

        console.debug('[cache-lens] index.js runCaptureOnce: starting pass', { chatId, characterId, groupId, family });

        if (!chatId || !family || !chatMetadata) {
            console.debug('[cache-lens] index.js runCaptureOnce: no chat, no backend family, or no metadata object — nothing to capture', {
                chatId, family, hasMetadata: chatMetadata !== null,
            });

            return { added: 0, saved: false };
        }

        // Step 2: fetch current records for the active backend. `fetchRecords` itself answers null on an
        // unsupported install or a failed request — §11.4's "retain existing persisted rows, log one concise
        // warning, and retry on the next normal trigger" is exactly this early return.
        const records = await fetchRecords(family);

        if (!Array.isArray(records)) {
            console.debug('[cache-lens] index.js runCaptureOnce: record fetch failed or unsupported, retaining existing rows', { chatId, family });

            return { added: 0, saved: false };
        }

        // Step 3: project EVERY `quiet` record to metadata-only immediately. Nothing downstream — no local,
        // no log, no candidate array — may ever hold the unprojected record; `projectQuietRecord` is the one
        // and only place that boundary is drawn (record.js §6.6/§12/§13), and the raw `records` array is not
        // read again after this loop.
        /** @type {import('./record.js').QuietRecordProjection[]} */
        const projections = [];

        for (const record of records) {
            if (record?.genType !== 'quiet') {
                continue;
            }

            const projection = projectQuietRecord(record);

            if (projection) {
                projections.push(projection);
            }
        }

        /** @type {import('./persist.js').RawRequestStamp[]} */
        const stamps = [];

        for (const projection of projections) {
            // Step 4: the chat id must EXACTLY equal the snapshotted chat. An absent or mismatched chat id is
            // never guessed at — §7.4 step 4, §11.2.
            if (projection.chatId !== chatId) {
                console.debug('[cache-lens] index.js runCaptureOnce: discarded candidate, wrong or missing chatId', {
                    recordId: projection.recordId, seq: projection.seq, projectionChatId: projection.chatId, chatId,
                });

                continue;
            }

            // Step 5: terminal only. A `pending` record — or one from a Taproom too old to say `status` at
            // all — stays live-only and is eligible on the next refresh (§7.4 step 5, §11.1).
            if (!isTerminalRecord(/** @type {import('./record.js').CacheRecord} */ (/** @type {unknown} */ (projection)))) {
                console.debug('[cache-lens] index.js runCaptureOnce: discarded candidate, not terminal', {
                    recordId: projection.recordId, seq: projection.seq, status: projection.status,
                });

                continue;
            }

            // Step 6: validate and convert to a `RawRequestStamp`. `buildRawStamp` (persist.js) is the single
            // place that enforces the untrusted-JSON invariants — this call supplies fields, it does not
            // re-check them.
            const stamp = buildRawStamp({
                id: projection.recordId,
                backend: projection.backend,
                apiType: projection.apiType,
                seq: projection.seq,
                generationType: projection.genType,
                requestedAt: projection.at,
                completedAt: projection.completedAt,
                status: projection.status,
                usageState: projection.usageState,
                inputTokens: projection.inputTokens,
                cachedTokens: projection.cachedTokens,
                uncachedTokens: projection.uncachedTokens,
            });

            if (stamp) {
                stamps.push(stamp);
            } else {
                console.debug('[cache-lens] index.js runCaptureOnce: buildRawStamp refused candidate', {
                    recordId: projection.recordId, seq: projection.seq, status: projection.status,
                });
            }
        }

        // Step 8 (first check): re-verify chat id, character/group identity, and the metadata OBJECT IDENTITY
        // before the merge is even computed against it. `captureMeasurement` below has the same shaped guard
        // for message stamps, and for the same reason: the fetch above was an await, and a chat switch or a
        // delete can land underneath it.
        const identityStillCurrent = () => {
            const now = getContext();

            return currentChatId() === chatId
                && (now?.characterId ?? null) === characterId
                && (now?.groupId ?? null) === groupId
                && now?.chatMetadata === chatMetadata;
        };

        if (!identityStillCurrent()) {
            console.debug('[cache-lens] index.js runCaptureOnce: discarded whole pass, chat identity changed before merge', { chatId, candidateCount: stamps.length });

            return { added: 0, saved: false };
        }

        // If the envelope version is unreadable, report it and leave the metadata untouched. Reading it as an
        // empty list would make a later merge overwrite entries written by a newer version.
        const envelopeVersion = rawEnvelopeVersionOf(chatMetadata);

        if (envelopeVersion !== null && envelopeVersion !== RAW_ENVELOPE_VERSION) {
            console.debug('[cache-lens] index.js runCaptureOnce: envelope unreadable by this build, pass aborted before touching it', {
                chatId, envelopeVersion, expected: RAW_ENVELOPE_VERSION, candidateCount: stamps.length,
            });

            return { added: 0, saved: false };
        }

        // Step 7: merge by `id` against what is already persisted.
        const existing = readRawRequests(chatMetadata);
        const { merged, changed } = mergeRawRequests(existing, stamps);
        const existingIds = new Set(existing.map(s => s.id));
        const added = stamps.filter(s => !existingIds.has(s.id)).length;

        // Step 9: an unchanged merge saves NOTHING. Not a debounced save, not a save "just in case" — none.
        if (!changed) {
            console.debug('[cache-lens] index.js runCaptureOnce: merge unchanged, no save', {
                chatId, existingCount: existing.length, candidateCount: stamps.length,
            });

            return { added: 0, saved: false };
        }

        // Step 8 (second check): re-verify identity again, immediately before the write, for the same reason
        // as the first check — `readRawRequests`/`mergeRawRequests` above did not await anything, but the
        // caller of this pass may have been queued behind another one that did.
        if (!identityStillCurrent()) {
            console.debug('[cache-lens] index.js runCaptureOnce: discarded whole pass, chat identity changed before save', { chatId, added });

            return { added: 0, saved: false };
        }

        writeRawRequests(chatMetadata, merged);

        // Step 10: save through `context.saveMetadata()`, without blocking response display — this whole
        // function already runs detached from any event handler's return value (see `init()` below). A save
        // failure keeps the in-memory merge and retries on the next trigger (§11.4); it never fails loudly.
        let saved = false;

        try {
            await context.saveMetadata?.();
            saved = true;
            console.debug('[cache-lens] index.js runCaptureOnce: saved', { chatId, mergedCount: merged.length, added });
        } catch (error) {
            console.debug('[cache-lens] index.js runCaptureOnce: saveMetadata threw, keeping in-memory merge for the next trigger', {
                chatId, error: error instanceof Error ? error.message : String(error),
            });
        }

        // A new row exists now, in memory at least — the reader should see it without doing anything.
        refreshPanel();

        return { added, saved };
    } catch (error) {
        // A catch that swallows gets a log line, with no exceptions. Nothing in a raw-generation capture pass
        // is worth failing a generation or the panel over.
        console.debug('[cache-lens] index.js runCaptureOnce: unhandled error, pass produced nothing', {
            error: error instanceof Error ? error.message : String(error),
        });

        return { added: 0, saved: false };
    }
}

/**
 * Capture whatever quiet (raw-generation) records the server currently holds for the active chat, merge them
 * into `chatMetadata.cacheLens.rawRequests`, and save — idempotently (DESIGN_RAW_GENERATION_ROWS.md §7.4).
 *
 * Event handlers and panel refreshes call this without awaiting it so capture cannot delay generation. It is
 * exported for callers, including tests, that need to await completion.
 *
 * Captures share one in-flight promise. Any number of triggers during a pass request at most one additional
 * pass, preventing concurrent fetches and an unbounded queue.
 * @returns {Promise<{added: number, saved: boolean}>} The result of whichever pass this call ultimately
 * joins — the last pass to run before the promise settles
 */
export function captureRawRecords() {
    if (activeCapture) {
        captureRerunQueued = true;
        console.debug('[cache-lens] index.js captureRawRecords: capture already in flight, queuing exactly one rerun');

        return activeCapture;
    }

    const loop = (async () => {
        /** @type {{added: number, saved: boolean}} */
        let result = { added: 0, saved: false };

        do {
            captureRerunQueued = false;
            result = await runCaptureOnce();
        } while (captureRerunQueued);

        return result;
    })();

    activeCapture = loop.finally(() => {
        activeCapture = null;
    });

    return activeCapture;
}

/**
 * Build the model behind the panel: one row per listed turn, newest first.
 *
 * Prefer the message stamp, then live timings or server records, then a labeled prefix estimate. Stamps keep
 * rows renderable after reload without live server state.
 * @param {{freshFor?: number}} [options] `freshFor` suppresses the stored stamp for one message id, so a
 * regenerate or a swipe measures itself instead of handing back the measurement it is about to replace
 * @returns {Promise<{rows: Row[], messageRows: MessageRow[], allMessageRows: MessageRow[],
 * userMesIds: Set<number>, mode: Mode, droppedRows: number}>} `rows` is the sorted, ten-row mixed display slice;
 * `messageRows` is its message-only subset. `allMessageRows` contains every valid message row before raw rows
 * use the display budget, so capture is not limited by what the panel renders.
 */
export async function buildRows(options = {}) {
    const context = getContext();
    const chatMessages = Array.isArray(context?.chat) ? context.chat : [];
    const chatId = currentChatId();

    // Panel open/refresh is a capture trigger, but never block row construction on its network request.
    if (options.freshFor === undefined) {
        void captureRawRecords();
    }

    const probe = await probeRecord();
    // Check both modes: server records cover only retained generations, while plugin presence determines
    // whether an unmatched older browser prompt can be trusted.
    const pluginsPresent = await hasServerPlugins();
    const family = backendFamily(main_api);

    // Chat-completion backends: the prefix rule still applies to provider-side caching, but the unit is a
    // message array rather than a string and providers report hits differently. DESIGN.md §12.3 — build for
    // text completion first, and HIDE rather than guess.
    // Read stamp versions separately so an unsupported schema is distinct from an absent stamp.
    /** @type {Map<number, {version: number|null, stamp: import('./persist.js').Stamp|null}>} */
    const stamps = new Map();

    for (let index = 0; index < chatMessages.length; index++) {
        const version = stampVersionOf(chatMessages[index]);

        if (version === null || index === options.freshFor) {
            continue;
        }

        stamps.set(index, { version, stamp: readStamp(chatMessages[index]) });
    }

    const all = Array.isArray(itemizedPrompts) ? itemizedPrompts : [];
    const promptBearing = all
        // Empty prompts have no useful comparison; message arrays are valid prompts too.
        .filter(entry => entry && promptTextOf(entry) !== null && Number.isFinite(Number(entry.mesId)));
    // Quiet generations may be itemized at `mesId = chat.length` without creating a chat message; later, a
    // user's own message can occupy that slot. Exclude user messages even when present, and accept a stamp only
    // when capture previously associated the id with a generated message.
    const usable = promptBearing
        .filter((entry) => {
            const id = Number(entry.mesId);
            const message = chatMessages[id];

            return (Boolean(message) && message.is_user !== true) || stamps.has(id);
        })
        .sort((a, b) => Number(a.mesId) - Number(b.mesId));
    const phantomCount = promptBearing.length - usable.length;

    if (phantomCount > 0) {
        console.debug('[cache-lens] index.js buildRows: itemized entries with no generated chat message skipped (quiet-generation mesId=chat.length, or the reader\'s own message now filling that slot)', { chatId, phantomCount });
    }

    const byMesId = new Map(usable.map(entry => [Number(entry.mesId), entry]));
    // Keep stamped turns whose prompt has aged out of the bounded browser store; the stamp may be the only
    // remaining measurement.
    const rescued = all.filter((entry) => {
        const id = Number(entry.mesId);

        return Number.isFinite(id) && !byMesId.has(id) && stamps.has(id);
    }).length;
    // Count real prompt-bearing turns that are not listed. Entries without a usable prompt are not turns;
    // rescued chat-completion entries and phantom quiet-generation entries are excluded from the count.
    const droppedRows = all.length - usable.length - rescued - phantomCount;

    const ids = [...new Set([...byMesId.keys(), ...stamps.keys()])].sort((a, b) => a - b);
    // One extra beyond the visible rows, because the oldest visible row needs a predecessor to compare with.
    const window = ids.slice(Math.max(0, ids.length - (ROW_COUNT + 1)));
    const turns = window.map((mesId) => {
        const entry = byMesId.get(mesId) ?? null;
        const stamped = stamps.get(mesId) ?? null;
        const rawPrompt = entry ? promptTextOf(entry) : null;

        return {
            mesId,
            rawPrompt,
            messageArray: Array.isArray(entry?.rawPrompt),
            seq: rawPrompt !== null ? (seqByClientHash.get(hashPrompt(rawPrompt)) ?? null) : null,
            itemized: entry,
            stamp: stamped?.stamp ?? null,
            stampVersion: stamped?.version ?? null,
        };
    });

    const records = family ? await fetchRecords(family) : null;
    // Correlate only turns with prompts; stamp-only turns would skew the final one-candidate match.
    const matched = correlate(turns.filter(hasPrompt).reverse(), records, chatId);
    const bySeq = new Map(Array.isArray(records) ? records.map(record => [String(record.seq), record]) : []);

    // DESIGN_RAW_GENERATION_ROWS.md §11.4: whether THIS TAPROOM BUILD exposes raw usage fields at all, judged
    // from the live fetch (`records`) rather than from persisted stamps — a persisted stamp only ever holds
    // 'available' | 'absent' | 'invalid' (buildRawStamp/normalizeRawFields collapse an unrecognized usageState
    // to 'absent'), so the install-level "this build cannot say" signal `usageCountsOf` reports as `'unknown'`
    // would otherwise be lost the moment a stamp is written. Judged over terminal `quiet` records only, since
    // usage is only ever meaningful for those; a chat with no such records yet says nothing either way, and
    // defaults to supported rather than greying a panel that has simply never seen one.
    let rawUsageSupported = true;

    if (Array.isArray(records)) {
        const terminalQuiet = records.filter(record => record?.genType === 'quiet' && isTerminalRecord(record));

        if (terminalQuiet.length > 0 && terminalQuiet.some(record => usageCountsOf(record).usageState === 'unknown')) {
            rawUsageSupported = false;
        }
    }

    console.debug('[cache-lens] index.js buildRows: raw usage support judged from live fetch', {
        chatId, family, recordsSeen: Array.isArray(records) ? records.length : 0, rawUsageSupported,
    });

    /** @type {MessageRow[]} */
    const rows = [];
    // The extra entry at the front is a baseline, not a row — unless it is the first turn of the chat, which
    // has no baseline of its own and renders with NO BAR rather than a zero bar (DESIGN.md §7.2 `empty-prev`).
    const oldestRow = ids.length > ROW_COUNT ? 1 : 0;

    for (let index = window.length - 1; index >= oldestRow; index--) {
        const turn = turns[index];
        const previous = index > 0 ? turns[index - 1] : null;
        const stamp = turn.stamp;
        const record = matched.get(turn.mesId) ?? null;
        const previousRecord = previous ? (matched.get(previous.mesId) ?? null) : null;
        const source = provenanceFor(record, probe.supported, pluginsPresent);
        const promptText = source.text ?? turn.rawPrompt ?? '';
        const promptKnown = promptText.length > 0;

        // The stamp follows the displayed swipe; live RAM may still describe a different, newer swipe.
        const stampTimings = timingsFromStamp(stamp);
        // ⚠️ `getTimings(turn.seq)` AS WELL AS `getTimings(record.seq)`. Both are the value of the same
        // `X-ST-Prompt-Seq` header — `correlate`'s first pass matches turns to records through exactly that
        // equality — so the staged timings are reachable with no record fetched at all. That is what lets
        // `captureMeasurement` stamp a turn before the record route has been asked anything.
        const liveTimings = (record ? getTimings(record.seq) : null) ?? getTimings(turn.seq);
        // Some providers report cache use in `GENERATION_TIMINGS`; chat-completion providers instead expose
        // finalized `usage` on their records. Normalize both forms to the same timing shape.
        const recordTimings = timingsFromRecordUsage(record);

        // What the cache actually held when this prompt arrived.
        const predecessor = record && record.prevSeq !== null && record.prevSeq !== undefined
            ? (bySeq.get(String(record.prevSeq)) ?? null)
            : null;
        // What the previous turn's prompt hashed to, as sent: the record's own hash when it was correlated,
        // and the browser's copy otherwise — which is the same string whenever nothing rewrote it.
        const previousHash = previous
            ? (previousRecord?.hash ?? hashPrompt(previous.rawPrompt))
            : null;
        const eviction = evictionNote(record, predecessor, previousHash);

        let baseline = null;

        if (!promptKnown) {
            // Nothing to compare, and nothing to compare it against. The measurement below is the row.
            baseline = null;
        } else if (predecessor && !eviction.ok && typeof predecessor.text === 'string') {
            // §4.2: the comparison is against the previous request that actually REACHED the backend. When
            // something else got in between, that something else is the baseline — and the row says so.
            baseline = predecessor.text;
        } else if (previous && typeof previous.rawPrompt === 'string') {
            // §4.1: the cache after turn N holds prompt_N *and* the reply it generated, and turn N+1's
            // prompt contains that reply. Comparing against the prompt alone under-reports reuse by the
            // length of every reply, and the error grows with the reply.
            const previousText = (previousRecord && typeof previousRecord.text === 'string')
                ? previousRecord.text
                : previous.rawPrompt;
            const reply = chatMessages[previous.mesId]?.mes;

            if (typeof reply !== 'string') {
                baseline = previousText;
            } else if (turn.messageArray && previousText.endsWith(']')) {
                // ⚠️ A MESSAGE-ARRAY PROMPT DOES NOT GROW BY TEXT APPENDED AFTER ITS `]`. The reply comes back
                // as the next assistant message, `{"role":"assistant","content":…` (`getChat()`'s key order),
                // so that is what the cache's copy is extended with. The closing `}` is left off because
                // `name` or `reasoning` may follow the content, and a guessed byte there would only shorten
                // the prefix this row reports.
                baseline = `${previousText.slice(0, -1)},{"role":"assistant","content":${JSON.stringify(reply)}`;
            } else {
                baseline = previousText + reply;
            }
        }

        // §6.2c: where the server plugins actually wrote, mapped onto the prompt as sent. Observed, never
        // configured — a plugin's settings say where it MEANT to write. The record is server RAM and does
        // not survive the reload, so a stored row falls back to what the stamp kept.
        const rewriteSites = record ? rewriteSitesOf(record) : (stamp?.rewriteSites ?? []);
        const reuse = describeReuse(baseline, promptText);
        const encode = turn.messageArray ? jsonEscaped : verbatim;
        const spans = reuse.hasBaseline && turn.itemized ? locateSections(promptText, sectionsOf(turn.itemized, chatMessages, encode)) : [];
        // Preserve why comparison is unavailable; only `first-turn` means the cache has no predecessor.
        const baselineMissing = reuse.hasBaseline
            ? null
            : (!promptKnown ? 'no-prompt' : (previous === null ? 'first-turn' : 'predecessor-gone'));
        // Greying is a statement about confidence in the PROMPT TEXT. A row with no prompt text is not
        // showing one, so there is nothing to be unsure about — it says what it does have instead.
        const greyed = promptKnown && (source.provenance === PROVENANCE.UNKNOWN || !eviction.ok);
        const rowTimings = stampTimings ?? liveTimings ?? recordTimings;
        // Use the matched record time, then the stamp's request time, then its measurement time. Keep null when
        // none exists; the comparator handles missing time only for ordering, never as a persisted value.
        const requestedAt = Number.isFinite(record?.at)
            ? /** @type {number} */ (record?.at)
            : (Number.isFinite(stamp?.requestAt) ? /** @type {number} */ (stamp?.requestAt) : (Number.isFinite(stamp?.at) ? /** @type {number} */ (stamp?.at) : null));

        rows.push({
            kind: /** @type {'message'} */ ('message'),
            rowKey: `message:${turn.mesId}`,
            requestedAt,
            measurement: measurementFromTimings(rowTimings),
            mesId: turn.mesId,
            // The correlation handle, kept on the row so `captureMeasurement` can write it into the stamp
            // without redoing the matching. `turn.seq` is the header this page watched go past, which is
            // exact; the record's own is the same value arrived at by matching; the stamp's is what a
            // previous page wrote down.
            seq: turn.seq ?? (record ? String(record.seq) : null) ?? stamp?.seq ?? null,
            baselineSeq: record?.prevSeq === null || record?.prevSeq === undefined
                ? (stamp?.baselineSeq ?? null)
                : String(record.prevSeq),
            rewriteSites,
            promptText,
            promptKnown,
            baselineText: baseline,
            hasBaseline: reuse.hasBaseline,
            baselineMissing,
            prefixChars: promptKnown ? reuse.prefixChars : (stamp?.eligibleChars ?? 0),
            promptChars: promptKnown ? reuse.nextChars : (stamp?.promptChars ?? 0),
            charRatio: reuse.ratio,
            maxContext: Number(turn.itemized?.this_max_context) || stamp?.maxContext || 0,
            tokenizer: turn.itemized?.tokenizer || '',
            provenance: source.provenance,
            provenanceLabel: source.label,
            provenanceDetail: source.detail,
            rewrittenBy: source.rewrittenBy?.length > 0 ? source.rewrittenBy : (stamp?.rewrittenBy ?? []),
            evictionNote: eviction.note,
            greyed,
            greyedReason: source.provenance === PROVENANCE.UNKNOWN ? source.label : eviction.note,
            // §14.6: say which of the three sources drew this row, and when it was measured. A stat taken
            // days ago describes the backend as it was configured then.
            recorded: stamp !== null,
            measuredAt: stamp?.at ?? null,
            // `recordTimings` counts as 'live' alongside RAM timings: both describe THIS page's session (the
            // record route was just asked, same as `getTimings` reading this page's RAM), as opposed to
            // `stampTimings`, which is what a previous page measured and saved with the message.
            measurementSource: stampTimings ? 'recorded' : ((liveTimings || recordTimings) ? 'live' : null),
            unreadableStamp: turn.stampVersion !== null && stamp === null ? turn.stampVersion : null,
            attribution: reuse.hasBaseline ? attributeOffset(spans, reuse.prefixChars) : null,
            // A plugin's insertion is not one of the prompt's own sections, so `attributeOffset` would name
            // whatever section it landed in — Chat History, usually — and send a reader to fix the wrong
            // thing. When the change is inside text a plugin wrote, the plugin is the answer.
            rewriteHit: reuse.hasBaseline ? rewriteAt(rewriteSites, reuse.prefixChars) : null,
            rewriteNote: describeRewrites(rewriteSites),
            // Server-plugin records omit browser-side changes. Use the stamp when a predecessor breakdown is
            // unavailable; an empty array is a valid comparison result.
            clientChanges: changedClientComponents(previous?.itemized, turn.itemized) ?? (stamp?.clientChanges ?? []),
            // A component absent from the final prompt may have been removed by the context limiter.
            clientUnplaced: unplacedClientComponents(turn.itemized, promptText, encode),
            timings: rowTimings,
            // Seeded from the stamp so a rehydrated row has its tick and its verdict on the FIRST paint,
            // before the tokenizer has been asked anything; `fillTokenCounts` replaces them for any row
            // whose prompt is still here to count.
            promptTokens: stamp?.promptTokens ?? null,
            prefixTokens: stamp?.eligibleTokens ?? null,
        });
    }

    // DESIGN_RAW_GENERATION_ROWS.md §8: built from persisted stamps only — a raw row is never walked through
    // the message-row window above, and never correlated against `itemizedPrompts` or a fork record, because
    // a `quiet` request has neither a chat message nor a prompt this panel may compare against anything.
    const chatMetadata = context?.chatMetadata ?? null;
    const rawStamps = readRawRequests(chatMetadata);
    const envelopeVersion = rawEnvelopeVersionOf(chatMetadata);
    const rawEnvelopeUnreadable = envelopeVersion !== null && envelopeVersion !== RAW_ENVELOPE_VERSION ? envelopeVersion : null;

    /** @type {RawRow[]} */
    const rawRows = rawStamps.map(rawStamp => ({
        kind: /** @type {'raw'} */ ('raw'),
        rowKey: `raw:${rawStamp.id}`,
        requestedAt: rawStamp.requestedAt,
        seq: rawStamp.seq,
        measurement: measurementFromRawStamp(rawStamp),
        stamp: rawStamp,
    }));

    console.debug('[cache-lens] index.js buildRows: raw rows read from chat metadata', {
        chatId, rawStampCount: rawStamps.length, rawEnvelopeUnreadable,
    });

    // DESIGN_RAW_GENERATION_ROWS.md §8: build ALL valid message and raw rows, sort the combined list, and
    // only THEN apply the ten-row slice — raw rows consume the same render budget as message rows, which is
    // the approved product behavior (§2.2), not an accident to work around.
    /** @type {Row[]} */
    const combined = [.../** @type {Row[]} */ (rows), ...rawRows];

    // Untimed message rows sort no earlier than the newest timed message row. This is only a sort key:
    // `requestedAt` remains null so a borrowed timestamp is never persisted as a real measurement time.
    /** @type {Map<string, number>} */
    const sortAt = new Map();
    let newestBelow = 0;

    // `rows` is newest first, so this walks the chat oldest first.
    for (let index = rows.length - 1; index >= 0; index--) {
        newestBelow = Math.max(newestBelow, rows[index].requestedAt ?? 0);
        sortAt.set(rows[index].rowKey, newestBelow);
    }

    combined.sort((a, b) => {
        // 🔴 TWO MESSAGE ROWS ARE ORDERED BY THE CHAT, FIRST AND ONLY. Their `sortAt` never decreases with
        // `mesId`, so this is the order steps 1–3 would reach anyway — except when two turns carry times from
        // different clocks (a record's server `at`, a stamp's client `at`) or seqs from either side of a server
        // restart, and then steps 1 or 2 could put an older turn above a newer one.
        if (a.kind === 'message' && b.kind === 'message' && a.mesId !== b.mesId) {
            return b.mesId - a.mesId;
        }

        // 1. `requestedAt` descending — newest first. A message row's key is `sortAt` above; a missing one is
        // treated as `0` HERE AND ONLY HERE, for ordering purposes only; it is never written back as a value
        // anywhere.
        const atA = (a.kind === 'message' ? sortAt.get(a.rowKey) : a.requestedAt) ?? 0;
        const atB = (b.kind === 'message' ? sortAt.get(b.rowKey) : b.requestedAt) ?? 0;

        if (atB !== atA) {
            return atB - atA;
        }

        // 2. Numeric `seq` descending, when both sides carry one that parses as a number. `seq` is a
        // correlation handle from a single backend's monotonic counter, so this only ever discriminates two
        // rows that are already from the same backend stream — there is no independent "backend" field to
        // compare it against on a message row, and none is needed: two rows sharing a timestamp AND a seq
        // space are, by construction, from the same stream.
        const seqA = a.seq === null || a.seq === undefined ? NaN : Number(a.seq);
        const seqB = b.seq === null || b.seq === undefined ? NaN : Number(b.seq);

        if (Number.isFinite(seqA) && Number.isFinite(seqB) && seqA !== seqB) {
            return seqB - seqA;
        }

        // Preserve numeric message order when two message rows tie on time and sequence. A raw row has no
        // `mesId`, so it skips this comparison and uses the raw-row tie-break below.

        // 4. `rowKey` ordinal, as a deterministic final tie-breaker (§8) — reached when a raw row is involved,
        // or (defensively) when two message rows somehow share a `mesId`.
        if (a.rowKey === b.rowKey) {
            return 0;
        }

        return a.rowKey < b.rowKey ? 1 : -1;
    });

    const listed = combined.slice(0, ROW_COUNT);
    // Message-gap calculation receives MESSAGE ROWS ONLY (§8) — `userMessageIds` reads `mesId`, which a raw
    // row does not have.
    const messageRows = /** @type {MessageRow[]} */ (listed.filter(row => row.kind === 'message'));
    const rawRowCount = listed.length - messageRows.length;

    console.debug('[cache-lens] index.js buildRows: listed rows assembled', {
        chatId, messageRowCount: messageRows.length, rawRowCount, droppedRows,
    });

    return {
        rows: listed,
        messageRows,
        // `allMessageRows` contains the complete message-only window before raw rows compete for the render
        // budget. Measurement capture searches this list, so the render slice cannot hide a new measurement.
        allMessageRows: rows,
        userMesIds: userMessageIds(chatMessages, messageRows),
        mode: {
            recordSupported: probe.supported,
            depth: probe.depth,
            pluginsPresent,
            backend: family,
            recordsSeen: Array.isArray(records) ? records.length : 0,
            rawUsageSupported,
            rawEnvelopeUnreadable,
            rawRows: rawRowCount,
        },
        droppedRows,
    };
}

/**
 * Fill in the token numbers for rows already on screen.
 *
 * Called after render, never on the generation path. Character counts render immediately; token counts fill in
 * when available. The mixed rows include raw rows, so check `kind` before reading message-only fields.
 * @param {Row[]} rows Rows from `buildRows`
 * @param {string|null} chatId The chat, for the memo key
 * @returns {Promise<Row[]>} The same rows, with token counts filled in where the tokenizer answered
 */
export async function fillTokenCounts(rows, chatId) {
    await Promise.all(rows.map(async (row) => {
        // Raw rows have no prompt or message fields to tokenize.
        if (row.kind !== 'message') {
            return;
        }

        // Do not replace a persisted count with zero when the source prompt is unavailable.
        if (!row.promptKnown) {
            return;
        }

        const key = `${chatId}:${row.mesId}`;

        row.promptTokens = await countTokens(`${key}:all:${row.promptChars}`, row.promptText);

        if (row.hasBaseline) {
            row.prefixTokens = await countTokens(`${key}:pre:${row.prefixChars}`, row.promptText.slice(0, row.prefixChars));
        }
    }));

    return rows;
}

/**
 * Write this turn's measurement into the message, so it outlives the page that took it.
 *
 * Run after the message exists so its stamp can be attached by message id. The event handler does not await
 * this fetch-and-tokenize work, which would otherwise delay the reply; this function saves the chat itself.
 * @param {number} mesId The message the generation produced
 * @returns {Promise<boolean>} Whether a stamp was written
 */
export async function captureMeasurement(mesId) {
    if (!Number.isFinite(mesId)) {
        return false;
    }

    try {
        const context = getContext();
        const message = context?.chat?.[mesId];

        if (!message || typeof message !== 'object') {
            return false;
        }

        const chatId = currentChatId();
        // Ignore the old stamp for this message and search all message rows; raw/display slicing must not
        // hide a regenerated message from capture.
        const { allMessageRows } = await buildRows({ freshFor: mesId });
        const row = allMessageRows.find(candidate => candidate.mesId === mesId) ?? null;

        if (!row) {
            // §14.5: a generation with no visible message — summarisation, vectors, impersonate, a quiet
            // prompt — has nothing to attach to and is not a row either. A missing stamp is not an error.
            //
            // No row exists in the complete message-only window for this id; raw-row slicing cannot cause this
            // case because the search above uses the unsliced messages.
            console.debug('[cache-lens] index.js captureMeasurement: no row for this message id — §14.5, nothing was ever built for it (no stamp, no itemized prompt)', { chatId, mesId });

            return false;
        }

        await fillTokenCounts([row], chatId);

        const stamp = buildStamp({
            seq: row.seq,
            at: Date.now(),
            maxContext: row.maxContext,
            promptChars: row.promptChars,
            eligibleChars: row.prefixChars,
            eligibleTokens: row.prefixTokens,
            promptTokens: row.promptTokens,
            actualTokens: row.timings?.cache_n,
            processedTokens: row.timings?.prompt_n,
            promptMs: row.timings?.prompt_ms,
            divergedAt: row.hasBaseline ? row.prefixChars : null,
            baselineSeq: row.baselineSeq ?? null,
            rewrittenBy: row.rewrittenBy,
            rewriteSites: row.rewriteSites,
            clientChanges: row.clientChanges,
            // Persist the timestamp resolved by `buildRows`. Keep null when no source timestamp exists so a
            // fabricated zero cannot outrank the stamp's actual measurement time on later reads.
            requestAt: row.requestedAt,
        });

        if (!stamp) {
            return false;
        }

        // Recheck object and chat identity after the fetch before writing to the message index.
        if (getContext()?.chat?.[mesId] !== message || currentChatId() !== chatId) {
            return false;
        }

        message.extra = message.extra || {};
        message.extra.cacheLens = stamp;

        // Keep the stamp in the active swipe too; streaming and non-streaming paths copy message extras at
        // different times, and either may copy before this asynchronous write.
        syncMesToSwipe(mesId);

        // The core's message save may already have completed while this asynchronous capture ran.
        await context.saveChat?.();

        return true;
    } catch {
        // Persistence is best-effort; a failed stamp must not fail generation.
        return false;
    }
}

/**
 * Wire the extension up. Called by the manifest's `activate` hook.
 * @returns {void}
 */
export function init() {
    installSeqCapture();

    // Display backend-reported reuse separately from the prefix estimate; their difference is meaningful.
    if (event_types.GENERATION_TIMINGS) {
        eventSource.on(event_types.GENERATION_TIMINGS, (payload) => {
            const event = /** @type {TimingsEvent|null|undefined} */ (payload);

            noteTimings(event?.seq ?? null, event?.raw ?? null);
            refreshPanel();
        });
    }

    // This also captures quiet generations that produce no chat message. Guard the optional event for older hosts.
    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            void captureRawRecords();
        });
    }

    // The message now exists, so capture asynchronously and do not delay the core's awaited event handler.
    eventSource.on(event_types.MESSAGE_RECEIVED, (mesId) => {
        void captureMeasurement(Number(mesId)).then(() => refreshPanel());
        // Quote-and-Send recovery trigger; merging twice is idempotent, and capture must not delay the reply.
        void captureRawRecords();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // The host emits CHAT_CHANGED after loading the new chat, so context identifies the new conversation.
        void captureRawRecords();
        refreshPanel();
    });

    const button = document.createElement('div');

    button.id = 'cache_lens_button';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.title = 'How much of each turn could the backend reuse from its KV cache?';
    button.append(Object.assign(document.createElement('div'), { className: 'fa-solid fa-layer-group extensionsMenuExtensionButton' }));
    button.append(document.createTextNode('Cache Lens'));
    button.addEventListener('click', () => void openPanel());

    document.getElementById('extensionsMenu')?.append(button);
}

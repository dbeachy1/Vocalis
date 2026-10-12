/**
 * WHY A TURN WENT COLD — the shape of the change between two successive prompts, in numbers only.
 *
 * A KV cache is a prefix. When the browser assembles turn N+1 it usually appends at the bottom and evicts a
 * little from the top, and llama.cpp's `--cache-reuse` slides the surviving middle into its new position
 * rather than recomputing it. That slide is ONE-DIRECTIONAL, and the asymmetry is the whole subject of this
 * module: in the server's reuse loop only the CACHE pointer advances on a mismatch, so cached content can be
 * moved to an EARLIER position and never a later one. Deleting text above the history is absorbed; inserting
 * text above the history cannot be, and every token below it is reprocessed.
 *
 * Measured on this install:
 *
 *     ~300 tokens deleted above the history   -> 100.0 % cached, 0.14 s
 *     ~300 tokens inserted above the history  ->   0.1 % cached, 15.3 s   (identical with the flag OFF)
 *     ~300 tokens inserted below everything   ->  97.1 % cached,  1.3 s
 *
 * So "the turn was cold" is not a mystery to be reasoned about from timings. It is a question about the two
 * strings, it has one right answer, and this computes it.
 *
 * 🔴 NUMBERS ONLY. NOTHING FROM EITHER PROMPT IS RETURNED OR LOGGED — no text, no excerpt, no hash of a
 * fragment, no first-differing character. What leaves here is offsets, lengths, deltas and a verdict from a
 * fixed vocabulary, which is why the caller may log it as `LogClass.NORMAL` on an install with `debugMode`
 * off. That property is not incidental to the design; it is the reason the module can exist at all, because
 * the alternative — diagnosing this from the prompts themselves — means reading the conversation.
 *
 * ⚠️ THIS LOCATES AND CLASSIFIES THE DIVERGENCE. IT DOES NOT PREDICT THE BACKEND'S CACHED-TOKEN COUNT.
 * The real loop runs over TOKENS with `n_cache_reuse = 256`; this runs over lines, because tokenising a
 * 200 KB prompt on the server for a diagnostic would cost more than the generation it is diagnosing. Lines
 * are the right proxy for *where* and *which direction* — they are wrong for *how many*. When an exact
 * cached-token prediction is wanted, `temp/kvtest/reuse-sim.mjs` replays the token-level loop offline and
 * has matched the backend's own count exactly on every turn it was tested against.
 */

/**
 * Smallest run that the reuse loop will accept as a chunk, in characters.
 *
 * llama.cpp's default is 256 TOKENS and this file works in characters, so 1024 is that at the ~4 chars/token
 * this workload actually runs at. It does not need to be exact: its only job is to stop a coincidental
 * one-line match — a bare separator, a repeated name — from being mistaken for the history re-converging.
 */
const MIN_CHUNK_CHARS = 1024;

/**
 * Shortest run that may be used to claim content was displaced rather than deleted.
 *
 * Below this a match is as likely to be a coincidence as a fact — prompts repeat separators, speaker names
 * and stock phrasing constantly — and the cost of a false positive here is a turn reported COLD that was
 * not, which is the failure mode this whole module exists to avoid producing.
 */
const MIN_PROBE_CHARS = 256;

/**
 * Ceiling on line comparisons, so a pathological prompt cannot make a diagnostic cost more than the thing it
 * is diagnosing. A 200 KB prompt is ~2,000 lines and the loop is near-linear on real input; this is a
 * backstop, and reaching it produces an honest `UNDETERMINED` rather than a wrong verdict.
 */
const MAX_COMPARISONS = 5_000_000;

/**
 * What happened between the two prompts.
 *
 * ⚠️ `INSERTION_ABOVE` IS THE ONLY EXPENSIVE ONE, and it is expensive no matter which backend is running or
 * how it is configured. The others are all absorbed by a correctly configured llama-server.
 */
export const Verdict = Object.freeze({
    /** The prompts are the same string. A re-send, or a swipe that rebuilt an identical prompt. */
    IDENTICAL: 'IDENTICAL',
    /** The previous prompt is a prefix of this one. Nothing moved; the cache is reused whole. */
    APPEND_ONLY: 'APPEND_ONLY',
    /** Text vanished above surviving content, which slid EARLIER. `--cache-reuse` absorbs this. */
    DELETION_ABOVE: 'DELETION_ABOVE',
    /** Text appeared above surviving content, which must slide LATER. Nothing can absorb this. */
    INSERTION_ABOVE: 'INSERTION_ABOVE',
    /**
     * The prompts share a prefix and then simply differ to the end — the last message was rewritten,
     * extended or swiped. Nothing was displaced, so there was nothing for the reuse loop to recover, and
     * the cost is only the changed tail.
     *
     * 🔴 THIS IS NOT `INSERTION_ABOVE`, AND CONFLATING THEM WAS A REAL BUG. Both leave the loop having
     * recovered nothing beyond the common prefix, so a classifier that reads only that number calls a
     * 99.1%-reused tail edit a cold turn. `tests/frontend/cold-turn-reproduction.e2e.js` caught it by
     * driving real generations: every one of six turns was reported cold, including turns that reused
     * 7,991 of 8,062 characters. A diagnostic in that state does not merely add noise — it sends whoever
     * is chasing a slow turn to a part of the prompt that never moved.
     */
    TAIL_CHANGE: 'TAIL_CHANGE',
    /** The loop hit its comparison ceiling. Says nothing either way, and must not be read as a verdict. */
    UNDETERMINED: 'UNDETERMINED',
});

/**
 * Length of the common prefix of two line arrays.
 * @param {string[]} a Lines
 * @param {string[]} b Lines
 * @returns {number} Count of leading lines that match
 */
function commonPrefixLines(a, b) {
    const limit = Math.min(a.length, b.length);
    let n = 0;

    while (n < limit && a[n] === b[n]) {
        n += 1;
    }

    return n;
}

/**
 * Characters in a slice of lines, counting the newlines that `split` removed.
 * @param {string[]} lines Lines
 * @param {number} from First index
 * @param {number} to One past the last index
 * @returns {number} Character count
 */
function charsIn(lines, from, to) {
    let total = 0;

    for (let i = from; i < to; i++) {
        total += lines[i].length + 1;
    }

    return total;
}

/**
 * Replay llama.cpp's cache-reuse loop over lines and report what it found.
 *
 * The loop, in the shape the server runs it (`server-context.cpp`, build b10625):
 *
 *     head_c = head_p = <plain common prefix>
 *     while both in range:
 *         n_match = run length where cache[head_c + i] == prompt[head_p + i]
 *         if n_match is big enough:  reuse that chunk; head_c += n; head_p += n
 *         else:                      head_c += 1        <-- ONLY the cache pointer
 *
 * That `else` is the asymmetry. `head_p` never advances on a mismatch, so `head_c - head_p` only grows: the
 * cache can be told a chunk now lives EARLIER, never later. A deletion is expressible; an insertion is not.
 * @param {string[]} cache Lines of the previous prompt — what the backend is holding
 * @param {string[]} next Lines of the prompt about to be sent
 * @returns {{reusedChars: number, stalledAtLine: number, exhausted: boolean}} What the loop kept, and the
 * line in the NEW prompt where it could go no further
 */
function replayReuseLoop(cache, next) {
    const prefix = commonPrefixLines(cache, next);
    let headC = prefix;
    let headP = prefix;
    let reusedChars = charsIn(next, 0, prefix);
    let comparisons = prefix;

    while (headC < cache.length && headP < next.length) {
        let match = 0;
        let matchChars = 0;

        while (headC + match < cache.length && headP + match < next.length && cache[headC + match] === next[headP + match]) {
            matchChars += next[headP + match].length + 1;
            match += 1;
            comparisons += 1;
        }

        comparisons += 1;

        if (comparisons > MAX_COMPARISONS) {
            return { reusedChars, stalledAtLine: headP, exhausted: true };
        }

        if (matchChars >= MIN_CHUNK_CHARS) {
            reusedChars += matchChars;
            headC += match;
            headP += match;
        } else {
            // 🔴 THE CACHE POINTER, AND ONLY THE CACHE POINTER. Advancing `headP` here would model a
            // backend that can absorb an insertion, which is exactly the thing this file exists to say
            // llama.cpp cannot do. The bug would be invisible: every cold turn would be reported warm.
            headC += 1;
        }
    }

    return { reusedChars, stalledAtLine: headP, exhausted: false };
}

/**
 * @typedef {object} PromptGeometry
 * @property {string} verdict One of {@link Verdict}.
 * @property {number} length Characters in the new prompt.
 * @property {number} prevLength Characters in the prompt the backend is holding.
 * @property {number} commonPrefix Characters shared before the first difference. Reused by ANY backend, with
 * or without cache reuse, and the floor on what a cold turn keeps.
 * @property {number} reusable Characters the reuse loop would keep, common prefix included.
 * @property {number} atChar Where the first difference is, in the new prompt.
 * @property {number} stalledAtChar Where the reuse loop could go no further, in the new prompt. On a cold
 * turn this is the insertion point — the thing worth naming a cause for.
 * @property {number} delta Change in total length.
 */

/**
 * Did the cached content just after the divergence move DOWN the new prompt, rather than vanish?
 *
 * This is the question that separates the expensive case from the cheap one when the reuse loop recovered
 * nothing. An insertion pushes everything below it later, so the bytes the backend holds after the
 * divergence still exist — further on. A rewritten tail simply does not contain them.
 *
 * ⚠️ SEARCHED FROM THE DIVERGENCE, NOT FROM ZERO. A probe found somewhere ABOVE the divergence would be a
 * coincidental repeat — a separator, a speaker name — and would turn every turn into an insertion.
 * @param {string} previousText What the backend holds
 * @param {string} currentText What is about to be sent
 * @param {number} commonPrefix Where the two first differ
 * @returns {boolean} True when displaced content was found later in the new prompt
 */
function displacedForward(previousText, currentText, commonPrefix) {
    const probe = previousText.slice(commonPrefix, commonPrefix + MIN_CHUNK_CHARS);

    // Too little left to be sure of anything. A short run matches by accident, and claiming an insertion on
    // one would be exactly the false positive this function exists to remove.
    if (probe.length < MIN_PROBE_CHARS) {
        return false;
    }

    return currentText.indexOf(probe, commonPrefix) > commonPrefix;
}

/**
 * Compare the prompt about to be sent against the one the backend is already holding.
 * @param {string} previousText The previous outgoing prompt
 * @param {string} currentText The prompt about to be sent
 * @returns {PromptGeometry} The shape of the change, in numbers
 */
/**
 * The first character at which two strings differ, searched forward from a known-common prefix.
 *
 * The reuse replay works in lines because tokenising a 200 KB prompt for a diagnostic would cost more than
 * the generation it is diagnosing. That makes every offset it produces land on a line boundary, which is
 * fine for arithmetic and wrong for naming a place: a prompt part can begin mid-line, and then the offset
 * points at the part before the one that changed.
 * @param {string} a One string
 * @param {string} b The other
 * @param {number} from A position both are known to agree up to
 * @returns {number} The first differing index
 */
function firstDifferingChar(a, b, from) {
    const shared = Math.min(a.length, b.length);
    let at = Math.max(0, Math.min(from, shared));

    while (at < shared && a[at] === b[at]) {
        at += 1;
    }

    return at;
}

export function analyzeGeometry(previousText, currentText) {
    const length = currentText.length;
    const prevLength = previousText.length;
    const delta = length - prevLength;

    if (previousText === currentText) {
        return { verdict: Verdict.IDENTICAL, length, prevLength, commonPrefix: length, reusable: length, atChar: length, stalledAtChar: length, delta };
    }

    const cache = previousText.split('\n');
    const next = currentText.split('\n');

    const prefixLines = commonPrefixLines(cache, next);
    const commonPrefix = Math.min(charsIn(next, 0, prefixLines), length);

    // 🔴 THE EXACT CHARACTER, BECAUSE THE LINE-GRANULAR ONE NAMES THE WRONG PART OF THE PROMPT.
    // `commonPrefix` is where the first differing LINE begins, which is the right unit for the reuse
    // arithmetic below — the replay works in lines, as `replayReuseLoop` documents. It is the wrong unit
    // for `locateRegion`, which maps an offset onto the browser's part boundaries: a line that straddles a
    // seam is reported against the part it STARTS in, not the part that actually changed.
    //
    // ⚠️ REPORTING ONLY. `commonPrefix` is unchanged and every reuse figure still derives from it, so the
    // percentages that match the backend to within two points are untouched.
    const atChar = firstDifferingChar(previousText, currentText, commonPrefix);

    if (prefixLines === cache.length) {
        // Everything the backend holds is still a leading prefix of what we are about to send. This is the
        // shape a `/continue` produces, and the cheapest turn there is.
        return { verdict: Verdict.APPEND_ONLY, length, prevLength, commonPrefix, reusable: commonPrefix, atChar, stalledAtChar: length, delta };
    }

    const { reusedChars, stalledAtLine, exhausted } = replayReuseLoop(cache, next);
    const stalledAtChar = Math.min(charsIn(next, 0, stalledAtLine), length);

    if (exhausted) {
        return { verdict: Verdict.UNDETERMINED, length, prevLength, commonPrefix, reusable: reusedChars, atChar, stalledAtChar, delta };
    }

    // The loop reconverged and carried the rest across: whatever changed at `atChar` was a deletion, and the
    // surviving content moved earlier.
    if (reusedChars > commonPrefix) {
        return { verdict: Verdict.DELETION_ABOVE, length, prevLength, commonPrefix, reusable: reusedChars, atChar, stalledAtChar, delta };
    }

    // It recovered nothing, and that has two completely different causes. Either the cached content after
    // the divergence still exists but now sits LATER — an insertion, the shift the loop cannot express — or
    // it is simply gone, because the tail was rewritten and there was never anything to shift. Asking the
    // strings settles it: does what the backend holds after the divergence appear again further down?
    const verdict = displacedForward(previousText, currentText, commonPrefix) ? Verdict.INSERTION_ABOVE : Verdict.TAIL_CHANGE;

    return {
        verdict,
        length,
        prevLength,
        commonPrefix,
        reusable: reusedChars,
        atChar,
        stalledAtChar,
        delta,
    };
}

/**
 * The four top-level parts, in the order the browser joins them (`getCombinedPrompt`).
 *
 * Their running total gives the seams, which is how a character offset becomes the name of a region. Every
 * other field in the shape lives INSIDE one of these and is reported by size change alone.
 */
const LAYOUT = Object.freeze(['story', 'ex', 'hist', 'cont']);

/** Human names for the regions, so a log line reads as a place and not as a field abbreviation. */
const REGION_NAMES = Object.freeze({
    story: 'story string (system prompt, card, persona, World Info)',
    ex: 'example messages',
    hist: 'chat history',
    cont: 'continue tail',
});

/**
 * Read the `X-ST-Prompt-Shape` header.
 *
 * Deliberately generic — `name=number` pairs, no field list. A parser holding its own copy of the writer's
 * fields is a parser that silently drops the next field somebody adds; here an unknown name reports itself.
 * @param {string} [value] The header value
 * @returns {Map<string, number>|null} Field sizes, or null when absent or unreadable
 */
export function parsePromptShape(value) {
    if (typeof value !== 'string' || !value.startsWith('v1;')) {
        return null;
    }

    const fields = new Map();

    for (const pair of value.slice(3).split(';')) {
        const at = pair.indexOf('=');

        if (at <= 0) {
            continue;
        }

        const name = pair.slice(0, at);
        const size = Number(pair.slice(at + 1));

        // 🔴 FINITE, NON-NEGATIVE NUMBERS ONLY. This value arrives in a request header, so it is input: a
        // NaN would propagate into every offset computed from it and print a log line of `NaN` that reads
        // like a bug in the analysis rather than a bad header.
        if (Number.isFinite(size) && size >= 0 && /^[a-z]{1,12}$/.test(name)) {
            fields.set(name, Math.trunc(size));
        }
    }

    return fields.size ? fields : null;
}

/**
 * Which top-level region a character offset falls in.
 *
 * ⚠️ THE SHAPE DESCRIBES WHAT THE BROWSER BUILT, AND A SERVER PLUGIN MAY HAVE REWRITTEN THE PROMPT SINCE.
 * `rewriteSites` on the record says where that happened, so a caller with a rewrite above the offset should
 * treat this as approximate. Naming the region is still worth more than not naming it: the regions are tens
 * of thousands of characters wide and a plugin's insertion is hundreds.
 * @param {Map<string, number>|null} shape Field sizes for this turn
 * @param {number} atChar Offset in the prompt
 * @returns {string} The region name, or 'unknown' when there is no shape to place it in
 */
/**
 * The absolute bounds of every top-level part, as one line.
 *
 * 🔴 WITHOUT THIS AN OFFSET CANNOT BE PLACED, AND THE `parts:` LINE CANNOT SUPPLY IT. That line reports
 * fields whose SIZE changed, so a part that is constant in length is simply absent from it — and a part
 * that changed CONTENT without changing length is absent while being the entire cause. On 2026-08-27 that
 * combination produced an unresolvable reading: `story` and `ex` both absent, and a divergence the region
 * mapper placed inside `ex`, which is only possible if one of them changed underneath a constant length.
 * Printing the bounds every turn makes the arithmetic checkable from the log instead of inferrable.
 * @param {Map<string, number>|null} shape The parsed shape header
 * @returns {string} The bounds, or a note when there is no shape
 */
export function describeLayout(shape) {
    if (!shape) {
        return 'no shape to place offsets against';
    }

    const spans = [];
    let start = 0;

    for (const part of LAYOUT) {
        const size = shape.get(part) ?? 0;
        spans.push(`${part} ${start}..${start + size}`);
        start += size;
    }

    return spans.join(', ');
}

/**
 * Which parts changed CONTENT, as against which changed SIZE.
 *
 * 🔴 THIS IS THE QUESTION `describeShapeChange` STRUCTURALLY CANNOT ANSWER, AND IT IS THE ONE THAT WAS
 * NEEDED. That line reports fields whose value moved, so a part which is byte-different at a constant
 * length is ABSENT FROM IT while being the entire cause. On 2026-08-27 three consecutive turns on the live
 * install produced exactly that: `story` and `ex` both missing from `parts:` — therefore unchanged in size
 * — while the divergence was placed inside `ex`, which requires `story + ex` to exceed the offset. Both
 * cannot hold unless something above the chat history mutated without resizing. There was no way to find
 * out which part, because nothing compared the parts themselves.
 *
 * So this slices both prompts by their own shapes and compares. `story CHANGED at 8807 of 9929 (SAME
 * LENGTH)` names the culprit outright and ends a class of investigation that otherwise runs on inference.
 *
 * 🔴 STILL NUMBERS AND FIXED KEYWORDS ONLY. Offsets, sizes, deltas, and the words IDENTICAL / CHANGED /
 * SAME LENGTH. No excerpt, no first differing character, and no hash of a fragment — `prompt-record.js`
 * states the contract and `prompt-cache-geometry-wire.test.js` enforces it by reading `st.log` back.
 *
 * ⚠️ OFFSETS CAN DRIFT BY THE NUMBER OF CARRIAGE RETURNS, AND THE LINE SAYS SO WHEN THEY DO. The shape is
 * measured on the browser's parts before `getCombinedPrompt` strips `\r` from the joined result, so the
 * boundaries here are exact only when the prompt held none. Rather than pretend, the totals are compared
 * and any mismatch is reported — an approximate boundary still identifies the part, which is the whole job.
 * @param {string} previousText The prompt the backend is holding
 * @param {Map<string, number>|null} previousShape Its shape
 * @param {string} text The prompt about to be sent
 * @param {Map<string, number>|null} shape Its shape
 * @returns {string} One readable line
 */
export function describePartDiff(previousText, previousShape, text, shape) {
    if (!previousShape || !shape) {
        return 'no shape on one side, so parts cannot be compared';
    }

    const parts = [];
    let previousStart = 0;
    let start = 0;

    for (const part of LAYOUT) {
        const previousSize = previousShape.get(part) ?? 0;
        const size = shape.get(part) ?? 0;
        const before = previousText.slice(previousStart, previousStart + previousSize);
        const after = text.slice(start, start + size);

        if (before === after) {
            parts.push(`${part} IDENTICAL`);
        } else {
            let at = 0;
            const shared = Math.min(before.length, after.length);

            while (at < shared && before[at] === after[at]) {
                at += 1;
            }

            const delta = size - previousSize;
            // SAME LENGTH is called out in words because it is the diagnosis, not a detail: a part that
            // changed content without changing size is invisible to every other line in this diagnostic.
            const sizeNote = delta === 0 ? 'SAME LENGTH' : `${delta > 0 ? '+' : ''}${delta}`;

            parts.push(`${part} CHANGED at ${at} of ${size} (${sizeNote})`);
        }

        previousStart += previousSize;
        start += size;
    }

    const drift = text.length - start;

    if (drift !== 0) {
        parts.push(`offsets approximate: parts total ${start}, prompt is ${text.length} (${drift > 0 ? '+' : ''}${drift})`);
    }

    return parts.join(', ');
}

export function locateRegion(shape, atChar) {
    if (!shape) {
        return 'unknown';
    }

    let start = 0;

    for (const part of LAYOUT) {
        const size = shape.get(part) ?? 0;

        if (atChar < start + size) {
            return REGION_NAMES[part];
        }

        start += size;
    }

    return 'past the assembled parts';
}

/**
 * Which parts changed size since the previous turn, largest change first.
 *
 * This is the half of the diagnosis that survives everything: it needs no offsets, no assumption about what
 * a plugin did, and no arithmetic that can drift. On a cold turn it usually names the cause outright.
 * @param {Map<string, number>|null} previousShape Last turn's field sizes
 * @param {Map<string, number>|null} shape This turn's field sizes
 * @returns {string} A readable list, or a note when there is nothing to compare
 */
export function describeShapeChange(previousShape, shape) {
    if (!shape || !previousShape) {
        return 'no shape to compare (client sent none, or this is the first turn)';
    }

    const changes = [];

    for (const [name, size] of shape) {
        const before = previousShape.get(name) ?? 0;

        if (size !== before) {
            changes.push({ name, before, size, magnitude: Math.abs(size - before) });
        }
    }

    if (!changes.length) {
        return 'every part the same size as last turn';
    }

    changes.sort((a, b) => b.magnitude - a.magnitude);

    return changes
        .map(({ name, before, size }) => `${name} ${before}->${size} (${size - before >= 0 ? '+' : ''}${size - before})`)
        .join(', ');
}

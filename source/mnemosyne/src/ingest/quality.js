import { INGEST_DEFAULTS } from '../config.js';

/**
 * The cheap gates a candidate memory passes before anything expensive happens to it (§5.3 tiers 1–2).
 *
 * Pure functions over a string: long enough, clipped to the size limit rather than rejected over it, and —
 * separately — whether it carries the state-change phrasing that turns a near-duplicate into a supersession
 * rather than a drop. Nothing here embeds, stores, or logs.
 *
 * ⚠️ The state-change regex is FIRST CUT and English-only. `hasStateChangeMarker` in particular decides whether a
 * similar memory REPLACES an existing one or sits beside it, so widening the list changes what gets retired.
 */

/**
 * State-change phrasing that turns a near-duplicate into a supersession (Smart-Memory's marker list, §5.3).
 *
 * 🔴 EVERY ENTRY MUST BE A PHRASE THAT ONLY EVER MEANS "THIS CHANGED". The list used to carry the bare words
 * `now`, `left`, `changed` and `stopped`, and each of them is a common word in ordinary description rather than
 * a claim of change: *"a burn scar on her **left** forearm"*, *"**now** that I think of it"*, *"she **changed**
 * clothes"*. A marker is not a hint here — it is what decides whether a similar memory RETIRES an existing one,
 * so a word that fires on prose is a word that deletes true memories. `left` was the worst of them: it matched
 * every mention of a left hand, side or turn, and the extraction prompt actively asks the model for
 * change-flavored phrasing, so markers are the common case rather than the rare one.
 *
 * Keep the phrase forms (`has left`, `is now`, `has changed`) — they carry the tense that makes the claim.
 */
const STATE_CHANGE_RE = /\b(no longer|not any ?more|is now|are now|became|has become|have become|has changed|have changed|has stopped|have stopped|has left|have left|moved to|moved out|was killed|died|is dead|broke up|reconciled|used to|formerly)\b/i;

// 🔴 THERE USED TO BE A HEDGE FILTER HERE, AND IT DELETED MEMORIES FOR CONTAINING A WORD.
//
// `HEDGE_RE` rejected any statement containing `maybe|might|seems|perhaps|likely|…` anywhere in it — so
// A hedge-word filter discarded any statement containing a qualifying word, even when it expressed useful
// uncertainty. It could permanently lose a memory while advancing the high-water mark, so it was removed.

/**
 * Does a statement carry explicit state-change phrasing? Such a statement, when similar to an existing memory,
 * is treated as an update to it rather than a duplicate of it.
 *
 * @param {string} statement
 * @returns {boolean}
 */
export function hasStateChangeMarker(statement) {
    return STATE_CHANGE_RE.test(statement);
}

/**
 * The quality gate (§5.3 tier 2): long enough to say something. That is all it rejects now.
 *
 * 🔴 **THE UPPER BOUND IS NOT A REJECTION ANY MORE — see {@link fitLength}.** This used to return false above
 * `maxLength`, and the tooltip said so in as many words: *"A memory longer than this is discarded entirely,
 * and that loss is permanent."* A memory the model wrote too richly was thrown away whole for being too good,
 * with the mark advancing past it. Over-length statements are now CLIPPED to the limit and stored, so the user
 * can see and edit them; nothing is discarded for its length.
 *
 * @param {string} statement
 * @param {{ minLength?: number }} [limits]
 * @returns {boolean}
 */
export function passesQuality(statement, { minLength = INGEST_DEFAULTS.minLength } = {}) {
    return statement.trim().length >= minLength;
}

/**
 * Bring a statement within `maxLength` by clipping it, never by discarding it.
 *
 * Cuts at the last sentence end that keeps at least half the limit, so a clipped memory still reads as whole
 * sentences. With no such boundary it cuts at the last space and marks the cut with `…`, so the panel shows
 * plainly that the memory was shortened. The result is always ≤ `maxLength`.
 *
 * @param {string} statement
 * @param {{ maxLength?: number }} [limits]
 * @returns {{ text: string, clipped: boolean }}
 */
export function fitLength(statement, { maxLength = INGEST_DEFAULTS.maxLength } = {}) {
    const s = statement.trim();
    if (s.length <= maxLength) {
        return { text: s, clipped: false };
    }
    return { text: clipToLimit(s, maxLength), clipped: true };
}

/**
 * The clipping itself, shared with the parser's guillotined-last-line repair.
 *
 * @param {string} s Trimmed text longer than `limit`, or a line cut off mid-sentence (`limit` = its length)
 * @param {number} limit
 * @returns {string}
 */
export function clipToLimit(s, limit) {
    const head = s.slice(0, limit);
    // The last sentence end inside the limit: terminal punctuation, optionally a closing quote, then a space
    // or the end of the slice.
    let cut = -1;
    for (const m of head.matchAll(/[.!?]["'’”)]?(?=\s|$)/g)) {
        cut = (m.index ?? 0) + m[0].length;
    }
    if (cut >= limit / 2) {
        return head.slice(0, cut).trim();
    }
    // No usable sentence boundary: cut at a word and say so with an ellipsis (one character, inside the limit).
    const room = head.slice(0, limit - 1);
    const space = room.lastIndexOf(' ');
    return `${(space > limit / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

/**
 * Normalize text for the free exact-duplicate check (§5.3 tier 1): case-fold, trim, collapse whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

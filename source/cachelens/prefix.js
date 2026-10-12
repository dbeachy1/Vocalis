/**
 * The prefix engine — how much of `next` a KV cache holding `prev` could reuse.
 *
 * 🔴 THIS MODULE IMPORTS NOTHING, AND THAT IS THE POINT. It takes two strings and returns a number, so the
 * two corrections the whole design turns on (DESIGN.md §3 and §4.1) are testable against hand-written
 * fixtures instead of against a live chat. Every bug this tool could plausibly ship lives in this file, and
 * `test/prefix.test.js` is where it gets caught.
 *
 * 🔴 IT IS A PREFIX, NOT A DIFF. A backend reuses its cache up to the FIRST position that differs and
 * recomputes everything after it. A diff finds identical islands *after* a change and would colour them
 * green; the cache cannot use a single token of them. A prompt with one word changed near the top diffs at
 * ~99% identical and reuses ~0%, and reporting the 99% would make this tool lie in exactly the situation it
 * exists to expose. See the `top-edit` fixture, which is the standing regression test for that mistake.
 */

/**
 * Is this UTF-16 code unit the leading half of a surrogate pair?
 * @param {number} unit A code unit, or NaN when read past the end of a string
 * @returns {boolean} True for a high surrogate
 */
function isHighSurrogate(unit) {
    return unit >= 0xD800 && unit <= 0xDBFF;
}

/**
 * The number of leading characters `prev` and `next` share.
 *
 * ⚠️ NO NORMALIZATION OF ANY KIND — not line endings, not whitespace, not Unicode form. The backend received
 * exactly these bytes. Normalizing would paper over a real cache break and report reuse that did not happen,
 * which is the same class of lie as the diff above, just quieter.
 * @param {string|null|undefined} prev The baseline — what the cache is assumed to hold. Assembled by the
 * caller per DESIGN.md §4.1; this function does not know what a completion is.
 * @param {string|null|undefined} next The prompt being sent
 *
 * ⚠️ BOTH ADMIT THE ABSENCE THE FIRST LINE OF THE BODY REFUSES, and `describeReuse` below already
 * did for `prev`. A signature narrower than its own guard makes the test that proves the guard is live the
 * one place a cast is needed — which is the guard's evidence being weakened to protect a wrong annotation.
 * @returns {number} Characters of shared prefix, always landing on a code point boundary
 */
export function commonPrefixChars(prev, next) {
    if (typeof prev !== 'string' || typeof next !== 'string') {
        return 0;
    }

    const limit = Math.min(prev.length, next.length);
    let i = 0;

    while (i < limit && prev.charCodeAt(i) === next.charCodeAt(i)) {
        i++;
    }

    // ⚠️ DO NOT SPLIT A SURROGATE PAIR. If the divergence landed between the halves of an astral character
    // the last matched unit is a lone high surrogate, which is not a character the backend tokenized —
    // it is half of one. One emoji in a persona is enough to hit this, and the symptom is a phantom
    // one-character divergence that never resolves no matter what the user edits.
    //
    // The exception is two strings that are wholly identical: there is nothing after the pair to disagree
    // with, so a trailing high surrogate there is simply the text both sides hold, and backing off would
    // under-report a perfect match by one character.
    const identical = i === prev.length && i === next.length;

    if (!identical && i > 0 && isHighSurrogate(prev.charCodeAt(i - 1))) {
        i--;
    }

    return i;
}

/**
 * What a prefix scan can say about one turn.
 * @typedef {object} Reuse
 * @property {boolean} hasBaseline Whether there was anything to compare against at all. Distinct from a
 * prefix of zero, which is a real comparison that found nothing in common.
 * @property {number} prefixChars Characters of `next` the cache could reuse. 0 when there is no baseline.
 * @property {number} nextChars Length of the prompt being sent.
 * @property {number} ratio `prefixChars / nextChars`, and 0 when there is no baseline to reuse from.
 */

/**
 * The same comparison, carrying the one distinction a bare integer cannot make.
 *
 * 🔴 "NO BASELINE" IS NOT "ZERO REUSE". The first turn of a chat has nothing in the cache to compare
 * against, and drawing a solid red bar for it would report a catastrophic cache miss where nothing happened
 * at all. The caller renders no bar for `hasBaseline: false` — see DESIGN.md §7.2's `empty-prev` fixture,
 * which exists to keep that distinction alive in a pure module rather than in the renderer where it cannot
 * be tested.
 * @param {string|null|undefined} prev The baseline, or empty/absent when there is none
 * @param {string} next The prompt being sent
 * @returns {Reuse} `ratio` is the fraction of `next` the cache could reuse, and is 0 when there is no
 * baseline to reuse from.
 */
export function describeReuse(prev, next) {
    const nextChars = typeof next === 'string' ? next.length : 0;
    const hasBaseline = typeof prev === 'string' && prev.length > 0;
    const prefixChars = hasBaseline ? commonPrefixChars(prev, next) : 0;

    return {
        hasBaseline,
        prefixChars,
        nextChars,
        ratio: nextChars > 0 ? prefixChars / nextChars : 0,
    };
}

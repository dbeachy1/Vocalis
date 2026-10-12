/**
 * Attribution — turning a divergence offset into the name of the thing that moved.
 *
 * 🔴 THIS MODULE IMPORTS NOTHING. Same reason as `prefix.js`: it takes strings and returns names, so its
 * one dangerous behaviour — naming the wrong section — is testable against fixtures.
 *
 * "You lost the cache at char 1,842" is trivia. "You lost it inside World Info" is a fix. That is the whole
 * value here, and it is also the whole risk: a WRONG attribution sends the reader off to fix the wrong
 * lorebook, which is worse than no attribution at all. So every rule below resolves ties and doubts toward
 * saying nothing (DESIGN.md §8.1).
 */

/**
 * One section of a prompt, as the itemized record holds it.
 * @typedef {object} SectionSpec
 * @property {string} name Human-facing name — what the row will say
 * @property {string|undefined} text The section's text, verbatim, as it should appear in the prompt.
 * Absent whenever the itemized record did not carry that section — `locateUnique` already refuses a
 * non-string, so an absent section is omitted rather than being matched as an empty one.
 * @property {SectionSpec[]} [children] Sections nested inside this one. World Info lives inside the story
 * string; a turn lives inside the chat history. The innermost match is the one reported.
 * @property {boolean} [orderedChildren] Whether the children appear in the order given (default true).
 * Set false for a level whose members have no fixed order — depth injections land between chat turns
 * according to their configured depth, so anchoring them one after another would misplace all but the first.
 */

/**
 * A located section.
 * @typedef {object} SectionSpan
 * @property {string} name
 * @property {number} start Inclusive character offset into the prompt
 * @property {number} end Exclusive
 * @property {number} depth 0 for a top-level section, 1 for its children, and so on
 */

/**
 * Find the one place `text` sits inside `prompt[from, to)`, or nothing.
 *
 * 🔴 MORE THAN ONE MATCH MEANS NO MATCH. A section string that appears twice in the remaining span cannot be
 * placed — the first occurrence is a guess, and a guess here is the wrong-lorebook failure above. Zero
 * matches is the same answer for the same reason: the prompt the section was supposed to be in has been
 * transformed (instruct wrapping, `collapse_newlines`, a plugin rewrite) and we no longer know where it went.
 * @param {string} prompt The prompt being searched
 * @param {string|undefined} text The section text, absent when the itemized record did not carry it
 * @param {number} from Inclusive
 * @param {number} to Exclusive
 * @returns {{start: number, end: number}|null} The unique span, or null when absent or ambiguous
 */
function locateUnique(prompt, text, from, to) {
    if (typeof text !== 'string' || text.length === 0) {
        return null;
    }

    const start = prompt.indexOf(text, from);

    if (start < 0 || start + text.length > to) {
        return null;
    }

    const second = prompt.indexOf(text, start + 1);

    if (second >= 0 && second + text.length <= to) {
        return null;
    }

    return { start, end: start + text.length };
}

/**
 * Resolve one level of sections into spans, recursing into children.
 * @param {string} prompt The prompt
 * @param {SectionSpec[]} sections The sections at this level, in prompt order
 * @param {number} from Window start, inclusive
 * @param {number} to Window end, exclusive
 * @param {boolean} ordered Whether these siblings are anchored one after another
 * @param {number} depth Nesting depth, for innermost-wins resolution
 * @param {SectionSpan[]} out Accumulator
 * @returns {number} The offset the next sibling should be anchored from
 */
function resolveLevel(prompt, sections, from, to, ordered, depth, out) {
    let cursor = from;

    for (const section of Array.isArray(sections) ? sections : []) {
        if (!section || typeof section.name !== 'string') {
            continue;
        }

        const searchFrom = ordered ? cursor : from;
        const span = locateUnique(prompt, section.text, searchFrom, to);
        const children = Array.isArray(section.children) ? section.children : [];
        const childrenOrdered = section.orderedChildren !== false;

        if (span) {
            out.push({ name: section.name, start: span.start, end: span.end, depth });
            resolveLevel(prompt, children, span.start, span.end, childrenOrdered, depth + 1, out);
            cursor = Math.max(cursor, span.end);
            continue;
        }

        // ⚠️ AN UNPLACEABLE PARENT DOES NOT DISINHERIT ITS CHILDREN. The story string is assembled from a
        // template and then wrapped by instruct formatting, so the concatenation the record stored often does
        // not appear verbatim while the lorebook text inside it does — and World Info is the single most
        // useful thing this panel can name. The children are searched in the window the parent would have
        // occupied, at the parent's own depth, so they still resolve and still cannot escape the window.
        cursor = Math.max(cursor, resolveLevel(prompt, children, searchFrom, to, childrenOrdered, depth, out));
    }

    return cursor;
}

/**
 * Locate every section of a prompt.
 *
 * Anchored forward: each section is searched for starting at the end of the previous one, in prompt order, so
 * a string that legitimately occurs twice (a character description echoed in the examples block) is placed by
 * position rather than by luck.
 * @param {string} prompt The prompt to locate sections within — the same string the divergence offset indexes
 * @param {SectionSpec[]} sections The sections, in prompt order
 * @returns {SectionSpan[]} Every span that could be placed unambiguously. Sections that could not are simply
 * absent, which is how an offset inside them ends up unattributed.
 */
export function locateSections(prompt, sections) {
    if (typeof prompt !== 'string' || prompt.length === 0) {
        return [];
    }

    /** @type {SectionSpan[]} */
    const out = [];

    resolveLevel(prompt, sections, 0, prompt.length, true, 0, out);

    return out;
}

/**
 * Name the section an offset falls in.
 *
 * The innermost containing span wins — a divergence inside a lorebook entry inside the story string is
 * reported as World Info, because that is the thing the reader can go and change.
 * @param {SectionSpan[]} spans From `locateSections`
 * @param {number} offset A character offset into the same prompt
 * @returns {string|null} The section name, or null for unattributed
 */
export function attributeOffset(spans, offset) {
    if (!Array.isArray(spans) || !Number.isFinite(offset)) {
        return null;
    }

    /** @type {SectionSpan|null} */
    let best = null;

    for (const span of spans) {
        if (offset < span.start || offset >= span.end) {
            continue;
        }

        const deeper = best === null || span.depth > best.depth;
        // Two spans at the same depth can overlap when an unplaceable parent promoted its children; the
        // tighter one is the more specific answer.
        const tighter = best !== null && span.depth === best.depth && (span.end - span.start) < (best.end - best.start);

        if (deeper || tighter) {
            best = span;
        }
    }

    return best ? best.name : null;
}

/**
 * The client-side components of a prompt, by the field the itemized record holds each one in.
 *
 * 🔴 THESE NEVER APPEAR IN `rewrittenBy`, AND THAT IS NOT A GAP IN THE FORK. World Info, the author's note,
 * summaries and vector results are applied IN THE BROWSER, before the request is made, so the server sees a
 * finished prompt with no seam and has genuinely nothing to report. The panel named one server plugin and
 * said nothing about a World Book that was rewriting the prompt every turn — misleading by omission, and
 * the omission was invisible.
 *
 * ⚠️ THE INTERESTING QUESTION IS NOT WHICH ARE PRESENT — it is which CHANGED, because that is what a cache
 * pays for. A World Book that is enormous and identical every turn costs nothing.
 */
const CLIENT_COMPONENTS = [
    { name: 'World Info', field: 'worldInfoString' },
    { name: "Author's Note", field: 'authorsNoteString' },
    { name: 'Summary', field: 'summarizeString' },
    { name: 'Vector Memories', field: 'chatVectorsString' },
    { name: 'Data Bank', field: 'dataBankVectorsString' },
    { name: 'Smart Context', field: 'smartContextString' },
    // Depth-injected text spliced into the message array, and every other extension prompt joined. Without
    // these two the list is incomplete again — which is the same failure as the label that claimed
    // completeness, just quieter.
    { name: 'Depth Injections', field: 'chatInjects' },
    { name: 'Other Extensions', field: 'allAnchors' },
];

/**
 * @param {STItemizedPrompt} itemized An itemized record
 * @param {string} field The field to read
 * @returns {string} Its text. Absent and empty read alike, so a component that was removed counts as a
 *   change and one that was never there does not. A field that is not a string is compared by its JSON
 *   rather than being silently treated as empty — an unexpected shape must not turn into "nothing changed".
 */
function componentText(itemized, field) {
    const value = itemized[field];

    if (typeof value === 'string') {
        return value;
    }

    return value === null || value === undefined ? '' : JSON.stringify(value);
}

/**
 * Which client-side components differ from the previous turn's.
 *
 * ⚠️ NO PREVIOUS TURN MEANS NO ANSWER, NOT "NOTHING CHANGED". The first row of a chat, and any turn whose
 * predecessor is not on screen, has nothing to compare against; reporting an empty list there would say
 * "none of these changed" about a comparison that was never made.
 * @param {STItemizedPrompt|null|undefined} previous The previous turn's itemized record
 * @param {STItemizedPrompt|null|undefined} current This turn's itemized record
 * @returns {string[]|null} The names that changed, or null when there was nothing to compare against
 */
export function changedClientComponents(previous, current) {
    if (!previous || !current) {
        return null;
    }

    return CLIENT_COMPONENTS
        .filter(component => componentText(previous, component.field) !== componentText(current, component.field))
        .map(component => component.name);
}

/**
 * Client-side components the breakdown holds but the prompt as sent does not contain.
 *
 * ⚠️ A COMPONENT THAT IS NOT FOUND IS INFORMATION, NOT AN ERROR. A World Info entry can activate and then be
 * trimmed by the context limiter after the breakdown was built, and its absence from the prompt is the only
 * evidence that happened — invisible any other way. It is also what a component assembled into the prompt in
 * pieces looks like, and this code cannot tell those two apart, so the row states the observation and the
 * tooltip states both readings.
 *
 * 🔴 `indexOf`, NOT `locateSections`. That function omits a section it could not place UNAMBIGUOUSLY, which
 * conflates "not in the prompt" with "in it more than once" — and reporting the second as the first would be
 * a false claim about the user's lorebook.
 *
 * ⚠️ `encode` IS HOW A COMPONENT APPEARS IN THIS PROMPT. A chat-completion prompt is `JSON.stringify(messages)`,
 * which holds every newline as `\n`, so a multi-line lorebook searched for verbatim is never found — and this
 * function would then report, about every chat-completion turn, that World Info was trimmed out of a prompt it
 * is sitting in. The caller knows which form the prompt is in; this module stays free of that knowledge.
 * @param {STItemizedPrompt|null|undefined} itemized This turn's itemized record
 * @param {string} prompt The prompt as sent
 * @param {(text: string) => string|undefined} [encode] Turns a component's text into its form inside `prompt`
 * @returns {string[]} The names, empty when every non-empty component is present
 */
export function unplacedClientComponents(itemized, prompt, encode = text => text) {
    if (!itemized || typeof prompt !== 'string' || prompt.length === 0) {
        return [];
    }

    return CLIENT_COMPONENTS
        .filter((component) => {
            const text = componentText(itemized, component.field);

            return text.length > 0 && !prompt.includes(encode(text) ?? text);
        })
        .map(component => component.name);
}

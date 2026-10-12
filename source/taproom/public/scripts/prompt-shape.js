/**
 * THE PROMPT'S SHAPE, WITHOUT THE PROMPT — lengths of the parts the browser assembled, for the server's
 * cache-geometry diagnostic.
 *
 * The server can see THAT a turn diverged from the previous one and where, because it holds both strings
 * (`src/prompt-record.js`). What it cannot see is which of the browser's parts the divergence landed in:
 * World Info, the author's note, a summary, a depth injection and the chat history are all applied here and
 * arrive at the server as one flat string. So the browser sends the seam positions and nothing else.
 *
 * 🔴 LENGTHS AND COUNTS. NEVER TEXT. Every value here is a number, and the field names are a fixed vocabulary
 * from this file. That is what lets the server log the result as non-sensitive on an install with debugMode
 * off — see `src/prompt-cache-geometry.js`, which states the same rule from the other end.
 *
 * ⚠️ IT RIDES A HEADER, SO IT STAYS SMALL. `getGenerationHeaders` documents why identity goes in headers
 * rather than the body — the text-completion path forwards the body to the model host verbatim — and adds
 * that anything sent this way must stay short. The full shape is ~150 characters — ~110 for the layout, plus
 * the four `p*` fields echoing the backend's last measurement when there is one. A field added here must
 * not change that by much, and nothing that grows with the conversation belongs in it.
 */

/**
 * The wire format: `v1;name=number;name=number`.
 *
 * Deliberately generic, so the server's parser needs no copy of the field list. A format whose reader must be
 * kept in step with its writer, in a different directory, is a bug waiting for someone to add a field to one
 * side; here an unknown name simply reports itself by name.
 */
const SHAPE_VERSION = 'v1';

/**
 * Describe the assembled prompt by the size of its parts.
 *
 * The first four are the prompt's top-level layout in send order — `getCombinedPrompt` joins exactly these,
 * so their cumulative lengths are the seam offsets the server needs to place a divergence. The rest are
 * contributors that live INSIDE those four and cannot be located by offset, but whose change in size is
 * usually the whole answer: if a cold turn's World Info grew by 512 characters, that is the cause and no
 * offset arithmetic is needed to say so.
 * @param {object} parts The assembled pieces
 * @param {string} [parts.story] Story string: system prompt, card, persona, World Info before/after
 * @param {string} [parts.examples] Example messages, as included this turn
 * @param {string} [parts.history] The chat history, depth injections included
 * @param {string} [parts.continueTail] The partial message being continued, when continuing
 * @param {string} [parts.worldInfo] World Info text, which lives inside `story`
 * @param {string} [parts.authorsNote] Author's note
 * @param {string} [parts.summary] Running summary
 * @param {string} [parts.vectors] Vector recall, chat and data bank together
 * @param {string} [parts.injects] Depth injections, which live inside `history`
 * @param {number} [parts.messagesCount] Messages that fit in the window
 * @param {number} [parts.examplesCount] Example dialogues that fit in the window
 * @param {number} [parts.messageId] The id of the message this generation will produce, so a log line
 * can be matched to a message without a screenshot
 * @param {object} [parts.measured] What the backend REPORTED about an earlier prompt, echoed back so the
 * server can log the measured outcome beside its own prediction. Omitted entirely when there is none.
 * @param {number} [parts.measured.seq] The prompt-record seq the measurement belongs to
 * @param {number} [parts.measured.cached] Tokens the backend reused
 * @param {number} [parts.measured.processed] Tokens the backend had to process
 * @param {number} [parts.measured.ms] Prefill milliseconds
 * @returns {string} The header value
 */
export function formatPromptShape(parts) {
    const size = (value) => (typeof value === 'string' ? value.length : 0);
    const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(Number(value))) : 0);

    const fields = [
        ['story', size(parts.story)],
        ['ex', size(parts.examples)],
        ['hist', size(parts.history)],
        ['cont', size(parts.continueTail)],
        ['wi', size(parts.worldInfo)],
        ['an', size(parts.authorsNote)],
        ['sum', size(parts.summary)],
        ['vec', size(parts.vectors)],
        ['inj', size(parts.injects)],
        ['msgs', count(parts.messagesCount)],
        ['exms', count(parts.examplesCount)],
        ['mesid', count(parts.messageId)],
    ];

    // 🔴 OMITTED WHEN ABSENT, NEVER SENT AS ZERO. A backend that reused nothing reports `pcached=0`, and
    // that is the single most interesting reading there is — the first turn after a restart produced
    // exactly it. Defaulting a missing measurement to 0 would make "no measurement yet" and "the cache
    // did nothing" the same line. The wire format is name=number pairs with a generic reader, so leaving
    // the fields out is what "not measured" looks like.
    if (parts.measured && Number.isFinite(parts.measured.seq)) {
        fields.push(['pseq', count(parts.measured.seq)]);
        fields.push(['pcached', count(parts.measured.cached)]);
        fields.push(['pproc', count(parts.measured.processed)]);
        fields.push(['pms', count(parts.measured.ms)]);
    }

    return [SHAPE_VERSION, ...fields.map(([name, value]) => `${name}=${value}`)].join(';');
}

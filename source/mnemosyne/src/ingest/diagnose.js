/**
 * Turning a thrown extraction failure into a sentence an operator can act on, without putting conversation in
 * the log.
 *
 * ## 🔴 Why this module exists
 *
 * `maybeIngest`'s catch used to report `error.name` and nothing else, on the reasoning that "an error's name is
 * not user content; its message can be". The reasoning is sound and the result was useless: every throw on the
 * extraction path is a plain `Error`, so a permanently dead feature reported itself as
 * `ingest declined after an error (Error) — Details suppressed.` on every turn, for ever. That line was the
 * entire operator-visible story of an install on which automatic memory had never once succeeded — an hour of
 * a user's evening, a screenshot and a full log dump to establish something the plugin already knew.
 *
 * ## 🔴 Why the fork's own messages can be quoted, and where that stops
 *
 * Everything `context.generate` throws is a string the FORK authored, prefixed `context.generate:`, and the
 * values interpolated into them are structural: an `api_type` from a fixed enum, a millisecond timeout, an
 * HTTP status. None of them is user-authored, so a rewritten form of them belongs on the NORMAL channel by the
 * same rule that lets us log `%d stored`.
 *
 * 🔴 **With exactly one exception, and it is the whole reason this is a translator rather than a pass-through.**
 * The non-OK branch reads `` `backend '${api_type}' returned ${status}. ${detail}` `` where `detail` is
 * `await reply.text()` — *the backend's response body*. An OpenAI-compatible 400 commonly echoes the offending
 * request back, and the offending request contains the extraction prompt, and the extraction prompt contains
 * the user's conversation. Passing the message through would therefore leak chat content into `st.log` on a
 * default install, which is precisely the failure `logging.js` exists to prevent. So the status code is lifted
 * out by pattern and **everything after it is dropped**.
 *
 * ⚠️ Anything unrecognized degrades to the error's *name*, i.e. exactly the old behavior. A message this
 * module has not been taught is treated as potentially content-bearing, never quoted hopefully.
 */

/**
 * The known `context.generate` failures, most specific first.
 *
 * Each entry matches on a fragment of the fork's authored message and yields a content-free description plus a
 * `fix` — the thing the operator would actually do about it. The fragments are deliberately short and stable:
 * matching whole sentences would break on a fork wording change and silently fall through to `(Error)`, which
 * is the state this module exists to end.
 *
 * @type {Array<{ match: RegExp, describe: (m: RegExpMatchArray) => string, fix: string }>}
 */
const KNOWN = [
    {
        match: /no active backend captured/,
        describe: () => 'the fork has not captured a backend connection for this user',
        fix: 'Generate once in a chat — the fork stashes the connection as it passes, so extraction can only run after that. A fork below plugin API 8 captures Text Completion connections only, so in Chat Completion this stays unfixable until the fork is updated.',
    },
    {
        match: /is not supported yet/,
        describe: () => 'the fork\'s plugin generate does not support this backend',
        fix: 'Automatic memory needs a backend the fork\'s plugin generate can drive: the OpenAI-completions family in Text Completion, and, from plugin API 8, the OpenAI-wire Chat Completion sources. Update the fork, or switch to a supported backend.',
    },
    {
        match: /no instruct envelope was captured/,
        describe: () => 'the fork captured no instruct envelope, so the extraction prompt cannot be framed',
        fix: 'Turn Instruct Mode on for this connection, then generate once so the fork captures the envelope.',
    },
    {
        match: /did not answer within (\d+)ms/,
        describe: (m) => `the backend did not answer within ${m[1]}ms`,
        fix: 'The backend is slow or wedged. Check it is up and serving completions.',
    },
    {
        // 🔴 THE STATUS ONLY. `detail` follows it in the fork's message and is the backend's response body —
        // see the module header. The capture group stops at the digits and nothing past them is read.
        match: /returned (\d{3})\b/,
        describe: (m) => `the backend rejected the request with HTTP ${m[1]}`,
        fix: 'A 401 or 403 is authentication; a 400 is usually an unsupported parameter in the request body.',
    },
    {
        match: /returned no completion text/,
        describe: () => 'the backend answered, but with no completion text in it',
        fix: 'The backend replied in a shape the fork could not read. Check the model is loaded and serving completions.',
    },
];

/**
 * Describe why an extraction failed, in terms that are safe to publish.
 *
 * @param {unknown} error Whatever was thrown — `throw` takes anything, so nothing is assumed about it
 * @returns {{ reason: string, fix: string|null }} `reason` is always a sentence fragment naming the cause;
 *          `fix` is present only when the cause is one we recognize.
 */
export function describeFailure(error) {
    const message = typeof (/** @type {Partial<Error>} */ (error)?.message) === 'string'
        ? /** @type {string} */ (/** @type {Partial<Error>} */ (error).message)
        : '';

    for (const entry of KNOWN) {
        const found = message.match(entry.match);

        if (found) {
            return { reason: entry.describe(found), fix: entry.fix };
        }
    }

    // ⚠️ THE FALLBACK IS THE OLD BEHAVIOR ON PURPOSE. An unrecognized message may carry anything — a store
    // error naming a path, a card parse quoting a field — so it is not published. The name alone is what the
    // previous implementation logged and it remains the safe floor.
    const name = /** @type {Partial<Error>} */ (error)?.name;

    return {
        reason: `an unrecognized ${typeof name === 'string' && name ? name : 'Error'} (details suppressed — turn on logging.debugMode to see it)`,
        fix: null,
    };
}

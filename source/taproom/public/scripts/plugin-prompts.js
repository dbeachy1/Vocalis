/**
 * The recent conversation, structured, for server plugins that asked for it (§17).
 *
 * On the chat path a server interceptor is handed the role-tagged array; on the TEXT path it gets one
 * instruct-rendered string, because the client renders the turns to a blob before POSTing and the server never
 * sees them. That forces a memory plugin to guess its retrieval query out of a rendered template and to
 * reconstruct turns lossily for ingest. This is the client half of closing that.
 *
 * 🔴 EVERYTHING IN THIS FILE IS PURE, AND THAT IS DELIBERATE. The two rules it encodes — where an index comes
 * from, and what a turn looks like — are the two §17 got WRONG on the first attempt, and both failures were
 * silent. Keeping them free of imports is what lets them be tested directly instead of only through a browser.
 * The window SIZE lives in plugin-client-config.js, because that is an I/O concern and this is not.
 */

/**
 * Is this one of the messages a prompt is built from?
 *
 * 🔴 ONE PREDICATE FOR BOTH READERS OF A CHAT. `Generate()` uses it to build the prompt and the `recentMessages`
 * window; the server's `context.readChat` (API v7) imports this same file to read a chat from disk. A copy of
 * the rule on the server would be a second definition of "hidden", and the day the two disagreed a rescan
 * would return a different set of turns from the one live ingest saw — with the same indices, so nothing
 * would notice.
 *
 * `/hide` sets `is_system`, which is what drops a message here. A tool-call record is also `is_system`, and is
 * kept only while the connection can use tools — which only the client knows, hence the parameter.
 * @param {object} message One chat message
 * @param {boolean} canUseTools Whether the active connection supports tool calling
 * @returns {boolean} True if the message belongs in the prompt
 */
export function isCoreMessage(message, canUseTools) {
    // 🔴 A COMPACTED MESSAGE IS OUT, TOOLS OR NOT. Taproom Compactor hides the messages it has
    // summarized by setting `is_system` (the `/hide` mechanism) and marks each one with
    // `extra.taproom_compactor`. Without this clause the tool-record exception below would keep
    // every compacted TOOL message in the prompt for ever — silently, and precisely on the long
    // tool-heavy chats compaction exists for. The summary now speaks for these messages; nothing
    // browser-side can detect the omission, so the rule lives here, in the one predicate both the
    // client and the server's `readChat` share (taproom-compactor DESIGN.md §8.3).
    //
    // ⚠️ HIDDEN AND MARKED, both — a mark alone changes nothing. Manually unhiding a compacted
    // message (`/unhide`) is the user overriding the compaction for that message, and the
    // override wins: the message re-enters the prompt alongside the summary that also describes
    // it. Duplication, chosen by the user, is not corruption; silently vetoing their unhide
    // would be.
    if (message.is_system && message.extra?.taproom_compactor) {
        return false;
    }

    return !message.is_system || (canUseTools && Array.isArray(message.extra?.tool_invocations));
}

/**
 * Split the chat into the messages a prompt is built from, and their indices in the FULL chat array.
 *
 * 🔴 THE INDICES ARE CAPTURED BEFORE THE FILTER, AND THAT IS THE WHOLE POINT. `/hide` is implemented as
 * `is_system = true`, so a hidden message drops out of this filter and every later message shifts down one
 * position. Any number derived from a POST-filter position — the `index` the core-chat map assigns, or a
 * single offset for the window — therefore changes meaning the moment a user hides something, and a plugin
 * holding a high-water mark against it silently stops seeing new turns. §17.8.1.
 *
 * The codebase already makes exactly this capture for exactly this reason, in `getRegexedString`'s depth
 * calculation. This is that idiom a second time, not a new concept.
 *
 * ⚠️ ONE PREDICATE, TWO ARRAYS, RETURNED TOGETHER. A caller that filtered separately would have two filters to
 * keep in step, and nothing to notice when they drifted.
 * @param {object[]} chat The full chat array
 * @param {(message: object) => boolean} isCoreMessage Which messages a prompt is built from
 * @param {boolean} isSwipe Whether this generation is a swipe, which drops the last message
 * @returns {{messages: object[], indices: number[]}} The core messages and their chat-relative indices
 */
export function splitCoreChat(chat, isCoreMessage, isSwipe) {
    const indices = chat.map((_, index) => index).filter(index => isCoreMessage(chat[index]));

    if (isSwipe) {
        // A swipe regenerates the last reply, so the prompt is built without it. It renumbers NOTHING: the
        // turns that remain keep the indices they had, which is what makes a swipe invisible to a plugin's
        // mark — the case that motivated the anchor in the first place.
        indices.pop();
    }

    return { messages: indices.map(index => chat[index]), indices };
}

/**
 * Turn the conversation's recent turns into the shape a plugin receives.
 *
 * 🔴 NOT ST's `ChatMessage`. Forwarding `{ mes, name, is_user, is_system, extra, … }` raw would hand every
 * plugin the fork's internals — no `role`, no `content` — and break any renderer written against the chat
 * path; the one known consumer's would emit "Alice: undefined" for every turn. So the client normalizes, once,
 * identically for both paths (§17.5).
 *
 * ⚠️ THE INDICES ARE SPARSE. Hidden and system messages leave gaps, so `last.index - mark` is NOT a count of
 * turns and must never be used as one. Count the turns above the mark instead. This is stated for the plugin's
 * benefit and is the documented consequence of §17.8.1's choice.
 *
 * ⚠️ `send_date` TRAVELS RAW AND THE SERVER PARSES IT (API v7). Like `avatar`, it is a fork-internal key that
 * the server replaces before a plugin sees the turn — here with `sendDate` in epoch milliseconds. The parse is
 * server-side because the server's `readChat` must produce the identical number for the identical message,
 * and one parser (`src/message-time.js`) is how that stays true. Omitted when the message has none.
 * @param {object[]} messages The core messages, in order, with content already resolved
 * @param {number[]} indices Each one's position in the full chat array, parallel to `messages`
 * @param {number} limit How many trailing turns to send — the largest any plugin declared
 * @param {string} [selectedAvatar] The current character's avatar filename, for solo chats — see below
 * @returns {Array<{role: string, name: string|undefined, content: string, index: number, avatar: string|undefined, send_date?: string|number}>|undefined}
 * The window, or undefined when nobody asked for one
 */
export function buildRecentMessages(messages, indices, limit, selectedAvatar) {
    if (!Number.isInteger(limit) || limit <= 0 || !Array.isArray(messages) || !Array.isArray(indices)) {
        return undefined;
    }

    // Belt and braces: `splitCoreChat` returns these together and in step, so a mismatch means a caller has
    // taken them apart and dropped one. An anchor that does not line up with its turns is worse than no window
    // at all — it is a window that reads as correct — so say so and send nothing.
    if (messages.length !== indices.length) {
        console.error('Recent messages and their chat indices are out of step; no window will be sent to server plugins.');
        return undefined;
    }

    const from = Math.max(0, messages.length - limit);

    return messages.slice(from).map((message, offset) => ({
        role: message.is_user ? 'user' : (message.is_system ? 'system' : 'assistant'),
        // The character in a solo chat, the responding character in a group, the persona on user turns —
        // which is precisely what ST already stores per message.
        name: typeof message.name === 'string' && message.name !== '' ? message.name : undefined,
        content: String(message.mes ?? ''),
        index: indices[from + offset],
        avatar: turnAvatar(message, selectedAvatar),
        // Spread rather than assigned so a message without one sends no key at all, and a stray object in
        // the field never reaches the wire — the server's well-formedness check would drop the whole window.
        ...(typeof message.send_date === 'string' || typeof message.send_date === 'number' ? { send_date: message.send_date } : {}),
    }));
}

/**
 * Which character produced a turn, as an avatar filename — the key the SERVER trades for a stable `charId`.
 *
 * 🔴 A KEY, NOT AN ID, AND THE DISTINCTION IS THE DESIGN (§22.8.2). The map from avatar filename to id lives
 * on the server; this file is pure and could not read it if it wanted to. So the client answers the only
 * question it is actually able to answer — *which card wrote this turn* — and the server answers the one it
 * owns.
 *
 * ⚠️ `original_avatar` IS SET IN GROUP CHATS ONLY (`group-chats.js:599`, `script.js:6825`, both gated on
 * `selected_group`). In a solo chat no turn carries one, so an assistant turn is attributed to the selected
 * character — which is correct, because a solo chat has exactly one. That fallback is why `selectedAvatar` is
 * a parameter rather than something read from module state: this file stays pure, and the rule stays testable.
 *
 * 🔴 USER AND SYSTEM TURNS RESOLVE TO `undefined`, WHICH THE SERVER TURNS INTO `null` — NEVER `''`. An empty
 * string composes into a structurally valid "no character" partition that silently collects every user-tier
 * fact a plugin extracts. Returning nothing is what keeps that impossible.
 * @param {object} message One core message
 * @param {string} [selectedAvatar] The current character's avatar filename
 * @returns {string|undefined} The avatar filename, or undefined when no character produced this turn
 */
function turnAvatar(message, selectedAvatar) {
    if (message.is_user || message.is_system) {
        return undefined;
    }

    if (typeof message.original_avatar === 'string' && message.original_avatar !== '') {
        return message.original_avatar;
    }

    return typeof selectedAvatar === 'string' && selectedAvatar !== '' ? selectedAvatar : undefined;
}

/**
 * Where each rendered turn begins inside the prompt that is actually about to be sent (§27).
 *
 * The text path hands a server plugin ONE rendered string. The turn boundaries inside it existed only here,
 * in the client, at build time — `chat2` holds one instruct-rendered turn per entry — and the render throws
 * them away. A plugin that wants to place something at depth N therefore has to recover them by guessing the
 * instruct template out of the blob, which breaks on template changes, macros and prompt-regex transforms.
 * That guess is the whole reason a memory plugin prepends to the front instead, and prepending to the front
 * is what `KVCACHE_WORLDINFO_MEASUREMENTS.md` measured at 0.1 % cache reuse against 97.1 % below the history.
 *
 * So the fork ships the STRUCTURE and keeps its hands off the policy (§6.3): a character offset per turn, and
 * not one opinion about what belongs at any of them.
 *
 * 🔴 LOCATED BY SEARCH, NOT BY ARITHMETIC, AND THE DIFFERENCE IS THE SAFETY PROPERTY. Accumulating lengths
 * while `combine()` concatenates is exact at that instant and then silently stops being exact: the join is
 * followed by a `\r` strip, optionally by `collapseNewlines`, by a `GENERATE_AFTER_COMBINE_PROMPTS`
 * subscriber that may rewrite the whole string, and on the text path by `TEXT_COMPLETION_SETTINGS_READY`.
 * Each of those shifts every offset after it, and an offset that is WRONG is far worse than one that is
 * missing — the plugin splices into the middle of somebody else's turn and the prompt is corrupt, with
 * nothing anywhere to report it. Searching for the turn's own text in the FINAL string cannot do that: a hit
 * is a proof, and a miss is an honest `-1` that the plugin answers by falling back to its old placement.
 *
 * ⚠️ BACKWARDS, WITH A CEILING, BECAUSE SHORT TURNS REPEAT. "Yes." occurs a dozen times in a long chat, and a
 * forward `indexOf` would pin every one of them to the first. Walking from the end and refusing to look past
 * the turn already placed makes the k-th hit the k-th turn by construction. A turn that cannot be found does
 * NOT lower the ceiling — it is unknown, not known-to-be-here, and moving the ceiling on a guess is how one
 * transformed turn would drag every turn above it out of position.
 * @param {string} prompt The prompt exactly as it will be sent — after every transform, not before
 * @param {Array<{text: string, chatIndex: number}>} renderedTurns Each turn's rendered form and its position
 * in the FULL chat array, in prompt order, oldest first. `chatIndex` is -1 for anything that is not a turn.
 * @returns {Map<number, number>} Chat index to character offset, holding only the turns that were found
 */
export function locateRenderedTurns(prompt, renderedTurns) {
    /** @type {Map<number, number>} */
    const located = new Map();

    if (typeof prompt !== 'string' || !Array.isArray(renderedTurns)) {
        return located;
    }

    let ceiling = prompt.length;

    for (let i = renderedTurns.length - 1; i >= 0; i--) {
        const turn = renderedTurns[i];

        // Not a turn (a depth injection, the user-alignment message, a jailbreak), or nothing to search for.
        // Both are ordinary; `chat2` carries all three alongside the real turns and always has.
        if (!turn || !Number.isInteger(turn.chatIndex) || turn.chatIndex < 0 || typeof turn.text !== 'string' || turn.text === '') {
            continue;
        }

        // `lastIndexOf`'s second argument bounds where the match may START, so the ceiling — which is where
        // the turn BELOW this one starts — has to be reduced by the needle's length for the match to be
        // required to end at or before it.
        const at = prompt.lastIndexOf(turn.text, ceiling - turn.text.length);

        if (at < 0) {
            continue;
        }

        located.set(turn.chatIndex, at);
        ceiling = at;
    }

    return located;
}

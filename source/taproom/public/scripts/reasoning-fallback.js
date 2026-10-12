/**
 * Choose the only usable side of a model response. The original strings are returned unchanged
 * so leading Markdown whitespace is not lost; callers decide whether the selected text is safe.
 * @param {unknown} content Normal/final response content
 * @param {unknown} reasoning Extracted reasoning content
 * @returns {{ text: string, usedFallback: boolean }}
 */
export function selectReasoningFallback(content, reasoning) {
    const normal = typeof content === 'string' ? content : '';
    if (normal.trim()) {
        return { text: normal, usedFallback: false };
    }
    const fallback = typeof reasoning === 'string' ? reasoning : '';
    if (fallback.trim()) {
        return { text: fallback, usedFallback: true };
    }
    return { text: '', usedFallback: false };
}

/**
 * Whether a rendered text-completion prompt ends inside an open thinking block, so the model's reply begins
 * in the middle of its reasoning with no opening tag of its own.
 *
 * A prompt can end inside an open thinking block when `<think>` is in the Last Assistant Prefix, so the prompt ends
 * `<｜Assistant｜><think>`. Featherless then returns the reasoning one of two ways, and not consistently:
 * split off into its reasoning channel (fine), or left in the reply text as `reasoning</think>reply`. The
 * ordinary parser only recognises a reply that STARTS with the opening tag, so the second shape rendered
 * the whole chain of thought as the message, and a turn where the model skipped thinking rendered a bare
 * `</think>` in front of the reply.
 *
 * ⚠️ START REPLY WITH IS EXCLUDED ON PURPOSE. When the tag comes from there, `cleanUpMessage` glues it back
 * onto the front of the reply and the ordinary parser already handles it; splitting here as well would
 * strip the reasoning, and then the re-added tag would sit on the bare reply — the stray `<think>` this
 * setting was changed to get rid of.
 *
 * @param {unknown} prompt The prompt exactly as it is sent (a string on the text-completion paths)
 * @param {string} openTag The reasoning template's opening tag, whitespace trimmed
 * @param {string} replyPrefix Start Reply With, macros substituted
 * @returns {boolean}
 */
export function promptEndsInsideReasoning(prompt, openTag, replyPrefix) {
    if (typeof prompt !== 'string' || !openTag) {
        return false;
    }
    if (typeof replyPrefix === 'string' && replyPrefix.includes(openTag)) {
        return false;
    }
    return prompt.trimEnd().endsWith(openTag);
}

/**
 * Splits a reply whose prompt opened the thinking block: everything before the first closing tag is
 * reasoning, everything after it is the reply. Returns null when there is no closing tag, because then
 * nothing says where the reasoning ends — the caller leaves the text alone, and a streamed reply that held
 * it as reasoning is put back by {@link repairReasoningOnlyMessage}.
 *
 * `</think>` with nothing before it is a model that chose not to think; that yields empty reasoning and the
 * reply without the tag.
 *
 * @param {unknown} text Reply text as the backend returned it
 * @param {string} openTag The reasoning template's opening tag, whitespace trimmed
 * @param {string} closeTag The reasoning template's closing tag, whitespace trimmed
 * @returns {{ reasoning: string, content: string } | null}
 */
export function splitReasoningOpenedByPrompt(text, openTag, closeTag) {
    if (typeof text !== 'string' || !closeTag) {
        return null;
    }
    const at = text.indexOf(closeTag);
    if (at === -1) {
        return null;
    }
    let reasoning = text.slice(0, at).trim();
    // A model that repeats the opening tag the prompt already gave it.
    if (openTag && reasoning.startsWith(openTag)) {
        reasoning = reasoning.slice(openTag.length).trim();
    }
    return { reasoning, content: text.slice(at + closeTag.length).trimStart() };
}

/**
 * Repairs the narrow parser failure where an assistant response is stored entirely as reasoning.
 *
 * The reasoning parser can consume a complete response when a model omits its closing suffix. Such a
 * message must be made visible as normal assistant text so rendering, text-to-speech, and subsequent
 * prompt construction all see the response. This helper intentionally excludes user, system, and small
 * system messages because their empty bodies have other valid meanings.
 *
 * @param {ChatMessage} message Message to inspect and, when necessary, repair in place
 * @returns {boolean} Whether the message was repaired
 */
export function repairReasoningOnlyMessage(message) {
    if (!message || typeof message !== 'object' || message.is_user || message.is_system || message.extra?.isSmallSys) {
        return false;
    }

    const extra = message.extra;
    const reasoning = typeof extra?.reasoning === 'string' ? extra.reasoning : '';
    const selected = selectReasoningFallback(message.mes, reasoning);

    if (!selected.usedFallback) {
        return false;
    }

    // Preserve the complete model output; leading whitespace can be meaningful Markdown.
    message.mes = selected.text;

    for (const key of ['reasoning', 'reasoning_duration', 'reasoning_type', 'reasoning_display_text', 'reasoning_signature']) {
        delete extra[key];
    }

    // Keep the active swipe and its metadata aligned with the repaired message. Older chats may have
    // swipes without a complete swipe_info array, so backfill only the selected entry when possible.
    const swipeId = message.swipe_id;
    if (Array.isArray(message.swipes) && Number.isInteger(swipeId) && swipeId >= 0 && swipeId < message.swipes.length) {
        message.swipes[swipeId] = message.mes;
        if (!Array.isArray(message.swipe_info)) {
            message.swipe_info = [];
        }
        const swipeInfo = message.swipe_info[swipeId] && typeof message.swipe_info[swipeId] === 'object'
            ? message.swipe_info[swipeId]
            : {};
        swipeInfo.send_date = message.send_date;
        swipeInfo.gen_started = message.gen_started;
        swipeInfo.gen_finished = message.gen_finished;
        swipeInfo.extra = structuredClone(message.extra);
        message.swipe_info[swipeId] = swipeInfo;
    }

    return true;
}

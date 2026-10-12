/**
 * What the 🖌 button on a message does when that message has no image yet.
 *
 * `sdMessageButton` is a **re-roll** button: its job is "make another version of this image", and it
 * reuses the prompt saved on the existing one. The first-click case has no image to re-roll, so
 * upstream falls back to `title: message.mes` — **the entire message text becomes the prompt**, with
 * no LLM step, on a checkpoint that wants Danbooru tags. Prose, dialogue, `"she said"` and all, sent
 * straight to the sampler.
 *
 * It is instant, and it is the reason the button feels useless: 🪄 → *The Last Message* asks the LLM
 * to rewrite the scene as tags first, and produces a visibly better image from the same message.
 *
 * This module decides whether to take that better path, and — the part that is not obvious — what to
 * ask the LLM when the clicked message is **not** the last one.
 */

/**
 * 🔴 OFF IS UPSTREAM. Unchecked, the button must send `message.mes` exactly as it does today.
 *
 * @param {object} settings The `extension_settings.sd` object
 * @param {boolean} hasExistingImage Whether the message already carries a generated image
 * @returns {boolean} True to ask the LLM for a prompt instead of sending the raw message text
 */
export function shouldGeneratePromptWithLlm(settings, hasExistingImage) {
    // A message that already has an image is a genuine re-roll, and re-rolling means reusing that
    // image's prompt. Regenerating the prompt would quietly turn "another version of this" into
    // "a different picture", which is not what the button is for and not what was asked for.
    if (hasExistingImage) {
        return false;
    }

    return !!settings?.message_button_llm_prompt;
}

/**
 * Build the hidden instruction sent to the chat model.
 *
 * 🔴 **THE TEMPLATE SAYS "THE LAST CHAT MESSAGE", AND THE BUTTON IS NOT ALWAYS ON THE LAST ONE.**
 * The stock *Last Message* template instructs the model to describe *the last chat message*, which is
 * correct for the wand — that mode has no target but the newest message. The 🖌 button sits on every
 * message, including ones you have scrolled back to. Sending the template unchanged there produces a
 * flawless description of **a different message than the one you clicked**, and nothing in the UI or
 * the logs would say so.
 *
 * So: when the target really is the last message, the template goes out verbatim and this behaves
 * identically to the wand mode. When it is not, the target is named explicitly and the model is told
 * to ignore the recency wording it is about to read.
 *
 * @param {string} template The `Last Message` prompt template, macros already substituted
 * @param {string} messageText The text of the message whose button was clicked
 * @param {boolean} isLastMessage Whether that message is the last non-system message in the chat
 * @returns {string} The quiet prompt to send
 */
export function buildMessageQuietPrompt(template, messageText, isLastMessage) {
    const base = String(template ?? '').trim();

    if (isLastMessage) {
        return base;
    }

    const target = String(messageText ?? '').trim();

    // Nothing to point at -- fall back rather than emit an empty override block that reads as an
    // instruction to describe nothing.
    if (!target) {
        return base;
    }

    return `${base}\n\nIgnore the instruction to use the last chat message. Describe this message instead, and nothing else:\n"""\n${target}\n"""`;
}

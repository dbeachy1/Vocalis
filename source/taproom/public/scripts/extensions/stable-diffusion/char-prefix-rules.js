/**
 * Whether a generation gets the character-specific prompt prefix.
 *
 * Upstream drops that prefix for FREE (`/imagine`), FREE_EXTENDED, BACKGROUND, USER and
 * USER_MULTIMODAL. The intent is coherent — *"you typed exactly what you want, do not inject
 * character flavour"* — and it holds as long as the prefix is only adjectives.
 *
 * 🔴 **It stops holding once the prefix is where a LoRA lives.** ComfyUI has no LoRA concept in
 * SillyTavern, so a per-character LoRA rides in as a `<lora:NAME:1.0>` tag inside that same field
 * (see `DESIGN_IMAGE_GENERATION.md` §15). "Do not add flavour" then quietly also means "do not be
 * this character at all", and the failure is invisible: `/imagine` returns a perfectly good image of
 * the wrong person, with nothing in the UI or the logs saying a field was skipped.
 *
 * This module holds the rule alone, for the reason `comfy-auth.js` does: `index.js` transitively
 * imports the whole application and cannot be loaded under jest, and every failure mode here is
 * silent.
 */

/**
 * 🔴 OFF MUST BE BYTE-FOR-BYTE UPSTREAM. The checkbox is opt-in and defaults to false, so with it
 * unchecked this must reduce exactly to upstream's
 * `!ignoreNoCharForSwipe && noCharPrefix.includes(generationType)`.
 *
 * ⚠️ **The opt-in reaches FREE and FREE_EXTENDED only** — never BACKGROUND or USER. Those two are
 * genuinely not the character: a background is scenery, and "me" is the user's persona. Extending the
 * flag to them would put the character's LoRA on a picture of a room, which is the same class of bug
 * in the other direction.
 *
 * @param {object} params
 * @param {boolean} params.isNoCharPrefixMode The mode is in upstream's `noCharPrefix` list
 * @param {boolean} params.isFreeMode The mode is FREE or FREE_EXTENDED — i.e. `/imagine`
 * @param {boolean} params.isSwipe The generation was initiated by swiping an existing image
 * @param {boolean} params.isCharChat A single character is selected and this is not a group
 * @param {boolean} params.includeInFreeMode `extension_settings.sd.free_mode_char_prefix`
 * @returns {boolean} True when the character-specific prefixes must be left out
 */
export function shouldSkipCharacterPrefix({
    isNoCharPrefixMode,
    isFreeMode,
    isSwipe,
    isCharChat,
    includeInFreeMode,
}) {
    // The mode wants the prefix regardless -- Character, Portrait, Scenario, Last Message, Raw Last.
    if (!isNoCharPrefixMode) {
        return false;
    }

    // Upstream's existing carve-out: re-swiping an image in a single-character chat keeps the prefix,
    // so the swipe does not silently render a different character than the image it replaces. Its
    // existence is the evidence that this rule was already found to be wrong once.
    if (isSwipe && isCharChat) {
        return false;
    }

    // The opt-in. Group chats are excluded for the same reason the fields are hidden there at all --
    // there is no single character whose prefix it would be.
    if (isFreeMode && isCharChat && includeInFreeMode) {
        return false;
    }

    return true;
}

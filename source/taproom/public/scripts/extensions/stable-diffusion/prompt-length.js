/**
 * How many tokens the LLM gets when it is writing an image prompt.
 *
 * 🔴 **A language model fills the budget it is given.** The image-prompt call is
 * `generateQuietPrompt({ quietPrompt })` with no `responseLength`, so it inherits the main chat
 * response budget — set high, correctly, so ordinary replies are not truncated. Handed 500 tokens and
 * told to emit a comma-delimited list, a model emits 500 tokens of comma-delimited list. Observed
 * 2026-08-02: ~200 tags, drifting from the scene into `residential road view, commercial road view,
 * industrial road view…` long after it had run out of anything to describe.
 *
 * ⚠️ **This is not a repetition problem and samplers do not fix it.** DRY penalises repeated token
 * sequences; the tail here is lexically distinct every time and merely *semantically* redundant, so
 * DRY sees nothing wrong. Nor does instructing the model — "output at most 30 keywords" is a counting
 * task, and a model that could count would not be doing this. The only reliable bound is a token cap.
 *
 * Its own module for the reason `comfy-auth.js` is: `index.js` cannot be loaded under jest, and the
 * unset case has to keep behaving exactly like upstream.
 */

/** Below this a prompt cannot say anything useful; above it the cap is not a cap. */
const MIN_LENGTH = 16;
const MAX_LENGTH = 2048;

/**
 * 🔴 UNSET MUST MEAN UPSTREAM. `null` is what `generateQuietPrompt` treats as "not customised", so
 * every not-a-usable-number case has to return `null` rather than a fallback figure — otherwise
 * turning the feature off, or fat-fingering the field, silently truncates image prompts instead of
 * restoring the previous behaviour.
 *
 * @param {object} settings The `extension_settings.sd` object
 * @returns {number|null} A token cap, or null to inherit the API's configured response length
 */
export function resolveImagePromptLength(settings) {
    const raw = settings?.prompt_response_length;

    if (raw === undefined || raw === null || raw === '') {
        return null;
    }

    const value = Math.floor(Number(raw));

    // 0 is the documented "use the API's own setting", and it shares its answer with every other
    // unusable input -- negatives, NaN, text -- because all of them mean "no cap was configured".
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }

    return Math.min(Math.max(value, MIN_LENGTH), MAX_LENGTH);
}

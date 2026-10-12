/**
 * Per-character image checkpoint and ComfyUI workflow.
 *
 * 🔴 **A LoRA RIDES IN THE PROMPT. A CHECKPOINT DOES NOT.** `<lora:NAME:1.0>` is text — it is
 * concatenated into `%prompt%` and parsed back out by a tag-loader node at graph-execution time,
 * which is exactly why per-character LoRAs already work today through the character prompt prefix
 * and needed no code at all. A checkpoint name is an *input on a loader node*, substituted into the
 * workflow JSON from one global setting before submission. There is no text channel it can ride in
 * and no node that parses it out of a prompt. That asymmetry is the entire reason this file exists.
 *
 * ⚠️ **THE WORKFLOW TRAVELS WITH THE MODEL.** SDXL/Illustrious and FLUX.2 do not share a graph —
 * FLUX wants a UNet loader, dual CLIP encoders and its own VAE. Swapping `ckpt_name` while leaving
 * an SDXL graph in place is a hard ComfyUI error at the loader node, not a picture. Both fields are
 * offered together for that reason. Setting only `model` is still allowed and still correct when
 * two checkpoints share an architecture (two Illustrious merges, say) — but nothing here can detect
 * a mismatch, because only ComfyUI knows what a given graph will accept.
 *
 * Why a module rather than four lines inline: `index.js` transitively imports the whole application
 * and cannot be loaded under jest — the same reason `char-prefix-rules.js` and `comfy-auth.js`
 * exist. Every failure here is silent. A wrong checkpoint does not throw; it returns a perfectly
 * good image of the wrong thing, and neither the UI nor the ComfyUI log says a field was
 * substituted. Rules that fail silently get asserted, not eyeballed.
 */

/**
 * Fields a character may override.
 *
 * Deliberately short. Everything else a checkpoint implies — sampler, scheduler, steps, CFG — can
 * be hardcoded in the workflow JSON, which is per-character now and is the natural home for values
 * that only make sense for one graph. Adding them here would create two places to set one thing.
 */
export const OVERRIDE_FIELDS = Object.freeze(['model', 'comfy_workflow']);

/** Stored value meaning "inherit the global setting". Empty so it is a real `<option>` value. */
export const INHERIT = '';

/**
 * Resolve the effective generation settings for one request.
 *
 * PURE. Every layer is an argument and `global` is never mutated — the returned object is a fresh
 * copy. That matters beyond tidiness: `setTypeSpecificDimensions()` and `generateMediaSwipe()` both
 * mutate `extension_settings.sd` in place and restore it in a `finally`, so a second generation
 * fired mid-flight can move width, height or seed under the first one. Snapshotting at resolve time
 * means an in-flight request keeps the values it was started with.
 *
 * @param {object} params
 * @param {object} params.global Global extension settings. Not mutated.
 * @param {object|null} [params.character] Per-character overrides, e.g. `{ model, comfy_workflow }`.
 * @param {Record<string, string[]>} [params.available] Values the backend currently offers, per
 * field. Absent or empty means "not loaded yet" — never "nothing is valid". See below.
 * @param {string[]} [params.commandFields] Fields an explicit one-shot slash argument set for this
 * generation. The character must not override these — see below.
 * @returns {{settings: object, fallbacks: Array<{field: string, requested: string}>}} The effective
 * settings, and any override that was dropped because the backend does not have it.
 */
export function resolveImageOverrides({ global, character = null, available = {}, commandFields = [] }) {
    const settings = { ...global };
    const fallbacks = [];
    const explicit = new Set(commandFields);

    for (const field of OVERRIDE_FIELDS) {
        // 🔴 A ONE-SHOT SLASH ARGUMENT OUTRANKS THE CHARACTER. `/imagine model=X` is the user naming
        // a checkpoint for this generation and nothing else; letting the card win would silently
        // ignore what they typed. Upstream's `applyCommandArguments()` has already written the
        // argument into the global (and restores it afterwards), so `settings` already carries the
        // right value — skipping the field here is what honours it.
        if (explicit.has(field)) {
            continue;
        }

        const requested = character?.[field];

        if (typeof requested !== 'string' || requested === INHERIT) {
            continue;
        }

        const known = available[field];

        // ⚠️ An empty list means the fetch has not landed, NOT that every value is invalid. The
        // model list comes from ComfyUI asynchronously, so a generation fired during startup or
        // straight after a reconnect would otherwise drop a perfectly good override and toast about
        // it. Validate only against a list that actually has contents.
        if (Array.isArray(known) && known.length > 0 && !known.includes(requested)) {
            fallbacks.push({ field, requested });
            continue;
        }

        settings[field] = requested;
    }

    return { settings, fallbacks };
}

/**
 * Build the option list for a per-character override dropdown.
 *
 * 🔴 THE SYNTHETIC OPTION IS NOT COSMETIC — WITHOUT IT THE SAVED VALUE ERASES ITSELF. The model
 * list is fetched from the backend, so at the moment a chat opens the `<select>` may be empty or
 * stale. A `<select>` whose value is not among its options reports the *first* option instead, and
 * the change handler then persists that back over the real setting. One chat switch before the
 * fetch lands and the character's checkpoint is silently gone. Rendering the saved value as its own
 * option keeps the control honest until the real list arrives.
 *
 * @param {object} params
 * @param {Array<string|{value: string, text?: string}>} [params.values] Live backend values.
 * @param {string} [params.saved] Currently stored value for this character.
 * @param {string} [params.inheritLabel] Label for the sentinel option.
 * @returns {Array<{value: string, text: string, missing: boolean}>} Options, sentinel first.
 */
export function buildOverrideOptions({ values = [], saved = INHERIT, inheritLabel = '(use global)' }) {
    const options = [{ value: INHERIT, text: inheritLabel, missing: false }];

    for (const entry of values) {
        const value = typeof entry === 'string' ? entry : String(entry?.value ?? '');
        const text = typeof entry === 'string' ? entry : String(entry?.text || entry?.value || '');

        // The sentinel owns the empty value. Some sources emit a placeholder option with an empty
        // value of their own (`N/A` on RunPod, `<Enter Model ID above>` on HuggingFace); letting one
        // through would give the list two entries meaning "inherit" and make selection ambiguous.
        if (value === INHERIT) {
            continue;
        }

        options.push({ value, text, missing: false });
    }

    if (saved !== INHERIT && !options.some(option => option.value === saved)) {
        options.push({ value: saved, text: `${saved} — not found`, missing: true });
    }

    return options;
}

/** Human-readable field names for the fallback toast. */
const FIELD_LABELS = Object.freeze({
    model: 'model',
    comfy_workflow: 'workflow',
});

/**
 * Message for the one toast a dropped override is allowed to produce.
 *
 * ⚠️ Once per chat session, never once per generation — image swipes re-enter the generation path
 * and would turn a single bad card into a wall of identical toasts.
 *
 * @param {Array<{field: string, requested: string}>} fallbacks Dropped overrides.
 * @returns {string} Toast body, or an empty string when nothing was dropped.
 */
export function describeFallbacks(fallbacks) {
    if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
        return '';
    }

    const parts = fallbacks.map(({ field, requested }) => `${FIELD_LABELS[field] ?? field} "${requested}"`);
    return `This character asks for ${parts.join(' and ')}, which the connected backend does not have. Using the global setting instead.`;
}

/**
 * The tunables a user can see and change, and the rules that keep them safe to change.
 *
 * ## 🔴 Why this exists
 *
 * These settings expose model- and context-dependent limits without requiring a code change for each
 * deployment. Their defaults are initial values; operators can inspect and tune them for their backend and
 * context budget.
 *
 * ## 🔴 The one constraint that shapes everything here: the reservation is declared ONCE
 *
 * `reservesTokens` is the prompt space Mnemosyne promises the fork it will not exceed when it injects
 * recalled memories, and it is declared in `context.onPrompt(...)` at plugin **init** — before any user has
 * logged in, let alone loaded settings. So a per-user `maxLength` or `retrievalK` cannot move it.
 *
 * The declaration must therefore cover the WORST CASE THE SCHEMA ALLOWS, not the current value: see
 * {@link declaredReserveTokens}. That is why the `max` on those two fields is a real design decision rather
 * than a generous guess — raise them and every user pays the reservation, in chat history the client trims
 * to make the room, whether or not they ever turn the knob up.
 *
 * ## What is deliberately NOT here
 *
 * The similarity thresholds (`duplicateCosine`, `supersedeCosine`) and `minLength`. They are not
 * preferences; they decide whether a memory REPLACES or sits beside another, and whether a true fact is
 * discarded for ever. A wrong value corrupts the store quietly rather than producing a visibly bad result,
 * which is exactly the kind of knob a user cannot evaluate by looking. Scoping is absent for the stronger
 * reason given in `config.js`.
 */

import { INGEST_DEFAULTS, MEMORY_DEFAULTS } from './config.js';
import { DEFAULT_EXTRACTION_TEMPLATE, INDEX_MAX } from './ingest/extraction.js';

/**
 * Characters per token, measured on GLM-Steam-106B-A12B for Latin-script prose.
 *
 * ⚠️ The same assumption `reservesTokens` has always carried, restated here because {@link declaredReserveTokens}
 * is now what spends it. A denser script (CJK especially) tokenizes past this, and `context` exposes no
 * `countTokens` for us to check against — so the margin below is doing real work, not rounding.
 */
const MEASURED_CHARS_PER_TOKEN = 4.673;

/**
 * The injected block's own scaffolding, in characters: the heading, and the `\n- ` that opens each memory.
 *
 * 🔴 A COPY OF A NUMBER THAT LIVES IN `retrieval.js`, AND THE TEST IS WHAT MAKES THAT SAFE. It cannot be
 * imported — `retrieval.js` imports THIS module, so the arrow only goes one way — so `tests/plugin.test.js`
 * asserts `BLOCK_HEADER.length === BLOCK_HEADER_CHARS` and fails the suite if the wording ever changes
 * without this following it.
 *
 * ⚠️ It said 42 for a five-memory block. The header alone is 123, so the reservation was 96 characters short
 * of the block it reserves for — hidden by the 10% margin below, and by `renderBlock` trimming a memory to
 * fit rather than overrunning.
 */
export const BLOCK_HEADER_CHARS = 123;

/** `'\n- '`, once per memory. See {@link BLOCK_HEADER_CHARS}. */
export const BLOCK_BULLET_CHARS = 3;

/** The fork refuses a per-registration reservation above this, loudly, at registration time. */
const FORK_RESERVATION_CEILING = 8192;

/**
 * One editable setting.
 *
 * @typedef {object} SettingField
 * @property {string} key             The `INGEST_DEFAULTS`/`MEMORY_DEFAULTS` name it overrides
 * @property {string} label           What the panel calls it
 * @property {string} tooltip         What it does, in the user's terms — shown on hover
 * @property {number} min
 * @property {number} max
 * @property {number} fallback        The built-in default
 * @property {string} unit            Rendered after the input
 * @property {string} [note]          A consequence worth stating next to the field
 */

/**
 * Every knob, in the order the panel shows them: what a memory IS, then how many are recalled, then how
 * often extraction runs.
 *
 * 🔴 **`max` on `maxLength` and `retrievalK` is load-bearing** — see {@link declaredReserveTokens}. Changing
 * either changes the reservation declared to the fork for every user on the install.
 *
 * @type {readonly SettingField[]}
 */
export const SETTINGS_SCHEMA = Object.freeze([
    {
        key: 'maxLength',
        label: 'Memory size',
        tooltip: 'How long a single memory may be. This is a ceiling, not a target — but it is also what '
            + 'the extractor is told, so a small value produces short memories. Too small and you get '
            + '"Test User talked with Test Character 1 about sailing", which tells a future chat nothing. A memory longer '
            + 'than this is cut off at the limit and still stored, and the log says so.',
        min: 200, max: 3000, fallback: INGEST_DEFAULTS.maxLength, unit: 'characters',
        note: 'Raising this and "Memories recalled per reply" together is what costs prompt space.',
    },
    {
        key: 'retrievalK',
        label: 'Memories recalled per reply',
        tooltip: 'How many stored memories are searched out and injected into each reply. More memories '
            + 'means more context for the character and less room for the conversation itself.',
        min: 1, max: 6, fallback: MEMORY_DEFAULTS.retrievalK, unit: 'memories',
    },
    {
        key: 'maxMemories',
        label: 'Memories asked for per pass',
        tooltip: 'How many memories one extraction asks the model for. Asking for a limit makes the model '
            + 'rank rather than dump everything it noticed — but if it returns more anyway, they are kept.',
        min: 1, max: 12, fallback: INGEST_DEFAULTS.maxMemories, unit: 'memories',
    },
    {
        key: 'firstPassMessages',
        label: 'First extraction after',
        tooltip: 'How many messages a NEW chat must reach before memory runs for the first time. Lower '
            + 'catches the opening of a story, which the regular interval can never go back for.',
        min: 2, max: 40, fallback: INGEST_DEFAULTS.firstPassMessages, unit: 'messages',
    },
    {
        key: 'triggerMessages',
        label: 'Then every',
        tooltip: 'How many new messages accumulate before memory runs again. Lower means more memories '
            + 'and more calls to your model; higher means cheaper and coarser.',
        // 🔴 BOUNDED BY THE WINDOW, NOT PICKED. This was `60` against a `windowMax` of 40 and a declared
        // fork window of 50, and BOTH excesses were silent:
        //
        //   • above `windowMax` (40) — the gate waits for, say, 45 fresh turns, `windowSlice` then hands the
        //     extractor only the newest 40 of them, and `advance()` marks the mark to the LAST index in the
        //     window. The five oldest turns are declared extracted having never been read. Permanent,
        //     invisible memory loss on every single pass.
        //   • above the declared window (50) — `fresh.length` saturates at 50, so `fresh >= needed` is never
        //     true. Ingest fires once on `firstPassMessages` and then never again, logging
        //     "50/55 fresh turns — waiting." for ever.
        //
        // Neither was reported anywhere, and the tooltip presents the knob as a cost/coarseness trade. So the
        // maximum is DERIVED from the window rather than written down beside it: `windowMax` is the largest
        // interval whose every turn the extractor actually sees, and a setting the engine cannot honor is
        // not a setting. Tune `windowMax` and this follows it instead of quietly going back out of range.
        min: 2, max: INGEST_DEFAULTS.windowMax, fallback: INGEST_DEFAULTS.triggerMessages, unit: 'messages',
    },
    {
        key: 'existingContextK',
        label: 'Known memories shown to the extractor',
        tooltip: 'How many already-stored memories the extractor is shown so it does not repeat them. '
            + 'More reduces duplicates and makes the extraction prompt longer.',
        min: 0, max: 60, fallback: INGEST_DEFAULTS.existingContextK, unit: 'memories',
    },
    {
        key: 'extractCeilingTokens',
        label: 'Extraction token ceiling',
        tooltip: 'The most tokens one extraction may generate. This is a RUNAWAY GUARD, not a budget: a '
            + 'reasoning model spends most of it thinking before it answers, and that thinking is billed '
            + 'here but never shown to the plugin. Set it too low and the model runs out mid-thought and '
            + 'returns nothing at all.',
        min: 500, max: 32000, fallback: INGEST_DEFAULTS.extractCeilingTokens, unit: 'tokens',
        note: 'DeepSeek-V4-Pro measured 1,487 tokens on a five-message window, of which the answer was 484 characters.',
    },
]);

/**
 * `INGEST_DEFAULTS` with the settable numbers widened.
 *
 * ⚠️ **`INGEST_DEFAULTS` IS FROZEN, SO ITS NUMBERS ARE LITERAL TYPES** — `maxLength` is the type `1500`, not
 * `number`. That is a real property worth keeping for the constants (a typo assigning 150 to a default is a
 * compile error), and it is exactly wrong for the runtime object, whose whole purpose is that a user chose
 * those values. So the settable keys are widened here, by name, and everything else keeps the literal type
 * it had. Widening the whole object with `Record<string, number>` would have been shorter and would have
 * thrown away `confirmUncertain`'s boolean along with it.
 *
 * @typedef {Omit<typeof INGEST_DEFAULTS, 'maxLength'|'maxMemories'|'firstPassMessages'|'triggerMessages'|'existingContextK'|'extractCeilingTokens'|'extractMaxTokens'> & {
 *   maxLength: number,
 *   maxMemories: number,
 *   firstPassMessages: number,
 *   triggerMessages: number,
 *   existingContextK: number,
 *   extractCeilingTokens: number,
 *   extractMaxTokens: number,
 * }} RuntimeIngestDefaults
 */

/** @type {Map<string, SettingField>} */
const BY_KEY = new Map(SETTINGS_SCHEMA.map(f => [f.key, f]));

/**
 * The reservation to declare to the fork at init — sized for the worst case the schema PERMITS.
 *
 * 🔴 **NOT the current settings, and that is the whole point.** The declaration happens once, at plugin
 * init, before any user's store is open. If it tracked a user's current value it would be a promise made on
 * behalf of settings nobody has loaded yet, and the first user to raise `maxLength` would silently break it —
 * which caused the original overrun (the block overruns, KoboldCpp discards from the front, and
 * `noteInjection` still records `active: true`).
 *
 * ⚠️ It is checked against the fork's ceiling here rather than discovered at registration, because a
 * registration failure is a plugin that does not load at all.
 *
 * ## 🔴 The current reserve is 4,254 tokens; the previous flat reserve was 550
 *
 * The fork spends this on EVERY generation whether or not
 * anything is injected (`public/script.js` subtracts `getReservedPromptTokens()` from the context window), so
 * a user on stock defaults — whose real worst-case block is about 1,780 tokens — pays 4,254.
 *
 * It stays, because the alternative is worse in the direction that matters. The declaration cannot track a
 * per-user value (see above), so the only lever is the schema's maxima, and lowering those does not save the
 * tokens — it removes the settings range from every user in order to save them. Narrowing the configured range to
 * recover prompt space would reduce capacity for every user, even when the extra reserve is not needed.
 *
 * ⚠️ **WHAT WOULD CHANGE IT, so the next reader has a test rather than an opinion:** a context window small
 * enough that 4,254 tokens is a large fraction of it. On an 8K-context local model with a 400-token response
 * budget the prompt drops to roughly 3,500 tokens, which is the fork's own "no history and no error" symptom.
 * If that install ever matters, `maxLength.max: 2000` with `retrievalK.max: 5` brings the declaration to
 * 2,370 — one edit to {@link SETTINGS_SCHEMA}, no code change, and fully reversible. Nothing here is load
 * bearing on the current number; it is a config value, and it is written down rather than guarded.
 *
 * @returns {number} tokens
 */
export function declaredReserveTokens() {
    const maxLen = /** @type {SettingField} */ (BY_KEY.get('maxLength')).max;
    const maxK = /** @type {SettingField} */ (BY_KEY.get('retrievalK')).max;

    // The block's own scaffolding: the heading, and the `\n- ` that opens each bullet.
    //
    // ⚠️ MEASURED FROM `renderBlock`, NOT ESTIMATED. This said "measured at 42 characters for a 5-memory
    // block", and the header alone is 123 — the real 5-memory scaffold is 138. The reservation was therefore
    // 96 characters short of the block it reserves for, hidden the whole time by the 10% margin below and by
    // `renderBlock` quietly trimming a memory to fit rather than overrunning. Both halves are now honest: the
    // render charges only text against the text budget, and this counts the scaffolding it actually adds.
    const scaffold = BLOCK_HEADER_CHARS + maxK * BLOCK_BULLET_CHARS;
    const tokens = Math.ceil((maxK * maxLen + scaffold) / MEASURED_CHARS_PER_TOKEN);

    // A 10% margin for a script that tokenizes denser than the measurement. See MEASURED_CHARS_PER_TOKEN.
    const declared = Math.ceil(tokens * 1.1);

    if (declared > FORK_RESERVATION_CEILING) {
        throw new Error(
            `Mnemosyne: the settings schema permits a recall block of ${declared} tokens, above the fork's `
            + `per-registration ceiling of ${FORK_RESERVATION_CEILING}. Lower the max on maxLength or `
            + 'retrievalK in SETTINGS_SCHEMA — this is a design decision, not a runtime condition.',
        );
    }

    return declared;
}

/**
 * The built-in value of every setting — what a user who has never opened the panel is running.
 *
 * @returns {Record<string, number>}
 */
export function defaultSettings() {
    return Object.fromEntries(SETTINGS_SCHEMA.map(f => [f.key, f.fallback]));
}

/**
 * Fold a candidate settings object onto the defaults, keeping only what is valid.
 *
 * 🔴 **CLAMPS AND DROPS RATHER THAN THROWING, AND NEVER PARTIALLY APPLIES.** This reads two untrusted
 * sources — a form post and a stored preset written by an older version — and the failure that matters is a
 * store left running on half a settings object. An unknown key is dropped, an unparseable or out-of-range
 * value falls back to the built-in default for that field, and the result is always complete.
 *
 * ⚠️ Out-of-range CLAMPS rather than falling back, because a user dragging a number past the maximum means
 * "as high as it goes", and silently resetting them to the default would look like the setting was ignored.
 * A value that is not a number at all is a different thing — that is corruption, and it takes the default.
 *
 * @param {unknown} raw
 * @returns {Record<string, number>} a complete, valid settings object
 */
export function coerceSettings(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
    /** @type {Record<string, number>} */
    const out = {};

    for (const field of SETTINGS_SCHEMA) {
        // 🔴 CHECK THE TYPE BEFORE `Number()`, BECAUSE `Number()` INVENTS ZEROS. `Number(null)`, `Number([])`
        // and `Number('')` are all 0 — finite, in range after clamping, and therefore indistinguishable from a
        // user who typed 0. A stored `null` would have silently become `min` on every field: `maxLength` 200,
        // `retrievalK` 1. That is corruption reading as intent, which is the one thing this function exists to
        // prevent, and it is exactly what the docblock above promises does not happen.
        const raw = source[field.key];
        const value = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
            ? Number(raw)
            : Number.NaN;

        out[field.key] = Number.isFinite(value)
            ? Math.min(field.max, Math.max(field.min, Math.round(value)))
            : field.fallback;
    }

    return out;
}

/**
 * The settings, expressed the way the rest of the code already reads its numbers.
 *
 * 🔴 **A TRANSLATION LAYER, ON PURPOSE.** Ingest reads `defaults.triggerMessages` and retrieval reads
 * `retrievalK`; the panel shows "Never more often than … seconds". Converting here means the units the user
 * sees are chosen for the user, and no call site has to know that the stored form differs.
 *
 * @param {Record<string, number>} settings
 * @returns {{ingest: RuntimeIngestDefaults, retrievalK: number}}
 */
export function asRuntimeDefaults(settings) {
    const s = coerceSettings(settings);

    return {
        ingest: {
            ...INGEST_DEFAULTS,
            maxLength: s.maxLength,
            maxMemories: s.maxMemories,
            firstPassMessages: s.firstPassMessages,
            triggerMessages: s.triggerMessages,
            existingContextK: s.existingContextK,
            extractCeilingTokens: s.extractCeilingTokens,
            // 🔴 DERIVED, NEVER SET DIRECTLY. `extractMaxTokens` is what `parseExtraction` measures a reply
            // against to decide whether the last line was clipped, so it has to track what a full answer
            // actually is: `maxMemories` statements of `maxLength` plus their tags. Exposing it as its own
            // knob would let a user set an answer budget that disagrees with the memories they asked for,
            // and the symptom — good final memories silently dropped as truncated — would be unattributable.
            //
            // 🔴 **AND A LINE IS NOT JUST TAG + STATEMENT ANY MORE.** Since the index line shipped, every line
            // the grammar and the prompt ask for is `[tag] statement || <index>`, where the index may run to
            // `INDEX_MAX`. The `+ 24` covered the tag and the newline and nothing else, so this derivation
            // under-sized a legal answer by `maxMemories × 204` characters — at the shipped defaults it
            // produced 1957 where the constant it replaced was 2400, and `looksGuillotined` then tripped at
            // 7,818 characters against an answer the grammar permits to reach ~10,300. A dense pass lost its
            // last complete memory and advanced past the window for good. `+ 4` is the ` || ` itself.
            //
            // ⚠️ **CLAMPED TO THE WIRE CEILING, because a budget above it can never be reached.** A reply is
            // cut off at `extractCeilingTokens`, so measuring it against a LARGER number means `nearCeiling`
            // is false however brutally the model was truncated — and a half-sentence then clears `minLength`
            // and is stored as a durable fact. `extractCeilingTokens` goes down to 500 while this derivation
            // defaults to nearly 2,600, so the guard was disabled outright for anyone who lowered the ceiling
            // the tooltip presents as a harmless runaway guard.
            extractMaxTokens: Math.min(
                Math.ceil((s.maxMemories * (s.maxLength + 24 + 4 + INDEX_MAX)) / MEASURED_CHARS_PER_TOKEN),
                s.extractCeilingTokens,
            ),
        },
        retrievalK: s.retrievalK,
    };
}

/** The `meta` key the settings object lives under. */
export const SETTINGS_KEY = 'settings';

/** The `meta` key the named presets live under. */
export const PRESETS_KEY = 'settings_presets';

/**
 * This user's settings, complete and valid, whatever is actually in the store.
 *
 * ⚠️ Read per call rather than cached. It is one indexed point query on an already-open database, against a
 * path that is about to do an embedding or a completion — and a cache here would need invalidating from the
 * settings route, which is a second thing to get wrong for no measurable gain.
 *
 * @param {{getMetaJson: (key: string) => unknown}} store
 * @returns {Record<string, number>}
 */
export function readSettings(store) {
    return coerceSettings(store.getMetaJson(SETTINGS_KEY));
}

/**
 * Merge a patch over the current settings and persist the result.
 *
 * ⚠️ A PATCH, not a replacement: the panel posts only the fields its form carries, and a future version that
 * adds a field must not blank it for everyone who saves from an older form.
 *
 * @param {{getMetaJson: (key: string) => unknown, setMetaJson: (key: string, value: unknown) => void}} store
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, number>} the settings as they now stand
 */
export function writeSettings(store, patch) {
    const merged = coerceSettings({ ...readSettings(store), ...patch });
    store.setMetaJson(SETTINGS_KEY, merged);

    return merged;
}

/**
 * The saved presets, newest name order preserved, as `{name, settings}` rows.
 *
 * 🔴 **A LIST, NOT A MAP, BECAUSE ORDER IS THE USER'S.** They named these; showing them back in an order the
 * runtime chose (insertion hash, alphabetical) makes a list of your own labels feel like someone else's.
 *
 * ⚠️ `builtIn` marks the one row that is not the user's: it is synthesized on every read and cannot be
 * saved over or deleted. Callers that MUTATE the list must use `storedPresets` instead — see its note.
 *
 * @param {{getMetaJson: (key: string) => unknown}} store
 * @returns {Array<{name: string, settings: Record<string, number>, template: string, builtIn: boolean}>}
 */
export function readPresets(store) {
    // 🔴 THE BUILT-IN IS FIRST AND IS NOT ONE OF THE STORED ROWS. See {@link builtInPreset}.
    return [builtInPreset(), ...storedPresets(store)];
}

/**
 * The name reserved for the built-in preset. Case-insensitive: a user cannot save `Default` either.
 * @type {string}
 */
export const DEFAULT_PRESET_NAME = 'default';

/**
 * Whether a name is the reserved one, however it was typed or spaced.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isDefaultPreset(name) {
    return String(name ?? '').trim().toLowerCase() === DEFAULT_PRESET_NAME;
}

/**
 * The always-present, never-editable preset: the shipped defaults, exactly as a fresh install runs them.
 *
 * 🔴 **SYNTHESIZED, NEVER STORED, AND THAT IS WHAT MAKES IT READ-ONLY.** A row written into `meta` would be a
 * row something can overwrite — `savePreset` under the same name, a hand-edited store, a future migration —
 * and "read-only" would then be a rule three call sites have to remember rather than a property of the data.
 * Built from {@link defaultSettings} on every read, it cannot drift from the shipped defaults, cannot be
 * damaged, and survives anything: a `clearMemories`, a corrupted `meta`, a brand-new store on a fresh install.
 * There is nothing to back up and nothing to restore.
 *
 * ⚠️ **Its template is `''`, which means "track the built-in prompt" — not "a copy of today's prompt".** So
 * rolling back to it puts the user on the shipped wording *including future improvements to it*, which is the
 * same distinction {@link readPromptTemplate} makes and for the same reason. A preset that froze a verbatim
 * copy would quietly pin them to this version's prompt for ever.
 *
 * @returns {{name: string, settings: Record<string, number>, template: string, builtIn: boolean}}
 */
function builtInPreset() {
    return { name: DEFAULT_PRESET_NAME, settings: defaultSettings(), template: '', builtIn: true };
}

/**
 * The user's own saved presets — the stored rows alone, without the built-in.
 *
 * 🔴 **EVERY WRITE PATH USES THIS, NEVER {@link readPresets}.** `savePreset` and `deletePreset` rebuild the
 * stored list from what they read; reading a list with the synthetic default in it would persist the default
 * into `meta` on the next save, which is precisely how a read-only thing stops being read-only.
 *
 * @param {{getMetaJson: (key: string) => unknown}} store
 * @returns {Array<{name: string, settings: Record<string, number>, template: string, builtIn: boolean}>}
 */
function storedPresets(store) {
    const raw = store.getMetaJson(PRESETS_KEY);

    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .filter(row => row && typeof row === 'object' && typeof row.name === 'string' && row.name.trim() !== '')
        // ⚠️ A stored row named `default` is dropped rather than shown beside the built-in. One can exist —
        // saved before the built-in did, or written by hand — and two rows with one name give the user two
        // Load buttons that do different things and no way to tell which is which.
        .filter(row => !isDefaultPreset(row.name))
        .map(row => ({
            name: String(row.name).slice(0, 60),
            settings: coerceSettings(row.settings),
            // ⚠️ A preset written before v1.0's prompt editor has no `template`, and `''` is the right reading
            // of that: it means "this preset does not override the prompt", which is exactly what those
            // presets did. Loading one must not silently blank an override the user set separately — see
            // applyPreset for where that distinction is actually spent.
            template: typeof row.template === 'string' ? row.template.slice(0, PROMPT_MAX_CHARS) : '',
            builtIn: false,
        }));
}

/**
 * Save the given settings under a name, replacing a preset of the same name.
 *
 * ⚠️ Replace-by-name rather than refuse-if-exists: "save" on a name you already have means "update it", and
 * a preset is a convenience the user can rebuild in seconds, so a confirmation dialog would cost more than
 * the mistake.
 *
 * @param {{getMetaJson: (key: string) => unknown, setMetaJson: (key: string, value: unknown) => void}} store
 * @param {string} name
 * @param {Record<string, unknown>} settings
 * @param {string} [template] The prompt override to capture with it, `''` for "does not override the prompt"
 * @returns {Array<{name: string, settings: Record<string, number>, template: string, builtIn: boolean}>} the presets as they now stand, built-in first
 */
export function savePreset(store, name, settings, template = '') {
    const clean = String(name ?? '').trim().slice(0, 60);

    // 🔴 THE RESERVED NAME IS REFUSED HERE, NOT ONLY AT THE ROUTE. This is the function that writes, and a
    // rule enforced only in the HTTP layer is one that any other caller — a future panel action, a test, an
    // import — walks straight past. `default` is the one thing in this list a user can always fall back to;
    // it stops being that the moment it can be overwritten with their current numbers.
    if (!clean || isDefaultPreset(clean)) {
        return readPresets(store);
    }

    const rows = storedPresets(store).filter(row => row.name !== clean);
    // 🔴 THE PROMPT TRAVELS WITH THE NUMBERS, because they are one setting in every way that matters. A
    // 1.6T reasoning model and a small local one want different memory sizes AND different wording — telling
    // a weak model to write "a substantial paragraph" produces padding, not detail. A preset that restored
    // the numbers and left the prompt behind would be the half of the switch that is easy to implement and
    // useless in practice.
    rows.push({
        name: clean, settings: coerceSettings(settings), builtIn: false,
        template: typeof template === 'string' ? template.slice(0, PROMPT_MAX_CHARS) : '',
    });
    // ⚠️ `builtIn` is DERIVED, so it is not persisted. Writing it would put a field in `meta` that the reader
    // recomputes anyway — and a stored `builtIn: true` is the one value that could make a user's own row
    // claim to be the protected one.
    store.setMetaJson(PRESETS_KEY, rows.map(({ name: n, settings: s, template: t }) => ({ name: n, settings: s, template: t })));

    return readPresets(store);
}

/**
 * Delete a preset by name. Unknown names are a no-op, not an error — the button that sends this is rendered
 * from a list that may be one request out of date.
 *
 * @param {{getMetaJson: (key: string) => unknown, setMetaJson: (key: string, value: unknown) => void}} store
 * @param {string} name
 * @returns {Array<{name: string, settings: Record<string, number>, template: string, builtIn: boolean}>} the presets as they now stand, built-in first
 */
export function deletePreset(store, name) {
    // 🔴 The built-in cannot be deleted, and the write is skipped entirely rather than filtered — it is not
    // in the stored list to remove, so a delete of it must not rewrite `meta` at all.
    if (isDefaultPreset(name)) {
        return readPresets(store);
    }

    const rows = storedPresets(store).filter(row => row.name !== String(name ?? '').trim());
    store.setMetaJson(PRESETS_KEY, rows);

    return readPresets(store);
}

/** The `meta` key the user's extraction-prompt template lives under. */
export const PROMPT_KEY = 'extraction_template';

/**
 * The largest template we will store.
 *
 * ⚠️ A ceiling rather than a policy: the template is sent to the model on every extraction, so a runaway
 * paste costs prompt budget on every pass for ever. Generous enough that the built-in default (about 3,900
 * characters rendered) can be edited substantially without hitting it.
 */
export const PROMPT_MAX_CHARS = 20000;

/**
 * This user's extraction template, or `''` meaning "use the built-in".
 *
 * 🔴 **EMPTY IS A REAL ANSWER, NOT A MISSING ONE.** "Never opened the settings" and "edited it and then reset
 * to default" are the same state deliberately: both should run the shipped prompt, and storing a copy of the
 * default for the second case would freeze it — a user who reset in v1.0 would still be running v1.0's prompt
 * after the default improved, with nothing to tell them.
 *
 * @param {{getMetaJson: (key: string) => unknown}} store
 * @returns {string}
 */
export function readPromptTemplate(store) {
    const raw = store.getMetaJson(PROMPT_KEY);

    return typeof raw === 'string' ? raw.slice(0, PROMPT_MAX_CHARS) : '';
}

/**
 * Save an extraction template. Anything blank clears it back to the built-in.
 *
 * ⚠️ **No validation of the CONTENT, on purpose.** A template that omits the format instructions will produce
 * unparseable output, and that is the user's business — this is the prompt, the whole point is that they can
 * change it, and a plugin that rejected prompts it did not recognize would be pretending to know better. The
 * panel warns; the store obeys. What IS enforced is the length, because that is a cost the user cannot see.
 *
 * @param {{setMetaJson: (key: string, value: unknown) => void}} store
 * @param {unknown} template
 * @returns {string} what is now stored
 */
export function writePromptTemplate(store, template) {
    // 🔴 NORMALIZE BEFORE ANYTHING ELSE, BECAUSE A BROWSER DOES NOT SEND BACK WHAT IT WAS GIVEN. The HTML
    // spec has a textarea submit its value with every line break as CRLF, so the default prompt handed to the
    // editor as LF comes back as CRLF — and an exact comparison against the constant below would then MISS,
    // storing a byte-different copy of the default and freezing the user on it. That is the precise failure
    // the comparison exists to prevent, arriving through the one path that actually matters: the real UI.
    // Caught by driving the live panel, not by any test.
    const raw = typeof template === 'string' ? template : '';
    const clean = raw.replace(/\r\n/g, '\n').slice(0, PROMPT_MAX_CHARS);

    // 🔴 SAVING THE DEFAULT UNCHANGED STORES NOTHING, AND THAT IS THE WHOLE REASON THE PANEL CAN SHOW IT.
    // The editor opens with the built-in prompt visible. Saving it unchanged stores no override, so future
    // improvements to the shipped default continue to apply.
    const stored = clean.trim() === '' || clean === DEFAULT_EXTRACTION_TEMPLATE ? '' : clean;
    store.setMetaJson(PROMPT_KEY, stored);

    return stored;
}

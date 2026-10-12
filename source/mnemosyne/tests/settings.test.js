/**
 * The settings module: what a user is allowed to change, what happens when the stored value is wrong, and
 * the one invariant that reaches outside this file.
 *
 * 🔴 **The reservation tests are the important ones.** Everything else here is clamping arithmetic. The
 * reservation is a promise made to the fork ONCE at init, on behalf of settings no user has loaded yet, and
 * breaking it does not throw — the injected block overruns, the backend discards from the front, and
 * `noteInjection` still records `active: true`. So it fails as memories that silently never arrive.
 */

import { describe, test, expect } from '@jest/globals';

import { INGEST_DEFAULTS, MEMORY_DEFAULTS } from '../src/config.js';
import { DEFAULT_EXTRACTION_TEMPLATE, INDEX_MAX } from '../src/ingest/extraction.js';
import {
    DEFAULT_PRESET_NAME,
    PRESETS_KEY,
    SETTINGS_SCHEMA,
    asRuntimeDefaults,
    coerceSettings,
    declaredReserveTokens,
    defaultSettings,
    deletePreset,
    readPresets,
    readSettings,
    savePreset,
    writeSettings,
    readPromptTemplate,
    writePromptTemplate,
    PROMPT_MAX_CHARS,
} from '../src/settings.js';

/** A store that is just the two meta methods, because that is all settings.js is allowed to touch. */
function fakeStore(initial = {}) {
    const meta = new Map(Object.entries(initial));

    return {
        // Faithful to the real `Store#getMetaJson`, which catches a parse failure and returns null — see the
        // 🔴 on that method for why unreadable and absent are deliberately the same answer. A fake that threw
        // here would be testing the fake.
        getMetaJson: (/** @type {string} */ key) => {
            if (!meta.has(key)) {
                return null;
            }
            try {
                return JSON.parse(/** @type {string} */ (meta.get(key)));
            } catch {
                return null;
            }
        },
        setMetaJson: (/** @type {string} */ key, /** @type {unknown} */ value) => meta.set(key, JSON.stringify(value)),
        /** Test-only: what is actually on "disk", so a round-trip is checked through the serialization. */
        _raw: meta,
    };
}

const field = (/** @type {string} */ key) => /** @type {{key: string, min: number, max: number, fallback: number}} */ (
    SETTINGS_SCHEMA.find(f => f.key === key)
);

/**
 * The user's OWN presets. `readPresets` returns the built-in `default` first, and the preset tests below were
 * written about the rows a user saves.
 *
 * ⚠️ Filtering rather than stitching `'default'` into every expectation on purpose: those tests are about
 * saving, replacing, coercing and deleting, and threading a constant through all of them would blur what each
 * one actually asserts. The built-in has its own tests, where it is the subject rather than a fixture.
 *
 * @param {Parameters<typeof readPresets>[0]} store
 * @returns {ReturnType<typeof readPresets>}
 */
const mine = store => readPresets(store).filter(p => !p.builtIn);

describe('the schema itself', () => {
    test('every field carries a tooltip, because a knob nobody understands is not a setting', () => {
        for (const f of SETTINGS_SCHEMA) {
            expect(typeof f.tooltip).toBe('string');
            // Long enough to be an explanation rather than a restatement of the label.
            expect(f.tooltip.length).toBeGreaterThan(40);
            expect(f.label).not.toBe('');
            expect(f.unit).not.toBe('');
        }
    });

    test('every default sits inside its own range', () => {
        for (const f of SETTINGS_SCHEMA) {
            expect(f.min).toBeLessThan(f.max);
            expect(f.fallback).toBeGreaterThanOrEqual(f.min);
            expect(f.fallback).toBeLessThanOrEqual(f.max);
        }
    });

    test('the defaults are the shipped constants, so an unconfigured user changes nothing', () => {
        const d = defaultSettings();

        expect(d.maxLength).toBe(INGEST_DEFAULTS.maxLength);
        expect(d.maxMemories).toBe(INGEST_DEFAULTS.maxMemories);
        expect(d.retrievalK).toBe(MEMORY_DEFAULTS.retrievalK);
        expect(d.triggerMessages).toBe(INGEST_DEFAULTS.triggerMessages);
    });
});

describe('🔴 the reservation declared to the fork', () => {
    test('covers the largest block the schema PERMITS, not the default one', () => {
        // The same worst case retrieval can build: retrievalK memories of maxLength characters.
        const worstChars = field('retrievalK').max * field('maxLength').max;
        const declaredChars = declaredReserveTokens() * 4.673;

        expect(declaredChars).toBeGreaterThan(worstChars);
    });

    test('stays inside the fork\'s per-registration ceiling, which is refused loudly rather than clamped', () => {
        expect(declaredReserveTokens()).toBeLessThanOrEqual(8192);
    });

    test('⚠️ is bigger than the default-sized block — the point is that it is NOT the current value', () => {
        const defaultChars = defaultSettings().retrievalK * defaultSettings().maxLength;

        expect(declaredReserveTokens() * 4.673).toBeGreaterThan(defaultChars);
    });
});

describe('coercing whatever is actually stored', () => {
    test('an out-of-range value CLAMPS, because dragging past the max means "as high as it goes"', () => {
        expect(coerceSettings({ maxLength: 99999 }).maxLength).toBe(field('maxLength').max);
        expect(coerceSettings({ maxLength: -5 }).maxLength).toBe(field('maxLength').min);
    });

    test('⚠️ but a value that is not a number takes the default — that is corruption, not intent', () => {
        expect(coerceSettings({ maxLength: 'wide' }).maxLength).toBe(field('maxLength').fallback);
        expect(coerceSettings({ maxLength: null }).maxLength).toBe(field('maxLength').fallback);
        expect(coerceSettings({ maxLength: {} }).maxLength).toBe(field('maxLength').fallback);
    });

    test('🔴 the result is always COMPLETE, so no caller can run on half a settings object', () => {
        for (const raw of [null, undefined, 42, 'nonsense', [], { unknownKey: 1 }]) {
            const out = coerceSettings(raw);

            expect(Object.keys(out).sort()).toEqual(SETTINGS_SCHEMA.map(f => f.key).sort());
            expect(Object.values(out).every(Number.isFinite)).toBe(true);
        }
    });

    test('an unknown key is dropped rather than carried', () => {
        expect(coerceSettings({ maxLength: 800, scopeToCharacter: false })).not.toHaveProperty('scopeToCharacter');
    });

    test('a fractional value rounds rather than reaching a consumer as a fraction', () => {
        expect(coerceSettings({ maxMemories: 3.7 }).maxMemories).toBe(4);
    });
});

describe('translating to what the runtime already reads', () => {
    test('🔴 extractMaxTokens is DERIVED from the memories asked for, never set directly', () => {
        const small = asRuntimeDefaults({ ...defaultSettings(), maxMemories: 2, maxLength: 400 });
        const large = asRuntimeDefaults({ ...defaultSettings(), maxMemories: 10, maxLength: 3000 });

        // It is the answer budget parseExtraction measures against, so it has to track what a full answer is.
        expect(large.ingest.extractMaxTokens).toBeGreaterThan(small.ingest.extractMaxTokens);
        expect(small.ingest.extractMaxTokens).toBeGreaterThanOrEqual(Math.ceil((2 * 400) / 4.673));
    });

    test('🔴 the budget covers a WHOLE line — tag AND the index line the grammar now requires', () => {
        // The derivation used to allow `maxLength + 24` for the tag and the newline, and nothing at all for the
        // ` || <index>` that every v5 line carries. `looksGuillotined` then tripped on answers that were
        // complete, and `parseExtraction` popped their last memory — permanently, because the pass advances.
        // The floor here is the honest worst case: every line at maxLength, every index at INDEX_MAX.
        const s = { ...defaultSettings(), maxMemories: 6, maxLength: 1500, extractCeilingTokens: 32000 };
        const worstCaseChars = 6 * (1500 + 24 + 4 + INDEX_MAX);

        expect(asRuntimeDefaults(s).ingest.extractMaxTokens)
            .toBeGreaterThanOrEqual(Math.ceil(worstCaseChars / 4.673));
    });

    test('🔴 the budget never exceeds the wire ceiling, or truncation becomes undetectable', () => {
        // A reply cannot be longer than the ceiling it was generated under, so measuring it against a LARGER
        // number means `nearCeiling` is false however brutally the model was cut off — and a half sentence then
        // clears minLength and is stored as a durable fact. extractCeilingTokens goes down to 500 while the
        // derivation defaults to thousands, so this was disabled outright for anyone who lowered it.
        const starved = asRuntimeDefaults({ ...defaultSettings(), extractCeilingTokens: 800 });

        expect(starved.ingest.extractMaxTokens).toBe(800);
        expect(starved.ingest.extractMaxTokens).toBeLessThanOrEqual(starved.ingest.extractCeilingTokens);
    });

    test('⚠️ the untouched constants survive the spread, including the non-numeric ones', () => {
        const out = asRuntimeDefaults(defaultSettings()).ingest;

        expect(out.confirmUncertain).toBe(INGEST_DEFAULTS.confirmUncertain);
        expect(out.duplicateCosine).toBe(INGEST_DEFAULTS.duplicateCosine);
        expect(out.minLength).toBe(INGEST_DEFAULTS.minLength);
    });
});

describe('persistence, through the store the plugin actually has', () => {
    test('an unwritten store reads as the defaults', () => {
        expect(readSettings(fakeStore())).toEqual(defaultSettings());
    });

    test('🔴 an unreadable or wrong-shaped value reads as the defaults rather than taking memory down', () => {
        // Two different corruptions: bytes the store cannot parse at all (its own guard turns that into null),
        // and valid JSON of the wrong shape, which reaches settings.js intact and is its problem.
        const unparseable = fakeStore();
        unparseable._raw.set('settings', '{ not json');
        expect(readSettings(unparseable)).toEqual(defaultSettings());

        for (const shape of ['a string', 7, [1, 2, 3], true]) {
            const store = fakeStore();
            store._raw.set('settings', JSON.stringify(shape));
            expect(readSettings(store)).toEqual(defaultSettings());
        }
    });

    test('a write is a PATCH — a form that posts one field does not blank the rest', () => {
        const store = fakeStore();
        writeSettings(store, { maxLength: 900 });
        const after = writeSettings(store, { retrievalK: 2 });

        expect(after.maxLength).toBe(900);
        expect(after.retrievalK).toBe(2);
    });

    test('the round trip goes through real serialization', () => {
        const store = fakeStore();
        writeSettings(store, { maxLength: 2222 });

        expect(readSettings(store).maxLength).toBe(2222);
    });
});

describe('presets', () => {
    test('🔴 the built-in `default` is there before anything is saved, and is always first', () => {
        const store = fakeStore();

        expect(readPresets(store).map(p => p.name)).toEqual([DEFAULT_PRESET_NAME]);
        expect(readPresets(store)[0].builtIn).toBe(true);
        expect(readPresets(store)[0].settings).toEqual(defaultSettings());
        // `''` means "track the built-in prompt", not a frozen copy of today's — see readPromptTemplate.
        expect(readPresets(store)[0].template).toBe('');
    });

    test('🔴 it cannot be saved over, and the attempt does not create a stored row', () => {
        const store = fakeStore();

        savePreset(store, DEFAULT_PRESET_NAME, { ...defaultSettings(), maxLength: 2000 });
        savePreset(store, '  DEFAULT  ', { ...defaultSettings(), maxLength: 2000 });

        expect(mine(store)).toEqual([]);
        expect(readPresets(store)[0].settings.maxLength).toBe(defaultSettings().maxLength);
    });

    test('🔴 it cannot be deleted, and deleting it does not disturb the stored list', () => {
        const store = fakeStore();
        savePreset(store, 'Keep me', defaultSettings());

        deletePreset(store, DEFAULT_PRESET_NAME);

        expect(readPresets(store).map(p => p.name)).toEqual([DEFAULT_PRESET_NAME, 'Keep me']);
    });

    test('a stored row named `default` is hidden rather than shown twice', () => {
        // One can exist — written by hand, or saved before the built-in did. Two rows with one name give the
        // user two Load buttons that do different things and no way to tell which is which.
        const store = fakeStore();
        store.setMetaJson(PRESETS_KEY, [{ name: 'default', settings: { maxLength: 999 }, template: 'x' }]);

        expect(readPresets(store).map(p => p.name)).toEqual([DEFAULT_PRESET_NAME]);
        expect(readPresets(store)[0].settings.maxLength).toBe(defaultSettings().maxLength);
    });

    test('save, read back, and delete', () => {
        const store = fakeStore();
        savePreset(store, 'DeepSeek V4 Pro', { ...defaultSettings(), maxLength: 2000 });
        savePreset(store, 'Local Kobold', { ...defaultSettings(), maxLength: 400 });

        expect(mine(store).map(p => p.name)).toEqual(['DeepSeek V4 Pro', 'Local Kobold']);
        expect(mine(store)[0].settings.maxLength).toBe(2000);

        deletePreset(store, 'DeepSeek V4 Pro');
        expect(mine(store).map(p => p.name)).toEqual(['Local Kobold']);
    });

    test('saving an existing name REPLACES it rather than duplicating', () => {
        const store = fakeStore();
        savePreset(store, 'Same', { ...defaultSettings(), maxLength: 400 });
        savePreset(store, 'Same', { ...defaultSettings(), maxLength: 1200 });

        expect(mine(store)).toHaveLength(1);
        expect(mine(store)[0].settings.maxLength).toBe(1200);
    });

    test('⚠️ a preset written by an older version is coerced on read, never trusted', () => {
        const store = fakeStore();
        store._raw.set('settings_presets', JSON.stringify([{ name: 'Old', settings: { maxLength: 99999 } }]));

        expect(mine(store)[0].settings.maxLength).toBe(field('maxLength').max);
        expect(mine(store)[0].settings.retrievalK).toBe(field('retrievalK').fallback);
    });

    test('a nameless preset is refused, and a junk blob reads as no presets', () => {
        const store = fakeStore();
        savePreset(store, '   ', defaultSettings());
        expect(mine(store)).toEqual([]);

        store._raw.set('settings_presets', JSON.stringify({ not: 'an array' }));
        expect(mine(store)).toEqual([]);
    });

    test('deleting a name that is not there is a no-op, not an error', () => {
        const store = fakeStore();
        savePreset(store, 'Keep', defaultSettings());

        expect(() => deletePreset(store, 'Never existed')).not.toThrow();
        expect(mine(store).map(p => p.name)).toEqual(['Keep']);
    });
});

describe('the extraction prompt template', () => {
    test('an untouched store runs the built-in, reported as empty rather than as a copy', () => {
        expect(readPromptTemplate(fakeStore())).toBe('');
    });

    test('an edited template round-trips', () => {
        const store = fakeStore();
        writePromptTemplate(store, 'Extract from {{window}} for {{charName}}.');

        expect(readPromptTemplate(store)).toBe('Extract from {{window}} for {{charName}}.');
    });

    test('🔴 saving the built-in UNCHANGED stores nothing, so the user keeps tracking the shipped prompt', () => {
        // The panel shows the real prompt in the editor, so an ordinary save posts the default back verbatim.
        // Storing it would freeze this user on today's wording for ever, with nothing to tell them why their
        // memories stopped improving when the default did.
        const store = fakeStore();
        writePromptTemplate(store, DEFAULT_EXTRACTION_TEMPLATE);

        expect(readPromptTemplate(store)).toBe('');
    });

    test('blank clears the override — "reset" and "never edited" are one state', () => {
        const store = fakeStore();
        writePromptTemplate(store, 'something of my own');
        writePromptTemplate(store, '   ');

        expect(readPromptTemplate(store)).toBe('');
    });

    test('⚠️ an over-long template is truncated, because it is paid for on EVERY extraction', () => {
        const store = fakeStore();
        writePromptTemplate(store, 'x'.repeat(PROMPT_MAX_CHARS + 5000));

        expect(readPromptTemplate(store)).toHaveLength(PROMPT_MAX_CHARS);
    });

    test('a non-string reads as no override rather than as a crash', () => {
        const store = fakeStore();
        store._raw.set('extraction_template', JSON.stringify({ not: 'a string' }));

        expect(readPromptTemplate(store)).toBe('');
    });
});

describe('🔴 a preset carries the prompt, not just the numbers', () => {
    test('save captures the template that was running, and load restores it', () => {
        const store = fakeStore();
        writeSettings(store, { maxLength: 2400 });
        writePromptTemplate(store, 'Big model wording: {{window}}');
        savePreset(store, 'Pro', readSettings(store), readPromptTemplate(store));

        // Move to a completely different state.
        writeSettings(store, { maxLength: 400 });
        writePromptTemplate(store, 'Small model wording: {{window}}');

        const pro = readPresets(store).find(p => p.name === 'Pro');
        expect(pro?.settings.maxLength).toBe(2400);
        expect(pro?.template).toBe('Big model wording: {{window}}');
    });

    test('⚠️ a preset saved on the BUILT-IN prompt carries `` and so clears an override on load', () => {
        // "Put me back in that state" has to include "…and I was not overriding the prompt". Leaving a stray
        // override behind would produce a state nobody ever saved.
        const store = fakeStore();
        savePreset(store, 'Stock', defaultSettings(), '');

        expect(mine(store)[0].template).toBe('');
    });

    test('a preset written before the prompt editor existed reads as no override, not as undefined', () => {
        const store = fakeStore();
        store._raw.set('settings_presets', JSON.stringify([{ name: 'Old', settings: defaultSettings() }]));

        expect(mine(store)[0].template).toBe('');
    });

    test('⚠️ an over-long template in a preset is truncated on read, like any other stored one', () => {
        const store = fakeStore();
        store._raw.set('settings_presets', JSON.stringify([
            { name: 'Huge', settings: defaultSettings(), template: 'y'.repeat(PROMPT_MAX_CHARS + 1000) },
        ]));

        expect(mine(store)[0].template).toHaveLength(PROMPT_MAX_CHARS);
    });
});

describe('🔴 the browser does not send back what it was given', () => {
    test('the default posted back with CRLF line endings still stores nothing', () => {
        // The HTML spec has a textarea submit its value with every break as CRLF. The editor is handed the
        // default with LF, so this is what a plain "Save" actually posts — and an exact comsamplecity1on would miss,
        // store a byte-different copy of the default, and freeze that user on it for ever.
        const store = fakeStore();
        writePromptTemplate(store, DEFAULT_EXTRACTION_TEMPLATE.replace(/\n/g, '\r\n'));

        expect(readPromptTemplate(store)).toBe('');
    });

    test('⚠️ a genuinely edited template is stored with LF, so it compares equal to itself next time', () => {
        const store = fakeStore();
        writePromptTemplate(store, 'Line one\r\nLine two {{window}}');

        expect(readPromptTemplate(store)).toBe('Line one\nLine two {{window}}');
    });
});

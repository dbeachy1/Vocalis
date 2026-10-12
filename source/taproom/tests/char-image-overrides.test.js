import { describe, test, expect } from '@jest/globals';

import {
    INHERIT,
    OVERRIDE_FIELDS,
    buildOverrideOptions,
    describeFallbacks,
    resolveImageOverrides,
} from '../public/scripts/extensions/stable-diffusion/char-image-overrides.js';

/**
 * A stand-in for `extension_settings.sd`, carrying the fields the Comfy path actually substitutes.
 * @param {object} over Fields to override
 * @returns {object} A global settings object
 */
const globalSettings = (over = {}) => ({
    source: 'comfy',
    model: 'GlobalCheckpoint.safetensors',
    comfy_workflow: 'Default_Comfy_Workflow.json',
    sampler: 'euler',
    scheduler: 'normal',
    steps: 20,
    scale: 7,
    width: 1024,
    height: 1024,
    seed: -1,
    ...over,
});

/**
 * 🔴 A WRONG CHECKPOINT DOES NOT THROW — IT RETURNS A GOOD IMAGE OF THE WRONG THING.
 *
 * Nothing in the UI or the ComfyUI log announces which checkpoint a request resolved to, so every
 * failure mode in this resolver is silent by construction. The rules therefore get asserted rather
 * than eyeballed, and the two that matter most are the ones a reader would not think to check:
 * that an unloaded model list never invalidates a good override, and that the global object is
 * never mutated.
 */
describe('Per-character image model — resolution', () => {
    test('no character overrides resolves to the global settings unchanged', () => {
        const global = globalSettings();
        const { settings, fallbacks } = resolveImageOverrides({ global });

        expect(settings).toEqual(global);
        expect(fallbacks).toEqual([]);
    });

    test('a null character is the same as no character', () => {
        const global = globalSettings();
        const { settings } = resolveImageOverrides({ global, character: null });

        expect(settings.model).toBe('GlobalCheckpoint.safetensors');
    });

    test('🔴 the global settings object is never mutated', () => {
        const global = globalSettings();
        const before = JSON.parse(JSON.stringify(global));

        resolveImageOverrides({
            global,
            character: { model: 'Illustrious.safetensors', comfy_workflow: 'Illustrious.json' },
            available: { model: ['Illustrious.safetensors'], comfy_workflow: ['Illustrious.json'] },
        });

        expect(global).toEqual(before);
    });

    test('the returned object is a copy, not a reference to the global', () => {
        const global = globalSettings();
        const { settings } = resolveImageOverrides({ global });

        expect(settings).not.toBe(global);
    });

    test('both fields override when the backend has them', () => {
        const { settings, fallbacks } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: 'FLUX.2-dev.safetensors', comfy_workflow: 'FLUX2-Portrait.json' },
            available: {
                model: ['GlobalCheckpoint.safetensors', 'FLUX.2-dev.safetensors'],
                comfy_workflow: ['Default_Comfy_Workflow.json', 'FLUX2-Portrait.json'],
            },
        });

        expect(settings.model).toBe('FLUX.2-dev.safetensors');
        expect(settings.comfy_workflow).toBe('FLUX2-Portrait.json');
        expect(fallbacks).toEqual([]);
    });

    test('overriding is per field — an unset workflow still inherits the global one', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: 'Illustrious.safetensors', comfy_workflow: INHERIT },
            available: { model: ['Illustrious.safetensors'] },
        });

        expect(settings.model).toBe('Illustrious.safetensors');
        expect(settings.comfy_workflow).toBe('Default_Comfy_Workflow.json');
    });

    test('fields outside the override set are untouched', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: 'Illustrious.safetensors', steps: 99, width: 512 },
            available: { model: ['Illustrious.safetensors'] },
        });

        expect(settings.steps).toBe(20);
        expect(settings.width).toBe(1024);
    });

    test('the override set is exactly model and workflow', () => {
        // Pinned deliberately. Sampler, steps and CFG belong inside the workflow JSON, which is now
        // per-character itself — adding them here would create two places to set one thing.
        expect([...OVERRIDE_FIELDS]).toEqual(['model', 'comfy_workflow']);
    });

    test('an empty model means inherit, not "set to empty"', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: INHERIT },
        });

        expect(settings.model).toBe('GlobalCheckpoint.safetensors');
    });

    test('an empty workflow means inherit, not "set to empty"', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings(),
            character: { comfy_workflow: INHERIT },
        });

        expect(settings.comfy_workflow).toBe('Default_Comfy_Workflow.json');
    });

    test('a non-string override is ignored rather than substituted', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: null, comfy_workflow: undefined },
        });

        expect(settings.model).toBe('GlobalCheckpoint.safetensors');
        expect(settings.comfy_workflow).toBe('Default_Comfy_Workflow.json');
    });
});

/**
 * 🔴 `/imagine model=X` IS THE USER TYPING A CHECKPOINT FOR THIS ONE IMAGE.
 *
 * Upstream implements that argument by writing X into the global settings and restoring them
 * afterwards, so by the time the resolver runs, `global.model` IS the command's value. Without the
 * `commandFields` carve-out the character override would then overwrite it and the argument would
 * be silently ignored for every character that has a checkpoint saved — the user gets a different
 * model than the one they just named, with nothing saying so.
 */
describe('Per-character image model — a one-shot slash argument outranks the character', () => {
    test('model= wins over the character checkpoint', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings({ model: 'CommandLine.safetensors' }),
            character: { model: 'Character.safetensors' },
            available: { model: ['CommandLine.safetensors', 'Character.safetensors'] },
            commandFields: ['model'],
        });

        expect(settings.model).toBe('CommandLine.safetensors');
    });

    test('naming only model= leaves the character workflow in force', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings({ model: 'CommandLine.safetensors' }),
            character: { model: 'Character.safetensors', comfy_workflow: 'Character.json' },
            available: { model: ['CommandLine.safetensors'], comfy_workflow: ['Character.json'] },
            commandFields: ['model'],
        });

        expect(settings.model).toBe('CommandLine.safetensors');
        expect(settings.comfy_workflow).toBe('Character.json');
    });

    test('naming both leaves the character out of it entirely', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings({ model: 'CLI.safetensors', comfy_workflow: 'CLI.json' }),
            character: { model: 'Character.safetensors', comfy_workflow: 'Character.json' },
            available: { model: ['CLI.safetensors'], comfy_workflow: ['CLI.json'] },
            commandFields: ['model', 'comfy_workflow'],
        });

        expect(settings.model).toBe('CLI.safetensors');
        expect(settings.comfy_workflow).toBe('CLI.json');
    });

    test('a command field is never reported as a fallback', () => {
        // The value came from the user, not the card, so it is not the card degrading.
        const { fallbacks } = resolveImageOverrides({
            global: globalSettings({ model: 'Whatever.safetensors' }),
            character: { model: 'Missing.safetensors' },
            available: { model: ['Other.safetensors'] },
            commandFields: ['model'],
        });

        expect(fallbacks).toEqual([]);
    });

    test('no command fields leaves character precedence exactly as before', () => {
        const { settings } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: 'Character.safetensors' },
            available: { model: ['Character.safetensors'] },
            commandFields: [],
        });

        expect(settings.model).toBe('Character.safetensors');
    });
});

describe('Per-character image model — graceful degradation', () => {
    test('a model the backend does not have falls back to global and is reported', () => {
        const { settings, fallbacks } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: 'Deleted.safetensors' },
            available: { model: ['GlobalCheckpoint.safetensors'] },
        });

        expect(settings.model).toBe('GlobalCheckpoint.safetensors');
        expect(fallbacks).toEqual([{ field: 'model', requested: 'Deleted.safetensors' }]);
    });

    test('a missing model does not take a valid workflow down with it', () => {
        const { settings, fallbacks } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: 'Deleted.safetensors', comfy_workflow: 'Illustrious.json' },
            available: {
                model: ['GlobalCheckpoint.safetensors'],
                comfy_workflow: ['Illustrious.json'],
            },
        });

        expect(settings.model).toBe('GlobalCheckpoint.safetensors');
        expect(settings.comfy_workflow).toBe('Illustrious.json');
        expect(fallbacks).toHaveLength(1);
    });

    test('🔴 an EMPTY list means "not loaded yet" and must not invalidate a good override', () => {
        // The model list is fetched from ComfyUI asynchronously. A generation fired during startup,
        // or straight after a reconnect, sees an empty list — treating that as "no model is valid"
        // would drop a perfectly good checkpoint and toast about it on every cold start.
        const { settings, fallbacks } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: 'Illustrious.safetensors' },
            available: { model: [] },
        });

        expect(settings.model).toBe('Illustrious.safetensors');
        expect(fallbacks).toEqual([]);
    });

    test('an absent list is treated the same as an empty one', () => {
        const { settings, fallbacks } = resolveImageOverrides({
            global: globalSettings(),
            character: { model: 'Illustrious.safetensors' },
            available: {},
        });

        expect(settings.model).toBe('Illustrious.safetensors');
        expect(fallbacks).toEqual([]);
    });
});

describe('Per-character image model — dropdown options', () => {
    test('the inherit sentinel is always first and always has the empty value', () => {
        const options = buildOverrideOptions({ values: ['A.safetensors'] });

        expect(options[0]).toEqual({ value: INHERIT, text: '(use global)', missing: false });
    });

    test('backend values are carried through in order', () => {
        const options = buildOverrideOptions({ values: ['A.safetensors', 'B.safetensors'] });

        expect(options.map(o => o.value)).toEqual([INHERIT, 'A.safetensors', 'B.safetensors']);
    });

    test('object-shaped entries keep their display text', () => {
        const options = buildOverrideOptions({
            values: [{ value: 'flux-dev', text: 'FLUX.2 Dev' }],
        });

        expect(options[1]).toEqual({ value: 'flux-dev', text: 'FLUX.2 Dev', missing: false });
    });

    test('a backend placeholder with an empty value does not become a second "inherit"', () => {
        // RunPod emits `{ value: '', text: 'N/A' }`; HuggingFace emits `<Enter Model ID above>`.
        const options = buildOverrideOptions({ values: [{ value: '', text: 'N/A' }] });

        expect(options.filter(o => o.value === INHERIT)).toHaveLength(1);
        expect(options[0].text).toBe('(use global)');
    });

    test('🔴 a saved value absent from the list gets a synthetic option so it cannot erase itself', () => {
        // Without this, the <select> reports its FIRST option instead of the saved value, and the
        // change handler persists that back — one chat switch before the fetch lands and the
        // character's checkpoint is silently gone.
        const options = buildOverrideOptions({
            values: ['A.safetensors'],
            saved: 'Illustrious.safetensors',
        });

        const synthetic = options.find(o => o.value === 'Illustrious.safetensors');
        expect(synthetic).toBeDefined();
        expect(synthetic.missing).toBe(true);
        expect(synthetic.text).toContain('not found');
    });

    test('a saved value already present in the list is not duplicated', () => {
        const options = buildOverrideOptions({
            values: ['A.safetensors'],
            saved: 'A.safetensors',
        });

        expect(options.filter(o => o.value === 'A.safetensors')).toHaveLength(1);
        expect(options.every(o => !o.missing)).toBe(true);
    });

    test('an empty list still renders the saved value rather than nothing', () => {
        const options = buildOverrideOptions({ values: [], saved: 'Illustrious.safetensors' });

        expect(options.map(o => o.value)).toEqual([INHERIT, 'Illustrious.safetensors']);
    });

    test('no saved value produces no synthetic option', () => {
        const options = buildOverrideOptions({ values: ['A.safetensors'], saved: INHERIT });

        expect(options.every(o => !o.missing)).toBe(true);
    });
});

describe('Per-character image model — fallback message', () => {
    test('nothing dropped produces no message', () => {
        expect(describeFallbacks([])).toBe('');
        expect(describeFallbacks(undefined)).toBe('');
    });

    test('the message names the field and the value the card asked for', () => {
        const message = describeFallbacks([{ field: 'model', requested: 'Deleted.safetensors' }]);

        expect(message).toContain('model');
        expect(message).toContain('Deleted.safetensors');
    });

    test('both fields collapse into one sentence', () => {
        const message = describeFallbacks([
            { field: 'model', requested: 'A.safetensors' },
            { field: 'comfy_workflow', requested: 'B.json' },
        ]);

        expect(message).toContain('A.safetensors');
        expect(message).toContain('workflow');
        expect(message).toContain('B.json');
        expect(message.split('.').filter(Boolean)).not.toHaveLength(0);
    });
});

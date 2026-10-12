import { describe, test, expect } from '@jest/globals';

import { resolveImagePromptLength } from '../public/scripts/extensions/stable-diffusion/prompt-length.js';

/**
 * 🔴 THE MODEL FILLED THE BUDGET IT WAS GIVEN, AND THE BUDGET WAS THE CHAT BUDGET.
 *
 * `generatePrompt` called `generateQuietPrompt({ quietPrompt })` with no `responseLength`, so writing
 * an image prompt inherited the main chat response allowance — set high, correctly, so ordinary
 * replies are not cut off. Handed ~500 tokens and asked for a comma-delimited list, the model
 * produced ~500 tokens of comma-delimited list: observed 2026-08-02 drifting from a car interior into
 * `residential road view, commercial road view, industrial road view, rural road view…` long after it
 * had run out of scene to describe.
 *
 * ⚠️ **Not fixable by samplers or by asking.** DRY was already enabled at 0.8 / 1.75 / allowed 2 /
 * range 2048 and saw nothing wrong, because the tail is lexically distinct and only *semantically*
 * redundant. "Output at most 30 keywords" is a counting instruction, and a model that could count
 * would not have produced the list in the first place. A token cap is the only reliable bound.
 *
 * 🔴 The property that makes this safe to ship: **anything that is not a usable positive number
 * returns `null`**, which is what `generateQuietPrompt` treats as "not customised". Off has to restore
 * upstream exactly, and a fat-fingered field must not silently truncate every image prompt.
 */
describe('🔴 Image prompt token cap', () => {
    test('unset inherits the API response length', () => {
        expect(resolveImagePromptLength({})).toBeNull();
    });

    test('🔴 0 means "use the API setting" — the documented off switch', () => {
        expect(resolveImagePromptLength({ prompt_response_length: 0 })).toBeNull();
    });

    test('a configured cap is returned', () => {
        expect(resolveImagePromptLength({ prompt_response_length: 200 })).toBe(200);
    });

    test('a numeric string from the input element is accepted', () => {
        expect(resolveImagePromptLength({ prompt_response_length: '200' })).toBe(200);
    });

    test('a fractional value is floored rather than passed on as a fraction', () => {
        expect(resolveImagePromptLength({ prompt_response_length: 200.9 })).toBe(200);
    });

    describe('🔴 every unusable input falls back to upstream, never to a number', () => {
        test('an empty field inherits the API response length', () => {
            expect(resolveImagePromptLength({ prompt_response_length: '' })).toBeNull();
        });

        test('null and undefined inherit it', () => {
            expect(resolveImagePromptLength({ prompt_response_length: null })).toBeNull();
            expect(resolveImagePromptLength({ prompt_response_length: undefined })).toBeNull();
        });

        test('text inherits it rather than becoming NaN downstream', () => {
            expect(resolveImagePromptLength({ prompt_response_length: 'lots' })).toBeNull();
            expect(resolveImagePromptLength({ prompt_response_length: NaN })).toBeNull();
        });

        test('a negative inherits it rather than clamping up to the floor', () => {
            expect(resolveImagePromptLength({ prompt_response_length: -50 })).toBeNull();
        });

        test('Infinity inherits it rather than clamping down to the ceiling', () => {
            expect(resolveImagePromptLength({ prompt_response_length: Infinity })).toBeNull();
        });

        test('missing settings do not throw', () => {
            expect(resolveImagePromptLength(undefined)).toBeNull();
            expect(resolveImagePromptLength(null)).toBeNull();
        });
    });

    describe('clamping — a cap that cannot say anything is not useful, and one that is huge is not a cap', () => {
        test('below the floor is raised to 16', () => {
            expect(resolveImagePromptLength({ prompt_response_length: 1 })).toBe(16);
        });

        test('above the ceiling is lowered to 2048', () => {
            expect(resolveImagePromptLength({ prompt_response_length: 999999 })).toBe(2048);
        });

        test('the boundaries themselves pass through untouched', () => {
            expect(resolveImagePromptLength({ prompt_response_length: 16 })).toBe(16);
            expect(resolveImagePromptLength({ prompt_response_length: 2048 })).toBe(2048);
        });
    });
});

import { describe, test, expect } from '@jest/globals';

import { shouldSkipCharacterPrefix } from '../public/scripts/extensions/stable-diffusion/char-prefix-rules.js';

/**
 * Upstream's expression, transcribed verbatim from `sendGenerationRequest` before this change:
 * `!ignoreNoCharForSwipe && noCharPrefix.includes(generationType)`. Kept here as the oracle the
 * exhaustive case below compares against, so "identical to upstream" is asserted rather than read.
 * @param {{isNoCharPrefixMode: boolean, isSwipe: boolean, isCharChat: boolean}} p Inputs
 * @returns {boolean} What upstream would have decided
 */
function upstreamSkipCharPrefix({ isNoCharPrefixMode, isSwipe, isCharChat }) {
    const ignoreNoCharForSwipe = isSwipe && isCharChat;
    return !ignoreNoCharForSwipe && isNoCharPrefixMode;
}

/**
 * 🔴 `/imagine` DROPPED THE CHARACTER PREFIX, AND WITH IT THE ONLY PLACE A LORA CAN LIVE.
 *
 * Upstream omits the character-specific prompt prefix for FREE (`/imagine`), FREE_EXTENDED,
 * BACKGROUND, USER and USER_MULTIMODAL. That is coherent while the prefix is adjectives. It is not
 * coherent once the prefix carries `<lora:NAME:1.0>`, because "do not add character flavour" then
 * also means "do not be this character" — and the result is a perfectly good image of the wrong
 * person, with nothing in the UI or the ComfyUI log indicating a field was skipped. Diagnosed
 * 2026-08-02 by the *absence* of rgthree's `Matched Lora input` line.
 *
 * Three properties, and the first is what makes the change safe to ship:
 *
 *   OFF     — reduces byte-for-byte to upstream's
 *             `!ignoreNoCharForSwipe && noCharPrefix.includes(generationType)`.
 *   ON      — FREE and FREE_EXTENDED get the prefix, in single-character chats only.
 *   BOUNDED — ON must NEVER reach BACKGROUND or USER. A background is scenery and "me" is the
 *             user's persona; putting the character's LoRA on either is the same bug mirrored.
 */
describe('🔴 Character prefix in /imagine — the opt-in must not change anything else', () => {
    /**
     * @param {object} over Fields to override
     * @returns {object} A full argument object
     */
    const args = (over = {}) => ({
        isNoCharPrefixMode: false,
        isFreeMode: false,
        isSwipe: false,
        isCharChat: true,
        includeInFreeMode: false,
        ...over,
    });

    describe('🔴 OFF — identical to upstream', () => {
        test('/imagine skips the prefix, exactly as upstream does', () => {
            expect(shouldSkipCharacterPrefix(args({ isNoCharPrefixMode: true, isFreeMode: true }))).toBe(true);
        });

        test('backgrounds and user portraits skip it', () => {
            expect(shouldSkipCharacterPrefix(args({ isNoCharPrefixMode: true }))).toBe(true);
        });

        test('Character / Portrait / Scenario / Last Message keep it', () => {
            expect(shouldSkipCharacterPrefix(args())).toBe(false);
        });

        test('the existing upstream swipe carve-out still applies', () => {
            expect(shouldSkipCharacterPrefix(args({ isNoCharPrefixMode: true, isSwipe: true }))).toBe(false);
        });

        test('the swipe carve-out needs a single-character chat, not just a swipe', () => {
            expect(shouldSkipCharacterPrefix(args({ isNoCharPrefixMode: true, isSwipe: true, isCharChat: false }))).toBe(true);
        });

        test('🔴 a populated setting object with the box off changes NOTHING', () => {
            // The mirror of the comfy-auth rule: off has to mean off, not "off unless something
            // else happens to be set".
            expect(shouldSkipCharacterPrefix(args({ isNoCharPrefixMode: true, isFreeMode: true, isCharChat: true, includeInFreeMode: false }))).toBe(true);
        });
    });

    describe('ON — /imagine gains the prefix', () => {
        const on = { includeInFreeMode: true };

        test('FREE keeps the prefix in a single-character chat', () => {
            expect(shouldSkipCharacterPrefix(args({ ...on, isNoCharPrefixMode: true, isFreeMode: true }))).toBe(false);
        });

        test('FREE_EXTENDED does too — same flag, same modes', () => {
            expect(shouldSkipCharacterPrefix(args({ ...on, isNoCharPrefixMode: true, isFreeMode: true }))).toBe(false);
        });

        test('groups are excluded — there is no single character whose prefix it would be', () => {
            expect(shouldSkipCharacterPrefix(args({ ...on, isNoCharPrefixMode: true, isFreeMode: true, isCharChat: false }))).toBe(true);
        });
    });

    describe('🔴 BOUNDED — the opt-in must not leak to the other three modes', () => {
        const on = { includeInFreeMode: true, isNoCharPrefixMode: true, isFreeMode: false };

        test('BACKGROUND still skips it with the box ON — scenery is not the character', () => {
            expect(shouldSkipCharacterPrefix(args(on))).toBe(true);
        });

        test('USER still skips it with the box ON — "me" is the user persona', () => {
            expect(shouldSkipCharacterPrefix(args(on))).toBe(true);
        });

        test('USER_MULTIMODAL still skips it with the box ON', () => {
            expect(shouldSkipCharacterPrefix(args(on))).toBe(true);
        });
    });

    describe('the modes that always keep it are unaffected by the flag', () => {
        test('a normal character mode keeps the prefix with the box OFF', () => {
            expect(shouldSkipCharacterPrefix(args({ includeInFreeMode: false }))).toBe(false);
        });

        test('a normal character mode keeps the prefix with the box ON', () => {
            expect(shouldSkipCharacterPrefix(args({ includeInFreeMode: true }))).toBe(false);
        });
    });

    /**
     * The whole point of extracting this: assert the OFF path against upstream's original expression
     * over every input combination, rather than by reading it.
     */
    test('🔴 EXHAUSTIVE: with the box off, all 16 input combinations match upstream exactly', () => {
        const bools = [false, true];
        let checked = 0;

        for (const isNoCharPrefixMode of bools) {
            for (const isFreeMode of bools) {
                for (const isSwipe of bools) {
                    for (const isCharChat of bools) {
                        const upstream = upstreamSkipCharPrefix({ isNoCharPrefixMode, isSwipe, isCharChat });
                        const actual = shouldSkipCharacterPrefix({
                            isNoCharPrefixMode, isFreeMode, isSwipe, isCharChat, includeInFreeMode: false,
                        });
                        expect({ isNoCharPrefixMode, isFreeMode, isSwipe, isCharChat, actual })
                            .toEqual({ isNoCharPrefixMode, isFreeMode, isSwipe, isCharChat, actual: upstream });
                        checked++;
                    }
                }
            }
        }

        expect(checked).toBe(16);
    });
});

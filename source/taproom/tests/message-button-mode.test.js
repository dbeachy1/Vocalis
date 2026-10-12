import { describe, test, expect } from '@jest/globals';

import { buildMessageQuietPrompt, shouldGeneratePromptWithLlm } from '../public/scripts/extensions/stable-diffusion/message-button-mode.js';

/**
 * 🔴 THE 🖌 BUTTON SENT THE WHOLE MESSAGE TO THE IMAGE BACKEND AS THE PROMPT.
 *
 * `sdMessageButton` is a re-roll button — it reuses the prompt saved on an existing image. The
 * first-click case has no image to re-roll, so upstream falls back to `title: message.mes`: prose,
 * dialogue and all, straight to a checkpoint that wants Danbooru tags, with no LLM step. Instant, and
 * This differs from the last-message action, which builds a prompt through the configured LLM path.
 *
 * Three properties:
 *
 *   OFF        — unchecked, the button does exactly what upstream does.
 *   RE-ROLL    — a message that already has an image is never re-prompted, checkbox or not. Re-rolling
 *                means "another version of this", and regenerating the prompt would silently make it
 *                "a different picture".
 *   RIGHT ONE  — 🔴 the template says "the last chat message" and the button is on every message. On
 *                anything but the last one, the target must be named, or the model writes a flawless
 *                description of a message you did not click.
 */
describe('🔴 Message button — LLM-built prompts', () => {
    describe('OFF is upstream', () => {
        test('unchecked never asks the LLM', () => {
            expect(shouldGeneratePromptWithLlm({ message_button_llm_prompt: false }, false)).toBe(false);
        });

        test('an absent setting never asks the LLM', () => {
            expect(shouldGeneratePromptWithLlm({}, false)).toBe(false);
            expect(shouldGeneratePromptWithLlm(undefined, false)).toBe(false);
        });

        test('checked, with no existing image, asks the LLM', () => {
            expect(shouldGeneratePromptWithLlm({ message_button_llm_prompt: true }, false)).toBe(true);
        });
    });

    describe('🔴 RE-ROLL — an existing image is never re-prompted', () => {
        test('checked but the message already has an image: reuse its prompt', () => {
            expect(shouldGeneratePromptWithLlm({ message_button_llm_prompt: true }, true)).toBe(false);
        });

        test('unchecked with an existing image: also reuse it', () => {
            expect(shouldGeneratePromptWithLlm({ message_button_llm_prompt: false }, true)).toBe(false);
        });
    });

    describe('🔴 RIGHT ONE — describing the message that was actually clicked', () => {
        const TEMPLATE = 'Describe the visual details in the last chat message as keywords.';
        const TEXT = 'She uncrossed her legs and leaned against the counter.';

        test('the last message sends the template verbatim — identical to the wand mode', () => {
            expect(buildMessageQuietPrompt(TEMPLATE, TEXT, true)).toBe(TEMPLATE);
        });

        test('an older message names the target and overrides the recency wording', () => {
            const result = buildMessageQuietPrompt(TEMPLATE, TEXT, false);
            expect(result).toContain(TEMPLATE);
            expect(result).toContain(TEXT);
            expect(result).toContain('Ignore the instruction to use the last chat message');
        });

        test('the target text is delimited, so it cannot be read as further instructions', () => {
            const result = buildMessageQuietPrompt(TEMPLATE, TEXT, false);
            expect(result).toContain(`"""\n${TEXT}\n"""`);
        });

        test('an empty older message falls back rather than telling the model to describe nothing', () => {
            expect(buildMessageQuietPrompt(TEMPLATE, '   ', false)).toBe(TEMPLATE);
            expect(buildMessageQuietPrompt(TEMPLATE, null, false)).toBe(TEMPLATE);
        });

        test('a missing template does not throw', () => {
            expect(buildMessageQuietPrompt(undefined, TEXT, true)).toBe('');
            expect(buildMessageQuietPrompt(null, TEXT, false)).toContain(TEXT);
        });

        test('surrounding whitespace is trimmed rather than shipped', () => {
            expect(buildMessageQuietPrompt(`  ${TEMPLATE}  `, TEXT, true)).toBe(TEMPLATE);
        });
    });
});

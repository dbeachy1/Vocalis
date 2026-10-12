import { describe, expect, test } from '@jest/globals';

import { promptEndsInsideReasoning, repairReasoningOnlyMessage, splitReasoningOpenedByPrompt } from '../public/scripts/reasoning-fallback.js';

describe('repairReasoningOnlyMessage', () => {
    test('promotes reasoning to visible text and synchronizes the active swipe', () => {
        const message = {
            is_user: false,
            is_system: false,
            mes: ' \n ',
            send_date: '2026-09-16T12:00:00.000Z',
            gen_started: '2026-09-16T11:59:00.000Z',
            gen_finished: '2026-09-16T12:00:00.000Z',
            swipe_id: 1,
            swipes: ['first answer', ''],
            swipe_info: [
                { extra: { reasoning: 'other reasoning' } },
                { extra: { reasoning: 'stale reasoning' } },
            ],
            extra: {
                reasoning: 'The complete answer arrived in the reasoning channel.',
                reasoning_duration: 1234,
                reasoning_type: 'parsed',
                reasoning_display_text: 'translated reasoning',
                reasoning_signature: 'encrypted-signature',
                api: 'openai',
                model: 'deepseek-v4-pro',
            },
        };

        expect(repairReasoningOnlyMessage(message)).toBe(true);
        expect(message.mes).toBe('The complete answer arrived in the reasoning channel.');
        expect(message.extra).toEqual({
            api: 'openai',
            model: 'deepseek-v4-pro',
        });
        expect(message.swipes).toEqual([
            'first answer',
            'The complete answer arrived in the reasoning channel.',
        ]);
        expect(message.swipe_info[1]).toEqual({
            send_date: message.send_date,
            gen_started: message.gen_started,
            gen_finished: message.gen_finished,
            extra: {
                api: 'openai',
                model: 'deepseek-v4-pro',
            },
        });
        expect(message.swipe_id).toBe(1);
    });

    test('backfills the active swipe record when the stored chat has no swipe_info array', () => {
        const message = {
            mes: '',
            swipe_id: 0,
            swipes: [''],
            send_date: '2026-09-16T12:00:00.000Z',
            extra: { reasoning: 'Recovered answer' },
        };

        expect(repairReasoningOnlyMessage(message)).toBe(true);
        expect(message.mes).toBe('Recovered answer');
        expect(message.swipes[0]).toBe('Recovered answer');
        expect(message.swipe_info[0].extra).toEqual({});
        expect(message.swipe_info[0].send_date).toBe(message.send_date);
    });

    test('preserves the complete reasoning text when promoting it', () => {
        const message = {
            mes: '  ',
            extra: { reasoning: '    Indented Markdown\n\nTrailing space.  ' },
        };

        expect(repairReasoningOnlyMessage(message)).toBe(true);
        expect(message.mes).toBe('    Indented Markdown\n\nTrailing space.  ');
        expect(message.extra).toEqual({});
    });

    test('does not modify non-target messages', () => {
        const cases = [
            { is_user: true },
            { is_system: true },
            { extra: { isSmallSys: true } },
            { mes: 'already visible', extra: { reasoning: 'not a fallback' } },
            { mes: '', extra: {} },
            { mes: '', extra: { reasoning: ' \n ' } },
        ];

        for (const fields of cases) {
            const message = {
                mes: '',
                extra: { reasoning: 'original reasoning' },
            };
            Object.assign(message, fields);
            const before = structuredClone(message);

            expect(repairReasoningOnlyMessage(message)).toBe(false);
            expect(message).toEqual(before);
        }
    });
});

// Cover a prompt that ends inside a thinking block and a reply that begins with a bare `</think>` tag.
describe('a prompt that opens the thinking block', () => {
    const PROMPT = '<｜User｜>Continue.<｜Assistant｜><think>';

    test('is recognised from the prompt as sent, trailing whitespace included', () => {
        expect(promptEndsInsideReasoning(PROMPT, '<think>', '')).toBe(true);
        expect(promptEndsInsideReasoning(`${PROMPT}\n`, '<think>', '')).toBe(true);
    });

    test('is not claimed when Start Reply With supplied the tag, because the ordinary parser handles that', () => {
        expect(promptEndsInsideReasoning(PROMPT, '<think>', '<think>')).toBe(false);
        expect(promptEndsInsideReasoning(PROMPT, '<think>', '<think>\n')).toBe(false);
    });

    test('is not claimed for a closed or absent block, a chat-completion message array, or no template', () => {
        expect(promptEndsInsideReasoning('<｜Assistant｜></think>', '<think>', '')).toBe(false);
        expect(promptEndsInsideReasoning('<｜Assistant｜>', '<think>', '')).toBe(false);
        expect(promptEndsInsideReasoning([{ role: 'user', content: '<think>' }], '<think>', '')).toBe(false);
        expect(promptEndsInsideReasoning(PROMPT, '', '')).toBe(false);
    });

    test('splits reasoning left in the reply text at the closing tag', () => {
        expect(splitReasoningOpenedByPrompt('The user wants the woman to answer.\n</think>\n\nThe woman looked at Test Character.', '<think>', '</think>'))
            .toEqual({ reasoning: 'The user wants the woman to answer.', content: 'The woman looked at Test Character.' });
    });

    test('drops a bare closing tag when the model skipped thinking', () => {
        expect(splitReasoningOpenedByPrompt('</think>The woman looked at Test Character.', '<think>', '</think>'))
            .toEqual({ reasoning: '', content: 'The woman looked at Test Character.' });
    });

    test('drops an opening tag the model repeated', () => {
        expect(splitReasoningOpenedByPrompt('<think>\nPlan the beat.\n</think>Reply.', '<think>', '</think>'))
            .toEqual({ reasoning: 'Plan the beat.', content: 'Reply.' });
    });

    test('leaves a reply with no closing tag alone, since nothing says where reasoning would end', () => {
        expect(splitReasoningOpenedByPrompt('A plain reply.', '<think>', '</think>')).toBeNull();
        expect(splitReasoningOpenedByPrompt('A plain reply.', '<think>', '')).toBeNull();
        expect(splitReasoningOpenedByPrompt(undefined, '<think>', '</think>')).toBeNull();
    });

    test('splits at the FIRST closing tag, so a reply that quotes the tag keeps the quote', () => {
        expect(splitReasoningOpenedByPrompt('Think.</think>She wrote "</think>" on the board.', '<think>', '</think>'))
            .toEqual({ reasoning: 'Think.', content: 'She wrote "</think>" on the board.' });
    });
});

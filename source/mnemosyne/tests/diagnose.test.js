import { describe, test, expect } from '@jest/globals';

import { describeFailure } from '../src/ingest/diagnose.js';

/**
 * Translating a thrown extraction failure into something publishable.
 *
 * 🔴 **The test that matters most is the leak one**, and it is not the one that looks important. The fork's
 * non-OK branch builds `` `backend '<type>' returned ${status}. ${detail}` `` where `detail` is the backend's
 * own response body — and an OpenAI-compatible 400 routinely echoes the offending request, which contains the
 * extraction prompt, which contains the user's conversation. Publishing that message verbatim would put chat
 * text into `st.log` on a default install: the exact failure `logging.js` exists to prevent, arriving through
 * a diagnostic added to make things *better*.
 *
 * The rest of the cases are ordinary coverage. This one is a guard.
 */
describe('describeFailure', () => {
    test('keeps the HTTP status and drops the response body entirely', () => {
        const leaky = new Error(
            'context.generate: backend \'featherless\' returned 400. '
            + '{"error":"unknown parameter","prompt":"Test Speaker leaned across the table and whispered"}',
        );

        const { reason, fix } = describeFailure(leaky);

        expect(reason).toBe('the backend rejected the request with HTTP 400');
        expect(reason).not.toContain('Test Speaker');
        expect(reason).not.toContain('whispered');
        expect(reason).not.toContain('prompt');
        expect(fix).toContain('400');
    });

    test('never repeats the handle the fork interpolated into its message', () => {
        const { reason } = describeFailure(new Error(
            'context.generate: no active backend captured for \'test-user\'. generate runs only after that user has generated at least once.',
        ));

        expect(reason).toBe('the fork has not captured a backend connection for this user');
        expect(reason).not.toContain('test-user');
    });

    test('names an unsupported backend without claiming to know which', () => {
        const { reason, fix } = describeFailure(new Error(
            'context.generate: backend \'openai\' is not supported yet — only the OpenAI-completions family. This is a follow-up.',
        ));

        expect(reason).toContain('does not support this backend');
        expect(fix).toContain('Text Completion');
    });

    test('a missing instruct envelope says what to turn on', () => {
        const { fix } = describeFailure(new Error(
            'context.generate: wrap was requested but no instruct envelope was captured for \'test-user\'.',
        ));

        expect(fix).toContain('Instruct Mode');
    });

    test('a timeout carries the millisecond bound, which is structural', () => {
        const { reason } = describeFailure(new Error(
            'context.generate: backend \'featherless\' did not answer within 300000ms.',
        ));

        expect(reason).toBe('the backend did not answer within 300000ms');
    });

    test('an empty completion is told apart from a rejected request', () => {
        const { reason } = describeFailure(new Error(
            'context.generate: backend \'featherless\' returned no completion text.',
        ));

        expect(reason).toContain('no completion text');
    });

    // 🔴 The floor. An unrecognized message may name a path, quote a card field, or hold anything else — so it
    // degrades to the error's NAME, which is what the old implementation published and is known safe.
    test('an unrecognized error falls back to the name and publishes nothing else', () => {
        const { reason, fix } = describeFailure(new TypeError('/home/test-user/.vault/secret.sqlite is corrupt'));

        expect(reason).toContain('TypeError');
        expect(reason).not.toContain('test-user');
        expect(reason).not.toContain('vault');
        expect(fix).toBeNull();
    });

    test('survives a thrown non-Error', () => {
        expect(describeFailure('just a string').reason).toContain('Error');
        expect(describeFailure(undefined).reason).toContain('Error');
        expect(describeFailure(null).reason).toContain('Error');
    });
});

import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';

import { locateRenderedTurns } from '../public/scripts/plugin-prompts.js';
import {
    RECENT_MESSAGES_FIELD,
    clearPromptInterceptors,
    onPrompt,
    runPromptInterceptors,
    takeRecentMessages,
} from '../src/generation-interceptors.js';
import { log } from '../src/logger.js';

/**
 * 🔴 THE DEPTH ANCHOR (§27) — WHY A WRONG OFFSET IS WORSE THAN NO OFFSET.
 *
 * A memory plugin on the text path receives one rendered string and used to prepend to the front of it,
 * because the turn boundaries inside the blob were destroyed by the render and recovering them meant guessing
 * the instruct template. Front placement measures at 0.1 % KV-cache reuse and 15.3 s per changed turn, against
 * 97.1 % and 1.3 s for the same block placed below the history, and
 * no backend flag rescues it.
 *
 * So the client now says where each turn begins. The number is only useful if it is RIGHT: a plugin splices at
 * it, so an offset that is off by even one turn puts a memory block inside somebody else's message, corrupting
 * a prompt in a way nothing downstream can see or report. Every test below exists to make the wrong number
 * impossible rather than unlikely — the contract is "a verified offset, or -1", and -1 costs only the old
 * prepend.
 */
describe('locateRenderedTurns — a hit is a proof, a miss is -1', () => {
    test('the ordinary case: each turn is found where it actually is', () => {
        const prompt = '### Story\n<|user|>hello\n<|bot|>hi there\n<|user|>how are you\n';
        const turns = [
            { text: '<|user|>hello\n', chatIndex: 0 },
            { text: '<|bot|>hi there\n', chatIndex: 1 },
            { text: '<|user|>how are you\n', chatIndex: 2 },
        ];

        const located = locateRenderedTurns(prompt, turns);

        expect(located.get(0)).toBe(prompt.indexOf('<|user|>hello'));
        expect(located.get(1)).toBe(prompt.indexOf('<|bot|>hi there'));
        expect(located.get(2)).toBe(prompt.indexOf('<|user|>how are you'));
        // And the offsets are usable: splicing at one lands exactly on that turn's first character.
        expect(prompt.slice(located.get(2))).toBe('<|user|>how are you\n');
    });

    test('🔴 IDENTICAL TURNS RESOLVE TO DIFFERENT OFFSETS — the bug a forward search would ship', () => {
        // "Yes." occurs a dozen times in a real chat. A forward `indexOf` pins every one of them to the FIRST
        // occurrence, so a plugin asking for depth 1 gets the offset of a turn near the top of the window and
        // splices its memory block into the distant past — which is not just useless, it is the front
        // placement this whole feature exists to stop, arrived at through a bug instead of a design.
        const prompt = 'A<|user|>ok\n<|bot|>sure\n<|user|>ok\n<|bot|>sure\n';
        const turns = [
            { text: '<|user|>ok\n', chatIndex: 10 },
            { text: '<|bot|>sure\n', chatIndex: 11 },
            { text: '<|user|>ok\n', chatIndex: 12 },
            { text: '<|bot|>sure\n', chatIndex: 13 },
        ];

        const located = locateRenderedTurns(prompt, turns);

        expect(located.get(10)).toBe(1);
        expect(located.get(11)).toBe(12);
        expect(located.get(12)).toBe(24);
        expect(located.get(13)).toBe(35);
        expect(new Set([located.get(10), located.get(11), located.get(12), located.get(13)]).size).toBe(4);
        // Every one of them still points at its own text, which is the property that actually matters.
        for (const turn of turns) {
            expect(prompt.startsWith(turn.text, located.get(turn.chatIndex))).toBe(true);
        }
    });

    test('a turn the prompt no longer contains is simply absent — never a nearby guess', () => {
        // This is what a `GENERATE_AFTER_COMBINE_PROMPTS` subscriber rewriting one message looks like from
        // here. The rewritten turn cannot be placed; the ones around it still can, and must not be dragged.
        const prompt = '<|user|>alpha\n<|bot|>REWRITTEN\n<|user|>gamma\n';
        const turns = [
            { text: '<|user|>alpha\n', chatIndex: 0 },
            { text: '<|bot|>beta\n', chatIndex: 1 },
            { text: '<|user|>gamma\n', chatIndex: 2 },
        ];

        const located = locateRenderedTurns(prompt, turns);

        expect(located.has(1)).toBe(false);
        expect(located.get(0)).toBe(0);
        expect(located.get(2)).toBe(prompt.indexOf('<|user|>gamma'));
    });

    test('a miss does NOT move the ceiling, so the turns above it keep their own positions', () => {
        // The tempting shortcut is to treat an unfound turn as "somewhere around here" and carry on. It is
        // not: it is unknown. Lowering the ceiling on a guess would let one transformed turn pull every turn
        // above it into the wrong place, and each of those would then be a WRONG offset rather than a missing
        // one — the exact failure this design refuses to be capable of.
        const prompt = 'X<|a|>1\nX<|a|>1\n<|gone|>\n';
        const turns = [
            { text: '<|a|>1\n', chatIndex: 0 },
            { text: '<|a|>1\n', chatIndex: 1 },
            { text: '<|missing|>\n', chatIndex: 2 },
        ];

        const located = locateRenderedTurns(prompt, turns);

        expect(located.has(2)).toBe(false);
        // Both survivors are found, in order, at their own occurrences — not both at the last one.
        expect(located.get(1)).toBe(9);
        expect(located.get(0)).toBe(1);
    });

    test('anything that is not a turn is skipped and does not consume an occurrence', () => {
        // `chat2` carries depth injections, the user-alignment message and the jailbreak alongside the real
        // turns, and always has. They render into the prompt but have no place in the chat array, so they
        // arrive here as chatIndex -1 and get no anchor.
        const prompt = '<|sys|>WI\n<|user|>hello\n';
        const turns = [
            { text: '<|sys|>WI\n', chatIndex: -1 },
            { text: '<|user|>hello\n', chatIndex: 7 },
        ];

        const located = locateRenderedTurns(prompt, turns);

        expect(located.size).toBe(1);
        expect(located.get(7)).toBe(prompt.indexOf('<|user|>hello'));
    });

    test('an empty turn is skipped rather than matching at every position', () => {
        // `''.lastIndexOf` succeeds everywhere. Left unguarded that is an offset that always looks valid and
        // is never meaningful.
        const located = locateRenderedTurns('anything', [{ text: '', chatIndex: 3 }]);

        expect(located.has(3)).toBe(false);
    });

    test('a turn is never matched past the one below it, even when its text also appears later', () => {
        const prompt = '<|user|>repeat after me\n<|bot|>repeat after me\n';
        const turns = [
            { text: 'repeat after me\n', chatIndex: 0 },
            { text: '<|bot|>repeat after me\n', chatIndex: 1 },
        ];

        const located = locateRenderedTurns(prompt, turns);

        expect(located.get(1)).toBe(prompt.indexOf('<|bot|>'));
        // Not the copy inside turn 1 — that region is already spoken for.
        expect(located.get(0)).toBe('<|user|>'.length);
    });

    test('garbage in gives an empty map, not a throw', () => {
        expect(locateRenderedTurns(null, [{ text: 'x', chatIndex: 0 }]).size).toBe(0);
        expect(locateRenderedTurns('x', null).size).toBe(0);
        expect(locateRenderedTurns('x', [null, undefined, { chatIndex: 0 }]).size).toBe(0);
    });
});

describe('the anchor on the wire — it has to survive the projection', () => {
    beforeEach(() => clearPromptInterceptors());
    afterAll(() => clearPromptInterceptors());

    /**
     * @param {any} body What the client posted
     * @returns {any} Something shaped enough like an Express request
     */
    const fakeRequest = (body) => ({ body });

    test('promptOffset is carried through to the plugin contract', () => {
        // 🔴 THE PROJECTION IS AN ALLOW-LIST, WHICH IS THE POINT AND ALSO THE HAZARD. `takeRecentMessages`
        // rebuilds each turn from named keys so ST internals cannot reach a plugin — so a new contract field
        // that nobody adds to it is dropped in silence: computed correctly on the client, carried correctly
        // on the wire, and gone. The plugin then sees a window with no offsets and cannot tell that from an
        // old fork.
        const request = fakeRequest({
            [RECENT_MESSAGES_FIELD]: [{ role: 'user', name: 'Test User', content: 'hi', index: 4, promptOffset: 1280 }],
        });

        expect(takeRecentMessages(request)).toEqual([{ role: 'user', name: 'Test User', content: 'hi', index: 4, promptOffset: 1280 }]);
    });

    test('-1 is legal and means "could not be placed"; absent means the client shipped none', () => {
        const withMiss = fakeRequest({ [RECENT_MESSAGES_FIELD]: [{ role: 'user', content: 'hi', index: 0, promptOffset: -1 }] });

        expect(takeRecentMessages(withMiss)).toEqual([{ role: 'user', content: 'hi', index: 0, promptOffset: -1 }]);
        // Not `{ …, promptOffset: undefined }`: the key is absent, so a plugin can tell an old client from a
        // turn that this client could not place.
        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: [{ role: 'user', content: 'hi', index: 0 }] }))[0])
            .not.toHaveProperty('promptOffset');
    });

    test('a nonsensical offset drops the WHOLE window, like every other malformed field', () => {
        const error = jest.spyOn(log, 'error').mockImplementation(() => { });

        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: [{ role: 'user', content: 'x', index: 0, promptOffset: -2 }] }))).toBeUndefined();
        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: [{ role: 'user', content: 'x', index: 0, promptOffset: 12.5 }] }))).toBeUndefined();
        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: [{ role: 'user', content: 'x', index: 0, promptOffset: '12' }] }))).toBeUndefined();
        expect(error).toHaveBeenCalled();

        error.mockRestore();
    });

    test('an interceptor receives the offsets alongside the prompt they point into', async () => {
        const prompt = 'STORY\n<|user|>hello\n<|bot|>hi\n';
        /** @type {any} */
        let seen = null;

        onPrompt('memory', async (outgoing) => {
            seen = outgoing;
            // What Mnemosyne actually does: splice at depth 1 rather than prepend to the front.
            const anchor = outgoing.recentMessages.at(-1).promptOffset;
            return `${outgoing.prompt.slice(0, anchor)}[MEMORY]\n${outgoing.prompt.slice(anchor)}`;
        }, { recentMessages: 2 });

        const result = await runPromptInterceptors({
            handle: 'test-user',
            backend: 'text',
            apiType: 'ooba',
            prompt,
            recentMessages: [
                { role: 'user', content: 'hello', index: 0, promptOffset: prompt.indexOf('<|user|>') },
                { role: 'assistant', content: 'hi', index: 1, promptOffset: prompt.indexOf('<|bot|>') },
            ],
        });

        expect(seen.recentMessages.map(t => t.promptOffset)).toEqual([6, 20]);
        expect(result.prompt).toBe('STORY\n<|user|>hello\n[MEMORY]\n<|bot|>hi\n');
        // 🔴 BELOW THE HISTORY, WHICH IS THE WHOLE POINT — everything before the last turn is byte-identical
        // to what the previous generation sent, so the backend's KV cache still matches on it.
        expect(result.prompt.startsWith('STORY\n<|user|>hello\n')).toBe(true);
    });
});

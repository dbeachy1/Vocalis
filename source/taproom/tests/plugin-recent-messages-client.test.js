import { describe, test, expect, jest } from '@jest/globals';

import { buildRecentMessages, isCoreMessage, splitCoreChat } from '../public/scripts/plugin-prompts.js';

/**
 * 🔴 THE ANCHOR (§17.8) — THE HALF OF `recentMessages` THAT WAS SPECIFIED WRONG THE FIRST TIME.
 *
 * A window pinned at N turns has a CONSTANT length. Every plugin doing incremental work over it — ingest,
 * checkpointing, summarization — keeps a high-water mark and asks "how much is new?" by subtracting against
 * that length. With a bounded window that subtraction is 50, then 0, then 0 for ever: the plugin stops firing,
 * permanently, with nothing in any log and a symptom ("the model has no memory") that points nowhere near the
 * cause. The fix is a per-turn index into the FULL chat array, and everything below exists because the
 * plausible cheaper fixes — the post-filter index the core-chat map already assigns, or one offset on the
 * window — fail in ways no green test would have shown.
 *
 * These are pure functions with no imports, which is deliberate: the two rules they encode are the two the
 * design got wrong, and both failures are silent, so they are tested directly rather than only through a
 * browser.
 */
describe('splitCoreChat — where an index comes from', () => {
    /**
     * A chat message, as ST stores one.
     * @param {string} mes The text
     * @param {object} [flags] is_user / is_system
     * @returns {object} The message
     */
    const message = (mes, flags = {}) => ({ mes, name: flags.is_user ? 'Test User' : 'Aria', ...flags });

    /** The prompt is built from everything that is not hidden — ST's own filter, minus the tool-call clause. */
    const isCore = (x) => !x.is_system;

    test('indices are positions in the FULL chat, not in the filtered result', () => {
        const chat = [message('a'), message('b'), message('c')];

        expect(splitCoreChat(chat, isCore, false).indices).toEqual([0, 1, 2]);
    });

    test('🔴 a hidden message leaves a GAP; the turns after it keep the numbers they had', () => {
        // The mutation this catches: numbering the turns by their position in the filtered array instead of
        // in `chat`. That renumbers everything after a `/hide` — `/hide` IS `is_system = true` — so a plugin's
        // mark lands ahead of the count and its ingest stalls until the conversation catches back up. The
        // same silent stall the anchor exists to prevent, re-entered through a different door.
        const chat = [message('a'), message('b'), message('hidden', { is_system: true }), message('d')];

        const { messages, indices } = splitCoreChat(chat, isCore, false);

        expect(messages.map(m => m.mes)).toEqual(['a', 'b', 'd']);
        expect(indices).toEqual([0, 1, 3]);
        // Not [0, 1, 2]. The message that used to be third is still the fourth thing in the conversation.
    });

    test('🔴 a swipe drops the last turn and renumbers NOTHING', () => {
        // This is the case that motivated the anchor: a swipe regenerates the last reply, so the prompt is
        // built without it. Every remaining turn must carry the index it carried a moment ago.
        const chat = [message('a'), message('b'), message('c')];

        const before = splitCoreChat(chat, isCore, false);
        const during = splitCoreChat(chat, isCore, true);

        expect(during.indices).toEqual([0, 1]);
        expect(during.indices).toEqual(before.indices.slice(0, -1));
    });

    test('a swipe over a chat with hidden messages drops the last VISIBLE turn, gaps intact', () => {
        const chat = [message('a'), message('hidden', { is_system: true }), message('c'), message('d')];

        expect(splitCoreChat(chat, isCore, true).indices).toEqual([0, 2]);
    });

    test('the messages and their indices are always the same length, and in the same order', () => {
        const chat = [message('a'), message('b', { is_system: true }), message('c'), message('d', { is_system: true })];

        const { messages, indices } = splitCoreChat(chat, isCore, false);

        expect(messages).toHaveLength(indices.length);
        expect(indices.map(index => chat[index])).toEqual(messages);
    });
});

/**
 * 🔴 THE REGRESSION GUARD FOR EVERYBODY WHO HAS NO PLUGINS AT ALL.
 *
 * §17 replaced the `coreChat` construction inside `Generate()` — a line that runs on **every generation, for
 * every user, plugin or no plugin** — so that the chat-relative indices could be captured alongside it. The
 * capability itself is inert without a registered plugin; this refactor is not. If `coreChat` came out even
 * slightly different afterwards, every prompt in the application would be subtly wrong, and no test in this
 * repository drives `Generate()` to notice.
 *
 * So this pins the equivalence directly: the ORIGINAL expression, written out verbatim as it stood before the
 * change, against what `splitCoreChat` returns, over a few thousand generated chats. It is a differential
 * test, not an example-based one, because the interesting cases are combinations — hidden messages at the
 * start, at the end, adjacent, a swipe on an all-hidden tail — and enumerating those by hand is exactly how
 * one gets missed.
 */
describe('splitCoreChat is behaviour-preserving for coreChat itself', () => {
    /**
     * `Generate()` as it stood BEFORE §17. Do not "tidy" this to call the new code; it is the control.
     * @param {object[]} chat The full chat
     * @param {boolean} canUseTools Whether tool calling is supported
     * @param {string} type The generation type
     * @returns {object[]} coreChat, exactly as it used to be built
     */
    function originalCoreChat(chat, canUseTools, type) {
        const coreChat = chat.filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)));
        if (type === 'swipe') {
            coreChat.pop();
        }
        return coreChat;
    }

    /**
     * A deterministic pseudo-random chat. Seeded so a failure is reproducible from the seed alone.
     * @param {number} seed
     * @returns {object[]} A chat
     */
    function chatFor(seed) {
        let state = seed;
        const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

        return Array.from({ length: Math.floor(next() * 12) }, (_, i) => {
            const message = { mes: `m${i}`, name: next() < 0.5 ? 'Test User' : 'Aria', is_user: next() < 0.5 };
            if (next() < 0.35) {
                message.is_system = true;
            }
            // A tool-invocation message is the one kind of is_system that SURVIVES the filter, and only when
            // tool calling is on. It is the whole reason the predicate is not simply `!x.is_system`.
            if (message.is_system && next() < 0.5) {
                message.extra = { tool_invocations: [{ name: 'something' }] };
            }
            return message;
        });
    }

    test('identical output across thousands of chats, both tool modes, swipe and not', () => {
        for (let seed = 1; seed <= 2000; seed++) {
            const chat = chatFor(seed);

            for (const canUseTools of [true, false]) {
                for (const type of ['normal', 'swipe']) {
                    const predicate = x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations));
                    const before = originalCoreChat(chat, canUseTools, type);
                    const after = splitCoreChat(chat, predicate, type === 'swipe').messages;

                    // Deep equality is not enough on its own — these must be the SAME message objects, because
                    // `Generate()` goes on to map over them and read `extra`, `is_user` and the rest.
                    expect(after).toEqual(before);
                    expect(after.every((message, i) => message === before[i])).toBe(true);
                }
            }
        }
    });

    test('the empty chat and the all-hidden chat behave as they always did', () => {
        const predicate = x => !x.is_system;

        expect(splitCoreChat([], predicate, false).messages).toEqual([]);
        // A swipe on a chat with nothing to pop must not throw, and must not go negative.
        expect(splitCoreChat([], predicate, true).messages).toEqual([]);
        expect(splitCoreChat([{ mes: 'a', is_system: true }], predicate, true).messages).toEqual([]);
    });
});

describe('buildRecentMessages — what a plugin actually receives', () => {
    /** A short conversation with a hidden message in the middle, already split. */
    const conversation = () => {
        const chat = [
            { mes: 'first', name: 'Test User', is_user: true },
            { mes: 'reply', name: 'Aria' },
            { mes: 'hidden', name: 'Aria', is_system: true },
            { mes: 'second', name: 'Test User', is_user: true },
            { mes: 'answer', name: 'Bex' },
        ];
        return { chat, ...splitCoreChat(chat, x => !x.is_system, false) };
    };

    test('normalizes to {role, name, content, index} and leaks no ST internals', () => {
        // 🔴 `mes` and `is_user` MUST NOT SURVIVE. Forwarding ST's ChatMessage would hand every plugin the
        // fork's internal shape — no `role`, no `content` — and break anything written against the chat path.
        const { messages, indices } = conversation();

        const window = buildRecentMessages(messages, indices, 10);

        expect(window).toEqual([
            { role: 'user', name: 'Test User', content: 'first', index: 0 },
            { role: 'assistant', name: 'Aria', content: 'reply', index: 1 },
            { role: 'user', name: 'Test User', content: 'second', index: 3 },
            { role: 'assistant', name: 'Bex', content: 'answer', index: 4 },
        ]);

        for (const turn of window) {
            expect(turn).not.toHaveProperty('mes');
            expect(turn).not.toHaveProperty('is_user');
            expect(turn).not.toHaveProperty('is_system');
            expect(turn).not.toHaveProperty('extra');
        }
    });

    test('🔴 the hidden message is skipped and the turn after it keeps index 3, not 2', () => {
        const { messages, indices } = conversation();

        expect(buildRecentMessages(messages, indices, 10).map(t => t.index)).toEqual([0, 1, 3, 4]);
    });

    test('the responding character is named per turn, which is what a group chat needs', () => {
        const { messages, indices } = conversation();

        // 'Aria' answered once and 'Bex' answered once. A single character name on the window could not say so.
        expect(buildRecentMessages(messages, indices, 10).map(t => t.name)).toEqual(['Test User', 'Aria', 'Test User', 'Bex']);
    });

    test('takes the LAST n turns, and their indices come with them', () => {
        const { messages, indices } = conversation();

        expect(buildRecentMessages(messages, indices, 2)).toEqual([
            { role: 'user', name: 'Test User', content: 'second', index: 3 },
            { role: 'assistant', name: 'Bex', content: 'answer', index: 4 },
        ]);
    });

    test('🔴 no declaration means undefined — never [], and never a partial window', () => {
        // Absent and empty are different facts: absent is "nobody asked", empty is "a chat with no turns". A
        // plugin must be able to tell them apart, and a silent half-window is worse than an obvious absence.
        const { messages, indices } = conversation();

        expect(buildRecentMessages(messages, indices, 0)).toBeUndefined();
        expect(buildRecentMessages(messages, indices, undefined)).toBeUndefined();
        expect(buildRecentMessages(messages, indices, -1)).toBeUndefined();

        // ...and a real chat with no turns yields [], which is the other fact.
        expect(buildRecentMessages([], [], 20)).toEqual([]);
    });

    test('a window larger than the conversation returns the whole conversation, not padding', () => {
        const { messages, indices } = conversation();

        expect(buildRecentMessages(messages, indices, 500)).toHaveLength(4);
    });

    test('turns and indices out of step send NOTHING, loudly', () => {
        // A window whose anchor does not line up with its turns reads as correct and is not. If a caller ever
        // takes the two apart and drops one, that must be a visible refusal, not quietly wrong indices.
        const error = jest.spyOn(console, 'error').mockImplementation(() => { });

        expect(buildRecentMessages([{ mes: 'a' }, { mes: 'b' }], [0], 10)).toBeUndefined();
        expect(error).toHaveBeenCalled();

        error.mockRestore();
    });

    test('a system message that survives the filter is role system, not assistant', () => {
        const chat = [{ mes: 'tool result', is_system: true, extra: { tool_invocations: [{}] } }];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        expect(buildRecentMessages(messages, indices, 5)[0].role).toBe('system');
    });

    test('a nameless turn carries name: undefined rather than an empty string', () => {
        const chat = [{ mes: 'narration', name: '' }];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        expect(buildRecentMessages(messages, indices, 5)[0].name).toBeUndefined();
    });
});

/**
 * 🔴 §22.8.2 — THE PER-TURN AVATAR KEY, WHICH IS THE CLIENT'S HALF OF STABLE IDENTITY.
 *
 * The client cannot mint an id: the map is server-owned. What it CAN answer is which card produced each turn,
 * and these are the rules for that answer. Every one of them is about refusing to guess — the failure being
 * designed against is not an error, it is a confident wrong attribution that files a durable fact about the
 * user into another character's memory.
 */
describe('buildRecentMessages — which card produced each turn (§22.8.2)', () => {
    test('a group turn is attributed by its own original_avatar, per turn', () => {
        const chat = [
            { mes: 'hi', name: 'Test User', is_user: true },
            { mes: 'hello', name: 'Marcus', original_avatar: 'Marcus.png' },
            { mes: 'indeed', name: 'Elara', original_avatar: 'Elara.png' },
        ];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        expect(buildRecentMessages(messages, indices, 10).map(t => t.avatar))
            .toEqual([undefined, 'Marcus.png', 'Elara.png']);
    });

    test('a solo turn falls back to the selected character, because there is exactly one', () => {
        // `original_avatar` is written on GROUP messages only (`group-chats.js:599`), so without this fallback
        // every solo chat would send a window of nulls and the whole feature would be group-only by accident.
        const chat = [
            { mes: 'hi', name: 'Test User', is_user: true },
            { mes: 'hello', name: 'Aria' },
        ];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        expect(buildRecentMessages(messages, indices, 10, 'Aria.png').map(t => t.avatar))
            .toEqual([undefined, 'Aria.png']);
    });

    test('🔴 with NO fallback supplied, an avatar-less character turn is undefined — not misattributed', () => {
        // This is the group case, and the gap is deliberate. `script.js` passes the fallback only when
        // `selected_group` is unset, because in a group the selected character is whoever is being drafted
        // RIGHT NOW — using it here would credit a historical turn to the wrong member. Missing a fact is
        // recoverable; filing it into another character's partition is not.
        const chat = [{ mes: 'hello', name: 'Marcus' }];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        expect(buildRecentMessages(messages, indices, 10)[0].avatar).toBeUndefined();
    });

    test('original_avatar wins over the fallback when both are present', () => {
        const chat = [{ mes: 'hello', name: 'Marcus', original_avatar: 'Marcus.png' }];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        expect(buildRecentMessages(messages, indices, 10, 'SomeoneElse.png')[0].avatar).toBe('Marcus.png');
    });

    test('🔴 a user turn is never attributed, even in a solo chat with a fallback available', () => {
        const chat = [{ mes: 'hi', name: 'Test User', is_user: true }];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        // The server turns undefined into `null`. If a user turn picked up the fallback instead, every
        // user-tier fact a memory plugin extracted would be attributed to the character, in every solo chat.
        expect(buildRecentMessages(messages, indices, 10, 'Aria.png')[0].avatar).toBeUndefined();
    });

    test('a system/narrator turn is never attributed either', () => {
        const chat = [{ mes: 'The wind rises.', is_system: true, extra: { tool_invocations: [{}] } }];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        expect(buildRecentMessages(messages, indices, 10, 'Aria.png')[0].avatar).toBeUndefined();
    });

    test('an empty original_avatar is undefined, never an empty string', () => {
        // The sentinel rule at its source. `''` composes into a valid "no character" partition downstream, so
        // it must not survive even this far.
        const chat = [{ mes: 'hello', name: 'Marcus', original_avatar: '' }];
        const { messages, indices } = splitCoreChat(chat, () => true, false);

        const { avatar } = buildRecentMessages(messages, indices, 10)[0];
        expect(avatar).toBeUndefined();
        expect(avatar).not.toBe('');
    });
});

/**
 * 🔴 THE COMPACTED-MESSAGE RULE (taproom-compactor DESIGN.md §8.3) — the one clause the Compactor
 * needs from the fork, pinned across all four quadrants of (tool-invocations × compacted) because
 * the failure it prevents is silent: without it, a compacted TOOL message stays in every prompt
 * for ever while everything browser-side believes it hidden.
 */
describe('isCoreMessage — a compacted message is out, tools or not', () => {
    const plain = { mes: 'a' };
    const hidden = { mes: 'a', is_system: true };
    const hiddenTool = { mes: 'a', is_system: true, extra: { tool_invocations: [{ name: 'search' }] } };
    const compacted = { mes: 'a', is_system: true, extra: { taproom_compactor: { seq: 1 } } };
    const compactedTool = {
        mes: 'a', is_system: true,
        extra: { taproom_compactor: { seq: 1 }, tool_invocations: [{ name: 'search' }] },
    };

    test.each([true, false])('with canUseTools=%s, the mark always wins', (canUseTools) => {
        expect(isCoreMessage(compacted, canUseTools)).toBe(false);
        expect(isCoreMessage(compactedTool, canUseTools)).toBe(false);
    });

    test('the pre-existing behavior is untouched for unmarked messages', () => {
        expect(isCoreMessage(plain, false)).toBe(true);
        expect(isCoreMessage(plain, true)).toBe(true);
        expect(isCoreMessage(hidden, false)).toBe(false);
        expect(isCoreMessage(hidden, true)).toBe(false);
        // The tool-record exception: kept only while the connection can use tools.
        expect(isCoreMessage(hiddenTool, true)).toBe(true);
        expect(isCoreMessage(hiddenTool, false)).toBe(false);
    });

    test('a manually UNHIDDEN compacted message re-enters the prompt — the user\'s override wins', () => {
        // `/unhide` clears `is_system` but leaves the mark. That is the user overriding the
        // compaction for that message (DESIGN.md §4): duplication alongside the summary, chosen
        // by them, never a silent veto of their action.
        const visibleMarked = { mes: 'a', extra: { taproom_compactor: { seq: 1 } } };
        expect(isCoreMessage(visibleMarked, true)).toBe(true);
        expect(isCoreMessage(visibleMarked, false)).toBe(true);
    });
});

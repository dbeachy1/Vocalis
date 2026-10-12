import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import {
    onChatDeleted,
    notifyChatDeleted,
    onChatRenamed,
    notifyChatRenamed,
    clearChatLifecycleHandlers,
    chatIdFromPath,
} from '../src/chat-lifecycle.js';

/**
 * 🔴 §24 — THE SIGNAL EXISTS TO DELETE ROWS, SO THE ONLY FAILURE THAT MATTERS IS THE SILENT ONE.
 *
 * A consumer keys its scenario rows on `s:<chatId>`, composed at WRITE time from the id the fork handed it
 * during generation. If the id in this signal is spelled even slightly differently — a surviving `.jsonl`, a
 * directory component, a different case — the consumer's delete matches **zero rows and reports success**.
 * Nothing errors, nothing logs, and the rows persist for the life of the install because there is no garbage
 * collector behind them.
 *
 * So the interesting tests here are not "does the handler fire" but "is the id spelled the way the generation
 * header spells it", which is what `chatIdFromPath` exists to guarantee by construction.
 */
describe('💬 chat lifecycle: the id has to be spelled the way the header spells it', () => {
    beforeEach(() => {
        clearChatLifecycleHandlers();
    });

    describe('chatIdFromPath — byte-identity by construction', () => {
        test('🔴 strips .jsonl, because getCurrentChatId() does not include it', () => {
            // `getCurrentChatId()` returns `characters[this_chid].chat` — the filename WITHOUT the extension.
            // `/api/chats/delete` accepts `chatfile` with or WITHOUT it and appends it when missing, so the
            // request body is not a reliable spelling and deriving from it would miss on half the requests.
            expect(chatIdFromPath('/data/default-user/chats/Seraphina/2026-07-18 @20h.jsonl'))
                .toBe('2026-07-18 @20h');
        });

        test('takes the basename — a directory component must never reach the id', () => {
            expect(chatIdFromPath('/data/default-user/chats/Seraphina/chat.jsonl')).toBe('chat');
        });

        test('handles Windows separators, since this runs on both', () => {
            expect(chatIdFromPath('B:\\data\\default-user\\chats\\Seraphina\\chat.jsonl')).toBe('chat');
        });

        test('a name that is already an id passes through unchanged', () => {
            expect(chatIdFromPath('e4c9f1a2-0b77-4a1e-9d3f-2c8a5b6e7f01')).toBe('e4c9f1a2-0b77-4a1e-9d3f-2c8a5b6e7f01');
        });

        test('⚠️ only a TRAILING .jsonl is stripped, not one in the middle of a name', () => {
            // A chat the user named "notes.jsonl backup" is a real name, not an extension.
            expect(chatIdFromPath('/chats/x/notes.jsonl backup.jsonl')).toBe('notes.jsonl backup');
        });

        test('a dot in a chat name survives — only the extension goes', () => {
            expect(chatIdFromPath('/chats/x/Dr. Vance, 2026.jsonl')).toBe('Dr. Vance, 2026');
        });
    });

    describe('delivery', () => {
        test('every handler is called, with the owner and the id', async () => {
            /** @type {any[]} */
            const seen = [];
            onChatDeleted((handle, chatId) => { seen.push(['a', handle, chatId]); });
            onChatDeleted((handle, chatId) => { seen.push(['b', handle, chatId]); });

            await notifyChatDeleted('test-user', 'chat-1');

            expect(seen).toEqual([['a', 'test-user', 'chat-1'], ['b', 'test-user', 'chat-1']]);
        });

        test('🔴 one plugin throwing does not stop the others, and does not take the deletion down', async () => {
            // The chat is already gone by the time this fires. A handler that throws must not turn a
            // successful delete into a 500, or a user cannot delete a chat because a plugin is broken.
            const error = jest.spyOn(console, 'error').mockImplementation(() => { });
            /** @type {string[]} */
            const seen = [];

            onChatDeleted(() => { throw new Error('plugin is broken'); });
            onChatDeleted((_handle, chatId) => { seen.push(chatId); });

            await expect(notifyChatDeleted('test-user', 'chat-1')).resolves.toBeUndefined();
            expect(seen).toEqual(['chat-1']);

            error.mockRestore();
        });

        test('an async handler is awaited, so the fork does not answer before the plugin has finished', async () => {
            /** @type {string[]} */
            const order = [];

            onChatDeleted(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                order.push('handler done');
            });

            await notifyChatDeleted('test-user', 'chat-1');
            order.push('notify returned');

            expect(order).toEqual(['handler done', 'notify returned']);
        });

        test('firing twice for the same chat is allowed — overlapping delete paths must not need dedup', async () => {
            /** @type {string[]} */
            const seen = [];
            onChatDeleted((_handle, chatId) => { seen.push(chatId); });

            await notifyChatDeleted('test-user', 'chat-1');
            await notifyChatDeleted('test-user', 'chat-1');

            expect(seen).toEqual(['chat-1', 'chat-1']);
        });

        test('a missing handle or id fires nothing rather than delivering a half-identified event', async () => {
            /** @type {any[]} */
            const seen = [];
            onChatDeleted((handle, chatId) => { seen.push([handle, chatId]); });

            await notifyChatDeleted('', 'chat-1');
            await notifyChatDeleted('test-user', '');
            await notifyChatDeleted(undefined, undefined);

            expect(seen).toEqual([]);
        });

        test('registering something that is not a function is refused at registration', () => {
            expect(() => onChatDeleted('not a function')).toThrow(TypeError);
        });
    });
});

/**
 * 🔴 §24.4 — A RENAME IS A MOVE, AND THE TWO WAYS TO GET IT WRONG LOSE DATA IN OPPOSITE DIRECTIONS.
 *
 * Renaming a chat changes its `chatId` while the chat still exists. Say nothing and the consumer's rows sit
 * under a key nothing will ever query again — live data loss on a conversation the user is still in the
 * middle of. Say "deleted" instead and the consumer throws those same rows away on purpose, which is worse.
 * Hence a distinct signal carrying both ids, and hence the isolation tests below: `notifyChatRenamed` must
 * never reach an `onChatDeleted` handler, in either direction.
 *
 * The `oldChatId === newChatId` guard is the other load-bearing one. A consumer asked to re-key a partition
 * onto itself is at best doing pointless work and at worst destroying it, depending on whether its
 * implementation moves rows or deletes-then-writes them.
 */
describe('✏️  §24.4 chat rename: the rows moved, they did not die', () => {
    beforeEach(() => {
        clearChatLifecycleHandlers();
    });

    describe('delivery', () => {
        test('every handler is called, with the owner and BOTH ids in order', async () => {
            /** @type {any[]} */
            const seen = [];
            onChatRenamed((handle, oldChatId, newChatId) => { seen.push(['a', handle, oldChatId, newChatId]); });
            onChatRenamed((handle, oldChatId, newChatId) => { seen.push(['b', handle, oldChatId, newChatId]); });

            await notifyChatRenamed('test-user', 'old-chat', 'new-chat');

            expect(seen).toEqual([
                ['a', 'test-user', 'old-chat', 'new-chat'],
                ['b', 'test-user', 'old-chat', 'new-chat'],
            ]);
        });

        test('🔴 the argument ORDER is (old, new) — reversing it re-keys the live partition onto the dead id', async () => {
            // Not pedantry. Both arguments are strings, so a consumer that had them the wrong way round would
            // still run, still report success, and would file the surviving chat's memories under the id that
            // no longer exists. Nothing would raise.
            /** @type {any} */
            let captured = null;
            onChatRenamed((_handle, oldChatId, newChatId) => { captured = { oldChatId, newChatId }; });

            await notifyChatRenamed('test-user', 'before', 'after');

            expect(captured).toEqual({ oldChatId: 'before', newChatId: 'after' });
        });

        test('🔴 one plugin throwing does not stop the others, and does not take the rename down', async () => {
            // The file has already moved by the time this fires. A handler that throws must not turn a
            // successful rename into a 500, or a user cannot rename a chat because a plugin is broken.
            const error = jest.spyOn(console, 'error').mockImplementation(() => { });
            /** @type {string[]} */
            const seen = [];

            onChatRenamed(() => { throw new Error('plugin is broken'); });
            onChatRenamed((_handle, oldChatId) => { seen.push(oldChatId); });

            await expect(notifyChatRenamed('test-user', 'old-chat', 'new-chat')).resolves.toBeUndefined();
            expect(seen).toEqual(['old-chat']);

            error.mockRestore();
        });

        test('an async handler is awaited, so the fork does not answer before the re-key has finished', async () => {
            // This one matters more than its deletion counterpart: the client updates its in-memory chat id
            // from the RESPONSE, so anything the consumer must finish before the next generation has to finish
            // before we answer.
            /** @type {string[]} */
            const order = [];

            onChatRenamed(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                order.push('handler done');
            });

            await notifyChatRenamed('test-user', 'old-chat', 'new-chat');
            order.push('notify returned');

            expect(order).toEqual(['handler done', 'notify returned']);
        });
    });

    describe('the guards', () => {
        test('🔴 a rename to the SAME id fires nothing — nobody is asked to re-key a partition onto itself', async () => {
            /** @type {any[]} */
            const seen = [];
            onChatRenamed((handle, oldChatId, newChatId) => { seen.push([handle, oldChatId, newChatId]); });

            await notifyChatRenamed('test-user', 'same-chat', 'same-chat');

            expect(seen).toEqual([]);
        });

        test('⚠️ but a case-only change IS a rename, because a case-sensitive filesystem says so', async () => {
            // The same-id guard is exact and deliberately case-SENSITIVE. On Linux `Foo` and `foo` are two
            // different files with two different chat ids, so suppressing this would strand real rows. (The
            // endpoint's own `exists` check is what refuses it on Windows, where it is not a real rename.)
            /** @type {any[]} */
            const seen = [];
            onChatRenamed((_handle, oldChatId, newChatId) => { seen.push([oldChatId, newChatId]); });

            await notifyChatRenamed('test-user', 'Foo', 'foo');

            expect(seen).toEqual([['Foo', 'foo']]);
        });

        test('a missing handle or either id fires nothing rather than a half-identified event', async () => {
            /** @type {any[]} */
            const seen = [];
            onChatRenamed((handle, oldChatId, newChatId) => { seen.push([handle, oldChatId, newChatId]); });

            await notifyChatRenamed('', 'old-chat', 'new-chat');
            await notifyChatRenamed('test-user', '', 'new-chat');
            await notifyChatRenamed('test-user', 'old-chat', '');
            await notifyChatRenamed(undefined, undefined, undefined);

            expect(seen).toEqual([]);
        });

        test('registering something that is not a function is refused at registration', () => {
            expect(() => onChatRenamed('not a function')).toThrow(TypeError);
        });
    });

    describe('🔴 the two signals are not each other', () => {
        test('a rename does NOT reach an onChatDeleted handler', async () => {
            // The expensive confusion. A consumer wired only for deletion, hearing a rename as a delete, would
            // discard the memories of a chat the user is still in.
            /** @type {any[]} */
            const deleted = [];
            /** @type {any[]} */
            const renamed = [];
            onChatDeleted((handle, chatId) => { deleted.push([handle, chatId]); });
            onChatRenamed((handle, oldChatId, newChatId) => { renamed.push([handle, oldChatId, newChatId]); });

            await notifyChatRenamed('test-user', 'old-chat', 'new-chat');

            expect(deleted).toEqual([]);
            expect(renamed).toEqual([['test-user', 'old-chat', 'new-chat']]);
        });

        test('a delete does NOT reach an onChatRenamed handler', async () => {
            /** @type {any[]} */
            const deleted = [];
            /** @type {any[]} */
            const renamed = [];
            onChatDeleted((handle, chatId) => { deleted.push([handle, chatId]); });
            onChatRenamed((handle, oldChatId, newChatId) => { renamed.push([handle, oldChatId, newChatId]); });

            await notifyChatDeleted('test-user', 'gone-chat');

            expect(renamed).toEqual([]);
            expect(deleted).toEqual([['test-user', 'gone-chat']]);
        });

        test('🔴 clearChatLifecycleHandlers() forgets RENAME handlers too, or suites leak into each other', async () => {
            // A handler surviving `clearChatLifecycleHandlers()` would make every later test in the process
            // see events it never registered for — and the failure would land in whichever suite ran next,
            // not in the one that caused it.
            /** @type {any[]} */
            const seen = [];
            onChatRenamed((_handle, oldChatId) => { seen.push(oldChatId); });

            clearChatLifecycleHandlers();
            await notifyChatRenamed('test-user', 'old-chat', 'new-chat');

            expect(seen).toEqual([]);
        });
    });
});

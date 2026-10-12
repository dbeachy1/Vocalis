import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { getOrMintCharacterId } from '../src/character-ids.js';
import { clearPromptInterceptors, onPrompt, runPromptInterceptors, takeRecentMessages } from '../src/generation-interceptors.js';
import { readChat } from '../src/plugin-read-chat.js';
import { registerStorageProvider, unregisterStorageProvider, StorageError, EUNAVAILABLE, EPROVIDER } from '../src/storage.js';
import { buildRecentMessages, isCoreMessage, splitCoreChat } from '../public/scripts/plugin-prompts.js';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * 🔴 PLUGIN API v7 — `context.readChat`, and the promise that makes it useful: a turn read from disk is the SAME
 * turn `recentMessages` delivered during a generation.
 *
 * Mnemosyne keeps a high-water mark in `index` and runs one extraction path over turns from either source. A
 * rescan that numbered turns differently would overlap or skip with no error; one whose `charId` or `sendDate`
 * differed would store duplicates the dedup check cannot recognise. So the central test here builds both paths
 * from ONE chat fixture — the client's real window builder feeding the server's real intake and identity
 * resolution on one side, `readChat` on the other — and requires the turns to be equal field by field.
 */
describe('🔌 context.readChat (plugin API v7)', () => {
    /** @type {string} */
    let root;
    /** @type {{root: string, chats: string, groupChats: string}} */
    let directories;

    beforeEach(() => {
        root = makeScratchDirectory('read-chat');
        directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats') };
        fs.mkdirSync(directories.chats, { recursive: true });
        fs.mkdirSync(directories.groupChats, { recursive: true });
        unregisterStorageProvider();
        clearPromptInterceptors();
    });

    afterEach(() => {
        unregisterStorageProvider();
        clearPromptInterceptors();
        fs.rmSync(root, { recursive: true, force: true });
    });

    /**
     * Write a chat file the way ST does: one JSON object per line.
     * @param {string} file Absolute path
     * @param {object[]} rows Header and messages
     * @returns {void}
     */
    function writeChat(file, rows) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'), 'utf-8');
    }

    const header = { user_name: 'Test User', character_name: 'Marcus', create_date: '2026-09-18@10h00m00s', chat_metadata: { integrity: 'x' } };

    /** A solo chat with a hidden message, a legacy timestamp, a message with no time and a bad one. */
    const soloMessages = [
        { name: 'Marcus', is_user: false, mes: 'Hello, Test User.', send_date: '2026-09-18T10:00:00.000Z' },
        { name: 'Test User', is_user: true, mes: 'Hi Marcus.', send_date: '2026-09-18T10:00:05.000Z' },
        { name: 'Marcus', is_user: false, is_system: true, mes: 'A hidden aside.', send_date: '2026-09-18T10:00:10.000Z' },
        { name: 'Marcus', is_user: false, mes: 'I remember the lighthouse.', send_date: '2024-7-12@01h31m37s123ms' },
        { name: 'Test User', is_user: true, mes: 'Tell me more.' },
        { name: 'Marcus', is_user: false, mes: 'It was in Maine.', send_date: 'sometime last spring' },
    ];

    const soloChatId = 'Marcus - 2026-09-18@10h00m00s';

    /** @returns {Promise<string>} Marcus's id, minted as a generation would have minted it */
    const mintMarcus = () => getOrMintCharacterId(root, 'Marcus.png');

    describe('🔴 parity with recentMessages — one fixture, both paths, equal turns', () => {
        test('a solo chat: every turn equal in index, content, charId and sendDate', async () => {
            await mintMarcus();
            writeChat(path.join(directories.chats, 'Marcus', `${soloChatId}.jsonl`), [header, ...soloMessages]);

            // THE GENERATION PATH, end to end on the server: the client's own window builder (with the chat
            // array as the client holds it — header removed), then the wire intake and identity resolution a
            // real generation goes through.
            const chat = soloMessages.map(message => ({ ...message }));
            const { messages, indices } = splitCoreChat(chat, message => isCoreMessage(message, false), false);
            const window = buildRecentMessages(messages, indices, 50, 'Marcus.png');
            const request = { body: { st_recent_messages: JSON.parse(JSON.stringify(window)) } };

            /** @type {any} */
            let seen;
            onPrompt('memory', async (outgoing) => { seen = outgoing; }, { recentMessages: 50 });
            await runPromptInterceptors({
                handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p', userRoot: root,
                charAvatar: 'Marcus.png', recentMessages: takeRecentMessages(request),
            });

            // THE DISK PATH.
            const read = await readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: soloChatId });

            expect(read).toEqual(seen.recentMessages);
            expect(read).toHaveLength(5);
        });

        test('a group chat: parity holds and each turn keeps its own speaker', async () => {
            const marcus = await mintMarcus();
            const elara = await getOrMintCharacterId(root, 'Elara.png');
            const groupMessages = [
                { name: 'Marcus', is_user: false, mes: 'Welcome.', original_avatar: 'Marcus.png', send_date: '2026-09-18T11:00:00.000Z' },
                { name: 'Test User', is_user: true, mes: 'Thanks.', send_date: '2026-09-18T11:00:01.000Z' },
                { name: 'Elara', is_user: false, mes: 'Hello there.', original_avatar: 'Elara.png', send_date: '2026-09-18T11:00:02.000Z' },
                // A turn with no avatar: in a group there is no fallback, so null — on both paths.
                { name: 'Narrator', is_user: false, mes: 'Rain falls.', send_date: '2026-09-18T11:00:03.000Z' },
            ];
            writeChat(path.join(directories.groupChats, '1726650000000.jsonl'), [{ chat_metadata: {} }, ...groupMessages]);

            const { messages, indices } = splitCoreChat(groupMessages, message => isCoreMessage(message, false), false);
            const window = buildRecentMessages(messages, indices, 50, undefined);
            /** @type {any} */
            let seen;
            onPrompt('memory', async (outgoing) => { seen = outgoing; }, { recentMessages: 50 });
            await runPromptInterceptors({
                handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p', userRoot: root,
                charAvatar: 'Elara.png', recentMessages: takeRecentMessages({ body: { st_recent_messages: window } }),
            });

            const read = await readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: '1726650000000' });

            expect(read).toEqual(seen.recentMessages);
            expect(read.map(turn => turn.charId)).toEqual([marcus, null, elara, null]);
        });
    });

    describe('the numbering', () => {
        test('🔴 a hidden message is excluded and leaves a GAP — later turns keep their chat positions', async () => {
            await mintMarcus();
            writeChat(path.join(directories.chats, 'Marcus', `${soloChatId}.jsonl`), [header, ...soloMessages]);

            const read = await readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: soloChatId });

            expect(read.map(turn => turn.index)).toEqual([0, 1, 3, 4, 5]);
            expect(read.map(turn => turn.content)).not.toContain('A hidden aside.');
        });

        test('a solo chat\'s first row is always the header; a group chat\'s only when it carries chat_metadata', async () => {
            // Old group files had no header. Dropping their first row anyway would lose a real message and shift
            // every index down by one — the client's `getGroupChat` checks for `chat_metadata`, so this must too.
            const rows = [{ name: 'Test User', is_user: true, mes: 'first' }, { name: 'Test User', is_user: true, mes: 'second' }];
            writeChat(path.join(directories.groupChats, 'old-group.jsonl'), rows);

            const read = await readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: 'old-group' });

            expect(read.map(turn => [turn.index, turn.content])).toEqual([[0, 'first'], [1, 'second']]);
        });

        test('an unparseable line is dropped before numbering, exactly as getChatData drops it', async () => {
            const file = path.join(directories.chats, 'Marcus', 'broken.jsonl');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, [JSON.stringify(header), '{not json', JSON.stringify({ name: 'Test User', is_user: true, mes: 'after' })].join('\n'), 'utf-8');

            const read = await readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: 'broken' });

            // The client's chat array is `getChatData`'s output minus the header, so the message is at 0 there.
            expect(read.map(turn => turn.index)).toEqual([0]);
        });

        test('`last` returns the trailing N core turns, with their full-chat indices', async () => {
            writeChat(path.join(directories.chats, 'Marcus', `${soloChatId}.jsonl`), [header, ...soloMessages]);

            const read = await readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: soloChatId, last: 2 });

            expect(read.map(turn => turn.index)).toEqual([4, 5]);
        });
    });

    describe('sendDate', () => {
        test('epoch ms for ISO and legacy formats; null — never 0, never now — when absent or unrecognized', async () => {
            writeChat(path.join(directories.chats, 'Marcus', `${soloChatId}.jsonl`), [header, ...soloMessages]);

            const read = await readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: soloChatId });

            expect(read[0].sendDate).toBe(Date.parse('2026-09-18T10:00:00.000Z'));
            expect(read[2].sendDate).toBe(new Date(2024, 6, 12, 1, 31, 37, 123).getTime());
            expect(read[3].sendDate).toBeNull();
            expect(read[4].sendDate).toBeNull();
            // The raw field is fork-internal and never reaches a plugin.
            for (const turn of read) {
                expect(turn).not.toHaveProperty('send_date');
                expect(turn).not.toHaveProperty('avatar');
            }
        });
    });

    describe('null and throw are different answers', () => {
        test('an id no chat carries is null', async () => {
            await expect(readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: 'nobody' })).resolves.toBeNull();
        });

        test('a renamed chat is readable under its NEW id at once, and the old id is null', async () => {
            const oldFile = path.join(directories.chats, 'Marcus', `${soloChatId}.jsonl`);
            writeChat(oldFile, [header, ...soloMessages]);
            // What `/api/chats/rename` does to the file (§24.4).
            fs.renameSync(oldFile, path.join(directories.chats, 'Marcus', 'The lighthouse.jsonl'));

            await expect(readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: 'The lighthouse' })).resolves.toHaveLength(5);
            await expect(readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: soloChatId })).resolves.toBeNull();
        });

        test('a chat with no core turns is an empty array, not null', async () => {
            writeChat(path.join(directories.chats, 'Marcus', 'empty.jsonl'), [header]);

            await expect(readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: 'empty' })).resolves.toEqual([]);
        });

        test('🔴 a LOCKED vault throws — even when the provider reports every file as absent', async () => {
            writeChat(path.join(directories.chats, 'Marcus', `${soloChatId}.jsonl`), [header, ...soloMessages]);
            // The shape a locked provider can take: nothing exists, nothing lists. Without the readiness check
            // that reads as "no such chat" and a rescan reports success having read nothing.
            registerStorageProvider(lockedProvider());

            await expect(readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: soloChatId })).rejects.toThrow(/locked/);
        });

        test('a provider that cannot decrypt the file throws, naming the plugin', async () => {
            writeChat(path.join(directories.chats, 'Marcus', `${soloChatId}.jsonl`), [header, ...soloMessages]);

            await expect(readChat({
                pluginId: 'memory', handle: 'test-user', directories, chatId: soloChatId,
                io: {
                    isReady: () => true,
                    exists: p => fs.existsSync(p),
                    listDirectories: p => fs.readdirSync(p),
                    readFile: async p => { throw new StorageError(EPROVIDER, 'Bad key.', p); },
                    lookupCharacterIds: async () => [],
                },
            })).rejects.toThrow(/memory.*could not read chat/);
        });

        test('two chats with the same id throw rather than guess which was meant', async () => {
            writeChat(path.join(directories.chats, 'Marcus', 'Shared.jsonl'), [header, ...soloMessages]);
            writeChat(path.join(directories.chats, 'Elara', 'Shared.jsonl'), [header, ...soloMessages]);

            await expect(readChat({ pluginId: 'memory', handle: 'test-user', directories, chatId: 'Shared' })).rejects.toThrow(/2 chats share this id/);
        });
    });
});

/**
 * A provider that is locked: not ready, every read refused, nothing visible.
 * @returns {any} The provider
 */
function lockedProvider() {
    const refuse = (p) => { throw new StorageError(EUNAVAILABLE, 'Locked.', p); };
    return {
        id: 'locked-for-test',
        owns: () => true,
        init: async () => { }, isReady: () => false, unlock: async () => { }, lock: () => { }, rekey: async () => { },
        readFile: async (p) => refuse(p),
        readFileSync: (p) => refuse(p),
        writeFile: async (p) => refuse(p),
        writeFileSync: (p) => refuse(p),
        createReadStream: () => { throw new Error('nope'); },
        createWriteStream: () => { throw new Error('nope'); },
        exists: () => false, stat: () => { throw new Error('nope'); }, readdir: () => [],
        mkdir: () => { }, unlink: () => { }, rename: () => { }, copyFile: () => { }, cp: () => { }, rm: () => { },
        sendFile: async () => { },
    };
}

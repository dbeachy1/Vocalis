import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { getOrMintCharacterId, CHARACTER_IDS_FILE } from '../src/character-ids.js';
import { clearPromptInterceptors, onPrompt, runPromptInterceptors, takeRecentMessages } from '../src/generation-interceptors.js';
import { registerStorageProvider, unregisterStorageProvider, StorageError, EUNAVAILABLE } from '../src/storage.js';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * 🔴 §22.9 ITEMS 10–14 — THE ASSERTIONS THAT CATCH A FIELD POPULATED FROM THE WRONG SOURCE.
 *
 * The module tests (`character-ids.test.js`) prove the map behaves. These prove the WIRE behaves: that what a
 * plugin is handed describes the character who produced each turn, rather than the one who happens to be
 * speaking, and that an avatar filename never reaches a plugin at all.
 *
 * The bug this file exists to catch does not throw. A per-turn `charId` filled in from ambient character state
 * passes every other test in the repo — the field is present, it is a real id, it belongs to a real character
 * — and is wrong on every turn but the last. In a group chat that means filing a durable fact about the user
 * into whichever character was drafted when a counter tripped, which is the exact bug §22.8.1 exists to fix.
 */
describe('🔌 §22 on the wire: who produced the turn, not who is speaking', () => {
    /** @type {string} */
    let root;

    beforeEach(() => {
        root = makeScratchDirectory('charid-wire');
        unregisterStorageProvider();
        clearPromptInterceptors();
    });

    afterEach(() => {
        unregisterStorageProvider();
        clearPromptInterceptors();
        fs.rmSync(root, { recursive: true, force: true });
    });

    /**
     * Registers a handler that captures the one thing under test.
     * @param {number} window How many turns to declare
     * @returns {() => any} Whatever the handler last saw
     */
    function capture(window = 50) {
        /** @type {any} */
        let seen;
        onPrompt('memory', async (outgoing) => { seen = outgoing; }, { recentMessages: window });
        return () => seen;
    }

    /**
     * One generation, as the endpoints assemble it.
     * @param {object} extra Identity and window
     * @returns {Promise<any>} The resolved prompt
     */
    const generate = (extra) => runPromptInterceptors({
        handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p', userRoot: root, ...extra,
    });

    /**
     * A turn as `takeRecentMessages` yields one — with the client's per-turn avatar key.
     * @param {number} index Position in the full chat
     * @param {string|undefined} avatar Who produced it
     * @param {string} [name] Display name
     * @returns {any} The turn
     */
    const turn = (index, avatar, name) => ({
        role: avatar ? 'assistant' : 'user',
        ...(name ? { name } : {}),
        content: `turn ${index}`,
        index,
        ...(avatar ? { avatar } : {}),
    });

    describe('the active character', () => {
        test('an avatar filename is minted into an id, and the filename never reaches the plugin', async () => {
            const seen = capture();
            await generate({ charAvatar: 'Marcus.png', personaId: 'test-user.png' });

            expect(seen().charId).toEqual(expect.any(String));
            expect(seen().personaId).toBe('test-user.png');

            // 🔴 An avatar filename is fork internals — §17.5's rule, and the reason `mes` and `is_user` are
            // not on the contract either. A plugin that could see it might key on it, and then a rename would
            // move it out from under them: the exact failure §22 exists to end.
            expect(seen()).not.toHaveProperty('charAvatar');
            expect(seen()).not.toHaveProperty('userRoot');
        });

        test('the id is STABLE across generations — minting is not a per-request event', async () => {
            const seen = capture();

            await generate({ charAvatar: 'Marcus.png' });
            const first = seen().charId;

            await generate({ charAvatar: 'Marcus.png' });
            expect(seen().charId).toBe(first);
        });

        test('no character selected yields null, never an empty string', async () => {
            const seen = capture();
            await generate({ charAvatar: undefined });

            expect(seen().charId).toBeNull();
        });

        test('§22.9 item 9 — the axes are independent', async () => {
            const seen = capture();

            await generate({ charAvatar: 'Marcus.png', personaId: 'test-user.png' });
            const marcusAsDoug = { charId: seen().charId, personaId: seen().personaId };

            await generate({ charAvatar: 'Marcus.png', personaId: 'voss.png' });
            const marcusAsVoss = { charId: seen().charId, personaId: seen().personaId };

            await generate({ charAvatar: 'Elara.png', personaId: 'test-user.png' });
            const elaraAsDoug = { charId: seen().charId, personaId: seen().personaId };

            // One character, two personas: same charId, different personaId.
            expect(marcusAsVoss.charId).toBe(marcusAsDoug.charId);
            expect(marcusAsVoss.personaId).not.toBe(marcusAsDoug.personaId);

            // Two characters, one persona: the reverse. This is what catches the two being quietly conflated
            // into a single composite key somewhere downstream.
            expect(elaraAsDoug.personaId).toBe(marcusAsDoug.personaId);
            expect(elaraAsDoug.charId).not.toBe(marcusAsDoug.charId);
        });
    });

    describe('§22.9 item 11 — per-turn ids follow the SPEAKER OF EACH TURN', () => {
        test('🔴 two members alternating produce ALTERNATING ids, not the drafted member on every turn', async () => {
            // This is the assertion a field populated from ambient character state fails, and the only one.
            const marcus = await getOrMintCharacterId(root, 'Marcus.png');
            const elara = await getOrMintCharacterId(root, 'Elara.png');
            expect(marcus).not.toBe(elara);

            const seen = capture();
            await generate({
                charAvatar: 'Marcus.png',   // Marcus is the one being drafted RIGHT NOW
                recentMessages: [
                    turn(0, undefined, 'Test User'),
                    turn(1, 'Marcus.png', 'Marcus'),
                    turn(2, undefined, 'Test User'),
                    turn(3, 'Elara.png', 'Elara'),
                    turn(4, 'Marcus.png', 'Marcus'),
                    turn(5, 'Elara.png', 'Elara'),
                ],
            });

            expect(seen().recentMessages.map(t => t.charId)).toEqual([
                null, marcus, null, elara, marcus, elara,
            ]);
        });

        test('the avatar key is stripped from every turn on the way out', async () => {
            const seen = capture();
            await generate({ recentMessages: [turn(0, 'Marcus.png', 'Marcus'), turn(1, undefined, 'Test User')] });

            for (const t of seen().recentMessages) {
                expect(t).not.toHaveProperty('avatar');
                expect(t).toHaveProperty('charId');
            }
        });

        test('name and index still arrive unchanged — this is additive', async () => {
            // Minted first ON PURPOSE. Written without this line the assertion failed with `charId: null`,
            // which is the lookup-never-mints rule doing its job: a window naming a character the map has not
            // seen resolves to null rather than inventing an identity for them.
            const marcus = await getOrMintCharacterId(root, 'Marcus.png');

            const seen = capture();
            await generate({ recentMessages: [turn(7, 'Marcus.png', 'Marcus')] });

            expect(seen().recentMessages[0]).toEqual({
                // `sendDate` joined in API v7, additively; this turn sent no `send_date`, so it is null.
                role: 'assistant', name: 'Marcus', content: 'turn 7', index: 7, charId: marcus, sendDate: null,
            });
        });
    });

    describe('§22.9 item 10 — null, never the empty string', () => {
        test('🔴 a user turn carries null', async () => {
            const seen = capture();
            await generate({ recentMessages: [turn(0, undefined, 'Test User')] });

            // Asserted as identity, not falsiness. `''` is falsy AND composes through the consumer's scopeKey
            // into `u::<personaId>` — a structurally valid "no character" partition that silently collects
            // every user-tier fact from any window containing a user turn. `toBeFalsy()` passes on that bug.
            expect(seen().recentMessages[0].charId).toBeNull();
            expect(seen().recentMessages[0].charId).not.toBe('');
        });

        test('a system/narrator turn carries null', async () => {
            const seen = capture();
            await generate({ recentMessages: [{ role: 'system', content: 'The wind rises.', index: 3 }] });

            expect(seen().recentMessages[0].charId).toBeNull();
        });

        test('a turn by a character the map has never seen carries null — it does NOT mint', async () => {
            const seen = capture();
            await generate({ recentMessages: [turn(0, 'Deleted.png', 'Ghost')] });

            expect(seen().recentMessages[0].charId).toBeNull();

            // And nothing was written AT ALL — the map file does not even exist. Minting here would grow it
            // without bound with ids for characters nobody can address.
            expect(fs.existsSync(path.join(root, CHARACTER_IDS_FILE))).toBe(false);
        });
    });

    describe('§22.9 item 12 — two group members sharing a display name', () => {
        test('🔴 identical names, different ids, and the window keeps them apart', async () => {
            // No test keyed on names can see this, which is the entire reason the field exists.
            const one = await getOrMintCharacterId(root, 'Marcus.png');
            const two = await getOrMintCharacterId(root, 'Marcus_1.png');

            const seen = capture();
            await generate({
                recentMessages: [turn(0, 'Marcus.png', 'Marcus'), turn(1, 'Marcus_1.png', 'Marcus')],
            });

            const [a, b] = seen().recentMessages;
            expect(a.name).toBe(b.name);         // the display names are identical...
            expect(a.charId).toBe(one);          // ...and the identities are not
            expect(b.charId).toBe(two);
            expect(a.charId).not.toBe(b.charId);
        });
    });

    describe('§22.9 item 13 — a renamed member\'s historical turns still resolve', () => {
        test('🔴 rename the map key, and turns carrying the NEW avatar keep the SAME id', async () => {
            const { renameCharacterId } = await import('../src/character-ids.js');

            const before = await getOrMintCharacterId(root, 'Marcus.png');
            await renameCharacterId(root, 'Marcus.png', 'Marcus Aurelius.png');

            // `renameGroupMember` rewrites `original_avatar` in every past group message, unconditionally and
            // BEFORE the "update past chats?" popup (`public/script.js:7318`) — so historical turns arrive
            // carrying the new filename. This test pins that: if a refactor ever moves that call behind the
            // popup, old turns arrive with the OLD avatar, resolve to null, and only this fails.
            const seen = capture();
            await generate({ recentMessages: [turn(0, 'Marcus Aurelius.png', 'Marcus Aurelius')] });

            expect(seen().recentMessages[0].charId).toBe(before);
        });
    });

    describe('§22.9 item 14 — the solo fallback', () => {
        test('a solo assistant turn resolves even though no message carries an avatar', async () => {
            // In a solo chat `original_avatar` is never written, so the CLIENT supplies the selected character
            // (see buildRecentMessages). By the time the window reaches here the avatar is already on the turn
            // — this asserts the resolution end of that, i.e. that solo windows are not all nulls.
            const marcus = await getOrMintCharacterId(root, 'Marcus.png');

            const seen = capture();
            await generate({ charAvatar: 'Marcus.png', recentMessages: [turn(1, 'Marcus.png', 'Marcus')] });

            expect(seen().recentMessages[0].charId).toBe(marcus);
        });
    });

    describe('degrading without failing', () => {
        test('🔴 a locked map yields null ids and lets the generation THROUGH', async () => {
            await getOrMintCharacterId(root, 'Marcus.png');
            registerStorageProvider({
                id: 'locked-for-test',
                owns: () => true,
                init: async () => { }, isReady: () => false, unlock: async () => { }, lock: () => { }, rekey: async () => { },
                readFile: async (p) => { throw new StorageError(EUNAVAILABLE, 'Locked.', p); },
                readFileSync: (p) => { throw new StorageError(EUNAVAILABLE, 'Locked.', p); },
                writeFile: async (p) => { throw new StorageError(EUNAVAILABLE, 'Locked.', p); },
                writeFileSync: (p) => { throw new StorageError(EUNAVAILABLE, 'Locked.', p); },
                createReadStream: () => { throw new Error('nope'); },
                createWriteStream: () => { throw new Error('nope'); },
                exists: () => false, stat: () => { throw new Error('nope'); }, readdir: () => [],
                mkdir: () => { }, unlink: () => { }, rename: () => { }, copyFile: () => { }, cp: () => { }, rm: () => { },
                sendFile: async () => { },
            });

            const seen = capture();
            const result = await generate({ charAvatar: 'Marcus.png', recentMessages: [turn(0, 'Marcus.png', 'Marcus')] });

            // A locked vault is a NORMAL state. A user who wants to chat without memory must not be blocked.
            expect(result.prompt).toBe('p');
            expect(seen().charId).toBeNull();
            expect(seen().recentMessages[0].charId).toBeNull();
        });

        test('no user root (an unauthenticated path) yields nulls rather than throwing', async () => {
            const seen = capture();
            await runPromptInterceptors({
                handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p',
                charAvatar: 'Marcus.png', recentMessages: [turn(0, 'Marcus.png', 'Marcus')],
            });

            expect(seen().charId).toBeNull();
            expect(seen().recentMessages[0].charId).toBeNull();
        });

        test('🔴 nothing is minted when no plugin is listening — a stock install stays untouched', async () => {
            clearPromptInterceptors();

            await generate({ charAvatar: 'Marcus.png' });

            expect(fs.existsSync(path.join(root, CHARACTER_IDS_FILE))).toBe(false);
        });
    });

    describe('the client half survives the projection', () => {
        test('takeRecentMessages carries the avatar key through, and still strips ST internals', () => {
            const body = {
                st_recent_messages: [
                    { role: 'assistant', name: 'Marcus', content: 'hi', index: 0, avatar: 'Marcus.png', mes: 'leak', is_user: false },
                ],
            };

            const [taken] = takeRecentMessages({ body });

            expect(taken).toEqual({ role: 'assistant', name: 'Marcus', content: 'hi', index: 0, avatar: 'Marcus.png' });
            expect(taken).not.toHaveProperty('mes');
            expect(taken).not.toHaveProperty('is_user');
        });

        test('an older client sending no avatar is not malformed — the window survives whole', () => {
            const body = { st_recent_messages: [{ role: 'user', name: 'Test User', content: 'hi', index: 0 }] };

            expect(takeRecentMessages({ body })).toHaveLength(1);
        });

        test('a non-string avatar IS malformed, and drops the whole window rather than half of it', () => {
            const body = { st_recent_messages: [{ role: 'user', content: 'hi', index: 0, avatar: 42 }] };

            expect(takeRecentMessages({ body })).toBeUndefined();
        });
    });
});

import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { MockServer } from '../../util/mock-server.js';
import { getFreePort, releasePort } from '../../util/st-server.js';
import { DEPENDENCIES, preflight, serverDirectory } from '../preflight.mjs';
import { chatBody, generate, get, login, makeMarker, post, prepareDataRoot, saveChat, shareModelCache, startServer } from '../harness.mjs';

/**
 * 🔴 SUITE B §7 B6 — DELETING A CHAT TAKES ITS MEMORIES WITH IT.
 *
 * Mnemosyne's §24 obligation, verified through the fork rather than against a mock. It is a privacy
 * promise with a sharp edge: a user who deletes a conversation has said *forget this*, and a memory
 * system that keeps the extracted facts has quietly overruled them — the deletion appears to work,
 * the chat is gone from the disk, and the contents keep surfacing in later conversations.
 *
 * ## Why this needs the fork and cannot be borrowed
 *
 * The signal crosses three pieces of code that only ever meet here. `chats.js` unlinks the file and
 * calls `notifyChatDeleted(handle, chatIdFromPath(chatFilePath))` — deriving the id from **the path it
 * actually unlinked**, deliberately, because the route appends `.jsonl` when the client omits it and
 * the request body is therefore not a reliable spelling of the id. `plugin-loader.js` fans that out to
 * `context.onChatDeleted`. Mnemosyne turns it into `forgetChatFor`. A mismatch anywhere along that
 * chain — an extension included, a separator normalised differently — matches **zero rows** in the
 * store and still reports a completely successful deletion. Nothing short of the real stack can catch
 * an id that is right in three places and wrong in the fourth.
 *
 * ## Both halves, because either alone is satisfied by a bug
 *
 * "The deleted chat's memory is gone" is equally the output of a store that dropped EVERYTHING — which
 * is a worse bug than the one being tested, and would pass a one-sided test with flying colours. So a
 * second chat is planted alongside, is never deleted, and must still be retrievable afterwards. The
 * count is pinned for the same reason: it must fall by exactly the deleted chat's share, not to zero.
 *
 * ⚠️ Evidence is what the fork put in front of the model (`MockServer.requests`), not the panel.
 */

const PERSONA_ID = 'persona-test-user';
const CHARACTER = makeMarker('DeletionCharacter');
const PERSONA = 'Test User';

/** The chat that gets deleted, and the one that must not be touched. */
const DOOMED_CHAT = 'the-doomed-chat';
const SURVIVING_CHAT = 'the-surviving-chat';

/** One secret per chat. Neither is ever typed — only stored. */
const DOOMED_SECRET = makeMarker('B6-SHOULD-BE-FORGOTTEN');
const SURVIVING_SECRET = makeMarker('B6-MUST-SURVIVE');

const DOOMED_MEMORY = `In this conversation the user revealed that ${DOOMED_SECRET}.`;
const SURVIVING_MEMORY = `In this other conversation the user revealed that ${SURVIVING_SECRET}.`;

/** Asked in both chats. Semantically near both memories, and free of either secret. */
const QUERY = 'What did the user reveal in this conversation?';

const gate = preflight('suite B — deleting a chat forgets its memories', [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne]);
const suite = gate.run ? describe : describe.skip;

suite('🗑️ §7 B6: a deleted chat takes its memories with it, and only its own', () => {
    /** @type {any} */
    let server;
    /** @type {string} */
    let base;
    /** @type {MockServer} */
    let backend;
    /** @type {number} */
    let backendPort;

    /** What the fork sent the model, in each chat, before and after the deletion. */
    let doomedBefore = '';
    let survivingBefore = '';
    let doomedAfter = '';
    let survivingAfter = '';

    /** What `/api/chats/delete` answered. */
    let deletion;

    /**
     * The store's actual rows, either side of the deletion.
     *
     * ⚠️ `GET /memory`, NOT `GET /status`. The first version of this file asserted on `status.count` and
     * failed — `readStatus` answers the number of memories injected on the LAST TURN, not how many the
     * store holds, so it read 1 before and 1 after and said nothing about either. The rows are also the
     * stronger evidence: a retrieval that merely stopped MATCHING would satisfy every prompt assertion
     * in this file while the deleted chat's memory sat in the database untouched.
     */
    let rowsBefore = [];
    let rowsAfter = [];

    beforeAll(async () => {
        backendPort = await getFreePort();
        backend = new MockServer({ port: backendPort, host: '127.0.0.1' });
        await backend.start();

        const prepared = await prepareDataRoot('integration-mnemosyne-chat-deletion');
        shareModelCache(prepared.dataRoot);

        const boot = await startServer({
            ...prepared,
            withVault: true,
            pluginsPath: path.join(serverDirectory, 'plugins'),
        });

        server = boot.server;
        base = boot.base;

        const cookie = await login(boot);

        // 🔴 REAL CHAT FILES, because the id the plugin is told comes from the path `chats.js` unlinked.
        // A memory whose chatId never corresponded to a chat on disk could never be forgotten by this
        // route, and a test that skipped the save would be asserting against a deletion that deleted
        // nothing — the 400 branch, not the success branch.
        for (const file of [DOOMED_CHAT, SURVIVING_CHAT]) {
            const saved = await saveChat(base, cookie, CHARACTER, file, chatBody(CHARACTER, PERSONA, ['Something was said here.']));

            if (saved.status !== 200) {
                throw new Error(`Saving "${file}" failed (${saved.status}): ${JSON.stringify(saved.body)}`);
            }
        }

        for (const [text, chatId] of [[DOOMED_MEMORY, DOOMED_CHAT], [SURVIVING_MEMORY, SURVIVING_CHAT]]) {
            const planted = await post(base, '/api/plugins/mnemosyne/memory', {
                text, tier: 'scenario', chatId, personaId: PERSONA_ID,
            }, cookie);

            if (planted.status !== 201) {
                throw new Error(`Planting into "${chatId}" failed (${planted.status}): ${JSON.stringify(planted.body)}`);
            }
        }

        /**
         * Ask in one chat and report what the fork sent the model.
         * @param {string} chatId The chat to generate in
         * @returns {Promise<string>} The outgoing request body, as JSON
         */
        const askIn = async (chatId) => {
            const driven = await generate({
                base, cookie, backendPort, text: QUERY,
                identity: { charAvatar: `${CHARACTER}.png`, charName: CHARACTER, personaId: PERSONA_ID, chatId },
            });

            if (driven.status !== 200) {
                throw new Error(`Generating in "${chatId}" failed (${driven.status}): ${JSON.stringify(driven.body)}\n\n${server.output()}`);
            }

            return JSON.stringify(backend.requests[backend.requests.length - 1] ?? {});
        };

        doomedBefore = await askIn(DOOMED_CHAT);
        survivingBefore = await askIn(SURVIVING_CHAT);
        rowsBefore = (await get(base, '/api/plugins/mnemosyne/memory', cookie)).body?.memories ?? [];

        // ── The deletion, through the app, exactly as the client does it ─────────────────────────
        deletion = await post(base, '/api/chats/delete', {
            avatar_url: `${CHARACTER}.png`, chatfile: DOOMED_CHAT,
        }, cookie);

        doomedAfter = await askIn(DOOMED_CHAT);
        survivingAfter = await askIn(SURVIVING_CHAT);
        rowsAfter = (await get(base, '/api/plugins/mnemosyne/memory', cookie)).body?.memories ?? [];
    }, 600_000);

    afterAll(async () => {
        await server?.stop();
        await backend?.stop();
        releasePort(backendPort);
    });

    describe('✅ the controls — both memories worked before anything was deleted', () => {
        test('the doomed chat could recall its own secret', () => {
            // 🔴 Without this, "the memory is gone" is satisfied by a memory that was never there, and
            // the whole file proves nothing at all.
            expect(doomedBefore).toContain(DOOMED_SECRET);
        });

        test('and so could the chat that is about to survive', () => {
            expect(survivingBefore).toContain(SURVIVING_SECRET);
        });

        test('the two chats did not simply see each other\'s memories', () => {
            // Scenario memories are keyed on chatId, so a leak here would mean the "surviving" assertion
            // below could be satisfied by the doomed chat's row.
            expect(doomedBefore).not.toContain(SURVIVING_SECRET);
            expect(survivingBefore).not.toContain(DOOMED_SECRET);
        });
    });

    describe('🔴 and after the deletion', () => {
        test('🗑️ the chat really was deleted — the success branch, not the 400', () => {
            // `chats.js` only notifies plugins inside `if (tryDeleteFile(...))`. A 400 here would mean the
            // signal never fired, and every assertion below would be about a chat that is still on disk.
            expect(deletion.status).toBe(200);
            expect(deletion.body).toEqual({ ok: true });
        });

        test('🔴 the deleted chat\'s memory is GONE', () => {
            expect(doomedAfter).not.toContain(DOOMED_SECRET);
        });

        test('🔴 CONTROL: and the other chat\'s memory is untouched', () => {
            // The half that separates "forgot the right chat" from "dropped everything" — which is the
            // worse bug, and the one a one-sided test would wave through.
            expect(survivingAfter).toContain(SURVIVING_SECRET);
        });

        test('🧮 the ROW is gone from the store, and only that row', () => {
            // The strongest claim in this file, and a different one from the assertions above: those say
            // the memory no longer reaches the model, which a retrieval that merely stopped matching
            // would also satisfy while the data sat in the database. This says the row is not there.
            const textOf = rows => rows.map(row => String(row?.text ?? '')).join('\n');

            expect(textOf(rowsBefore)).toContain(DOOMED_SECRET);
            expect(textOf(rowsBefore)).toContain(SURVIVING_SECRET);

            expect(textOf(rowsAfter)).not.toContain(DOOMED_SECRET);
            expect(textOf(rowsAfter)).toContain(SURVIVING_SECRET);

            // Exactly one row went, rather than the store being rebuilt or swept.
            expect(rowsAfter).toHaveLength(rowsBefore.length - 1);
        });
    });
});

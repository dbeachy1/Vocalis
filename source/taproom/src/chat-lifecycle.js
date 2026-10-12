/**
 * Chat lifecycle signals for server plugins.
 *
 * 🔴 WHY THIS EXISTS. A plugin that stores anything keyed on `chatId` — a memory store's scenario partition,
 * most of all — has no way to learn that a chat is gone. The rows it wrote are not merely unreachable, they
 * persist for the life of the install: there is no garbage collector behind them and none is planned. So the
 * fork has to say so at the moment it happens, because afterwards there is nothing left to notice.
 *
 * 🔴 TWO EVENTS, AND CONFLATING THEM LOSES DATA IN OPPOSITE DIRECTIONS. A chat can stop being reachable under
 * an id by being *deleted* — the rows are now garbage — or by being *renamed*, where the rows are still wanted
 * and have simply moved. A rename reported as a deletion destroys live memories on a conversation the user is
 * still having; a rename reported as nothing at all leaves them stranded under a key nothing will query again.
 * Hence `notifyChatDeleted` and `notifyChatRenamed` are separate signals carrying different arguments, and
 * neither is expressible in terms of the other.
 *
 * ⚠️ THIS IS NOT `storage.js`, AND THE SEPARATION IS DELIBERATE. `onStorageReady`/`onStorageLock` are about a
 * vault becoming readable. This is about a *file* ceasing to exist, which happens on plaintext installs too.
 * Keeping it out of `storage.js` also keeps this module free of `users.js` — which reaches `secrets.js`, reads
 * config at module scope and `process.exit(1)`s when no config path is set, taking every unit test with it.
 */

import { log, LogClass } from './logger.js';

/** @type {Array<(handle: string, chatId: string) => Promise<void>|void>} */
const chatDeletedHandlers = [];

/** @type {Array<(handle: string, oldChatId: string, newChatId: string) => Promise<void>|void>} */
const chatRenamedHandlers = [];

/**
 * Run something when a chat is deleted, whatever deleted it.
 * @param {(handle: string, chatId: string) => Promise<void>|void} handler Called with the owner and the chat id
 * @returns {void}
 */
export function onChatDeleted(handler) {
    if (typeof handler !== 'function') {
        throw new TypeError(`onChatDeleted() takes a function, got ${typeof handler}`);
    }

    chatDeletedHandlers.push(handler);
}

/**
 * Announce that a chat is gone.
 *
 * 🔴 THE ID MUST BE SPELLED EXACTLY AS `OutgoingPrompt.chatId` SPELLS IT, AND THAT IS THIS FUNCTION'S WHOLE
 * CONTRACT. A consumer keys its rows on `s:<chatId>` at write time; if the id here differs by so much as a
 * `.jsonl`, the delete matches zero rows **and reports success**. That is the one way this feature fails
 * silently, so callers derive the id from the basename of the file they actually deleted rather than from
 * whatever the request body happened to say — byte-identical by construction instead of by agreement between
 * two files that can drift apart.
 *
 * ⚠️ FIRING TWICE IS FINE AND CALLERS SHOULD NOT TRY TO DEDUPE. Deleting an already-forgotten chat is a no-op
 * for any sane consumer, so overlapping deletion paths (a character delete that takes its chats with it, say)
 * cost nothing. The expensive mistake is the opposite one — a path that stays silent.
 *
 * A handler that throws is logged against nobody in particular and does not stop the others, for the same
 * reason `notifyUserStorageReady` does it: one plugin must not be able to take a deletion down.
 * @param {string} handle The user whose chat it was
 * @param {string} chatId The chat id, spelled as `OutgoingPrompt.chatId` spells it
 * @returns {Promise<void>}
 */
export async function notifyChatDeleted(handle, chatId) {
    if (typeof handle !== 'string' || handle === '' || typeof chatId !== 'string' || chatId === '') {
        return;
    }

    for (const handler of chatDeletedHandlers) {
        try {
            await handler(handle, chatId);
        } catch (error) {
            log.error(LogClass.NORMAL, 'A plugin\'s chat-deleted handler failed. The chat is still deleted; that plugin may now hold orphaned rows.');
            log.error(LogClass.SENSITIVE, 'chat-deleted handler error:', error);
        }
    }
}

/**
 * Run something when a chat is renamed, keeping its contents.
 * @param {(handle: string, oldChatId: string, newChatId: string) => Promise<void>|void} handler Called with the owner and both ids
 * @returns {void}
 */
export function onChatRenamed(handler) {
    if (typeof handler !== 'function') {
        throw new TypeError(`onChatRenamed() takes a function, got ${typeof handler}`);
    }

    chatRenamedHandlers.push(handler);
}

/**
 * Announce that a chat has moved from one id to another.
 *
 * 🔴 THIS IS A MOVE, NOT A DELETE AND NOT A DELETE-PLUS-CREATE. The rows are still wanted; they are simply
 * filed under a name nothing will ever query again. A consumer re-keys its partition, so this signal must
 * never be emulated by firing `notifyChatDeleted` on the old id — that would destroy the very rows the rename
 * was supposed to preserve, and it would do it on a chat the user is still in the middle of.
 *
 * 🔴 BOTH IDS ARE SPELLED EXACTLY AS `OutgoingPrompt.chatId` SPELLS THEM. Same contract as
 * {@link notifyChatDeleted} and the same silent failure behind it: a consumer composes its key at write time
 * from the id it was handed during generation, so an `oldChatId` that differs by so much as a `.jsonl` re-keys
 * **zero rows and reports success**. Callers derive both ids with {@link chatIdFromPath} from the two real
 * paths rather than from the request body — `/api/chats/rename` sanitises its inputs, so the body is not a
 * reliable spelling of either end.
 *
 * ⚠️ A RENAME TO THE SAME ID IS NOT AN EVENT, AND EMITTING IT WOULD BE WORSE THAN SILENCE. A consumer asked to
 * re-key a partition onto itself is at best doing pointless work and at worst — depending on whether it moves
 * rows or deletes-then-writes them — destroying the partition outright. The one call site cannot currently
 * produce this, because the endpoint refuses when the destination already exists; the guard is here so that a
 * second call site added later cannot reintroduce it silently. Note the comparison is exact and deliberately
 * case-SENSITIVE: on a case-sensitive filesystem `Foo` → `foo` is a genuine rename with a genuine new id.
 *
 * Fire this only **after** the filesystem operation has succeeded, never before — see §24.6. On a vault
 * install the provider refuses without keys, so a locked vault fails the rename and never announces, and that
 * is precisely what lets a consumer skip building a replay queue. A queue of pending chat ids would be a
 * plaintext list of chat names on disk, on an install whose whole premise is encryption at rest.
 *
 * A handler that throws is logged and does not stop the others: one plugin must not be able to take a rename
 * down, and by the time this fires the file has already moved.
 * @param {string} handle The user whose chat it is
 * @param {string} oldChatId The id it was filed under, spelled as `OutgoingPrompt.chatId` spells it
 * @param {string} newChatId The id it is filed under now, spelled the same way
 * @returns {Promise<void>}
 */
export async function notifyChatRenamed(handle, oldChatId, newChatId) {
    if (typeof handle !== 'string' || handle === '') {
        return;
    }

    if (typeof oldChatId !== 'string' || oldChatId === '' || typeof newChatId !== 'string' || newChatId === '') {
        return;
    }

    if (oldChatId === newChatId) {
        return;
    }

    for (const handler of chatRenamedHandlers) {
        try {
            await handler(handle, oldChatId, newChatId);
        } catch (error) {
            log.error(LogClass.NORMAL, 'A plugin\'s chat-renamed handler failed. The chat is still renamed; that plugin may now hold rows under an id nothing will query again.');
            log.error(LogClass.SENSITIVE, 'chat-renamed handler error:', error);
        }
    }
}

/**
 * Forget every registered handler. Tests only.
 * @returns {void}
 */
export function clearChatLifecycleHandlers() {
    chatDeletedHandlers.length = 0;
    chatRenamedHandlers.length = 0;
}

/**
 * The chat id for a chat file, as `OutgoingPrompt.chatId` spells it.
 *
 * 🔴 BASENAME MINUS EXTENSION, DERIVED FROM THE PATH ACTUALLY DELETED. `getCurrentChatId()` on the client
 * returns `characters[this_chid].chat` — the filename **without** `.jsonl`. But `/api/chats/delete` accepts
 * `chatfile` with or without the extension and appends it when missing, so the request body is not a reliable
 * spelling of the id and emitting it verbatim would miss on every request that included the extension.
 * @param {string} chatFilePath Path to the chat file that was deleted
 * @returns {string} The chat id
 */
export function chatIdFromPath(chatFilePath) {
    const base = chatFilePath.replace(/\\/g, '/').split('/').pop() ?? '';
    return base.replace(/\.jsonl$/i, '');
}

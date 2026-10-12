/**
 * The engine behind `context.readChat` (plugin API v7): a chat's core turns, read from disk on demand.
 *
 * 🔴 WHY A PLUGIN NEEDS THIS. A plugin sees chat messages only in `outgoing.recentMessages`, which exists only
 * while a generation is in flight. A panel action — "rescan the last 200 messages" — has no generation, so it
 * has no messages. The chat is on disk, but a plugin has no import path into `src/`, and on an encrypted
 * install a raw `fs` read returns ciphertext. Same gap `readCharacterCard` closes for cards.
 *
 * 🔴 THE TURNS ARE THE SAME TURNS `recentMessages` WOULD HAVE CARRIED, BUILT BY THE SAME CODE. The chat is
 * split by the client's own `splitCoreChat` with the client's own `isCoreMessage`, shaped by the client's own
 * `buildRecentMessages`, and finished by the server's own `finishTurn` — imported, never copied. A plugin
 * stores a high-water mark in `index` and compares a rescan against what live ingest stored; a second
 * implementation of any of those rules would drift, and the drift would show up as a rescan that overlaps or
 * skips turns with no error anywhere.
 *
 * ⚠️ WHAT CAN STILL DIFFER, AND WHY. `content` here is the message's stored text (the active swipe). The
 * generation window's `content` is the same text AFTER three client-only steps, none of which the server can
 * reproduce because each depends on live client state:
 *   1. prompt-only regex scripts (`getRegexedString(..., { isPrompt: true })`);
 *   2. text of attached files (`appendFileContent`), and media/message titles marked "append title";
 *   3. on the first message only, a fresh `substituteParams` — which changes nothing unless the greeting was
 *      saved with an unresolved macro.
 * A chat with none of those — no prompt-only regex, no attachments — reads identically on both paths.
 * Macros in ordinary messages are NOT a difference: a message is stored with its macros already resolved.
 * ⚠️ AND TOOL-CALL RECORDS ARE EXCLUDED. They are `is_system` messages the client keeps only while the active
 * connection supports tool calling; the server cannot know that, so it reads them as the hidden messages they
 * otherwise are. Their indices are left as gaps, exactly as a hidden message's are, so no other turn moves.
 */

import path from 'node:path';

import { splitCoreChat, buildRecentMessages, isCoreMessage } from '../public/scripts/plugin-prompts.js';
import { lookupCharacterIds } from './character-ids.js';
import { finishTurn, logUnrecognizedSendDates } from './generation-interceptors.js';
import { parseChatJsonl } from './util.js';
import * as storage from './storage.js';
import { log, LogClass } from './logger.js';

/**
 * The filesystem operations `readChat` performs, injectable so the unit suite can drive the failure cases a
 * real vault would need a real lock for.
 * @typedef {object} ReadChatIo
 * @property {(handle: string) => boolean} isReady Whether the user's storage can be read right now
 * @property {(p: string) => boolean} exists Whether a file exists
 * @property {(p: string) => string[]} listDirectories Subdirectory names of a directory; `[]` if it is absent
 * @property {(p: string) => Promise<string>} readFile A file's decrypted text
 * @property {(root: string, avatars: Array<string|undefined>) => Promise<Array<string|null>>} lookupCharacterIds
 */

/** @type {ReadChatIo} */
const storageIo = {
    isReady: handle => storage.isReady(handle),
    exists: p => storage.exists(p),
    listDirectories: (p) => {
        try {
            return /** @type {import('node:fs').Dirent[]} */ (/** @type {unknown} */ (storage.readdir(p, { withFileTypes: true })))
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name);
        } catch (error) {
            // ENOENT only: a user who has never opened a solo chat has no `chats/` directory, which is "no
            // solo chats" and not an error. Everything else — a provider refusing — propagates.
            if (/** @type {any} */ (error)?.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    },
    readFile: async p => String(await storage.readFile(p, 'utf8')),
    lookupCharacterIds,
};

/**
 * Where a chat id lives on disk.
 *
 * 🔴 AN ID NAMES A FILE, NOT A CHARACTER, SO EVERY PLACE ONE COULD BE IS CHECKED. `OutgoingPrompt.chatId` is
 * the file's basename without `.jsonl` (`chatIdFromPath`); a group chat lives at `group chats/<id>.jsonl` and
 * a solo chat at `chats/<avatar without .png>/<id>.jsonl`, and the id alone does not say which character's
 * folder. A rename (§24.4) moves the file, so the new id is found immediately and the old one is not.
 *
 * ⚠️ TWO MATCHES THROW. Default chat names embed the character's name and a timestamp, so two characters
 * holding the same chat id means one was copied or imported by hand. Picking either would hand a plugin one
 * character's conversation filed under a request about the other, so the plugin is told instead.
 * @param {{chatsDir: string, groupChatsDir: string, chatId: string, io: ReadChatIo}} args
 * @returns {{file: string, group: boolean, avatar: string|undefined}|null} The location, or null if none
 */
function locateChat({ chatsDir, groupChatsDir, chatId, io }) {
    const fileName = `${chatId}.jsonl`;
    /** @type {Array<{file: string, group: boolean, avatar: string|undefined}>} */
    const found = [];

    const groupFile = path.join(groupChatsDir, fileName);
    if (io.exists(groupFile)) {
        found.push({ file: groupFile, group: true, avatar: undefined });
    }

    for (const directory of io.listDirectories(chatsDir)) {
        const soloFile = path.join(chatsDir, directory, fileName);
        if (io.exists(soloFile)) {
            // The folder is the avatar filename minus `.png` (`/api/chats/get` strips exactly that), and every
            // card is a PNG, so this is the avatar the client would have sent as `selectedAvatar` for this chat.
            found.push({ file: soloFile, group: false, avatar: `${directory}.png` });
        }
    }

    if (found.length > 1) {
        throw new Error(`${found.length} chats share this id (${found.filter(x => x.group).length} group, ${found.filter(x => !x.group).length} solo), so which one is meant cannot be told.`);
    }

    return found[0] ?? null;
}

/**
 * Read a chat's core turns, in the shape and numbering of `recentMessages`.
 * @param {object} args
 * @param {string} args.pluginId The calling plugin, for errors and the log
 * @param {string} args.handle The user whose chat this is
 * @param {{root: string, chats: string, groupChats: string}} args.directories That user's directories
 * @param {string} args.chatId The chat id, spelled as `OutgoingPrompt.chatId` spells it
 * @param {number} [args.last] How many trailing core turns to return; all of them when omitted
 * @param {ReadChatIo} [args.io] Filesystem operations, for tests
 * @returns {Promise<import('./generation-interceptors.js').RecentMessage[]|null>} The turns, or null if no chat
 * has that id
 */
export async function readChat({ pluginId, handle, directories, chatId, last, io = storageIo }) {
    // 🔴 A LOCKED VAULT THROWS HERE, BEFORE ANY LOOKUP. `exists` and `readdir` report on files that are on
    // disk whether or not they can be decrypted, so without this a lookup could succeed and the read fail —
    // or, worse, a provider that hides names while locked would make the chat look absent, and `null` would
    // tell the plugin "no such chat" when the truth is "not now". A rescan that did nothing must not report
    // success, which is what `null` or `[]` would let it do.
    if (!io.isReady(handle)) {
        throw new Error(`Plugin '${pluginId}' cannot read a chat for user ${JSON.stringify(handle)}: their storage is locked. Try again after they log in.`);
    }

    let located;
    try {
        located = locateChat({ chatsDir: directories.chats, groupChatsDir: directories.groupChats, chatId, io });
    } catch (error) {
        throw new Error(`Plugin '${pluginId}' could not find chat ${JSON.stringify(chatId)} for user ${JSON.stringify(handle)}: ${/** @type {any} */ (error)?.message ?? error}`, { cause: error });
    }

    if (located === null) {
        log.info(LogClass.NORMAL, `context.readChat: plugin '${pluginId}' asked for a chat that does not exist; returning null.`);
        return null;
    }

    let text;
    try {
        text = await io.readFile(located.file);
    } catch (error) {
        // Deleted between the lookup and the read — the same ordinary "no such chat" as not finding it.
        if (/** @type {any} */ (error)?.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Plugin '${pluginId}' could not read chat ${JSON.stringify(chatId)} for user ${JSON.stringify(handle)}: ${/** @type {any} */ (error)?.message ?? error}`, { cause: error });
    }

    const rows = parseChatJsonl(text);

    // 🔴 THE HEADER IS DROPPED BY THE CLIENT'S OWN RULE FOR EACH KIND, AND THE TWO RULES DIFFER. A solo chat's
    // first row is always removed (`getChat` shifts it unconditionally); a group chat's only when it carries
    // `chat_metadata` (`getGroupChat`), because old group files had no header. Index 0 must mean what it
    // means in the client's `chat` array, or every index is off by one.
    if (rows.length > 0 && (!located.group || Object.hasOwn(rows[0], 'chat_metadata'))) {
        rows.shift();
    }

    // No swipe: nothing is being regenerated, so the last turn is a real turn.
    const { messages, indices } = splitCoreChat(rows, message => isCoreMessage(message, false), false);

    if (messages.length === 0) {
        log.info(LogClass.NORMAL, `context.readChat: plugin '${pluginId}' read a chat with no core turns (${rows.length} rows, ${located.group ? 'group' : 'solo'}).`);
        return [];
    }

    // 🔴 THE SOLO FALLBACK IS THE CHAT'S OWN CHARACTER, AND THE GROUP GETS NONE — the rule `Generate()` applies,
    // for the reason it gives: a group turn without `original_avatar` has no knowable author, and guessing
    // would file a fact about the user into the wrong character's memory.
    const turns = buildRecentMessages(messages, indices, last ?? messages.length, located.group ? undefined : located.avatar) ?? [];

    // A locked or unreadable id map throws, as everything else here does. The generation path degrades to
    // `null` ids instead, because a user must be able to chat without memory — but nobody is waiting on a
    // rescan's reply, and a rescan that filed every turn as "no character" would be worse than one that failed.
    const ids = await io.lookupCharacterIds(directories.root, turns.map(turn => turn.avatar));

    logUnrecognizedSendDates(turns, `context.readChat for plugin '${pluginId}'`);

    log.info(LogClass.NORMAL, `context.readChat: plugin '${pluginId}' read ${turns.length} of ${messages.length} core turns (${rows.length} rows, ${located.group ? 'group' : 'solo'} chat${last === undefined ? '' : `, last ${last}`}).`);

    return turns.map((turn, i) => finishTurn(turn, ids[i]));
}

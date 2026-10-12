import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

import express from 'express';
import sanitize from 'sanitize-filename';
import * as storage from '../storage.js';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import {
    getConfigValue,
    humanizedDateTime,
    tryParse,
    parseChatJsonl,
    generateTimestamp,
    removeOldBackups,
    formatBytes,
    tryWriteFileSync,
    tryReadFileSync,
    tryDeleteFile,
    readFirstLine,
    isPathUnderParent,
} from '../util.js';
import { log, LogClass } from '../logger.js';
import { notifyChatDeleted, notifyChatRenamed, chatIdFromPath } from '../chat-lifecycle.js';
import { hasEnvelope } from '../storage-envelope.js';
import { describeUnavailableData } from '../storage-status.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');

export const CHAT_BACKUPS_PREFIX = 'chat_';

/**
 * Saves a chat to the backups directory.
 * @param {string} directory The user's backup directory.
 * @param {string} name The name of the chat.
 * @param {string} data The serialized chat to save.
 * @param {string} backupPrefix The file prefix. Typically CHAT_BACKUPS_PREFIX.
 * @returns
 */
function backupChat(directory, name, data, backupPrefix = CHAT_BACKUPS_PREFIX) {
    try {
        if (!isBackupEnabled) { return; }
        if (!storage.exists(directory)) {
            log.error(LogClass.NORMAL, 'The chat could not be backed up: no such directory');
            log.error(LogClass.SENSITIVE, 'Missing backup directory:', directory);
        }
        // replace non-alphanumeric characters with underscores
        name = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();

        const backupFile = path.join(directory, `${backupPrefix}${name}_${generateTimestamp()}.jsonl`);

        tryWriteFileSync(backupFile, data);
        removeOldBackups(directory, `${backupPrefix}${name}_`);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        removeOldBackups(directory, backupPrefix, maxTotalChatBackups);
    } catch (err) {
        log.error(LogClass.NORMAL, 'Could not backup chat');
        log.error(LogClass.SENSITIVE, 'Chat backup failed for', name, err);
    }
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<typeof backupChat>>}
 */
const backupFunctions = new Map();

/**
 * Gets a backup function for a user.
 * @param {string} handle User handle
 * @returns {typeof backupChat} Backup function
 */
function getBackupFunction(handle) {
    if (!backupFunctions.has(handle)) {
        backupFunctions.set(handle, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(handle) || (() => { });
}

/**
 * Gets a preview message from a chat message string.
 * @param {string} [lastMessage] - The message to truncate
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewMessage(lastMessage) {
    const strlen = 400;

    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > strlen
        ? '...' + lastMessage.substring(lastMessage.length - strlen)
        : lastMessage;
}

process.on('exit', () => {
    for (const func of backupFunctions.values()) {
        func.flush();
    }
});

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string} Chat data
 */
function importOobaChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const arr of jsonData.data_visible) {
        if (arr[0]) {
            const userMessage = {
                name: userName,
                is_user: true,
                send_date: new Date().toISOString(),
                mes: arr[0],
                extra: {},
            };
            chat.push(userMessage);
        }
        if (arr[1]) {
            const charMessage = {
                name: characterName,
                is_user: false,
                send_date: new Date().toISOString(),
                mes: arr[1],
                extra: {},
            };
            chat.push(charMessage);
        }
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Chat data
 * @returns {string} Chat data
 */
function importAgnaiChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.messages) {
        const isUser = !!message.userId;
        chat.push({
            name: isUser ? userName : characterName,
            is_user: isUser,
            send_date: new Date().toISOString(),
            mes: message.msg,
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string[]} Converted data
 */
function importCAIChat(userName, characterName, jsonData) {
    /**
     * Converts the chat data to suitable format.
     * @param {object} history Imported chat data
     * @returns {object[]} Converted chat data
     */
    function convert(history) {
        const starter = {
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        };

        const historyData = history.msgs.map((msg) => ({
            name: msg.src.is_human ? userName : characterName,
            is_user: msg.src.is_human,
            send_date: new Date().toISOString(),
            mes: msg.text,
            extra: {},
        }));

        return [starter, ...historyData];
    }

    const newChats = (jsonData.histories.histories ?? []).map(history => newChats.push(convert(history).map(obj => JSON.stringify(obj)).join('\n')));
    return newChats;
}

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {object} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @type {function(string): object} */
    function processKoboldMessage(msg) {
        const isUser = msg.includes(inputToken);
        return {
            name: isUser ? userName : characterName,
            is_user: isUser,
            mes: msg.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
            send_date: new Date().toISOString(),
            extra: {},
        };
    }

    // Create the header
    const userName = String(data.savedsettings.chatname);
    const characterName = String(data.savedsettings.chatopponent).split('||$||')[0];
    const header = {
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    };
    // Format messages
    const formattedMessages = data.actions.map(processKoboldMessage);
    // Add prompt if available
    if (data.prompt) {
        formattedMessages.unshift(processKoboldMessage(data.prompt));
    }
    // Combine header and messages
    const chatData = [header, ...formattedMessages];
    return chatData.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Flattens `msg` and `swipes` data from Chub Chat format.
 * Only changes enough to make it compatible with the standard chat serialization format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {string[]} lines serialised JSONL data
 * @returns {string} Converted data
 */
function flattenChubChat(userName, characterName, lines) {
    function flattenSwipe(swipe) {
        return swipe.message ? swipe.message : swipe;
    }

    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map(swipe => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return (lines ?? []).map(convert).join('\n');
}

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Imported chat data
 * @returns {string} Chat data
 */
function importRisuChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.data.message) {
        const isUser = message.role === 'user';
        chat.push({
            name: message.name ?? (isUser ? userName : characterName),
            is_user: isUser,
            send_date: new Date(Number(message.time ?? Date.now())).toISOString(),
            mes: message.data ?? '',
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Checks if the chat being saved has the same integrity as the one being loaded.
 * @param {string} filePath Path to the chat file
 * @param {string} integritySlug Integrity slug
 * @returns {Promise<boolean>} Whether the chat is intact
 */
async function checkChatIntegrity(filePath, integritySlug) {
    // If the chat file doesn't exist, assume it's intact
    if (!storage.exists(filePath)) {
        return true;
    }

    // Parse the first line of the chat file as JSON
    const firstLine = await readFirstLine(filePath);
    const jsonData = tryParse(firstLine);
    const chatIntegrity = jsonData?.chat_metadata?.integrity;

    // If the chat has no integrity metadata, assume it's intact
    if (!chatIntegrity) {
        log.debug(LogClass.SENSITIVE, `File "${filePath}" does not have integrity metadata matching "${integritySlug}". The integrity validation has been skipped.`);
        return true;
    }

    // Check if the integrity matches
    return chatIntegrity === integritySlug;
}

/**
 * @typedef {Object} ChatInfo
 * @property {string} [file_id] - The name of the chat file (without extension)
 * @property {string} [file_name] - The name of the chat file (with extension)
 * @property {string} [file_size] - The size of the chat file in a human-readable format
 * @property {number} [chat_items] - The number of chat items in the file
 * @property {string} [mes] - The last message in the chat
 * @property {number|string} [last_mes] - The timestamp of the last message
 * @property {object} [chat_metadata] - Additional chat metadata
 * @property {boolean} [match] - Whether the chat matches the search criteria
 */

/**
 * Reads the information from a chat file.
 * @param {string} pathToFile - Path to the chat file
 * @param {object} additionalData - Additional data to include in the result
 * @param {boolean} withMetadata - Whether to read chat metadata
 * @param {ChatMatchFunction|null} matcher - Optional function to match messages
 * @returns {Promise<ChatInfo>}
 *
 * @typedef {(textArray: string[]) => boolean} ChatMatchFunction
 */
export async function getChatInfo(pathToFile, additionalData = {}, withMetadata = false, matcher = null) {
    // 🔴 THE AWAITS COME OUT OF THE EXECUTOR, AND THAT IS A BUG FIX, NOT A TIDY-UP.
    //
    // This used to be `new Promise(async (res) => { ... await storage.stat(...) ... })` — an async executor
    // with no reject and no try/catch. Upstream that was merely untidy, because `fs.promises.stat` on a file
    // the caller had just listed does not fail. Through the provider seam it does: a locked vault is a
    // designed-for state and `storage.stat` throws in it. The throw rejected the EXECUTOR's promise, which
    // nobody holds — so the promise this function returns never settled at all, and the caller waited for
    // ever holding the socket while the stray rejection went looking for a listener that did not exist.
    //
    // Awaited out here, a failure simply rejects the promise `getChatInfo` returns, which is what every
    // caller already expects: they wrap this in `Promise.allSettled` or a try/catch.
    const parsedPath = path.parse(pathToFile);
    const stats = await storage.stat(pathToFile);
    const hasMatcher = (typeof matcher === 'function');

    const chatData = {
        match: false,
        file_id: parsedPath.name,
        file_name: parsedPath.base,
        file_size: formatBytes(stats.size),
        chat_items: 0,
        mes: '[The chat is empty]',
        last_mes: stats.mtimeMs,
        ...additionalData,
    };

    if (stats.size === 0) {
        return chatData;
    }

    return new Promise((res, rej) => {
        const fileStream = storage.createReadStream(pathToFile);

        // A stream that errors after it was handed back — the provider losing the file mid-read, an I/O
        // fault — emits 'error' with nobody listening, and an unhandled 'error' event is thrown rather
        // than delivered. Route it to the same rejection the awaits above now use.
        fileStream.on('error', rej);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        let lastLine;
        let itemCounter = 0;
        let hasAnyMatch = false;
        let matchBuffer = [];
        rl.on('line', (line) => {
            if (withMetadata && itemCounter === 0) {
                const jsonData = tryParse(line);
                if (jsonData && _.isObjectLike(jsonData.chat_metadata)) {
                    chatData.chat_metadata = jsonData.chat_metadata;
                }
            }
            // Skip matching if any match was already found
            if (hasMatcher && !hasAnyMatch && itemCounter > 0) {
                const jsonData = tryParse(line);
                if (jsonData) {
                    matchBuffer.push(jsonData.mes || '');
                    if (matcher(matchBuffer)) {
                        hasAnyMatch = true;
                        matchBuffer = [];
                    }
                }
            }
            itemCounter++;
            lastLine = line;
        });
        rl.on('close', () => {
            rl.close();

            if (lastLine) {
                const jsonData = tryParse(lastLine);
                if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
                    chatData.chat_items = (itemCounter - 1);
                    chatData.mes = jsonData.mes || '[The message is empty]';
                    chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
                    chatData.match = hasMatcher ? hasAnyMatch : true;

                    res(chatData);
                } else if (hasEnvelope(pathToFile)) {
                    // 🔴 NOT A CORRUPT FILE — AN ENCRYPTED CHAT WITH NO PROVIDER TO DECRYPT IT.
                    //
                    // The last line failed to parse because what is on disk is ciphertext, not JSON. The old
                    // code below treats "did not parse" as "corrupt, hide it", and that is exactly the §3
                    // mistake in a new place: it collapses ours-but-locked onto not-a-chat and DROPS the row.
                    // `DESIGN_MIXED_MODE.md` §11 is emphatic that an encrypted chat whose provider is gone
                    // must still APPEAR in the list, disabled — hiding it is how a user concludes their data
                    // is gone and stops looking for it. The discriminator is the structural envelope read
                    // keylessly off disk, never whether decryption/parsing succeeded. The row goes out with
                    // its file_name; the authenticated per-chat status endpoint (§6) is what then reads the
                    // envelope and names the provider it needs — this listing deliberately does not, so it
                    // stays as anonymous-safe as it was.
                    res(chatData);
                } else {
                    log.warn(LogClass.SENSITIVE, 'Found an invalid or corrupted chat file:', pathToFile);
                    res({});
                }
            } else {
                // A non-empty file that yielded no usable last line — one that is nothing but a newline, say.
                // Rare, but `stats.size === 0` does not cover it, and without this branch the promise simply
                // never settles and the caller waits for ever. Not a listable chat: answer like the corrupt
                // case rather than not answering at all.
                log.warn(LogClass.SENSITIVE, 'Found a chat file with no readable content:', pathToFile);
                res({});
            }
        });
    });
}

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
class IntegrityMismatchError extends Error {
    constructor(...params) {
        // Pass remaining arguments (including vendor specific ones) to parent constructor
        super(...params);
        // Maintains proper stack trace for where our error was thrown (non-standard)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, IntegrityMismatchError);
        }
        this.date = new Date();
    }
}

/**
 * Thrown when a chat's bytes are enveloped by a storage provider this instance cannot read.
 *
 * 🔴 THE INTEGRITY CHECK CANNOT CATCH THIS, WHICH IS WHY IT NEEDS ITS OWN GATE. `checkChatIntegrity`
 * reads the first line and compares a slug; an envelope does not parse, so `chatIntegrity` comes back
 * undefined and the check answers "intact" — the one mechanism that exists to stop a clobber fails
 * OPEN on exactly the bytes that must never be clobbered.
 */
class StorageUnavailableError extends Error {
    /**
     * @param {import('../storage-status.js').StorageState} storageState The provenance answer to send on.
     * @param {string} filePath The chat that could not be read, for the log line only.
     */
    constructor(storageState, filePath) {
        super(`The chat at "${filePath}" needs a storage provider that is not available.`);
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, StorageUnavailableError);
        }
        this.storage = storageState;
    }
}

/**
 * Refuse to touch a chat whose bytes are enveloped and unreadable.
 *
 * The same rule `worldinfo.js` applies to worlds, applied to the file type that actually holds the
 * conversation. Reading an unreadable chat yields `[]`, the client takes `[]` for "empty or corrupted",
 * pushes the character's greeting and calls `saveChatConditional()` with no further user action — so the
 * read side has to refuse too, not just the write side. Worlds and settings got this in §12.2; chats,
 * which are the thing the vault exists for, did not.
 *
 * ⚠️ A NEW CHAT STILL WORKS. A path with no file, or a file with no envelope, describes as plaintext and
 * reports nothing, so this fires only for bytes that are enveloped and unreadable.
 * @param {string} chatFilePath Absolute path to the chat file.
 * @returns {void}
 */
function refuseIfUnavailable(chatFilePath) {
    const unavailable = describeUnavailableData(chatFilePath);

    if (unavailable) {
        throw new StorageUnavailableError(unavailable, chatFilePath);
    }
}

/**
 * Tries to save the chat data to a file, performing an integrity check if required.
 * @param {Array} chatData The chat array to save.
 * @param {string} filePath Target file path for the data.
 * @param {boolean} skipIntegrityCheck If undefined, the chat's integrity will not be checked.
 * @param {string} handle The users handle, passed to getBackupFunction.
 * @param {string} cardName Passed to backupChat.
 * @param {string} backupDirectory Passed to backupChat.
 */
export async function trySaveChat(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory) {
    const jsonlData = chatData?.map(m => JSON.stringify(m)).join('\n');

    refuseIfUnavailable(filePath);

    const doIntegrityCheck = (checkIntegrity && !skipIntegrityCheck);
    const chatIntegritySlug = doIntegrityCheck ? chatData?.[0]?.chat_metadata?.integrity : undefined;

    if (chatIntegritySlug && !await checkChatIntegrity(filePath, chatIntegritySlug)) {
        throw new IntegrityMismatchError(`Chat integrity check failed for "${filePath}". The expected integrity slug was "${chatIntegritySlug}".`);
    }
    tryWriteFileSync(filePath, jsonlData);
    getBackupFunction(handle)(backupDirectory, cardName, jsonlData);
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        if (Array.isArray(chatData)) {
            await trySaveChat(chatData, chatFilePath, request.body.force, handle, cardName, request.user.directories.backups);
            return response.send({ ok: true });
        } else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof StorageUnavailableError) {
            log.warn(LogClass.NORMAL, 'Refused to save a chat whose storage provider is not available');
            return response.status(409).send({ storage: error.storage });
        }
        if (error instanceof IntegrityMismatchError) {
            log.error(LogClass.NORMAL, 'Failed to save chat: integrity check mismatch');
            log.error(LogClass.SENSITIVE, error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        log.error(LogClass.NORMAL, 'Failed to save chat');
        log.error(LogClass.SENSITIVE, error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/**
 * Gets the chat as an object.
 * @param {string} chatFilePath The full chat file path.
 * @returns {Array}} If the chatFilePath cannot be read, this will return [].
 */
export function getChatData(chatFilePath) {
    let chatData = [];

    const chatJSON = tryReadFileSync(chatFilePath) ?? '';
    if (chatJSON.length > 0) {
        // Parse each line as JSON — through the helper `context.readChat` also uses, so both drop the same lines.
        chatData = parseChatJsonl(chatJSON);
    } else {
        log.warn(LogClass.SENSITIVE, `File not found: ${chatFilePath}. The chat does not exist or is empty.`);
    }

    return chatData;
}

router.post('/get', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const directoryPath = path.join(request.user.directories.chats, dirName);
        if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
            return response.sendStatus(400);
        }
        const chatDirExists = storage.exists(directoryPath);

        //if no chat dir for the character is found, make one with the character name
        if (!chatDirExists) {
            storage.mkdir(directoryPath);
            return response.send({});
        }

        if (!request.body.file_name) {
            return response.send({});
        }

        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const chatFilePath = path.join(directoryPath, sanitize(chatFileName));

        // Refused rather than answered with `[]`. `getChatData` cannot tell ciphertext from an empty chat —
        // every line fails to parse and it returns the same `[]` either way — and the client treats `[]` as
        // "empty or corrupted", mints fresh integrity metadata, pushes the greeting and saves. One click on
        // a §11 dead row would otherwise replace the conversation with a plaintext stub.
        const unavailable = describeUnavailableData(chatFilePath);

        if (unavailable) {
            return response.status(409).send({ storage: unavailable });
        }

        return response.send(getChatData(chatFilePath));
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to get chat');
        log.error(LogClass.SENSITIVE, error);
        return response.send({});
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }

        const pathToFolder = request.body.is_group
            ? request.user.directories.groupChats
            : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
        if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, pathToFolder)) {
            return response.sendStatus(400);
        }
        const pathToOriginalFile = path.join(pathToFolder, sanitize(request.body.original_file));
        const pathToRenamedFile = path.join(pathToFolder, sanitize(request.body.renamed_file));
        const sanitizedFileName = path.parse(pathToRenamedFile).name;
        log.debug(LogClass.SENSITIVE, 'Old chat name', pathToOriginalFile);
        log.debug(LogClass.SENSITIVE, 'New chat name', pathToRenamedFile);

        if (!storage.exists(pathToOriginalFile) || storage.exists(pathToRenamedFile)) {
            log.error(LogClass.NORMAL, 'Either Source or Destination files are not available');
            return response.status(400).send({ error: true });
        }

        storage.copyFile(pathToOriginalFile, pathToRenamedFile);
        storage.unlink(pathToOriginalFile);
        log.info(LogClass.NORMAL, 'Successfully renamed chat file.');

        // §24.4: tell any plugin keyed on this chat that its rows have MOVED, not died. This is the only call
        // site — a character rename moves the chats folder and rewrites the speaker name inside each file, but
        // a chat id is a basename, so it changes no id and needs no signal.
        //
        // 🔴 AFTER THE UNLINK, NEVER BEFORE (§24.6). On a vault install `storage.unlink` reaches the provider,
        // which refuses without keys — so a locked vault throws out of this handler and never announces. That
        // ordering is what lets a consumer skip a replay queue, and a replay queue here would be a plaintext
        // list of chat names on disk, on an install whose whole premise is encryption at rest.
        //
        // Both ids come from the two paths we actually moved, not from `request.body`: the body is `sanitize`d
        // on the way in, so a name it mangled would be a spelling no consumer ever filed anything under, and
        // the re-key would match zero rows while reporting success.
        await notifyChatRenamed(
            request.user.profile.handle,
            chatIdFromPath(pathToOriginalFile),
            chatIdFromPath(pathToRenamedFile),
        );

        return response.send({ ok: true, sanitizedFileName });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error renaming chat file');
        log.error(LogClass.SENSITIVE, 'Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!path.extname(request.body.chatfile)) {
            request.body.chatfile += '.jsonl';
        }

        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = String(request.body.chatfile);
        const chatFilePath = path.join(request.user.directories.chats, dirName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }
        //Return success if the file was deleted.
        if (tryDeleteFile(chatFilePath)) {
            // §24: tell any plugin keyed on this chat, before we answer. Derived from the path we actually
            // unlinked rather than from `request.body.chatfile` — the handler above appends `.jsonl` when it
            // is missing, so the body is not a reliable spelling of the id, and a delete that arrived WITH
            // the extension would match zero rows in the consumer while reporting success.
            await notifyChatDeleted(request.user.profile.handle, chatIdFromPath(chatFilePath));
            return response.send({ ok: true });
        } else {
            log.error(LogClass.NORMAL, 'The chat file was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to delete chat');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const pathToFolder = request.body.is_group
        ? request.user.directories.groupChats
        : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
    const filename = path.join(pathToFolder, sanitize(request.body.file));
    if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, filename)) {
        return response.sendStatus(400);
    }
    let exportfilename = request.body.exportfilename;
    if (!storage.exists(filename)) {
        const errorMessage = {
            message: `Could not find JSONL file to export. Source chat file: ${filename}.`,
        };
        log.error(LogClass.NORMAL, 'Chat export failed: source file not found');
        log.error(LogClass.SENSITIVE, errorMessage.message);
        return response.status(404).json(errorMessage);
    }
    try {
        // Short path for JSONL files
        if (request.body.format === 'jsonl') {
            try {
                const rawFile = storage.readFileSync(filename, 'utf8');
                const successMessage = {
                    message: `Chat saved to ${exportfilename}`,
                    result: rawFile,
                };

                log.info(LogClass.SENSITIVE, `Chat exported as ${exportfilename}`);
                return response.status(200).json(successMessage);
            } catch (err) {
                const errorMessage = {
                    message: `Could not read JSONL file to export. Source chat file: ${filename}.`,
                };
                log.error(LogClass.NORMAL, 'Chat export failed: could not read the source file');
                log.error(LogClass.SENSITIVE, errorMessage.message, err);
                return response.status(500).json(errorMessage);
            }
        }

        const readStream = storage.createReadStream(filename);
        const rl = readline.createInterface({
            input: readStream,
        });
        let buffer = '';
        rl.on('line', (line) => {
            const data = JSON.parse(line);
            // Skip non-printable/prompt-hidden messages
            if (data.is_system) {
                return;
            }
            if (data.mes) {
                const name = data.name;
                const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                buffer += (`${name}: ${message}\n\n`);
            }
        });
        rl.on('close', () => {
            const successMessage = {
                message: `Chat saved to ${exportfilename}`,
                result: buffer,
            };
            log.info(LogClass.SENSITIVE, `Chat exported as ${exportfilename}`);
            return response.status(200).json(successMessage);
        });
    } catch (err) {
        log.error(LogClass.NORMAL, 'Chat export failed.');
        log.error(LogClass.SENSITIVE, 'chat export failed.', err);
        return response.sendStatus(400);
    }
});

router.post('/group/import', function (request, response) {
    try {
        const filedata = request.file;

        if (!filedata) {
            return response.sendStatus(400);
        }

        const chatname = humanizedDateTime();
        const pathToUpload = path.join(filedata.destination, filedata.filename);
        const pathToNewFile = path.join(request.user.directories.groupChats, `${chatname}.jsonl`);

        // 🔴 Same rule as the character-chat import below, for the same reason: an imported group chat is a
        // NEW chat and must take the provider's default, not inherit whatever state the multer staging file
        // happened to have. Copying made the guarantee contingent on the OPTIONAL `multerStorage` capability
        // — a provider that omits it stages in the clear, and the copy carried that plaintext into the group
        // chats directory.
        storage.writeFileSync(pathToNewFile, storage.readFileSync(pathToUpload));
        storage.unlink(pathToUpload);
        return response.send({ res: chatname });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to import group chat');
        log.error(LogClass.SENSITIVE, error);
        return response.send({ error: true });
    }
});

router.post('/import', validateAvatarUrlMiddleware, function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const format = request.body.file_type;
    const avatarUrl = (request.body.avatar_url).replace('.png', '');
    const characterName = sanitize(request.body.character_name) || 'Character';
    const userName = sanitize(request.body.user_name) || 'User';
    const fileNames = [];

    if (!request.file) {
        return response.sendStatus(400);
    }

    const directoryPath = path.join(request.user.directories.chats, avatarUrl);
    if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
        return response.sendStatus(400);
    }

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const data = storage.readFileSync(pathToUpload, 'utf8');

        if (format === 'json') {
            storage.unlink(pathToUpload);
            const jsonData = JSON.parse(data);

            /** @type {function(string, string, object): string|string[]} */
            let importFunc;

            if (jsonData.savedsettings !== undefined) { // Kobold Lite format
                importFunc = importKoboldLiteChat;
            } else if (jsonData.histories !== undefined) { // CAI Tools format
                importFunc = importCAIChat;
            } else if (Array.isArray(jsonData.data_visible)) { // oobabooga's format
                importFunc = importOobaChat;
            } else if (Array.isArray(jsonData.messages)) { // Agnai's format
                importFunc = importAgnaiChat;
            } else if (jsonData.type === 'risuChat') { // RisuAI format
                importFunc = importRisuChat;
            } else { // Unknown format
                log.error(LogClass.NORMAL, 'Incorrect chat format .json');
                return response.send({ error: true });
            }

            const handleChat = (chat) => {
                const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
                const filePath = path.join(directoryPath, fileName);
                fileNames.push(fileName);
                storage.writeFileSync(filePath, chat, 'utf8');
            };

            const chat = importFunc(userName, characterName, jsonData);

            if (Array.isArray(chat)) {
                chat.forEach(handleChat);
            } else {
                handleChat(chat);
            }

            return response.send({ res: true, fileNames });
        }

        if (format === 'jsonl') {
            let lines = data.split('\n');
            const header = lines[0];

            const jsonData = JSON.parse(header);

            if (!(jsonData.user_name !== undefined || jsonData.name !== undefined || jsonData.chat_metadata !== undefined)) {
                log.error(LogClass.NORMAL, 'Incorrect chat format .jsonl');
                return response.send({ error: true });
            }

            // Do a tiny bit of work to import Chub Chat data
            // Processing the entire file is so fast that it's not worth checking if it's a Chub chat first
            let flattenedChat = data;
            try {
                // flattening is unlikely to break, but it's not worth failing to
                // import normal chats in an attempt to import a Chub chat
                flattenedChat = flattenChubChat(userName, characterName, lines);
            } catch (error) {
                log.warn(LogClass.SENSITIVE, 'Failed to flatten Chub Chat data: ', error);
            }

            const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
            const filePath = path.join(directoryPath, fileName);
            fileNames.push(fileName);

            // 🔴 WRITE IT, NEVER COPY THE UPLOAD. `DESIGN_MIXED_MODE.md` §8: an import is a NEW chat and
            // takes the provider's default. This branch used `storage.copyFile(pathToUpload, filePath)`,
            // which does not choose the destination's state — it INHERITS the state of the multer staging
            // file, and staging is encrypted only if the provider implements the OPTIONAL `multerStorage`
            // capability. Under a provider that omits it (allowed, like `ownsUser`), the upload stages in the
            // clear and the copy carried that plaintext straight into the chats directory: an imported chat
            // written unencrypted onto an install whose whole premise is encryption at rest, with nothing in
            // the UI to say so. Writing the bytes we already read at the top of this handler costs nothing
            // extra and makes the guarantee unconditional. Both branches now do the same thing for the same
            // reason, which is why they are no longer two branches.
            storage.writeFileSync(filePath, flattenedChat, 'utf8');
            storage.unlink(pathToUpload);
            response.send({ res: true, fileNames });
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to import chat');
        log.error(LogClass.SENSITIVE, error);
        return response.send({ error: true });
    }
});

router.post('/group/get', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

    // Same refusal as `/get`, for the same reason: `[]` is the dangerous answer, not the safe one.
    const unavailable = describeUnavailableData(chatFilePath);

    if (unavailable) {
        return response.status(409).send({ storage: unavailable });
    }

    return response.send(getChatData(chatFilePath));
});

router.post('/group/info', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        const chatInfo = await getChatInfo(chatFilePath);
        return response.send(chatInfo);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to get group chat info');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/group/delete', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        //Return success if the file was deleted.
        if (tryDeleteFile(chatFilePath)) {
            // §24. ⚠️ THE CONSUMER'S LIST OF DELETION PATHS DID NOT INCLUDE THIS ONE — it named single-chat,
            // character-delete-with-chats and whole-group-delete. Deleting ONE conversation from a group is a
            // fourth path and belongs in the same category as the first: a single chat file, gone, with
            // scenario rows keyed on it. Wired for the same reason as the others, and noted here because an
            // omission from a requirements list is exactly the kind of gap that stays quiet.
            await notifyChatDeleted(request.user.profile.handle, chatIdFromPath(chatFilePath));
            return response.send({ ok: true });
        } else {
            log.error(LogClass.NORMAL, 'The group chat file was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to delete group chat');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/group/save', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const handle = request.user.profile.handle;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const chatData = request.body.chat;

        if (Array.isArray(chatData)) {
            await trySaveChat(chatData, chatFilePath, request.body.force, handle, String(id), request.user.directories.backups);
            return response.send({ ok: true });
        } else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof StorageUnavailableError) {
            log.warn(LogClass.NORMAL, 'Refused to save a group chat whose storage provider is not available');
            return response.status(409).send({ storage: error.storage });
        }
        if (error instanceof IntegrityMismatchError) {
            log.error(LogClass.NORMAL, 'Failed to save group chat: integrity check mismatch');
            log.error(LogClass.SENSITIVE, error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        log.error(LogClass.NORMAL, 'Failed to save group chat');
        log.error(LogClass.SENSITIVE, error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/**
 * Does this directory hold at least one file some provider enveloped?
 *
 * The evidence gate for the unresolved-group-chat rows below. An id a group claims but that nothing on disk
 * answers to has two possible explanations — its bytes are here under a name this fork cannot read, or the
 * chat was deleted and the id left behind — and only the first one deserves a row. A directory containing an
 * envelope is what separates them, and it is readable with no provider and no key (§3.1).
 *
 * 🔴 THE GATE IS WHAT KEEPS AN ORDINARY INSTALL UNCHANGED. With no encryption anywhere this returns false,
 * no rows are added, and the endpoint behaves exactly as it did — a stale id stays invisible rather than
 * becoming a permanent dead row telling people to install a plugin that would not bring anything back.
 * @param {string} directory The group chats directory
 * @returns {boolean} True if anything in it carries an envelope header
 */
function directoryHoldsEnvelopes(directory) {
    try {
        for (const name of storage.readdir(directory)) {
            if (path.extname(name) === '.jsonl' && hasEnvelope(path.join(directory, name))) {
                return true;
            }
        }
    } catch (error) {
        log.warn(LogClass.SENSITIVE, 'Could not scan for enveloped chats', error);
    }

    return false;
}

router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;

        /** @type {string[]} */
        let chatFiles = [];

        /** Chat ids a group claims that nothing on disk answers to — see the group branch below. */
        /** @type {string[]} */
        const unresolvedChatIds = [];

        if (group_id) {
            // Find group's chat IDs first
            const groupDir = path.join(request.user.directories.groups);
            const groupFiles = storage.readdir(groupDir)
                .filter(file => path.extname(file) === '.json');

            let targetGroup;
            for (const groupFile of groupFiles) {
                try {
                    const groupData = JSON.parse(storage.readFileSync(path.join(groupDir, groupFile), 'utf8'));
                    if (groupData.id === group_id) {
                        targetGroup = groupData;
                        break;
                    }
                } catch (error) {
                    log.warn(LogClass.SENSITIVE, groupFile, 'group file is corrupted:', error);
                }
            }

            if (!Array.isArray(targetGroup?.chats)) {
                return response.send([]);
            }

            // Find group chat files for given group ID.
            //
            // 🔴 A CHAT THE GROUP CLAIMS BUT THAT DOES NOT RESOLVE IS NOT NOTHING (§11). A group's chats are
            // found by ID from its definition, not by scanning the directory the way character chats are —
            // so when a provider mangles filenames, the logical name stops existing and `storage.exists`
            // says no. Dropping the row there is the §11 harm exactly: with the plugin uninstalled the
            // encrypted group chats silently vanished from the list, which is how a user concludes their
            // data is gone and stops looking for it. The character list never had this failure because it
            // reads the directory and sees the mangled names.
            const groupChatsDir = path.join(request.user.directories.groupChats);
            for (const chatId of targetGroup.chats) {
                const chatFile = path.join(groupChatsDir, `${chatId}.jsonl`);

                if (storage.exists(chatFile)) {
                    chatFiles.push(chatFile);
                } else {
                    unresolvedChatIds.push(String(chatId));
                }
            }
        } else {
            // Regular character chat directory
            const character_name = avatar_url.replace('.png', '');
            const directoryPath = path.join(request.user.directories.chats, character_name);

            if (!storage.exists(directoryPath)) {
                return response.send([]);
            }

            chatFiles = storage.readdir(directoryPath)
                .filter(file => path.extname(file) === '.jsonl')
                .map(fileName => path.join(directoryPath, fileName));
        }

        /**
         * @type {SearchChatResult[]}
         * @typedef {object} SearchChatResult
         * @property {string} [file_name] - The name of the chat file
         * @property {string} [file_size] - The size of the chat file in a human-readable format
         * @property {number} [message_count] - The number of messages in the chat
         * @property {number|string} [last_mes] - The timestamp of the last message
         * @property {string} [preview_message] - A preview of the last message
         */
        const results = [];

        /** @type {string[]} */
        const fragments = query ? query.trim().toLowerCase().split(/\s+/).filter(x => x) : [];

        /** @type {ChatMatchFunction} */
        const hasTextMatch = (textArray) => {
            if (fragments.length === 0) {
                return true;
            }
            return fragments.every(fragment => textArray.some(text => String(text ?? '').toLowerCase().includes(fragment)));
        };

        for (const chatFile of chatFiles) {
            const matcher = query ? hasTextMatch : null;
            const chatInfo = await getChatInfo(chatFile, {}, false, matcher);
            const hasMatch = chatInfo.match || hasTextMatch([chatInfo.file_id ?? '']);

            // Skip corrupted or invalid chat files
            if (!chatInfo.file_name) {
                continue;
            }

            // Empty chats without a file name match are skipped when searching with a query
            if (query && chatInfo.chat_items === 0 && !hasMatch) {
                continue;
            }

            // If no search query or a match was found, include the chat in results
            if (!query || hasMatch) {
                results.push({
                    file_name: chatInfo.file_id,
                    file_size: chatInfo.file_size,
                    message_count: chatInfo.chat_items,
                    last_mes: chatInfo.last_mes,
                    preview_message: getPreviewMessage(chatInfo.mes),
                });
            }
        }

        // §11: show the chats whose bytes are here under a name this fork cannot read, disabled and
        // explained, rather than dropping them. The state is built here and not by `describeStorageState`
        // because there is no path to describe — that function answers for BYTES, and the thing known here
        // is a different fact entirely: the GROUP says this chat exists and nothing on disk answers to it.
        //
        // ⚠️ `requiresProvider` is null — *provider unknown* — deliberately. The id in §3.1 is read from the
        // file's OWN envelope, and there is no file to read one from. Naming the provider off a SIBLING
        // file's envelope would be an inference dressed as a fact, so the client falls back to its existing
        // "requires a storage provider that is not installed" wording instead. Whether that inference is
        // worth making is `DESIGN_MIXED_MODE.md` §14.7.
        if (unresolvedChatIds.length > 0 && directoryHoldsEnvelopes(request.user.directories.groupChats)) {
            for (const chatId of unresolvedChatIds) {
                results.push({
                    file_name: chatId,
                    file_size: '',
                    message_count: 0,
                    last_mes: null,
                    preview_message: '',
                    // 🪪 `identity` is null for the same reason `requiresProvider` is, and the provenance
                    // registry does not change that. The registry answers "what do I know about the
                    // provider this FILE names", and no file here names one. It is the id that is missing,
                    // not the record of it.
                    storage: { encrypted: true, unavailable: true, requiresProvider: null, identity: null },
                });
            }
        }

        return response.send(results);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Chat search failed');
        log.error(LogClass.SENSITIVE, 'Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

router.post('/recent', async function (request, response) {
    try {
        /** @typedef {{pngFile?: string, groupId?: string, filePath: string, mtime: number}} ChatFile */
        /** @type {ChatFile[]} */
        const allChatFiles = [];
        /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];

        const getCharacterChatFiles = async () => {
            const pngDirents = await storage.readdir(request.user.directories.characters, { withFileTypes: true });
            const pngFiles = pngDirents.filter(e => e.isFile() && path.extname(e.name) === '.png').map(e => e.name);

            for (const pngFile of pngFiles) {
                const chatsDirectory = pngFile.replace('.png', '');
                const pathToChats = path.join(request.user.directories.chats, chatsDirectory);
                if (!storage.exists(pathToChats)) {
                    continue;
                }
                const pathStats = await storage.stat(pathToChats);
                if (pathStats.isDirectory()) {
                    const chatFiles = await storage.readdir(pathToChats);
                    const jsonlFiles = chatFiles.filter(file => path.extname(file) === '.jsonl');

                    for (const file of jsonlFiles) {
                        const filePath = path.join(pathToChats, file);
                        const stats = await storage.stat(filePath);
                        allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
                    }
                }
            }
        };

        const getGroupChatFiles = async () => {
            const groupDirents = await storage.readdir(request.user.directories.groups, { withFileTypes: true });
            const groups = groupDirents.filter(e => e.isFile() && path.extname(e.name) === '.json').map(e => e.name);

            for (const group of groups) {
                try {
                    const groupPath = path.join(request.user.directories.groups, group);
                    const groupContents = await storage.readFile(groupPath, 'utf8');
                    const groupData = JSON.parse(groupContents);

                    if (Array.isArray(groupData.chats)) {
                        for (const chat of groupData.chats) {
                            const filePath = path.join(request.user.directories.groupChats, `${chat}.jsonl`);
                            if (!storage.exists(filePath)) {
                                continue;
                            }
                            const stats = await storage.stat(filePath);
                            allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                        }
                    }
                } catch (error) {
                    // Skip group files that can't be read or parsed
                    continue;
                }
            }
        };

        const getRootChatFiles = async () => {
            const dirents = await storage.readdir(request.user.directories.chats, { withFileTypes: true });
            const chatFiles = dirents.filter(e => e.isFile() && path.extname(e.name) === '.jsonl').map(e => e.name);

            for (const file of chatFiles) {
                const filePath = path.join(request.user.directories.chats, file);
                const stats = await storage.stat(filePath);
                allChatFiles.push({ filePath, mtime: stats.mtimeMs });
            }
        };

        await Promise.allSettled([getCharacterChatFiles(), getGroupChatFiles(), getRootChatFiles()]);

        const max = parseInt(request.body.max ?? Number.MAX_SAFE_INTEGER) + pinnedChats.length;
        const isPinned = (/** @type {ChatFile} */ chatFile) => pinnedChats.some(p => p.file_name === path.basename(chatFile.filePath) && (p.avatar === chatFile.pngFile || p.group === chatFile.groupId));
        const recentChats = allChatFiles.sort((a, b) => {
            const isAPinned = isPinned(a);
            const isBPinned = isPinned(b);

            if (isAPinned && !isBPinned) return -1;
            if (!isAPinned && isBPinned) return 1;

            return b.mtime - a.mtime;
        }).slice(0, max);
        const jsonFilesPromise = recentChats.map((file) => {
            const withMetadata = !!request.body.metadata;
            return file.groupId
                ? getChatInfo(file.filePath, { group: file.groupId }, withMetadata)
                : getChatInfo(file.filePath, { avatar: file.pngFile }, withMetadata);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to list recent chats');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import * as storage from '../storage.js';

import { color, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { log, LogClass } from '../logger.js';
import { notifyChatDeleted, chatIdFromPath } from '../chat-lifecycle.js';
import { describeUnavailableData } from '../storage-status.js';

export const router = express.Router();

/**
 * Warns if group data contains deprecated metadata keys and removes them.
 * @param {object} groupData Group data object
 */
function warnOnGroupMetadata(groupData) {
    if (typeof groupData !== 'object' || groupData === null) {
        return;
    }
    ['chat_metadata', 'past_metadata'].forEach(key => {
        if (Object.hasOwn(groupData, key)) {
            log.warn(LogClass.SENSITIVE, color.yellow(`Group JSON data for "${groupData.id}" contains deprecated key "${key}".`));
            delete groupData[key];
        }
    });
}

/**
 * Migrates group metadata to include chat metadata for each group chat instead of the group itself.
 * @param {import('../users.js').UserDirectoryList[]} userDirectories Listing of all users' directories
 */
export async function migrateGroupChatsMetadataFormat(userDirectories) {
    for (const userDirs of userDirectories) {
        try {
            let anyDataMigrated = false;
            const backupPath = path.join(userDirs.backups, '_group_metadata_update');
            const groupFiles = await storage.readdir(userDirs.groups, { withFileTypes: true });
            const groupChatFiles = await storage.readdir(userDirs.groupChats, { withFileTypes: true });
            for (const groupFile of groupFiles) {
                try {
                    const isJsonFile = groupFile.isFile() && path.extname(groupFile.name) === '.json';
                    if (!isJsonFile) {
                        continue;
                    }
                    const groupFilePath = path.join(userDirs.groups, groupFile.name);
                    const groupDataRaw = await storage.readFile(groupFilePath, 'utf8');
                    const groupData = tryParse(groupDataRaw) || {};
                    const needsMigration = ['chat_metadata', 'past_metadata'].some(key => Object.hasOwn(groupData, key));
                    if (!needsMigration) {
                        continue;
                    }
                    if (!storage.exists(backupPath)) {
                        await storage.mkdir(backupPath, { recursive: true });
                    }
                    await storage.copyFile(groupFilePath, path.join(backupPath, groupFile.name));
                    const allMetadata = {
                        ...(groupData.past_metadata || {}),
                        [groupData.chat_id]: (groupData.chat_metadata || {}),
                    };
                    if (!Array.isArray(groupData.chats)) {
                        log.warn(LogClass.SENSITIVE, color.yellow(`Group ${groupFile.name} has no chats array, skipping migration.`));
                        continue;
                    }
                    for (const chatId of groupData.chats) {
                        try {
                            const chatFileName = sanitize(`${chatId}.jsonl`);
                            const chatFileDirent = groupChatFiles.find(f => f.isFile() && f.name === chatFileName);
                            if (!chatFileDirent) {
                                log.warn(LogClass.SENSITIVE, color.yellow(`Group chat file ${chatId} not found, skipping migration.`));
                                continue;
                            }
                            const chatFilePath = path.join(userDirs.groupChats, chatFileName);
                            const chatMetadata = allMetadata[chatId] || {};
                            const chatDataRaw = await storage.readFile(chatFilePath, 'utf8');
                            const chatData = chatDataRaw.split('\n').filter(line => line.trim()).map(line => tryParse(line)).filter(Boolean);
                            const alreadyHasMetadata = chatData.length > 0 && Object.hasOwn(chatData[0], 'chat_metadata');
                            if (alreadyHasMetadata) {
                                log.info(LogClass.SENSITIVE, color.yellow(`Group chat ${chatId} already has chat metadata, skipping update.`));
                                continue;
                            }
                            await storage.copyFile(chatFilePath, path.join(backupPath, chatFileName));
                            const chatHeader = { chat_metadata: chatMetadata, user_name: 'unused', character_name: 'unused' };
                            const newChatData = [chatHeader, ...chatData];
                            const newChatDataRaw = newChatData.map(entry => JSON.stringify(entry)).join('\n');
                            await storage.writeFile(chatFilePath, newChatDataRaw, 'utf8');
                            log.info(LogClass.SENSITIVE, `Updated group chat data format for ${chatId}`);
                            anyDataMigrated = true;
                        } catch (chatError) {
                            log.error(LogClass.NORMAL, color.red('Could not update existing chat data during group metadata migration'));
                            log.error(LogClass.SENSITIVE, color.red(`Could not update existing chat data for ${chatId}`), chatError);
                        }
                    }
                    delete groupData.chat_metadata;
                    delete groupData.past_metadata;
                    await storage.writeFile(groupFilePath, JSON.stringify(groupData, null, 4), 'utf8');
                    log.info(LogClass.SENSITIVE, `Migrated group chats metadata for group: ${groupData.id}`);
                    anyDataMigrated = true;
                } catch (groupError) {
                    log.error(LogClass.NORMAL, color.red('Could not process a group file during group metadata migration'));
                    log.error(LogClass.SENSITIVE, color.red(`Could not process group file ${groupFile.name}`), groupError);
                }
            }
            if (anyDataMigrated) {
                log.info(LogClass.SENSITIVE, color.green(`Completed migration of group chats metadata for user at ${userDirs.root}`));
                log.info(LogClass.SENSITIVE, color.cyan(`Backups of modified files are located at ${backupPath}`));
            }
        } catch (directoryError) {
            log.error(LogClass.NORMAL, color.red('Error migrating group chats metadata for a user'));
            log.error(LogClass.SENSITIVE, color.red(`Error migrating group chats metadata for user at ${userDirs.root}`), directoryError);
        }
    }
}

router.post('/all', (request, response) => {
    const groups = [];

    if (!storage.exists(request.user.directories.groups)) {
        storage.mkdir(request.user.directories.groups);
    }

    const files = storage.readdir(request.user.directories.groups).filter(x => path.extname(x) === '.json');
    const chats = storage.readdir(request.user.directories.groupChats).filter(x => path.extname(x) === '.jsonl');

    files.forEach(function (file) {
        const filePath = path.join(request.user.directories.groups, file);

        try {
            const fileContents = storage.readFileSync(filePath, 'utf8');
            const group = JSON.parse(fileContents);
            const groupStat = storage.stat(filePath);
            group.date_added = groupStat.birthtimeMs;
            group.create_date = new Date(groupStat.birthtimeMs).toISOString();

            let chat_size = 0;
            let date_last_chat = 0;

            if (Array.isArray(group.chats) && Array.isArray(chats)) {
                for (const chat of chats) {
                    if (group.chats.includes(path.parse(chat).name)) {
                        const chatStat = storage.stat(path.join(request.user.directories.groupChats, chat));
                        chat_size += chatStat.size;
                        date_last_chat = Math.max(date_last_chat, chatStat.mtimeMs);
                    }
                }
            }

            group.date_last_chat = date_last_chat;
            group.chat_size = chat_size;
            groups.push(group);
        } catch (error) {
            // 🪪 THE FIFTH DATA TYPE — a group DEFINITION whose provider is gone (`DESIGN_STORAGE_PROVENANCE.md`
            // §7 surface 4 / §12.3). A group written through a name-encrypting provider is enveloped on disk;
            // once the plugin is uninstalled the read succeeds as plain `fs` and hands `JSON.parse` an
            // envelope, which throws — and this handler used to log and DROP the group. The definition simply
            // vanished from the list, and the group read as deleted, the exact §11 mistake surface 4 exists to
            // stop. Only a parseable envelope earns this: an ordinary corrupt group JSON still falls through to
            // the log below, because telling a user to reinstall a plugin they never had is worse than silence.
            const unavailable = describeUnavailableData(filePath);

            if (unavailable) {
                const id = path.parse(file).name;
                groups.push({ id, name: id, members: [], disabled_members: [], chats: [], chat_id: id, storage: unavailable });
                return;
            }

            log.error(LogClass.NORMAL, 'Failed to read a group definition while listing groups');
            log.error(LogClass.SENSITIVE, error);
        }
    });

    return response.send(groups);
});

router.post('/create', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    warnOnGroupMetadata(request.body);
    const id = String(Date.now());
    const groupMetadata = {
        id: id,
        name: request.body.name ?? 'New Group',
        members: request.body.members ?? [],
        avatar_url: request.body.avatar_url,
        allow_self_responses: !!request.body.allow_self_responses,
        activation_strategy: request.body.activation_strategy ?? 0,
        generation_mode: request.body.generation_mode ?? 0,
        disabled_members: request.body.disabled_members ?? [],
        fav: request.body.fav,
        chat_id: request.body.chat_id ?? id,
        chats: request.body.chats ?? [id],
        auto_mode_delay: request.body.auto_mode_delay ?? 5,
        generation_mode_join_prefix: request.body.generation_mode_join_prefix ?? '',
        generation_mode_join_suffix: request.body.generation_mode_join_suffix ?? '',
    };
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const fileData = JSON.stringify(groupMetadata, null, 4);

    if (!storage.exists(request.user.directories.groups)) {
        storage.mkdir(request.user.directories.groups);
    }

    storage.writeFileSync(pathToFile, fileData);
    return response.send(groupMetadata);
});

router.post('/edit', getFileNameValidationFunction('id'), (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }
    warnOnGroupMetadata(request.body);
    const id = request.body.id;
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const fileData = JSON.stringify(request.body, null, 4);

    // 🪪 `/all` SYNTHESISES A PLACEHOLDER FOR AN UNREADABLE GROUP, AND THIS ROUTE WOULD WRITE IT BACK.
    // That row carries `members: []`, `chats: []` and default generation settings — an honest description of
    // what could be read, and a catastrophic thing to save. Anything that round-trips the list (a stale tab,
    // a third-party extension, a script) would replace the real definition with the placeholder. The client
    // marks the row unclickable, but a client guard cannot protect a server-side write.
    const unavailable = describeUnavailableData(pathToFile);

    if (unavailable) {
        return response.status(409).send({ storage: unavailable });
    }

    storage.writeFileSync(pathToFile, fileData);
    return response.send({ ok: true });
});

router.post('/delete', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const pathToGroup = path.join(request.user.directories.groups, sanitize(`${id}.json`));

    // 🔴 REFUSE BEFORE DESTROYING, BECAUSE THE CATCH BELOW FALLS THROUGH. `JSON.parse` throws on an
    // enveloped definition, the catch logs "clean them up manually", and control continues to the unlink —
    // so the group was destroyed AND its chat files were left behind, orphaned on disk for ever, with
    // `{ ok: true }` returned. The chats could not be named because the very list naming them was the thing
    // that could not be read. `storage.js` is explicit that EUNAVAILABLE and EPROVIDER "must NEVER be
    // handled by regenerating, resetting, pruning or deleting."
    const unavailable = describeUnavailableData(pathToGroup);

    if (unavailable) {
        return response.status(409).send({ storage: unavailable });
    }

    try {
        // Delete group chats
        const group = JSON.parse(storage.readFileSync(pathToGroup, 'utf8'));

        if (group && Array.isArray(group.chats)) {
            for (const chat of group.chats) {
                log.info(LogClass.SENSITIVE, 'Deleting group chat', chat);
                const pathToFile = path.join(request.user.directories.groupChats, sanitize(`${chat}.jsonl`));

                if (storage.exists(pathToFile)) {
                    storage.unlink(pathToFile);

                    // §24: one signal per chat, after its file is gone. This loop already names each chat
                    // individually, so unlike the character-delete path there is nothing to enumerate first.
                    //
                    // ✅ The ids here are the same namespace the generation header carries: a group's
                    // `chat_id` defaults to the group's own id (`:172`), and `getCurrentChatId()` returns
                    // `group.chat_id` for a group — so `s:<chatId>` composed at write time matches what is
                    // emitted here. They are uuids, so they also carry no collision risk.
                    await notifyChatDeleted(request.user.profile.handle, chatIdFromPath(pathToFile));
                }
            }
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Could not delete group chats. Clean them up manually.');
        log.error(LogClass.SENSITIVE, 'Group chat deletion error:', error);
    }

    // ⚠️ AND ANSWER EVEN IF THE UNLINK FAILS. This route became `async` in the fork, and Express 4 does not
    // forward a rejection out of an async handler — so a throw here did not become a 500, it became NOTHING:
    // no status, no body, a socket left hanging until the client gave up. The chats above are already gone
    // by this point, so silence is the one answer that helps nobody.
    try {
        if (storage.exists(pathToGroup)) {
            storage.unlink(pathToGroup);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'The group chats were deleted, but the group definition could not be removed.');
        log.error(LogClass.SENSITIVE, 'Group definition deletion error:', error);
        return response.status(500).send({ error: 'The group could not be fully deleted.' });
    }

    return response.send({ ok: true });
});

import * as storage from '../storage.js';
import express from 'express';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { CHAT_BACKUPS_PREFIX, getChatInfo } from './chats.js';
import { log, LogClass } from '../logger.js';
import { describeStorageState } from '../storage-status.js';

/**
 * 🔀 CHAT BACKUPS IN MIXED MODE — `DESIGN_MIXED_MODE.md` §9, §11, §14.5.
 *
 * §14.5 is settled and the decision is deliberate: **a legacy plaintext chat's backups become encrypted once
 * a provider is installed.** `backupChat` writes a brand-new file per save and a new file takes the
 * provider's default, so the backup tail of a plaintext chat is enveloped from the install onwards. That is
 * wanted — the backup directory is the one place where "everything from here on is protected" is the right
 * rule — but it hands this router the obligation that came with the decision:
 *
 * 🔴 **A backup that cannot be decrypted must SAY SO, and must never be handed to the chat importer.** The
 * user's own words for it: *trying to restore them should tell the user they need the plugin to restore it.*
 * Two things follow, and both are here rather than in the UI, because the UI's copy of the state is always
 * one uninstall out of date:
 *
 * 1. The listing must still LIST them (§11). With the provider gone the names on disk are the provider's
 *    mangled ones, so a prefix match finds nothing — the row vanishes and the user concludes the backups are
 *    gone. The envelope, readable with no provider and no key, is what keeps the row alive.
 * 2. The download must REFUSE them, with the provider id, rather than serving ciphertext. `restoreBackup()`
 *    feeds whatever it downloads straight to `importCharacterChat`, so serving ciphertext does not fail
 *    politely: it imports a garbage chat into the user's chat list and calls it a restore.
 */

export const router = express.Router();

/**
 * One row of the backups list: everything the chat listing says about a file, plus the storage state the
 * browser needs to draw the §11 dead row instead of a normal-looking row whose buttons fail on click.
 * @typedef {import('./chats.js').ChatInfo & {storage: import('../storage-status.js').StorageState}} BackupInfo
 */

/**
 * Is this resolved path a chat backup the caller is allowed to act on?
 *
 * The guard on delete and download, and it had the same blind spot the listing had: with the provider gone
 * the file is under its mangled name, so the `chat_` prefix is absent from a file the listing just offered.
 * Refusing it here would mean the row is visible and every button on it 400s. An enveloped `.jsonl` in the
 * backups directory is the same file the listing accepted, so accept it here too — and nothing widens beyond
 * that directory, because the caller joined the path there and `sanitize` removed any way back out of it.
 * @param {string} filePath The resolved absolute path
 * @returns {boolean} True if the path may be acted on
 */
function isChatBackupPath(filePath) {
    const base = path.parse(filePath).base;

    if (base.startsWith(CHAT_BACKUPS_PREFIX)) {
        return true;
    }

    return path.extname(base) === '.jsonl' && describeStorageState(filePath).encrypted;
}

router.post('/chat/get', async (request, response) => {
    try {
        /** @type {BackupInfo[]} */
        const backupModels = [];
        const directory = request.user.directories.backups;

        // 🔴 storage.readdir, NOT fs. Under a provider that encrypts filenames the raw directory holds
        // ciphertext names: nothing ends in '.jsonl', nothing starts with the prefix, this filter matches
        // nothing, and the endpoint returns [] with a 200. The backups are written correctly and are all
        // still there -- the restore UI just reports "no backups", silently and for ever, which is the
        // worst place to be wrong because it is where a user goes when something has already gone wrong.
        //
        // At the top of the backups directory a `.jsonl` file is a chat backup and every other backup kind is
        // `.json`, so the extension is the outer filter and the `chat_` stem is not — see below for why it
        // cannot be.
        const candidates = storage
            .readdir(directory, { withFileTypes: true })
            .filter(d => d.isFile() && path.extname(d.name) === '.jsonl')
            .map(d => d.name);

        for (const name of candidates) {
            const filePath = path.join(directory, name);
            const state = describeStorageState(filePath);

            // 🔴 PREFIX **OR** ENVELOPE. With a provider installed and unlocked, `readdir` hands back logical
            // names and the prefix is the whole answer. With the provider GONE the same file appears under
            // the provider's mangled name — it keeps its `.jsonl` extension (§14.2) but not its `chat_` stem
            // — so a prefix-only filter drops exactly the files the user most needs to see, on the one screen
            // they open because something has already gone wrong (§11).
            if (!name.startsWith(CHAT_BACKUPS_PREFIX) && !state.encrypted) {
                continue;
            }

            const info = await getChatInfo(filePath);
            if (!info || !info.file_name) {
                continue;
            }

            // The row carries its own storage state so the browser can draw the §11 dead row — reason shown,
            // name of the plugin it needs — instead of a normal-looking row whose buttons fail on click.
            backupModels.push({ ...info, storage: state });
        }

        return response.json(backupModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to list chat backups');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/chat/delete', async (request, response) => {
    try {
        const { name } = request.body;
        const filePath = path.join(request.user.directories.backups, sanitize(name));

        if (!isChatBackupPath(filePath)) {
            log.warn(LogClass.SENSITIVE, 'Attempt to delete non-chat backup file:', name);
            return response.sendStatus(400);
        }

        if (!storage.exists(filePath)) {
            return response.sendStatus(404);
        }

        // Deliberately NOT gated on decryptability. Deleting a backup nothing can read is the one action that
        // still makes sense on it, and refusing would leave the user with a row they can neither use nor
        // clear.
        await storage.unlink(filePath);
        return response.sendStatus(200);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to delete a chat backup');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/chat/download', async (request, response) => {
    try {
        const { name } = request.body;
        const filePath = path.join(request.user.directories.backups, sanitize(name));

        if (!isChatBackupPath(filePath)) {
            log.warn(LogClass.SENSITIVE, 'Attempt to download non-chat backup file:', name);
            return response.sendStatus(400);
        }

        if (!storage.exists(filePath)) {
            return response.sendStatus(404);
        }

        const state = describeStorageState(filePath);

        if (state.unavailable) {
            // 🔴 THE §14.5 OBLIGATION, ENFORCED SERVER-SIDE. Both callers of this route feed what comes back
            // into something that assumes chat text -- the viewer parses it as JSONL, the restorer posts it
            // to the chat importer -- so ciphertext served here becomes an imported garbage chat, which is a
            // worse outcome than any refusal. 409 rather than 404: the backup is emphatically THERE, and
            // "not found" is the one thing it must never be told (§11).
            return response.status(409).json({
                error: 'unavailable',
                // Validated to `[a-z0-9-]{1,32}` or dropped to null on the way out of the envelope, so this
                // is a plausible id or nothing -- never the string a planted file claimed (§3.1). The client
                // renders it as text and MUST NOT build an install link out of it.
                requiresProvider: state.requiresProvider,
                // 🪪 And whatever the fork itself recorded about that provider while it was installed, so
                // the refusal can name it rather than repeating a slug. Null when there is no record --
                // which is the case a planted id lands in, and it stays exactly as terse as it is today.
                identity: state.identity ?? null,
            });
        }

        // `response.download()` is sendFile plus a Content-Disposition header, and it reads the file
        // itself. Set the header ourselves and let the funnel produce the bytes.
        response.attachment(path.parse(filePath).base);
        return await storage.sendFile(response, filePath);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to download a chat backup');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

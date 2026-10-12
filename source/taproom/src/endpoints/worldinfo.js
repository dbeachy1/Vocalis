import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import * as storage from '../storage.js';
import { describeUnavailableData } from '../storage-status.js';
import { tryParse } from '../util.js';
import { log, LogClass } from '../logger.js';
import { emitForRequest } from '../event-stream.js';

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(directories.worlds, filename);

    if (!storage.exists(pathToWorldInfo)) {
        log.error(LogClass.NORMAL, 'The requested World Info file does not exist.');
        log.error(LogClass.SENSITIVE, `World info file ${filename} doesn't exist.`);
        return dummyObject;
    }

    const worldInfoText = storage.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}

export const router = express.Router();

/**
 * Reads a world's change token: what {@link describeChangeToken} is for, and nothing more.
 *
 * 🔴 THIS IS A CHANGE DETECTOR, NOT A HISTORY. `mtime` answers exactly one question — *are these the
 * same bytes I saw last time?* — and it answers it conservatively: it moves for reasons other than an
 * edit (an atomic write leaves the temp file's stamp; a provider resealing on key rotation rewrites
 * every file it owns), so it can say "changed" when nothing was changed. It can never say "unchanged"
 * about a book that was. A caller that warns before an overwrite gets a spurious warning at worst; one
 * that skipped the warning on a stale token would lose the user's edits, which is why the asymmetry is
 * the right way round.
 *
 * ⚠️ **Not a content hash, on purpose.** `/list` already reads every file to pull `extensions` out, so
 * hashing would be nearly free HERE — and would then be a promise this endpoint could not keep the day
 * that read is made lazy. `size` rides along because it is free and turns the common
 * same-second-two-writes case from a miss into a hit.
 *
 * Added for the Vocalis worldbook editor (C11), which imports a book, edits it over days and pushes it
 * back: without a token there is no way to notice that SillyTavern's copy moved in between, and the
 * push silently discards whatever happened here.
 * @param {string} filePath Absolute path to the world file
 * @returns {{mtime: number, size: number}|null} The token, or null if the file could not be stat'd
 */
function describeChangeToken(filePath) {
    try {
        const stat = storage.stat(filePath);
        return { mtime: Math.round(stat.mtimeMs), size: stat.size };
    } catch {
        // A world we cannot stat still lists — it just lists without a token, and a caller with no token
        // has to assume it changed. Losing the row entirely would be far worse than losing the hint.
        return null;
    }
}

router.post('/list', async (request, response) => {
    try {
        const data = [];
        const jsonFiles = (await storage.readdir(request.user.directories.worlds, { withFileTypes: true }))
            .filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === '.json')
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const file of jsonFiles) {
            const filePath = path.join(request.user.directories.worlds, file.name);
            const fileNameWithoutExt = path.parse(file.name).name;
            const change = describeChangeToken(filePath);

            try {
                const fileContents = await storage.readFile(filePath, 'utf8');
                const fileContentsParsed = tryParse(fileContents);

                // 🪪 A WORLD THAT WOULD OTHERWISE LIST AS EMPTY AND EDITABLE
                // (`DESIGN_STORAGE_PROVENANCE.md` §7 surface 4.)
                //
                // `tryParse` returns undefined for anything that is not JSON, and an envelope is not JSON.
                // The old `|| {}` turned that straight into a world with no entries — one that lists, opens
                // and EDITS like an empty one, directly on top of bytes the user cannot currently see. The
                // next save writes over them. So an unparseable file is asked the provenance question before
                // it is allowed to become `{}`, and when the answer is "its plugin is gone" the row says so.
                const unavailable = fileContentsParsed === undefined ? describeUnavailableData(filePath) : null;

                if (unavailable) {
                    data.push({ file_id: fileNameWithoutExt, name: fileNameWithoutExt, extensions: {}, storage: unavailable, change });
                    continue;
                }

                const fileExtensions = fileContentsParsed?.extensions || {};
                const fileData = {
                    file_id: fileNameWithoutExt,
                    name: fileContentsParsed?.name || fileNameWithoutExt,
                    extensions: _.isObjectLike(fileExtensions) ? fileExtensions : {},
                    change,
                };
                data.push(fileData);
            } catch (err) {
                // A THROWN read is the other half of the same question. The provider being locked rather
                // than uninstalled lands here, and so does an ordinary I/O failure; only the first has an
                // envelope to read, and only the first gets named.
                const unavailable = describeUnavailableData(filePath);

                if (unavailable) {
                    data.push({ file_id: fileNameWithoutExt, name: fileNameWithoutExt, extensions: {}, storage: unavailable, change });
                    continue;
                }

                log.warn(LogClass.SENSITIVE, `Error reading or parsing World Info file ${file.name}:`, err);
            }
        }

        return response.send(data);
    } catch (err) {
        log.error(LogClass.NORMAL, 'Error reading the World Info directory');
        log.error(LogClass.SENSITIVE, 'Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    try {
        const file = readWorldInfoFile(request.user.directories, request.body.name, true);
        return response.send(file);
    } catch (err) {
        // 🪪 §7 surface 4. `readWorldInfoFile` throws on bytes that are not JSON, which is the correct and
        // fail-closed answer for an enveloped file — an `{ entries: {} }` fallback here would hand the
        // editor an empty world backed by the user's real one. What it cannot do is SAY anything, so the
        // browser got a bare 500 and the user got "something went wrong". If the reason is a missing
        // plugin, answer with the id and let the client name it.
        const unavailable = describeUnavailableData(path.join(request.user.directories.worlds, sanitize(`${request.body.name}.json`)));

        if (unavailable) {
            return response.status(409).send({ storage: unavailable });
        }

        throw err;
    }
});

router.post('/delete', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(request.user.directories.worlds, filename);

    if (!storage.exists(pathToWorldInfo)) {
        throw new Error(`World info file ${filename} doesn't exist.`);
    }

    // 🪪 §7 surface 4, on the DESTRUCTIVE half — and this is the half where being wrong is unrecoverable.
    //
    // `loadWorldInfo` already 409s here so the native editor hides rather than opening an empty world over
    // the user's real one, and `markUnavailableWorlds()` disables the matching `<option>` so an unreadable
    // world cannot even be selected. Both of those live in the CLIENT, and a client is not where a rule
    // about destroying data belongs: anything that talks to this endpoint — a third-party extension
    // building its own lorebook list, a script, a stray curl — bypasses them completely.
    //
    // 🔴 THE FAILURE IS NOT THAT DELETE IS OFFERED, IT IS THAT THE WORLD LOOKS EMPTY. With no provider
    // registered, `storage.exists` and `storage.unlink` are plain `fs` against the file's own scrambled
    // on-disk name — so the file is found, and unlinking it succeeds. A caller that reads "unreadable" as
    // "zero entries" therefore asks to delete a lorebook it has been told is empty, gets a yes, and the
    // ciphertext is gone for good. `storage.js` states the rule this restores: EUNAVAILABLE and EPROVIDER
    // "must NEVER be handled by regenerating, resetting, pruning or deleting."
    const unavailable = describeUnavailableData(pathToWorldInfo);

    if (unavailable) {
        return response.status(409).send({ storage: unavailable });
    }

    storage.unlink(pathToWorldInfo);

    // 🔴 AFTER THE WRITE, NEVER BEFORE IT. Every emit in this file is placed below the operation it
    // describes and below every guard that can refuse it — the 409 above returns without emitting, because
    // announcing a deletion that did not happen would have every open tab drop a World Book that is still
    // there. An event is a statement of fact about the disk, not an intention.
    emitForRequest(request, 'worldinfo.deleted', { name: worldInfoName });

    return response.sendStatus(200);
});

router.post('/import', (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const filename = `${path.parse(sanitize(request.file.originalname)).name}.json`;

    let fileContents = null;

    if (request.body.convertedData) {
        fileContents = request.body.convertedData;
    } else {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        fileContents = storage.readFileSync(pathToUpload, 'utf8');
        storage.unlink(pathToUpload);
    }

    try {
        const worldContent = JSON.parse(fileContents);
        if (!('entries' in worldContent)) {
            throw new Error('File must contain a world info entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const pathToNewFile = path.join(request.user.directories.worlds, filename);
    const worldName = path.parse(pathToNewFile).name;

    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }

    // 🪪 THE THIRD DOOR INTO THE SAME OVERWRITE. `/edit` and `/delete` both guard this and this route did
    // not, which made importing the quieter way to do exactly what `/edit` refuses: the destination is
    // derived from the uploaded file's STEM, so a "Vault Notes.json" from anywhere lands on the logical path
    // of an existing unreadable "Vault Notes" and replaces it with a plausible plaintext world nobody will
    // question later. Same guard, same reason, same fail-closed answer.
    const unavailable = describeUnavailableData(pathToNewFile);

    if (unavailable) {
        return response.status(409).send({ storage: unavailable });
    }

    storage.writeFileSync(pathToNewFile, fileContents);
    emitForRequest(request, 'worldinfo.updated', { name: worldName });
    return response.send({ name: worldName });
});

router.post('/edit', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    try {
        if (!('entries' in request.body.data)) {
            throw new Error('World info must contain an entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const filename = sanitize(`${request.body.name}.json`);
    const pathToFile = path.join(request.user.directories.worlds, filename);

    // 🪪 The same guard as `/delete`, and the same reason — this is the overwrite the comment on
    // `loadWorldInfo` names when it says "an empty world here would open an editor over the user's real one,
    // and the next save would overwrite it". Deleting is louder, but this one is worse: it is silent, and it
    // replaces ciphertext with a plausible-looking plaintext world nobody will question later.
    //
    // ⚠️ CREATING A WORLD STILL WORKS. A path with no file, or a file with no envelope, describes as
    // plaintext and reports nothing — so this fires only for bytes that are enveloped and unreadable, never
    // for a new world or an ordinary one.
    const unavailable = describeUnavailableData(pathToFile);

    if (unavailable) {
        return response.status(409).send({ storage: unavailable });
    }

    storage.writeFileSync(pathToFile, JSON.stringify(request.body.data, null, 4));

    emitForRequest(request, 'worldinfo.updated', { name: request.body.name });

    return response.send({ ok: true });
});

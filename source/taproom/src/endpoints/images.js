import * as storage from '../storage.js';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import archiver from 'archiver';
import express from 'express';
import sanitize from 'sanitize-filename';

import { clientRelativePath, removeFileExtension, getImages, isPathUnderParent } from '../util.js';
import { MEDIA_EXTENSIONS, MEDIA_REQUEST_TYPE } from '../constants.js';
import { log, LogClass } from '../logger.js';

/**
 * Ensure the directory for the provided file path exists.
 * If not, it will recursively create the directory.
 *
 * @param {string} filePath - The full path of the file for which the directory should be ensured.
 */
function ensureDirectoryExistence(filePath) {
    const dirname = path.dirname(filePath);
    if (storage.exists(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    storage.mkdir(dirname);
}

export const router = express.Router();

/**
 * Endpoint to handle image uploads.
 * The image should be provided in the request body in base64 format.
 * Optionally, a character name can be provided to save the image in a sub-folder.
 *
 * @route POST /api/images/upload
 * @param {Object} request.body - The request payload.
 * @param {string} request.body.image - The base64 encoded image data.
 * @param {string} [request.body.ch_name] - Optional character name to determine the sub-directory.
 * @returns {Object} response - The response object containing the path where the image was saved.
 */
router.post('/upload', async (request, response) => {
    try {
        if (!request.body) {
            return response.status(400).send({ error: 'No data provided' });
        }

        const { image, format } = request.body;

        if (!image) {
            return response.status(400).send({ error: 'No image data provided' });
        }

        const validFormat = MEDIA_EXTENSIONS.includes(format);
        if (!validFormat) {
            return response.status(400).send({ error: 'Invalid image format' });
        }

        // Constructing filename and path
        let filename;
        if (request.body.filename) {
            filename = `${removeFileExtension(request.body.filename)}.${format}`;
        } else {
            filename = `${Date.now()}.${format}`;
        }

        // if character is defined, save to a sub folder for that character
        let pathToNewFile = path.join(request.user.directories.userImages, sanitize(filename));
        if (request.body.ch_name) {
            pathToNewFile = path.join(request.user.directories.userImages, sanitize(request.body.ch_name), sanitize(filename));
        }

        ensureDirectoryExistence(pathToNewFile);
        const imageBuffer = Buffer.from(image, 'base64');
        // 🔴 Pass the Buffer, not a Uint8Array view of it. `node:fs` accepts any TypedArray, but a
        // storage provider is free to accept only Buffer — and one that falls back to
        // `Buffer.from(String(data))` on anything else encrypts the comma-joined decimal byte list
        // instead of the image. It does not throw, and the file comes back the wrong length.
        await storage.writeFile(pathToNewFile, imageBuffer);
        response.send({ path: clientRelativePath(request.user.directories.root, pathToNewFile) });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to save an uploaded image');
        log.error(LogClass.SENSITIVE, error);
        response.status(500).send({ error: 'Failed to save the image' });
    }
});

router.post('/list/:folder?', (request, response) => {
    try {
        if (request.params.folder) {
            if (request.body.folder) {
                return response.status(400).send({ error: 'Folder specified in both URL and body' });
            }

            log.warn(LogClass.NORMAL, 'Deprecated: Use POST /api/images/list with folder in request body');
            request.body.folder = request.params.folder;
        }

        if (!request.body.folder) {
            return response.status(400).send({ error: 'No folder specified' });
        }

        const directoryPath = path.join(request.user.directories.userImages, sanitize(request.body.folder));
        const type = Number(request.body.type ?? MEDIA_REQUEST_TYPE.IMAGE);
        const sort = request.body.sortField || 'date';
        const order = request.body.sortOrder || 'asc';

        if (!storage.exists(directoryPath)) {
            storage.mkdir(directoryPath, { recursive: true });
        }

        const images = getImages(directoryPath, sort, type);
        if (order === 'desc') {
            images.reverse();
        }
        return response.send(images);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to list images in a user image folder');
        log.error(LogClass.SENSITIVE, error);
        return response.status(500).send({ error: 'Unable to retrieve files' });
    }
});

router.post('/folders', (request, response) => {
    try {
        const directoryPath = request.user.directories.userImages;
        if (!storage.exists(directoryPath)) {
            storage.mkdir(directoryPath, { recursive: true });
        }

        const folders = storage.readdir(directoryPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        return response.send(folders);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to list user image folders');
        log.error(LogClass.SENSITIVE, error);
        return response.status(500).send({ error: 'Unable to retrieve folders' });
    }
});

/**
 * Streams every image in one gallery folder as a zip.
 *
 * 🔴 **THE VAULT MADE THE IMAGE FOLDER UNBROWSABLE, AND THAT WAS A REAL LOSS.** Before encryption you
 * could open the folder and copy out the pictures you wanted to keep. Now the bytes on disk are
 * ciphertext and the only way out was one right-click-save at a time, or the whole-data-root backup —
 * a sledgehammer that also exports chats and settings.
 *
 * ⚠️ **Do NOT let archiver read the directory itself** (`archive.directory()`, `archive.glob()`). Those
 * never ask SillyTavern to read a file, so there is no `readFile` to intercept, and under a
 * transforming provider they would zip the raw ciphertext — producing an archive of unopenable
 * garbage that looks perfectly fine until you try to view a picture. Walk the entries and hand
 * archiver the LOGICAL bytes, exactly as `createBackupArchive` does (`users.js:2203`).
 *
 * Like the backup button, this is a deliberate, user-initiated plaintext export. That is the point of
 * it, not a leak.
 */
router.post('/download-folder', async (request, response) => {
    try {
        if (!request.body?.folder) {
            return response.status(400).send({ error: 'No folder specified' });
        }

        const folderName = sanitize(String(request.body.folder));

        if (!folderName) {
            return response.status(400).send({ error: 'Invalid folder name' });
        }

        const directoryPath = path.join(request.user.directories.userImages, folderName);

        if (!isPathUnderParent(request.user.directories.userImages, directoryPath)) {
            return response.status(400).send({ error: 'Invalid path' });
        }

        if (!storage.exists(directoryPath)) {
            return response.status(404).send({ error: 'Folder not found' });
        }

        const fileNames = storage.readdir(directoryPath, { withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => entry.name)
            .filter(name => MEDIA_EXTENSIONS.includes(path.extname(name).slice(1).toLowerCase()));

        // Answer before any headers are committed. Once the archive is piped, a failure can no longer
        // be reported as a status code -- the browser is already downloading something.
        if (!fileNames.length) {
            return response.status(404).send({ error: 'No images in this folder' });
        }

        const archive = archiver('zip');

        archive.on('error', function (error) {
            log.error(LogClass.NORMAL, 'Gallery archive failed.');
            log.error(LogClass.SENSITIVE, error);
        });

        response.attachment(`${folderName}.zip`);
        // @ts-ignore
        archive.pipe(response);

        // ⚠️ ABORT THE ARCHIVE IF A READ FAILS, AND ONLY THEN RETHROW. Without the abort the rejection
        // unwinds while the archiver is still piped to a live response, so nothing finalises it and the
        // client holds an open connection to a zip that never ends.
        try {
            for (const name of fileNames) {
                const contents = await storage.readFile(path.join(directoryPath, name));
                archive.append(Buffer.isBuffer(contents) ? contents : Buffer.from(contents), { name });
            }
        } catch (error) {
            archive.abort();
            throw error;
        }

        await archive.finalize();
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to archive a user image folder');
        log.error(LogClass.SENSITIVE, error);

        if (!response.headersSent) {
            return response.status(500).send({ error: 'Unable to create the archive' });
        }

        return response.end();
    }
});

router.post('/delete', async (request, response) => {
    try {
        if (!request.body.path) {
            return response.status(400).send('No path specified');
        }

        const pathToDelete = path.join(request.user.directories.root, request.body.path);
        if (!isPathUnderParent(request.user.directories.userImages, pathToDelete)) {
            return response.status(400).send('Invalid path');
        }

        if (!storage.exists(pathToDelete)) {
            return response.status(404).send('File not found');
        }

        storage.unlink(pathToDelete);
        log.info(LogClass.SENSITIVE, `Deleted image: ${request.body.path} from ${request.user.profile.handle}`);
        return response.sendStatus(200);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to delete a user image');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

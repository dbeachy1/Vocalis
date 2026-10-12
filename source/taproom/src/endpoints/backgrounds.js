import * as storage from '../storage.js';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { invalidateThumbnail } from './thumbnails.js';
import { thumbnailDimensions, readMetadataIndex, renameMetadata, removeMetadata, getOrGenerateMetadataBatch } from './image-metadata.js';
import { getImages } from '../util.js';
import { describeUnavailableData } from '../storage-status.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { log, LogClass } from '../logger.js';

export const router = express.Router();

router.post('/all', async function (request, response) {
    try {
        const directories = request.user.directories;
        const images = getImages(directories.backgrounds);
        const config = { width: thumbnailDimensions.bg[0], height: thumbnailDimensions.bg[1] };

        // Get metadata for all images to provide isAnimated flag to client
        const relativePaths = images.map(img => path.join('backgrounds', img));
        const { results: metadataMap } = await getOrGenerateMetadataBatch(directories.root, relativePaths, 'bg');

        // Build response with metadata for each image
        const imagesWithMetadata = images.map(img => {
            const relativePath = path.join('backgrounds', img);
            const metadata = metadataMap[relativePath];

            // 🪪 §7 surface 4. A background whose plugin is gone still LISTS — `mime.lookup` is happy with
            // the scrambled name's surviving `.png` — and then renders as a broken image with no
            // explanation. It is the mildest of the four failures and the most baffling to look at, because
            // nothing anywhere says the picture is fine and the thing that reads it is missing.
            //
            // ⚠️ A 64-byte prefix read per background, and only for files the installed provider does not
            // already claim. That is the same per-file cost §6.1 accepted for the chat list, on a directory
            // this handler is already generating image metadata for.
            const unavailable = describeUnavailableData(path.join(directories.backgrounds, img));

            return {
                filename: img,
                isAnimated: metadata?.isAnimated ?? false,
                ...(unavailable ? { storage: unavailable } : {}),
            };
        });

        response.json({ images: imagesWithMetadata, config });
    } catch (error) {
        log.error(LogClass.NORMAL, '[Backgrounds] Error fetching backgrounds');
        log.error(LogClass.SENSITIVE, '[Backgrounds] Error fetching backgrounds:', error);
        response.status(500).json({ error: 'Failed to fetch backgrounds' });
    }
});

/**
 * POST /api/backgrounds/folders
 * Returns folders and per-image folderIds from the metadata index.
 * Loaded separately from /all to avoid blocking image rendering.
 */
router.post('/folders', async function (request, response) {
    try {
        const index = await readMetadataIndex(request.user.directories.root);
        const folders = index.folders || [];

        // Build a slim map of image → folderIds for the frontend
        /** @type {Object.<string, string[]>} */
        const imageFolderMap = {};
        for (const [relativePath, meta] of Object.entries(index.images)) {
            if (Array.isArray(meta.folderIds) && meta.folderIds.length > 0) {
                // Strip the directory prefix to get just the filename
                const filename = relativePath.split('/').pop() || relativePath;
                imageFolderMap[filename] = meta.folderIds;
            }
        }

        response.json({ folders, imageFolderMap });
    } catch (error) {
        log.error(LogClass.NORMAL, '[Backgrounds] Folders endpoint error');
        log.error(LogClass.SENSITIVE, '[Backgrounds] Folders endpoint error:', error);
        response.status(500).json({ error: 'Internal server error.' });
    }
});

router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        if (request.body.bg !== sanitize(request.body.bg)) {
            log.error(LogClass.NORMAL, 'Malicious bg name prevented');
            return response.sendStatus(403);
        }

        const fileName = path.join(request.user.directories.backgrounds, sanitize(request.body.bg));

        if (!storage.exists(fileName)) {
            log.error(LogClass.NORMAL, 'BG file not found');
            return response.sendStatus(400);
        }

        storage.unlink(fileName);
        invalidateThumbnail(request.user.directories, 'bg', request.body.bg);

        // Remove metadata for deleted image
        const relativePath = path.join('backgrounds', request.body.bg);
        await removeMetadata(request.user.directories.root, relativePath).catch(err => {
            log.warn(LogClass.SENSITIVE, '[Backgrounds] Failed to remove metadata:', err.message);
        });

        return response.send('ok');
    } catch (err) {
        log.error(LogClass.NORMAL, '[Backgrounds] Failed to delete background');
        log.error(LogClass.SENSITIVE, err);
        response.sendStatus(500);
    }
});

router.post('/rename', async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        const oldFileName = path.join(request.user.directories.backgrounds, sanitize(request.body.old_bg));
        const newFileName = path.join(request.user.directories.backgrounds, sanitize(request.body.new_bg));

        if (!storage.exists(oldFileName)) {
            log.error(LogClass.NORMAL, 'BG file not found');
            return response.sendStatus(400);
        }

        if (storage.exists(newFileName)) {
            log.error(LogClass.NORMAL, 'New BG file already exists');
            return response.sendStatus(400);
        }

        storage.copyFile(oldFileName, newFileName);
        storage.unlink(oldFileName);
        invalidateThumbnail(request.user.directories, 'bg', request.body.old_bg);

        // Update metadata for renamed image
        const oldRelativePath = path.join('backgrounds', request.body.old_bg);
        const newRelativePath = path.join('backgrounds', request.body.new_bg);
        await renameMetadata(request.user.directories.root, oldRelativePath, newRelativePath).catch(err => {
            log.warn(LogClass.SENSITIVE, '[Backgrounds] Failed to rename metadata:', err.message);
        });

        return response.send('ok');
    } catch (err) {
        log.error(LogClass.NORMAL, '[Backgrounds] Failed to rename background');
        log.error(LogClass.SENSITIVE, err);
        response.sendStatus(500);
    }
});

router.post('/upload', async function (request, response) {
    try {
        if (!request.body || !request.file) return response.sendStatus(400);

        const img_path = path.join(request.file.destination, request.file.filename);
        const filename = sanitize(request.file.originalname);

        // 🔴 WRITE THE BYTES, DO NOT COPY THE UPLOAD. A copy inherits the state of the multer staging file,
        // and staging is only protected if the provider implements the OPTIONAL `multerStorage` capability;
        // a provider that omits it stages in the clear and the copy carried that plaintext into the user's
        // backgrounds directory. A background is a picture the user chose to upload — it is exactly the kind
        // of thing an encrypted install exists to keep off the disk in the clear. Same fix, same reason, as
        // the two chat-import paths in endpoints/chats.js.
        storage.writeFileSync(path.join(request.user.directories.backgrounds, filename), storage.readFileSync(img_path));
        storage.unlink(img_path);
        invalidateThumbnail(request.user.directories, 'bg', filename);

        // Generate metadata for the new image
        const relativePath = path.join('backgrounds', filename);
        await getOrGenerateMetadataBatch(request.user.directories.root, [relativePath], 'bg').catch(err => {
            log.warn(LogClass.SENSITIVE, '[Backgrounds] Failed to generate metadata for upload:', err.message);
        });

        response.send(filename);
    } catch (err) {
        log.error(LogClass.NORMAL, '[Backgrounds] Failed to upload background');
        log.error(LogClass.SENSITIVE, err);
        response.sendStatus(500);
    }
});

import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp } from '../jimp.js';
import * as storage from '../storage.js';

import { getImages, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { applyAvatarCropResize } from './characters.js';
import { invalidateThumbnail } from './thumbnails.js';
import cacheBuster from '../middleware/cacheBuster.js';
import { log, LogClass } from '../logger.js';

export const router = express.Router();

router.post('/get', function (request, response) {
    const images = getImages(request.user.directories.avatars);
    response.send(images);
});

router.post('/delete', getFileNameValidationFunction('avatar'), function (request, response) {
    if (!request.body) return response.sendStatus(400);

    if (request.body.avatar !== sanitize(request.body.avatar)) {
        log.error(LogClass.NORMAL, 'Malicious avatar name prevented');
        return response.sendStatus(403);
    }

    const fileName = path.join(request.user.directories.avatars, sanitize(request.body.avatar));

    if (storage.exists(fileName)) {
        storage.unlink(fileName);
        invalidateThumbnail(request.user.directories, 'persona', sanitize(request.body.avatar));
        return response.send({ result: 'ok' });
    }

    return response.sendStatus(404);
});

router.post('/upload', getFileNameValidationFunction('overwrite_name'), async (request, response) => {
    if (!request.file) return response.sendStatus(400);

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const crop = tryParse(request.query.crop);

        // 🔴 Jimp.read(path) opens the file with its OWN fs, reaching straight past the storage funnel. It
        // worked only for as long as uploads were staged in plaintext; against a provider that encrypts them
        // it would read ciphertext and report "not a valid image". Hand it bytes we have already read
        // THROUGH the funnel instead — same call, one fewer library holding its own file descriptor.
        const rawImg = await Jimp.read(await storage.readFile(pathToUpload));
        const image = await applyAvatarCropResize(rawImg, crop);

        // Remove previous thumbnail and bust cache if overwriting
        if (request.body.overwrite_name) {
            invalidateThumbnail(request.user.directories, 'persona', sanitize(request.body.overwrite_name));
            cacheBuster.bust(request, response);
        }

        const filename = sanitize(request.body.overwrite_name || `${Date.now()}.png`);
        const pathToNewFile = path.join(request.user.directories.avatars, filename);
        storage.writeFileSync(pathToNewFile, image);
        storage.unlink(pathToUpload);
        return response.send({ path: filename });
    } catch (err) {
        log.error(LogClass.NORMAL, 'Error uploading user avatar');
        log.error(LogClass.SENSITIVE, 'Error uploading user avatar:', err);
        return response.status(400).send('Is not a valid image');
    }
});
